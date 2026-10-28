// AVVISI DI INFOMOBILITÀ (client): pulsante con contatore, finestra con l'elenco, e interrogazioni per fermata (usate da mappa e pannello fermata).
// I dati arrivano da /api/avvisi (sito ACTV + canale Telegram, già uniti e con linee/fermate collegate). Tutto il testo è mostrato come testo semplice (esc).
import { $, esc, icon, api, badge } from './util.js';

const btn = $('avvisi-btn'), card = $('avvisi'), body = $('avvisi-body'), cnt = $('avvisi-count');
let data = null, err = null, timer = null, highlight = null, onChange = () => {};
const byStop = new Map();                                            // id fermata "src:id" -> [avviso, …]  (solo avvisi in corso)

const now = () => Date.now();
const isActive = a => a.from <= now() && a.to >= now();
const fmt = ms => new Date(ms).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const safeUrl = u => (/^https:\/\/(actv\.avmspa\.it|avm\.avmspa\.it|t\.me|telegram\.me)\//.test(u) ? u : null);
const SRC = { actv: 'ACTV', telegram: 'Telegram', both: 'ACTV · Telegram' };

function validity(a) {
  if (!a.dated) return `Pubblicato ${fmt(a.published)}`;
  return a.open ? `Dal ${fmt(a.from)}` : `Dal ${fmt(a.from)} al ${fmt(a.to)}`;
}
function reindex() {
  byStop.clear();
  for (const a of data?.items || []) if (isActive(a)) for (const id of a.stops || []) (byStop.get(id) || byStop.set(id, []).get(id)).push(a);
}
// avvisi in corso che riguardano almeno una delle fermate indicate (senza doppioni)
export function forStops(ids) {
  const seen = new Set(), out = [];
  for (const id of ids) for (const a of byStop.get(id) || []) if (isActive(a) && !seen.has(a.id)) { seen.add(a.id); out.push(a); }
  return out;
}
export const hasAlert = id => (byStop.get(id) || []).some(isActive);
// riga cliccabile per il pannello di una fermata: apre l'avviso nella finestra
export const rowHtml = a => `<button type="button" class="alert-row" data-av="${esc(a.id)}">${icon('warn', 'sm')}<span><b>${esc(a.title)}</b><small>${esc(a.dated && !a.open ? 'fino al ' + fmt(a.to) : validity(a))} · tocca per leggere</small></span></button>`;

function render() {
  const items = data?.items || [], act = items.filter(isActive), up = items.filter(a => !isActive(a));
  cnt.textContent = act.length ? String(act.length) : ''; cnt.hidden = !act.length;
  const label = act.length ? `Avvisi di servizio: ${act.length} in corso` : 'Avvisi di servizio: nessuno in corso';
  btn.setAttribute('aria-label', label); btn.title = label;
  if (card.hidden) return;
  if (!data) { body.innerHTML = err ? `<p class="av-note">Avvisi non disponibili: ${esc(err)}</p>` : 'Caricamento…'; return; }
  const item = a => {
    const links = [safeUrl(a.url) && `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${a.source === 'telegram' ? 'Apri il messaggio' : 'Leggi l\'avviso completo'}</a>`,
      a.tgUrl && a.tgUrl !== a.url && safeUrl(a.tgUrl) && `<a href="${esc(a.tgUrl)}" target="_blank" rel="noopener noreferrer">Messaggio Telegram</a>`].filter(Boolean).join('');
    return `<article class="av${a.id === highlight ? ' hl' : ''}" id="av-${esc(a.id)}"><div class="av-top"><span class="av-src">${esc(SRC[a.source] || '')}</span><span class="av-when">${esc(validity(a))}</span></div>`
      + `<h3>${esc(a.title)}</h3>${a.text ? `<p>${esc(a.text)}</p>` : ''}`
      + ((a.lines || []).length ? `<div class="av-lines"><span class="muted">Linee</span>${a.lines.map(l => badge(l.n, l.c, l.s)).join('')}</div>` : '')
      + ((a.stops || []).length ? `<div class="muted">${a.stops.length} ${a.stops.length === 1 ? 'fermata interessata' : 'fermate interessate'}: segnalate con ${icon('warn', 'sm')} sulla mappa e nel loro pannello</div>` : '')
      + (links ? `<div class="av-links">${links}</div>` : '') + '</article>';
  };
  body.innerHTML = (data.stale ? '<p class="av-note" role="status">Gli avvisi non si aggiornano da un po\': potrebbero non essere completi.</p>' : '')
    + (act.length ? `<h2 class="av-h">In corso</h2>${act.map(item).join('')}` : '<p class="muted pad">Nessun avviso in corso.</p>')
    + (up.length ? `<h2 class="av-h">In arrivo</h2>${up.map(item).join('')}` : '')
    + '<p class="tide-foot">Fonti: notizie del sito ACTV e canale Telegram ufficiale «AVM/Actv Venezia». Raccolta automatica: per le informazioni ufficiali fa fede il sito ACTV.</p>';
  if (highlight) { const el = body.querySelector('.hl'); if (el) el.scrollIntoView({ block: 'start' }); }
}
async function load() {
  try { const d = await api('/api/avvisi'); if (d.error) throw new Error(d.error); data = d; err = null; reindex(); }
  catch (e) { if (!e.busy) err = e.message; }
  render(); onChange();
}
function position() {                                                // allineata al pulsante, come la scheda della marea
  const w = $('wrap').getBoundingClientRect(), b = btn.getBoundingClientRect(), h = card.offsetHeight, g = 12;
  card.style.top = Math.max(g, Math.min(b.top - w.top - 8, w.height - h - g)) + 'px';
}
export const isOpen = () => !card.hidden;
export function open(id = null, beforeOpen) {
  if (beforeOpen) beforeOpen();
  highlight = id; card.hidden = false; btn.setAttribute('aria-expanded', 'true'); render(); position(); card.focus({ preventScroll: true }); load();
}
export function close() { if (card.hidden) return; card.hidden = true; highlight = null; btn.setAttribute('aria-expanded', 'false'); }
let before = () => {};
export function init(beforeOpen, changed) {
  before = beforeOpen || before; onChange = changed || onChange;
  btn.onclick = () => (card.hidden ? open(null, before) : close());
  $('avvisi-close').onclick = () => { close(); btn.focus(); };
  window.addEventListener('resize', () => { if (!card.hidden) position(); });
  load(); timer = setInterval(() => { if (!document.hidden) load(); }, 120000);
}
export const openAlert = id => open(id, before);
