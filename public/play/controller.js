// Motion Run — phone controller
//
// Screen flow: Character creator -> Join (room code) -> Camera permission
// -> Guided calibration -> Play.
//
// Two ways to control the game once playing, switchable any time from the
// tabs at the top of the play screen:
//   📷 Camera    — prop the phone up, step back, your BODY is tracked via
//                  the camera (pose detection, TensorFlow.js MoveNet).
//   📳 Hold phone — hold the phone and lean/hop/jab it (accelerometer).
// On-screen Jump/Punch buttons and tap-left/tap-right always work as a
// backup once actually playing.
//
// During the guided calibration screen, gestures are detected exactly the
// same way as in real play, but routed to the TV's step-by-step walkthrough
// instead of sending real game input — otherwise a practice jump would
// prematurely start the run (the TV starts the game on its first real
// jump/punch input). See `actionHandlers` below for that indirection, and
// `sendCalibration()` for how progress reaches the TV.
//
// CAMERA-MODE SETUP HAS A "PLACEMENT" AND "FRAMING" GATE BEFORE ANY OF
// THAT: after the player taps "Enable Camera Tracking" they still need to
// physically prop the phone up and walk back to their play space — which
// takes several seconds, during which the camera is very much pointed at a
// hand mid-fumble or a person mid-walk, not a calibrated stance. If pose
// detection reacted to that the way it reacts during real play, it would
// fire spurious jumps/punches/lane-changes before the player is even in
// position. So camera mode holds off on ALL of that (both the real
// realHandlers path and the practice calHandlers path) until:
//   1. the TV has shown "place your phone" and the player has confirmed
//      (Fire TV remote OK, relayed back here as `calibration_control`
//      'placement_ack') that it's in place, and
//   2. the TV's live framing check (silhouette guide, driven by
//      `evaluateFraming()` below) reports the player is visible at a
//      reasonable distance, confirmed either automatically (held for a
//      moment) or by another remote OK press ('moves_ack').
// `inCameraSetupGate` is the flag that suppresses lane/jump/punch
// detection for the whole of that window; `framingActive` is the narrower
// flag that turns on the framing evaluation itself once stage 1 is done.
// Hold-phone mode skips both stages entirely — the player never lets go of
// the phone, so there's nothing to walk away from or get "in frame" for.
//
// LANE CONTROL IS ABSOLUTE, NOT RELATIVE: both camera and hold-phone mode
// continuously track which of 3 zones (left/center/right) the player's
// body is currently in and tell the TV to put the character in the
// matching lane — see `computeZone()`. Returning to a normal, centered
// stance always puts the character back in the center lane; no deliberate
// "step back" gesture is needed. A little hysteresis (ENTER vs EXIT
// thresholds) stops the lane flickering right at the zone boundary.
//
// NOTE ON TUNING: none of the gesture-detection thresholds (camera or
// accelerometer) were tuned against a real phone or camera feed — this
// build environment has neither attached. They're reasoned starting
// points, kept deliberately forgiving (biased toward triggering too
// easily rather than not at all) since this is a fun family game, not a
// precision instrument. The calibration screen exists specifically so you
// can see what still needs adjusting on your actual device before playing.

(() => {
  // ==== Tunable thresholds ================================================
  const POSE_MIN_SCORE = 0.25;
  // Lane zones (camera mode): fraction of frame width the hips must be
  // offset from center to count as "in" the left/right zone (ENTER), and
  // how far back toward center they must return to leave it (EXIT — kept
  // smaller than ENTER so a normal stance reliably re-centers you without
  // needing an exaggerated opposite step).
  const LANE_ENTER_FRAC = 0.11;
  const LANE_EXIT_FRAC = 0.05;
  const JUMP_TRIGGER_TORSO_FRAC = 0.28;
  const JUMP_COOLDOWN_MS = 500;
  // Punch was firing continuously on real-device testing (2026-09-02) —
  // ordinary running arm swing was crossing these thresholds repeatedly.
  // Raised extension/velocity requirements (a punch now needs a clearly
  // more deliberate, further-reaching, faster jab than a running swing)
  // and roughly doubled the cooldown so even a borderline read can't
  // re-fire every few hundred ms. See also the TV-side debounce in
  // tv/game.js's handleInput(), which additionally ignores any punch
  // message that arrives while the previous punch's animation is still
  // playing — belt and braces against the same complaint.
  const PUNCH_EXTENSION_FRAC = 0.52;
  const PUNCH_VELOCITY_TORSO_FRAC = 2.0;
  const PUNCH_COOLDOWN_MS = 700;
  // Calibration-only punch thresholds (2026-09-02, "ensure punch is in the
  // list of movements during setup" feedback) — punch IS already one of
  // the 4 guided-calibration steps (see CAL_ORDER in tv/game.js, and
  // calState/calHandlers.punch below), but the thresholds directly above
  // were tightened specifically to stop punch false-firing during real
  // running, which made a deliberate practice punch during calibration
  // noticeably harder to land too — worth avoiding, since calibration is
  // the player's one chance to confirm their device can see this move at
  // all before a real run. There's no "false start" risk during setup the
  // way there is mid-run (a stray practice-screen punch just checks off a
  // box, it can't smash a crate or lose a life), so calibration can safely
  // use the original, more forgiving values instead. Real gameplay keeps
  // the stricter thresholds above completely untouched.
  const CAL_PUNCH_EXTENSION_FRAC = 0.38;
  const CAL_PUNCH_VELOCITY_TORSO_FRAC = 1.3;
  const CAL_PUNCH_COOLDOWN_MS = 450;
  // Was 20, then 30 (2026-09-02) — raised again to 45 (2026-09-02, "reduce
  // the delay between player movement and character movement" feedback) to
  // cut the worst-case pose-sampling delay (how long a real movement can
  // sit before we even look at a new camera frame) from ~33ms down to
  // ~22ms. This is just an upper cap on the sampling loop — real inference
  // time on the device is the actual floor, so raising it can only help,
  // never hurt, and 45 is still comfortably under what a modern phone
  // GPU/WebGL backend can sustain alongside MoveNet Lightning.
  const POSE_TARGET_FPS = 45;

  // Lane zones (hold-phone mode): same ENTER/EXIT hysteresis idea, in
  // degrees of phone tilt from the calibrated baseline.
  const TILT_ENTER_DEG = 16;
  const TILT_EXIT_DEG = 6;
  const MOTION_JUMP_TRIGGER = 14;
  // Raised alongside PUNCH_EXTENSION_FRAC/PUNCH_COOLDOWN_MS above — same
  // "punch firing continuously" real-device fix, hold-phone side.
  const MOTION_PUNCH_TRIGGER = 13;
  const MOTION_ROTATION_LOW = 250;
  // How much more vertical (device Y-axis) acceleration than lateral
  // (X/Z) acceleration a reading needs before onDeviceMotion() is willing
  // to call it a jump at all — see the big comment inside onDeviceMotion()
  // for why this exists (2026-09-02 "punch still not there" fix). 1.0
  // means "at least as vertical as lateral"; keeping it modest (not much
  // above 1.0) avoids over-correcting into swallowing real jumps.
  const MOTION_VERTICAL_DOMINANCE = 1.05;
  const MOTION_JUMP_COOLDOWN_MS = 500;
  const MOTION_PUNCH_COOLDOWN_MS = 700;
  // Calibration-only hold-phone punch thresholds — same reasoning as
  // CAL_PUNCH_EXTENSION_FRAC etc. above, just for the accelerometer path.
  // Matches the original pre-tightening values.
  const CAL_MOTION_PUNCH_TRIGGER = 9;
  const CAL_MOTION_PUNCH_COOLDOWN_MS = 450;
  const CROSS_TALK_LOCK_MS = 150;
  const GRAVITY_LOWPASS = 0.85;

  // Camera framing check (see the big header comment above): how close/far/
  // off-center counts as bad framing, and how long "good" framing has to
  // be held before we tell the TV it's ready to move on.
  const FRAMING_TOO_CLOSE_FRAC = 0.34; // torso height / frame height
  const FRAMING_TOO_FAR_FRAC = 0.15;
  const FRAMING_OFFCENTER_FRAC = 0.28; // |hip x offset| / frame width
  const FRAMING_GOOD_HOLD_MS = 900;
  const FRAMING_SEND_INTERVAL_MS = 200;

  const TFJS_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4/dist/tf.min.js';
  const POSE_DETECTION_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2/dist/pose-detection.min.js';

  const SKELETON_PAIRS = [
    ['left_shoulder', 'right_shoulder'], ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
    ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
    ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'], ['left_hip', 'right_hip'],
    ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'], ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'],
  ];

  // ==== Character data ======================================================
  const HAIR_OPTIONS = [
    { id: 'bald', label: '👨‍🦲 Bald' },
    { id: 'short', label: '💇 Short' },
    { id: 'spiky', label: '🦔 Spiky' },
    { id: 'afro', label: '🙆 Afro' },
    { id: 'pony', label: '🎀 Ponytail' },
  ];
  const HAT_OPTIONS = [
    { id: 'none', label: '🚫 No Hat' },
    { id: 'party', label: '🎉 Party' },
    { id: 'top', label: '🎩 Top Hat' },
    { id: 'cap', label: '🧢 Cap' },
    { id: 'propeller', label: '🚁 Propeller' },
  ];
  const COLOR_PALETTE = ['#3b2a1a', '#0b0b0b', '#f2c14e', '#e8836b', '#ff5a5f', '#6ee7ff', '#7c8cff', '#4ade80', '#ff9ecb', '#ffffff'];
  const STANDARD_CHARACTER = { hair: 'short', hairColor: '#3b2a1a', hat: 'none', hatColor: '#ff5a5f', shirtColor: '#ff5a5f' };

  let character = { ...STANDARD_CHARACTER };

  // ==== DOM ================================================================
  const characterScreen = document.getElementById('characterScreen');
  const joinScreen = document.getElementById('joinScreen');
  const controlChoiceScreen = document.getElementById('controlChoiceScreen');
  const chooseMotionBtn = document.getElementById('chooseMotionBtn');
  const choosePadBtn = document.getElementById('choosePadBtn');
  const permScreen = document.getElementById('permScreen');
  const calibrationScreen = document.getElementById('calibrationScreen');
  const playScreen = document.getElementById('playScreen');

  const avatarHair = document.getElementById('avatarHair');
  const avatarHat = document.getElementById('avatarHat');
  const avatarBody = document.getElementById('avatarBody');
  const hairOptionsEl = document.getElementById('hairOptions');
  const hairColorsEl = document.getElementById('hairColors');
  const hatOptionsEl = document.getElementById('hatOptions');
  const hatColorsEl = document.getElementById('hatColors');
  const shirtColorsEl = document.getElementById('shirtColors');
  const randomBtn = document.getElementById('randomBtn');
  const standardBtn = document.getElementById('standardBtn');
  const characterContinueBtn = document.getElementById('characterContinueBtn');

  const codeInput = document.getElementById('codeInput');
  const joinBtn = document.getElementById('joinBtn');
  const joinError = document.getElementById('joinError');
  const grantCameraBtn = document.getElementById('grantCameraBtn');
  const skipCameraBtn = document.getElementById('skipCameraBtn');
  const roomLabel = document.getElementById('roomLabel');
  const calibrateBtn = document.getElementById('calibrateBtn');

  const calRecenterBtn = document.getElementById('calRecenterBtn');
  const calSensorSlot = document.getElementById('calSensorSlot');
  const calibrationHint = document.getElementById('calibrationHint');
  const calSkipBtn = document.getElementById('calSkipBtn');
  const calSkipStepBtn = document.getElementById('calSkipStepBtn');
  const calStartBtn = document.getElementById('calStartBtn');

  const tabCamera = document.getElementById('tabCamera');
  const tabHold = document.getElementById('tabHold');
  const tabPad = document.getElementById('tabPad');
  const playSensorSlot = document.getElementById('playSensorSlot');
  const jumpBtn = document.getElementById('jumpBtn');
  const punchBtn = document.getElementById('punchBtn');
  const startRunBtn = document.getElementById('startRunBtn');
  const laneLeftBtn = document.getElementById('laneLeftBtn');
  const laneCentreBtn = document.getElementById('laneCentreBtn');
  const laneRightBtn = document.getElementById('laneRightBtn');
  const motionToggleBtn = document.getElementById('motionToggleBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const exitBtn = document.getElementById('exitBtn');
  const toast = document.getElementById('toast');

  const sensorPanel = document.getElementById('sensorPanel');
  const tiltZone = document.getElementById('tiltZone');
  const tiltMarker = document.getElementById('tiltMarker');
  const tiltHint = document.getElementById('tiltHint');
  const cameraView = document.getElementById('cameraView');
  const cameraVideo = document.getElementById('cameraVideo');
  const cameraCanvas = document.getElementById('cameraCanvas');
  const cameraCtx = cameraCanvas.getContext('2d');
  const cameraStatus = document.getElementById('cameraStatus');
  const laneMarker = document.getElementById('laneMarker');

  function showScreen(el) {
    [characterScreen, joinScreen, controlChoiceScreen, permScreen, calibrationScreen, playScreen]
      .forEach((s) => (s.style.display = 'none'));
    el.style.display = 'flex';
    updateFullscreenCam();
  }
  // Camera mode's live preview is genuinely useful to see full-size — both
  // while setting up (placing/framing the phone) and during real play (the
  // whole point of camera mode is watching yourself on the "mirror"), so on
  // either screen, while camera mode is active, blow the preview up to fill
  // the whole phone screen instead of sharing space with headers/buttons.
  // 2026-09-02 fix: this used to be gated to the calibration screen only
  // ("Play screen keeps the normal layout since the Jump/Punch buttons need
  // their room there") — but the buttons just need to become an overlay on
  // top of the fullscreen feed instead, same as the calibration screen's
  // header/hint/actions already do (see the body.cam-fullscreen #playScreen
  // CSS block), so there's no real reason play should be the exception the
  // user is hitting every time they turn the phone sideways mid-game.
  // Hold-phone mode has no camera feed to fill, so it's excluded either way.
  function updateFullscreenCam() {
    const onCalibration = calibrationScreen.style.display !== 'none';
    const onPlay = playScreen.style.display !== 'none';
    document.body.classList.toggle('cam-fullscreen', (onCalibration || onPlay) && currentMode === 'camera');
    // Controller mode ('pad') and the two motion modes want quite different
    // play screens — see the body.mode-pad / body.mode-motion CSS. Motion
    // modes drop the Jump/Punch buttons entirely so the camera gets the
    // whole screen; controller mode drops the sensor view and grows the
    // buttons instead.
    document.body.classList.toggle('mode-pad', currentMode === 'pad');
    document.body.classList.toggle('mode-motion', currentMode === 'camera' || currentMode === 'hold');
  }
  function showToast(msg) {
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => (toast.style.opacity = '0'), 1800);
  }
  function pulseAction(el) {
    el.style.filter = 'brightness(1.4)';
    setTimeout(() => (el.style.filter = ''), 150);
  }
  function moveSensorPanelTo(slot) {
    slot.appendChild(sensorPanel);
  }

  // =========================================================================
  // 1. CHARACTER CREATOR
  // =========================================================================
  function updateAvatarPreview() {
    avatarHair.className = `avatar-hair hair-${character.hair}`;
    avatarHair.style.background = character.hairColor;
    avatarHat.className = `avatar-hat hat-${character.hat}`;
    avatarHat.style.background = character.hatColor;
    avatarBody.style.background = character.shirtColor;
  }
  function refreshChipStates() {
    hairOptionsEl.querySelectorAll('.option-chip').forEach((c) => c.classList.toggle('active', c.dataset.id === character.hair));
    hatOptionsEl.querySelectorAll('.option-chip').forEach((c) => c.classList.toggle('active', c.dataset.id === character.hat));
    hairColorsEl.querySelectorAll('.color-swatch').forEach((c) => c.classList.toggle('active', c.dataset.color === character.hairColor));
    hatColorsEl.querySelectorAll('.color-swatch').forEach((c) => c.classList.toggle('active', c.dataset.color === character.hatColor));
    shirtColorsEl.querySelectorAll('.color-swatch').forEach((c) => c.classList.toggle('active', c.dataset.color === character.shirtColor));
  }
  function applyCharacter(next) {
    character = { ...character, ...next };
    updateAvatarPreview();
    refreshChipStates();
  }

  function buildOptionRow(container, options, key) {
    options.forEach((opt) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'option-chip';
      chip.textContent = opt.label;
      chip.dataset.id = opt.id;
      chip.addEventListener('click', () => applyCharacter({ [key]: opt.id }));
      container.appendChild(chip);
    });
  }
  function buildColorRow(container, key) {
    COLOR_PALETTE.forEach((color) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'color-swatch';
      sw.style.background = color;
      sw.dataset.color = color;
      sw.addEventListener('click', () => applyCharacter({ [key]: color }));
      container.appendChild(sw);
    });
  }
  buildOptionRow(hairOptionsEl, HAIR_OPTIONS, 'hair');
  buildColorRow(hairColorsEl, 'hairColor');
  buildOptionRow(hatOptionsEl, HAT_OPTIONS, 'hat');
  buildColorRow(hatColorsEl, 'hatColor');
  buildColorRow(shirtColorsEl, 'shirtColor');
  applyCharacter({}); // initial paint

  randomBtn.addEventListener('click', () => {
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    applyCharacter({
      hair: pick(HAIR_OPTIONS).id,
      hairColor: pick(COLOR_PALETTE),
      hat: pick(HAT_OPTIONS).id,
      hatColor: pick(COLOR_PALETTE),
      shirtColor: pick(COLOR_PALETTE),
    });
  });
  standardBtn.addEventListener('click', () => applyCharacter({ ...STANDARD_CHARACTER }));
  characterContinueBtn.addEventListener('click', () => showScreen(joinScreen));

  // =========================================================================
  // 2. WEBSOCKET / JOIN
  // =========================================================================
  let ws = null;
  let roomCode = null;

  function connect(code) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'register', role: 'controller', code }));
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'paired') {
        roomCode = msg.code;
        roomLabel.textContent = roomCode;
        sendCharacter();
        // First step of setup is now "how do you want to play?" — motion
        // tracking or the phone as a plain game controller.
        showScreen(controlChoiceScreen);
      } else if (msg.type === 'calibration_control') {
        // The TV relays Fire TV remote OK presses back to us during the
        // placement/framing setup stages — see handlePlacementAck/
        // handleMovesAck (defined further down, alongside beginCalibration).
        if (msg.action === 'placement_ack') handlePlacementAck();
        else if (msg.action === 'moves_ack') handleMovesAck();
        // The TV also drives WHICH move the walkthrough is currently asking
        // for, so we only accept that one — see handleCalStepRequest().
        else if (msg.action === 'step_request') handleCalStepRequest(msg);
        // The TV ends setup — either because the last move just got ticked
        // off, or because OK was pressed on the remote. Either way the
        // player doesn't have to come back to the phone to start.
        else if (msg.action === 'finish') finishCalibration({ notifyTv: false });
      } else if (msg.type === 'error') {
        joinError.textContent = msg.message || 'Could not connect.';
        joinBtn.disabled = false;
      }
    });

    ws.addEventListener('close', () => {
      if (playScreen.style.display !== 'none' || calibrationScreen.style.display !== 'none') {
        showToast('Disconnected from TV — reconnecting…');
      }
      showScreen(joinScreen);
      joinBtn.disabled = false;
    });

    ws.addEventListener('error', () => {
      joinError.textContent = 'Connection failed. Check you’re on the same WiFi as the TV.';
      joinBtn.disabled = false;
    });
  }

  function sendInput(action, value, opts) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg = { type: 'input', action, value };
    // `explicit` marks a message as a deliberate on-screen button tap, as
    // opposed to one raised by gesture detection (camera pose / phone
    // motion). The TV only lets an explicit tap (or its own remote) start
    // or retry a run — see handleInput() in tv/game.js — so a noisy false
    // -positive gesture can't accidentally kick off a new run on its own.
    // The Fire TV remote and this phone's own buttons are meant to be the
    // two reliable, deliberate ways to drive menus; raw gesture detection
    // is for in-run jump/punch only.
    if (opts && opts.explicit) msg.explicit = true;
    ws.send(JSON.stringify(msg));
  }
  function sendCharacter() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'character', ...character }));
  }
  function sendCalibration(event, extra) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'calibration', event, ...extra }));
  }

  joinBtn.addEventListener('click', () => {
    const code = codeInput.value.trim();
    if (code.length !== 6) {
      joinError.textContent = 'Enter the 6-digit code shown on the TV.';
      return;
    }
    joinError.textContent = '';
    joinBtn.disabled = true;
    connect(code);
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

  // =========================================================================
  // 3 & 4. CAMERA PERMISSION + CALIBRATION
  // =========================================================================
  chooseMotionBtn.addEventListener('click', () => showScreen(permScreen));
  choosePadBtn.addEventListener('click', () => beginPadMode());
  grantCameraBtn.addEventListener('click', () => beginCalibration('camera'));
  skipCameraBtn.addEventListener('click', () => beginCalibration('hold'));

  // Controller mode needs no calibration at all — there are no gestures to
  // teach or thresholds to check, just buttons — so it goes straight to the
  // play screen and tells the TV setup is finished.
  async function beginPadMode() {
    inCameraSetupGate = false;
    framingActive = false;
    await setMode('pad');
    actionHandlers = realHandlers;
    sendCalibration('done');
    showScreen(playScreen);
    showToast('Controller mode — use the buttons');
  }

  // See the big header comment for what these gate. Both default to
  // "everything's fine, detect normally" (false/false) so hold-phone mode
  // and real play are never accidentally blocked by leftover setup state.
  let inCameraSetupGate = false;
  let framingActive = false;
  let framingGoodStreakStart = null;
  let lastFramingSentT = 0;

  async function beginCalibration(mode) {
    resetCalibration();
    actionHandlers = calHandlers;
    moveSensorPanelTo(calSensorSlot);
    showScreen(calibrationScreen);
    inCameraSetupGate = false;
    framingActive = false;
    framingGoodStreakStart = null;
    await setMode(mode);
    if (currentMode === 'camera') {
      // Hold off on real detection — the placement/framing handshake with
      // the TV (handlePlacementAck/handleMovesAck below) is what lifts
      // this gate and actually starts per-move calibration.
      inCameraSetupGate = true;
      calibrationHint.textContent = '📺 Look at your TV to finish setting up your camera.';
      sendCalibration('placement');
    } else {
      sendCalibration('start', { mode: currentMode });
    }
  }

  function handlePlacementAck() {
    if (currentMode !== 'camera' || !inCameraSetupGate || framingActive) return;
    framingActive = true;
    framingGoodStreakStart = null;
    calibrationHint.textContent = '👀 Watch the TV — line yourself up in the outline.';
  }

  function handleMovesAck() {
    if (currentMode !== 'camera' || !inCameraSetupGate) return;
    inCameraSetupGate = false;
    framingActive = false;
    resetCalibration();
    sendCalibration('start', { mode: currentMode });
  }

  // The step-by-step walkthrough itself lives on the TV (see tv/game.js) —
  // this screen just detects each move (same detectors as real play, routed
  // through calHandlers below) and tells the TV which one just happened.
  const calState = { left: false, right: false, jump: false, punch: false };

  // 2026-09-03 fix ("the 4-stage setup never asks for a punch"). All four
  // detectors run at once during calibration, so before this change a stray
  // motion could tick off a move the TV hadn't asked for yet — punch most
  // of all, being the easiest to trigger accidentally while stepping around
  // — and the TV would then skip straight past it as "already done". The TV
  // now tells us exactly which single move it is asking for and we accept
  // only that one. `null` means "accept anything" and is just a safety
  // fallback for a TV that hasn't sent us a step yet.
  let expectedCalStep = null;
  let lastCalStepAt = 0;
  // A jump and a punch are both one sharp burst of motion, and the tail of
  // one can easily still be arriving when the next step appears. Without a
  // short deadline after each accepted step, a single physical movement
  // could satisfy two steps in a row and skip a prompt again by a different
  // route.
  const CAL_STEP_LOCKOUT_MS = 900;
  // If a move's detection just won't fire for this player, strict ordering
  // would trap them on that step. After a few seconds the phone offers a
  // per-move skip so they can always reach (and see) the remaining steps.
  const CAL_STUCK_HINT_MS = 6000;
  let calStuckTimer = null;

  const CAL_STEP_LABEL = {
    left: '⬅️ Step/lean LEFT',
    right: '➡️ Step/lean RIGHT',
    jump: '⬆️ JUMP',
    punch: '👊 PUNCH',
  };

  function handleCalStepRequest(msg) {
    expectedCalStep = msg && msg.step ? msg.step : null;
    calSkipStepBtn.style.display = 'none';
    if (calStuckTimer) clearTimeout(calStuckTimer);
    if (!expectedCalStep) {
      calibrationHint.textContent = 'All set! Starting on the TV — get into position.';
      calStartBtn.textContent = 'Start Run ✓';
      return;
    }
    const label = CAL_STEP_LABEL[expectedCalStep] || expectedCalStep;
    const n = typeof msg.index === 'number' ? msg.index + 1 : null;
    const total = msg.total || 4;
    calibrationHint.textContent = n
      ? 'Step ' + n + ' of ' + total + ' — do this now: ' + label
      : 'Do this now: ' + label;
    calStuckTimer = setTimeout(() => {
      calSkipStepBtn.textContent = 'Skip ' + label + ' ›';
      calSkipStepBtn.style.display = 'block';
    }, CAL_STUCK_HINT_MS);
  }

  function markCalDone(key) {
    if (calState[key]) return;
    // Only the move the TV is currently asking for counts.
    if (expectedCalStep && key !== expectedCalStep) return;
    const now = performance.now();
    if (now - lastCalStepAt < CAL_STEP_LOCKOUT_MS) return;
    lastCalStepAt = now;
    calState[key] = true;
    if (calStuckTimer) clearTimeout(calStuckTimer);
    calSkipStepBtn.style.display = 'none';
    if (navigator.vibrate) navigator.vibrate(15);
    sendCalibration('step', { step: key });
    if (Object.values(calState).every(Boolean)) {
      calStartBtn.textContent = 'Start Run ✓';
      calibrationHint.textContent = 'All set! Starting on the TV — get into position.';
    }
  }
  // Manual per-move escape hatch — reports the step as done exactly as a
  // detected move would, so the TV advances and the player still gets shown
  // every remaining step rather than having to abandon setup entirely.
  calSkipStepBtn.addEventListener('click', () => {
    if (!expectedCalStep) return;
    lastCalStepAt = 0;
    markCalDone(expectedCalStep);
  });
  function resetCalibration() {
    Object.keys(calState).forEach((k) => (calState[k] = false));
    expectedCalStep = null;
    lastCalStepAt = 0;
    if (calStuckTimer) clearTimeout(calStuckTimer);
    calSkipStepBtn.style.display = 'none';
    calStartBtn.textContent = 'Start Run →';
    calibrationHint.textContent = "👀 Look at your TV — it'll walk you through each move one at a time.";
  }

  // Ends setup and moves to the play screen. Normally driven by the TV now
  // (`calibration_control` / 'finish'), with the phone's own Skip setup /
  // Start Run buttons kept as a manual escape hatch — those can fire
  // mid-placement or mid-framing if the player would rather just get going,
  // so those gates are cleared here too or real play would stay stuck
  // undetected. `notifyTv: false` is used when the TV is the one that told
  // us to finish, so we don't echo the message straight back at it.
  function finishCalibration(opts) {
    inCameraSetupGate = false;
    framingActive = false;
    expectedCalStep = null;
    if (calStuckTimer) clearTimeout(calStuckTimer);
    calSkipStepBtn.style.display = 'none';
    if (!opts || opts.notifyTv !== false) sendCalibration('done');
    actionHandlers = realHandlers;
    moveSensorPanelTo(playSensorSlot);
    showScreen(playScreen);
  }
  // Wrapped rather than passed directly: these are click handlers, so the
  // MouseEvent would otherwise land in finishCalibration's `opts`.
  calStartBtn.addEventListener('click', () => finishCalibration());
  calSkipBtn.addEventListener('click', () => finishCalibration());

  function recenter() {
    if (currentMode === 'camera') {
      poseCenterX = null;
      poseHipYBaseline = null;
      cameraLaneZone = 0;
    } else {
      baselineGamma = null;
      tiltLaneZone = 0;
    }
    showToast('Recentered!');
  }
  calRecenterBtn.addEventListener('click', recenter);
  calibrateBtn.addEventListener('click', recenter);

  // =========================================================================
  // ACTION INDIRECTION — calibration screen marks a checklist item instead
  // of sending anything to the TV; the play screen sends for real.
  // =========================================================================
  let lastJumpTime = 0;
  let lastPunchTime = 0;
  let lastActionTime = 0;

  function fireJump(opts) {
    const now = performance.now();
    lastJumpTime = now;
    lastActionTime = now;
    sendInput('jump', undefined, opts);
    pulseAction(jumpBtn);
    if (navigator.vibrate) navigator.vibrate(30);
  }
  function firePunch(opts) {
    const now = performance.now();
    lastPunchTime = now;
    lastActionTime = now;
    sendInput('punch', undefined, opts);
    pulseAction(punchBtn);
    if (navigator.vibrate) navigator.vibrate([20, 30, 20]);
  }
  // A direct tap of the on-screen Jump/Punch button is always "explicit" —
  // see sendInput()'s comment above.
  jumpBtn.addEventListener('click', () => fireJump({ explicit: true }));
  punchBtn.addEventListener('click', () => firePunch({ explicit: true }));

  // Pause/Exit — a manual, always-reliable path to the same pause/exit
  // functionality the Fire TV remote's Back button also drives on the TV
  // side (see tv/game.js). We can't be sure every remote's Back button
  // reaches the page the way we expect (same open question as the
  // OK/Select button — see the big header comment in tv/game.js), so this
  // phone button is the guaranteed fallback, not an afterthought.
  pauseBtn.addEventListener('click', () => {
    sendInput('pause_toggle');
    if (navigator.vibrate) navigator.vibrate(15);
  });
  exitBtn.addEventListener('click', () => {
    sendInput('exit_to_menu');
    if (navigator.vibrate) navigator.vibrate([15, 40, 15]);
  });

  const realHandlers = {
    lane: (dir) => sendInput('lane', dir),
    laneZone: (zone) => sendInput('lane_set', zone),
    // Gesture-triggered — deliberately NOT explicit (see sendInput()), so a
    // stray pose/motion false-positive can't start or retry a run on its
    // own. Once a run is actually in progress these still work exactly the
    // same as a button tap for real gameplay jumps/punches.
    jump: () => fireJump(),
    punch: () => firePunch(),
  };
  const calHandlers = {
    lane: (dir) => markCalDone(dir < 0 ? 'left' : 'right'),
    laneZone: (zone) => {
      if (zone === -1) markCalDone('left');
      else if (zone === 1) markCalDone('right');
    },
    jump: () => markCalDone('jump'),
    punch: () => markCalDone('punch'),
  };
  let actionHandlers = calHandlers;

  let detectionEnabled = true;
  motionToggleBtn.addEventListener('click', () => {
    detectionEnabled = !detectionEnabled;
    motionToggleBtn.textContent = `Detection: ${detectionEnabled ? 'On' : 'Off'}`;
  });

  // =========================================================================
  // 5. MODE SWITCHING (used both to enter calibration and to switch mid-play)
  // =========================================================================
  // 'camera' and 'hold' are the two motion-tracking modes; 'pad' is the
  // phone used as a plain game controller (no sensors at all).
  let currentMode = null; // 'camera' | 'hold' | 'pad'
  const MODE_LABEL = { camera: 'Camera mode', hold: 'Hold-phone mode', pad: 'Controller mode' };

  async function setMode(mode) {
    if (mode === currentMode) return;
    if (mode === 'camera') {
      try {
        await startCamera();
      } catch (e) {
        showToast('Camera unavailable — using hold-phone mode.');
        mode = 'hold';
      }
    }
    if (mode === currentMode) return;
    const prev = currentMode;
    currentMode = mode;

    tabCamera.classList.toggle('active', mode === 'camera');
    tabHold.classList.toggle('active', mode === 'hold');
    tabPad.classList.toggle('active', mode === 'pad');
    cameraView.style.display = mode === 'camera' ? 'block' : 'none';
    tiltZone.style.display = mode === 'hold' ? 'flex' : 'none';

    if (mode === 'camera') {
      stopMotionListeners();
    } else if (mode === 'hold') {
      stopCamera();
      startMotionListeners();
      // Switching away from camera mode (e.g. tapping the "Hold phone" tab
      // mid-setup) means there's no more camera to place or frame — don't
      // leave a stale gate blocking hold-phone detection.
      inCameraSetupGate = false;
      framingActive = false;
    } else {
      // Controller mode: no camera, no motion listeners, nothing to detect.
      stopCamera();
      stopMotionListeners();
      inCameraSetupGate = false;
      framingActive = false;
    }
    if (prev) showToast(MODE_LABEL[mode]);
    updateFullscreenCam();
  }

  tabCamera.addEventListener('click', () => setMode('camera'));
  tabHold.addEventListener('click', () => setMode('hold'));
  tabPad.addEventListener('click', () => setMode('pad'));

  // Controller-mode lane buttons. Deliberately absolute (`lane_set`, the
  // same message the motion modes' zone tracking sends) rather than relative
  // nudges, so there's never a mismatch between the button you pressed and
  // the lane you're actually in.
  function padLane(zone, btn) {
    sendInput('lane_set', zone);
    [laneLeftBtn, laneCentreBtn, laneRightBtn].forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    if (navigator.vibrate) navigator.vibrate(10);
  }
  laneLeftBtn.addEventListener('click', () => padLane(-1, laneLeftBtn));
  laneCentreBtn.addEventListener('click', () => padLane(0, laneCentreBtn));
  laneRightBtn.addEventListener('click', () => padLane(1, laneRightBtn));

  // Motion modes have no Jump/Punch buttons any more, so this is their
  // guaranteed non-remote way to start or retry a run. An explicit jump is
  // exactly what the TV accepts as a deliberate "begin" (see sendInput()).
  startRunBtn.addEventListener('click', () => fireJump({ explicit: true }));

  function tapToSteer(e, zone) {
    const rect = zone.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    actionHandlers.lane(x < rect.width / 2 ? -1 : 1);
    pulseAction(zone);
  }
  tiltZone.addEventListener('click', (e) => tapToSteer(e, tiltZone));
  cameraView.addEventListener('click', (e) => tapToSteer(e, cameraView));

  // =========================================================================
  // CAMERA / POSE-TRACKING
  // =========================================================================
  let cameraStream = null;
  let libsLoadedPromise = null;
  let detector = null;
  let poseLoopRunning = false;
  let poseCenterX = null;
  let poseHipYBaseline = null;
  // Absolute lane zone the player's body is currently in: -1 left, 0
  // center, 1 right. Recomputed every frame from raw position (with
  // ENTER/EXIT hysteresis), not stepped/toggled — so standing back in a
  // neutral stance always lands you back at 0 (center lane) on its own.
  let cameraLaneZone = 0;
  let lastWrist = { left: null, right: null };

  // Shared absolute-zone hysteresis: harder to leave center (ENTER) than to
  // return to it (EXIT), so a normal centered stance reliably snaps you
  // back to lane 0 without needing an exaggerated opposite-direction step.
  function computeZone(p, currentZone, enter, exit) {
    if (currentZone === 0) {
      if (p > enter) return -1;
      if (p < -enter) return 1;
      return 0;
    }
    if (currentZone === -1) {
      if (p < -enter) return 1;
      if (p < exit) return 0;
      return -1;
    }
    // currentZone === 1
    if (p > enter) return -1;
    if (p > -exit) return 0;
    return 1;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }
  function loadPoseLibs() {
    if (!libsLoadedPromise) {
      libsLoadedPromise = (async () => {
        await loadScript(TFJS_URL);
        await loadScript(POSE_DETECTION_URL);
        await tf.setBackend('webgl');
        await tf.ready();
      })();
    }
    return libsLoadedPromise;
  }
  async function ensureDetector() {
    if (detector) return detector;
    await loadPoseLibs();
    detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
      runtime: 'tfjs',
      modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
    });
    return detector;
  }
  async function startCamera() {
    cameraStatus.textContent = 'Starting camera…';
    cameraView.style.display = 'block';

    if (!cameraStream) {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      cameraVideo.srcObject = cameraStream;
      await new Promise((resolve) => {
        cameraVideo.onloadedmetadata = () => { cameraVideo.play(); resolve(); };
      });
    }
    syncOverlayCanvas();

    cameraStatus.textContent = 'Loading pose tracker…';
    await ensureDetector();
    cameraStatus.textContent = 'Step into frame';

    if (!poseLoopRunning) {
      poseLoopRunning = true;
      poseLoop();
    }
  }
  function stopCamera() {
    poseLoopRunning = false;
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
  }

  let lastPoseT = 0;
  async function poseLoop() {
    if (!poseLoopRunning) return;
    const now = performance.now();
    if (now - lastPoseT < 1000 / POSE_TARGET_FPS) {
      requestAnimationFrame(poseLoop);
      return;
    }
    lastPoseT = now;
    try {
      const poses = await detector.estimatePoses(cameraVideo, { maxPoses: 1, flipHorizontal: false });
      processPose(poses[0]);
    } catch (e) {
      // transient — skip this frame
    }
    requestAnimationFrame(poseLoop);
  }

  function kp(keypoints, name) {
    const p = keypoints.find((k) => k.name === name);
    return p && p.score >= POSE_MIN_SCORE ? p : null;
  }
  function midpoint(a, b) {
    if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return a || b || null;
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function processPose(pose) {
    clearOverlay();
    if (!pose || !pose.keypoints) {
      drawFramingGuide(false);
      cameraStatus.textContent = 'Step into frame';
      if (framingActive) sendFramingThrottled('no_person', false);
      return;
    }
    const keypoints = pose.keypoints;

    const lShoulder = kp(keypoints, 'left_shoulder');
    const rShoulder = kp(keypoints, 'right_shoulder');
    const lHip = kp(keypoints, 'left_hip');
    const rHip = kp(keypoints, 'right_hip');
    const shoulderMid = midpoint(lShoulder, rShoulder);
    const hipMid = midpoint(lHip, rHip);
    // "Locked" = the tracker has a full torso, which is what every gesture
    // is measured against. Drives the overlay colour so the player can see
    // at a glance whether they're actually being tracked.
    const locked = !!(shoulderMid && hipMid);
    drawFramingGuide(locked);
    drawSkeleton(keypoints, locked);
    if (!locked) {
      cameraStatus.textContent = 'Step into frame';
      if (framingActive) sendFramingThrottled('no_person', false);
      return;
    }
    cameraStatus.textContent = '';

    const torsoScale = Math.max(20, dist(shoulderMid, hipMid));

    if (framingActive) {
      // Still working through the placement/framing handshake with the TV
      // — evaluate & report how well-framed the player is, but don't ALSO
      // run real lane/jump/punch detection on top of that (see the big
      // header comment for why).
      evaluateFraming(keypoints, hipMid, torsoScale);
      return;
    }
    if (inCameraSetupGate) return; // still on the "place your phone" step — camera's warming up, nothing to detect yet
    if (!detectionEnabled) return;

    // Lane (absolute: which zone is the player's body in right now).
    // NOTE the sign convention: the camera feed is mirrored for display
    // (see `transform: scaleX(-1)` in CSS) so it feels like a selfie
    // mirror, but pose detection runs on the RAW (unmirrored) video frame.
    // So the player's real left is +x in raw coordinates, meaning a
    // positive dx (hips moved toward larger raw-x) corresponds to the
    // player's own left, hence zone -1.
    if (poseCenterX === null) poseCenterX = hipMid.x;
    const dx = hipMid.x - poseCenterX;
    const frameW = cameraVideo.videoWidth;
    updateLaneMarker(dx, frameW);

    const nextZone = computeZone(dx / frameW, cameraLaneZone, LANE_ENTER_FRAC, LANE_EXIT_FRAC);
    if (nextZone !== cameraLaneZone) {
      cameraLaneZone = nextZone;
      actionHandlers.laneZone(cameraLaneZone);
    }

    // Jump (hips rise)
    if (poseHipYBaseline === null) poseHipYBaseline = hipMid.y;
    const rise = poseHipYBaseline - hipMid.y;
    const now = performance.now();
    if (rise > JUMP_TRIGGER_TORSO_FRAC * torsoScale && now - lastJumpTime > JUMP_COOLDOWN_MS && now - lastActionTime > CROSS_TALK_LOCK_MS) {
      lastJumpTime = now;
      lastActionTime = now;
      actionHandlers.jump();
    } else if (now - lastJumpTime > JUMP_COOLDOWN_MS) {
      poseHipYBaseline = poseHipYBaseline * 0.94 + hipMid.y * 0.06;
    }

    // Punch (fast wrist extension)
    checkPunch('left', kp(keypoints, 'left_wrist'), lShoulder, torsoScale, now);
    checkPunch('right', kp(keypoints, 'right_wrist'), rShoulder, torsoScale, now);
  }

  // Reports whether enough of the player is visible, at a sensible
  // distance, roughly centered — everything the TV's silhouette guide
  // needs to tell the player "step back" / "come closer" / "you're set".
  // There's no real-world distance measurement available (no known camera
  // focal length), so "too close/far" is inferred from torso height as a
  // fraction of the frame — untested against a real phone camera, same
  // caveat as the rest of this file's thresholds (see header comment).
  function evaluateFraming(keypoints, hipMid, torsoScale) {
    const frameW = cameraVideo.videoWidth;
    const frameH = cameraVideo.videoHeight;
    const nose = kp(keypoints, 'nose');

    let status;
    const torsoFrac = torsoScale / frameH;
    const centerOffsetFrac = Math.abs(hipMid.x - frameW / 2) / frameW;

    if (!nose) status = 'no_person';
    else if (torsoFrac > FRAMING_TOO_CLOSE_FRAC) status = 'too_close';
    else if (torsoFrac < FRAMING_TOO_FAR_FRAC) status = 'too_far';
    else if (centerOffsetFrac > FRAMING_OFFCENTER_FRAC) status = 'off_center';
    else status = 'good';

    const now = performance.now();
    if (status === 'good') {
      if (framingGoodStreakStart === null) framingGoodStreakStart = now;
    } else {
      framingGoodStreakStart = null;
    }
    const ready = status === 'good' && framingGoodStreakStart !== null && now - framingGoodStreakStart > FRAMING_GOOD_HOLD_MS;

    sendFramingThrottled(status, ready);
  }

  // Throttled so a jittery status doesn't flood the WebSocket — but a
  // freshly-"ready" reading always goes through immediately so the TV's
  // auto-advance timer starts on time.
  function sendFramingThrottled(status, ready) {
    const now = performance.now();
    if (ready || now - lastFramingSentT > FRAMING_SEND_INTERVAL_MS) {
      lastFramingSentT = now;
      sendCalibration('framing', { status, ready });
    }
  }

  function checkPunch(side, wrist, shoulder, torsoScale, now) {
    if (!wrist || !shoulder) { lastWrist[side] = null; return; }
    const prev = lastWrist[side];
    lastWrist[side] = { x: wrist.x, y: wrist.y, t: now };
    if (!prev) return;

    const dt = (now - prev.t) / 1000;
    if (dt <= 0 || dt > 0.5) return;
    const speed = Math.hypot(wrist.x - prev.x, wrist.y - prev.y) / dt;
    const extension = dist(wrist, shoulder) / torsoScale;

    // Calibration practice punches use the original, more forgiving
    // thresholds — see the CAL_PUNCH_* comment up top for why.
    const calibrating = actionHandlers === calHandlers;
    const velocityThresh = calibrating ? CAL_PUNCH_VELOCITY_TORSO_FRAC : PUNCH_VELOCITY_TORSO_FRAC;
    const extensionThresh = calibrating ? CAL_PUNCH_EXTENSION_FRAC : PUNCH_EXTENSION_FRAC;
    const cooldown = calibrating ? CAL_PUNCH_COOLDOWN_MS : PUNCH_COOLDOWN_MS;

    if (
      speed > velocityThresh * torsoScale &&
      extension > extensionThresh &&
      now - lastPunchTime > cooldown &&
      now - lastActionTime > CROSS_TALK_LOCK_MS
    ) {
      lastPunchTime = now;
      lastActionTime = now;
      actionHandlers.punch();
    }
  }

  function updateLaneMarker(dx, frameW) {
    const frac = Math.max(-1, Math.min(1, dx / (frameW * 0.35)));
    laneMarker.style.left = `${50 - frac * 50}%`;
    laneMarker.style.background = Math.abs(dx) > LANE_ENTER_FRAC * frameW ? '#ffd166' : '#6ee7ff';
  }

  // =========================================================================
  // POSE OVERLAY — 2026-09-03 alignment fix
  //
  // The skeleton is drawn in the canvas's OWN displayed pixels, and pose
  // keypoints (which come back in the raw video frame's coordinate space)
  // are mapped into that space here. Two things have to be undone to make
  // them line up with what the player actually sees:
  //   1. the video is displayed with `object-fit: cover`, i.e. scaled up by
  //      whichever axis needs it most and centre-cropped on the other, and
  //   2. it's mirrored horizontally so it reads like a selfie mirror.
  // Previously the canvas leaned on the browser to reproduce (1) via its own
  // `object-fit` and (2) via a CSS transform. That only lines up while the
  // canvas bitmap's aspect ratio exactly matches the live video's — and it
  // often doesn't (the bitmap was sized once at stream start, so any later
  // resolution change, rotation, or a stream that didn't honour the
  // requested 640x480 left it stale), which is what put the mesh off the
  // body. Doing the mapping explicitly here removes that whole class of
  // mismatch, and also lets the overlay be re-sized on rotation.
  // =========================================================================
  let overlayW = 0, overlayH = 0, overlayDpr = 1;

  function syncOverlayCanvas() {
    const cssW = cameraCanvas.clientWidth;
    const cssH = cameraCanvas.clientHeight;
    if (!cssW || !cssH) return false;
    // Cap the backing store — this canvas is redrawn every pose frame and
    // there's no detail here that needs full retina resolution.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cssW !== overlayW || cssH !== overlayH || dpr !== overlayDpr) {
      overlayW = cssW; overlayH = cssH; overlayDpr = dpr;
      cameraCanvas.width = Math.round(cssW * dpr);
      cameraCanvas.height = Math.round(cssH * dpr);
    }
    return true;
  }
  window.addEventListener('resize', syncOverlayCanvas);
  window.addEventListener('orientationchange', () => setTimeout(syncOverlayCanvas, 250));

  // Maps a point from raw video-frame coordinates to displayed CSS pixels,
  // applying the same cover-crop the video gets and the same mirroring.
  function videoToDisplay(x, y) {
    const vw = cameraVideo.videoWidth || 1;
    const vh = cameraVideo.videoHeight || 1;
    const scale = Math.max(overlayW / vw, overlayH / vh); // object-fit: cover
    const drawnW = vw * scale;
    const drawnH = vh * scale;
    const ox = (overlayW - drawnW) / 2; // centre-crop offsets (negative = cropped)
    const oy = (overlayH - drawnH) / 2;
    return {
      x: overlayW - (x * scale + ox), // mirrored, matching the video's scaleX(-1)
      y: y * scale + oy,
    };
  }

  function clearOverlay() {
    if (!syncOverlayCanvas()) return;
    cameraCtx.setTransform(1, 0, 0, 1, 0, 0);
    cameraCtx.clearRect(0, 0, cameraCanvas.width, cameraCanvas.height);
    cameraCtx.setTransform(overlayDpr, 0, 0, overlayDpr, 0, 0);
  }

  // A dashed head-to-hips target box, so lining yourself up is a matter of
  // stepping into an outline rather than guessing. Turns cyan once the
  // tracker actually has your torso, which doubles as a "it can see me"
  // signal without needing to look at the TV.
  function drawFramingGuide(locked) {
    const w = overlayW, h = overlayH;
    const boxH = h * 0.72;
    const boxW = Math.min(w * 0.5, boxH * 0.52);
    const x = (w - boxW) / 2;
    const y = (h - boxH) / 2;
    cameraCtx.save();
    cameraCtx.setLineDash([10, 9]);
    cameraCtx.lineWidth = 2.5;
    cameraCtx.strokeStyle = locked ? 'rgba(110,231,255,0.85)' : 'rgba(255,255,255,0.35)';
    cameraCtx.strokeRect(x, y, boxW, boxH);
    cameraCtx.restore();
  }

  function drawSkeleton(keypoints, locked) {
    const pts = {};
    keypoints.forEach((p) => {
      if (p.score >= POSE_MIN_SCORE) pts[p.name] = videoToDisplay(p.x, p.y);
    });

    // Dark under-stroke first so the mesh stays readable over a bright or
    // busy background — the old thin single-pass line was easy to lose.
    cameraCtx.lineCap = 'round';
    cameraCtx.lineJoin = 'round';
    [['rgba(0,0,0,0.45)', 9], [locked ? 'rgba(110,231,255,0.95)' : 'rgba(255,209,102,0.95)', 5]]
      .forEach(([colour, width]) => {
        cameraCtx.strokeStyle = colour;
        cameraCtx.lineWidth = width;
        cameraCtx.beginPath();
        SKELETON_PAIRS.forEach(([a, b]) => {
          const pa = pts[a], pb = pts[b];
          if (pa && pb) {
            cameraCtx.moveTo(pa.x, pa.y);
            cameraCtx.lineTo(pb.x, pb.y);
          }
        });
        cameraCtx.stroke();
      });

    Object.values(pts).forEach((p) => {
      cameraCtx.beginPath();
      cameraCtx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      cameraCtx.fillStyle = 'rgba(0,0,0,0.5)';
      cameraCtx.fill();
      cameraCtx.beginPath();
      cameraCtx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      cameraCtx.fillStyle = '#fff';
      cameraCtx.fill();
    });
  }

  // =========================================================================
  // HOLD-PHONE (ACCELEROMETER) MODE
  // =========================================================================
  let gravity = { x: 0, y: 0, z: 0 };
  let gravityInit = false;
  let baselineGamma = null;
  // Same absolute-zone idea as cameraLaneZone, in degrees of tilt.
  let tiltLaneZone = 0;
  let motionListenersAttached = false;

  function needsIOSPermission() {
    return typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';
  }

  async function startMotionListeners() {
    if (motionListenersAttached) return;
    if (needsIOSPermission()) {
      try {
        const motionResp = await DeviceMotionEvent.requestPermission();
        let orientationResp = 'granted';
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
          orientationResp = await DeviceOrientationEvent.requestPermission();
        }
        if (motionResp !== 'granted' || orientationResp !== 'granted') {
          showToast('Motion permission denied — use tap-to-steer and the buttons.');
          return;
        }
      } catch {
        showToast('Could not enable motion sensors — use tap-to-steer and the buttons.');
        return;
      }
    }
    window.addEventListener('devicemotion', onDeviceMotion);
    window.addEventListener('deviceorientation', onDeviceOrientation);
    motionListenersAttached = true;
  }
  function stopMotionListeners() {
    if (!motionListenersAttached) return;
    window.removeEventListener('devicemotion', onDeviceMotion);
    window.removeEventListener('deviceorientation', onDeviceOrientation);
    motionListenersAttached = false;
  }

  function onDeviceOrientation(e) {
    if (e.gamma === null) return;
    if (baselineGamma === null) baselineGamma = e.gamma;
    const diff = e.gamma - baselineGamma;

    const clamped = Math.max(-45, Math.min(45, diff));
    tiltMarker.style.transform = `translate(calc(-50% + ${clamped * 3}px), -50%)`;
    tiltMarker.style.background = Math.abs(diff) > TILT_ENTER_DEG ? '#ffd166' : '#6ee7ff';

    if (!detectionEnabled) return;
    // Same sign convention as before this rewrite: leaning right (diff > 0)
    // is zone 1, leaning left (diff < 0) is zone -1 — computeZone()'s
    // default polarity is the other way round, so we negate diff here.
    const nextZone = computeZone(-diff, tiltLaneZone, TILT_ENTER_DEG, TILT_EXIT_DEG);
    if (nextZone !== tiltLaneZone) {
      tiltLaneZone = nextZone;
      actionHandlers.laneZone(tiltLaneZone);
      pulseAction(tiltZone);
    }
  }

  function onDeviceMotion(e) {
    const usePreFiltered = e.acceleration && e.acceleration.x !== null;
    let ax, ay, az, mag;
    if (usePreFiltered) {
      const { x, y, z } = e.acceleration;
      ax = x; ay = y; az = z;
      mag = Math.sqrt(x * x + y * y + z * z);
    } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x !== null) {
      const raw = e.accelerationIncludingGravity;
      if (!gravityInit) { gravity = { x: raw.x, y: raw.y, z: raw.z }; gravityInit = true; }
      gravity.x = gravity.x * GRAVITY_LOWPASS + raw.x * (1 - GRAVITY_LOWPASS);
      gravity.y = gravity.y * GRAVITY_LOWPASS + raw.y * (1 - GRAVITY_LOWPASS);
      gravity.z = gravity.z * GRAVITY_LOWPASS + raw.z * (1 - GRAVITY_LOWPASS);
      ax = raw.x - gravity.x; ay = raw.y - gravity.y; az = raw.z - gravity.z;
      mag = Math.sqrt(ax * ax + ay * ay + az * az);
    } else {
      return;
    }

    let rot = 0;
    const hasRotation = e.rotationRate && e.rotationRate.alpha !== null;
    if (hasRotation) {
      const { alpha, beta, gamma } = e.rotationRate;
      rot = Math.sqrt((alpha || 0) ** 2 + (beta || 0) ** 2 + (gamma || 0) ** 2);
    }

    if (!detectionEnabled) return;
    const now = performance.now();
    if (now - lastActionTime < CROSS_TALK_LOCK_MS) return;

    // 2026-09-02 "punch still not there during setup" fix: the old logic
    // below checked ONLY the overall acceleration magnitude to decide
    // "jump", and rotationRate (hasRotation/rot) was meant to be the
    // tie-breaker against punches — but rotationRate is commonly
    // null/unavailable on real Android browsers, so `!hasRotation` was
    // true on most real devices, which made the jump check fire (and
    // `return` before the punch code below ever ran) for ANY hard motion,
    // including punches, since a real punch's accelerometer magnitude
    // very often also clears MOTION_JUMP_TRIGGER. That fully explains why
    // round 4's calibration-only punch *threshold* loosening had no felt
    // effect — the punch branch was frequently unreachable, not
    // insensitive. Fix: use the accelerometer's own axis split as the
    // primary jump/punch disambiguator (always available, unlike
    // rotationRate) — a jump moves the whole body, and the phone with it,
    // up/down along the phone's held-upright long axis (Y), while a punch
    // is a forward/lateral jab, dominant on X/Z, not Y. rotationRate is
    // still used as a secondary hint on devices that do report it.
    const verticalMag = Math.abs(ay);
    const lateralMag = Math.sqrt(ax * ax + az * az);
    const looksVertical = verticalMag >= lateralMag * MOTION_VERTICAL_DOMINANCE;

    if (mag > MOTION_JUMP_TRIGGER && now - lastJumpTime > MOTION_JUMP_COOLDOWN_MS) {
      const rotationSaysJump = !hasRotation || rot < MOTION_ROTATION_LOW;
      if (looksVertical && rotationSaysJump) {
        lastJumpTime = now; lastActionTime = now;
        actionHandlers.jump();
        return;
      }
    }
    // Calibration practice punches use the original, more forgiving
    // trigger/cooldown — see the CAL_PUNCH_*/CAL_MOTION_PUNCH_* comments
    // up top for why. The MOTION_JUMP_TRIGGER comparison just below stays
    // the same real trigger in both cases — it's only disambiguating "was
    // this reading big enough to also look like a jump", not part of the
    // punch sensitivity itself.
    const calibrating = actionHandlers === calHandlers;
    const punchTrigger = calibrating ? CAL_MOTION_PUNCH_TRIGGER : MOTION_PUNCH_TRIGGER;
    const punchCooldown = calibrating ? CAL_MOTION_PUNCH_COOLDOWN_MS : MOTION_PUNCH_COOLDOWN_MS;
    if (mag > punchTrigger && now - lastPunchTime > punchCooldown) {
      const rotationSaysPunch = !hasRotation || rot >= MOTION_ROTATION_LOW || mag <= MOTION_JUMP_TRIGGER;
      if (!looksVertical || rotationSaysPunch) {
        lastPunchTime = now; lastActionTime = now;
        actionHandlers.punch();
      }
    }
  }

  // Prevent double-tap-to-zoom / accidental scrolling during play — but
  // NOT inside #characterScreen, which relies on native touch scrolling
  // (overflow-y: auto) to reach Hat/Shirt/Continue below the fold on
  // shorter phone screens. Every other screen is a fixed, non-scrolling
  // layout, so blocking touchmove there is safe and intentional.
  document.addEventListener('touchmove', (e) => {
    if (e.target.closest('#characterScreen')) return;
    e.preventDefault();
  }, { passive: false });

  showScreen(characterScreen);
})();
