// VIAGGIO GUIDATO («Inizia il viaggio») e I MIEI VIAGGI (viaggi salvati per un giorno e un'ora).
//
// Viaggio guidato: da una soluzione che parte entro 2 ore (o è partita da meno di 10 minuti).
//  · notifiche di sistema per ogni momento (esci, cambio, scendi): Web Push, quindi anche ad app chiusa e a schermo spento
//    (iPhone/iPad: con l'app installata sulla schermata Home, iOS 16.4 o successivo). Senza Web Push l'app avvisa finché resta aperta;
//  · con l'app davanti: schermata «In viaggio» con l'indicazione del momento e il conto alla rovescia, schermo tenuto acceso
//    (Screen Wake Lock, si può spegnere). Nessun browser permette a una pagina web di restare attiva in secondo piano: lì lavorano le notifiche;
//  · aggiornamento in tempo reale solo della corsa che conta adesso, ogni 30 s e solo con l'app davanti (versione leggera di /api/trip);
//  · finisce da solo 20 minuti dopo l'arrivo; «Termina viaggio» annulla anche gli avvisi sul server.
// I miei viaggi: viaggi futuri salvati sul dispositivo (al massimo 10), separati dai preferiti (che sono luoghi e percorsi senza orario);
//  si cancellano da soli dopo l'arrivo.
// Tutto sta nella memoria del dispositivo; i dati letti dalla memoria si ricostruiscono campo per campo (non si fidano di ciò che trovano).
import { esc, icon, badge, api, p2 } from './util.js';
import * as Notify from './notify.js';

const KEY = 'tpl.viaggio', KEY_SAVED = 'tpl.viaggi', KEY_LOCK = 'tpl.viaggio.schermo', MAX_SAVED = 10;
export const START_BEFORE = 120 * 60e3, START_AFTER = 10 * 60e3;   // si può iniziare da 2 h prima a 10 min dopo la partenza
const END_AFTER = 20 * 60e3, TICK_MS = 15000, LIVE_MS = 30000;

// ---- ore di Venezia (Europe/Rome) indipendenti dal fuso del dispositivo ----
let fmt = null;
function romeOff(ms) {                                              // ms (UTC) -> scarto di Roma in ms (+1 h / +2 h)
  try {
    fmt ||= new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(ms / 60000) * 60000;
  } catch { return 3600e3; }
}
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`; };
export function romeMs(ymd, hm) {                                   // '2026-11-16', '08:20' -> istante
  const [y, m, d] = ymd.split('-').map(Number), [h, mi] = hm.split(':').map(Number), base = Date.UTC(y, m - 1, d, h, mi);
  let t = base - romeOff(base); t = base - romeOff(t); return t;
}
export const romeYmd = ms => { const t = new Date(ms + romeOff(ms)); return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`; };
const romeHm = ms => { const t = new Date(ms + romeOff(ms)); return `${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}`; };
const HM = /^\d{1,2}:\d{2}$/, YMD = /^\d{4}-\d{2}-\d{2}$/;
const ROUTE = /^(nav|aut):[A-Za-z0-9_.:|\-/]{1,60}$/, TRIP = /^(nav|aut):[A-Za-z0-9_.:|\-]{1,100}$/;

// ---- istantanea di una soluzione del pianificatore (quello che serve, niente di più) ----
// o: soluzione di /api/percorso · date: 'YYYY-MM-DD' del giorno cercato · from/to: punti (come li salva il pianificatore) · nameOf: id -> nome della fermata
const ll = x => (Number.isFinite(+x?.lat) && Number.isFinite(+x?.lon) && x.lat !== null && x.lon !== null ? { lat: +(+x.lat).toFixed(5), lon: +(+x.lon).toFixed(5) } : {});
export function snapshot(o, { date, from, to, nameOf = null }) {
  if (!o || !Array.isArray(o.tratte) || !YMD.test(date || '')) return null;
  let day = 0, prev = null;
  const at = hm => {                                                // orari in sequenza: dopo mezzanotte si passa al giorno dopo
    const [h, m] = String(hm).split(':').map(Number), x = (h % 24) * 60 + m;
    if (prev != null && x < prev - 360) day++;
    prev = x; return romeMs(addDays(date, day), `${p2(h % 24)}:${p2(m)}`);
  };
  const nm = st => String((nameOf && nameOf(st.id)) || st.name || '').slice(0, 80);
  const leaveMs = at(o.parti), legs = [];
  for (const t of o.tratte) {
    if (t.tipo === 'piedi') { legs.push({ t: 'w', min: Math.max(0, Math.round(t.min) || 0), to: t.a ? nm(t.a) : null }); continue; }
    if (t.tipo !== 'mezzo' || !t.tripId || !t.da?.id || !t.a?.id) continue;
    const dm = at(t.da.sched || t.da.exp), am = at(t.a.sched || t.a.exp);
    legs.push({ t: 'r', src: t.src === 'nav' ? 'nav' : 'aut', trip: String(t.tripId).slice(0, 100), line: String(t.line || '').slice(0, 12), color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : null,
      hs: String(t.headsign || '').slice(0, 80), n: Math.max(1, +t.fermate || 1), pos: Array.isArray(t.pos) ? t.pos.slice(0, 2).map(Number) : null,
      da: { id: t.da.id, name: nm(t.da), hm: t.da.sched || '', ms: dm, ...ll(t.da) }, a: { id: t.a.id, name: nm(t.a), hm: t.a.sched || '', ms: am, ...ll(t.a) } });
  }
  const arriveMs = at(o.arrivi), rides = legs.filter(l => l.t === 'r');
  if (!rides.length) return null;
  const id = (date + '|' + rides.map(r => r.src + r.trip + '@' + r.da.id).join('>')).replace(/[^A-Za-z0-9_|>@:.-]/g, '').slice(0, 300);
  // famiglia (linee e fermate di salita/discesa) e linee: servono a ritrovare la stessa proposta tra gli «altri orari» (v33.2)
  const fam = typeof o.famiglia === 'string' && o.famiglia.length <= 400 ? o.famiglia : null;
  const rotte = Array.isArray(o.rotte) ? o.rotte.filter(x => typeof x === 'string' && ROUTE.test(x)).slice(0, 6) : [];
  return { v: 1, id, date, from, to, parti: o.parti, arrivi: o.arrivi, minuti: +o.minuti || 0, cambi: +o.cambi || 0, piedi: +o.piedi || 0, leaveMs, arriveMs, legs, ...(fam ? { fam } : {}), ...(rotte.length ? { rotte } : {}) };
}
// ricostruzione sicura da memoria
const sstr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const sid = v => (typeof v === 'string' && /^(nav|aut):[A-Za-z0-9_.:|\-]{1,100}$/.test(v) ? v : null);
const fin = v => (Number.isFinite(v) ? v : null);
function cleanStop(x) { const id = sid(x?.id), ms = fin(x?.ms); return id && ms ? { id, name: sstr(x.name, 80), hm: HM.test(x.hm || '') ? x.hm : romeHm(ms), ms, live: fin(x.live), ...ll(x) } : null; }
function cleanEp(e) {
  if (!e || typeof e !== 'object') return null;
  const k = e.kind, lat = fin(+e.lat), lon = fin(+e.lon), label = sstr(e.label, 100);
  if (k === 'me') return { kind: 'me', label: 'La mia posizione' };
  if (k === 'stop' && sid(e.id)) return { kind: 'stop', id: e.id, label, src: e.src === 'nav' ? 'nav' : 'aut', lat, lon };
  if (k === 'zone' && typeof e.key === 'string' && e.key.length < 120) return { kind: 'zone', key: e.key, label, src: e.src === 'nav' ? 'nav' : 'aut', lat, lon };
  if (k === 'point' && lat != null && lon != null) return { kind: 'point', label: label || 'Punto sulla mappa', lat, lon };
  return null;
}
export function clean(s) {
  if (!s || typeof s !== 'object' || s.v !== 1 || typeof s.id !== 'string' || !YMD.test(s.date || '') || !Array.isArray(s.legs)) return null;
  const legs = [];
  for (const l of s.legs.slice(0, 20)) {
    if (l?.t === 'w') legs.push({ t: 'w', min: Math.min(180, Math.max(0, Math.round(+l.min) || 0)), to: l.to ? sstr(l.to, 80) : null });
    else if (l?.t === 'r') {
      const da = cleanStop(l.da), a = cleanStop(l.a); if (!da || !a || typeof l.trip !== 'string' || !/^[A-Za-z0-9_.:|\-]{1,100}$/.test(l.trip)) return null;
      legs.push({ t: 'r', src: l.src === 'nav' ? 'nav' : 'aut', trip: l.trip, line: sstr(l.line, 12), color: /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : null, hs: sstr(l.hs, 80),
        n: Math.max(1, Math.min(200, +l.n || 1)), pos: Array.isArray(l.pos) && l.pos.length === 2 && l.pos.every(Number.isInteger) ? l.pos : null, da, a, cancel: !!l.cancel });
    }
  }
  const leaveMs = fin(s.leaveMs), arriveMs = fin(s.arriveMs);
  if (!legs.some(l => l.t === 'r') || !leaveMs || !arriveMs || !HM.test(s.parti || '') || !HM.test(s.arrivi || '')) return null;
  return { v: 1, id: s.id.slice(0, 300), date: s.date, from: cleanEp(s.from), to: cleanEp(s.to), parti: s.parti, arrivi: s.arrivi, minuti: Math.max(0, +s.minuti || 0),
    cambi: Math.max(0, +s.cambi || 0), piedi: Math.max(0, +s.piedi || 0), leaveMs, arriveMs, legs,
    ...(typeof s.fam === 'string' && s.fam.length <= 400 ? { fam: s.fam } : {}),
    ...(Array.isArray(s.rotte) && s.rotte.every(x => typeof x === 'string' && ROUTE.test(x)) ? { rotte: s.rotte.slice(0, 6) } : {}),
    ...(s.started ? { started: fin(s.started), viaggio: /^[A-Za-z0-9_-]{6,40}$/.test(s.viaggio || '') ? s.viaggio : null, notif: sstr(s.notif, 300), mode: s.mode === 'push' || s.mode === 'poll' ? s.mode : null } : {}) };
}
const rides = s => s.legs.filter(l => l.t === 'r');
const fromLabel = s => s.from?.label || 'Partenza', toLabel = s => s.to?.label || 'Arrivo';
// si può iniziare adesso? (oggi, da 2 ore prima a 10 minuti dopo la partenza)
export const startable = (s, now = Date.now()) => !!s && s.leaveMs - START_BEFORE <= now && now <= rides(s)[0].da.ms + START_AFTER && now < s.arriveMs;

// ---- PROPOSTA ESATTA (v33.2): viaggio salvato e link condiviso portano la firma della soluzione scelta ----
// firma = corse in ordine («nav:NAV_ACTV_656_86>aut:…»): una proposta è la stessa se usa le stesse corse (le fermate di salita possono cambiare
// di poco con il ricalcolo). Con la firma vanno giorno, orari di partenza/arrivo, famiglia (linee e fermate) e linee, per cercarla anche tra
// gli «altri orari» dello stesso percorso.
export const solTrips = o => (o?.tratte || []).filter(t => t.tipo === 'mezzo' && t.tripId).map(t => `${t.src}:${t.tripId}`).join('>');
export const snapTrips = s => rides(s).map(r => `${r.src}:${r.trip}`).join('>');
export function wantOf(s) {
  const R = rides(s);
  return { trips: snapTrips(s), fam: s.fam || null, rotte: s.rotte || [], date: s.date, parti: s.parti, arrivi: s.arrivi, depMs: R[0].da.ms, leaveMs: s.leaveMs,
    linee: R.map(r => r.line).join(' + ') };
}
// parametri del link di una proposta (oltre a «da» e «a», che mette il pianificatore)
export function linkParams(s) {
  const w = wantOf(s), out = { quando: 'partenza', ora: s.parti.replace(':', ''), data: s.date.replace(/-/g, ''), arr: s.arrivi.replace(':', ''), sol: w.trips };
  if (w.fam && w.fam.length <= 300) out.fam = w.fam;
  if (w.rotte.length) out.rotte = w.rotte.join(',');
  return out;
}
// dal link (get: chiave -> valore già limitato in lunghezza) -> want | null; tutto controllato, niente che finisca nell'HTML senza esc
export function parseWant(get) {
  const sol = get('sol'), ora = /^([01]\d|2[0-3])([0-5]\d)$/.exec(get('ora') || ''), dd = /^(\d{4})(\d{2})(\d{2})$/.exec(get('data') || ''), arr = /^([01]\d|2[0-3])([0-5]\d)$/.exec(get('arr') || '');
  if (!sol || !ora || !dd) return null;
  const trips = sol.split('>'); if (!trips.length || trips.length > 6 || !trips.every(t => TRIP.test(t))) return null;
  const fam = get('fam'), rotte = (get('rotte') || '').split(',').filter(x => ROUTE.test(x)).slice(0, 6);
  const date = `${dd[1]}-${dd[2]}-${dd[3]}`, parti = `${ora[1]}:${ora[2]}`;
  return { trips: trips.join('>'), fam: fam && fam.length <= 300 ? fam : null, rotte, date, parti, arrivi: arr ? `${arr[1]}:${arr[2]}` : null, depMs: null, leaveMs: romeMs(date, parti), linee: '' };
}
// come riaprire una proposta: 'passata' (partenza già avvenuta: alternative di adesso), 'adesso' (entro 90 minuti, oggi: ricerca in tempo reale),
// 'orario' (più avanti: ricerca all'orario della proposta)
export function reopenMode(w, now = Date.now()) {
  const dep = w.depMs ?? w.leaveMs;
  if (!Number.isFinite(dep) || dep < now - 60e3) return 'passata';
  return w.leaveMs - now <= 90 * 60e3 ? 'adesso' : 'orario';
}

// ---- etichette di giorno e minuti ----
export function dayLabel(ymd, now = Date.now()) {
  const t = romeYmd(now);
  if (ymd === t) return 'Oggi'; if (ymd === addDays(t, 1)) return 'Domani';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
const longDay = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); };
const inTxt = (ms, now) => { const m = Math.ceil((ms - now) / 60000); return m <= 0 ? 'ora' : m === 1 ? 'tra 1 min' : m < 60 ? `tra ${m} min` : `tra ${Math.floor(m / 60)} h ${p2(m % 60)}`; };
const walkTxt = m => (m <= 1 ? 'a piedi 1 min' : `a piedi ${m} min`);

// ---- I MIEI VIAGGI ----
function readSaved() { try { const d = JSON.parse(localStorage.getItem(KEY_SAVED) || '[]'); return Array.isArray(d) ? d.map(clean).filter(Boolean) : []; } catch { return []; } }
let saved = readSaved().filter(s => s.arriveMs > Date.now());
const writeSaved = () => { try { localStorage.setItem(KEY_SAVED, JSON.stringify(saved)); return true; } catch { return false; /* solo in memoria */ } };
writeSaved();                                                       // (toglie subito i viaggi passati)
export const savedList = (now = Date.now()) => { const n = saved.length; saved = saved.filter(s => s.arriveMs > now); if (saved.length !== n) writeSaved(); return saved.slice(); };
export const isSaved = id => saved.some(s => s.id === id);
export function toggleSaved(s) {                                    // -> { saved: bool } oppure { error }
  if (isSaved(s.id)) { saved = saved.filter(x => x.id !== s.id); writeSaved(); return { saved: false }; }
  savedList();
  if (saved.length >= MAX_SAVED) return { error: `Hai già ${MAX_SAVED} viaggi salvati: elimina quello che non ti serve più.` };
  const { started, viaggio, notif, mode, ...keep } = s;
  saved.push(keep); saved.sort((a, b) => a.leaveMs - b.leaveMs);
  // v34: memoria del browser piena o bloccata: lo si dice (prima diceva «Salvato» e il viaggio spariva alla riapertura)
  if (!writeSaved()) return { saved: true, volatile: true };
  try { navigator.storage?.persist?.(); } catch { /* facoltativo: chiede al browser di non cancellare da solo i dati del sito */ }
  return { saved: true };
}
export const removeSaved = id => { saved = saved.filter(x => x.id !== id); writeSaved(); };
export const savedById = id => saved.find(s => s.id === id) || null;

// ---- VIAGGIO IN CORSO ----
let J = null, tickT = null, liveT = 0, lock = null, listeners = new Set(), liveErr = 0;
try { J = clean(JSON.parse(localStorage.getItem(KEY) || 'null')); if (J && Date.now() > J.arriveMs + END_AFTER) J = null; } catch { J = null; }
const writeJ = () => { try { if (J) localStorage.setItem(KEY, JSON.stringify(J)); else localStorage.removeItem(KEY); } catch { /* solo in memoria */ } };
export const active = () => J;
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const fn of listeners) { try { fn(J); } catch { /* un ascoltatore non blocca gli altri */ } } };
export const lockWanted = () => { try { return localStorage.getItem(KEY_LOCK) !== '0'; } catch { return true; } };
export const lockSupported = () => 'wakeLock' in navigator;
export const lockOn = () => !!lock;
export function setLockWanted(v) { try { localStorage.setItem(KEY_LOCK, v ? '1' : '0'); } catch { /* facoltativo */ } if (v) acquire(); else release(); emit(); }

async function acquire(force = false) {
  if ((!J && !force) || !lockWanted() || !lockSupported() || document.hidden || lock) return;
  try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; emit(); }); emit(); } catch { lock = null; }
}
// schermo acceso chiesto subito al tocco su «Inizia il viaggio» (alcuni browser lo concedono solo durante un gesto)
export const preLock = () => acquire(true);
export function release() { const l = lock; lock = null; l?.release?.().catch?.(() => {}); }

const randId = () => { const b = new Uint8Array(12); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
// avvisi del viaggio: per ogni corsa «esci» o «cambio» (fermata di salita, preavviso = minuti a piedi + margine) e «scendi» (2 min prima)
export function watchItems(s, now = Date.now(), styleOf = () => null) {
  const out = []; let walk = 0, k = 0;
  for (const l of s.legs) {
    if (l.t === 'w') { walk += l.min; continue; }
    const style = styleOf(l.line, l.color, l.src), base = { trip: `${l.src}:${l.trip}`, line: l.line, headsign: l.hs, style };
    if (now < l.da.ms - 90e3) out.push({ ...base, stop: l.da.id, stopName: l.da.name, ruolo: k === 0 ? 'esci' : 'cambio', walk, lead: Math.min(45, Math.max(2, walk + (k === 0 ? 2 : 3))) });
    if (now < l.a.ms - 60e3) out.push({ ...base, stop: l.a.id, stopName: l.a.name, ruolo: 'scendi', walk: 0, lead: 2 });
    walk = 0; k++;
  }
  return out.slice(0, 8);
}
// «quando uscire, cambiare e scendere» secondo il viaggio: niente «cambiare» senza cambi, niente «uscire» se si parte già dalla fermata
export function momenti(s) {
  const R = rides(s), walk0 = s.legs.findIndex(l => l.t === 'r') > 0 && s.legs.slice(0, s.legs.findIndex(l => l.t === 'r')).some(l => l.t === 'w' && l.min > 0);
  const m = [walk0 ? 'uscire' : 'salire', ...(R.length > 1 ? ['cambiare'] : []), 'scendere'];
  return m.length === 2 ? m.join(' e ') : m.slice(0, -1).join(', ') + ' e ' + m[m.length - 1];
}
// -> { ok, msg }  (msg: com'è andata con le notifiche, sempre detto chiaramente)
export async function start(s, styleOf) {
  if (J) await end(true);
  J = { ...s, started: Date.now(), viaggio: randId(), notif: '', mode: null };
  writeJ(); startTimers(); acquire(); emit();
  const items = watchItems(J, Date.now(), styleOf);
  let msg;
  if (!items.length) msg = 'Il viaggio è già quasi finito: nessun avviso da attivare.';
  else {
    const r = await Notify.startJourney(J.viaggio, items).catch(e => ({ ok: false, msg: e.message }));
    if (!J) return { ok: false, msg: '' };                           // terminato nel frattempo
    if (r.ok) {
      J.mode = r.mode;
      msg = r.mode === 'push' ? `Notifiche attive: ti avviso quando ${momenti(J)}, anche con l'app chiusa.` : r.note;
      if (r.made < r.total) msg += ` (${r.total - r.made} ${r.total - r.made === 1 ? 'avviso non attivato' : 'avvisi non attivati'})`;
    } else msg = (r.msg || 'Notifiche non disponibili.') + ' Tieni l\'app aperta: le indicazioni restano qui.';
  }
  J.notif = msg; writeJ(); emit(); refreshLive(true); gpsSync(true);   // dentro il tocco di «Inizia il viaggio»: il permesso si può chiedere
  return { ok: true, msg };
}
export async function end(quiet = false) {
  if (!J) return;
  const v = J.viaggio; J = null; writeJ(); stopTimers(); release(); gpsStop(); gpsFix = null; gpsHist = []; emit();
  if (v) await Notify.stopJourney(v, quiet);
}

// ---- FASE DEL VIAGGIO: cosa fare adesso (funzione pura, provata nei test) ----
// -> { key, kind, idx, title, when (istante del conto alla rovescia), sub, short, warn? }
export function phase(s, now = Date.now()) {
  const R = rides(s), t = x => x.live ?? x.ms;
  let walk = 0, k = 0;
  for (let i = 0; i < s.legs.length; i++) {
    const l = s.legs[i];
    if (l.t === 'w') { walk += l.min; continue; }
    const dep = t(l.da), arr = t(l.a), prev = k > 0 ? R[k - 1] : null;
    const cancel = l.cancel ? 'La corsa risulta soppressa: tocca «Ricalcola da qui» per un\'altra soluzione.' : null;
    if (now < dep - 30e3) {
      const lineTxt = `linea ${l.line}${l.hs ? ' per ' + l.hs : ''}`;
      if (k === 0) {
        // ora di uscita: quella della soluzione (come nella riga «Partenza»), spostata del ritardo o anticipo della corsa
        const leave = Math.min(s.leaveMs, l.da.ms - walk * 60e3) + (dep - l.da.ms);
        if (walk > 0 && now < leave - 60e3) return { key: `esci${k}`, kind: 'esci', idx: k, title: `Esci alle ${romeHm(leave)}`, when: leave, sub: `${walkTxt(walk)} fino a ${l.da.name}, poi ${lineTxt} alle ${romeHm(dep)}`, short: `Esci ${inTxt(leave, now)}`, warn: cancel };
        return { key: `sali${k}`, kind: 'sali', idx: k, title: `Linea ${l.line} alle ${romeHm(dep)}`, when: dep, sub: `${walk > 0 ? 'Vai a ' : 'Da '}${l.da.name}${l.hs ? ' · direzione ' + l.hs : ''}`, short: `Linea ${l.line} ${inTxt(dep, now)}`, warn: cancel };
      }
      const late = prev && t(prev.a) + walk * 60e3 > dep;
      return { key: `cambio${k}`, kind: 'cambio', idx: k, title: `Cambio: linea ${l.line} alle ${romeHm(dep)}`, when: dep, sub: `${walk > 0 ? `${walkTxt(walk)} fino a ` : 'Da '}${l.da.name}${l.hs ? ' · direzione ' + l.hs : ''}`,
        short: `Cambio ${inTxt(dep, now)}`, warn: cancel || (late ? `Con gli orari di adesso arrivi alle ${romeHm(t(prev.a))}: il cambio è a rischio. Se lo perdi, tocca «Ricalcola da qui».` : null) };
    }
    if (now < arr - 30e3) {
      const soon = arr - now <= 3 * 60e3;
      // già a bordo: si avvisa subito se, con gli orari di adesso, il cambio successivo non riesce
      let j = i + 1, w2 = 0; while (s.legs[j]?.t === 'w') w2 += s.legs[j++].min;
      const nx = s.legs[j], risk = nx?.t === 'r' && arr + w2 * 60e3 > t(nx.da) ? `Con gli orari di adesso arrivi alle ${romeHm(arr)}: il cambio con la linea ${nx.line} delle ${romeHm(t(nx.da))} è a rischio.` : null;
      return { key: `bordo${k}`, kind: soon ? 'scendi' : 'bordo', idx: k, title: soon ? `Scendi a ${l.a.name}` : `Sei sulla linea ${l.line}`, when: arr,
        sub: soon ? `Arrivo alle ${romeHm(arr)}: preparati a scendere` : `Scendi a ${l.a.name} alle ${romeHm(arr)}${l.hs ? ' · direzione ' + l.hs : ''}`, short: `Scendi ${inTxt(arr, now)}`, warn: cancel || risk };
    }
    walk = 0; k++;
  }
  const last = R[R.length - 1], arrive = Math.max(s.arriveMs, t(last.a) + walk * 60e3);
  if (walk > 0 && now < arrive) return { key: 'piedi', kind: 'piedi', idx: k, title: 'Ultimo tratto a piedi', when: arrive, sub: `${walkTxt(walk)} fino a ${toLabel(s)} · arrivo alle ${romeHm(arrive)}`, short: 'Quasi arrivato' };
  return { key: 'fine', kind: 'fine', idx: k, title: 'Sei arrivato', when: null, sub: `${toLabel(s)} · il viaggio si chiude da solo tra poco`, short: 'Arrivato' };
}
export const phaseNow = () => (J ? phase(J) : null);
// ARRIVO PREVISTO con il tempo reale (Infinity se una corsa è soppressa o un cambio è già perso) e motivo per cercare un'alternativa:
// solo ritardo grave (≥ 8 min sull'arrivo) o problema della fase (soppressa, cambio a rischio). Funzione pura, provata nei test.
export function altNeed(s, now = Date.now()) {
  if (!s) return null;
  const R = rides(s), t = x => x.live ?? x.ms, ph = phase(s, now);
  if (ph.kind === 'fine' || ph.kind === 'piedi') return null;
  let tail = 0; for (let i = s.legs.length - 1; i >= 0 && s.legs[i].t === 'w'; i--) tail += s.legs[i].min;
  if (R.some(r => r.cancel && now < t(r.a))) return { why: 'soppressa', arrive: Infinity };
  for (let k = 1; k < R.length; k++) {                             // cambio già perso con gli orari di adesso
    let i = s.legs.indexOf(R[k]) - 1, w = 0; while (i >= 0 && s.legs[i].t === 'w') w += s.legs[i--].min;
    if (now < t(R[k].da) && t(R[k - 1].a) + w * 60e3 > t(R[k].da) + 60e3) return { why: 'cambio', arrive: Infinity };
  }
  const arrive = t(R[R.length - 1].a) + tail * 60e3;
  return arrive - s.arriveMs >= 8 * 60e3 ? { why: 'ritardo', arrive } : null;
}

// ---- POSIZIONE DURANTE IL VIAGGIO (v33.2): GPS solo quando serve, mai a bordo né ad app nascosta ----
// Serve a piedi verso la fermata di partenza (5 minuti prima di uscire), nei cambi a piedi e negli ultimi minuti prima della discesa (per dire
// quanto manca alla fermata). A bordo e con l'app nascosta è spento: lì lavorano gli orari in tempo reale e le notifiche del server.
// La posizione resta sul telefono (non va mai al server). Si accende da sola solo se il permesso c'è già o se l'hai attivata tu con un tocco.
const KEY_GPS = 'tpl.viaggio.gps', GPS_OPTS = { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 };
let gpsId = null, gpsFix = null, gpsHist = [], gpsPerm = null, gpsErr = null, gpsEmitAt = 0;
export const gpsSupported = () => typeof navigator !== 'undefined' && 'geolocation' in navigator;
export const gpsWanted = () => { try { return localStorage.getItem(KEY_GPS) !== '0'; } catch { return true; } };
const distM = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));
// fermata a cui si va adesso e se il GPS serve in questa fase (funzione pura, provata nei test)
export function gpsTarget(s, ph, now = Date.now()) {
  if (!s || !ph) return null;
  const R = rides(s), first = s.legs.findIndex(l => l.t === 'r'), walk0 = s.legs.slice(0, first).some(l => l.t === 'w' && l.min > 0);
  if (ph.kind === 'esci') return ph.when - now <= 5 * 60e3 ? { stop: R[0].da, why: 'verso la fermata' } : null;
  if (ph.kind === 'sali') return ph.idx === 0 && walk0 ? { stop: R[0].da, why: 'verso la fermata' } : null;
  if (ph.kind === 'cambio') {
    let i = s.legs.indexOf(R[ph.idx]) - 1, w = 0; while (i >= 0 && s.legs[i].t === 'w') w += s.legs[i--].min;
    return w > 0 ? { stop: R[ph.idx].da, why: 'verso la fermata del cambio' } : null;
  }
  if (ph.kind === 'scendi') return { stop: R[ph.idx].a, why: 'per la discesa' };
  const c = checkRide(s, now);                                       // v34: pochi minuti dopo la partenza e dopo la discesa, per un controllo
  if (c) return { stop: c.stop, why: c.kind === 'salita' ? 'per controllare la salita' : 'per controllare la discesa', check: c.kind };
  return null;                                                       // a bordo e ultimo tratto a piedi (dopo i controlli), arrivato: spento
}
// ---- CONTROLLI SUL CAMPO CON LA POSIZIONE (v34): solo suggerimenti, mai azioni automatiche ----
// salita: fino a 4 minuti dopo la partenza (prevista o in tempo reale) si guarda se sei ancora al pontile/alla fermata (mezzo perso, in ritardo
// o che non si è fermato); discesa: fino a 6 minuti dopo l'arrivo si guarda se ti allontani più in fretta di chi cammina (discesa mancata).
const SALITA_MS = 4 * 60e3, DISCESA_MS = 6 * 60e3;
export function checkRide(s, now = Date.now()) {
  if (!s) return null;
  const R = rides(s), t = x => x.live ?? x.ms;
  for (let k = 0; k < R.length; k++) { const dep = t(R[k].da); if (now >= dep && now < dep + SALITA_MS && now < t(R[k].a)) return { kind: 'salita', k, stop: R[k].da, since: now - dep }; }
  for (let k = R.length - 1; k >= 0; k--) { const arr = t(R[k].a); if (now >= arr && now < arr + DISCESA_MS) return { kind: 'discesa', k, stop: R[k].a, since: now - arr }; }
  return null;
}
// fixes: ultime posizioni (la più recente in fondo). Servono almeno due letture recenti e precise, a 8 s o più di distanza, tutte d'accordo:
// un salto isolato del GPS non basta.
export function gpsWarn(s, fixes, now = Date.now()) {
  const c = checkRide(s, now); if (!c || !Number.isFinite(c.stop?.lat)) return null;
  const ok = (fixes || []).filter(f => f && now - f.at <= 60e3 && f.acc <= 100);
  if (ok.length < 2 || ok[ok.length - 1].at - ok[0].at < 8e3) return null;
  const l = rides(s)[c.k], d = f => distM(f, c.stop), t0 = now - c.since;
  if (c.kind === 'salita') {
    if (c.since < 90e3 || !ok.every(f => f.acc <= 50 && d(f) <= Math.max(80, f.acc))) return null;
    return `Sei ancora a ${c.stop.name}? Se la linea ${l.line} non è passata può essere in ritardo o non fermarsi; se l'hai persa, tocca «Ricalcola da qui».`;
  }
  if (c.since < 60e3) return null;
  const lim = f => 300 + 150 * Math.max(0, f.at - t0) / 60e3;       // a piedi ci si allontana al massimo di ~85 m al minuto: margine ampio
  if (!ok.every(f => d(f) - f.acc > lim(f))) return null;
  const m = Math.round(d(ok[ok.length - 1]) / 50) * 50;
  return `Sei a circa ${m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : m + ' m'} da ${c.stop.name}: se non sei sceso, scendi alla prossima fermata e tocca «Ricalcola da qui».`;
}

function gpsStop() { if (gpsId != null) { try { navigator.geolocation.clearWatch(gpsId); } catch { /* niente */ } gpsId = null; } }
async function gpsPermState() {
  try { const p = await navigator.permissions?.query?.({ name: 'geolocation' }); gpsPerm = p?.state || null; } catch { gpsPerm = null; }
  return gpsPerm;
}
function gpsStart() {
  if (gpsId != null || !gpsSupported()) return;
  gpsId = navigator.geolocation.watchPosition(pos => {
    const c = pos.coords; if (!Number.isFinite(c.latitude)) return;
    gpsFix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy || 0, at: Date.now() }; gpsErr = null;
    gpsHist = [...gpsHist.filter(f => gpsFix.at - f.at <= 60e3), gpsFix].slice(-4);
    if (Date.now() - gpsEmitAt > 10000) { gpsEmitAt = Date.now(); emit(); }   // al massimo un ridisegno ogni 10 s
  }, err => { gpsErr = err.code === 1 ? 'negato' : 'assente'; if (err.code === 1) { gpsStop(); try { localStorage.setItem(KEY_GPS, '0'); } catch { /* niente */ } } emit(); }, GPS_OPTS);
}
// accende o spegne secondo la fase (chiamata a ogni passo del viaggio); gesto = true se viene da un tocco (può chiedere il permesso)
async function gpsSync(gesto = false) {
  const ph = J ? phase(J) : null, tgt = J && !document.hidden && gpsWanted() && gpsSupported() ? gpsTarget(J, ph) : null;
  if (!tgt) { gpsStop(); return; }
  if (!gesto && gpsPerm !== 'granted' && (await gpsPermState()) !== 'granted') return;   // senza permesso già dato si aspetta un tocco
  gpsStart();
}
export function setGpsWanted(v) { try { localStorage.setItem(KEY_GPS, v ? '1' : '0'); } catch { /* facoltativo */ } gpsErr = null; if (v) gpsSync(true); else gpsStop(); emit(); }
// riga per la schermata: stato del GPS e distanza dalla fermata
export function gpsLine(s = J, now = Date.now()) {
  if (!s || !gpsSupported()) return '';
  if (!gpsWanted()) return gpsErr === 'negato' ? 'Posizione non permessa: la puoi consentire dalle impostazioni del browser.' : 'Posizione spenta per questo viaggio.';
  const tgt = gpsTarget(s, phase(s, now), now);
  if (!tgt) return 'Posizione in pausa: a bordo e con l\'app chiusa non serve (bastano orari in tempo reale e notifiche). Si riaccende a piedi verso la fermata, prima di scendere e per pochi minuti dopo salita e discesa.';
  if (gpsId == null) return `Posizione: si accende ${tgt.why} quando il permesso è concesso.`;
  if (!gpsFix || now - gpsFix.at > 60e3) return `Posizione accesa ${tgt.why}: cerco il segnale…`;
  if (!Number.isFinite(tgt.stop.lat)) return `Posizione accesa ${tgt.why}.`;
  const d = Math.round(distM(gpsFix, tgt.stop) / 10) * 10;
  return d <= Math.max(60, gpsFix.acc) ? `Sei a ${tgt.stop.name}.` : `Sei a circa ${d >= 1000 ? (d / 1000).toFixed(1).replace('.', ',') + ' km' : d + ' m'} da ${tgt.stop.name}.`;
}
export const gpsOn = () => gpsId != null;
// v34: posizione del viaggio recente e precisa (per «Ricalcola da qui» quando la mappa non ha la tua posizione), altrimenti null
export const lastFix = (now = Date.now()) => (gpsFix && now - gpsFix.at <= 90e3 && gpsFix.acc <= 100 ? { lat: gpsFix.lat, lng: gpsFix.lon } : null);

// ---- aggiornamento in tempo reale della corsa che conta adesso ----
function currentRide(now = Date.now()) {
  if (!J) return null;
  for (const r of rides(J)) if (now < (r.a.live ?? r.a.ms) - 30e3) return r;
  return null;
}
async function refreshLive(force = false) {
  if (!J || document.hidden) return;
  if (!force && Date.now() - liveT < LIVE_MS * (1 + Math.min(liveErr, 4))) return;     // con errori: si rallenta
  const r = currentRide(); if (!r) return;
  if (r.da.ms - Date.now() > 90 * 60e3) return;                     // troppo presto: niente tempo reale
  liveT = Date.now();
  try {
    const d = await api(`/api/trip?id=${encodeURIComponent(r.src + ':' + r.trip)}&lite=1`);
    if (!J || d?.error) throw new Error(d?.error || '');
    liveErr = 0;
    const st = Array.isArray(d.stops) ? d.stops : [];
    const pick = (x, k) => (r.pos && st[r.pos[k]]?.id === x.id ? st[r.pos[k]] : st.find(y => y.id === x.id));
    for (const [x, k] of [[r.da, 0], [r.a, 1]]) { const y = pick(x, k); x.live = y && Number.isFinite(y.expMs) && y.state !== 'passed' ? y.expMs : (y?.state === 'passed' ? x.live ?? null : null); }
    r.cancel = !!d.cancelled;
    writeJ(); emit();
  } catch { liveErr++; }
}

function tick() {
  if (!J) { gpsStop(); return stopTimers(); }
  if (Date.now() > J.arriveMs + END_AFTER) { end(true); return; }
  gpsSync(); emit(); refreshLive();
}
function startTimers() { stopTimers(); if (J && !document.hidden) tickT = setInterval(tick, TICK_MS); }
function stopTimers() { clearInterval(tickT); tickT = null; }
document.addEventListener('visibilitychange', () => {
  if (!J) return;
  if (document.hidden) { stopTimers(); gpsStop(); return; }         // in secondo piano lavorano le notifiche: nessun timer, nessuna richiesta, niente GPS
  tick(); startTimers(); acquire(); refreshLive(true);
});
// schermo acceso non concesso (alcuni browser lo danno solo dopo un tocco): si riprova al primo tocco sulla pagina
document.addEventListener('pointerdown', () => { if (J && !lock && lockWanted()) acquire(); }, { passive: true, capture: true });
if (J) { startTimers(); setTimeout(() => { acquire(); refreshLive(true); emit(); }, 1500); }

// ---- SCHERMATA «IN VIAGGIO» ----
function stepsHtml(s, ph, now) {
  const out = [];
  out.push(`<li class="vg-s${now >= s.leaveMs ? ' done' : ''}"><span class="vg-st">${esc(s.parti)}</span><span>Partenza · ${esc(fromLabel(s))}</span></li>`);
  let k = 0;
  for (const l of s.legs) {
    if (l.t === 'w') { out.push(`<li class="vg-s walk"><span class="vg-st">${icon('walk', 'sm')}</span><span>${esc(walkTxt(l.min))}${l.to ? ' fino a ' + esc(l.to) : ''}</span></li>`); continue; }
    const doneDep = ph.idx > k || (ph.idx === k && (ph.kind === 'bordo' || ph.kind === 'scendi')), doneArr = ph.idx > k, cur = ph.idx === k;
    const dl = l.da.live && Math.abs(l.da.live - l.da.ms) >= 60e3 ? ` <small class="vg-live">${romeHm(l.da.live)}</small>` : '';
    const al = l.a.live && Math.abs(l.a.live - l.a.ms) >= 60e3 ? ` <small class="vg-live">${romeHm(l.a.live)}</small>` : '';
    out.push(`<li class="vg-s ride${doneDep ? ' done' : ''}${cur && !doneDep ? ' cur' : ''}"><span class="vg-st">${esc(l.da.hm || romeHm(l.da.ms))}${dl}</span><span>${badge(l.line, l.color, l.src)} <b>${esc(l.da.name)}</b>${l.hs ? `<small> direzione ${esc(l.hs)}</small>` : ''}</span></li>`);
    out.push(`<li class="vg-s off${doneArr ? ' done' : ''}${cur && doneDep ? ' cur' : ''}"><span class="vg-st">${esc(l.a.hm || romeHm(l.a.ms))}${al}</span><span>Scendi a <b>${esc(l.a.name)}</b><small> · ${l.n} ${l.n === 1 ? 'fermata' : 'fermate'}</small></span></li>`);
    k++;
  }
  out.push(`<li class="vg-s end${ph.kind === 'fine' ? ' done' : ''}"><span class="vg-st">${esc(s.arrivi)}</span><span>Arrivo · ${esc(toLabel(s))}</span></li>`);
  return out.join('');
}
// come arrivano gli aggiornamenti con lo schermo spento o l'app chiusa (il browser ferma la pagina: lavora il server)
const bgTxt = s => (s.mode === 'push'
  ? 'Con lo schermo spento o l\'app chiusa il telefono ferma l\'app: «esci», «cambio», «scendi», corse soppresse e ritardi arrivano come notifiche dal server. Quando la riapri si aggiorna subito.'
  : 'Senza notifiche, con lo schermo spento o l\'app chiusa non ricevi avvisi: tieni l\'app aperta. Quando la riapri si aggiorna subito.');
const PH_IC = { esci: 'walk', sali: 'clock', cambio: 'swap', bordo: 'next', scendi: 'pin', piedi: 'walk', fine: 'check' };
export function viewHtml(now = Date.now()) {
  const s = J; if (!s) return '';
  const ph = phase(s, now), gw = gpsOn() ? gpsWarn(s, gpsHist, now) : null;
  const lockTxt = !lockSupported() ? 'Questo browser non permette di tenere acceso lo schermo: le notifiche ti avvisano comunque.'
    : lockWanted() ? (lock ? 'Schermo tenuto acceso finché l\'app è davanti.' : 'Il browser per ora non lo concede: riprovo al prossimo tocco. Le notifiche ti avvisano comunque.') : 'Lo schermo si spegne come al solito.';
  return `<div class="vg" data-ph="${esc(ph.key)}" data-gw="${esc(gw || '')}">`
    + `<p class="vg-route"><span class="vg-od">${icon('route', 'sm')}${esc(fromLabel(s))} ${icon('next', 'sm')} ${esc(toLabel(s))}</span></p>`
    + `<div class="vg-now" data-kind="${ph.kind}" role="status" aria-live="polite"><span class="vg-ic">${icon(PH_IC[ph.kind] || 'next')}</span><div><b class="vg-t">${esc(ph.title)}</b>`
    + `${ph.when ? `<span class="vg-c" data-when="${ph.when}">${esc(inTxt(ph.when, now))}</span>` : ''}<small class="vg-sub">${esc(ph.sub)}</small></div></div>`
    + (ph.warn ? `<p class="vg-warn">${icon('warn', 'sm')}<span>${esc(ph.warn)}</span></p>` : '')
    + (gw ? `<p class="vg-warn vg-gw" role="alert">${icon('locate', 'sm')}<span>${esc(gw)}</span></p>` : '')
    + `<ol class="vg-steps">${stepsHtml(s, ph, now)}</ol>`
    + `<p class="vg-note">${icon('bell', 'sm')}<span>${esc(s.notif || 'Attivo gli avvisi…')}${s.mode === 'push' && /android/i.test(navigator.userAgent) ? ' Se arrivano in ritardo, togli il browser dalle app in sospensione nelle impostazioni della batteria.' : ''}</span></p>`
    + (gpsSupported() ? `<p class="vg-gps">${icon('locate', 'sm')}<span class="vg-gpst">${esc(gpsLine(s, now))}</span></p>` : '')
    + `<p class="vg-gps">${icon('info', 'sm')}<span>${esc(bgTxt(s))}</span></p>`
    + (gpsSupported() ? `<label class="vg-lock"><input type="checkbox" class="vg-gpscb"${gpsWanted() ? ' checked' : ''}><span><b>Usa la posizione durante il viaggio</b><small>A piedi verso la fermata, nei cambi a piedi, prima di scendere e per pochi minuti dopo salita e discesa (per accorgersi di un mezzo perso o di una discesa mancata); resta sul telefono.</small></span></label>` : '')
    + `<label class="vg-lock"><input type="checkbox" class="vg-lockcb"${lockWanted() ? ' checked' : ''}${lockSupported() ? '' : ' disabled'}><span><b>Schermo sempre acceso</b><small>${esc(lockTxt)} Consuma più batteria; si spegne a fine viaggio.</small></span></label>`
    + `<div class="vg-acts"><button type="button" class="btn vg-recalc">${icon('route', 'sm')}<span>Ricalcola da qui</span></button>`
    + `<button type="button" class="btn vg-end">${icon('close', 'sm')}<span>Termina viaggio</span></button></div></div>`;
}
// aggiornamento leggero (solo conto alla rovescia) se la fase non è cambiata; altrimenti la schermata si ridisegna
export function updateView(root, now = Date.now()) {
  const v = root.querySelector('.vg'); if (!v || !J) return false;
  const ph = phase(J, now); if (v.dataset.ph !== ph.key) return false;
  if ((v.dataset.gw || '') !== ((gpsOn() ? gpsWarn(J, gpsHist, now) : null) || '')) return false;   // avviso dalla posizione comparso o sparito
  const c = v.querySelector('.vg-c'); if (c && ph.when) c.textContent = inTxt(ph.when, now);
  const g = v.querySelector('.vg-gpst'); if (g) g.textContent = gpsLine(J, now);
  return true;
}
export const shortText = (now = Date.now()) => (J ? phase(J, now).short : '');

// ---- CONDIVIDI COME TESTO (v33.2: ordinato, con il simbolo del mezzo, le linee, gli orari, i cambi e il link alla proposta) ----
const modeIc = l => (l.src === 'nav' ? '⛴️' : /^PM$/i.test(l.line) ? '🚝' : /^T\d$/i.test(l.line) ? '🚊' : '🚌');
const durTxt = m => (m >= 60 ? `${Math.floor(m / 60)} h ${p2(m % 60)}` : `${m} min`);
export function shareText(s, link) {
  const R = rides(s), L = [`🧭 ${fromLabel(s)} → ${toLabel(s)}`,
    `📅 ${longDay(s.date).replace(/^./, c => c.toUpperCase())} · ${s.parti} → ${s.arrivi} (${durTxt(s.minuti)}, ${s.cambi ? `${s.cambi} ${s.cambi > 1 ? 'cambi' : 'cambio'}` : 'senza cambi'}${s.piedi ? `, ${s.piedi} min a piedi` : ''})`, ''];
  let k = 0, walk = 0;
  const flushWalk = (last) => {
    if (!walk) return;
    if (k === 0) L.push(`🚶 ${s.parti}  a piedi ${walk} min`);
    else if (!last) L.push(`🔁 cambio a piedi ${walk} min`);
    walk = 0;
  };
  for (const l of s.legs) {
    if (l.t === 'w') { walk += l.min; continue; }
    if (k > 0 && !walk) L.push('🔁 cambio');
    flushWalk(false);
    L.push(`${modeIc(l)} ${(l.da.hm || romeHm(l.da.ms))}  [${l.line}]${l.hs ? ` direzione ${l.hs}` : ''}`);
    L.push(`      sali a ${l.da.name}`);
    L.push(`   ${(l.a.hm || romeHm(l.a.ms))}  scendi a ${l.a.name} · ${l.n} ${l.n === 1 ? 'fermata' : 'fermate'}`);
    k++;
  }
  if (walk) L.push(`🚶 a piedi ${walk} min fino all'arrivo`);
  L.push(`🏁 ${s.arrivi}  ${toLabel(s)}`, '', `Linee: ${R.map(l => `${modeIc(l)} ${l.line}`).join('  ')}`, 'Orari programmati ACTV: prima di partire controlla il tempo reale.');
  if (link) L.push('', `Apri questa proposta: ${link}`);
  return L.join('\n');
}
// -> 'condiviso' | 'copiato' | 'annullato' | 'errore'
export async function share(s, link) {
  const text = shareText(s, link);
  if (navigator.share) {
    try { await navigator.share({ title: `${fromLabel(s)} → ${toLabel(s)}, ${s.parti}`, text }); return 'condiviso'; }
    catch (e) { if (e?.name === 'AbortError') return 'annullato'; }
  }
  try { await navigator.clipboard.writeText(text); return 'copiato'; } catch { /* sotto */ }
  try {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok ? 'copiato' : 'errore';
  } catch { return 'errore'; }
}

// ---- elenco «I miei viaggi» (schermata iniziale del pianificatore, sopra i percorsi recenti e salvati) ----
export function savedHtml(now = Date.now()) {
  const list = savedList(now); if (!list.length) return '';
  return '<div class="search-category">I miei viaggi</div>' + list.map(s => {
    const go = startable(s, now), r0 = rides(s)[0], day = dayLabel(s.date, now);
    return `<div class="vg-row"><button type="button" class="pp-sug vg-open" data-vg="${esc(s.id)}">${icon('bookmark')}<span><b>${esc(day)} · ${esc(s.parti)}–${esc(s.arrivi)}</b>`
      + `<small>${esc(fromLabel(s))} → ${esc(toLabel(s))} · linea ${esc(r0.line)}${s.cambi ? ` + ${s.cambi} ${s.cambi > 1 ? 'cambi' : 'cambio'}` : ''}</small>${go ? '<small class="vg-ready">si può iniziare ora</small>' : ''}</span></button>`
      + `<button type="button" class="ibtn sm vg-del" data-vgdel="${esc(s.id)}" aria-label="Elimina il viaggio di ${esc(day.toLowerCase())} alle ${esc(s.parti)}" title="Elimina">${icon('trash', 'sm')}</button></div>`;
  }).join('');
}
