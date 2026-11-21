// PIANIFICA PERCORSO (client): da / a, quando, soluzioni e dettaglio tappa per tappa, nel pannello laterale (o in basso sul telefono).
// Il calcolo lo fa il server (/api/percorso). La posizione dell'utente NON esce dal telefono: si inviano solo le fermate vicine al punto
// scelto, con la distanza calcolata qui: lungo le strade (camminata.js, rete pedonale di OpenStreetMap scaricata dal CDN, fino a 30 minuti
// a passo svelto) o, se la rete non è disponibile, in linea d'aria come prima. Anche i tratti a piedi sulla mappa seguono le strade. Ogni tratta in mezzo usa gli stessi orari, simboli e diciture del pannello fermata,
// e si apre nel pannello del mezzo (con «indietro» al percorso).
import { esc, icon, badge, colorInfo, lum, delayInfo, etaText, api, srcIcon, vehName, localDate, ritenta, riuscito, NON_ORA } from './util.js';
import { zones, zoneOf, norm, snorm, groups, aliasOf } from './zones.js';
import * as Fav from './fav.js';
import * as Scegli from './scegli.js';
import * as Walk from './camminata.js';
import * as Viaggio from './viaggio.js';
import * as Notify from './notify.js';
import * as Avvisi from './avvisi.js';
import * as Tide from './tide.js';
import * as Livelli from './livelli.js';
import * as XA from './acqua.js';

const NEAR_M = 1500, NEAR_N = 14, REFRESH_MS = 60000, KEY = 'tpl.percorso', KEY_OPZ = 'tpl.percorso.opz';
let X = null;                      // contesto dato da app.js (mappa, pannello, fermate, posizione…)
// det: soluzione mostrata nel dettaglio (dell'elenco o un'alternativa); alts: alternative caricate per il dettaglio; opz: filtri; showOpz: pagina dei filtri
// mezzi: battelli (nav) e autobus/tram (aut, come i pulsanti della mappa)
// v28: tre scelte sole. pref: equilibrata (Arrivare prima) | piedi (Camminare meno) | cambi (Meno cambi);
// passo (andatura): calma (passo tranquillo + 3 minuti per i cambi) | normale | svelta; mezzi: battelli e/o autobus e tram
const OPZ0 = { mezzi: ['nav', 'aut'], pref: 'equilibrata', passo: 'normale' };
// when: 'now' (parti adesso, tempo reale) · 'at' (parti alle) · 'by' (arriva entro); date: giorno scelto (AAAA-MM-GG), entro le date dei GTFS in archivio
const S = { formOpen: false, tall: false, walkShow: false, from: null, to: null, when: 'now', time: '', date: '', res: null, err: null, sel: -1, det: null, alts: null, edit: null, lst: null, ren: null, draft: null, draftF: null, q: '', picking: null, loading: false, asked: 0,
  opz: { ...OPZ0 }, showOpz: false, opzDirty: false };
let timer = null, token = 0, retry = null, range = { min: '', max: '' };
// date con orari disponibili: le stesse della modalità «Programmato» (/api/dates, versioni dei GTFS in archivio)
api('/api/dates').then(d => { const iso = y => (y ? `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}` : ''); range = { min: iso(d.min), max: iso(d.max) }; }).catch(() => {});
const today = () => localDate();
const clampDate = v => { const t = today(); let d = v || t; if (d < t) d = t; if (range.min && d < range.min) d = range.min; if (range.max && d > range.max) d = range.max; return d; };

// ---- punti: { kind: 'me'|'point'|'stop'|'zone', label, lat, lon, id?, key?, src? } ----
const mDist = (a, b, c, d) => Math.hypot((a - c) * 111320, (b - d) * 111320 * Math.cos(a * Math.PI / 180));
function stopEp(id, name, src) {
  const z = zoneOf.get(id); if (z) return zoneEp(z);
  const pid = aliasOf.get(id) || id, s = X.stopById.get(pid);
  return { kind: 'stop', id: pid, label: s ? s[1] : name, src: s ? s[4] : src, lat: s ? +s[2] : null, lon: s ? +s[3] : null };
}
const zoneEp = z => ({ kind: 'zone', key: z.key, label: z.name, src: z.src, lat: z.center[0], lon: z.center[1] });
const meEp = ll => ({ kind: 'me', label: 'La mia posizione', lat: ll.lat, lon: ll.lng });
// fermate candidate da mandare al server: "src:id~metri"
function cands(ep) {
  if (!ep) return null;
  if (ep.kind === 'zone') { const z = zones.get(ep.key); if (!z) return null; return z.items.flatMap(i => groups.get(i.id) || [i.id]).map(id => id + '~0'); }
  if (ep.kind === 'stop') return (groups.get(ep.id) || [ep.id]).map(id => id + '~0');
  // distanze lungo le strade già calcolate per questo punto (prepWalk): «~r» = metri reali, il server non aggiunge la sua stima
  const real = walkVal.get(ptKey(ep) + acquaK);
  if (real?.size) return [...real].sort((a, b) => a[1] - b[1]).slice(0, NEAR_N).flatMap(([id, d]) => (groups.get(id) || [id]).map(x => x + '~' + d + '~r'));
  return nearStops(ep).slice(0, NEAR_N).flatMap(([id, d]) => (groups.get(id) || [id]).map(x => x + '~' + Math.round(d)));
}
function nearStops(ep) {
  const near = [];
  for (const s of X.allStops()) { const d = mDist(ep.lat, ep.lon, +s[2], +s[3]); if (d <= NEAR_M) near.push([s[0], d, +s[2], +s[3]]); }
  return near.sort((a, b) => a[1] - b[1]);
}
// ---- a piedi lungo le strade (camminata.js) ----
// walkMemo: calcoli in corso o fatti (chiave -> Promise); walkVal: risultati pronti, usati in modo sincrono da cands() e baseQs()
//   «lat,lon»            Map(fermata -> metri) dal punto alle fermate vicine
//   «w|da|a»             { m, pts } tutto a piedi tra i due punti
//   «p|lat,lon|lat,lon»  { m, pts } tratto a piedi disegnato sulla mappa
const walkMemo = new Map(), walkVal = new Map();
const ptKey = ep => `${(+ep.lat).toFixed(5)},${(+ep.lon).toFixed(5)}`;
function memoWalk(k, fn) {
  if (walkMemo.has(k)) return walkMemo.get(k);
  if (walkMemo.size > 80) { walkMemo.clear(); walkVal.clear(); }
  const p = fn().then(v => { if (v == null) walkMemo.delete(k); else walkVal.set(k, v); return v; }, () => { walkMemo.delete(k); return null; });   // non riuscito: si riprova la volta dopo
  walkMemo.set(k, p); return p;
}
const isPoint = ep => ep && (ep.kind === 'me' || ep.kind === 'point') && ep.lat != null;
// ACQUA ALTA nei tratti a piedi (acqua.js, livelli.js): al livello di marea in città nell'ora del tratto, con il MOSE, i tratti allagati
// senza passerella si evitano se c'è un'altra strada e le passerelle posate si usano. Solo con la marea da +80 cm e i dati già sul telefono
// (o scaricabili in 3 s); altrimenti tutto come prima. acquaK: parte delle chiavi dei calcoli a piedi (cambia con il livello).
let acquaK = '';
const idxMemo = new Map();
async function acquaA(ms) {
  const liv = Livelli.livelloA(ms); if (!liv || !(liv.cm >= XA.MIN_ACQUA)) return null;
  const d = Livelli.pronti() || await Promise.race([Livelli.carica(), new Promise(r => setTimeout(() => r(null), 3000))]);
  if (!d) return null;
  if (d.Q.rilievo && S.from?.lat != null && S.to?.lat != null) {        // quote misurate per la zona del percorso (tessere del rilievo)
    const box = [Math.min(S.from.lat, S.to.lat) - 0.006, Math.min(S.from.lon, S.to.lon) - 0.008, Math.max(S.from.lat, S.to.lat) + 0.006, Math.max(S.from.lon, S.to.lon) + 0.008];
    await Promise.race([Livelli.prepara(box), new Promise(r => setTimeout(r, 2500))]);
  }
  const st = XA.inStagione(ms, d.P.stagione), k = `${liv.cm}${st ? 's' : ''}t${Livelli.tessere()}`;
  let pass = idxMemo.get(k); if (!pass) { if (idxMemo.size > 30) idxMemo.clear(); pass = XA.indicePasserelle(XA.posate(d.P, liv.cm, ms)); idxMemo.set(k, pass); }
  return { cm: liv.cm, Q: d.Q, pass, key: '|a' + k, mose: liv.mose };
}
// istante della ricerca (partenza o arrivo scelti, o adesso) e di un tratto a piedi di una soluzione (k = indice nella soluzione)
const searchMs = () => (S.when !== 'now' && S.time ? Viaggio.romeMs(clampDate(S.date), S.time) : Date.now());
function legMs(o, k) {
  const sn = snapOf(o); if (!sn) return searchMs();
  let j = 0, ms = sn.leaveMs;                                     // sn.legs: stesse tappe di o.tratte (senza le corse non valide)
  for (let i = 0; i < o.tratte.length && i < k; i++) {
    const t = o.tratte[i], l = sn.legs[j];
    if (t.tipo === 'piedi') { if (l?.t === 'w') j++; continue; }
    if (t.tipo === 'mezzo' && l?.t === 'r' && t.tripId) { ms = l.a.ms; j++; }
  }
  return ms;
}
const walkKey = () => (S.from?.lat != null && S.to?.lat != null ? `w|${ptKey(S.from)}|${ptKey(S.to)}${acquaK}` : null);
// prima di chiedere le soluzioni: distanze reali dai punti alle fermate vicine e percorso «tutto a piedi» (se entro 30 minuti)
async function prepWalk() {
  const jobs = [], acqua = (isPoint(S.from) || isPoint(S.to)) ? await acquaA(searchMs()) : null;
  acquaK = acqua ? acqua.key : '';
  for (const ep of [S.from, S.to]) if (isPoint(ep)) jobs.push(memoWalk(ptKey(ep) + acquaK, async () => {
    const near = nearStops(ep); if (!near.length) return null;
    const m = await Walk.distanze({ lat: +ep.lat, lon: +ep.lon }, near.map(([id, , lat, lon]) => ({ key: id, lat, lon })), 14, 4000, acqua);
    return m && m.size ? m : null;                                 // nessuna fermata raggiungibile lungo la rete: linea d'aria, come prima
  }));
  const wk = walkKey();
  if (wk && mDist(S.from.lat, S.from.lon, S.to.lat, S.to.lon) <= Walk.LIMITE_M) jobs.push(memoWalk(wk, () => Walk.percorso({ lat: +S.from.lat, lon: +S.from.lon }, { lat: +S.to.lat, lon: +S.to.lon }, 6000, acqua)));
  await Promise.all(jobs);
}
// tratto a piedi disegnato: all'ora del tratto (ms), con l'acqua alta se serve
const pathFor = async (a, b, ms) => {
  const acqua = await acquaA(ms ?? searchMs());
  return memoWalk(`p|${a[0].toFixed(5)},${a[1].toFixed(5)}|${b[0].toFixed(5)},${b[1].toFixed(5)}${acqua ? acqua.key : ''}`, () => Walk.percorso({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }, 6000, acqua));
};
// testo breve per un tratto a piedi con l'acqua alta: passerelle usate e acqua inevitabile
function acquaTxt(w) {
  const a = w?.acqua; if (!a) return '';
  const pp = a.passerelle.map(p => p.d.replace(/^Da /, 'da ')).slice(0, 2), out = [];
  if (a.passerella >= 5 && pp.length) out.push(`su passerella ${pp.length === 1 ? pp[0] : pp.length + ' tratti'} (posata da ${Math.min(...a.passerelle.map(p => p.q))} cm)`);
  const m = Math.round(a.bagnati / 10) * 10 || 5, cm = Math.max(2, Math.round(a.prof));
  const qual = (a.stimati ?? a.bagnati) * 2 > a.bagnati ? 'stima' : 'quote del rilievo';   // quote misurate (RAMSES) per più di metà dei metri bagnati
  if (a.bagnati >= 5) out.push(cm < 10 ? `acqua bassa possibile per circa ${m} m (pochi cm, ${qual})` : `acqua possibile per circa ${m} m, fino a ~${cm} cm (${qual}): ${cm < 30 ? 'stivali' : 'stivali alti'}`);
  return out.join(' · ');
}
// ACQUA ALTA SULLE SCHEDE: i tratti a piedi di ogni soluzione (stessi capi del disegno sulla mappa, all'ora del tratto) si calcolano sul
// telefono appena compaiono le soluzioni, e la scheda dice se si cammina all'asciutto, su passerella o con l'acqua. Solo da +80 cm in città.
const acqSol = new Map(), acqWait = new Set();                    // chiave soluzione -> testo
const acqKey = o => { const sn = snapOf(o); return `${solId(o)}|${sn?.leaveMs ?? ''}|${S.from ? epSig(S.from) : ''}|${S.to ? epSig(S.to) : ''}`; };
function walkSegs(o) {
  const F = S.from, T = S.to, out = []; let prev = F?.lat != null ? [F.lat, F.lon] : null;
  const add = (a, b, k) => { if (a && b && mDist(a[0], a[1], b[0], b[1]) >= 15) out.push({ a, b, ms: legMs(o, k) }); };
  o.tratte.forEach((t, k) => {
    if (t.tipo === 'piedi') { const p = t.a?.lat != null ? [t.a.lat, t.a.lon] : t.estremo === 'arrivo' && T?.lat != null ? [T.lat, T.lon] : null; if (t.da?.lat != null) prev = [t.da.lat, t.da.lon]; add(prev, p, k); if (p) prev = p; return; }
    const start = t.da?.lat != null ? [t.da.lat, t.da.lon] : null; if (prev && start && mDist(prev[0], prev[1], start[0], start[1]) > 25) add(prev, start, k);
    prev = t.a?.lat != null ? [t.a.lat, t.a.lon] : prev;
  });
  const last = o.tratte[o.tratte.length - 1];
  if (T?.lat != null && prev && last?.tipo === 'mezzo' && mDist(prev[0], prev[1], T.lat, T.lon) > 25) add(prev, [T.lat, T.lon], o.tratte.length);
  return out;
}
async function acquaSol(o) {
  const segs = walkSegs(o); if (!segs.length) return '';
  const ws = await Promise.all(segs.map(g => pathFor(g.a, g.b, g.ms)));
  const m = { bagnati: 0, passerella: 0, prof: 0, passerelle: [], stimati: 0 }; let any = false;
  for (const w of ws) {
    const a = w?.acqua; if (!a) continue; any = true;
    m.bagnati += a.bagnati; m.passerella += a.passerella; m.prof = Math.max(m.prof, a.prof); m.stimati += a.stimati ?? a.bagnati;
    for (const p of a.passerelle) if (!m.passerelle.some(x => x.d === p.d)) m.passerelle.push(p);
  }
  if (!any) return '';
  const t = acquaTxt({ acqua: m });
  return t ? 'A piedi: ' + t : 'A piedi all\'asciutto (stima)';
}
function acqLine(o) {
  const t = acqSol.get(acqKey(o)); if (!t) return '';
  return `<span class="pp-acl">${icon('passerella', 'sm')}<span>${esc(t)}</span></span>`;
}
// dopo aver disegnato l'elenco o il dettaglio: calcola le schede che mancano e le completa senza ridisegnare tutto
function fillAcqua(list) {
  const lv = Livelli.livelloA(searchMs()); if (!(lv?.cm >= XA.MIN_ACQUA)) return;
  if (acqSol.size > 60) acqSol.clear();
  for (const o of list) {
    const k = acqKey(o); if (acqSol.has(k) || acqWait.has(k)) continue;
    acqWait.add(k);
    acquaSol(o).then(t => {
      acqWait.delete(k); acqSol.set(k, t || ''); if (!t) return;
      for (const b of X.plist.querySelectorAll('.pp-opt[data-sid]')) if (b.dataset.sid === k && !b.querySelector('.pp-acl')) b.insertAdjacentHTML('beforeend', acqLine(o));
      const tb = S.det && acqKey(S.det) === k && X.plist.querySelector('.pp-tide > span');
      if (tb && !tb.querySelector('.pp-acqt')) tb.insertAdjacentHTML('beforeend', `<span class="pp-acqt">${esc(t)}</span>`);
    }, () => acqWait.delete(k));
  }
}
const epName = ep => (ep ? ep.label : '');
// PERCORSI RECENTI (v29), solo sul telefono: gli ultimi 5 cercati, offerti tra i suggerimenti quando il campo è vuoto. «La mia posizione» si
// salva senza coordinate (al momento dell'uso si prende quella di adesso). Il modulo NON si riempie da solo con un percorso vecchio.
const STALE_MS = 30 * 60000;                                       // dopo 30 minuti senza usarlo il pianificatore si riapre pulito
const epKeep = ep => (!ep ? null : ep.kind === 'me' ? { kind: 'me', label: 'La mia posizione' } : (ep.kind === 'stop' || ep.kind === 'zone' || ep.kind === 'point') ? { ...ep } : null);
const epSig = ep => (!ep ? '' : ep.kind === 'stop' ? 'f:' + ep.id : ep.kind === 'zone' ? 'z:' + ep.key : ep.kind === 'me' ? 'me' : `p:${(+ep.lat).toFixed(4)},${(+ep.lon).toFixed(4)}`);
let recenti = [];
const save = () => {};                                             // (prima: partenza e arrivo rimessi nel modulo alla riapertura)
function addRecent() {
  const from = epKeep(S.from), to = epKeep(S.to); if (!from || !to) return;
  const sig = epSig(from) + '>' + epSig(to);
  recenti = [{ from, to, at: Date.now() }, ...recenti.filter(r => epSig(r.from) + '>' + epSig(r.to) !== sig)].slice(0, 5);
  keepRecenti();
}
const recSig = r => epSig(r.from) + '>' + epSig(r.to);
const keepRecenti = () => { try { localStorage.setItem(KEY, JSON.stringify({ v: 2, recenti })); } catch { /* facoltativo */ } };
// MODIFICA DI UN RECENTE (v33.5): stessa posizione e stessa data; se diventa uguale a un altro recente, l'altro si toglie (niente doppioni).
// -> 'ok' | 'same' (partenza = arrivo) | 'missing'
function updateRecent(k, from, to) {
  const i = recenti.findIndex(x => recSig(x) === k), f = epKeep(from), t = epKeep(to); if (i < 0 || !f || !t) return 'missing';
  if (epSig(f) === epSig(t)) return 'same';
  const n = { from: f, to: t, at: recenti[i].at }, ns = recSig(n);
  recenti = recenti.map((x, j) => (j === i ? n : x)).filter((x, j) => j === i || recSig(x) !== ns);
  keepRecenti(); return 'ok';
}
function removeRecent(k) { recenti = recenti.filter(x => recSig(x) !== k); keepRecenti(); }
function restore() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (d?.v === 2 && Array.isArray(d.recenti)) recenti = d.recenti.filter(r => r && epKeep(r.from) && epKeep(r.to)).slice(0, 5);
    else if (d?.v === 1 && d.from && d.to) recenti = [{ from: d.from, to: d.to, at: 0 }];   // versione precedente: l'ultimo percorso diventa un recente
  } catch { /* niente */ }
  let old = null;
  try { const o = JSON.parse(localStorage.getItem(KEY_OPZ) || 'null'); if (o && typeof o === 'object') { old = o; for (const k in OPZ0) if (o[k] != null && typeof o[k] === typeof OPZ0[k]) S.opz[k] = o[k]; } } catch { /* niente */ }
  // v28: passo «lento» o tempo «largo» per i cambi -> andatura «con calma»; passo «veloce» -> «svelta»; il limite a piedi per tratto non c'è più
  if (old && (old.passo === 'lento' || old.margine === 'largo')) S.opz.passo = 'calma';
  else if (S.opz.passo === 'veloce') S.opz.passo = 'svelta';
  if (!['calma', 'normale', 'svelta'].includes(S.opz.passo)) S.opz.passo = 'normale';
  if (!['equilibrata', 'piedi', 'cambi', 'veloce'].includes(S.opz.pref)) S.opz.pref = 'equilibrata';
  // versioni precedenti: battelli, bus e tram separati (il tram era già compreso nei bus)
  if (Array.isArray(S.opz.mezzi)) S.opz.mezzi = [...new Set(S.opz.mezzi.map(m => (m === 'bus' || m === 'tram' ? 'aut' : m)).filter(m => m === 'nav' || m === 'aut'))];
  if (!Array.isArray(S.opz.mezzi) || !S.opz.mezzi.length) S.opz.mezzi = [...OPZ0.mezzi];
  // v27: preferenze come nelle app di trasporto (Migliore, Meno cambi, Meno a piedi); «Più veloce» e il tetto ai cambi non ci sono più
  if (S.opz.pref === 'veloce') S.opz.pref = 'equilibrata';
}
const saveOpz = () => { try { localStorage.setItem(KEY_OPZ, JSON.stringify(S.opz)); } catch { /* facoltativo */ } };
// filtri diversi da quelli normali: numero (per il pulsante) e parametri della richiesta
const opzCount = () => Object.keys(OPZ0).filter(k => String(S.opz[k]) !== String(OPZ0[k])).length;
const MEZZI = [['nav', 'ship', 'Navigazione'], ['aut', 'bus', 'Automobilistico']];
const mezziTxt = () => (S.opz.mezzi.length < 2 ? 'solo ' + (S.opz.mezzi[0] === 'nav' ? 'navigazione' : 'automobilistico') : '');
function opzQs() {
  const o = S.opz; let q = '';
  if (o.mezzi.length < 2) q += '&mezzi=' + o.mezzi.join(',');
  if (o.pref !== 'equilibrata') q += '&pref=' + o.pref;
  if (o.passo === 'calma') q += '&passo=lento&margine=largo';
  else if (o.passo === 'svelta') q += '&passo=veloce';
  return q;
}

export function init(ctx) {
  X = ctx; restore();
  Viaggio.onChange(onVg); vgLastId = Viaggio.active()?.viaggio || null;
  X.map?.on('dragstart zoomstart', userMove);                            // mappa spostata o ingrandita a mano (non dall'inquadratura automatica)
  // cambio di tema chiaro/scuro: i tratti a piedi sulla mappa si ridisegnano con i colori giusti
  new MutationObserver(() => { if (X.isOpen() && (S.res || S.det)) draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // dati della marea arrivati dopo il pianificatore: nota sulla marea nel dettaglio e acqua alta sulle schede, senza ridisegnare tutto
  window.addEventListener('tpl:tide', () => {
    if (!X.isOpen() || vgShown()) return;
    if (S.det && !X.plist.querySelector('.pp-tide')) { const h = tideHtml(S.det, snapOf(S.det)), st = X.plist.querySelector('.pp-steps'); if (h && st) st.insertAdjacentHTML('beforebegin', h); }
    if (S.det) fillAcqua([S.det]); else if (S.res?.soluzioni?.length) fillAcqua(S.res.soluzioni);
  });
  X.chips.addEventListener('click', onClick); X.plist.addEventListener('click', onClick);
  X.chips.addEventListener('input', e => { if (e.target.matches('.pp-q')) { S.q = e.target.value; renderSuggest(); } });
  X.plist.addEventListener('input', e => { if (e.target.matches('.pp-dn') && S.draft) S.draft.name = e.target.value; });
  X.plist.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.pp-dn')) { e.preventDefault(); saveDraft(false); } });
  X.chips.addEventListener('change', e => {
    if (e.target.matches('.pp-time') && e.target.value) { S.time = e.target.value; run(); }
    if (e.target.matches('.pp-date')) { S.date = clampDate(e.target.value); e.target.value = S.date; run(); }
  });
  X.chips.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.pp-q')) { const f = X.plist.querySelector('.pp-sug'); if (f) f.click(); } if (e.key === 'Escape' && (S.edit || S.draft)) { e.stopPropagation(); back(); } });
}
export const isPicking = () => !!S.picking;
// livelli interni del pianificatore per il tasto «indietro» (nav.js): ricerca di un punto, opzioni, dettaglio di una soluzione
export const depth = () => (vgShown() ? 0 : (S.edit ? 1 : 0) + (S.draft ? 1 : 0) + (S.draftF ? 1 : 0) + (S.showOpz ? 1 : 0) + (formShown() && S.from && S.to ? 1 : 0) + (S.det ? 1 : 0));
export function back() {
  if (vgShown()) return false;                                     // schermata «In viaggio»: «indietro» chiude il pannello (il viaggio continua)
  if (S.draftF) { S.draftF = null; S.q = ''; render(); return true; }   // scelta di un punto della bozza -> scheda di modifica
  if (S.draft) { S.draft = null; render(); return true; }               // scheda di modifica -> elenchi (nulla salvato)
  if (S.edit) { S.edit = null; S.lst = null; S.q = ''; render(); draw(); return true; }
  if (S.showOpz) { const d = S.opzDirty; S.showOpz = false; S.opzDirty = false; renderForm(); if (d) run(); else renderBody(); X.changed?.(); return true; }
  if (S.formOpen && S.from && S.to) { S.formOpen = false; render(); return true; }   // modulo riaperto: si richiude nella riga riassuntiva
  if (S.det) { S.sel = -1; S.det = null; S.tall = false; renderBody(); draw(); return true; }
  return false;
}
// TRE LIVELLI DEL PANNELLO (per vedere il percorso sulla mappa anche con il pianificatore aperto):
//   form  campi completi (partenza, arrivo, quando, opzioni): finché manca un punto, o riaperti con «Modifica»
//   list  partenza e arrivo scelti: i campi diventano UNA riga riassuntiva (toccandola si riaprono); sotto, le soluzioni
//   det   una soluzione scelta: il foglio si abbassa ancora (sul telefono circa 40% dello schermo) e la mappa mostra il percorso intero;
//         «Soluzioni» torna alla lista, la freccia ⌃ allarga il foglio per leggere tutte le tappe (⌄ lo riabbassa)
// VIAGGIO GUIDATO: la schermata «In viaggio» usa il livello «det» (foglio basso, mappa con il percorso, freccia per allargarlo)
let vgSol = null;                                                  // soluzione del viaggio in corso (solo in memoria: serve per disegnarlo)
const vgShown = () => !!(S.vg && Viaggio.active());
export const inVg = () => vgShown();
const formShown = () => !vgShown() && !!(S.edit || S.showOpz || !S.from || !S.to || S.formOpen);
export const level = () => (vgShown() ? 'det' : formShown() ? 'form' : S.det ? 'det' : 'list');
export const isTall = () => !!((S.det || vgShown()) && S.tall && !formShown());
// a tutto schermo sul telefono finché non ci sono soluzioni da guardare sulla mappa
export const wantsFull = () => !vgShown() && !!(S.edit || S.showOpz || !S.from || !S.to || (!S.res && !S.err));
// corse della soluzione disegnata sulla mappa («src:corsa»): i soli mezzi da mostrare mentre il pianificatore è aperto
export function tripsShown() {
  const out = new Set();
  if (vgShown()) { for (const l of Viaggio.active().legs) if (l.t === 'r') out.add(`${l.src}:${l.trip}`); return out; }
  const o = S.det || S.res?.soluzioni?.[0];
  for (const t of o?.tratte || []) if (t.tipo === 'mezzo' && t.tripId) out.add(`${t.src}:${t.tripId}`);
  return out;
}
// percorso preferito (stella nell'intestazione del pannello): c'è un percorso completo? è già salvato?
export const canSave = () => !vgShown() && !!(S.from && S.to);
// link condivisibile: codice di un punto (fermata f:, zona z:, punto della mappa p:); «la mia posizione» non si condivide mai
const epCode = ep => (!ep ? null : ep.kind === 'stop' ? 'f:' + ep.id : ep.kind === 'zone' ? 'z:' + ep.key : ep.kind === 'point' ? `p:${(+ep.lat).toFixed(5)},${(+ep.lon).toFixed(5)}` : null);
// con un orario scelto il link lo porta con sé (giorno, ora, «partenza»/«arrivo entro»); con «Adesso» chi lo apre vede il suo adesso
// (v33.2) con una proposta aperta nel dettaglio, il link è quello della proposta (si riapre il suo dettaglio, non l'elenco)
export const shareCodes = () => {
  const base = { da: epCode(S.from), a: epCode(S.to) }, sn = S.det && !vgShown() ? snapOf(S.det) : null;
  if (sn) return { ...base, ...Viaggio.linkParams(sn) };
  return { ...base, ...(S.when !== 'now' && S.time ? { quando: S.when === 'by' ? 'arrivo' : 'partenza', ora: S.time.replace(':', ''), data: clampDate(S.date).replace(/-/g, '') } : {}) };
};
export const isSaved = () => Fav.hasRoute(S.from, S.to);
export function toggleSaved() { if (!canSave()) return undefined; const r = Fav.toggleRoute(S.from, S.to); X.favChanged?.(); if (S.edit && !S.q) renderSuggest(); return r; }

// apre la pianificazione (from: punto di partenza già scelto, es. una fermata)
export function show(opts = {}) {
  // viaggio in corso: il pianificatore si apre sulla schermata «In viaggio» (non quando si chiede un percorso preciso, es. «Percorso da qui»)
  S.vg = !!Viaggio.active() && (opts.viaggio || !(opts.from || opts.to));
  if (vgShown()) { S.edit = null; S.showOpz = false; vgTop = true; render(); draw(); return; }
  // riaperto dopo più di 30 minuti (o alla prima apertura): pulito, da «la mia posizione», «Adesso». Entro 30 minuti resta com'era.
  if (!opts.from && !opts.to && Date.now() - (S.usedAt || 0) > STALE_MS) {
    Object.assign(S, { from: null, to: null, res: null, det: null, sel: -1, alts: null, sim: null, more: null, err: null, showOpz: false, formOpen: false, edit: null, lst: null, ren: null, draft: null, draftF: null, q: '', when: 'now', walkShow: false, tall: false });
  }
  S.usedAt = Date.now();
  if (opts.from || opts.to) { S.res = null; S.det = null; S.sel = -1; S.alts = null; S.showOpz = false; }
  if (opts.from) S.from = opts.from; if (opts.to) S.to = opts.to;
  if (opts.from && opts.to && !opts.quando) S.when = 'now';        // percorso salvato, recente o link senza orario: si parte da «Adesso»
  if (opts.quando && /^\d{2}:\d{2}$/.test(opts.ora || '')) { S.when = opts.quando === 'arrivo' ? 'by' : 'at'; S.time = opts.ora; S.date = clampDate(opts.data || today()); }
  // PROPOSTA DA RIAPRIRE (viaggio salvato o link di una proposta, v33.2): già partita -> alternative di adesso con un messaggio; entro 90 minuti ->
  // ricerca «Adesso» (tempo reale); più avanti -> ricerca all'orario della proposta. La proposta si cerca poi tra le soluzioni e gli «altri orari».
  S.want = null; S.notice = null;
  if (opts.want) {
    const mode = Viaggio.reopenMode(opts.want);
    if (mode === 'passata') { S.when = 'now'; S.notice = { kind: 'passata', w: opts.want }; }
    else { S.want = opts.want; if (mode === 'adesso') S.when = 'now'; else { S.when = 'at'; S.time = opts.want.parti; S.date = clampDate(opts.want.date); } }
  }
  // percorso salvato con «la mia posizione»: quella di adesso (se non c'è ancora, si chiede)
  for (const f of ['from', 'to']) if (S[f]?.kind === 'me' && S[f].lat == null) { const me = X.me(); if (me) S[f] = meEp(me); else { S[f] = null; S.edit = f; S.asked = f; X.locate(); } }
  if (!S.from && X.me()) S.from = meEp(X.me());
  X.pbadge.innerHTML = `<span class="pp-hic">${icon('route')}</span>`;
  X.pname.innerHTML = '<span>Pianifica percorso</span>';
  X.psub.textContent = ''; X.pstatus.textContent = '';
  if (!S.edit && (!S.from || !S.to)) S.edit = !S.from ? 'from' : 'to';
  render();
  if (S.from && S.to && !S.res) run(); else draw();
}
export function clear() { if (S.from || S.to) S.usedAt = Date.now(); viewKey = solKey = ''; lastPts = []; clearInterval(timer); timer = null; clearTimeout(retry); S.picking = null; X.layer.clearLayers(); X.setPick(false); }
export function refresh() { if (S.res && S.when === 'now' && !S.edit) run(true); }
// posizione arrivata (dopo la richiesta da «La mia posizione»)
export function onPosition(ll) {
  if (!ll || !S.asked) return;
  const f = S.asked; S.asked = 0;
  S[f] = meEp(ll); S.edit = null; save(); render(); run();
}
// punto toccato sulla mappa in modalità «scegli sulla mappa»
export function pick(ll) {
  const f = S.picking; if (!f) return false;
  S.picking = null; X.setPick(false);
  if (!ll) { render(); return true; }                          // annullato
  if (S.draft && S.draftF === f) { S.draft[f] = { kind: 'point', label: 'Punto sulla mappa', lat: ll.lat, lon: ll.lng }; S.draftF = null; render(); return true; }
  S[f] = { kind: 'point', label: 'Punto sulla mappa', lat: ll.lat, lon: ll.lng }; S.edit = null; render(); run();
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// RICERCA
// ---------------------------------------------------------------------------------------------------------------------
// parametri comuni di /api/percorso e /api/percorso-simili (null se mancano i punti)
function baseQs(over = null) {
  const da = cands(S.from), a = cands(S.to);
  if (!da || !a || !da.length || !a.length) return null;
  let qs = `da=${encodeURIComponent(da.join(','))}&a=${encodeURIComponent(a.join(','))}`;
  const wv = walkVal.get(walkKey());
  if (wv) qs += `&piedi=${wv.m}&piedir=1`;                       // tutto a piedi: metri lungo le strade
  else if (S.from.lat != null && S.to.lat != null) qs += `&piedi=${Math.round(mDist(S.from.lat, S.from.lon, S.to.lat, S.to.lon))}`;
  if (over) {                                                     // «più tardi» / «prima»: orario dato, stesso giorno
    qs += `&secs=${over.secs}&date=${over.date.replace(/-/g, '')}`;
    if (over.entro) qs += '&arrivo=1';
  } else if (S.when !== 'now' && S.time) {
    const [h, m] = S.time.split(':').map(Number);
    qs += `&secs=${h * 3600 + m * 60}&date=${clampDate(S.date).replace(/-/g, '')}`;
    if (S.when === 'by') qs += '&arrivo=1';
  }
  return qs + opzQs();
}
async function run(quiet) {
  // nuova ricerca: i risultati vecchi spariscono subito (niente proposte di un altro orario o di un altro giorno mentre si aspetta)
  if (!quiet && !S.want && S.notice?.used) S.notice = null; else if (S.notice) S.notice.used = true;
  if (!quiet) { S.walkShow = false; S.more = null; S.sim = null; if (S.from && S.to) { S.loading = true; S.res = null; S.err = null; S.sel = -1; S.det = null; S.alts = null; renderBody(); draw(); } }
  const my0 = ++token; await prepWalk(); if (my0 !== token) return;   // al massimo pochi secondi (la prima volta); poi linea d'aria
  const da = cands(S.from), a = cands(S.to);
  if (!da || !a) { S.res = null; render(); return; }
  if (!da.length || !a.length) { S.res = null; S.err = `Nessuna fermata entro 1,5 km dal punto di ${!da.length ? 'partenza' : 'arrivo'}.`; renderBody(); return; }
  const qs = '/api/percorso?' + baseQs();
  const my = ++token; clearTimeout(retry); S.loading = !quiet; S.err = null; if (!quiet) { S.sel = -1; S.det = null; S.alts = null; renderBody(); }
  try {
    const r = await api(qs);
    if (my !== token) return;
    if (r.error) throw new Error(r.error);
    S.res = r; S.loading = false; S.wait = null; riuscito('plan'); S.usedAt = Date.now();
    if (!quiet) addRecent();
    if (r.soluzioni.length) loadSim(r.soluzioni[0]);
    if (S.sel >= r.soluzioni.length) { S.sel = -1; S.det = null; }
    else if (S.sel >= 0) { const f = S.det?.famiglia, k = r.soluzioni.findIndex(o => o.famiglia === f); if (k >= 0) { S.sel = k; S.det = r.soluzioni[k]; } }   // stesso percorso, orari aggiornati
    if (S.want) {                                                    // proposta da riaprire: tra le soluzioni, poi tra gli altri orari dello stesso percorso
      const want = S.want; S.want = null;
      const k = r.soluzioni.findIndex(o => Viaggio.solTrips(o) === want.trips);
      if (k >= 0) { S.sel = k; S.det = r.soluzioni[k]; S.formOpen = false; }
      else findWanted(want, my);
    }
  } catch (e) {
    if (my !== token) return; S.loading = false;
    if ((e.loading || e.busy) && ritenta('plan', () => { if (X.isOpen() && my === token) run(quiet); }, 2500)) { S.loading = true; S.wait = e.loading ? 'orari' : 'occupato'; if (!quiet || e.loading) { S.res = null; S.more = null; S.sim = null; draw(); } renderBody(); return; }   // orari di un'altra data in caricamento o server occupato: si riprova da soli, con un limite
    if (e.loading || e.busy) e = new Error(NON_ORA);
    if (!quiet || !S.res) { S.res = null; S.err = 'Ricerca non riuscita: ' + e.message; }
  }
  renderBody(); draw();
  clearInterval(timer); timer = S.when === 'now' && S.res ? setInterval(() => { if (X.isOpen() && !S.edit && !vgShown() && !document.hidden) run(true); }, REFRESH_MS) : null;
}

// proposta non tra le soluzioni: stesso percorso ad altri orari (/api/percorso-simili, la stessa richiesta del dettaglio); se non c'è,
// messaggio chiaro sopra le soluzioni migliori di adesso (mai una schermata vuota)
async function findWanted(want, my) {
  const base = baseQs(); let x = null;
  if (base && want.fam && want.rotte?.length) {
    try {
      const r = await api(`/api/percorso-simili?${base}&fam=${encodeURIComponent(want.fam)}&rotte=${encodeURIComponent(want.rotte.join(','))}${want.arrivi ? `&arr=${encodeURIComponent(want.arrivi)}` : ''}`);
      if (!r.error) x = ['stesso', 'varianti', 'altre'].flatMap(k => r[k] || []).find(o => Viaggio.solTrips(o) === want.trips) || null;
    } catch { /* sotto: messaggio */ }
  }
  if (my !== token) return;
  if (x) { S.det = x; S.sel = -1; S.formOpen = false; renderForm(); renderBody(); draw(); return; }
  S.notice = { kind: 'cambiata', w: want, used: true }; renderBody();
}
// SCIOPERO (v33.3): avvertenza in cima alle soluzioni e nel dettaglio quando i viaggi cadono nella finestra dello sciopero
function strikeOf(list) {
  const sn = (list || []).map(snapOf).filter(Boolean); if (!sn.length) return '';
  return Avvisi.strikeNoteHtml(Avvisi.strikeFor(Math.min(...sn.map(x => x.leaveMs)), Math.max(...sn.map(x => x.arriveMs))), 'viaggio');
}
const noticeHtml = () => {
  const n = S.notice; if (!n) return '';
  const w = n.w, what = `${w.parti}${w.arrivi ? `–${w.arrivi}` : ''}${w.linee ? ` · ${w.linee}` : ''}`;
  const txt = n.kind === 'passata' ? `La proposta delle ${what} è già partita.` : `La proposta delle ${what} non c'è più: gli orari o il tempo reale sono cambiati.`;
  return `<p class="pp-notice" role="status">${icon('info', 'sm')}<span><b>${esc(txt)}</b><small>Qui sotto le soluzioni migliori per lo stesso tragitto.</small></span></p>`;
};
// alternative della soluzione nel dettaglio: stesso percorso ad altri orari, una linea diversa, altre linee (caricate quando si apre)
async function loadAlts(o) {
  const key = o.famiglia + '|' + (S.res?.aggiornato || ''); if (S.alts?.key === key) return;
  const base = baseQs(); if (!base) return;
  S.alts = { key, loading: true };
  try {
    const r = await api(`/api/percorso-simili?${base}&fam=${encodeURIComponent(o.famiglia)}&rotte=${encodeURIComponent(o.rotte.join(','))}&arr=${encodeURIComponent(o.arrivi)}`);
    if (S.alts?.key !== key) return;
    if (r.error) throw new Error(r.error);
    S.alts = { key, data: r };
  } catch { if (S.alts?.key === key) S.alts = { key, err: true }; }
  if (S.det && S.det.famiglia === o.famiglia && !S.showOpz && !S.edit) renderAlts();
}

// ---------------------------------------------------------------------------------------------------------------------
// INTERFACCIA
// ---------------------------------------------------------------------------------------------------------------------
function render() {
  if (vgShown()) { renderVg(); X.favChanged?.(); X.changed?.(); return; }
  X.pname.innerHTML = '<span>Pianifica percorso</span>';
  renderForm(); if (S.edit) renderSuggest(); else renderBody(); X.favChanged?.(); X.changed?.();
}
// schermata «In viaggio»
let vgTop = false;                                                  // entrando nella schermata «In viaggio» si parte dall'alto (non dallo scorrimento del dettaglio)
function renderVg() {
  X.chips.innerHTML = '';
  X.pbadge.innerHTML = `<span class="pp-hic">${icon('route')}</span>`; X.pname.innerHTML = '<span>In viaggio</span>'; X.psub.textContent = ''; X.pstatus.textContent = '';
  X.plist.innerHTML = `<div class="pp-dhead"><button type="button" class="linkback vg-plan">${icon('back', 'sm')}<span>Pianifica un altro percorso</span></button>`
    + `<button type="button" class="ibtn sm pp-tall" aria-pressed="${S.tall}" aria-label="${S.tall ? 'Abbassa il pannello e mostra di più la mappa' : 'Alza il pannello per leggere tutte le tappe'}" title="${S.tall ? 'Più mappa' : 'Più tappe'}">${icon(S.tall ? 'down' : 'up', 'sm')}</button></div>`
    + vgAltHtml() + Viaggio.viewHtml();
  if (vgTop) { vgTop = false; X.plist.scrollTop = 0; }
}
function leaveVg(other = false) {
  S.vg = false; vgEndArm = 0;
  if (other) { S.det = null; S.sel = -1; S.tall = false; S.formOpen = true; }   // «Pianifica un altro percorso»: campi aperti per cambiare partenza e arrivo
  if (!S.from || !S.to) S.edit = !S.from ? 'from' : 'to';
  render(); draw();
}
let vgEndArm = 0, vgLastId = null;
// aggiornamenti del viaggio (conto alla rovescia ogni 15 s, tempo reale, inizio e fine)
function onVg(j) {
  const id = j?.viaggio || null, changed = id !== vgLastId; vgLastId = id;
  if (j) checkVgAlt(j); else vgAlt = null;
  if (!X?.isOpen()) return;
  if (S.vg && !j) { if (!vgStarting) leaveVg(); return; }                                   // viaggio terminato
  if (vgShown()) { if (changed || !Viaggio.updateView(X.plist)) { const keep = !vgTop && !changed, y = X.plist.scrollTop; renderVg(); if (keep) X.plist.scrollTop = y; else X.plist.scrollTop = 0; } return; }
  if (changed && S.edit && !S.q) renderSuggest();                          // riga «Viaggio in corso» nei suggerimenti
}
function fieldHtml(f) {
  const ep = S[f], lab = f === 'from' ? 'Da' : 'A';
  const val = ep ? `${ep.kind === 'me' ? icon('locate', 'sm') : ep.kind === 'point' ? icon('pin', 'sm') : srcIcon(ep.src, 'sm')}<span>${esc(epName(ep))}</span>`
    : `<span class="pp-ph">${f === 'from' ? 'Punto di partenza' : 'Dove vuoi andare?'}</span>`;
  // × per togliere il punto scelto (accanto al campo, non dentro: un pulsante non può contenerne un altro)
  return `<div class="pp-fw"><button type="button" class="pp-f" data-f="${f}" aria-label="${lab}: ${esc(ep ? epName(ep) : 'da scegliere')}"><small>${lab}</small><span class="pp-v">${val}</span></button>`
    + (ep ? `<button type="button" class="ibtn sm pp-fx" data-clr="${f}" aria-label="Cancella ${f === 'from' ? 'la partenza' : "l'arrivo"}" title="Cancella">${icon('close', 'sm')}</button>` : '') + '</div>';
}
// riga riassuntiva del modulo (livelli list e det): da → a, quando, opzioni; toccandola si riaprono i campi
const epIc = ep => (ep.kind === 'me' ? icon('locate', 'sm') : ep.kind === 'point' ? icon('pin', 'sm') : srcIcon(ep.src, 'sm'));
const dmy = d => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
function miniHtml() {
  const nf = opzCount(), when = S.when === 'now' ? 'Adesso' : `${S.when === 'by' ? 'Arrivo entro le' : 'Partenza alle'} ${esc(S.time || '')}${S.date && S.date !== today() ? ` · ${dmy(S.date)}` : ''}`;
  const lab = `Modifica partenza, arrivo e orario. Ora: da ${epName(S.from)} a ${epName(S.to)}, ${when.toLowerCase()}`;
  return `<div class="pp pp-mini"><button type="button" class="pp-sum" data-expand aria-expanded="false" aria-label="${esc(lab)}">`
    + `<span class="pp-sum-l"><span class="pp-sum-pts"><span class="pp-sum-p">${epIc(S.from)}<span>${esc(epName(S.from))}</span></span>${icon('next', 'sm pp-sum-a')}<span class="pp-sum-p">${epIc(S.to)}<span>${esc(epName(S.to))}</span></span></span>`
    + `<span class="pp-sum-w">${when}${mezziTxt() ? ` · ${mezziTxt()}` : ''}${nf ? ` · ${nf} ${nf > 1 ? 'opzioni' : 'opzione'}` : ''}</span></span>`
    + `<span class="pp-sum-e">${icon('edit', 'sm')}<span>Modifica</span></span></button></div>`;
}
function renderForm() {
  if (vgShown()) { X.chips.innerHTML = ''; return; }
  if (S.edit && S.draft && !S.draftF) {
    X.chips.innerHTML = `<div class="pp pp-editing"><div class="pp-qwrap"><button type="button" class="ibtn sm pp-qback" aria-label="Annulla la modifica">${icon('back')}</button><b class="pp-dtitle">Modifica percorso</b></div></div>`;
    return;
  }
  if (S.edit) {
    const ph = S.draftF ? (S.draftF === 'from' ? 'Nuova partenza: fermata o luogo' : 'Nuovo arrivo: fermata o luogo') : S.edit === 'from' ? 'Partenza: fermata o luogo' : 'Arrivo: fermata o luogo';
    X.chips.innerHTML = `<div class="pp pp-editing"><div class="pp-qwrap"><button type="button" class="ibtn sm pp-qback" aria-label="Annulla">${icon('back')}</button>`
      + `<span class="xwrap"><input class="pp-q" type="search" enterkeyhint="search" autocomplete="off" maxlength="80" placeholder="${ph}" aria-label="${(S.draftF || S.edit) === 'from' ? 'Cerca il punto di partenza' : 'Cerca il punto di arrivo'}" value="${esc(S.q)}">`
      + `<button type="button" class="ibtn sm xbtn" data-x aria-label="Cancella il testo"${S.q ? '' : ' hidden'}>${icon('close', 'sm')}</button></span></div></div>`;
    const inp = X.chips.querySelector('.pp-q'); if (inp && document.activeElement !== inp) setTimeout(() => inp.focus(), 30);
    return;
  }
  if (S.from && S.to && !S.formOpen && !S.showOpz) { X.chips.innerHTML = miniHtml(); return; }
  const at = S.when !== 'now', by = S.when === 'by';
  if (at && !S.time) { const d = new Date(Date.now() + (by ? 60 : 10) * 60000); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5); S.time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
  if (at) S.date = clampDate(S.date);
  // QUANDO: interruttore a tre voci (come nelle app di mappe e trasporti): Adesso · Partenza · Arrivo; con un orario scelto, giorno e ora
  // compaiono accanto. Le date ammesse sono quelle con gli orari in archivio (le stesse della modalità «Programmato»).
  const seg = [['now', 'Adesso'], ['at', 'Partenza'], ['by', 'Arrivo']].map(([w, t]) => `<button type="button" data-w="${w}" aria-pressed="${S.when === w}" class="${S.when === w ? 'on' : ''}">${t}</button>`).join('');
  const t = today(), dateLab = !S.date || S.date === t ? 'oggi' : null;
  X.chips.innerHTML = `<div class="pp"><div class="pp-ends"><div class="pp-rail" aria-hidden="true"><span class="pp-o"></span><span class="pp-l"></span><span class="pp-d"></span></div>`
    + `<div class="pp-fields">${fieldHtml('from')}${fieldHtml('to')}</div>`
    + `<button type="button" class="ibtn sm pp-swap" aria-label="Inverti partenza e arrivo" title="Inverti">${icon('swap')}</button></div>`
    + `<div class="pp-when"><span class="pp-segw" role="group" aria-label="Quando">${seg}</span>`
    + (S.formOpen && S.from && S.to && S.res ? `<button type="button" class="nlink pp-collapse" aria-label="Riduci i campi e torna alle soluzioni">${icon('up', 'sm')}<span>Riduci</span></button>` : '')
    + (at ? `<span class="pp-tw"><button type="button" class="dtf pp-dbtn" aria-haspopup="dialog" aria-label="Giorno: ${esc(Scegli.dayLabel(S.date))}">${icon('cal', 'sm')}<span>${esc(Scegli.dayLabel(S.date))}</span></button>`
      + `<button type="button" class="dtf pp-tbtn" aria-haspopup="dialog" aria-label="${by ? 'Arrivo entro le' : 'Partenza alle'} ${esc(S.time)}">${icon('clock', 'sm')}<span>${esc(S.time)}</span></button></span>` : '')
    + `<button type="button" class="pp-opzbtn${S.showOpz ? ' on' : ''}" aria-expanded="${S.showOpz}" aria-label="Opzioni del percorso${opzCount() ? ` (${opzCount()} attive)` : ''}" title="Opzioni">${icon('sliders', 'sm')}<span class="pp-optx">Opzioni</span>${opzCount() ? `<span class="pp-cnt">${opzCount()}</span>` : ''}</button>`
    + '</div></div>';
}
// PERCORSI RECENTI E SALVATI: «Modifica» per sezione, come nel pannello Preferiti (v33.5). In modifica ogni riga ha: cambia partenza e arrivo
// (scheda di modifica qui sotto), sposta su/giù (solo salvati, come nei Preferiti), elimina.
const catHtml = (s, title) => `<div class="search-category pp-cat"><span>${title}</span><button type="button" class="nlink pp-catb" data-lst="${s}" aria-pressed="${S.lst === s}">${S.lst === s ? 'Fine' : `${icon('edit', 'sm')}Modifica`}</button></div>`;
function lstRow(s, k, r, i, n) {
  const ic = icon(s === 'route' ? 'route' : 'clock'), title = esc(s === 'route' && r.name ? r.name : r.from.label), sub = esc(s === 'route' && r.name ? `${r.from.label} → ${r.to.label}` : r.to.label);
  if (S.lst !== s) return `<button type="button" class="pp-sug" data-s="${s}" data-k="${esc(k)}">${ic}<span><b>${title}</b><small>${s === 'route' && r.name ? '' : icon('next', 'sm') + ' '}${sub}</small></span></button>`;
  const lab = esc(`${r.from.label} → ${r.to.label}`);
  return `<div class="vg-row pp-erow"><span class="pp-sug static">${ic}<span><b>${title}</b><small>${s === 'route' && r.name ? '' : icon('next', 'sm') + ' '}${sub}</small></span></span><span class="fv-acts">`
    + `<button type="button" class="ibtn sm" data-ded="${s}" data-k="${esc(k)}" aria-label="Modifica il percorso ${lab}" title="Modifica">${icon('edit', 'sm')}</button>`
    + (s === 'route' ? `<button type="button" class="ibtn sm" data-dmv="-1" data-k="${esc(k)}" aria-label="Sposta su"${i ? '' : ' disabled'}>${icon('up', 'sm')}</button>`
      + `<button type="button" class="ibtn sm" data-dmv="1" data-k="${esc(k)}" aria-label="Sposta giù"${i < n - 1 ? '' : ' disabled'}>${icon('down', 'sm')}</button>` : '')
    + `<button type="button" class="ibtn sm fv-del" data-ddel="${s}" data-k="${esc(k)}" aria-label="Elimina il percorso ${lab}" title="Elimina">${icon('trash', 'sm')}</button></span></div>`;
}
// SCHEDA DI MODIFICA (bozza): nulla si scrive finché non si tocca «Salva modifiche» (stessa voce) o «Salva come nuovo» / «Aggiungi ai salvati»
// (voce nuova, l'originale resta). Partenza e arrivo si scelgono con la stessa ricerca del pianificatore (fermate, luoghi, posizione, mappa).
function draftHtml() {
  const d = S.draft, rt = d.s === 'route';
  const fld = f => `<div class="pp-fw"><button type="button" class="pp-f pp-df" data-df="${f}" aria-label="${f === 'from' ? 'Partenza' : 'Arrivo'}: ${esc(epName(d[f]))}. Tocca per cambiare"><small>${f === 'from' ? 'Partenza' : 'Arrivo'}</small><span class="pp-v">${epIc(d[f])}<span>${esc(epName(d[f]))}</span></span></button></div>`;
  return `<div class="pp-draft"><p class="pp-dhead muted">${icon('info', 'sm')}<span>${rt ? 'Percorso salvato' : 'Percorso recente'}: tocca partenza o arrivo per cambiarli.</span></p>`
    + `<div class="pp-ends"><div class="pp-rail" aria-hidden="true"><span class="pp-o"></span><span class="pp-l"></span><span class="pp-d"></span></div><div class="pp-fields">${fld('from')}${fld('to')}</div>`
    + `<button type="button" class="ibtn sm pp-dswap" aria-label="Inverti partenza e arrivo" title="Inverti">${icon('swap')}</button></div>`
    + (rt ? `<label class="pp-dname"><small>Nome (facoltativo)</small><input type="text" class="pp-dn" maxlength="60" value="${esc(d.name || '')}" placeholder="Nome (es. Casa → Lavoro)"></label>` : '')
    + `<div class="pp-dacts"><button type="button" class="pp-act pp-dok" data-dsave>${icon('check', 'sm')}<span>Salva modifiche</span></button>`
    + `<button type="button" class="pp-act" data-dnew>${icon('star', 'sm')}<span>${rt ? 'Salva come nuovo' : 'Aggiungi ai salvati'}</span></button>`
    + `<button type="button" class="pp-act" data-dcancel>${icon('close', 'sm')}<span>Annulla</span></button></div></div>`;
}
function saveDraft(asNew) {
  const d = S.draft; if (!d) return;
  const name = X.plist.querySelector('.pp-dn')?.value ?? d.name;
  const res = d.s === 'route' ? (asNew ? Fav.addRoute(d.from, d.to, name) : Fav.updateRoute(d.k, d.from, d.to, name))
    : asNew ? Fav.addRoute(d.from, d.to) : updateRecent(d.k, d.from, d.to);
  const msg = { ok: asNew ? 'Percorso aggiunto ai salvati.' : d.s === 'recent' && Fav.hasRoute(d.from, d.to) ? 'Percorso modificato: è già tra i salvati.' : 'Percorso modificato.',
    dup: 'Questo percorso è già tra i salvati: nessun doppione creato.', same: 'Partenza e arrivo coincidono: scegline due diversi.',
    missing: 'Il percorso non c\'è più (forse eliminato in un\'altra scheda).' }[res] || 'Memoria del dispositivo non disponibile: modifica non salvata.';
  X.toast?.(msg, res === 'ok' ? 2500 : 4500);
  if (res === 'ok' || res === 'missing') { S.draft = null; S.draftF = null; X.favChanged?.(); render(); }
}
function renderSuggest() {
  if (S.draft && !S.draftF) { X.plist.innerHTML = draftHtml(); X.layer.clearLayers(); return; }
  const q = S.q.trim(), qn = norm(q.toLowerCase()), out = [];
  out.push(`<button type="button" class="pp-sug" data-s="me">${icon('locate')}<span><b>La mia posizione</b><small>usata solo sul telefono: al server vanno le fermate vicine</small></span></button>`);
  out.push(`<button type="button" class="pp-sug" data-s="map">${icon('pin')}<span><b>Scegli sulla mappa</b><small>tocca il punto sulla mappa</small></span></button>`);
  if (S.draftF) out.unshift(`<p class="pp-dhead muted pad">${icon('edit', 'sm')}<span>Scegli ${S.draftF === 'from' ? 'la nuova partenza' : 'il nuovo arrivo'} del percorso.</span></p>`);
  if (!q && !S.draftF) {
    const j = Viaggio.active();
    if (j) out.push(`<div class="search-category">Viaggio in corso</div><button type="button" class="pp-sug vg-cur" data-s="live">${icon('live')}<span><b>${esc(j.from?.label || 'Partenza')} → ${esc(j.to?.label || 'Arrivo')}</b><small>${esc(Viaggio.shortText())} · tocca per le indicazioni</small></span></button>`);
    out.push(Viaggio.savedHtml());
    const saved = new Set(Fav.allRoutes().map(r => epSig(r.from) + '>' + epSig(r.to)));
    const rec = recenti.filter(r => !saved.has(epSig(r.from) + '>' + epSig(r.to)));
    if (S.lst === 'recent' && !rec.length) S.lst = null;
    if (rec.length) out.push(catHtml('recent', 'Percorsi recenti') + rec.map((r, i) => lstRow('recent', recSig(r), r, i, rec.length)).join(''));
    const rs = Fav.allRoutes(), rsv = S.lst === 'route' ? rs : rs.slice(0, 8);   // in modifica si vedono tutti (anche oltre gli 8)
    if (S.lst === 'route' && !rs.length) S.lst = null;
    if (rs.length) out.push(catHtml('route', 'Percorsi salvati') + rsv.map((r, i) => lstRow('route', r.k, r, i, rsv.length)).join(''));
  }
  if (!q) {
    const fav = Fav.all();
    if (fav.length) out.push('<div class="search-category">Preferiti</div>' + fav.slice(0, 8).map(f => `<button type="button" class="pp-sug" data-s="fav" data-k="${esc(f.k)}">${icon('star', 'sm fav-ic')}${srcIcon(f.src)}<span>${esc(f.name)}</span></button>`).join(''));
  } else {
    const zs = [...zones.values()].filter(z => z.norm.includes(qn)).slice(0, 8);
    const ss = X.allStops().filter(s => snorm.get(s[0])?.includes(qn) && !zs.includes(zoneOf.get(s[0]))).slice(0, 10);
    if (zs.length || ss.length) out.push('<div class="search-category">Fermate</div>' + zs.map(z => `<button type="button" class="pp-sug" data-s="zone" data-k="${esc(z.key)}">${srcIcon(z.src)}<span>${esc(z.name)}</span><small class="muted">${z.letters.length} ${z.src === 'nav' ? 'pontili' : 'fermate'}</small></button>`).join('')
      + ss.map(s => `<button type="button" class="pp-sug" data-s="stop" data-k="${esc(s[0])}">${srcIcon(s[4])}<span>${esc(s[1])}</span></button>`).join(''));
    else out.push('<p class="muted pad">Nessuna fermata con questo nome: puoi scegliere il punto sulla mappa.</p>');
  }
  X.plist.innerHTML = `<div class="pp-sugs" role="listbox">${out.join('')}</div>`;
  X.layer.clearLayers();
}
// confronto di due orari «hh:mm» vicini a un riferimento (a cavallo della mezzanotte)
const hmS = (x, ref) => { const [h, m] = x.split(':').map(Number), [rh, rm] = ref.split(':').map(Number); let d = h * 60 + m - (rh * 60 + rm); if (d > 720) d -= 1440; if (d < -720) d += 1440; return d; };
const cmpHm = (a, b, ref) => hmS(a, ref) - hmS(b, ref);
const minTxt = m => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`);
const walkChip = m => `<span class="pp-w" title="A piedi ${m} min">${icon('walk', 'sm')}${m}′</span>`;
// stato della partenza della tratta, come nel pannello fermata: orario (barrato se cambia) + In orario / In ritardo / Da orario
function legStatus(s, live) {
  if (!live) return { time: `<strong>${esc(s.sched)}</strong>`, txt: '', cls: '' };
  if (s.cancel) return { time: `<strong class="late">${esc(s.sched)}</strong>`, txt: s.cancel === 'trip' ? 'Corsa soppressa' : 'Fermata saltata', cls: 'late' };
  if (!s.live) return { time: `<strong>${esc(s.sched)}</strong>`, txt: 'Da orario', cls: '' };
  const di = delayInfo(s.delay);
  return { time: (Math.abs(s.delay) >= 1 ? `<span class="sched-crossed">${esc(s.sched)}</span>` : '') + `<strong class="${di.cls}">${esc(s.exp)}</strong>`, txt: di.txt, cls: di.cls };
}
const trkIcon = (lv, live) => (live ? `<span class="pp-trk${lv ? ' on' : ''}" title="${lv ? 'Corsa in tempo reale' : 'Orario programmato'}">${icon(lv ? 'live' : 'clock', 'sm')}</span>` : '');
const stopName = st => esc(X.stopLabel(st.id) || st.name);

// AVVISO SUI CAMBI, in chiaro e con la fermata:
//   persa (tempo reale): con i ritardi di adesso il primo mezzo arriva DOPO la partenza del secondo, quindi quel cambio non riesce;
//   a rischio: il cambio si fa, ma con meno di 2 minuti di margine (basta un piccolo ritardo per perderlo).
function riskInfo(o) {
  const t = o.tratte.find(x => x.tipo === 'mezzo' && x.persa) || o.tratte.find(x => x.tipo === 'mezzo' && x.aRischio);
  if (!t) return null;
  const at = stopName(t.da);
  return t.persa ? { cls: 'lost', txt: `Con i ritardi di adesso arrivi a ${at} dopo la partenza della linea ${esc(t.line)}: questo cambio non riesce, guarda le altre soluzioni.` }
    : { cls: '', txt: `Cambio a ${at} con ${t.cambioMin < 1 ? 'meno di 1 minuto' : t.cambioMin === 1 ? '1 solo minuto' : t.cambioMin + ' minuti'} di margine: basta un piccolo ritardo per perdere la linea ${esc(t.line)}.` };
}
// passo «Cambio» nel dettaglio: margine in minuti e, se serve, cosa vuol dire
const minW = m => (m < 1 ? 'meno di 1 minuto' : m === 1 ? '1 minuto' : m + ' minuti');
const chgTitle = t => (t.persa ? 'Cambio che non riesce con i ritardi di adesso' : t.cambioMin != null ? `Cambio · ${minW(t.cambioMin)} di margine` : 'Cambio');
const chgNote = t => (t.persa ? ' · arrivi dopo la partenza: scegli un\'altra soluzione' : t.aRischio ? ' · margine stretto: tieniti pronto, un piccolo ritardo e la perdi' : '');
const riskLine = o => { const r = riskInfo(o); return (r ? `<span class="pp-risk${r.cls ? ' ' + r.cls : ''}">${icon('warn', 'sm')}<span>${r.txt}</span></span>` : '') + limitLine(o); };
// «ARRIVO ENTRO»: margine sull'orario chiesto (v33.2). Al limite (meno di 5 minuti o cambio stretto) si dice chiaramente cosa rischi; le altre «con margine»
const limitTxt = o => (o.margine == null || !S.res?.entro ? '' : o.limite
  ? `Arrivo al limite (margine ${o.margine} min${o.aRischio ? ', cambio stretto' : ''}): un piccolo ritardo può farti arrivare dopo le ${S.res.entro}.`
  : `Arrivi ${o.margine} min prima delle ${S.res.entro}.`);
const limitLine = o => (o.margine == null || !S.res?.entro ? '' : o.limite ? `<span class="pp-limit">${esc(limitTxt(o))}</span>` : `<span class="pp-ok muted">${esc(limitTxt(o))}</span>`);
// ALTRI ORARI dello stesso percorso come pulsanti sotto la scheda (non dentro: si toccano uno per uno)
function poiRow(o, k) {
  if (!o.poi?.length) return '';
  return `<div class="pp-poi" role="group" aria-label="${S.res?.entro ? 'Stesso percorso, partenze prima' : 'Stesso percorso, partenze dopo'}"><span class="muted">${S.res?.entro ? 'Anche prima, alle' : 'Anche alle'}</span>`
    + o.poi.map(x => `<button type="button" class="pp-pchip" data-k="${k}" data-poi="${esc(x.parti)}" aria-label="Partenza alle ${esc(x.parti)}, arrivo alle ${esc(x.arrivi)}"><b>${esc(x.parti)}</b><small>${esc(x.arrivi)}</small></button>`).join('') + '</div>';
}
// SIMILI ALLA CONSIGLIATA: stesse ore circa, con un'altra linea (riepilogo subito nell'elenco, una riga ciascuna)
const hmMin = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
function simHtml(r) {
  const top = r.soluzioni[0]; if (!top || !S.sim || S.sim.key !== simKey(top)) return '';
  if (S.sim.loading) return `<p class="pp-simload muted"><span class="spin sm" aria-hidden="true"></span>Cerco soluzioni simili con altre linee…</p>`;
  const d = S.sim.data; if (!d) return '';
  const fams = new Set(r.soluzioni.map(o => o.famiglia)), rows = [];
  for (const kind of ['varianti', 'altre']) (d[kind] || []).forEach((x, k) => { if (!fams.has(x.famiglia)) { fams.add(x.famiglia); rows.push([kind, k, x]); } });
  if (!rows.length) return '';
  const diff = x => { const v = r.entro ? hmMin(top.parti) - hmMin(x.parti) : hmMin(x.arrivi) - hmMin(top.arrivi); return v === 0 ? (r.entro ? 'stessa partenza' : 'stesso arrivo') : r.entro ? (v > 0 ? `parte ${v} min prima` : `parte ${-v} min dopo`) : (v > 0 ? `arriva ${v} min dopo` : `arriva ${-v} min prima`); };
  return `<h3 class="pp-ah">Simili, con altre linee</h3><div class="pp-sim">${rows.slice(0, 4).map(([kind, k, x]) => {
    const seq = x.tratte.filter(t => t.tipo === 'mezzo').map(t => badge(t.line, t.color, t.src, ' sm')).join(`<span class="pp-sep">${icon('next', 'sm')}</span>`);
    return `<button type="button" class="pp-srow" data-sim="${kind}:${k}"><span class="pp-sseq">${seq}</span><span class="pp-stimes"><b>${esc(x.parti)}</b>${icon('next', 'sm')}<b>${esc(x.arrivi)}</b></span><span class="pp-sdiff">${esc(diff(x))}${x.cambi ? ` · ${cambiTxt(x)}` : ''}</span></button>`;
  }).join('')}</div>`;
}
const simKey = o => o.famiglia + '|' + (baseQs() || '');
async function loadSim(o) {
  const key = simKey(o); if (S.sim?.key === key && !S.sim.err) return;
  const base = baseQs(); if (!base) return;
  S.sim = { key, loading: true };
  try {
    const r = await api(`/api/percorso-simili?${base}&fam=${encodeURIComponent(o.famiglia)}&rotte=${encodeURIComponent(o.rotte.join(','))}&arr=${encodeURIComponent(o.arrivi)}`);
    if (S.sim?.key !== key) return;
    if (r.error) throw new Error(r.error);
    S.sim = { key, data: r };
    if (!S.alts) S.alts = { key: o.famiglia + '|' + (S.res?.aggiornato || ''), data: r };   // aprendo la consigliata le alternative sono già pronte
  } catch { if (S.sim?.key === key) S.sim = { key, err: true }; }
  if (!S.det && !S.showOpz && !S.edit && S.res) renderBody();
}
// PIÙ TARDI / PRIMA: un'altra ricerca dall'ultima partenza (o dall'arrivo più presto, con «arrivo entro»), aggiunta in fondo
function moreHtml(r) {
  if (!S.more?.list?.length) return S.more?.err ? `<p class="muted pad">${esc(S.more.err)}</p>` : '';
  return `<h3 class="pp-ah">${r.entro ? 'Arrivano prima' : 'Più tardi'}</h3>` + S.more.list.map((o, k) => `<div class="pp-card">${optCard(o, `data-mk="${k}"`, false, false, true)}</div>`).join('');
}
async function loadMore() {
  const r = S.res; if (!r?.soluzioni?.length || S.more?.loading) return;
  const all = [...r.soluzioni, ...(S.more?.list || [])], date = S.when === 'now' ? today() : clampDate(S.date);
  let secs;
  if (r.entro) { const first = all.reduce((m, o) => Math.min(m, hmMin(o.arrivi)), 1e9); secs = (first - 1) * 60; }
  else { const last = all.reduce((m, o) => Math.max(m, hmMin(o.parti), ...(o.poi || []).map(x => hmMin(x.parti))), 0); secs = (last + 1) * 60; }
  if (secs < 0 || secs >= 30 * 3600) return;
  const base = baseQs({ secs, date, entro: !!r.entro }); if (!base) return;
  S.more = { ...(S.more || { list: [] }), loading: true, err: null }; renderBody();
  try {
    const q = await api('/api/percorso?' + base);
    if (q.error) throw new Error(q.error);
    const seen = new Set(all.map(o => o.famiglia + '@' + o.parti));
    const add = q.soluzioni.filter(o => !seen.has(o.famiglia + '@' + o.parti));
    S.more = { list: [...(S.more?.list || []), ...add], loading: false, err: add.length ? null : 'Nessun\'altra soluzione nelle ore successive.' };
  } catch (e) { S.more = { ...(S.more || {}), loading: false, err: e.loading ? NON_ORA : 'Non riuscito: ' + e.message }; }
  if (S.res && !S.det) renderBody();
}
// ---- viaggio di una soluzione: istantanea (giorno e orari veri), avvisi, marea, azioni ----
const snapMemo = new WeakMap();
const ymdOf = d => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);
function snapOf(o) {
  if (!o) return null;
  if (snapMemo.has(o)) return snapMemo.get(o);
  let date = ymdOf(S.res?.data) || (S.when === 'now' ? today() : clampDate(S.date));
  // soluzione che parte dopo la mezzanotte rispetto all'orario cercato («più tardi» alle 23:50 → 00:10): è del giorno dopo
  const ref = S.res?.entro || S.res?.ora;
  if (ref && /^\d{1,2}:\d{2}$/.test(ref) && /^\d{1,2}:\d{2}$/.test(o.parti || '') && Viaggio.romeMs(date, o.parti) < Viaggio.romeMs(date, ref) - 8 * 3600e3) date = Viaggio.romeYmd(Viaggio.romeMs(date, o.parti) + 864e5);
  const sn = Viaggio.snapshot(o, { date, from: epKeep(S.from), to: epKeep(S.to), nameOf: id => X.stopLabel(id) });
  snapMemo.set(o, sn); return sn;
}
const solLines = o => o.tratte.filter(t => t.tipo === 'mezzo').map(t => ({ s: t.src, n: t.line }));
const solStops = o => o.tratte.filter(t => t.tipo === 'mezzo').flatMap(t => [t.da.id, t.a.id]);
const avvisiOf = (o, sn) => (sn ? Avvisi.forJourney({ lines: solLines(o), stops: solStops(o), fromMs: sn.leaveMs, toMs: sn.arriveMs }) : []);
// riga compatta sulla scheda: l'avviso più importante (o quanti sono)
function avLine(o) {
  const av = avvisiOf(o, snapOf(o)); if (!av.length) return '';
  const a = av[0], txt = av.length === 1 ? `${a.effectLabel || 'Avviso'}: ${a.title}` : `${av.length} avvisi per questo viaggio · ${a.effectLabel || a.title}`;
  return `<span class="pp-avl" data-sev="${esc(a.severity || 'warning')}">${icon(a.severity === 'info' ? 'info' : 'warn', 'sm')}<span>${esc(txt)}</span></span>`;
}
// zone della città storica (con Giudecca e Murano) dove l'acqua alta allaga i percorsi a piedi
const inVenice = (lat, lon) => lat >= 45.420 && lat <= 45.462 && lon >= 12.300 && lon <= 12.370;
function tideHtml(o, sn) {
  if (!sn) return '';
  const pts = [];
  o.tratte.forEach((t, k) => {
    if (t.tipo !== 'piedi' || t.min < 1) return;
    if (t.da?.lat != null) pts.push([t.da.lat, t.da.lon]); if (t.a?.lat != null) pts.push([t.a.lat, t.a.lon]);
    if (k === 0 && S.from?.lat != null) pts.push([S.from.lat, S.from.lon]); if (t.estremo === 'arrivo' && S.to?.lat != null) pts.push([S.to.lat, S.to.lon]);
  });
  if (!pts.some(([a, b]) => inVenice(a, b))) return '';
  const p = Livelli.picco(sn.leaveMs, sn.arriveMs); if (!p) return '';
  const liv = XA.livelloCitta(p, Tide.moseState()); if (!(liv.cm >= 90 || (liv.mose && p.cm >= 100))) return '';
  const hm = new Date(p.ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }), ms = p.prova ? null : Tide.moseState();
  const mose = liv.mose ? ` Con il MOSE ${ms === 'programmato' ? 'previsto' : 'in funzione'} in città il livello dovrebbe restare sotto circa ${XA.LIV_MOSE + 2} cm.` : ms === 'sollevata' || ms === 'sollevamento' ? ' Il MOSE è in funzione.' : '';
  const calc = Livelli.pronti() && liv.cm >= XA.MIN_ACQUA ? ' I tratti a piedi evitano dove possibile le zone potenzialmente allagabili e usano le passerelle posate: i dettagli sono in ogni tratto.' : ' Nei tratti a piedi le zone più basse (come San Marco) possono essere allagate: controlla passerelle e calzature.';
  const tot = acqSol.get(acqKey(o)), riep = tot ? `<span class="pp-acqt">${esc(tot)}</span>` : '';
  return `<p class="pp-tide">${icon('tide', 'sm')}<span><b>${p.prova ? `Prova in locale: marea ${p.cm} cm` : `Marea ${p.kind === 'previsto' ? 'prevista' : 'misurata'} ${p.cm} cm verso le ${hm}`}</b>${liv.mose ? '' : calc}${mose}${riep}</span></p>`;
}
const shareLink = sn => {
  const u = new URL('/', location.origin), c = { da: epCode(S.from), a: epCode(S.to) };
  if (c.da) u.searchParams.set('da', c.da); if (c.a) u.searchParams.set('a', c.a);
  if (sn) for (const [k, v] of Object.entries(Viaggio.linkParams(sn))) u.searchParams.set(k, v);
  return c.a ? u.toString() : null;
};
function actsHtml(o, sn) {
  if (!sn) return '';
  const now = Date.now(), j = Viaggio.active(), cur = j && j.id === sn.id, go = !cur && Viaggio.startable(sn, now), future = sn.legs.find(l => l.t === 'r').da.ms + 60e3 > now, sv = Viaggio.isSaved(sn.id);   // «futuro»: finché la prima corsa non è partita
  let h = '<div class="pp-acts">';
  if (cur) h += `<button type="button" class="btn primary pp-go" data-golive>${icon('live', 'sm')}<span>Torna al viaggio in corso</span></button>`;
  else if (go) {
    h += `<button type="button" class="btn primary pp-go">${icon('play', 'sm')}<span>Inizia il viaggio</span></button>`
      + `<small class="pp-gonote">Ti avviso quando ${Viaggio.momenti(sn)}${Notify.needsInstall() ? '. Su iPhone le notifiche richiedono l\'app installata sulla schermata Home: senza, le indicazioni restano nell\'app aperta' : ', anche con l\'app chiusa'}.</small>`;
  }
  h += '<div class="pp-acts2">'
    + (future && !cur ? `<button type="button" class="pp-act pp-svtrip" aria-pressed="${sv}">${icon('bookmark', 'sm')}<span>${sv ? 'Salvato' : 'Salva viaggio'}</span></button>` : '')
    + `<button type="button" class="pp-act pp-txt">${icon('share', 'sm')}<span>Condividi</span></button></div>`;
  if (future && !go && !cur) h += `<small class="pp-gonote muted">${sv ? 'Lo ritrovi in «I miei viaggi», all\'apertura del pianificatore.' : 'Salvalo per ritrovarlo in «I miei viaggi».'} «Inizia il viaggio» compare da 2 ore prima della partenza.</small>`;
  return h + '</div>';
}
const cambiTxt = o => (o.cambi ? `${o.cambi} ${o.cambi > 1 ? 'cambi' : 'cambio'}` : 'senza cambi');
// scheda di una soluzione (elenco e alternative). attr: attributi del pulsante; compact: senza la riga della partenza
function optCard(o, attr, live, compact = false, noPoi = false) {
  const first = o.tratte.find(t => t.tipo === 'mezzo'), st = legStatus(first.da, live);
  const seq = o.tratte.map(t => t.tipo === 'piedi' ? walkChip(t.min) : `<span class="pp-b">${badge(t.line, t.color, t.src, ' sm')}</span>`).join(`<span class="pp-sep">${icon('next', 'sm')}</span>`);
  const when = live && o.partiMs ? `<span class="in-min" data-exp="${o.partiMs}">${esc(etaText(null, o.partiMs, 0))}</span>` : '';
  const poi = o.poi?.length ? `<span class="pp-o5">${S.res?.entro ? 'Anche prima, alle' : 'Poi alle'} ${o.poi.map(x => `<b>${esc(x.parti)}</b>`).join(' · ')}</span>` : '';
  return `<button type="button" class="pp-opt${compact ? ' sm' : ''}" ${attr} data-sid="${esc(acqKey(o))}">`
    + `<span class="pp-o1"><span class="pp-times"><b>${esc(o.parti)}</b>${icon('next', 'sm')}<b>${esc(o.arrivi)}</b></span><span class="pp-dur">${minTxt(o.minuti)}</span></span>`
    + `<span class="pp-seq">${seq}</span>`
    + (compact ? '' : `<span class="pp-o3">${trkIcon(first.trk, live)}<span>Da ${stopName(first.da)}${st.txt ? ` · <span class="${st.cls}">${esc(st.txt)}</span>` : ''}</span></span>`)
    + `<span class="pp-o4">${when}<span>${cambiTxt(o)}${o.piedi ? ` · ${o.piedi} min a piedi` : ''}</span>${o.etichetta && !compact ? `<span class="pp-tag">${esc(o.etichetta)}</span>` : ''}</span>${riskLine(o)}${avLine(o)}${acqLine(o)}`
    + (compact || noPoi ? '' : poi) + '</button>';
}
const kmTxt = m => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
// «tutto a piedi» disegnato sulla mappa: scelto toccando la scheda, o da solo se nessun mezzo conviene
const walkShown = () => !S.det && !!walkVal.get(walkKey()) && S.res?.piedi != null && (S.walkShow || !S.res.soluzioni.length);
const PREF_TXT = { equilibrata: 'Arrivare prima', veloce: 'Arrivare prima', cambi: 'Meno cambi', piedi: 'Camminare meno' };
function renderBody() {
  if (vgShown()) return renderVg();
  if (S.edit) return;
  if (S.showOpz) return renderOpz();
  const r = S.res, live = !!r?.live;
  if (!S.from || !S.to) { X.plist.innerHTML = `<p class="muted pad">Scegli ${!S.from ? 'la partenza' : 'l\'arrivo'}: una fermata, la tua posizione o un punto sulla mappa.</p>`; return; }
  if (S.loading && !r) {                                          // attesa sempre visibile, con il motivo se è lunga
    const day = Scegli.dayLabel(S.when === 'now' ? today() : S.date), title = S.wait === 'orari' ? `Carico gli orari di ${day === 'Oggi' || day === 'Domani' ? day.toLowerCase() : day}…` : 'Cerco le soluzioni…';
    const why = S.wait === 'orari' ? 'Le soluzioni compaiono appena gli orari sono pronti: la prima volta può volerci fino a un minuto.' : S.wait === 'occupato' ? 'Server occupato: riprovo tra pochi secondi.' : '';
    X.plist.innerHTML = `<div class="pp-wait${S.wait === 'orari' ? ' big' : ''}" role="status" aria-live="polite"><span class="spin" aria-hidden="true"></span><span><b>${esc(title)}</b>${why ? `<small>${why}</small>` : ''}</span></div>`; return;
  }
  if (S.err) { X.plist.innerHTML = `<p class="late pad">${esc(S.err)}</p>`; return; }
  if (!r) { X.plist.innerHTML = ''; return; }
  if (S.det) return renderDetail(S.det, live);
  const nf = opzCount();
  const head = noticeHtml() + strikeOf(r.soluzioni) + `<p class="pp-meta muted">${live ? `In tempo reale · aggiornato alle ${new Date(r.aggiornato).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : r.entro ? `Orari programmati · arrivo entro le ${esc(r.entro)}` : `Orari programmati · partenza dalle ${esc(r.ora)}`}`
    + (mezziTxt() ? ` · ${mezziTxt()}` : '') + (nf ? ` · <button type="button" class="nlink pp-opzlink">${nf} ${nf > 1 ? 'opzioni attive' : 'opzione attiva'}</button>` : '') + '</p>';
  // «tutto a piedi» in cima all'elenco: se nessun mezzo conviene, se dura poco più del mezzo più rapido (5 minuti) o se FA ARRIVARE PRIMA di
  // qualsiasi mezzo (con «arrivo entro»: fa partire più tardi), anche quando il mezzo dura meno ma parte tra un po'
  const mm = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
  const rel = (x, ref) => { let d = x - ref; while (d < -720) d += 1440; while (d > 720) d -= 1440; return d; };   // minuti, a cavallo della mezzanotte
  const walkFirst = r.piedi != null && r.soluzioni.length > 0 && (r.entro
    ? r.soluzioni.every(o => rel(mm(o.parti), mm(r.entro) - r.piedi) <= 0)
    : r.soluzioni.every(o => rel(mm(o.arrivi), mm(r.ora) + r.piedi) >= 0));
  const walkTie = walkFirst && (r.entro ? r.soluzioni.some(o => rel(mm(o.parti), mm(r.entro) - r.piedi) === 0) : r.soluzioni.some(o => rel(mm(o.arrivi), mm(r.ora) + r.piedi) === 0));
  const walkNote = walkFirst ? (walkTie ? (r.entro ? 'a piedi parti alla stessa ora che con il mezzo' : 'a piedi arrivi alla stessa ora che con il mezzo')
    : r.entro ? 'a piedi parti più tardi che con qualsiasi mezzo' : 'a piedi arrivi prima di qualsiasi mezzo')
    : r.soluzioni.length && r.piedi <= Math.min(...r.soluzioni.map(o => o.minuti)) ? 'fai prima a piedi' : '';
  const walkOnly = r.piedi != null && (!r.soluzioni.length || walkFirst || r.piedi <= Math.min(...r.soluzioni.map(o => o.minuti)) + 5)
    ? `<${walkVal.get(walkKey()) ? `button type="button" data-walkonly aria-pressed="${walkShown()}"` : 'div'} class="pp-walkonly${walkShown() ? ' on' : ''}">${icon('walk')}<span><b>A piedi: circa ${minTxt(r.piedi)}${walkVal.get(walkKey()) ? ` · ${kmTxt(walkVal.get(walkKey()).m)}` : ''}</b>${r.soluzioni.length ? (walkNote ? `<small>${walkNote}</small>` : '') : '<small>nessun mezzo conviene per questo tragitto</small>'}${walkVal.get(walkKey()) ? `<small>${walkShown() ? 'sulla mappa il percorso a piedi' : 'tocca per vederlo sulla mappa'}</small>` : ''}${acquaTxt(walkVal.get(walkKey())) ? `<small class="pp-acq">${icon('passerella', 'sm')}${esc(acquaTxt(walkVal.get(walkKey())))}</small>` : ''}</span></${walkVal.get(walkKey()) ? 'button' : 'div'}>` : '';
  if (!r.soluzioni.length) {
    X.plist.innerHTML = head + walkOnly + (walkOnly ? '' : `<p class="muted pad">${r.senzaFermate ? `Nessuna fermata vicina al punto scelto.` : r.entro ? `Nessuna soluzione per arrivare entro le ${esc(r.entro)} (si guardano le 5 ore prima). Prova un orario più tardi.` : 'Nessuna soluzione nelle prossime ore con autobus, tram o battelli. Prova un altro orario o un punto vicino.'}${nf ? ' Le opzioni attive possono escludere delle soluzioni.' : ''}</p>`);
    return;
  }
  // la CONSIGLIATA in evidenza (la più semplice da fare per te, secondo «Cosa conta di più»); sotto le altre
  const [top, ...rest] = r.soluzioni, card = (o, k) => `<div class="pp-card">${optCard(o, `data-k="${k}"`, live, false, true)}${poiRow(o, k)}</div>`;
  X.plist.innerHTML = head + walkOnly + `<div class="pp-list"><div class="pp-top">${card(top, 0)}</div>${simHtml(r)}`
    + (rest.length ? `<h3 class="pp-ah">Altre soluzioni</h3>${rest.map((o, k) => card(o, k + 1)).join('')}` : '') + moreHtml(r) + '</div>'
    + `<button type="button" class="pp-later"${S.more?.loading ? ' disabled aria-busy="true"' : ''}>${S.more?.loading ? '<span class="spin sm" aria-hidden="true"></span>' : icon('clock', 'sm')}<span>${r.entro ? 'Mostra soluzioni che arrivano prima' : 'Mostra soluzioni più tardi'}</span></button>`
    + `<p class="pp-note muted">Ordinate per «${esc(PREF_TXT[S.opz.pref] || 'Arrivare prima')}». Fanno fede gli orari ACTV.</p>`;
  fillAcqua(r.soluzioni);
}
// pagina delle opzioni (v28): cosa conta di più, andatura, mezzi
function renderOpz() {
  const o = S.opz, seg = (k, vals) => `<div class="chips pp-seg" role="group">${vals.map(([v, t]) => `<button type="button" class="chip all${String(o[k]) === v ? ' on' : ''}" data-o="${k}" data-v="${v}" aria-pressed="${String(o[k]) === v}">${t}</button>`).join('')}</div>`;
  X.plist.innerHTML = `<button type="button" class="linkback pp-oback">${icon('back', 'sm')}<span>Soluzioni</span></button>`
    + '<div class="pp-opz">'
    + `<div class="pp-og"><b>Mezzi</b><div class="chips pp-seg" role="group">${MEZZI.map(([v, ic, l]) => `<button type="button" class="chip all${o.mezzi.includes(v) ? ' on' : ''}" data-m="${v}" aria-pressed="${o.mezzi.includes(v)}">${icon(ic, 'sm')}${l}</button>`).join('')}</div><small class="muted">Almeno uno.</small></div>`
    + `<div class="pp-og"><b>Cosa conta di più</b>${seg('pref', [['equilibrata', 'Arrivare prima'], ['piedi', 'Camminare meno'], ['cambi', 'Meno cambi']])}`
    + `<small class="muted">${{ equilibrata: 'Arrivi il prima possibile, contando anche quanto dura il viaggio. Un cambio o un tratto a piedi in più solo se fanno guadagnare davvero tempo (un cambio vale 8 minuti).', piedi: 'Ogni minuto a piedi pesa come tre minuti di viaggio; tra un mezzo e l\'altro al massimo 10 minuti a piedi. Il mezzo si propone anche quando a piedi faresti prima.', cambi: 'Meglio aspettare il diretto: un cambio si propone solo se fa guadagnare almeno 20 minuti.' }[o.pref] || ''}</small></div>`
    + `<div class="pp-og"><b>Andatura</b>${seg('passo', [['calma', 'Con calma'], ['normale', 'Normale'], ['svelta', 'Svelta']])}`
    + `<small class="muted">${{ calma: 'Circa 3,5 km/h e almeno 2 minuti per ogni cambio: bagagli, bambini, passeggino o chi cammina piano.', normale: 'Circa 4,5 km/h a Venezia (ponti e folla) e 4,8 km/h in terraferma. I cambi con meno di 2 minuti sono segnati «coincidenza a rischio».', svelta: 'Circa 5,6 km/h a Venezia e 6 km/h in terraferma: chi conosce le calli.' }[o.passo]}</small></div>`
    + '</div>'
    + `<div class="pp-obtns"><button type="button" class="nlink pp-oreset"${opzCount() ? '' : ' disabled'}>Ripristina</button><button type="button" class="pp-ook">Mostra le soluzioni</button></div>`;
}
function renderDetail(o, live) {
  const steps = [];
  o.tratte.forEach((t, k) => {
    if (t.tipo === 'piedi') {
      const to = t.a ? `fino a ${stopName(t.a)}` : t.estremo === 'arrivo' ? 'fino all\'arrivo' : '';
      steps.push(`<li class="pp-step walk" data-wk="${k}"><span class="pp-sic">${icon('walk')}</span><div><b>A piedi ${t.min} min</b><small>${to}</small></div></li>`);
      return;
    }
    const d = legStatus(t.da, live), a = legStatus(t.a, live), k0 = colorInfo(t.color, t.line), rail = lum(k0.rail) > .8 || lum(k0.rail) < .03 ? 'var(--fg)' : k0.rail;
    const when = live && t.da.expMs && !t.da.cancel ? `<span class="in-min" data-exp="${t.da.expMs}" data-ph="${esc(t.da.phase || '')}">${esc(etaText(t.da.phase, t.da.expMs, 0))}</span>` : '';
    const veh = t.vehicle ? ` · ${esc(vehName(t.src, t.vehicle))}` : '';
    steps.push(`<li class="pp-step ride" style="--rc:${rail}"><button type="button" class="pp-ride" data-leg="${k}" aria-label="Apri la corsa della linea ${esc(t.line)} per ${esc(t.headsign || '')}">`
      + `<span class="pp-rh">${badge(t.line, t.color, t.src)}${trkIcon(t.trk, live)}<span class="pp-hs">${icon('next', 'sm')}${esc(t.headsign || '')}</span></span>`
      + `<span class="pp-sp"><span class="pp-st">${d.time}</span><span class="pp-sn"><b>${stopName(t.da)}</b><small class="${d.cls}">${esc(d.txt)}${veh}</small></span>${when}</span>`
      + `<span class="pp-mid muted">${t.fermate} ${t.fermate === 1 ? 'fermata' : 'fermate'} · tocca per seguire la corsa</span>`
      + `<span class="pp-sp"><span class="pp-st">${a.time}</span><span class="pp-sn"><b>${stopName(t.a)}</b><small>scendi qui</small></span></span>`
      + '</button></li>');
    const nx = o.tratte[k + 1];
    if (nx && nx.tipo === 'mezzo') steps.push(`<li class="pp-step chg${nx.aRischio || nx.persa ? ' risk' : ''}"><span class="pp-sic">${icon(nx.aRischio || nx.persa ? 'warn' : 'next', 'sm')}</span><div><b>${chgTitle(nx)}</b><small>stessa fermata${chgNote(nx)}</small></div></li>`);
    // cambio con tratto a piedi: margine e rischio prima del tratto a piedi verso la corsa successiva
    const nr = o.tratte[k + 2];
    if (nx && nx.tipo === 'piedi' && nr && nr.tipo === 'mezzo' && nr.cambioMin != null) steps.push(`<li class="pp-step chg note${nr.aRischio || nr.persa ? ' risk' : ''}"><span class="pp-sic">${icon(nr.aRischio || nr.persa ? 'warn' : 'clock', 'sm')}</span><div><b>${chgTitle(nr)}</b><small>a piedi ${nx.min} min${chgNote(nr)}</small></div></li>`);
  });
  steps.push(`<li class="pp-step end"><span class="pp-sic">${icon('pin')}</span><div><b>Arrivo alle ${esc(o.arrivi)}</b><small>${esc(epName(S.to))}</small></div></li>`);
  X.plist.innerHTML = `<div class="pp-dhead"><button type="button" class="linkback pp-back">${icon('back', 'sm')}<span>Tutte le soluzioni</span></button>`
    + `<button type="button" class="ibtn sm pp-tall" aria-pressed="${S.tall}" aria-label="${S.tall ? 'Abbassa il pannello e mostra di più la mappa' : 'Alza il pannello per leggere tutte le tappe'}" title="${S.tall ? 'Più mappa' : 'Più tappe'}">${icon(S.tall ? 'down' : 'up', 'sm')}</button></div>`
    + `<div class="pp-dsum"><span class="pp-times"><b>${esc(o.parti)}</b>${icon('next', 'sm')}<b>${esc(o.arrivi)}</b></span><span class="muted">${minTxt(o.minuti)} · ${cambiTxt(o)}${o.piedi ? ` · ${o.piedi} min a piedi` : ''}</span>${riskLine(o)}</div>`
    + strikeOf([o]) + actsHtml(o, snapOf(o)) + detAvHtml(o) + tideHtml(o, snapOf(o))
    + `<ol class="pp-steps"><li class="pp-step start"><span class="pp-sic">${S.from.kind === 'me' ? icon('locate') : icon('pin')}</span><div><b>Partenza alle ${esc(o.parti)}</b><small>${esc(epName(S.from))}</small></div></li>${steps.join('')}</ol>`
    + '<section class="pp-alts" aria-live="polite"></section>';
  renderAlts(); loadAlts(o); fillAcqua([o]);
}
function detAvHtml(o) {
  const av = avvisiOf(o, snapOf(o)); if (!av.length) return '';
  const only = new Set(solLines(o).map(l => Avvisi.keyOf(l.s, l.n)));
  return `<div class="pp-avs"><p class="pp-avh">${icon('warn', 'sm')}<span>Avvisi per questo viaggio</span></p>${av.map(a => Avvisi.rowHtml(a, only)).join('')}</div>`;
}
// alternative nel dettaglio
function renderAlts() {
  const box = X.plist.querySelector('.pp-alts'), o = S.det; if (!box || !o) return;
  const A = S.alts, live = !!S.res?.live;
  if (!A || A.loading) { box.innerHTML = `<h3 class="pp-ah">Alternative</h3><p class="muted pad">Cerco gli altri orari e le alternative…</p>`; return; }
  if (A.err || !A.data) { box.innerHTML = `<h3 class="pp-ah">Alternative</h3><p class="muted pad">Alternative non disponibili.</p>`; return; }
  const d = A.data, same = d.stesso.filter(x => x.famiglia === o.famiglia);
  if (S.wantTime) {                                              // aperto toccando un orario sotto la scheda: si passa a quella partenza
    const w = S.wantTime; S.wantTime = null; const x = same.find(z => z.parti === w);
    if (x && !(x.parti === o.parti && x.arrivi === o.arrivi)) { S.det = x; S.sel = -1; renderBody(); draw(); return; }
  }
  let h = '';
  if (same.length > 1) h += `<h3 class="pp-ah">Stesso percorso, altri orari</h3><div class="pp-trow" role="list">${same.map((x, k) => { const cur = x.parti === o.parti && x.arrivi === o.arrivi;
    return `<button type="button" class="pp-tchip${cur ? ' on' : ''}" data-alt="stesso:${k}" role="listitem" aria-current="${cur}"><b>${esc(x.parti)}</b><span>${esc(x.arrivi)}</span></button>`; }).join('')}</div>`;
  if (d.varianti.length) h += `<h3 class="pp-ah">Cambiando una linea</h3><div class="pp-list">${d.varianti.map((x, k) => optCard(x, `data-alt="varianti:${k}"`, live, true)).join('')}</div>`;
  if (d.altre.length) h += `<h3 class="pp-ah">Con altre linee</h3><div class="pp-list">${d.altre.map((x, k) => optCard(x, `data-alt="altre:${k}"`, live, true)).join('')}</div>`;
  box.innerHTML = h || `<h3 class="pp-ah">Alternative</h3><p class="muted pad">Nessun'altra soluzione ragionevole per questo tragitto.</p>`;
}
// ---------------------------------------------------------------------------------------------------------------------
// MAPPA: tratte colorate come le linee, tratti a piedi tratteggiati, partenza e arrivo
// ---------------------------------------------------------------------------------------------------------------------
// INQUADRATURA del percorso mostrato (partenza, arrivo, fermate, cambi, tratti a piedi), nella parte di mappa non coperta da pannelli e
// controlli (X.fit). Si ricentra quando cambia QUELLO CHE SI GUARDA (punti, soluzione scelta, «tutto a piedi»); gli aggiornamenti
// automatici (ogni minuto) ricentrano solo se nel frattempo non hai spostato o ingrandito la mappa a mano.
let drawTok = 0, viewKey = '', solKey = '', userMoved = false, fitting = false;
const solId = o => (o ? o.tratte.map(t => t.tipo === 'mezzo' ? `${t.tripId || t.line}@${t.da?.id}` : 'p').join('>') : '');
function userMove() { if (!fitting) userMoved = true; }
let lastPts = [];
// dopo l'impaginazione (due fotogrammi): il pannello ha già l'altezza definitiva quando si calcola la zona libera
function fitTo(pts) { if (!pts.length) return; lastPts = pts; fitting = true; requestAnimationFrame(() => requestAnimationFrame(() => { X.fit(lastPts); setTimeout(() => { fitting = false; }, 700); })); }
// il pannello ha cambiato altezza (soluzioni arrivate, dettaglio aperto): stessa inquadratura, se non hai spostato la mappa a mano
export function refit() { if (lastPts.length && !userMoved && X?.isOpen()) fitTo(lastPts); }
function draw() {
  X.layer.clearLayers();
  const vg = vgShown(), F = vg ? Viaggio.active().from : S.from, T = vg ? Viaggio.active().to : S.to;
  const r = S.res, o = vg ? vgSol : S.det || r?.soluzioni?.[0], pts = [], myDraw = ++drawTok;
  const mark = (ep, end) => { if (!ep || ep.lat == null) return; L.circleMarker([ep.lat, ep.lon], { radius: 8, weight: 3, color: end ? '#b42318' : '#0b62c4', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(X.layer); pts.push([ep.lat, ep.lon]); };
  // tratto a piedi: alone (chiaro sulla mappa chiara, scuro su quella scura) e pallini tondi sopra, come nelle app di mappe.
  // La mappa disegna su canvas: i colori si scelgono qui secondo il tema (e al cambio di tema si ridisegna, vedi in fondo).
  const dark = document.documentElement.dataset.theme === 'dark', WS = dark ? { halo: '#0b1520', ho: .85, dot: '#7cc0ff' } : { halo: '#ffffff', ho: .92, dot: '#0b62c4' };
  const walkPath = (pts, pending) => [
    L.polyline(pts, { color: WS.halo, weight: 10, opacity: WS.ho, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(X.layer),
    L.polyline(pts, { color: WS.dot, weight: 6, opacity: pending ? .45 : 1, dashArray: '0.1 10', lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(X.layer)   // provvisorio (linea retta): più tenue
  ];
  // acqua alta lungo il tratto: in blu le parti con acqua possibile, nel colore delle passerelle quelle su passerella posata
  const acquaParti = w => { for (const pa of w?.acqua?.parti || []) L.polyline(pa.pts, { color: pa.k === 'acqua' ? '#1e78e6' : (dark ? '#ffa94d' : '#c2410c'), weight: 5, opacity: .95, lineCap: 'round', interactive: false }).addTo(X.layer); };
  // subito in linea retta (più tenue), poi (appena calcolato sul telefono) lungo le strade; k = tappa nel dettaglio (per i metri)
  const walkLine = (a, b, k) => {
    const near = mDist(a[0], a[1], b[0], b[1]) < 15, line = walkPath([a, b], !near);
    if (near) return;
    pathFor(a, b, o && k != null ? legMs(o, k) : searchMs()).then(w => {
      if (!w || myDraw !== drawTok) { if (myDraw === drawTok) line[1].setStyle?.({ opacity: 1 }); return; }   // niente percorso: resta la linea retta, piena
      for (const l of line) X.layer.removeLayer(l);
      walkPath(w.pts); acquaParti(w);
      const at = k != null && acquaTxt(w), sa = at && X.plist.querySelector(`.pp-step.walk[data-wk="${k}"] div`);
      if (sa && !sa.querySelector('.pp-acq')) sa.insertAdjacentHTML('beforeend', `<small class="pp-acq">${icon('passerella', 'sm')}${esc(at)}</small>`);
      // il tratto lungo le strade esce dall'inquadratura: si riallarga (solo se non hai spostato la mappa)
      if (!userMoved && X.map && !w.pts.every(p => X.map.getBounds().contains(p))) { pts.push(...w.pts); fitTo(pts); }
      const st = k != null && X.plist.querySelector(`.pp-step.walk[data-wk="${k}"] small`);
      if (st && !st.dataset.m) { st.dataset.m = '1'; st.textContent += `${st.textContent ? ' · ' : ''}${kmTxt(w.m)}`; }
    });
  };
  if (!vg && walkShown()) {                                              // tutto a piedi
    const w = walkVal.get(walkKey());
    walkPath(w.pts); acquaParti(w); pts.push(...w.pts);
  } else if (o) {
    let prev = F?.lat != null ? [F.lat, F.lon] : null;
    const walkTo = (p, k) => { if (prev && p) { walkLine(prev, p, k); pts.push(prev, p); } };
    o.tratte.forEach((t, k) => {
      if (t.tipo === 'piedi') { const p = t.a?.lat != null ? [t.a.lat, t.a.lon] : t.estremo === 'arrivo' && T?.lat != null ? [T.lat, T.lon] : null; if (t.da?.lat != null) prev = [t.da.lat, t.da.lon]; walkTo(p, k); if (p) prev = p; return; }
      const start = t.da.lat != null ? [t.da.lat, t.da.lon] : null; if (prev && start && mDist(prev[0], prev[1], start[0], start[1]) > 25) walkTo(start);
      const line = t.shape?.length ? t.shape : t.stops.map(s => [s[0], s[1]]);
      X.drawLine(line, colorInfo(t.color, t.line), X.layer, .95);
      for (const s of [t.stops[0], t.stops[t.stops.length - 1]]) L.circleMarker([s[0], s[1]], { radius: 5, weight: 2, color: '#0f172a', fillColor: '#fff', fillOpacity: 1 }).bindTooltip(esc(s[2])).addTo(X.layer);
      pts.push(...line);
      prev = t.a.lat != null ? [t.a.lat, t.a.lon] : prev;
    });
    if (T?.lat != null && prev && mDist(prev[0], prev[1], T.lat, T.lon) > 25 && o.tratte[o.tratte.length - 1].tipo === 'mezzo') walkTo([T.lat, T.lon]);
  }
  mark(F, false); mark(T, true);
  X.changed?.();                                                  // impaginazione (foglio o tutto schermo) e mezzi sulla mappa: solo quelli di questa soluzione
  const vk = `${vg ? 'vg|' : ''}${F?.lat != null ? ptKey(F) : ''}|${T?.lat != null ? ptKey(T) : ''}|${!vg && walkShown()}|${vg ? solId(vgSol) : S.det ? solId(S.det) : ''}`, sk = solId(o);
  if (vk !== viewKey) { viewKey = vk; solKey = sk; userMoved = false; fitTo(pts); }        // scelta tua: si inquadra sempre
  else if (sk !== solKey) { solKey = sk; if (!userMoved) fitTo(pts); }                      // cambiata da un aggiornamento: solo se non hai mosso la mappa
}

// ---------------------------------------------------------------------------------------------------------------------
// TOCCHI
// ---------------------------------------------------------------------------------------------------------------------
function choose(f, ep) {
  if (S.draft && S.draftF) { S.draft[S.draftF] = ep; S.draftF = null; S.q = ''; render(); return; }   // scheda di modifica: si cambia solo la bozza
  S[f] = ep; S.edit = null; S.q = ''; if (S.from && S.to) S.formOpen = false; save(); render(); if (S.from && S.to) run(); else { S.edit = !S.from ? 'from' : !S.to ? 'to' : null; render(); } }
let vgStarting = false;
async function startVg(o) {
  const permP = Notify.askPermission();                             // dentro il tocco: Safari chiede il permesso solo durante un gesto
  Viaggio.preLock();
  const sn = snapOf(o); if (!sn) return;
  vgStarting = true; vgSol = o; S.vg = true; S.tall = false; vgTop = true;
  try {
    await permP;
    const p = Viaggio.start(sn, X.styleOf || (() => null));
    render(); draw();
    const r = await p;
    if (r.msg && !(X.isOpen() && vgShown())) X.toast?.(r.msg, 7000);     // con la schermata aperta lo stato degli avvisi è già scritto lì
  } finally { vgStarting = false; }
  if (Viaggio.active()) { S.vg = true; if (X.isOpen()) { render(); draw(); } }
}
// «Ricalcola da qui»: dalla posizione (se c'è) o dalla fermata dove ti trovi secondo il viaggio, fino all'arrivo, con «Adesso». Il viaggio resta attivo.
// punto da cui ripartire: la posizione (se c'è), altrimenti la fermata dove ti trovi secondo il viaggio, altrimenti la partenza
function vgFrom(j) {
  if (X.me()) return meEp(X.me());
  const ph = Viaggio.phase(j), R = j.legs.filter(l => l.t === 'r');
  const st = ph.kind === 'cambio' ? R[ph.idx - 1]?.a : ph.kind === 'bordo' || ph.kind === 'scendi' ? R[ph.idx]?.a : null, s0 = st && X.stopById.get(st.id);
  return s0 ? stopEp(s0[0], s0[1], s0[4]) : j.from && j.from.kind !== 'me' ? { ...j.from } : null;
}
// ALTERNATIVA PIÙ VELOCE durante il viaggio (v33.2): si cerca SOLO se c'è un problema vero (corsa soppressa, cambio perso, arrivo in ritardo di
// 8 minuti o più), con l'app davanti, al massimo una volta ogni 3 minuti per viaggio (una sola richiesta al server). Si propone con un riquadro
// discreto solo se fa arrivare almeno 6 minuti prima (o se il viaggio non regge più): il viaggio in corso non cambia finché non lo tocchi.
let vgAlt = null, vgAltAt = 0, vgAltBusy = false;
const ALT_EVERY = 3 * 60e3, ALT_GAIN = 6 * 60e3;
async function checkVgAlt(j) {
  if (!j || document.hidden || vgAltBusy) return;
  if (vgAlt && (vgAlt.id !== j.viaggio || Date.now() - vgAlt.at > 10 * 60e3)) vgAlt = null;
  const need = Viaggio.altNeed(j); if (!need) { if (vgAlt) { vgAlt = null; if (vgShown()) renderVg(); } return; }
  if (Date.now() - vgAltAt < ALT_EVERY || !j.to || j.to.kind === 'me') return;
  const from = vgFrom(j), da = cands(from), a = cands(j.to); if (!da?.length || !a?.length) return;
  vgAltAt = Date.now(); vgAltBusy = true;
  try {
    const r = await api(`/api/percorso?da=${encodeURIComponent(da.join(','))}&a=${encodeURIComponent(a.join(','))}${opzQs()}`);
    const o = r?.soluzioni?.[0]; if (!o || !Viaggio.active() || Viaggio.active().viaggio !== j.viaggio) return;
    let arr = Viaggio.romeMs(today(), o.arrivi); if (arr < Date.now() - 6 * 3600e3) arr += 864e5;
    if (need.arrive !== Infinity && arr > need.arrive - ALT_GAIN) return;
    vgAlt = { id: j.viaggio, at: Date.now(), why: need.why, parti: o.parti, arrivi: o.arrivi, linee: o.tratte.filter(t => t.tipo === 'mezzo').map(t => t.line).join(' + '),
      gain: need.arrive === Infinity ? null : Math.round((need.arrive - arr) / 60e3) };
    if (X.isOpen() && vgShown()) renderVg();
  } catch { /* nessun riquadro: il viaggio continua come prima */ } finally { vgAltBusy = false; }
}
const vgAltHtml = () => {
  const v = vgAlt, j = Viaggio.active(); if (!v || !j || v.id !== j.viaggio) return '';
  const head = v.why === 'soppressa' ? 'Corsa soppressa: c\'è un\'alternativa' : v.why === 'cambio' ? 'Il cambio salta: c\'è un\'alternativa' : 'Trovata alternativa più veloce';
  return `<button type="button" class="vg-alt vg-recalc">${icon('route', 'sm')}<span><b>${esc(head)}</b><small>Linea ${esc(v.linee)} · partenza ${esc(v.parti)}, arrivo ${esc(v.arrivi)}${v.gain ? ` (${v.gain} min prima)` : ''} · tocca per vederla</small></span></button>`;
};
function recalcVg() {
  const j = Viaggio.active(); if (!j?.to) { X.toast?.('Arrivo del viaggio non disponibile: scegli il percorso dal pianificatore.', 4000); return; }
  const from = vgFrom(j); vgAlt = null;
  S.vg = false; vgEndArm = 0; if (!from) S.from = null;
  show({ ...(from ? { from } : {}), to: { ...j.to, ...(j.to.kind === 'me' ? { lat: null } : {}) } });
}
function onClick(e) {
  if (!X.isOpen()) return;
  const t = e.target;
  // VIAGGIO GUIDATO, I MIEI VIAGGI, avvisi e condivisione
  if (t.closest('.vg-plan')) { leaveVg(true); return; }
  const lk = t.closest('.vg-lockcb'); if (lk) { Viaggio.setLockWanted(lk.checked); return; }
  const gp = t.closest('.vg-gpscb'); if (gp) { Viaggio.setGpsWanted(gp.checked); return; }   // nel tocco: il browser può chiedere il permesso
  const en = t.closest('.vg-end');
  if (en) {
    if (Date.now() - vgEndArm < 4000) { vgEndArm = 0; Viaggio.end(); X.toast?.('Viaggio terminato: avvisi annullati.', 3000); return; }
    vgEndArm = Date.now(); en.classList.add('armed'); en.querySelector('span').textContent = 'Tocca di nuovo per terminare';
    setTimeout(() => { if (en.isConnected && Date.now() - vgEndArm >= 3900) { en.classList.remove('armed'); en.querySelector('span').textContent = 'Termina viaggio'; } }, 4000);
    return;
  }
  if (t.closest('.vg-recalc')) { recalcVg(); return; }
  const av = t.closest('.alert-row'); if (av) { Avvisi.openAlert(av.dataset.av); return; }
  const go = t.closest('.pp-go');
  if (go) { if (go.dataset.golive != null) { S.vg = true; S.tall = false; vgTop = true; render(); draw(); } else startVg(S.det); return; }
  if (t.closest('.pp-svtrip')) {
    const sn = snapOf(S.det); if (!sn) return;
    const r = Viaggio.toggleSaved(sn);
    if (r.error) X.toast?.(r.error, 5000); else X.toast?.(r.saved ? 'Salvato in «I miei viaggi»: lo trovi aprendo il pianificatore.' : 'Tolto da «I miei viaggi».', 3500);
    renderBody(); return;
  }
  if (t.closest('.pp-txt')) {
    const sn = snapOf(S.det); if (!sn) return;
    Viaggio.share(sn, shareLink(sn)).then(r => {
      if (r === 'copiato') X.toast?.('Proposta copiata (con il link): incollala in un messaggio.', 3500);
      else if (r === 'errore') X.toast?.('Condivisione non riuscita su questo dispositivo.', 4000);
    });
    return;
  }
  const vd = t.closest('[data-vgdel]'); if (vd) { Viaggio.removeSaved(vd.dataset.vgdel); X.toast?.('Viaggio eliminato.', 2500); renderSuggest(); return; }
  const vo = t.closest('[data-vg]');
  if (vo) {
    const sv = Viaggio.savedById(vo.dataset.vg); if (!sv || !sv.to) { renderSuggest(); return; }
    S.edit = null; S.q = '';
    if (!sv.from) S.from = null;
    show({ ...(sv.from ? { from: { ...sv.from, ...(sv.from.kind === 'me' ? { lat: null } : {}) } } : {}), to: { ...sv.to, ...(sv.to.kind === 'me' ? { lat: null } : {}) }, want: Viaggio.wantOf(sv) });
    return;
  }
  if (t.closest('[data-s="live"]')) { S.edit = null; S.q = ''; S.vg = true; S.tall = false; vgTop = true; render(); draw(); return; }
  if (t.closest('[data-expand]')) { S.formOpen = true; S.tall = false; render(); X.chips.querySelector('.pp-f')?.focus(); return; }
  if (t.closest('.pp-collapse')) { S.formOpen = false; render(); return; }
  if (t.closest('.pp-tall')) { S.tall = !S.tall; renderBody(); X.changed?.(); return; }
  // modifica dei percorsi recenti e salvati (v33.5)
  const ls = t.closest('[data-lst]'); if (ls) { S.lst = S.lst === ls.dataset.lst ? null : ls.dataset.lst; renderSuggest(); X.plist.querySelector(`[data-lst="${ls.dataset.lst}"]`)?.focus(); return; }
  const de = t.closest('[data-ded]');
  if (de) {
    const k = de.dataset.k, r = de.dataset.ded === 'route' ? Fav.routeByKey(k) : recenti.find(x => recSig(x) === k);
    if (r) { S.draft = { s: de.dataset.ded, k, from: { ...r.from }, to: { ...r.to }, name: r.name || '' }; S.draftF = null; S.q = ''; render(); X.plist.scrollTop = 0; } else renderSuggest();
    return;
  }
  const dd = t.closest('[data-ddel]');
  if (dd) { if (dd.dataset.ddel === 'route') { Fav.removeRoute(dd.dataset.k); X.favChanged?.(); } else removeRecent(dd.dataset.k); X.toast?.('Percorso eliminato.', 2500); renderSuggest(); return; }
  const dm = t.closest('[data-dmv]'); if (dm) { Fav.moveRoute(dm.dataset.k, +dm.dataset.dmv); X.favChanged?.(); renderSuggest(); return; }
  if (S.draft) {
    const df = t.closest('[data-df]'); if (df) { S.draft.name = X.plist.querySelector('.pp-dn')?.value ?? S.draft.name; S.draftF = df.dataset.df; S.q = ''; render(); return; }
    if (t.closest('.pp-dswap')) { S.draft.name = X.plist.querySelector('.pp-dn')?.value ?? S.draft.name; [S.draft.from, S.draft.to] = [S.draft.to, S.draft.from]; renderSuggest(); return; }
    if (t.closest('[data-dcancel]')) { S.draft = null; S.draftF = null; render(); return; }
    if (t.closest('[data-dsave], [data-dnew]')) { saveDraft(!!t.closest('[data-dnew]')); return; }
  }
  const fld = t.closest('.pp-f'); if (fld) { S.edit = fld.dataset.f; S.q = ''; render(); return; }
  if (t.closest('.pp-qback')) { back(); return; }
  if (t.closest('.pp-swap')) { [S.from, S.to] = [S.to, S.from]; save(); render(); run(); return; }
  const clr = t.closest('[data-clr]');
  if (clr) { S[clr.dataset.clr] = null; S.res = null; S.det = null; S.sel = -1; S.alts = null; S.err = null; save(); render(); X.layer.clearLayers(); return; }
  const w = t.closest('[data-w]'); if (w) { S.when = w.dataset.w; S.showOpz = false; render(); run(); return; }
  const sg = t.closest('.pp-sug');
  if (sg) {
    const f = S.draftF || S.edit, k = sg.dataset.k;
    if (sg.dataset.s === 'me' && S.draftF) { choose(f, { kind: 'me', label: 'La mia posizione' }); return; }   // nel percorso si salva senza coordinate
    if (sg.dataset.s === 'me') { const me = X.me(); if (me) choose(f, meEp(me)); else { S.asked = f; X.locate(); X.plist.innerHTML = '<p class="muted pad">Cerco la tua posizione…</p>'; } return; }
    if (sg.dataset.s === 'map') { S.picking = f; X.setPick(true, f === 'from' ? 'Tocca la mappa nel punto di partenza' : 'Tocca la mappa nel punto di arrivo'); return; }
    if (sg.dataset.s === 'zone') { const z = zones.get(k); if (z) choose(f, zoneEp(z)); return; }
    if (sg.dataset.s === 'recent') { const r = recenti.find(x => epSig(x.from) + '>' + epSig(x.to) === k); if (r) { S.edit = null; S.q = ''; show({ from: { ...r.from, ...(r.from.kind === 'me' ? { lat: null } : {}) }, to: { ...r.to, ...(r.to.kind === 'me' ? { lat: null } : {}) } }); } return; }
    if (sg.dataset.s === 'route') { const r = Fav.routeByKey(k); if (r) { S.edit = null; S.q = ''; show({ from: { ...r.from }, to: { ...r.to } }); X.favChanged?.(); } return; }
    if (sg.dataset.s === 'stop') { const s = X.stopById.get(k) || X.allStops().find(x => x[0] === k); if (s) choose(f, stopEp(s[0], s[1], s[4])); return; }
    if (sg.dataset.s === 'fav') {
      if (k.startsWith('zone:')) { const z = zones.get(k.slice(5)); if (z) choose(f, zoneEp(z)); }
      else { const id = k.slice(5), s = X.stopById.get(aliasOf.get(id) || id); if (s) choose(f, stopEp(s[0], s[1], s[4])); }
      return;
    }
  }
  // giorno e ora: selettori dell'app (scegli.js), sempre dentro lo schermo
  if (t.closest('.pp-dbtn')) { const tt = today(); Scegli.giorno(t.closest('.pp-dbtn'), { value: S.date || tt, min: clampDate(tt), max: range.max || null, onPick: v => { S.date = clampDate(v); renderForm(); run(); } }); return; }
  if (t.closest('.pp-tbtn')) { Scegli.ora(t.closest('.pp-tbtn'), { value: S.time, label: S.when === 'by' ? 'Arrivo entro le' : 'Partenza alle', onPick: v => { S.time = v; renderForm(); run(); } }); return; }
  // opzioni
  if (t.closest('.pp-opzbtn, .pp-opzlink')) { S.showOpz = !S.showOpz || !!t.closest('.pp-opzlink'); S.opzDirty = false; renderForm(); renderBody(); X.plist.scrollTop = 0; return; }
  const om = t.closest('[data-m]');
  if (om) { const v = om.dataset.m, m = S.opz.mezzi; S.opz.mezzi = m.includes(v) ? (m.length > 1 ? m.filter(x => x !== v) : m) : [...m, v]; S.opzDirty = true; saveOpz(); renderForm(); renderOpz(); return; }
  const oo = t.closest('[data-o]'); if (oo) { S.opz[oo.dataset.o] = oo.dataset.v; S.opzDirty = true; saveOpz(); renderForm(); renderOpz(); return; }
  if (t.closest('.pp-oreset')) { S.opz = { ...OPZ0, mezzi: [...OPZ0.mezzi] }; S.opzDirty = true; saveOpz(); renderForm(); renderOpz(); return; }
  if (t.closest('.pp-ook, .pp-oback')) { const d = S.opzDirty; S.showOpz = false; S.opzDirty = false; renderForm(); if (d) run(); else renderBody(); X.plist.scrollTop = 0; return; }
  if (t.closest('[data-walkonly]')) { S.walkShow = !walkShown(); renderBody(); draw(); return; }
  // soluzioni e alternative
  const alt = t.closest('[data-alt]');
  if (alt && S.alts?.data) { const [kind, k] = alt.dataset.alt.split(':'), x = S.alts.data[kind]?.[+k]; if (x) { S.det = x; S.sel = -1; S.formOpen = false; renderForm(); renderBody(); draw(); X.plist.scrollTop = 0; } return; }
  const opt = t.closest('.pp-opt'); if (opt && opt.dataset.k != null) { S.sel = +opt.dataset.k; S.det = S.res?.soluzioni?.[S.sel] || null; S.formOpen = false; S.tall = false; renderForm(); renderBody(); draw(); X.plist.scrollTop = 0; return; }
  if (t.closest('.pp-back')) { S.sel = -1; S.det = null; S.tall = false; renderBody(); draw(); return; }
  // «Più tardi» / «Prima»: si AGGIUNGONO le soluzioni successive (o precedenti) in fondo all'elenco; l'orario scelto non cambia
  if (t.closest('.pp-later')) { loadMore(); return; }
  const mk = t.closest('[data-mk]'); if (mk && S.more?.list) { const x = S.more.list[+mk.dataset.mk]; if (x) { S.det = x; S.sel = -1; S.formOpen = false; S.tall = false; renderForm(); renderBody(); draw(); X.plist.scrollTop = 0; } return; }
  // orario di un'altra partenza dello stesso percorso (pulsanti sotto la scheda): si apre quella partenza
  const pc = t.closest('[data-poi]');
  if (pc) { const k = +pc.dataset.k, o = S.res?.soluzioni?.[k]; if (o) { S.sel = k; S.det = o; S.wantTime = pc.dataset.poi; S.formOpen = false; S.tall = false; renderForm(); renderBody(); draw(); X.plist.scrollTop = 0; } return; }
  // simili alla consigliata (riepilogo nell'elenco)
  const sm = t.closest('[data-sim]');
  if (sm && S.sim?.data) { const [kind, k] = sm.dataset.sim.split(':'), x = S.sim.data[kind]?.[+k]; if (x) { S.det = x; S.sel = -1; S.formOpen = false; S.tall = false; renderForm(); renderBody(); draw(); X.plist.scrollTop = 0; } return; }
  const ride = t.closest('.pp-ride');
  if (ride) { const leg = S.det?.tratte[+ride.dataset.leg]; if (leg) X.openTrip(leg); }
}
