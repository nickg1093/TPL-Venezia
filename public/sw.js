// SERVICE WORKER — rende l'app installabile e veloce da riaprire.
//  - pagina (navigazioni): prima la rete (così gli aggiornamenti arrivano subito), se offline l'ultima copia salvata
//  - icone e manifest: dalla cache
//  - Leaflet (unpkg): dalla cache, aggiornata in background
//  - /api/* e mattonelle della mappa: MAI intercettati (dati live sempre freschi; le mattonelle le gestisce il browser)
// Per forzare l'aggiornamento della cache dopo modifiche ai file della shell: incrementare VERSION.
const VERSION = 'v1';
const CACHE = `tpl-venezia-${VERSION}`;
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-48.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('tpl-venezia-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;          // dati live: sempre dalla rete
    if (req.mode === 'navigate') {
      e.respondWith(fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(ca => ca.put('/', c)); } return r; })
        .catch(() => caches.match('/').then(r => r || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))));
      return;
    }
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(req, c)); } return r; })));
    return;
  }
  if (url.hostname === 'unpkg.com') {                                                       // libreria della mappa: cache + aggiornamento in background
    e.respondWith(caches.open(CACHE).then(ca => ca.match(req).then(hit => {
      const net = fetch(req).then(r => { if (r.ok) ca.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })));
  }
});
