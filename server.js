// Motion Run — relay server (zero external dependencies)
//
// Serves two web pages:
//   /tv    — the big-screen 3D runner game (open this on the Fire TV browser)
//   /play  — the phone controller (open this on your phone's browser)
//
// The TV page requests a 6-digit room code. The phone page joins that room
// code. From then on, every input event the phone detects (lane change,
// jump, punch) is relayed over WebSocket straight to that TV's game loop.
// The guided camera-setup flow (place phone -> get in frame -> per-move
// calibration) runs in both directions: the phone reports its own progress
// to the TV ('calibration' messages), and the TV relays Fire TV remote "OK"
// presses back to the phone ('calibration_control' messages) so setup can
// be driven from the couch once the phone's been propped up and walked
// away from — see tv/game.js and play/controller.js for the details.
//
// This build uses only Node's built-in `https`/`fs` modules plus the tiny
// hand-rolled WebSocket server in lib/ws-lite.js — see that file's header
// comment for why (no npm registry access in the build sandbox). If you
// have normal npm access when you pick this project back up, feel free to
// swap in `express` + `ws` for a more battle-tested implementation.
//
// WHY HTTPS: the /play controller's camera-based pose tracking uses
// getUserMedia(), which every mobile browser refuses to grant on a plain
// http:// origin (except localhost) — camera/mic access requires a
// "secure context". There's no real certificate authority for a private
// LAN IP, so certs/ has a self-signed cert covering this project's
// current LAN IP (see README for how to regenerate it if that IP
// changes). Your phone and TV browsers will show a one-time "connection
// isn't private" warning the first time they load the site — that's
// expected for a self-signed cert; tap through it (Advanced -> Proceed).
//
// Run with:  node server.js   (no install step needed)
// Then, on your TV and phone (same WiFi network), open:
//   https://<this-computer's-LAN-IP>:3000/tv
//   https://<this-computer's-LAN-IP>:3000/play

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WSServer } = require('./lib/ws-lite');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');

// When this runs on Render (or any host that terminates TLS for us and
// hands us plain HTTP on the injected PORT), we must NOT also try to
// speak TLS ourselves — Render sets RENDER=true on every instance, so we
// use that as the signal. Locally on your LAN, RENDER is unset, so we
// fall back to the self-signed-HTTPS mode (see the big comment above)
// which is what getUserMedia() needs for camera access on a plain LAN IP.
// A cloud deploy gets a real certificate for free from Render's own
// *.onrender.com domain, so no local cert juggling is needed there.
const ON_RENDER = !!process.env.RENDER;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/tv/';

  // Directory-style routes (e.g. "/tv", "/play") MUST redirect to add the
  // trailing slash rather than silently serving index.html at the
  // slash-less URL — otherwise the browser resolves the page's *own*
  // relative script/asset URLs (e.g. "./game.js") against the wrong base
  // and everything 404s. (Content-Location/other subtleties aside, an
  // explicit redirect is the simple, correct fix.)
  if (!urlPath.endsWith('/') && !path.extname(urlPath)) {
    res.writeHead(302, { Location: urlPath + '/' });
    res.end();
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  // Prevent path traversal outside PUBLIC_DIR.
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

let server;
if (ON_RENDER) {
  // Render terminates TLS for us and proxies plain HTTP to this process —
  // speaking HTTPS here ourselves would just break the connection.
  server = http.createServer(serveStatic);
} else {
  let tlsOptions;
  try {
    tlsOptions = {
      key: fs.readFileSync(path.join(CERT_DIR, 'server.key')),
      cert: fs.readFileSync(path.join(CERT_DIR, 'server.cert')),
    };
  } catch (err) {
    console.error('Could not read certs/server.key and certs/server.cert.');
    console.error('See README.md — "Regenerating the HTTPS certificate" — to create them.');
    process.exit(1);
  }
  server = https.createServer(tlsOptions, serveStatic);
}
const wss = new WSServer({ server });

/** @type {Map<string, {tv: import('./lib/ws-lite').WSConnection|null, controllers: Set<import('./lib/ws-lite').WSConnection>}>} */
const rooms = new Map();

// 6 digits once this is reachable from the open internet (Render deploy) —
// a 4-digit code is fine on a private LAN but too easy to stumble into by
// guessing once the server has a public URL. Same code path locally too,
// no harm in the extra two digits there.
function makeRoomCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.constructor.OPEN) ws.send(JSON.stringify(obj));
}

function roomFor(code) {
  if (!rooms.has(code)) rooms.set(code, { tv: null, controllers: new Set() });
  return rooms.get(code);
}

function cleanupEmptyRoom(code) {
  const room = rooms.get(code);
  if (room && !room.tv && room.controllers.size === 0) rooms.delete(code);
}

wss.on('connection', (ws) => {
  ws.role = null;
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }

    if (msg.type === 'register') {
      if (msg.role === 'tv') {
        const code = makeRoomCode();
        ws.role = 'tv';
        ws.roomCode = code;
        roomFor(code).tv = ws;
        send(ws, { type: 'room', code });
      } else if (msg.role === 'controller') {
        const code = String(msg.code || '').trim();
        const room = rooms.get(code);
        if (!room || !room.tv) {
          send(ws, { type: 'error', message: 'Room not found. Check the code on the TV screen.' });
          return;
        }
        ws.role = 'controller';
        ws.roomCode = code;
        room.controllers.add(ws);
        send(ws, { type: 'paired', code });
        send(room.tv, { type: 'controller_connected', count: room.controllers.size });
      }
      return;
    }

    // Motion/input events from a controller are relayed straight to its TV.
    if (msg.type === 'input' && ws.role === 'controller' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room && room.tv) send(room.tv, msg);
      return;
    }

    // Character customization (hair/hat/shirt) picked on the controller,
    // relayed to the TV so it can dress the player model.
    if (msg.type === 'character' && ws.role === 'controller' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room && room.tv) send(room.tv, msg);
      return;
    }

    // Guided-calibration progress (start / step / done) — the phone owns
    // the camera/motion sensors and detects each move, but the walkthrough
    // itself is displayed on the TV, so every event gets relayed there.
    if (msg.type === 'calibration' && ws.role === 'controller' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room && room.tv) send(room.tv, msg);
      return;
    }

    // Optional: TV -> controller feedback (e.g. game-over, buzz cue).
    if (msg.type === 'feedback' && ws.role === 'tv' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) room.controllers.forEach((c) => send(c, msg));
      return;
    }

    // TV -> controller setup control (Fire TV remote "OK" presses that
    // advance the guided camera-setup flow — see the big comment block at
    // the top of tv/game.js's calibration section for the full picture).
    if (msg.type === 'calibration_control' && ws.role === 'tv' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) room.controllers.forEach((c) => send(c, msg));
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (ws.role === 'tv' && room.tv === ws) {
      room.tv = null;
      room.controllers.forEach((c) => send(c, { type: 'error', message: 'TV disconnected.' }));
    } else if (ws.role === 'controller') {
      room.controllers.delete(ws);
      if (room.tv) send(room.tv, { type: 'controller_connected', count: room.controllers.size });
    }
    cleanupEmptyRoom(ws.roomCode);
  });
});

server.listen(PORT, () => {
  if (ON_RENDER) {
    console.log(`Motion Run server listening on plain HTTP :${PORT} (Render terminates TLS)`);
    console.log('  Open the Render-assigned https://...onrender.com URL, then /tv and /play.');
  } else {
    console.log(`Motion Run server listening on https://0.0.0.0:${PORT}`);
    console.log(`  TV screen:        https://<your-LAN-ip>:${PORT}/tv`);
    console.log(`  Phone controller: https://<your-LAN-ip>:${PORT}/play`);
    console.log('  (self-signed cert — your browser will warn once; tap through it)');
  }
});
