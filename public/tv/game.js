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

// 2026-09-03: difficulty now ramps on DISTANCE TRAVELLED, not score. Score
// used to accumulate automatically with distance, so the two were the same
// quantity — but points now come only from collecting coins and gems, which
// means a player who misses everything would otherwise never speed up (and
// a greedy one would ramp unfairly fast). The constants are the old
// per-score-point values scaled by the old score-per-metre rate (~1.4), so
// the difficulty curve over a run is unchanged.
const BASE_SPEED = 12;      // units/sec at the start of a run
const MAX_SPEED = 26;
const SPEED_RAMP = 0.003;   // speed added per metre travelled

const BASE_SPAWN_INTERVAL = 1.65; // seconds
const MIN_SPAWN_INTERVAL = 0.85;
const SPAWN_RAMP = 0.0005;  // per metre travelled

// ---- Collectibles ---------------------------------------------------
// Coins are the Sonic-ring layer: a near-constant stream to run through, so
// there's always something to aim for between obstacles. Gems are the
// reward layer — deliberately placed high, above a hurdle, so the only way
// to get one is to actually jump the hurdle rather than dodge into another
// lane. Points come exclusively from these two.
const COIN_VALUE = 10;
const GEM_VALUE = 50;
const COIN_Y = 1.15;          // chest height — collected just by running through
const GEM_Y = 2.75;           // only reachable mid-jump
const GEM_MIN_PLAYER_Y = 0.9; // how high the player must actually be to take a gem
const COIN_RUN_MIN = 4;       // coins per trail
const COIN_RUN_MAX = 7;
const COIN_SPACING = 2.6;     // metres between coins in a trail
const BASE_COIN_INTERVAL = 1.5; // seconds between trails
const PICKUP_RADIUS_Z = 1.5;  // how forgiving collection is along the track
const PUNCH_COIN_REWARD = 3;  // coins released by smashing a crate

// Countdown before every run (2026-09-03) — the game now starts on its own
// rather than waiting for a Start press, so the player needs a moment to
// put the phone down and get into position first.
const COUNTDOWN_SECONDS = 4;      // 3, 2, 1, GO!
const GAMEOVER_RESTART_DELAY = 4.5; // seconds on the Run Over screen before going again

const JUMP_VELOCITY = 8.2;
const GRAVITY = -22;

const PUNCH_DURATION = 0.34; // seconds arm is "active" (gameplay hit-window — untouched, balance-sensitive)
const HIT_INVULN_TIME = 1.1;

// Cosmetic-only punch animation timing — deliberately separate from
// PUNCH_DURATION above. PUNCH_DURATION gates real gameplay (how long a
// crate arriving at the collision zone counts as "safely smashed"), so it
// stays exactly as tuned. This timer just drives the exaggerated visual
// windup/snap/settle and can run longer without touching game balance.
// Sized up again 2026-09-02 ("not exaggerated enough" feedback) — bigger
// windup, further reach, and a stronger overshoot snap (see the increased
// easeOutBack() overshoot constant below too).
const PUNCH_ANIM_DURATION = 0.68;
const PUNCH_WINDUP_FRAC = 0.15; // fraction of the animation spent winding up (arm pulls back)
const PUNCH_SNAP_FRAC = 0.3;    // fraction spent snapping forward (with overshoot)
const PUNCH_WINDUP_PULL = 0.85; // radians the arm pulls back before throwing the punch
const PUNCH_MAX_EXTEND = -2.95; // radians of forward extension at full reach (~169°) — big and cartoonish

const OBSTACLE_TYPES = ['hurdle', 'crate', 'wall'];

// On-screen action prompt (added 2026-09-02, "prompt telling the player
// when to punch/jump so they can time it" feedback) — see
// updateActionPrompt() below for the logic; this is just the per-type copy.
const ACTION_PROMPT_META = {
  hurdle: { icon: '⬆️', text: 'JUMP!' },
  crate: { icon: '👊', text: 'PUNCH!' },
  wall: { icon: '↔️', text: 'MOVE!' },
};
const PROMPT_LEAD_TIME = 0.85; // seconds of warning shown before the obstacle reaches the collision zone

// Obstacle knockback (see launchObstacleFlying()) — a punched crate
// rockets off with its own little projectile arc instead of just scrolling
// past like normal, which is the whole "send it flying" payoff of a
// successful punch.
const OBSTACLE_GRAVITY = -30;
const PUNCH_LAUNCH_VY = 12;
const PUNCH_LAUNCH_VZ_BOOST = 15;
const PUNCH_LAUNCH_VX_SPREAD = 7;
const FLYING_DESPAWN_Z = DESPAWN_Z + 24;

// ---------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------
const canvas = document.getElementById('gameCanvas');
// 2026-09-02 "lag is still just as bad" fix: Fire TV Stick GPUs are weak
// mobile-class hardware (often well below even a mid-range phone), and
// the previous settings here — MSAA antialiasing plus rendering at up to
// 2x devicePixelRatio — can easily cost more fill-rate than that hardware
// has, which produces real, felt choppiness no amount of input-latency
// tuning (the previous round's fix) can paper over. A TV output is a
// fixed physical resolution anyway, so supersampling above 1x buys very
// little visible sharpness there for a lot of extra per-pixel cost.
// Start conservative — no MSAA, pixelRatio capped at 1 — and see
// maybeDowngradeQuality() below animate() for a one-time further
// step-down if the device is still measurably short of a smooth frame
// rate even at these settings.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
// 2026-09-02 "improve the locations" visual pass: a plain flat-color
// background reads as an empty void behind the track. A baked (not
// per-frame — this canvas runs once, at startup) vertical gradient sky
// with a soft sun glow costs nothing extra at render time (it's still
// just one background fill, same as the flat color it replaces) but adds
// real atmosphere. Fog color is sampled from the gradient's horizon band
// so distant obstacles/scenery fade into the sky instead of into a
// mismatched flat tone.
function makeSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 512;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#2f6fd8');
  grad.addColorStop(0.45, '#6fb3ea');
  grad.addColorStop(0.72, '#bfe3f5');
  grad.addColorStop(1, '#e9f6ea');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 512);
  // Soft sun glow near the horizon, off to one side, matching the
  // directional "sun" light's rough position below.
  const sun = ctx.createRadialGradient(1.4, 300, 0, 1.4, 300, 220);
  sun.addColorStop(0, 'rgba(255,250,225,0.9)');
  sun.addColorStop(1, 'rgba(255,250,225,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.background = makeSkyTexture();
scene.fog = new THREE.Fog(0xbfe3f5, 30, 85);

const CAMERA_BASE_Y = 4.6;
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, CAMERA_BASE_Y, 8.2);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Lights — hemisphere for soft sky/ground fill (cheap, no shadow cost),
// directional "sun" for shape-defining highlights, plus a very low-cost
// second directional as a cool rim/fill from the opposite side so the
// character and obstacles don't look flatly lit head-on. None of these
// cast shadow maps — that's a real GPU cost on weak Fire TV Stick
// hardware and blob shadows (see shadowBlob below) already sell "grounded"
// well enough for this low-poly style.
scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x445566, 0.95));
const sun = new THREE.DirectionalLight(0xfff3d6, 1.0);
sun.position.set(-6, 12, 6);
scene.add(sun);
const rimLight = new THREE.DirectionalLight(0x8fb8ff, 0.35);
rimLight.position.set(8, 6, -10);
scene.add(rimLight);

// ---------------------------------------------------------------------
// Ground (scrolling texture, no geometry recycling needed)
// ---------------------------------------------------------------------
function makeRoadTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const ctx = c.getContext('2d');
  // Grass either side of the path — two-tone with a scatter of darker
  // flecks instead of a single flat fill, so the ground reads as a
  // textured surface rather than a solid color plane, even at a glance.
  ctx.fillStyle = '#3a7d3f';
  ctx.fillRect(0, 0, 256, 512);
  ctx.fillStyle = 'rgba(45,100,50,0.5)';
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * 256, y = Math.random() * 512;
    if (x > 40 && x < 216) continue; // keep the path itself clean
    ctx.fillRect(x, y, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  // Path: subtle asphalt-grain variation instead of one flat gray.
  ctx.fillStyle = '#5a5f6b';
  ctx.fillRect(48, 0, 160, 512);
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  for (let i = 0; i < 140; i++) {
    ctx.fillRect(48 + Math.random() * 160, Math.random() * 512, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  // Worn shoulder edge where grass meets path.
  ctx.strokeStyle = 'rgba(60,90,55,0.6)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(48, 0); ctx.lineTo(48, 512); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(208, 0); ctx.lineTo(208, 512); ctx.stroke();
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
// `cap` (2026-09-02 "improve the character" pass) optionally adds a small
// sphere at the free end of the limb — a hand on an arm, a shoe on a leg —
// so the rig doesn't just end in a bare rectangular stump. One extra cheap
// primitive per limb; negligible triangle count next to the win in
// readability.
function limb(w, h, d, color, pivotYOffset, cap) {
  const pivot = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color })
  );
  mesh.position.y = -h / 2;
  pivot.add(mesh);
  if (cap) {
    const capMesh = new THREE.Mesh(
      new THREE.SphereGeometry(cap.radius, 8, 8),
      new THREE.MeshLambertMaterial({ color: cap.color })
    );
    capMesh.position.y = -h - cap.radius * 0.3;
    pivot.add(capMesh);
  }
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

// A couple of tiny extra primitives (2026-09-02 "improve the character"
// pass) — cheap (two small spheres) but they're the single biggest reason
// the character used to read as a faceless blank capsule-and-ball rig.
const eyeGeo = new THREE.SphereGeometry(0.045, 8, 8);
const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
eyeL.position.set(-0.12, 0.03, 0.29);
const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
eyeR.position.set(0.12, 0.03, 0.29);
head.add(eyeL, eyeR);

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

const armL = limb(0.18, 0.62, 0.18, 0xff5a5f, 1.52, { radius: 0.1, color: 0xffd7b0 });
armL.position.x = -0.52;
player.add(armL);
const armR = limb(0.18, 0.62, 0.18, 0xff5a5f, 1.52, { radius: 0.1, color: 0xffd7b0 });
armR.position.x = 0.52;
player.add(armR);

const legL = limb(0.22, 0.62, 0.22, 0x2b2f45, 0.78, { radius: 0.13, color: 0x1c1f2e });
legL.position.x = -0.2;
player.add(legL);
const legR = limb(0.22, 0.62, 0.22, 0x2b2f45, 0.78, { radius: 0.13, color: 0x1c1f2e });
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
// A little per-instance hue jitter (2026-09-02 "improve the locations"
// pass) so a whole tree-line of identical cones doesn't read as obviously
// copy-pasted — cheap (one extra color lerp per instance, done once at
// spawn, not per frame).
function jitterColor(hex, amount) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(
    (hsl.h + (Math.random() - 0.5) * amount + 1) % 1,
    Math.max(0, Math.min(1, hsl.s + (Math.random() - 0.5) * amount)),
    Math.max(0, Math.min(1, hsl.l + (Math.random() - 0.5) * amount))
  );
  return c;
}
function makeTree() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.4, 6), new THREE.MeshLambertMaterial({ color: 0x7a5230 }));
  trunk.position.y = 0.7;
  const scale = 0.85 + Math.random() * 0.4;
  const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.0 * scale, 2.0 * scale, 8), new THREE.MeshLambertMaterial({ color: jitterColor(0x2e7d4f, 0.12) }));
  leaves.position.y = 0.7 + 1.4 * scale;
  g.add(trunk, leaves);
  return g;
}
function makeBush() {
  const g = new THREE.Group();
  const n = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    const r = 0.32 + Math.random() * 0.16;
    const blob = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), new THREE.MeshLambertMaterial({ color: jitterColor(0x3f9152, 0.1) }));
    blob.position.set((Math.random() - 0.5) * 0.4, r * 0.7, (Math.random() - 0.5) * 0.3);
    g.add(blob);
  }
  return g;
}
function makeRock() {
  const r = 0.22 + Math.random() * 0.22;
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), new THREE.MeshLambertMaterial({ color: jitterColor(0x8a8f99, 0.06) }));
  rock.position.y = r * 0.5;
  rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
  return rock;
}
const SCENERY_MAKERS = [makeTree, makeTree, makeTree, makeBush, makeRock];
for (let i = 0; i < 26; i++) {
  const make = SCENERY_MAKERS[Math.floor(Math.random() * SCENERY_MAKERS.length)];
  const t = make();
  const side = i % 2 === 0 ? -1 : 1;
  t.position.set(side * (5.5 + Math.random() * 3.5), 0, -i * 7.5 - Math.random() * 6);
  scene.add(t);
  sceneryPool.push(t);
}

// ---------------------------------------------------------------------
// Obstacles
// ---------------------------------------------------------------------
const obstacles = [];
const impactBursts = []; // small comedic particle bursts spawned by launchObstacleFlying()

// Obstacle surface textures (2026-09-02 "improve the objects" pass) — each
// baked once at startup on a small canvas and reused across every spawned
// instance of that type, exactly like makeRoadTexture()/makeSkyTexture()
// above: this swaps a flat MeshLambertMaterial color for a textured one,
// which costs the same at render time (same triangle count, same shader),
// just with a more interesting surface instead of a single flat tone.
function makeCrateTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#a5682a';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(70,40,10,0.55)';
  ctx.lineWidth = 3;
  for (let x = 0; x <= 128; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 128); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(255,220,160,0.25)';
  ctx.lineWidth = 1;
  for (let x = 4; x <= 128; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 128); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(70,40,10,0.6)';
  ctx.lineWidth = 5;
  ctx.strokeRect(3, 3, 122, 122);
  ctx.beginPath(); ctx.moveTo(3, 3); ctx.lineTo(125, 125); ctx.moveTo(125, 3); ctx.lineTo(3, 125); ctx.stroke();
  return new THREE.CanvasTexture(c);
}
function makeHazardTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffb703';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#241a00';
  ctx.save();
  ctx.translate(32, 32); ctx.rotate(Math.PI / 4); ctx.translate(-32, -32);
  for (let x = -64; x < 128; x += 24) ctx.fillRect(x, 0, 12, 64);
  ctx.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
function makeBrickTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#6c7a89';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(40,48,56,0.6)';
  ctx.lineWidth = 3;
  const rowH = 21;
  for (let row = 0, y = 0; y <= 128; y += rowH, row++) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke();
    const offset = row % 2 === 0 ? 0 : 21;
    for (let x = offset; x <= 128; x += 42) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + rowH); ctx.stroke(); }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.5, 2);
  return tex;
}
const crateTexture = makeCrateTexture();
const hazardTexture = makeHazardTexture();
const brickTexture = makeBrickTexture();

function buildObstacleMesh(type) {
  if (type === 'hurdle') {
    const g = new THREE.Group();
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.18), new THREE.MeshLambertMaterial({ map: hazardTexture }));
    bar.position.y = 0.55;
    const legA = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.55, 0.1), new THREE.MeshLambertMaterial({ color: 0xd98a00 }));
    legA.position.set(-0.65, 0.275, 0);
    const legB = legA.clone(); legB.position.x = 0.65;
    g.add(bar, legA, legB);
    return g;
  }
  if (type === 'crate') {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.1, 1.0), new THREE.MeshLambertMaterial({ map: crateTexture }));
    m.position.y = 0.55;
    return m;
  }
  // wall
  const m = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.6, 0.6), new THREE.MeshLambertMaterial({ map: brickTexture }));
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
  obstacles.push({ type, lane, mesh, resolved: false, flying: false });
  // A hurdle is the one obstacle you clear by going UP, so it's the natural
  // place to hang a gem: the jump you already have to make is what earns it.
  if (type === 'hurdle') spawnGem(lane, SPAWN_Z);
}

// ---------------------------------------------------------------------
// Collectibles — coins (constant, run-through) and gems (high, jump-only).
// Shared geometry/materials: every coin in a run is the same disc and every
// gem the same octahedron, so this adds a lot of on-screen reward for very
// little GPU cost (see the rendering-cost note in the renderer setup).
// ---------------------------------------------------------------------
const coinGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.07, 16);
const coinMat = new THREE.MeshLambertMaterial({ color: 0xffc53d, emissive: 0x6b4a00 });
const gemGeo = new THREE.OctahedronGeometry(0.42);
const gemMat = new THREE.MeshLambertMaterial({ color: 0x6ee7ff, emissive: 0x0a5f75 });
const pickups = [];
// Only ever flipped by the test hook at the bottom of this file, so a test
// can place one known coin and watch what happens to it without the normal
// trail spawner dropping more into the scene mid-measurement.
let coinSpawnEnabled = true;

function addPickup(kind, lane, z) {
  const mesh = new THREE.Mesh(kind === 'gem' ? gemGeo : coinGeo, kind === 'gem' ? gemMat : coinMat);
  mesh.position.x = LANE_X[lane];
  mesh.position.y = kind === 'gem' ? GEM_Y : COIN_Y;
  mesh.position.z = z;
  // Coins are discs: stand them upright facing back down the track so the
  // player sees a full circle coming at them, like a ring.
  if (kind !== 'gem') mesh.rotation.x = Math.PI / 2;
  scene.add(mesh);
  pickups.push({ kind, lane, mesh, collected: false });
}

function spawnGem(lane, z) {
  addPickup('gem', lane, z);
}

// True if any unresolved obstacle in `lane` overlaps the z-range a coin
// trail would occupy — so trails don't get buried inside a wall or crate.
function laneBlocked(lane, zStart, zEnd) {
  return obstacles.some((o) =>
    !o.flying && o.lane === lane && o.mesh.position.z >= zStart - 3 && o.mesh.position.z <= zEnd + 3);
}

function spawnCoinRun() {
  const count = COIN_RUN_MIN + Math.floor(Math.random() * (COIN_RUN_MAX - COIN_RUN_MIN + 1));
  const zEnd = SPAWN_Z;
  const zStart = SPAWN_Z - (count - 1) * COIN_SPACING;
  // Prefer a lane the trail can actually live in; if all three are busy this
  // trail is simply skipped rather than spawned inside something.
  const lanes = [0, 1, 2].sort(() => Math.random() - 0.5);
  const lane = lanes.find((l) => !laneBlocked(l, zStart, zEnd));
  if (lane === undefined) return;
  for (let i = 0; i < count; i++) addPickup('coin', lane, zStart + i * COIN_SPACING);
}

// Coins released by smashing a crate: they pop out of the wreckage and are
// banked immediately, so a good punch still pays — and the points still
// come from coins rather than from a bare score bonus.
function releaseCoins(position, count) {
  addScore(count * COIN_VALUE);
  popCombo(`+${count * COIN_VALUE}`);
  const group = new THREE.Group();
  const particles = [];
  // These ride the impact-burst updater, which fades particles by writing
  // `material.opacity` — so they need their OWN material. Handing them the
  // shared coinMat would fade every uncollected coin on the track with them.
  const burstMat = new THREE.MeshLambertMaterial({ color: 0xffc53d, emissive: 0x6b4a00, transparent: true });
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(coinGeo, burstMat);
    mesh.position.copy(position);
    mesh.rotation.x = Math.PI / 2;
    const angle = (i / count) * Math.PI * 2;
    particles.push({ mesh, vel: { x: Math.cos(angle) * 3, y: 6 + Math.random() * 3, z: Math.sin(angle) * 3 } });
    group.add(mesh);
  }
  scene.add(group);
  impactBursts.push({ group, particles, age: 0 });
}

function addScore(points) {
  state.score += points;
  scoreVal.textContent = String(Math.floor(state.score));
  if (state.score > highScore) {
    highScore = state.score;
    highScoreVal.textContent = String(Math.floor(highScore));
  }
}

// Sends a successfully-punched obstacle rocketing off with its own little
// projectile arc (random sideways scatter + a big upward pop + gravity +
// tumbling spin) instead of just continuing to scroll past like normal —
// the visual payoff of a successful punch. `speed` is folded into the
// launch so it still looks like it's being knocked further down the track,
// not just straight up.
function launchObstacleFlying(o, speed) {
  o.flying = true;
  o.flyVel = {
    x: (Math.random() * 2 - 1) * PUNCH_LAUNCH_VX_SPREAD,
    y: PUNCH_LAUNCH_VY,
    z: speed + PUNCH_LAUNCH_VZ_BOOST,
  };
  o.spin = {
    x: (Math.random() * 2 - 1) * 12,
    y: (Math.random() * 2 - 1) * 12,
    z: (Math.random() * 2 - 1) * 12,
  };
  spawnImpactBurst(o.mesh.position);
}

// A small comic-book "POW" burst of little cubes at the point of impact —
// pure juice, no gameplay effect. Self-contained: each burst tracks its
// own particles and removes itself from the scene once they've faded.
const IMPACT_COLORS = [0xffd166, 0xff5a5f, 0x6ee7ff, 0xffffff];
const IMPACT_PARTICLE_COUNT = 16; // was 10 — bigger, busier "POW" for the exaggerated-punch upgrade
function spawnImpactBurst(position) {
  const group = new THREE.Group();
  const particles = [];
  for (let i = 0; i < IMPACT_PARTICLE_COUNT; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: IMPACT_COLORS[i % IMPACT_COLORS.length], transparent: true });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), mat);
    mesh.position.copy(position);
    const angle = (i / IMPACT_PARTICLE_COUNT) * Math.PI * 2 + Math.random() * 0.4;
    const speedXZ = 4 + Math.random() * 3.5;
    particles.push({
      mesh,
      vel: { x: Math.cos(angle) * speedXZ, y: 3.5 + Math.random() * 4.5, z: Math.sin(angle) * speedXZ },
    });
    group.add(mesh);
  }
  scene.add(group);
  impactBursts.push({ group, particles, age: 0 });
}
const IMPACT_BURST_LIFETIME = 0.6; // seconds — was 0.5

// Shows a pulsing "JUMP!"/"PUNCH!"/"MOVE!" cue shortly before the nearest
// unresolved, non-flying obstacle in the player's CURRENT lane would reach
// the collision zone — a timing cue so the player can learn the rhythm
// instead of just reacting. Recomputed fresh every frame from live state
// (not a one-shot flag), so it naturally updates if the player changes
// lanes and a different obstacle becomes the relevant one, and it hides
// itself the instant nothing in-lane is within the warning window.
function updateActionPrompt(speed) {
  let target = null;
  let bestZ = -Infinity;
  for (const o of obstacles) {
    if (o.flying || o.resolved) continue;
    if (o.lane !== state.lane) continue;
    if (o.mesh.position.z >= COLLISION_Z_MIN) continue;
    // Obstacles travel toward +z, so the largest z among candidates is the
    // one closest to the player right now.
    if (o.mesh.position.z > bestZ) { bestZ = o.mesh.position.z; target = o; }
  }
  if (!target || speed <= 0) { actionPromptEl.style.display = 'none'; return; }
  const timeToImpact = (COLLISION_Z_MIN - bestZ) / speed;
  if (timeToImpact > PROMPT_LEAD_TIME || timeToImpact < 0) { actionPromptEl.style.display = 'none'; return; }
  const meta = ACTION_PROMPT_META[target.type] || ACTION_PROMPT_META.hurdle;
  actionPromptEl.textContent = `${meta.icon} ${meta.text}`;
  actionPromptEl.style.display = 'block';
}
function hideActionPrompt() {
  actionPromptEl.style.display = 'none';
}

function updateImpactBursts(dt) {
  for (let i = impactBursts.length - 1; i >= 0; i--) {
    const burst = impactBursts[i];
    burst.age += dt;
    const fade = Math.max(0, 1 - burst.age / IMPACT_BURST_LIFETIME);
    burst.particles.forEach((p) => {
      p.vel.y += OBSTACLE_GRAVITY * dt;
      p.mesh.position.x += p.vel.x * dt;
      p.mesh.position.y += p.vel.y * dt;
      p.mesh.position.z += p.vel.z * dt;
      p.mesh.material.opacity = fade;
      p.mesh.scale.setScalar(Math.max(0.05, fade));
    });
    if (burst.age >= IMPACT_BURST_LIFETIME) {
      scene.remove(burst.group);
      impactBursts.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------
// Exaggerated punch animation — anticipation (windup), a fast forward
// snap with a cartoonish overshoot past full extension, then a settle back
// to neutral. Driven by state.punchAnimTimer, which is purely cosmetic
// (see its declaration above) — completely separate from the gameplay
// hit-window timer (state.punchTimer / PUNCH_DURATION), so this can be as
// big and floppy as we want without touching game balance.
// ---------------------------------------------------------------------
function easeOutBack(x) {
  // c1 raised from the textbook 1.70158 to exaggerate the overshoot — a
  // bigger cartoonish "snap past the target and settle back" for the punch.
  const c1 = 2.4;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
function punchArmRotation(elapsedFrac) {
  if (elapsedFrac < PUNCH_WINDUP_FRAC) {
    const w = elapsedFrac / PUNCH_WINDUP_FRAC;
    return PUNCH_WINDUP_PULL * Math.sin(w * Math.PI / 2);
  }
  const snapEnd = PUNCH_WINDUP_FRAC + PUNCH_SNAP_FRAC;
  if (elapsedFrac < snapEnd) {
    const s = (elapsedFrac - PUNCH_WINDUP_FRAC) / PUNCH_SNAP_FRAC;
    const eased = easeOutBack(s); // overshoots past 1.0 then eases back toward it — the cartoonish "snap"
    return PUNCH_WINDUP_PULL + eased * (PUNCH_MAX_EXTEND - PUNCH_WINDUP_PULL);
  }
  const r = (elapsedFrac - snapEnd) / (1 - snapEnd);
  const eased = 1 - Math.pow(1 - r, 2);
  return PUNCH_MAX_EXTEND * (1 - eased);
}
// A short triangular "impact" bump centered on the moment of full
// extension — drives the torso squash/stretch and the forward lunge.
function punchImpactBump(elapsedFrac) {
  const peak = PUNCH_WINDUP_FRAC + PUNCH_SNAP_FRAC;
  const width = 0.17; // widened slightly alongside the bigger animation below
  const d = Math.abs(elapsedFrac - peak);
  return d < width ? 1 - d / width : 0;
}

// ---------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------
const state = {
  phase: 'pairing', // pairing -> ready -> countdown -> playing -> gameover
  score: 0,
  lives: 3,
  lane: 1,
  grounded: true,
  vy: 0,
  jumping: false,
  punchTimer: 0,
  punchAnimTimer: 0, // cosmetic-only — see PUNCH_ANIM_DURATION above
  invulnTimer: 0,
  spawnTimer: BASE_SPAWN_INTERVAL,
  coinTimer: 0.8,
  distance: 0,        // metres this run — drives the difficulty ramp
  distanceForTex: 0,
  countdownT: 0,      // seconds left on the pre-run countdown
  gameOverT: 0,       // seconds spent on the Run Over screen (auto-restart)
};

// ---------------------------------------------------------------------
// High score — persisted in this browser's localStorage. There's no
// server-side database in this project (see server.js), and a Fire TV is
// normally one shared device anyway, so "best score seen on this TV" is
// the right scope — no accounts or sync needed. Falls back to an
// in-memory-only high score (never persists) if localStorage throws, e.g.
// a locked-down browser profile.
// ---------------------------------------------------------------------
const HIGH_SCORE_KEY = 'motionrun_highscore';
function loadHighScore() {
  try {
    return Math.max(0, parseInt(localStorage.getItem(HIGH_SCORE_KEY), 10) || 0);
  } catch {
    return 0;
  }
}
function saveHighScore(value) {
  try { localStorage.setItem(HIGH_SCORE_KEY, String(Math.floor(value))); } catch { /* ignore */ }
}
let highScore = loadHighScore();
let highScoreAtRunStart = highScore;

const scoreVal = document.getElementById('scoreVal');
const highScoreVal = document.getElementById('highScoreVal');
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
const actionPromptEl = document.getElementById('actionPrompt');

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
highScoreVal.textContent = String(Math.floor(highScore));

const hudEl = document.getElementById('hud');
const countdownEl = document.getElementById('countdown');
const countdownHintEl = document.getElementById('countdownHint');
const controlBadge = document.getElementById('controlBadge');
const pausedPanel = document.getElementById('pausedPanel');
const pausedScoreVal = document.getElementById('pausedScoreVal');
const newHighScoreNote = document.getElementById('newHighScoreNote');

const PANELS = {
  pairing: pairingPanel,
  ready: readyPanel,
  gameover: gameOverPanel,
  paused: pausedPanel,
  calibrating: calibrationPanel,
  placement: placementPanel,
  framing: framingPanel,
};

// ---------------------------------------------------------------------
// Control badge — a small persistent "what do I use right now?" pill so
// it's obvious at every stage, not just the first one, whether the Fire TV
// remote or the phone is what drives the current screen. Shown for every
// non-playing stage; hidden once a run is actually in progress (input is
// coming from the phone continuously at that point, no ambiguity).
// ---------------------------------------------------------------------
const CONTROL_BADGE_TEXT = {
  pairing: { text: '📱 Use your phone to join', cls: 'phone' },
  ready: { text: '🎮 Remote OK, or 📱 jump/punch, to start', cls: 'remote' },
  placement: { text: '🎮 Use your Fire TV remote', cls: 'remote' },
  framing: { text: '🎮 Use your Fire TV remote', cls: 'remote' },
  calibrating: { text: '📱 Copy the moves · 🎮 OK to start', cls: 'phone' },
  paused: { text: '🎮 Remote OK to resume, Back to exit', cls: 'remote' },
  gameover: { text: '🎮 Remote OK, or 📱 jump/punch, to retry', cls: 'remote' },
};
function updateControlBadge(stageKey) {
  const meta = CONTROL_BADGE_TEXT[stageKey];
  // The badge is a fixed pill near the top of the screen and the panels are
  // vertically centred, so on a tall panel (the calibration one especially)
  // the two used to collide — the pill sat right on top of the panel's
  // heading. Panels get nudged down while a badge is showing; see
  // `body.badge-visible .overlay-panel` in index.html.
  document.body.classList.toggle('badge-visible', !!meta);
  if (!meta) { controlBadge.style.display = 'none'; return; }
  controlBadge.textContent = meta.text;
  controlBadge.className = `control-badge ${meta.cls}`;
  controlBadge.style.display = 'block';
}
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
  // Score/lives belong to a run in progress. Leaving them up during
  // pairing/setup showed a stale score from the *previous* run next to a
  // "Step 1 of 4" setup prompt, which reads like the game is already going.
  const inRun = state.phase === 'playing' || state.phase === 'paused' || state.phase === 'countdown';
  hudEl.style.display = inRun ? 'flex' : 'none';
  // The countdown owns the screen on its own — no panel, no badge.
  if (state.phase === 'countdown') { showPanel(null); updateControlBadge(null); return; }
  if (setupStage === 'placement') { showPanel('placement'); updateControlBadge('placement'); return; }
  if (setupStage === 'framing') { showPanel('framing'); updateControlBadge('framing'); return; }
  if (calibrating) { showPanel('calibrating'); updateControlBadge('calibrating'); return; }
  if (state.phase === 'pairing') { showPanel('pairing'); updateControlBadge('pairing'); }
  else if (state.phase === 'ready') { showPanel('ready'); updateControlBadge('ready'); }
  else if (state.phase === 'paused') { showPanel('paused'); updateControlBadge('paused'); }
  else if (state.phase === 'gameover') { showPanel('gameover'); updateControlBadge('gameover'); }
  else { showPanel(null); updateControlBadge(null); }
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

function sendCalibrationControl(action, extra) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'calibration_control', action, ...extra }));
  }
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
// Counts down once the last calibration move is done, then finishes setup
// on its own — see advanceCalibrationUI()/finishSetupFromTv().
let calAutoFinishT = 0;
const CAL_AUTO_FINISH_DELAY = 1.6; // seconds of "All set!" before starting
let calMode = 'camera';
let calIndex = 0;
let calDone = { left: false, right: false, jump: false, punch: false };

function renderCalDots() {
  calDots.textContent = CAL_ORDER.map((key, i) => (calDone[key] ? '✅' : i === calIndex ? '🔵' : '⚪')).join(' ');
}
// 2026-09-03 fix ("the 4-stage setup never asks for a punch"): the phone
// runs ALL four detectors continuously during calibration, so before this
// change any stray motion or pose false-positive could silently tick off a
// move the walkthrough hadn't reached yet — most often `punch`, since a
// hard lateral motion is the easiest one to trigger by accident while the
// player is stepping left/right. advanceCalibrationUI() then skipped every
// already-done step, so the PUNCH prompt was checked off in the background
// and never actually displayed. The walkthrough now drives the phone
// instead of merely reacting to it: every time the shown step changes, the
// TV tells the phone which single move it is currently asking for, and the
// phone ignores everything else (see expectedCalStep in controller.js).
function requestCalStepOnPhone() {
  sendCalibrationControl('step_request', {
    step: calIndex < CAL_ORDER.length ? CAL_ORDER[calIndex] : null,
    index: calIndex,
    total: CAL_ORDER.length,
    mode: calMode,
  });
}
function showCalibrationStep() {
  if (calIndex >= CAL_ORDER.length) {
    calMoveIcon.textContent = '🎉';
    calMoveText.textContent = 'All set!';
    calStepCounter.textContent = 'Nice work!';
    renderCalDots();
    requestCalStepOnPhone();
    return;
  }
  const meta = CAL_META[CAL_ORDER[calIndex]];
  calMoveIcon.textContent = meta.icon;
  calMoveText.textContent = calMode === 'hold' ? meta.textHold : meta.textCamera;
  calStepCounter.textContent = `Step ${calIndex + 1} of ${CAL_ORDER.length}`;
  renderCalDots();
  requestCalStepOnPhone();
}
function startCalibrationUI(mode) {
  calibrating = true;
  calAutoFinishT = 0;
  setupStage = 'none'; // placement/framing are done — the per-move panel takes over
  calMode = mode || 'camera';
  calIndex = 0;
  calDone = { left: false, right: false, jump: false, punch: false };
  showCalibrationStep();
  syncPanel();
}
function advanceCalibrationUI(step) {
  if (!calibrating || !(step in calDone) || calDone[step]) return;
  // Strictly in order now. The phone is told which move we're asking for
  // and only reports that one, so anything else arriving here is either a
  // stale in-flight message or an out-of-date phone — either way, ignoring
  // it is what guarantees every step (punch included) is actually shown and
  // actually performed rather than being ticked off in the background.
  if (calIndex >= CAL_ORDER.length || step !== CAL_ORDER[calIndex]) return;
  calDone[step] = true;
  calIndex++;
  showCalibrationStep();
  if (calIndex >= CAL_ORDER.length) {
    // 2026-09-03: all four moves done means nothing further is needed from
    // the player, so setup finishes itself after a beat (long enough for
    // "All set!" to register) and the run counts in. This used to sit there
    // waiting for a "Start Run" tap on the phone — the press that shouldn't
    // have to be made. Pressing OK on the remote skips the beat.
    calAutoFinishT = CAL_AUTO_FINISH_DELAY;
  }
}

// Ends per-move setup from the TV side and rolls straight into the
// countdown. Tells the phone first so it leaves its calibration screen and
// switches its detectors back to real gameplay input.
function finishSetupFromTv() {
  if (!calibrating) return;
  calAutoFinishT = 0;
  sendCalibrationControl('finish');
  finishCalibrationUI();
}
function finishCalibrationUI() {
  calibrating = false;
  calAutoFinishT = 0;
  setupStage = 'none'; // covers the "Skip setup" escape hatch firing mid-placement/framing
  // 2026-09-03 ("you still need to press start on the phone"): finishing
  // setup IS the start signal. Nothing further is required from the player
  // — the countdown gives them time to put the phone down and get set.
  if (state.phase === 'ready' || state.phase === 'pairing') {
    startCountdown();
    return;
  }
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
  state.punchAnimTimer = 0;
  state.invulnTimer = 0;
  state.spawnTimer = BASE_SPAWN_INTERVAL;
  state.coinTimer = 0.8;
  state.distance = 0;
  obstacles.splice(0).forEach((o) => scene.remove(o.mesh));
  pickups.splice(0).forEach((p) => scene.remove(p.mesh));
  impactBursts.splice(0).forEach((b) => scene.remove(b.group));
  player.position.set(0, 0, 0);
  player.rotation.y = 0;
  torso.scale.set(1, 1, 1);
  renderLives();
  scoreVal.textContent = '0';
  hideActionPrompt();
}

// 2026-09-03: runs now begin with a countdown rather than the instant a
// start input arrives. Two reasons: the player has just put the phone down
// and needs a moment to get back into position, and the game now starts
// itself (see startCountdown()'s callers) rather than waiting to be told,
// so there has to be *some* warning before the track starts moving.
function startCountdown() {
  if (state.phase === 'countdown' || state.phase === 'playing') return;
  resetRun();
  state.phase = 'countdown';
  state.countdownT = COUNTDOWN_SECONDS;
  calibrating = false;
  setupStage = 'none';
  highScoreAtRunStart = highScore;
  syncPanel();
  renderCountdown();
}

function renderCountdown() {
  const whole = Math.ceil(state.countdownT);
  const go = whole <= 1;
  countdownEl.textContent = go ? 'GO!' : String(whole - 1);
  countdownEl.style.display = 'block';
  countdownHintEl.style.display = go ? 'none' : 'block';
  // Restart the pop animation on each new number.
  countdownEl.classList.remove('tick');
  void countdownEl.offsetWidth;
  countdownEl.classList.add('tick');
}

function hideCountdown() {
  countdownEl.style.display = 'none';
  countdownHintEl.style.display = 'none';
}

function startPlaying() {
  // resetRun() already happened in startCountdown(); don't wipe the scene
  // again here or the countdown's settled state would be thrown away.
  if (state.phase !== 'countdown') {
    resetRun();
    highScoreAtRunStart = highScore;
  }
  state.phase = 'playing';
  calibrating = false;
  hideCountdown();
  lastT = performance.now(); // the countdown didn't advance the world; don't hand it a big dt
  showPanel(null);
  updateControlBadge(null);
}

function gameOver() {
  state.phase = 'gameover';
  state.gameOverT = 0;
  finalScoreEl.textContent = Math.floor(state.score);
  commitHighScore();
  newHighScoreNote.style.display = state.score > highScoreAtRunStart ? 'block' : 'none';
  hideActionPrompt();
  hideCountdown();
  syncPanel();
}

// ---------------------------------------------------------------------
// Pause / Exit — driven by the Fire TV remote's Back button (untested on
// real hardware, same open question as the OK button — see the isSelectPress
// comment below) and, always reliably, by the ⏸/✕ buttons on the phone
// (see pauseBtn/exitBtn in play/controller.js). Pausing just stops
// updatePlaying() from running (see animate() — it only calls updatePlaying
// when state.phase === 'playing'), so the whole game genuinely freezes: no
// separate "pause the physics" bookkeeping needed. Exiting is a soft
// game-over — it banks the high score if this run earned one, then drops
// back to the "ready" screen so the next run can start right away without
// re-pairing.
// ---------------------------------------------------------------------
function commitHighScore() {
  // updatePlaying() already live-updates the in-memory `highScore` the
  // instant state.score passes it (for the HUD to react immediately), so
  // by the time this runs `highScore` already reflects this run's best —
  // this just persists that current value at a natural checkpoint
  // (gameOver/exitToMenu) rather than writing to localStorage every frame.
  saveHighScore(highScore);
  highScoreVal.textContent = String(Math.floor(highScore));
}

function pauseGame() {
  if (state.phase !== 'playing') return;
  state.phase = 'paused';
  pausedScoreVal.textContent = String(Math.floor(state.score));
  hideActionPrompt();
  syncPanel();
}

function resumeGame() {
  if (state.phase !== 'paused') return;
  state.phase = 'playing';
  lastT = performance.now(); // avoid a huge dt jump on the first frame back
  showPanel(null);
  updateControlBadge(null);
}

function exitToMenu() {
  if (state.phase !== 'playing' && state.phase !== 'paused' && state.phase !== 'countdown') return;
  commitHighScore();
  hideCountdown();
  state.phase = 'ready';
  calibrating = false;
  setupStage = 'none';
  hideActionPrompt();
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
  // Pause/Exit can arrive while playing OR already paused (toggling back
  // and forth), so handle them before the general "must be playing" guard
  // below — everything else (lane/jump/punch) only makes sense mid-run.
  if (msg.action === 'pause_toggle') {
    if (state.phase === 'playing') pauseGame();
    else if (state.phase === 'paused') resumeGame();
    return;
  }
  if (msg.action === 'exit_to_menu') {
    exitToMenu();
    return;
  }

  // Starting/retrying a run requires an *explicit* jump/punch — a deliberate
  // tap of the phone's on-screen button (see sendInput()/fireJump()/
  // firePunch() in play/controller.js) — not a raw gesture detection, so a
  // noisy false-positive punch/jump reading can't accidentally kick off a
  // new run on its own. The Fire TV remote's OK button (see the keydown
  // handler further down) is the other, equally deliberate way in — those
  // two are meant to be the primary/reliable paths; gesture detection only
  // drives real in-run jump/punch, never phase transitions.
  // These now start the COUNTDOWN rather than the run itself — a deliberate
  // start still works, it just skips ahead to "3, 2, 1, GO!" instead of
  // dropping the player straight into a moving track. On the game-over
  // screen it also short-circuits the automatic restart timer.
  if ((state.phase === 'ready' || state.phase === 'gameover')
      && (msg.action === 'jump' || msg.action === 'punch') && msg.explicit) {
    startCountdown();
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
    // Ignore a new punch while the last one's big cosmetic animation is
    // still playing. Without this, a burst of punch messages (e.g. an
    // over-sensitive gesture reading) restarted the animation every time
    // one arrived, which looked like the punch was "going off continuously"
    // and also meant it never got to play out its full exaggerated
    // windup/snap. This lets every punch that does register finish its
    // full animation before the next one can begin — a natural rate limit
    // on top of the phone-side cooldown/threshold tightening.
    if (state.punchAnimTimer > 0) return;
    state.punchTimer = PUNCH_DURATION;
    state.punchAnimTimer = PUNCH_ANIM_DURATION;
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
// The Fire TV remote's Back button — like the OK button above, we haven't
// been able to confirm exactly what key event this reaches the page as on
// real hardware, so we accept the two most likely candidates (Escape is
// the standard web convention; Backspace is common on some remote/browser
// combinations). The phone's ✕ Exit button (see play/controller.js) is the
// guaranteed fallback if neither matches your specific Fire TV.
function isBackPress(e) {
  return e.key === 'Escape' || e.code === 'Escape' || e.code === 'Backspace';
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

  // Pause (Back while playing) / Exit (Back again while paused) / Resume
  // (OK while paused) — remote-first, with the phone's ⏸/✕ buttons as the
  // always-reliable equivalent (see handleInput's pause_toggle/exit_to_menu).
  if (isBackPress(e)) {
    if (state.phase === 'playing') { pauseGame(); return; }
    if (state.phase === 'paused') { exitToMenu(); return; }
  }
  if (state.phase === 'paused' && isSelectPress(e)) { resumeGame(); return; }

  // 2026-09-03: OK during per-move setup ends setup and starts the run.
  // The moves themselves are body/phone-driven, but STARTING is the
  // remote's job — the player shouldn't have to walk back to the phone and
  // tap "Start Run" to get going, which is what this used to require.
  if (calibrating && isSelectPress(e)) { finishSetupFromTv(); return; }

  // OK/Select (or Space/F as a keyboard fallback) also starts/retries a run
  // from the Ready or Game Over screens — the remote works here too, not
  // just jump/punch from the phone.
  if (!calibrating && state.phase !== 'playing' && state.phase !== 'paused' && (isSelectPress(e) || e.code === 'KeyF')) {
    if (state.phase === 'ready' || state.phase === 'gameover') startCountdown();
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
  return Math.min(MAX_SPEED, BASE_SPEED + state.distance * SPEED_RAMP);
}

function updatePlaying(dt) {
  const speed = currentSpeed();
  // Distance drives the difficulty ramp. Score does NOT accumulate here any
  // more (2026-09-03): points come only from collecting coins and gems, via
  // addScore() — see the collectibles section above.
  state.distance += speed * dt;

  // Ground scroll
  state.distanceForTex += speed * dt;
  roadTexture.offset.y = (state.distanceForTex / 8) % 1;

  // Scenery scroll (recycle)
  sceneryPool.forEach((t) => {
    t.position.z += speed * dt;
    if (t.position.z > 10) t.position.z -= 16 * sceneryPool.length * 0.5;
  });

  // Player lane lerp + lean. The multiplier here (was 9, then 15) is how
  // snappily the character visually catches up to the lane the player's
  // body/tilt just moved into — raised again 2026-09-02 ("reduce the delay
  // between player movement and character movement" feedback) for an even
  // quicker response, since the input itself (WebSocket message ->
  // lane_set) is already effectively instant and this easing remains the
  // biggest source of felt latency between a real move and the on-screen
  // reaction. At dt*24 the character reaches ~92% of the way to the new
  // lane within about 5 frames (~80ms at 60fps), versus needing roughly
  // twice that many frames at the old dt*15.
  // The lean-rotation lerp is sped up to match (dt*10 -> dt*16) so the
  // torso bank doesn't visibly lag behind the now-snappier lane movement.
  const targetX = LANE_X[state.lane];
  const dx = targetX - player.position.x;
  player.position.x += dx * Math.min(1, dt * 24);
  player.rotation.z = THREE.MathUtils.lerp(player.rotation.z, THREE.MathUtils.clamp(-dx * 0.35, -0.35, 0.35), dt * 16);

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

  // Punch timers — punchTimer gates gameplay (crate-safety window),
  // punchAnimTimer drives the exaggerated cosmetic animation below; see
  // the big comment above punchArmRotation() for why they're separate.
  if (state.punchTimer > 0) state.punchTimer = Math.max(0, state.punchTimer - dt);
  if (state.punchAnimTimer > 0) state.punchAnimTimer = Math.max(0, state.punchAnimTimer - dt);
  if (state.invulnTimer > 0) state.invulnTimer = Math.max(0, state.invulnTimer - dt);

  // Procedural animation
  const runT = state.distanceForTex * 1.6;
  const swing = state.grounded ? Math.sin(runT) * 0.6 : 0;
  legL.rotation.x = state.grounded ? swing : -0.5;
  legR.rotation.x = state.grounded ? -swing : 0.3;
  head.position.y = 1.85 + (state.grounded ? Math.abs(Math.sin(runT)) * 0.03 : 0.05);
  if (propellerBlade) propellerBlade.rotation.y += dt * 14;

  // Tracks this frame's impact-bump strength (0 outside a punch) so the
  // camera-kick code after the follow-cam update below can react to it too.
  let punchBump = 0;

  if (state.punchAnimTimer > 0) {
    // Big, floppy, cartoonish: anticipation windup -> fast snap forward
    // with overshoot -> settle. Both arms sell it (off-arm swings back for
    // counterbalance), plus a bigger torso twist, a squash/stretch "oomph"
    // at the moment of impact, and a forward lunge — all purely cosmetic.
    // Sized up 2026-09-02 ("not exaggerated enough" feedback): bigger
    // multipliers across the board plus a camera kick, on top of the
    // bigger windup/reach/overshoot constants above.
    const elapsedFrac = 1 - state.punchAnimTimer / PUNCH_ANIM_DURATION;
    const armAngle = punchArmRotation(elapsedFrac);
    const bump = punchImpactBump(elapsedFrac);
    punchBump = bump;
    armR.rotation.x = -armAngle;
    armL.rotation.x = armAngle * 0.65;
    player.rotation.y = -armAngle * 0.22;
    player.position.z = -bump * 0.6;
    torso.scale.set(1 + bump * 0.34, 1 - bump * 0.24, 1 + bump * 0.34);
  } else {
    armR.rotation.x = state.grounded ? swing * 0.8 : -0.4;
    armL.rotation.x = state.grounded ? -swing * 0.8 : -0.4;
    player.rotation.y = THREE.MathUtils.lerp(player.rotation.y, 0, Math.min(1, dt * 10));
    player.position.z = THREE.MathUtils.lerp(player.position.z, 0, Math.min(1, dt * 10));
    torso.scale.set(
      THREE.MathUtils.lerp(torso.scale.x, 1, Math.min(1, dt * 10)),
      THREE.MathUtils.lerp(torso.scale.y, 1, Math.min(1, dt * 10)),
      THREE.MathUtils.lerp(torso.scale.z, 1, Math.min(1, dt * 10))
    );
  }

  updateImpactBursts(dt);
  updateActionPrompt(speed);

  // Camera follow — sped up alongside the lane-lerp above (dt*4 -> dt*7)
  // so the whole scene re-centers on the player quickly too; otherwise the
  // character itself would snap to its new lane fast while the camera lags
  // behind, which still reads as a delayed reaction overall.
  camera.position.x += (player.position.x * 0.6 - (camera.position.x - 0)) * Math.min(1, dt * 7);
  // A small extra "kick" at the moment of punch impact — quick camera pop
  // toward the player for a bit more comic-book oomph, purely cosmetic.
  camera.position.y = CAMERA_BASE_Y + punchBump * 0.18;
  camera.lookAt(player.position.x * 0.4, 1.3, -8);

  // Spawn obstacles
  state.spawnTimer -= dt;
  if (state.spawnTimer <= 0) {
    spawnObstacle();
    const interval = Math.max(MIN_SPAWN_INTERVAL, BASE_SPAWN_INTERVAL - state.distance * SPAWN_RAMP);
    state.spawnTimer = interval * (0.8 + Math.random() * 0.4);
  }

  // Spawn coin trails on their own cadence, so there's a near-constant
  // stream of them to run through between obstacles.
  state.coinTimer -= dt;
  if (state.coinTimer <= 0) {
    if (coinSpawnEnabled) spawnCoinRun();
    state.coinTimer = BASE_COIN_INTERVAL * (0.75 + Math.random() * 0.5);
  }

  // Update collectibles
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.mesh.position.z += speed * dt;
    // A little spin so they read as collectible rather than scenery.
    if (p.kind === 'gem') {
      p.mesh.rotation.y += dt * 2.6;
      p.mesh.position.y = GEM_Y + Math.sin(state.distanceForTex * 0.9 + p.mesh.position.x) * 0.12;
    } else {
      p.mesh.rotation.y += dt * 3.4;
    }

    if (!p.collected && p.lane === state.lane && Math.abs(p.mesh.position.z) <= PICKUP_RADIUS_Z) {
      // A gem hangs high on purpose: you have to actually be off the ground
      // to take it, which is what makes it the reward for jumping a hurdle
      // rather than something you collect by walking underneath.
      const reachable = p.kind === 'gem' ? player.position.y >= GEM_MIN_PLAYER_Y : true;
      if (reachable) {
        p.collected = true;
        addScore(p.kind === 'gem' ? GEM_VALUE : COIN_VALUE);
        if (p.kind === 'gem') popCombo(`GEM +${GEM_VALUE}`);
        scene.remove(p.mesh);
        pickups.splice(i, 1);
        continue;
      }
    }

    if (p.mesh.position.z > DESPAWN_Z) {
      scene.remove(p.mesh);
      pickups.splice(i, 1);
    }
  }

  // Update obstacles
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];

    // Obstacles already knocked flying by a punch (see launchObstacleFlying)
    // run their own little projectile-physics arc instead of the normal
    // conveyor-belt scroll below — skip straight to that and move on.
    if (o.flying) {
      o.flyVel.y += OBSTACLE_GRAVITY * dt;
      o.mesh.position.x += o.flyVel.x * dt;
      o.mesh.position.y += o.flyVel.y * dt;
      o.mesh.position.z += o.flyVel.z * dt;
      o.mesh.rotation.x += o.spin.x * dt;
      o.mesh.rotation.y += o.spin.y * dt;
      o.mesh.rotation.z += o.spin.z * dt;
      if (o.mesh.position.z > FLYING_DESPAWN_Z || o.mesh.position.y < -14) {
        scene.remove(o.mesh);
        obstacles.splice(i, 1);
      }
      continue;
    }

    o.mesh.position.z += speed * dt;

    if (!o.resolved && o.mesh.position.z >= COLLISION_Z_MIN && o.mesh.position.z <= COLLISION_Z_MAX) {
      o.resolved = true;
      if (o.lane === state.lane) {
        let safe = false;
        if (o.type === 'hurdle') safe = !state.grounded;
        else if (o.type === 'crate') safe = state.punchTimer > 0;
        else safe = false; // wall: only lane-dodge saves you

        if (safe) {
          if (o.type === 'crate') {
            // Smashing a crate scatters coins — the reward for a good punch
            // is still points, but they arrive as coins like everything else.
            launchObstacleFlying(o, speed);
            releaseCoins(o.mesh.position, PUNCH_COIN_REWARD);
          } else {
            popCombo('JUMP!');
          }
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

// One-time adaptive downgrade (see the renderer-setup comment above): if
// the device is still averaging under ~45fps over the first couple of
// seconds even at pixelRatio 1 with no antialiasing, drop resolution
// further rather than staying sharp-but-choppy. Runs once, only ever
// downward, and touches nothing gameplay-related — dt/timing in animate()
// below is entirely separate.
let qualityFrameCount = 0;
let qualityFrameTimeSum = 0;
let qualityDowngraded = false;
const QUALITY_SAMPLE_FRAMES = 90;
const QUALITY_FRAME_MS_FLOOR = 1000 / 45;
function maybeDowngradeQuality(rawFrameMs) {
  if (qualityDowngraded || qualityFrameCount >= QUALITY_SAMPLE_FRAMES) return;
  qualityFrameCount++;
  qualityFrameTimeSum += rawFrameMs;
  if (qualityFrameCount < QUALITY_SAMPLE_FRAMES) return;
  qualityDowngraded = true;
  const avgFrameMs = qualityFrameTimeSum / qualityFrameCount;
  if (avgFrameMs > QUALITY_FRAME_MS_FLOOR) {
    renderer.setPixelRatio(0.75);
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const rawFrameMs = now - lastT;
  const dt = Math.min(0.05, rawFrameMs / 1000);
  lastT = now;
  maybeDowngradeQuality(rawFrameMs);

  if (state.phase === 'playing') updatePlaying(dt);

  // Pre-run countdown: the world is already built and sitting still, so the
  // player can see the track and get into position before it starts moving.
  if (state.phase === 'countdown') {
    const before = Math.ceil(state.countdownT);
    state.countdownT -= dt;
    if (state.countdownT <= 0) startPlaying();
    else if (Math.ceil(state.countdownT) !== before) renderCountdown();
  }

  // Auto-restart after a run ends, so a session keeps flowing without
  // anyone having to press anything. Exiting (remote Back / phone ✕) still
  // leaves to the ready screen instead.
  if (state.phase === 'gameover') {
    state.gameOverT += dt;
    if (state.gameOverT >= GAMEOVER_RESTART_DELAY) startCountdown();
  }

  // Setup finishes itself once the last move is done (see
  // advanceCalibrationUI) — no press needed on the phone or the remote.
  if (calibrating && calAutoFinishT > 0) {
    calAutoFinishT -= dt;
    if (calAutoFinishT <= 0) finishSetupFromTv();
  }

  // Auto-advance out of the framing check once "good" framing has held for
  // a moment — the remote OK press (see keydown handler above) can also
  // confirm this early, so whichever happens first wins.
  if (setupStage === 'framing' && framingReady && framingReadySinceT !== null
      && now - framingReadySinceT > FRAMING_AUTO_ADVANCE_MS) {
    confirmMovesStart();
  }

  renderer.render(scene, camera);
}
// A small read-mostly window onto game state for the automated tests.
// Gameplay itself (coin runs, the countdown, the auto-restart) is otherwise
// only observable by watching the screen, which is exactly the kind of thing
// that has slipped through unnoticed on this project before. Nothing here is
// used by the game, and nothing the player can reach calls it.
window.__mrDebug = {
  phase: () => state.phase,
  score: () => Math.floor(state.score),
  distance: () => state.distance,
  lane: () => state.lane,
  lives: () => state.lives,
  pickupCount: (kind) => (kind ? pickups.filter((p) => p.kind === kind).length : pickups.length),
  clearPickups: () => { pickups.splice(0).forEach((p) => scene.remove(p.mesh)); },
  placePickup: (kind, lane, z) => addPickup(kind, lane, z),
  setCoinSpawning: (on) => { coinSpawnEnabled = !!on; },
  jump: () => { if (state.grounded) { state.grounded = false; state.jumping = true; state.vy = JUMP_VELOCITY; } },
  endRun: () => gameOver(),
};

// Paint the initial (pairing) state once before the loop starts. Without
// this, syncPanel() only ever ran in response to a state change, so on a
// fresh page load the pairing badge never appeared and the score/lives HUD
// stayed visible over the pairing panel until the first phone message
// arrived. Deliberately down here, after every `let` it reads (setupStage,
// calibrating, state) has actually been initialised.
syncPanel();
animate();
