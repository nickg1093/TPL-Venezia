// DATI FISSI (fermate, linee, tracciati) SALVATI SUI DISPOSITIVI E SCARICATI DAL CDN.
//
// Cosa sono. Le parti dei GTFS che cambiano solo con una nuova versione degli orari: elenco delle fermate, linee, tracciati delle linee.
// Prima arrivavano dal server a ogni apertura dell'app (fermate: ~36 KB compressi ogni volta). Ora il telefono li tiene in memoria e li
// riscarica solo quando cambia la versione dei GTFS, di preferenza dal CDN (jsDelivr, che legge il ramo «dati» del repository GitHub).
//
// Chi decide cosa è valido. Il SERVER: per ogni servizio (nav, aut) calcola i file dalla versione dei GTFS che sta usando davvero e ne
// pubblica l'impronta SHA-256 in /api/fissi. Il telefono usa un file del CDN SOLO se la sua impronta coincide; altrimenti lo chiede al
// server (/api/fisso), e se anche questo non va usa i vecchi indirizzi (/api/stops, /api/routes, /api/shapes). Così non si possono mai
// mescolare fermate di una versione con orari di un'altra, e il CDN non è mai indispensabile.
//
// Chi genera i file del CDN. Il workflow GitHub «dati» (scripts/genera-dati.js) con QUESTO stesso modulo e lo stesso ZIP: i byte sono
// identici a quelli calcolati dal server, quindi le impronte coincidono. Una versione dei GTFS scaricata dal server ma non ancora
// elaborata dal workflow resta servita dal server finché non arriva sul CDN (di solito poche ore).
//
// Il ramo «dati» contiene anche le mattonelle della rete pedonale (scripts/pedoni-core.js) usate dal telefono per i percorsi a piedi.
// Il file indice.json del ramo dice in quale commit stanno i file: gli indirizzi del CDN usano quel commit, quindi non cambiano mai e
// restano in cache per sempre.
const crypto = require('crypto');
const zlib = require('zlib');

const FORMATO = 1;
const NOMI = ['stops', 'routes', 'shapes'];
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
// versione dei dati di un servizio: impronta (md5) dello ZIP dei GTFS da cui vengono, accorciata
const versione = G => String(G?.meta?.hash || '').slice(0, 12);

// tracciato -> testo compatto («encoded polyline», 5 decimali come /api/shapes): un decimo dello spazio, stessi punti
function encode(pts) {
  let o = '', pl = 0, pn = 0;
  const e = v => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 0x20) { o += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } o += String.fromCharCode(v + 63); };
  for (const [a, b] of pts) { const la = Math.round(a * 1e5), ln = Math.round(b * 1e5); e(la - pl); e(ln - pn); pl = la; pn = ln; }
  return o;
}
function decode(s) {
  const out = []; let i = 0, la = 0, ln = 0;
  const d = () => { let r = 0, sh = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20 && i < s.length); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < s.length) { la += d(); ln += d(); out.push([la / 1e5, ln / 1e5]); }
  return out;
}

// I tre file di un servizio, come testo JSON (Buffer):
//   stops  [[id, nome, lat, lon], …]  le stesse righe di /api/stops (senza il prefisso «src:» e senza il servizio in coda)
//   routes {route_id: {name, color, type}}  come /api/routes (senza src)
//   shapes {route_id: [tracciato codificato, …]}  come /api/shapes, codificati con encode()
function files(G, toLL) {
  const stops = [];
  for (const s in G.stopIndex) { const name = G.stopBaseNames?.get(s) || G.stops[s], l = G.stopLoc[s]; if (l && name) stops.push([s, name, l[0], l[1]]); }
  const shapes = {};
  for (const r in G.routeShapes) shapes[r] = G.routeShapes[r].map(p => encode(toLL(p)));
  return { stops: Buffer.from(JSON.stringify(stops)), routes: Buffer.from(JSON.stringify(G.routes)), shapes: Buffer.from(JSON.stringify(shapes)) };
}

// ---- lato server ----
// Per servizio: { v, files: { stops: { sha, gz }, … } } calcolati una volta per versione dei GTFS (pochi decimi di secondo).
function store(toLL) {
  const cache = new Map();                                      // servizio -> { hash, v, files }
  return {
    get(id, G) {
      const h = G?.meta?.hash; if (!h) return null;
      let c = cache.get(id);
      if (!c || c.hash !== h) {
        const f = files(G, toLL), out = {};
        for (const k of NOMI) out[k] = { sha: sha256(f[k]), gz: zlib.gzipSync(f[k], { level: 9 }), size: f[k].length };
        cache.set(id, c = { hash: h, v: versione(G), files: out });
      }
      return c;
    }
  };
}

// ---- indice del ramo «dati» su GitHub (letto dal server ogni mezz'ora: pochi byte, di solito «non cambiato») ----
const RE_COMMIT = /^[0-9a-f]{40}$/, RE_VER = /^[0-9a-f]{6,64}$/, RE_SHA = /^[0-9a-f]{64}$/;
function parseIndice(j) {
  if (!j || typeof j !== 'object' || j.formato !== FORMATO || !RE_COMMIT.test(j.commit || '')) return null;
  const fissi = new Set((Array.isArray(j.fissi) ? j.fissi : []).filter(x => typeof x === 'string' && /^(nav|aut)\/[0-9a-f]{12}$/.test(x)));
  const p = j.pedoni, ok = p && RE_VER.test(p.v || '') && RE_SHA.test(p.indice || '') && p.lat > 0 && p.lat < 1 && p.lon > 0 && p.lon < 1;
  return { commit: j.commit, fissi, pedoni: ok ? { v: p.v, indice: p.indice, lat: +p.lat, lon: +p.lon } : null };
}
function remote({ repo, enabled = true, every = 30 * 60e3, fetchFn = globalThis.fetch } = {}) {
  let cur = null, etag = null, timer = null;
  const url = `https://raw.githubusercontent.com/${repo}/dati/indice.json`;
  async function poll() {
    try {
      const r = await fetchFn(url, { headers: etag ? { 'If-None-Match': etag } : {}, signal: AbortSignal.timeout(10000) });
      if (r.status === 304) return;
      if (!r.ok) return;
      const txt = await r.text(); if (txt.length > 65536) return;
      const p = parseIndice(JSON.parse(txt)); if (!p) return;
      cur = p; etag = r.headers.get('etag');
    } catch { /* GitHub irraggiungibile: si continua con l'ultimo indice letto (o senza CDN) */ }
  }
  return {
    start() { if (!enabled || !repo || !fetchFn) return; poll(); timer = setInterval(poll, every); timer.unref?.(); },
    stop() { clearInterval(timer); },
    poll,
    get: () => cur,
    set: v => { cur = v; },                                     // per le prove
    // basi del CDN per un commit: jsDelivr, poi raw.githubusercontent.com come riserva
    bases: () => (cur ? [`https://cdn.jsdelivr.net/gh/${repo}@${cur.commit}`, `https://raw.githubusercontent.com/${repo}/${cur.commit}`] : [])
  };
}

module.exports = { FORMATO, NOMI, files, store, versione, sha256, encode, decode, parseIndice, remote };
