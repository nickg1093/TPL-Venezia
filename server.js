// SERVER WEB. Instrada le richieste, applica la sicurezza (security.js) e serve la pagina; tutta la logica dei mezzi è in live.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const live = require('./live');
const schedule = require('./schedule');
const gtfs = require('./gtfs');
const tide = require('./tide');
const avvisi = require('./avvisi');
const sec = require('./security');
const { equivalentStops } = require('./stopgroups');
const { audit } = require('./feedaudit');
const { D, S, IDS, ready } = live;

const PORT = +process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '', DIAG_TOKEN = process.env.DIAG_TOKEN || '';
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (code, msg) => Object.assign(new Error(msg), { code });
const q = (u, k) => u.searchParams.get(k);

// ---- parametri comuni ----
const wanted = u => { const s = q(u, 'src'); return s ? s.split(',').filter(x => IDS.includes(x)).slice(0, IDS.length) : IDS.slice(); };
const mode = u => (q(u, 'secs') != null ? 'sched' : 'live');   // in modalità orario non c'è stato live
function timeParams(u) {   // { secs, date } già validati; valori invalidi = errore 400
  const secs = sec.vSecs(q(u, 'secs')), date = sec.vDate(q(u, 'date'));
  if (secs === false) throw sec.bad('parametro secs non valido');
  if (date === false) throw sec.bad('parametro date non valido');
  return { secs, date };
}
const fullId = (u, key) => { const r = sec.vFullId(q(u, key), IDS); if (!r) throw sec.bad(`parametro ${key} non valido`); return r; };
// Ordine di passaggio: per orario PREVISTO (con ritardo/anticipo reale), poi per orario programmato.
const byExpected = (a, b) => (a.expSec - b.expSec) || (a.schedIn - b.schedIn);
const labelsOf = i => new Map(S[i].vehicles.filter(x => x.tripId && x.label).map(x => [x.tripId, x.label]));

// Dati del veicolo esposti al pubblico: solo ciò che serve alla mappa (niente stati interni)
const PUBLIC_VEH = ['id', 'src', 'label', 'lat', 'lon', 'bearing', 'speed', 'line', 'color', 'tripId', 'routeId', 'headsign', 'key', 'ts', 'old', 'sim', 'co', 'dup', 'dupWith', 'path'];
const publicVehicle = v => { const o = {}; for (const k of PUBLIC_VEH) if (v[k] !== undefined && v[k] !== null && v[k] !== false) o[k] = v[k]; if (o.speed != null) o.speed = +o.speed.toFixed(1); return o; };

// marea con cache breve: più utenti = una sola richiesta al portale
let tideCache = { t: 0, v: null };
async function getTideCached(debug) {
  if (!debug && tideCache.v && Date.now() - tideCache.t < 30000) return tideCache.v;
  const v = await tide.getTide({ debug }); if (!debug) tideCache = { t: Date.now(), v }; return v;
}

// Elenco passaggi di una fermata (o di più fermate = zona), con i mezzi equivalenti e senza doppioni
function departuresFor(fulls, u) {
  const { secs, date } = timeParams(u), liveMode = mode(u) === 'live', out = [], seen = new Set();
  let note = null, liveUpdated = 0;
  for (const [i, sid] of fulls) {
    const G = D[i], lab = labelsOf(i), full = `${i}:${sid}`;
    for (const eq of equivalentStops(G, sid)) {
      const isRequest = G.stopIsRequest?.get(eq) || false;
      for (const d of schedule.departures(G, S[i].live, eq, secs, date, liveMode ? S[i].state : null)) {
        const k = `${full}|${d.tripId}|${d.seq}|${d.veh ?? ''}|${d.done ? 1 : 0}`;
        if (seen.has(k)) continue; seen.add(k);
        out.push({ ...d, src: i, stop: full, vehicle: d.vehLabel || lab.get(d.tripId) || null, isRequest });
      }
    }
    note = live.noteOf(G, date); liveUpdated = Math.max(liveUpdated, S[i].updated);
  }
  return { out: out.sort(byExpected), note, liveUpdated };
}

// ---- ROUTE API ----  auth: 'diag' | 'admin' | undefined;  method: 'POST' solo per azioni che modificano lo stato
const API = new Map(Object.entries({
  '/api/vehicles': { fn: u => {
    const list = wanted(u), errors = list.map(i => S[i].error).filter(Boolean), now = Date.now();
    return { updated: Math.max(0, ...list.map(i => S[i].updated)), feedTs: Math.max(0, ...list.map(i => S[i].feedTs || 0)) || null,
      error: errors.join('; ') || null, version: live.version(), ready, sim: list.filter(i => S[i].sim),
      stale: list.filter(i => S[i].feedTs && now - S[i].feedTs > 5 * 60e3),     // servizi il cui feed non si aggiorna da oltre 5 minuti
      vehicles: list.flatMap(i => S[i].vehicles.map(publicVehicle)) };
  } },
  '/api/scheduled': { fn: u => {
    const errors = [], vehicles = [], { secs, date } = timeParams(u);
    for (const i of wanted(u)) {
      try {
        for (const v of schedule.positionsNow(D[i], secs, date))
          vehicles.push({ ...v, tripId: v.id, id: `${i}:${v.id}`, src: i, routeId: v.routeId ? `${i}:${v.routeId}` : null });
      } catch (e) { errors.push(`${i}: errore`); console.error('scheduled', i, e.message); }
    }
    return { updated: Date.now(), error: errors.join('; ') || null, version: live.version(), ready, vehicles };
  } },
  '/api/stops': { raw: (u, req, res) => {
    let gz = live.stopsCache();
    if (!gz) {
      const out = [];
      for (const i of IDS) {
        const G = D[i];
        for (const s in G.stopIndex) {
          const name = G.stopBaseNames?.get(s) || G.stops[s], l = G.stopLoc[s];
          if (l && name) out.push([`${i}:${s}`, name, l[0], l[1], i]);
        }
      }
      live.setStopsCache(gz = zlib.gzipSync(Buffer.from(JSON.stringify(out))));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
    res.end(gz);
  } },
  '/api/stop': { fn: u => {
    const [i, sid] = fullId(u, 'id'), G = D[i];
    if (!has(G.stopIndex, sid)) throw fail(404, 'fermata sconosciuta');
    const { out, note, liveUpdated } = departuresFor([[i, sid]], u);
    return { stop: { id: `${i}:${sid}`, name: G.stopBaseNames?.get(sid) || G.stops[sid] || sid, src: i }, liveUpdated, note, departures: out.slice(0, 120) };
  } },
  '/api/zone': { fn: u => {
    const list = (q(u, 'ids') || '').split(',').slice(0, 24).map(f => sec.vFullId(f, IDS));
    if (!list.length || list.some(x => !x)) throw sec.bad('parametro ids non valido');
    if (list.some(([i, sid]) => !has(D[i].stopIndex, sid))) throw fail(404, 'zona sconosciuta');
    const { out, note, liveUpdated } = departuresFor(list, u);
    return { liveUpdated, note, departures: out.slice(0, 300) };
  } },
  '/api/trip': { fn: u => {
    const [i, tid] = fullId(u, 'id'), veh = q(u, 'veh');
    if (!sec.vVeh(veh)) throw sec.bad('parametro veh non valido');
    if (!D[i].stopTimes.has(tid)) throw fail(404, 'corsa sconosciuta');
    return live.tripDetail(i, tid, q(u, 'mode') !== 'sched', veh || null);
  } },
  '/api/routes': { fn: () => {
    const out = {};
    for (const i of IDS) for (const r in D[i].routes) out[`${i}:${r}`] = { ...D[i].routes[r], src: i };
    return out;
  } },
  '/api/shapes': { fn: u => {
    const [i, rid] = fullId(u, 'id');
    return { shapes: has(D[i].routeShapes, rid) ? D[i].routeShapes[rid].map(p => gtfs.toLL(p)) : [] };
  } },
  // MAREA: livello attuale, tendenza e prossimi estremi (CPSM Venezia, open data). Il campione grezzo (?debug=1) richiede DIAG_TOKEN.
  '/api/tide': { fn: u => getTideCached(q(u, 'debug') === '1' && sec.tokenOk(u._req, DIAG_TOKEN)) },
  // AVVISI DI INFOMOBILITÀ (sito ACTV + canale Telegram), con linee e fermate collegate; aggiornati in automatico (avvisi.js)
  '/api/avvisi': { fn: () => avvisi.getAvvisi() },
  // DIAGNOSI (riservata, DIAG_TOKEN): analisi dei feed realtime, collegamento col GTFS statico, versioni GTFS in archivio e scelta
  '/api/audit': { auth: 'diag', fn: u => Object.fromEntries(wanted(u).map(i => [i, {
    intervalloLetturaMs: live.REFRESH_MS, periodoPubblicazioneStimatoMs: S[i].pubMs ? Math.round(S[i].pubMs) : null,
    ultimoAggiornamento: S[i].updated ? new Date(S[i].updated).toISOString() : null, posizioniDaOrario: S[i].sim,
    etaFeedSecondi: S[i].feedTs ? Math.round((Date.now() - S[i].feedTs) / 1000) : null,
    collegamentoGtfsStatico: S[i].match,
    veicoli: S[i].raw.vehiclePositions ? audit(S[i].raw.vehiclePositions.buf) : null,
    tripUpdates: S[i].raw.tripUpdates ? audit(S[i].raw.tripUpdates.buf) : null
  }])) },
  '/api/gtfs': { auth: 'diag', fn: () => live.gtfsStatus() },
  // quale IP vede il server per chi chiama (serve a scegliere TRUST_PROXY): intestazione X-Forwarded-For grezza e IP usato per i limiti
  '/api/whoami': { auth: 'diag', fn: (u, req) => ({ xForwardedFor: req.headers['x-forwarded-for'] || null, remote: req.socket.remoteAddress, ipUsato: sec.clientIp(req), trustProxy: process.env.TRUST_PROXY ?? null }) },
  // RICARICA GTFS (riservata, ADMIN_TOKEN, solo POST): controlla il sito ACTV, archivia le versioni nuove e rivaluta quale usare
  '/api/reload-gtfs': { auth: 'admin', method: 'POST', fn: async () => {
    const res = {};
    for (const i of IDS) res[i] = await live.syncStatic(i).catch(e => ({ error: e.message }));
    return { ok: true, risultato: res };
  } }
}));

// ---- risposte ----
function send(req, res, obj, code = 200, extra = {}) {
  const body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  const head = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...extra };
  if (body.length < 1024 || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(code, head); return res.end(body); }
  zlib.gzip(body, (err, z) => { res.writeHead(code, err ? head : { ...head, 'Content-Encoding': 'gzip' }); res.end(err ? body : z); });
}
const text = (res, code, msg, extra = {}) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(msg); };

// ---- FILE STATICI: pagina e risorse (public/) + Leaflet (da node_modules, servito dallo stesso sito: nessuna dipendenza da CDN) ----
// Letti UNA volta all'avvio e tenuti in memoria già compressi: nessun accesso al disco per richiesta, quindi nessuna possibilità di
// percorsi tipo ../ (si cerca solo per chiave esatta nella tabella).
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const statics = new Map();
function loadStatics(dir, base = '') {
  if (!fs.existsSync(dir)) return false;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name), url = base + '/' + f.name;
    if (f.isDirectory()) { loadStatics(full, url); continue; }
    const ext = path.extname(f.name).toLowerCase(); if (!MIME[ext]) continue;           // solo tipi noti
    const body = fs.readFileSync(full), compressible = /^\.(html|js|css|webmanifest|json|svg|txt)$/.test(ext);
    const head = { 'Content-Type': MIME[ext], 'Cache-Control': ext === '.png' || url.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
      ETag: '"' + crypto.createHash('md5').update(body).digest('hex').slice(0, 20) + '"' };
    if (f.name === 'sw.js') head['Service-Worker-Allowed'] = '/';
    statics.set(url, { head, body, gz: compressible ? zlib.gzipSync(body) : null });
  }
  return true;
}
loadStatics(path.join(__dirname, 'public'));
try { loadStatics(path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist'), '/vendor/leaflet'); }
catch { console.error('Leaflet non trovato: esegui "npm install" (la mappa non si vedrà)'); }
// dalla cartella dist di Leaflet servono solo libreria, stili e immagini dei controlli
for (const k of [...statics.keys()]) if (k.startsWith('/vendor/leaflet/') && !/^\/vendor\/leaflet\/(leaflet\.(js|css)|images\/.+)$/.test(k)) statics.delete(k);

function serveStatic(req, res, ent) {
  if (req.headers['if-none-match'] === ent.head.ETag) { res.writeHead(304, { ETag: ent.head.ETag, 'Cache-Control': ent.head['Cache-Control'] }); return res.end(); }
  const gz = ent.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, gz ? { ...ent.head, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : ent.head);
  res.end(req.method === 'HEAD' ? undefined : (gz ? ent.gz : ent.body));
}

// ---- AGGIORNAMENTO A SPINTA (Server-Sent Events) ----
// "1" = dati nuovi dal feed (ricaricare mezzi e pannelli); "0" = solo tempo trascorso (ricaricare i pannelli aperti).
const sse = new Set();
live.events.on('push', changed => { const m = `data: ${changed ? 1 : 0}\n\n`; for (const r of sse) { try { r.write(m); } catch { sse.delete(r); } } });
setInterval(() => { for (const r of sse) { try { r.write(': ping\n\n'); } catch { sse.delete(r); } } }, 20000).unref();   // evita che i proxy chiudano la connessione

// ---- GESTORE RICHIESTE ----
async function onRequest(req, res) {
  let u;
  if ((req.url || '').length > 2048) return text(res, 414, 'Indirizzo troppo lungo');
  try { u = new URL(req.url, 'http://localhost'); } catch { return text(res, 400, 'Richiesta non valida'); }
  sec.securityHeaders(req, res);
  const p = u.pathname;
  if (sec.httpsRedirect(req, res, p)) return;
  if (p === '/healthz') return text(res, 200, 'ok');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'POST' && p === '/api/reload-gtfs')) return text(res, 405, 'Metodo non consentito', { Allow: 'GET, HEAD' });

  const wait = sec.limit(req, sec.classOf(p));
  if (wait) return text(res, 429, 'Troppe richieste', { 'Retry-After': String(wait) });

  if (p === '/api/stream') {
    const release = sec.sseAcquire(req);
    if (!release) return text(res, 429, 'Troppe connessioni', { 'Retry-After': '30' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n'); sse.add(res);
    req.on('close', () => { sse.delete(res); release(); });
    return;
  }

  const api = API.get(p);
  if (api) {
    if ((api.method || 'GET') !== req.method && !(req.method === 'HEAD' && !api.method)) return text(res, 405, 'Metodo non consentito', { Allow: api.method || 'GET, HEAD' });
    if (api.auth) {
      if (sec.limit(req, 'admin')) return text(res, 429, 'Troppi tentativi', { 'Retry-After': '60' });
      if (!sec.tokenOk(req, api.auth === 'admin' ? ADMIN_TOKEN : DIAG_TOKEN)) return text(res, 401, 'Non autorizzato', { 'WWW-Authenticate': 'Bearer' });
    }
    try {
      u._req = req;
      if (api.raw) return api.raw(u, req, res);
      send(req, res, await api.fn(u, req));
    } catch (e) {
      const code = e.code >= 400 && e.code < 500 ? e.code : 500;
      if (code === 500) console.error(`errore ${p}:`, e.stack || e.message);
      send(req, res, { error: code === 500 ? 'errore interno' : e.message }, code);       // dettagli interni mai al client
    }
    return;
  }
  if (p.startsWith('/api/')) return send(req, res, { error: 'non trovato' }, 404);

  const ent = statics.get(p === '/' ? '/index.html' : p);
  if (ent) return serveStatic(req, res, ent);
  if (p.includes('.') || p.startsWith('/vendor/')) return text(res, 404, 'Non trovato');   // file inesistente: 404 vero
  const page = statics.get('/index.html');
  return page ? serveStatic(req, res, page) : text(res, 500, 'public/index.html mancante');
}

const server = http.createServer((req, res) => { onRequest(req, res).catch(e => { console.error('richiesta:', e.stack || e.message); if (!res.headersSent) text(res, 500, 'Errore interno'); else res.end(); }); });
server.headersTimeout = 15000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 60;   // protezione da connessioni lente (slowloris)
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));

// ---- AVVIO ----
live.startLoops();
live.startStatic();
// avvisi: linee e fermate si riconoscono con i GTFS in uso (indici ricostruiti solo quando cambia la versione dei dati)
let avCtx = { v: -1 };
avvisi.setContext(() => {
  if (avCtx.v === live.version()) return avCtx;
  const known = new Map(), byName = new Map();
  for (const i of IDS) {
    const G = D[i]; if (!G?.routes) continue;
    for (const r of Object.values(G.routes)) if (r?.name) known.set(String(r.name).toUpperCase(), r.name);
    for (const s in G.stopIndex || {}) { const n = avvisi.norm(G.stopBaseNames?.get(s) || G.stops[s] || ''); if (n) (byName.get(n) || byName.set(n, []).get(n)).push(`${i}:${s}`); }
  }
  return (avCtx = { v: live.version(), known, byName });
});
avvisi.start();
tide.start();   // raccolta periodica del livello di marea: costruisce la storia da cui si ricava la tendenza

// KEEP-ALIVE Render (piano gratuito): si addormenta dopo 15 min senza richieste in ingresso.
// Il server si auto-contatta dall'esterno (URL pubblico) ogni 10 min finché è sveglio; per svegliarlo da spento serve un pinger esterno su /healthz (vedi README).
const SELF = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL;
if (SELF && /^https?:\/\//.test(SELF)) setInterval(() => fetch(SELF.replace(/\/$/, '') + '/healthz', { signal: AbortSignal.timeout(15000) }).catch(() => {}), 10 * 60 * 1000).unref();

// ---- ROBUSTEZZA ----
process.on('unhandledRejection', e => console.error('promessa non gestita:', e && e.stack || e));
process.on('uncaughtException', e => { console.error('errore non gestito, riavvio:', e && e.stack || e); process.exit(1); });   // l'orchestratore (Render) riavvia il processo
function shutdown(sig) {
  console.log(sig + ': chiusura ordinata');
  for (const r of sse) { try { r.end(); } catch { /* già chiusa */ } }
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
