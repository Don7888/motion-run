# Motion Run

A "Danny Go"–style movement game: a 3D runner plays on your TV (Fire TV / any
browser), and your phone is the controller. Two control styles are built
in — camera-based body tracking (prop the phone up and just move) or
hold-the-phone motion sensing — either way: step/lean left or right to
change lanes, hop to jump over hurdles, and throw a punch to smash crates.

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

You'll see:

```
Motion Run server listening on https://0.0.0.0:3000
  TV screen:        https://<your-LAN-ip>:3000/tv
  Phone controller: https://<your-LAN-ip>:3000/play
```

Find your computer's LAN IP (e.g. `192.168.1.42`) — on Mac/Linux,
`ipconfig getifaddr en0` or `hostname -I`; on Windows, `ipconfig`.

1. On the Fire TV's browser (Silk Browser, or the **Downloader** app, which
   has an easier remote-friendly keyboard for typing URLs — the built-in Fire
   TV launcher doesn't browse the web, so you'll need a browser app
   installed), open `https://<your-LAN-ip>:3000/tv`. You'll hit a "connection
   isn't private" warning — that's expected, see *Why HTTPS* below; tap
   **Advanced → Proceed**. A 6-digit room code appears.
2. On your phone (same WiFi network), open `https://<your-LAN-ip>:3000/play`
   in a normal browser (Safari on iOS, Chrome on Android), same one-time
   security warning click-through.
3. **Create your character** — pick hair, a hat, and a shirt color, or tap
   **Random**/**Standard** to skip quickly.
4. Enter the room code and tap **Connect to TV**.
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
   `certs/` shouldn't be committed at all, see below), and create it.
3. On the new repo's page, click **uploading an existing file** and drag in
   every file/folder from this project *except* `certs/` — `server.js`,
   `package.json`, `lib/`, `public/`, `README.md`. Commit the upload.
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
for a private LAN IP, so `certs/` holds a **self-signed certificate**
covering this project's current LAN IP. Every browser (laptop, Fire TV,
phone) will show a one-time "connection isn't private" warning the first
time it loads the site — tap **Advanced → Proceed**, it only happens once
per browser.

### Regenerating the certificate

The cert is only valid for the LAN IP it was generated with. If your
computer's IP changes (new router, DHCP renewal, different network), camera
mode will stop working until you regenerate it:

```bash
cd certs
openssl req -x509 -newkey rsa:2048 -keyout server.key -out server.cert -days 730 -nodes \
  -subj "/CN=motion-run.local" \
  -addext "subjectAltName=IP:<your-new-LAN-ip>,IP:127.0.0.1,DNS:localhost"
```

(Windows doesn't ship `openssl` by default — Git for Windows bundles one, or
ask whichever Claude session you're working with to regenerate it for you
and place the files, same as the first time.)

## Gameplay

- **3 lanes.** Lane control is absolute, not a step-and-return toggle: the
  game continuously tracks which of 3 zones (left/center/right) your body
  is currently in and puts your character there. Step or lean past a
  threshold to enter the left/right zone, and just standing/holding
  normally again snaps you straight back to the center lane — no
  exaggerated "return" gesture needed.
- **Hurdles** (low orange bars) — jump (hop) to clear them.
- **Crates** (brown boxes) — punch to smash them.
- **Walls** (grey barriers) — too tall to jump, too tough to punch; the only
  way past is to be in a different lane already.
- Getting hit costs a heart (3 total); a short invulnerability window follows
  each hit. Score climbs with distance and successful hurdle/crate clears;
  speed ramps up gradually. Lose all hearts and it's game over — jump or
  punch again to restart.

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

## The guided calibration screen

After choosing a mode, a short "quick setup" walkthrough appears **on the
TV** — one move at a time (step/lean left, step/lean right, jump, punch),
shown as a big icon + label with a progress dot row. The phone (which owns
the camera/motion sensors) runs the exact same gesture detection as real
gameplay, but routes each detected gesture to the TV as calibration
progress instead of as real game input — otherwise a practice jump would
prematurely start the run, since the TV starts the game on its first real
jump/punch input. The phone screen itself just shows "Look at your TV" plus
a **Recenter** button (if detection seems off-center), **Skip setup**, and
**Start Run** — it's not gated on finishing all four moves, skipping is
always fine. This split exists because it's a lot easier to follow a
walkthrough on the big screen you're already facing than on the phone
you're not looking at while moving.

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
`error` / `controller_connected` / `feedback`) would carry over unchanged; only
`server.js`'s plumbing would need to change. The TensorFlow.js/pose-detection
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
- ⬜ **Not tested:** actual 3D rendering/game feel in a real browser; the
  camera pose-detection and accelerometer gesture thresholds on a real
  device; the TensorFlow.js CDN URLs resolving (this sandbox's network
  policy blocks the CDN hosts it would need to check them, though they're
  well-established, long-published packages). These are the things to check
  first when you pick this up — see *Tuning the motion detection* above,
  and just play it.

## Project layout

```
motion-run/
├── server.js                   # HTTPS + WebSocket relay server (no dependencies)
├── certs/
│   ├── server.key               # self-signed TLS key (see "Why HTTPS")
│   └── server.cert               # self-signed TLS cert, SAN = current LAN IP
├── lib/
│   └── ws-lite.js                # minimal hand-rolled WebSocket server (RFC 6455)
├── package.json
└── public/
    ├── tv/
    │   ├── index.html            # TV screen: HUD, pairing/ready/game-over panels
    │   └── game.js                 # Three.js 3D runner — game loop, obstacles, player, hair/hats
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
- Add more obstacle variety, power-ups, multiple levels/environments, and
  music/SFX.
- Add a simple on-screen countdown ("3, 2, 1, GO!") between pairing and the
  run actually starting, and post-run stats (best combo, longest streak).
- More hair/hat styles, and a matching 3D preview on the character screen
  instead of the current simplified CSS avatar.
- Consider swapping the hand-rolled WebSocket server for `ws`/`socket.io`
  once you have normal npm access, for robustness (reconnection, binary
  frames, compression).
