// AVVISO DI ARRIVO DI UNA CORSA (notifiche). Si attiva solo con un tocco sulla campanella del pannello della corsa (aperta da una fermata).
//  · Web Push (Android, computer, iPhone con l'app installata): notifiche di sistema anche ad app chiusa;
//  · senza Web Push (es. iPhone da Safari senza installare l'app): l'app, finché resta aperta, chiede i messaggi al server e li mostra lei;
//  · il permesso lo chiede il sistema; se è negato si spiega come riattivarlo. Suoni, vibrazione, "non disturbare": impostazioni del telefono.
// Gli avvisi attivi stanno nella memoria del dispositivo (campanella accesa anche riaprendo l'app) e scadono da soli.
import { api } from './util.js';

const KEY = 'tpl.watches', LIFE = 3 * 3600e3;
let list = load(), pollTimer = null, onChange = () => {}, onFront = () => {};
function load() { try { const d = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(d) ? d.filter(w => w && w.id && w.until > Date.now()) : []; } catch { return []; } }
function save() { list = list.filter(w => w.until > Date.now()); try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* solo in memoria */ } onChange(); }
// onFront(msg): messaggio arrivato con l'app in primo piano (lo mostra l'app, non il sistema)
export const init = (fn, front) => { onChange = fn || onChange; onFront = front || onFront; startPolling(); };
export const find = (trip, stop) => list.find(w => w.trip === trip && w.stop === stop && w.until > Date.now()) || null;
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

// -> { ok, mode: 'push'|'poll', note? } oppure { ok: false, msg }
export async function start({ trip, stop, stopName, lead, line, headsign, style }) {
  if (!supported()) return { ok: false, msg: iOS && !standalone() ? 'Su iPhone e iPad le notifiche funzionano con l\'app installata: tocca Condividi, poi «Aggiungi alla schermata Home», e apri l\'app da lì.' : 'Questo browser non supporta le notifiche.' };
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
  const old = find(trip, stop); if (old) await stopWatch(old, true);
  const r = await post('/api/watch', { sub: sub ? sub.toJSON() : null, trip, stop, stopName, lead, style });
  list.push({ id: r.id, token: r.token, mode: r.mode, trip, stop, stopName, lead, line, headsign, until: Date.now() + LIFE }); save(); startPolling();
  return { ok: true, mode: r.mode, note: r.mode === 'poll' ? 'Questo dispositivo non riceve notifiche ad app chiusa: ti avviso finché l\'app resta aperta.' : null };
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
    const ws = list.filter(w => w.mode === 'poll'); if (!ws.length) { clearInterval(pollTimer); pollTimer = null; return; }
    for (const w of ws) {
      try {
        const r = await fetch(`/api/watch/poll?id=${encodeURIComponent(w.id)}&token=${encodeURIComponent(w.token)}`, { cache: 'no-store' });
        if (r.status === 404) { ended(w.id); continue; }
        const d = await r.json();
        for (const m of d.messages || []) {
          if (document.visibilityState === 'visible' && document.hasFocus()) { onFront(m); continue; }        // app davanti: lo mostra l'app
          const reg = await ready().catch(() => null); if (reg && Notification.permission === 'granted') reg.active?.postMessage({ type: 'tpl-notify', msg: m });
        }
        if (!d.active) ended(w.id);
      } catch { /* rete assente: si riprova */ }
    }
  }, 20000);
}
