// SCHERMO INTERO (v33.5), scelta dell'utente in Informazioni. Nasconde le barre del sistema (in alto ora e batteria; in basso tasti Android o
// barra dei gesti) dove il sistema lo permette, con la Fullscreen API: Android (Chrome, Edge, Samsung Internet, anche app installata), computer,
// iPad (Safari 16.4+). Su iPhone il sistema NON lo permette alle pagine web né alle app installate dalla schermata Home: l'opzione non compare
// e una nota lo spiega (l'app usa già tutto lo schermo concesso, fino ai bordi, con viewport-fit=cover e le distanze di sicurezza).
// Perché non «display: fullscreen» nel manifest: varrebbe per sempre e per tutti (anche sul computer), non si potrebbe spegnere dall'app e
// Android lo applica solo all'aggiornamento dell'app installata, a distanza di giorni. Così invece è una scelta reversibile e immediata.
//   · il sistema richiede un tocco per entrare: all'apertura dell'app (scelta attiva) si rientra al primo tocco;
//   · le barre restano richiamabili con i gesti normali (scorrendo dal bordo); il tasto o gesto «indietro» di Android esce dallo schermo
//     intero (comportamento del sistema): si rientra da soli al tocco successivo, finché la scelta è attiva;
//   · nessun tocco su campi di testo fa rientrare (la tastiera non deve saltare); rotazione, tastiera e barre che compaiono cambiano la
//     dimensione della finestra: theme-init.js e la mappa si ricalcolano con l'evento resize (anche dopo ogni cambio di stato).
const KEY = 'tpl.schermo';
const d = document, el = d.documentElement;
const fsEl = () => d.fullscreenElement || d.webkitFullscreenElement || null;
export const supported = () => !!(d.fullscreenEnabled || d.webkitFullscreenEnabled) && !!(el.requestFullscreen || el.webkitRequestFullscreen);
const iPhone = /iphone|ipod/i.test(navigator.userAgent);
export const wanted = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
let busy = false;
function enter() {
  if (!supported() || fsEl() || busy || d.hidden) return;
  busy = true;
  try {
    const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen();
    Promise.resolve(p).catch(() => {}).finally(() => { busy = false; });
  } catch { busy = false; }
}
function leave() { try { if (fsEl()) (d.exitFullscreen || d.webkitExitFullscreen).call(d)?.catch?.(() => {}); } catch { /* ignora */ } }
const typing = t => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');
let onChange = () => {};
function changed() {
  // le barre comparse o sparite cambiano lo spazio: si rimisura subito e dopo l'animazione del sistema
  const kick = () => window.dispatchEvent(new Event('resize'));
  requestAnimationFrame(kick); setTimeout(kick, 350);
  onChange(!!fsEl());
}
export function set(on) {
  try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* solo per questa apertura */ }
  if (on) enter(); else leave();
}
export const active = () => !!fsEl();
export function init(opts = {}) {
  onChange = opts.onChange || onChange;
  d.addEventListener('fullscreenchange', changed); d.addEventListener('webkitfullscreenchange', changed);
  // rientro al tocco (pointerup e tasti attivano il permesso del sistema; pointerdown al tocco no)
  const again = e => { if (wanted() && !fsEl() && !typing(e.target) && !e.target?.closest?.('[data-fs]')) enter(); };
  addEventListener('pointerup', again, { capture: true, passive: true });
  addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') again(e); }, { capture: true, passive: true });
  return { supported: supported(), iPhone };
}
