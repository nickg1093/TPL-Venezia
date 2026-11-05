// CENTRALE ACTV — lettura sicura di oraritemporeale.actv.it con contromisure anti-Imperva e richieste On-Demand.
const { equivalentStops } = require('./stopgroups');
const { C, st, lineOf, fresh, SRC } = require('./centrale-stato');

const BASE = (process.env.ACTV_CENTRALE_URL || 'https://oraritemporeale.actv.it').replace(/\/+$/, '');
const sleep = ms => new Promise(ok => setTimeout(ok, ms).unref?.());

// ---- Gestione della Sessione e Cookie Jar per Imperva ----
let cookieJar = '';
const browserHeaders = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// ---- Code di richieste controllate (On-Demand) ----
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
    const headers = { ...browserHeaders, 'Referer': BASE + '/' };
    if (cookieJar) headers['Cookie'] = cookieJar;

    const r = await fetch(BASE + path, { 
      headers, 
      signal: AbortSignal.timeout(C.TIMEOUT_MS) 
    });

    // Cattura e aggiorna i cookie di Imperva (visid_incap, incap_ses, reese84)
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) {
      // Semplice estrazione e merge dei cookie per mantenere la sessione viva
      cookieJar = setCookie.split(',').map(c => c.split(';')[0]).join('; ');
    }

    const contentType = r.headers.get('content-type') || '';
    
    // Se Imperva restituisce HTML anziché JSON, è scattato il challenge di blocco
    if (!r.ok || contentType.includes('text/html')) {
      s.errori++;
      s.ultimoErrore = `${new Date().toISOString()} ${path}: Rilevato blocco o challenge Imperva (HTTP ${r.status})`;
      throw new Error('Blocco anti-bot Imperva attivo');
    }

    const j = await r.json(); 
    s.letture++; 
    s.erroriDiFila = 0; 
    return j;

  } catch (e) {
    s.errori++; 
    if (e.name === 'TimeoutError') s.timeout++; 
    s.ultimoErrore = `${new Date().toISOString()} ${path}: ${e.message}`;
    if (++s.erroriDiFila >= C.FAIL_MAX) { s.pausaFino = Date.now() + C.PAUSE_MS; s.erroriDiFila = 0; }
    throw e;
  } finally { 
    inFlight--; 
    pump(); 
  }
}

// ---- Catalogo fermate (memorizzato a lungo per ridurre le chiamate) ----
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
    .catch(() => { c.t = Date.now() - C.CATALOG_MS + 60e3; }).finally(() => { c.p = null; });
  if (!c.byCode.size) await c.p;
  return c;
}

// ---- Lettura pagine On-Demand (eseguita SOLO all'apertura di una fermata/corsa) ----
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

function pagesFor(src, sid) {
  const G = st.ctx?.G(src), c = st.catalog[src]; if (!G || !c) return [];
  const out = new Map();
  for (const eq of equivalentStops(G, sid)) { const ent = c.byCode.get(eq); if (ent) out.set(ent.page, ent); }
  return [...out.values()];
}

// Funzione principale richiamata ESCLUSIVAMENTE quando l'utente apre una fermata o una corsa
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
  } catch { /* gestito in silenzio per non bloccare l'app se la centrale non risponde */ }
}

// ---- Controllo continuo in sottofondo disattivato per azzerare il traffico automatico ----
function tick() {}
function startBackground(after) {}

module.exports = { BASE, getJson, buildCatalog, ensureCatalog, fetchPage, pagesFor, prepareStops, startBackground, tick };
