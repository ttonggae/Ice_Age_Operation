/**
 * ✅ WebRTC "시그널링" 서버 (WebSocket)
 * - WebRTC는 P2P지만, 처음에 Offer/Answer/ICE를 "교환"하려면 중계가 필요함
 * - 이 서버는 그 메시지들을 룸코드 기준으로 전달만 해줌(게임 데이터는 P2P로 감)
 *
 * 룸 규칙:
 * - 룸 생성자는 host
 * - 최대 5명 (host 포함)
 * - host가 나가면 방 종료(간단 처리)
 */

import { WebSocketServer } from "ws";

const PORT = 8080;
const wss = new WebSocketServer({ port: PORT });

/** rooms: Map<roomCode, {hostId:string, peers: Map<peerId, {ws, name}>}> */
const rooms = new Map();

const makeRoomCode = () => {
  const a = Math.random().toString(36).slice(2, 6).toUpperCase();
  const b = Math.random().toString(36).slice(2, 4).toUpperCase();
  return `IAO-${a}-${b}`; // Ice_Age_Operation
};
const makePeerId = () => Math.random().toString(36).slice(2, 10);

const send = (ws, obj) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

const broadcast = (roomCode, obj, exceptPeerId = null) => {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const [pid, p] of room.peers) {
    if (exceptPeerId && pid === exceptPeerId) continue;
    send(p.ws, obj);
  }
};

const peersList = (roomCode) => {
  const room = rooms.get(roomCode);
  if (!room) return [];
  return [...room.peers.entries()].map(([peerId, p]) => ({ peerId, name: p.name }));
};

function cleanupPeer(ws) {
  for (const [roomCode, room] of rooms) {
    for (const [peerId, peer] of room.peers) {
      if (peer.ws === ws) {
        room.peers.delete(peerId);

        // 다른 사람들에게 퇴장 알림
        broadcast(roomCode, { type: "peer_left", peerId });

        // host가 나가면 방 종료
        if (room.hostId === peerId) {
          broadcast(roomCode, { type: "error", message: "호스트가 나가서 방이 종료됨" });
          rooms.delete(roomCode);
        }

        if (room.peers.size === 0) rooms.delete(roomCode);
        return;
      }
    }
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", message: "JSON 파싱 실패" });
    }

    // 1) 방 만들기
    if (msg.type === "create_room") {
      const name = String(msg.name || "Host").slice(0, 16);
      const roomCode = String(msg.roomCode || "").trim().slice(0, 16) || makeRoomCode();

      if (rooms.has(roomCode)) {
        return send(ws, { type: "error", message: "이미 존재하는 룸코드" });
      }

      const peerId = makePeerId();
      rooms.set(roomCode, {
        hostId: peerId,
        peers: new Map([[peerId, { ws, name }]]),
      });

      return send(ws, {
        type: "room_created",
        roomCode,
        peerId,
        hostId: peerId,
        peers: peersList(roomCode),
      });
    }

    // 2) 방 참가
    if (msg.type === "join_room") {
      const roomCode = String(msg.roomCode || "").trim();
      const name = String(msg.name || "Join").slice(0, 16);

      const room = rooms.get(roomCode);
      if (!room) return send(ws, { type: "error", message: "존재하지 않는 룸코드" });
      if (room.peers.size >= 5) return send(ws, { type: "error", message: "방이 가득 참(최대 5명)" });

      const peerId = makePeerId();
      room.peers.set(peerId, { ws, name });

      // 참가자에게 현재 방 정보
      send(ws, {
        type: "room_joined",
        roomCode,
        peerId,
        hostId: room.hostId,
        peers: peersList(roomCode),
      });

      // 기존 사람들에게 새 참가자 알림
      broadcast(roomCode, { type: "peer_joined", peer: { peerId, name } }, peerId);
      return;
    }

    // 3) 시그널 중계 (Offer/Answer/ICE)
    if (msg.type === "signal") {
      const roomCode = msg.roomCode;
      const to = msg.to;
      const data = msg.data;

      const room = rooms.get(roomCode);
      if (!room) return send(ws, { type: "error", message: "방 없음" });

      // sender id 찾기
      let fromId = null;
      for (const [pid, p] of room.peers) if (p.ws === ws) fromId = pid;
      if (!fromId) return send(ws, { type: "error", message: "방 참가자 아님" });

      const target = room.peers.get(to);
      if (!target) return send(ws, { type: "error", message: "대상 peer 없음" });

      return send(target.ws, { type: "signal", from: fromId, data });
    }
  });

  ws.on("close", () => cleanupPeer(ws));
  ws.on("error", () => cleanupPeer(ws));
});

console.log(`✅ Signaling server: ws://localhost:${PORT}`);
