// SERVICE WORKER — rende l'app installabile e veloce da riaprire.
//  - pagina, script e fogli di stile (/, /js, /css): prima la rete (gli aggiornamenti arrivano subito), se offline l'ultima copia salvata
//  - icone, manifest e Leaflet (/icons, /vendor): dalla cache, aggiornati in background
//  - /api/*, /healthz e mattonelle della mappa: MAI intercettati (dati live sempre freschi; le mattonelle le gestisce il browser)
// Dopo modifiche ai file della shell (icone, manifest, elenco SHELL) incrementare VERSION: la cache vecchia viene cancellata.
const VERSION = 'v7';
const CACHE = `tpl-venezia-${VERSION}`;
const SHELL = ['/', '/css/app.css', '/js/app.js', '/js/util.js', '/js/zones.js', '/js/tide.js', '/js/avvisi.js', '/js/pwa.js', '/js/theme-init.js', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
  '/icons/sprite.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-48.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('tpl-venezia-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const store = (req, r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(req, c)); } return r; };
const offline = () => new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;                       // tutto il resto (mattonelle comprese) va direttamente alla rete
  const p = url.pathname;
  if (p.startsWith('/api/') || p === '/healthz') return;                                    // dati live: sempre dalla rete
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => store('/', r)).catch(() => caches.match('/').then(r => r || offline())));
  } else if (p.startsWith('/js/') || p.startsWith('/css/')) {                               // codice dell'app: rete prima
    e.respondWith(fetch(req).then(r => store(req, r)).catch(() => caches.match(req).then(r => r || offline())));
  } else {                                                                                  // icone, manifest, Leaflet: cache e aggiornamento in background
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(r => store(req, r)).catch(() => hit || offline());
      return hit || net;
    }));
  }
});
