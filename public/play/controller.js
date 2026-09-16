// MotionQuest — phone controller
//
// Screen flow (2026-09-03 — reordered so joining comes first): Join (room
// code, either typed or auto-filled by scanning the TV's QR code) ->
// Character creator -> Control-method choice -> Camera permission ->
// Guided calibration -> Play. Character creation moved to AFTER a
// successful TV connection specifically so scanning the QR code (see
// tv/index.html's #joinQr and server.js's /qr/<code>.svg) can skip straight
// to "you're connected, now build your character" instead of making a
// player who just scanned a code sit through the character creator before
// they even know pairing worked.
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
//
// KEEPING THE PHONE ALIVE IN CAMERA MODE — 2026-09-14, after an iPhone 13
// report ("didn't work when doing the motion capture": camera picture looked
// fine, the character on the TV never moved once). Camera mode asks the player
// to prop the phone up and then never touch it again, which from the phone's
// side is minutes of no input — so it locks its screen, the OS stops the camera
// track, and every pose frame after that fails. Chrome on Android had been
// masking this by holding a wake lock of its own for the playing <video>
// element; iOS Safari doesn't, and an iPhone's Auto-Lock can be 30 seconds.
// Three things came out of that round, and they are separate concerns worth
// keeping separate:
//   1. SCREEN WAKE LOCK — hold one while the camera runs, re-acquire it on
//      return to the foreground, and warn up front on browsers without the API
//      (see the SCREEN WAKE LOCK block).
//   2. FAILURE HAS TO BE VISIBLE — poseLoop()'s catch used to discard every
//      error, so a permanently dead tracker and a player who hadn't stepped
//      into frame yet produced the same screen forever. Failure is now timed,
//      recovered from once automatically, and reported to the phone AND the TV
//      (see the POSE-LOOP HEALTH block).
//   3. DIAGNOSTICS ON THE DEVICE — every candidate cause of that report looked
//      identical from the outside, so the numbers that tell them apart are now
//      readable on the phone itself (see the TRACKING DIAGNOSTICS block).

(() => {
  // ==== Tunable thresholds ================================================
  const POSE_MIN_SCORE = 0.25;
  // Lane zones (camera mode): how far the hips must move sideways from the
  // player's own neutral position to count as "in" the left/right zone
  // (ENTER), and how far back toward neutral they must return to leave it
  // (EXIT — kept smaller than ENTER so a normal stance reliably re-centers
  // you without needing an exaggerated opposite step).
  //
  // 2026-09-09 — "the middle is too narrow". These were fractions of frame
  // WIDTH, and that was the bug, not the number. A fraction of frame width
  // is a different REAL distance depending on how far back you stand, so
  // the centre lane silently changed size as the player moved:
  //
  //   at 1.5m from the phone   0.083 of frame width = ~17cm of hip movement
  //   at 2.5m                                       = ~29cm
  //   at 3.0m                                       = ~35cm
  //
  // 17cm is inside the ordinary sway of jogging on the spot, so anyone
  // standing at the near end of the framing check's accepted range was
  // getting lane changes they never asked for and could not hold the middle.
  // Children get this worst: the framing check sizes them by torso, so a
  // child is asked to stand ~0.8-1.9m back, i.e. squarely in the twitchy
  // zone, where an adult at 2.5-3m never noticed a problem.
  //
  // The fix is to measure the threshold in TORSO LENGTHS instead. Torso
  // (shoulder-mid to hip-mid) is already tracked, shrinks with distance in
  // exactly the same proportion as everything else in frame, and scales with
  // the player's own size — so one number now means one real distance for
  // everybody, at any distance, adult or child:
  //
  //   0.75 torso  ~=  34cm for an adult (0.45m torso)
  //               ~=  22cm for a young child (0.30m torso)
  //
  // which is comfortably clear of jog/sway noise (~10-15cm) and comfortably
  // inside a deliberate side step (~35-55cm). THIS is the knob to turn if it
  // still feels twitchy (lower = more sensitive) or sluggish (higher).
  const LANE_ENTER_TORSO_FRAC = 0.75;
  const LANE_EXIT_TORSO_FRAC = 0.36;
  // Guard rails, as fractions of frame width, in case a bad torso read makes
  // the threshold nonsense — without these a momentarily tiny torso estimate
  // would make the character flick lanes on noise, and a huge one would make
  // lane changes impossible. Never reached during normal tracking.
  const LANE_ENTER_MIN_FRAME_FRAC = 0.05;
  const LANE_ENTER_MAX_FRAME_FRAC = 0.16;
  // The neutral position is learned rather than assumed to be the middle of
  // the frame (the framing check tolerates being up to 0.28 of frame width
  // off-centre, which is far more than a whole lane threshold). It used to be
  // captured from a SINGLE frame, which is a coin toss if that frame landed
  // mid-step — and it then never moved again for the rest of the session.
  // Now it is the median of a short burst, and re-settles very slowly while
  // the player is clearly standing neutral, so a run doesn't drift.
  const POSE_CENTER_SAMPLES = 12;        // ~0.27s at POSE_TARGET_FPS
  const POSE_CENTER_SETTLE = 0.004;      // per frame, only when clearly centred
  const POSE_CENTER_SETTLE_BAND = 0.35;  // fraction of ENTER that counts as "clearly centred"
  const JUMP_TRIGGER_TORSO_FRAC = 0.28;
  const JUMP_COOLDOWN_MS = 500;
  // 2026-09-11 ("it got stuck on jump a few times", real camera-mode
  // testing): jump used to be a pure LEVEL trigger — "rise is currently
  // above the threshold" — re-checked every frame and gated only by
  // JUMP_COOLDOWN_MS. A real jump's hang time is often *longer* than that
  // 500ms cooldown, so the very same jump would still read as "hips risen"
  // the instant the cooldown expired, fire a SECOND jump message for a
  // single physical jump, reset the cooldown clock again, and repeat for
  // as long as the player was still airborne or mid-landing — which reads
  // to the player as the character being "stuck" jumping over and over.
  // Worse, the baseline drift-correction below was also gated on the same
  // cooldown, so it could never catch up while this was happening, which
  // kept the bug feeding itself.
  //
  // Fixed by making jump a true EDGE trigger with hysteresis, the same
  // ENTER/EXIT idea already used for lanes: `jumpArmed` must be true to
  // fire, goes false the instant it fires, and only goes true again once
  // the hips have genuinely returned close to baseline (below
  // JUMP_REARM_TORSO_FRAC) — i.e. the player has actually landed. One real
  // jump can now only ever produce one jump message, no matter how long
  // the hang time is or how the cooldown lines up against it.
  const JUMP_REARM_TORSO_FRAC = 0.12;
  // ---- Duck (2026-09-04, the era-levels round) ------------------------
  // Detected as the mirror image of a jump: the hips DROP below their
  // resting baseline by a good fraction of torso length. The threshold is
  // deliberately higher than JUMP_TRIGGER_TORSO_FRAC — a jump lifts the
  // whole body and is unmistakable, whereas hips dip a little on every
  // running step, so the bar for "that was deliberate" has to be higher or
  // the character would duck constantly while the player jogs on the spot.
  const DUCK_TRIGGER_TORSO_FRAC = 0.34;
  const DUCK_COOLDOWN_MS = 700;
  // Landing from a jump drives the hips BELOW baseline for a moment, which
  // looks exactly like a crouch. Ducks are therefore ignored for a beat
  // after a jump — slightly longer than JUMP_COOLDOWN_MS, because the dip
  // happens on touchdown, i.e. at the END of the jump, not the start.
  const DUCK_AFTER_JUMP_LOCK_MS = 750;
  // Calibration is more forgiving, for the same reason CAL_PUNCH_* are: a
  // practice duck during setup carries no risk, and the player needs to
  // see the move register at all before trusting it mid-run.
  const CAL_DUCK_TRIGGER_TORSO_FRAC = 0.24;
  const CAL_DUCK_COOLDOWN_MS = 450;
  // Same "stuck" fix as jump above, applied to duck: re-arms only once the
  // hips have risen back out of the crouch, past this fraction of torso
  // length below baseline.
  const DUCK_REARM_TORSO_FRAC = 0.14;
  // Punch was firing continuously on real-device testing (2026-09-02) —
  // ordinary running arm swing was crossing these thresholds repeatedly.
  // Raised extension/velocity requirements (a punch now needs a clearly
  // more deliberate, further-reaching, faster jab than a running swing)
  // and roughly doubled the cooldown so even a borderline read can't
  // re-fire every few hundred ms. See also the TV-side debounce in
  // tv/game.js's handleInput(), which additionally ignores any punch
  // message that arrives while the previous punch's animation is still
  // playing — belt and braces against the same complaint.
  // 2026-09-16 ("Punch is going off too much") — Don's first real Fire TV
  // session, and the third round in a row this has come up, so this time the
  // fix is not just bigger numbers. Two NEW structural requirements land in
  // checkPunch() alongside the raised bars below:
  //
  //   - a punch must be EXTENDING. A punch is by definition the arm going
  //     out; the wrist's distance from the shoulder has to be growing between
  //     the two confirming frames (PUNCH_MIN_EXTEND_RATE). An arm swinging
  //     while the player steps sideways or lands a jump moves every bit as
  //     fast as a punch — that is why speed alone kept firing — but it does
  //     not extend, so this rejects it outright rather than by degree.
  //   - a punch is roughly FORWARD/sideways, not vertical. Raising or
  //     dropping an arm is mostly vertical wrist travel
  //     (PUNCH_MAX_VERTICAL_RATIO), and was the other big false-positive
  //     source: reaching up, or arms flying up on a jump.
  //
  // The raised bars are the cheap half of the fix. Extension went 0.52 →
  // 0.62 of a torso (a real punch reaches much further than a relaxed arm's
  // resting 0.5-ish), velocity 2.0 → 2.8 torsos/sec, and the cooldown 700 →
  // 900ms so a single flurry cannot read as three punches.
  const PUNCH_EXTENSION_FRAC = 0.62;
  const PUNCH_VELOCITY_TORSO_FRAC = 2.8;
  const PUNCH_COOLDOWN_MS = 900;
  // Torso-fractions per second the wrist must be moving AWAY from the
  // shoulder by. Deliberately small: the point is the SIGN (extending, not
  // retracting or holding), not a second speed bar on top of the velocity
  // one above.
  const PUNCH_MIN_EXTEND_RATE = 0.35;
  // |dy| / |dx| ceiling for the wrist's travel between frames. 2.2 still
  // allows a downward-angled or slightly rising punch, while rejecting the
  // near-vertical arm travel of a reach or a jump.
  const PUNCH_MAX_VERTICAL_RATIO = 2.2;
  // 2026-09-11 ("punch triggers when I've not done a punch", randomly, no
  // clear pattern — real camera-mode testing): that "no clear pattern" is
  // the signature of single-frame POSE NOISE rather than a real gesture
  // being misread. MoveNet occasionally reports one noisy wrist estimate —
  // a small jump in position from motion blur, brief partial occlusion, or
  // just an off frame — and the old check fired a punch off ONE such frame
  // the instant it happened to clear both the speed and extension bars.
  //
  // Two independent tightenings, both cheap (well under one frame of
  // latency at POSE_TARGET_FPS):
  //   1. A punch reading is only trusted from a wrist estimate the model
  //      itself is reasonably confident in — POSE_MIN_SCORE (0.25) is a
  //      deliberately low bar so lane/jump/duck (which average many frames
  //      together) keep working at the edges of the frame; punch fires off
  //      a single frame's reading, so it needs a cleaner one.
  //   2. A punch must clear the bar on TWO qualifying frames within
  //      PUNCH_CONFIRM_WINDOW_MS of each other, not just one — see
  //      checkPunch()'s comment. A real punch stays fast and extended for
  //      several consecutive frames near its peak, so this costs it
  //      nothing; an isolated noisy frame essentially never repeats on the
  //      very next sample too.
  const PUNCH_MIN_SCORE = 0.35;
  const PUNCH_CONFIRM_WINDOW_MS = 150;
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
  //
  // 2026-09-16: these forgiving values now apply ONLY while the walkthrough
  // is actually asking for the punch, not for the whole of setup. That was
  // the other half of "even during setup the character is punching before
  // punch is configured": during the left/right/jump/duck steps the loosened
  // bars were still live, so stepping sideways in front of the camera read as
  // a punch. Outside the punch step, setup now uses the same strict
  // thresholds real play does. See punchTuning() below.
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
  // =======================================================================
  // PARTIAL-BODY TRACKING — 2026-09-15
  // =======================================================================
  // "In landscape it's rare that the player's full body will be visible."
  // Correct — and the old code depended on it being visible: a gesture was
  // only detected once BOTH a shoulder and a hip were tracked, and every
  // threshold was a fraction of the shoulder-to-hip distance. A phone propped
  // up in landscape, at the sort of distance a living room allows, very often
  // sees head and shoulders and nothing below — in which case nothing locked
  // on and nothing was ever detected at all.
  //
  // Tracking now degrades instead of failing:
  //   scale:     shoulder-to-hip distance -> shoulder WIDTH converted to an
  //              equivalent torso length. Everything downstream stays in
  //              "fractions of a torso", so none of the existing tuning has
  //              to be re-derived.
  //   reference: hip midpoint -> shoulder midpoint, as the one point that
  //              lane / jump / duck are all measured from.
  // A shoulder width is roughly three quarters of a torso length on an adult
  // (rather less on a child); 1.35 is the reciprocal, biased slightly toward
  // reading small, which makes gestures trigger a little more easily — the
  // direction this file has always deliberately erred in.
  const SHOULDER_WIDTH_TO_TORSO = 1.35;
  // Switching the reference point mid-run moves it by most of a torso in a
  // single frame, which is a bigger step than any real jump — so the
  // baselines MUST be dropped when it happens, or the switch itself fires a
  // phantom jump or duck. Switching back is also deliberately sticky: hips
  // are adopted again only after being continuously present for this many
  // frames, so hips that flicker in and out at the bottom edge of the frame
  // (the common landscape case, and the exact one that would otherwise flap
  // between references several times a second) settle on shoulders and stay.
  // The delay deliberately does NOT apply to the FIRST acquisition: a player
  // standing in full view should be on the hip reference from frame one, not
  // half a second later via an avoidable baseline reset.
  const REF_HIP_REACQUIRE_FRAMES = 25;
  // A crouch folds the body, so the shoulders travel further down than the
  // hips do — measuring a duck from the shoulders is therefore more sensitive
  // than the hip-tuned threshold expects. Scaled back to compensate. A jump
  // lifts the whole body uniformly, so it needs no such correction.
  const SHOULDER_REF_DUCK_MULT = 1.3;
  // Below this — equivalent torso length as a fraction of the frame's short
  // side — the body is too small for the keypoints to be worth trusting.
  // THAT, rather than "I can't see your legs", is what "too far" now means.
  const FRAMING_MIN_SCALE_FRAC = 0.11;
  // How close to the frame edge a landmark may sit before it counts as cut
  // off, as a fraction of frame width/height.
  const FRAMING_EDGE_MARGIN_FRAC = 0.03;
  // 2026-09-14 ("iPhone 13 didn't work when doing the motion capture"). Three
  // time budgets for noticing that pose detection has stopped working at all,
  // rather than assuming every failed frame is a transient blip — see
  // poseLoop() for the reasoning and what each one triggers.
  const POSE_FAIL_WARN_MS = 1200;
  const POSE_FAIL_RECOVER_MS = 3000;
  const POSE_FAIL_GIVEUP_MS = 10000;
  // How long the pose loop can go without producing a single successful frame
  // before we treat the tracker as stalled rather than merely slow. A CPU
  // backend on a phone can take well over a second per frame, so this has to
  // be generous enough not to fire on "working, just far too slow" — that case
  // is reported separately, by backend name.
  const POSE_STALL_MS = 6000;
  const DIAG_REFRESH_MS = 250;

  // Lane zones (hold-phone mode): same ENTER/EXIT hysteresis idea, in
  // degrees of phone tilt from the calibrated baseline.
  const TILT_ENTER_DEG = 16;
  const TILT_EXIT_DEG = 6;
  const MOTION_JUMP_TRIGGER = 14;
  // Raised alongside PUNCH_EXTENSION_FRAC/PUNCH_COOLDOWN_MS above — same
  // "punch firing continuously" real-device fix, hold-phone side. Raised
  // again 2026-09-16, but only 13 → 14, matching MOTION_JUMP_TRIGGER so both
  // gestures share one "this was a deliberate burst, not ordinary movement"
  // bar. Deliberately a small raise: a real jab on a held phone reads about
  // 15–16 and has to keep landing (mr_test_motion_classify pins both of those
  // borderline cases), so pushing this number higher would start costing real
  // punches. The substantive hold-phone fix this round is the structural one
  // inside onDeviceMotion() — see the rotationSaysPunch comment there, which
  // is what was actually letting ordinary vertical movement fire punches on
  // any device that doesn't report rotationRate (i.e. most Androids).
  const MOTION_PUNCH_TRIGGER = 14;
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
  // Hold-phone duck — see the sign discussion in onDeviceMotion().
  const MOTION_DUCK_TRIGGER = 10;
  const MOTION_DUCK_COOLDOWN_MS = 700;
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
  //
  // These are measured against the frame's SHORT side, not its height. A
  // phone sensor is 4:3, so the short side is the "3" whichever way the
  // phone is propped, and normalising by it keeps these two numbers meaning
  // the same physical distance in either orientation. That is why the
  // 2026-09-04 switch back to LANDSCAPE needed no change here, while the
  // lane thresholds above — which are fractions of WIDTH — did.
  // 2026-09-15: FRAMING_TOO_CLOSE_FRAC / FRAMING_TOO_FAR_FRAC (0.34 / 0.15 of
  // the frame's short side) are deliberately gone. They assumed a full body in
  // shot, and in landscape they rejected the very framing that works best —
  // see the rewritten computeFramingStatus() for what replaced them.
  const FRAMING_OFFCENTER_FRAC = 0.28; // |hip x offset| / frame width
  const FRAMING_GOOD_HOLD_MS = 900;
  const FRAMING_SEND_INTERVAL_MS = 200;

  // 2026-09-10 ("started to move towards the camera and moved off the spot,
  // affecting the motion capture"): liveFramingCheck() re-uses the two
  // thresholds above DURING real play, not just at setup. It needs its own
  // "clear" thresholds so a player who is right on the edge of too-close
  // doesn't flicker in and out of the warning every frame — you have to back
  // off a bit further than the trigger point before it clears, and the
  // interval below throttles how often we bother re-sending the same
  // still-bad status to the TV.
  // 2026-09-15: the two value-based clearance bands that used to live here
  // are gone with the torso-fraction test they belonged to — liveFramingCheck()
  // now holds a verdict for a moment before acting on it instead. Raising a
  // warning is deliberately slower than clearing one.
  const LIVE_FRAMING_WARN_HOLD_MS = 600;
  const LIVE_FRAMING_OK_HOLD_MS = 250;
  const LIVE_FRAMING_SEND_INTERVAL_MS = 400;

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
  const sessionExpiredScreen = document.getElementById('sessionExpiredScreen');
  const scanNewCodeBtn = document.getElementById('scanNewCodeBtn');
  const connectionBanner = document.getElementById('connectionBanner');
  const controlChoiceScreen = document.getElementById('controlChoiceScreen');
  const chooseMotionBtn = document.getElementById('chooseMotionBtn');
  const choosePadBtn = document.getElementById('choosePadBtn');
  const permScreen = document.getElementById('permScreen');
  const rememberedSetupScreen = document.getElementById('rememberedSetupScreen');
  const useRememberedBtn = document.getElementById('useRememberedBtn');
  const redoSetupBtn = document.getElementById('redoSetupBtn');
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
  const playerBadge = document.getElementById('playerBadge');
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
  const duckBtn = document.getElementById('duckBtn');
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
  const camDiagBtn = document.getElementById('camDiagBtn');
  const camDiag = document.getElementById('camDiag');
  const motionPermBanner = document.getElementById('motionPermBanner');
  const enableMotionBtn = document.getElementById('enableMotionBtn');

  // =========================================================================
  // TRACKING DIAGNOSTICS — 2026-09-14
  // =========================================================================
  // Added after an iPhone 13 report ("didn't work when doing the motion
  // capture": camera picture fine, character on the TV never moved) that could
  // not be narrowed down from the outside, because every plausible cause —
  // screen lock ending the camera track, a zero-sized video frame, MoveNet
  // silently landing on the CPU backend, the framing gate never passing —
  // produced the identical screen. This is a plain readout of the numbers that
  // tell those apart, on the phone itself, so one screenshot settles it.
  // Deliberately always available rather than hidden behind a debug flag:
  // the whole reason the earlier rounds took several passes each is that
  // nothing could be observed on a real device.
  const diag = {
    backend: '',
    backendError: '',
    videoSize: '',
    poseFps: 0,
    poseError: '',
    playError: '',
    wakeLock: 'not requested',
    wakeLockError: '',
    trackEnded: false,
    trackMuted: false,
    recoveryAttempts: 0,
    recoveryError: '',
    hiddenCount: 0,
    lastHiddenAt: '',
    locked: false,
    torsoFrac: 0,
    framing: '',
    view: '',
    bodyRef: '',
    refSwitches: 0,
    motionPerm: '',
  };
  let diagVisible = false;
  function showDiagnostics(on) {
    diagVisible = !!on;
    if (camDiag) camDiag.hidden = !diagVisible;
    if (camDiagBtn) camDiagBtn.setAttribute('aria-expanded', String(diagVisible));
    if (diagVisible) renderDiagnostics();
  }
  function renderDiagnostics() {
    if (!camDiag || !diagVisible) return;
    const track = cameraStream && cameraStream.getVideoTracks()[0];
    const lines = [
      `mode      ${currentMode || '-'}`,
      `backend   ${diag.backend || '-'}${diag.backendError ? ` (${diag.backendError})` : ''}`,
      `video     ${diag.videoSize || `${cameraVideo.videoWidth}x${cameraVideo.videoHeight}`}`,
      `pose fps  ${diag.poseFps}`,
      `track     ${track ? track.readyState : 'none'}${diag.trackMuted ? ' muted' : ''}${diag.trackEnded ? ' ENDED' : ''}`,
      `wake lock ${diag.wakeLock}${diag.wakeLockError ? ` (${diag.wakeLockError})` : ''}`,
      `body      ${diag.locked ? 'tracked' : 'NOT tracked'}  torso ${diag.torsoFrac.toFixed(3)}`,
      `sees      ${diag.view || '-'}  via ${diag.bodyRef || '-'}${diag.refSwitches ? ` (${diag.refSwitches} switches)` : ''}`,
      `framing   ${diag.framing || '-'}  gate ${inCameraSetupGate ? 'setup' : framingActive ? 'framing' : 'off'}`,
      `backgrnd  ${diag.hiddenCount}x${diag.lastHiddenAt ? ` last ${diag.lastHiddenAt}` : ''}`,
      `restarts  ${diag.recoveryAttempts}${diag.recoveryError ? ` (${diag.recoveryError})` : ''}`,
    ];
    if (diag.motionPerm) lines.push(`motion    ${diag.motionPerm}`);
    if (diag.playError) lines.push(`play err  ${diag.playError}`);
    if (diag.poseError) lines.push(`pose err  ${diag.poseError}`);
    camDiag.textContent = lines.join('\n');
  }
  if (camDiagBtn) camDiagBtn.addEventListener('click', () => showDiagnostics(!diagVisible));
  setInterval(renderDiagnostics, DIAG_REFRESH_MS);

  function showScreen(el) {
    [characterScreen, joinScreen, sessionExpiredScreen, controlChoiceScreen, permScreen, rememberedSetupScreen, calibrationScreen, playScreen]
      .forEach((s) => (s.style.display = 'none'));
    el.style.display = 'flex';
    // 2026-09-03 styling pass: the app title and strapline are worth having
    // on the join/character/choice screens and are pure wasted height once
    // you're actually setting up or playing — that's ~80px the camera view
    // and the buttons want. See body.in-game in index.html.
    document.body.classList.toggle('in-game', el === playScreen || el === calibrationScreen);
    // 2026-09-08: the join screen's background art (art/join-bg.jpg) already
    // paints the MotionQuest logo + tagline, so the standard #app header is
    // redundant there — hide it just for this screen (see the join-screen
    // CSS block in index.html).
    document.body.classList.toggle('on-join', el === joinScreen);
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
  // 2026-09-03: character creation now happens AFTER joining (see the
  // header comment), so "Continue" here sends the finished character to
  // the (already-connected) TV and leads straight into the control-method
  // choice, rather than the join screen.
  characterContinueBtn.addEventListener('click', () => {
    sendCharacter();
    showScreen(controlChoiceScreen);
  });

  // =========================================================================
  // 2. WEBSOCKET / JOIN
  // =========================================================================
  let ws = null;
  let roomCode = null;

  // 2026-09-16 (reconnect round): a private, unguessable per-device
  // credential — NOT the 6-digit room code, which is meant for initial
  // pairing only and must never by itself be enough to reclaim a slot (see
  // server.js). Generated once with the Web Crypto RNG and kept in
  // sessionStorage so it survives a reload of this tab but goes away with
  // it — there is no reason for it to outlive the tab, and every value here
  // is meaningless to anyone who doesn't already hold this exact phone's
  // open session. Never sent anywhere except this server's own /register
  // message, and never derived from or exposed via the join URL/QR code.
  function makeDeviceToken() {
    const bytes = new Uint8Array(16);
    (window.crypto || {}).getRandomValues?.(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') || `${Date.now()}-${Math.random()}`.replace(/[^a-z0-9]/gi, '');
  }
  let deviceToken;
  try {
    deviceToken = sessionStorage.getItem('mq_device_token') || makeDeviceToken();
    sessionStorage.setItem('mq_device_token', deviceToken);
  } catch {
    deviceToken = makeDeviceToken(); // private browsing etc. — still works, just won't survive a reload
  }

  // Whether this phone has EVER successfully paired this page-load. Before
  // that, a closed socket is just a failed join attempt (show the join
  // error, let them retry); after it, a closed socket is something to
  // recover from automatically without bouncing the player off whatever
  // screen — setup or mid-run — they were actually on.
  let everPaired = false;
  let sessionExpiredShown = false;
  let intentionalDisconnect = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let reconnectDeadline = 0;
  // Capped backoff — quick at first (a wifi handoff is usually sub-second),
  // levelling off rather than growing forever. The deadline below is what
  // actually decides when to stop, not the length of this list.
  const RECONNECT_DELAYS_MS = [1000, 1500, 2500, 4000, 6000, 8000];
  // A little longer than the server's own CONTROLLER_RECONNECT_GRACE_MS
  // (server.js), so automatic recovery has already had every chance the
  // server itself allows before we ever bother the player with a button.
  const MAX_AUTO_RECONNECT_MS = 28000;

  function connect(code) {
    intentionalDisconnect = false;
    everPaired = false;
    reconnectAttempts = 0;
    reconnectDeadline = 0;
    roomCode = code;
    hideConnectionBanner();
    openSocket();
  }

  function openSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.addEventListener('open', handleSocketOpen);
    ws.addEventListener('message', handleSocketMessage);
    ws.addEventListener('close', handleSocketClose);
    ws.addEventListener('error', handleSocketError);
  }

  function handleSocketOpen() {
    ws.send(JSON.stringify({ type: 'register', role: 'controller', code: roomCode, deviceToken }));
  }

  function handleSocketMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'paired') {
      const wasReconnect = everPaired && msg.reconnected;
      reconnectAttempts = 0;
      reconnectDeadline = 0;
      hideConnectionBanner();
      everPaired = true;
      roomCode = msg.code;
      roomLabel.textContent = roomCode;
      // Multiplayer: the server assigns a stable 1-4 id on join (see
      // server.js's assignPlayerId()) purely so the TV can tell whose turn
      // it is — this phone doesn't need to do anything differently, just
      // show the player which colour/number they ended up as.
      if (playerBadge && msg.playerId) playerBadge.textContent = ` · P${msg.playerId}`;
      if (wasReconnect) {
        // A network blip, not a fresh join — reclaiming the SAME slot (see
        // deviceToken above). Whatever screen/state the player was on stays
        // exactly as it was; reconnecting must never bounce them back to
        // character creation or the start of setup.
        return;
      }
      // 2026-09-03: character creation now happens straight after a
      // successful connection rather than before it (see the header
      // comment) — sendCharacter() moves to characterContinueBtn's click
      // handler below, once there's an actual customized character to
      // send instead of just the default.
      showScreen(characterScreen);
    } else if (msg.type === 'calibration_control') {
      // The TV relays Fire TV remote OK presses back to us during the
      // placement/framing setup stages — see handlePlacementAck/
      // handleMovesAck (defined further down, alongside beginCalibration).
      if (msg.action === 'placement_ack') handlePlacementAck();
      else if (msg.action === 'moves_ack') handleMovesAck();
      // The TV also drives WHICH move the walkthrough is currently asking
      // for, so we only accept that one — see handleCalStepRequest().
      else if (msg.action === 'step_request') handleCalStepRequest(msg);
      else if (msg.action === 'step_arm') handleCalStepArm(msg);
      // 2026-09-16: Back part-way through setup steps one stage back rather
      // than tearing the whole thing down — see handleFramingBack().
      else if (msg.action === 'framing_back') handleFramingBack();
      else if (msg.action === 'placement_back') handlePlacementBack();
      // The TV ends setup — either because the last move just got ticked
      // off, or because OK was pressed on the remote. Either way the
      // player doesn't have to come back to the phone to start.
      else if (msg.action === 'finish') finishCalibration({ notifyTv: false });
      // 2026-09-15 ("if you press back on the level select it goes back to
      // configuration"): sent to every phone in the room when Back is
      // pressed on the era picker. Whatever this phone was doing — mid
      // run, mid calibration, sitting on the play screen — gets torn down
      // and it lands back on control choice to pick motion/pad again.
      else if (msg.action === 'restart') handleRestartConfiguration();
    } else if (msg.type === 'tv_status') {
      handleTvStatus(msg.status);
    } else if (msg.type === 'session_expired') {
      handleSessionExpired();
    } else if (msg.type === 'error') {
      if (msg.code === 'room_not_found' && everPaired) {
        // Discovered on a reconnect attempt (we were already in) rather
        // than on a fresh join — the room is genuinely gone, not just a
        // mistyped code, so this is the expired-session story.
        handleSessionExpired();
        return;
      }
      joinError.textContent = msg.message || 'Could not connect.';
      joinBtn.disabled = false;
    }
  }

  function handleSocketClose() {
    if (intentionalDisconnect) return;
    if (!everPaired) {
      // Never successfully paired on this attempt — a plain join failure,
      // not a "reconnecting" story to be calm about.
      showScreen(joinScreen);
      joinBtn.disabled = false;
      return;
    }
    scheduleReconnect();
  }

  function handleSocketError() {
    if (!everPaired) {
      joinError.textContent = 'Connection failed. Check you’re on the same WiFi as the TV.';
      joinBtn.disabled = false;
    }
    // A 'close' event follows an 'error' on every browser this runs on —
    // the actual reconnect scheduling lives there so it only runs once.
  }

  // Automatic, capped-backoff reconnection. Deliberately calm: no screen
  // change, no alarming copy, nothing torn down — see the header comment on
  // deviceToken/everPaired for why this can just quietly retry in place.
  // Only once the deadline passes does this stop trying on its own and put
  // a manual retry button in front of the player.
  function scheduleReconnect() {
    if (!reconnectDeadline) reconnectDeadline = Date.now() + MAX_AUTO_RECONNECT_MS;
    if (Date.now() >= reconnectDeadline) {
      showConnectionBanner('failed', 'Couldn’t reconnect automatically.');
      return;
    }
    showConnectionBanner('reconnecting', '🔄 Reconnecting to the TV…');
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempts++;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(openSocket, delay);
  }

  function retryConnectionNow() {
    clearTimeout(reconnectTimer);
    reconnectAttempts = 0;
    reconnectDeadline = 0;
    openSocket();
  }

  function showConnectionBanner(kind, text) {
    if (!connectionBanner) return;
    connectionBanner.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = text;
    connectionBanner.appendChild(label);
    if (kind === 'failed') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small';
      btn.textContent = '🔄 Try again';
      btn.addEventListener('click', retryConnectionNow);
      connectionBanner.appendChild(btn);
    }
    connectionBanner.className = kind === 'failed' ? 'showing failed' : 'showing';
  }
  function hideConnectionBanner() {
    if (connectionBanner) connectionBanner.className = '';
  }

  // The TV side can blip too (its own network, or its page reloading) —
  // told to us via tv_status so we can stay calm about that as well, rather
  // than only ever handling our own socket dropping.
  function handleTvStatus(status) {
    if (status === 'reconnecting') {
      showConnectionBanner('reconnecting', '🔄 Waiting for the TV to come back…');
    } else if (status === 'connected') {
      hideConnectionBanner();
    } else if (status === 'left') {
      // The TV's own reconnect grace window ran out — not a blip. Treated
      // the same as the room itself expiring, below.
      handleSessionExpired();
    }
  }

  // A genuinely expired/gone TV session (server.js's idle sweep, or the TV
  // never coming back within its own grace window) is a dead end that no
  // amount of automatic retrying will fix — per the guardrail, this gets an
  // unambiguous screen and a single clear action, not a banner that spins
  // forever.
  function handleSessionExpired() {
    if (sessionExpiredShown) return;
    sessionExpiredShown = true;
    intentionalDisconnect = true;
    clearTimeout(reconnectTimer);
    hideConnectionBanner();
    try { ws && ws.close(); } catch { /* already gone */ }
    teardownActiveSetup();
    everPaired = false;
    roomCode = null;
    showScreen(sessionExpiredScreen);
  }

  if (scanNewCodeBtn) {
    scanNewCodeBtn.addEventListener('click', () => {
      sessionExpiredShown = false;
      codeInput.value = '';
      joinError.textContent = '';
      joinBtn.disabled = false;
      showScreen(joinScreen);
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
  chooseMotionBtn.addEventListener('click', () => {
    // 2026-09-14: warn about Auto-Lock before the phone gets propped up — see
    // #autoLockHint in index.html and the SCREEN WAKE LOCK block below.
    const autoLockHint = document.getElementById('autoLockHint');
    if (autoLockHint) autoLockHint.hidden = ('wakeLock' in navigator) && !!navigator.wakeLock;
    showScreen(permScreen);
  });
  choosePadBtn.addEventListener('click', () => beginPadMode());

  // =========================================================================
  // REMEMBERED SETUP (2026-09-16)
  // =========================================================================
  // "The local remembered-setup record should contain only the minimum
  // non-sensitive state needed to skip calibration: setup version, input
  // mode, completion timestamp, and completed gesture names" — never raw
  // pose, camera, or motion-sensor data. Bumping SETUP_VERSION invalidates
  // every existing record automatically: an old version just fails the
  // check below and the player falls back to full calibration, exactly as
  // if nothing had ever been saved.
  const SETUP_VERSION = 1;
  const REMEMBERED_SETUP_KEY = 'mq_remembered_setup';

  function loadRememberedSetup(mode) {
    try {
      const raw = localStorage.getItem(REMEMBERED_SETUP_KEY);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      if (!rec || rec.version !== SETUP_VERSION || rec.mode !== mode) return null;
      const moves = Object.keys(calState);
      if (!Array.isArray(rec.completedMoves) || !moves.every((m) => rec.completedMoves.includes(m))) return null;
      return rec;
    } catch {
      // Unavailable storage, corrupt JSON, private-mode throw — any of these
      // just means "nothing remembered", never a crash.
      return null;
    }
  }

  // Deliberately conservative: only a setup where THIS phone itself
  // detected every single move during the session just finishing counts as
  // "remembered" — a move ticked off via the TV remote's skip, or one
  // carried over unverified from an earlier remembered setup, does not.
  // That is what "the phone demonstrably did every move" means as a signal
  // worth trusting next time.
  function saveRememberedSetupIfComplete() {
    if (!currentMode || currentMode === 'pad') return;
    if (!Object.values(calState).every(Boolean)) return;
    try {
      localStorage.setItem(REMEMBERED_SETUP_KEY, JSON.stringify({
        version: SETUP_VERSION,
        mode: currentMode,
        completedMoves: Object.keys(calState).filter((k) => calState[k]),
        completedAt: Date.now(),
      }));
    } catch {
      // Storage full/unavailable — setup just isn't remembered next time.
    }
  }

  // Skips straight past the per-move walkthrough: tells the TV which moves
  // this phone already proved it can do, and lands on the TV's own review
  // screen (see applyRememberedCalibration() in tv/game.js) — never
  // straight into a run, and still one tap away from a full redo.
  async function useRememberedSetup(remembered) {
    resetCalibration();
    actionHandlers = calHandlers;
    moveSensorPanelTo(calSensorSlot);
    showScreen(calibrationScreen);
    inCameraSetupGate = false;
    framingActive = false;
    calibrationHint.textContent = 'Using your remembered setup — check the TV…';
    await setMode(remembered.mode);
    sendCalibration('remembered', { mode: remembered.mode, completedMoves: remembered.completedMoves });
  }

  let pendingRememberedSetup = null;
  function offerOrBeginCalibration(mode) {
    const remembered = loadRememberedSetup(mode);
    if (remembered) {
      pendingRememberedSetup = remembered;
      showScreen(rememberedSetupScreen);
      return;
    }
    beginCalibration(mode);
  }
  useRememberedBtn.addEventListener('click', () => {
    if (!pendingRememberedSetup) return;
    const remembered = pendingRememberedSetup;
    pendingRememberedSetup = null;
    useRememberedSetup(remembered);
  });
  redoSetupBtn.addEventListener('click', () => {
    const mode = pendingRememberedSetup ? pendingRememberedSetup.mode : 'camera';
    pendingRememberedSetup = null;
    beginCalibration(mode);
  });

  grantCameraBtn.addEventListener('click', () => offerOrBeginCalibration('camera'));
  skipCameraBtn.addEventListener('click', () => offerOrBeginCalibration('hold'));

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

  // 2026-09-15 ("if you press back on the level select it goes back to
  // configuration"): the TV broadcasts this to every phone in the room when
  // Back is pressed on the era picker (see restartConfiguration() in
  // tv/game.js). Whatever this phone was doing gets torn down the same way
  // switching control modes already does — stop the camera and any motion
  // listeners, drop the setup gates, forget which mode was chosen — and it
  // lands back on control choice so the player can pick motion or pad and
  // recalibrate from scratch.
  // Shared by the "Back on the era picker" restart AND a genuinely expired
  // TV session (2026-09-16) — both mean "nothing currently running is still
  // valid", just with a different destination screen afterwards.
  function teardownActiveSetup() {
    stopCamera();
    stopMotionListeners();
    hideMotionPermBanner();
    if (calStuckTimer) clearTimeout(calStuckTimer);
    inCameraSetupGate = false;
    framingActive = false;
    framingGoodStreakStart = null;
    expectedCalStep = null;
    currentMode = null;
    actionHandlers = realHandlers;
    pendingRememberedSetup = null;
  }

  function handleRestartConfiguration() {
    teardownActiveSetup();
    showScreen(controlChoiceScreen);
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

  // 2026-09-16 ("Back should always lead to the previous screen"): the TV
  // sends these when Back is pressed part-way through setup, so each press
  // steps back one stage instead of dumping the player out of setup or —
  // worse, before this round — closing the app. The inverse of
  // handleMovesAck/handlePlacementAck above.
  function handleFramingBack() {
    if (currentMode !== 'camera') return;
    inCameraSetupGate = true;
    framingActive = true;
    framingGoodStreakStart = null;
    expectedCalStep = null;
    calStepArmed = false;
    calSkipStepBtn.style.display = 'none';
    if (calStuckTimer) clearTimeout(calStuckTimer);
    calibrationHint.textContent = '👀 Watch the TV — line yourself up in the outline.';
  }

  function handlePlacementBack() {
    if (currentMode !== 'camera') return;
    inCameraSetupGate = true;
    framingActive = false;
    framingGoodStreakStart = null;
    calibrationHint.textContent = '📺 Watch the TV — prop the phone up where it can see you.';
  }

  // The step-by-step walkthrough itself lives on the TV (see tv/game.js) —
  // this screen just detects each move (same detectors as real play, routed
  // through calHandlers below) and tells the TV which one just happened.
  const calState = { left: false, right: false, jump: false, duck: false, punch: false };

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
  // 2026-09-15 ("there should always be a short countdown before doing a
  // movement to allow the player to get in position"). The TV now counts the
  // player in before each move, and a move must not be accepted while that
  // countdown is still running — otherwise it registers whatever they happen
  // to be doing as they walk back into position, which is exactly the sort of
  // accidental early tick-off the 2026-09-03 ordering fix was about.
  // `step_request` names the move and leaves us DISARMED; `step_arm` (sent by
  // the TV when it says GO) is what opens detection. A TV that sends no
  // countdown at all arms immediately, so an older TV build still works.
  let calStepArmed = true;
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
    // Armed only if this TV isn't going to count us in.
    calStepArmed = !(msg && msg.countdown);
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

  // Sent by the TV the moment its "3 - 2 - 1 - GO" reaches GO.
  function handleCalStepArm(msg) {
    if (msg && msg.step && msg.step !== expectedCalStep) return; // stale arm for a move we've moved past
    calStepArmed = true;
    // The stuck-skip clock starts from GO, not from the prompt appearing —
    // counting the countdown against the player would offer them a skip
    // before they'd had a fair chance to do the move.
    if (calStuckTimer) clearTimeout(calStuckTimer);
    if (expectedCalStep) {
      const label = CAL_STEP_LABEL[expectedCalStep] || expectedCalStep;
      calStuckTimer = setTimeout(() => {
        calSkipStepBtn.textContent = 'Skip ' + label + ' \u203a';
        calSkipStepBtn.style.display = 'block';
      }, CAL_STUCK_HINT_MS);
    }
  }

  function markCalDone(key) {
    if (calState[key]) return;
    // Not while the TV is still counting the player in — see calStepArmed.
    if (!calStepArmed) return;
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
    calStepArmed = true; // a deliberate tap is not an accidental early trigger
    markCalDone(expectedCalStep);
  });
  function resetCalibration() {
    Object.keys(calState).forEach((k) => (calState[k] = false));
    expectedCalStep = null;
    calStepArmed = true;
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
    saveRememberedSetupIfComplete();
    if (!opts || opts.notifyTv !== false) sendCalibration('done');
    // 2026-09-09: re-learn where "centre" is on the way into real play.
    // Calibration's last acts are a LEFT step, a RIGHT step, a jump, a duck
    // and a punch — the player is rarely standing neutral at the moment it
    // ends, and until now whatever position they happened to be in became
    // the centre lane for the entire run. Nulling these makes onPose()
    // re-derive the neutral from a fresh median burst once they settle.
    poseCenterX = null;
    poseCenterSamples.length = 0;
    poseHipYBaseline = null;
    cameraLaneZone = 0;
    jumpArmed = true;
    duckArmed = true;
    punchPending = { left: null, right: null };
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
      poseCenterSamples.length = 0;
      poseHipYBaseline = null;
      cameraLaneZone = 0;
      jumpArmed = true;
      duckArmed = true;
      punchPending = { left: null, right: null };
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
  let lastDuckTime = 0;
  let lastActionTime = 0;
  // Edge-trigger arming for jump/duck — see JUMP_REARM_TORSO_FRAC's comment.
  // Both start armed: a player who is already standing neutral when
  // tracking locks on should be able to jump/duck immediately.
  let jumpArmed = true;
  let duckArmed = true;

  function fireJump(opts) {
    const now = performance.now();
    lastJumpTime = now;
    lastActionTime = now;
    sendInput('jump', undefined, opts);
    pulseAction(jumpBtn);
    if (navigator.vibrate) navigator.vibrate(30);
  }
  function fireDuck(opts) {
    const now = performance.now();
    lastDuckTime = now;
    lastActionTime = now;
    sendInput('duck', undefined, opts);
    pulseAction(duckBtn);
    // A short double buzz, distinct from jump's single pulse, so the two
    // are tellable apart by feel when the phone is in a pocket.
    if (navigator.vibrate) navigator.vibrate([15, 25, 15]);
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
  duckBtn.addEventListener('click', () => fireDuck({ explicit: true }));

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
    duck: () => fireDuck(),
  };
  // 2026-09-15 ("better to have the character there copying your movements").
  // Gestures detected during setup are ALSO sent to the TV so the character
  // can perform them — but ONLY the move the walkthrough is currently asking
  // for, and only once it has actually counted the player in.
  //
  // This replaces the opposite rule (2026-09-15), which mirrored every
  // detected gesture at every moment on purpose, "including moves the
  // walkthrough hasn't asked for yet". Don, after the first real Fire TV
  // session: "Punch is going off too much and even during setup the character
  // is punching before punch is configured. The character is moving on setup
  // before the movement is configured. The character should show the player
  // what to do then the player follows the movement after the countdown."
  //
  // Which is right: the character is the DEMONSTRATION during the count-in
  // (see the TV's playMoveDemo()) and the MIRROR after it. If it also twitched
  // at every stray gesture, the player can't tell which of the two they are
  // looking at, and a punch — the easiest gesture to trigger by accident
  // while stepping sideways — made the character punch through the whole of
  // setup.
  //
  // mirrorAllowed() is the gate. `calStepArmed` is set by the TV's step_arm
  // (i.e. "GO"), so nothing mirrors during the count-in; `expectedCalStep`
  // is the one move being asked for. Returning to centre is always allowed:
  // it is the character coming back to rest, not an unasked-for move, and
  // without it the character would stay stuck out in a side lane.
  //
  // Deliberately a `calibration` event rather than a real `input` message:
  // the TV starts a run on the first genuine jump/punch input, so sending
  // these as ordinary input would launch the game from the setup screen.
  function mirrorAllowed(move) {
    if (!calStepArmed) return false;
    if (!expectedCalStep) return true; // TV hasn't named a step — old-TV fallback
    return move === expectedCalStep;
  }
  function sendMirror(action, value) {
    sendCalibration('mirror', value === undefined ? { action } : { action, value });
  }
  const calHandlers = {
    lane: (dir) => {
      const move = dir < 0 ? 'left' : 'right';
      if (mirrorAllowed(move)) sendMirror('lane_set', dir < 0 ? -1 : 1);
      markCalDone(move);
    },
    laneZone: (zone) => {
      // zone 0 is "back to the middle" — always mirrored, see above.
      const move = zone === -1 ? 'left' : zone === 1 ? 'right' : null;
      if (move === null || mirrorAllowed(move)) sendMirror('lane_set', zone);
      if (zone === -1) markCalDone('left');
      else if (zone === 1) markCalDone('right');
    },
    jump: () => { if (mirrorAllowed('jump')) sendMirror('jump'); markCalDone('jump'); },
    punch: () => { if (mirrorAllowed('punch')) sendMirror('punch'); markCalDone('punch'); },
    duck: () => { if (mirrorAllowed('duck')) sendMirror('duck'); markCalDone('duck'); },
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
        // 2026-09-14: say WHAT went wrong. "Camera unavailable" covered an
        // insecure origin, a refused permission, a camera another app had
        // taken and a pose library that wouldn't load, which made a real
        // iPhone report impossible to act on. The reason is also kept in the
        // diagnostics readout, which survives the toast.
        diag.cameraError = String((e && e.message) || e);
        showToast(`Camera unavailable (${diag.cameraError}) — switching to hold-phone mode.`);
        showDiagnostics(true);
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
      hideMotionPermBanner();
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
      hideMotionPermBanner();
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
  // Collected until there are POSE_CENTER_SAMPLES of them, then reduced to a
  // median and cleared — see the lane block in onPose().
  const poseCenterSamples = [];
  let poseHipYBaseline = null;
  // Absolute lane zone the player's body is currently in: -1 left, 0
  // center, 1 right. Recomputed every frame from raw position (with
  // ENTER/EXIT hysteresis), not stepped/toggled — so standing back in a
  // neutral stance always lands you back at 0 (center lane) on its own.
  let cameraLaneZone = 0;
  // Whether the player is currently too close/far DURING REAL PLAY, not just
  // during setup — see the big comment above liveFramingCheck() for why this
  // exists (2026-09-10: "started to move towards the camera and moved off
  // the spot, affecting the motion capture").
  let liveFramingStatus = 'ok';
  let lastLiveFramingSentT = 0;
  let lastWrist = { left: null, right: null };
  // First-qualifying-frame timestamp per arm, awaiting a second confirming
  // frame — see PUNCH_CONFIRM_WINDOW_MS's comment and checkPunch() below.
  let punchPending = { left: null, right: null };

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
        // 2026-09-14: tf.setBackend() RESOLVES FALSE when a backend isn't
        // available — it does not throw. The old code ignored that return
        // value, so on any device where WebGL couldn't be acquired, TFJS
        // quietly settled on the 'cpu' backend instead and MoveNet ran there:
        // seconds per frame rather than tens of milliseconds. Every visible
        // symptom of that is identical to "the camera works but the character
        // never moves", because the gesture detectors need frame-to-frame
        // deltas at something like a real frame rate to fire at all. Check the
        // result, and record whatever we actually ended up on so the
        // diagnostics readout (and therefore a bug report) can say so.
        let ok = false;
        try {
          ok = await tf.setBackend('webgl');
        } catch (e) {
          diag.backendError = String((e && e.message) || e);
        }
        if (!ok) {
          diag.backendError = diag.backendError || 'WebGL backend unavailable';
          try { await tf.setBackend('cpu'); } catch {}
        }
        await tf.ready();
        diag.backend = (typeof tf.getBackend === 'function' && tf.getBackend()) || 'unknown';
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
  // =========================================================================
  // SCREEN WAKE LOCK — 2026-09-14, "iPhone 13 didn't work when doing the
  // motion capture"
  // =========================================================================
  // Camera mode's entire premise is that the phone is propped up and then NOT
  // touched again: the player walks back to their play space and looks at the
  // TV for the rest of setup and the whole run. From the phone's point of view
  // that is minutes of zero user input — and a phone receiving no input locks
  // its screen. When it locks, the page is suspended, the OS stops the camera
  // track, and every pose frame from then on fails. Nothing reaches the TV,
  // but when you pick the phone up and unlock it the camera preview springs
  // back looking perfectly healthy. That is precisely the reported symptom:
  // camera fine, character never moved.
  //
  // Why this bit an iPhone when the Android phone this was built against was
  // fine: Chrome on Android takes a display wake lock of its own while a
  // visible <video> element is playing, and a camera preview counts — so
  // Android had been staying awake by accident, for a reason nothing in this
  // code asked for. iOS Safari does no such thing for muted inline video or a
  // MediaStream, so an iPhone just follows its Auto-Lock setting, whose
  // shortest option is 30 SECONDS — far less than camera setup takes on any
  // device.
  //
  // Fix: hold a real Screen Wake Lock for as long as the camera is running
  // (Safari 16.4+, Chrome 84+), re-acquire it whenever the page returns to the
  // foreground — the platform releases it on hide, by spec, so this is not
  // optional — and release it when the camera stops. Where the API isn't
  // available at all, say so on screen: a page cannot override Auto-Lock
  // without it, and the player needs to know to change that setting rather
  // than discover it by having the game quietly stop.
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || !navigator.wakeLock) {
      diag.wakeLock = 'unsupported';
      return false;
    }
    if (wakeLock) return true;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      diag.wakeLock = 'held';
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        if (diag.wakeLock === 'held') diag.wakeLock = 'released';
      });
      return true;
    } catch (e) {
      // Thrown when the page is hidden, the battery is very low, or the
      // platform simply refuses. Not fatal — worth reporting, not worth
      // stopping over.
      wakeLock = null;
      diag.wakeLock = 'refused';
      diag.wakeLockError = String((e && e.message) || e);
      return false;
    }
  }
  function releaseWakeLock() {
    if (!wakeLock) return;
    try { wakeLock.release(); } catch {}
    wakeLock = null;
    diag.wakeLock = 'released';
  }

  // A <video> fed by a MediaStream can report 0x0 for a short while after
  // loadedmetadata on some platforms, and TFJS throws outright on a zero-sized
  // input. Waiting for real dimensions once, here, is cheaper than letting
  // every early frame fail and be swallowed — and it also means
  // syncOverlayCanvas() below sizes itself against a frame that exists.
  function waitForVideoDimensions(timeoutMs = 5000) {
    if (cameraVideo.videoWidth > 0 && cameraVideo.videoHeight > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = performance.now();
      const tick = () => {
        if (cameraVideo.videoWidth > 0 && cameraVideo.videoHeight > 0) return resolve(true);
        if (performance.now() - started > timeoutMs) return resolve(false);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  async function openCameraStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // Nearly always an insecure origin: both iOS and Android hide
      // mediaDevices entirely on plain http:// (localhost excepted), so this
      // is worth naming rather than reporting as a generic camera failure.
      throw new Error('This browser is not offering camera access (is the page on https?)');
    }
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    cameraVideo.srcObject = cameraStream;
    await new Promise((resolve) => {
      if (cameraVideo.readyState >= 1) return resolve();
      cameraVideo.onloadedmetadata = () => resolve();
    });
    // play() returns a promise that can reject (autoplay policy, a stream
    // pulled away mid-start). The old code ignored it, which turned a failed
    // play into a permanently blank tracker with no message anywhere.
    try {
      await cameraVideo.play();
    } catch (e) {
      diag.playError = String((e && e.message) || e);
    }
    await waitForVideoDimensions();
    // The camera track ending underneath us is the single most likely way
    // camera mode dies in the field (screen lock, another app taking the
    // camera, the OS reclaiming it). Listen for it directly rather than
    // inferring it from failing inference.
    const track = cameraStream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', () => {
        diag.trackEnded = true;
        noteCameraLost('The camera stopped — phone may have locked its screen.');
      });
      track.addEventListener('mute', () => { diag.trackMuted = true; });
      track.addEventListener('unmute', () => { diag.trackMuted = false; });
    }
  }

  async function startCamera() {
    cameraStatus.textContent = 'Starting camera…';
    cameraView.style.display = 'block';

    if (!cameraStream) await openCameraStream();
    syncOverlayCanvas();
    // Deliberately not awaited — the camera should never wait on this — but the
    // result does matter to the player, because a phone that can't be kept
    // awake will lock itself mid-run and take the camera with it.
    acquireWakeLock().then((held) => {
      if (held) return;
      showToast(diag.wakeLock === 'unsupported'
        ? "Can't stop this phone sleeping — set Auto-Lock to Never, or tracking will stop."
        : "Couldn't keep the screen awake — if tracking stops, wake the phone and it'll pick back up.");
    });

    cameraStatus.textContent = 'Loading pose tracker…';
    await ensureDetector();
    if (diag.backend && diag.backend !== 'webgl') {
      // Worth interrupting the player for: MoveNet on the CPU backend is far
      // too slow for gesture detection, so this is a real "it will not work"
      // rather than a curiosity.
      showToast(`Pose tracking is running on the slow "${diag.backend}" mode — movements may not register.`);
    }
    cameraStatus.textContent = 'Step into frame';

    resetPoseHealth();
    if (!poseLoopRunning) {
      poseLoopRunning = true;
      poseLoop();
    }
  }
  function stopCamera() {
    poseLoopRunning = false;
    releaseWakeLock();
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
  }

  // =========================================================================
  // POSE-LOOP HEALTH — 2026-09-14
  // =========================================================================
  // poseLoop()'s catch used to read `// transient — skip this frame` and
  // discard the error. That is right for the occasional dropped frame and
  // catastrophic for anything permanent: a tracker that has stopped working
  // for good produces exactly the same screen as a player who simply isn't
  // standing in frame yet — camera preview running, no skeleton, no messages,
  // forever, on both the phone and the TV. Every candidate cause of the
  // iPhone report (a stopped camera track, a zero-sized video, a WebGL
  // context loss, a detector that won't run on this device) reached the
  // player identically: as silence. So: count how LONG failure has been
  // continuous, try one automatic recovery, and if that doesn't take, say
  // plainly what happened and point at the fallback that always works.
  let poseFailSince = 0;
  let poseLastOkT = 0;
  let poseRecoveryTried = false;
  let poseGaveUp = false;
  let poseFrameCount = 0;
  let poseFpsWindowStart = 0;

  function resetPoseHealth() {
    poseFailSince = 0;
    poseLastOkT = performance.now();
    poseRecoveryTried = false;
    poseGaveUp = false;
    poseFrameCount = 0;
    poseFpsWindowStart = performance.now();
    diag.poseFps = 0;
    diag.poseError = '';
    diag.trackEnded = false;
  }

  // Called both by the track's own 'ended' event and by the failure path
  // below — whichever notices first.
  function noteCameraLost(message) {
    if (currentMode !== 'camera' || poseGaveUp) return;
    cameraStatus.textContent = message;
    showDiagnostics(true);
    tryCameraRecovery();
  }

  let recoveryInFlight = false;
  async function tryCameraRecovery() {
    if (recoveryInFlight || poseRecoveryTried || currentMode !== 'camera') return;
    recoveryInFlight = true;
    poseRecoveryTried = true;
    diag.recoveryAttempts = (diag.recoveryAttempts || 0) + 1;
    try {
      cameraStatus.textContent = 'Restarting camera…';
      if (cameraStream) {
        cameraStream.getTracks().forEach((t) => t.stop());
        cameraStream = null;
      }
      await openCameraStream();
      syncOverlayCanvas();
      acquireWakeLock();
      resetPoseHealth();
      cameraStatus.textContent = 'Step into frame';
      if (!poseLoopRunning) { poseLoopRunning = true; poseLoop(); }
      // Clear the TV's sticky "phone stopped tracking" banner — it doesn't
      // clear itself (see updateTrackingWarning() in tv/game.js), because
      // nothing but this actually fixes it.
      sendCalibration('tracking', { status: 'ok' });
    } catch (e) {
      diag.recoveryError = String((e && e.message) || e);
      giveUpOnCamera();
    } finally {
      recoveryInFlight = false;
    }
  }

  function giveUpOnCamera() {
    if (poseGaveUp) return;
    poseGaveUp = true;
    cameraStatus.textContent = 'Camera tracking has stopped';
    showDiagnostics(true);
    showToast('Camera tracking stopped working. Tap 🎮 Controller at the top to keep playing.');
    // The TV is the only screen the player is actually looking at during a
    // run, so it has to hear about this too — reuse the framing/tracking
    // message the TV already understands and relays unconditionally.
    sendCalibration('tracking', { status: 'camera_lost' });
  }

  // 2026-09-14: nothing in this file watched for the page being backgrounded.
  // The wake lock is released by the platform on hide (by spec), and on iOS a
  // screen lock also ends the camera track — so coming back to the foreground
  // is exactly the moment to re-take the lock and check whether there is still
  // a live camera to read from.
  document.addEventListener('visibilitychange', () => {
    diag.hiddenCount = diag.hiddenCount || 0;
    if (document.hidden) {
      diag.hiddenCount++;
      diag.lastHiddenAt = new Date().toLocaleTimeString();
      return;
    }
    if (currentMode !== 'camera') return;
    acquireWakeLock();
    const track = cameraStream && cameraStream.getVideoTracks()[0];
    const dead = !track || track.readyState === 'ended';
    if (dead) {
      poseRecoveryTried = false; // a fresh chance now that we're visible again
      poseGaveUp = false;
      noteCameraLost('Camera stopped while the phone was asleep — restarting…');
    } else if (cameraVideo.paused) {
      cameraVideo.play().catch((e) => { diag.playError = String((e && e.message) || e); });
    }
  });

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
      // A successful call clears the failure streak — see the POSE-LOOP HEALTH
      // block above for why a streak is tracked at all.
      poseFailSince = 0;
      poseLastOkT = now;
      poseFrameCount++;
      if (now - poseFpsWindowStart >= 1000) {
        diag.poseFps = Math.round((poseFrameCount * 1000) / (now - poseFpsWindowStart));
        poseFrameCount = 0;
        poseFpsWindowStart = now;
      }
      diag.videoSize = `${cameraVideo.videoWidth}x${cameraVideo.videoHeight}`;
      processPose(poses[0]);
    } catch (e) {
      // Still skip the frame — but no longer silently. One bad frame is
      // ordinary; continuous failure is the bug that hid the iPhone problem.
      if (!poseFailSince) poseFailSince = now;
      diag.poseError = String((e && e.message) || e);
      const failedFor = now - poseFailSince;
      if (failedFor > POSE_FAIL_GIVEUP_MS) {
        giveUpOnCamera();
      } else if (failedFor > POSE_FAIL_RECOVER_MS) {
        tryCameraRecovery();
      } else if (failedFor > POSE_FAIL_WARN_MS) {
        cameraStatus.textContent = 'Tracking trouble — hold on…';
      }
    }
    requestAnimationFrame(poseLoop);
  }

  // The stall watchdog has to live OUTSIDE poseLoop(). estimatePoses() can
  // stop coming back entirely rather than rejecting — a lost WebGL context can
  // leave that promise pending forever, and requestAnimationFrame stops firing
  // altogether while the page is backgrounded — and in either case the loop is
  // parked at its own `await`, so no check placed inside it can ever run. A
  // plain interval keeps ticking regardless, which is the whole point.
  setInterval(() => {
    if (!poseLoopRunning || currentMode !== 'camera' || poseGaveUp) return;
    if (document.hidden) return; // expected to be idle; visibilitychange handles the return
    const since = performance.now() - poseLastOkT;
    if (!poseLastOkT || since <= POSE_STALL_MS) return;
    diag.poseError = diag.poseError || `no pose frame for ${Math.round(since / 1000)}s`;
    if (poseRecoveryTried) giveUpOnCamera(); else tryCameraRecovery();
  }, 1000);

  function kp(keypoints, name) {
    const p = keypoints.find((k) => k.name === name);
    return p && p.score >= POSE_MIN_SCORE ? p : null;
  }
  function midpoint(a, b) {
    if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return a || b || null;
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // 2026-09-15. Works out, from whatever this frame's keypoints happen to
  // contain, the two numbers the whole detector runs on: the point to measure
  // movement FROM, and the yardstick to measure it AGAINST. Returns null when
  // there isn't enough of a person to track at all — which now means "no
  // shoulders", not "no full torso".
  //
  // Both shoulders are the real requirement, and that is a low bar by design:
  // a camera that can see a person at all in a living room can almost always
  // see their shoulders, and shoulders alone carry every gesture this game
  // needs — sideways for lane, up for jump, down for duck, and they are the
  // anchor a punch is measured from anyway.
  let bodyRef = null;           // 'hips' | 'shoulders'
  let hipsPresentFrames = 0;
  let smoothedScale = null;
  function resolveBody(shoulderMid, hipMid, lShoulder, rShoulder) {
    // Scale first, since the reference choice doesn't change what a torso is
    // worth. Prefer a real torso; fall back to shoulder width converted to an
    // equivalent torso so every existing *_TORSO_FRAC constant keeps meaning
    // the same physical distance.
    let rawScale = null;
    if (shoulderMid && hipMid) rawScale = dist(shoulderMid, hipMid);
    else if (lShoulder && rShoulder) rawScale = dist(lShoulder, rShoulder) * SHOULDER_WIDTH_TO_TORSO;
    if (!rawScale || !shoulderMid) {
      bodyRef = null;
      hipsPresentFrames = 0;
      smoothedScale = null;
      return null;
    }
    // Smoothed, because the thresholds derived from it are compared against
    // per-frame movement: an unsmoothed scale makes every threshold jitter by
    // a few percent each frame, which is the sort of thing that turns a
    // borderline duck into an intermittent one.
    rawScale = Math.max(20, rawScale);
    smoothedScale = smoothedScale === null ? rawScale : smoothedScale * 0.85 + rawScale * 0.15;

    // Reference point. Hips are preferred when genuinely available — they are
    // what the thresholds were originally tuned against — but only after
    // they've been steady for a while, so an intermittent hip can't drag the
    // reference back and forth.
    hipsPresentFrames = hipMid ? hipsPresentFrames + 1 : 0;
    let nextRef;
    if (!hipMid) nextRef = 'shoulders';
    else if (bodyRef === null) nextRef = 'hips';   // first acquisition: take the best available at once
    else if (bodyRef === 'hips') nextRef = 'hips';
    else nextRef = hipsPresentFrames >= REF_HIP_REACQUIRE_FRAMES ? 'hips' : 'shoulders';

    // First acquisition is not a "switch": there are no stale baselines to
    // throw away, and counting it would put a misleading 1 in the diagnostics
    // readout at the start of every single run.
    const firstAcquisition = bodyRef === null;
    if (nextRef !== bodyRef && firstAcquisition) {
      bodyRef = nextRef;
    } else if (nextRef !== bodyRef) {
      // The reference just moved by most of a torso in one frame. Every
      // baseline measured against the OLD reference is now meaningless, and
      // leaving them in place is what would fire a phantom jump or duck at
      // the exact moment the player's hips slipped out of frame. Same reset
      // liveFramingCheck() does when the player changes distance, and for the
      // same reason.
      bodyRef = nextRef;
      poseCenterX = null;
      poseCenterSamples.length = 0;
      poseHipYBaseline = null;
      jumpArmed = true;
      duckArmed = true;
      punchPending = { left: null, right: null };
      diag.refSwitches = (diag.refSwitches || 0) + 1;
    }
    diag.bodyRef = bodyRef;
    return {
      point: bodyRef === 'hips' ? hipMid : shoulderMid,
      scale: smoothedScale,
      ref: bodyRef,
      hasHips: !!hipMid,
      // What the player would say they can see of themselves — used for the
      // framing advice and shown in the diagnostics readout.
      view: hipMid ? 'full body' : 'head & shoulders',
    };
  }

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
    // 2026-09-15 ("in landscape it's rare that the player's full body will be
    // visible"): "locked" used to mean a FULL TORSO — both a shoulder and a
    // hip — and every threshold in this file was a fraction of the
    // shoulder-to-hip distance. Propped up in landscape, a phone very often
    // sees head and shoulders and no hips at all, and in that framing the old
    // check never locked on: the overlay stayed red, the status stayed "Step
    // into frame", and nothing was ever detected. Tracking now degrades
    // instead of failing — see resolveBody() for what it falls back to and
    // why switching reference mid-run has to reset the baselines.
    const body = resolveBody(shoulderMid, hipMid, lShoulder, rShoulder);
    const locked = !!body;
    diag.locked = locked;
    drawFramingGuide(locked);
    drawSkeleton(keypoints, locked);
    if (!locked) {
      cameraStatus.textContent = 'Step into frame';
      if (framingActive) sendFramingThrottled('no_person', false);
      return;
    }
    cameraStatus.textContent = '';

    // `refPoint` is the single point every gesture is measured from (hips when
    // they're there, shoulders otherwise) and `torsoScale` is the yardstick
    // every threshold is a fraction of — an EQUIVALENT torso length, so all
    // the existing tuning keeps its meaning whichever source it came from.
    const refPoint = body.point;
    const torsoScale = body.scale;
    // Recorded for the diagnostics readout: torso size as a fraction of the
    // frame's short side is the number every framing decision turns on, so
    // seeing it is what distinguishes "the framing gate is rejecting this
    // player" from "pose detection isn't running at all".
    {
      const shortSide = Math.min(cameraVideo.videoWidth || 1, cameraVideo.videoHeight || 1);
      diag.torsoFrac = torsoScale / shortSide;
    }

    // 2026-09-15: computed ONCE per frame and shared by the setup gate and
    // the in-play drift check below, which used to run separate and (after
    // this round) incompatible versions of the same judgement.
    const framingStatus = computeFramingStatus(keypoints, refPoint, torsoScale, body);

    if (framingActive) {
      // Still working through the placement/framing handshake with the TV
      // — evaluate & report how well-framed the player is, but don't ALSO
      // run real lane/jump/punch detection on top of that (see the big
      // header comment for why).
      evaluateFraming(framingStatus);
      return;
    }
    if (inCameraSetupGate) return; // still on the "place your phone" step — camera's warming up, nothing to detect yet
    if (!detectionEnabled) return;

    liveFramingCheck(framingStatus);

    // Lane (absolute: which zone is the player's body in right now).
    // NOTE the sign convention: the camera feed is mirrored for display
    // (see `transform: scaleX(-1)` in CSS) so it feels like a selfie
    // mirror, but pose detection runs on the RAW (unmirrored) video frame.
    // So the player's real left is +x in raw coordinates, meaning a
    // positive dx (hips moved toward larger raw-x) corresponds to the
    // player's own left, hence zone -1.
    const frameW = cameraVideo.videoWidth;
    // Thresholds in PIXELS, derived from this player's torso rather than
    // from the frame — see the long note on LANE_ENTER_TORSO_FRAC. Clamped
    // so a bad torso read can't turn the centre lane into a hair trigger or
    // into something unreachable.
    const laneEnter = Math.min(
      LANE_ENTER_MAX_FRAME_FRAC * frameW,
      Math.max(LANE_ENTER_MIN_FRAME_FRAC * frameW, LANE_ENTER_TORSO_FRAC * torsoScale),
    );
    const laneExit = laneEnter * (LANE_EXIT_TORSO_FRAC / LANE_ENTER_TORSO_FRAC);

    // Learn the player's neutral x from a short burst and take the MEDIAN,
    // so one frame caught mid-step can't define "centre" for the whole run
    // (which is what used to happen — and calibration asks for a LEFT step
    // and a RIGHT step immediately beforehand, so being mid-step at that
    // moment was likely rather than unlucky).
    if (poseCenterX === null) {
      poseCenterSamples.push(refPoint.x);
      if (poseCenterSamples.length >= POSE_CENTER_SAMPLES) {
        const sorted = poseCenterSamples.slice().sort((a, b) => a - b);
        poseCenterX = sorted[sorted.length >> 1];
        poseCenterSamples.length = 0;
      }
    }
    // Jump/duck/punch below don't depend on the lane baseline, so they stay
    // live through those few frames — only lane reporting waits.
    if (poseCenterX !== null) {
      const dx = refPoint.x - poseCenterX;
      updateLaneMarker(dx, laneEnter);

      const nextZone = computeZone(dx, cameraLaneZone, laneEnter, laneExit);
      if (nextZone !== cameraLaneZone) {
        cameraLaneZone = nextZone;
        actionHandlers.laneZone(cameraLaneZone);
      }
      // Very slow drift correction, and only while the player is clearly
      // standing neutral — people creep across a room over a two-minute run,
      // and without this the centre lane gradually stops being where they
      // are standing. The band keeps it from eroding a deliberate lean that
      // is sitting just inside the enter threshold.
      if (cameraLaneZone === 0 && Math.abs(dx) < laneEnter * POSE_CENTER_SETTLE_BAND) {
        poseCenterX += (refPoint.x - poseCenterX) * POSE_CENTER_SETTLE;
      }
    }

    // The little live figure on the TV (2026-09-16). Setup only: during a real
    // run the player is watching the game, not a diagram of themselves, and
    // there is no reason to spend the bandwidth. See sendPoseViewThrottled().
    if (actionHandlers === calHandlers) {
      // framingStatus is already computed once per frame further up — reused
      // here deliberately rather than recomputed, so the figure's "you're
      // drifting out of shot" warning can never disagree with the one the
      // setup gate and the in-play drift check are using.
      sendPoseViewThrottled(
        keypoints, frameW, cameraVideo.videoHeight, cameraLaneZone,
        poseCenterX, laneEnter, framingStatus,
      );
    }

    // Jump (hips rise) and duck (hips drop) share one baseline, because
    // they are the same measurement in opposite directions. Screen y grows
    // downward, so `rise` is positive when the player goes UP and `drop`
    // is positive when they go DOWN.
    if (poseHipYBaseline === null) poseHipYBaseline = refPoint.y;
    const rise = poseHipYBaseline - refPoint.y;
    const drop = refPoint.y - poseHipYBaseline;
    const now = performance.now();
    const inCalibration = actionHandlers === calHandlers;
    // 2026-09-15: scaled up when measuring from the shoulders, which travel
    // further into a crouch than the hips this threshold was tuned against —
    // see SHOULDER_REF_DUCK_MULT.
    const duckRefMult = body.ref === 'shoulders' ? SHOULDER_REF_DUCK_MULT : 1;
    const duckTrigger = (inCalibration ? CAL_DUCK_TRIGGER_TORSO_FRAC : DUCK_TRIGGER_TORSO_FRAC) * torsoScale * duckRefMult;
    const duckCooldown = inCalibration ? CAL_DUCK_COOLDOWN_MS : DUCK_COOLDOWN_MS;

    // Re-arm once the hips have genuinely returned near baseline — i.e. the
    // player has landed the jump / come back up out of the duck. See
    // JUMP_REARM_TORSO_FRAC's comment for why this exists ("stuck on
    // jump"): without it, a single jump whose hang time outlasts the
    // cooldown could fire twice (or more) off the same physical motion.
    if (!jumpArmed && rise < JUMP_REARM_TORSO_FRAC * torsoScale) jumpArmed = true;
    if (!duckArmed && drop < DUCK_REARM_TORSO_FRAC * torsoScale) duckArmed = true;

    if (jumpArmed && rise > JUMP_TRIGGER_TORSO_FRAC * torsoScale && now - lastJumpTime > JUMP_COOLDOWN_MS && now - lastActionTime > CROSS_TALK_LOCK_MS) {
      lastJumpTime = now;
      lastActionTime = now;
      jumpArmed = false;
      actionHandlers.jump();
    } else if (duckArmed && drop > duckTrigger
        && now - lastDuckTime > duckCooldown
        && now - lastJumpTime > DUCK_AFTER_JUMP_LOCK_MS
        && now - lastActionTime > CROSS_TALK_LOCK_MS) {
      lastDuckTime = now;
      lastActionTime = now;
      duckArmed = false;
      actionHandlers.duck();
    } else if (jumpArmed && duckArmed) {
      // The baseline only re-settles while genuinely at rest (both armed —
      // not mid-jump or mid-duck) — otherwise a held crouch would drag the
      // baseline down with it (and the player would have to duck further
      // and further each time), or a long jump's hang time would slowly
      // pull the baseline up to meet it.
      poseHipYBaseline = poseHipYBaseline * 0.94 + refPoint.y * 0.06;
    }

    // Punch (fast wrist extension)
    checkPunch('left', kp(keypoints, 'left_wrist'), lShoulder, torsoScale, now);
    checkPunch('right', kp(keypoints, 'right_wrist'), rShoulder, torsoScale, now);
  }

  // 2026-09-10 ("started to move towards the camera and moved off the
  // spot, affecting the motion capture"): the placement/framing handshake
  // above only ever ran ONCE, during setup — once a real run started,
  // nothing noticed a player drifting closer or farther from the lens.
  // The lane/jump/duck thresholds already scale with torsoScale each
  // frame, so they mostly track a gradual size change on their own, but
  // the BASELINES they're measured against (poseCenterX, poseHipYBaseline)
  // are fixed pixel positions from whenever they were last set, and don't
  // move with the player — a real step toward the camera changes both
  // torso scale AND the hips' pixel position at once, which is exactly the
  // kind of jump the slow drift-correction elsewhere in this file (see
  // POSE_CENTER_SETTLE) is deliberately too gentle to absorb quickly.
  //
  // This reuses the same too-close/too-far thresholds the setup screen
  // already trusts, checked continuously during real play: the moment the
  // player crosses into "too close" or "too far", both baselines are
  // dropped so they get rebuilt fresh from right now (a stale reference
  // measured at the OLD distance is worse than none), and the TV is told
  // so it can nudge the player back — the phone itself is usually propped
  // up out of sight during play, so that's the only place the player will
  // actually see the warning. Hysteresis (the *_CLEAR fractions) stops
  // this flapping on/off right at the boundary, same idea as
  // LANE_EXIT_TORSO_FRAC for lanes.
  // 2026-09-15: now fed the SAME framing verdict the setup gate uses, rather
  // than running its own copy of the distance maths against thresholds tuned
  // for a full-body view. Keeping two implementations was how the setup gate
  // and the in-play check could disagree — and once setup accepts an
  // upper-body framing, a live check still using the old bounds would have
  // spent the whole run insisting the player was too close.
  //
  // Hysteresis is now "hold the new verdict for a moment before acting on it"
  // rather than a second set of clearance thresholds. It does the same job —
  // stopping a player sitting right on a boundary from flapping in and out of
  // the warning — and it works for every status, including the cut-off ones
  // that have no single number to put a clearance band around.
  let livePendingStatus = 'ok';
  let livePendingSinceT = 0;
  function liveFramingCheck(status) {
    const now = performance.now();
    // Only two of the framing verdicts mean anything DURING a run, and this
    // mapping is load-bearing:
    //   - 'good' is the setup gate's word for healthy; this check's word is
    //     'ok'. Treating them as different statuses made the first
    //     well-framed moment of every run look like a status CHANGE, which
    //     dropped the lane/jump/duck baselines and re-armed everything —
    //     silently eating whatever gesture was in progress. Caught by
    //     mr_test_pose_gestures.js ("a second, genuine jump after landing").
    //   - 'off_center' is a setup concern only. Mid-run, being off-centre IS
    //     the game: it's how you change lane. Warning about it, or resetting
    //     baselines over it, would fight the player constantly.
    const settled = (status === 'too_close' || status === 'too_far') ? status : 'ok';
    if (settled !== livePendingStatus) {
      livePendingStatus = settled;
      livePendingSinceT = now;
    }
    // A verdict has to persist to count. 'ok' is allowed to take effect
    // faster than a warning: clearing a warning the player has already acted
    // on should feel immediate, while raising one should not fire on a single
    // odd frame.
    const holdMs = settled === 'ok' ? LIVE_FRAMING_OK_HOLD_MS : LIVE_FRAMING_WARN_HOLD_MS;
    if (now - livePendingSinceT < holdMs) return;

    const changed = settled !== liveFramingStatus;
    liveFramingStatus = settled;

    if (changed) {
      // Whichever way this just changed, the OLD baselines were measured
      // at the OLD distance — re-seed them from scratch rather than let a
      // stale reference keep fighting the player. poseCenterX going back
      // to null re-runs the same short median-sampling burst used on
      // first ever calibration (see POSE_CENTER_SAMPLES above), rather
      // than trusting one possibly-mid-step frame.
      poseCenterX = null;
      poseCenterSamples.length = 0;
      poseHipYBaseline = null;
      jumpArmed = true;
      duckArmed = true;
      punchPending = { left: null, right: null };
      if (cameraLaneZone !== 0) { cameraLaneZone = 0; actionHandlers.laneZone(0); }
    }
    if (changed || (settled !== 'ok' && now - lastLiveFramingSentT > LIVE_FRAMING_SEND_INTERVAL_MS)) {
      lastLiveFramingSentT = now;
      sendCalibration('tracking', { status: settled });
    }
  }

  // Reports whether enough of the player is visible, at a sensible
  // distance, roughly centered — everything the TV's silhouette guide
  // needs to tell the player "step back" / "come closer" / "you're set".
  // There's no real-world distance measurement available (no known camera
  // focal length), so "too close/far" is inferred from torso height as a
  // fraction of the frame — untested against a real phone camera, same
  // caveat as the rest of this file's thresholds (see header comment).
  // 2026-09-15, rewritten for "in landscape it's rare that the player's full
  // body will be visible".
  //
  // This used to judge distance purely by torso height as a fraction of the
  // frame's short side, between two fixed bounds. That test assumes a full
  // body in frame, and it actively REJECTED the framing Don describes: stand
  // where a landscape phone can only see you from the waist up and your torso
  // fills far more of the frame than 0.34, so the old check called it
  // "too_close" and told you to back away — from a position that tracks
  // perfectly well. Setup could not be completed from a normal living-room
  // distance.
  //
  // What actually matters is not how much of you is in shot, it is:
  //   1. can the tracker see enough of you to read a gesture (are you big
  //      enough in frame, and are your shoulders there at all), and
  //   2. are you being CUT OFF at the edges, so a movement would carry part
  //      of you out of shot.
  // Both are checked directly now, and an upper-body-only view passes.
  function computeFramingStatus(keypoints, refPoint, torsoScale, body) {
    const frameW = cameraVideo.videoWidth;
    const frameH = cameraVideo.videoHeight;
    const nose = kp(keypoints, 'nose');
    const lShoulder = kp(keypoints, 'left_shoulder');
    const rShoulder = kp(keypoints, 'right_shoulder');

    let status;
    // Still normalised against the SHORT side, so the number means the same
    // physical distance whichever way up the phone is — the one part of the
    // old approach that was orientation-independent and worth keeping.
    const torsoFrac = torsoScale / Math.min(frameW, frameH);
    const centerOffsetFrac = Math.abs(refPoint.x - frameW / 2) / frameW;
    const marginX = frameW * FRAMING_EDGE_MARGIN_FRAC;
    const marginY = frameH * FRAMING_EDGE_MARGIN_FRAC;
    // "Cut off" = a landmark we depend on is sitting hard against an edge, so
    // any movement toward it leaves the frame. The head and both shoulders
    // are what's depended on; the legs explicitly are not.
    const shoulderOffSide = (lShoulder && (lShoulder.x < marginX || lShoulder.x > frameW - marginX))
      || (rShoulder && (rShoulder.x < marginX || rShoulder.x > frameW - marginX));
    const headCutOff = nose && nose.y < marginY;
    // Room to jump: the head needs somewhere to go. A player framed with
    // their head already at the top of shot will leave the frame the moment
    // they jump, and the jump will read as their head vanishing.
    const noHeadroom = nose && nose.y < torsoScale * 0.45;

    if (!body || !nose) status = 'no_person';
    else if (torsoFrac < FRAMING_MIN_SCALE_FRAC) status = 'too_far';
    else if (shoulderOffSide || headCutOff || noHeadroom) status = 'too_close';
    else if (centerOffsetFrac > FRAMING_OFFCENTER_FRAC) status = 'off_center';
    else status = 'good';
    diag.framing = status;
    diag.view = body ? body.view : '-';
    return status;
  }

  // The setup-gate half: how long has the player held a good framing, and is
  // that long enough to tell the TV they're ready to move on.
  function evaluateFraming(status) {
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
      sendCalibration('framing', { status, ready, view: diag.view });
    }
  }

  // =========================================================================
  // POSE VIEW — the little live figure on the TV (2026-09-16)
  // =========================================================================
  // Don: "It should be clear to the player moving left and right where they
  // have to movement and if they go off screen. Perhaps a camera screen in the
  // bottom corner to show the segment they need to move to."
  //
  // This sends the SKELETON rather than camera frames. Same information for
  // the purpose — where you are, which zone that puts you in, and whether you
  // are drifting out of shot — for a tiny fraction of the bandwidth, and it
  // travels over the relay the game already has rather than needing a video
  // path through it. It also means no picture of anybody's living room ever
  // leaves the phone, which matters more here than the realism would have.
  //
  // Coordinates are normalised 0..1 of the frame and MIRRORED on x, matching
  // the phone's own preview (CSS scaleX(-1)) and the mirror metaphor: step to
  // your left and the figure moves left, the same mapping the character on the
  // TV already teaches.
  const POSE_VIEW_SEND_INTERVAL_MS = 100; // 10/s — smooth enough to read, cheap
  const POSE_VIEW_POINTS = [
    'nose',
    'left_shoulder', 'right_shoulder',
    'left_elbow', 'right_elbow',
    'left_wrist', 'right_wrist',
    'left_hip', 'right_hip',
    'left_knee', 'right_knee',
    'left_ankle', 'right_ankle',
  ];
  let lastPoseViewSentT = 0;

  function sendPoseViewThrottled(keypoints, frameW, frameH, zone, centerX, laneEnter, framing) {
    const now = performance.now();
    if (now - lastPoseViewSentT < POSE_VIEW_SEND_INTERVAL_MS) return;
    lastPoseViewSentT = now;
    if (!frameW || !frameH) return;
    const round = (v) => Math.round(v * 1000) / 1000;
    // A missing/unconfident point is sent as null rather than omitted, so the
    // TV can keep the fixed order and just not draw that bone.
    const pts = POSE_VIEW_POINTS.map((name) => {
      const p = kp(keypoints, name);
      if (!p) return null;
      return [round(1 - p.x / frameW), round(p.y / frameH)];
    });
    // Zone boundaries, mirrored the same way. The player's own left is +x raw,
    // so after mirroring the LEFT boundary is the smaller number — hence the
    // swap here rather than at the drawing end.
    const bounds = (centerX !== null && laneEnter)
      ? [round(1 - (centerX + laneEnter) / frameW), round(1 - (centerX - laneEnter) / frameW)]
      : null;
    sendCalibration('poseview', { pts, zone, bounds, framing });
  }

  // 2026-09-11 ("punch triggers when I've not done a punch", randomly) — see
  // PUNCH_MIN_SCORE/PUNCH_CONFIRM_WINDOW_MS's comment up top for the
  // reasoning. Two changes from the original single-frame check:
  //   - a wrist estimate below PUNCH_MIN_SCORE is treated as untracked
  //     (same as absent), same as kp()'s own POSE_MIN_SCORE gate but held
  //     to a stricter bar because punch trusts a single frame's position;
  //   - a frame that clears the speed+extension bar doesn't fire on its
  //     own. It's remembered as a PENDING punch; only a second qualifying
  //     frame within PUNCH_CONFIRM_WINDOW_MS actually fires. A real punch
  //     stays fast and extended for several consecutive frames near its
  //     peak, so it still confirms almost immediately; an isolated noisy
  //     frame — the "no clear pattern" signature — essentially never
  //     repeats on the very next sample too.
  // Which punch thresholds apply right now. The loosened calibration values
  // exist so a deliberate practice punch on the punch STEP lands easily; they
  // were never meant to be live while the walkthrough is asking for a step to
  // the left, which is how stepping sideways ended up registering as a punch
  // (2026-09-16). Anywhere else — real play, and every non-punch setup step —
  // uses the strict values.
  function punchTuning() {
    const inCalibration = actionHandlers === calHandlers;
    const onPunchStep = inCalibration && expectedCalStep === 'punch';
    if (onPunchStep) {
      return {
        velocity: CAL_PUNCH_VELOCITY_TORSO_FRAC,
        extension: CAL_PUNCH_EXTENSION_FRAC,
        cooldown: CAL_PUNCH_COOLDOWN_MS,
        motionTrigger: CAL_MOTION_PUNCH_TRIGGER,
        motionCooldown: CAL_MOTION_PUNCH_COOLDOWN_MS,
      };
    }
    return {
      velocity: PUNCH_VELOCITY_TORSO_FRAC,
      extension: PUNCH_EXTENSION_FRAC,
      cooldown: PUNCH_COOLDOWN_MS,
      motionTrigger: MOTION_PUNCH_TRIGGER,
      motionCooldown: MOTION_PUNCH_COOLDOWN_MS,
    };
  }

  function checkPunch(side, wrist, shoulder, torsoScale, now) {
    if (!wrist || !shoulder || wrist.score < PUNCH_MIN_SCORE) {
      lastWrist[side] = null;
      punchPending[side] = null;
      return;
    }
    const prev = lastWrist[side];
    const extension = dist(wrist, shoulder) / torsoScale;
    lastWrist[side] = { x: wrist.x, y: wrist.y, t: now, ext: extension };
    if (!prev) return;

    const dt = (now - prev.t) / 1000;
    // Besides the existing "gap too large" guard, also floor dt against a
    // near-zero value — a very short dt would blow up an otherwise modest
    // pixel jitter into a huge, spurious speed reading via division.
    if (dt <= 1 / (POSE_TARGET_FPS * 2) || dt > 0.5) return;
    const dx = wrist.x - prev.x;
    const dy = wrist.y - prev.y;
    const speed = Math.hypot(dx, dy) / dt;

    // Calibration practice punches use the original, more forgiving
    // thresholds — but ONLY on the punch step itself (2026-09-16). See the
    // CAL_PUNCH_* comment up top.
    const tune = punchTuning();
    const velocityThresh = tune.velocity;
    const extensionThresh = tune.extension;
    const cooldown = tune.cooldown;

    // 2026-09-16, the two structural gates — see the PUNCH_MIN_EXTEND_RATE /
    // PUNCH_MAX_VERTICAL_RATIO comments up top. Both are computed from the
    // same two frames the speed above uses, so neither costs a frame of
    // latency. prev.ext is absent for one frame after a fresh acquire, in
    // which case the extension-rate gate can't be evaluated and this frame
    // simply doesn't qualify — the next one will.
    const extendRate = typeof prev.ext === 'number' ? (extension - prev.ext) / dt : null;
    const extending = extendRate !== null && extendRate > PUNCH_MIN_EXTEND_RATE;
    const mostlyHorizontal = Math.abs(dy) <= Math.abs(dx) * PUNCH_MAX_VERTICAL_RATIO;

    const qualifies = speed > velocityThresh * torsoScale
      && extension > extensionThresh
      && extending
      && mostlyHorizontal;

    if (!qualifies) {
      // Only drop an in-progress confirmation once it's aged out — a
      // single frame that missed by a hair shouldn't cost an otherwise-real
      // punch its confirming second frame.
      if (punchPending[side] !== null && now - punchPending[side] > PUNCH_CONFIRM_WINDOW_MS) {
        punchPending[side] = null;
      }
      return;
    }

    const hasPendingInWindow = punchPending[side] !== null && now - punchPending[side] <= PUNCH_CONFIRM_WINDOW_MS;
    if (hasPendingInWindow && now - lastPunchTime > cooldown && now - lastActionTime > CROSS_TALK_LOCK_MS) {
      lastPunchTime = now;
      lastActionTime = now;
      punchPending[side] = null;
      actionHandlers.punch();
      return;
    }
    // Not confirmed this frame — either this is the first qualifying frame,
    // the previous pending one aged out of the window, or a genuine
    // two-frame gesture got blocked by cooldown/cross-talk. Either way,
    // (re)anchor the pending window here so the NEXT qualifying frame gets
    // a fresh chance to confirm, rather than being stuck comparing against
    // a stale timestamp that can never be within the window again.
    punchPending[side] = now;
  }

  // `laneEnter` is now in pixels and varies with the player's torso (see
  // LANE_ENTER_TORSO_FRAC), so the marker is scaled against the threshold
  // itself. That also makes the readout more useful than it was: full
  // deflection is now exactly "one lane change", not an arbitrary slice of
  // the frame that happened to be near it.
  function updateLaneMarker(dx, laneEnter) {
    const frac = Math.max(-1, Math.min(1, dx / (laneEnter * 2.2)));
    laneMarker.style.left = `${50 - frac * 50}%`;
    laneMarker.style.background = Math.abs(dx) > laneEnter ? '#ffd166' : '#6ee7ff';
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

  // 2026-09-14: iOS only grants motion access from a call made DIRECTLY inside
  // a user gesture — once anything has been awaited, the gesture is spent and
  // requestPermission() rejects outright. That is fine on the two paths that
  // reach here straight from a tap (the "Hold my phone instead" button and the
  // 📳 tab), and quietly fatal on the one that doesn't: setMode()'s camera
  // fallback awaits the failed startCamera() first, so on an iPhone a camera
  // problem used to take the hold-phone fallback down with it — no camera, no
  // sensors, one toast, nothing working. Hence `motionPermBanner`: when the
  // prompt can't be raised (or was refused), surface a button so the player
  // can grant it from a fresh, real tap instead of being left with neither
  // mode. Android never has the prompt at all and is unaffected throughout.
  function showMotionPermBanner(reason) {
    diag.motionPerm = reason;
    if (!motionPermBanner) return;
    motionPermBanner.hidden = false;
    motionPermBanner.classList.add('show');
  }
  function hideMotionPermBanner() {
    if (!motionPermBanner) return;
    motionPermBanner.hidden = true;
    motionPermBanner.classList.remove('show');
  }

  async function startMotionListeners() {
    if (motionListenersAttached) return true;
    if (needsIOSPermission()) {
      try {
        const motionResp = await DeviceMotionEvent.requestPermission();
        let orientationResp = 'granted';
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
          orientationResp = await DeviceOrientationEvent.requestPermission();
        }
        if (motionResp !== 'granted' || orientationResp !== 'granted') {
          diag.motionPerm = 'denied';
          showToast('Motion permission denied — use tap-to-steer and the buttons.');
          showMotionPermBanner('denied');
          return false;
        }
      } catch (e) {
        // Overwhelmingly "not called from a user gesture" — recoverable with
        // one tap, so offer that rather than writing the mode off.
        diag.motionPermError = String((e && e.message) || e);
        showToast('Tap “Turn on motion sensors” to let the phone feel your movements.');
        showMotionPermBanner('needs a tap');
        return false;
      }
    }
    diag.motionPerm = 'granted';
    hideMotionPermBanner();
    window.addEventListener('devicemotion', onDeviceMotion);
    window.addEventListener('deviceorientation', onDeviceOrientation);
    motionListenersAttached = true;
    return true;
  }
  if (enableMotionBtn) {
    enableMotionBtn.addEventListener('click', async () => {
      // A genuine tap — the one context iOS will raise the prompt in.
      const ok = await startMotionListeners();
      if (ok) showToast('Motion sensors on.');
    });
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
    // Duck, hold-phone mode (2026-09-04). A jump and a duck are both
    // vertical-dominant, so magnitude alone can't tell them apart — the
    // SIGN is what separates them. `ay` is acceleration along the phone's
    // long axis with gravity removed, so a sharp negative spike is the
    // phone being driven downward: the player dropping into a crouch.
    // Held to a lower trigger than a jump because crouching with a phone
    // in hand is a gentler movement than leaving the ground.
    //
    // Caveat, same as every other threshold in this file: these numbers
    // have not been validated against real handset accelerometer data, and
    // hold-phone mode is the secondary control scheme. Camera mode above
    // is the one to trust, and the on-screen DUCK button is always exact.
    if (ay < -MOTION_DUCK_TRIGGER
        && looksVertical
        && now - lastDuckTime > MOTION_DUCK_COOLDOWN_MS
        && now - lastJumpTime > DUCK_AFTER_JUMP_LOCK_MS) {
      lastDuckTime = now; lastActionTime = now;
      actionHandlers.duck();
      return;
    }
    // Calibration practice punches use the original, more forgiving
    // trigger/cooldown — see the CAL_PUNCH_*/CAL_MOTION_PUNCH_* comments
    // up top for why. The MOTION_JUMP_TRIGGER comparison just below stays
    // the same real trigger in both cases — it's only disambiguating "was
    // this reading big enough to also look like a jump", not part of the
    // punch sensitivity itself.
    // 2026-09-16: scoped to the punch STEP rather than all of setup, same as
    // the camera path — see punchTuning().
    const tune = punchTuning();
    const punchTrigger = tune.motionTrigger;
    const punchCooldown = tune.motionCooldown;
    if (mag > punchTrigger && now - lastPunchTime > punchCooldown) {
      // 2026-09-16 ("Punch is going off too much"): `rotationSaysPunch` used
      // to accept `mag <= MOTION_JUMP_TRIGGER` as evidence of a punch, which
      // on a device reporting no rotationRate at all (most real Androids)
      // meant every vertical-dominant shake below the jump bar fell through
      // to here and fired a punch. A punch on a held phone is a jab —
      // lateral-dominant — so vertical-dominant motion is now rejected
      // outright unless the device's own rotation reading positively says
      // otherwise.
      const rotationSaysPunch = hasRotation && rot >= MOTION_ROTATION_LOW;
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

  // =========================================================================
  // TEST HOOK — 2026-09-11, same idea as tv/game.js's window.__mrDebug:
  // there is no camera or real device motion available in an automated test
  // environment, so gesture-detection regressions (the "stuck on jump" /
  // "punch triggers when I've not done a punch" round) have to be tested
  // by feeding synthetic pose data through the REAL detection code —
  // processPose(), checkPunch() — not a reimplementation of it. This calls
  // processPose() directly (bypassing getUserMedia/TFJS entirely) and
  // exposes the internal arming state a test needs to assert against.
  // Always present, same as __mrDebug — never gated behind an env flag.
  // =========================================================================
  window.__mrPoseDebug = {
    // Puts the detector into the same state real play is in once
    // calibration finishes (see finishCalibration()) — real handlers live,
    // no setup gates active — without going through the camera/permission/
    // calibration UI flow at all. `cameraVideo.videoWidth/videoHeight` are
    // read-only and normally only populated by a real media stream (which
    // getUserMedia never runs in a test), but liveFramingCheck()/
    // evaluateFraming() divide by them — so this stubs in a plausible fixed
    // frame size (default 640x480, matching startCamera()'s requested
    // resolution) via defineProperty, same trick a test would use on any
    // other read-only DOM property.
    enterRealPlay(opts) {
      actionHandlers = realHandlers;
      inCameraSetupGate = false;
      framingActive = false;
      detectionEnabled = true;
      const frameW = (opts && opts.frameW) || 640;
      const frameH = (opts && opts.frameH) || 480;
      Object.defineProperty(cameraVideo, 'videoWidth', { value: frameW, configurable: true });
      Object.defineProperty(cameraVideo, 'videoHeight', { value: frameH, configurable: true });
    },
    // 2026-09-16: the calibration equivalent of enterRealPlay() above, plus a
    // way to say which move the TV is currently asking for and whether it has
    // counted the player in yet. Between them these are what let a test assert
    // the mirror gate (mirrorAllowed()) without driving a whole TV walkthrough
    // — the gate is the fix for "the character is punching before punch is
    // configured", so it needs to be observable on its own.
    enterCalibration(opts) {
      actionHandlers = calHandlers;
      inCameraSetupGate = false;
      framingActive = false;
      detectionEnabled = true;
      const frameW = (opts && opts.frameW) || 640;
      const frameH = (opts && opts.frameH) || 480;
      Object.defineProperty(cameraVideo, 'videoWidth', { value: frameW, configurable: true });
      Object.defineProperty(cameraVideo, 'videoHeight', { value: frameH, configurable: true });
    },
    setCalStep(step, armed) {
      expectedCalStep = step || null;
      calStepArmed = !!armed;
      lastCalStepAt = 0; // don't let the per-step lockout swallow the next case
    },
    calStepState: () => ({ expected: expectedCalStep, armed: calStepArmed }),
    punchTuning: () => punchTuning(),
    // Same reset finishCalibration()/recenter() do, exposed directly so a
    // test can start each case from a clean baseline.
    reset() {
      poseCenterX = null;
      poseCenterSamples.length = 0;
      poseHipYBaseline = null;
      cameraLaneZone = 0;
      jumpArmed = true;
      duckArmed = true;
      punchPending = { left: null, right: null };
      lastWrist = { left: null, right: null };
      lastJumpTime = 0;
      lastDuckTime = 0;
      lastPunchTime = 0;
      lastActionTime = 0;
    },
    // `keypoints`: array of {name, x, y, score}. Feeds straight into the
    // real processPose(), exactly as a real pose-detection frame would.
    injectPose(keypoints) {
      processPose({ keypoints });
    },
    state() {
      return {
        jumpArmed, duckArmed,
        punchPending: { ...punchPending },
        poseHipYBaseline, poseCenterX, cameraLaneZone,
      };
    },
    // 2026-09-14 additions. The wake-lock / camera-recovery / error-surfacing
    // work of this round is all about what happens when the camera or the pose
    // detector FAILS — and neither exists in an automated test environment, so
    // the only way to cover these paths is to drive them directly. Same
    // principle as injectPose() above: exercise the real functions, not a
    // reimplementation of them.
    diag() { return { ...diag }; },
    diagVisible() { return diagVisible; },
    // Pretends the pose detector is failing, for `ms` of simulated continuous
    // failure, and returns what the health logic decided. Exercises the real
    // thresholds (POSE_FAIL_WARN_MS / _RECOVER_MS / _GIVEUP_MS) without
    // needing a camera to break.
    simulatePoseFailure(ms) {
      const now = performance.now();
      poseFailSince = now - ms;
      diag.poseError = 'simulated failure';
      const failedFor = now - poseFailSince;
      if (failedFor > POSE_FAIL_GIVEUP_MS) giveUpOnCamera();
      else if (failedFor > POSE_FAIL_RECOVER_MS) tryCameraRecovery();
      else if (failedFor > POSE_FAIL_WARN_MS) cameraStatus.textContent = 'Tracking trouble — hold on…';
      return { status: cameraStatus.textContent, gaveUp: poseGaveUp, recoveryAttempts: diag.recoveryAttempts };
    },
    // Lets a test assert the mode-plumbing around the failure paths (which
    // check currentMode) without a real getUserMedia call.
    forceMode(mode) { currentMode = mode; },
    // 2026-09-15: puts the detector into the setup FRAMING stage, where
    // computeFramingStatus()/evaluateFraming() run and real gesture detection
    // deliberately does not — the state the partial-body framing rules have to
    // be asserted in. Same idea as enterRealPlay() above.
    enterFramingCheck(opts) {
      actionHandlers = calHandlers;
      inCameraSetupGate = true;
      framingActive = true;
      detectionEnabled = true;
      const frameW = (opts && opts.frameW) || 640;
      const frameH = (opts && opts.frameH) || 480;
      Object.defineProperty(cameraVideo, 'videoWidth', { value: frameW, configurable: true });
      Object.defineProperty(cameraVideo, 'videoHeight', { value: frameH, configurable: true });
    },
    // Resets the partial-body reference tracking, so each test case starts
    // from "nothing acquired yet" rather than inheriting the previous case's
    // reference choice and its re-acquire counter.
    resetBodyRef() {
      bodyRef = null;
      hipsPresentFrames = 0;
      smoothedScale = null;
      diag.refSwitches = 0;
      livePendingStatus = 'ok';
      livePendingSinceT = 0;
      liveFramingStatus = 'ok';
    },
    bodyState() { return { ref: bodyRef, scale: smoothedScale, hipsPresentFrames, switches: diag.refSwitches }; },
    poseHealth() {
      return {
        poseGaveUp, poseRecoveryTried, poseFailSince, poseLastOkT,
        loopRunning: poseLoopRunning,
      };
    },
    resetPoseHealth,
    wakeLockState() { return diag.wakeLock; },
    showDiagnostics,
    // 2026-09-16 (reconnect round) — read-only state a test can assert
    // against without reaching into module internals, plus one action hook
    // for the one thing a test genuinely cannot wait out for real: idle
    // room expiry is tens of minutes even under the server's own
    // MQ_TEST_TIMERS shortcut in some suites, and there's no reason to make
    // a test simulate a whole dropped socket just to reach the same code
    // path handleSessionExpired() already runs for real.
    connectionState() {
      return {
        everPaired,
        deviceToken,
        roomCode,
        reconnecting: !!reconnectTimer,
        bannerText: connectionBanner ? connectionBanner.textContent : '',
        bannerShowing: !!(connectionBanner && connectionBanner.classList.contains('showing')),
        bannerFailed: !!(connectionBanner && connectionBanner.classList.contains('failed')),
        sessionExpiredShown,
        onSessionExpiredScreen: sessionExpiredScreen.style.display !== 'none',
      };
    },
    simulateSessionExpired() { handleSessionExpired(); },
    retryConnectionNow,
    // 2026-09-16 (remembered setup) — read-only + one seeding hook, same
    // spirit as connectionState() above: a test can't get this phone to
    // "have completed every move on a previous visit" any other way than
    // actually playing through calibration once for real first, so this
    // lets it seed (or clear) the exact record saveRememberedSetupIfComplete()
    // would have written, then drive the real offer/use/redo buttons.
    rememberedSetupState() {
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem(REMEMBERED_SETUP_KEY) || 'null'); } catch { stored = 'unreadable'; }
      return {
        stored,
        version: SETUP_VERSION,
        onOfferScreen: rememberedSetupScreen.style.display !== 'none',
        pending: pendingRememberedSetup ? { ...pendingRememberedSetup } : null,
      };
    },
    seedRememberedSetup(rec) {
      try { localStorage.setItem(REMEMBERED_SETUP_KEY, JSON.stringify(rec)); } catch { /* ignore */ }
    },
    clearRememberedSetup() {
      try { localStorage.removeItem(REMEMBERED_SETUP_KEY); } catch { /* ignore */ }
    },
  };

  // =========================================================================
  // STARTUP — join screen first (see the header comment for the flow
  // reorder). If the page was opened by scanning the TV's QR code (see
  // tv/index.html's #joinQr and server.js's /qr/<code>.svg), the URL
  // carries the room code already — fill it in and connect immediately
  // instead of making the player type 6 digits they just scanned past.
  // =========================================================================
  const scannedCode = (new URLSearchParams(location.search).get('code') || '').trim();
  showScreen(joinScreen);
  if (/^\d{6}$/.test(scannedCode)) {
    codeInput.value = scannedCode;
    joinError.textContent = '';
    joinBtn.disabled = true;
    connect(scannedCode);
  }
})();
