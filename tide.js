// MAREA A VENEZIA — livello attuale, tendenza e prossime alte/basse maree.
// Fonte: Istituzione Centro Previsioni e Segnalazioni Maree (CPSM), Comune di Venezia, open data (licenza CC BY).
// Dataset: "CPSM: dati meteomarini laguna e litorale veneziano" su dati.venezia.it
//   livello.json   livello in metri ogni 5 minuti (ritardo ~3 min) per 13 stazioni; ORA SOLARE (UTC+1); -999 = dato mancante
//   previsione.json estremi (alte/basse) previsti, in cm, riferiti a Punta Salute
// RISERVA: ISPRA – Servizio Laguna di Venezia, rete mareografica RMLV (www.venezia.isprambiente.it/dati/Dati2.xml, ultimo valore di
//   ogni stazione, in cm sullo ZMPS, ORA SOLARE). Si usa per il livello quando il portale del Comune non risponde o è fermo: dal 26/11/2026
//   il firewall del Comune respinge le richieste dai server cloud (Render, GitHub). Le previsioni restano solo quelle del Centro Maree.
// Stazione ufficiale per Venezia dal 2002: "Punta Salute Canal Grande" (ID 1025).
// Il livello è riferito allo zero mareografico di Punta della Salute (ZMPS).

const BASE = ['https://dati.venezia.it/sites/default/files/dataset/opendata/', 'http://dati.venezia.it/sites/default/files/dataset/opendata/'];
const HEADERS = {   // identificazione esplicita del servizio di acquisizione
  'User-Agent': 'VeneziaTPL/1.0 (+https://veneziatpl.onrender.com/)',
  'Accept': 'application/json,*/*;q=0.8', 'Accept-Language': 'it-IT,it;q=0.9'
};
const ISPRA_URL = 'https://www.venezia.isprambiente.it/dati/Dati2.xml', ISPRA_ST = { marker: '129', id: 'I129', name: 'Punta della Salute (ISPRA)' };
const SOURCES = {
  cpsm: { name: 'Centro Previsioni e Segnalazioni Maree – Comune di Venezia', license: 'CC BY', url: 'https://dati.venezia.it/?q=content/cpsm-dati-meteomarini-laguna-e-litorale-veneziano' },
  ispra: { name: 'ISPRA – Servizio Laguna di Venezia, rete mareografica RMLV', license: 'CC BY 4.0', url: 'https://www.venezia.isprambiente.it/rete-meteo-mareografica' }
};
const MAIN = { id: '1025', name: 'Punta Salute Canal Grande' }, FALLBACK = ['1045', '1029'];   // Giudecca, Misericordia
const LEVEL_TTL = 90 * 1000, FORECAST_TTL = 20 * 60 * 1000, HIST_MS = 6 * 3600 * 1000, STALE_MS = 20 * 60 * 1000;
const SOLAR = 3600 * 1000, TREND_MAX_AGE_MS = 40 * 60e3, ISPRA_STALE_MS = 35 * 60e3;   // ISPRA pubblica il file circa ogni 15 minuti   // UTC+1: tutti i dati del portale sono in ora solare

// "2026-10-23 10:30:00" (ora solare) -> millisecondi UTC
function solarToMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || '').trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - SOLAR : null;
}
// "0.79 m" -> 79 (cm); -999 / non numerico -> null
function toCm(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > -9 && n < 9 ? Math.round(n * 100) : null;
}

// Classificazione indicativa (soglie del Centro Maree, in cm sullo ZMPS)
const CATS = [
  [-Infinity, -90, 'bassa-eccezionale', 'Bassa marea eccezionale'], [-90, -50, 'bassa', 'Marea sotto i valori normali'],
  [-50, 80, 'normale', 'Marea normale'], [80, 110, 'sostenuta', 'Marea sostenuta'],
  [110, 140, 'molto-sostenuta', 'Marea molto sostenuta'], [140, Infinity, 'eccezionale', 'Marea eccezionale']
];
const categoryOf = cm => { const c = CATS.find(([lo, hi]) => cm >= lo && cm < hi); return { key: c[2], label: c[3] }; };

function parseLevels(json) {
  if (!Array.isArray(json)) return [];
  return json.map(o => ({ id: String(o.ID_stazione), name: o.stazione, cm: toCm(o.valore), ts: solarToMs(o.data) })).filter(s => s.ts != null);
}

// ISPRA Dati2.xml -> { id, name, cm, ts, src: 'ispra' } della stazione di Punta della Salute (marea), oppure null.
// "27/11/2026 08:55:00" in ora solare; se l'istante risultasse nel futuro (eventuale ora legale) si toglie un'ora.
function parseIspra(xml, now = Date.now()) {
  const m = new RegExp(`<marker\\s+id\\s*=\\s*"${ISPRA_ST.marker}"[^>]*>([\\s\\S]*?)</marker>`).exec(String(xml || ''));
  if (!m) return null;
  const ins = /<instrument[^>]*type\s*=\s*"Marea"[^>]*>\s*<value\s+datetime\s*=\s*"(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?"\s*>\s*(-?\d+(?:[.,]\d+)?)\s*<\/value>/.exec(m[1]);
  if (!ins) return null;
  let ts = Date.UTC(+ins[3], +ins[2] - 1, +ins[1], +ins[4], +ins[5], +(ins[6] || 0)) - SOLAR;
  if (ts > now + 10 * 60e3) ts -= 3600e3;
  const cm = Math.round(parseFloat(ins[7].replace(',', '.')));
  if (!Number.isFinite(cm) || cm <= -400 || cm >= 500 || ts > now + 10 * 60e3) return null;
  return { id: ISPRA_ST.id, name: ISPRA_ST.name, cm, ts, src: 'ispra' };
}
async function getIspra() {
  const res = await fetch(ISPRA_URL, { headers: HEADERS, signal: AbortSignal.timeout(10000), redirect: 'follow' });
  if (!res.ok) throw new Error(`ISPRA: HTTP ${res.status}`);
  const txt = await res.text(); if (txt.length > 2e6) throw new Error('ISPRA: risposta troppo grande');
  const p = parseIspra(txt); if (!p) throw new Error('ISPRA: Punta della Salute non trovata');
  return p;
}

// Tendenza: pendenza (cm/h) della retta ai minimi quadrati sulle letture degli ultimi 45 min (servono >= 3 punti e >= 15 min di storia)
function trendOf(hist) {
  if (!hist.length) return null;
  const last = hist[hist.length - 1], pts = hist.filter(p => p.t >= last.t - 45 * 60e3);
  if (pts.length < 3 || last.t - pts[0].t < 15 * 60e3) return null;
  const n = pts.length, mx = pts.reduce((a, p) => a + p.t, 0) / n, my = pts.reduce((a, p) => a + p.cm, 0) / n;
  let num = 0, den = 0; for (const p of pts) { num += (p.t - mx) * (p.cm - my); den += (p.t - mx) ** 2; }
  const rate = den ? (num / den) * 3600e3 : 0;
  return { dir: rate >= 3 ? 'up' : rate <= -3 ? 'down' : 'steady', rate: Math.round(rate * 10) / 10, basis: 'osservato' };
}

// Estremi previsti. Il formato non è garantito: si cerca il primo elenco di oggetti e si riconoscono i campi per nome
// (valore/livello in cm; tipo max|min; istante = data-ora completa oppure "ora" HH:MM con la data dedotta dall'emissione).
function parseForecast(json) {
  let arr = Array.isArray(json) ? json : null;
  if (!arr && json && typeof json === 'object') {
    const st = [json];
    while (st.length) { const o = st.pop(); if (Array.isArray(o) && o.length && o[0] && typeof o[0] === 'object') { arr = o; break; } if (o && typeof o === 'object') st.push(...Object.values(o)); }
  }
  if (!arr) return [];
  const pick = (o, re) => { const k = Object.keys(o).find(k => re.test(k)); return k === undefined ? undefined : o[k]; };
  const out = []; let prevTs = null;
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const cm = parseFloat(String(pick(o, /^(valore|value|livello|altezza|cm)$/i) ?? '').replace(',', '.'));
    const typ = String(pick(o, /^(tipo|tipo_?estremale|type|estremale|estremo)$/i) ?? '').toLowerCase(), type = /max|alt/.test(typ) ? 'max' : /min|bass/.test(typ) ? 'min' : null;
    const issued = solarToMs(pick(o, /emissione|data_?previsione/i));
    let ts = solarToMs(pick(o, /^(data_?ora|data_?estremale|datetime|istante|timestamp)$/i));
    if (ts == null) {
      const hm = /^(\d{1,2}):(\d{2})/.exec(String(pick(o, /^ora$/i) ?? ''));
      if (hm && issued != null) {
        const day0 = Math.floor((issued + SOLAR) / 864e5) * 864e5 - SOLAR;       // mezzanotte (solare) del giorno di emissione
        ts = day0 + (+hm[1] * 3600 + +hm[2] * 60) * 1000;
        if (prevTs != null) { while (ts < prevTs) ts += 864e5; } else if (ts < issued - 3600e3) ts += 864e5;   // elenco cronologico: passaggio di giorno
      }
    }
    if (!Number.isFinite(cm) || !type || ts == null) continue;
    out.push({ type, cm: Math.round(cm), ts }); prevTs = ts;
  }
  return out;
}


// CURVA PREVISTA: il portale dà solo gli estremi (alte/basse maree). Fra due estremi consecutivi la marea segue con buona approssimazione una
// mezza cosinusoide (semplice e standard); fino al primo estremo futuro si parte dal livello misurato adesso. La differenza fra il livello misurato
// e quello che il modello darebbe ora (effetto di vento e pressione) si porta avanti smorzandola in ~3 ore. Oltre l'ultimo estremo noto la curva si ferma.
const STEP_MS = 10 * 60e3, AHEAD_MS = 18 * 3600e3, DECAY_MS = 3 * 3600e3;
function buildCurve(extremes, hist, now) {
  const ex = extremes.filter(e => e.ts > now - 12 * 3600e3).sort((a, b) => a.ts - b.ts), last = hist[hist.length - 1];
  const nowCm = last && now - last.t < 30 * 60e3 ? last.cm : null;
  const pts = ex.slice(); if (!pts.length) return [];
  const cos = (a, b, f) => (a.cm + b.cm) / 2 + (a.cm - b.cm) / 2 * Math.cos(Math.PI * f);
  const model = (t, anchor) => {
    for (let i = 0; i < pts.length - 1; i++) if (t >= pts[i].ts && t <= pts[i + 1].ts) return cos(pts[i], pts[i + 1], (t - pts[i].ts) / (pts[i + 1].ts - pts[i].ts));
    if (anchor && t >= anchor.ts && t <= pts[0].ts) return cos(anchor, pts[0], (t - anchor.ts) / (pts[0].ts - anchor.ts));
    return null;
  };
  const anchor = nowCm != null ? { ts: now, cm: nowCm } : null;
  const hasPrev = pts.some(e => e.ts <= now);
  const m0 = model(now, hasPrev ? null : anchor), delta = nowCm != null && m0 != null && hasPrev ? nowCm - m0 : 0;
  const out = [];
  for (let t = now; t <= now + AHEAD_MS; t += STEP_MS) {
    const m = model(t, hasPrev ? null : anchor); if (m == null) break;
    out.push([t, Math.round(m + delta * Math.exp(-(t - now) / DECAY_MS))]);
  }
  return out;
}

const S = { level: null, levelAt: 0, hist: [], forecast: [], forecastAt: 0, err: null, cpsmErr: null, ispraErr: null, raw: null };

// FONTE BLOCCATA: dal 26/11/2026 il portale (dietro il firewall Imperva del Comune) risponde HTTP 403 alle richieste dai server cloud
// (Render, GitHub Actions). Su 403/429 non si insiste: pausa crescente (5, 10, 20, poi 30 min) e niente secondo tentativo in http://,
// così il server non peggiora la propria reputazione presso il firewall e non spreca rete. Il blocco non va aggirato.
const BLOCK_MIN_MS = 5 * 60e3, BLOCK_MAX_MS = 30 * 60e3;
const B = { until: 0, wait: 0, status: null, since: null };
async function getJson(name) {
  if (Date.now() < B.until) throw new Error(`${name}: fonte in pausa dopo HTTP ${B.status}`);
  let last = null;
  for (const b of BASE) {
    try {
      const res = await fetch(b + name, { headers: HEADERS, signal: AbortSignal.timeout(10000), redirect: 'follow' });
      if (res.status === 403 || res.status === 429) {
        B.wait = Math.min(BLOCK_MAX_MS, B.wait ? B.wait * 2 : BLOCK_MIN_MS); B.until = Date.now() + B.wait; B.status = res.status; B.since = B.since || Date.now();
        const e = new Error(`${name}: HTTP ${res.status}`); e.blocked = true; throw e;
      }
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      const j = await res.json(); B.wait = 0; B.until = 0; B.status = null; B.since = null;
      return j;
    } catch (e) { last = e; if (e.blocked) break; }
  }
  throw last;
}

let busy = null;
async function refresh(force = false) {
  const now = Date.now();
  if (busy) return busy;
  if (!force && now - S.levelAt < LEVEL_TTL) return;
  busy = (async () => {
    let st = [], cpsmErr = null;
    try { st = parseLevels(await getJson('livello.json')); } catch (e) { cpsmErr = e; }
    let pick = [MAIN.id, ...FALLBACK].map(id => st.find(s => s.id === id && s.cm != null)).find(Boolean);
    if (pick) pick = { ...pick, src: 'cpsm' };
    // Centro Maree assente o fermo: livello di riserva da ISPRA (Punta della Salute), se più recente
    if (!pick || Date.now() - pick.ts > STALE_MS) {
      try { const isp = await getIspra(); if (!pick || isp.ts > pick.ts) pick = isp; S.ispraErr = null; } catch (e) { S.ispraErr = e.message; }
    }
    try {
      if (!pick) throw new Error([cpsmErr && cpsmErr.message, S.ispraErr].filter(Boolean).join('; ') || 'livello non disponibile');
      S.level = { ...pick, others: pick.src === 'cpsm' ? st.filter(s => s.cm != null && s.id !== pick.id).map(({ id, name, cm }) => ({ id, name, cm })) : [] };
      S.levelAt = Date.now(); S.err = null; S.cpsmErr = cpsmErr ? cpsmErr.message : null;
      if (!S.hist.length || S.hist[S.hist.length - 1].t < pick.ts) S.hist.push({ t: pick.ts, cm: pick.cm });   // una lettura per istante, in ordine
      S.hist = S.hist.filter(p => p.t >= pick.ts - HIST_MS);
    } catch (e) { S.err = e.message; }
    if (Date.now() - S.forecastAt > FORECAST_TTL) {
      try { const j = await getJson('previsione.json'); S.raw = Array.isArray(j) ? j.slice(0, 4) : j; S.forecast = parseForecast(j); S.forecastAt = S.forecastOkAt = Date.now(); }
      catch (e) { S.forecastAt = Date.now() - FORECAST_TTL + 120000; }      // riprova tra 2 min senza martellare il portale
    }
  })().finally(() => { busy = null; });
  return busy;
}

// Istantanea SENZA rete (per gli avvisi automatici): livello misurato e picco previsto nelle prossime ore. null se manca il dato.
function snapshot(ahead = 12 * 3600e3) {
  const lv = S.level; if (!lv) return null;
  const now = Date.now(), peaks = S.forecast.filter(f => f.type === 'max' && f.ts > now - 30 * 60e3 && f.ts < now + ahead).sort((a, b) => b.cm - a.cm);
  return { cm: lv.cm, ts: lv.ts, stale: now - lv.ts > 45 * 60e3, peak: peaks[0] ? { cm: peaks[0].cm, ts: peaks[0].ts } : null };
}

// Risposta per il client
async function getTide({ debug = false } = {}) {
  await refresh();
  if (!S.level) { const e = new Error(S.err || 'dati di marea non disponibili'); e.code = 503; throw e; }
  const now = Date.now(), lv = S.level, cm = lv.cm;
  const next = S.forecast.filter(f => f.ts > now - 5 * 60e3).slice(0, 4);
  const old = now - lv.ts > TREND_MAX_AGE_MS;                         // dato vecchio: la tendenza «osservata» di allora non vale più
  let trend = old ? null : trendOf(S.hist);
  if (!trend && next.length) trend = { dir: next[0].type === 'max' ? 'up' : 'down', rate: null, basis: 'previsione' };   // senza storia: direzione dal prossimo estremo
  const out = {
    station: lv.name, cm, ts: lv.ts, ageMin: Math.max(0, Math.round((now - lv.ts) / 60000)), stale: now - lv.ts > (lv.src === 'ispra' ? ISPRA_STALE_MS : STALE_MS),
    category: categoryOf(cm), trend,
    // stato della fonte (senza dettagli tecnici): il client spiega perché il dato è vecchio
    fonte: S.err ? { ok: false, motivo: B.status ? 'bloccata' : 'non disponibile', da: B.since } : { ok: true, riserva: lv.src === 'ispra' }, next: next.map(n => ({ ...n, cat: categoryOf(n.cm).key })),
    history: S.hist.map(p => [p.t, p.cm]),
    // grafico: 6 ore osservate (storia raccolta dal server) + 18 ore previste (curva ricavata dagli estremi previsti)
    chart: { from: now - HIST_MS, to: now + AHEAD_MS, now, observed: S.hist.map(p => [p.t, p.cm]), forecast: buildCurve(S.forecast, S.hist, now),
      extremes: S.forecast.filter(f => f.ts > now - HIST_MS && f.ts < now + AHEAD_MS).map(f => ({ type: f.type, cm: f.cm, ts: f.ts })) },
    source: SOURCES[lv.src] || SOURCES.cpsm,
    forecastSource: SOURCES.cpsm, forecastAgeMin: S.forecastOkAt ? Math.round((now - S.forecastOkAt) / 60000) : null
  };
  if (debug) out.debug = { forecastParsed: S.forecast.length, rawSample: S.raw, error: S.err, cpsm: S.cpsmErr, ispra: S.ispraErr, pausa: B.until > now ? Math.round((B.until - now) / 1000) : 0 };
  return out;
}

// Storia recuperata dall'archivio (marea-archivio.js) unita a quella raccolta: un punto per istante, ultime 6 ore, in ordine di tempo
function mergeHist(points, now = Date.now()) {
  const by = new Map();
  for (const p of [...points, ...S.hist]) if (p && Number.isFinite(p.t) && Number.isFinite(p.cm)) by.set(p.t, { t: p.t, cm: p.cm });
  const all = [...by.values()].sort((a, b) => a.t - b.t), last = all.length ? all[all.length - 1].t : now;
  S.hist = all.filter(p => p.t >= Math.min(now, last) - HIST_MS);
  return S.hist.length;
}
// Raccolta periodica: serve a costruire la storia da cui si ricava la tendenza anche senza utenti collegati.
// archivio: { repo } = all'avvio si recuperano le ultime ore dal ramo «archivio-marea» (dopo un riavvio il grafico non riparte vuoto).
function start({ archivio = null } = {}) {
  if (archivio?.repo) {
    const load = () => require('./marea-archivio').restore({ repo: archivio.repo }).then(p => { if (p.length) mergeHist(p); return p.length; }).catch(() => 0);
    load().then(n => { if (!n) setTimeout(load, 5 * 60e3).unref?.(); });   // archivio non raggiungibile: un altro tentativo tra 5 minuti
  }
  refresh(true).catch(() => {}); setInterval(() => refresh(true).catch(() => {}), 150000).unref?.();
}
module.exports = { _B: B, parseIspra, getIspra, SOURCES, snapshot, buildCurve, getTide, start, mergeHist, getJson, parseLevels, parseForecast, trendOf, categoryOf, solarToMs, toCm, _S: S };
