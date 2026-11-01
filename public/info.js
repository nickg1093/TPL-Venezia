// PAGINA INFORMAZIONI (bottone «i», a tutto schermo): note legali, informativa privacy, permessi, sicurezza, fonti e licenze, avvisi di arrivo attivi.
// Il testo è nella pagina (index.html); qui: apertura/chiusura (anche col tasto «indietro»), indice, avvisi attivi, titolare e contatti.
import { $, esc, icon, api } from './util.js';
import * as Notify from './notify.js';

const btn = $('info-btn'), card = $('info'), list = $('info-watches'), wbtn = $('watch-btn'), wcount = $('watch-count');
let before = () => {};
export const isOpen = () => !card.hidden;
// pagina a tutto schermo: il tasto «indietro» del telefono la chiude (voce nella cronologia)
let pushed = false;
// avvisi di arrivo attivi su questo dispositivo, con la possibilità di disattivarli
// campanella sopra la «i»: visibile solo con almeno un avviso attivo, con il numero; apre la lista (qui sotto, in cima alla pagina)
export function updateWatchButton() {
  const n = Notify.all().length;
  wbtn.hidden = !n; wcount.textContent = n > 9 ? '9+' : String(n);
  const lab = n === 1 ? '1 avviso di arrivo attivo: apri la lista' : `${n} avvisi di arrivo attivi: apri la lista`;
  wbtn.setAttribute('aria-label', lab); wbtn.title = lab;
}
export function renderWatches() {
  updateWatchButton();
  const ws = Notify.all();
  list.innerHTML = ws.length ? `<h3>${icon('bell', 'sm')} Avvisi di arrivo attivi</h3>` + ws.map(w =>
    `<div class="iw"><span><b>Linea ${esc(w.line || '')}</b>${w.headsign ? ' → ' + esc(w.headsign) : ''}<br><small class="muted">${esc(w.stopName || '')} · ${w.lead} min prima</small></span>`
    + `<button type="button" class="nlink" data-wid="${esc(w.id)}">Disattiva</button></div>`).join('') : '';
}
list.addEventListener('click', async e => {
  const b = e.target.closest('[data-wid]'); if (!b) return;
  const w = Notify.all().find(x => x.id === b.dataset.wid); if (w) await Notify.stopWatch(w);
  renderWatches();
});
export function open() {
  before(); card.hidden = false; btn.setAttribute('aria-expanded', 'true'); renderWatches();
  card.style.setProperty('--fp-h', card.querySelector('.fp-h').offsetHeight + 'px');   // l'indice resta agganciato sotto l'intestazione
  card.scrollTop = 0; card.focus({ preventScroll: true });
  try { history.pushState({ info: 1 }, '', '#informazioni'); pushed = true; } catch { pushed = false; }
}
export function close(fromHistory = false) {
  if (card.hidden) return; card.hidden = true; btn.setAttribute('aria-expanded', 'false');
  if (pushed && !fromHistory) { pushed = false; try { history.back(); } catch { /* ignora */ } } else pushed = false;
}
export function init(beforeOpen) {
  before = beforeOpen || before;
  btn.onclick = () => (card.hidden ? open() : close());
  // campanella: apre Informazioni direttamente sulla lista degli avvisi (subito sotto l'intestazione fissa), con il fuoco sul suo titolo
  wbtn.onclick = () => {
    if (card.hidden) open();
    const top = list.getBoundingClientRect().top - card.getBoundingClientRect().top + card.scrollTop - card.querySelector('.fp-h').offsetHeight - 12;
    card.scrollTop = Math.max(0, top);
    const h = list.querySelector('h3'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  };
  updateWatchButton();
  $('info-close').onclick = () => { close(); btn.focus(); };
  window.addEventListener('popstate', () => { if (!card.hidden) close(true); });
  // indice della pagina: scorrimento alla sezione senza toccare l'indirizzo (la voce #informazioni serve al tasto «indietro»)
  card.querySelector('.ip-toc').addEventListener('click', e => {
    const b = e.target.closest('[data-go]'); if (!b) return;
    const t = $(b.dataset.go); if (!t) return;
    t.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    t.querySelector('h3')?.setAttribute('tabindex', '-1'); t.querySelector('h3')?.focus({ preventScroll: true });
  });
  // indice: evidenzia la sezione che si sta leggendo
  const tocBtns = [...card.querySelectorAll('.ip-toc [data-go]')];
  if ('IntersectionObserver' in window) {
    const seen = new Map();
    const io = new IntersectionObserver(es => {
      for (const e of es) seen.set(e.target.id, e.isIntersecting);
      const cur = tocBtns.find(b => seen.get(b.dataset.go));
      for (const b of tocBtns) { if (b === cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); }
      if (cur) { const t = cur.parentElement; t.scrollLeft = cur.offsetLeft - (t.clientWidth - cur.offsetWidth) / 2; }   // solo in orizzontale
    }, { root: card, rootMargin: '-35% 0px -60% 0px' });
    for (const b of tocBtns) { const s = $(b.dataset.go); if (s) io.observe(s); }
  }
  // contatto del titolare (variabile APP_CONTACT sul server; nessun nome mostrato): un indirizzo e-mail diventa un collegamento
  const contactNode = v => {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { const a = document.createElement('a'); a.href = 'mailto:' + v; a.textContent = v; return a; }
    if (/^https:\/\//.test(v)) { const a = document.createElement('a'); a.href = v; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = v.replace(/^https:\/\//, ''); return a; }
    return document.createTextNode(v);
  };
  api('/api/about').then(d => {
    if (d?.contact) {
      $('ip-owner-contact').replaceChildren(contactNode(d.contact)); $('ip-owner').hidden = false;
      $('info-contact').replaceChildren(contactNode(d.contact)); $('info-contact-row').hidden = false;
    }
    $('info-version').textContent = `Versione ${d?.version || ''}`;
  }).catch(() => {});
  // attribuzione della mappa: visibile all'apertura, poi si riduce dopo 5 s o alla prima interazione (crediti completi qui)
  const at = $('osm-attr'), hide = () => at.classList.add('off');
  setTimeout(hide, 5000);
  return hide;
}
