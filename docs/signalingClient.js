/**
 * ✅ signalingClient.js
 * - 서버(ws://localhost:8080)와 연결
 * - 룸코드로 create/join
 * - WebRTC Offer/Answer/ICE를 자동 교환
 *
 * 현재 연결 방식:
 * - "Host ↔ 1명" 데모(구조는 여러 명 확장 가능)
 * - 참가자가 들어오면 호스트가 그 참가자에게 Offer 전송
 */

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const safeJsonParse = (t) => {
  try { return JSON.parse(t); } catch { return null; }
};

export function createSignalingClient(wsUrl = "ws://localhost:8080") {
  let ws = null;

  let roomInfo = null; // {roomCode, peerId, hostId, peers}
  let pc = null;
  let dc = null;

  // 데모: 현재 연결 대상(호스트가 누구에게 Offer 주는지)
  let lastTargetPeerId = null;

  // 외부 콜백(메인 UI에서 화면 표시용)
  let onStatus = () => {};
  let onPeers = () => {};
  let onConnected = () => {};
  let onDataMessage = () => {};

  function setCallbacks(cbs) {
    if (cbs.onStatus) onStatus = cbs.onStatus;
    if (cbs.onPeers) onPeers = cbs.onPeers;
    if (cbs.onConnected) onConnected = cbs.onConnected;
    if (cbs.onDataMessage) onDataMessage = cbs.onDataMessage;
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  async function connectWs() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    await new Promise((resolve, reject) => {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        onStatus(`WS 연결됨: ${wsUrl}`);
        resolve();
      };

      ws.onerror = () => reject(new Error("WS 연결 실패"));

      ws.onmessage = async (ev) => {
        const msg = safeJsonParse(ev.data);
        if (!msg) return;

        if (msg.type === "error") {
          onStatus(`❗ 서버: ${msg.message}`);
          return;
        }

        // 방 생성/참가 결과
        if (msg.type === "room_created" || msg.type === "room_joined") {
          roomInfo = {
            roomCode: msg.roomCode,
            peerId: msg.peerId,
            hostId: msg.hostId,
            peers: msg.peers || [],
          };
          onPeers(roomInfo.peers, roomInfo.hostId);

          onStatus(
            msg.type === "room_created"
              ? `방 생성: ${roomInfo.roomCode}`
              : `방 참가: ${roomInfo.roomCode}`
          );

          // 호스트면: PC 미리 준비 (참가자 오면 offer)
          if (roomInfo.peerId === roomInfo.hostId) {
            prepareHostPc();
          }
          return;
        }

        // 누가 들어옴
        if (msg.type === "peer_joined") {
          if (!roomInfo) return;
          roomInfo.peers.push(msg.peer);
          onPeers(roomInfo.peers, roomInfo.hostId);

          // 호스트라면 새 참가자에게 offer
          if (roomInfo.peerId === roomInfo.hostId) {
            onStatus(`참가자 입장: ${msg.peer.name}`);
            await makeOfferTo(msg.peer.peerId);
          }
          return;
        }

        // 누가 나감
        if (msg.type === "peer_left") {
          if (!roomInfo) return;
          roomInfo.peers = roomInfo.peers.filter((p) => p.peerId !== msg.peerId);
          onPeers(roomInfo.peers, roomInfo.hostId);
          onStatus(`참가자 퇴장: ${msg.peerId}`);
          return;
        }

        // 시그널 수신(Offer/Answer/ICE)
        if (msg.type === "signal") {
          await handleSignal(msg.from, msg.data);
          return;
        }
      };
    });
  }

  function cleanupRtc() {
    if (dc) { try { dc.close(); } catch {} dc = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
  }

  // ===== 호스트 PC 준비 =====
  function prepareHostPc() {
    cleanupRtc();
    pc = new RTCPeerConnection(RTC_CONFIG);

    // 호스트는 dataChannel 직접 생성
    dc = pc.createDataChannel("game");
    bindDataChannel(dc);

    // ICE 후보가 생길 때마다 상대에게 전달
    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !roomInfo || !lastTargetPeerId) return;
      send({
        type: "signal",
        roomCode: roomInfo.roomCode,
        to: lastTargetPeerId,
        data: { ice: ev.candidate },
      });
    };

    pc.onconnectionstatechange = () => {
      onStatus(`RTC 상태: ${pc.connectionState}`);
      if (pc.connectionState === "connected") onConnected({ pc, dc });
    };
  }

  async function makeOfferTo(targetPeerId) {
    if (!roomInfo) return;
    if (!pc) prepareHostPc();

    lastTargetPeerId = targetPeerId;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Offer 전송
    send({
      type: "signal",
      roomCode: roomInfo.roomCode,
      to: targetPeerId,
      data: { sdp: pc.localDescription },
    });

    onStatus("호스트: Offer 전송");
  }

  // ===== 참가자 PC 준비 =====
  async function prepareJoinPc() {
    cleanupRtc();
    pc = new RTCPeerConnection(RTC_CONFIG);

    // 참가자는 호스트가 만든 dataChannel을 받는다
    pc.ondatachannel = (ev) => {
      dc = ev.channel;
      bindDataChannel(dc);
    };

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !roomInfo) return;
      send({
        type: "signal",
        roomCode: roomInfo.roomCode,
        to: roomInfo.hostId,
        data: { ice: ev.candidate },
      });
    };

    pc.onconnectionstatechange = () => {
      onStatus(`RTC 상태: ${pc.connectionState}`);
      if (pc.connectionState === "connected") onConnected({ pc, dc });
    };
  }

  // ===== 시그널 처리 =====
  async function handleSignal(fromPeerId, data) {
    if (!roomInfo) return;

    // SDP(offer/answer)
    if (data?.sdp) {
      // 참가자: host offer 받음 -> answer 생성/전송
      if (roomInfo.peerId !== roomInfo.hostId) {
        if (!pc) await prepareJoinPc();

        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        send({
          type: "signal",
          roomCode: roomInfo.roomCode,
          to: roomInfo.hostId,
          data: { sdp: pc.localDescription },
        });

        onStatus("참가자: Answer 전송");
        return;
      }

      // 호스트: 참가자가 보낸 answer 받음 -> remoteDescription 세팅
      if (roomInfo.peerId === roomInfo.hostId) {
        if (!pc) return;
        await pc.setRemoteDescription(data.sdp);
        onStatus("호스트: Answer 적용");
        return;
      }
    }

    // ICE 후보
    if (data?.ice) {
      if (!pc) return;
      try {
        await pc.addIceCandidate(data.ice);
      } catch (e) {
        onStatus(`ICE 추가 실패: ${String(e)}`);
      }
    }
  }

  function bindDataChannel(channel) {
    channel.onopen = () => onStatus("데이터채널 open");
    channel.onclose = () => onStatus("데이터채널 close");
    channel.onerror = (e) => onStatus(`데이터채널 error: ${String(e)}`);
    channel.onmessage = (ev) => {
      const obj = safeJsonParse(ev.data);
      onDataMessage(obj ?? ev.data);
    };
  }

  // ===== 외부 API =====
  async function createRoom(name, roomCodeOptional = "") {
    await connectWs();
    send({ type: "create_room", name, roomCode: roomCodeOptional });
  }

  async function joinRoom(name, roomCode) {
    await connectWs();
    send({ type: "join_room", name, roomCode });
  }

  function sendData(obj) {
    if (!dc || dc.readyState !== "open") return;
    dc.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  return {
    setCallbacks,
    createRoom,
    joinRoom,
    sendData,
    getRoomInfo: () => roomInfo,
    getDataChannel: () => dc,
  };
}
