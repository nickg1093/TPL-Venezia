// FILTRI E LIVELLI DELLA MAPPA: i due pulsanti in cima alla colonna di destra.
//  · «Mezzi sulla mappa»: menu con Navigazione, Automobilistico, Mezzi senza linea (gli interruttori sono quelli di sempre: app.js li legge
//    come prima). Un punto sul pulsante dice che qualche filtro è diverso dal solito.
//  · «Livelli della mappa»: allagamento stimato della città e percorsi su passerelle all'ora scelta (adesso, colmo previsto, o l'ora del
//    cursore nel grafico della marea), tenendo conto del MOSE (regole in acqua.js).
// DATI: /acqua/{indice,quote,passerelle}.json (scripts/genera-acqua.js, stima, ~16 kB compressi) e, se c'è, il rilievo RAMSES in
// /acqua/rilievo/ (indice ~1 kB + 13 tessere di ~1,2 km, 25 kB compressi in tutto, al più ~6 kB l'una; «Fonte informativa: Insula spa»). Si scaricano SOLO quando un livello si accende (a mano, o da solo con la marea da +80 cm in su) e, per le tessere, solo
// per la zona vista o del percorso; una volta per versione, poi restano nel telefono (cache «tpl-fissi-1», impronta SHA-256 controllata).
// Anche gli indici restano salvati: SENZA RETE si usano gli ultimi file verificati (la marea, invece, serve dalla rete o già caricata).
// Nessun calcolo e nessuna richiesta in più al server oltre ai file statici.
// Livelli «automatici» (scelta predefinita): accesi con la marea in città da +80 cm (allagamento) e, in stagione, passerelle posate.
import { $, esc, hm, seguiScheda, altezzaUtile } from './util.js';
import * as Tide from './tide.js';
import * as Fissi from './fissi.js';
import * as X from './acqua.js';
import * as Walk from './camminata.js';

const KEY = 'tpl.livelli', ORA_MS = 5 * 60e3, IND_KEY = '/__acqua/indice', RIL_KEY = '/__acqua/rilievo-indice';
let map = null, beforeOpenFn = () => {}, toastFn = () => {};
let pref = { all: 'auto', pass: 'auto', q: 'ora' };
let dati = null, caricoP = null, errore = null, ril = null;   // ril: { ind, g, t: Map tessere, meta, attese: Map }
let imgLayer = null, imgCm = null, passLayer = null, passSig = '', svgR = null, avvisato = '';
try { const p = JSON.parse(localStorage.getItem(KEY) || 'null'); if (p && typeof p === 'object') for (const k of ['all', 'pass']) if (['auto', 'on', 'off'].includes(p[k])) pref[k] = p[k]; if (p && ['ora', 'colmo'].includes(p.q)) pref.q = p.q; } catch { /* memoria non disponibile */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(pref)); } catch { /* facoltativo */ } };
const fmt = cm => `${cm > 0 ? '+' : cm < 0 ? '−' : ''}${Math.abs(Math.round(cm))}`;
const dayTag = ms => { const a = new Date(ms), b = new Date(); return a.toDateString() === b.toDateString() ? '' : a.toLocaleDateString('it-IT', { weekday: 'short' }) + ' '; };

// ---------------- dati: indice, quote e passerelle (verificati, salvati sul telefono) ----------------
export function carica() {
  if (dati) return Promise.resolve(dati);
  if (caricoP) return caricoP;
  caricoP = (async () => {
    const valido = i => !!(i && i.formato === 1 && /^[0-9a-f]{64}$/.test(i.files?.quote?.sha || '') && /^[0-9a-f]{64}$/.test(i.files?.passerelle?.sha || ''));
    let ind = await fetch('/acqua/indice.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    const c = await Fissi.openCache();
    if (valido(ind)) { if (c) c.put(IND_KEY, new Response(JSON.stringify(ind), { headers: { 'Content-Type': 'application/json' } })).catch(() => {}); }
    else ind = c ? await c.match(IND_KEY).then(r => (r ? r.json() : null)).catch(() => null) : null;   // senza rete: l'ultimo indice verificato
    if (!valido(ind)) throw new Error('dati non disponibili');
    const get = async n => { const f = ind.files[n]; const b = await Fissi.getVerified('/__acqua/' + f.sha, f.sha, [`/acqua/${n}.json?h=${f.sha.slice(0, 12)}`]); return JSON.parse(new TextDecoder().decode(b)); };
    const [q, p] = await Promise.all([get('quote'), get('passerelle')]);
    const Qb = X.quoteDa(q), P = X.passerelleDa(p); if (!Qb || !P) throw new Error('dati non validi');
    const ri = await rilievoIndice(c);
    ril = ri ? { ind: ri, g: ri.g, t: new Map(), meta: ri.rilievo, attese: new Map() } : null;
    prune(new Set([...Object.values(ind.files).map(f => f.sha), ...(ri ? Object.values(ri.files).map(f => f.sha) : []), IND_KEY.slice(9), RIL_KEY.slice(9)]));
    errore = null; dati = { Q: ril ? X.composta(Qb, ril) : Qb, Qb, P, v: ind.v };
    const card = document.getElementById('ip-ramses'); if (card) card.hidden = !ril;
    return dati;
  })().catch(e => { caricoP = null; errore = e.message || 'non disponibili'; return null; });
  return caricoP;
}
export const pronti = () => dati;
// RILIEVO (quote misurate, facoltativo): /acqua/rilievo/indice.json + tessere di ~1,2 km. Se la cartella manca (404): solo stima, come prima. Indice salvato per l'uso senza rete; tessere scaricate solo per la zona
// che serve (vista della mappa, zona del percorso), verificate con l'impronta e salvate come gli altri file.
async function rilievoIndice(c) {
  const ok = i => !!(i && i.formato === 1 && i.g && i.g.dlat > 0 && i.g.dlon > 0 && i.files && Object.values(i.files).every(f => /^[0-9a-f]{64}$/.test(f?.sha || '')) && i.rilievo?.attribuzione);
  let i = await fetch('/acqua/rilievo/indice.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : r.status === 404 ? false : null)).catch(() => null);
  if (i === false) { if (c) c.delete(RIL_KEY).catch(() => {}); return null; }   // il server non ha il rilievo: niente tessere vecchie
  if (ok(i)) { if (c) c.put(RIL_KEY, new Response(JSON.stringify(i), { headers: { 'Content-Type': 'application/json' } })).catch(() => {}); return i; }
  i = c ? await c.match(RIL_KEY).then(r => (r ? r.json() : null)).catch(() => null) : null;
  return ok(i) ? i : null;
}
// carica le tessere del rilievo che toccano il riquadro [sud, ovest, nord, est]; restituisce quante sono nuove (0 = niente da ridisegnare)
export async function prepara(box) {
  if (!ril || !box) return 0;
  const g = ril.g, r0 = Math.floor((box[0] - g.lat0) / g.dlat), r1 = Math.floor((box[2] - g.lat0) / g.dlat), c0 = Math.floor((box[1] - g.lon0) / g.dlon), c1 = Math.floor((box[3] - g.lon0) / g.dlon);
  const ids = [];
  for (let r = Math.max(0, r0); r <= r1; r++) for (let c = Math.max(0, c0); c <= c1; c++) { const id = `${r}_${c}`; if (ril.ind.files[id] && !ril.t.has(id)) ids.push(id); }
  if (!ids.length) return 0;
  const prima = ril.t.size;
  await Promise.all(ids.map(id => {
    if (!ril.attese.has(id)) {
      const f = ril.ind.files[id];
      ril.attese.set(id, Fissi.getVerified('/__acqua/' + f.sha, f.sha, [`/acqua/rilievo/${id}.json?h=${f.sha.slice(0, 12)}`])
        .then(b => { const q = X.quoteDa(JSON.parse(new TextDecoder().decode(b))); if (q) ril.t.set(id, q); })
        .catch(() => {}).finally(() => ril.attese.delete(id)));                 // senza rete e mai scaricata: lì resta la stima
    }
    return ril.attese.get(id);
  }));
  return ril.t.size - prima;
}
export const tessere = () => (ril ? ril.t.size : 0);
async function prune(keep) {
  const c = await Fissi.openCache(); if (!c) return;
  try { for (const req of await c.keys()) { const p = new URL(req.url).pathname; if (p.startsWith('/__acqua/') && !keep.has(p.slice(9))) c.delete(req); } } catch { /* niente */ }
}

// PROVA IN LOCALE: solo sul computer (localhost) l'indirizzo «?marea=110» simula quel livello in città (osservato, per tutte le ore), per
// vedere livelli e pianificatore con l'acqua alta anche quando la marea vera è bassa. Sul sito pubblico il parametro non fa nulla.
const PROVA = (() => { try { if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return null; const v = +new URLSearchParams(location.search).get('marea'); return v >= 40 && v <= 200 ? Math.round(v) : null; } catch { return null; } })();
const livelloTide = t => (PROVA != null ? { cm: PROVA, kind: 'osservato' } : Tide.levelAt(t));
// ---------------- livello all'ora scelta ----------------
// { ms, raw: { cm, kind }, eff: { cm, kind, mose, mare? }, quando: 'cursore' | 'ora' | 'colmo' } oppure null (marea non disponibile)
function momento() {
  const now = Date.now(), cur = Tide.cursorAt();
  if (cur != null) { const raw = livelloTide(cur); return raw ? { ms: cur, raw, eff: X.livelloCitta(raw, Tide.moseState()), quando: 'cursore' } : null; }
  if (pref.q === 'colmo' && PROVA == null) {
    const sp = Tide.span(), pk = sp ? Tide.peakIn(now, sp.to) : null;
    if (pk) return { ms: pk.ts, raw: pk, eff: X.livelloCitta(pk, Tide.moseState()), quando: 'colmo' };
  }
  const raw = livelloTide(now) || livelloTide(now - 15 * 60e3);
  return raw ? { ms: now, raw, eff: X.livelloCitta(raw, Tide.moseState()), quando: 'ora' } : null;
}
// colmo previsto nelle prossime ore, già «in città» (per proporre i livelli prima che servano)
function colmo() { if (PROVA != null) return { ...X.livelloCitta({ cm: PROVA, kind: 'osservato' }, null), ts: Date.now() }; const now = Date.now(), sp = Tide.span(), pk = sp ? Tide.peakIn(now, sp.to) : null; return pk ? { ...X.livelloCitta(pk, Tide.moseState()), ts: pk.ts } : null; }

// Livello per il pianificatore: all'istante ms, in città; null se la marea non è nota a quell'ora
export function livelloA(ms) { const raw = livelloTide(ms); return raw ? X.livelloCitta(raw, Tide.moseState()) : null; }
// colmo tra due istanti (per il viaggio): { cm, kind, ts } come Tide.peakIn, con la prova in locale; null se la marea non è nota
export function picco(da, a) { if (PROVA != null) return { cm: PROVA, kind: 'osservato', ts: da, prova: true }; return Tide.peakIn(da, a); }

// ---------------- disegno sulla mappa ----------------
function panes() {
  if (svgR) return;
  const a = map.createPane('acqua'); a.style.zIndex = 350; a.style.pointerEvents = 'none';
  const p = map.createPane('passerelle'); p.style.zIndex = 450;   // sopra la tela dei tracciati (400), sotto fermate e mezzi
  svgR = L.svg({ pane: 'passerelle' }); canR = L.canvas({ pane: 'acqua', padding: 0.2 });
  map.on('moveend', () => { if (acquaOn) { clearTimeout(muovi); muovi = setTimeout(aggiorna, 250); } });
}
// ALLAGAMENTO, SOLO DOVE SI CAMMINA: le calli, fondamenta e campi della rete pedonale (le stesse mattonelle dei percorsi a piedi, dal CDN),
// colorate dove la quota è sotto il livello; ponti esclusi. Profondità in 4 fasce di colore; linea CONTINUA dove la quota è misurata
// (rilievo RAMSES), TRATTEGGIATA dove è stimata (se il file non ha il rilievo, tutto continuo come prima). Con la mappa lontana (zoom sotto
// 13) niente acqua (si vedono le passerelle e la nota «avvicina la mappa»); solo senza rete pedonale le celle della griglia, nette e piccole.
const FASCE = [[2, 10, 0.45], [10, 20, 0.6], [20, 35, 0.75], [35, 999, 0.9]], SPESSORE = { 13: 1.5, 14: 2, 15: 3, 16: 4, 17: 6, 18: 9, 19: 12 };
let canR = null, calliLayer = null, calliSig = '', muovi = 0, calliTok = 0, acquaOn = false, lontano = false;
const memoPezzi = new Map();                                    // tratto -> pezzi bagnati per fascia, al livello memoCm
let memoCm = null;
function pezziBagnati(e, cm) {
  let v = memoPezzi.get(e); if (v) return v;
  v = [[], [], [], [], [], [], [], []];                          // 0-3 fasce su quote misurate, 4-7 le stesse su quote stimate
  const tratteggio = !!dati.Q.rilievo;
  if (!X.ponte(e)) {
    const g = e.g; let cur = null, curF = -1;
    const chiudi = () => { if (cur && cur.length > 1) v[curF].push(cur); cur = null; curF = -1; };
    for (let i = 1; i < g.length; i++) {
      const la0 = g[i - 1][0] / 1e6, lo0 = g[i - 1][1] / 1e6, la1 = g[i][0] / 1e6, lo1 = g[i][1] / 1e6;
      const L = Math.hypot((la1 - la0) * 111320, (lo1 - lo0) * 78000), n = Math.max(1, Math.ceil(L / 5));
      for (let j = 0; j <= n; j++) {
        if (i > 1 && j === 0) continue;
        const f = j / n, la = la0 + (la1 - la0) * f, lo = lo0 + (lo1 - lo0) * f, h = dati.Q.at(la, lo), d = h == null ? -1 : cm - h;
        let k = d < 2 ? -1 : FASCE.findIndex(([a, b]) => d >= a && d < b);
        if (k >= 0 && tratteggio && !dati.Q.misurata(la, lo)) k += 4;
        if (k !== curF) { const last = cur && cur[cur.length - 1]; chiudi(); if (k >= 0) { cur = last ? [last] : []; curF = k; } }
        if (k >= 0) cur.push([la, lo]);
      }
    }
    chiudi();
  }
  memoPezzi.set(e, v); return v;
}
async function disegnaAcqua(cm) {
  acquaOn = true;
  const z = map.getZoom(), B = map.getBounds().pad(0.15), G = dati.Q.G;
  // solo la parte della vista dentro la zona stimata (città, isole): meno mattonelle da caricare
  const bbox = [Math.max(B.getSouth(), G.lat0), Math.max(B.getWest(), G.lon0), Math.min(B.getNorth(), G.lat0 + G.righe * G.dlat), Math.min(B.getEast(), G.lon0 + G.colonne * G.dlon)];
  const tok = ++calliTok;
  lontano = z < 13;
  if (lontano || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) { togliCalli(); togliGriglia(); return; }
  const [edges, nuove] = await Promise.all([Walk.tratti(bbox, 40), prepara(bbox)]);
  if (tok !== calliTok) return;
  if (nuove) { memoPezzi.clear(); calliSig = ''; }
  if (!edges) { togliCalli(); return griglia(cm); }
  togliGriglia();
  if (memoCm !== cm) { memoPezzi.clear(); memoCm = cm; }
  const sig = `${cm}|${z}|${bbox.map(x => x.toFixed(3)).join(',')}`; if (calliLayer && sig === calliSig) return;
  const per = [[], [], [], [], [], [], [], []];
  for (const e of edges) { const v = pezziBagnati(e, cm); for (let k = 0; k < 8; k++) if (v[k].length) per[k].push(...v[k]); }
  const lg = L.layerGroup(), w = SPESSORE[Math.max(13, Math.min(19, Math.round(z)))];
  per.forEach((lines, k) => { if (lines.length) L.polyline(lines, { renderer: canR, color: '#1e78e6', opacity: FASCE[k % 4][2], weight: w, lineCap: 'butt', lineJoin: 'round', dashArray: k >= 4 ? `${Math.round(w * 1.6)} ${Math.round(w * 1.2)}` : null, interactive: false }).addTo(lg); });
  togliCalli(); calliLayer = lg.addTo(map); calliSig = sig;
  fonte(per.slice(0, 4).some(l => l.length));                         // quote misurate sulla mappa: «Fonte informativa: Insula spa»
}
function togliCalli() { if (calliLayer) { calliLayer.remove(); calliLayer = null; } calliSig = ''; fonte(false); }
let fonteVista = false;
function fonte(on) {
  const el = document.getElementById('attr-insula'); if (el) el.hidden = !on;
  if (on && !fonteVista) { fonteVista = true; document.dispatchEvent(new Event('tpl:crediti')); }   // prima volta: crediti con la fonte Insula per 5 s
}
// riserva: celle della griglia (20 m) come piccoli quadrati netti, senza sfumare
function griglia(cm) {
  if (imgLayer && imgCm === cm) return;
  const { Q } = dati, G = Q.G, W = G.colonne, H = G.righe;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const v = Q.v[r * W + c]; if (v === 255) continue;
    const depth = cm - (50 + v * 2); if (depth < 2) continue;
    const k = FASCE.findIndex(([a, b]) => depth >= a && depth < b);
    const o = ((H - 1 - r) * W + c) * 4; d[o] = 30; d[o + 1] = 120; d[o + 2] = 230; d[o + 3] = Math.round(255 * FASCE[k][2] * 0.8);
  }
  ctx.putImageData(img, 0, 0);
  const b = [[G.lat0, G.lon0], [G.lat0 + H * G.dlat, G.lon0 + W * G.dlon]], url = cv.toDataURL();
  if (imgLayer) imgLayer.setUrl(url); else imgLayer = L.imageOverlay(url, b, { pane: 'acqua', interactive: false, className: 'acqua-img griglia' }).addTo(map);
  imgCm = cm;
}
function togliGriglia() { if (imgLayer) { imgLayer.remove(); imgLayer = null; imgCm = null; } }
function togliAcqua() { calliTok++; acquaOn = false; togliCalli(); togliGriglia(); }
function disegnaPasserelle(list, oltre) {
  const sig = list.map(p => p.id).join(',') + (oltre ? '!' : '');
  if (passLayer && sig === passSig) return;
  togliPasserelle(); passSig = sig;
  passLayer = L.layerGroup();
  for (const p of list) L.polyline(p.parti || p.pts, { renderer: svgR, className: 'pass-h', weight: 8, interactive: false }).addTo(passLayer);   // prima tutti gli aloni, poi le linee
  for (const p of list) {
    const txt = `<b>Passerella ${esc(p.t || p.id)}</b> · ${esc(p.s)}<br>${esc(p.d)}<br>Posata da ${fmt(p.q)} cm · ${Math.round(p.m)} m${p.k === 'i' ? '<br><i>Tracciato indicativo</i>' : p.osm >= 0.95 ? `<br><i>Tracciato ${p.tavola ? 'dalla tavola dell\'Atlante, ' : ''}sulle calli di OpenStreetMap</i>` : p.tavola ? `<br><i>Tracciato dalla tavola dell'Atlante${p.osm > 0 ? ', in parte sulle calli di OpenStreetMap' : ''}</i>` : ''}${oltre ? '<br><b>Oltre +120 cm alcuni tratti possono essere sommersi</b>' : ''}`;
    L.polyline(p.parti || p.pts, { renderer: svgR, className: `pass-l ${p.k}${oltre ? ' oltre' : ''}`, weight: 4.5 }).bindPopup(txt).addTo(passLayer);
  }
  passLayer.addTo(map);
}
function togliPasserelle() { if (passLayer) { passLayer.remove(); passLayer = null; } passSig = ''; }

// ---------------- stato e aggiornamento ----------------
let agg = 0;
function aggiorna() { if (agg) return; agg = requestAnimationFrame(() => { agg = 0; applica(); }); }
async function applica() {
  if (!map) return;
  const m = momento(), now = Date.now(), cm = m?.eff?.cm;
  const autoAll = Number.isFinite(cm) && cm >= X.MIN_ACQUA, stag = X.inStagione(m?.ms ?? now);
  const vedi = { all: pref.all === 'on' || (pref.all === 'auto' && autoAll), pass: pref.pass === 'on' || (pref.pass === 'auto' && autoAll && stag) };
  if ((vedi.all || vedi.pass) && !dati) { await carica(); }
  panes();
  let posateL = [], stato = null;
  if (dati && m) {
    stato = X.statoPasserelle(dati.P, cm, m.ms);
    posateL = X.posate(dati.P, cm, m.ms);
  }
  if (vedi.all && dati && Number.isFinite(cm)) await disegnaAcqua(cm); else togliAcqua();
  if (vedi.pass && dati && posateL.length) disegnaPasserelle(posateL, stato === 'oltre'); else togliPasserelle();
  // pulsante: punto blu se un livello è sulla mappa; arancio se l'acqua alta è prevista e i livelli sono spenti
  const pk = colmo(), badge = $('livelli-btn').querySelector('.fbadge');
  const sulla = (vedi.all && acquaOn) || (vedi.pass && passLayer);
  if (sulla) { badge.hidden = false; badge.dataset.k = 'acqua'; } else if (pk && pk.cm >= 90) { badge.hidden = false; badge.dataset.k = 'alta'; } else badge.hidden = true;
  const lab = 'Livelli della mappa: acqua alta e passerelle' + (sulla ? ' (accesi)' : pk && pk.cm >= 90 ? ` (acqua alta prevista ${fmt(pk.cm)} cm)` : '');
  $('livelli-btn').setAttribute('aria-label', lab); $('livelli-btn').title = lab;
  // avviso una volta per evento quando i livelli si accendono da soli
  if (sulla && (pref.all === 'auto' || pref.pass === 'auto') && Number.isFinite(cm)) {
    const k = `${new Date().toDateString()}|${Math.floor(cm / 10)}`;
    if (avvisato !== k && !isOpen()) { avvisato = k; toastFn(`Acqua alta ${fmt(cm)} cm: zone ${dati?.Q.rilievo ? 'dove può esserci acqua' : 'allagate (stima)'}${posateL.length ? ' e passerelle' : ''} sulla mappa. Tocca «Livelli» per le opzioni.`, 7000); }
  }
  if (!$('livelli').hidden) testi(m, vedi, stato, posateL, pk);
}
function testi(m, vedi, stato, posateL, pk) {
  $('lv-all').checked = vedi.all; $('lv-pass').checked = vedi.pass;
  const cm = m?.eff?.cm, quando = !m ? '' : m.quando === 'cursore' ? `alle ${dayTag(m.ms)}${hm(m.ms)} (ora scelta nel grafico)` : m.quando === 'colmo' ? `colmo previsto ${dayTag(m.ms)}alle ${hm(m.ms)}` : 'adesso';
  const auto = k => (pref[k] === 'auto' ? 'automatico' : pref[k] === 'on' ? 'sempre acceso' : 'spento');
  let sA, sP;
  if (!m) { sA = 'Marea non disponibile in questo momento'; sP = auto('pass'); }
  else {
    const perc = dati && cm >= X.MIN_ACQUA - 10 ? ` · circa ${Math.round(dati.Q.percento(cm))}% della città storica` : '';
    sA = `${fmt(cm)} cm ${quando}${perc} · ${auto('all')}`;
    sP = stato === 'fuori' ? 'fuori stagione (15 settembre – 30 aprile)' : stato === 'no' || (!dati && cm < X.MIN_ACQUA) ? `nessuna posata a ${fmt(cm)} cm · ${auto('pass')}`
      : dati ? `${posateL.length} percorsi posati a ${fmt(cm)} cm · ${auto('pass')}` : auto('pass');
  }
  $('lv-all-sub').textContent = sA; $('lv-pass-sub').textContent = sP;
  const segBtns = [...document.querySelectorAll('.lv-seg button')], cur = Tide.cursorAt() != null;
  for (const b of segBtns) { b.setAttribute('aria-checked', String(!cur && b.dataset.q === pref.q)); b.disabled = cur; }
  const note = [];
  if (PROVA != null) note.push(`<p class="warn">Prova in locale: livello simulato ${fmt(PROVA)} cm (indirizzo «?marea=»).</p>`);
  if (m?.eff?.mose) note.push(`<p class="warn">MOSE ${Tide.moseState() === 'sollevata' ? 'sollevato' : 'in funzione o previsto'}: in mare sono previsti ${fmt(m.eff.mare)} cm, ma in città il livello dovrebbe restare sotto circa ${X.LIV_MOSE + 2} cm.</p>`);
  if (stato === 'oltre') note.push(`<p class="warn">Oltre +${dati.P.garantiti} cm alcuni tratti delle passerelle possono essere sommersi o inagibili.</p>`);
  if (pk && pk.cm >= 90 && m?.quando === 'ora' && (cm ?? 0) < pk.cm - 5) note.push(`<p>Colmo previsto ${fmt(pk.cm)} cm ${dayTag(pk.ts)}alle ${hm(pk.ts)}${pk.mose ? ' (con il MOSE)' : ''}: scegli «Colmo previsto» per vederlo.</p>`);
  if (errore && (vedi.all || vedi.pass)) note.push(`<p class="warn">Dati dell'acqua alta non disponibili (${esc(errore)}): riprova più tardi.</p>`);
  if (vedi.all && dati) note.push(`<p class="lv-legend"><span class="lv-grad" aria-hidden="true"></span>Solo calli e campi · più scuro = più acqua · ponti asciutti</p>`);
  if (vedi.all && dati?.Q.rilievo) note.push(`<p class="lv-legend"><span class="lv-ql" aria-hidden="true"></span>quota misurata<span class="lv-ql s" aria-hidden="true"></span>quota stimata</p>`);
  if (vedi.all && dati && acquaOn && lontano) note.push('<p>Avvicina la mappa per vedere le calli allagate.</p>');
  if (vedi.pass && dati && posateL.length) note.push(`<p class="lv-legend"><span class="lv-pl" aria-hidden="true"></span>passerella<span class="lv-pl i" aria-hidden="true"></span>tracciato indicativo</p>`);
  if (vedi.pass && dati && posateL.length) note.push('<p>Passerelle del piano comunale, mostrate dal livello di posa previsto: la posa effettiva e le chiusure non sono verificabili da qui. I ponti non si allagano.</p>');
  if (pref.all !== 'auto' || pref.pass !== 'auto') note.push('<p><button type="button" class="nlink" data-auto>Torna ad automatico</button></p>');
  $('lv-nota').innerHTML = note.join('');
  const R = dati?.Q.rilievo;
  $('lv-foot-q').innerHTML = R ? 'zone <b>potenzialmente</b> allagabili, non allagamento certo: quote <b>misurate</b> nella città storica e alla Giudecca (rilievo RAMSES, curve ogni 1 cm; <i>Fonte informativa: Insula spa</i>), <b>stimate</b> altrove'
    : 'zone <b>potenzialmente</b> allagabili da una <b>stima indicativa</b> delle quote delle calli';
}

// ---------------- menu ----------------
const POP = { mezzi: 'mezzi-btn', livelli: 'livelli-btn' };
export const isOpen = () => (!$('mezzi').hidden ? 'mezzi' : !$('livelli').hidden ? 'livelli' : null);
function position(id) {
  const card = $(id), w = $('wrap').getBoundingClientRect(), b = $(POP[id]).getBoundingClientRect(), g = 12, H = altezzaUtile(w);
  card.style.maxHeight = (H - 2 * g) + 'px';
  const h = card.offsetHeight;
  card.style.top = Math.max(g, Math.min(b.top - w.top - 8, H - h - g)) + 'px';
}
let seguiti = false;
function segui() { if (seguiti) return; seguiti = true; for (const id of Object.keys(POP)) seguiScheda($(id), () => position(id)); }
export function open(id) {
  if (!POP[id]) return;
  beforeOpenFn(); close(id === 'mezzi' ? 'livelli' : 'mezzi');
  const card = $(id); card.hidden = false; $(POP[id]).setAttribute('aria-expanded', 'true');
  if (id === 'livelli') applica();
  segui(); position(id); card.focus({ preventScroll: true });
}
// chiude un menu (o quello aperto); restituisce l'id del pulsante a cui tornare
export function close(id = isOpen()) {
  if (!id || $(id).hidden) return null;
  $(id).hidden = true; $(POP[id]).setAttribute('aria-expanded', 'false'); return POP[id];
}
function badgeMezzi() {
  const nav = document.querySelector('input[name=src][value=nav]').checked, aut = document.querySelector('input[name=src][value=aut]').checked, unk = $('unk-toggle').checked;
  const diverso = !nav || !aut || unk, b = $('mezzi-btn'), d = b.querySelector('.fbadge');
  d.hidden = !diverso;
  const lab = `Mezzi sulla mappa${diverso ? ': ' + [!nav ? 'navigazione nascosta' : '', !aut ? 'autobus nascosti' : '', unk ? 'mezzi senza linea visibili' : ''].filter(Boolean).join(', ') : ''}`;
  b.setAttribute('aria-label', lab); b.title = lab;
}

export function init({ map: m, beforeOpen, toast }) {
  map = m; beforeOpenFn = beforeOpen || beforeOpenFn; toastFn = toast || toastFn;
  for (const id of Object.keys(POP)) {
    $(POP[id]).onclick = () => ($(id).hidden ? open(id) : close(id));
    $(id + '-close').onclick = () => { const b = close(id); if (b) $(b).focus(); };
  }
  $('mezzi').addEventListener('change', badgeMezzi); badgeMezzi();
  $('lv-all').addEventListener('change', e => { pref.all = e.target.checked ? 'on' : 'off'; save(); applica(); });
  $('lv-pass').addEventListener('change', e => { pref.pass = e.target.checked ? 'on' : 'off'; save(); applica(); });
  document.querySelector('.lv-seg').addEventListener('click', e => { const b = e.target.closest('button[data-q]'); if (!b || b.disabled) return; pref.q = b.dataset.q; save(); applica(); });
  $('lv-nota').addEventListener('click', e => { if (e.target.closest('[data-auto]')) { pref.all = 'auto'; pref.pass = 'auto'; save(); applica(); } });
  window.addEventListener('tpl:tide', aggiorna);
  window.addEventListener('tpl:tide-cursor', aggiorna);
  window.addEventListener('resize', () => { const id = isOpen(); if (id) position(id); });
  setInterval(() => { if (!document.hidden) aggiorna(); }, ORA_MS);   // «adesso» si sposta: livello e passerelle seguono la marea
  document.addEventListener('visibilitychange', () => { if (!document.hidden) aggiorna(); });
  aggiorna();
}
