// MotionQuest — TV game (Three.js third-person runner)
//
// Player is controlled entirely by messages relayed from the phone
// controller over WebSocket: {type:'input', action:'lane', value:-1|1},
// {type:'input', action:'jump'}, {type:'input', action:'punch'}.

import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { loadModel } from './glb-lite.js';
import * as audio from './audio.js';

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

// ---- Extra lives and the star (2026-09-04) --------------------------
// Both are rare run-through pickups on the coin line, so a child can take
// them without any precision — the difficulty is in them turning up at all,
// not in catching them.
const START_LIVES = 3;
const MAX_LIVES = 5;          // hearts cap out; a heart at full health pays points instead
const FULL_HEALTH_LIFE_VALUE = 150;
const LIFE_SPAWN_MIN = 30;    // seconds between heart spawn attempts
const LIFE_SPAWN_MAX = 48;

const STAR_DURATION = 10;     // seconds of invincible super-speed
const STAR_SPEED_MULT = 1.55;
const STAR_SMASH_COINS = 4;   // coins scattered by each obstacle you plough through
const STAR_SPAWN_MIN = 26;    // seconds between star spawn attempts
const STAR_SPAWN_MAX = 42;
const STAR_FOV_KICK = 1.13;   // camera widens while boosting — cheap, sells the speed

// Countdown before every run (2026-09-03) — the game now starts on its own
// rather than waiting for a Start press, so the player needs a moment to
// put the phone down and get into position first.
const COUNTDOWN_SECONDS = 4;      // 3, 2, 1, GO!
const GAMEOVER_RESTART_DELAY = 4.5; // seconds on the Run Over screen before going again

const JUMP_VELOCITY = 8.2;
const GRAVITY = -22;

// 2026-09-10 ("the prompt comes up too early... make the window more
// generous"). Both halves of that were one problem. Getting a punch to the
// TV takes the player about 0.5-0.8s all in — see the prompt, decide, throw
// the punch, have the phone's pose detector recognise it, relay it — but the
// punch then counted for only 0.34s. So a player who reacted PROMPTLY to a
// cue 0.85s out had their punch expire before the crate arrived, and the
// only way to hit anything was to react late. Punishing people for being
// quick is exactly backwards.
//
// The window is now long enough to cover the whole spread of human reaction
// times, so any punch thrown in response to the cue lands.
const PUNCH_DURATION = 0.9;
const HIT_INVULN_TIME = 1.1;

// Cosmetic-only punch animation timing — deliberately separate from
// PUNCH_DURATION above. PUNCH_DURATION gates real gameplay (how long a
// crate arriving at the collision zone counts as "safely smashed"), so it
// stays exactly as tuned. This timer just drives the exaggerated visual
// windup/snap/settle and can run longer without touching game balance.
// Sized up again 2026-09-02 ("not exaggerated enough" feedback) — bigger
// windup, further reach, and a stronger overshoot snap (see the increased
// easeOutBack() overshoot constant below too).
// Stretched with the gameplay window (2026-09-10) so the animation still
// finishes inside the time the punch actually counts for. Kept just under
// PUNCH_DURATION, never over: the animation is what blocks a re-punch, and
// a player should never be locked out of throwing another one while the
// last is still live.
const PUNCH_ANIM_DURATION = 0.85;
const PUNCH_WINDUP_FRAC = 0.15; // fraction of the animation spent winding up (arm pulls back)
const PUNCH_SNAP_FRAC = 0.3;    // fraction spent snapping forward (with overshoot)
const PUNCH_WINDUP_PULL = 1.15; // radians the arm pulls back before throwing the punch
const PUNCH_MAX_EXTEND = -3.35; // radians of forward extension at full reach (~192°) — past vertical, deliberately absurd

const OBSTACLE_TYPES = ['hurdle', 'crate', 'wall', 'lowbar'];

// ---- Ducking (2026-09-04) -------------------------------------------
// The fourth move, added with the era levels — the key art's "DUCK UNDER
// OBSTACLES". A duck is a timed window rather than a held pose: the phone
// reports a crouch once (see detectDuck() in play/controller.js) and the
// character stays low for DUCK_DURATION. Held poses are miserable over a
// network — a dropped "stood back up" packet would leave the character
// crouching forever — whereas a fixed window always resolves itself.
//
// The window is a touch longer than the punch window because a crouch is a
// slower movement to make than a jab, and the player is reacting to
// something coming at them at speed.
// 0.7s, not the 0.55 first tried: at full speed an obstacle is inside the
// collision zone for under a tenth of a second, so the window is really a
// budget for how far out the player's timing can be. Half a second of slack
// either side is about right for a child reacting to an on-screen cue.
const DUCK_DURATION = 0.7;    // seconds the character stays low (gameplay window)
const DUCK_SCALE_Y = 0.52;    // how far the body compresses at full crouch
const DUCK_IN_FRAC = 0.22;    // fraction of the window spent dropping down
const DUCK_OUT_FRAC = 0.3;    // fraction spent standing back up

// On-screen action prompt (added 2026-09-02, "prompt telling the player
// when to punch/jump so they can time it" feedback) — see
// updateActionPrompt() below for the logic; this is just the per-type copy.
const ACTION_PROMPT_META = {
  hurdle: { icon: '⬆️', text: 'JUMP!' },
  crate: { icon: '👊', text: 'PUNCH!' },
  wall: { icon: '↔️', text: 'MOVE!' },
  lowbar: { icon: '⬇️', text: 'DUCK!' },
};
// Pulled in from 0.85 so the cue means "throw it now" rather than "something
// is coming eventually". With the much longer PUNCH_DURATION above, a player
// who reacts instantly and one who takes a beat both connect.
const PROMPT_LEAD_TIME = 0.65; // seconds of warning before the obstacle reaches the collision zone

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
// 2026-09-04 MotionQuest: parameterised so each era can supply its own sky.
// `stops` is four colours from zenith to horizon; `glow` is the colour of
// the soft light bloom near the horizon (a sun for daylight eras, a neon
// haze for the future city, a volcanic glare for the dinosaur valley).
const DEFAULT_SKY = ['#2f6fd8', '#6fb3ea', '#bfe3f5', '#e9f6ea'];
function makeSkyTexture(stops, glow) {
  const s = stops || DEFAULT_SKY;
  const c = document.createElement('canvas');
  c.width = 2; c.height = 512;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, s[0]);
  grad.addColorStop(0.45, s[1]);
  grad.addColorStop(0.72, s[2]);
  grad.addColorStop(1, s[3]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 512);
  // Soft sun glow near the horizon, off to one side, matching the
  // directional "sun" light's rough position below.
  const glowColor = glow || 'rgba(255,250,225,0.9)';
  const sun = ctx.createRadialGradient(1.4, 300, 0, 1.4, 300, 220);
  sun.addColorStop(0, glowColor);
  sun.addColorStop(1, glowColor.replace(/[\d.]+\)$/, '0)'));
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.background = makeSkyTexture();
// 2026-09-04: pushed way back (was 30->85). Fog starting 30 units out was
// bleaching the colour out of everything past the first few trees, which
// is the opposite of the flat, saturated look this style depends on. It
// still fades the far end enough to hide scenery recycling, just without
// draining the middle distance.
scene.fog = new THREE.Fog(0xcdeaf7, 60, 150);

// Raised from 4.6 (2026-09-10). Together with the flatter hills above, this
// is what buys back the line of sight over a crest to the base of an
// obstacle in the dip beyond — the extra height costs nothing and changes
// the framing barely at all.
const CAMERA_BASE_Y = 5.15;
// How far the camera leans into a corner at the sharpest point of the turn,
// in radians (~4.6 degrees). Deliberately small: the ask was for the camera
// to stay fixed behind the character, so this is a touch of body language on
// the turn, not a camera move. Eased rather than applied directly so it
// doesn't snap on at the corner entry.
const CAMERA_CORNER_ROLL = 0.08;
let cameraRoll = 0;
// How far the horizon landmark swings across the view while a corner is
// being taken. A backdrop nailed dead ahead through a 90-degree turn quietly
// argues that you are not turning at all, which undercuts the whole thing.
// Driven by the RATE of turn rather than by absolute heading, so it swings
// out as the corner is taken and eases back afterwards — a landmark that
// tracked heading outright would end up behind the player and leave the
// horizon empty, which is exactly what these landmarks exist to prevent.
const HORIZON_CORNER_SWING = 0.5;
let horizonSwing = 0;
const BASE_FOV = 62; // restored after the star's camera kick — see endStar()
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 200);
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
// 2026-09-04 rebalance. Two things were wrong for a blocky style:
//   1. The hemisphere fill was at 0.95, which washed every face to roughly
//      the same brightness. A boxy character only reads as three-dimensional
//      if its top, front and side faces are clearly different values, so the
//      fill comes down and the sun goes up.
//   2. The sun sat at +z — in FRONT of the character, i.e. lighting the one
//      side the player never sees. The camera is behind the runner, so it
//      now sits behind and above, lighting the faces actually on screen.
// Named (2026-09-04) so applyEra() can retune all three lights per era —
// the dinosaur valley is lit by a low volcanic sun, the neon city barely at
// all. Lighting does more than palette to make an era feel different.
const hemiLight = new THREE.HemisphereLight(0xd6ecff, 0x6b7a8c, 0.6);
scene.add(hemiLight);
const sun = new THREE.DirectionalLight(0xfff6e2, 1.35);
sun.position.set(-5, 8, -11);
scene.add(sun);
const rimLight = new THREE.DirectionalLight(0x9fc4ff, 0.32);
rimLight.position.set(9, 5, 8);
scene.add(rimLight);

// ---------------------------------------------------------------------
// Ground (scrolling texture, no geometry recycling needed)
// ---------------------------------------------------------------------
// 2026-09-04 MotionQuest: `pal` lets each era repaint the ground without
// changing the banding logic, which is what sells the sense of speed.
//   verge  two alternating tones for the ground either side of the track
//   kerb   the strip separating verge from track
//   path   two alternating tones for the track itself
//   dash   the lane markings (set to null for eras with no road markings)
const DEFAULT_GROUND = {
  verge: ['#6cbe4a', '#63b243'], kerb: '#d8dbe0',
  path: ['#585c6b', '#545867'], dash: '#f2f4f8',
};
function makeRoadTexture(pal) {
  const p = pal || DEFAULT_GROUND;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const ctx = c.getContext('2d');
  // 2026-09-04: flat, saturated, banded — the blocky-world look. The old
  // version scattered noise flecks over the grass and asphalt grain over
  // the path to read as "textured ground". Next to a voxel character that
  // reads as half-finished realism, so it is all flat colour now, with the
  // variation coming from clean alternating bands instead of noise. Bands
  // also do something noise never did: they slide past as you run, which
  // is free extra sense of speed.
  const BAND = 64;
  for (let y = 0; y < 512; y += BAND) {
    ctx.fillStyle = (y / BAND) % 2 === 0 ? p.verge[0] : p.verge[1];
    ctx.fillRect(0, y, 256, BAND);
  }
  // Kerb strip either side of the path.
  ctx.fillStyle = p.kerb;
  ctx.fillRect(42, 0, 6, 512);
  ctx.fillRect(208, 0, 6, 512);
  // Path: one flat tone, banded the same way so it scrolls with the grass.
  for (let y = 0; y < 512; y += BAND) {
    ctx.fillStyle = (y / BAND) % 2 === 0 ? p.path[0] : p.path[1];
    ctx.fillRect(48, y, 160, BAND);
  }
  // Crisp lane dashes. Some eras (paved Rome, the primeval valley) have no
  // painted lane markings, so `dash: null` skips them entirely.
  if (p.dash) {
    ctx.fillStyle = p.dash;
    for (let y = 8; y < 512; y += 56) {
      ctx.fillRect(128 - 56, y, 7, 30);
      ctx.fillRect(128 + 49, y, 7, 30);
    }
  }
  // Optional paving grid — Rome's flagstones and the future city's tile
  // seams both read as "constructed surface" rather than open road.
  if (p.slabs) {
    ctx.strokeStyle = p.slabs;
    ctx.lineWidth = 2;
    for (let y = 0; y <= 512; y += 32) { ctx.beginPath(); ctx.moveTo(48, y); ctx.lineTo(208, y); ctx.stroke(); }
    for (let x = 48; x <= 208; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 512); ctx.stroke(); }
  }
  const tex = new THREE.CanvasTexture(c);
  // Canvas pixels are sRGB. Without this three treats them as linear and
  // the whole texture renders bleached — see makeSkyTexture(), which had
  // it from the start and is why the sky alone looked right.
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 60);
  // The road recedes to the horizon, so almost every road pixel on screen is
  // sampled at a grazing angle — exactly the case plain mipmapping blurs to
  // mush, and the main reason the track looked soft a few metres ahead of the
  // player. Anisotropic filtering is fixed-function GPU work that costs
  // essentially nothing and keeps the lane markings and kerbs crisp into the
  // distance. Clamped to 4 rather than the maximum: returns fall off sharply
  // after that, and a Fire TV Stick's GPU is not where to spend the rest.
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return tex;
}
let roadTexture = makeRoadTexture();
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
  pivot.userData.mesh = mesh; // so dressPlayer() can tint the sleeves
  if (cap) {
    // A hand or a shoe. A BOX, not a sphere (2026-09-04): every rounded
    // primitive on this character was quietly fighting the blocky look,
    // and a hard-edged end block also catches the light as its own facet
    // instead of smearing into a highlight.
    const capMesh = new THREE.Mesh(
      new THREE.BoxGeometry(cap.w, cap.h, cap.d),
      new THREE.MeshLambertMaterial({ color: cap.color })
    );
    capMesh.position.set(0, -h - cap.h / 2 + 0.02, cap.z || 0);
    pivot.add(capMesh);
  }
  pivot.position.y = pivotYOffset;
  return pivot;
}

const player = new THREE.Group();

// =====================================================================
// The character (2026-09-04 rebuild, Crossy-Road-style blocky proportions)
//
// Every part is an axis-aligned box. That is not a shortcut — it is the
// look: Crossy Road's characters are boxes too, and what makes them read
// as designed rather than programmer-art is proportion, flat saturated
// colour, and animation, not polygon count. It also happens to be the
// cheapest thing this Fire TV Stick can draw.
//
// The proportions are the main change from the old capsule-and-sphere rig:
// the head is now about 40% of total height and slightly WIDER than the
// body, with stubby limbs. That is what reads as "character" rather than
// "small person" when it is forty pixels tall and running away from you.
//
// Layout, feet at y=0:
//   legs   0.00 -> 0.58   head  1.30 -> 2.02  (0.72 cube-ish)
//   body   0.58 -> 1.30   arms  pivot at 1.22
//
// The body is deliberately WIDER than the head. A head wider than the
// shoulders reads as a bobblehead toy; matching them and giving the body
// some bulk reads as a character with shoulders, which is what carries the
// silhouette when it is small on screen.
// =====================================================================
const HEAD_Y = 1.66;   // centre of the head box
const TORSO_Y = 0.94;  // centre of the body box
const SKIN = 0xffc08a;

// Upper body (body + head + arms) is its own group so the run cycle can
// bob it while the legs stay planted on the ground — see updatePlaying().
const upper = new THREE.Group();
player.add(upper);

const torso = new THREE.Mesh(
  new THREE.BoxGeometry(0.86, 0.72, 0.58),
  new THREE.MeshLambertMaterial({ color: 0xff5a5f })
);
torso.position.y = TORSO_Y;
upper.add(torso);

const head = new THREE.Mesh(
  new THREE.BoxGeometry(0.80, 0.72, 0.76),
  new THREE.MeshLambertMaterial({ color: SKIN })
);
head.position.y = HEAD_Y;
upper.add(head);

// Eyes, on the front face (+z is the direction of travel, i.e. away from
// the camera). Barely visible in a runner, but they matter on the pairing
// screen and whenever the camera swings round.
const eyeGeo = new THREE.BoxGeometry(0.12, 0.16, 0.04);
const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
eyeL.position.set(-0.18, 0.02, 0.39);
const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
eyeR.position.set(0.18, 0.02, 0.39);
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
  const slab = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    hairGroup.add(m);
    return m;
  };
  // The head is a 0.80 x 0.72 x 0.76 box centred on the hair group's
  // origin: top face y = +0.36, back face z = -0.38. Hair wraps the top
  // AND the upper sides/back rather than sitting on top like a lid — from
  // behind, which is the view the player actually has, the back of the
  // head is most of the character's silhouette.
  if (style === 'short' || style === 'pony') {
    slab(0.86, 0.18, 0.82, 0, 0.30, 0);          // cap over the crown
    slab(0.86, 0.30, 0.10, 0, 0.08, -0.40);      // down to a natural hairline
    slab(0.86, 0.12, 0.10, 0, 0.20, 0.39);       // fringe over the brow
    if (style === 'pony') {
      slab(0.20, 0.18, 0.14, 0, 0.06, -0.46);    // band
      slab(0.17, 0.42, 0.17, 0, -0.18, -0.50);   // tail down the back
    }
  } else if (style === 'spiky') {
    slab(0.86, 0.16, 0.82, 0, 0.30, 0);
    slab(0.86, 0.26, 0.10, 0, 0.10, -0.40);
    const spikes = [[-0.26, 0.18], [0, -0.14], [0.26, 0.20], [-0.12, -0.28], [0.14, 0.02]];
    spikes.forEach(([x, z], i) => slab(0.15, 0.24 + (i % 2) * 0.08, 0.15, x, 0.50, z));
  } else if (style === 'afro') {
    slab(1.04, 0.50, 0.98, 0, 0.34, 0);          // one big block, not a sphere
    slab(0.84, 0.18, 0.78, 0, 0.66, 0);          // stepped top
  }
}

function buildHat(style, color) {
  clearGroup(hatGroup);
  propellerBlade = null;
  const mat = new THREE.MeshLambertMaterial({ color });
  if (style === 'none') return;
  const slab = (w, h, d, x, y, z, m) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m || mat);
    mesh.position.set(x, y, z);
    hatGroup.add(mesh);
    return mesh;
  };
  if (style === 'party') {
    // A stepped voxel cone — three shrinking blocks, which is how this
    // shape is built in a blocky style.
    slab(0.44, 0.18, 0.44, 0, 0.46, 0);
    slab(0.30, 0.18, 0.30, 0, 0.63, 0);
    slab(0.17, 0.18, 0.17, 0, 0.80, 0);
    slab(0.13, 0.13, 0.13, 0, 0.95, 0, new THREE.MeshLambertMaterial({ color: 0xffffff }));
  } else if (style === 'top') {
    slab(0.98, 0.09, 0.94, 0, 0.41, 0);          // brim
    slab(0.62, 0.46, 0.60, 0, 0.68, 0);          // crown
  } else if (style === 'cap' || style === 'propeller') {
    slab(0.86, 0.26, 0.82, 0, 0.48, 0);          // crown
    slab(0.56, 0.08, 0.30, 0, 0.39, 0.52);       // peak, over the face
    if (style === 'propeller') {
      slab(0.07, 0.13, 0.07, 0, 0.67, 0, new THREE.MeshLambertMaterial({ color: 0x888888 }));
      propellerBlade = slab(0.42, 0.05, 0.09, 0, 0.76, 0, new THREE.MeshLambertMaterial({ color: 0xffd166 }));
    }
  }
}

function dressPlayer(character) {
  if (!character) return;
  buildHair(character.hair || 'bald', character.hairColor || '#3b2a1a');
  buildHat(character.hat || 'none', character.hatColor || '#ff5a5f');
  if (character.shirtColor) {
    torso.material.color.set(character.shirtColor);
    // Sleeves a shade darker than the shirt so the arms separate from the
    // torso at a glance — from directly behind they are otherwise one
    // solid block of colour and the run cycle stops reading.
    const sleeve = new THREE.Color(character.shirtColor).multiplyScalar(0.78);
    [armL, armR].forEach((a) => a.userData.mesh.material.color.copy(sleeve));
  }
}

// Arms hang off the upper body so they bob with it; legs belong to the
// player root so the feet stay on the ground through the run cycle.
const armL = limb(0.22, 0.54, 0.26, 0xff5a5f, 1.22, { w: 0.24, h: 0.20, d: 0.28, color: SKIN });
armL.position.x = -0.57;
upper.add(armL);
const armR = limb(0.22, 0.54, 0.26, 0xff5a5f, 1.22, { w: 0.24, h: 0.20, d: 0.28, color: SKIN });
armR.position.x = 0.57;
upper.add(armR);

const legL = limb(0.28, 0.46, 0.30, 0x2b2f45, 0.58, { w: 0.30, h: 0.14, d: 0.40, color: 0x1c1f2e, z: 0.05 });
legL.position.x = -0.20;
player.add(legL);
const legR = limb(0.28, 0.46, 0.30, 0x2b2f45, 0.58, { w: 0.30, h: 0.14, d: 0.40, color: 0x1c1f2e, z: 0.05 });
legR.position.x = 0.20;
player.add(legR);

// Dressed only once the limbs exist: dressPlayer() tints the sleeves too,
// so calling it any earlier hits armL/armR in their temporal dead zone and
// throws before the scene ever renders.
dressPlayer({ hair: 'short', hairColor: '#3b2a1a', hat: 'none', hatColor: '#ff5a5f', shirtColor: '#ff5a5f' });

// Star aura — an unlit translucent shell that only appears while the star
// is running. Deliberately a separate object rather than a tint on the
// character's own materials: those carry the player's chosen shirt/hair
// colours, and restoring them correctly afterwards is a bug waiting to
// happen. depthWrite off so it never occludes the character inside it.
// Additive, not plain transparency: a translucent box TINTS the character
// (it looked like he was standing behind frosted glass), whereas additive
// blending only ever adds light, so he glows instead of dimming.
const starAura = new THREE.Mesh(
  new THREE.BoxGeometry(1.7, 2.6, 1.6),
  new THREE.MeshBasicMaterial({
    color: 0xffd93d,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
);
starAura.position.y = 1.06;
starAura.visible = false;
player.add(starAura);

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
// 2026-09-04: all scenery is boxes now. A cone tree and a sphere bush beside
// a voxel character read as two different games; the whole point of the
// blocky style is that everything obeys it. Cheaper too — a box is 12
// triangles where the old cone/sphere pair was well over a hundred.
function boxMesh(w, h, d, color) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
}
function makeTree() {
  const g = new THREE.Group();
  const scale = 0.85 + Math.random() * 0.4;
  const trunk = boxMesh(0.34, 1.2 * scale, 0.34, 0x8a5f36);
  trunk.position.y = 0.6 * scale;
  // Two stacked canopy blocks, the upper one smaller — a stepped voxel
  // silhouette rather than a smooth cone.
  const lower = boxMesh(1.6 * scale, 0.95 * scale, 1.6 * scale, jitterColor(0x53bf58, 0.1));
  lower.position.y = 1.2 * scale + 0.48 * scale;
  const upper = boxMesh(1.1 * scale, 0.7 * scale, 1.1 * scale, jitterColor(0x66d16b, 0.1));
  upper.position.y = 1.2 * scale + 1.3 * scale;
  g.add(trunk, lower, upper);
  return g;
}
function makeBush() {
  const g = new THREE.Group();
  const n = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    const w = 0.5 + Math.random() * 0.35;
    const h = 0.4 + Math.random() * 0.3;
    const blob = boxMesh(w, h, w * 0.9, jitterColor(0x58bd61, 0.1));
    blob.position.set((Math.random() - 0.5) * 0.5, h / 2, (Math.random() - 0.5) * 0.4);
    g.add(blob);
  }
  return g;
}
function makeRock() {
  const g = new THREE.Group();
  const w = 0.42 + Math.random() * 0.3;
  const h = 0.3 + Math.random() * 0.24;
  const base = boxMesh(w, h, w * 0.85, jitterColor(0x9298a4, 0.05));
  base.position.y = h / 2;
  g.add(base);
  if (Math.random() < 0.6) {
    const cap = boxMesh(w * 0.55, h * 0.6, w * 0.5, jitterColor(0xa2a8b4, 0.05));
    cap.position.set(w * 0.12, h + h * 0.3, 0);
    g.add(cap);
  }
  return g;
}
// ---- Era-specific scenery (2026-09-04 MotionQuest) -------------------
// Same rule as everything else: axis-aligned boxes only. What separates a
// cypress from a palm from a neon tower is proportion and colour, not
// geometry — which is exactly why four visually distinct eras cost almost
// nothing extra to draw.

// Primeval valley: tall bare-trunked tree ferns with a wide frond crown.
function makePalm() {
  const g = new THREE.Group();
  const scale = 0.9 + Math.random() * 0.5;
  const trunk = boxMesh(0.3, 2.6 * scale, 0.3, jitterColor(0x7a5a3a, 0.08));
  trunk.position.y = 1.3 * scale;
  g.add(trunk);
  // Fronds splayed from the crown. Each is a long slab hung off a pivot at
  // the trunk top, so rotating the pivot swings the whole frond outward and
  // down — rotating the slab itself would spin it about its own middle and
  // give you a propeller, which is exactly what the first attempt looked
  // like. Five, not four, so the crown never reads as a flat cross when
  // seen from directly behind.
  const crownY = 2.6 * scale;
  for (let i = 0; i < 5; i++) {
    const pivot = new THREE.Group();
    pivot.position.y = crownY;
    pivot.rotation.y = (i / 5) * Math.PI * 2 + Math.random() * 0.2;
    pivot.rotation.z = -0.42 - Math.random() * 0.18; // droop
    const frond = boxMesh(1.5, 0.14, 0.44, jitterColor(0x3f9c52, 0.12));
    frond.position.x = 0.75; // hangs out from the pivot, not centred on it
    pivot.add(frond);
    g.add(pivot);
  }
  // A stubby cluster at the very top hides the join where the fronds meet.
  const crown = boxMesh(0.42, 0.3, 0.42, 0x4f7a3a);
  crown.position.y = crownY + 0.08;
  g.add(crown);
  return g;
}
// A fern clump — low, wide, and a colder green than the canopy above.
function makeFern() {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const blade = boxMesh(0.24, 0.9 + Math.random() * 0.5, 0.24, jitterColor(0x2f7d45, 0.12));
    blade.position.set((Math.random() - 0.5) * 0.7, 0.5, (Math.random() - 0.5) * 0.5);
    blade.rotation.z = (Math.random() - 0.5) * 0.5;
    g.add(blade);
  }
  return g;
}
// Bones sticking out of the ground — cheap, and instantly says "dinosaur".
function makeBones() {
  const m = modelInstance('dinosaur_bone');
  if (m) { m.rotation.y = Math.random() * Math.PI; return m; }
  const g = new THREE.Group();
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const rib = boxMesh(0.14, 0.9 + Math.random() * 0.6, 0.14, 0xe8e2d0);
    rib.position.set(-0.5 + i * 0.28, 0.5, (Math.random() - 0.5) * 0.3);
    rib.rotation.z = 0.3 + Math.random() * 0.2;
    g.add(rib);
  }
  return g;
}

// Ancient Rome: cypress trees — narrow, very tall, near-black green.
function makeCypress() {
  const g = new THREE.Group();
  const scale = 1.0 + Math.random() * 0.5;
  const trunk = boxMesh(0.22, 0.5, 0.22, 0x6b4a30);
  trunk.position.y = 0.25;
  const body = boxMesh(0.85, 3.2 * scale, 0.85, jitterColor(0x2c5e37, 0.08));
  body.position.y = 0.5 + 1.6 * scale;
  const tip = boxMesh(0.5, 0.7 * scale, 0.5, jitterColor(0x336b3f, 0.08));
  tip.position.y = 0.5 + 3.2 * scale + 0.35 * scale;
  g.add(trunk, body, tip);
  return g;
}
// A fluted marble column, sometimes broken off partway up.
function makeColumn() {
  const m = modelInstance('roman_column');
  if (m) { m.scale.multiplyScalar(0.9 + Math.random() * 0.5); return m; }
  const g = new THREE.Group();
  const broken = Math.random() < 0.3;
  const h = broken ? 1.4 + Math.random() * 0.8 : 3.4 + Math.random() * 0.8;
  const base = boxMesh(0.9, 0.22, 0.9, 0xdcd3bd);
  base.position.y = 0.11;
  const shaft = boxMesh(0.62, h, 0.62, jitterColor(0xeee6d2, 0.04));
  shaft.position.y = 0.22 + h / 2;
  g.add(base, shaft);
  if (!broken) {
    const cap = boxMesh(0.9, 0.26, 0.9, 0xdcd3bd);
    cap.position.y = 0.22 + h + 0.13;
    g.add(cap);
  }
  return g;
}
// The red-and-gold banner from the key art, hanging from a pole.
// The pack's arch is a better roadside landmark than a banner pole, so Rome
// alternates the two: an arch where a model is available, the banner
// otherwise. Both together read as a street rather than a colonnade.
function makeArchOrBanner() {
  const m = modelInstance('roman_arch');
  if (m) { m.rotation.y = (Math.random() - 0.5) * 0.4; return m; }
  return makeBanner();
}
function makeBanner() {
  const g = new THREE.Group();
  const pole = boxMesh(0.14, 3.6, 0.14, 0x8a6a3a);
  pole.position.y = 1.8;
  const cloth = boxMesh(0.9, 1.7, 0.08, 0xa8202a);
  cloth.position.set(0.45, 2.5, 0);
  const laurel = boxMesh(0.34, 0.34, 0.1, 0xd9b04a);
  laurel.position.set(0.45, 2.7, 0.06);
  g.add(pole, cloth, laurel);
  return g;
}

// Future city: neon towers of stacked slabs with lit window bands.
function makeTower() {
  const g = new THREE.Group();
  const h = 6 + Math.random() * 12;
  const w = 1.6 + Math.random() * 1.4;
  const body = boxMesh(w, h, w, 0x1b2340);
  body.position.y = h / 2;
  g.add(body);
  // Emissive window bands — MeshBasicMaterial so they glow flatly at full
  // brightness regardless of the scene lighting, which is what reads as
  // "lit from inside" rather than "a pale stripe".
  const neon = [0x36e0ff, 0xff4fd8, 0x9b6bff][Math.floor(Math.random() * 3)];
  const bandCount = Math.floor(h / 1.8);
  for (let i = 0; i < bandCount; i++) {
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(w * 1.02, 0.16, w * 1.02),
      new THREE.MeshBasicMaterial({ color: neon })
    );
    band.position.y = 1.2 + i * 1.8;
    g.add(band);
  }
  return g;
}
// A short holographic advert pylon at ground level.
function makeHoloSign() {
  // Half the future's "signs" are now the pack's drone, hung in the air
  // where a flying machine belongs — the key art has them above the street.
  if (Math.random() < 0.5) {
    const d = modelInstance('future_drone');
    if (d) {
      d.position.y = 3.2 + Math.random() * 2.2;
      d.rotation.y = (Math.random() - 0.5) * 0.6;
      return d;
    }
  }
  const g = new THREE.Group();
  const post = boxMesh(0.16, 2.2, 0.16, 0x2a3350);
  post.position.y = 1.1;
  const neon = [0x36e0ff, 0xff4fd8, 0xffe14f][Math.floor(Math.random() * 3)];
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 0.9, 0.08),
    new THREE.MeshBasicMaterial({ color: neon, transparent: true, opacity: 0.75 })
  );
  panel.position.y = 2.5;
  g.add(post, panel);
  return g;
}

const SCENERY_MAKERS = {
  tree: makeTree, bush: makeBush, rock: makeRock,
  palm: makePalm, fern: makeFern, bones: makeBones,
  cypress: makeCypress, column: makeColumn, banner: makeArchOrBanner,
  tower: makeTower, holo: makeHoloSign,
};

// Rebuilds the roadside scenery for an era. Old props are removed and their
// geometry/materials disposed — without that, switching eras a few times
// would leak GPU memory on a device that has very little of it.
function buildScenery(names) {
  while (sceneryPool.length) {
    const prop = sceneryPool.pop();
    scene.remove(prop);
    prop.traverse((n) => { n.geometry?.dispose(); n.material?.dispose(); });
  }
  for (let i = 0; i < 26; i++) {
    const make = SCENERY_MAKERS[names[Math.floor(Math.random() * names.length)]] || makeTree;
    const t = make();
    const side = i % 2 === 0 ? -1 : 1;
    t.position.set(side * (5.5 + Math.random() * 3.5), 0, -i * 7.5 - Math.random() * 6);
    // Auto-terrain (dino/rome) redraws x/y from these each frame instead of
    // the roadside props staying planted on a flat, straight verge while the
    // road itself visibly curves and rolls underneath them.
    t.userData.baseX = t.position.x;
    t.userData.baseY = t.position.y;
    // Where the prop is along the track, in the same sign convention
    // position.z used to carry (negative = ahead). The corner path (2026-09-09)
    // needs the drawn position free, so this is the scroll/recycle variable.
    t.userData.trackZ = t.position.z;
    // Several makers give their prop a random yaw; keep it so the corner
    // alignment adds to it rather than flattening every prop to one angle.
    t.userData.baseYaw = t.rotation.y;
    scene.add(t);
    sceneryPool.push(t);
  }
}
buildScenery(['tree', 'tree', 'tree', 'bush', 'rock']);

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
  const tex = new THREE.CanvasTexture(c);
  // Canvas pixels are sRGB. Without this three treats them as linear and
  // the whole texture renders bleached — see makeSkyTexture(), which had
  // it from the start and is why the sky alone looked right.
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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
  // Canvas pixels are sRGB. Without this three treats them as linear and
  // the whole texture renders bleached — see makeSkyTexture(), which had
  // it from the start and is why the sky alone looked right.
  tex.colorSpace = THREE.SRGBColorSpace;
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
  // Canvas pixels are sRGB. Without this three treats them as linear and
  // the whole texture renders bleached — see makeSkyTexture(), which had
  // it from the start and is why the sky alone looked right.
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.5, 2);
  return tex;
}
const crateTexture = makeCrateTexture();
const hazardTexture = makeHazardTexture();
const brickTexture = makeBrickTexture();

// =====================================================================
// Obstacle shapes, per era (2026-09-04 MotionQuest)
//
// Four obstacle types, each tied to one move the player has to make:
//   hurdle  JUMP    crate   PUNCH    wall  MOVE (dodge)    lowbar  DUCK
//
// Every era supplies its own mesh for all four. The GAMEPLAY is identical
// across eras — same lanes, same collision box, same timing — so a player
// who has learned Present Day can read a Roman street immediately. Only
// the costume changes. That is deliberate: a runner that changed its rules
// per level would be teaching four games instead of one.
//
// LOW BAR GEOMETRY (the new duck obstacle): the beam sits with its
// underside at y=1.35 and its top around y=2.6. A standing player is about
// 2.0 tall, so they walk straight into it; ducking (see DUCK_HEIGHT in
// updatePlaying) drops them under it. Jumping does NOT save you — it puts
// your head squarely into the beam, which is the point of having a move
// that isn't "jump".
// =====================================================================
const LOWBAR_UNDERSIDE = 1.35;

// =====================================================================
// THE PUNCHABLE CHARACTERS (2026-09-10)
//
// One per era, and the only obstacle the player meets face to face — you
// walk right up to these and hit them, so they carry more of the game's
// character than anything else on the track and are worth real geometry.
//
// Built to read at speed, from behind, at roughly 10-20 metres: strong
// silhouette first (tail, crest, cannon arms), detail second. Each is
// 20-30 boxes, which is nothing next to the scenery already on screen, and
// each gets a slow idle motion so it looks alive on the approach rather
// than like a prop sitting on the road — see updateObstacleIdle().
//
// They face the player (+z), because you are running at them.
// =====================================================================

/** Shorthand: a box at a position, optionally rotated, added to `g`. */
function part(g, w, h, d, color, x, y, z, rx, ry) {
  const m = boxMesh(w, h, d, color);
  m.position.set(x, y, z);
  if (rx) m.rotation.x = rx;
  if (ry) m.rotation.y = ry;
  g.add(m);
  return m;
}

function makeTrex() {
  const g = new THREE.Group();
  const HIDE = 0x5f9e46, BELLY = 0x9dc47a, DARK = 0x477a34;
  // Body, sloping forward from the hips — the line that makes a theropod
  // read as a theropod rather than as a standing lizard.
  part(g, 0.95, 0.85, 1.25, HIDE, 0, 1.15, 0);
  part(g, 0.72, 0.55, 0.5, BELLY, 0, 0.98, 0.42);
  // Tail: four tapering segments, each lower and further back, so it reads
  // as a counterweight rather than a stuck-on stump.
  const tail = [[0.6, 0.5, 0.75, 1.18, -0.85], [0.46, 0.4, 0.7, 1.06, -1.45],
                [0.32, 0.3, 0.65, 0.94, -1.98], [0.2, 0.2, 0.55, 0.84, -2.4]];
  tail.forEach(([w, h, d, y, z], i) => part(g, w, h, d, i % 2 ? DARK : HIDE, 0, y, z));
  // Neck and head, thrust forward over the legs.
  part(g, 0.42, 0.42, 0.5, HIDE, 0, 1.55, 0.5);
  const head = part(g, 0.55, 0.5, 0.95, HIDE, 0, 1.78, 0.95);
  head.name = 'trexHead';
  part(g, 0.5, 0.22, 0.8, BELLY, 0, 1.6, 1.02);          // lower jaw
  // Teeth — four little white blocks along the jawline. Tiny, but they are
  // what turns a green box into something with a mouth.
  for (let i = 0; i < 4; i++) part(g, 0.08, 0.16, 0.08, 0xfdf6e3, -0.18 + i * 0.12, 1.66, 1.36);
  part(g, 0.14, 0.14, 0.06, 0xffd24a, -0.2, 1.92, 1.34); // eyes
  part(g, 0.14, 0.14, 0.06, 0xffd24a, 0.2, 1.92, 1.34);
  part(g, 0.08, 0.08, 0.05, 0x1a1a1a, -0.2, 1.92, 1.38);
  part(g, 0.08, 0.08, 0.05, 0x1a1a1a, 0.2, 1.92, 1.38);
  part(g, 0.3, 0.16, 0.2, DARK, 0, 2.06, 1.1);           // brow ridge
  // The famous little arms.
  part(g, 0.12, 0.32, 0.12, HIDE, -0.5, 1.3, 0.5);
  part(g, 0.12, 0.32, 0.12, HIDE, 0.5, 1.3, 0.5);
  part(g, 0.1, 0.1, 0.18, BELLY, -0.5, 1.14, 0.58);
  part(g, 0.1, 0.1, 0.18, BELLY, 0.5, 1.14, 0.58);
  // Legs: thick thigh, angled shin, big three-toed foot.
  [-1, 1].forEach((side) => {
    part(g, 0.4, 0.6, 0.5, HIDE, side * 0.36, 0.75, -0.1);
    part(g, 0.26, 0.55, 0.3, DARK, side * 0.36, 0.32, 0.06);
    part(g, 0.36, 0.16, 0.6, DARK, side * 0.36, 0.08, 0.28);
    for (let t = 0; t < 3; t++) part(g, 0.09, 0.1, 0.16, 0xe8e0cf, side * 0.36 + (t - 1) * 0.12, 0.05, 0.56);
  });
  // Back stripes, for a bit of pattern at distance.
  for (let i = 0; i < 3; i++) part(g, 0.12, 0.1, 0.9, DARK, -0.3 + i * 0.3, 1.58, -0.1);
  g.userData.idle = 'trex';
  g.userData.parts = { head };
  return g;
}

function makeLegionary() {
  const g = new THREE.Group();
  const TUNIC = 0xb23a2e, ARMOUR = 0xc9a227, SKIN = 0xd9a273, LEATHER = 0x6b4a2f;
  part(g, 0.62, 0.62, 0.42, ARMOUR, 0, 1.32, 0);          // segmented cuirass
  for (let i = 0; i < 3; i++) part(g, 0.66, 0.08, 0.46, 0xa8871c, 0, 1.14 + i * 0.2, 0);
  part(g, 0.6, 0.34, 0.4, TUNIC, 0, 0.92, 0);             // tunic skirt
  for (let i = 0; i < 4; i++) part(g, 0.1, 0.28, 0.06, LEATHER, -0.24 + i * 0.16, 0.7, 0.21);
  // Head, helmet and the crest that makes the silhouette unmistakable.
  part(g, 0.34, 0.34, 0.32, SKIN, 0, 1.79, 0);
  part(g, 0.4, 0.26, 0.38, ARMOUR, 0, 1.94, 0);           // helmet bowl
  part(g, 0.44, 0.08, 0.12, ARMOUR, 0, 1.86, 0.2);        // brow guard
  part(g, 0.1, 0.3, 0.34, ARMOUR, -0.2, 1.8, 0);          // cheek plates
  part(g, 0.1, 0.3, 0.34, ARMOUR, 0.2, 1.8, 0);
  const crest = part(g, 0.1, 0.26, 0.5, TUNIC, 0, 2.18, -0.02);
  crest.name = 'crest';
  part(g, 0.08, 0.06, 0.12, 0xffd24a, -0.09, 1.83, 0.18); // eyes in the helmet shadow
  part(g, 0.08, 0.06, 0.12, 0xffd24a, 0.09, 1.83, 0.18);
  // Shield on the left arm, held across the body — the big readable shape.
  const shield = new THREE.Group();
  part(shield, 0.62, 1.0, 0.12, TUNIC, 0, 0, 0);
  part(shield, 0.5, 0.16, 0.14, ARMOUR, 0, 0.22, 0.02);
  part(shield, 0.16, 0.16, 0.16, ARMOUR, 0, 0, 0.08);     // boss
  part(shield, 0.16, 0.5, 0.13, ARMOUR, 0, -0.22, 0.01);
  shield.position.set(-0.5, 1.22, 0.3);
  shield.rotation.y = 0.3;
  shield.name = 'shield';
  g.add(shield);
  part(g, 0.18, 0.5, 0.18, SKIN, -0.42, 1.35, 0.12);      // shield arm
  // Spear arm, raised.
  part(g, 0.18, 0.5, 0.18, SKIN, 0.42, 1.4, 0.05);
  const spear = part(g, 0.08, 1.9, 0.08, LEATHER, 0.52, 1.5, 0.15);
  spear.name = 'spear';
  part(g, 0.12, 0.3, 0.12, 0xd8d8d8, 0.52, 2.5, 0.15);    // spearhead
  // Legs and sandals.
  [-1, 1].forEach((side) => {
    part(g, 0.22, 0.55, 0.24, SKIN, side * 0.17, 0.45, 0);
    part(g, 0.24, 0.12, 0.34, LEATHER, side * 0.17, 0.11, 0.05);
    part(g, 0.25, 0.1, 0.25, ARMOUR, side * 0.17, 0.62, 0.11); // greaves
  });
  g.userData.idle = 'legionary';
  g.userData.parts = { crest, spear };
  return g;
}

function makeSentryBot() {
  const g = new THREE.Group();
  const SHELL = 0x2f3a63, TRIM = 0x4a5891, NEON = 0x36e0ff, HOT = 0xff4fd8;
  part(g, 0.9, 0.8, 0.6, SHELL, 0, 1.35, 0);              // chassis
  part(g, 0.96, 0.1, 0.64, TRIM, 0, 1.72, 0);
  part(g, 0.7, 0.3, 0.5, TRIM, 0, 0.95, 0);               // waist
  // Head with a full-width visor — the one bright shape, so it reads first.
  part(g, 0.5, 0.36, 0.44, SHELL, 0, 1.95, 0);
  const visor = neonBox(0.44, 0.14, 0.06, NEON);
  visor.position.set(0, 1.97, 0.24);
  visor.name = 'visor';
  g.add(visor);
  part(g, 0.06, 0.24, 0.06, TRIM, 0, 2.24, 0);            // antenna
  const blip = neonBox(0.1, 0.1, 0.1, HOT);
  blip.position.set(0, 2.4, 0);
  blip.name = 'blip';
  g.add(blip);
  // Shoulders and arm cannons.
  [-1, 1].forEach((side) => {
    part(g, 0.28, 0.3, 0.42, TRIM, side * 0.6, 1.6, 0);
    part(g, 0.22, 0.5, 0.22, SHELL, side * 0.62, 1.25, 0.02);
    part(g, 0.3, 0.3, 0.55, SHELL, side * 0.62, 1.0, 0.2); // cannon housing
    const muzzle = neonBox(0.16, 0.16, 0.12, HOT);
    muzzle.position.set(side * 0.62, 1.0, 0.5);
    g.add(muzzle);
  });
  // Chest light and vents.
  const core = neonBox(0.26, 0.26, 0.06, HOT);
  core.position.set(0, 1.38, 0.31);
  core.name = 'core';
  g.add(core);
  for (let i = 0; i < 3; i++) part(g, 0.5, 0.05, 0.05, NEON, 0, 1.6 - i * 0.09, 0.31);
  // Legs ending in a hover pad rather than feet — it floats a little.
  [-1, 1].forEach((side) => {
    part(g, 0.24, 0.45, 0.28, SHELL, side * 0.22, 0.62, 0);
    part(g, 0.3, 0.14, 0.42, TRIM, side * 0.22, 0.36, 0.04);
  });
  const glow = neonBox(0.8, 0.08, 0.5, NEON);
  glow.position.set(0, 0.24, 0.02);
  glow.name = 'hoverGlow';
  g.add(glow);
  g.userData.idle = 'bot';
  g.userData.parts = { visor, blip, core, glow };
  return g;
}

/**
 * A slow idle for the punchable characters, so one standing on the track
 * reads as something waiting for you rather than as furniture. Called once
 * per character per frame from the obstacle loop.
 *
 * Everything here is bounded and driven off the object's own phase offset,
 * so a row of three across the lanes doesn't move in lockstep — the giveaway
 * that would make them look like three copies of one prop.
 */
function updateObstacleIdle(mesh, t) {
  const kind = mesh.userData.idle;
  if (!kind) return;
  if (mesh.userData.phase === undefined) mesh.userData.phase = Math.random() * Math.PI * 2;
  const ph = mesh.userData.phase;
  const p = mesh.userData.parts || {};
  if (kind === 'trex') {
    // Weight shifting foot to foot, head swinging with it.
    mesh.rotation.z = Math.sin(t * 1.6 + ph) * 0.045;
    if (p.head) {
      p.head.position.y = 1.78 + Math.sin(t * 2.4 + ph) * 0.07;
      p.head.rotation.x = Math.sin(t * 1.1 + ph) * 0.12;
    }
  } else if (kind === 'legionary') {
    // At attention, but not carved from stone: the crest catches the wind
    // and the spear shifts in his grip.
    if (p.crest) p.crest.rotation.z = Math.sin(t * 2.2 + ph) * 0.16;
    if (p.spear) p.spear.rotation.z = 0.05 + Math.sin(t * 0.9 + ph) * 0.04;
    mesh.rotation.z = Math.sin(t * 0.8 + ph) * 0.02;
  } else if (kind === 'bot') {
    // Hovering, with the visor and core breathing and the antenna blipping.
    mesh.position.y += Math.sin(t * 1.9 + ph) * 0.06;
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 3.1 + ph));
    if (p.visor) p.visor.scale.set(1, pulse, 1);
    if (p.core) p.core.scale.setScalar(0.85 + pulse * 0.3);
    if (p.glow) p.glow.scale.set(1 + Math.sin(t * 1.9 + ph) * 0.12, 1, 1);
    if (p.blip) p.blip.visible = Math.sin(t * 5.5 + ph) > 0;
  }
}

// --- Present Day -----------------------------------------------------
// 2026-09-10: the jump/duck/dodge obstacles were three or four plain boxes
// apiece and had almost no era character. Each is now built to say what it
// wants from the player in its silhouette — a hurdle is low and wide with
// clear air under the bar, a wall is tall and solid with no gap, a low bar
// hangs with obvious clearance beneath it — and to look like it belongs to
// its century.
function obPresentHurdle() {
  const g = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.2, 0.2), new THREE.MeshLambertMaterial({ map: hazardTexture }));
  bar.position.y = 0.6;
  g.add(bar);
  part(g, 1.7, 0.12, 0.14, 0xd98a00, 0, 0.34, 0);          // lower rail
  [-1, 1].forEach((side) => {
    part(g, 0.12, 0.62, 0.12, 0xd98a00, side * 0.72, 0.31, 0);
    part(g, 0.2, 0.08, 0.5, 0x8c9099, side * 0.72, 0.04, 0); // weighted foot
    part(g, 0.14, 0.14, 0.14, 0xffd166, side * 0.72, 0.68, 0); // cap light
  });
  return g;
}
function obPresentCrate() {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.1, 1.0), new THREE.MeshLambertMaterial({ map: crateTexture }));
  m.position.y = 0.55;
  return m;
}
function obPresentWall() {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.6, 0.6), new THREE.MeshLambertMaterial({ map: brickTexture }));
  m.position.y = 1.3;
  g.add(m);
  part(g, 1.95, 0.2, 0.75, 0x9aa0aa, 0, 2.7, 0);           // coping stone
  part(g, 1.9, 0.14, 0.7, 0x8c9099, 0, 0.07, 0);           // footing
  // A road-works sign bolted to it, so it reads as "closed" rather than
  // as a piece of scenery that happens to be in the way.
  part(g, 0.8, 0.55, 0.06, 0xffd166, 0, 1.75, 0.34);
  part(g, 0.55, 0.1, 0.05, 0x2a1a08, 0, 1.75, 0.38);
  return g;
}
function obPresentLowbar() {
  return modelOr('duck_barrier', obPresentLowbarBoxes);
}
function obPresentLowbarBoxes() {
  const g = new THREE.Group();
  const beam = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.36, 0.32), new THREE.MeshLambertMaterial({ map: hazardTexture }));
  beam.position.y = LOWBAR_UNDERSIDE + 0.18;
  g.add(beam);
  [-1, 1].forEach((side) => {
    part(g, 0.16, LOWBAR_UNDERSIDE + 0.36, 0.16, 0x8c9099, side * 1.0, (LOWBAR_UNDERSIDE + 0.36) / 2, 0);
    part(g, 0.42, 0.1, 0.42, 0x6d727a, side * 1.0, 0.05, 0);  // base plate
    part(g, 0.12, 0.12, 0.12, 0xff5a5f, side * 1.0, LOWBAR_UNDERSIDE + 0.44, 0);
  });
  // Hanging tapes, which is what actually sells "get under this".
  for (let i = 0; i < 5; i++) part(g, 0.12, 0.3, 0.03, 0xffd166, -0.8 + i * 0.4, LOWBAR_UNDERSIDE - 0.12, 0.14);
  return g;
}

// --- Primeval Valley (dinosaurs) -------------------------------------
function obDinoHurdle() {
  const g = new THREE.Group();
  part(g, 2.0, 0.5, 0.5, 0x6b4a2f, 0, 0.32, 0);            // fallen log
  part(g, 0.3, 0.3, 0.56, 0x54381f, 0.35, 0.34, 0);        // knot
  part(g, 1.9, 0.1, 0.52, 0x4c8f45, 0, 0.57, 0);           // moss along the top
  part(g, 0.55, 0.5, 0.55, 0x7a5638, -1.0, 0.3, 0);        // broken end, ragged
  part(g, 0.34, 0.3, 0.34, 0x54381f, 1.0, 0.36, 0.06);
  // Stumps of snapped branches, angled out of the trunk.
  part(g, 0.14, 0.5, 0.14, 0x54381f, -0.5, 0.6, 0.1, 0.5, 0);
  part(g, 0.12, 0.42, 0.12, 0x54381f, 0.62, 0.58, -0.08, -0.4, 0);
  for (let i = 0; i < 3; i++) part(g, 0.26, 0.12, 0.2, 0x3f8c4a, -0.6 + i * 0.6, 0.06, 0.28);
  return g;
}
// 2026-09-10. The three punchable characters were coming from the GLB pack,
// and those files are tiny — the T-rex was 7KB, which bought a green box with
// legs: no tail, no jaw, no arms. Hand-built geometry gets far more shape for
// the same triangle budget and matches the blocky art direction the rest of
// the game is authored in, so these are now built here and the weak models
// are no longer used for them. (roman_column, time_portal and the collectible
// models are Don's own and still come from the pack.)
function obDinoCrate() { return makeTrex(); }
function obDinoCrateBoxes() {
  const g = new THREE.Group();
  const nest = boxMesh(1.35, 0.34, 1.05, 0x7a5c34);
  nest.position.y = 0.17;
  g.add(nest);
  for (let i = 0; i < 3; i++) {
    const egg = boxMesh(0.36, 0.5, 0.36, 0xf0e4c8);
    egg.position.set(-0.36 + i * 0.36, 0.55, (i % 2) * 0.16 - 0.08);
    g.add(egg);
  }
  return g;
}
function obDinoWall() {
  const g = new THREE.Group();
  // A stack of boulders rather than one slab — offset a little each way so
  // the silhouette is craggy instead of rectangular.
  part(g, 1.8, 1.0, 0.7, 0x6f6659, 0, 0.5, 0);
  part(g, 1.6, 0.85, 0.66, 0x7b7264, -0.08, 1.4, 0.04);
  part(g, 1.3, 0.7, 0.6, 0x655d51, 0.1, 2.15, -0.03);
  part(g, 0.8, 0.45, 0.5, 0x827868, -0.05, 2.7, 0.02);
  part(g, 0.5, 0.3, 0.4, 0x6f6659, 0.45, 2.95, 0);
  // Ribs half-buried at the base — the valley eats runners.
  part(g, 0.16, 0.5, 0.16, 0xe8e0cf, -0.85, 0.22, 0.36, 0, 0.4);
  part(g, 0.16, 0.42, 0.16, 0xe8e0cf, 0.9, 0.18, 0.32, 0, -0.3);
  for (let i = 0; i < 3; i++) part(g, 0.3, 0.16, 0.26, 0x4c8f45, -0.6 + i * 0.6, 0.07, 0.4);
  return g;
}
function obDinoLowbar() {
  return modelOr('duck_barrier', obDinoLowbarBoxes);
}
function obDinoLowbarBoxes() {
  // A fallen branch slung across the trail with vines hanging off it.
  const g = new THREE.Group();
  const branch = boxMesh(2.2, 0.32, 0.32, 0x5e4128);
  branch.position.y = LOWBAR_UNDERSIDE + 0.16;
  g.add(branch);
  for (let i = 0; i < 5; i++) {
    const vine = boxMesh(0.1, 0.5 + Math.random() * 0.45, 0.1, 0x3f8c4a);
    vine.position.set(-0.85 + i * 0.42, LOWBAR_UNDERSIDE + 0.3 + 0.28, 0);
    g.add(vine);
  }
  const trunkA = boxMesh(0.26, LOWBAR_UNDERSIDE + 0.32, 0.26, 0x6b4a2f);
  trunkA.position.set(-1.05, (LOWBAR_UNDERSIDE + 0.32) / 2, 0);
  const trunkB = trunkA.clone(); trunkB.position.x = 1.05;
  g.add(trunkA, trunkB);
  return g;
}

// --- Ancient Rome ----------------------------------------------------
function obRomeHurdle() {
  const g = new THREE.Group();
  // A toppled column lying across the street, which is a far better reason
  // to jump than the plain marble step this used to be.
  part(g, 0.5, 0.5, 2.0, 0xefe7d4, 0, 0.3, 0);
  for (let i = 0; i < 4; i++) part(g, 0.54, 0.08, 0.3, 0xd8cfb6, 0, 0.3, -0.75 + i * 0.5);
  part(g, 0.7, 0.66, 0.3, 0xd8cfb6, 0, 0.33, 1.0);          // capital, one end
  part(g, 0.62, 0.58, 0.22, 0xcfc3a4, 0, 0.31, -1.02);      // broken base
  part(g, 0.3, 0.26, 0.26, 0xefe7d4, 0.75, 0.13, 0.55);     // chunks knocked off
  part(g, 0.24, 0.2, 0.2, 0xd8cfb6, -0.8, 0.1, -0.4);
  return g;
}
function obRomeCrate() { return makeLegionary(); }
function obRomeCrateBoxes() {
  const g = new THREE.Group();
  const legs = boxMesh(0.5, 0.5, 0.34, 0x8a6a4a);
  legs.position.y = 0.25;
  const skirt = boxMesh(0.68, 0.34, 0.42, 0xa8202a);
  skirt.position.y = 0.66;
  const torso = boxMesh(0.72, 0.6, 0.46, 0x9aa3ad);
  torso.position.y = 1.12;
  const head = boxMesh(0.46, 0.44, 0.44, 0xffc08a);
  head.position.y = 1.62;
  const helmet = boxMesh(0.54, 0.3, 0.52, 0x8f98a3);
  helmet.position.y = 1.82;
  const crest = boxMesh(0.12, 0.26, 0.54, 0xc9303a);
  crest.position.y = 2.06;
  const shield = boxMesh(0.14, 0.9, 0.6, 0xa8202a);
  shield.position.set(-0.44, 1.0, 0.12);
  const boss = boxMesh(0.06, 0.26, 0.26, 0xd9b04a);
  boss.position.set(-0.52, 1.0, 0.12);
  g.add(legs, skirt, torso, head, helmet, crest, shield, boss);
  return g;
}
function obRomeWall() {
  // The "AVOID PILLARS" panel.
  return modelOr('roman_column', obRomeWallBoxes);
}
function obRomeWallBoxes() {
  const g = new THREE.Group();
  part(g, 1.5, 0.3, 1.0, 0xd8cfb6, 0, 0.15, 0);             // plinth
  part(g, 1.3, 0.16, 0.9, 0xcfc3a4, 0, 0.36, 0);
  part(g, 1.1, 2.2, 0.8, 0xefe7d4, 0, 1.5, 0);              // shaft
  // Fluting: shallow vertical grooves picked out in a darker tone.
  for (let i = 0; i < 4; i++) part(g, 0.1, 2.1, 0.06, 0xdcd3bd, -0.36 + i * 0.24, 1.5, 0.41);
  part(g, 1.3, 0.2, 0.95, 0xd8cfb6, 0, 2.7, 0);             // capital
  part(g, 1.5, 0.22, 1.05, 0xefe7d4, 0, 2.9, 0);            // abacus
  part(g, 0.28, 0.28, 0.28, 0xd9b04a, -0.5, 2.72, 0.4);     // gilded corner volutes
  part(g, 0.28, 0.28, 0.28, 0xd9b04a, 0.5, 2.72, 0.4);
  return g;
}
function obRomeLowbar() {
  return modelOr('duck_barrier', obRomeLowbarBoxes);
}
function obRomeLowbarBoxes() {
  // The rope-slung timber with a red SPQR banner from the art.
  const g = new THREE.Group();
  const beam = boxMesh(2.3, 0.3, 0.34, 0x7a5a35);
  beam.position.y = LOWBAR_UNDERSIDE + 0.15;
  const cloth = boxMesh(1.5, 0.62, 0.08, 0xa8202a);
  cloth.position.set(0, LOWBAR_UNDERSIDE + 0.62, 0.2);
  const laurel = boxMesh(0.3, 0.3, 0.1, 0xd9b04a);
  laurel.position.set(0, LOWBAR_UNDERSIDE + 0.62, 0.26);
  const postA = boxMesh(0.22, LOWBAR_UNDERSIDE + 0.3, 0.22, 0x8a6a3a);
  postA.position.set(-1.1, (LOWBAR_UNDERSIDE + 0.3) / 2, 0);
  const postB = postA.clone(); postB.position.x = 1.1;
  g.add(beam, cloth, laurel, postA, postB);
  return g;
}

// --- Neon Future -----------------------------------------------------
// The glowing parts use MeshBasicMaterial so they stay at full brightness
// under the era's deliberately dim lighting — that contrast is what makes
// a night city read as neon rather than just dark.
function neonBox(w, h, d, color, opacity) {
  return new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshBasicMaterial({ color, transparent: opacity !== undefined, opacity: opacity === undefined ? 1 : opacity })
  );
}
function obFutureHurdle() {
  const g = new THREE.Group();
  const bar = neonBox(1.8, 0.22, 0.22, 0x36e0ff);
  bar.position.y = 0.58;
  g.add(bar);
  const under = neonBox(1.6, 0.06, 0.06, 0x9b6bff);
  under.position.y = 0.3;
  g.add(under);
  [-1, 1].forEach((side) => {
    part(g, 0.16, 0.6, 0.16, 0x2a3350, side * 0.88, 0.3, 0);
    part(g, 0.34, 0.1, 0.42, 0x39456b, side * 0.88, 0.05, 0);   // clamp foot
    const cap = neonBox(0.2, 0.12, 0.2, 0x36e0ff);
    cap.position.set(side * 0.88, 0.66, 0);
    g.add(cap);
  });
  return g;
}
function obFutureCrate() { return makeSentryBot(); }
function obFutureCrateBoxes() {
  const g = new THREE.Group();
  const body = boxMesh(1.0, 0.7, 0.8, 0x39456b);
  body.position.y = 0.9;
  const eye = neonBox(0.4, 0.24, 0.06, 0xff4fd8);
  eye.position.set(0, 0.98, 0.42);
  const fin = neonBox(1.3, 0.08, 0.1, 0x36e0ff);
  fin.position.y = 0.52;
  const skirt = boxMesh(0.5, 0.3, 0.5, 0x2a3350);
  skirt.position.y = 0.4;
  g.add(body, eye, fin, skirt);
  return g;
}
function obFutureWall() {
  const g = new THREE.Group();
  // A shield emitter: heavy posts top and bottom, energy field between.
  part(g, 2.0, 0.34, 0.4, 0x2a3350, 0, 0.17, 0);
  part(g, 2.0, 0.3, 0.4, 0x2a3350, 0, 2.75, 0);
  [-1, 1].forEach((side) => part(g, 0.22, 2.6, 0.34, 0x39456b, side * 0.9, 1.45, 0));
  const field = neonBox(1.6, 2.3, 0.1, 0x9b6bff, 0.55);
  field.position.y = 1.45;
  g.add(field);
  // Emitter nodes down each post, so the field looks generated rather than
  // painted on.
  for (let i = 0; i < 4; i++) {
    [-1, 1].forEach((side) => {
      const node = neonBox(0.14, 0.14, 0.4, 0x36e0ff);
      node.position.set(side * 0.9, 0.55 + i * 0.62, 0);
      g.add(node);
    });
  }
  return g;
}
function obFutureLowbar() {
  // A laser gate: solid emitters, glowing beam between them.
  const g = new THREE.Group();
  const beam = neonBox(2.2, 0.26, 0.18, 0xff4fd8);
  beam.position.y = LOWBAR_UNDERSIDE + 0.13;
  const glow = neonBox(2.2, 0.6, 0.06, 0xff4fd8, 0.28);
  glow.position.y = LOWBAR_UNDERSIDE + 0.3;
  const emitterA = boxMesh(0.28, LOWBAR_UNDERSIDE + 0.26, 0.28, 0x2a3350);
  emitterA.position.set(-1.1, (LOWBAR_UNDERSIDE + 0.26) / 2, 0);
  const emitterB = emitterA.clone(); emitterB.position.x = 1.1;
  g.add(beam, glow, emitterA, emitterB);
  return g;
}

// =====================================================================
// MODEL PACK (2026-09-04) — Don's motionquest_3d_asset_pack
//
// Thirteen low-poly GLB models, 1,344 triangles between them, no textures
// and no animation. That budget is nothing on this hardware, which is why
// they are worth using: they carry far more shape than a stack of boxes for
// no meaningful cost.
//
// THE CONTRACT: every model is optional. They load asynchronously after the
// page is already running, and any that fails — missing file, a format this
// parser doesn't handle, a bad fetch — simply leaves the hand-built box
// version in place. modelOr() is the whole mechanism: ask for a model, get
// the boxes back if it isn't there. Nothing in the game waits on a model and
// nothing breaks without one. The game shipped and was tested without these;
// they are an upgrade layered on top, not a dependency.
//
// `height` normalises every model to game units (the player is ~2.0 tall),
// because the pack is authored at its own scale and a Roman soldier three
// times the player's height would be a very different game.
// =====================================================================
// Sizes were set by rendering every model next to a player-height reference
// box, not by reading the numbers — which is how the flat ones (portal, road
// gap, drone) were caught: scaled by height they came out tens of units
// across. Those are normalised by width instead.
const MODEL_SPECS = {
  roman_soldier: { height: 2.0 },      // punchable, so player-sized
  roman_column: { height: 3.2 },       // a wall you must dodge — taller than you
  roman_arch: { height: 4.2 },         // scenery, overhead
  magic_potion: { height: 0.85 },      // "COLLECT MAGIC POTIONS", from the Rome art
  dinosaur_trex: { height: 2.3 },      // punchable, so kept near player height
  dinosaur_bone: { height: 0.8 },
  duck_barrier: { height: 1.75 },      // see the note in the lowbar builders
  future_robot: { height: 1.9 },
  future_energy_cell: { height: 0.75 },
  future_drone: { width: 2.2 },        // long and flat — width is its real size
  road_gap: { width: 2.4 },            // one lane wide
  time_portal: { width: 7.0 },         // a gateway you run through
};
const models = new Map();   // name -> loaded THREE.Group (the template)

async function loadModelPack() {
  await Promise.all(Object.entries(MODEL_SPECS).map(async ([name, spec]) => {
    try {
      models.set(name, await loadModel(`./models/${name}.glb`, spec));
    } catch (err) {
      // Deliberately a warning, not an error: a missing model is a downgrade
      // in looks, not a broken game, and the box fallback covers it.
      console.warn(`[models] ${name} unavailable, using built-in shape:`, err.message);
    }
  }));
  // Everything already in the scene was built from boxes. Re-apply the era so
  // the static parts (scenery, horizon) pick the models up rather than waiting
  // for the next era switch. Obstacles already on their way to the player are
  // left alone — swapping one out mid-approach would be worse than a late
  // upgrade.
  applyEra(currentEraId);
}

/**
 * A fresh instance of `name`, or null if that model isn't available.
 * clone() shares geometry and materials with the template, so a hundred
 * Roman soldiers cost one soldier's worth of GPU memory.
 */
function modelInstance(name) {
  const template = models.get(name);
  return template ? template.clone() : null;
}

/** A model if we have it, otherwise whatever `fallback()` builds. */
function modelOr(name, fallback) {
  return modelInstance(name) || fallback();
}

const ERA_OBSTACLES = {
  present: { hurdle: obPresentHurdle, crate: obPresentCrate, wall: obPresentWall, lowbar: obPresentLowbar },
  dino: { hurdle: obDinoHurdle, crate: obDinoCrate, wall: obDinoWall, lowbar: obDinoLowbar },
  rome: { hurdle: obRomeHurdle, crate: obRomeCrate, wall: obRomeWall, lowbar: obRomeLowbar },
  future: { hurdle: obFutureHurdle, crate: obFutureCrate, wall: obFutureWall, lowbar: obFutureLowbar },
};

function buildObstacleMesh(type) {
  const set = ERA_OBSTACLES[currentEraId] || ERA_OBSTACLES.present;
  const make = set[type] || set.hurdle;
  return make();
}

function spawnObstacle() {
  // Nothing is placed on the turn-in. An obstacle that first becomes visible
  // as the road is swinging away underneath it is unreadable — the player is
  // being asked to judge a lane against a horizon that is still rotating —
  // and the corner is much clearer with a clean stretch of road through it.
  // Skipping simply means no obstacle this tick; the spawn timer carries on,
  // so the run picks straight back up on the exit.
  if (terrainActive() && insideCorner(state.distance - SPAWN_Z)) return;
  const types = currentEra().obstacleTypes;
  const type = types[Math.floor(Math.random() * types.length)];
  const lane = Math.floor(Math.random() * 3);
  const mesh = buildObstacleMesh(type);
  mesh.position.x = LANE_X[lane];
  mesh.position.z = SPAWN_Z;
  scene.add(mesh);
  // baseY: whatever height the builder itself anchored the mesh at (usually
  // 0) — auto-terrain adds hillOffset() on top of this each frame rather
  // than overwriting it, so an obstacle with its own vertical anchor still
  // keeps it.
  // `trackZ` is the obstacle's distance along the track in the sign
  // convention position.z used to carry on its own (negative = ahead of the
  // player). Since 2026-09-09 the drawn position.z is a function of the
  // corner the obstacle is sitting on, so the two had to come apart —
  // EVERYTHING that decides gameplay (the collision window below, the punch
  // target search, despawn) reads trackZ, and nothing reads the drawn
  // position. That is what keeps corners strictly cosmetic.
  obstacles.push({ type, lane, mesh, resolved: false, flying: false, baseY: mesh.position.y, trackZ: SPAWN_Z });
  // A hurdle is the one obstacle you clear by going UP, so it's the natural
  // place to hang a gem: the jump you already have to make is what earns it.
  if (type === 'hurdle') spawnGem(lane, SPAWN_Z);
}

// =====================================================================
// THE ERAS (2026-09-04 — "MotionQuest: Move Through Time")
//
// Ordered chronologically, which is also the unlock order: you start in the
// primeval valley and work forward to the neon city. That ordering is the
// whole premise of the game, so the level select reads left-to-right as a
// timeline rather than an arbitrary menu.
//
// Each era is pure data — palette, lighting, scenery mix, obstacle set and
// an unlock threshold. Nothing here changes how the game PLAYS; see the
// note on ERA_OBSTACLES above for why that is deliberate.
//
// `goal` is the distance in metres at which the NEXT era unlocks. It is no
// longer a finish line — 2026-09-10 ("no end, but tell the player when the
// next level is unlocked"): a run now keeps going for as long as the player
// keeps their hearts, through the unlock moment and beyond, getting harder
// the further they get (see currentSpeed()/spawnInterval and ERA_TIER).
// `goal` still steps up per era rather than doubling, both because it's a
// gentler unlock curve and because a later era already starts tougher.
// =====================================================================
const ERAS = [
  {
    id: 'dino', name: 'Primeval Valley', sub: 'Mind the teeth', icon: '🦕',
    goal: 700,
    sky: ['#3a1f4d', '#8c3b2f', '#d9743a', '#f2c078'],
    glow: 'rgba(255,180,90,0.95)',
    fog: 0xd98f52, fogNear: 58, fogFar: 215,
    // Brighter fill than the first pass (0.62 / near-black ground bounce):
    // the volcanic sun is warm but low, and it was leaving the character a
    // near-silhouette against a bright sky — a runner you can't read is
    // worse than an era that's a shade less moody.
    hemi: [0xffe0b8, 0x7a5c42, 0.85], sun: [0xffc07a, 1.5, [-6, 7, -10]], rim: [0xff8f5a, 0.34],
    ground: { verge: ['#5f8f3c', '#557f36'], kerb: '#7a6a45', path: ['#7d6a4e', '#776449'], dash: null },
    scenery: ['palm', 'palm', 'fern', 'fern', 'bones', 'rock'],
    obstacleTypes: ['hurdle', 'crate', 'wall', 'lowbar'],
    coin: [0xffb03d, 0x6b3a00], gem: [0x6ee7ff, 0x0a5f75],
  },
  {
    id: 'rome', name: 'Ancient Rome', sub: 'Glory awaits', icon: '🏛️',
    goal: 900,
    sky: ['#1f68c9', '#5aa6e8', '#bfe0f2', '#f6efd9'],
    glow: 'rgba(255,248,220,0.95)',
    fog: 0xe6ddc2, fogNear: 62, fogFar: 225,
    hemi: [0xfff0d0, 0x7a6a52, 0.66], sun: [0xfff4dc, 1.4, [-5, 8, -11]], rim: [0xffd9a0, 0.3],
    ground: { verge: ['#6f9b45', '#66913e'], kerb: '#cfc3a4', path: ['#ded3b8', '#d6cbaf'], dash: null, slabs: 'rgba(120,105,75,0.35)' },
    scenery: ['cypress', 'cypress', 'column', 'banner', 'column'],
    obstacleTypes: ['hurdle', 'crate', 'wall', 'lowbar'],
    coin: [0x4fa8ff, 0x0a3a75], gem: [0xc77dff, 0x3a1060],
  },
  {
    id: 'present', name: 'Present Day', sub: 'Where you started', icon: '🏙️',
    goal: 1100,
    sky: DEFAULT_SKY,
    glow: 'rgba(255,250,225,0.9)',
    fog: 0xcdeaf7, fogNear: 62, fogFar: 220,
    hemi: [0xd6ecff, 0x6b7a8c, 0.6], sun: [0xfff6e2, 1.35, [-5, 8, -11]], rim: [0x9fc4ff, 0.32],
    ground: DEFAULT_GROUND,
    scenery: ['tree', 'tree', 'tree', 'bush', 'rock'],
    obstacleTypes: ['hurdle', 'crate', 'wall', 'lowbar'],
    coin: [0xffc53d, 0x6b4a00], gem: [0x6ee7ff, 0x0a5f75],
  },
  {
    id: 'future', name: 'Neon Future', sub: 'Systems online', icon: '🛸',
    goal: 1300,
    sky: ['#080b1f', '#1a1547', '#3d2170', '#6b2f8a'],
    glow: 'rgba(90,220,255,0.55)',
    fog: 0x2a1c4d, fogNear: 55, fogFar: 210,
    // Deliberately dim: the neon materials are MeshBasicMaterial and stay at
    // full brightness regardless, so lowering everything else is what makes
    // them pop instead of sitting flat against an evenly-lit scene.
    hemi: [0x4a5cff, 0x0d0a1f, 0.42], sun: [0x9fd8ff, 0.75, [-4, 7, -10]], rim: [0xff4fd8, 0.45],
    ground: { verge: ['#141a33', '#11162c'], kerb: '#36e0ff', path: ['#1d2340', '#1a2039'], dash: '#36e0ff', slabs: 'rgba(54,224,255,0.10)' },
    scenery: ['tower', 'tower', 'holo', 'tower', 'holo'],
    obstacleTypes: ['hurdle', 'crate', 'wall', 'lowbar'],
    coin: [0x36e0ff, 0x08616b], gem: [0xff4fd8, 0x6b0a52],
  },
];

// =====================================================================
// PER-ERA DIFFICULTY TIER (2026-09-10)
//
// "The levels should increase in difficulty as the player gets further
// in." An era's position in ERAS (0-3) nudges the run's starting speed up
// and its starting spawn gap down, on top of the existing ramp-with-distance
// inside a run (SPEED_RAMP/SPAWN_RAMP below) — so Ancient Rome opens
// noticeably brisker than Primeval Valley did, and Neon Future brisker
// still, even before either has covered a metre. Gentle steps, same
// philosophy as the `goal` spacing above: a later era should read as the
// next challenge, not a wall.
// =====================================================================
function eraTier(era) { return Math.max(0, ERAS.findIndex((e) => e.id === era.id)); }
function eraBaseSpeed(era) { return BASE_SPEED + eraTier(era) * 1.1; }
function eraBaseSpawnInterval(era) {
  return Math.max(MIN_SPAWN_INTERVAL + 0.15, BASE_SPAWN_INTERVAL - eraTier(era) * 0.14);
}

// =====================================================================
// HORIZON LANDMARKS (2026-09-04, from Don's key art)
//
// The single biggest difference between the uploaded artwork and the game
// was not colour or detail — it was that every piece of art has something
// ON THE HORIZON. The Rome mockup has the Colosseum behind the street; the
// dinosaur vignette has an erupting volcano; the future one has a city
// skyline. Without that, a runner reads as a corridor: you are travelling
// but never somewhere.
//
// These sit far down the track at HORIZON_Z and DO NOT SCROLL. That is the
// point — a landmark that slid past would be a prop, whereas one that stays
// put on the horizon is a place you are running towards. They are deep
// enough into the fog to be hazy, which is what sells the distance and also
// means they can be very coarse geometry without anyone noticing.
//
// Cost: a few dozen static boxes, built once per era switch, never updated
// per frame. Cheaper than one of the scenery props that actually moves.
// =====================================================================
const HORIZON_Z = -118;
let horizonGroup = null;

function horizonBox(g, w, h, d, x, y, z, color, basic) {
  const mat = basic
    ? new THREE.MeshBasicMaterial({ color })
    : new THREE.MeshLambertMaterial({ color });
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

// Primeval Valley: a stepped volcano with a lava cap and a glow, flanked by
// ridges. The lava uses MeshBasicMaterial so it stays hot against the dim,
// heavily-fogged distance instead of going grey with everything else.
function horizonDino(g) {
  const steps = [[34, 7, -1], [26, 9, 6], [18, 8, 15], [11, 6, 22]];
  for (const [w, d, y] of steps) horizonBox(g, w, 10, d, -6, y, 0, 0x5c4636);
  horizonBox(g, 9, 3, 6, -6, 27, 0, 0xff5a1e, true);      // crater
  horizonBox(g, 3.5, 9, 3.5, -4, 32, 0, 0xff8a3d, true);  // plume of lava
  horizonBox(g, 14, 7, 8, -13, 3.5, 6, 0x4c4030);         // shoulder
  // Ash cloud above it.
  horizonBox(g, 12, 6, 8, -5, 38, -3, 0x6b5a52);
  horizonBox(g, 8, 5, 6, 0, 44, -3, 0x7a6960);
  horizonBox(g, 5, 4, 5, 4, 49, -3, 0x8a7a70);
  // Far ridges either side. Stepped rather than one slab each: a single
  // wide box at this distance reads as a plank hanging over the horizon,
  // because a hard-edged rectangle floating in fog has nothing to say it is
  // a hill. Overlapping blocks of differing heights give it a skyline.
  const ridge = (baseX, dir) => {
    for (let i = 0; i < 6; i++) {
      const w = 9 + (i % 3) * 4;
      const h = 13 - i * 1.6 + (i % 2) * 3;
      horizonBox(g, w, h, 11, baseX + dir * i * 7, h / 2, 10 + (i % 2) * 4,
        i % 2 ? 0x4a5a3c : 0x415030);
    }
  };
  ridge(20, 1);
  ridge(-22, -1);
}

// Ancient Rome: the Colosseum, a triumphal arch and a temple portico —
// the three landmarks in the uploaded Rome mockup. The Colosseum is an
// approximated ring: an outer band of segments with a darker inner band
// behind it, which reads as an amphitheatre at this distance far more
// cheaply than modelling arches would.
function horizonRome(g) {
  const CX = -14, STONE = 0xd8c3a0, STONE_DK = 0xa8906c;
  const R = 15;
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const x = CX + Math.cos(a) * R;
    const z = Math.sin(a) * R * 0.5;
    // The back half sits lower, so the ring reads as an open bowl rather
    // than a solid drum.
    const h = z < 0 ? 12 : 17;
    horizonBox(g, 5.2, h, 4, x, h / 2, z, i % 2 ? STONE : STONE_DK);
  }
  horizonBox(g, 26, 3, 14, CX, 18.5, 0, STONE);  // top cornice
  // Triumphal arch to the right of the track.
  horizonBox(g, 5, 16, 5, 24, 8, 4, STONE);
  horizonBox(g, 5, 16, 5, 36, 8, 4, STONE);
  horizonBox(g, 17, 5, 6, 30, 18, 4, STONE);
  horizonBox(g, 11, 3, 7, 30, 22, 4, 0xd9b04a);  // gilded top
  // Temple portico further right.
  for (let i = 0; i < 5; i++) horizonBox(g, 1.8, 11, 1.8, 48 + i * 3.4, 5.5, 8, STONE);
  horizonBox(g, 20, 3, 6, 54.8, 12.5, 8, STONE_DK);
  // Distant cypress line.
  for (let i = 0; i < 9; i++) horizonBox(g, 2.6, 9 + (i % 3) * 2, 2.6, -60 + i * 5, 5, 14, 0x2f5c38);
}

// Present Day: a modest town skyline — enough to say the road goes
// somewhere, without competing with the era it belongs to.
function horizonPresent(g) {
  const blocks = [[10, 16, -34], [8, 22, -22], [12, 13, -10], [9, 19, 12], [11, 15, 24], [8, 24, 36]];
  for (const [w, h, x] of blocks) horizonBox(g, w, h, 9, x, h / 2, 0, 0x8494a8);
  for (let i = 0; i < 7; i++) horizonBox(g, 5, 6 + (i % 3) * 2, 6, -55 + i * 16, 3, 12, 0x6f8060);
}

// Neon Future: a dense skyline of towers with lit bands, the tallest
// clustered behind the track so you run into the middle of the city.
function horizonFuture(g) {
  const neon = [0x36e0ff, 0xff4fd8, 0x9b6bff];
  for (let i = 0; i < 16; i++) {
    const x = -60 + i * 8 + (i % 3);
    const h = 18 + ((i * 37) % 26) - Math.abs(x) * 0.16;
    const w = 5 + (i % 3);
    horizonBox(g, w, h, 7, x, h / 2, (i % 2) * 6, 0x141a33);
    const c = neon[i % 3];
    for (let b = 1; b < Math.floor(h / 5); b++) {
      horizonBox(g, w * 1.04, 0.5, 7.1, x, b * 5, (i % 2) * 6, c, true);
    }
    horizonBox(g, 1.2, 2.4, 1.2, x, h + 1.2, (i % 2) * 6, c, true); // aerial light
  }
}

const ERA_HORIZONS = {
  dino: horizonDino, rome: horizonRome, present: horizonPresent, future: horizonFuture,
};

function buildHorizon(id) {
  if (horizonGroup) {
    scene.remove(horizonGroup);
    horizonGroup.traverse((n) => { n.geometry?.dispose(); n.material?.dispose(); });
    horizonGroup = null;
  }
  const make = ERA_HORIZONS[id];
  if (!make) return;
  horizonGroup = new THREE.Group();
  horizonGroup.position.z = HORIZON_Z;
  make(horizonGroup);
  scene.add(horizonGroup);
}

const ERA_BY_ID = Object.fromEntries(ERAS.map((e) => [e.id, e]));
let currentEraId = 'present';
function currentEra() { return ERA_BY_ID[currentEraId] || ERA_BY_ID.present; }

// =====================================================================
// THE TRACK PATH — straight running, joined by real 90-degree corners
// (2026-09-09, replacing the 2026-09-08 "auto-terrain" wobble)
//
// The previous version bent the track with a pair of summed sine waves. It
// was never straight and it never actually turned: the character just slid
// continuously sideways, which is precisely the complaint — "it is supposed
// to be that the character turns 90 degrees round a corner and the camera
// stays behind them... there should always be straight line running but
// with 90 degree turns."
//
// So the path is now piecewise: long STRAIGHTS joined by CORNERS that each
// turn exactly 90 degrees, left or right, over CORNER_ARC metres of track.
// Between corners the heading is dead constant, so the running really is in
// a straight line.
//
// HOW THE CORNER IS DRAWN, and why the camera needs no work at all.
//
// The game is a treadmill: the character stays at the origin running toward
// -z, obstacles scroll toward +z, and the camera sits behind at +z looking
// down -z. Rather than fight that, the path is evaluated IN THE PLAYER'S OWN
// FRAME. pathLocal(d) answers "if I am here, where is the point d metres
// further along the track, relative to me and to the way I am currently
// facing?" — so the player is always at the origin facing -z, and the road
// ahead is what bends away and comes back. The camera therefore stays
// exactly, permanently behind the character through the whole turn without a
// single line of camera code, which is the behaviour that was asked for.
//
// It also means the corner is visible from a long way off: pathLocal is
// evaluated out to PATH_AHEAD metres, well beyond where obstacles spawn, so
// the bend is on screen and unmistakable long before the player reaches it.
//
// WHAT THIS DOES NOT TOUCH. Exactly as before, this is a rendering layer.
// The simulation underneath is still straight and lane-based: collision is
// lane index plus a z window, pickups are lane plus z, and `position.z` is
// still plain distance-ahead-along-the-track for every object. Bending where
// things are DRAWN can never desync a hit or a pickup, because nothing that
// decides either one reads any of this.
// =====================================================================

// Which eras run the corner system. 2026-09-09: all four. Corners are core
// to how the game reads now rather than a two-era experiment, and a player
// working forward through the timeline shouldn't find the road stops turning
// halfway. Narrow this set to scope it back.
const TERRAIN_ERA_IDS = new Set(['dino', 'rome', 'present', 'future']);
function terrainActive() { return TERRAIN_ERA_IDS.has(currentEraId); }

// Metres of track spent turning through the 90 degrees. At the game's
// speeds (12 m/s at the start, 26 flat out) 26m is roughly 1-2 seconds of
// turn: long enough to read as sweeping round a bend rather than pivoting on
// the spot, short enough to be unmistakably a corner rather than a drift.
const CORNER_ARC = 26;
const CORNER_FIRST_MIN = 90;       // never a corner before the player has settled in
const CORNER_STRAIGHT_MIN = 105;   // clear straight running between corners
const CORNER_STRAIGHT_MAX = 150;
const CORNER_WARN_DISTANCE = 60;   // how far out the "bend ahead" sign appears
// How far past the player's current distance the corner table stays built
// out to. Comfortably beyond PATH_AHEAD (below) so a corner is always fully
// laid out long before the road-drawing or spawn code needs to read it.
const CORNER_LOOKAHEAD = 600;

// How far along the track the local path is evaluated each frame. Ahead of
// the player this has to comfortably exceed the obstacle spawn point
// (SPAWN_Z, 80m) so a corner is fully drawn before anything arrives on it;
// behind, just enough to cover objects still on screen after passing.
// Both distances are exact multiples of PATH_STEP on purpose. The table
// index for a distance is (d + PATH_BEHIND) / PATH_STEP, so if PATH_BEHIND
// were not a whole number of steps the player's own sample would not land on
// an index and every position in the game would sit half a step up the
// track — subtle, uniform, and exactly the kind of thing that never looks
// like a bug, just like everything being slightly wrong.
// Far enough ahead that the end of the road is beyond every era's fogFar
// (the deepest is Rome's 225), so the ribbon fades into the haze instead of
// stopping in mid-air at a visible hard edge. 165 samples is ~330 vertices
// rewritten per frame — still nothing next to the scenery.
const PATH_AHEAD = 232;
const PATH_BEHIND = 16;
// 2 metres rather than 1.5: 125 samples instead of 165 for the same reach,
// which is a quarter off the per-frame path maths and off the road geometry,
// for a segment length still short enough that the road's edge reads as a
// curve rather than as a polygon through a corner.
const PATH_STEP = 2;
const PATH_SAMPLES = Math.round((PATH_BEHIND + PATH_AHEAD) / PATH_STEP) + 1;

// Corners are laid out deterministically from the era id, so a level has the
// same corners every time you play it. A runner you can learn is fairer than
// one that reshuffles under you, and it makes the layout reproducible in
// tests. Small, standard hash + PRNG rather than Math.random().
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// [{ start, end, dir }] in metres along the track; dir -1 = left, +1 = right.
// 2026-09-10 ("no end"): a run no longer stops at a fixed distance, so the
// corner table can no longer be built once up to a known `goal` — it is
// grown lazily instead, as far ahead of the player as CORNER_LOOKAHEAD
// needs, for as long as the run keeps going. The generator (cornerRng) and
// its running state (cornerD/cornerLastDir) persist between calls so the
// sequence is one continuous draw from the era's seed, not a series of
// independent ones — the same level still turns in the same places every
// time you play it, all the way out, however far that ends up being.
let corners = [];
let cornerRng = null;
let cornerD = 0;
let cornerLastDir = 1;

function resetCorners(eraId) {
  corners = [];
  if (!TERRAIN_ERA_IDS.has(eraId)) { cornerRng = null; return; }
  cornerRng = mulberry32(hashSeed(`motionquest:${eraId}`));
  cornerD = CORNER_FIRST_MIN + cornerRng() * 40;
  cornerLastDir = cornerRng() < 0.5 ? -1 : 1;
  extendCornersTo(CORNER_LOOKAHEAD);
}

function extendCornersTo(minDistance) {
  if (!cornerRng) return;
  while (cornerD + CORNER_ARC < minDistance) {
    // Mostly alternate. Always alternating reads as a metronome; never
    // alternating spirals off in one direction and every corner starts to
    // feel the same. Roughly three in four flips.
    const dir = cornerRng() < 0.72 ? -cornerLastDir : cornerLastDir;
    corners.push({ start: cornerD, end: cornerD + CORNER_ARC, dir });
    cornerLastDir = dir;
    cornerD += CORNER_ARC + CORNER_STRAIGHT_MIN + cornerRng() * (CORNER_STRAIGHT_MAX - CORNER_STRAIGHT_MIN);
  }
}

// Eased rather than a constant-radius arc: a real road corner turns in and
// out gradually (a transition curve), and easing the same way keeps the
// character from snapping into and out of the rotation.
function cornerEase(t) { return t * t * (3 - 2 * t); }

/** Absolute track heading in radians at distance `d`. Constant on straights. */
function headingAt(d) {
  if (!terrainActive()) return 0;
  let h = 0;
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    if (d <= c.start) break;
    const t = d >= c.end ? 1 : (d - c.start) / CORNER_ARC;
    h += c.dir * (Math.PI / 2) * cornerEase(t);
  }
  return h;
}

/** The next corner starting at or after `d`, or null if the level has none left. */
function nextCornerFrom(d) {
  for (let i = 0; i < corners.length; i++) {
    if (corners[i].end > d) return corners[i];
  }
  return null;
}

/** True when `d` sits inside a corner (plus a little margin either side). */
function insideCorner(d, margin = 6) {
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    if (d >= c.start - margin && d <= c.end + margin) return true;
    if (c.start - margin > d) break;
  }
  return false;
}

// 0 at the start of a level, 1 at the finish line. Still used by the hills.
function terrainRamp(distanceAlong) {
  const goal = currentEra().goal || 1;
  return THREE.MathUtils.clamp(distanceAlong / goal, 0, 1);
}

// Vertical offset (metres) of the ground at a point along it — hills and
// dips, unchanged from the 2026-09-08 pass, which was never the complaint.
// Kept as a plain function of absolute distance so the ground ribbon can
// sample it per vertex (it now genuinely rolls, rather than the whole flat
// plane tilting to the height under the player).
// 2026-09-10 ("characters disappear into the ground on hills and dips").
// Nothing was sinking — measured, obstacles sat exactly on the surface to
// the millimetre. The problem was OCCLUSION: with up to ~3.1m of relief
// packed into a few tens of metres, a crest between the camera and an
// obstacle 20-40m ahead hid its legs, or the whole thing. That reads
// exactly like the character sinking into the ground, and it is worse than
// cosmetic — it hides the thing the player is supposed to be reacting to.
//
// So the roll stays, at roughly half the height and stretched out longer.
// The short, choppy second wave is the part that did the hiding (a 84m
// wavelength puts a crest and a trough inside the reaction window), so it
// is both smaller and slower now. Line of sight to an obstacle's base is
// checked by mr_test_terrain_sight.js rather than by eye.
function hillOffset(distanceAlong) {
  if (!terrainActive()) return 0;
  const ramp = terrainRamp(distanceAlong);
  const amp = THREE.MathUtils.lerp(0.25, 0.75, ramp);
  const chaos = Math.max(0, ramp - 0.35) * (1 / 0.65);
  return (
    Math.sin(distanceAlong * THREE.MathUtils.lerp(0.011, 0.02, ramp) + 0.6) * amp +
    Math.sin(distanceAlong * 0.038 + 2.4) * chaos * 0.28
  );
}

// ---- The local path table -------------------------------------------
// Rebuilt once per frame (guarded on the player's distance, so calling it
// repeatedly within a frame is free) by integrating the unit heading vector
// along the track. Roughly 100 samples of trivial arithmetic — far cheaper
// than the per-object trig it replaces, and it makes every consumer a
// clamped table lookup.
const pathX = new Float32Array(PATH_SAMPLES);
const pathZ = new Float32Array(PATH_SAMPLES);
const pathYaw = new Float32Array(PATH_SAMPLES);
// Ground height, cached alongside. hillOffset() is two sines, and it was
// being called afresh for every road vertex AND every obstacle, pickup and
// prop, every frame — several hundred sines a frame to answer the same
// question at the same handful of distances.
const pathY = new Float32Array(PATH_SAMPLES);
let pathBase = NaN;

function rebuildPathTable(base) {
  if (base === pathBase) return;
  pathBase = base;
  const h0 = terrainActive() ? headingAt(base) : 0;
  const zeroIdx = Math.round(PATH_BEHIND / PATH_STEP); // index of the player

  // The player's own sample: origin, facing straight down -z by definition.
  pathX[zeroIdx] = 0; pathZ[zeroIdx] = 0; pathYaw[zeroIdx] = 0;
  pathY[zeroIdx] = hillOffset(base);

  // Forward. Heading is sampled at the middle of each step (midpoint rule),
  // which keeps the integrated path on the true curve through the corner
  // rather than cutting the inside of it.
  let x = 0, z = 0;
  for (let i = zeroIdx + 1; i < PATH_SAMPLES; i++) {
    const d = (i - zeroIdx) * PATH_STEP;
    const mid = base + d - PATH_STEP / 2;
    const th = (terrainActive() ? headingAt(mid) : 0) - h0;
    x += Math.sin(th) * PATH_STEP;
    z -= Math.cos(th) * PATH_STEP;
    pathX[i] = x; pathZ[i] = z;
    pathYaw[i] = (terrainActive() ? headingAt(base + d) : 0) - h0;
    pathY[i] = hillOffset(base + d);
  }
  // Backward, for the stretch of track already behind the player that is
  // still on screen.
  x = 0; z = 0;
  for (let i = zeroIdx - 1; i >= 0; i--) {
    const d = (i - zeroIdx) * PATH_STEP; // negative
    const mid = base + d + PATH_STEP / 2;
    const th = (terrainActive() ? headingAt(mid) : 0) - h0;
    x -= Math.sin(th) * PATH_STEP;
    z += Math.cos(th) * PATH_STEP;
    pathX[i] = x; pathZ[i] = z;
    pathYaw[i] = (terrainActive() ? headingAt(base + d) : 0) - h0;
    pathY[i] = hillOffset(base + d);
  }
}

// Scratch object — pathLocal() is called for every obstacle, pickup, prop
// and ribbon vertex every frame, and allocating a fresh {x,z,yaw} for each
// would hand the garbage collector thousands of objects a second on a
// device that really cannot afford it.
const pathOut = { x: 0, z: 0, yaw: 0, y: 0 };

/**
 * Where the track point `dAhead` metres in front of the player sits,
 * expressed relative to the player (origin, facing -z). Returns a SHARED
 * object: read it before the next call.
 */
function pathLocal(dAhead) {
  if (!terrainActive()) {
    pathOut.x = 0; pathOut.z = -dAhead; pathOut.yaw = 0; pathOut.y = 0;
    return pathOut;
  }
  const f = THREE.MathUtils.clamp((dAhead + PATH_BEHIND) / PATH_STEP, 0, PATH_SAMPLES - 1);
  const i = Math.min(PATH_SAMPLES - 2, Math.floor(f));
  const t = f - i;
  pathOut.x = pathX[i] + (pathX[i + 1] - pathX[i]) * t;
  pathOut.z = pathZ[i] + (pathZ[i + 1] - pathZ[i]) * t;
  pathOut.yaw = pathYaw[i] + (pathYaw[i + 1] - pathYaw[i]) * t;
  pathOut.y = pathY[i] + (pathY[i + 1] - pathY[i]) * t;
  return pathOut;
}

/**
 * Places `obj` on the track: `dAhead` metres along, `across` metres to the
 * right of the centre line (a lane offset), sitting `baseY` above the
 * ground. Also yaws it to face along the track, so a hurdle at a corner is
 * square to the road rather than to the world.
 *
 * Sign convention: at relative heading th the track's forward direction is
 * (sin th, 0, -cos th) and its right is (cos th, 0, sin th). A mesh whose
 * own forward is -z lines up with that when rotated by -th about y.
 */
function trackPos(obj, dAhead, across, baseY) {
  const p = pathLocal(dAhead);
  obj.position.x = p.x + Math.cos(p.yaw) * across;
  obj.position.z = p.z + Math.sin(p.yaw) * across;
  obj.position.y = baseY + p.y;
  return p;
}

/**
 * As trackPos, and also yaws the object to face along the track, so a hurdle
 * or a roadside column on a corner is square to the road rather than to the
 * world. `yawBase` preserves whatever rotation the object was built with —
 * several scenery makers give their props a random yaw, and overwriting it
 * would line every rock and bone up in the same direction.
 *
 * Not used for the spinning pickups or for punched obstacles tumbling
 * through the air: both animate rotation.y themselves, and this would fight
 * them for it.
 */
function placeOnTrack(obj, dAhead, across, baseY, yawBase = 0) {
  const p = trackPos(obj, dAhead, across, baseY);
  obj.rotation.y = yawBase - p.yaw;
}

// ---- The road itself -------------------------------------------------
// A 90-degree corner is the one thing the old single flat quad could never
// show: you cannot bend a rigid plane, which is why the previous pass had to
// settle for sliding and tilting it and calling that a turn. So the road is
// now a RIBBON — a strip of quads laid along the path, rebuilt from the path
// table every frame.
//
// It is much cheaper than it sounds. ~100 segments is ~200 vertices, i.e. a
// few hundred floats rewritten per frame, against a Fire TV Stick already
// drawing thousands of triangles of scenery. Rebuilding it in the player's
// own frame, rather than keeping one long static mesh and sliding it, also
// means the road is always exactly under the player with no world-space
// bookkeeping that can drift.
//
// Normals are left pointing straight up. The hills are gentle (about a metre
// of rise over tens of metres), so real per-vertex normals every frame would
// cost more than the shading difference is worth.
const ROAD_HALF_WIDTH = 7;      // matches the 14-wide plane it replaces
// How far the ground keeps going beyond the road. On a straight you never
// see past the edge of a 14-wide strip, because the road runs away to the
// horizon and fills the view — but on a 90-degree corner you are looking
// ACROSS the bend, and without this the road is a ribbon floating in open
// sky with nothing under it. The apron rides the same path and the same
// hills, so it fills the view at every point of the turn.
const APRON_HALF_WIDTH = 70;
// The shared road texture carries repeat.y = 60, so three multiplies our v
// by 60 before sampling. Dividing distance by 500 here therefore lands one
// texture tile every 500/60 = 8.33 metres — the same banding pitch, and so
// the same sense of speed, as the flat plane this replaces.
const ROAD_TEX_PERIOD = 500;
// Four across: apron edge, road edge, road edge, apron edge. The two apron
// vertices carry the same u as the road edge beside them (u = 0 and u = 1 are
// both verge in makeRoadTexture), so the apron is the verge colour and its
// banding lines up with the road's — no seam, and no second material.
const RIB_COLS = 4;
const RIB_VERTS = PATH_SAMPLES * RIB_COLS;
const ribbonPos = new Float32Array(RIB_VERTS * 3);
const ribbonUv = new Float32Array(RIB_VERTS * 2);
const ribbonNorm = new Float32Array(RIB_VERTS * 3);
const ribbonIdx = new Uint16Array((PATH_SAMPLES - 1) * (RIB_COLS - 1) * 6);
// Winding matters: within a sample the columns run left to right, and `b` is
// the same column one step further up the track. Wound the other way round
// the whole road faces DOWNWARD, gets back-face culled, and the player runs
// across an invisible surface over open sky — which is exactly what the
// first version of this did.
{
  let k = 0;
  for (let i = 0; i < PATH_SAMPLES - 1; i++) {
    for (let j = 0; j < RIB_COLS - 1; j++) {
      const a = i * RIB_COLS + j;
      const b = a + RIB_COLS;
      ribbonIdx[k++] = a; ribbonIdx[k++] = a + 1; ribbonIdx[k++] = b;
      ribbonIdx[k++] = a + 1; ribbonIdx[k++] = b + 1; ribbonIdx[k++] = b;
    }
  }
}
for (let i = 0; i < RIB_VERTS; i++) ribbonNorm[i * 3 + 1] = 1;

const ribbonGeo = new THREE.BufferGeometry();
ribbonGeo.setAttribute('position', new THREE.BufferAttribute(ribbonPos, 3));
ribbonGeo.setAttribute('uv', new THREE.BufferAttribute(ribbonUv, 2));
ribbonGeo.setAttribute('normal', new THREE.BufferAttribute(ribbonNorm, 3));
ribbonGeo.setIndex(new THREE.BufferAttribute(ribbonIdx, 1));
const roadRibbon = new THREE.Mesh(ribbonGeo, new THREE.MeshLambertMaterial({ map: roadTexture }));
// Regenerated in the player's own frame every frame, so three must never
// cull it against a bounding volume computed from an older shape.
roadRibbon.frustumCulled = false;
roadRibbon.visible = false;
scene.add(roadRibbon);

const RIB_ACROSS = [-APRON_HALF_WIDTH, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, APRON_HALF_WIDTH];
const RIB_U = [0, 0, 1, 1];

function updateRoadRibbon(base) {
  for (let i = 0; i < PATH_SAMPLES; i++) {
    const dAhead = i * PATH_STEP - PATH_BEHIND;
    const p = pathLocal(dAhead);
    // The track's right-hand direction here, so the ribbon's width stays
    // square to the road all the way through a corner. A strip laid out on a
    // fixed x axis would visibly shear as the road turned away from it.
    const rx = Math.cos(p.yaw), rz = Math.sin(p.yaw);
    const y = p.y;
    const v = (base + dAhead) / ROAD_TEX_PERIOD;
    for (let j = 0; j < RIB_COLS; j++) {
      const o = (i * RIB_COLS + j) * 3;
      const u = (i * RIB_COLS + j) * 2;
      ribbonPos[o] = p.x + rx * RIB_ACROSS[j];
      ribbonPos[o + 1] = y;
      ribbonPos[o + 2] = p.z + rz * RIB_ACROSS[j];
      ribbonUv[u] = RIB_U[j];
      ribbonUv[u + 1] = v;
    }
  }
  ribbonGeo.attributes.position.needsUpdate = true;
  ribbonGeo.attributes.uv.needsUpdate = true;
}

// Swaps the whole world over to an era: sky, fog, the three lights, the
// ground texture, the roadside scenery and the collectible colours. Called
// once when a level is chosen, never per frame.
function applyEra(id) {
  const era = ERA_BY_ID[id] ? id : 'present';
  currentEraId = era;
  const e = ERA_BY_ID[era];

  scene.background?.dispose?.();
  scene.background = makeSkyTexture(e.sky, e.glow);
  scene.fog = new THREE.Fog(e.fog, e.fogNear, e.fogFar);

  hemiLight.color.set(e.hemi[0]);
  hemiLight.groundColor.set(e.hemi[1]);
  hemiLight.intensity = e.hemi[2];
  sun.color.set(e.sun[0]);
  sun.intensity = e.sun[1];
  sun.position.set(e.sun[2][0], e.sun[2][1], e.sun[2][2]);
  rimLight.color.set(e.rim[0]);
  rimLight.intensity = e.rim[1];

  const oldTex = roadTexture;
  roadTexture = makeRoadTexture(e.ground);
  ground.material.map = roadTexture;
  ground.material.needsUpdate = true;
  roadRibbon.material.map = roadTexture;
  roadRibbon.material.needsUpdate = true;
  oldTex?.dispose();

  // This level's corners. Deterministic from the era id (see resetCorners),
  // so the same level always turns in the same places, however far the run
  // goes. The ribbon takes over from the flat plane wherever corners are
  // switched on — only one of the two is ever visible, or they would
  // z-fight along the whole road.
  resetCorners(era);
  pathBase = NaN; // force a path rebuild before the next frame draws
  roadRibbon.visible = terrainActive();
  ground.visible = !terrainActive();

  buildScenery(e.scenery);
  buildHorizon(era);
  audio.playMusic(era);

  coinMat.color.set(e.coin[0]);
  coinMat.emissive.set(e.coin[1]);
  gemMat.color.set(e.gem[0]);
  gemMat.emissive.set(e.gem[1]);
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
// Heart and star are little voxel sprites — a few boxes each, in the same
// blocky language as everything else. Geometry is shared per-part across
// every instance, same as the coin disc and gem octahedron above.
const HEART_PARTS = [
  [0.34, 0.30, 0.28, -0.18, 0.28],
  [0.34, 0.30, 0.28, 0.18, 0.28],
  [0.80, 0.34, 0.28, 0, 0.02],
  [0.52, 0.22, 0.28, 0, -0.24],
  [0.22, 0.20, 0.28, 0, -0.42],
];
const STAR_PARTS = [
  [0.42, 0.42, 0.22, 0, 0.04],
  [0.20, 0.34, 0.22, 0, 0.36],
  [0.34, 0.20, 0.22, -0.32, 0.08],
  [0.34, 0.20, 0.22, 0.32, 0.08],
  [0.18, 0.30, 0.22, -0.20, -0.30],
  [0.18, 0.30, 0.22, 0.20, -0.30],
];
const heartMat = new THREE.MeshLambertMaterial({ color: 0xff4d6d, emissive: 0x5c0f22 });
const starMat = new THREE.MeshLambertMaterial({ color: 0xffd93d, emissive: 0x6b5200 });
const heartGeos = HEART_PARTS.map(([w, h, d]) => new THREE.BoxGeometry(w, h, d));
const starGeos = STAR_PARTS.map(([w, h, d]) => new THREE.BoxGeometry(w, h, d));
function buildVoxelSprite(parts, geos, mat) {
  const g = new THREE.Group();
  parts.forEach(([, , , x, y], i) => {
    const m = new THREE.Mesh(geos[i], mat);
    m.position.set(x, y, 0);
    g.add(m);
  });
  return g;
}

const pickups = [];
// Only ever flipped by the test hook at the bottom of this file, so a test
// can place one known coin and watch what happens to it without the normal
// trail spawner dropping more into the scene mid-measurement.
let coinSpawnEnabled = true;
// Test-only, mirroring coinSpawnEnabled: lets a suite put ONE known obstacle
// on the track and watch what happens to it, instead of trying to pick it out
// of the run's own stream of them.
let obstacleSpawnEnabled = true;

// Per-era collectible models. The Rome panel in Don's artwork literally
// says "COLLECT MAGIC POTIONS", and the pack contains that potion; the
// future era gets its energy cell. Anywhere without a model kept the coin
// disc, which is why coins are still the fallback rather than being removed.
const ERA_COIN_MODEL = { rome: 'magic_potion', future: 'future_energy_cell' };

function makePickupMesh(kind) {
  if (kind === 'gem') return new THREE.Mesh(gemGeo, gemMat);
  if (kind === 'coin') {
    const modelName = ERA_COIN_MODEL[currentEraId];
    if (modelName) {
      const m = modelInstance(modelName);
      // Centred on the pickup's own origin: addPickup() positions these at
      // chest height, so a model sitting on its base would hang below the
      // point the player actually collects.
      if (m) { m.position.y = -0.4; const wrap = new THREE.Group(); wrap.add(m); return wrap; }
    }
  }
  if (kind === 'life') return buildVoxelSprite(HEART_PARTS, heartGeos, heartMat);
  if (kind === 'star') return buildVoxelSprite(STAR_PARTS, starGeos, starMat);
  // Coins are discs: stood upright facing back down the track so the player
  // sees a full circle coming at them, like a ring.
  const m = new THREE.Mesh(coinGeo, coinMat);
  m.rotation.x = Math.PI / 2;
  return m;
}

function addPickup(kind, lane, z) {
  const mesh = makePickupMesh(kind);
  mesh.position.x = LANE_X[lane];
  mesh.position.y = kind === 'gem' ? GEM_Y : COIN_Y;
  mesh.position.z = z;
  scene.add(mesh);
  pickups.push({ kind, lane, mesh, collected: false, trackZ: z });
}

// Hearts and stars pick a lane that isn't already occupied by an obstacle,
// the same way a coin trail does — a rare pickup buried inside a wall would
// be worse than no pickup at all.
function spawnSpecial(kind) {
  const lanes = [0, 1, 2].sort(() => Math.random() - 0.5);
  const lane = lanes.find((l) => !laneBlocked(l, SPAWN_Z, SPAWN_Z));
  if (lane === undefined) return false;
  addPickup(kind, lane, SPAWN_Z);
  return true;
}

function spawnGem(lane, z) {
  addPickup('gem', lane, z);
}

// True if any unresolved obstacle in `lane` overlaps the z-range a coin
// trail would occupy — so trails don't get buried inside a wall or crate.
function laneBlocked(lane, zStart, zEnd) {
  return obstacles.some((o) =>
    !o.flying && o.lane === lane && o.trackZ >= zStart - 3 && o.trackZ <= zEnd + 3);
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
// ---------------------------------------------------------------------
// The star (2026-09-04): ten seconds of invincible super-speed. Anything
// you touch is smashed out of the way and pays coins for it.
// ---------------------------------------------------------------------
function startStar() {
  const refreshing = state.starT > 0;
  state.starT = STAR_DURATION;
  starAura.visible = true;
  starTimerEl.style.display = 'block';
  hideActionPrompt(); // timing cues are meaningless while nothing can hit you
  popCombo(refreshing ? 'STAR REFILLED!' : '⭐ SUPER SPEED!');
}

function endStar() {
  state.starT = 0;
  starAura.visible = false;
  starTimerEl.style.display = 'none';
  camera.fov = BASE_FOV;
  camera.updateProjectionMatrix();
}

function updateStar(dt) {
  if (state.starT <= 0) return;
  state.starT = Math.max(0, state.starT - dt);
  if (state.starT === 0) { endStar(); popCombo('STAR OVER'); return; }
  // Cycle the aura's hue and pulse it, so "invincible" is unmistakable from
  // the sofa without touching the character's own colours.
  const t = state.starT;
  starAura.material.color.setHSL((performance.now() * 0.0012) % 1, 0.9, 0.6);
  starAura.material.opacity = 0.34 + Math.abs(Math.sin(t * 9)) * 0.22;
  // Ease the camera wider while boosting, and back on the way out.
  const targetFov = BASE_FOV * STAR_FOV_KICK;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 5);
  camera.updateProjectionMatrix();
  starTimerEl.textContent = `⭐ ${Math.ceil(state.starT)}`;
}

function updateActionPrompt(speed) {
  // Nothing can hit you during a star, so a "JUMP!"/"PUNCH!" cue would be
  // telling the player to react to something that no longer matters.
  if (state.starT > 0) { actionPromptEl.style.display = 'none'; return; }
  let target = null;
  let bestZ = -Infinity;
  for (const o of obstacles) {
    if (o.flying || o.resolved) continue;
    if (o.lane !== state.lane) continue;
    if (o.trackZ >= COLLISION_Z_MIN) continue;
    // Obstacles travel toward +z, so the largest z among candidates is the
    // one closest to the player right now.
    if (o.trackZ > bestZ) { bestZ = o.trackZ; target = o; }
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
  lives: START_LIVES,
  lane: 1,
  grounded: true,
  vy: 0,
  jumping: false,
  // Height above the LOCAL terrain, i.e. the pure jump arc with auto-terrain's
  // hill/dip offset never mixed in — player.position.y is derived from this
  // (see the bottom of updatePlaying), never the other way around, so a
  // grounded character can't silently accumulate the hill offset frame after
  // frame just because nothing resets player.position.y itself while grounded.
  jumpY: 0,
  punchTimer: 0,
  punchAnimTimer: 0, // cosmetic-only — see PUNCH_ANIM_DURATION above
  duckTimer: 0,      // seconds of duck left; > 0 clears a low bar
  invulnTimer: 0,
  starT: 0,            // seconds of star left; > 0 means invincible + boosted
  lifeSpawnTimer: 0,   // countdown to the next heart spawn attempt
  starSpawnTimer: 0,   // countdown to the next star spawn attempt
  spawnTimer: BASE_SPAWN_INTERVAL,
  coinTimer: 0.8,
  distance: 0,        // metres this run — drives the difficulty ramp
  runTime: 0,         // seconds of actual running, for the results breakdown
  coinsTaken: 0,      // collectibles picked up this run
  clears: 0,          // obstacles jumped, ducked or punched rather than hit
  unlockAnnounced: false, // has this run already shown its unlock toast
  distanceForTex: 0,
  countdownT: 0,      // seconds left on the pre-run countdown
  gameOverT: 0,       // seconds spent on the Run Over screen (auto-restart)
  turnEndT: 0,        // seconds spent on a multiplayer turn's result screen
  turnIntroT: 0,       // seconds spent on the "Player N's turn" screen
};

// =========================================================================
// MULTIPLAYER — up to 4 players, one phone each, taking turns at a time
// trial on the same level. Deliberately built as a thin layer on top of the
// existing single-player flow rather than a parallel mode: the level, the
// countdown, resetRun() and gameOver() are all exactly the
// same code a solo player uses — a "turn" is just one ordinary run, with
// bookkeeping before and after it to say whose run it was and what to do
// when it ends. Single-player is `roster.length <= 1`, in which case none
// of this engages and the game behaves exactly as it always has.
// =========================================================================
const PLAYER_META = [
  { name: 'Player 1', color: '#FF2D95' }, // magenta
  { name: 'Player 2', color: '#22D3EE' }, // cyan
  { name: 'Player 3', color: '#4ADE80' }, // mint
  { name: 'Player 4', color: '#FFD93D' }, // gold
];
function playerLabel(id) { return PLAYER_META[((id - 1) % 4 + 4) % 4] || PLAYER_META[0]; }

// Player ids (1-4) of every phone currently connected, kept in sync by the
// server's `roster` broadcasts (see server.js) — NOT the same as
// `controller_connected`'s count, which this still exists alongside since
// nothing else reads it.
let roster = [];

const TURN_INTRO_DELAY = 1.8;   // seconds shown on "Player N's turn" before the countdown
const TURN_END_AUTO_DELAY = 3.2; // seconds a per-turn result screen waits before auto-advancing

const multiplayer = {
  active: false,
  order: [],     // player ids, in turn order, fixed for the whole game
  index: 0,      // whose turn is current — order[index]
  results: [],   // {id, name, color, finished, time, distance, score}
  // True when there are more players than phones, i.e. they are sharing.
  // The turn structure is identical either way; what changes is that input
  // is no longer matched to a specific phone, and the turn intro tells them
  // to hand it over.
  sharing: false,
};

// =====================================================================
// HOW MANY PEOPLE ARE PLAYING (2026-09-10)
//
// "Players should only need one phone to play." Multiplayer used to be
// inferred purely from how many phones were connected — two phones meant a
// two-player game, one phone meant solo, and a family with one phone between
// them simply could not play together.
//
// So the party size is now something the room states outright, from 1 to 4,
// independently of how many phones are in the room. With fewer phones than
// players it becomes a pass-the-phone game: same turns, same leaderboard,
// the phone just changes hands between them.
// =====================================================================
const MAX_PARTY = 4;
let partySize = 1;
// Cleared once the player has chosen for themselves, so the default tracking
// the roster never fights a deliberate choice.
let partySizeChosen = false;

function setPartySize(n) {
  const next = THREE.MathUtils.clamp(Math.round(n), 1, MAX_PARTY);
  if (next === partySize) return;
  partySize = next;
  partySizeChosen = true;
  renderParty();
  renderReadyHint();
  renderPartyHint();
}

/** Keeps the default in step with the phones present, until someone chooses. */
function syncPartyToRoster() {
  if (partySizeChosen) return;
  partySize = Math.max(1, Math.min(MAX_PARTY, roster.length));
  renderParty();
}

function renderParty() {
  let html = '';
  for (let i = 1; i <= MAX_PARTY; i++) {
    html += `<span class="party-chip${i === partySize ? ' on' : ''}">${i}</span>`;
  }
  if (partyChipsEl) partyChipsEl.innerHTML = html;
  if (partyChipsLevelEl) partyChipsLevelEl.innerHTML = html;
}

function resetMultiplayer() {
  multiplayer.active = false;
  multiplayer.order = [];
  multiplayer.index = 0;
  multiplayer.results = [];
  multiplayer.sharing = false;
}

// Called once, at the moment a level is actually chosen — the natural point
// a "game" begins, whether that's one player or four. Locks in the turn
// order for the whole session; players who join mid-game join the NEXT one.
function beginMultiplayerIfNeeded() {
  // The party size is what decides this now, not the phone count. With a
  // phone each, turn order follows the roster so every player keeps their own
  // device and colour; with fewer phones than players the order is just the
  // player slots 1..n and the phone is passed along them.
  const size = Math.max(partySize, roster.length >= 2 ? roster.length : 1);
  if (size >= 2) {
    multiplayer.active = true;
    multiplayer.sharing = roster.length < size;
    multiplayer.order = multiplayer.sharing
      ? Array.from({ length: size }, (_, i) => i + 1)
      : roster.slice().sort((a, b) => a - b);
    multiplayer.index = 0;
    multiplayer.results = [];
  } else {
    resetMultiplayer();
  }
}

function activePlayerId() {
  return multiplayer.active ? multiplayer.order[multiplayer.index] : null;
}

function recordTurnResult(finished) {
  const id = activePlayerId();
  if (id == null) return;
  const label = playerLabel(id);
  multiplayer.results.push({
    id, name: label.name, color: label.color,
    finished, time: finished ? state.runTime : null,
    distance: Math.floor(state.distance), score: Math.floor(state.score),
  });
}

// Ranks finishers by time (fastest first), then anyone who didn't finish by
// how far they got — a DNF still has a placing, it's just not a time.
function rankedResults() {
  return multiplayer.results.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.time - b.time;
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    return b.distance - a.distance;
  });
}

function showTurnIntro() {
  state.phase = 'turnIntro';
  state.turnIntroT = 0;
  const id = activePlayerId();
  const label = playerLabel(id);
  if (turnIntroTitle) turnIntroTitle.textContent = `${label.name}'s turn`;
  if (turnIntroCallout) {
    // On a shared phone the handover IS the instruction, so it goes first and
    // in place of the generic "get ready" — nobody can start until the right
    // person is holding it.
    turnIntroCallout.textContent = multiplayer.sharing && multiplayer.index > 0
      ? `📱 Pass the phone to ${label.name} — turn ${multiplayer.index + 1} of ${multiplayer.order.length}`
      : `Turn ${multiplayer.index + 1} of ${multiplayer.order.length} — get ready!`;
  }
  if (turnIntroSwatch) turnIntroSwatch.style.setProperty('--slot-color', label.color);
  hideActionPrompt();
  hideCountdown();
  syncPanel();
}

function showLeaderboard() {
  state.phase = 'leaderboard';
  if (leaderboardList) {
    const ranked = rankedResults();
    leaderboardList.innerHTML = ranked.map((r, i) => `
      <div class="leaderboard-row${i === 0 ? ' winner' : ''}">
        <span class="leaderboard-rank">${i + 1}</span>
        <span class="leaderboard-swatch" style="--slot-color:${r.color}"></span>
        <span class="leaderboard-name">${r.name}</span>
        <span class="leaderboard-time${r.finished ? '' : ' dnf'}">${r.finished ? formatTime(r.time) : `${r.distance} m`}</span>
      </div>
    `).join('');
  }
  hideActionPrompt();
  hideCountdown();
  syncPanel();
}

// Called once a turn's result screen (gameover — the only way a turn ends
// now) is done — either the timer ran out or someone pressed the button
// early. Moves to the next player, or to the leaderboard if that was the
// last one.
function advanceMultiplayerTurn() {
  if (!multiplayer.active) return;
  multiplayer.index += 1;
  if (multiplayer.index >= multiplayer.order.length) {
    showLeaderboard();
  } else {
    showTurnIntro();
  }
}

// Leaving the leaderboard (or cancelling mid-game via Back) always returns
// to the era picker — a new game means picking again, even if it'll just be
// the same era and the same players.
function endMultiplayer() {
  resetMultiplayer();
  openLevelSelect();
}

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
const roomCodeMiniEl = document.getElementById('roomCodeMini');
const playUrlEl = document.getElementById('playUrl');
const joinQrEl = document.getElementById('joinQr');
const pairingHint = document.getElementById('pairingHint');
const rosterRowEl = document.getElementById('rosterRow');
const movesStripEl = document.getElementById('movesStrip');
const readyJoinHintEl = document.getElementById('readyJoinHint');
const readyStartHintEl = document.getElementById('readyStartHint');
const partyChipsEl = document.getElementById('partyChips');
const partyChipsLevelEl = document.getElementById('partyChipsLevel');
const turnIntroPanel = document.getElementById('turnIntroPanel');
const turnIntroTitle = document.getElementById('turnIntroTitle');
const turnIntroCallout = document.getElementById('turnIntroCallout');
const turnIntroSwatch = document.getElementById('turnIntroSwatch');
const leaderboardPanel = document.getElementById('leaderboardPanel');
const leaderboardList = document.getElementById('leaderboardList');
const comboEl = document.getElementById('combo');
const flashEl = document.getElementById('flash');
const finalScoreEl = document.getElementById('finalScore');
const actionPromptEl = document.getElementById('actionPrompt');
const starTimerEl = document.getElementById('starTimer');

function renderLives() {
  livesEl.innerHTML = '';
  // Grows past the starting three as extra hearts are collected, rather
  // than always drawing MAX_LIVES slots — five outlines at the start of a
  // run would read as "you have already lost two".
  const slots = Math.max(START_LIVES, state.lives);
  for (let i = 0; i < slots; i++) {
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

const levelSelectPanel = document.getElementById('levelSelectPanel');
const levelGridEl = document.getElementById('levelGrid');
const eraBadge = document.getElementById('eraBadge');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const unlockToastEl = document.getElementById('unlockToast');

const PANELS = {
  pairing: pairingPanel,
  ready: readyPanel,
  gameover: gameOverPanel,
  paused: pausedPanel,
  calibrating: calibrationPanel,
  placement: placementPanel,
  framing: framingPanel,
  levelSelect: levelSelectPanel,
  turnIntro: turnIntroPanel,
  leaderboard: leaderboardPanel,
};

// ---------------------------------------------------------------------
// Control badge — a small persistent "what do I use right now?" pill so
// it's obvious at every stage, not just the first one, whether the Fire TV
// remote or the phone is what drives the current screen. Shown for every
// non-playing stage; hidden once a run is actually in progress (input is
// coming from the phone continuously at that point, no ambiguity).
//
// 2026-09-10 ("the setup menus are unclear"): placement and framing used to
// just say WHICH device to use ("Use your Fire TV remote") without saying
// what to actually do with it — the one on-screen line that did say
// ("Step back, then press OK") was accidentally left screen-reader-only,
// i.e. invisible, on the placement screen. This badge is the one thing
// guaranteed to be on screen at every setup stage, so it now carries the
// real instruction itself rather than just naming the input device. It
// also gets a "Setup N/4" prefix on the four setup screens specifically
// (see SETUP_STEP_OF_4) — the art behind Ready/Placement draws that same
// 4-step timeline, but only for those two; the badge now keeps it going
// through Framing and Calibration too, where the art doesn't.
// ---------------------------------------------------------------------
const CONTROL_BADGE_TEXT = {
  pairing: { text: '📱 Use your phone to join', cls: 'phone' },
  ready: { text: '🎮 Remote OK, or 📱 jump/punch, to start', cls: 'remote' },
  placement: { text: '🎮 Step back, then press OK', cls: 'remote' },
  framing: { text: '🎮 Get in frame — press OK to skip ahead', cls: 'remote' },
  calibrating: { text: '📱 Copy the moves · 🎮 OK to start', cls: 'phone' },
  paused: { text: '🎮 Remote OK to resume, Back to exit', cls: 'remote' },
  gameover: { text: '🎮 Remote OK to retry · Back for levels', cls: 'remote' },
  levelSelect: { text: '🎮 ◀ ▶ to choose · OK to travel', cls: 'remote' },
  turnIntro: null, // no input needed — see TURN_INTRO_DELAY
  leaderboard: { text: '🎮 Remote OK to continue', cls: 'remote' },
};
// The four setup stages, in order, so the badge can say "Setup 2/4" etc.
// Kept separate from CAL_ORDER (the four MOVES inside the calibrating
// stage) precisely so the two "step 1 of 4" ideas never collide again.
const SETUP_STEP_OF_4 = { ready: 1, placement: 2, framing: 3, calibrating: 4 };

function updateControlBadge(stageKey) {
  const meta = CONTROL_BADGE_TEXT[stageKey];
  // The badge is a fixed pill near the top of the screen and the panels are
  // vertically centred, so on a tall panel (the calibration one especially)
  // the two used to collide — the pill sat right on top of the panel's
  // heading. Panels get nudged down while a badge is showing; see
  // `body.badge-visible .overlay-panel` in index.html.
  document.body.classList.toggle('badge-visible', !!meta);
  if (!meta) { controlBadge.style.display = 'none'; return; }
  const step = SETUP_STEP_OF_4[stageKey];
  controlBadge.textContent = step ? `Setup ${step}/4 · ${meta.text}` : meta.text;
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
  // A run in progress outranks any setup stage (2026-09-09). Setup panels
  // used to sit above everything except the countdown, so a second player
  // starting setup on their phone mid-run — or a stale placement message
  // arriving late — painted a full-screen "place your phone" panel over a
  // live game. Their setup is still tracked underneath; it just waits for a
  // screen it can legitimately have.
  if (inRun) {
    if (state.phase === 'paused') { showPanel('paused'); updateControlBadge('paused'); }
    else { showPanel(null); updateControlBadge(null); }
    return;
  }
  if (setupStage === 'placement') { showPanel('placement'); updateControlBadge('placement'); return; }
  if (setupStage === 'framing') { showPanel('framing'); updateControlBadge('framing'); return; }
  if (calibrating) { showPanel('calibrating'); updateControlBadge('calibrating'); return; }
  if (state.phase === 'pairing') { showPanel('pairing'); updateControlBadge('pairing'); }
  else if (state.phase === 'levelSelect') { showPanel('levelSelect'); updateControlBadge('levelSelect'); }
  else if (state.phase === 'ready') { showPanel('ready'); updateControlBadge('ready'); }
  else if (state.phase === 'paused') { showPanel('paused'); updateControlBadge('paused'); }
  else if (state.phase === 'gameover') { showPanel('gameover'); updateControlBadge('gameover'); }
  else if (state.phase === 'turnIntro') { showPanel('turnIntro'); updateControlBadge('turnIntro'); }
  else if (state.phase === 'leaderboard') { showPanel('leaderboard'); updateControlBadge('leaderboard'); }
  else { showPanel(null); updateControlBadge(null); }
}

// Four slots, filled in join order — this is the only place the game shows
// "who's connected" before a run starts. Re-rendered on every `roster`
// message from the server (see the WebSocket handler below).
function renderRoster() {
  if (!rosterRowEl) return;
  rosterRowEl.innerHTML = PLAYER_META.map((meta, i) => {
    const id = i + 1;
    const filled = roster.includes(id);
    return `<span class="roster-slot${filled ? ' filled' : ''}" style="--slot-color:${meta.color}">${filled ? id : ''}</span>`;
  }).join('');
  if (readyJoinHintEl) {
    readyJoinHintEl.style.display = roster.length >= 4 ? 'none' : 'block';
  }
}

// Replaces the old "step left/right, jump, duck, punch" sentence on the
// Ready screen with one tile per move, built from the same CAL_META the
// guided setup uses — left/right share a tile since they're one skill
// ("move sideways"), not two.
function renderMovesStrip() {
  if (!movesStripEl) return;
  const tiles = [
    { icon: '⬅️➡️', label: 'Move' },
    { icon: CAL_META.jump.icon, label: 'Jump' },
    { icon: CAL_META.duck.icon, label: 'Duck' },
    { icon: CAL_META.punch.icon, label: 'Punch' },
  ];
  movesStripEl.innerHTML = tiles.map((t) => `
    <div class="move-tile"><div class="move-icon">${t.icon}</div><span class="move-label">${t.label}</span></div>
  `).join('');
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

// =========================================================================
// WHO HAS ACTUALLY FINISHED SETUP (2026-09-09)
//
// "Sometimes it doesn't set up before starting the game." The cause was
// that the TV had no memory of setup at all: `setupStage` and `calibrating`
// were transient UI state, thrown away the moment a panel closed, and
// nothing anywhere recorded that a given player had been through placement,
// framing and the five moves.
//
// Meanwhile the ready screen invites a start ("Press OK on your remote, or
// tap Jump/Punch on your phone") from the instant a phone's WebSocket
// connects — which happens before the player has even chosen a control mode,
// let alone set the phone down and stepped back. Press OK there and
// startCountdown() ran happily with no setup whatsoever. Whether you got set
// up came down to whether you happened to press OK before or after working
// through your phone, which is exactly the "sometimes" in the report.
//
// So completion is now recorded per player id and the start is gated on it.
// Two deliberate escape hatches keep this from ever being a trap: pressing
// OK a second time starts anyway, and a player who disconnects stops being
// something the room waits for.
// =========================================================================
const setupDonePlayers = new Set();
// Set when a start was refused for want of setup; a second press inside this
// window goes ahead regardless.
let startOverrideUntil = 0;
const START_OVERRIDE_WINDOW_MS = 6000;

/** Connected players who have not yet finished setting their phone up. */
function playersNotSetUp() {
  return roster.filter((id) => !setupDonePlayers.has(id));
}

/**
 * True when a run may begin. An empty roster falls through to the existing
 * pairing handling rather than being treated as "everyone is ready".
 */
function everyoneSetUp() {
  return roster.length > 0 && playersNotSetUp().length === 0;
}

/**
 * The gate itself. Returns true if the caller should go ahead and start.
 * Refusing once puts the ready screen into "still setting up" mode and arms
 * the override, so the second press always gets through — a phone that
 * crashed mid-setup, or a player who genuinely wants to use the remote
 * only, can never leave the room stuck on a screen it can't leave.
 */
function mayStartRun() {
  if (everyoneSetUp()) return true;
  const now = performance.now();
  if (startOverrideUntil && now < startOverrideUntil) {
    startOverrideUntil = 0;
    return true;
  }
  startOverrideUntil = now + START_OVERRIDE_WINDOW_MS;
  renderReadyHint();
  return false;
}

/** Forgets a player's setup once they drop, so the room stops waiting. */
function forgetDisconnectedSetup() {
  for (const id of Array.from(setupDonePlayers)) {
    if (!roster.includes(id)) setupDonePlayers.delete(id);
  }
}

/**
 * The ready screen's bottom line. Three states, because the honest answer to
 * "can I start?" is genuinely different in each: everyone's ready, someone
 * is still setting up, or you've asked twice and we'll take your word for it.
 */
function renderReadyHint() {
  if (!readyStartHintEl) return;
  const waiting = playersNotSetUp();
  if (waiting.length === 0) {
    // With more players than phones, say up front that it is a pass-the-phone
    // game — otherwise the first handover is a surprise mid-game.
    const sharing = partySize > Math.max(1, roster.length);
    readyStartHintEl.textContent = partySize > 1
      ? (sharing
          ? `🎮 ◀ ▶ sets players · ${partySize} taking turns, passing the phone · OK to start`
          : `🎮 ◀ ▶ sets players · ${partySize} with a phone each · OK to start`)
      : '🎮 ◀ ▶ sets players · Press OK on your remote (or tap Jump/Punch on your phone) to start';
    return;
  }
  const who = waiting.length === 1
    ? `${playerLabel(waiting[0]).name} is`
    : `${waiting.length} players are`;
  // Even the override message names who is being waited for. A bare "press
  // OK again to start anyway" answers the wrong question: the player pressed
  // OK expecting a run and needs to know what stopped it, not just how to
  // insist. Saying both means the skip is an informed choice.
  if (startOverrideUntil && performance.now() < startOverrideUntil) {
    readyStartHintEl.textContent = `📱 ${who} still setting up — press OK again to start anyway`;
    return;
  }
  readyStartHintEl.textContent = `📱 ${who} still setting up — finish on the phone, then press OK`;
}

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
    ? 'Press OK, or hold still…'
    : 'Stand 2–3m back · press OK when set';
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
// Duck joins the guided setup (2026-09-04) rather than being sprung on the
// player mid-run: it's the move whose detection is easiest to get wrong in
// an unfamiliar room, so it's worth confirming it reads at all before the
// first low bar arrives at speed.
const CAL_ORDER = ['left', 'right', 'jump', 'duck', 'punch'];
const CAL_META = {
  left: { icon: '⬅️', textCamera: 'Step LEFT', textHold: 'Lean LEFT' },
  right: { icon: '➡️', textCamera: 'Step RIGHT', textHold: 'Lean RIGHT' },
  jump: { icon: '⬆️', textCamera: 'JUMP', textHold: 'JUMP' },
  duck: { icon: '⬇️', textCamera: 'DUCK down', textHold: 'DUCK down' },
  punch: { icon: '👊', textCamera: 'PUNCH', textHold: 'PUNCH' },
};
// Decays after every landing to drive the touchdown squash — see the
// squash-and-stretch block in updatePlaying().
let landSquash = 0;
let calibrating = false;
// Counts down once the last calibration move is done, then finishes setup
// on its own — see advanceCalibrationUI()/finishSetupFromTv().
let calAutoFinishT = 0;
const CAL_AUTO_FINISH_DELAY = 1.6; // seconds of "All set!" before starting
let calMode = 'camera';
let calIndex = 0;
// Derived from CAL_ORDER, never written out separately — see the note on
// the reset in startCalibrationUI() for what a hand-maintained copy costs.
let calDone = Object.fromEntries(CAL_ORDER.map((k) => [k, false]));

// 2026-09-03 styling pass: chunky numbered tiles rather than three
// near-identical emoji circles, so "done", "doing now" and "still to come"
// read as three obviously different things from across a room. Styling
// lives in index.html (.cal-tile); this only decides which class each
// step gets.
function renderCalDots() {
  calDots.innerHTML = CAL_ORDER.map((key, i) => {
    const cls = calDone[key] ? 'done' : i === calIndex ? 'current' : 'todo';
    const label = calDone[key] ? '✓' : String(i + 1);
    return `<span class="cal-tile ${cls}">${label}</span>`;
  }).join('');
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
  // "Move" rather than "Step" — Setup 4/4 (the control badge, above) already
  // owns "step" for the four setup STAGES; reusing it here for the four
  // calibration MOVES was the exact ambiguity that made this screen read as
  // "back to setup stage 1" instead of "the first of four moves".
  calStepCounter.textContent = `Move ${calIndex + 1} of ${CAL_ORDER.length}`;
  renderCalDots();
  requestCalStepOnPhone();
}
function startCalibrationUI(mode) {
  calibrating = true;
  calAutoFinishT = 0;
  setupStage = 'none'; // placement/framing are done — the per-move panel takes over
  calMode = mode || 'camera';
  calIndex = 0;
  // Built from CAL_ORDER rather than written out again. This literal was
  // missed when duck was added to CAL_ORDER, and since advanceCalibrationUI()
  // bails on `!(step in calDone)`, setup silently stuck on the duck step with
  // no way past it. Deriving it makes that class of drift impossible.
  calDone = Object.fromEntries(CAL_ORDER.map((k) => [k, false]));
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
/**
 * @param {number|undefined} playerId who finished, from the server's stamp on
 *   the relayed `calibration` message. Undefined only for an old phone build
 *   or a hand-crafted message, in which case every connected player is
 *   credited — the pre-2026-09-09 behaviour, which is the safe fallback since
 *   it can only ever unblock a start, never wrongly block one.
 */
function markSetupDone(playerId) {
  if (typeof playerId === 'number') setupDonePlayers.add(playerId);
  else roster.forEach((id) => setupDonePlayers.add(id));
  startOverrideUntil = 0;
  renderReadyHint();
}

function finishCalibrationUI(playerId) {
  markSetupDone(playerId);
  calibrating = false;
  calAutoFinishT = 0;
  setupStage = 'none'; // covers the "Skip setup" escape hatch firing mid-placement/framing
  // 2026-09-03 ("you still need to press start on the phone"): finishing
  // setup IS the start signal. Nothing further is required from the player.
  // 2026-09-04: it now opens the era picker rather than launching straight
  // into a run — with four levels there is a genuine choice to make, and
  // the countdown still gives them time to put the phone down once they've
  // made it. One button press, not a menu to wade through.
  // 2026-09-09: with more than one phone in the room this now waits for the
  // rest of them. Rolling on to the era picker the moment the FIRST player
  // finished was the multiplayer half of "it didn't set up before starting" —
  // players two and three were still on the placement step when the picker
  // took the screen away from them.
  if ((state.phase === 'ready' || state.phase === 'pairing') && everyoneSetUp()) {
    openLevelSelect();
    return;
  }
  if (state.phase === 'pairing' && roster.length > 0) state.phase = 'ready';
  renderReadyHint();
  syncPanel();
}

// =========================================================================
// LEVEL SELECT AND PROGRESSION (2026-09-04)
//
// Stored on the TV, not the phone, and for the same reason the high score
// is (see HIGH_SCORE_KEY): a Fire TV is a shared family device and "which
// eras has this household reached" belongs to the telly, not to whoever
// happened to be holding a phone. Different kids can play on different
// phones without resetting each other's progress.
//
// Only the first era is unlocked on a fresh install; finishing one unlocks
// the next. Everything degrades to "just the first era, no memory" if
// localStorage is unavailable rather than breaking the menu.
// =========================================================================
const PROGRESS_KEY = 'motionquest_progress';
let progressCache = null;

function loadProgress() {
  if (progressCache) return progressCache;
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null');
  } catch { data = null; }
  const known = ERAS.map((e) => e.id);
  const unlocked = Array.isArray(data?.unlocked)
    ? data.unlocked.filter((id) => known.includes(id))
    : [];
  // The first era is always available — otherwise a corrupted save would
  // leave the player staring at four locked tiles and no way in.
  if (!unlocked.includes(ERAS[0].id)) unlocked.unshift(ERAS[0].id);
  progressCache = { unlocked, best: (data && typeof data.best === 'object' && data.best) || {} };
  return progressCache;
}

function saveProgress(p) {
  progressCache = p;
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* private mode — session only */ }
}

function isUnlocked(id) { return loadProgress().unlocked.includes(id); }

// Unlocks whatever comes after `id` in the timeline. Returns the era that
// was newly opened, or null if there was nothing new (last era, or already
// unlocked from a previous playthrough).
function unlockNextAfter(id) {
  const idx = ERAS.findIndex((e) => e.id === id);
  const next = ERAS[idx + 1];
  if (!next) return null;
  const p = loadProgress();
  if (p.unlocked.includes(next.id)) return null;
  p.unlocked.push(next.id);
  saveProgress(p);
  return next;
}

function recordBest(id, score) {
  const p = loadProgress();
  if (!p.best[id] || score > p.best[id]) {
    p.best[id] = Math.floor(score);
    saveProgress(p);
  }
}

let levelSelectIndex = 0;

function renderPartyHint() {
  const el = document.getElementById('levelSelectPanel');
  if (!el) return;
  const hint = el.querySelector('p.hint');
  if (!hint) return;
  const sharing = partySize > Math.max(1, roster.length);
  hint.textContent = partySize > 1
    ? (sharing
        ? `🎮 ◀ ▶ picks a level · ${partySize} players taking turns, passing the phone`
        : `🎮 ◀ ▶ picks a level · ${partySize} players, a phone each`)
    : '🎮 ◀ ▶ + OK · 📱 step + jump — either picks a level';
}

function renderLevelSelect() {
  if (!levelGridEl) return;
  const p = loadProgress();
  levelGridEl.innerHTML = '';
  ERAS.forEach((era, i) => {
    const locked = !p.unlocked.includes(era.id);
    const card = document.createElement('div');
    card.className = 'level-card'
      + (i === levelSelectIndex ? ' selected' : '')
      + (locked ? ' locked' : '');
    card.dataset.era = era.id;
    const best = p.best[era.id];
    card.innerHTML = `
      <div class="level-icon">${locked ? '🔒' : era.icon}</div>
      <div class="level-name">${era.name}</div>
      <div class="level-sub">${locked ? 'Unlock the era before' : era.sub}</div>
      <div class="level-meta">${locked ? '' : (best ? `Best ${best}` : `${era.goal}m unlocks next era`)}</div>
    `;
    levelGridEl.appendChild(card);
  });
}

function openLevelSelect() {
  const p = loadProgress();
  // Land the cursor on the furthest era they can actually play — after
  // finishing Rome, the menu should be offering Present Day, not making
  // them scroll past two they've already beaten.
  let idx = 0;
  ERAS.forEach((e, i) => { if (p.unlocked.includes(e.id)) idx = i; });
  levelSelectIndex = idx;
  state.phase = 'levelSelect';
  hideCountdown();
  hideActionPrompt();
  renderLevelSelect();
  // The party chips and the hint live on this panel too, and a player who
  // never touches up/down would otherwise see whatever they said last time.
  renderParty();
  renderPartyHint();
  syncPanel();
}

function moveLevelSelection(dir) {
  if (state.phase !== 'levelSelect') return;
  levelSelectIndex = Math.max(0, Math.min(ERAS.length - 1, levelSelectIndex + dir));
  renderLevelSelect();
}

function chooseLevel() {
  if (state.phase !== 'levelSelect') return;
  const era = ERAS[levelSelectIndex];
  if (!era || !isUnlocked(era.id)) {
    // Shake the locked card rather than silently doing nothing, so it's
    // clear the button worked and the level didn't.
    const card = levelGridEl?.children[levelSelectIndex];
    if (card) { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
    return;
  }
  beginMultiplayerIfNeeded();
  applyEra(era.id);
  updateEraBadge();
  if (multiplayer.active) showTurnIntro();
  else startCountdown();
}

const muteBtn = document.getElementById('muteBtn');
const soundHintEl = document.getElementById('soundHint');
const turnSignEl = document.getElementById('turnSign');
const turnSignArrowEl = document.getElementById('turnSignArrow');

// Puts up the "bend ahead" sign while a corner is coming, and takes it down
// once the player is into it. Only while actually running: on the menus the
// distance isn't moving and a permanent sign would just be furniture.
// Guarded writes, so a frame in which nothing changed costs two comparisons.
let turnSignDir = 0;
function updateTurnSign() {
  if (!turnSignEl) return;
  let dir = 0;
  if (terrainActive() && state.phase === 'playing') {
    const c = nextCornerFrom(state.distance);
    // Shown from CORNER_WARN_DISTANCE out, and dropped once the turn is
    // properly under way — by then the road is doing the telling.
    if (c && state.distance > c.start - CORNER_WARN_DISTANCE
        && state.distance < c.start + CORNER_ARC * 0.4) {
      dir = c.dir;
    }
  }
  if (dir === turnSignDir) return;
  turnSignDir = dir;
  turnSignEl.style.display = dir === 0 ? 'none' : 'flex';
  if (dir !== 0 && turnSignArrowEl) turnSignArrowEl.textContent = dir < 0 ? '↰' : '↱';
}

// Shows "press OK for sound" only while the browser is actually refusing to
// start the music (2026-09-09 — see tryStartMusic() in audio.js for why that
// happens at all). Polled from the frame loop rather than pushed, because the
// block clears asynchronously from inside a play() promise; the DOM write is
// guarded so this is a property read per frame in the normal case.
let soundHintShown = false;
function updateSoundHint() {
  if (!soundHintEl) return;
  const blocked = audio.isMusicBlocked();
  if (blocked === soundHintShown) return;
  soundHintShown = blocked;
  soundHintEl.style.display = blocked ? 'flex' : 'none';
}

function setMuted(isMuted) {
  if (!muteBtn) return;
  muteBtn.textContent = isMuted ? '🔇' : '🔊';
  muteBtn.classList.toggle('muted', isMuted);
}
if (muteBtn) {
  setMuted(audio.isMuted());
  muteBtn.addEventListener('click', () => { audio.unlock(); setMuted(audio.toggleMute()); });
}

function updateEraBadge() {
  if (!eraBadge) return;
  const e = currentEra();
  eraBadge.textContent = `${e.icon} ${e.name}`;
}

// The distance bar in the HUD. 2026-09-10 ("no end"): once the unlock
// threshold is passed the bar has nothing left to fill towards, so it
// holds full and gold rather than sitting at a permanently-maxed-out
// "100%" that invites the question of why the run hasn't stopped.
function updateProgressBar() {
  if (!progressFill) return;
  const goal = currentEra().goal;
  const past = state.distance >= goal;
  const pct = past ? 1 : Math.max(0, state.distance / goal);
  progressFill.style.width = `${(pct * 100).toFixed(1)}%`;
  progressFill.classList.toggle('endless', past);
  if (progressLabel) {
    progressLabel.textContent = past
      ? `${Math.floor(state.distance)} m · endless`
      : `${Math.floor(state.distance)} / ${goal} m`;
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// =====================================================================
// UNLOCKING THE NEXT ERA MID-RUN (2026-09-10)
//
// "No end, but tell the player when the next level is unlocked." Reaching
// an era's `goal` used to stop the run and show a whole results screen
// (levelComplete()); now the run doesn't stop for anything but running out
// of hearts, so this just banks the unlock and puts up a toast — the game
// underneath keeps playing, and keeps getting harder, right through it.
// =====================================================================
function announceUnlock() {
  // The run keeps going right through this — a player's turn (solo or
  // multiplayer) still only ends at gameOver(), which is where the score
  // and unlock get their final, one-time recording.
  const era = currentEra();
  const opened = unlockNextAfter(era.id);
  if (!opened) return; // last era already reached on a previous run
  audio.sfx('star');
  showUnlockToast(`🔓 ${opened.icon} ${opened.name} unlocked!`);
  renderLevelSelect(); // so the picker reflects it immediately if paused into
}

function showUnlockToast(text) {
  if (!unlockToastEl) return;
  unlockToastEl.textContent = text;
  unlockToastEl.classList.add('show');
  clearTimeout(showUnlockToast._t);
  showUnlockToast._t = setTimeout(() => unlockToastEl.classList.remove('show'), 3200);
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

// =====================================================================
// THE FINISH LINE (2026-09-04)
//
// Until the model pack arrived, reaching an era's goal simply switched the
// screen — the finish existed as a number on a progress bar and nothing
// else. Don's time_portal model gives it a physical presence: it appears
// down the track once you are close, grows as you approach, and you run
// through it. That is also the game's title doing some work — you are not
// finishing a level, you are stepping through time to the next era.
//
// Positioned by the same maths the obstacles use, so it approaches at
// exactly the run's speed and lines up with the goal distance rather than
// merely being nearby.
//
// 2026-09-10 ("no end"): running through it no longer ends anything — the
// unlock toast (announceUnlock()) fires independently, on the same
// threshold, and the run carries straight on. The portal is now purely the
// visual beat for that moment: it still needs to disappear behind the
// player once passed, which it never had to do before (the run always
// ended here, so nothing was left running long enough to notice it hadn't).
// =====================================================================
const PORTAL_LEAD_DISTANCE = 55; // metres before the goal that it appears
let finishPortal = null;
let portalSpin = 0;

function clearFinishPortal() {
  if (!finishPortal) return;
  scene.remove(finishPortal);
  finishPortal = null;
}

function updateFinishPortal(dt) {
  const goal = currentEra().goal;
  const remaining = goal - state.distance;
  if (remaining > PORTAL_LEAD_DISTANCE || remaining < -4) {
    clearFinishPortal();
    return;
  }
  if (!finishPortal) {
    finishPortal = modelInstance('time_portal') || null;
    if (!finishPortal) return;      // no model: the progress bar still ends the run
    // The portal is authored as a flat disc lying in its own XY plane. In a
    // Z-up file that is a disc on the FLOOR, and the loader's Z-up -> Y-up
    // rotation faithfully kept it horizontal — so it arrived as a puddle
    // rather than a gateway. Rotating the wrapper back by +90° cancels that
    // and stands it upright facing straight down the track at the player.
    finishPortal.rotation.x = Math.PI / 2;
    finishPortal.position.set(0, 2.8, SPAWN_Z);
    scene.add(finishPortal);
  }
  // Sits exactly `remaining` metres up the track, so it arrives on the
  // metre the era ends rather than drifting against the progress bar. On a
  // corner era that means following the road round: a finish line hanging in
  // mid-air off the outside of the last bend would be a strange thing to be
  // running towards. rotation.x/z are the portal's own upright-and-spinning
  // pose, so only x/z position and the yaw are taken from the track.
  if (terrainActive()) {
    const q = pathLocal(remaining);
    finishPortal.position.x = q.x;
    finishPortal.position.z = q.z;
    finishPortal.position.y = 2.8 + hillOffset(state.distance + remaining);
  } else {
    finishPortal.position.x = 0;
    finishPortal.position.z = -remaining;
  }
  portalSpin += dt * 1.6;
  // Spun about its own normal (local z), so it turns in its own plane like a
  // gateway rather than tumbling.
  finishPortal.rotation.z = portalSpin;
}

function resetRun() {
  state.score = 0;
  state.lives = START_LIVES;
  state.lane = 1;
  state.grounded = true;
  state.vy = 0;
  state.jumping = false;
  state.jumpY = 0;
  state.punchTimer = 0;
  state.punchAnimTimer = 0;
  state.duckTimer = 0;
  state.invulnTimer = 0;
  state.starT = 0;
  state.lifeSpawnTimer = LIFE_SPAWN_MIN + Math.random() * (LIFE_SPAWN_MAX - LIFE_SPAWN_MIN);
  state.starSpawnTimer = STAR_SPAWN_MIN + Math.random() * (STAR_SPAWN_MAX - STAR_SPAWN_MIN);
  endStar();
  state.spawnTimer = BASE_SPAWN_INTERVAL;
  state.coinTimer = 0.8;
  state.distance = 0;
  state.runTime = 0;
  state.coinsTaken = 0;
  state.clears = 0;
  state.unlockAnnounced = false; // a fresh run gets its own shot at the toast
  obstacles.splice(0).forEach((o) => scene.remove(o.mesh));
  pickups.splice(0).forEach((p) => scene.remove(p.mesh));
  clearFinishPortal();
  impactBursts.splice(0).forEach((b) => scene.remove(b.group));
  player.position.set(0, 0, 0);
  player.rotation.y = 0;
  player.scale.set(1, 1, 1);
  upper.position.y = 0;
  upper.rotation.x = 0;
  landSquash = 0;
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
  // Pitched well down, so finishing badly sounds different from finishing.
  audio.sfx('star', { rate: 0.5 });
  state.phase = 'gameover';
  state.gameOverT = 0;
  state.turnEndT = 0;
  finalScoreEl.textContent = Math.floor(state.score);
  commitHighScore();
  // The run has no other end any more (2026-09-10), so this is also the one
  // moment an era's "best" score gets banked — it used to happen only on
  // reaching the old finish line, which every run now runs straight past.
  recordBest(currentEra().id, state.score);
  newHighScoreNote.style.display = state.score > highScoreAtRunStart ? 'block' : 'none';
  const titleEl = document.getElementById('gameOverTitle');
  const hintEl = document.getElementById('gameOverHint');
  const subHintEl = document.getElementById('gameOverSubHint');
  const statsEl = document.getElementById('gameOverStats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div><span>Time</span><b>${formatTime(state.runTime)}</b></div>
      <div><span>Distance</span><b>${Math.floor(state.distance)}m</b></div>
      <div><span>Collected</span><b>${state.coinsTaken}</b></div>
      <div><span>Cleared</span><b>${state.clears}</b></div>
    `;
  }
  if (multiplayer.active) {
    recordTurnResult(false);
    if (titleEl) titleEl.textContent = `${playerLabel(activePlayerId()).name} is out!`;
    if (hintEl) {
      hintEl.textContent = multiplayer.index + 1 < multiplayer.order.length
        ? '🎮 OK / Jump / Punch for the next player'
        : '🎮 OK / Jump / Punch to see the results';
    }
    if (subHintEl) subHintEl.style.display = 'none';
  } else {
    if (titleEl) titleEl.textContent = 'Run Over!';
    if (hintEl) hintEl.textContent = '🎮 Press OK on your remote (or tap Jump/Punch on your phone) to run again';
    if (subHintEl) subHintEl.style.display = 'block';
  }
  hideActionPrompt();
  hideCountdown();
  endStar(); // don't leave the aura, the HUD pill or the widened FOV behind
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
  // 2026-09-09 (part of the "dino level has no music" fix): these two calls
  // used to sit ABOVE the phase guards, so a pause_toggle arriving outside a
  // run — a stray ⏸ from a phone sitting on a menu screen — silenced the
  // music and then returned before anything was actually paused, leaving
  // nothing behind that would ever turn it back on. Music state now only
  // moves when the game state actually moves with it.
  if (state.phase !== 'playing') return;
  audio.pauseMusic();
  state.phase = 'paused';
  pausedScoreVal.textContent = String(Math.floor(state.score));
  hideActionPrompt();
  syncPanel();
}

function resumeGame() {
  if (state.phase !== 'paused') return;
  audio.resumeMusic();
  state.phase = 'playing';
  lastT = performance.now(); // avoid a huge dt jump on the first frame back
  showPanel(null);
  updateControlBadge(null);
}

function exitToMenu() {
  if (state.phase !== 'playing' && state.phase !== 'paused' && state.phase !== 'countdown') return;
  commitHighScore();
  hideCountdown();
  // Exiting mid-turn abandons the whole multiplayer game, same reasoning as
  // the Back-press handler on the results screens — there's no sensible
  // "resume this player's turn later".
  resetMultiplayer();
  // Leaving a paused run has to undo the pause's effect on the music, or the
  // menus (and the next run, which may well be the same era) stay silent —
  // this was the other half of the 2026-09-09 "no music" bug.
  audio.resumeMusic();
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
    // The Join screen (2026-09-08 redesign) shows the code as a row of
    // individual voxel-style tiles rather than one plain string — built
    // with no whitespace between the <span>s so .textContent (what the
    // test suite and roomCodeMiniEl's copy both rely on) still reads back
    // as exactly the 6-digit code.
    roomCodeEl.innerHTML = String(msg.code).split('').map((d) => `<span class="pq-tile">${d}</span>`).join('');
    if (roomCodeMiniEl) roomCodeMiniEl.textContent = msg.code;
    // Scan-to-join (2026-09-03): the server generates this SVG itself (see
    // server.js's /qr/<code>.svg route + lib/qrcode-lite.js) so no library
    // or network fetch is needed here — just point an <img> at it once the
    // room code exists. Same-origin request, so no CORS concerns either.
    joinQrEl.src = `/qr/${msg.code}.svg`;
  } else if (msg.type === 'roster') {
    // Who's actually connected, by player id — separate from
    // controller_connected's bare count, which this still runs alongside.
    // Multiplayer's turn order is only locked in once a level is chosen
    // (see beginMultiplayerIfNeeded()), so a late join or a drop mid-game
    // doesn't reshuffle a turn order already in progress.
    roster = Array.isArray(msg.ids) ? msg.ids.slice().sort((a, b) => a - b) : [];
    // A player who has gone stops being someone the room waits for, and a
    // NEW id in an old slot must not inherit the previous occupant's
    // "already set up" — both handled by pruning against the live roster.
    forgetDisconnectedSetup();
    syncPartyToRoster();
    renderRoster();
    renderReadyHint();
  } else if (msg.type === 'controller_connected') {
    if (msg.count > 0 && (state.phase === 'pairing')) {
      state.phase = 'ready';
      renderReadyHint();
      syncPanel();
    } else if (msg.count === 0 && state.phase !== 'playing') {
      state.phase = 'pairing';
      calibrating = false;
      setupStage = 'none';
      setupDonePlayers.clear();
      startOverrideUntil = 0;
      resetMultiplayer();
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
    else if (msg.event === 'done') finishCalibrationUI(msg.playerId);
  } else if (msg.type === 'error') {
    pairingHint.textContent = msg.message;
  }
});

ws.addEventListener('close', () => {
  pairingHint.textContent = 'Connection lost — refresh this page to reconnect.';
});

// Remembers the last absolute body position seen on the era picker so a
// player standing to one side doesn't scroll the menu continuously.
let lastSelectLaneValue = 0;

function handleInput(msg) {
  // Browsers only allow audio to start from a genuine user gesture. A phone
  // message is one, and so is the remote keydown handler below.
  audio.unlock();
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
  // The era picker is drivable from the phone as well as the remote, so a
  // player who never picks the remote up isn't stuck. Lane gestures browse
  // the timeline; a deliberate jump/punch confirms — same "explicit only"
  // rule as starting a run, so a noisy gesture reading can't pick a level.
  if (state.phase === 'levelSelect') {
    if (msg.action === 'lane') { moveLevelSelection(msg.value > 0 ? 1 : -1); return; }
    if (msg.action === 'lane_set' && typeof msg.value === 'number') {
      // Absolute body position: stepping left/right of centre nudges the
      // selection once per change rather than repeating while they stand there.
      if (msg.value !== lastSelectLaneValue) {
        if (msg.value !== 0) moveLevelSelection(msg.value > 0 ? 1 : -1);
        lastSelectLaneValue = msg.value;
      }
      return;
    }
    if ((msg.action === 'jump' || msg.action === 'punch') && msg.explicit) { chooseLevel(); return; }
    return;
  }
  if (state.phase === 'leaderboard'
      && (msg.action === 'jump' || msg.action === 'punch') && msg.explicit) {
    endMultiplayer();
    return;
  }
  // Stepping left and right on the ready screen sets how many are playing —
  // the same gesture that browses the era picker, so a player who never picks
  // the remote up can still set the party size themselves.
  if (state.phase === 'ready' && msg.action === 'lane_set' && typeof msg.value === 'number') {
    if (msg.value !== lastSelectLaneValue) {
      if (msg.value !== 0) setPartySize(partySize + (msg.value > 0 ? 1 : -1));
      lastSelectLaneValue = msg.value;
    }
    return;
  }
  if (state.phase === 'ready' && msg.action === 'lane') {
    setPartySize(partySize + (msg.value > 0 ? 1 : -1));
    return;
  }
  if (state.phase === 'ready'
      && (msg.action === 'jump' || msg.action === 'punch') && msg.explicit) {
    // Won't start until every connected phone has actually been set up —
    // see the note above setupDonePlayers. A refusal repaints the hint
    // saying who we're waiting for; asking a second time goes anyway.
    if (!mayStartRun()) return;
    // Two or more phones connected before the first run starts means a
    // multiplayer game — route through the era picker so the group picks
    // together, same as any other route into chooseLevel()/
    // beginMultiplayerIfNeeded(). One phone keeps the old direct-start.
    if (partySize >= 2 || roster.length >= 2) openLevelSelect(); else startCountdown();
    return;
  }
  if (state.phase === 'gameover'
      && (msg.action === 'jump' || msg.action === 'punch') && msg.explicit) {
    if (multiplayer.active) advanceMultiplayerTurn(); else startCountdown();
    return;
  }
  // Mid-run input during a multiplayer turn only counts from whoever's turn
  // it actually is — otherwise every connected phone would steer the same
  // character during someone else's timed run.
  // Whose input counts. With a phone each, only the player whose turn it is
  // may steer. On a shared phone there is only one device and it belongs to
  // whoever is holding it, so matching ids would lock everyone out from turn
  // two onwards.
  if (multiplayer.active && !multiplayer.sharing
      && state.phase === 'playing' && msg.playerId !== activePlayerId()) return;
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
      audio.sfx('jump');
    }
  } else if (msg.action === 'duck') {
    // The pack has no duck sound. Rather than leave the move silent — it is
    // the one move with no other feedback, since you don't leave the ground
    // — the jump sample is played back slow, which reads as a downward
    // version of the same action. A standard trick, not a bodge.
    if (state.grounded && state.duckTimer <= 0) audio.sfx('jump', { rate: 0.62 });
    // Only from the ground: ducking mid-air would be a second way to clear
    // a hurdle and would make the jump/duck distinction meaningless. Also
    // ignored while a duck is already running, so a burst of crouch
    // readings can't hold the character down indefinitely.
    if (state.grounded && state.duckTimer <= 0) state.duckTimer = DUCK_DURATION;
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
    audio.sfx('punch');
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
// M mutes, for testing from a keyboard; the on-screen button below is the
// route a player actually has, since a Fire TV remote has no M key.
function isMutePress(e) { return e.code === 'KeyM'; }

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
  // Any remote press is a genuine user gesture, which is what browsers
  // require before audio may start.
  audio.unlock();
  if (isMutePress(e)) { setMuted(audio.toggleMute()); return; }
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
    // From the results screens, Back goes to the era picker rather than
    // straight back into the same level again. Mid-multiplayer-game, Back
    // abandons the whole session (remaining turns included) rather than
    // just the current one — a half-finished leaderboard would be worse.
    if (state.phase === 'gameover'
        || state.phase === 'ready' || state.phase === 'leaderboard') {
      if (multiplayer.active) endMultiplayer(); else openLevelSelect();
      return;
    }
  }

  // Era picker: left/right to browse the timeline, OK to travel there.
  if (state.phase === 'levelSelect') {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') { moveLevelSelection(-1); return; }
    if (e.code === 'ArrowRight' || e.code === 'KeyD') { moveLevelSelection(1); return; }
    // Up/down sets how many are playing, so it doesn't fight left/right
    // browsing the timeline.
    if (e.code === 'ArrowUp' || e.code === 'KeyW') { setPartySize(partySize + 1); return; }
    if (e.code === 'ArrowDown' || e.code === 'KeyS') { setPartySize(partySize - 1); return; }
    if (isSelectPress(e) || e.code === 'KeyF') { chooseLevel(); return; }
    return;
  }
  if (state.phase === 'leaderboard' && (isSelectPress(e) || e.code === 'KeyF')) {
    endMultiplayer();
    return;
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
    if (state.phase === 'ready') {
      // Same setup gate as the phone's jump/punch route above — the remote
      // was in fact the likelier way to skip setup, since the ready screen
      // sits there inviting an OK press from the moment a phone connects.
      if (!mayStartRun()) return;
      // The party size decides this now, not the phone count: three people
      // sharing one phone still go through the era picker together.
      if (partySize >= 2 || roster.length >= 2) openLevelSelect(); else startCountdown();
    } else if (state.phase === 'gameover') {
      if (multiplayer.active) advanceMultiplayerTurn(); else startCountdown();
    }
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
  const base = Math.min(MAX_SPEED, eraBaseSpeed(currentEra()) + state.distance * SPEED_RAMP);
  // The star deliberately breaks the MAX_SPEED ceiling — going faster than
  // the game normally allows is the whole point of it.
  return state.starT > 0 ? base * STAR_SPEED_MULT : base;
}

function updatePlaying(dt) {
  const speed = currentSpeed();
  // Distance drives the difficulty ramp. Score does NOT accumulate here any
  // more (2026-09-03): points come only from collecting coins and gems, via
  // addScore() — see the collectibles section above.
  state.distance += speed * dt;
  state.runTime += dt;
  updateProgressBar();
  updateFinishPortal(dt);
  // The unlock threshold. 2026-09-10: this used to end the run outright
  // ("levelComplete()"); now it fires once, announces whatever it opened,
  // and lets the run carry straight on — see announceUnlock().
  if (!state.unlockAnnounced && state.distance >= currentEra().goal) {
    state.unlockAnnounced = true;
    announceUnlock();
  }

  // Keep the corner table built out ahead of wherever the player has
  // actually reached — a run has no fixed length any more, so this has to
  // keep extending for as long as the run does, not just once at the start.
  if (terrainActive()) extendCornersTo(state.distance + CORNER_LOOKAHEAD);

  // The path table is what every position below is read out of, so it has to
  // be rebuilt for this frame's distance before anything consults it.
  rebuildPathTable(state.distance);

  // Ground. On the corner eras the road is the ribbon, which carries the
  // scroll in its own texture coordinates (see updateRoadRibbon), so the
  // flat plane's offset trick would double it up.
  state.distanceForTex += speed * dt;
  if (terrainActive()) updateRoadRibbon(state.distance);
  else roadTexture.offset.y = (state.distanceForTex / 8) % 1;

  // Scenery scroll (recycle). position.z stays exactly what it always was —
  // plain distance ahead of the player — and the drawn position is derived
  // from it, so the recycling above is untouched by the corners.
  // Scenery scroll (recycle). `trackZ` carries the meaning position.z used to
  // (negative = ahead of the player) and is what the recycling runs on;
  // position is then purely where the prop gets DRAWN. They have to be
  // separate now, because on a corner the drawn z is a function of the bend
  // and feeding that back into the scroll would corrupt the recycling.
  sceneryPool.forEach((t) => {
    t.userData.trackZ += speed * dt;
    if (t.userData.trackZ > 10) t.userData.trackZ -= 16 * sceneryPool.length * 0.5;
    if (terrainActive()) {
      const zAhead = -t.userData.trackZ;
      // baseX is the prop's distance out from the centre line, so it rides
      // round the bend with the verge instead of staying where the road was.
      placeOnTrack(t, zAhead, t.userData.baseX, t.userData.baseY, t.userData.baseYaw);
    } else {
      t.position.x = t.userData.baseX;
      t.position.y = t.userData.baseY;
      t.position.z = t.userData.trackZ;
      t.rotation.y = t.userData.baseYaw;
    }
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
  // 2026-09-09: the corner path is evaluated in the PLAYER'S frame, so the
  // player sits at the origin facing -z by construction and a lane is once
  // again a plain sideways offset — no curve term, at any point on any
  // corner. It is the road and everything on it that bends around them,
  // which is exactly why the camera needs no work to stay behind.
  const targetX = LANE_X[state.lane];
  const dx = targetX - player.position.x;
  player.position.x += dx * Math.min(1, dt * 24);
  player.rotation.z = THREE.MathUtils.lerp(player.rotation.z, THREE.MathUtils.clamp(-dx * 0.35, -0.35, 0.35), dt * 16);

  // Jump physics — tracked in state.jumpY (height above LOCAL terrain), not
  // player.position.y directly. player.position.y is grounded==0 whenever
  // the character isn't jumping, every single frame, by construction, so
  // auto-terrain's hill offset (added once, at the very bottom of this
  // function) can never accumulate onto it just because nothing else here
  // resets player.position.y while grounded.
  if (!state.grounded) {
    state.vy += GRAVITY * dt;
    state.jumpY += state.vy * dt;
    if (state.jumpY <= 0) {
      state.jumpY = 0;
      state.vy = 0;
      state.grounded = true;
      state.jumping = false;
      landSquash = 1; // drives the touchdown squash below
    }
  } else {
    state.jumpY = 0;
  }
  player.position.y = state.jumpY;
  shadowBlob.position.x = player.position.x;
  shadowBlob.scale.setScalar(THREE.MathUtils.clamp(1 - player.position.y * 0.15, 0.4, 1));

  // Punch timers — punchTimer gates gameplay (crate-safety window),
  // punchAnimTimer drives the exaggerated cosmetic animation below; see
  // the big comment above punchArmRotation() for why they're separate.
  if (state.punchTimer > 0) state.punchTimer = Math.max(0, state.punchTimer - dt);
  if (state.punchAnimTimer > 0) state.punchAnimTimer = Math.max(0, state.punchAnimTimer - dt);
  if (state.duckTimer > 0) state.duckTimer = Math.max(0, state.duckTimer - dt);
  if (state.invulnTimer > 0) state.invulnTimer = Math.max(0, state.invulnTimer - dt);
  updateStar(dt);

  // Procedural animation
  const runT = state.distanceForTex * 1.6;
  const swing = state.grounded ? Math.sin(runT) * 0.6 : 0;
  legL.rotation.x = state.grounded ? swing : -0.5;
  legR.rotation.x = state.grounded ? -swing : 0.3;

  // Upper-body bob. Twice per stride (hence the doubled runT), so it reads
  // as weight landing on each foot rather than a float. The legs are NOT in
  // this group, so the feet stay planted while the body rides up and down.
  upper.position.y = state.grounded ? Math.abs(Math.sin(runT)) * 0.055 : 0.03;

  // Squash and stretch (2026-09-04) — the single biggest thing that makes a
  // blocky character feel alive instead of a sliding prop. Stretch tall on
  // the way up, squash flat on touchdown, and let it spring back. Applied to
  // the player group, which is anchored at the feet, so the character
  // deforms from the ground up the way a real jump does; player.position is
  // untouched, so none of this can affect collision or gem reach.
  if (landSquash > 0) landSquash = Math.max(0, landSquash - dt * 5.5);
  const stretch = state.grounded ? 0 : THREE.MathUtils.clamp(state.vy / JUMP_VELOCITY, -1, 1) * 0.16;
  const squash = landSquash * 0.26;

  // Duck (2026-09-04). Drops fast, holds, springs back up — the drop is
  // quicker than the recovery because getting UNDER the bar is the urgent
  // half, and a slow rise reads as effort rather than a rubber band. The
  // character is anchored at the feet, so compressing y alone plants it
  // convincingly; widening x/z a little is the squash that stops it looking
  // like the model simply got shorter.
  let duckAmt = 0;
  if (state.duckTimer > 0) {
    const frac = 1 - state.duckTimer / DUCK_DURATION; // 0 at start, 1 at end
    if (frac < DUCK_IN_FRAC) duckAmt = frac / DUCK_IN_FRAC;
    else if (frac > 1 - DUCK_OUT_FRAC) duckAmt = (1 - frac) / DUCK_OUT_FRAC;
    else duckAmt = 1;
    duckAmt = THREE.MathUtils.clamp(duckAmt, 0, 1);
  }
  const duckY = 1 - duckAmt * (1 - DUCK_SCALE_Y);
  const duckXZ = 1 + duckAmt * 0.16;

  player.scale.set(
    (1 - stretch * 0.55 + squash * 0.7) * duckXZ,
    (1 + stretch - squash) * duckY,
    (1 - stretch * 0.55 + squash * 0.7) * duckXZ
  );
  // Lean the upper body forward into the crouch rather than just shrinking
  // straight down — a duck is a movement, not a resize.
  upper.rotation.x = duckAmt * 0.5;

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
    // 2026-09-10 "exaggerate the animation to make it more amusing": the
    // whole body now commits to the punch rather than just the arm. Windup
    // rocks back and drops into a crouch; the snap throws the body forward
    // onto its toes with a hop, a hard shoulder twist, the head thrown
    // after the fist, and the off-arm flung out behind as counterweight.
    const elapsedFrac = 1 - state.punchAnimTimer / PUNCH_ANIM_DURATION;
    const armAngle = punchArmRotation(elapsedFrac);
    const bump = punchImpactBump(elapsedFrac);
    // Positive while winding up, 0 once the fist is on its way — drives the
    // anticipation (lean back, sink down) that makes the snap read as fast.
    const windup = Math.max(0, armAngle) / PUNCH_WINDUP_PULL;
    punchBump = bump;
    armR.rotation.x = -armAngle;
    // 0.45, not more: armAngle reaches -3.35 rad at full reach, so a bigger
    // multiplier swings the off-arm past 200 degrees and straight through
    // the torso. This is a hard counter-swing that stays outside the body.
    armL.rotation.x = armAngle * 0.45;              // off-arm flung the other way
    armR.rotation.z = -bump * 0.30;                 // fist crosses the body a little
    armL.rotation.z = bump * 0.42;
    player.rotation.y = -armAngle * 0.34;           // shoulder twist, was 0.22
    player.rotation.x = windup * 0.16 - bump * 0.30; // rock back, then lunge over the fist
    player.position.z = windup * 0.22 - bump * 1.15; // was a flat -bump * 0.6
    player.position.y += bump * 0.30;               // little hop off the ground at impact
    head.rotation.x = -bump * 0.34;                 // head thrown after the punch
    legL.rotation.x = swing * 0.3 - windup * 0.35;  // knees bend into the windup
    legR.rotation.x = -swing * 0.3 - windup * 0.35;
    torso.scale.set(1 + bump * 0.52, 1 - bump * 0.38 + windup * 0.10, 1 + bump * 0.52);
  } else {
    armR.rotation.x = state.grounded ? swing * 0.8 : -0.4;
    armL.rotation.x = state.grounded ? -swing * 0.8 : -0.4;
    // Everything the punch borrowed gets eased back, or the character keeps
    // whatever pose the last frame of the punch left it in.
    armR.rotation.z = THREE.MathUtils.lerp(armR.rotation.z, 0, Math.min(1, dt * 12));
    armL.rotation.z = THREE.MathUtils.lerp(armL.rotation.z, 0, Math.min(1, dt * 12));
    player.rotation.x = THREE.MathUtils.lerp(player.rotation.x, 0, Math.min(1, dt * 12));
    head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, 0, Math.min(1, dt * 12));
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
  camera.position.y = CAMERA_BASE_Y + punchBump * 0.30;
  camera.lookAt(player.position.x * 0.4, 1.05, -13);

  // Spawn obstacles
  state.spawnTimer -= dt;
  if (state.spawnTimer <= 0) {
    if (obstacleSpawnEnabled) spawnObstacle();
    const interval = Math.max(MIN_SPAWN_INTERVAL, eraBaseSpawnInterval(currentEra()) - state.distance * SPAWN_RAMP);
    state.spawnTimer = interval * (0.8 + Math.random() * 0.4);
  }

  // Spawn coin trails on their own cadence, so there's a near-constant
  // stream of them to run through between obstacles.
  state.coinTimer -= dt;
  if (state.coinTimer <= 0) {
    if (coinSpawnEnabled) spawnCoinRun();
    state.coinTimer = BASE_COIN_INTERVAL * (0.75 + Math.random() * 0.5);
  }

  // Hearts and stars, each on their own long, independent timer. If the
  // spawn is skipped because all three lanes are busy, retry shortly rather
  // than waiting out another full interval — otherwise a crowded stretch of
  // track can silently swallow a pickup the player waited a minute for.
  state.lifeSpawnTimer -= dt;
  if (state.lifeSpawnTimer <= 0) {
    const placed = spawnSpecial('life');
    state.lifeSpawnTimer = placed
      ? LIFE_SPAWN_MIN + Math.random() * (LIFE_SPAWN_MAX - LIFE_SPAWN_MIN)
      : 1.5;
  }
  state.starSpawnTimer -= dt;
  if (state.starSpawnTimer <= 0) {
    const placed = spawnSpecial('star');
    state.starSpawnTimer = placed
      ? STAR_SPAWN_MIN + Math.random() * (STAR_SPAWN_MAX - STAR_SPAWN_MIN)
      : 1.5;
  }

  // Update collectibles
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.trackZ += speed * dt;
    // Pickups ride the bend with the lane they sit in, so a coin trail
    // follows the road round a corner instead of sailing off the outside of
    // it. Position only — these spin on their own axis just below, and the
    // spin is their whole read as "collectible", so the corner must not take
    // rotation.y away from them.
    // Ground height under this pickup, taken from the per-frame path table
    // rather than recomputed — the bob/spin below adds to it.
    let hillY = 0;
    if (terrainActive()) {
      hillY = trackPos(p.mesh, -p.trackZ, LANE_X[p.lane], 0).y;
    } else {
      p.mesh.position.x = LANE_X[p.lane];
      p.mesh.position.z = p.trackZ;
    }
    // A little spin so they read as collectible rather than scenery.
    if (p.kind === 'gem') {
      p.mesh.rotation.y += dt * 2.6;
      p.mesh.position.y = GEM_Y + Math.sin(state.distanceForTex * 0.9 + p.mesh.position.x) * 0.12 + hillY;
    } else if (p.kind === 'life' || p.kind === 'star') {
      // Rare pickups spin faster and bob, so they stand out from the
      // constant stream of coins at a glance.
      p.mesh.rotation.y += dt * 2.2;
      p.mesh.position.y = COIN_Y + 0.25 + Math.sin(state.distanceForTex * 1.2) * 0.16 + hillY;
    } else {
      p.mesh.rotation.y += dt * 3.4;
      p.mesh.position.y = COIN_Y + hillY;
    }

    if (!p.collected && p.lane === state.lane && Math.abs(p.trackZ) <= PICKUP_RADIUS_Z) {
      // A gem hangs high on purpose: you have to actually be off the ground
      // to take it, which is what makes it the reward for jumping a hurdle
      // rather than something you collect by walking underneath.
      const reachable = p.kind === 'gem' ? player.position.y >= GEM_MIN_PLAYER_Y : true;
      if (reachable) {
        p.collected = true;
        state.coinsTaken += 1;
        if (p.kind === 'coin') audio.sfx('coin');
        else if (p.kind === 'gem') audio.sfx('gem');
        else if (p.kind === 'life') audio.sfx('heart');
        else if (p.kind === 'star') audio.sfx('star');
        if (p.kind === 'life') {
          if (state.lives < MAX_LIVES) {
            state.lives += 1;
            renderLives();
            popCombo('+1 LIFE ❤️');
          } else {
            // Never a wasted pickup: at full health a heart pays out instead.
            addScore(FULL_HEALTH_LIFE_VALUE);
            popCombo(`FULL HEALTH +${FULL_HEALTH_LIFE_VALUE}`);
          }
        } else if (p.kind === 'star') {
          startStar();
        } else {
          addScore(p.kind === 'gem' ? GEM_VALUE : COIN_VALUE);
          if (p.kind === 'gem') popCombo(`GEM +${GEM_VALUE}`);
        }
        scene.remove(p.mesh);
        pickups.splice(i, 1);
        continue;
      }
    }

    if (p.trackZ > DESPAWN_Z) {
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

    o.trackZ += speed * dt;

    // Purely a redraw of where the obstacle sits on screen. Collision just
    // below still keys off o.lane plus a window on o.trackZ, never the drawn
    // position, so an obstacle swinging round a corner can't dodge or cheat
    // its own hitbox. Yawed to face along the track as well, so a hurdle
    // mid-corner lies square across the road instead of skewed to the world.
    if (terrainActive()) {
      placeOnTrack(o.mesh, -o.trackZ, LANE_X[o.lane], o.baseY);
    } else {
      o.mesh.position.x = LANE_X[o.lane];
      o.mesh.position.y = o.baseY;
      o.mesh.position.z = o.trackZ;
    }
    // After placement, so the idle rides on top of the track position rather
    // than being overwritten by it every frame.
    updateObstacleIdle(o.mesh, state.distanceForTex * 0.35);

    if (!o.resolved && o.trackZ >= COLLISION_Z_MIN && o.trackZ <= COLLISION_Z_MAX) {
      o.resolved = true;
      if (o.lane === state.lane) {
        let safe = false;
        if (o.type === 'hurdle') safe = !state.grounded;
        else if (o.type === 'crate') safe = state.punchTimer > 0;
        // A low bar is cleared by ducking and ONLY by ducking. Jumping into
        // one puts your head straight through it, which is what stops the
        // new obstacle from collapsing back into "another hurdle".
        else if (o.type === 'lowbar') safe = state.duckTimer > 0 && state.grounded;
        else safe = false; // wall: only lane-dodge saves you

        if (state.starT > 0) {
          // Star: run straight through it. Walls included — this is the one
          // thing in the game that gets you past a wall without dodging.
          launchObstacleFlying(o, speed);
          releaseCoins(o.mesh.position, STAR_SMASH_COINS);
          popCombo('SMASH!');
        } else if (safe) {
          state.clears += 1;
          if (o.type === 'lowbar') {
            popCombo('DUCK!');
          } else if (o.type === 'crate') {
            // Smashing a crate scatters coins — the reward for a good punch
            // is still points, but they arrive as coins like everything else.
            launchObstacleFlying(o, speed);
            releaseCoins(o.mesh.position, PUNCH_COIN_REWARD);
          } else {
            popCombo('JUMP!');
          }
        } else if (state.invulnTimer <= 0) {
          audio.sfx('punch', { rate: 0.45, gain: 0.9 });
          state.lives -= 1;
          state.invulnTimer = HIT_INVULN_TIME;
          renderLives();
          flashHit();
          if (state.lives <= 0) { gameOver(); return; }
        }
      }
    }

    if (o.trackZ > DESPAWN_Z) {
      scene.remove(o.mesh);
      obstacles.splice(i, 1);
    }
  }

  // --- Terrain visuals: shadow, player & camera --------------------------
  // Deliberately last: every check above this point (grounded/jump physics,
  // the gem-height check, collision) already ran against the character's
  // plain jump-relative height, so adding the local hill height to
  // player.position.y here can't retroactively change any of those.
  //
  // 2026-09-09: the road no longer needs faking here. The ribbon genuinely
  // follows the path and genuinely rolls over the hills, vertex by vertex
  // (updateRoadRibbon), so the old "tilt one big flat quad and hope the fog
  // hides the ends" trick is gone with the quad.
  //
  // The camera keeps looking straight down the track — which, because the
  // path is evaluated in the player's own frame, IS behind the character all
  // the way through a corner without doing anything about it. The only nod
  // to the turn is a slight roll into it, which reads as leaning into the
  // bend; the camera's position and heading relative to the runner never
  // change, exactly as asked for.
  if (terrainActive()) {
    const groundY = hillOffset(state.distance);
    shadowBlob.position.y = groundY + 0.02;
    player.position.y += groundY;
    camera.position.y += groundY;
    // Aimed further up the track than the old -8: looking further ahead
    // lifts the horizon in frame, which is the other half of seeing over a
    // crest. Still a fixed point relative to the runner, so the camera is
    // no more "active" than it was.
    camera.lookAt(player.position.x * 0.4, 1.05 + groundY, -13);
    // How sharply the track is turning right here, as a fraction of the
    // steepest a corner ever gets: 0 on a straight, 1 at the middle of a
    // corner. cornerEase peaks at 1.5x the average rate.
    const turnRate = (headingAt(state.distance + 2) - headingAt(state.distance - 2)) / 4;
    const bank = THREE.MathUtils.clamp(turnRate / (1.5 * (Math.PI / 2) / CORNER_ARC), -1, 1);
    cameraRoll += (bank * CAMERA_CORNER_ROLL - cameraRoll) * Math.min(1, dt * 3);
    camera.rotateZ(cameraRoll);
    if (horizonGroup) {
      horizonSwing += (bank * HORIZON_CORNER_SWING - horizonSwing) * Math.min(1, dt * 1.6);
      // Orbited about the PLAYER, not spun about its own centre — rotating
      // the group in place would just turn the volcano round, which is not
      // what a distant landmark does when you take a bend.
      horizonGroup.position.x = HORIZON_Z * Math.sin(horizonSwing);
      horizonGroup.position.z = HORIZON_Z * Math.cos(horizonSwing);
      horizonGroup.rotation.y = horizonSwing;
    }
  } else if (ground.position.y !== 0 || ground.rotation.z !== 0) {
    // Snap flat immediately on leaving a terrain era rather than easing out
    // of a stale tilt — this only ever runs on the frame an era switch
    // actually happens, not every frame of a non-terrain run.
    ground.position.y = 0;
    ground.rotation.x = -Math.PI / 2;
    ground.rotation.z = 0;
    shadowBlob.position.y = 0.02;
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
// 2026-09-10 "improve the resolution without hurting performance". The old
// logic could only ever step DOWN, so a device with headroom to spare stayed
// at the cautious starting resolution forever — which is most of the reason
// the picture looked soft. It now measures first and moves in whichever
// direction the measurement points.
//
// The bar to earn more resolution is deliberately strict: a comfortable
// margin over 60fps, not merely "not struggling", so a device that is only
// just coping is never pushed over the edge by its own good behaviour.
const QUALITY_FRAME_MS_HEADROOM = 1000 / 75;
const QUALITY_MAX_PIXEL_RATIO = 2;
function maybeDowngradeQuality(rawFrameMs) {
  if (qualityDowngraded || qualityFrameCount >= QUALITY_SAMPLE_FRAMES) return;
  qualityFrameCount++;
  qualityFrameTimeSum += rawFrameMs;
  if (qualityFrameCount < QUALITY_SAMPLE_FRAMES) return;
  qualityDowngraded = true;
  const avgFrameMs = qualityFrameTimeSum / qualityFrameCount;
  const dpr = window.devicePixelRatio || 1;
  if (avgFrameMs > QUALITY_FRAME_MS_FLOOR) {
    renderer.setPixelRatio(0.75);
    renderer.setSize(window.innerWidth, window.innerHeight);
  } else if (avgFrameMs < QUALITY_FRAME_MS_HEADROOM && dpr > 1) {
    // Render above CSS resolution and let the display downsample. That is
    // supersampling, so it smooths edges as well as sharpening detail — the
    // antialiasing the renderer deliberately turned off, bought back only on
    // hardware that has demonstrated it can afford it.
    renderer.setPixelRatio(Math.min(dpr, QUALITY_MAX_PIXEL_RATIO));
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
  updateSoundHint();

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
  // leaves to the ready screen instead. In multiplayer this instead advances
  // the turn (see the block below) — restarting the SAME player's run here
  // would silently skip everyone else.
  if (state.phase === 'gameover' && !multiplayer.active) {
    state.gameOverT += dt;
    if (state.gameOverT >= GAMEOVER_RESTART_DELAY) startCountdown();
  }

  // Multiplayer: each turn's result screen clears itself after a few
  // seconds, same idea as the auto-restart above but advancing to the next
  // player (or the leaderboard) instead of retrying. gameover is the only
  // way a turn ends now (2026-09-10) — there is no more mid-turn "finished".
  if (multiplayer.active && state.phase === 'gameover') {
    state.turnEndT += dt;
    if (state.turnEndT >= TURN_END_AUTO_DELAY) advanceMultiplayerTurn();
  }
  if (state.phase === 'turnIntro') {
    state.turnIntroT += dt;
    if (state.turnIntroT >= TURN_INTRO_DELAY) startCountdown();
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

  // The world is on screen during the countdown, the pause screen and the
  // menus, not just mid-run, so the road has to be built for every frame
  // that gets drawn — not only the ones updatePlaying() handles.
  // rebuildPathTable() is guarded on the distance, so the common case where
  // updatePlaying already did this costs one comparison.
  if (terrainActive()) {
    rebuildPathTable(state.distance);
    updateRoadRibbon(state.distance);
  }
  updateTurnSign();

  renderer.render(scene, camera);
}
// A small read-mostly window onto game state for the automated tests.
// Gameplay itself (coin runs, the countdown, the auto-restart) is otherwise
// only observable by watching the screen, which is exactly the kind of thing
// that has slipped through unnoticed on this project before. Nothing here is
// used by the game, and nothing the player can reach calls it.

// A read-only window onto the scene's current look, so a test can assert
// that switching era actually REPAINTS THE WORLD rather than just changing
// the label on the HUD — the failure mode where four "levels" turn out to
// be one level with four names. `groundKey` is a cheap fingerprint of the
// ground palette: two eras painted the same would produce the same string.
window.__mrScene = {
  get fog() { return scene.fog; },
  get hemi() { return hemiLight; },
  get sun() { return sun; },
  get rim() { return rimLight; },
  get groundKey() {
    const g = currentEra().ground;
    return [g.verge.join('/'), g.kerb, g.path.join('/'), g.dash || '-', g.slabs || '-'].join('|');
  },
  get sceneryKinds() { return [...new Set(currentEra().scenery)]; },
};

window.__mrDebug = {
  phase: () => state.phase,
  score: () => Math.floor(state.score),
  distance: () => state.distance,
  lane: () => state.lane,
  lives: () => state.lives,
  starRemaining: () => state.starT,
  setLives: (n) => { state.lives = n; renderLives(); },
  spawnSpecial: (kind) => spawnSpecial(kind),
  placeSpecial: (kind, lane, z) => addPickup(kind, lane, z),
  coinsTaken: () => state.coinsTaken,
  pickupCount: (kind) => (kind ? pickups.filter((p) => p.kind === kind).length : pickups.length),
  clearPickups: () => { pickups.splice(0).forEach((p) => scene.remove(p.mesh)); },
  placePickup: (kind, lane, z) => addPickup(kind, lane, z),
  setCoinSpawning: (on) => { coinSpawnEnabled = !!on; },
  setObstacleSpawning: (on) => { obstacleSpawnEnabled = !!on; },
  clearObstacles: () => { obstacles.splice(0).forEach((o) => scene.remove(o.mesh)); },
  clears: () => state.clears,
  punchTimers: () => ({ hit: state.punchTimer, anim: state.punchAnimTimer,
                        hitMax: PUNCH_DURATION, animMax: PUNCH_ANIM_DURATION }),
  // The character's actual pose, for asserting that the punch animation
  // really moves the whole body rather than just nudging an arm.
  pose: () => ({
    armR: +armR.rotation.x.toFixed(3), armL: +armL.rotation.x.toFixed(3),
    armRz: +armR.rotation.z.toFixed(3),
    bodyYaw: +player.rotation.y.toFixed(3), bodyPitch: +player.rotation.x.toFixed(3),
    lungeZ: +player.position.z.toFixed(3), hopY: +player.position.y.toFixed(3),
    headPitch: +head.rotation.x.toFixed(3),
    torsoX: +torso.scale.x.toFixed(3), torsoY: +torso.scale.y.toFixed(3),
  }),
  promptLeadTime: () => PROMPT_LEAD_TIME,
  speed: () => currentSpeed(),
  promptVisible: () => actionPromptEl.style.display !== 'none',
  // Distance-along of the obstacle closest to the player (0 = level with
  // them, negative = still ahead). Lets a test act at the right MOMENT
  // rather than after a fixed sleep — this sandbox renders in software and
  // runs the game clock at roughly half real-time, so a sleep tuned on one
  // machine times a jump completely differently on another.
  // As nearestObstacleZ, for pickups — same reason: a test needs to act when
  // the thing actually arrives, not after a sleep that assumes a frame rate.
  nearestPickupZ: (kind) => pickups.reduce((z, p) => ((kind && p.kind !== kind) || p.collected ? z : Math.max(z, p.trackZ)), -Infinity),
  nearestObstacleZ: () => obstacles.reduce((z, o) => (o.flying ? z : Math.max(z, o.trackZ)), -Infinity),
  jump: () => { if (state.grounded) { state.grounded = false; state.jumping = true; state.vy = JUMP_VELOCITY; } },
  duck: () => { if (state.grounded && state.duckTimer <= 0) state.duckTimer = DUCK_DURATION; },
  duckRemaining: () => state.duckTimer,
  punch: () => { if (state.punchAnimTimer <= 0) { state.punchTimer = PUNCH_DURATION; state.punchAnimTimer = PUNCH_ANIM_DURATION; } },
  era: () => currentEraId,
  music: () => audio.musicState(),
  muted: () => audio.isMuted(),
  musicBlocked: () => audio.isMusicBlocked(),
  pauseMusic: () => audio.pauseMusic(),
  grounded: () => state.grounded,
  eraGoal: () => currentEra().goal,
  eraList: () => ERAS.map((e) => e.id),
  applyEra: (id) => applyEra(id),
  setDistance: (m) => { state.distance = m; },
  unlocked: () => loadProgress().unlocked.slice(),
  setUnlocked: (ids) => { const p = loadProgress(); p.unlocked = ids.slice(); saveProgress(p); renderLevelSelect(); },
  selectIndex: () => levelSelectIndex,
  obstacleCount: () => obstacles.length,
  placeObstacle: (type, lane, z) => {
    // Same as spawnObstacle(): buildObstacleMesh already sets the right y
    // for the type, so only lane and distance are placed here.
    const mesh = buildObstacleMesh(type);
    mesh.position.x = LANE_X[lane];
    mesh.position.z = z;
    scene.add(mesh);
    obstacles.push({ type, lane, mesh, resolved: false, flying: false, baseY: mesh.position.y, trackZ: z });
  },
  endRun: () => gameOver(),
  roster: () => roster.slice(),
  multiplayer: () => ({
    active: multiplayer.active,
    order: multiplayer.order.slice(),
    index: multiplayer.index,
    activePlayerId: activePlayerId(),
    results: multiplayer.results.map((r) => ({ ...r })),
  }),
  partySize: () => partySize,
  setPartySize: (n) => setPartySize(n),
  setupDone: () => Array.from(setupDonePlayers).sort((a, b) => a - b),
  everyoneSetUp: () => everyoneSetUp(),
  readyHint: () => (readyStartHintEl ? readyStartHintEl.textContent : ''),
  terrainActive: () => terrainActive(),
  terrainAt: (d) => ({ hill: hillOffset(d), heading: headingAt(d) }),
  corners: () => corners.map((c) => ({ ...c })),
  headingAt: (d) => headingAt(d),
  // The track point `d` metres ahead of a player standing at `base`,
  // in that player's own frame. Copied out of the shared scratch object.
  pathAt: (base, d) => { rebuildPathTable(base); const q = pathLocal(d); return { x: q.x, z: q.z, yaw: q.yaw }; },
  nextCorner: (d) => { const c = nextCornerFrom(d); return c ? { ...c } : null; },
  playerX: () => player.position.x,
  playerY: () => player.position.y,
  groundTilt: () => ({ y: ground.position.y, rotX: ground.rotation.x, rotZ: ground.rotation.z }),
  // --- 2026-09-10: endless levels + per-era difficulty ---------------
  unlockAnnounced: () => state.unlockAnnounced,
  cornerCount: () => corners.length,
  cornerFrontier: () => cornerD,
  extendCornersTo: (d) => extendCornersTo(d),
  unlockToastText: () => (unlockToastEl ? unlockToastEl.textContent : ''),
  unlockToastVisible: () => !!(unlockToastEl && unlockToastEl.classList.contains('show')),
  eraTier: (id) => eraTier(ERA_BY_ID[id] || currentEra()),
  eraBaseSpeed: (id) => eraBaseSpeed(ERA_BY_ID[id] || currentEra()),
  eraBaseSpawnInterval: (id) => eraBaseSpawnInterval(ERA_BY_ID[id] || currentEra()),
  best: (id) => loadProgress().best[id] || 0,
};

// Paint the initial (pairing) state once before the loop starts. Without
// this, syncPanel() only ever ran in response to a state change, so on a
// fresh page load the pairing badge never appeared and the score/lives HUD
// stayed visible over the pairing panel until the first phone message
// arrived. Deliberately down here, after every `let` it reads (setupStage,
// calibrating, state) has actually been initialised.
// Paint the starting era's world (Present Day's palette is the file's
// built-in default, so this is what makes a *different* saved era show its
// own sky on the pairing screen rather than the default one).
applyEra(currentEraId);
// Deliberately not awaited. The game is fully playable on its built-in box
// shapes; the model pack upgrades what it can, whenever it arrives, and a
// slow or failed fetch never delays the pairing screen.
loadModelPack();
// Effects are decoded up front so the first coin doesn't arrive late. Music
// streams instead (see audio.js), and neither starts until unlock().
audio.preloadSfx();
updateEraBadge();
renderLevelSelect();
renderRoster();
renderParty();
renderMovesStrip();
syncPanel();
animate();


