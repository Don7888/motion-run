// Motion Run — TV game (Three.js third-person runner)
//
// Player is controlled entirely by messages relayed from the phone
// controller over WebSocket: {type:'input', action:'lane', value:-1|1},
// {type:'input', action:'jump'}, {type:'input', action:'punch'}.

import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

// ---------------------------------------------------------------------
// Constants / tuning
// ---------------------------------------------------------------------
const LANE_X = [-2.4, 0, 2.4];
const COLLISION_Z_MIN = -1.1;
const COLLISION_Z_MAX = 1.1;
const SPAWN_Z = -80;
const DESPAWN_Z = 8;

const BASE_SPEED = 12;      // units/sec at score 0
const MAX_SPEED = 26;
const SPEED_RAMP = 0.0022;  // speed added per score point

const BASE_SPAWN_INTERVAL = 1.65; // seconds
const MIN_SPAWN_INTERVAL = 0.85;
const SPAWN_RAMP = 0.00035;

const JUMP_VELOCITY = 8.2;
const GRAVITY = -22;

const PUNCH_DURATION = 0.34; // seconds arm is "active"
const HIT_INVULN_TIME = 1.1;

const OBSTACLE_TYPES = ['hurdle', 'crate', 'wall'];

// ---------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------
const canvas = document.getElementById('gameCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fd3ff);
scene.fog = new THREE.Fog(0x8fd3ff, 30, 85);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 4.6, 8.2);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Lights
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(-6, 12, 6);
scene.add(sun);

// ---------------------------------------------------------------------
// Ground (scrolling texture, no geometry recycling needed)
// ---------------------------------------------------------------------
function makeRoadTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3a7d3f';
  ctx.fillRect(0, 0, 256, 512);
  ctx.fillStyle = '#5a5f6b';
  ctx.fillRect(48, 0, 160, 512);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 6;
  ctx.setLineDash([28, 24]);
  ctx.beginPath(); ctx.moveTo(128 - 53, 0); ctx.lineTo(128 - 53, 512); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(128 + 53, 0); ctx.lineTo(128 + 53, 512); ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 60);
  return tex;
}
const roadTexture = makeRoadTexture();
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(14, 500),
  new THREE.MeshLambertMaterial({ map: roadTexture })
);
ground.rotation.x = -Math.PI / 2;
ground.position.z = -180;
scene.add(ground);

// ---------------------------------------------------------------------
// Player (procedural low-poly character)
// ---------------------------------------------------------------------
function limb(w, h, d, color, pivotYOffset) {
  const pivot = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color })
  );
  mesh.position.y = -h / 2;
  pivot.add(mesh);
  pivot.position.y = pivotYOffset;
  return pivot;
}

const player = new THREE.Group();

const torso = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.42, 0.55, 4, 8),
  new THREE.MeshLambertMaterial({ color: 0xff5a5f })
);
torso.position.y = 1.15;
player.add(torso);

const head = new THREE.Mesh(
  new THREE.SphereGeometry(0.32, 16, 16),
  new THREE.MeshLambertMaterial({ color: 0xffd7b0 })
);
head.position.y = 1.85;
player.add(head);

// Hair/hat are rebuilt on demand by dressPlayer() from the phone's
// character-creator choice; both groups live in head-local space so they
// automatically follow head position/animation.
const hairGroup = new THREE.Group();
head.add(hairGroup);
const hatGroup = new THREE.Group();
head.add(hatGroup);
let propellerBlade = null; // spun each frame in updatePlaying() when present

function clearGroup(group) {
  while (group.children.length) {
    const child = group.children.pop();
    child.geometry?.dispose();
    child.material?.dispose();
  }
}

function buildHair(style, color) {
  clearGroup(hairGroup);
  const mat = new THREE.MeshLambertMaterial({ color });
  if (style === 'bald') return;
  if (style === 'short' || style === 'pony') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.335, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    hairGroup.add(cap);
    if (style === 'pony') {
      const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.28, 4, 6), mat);
      tail.position.set(0, 0.05, 0.3);
      tail.rotation.x = -0.9;
      hairGroup.add(tail);
    }
  } else if (style === 'spiky') {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.16, 6), mat);
      spike.position.set(Math.cos(a) * 0.14, 0.28, Math.sin(a) * 0.14);
      spike.rotation.set((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4);
      hairGroup.add(spike);
    }
  } else if (style === 'afro') {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 12), mat);
    puff.position.y = 0.06;
    hairGroup.add(puff);
  }
}

function buildHat(style, color) {
  clearGroup(hatGroup);
  propellerBlade = null;
  const mat = new THREE.MeshLambertMaterial({ color });
  if (style === 'none') return;
  if (style === 'party') {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 10), mat);
    cone.position.y = 0.55;
    const pompom = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    pompom.position.y = 0.81;
    hatGroup.add(cone, pompom);
  } else if (style === 'top') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.35, 12), mat);
    body.position.y = 0.475;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.04, 12), mat);
    brim.position.y = 0.32;
    hatGroup.add(body, brim);
  } else if (style === 'cap' || style === 'propeller') {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.36, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.1), mat);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 0.2), mat);
    brim.position.set(0, 0.28, -0.28);
    hatGroup.add(dome, brim);
    if (style === 'propeller') {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 6), new THREE.MeshLambertMaterial({ color: 0x888888 }));
      stick.position.y = 0.62;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, 0.06), new THREE.MeshLambertMaterial({ color: 0xffd166 }));
      blade.position.y = 0.67;
      propellerBlade = blade;
      hatGroup.add(stick, blade);
    }
  }
}

function dressPlayer(character) {
  if (!character) return;
  buildHair(character.hair || 'bald', character.hairColor || '#3b2a1a');
  buildHat(character.hat || 'none', character.hatColor || '#ff5a5f');
  if (character.shirtColor) torso.material.color.set(character.shirtColor);
}
dressPlayer({ hair: 'short', hairColor: '#3b2a1a', hat: 'none', hatColor: '#ff5a5f', shirtColor: '#ff5a5f' });

const armL = limb(0.18, 0.62, 0.18, 0xff5a5f, 1.52);
armL.position.x = -0.52;
player.add(armL);
const armR = limb(0.18, 0.62, 0.18, 0xff5a5f, 1.52);
armR.position.x = 0.52;
player.add(armR);

const legL = limb(0.22, 0.62, 0.22, 0x2b2f45, 0.78);
legL.position.x = -0.2;
player.add(legL);
const legR = limb(0.22, 0.62, 0.22, 0x2b2f45, 0.78);
legR.position.x = 0.2;
player.add(legR);

player.position.set(0, 0, 0);
scene.add(player);

const shadowBlob = new THREE.Mesh(
  new THREE.CircleGeometry(0.55, 20),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 })
);
shadowBlob.rotation.x = -Math.PI / 2;
shadowBlob.position.y = 0.02;
scene.add(shadowBlob);

// ---------------------------------------------------------------------
// Scenery (decorative, non-colliding, purely for a sense of speed)
// ---------------------------------------------------------------------
const sceneryPool = [];
function makeTree() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.4, 6), new THREE.MeshLambertMaterial({ color: 0x7a5230 }));
  trunk.position.y = 0.7;
  const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.0, 2.0, 8), new THREE.MeshLambertMaterial({ color: 0x2e7d4f }));
  leaves.position.y = 2.1;
  g.add(trunk, leaves);
  return g;
}
for (let i = 0; i < 16; i++) {
  const t = makeTree();
  const side = i % 2 === 0 ? -1 : 1;
  t.position.set(side * (5.5 + Math.random() * 3), 0, -i * 12 - Math.random() * 6);
  scene.add(t);
  sceneryPool.push(t);
}

// ---------------------------------------------------------------------
// Obstacles
// ---------------------------------------------------------------------
const obstacles = [];

function buildObstacleMesh(type) {
  if (type === 'hurdle') {
    const g = new THREE.Group();
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.18), new THREE.MeshLambertMaterial({ color: 0xffb703 }));
    bar.position.y = 0.55;
    const legA = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.55, 0.1), new THREE.MeshLambertMaterial({ color: 0xd98a00 }));
    legA.position.set(-0.65, 0.275, 0);
    const legB = legA.clone(); legB.position.x = 0.65;
    g.add(bar, legA, legB);
    return g;
  }
  if (type === 'crate') {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.1, 1.0), new THREE.MeshLambertMaterial({ color: 0xa5682a }));
    m.position.y = 0.55;
    return m;
  }
  // wall
  const m = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.6, 0.6), new THREE.MeshLambertMaterial({ color: 0x6c7a89 }));
  m.position.y = 1.3;
  return m;
}

function spawnObstacle() {
  const type = OBSTACLE_TYPES[Math.floor(Math.random() * OBSTACLE_TYPES.length)];
  const lane = Math.floor(Math.random() * 3);
  const mesh = buildObstacleMesh(type);
  mesh.position.x = LANE_X[lane];
  mesh.position.z = SPAWN_Z;
  scene.add(mesh);
  obstacles.push({ type, lane, mesh, resolved: false });
}

// ---------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------
const state = {
  phase: 'pairing', // pairing -> ready -> playing -> gameover
  score: 0,
  lives: 3,
  lane: 1,
  grounded: true,
  vy: 0,
  jumping: false,
  punchTimer: 0,
  invulnTimer: 0,
  spawnTimer: BASE_SPAWN_INTERVAL,
  distanceForTex: 0,
};

const scoreVal = document.getElementById('scoreVal');
const livesEl = document.getElementById('lives');
const pairingPanel = document.getElementById('pairingPanel');
const readyPanel = document.getElementById('readyPanel');
const gameOverPanel = document.getElementById('gameOverPanel');
const calibrationPanel = document.getElementById('calibrationPanel');
const calStepCounter = document.getElementById('calStepCounter');
const calMoveIcon = document.getElementById('calMoveIcon');
const calMoveText = document.getElementById('calMoveText');
const calDots = document.getElementById('calDots');
const placementPanel = document.getElementById('placementPanel');
const framingPanel = document.getElementById('framingPanel');
const framingSilhouette = document.getElementById('framingSilhouette');
const framingStatusText = document.getElementById('framingStatusText');
const framingSubHint = document.getElementById('framingSubHint');
const roomCodeEl = document.getElementById('roomCode');
const playUrlEl = document.getElementById('playUrl');
const pairingHint = document.getElementById('pairingHint');
const comboEl = document.getElementById('combo');
const flashEl = document.getElementById('flash');
const finalScoreEl = document.getElementById('finalScore');

function renderLives() {
  livesEl.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const span = document.createElement('span');
    span.className = 'heart' + (i < state.lives ? '' : ' lost');
    span.textContent = '❤️';
    livesEl.appendChild(span);
  }
}
renderLives();

const PANELS = {
  pairing: pairingPanel,
  ready: readyPanel,
  gameover: gameOverPanel,
  calibrating: calibrationPanel,
  placement: placementPanel,
  framing: framingPanel,
};
function showPanel(which) {
  Object.entries(PANELS).forEach(([name, el]) => {
    el.style.display = name === which ? 'block' : 'none';
  });
}

// A player working through setup (placement/framing/calibrating) on the
// phone shouldn't fight the "Player connected!" panel for screen space —
// any active setup stage overrides whatever `state.phase` would otherwise
// show, until the phone signals it's done. Priority: placement > framing >
// per-move calibration > normal phase-based panels.
function syncPanel() {
  if (setupStage === 'placement') { showPanel('placement'); return; }
  if (setupStage === 'framing') { showPanel('framing'); return; }
  if (calibrating) { showPanel('calibrating'); return; }
  if (state.phase === 'pairing') showPanel('pairing');
  else if (state.phase === 'ready') showPanel('ready');
  else if (state.phase === 'gameover') showPanel('gameover');
  else showPanel(null);
}

// =========================================================================
// CAMERA SETUP — PLACEMENT + FRAMING CHECK
//
// Camera mode needs the player to physically prop the phone up and walk
// away from it before any gesture detection should react to anything —
// otherwise the player fumbling with the phone (or just walking across the
// room) gets misread as jumps/punches/lane changes. So camera-mode setup
// now runs in three stages, all displayed here on the TV and driven mostly
// by the Fire TV remote's OK/Select button (Enter key) once the phone is
// out of the player's hands:
//
//   1. "placement"  — static instructions ("place your phone under the TV
//      and step back"). Advances on remote OK, which we relay back to the
//      phone as a `calibration_control` message so it knows to start
//      evaluating the camera framing.
//   2. "framing"    — the phone continuously reports whether it can see
//      enough of the player at a sensible distance (`calibration` event
//      'framing', {status, ready}); we show a silhouette guide here and
//      either auto-advance once "ready" has held for a bit, or let the
//      remote OK button confirm/skip early.
//   3. per-move calibration (existing `calibrating` flow below) — only
//      begins once we've told the phone `moves_ack`, which is also the
//      point the phone starts reacting to real jump/punch/lane gestures.
//
// Hold-phone mode skips straight to per-move calibration (`calibrating`)
// since the player keeps the phone in hand throughout — there's nothing to
// "get in frame" for.
// =========================================================================
let setupStage = 'none'; // 'none' | 'placement' | 'framing'
let framingStatus = 'no_person';
let framingReady = false;
let framingReadySinceT = null;
let movesConfirmSent = false;
const FRAMING_AUTO_ADVANCE_MS = 900;

const FRAMING_META = {
  no_person: { text: 'Step into frame', color: '#ff8a8a' },
  too_close: { text: 'Move back a little', color: '#ffd166' },
  too_far: { text: 'Move a bit closer', color: '#ffd166' },
  off_center: { text: 'Move to the center', color: '#ffd166' },
  good: { text: 'Perfect! Hold still…', color: '#6ee7ff' },
};

function sendCalibrationControl(action) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'calibration_control', action }));
}

function startPlacementUI() {
  setupStage = 'placement';
  movesConfirmSent = false;
  framingReady = false;
  framingReadySinceT = null;
  syncPanel();
}

function renderFramingPanel() {
  const meta = FRAMING_META[framingStatus] || FRAMING_META.no_person;
  framingStatusText.textContent = meta.text;
  framingSilhouette.style.setProperty('--sil-color', meta.color);
  framingSilhouette.classList.toggle('good', framingStatus === 'good');
  framingSubHint.textContent = framingReady
    ? "Press OK to continue, or we'll start in a moment…"
    : "Press OK once you're set, or hold still and we'll continue automatically";
}

function updateFramingUI(status, ready) {
  setupStage = 'framing';
  framingStatus = status;
  if (ready && !framingReady) framingReadySinceT = performance.now();
  if (!ready) framingReadySinceT = null;
  framingReady = ready;
  renderFramingPanel();
  syncPanel();
}

function confirmMovesStart() {
  if (movesConfirmSent || setupStage !== 'framing') return;
  movesConfirmSent = true;
  sendCalibrationControl('moves_ack');
}

// =========================================================================
// GUIDED CALIBRATION — walked through here on the TV, one move at a time,
// while the phone (which owns the camera/motion sensors) detects each move
// and reports progress over WebSocket. See README "The guided calibration
// screen" for the full flow.
// =========================================================================
const CAL_ORDER = ['left', 'right', 'jump', 'punch'];
const CAL_META = {
  left: { icon: '⬅️', textCamera: 'Step LEFT', textHold: 'Lean LEFT' },
  right: { icon: '➡️', textCamera: 'Step RIGHT', textHold: 'Lean RIGHT' },
  jump: { icon: '⬆️', textCamera: 'JUMP', textHold: 'JUMP' },
  punch: { icon: '👊', textCamera: 'PUNCH', textHold: 'PUNCH' },
};
let calibrating = false;
let calMode = 'camera';
let calIndex = 0;
let calDone = { left: false, right: false, jump: false, punch: false };

function renderCalDots() {
  calDots.textContent = CAL_ORDER.map((key, i) => (calDone[key] ? '✅' : i === calIndex ? '🔵' : '⚪')).join(' ');
}
function showCalibrationStep() {
  if (calIndex >= CAL_ORDER.length) {
    calMoveIcon.textContent = '🎉';
    calMoveText.textContent = 'All set!';
    calStepCounter.textContent = 'Nice work!';
    renderCalDots();
    return;
  }
  const meta = CAL_META[CAL_ORDER[calIndex]];
  calMoveIcon.textContent = meta.icon;
  calMoveText.textContent = calMode === 'hold' ? meta.textHold : meta.textCamera;
  calStepCounter.textContent = `Step ${calIndex + 1} of ${CAL_ORDER.length}`;
  renderCalDots();
}
function startCalibrationUI(mode) {
  calibrating = true;
  setupStage = 'none'; // placement/framing are done — the per-move panel takes over
  calMode = mode || 'camera';
  calIndex = 0;
  calDone = { left: false, right: false, jump: false, punch: false };
  showCalibrationStep();
  syncPanel();
}
function advanceCalibrationUI(step) {
  if (!calibrating || !(step in calDone) || calDone[step]) return;
  calDone[step] = true;
  // Advance to the next not-yet-done step — keeps things moving forward
  // even if the player's attempts land slightly out of the shown order.
  while (calIndex < CAL_ORDER.length && calDone[CAL_ORDER[calIndex]]) calIndex++;
  showCalibrationStep();
}
function finishCalibrationUI() {
  calibrating = false;
  setupStage = 'none'; // covers the "Skip setup" escape hatch firing mid-placement/framing
  syncPanel();
}

function popCombo(text) {
  comboEl.textContent = text;
  comboEl.style.opacity = '1';
  clearTimeout(popCombo._t);
  popCombo._t = setTimeout(() => (comboEl.style.opacity = '0'), 450);
}

function flashHit() {
  flashEl.style.opacity = '0.55';
  setTimeout(() => (flashEl.style.opacity = '0'), 120);
}

function resetRun() {
  state.score = 0;
  state.lives = 3;
  state.lane = 1;
  state.grounded = true;
  state.vy = 0;
  state.jumping = false;
  state.punchTimer = 0;
  state.invulnTimer = 0;
  state.spawnTimer = BASE_SPAWN_INTERVAL;
  obstacles.splice(0).forEach((o) => scene.remove(o.mesh));
  player.position.set(0, 0, 0);
  renderLives();
  scoreVal.textContent = '0';
}

function startPlaying() {
  resetRun();
  state.phase = 'playing';
  calibrating = false;
  showPanel(null);
}

function gameOver() {
  state.phase = 'gameover';
  finalScoreEl.textContent = Math.floor(state.score);
  syncPanel();
}

// ---------------------------------------------------------------------
// WebSocket — pairing + input relay
// ---------------------------------------------------------------------
const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${wsProtocol}://${location.host}`);

playUrlEl.textContent = `${location.host}/play`;

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'register', role: 'tv' }));
});

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  if (msg.type === 'room') {
    roomCodeEl.textContent = msg.code;
  } else if (msg.type === 'controller_connected') {
    if (msg.count > 0 && (state.phase === 'pairing')) {
      state.phase = 'ready';
      syncPanel();
    } else if (msg.count === 0 && state.phase !== 'playing') {
      state.phase = 'pairing';
      calibrating = false;
      setupStage = 'none';
      syncPanel();
    }
  } else if (msg.type === 'input') {
    handleInput(msg);
  } else if (msg.type === 'character') {
    dressPlayer(msg);
  } else if (msg.type === 'calibration') {
    if (msg.event === 'placement') startPlacementUI();
    else if (msg.event === 'framing') updateFramingUI(msg.status, msg.ready);
    else if (msg.event === 'start') startCalibrationUI(msg.mode);
    else if (msg.event === 'step') advanceCalibrationUI(msg.step);
    else if (msg.event === 'done') finishCalibrationUI();
  } else if (msg.type === 'error') {
    pairingHint.textContent = msg.message;
  }
});

ws.addEventListener('close', () => {
  pairingHint.textContent = 'Connection lost — refresh this page to reconnect.';
});

function handleInput(msg) {
  if (state.phase === 'ready' && (msg.action === 'jump' || msg.action === 'punch')) {
    startPlaying();
    return;
  }
  if (state.phase === 'gameover' && (msg.action === 'jump' || msg.action === 'punch')) {
    startPlaying();
    return;
  }
  if (state.phase !== 'playing') return;

  if (msg.action === 'lane') {
    // Relative one-lane nudge (used by tap-to-steer on the phone).
    const dir = msg.value > 0 ? 1 : -1;
    state.lane = Math.max(0, Math.min(2, state.lane + dir));
  } else if (msg.action === 'lane_set') {
    // Absolute lane target (used by camera/hold-phone body tracking) —
    // msg.value is -1/0/1 for left/center/right, so the character always
    // sits wherever the player's body currently is, including snapping
    // straight back to the center lane the moment they return to a
    // neutral stance, with no extra "return" gesture required.
    state.lane = Math.max(0, Math.min(2, 1 + msg.value));
  } else if (msg.action === 'jump') {
    if (state.grounded) {
      state.grounded = false;
      state.jumping = true;
      state.vy = JUMP_VELOCITY;
    }
  } else if (msg.action === 'punch') {
    state.punchTimer = PUNCH_DURATION;
  }
}

// The Fire TV remote's center OK/Select button reaches the page as a
// standard 'Enter' keydown (same as a TV media-app would see) — we haven't
// been able to test this against real Fire TV hardware in this build
// environment, so also accept Space/NumpadEnter as fallbacks in case the
// remote maps differently on your specific device. This is what drives the
// player through the placement and framing setup stages from the couch,
// once the phone itself is out of their hands.
function isSelectPress(e) {
  return e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space';
}

window.addEventListener('keydown', (e) => {
  if (setupStage === 'placement' && isSelectPress(e)) {
    sendCalibrationControl('placement_ack');
    return;
  }
  if (setupStage === 'framing' && isSelectPress(e)) {
    confirmMovesStart();
    return;
  }

  // Fallback: also allow keyboard testing on this screen (A/D or arrows to
  // change lane, Space to jump, F to punch) — handy when testing without a
  // phone in hand.
  if (state.phase !== 'playing' && (e.code === 'Space' || e.code === 'KeyF')) {
    if (state.phase === 'ready' || state.phase === 'gameover') startPlaying();
    return;
  }
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') handleInput({ type: 'input', action: 'lane', value: -1 });
  if (e.code === 'ArrowRight' || e.code === 'KeyD') handleInput({ type: 'input', action: 'lane', value: 1 });
  if (e.code === 'Space') handleInput({ type: 'input', action: 'jump' });
  if (e.code === 'KeyF') handleInput({ type: 'input', action: 'punch' });
});

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------
let lastT = performance.now();

function currentSpeed() {
  return Math.min(MAX_SPEED, BASE_SPEED + state.score * SPEED_RAMP);
}

function updatePlaying(dt) {
  const speed = currentSpeed();
  state.score += speed * dt * 1.4;
  scoreVal.textContent = String(Math.floor(state.score));

  // Ground scroll
  state.distanceForTex += speed * dt;
  roadTexture.offset.y = (state.distanceForTex / 8) % 1;

  // Scenery scroll (recycle)
  sceneryPool.forEach((t) => {
    t.position.z += speed * dt;
    if (t.position.z > 10) t.position.z -= 16 * sceneryPool.length * 0.5;
  });

  // Player lane lerp + lean
  const targetX = LANE_X[state.lane];
  const dx = targetX - player.position.x;
  player.position.x += dx * Math.min(1, dt * 9);
  player.rotation.z = THREE.MathUtils.lerp(player.rotation.z, THREE.MathUtils.clamp(-dx * 0.35, -0.35, 0.35), dt * 10);

  // Jump physics
  if (!state.grounded) {
    state.vy += GRAVITY * dt;
    player.position.y += state.vy * dt;
    if (player.position.y <= 0) {
      player.position.y = 0;
      state.vy = 0;
      state.grounded = true;
      state.jumping = false;
    }
  }
  shadowBlob.position.x = player.position.x;
  shadowBlob.scale.setScalar(THREE.MathUtils.clamp(1 - player.position.y * 0.15, 0.4, 1));

  // Punch timer
  if (state.punchTimer > 0) state.punchTimer = Math.max(0, state.punchTimer - dt);
  if (state.invulnTimer > 0) state.invulnTimer = Math.max(0, state.invulnTimer - dt);

  // Procedural animation
  const runT = state.distanceForTex * 1.6;
  const swing = state.grounded ? Math.sin(runT) * 0.6 : 0;
  legL.rotation.x = state.grounded ? swing : -0.5;
  legR.rotation.x = state.grounded ? -swing : 0.3;
  armL.rotation.x = state.grounded ? -swing * 0.8 : -0.4;
  head.position.y = 1.85 + (state.grounded ? Math.abs(Math.sin(runT)) * 0.03 : 0.05);
  if (propellerBlade) propellerBlade.rotation.y += dt * 14;

  if (state.punchTimer > 0) {
    const t = 1 - state.punchTimer / PUNCH_DURATION;
    const ext = t < 0.5 ? t * 2 : (1 - t) * 2;
    armR.rotation.x = -ext * 1.9;
  } else {
    armR.rotation.x = state.grounded ? swing * 0.8 : -0.4;
  }

  // Camera follow
  camera.position.x += (player.position.x * 0.6 - (camera.position.x - 0)) * Math.min(1, dt * 4);
  camera.lookAt(player.position.x * 0.4, 1.3, -8);

  // Spawn obstacles
  state.spawnTimer -= dt;
  if (state.spawnTimer <= 0) {
    spawnObstacle();
    const interval = Math.max(MIN_SPAWN_INTERVAL, BASE_SPAWN_INTERVAL - state.score * SPAWN_RAMP);
    state.spawnTimer = interval * (0.8 + Math.random() * 0.4);
  }

  // Update obstacles
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    o.mesh.position.z += speed * dt;

    if (!o.resolved && o.mesh.position.z >= COLLISION_Z_MIN && o.mesh.position.z <= COLLISION_Z_MAX) {
      o.resolved = true;
      if (o.lane === state.lane) {
        let safe = false;
        if (o.type === 'hurdle') safe = !state.grounded;
        else if (o.type === 'crate') safe = state.punchTimer > 0;
        else safe = false; // wall: only lane-dodge saves you

        if (safe) {
          popCombo(o.type === 'hurdle' ? 'JUMP!' : o.type === 'crate' ? 'SMASH!' : '');
          state.score += 25;
        } else if (state.invulnTimer <= 0) {
          state.lives -= 1;
          state.invulnTimer = HIT_INVULN_TIME;
          renderLives();
          flashHit();
          if (state.lives <= 0) { gameOver(); return; }
        }
      }
    }

    if (o.mesh.position.z > DESPAWN_Z) {
      scene.remove(o.mesh);
      obstacles.splice(i, 1);
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (state.phase === 'playing') updatePlaying(dt);

  // Auto-advance out of the framing check once "good" framing has held for
  // a moment — the remote OK press (see keydown handler above) can also
  // confirm this early, so whichever happens first wins.
  if (setupStage === 'framing' && framingReady && framingReadySinceT !== null
      && now - framingReadySinceT > FRAMING_AUTO_ADVANCE_MS) {
    confirmMovesStart();
  }

  renderer.render(scene, camera);
}
animate();
