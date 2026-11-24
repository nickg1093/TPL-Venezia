// PROTEZIONI DELL'APP SUL TELEFONO (tutti i sistemi): barra dei messaggi di sistema, errori imprevisti, aggiornamento automatico,
// notifiche che non arriverebbero più.
//  · BARRA (#sysbar): un messaggio alla volta, con un'azione (es. «Riattiva», «Aggiorna», «Ricarica») e la X; ha la precedenza sul suggerimento di installazione;
//  · ERRORI IMPREVISTI: l'app resta usabile (ogni gestore è separato); 3 errori in un minuto → «Ricarica». Al server va solo un conteggio anonimo
//    (messaggio tecnico e punto del codice, niente dati dell'utente), al massimo 5 per apertura dell'app: serve a trovare e correggere i difetti;
//  · AGGIORNAMENTO: le app installate (iPhone, Android) restano aperte anche per giorni senza ricaricare la pagina. Al ritorno nell'app si controlla
//    se c'è una versione nuova (al massimo ogni 30 minuti, poche centinaia di byte); quando è pronta si ricarica da sola mentre l'app è in secondo
//    piano (nessuno la sta guardando: il viaggio in corso e il pianificatore si riaprono dalla memoria del telefono); se resta davanti, «Aggiorna»;
//  · NOTIFICHE: con avvisi attivi, se il telefono non può più riceverli (permesso tolto, iscrizione revocata dal sistema) lo si dice e si
//    riattivano con un tocco.
import { $, esc } from './util.js';
import * as Notify from './notify.js';

const bar = $('sysbar'), txt = $('sysbar-text'), act = $('sysbar-act'), cls = $('sysbar-close');
let cur = null;
const closed = new Set();                                               // messaggi chiusi con la X: non si ripropongono in questa apertura
export function show({ key, html, label = '', fn = null }) {
  if (!bar || closed.has(key)) return;
  cur = key; txt.innerHTML = html; act.hidden = !label; act.textContent = label;
  act.onclick = fn ? e => { e.stopPropagation(); fn(); } : null;
  bar.hidden = false; const sn = $('snack'); if (sn) sn.hidden = true;
}
export function hide(key) { if (bar && (!key || key === cur)) { bar.hidden = true; cur = null; } }
if (cls) cls.onclick = () => { if (cur) closed.add(cur); hide(); };

// ---- ERRORI IMPREVISTI ----
const VERSION = 'v34';
let sent = 0, recent = [];
const SKIP = /ResizeObserver loop|^Script error\.?$|AbortError|The operation was aborted|Failed to fetch|Load failed|NetworkError|network error|cancelled|annullat/i;
function report(kind, msg, where) {
  const m = String(msg || '').replace(/https?:\/\/\S+/g, '').replace(/\d{4,}/g, '#').slice(0, 160).trim();
  if (!m || SKIP.test(m)) return;
  if (where && /^(?:chrome|moz|safari|webkit)-extension:/.test(where)) return;     // estensioni del browser: non sono errori dell'app
  const now = Date.now(); recent = recent.filter(t => now - t < 60000); recent.push(now);
  if (recent.length >= 3) show({ key: 'errori', html: 'Qualcosa non ha funzionato come previsto. Se l\'app non risponde, ricaricala.', label: 'Ricarica', fn: () => location.reload() });
  if (sent >= 5) return; sent++;
  const body = JSON.stringify({ k: kind, m, w: String(where || '').replace(location.origin, '').replace(/\?.*$/, '').slice(0, 120), v: VERSION });
  try { if (!navigator.sendBeacon?.('/api/errore', new Blob([body], { type: 'application/json' }))) fetch('/api/errore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {}); } catch { /* facoltativo */ }
}
addEventListener('error', e => { if (e.error || e.message) report('errore', e.message || e.error?.message, `${e.filename || ''}:${e.lineno || 0}`); });
addEventListener('unhandledrejection', e => { const r = e.reason; report('promessa', r?.message || String(r || ''), String(r?.stack || '').split('\n').find(l => /\/js\//.test(l))?.trim() || ''); });

// ---- AGGIORNAMENTO AUTOMATICO ----
if ('serviceWorker' in navigator) {
  const had = !!navigator.serviceWorker.controller;                     // alla prima installazione «controllerchange» non è un aggiornamento
  let pending = false, lastCheck = Date.now();
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had || pending) return; pending = true;
    if (document.hidden) location.reload();
    else show({ key: 'versione', html: '<b>Nuova versione pronta.</b> Si aggiorna da sola quando lasci l\'app, oppure subito:', label: 'Aggiorna', fn: () => location.reload() });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (pending) location.reload(); return; }   // in secondo piano: nessuno la sta guardando
    if (Date.now() - lastCheck > 30 * 60e3) { lastCheck = Date.now(); navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {}); }
  });
}

// ---- NOTIFICHE CHE NON ARRIVEREBBERO PIÙ ----
let lastHealth = 0;
async function checkNotify() {
  if (Date.now() - lastHealth < 60000) return; lastHealth = Date.now();
  const h = await Notify.health().catch(() => 'ok');
  if (h === 'ok') { hide('notifiche'); return; }
  if (h === 'negato') show({ key: 'notifiche', html: '<b>Notifiche bloccate</b> per questo sito: gli avvisi attivi non arriverebbero. Riattivale dalle impostazioni del telefono o del browser.' });
  else show({ key: 'notifiche', html: '<b>Le notifiche non sono più attive</b> su questo dispositivo: gli avvisi attivi non arriverebbero.', label: 'Riattiva', fn: async () => {
    const r = await Notify.reactivate().catch(e => ({ ok: false, msg: e.message }));
    if (r.ok) { hide('notifiche'); show({ key: 'notifiche-ok', html: 'Notifiche riattivate: gli avvisi continuano.' }); setTimeout(() => hide('notifiche-ok'), 4000); }
    else show({ key: 'notifiche', html: esc(r.msg || 'Non è stato possibile riattivarle.') });
  } });
}
export function init() {
  setTimeout(checkNotify, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(checkNotify, 1500); });
}
