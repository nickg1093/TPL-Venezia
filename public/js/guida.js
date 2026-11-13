// GUIDA INTERATTIVA: schermo oscurato, il punto spiegato resta in luce, una scheda breve accanto.
//   · prima apertura dell'app: la mappa (GUIDA_MAPPA); prima fermata aperta: il pannello (GUIDA_PANNELLO);
//   · dopo un aggiornamento, chi l'ha già vista vede solo i passi nuovi (campo since, confrontato con la versione salvata) con la scheda «Novità»;
//   · tocco ovunque = avanti; «Indietro»; X = chiudi. Il tocco sul punto in luce NON lo attiva (nessuna azione per sbaglio);
//   · tastiera: frecce, Invio, Esc; il fuoco resta dentro la guida; testi letti dal lettore di schermo (dialog con titolo e descrizione);
//   · un passo il cui punto ora non c'è (es. nessuna corsa partita da poco) si salta; la luce segue il punto se si muove.
// Memoria sul telefono (localStorage «tpl.guida»): versione della guida vista e quali parti; nessun dato esce dal telefono.
import { esc, icon } from './util.js';

export const GUIDA_VER = 'v27';
const KEY = 'tpl.guida';

// Nei testi: html scritto qui (fisso), mai dati che arrivano da fuori.
// il mezzo più isolato nella parte alta della mappa: in luce si vede bene, senza altri simboli addosso
const lonely = () => {
  const all = [...document.querySelectorAll('.bus-marker')].map(e => ({ e, r: e.getBoundingClientRect() })).filter(o => o.r.width);
  const c = o => [o.r.left + o.r.width / 2, o.r.top + o.r.height / 2];
  let best = null, bd = -1;
  for (const o of all) {
    const [x, y] = c(o); if (y < 90 || y > innerHeight * 0.55 || x < 40 || x > innerWidth - 100) continue;
    let d = 1e9; for (const p of all) if (p !== o) { const [u, v] = c(p); d = Math.min(d, Math.hypot(u - x, v - y)); }
    if (d > bd) { bd = d; best = o.e; }
  }
  return best;
};
const q = s => () => document.querySelector(s);
const both = (a, b) => () => {                                       // due tasti vicini in un'unica luce
  const x = document.getElementById(a), y = document.getElementById(b);
  if (!x || !y || x.hidden || y.hidden) return null;
  return { isConnected: true, getBoundingClientRect: () => { const r = x.getBoundingClientRect(), s = y.getBoundingClientRect(); return { left: Math.min(r.left, s.left), top: Math.min(r.top, s.top), width: Math.max(r.right, s.right) - Math.min(r.left, s.left), height: Math.max(r.bottom, s.bottom) - Math.min(r.top, s.top) }; } };
};

const GUIDA_MAPPA = [
  { since: 'v23', icon: 'ship', title: 'Benvenuto!', html: 'Vaporetti, bus e tram di Venezia <b>in tempo reale</b>. In pochi passi ti mostro cosa puoi fare.<span class="tg-hint">Tocca ovunque per andare avanti.</span>', start: 'Iniziamo' },
  { since: 'v23', el: lonely, round: true, pad: 8, icon: 'live', title: 'Tocca un mezzo', html: 'Ogni simbolo è un mezzo che si muove adesso. Toccalo per vedere la sua corsa e le prossime fermate, e <b>seguirlo</b> sulla mappa.' },
  { since: 'v23', el: q('#search-toggle-btn'), round: true, icon: 'search', title: 'Cerca fermate e linee', html: 'Scrivi il nome di una fermata o il numero di una linea. Qui ritrovi anche i tuoi <b>preferiti</b>.' },
  { since: 'v23', el: q('#locate'), round: true, icon: 'locate', title: 'Fermate vicine a te', html: 'Mostra dove sei e le fermate più vicine. <b>La tua posizione resta sul telefono.</b>' },
  { since: 'v23', el: q('#controls .group'), icon: 'ship', title: 'Battelli e bus', html: 'Mostra o nascondi la navigazione e i bus/tram, anche separatamente.' },
  { since: 'v23', el: q('#plan-btn'), icon: 'route', title: 'Pianifica un percorso', html: 'Dimmi da dove a dove: ti propongo le soluzioni migliori, con cambi e tratti a piedi. Puoi <b>salvare</b> i percorsi che fai spesso.' },
  { since: 'v23', el: () => document.getElementById('avvisi-btn')?.closest('.group'), icon: 'warn', title: 'Avvisi e marea', html: 'Scioperi, deviazioni e fermate sospese; il livello della <b>marea</b> e i servizi in caso di acqua alta.' },
  { since: 'v24', el: q('#unk-btn'), round: true, icon: 'unknown', title: 'Mezzi senza linea', html: 'I mezzi che il feed ACTV non associa a nessuna linea (simbolo <b>?</b>) sono nascosti: con questo tasto li mostri, in grigio.' },
  { since: 'v24', el: q('#favs-btn'), round: true, icon: 'star', title: 'I tuoi preferiti', html: 'Fermate e percorsi salvati, a portata di tocco. Puoi riordinarli, dare un nome ai percorsi e salvarne una <b>copia</b>.' },
  { since: 'v23', el: q('#bottom-bar .seg'), icon: 'clock', title: 'Tempo reale o Programmato', html: '<b>Tempo reale</b>: dove sono i mezzi adesso. <b>Programmato</b>: gli orari di un altro giorno o di un\'altra ora.' },
  { since: 'v23', el: q('#info-btn'), round: true, icon: 'info', title: 'La guida è sempre qui', html: 'Nelle <b>Informazioni</b> puoi rivedere questa guida quando vuoi.', end: 'Fine' },
];
const GUIDA_PANNELLO = [
  { since: 'v23', el: q('#plist .dep.d3 .dm'), pad: 4, icon: 'next', title: 'Ogni partenza su tre righe', html: '<b>Destinazione</b>, poi le <b>fermate successive</b> (scorrono), poi <b>pontile · stato · mezzo</b>. Tocca la riga per seguire la corsa.', start: 'Avanti' },
  { since: 'v23', el: q('#plist .dep.d3 .dt3'), pad: 4, icon: 'clock', title: 'L\'orario giusto', html: 'Se il mezzo è in ritardo o in anticipo vedi l\'orario <b>aggiornato</b>; sopra, barrato, quello previsto.' },
  { since: 'v23', el: q('#plist .dep.d3 .bsrc'), round: true, pad: 5, icon: 'live', title: 'Tracciato o da orario', html: `<span class="k">${icon('live', 'sm')}</span> mezzo rilevato in tempo reale · <span class="k">${icon('clock', 'sm')}</span> corsa non rilevata: vale l'orario programmato.` },
  { since: 'v23', el: q('#plist .pastsw'), icon: 'clock', title: 'Partiti da poco', html: 'Le corse appena partite restano qui 3 minuti: tocca per aprirle o chiuderle.' },
  { since: 'v23', el: q('#plist .vsw'), round: true, icon: 'route', title: 'Orario o per linea', html: '<b>Per linea</b> raggruppa le corse uguali: tocca un gruppo per vedere tutti i suoi passaggi.' },
  { since: 'v23', el: q('#plist .dep-bell'), round: true, icon: 'bell', title: 'Avvisami', html: 'Tocca la campanella: ti avviso <b>prima che arrivi</b>, anche ad app chiusa.' },
  { since: 'v23', el: both('pshare', 'pfav'), round: true, icon: 'star', title: 'Salva e condividi', html: 'La <b>stella</b> salva la fermata tra i preferiti; con l\'altro tasto mandi il <b>link</b> a chi vuoi.', end: 'Ho capito' },
];
// novità senza un punto nell'app (solo a chi aveva già visto la guida di una versione precedente)
const NOVITA_EXTRA = [
  { since: 'v24', icon: 'back', title: 'Il tasto «indietro» funziona', html: 'Il tasto o il gesto <b>indietro</b> del telefono chiude la finestra aperta o torna al pannello precedente. I comandi dei pannelli sono nella <b>linguetta</b> sul bordo, e il nome della fermata resta su una riga.' },
  { since: 'v27', icon: 'tide', title: 'MOSE nella marea', html: 'Nel pannello della marea un semaforo dice se il MOSE è attivo; tocca «Barriere» per vedere le quattro barriere, una per una: verde in recesso, giallo con sollevamento programmato, giallo lampeggiante in movimento, rosso sollevata. Fonte: Autorità per la Laguna di Venezia.' },
  { since: 'v27', icon: 'route', title: 'Il pianificatore si fa da parte', html: 'Scelti partenza e arrivo, il pianificatore si riduce a una riga: la mappa mostra tutto il percorso, mezzi e tratti a piedi. Toccando una soluzione il pannello si abbassa ancora; «Modifica» o «Tutte le soluzioni» per tornare indietro.' },
  { since: 'v27', icon: 'route', title: 'Percorsi più semplici', html: 'Le preferenze sono tre, come nelle app di trasporto: Migliore, Meno cambi, Meno a piedi. Niente più cambi per guadagnare pochi minuti; con «Arrivo» le proposte arrivano vicino all\'orario scelto.' },
  { since: 'v26', icon: 'route', title: 'Percorso sempre in vista', html: 'Scegliendo una soluzione la mappa inquadra tutto il tragitto, tratti a piedi compresi, nella parte libera dello schermo; se sposti la mappa, gli aggiornamenti non la ricentrano più.' },
  { since: 'v26', icon: 'tide', title: 'Marea senza buchi', html: 'Il grafico della marea mostra le ultime ore anche subito dopo un aggiornamento del servizio.' },
  { since: 'v25', icon: 'walk', title: 'A piedi lungo le strade', html: 'Nel percorso i tratti a piedi seguono calli, ponti e marciapiedi, fino a 30 minuti di cammino, e ne vedi la lunghezza. Il calcolo lo fa il tuo telefono: la posizione non esce dal dispositivo.' },
  { since: 'v25', icon: 'db', title: 'Più veloce ad aprirsi', html: 'Fermate, linee e strade restano salvate sul telefono e si riscaricano solo quando ACTV pubblica orari nuovi.' },
  { since: 'v24', icon: 'route', title: 'Percorsi in qualsiasi giorno', html: 'Il pianificatore usa gli orari del giorno che scegli (gli stessi di <b>Programmato</b>) e, mentre lo usi, sulla mappa restano solo i mezzi del tuo percorso.' }
];
const NOVITA_INTRO = { tag: 'Novità', icon: 'info', title: 'Cosa c\'è di nuovo', html: 'L\'app è stata aggiornata: ti mostro in breve le novità.', start: 'Vediamo' };

// ---------------------------------------------------------------------------------------------------------------------
// memoria: { v: versione vista, mappa: bool, pannello: bool }
const vnum = v => String(v || 'v0').replace(/^v/, '').split('.').map(n => +n || 0);
const newer = (a, b) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
function read() {
  try { const o = JSON.parse(localStorage.getItem(KEY) || 'null'); if (o && typeof o === 'object' && /^v\d{1,3}(\.\d{1,3}){0,2}$/.test(o.v)) return { v: o.v, mappa: o.mappa === true, pannello: o.pannello === true }; } catch { /* memoria non disponibile */ }
  return null;
}
function write(part) {
  const r = read(), cur = r && r.v === GUIDA_VER ? r : { v: GUIDA_VER, mappa: false, pannello: false };
  cur[part] = true; try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* facoltativo */ }
}
// passi da mostrare per una parte: tutti la prima volta; dopo un aggiornamento solo quelli nuovi, con l'etichetta «Novità»
function stepsFor(part) {
  const all = part === 'mappa' ? GUIDA_MAPPA : GUIDA_PANNELLO, r = read();
  if (!r) return all;                                                           // prima volta in assoluto
  if (r.v === GUIDA_VER) return r[part] ? [] : all;                             // stessa versione: solo se quella parte non è stata vista
  const nuovi = all.filter(s => newer(s.since, r.v)).map(s => ({ ...s, tag: 'Novità', start: undefined, end: undefined }));
  if (part === 'mappa') { const extra = NOVITA_EXTRA.filter(s => newer(s.since, r.v)); if (nuovi.length || extra.length) return [NOVITA_INTRO, ...nuovi, ...extra.map(s => ({ ...s, tag: 'Novità' }))]; return []; }
  return nuovi;
}

// ---------------------------------------------------------------------------------------------------------------------
let root = null, steps = [], k = 0, done = null, lastFocus = null, cur = null, follow = null;
function resolve(st) { const el = typeof st.el === 'function' ? st.el() : null; if (!el) return null; const r = el.getBoundingClientRect(); return r.width || r.height ? el : null; }
function rectOf(st) {
  if (!st.el) return null;
  if (!cur || !cur.isConnected) cur = resolve(st);                               // l'elenco si ridisegna ogni pochi secondi: si ritrova il punto
  if (!cur) return null;
  const r = cur.getBoundingClientRect(), p = st.pad ?? 6;
  if (!r.width && !r.height) return null;
  return { x: r.left - p, y: r.top - p, w: r.width + 2 * p, h: r.height + 2 * p };
}
function place() {
  if (!root) return;
  const st = steps[k], hole = root.querySelector('.tg-hole'), card = root.querySelector('.tg-card');
  const r = rectOf(st), W = innerWidth, H = innerHeight, M = 16;
  if (r) { Object.assign(hole.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', borderRadius: st.round ? '999px' : '16px' }); hole.classList.remove('none'); }
  else { Object.assign(hole.style, { left: W / 2 + 'px', top: H / 2 + 'px', width: '0px', height: '0px' }); hole.classList.add('none'); }
  const cw = Math.min(360, W - 2 * M); card.style.width = cw + 'px';            // su schermi stretti: larga quanto lo schermo, margini 16 px
  const ch = card.offsetHeight;
  let left, top, arrow = '';
  if (!r) { left = (W - cw) / 2; top = Math.max(M, (H - ch) / 2); }
  else {
    left = Math.min(Math.max(M, r.x + r.w / 2 - cw / 2), W - cw - M);
    if (r.y + r.h + 14 + ch <= H - M) { top = r.y + r.h + 14; arrow = 'up'; }  // sotto il punto se c'è posto, altrimenti sopra
    else if (r.y - 14 - ch >= M) { top = r.y - 14 - ch; arrow = 'down'; }
    else top = Math.max(M, H - ch - M);
    card.style.setProperty('--ax', Math.min(Math.max(22, r.x + r.w / 2 - left), cw - 22) + 'px');
  }
  card.dataset.arrow = arrow;
  Object.assign(card.style, { left: left + 'px', top: top + 'px' });
}
function render() {
  const st = steps[k], n = steps.length, last = k === n - 1;
  cur = st.el ? resolve(st) : null;
  if (cur && cur.scrollIntoView && cur.closest?.('#plist')) {                   // punto nell'elenco ma fuori vista: lo si porta in vista
    const r = cur.getBoundingClientRect(), box = cur.closest('#plist').getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) cur.scrollIntoView({ block: 'center' });
  }
  root.querySelector('.tg-card').innerHTML =
    `<button type="button" class="tg-x" data-tg="skip" aria-label="Chiudi la guida" title="Chiudi la guida">${icon('close')}</button>`
    + (st.tag ? `<span class="tg-tag">${esc(st.tag)}</span>` : '')
    + `<h2 id="tg-t">${st.icon ? icon(st.icon) : ''}${esc(st.title)}</h2>`
    + `<p id="tg-d">${st.html}</p>`
    + `<div class="tg-foot"><span class="tg-dots" aria-hidden="true">${steps.map((_, i) => `<i class="${i === k ? 'on' : i < k ? 'past' : ''}"></i>`).join('')}</span>`
    + `<span class="tg-count">Passo ${k + 1} di ${n}</span>`
    + (k ? '<button type="button" class="tg-btn ghost" data-tg="prev">Indietro</button>' : '')
    + `<button type="button" class="tg-btn" data-tg="next">${esc(last ? (st.end || 'Fine') : (k ? 'Avanti' : (st.start || 'Avanti')))}</button></div>`;
  place();
  root.querySelector('[data-tg="next"]').focus({ preventScroll: true });
}
function go(d) { const j = k + d; if (j < 0) return; if (j >= steps.length) return close(); k = j; render(); }
function close() {
  if (!root) return;
  const r = root; root = null; cur = null;
  r.classList.remove('in'); setTimeout(() => r.remove(), 220);
  clearInterval(follow); removeEventListener('resize', place); removeEventListener('keydown', onKey, true);
  if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
  const f = done; done = null; f?.();
}
function onKey(e) {
  if (!root) return;
  const kk = e.key;
  if (kk === 'Escape') close();
  else if (kk === 'ArrowRight' || kk === 'PageDown') go(1);
  else if (kk === 'ArrowLeft' || kk === 'PageUp') go(-1);
  else if (kk === 'Tab') { const f = [...root.querySelectorAll('button')]; const i = f.indexOf(document.activeElement); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus(); }
  else if (kk === 'Enter' || kk === ' ') { if (!document.activeElement?.closest?.('.tg')) go(1); else return; }   // Invio sui pulsanti: il loro clic
  else return;
  e.preventDefault(); e.stopPropagation();                                        // l'app sotto non riceve i tasti della guida
}
function show(list, onDone) {
  if (root) return false;
  steps = list.filter(s => !s.el || resolve(s));                                 // passi senza il loro punto adesso: saltati
  if (!steps.length) { onDone?.(); return false; }
  k = 0; done = onDone; lastFocus = document.activeElement;
  root = document.createElement('div');
  root.className = 'tg'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'tg-t'); root.setAttribute('aria-describedby', 'tg-d');
  root.innerHTML = '<div class="tg-hole none"></div><div class="tg-card" aria-live="polite"></div>';
  root.addEventListener('click', e => {
    e.stopPropagation();
    const b = e.target.closest('[data-tg]');
    if (b) return b.dataset.tg === 'skip' ? close() : go(b.dataset.tg === 'prev' ? -1 : 1);
    if (!e.target.closest('.tg-card')) go(1);                                     // tocco sullo schermo oscurato o sul punto in luce: avanti
  });
  for (const t of ['pointerdown', 'touchstart', 'wheel']) root.addEventListener(t, e => e.stopPropagation(), { passive: true });
  document.body.appendChild(root);
  addEventListener('resize', place); addEventListener('keydown', onKey, true);
  follow = setInterval(place, 400);                                              // la luce segue il punto (mezzo in movimento, elenco ridisegnato)
  requestAnimationFrame(() => root?.classList.add('in'));
  render();
  return true;
}

export const active = () => !!root;
// all'avvio (mappa pronta, nessun pannello aperto): guida della mappa o novità
export function boot() { const s = stepsFor('mappa'); if (s.length) show(s, () => write('mappa')); }
// pannello di una fermata appena disegnato (tempo reale, con partenze): guida del pannello una volta
export function panelReady() { if (root) return; const s = stepsFor('pannello'); if (s.length) show(s, () => write('pannello')); }
// «Rivedi la guida» dalle Informazioni: tutta la guida della mappa; quella del pannello alla prossima fermata aperta
export function restart() {
  try { localStorage.setItem(KEY, JSON.stringify({ v: GUIDA_VER, mappa: false, pannello: false })); } catch { /* facoltativo */ }
  show(GUIDA_MAPPA, () => write('mappa'));
}
