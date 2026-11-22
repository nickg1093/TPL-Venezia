// ORARI PROGRAMMATI DI OGGI ANCHE SENZA RETE (pannello della fermata).
// Con la connessione l'app chiede le partenze al server (tempo reale + orario). Senza connessione il server non risponde: per non lasciare
// il pannello vuoto, il telefono tiene una copia degli ORARI PROGRAMMATI del giorno, presi dai file per giorno che il workflow «dati»
// pubblica sul CDN (orari.js sul server: orari/<src>/<versione>.json e orari/<src>/g/<impronta>.json, gli stessi che usa il server).
//
// Regole (dati sempre giusti, mai spacciati per attuali):
//   · si salvano SOLO i giorni che il server indica in /api/fissi (src[].orari: oggi e, se usa la stessa versione, domani) e SOLO della
//     versione dei dati fissi in uso (stesse fermate e linee); ogni file si verifica con l'impronta del suo nome e la versione che dichiara;
//   · si tengono al massimo ieri (per le corse dopo mezzanotte, orari 24:xx), oggi e domani (scaricato dopo le 20, per il cambio di
//     giorno senza rete); tutto il resto si cancella. Con «risparmio dati» attivo si scarica solo oggi;
//   · giorno, ore e corse oltre mezzanotte nel fuso di Venezia, indipendenti dal dispositivo (giorno di servizio GTFS: mezzogiorno − 12 h);
//   · senza rete il pannello mostra solo orari programmati, con la dicitura «Senza rete · orari programmati» e «Da orario» su ogni riga:
//     mai ritardi, mezzi o soppressioni vecchi. Se il giorno di oggi non è salvato, lo si dice (niente orari di un altro giorno).
// La parte di calcolo è pura (prove in tests/orarioggi.test.js); la memoria è la stessa Cache Storage dei dati fissi (chiavi /__orari/).
import * as Fissi from './fissi.js';

const KEY = 'tpl.orari', PRE = '/__orari/', RE16 = /^[0-9a-f]{16}$/, RE12 = /^[0-9a-f]{12}$/, RE8 = /^\d{8}$/;
const p2 = n => String(n).padStart(2, '0');

// ---- ore e giorni di Venezia (Europe/Rome) ----
let fmt = null;
function romeOff(ms) {                                              // scarto di Roma rispetto a UTC in ms (+1 h / +2 h)
  try {
    fmt ||= new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(ms / 60000) * 60000;
  } catch { return 3600e3; }
}
export const ymd8 = ms => { const t = new Date(ms + romeOff(ms)); return `${t.getUTCFullYear()}${p2(t.getUTCMonth() + 1)}${p2(t.getUTCDate())}`; };
export const oraRoma = ms => { const t = new Date(ms + romeOff(ms)); return t.getUTCHours() + t.getUTCMinutes() / 60; };
export const addDays8 = (d, n) => { const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + n)); return `${t.getUTCFullYear()}${p2(t.getUTCMonth() + 1)}${p2(t.getUTCDate())}`; };
// inizio del giorno di servizio GTFS (mezzogiorno di Venezia − 12 h: giusto anche nei giorni del cambio d'ora)
export function zeroMs(d) {
  const base = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), 12, 0);
  let t = base - romeOff(base); t = base - romeOff(t);
  return t - 12 * 3600e3;
}
const hhmm = s => { const m = Math.floor(s / 60), h = Math.floor(m / 60) % 24; return `${p2(h)}:${p2(m % 60)}`; };

// ---- file di un giorno (orari.js: { f, src, v, p: [[fermate[], seq[]]…], t: [[n, trip, route, headsign, service, shape, dir, pattern, partenza, arrivi[], soste[] | 0]…] }) ----
export function leggiGiorno(j, src, v) {
  if (!j || j.f !== 1 || j.src !== src || j.v !== v || !Array.isArray(j.p) || !Array.isArray(j.t)) return null;
  const p = j.p.filter(x => Array.isArray(x) && Array.isArray(x[0]));
  if (p.length !== j.p.length) return null;
  return j;
}
// indice fermata -> [[riga, posizione]…] (una volta per file)
const indici = new WeakMap();
function indice(d) {
  let I = indici.get(d); if (I) return I;
  I = new Map();
  d.t.forEach((r, k) => {
    const pat = Array.isArray(r) && r[7] >= 0 ? d.p[r[7]] : null; if (!pat || !Number.isFinite(r[8]) || !Array.isArray(r[9])) return;
    pat[0].forEach((s, i) => { let l = I.get(s); if (!l) I.set(s, l = []); l.push([k, i]); });
  });
  indici.set(d, I); return I;
}

// ---- fermate successive (stesse regole di prossime.js sul server: tests/orarioggi.test.js controlla che coincidano) ----
const MAX = 12;
const GENERIC = new Set(['via', 'viale', 'piazza', 'piazzale', 'corso', 'riva', 'calle', 'campo', 'fondamenta', 'fondamente', 'ponte', 'strada',
  'san', 'santa', 'sant', 'santo', 'santi', 'stazione', 'largo', 'vicolo', 'rotonda', 'incrocio', 'zona', 'ss', 'sr', 'sp']);
export const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/["“”'‘’`]/g, ' ')
  .replace(/\bs\.\s*/g, 'san ').replace(/\bp\.le\b/g, 'piazzale').replace(/\bf\.te\b/g, 'fondamente').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const cleanName = s => String(s || '').slice(0, 120).replace(/\s*["“”'‘’][A-Za-z0-9]{1,2}["“”'‘’]\s*$/, '').replace(/\s+[A-Z][0-9]{0,2}$/, '').trim();
function similar(a, b) {
  const x = norm(a), y = norm(b); if (!x || !y) return false;
  if (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ')) return true;
  const wx = x.split(' '), wy = y.split(' ');
  let k = 0; while (k < wx.length && k < wy.length && wx[k] === wy[k]) k++;
  return k >= 2 || (k === 1 && !GENERIC.has(wx[0]) && wx[0].length >= 4);
}
export function build(names, dest) {
  const L = [];
  for (const raw of names) { const n = cleanName(raw); if (n && (!L.length || norm(L[L.length - 1]) !== norm(n))) L.push(n); }
  while (L.length && similar(L[L.length - 1], dest)) L.pop();
  const out = []; let count = 0, more = false;
  for (let i = 0; i < L.length && !more;) {
    const w = L[i].split(' ');
    let best = null;
    for (let p = Math.min(3, w.length - 1); p >= 1 && !best; p--) {
      const pre = w.slice(0, p).join(' '), pn = norm(pre);
      if (!pn || (p === 1 && GENERIC.has(pn))) continue;
      let j = i + 1; while (j < L.length && norm(L[j]).startsWith(pn + ' ')) j++;
      if (j - i >= 2) best = { pre, j, p };
    }
    if (best) {
      const rest = L.slice(i, best.j).map(n => n.split(' ').slice(best.p).join(' ')).filter(Boolean), room = MAX - count;
      if (rest.length > room) { out.push([best.pre, rest.slice(0, Math.max(1, room))]); more = true; break; }
      out.push([best.pre, rest]); count += rest.length; i = best.j;
    } else {
      if (count >= MAX) { more = true; break; }
      out.push(L[i++]); count++;
    }
    if (count >= MAX && i < L.length) more = true;
  }
  return more ? { s: out, m: true } : { s: out };
}

// ---- partenze programmate a una o più fermate ----
// giorni: [{ ymd: AAAAMMGG, src, d }] (file già letti); ids: ['src:fermata', …]; now: ms; info: { nome(full) -> nome della fermata,
// linea(src, route) -> { name, color } | null }. Stessi campi delle righe di /api/stop (schedule.js) in orario programmato:
// live false, delay null, nessun mezzo. Finestra come il server: partite da 3 minuti, fino a 2 ore.
export function partenze(giorni, ids, now, info = {}) {
  const want = new Map();                                         // src -> Set(fermata)
  for (const f of ids || []) { const k = String(f).indexOf(':'); if (k < 1) continue; const s = f.slice(0, k); if (!want.has(s)) want.set(s, new Set()); want.get(s).add(f.slice(k + 1)); }
  const out = [], seen = new Set(), nexts = {}, short = new Map();
  const nome = f => (info.nome ? info.nome(f) : null) || '';
  for (const { ymd, src, d } of giorni || []) {
    const ws = want.get(src); if (!ws || !d || !RE8.test(ymd)) continue;
    const I = indice(d), z = zeroMs(ymd);
    for (const sid of ws) for (const [k, i] of I.get(sid) || []) {
      const r = d.t[k], pat = d.p[r[7]], n = pat[0].length, last = i === n - 1;
      const ts = r[8] + (+r[9][i] || 0) + (!last && Array.isArray(r[10]) ? +r[10][i] || 0 : 0);
      const sm = (z + ts * 1000 - now) / 1000;
      if (!(sm >= -180 && sm <= 7200)) continue;
      const full = `${src}:${sid}`, key = `${full}|${r[1]}|${i}|${ymd}`; if (seen.has(key)) continue; seen.add(key);
      const ln = info.linea ? info.linea(src, r[2]) : null, dest = r[3] || nome(`${src}:${pat[0][n - 1]}`) || null;
      const x = { src, stop: full, tripId: r[1], seq: i, line: ln?.name || r[2], color: ln?.color || null, headsign: dest, sched: hhmm(ts), exp: hhmm(ts), arrival: last,
        schedIn: Math.round(sm / 60), schedSec: sm, expIn: Math.round(sm / 60), expSec: sm, expMs: null, delay: null, live: false, veh: null, vehLabel: null, vehicle: null,
        stale: null, atStop: false, phase: null, done: false, cancel: null, isRequest: false, programmato: true };
      if (!last) {
        const nk = `${r[7]}.${i}.${norm(dest).slice(0, 40)}.${src}`;
        let c = short.get(nk);
        if (!c) { const v = build(pat[0].slice(i + 1).map(s => nome(`${src}:${s}`)), dest || ''); if (v.s.length) { c = 'n' + short.size.toString(36); short.set(nk, c); nexts[c] = v; } else short.set(nk, ''); }
        if (c) x.nx = c;
      }
      out.push(x);
    }
  }
  out.sort((a, b) => a.schedSec - b.schedSec);
  return { departures: out.slice(0, 300), nexts };
}

// ---- memoria del telefono ----
const leggiMeta = () => { try { const m = JSON.parse(localStorage.getItem(KEY) || 'null'); return m && m.f === 1 && m.s && typeof m.s === 'object' ? m : { f: 1, s: {} }; } catch { return { f: 1, s: {} }; } };
const scriviMeta = m => { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* memoria piena: si ritenta alla prossima apertura */ } };
// controllo campo per campo di ciò che arriva dalla memoria (può essere vecchio o rovinato)
function metaPulita(m) {
  const out = { f: 1, s: {}, salvato: Number.isFinite(m?.salvato) ? m.salvato : 0 };
  for (const [src, e] of Object.entries(m?.s || {})) {
    if (!/^[a-z]{2,8}$/.test(src) || !e || !RE12.test(e.v || '') || typeof e.g !== 'object') continue;
    const g = {}; for (const [d, h] of Object.entries(e.g)) if (RE8.test(d) && RE16.test(h || '')) g[d] = h;
    out.s[src] = { v: e.v, g };
  }
  return out;
}
const parsed = new Map();                                        // impronta -> file letto (in questa sessione)
async function apri(h, src, v) {
  if (parsed.has(h)) return parsed.get(h);
  const c = await Fissi.openCache(); if (!c) return null;
  try {
    const r = await c.match(PRE + h); if (!r) return null;
    const b = await r.arrayBuffer();
    if (!(await Fissi.sha256(b)).startsWith(h)) { c.delete(PRE + h); return null; }
    const d = leggiGiorno(JSON.parse(new TextDecoder().decode(b)), src, v);
    if (d) { if (parsed.size > 8) parsed.clear(); parsed.set(h, d); }
    return d;
  } catch { return null; }
}

// Con la rete: scarica (una volta) i file dei giorni che servono e cancella quelli superati. Silenziosa: se qualcosa manca, al massimo
// senza rete non ci saranno gli orari.
let corsa = null;
export function prepara(now = Date.now()) {
  if (corsa) return corsa;
  corsa = (async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const man = Fissi.current() || await Fissi.manifest(); if (!man?.src) return;
    const bases = Fissi.cdnBases(man); if (!bases.length) return;
    const oggi = ymd8(now), ieri = addDays8(oggi, -1), domani = addDays8(oggi, 1);
    const risparmio = typeof navigator !== 'undefined' && !!navigator.connection?.saveData;
    const tardi = oraRoma(now) >= 20;                               // dopo le 20 anche domani: dopo mezzanotte serve senza rete
    const m = metaPulita(leggiMeta()), c = await Fissi.openCache(); if (!c) return;
    let cambiato = false;
    for (const s of man.src) {
      if (!s || !RE12.test(s.v || '') || !Array.isArray(s.orari)) continue;
      let e = m.s[s.id];
      if (!e || e.v !== s.v) { e = m.s[s.id] = { v: s.v, g: {} }; cambiato = true; }   // versione nuova: i file vecchi non valgono più
      const giorni = s.orari.filter(d => RE8.test(d) && (d === oggi || (d === domani && tardi && !risparmio)) && !e.g[d]);
      if (!giorni.length) continue;
      let idx = null;
      for (const b of bases) {
        try {
          const r = await fetch(`${b}/orari/${s.id}/${s.v}.json`, { cache: 'force-cache', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
          if (!r.ok) continue;
          const j = await r.json();
          if (j && j.f === 1 && j.src === s.id && j.v === s.v && String(j.h || '').startsWith(s.v) && j.giorni && typeof j.giorni === 'object') { idx = j; break; }
        } catch { /* prossima base */ }
      }
      if (!idx) continue;
      for (const d of giorni) {
        const h = idx.giorni[d]; if (!RE16.test(h || '')) continue;
        try {
          const b = await Fissi.getVerified(PRE + h, h, bases.map(x => `${x}/orari/${s.id}/g/${h}.json`));
          if (!leggiGiorno(JSON.parse(new TextDecoder().decode(b)), s.id, s.v)) { c.delete(PRE + h); continue; }
          e.g[d] = h; cambiato = true;
        } catch { /* non disponibile: si riprova più tardi */ }
      }
    }
    // tenuti solo ieri, oggi e domani della versione in uso; gli altri file si cancellano
    for (const e of Object.values(m.s)) for (const d of Object.keys(e.g)) if (d !== ieri && d !== oggi && d !== domani) { delete e.g[d]; cambiato = true; }
    for (const id of Object.keys(m.s)) if (!man.src.some(s => s.id === id)) { delete m.s[id]; cambiato = true; }
    if (cambiato) { m.salvato = now; scriviMeta(m); }
    const keep = new Set(Object.values(m.s).flatMap(e => Object.values(e.g)));
    try { for (const req of await c.keys()) { const p = new URL(req.url).pathname; if (p.startsWith(PRE) && !keep.has(p.slice(PRE.length))) c.delete(req); } } catch { /* niente */ }
  })().catch(() => {}).finally(() => { corsa = null; });
  return corsa;
}

// Senza rete: partenze programmate delle fermate dai file salvati. null se il giorno di oggi non è salvato per nessuna di quelle fermate
// (allora si dice che gli orari di oggi non sono disponibili senza rete). { departures, nexts, programmato: true, salvato }
export async function perFermate(ids, now = Date.now(), info = {}) {
  const m = metaPulita(leggiMeta()), oggi = ymd8(now), srcs = new Set((ids || []).map(f => String(f).split(':')[0]));
  const giorni = []; let conOggi = false;
  for (const src of srcs) {
    const e = m.s[src]; if (!e) continue;
    for (const d of [oggi, addDays8(oggi, -1), addDays8(oggi, 1)]) {
      const h = e.g[d]; if (!h) continue;
      const file = await apri(h, src, e.v); if (!file) continue;
      if (d === oggi) conOggi = true;
      giorni.push({ ymd: d, src, d: file });
    }
  }
  if (!conOggi) return null;
  return { ...partenze(giorni, ids, now, info), programmato: true, salvato: m.salvato || null, liveUpdated: 0 };
}
export const haOggi = (now = Date.now()) => { const m = metaPulita(leggiMeta()), d = ymd8(now); return Object.values(m.s).some(e => !!e.g[d]); };
