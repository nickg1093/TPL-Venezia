// ORARI DI UN'ALTRA DATA (modalità «Programmato», percorso in un altro giorno) E FILE DEGLI ORARI PER GIORNO SUL CDN.
//
// Il problema. Le versioni dei GTFS ACTV possono coprire mesi (65.000 corse, 134 MB di orari); leggere il file intero per una data
// diversa da oggi pesa sul server (memoria e CPU del piano gratuito). In un giorno circolano invece ~4.500 corse: ~700 KB, ~60 KB compressi.
//
// La soluzione. Il workflow GitHub «dati» (scripts/genera-dati.js) prepara con QUESTO modulo un file per ogni giorno di ogni versione
// in archivio per i giorni in cui serve (quelli per cui quella versione è la scelta, più il giorno prima e il giorno dopo), e li pubblica sul ramo «dati» (CDN jsDelivr, come i dati fissi):
//   orari/<nav|aut>/<versione>.json   indice della versione: { f, src, v, h (impronta md5 completa dello ZIP), giorni: { AAAAMMGG: file | 0 } }
//   orari/<nav|aut>/g/<file>.json     corse di un giorno (il nome è l'impronta del contenuto: giorni uguali = un file solo)
// Per una data diversa da oggi il server scarica i tre giorni che servono (giorno prima, giorno, giorno dopo), ~180 KB compressi, e
// ricostruisce le stesse strutture che otterrebbe dallo ZIP (verificato dai test: partenze e posizioni identiche).
//
// Dati sempre corretti. Il server usa i file del CDN SOLO se:
//   · la versione scelta per quella data (gtfsstore.choose, come sempre) è la stessa in uso oggi (fermate, linee e tracciati si prendono da lì);
//   · l'indice della versione sul CDN ha la stessa impronta md5 completa dello ZIP scelto (una versione nuova di ACTV ha un'altra impronta);
//   · ogni file scaricato ha l'impronta del suo nome (quella scritta nell'indice per quel giorno) e dichiara la versione giusta.
// Il giorno non è scritto nel file (sta nell'indice): così i giorni con le stesse corse (es. tutti i feriali) sono un file solo.
// In ogni altro caso (CDN irraggiungibile, versione non ancora elaborata dal workflow, giorno mancante, versione diversa) si leggono le
// corse dallo ZIP in archivio, a pezzi e solo per quei tre giorni (gtfs.loadVersion): più lento, sempre esatto. Il CDN non è mai indispensabile.
const crypto = require('crypto');
const { destinazione } = require('./nomi');
const gtfs = require('./gtfs');
const cal = require('./calendar');
const ids = require('./ids');

const FORMATO = 1;
const MAX_FILE = 4 * 1024 * 1024;                     // nessun file del CDN più grande di così (un giorno: ~0,7 MB)
const sha16 = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const RE_DAY = /^\d{8}$/, RE_SHA16 = /^[0-9a-f]{16}$/, RE_V = /^[0-9a-f]{12}$/, RE_MD5 = /^[0-9a-f]{32}$/;

// ---- generazione (workflow) ----
// File di un giorno da una versione letta per intero (gtfs.loadVersion(..., { full: true })). Corse in servizio quel giorno, nell'ordine
// del file (n = posizione tra tutte le corse: il server le rimette in quell'ordine). Righe: [n, trip_id, route_id, headsign, service_id,
// shape_id, direction_id, percorso, partenza, arrivi relativi[], soste[] | 0]. Percorsi: [fermate[], stop_sequence[]] condivisi.
function giorno(G, src, d, ordine = null) {
  const svc = cal.activeServices(G.calendar, G.exByDate, d);
  const pos = ordine || new Map(G.tripIds.map((t, n) => [t, n])), pats = new Map(), P = [], T = [];
  for (const tid in G.trips) {
    const tr = G.trips[tid]; if (!svc.has(tr.service)) continue;
    const st = G.stopTimes.get(tid);
    if (!st) { T.push([-1, tid, tr.route, tr.headsign, tr.service, tr.shape, tr.dir, -1, 0, [], 0]); continue; }
    let pi = pats.get(st.s);
    if (pi === undefined) { pats.set(st.s, pi = P.length); P.push([st.s, Array.from(st.q)]); }
    const t0 = st.d[0], a = Array.from(st.a, x => x - t0), w = Array.from(st.d, (x, i) => x - st.a[i]);
    T.push([pos.get(tid), tid, tr.route, tr.headsign, tr.service, tr.shape, tr.dir, pi, t0, a, w.some(Boolean) ? w : 0]);
  }
  T.sort((x, y) => (x[0] < 0) - (y[0] < 0) || x[0] - y[0]);
  if (!T.length) return null;
  return Buffer.from(JSON.stringify({ f: FORMATO, src, v: String(G.meta.hash).slice(0, 12), p: P, t: T }));
}
// I giorni indicati di una versione: { indice: Buffer, files: Map(nome -> Buffer) }
function versione(G, src, days) {
  const files = new Map(), giorni = {}, ordine = new Map(G.tripIds.map((t, n) => [t, n]));
  for (const d of [...new Set(days)].sort()) {
    const buf = giorno(G, src, d, ordine);
    if (!buf) { giorni[d] = 0; continue; }
    const name = sha16(buf); files.set(name, buf); giorni[d] = name;
  }
  const indice = Buffer.from(JSON.stringify({ f: FORMATO, src, v: String(G.meta.hash).slice(0, 12), h: G.meta.hash, giorni }));
  return { indice, files };
}

// ---- lettura (server) ----
function checkIndice(j, src, hash) {
  if (!j || j.f !== FORMATO || j.src !== src || j.h !== hash || !RE_MD5.test(j.h) || j.v !== hash.slice(0, 12) || !j.giorni || typeof j.giorni !== 'object') return null;
  for (const [d, n] of Object.entries(j.giorni)) if (!RE_DAY.test(d) || !(n === 0 || RE_SHA16.test(n))) return null;
  return j;
}
function checkGiorno(j, src, v) {
  if (!j || j.f !== FORMATO || j.src !== src || j.v !== v || !Array.isArray(j.p) || !Array.isArray(j.t)) return null;
  for (const p of j.p) if (!Array.isArray(p) || !Array.isArray(p[0]) || !Array.isArray(p[1]) || p[0].length !== p[1].length) return null;
  for (const r of j.t) {
    if (!Array.isArray(r) || r.length !== 11 || typeof r[1] !== 'string' || !Number.isInteger(r[0]) || !Number.isInteger(r[7])) return null;
    if (r[7] >= 0) { const p = j.p[r[7]]; if (!p || !Array.isArray(r[9]) || r[9].length !== p[0].length || (r[10] !== 0 && (!Array.isArray(r[10]) || r[10].length !== p[0].length))) return null; }
  }
  return j;
}
// Strutture degli orari come gtfs.js (build), dalle corse dei giorni (file già controllati) e da fermate/linee/tracciati della versione
// in uso (base: stessa impronta). Oggetto nuovo: le cache interne (servizi, indici) restano separate da quelle della base.
function ricostruisci(base, giorni, date) {
  const G = gtfs.empty();
  for (const k of ['routes', 'stops', 'stopLoc', 'routeShapes', 'shapePts', 'calendar', 'exByDate', 'nameToStopIds', 'stopBaseNames', 'stopIsRequest']) G[k] = base[k];
  const rows = new Map();
  for (const j of giorni) {
    const P = j.p.map(([s, q]) => ({ s, q: Int32Array.from(q) }));
    for (const r of j.t) if (!rows.has(r[1])) rows.set(r[1], { r, P });
  }
  const ord = [...rows.values()].sort((x, y) => (x.r[0] < 0) - (y.r[0] < 0) || x.r[0] - y.r[0]);
  for (const { r, P } of ord) {
    const [n, tid, route, headsign, service, shape, dir, pi, t0, a, w] = r;
    G.trips[tid] = { route, headsign: destinazione(headsign), service, shape, dir };   // anche dai file del CDN generati prima di nomi.js
    if (n < 0 || pi < 0) continue;
    const p = P[pi], A = Int32Array.from(a, x => x + t0), Dp = Int32Array.from(A, (x, i) => x + (w ? w[i] : 0));
    G.stopTimes.set(tid, { s: p.s, q: p.q, a: A, d: Dp, start: Dp[0], end: A[A.length - 1] });
  }
  G.tripIds = [...G.stopTimes.keys()];
  const cnt = {};
  for (const tid of G.tripIds) for (const sid of G.stopTimes.get(tid).s) cnt[sid] = (cnt[sid] || 0) + 1;
  for (const sid in cnt) G.stopIndex[sid] = new Int32Array(cnt[sid] * 2);
  const at = {};
  G.tripIds.forEach((tid, n) => { const s = G.stopTimes.get(tid).s; for (let i = 0; i < s.length; i++) { const p = at[s[i]] || 0; G.stopIndex[s[i]][p] = n; G.stopIndex[s[i]][p + 1] = i; at[s[i]] = p + 2; } });
  for (const sid in base.stopIndex) if (!G.stopIndex[sid]) G.stopIndex[sid] = new Int32Array(0);
  ids.attach(G);
  const days = gtfs.window3(date);
  G.meta = { ...base.meta, reason: `versione per la data ${date} (orari dal CDN)`, today: date, loadedAt: Date.now(), days, key: base.meta.hash + '@' + date, cdn: true };
  return G;
}

// ---- server: orari per una data ----
let remote = null;                                   // fissi.remote del server (indice del ramo «dati»: commit, versioni presenti)
const indici = new Map();                            // commit|src/versione -> indice già scaricato e controllato
let avvisato = '';
const init = o => { remote = o.remote || null; };
async function scarica(rel) {
  let last = null;
  for (const b of remote.bases()) {
    try {
      const r = await fetch(`${b}/${rel}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) { last = new Error('HTTP ' + r.status); continue; }
      if ((+r.headers.get('content-length') || 0) > MAX_FILE) throw new Error('file troppo grande');
      const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > MAX_FILE) throw new Error('file troppo grande');
      return buf;
    } catch (e) { last = e; }
  }
  throw last || new Error('CDN non configurato');
}
async function dalCdn(id, pick, date, base) {
  const cur = remote?.get?.(), v = pick.hash.slice(0, 12);
  if (!cur || !cur.orari?.has(`${id}/${v}`)) throw new Error('versione non ancora sul CDN');
  const ik = `${cur.commit}|${id}/${v}`;
  let idx = indici.get(ik);
  if (!idx) {
    idx = checkIndice(JSON.parse(await scarica(`orari/${id}/${v}.json`)), id, pick.hash);
    if (!idx) throw new Error('indice della versione non valido');
    if (indici.size > 8) indici.clear();
    indici.set(ik, idx);
  }
  const giorni = [];
  for (const d of gtfs.window3(date)) {
    const name = idx.giorni[d];
    if (name === undefined) throw new Error(`giorno ${d} assente`);
    if (name === 0) continue;                         // nessuna corsa quel giorno
    const buf = await scarica(`orari/${id}/g/${name}.json`);
    if (sha16(buf) !== name) throw new Error(`file del ${d} alterato`);
    const j = checkGiorno(JSON.parse(buf), id, v); if (!j) throw new Error(`file del ${d} non valido`);
    giorni.push(j);
  }
  return ricostruisci(base, giorni, date);
}
// base = orari in uso oggi (live.js). Sempre un risultato esatto: CDN se possibile, altrimenti ZIP.
async function perData(id, pick, date, base = null) {
  if (remote && base?.meta?.hash === pick.hash) {
    try {
      const G = await dalCdn(id, pick, date, base);
      console.log(`GTFS [${id}]: orari del ${date} dal CDN (${G.tripIds.length} corse)`);
      return G;
    } catch (e) {
      const k = `${id}|${pick.hash}|${e.message}`;
      if (avvisato !== k) { avvisato = k; console.log(`GTFS [${id}]: orari del ${date} dallo ZIP (CDN: ${e.message})`); }
    }
  }
  return gtfs.loadVersion(id, pick, date);
}

module.exports = { FORMATO, giorno, versione, ricostruisci, checkIndice, checkGiorno, perData, init, sha16 };
