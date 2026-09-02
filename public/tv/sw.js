// Minimal service worker - exists mainly so this page qualifies as an
// installable PWA (Chrome/PWABuilder's installability checks require one
// registered with a fetch handler). Deliberately network-first with no
// real offline caching: this game needs a live WebSocket connection to the
// relay server to do anything useful, so there's no meaningful "offline
// mode" to build here, and network-first avoids ever serving a stale
// game.js/index.html after a deploy.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
