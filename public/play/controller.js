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
// same way as in real play, but routed to the on-screen checklist instead
// of the TV — otherwise a practice jump would prematurely start the run
// (the TV starts the game on its first real jump/punch input). See
// `actionHandlers` below for that indirection.
//
// NOTE ON TUNING: none of the gesture-detection thresholds (camera or
// accelerometer) were tuned against a real phone or camera feed — this
// build environment has neither attached. They're reasoned starting
// points; the calibration screen exists specifically so you can see
// whether they need adjusting on your actual device before playing.

(() => {
  // ==== Tunable thresholds ================================================
  const POSE_MIN_SCORE = 0.35;
  const LANE_TRIGGER_FRAC = 0.10;
  const LANE_RESET_FRAC = 0.045;
  const JUMP_TRIGGER_TORSO_FRAC = 0.55;
  const JUMP_COOLDOWN_MS = 550;
  const PUNCH_EXTENSION_FRAC = 0.75;
  const PUNCH_VELOCITY_TORSO_FRAC = 3.2;
  const PUNCH_COOLDOWN_MS = 500;
  const POSE_TARGET_FPS = 20;

  const TILT_TRIGGER_DEG = 18;
  const TILT_RESET_DEG = 8;
  const MOTION_JUMP_TRIGGER = 20;
  const MOTION_PUNCH_TRIGGER = 13;
  const MOTION_ROTATION_LOW = 250;
  const MOTION_JUMP_COOLDOWN_MS = 550;
  const MOTION_PUNCH_COOLDOWN_MS = 550;
  const CROSS_TALK_LOCK_MS = 150;
  const GRAVITY_LOWPASS = 0.85;

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
  const checkLeftLabel = document.getElementById('checkLeftLabel');
  const checkRightLabel = document.getElementById('checkRightLabel');
  const calSkipBtn = document.getElementById('calSkipBtn');
  const calStartBtn = document.getElementById('calStartBtn');

  const tabCamera = document.getElementById('tabCamera');
  const tabHold = document.getElementById('tabHold');
  const playSensorSlot = document.getElementById('playSensorSlot');
  const jumpBtn = document.getElementById('jumpBtn');
  const punchBtn = document.getElementById('punchBtn');
  const motionToggleBtn = document.getElementById('motionToggleBtn');
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
    [characterScreen, joinScreen, permScreen, calibrationScreen, playScreen].forEach((s) => (s.style.display = 'none'));
    el.style.display = 'flex';
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
        showScreen(permScreen);
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

  function sendInput(action, value) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'input', action, value }));
  }
  function sendCharacter() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'character', ...character }));
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
  grantCameraBtn.addEventListener('click', () => beginCalibration('camera'));
  skipCameraBtn.addEventListener('click', () => beginCalibration('hold'));

  async function beginCalibration(mode) {
    resetCalibration();
    actionHandlers = calHandlers;
    moveSensorPanelTo(calSensorSlot);
    showScreen(calibrationScreen);
    await setMode(mode);
    updateCalLabels(currentMode);
  }

  const calState = { left: false, right: false, jump: false, punch: false };
  const CAL_ITEM_IDS = { left: 'checkLeft', right: 'checkRight', jump: 'checkJump', punch: 'checkPunch' };
  const CAL_ITEM_NUMS = { left: '1', right: '2', jump: '3', punch: '4' };

  function markCalDone(key) {
    if (calState[key]) return;
    calState[key] = true;
    const el = document.getElementById(CAL_ITEM_IDS[key]);
    el.classList.add('done');
    el.querySelector('.mark').textContent = '✓';
    if (navigator.vibrate) navigator.vibrate(15);
    if (Object.values(calState).every(Boolean)) {
      calStartBtn.textContent = 'Start Run ✓';
      calibrationHint.textContent = 'All set! Tap Start Run whenever you\'re ready.';
    }
  }
  function resetCalibration() {
    Object.keys(calState).forEach((k) => (calState[k] = false));
    Object.entries(CAL_ITEM_IDS).forEach(([key, id]) => {
      const el = document.getElementById(id);
      el.classList.remove('done');
      el.querySelector('.mark').textContent = CAL_ITEM_NUMS[key];
    });
    calStartBtn.textContent = 'Start Run →';
    calibrationHint.textContent = "Try each move below — we'll check it off once we see it.";
  }
  function updateCalLabels(mode) {
    const verb = mode === 'camera' ? 'Step' : 'Lean';
    checkLeftLabel.textContent = `${verb} left`;
    checkRightLabel.textContent = `${verb} right`;
  }

  function finishCalibration() {
    actionHandlers = realHandlers;
    moveSensorPanelTo(playSensorSlot);
    showScreen(playScreen);
  }
  calStartBtn.addEventListener('click', finishCalibration);
  calSkipBtn.addEventListener('click', finishCalibration);

  function recenter() {
    if (currentMode === 'camera') {
      poseCenterX = null;
      poseHipYBaseline = null;
    } else {
      baselineGamma = null;
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

  function fireJump() {
    const now = performance.now();
    lastJumpTime = now;
    lastActionTime = now;
    sendInput('jump');
    pulseAction(jumpBtn);
    if (navigator.vibrate) navigator.vibrate(30);
  }
  function firePunch() {
    const now = performance.now();
    lastPunchTime = now;
    lastActionTime = now;
    sendInput('punch');
    pulseAction(punchBtn);
    if (navigator.vibrate) navigator.vibrate([20, 30, 20]);
  }
  jumpBtn.addEventListener('click', fireJump);
  punchBtn.addEventListener('click', firePunch);

  const realHandlers = {
    lane: (dir) => sendInput('lane', dir),
    jump: () => fireJump(),
    punch: () => firePunch(),
  };
  const calHandlers = {
    lane: (dir) => markCalDone(dir < 0 ? 'left' : 'right'),
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
  let currentMode = null; // 'camera' | 'hold'

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
    cameraView.style.display = mode === 'camera' ? 'block' : 'none';
    tiltZone.style.display = mode === 'hold' ? 'flex' : 'none';

    if (mode === 'camera') {
      stopMotionListeners();
    } else {
      stopCamera();
      startMotionListeners();
    }
    if (prev) showToast(mode === 'camera' ? 'Camera mode' : 'Hold-phone mode');
  }

  tabCamera.addEventListener('click', () => setMode('camera'));
  tabHold.addEventListener('click', () => setMode('hold'));

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
  let laneArmedCam = true;
  let lastWrist = { left: null, right: null };

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
      cameraCanvas.width = cameraVideo.videoWidth;
      cameraCanvas.height = cameraVideo.videoHeight;
    }

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
    cameraCtx.clearRect(0, 0, cameraCanvas.width, cameraCanvas.height);
    if (!pose || !pose.keypoints) { cameraStatus.textContent = 'Step into frame'; return; }
    const keypoints = pose.keypoints;
    drawSkeleton(keypoints);

    const lShoulder = kp(keypoints, 'left_shoulder');
    const rShoulder = kp(keypoints, 'right_shoulder');
    const lHip = kp(keypoints, 'left_hip');
    const rHip = kp(keypoints, 'right_hip');
    const shoulderMid = midpoint(lShoulder, rShoulder);
    const hipMid = midpoint(lHip, rHip);
    if (!shoulderMid || !hipMid) { cameraStatus.textContent = 'Step into frame'; return; }
    cameraStatus.textContent = '';

    const torsoScale = Math.max(20, dist(shoulderMid, hipMid));
    if (!detectionEnabled) return;

    // Lane (step left/right) — see the sign-convention note in README/comments below.
    if (poseCenterX === null) poseCenterX = hipMid.x;
    const dx = hipMid.x - poseCenterX;
    const frameW = cameraVideo.videoWidth;
    updateLaneMarker(dx, frameW);

    if (laneArmedCam && dx > LANE_TRIGGER_FRAC * frameW) {
      actionHandlers.lane(-1); // stepped to your left
      laneArmedCam = false;
    } else if (laneArmedCam && dx < -LANE_TRIGGER_FRAC * frameW) {
      actionHandlers.lane(1); // stepped to your right
      laneArmedCam = false;
    } else if (!laneArmedCam && Math.abs(dx) < LANE_RESET_FRAC * frameW) {
      laneArmedCam = true;
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

  function checkPunch(side, wrist, shoulder, torsoScale, now) {
    if (!wrist || !shoulder) { lastWrist[side] = null; return; }
    const prev = lastWrist[side];
    lastWrist[side] = { x: wrist.x, y: wrist.y, t: now };
    if (!prev) return;

    const dt = (now - prev.t) / 1000;
    if (dt <= 0 || dt > 0.5) return;
    const speed = Math.hypot(wrist.x - prev.x, wrist.y - prev.y) / dt;
    const extension = dist(wrist, shoulder) / torsoScale;

    if (
      speed > PUNCH_VELOCITY_TORSO_FRAC * torsoScale &&
      extension > PUNCH_EXTENSION_FRAC &&
      now - lastPunchTime > PUNCH_COOLDOWN_MS &&
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
    laneMarker.style.background = Math.abs(dx) > LANE_TRIGGER_FRAC * frameW ? '#ffd166' : '#6ee7ff';
  }

  function drawSkeleton(keypoints) {
    cameraCtx.lineWidth = 3;
    cameraCtx.strokeStyle = 'rgba(110, 231, 255, 0.85)';
    SKELETON_PAIRS.forEach(([a, b]) => {
      const pa = kp(keypoints, a), pb = kp(keypoints, b);
      if (pa && pb) {
        cameraCtx.beginPath();
        cameraCtx.moveTo(pa.x, pa.y);
        cameraCtx.lineTo(pb.x, pb.y);
        cameraCtx.stroke();
      }
    });
    cameraCtx.fillStyle = '#ffd166';
    keypoints.forEach((p) => {
      if (p.score >= POSE_MIN_SCORE) {
        cameraCtx.beginPath();
        cameraCtx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        cameraCtx.fill();
      }
    });
  }

  // =========================================================================
  // HOLD-PHONE (ACCELEROMETER) MODE
  // =========================================================================
  let gravity = { x: 0, y: 0, z: 0 };
  let gravityInit = false;
  let baselineGamma = null;
  let laneArmed = true;
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
    tiltMarker.style.background = Math.abs(diff) > TILT_TRIGGER_DEG ? '#ffd166' : '#6ee7ff';

    if (!detectionEnabled) return;
    if (laneArmed && diff > TILT_TRIGGER_DEG) {
      actionHandlers.lane(1);
      laneArmed = false;
      pulseAction(tiltZone);
    } else if (laneArmed && diff < -TILT_TRIGGER_DEG) {
      actionHandlers.lane(-1);
      laneArmed = false;
      pulseAction(tiltZone);
    } else if (!laneArmed && Math.abs(diff) < TILT_RESET_DEG) {
      laneArmed = true;
    }
  }

  function onDeviceMotion(e) {
    const usePreFiltered = e.acceleration && e.acceleration.x !== null;
    let mag;
    if (usePreFiltered) {
      const { x, y, z } = e.acceleration;
      mag = Math.sqrt(x * x + y * y + z * z);
    } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x !== null) {
      const raw = e.accelerationIncludingGravity;
      if (!gravityInit) { gravity = { x: raw.x, y: raw.y, z: raw.z }; gravityInit = true; }
      gravity.x = gravity.x * GRAVITY_LOWPASS + raw.x * (1 - GRAVITY_LOWPASS);
      gravity.y = gravity.y * GRAVITY_LOWPASS + raw.y * (1 - GRAVITY_LOWPASS);
      gravity.z = gravity.z * GRAVITY_LOWPASS + raw.z * (1 - GRAVITY_LOWPASS);
      const lx = raw.x - gravity.x, ly = raw.y - gravity.y, lz = raw.z - gravity.z;
      mag = Math.sqrt(lx * lx + ly * ly + lz * lz);
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

    if (mag > MOTION_JUMP_TRIGGER && now - lastJumpTime > MOTION_JUMP_COOLDOWN_MS) {
      if (!hasRotation || rot < MOTION_ROTATION_LOW) {
        lastJumpTime = now; lastActionTime = now;
        actionHandlers.jump();
        return;
      }
    }
    if (mag > MOTION_PUNCH_TRIGGER && now - lastPunchTime > MOTION_PUNCH_COOLDOWN_MS) {
      if (!hasRotation || rot >= MOTION_ROTATION_LOW || mag <= MOTION_JUMP_TRIGGER) {
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
