// FINESTRA MAREA: livello attuale, categoria, tendenza, prossimi estremi e grafico delle ultime ore (dati CPSM Venezia tramite /api/tide).
import { $, esc, icon, hm, dataCompleta, api, seguiScheda, altezzaUtile, romeP } from './util.js';

const btn = $('tide-btn'), card = $('tide'), body = $('tide-body');
let data = null, err = null, timer = null, mose = null, moseOpen = false, drawnEv = null;   // dettaglio delle 4 barriere: chiuso di base, resta come lo lascia l'utente
const fmtCm = cm => `${cm > 0 ? '+' : cm < 0 ? '−' : ''}${Math.abs(cm)}`;
const dayTag = ms => (romeP(ms).iso === romeP().iso ? '' : new Date(ms).toLocaleDateString('it-IT', { weekday: 'short', timeZone: 'Europe/Rome' }) + ' ');
// Promemoria breve: con la marea (attuale o prevista nel grafico) oltre 85 cm ACTV pubblica quali servizi di navigazione sono previsti
const AA_URL = 'https://actv.avmspa.it/it/content/acqua-alta-servizi-di-navigazione-previsti', AA_CM = 85;
const peakOf = d => Math.max(d.cm, ...(d.next || []).map(n => n.cm), ...((d.chart && d.chart.forecast) || []).map(p => p[1]));
// triangolo accanto alle maree oltre la prima soglia del piano ACTV: apre l'avviso di acqua alta (ufficiale o calcolato dal livello)
const warnBtn = `<button type="button" class="tide-warn" aria-label="Acqua alta oltre ${AA_CM} cm: apri l'avviso sui servizi di navigazione" title="Apri l'avviso di acqua alta">${icon('warn', 'sm')}</button>`;
// dato vecchio: entro 90 minuti si dice da quanti minuti, oltre si dice l'ora (e il giorno) dell'ultima misura; se la fonte non risponde
// al server lo si dice chiaramente, così il livello mostrato non sembra quello attuale
const staleTxt = d => {
  const min = Math.max(0, Math.round(+d.ageMin) || 0), quando = min <= 90 ? `di ${min} minuti fa` : `delle ${dayTag(d.ts)}${hm(d.ts)}`;
  return `<b>Livello non aggiornato</b>: ultimo dato ${quando}.${d.fonte && d.fonte.ok === false ? ' Il Centro Maree al momento non risponde al server; per il livello attuale vale la previsione.' : ''}`;
};
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
    if (left - lastX >= 8) { xt += `<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="${anchor}">${k === 0 && !data?.salvata ? 'ora' : hm(t)}</text>`; lastX = anchor === 'end' ? x : x + 18; }
  }
  // ETICHETTE SENZA SOVRAPPOSIZIONI: valori dei massimi/minimi, soglia MOSE (110 cm, linea tratteggiata) e orario del sollevamento
  // programmato (linea verticale). Per ognuna si provano più posizioni e si sceglie la prima che non tocca le etichette già messe, la curva
  // e i bordi; se nessuna è libera, quella che ne tocca meno. Larghezza stimata del testo (cifre e maiuscole, grassetto): 0,7 × corpo,
  // un po' abbondante perché il carattere cambia da telefono a telefono.
  const tOf = x => c.from + (x - L) / (W - L - R) * (c.to - c.from), boxes = [];
  const box = (x, y, txt, anchor, fs) => { const w = txt.length * fs * 0.7 + 3, x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x; return { x0, x1: x0 + w, y0: y - fs * 0.78, y1: y + fs * 0.22 }; };
  const over = (a, b) => a.x0 < b.x1 + 2 && b.x0 < a.x1 + 2 && a.y0 < b.y1 + 1 && b.y0 < a.y1 + 1;
  const curva = b => { for (let x = Math.max(L, b.x0); x <= Math.min(W - R, b.x1); x += 2) { const v = valueAt(c, tOf(x)); if (v) { const y = Y(v.cm); if (y >= b.y0 - 3 && y <= b.y1 + 3) return 1; } } return 0; };
  const fuori = b => (b.x0 < L + 1 || b.x1 > W - R - 1 || b.y0 < 0 || b.y1 > H - B - 1 ? 1 : 0);
  const xn = X(c.now), extra = [b => b.x0 < xn + 2 && b.x1 > xn - 2];   // linee verticali da non coprire: «ora» e sollevamento del MOSE
  function place(cands, txt, cls, fs, linee = true) {
    let best = null;
    for (const [x, y, anchor] of cands) {
      const b = box(x, y, txt, anchor, fs);
      const score = boxes.filter(o => over(o, b)).length * 10 + fuori(b) * 20 + (linee ? curva(b) * 4 : 0) + extra.filter(f => f(b)).length * 3;
      if (!best || score < best.score) best = { x, y, anchor, b, score };
      if (score === 0) break;
    }
    boxes.push(best.b);
    return `<text class="${cls}" x="${best.x.toFixed(1)}" y="${best.y.toFixed(1)}" text-anchor="${best.anchor}">${txt}</text>`;
  }
  let ms = '', lab = '';
  const evT = moseEventMs(); drawnEv = evT;
  const xv = evT && evT >= c.from && evT <= c.to ? X(evT) : null;
  if (xv != null) { ms += `<line class="msv" x1="${xv.toFixed(1)}" x2="${xv.toFixed(1)}" y1="${T}" y2="${H - B}"/>`; extra.push(b => b.x0 < xv + 2 && b.x1 > xv - 2); }
  const y110 = hi >= 100 ? Y(110) : null;
  if (y110 != null) ms += `<line class="msl" x1="${L}" x2="${W - R}" y1="${y110.toFixed(1)}" y2="${y110.toFixed(1)}"/>`;
  // valori degli estremi per primi (sono i più importanti): sopra o sotto il punto, oppure di lato
  const marks = ext.filter(e => e.ts >= c.from && e.ts <= c.to).map(e => {
    const x = X(e.ts), y = Y(e.cm), up = e.type === 'max';
    boxes.push({ x0: x - 5, x1: x + 5, y0: y - 5, y1: y + 5 });     // il cerchio stesso
    const cand = up ? [[x, y - 9, 'middle'], [x + 8, y - 4, 'start'], [x - 8, y - 4, 'end'], [x, y + 19, 'middle']] : [[x, y + 19, 'middle'], [x + 8, y + 9, 'start'], [x - 8, y + 9, 'end'], [x, y - 9, 'middle']];
    return `<circle class="ex" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"/>` + place(cand, fmtCm(e.cm), 'exl', 13, false);
  }).join('');
  // soglia 110: sopra o sotto la linea, da destra a sinistra (prima dell'orario del sollevamento, che ha più posti possibili)
  if (y110 != null) { const cand = [[W - R - 3, y110 - 5, 'end'], [W - R - 3, y110 + 15, 'end']]; for (let x = W - R - 50; x > L + 40; x -= 30) cand.push([x, y110 - 5, 'middle'], [x, y110 + 15, 'middle']); cand.push([L + 4, y110 - 5, 'start'], [L + 4, y110 + 15, 'start']); lab += place(cand, 'MOSE 110', 'mst', 12); }
  // orario del sollevamento: accanto alla linea, a destra o a sinistra, dall'alto in basso
  if (xv != null) { const cand = []; for (let y = T + 11; y <= H - B - 4; y += 14) cand.push([xv + 4, y, 'start'], [xv - 4, y, 'end']); lab += place(cand, `MOSE ${hm(evT)}`, 'mst', 12); }
  const desc = `Grafico del livello di marea dalle ${hm(c.from)} alle ${hm(c.to)}: fino a sei ore osservate e diciotto ore previste. Trascina sul grafico, o usa le frecce, per leggere il livello a ogni ora.`;
  return `<div class="tide-chart" data-lo="${lo}" data-hi="${hi}"><div class="tide-read" aria-live="polite"><span class="tr-time"></span><b class="tr-val"></b><span class="tr-kind"></span></div>`
    + `<svg viewBox="0 0 ${W} ${H}" role="slider" tabindex="0" aria-label="${esc(desc)}" aria-valuemin="${c.from}" aria-valuemax="${c.to}" aria-valuenow="${c.now}">${grid}${xt}${ms}`
    + `<line class="nowl" x1="${X(c.now).toFixed(1)}" x2="${X(c.now).toFixed(1)}" y1="${T}" y2="${H - B}"/>`
    + (obs.length > 1 ? `<path class="obs" d="${path(obs)}"/>` : '') + (fc.length > 1 ? `<path class="fc" d="${path(fc)}"/>` : '') + marks + lab
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
    window.dispatchEvent(new CustomEvent('tpl:tide-cursor'));   // livelli della mappa (livelli.js): allagamento all'ora scelta
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
// oltre 85 cm ACTV modifica alcuni servizi di navigazione: quando (adesso o il primo massimo previsto oltre la soglia) e link al piano ACTV
function aaLink(d) {
  if (!(peakOf(d) > AA_CM)) return '';
  const nx = (d.next || []).find(n => n.type === 'max' && n.cm > AA_CM), fc = ((d.chart && d.chart.forecast) || []).find(p => p[1] > AA_CM && p[0] > Date.now());
  const txt = d.cm > AA_CM ? `${d.salvata ? `Alle ${hm(d.ts)} (dati salvati)` : 'Adesso'} ${fmtCm(d.cm)} cm: alcuni servizi di navigazione sono modificati`
    : nx ? `Prevista ${fmtCm(nx.cm)} cm ${dayTag(nx.ts)}${hm(nx.ts)}: alcuni servizi di navigazione cambiano`
    : fc ? `Prevista oltre ${AA_CM} cm ${dayTag(fc[0])}${hm(fc[0])}: alcuni servizi di navigazione cambiano` : `Oltre ${AA_CM} cm alcuni servizi di navigazione cambiano`;
  return `<a class="tide-aa" href="${AA_URL}" target="_blank" rel="noopener noreferrer">${icon('warn', 'sm')}<span>${txt} · piano ACTV</span></a>`;
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
    + aaLink(d)
    + (d.salvata ? `<p class="tide-note" role="status"><b>Senza connessione: dati salvati</b> alle ${dayTag(d.salvata)}${hm(d.salvata)}. Livello e tendenza sono di allora; per le ore successive vale la previsione di allora.</p>` : '')
    + (d.stale && !d.salvata ? `<p class="tide-note" role="status">${staleTxt(d)}</p>` : '')
    + (next ? `<ul class="tide-next" aria-label="Prossime alte e basse maree previste">${next}</ul>` : '')
    + (d.chart ? chartHtml(d.chart) : '')
    + moseHtml()
    + `<p class="tide-foot">${esc(d.station)} · rilevato alle ${hm(d.ts)}. Livello sullo zero mareografico di Punta della Salute; dati grezzi, non validati.<br>Fonte (licenza ${esc(d.source.license)}):<a href="${esc(safeUrl(d.source.url))}" target="_blank" rel="noopener noreferrer">${esc(d.source.name)}</a>`
    + (d.forecastSource && d.forecastSource.url !== d.source.url ? `<br>Il Centro Maree non risponde: livello dalla rete ISPRA. Previsioni:<a href="${esc(safeUrl(d.forecastSource.url))}" target="_blank" rel="noopener noreferrer">${esc(d.forecastSource.name)}</a>${d.forecastAgeMin != null && d.forecastAgeMin > 60 ? ` (aggiornate ${d.forecastAgeMin >= 120 ? Math.round(d.forecastAgeMin / 60) + ' ore' : d.forecastAgeMin + ' minuti'} fa)` : ''}` : '')
    + '</p>';
  if (d.chart) bindChart(d.chart);
  btn.querySelector('.dotc').dataset.cat = d.category.key;
  markBtn();
  const label = `Marea a Venezia: ${fmtCm(d.cm)} cm, ${d.category.label.toLowerCase()}${t ? ', ' + tr.txt.split(' · ')[0].toLowerCase() : ''}${d.salvata ? ' (dati salvati, senza connessione)' : ''}`;
  btn.setAttribute('aria-label', label); btn.title = label;
}
// SENZA RETE: l'ultima risposta valida resta nel telefono (36 ore al massimo) e si usa, dichiarata come «dati salvati» con l'ora, solo se
// non ci sono dati più nuovi. Livello e tendenza sono quelli di allora; per le ore successive vale la previsione salvata (livelli.js).
const SALVA = 'tpl.marea', MAX_SALVATI = 36 * 3600e3;
async function load() {
  try {
    const d = await api('/api/tide'); if (d.error) throw new Error(d.error); data = d; err = null;
    try { localStorage.setItem(SALVA, JSON.stringify({ t: Date.now(), d })); } catch { /* memoria piena o non disponibile */ }
  } catch (e) {
    err = e.message;
    if (!data || data.salvata) {
      try { const s = JSON.parse(localStorage.getItem(SALVA) || 'null'); if (s?.d?.chart && Date.now() - s.t < MAX_SALVATI) data = { ...s.d, salvata: s.t }; } catch { /* niente */ }
    }
  }
  render(); if (!card.hidden) position();
  window.dispatchEvent(new CustomEvent('tpl:tide'));                 // dati nuovi: livelli della mappa e pianificatore
}
// MOSE attivo o in movimento: segnale anche sul pulsante della marea (dallo stato letto o dal riassunto di /api/tide)
function markBtn() {
  const ms = mose && !mose.error ? mose : data?.mose;
  if (ms && ms.sem && ms.sem !== 'verde' && ms.sem !== 'grigio') btn.dataset.mose = ms.sem; else delete btn.dataset.mose;
}
// stato del MOSE: solo con la finestra aperta (il server legge la fonte al massimo ogni 4-10 minuti)
async function loadMose() {
  try { mose = await api('/api/mose'); } catch { mose = mose || { error: 'non disponibile' }; }
  // si aggiorna solo il riquadro MOSE (e il segnale sul pulsante); il grafico si ridisegna solo se cambia l'orario del sollevamento
  // (linea verticale), con il cursore dove l'hai messo
  const sec = body.querySelector('section.mose');
  if (sec && data) {
    sec.outerHTML = moseHtml(); markBtn();
    const ch = body.querySelector('.tide-chart'); if (ch && data.chart && moseEventMs() !== drawnEv) { ch.outerHTML = chartHtml(data.chart); bindChart(data.chart); }
    if (!card.hidden) position();
  }
  else if (!card.hidden) { render(); position(); }
}

// ---- MOSE: semafori per barriera (verde in recesso, giallo programmato, giallo lampeggiante in movimento, rosso sollevata) ----
const SEM_TXT = { verde: 'in recesso', giallo: 'sollevamento programmato', lampeggia: 'in movimento', rosso: 'sollevata', grigio: 'stato non riconosciuto' };
const STATO_TXT = { recesso: 'In recesso', programmato: 'Sollevamento programmato', sollevamento: 'In sollevamento', abbassamento: 'In abbassamento', sollevata: 'Sollevata' };
function moseEventMs() {                                      // istante del sollevamento programmato (ora di Venezia, già convertito dal server)
  const e = mose && !mose.error && mose.evento; if (!e) return null;
  if (Number.isFinite(e.ms)) return e.ms;
  return null;   // senza istante certo non si indovina (AM/PM): si mostra il testo della fonte
}
const sema = sem => `<span class="sema" data-sem="${esc(sem)}" aria-hidden="true"><i class="r"></i><i class="y"></i><i class="g"></i></span>`;
function riepilogo(list) {                                   // «· 4 in recesso» / «· 2 sollevate, 2 in recesso»
  if (!list.length) return '';
  // [singolare, plurale] riferiti a «barriera/barriere» (femminile)
  const LAB = { verde: ['in recesso', 'in recesso'], giallo: ['con sollevamento programmato', 'con sollevamento programmato'], lampeggia: ['in movimento', 'in movimento'], rosso: ['sollevata', 'sollevate'], grigio: ['con stato non riconosciuto', 'con stato non riconosciuto'] };
  const lab = (s, n) => esc((LAB[s] || ['', ''])[n > 1 ? 1 : 0]);
  const c = {}; for (const b of list) c[b.sem] = (c[b.sem] || 0) + 1;
  const k = Object.keys(c); if (k.length === 1) return ` <span class="muted">· ${list.length === 1 ? '' : 'tutte '}${lab(k[0], list.length)}</span>`;
  return ` <span class="muted">· ${k.map(s => `${c[s]} ${lab(s, c[s])}`).join(', ')}</span>`;
}
function moseHtml() {
  if (!mose) return '<section class="mose" aria-label="MOSE"><h3 class="mose-h">MOSE <span class="muted">· caricamento…</span></h3></section>';
  if (mose.error) return `<section class="mose" aria-label="MOSE"><h3 class="mose-h">MOSE</h3><p class="tide-note">Stato delle barriere non disponibile in questo momento. <a href="https://www.autoritalaguna.it/operativita-m-o-s-e/" target="_blank" rel="noopener noreferrer">Pagina dell'Autorità per la Laguna</a></p></section>`;
  const groups = []; for (const b of mose.barriere || []) { let g = groups.find(x => x.bocca === b.bocca); if (!g) groups.push(g = { bocca: b.bocca, list: [] }); g.list.push(b); }
  const evT = moseEventMs();
  return `<section class="mose" data-sem="${esc(mose.sem)}" aria-label="MOSE: ${esc(mose.titolo)}">`
    + `<h3 class="mose-h">${sema(mose.sem)}<span>${esc(mose.titolo)}</span></h3>`
    + (mose.evento && (mose.evento.data || mose.evento.orario) ? `<p class="mose-ev">${icon('clock', 'sm')}<span>Sollevamento previsto ${evT ? `${dataCompleta(evT)} alle ${hm(evT)}` : esc(`${mose.evento.data} ${mose.evento.orario}`.trim())}</span></p>` : '')
    + `<details class="mose-d"${moseOpen ? ' open' : ''}><summary>${icon('chev', 'sm mose-chev')}<span>Barriere${riepilogo(mose.barriere || [])}</span></summary>`
    + `<ul class="mose-b">${groups.map(g => `<li><b>${esc(g.bocca.replace(/^Bocca di /i, ''))}</b><ul>${g.list.map(b => `<li data-sem="${esc(b.sem)}">${sema(b.sem)}<span class="mb-n">${esc(b.barriera.replace(/^Barriera di /i, ''))}</span><span class="mb-s">${esc(STATO_TXT[b.stato] || b.testo)}</span><span class="sr-only"> (${SEM_TXT[b.sem] || ''})</span></li>`).join('')}</ul></li>`).join('')}</ul></details>`
    + `<p class="tide-foot">${mose.aggiornato ? `Stato aggiornato dall'Autorità alle ${dayTag(mose.aggiornato)}${hm(mose.aggiornato)}` : 'Stato'}${mose.stale ? ' · <b>non aggiornato di recente</b>' : ''}. Il sollevamento si decide con previsioni oltre 110 cm; informazione indicativa.<br>Fonte:<a href="${esc(safeUrl(mose.fonte?.url || ''))}" target="_blank" rel="noopener noreferrer">${esc(mose.fonte?.nome || 'Autorità per la Laguna di Venezia')} · Operatività M.O.S.E.</a></p></section>`;
}
function position() {   // la scheda si allinea al suo pulsante, senza uscire dalla mappa
  const w = $('wrap').getBoundingClientRect(), b = btn.getBoundingClientRect(), g = 12, H = altezzaUtile(w);
  card.style.maxHeight = (H - 2 * g) + 'px';
  const h = card.offsetHeight;
  card.style.top = Math.max(g, Math.min(b.top - w.top - 8, H - h - g)) + 'px';
}
// marea più alta in un periodo (osservata o prevista), per il pianificatore: { cm, kind, ts } oppure null se il periodo esce dai dati
// (la previsione arriva a circa 18 ore). Usa i dati già scaricati per il pulsante della marea: nessuna richiesta in più.
export function peakIn(fromMs, toMs) {
  const c = data?.chart; if (!c || !(c.observed?.length || c.forecast?.length) || toMs < c.from || fromMs > c.to) return null;
  let best = null;
  const a = Math.max(fromMs, c.from), end = Math.min(toMs, c.to), ts = [];
  for (let t = a; t <= end; t += 5 * 60e3) ts.push(t);
  // v34: anche gli istanti dei dati e il termine dell'intervallo (prima un colmo tra due passi di 5 minuti poteva sfuggire di qualche cm)
  for (const q of [...(c.observed || []), ...fcFrom(c), ...(c.extremes || []).map(e => [e.ts])]) if (q[0] >= a && q[0] <= end) ts.push(q[0]);
  ts.push(end);
  for (const t of ts) { const v = valueAt(c, t); if (v && (!best || v.cm > best.cm)) best = { ...v, ts: t }; }
  return best;
}
// livello (osservato o previsto) a un istante, dai dati già scaricati: { cm, kind } o null (fuori dai dati: circa −6 / +18 ore)
// v34: età dell'ultimo dato se è vecchio (per dirlo anche nel pianificatore), altrimenti null
export const staleMin = () => (data?.stale && !data?.salvata ? Math.max(0, Math.round(+data.ageMin) || 0) : null);
export const levelAt = t => (data?.chart ? valueAt(data.chart, t) : null);
export const span = () => (data?.chart ? { from: data.chart.from, to: data.chart.to, now: data.chart.now } : null);
// ora scelta con il cursore del grafico, solo con la finestra della marea aperta (altrimenti null = adesso)
export const cursorAt = () => (!card.hidden && cursorT != null ? cursorT : null);
export const moseState = () => (mose && !mose.error ? mose.stato : data?.mose?.stato) || null;
export const isOpen = () => !card.hidden;
export function open(beforeOpen) {
  if (beforeOpen) beforeOpen();
  card.hidden = false; btn.setAttribute('aria-expanded', 'true'); render(); position(); card.focus({ preventScroll: true });
  load(); loadMose(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) { load(); loadMose(); } }, 60000);   // app in secondo piano: nessuna richiesta
}
export function close() { if (card.hidden) return; card.hidden = true; btn.setAttribute('aria-expanded', 'false'); clearInterval(timer); if (cursorT != null) window.dispatchEvent(new CustomEvent('tpl:tide-cursor')); }
export function init(beforeOpen) {
  seguiScheda(card, position);
  body.addEventListener('toggle', e => { if (e.target.classList?.contains('mose-d')) { moseOpen = e.target.open; position(); } }, true);   // «toggle» non risale: in cattura
  body.addEventListener('click', e => { if (e.target.closest('.tide-warn')) window.dispatchEvent(new CustomEvent('tpl:water-alert')); });
  btn.onclick = () => (card.hidden ? open(beforeOpen) : close());
  $('tide-close').onclick = () => { close(); btn.focus(); };
  window.addEventListener('resize', () => { if (!card.hidden) { render(); position(); } });
  load(); setInterval(() => { if (!document.hidden && card.hidden) load(); }, 300000);   // aggiorna anche il punto colorato sul pulsante
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !card.hidden) { load(); loadMose(); } });   // di nuovo visibile con la finestra aperta: dato fresco subito
}
