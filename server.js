// MotionQuest — relay server (zero external dependencies)
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

// --- Reconnect & session-lifetime tuning (2026-09-16 round) -----------------
// A phone's own network hiccup (elevator, wifi handoff, screen lock) or a TV
// browser blip should recover on its own without losing a player's slot or
// forcing anyone back through setup. A short per-connection grace period
// keeps a disconnected side's identity reserved for a little while, so a
// reconnecting socket can reclaim exactly who it was rather than looking like
// a brand-new join. This is separate from a room simply going stale: a TV
// left sitting on the pairing screen for a long time is an expired session,
// not a blip, and is swept away outright so a fresh code is always waiting.
// MQ_TEST_TIMERS shrinks all of the above to a few seconds so the Playwright
// suite can actually exercise grace-window and idle-expiry behavior without
// a real test taking 45 minutes. Never set in production — see README.md.
const TEST_TIMERS = !!process.env.MQ_TEST_TIMERS;
// 2026-09-16: the two reconnect grace windows need to stay comfortably
// longer than the CLIENT's own first-retry delay (game.js's
// TV_RECONNECT_DELAYS_MS / controller.js's RECONNECT_DELAYS_MS both start
// their backoff at a hardcoded 1000ms, unaffected by this flag — there's no
// client-side equivalent of MQ_TEST_TIMERS). In production the ratio is
// roughly 20-25:1 (a real blip's first retry lands nowhere near the grace
// window), so shrinking both grace windows to ~1000ms here reproduced a
// race that never happens for real: the room could mark a merely-blipped
// TV/phone as "left" before its very first, on-time reconnect attempt had
// even finished round-tripping. Keeping a similar multiple under test mode
// avoids that false expiry while still finishing in a couple of seconds.
const CONTROLLER_RECONNECT_GRACE_MS = TEST_TIMERS ? 2500 : 25000;
const TV_RECONNECT_GRACE_MS = TEST_TIMERS ? 2500 : 20000;
const ROOM_IDLE_EXPIRE_MS = TEST_TIMERS ? 4000 : 45 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = TEST_TIMERS ? 500 : 60 * 1000;

/**
 * @typedef {{
 *   tv: import('./lib/ws-lite').WSConnection|null,
 *   tvPendingTimer: NodeJS.Timeout|null,
 *   controllers: Set<import('./lib/ws-lite').WSConnection>,
 *   players: Map<number, {token: string|null, pendingRemoveTimer: NodeJS.Timeout|null}>,
 *   tokenToPlayer: Map<string, number>,
 *   lastActivity: number,
 * }} Room
 */
/** @type {Map<string, Room>} */
const rooms = new Map();

function touchActivity(room) {
  room.lastActivity = Date.now();
}

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
  if (!rooms.has(code)) {
    rooms.set(code, {
      tv: null,
      tvPendingTimer: null,
      controllers: new Set(),
      players: new Map(),
      tokenToPlayer: new Map(),
      lastActivity: Date.now(),
    });
  }
  return rooms.get(code);
}

// A room is only truly empty once nothing could still reclaim it: no live TV,
// no TV reconnect grace timer pending, no live phone, and no phone reconnect
// grace timer pending either. Each grace-timer callback calls this again once
// it fires, so a room that never gets reclaimed still cleans itself up —
// just after its grace window rather than the instant a socket drops.
function cleanupEmptyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.tv || room.tvPendingTimer) return;
  if (room.controllers.size > 0 || room.players.size > 0) return;
  rooms.delete(code);
}

// A session nobody has touched in a long time (TV left on the pairing screen
// overnight, say) is expired outright rather than left to rot — swept
// periodically rather than timed per-room, to keep this simple. Both sides
// are told plainly, while their sockets are still open, so neither is left
// guessing why the game vanished.
function expireRoom(code, room) {
  const msg = { type: 'session_expired', message: 'This session timed out from inactivity.' };
  if (room.tv) send(room.tv, msg);
  room.controllers.forEach((c) => send(c, msg));
  if (room.tvPendingTimer) clearTimeout(room.tvPendingTimer);
  for (const rec of room.players.values()) {
    if (rec.pendingRemoveTimer) clearTimeout(rec.pendingRemoveTimer);
  }
  rooms.delete(code);
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_IDLE_EXPIRE_MS) expireRoom(code, room);
  }
}, IDLE_SWEEP_INTERVAL_MS).unref();

// Multiplayer (2026-09-08): up to 4 phones can join one room, one per
// player. Each gets a stable 1-4 id — the lowest one not currently in
// use — assigned once at connect time and never renumbered while it's
// still connected, so the TV can track "whose turn is it" by id across a
// whole multiplayer game without the phones needing to agree on anything
// among themselves. A 5th join is turned away rather than silently
// bumping someone, since there's no fair way to pick who loses a slot.
const MAX_PLAYERS = 4;
// Uses room.players (identities, including anyone mid-reconnect-grace) rather
// than room.controllers (live sockets only) — a phone that just dropped and
// is still inside its grace window keeps its slot reserved, so a second
// device can't be handed the same id while the first might still come back.
function assignPlayerId(room) {
  for (let id = 1; id <= MAX_PLAYERS; id++) if (!room.players.has(id)) return id;
  return null;
}

// Tells the TV exactly who's connected, by id — the roster the multiplayer
// join/turn-order UI is built from (see renderRoster()/beginMultiplayerIfNeeded()
// in tv/game.js). Sent in addition to the older controller_connected count,
// which nothing else here needed to change.
function broadcastRoster(room) {
  if (!room.tv) return;
  const ids = Array.from(room.controllers, (c) => c.playerId).sort((a, b) => a - b);
  send(room.tv, { type: 'roster', ids });
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
        // A TV whose socket merely dropped (not a full page reload) can ask
        // to reclaim the exact code it already had, via rejoinCode — but
        // only while that room's TV slot is still actually free. This is
        // what lets a brief network blip resume silently on the SAME code
        // instead of stranding every already-paired phone. A rejoinCode that
        // can't be reclaimed (room gone, or someone/something else already
        // holds it) is not an error — it just falls through to a normal
        // fresh code, which is also exactly the behavior a genuinely expired
        // session should get.
        const rejoinCode = typeof msg.rejoinCode === 'string' ? msg.rejoinCode.trim() : null;
        let code = null;
        let rejoined = false;
        if (rejoinCode && rooms.has(rejoinCode) && !rooms.get(rejoinCode).tv) {
          const existing = rooms.get(rejoinCode);
          code = rejoinCode;
          rejoined = true;
          if (existing.tvPendingTimer) {
            clearTimeout(existing.tvPendingTimer);
            existing.tvPendingTimer = null;
          }
        }
        if (!code) code = makeRoomCode();
        ws.role = 'tv';
        ws.roomCode = code;
        const room = roomFor(code);
        room.tv = ws;
        touchActivity(room);
        send(ws, { type: 'room', code, rejoined });
        if (rejoined) {
          // Let every already-connected phone know the TV is back, and
          // resend the roster so nothing on either side looks stale.
          room.controllers.forEach((c) => send(c, { type: 'tv_status', status: 'connected' }));
          send(ws, { type: 'controller_connected', count: room.controllers.size });
          broadcastRoster(room);
        }
      } else if (msg.role === 'controller') {
        const code = String(msg.code || '').trim();
        const room = rooms.get(code);
        if (!room || !room.tv) {
          send(ws, { type: 'error', code: 'room_not_found', message: 'Room not found. Check the code on the TV screen.' });
          return;
        }
        touchActivity(room);

        // Reclaiming an existing slot requires presenting the exact private
        // token that was handed out for it when that slot was first taken —
        // the 6-digit room code (which anyone who scans the QR or is told
        // the digits has) is deliberately never enough on its own. That is
        // what makes a network blip recoverable without opening a hijack
        // path: a second real player who knows only the code, but not
        // another player's own token, always gets a brand-new slot below,
        // never someone else's identity or their finished calibration.
        const token = typeof msg.deviceToken === 'string' && msg.deviceToken.length >= 16 && msg.deviceToken.length <= 128
          ? msg.deviceToken
          : null;
        let playerId = null;
        let reconnected = false;
        if (token && room.tokenToPlayer.has(token)) {
          const claimedId = room.tokenToPlayer.get(token);
          const rec = room.players.get(claimedId);
          if (rec) {
            playerId = claimedId;
            reconnected = true;
            if (rec.pendingRemoveTimer) {
              clearTimeout(rec.pendingRemoveTimer);
              rec.pendingRemoveTimer = null;
            }
            // Only one live socket per player id — drop anything stale still
            // on file for it (e.g. an old tab that hasn't finished closing).
            for (const c of room.controllers) {
              if (c.playerId === playerId && c !== ws) {
                room.controllers.delete(c);
                try { c.close(); } catch { /* already gone */ }
              }
            }
          }
        }
        if (playerId === null) {
          playerId = assignPlayerId(room);
          if (playerId === null) {
            send(ws, { type: 'error', code: 'room_full', message: 'Room is full — up to 4 players can join.' });
            return;
          }
          room.players.set(playerId, { token, pendingRemoveTimer: null });
          if (token) room.tokenToPlayer.set(token, playerId);
        }

        ws.role = 'controller';
        ws.roomCode = code;
        ws.playerId = playerId;
        room.controllers.add(ws);
        send(ws, { type: 'paired', code, playerId, reconnected });
        send(room.tv, { type: 'controller_connected', count: room.controllers.size });
        send(room.tv, { type: 'controller_status', playerId, status: reconnected ? 'reconnected' : 'connected' });
        broadcastRoster(room);
      }
      return;
    }

    // Motion/input events from a controller are relayed straight to its TV.
    // Stamped with the sender's playerId so the TV can tell whose turn it
    // actually is in a multiplayer game — see the msg.playerId check in
    // tv/game.js's handleInput(). Harmless in solo play, where nothing reads it.
    if (msg.type === 'input' && ws.role === 'controller' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) touchActivity(room);
      if (room && room.tv) send(room.tv, { ...msg, playerId: ws.playerId });
      return;
    }

    // Character customization (hair/hat/shirt) picked on the controller,
    // relayed to the TV so it can dress the player model.
    if (msg.type === 'character' && ws.role === 'controller' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) touchActivity(room);
      if (room && room.tv) send(room.tv, { ...msg, playerId: ws.playerId });
      return;
    }

    // Guided-calibration progress (start / step / done) — the phone owns
    // the camera/motion sensors and detects each move, but the walkthrough
    // itself is displayed on the TV, so every event gets relayed there.
    if (msg.type === 'calibration' && ws.role === 'controller' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) touchActivity(room);
      if (room && room.tv) send(room.tv, { ...msg, playerId: ws.playerId });
      return;
    }

    // Optional: TV -> controller feedback (e.g. game-over, buzz cue).
    if (msg.type === 'feedback' && ws.role === 'tv' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) { touchActivity(room); room.controllers.forEach((c) => send(c, msg)); }
      return;
    }

    // TV -> controller setup control (Fire TV remote "OK" presses that
    // advance the guided camera-setup flow — see the big comment block at
    // the top of tv/game.js's calibration section for the full picture).
    if (msg.type === 'calibration_control' && ws.role === 'tv' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) { touchActivity(room); room.controllers.forEach((c) => send(c, msg)); }
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const code = ws.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    if (ws.role === 'tv' && room.tv === ws) {
      room.tv = null;
      // Softer than a flat "TV disconnected" — the phone is meant to keep
      // calm and retry on its own for a while before saying anything is
      // actually wrong. See tv_status handling in play/controller.js.
      room.controllers.forEach((c) => send(c, { type: 'tv_status', status: 'reconnecting' }));
      room.tvPendingTimer = setTimeout(() => {
        room.tvPendingTimer = null;
        room.controllers.forEach((c) => send(c, { type: 'tv_status', status: 'left' }));
        cleanupEmptyRoom(code);
      }, TV_RECONNECT_GRACE_MS);
    } else if (ws.role === 'controller') {
      room.controllers.delete(ws);
      if (room.tv) send(room.tv, { type: 'controller_connected', count: room.controllers.size });
      const playerId = ws.playerId;
      const rec = room.players.get(playerId);
      if (rec) {
        if (room.tv) send(room.tv, { type: 'controller_status', playerId, status: 'reconnecting' });
        rec.pendingRemoveTimer = setTimeout(() => {
          room.players.delete(playerId);
          if (rec.token) room.tokenToPlayer.delete(rec.token);
          if (room.tv) send(room.tv, { type: 'controller_status', playerId, status: 'left' });
          cleanupEmptyRoom(code);
        }, CONTROLLER_RECONNECT_GRACE_MS);
      }
      broadcastRoster(room);
    }
    cleanupEmptyRoom(code);
  });
});

server.listen(PORT, () => {
  if (ON_RENDER) {
    console.log(`MotionQuest server listening on plain HTTP :${PORT} (Render terminates TLS)`);
    console.log('  Open the Render-assigned https://...onrender.com URL, then /tv and /play.');
  } else {
    const ips = selfsigned.lanAddresses();
    console.log('');
    console.log('  MotionQuest is running on your network.');
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
