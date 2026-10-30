// SERVICE WORKER — rende l'app installabile e veloce da riaprire.
//  - pagina, script e fogli di stile (/, /js, /css): prima la rete (gli aggiornamenti arrivano subito), se offline l'ultima copia salvata
//  - icone, manifest e Leaflet (/icons, /vendor): dalla cache, aggiornati in background
//  - /api/*, /healthz e mattonelle della mappa: MAI intercettati (dati live sempre freschi; le mattonelle le gestisce il browser)
// Dopo modifiche ai file della shell (icone, manifest, elenco SHELL) incrementare VERSION: la cache vecchia viene cancellata.
const VERSION = 'v19';
const CACHE = `tpl-venezia-${VERSION}`;
const SHELL = ['/', '/css/app.css', '/js/app.js', '/js/util.js', '/js/zones.js', '/js/tide.js', '/js/avvisi.js', '/js/locate.js', '/js/fav.js', '/js/notify.js', '/js/pwa.js', '/js/theme-init.js', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
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

// ---- NOTIFICHE DI ARRIVO (Web Push) ----
// Il server manda un messaggio cifrato; qui diventa una notifica di sistema: suono, vibrazione, "non disturbare", schermata di blocco
// li decide il telefono secondo le impostazioni dell'utente. Stesso "tag" per la stessa corsa: la notifica nuova sostituisce la vecchia.
// Grafica come nell'app, senza emoji:  immagine = mattonella (bus/tram) o cerchio (battelli) della linea con i suoi colori;
// piccola icona della barra di stato (badge) = simbolo stilizzato del servizio, lo stesso disegno delle icone dell'app.
// App aperta e in primo piano: nessuna notifica di sistema, l'app mostra l'informazione al suo interno (linee guida Apple/Google).
const ICON = '/icons/icon-192.png';
const GLYPH = {   // tracciati di /icons/sprite.svg (i-bus, i-tram, i-ship), griglia 24x24
  bus: ['M7.5 3.5h9a3.5 3.5 0 0 1 3.5 3.5v7a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 14V7a3.5 3.5 0 0 1 3.5-3.5z', 'M4 11h16M8 21v-2.5M16 21v-2.5'],
  tram: ['M9 2.5h6M12 2.5V5', 'M8.2 5h7.6a3.2 3.2 0 0 1 3.2 3.2v6.1a3.2 3.2 0 0 1-3.2 3.2H8.2A3.2 3.2 0 0 1 5 14.3V8.2A3.2 3.2 0 0 1 8.2 5z', 'M5 11h14M8 21l1.4-3.5M16 21l-1.4-3.5'],
  ship: ['M3.5 15.5 5 20h14l1.5-4.5-8.5-2.8z', 'M7.5 12.4V8h9v4.4M12 8V4.5']
};
const glyphOf = m => (m.src === 'nav' ? 'ship' : /^T\d/i.test(m.line || '') ? 'tram' : 'bus');
async function toDataUrl(canvas) {
  const buf = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()); let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return 'data:image/png;base64,' + btoa(s);
}
async function lineIcon(m) {
  const st = m.style; if (typeof OffscreenCanvas === 'undefined' || !st || !m.line) return ICON;
  try {
    const S = 192, c = new OffscreenCanvas(S, S), x = c.getContext('2d'), txt = String(m.line).slice(0, 5);
    x.font = `800 ${txt.length <= 2 ? 84 : txt.length === 3 ? 68 : 54}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    x.lineWidth = 10; x.fillStyle = st.bg; x.strokeStyle = st.fg;
    if (st.shape === 'circle') { x.beginPath(); x.arc(S / 2, S / 2, 84, 0, Math.PI * 2); x.fill(); x.stroke(); }
    else { const w = Math.min(184, Math.max(150, x.measureText(txt).width + 64)), h = 128; x.beginPath(); x.roundRect((S - w) / 2, (S - h) / 2, w, h, 30); x.fill(); x.stroke(); }
    x.fillStyle = st.fg; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, S / 2, S / 2 + 4);
    return await toDataUrl(c);
  } catch { return ICON; }
}
async function badgeIcon(m) {
  if (typeof OffscreenCanvas === 'undefined' || typeof Path2D === 'undefined') return '/icons/favicon-48.png';
  try {
    const c = new OffscreenCanvas(96, 96), x = c.getContext('2d'); x.scale(4, 4);
    x.strokeStyle = '#fff'; x.lineWidth = 2.1; x.lineCap = 'round'; x.lineJoin = 'round';
    for (const d of GLYPH[glyphOf(m)]) x.stroke(new Path2D(d));
    return await toDataUrl(c);
  } catch { return '/icons/favicon-48.png'; }
}
async function show(m) {
  const [icon, badge] = await Promise.all([lineIcon(m), badgeIcon(m)]);
  return self.registration.showNotification(m.title || 'Venezia TPL live', {
    body: m.body || '', tag: m.tag || 'tpl', renotify: !m.silent, silent: !!m.silent, icon, badge, lang: 'it', dir: 'ltr',
    timestamp: m.ts || Date.now(), requireInteraction: m.kind === 'lead' || m.kind === 'arrive', vibrate: m.silent ? undefined : [140, 70, 140],
    data: { url: m.url || '/', id: m.id, token: m.token, kind: m.kind },
    actions: m.id && !['arrive', 'cancel', 'skip', 'passed'].includes(m.kind) ? [{ action: 'stop', title: 'Non avvisarmi più' }] : []
  });
}
const ENDS = ['arrive', 'cancel', 'skip', 'passed'];
const toClients = msg => self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => cs.forEach(c => c.postMessage(msg)));
self.addEventListener('push', e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch { m = { title: 'Venezia TPL live', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async cs => {
    const front = cs.find(c => c.visibilityState === 'visible' && c.focused);
    if (front) front.postMessage({ type: 'tpl-push', msg: m }); else await show(m);
    if (ENDS.includes(m.kind)) await toClients({ type: 'tpl-watch-ended', id: m.id });
  }));
});
// messaggi dell'app aperta in secondo piano (dispositivi senza Web Push): stessa grafica
self.addEventListener('message', e => { if (e.data?.type === 'tpl-notify' && e.data.msg) e.waitUntil(show(e.data.msg)); });
// il servizio di notifica rinnova l'iscrizione: si rifà e gli avvisi attivi passano alla nuova (niente avvisi persi)
const b64ToBytes = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)); return Uint8Array.from(b, ch => ch.charCodeAt(0)); };
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const old = e.oldSubscription?.endpoint; let sub = e.newSubscription;
    if (!sub) { const { key } = await (await fetch('/api/push-key', { cache: 'no-store' })).json(); sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }); }
    if (old) await fetch('/api/watch/resub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old, sub: sub.toJSON() }) });
  })().catch(() => {}));
});
self.addEventListener('notificationclick', e => {
  const d = e.notification.data || {}; e.notification.close();
  if (e.action === 'stop') {
    e.waitUntil(fetch('/api/watch/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.id, token: d.token }) }).catch(() => {})
      .then(() => toClients({ type: 'tpl-watch-ended', id: d.id })));
    return;
  }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => new URL(x.url).origin === location.origin);
    if (c) { c.postMessage({ type: 'tpl-open', url: d.url }); return c.focus(); }
    return self.clients.openWindow(d.url || '/');
  }));
});
