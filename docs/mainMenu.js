/**
 * mainMenu.js
 * - 메인 메뉴 UI: 호스트/연결 탭
 * - WebRTC P2P 연결(임시): Offer/Answer를 복사/붙여넣기로 교환하는 방식
 * - 나중에 WebSocket 시그널링 서버를 붙이기 쉽게 함수로 분리
 */

// ===== DOM =====
const netPill = document.getElementById("netPill");
const rolePill = document.getElementById("rolePill");
const roomPill = document.getElementById("roomPill");

const tabs = Array.from(document.querySelectorAll(".tab"));
const panelHost = document.getElementById("panel-host");
const panelJoin = document.getElementById("panel-join");

const modal = document.getElementById("modal");
document.getElementById("btnHow").addEventListener("click", () => (modal.hidden = false));
document.getElementById("btnCloseModal").addEventListener("click", () => (modal.hidden = true));
modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

const soloStage = document.getElementById("soloStage");
document.getElementById("btnStartLocal").addEventListener("click", () => {
  const stage = soloStage?.value || "GEN-01";
  window.location.href = `ingame/index.html?stage=${encodeURIComponent(stage)}&mode=solo`;
});

// ===== 상태 =====
let role = "none"; // "host" | "join" | "none"
let pc = null;
let dataChannel = null;
let lobbyReady = false;
let lobbyInited = false;
let remoteHostState = null;
let peerStates = new Map();
let primaryConnId = null;
let offerSeq = 1;
let remotePeers = [];

const localClientId = Math.random().toString(36).slice(2, 10);
const hostConnections = new Map();

const MISSION_INFO = {
  "GEN-01": "발전기를 단계별로 가동하고 방어 라인을 유지해야 한다.",
  "COM-02": "통신기 중계탑을 복구하고 신호를 안정화해야 한다.",
  "PUR-03": "정화기를 재가동해 오염 구역을 정리해야 한다.",
  "RES-04": "선발대 구조를 위해 안전 지점을 확보해야 한다.",
};

// WebRTC 설정(기본 STUN 서버)
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ===== 유틸 =====
function setPills({ net, roleText, room }) {
  netPill.textContent = net;
  rolePill.textContent = roleText;
  roomPill.textContent = room;
}

function logTo(el, msg) {
  el.textContent += (el.textContent ? "\n" : "") + msg;
  el.scrollTop = el.scrollHeight;
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ===== 탭 동작 =====
tabs.forEach((t) => {
  t.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.remove("active"));
    t.classList.add("active");

    if (t.dataset.tab === "host") {
      panelHost.classList.add("active");
      panelJoin.classList.remove("active");
    } else {
      panelJoin.classList.add("active");
      panelHost.classList.remove("active");
    }
  });
});

function cleanupConnection() {
  if (dataChannel) {
    try { dataChannel.close(); } catch {}
    dataChannel = null;
  }
  if (pc) {
    try { pc.close(); } catch {}
    pc = null;
  }
}

function cleanupHostConnections() {
  hostConnections.forEach((conn) => {
    if (conn.dc) {
      try { conn.dc.close(); } catch {}
    }
    if (conn.pc) {
      try { conn.pc.close(); } catch {}
    }
  });
  hostConnections.clear();
  peerStates.clear();
  primaryConnId = null;
  offerSeq = 1;
  remoteHostState = null;
  remotePeers = [];
}

function waitIceGatheringComplete(peer) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (peer.iceGatheringState === "complete") {
        peer.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", check);
  });
}

function bindPeerEvents(peer, logEl) {
  peer.oniceconnectionstatechange = () => {
    logTo(logEl, `ICE 상태: ${peer.iceConnectionState}`);

    if (peer.iceConnectionState === "failed") {
      setPills({
        net: "⚠️ 연결 실패",
        roleText: role === "host" ? "👤 역할: Host" : "👤 역할: Join",
        room: "🏷️ 룸: -",
      });
      logTo(logEl, "⚠️ 연결 실패. 네트워크/NAT 환경을 확인해줘.");
    }
  };
}

function bindDataChannel(channel, logEl, connId = null) {
  channel.onopen = () => {
    logTo(logEl, "데이터 채널 open");
    setPills({
      net: "✅ 온라인(연결됨)",
      roleText: role === "host" ? "👤 역할: Host" : "👤 역할: Join",
      room: "🏷️ 룸: -",
    });

    if (role === "host") btnHostToLobby.disabled = false;
    if (role === "join") btnJoinToLobby.disabled = false;

    if (role === "host" && connId) {
      const conn = hostConnections.get(connId);
      if (conn) conn.dc = channel;
    }

    enterLobby();
  };
  channel.onclose = () => logTo(logEl, "데이터 채널 close");
  channel.onerror = (e) => logTo(logEl, `데이터 채널 error: ${String(e)}`);
  channel.onmessage = (ev) => {
    const obj = safeJsonParse(ev.data);
    if (obj?.type === "lobby_state") {
      if (role === "host") {
        if (obj.payload?.id) peerStates.set(obj.payload.id, obj.payload);
        broadcastSnapshot();
        return;
      }
      remoteHostState = obj.payload || null;
      applyRemoteState();
      renderPlayerList();
      return;
    }
    if (obj?.type === "lobby_snapshot") {
      if (role === "host") return;
      remoteHostState = obj.payload?.host || null;
      remotePeers = Array.isArray(obj.payload?.peers) ? obj.payload.peers : [];
      applyRemoteState();
      renderPlayerList();
      updateStartButtonState();
      return;
    }
    if (obj?.type === "start_game") {
      gotoIngame(obj.payload?.stage);
      return;
    }
    logTo(logEl, `수신: ${ev.data}`);
  };
}

// ===== Host UI =====
const hostName = document.getElementById("hostName");
const btnCreateRoom = document.getElementById("btnCreateRoom");
const btnCopyOffer = document.getElementById("btnCopyOffer");
const hostOffer = document.getElementById("hostOffer");
const hostAnswerIn = document.getElementById("hostAnswerIn");
const btnApplyAnswer = document.getElementById("btnApplyAnswer");
const btnHostToLobby = document.getElementById("btnHostToLobby");
const hostLog = document.getElementById("hostLog");

async function createHostOffer(logEl) {
  const connId = `O-${offerSeq++}`;
  const peer = new RTCPeerConnection(RTC_CONFIG);
  const channel = peer.createDataChannel("game");

  bindDataChannel(channel, logEl, connId);
  bindPeerEvents(peer, logEl);

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitIceGatheringComplete(peer);

  const offerText = JSON.stringify(peer.localDescription);
  hostConnections.set(connId, { pc: peer, dc: channel, offerText, answered: false });
  return { connId, offerText };
}

async function applyAnswerToConn(connId, answerText, logEl) {
  const conn = hostConnections.get(connId);
  if (!conn) {
    logTo(logEl, "❗ 연결 대상이 없습니다.");
    return false;
  }

  const ans = safeJsonParse(answerText.trim());
  if (!ans) {
    logTo(logEl, "❗ Answer JSON 파싱 실패. JSON 형태인지 확인해줘.");
    return false;
  }

  await conn.pc.setRemoteDescription(ans);
  conn.answered = true;
  logTo(logEl, `Answer 적용 완료: ${connId}`);
  setPills({
    net: "🧊 연결 시도중",
    roleText: "👤 역할: Host",
    room: "🏷️ 룸: -",
  });
  return true;
}

btnCreateRoom.addEventListener("click", async () => {
  role = "host";
  setPills({
    net: "🧊 준비중",
    roleText: "👤 역할: Host",
    room: "🏷️ 룸: -",
  });

  hostLog.textContent = "";
  logTo(hostLog, `호스트 시작: ${hostName.value || "Unnamed"}`);
  logTo(hostLog, "PeerConnection 생성 중...");

  cleanupConnection();
  cleanupHostConnections();

  const offerResult = await createHostOffer(hostLog);
  primaryConnId = offerResult.connId;
  hostOffer.value = offerResult.offerText;
  btnCopyOffer.disabled = false;
  btnApplyAnswer.disabled = false;

  logTo(hostLog, "Offer 생성 완료! 참가자에게 Offer JSON을 보내줘.");
  setPills({
    net: "🧊 Offer 생성됨",
    roleText: "👤 역할: Host",
    room: "🏷️ 룸: -",
  });
});

btnCopyOffer.addEventListener("click", async () => {
  await copyText(hostOffer.value);
  logTo(hostLog, "Offer 복사 완료!");
});

btnApplyAnswer.addEventListener("click", async () => {
  if (!primaryConnId) {
    logTo(hostLog, "❗ 적용할 Offer가 없습니다. 먼저 방 만들기를 눌러줘.");
    return;
  }
  await applyAnswerToConn(primaryConnId, hostAnswerIn.value, hostLog);
});

btnHostToLobby.addEventListener("click", () => {
  enterLobby();
});

// ===== Join UI =====
const joinName = document.getElementById("joinName");
const joinOfferIn = document.getElementById("joinOfferIn");
const btnCreateAnswer = document.getElementById("btnCreateAnswer");
const btnCopyAnswer = document.getElementById("btnCopyAnswer");
const joinAnswerOut = document.getElementById("joinAnswerOut");
const btnJoinToLobby = document.getElementById("btnJoinToLobby");
const joinLog = document.getElementById("joinLog");

const mainGrid = document.querySelector("main.grid");
const lobby = document.getElementById("lobby");
const lobbyLog = document.getElementById("lobbyLog");
const btnBackToMenu = document.getElementById("btnBackToMenu");
const btnPing = document.getElementById("btnPing");
const btnReadyToggle = document.getElementById("btnReadyToggle");
const missionSelect = document.getElementById("missionSelect");
const missionDesc = document.getElementById("missionDesc");
const roleGrid = document.getElementById("roleGrid");
const weaponSelect = document.getElementById("weaponSelect");
const gadgetSelect = document.getElementById("gadgetSelect");
const playerList = document.getElementById("playerList");
const equipInputs = Array.from(document.querySelectorAll(".equipRow input[type=checkbox]"));
const hostMultiCard = document.getElementById("hostMultiCard");
const btnNewOffer = document.getElementById("btnNewOffer");
const offerList = document.getElementById("offerList");
const btnStartGame = document.getElementById("btnStartGame");

btnCreateAnswer.addEventListener("click", async () => {
  role = "join";
  setPills({
    net: "🧊 준비중",
    roleText: "👤 역할: Join",
    room: "🏷️ 룸: (Offer 기반)",
  });

  joinLog.textContent = "";
  logTo(joinLog, `참가자 시작: ${joinName.value || "Unnamed"}`);

  cleanupConnection();

  const offer = safeJsonParse(joinOfferIn.value.trim());
  if (!offer) {
    logTo(joinLog, "❗ Offer JSON 파싱 실패. 호스트 Offer를 그대로 붙여넣었는지 확인!");
    return;
  }

  pc = new RTCPeerConnection(RTC_CONFIG);
  pc.ondatachannel = (ev) => {
    dataChannel = ev.channel;
    bindDataChannel(dataChannel, joinLog);
    logTo(joinLog, "데이터 채널 연결됨!");
  };
  bindPeerEvents(pc, joinLog);

  await pc.setRemoteDescription(offer);
  logTo(joinLog, "Offer 적용 완료. Answer 생성 중...");

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceGatheringComplete(pc);

  joinAnswerOut.value = JSON.stringify(pc.localDescription);
  btnCopyAnswer.disabled = false;

  logTo(joinLog, "Answer 생성 완료! 이 Answer를 호스트에게 보내줘.");
  setPills({
    net: "🧊 Answer 생성됨",
    roleText: "👤 역할: Join",
    room: "🏷️ 룸: (Offer 기반)",
  });
});

btnCopyAnswer.addEventListener("click", async () => {
  await copyText(joinAnswerOut.value);
  logTo(joinLog, "Answer 복사 완료!");
});

btnJoinToLobby.addEventListener("click", () => {
  enterLobby();
});

function enterLobby() {
  if (!mainGrid || !lobby) return;
  mainGrid.style.display = "none";
  lobby.hidden = false;
  logTo(lobbyLog, "✅ P2P 연결 성공! 로비 입장");

  if (!lobbyInited) initLobbyUi();
  renderPlayerList();
  sendLobbyState();

  if (missionSelect) missionSelect.disabled = role !== "host";
  if (hostMultiCard) hostMultiCard.hidden = role !== "host";
  if (btnStartGame) btnStartGame.hidden = role !== "host";
  if (role === "host") syncHostOfferList();
  updateStartButtonState();

  if (btnPing) {
    btnPing.onclick = () => {
      broadcastToPeers({ type: "ping", t: Date.now(), from: role });
      logTo(lobbyLog, "📤 ping 전송");
    };
  }
}

function initLobbyUi() {
  lobbyInited = true;

  if (missionSelect && missionDesc) {
    const bootKey = missionSelect.value;
    missionDesc.textContent = MISSION_INFO[bootKey] || "";
    missionSelect.addEventListener("change", () => {
      if (role !== "host") return;
      const key = missionSelect.value;
      missionDesc.textContent = MISSION_INFO[key] || "";
      logTo(lobbyLog, `미션 변경: ${key}`);
      renderPlayerList();
      sendLobbyState();
      updateStartButtonState();
    });
  }

  if (roleGrid) {
    roleGrid.addEventListener("click", (e) => {
      const btn = e.target.closest(".roleCard");
      if (!btn) return;
      roleGrid.querySelectorAll(".roleCard").forEach((el) => el.classList.remove("active"));
      btn.classList.add("active");
      logTo(lobbyLog, `역할 선택: ${btn.dataset.role}`);
      renderPlayerList();
      sendLobbyState();
      updateStartButtonState();
    });
  }

  if (weaponSelect) {
    weaponSelect.addEventListener("change", () => {
      logTo(lobbyLog, `주무기: ${weaponSelect.value}`);
      renderPlayerList();
      sendLobbyState();
      updateStartButtonState();
    });
  }

  if (gadgetSelect) {
    gadgetSelect.addEventListener("change", () => {
      logTo(lobbyLog, `보조 장비: ${gadgetSelect.value}`);
      renderPlayerList();
      sendLobbyState();
      updateStartButtonState();
    });
  }

  if (equipInputs.length) {
    equipInputs.forEach((input) => {
      input.addEventListener("change", () => {
        logTo(lobbyLog, "특수 장비 변경");
        renderPlayerList();
        sendLobbyState();
        updateStartButtonState();
      });
    });
  }

  if (btnReadyToggle) {
    btnReadyToggle.addEventListener("click", () => {
      lobbyReady = !lobbyReady;
      btnReadyToggle.textContent = lobbyReady ? "준비 취소" : "준비";
      logTo(lobbyLog, lobbyReady ? "준비 완료" : "준비 해제");
      renderPlayerList();
      sendLobbyState();
      updateStartButtonState();
    });
  }

  if (btnNewOffer) {
    btnNewOffer.addEventListener("click", async () => {
      if (role !== "host") return;
      const offerResult = await createHostOffer(lobbyLog);
      addOfferItem(offerResult.connId, offerResult.offerText);
      logTo(lobbyLog, `새 Offer 생성: ${offerResult.connId}`);
    });
  }

  if (btnStartGame) {
    btnStartGame.addEventListener("click", () => {
      if (role !== "host") return;
      if (btnStartGame.disabled) {
        logTo(lobbyLog, "모든 플레이어가 준비되어야 시작할 수 있어.");
        return;
      }
      const stage = missionSelect?.value || "GEN-01";
      broadcastToPeers({ type: "start_game", payload: { stage } });
      gotoIngame(stage);
    });
  }
}

function syncHostOfferList() {
  if (!offerList || !primaryConnId) return;
  addOfferItem(primaryConnId, hostOffer.value);
}

function addOfferItem(connId, offerText) {
  if (!offerList) return;
  if (offerList.querySelector(`[data-conn-id="${connId}"]`)) return;

  const item = document.createElement("div");
  item.className = "offerItem";
  item.dataset.connId = connId;
  item.innerHTML = `
    <div class="offerRow">
      <div class="offerTitle">Offer ${connId}</div>
      <button class="btn ghost" data-action="copy">Offer 복사</button>
    </div>
    <textarea class="offerOut" rows="4" readonly></textarea>
    <textarea class="answerIn" rows="4" placeholder="Answer JSON 붙여넣기"></textarea>
    <div class="actionsRow">
      <button class="btn" data-action="apply">Answer 적용</button>
    </div>
  `;

  const offerOut = item.querySelector(".offerOut");
  const answerIn = item.querySelector(".answerIn");
  const copyBtn = item.querySelector('[data-action="copy"]');
  const applyBtn = item.querySelector('[data-action="apply"]');

  offerOut.value = offerText;

  copyBtn.addEventListener("click", async () => {
    await copyText(offerOut.value);
    logTo(lobbyLog, `Offer 복사: ${connId}`);
  });

  applyBtn.addEventListener("click", async () => {
    const ok = await applyAnswerToConn(connId, answerIn.value, lobbyLog);
    if (ok) applyBtn.disabled = true;
  });

  offerList.appendChild(item);
}

function getLocalState() {
  const name = role === "host" ? hostName.value : joinName.value;
  const activeRole = roleGrid?.querySelector(".roleCard.active");
  const equip = equipInputs.filter((el) => el.checked).map((el) => el.value);
  return {
    id: localClientId,
    name: name || "Player",
    ready: lobbyReady,
    isHost: role === "host",
    role: activeRole?.dataset.role || "Assault",
    weapon: weaponSelect?.value || "rifle",
    gadget: gadgetSelect?.value || "turret",
    mission: missionSelect?.value || "GEN-01",
    equip,
  };
}

function sendLobbyState() {
  if (role === "host") {
    broadcastSnapshot();
    return;
  }
  if (!dataChannel || dataChannel.readyState !== "open") return;
  dataChannel.send(JSON.stringify({ type: "lobby_state", payload: getLocalState() }));
}

function broadcastToPeers(message) {
  const payload = typeof message === "string" ? message : JSON.stringify(message);
  if (role === "host") {
    hostConnections.forEach((conn) => {
      if (conn.dc && conn.dc.readyState === "open") conn.dc.send(payload);
    });
    return;
  }

  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(payload);
  }
}

function buildSnapshot() {
  const localState = getLocalState();
  const peers = [];
  peerStates.forEach((state) => peers.push(state));
  return [localState, ...peers];
}

function broadcastSnapshot() {
  if (role !== "host") return;
  const snapshot = buildSnapshot();
  const payload = {
    host: snapshot[0],
    peers: snapshot.slice(1),
  };
  broadcastToPeers({ type: "lobby_snapshot", payload });
  renderPlayerList();
  updateStartButtonState();
}

function updateStartButtonState() {
  if (!btnStartGame) return;
  if (role !== "host") {
    btnStartGame.disabled = true;
    return;
  }
  const players = buildSnapshot();
  const allReady = players.length > 0 && players.every((p) => p.ready);
  btnStartGame.disabled = !allReady;
}

function renderPlayerList() {
  if (!playerList) return;
  const localState = getLocalState();

  const players = [];
  if (localState.isHost) {
    players.push(localState);
    peerStates.forEach((state) => players.push(state));
    if (peerStates.size === 0) {
      players.push({
        name: "참가자 대기중",
        ready: false,
        isHost: false,
        role: "-",
        weapon: "-",
        gadget: "-",
        equip: [],
      });
    }
  } else {
    if (remoteHostState) players.push(remoteHostState);
    const mergedPeers = remotePeers.filter((p) => p.id !== localClientId);
    players.push(localState, ...mergedPeers);
  }

  if (role !== "host" && !remoteHostState) {
    players.push({
      name: "호스트 대기중",
      ready: false,
      isHost: true,
      role: "-",
      weapon: "-",
      gadget: "-",
      equip: [],
    });
  }

  playerList.innerHTML = players
    .map((p) => {
      const readyClass = p.ready ? "ok" : "wait";
      const readyText = p.ready ? "준비완료" : "대기";
      const hostBadge = p.isHost ? '<span class="badge host">HOST</span>' : "";
      const equipText = p.equip?.length ? p.equip.join(", ") : "-";
      return `
        <div class="slot">
          <div class="slotLeft">
            <div class="slotName">${p.name}</div>
            <div class="slotMeta">${p.role} · ${p.weapon} · ${p.gadget} · ${equipText}</div>
          </div>
          <div class="actionsRow">
            ${hostBadge}
            <span class="badge ${readyClass}">${readyText}</span>
          </div>
        </div>`;
    })
    .join("");
}

function applyRemoteState() {
  if (!remoteHostState) return;
  if (role !== "host" && missionSelect && missionDesc) {
    if (missionSelect.value !== remoteHostState.mission) {
      missionSelect.value = remoteHostState.mission;
      missionDesc.textContent = MISSION_INFO[remoteHostState.mission] || "";
      logTo(lobbyLog, `호스트 미션 적용: ${remoteHostState.mission}`);
    }
  }
}

if (btnBackToMenu) {
  btnBackToMenu.addEventListener("click", () => {
    if (!mainGrid || !lobby) return;
    lobby.hidden = true;
    mainGrid.style.display = "";
    lobbyLog.textContent = "";
    if (offerList) offerList.innerHTML = "";
    peerStates.clear();
    remoteHostState = null;
    remotePeers = [];
    cleanupConnection();
    cleanupHostConnections();
    setPills({ net: "🔌 오프라인", roleText: "👤 역할: -", room: "🏷️ 룸: -" });
  });
}

function gotoIngame(stageKey) {
  const stage = stageKey || missionSelect?.value || "GEN-01";
  const url = `ingame/index.html?stage=${encodeURIComponent(stage)}`;
  window.location.href = url;
}
