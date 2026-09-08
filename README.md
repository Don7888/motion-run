# MotionQuest — *Move Through Time*

A "Danny Go"–style movement game: a 3D runner plays on your TV (Fire TV / any
browser), and your phone is the controller. Two control styles are built
in — camera-based body tracking (prop the phone up and just move) or
hold-the-phone motion sensing — either way: step/lean left or right to
change lanes, hop to jump over hurdles, duck under low bars, and throw a
punch to smash what's in the way.

You run through **four eras**, unlocked in order, oldest first:

| | Era | Finish line |
|---|---|---|
| 🦕 | **Primeval Valley** — volcanic sky, tree ferns, bones in the dirt | 700 m |
| 🏛️ | **Ancient Rome** — marble columns, cypresses, SPQR banners | 900 m |
| 🏙️ | **Present Day** — the original road level | 1100 m |
| 🛸 | **Neon Future** — night city, laser gates, glowing towers | 1300 m |

The **gameplay is identical in every era** — same three lanes, same
collision box, same four moves. Only the costume changes. That is
deliberate: a runner that changed its rules per level would be teaching
four games instead of one. What each era does change is its sky, fog,
lighting, ground, roadside scenery and the shape of all four obstacle
types.

This is a **working prototype**, built and tested as far as this build
environment allows (see *What's been tested* below). It's meant as a strong
starting point to play with on real hardware and iterate on, not a finished,
store-ready product.

## How it works

```
┌────────────────┐   WebSocket    ┌──────────────────┐   WebSocket    ┌───────────────┐
│   Fire TV /     │◄──────────────┤  Node.js server   ├───────────────►│  Your phone   │
│  browser (/tv)  │   room code    │   (this laptop /  │   room code    │ browser(/play)│
│  3D game        │   pairing +    │    PC on same     │   pairing +    │ camera pose / │
│  (Three.js)     │   input relay  │    WiFi network)   │   input relay  │ motion sensors│
└─────────────────┘                └───────────────────┘                └───────────────┘
```

- The **server** (`server.js`) is a small Node.js app with **zero external
  dependencies** — it serves the two web pages over **HTTPS** (see *Why
  HTTPS* below) and relays messages between them over a hand-rolled
  WebSocket implementation (`lib/ws-lite.js`). See *Why no `express`/`ws`
  package* below for why it's built this way.
- The **TV page** (`public/tv`) is a Three.js 3D endless runner. It requests
  a 6-digit room code from the server and displays it on screen.
- The **phone page** (`public/play`) is a mobile web app: create a
  character, join the room code, set up motion detection, then play. It
  becomes the controller; on-screen buttons are always available too as a
  reliable fallback input method.

No app-store install is required for either side — both are just web pages,
opened in a browser, on the same WiFi network.

## Running it

Requires only Node.js 18+ (no `npm install` needed — there are no
dependencies).

```bash
node server.js
```

On Windows there's no need to open a terminal at all — double-click
**`start-lan-windows.bat`**, which does the same thing and leaves the
window open while you play.

The first run generates a self-signed HTTPS certificate for whatever LAN
address this machine currently has (see *Why HTTPS* below) and prints the
exact URL to open — you don't have to look your IP up:

```
Generating a self-signed certificate for 192.168.1.42, 127.0.0.1, localhost…
Saved to certs/ (valid until 2028-12-07).

  Motion Run is running on your network.

  On the TV, open:   https://192.168.1.42:3000/tv

  Then scan the QR code on the TV with your phone.

  Both devices will warn once that the connection isn't private —
  that's the self-signed certificate. Choose Advanced, then proceed.
```

Later runs reuse that certificate silently, and only regenerate it if your
computer's LAN address has changed.

1. On the Fire TV's browser (Silk Browser, or the **Downloader** app, which
   has an easier remote-friendly keyboard for typing URLs — the built-in Fire
   TV launcher doesn't browse the web, so you'll need a browser app
   installed), open `https://<your-LAN-ip>:3000/tv`. You'll hit a "connection
   isn't private" warning — that's expected, see *Why HTTPS* below; tap
   **Advanced → Proceed**. A 6-digit room code appears.
2. **Point your phone's camera at the QR code on the TV** and open the link
   it offers — that carries the room code with it, so there's nothing to
   type. (If the phone won't scan it, open `https://<your-LAN-ip>:3000/play`
   by hand and type the 6-digit code instead.) You'll get the same one-time
   security warning on the phone; **Advanced → Proceed** again.
3. The phone connects to the TV straight away.
4. **Create your character** — pick hair, a hat, and a shirt color, or tap
   **Random**/**Standard** to skip quickly.
5. Choose **Enable Camera Tracking** (prop the phone up, step back) or
   **Hold my phone instead** (the original accelerometer mode).
6. **Quick setup**: a short calibration walkthrough appears **on the TV**,
   one move at a time (step/lean left, step/lean right, jump, punch) — copy
   whatever it shows and the phone (which is doing the actual detecting)
   checks it off. Tap **Skip setup** on the phone any time, or **Start Run**
   once you're happy.

You can also test entirely on one machine: open `/tv` and `/play` in two
browser tabs/windows on the same computer, or on the TV page use the keyboard
fallback (arrow keys/A-D to change lanes, Space to jump, F to punch) if you
just want to see the game running without a phone at all.

### Testing on a phone or Fire TV that isn't on your home network

In **LAN mode** (running `node server.js` on your own laptop, as above), both
pages must be able to reach that machine over WebSocket, so the TV and phone
need to be on the same WiFi network as it. **This whole limitation goes away
once you deploy to Render** — see the next section — since everyone then
connects to one always-on public URL instead of your laptop's LAN IP.

## Deploying to the cloud (Render)

Running the server on a laptop works, but means the laptop has to be on and
awake every time you want to play, and your phone/Fire TV have to be on the
same WiFi network as it. Hosting the server on [Render](https://render.com)
instead removes both constraints: one public URL, reachable from any WiFi
or mobile data connection, no self-signed-certificate warning (Render gives
it a real TLS certificate for free), and the Fire TV Stick never has to do
any of the heavy lifting itself.

`server.js` already supports this — it automatically detects Render's
`RENDER` environment variable and switches from local self-signed-HTTPS mode
to plain HTTP (Render terminates TLS for you in front of the app), so the
exact same code runs in both places.

Render's web-service tooling deploys from a Git repository — it needs
somewhere to `git clone` from — so the one manual step is getting this
project onto GitHub (this build environment has no GitHub access itself,
and no GitHub connector is currently installed, so this part can't be fully
automated from here):

1. If you don't already have one, create a free account at
   [github.com](https://github.com).
2. Click **New repository**, give it a name (e.g. `motion-run`), leave it
   **Public** (there's nothing sensitive in it — the self-signed cert/key in
   `certs/` is gitignored and never committed, see below), and create it.
3. On the new repo's page, click **uploading an existing file** and drag in
   every file/folder from this project *except* `certs/` — `server.js`,
   `package.json`, `lib/`, `public/`, `README.md`, `.gitignore`. Commit the
   upload.
4. Send me the repository's URL (e.g. `https://github.com/yourname/motion-run`)
   and I'll create the Render web service pointed at it — build command
   `npm install`, start command `npm start`, using the free plan.
5. Once it deploys, Render gives you a URL like
   `https://motion-run-xxxx.onrender.com`. Open `/tv` on the Fire TV browser
   and `/play` on your phone — no LAN IP, no security warning, no laptop
   required to be running.

Note: Render's free plan spins the service down after periods of no traffic
and takes ~30–60 seconds to wake back up on the next request — worth
knowing so a "stuck loading" TV screen right after a break isn't mistaken
for a bug.

## Why HTTPS (local LAN mode)

Camera-based tracking uses `getUserMedia()`, which every mobile browser
refuses to grant on a plain `http://` origin (except `localhost`) — camera
access requires a "secure context". There's no real certificate authority
for a private LAN IP, so the server signs its own. Every browser (laptop,
Fire TV, phone) will show a one-time "connection isn't private" warning the
first time it loads the site — tap **Advanced → Proceed**, it only happens
once per browser.

### The certificate looks after itself

On startup the server checks `certs/` for a certificate that is still valid
and still covers this machine's current LAN address. If there isn't one — a
fresh clone, a new router, a DHCP renewal, a different network — it
generates a new one and saves it, then carries on booting. There is nothing
to run by hand, and in particular **no `openssl`**, which matters because
Windows doesn't ship it.

That's `lib/selfsigned-lite.js`: it uses Node's built-in `crypto` for the
key and the signature, and builds the X.509 structure itself, in the same
dependency-free spirit as `lib/ws-lite.js` and `lib/qrcode-lite.js`.

`certs/` is in `.gitignore` and must stay out of the repository — it holds a
private key, and it's specific to one machine's IP anyway. Each clone makes
its own on first run.

One consequence worth knowing: Chrome won't register a service worker on a
self-signed origin, so LAN mode skips that (the TV page detects a bare-IP
address and doesn't try). The game is unaffected; it only means the LAN
address isn't installable as an app, which you'd never want anyway.

## Gameplay

- **3 lanes.** Lane control is absolute, not a step-and-return toggle: the
  game continuously tracks which of 3 zones (left/center/right) your body
  is currently in and puts your character there. Step or lean past a
  threshold to enter the left/right zone, and just standing/holding
  normally again snaps you straight back to the center lane — no
  exaggerated "return" gesture needed.
- **Four obstacle types, one move each.** Every era dresses these
  differently — a crate is a Roman legionary in Ancient Rome and a hovering
  drone in Neon Future — but they always behave the same way:
  - **Hurdles** — jump (hop) to clear them.
  - **Crates** — punch to smash them.
  - **Low bars** — duck under them. Jumping does *not* save you: it puts
    your head straight into the bar. That is the point of having a move
    that isn't "jump".
  - **Walls** — too tall to jump, too tough to punch; the only way past is
    to be in a different lane already.
- Getting hit costs a heart (3 to start, 5 maximum); a short invulnerability
  window follows each hit. Score comes from collecting coins and gems, not
  from distance alone. Hearts and stars appear occasionally — a star gives
  10 seconds of invincible super-speed that ploughs straight through
  anything, walls included. Speed ramps up gradually with distance.
- **Each era has a finish line.** Reach it and the era is complete, your
  best score for it is recorded, and the next era unlocks. Lose all hearts
  first and it's game over — jump or punch to run it again, or press Back
  on the remote to pick a different era.

## The era picker

Finishing setup opens the era picker rather than dropping you straight into
a run. Four cards read left to right as a timeline. Move with **◀ ▶** on the
Fire TV remote and press **OK**, or — without touching the remote at all —
step left and right and jump to confirm. A locked card shakes rather than
silently doing nothing, so it's clear the button worked and the level
didn't.

Progress (which eras are unlocked, and your best score in each) is stored in
the TV's `localStorage` under `motionquest_progress`, for the same reason
the high score is: a Fire TV is a shared family device, so "which eras has
this household reached" belongs to the telly, not to whoever happened to be
holding a phone. Different kids on different phones don't reset each other.
If `localStorage` is unavailable the game still works — progress just lasts
for the session.

## Multiplayer (up to 4 players, take turns)

Any number of phones (1–4) can join the same room before a run starts. With
just one phone, nothing changes — the game plays exactly as always. The
moment a **second** phone joins, choosing an era on the ready screen no
longer starts a run immediately: it becomes a **time trial**. Every joined
player races the same level, one after another, in join order:

- The TV shows a **"Player N's turn"** card naming whoever's up next, then
  runs their turn exactly like a normal solo run — same track, same
  obstacles, same countdown.
- **Only that player's phone controls the character.** Every other phone's
  input is ignored for the duration of the turn (`server.js` stamps each
  phone with a stable `playerId` on join and relays it with every message;
  `game.js` drops any input whose `playerId` doesn't match whoever's turn it
  is). There's no way for player 2 to nudge player 1's run.
- Finishing the level or running out of hearts ends that player's turn and
  automatically advances to the next player's turn-intro card — nobody has
  to press anything to hand off.
- Once everyone has gone, a **leaderboard** ranks finishers by finish time
  (fastest first), with anyone who didn't finish (DNF) listed below,
  ordered by how far they got. Continuing from the leaderboard returns to
  the era picker with the room ready for another round.
- A 5th phone trying to join a full room gets a plain "Room is full" message
  instead of connecting.

This is a bookkeeping layer on top of the existing single-player run, not a
parallel game mode — `resetRun()`, `startCountdown()`, `levelComplete()` and
`gameOver()` are all exactly the same functions a solo player hits, just
called once per turn with a bit of state (`multiplayer.*` in `game.js`)
tracking whose turn it is and what everyone's scored so far.

## Auto-terrain: turns, hills & dips (Primeval Valley & Ancient Rome)

Danny-Go/Temple-Run-style automatic terrain has been added to the two eras
released so far. The path itself bends left and right and rolls over hills
and dips as you run — **no new input required**. The character and camera
simply follow the bend automatically, exactly like Temple Run's auto-turns;
you still only run, jump, duck, punch and change lanes.

- **Scoped to Primeval Valley and Ancient Rome only**, by design — Present
  Day and Neon Future are untouched and still run dead straight and flat.
- **Gets wilder the deeper into a level you get.** Both the turns and the
  hills start gentle near the beginning of a run and grow sharper, taller,
  and more chaotic (a second, faster wave layers in on top of the first)
  the closer you get to the finish line — increasing difficulty and chaos
  over the course of a single run, not just across eras.
- It's a **purely cosmetic layer** on top of the existing straight,
  lane-based simulation (see the `AUTO-TERRAIN` comment block above
  `terrainActive()` in `game.js`): collision is still decided by lane index
  plus a distance window, exactly as before, so bending the track sideways
  or rolling it vertically can never desync a hit, a jump, or a pickup — it
  only changes where things are *drawn*. The ground plane, the character,
  the camera, obstacles, roadside scenery and pickups all pick up the same
  `curveOffset()`/`hillOffset()` for their own position along the track, so
  everything bends and rolls together.

## The character creator

The first screen on `/play` lets you pick a hairstyle + color, a hat + color
(including a spinning propeller cap), and a shirt color. **Random** rolls
everything at once; **Standard** resets to the default look — both exist so
people can get through this screen in one tap if they don't care to fuss
with it. The choice is sent to the TV once you pair and shows up on your 3D
character immediately (`public/tv/game.js` → `dressPlayer()`); it's not
saved anywhere, so it resets each time you reopen `/play`.

## Camera mode vs. hold-phone mode

**Camera mode** (default, recommended): prop the phone up somewhere stable,
step back so your whole body is in frame, and your body is tracked in the
browser using TensorFlow.js + MoveNet (loaded from a CDN — see *Tuning the
motion detection* for the exact gesture math). Nobody touches the phone
while playing. **Hold-phone mode** is the original accelerometer-based
control scheme — hold the phone and lean/hop/jab it. Switch between them
any time from the tabs at the top of the play screen; the on-screen
Jump/Punch buttons and tap-left/tap-right zones work in either mode.

## The guided setup screen

Choosing **hold-phone mode** goes straight into the per-move walkthrough
described below, since the player keeps the phone in hand the whole time.
Choosing **camera mode** first walks through two extra stages — driven from
the couch with the **Fire TV remote**, not the phone — because the player
needs to physically prop the phone up and walk back to their play space
before pose detection should react to anything, and reacting to that
walk-away (or to the phone being fumbled with) as if it were a real jump or
lane change was exactly the bug this setup exists to fix:

1. **Place your phone** — the TV shows "place your phone under the TV,
   screen facing you, then step back." Pressing **OK on the remote**
   confirms it's in place. Nothing is being detected yet at this point —
   camera and pose model are loading in the background, but gesture
   detection stays fully off.
2. **Get in frame** — the TV shows a silhouette outline and a live status
   ("Step into frame" / "Move back a little" / "Move a bit closer" / "Move
   to the center" / "Perfect! Hold still…") driven by the phone's pose
   detection reporting how well-framed the player is — enough of them
   visible, at a sensible distance, roughly centered. Once that holds for
   about a second the TV moves on automatically; **OK on the remote** also
   confirms/skips it early at any point, in case the auto-check is being
   fussy. Detection is still off — this stage only checks *whether* the
   player can be seen well, not looking at what they're doing.
3. **Per-move calibration** — same as before: one move at a time (step/lean
   left, step/lean right, jump, punch) shown as a big icon + label with a
   progress dot row on the TV. This is the point gesture detection actually
   turns on. The phone runs the exact same gesture detection as real
   gameplay, but routes each detected gesture to the TV as calibration
   progress instead of as real game input — otherwise a practice jump would
   prematurely start the run, since the TV starts the game on its first
   real jump/punch input.

Throughout all of this the phone screen itself just shows a short "look at
your TV" hint plus a **Recenter** button (if detection seems off-center),
**Skip setup**, and **Start Run** — neither button is gated on finishing
every stage, skipping straight to real play is always fine as a manual
fallback if the remote isn't behaving as expected on your specific Fire TV
model (see the caveat in *What's been tested* below).

**How the remote reaches the phone:** the TV relays "OK" presses back to
the phone over the same WebSocket connection as a `calibration_control`
message (`placement_ack` / `moves_ack`), and the phone's `evaluateFraming()`
(in `controller.js`) reports framing status back up as `calibration`
`framing` events — see the big comment blocks in both `tv/game.js`'s camera
setup section and `play/controller.js`'s header for the full message
choreography.

## Tuning the motion detection

Both `public/play/controller.js` detection paths have their thresholds as
plain constants at the top of the file — **none of them were tuned against
a real phone, camera, or person**, since this build environment has neither
a phone, a camera, nor a body attached to it. They're reasoned starting
points, deliberately loosened (biased toward triggering too easily rather
than not at all, since this is a fun family game, not a precision
instrument); the calibration screen exists specifically so you can see what
still needs adjusting before you actually play. Expect to nudge things
after trying it for real:

**Camera / pose-tracking mode:**
- `LANE_ENTER_FRAC` / `LANE_EXIT_FRAC` — lane control is absolute zone
  tracking, not a step-and-return toggle: `LANE_ENTER_FRAC` is how far (as
  a fraction of frame width) your hips need to move off-center to enter the
  left/right zone, and `LANE_EXIT_FRAC` (kept smaller, so a normal stance
  reliably re-centers you) is how far back you need to come to leave it.
  See `computeZone()`.
- `JUMP_TRIGGER_TORSO_FRAC` — how much your hips need to rise (relative to
  your torso height, so it scales with distance from the camera) to count
  as a jump.
- `PUNCH_EXTENSION_FRAC` / `PUNCH_VELOCITY_TORSO_FRAC` — how extended and
  how fast a wrist movement needs to be to count as a punch.
- If left/right feels backwards on your setup, negate `dx` where it's
  passed into `computeZone()` in `processPose()` — see the comment right
  above it explaining the (unmirrored raw camera frame) sign convention it
  assumes.
- `FRAMING_TOO_CLOSE_FRAC` / `FRAMING_TOO_FAR_FRAC` — the "get in frame"
  check's too-close/too-far thresholds, as torso height (shoulder-to-hip
  distance) relative to the frame height. `FRAMING_OFFCENTER_FRAC` is the
  same idea horizontally. `FRAMING_GOOD_HOLD_MS` is how long "good" framing
  has to be held before the TV auto-advances — see `evaluateFraming()`.

**Hold-phone / accelerometer mode:**
- `TILT_ENTER_DEG` / `TILT_EXIT_DEG` — same absolute-zone idea as the
  camera mode's `LANE_ENTER_FRAC`/`LANE_EXIT_FRAC`, in degrees of tilt from
  the calibrated baseline.
- `MOTION_JUMP_TRIGGER` / `MOTION_PUNCH_TRIGGER` / `MOTION_ROTATION_LOW` —
  acceleration/rotation thresholds distinguishing a hop from a jab.

**Either mode:** the **Recenter** button re-zeroes whichever baseline the
current mode uses (and resets its lane zone to center). The on-screen
**Jump**/**Punch** buttons and tap-left/tap-right zones always work,
independent of detection, so you always have a reliable way to play or to
test the WebSocket relay in isolation.

## Why no `express`/`ws` package

This build environment's npm registry access is blocked, so installing
normal dependencies wasn't possible here. Rather than leave the project in a
broken, uninstallable state, `server.js` and `lib/ws-lite.js` implement
static file serving and the WebSocket protocol (RFC 6455) using only Node's
built-in `https`/`fs`/`crypto` modules. It's deliberately minimal (single-
frame-friendly parsing, no compression/extensions) but is protocol-correct
for what this project needs, and was verified end-to-end (see below).

**If you have normal npm access wherever you continue this project**,
swapping in `express` + `ws` is a reasonable cleanup — the message protocol
(`register` / `room` / `paired` / `input` / `character` / `calibration` /
`calibration_control` / `error` / `controller_connected` / `feedback`) would
carry over unchanged; only `server.js`'s plumbing would need to change.
`calibration_control` is the one message type that flows TV → phone (Fire TV
remote OK presses during setup); everything else flows phone → TV. The
TensorFlow.js/pose-detection
libraries used by camera mode are loaded from a CDN in the browser directly
(see the `TFJS_URL`/`POSE_DETECTION_URL` constants in `controller.js`), so
they're unaffected by the sandbox's npm restriction either way.

## What's been tested

Since this prototype was built in a sandboxed environment with no browser,
GPU, camera, or phone attached, verification was necessarily limited to
what could be checked headlessly:

- ✅ All JS files pass syntax checks, and every DOM id referenced from
  `controller.js` was cross-checked against `public/play/index.html`.
- ✅ The HTTPS static server (self-signed cert) correctly serves `/tv`,
  `/play`, and their assets, with a working 404 for unknown paths.
- ✅ The WebSocket relay was exercised end-to-end over TLS with a scripted
  client, covering room pairing, `input` events, and `character` events all
  being correctly relayed controller → server → TV.
- ✅ The full placement → framing → per-move-calibration flow (including
  the new `calibration_control` TV→phone relay and the TV's remote-Enter
  keydown handling) was exercised end-to-end with a scripted fake phone
  client and a real (headless) TV page: placement/framing panels show and
  hide correctly, framing status text updates per status, sustained
  "good + ready" framing auto-advances after the hold time, a remote OK
  press both confirms placement and manually skips the framing wait, the
  per-move steps and "done" still work exactly as before, and the whole run
  produced zero browser console errors.
- ⬜ **Not tested:** actual 3D rendering/game feel in a real browser; the
  camera pose-detection, accelerometer, and get-in-frame thresholds on a
  real device (the too-close/too-far/off-center fractions in *Tuning the
  motion detection* are reasoned starting points, not measured); the
  TensorFlow.js CDN URLs resolving (this sandbox's network policy blocks
  the CDN hosts it would need to check them, though they're well-
  established, long-published packages); and **whether your specific Fire
  TV model's remote actually sends an `Enter` keydown for its OK/Select
  button** to a plain fullscreen web page — the placement/framing stages'
  `isSelectPress()` check in `tv/game.js` also accepts Space/NumpadEnter as
  fallbacks, but if none of those fire on your remote, use **Skip setup**
  on the phone as the manual way through. These are the things to check
  first when you pick this up — see *Tuning the motion detection* above,
  and just play it.

## Project layout

```
motion-run/
├── server.js                   # HTTPS + WebSocket relay server (no dependencies)
├── certs/                      # generated on first run, gitignored, never committed
│   ├── server.key               # self-signed TLS key (see "Why HTTPS")
│   └── server.cert               # self-signed TLS cert, SAN = current LAN IP
├── lib/
│   ├── ws-lite.js                # minimal hand-rolled WebSocket server (RFC 6455)
│   ├── qrcode-lite.js            # minimal QR encoder for the TV's join code
│   └── selfsigned-lite.js        # X.509 self-signed cert generator (no openssl)
├── package.json
└── public/
    ├── tv/
    │   ├── index.html            # TV screen: HUD, pairing/era-picker/game-over panels
    │   ├── game.js                 # Three.js 3D runner — game loop, ERAS table, obstacles, player
    │   ├── art/                    # era card art + key art, cut down from the source artwork
    │   ├── audio/                  # music loops + effects (MP3; sources were 41MB of WAV)
    │   ├── audio.js                # music/effects engine — Web Audio for SFX, <audio> for music
    │   ├── glb-lite.js             # ~100-line GLB loader (see its header for why not GLTFLoader)
    │   ├── models/                 # the low-poly GLB asset pack
    │   └── icons/                  # app icons (PWA install / Fire TV package)
    └── play/
        ├── index.html            # phone controller UI (character/join/perm/calibration/play)
        └── controller.js           # character creator, camera pose tracking, accelerometer mode
```

## Natural next steps

- Playtest on a real Fire TV browser + phone and retune the detection
  thresholds (see above) — this is the big one.
- Package the TV page as an actual Fire TV app (a WebView-wrapped APK, or
  using Amazon's web-app packaging tools) so it can launch from the Fire TV
  home screen instead of needing a sideloaded browser.
- Add more obstacle variety and power-ups.
- Bring auto-terrain (turns/hills/dips) to Present Day and Neon Future too,
  now that Primeval Valley and Ancient Rome have proven the approach.
- Let multiplayer turns be simultaneous (everyone racing at once, split-
  screen or ghost runners) instead of one-at-a-time, if a group wants a
  faster round than a full turn order.
- Add a simple on-screen countdown ("3, 2, 1, GO!") between pairing and the
  run actually starting, and post-run stats (best combo, longest streak).
- More hair/hat styles, and a matching 3D preview on the character screen
  instead of the current simplified CSS avatar.
- Consider swapping the hand-rolled WebSocket server for `ws`/`socket.io`
  once you have normal npm access, for robustness (reconnection, binary
  frames, compression).
