// CENTRALE ACTV — lettura di oraritemporeale.actv.it: elenco fermate, partenze di una fermata, limiti verso ACTV, controllo continuo.
// Si legge sempre la pagina della SINGOLA fermata (mai i "terminal", che uniscono fermate distinte nel GTFS: Mestre Centro + 27 Ottobre).
const { equivalentStops } = require('./stopgroups');
const { C, st, lineOf, fresh, SRC } = require('./centrale-stato');

const BASE = (process.env.ACTV_CENTRALE_URL || 'https://oraritemporeale.actv.it').replace(/\/+$/, '');
const sleep = ms => new Promise(ok => setTimeout(ok, ms).unref?.());

// ---- richieste: al massimo MAX_PARALLEL insieme e MAX_PER_MIN al minuto; dopo FAIL_MAX errori di fila, pausa ----
const queue = []; let inFlight = 0, minute = 0, perMinute = 0;
function pump() {
  const m = Math.floor(Date.now() / 60000); if (m !== minute) { minute = m; perMinute = 0; }
  while (queue.length && inFlight < C.MAX_PARALLEL && perMinute < C.MAX_PER_MIN) { inFlight++; perMinute++; queue.shift()(); }
  if (queue.length && perMinute >= C.MAX_PER_MIN) setTimeout(pump, 1000).unref?.();
}
async function getJson(path) {
  const s = st.stat;
  if (Date.now() < s.pausaFino) throw new Error('pausa dopo errori ripetuti');
  await new Promise(ok => { queue.push(ok); pump(); });
  try {
    const r = await fetch(BASE + path, { headers: { Accept: 'application/json', 'User-Agent': 'VeneziaTPL-live (orari ACTV per i passeggeri)' }, signal: AbortSignal.timeout(C.TIMEOUT_MS) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(); s.letture++; s.erroriDiFila = 0; return j;
  } catch (e) {
    s.errori++; if (e.name === 'TimeoutError') s.timeout++; s.ultimoErrore = `${new Date().toISOString()} ${path}: ${e.message}`;
    if (++s.erroriDiFila >= C.FAIL_MAX) { s.pausaFino = Date.now() + C.PAUSE_MS; s.erroriDiFila = 0; }
    throw e;
  } finally { inFlight--; pump(); }
}
const budgetLeft = () => { const m = Math.floor(Date.now() / 60000); return m !== minute ? C.MAX_PER_MIN : C.MAX_PER_MIN - perMinute - queue.length; };

// ---- elenco fermate: codice GTFS -> pagina ACTV più specifica che lo contiene ----
// I nomi delle pagine contengono i codici ("392-1392-web-aut", "5009-5011-...-S.Marco_S.Zaccaria-nav-web").
function buildCatalog(list) {
  const byCode = new Map();
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s.name !== 'string' || /^terminal/i.test(s.name)) continue;
    const codes = s.name.split('-').filter(t => /^\d{1,6}$/.test(t)); if (!codes.length) continue;
    const ent = { page: s.name, codes, lines: new Set((s.lines || []).map(l => lineOf(l.alias))) };
    for (const c of codes) { const o = byCode.get(c); if (!o || o.codes.length > codes.length) byCode.set(c, ent); }
  }
  return byCode;
}
async function ensureCatalog(src) {
  const c = st.catalog[src] ||= { t: 0, byCode: new Map(), p: null };
  if (Date.now() - c.t < C.CATALOG_MS && c.byCode.size) return c;
  c.p ||= getJson(`/${src}/backend/page/stops`).then(j => { const m = buildCatalog(j); if (m.size) { c.byCode = m; c.t = Date.now(); } })
    .catch(() => { c.t = Date.now() - C.CATALOG_MS + 60e3; }).finally(() => { c.p = null; });   // errore: si riprova fra un minuto
  if (!c.byCode.size) await c.p;
  return c;
}

// ---- partenze di una pagina (lettura già in corso o dato fresco: nessuna nuova richiesta) ----
function fetchPage(src, page) {
  const k = src + '|' + page, e = st.pages.get(k) || st.pages.set(k, { t: 0, rows: null, p: null }).get(k);
  if (Date.now() - e.t < C.FRESH_MS || e.p) return e;
  const at = Date.now();
  e.p = getJson(`/${src}/backend/passages/${encodeURIComponent(page)}`)
    .then(j => { if (Array.isArray(j)) { e.rows = j; e.t = at; e.err = null; } else e.err = 'formato inatteso'; })
    .catch(err => { e.err = err.message; })
    .finally(() => { e.p = null; });
  if (st.pages.size > 3000) for (const [kk, v] of st.pages) if (Date.now() - v.t > C.STALE_MS && !v.p) st.pages.delete(kk);
  return e;
}

// pagine ACTV di una fermata (codice e fermate equivalenti dello stesso palo)
function pagesFor(src, sid) {
  const G = st.ctx?.G(src), c = st.catalog[src]; if (!G || !c) return [];
  const out = new Map();
  for (const eq of equivalentStops(G, sid)) { const ent = c.byCode.get(eq); if (ent) out.set(ent.page, ent); }
  return [...out.values()];
}

// Dati ACTV di più fermate (pannello fermata/zona, pannello del mezzo): lancia le letture e aspetta al massimo WAIT_MS quelle senza dato.
async function prepareStops(list) {
  if (!st.ctx) return;
  try {
    const srcs = [...new Set(list.map(([s]) => s).filter(s => SRC.has(s)))];
    await Promise.race([Promise.all(srcs.map(ensureCatalog)), sleep(C.WAIT_MS)]);
    const waits = [];
    for (const [src, sid] of list) {
      if (!SRC.has(src)) continue;
      for (const ent of pagesFor(src, sid)) { const e = fetchPage(src, ent.page); if (!fresh(e) && e.p && waits.length < C.MAX_PAGES_WAIT) waits.push(e.p); }
    }
    if (waits.length) await Promise.race([Promise.allSettled(waits), sleep(C.WAIT_MS)]);
  } catch { /* la centrale non è indispensabile */ }
}

// ---- controllo continuo in sottofondo ----
// Ogni 10 s, entro BG_PER_MIN letture al minuto (e lasciando sempre spazio alle richieste degli utenti): prima le fermate per cui turni.js ha
// chiesto un controllo (mezzi molto in ritardo), poi, a rotazione, la prossima fermata di ogni mezzo in servizio. Così il confronto è continuo
// su tutti i mezzi e le corse, e i dati sono già pronti quando un utente apre un pannello.
let rot = 0, timer = null, onPages = null;
function tick() {
  if (!st.ctx || C.BG_PER_MIN <= 0) return;
  const now = Date.now(), want = [], seen = new Set();
  const push = (src, sid) => { const k = src + '|' + sid; if (!seen.has(k)) { seen.add(k); want.push([src, sid]); } };
  for (const [k, t] of st.wants) { if (now - t > 60e3) { st.wants.delete(k); continue; } const [src, sid] = k.split('|'); push(src, sid); }
  const all = [];
  for (const src of SRC) {
    const state = st.ctx.state(src) || {}, G = st.ctx.G(src); if (!G) continue;
    for (const tid in state) { const ps = state[tid], s = G.stopTimes.get(tid); if (ps?.vehKey && s && ps.cur < s.s.length) all.push([src, s.s[ps.cur]]); }
  }
  for (let j = 0; j < all.length; j++) { const x = all[(rot + j) % all.length]; push(x[0], x[1]); }
  let budget = Math.min(Math.ceil(C.BG_PER_MIN * C.BG_EVERY_MS / 60000), Math.max(0, budgetLeft() - 20)), used = 0;
  const reads = [];
  for (const [src, sid] of want) {
    if (used >= budget) break;
    if (!st.catalog[src]?.byCode.size) { ensureCatalog(src).catch(() => {}); continue; }
    for (const ent of pagesFor(src, sid)) {
      const e = st.pages.get(src + '|' + ent.page);
      if (e && (e.p || now - e.t < C.FRESH_MS)) continue;                // dato recente o lettura in corso
      const f = fetchPage(src, ent.page); if (f.p) { reads.push(f.p); used++; }
    }
  }
  if (all.length) rot = (rot + Math.max(1, used)) % all.length;
  if (reads.length && onPages) Promise.allSettled(reads).then(() => { try { onPages(); } catch { /* diagnosi */ } });
}
function startBackground(after) {
  onPages = after;
  if (!timer && C.BG_PER_MIN > 0) timer = setInterval(tick, C.BG_EVERY_MS), timer.unref?.();
}

module.exports = { BASE, getJson, buildCatalog, ensureCatalog, fetchPage, pagesFor, prepareStops, startBackground, tick };
