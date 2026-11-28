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

const {withReserve,enabled:hubEnabled}=require('./hub-reserve');
const {readHistory}=require('./hub-history');
const {forecastTime,selectForecast}=require('./forecast-contract');
const BASE = 'https://dati.venezia.it/sites/default/files/dataset/opendata/';
const { cpsmGate, createSourceGate } = require('./cpsm-access');
const WEB_FORECAST=require('./cpsm-web-forecast');
const readWebForecast=WEB_FORECAST.createWebForecastReader({gate:createSourceGate({gapMs:process.env.NODE_TEST_CONTEXT?0:10000,enabled:()=>process.env.CPSM_OFFICIAL_FILES_ENABLED!=='false'}),userAgent:'VeneziaTPL/1.0 (+https://veneziatpl.onrender.com/about-data.html)'});
const HEADERS = {   // identificazione esplicita del servizio di acquisizione
  'User-Agent': 'VeneziaTPL/1.0 (+https://veneziatpl.onrender.com/about-data.html)',
  'Accept': 'application/json,*/*;q=0.8', 'Accept-Language': 'it-IT,it;q=0.9'
};
const ISPRA_URL = 'https://www.venezia.isprambiente.it/dati/Dati2.xml', ISPRA_ST = { marker: '129', id: 'I129', name: 'Punta della Salute (ISPRA)' };
const SOURCES = {
  cpsm: { name: 'Centro Previsioni e Segnalazioni Maree – Comune di Venezia', license: 'CC BY', url: 'https://dati.venezia.it/?q=content/cpsm-dati-meteomarini-laguna-e-litorale-veneziano' },
  cpsmWeb: {name:'Centro Maree · bollettino web (riserva)',license:'CC BY-NC-SA 3.0 IT',licenseUrl:WEB_FORECAST.LICENSE_URL,url:WEB_FORECAST.URL},
  ispra: { name: 'ISPRA – Servizio Laguna di Venezia, rete mareografica RMLV', license: 'CC BY 4.0', url: 'https://www.venezia.isprambiente.it/rete-meteo-mareografica' }
};
const MAIN = { id: '1025', name: 'Punta Salute Canal Grande' }, FALLBACK = ['1045', '1029'];   // Giudecca, Misericordia
const LEVEL_TTL = 90 * 1000, FORECAST_TTL = 20 * 60 * 1000, HIST_MS = 6 * 3600 * 1000, STALE_MS = 20 * 60 * 1000;
const SOLAR = 3600 * 1000, TREND_MAX_AGE_MS = 40 * 60e3, ISPRA_STALE_MS = 35 * 60e3;   // ISPRA pubblica il file circa ogni 15 minuti   // UTC+1: tutti i dati del portale sono in ora solare

// "2026-10-23 10:30:00" (ora solare) -> millisecondi UTC
function solarToMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || '').trim());
  if (!m) return null;
  const [y,mo,d,h,mi,se] = m.slice(1).map(Number);
  const local = Date.UTC(y, mo-1, d, h, mi, se || 0), check = new Date(local);
  if (!Number.isFinite(local) || check.getUTCFullYear()!==y || check.getUTCMonth()!==mo-1 || check.getUTCDate()!==d || check.getUTCHours()!==h || check.getUTCMinutes()!==mi || check.getUTCSeconds()!==(se||0)) return null;
  return local-SOLAR;
}
// "0.79 m" -> 79 (cm); -999 / non numerico -> null
function toCm(v) {
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*m?\s*$/i.exec(String(v ?? ''));
  const n = m ? Number(m[1].replace(',','.')) : NaN;
  return Number.isFinite(n) && Math.abs(n)<=3 ? Math.round(n*100) : null;
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
  return json.filter(o=>o && typeof o==='object').map(o => ({ id: String(o.ID_stazione), name: o.stazione, cm: toCm(o.valore), ts: solarToMs(o.data) })).filter(s => s.ts != null);
}

// Select the latest valid observation per station; prefer the reference station.
function selectCpsmLevel(rows, now=Date.now()) {
  const valid=rows.filter(s=>s.cm!=null && s.ts<=now+5*60e3 && s.ts>=now-STALE_MS);
  for(const id of [MAIN.id,...FALLBACK]) {
    const newest=valid.filter(s=>s.id===id).sort((a,b)=>b.ts-a.ts)[0];
    if(newest)return {...newest,src:'cpsm'};
  }
  return null;
}
async function boundedText(res, max) {
  if(Number(res.headers?.get?.('content-length'))>max){try{await res.body?.cancel();}catch{} throw new Error('Risposta oltre il limite');}
  // Real fetch responses have a stream. The text-only branch supports injected test fixtures.
  if(!res.body){const text=await res.text();if(Buffer.byteLength(text)>max)throw new Error('Risposta oltre il limite');return text;}
  const reader=res.body.getReader(), chunks=[];let size=0,complete=false;
  try { for(;;){const {done,value}=await reader.read();if(done){complete=true;break;}size+=value.byteLength;if(size>max)throw new Error('Risposta oltre il limite');chunks.push(value);} }
  finally {if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks,size).toString('utf8');
}
// ISPRA Dati2.xml -> { id, name, cm, ts, src: 'ispra' } della stazione di Punta della Salute (marea), oppure null.
// ISPRA measurements use fixed solar time, as in Intranet-BIS. Never shift future timestamps.
function parseIspra(xml, now = Date.now()) {
  const m = new RegExp(`<marker\\s+id\\s*=\\s*"${ISPRA_ST.marker}"[^>]*>([\\s\\S]*?)</marker>`).exec(String(xml || ''));
  if (!m) return null;
  const ins = /<instrument[^>]*type\s*=\s*"Marea"[^>]*>\s*<value\s+datetime\s*=\s*"(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?"\s*>\s*(-?\d+(?:[.,]\d+)?)\s*<\/value>/.exec(m[1]);
  if (!ins) return null;
  const ts=solarToMs(ins[3]+'-'+ins[2]+'-'+ins[1]+' '+ins[4]+':'+ins[5]+':'+(ins[6]||'00'));
  const cm = Number(ins[7].replace(',', '.'));
  if (ts==null||!Number.isFinite(cm)||Math.abs(cm)>300||ts>now+5*60e3)return null;
  return { id: ISPRA_ST.id, name: ISPRA_ST.name, cm:Math.round(cm), ts, src: 'ispra' };
}
async function getIspra() {
  const res = await fetch(ISPRA_URL, { headers: HEADERS, signal: AbortSignal.timeout(10000), redirect: 'follow' });
  if (!res.ok) {try{await res.body?.cancel();}catch{} throw new Error(`ISPRA: HTTP ${res.status}`);}
  const txt = await boundedText(res, 2_000_000);
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
function parseForecast(json,now=Date.now()) {
  // The documented CPSM schema uses Italian civil time, not solar time.
  if(Array.isArray(json)&&json.some(r=>r&&Object.hasOwn(r,'DATA_PREVISIONE')&&Object.hasOwn(r,'DATA_ESTREMALE'))){try{return selectForecast(json,now).points;}catch{return [];}}
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
    if (!Number.isFinite(cm) || Math.abs(cm)>300 || !type || ts == null) continue;
    out.push({ type, cm: Math.round(cm), ts }); prevTs = ts;
  }
  return [...new Map(out.map(p=>[p.ts,p])).values()].sort((a,b)=>a.ts-b.ts);
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
const B = cpsmGate.state;
const validators = new Map();
async function getJson(name) {
  return cpsmGate.run(async check => {
    const prior=validators.get(name);
    const headers={...HEADERS,...(prior?.etag?{'If-None-Match':prior.etag}:{}),...(prior?.modified?{'If-Modified-Since':prior.modified}:{})};
    const res=await check(await fetch(BASE + name,{headers,signal:AbortSignal.timeout(10000),redirect:'error'}));
    if(res.status===304 && prior)return prior.rows;
    if(!res.ok){try{await res.body?.cancel();}catch{} throw new Error(name+': HTTP '+res.status);}
    const rows=JSON.parse(await boundedText(res,1_000_000));
    if(!Array.isArray(rows))throw new Error(name+': JSON non valido');
    validators.set(name,{rows,etag:res.headers?.get?.('etag'),modified:res.headers?.get?.('last-modified')});
    return rows;
  },0);
}

let busy = null;
async function refresh(force = false) {
  const now = Date.now();
  if (busy) return busy;
  if (!force && now - S.levelAt < LEVEL_TTL) return;
  busy = (async () => {
    let st = [], cpsmErr = null;
    try { st = await withReserve(async()=>{const rows=await getJson('livello.json'), parsed=parseLevels(rows);if(hubEnabled()&&!selectCpsmLevel(parsed))throw Error('Misura CPSM non recente');return parsed;},BASE+'livello.json',{parse:body=>{const parsed=parseLevels(JSON.parse(body));if(!selectCpsmLevel(parsed))throw Error('Misura Hub non recente');return parsed;}}); } catch (e) { cpsmErr = e; }
    let pick = selectCpsmLevel(st);
    if (!pick && !cpsmErr) cpsmErr = new Error('Misura CPSM recente non disponibile');
    // Centro Maree assente o fermo: livello di riserva da ISPRA (Punta della Salute), se più recente
    if (!pick) {
      try { const valid=isp=>{if(!isp||Date.now()-isp.ts>ISPRA_STALE_MS||isp.ts>Date.now()+5*60e3)throw Error('Misura ISPRA non recente');return isp;};pick=await withReserve(async()=>valid(await getIspra()),ISPRA_URL,{maxBytes:2000000,parse:body=>valid(parseIspra(body))}); S.ispraErr = null; } catch (e) { S.ispraErr = e.message; }
    }
    try {
      if (!pick) throw new Error([cpsmErr && cpsmErr.message, S.ispraErr].filter(Boolean).join('; ') || 'livello non disponibile');
      if(S.level && S.level.ts>pick.ts) pick=S.level;
      else S.level = { ...pick, others: pick.src === 'cpsm' ? st.filter(s => s.cm != null && s.id !== pick.id && s.ts<=Date.now()+5*60e3 && Date.now()-s.ts<=STALE_MS).map(({ id, name, cm }) => ({ id, name, cm })) : [] };
      S.levelAt = Date.now(); S.err = null; S.cpsmErr = cpsmErr ? cpsmErr.message : null;
      if (!S.hist.length || S.hist[S.hist.length - 1].t < pick.ts) S.hist.push({ t: pick.ts, cm: pick.cm });   // una lettura per istante, in ordine
      S.hist = S.hist.filter(p => p.t >= pick.ts - HIST_MS);
    } catch (e) { S.err = e.message; }
    if (Date.now() - S.forecastAt > FORECAST_TTL) {
      try {
        const validate=j=>{const points=parseForecast(j),checked=Date.now();const issue=Math.max(0,...j.map(row=>forecastTime(row?.DATA_PREVISIONE ?? row?.data_previsione ?? row?.emissione)||0));if(!points.some(p=>p.ts>checked)||(issue&&(issue>checked+5*60e3||checked-issue>72*3600e3))||(S.forecastIssue&&issue<S.forecastIssue))throw Error('Previsione ufficiale non valida o precedente');return {j,points,checked,issue};};
        const {j,points,checked,issue}=await withReserve(async()=>validate(await getJson('previsione.json')),BASE+'previsione.json',{parse:body=>validate(JSON.parse(body))});
        S.raw=j.slice(0,4);S.forecast=points;S.forecastAt=checked;S.forecastOrigin='json';
        if(issue){S.forecastIssue=issue;S.forecastOkAt=issue;} else if(!S.forecastOkAt)S.forecastOkAt=checked;
      }
      catch (e) {
        try {
          const web=await readWebForecast();
          if(S.forecastIssue && web.issue<S.forecastIssue)throw Error('Bollettino web precedente');
          S.forecast=web.rows.map(row=>({type:row.TIPO_ESTREMALE,cm:row.VALORE,ts:Date.parse(row.DATA_ESTREMALE)}));
          S.forecastIssue=S.forecastOkAt=web.issue;S.forecastOrigin='web';
        } catch { /* conserve the last valid official bulletin */ }
        // Keep checking the primary; the web reader has its own five-minute cache.
        S.forecastAt=Date.now()-FORECAST_TTL+120000;
      }
    }
  })().finally(() => { busy = null; });
  return busy;
}

// Istantanea SENZA rete (per gli avvisi automatici): livello misurato e picco previsto nelle prossime ore. null se manca il dato.
function snapshot(ahead = 12 * 3600e3) {
  const lv = S.level; if (!lv) return null;
  const now = Date.now(), peaks = validForecast(now).filter(f => f.type === 'max' && f.ts > now - 30 * 60e3 && f.ts < now + ahead).sort((a, b) => b.cm - a.cm);
  return { cm: lv.cm, ts: lv.ts, stale: now - lv.ts > 45 * 60e3, peak: peaks[0] ? { cm: peaks[0].cm, ts: peaks[0].ts } : null };
}

function validForecast(now) { return S.forecastOkAt && now-S.forecastOkAt<=72*3600e3 && now-S.forecastOkAt>=-5*60e3 ? S.forecast : []; }

// Risposta per il client
async function getTide({ debug = false } = {}) {
  await refresh();
  if (!S.level) { const e = new Error(S.err || 'dati di marea non disponibili'); e.code = 503; throw e; }
  const now = Date.now(), lv = S.level, cm = lv.cm;
  const forecast=validForecast(now);
  const next = forecast.filter(f => f.ts > now - 5 * 60e3).slice(0, 4);
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
    chart: { from: now - HIST_MS, to: now + AHEAD_MS, now, observed: S.hist.map(p => [p.t, p.cm]), forecast: buildCurve(forecast, S.hist, now),
      extremes: forecast.filter(f => f.ts > now - HIST_MS && f.ts < now + AHEAD_MS).map(f => ({ type: f.type, cm: f.cm, ts: f.ts })) },
    source: SOURCES[lv.src] || SOURCES.cpsm, restored: Boolean(lv.restored),
    forecastSource: S.forecastOrigin==='web' ? SOURCES.cpsmWeb : SOURCES.cpsm, forecastAgeMin: S.forecastOkAt ? Math.round((now - S.forecastOkAt) / 60000) : null
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
// Restore a real observation with its original provenance; never present it as a new HTTP reading.
function restoreArchivedLevel(points, now=Date.now()) {
  mergeHist(points,now);
  if(!S.level){
    const p=points.filter(p=>Number.isFinite(p.t)&&Number.isFinite(p.cm)&&p.t<=now+300e3&&p.t>=now-HIST_MS&&((p.f==='cpsm'&&[MAIN.id,...FALLBACK].includes(p.st))||(p.f==='ispra'&&p.st===ISPRA_ST.id))).sort((a,b)=>b.t-a.t)[0];
    if(p){S.level={id:p.st,name:p.f==='ispra'?ISPRA_ST.name:p.st===MAIN.id?MAIN.name:'Stazione CPSM '+p.st,cm:p.cm,ts:p.t,src:p.f,others:[],restored:true};S.err='Misura archiviata; aggiornamento in attesa';}
  }
  return S.hist.length;
}
let hubHistoryFlight=null,hubHistoryAt=0;
function recoverHubHistory(now=Date.now()){
 if(!hubEnabled()||hubHistoryFlight||now-hubHistoryAt<15*60000)return hubHistoryFlight;
 hubHistoryAt=now;
 hubHistoryFlight=(async()=>{
  const points=new Map();
  for(const key of ['livello','cpsm-table','ispra-level']){
   try{await readHistory(key,now-HIST_MS,now,{onPage:items=>{for(const x of items){const cm=x.data.cm;if(!Number.isFinite(cm)||Math.abs(cm)>300)continue;const rank=key==='livello'?[MAIN.id,...FALLBACK].indexOf(x.station):key==='cpsm-table'?3:x.station===ISPRA_ST.id?4:-1;if(rank<0)continue;const old=points.get(x.timestamp);if(!old||rank<old.rank)points.set(x.timestamp,{t:x.timestamp,cm,rank});}}});}catch{}
  }
  mergeHist([...points.values()],Date.now());
 })().finally(()=>{hubHistoryFlight=null;});return hubHistoryFlight;
}
// Raccolta periodica: serve a costruire la storia da cui si ricava la tendenza anche senza utenti collegati.
// archivio: { repo } = all'avvio si recuperano le ultime ore dal ramo «archivio-marea» (dopo un riavvio il grafico non riparte vuoto).
function start({ archivio = null } = {}) {
  if (archivio?.repo) {
    const load = () => require('./marea-archivio').restore({ repo: archivio.repo, withSource:true }).then(p => { if (p.length) restoreArchivedLevel(p); return p.length; }).catch(() => 0);
    load().then(n => { if (!n) setTimeout(load, 5 * 60e3).unref?.(); });   // archivio non raggiungibile: un altro tentativo tra 5 minuti
  }
  const run=()=>{refresh(true).catch(()=>{});void recoverHubHistory()?.catch(()=>{});};run();setInterval(run,150000).unref?.();
}
module.exports = { restoreArchivedLevel, selectCpsmLevel, _B: B, parseIspra, getIspra, SOURCES, snapshot, buildCurve, getTide, start, mergeHist, getJson, parseLevels, parseForecast, trendOf, categoryOf, solarToMs, toCm, _S: S };
