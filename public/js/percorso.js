// PIANIFICA PERCORSO (client): da / a, quando, soluzioni e dettaglio tappa per tappa, nel pannello laterale (o in basso sul telefono).
// Il calcolo lo fa il server (/api/percorso). La posizione dell'utente NON esce dal telefono: si inviano solo le fermate vicine al punto
// scelto, con la distanza calcolata qui: lungo le strade (camminata.js, rete pedonale di OpenStreetMap scaricata dal CDN, fino a 30 minuti
// a passo svelto) o, se la rete non è disponibile, in linea d'aria come prima. Anche i tratti a piedi sulla mappa seguono le strade. Ogni tratta in mezzo usa gli stessi orari, simboli e diciture del pannello fermata,
// e si apre nel pannello del mezzo (con «indietro» al percorso).
import { esc, icon, badge, colorInfo, lum, delayInfo, etaText, api, srcIcon, vehName, localDate } from './util.js';
import { zones, zoneOf, norm, snorm, groups, aliasOf } from './zones.js';
import * as Fav from './fav.js';
import * as Walk from './camminata.js';

const NEAR_M = 1500, NEAR_N = 14, REFRESH_MS = 60000, KEY = 'tpl.percorso', KEY_OPZ = 'tpl.percorso.opz';
let X = null;                      // contesto dato da app.js (mappa, pannello, fermate, posizione…)
// det: soluzione mostrata nel dettaglio (dell'elenco o un'alternativa); alts: alternative caricate per il dettaglio; opz: filtri; showOpz: pagina dei filtri
// mezzi: battelli (nav) e autobus/tram (aut, come i pulsanti della mappa)
const OPZ0 = { mezzi: ['nav', 'aut'], pref: 'equilibrata', cambi: '4', piedimax: '', passo: 'normale', margine: 'normale' };
// when: 'now' (parti adesso, tempo reale) · 'at' (parti alle) · 'by' (arriva entro); date: giorno scelto (AAAA-MM-GG), entro le date dei GTFS in archivio
const S = { walkShow: false, from: null, to: null, when: 'now', time: '', date: '', res: null, err: null, sel: -1, det: null, alts: null, edit: null, q: '', picking: null, loading: false, asked: 0,
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
  const real = walkVal.get(ptKey(ep));
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
const walkKey = () => (S.from?.lat != null && S.to?.lat != null ? `w|${ptKey(S.from)}|${ptKey(S.to)}` : null);
// prima di chiedere le soluzioni: distanze reali dai punti alle fermate vicine e percorso «tutto a piedi» (se entro 30 minuti)
async function prepWalk() {
  const jobs = [];
  for (const ep of [S.from, S.to]) if (isPoint(ep)) jobs.push(memoWalk(ptKey(ep), async () => {
    const near = nearStops(ep); if (!near.length) return null;
    const m = await Walk.distanze({ lat: +ep.lat, lon: +ep.lon }, near.map(([id, , lat, lon]) => ({ key: id, lat, lon })));
    return m && m.size ? m : null;                                 // nessuna fermata raggiungibile lungo la rete: linea d'aria, come prima
  }));
  const wk = walkKey();
  if (wk && mDist(S.from.lat, S.from.lon, S.to.lat, S.to.lon) <= Walk.LIMITE_M) jobs.push(memoWalk(wk, () => Walk.percorso({ lat: +S.from.lat, lon: +S.from.lon }, { lat: +S.to.lat, lon: +S.to.lon })));
  await Promise.all(jobs);
}
const pathFor = (a, b) => memoWalk(`p|${a[0].toFixed(5)},${a[1].toFixed(5)}|${b[0].toFixed(5)},${b[1].toFixed(5)}`, () => Walk.percorso({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }));
const epName = ep => (ep ? ep.label : '');
const save = () => { try { const k = ep => (ep && (ep.kind === 'stop' || ep.kind === 'zone') ? ep : null); localStorage.setItem(KEY, JSON.stringify({ v: 1, from: k(S.from), to: k(S.to) })); } catch { /* facoltativo */ } };
function restore() {
  try { const d = JSON.parse(localStorage.getItem(KEY) || 'null'); if (d?.v === 1) { S.from = d.from || null; S.to = d.to || null; } } catch { /* niente */ }
  try { const o = JSON.parse(localStorage.getItem(KEY_OPZ) || 'null'); if (o && typeof o === 'object') for (const k in OPZ0) if (o[k] != null && typeof o[k] === typeof OPZ0[k]) S.opz[k] = o[k]; } catch { /* niente */ }
  // versioni precedenti: battelli, bus e tram separati (il tram era già compreso nei bus)
  if (Array.isArray(S.opz.mezzi)) S.opz.mezzi = [...new Set(S.opz.mezzi.map(m => (m === 'bus' || m === 'tram' ? 'aut' : m)).filter(m => m === 'nav' || m === 'aut'))];
  if (!Array.isArray(S.opz.mezzi) || !S.opz.mezzi.length) S.opz.mezzi = [...OPZ0.mezzi];
  // v27: preferenze come nelle app di trasporto (Migliore, Meno cambi, Meno a piedi); «Più veloce» e il tetto ai cambi non ci sono più
  if (S.opz.pref === 'veloce') S.opz.pref = 'equilibrata';
  S.opz.cambi = OPZ0.cambi;
}
const saveOpz = () => { try { localStorage.setItem(KEY_OPZ, JSON.stringify(S.opz)); } catch { /* facoltativo */ } };
// filtri diversi da quelli normali: numero (per il pulsante) e parametri della richiesta
const opzCount = () => Object.keys(OPZ0).filter(k => String(S.opz[k]) !== String(OPZ0[k])).length;
function opzQs() {
  const o = S.opz; let q = '';
  if (o.mezzi.length < 2) q += '&mezzi=' + o.mezzi.join(',');
  if (o.pref !== 'equilibrata') q += '&pref=' + o.pref;
  if (o.cambi !== '4') q += '&cambi=' + o.cambi;
  if (o.piedimax) q += '&piedimax=' + o.piedimax;
  if (o.passo !== 'normale') q += '&passo=' + o.passo;
  if (o.margine === 'largo') q += '&margine=largo';
  return q;
}

export function init(ctx) {
  X = ctx; restore();
  X.map?.on('dragstart zoomstart', userMove);                            // mappa spostata o ingrandita a mano (non dall'inquadratura automatica)
  // cambio di tema chiaro/scuro: i tratti a piedi sulla mappa si ridisegnano con i colori giusti
  new MutationObserver(() => { if (X.isOpen() && (S.res || S.det)) draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  X.chips.addEventListener('click', onClick); X.plist.addEventListener('click', onClick);
  X.chips.addEventListener('input', e => { if (e.target.matches('.pp-q')) { S.q = e.target.value; renderSuggest(); } });
  X.chips.addEventListener('change', e => {
    if (e.target.matches('.pp-time') && e.target.value) { S.time = e.target.value; run(); }
    if (e.target.matches('.pp-date')) { S.date = clampDate(e.target.value); e.target.value = S.date; run(); }
  });
  X.chips.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.pp-q')) { const f = X.plist.querySelector('.pp-sug'); if (f) f.click(); } if (e.key === 'Escape' && S.edit) { e.stopPropagation(); S.edit = null; render(); } });
}
export const isPicking = () => !!S.picking;
// livelli interni del pianificatore per il tasto «indietro» (nav.js): ricerca di un punto, opzioni, dettaglio di una soluzione
export const depth = () => (S.edit ? 1 : 0) + (S.showOpz ? 1 : 0) + (S.det ? 1 : 0);
export function back() {
  if (S.edit) { S.edit = null; S.q = ''; render(); draw(); return true; }
  if (S.showOpz) { const d = S.opzDirty; S.showOpz = false; S.opzDirty = false; renderForm(); if (d) run(); else renderBody(); return true; }
  if (S.det) { S.sel = -1; S.det = null; renderBody(); draw(); return true; }
  return false;
}
// a tutto schermo sul telefono finché non ci sono soluzioni da guardare sulla mappa
export const wantsFull = () => !!(S.edit || S.showOpz || !S.from || !S.to || (!S.res && !S.err));
// corse della soluzione disegnata sulla mappa («src:corsa»): i soli mezzi da mostrare mentre il pianificatore è aperto
export function tripsShown() {
  const o = S.det || S.res?.soluzioni?.[0]; const out = new Set();
  for (const t of o?.tratte || []) if (t.tipo === 'mezzo' && t.tripId) out.add(`${t.src}:${t.tripId}`);
  return out;
}
// percorso preferito (stella nell'intestazione del pannello): c'è un percorso completo? è già salvato?
export const canSave = () => !!(S.from && S.to);
// link condivisibile: codice di un punto (fermata f:, zona z:, punto della mappa p:); «la mia posizione» non si condivide mai
const epCode = ep => (!ep ? null : ep.kind === 'stop' ? 'f:' + ep.id : ep.kind === 'zone' ? 'z:' + ep.key : ep.kind === 'point' ? `p:${(+ep.lat).toFixed(5)},${(+ep.lon).toFixed(5)}` : null);
export const shareCodes = () => ({ da: epCode(S.from), a: epCode(S.to) });
export const isSaved = () => Fav.hasRoute(S.from, S.to);
export function toggleSaved() { if (!canSave()) return undefined; const r = Fav.toggleRoute(S.from, S.to); X.favChanged?.(); if (S.edit && !S.q) renderSuggest(); return r; }

// apre la pianificazione (from: punto di partenza già scelto, es. una fermata)
export function show(opts = {}) {
  if (opts.from || opts.to) { S.res = null; S.det = null; S.sel = -1; S.alts = null; S.showOpz = false; }
  if (opts.from) S.from = opts.from; if (opts.to) S.to = opts.to;
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
export function clear() { viewKey = solKey = ''; lastPts = []; clearInterval(timer); timer = null; clearTimeout(retry); S.picking = null; X.layer.clearLayers(); X.setPick(false); }
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
  S[f] = { kind: 'point', label: 'Punto sulla mappa', lat: ll.lat, lon: ll.lng }; S.edit = null; render(); run();
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// RICERCA
// ---------------------------------------------------------------------------------------------------------------------
// parametri comuni di /api/percorso e /api/percorso-simili (null se mancano i punti)
function baseQs() {
  const da = cands(S.from), a = cands(S.to);
  if (!da || !a || !da.length || !a.length) return null;
  let qs = `da=${encodeURIComponent(da.join(','))}&a=${encodeURIComponent(a.join(','))}`;
  const wv = walkVal.get(walkKey());
  if (wv) qs += `&piedi=${wv.m}&piedir=1`;                       // tutto a piedi: metri lungo le strade
  else if (S.from.lat != null && S.to.lat != null) qs += `&piedi=${Math.round(mDist(S.from.lat, S.from.lon, S.to.lat, S.to.lon))}`;
  if (S.when !== 'now' && S.time) {
    const [h, m] = S.time.split(':').map(Number);
    qs += `&secs=${h * 3600 + m * 60}&date=${clampDate(S.date).replace(/-/g, '')}`;
    if (S.when === 'by') qs += '&arrivo=1';
  }
  return qs + opzQs();
}
async function run(quiet) {
  if (!quiet) { S.walkShow = false; if (S.from && S.to) { S.loading = true; S.err = null; S.sel = -1; S.det = null; S.alts = null; renderBody(); } }
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
    S.res = r; S.loading = false;
    if (S.sel >= r.soluzioni.length) { S.sel = -1; S.det = null; }
    else if (S.sel >= 0) { const f = S.det?.famiglia, k = r.soluzioni.findIndex(o => o.famiglia === f); if (k >= 0) { S.sel = k; S.det = r.soluzioni[k]; } }   // stesso percorso, orari aggiornati
  } catch (e) {
    if (my !== token) return; S.loading = false;
    if (e.loading || e.busy) { S.loading = true; retry = setTimeout(() => { if (X.isOpen() && my === token) run(quiet); }, 2500); renderBody(); return; }   // orari di un'altra data in caricamento: si riprova da soli
    if (!quiet || !S.res) { S.res = null; S.err = 'Ricerca non riuscita: ' + e.message; }
  }
  renderBody(); draw();
  clearInterval(timer); timer = S.when === 'now' && S.res ? setInterval(() => { if (X.isOpen() && !S.edit && !document.hidden) run(true); }, REFRESH_MS) : null;
}

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
function render() { renderForm(); if (S.edit) renderSuggest(); else renderBody(); X.favChanged?.(); X.changed?.(); }
function fieldHtml(f) {
  const ep = S[f], lab = f === 'from' ? 'Da' : 'A';
  const val = ep ? `${ep.kind === 'me' ? icon('locate', 'sm') : ep.kind === 'point' ? icon('pin', 'sm') : srcIcon(ep.src, 'sm')}<span>${esc(epName(ep))}</span>`
    : `<span class="pp-ph">${f === 'from' ? 'Punto di partenza' : 'Dove vuoi andare?'}</span>`;
  // × per togliere il punto scelto (accanto al campo, non dentro: un pulsante non può contenerne un altro)
  return `<div class="pp-fw"><button type="button" class="pp-f" data-f="${f}" aria-label="${lab}: ${esc(ep ? epName(ep) : 'da scegliere')}"><small>${lab}</small><span class="pp-v">${val}</span></button>`
    + (ep ? `<button type="button" class="ibtn sm pp-fx" data-clr="${f}" aria-label="Cancella ${f === 'from' ? 'la partenza' : "l'arrivo"}" title="Cancella">${icon('close', 'sm')}</button>` : '') + '</div>';
}
function renderForm() {
  if (S.edit) {
    X.chips.innerHTML = `<div class="pp pp-editing"><div class="pp-qwrap"><button type="button" class="ibtn sm pp-qback" aria-label="Annulla">${icon('back')}</button>`
      + `<span class="xwrap"><input class="pp-q" type="search" enterkeyhint="search" autocomplete="off" maxlength="80" placeholder="${S.edit === 'from' ? 'Partenza: fermata o luogo' : 'Arrivo: fermata o luogo'}" aria-label="${S.edit === 'from' ? 'Cerca il punto di partenza' : 'Cerca il punto di arrivo'}" value="${esc(S.q)}">`
      + `<button type="button" class="ibtn sm xbtn" data-x aria-label="Cancella il testo"${S.q ? '' : ' hidden'}>${icon('close', 'sm')}</button></span></div></div>`;
    const inp = X.chips.querySelector('.pp-q'); if (inp && document.activeElement !== inp) setTimeout(() => inp.focus(), 30);
    return;
  }
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
    + (at ? `<span class="pp-tw"><input class="pp-date" type="date" value="${esc(S.date)}" min="${esc(clampDate(t))}"${range.max ? ` max="${esc(range.max)}"` : ''} aria-label="Giorno${dateLab ? ' (oggi)' : ''}">`
      + `<input class="pp-time" type="time" value="${esc(S.time)}" step="300" aria-label="${by ? 'Arrivo entro le' : 'Partenza alle'}"></span>` : '')
    + `<button type="button" class="pp-opzbtn${S.showOpz ? ' on' : ''}" aria-expanded="${S.showOpz}" aria-label="Opzioni del percorso${opzCount() ? ` (${opzCount()} attive)` : ''}" title="Opzioni">${icon('sliders', 'sm')}<span class="pp-optx">Opzioni</span>${opzCount() ? `<span class="pp-cnt">${opzCount()}</span>` : ''}</button>`
    + '</div></div>';
}
function renderSuggest() {
  const q = S.q.trim(), qn = norm(q.toLowerCase()), out = [];
  out.push(`<button type="button" class="pp-sug" data-s="me">${icon('locate')}<span><b>La mia posizione</b><small>usata solo sul telefono: al server vanno le fermate vicine</small></span></button>`);
  out.push(`<button type="button" class="pp-sug" data-s="map">${icon('pin')}<span><b>Scegli sulla mappa</b><small>tocca il punto sulla mappa</small></span></button>`);
  if (!q) {
    const rs = Fav.allRoutes();
    if (rs.length) out.push('<div class="search-category">Percorsi salvati</div>' + rs.slice(0, 8).map(r => `<button type="button" class="pp-sug" data-s="route" data-k="${esc(r.k)}">${icon('route')}<span><b>${esc(r.from.label)}</b><small>${icon('next', 'sm')} ${esc(r.to.label)}</small></span></button>`).join(''));
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

const cambiTxt = o => (o.cambi ? `${o.cambi} ${o.cambi > 1 ? 'cambi' : 'cambio'}` : 'senza cambi');
// scheda di una soluzione (elenco e alternative). attr: attributi del pulsante; compact: senza la riga della partenza
function optCard(o, attr, live, compact = false) {
  const first = o.tratte.find(t => t.tipo === 'mezzo'), st = legStatus(first.da, live);
  const seq = o.tratte.map(t => t.tipo === 'piedi' ? walkChip(t.min) : `<span class="pp-b">${badge(t.line, t.color, t.src, ' sm')}</span>`).join(`<span class="pp-sep">${icon('next', 'sm')}</span>`);
  const when = live && o.partiMs ? `<span class="in-min" data-exp="${o.partiMs}">${esc(etaText(null, o.partiMs, 0))}</span>` : '';
  const poi = o.poi?.length ? `<span class="pp-o5">${S.res?.entro ? 'Anche prima, alle' : 'Poi alle'} ${o.poi.map(x => `<b>${esc(x.parti)}</b>`).join(' · ')}</span>` : '';
  return `<button type="button" class="pp-opt${compact ? ' sm' : ''}" ${attr}>`
    + `<span class="pp-o1"><span class="pp-times"><b>${esc(o.parti)}</b>${icon('next', 'sm')}<b>${esc(o.arrivi)}</b></span><span class="pp-dur">${minTxt(o.minuti)}</span></span>`
    + `<span class="pp-seq">${seq}</span>`
    + (compact ? '' : `<span class="pp-o3">${trkIcon(first.trk, live)}<span>Da ${stopName(first.da)}${st.txt ? ` · <span class="${st.cls}">${esc(st.txt)}</span>` : ''}</span></span>`)
    + `<span class="pp-o4">${when}<span>${cambiTxt(o)}${o.piedi ? ` · ${o.piedi} min a piedi` : ''}</span>${o.etichetta && !compact ? `<span class="pp-tag">${esc(o.etichetta)}</span>` : ''}${o.rischio ? '<span class="pp-tag warn">coincidenza a rischio</span>' : ''}</span>`
    + (compact ? '' : poi) + '</button>';
}
const kmTxt = m => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
// «tutto a piedi» disegnato sulla mappa: scelto toccando la scheda, o da solo se nessun mezzo conviene
const walkShown = () => !S.det && !!walkVal.get(walkKey()) && S.res?.piedi != null && (S.walkShow || !S.res.soluzioni.length);
const PREF_TXT = { equilibrata: 'Migliore', veloce: 'Migliore', cambi: 'Meno cambi', piedi: 'Meno a piedi' };
function renderBody() {
  if (S.edit) return;
  if (S.showOpz) return renderOpz();
  const r = S.res, live = !!r?.live;
  if (!S.from || !S.to) { X.plist.innerHTML = `<p class="muted pad">Scegli ${!S.from ? 'la partenza' : 'l\'arrivo'}: una fermata, la tua posizione o un punto sulla mappa.</p>`; return; }
  if (S.loading && !r) { X.plist.innerHTML = '<p class="muted pad">Cerco le soluzioni…</p>'; return; }
  if (S.err) { X.plist.innerHTML = `<p class="late pad">${esc(S.err)}</p>`; return; }
  if (!r) { X.plist.innerHTML = ''; return; }
  if (S.det) return renderDetail(S.det, live);
  const nf = opzCount();
  const head = `<p class="pp-meta muted">${live ? `In tempo reale · aggiornato alle ${new Date(r.aggiornato).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : r.entro ? `Orari programmati · arrivo entro le ${esc(r.entro)}` : `Orari programmati · partenza dalle ${esc(r.ora)}`}`
    + (nf ? ` · <button type="button" class="nlink pp-opzlink">${nf} ${nf > 1 ? 'opzioni attive' : 'opzione attiva'}</button>` : '') + '</p>';
  const walkOnly = r.piedi != null && (!r.soluzioni.length || r.piedi <= Math.min(...r.soluzioni.map(o => o.minuti)) + 5)
    ? `<${walkVal.get(walkKey()) ? `button type="button" data-walkonly aria-pressed="${walkShown()}"` : 'div'} class="pp-walkonly${walkShown() ? ' on' : ''}">${icon('walk')}<span><b>A piedi: circa ${minTxt(r.piedi)}${walkVal.get(walkKey()) ? ` · ${kmTxt(walkVal.get(walkKey()).m)}` : ''}</b>${r.soluzioni.length ? (r.piedi <= Math.min(...r.soluzioni.map(o => o.minuti)) ? '<small>fai prima a piedi</small>' : '') : '<small>nessun mezzo conviene per questo tragitto</small>'}${walkVal.get(walkKey()) ? `<small>${walkShown() ? 'sulla mappa il percorso a piedi' : 'tocca per vederlo sulla mappa'}</small>` : ''}</span></${walkVal.get(walkKey()) ? 'button' : 'div'}>` : '';
  if (!r.soluzioni.length) {
    X.plist.innerHTML = head + walkOnly + (walkOnly ? '' : `<p class="muted pad">${r.senzaFermate ? `Nessuna fermata ${S.opz.piedimax ? `entro ${S.opz.piedimax} minuti a piedi` : 'vicina'} al punto scelto.` : r.entro ? `Nessuna soluzione per arrivare entro le ${esc(r.entro)} (si guardano le 5 ore prima). Prova un orario più tardi.` : 'Nessuna soluzione nelle prossime ore con autobus, tram o battelli. Prova un altro orario o un punto vicino.'}${nf ? ' Le opzioni attive possono escludere delle soluzioni.' : ''}</p>`);
    return;
  }
  X.plist.innerHTML = head + walkOnly + `<div class="pp-list">${r.soluzioni.map((o, k) => optCard(o, `data-k="${k}"`, live)).join('')}</div>`
    + `<button type="button" class="nlink pp-later">${icon('clock', 'sm')}${r.entro ? 'Soluzioni precedenti' : 'Soluzioni più tardi'}</button>`
    + `<p class="pp-note muted">Una proposta per percorso, ordinate per «${esc(PREF_TXT[S.opz.pref] || 'Migliore')}»: nel dettaglio trovi gli altri orari e le alternative. Tempi a piedi sulla rete pedonale di OpenStreetMap; fanno fede gli orari ACTV.</p>`;
}
// pagina delle opzioni: mezzi, preferenza, cambi, camminata, passo, margine
function renderOpz() {
  const o = S.opz, seg = (k, vals) => `<div class="chips pp-seg" role="group">${vals.map(([v, t]) => `<button type="button" class="chip all${String(o[k]) === v ? ' on' : ''}" data-o="${k}" data-v="${v}" aria-pressed="${String(o[k]) === v}">${t}</button>`).join('')}</div>`;
  const mz = [['nav', 'ship', 'Battelli'], ['aut', 'bus', 'Autobus e tram']];
  X.plist.innerHTML = `<button type="button" class="linkback pp-oback">${icon('back', 'sm')}<span>Soluzioni</span></button>`
    + '<div class="pp-opz">'
    + `<div class="pp-og"><b>Mezzi</b><div class="chips pp-seg" role="group">${mz.map(([v, ic, t]) => `<button type="button" class="chip all${o.mezzi.includes(v) ? ' on' : ''}" data-m="${v}" aria-pressed="${o.mezzi.includes(v)}">${icon(ic, 'sm')}${t}</button>`).join('')}</div></div>`
    + `<div class="pp-og"><b>Preferisci</b>${seg('pref', [['equilibrata', 'Migliore'], ['cambi', 'Meno cambi'], ['piedi', 'Meno a piedi']])}`
    + `<small class="muted">${{ equilibrata: 'Il percorso più comodo: un cambio si propone solo se fa risparmiare almeno 8 minuti.', cambi: 'Meglio aspettare il mezzo diretto: un cambio si propone solo se fa risparmiare almeno 20 minuti.', piedi: 'Ogni minuto a piedi pesa come tre minuti di viaggio.' }[o.pref] || ''}</small></div>`
    + `<div class="pp-og"><b>A piedi, per ogni tratto</b>${seg('piedimax', [['', 'Senza limite'], ['5', '5 min'], ['10', '10 min'], ['15', '15 min'], ['20', '20 min']])}</div>`
    + `<div class="pp-og"><b>Il tuo passo</b>${seg('passo', [['lento', 'Tranquillo'], ['normale', 'Normale'], ['veloce', 'Svelto']])}`
    + `<small class="muted">${{ lento: 'Circa 3,5 km/h: con bagagli, bambini o chi cammina piano.', normale: 'Circa 4,5 km/h a Venezia (ponti e folla) e 4,8 km/h in terraferma.', veloce: 'Circa 5,6 km/h a Venezia e 6 km/h in terraferma: chi conosce le calli.' }[o.passo]}</small></div>`
    + `<div class="pp-og"><b>Tempo per i cambi</b>${seg('margine', [['normale', 'Normale'], ['largo', 'Più tempo (+3 min)']])}<small class="muted">Normale: 1 minuto tra autobus e tram, 2 se c'è un battello.</small></div>`
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
    if (nx && nx.tipo === 'mezzo') steps.push(`<li class="pp-step chg"><span class="pp-sic">${icon('next', 'sm')}</span><div><b>Cambio</b><small>stessa fermata</small></div></li>`);
  });
  steps.push(`<li class="pp-step end"><span class="pp-sic">${icon('pin')}</span><div><b>Arrivo alle ${esc(o.arrivi)}</b><small>${esc(epName(S.to))}</small></div></li>`);
  X.plist.innerHTML = `<button type="button" class="linkback pp-back">${icon('back', 'sm')}<span>Tutte le soluzioni</span></button>`
    + `<div class="pp-dsum"><span class="pp-times"><b>${esc(o.parti)}</b>${icon('next', 'sm')}<b>${esc(o.arrivi)}</b></span><span class="muted">${minTxt(o.minuti)} · ${cambiTxt(o)}${o.piedi ? ` · ${o.piedi} min a piedi` : ''}</span>${o.rischio ? '<span class="pp-tag warn">Coincidenza a rischio con i tempi aggiornati</span>' : ''}</div>`
    + `<ol class="pp-steps"><li class="pp-step start"><span class="pp-sic">${S.from.kind === 'me' ? icon('locate') : icon('pin')}</span><div><b>Partenza alle ${esc(o.parti)}</b><small>${esc(epName(S.from))}</small></div></li>${steps.join('')}</ol>`
    + '<section class="pp-alts" aria-live="polite"></section>';
  renderAlts(); loadAlts(o);
}
// alternative nel dettaglio
function renderAlts() {
  const box = X.plist.querySelector('.pp-alts'), o = S.det; if (!box || !o) return;
  const A = S.alts, live = !!S.res?.live;
  if (!A || A.loading) { box.innerHTML = `<h3 class="pp-ah">Alternative</h3><p class="muted pad">Cerco gli altri orari e le alternative…</p>`; return; }
  if (A.err || !A.data) { box.innerHTML = `<h3 class="pp-ah">Alternative</h3><p class="muted pad">Alternative non disponibili.</p>`; return; }
  const d = A.data, same = d.stesso.filter(x => x.famiglia === o.famiglia);
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
  const r = S.res, o = S.det || r?.soluzioni?.[0], pts = [], myDraw = ++drawTok;
  const mark = (ep, end) => { if (!ep || ep.lat == null) return; L.circleMarker([ep.lat, ep.lon], { radius: 8, weight: 3, color: end ? '#b42318' : '#0b62c4', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(X.layer); pts.push([ep.lat, ep.lon]); };
  // tratto a piedi: alone (chiaro sulla mappa chiara, scuro su quella scura) e pallini tondi sopra, come nelle app di mappe.
  // La mappa disegna su canvas: i colori si scelgono qui secondo il tema (e al cambio di tema si ridisegna, vedi in fondo).
  const dark = document.documentElement.dataset.theme === 'dark', WS = dark ? { halo: '#0b1520', ho: .85, dot: '#7cc0ff' } : { halo: '#ffffff', ho: .92, dot: '#0b62c4' };
  const walkPath = (pts, pending) => [
    L.polyline(pts, { color: WS.halo, weight: 10, opacity: WS.ho, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(X.layer),
    L.polyline(pts, { color: WS.dot, weight: 6, opacity: pending ? .45 : 1, dashArray: '0.1 10', lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(X.layer)   // provvisorio (linea retta): più tenue
  ];
  // subito in linea retta (più tenue), poi (appena calcolato sul telefono) lungo le strade; k = tappa nel dettaglio (per i metri)
  const walkLine = (a, b, k) => {
    const near = mDist(a[0], a[1], b[0], b[1]) < 15, line = walkPath([a, b], !near);
    if (near) return;
    pathFor(a, b).then(w => {
      if (!w || myDraw !== drawTok) { if (myDraw === drawTok) line[1].setStyle?.({ opacity: 1 }); return; }   // niente percorso: resta la linea retta, piena
      for (const l of line) X.layer.removeLayer(l);
      walkPath(w.pts);
      // il tratto lungo le strade esce dall'inquadratura: si riallarga (solo se non hai spostato la mappa)
      if (!userMoved && X.map && !w.pts.every(p => X.map.getBounds().contains(p))) { pts.push(...w.pts); fitTo(pts); }
      const st = k != null && X.plist.querySelector(`.pp-step.walk[data-wk="${k}"] small`);
      if (st && !st.dataset.m) { st.dataset.m = '1'; st.textContent += `${st.textContent ? ' · ' : ''}${kmTxt(w.m)}`; }
    });
  };
  if (walkShown()) {                                              // tutto a piedi
    const w = walkVal.get(walkKey());
    walkPath(w.pts); pts.push(...w.pts);
  } else if (o) {
    let prev = S.from?.lat != null ? [S.from.lat, S.from.lon] : null;
    const walkTo = (p, k) => { if (prev && p) { walkLine(prev, p, k); pts.push(prev, p); } };
    o.tratte.forEach((t, k) => {
      if (t.tipo === 'piedi') { const p = t.a?.lat != null ? [t.a.lat, t.a.lon] : t.estremo === 'arrivo' && S.to?.lat != null ? [S.to.lat, S.to.lon] : null; if (t.da?.lat != null) prev = [t.da.lat, t.da.lon]; walkTo(p, k); if (p) prev = p; return; }
      const start = t.da.lat != null ? [t.da.lat, t.da.lon] : null; if (prev && start && mDist(prev[0], prev[1], start[0], start[1]) > 25) walkTo(start);
      const line = t.shape?.length ? t.shape : t.stops.map(s => [s[0], s[1]]);
      X.drawLine(line, colorInfo(t.color, t.line), X.layer, .95);
      for (const s of [t.stops[0], t.stops[t.stops.length - 1]]) L.circleMarker([s[0], s[1]], { radius: 5, weight: 2, color: '#0f172a', fillColor: '#fff', fillOpacity: 1 }).bindTooltip(esc(s[2])).addTo(X.layer);
      pts.push(...line);
      prev = t.a.lat != null ? [t.a.lat, t.a.lon] : prev;
    });
    if (S.to?.lat != null && prev && mDist(prev[0], prev[1], S.to.lat, S.to.lon) > 25 && o.tratte[o.tratte.length - 1].tipo === 'mezzo') walkTo([S.to.lat, S.to.lon]);
  }
  mark(S.from, false); mark(S.to, true);
  X.changed?.();                                                  // impaginazione (foglio o tutto schermo) e mezzi sulla mappa: solo quelli di questa soluzione
  const vk = `${S.from ? ptKey(S.from) : ''}|${S.to ? ptKey(S.to) : ''}|${walkShown()}|${S.det ? solId(S.det) : ''}`, sk = solId(o);
  if (vk !== viewKey) { viewKey = vk; solKey = sk; userMoved = false; fitTo(pts); }        // scelta tua: si inquadra sempre
  else if (sk !== solKey) { solKey = sk; if (!userMoved) fitTo(pts); }                      // cambiata da un aggiornamento: solo se non hai mosso la mappa
}

// ---------------------------------------------------------------------------------------------------------------------
// TOCCHI
// ---------------------------------------------------------------------------------------------------------------------
function choose(f, ep) { S[f] = ep; S.edit = null; S.q = ''; save(); render(); if (S.from && S.to) run(); else { S.edit = !S.from ? 'from' : !S.to ? 'to' : null; render(); } }
function onClick(e) {
  if (!X.isOpen()) return;
  const t = e.target;
  const fld = t.closest('.pp-f'); if (fld) { S.edit = fld.dataset.f; S.q = ''; render(); return; }
  if (t.closest('.pp-qback')) { S.edit = null; S.q = ''; render(); draw(); return; }
  if (t.closest('.pp-swap')) { [S.from, S.to] = [S.to, S.from]; save(); render(); run(); return; }
  const clr = t.closest('[data-clr]');
  if (clr) { S[clr.dataset.clr] = null; S.res = null; S.det = null; S.sel = -1; S.alts = null; S.err = null; save(); render(); X.layer.clearLayers(); return; }
  const w = t.closest('[data-w]'); if (w) { S.when = w.dataset.w; S.showOpz = false; render(); run(); return; }
  const sg = t.closest('.pp-sug');
  if (sg) {
    const f = S.edit, k = sg.dataset.k;
    if (sg.dataset.s === 'me') { const me = X.me(); if (me) choose(f, meEp(me)); else { S.asked = f; X.locate(); X.plist.innerHTML = '<p class="muted pad">Cerco la tua posizione…</p>'; } return; }
    if (sg.dataset.s === 'map') { S.picking = f; X.setPick(true, f === 'from' ? 'Tocca la mappa nel punto di partenza' : 'Tocca la mappa nel punto di arrivo'); return; }
    if (sg.dataset.s === 'zone') { const z = zones.get(k); if (z) choose(f, zoneEp(z)); return; }
    if (sg.dataset.s === 'route') { const r = Fav.routeByKey(k); if (r) { S.edit = null; S.q = ''; show({ from: { ...r.from }, to: { ...r.to } }); X.favChanged?.(); } return; }
    if (sg.dataset.s === 'stop') { const s = X.stopById.get(k) || X.allStops().find(x => x[0] === k); if (s) choose(f, stopEp(s[0], s[1], s[4])); return; }
    if (sg.dataset.s === 'fav') {
      if (k.startsWith('zone:')) { const z = zones.get(k.slice(5)); if (z) choose(f, zoneEp(z)); }
      else { const id = k.slice(5), s = X.stopById.get(aliasOf.get(id) || id); if (s) choose(f, stopEp(s[0], s[1], s[4])); }
      return;
    }
  }
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
  if (alt && S.alts?.data) { const [kind, k] = alt.dataset.alt.split(':'), x = S.alts.data[kind]?.[+k]; if (x) { S.det = x; S.sel = -1; renderBody(); draw(); X.plist.scrollTop = 0; } return; }
  const opt = t.closest('.pp-opt'); if (opt && opt.dataset.k != null) { S.sel = +opt.dataset.k; S.det = S.res?.soluzioni?.[S.sel] || null; renderBody(); draw(); X.plist.scrollTop = 0; return; }
  if (t.closest('.pp-back')) { S.sel = -1; S.det = null; renderBody(); draw(); return; }
  if (t.closest('.pp-later')) {
    const r = S.res; if (!r?.soluzioni?.length) return;
    if (r.entro) {                                             // arrivo entro: un minuto prima dell'arrivo più presto mostrato
      const first = r.soluzioni.reduce((m, o) => (cmpHm(o.arrivi, m, r.entro) < 0 ? o.arrivi : m), r.soluzioni[0].arrivi), [h, m] = first.split(':').map(Number), d = new Date(); d.setHours(h, m - 1, 0, 0);
      S.time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; render(); run(); return;
    }
    const last = r.soluzioni.reduce((m, o) => (o.parti > m ? o.parti : m), r.soluzioni[0].parti), [h, m] = last.split(':').map(Number), d = new Date(); d.setHours(h, m + 1, 0, 0);
    if (S.when === 'now') S.date = today(); S.when = 'at'; S.time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; render(); run(); return;
  }
  const ride = t.closest('.pp-ride');
  if (ride) { const leg = S.det?.tratte[+ride.dataset.leg]; if (leg) X.openTrip(leg); }
}
