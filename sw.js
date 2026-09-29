// Bump VERSION on every release. A changed sw.js is what makes phones detect an update.
const VERSION = '0.1.0';
const CACHE = 'suckmacock-' + VERSION;
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'data/league.json',
  'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  // No skipWaiting here: the new version waits until the user taps "Update".
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

// Network-first: fresh content when online, cached copy when offline.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('index.html')))
  );
});
