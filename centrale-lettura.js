// CENTRALE ACTV — lettura sicura tramite Playwright (Browser Umano On-Demand)
const { chromium } = require('playwright');
const { equivalentStops } = require('./stopgroups');
const { C, st, lineOf, fresh, SRC } = require('./centrale-stato');

const BASE = (process.env.ACTV_CENTRALE_URL || 'https://oraritemporeale.actv.it').replace(/\/+$/, '');
const sleep = ms => new Promise(ok => setTimeout(ok, ms).unref?.());

// ---- Gestione dell'istanza Browser On-Demand ----
let browserInstance = null;
let contextInstance = null;

async function getBrowserContext() {
  if (!browserInstance) {
    // Avvia il browser in background (headless) ma con firme identiche a un browser reale
    browserInstance = await chromium.launch({ 
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    });
    contextInstance = await browserInstance.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'it-IT',
      viewport: { width: 1280, height: 800 }
    });
  }
  return contextInstance;
}

// ---- Funzione di recupero JSON tramite Browser Reale (Superamento Imperva) ----
async function getJson(path) {
  const s = st.stat;
  if (Date.now() < s.pausaFino) throw new Error('pausa dopo errori ripetuti');

  let page = null;
  try {
    const context = await getBrowserContext();
    page = await context.newPage();

    const targetUrl = BASE + path;
    
    // Navigazione gestita dal browser: risolve automaticamente i challenge JS e i cookie di Imperva
    const response = await page.goto(targetUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: C.TIMEOUT_MS 
    });

    if (!response || !response.ok()) {
      throw new Error(`HTTP error: ${response ? response.status() : 'risposta nulla'}`);
    }

    // Estrazione del JSON restituito dalla rotta backend
    let json;
    try {
      json = await response.json();
    } catch {
      // Fallback nel caso in cui il contenuto venga letto come testo HTML/JSON grezzo dalla pagina
      const textContent = await page.evaluate(() => document.body.innerText);
      json = JSON.parse(textContent);
    }

    s.letture++;
    s.erroriDiFila = 0;
    return json;

  } catch (e) {
    s.errori++;
    if (e.name === 'TimeoutError' || e.message.includes('Timeout')) s.timeout++;
    s.ultimoErrore = `${new Date().toISOString()} ${path}: ${e.message}`;
    if (++s.erroriDiFila >= C.FAIL_MAX) {
      s.pausaFino = Date.now() + C.PAUSE_MS;
      s.erroriDiFila = 0;
    }
    throw e;
  } finally {
    if (page) {
      await page.close().catch(() => {}); // Chiude la scheda ma mantiene vivo il contesto e i cookie di sessione
    }
  }
}

// ---- Catalogo fermate ----
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

// ---- Lettura pagine On-Demand (Attivazione esclusivamente su richiesta utente) ----
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

// Chiamata eseguita SOLO quando l'utente apre un pannello (fermata o corsa)
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
  } catch { /* gestito in silenzio per continuità app */ }
}

// ---- Sottofondo completamente disattivato (Zero richieste automatiche) ----
function tick() {}
function startBackground(after) {}

module.exports = { BASE, getJson, buildCatalog, ensureCatalog, fetchPage, pagesFor, prepareStops, startBackground, tick };
