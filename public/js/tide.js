// FINESTRA MAREA: livello attuale, categoria, tendenza, prossimi estremi e grafico delle ultime ore (dati CPSM Venezia tramite /api/tide).
import { $, esc, icon, hm } from './util.js';

const btn = $('tide-btn'), card = $('tide'), body = $('tide-body');
let data = null, err = null, timer = null;
const fmtCm = cm => `${cm > 0 ? '+' : cm < 0 ? '−' : ''}${Math.abs(cm)}`;
const dayTag = ms => { const a = new Date(ms), b = new Date(); return a.toDateString() === b.toDateString() ? '' : a.toLocaleDateString('it-IT', { weekday: 'short' }) + ' '; };
const safeUrl = u => (/^https:\/\//.test(u) ? u : '#');

// ---- GRAFICO: 6 ore osservate + 6 ore previste, con cursore mobile (trascinando sul grafico oppure con il cursore sotto) ----
const CH = { W: 300, H: 200, L: 42, R: 10, T: 14, B: 28 };   // W si adatta alla larghezza della scheda: il testo del grafico resta della grandezza prevista su ogni schermo
let cursorT = null;                                           // istante scelto (null = adesso); resta anche se i dati si aggiornano
const lerp = (pts, t) => {                                    // valore interpolato su una serie [[t, cm], …] ordinata; null fuori dalla serie
  if (!pts.length || t < pts[0][0] || t > pts[pts.length - 1][0]) return null;
  for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const a = pts[i - 1], b = pts[i], f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * f; }
  return pts[pts.length - 1][1];
};
function valueAt(c, t) {                                      // { cm, kind: 'osservato' | 'previsto' } oppure null
  if (t <= c.now) { const v = lerp(c.observed || [], t); return v == null ? null : { cm: Math.round(v), kind: 'osservato' }; }
  const v = lerp(c.forecast || [], t); return v == null ? null : { cm: Math.round(v), kind: 'previsto' };
}
function chartHtml(c) {
  CH.W = Math.max(200, Math.min(520, Math.round((card.clientWidth || 340) - 40)));
  const obs = c.observed || [], fc = c.forecast || [], ext = c.extremes || [], { W, H, L, R, T, B } = CH;
  const vals = [...obs, ...fc].map(p => p[1]).concat(ext.map(e => e.cm));
  if (vals.length < 2) return '';
  let lo = Math.min(...vals), hi = Math.max(...vals); const step = hi - lo > 120 ? 50 : hi - lo > 50 ? 20 : 10;
  lo = Math.floor((lo - 5) / step) * step; hi = Math.ceil((hi + 5) / step) * step;
  const X = t => L + (W - L - R) * (t - c.from) / (c.to - c.from), Y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join('');
  let grid = '', xt = '';
  for (let v = lo; v <= hi; v += step) grid += `<line class="g${v === 0 ? ' z' : ''}" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${L - 5}" y="${(Y(v) + 4.5).toFixed(1)}" text-anchor="end">${fmtCm(v)}</text>`;
  for (let k = -6; k <= 12; k += (W < 340 ? 6 : 3)) { const t = c.now + k * 3600e3; xt += `<line class="g" x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${T}" y2="${H - B}"/><text x="${X(t).toFixed(1)}" y="${H - 8}" text-anchor="${X(t) > W - 22 ? 'end' : 'middle'}">${k === 0 ? 'ora' : hm(t)}</text>`; }
  const marks = ext.filter(e => e.ts >= c.from && e.ts <= c.to).map(e => `<circle class="ex" cx="${X(e.ts).toFixed(1)}" cy="${Y(e.cm).toFixed(1)}" r="3.5"/><text class="exl" x="${X(e.ts).toFixed(1)}" y="${(Y(e.cm) + (e.type === 'max' ? -8 : 17)).toFixed(1)}" text-anchor="middle">${fmtCm(e.cm)}</text>`).join('');
  const desc = `Grafico del livello di marea dalle ${hm(c.from)} alle ${hm(c.to)}: fino a sei ore osservate e dodici ore previste. Usa il cursore sotto il grafico per leggere il livello a ogni ora.`;
  return `<div class="tide-chart" data-lo="${lo}" data-hi="${hi}"><div class="tide-read" aria-live="polite"><span class="tr-time"></span><b class="tr-val"></b><span class="tr-kind"></span></div>`
    + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(desc)}">${grid}${xt}`
    + `<line class="nowl" x1="${X(c.now).toFixed(1)}" x2="${X(c.now).toFixed(1)}" y1="${T}" y2="${H - B}"/>`
    + (obs.length > 1 ? `<path class="obs" d="${path(obs)}"/>` : '') + (fc.length > 1 ? `<path class="fc" d="${path(fc)}"/>` : '') + marks
    + `<line class="cur" y1="${T}" y2="${H - B}" x1="-10" x2="-10"/><circle class="curd" r="5" cx="-10" cy="-10"/></svg>`
    + `<input class="tide-range" type="range" min="${c.from}" max="${c.to}" step="300000" value="${c.now}" aria-label="Cursore orario: scorri per leggere il livello di marea">`
    + `<p class="tide-legend" title="La curva prevista è ricavata dagli estremi di marea previsti da CPSM"><span class="lgi"><span class="lg obs"></span>osservato</span><span class="lgi"><span class="lg fc"></span>previsto</span></p></div>`;
}
function bindChart(c) {                                       // collega cursore e grafico; si richiama a ogni disegno
  const box = body.querySelector('.tide-chart'); if (!box) return;
  const svg = box.querySelector('svg'), rng = box.querySelector('.tide-range'), line = svg.querySelector('.cur'), dot = svg.querySelector('.curd');
  const set = t => {
    t = Math.min(c.to, Math.max(c.from, t)); cursorT = Math.abs(t - c.now) < 150000 ? null : t;
    const X = L => CH.L + (CH.W - CH.L - CH.R) * (t - c.from) / (c.to - c.from), v = valueAt(c, t), hmTxt = `${dayTag(t)}${hm(t)}`;
    rng.value = String(t); line.setAttribute('x1', X()); line.setAttribute('x2', X());
    const lo = +box.dataset.lo, hi = +box.dataset.hi;
    if (v) { const Yv = CH.T + (CH.H - CH.T - CH.B) * (1 - (v.cm - lo) / (hi - lo)); dot.setAttribute('cx', X()); dot.setAttribute('cy', Yv.toFixed(1)); } else { dot.setAttribute('cx', -10); dot.setAttribute('cy', -10); }
    box.querySelector('.tr-time').textContent = hmTxt;
    box.querySelector('.tr-val').textContent = v ? `${fmtCm(v.cm)} cm` : 'nessun dato';
    box.querySelector('.tr-kind').textContent = v ? (v.kind === 'previsto' ? 'previsto' : 'osservato') : (t <= c.now ? 'storico non disponibile' : 'oltre la previsione');
    rng.setAttribute('aria-valuetext', `${hmTxt}: ${v ? fmtCm(v.cm) + ' centimetri, ' + v.kind : 'nessun dato'}`);
  };
  rng.addEventListener('input', () => set(+rng.value));
  const fromPtr = e => { const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * CH.W; set(c.from + (x - CH.L) / (CH.W - CH.L - CH.R) * (c.to - c.from)); };
  svg.addEventListener('pointerdown', e => { svg.setPointerCapture?.(e.pointerId); fromPtr(e); });
  svg.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'mouse') fromPtr(e); });
  set(cursorT ?? c.now);
}
function render() {
  const d = data;
  if (!d) { body.innerHTML = err ? `<p class="tide-note">Dati di marea non disponibili: ${esc(err)}</p>` : 'Caricamento…'; return; }
  const t = d.trend;
  const tr = !t ? { icon: 'steady', txt: 'Tendenza in calcolo…' }
    : t.dir === 'up' ? { icon: 'up', txt: `In crescita${t.rate != null ? ` · +${Math.abs(t.rate)} cm/h` : ''}` }
    : t.dir === 'down' ? { icon: 'down', txt: `In calo${t.rate != null ? ` · −${Math.abs(t.rate)} cm/h` : ''}` }
    : { icon: 'steady', txt: 'Stazionaria' };
  const next = (d.next || []).map(n => `<li><b>${n.type === 'max' ? 'Alta' : 'Bassa'}</b><span class="v"><i class="cdot" data-cat="${esc(n.cat || '')}" aria-hidden="true"></i>${fmtCm(n.cm)} cm · ${dayTag(n.ts)}${hm(n.ts)}</span></li>`).join('');
  body.innerHTML = `<div class="tide-level"><span class="num">${fmtCm(d.cm)}</span><span class="unit">cm</span></div>`
    + `<div class="tide-cat" data-cat="${esc(d.category.key)}">${esc(d.category.label)}</div>`
    + `<div class="tide-trend">${icon(tr.icon)}<span>${tr.txt}${t && t.basis === 'previsione' ? ' <span class="muted">(da previsione)</span>' : ''}</span></div>`
    + (d.stale ? `<p class="tide-note" role="status">Ultimo dato di ${d.ageMin} minuti fa: potrebbe non essere aggiornato.</p>` : '')
    + (next ? `<ul class="tide-next" aria-label="Prossime alte e basse maree previste">${next}</ul>` : '')
    + (d.chart ? chartHtml(d.chart) : '')
    + `<p class="tide-foot">${esc(d.station)} · rilevato alle ${hm(d.ts)}. Livello sullo zero mareografico di Punta della Salute; dati grezzi, non validati.<br>Fonte (licenza ${esc(d.source.license)}):<a href="${esc(safeUrl(d.source.url))}" target="_blank" rel="noopener noreferrer">${esc(d.source.name)}</a></p>`;
  if (d.chart) bindChart(d.chart);
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
  window.addEventListener('resize', () => { if (!card.hidden) { render(); position(); } });
  load(); setInterval(() => { if (!document.hidden && card.hidden) load(); }, 300000);   // aggiorna anche il punto colorato sul pulsante
}
