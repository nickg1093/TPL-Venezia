// AVVISI DI INFOMOBILITÀ (client): pulsante con contatore, finestra con l'elenco, e interrogazioni per fermata (usate da mappa e pannello fermata).
// I dati arrivano da /api/avvisi (sito ACTV + canale Telegram, già uniti e con linee/fermate collegate). Tutto il testo è mostrato come testo semplice (esc).
import { $, esc, icon, srcIcon, api, badge } from './util.js';

const btn = $('avvisi-btn'), card = $('avvisi'), body = $('avvisi-body'), cnt = $('avvisi-count');
let data = null, err = null, timer = null, highlight = null, onChange = () => {};
const byStop = new Map(), byLine = new Map();                      // fermata "src:id" / linea "src:NOME" -> [avviso, …]  (solo avvisi in corso)

const now = () => Date.now();
const isActive = a => a.from <= now() && a.to >= now();
// avviso che "pesa" su fermate e mezzi: in corso, non risolto, non generale (es. nuovi orari di tutta la rete)
const isWarn = a => isActive(a) && !a.resolved && !a.general;
const two = n => String(n).padStart(2, '0');
const hmOf = ms => { const d = new Date(ms); return `${d.getHours()}:${two(d.getMinutes())}`; };
const dayOf = ms => new Date(ms).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
const midnight = ms => { const d = new Date(ms); return d.getHours() === 0 && d.getMinutes() === 0; };
const endOfDay = ms => { const d = new Date(ms); return d.getHours() === 23 && d.getMinutes() === 59; };
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const fmt = ms => `${dayOf(ms)}, ${hmOf(ms)}`;
const safeUrl = u => (/^https:\/\/(actv\.avmspa\.it|avm\.avmspa\.it|t\.me|telegram\.me)\//.test(u) ? u : null);
const SRC = { actv: 'ACTV', telegram: 'Telegram', both: 'ACTV · Telegram', auto: 'Calcolato dal livello di marea' };

// periodo in forma breve e precisa: "ven 30 ott, 8:30–12:00", "ven 30 ott dalle 8:30 fino al termine", "dal sab 31 ott al dom 1 nov"
function validity(a) {
  if (a.source === 'auto') return 'In base alla marea';
  if (a.resolved) return `Risolto alle ${hmOf(a.published)}`;
  const up = a.updated ? ' · aggiornato' : '';
  if (!a.dated) return `Pubblicato ${fmt(a.published)}${up}`;
  const f = midnight(a.from) ? dayOf(a.from) : fmt(a.from), t = endOfDay(a.to) ? dayOf(a.to) : fmt(a.to);
  if (a.open) return `Dal ${f}${up}`;
  if (a.untilEnd) return `${midnight(a.from) ? dayOf(a.from) : `${dayOf(a.from)} dalle ${hmOf(a.from)}`} fino al termine${up}`;
  if (sameDay(a.from, a.to)) return midnight(a.from) && endOfDay(a.to) ? `${dayOf(a.from)}${up}` : `${dayOf(a.from)}, ${hmOf(a.from)}–${hmOf(a.to)}${up}`;
  return `Dal ${f} al ${t}${up}`;
}
const lineKey = (s, n) => `${s}:${String(n).toUpperCase()}`;
// da dove viene il livello: misura, previsione, avviso ufficiale (vale il più alto)
function waterSrc(w) {
  const p = [w.measured != null ? `misurato ora ${w.measured} cm` : null, w.forecast ? `previsto ${w.forecast.cm} cm alle ${hmOf(w.forecast.ts)}` : null,
    w.official != null ? `avviso ufficiale ${w.official} cm` : w.confirmed ? 'confermato da avviso ufficiale' : null].filter(Boolean);
  return p.length ? `<span class="av-wsrc muted">${esc(p.join(' · '))}</span>` : '';
}
function reindex() {
  byStop.clear(); byLine.clear();
  for (const a of data?.items || []) {
    if (!isWarn(a)) continue;
    for (const id of a.stops || []) (byStop.get(id) || byStop.set(id, []).get(id)).push(a);
    for (const l of a.lines || []) { const k = lineKey(l.s, l.n); (byLine.get(k) || byLine.set(k, []).get(k)).push(a); }
  }
}
const uniq = list => { const seen = new Set(); return list.filter(a => isWarn(a) && !seen.has(a.id) && seen.add(a.id)); };
// avvisi in corso che citano esplicitamente una delle fermate indicate
export const forStops = ids => uniq(ids.flatMap(id => byStop.get(id) || []));
// avvisi in corso su una delle linee indicate ([{ s: 'aut', n: '7E' }]): valgono in ogni fermata in cui la linea ferma e sul mezzo
export const forLines = list => uniq(list.flatMap(l => byLine.get(lineKey(l.s, l.n)) || []));
// triangolo (mappa, titolo della fermata, riga del passaggio): solo avvisi gravi o di attenzione, non quelli informativi
const isAlarm = a => isWarn(a) && a.severity !== 'info';
export const lineHasAlert = (s, n) => (byLine.get(lineKey(s, n)) || []).some(isAlarm);
export const hasAlert = id => (byStop.get(id) || []).some(isAlarm);
export const anyAlarm = list => list.some(isAlarm);
const sevIcon = a => icon(a.severity === 'info' ? 'info' : 'warn', 'sm');
const effTag = a => (a.effectLabel ? `<span class="av-eff" data-sev="${esc(a.severity || 'warning')}">${esc(a.effectLabel)}</span>` : '');
// avviso di acqua alta da aprire dal pannello della marea: prima quello ufficiale, poi quello automatico (in corso o in arrivo)
export const waterAlertId = () => { const l = (data?.items || []).filter(a => a.water && a.to >= now()); return (l.find(a => a.source !== 'auto') || l[0])?.id || null; };
// riga cliccabile per il pannello di una fermata: apre l'avviso nella finestra
// riga cliccabile (pannello fermata e pannello mezzo): apre l'avviso nella finestra. "only" = linee da citare (quelle della fermata o del mezzo)
export const rowHtml = (a, only = null) => {
  const ls = (a.lines || []).filter(l => !only || only.has(lineKey(l.s, l.n))).map(l => l.n);
  const ln = ls.length ? `${ls.length === 1 ? 'Linea' : 'Linee'} ${ls.slice(0, 4).join(', ')}${ls.length > 4 ? '…' : ''} · ` : '';
  return `<button type="button" class="alert-row" data-av="${esc(a.id)}" data-sev="${esc(a.severity || 'warning')}">${sevIcon(a)}<span>${effTag(a)}<b>${esc(a.title)}</b><small>${esc(ln + validity(a))} · tocca per leggere</small></span></button>`;
};
export const keyOf = lineKey;

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
    return `<article class="av${a.id === highlight ? ' hl' : ''}${a.resolved ? ' ok' : ''}" id="av-${esc(a.id)}"><div class="av-top"><span class="av-src">${a.resolved ? icon('check', 'sm') : ''}${esc(SRC[a.source] || '')}</span>${effTag(a)}<span class="av-when">${esc(validity(a))}</span></div>`
      + `<h3>${esc(a.title)}</h3>${a.text ? `<p>${esc(a.text)}</p>` : ''}`
      + (a.water ? `<div class="av-plan"><strong>Piano acqua alta ACTV per +${esc(a.water.level)} cm</strong>${waterSrc(a.water)}<ul>${(a.water.plan || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul><a href="${esc(a.water.url)}" target="_blank" rel="noopener noreferrer">Servizi di navigazione previsti</a> · verifica sempre l'avviso ufficiale.</div>` : '')
      + ((a.lines || []).length ? `<div class="av-lines"><span class="muted">Linee</span>${a.lines.map(l => badge(l.n, l.c, l.s)).join('')}</div>` : '')
      + ((a.stopNames || []).length ? `<div class="av-stops"><span class="muted">${a.stopNames.length === 1 ? 'Fermata' : 'Fermate'} ${icon('warn', 'sm')}</span>${a.stopNames.map(s => `<span class="av-stop">${srcIcon(s.s, 'sm')}${esc(s.n)}</span>`).join('')}</div>` : '')
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
