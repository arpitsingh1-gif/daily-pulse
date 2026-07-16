// Daily Pulse service worker — shell cache-first, data network-first.
const VER = 'dp-v3';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'data/skills-bank.json', 'data/embed.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/data/data.json')) {
    // network-first: fresh data when online, cached data offline
    e.respondWith(
      fetch(e.request).then((r) => {
        const copy = r.clone();
        caches.open(VER).then((c) => c.put('data/data.json', copy));
        return r;
      }).catch(() => caches.match('data/data.json'))
    );
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
