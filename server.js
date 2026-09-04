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
// LAN IP, so this server signs its own on first run — covering whatever
// LAN address this machine currently has — and regenerates it by itself
// if that address later changes (see lib/selfsigned-lite.js). Your phone
// and TV browsers will show a one-time "connection isn't private"
// warning the first time they load the site — that's expected for a
// self-signed cert; tap through it (Advanced -> Proceed).
//
// Run with:  node server.js   (no install step needed)
// It prints the exact https:// URL to open on your TV, so you don't have
// to go looking up this machine's LAN IP yourself.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WSServer } = require('./lib/ws-lite');
const qrcodeLite = require('./lib/qrcode-lite');
const selfsigned = require('./lib/selfsigned-lite');

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
    // No Cache-Control/ETag/Last-Modified was ever set here, which leaves
    // every browser (and, worse, the Fire TV APK's Chrome Custom Tab —
    // TWAs are known to cache more aggressively than a normal tab) free to
    // reuse its own cached copy of index.html/game.js/controller.js
    // indefinitely using default heuristics. That's a real, previously
    // unexamined explanation for why verified-deployed fixes could still
    // "not show up" on a real device: the origin has the new bytes, but
    // the device never re-requests them. Force revalidation on every load
    // for the files that actually change (html/js/css) — this project is
    // tiny, so the extra round-trip cost is negligible next to the risk of
    // silently stale gameplay code. Static, rarely-changing assets
    // (icons/images) keep a normal short cache since staleness there is
    // harmless.
    const NO_CACHE_EXTS = new Set(['.html', '.js', '.css', '.json']);
    const cacheControl = NO_CACHE_EXTS.has(ext)
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
    });
    res.end(data);
  });
}

// 2026-09-03 "scan a code on the TV to join automatically" feature: the TV
// shows a QR code (generated server-side by lib/qrcode-lite.js — see that
// file's header for why it's hand-rolled) encoding this server's own
// /play?code=<room> URL, so a phone camera can jump straight to the join
// screen with the code already filled in instead of the player typing 6
// digits by hand. Needs this server's own origin, which depends on how it's
// reached: Render terminates TLS and proxies to us over plain HTTP, setting
// x-forwarded-proto/x-forwarded-host; running locally we ARE the TLS
// endpoint (see the ON_RENDER branch below), so req.socket.encrypted is the
// right signal there instead.
function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

const QR_ROUTE_RE = /^\/qr\/(\d{6})\.svg$/;

// Returns true if it fully handled the request (a matching /qr/<code>.svg
// route), false if the caller should fall through to serveStatic.
function maybeServeQr(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const m = QR_ROUTE_RE.exec(urlPath);
  if (!m) return false;
  const code = m[1];
  const joinUrl = `${requestOrigin(req)}/play?code=${code}`;
  let svg;
  try {
    svg = qrcodeLite.toSVG(joinUrl);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Could not generate QR code');
    return true;
  }
  // The join URL (and so the QR pixels) is fully determined by the 6-digit
  // code in the path, so this response can be cached hard — a re-request
  // for the same code always produces byte-identical output.
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'public, max-age=86400, immutable',
  });
  res.end(svg);
  return true;
}

function requestHandler(req, res) {
  if (maybeServeQr(req, res)) return;
  serveStatic(req, res);
}

let server;
if (ON_RENDER) {
  // Render terminates TLS for us and proxies plain HTTP to this process —
  // speaking HTTPS here ourselves would just break the connection.
  server = http.createServer(requestHandler);
} else {
  // 2026-09-04: the certificate is generated here on first run rather than
  // by hand. It used to be a documented openssl command with your LAN IP
  // pasted in, which failed for two reasons: `certs/` is deliberately never
  // committed (it's per-machine and contains a private key), so a fresh
  // clone couldn't start LAN mode at all; and Windows has no openssl, so the
  // documented command doesn't even run there. lib/selfsigned-lite.js builds
  // the certificate in pure Node instead.
  //
  // An existing cert is REUSED whenever it still covers this machine's
  // current LAN address. That matters for more than speed: browsers remember
  // the security exception you clicked for one specific certificate, so
  // regenerating on every boot would mean clicking through the warning on
  // the TV and the phone every single time you played.
  const lanIps = selfsigned.lanAddresses();
  const certHosts = [...lanIps, '127.0.0.1', 'localhost'];
  const keyPath = path.join(CERT_DIR, 'server.key');
  const certPath = path.join(CERT_DIR, 'server.cert');
  let tlsOptions = null;
  try {
    const existing = {
      key: fs.readFileSync(keyPath, 'utf8'),
      cert: fs.readFileSync(certPath, 'utf8'),
    };
    if (selfsigned.certCovers(existing.cert, lanIps)) tlsOptions = existing;
    else console.log('Existing certificate does not cover this machine\'s current LAN address — regenerating.');
  } catch {
    // No cert yet; fall through and make one.
  }
  if (!tlsOptions) {
    console.log(`Generating a self-signed certificate for ${certHosts.join(', ')}…`);
    const made = selfsigned.generate(certHosts);
    fs.mkdirSync(CERT_DIR, { recursive: true });
    fs.writeFileSync(keyPath, made.key, { mode: 0o600 });
    fs.writeFileSync(certPath, made.cert);
    tlsOptions = { key: made.key, cert: made.cert };
    console.log(`Saved to certs/ (valid until ${made.notAfter.toISOString().slice(0, 10)}).`);
  }
  server = https.createServer(tlsOptions, requestHandler);
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
    const ips = selfsigned.lanAddresses();
    console.log('');
    console.log('  Motion Run is running on your network.');
    console.log('');
    if (ips.length === 0) {
      console.log('  No LAN address found — is this machine on WiFi/ethernet?');
      console.log(`  Local only:  https://localhost:${PORT}/tv`);
    } else {
      for (const ip of ips) {
        console.log(`  On the TV, open:   https://${ip}:${PORT}/tv`);
      }
      console.log('');
      console.log('  Then scan the QR code on the TV with your phone.');
    }
    console.log('');
    console.log('  Both devices will warn once that the connection isn\'t private —');
    console.log('  that\'s the self-signed certificate. Choose Advanced, then proceed.');
    console.log('');
  }
});
