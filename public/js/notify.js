// AVVISO DI ARRIVO DI UNA CORSA (notifiche). Si attiva solo con un tocco sulla campanella del pannello della corsa (aperta da una fermata).
//  · Web Push (Android, computer, iPhone con l'app installata): notifiche di sistema anche ad app chiusa;
//  · senza Web Push (es. iPhone da Safari senza installare l'app): l'app, finché resta aperta, chiede i messaggi al server e li mostra lei;
//  · il permesso lo chiede il sistema; se è negato si spiega come riattivarlo. Suoni, vibrazione, "non disturbare": impostazioni del telefono.
// Gli avvisi attivi stanno nella memoria del dispositivo (campanella accesa anche riaprendo l'app) e scadono da soli.
import { api } from './util.js';

const KEY = 'tpl.watches', LIFE = 3 * 3600e3;
let list = [], pollTimer = null, onChange = () => {}, onFront = () => {};
// La memoria del browser non è affidabile (può essere stata modificata): ogni avviso si ricostruisce campo per campo, con tipi e lunghezze
// controllati, prima di usarlo nell'interfaccia.
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
function clean(w) {
  if (!w || typeof w !== 'object') return null;
  const lead = Number(w.lead), until = Number(w.until);
  if (typeof w.id !== 'string' || !w.id || !Number.isInteger(lead) || lead < 1 || lead > 60 || !Number.isFinite(until)) return null;
  const st = w.style, hex = v => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
  const style = st && (st.shape === 'tile' || st.shape === 'circle') && hex(st.bg) && hex(st.fg) ? { shape: st.shape, bg: hex(st.bg), fg: hex(st.fg) } : null;
  const ruolo = ['esci', 'cambio', 'scendi'].includes(w.ruolo) ? w.ruolo : null, viaggio = ruolo && typeof w.viaggio === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(w.viaggio) ? w.viaggio : null;
  return { id: str(w.id, 80), token: str(w.token, 200), mode: w.mode === 'poll' ? 'poll' : 'push', trip: str(w.trip, 120), stop: str(w.stop, 80),
    stopName: str(w.stopName, 120), lead, line: str(w.line, 20), headsign: str(w.headsign, 120), until, style,
    ...(viaggio ? { ruolo, viaggio, walk: Number.isInteger(w.walk) && w.walk >= 0 && w.walk <= 60 ? w.walk : 0 } : {}) };
}
function load() { try { const d = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(d) ? d.map(clean).filter(w => w && w.until > Date.now()).slice(0, 50) : []; } catch { return []; } }
// letti DOPO aver definito str/clean (prima, dalla v24 alla v30, la lettura falliva in silenzio e la lista ripartiva vuota a ogni apertura)
list = load();
function save() { list = list.filter(w => w.until > Date.now()); try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* solo in memoria */ } onChange(); }
// onFront(msg): messaggio arrivato con l'app in primo piano (lo mostra l'app, non il sistema)
export const init = (fn, front) => {
  onChange = fn || onChange; onFront = front || onFront; startPolling();
  // avvisi attivi ripresentati al server (che dopo un riavvio o un aggiornamento li avrebbe persi): all'apertura, al ritorno in primo piano,
  // al ritorno della rete e quando il flusso dei mezzi si ricollega (app.js)
  setTimeout(() => restoreAll(true), 2500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) restoreAll(); });
  addEventListener('online', () => restoreAll(true));
};
// -> nulla; gli avvisi che il server dichiara scaduti o non più validi (corsa non più negli orari) si tolgono anche qui
let lastRestore = 0;
export async function restoreAll(force = false) {
  const ws = live(); if (!ws.length) return;
  if (!force && Date.now() - lastRestore < 60000) return; lastRestore = Date.now();
  let sub = null;
  try { const reg = await ready(); sub = reg.pushManager ? await reg.pushManager.getSubscription() : null; } catch { sub = null; }
  // prima gli avvisi del viaggio guidato (in ordine), poi quelli singoli; il server ne accetta 8 per volta
  const items = [...ws.filter(w => w.viaggio), ...ws.filter(w => !w.viaggio)].filter(w => w.mode === 'poll' || sub).slice(0, 8).map(w => ({ id: w.id, token: w.token, trip: w.trip, stop: w.stop,
    stopName: w.stopName, lead: w.lead, style: w.style || null, created: w.until - LIFE, sub: w.mode === 'push' && sub ? sub.toJSON() : null,
    ...(w.viaggio ? { ruolo: w.ruolo, viaggio: w.viaggio, walk: w.walk } : {}) }));
  if (!items.length) return;
  const r = await post('/api/watch/restore', { items }).catch(() => null);
  for (const [id, st] of Object.entries(r?.stato || {})) if (st === 'scaduto' || st === 'non valido') ended(id);
}
// gli avvisi del viaggio guidato hanno la loro schermata («In viaggio»): campanelle ed elenco mostrano solo quelli singoli
const live = () => list.filter(w => w.until > Date.now());
const all0 = () => live().filter(w => !w.viaggio);
export const all = () => all0().slice();
export const find = (trip, stop) => all0().find(w => w.trip === trip && w.stop === stop) || null;
export const ofJourney = v => live().filter(w => w.viaggio === v);
export const supported = () => 'Notification' in window && 'serviceWorker' in navigator;
const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
const b64ToBytes = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const sameKey = (buf, bytes) => { if (!buf) return false; const a = new Uint8Array(buf); return a.length === bytes.length && a.every((x, i) => x === bytes[i]); };
const ready = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, ko) => setTimeout(() => ko(new Error('service worker non pronto')), 5000))]);

// permesso chiesto DENTRO il tocco (Safari lo concede solo durante un gesto): da chiamare come prima cosa nel gestore del clic
export const askPermission = () => (!supported() ? Promise.resolve('unsupported') : Notification.permission === 'default' ? Notification.requestPermission().catch(() => 'default') : Promise.resolve(Notification.permission));
export const INSTALL_IOS = 'Su iPhone e iPad le notifiche funzionano con l\'app installata: tocca Condividi, poi «Aggiungi alla schermata Home», e apri l\'app da lì.';
export const needsInstall = () => iOS && !standalone() && !supported();
// permesso e iscrizione Web Push (una volta sola, anche per un viaggio con più avvisi) -> { ok: true, sub|null } oppure { ok: false, msg }
async function prepare() {
  if (!supported()) return { ok: false, msg: iOS && !standalone() ? INSTALL_IOS : 'Questo browser non supporta le notifiche.' };
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, msg: 'Notifiche bloccate per questo sito. Per riceverle consentile dalle impostazioni del browser (icona accanto all\'indirizzo) e, se serve, da quelle del telefono.' };
  let sub = null;
  try {
    const reg = await ready();
    if ('PushManager' in window && reg.pushManager) {
      const { key } = await api('/api/push-key'), bytes = b64ToBytes(key);
      sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub.options?.applicationServerKey, bytes)) { await sub.unsubscribe().catch(() => {}); sub = null; }   // il server ha chiavi nuove
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    }
  } catch { sub = null; }                                                    // niente Web Push: si usa l'app aperta
  return { ok: true, sub };
}
const POLL_NOTE = 'Questo dispositivo non riceve notifiche ad app chiusa: ti avviso finché l\'app resta aperta.';
// -> { ok, mode: 'push'|'poll', note? } oppure { ok: false, msg }
export async function start({ trip, stop, stopName, lead, line, headsign, style }) {
  const p = await prepare(); if (!p.ok) return p;
  const sub = p.sub, old = find(trip, stop); if (old) await stopWatch(old, true);
  const r = await post('/api/watch', { sub: sub ? sub.toJSON() : null, trip, stop, stopName, lead, style });
  list.push({ id: r.id, token: r.token, mode: r.mode, trip, stop, stopName, lead, line, headsign, until: Date.now() + LIFE, style: style || null }); save(); startPolling();
  return { ok: true, mode: r.mode, note: r.mode === 'poll' ? POLL_NOTE : null };
}
// SALUTE DELLE NOTIFICHE: avvisi attivi in modalità push ma il telefono non può più riceverli (permesso tolto dalle impostazioni, iscrizione
// revocata dal sistema, es. Safari dopo push senza notifica, o rinnovata senza avviso). -> 'ok' | 'perso' (si riattiva con un tocco) | 'negato'
export async function health() {
  const ws = live().filter(w => w.mode === 'push'); if (!ws.length || !supported()) return 'ok';
  if (Notification.permission === 'denied') return 'negato';
  if (Notification.permission !== 'granted') return 'perso';
  try { const reg = await ready(); const sub = reg.pushManager ? await reg.pushManager.getSubscription() : null; return sub ? 'ok' : 'perso'; } catch { return 'ok'; }
}
// riattivazione: DENTRO il tocco (Safari concede permesso e iscrizione solo durante un gesto); gli avvisi attivi passano alla nuova iscrizione
export async function reactivate() {
  const p = await prepare(); if (!p.ok) return p;
  if (!p.sub) return { ok: false, msg: POLL_NOTE };
  await restoreAll(true);
  return { ok: true };
}
// VIAGGIO GUIDATO: un avviso per ogni momento del viaggio (esci, cambio, scendi), con un identificativo comune: le notifiche si sostituiscono
// l'una con l'altra invece di accumularsi. items: [{ trip, stop, stopName, lead, ruolo, walk, line, headsign, style }] in ordine di tempo.
// Si attivano uno dopo l'altro (niente raffiche verso il server); quelli che il server rifiuta (corsa non più negli orari, troppi avvisi) si saltano.
// -> { ok, mode, made, total, note? } oppure { ok: false, msg }
export async function startJourney(viaggio, items) {
  const p = await prepare(); if (!p.ok) return p;
  await stopJourney(viaggio, true);
  let made = 0, mode = p.sub ? 'push' : 'poll', lastErr = '';
  for (const it of items.slice(0, 8)) {
    try {
      const r = await post('/api/watch', { sub: p.sub ? p.sub.toJSON() : null, trip: it.trip, stop: it.stop, stopName: it.stopName, lead: it.lead, style: it.style || null, ruolo: it.ruolo, viaggio, walk: it.walk || 0 });
      list.push({ id: r.id, token: r.token, mode: r.mode, trip: it.trip, stop: it.stop, stopName: it.stopName, lead: it.lead, line: it.line, headsign: it.headsign, until: Date.now() + LIFE,
        style: it.style || null, ruolo: it.ruolo, viaggio, walk: it.walk || 0 });
      mode = r.mode; made++;
    } catch (e) { lastErr = e.message; }
  }
  save(); startPolling();
  if (!made) return { ok: false, msg: lastErr ? `Avvisi non attivati (${lastErr}). Il viaggio resta visibile qui, con l'app aperta.` : 'Avvisi non attivati.' };
  return { ok: true, mode, made, total: Math.min(items.length, 8), note: mode === 'poll' ? POLL_NOTE : null };
}
export async function stopJourney(viaggio, quiet = false) {
  const ws = ofJourney(viaggio); if (!ws.length) return;
  list = list.filter(w => w.viaggio !== viaggio); save();
  const jobs = ws.map(w => post('/api/watch/cancel', { id: w.id, token: w.token }).catch(() => {}));
  if (!quiet) await Promise.all(jobs);
}
export async function stopWatch(w, quiet = false) {
  list = list.filter(x => x.id !== w.id); save();
  if (!quiet) await post('/api/watch/cancel', { id: w.id, token: w.token }).catch(() => {});
  else post('/api/watch/cancel', { id: w.id, token: w.token }).catch(() => {});
}
export const ended = id => { if (list.some(w => w.id === id)) { list = list.filter(w => w.id !== id); save(); } };

// canale "app aperta": ogni 20 s i messaggi in attesa, mostrati come notifiche di sistema con la stessa grafica (via service worker)
function startPolling() {
  if (pollTimer || !list.some(w => w.mode === 'poll')) return;
  pollTimer = setInterval(async () => {
    const ws = list.filter(w => w.mode === 'poll' && w.until > Date.now()); if (!ws.length) { clearInterval(pollTimer); pollTimer = null; return; }
    // una richiesta sola per tutti gli avvisi (al massimo 8: gli altri al giro dopo)
    const turn = ws.slice(0, 8);
    try {
      const r = await fetch(`/api/watch/poll?ids=${turn.map(w => encodeURIComponent(w.id) + '.' + encodeURIComponent(w.token)).join(',')}`, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      for (const w of turn) {
        const x = d.r?.[w.id];
        if (!x) { ended(w.id); continue; }
        for (const m of x.messages || []) {
          if (document.visibilityState === 'visible' && document.hasFocus()) { onFront(m); continue; }        // app davanti: lo mostra l'app
          const reg = await ready().catch(() => null); if (reg && Notification.permission === 'granted') reg.active?.postMessage({ type: 'tpl-notify', msg: m });
        }
        if (!x.active) ended(w.id);
      }
    } catch { /* rete assente: si riprova */ }
  }, 20000);
}
