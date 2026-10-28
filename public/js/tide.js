// FINESTRA MAREA: livello attuale, categoria, tendenza, prossimi estremi e grafico delle ultime ore (dati CPSM Venezia tramite /api/tide).
import { $, esc, icon, hm } from './util.js';

const btn = $('tide-btn'), card = $('tide'), body = $('tide-body');
let data = null, err = null, timer = null;
const fmtCm = cm => `${cm > 0 ? '+' : cm < 0 ? '−' : ''}${Math.abs(cm)}`;
const dayTag = ms => { const a = new Date(ms), b = new Date(); return a.toDateString() === b.toDateString() ? '' : a.toLocaleDateString('it-IT', { weekday: 'short' }) + ' '; };
const safeUrl = u => (/^https:\/\//.test(u) ? u : '#');

function spark(h) {   // andamento delle ultime ore, con descrizione testuale per chi non vede il grafico
  if (!h || h.length < 3) return '';
  const W = 300, H = 64, P = 7, x0 = h[0][0], x1 = h[h.length - 1][0], ys = h.map(p => p[1]), lo = Math.min(...ys), span = Math.max(Math.max(...ys) - lo, 10);
  const X = t => P + (W - 2 * P) * (t - x0) / Math.max(1, x1 - x0), Y = v => H - P - (H - 2 * P) * (v - lo) / span;
  const d = h.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(''), mins = Math.round((x1 - x0) / 60000), last = h[h.length - 1];
  return `<svg class="tide-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Andamento delle ultime ${mins >= 90 ? Math.round(mins / 60) + ' ore' : mins + ' minuti'}: da ${fmtCm(h[0][1])} a ${fmtCm(last[1])} centimetri"><path d="${d}"/><circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="5"/></svg>`;
}
function render() {
  const d = data;
  if (!d) { body.innerHTML = err ? `<p class="tide-note">Dati di marea non disponibili: ${esc(err)}</p>` : 'Caricamento…'; return; }
  const t = d.trend;
  const tr = !t ? { icon: 'steady', txt: 'Tendenza in calcolo…' }
    : t.dir === 'up' ? { icon: 'up', txt: `In crescita${t.rate != null ? ` · +${Math.abs(t.rate)} cm/h` : ''}` }
    : t.dir === 'down' ? { icon: 'down', txt: `In calo${t.rate != null ? ` · −${Math.abs(t.rate)} cm/h` : ''}` }
    : { icon: 'steady', txt: 'Stazionaria' };
  const next = (d.next || []).map(n => `<li><b>${n.type === 'max' ? 'Alta' : 'Bassa'}</b><span class="v">${fmtCm(n.cm)} cm · ${dayTag(n.ts)}${hm(n.ts)}</span></li>`).join('');
  body.innerHTML = `<div class="tide-level"><span class="num">${fmtCm(d.cm)}</span><span class="unit">cm</span></div>`
    + `<div class="tide-cat" data-cat="${esc(d.category.key)}">${esc(d.category.label)}</div>`
    + `<div class="tide-trend">${icon(tr.icon)}<span>${tr.txt}${t && t.basis === 'previsione' ? ' <span class="muted">(da previsione)</span>' : ''}</span></div>`
    + (d.stale ? `<p class="tide-note" role="status">Ultimo dato di ${d.ageMin} minuti fa: potrebbe non essere aggiornato.</p>` : '')
    + (next ? `<ul class="tide-next" aria-label="Prossime alte e basse maree previste">${next}</ul>` : '')
    + spark(d.history)
    + `<p class="tide-foot">${esc(d.station)} · rilevato alle ${hm(d.ts)}. Livello sullo zero mareografico di Punta della Salute; dati grezzi, non validati.<br>Fonte (licenza ${esc(d.source.license)}):<a href="${esc(safeUrl(d.source.url))}" target="_blank" rel="noopener noreferrer">${esc(d.source.name)}</a></p>`;
  btn.querySelector('.dotc').dataset.cat = d.category.key;
  const label = `Marea a Venezia: ${fmtCm(d.cm)} cm, ${d.category.label.toLowerCase()}${t ? ', ' + tr.txt.split(' · ')[0].toLowerCase() : ''}`;
  btn.setAttribute('aria-label', label); btn.title = label;
}
async function load() {
  try { const d = await (await fetch('/api/tide', { cache: 'no-store' })).json(); if (d.error) throw new Error(d.error); data = d; err = null; }
  catch (e) { err = e.message; }
  render(); if (!card.hidden) position();
}
function position() {   // la scheda si allinea al suo pulsante, senza uscire dalla mappa
  const w = $('wrap').getBoundingClientRect(), b = btn.getBoundingClientRect(), h = card.offsetHeight, g = 12;
  card.style.top = Math.max(g, Math.min(b.top - w.top - 8, w.height - h - g)) + 'px';
}
export const isOpen = () => !card.hidden;
export function open(beforeOpen) {
  if (beforeOpen) beforeOpen();
  card.hidden = false; btn.setAttribute('aria-expanded', 'true'); render(); position(); card.focus({ preventScroll: true });
  load(); clearInterval(timer); timer = setInterval(load, 60000);
}
export function close() { if (card.hidden) return; card.hidden = true; btn.setAttribute('aria-expanded', 'false'); clearInterval(timer); }
export function init(beforeOpen) {
  btn.onclick = () => (card.hidden ? open(beforeOpen) : close());
  $('tide-close').onclick = () => { close(); btn.focus(); };
  window.addEventListener('resize', () => { if (!card.hidden) position(); });
  load(); setInterval(() => { if (!document.hidden && card.hidden) load(); }, 300000);   // aggiorna anche il punto colorato sul pulsante
}
