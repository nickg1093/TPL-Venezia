// INSTALLAZIONE COME APP + SERVICE WORKER.
// Chrome/Edge/Android: l'evento beforeinstallprompt abilita il pulsante (il browser mostra anche la sua icona "Installa" nella barra).
// iPhone/iPad (Safari) non hanno l'evento: si mostrano le istruzioni "Condividi > Aggiungi alla schermata Home".
import { $, icon } from './util.js';

const installBtn = $('install-btn'), snack = $('snack');
let evt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const snoozed = () => { try { return +localStorage.getItem('installSnooze') > Date.now(); } catch { return false; } };
const snooze = () => { try { localStorage.setItem('installSnooze', String(Date.now() + 14 * 864e5)); } catch { /* ignora */ } };
const sync = () => { installBtn.hidden = standalone() || !(evt || iOS); };
function showSnack(ios) {
  $('snack-text').innerHTML = ios ? `Su iPhone e iPad: tocca ${icon('share', 'sm')} <b>Condividi</b>, poi <b>Aggiungi alla schermata Home</b>.` : "Installa l'app sul telefono: si apre più in fretta, a schermo intero.";
  $('snack-install').hidden = ios; snack.hidden = false; clearTimeout(showSnack.t); showSnack.t = setTimeout(() => { snack.hidden = true; }, 20000);
}
async function doInstall() {
  if (evt) { snack.hidden = true; evt.prompt(); const r = await evt.userChoice.catch(() => null); evt = null; sync(); if (r && r.outcome === 'dismissed') snooze(); }
  else if (iOS) showSnack(true);
}
export function init() {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); evt = e; sync(); if (!snoozed() && !standalone()) showSnack(false); });
  window.addEventListener('appinstalled', () => { evt = null; snack.hidden = true; sync(); });
  installBtn.onclick = doInstall; $('snack-install').onclick = doInstall;
  $('snack-close').onclick = () => { snack.hidden = true; snooze(); };
  matchMedia('(display-mode: standalone)').addEventListener?.('change', sync);
  sync();
  if (iOS && !standalone() && !snoozed()) setTimeout(() => showSnack(true), 4000);   // un solo suggerimento, poi 14 giorni di pausa
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => { /* l'app funziona anche senza */ });
}
