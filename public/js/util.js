// FUNZIONI DI SUPPORTO CONDIVISE (nessuna dipendenza dalla mappa): testo sicuro, orari, icone, nomi dei mezzi, colori delle linee, etichette di stato.
export const $ = id => document.getElementById(id);

// Tutto ciò che viene da fuori (nomi di fermate, destinazioni, etichette dei mezzi) passa da esc() prima di entrare in innerHTML.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const p2 = n => String(n).padStart(2, '0');
// v34: ORA DI VENEZIA anche se il telefono è su un altro fuso (turista che pianifica da casa, fuso impostato a mano): orari, date e
// orologio dell'app sono sempre quelli di Venezia, come gli orari ACTV.
const ROME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const romeP = (ms = Date.now()) => {
  const o = {}; for (const x of ROME.formatToParts(new Date(ms))) o[x.type] = x.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, iso: `${o.year}-${o.month}-${o.day}` };
};
export const nowSecs = () => { const r = romeP(); return r.h * 3600 + r.mi * 60 + r.s; };
export const fmtSecs = s => `${p2(Math.floor(s / 3600) % 24)}:${p2(Math.floor(s % 3600 / 60))}:${p2(s % 60)}`;
export const localDate = () => romeP().iso;
export const hm = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Rome' });
// data completa «25/11/2026» (ora di Venezia)
export const dataCompleta = ms => new Date(ms).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Rome' });

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
const NT = ['lido di venezia', 'ammiana', 'san nicolo', 'san marco', 'metamauco', 'marco polo', 'pellestrina'];
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
    if (expMs) { const s = (expMs - Date.now()) / 1000; return s <= 45 ? 'In arrivo' : `Tra ${Math.max(1, Math.round(s / 60))} min`; }
  }
  return inMin <= 0 ? 'In partenza' : `Tra ${inMin} min`;
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
export const delayInfo = d => d >= 1 ? { cls: 'late', txt: `In ritardo di ${d} min`, long: `in ritardo di ${d} minuti` } : d <= -1 ? { cls: 'early', txt: `In anticipo di ${-d} min`, long: `in anticipo di ${-d} minuti` } : { cls: 'ok', txt: 'In orario', long: 'in orario' };

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
// NUOVI TENTATIVI LIMITATI per le risposte «in caricamento» (409) e «occupato» (503/429): attese crescenti (3 s, poi 6 s… fino a 15 s),
// al massimo 40 tentativi (~5 minuti). Mai un ciclo senza fine: un server in difficoltà non viene tempestato di richieste.
const tries = new Map();
export function ritenta(key, fn, ms = 3000, max = 40) {
  const n = (tries.get(key) || 0) + 1; tries.set(key, n);
  if (n > max) { tries.delete(key); return false; }
  busyDelta(1);                                                   // anche durante l'attesa tra un tentativo e l'altro la barra di caricamento resta
  setTimeout(() => { busyDelta(-1); fn(); }, Math.min(ms * (1 + Math.floor((n - 1) / 10)), 15000));
  return true;
}
export const riuscito = key => { tries.delete(key); };
export const NON_ORA = 'orari della data scelta non disponibili ora, riprova tra qualche minuto';
// cache: 'no-cache' = il browser rivalida (ETag): se il server risponde 304 riusa la copia già scaricata (meno dati, stessi contenuti)
export async function api(url, { cache = 'no-store' } = {}) {
  busyDelta(1);
  try {
    const r = await fetch(url, { cache });
    if (r.status === 409) { const e = new Error('carico gli orari della data scelta…'); e.loading = true; throw e; }
    if (r.status === 429 || r.status === 503) { const e = new Error('server occupato, riprovo'); e.busy = true; throw e; }
    let d; try { d = await r.json(); } catch { throw new Error(`risposta non valida (HTTP ${r.status})`); }
    return d;
  } finally { busyDelta(-1); }
}
// ultimo rilevamento del mezzo (pannello della corsa, app.js): «Posizione aggiornata N secondi/minuti fa», «dato non recente» da 3 minuti
export function etaPosizione(ts, now, old = false) {                 // testo e stato da ora del rilevamento (ms) e adesso (ms)
  if (!Number.isFinite(ts) || ts > now + 60e3) return null;           // ora futura (orologio del mezzo sbagliato): non si mostra
  const sec = Math.max(0, Math.floor((now - ts) / 1000)), min = Math.floor(sec / 60), vecchio = !!old || sec >= 180;
  const quanto = sec < 60 ? (sec === 1 ? '1 secondo fa' : `${sec} secondi fa`) : min < 60 ? (min === 1 ? '1 minuto fa' : `${min} minuti fa`) : 'più di un\'ora fa';
  return { txt: `Posizione aggiornata ${quanto}${vecchio ? ' · dato non recente' : ''}`, vecchio };
}
// SCHEDE AGGANCIATE A UN PULSANTE (preferiti, marea, avvisi, menu della mappa): la posizione si ricalcola ogni volta che cambia l'altezza
// della scheda (schede Fermate/Percorsi, modifica, dati arrivati dopo), lo schermo (rotazione, finestra) o la parte visibile (tastiera
// aperta: visualViewport). Così la scheda non resta più alta o più bassa del dovuto e non esce dallo schermo. fn() riposiziona; si chiama
// al più una volta per fotogramma e solo con la scheda aperta.
export function seguiScheda(card, fn) {
  let q = 0;
  const go = () => { if (q || card.hidden) return; q = requestAnimationFrame(() => { q = 0; if (!card.hidden) fn(); }); };
  try { new ResizeObserver(go).observe(card); } catch { /* browser vecchio: restano gli eventi qui sotto */ }
  addEventListener('resize', go); addEventListener('orientationchange', go);
  globalThis.visualViewport?.addEventListener('resize', go);
  return go;
}
// altezza utile per una scheda dentro #wrap: la parte di mappa visibile (con la tastiera aperta è più bassa della finestra)
export function altezzaUtile(w) {
  const vv = globalThis.visualViewport, vis = vv ? vv.height + vv.offsetTop - w.top : innerHeight - w.top;
  return Math.max(120, Math.min(w.height, vis));
}
