function getStageKey() {
  const params = new URLSearchParams(window.location.search);
  return params.get("stage") || "GEN-01";
}

const canvas = document.getElementById("gameCanvas");
const ctx = canvas ? canvas.getContext("2d") : null;
const visionGLCanvas = document.getElementById("visionGL");
const visionGL = visionGLCanvas ? visionGLCanvas.getContext("webgl", { premultipliedAlpha: false }) : null;
const aimCanvas = document.getElementById("aimCanvas");
const aimCtx = aimCanvas ? aimCanvas.getContext("2d") : null;
const miniMap = document.getElementById("miniMap");
const miniCtx = miniMap ? miniMap.getContext("2d") : null;
const btnExitToMenu = document.getElementById("btnExitToMenu");
const visionMaskCanvas = document.createElement("canvas");
const visionMaskCtx = visionMaskCanvas.getContext("2d");
const ingameChannel = new BroadcastChannel("iao_ingame");
const clientId = sessionStorage.getItem("iaoClientId") || Math.random().toString(36).slice(2, 10);
const inventorySlots = Array.from(document.querySelectorAll(".inventory .invSlot"));
const inventoryItems = [
  { type: "main", name: "Rifle", ammo: 25, maxAmmo: 30, uses: null, spreadDeg: 3, lifeSec: 2.2 },
  { type: "side", name: "Pistol", ammo: 12, maxAmmo: 12, uses: null, spreadDeg: 8, lifeSec: 1.5 },
  { type: "gear", name: "Turret", ammo: null, maxAmmo: null, uses: { cur: 2, max: 3 }, spreadDeg: 0, lifeSec: 0.8 },
];
let activeSlotIndex = 0;
let visionProgram = null;
let visionBuffer = null;
let visionTexture = null;
let visionUniforms = null;

const input = {
  up: false,
  down: false,
  left: false,
  right: false,
  sprint: false,
  shooting: false,
  aiming: false,
  mouseX: 0,
  mouseY: 0,
};

const player = {
  x: 0,
  y: 0,
  r: 12,
  speed: 220,
  ammo: 30,
  maxAmmo: 30,
  hp: 100,
  maxHp: 100,
  stamina: 100,
  maxStamina: 100,
  hasLight: false,
};

const bullets = [];
const otherPlayers = [];
const BULLET_SPEED = 520;
const BULLET_LIFE = 1.8;
let lastShot = 0;
const SHOT_COOLDOWN = 0.12;

let viewWidth = 0;
let viewHeight = 0;
const world = {
  width: 2400,
  height: 1800,
};
const camera = { x: 0, y: 0 };
const stage = {
  tileSize: 80,
  tiles: [],
  events: [],
};

const hud = {
  hpFill: document.getElementById("hpFill"),
  hpValue: document.getElementById("hpValue"),
  stamFill: document.getElementById("stamFill"),
  stamValue: document.getElementById("stamValue"),
};

const RUN_MULT = 1.6;
const STAMINA_DRAIN = 35;
const STAMINA_REGEN = 28;
const BLIZZARD_DAMAGE = 1;
const FOV_NO_LIGHT_DEG = 30;
const FOV_LIGHT_DEG = 140;
const RANGE_NO_LIGHT_TILES = 5;
const RANGE_LIGHT_TILES = 50;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function resizeCanvas() {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  viewWidth = Math.max(320, Math.round(rect.width));
  viewHeight = Math.max(240, Math.round(rect.height));
  canvas.width = Math.round(viewWidth * window.devicePixelRatio);
  canvas.height = Math.round(viewHeight * window.devicePixelRatio);
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  visionMaskCanvas.width = viewWidth;
  visionMaskCanvas.height = viewHeight;
  if (visionGLCanvas) {
    visionGLCanvas.width = Math.round(viewWidth * window.devicePixelRatio);
    visionGLCanvas.height = Math.round(viewHeight * window.devicePixelRatio);
    visionGLCanvas.style.width = `${viewWidth}px`;
    visionGLCanvas.style.height = `${viewHeight}px`;
  }
  if (aimCanvas && aimCtx) {
    aimCanvas.width = Math.round(viewWidth * window.devicePixelRatio);
    aimCanvas.height = Math.round(viewHeight * window.devicePixelRatio);
    aimCanvas.style.width = `${viewWidth}px`;
    aimCanvas.style.height = `${viewHeight}px`;
    aimCtx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  }
  if (visionGL) {
    visionGL.viewport(0, 0, visionGLCanvas.width, visionGLCanvas.height);
  }
}

function handleInput(dt) {
  let vx = 0;
  let vy = 0;
  if (input.up) vy -= 1;
  if (input.down) vy += 1;
  if (input.left) vx -= 1;
  if (input.right) vx += 1;
  const len = Math.hypot(vx, vy) || 1;
  vx /= len;
  vy /= len;
  const canRun = input.sprint && player.stamina > 0 && (vx !== 0 || vy !== 0);
  const speed = canRun ? player.speed * RUN_MULT : player.speed;
  const nextX = player.x + vx * speed * dt;
  const nextY = player.y + vy * speed * dt;
  const resolvedX = resolveCollision(nextX, player.y);
  player.x = resolvedX.x;
  const resolvedY = resolveCollision(player.x, nextY);
  player.y = resolvedY.y;
  player.x = clamp(player.x, player.r, world.width - player.r);
  player.y = clamp(player.y, player.r, world.height - player.r);
  resolvePlayerOverlap();

  if (canRun) {
    player.stamina = Math.max(0, player.stamina - STAMINA_DRAIN * dt);
  } else {
    player.stamina = Math.min(player.maxStamina, player.stamina + STAMINA_REGEN * dt);
  }
}

function resolvePlayerOverlap() {
  if (!otherPlayers.length) return;
  otherPlayers.forEach((other) => {
    const dx = player.x - other.x;
    const dy = player.y - other.y;
    const dist = Math.hypot(dx, dy) || 1;
    const minDist = player.r + other.r;
    if (dist < minDist) {
      const push = (minDist - dist) / dist;
      player.x += dx * push;
      player.y += dy * push;
    }
  });
}

function tryShoot(now) {
  if (!input.shooting) return;
  if (now - lastShot < SHOT_COOLDOWN) return;
  if (player.ammo <= 0) return;
  lastShot = now;
  player.ammo -= 1;
  updateHud();

  const targetX = camera.x + input.mouseX;
  const targetY = camera.y + input.mouseY;
  const dx = targetX - player.x;
  const dy = targetY - player.y;
  const baseAngle = Math.atan2(dy, dx);
  const spreadRad = getActiveSpreadRad();
  const spreadOffset = (Math.random() * 2 - 1) * spreadRad;
  const shotAngle = baseAngle + spreadOffset;
  const ux = Math.cos(shotAngle);
  const uy = Math.sin(shotAngle);
  const life = getActiveBulletLife();
  bullets.push({
    x: player.x + ux * (player.r + 4),
    y: player.y + uy * (player.r + 4),
    vx: ux * BULLET_SPEED,
    vy: uy * BULLET_SPEED,
    life,
  });
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i -= 1) {
    const b = bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0 || isWallAt(b.x, b.y)) {
      bullets.splice(i, 1);
    }
  }
}

function updateHud() {
  syncInventoryUi();
  if (hud.hpFill) hud.hpFill.style.width = `${(player.hp / player.maxHp) * 100}%`;
  if (hud.hpValue) hud.hpValue.textContent = `${Math.round(player.hp)}/${player.maxHp}`;
  if (hud.stamFill) hud.stamFill.style.width = `${(player.stamina / player.maxStamina) * 100}%`;
  if (hud.stamValue) hud.stamValue.textContent = `${Math.round(player.stamina)}/${player.maxStamina}`;
}

function getActiveSpreadRad() {
  const slot = inventoryItems[activeSlotIndex];
  const spreadDeg = slot?.spreadDeg ?? 0;
  return (spreadDeg * Math.PI) / 180;
}

function getActiveBulletLife() {
  const slot = inventoryItems[activeSlotIndex];
  return slot?.lifeSec ?? BULLET_LIFE;
}

function draw() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  camera.x = clamp(player.x - viewWidth / 2, 0, Math.max(0, world.width - viewWidth));
  camera.y = clamp(player.y - viewHeight / 2, 0, Math.max(0, world.height - viewHeight));

  ctx.save();
  ctx.fillStyle = "rgba(10,16,28,0.95)";
  ctx.fillRect(0, 0, viewWidth, viewHeight);
  ctx.restore();

  drawTiles();

  ctx.save();
  ctx.fillStyle = "#2b69ff";
  ctx.beginPath();
  ctx.arc(player.x - camera.x, player.y - camera.y, player.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (otherPlayers.length) {
    ctx.save();
    ctx.fillStyle = "#f97316";
    otherPlayers.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x - camera.x, p.y - camera.y, p.r || player.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  drawPlayerBars();

  ctx.save();
  ctx.fillStyle = "#e9f0ff";
  bullets.forEach((b) => {
    ctx.beginPath();
    ctx.arc(b.x - camera.x, b.y - camera.y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();

  drawAimAssist();
  drawVisionCone();
  drawMiniMap();
  drawAimAssist();

  if (blizzardFade > 0.01) {
    ctx.save();
    ctx.fillStyle = `rgba(70,140,220,${blizzardFade})`;
    ctx.fillRect(0, 0, viewWidth, viewHeight);
    ctx.restore();
  }
}

let lastTime = 0;
let timeSec = 0;
let blizzardFade = 0;
let lastPosSent = 0;
function loop(ts) {
  if (!lastTime) lastTime = ts;
  const dt = Math.min(0.033, (ts - lastTime) / 1000);
  lastTime = ts;
  timeSec += dt;
  handleInput(dt);
  tryShoot(ts / 1000);
  updateBullets(dt);
  applyBlizzardDamage(dt);
  updateBlizzardOverlay(dt);
  updateHud();
  updateEvents();
  sendLocalPos(ts);
  draw();
  requestAnimationFrame(loop);
}

function bindInput() {
  if (!canvas) return;
  window.addEventListener("keydown", (e) => {
    if (e.key === "w" || e.key === "W") input.up = true;
    if (e.key === "s" || e.key === "S") input.down = true;
    if (e.key === "a" || e.key === "A") input.left = true;
    if (e.key === "d" || e.key === "D") input.right = true;
    if (e.key === "Shift") input.sprint = true;
    if (e.key === "l" || e.key === "L") player.hasLight = !player.hasLight;
    if (e.code === "Space" && !document.fullscreenElement) {
      requestFullscreen();
    }
    if (e.code === "Digit1") setActiveSlot(0);
    if (e.code === "Digit2") setActiveSlot(1);
    if (e.code === "Digit3") setActiveSlot(2);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "w" || e.key === "W") input.up = false;
    if (e.key === "s" || e.key === "S") input.down = false;
    if (e.key === "a" || e.key === "A") input.left = false;
    if (e.key === "d" || e.key === "D") input.right = false;
    if (e.key === "Shift") input.sprint = false;
  });

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    input.mouseX = ((e.clientX - rect.left) / rect.width) * viewWidth;
    input.mouseY = ((e.clientY - rect.top) / rect.height) * viewHeight;
  });
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) input.shooting = true;
    if (e.button === 2) input.aiming = true;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) input.shooting = false;
    if (e.button === 2) input.aiming = false;
  });

  window.addEventListener("resize", () => {
    resizeCanvas();
  });
}

function drawAimAssist() {
  if (!aimCtx) return;
  aimCtx.clearRect(0, 0, viewWidth, viewHeight);
  const startX = player.x;
  const startY = player.y;
  const targetX = camera.x + input.mouseX;
  const targetY = camera.y + input.mouseY;
  const dx = targetX - startX;
  const dy = targetY - startY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const offset = player.r + 8;
  const laserStartX = startX + ux * offset;
  const laserStartY = startY + uy * offset;
  const maxDist = BULLET_SPEED * getActiveBulletLife();
  const wallHit = getLaserHit(laserStartX, laserStartY, ux, uy, maxDist);
  const crossDist = Math.min(maxDist, Math.max(0, len - 18));
  const wallDist = Math.hypot(wallHit.x - laserStartX, wallHit.y - laserStartY);
  const finalDist = Math.min(crossDist, wallDist);
  const endX = laserStartX + ux * finalDist;
  const endY = laserStartY + uy * finalDist;

  if (input.aiming) {
    const sx = laserStartX - camera.x;
    const sy = laserStartY - camera.y;
    const ex = endX - camera.x;
    const ey = endY - camera.y;
    aimCtx.save();
    aimCtx.shadowColor = "rgba(255,80,80,0.9)";
    aimCtx.shadowBlur = 12;
    aimCtx.strokeStyle = "rgba(255,80,80,0.7)";
    aimCtx.lineWidth = 2.4;
    aimCtx.beginPath();
    aimCtx.moveTo(sx, sy);
    aimCtx.lineTo(ex, ey);
    aimCtx.stroke();
    aimCtx.shadowBlur = 0;
    aimCtx.strokeStyle = "rgba(255,140,140,0.95)";
    aimCtx.lineWidth = 1.2;
    aimCtx.beginPath();
    aimCtx.moveTo(sx, sy);
    aimCtx.lineTo(ex, ey);
    aimCtx.stroke();
    aimCtx.restore();
  }

  const cx = input.mouseX;
  const cy = input.mouseY;
  aimCtx.save();
  aimCtx.shadowColor = "rgba(80,200,255,0.9)";
  aimCtx.shadowBlur = 10;
  aimCtx.strokeStyle = "rgba(110,220,255,0.85)";
  aimCtx.lineWidth = 2;
  aimCtx.beginPath();
  aimCtx.moveTo(cx - 10, cy);
  aimCtx.lineTo(cx - 3, cy);
  aimCtx.moveTo(cx + 3, cy);
  aimCtx.lineTo(cx + 10, cy);
  aimCtx.moveTo(cx, cy - 10);
  aimCtx.lineTo(cx, cy - 3);
  aimCtx.moveTo(cx, cy + 3);
  aimCtx.lineTo(cx, cy + 10);
  aimCtx.stroke();
  aimCtx.shadowBlur = 0;
  aimCtx.strokeStyle = "rgba(200,245,255,0.95)";
  aimCtx.lineWidth = 1;
  aimCtx.beginPath();
  aimCtx.moveTo(cx - 8, cy);
  aimCtx.lineTo(cx - 3, cy);
  aimCtx.moveTo(cx + 3, cy);
  aimCtx.lineTo(cx + 8, cy);
  aimCtx.moveTo(cx, cy - 8);
  aimCtx.lineTo(cx, cy - 3);
  aimCtx.moveTo(cx, cy + 3);
  aimCtx.lineTo(cx, cy + 8);
  aimCtx.stroke();
  aimCtx.restore();
}

function getLaserHit(sx, sy, ux, uy, maxDist) {
  const step = 12;
  let dist = 0;
  while (dist < maxDist) {
    const nx = sx + ux * dist;
    const ny = sy + uy * dist;
    if (isWallAt(nx, ny)) {
      return { x: nx, y: ny };
    }
    dist += step;
  }
  return { x: sx + ux * maxDist, y: sy + uy * maxDist };
}

function setActiveSlot(index) {
  if (!inventorySlots.length) return;
  if (index < 0 || index >= inventorySlots.length) return;
  activeSlotIndex = index;
  inventorySlots.forEach((slot, i) => {
    slot.classList.toggle("active", i === index);
  });
  const slot = inventoryItems[index];
  if (slot?.ammo != null) {
    player.maxAmmo = slot.maxAmmo;
    player.ammo = slot.ammo;
  }
  syncInventoryUi();
}

function syncInventoryUi() {
  if (!inventorySlots.length) return;
  inventorySlots.forEach((slot, i) => {
    const itemEl = slot.querySelector(".invItem");
    const metaEl = slot.querySelector(".invMeta");
    const item = inventoryItems[i];
    if (!item) return;
    if (itemEl) itemEl.textContent = item.name;
    if (metaEl) {
      if (item.ammo != null) {
        metaEl.textContent = `${item.ammo}/${item.maxAmmo}`;
      } else if (item.uses) {
        metaEl.textContent = `${item.uses.cur}/${item.uses.max}`;
      } else {
        metaEl.textContent = "-";
      }
    }
  });
}

function drawPlayerBars() {
  const screenX = player.x - camera.x;
  const screenY = player.y - camera.y;
  const barWidth = 44;
  const barHeight = 4;
  const gap = 6;
  const hpRatio = player.hp / player.maxHp;
  const stRatio = player.stamina / player.maxStamina;

  ctx.save();
  ctx.translate(screenX - barWidth / 2, screenY - player.r - gap - barHeight * 2);

  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(0, 0, barWidth, barHeight);
  ctx.fillRect(0, barHeight + 3, barWidth, barHeight);

  ctx.fillStyle = "#22c55e";
  ctx.fillRect(0, 0, barWidth * hpRatio, barHeight);
  ctx.fillStyle = "#facc15";
  ctx.fillRect(0, barHeight + 3, barWidth * stRatio, barHeight);
  ctx.restore();
}

function drawMiniMap() {
  if (!miniCtx || !miniMap) return;
  const w = miniMap.width;
  const h = miniMap.height;
  miniCtx.clearRect(0, 0, w, h);

  miniCtx.fillStyle = "rgba(8,12,20,0.85)";
  miniCtx.fillRect(0, 0, w, h);

  if (stage.tiles.length) {
    const rows = stage.tiles.length;
    const cols = stage.tiles[0].length;
    const sx = w / (cols * stage.tileSize);
    const sy = h / (rows * stage.tileSize);
    const tW = stage.tileSize * sx;
    const tH = stage.tileSize * sy;

    for (let y = 0; y < rows; y += 1) {
      const row = stage.tiles[y];
      for (let x = 0; x < cols; x += 1) {
        const tile = row[x];
        if (tile === "#") {
          miniCtx.fillStyle = "rgba(80,96,120,0.7)";
          miniCtx.fillRect(x * tW, y * tH, tW, tH);
        } else if (tile === "~") {
          miniCtx.fillStyle = "rgba(30,46,70,0.6)";
          miniCtx.fillRect(x * tW, y * tH, tW, tH);
        }
      }
    }
  }

  miniCtx.strokeStyle = "rgba(255,255,255,0.12)";
  miniCtx.strokeRect(0.5, 0.5, w - 1, h - 1);

  const sx = w / world.width;
  const sy = h / world.height;
  const px = player.x * sx;
  const py = player.y * sy;

  miniCtx.fillStyle = "#2b69ff";
  miniCtx.beginPath();
  miniCtx.arc(px, py, 4, 0, Math.PI * 2);
  miniCtx.fill();

  if (stage.events.length) {
    stage.events.forEach((ev) => {
      const ex = ev.x * sx;
      const ey = ev.y * sy;
      miniCtx.fillStyle = ev.triggered ? "#22c55e" : "#f59e0b";
      miniCtx.beginPath();
      miniCtx.arc(ex, ey, 2.5, 0, Math.PI * 2);
      miniCtx.fill();
    });
  }

  miniCtx.strokeStyle = "rgba(255,255,255,0.2)";
  miniCtx.strokeRect(camera.x * sx, camera.y * sy, viewWidth * sx, viewHeight * sy);
}

function castVisionDistance(angle, maxRange) {
  const step = Math.max(6, stage.tileSize / 10);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let dist = 0;
  while (dist < maxRange) {
    const nx = player.x + cos * dist;
    const ny = player.y + sin * dist;
    if (isOtherPlayerAt(nx, ny)) return dist;
    if (isWallAt(nx, ny)) {
      const wallReveal = stage.tileSize * 0.35;
      return Math.min(maxRange, Math.max(0, dist - step * 0.5 + wallReveal));
    }
    dist += step;
  }
  return maxRange;
}

function isOtherPlayerAt(wx, wy) {
  if (!otherPlayers.length) return false;
  for (const p of otherPlayers) {
    const r = p.r || player.r;
    const dx = wx - p.x;
    const dy = wy - p.y;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}

function drawVisionCone() {
  if (!ctx || !visionMaskCtx) return;
  const fovDeg = player.hasLight ? FOV_LIGHT_DEG : FOV_NO_LIGHT_DEG;
  const rangeTiles = player.hasLight ? RANGE_LIGHT_TILES : RANGE_NO_LIGHT_TILES;
  const range = rangeTiles * stage.tileSize;
  const aimX = camera.x + input.mouseX;
  const aimY = camera.y + input.mouseY;
  const dx = aimX - player.x;
  const dy = aimY - player.y;
  const baseAngle = Math.atan2(dy, dx);
  const half = (fovDeg * Math.PI) / 360;
  const segments = Math.max(40, Math.ceil(fovDeg * 2.8));
  const points = [];

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const angle = baseAngle - half + t * half * 2;
    const dist = castVisionDistance(angle, range);
    points.push({
      x: player.x + Math.cos(angle) * dist,
      y: player.y + Math.sin(angle) * dist,
    });
  }
  const px = player.x - camera.x;
  const py = player.y - camera.y;

  visionMaskCtx.save();
  visionMaskCtx.clearRect(0, 0, viewWidth, viewHeight);
  visionMaskCtx.fillStyle = "#000000";
  visionMaskCtx.fillRect(0, 0, viewWidth, viewHeight);
  visionMaskCtx.globalCompositeOperation = "destination-out";
  visionMaskCtx.beginPath();
  visionMaskCtx.arc(px, py, stage.tileSize, 0, Math.PI * 2);
  visionMaskCtx.fill();
  visionMaskCtx.beginPath();
  visionMaskCtx.moveTo(px, py);
  points.forEach((p) => {
    visionMaskCtx.lineTo(p.x - camera.x, p.y - camera.y);
  });
  visionMaskCtx.closePath();
  visionMaskCtx.fill();
  visionMaskCtx.globalCompositeOperation = "source-over";
  visionMaskCtx.restore();

  renderVisionMask();
}

function resolveCollision(nx, ny) {
  if (!stage.tiles.length) return { x: nx, y: ny };
  const r = player.r;
  const points = [
    { x: nx - r, y: ny },
    { x: nx + r, y: ny },
    { x: nx, y: ny - r },
    { x: nx, y: ny + r },
  ];
  for (const p of points) {
    if (isWallAt(p.x, p.y)) {
      return { x: player.x, y: player.y };
    }
  }
  return { x: nx, y: ny };
}

function isWallAt(wx, wy) {
  const t = stage.tileSize;
  const col = Math.floor(wx / t);
  const row = Math.floor(wy / t);
  if (row < 0 || col < 0) return true;
  if (row >= stage.tiles.length) return true;
  if (col >= stage.tiles[0].length) return true;
  return stage.tiles[row][col] === "#";
}

function updateEvents() {
  if (!stage.events.length) return;
  stage.events.forEach((ev) => {
    if (ev.triggered) return;
    const dx = player.x - ev.x;
    const dy = player.y - ev.y;
    if (Math.hypot(dx, dy) <= ev.radius) {
      ev.triggered = true;
      console.log(`Event triggered: ${ev.id}`);
    }
  });
}

function drawTiles() {
  if (!stage.tiles.length) return;
  const t = stage.tileSize;
  const rows = stage.tiles.length;
  const cols = stage.tiles[0].length;
  const startCol = clamp(Math.floor(camera.x / t), 0, cols - 1);
  const endCol = clamp(Math.ceil((camera.x + viewWidth) / t), 0, cols - 1);
  const startRow = clamp(Math.floor(camera.y / t), 0, rows - 1);
  const endRow = clamp(Math.ceil((camera.y + viewHeight) / t), 0, rows - 1);

  for (let y = startRow; y <= endRow; y += 1) {
    const row = stage.tiles[y];
    for (let x = startCol; x <= endCol; x += 1) {
      const tile = row[x];
      const sx = x * t - camera.x;
      const sy = y * t - camera.y;
      if (tile === "#") {
        ctx.fillStyle = "rgba(18,28,45,0.95)";
        ctx.fillRect(sx, sy, t, t);
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.strokeRect(sx, sy, t, t);
        continue;
      }
      if (tile === "~") {
        ctx.fillStyle = "rgba(235,245,255,0.85)";
        ctx.fillRect(sx, sy, t, t);
        continue;
      }
      if (tile === ",") {
        ctx.fillStyle = "rgba(24,36,56,0.55)";
        ctx.fillRect(sx, sy, t, t);
        continue;
      }
      ctx.fillStyle = "rgba(10,16,28,0.6)";
      ctx.fillRect(sx, sy, t, t);
    }
  }
}

function getTileAt(wx, wy) {
  if (!stage.tiles.length) return ".";
  const t = stage.tileSize;
  const col = Math.floor(wx / t);
  const row = Math.floor(wy / t);
  if (row < 0 || col < 0) return "~";
  if (row >= stage.tiles.length) return "~";
  if (col >= stage.tiles[0].length) return "~";
  return stage.tiles[row][col];
}

function applyBlizzardDamage(dt) {
  if (player.hp <= 0) return;
  const tile = getTileAt(player.x, player.y);
  if (tile !== "~") return;
  player.hp = Math.max(0, player.hp - BLIZZARD_DAMAGE * dt);
}

function updateBlizzardOverlay(dt) {
  const tile = getTileAt(player.x, player.y);
  const target = tile === "~" ? 0.45 : 0;
  const speed = tile === "~" ? 3.5 : 2.8;
  blizzardFade += (target - blizzardFade) * clamp(dt * speed, 0, 1);
}

if (canvas && ctx) {
  resizeCanvas();
  initVisionGL();
  bindInput();
  player.x = world.width / 2;
  player.y = world.height / 2;
  updateHud();
  requestAnimationFrame(loop);
}

if (btnExitToMenu) {
  btnExitToMenu.addEventListener("click", () => {
    const ok = window.confirm("메인 메뉴로 돌아가면 진행이 초기화됩니다. 이동할까요?");
    if (!ok) return;
    window.location.href = "../index.html";
  });
}

async function requestFullscreen() {
  if (document.fullscreenElement) return;
  try {
    await document.documentElement.requestFullscreen();
  } catch {}
}

ingameChannel.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "remote_positions" && Array.isArray(msg.payload)) {
    otherPlayers.length = 0;
    msg.payload
      .filter((p) => p.id && p.id !== clientId)
      .forEach((p) => otherPlayers.push(p));
  }
};

ingameChannel.postMessage({ type: "ingame_ready", payload: { id: clientId } });

function sendLocalPos(nowMs) {
  if (nowMs - lastPosSent < 60) return;
  lastPosSent = nowMs;
  ingameChannel.postMessage({
    type: "local_pos",
    payload: {
      id: clientId,
      x: player.x,
      y: player.y,
      r: player.r,
    },
  });
}

function initVisionGL() {
  if (!visionGL) return;
  const vertSrc = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = (aPos + 1.0) * 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;
  const fragSrc = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uMask;
    uniform vec2 uTexel;
    uniform float uBlur;
    void main() {
      vec2 t = uTexel * uBlur;
      float a = 0.0;
      a += texture2D(uMask, vUv + t * vec2(-1.0, -1.0)).a * 0.06;
      a += texture2D(uMask, vUv + t * vec2( 0.0, -1.0)).a * 0.10;
      a += texture2D(uMask, vUv + t * vec2( 1.0, -1.0)).a * 0.06;
      a += texture2D(uMask, vUv + t * vec2(-1.0,  0.0)).a * 0.10;
      a += texture2D(uMask, vUv).a * 0.36;
      a += texture2D(uMask, vUv + t * vec2( 1.0,  0.0)).a * 0.10;
      a += texture2D(uMask, vUv + t * vec2(-1.0,  1.0)).a * 0.06;
      a += texture2D(uMask, vUv + t * vec2( 0.0,  1.0)).a * 0.10;
      a += texture2D(uMask, vUv + t * vec2( 1.0,  1.0)).a * 0.06;
      gl_FragColor = vec4(0.0, 0.0, 0.0, a);
    }
  `;
  const compile = (type, src) => {
    const shader = visionGL.createShader(type);
    if (!shader) return null;
    visionGL.shaderSource(shader, src);
    visionGL.compileShader(shader);
    if (!visionGL.getShaderParameter(shader, visionGL.COMPILE_STATUS)) {
      visionGL.deleteShader(shader);
      return null;
    }
    return shader;
  };
  const vs = compile(visionGL.VERTEX_SHADER, vertSrc);
  const fs = compile(visionGL.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return;
  const program = visionGL.createProgram();
  if (!program) return;
  visionGL.attachShader(program, vs);
  visionGL.attachShader(program, fs);
  visionGL.linkProgram(program);
  if (!visionGL.getProgramParameter(program, visionGL.LINK_STATUS)) return;
  visionGL.useProgram(program);

  const buffer = visionGL.createBuffer();
  visionGL.bindBuffer(visionGL.ARRAY_BUFFER, buffer);
  visionGL.bufferData(
    visionGL.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    visionGL.STATIC_DRAW
  );
  const aPos = visionGL.getAttribLocation(program, "aPos");
  visionGL.enableVertexAttribArray(aPos);
  visionGL.vertexAttribPointer(aPos, 2, visionGL.FLOAT, false, 0, 0);

  const texture = visionGL.createTexture();
  visionGL.bindTexture(visionGL.TEXTURE_2D, texture);
  visionGL.texParameteri(visionGL.TEXTURE_2D, visionGL.TEXTURE_MIN_FILTER, visionGL.LINEAR);
  visionGL.texParameteri(visionGL.TEXTURE_2D, visionGL.TEXTURE_MAG_FILTER, visionGL.LINEAR);
  visionGL.texParameteri(visionGL.TEXTURE_2D, visionGL.TEXTURE_WRAP_S, visionGL.CLAMP_TO_EDGE);
  visionGL.texParameteri(visionGL.TEXTURE_2D, visionGL.TEXTURE_WRAP_T, visionGL.CLAMP_TO_EDGE);

  visionProgram = program;
  visionBuffer = buffer;
  visionTexture = texture;
  visionUniforms = {
    mask: visionGL.getUniformLocation(program, "uMask"),
    texel: visionGL.getUniformLocation(program, "uTexel"),
    blur: visionGL.getUniformLocation(program, "uBlur"),
  };

  visionGL.enable(visionGL.BLEND);
  visionGL.blendFunc(visionGL.SRC_ALPHA, visionGL.ONE_MINUS_SRC_ALPHA);
}

function renderVisionMask() {
  if (!visionGL || !visionProgram || !visionTexture || !visionUniforms) return;
  visionGL.useProgram(visionProgram);
  visionGL.activeTexture(visionGL.TEXTURE0);
  visionGL.bindTexture(visionGL.TEXTURE_2D, visionTexture);
  visionGL.pixelStorei(visionGL.UNPACK_FLIP_Y_WEBGL, true);
  visionGL.texImage2D(
    visionGL.TEXTURE_2D,
    0,
    visionGL.RGBA,
    visionGL.RGBA,
    visionGL.UNSIGNED_BYTE,
    visionMaskCanvas
  );
  const texelX = 1 / visionMaskCanvas.width;
  const texelY = 1 / visionMaskCanvas.height;
  visionGL.uniform1i(visionUniforms.mask, 0);
  visionGL.uniform2f(visionUniforms.texel, texelX, texelY);
  visionGL.uniform1f(visionUniforms.blur, 20);
  visionGL.drawArrays(visionGL.TRIANGLE_STRIP, 0, 4);
}

async function loadStage(stageKey) {
  const url = `../stages/${stageKey}.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`stage load failed: ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.tiles)) {
      stage.tiles = data.tiles;
      stage.tileSize = Number(data.tileSize) || stage.tileSize;
      stage.events = Array.isArray(data.events) ? data.events : [];
      stage.events = stage.events.map((ev) => {
        const x = typeof ev.tileX === "number" ? ev.tileX * stage.tileSize + stage.tileSize / 2 : ev.x;
        const y = typeof ev.tileY === "number" ? ev.tileY * stage.tileSize + stage.tileSize / 2 : ev.y;
        return {
          id: ev.id || "event",
          type: ev.type || "event",
          title: ev.title || "",
          radius: ev.radius || 120,
          x: x ?? 0,
          y: y ?? 0,
          triggered: false,
        };
      });
      world.width = stage.tiles[0].length * stage.tileSize;
      world.height = stage.tiles.length * stage.tileSize;
      const spawn = findSpawnPoint();
      player.x = spawn.x;
      player.y = spawn.y;
    }
  } catch {
    stage.tiles = [];
  }
}

loadStage(getStageKey());

function findSpawnPoint() {
  if (!stage.tiles.length) {
    return { x: world.width / 2, y: world.height / 2 };
  }
  const rows = stage.tiles.length;
  const cols = stage.tiles[0].length;
  for (let y = 0; y < rows; y += 1) {
    const row = stage.tiles[y];
    for (let x = 0; x < cols; x += 1) {
      if (row[x] === "S") {
        return {
          x: x * stage.tileSize + stage.tileSize / 2,
          y: y * stage.tileSize + stage.tileSize / 2,
        };
      }
    }
  }
  return { x: world.width / 2, y: world.height / 2 };
}
