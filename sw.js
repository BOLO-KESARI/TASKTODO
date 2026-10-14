// taskctl service worker: lets the app shell open offline.
// It only touches page navigations. /api/tasks (sync) and everything else go straight to the network.
const CACHE = 'taskctl-shell-v1';

self.addEventListener('install', e => {
  e.waitUntil(
    fetch('/', { cache: 'reload' })
      .then(res => res.ok && caches.open(CACHE).then(c => c.put('/', res)))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || req.mode !== 'navigate') return;
  // Network first, so you always get the newest deploy; fall back to the saved copy when offline.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); }
        return res;
      })
      .catch(() => caches.match('/').then(r => r || Response.error()))
  );
});
