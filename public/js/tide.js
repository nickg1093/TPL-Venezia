// FINESTRA MAREA: livello attuale, categoria, tendenza, prossimi estremi e grafico delle ultime ore (dati CPSM Venezia tramite /api/tide).
import { $, esc, icon, hm, api } from './util.js';

const btn = $('tide-btn'), card = $('tide'), body = $('tide-body');
let data = null, err = null, timer = null, mose = null;
const fmtCm = cm => `${cm > 0 ? '+' : cm < 0 ? '−' : ''}${Math.abs(cm)}`;
const dayTag = ms => { const a = new Date(ms), b = new Date(); return a.toDateString() === b.toDateString() ? '' : a.toLocaleDateString('it-IT', { weekday: 'short' }) + ' '; };
// Promemoria breve: con la marea (attuale o prevista nel grafico) oltre 85 cm ACTV pubblica quali servizi di navigazione sono previsti
const AA_URL = 'https://actv.avmspa.it/it/content/acqua-alta-servizi-di-navigazione-previsti', AA_CM = 85;
const peakOf = d => Math.max(d.cm, ...(d.next || []).map(n => n.cm), ...((d.chart && d.chart.forecast) || []).map(p => p[1]));
// triangolo accanto alle maree oltre la prima soglia del piano ACTV: apre l'avviso di acqua alta (ufficiale o calcolato dal livello)
const warnBtn = `<button type="button" class="tide-warn" aria-label="Acqua alta oltre ${AA_CM} cm: apri l'avviso sui servizi di navigazione" title="Apri l'avviso di acqua alta">${icon('warn', 'sm')}</button>`;
const safeUrl = u => (/^https:\/\//.test(u) ? u : '#');

// ---- GRAFICO: fino a 6 ore osservate + 18 ore previste, con cursore mobile: si trascina sul grafico (dito o mouse) o si usano le frecce ----
const CH = { W: 300, H: 200, L: 42, R: 10, T: 14, B: 28 };   // W si adatta alla larghezza della scheda: il testo del grafico resta della grandezza prevista su ogni schermo
let cursorT = null;                                           // istante scelto (null = adesso); resta anche se i dati si aggiornano
const lerp = (pts, t) => {                                    // valore interpolato su una serie [[t, cm], …] ordinata; null fuori dalla serie
  if (!pts.length || t < pts[0][0] || t > pts[pts.length - 1][0]) return null;
  for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const a = pts[i - 1], b = pts[i], f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * f; }
  return pts[pts.length - 1][1];
};
// Serie PREVISTA disegnata e letta dal cursore: parte dall'ULTIMO valore osservato, così tra l'ultima misura (es. 16:20) e l'inizio della
// previsione non resta un buco "nessun dato" proprio intorno all'ora attuale. Quel tratto è trattato come previsione (linea tratteggiata).
const fcFrom = c => {
  const obs = c.observed || [], fc = c.forecast || [], last = obs[obs.length - 1];
  return last ? [last, ...fc.filter(p => p[0] > last[0])] : fc;
};
function valueAt(c, t) {                                      // { cm, kind: 'osservato' | 'previsto' } oppure null
  const obs = c.observed || [], last = obs[obs.length - 1];
  if (last && t <= last[0]) { const v = lerp(obs, t); return v == null ? null : { cm: Math.round(v), kind: 'osservato' }; }
  const v = lerp(fcFrom(c), t); return v == null ? null : { cm: Math.round(v), kind: 'previsto' };
}
function chartHtml(c) {
  CH.W = Math.max(200, Math.min(520, Math.round((card.clientWidth || 340) - 40)));
  const obs = c.observed || [], fc = fcFrom(c), ext = c.extremes || [], { W, H, L, R, T, B } = CH;
  const vals = [...obs, ...fc].map(p => p[1]).concat(ext.map(e => e.cm));
  if (vals.length < 2) return '';
  let lo = Math.min(...vals), hi = Math.max(...vals); const step = hi - lo > 120 ? 50 : hi - lo > 50 ? 20 : 10;
  lo = Math.floor((lo - 5) / step) * step; hi = Math.ceil((hi + 5) / step) * step;
  const X = t => L + (W - L - R) * (t - c.from) / (c.to - c.from), Y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join('');
  let grid = '', xt = '';
  for (let v = lo; v <= hi; v += step) grid += `<line class="g${v === 0 ? ' z' : ''}" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${L - 5}" y="${(Y(v) + 4.5).toFixed(1)}" text-anchor="end">${fmtCm(v)}</text>`;
  // etichette dell'asse orario: solo se c'è spazio dalla precedente (circa 44 px per "19:10"); l'ultima linea resta anche senza etichetta
  let lastX = -1e9;
  for (let k = -6; k <= 18; k += (W < 420 ? 6 : 3)) {
    const t = c.now + k * 3600e3, x = X(t), anchor = x > W - 22 ? 'end' : 'middle', left = anchor === 'end' ? x - 36 : x - 18;
    xt += `<line class="g" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${T}" y2="${H - B}"/>`;
    if (left - lastX >= 8) { xt += `<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="${anchor}">${k === 0 ? 'ora' : hm(t)}</text>`; lastX = anchor === 'end' ? x : x + 18; }
  }
  // MOSE nel grafico: soglia di 110 cm (il sollevamento si decide con previsioni oltre questo livello) se rientra nella scala, e l'orario
  // del sollevamento programmato, se l'Autorità lo pubblica
  let ms = '';
  if (hi >= 100) { const y = Y(110).toFixed(1); ms += `<line class="msl" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text class="mst" x="${W - R - 3}" y="${(+y - 5).toFixed(1)}" text-anchor="end">MOSE 110</text>`; }
  const evT = moseEventMs(); if (evT && evT >= c.from && evT <= c.to) { const x = X(evT).toFixed(1); ms += `<line class="msv" x1="${x}" x2="${x}" y1="${T}" y2="${H - B}"/><text class="mst" x="${x}" y="${T + 11}" text-anchor="${+x > W - 60 ? 'end' : 'start'}" dx="${+x > W - 60 ? -4 : 4}">MOSE ${hm(evT)}</text>`; }
  const marks = ext.filter(e => e.ts >= c.from && e.ts <= c.to).map(e => `<circle class="ex" cx="${X(e.ts).toFixed(1)}" cy="${Y(e.cm).toFixed(1)}" r="3.5"/><text class="exl" x="${X(e.ts).toFixed(1)}" y="${(Y(e.cm) + (e.type === 'max' ? -8 : 17)).toFixed(1)}" text-anchor="middle">${fmtCm(e.cm)}</text>`).join('');
  const desc = `Grafico del livello di marea dalle ${hm(c.from)} alle ${hm(c.to)}: fino a sei ore osservate e diciotto ore previste. Trascina sul grafico, o usa le frecce, per leggere il livello a ogni ora.`;
  return `<div class="tide-chart" data-lo="${lo}" data-hi="${hi}"><div class="tide-read" aria-live="polite"><span class="tr-time"></span><b class="tr-val"></b><span class="tr-kind"></span></div>`
    + `<svg viewBox="0 0 ${W} ${H}" role="slider" tabindex="0" aria-label="${esc(desc)}" aria-valuemin="${c.from}" aria-valuemax="${c.to}" aria-valuenow="${c.now}">${grid}${xt}${ms}`
    + `<line class="nowl" x1="${X(c.now).toFixed(1)}" x2="${X(c.now).toFixed(1)}" y1="${T}" y2="${H - B}"/>`
    + (obs.length > 1 ? `<path class="obs" d="${path(obs)}"/>` : '') + (fc.length > 1 ? `<path class="fc" d="${path(fc)}"/>` : '') + marks
    + `<line class="cur" y1="${T}" y2="${H - B}" x1="-10" x2="-10"/><circle class="curd" r="5" cx="-10" cy="-10"/></svg>`
    + `<p class="tide-legend" title="La curva prevista è ricavata dagli estremi di marea previsti da CPSM"><span class="lgi"><span class="lg obs"></span>osservato</span><span class="lgi"><span class="lg fc"></span>previsto</span></p></div>`;
}
function bindChart(c) {                                       // collega cursore e grafico; si richiama a ogni disegno
  const box = body.querySelector('.tide-chart'); if (!box) return;
  const svg = box.querySelector('svg'), line = svg.querySelector('.cur'), dot = svg.querySelector('.curd');
  let curT = c.now;
  const set = t => {
    t = Math.min(c.to, Math.max(c.from, t)); cursorT = Math.abs(t - c.now) < 150000 ? null : t;
    const X = L => CH.L + (CH.W - CH.L - CH.R) * (t - c.from) / (c.to - c.from), v = valueAt(c, t), hmTxt = `${dayTag(t)}${hm(t)}`;
    curT = t; line.setAttribute('x1', X()); line.setAttribute('x2', X());
    const lo = +box.dataset.lo, hi = +box.dataset.hi;
    if (v) { const Yv = CH.T + (CH.H - CH.T - CH.B) * (1 - (v.cm - lo) / (hi - lo)); dot.setAttribute('cx', X()); dot.setAttribute('cy', Yv.toFixed(1)); } else { dot.setAttribute('cx', -10); dot.setAttribute('cy', -10); }
    box.querySelector('.tr-time').textContent = hmTxt;
    box.querySelector('.tr-val').textContent = v ? `${fmtCm(v.cm)} cm` : 'nessun dato';
    box.querySelector('.tr-kind').textContent = v ? (v.kind === 'previsto' ? 'previsto' : 'osservato') : (t <= ((c.observed || [])[0]?.[0] ?? c.now) ? 'storico non disponibile' : 'oltre la previsione');
    svg.setAttribute('aria-valuenow', String(Math.round(t))); svg.setAttribute('aria-valuetext', `${hmTxt}: ${v ? fmtCm(v.cm) + ' centimetri, ' + v.kind : 'nessun dato'}`);
  };
  // tastiera: frecce ±5 minuti, Pagina su/giù ±1 ora, Inizio/Fine
  svg.addEventListener('keydown', e => {
    const d = { ArrowLeft: -3e5, ArrowDown: -3e5, ArrowRight: 3e5, ArrowUp: 3e5, PageDown: -36e5, PageUp: 36e5 }[e.key];
    if (d) { e.preventDefault(); set(curT + d); } else if (e.key === 'Home') { e.preventDefault(); set(c.from); } else if (e.key === 'End') { e.preventDefault(); set(c.to); }
  });
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
  const next = (d.next || []).map(n => `<li><b>${n.type === 'max' ? 'Alta' : 'Bassa'}</b><span class="v">${fmtCm(n.cm)} cm · ${dayTag(n.ts)}${hm(n.ts)}<i class="cdot" data-cat="${esc(n.cat || '')}" aria-hidden="true"></i>${n.type === 'max' && n.cm > AA_CM ? warnBtn : ''}</span></li>`).join('');
  body.innerHTML = `<div class="tide-level"><span class="num">${fmtCm(d.cm)}</span><span class="unit">cm</span></div>`
    + `<div class="tide-cat" data-cat="${esc(d.category.key)}">${esc(d.category.label)}${d.cm > AA_CM ? warnBtn : ''}</div>`
    + `<div class="tide-trend">${icon(tr.icon)}<span>${tr.txt}${t && t.basis === 'previsione' ? ' <span class="muted">(da previsione)</span>' : ''}</span></div>`
    + (peakOf(d) > AA_CM ? `<a class="tide-aa" href="${AA_URL}" target="_blank" rel="noopener noreferrer">${icon('warn', 'sm')}<span>Oltre ${AA_CM} cm: servizi di navigazione previsti</span></a>` : '')
    + (d.stale ? `<p class="tide-note" role="status">Ultimo dato di ${Math.round(+d.ageMin) || 0} minuti fa: potrebbe non essere aggiornato.</p>` : '')
    + (next ? `<ul class="tide-next" aria-label="Prossime alte e basse maree previste">${next}</ul>` : '')
    + (d.chart ? chartHtml(d.chart) : '')
    + moseHtml()
    + `<p class="tide-foot">${esc(d.station)} · rilevato alle ${hm(d.ts)}. Livello sullo zero mareografico di Punta della Salute; dati grezzi, non validati.<br>Fonte (licenza ${esc(d.source.license)}):<a href="${esc(safeUrl(d.source.url))}" target="_blank" rel="noopener noreferrer">${esc(d.source.name)}</a></p>`;
  if (d.chart) bindChart(d.chart);
  btn.querySelector('.dotc').dataset.cat = d.category.key;
  markBtn();
  const label = `Marea a Venezia: ${fmtCm(d.cm)} cm, ${d.category.label.toLowerCase()}${t ? ', ' + tr.txt.split(' · ')[0].toLowerCase() : ''}`;
  btn.setAttribute('aria-label', label); btn.title = label;
}
async function load() {
  try { const d = await api('/api/tide'); if (d.error) throw new Error(d.error); data = d; err = null; }
  catch (e) { err = e.message; }
  render(); if (!card.hidden) position();
}
// MOSE attivo o in movimento: segnale anche sul pulsante della marea (dallo stato letto o dal riassunto di /api/tide)
function markBtn() {
  const ms = mose && !mose.error ? mose : data?.mose;
  if (ms && ms.sem && ms.sem !== 'verde' && ms.sem !== 'grigio') btn.dataset.mose = ms.sem; else delete btn.dataset.mose;
}
// stato del MOSE: solo con la finestra aperta (il server legge la fonte al massimo ogni 4-10 minuti)
async function loadMose() {
  try { mose = await api('/api/mose'); } catch { mose = mose || { error: 'non disponibile' }; }
  // si aggiorna solo il riquadro MOSE (e il segnale sul pulsante): il grafico resta com'è, con il cursore dove l'hai messo
  const sec = body.querySelector('section.mose');
  if (sec && data) { sec.outerHTML = moseHtml(); markBtn(); if (!card.hidden) position(); }
  else if (!card.hidden) { render(); position(); }
}

// ---- MOSE: semafori per barriera (verde in recesso, giallo programmato, giallo lampeggiante in movimento, rosso sollevata) ----
const SEM_TXT = { verde: 'in recesso', giallo: 'sollevamento programmato', lampeggia: 'in movimento', rosso: 'sollevata', grigio: 'stato non riconosciuto' };
const STATO_TXT = { recesso: 'In recesso', programmato: 'Programmato', sollevamento: 'In sollevamento', abbassamento: 'In abbassamento', sollevata: 'Sollevata' };
function moseEventMs() {                                      // «14/11/2026» + «06:30» (ora di Venezia) -> ms
  const e = mose && !mose.error && mose.evento; if (!e) return null;
  const d = String(e.data || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/), t = String(e.orario || '').match(/(\d{1,2})[:.](\d{2})/);
  if (!d || !t) return null;
  const ms = new Date(+d[3], +d[2] - 1, +d[1], +t[1], +t[2]).getTime();
  return Number.isFinite(ms) ? ms : null;
}
const sema = sem => `<span class="sema" data-sem="${esc(sem)}" aria-hidden="true"><i class="r"></i><i class="y"></i><i class="g"></i></span>`;
function moseHtml() {
  if (!mose) return '<section class="mose" aria-label="MOSE"><h3 class="mose-h">MOSE <span class="muted">· caricamento…</span></h3></section>';
  if (mose.error) return `<section class="mose" aria-label="MOSE"><h3 class="mose-h">MOSE</h3><p class="tide-note">Stato delle barriere non disponibile in questo momento. <a href="https://www.autoritalaguna.it/operativita-m-o-s-e/" target="_blank" rel="noopener noreferrer">Pagina dell'Autorità per la Laguna</a></p></section>`;
  const groups = []; for (const b of mose.barriere || []) { let g = groups.find(x => x.bocca === b.bocca); if (!g) groups.push(g = { bocca: b.bocca, list: [] }); g.list.push(b); }
  const evT = moseEventMs();
  return `<section class="mose" data-sem="${esc(mose.sem)}" aria-label="MOSE: ${esc(mose.titolo)}">`
    + `<h3 class="mose-h">${sema(mose.sem)}<span>${esc(mose.titolo)}</span></h3>`
    + (mose.evento && (mose.evento.data || mose.evento.orario) ? `<p class="mose-ev">${icon('clock', 'sm')}<span>Sollevamento previsto ${evT ? `${dayTag(evT)}alle ${hm(evT)}` : esc(`${mose.evento.data} ${mose.evento.orario}`.trim())}</span></p>` : '')
    + `<ul class="mose-b">${groups.map(g => `<li><b>${esc(g.bocca.replace(/^Bocca di /i, ''))}</b><ul>${g.list.map(b => `<li data-sem="${esc(b.sem)}">${sema(b.sem)}<span class="mb-n">${esc(b.barriera.replace(/^Barriera di /i, ''))}</span><span class="mb-s">${esc(STATO_TXT[b.stato] || b.testo)}</span><span class="sr-only"> (${SEM_TXT[b.sem] || ''})</span></li>`).join('')}</ul></li>`).join('')}</ul>`
    + `<p class="tide-foot">${mose.aggiornato ? `Stato aggiornato dall'Autorità alle ${dayTag(mose.aggiornato)}${hm(mose.aggiornato)}` : 'Stato'}${mose.stale ? ' · <b>non aggiornato di recente</b>' : ''}. Il sollevamento si decide con previsioni oltre 110 cm; informazione indicativa.<br>Fonte:<a href="${esc(safeUrl(mose.fonte?.url || ''))}" target="_blank" rel="noopener noreferrer">${esc(mose.fonte?.nome || 'Autorità per la Laguna di Venezia')} · Operatività M.O.S.E.</a></p></section>`;
}
function position() {   // la scheda si allinea al suo pulsante, senza uscire dalla mappa
  const w = $('wrap').getBoundingClientRect(), b = btn.getBoundingClientRect(), h = card.offsetHeight, g = 12;
  card.style.top = Math.max(g, Math.min(b.top - w.top - 8, w.height - h - g)) + 'px';
}
export const isOpen = () => !card.hidden;
export function open(beforeOpen) {
  if (beforeOpen) beforeOpen();
  card.hidden = false; btn.setAttribute('aria-expanded', 'true'); render(); position(); card.focus({ preventScroll: true });
  load(); loadMose(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) { load(); loadMose(); } }, 60000);   // app in secondo piano: nessuna richiesta
}
export function close() { if (card.hidden) return; card.hidden = true; btn.setAttribute('aria-expanded', 'false'); clearInterval(timer); }
export function init(beforeOpen) {
  body.addEventListener('click', e => { if (e.target.closest('.tide-warn')) window.dispatchEvent(new CustomEvent('tpl:water-alert')); });
  btn.onclick = () => (card.hidden ? open(beforeOpen) : close());
  $('tide-close').onclick = () => { close(); btn.focus(); };
  window.addEventListener('resize', () => { if (!card.hidden) { render(); position(); } });
  load(); setInterval(() => { if (!document.hidden && card.hidden) load(); }, 300000);   // aggiorna anche il punto colorato sul pulsante
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !card.hidden) { load(); loadMose(); } });   // di nuovo visibile con la finestra aperta: dato fresco subito
}
