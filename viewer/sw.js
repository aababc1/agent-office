/* Agent Office service worker.
   App shell: cache-first (updates in the background). Data files: network-first with the
   cached copy as fallback, so the last known office appears instantly even offline. */
const SHELL = 'office-shell-v1';
const DATA = 'office-data-v1';
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![SHELL, DATA].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isData = /\/data\/.*\.(json|jsonl)$/.test(url.pathname);
  if (isData) {
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(DATA).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || new Response('', {status: 504}))));
  } else {
    e.respondWith(caches.match(e.request).then(cached => { const net = fetch(e.request).then(r => { caches.open(SHELL).then(c => c.put(e.request, r.clone())); return r; }).catch(() => cached);
      return cached || net; }));
  }
});
