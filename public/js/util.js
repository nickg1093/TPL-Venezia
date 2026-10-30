// FUNZIONI DI SUPPORTO CONDIVISE (nessuna dipendenza dalla mappa): testo sicuro, orari, icone, nomi dei mezzi, colori delle linee, etichette di stato.
export const $ = id => document.getElementById(id);

// Tutto ciò che viene da fuori (nomi di fermate, destinazioni, etichette dei mezzi) passa da esc() prima di entrare in innerHTML.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const p2 = n => String(n).padStart(2, '0');
export const nowSecs = () => { const d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); };
export const fmtSecs = s => `${p2(Math.floor(s / 3600) % 24)}:${p2(Math.floor(s % 3600 / 60))}:${p2(s % 60)}`;
export const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
export const hm = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

// ---------- ICONE ----------
// Un solo set (icons/sprite.svg), stesso stile ovunque. Niente emoji nel codice: per cambiare o aggiungere un simbolo si modifica lo sprite.
export const SPRITE = '/icons/sprite.svg';
export const icon = (name, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true" focusable="false"><use href="${SPRITE}#i-${name}"/></svg>`;
export const srcIcon = (src, cls = '') => icon(src === 'nav' ? 'ship' : 'bus', cls);                          // servizio: battello o autobus
export const isTram = (label, line) => /^tram/i.test(String(label ?? '').trim()) || /^T[12]$/i.test(String(line ?? '').trim());   // tram: etichetta TRAM_n oppure linee T1/T2
export const vehIconName = (src, label, line) => src === 'aut' ? (isTram(label, line) ? 'tram' : 'bus') : 'ship';   // mezzo: tram, autobus o battello (gli stessi simboli dei pulsanti dei servizi)
export const vehIcon = (src, label, cls = '', line = '') => icon(vehIconName(src, label, line), cls);

// ---------- NOMI DEI MEZZI ----------
// Il feed dà solo un'etichetta (es. "476", "Tram_12", "Lido di Venezia"): il prefisso dipende dal tipo di mezzo.
//  autobus: BUS n · tram: TRAM n · battelli: N/T (navi traghetto, riconosciute dal nome), M/B (numeri 1-99), M/S (100-300), altrimenti M/N
const NT = ['lido di venezia', 'ammiana', 'san nicolo', 'san nicolò', 'metamauco', 'marco polo', 'pellestrina'];
export function vehName(src, label) {
  const l = String(label ?? '').trim();
  if (!l) return '';
  if (src === 'aut') { const t = /^tram_(.+)$/i.exec(l); return t ? `TRAM ${t[1]}` : /^tram/i.test(l) ? l.toUpperCase() : `BUS ${l}`; }
  if (NT.some(v => l.toLowerCase().includes(v))) return `N/T ${l.toUpperCase()}`;
  if (/^\d+$/.test(l)) { const n = +l; return n <= 99 && n >= 1 ? `M/B ${n}` : n >= 100 && n <= 300 ? `M/S ${n}` : `mezzo ${n}`; }
  return `M/N ${l}`;
}

// ---------- COLORI DELLE LINEE ----------
// Luminanza relativa WCAG; il testo del badge è bianco o quasi nero a seconda di quale dà il contrasto MIGLIORE con il colore della linea
export function lum(hex) {
  const n = parseInt(hex.slice(1), 16), f = c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
  return .2126 * f((n >> 16) & 255) + .7152 * f((n >> 8) & 255) + .0722 * f(n & 255);
}
export function contrast(hex) {
  const L = lum(hex);
  return 1.05 / (L + .05) >= (L + .05) / (lum('#0f172a') + .05) ? '#ffffff' : '#0f172a';
}
// colori validi solo se #RRGGBB (il valore finisce in attributi style: niente altro deve passare); la linea 1 (bianca) ha un trattamento a parte
export function colorInfo(c, line = '') {
  if (String(line).trim() === '1') return { c: '#ffffff', ink: '#14232b', rail: '#ffffff', contrast: '#14232b' };
  const col = /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#0a6c8c', ink = contrast(col);
  return { c: col, ink, rail: col, contrast: ink };
}
export const badge = (line, color, src, extra = '') => {
  const k = colorInfo(color, line);
  return `<div class="bus${src === 'aut' ? ' aut' : ''}${extra}" style="--c:${k.c};--t:${k.ink};--b:${k.ink}">${esc(line)}</div>`;
};
export const ptHtml = (l, sm) => `<span class="pt${sm ? ' sm' : ''}">${esc((l || '').toUpperCase())}</span>`;

// ---------- ETICHETTE DI STATO DEL PASSAGGIO ----------
// Una sola funzione per pannello fermata e dettaglio corsa.
//  at = fermo in fermata · departing = sta partendo · approaching = in arrivo · departed = già partito · altrimenti conto alla rovescia in minuti
export function etaText(phase, expMs, inMin, live = true) {
  if (live) {
    if (phase === 'at') return 'In fermata';
    if (phase === 'departing') return 'In partenza';
    if (phase === 'approaching') return 'In arrivo';
    if (phase === 'arrived') return 'Arrivato';
    if (phase === 'departed') return 'Partito';
    if (expMs) { const s = (expMs - Date.now()) / 1000; return s <= 45 ? 'In arrivo' : `tra ${Math.max(1, Math.round(s / 60))} min`; }
  }
  return inMin <= 0 ? 'In partenza' : `tra ${inMin} min`;
}
// aggiorna ogni secondo i "tra N min" senza aspettare il server (le fasi fisse non cambiano)
const FIXED = new Set(['at', 'departing', 'approaching', 'arrived', 'departed']);
export function tickEta() {
  document.querySelectorAll('[data-exp]').forEach(el => {
    const ph = el.dataset.ph; if (!el.dataset.exp || FIXED.has(ph)) return;
    el.textContent = etaText(ph, +el.dataset.exp, 0);
  });
}

// ritardo -> classe e testo (stessa regola ovunque)
// Stato del passaggio, UNA formula per tutta l'app (pannello fermata, pannello mezzo, intestazione): breve ma esplicita; long = per i lettori di schermo
export const delayInfo = d => d >= 1 ? { cls: 'late', txt: `ritardo ${d} min`, long: `in ritardo di ${d} minuti` } : d <= -1 ? { cls: 'early', txt: `anticipo ${-d} min`, long: `in anticipo di ${-d} minuti` } : { cls: 'ok', txt: 'in orario', long: 'in orario' };

// Lettura JSON dal server. Una risposta "troppe richieste" (429, testo semplice) non è un errore dei dati: si segnala con busy = true
// e il chiamante tiene a schermo ciò che già mostra e riprova al giro successivo.
// Richieste in corso: se una dura più di BUSY_MS compare la barra di caricamento (onBusy), così chi aspetta vede sempre che l'app sta lavorando.
const BUSY_MS = 350;
let pending = 0, busyTimer = null, busyFn = null;
export const onBusy = fn => { busyFn = fn; };
const busyDelta = d => {
  pending = Math.max(0, pending + d);
  if (pending > 0 && !busyTimer) busyTimer = setTimeout(() => { busyTimer = null; if (pending > 0) busyFn?.(true); }, BUSY_MS);
  if (pending === 0) { clearTimeout(busyTimer); busyTimer = null; busyFn?.(false); }
};
// cache: 'no-cache' = il browser rivalida (ETag): se il server risponde 304 riusa la copia già scaricata (meno dati, stessi contenuti)
export async function api(url, { cache = 'no-store' } = {}) {
  busyDelta(1);
  try {
    const r = await fetch(url, { cache });
    if (r.status === 409) { const e = new Error('carico gli orari della data scelta…'); e.loading = true; throw e; }
    if (r.status === 429) { const e = new Error('server occupato, riprovo'); e.busy = true; throw e; }
    let d; try { d = await r.json(); } catch { throw new Error(`risposta non valida (HTTP ${r.status})`); }
    return d;
  } finally { busyDelta(-1); }
}
