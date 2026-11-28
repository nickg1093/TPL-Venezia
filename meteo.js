'use strict';
// METEO — acquisizione continua e cache RAM dell'ULTIMA osservazione di ciascun sensore (nessuno storico, nessun disco, nessuna UI).
// Un ciclo indipendente per ogni feed (5 file del Centro Maree, vePORTO, METAR): un guasto o una fonte lenta non fermano gli altri, e
// ogni misura nuova è pubblicata appena letta (nuovo timestamp = nuova misura, anche a valore invariato).
// Polling adattivo: il ciclo impara periodo di pubblicazione e ritardo della fonte e torna a controllare poco prima del dato atteso,
// poi ogni 30-60 s finché arriva (richieste condizionali ETag/Last-Modified: un controllo a vuoto costa un 304). Errori: attesa crescente.
// Le API leggono solo la cache: nessuna richiesta esterna durante una risposta.
const X = require('./meteo-parse');
const {withReserve,readHub,enabled:hubEnabled}=require('./hub-reserve');
const {EXPECTED,mergeSensors}=require('./sensor-merge');

const CPSM = 'https://dati.venezia.it/sites/default/files/dataset/opendata/';
const { cpsmGate } = require('./cpsm-access');
const USER_AGENT = 'VeneziaTPL/1.0 (+https://veneziatpl.onrender.com/about-data.html)';
const VEPORTO = 'https://veporto.it/pwa-api/v1';
const METAR = 'https://aviationweather.gov/api/data/metar?ids=LIPZ&format=json&hours=3';
const MAX_BYTES = 256000, TIMEOUT_MS = 12000;

const MIN = 60e3;
// periodo: cadenza nominale della fonte (poi stimata); veloce: controllo quando il dato è atteso; lento: tetto all'attesa; vecchio: oltre è «non aggiornato»
const FEED = [
  ...['vento', 'pressione', 'tempacqua', 'umidita', 'temparia'].map(c => ({ id: 'cpsm-' + c, fonte: 'cpsm', categorie: [c], file: c + '.json', periodo: 5 * MIN, veloce: 30e3, lento: 5 * MIN, vecchio: 25 * MIN })),
  { id: 'veporto', fonte: 'veporto', categorie: ['visibilita'], periodo: 5 * MIN, veloce: 60e3, lento: 5 * MIN, vecchio: 25 * MIN },
  { id: 'metar', fonte: 'metar', categorie: ['visibilita', 'vento', 'temparia', 'rugiada', 'umidita', 'pressione', 'metar'], periodo: 30 * MIN, veloce: 60e3, lento: 10 * MIN, vecchio: 100 * MIN }
];
const FONTI = {
  cpsm: { nome: 'Centro Previsioni e Segnalazioni Maree – Comune di Venezia (Open Data)', url: 'https://dati.venezia.it', note: 'Dati automatici non validati; orari in UTC+1 fisso.' },
  veporto: { nome: 'vePORTO – Autorità di Sistema Portuale del Mare Adriatico Settentrionale', url: 'https://veporto.it', note: 'Visibilimetri portuali.' },
  metar: { nome: 'METAR LIPZ – Venezia Tessera, aeroporto Marco Polo (NOAA Aviation Weather Center)', url: 'https://aviationweather.gov', note: 'Osservazione aeroportuale, non lagunare; umidità derivata da temperatura e rugiada.' }
};

const sensori = new Map();   // chiave fonte|categoria|idStazione -> osservazione
const stato = new Map();     // id feed -> stato del ciclo
let opz = { fetch: (...a) => fetch(...a), adesso: Date.now, veporto: false, log: (...a) => console.warn(...a) };
let avviato = false;

const nuovoStato = f => ({ id: f.id, fonte: f.fonte, inCorso: null, timer: null, etag: null, modificato: null, controlli: 0, nonModificati: 0, nuoveMisure: 0,
  errori: 0, erroriConsecutivi: 0, ultimoControllo: null, ultimoRiuscito: null, ultimoErrore: null, ultimoDatoMs: null, periodi: [], ritardi: [], prossimo: null, durataMs: null });
for (const f of FEED) stato.set(f.id, nuovoStato(f));

// ---- rete ----
async function leggi(res) {
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('risposta troppo grande');
  if (!res.body) throw new Error('risposta vuota');
  const rd = res.body.getReader(), parti = []; let n = 0, fine = false;
  try { for (;;) { const c = await rd.read(); if (c.done) { fine = true; break; } n += c.value.byteLength; if (n > MAX_BYTES) throw new Error('risposta troppo grande'); parti.push(c.value); } }
  finally { if (!fine) await rd.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(parti.map(p => Buffer.from(p)), n).toString('utf8'));
}
// GET condizionale; 304 -> null (niente di nuovo)
async function getJson(url, s, headers = {}, check = async res => res) {
  const h = { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': USER_AGENT, ...headers };
  if (s.etag) h['If-None-Match'] = s.etag;
  if (s.modificato) h['If-Modified-Since'] = s.modificato;
  const res = await check(await opz.fetch(url, { headers: h, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: url.startsWith(CPSM) ? 'error' : 'follow' }));
  if (res.status === 304) return null;
  if (!res.ok) { try { await res.body?.cancel(); } catch {} throw new Error('HTTP ' + res.status); }
  const j = await leggi(res);
  s.etag = res.headers.get('etag') || null; s.modificato = res.headers.get('last-modified') || null;
  return j;
}
async function cpsm(f, s) {
  return cpsmGate.run(check => getJson(CPSM + f.file, s, { 'Accept-Language': 'it-IT,it;q=0.9' },check),2);
}
// vePORTO: accesso anonimo della PWA pubblica (utente «imbarcazione», nessuna password); il JWT resta solo in memoria e non è mai esposto né scritto
let jwt = null, jwtScade = 0;
async function token(forza) {
  const ora = opz.adesso();
  if (!forza && jwt && jwtScade > ora + 60e3) return jwt;
  const res = await opz.fetch(VEPORTO + '/auth', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ username: 'imbarcazione', password: null }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('autenticazione HTTP ' + res.status);
  const v = (res.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) throw new Error('token mancante');
  let scade = ora + 13 * MIN;
  try { const p = JSON.parse(Buffer.from(v.split('.')[1], 'base64url').toString('utf8')); if (Number.isFinite(p.exp)) scade = Math.min(scade, p.exp * 1000 - 30e3); } catch { throw new Error('token non leggibile'); }
  if (scade <= ora) throw new Error('token già scaduto');
  jwt = v; jwtScade = scade; return jwt;
}
async function veporto(f, s) {
  let t = await token(false);
  try { return await getJson(VEPORTO + '/meteo-station?limit=1000', s, { Authorization: 'Bearer ' + t }); }
  catch (e) { if (!/HTTP 401/.test(e.message)) throw e; t = await token(true); return getJson(VEPORTO + '/meteo-station?limit=1000', s, { Authorization: 'Bearer ' + t }); }
}

// ---- cache: una voce per sensore; si sostituisce solo se cambia il timestamp (o il dato a pari timestamp: rettifica della fonte) ----
function metti(fonte, categoria, oss, ora) {
  const k = `${fonte}|${categoria}|${oss.idStazione}`, p = sensori.get(k);
  if (oss.misuratoMs == null && p) return false;
  if(p&&Number.isFinite(p.misuratoMs)&&Number.isFinite(oss.misuratoMs)&&oss.misuratoMs<p.misuratoMs&&Object.values(p.dati||{}).some(v=>typeof v==='number'&&Number.isFinite(v)))return false;                       // riga senza orario: non cancella una misura valida
  const uguale = p && p.misuratoMs === oss.misuratoMs && JSON.stringify(p.dati) === JSON.stringify(oss.dati);
  if (uguale) { p.confermatoMs = ora; return false; }
  sensori.set(k, { fonte, categoria, idStazione: oss.idStazione, stazione: oss.stazione, misuratoMs: oss.misuratoMs, acquisitoMs: ora, confermatoMs: ora, dati: oss.dati });
  return !p || p.misuratoMs !== oss.misuratoMs;
}
function registra(f, json, ora) {
  let nuove = 0, max = null;
  const add = (cat, o) => { if (o.misuratoMs != null && (max == null || o.misuratoMs > max)) max = o.misuratoMs; if (metti(f.fonte, cat, o, ora)) nuove++; };
  if (f.fonte === 'cpsm') {
    const c = f.categorie[0];
    for (const o of X.parseCpsm(c, json)) {
      const dati = c === 'vento' ? { velocita: o.velocita, raffica: o.raffica, direzione: o.direzione, calmo: o.calmo, variabile: o.variabile } : { valore: o.valore };
      add(c, { idStazione: o.idStazione, stazione: o.stazione, misuratoMs: o.misuratoMs, dati });
    }
  } else if (f.fonte === 'veporto') {
    for (const o of X.parseVeporto(json)) add('visibilita', { idStazione: o.idStazione, stazione: o.stazione, misuratoMs: o.misuratoMs, dati: { valore: o.valore, limite: null } });
  } else {
    const m = X.parseMetar(json, ora); if (!m) throw new Error('nessuna osservazione LIPZ valida');
    const b = { idStazione: 'LIPZ', stazione: 'Aeroporto Marco Polo', misuratoMs: m.misuratoMs };
    add('metar', { ...b, dati: { codice: m.codice, fenomeni: m.fenomeni, nubi: m.nubi, cavok: m.cavok } });
    add('visibilita', { ...b, dati: m.visibilita ? { valore: m.visibilita.valore, limite: m.visibilita.limite, codice: m.visibilita.codice } : { valore: null, limite: null } });
    add('vento', { ...b, dati: m.vento ? { velocita: m.vento.velocita, raffica: m.vento.raffica, direzione: m.vento.direzione, calmo: m.vento.calmo, variabile: m.vento.variabile, variazione: m.vento.variazione } : { velocita: null, raffica: null, direzione: null, calmo: false, variabile: false } });
    add('temparia', { ...b, dati: { valore: m.temperatura } });
    add('rugiada', { ...b, dati: { valore: m.rugiada } });
    add('umidita', { ...b, dati: { valore: m.umidita, derivato: true } });
    add('pressione', { ...b, dati: { valore: m.qnh, tipo: 'QNH' } });
  }
  return { nuove, max };
}
const mediana = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
// prossimo controllo: poco prima del dato atteso (ultimo dato + periodo stimato + ritardo di pubblicazione stimato), poi «veloce» finché arriva
function attesa(f, s, ora) {
  if (s.erroriConsecutivi) return Math.min(10 * MIN, f.veloce * 2 ** Math.min(s.erroriConsecutivi, 5)) * (0.85 + Math.random() * 0.3);
  if (s.ultimoDatoMs == null) return f.veloce;
  const periodo = mediana(s.periodi) || f.periodo, ritardo = mediana(s.ritardi) ?? 60e3;
  const atteso = s.ultimoDatoMs + periodo + ritardo, mancano = atteso - ora;
  if (mancano > f.veloce) return Math.min(f.lento, mancano - f.veloce / 2);
  if (-mancano > 3 * periodo) return f.lento;   // la fonte si è fermata: si controlla di rado, senza martellare
  return f.veloce;
}
async function controlla(f) {
  const s = stato.get(f.id);
  if (s.inCorso) return s.inCorso;                                    // mai due richieste sovrapposte sullo stesso feed
  s.inCorso = (async () => {
    const t0 = opz.adesso(); s.controlli++; s.ultimoControllo = t0;
    try {
      const direct=()=>f.fonte==='cpsm'?cpsm(f,s):f.fonte==='veporto'?veporto(f,s):getJson(METAR,s,{'User-Agent':USER_AGENT});
      const url=f.fonte==='cpsm'?CPSM+f.file:f.fonte==='veporto'?VEPORTO+'/meteo-station?limit=1000':METAR;
      const validate=(j,allow304)=>{if(j===null&&allow304&&s.ultimoDatoMs!=null&&opz.adesso()-s.ultimoDatoMs<=f.vecchio)return j;if(!Array.isArray(j))throw Error('Misura non disponibile');const now=opz.adesso();if(f.fonte==='metar'){const p=X.parseMetar(j,now);if(p&&p.misuratoMs<=now+300000&&now-p.misuratoMs<=f.vecchio)return j;}else{const rows=f.fonte==='cpsm'?X.parseCpsm(f.categorie[0],j):X.parseVeporto(j);if(rows.some(p=>p.valore!==null&&Number.isFinite(p.misuratoMs)&&p.misuratoMs<=now+300000&&now-p.misuratoMs<=f.vecchio))return j;}throw Error('Misura non recente');};
      let j=await withReserve(async()=>{const j=await direct();if(Array.isArray(j))s.directRows=j;return hubEnabled()?validate(j,true):j;},url,{fetchFn:opz.fetch,maxBytes:MAX_BYTES,now:opz.adesso(),parse:body=>validate(JSON.parse(body),false)});
      if(hubEnabled()&&f.fonte!=='metar'){
        const key=f.fonte==='veporto'?'veporto':f.categorie[0],now=opz.adesso();
        const inspect=row=>{if(key==='veporto'){const id=String(row?.nome||'').trim().toUpperCase().replace(/[’‘]/g,"'");if(!EXPECTED.veporto.includes(id))return null;const p=X.parseVeporto([row]).find(x=>x.idStazione===id);return {id,stamp:p?.misuratoMs,valid:Number.isFinite(p?.valore)};}const p=X.parseCpsm(key,[row])[0];return p?{id:p.idStazione,stamp:p.misuratoMs,valid:Number.isFinite(p.valore)}:null;};
        const original=j===null?s.directRows||[]:j;
        if(mergeSensors(original,[],inspect,EXPECTED[key],now,f.vecchio).missing.length&&now-(s.hubPartialAt||0)>=60000){
          s.hubPartialAt=now;try{const reserve=await readHub(url,{fetchFn:opz.fetch,maxBytes:MAX_BYTES,now});const merged=mergeSensors(original,reserve,inspect,EXPECTED[key],now,f.vecchio);if(merged.filled.length)j=merged.rows;}catch{}
        }
      }
      const ora = opz.adesso();
      if (j === null) s.nonModificati++;
      else {
        const { nuove, max } = registra(f, j, ora);
        s.nuoveMisure += nuove;
        if (max != null && (s.ultimoDatoMs == null || max > s.ultimoDatoMs)) {
          if (s.ultimoDatoMs != null) { s.periodi.push(max - s.ultimoDatoMs); s.periodi = s.periodi.slice(-8); }
          s.ritardi.push(Math.max(0, ora - max)); s.ritardi = s.ritardi.slice(-8);
          s.ultimoDatoMs = max;
        }
      }
      s.ultimoRiuscito = ora; s.erroriConsecutivi = 0; s.ultimoErrore = null;
    } catch (e) {
      s.errori++; s.erroriConsecutivi++; s.ultimoErrore = String(e && e.message || e).slice(0, 120);
      if (s.erroriConsecutivi === 1 || s.erroriConsecutivi % 10 === 0) opz.log(`meteo ${f.id}: ${s.ultimoErrore}`);
    } finally { s.durataMs = opz.adesso() - t0; }
  })().finally(() => { s.inCorso = null; });
  return s.inCorso;
}
function pianifica(f) {
  const s = stato.get(f.id);
  const giro = async () => { s.timer = null; await controlla(f); if (!avviato) return; const d = Math.round(Math.max(attesa(f, s, opz.adesso()), f.fonte === 'cpsm' ? Math.max(60000, Math.min(600000, cpsmGate.state.until - Date.now())) : 0)); s.prossimo = opz.adesso() + d; s.timer = setTimeout(giro, d); s.timer.unref?.(); };
  return giro();
}
const attivi = () => FEED.filter(f => f.fonte !== 'veporto' || opz.veporto);
// avvio: tutti i feed subito e in parallelo; la cache si ricostruisce da sola dopo un riavvio (al primo giro)
function start(o = {}) {
  opz = { ...opz, veporto: process.env.VEPORTO_ENABLED === 'true', ...o };
  if (avviato) return; avviato = true;
  for (const f of attivi()) pianifica(f).catch(() => {});
}
function stop() { avviato = false; for (const s of stato.values()) { clearTimeout(s.timer); s.timer = null; } }

// ---- uscita (solo cache) ----
const fmtOra = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const NOME_FONTE = { cpsm: 'Centro Maree', veporto: 'vePORTO', metar: 'METAR LIPZ' };
function voce(x, ora) {
  const f = FEED.find(z => z.fonte === x.fonte), eta = x.misuratoMs != null ? Math.round((ora - x.misuratoMs) / 1000) : null;
  const futuro = eta != null && eta < -300, fresco = eta != null && !futuro && eta * 1000 <= f.vecchio;
  const d = x.dati, ventoCat = x.categoria === 'vento';
  const valore = ventoCat ? d.velocita : x.categoria === 'metar' ? null : d.valore;
  const o = { stazione: x.stazione, idStazione: x.idStazione, fonte: NOME_FONTE[x.fonte], codiceFonte: x.fonte, categoria: x.categoria };
  if (ventoCat) Object.assign(o, { velocita: d.velocita, raffica: d.raffica, unita: 'km/h', direzione: d.direzione || null, calmo: !!d.calmo, variabile: !!d.variabile, ...(d.variazione ? { variazione: d.variazione } : {}) });
  else if (x.categoria === 'metar') Object.assign(o, { codice: d.codice, fenomeni: d.fenomeni, nubi: d.nubi, cavok: d.cavok });
  else Object.assign(o, { valore: d.valore, unita: X.UNITA[x.categoria] || null, ...(d.limite ? { limite: d.limite } : {}), ...(d.codice ? { codice: d.codice } : {}), ...(d.tipo ? { tipo: d.tipo } : {}) });
  if (d.derivato) o.derivato = true;
  return { ...o, misurato: x.misuratoMs != null ? new Date(x.misuratoMs).toISOString() : null, misuratoLocale: x.misuratoMs != null ? fmtOra.format(new Date(x.misuratoMs)) : null,
    acquisito: new Date(x.acquisitoMs).toISOString(), ritardoAcquisizioneS: x.misuratoMs != null ? Math.max(0, Math.round((x.acquisitoMs - x.misuratoMs) / 1000)) : null,
    etaS: eta, fresco, disponibile: fresco && (valore != null || x.categoria === 'metar') };
}
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, ' ').replace(/\s+/g, ' ').trim();
const CATEGORIE = ['visibilita', 'vento', 'temparia', 'tempacqua', 'umidita', 'pressione', 'rugiada', 'metar'];
// { categoria: [voci] } con filtri facoltativi su stazione (parte del nome) e fonte (cpsm|veporto|metar)
function misure({ categoria = null, stazione = null, fonte = null } = {}) {
  const ora = opz.adesso(), out = {};
  for (const c of categoria ? [categoria] : CATEGORIE) out[c] = [];
  for (const x of sensori.values()) {
    if (!out[x.categoria]) continue;
    if (fonte && x.fonte !== fonte) continue;
    if (stazione && !norm(x.stazione).includes(norm(stazione)) && norm(x.idStazione) !== norm(stazione)) continue;
    out[x.categoria].push(voce(x, ora));
  }
  for (const c in out) out[c].sort((a, b) => a.stazione.localeCompare(b.stazione, 'it') || a.fonte.localeCompare(b.fonte));
  return out;
}
function statoFonti() {
  const ora = opz.adesso(), out = {};
  for (const f of FEED) {
    const s = stato.get(f.id), attivo = avviato && attivi().includes(f);
    out[f.id] = { attivo, ultimoControllo: s.ultimoControllo ? new Date(s.ultimoControllo).toISOString() : null, ultimoControlloRiuscito: s.ultimoRiuscito ? new Date(s.ultimoRiuscito).toISOString() : null,
      ok: s.ultimoControllo != null ? s.erroriConsecutivi === 0 : null, ultimaMisura: s.ultimoDatoMs ? new Date(s.ultimoDatoMs).toISOString() : null,
      etaUltimaMisuraS: s.ultimoDatoMs ? Math.round((ora - s.ultimoDatoMs) / 1000) : null };
  }
  return out;
}
function snapshot(filtri = {}) {
  return { aggiornato: new Date(opz.adesso()).toISOString(), fusoOrario: 'Europe/Rome', misure: misure(filtri), fonti: FONTI, stato: statoFonti(),
    note: 'Ultima osservazione per sensore, senza storico. «fresco» = misura entro la cadenza attesa della fonte (Centro Maree e vePORTO 25 min, METAR 100 min). Direzione del vento = provenienza.' };
}
function diagnosi() {
  const ora = opz.adesso(), out = {};
  for (const f of FEED) {
    const s = stato.get(f.id);
    out[f.id] = { attivo: avviato && attivi().includes(f), controlli: s.controlli, nonModificati304: s.nonModificati, nuoveMisure: s.nuoveMisure, errori: s.errori, erroriConsecutivi: s.erroriConsecutivi,
      ultimoErrore: s.ultimoErrore, durataUltimoControlloMs: s.durataMs, periodoStimatoS: mediana(s.periodi) != null ? Math.round(mediana(s.periodi) / 1000) : null,
      ritardoPubblicazioneMedianoS: mediana(s.ritardi) != null ? Math.round(mediana(s.ritardi) / 1000) : null, prossimoControlloTraS: s.prossimo ? Math.round((s.prossimo - ora) / 1000) : null,
      richiesteCondizionali: !!(s.etag || s.modificato) };
  }
  return { feed: out, sensori: sensori.size, veportoAbilitato: !!opz.veporto };
}
function _reset() { stop(); sensori.clear(); for (const f of FEED) stato.set(f.id, nuovoStato(f)); jwt = null; jwtScade = 0; opz = { fetch: (...a) => fetch(...a), adesso: Date.now, veporto: false, log: (...a) => console.warn(...a) }; }

module.exports = { start, stop, snapshot, misure, diagnosi, controlla, attesa, FEED, CATEGORIE, _reset, _stato: stato, _sensori: sensori, _opz: o => { opz = { ...opz, ...o }; } };
