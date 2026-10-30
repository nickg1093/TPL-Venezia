// AVVISO DI ARRIVO DI UNA CORSA A UNA FERMATA: regole (funzione pura, provata nei test) e ciclo di controllo.
// Due canali: "push" (notifica del sistema anche ad app chiusa) e "poll" (dispositivi senza Web Push, es. iPhone senza app installata:
// l'app aperta chiede i messaggi e li mostra lei). Le regole sono le stesse; vedi push.js per l'elenco dei messaggi.
const crypto = require('crypto');
const cal = require('./calendar');
const push = require('./push');

const MAX_PER_IP = 6, MAX_TOTAL = 1000, LIFE_MS = 3 * 3600e3, STEP_MS = 15000, DELAY_STEP = 3, UPDATE_GAP_MS = 4 * 60e3;
const W = new Map();
const hm = ms => { const s = cal.romeParts(ms).secs; return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`; };
const dly = d => (d == null || Math.abs(d) < 1 ? '' : d > 0 ? ` · ritardo ${d} min` : ` · anticipo ${-d} min`);

// Prossimo messaggio per una corsa (al massimo uno a ogni controllo). w: stato dell'avviso, d: dettaglio della corsa (live.tripDetail).
// -> { msg?: {kind, title, body, silent}, end?: true }
function step(w, d, now = Date.now()) {
  // titolo breve, senza emoji: la linea (con la sua mattonella o il suo cerchio come immagine della notifica) e la destinazione
  const title = `Linea ${d.trip.line}${d.trip.headsign ? ' → ' + d.trip.headsign : ''}`, stop = w.stopName;
  const out = (kind, body, silent, end = false, ttl = 120) => ({ msg: { kind, title, body, silent, line: d.trip.line, ttl }, end });
  if (w.k == null || w.k >= d.stops.length || d.stops[w.k].id !== w.stop) {     // fermata nella corsa: la prima non ancora passata (le circolari la toccano due volte)
    let k = d.stops.findIndex(s => s.id === w.stop && s.state !== 'passed'); if (k < 0) k = d.stops.findIndex(s => s.id === w.stop);
    if (k < 0) return { end: true }; w.k = k;
  }
  const s = d.stops[w.k];
  if (d.cancelled) return out('cancel', `Corsa soppressa: non passerà da ${stop}.`, false, true, 900);
  if (s.skipped) return out('skip', `Il mezzo non ferma a ${stop} (fermata saltata).`, false, true, 900);
  if (s.state === 'passed') return w.sent.arr ? { end: true } : out('passed', `Passato da ${stop}.`, true, true);
  const eta = s.expMs ?? now + (s.inMin ?? 0) * 60000, mins = Math.max(0, Math.round((eta - now) / 60000));
  const est = d.live && d.detected !== false ? '' : ' (da orario)', when = `alle ${hm(eta)}${dly(s.delay)}${est}`;
  if (now - w.created > LIFE_MS || eta < now - 10 * 60e3) return { end: true };
  const here = s.state === 'at' || s.phase === 'approaching' || mins <= 1;
  if (!w.sent.arr && here && (w.sent.lead || w.lead <= 2 || mins <= 1)) { w.sent.lead = w.sent.conf = w.sent.arr = true; return out('arrive', `In arrivo ora a ${stop}.`, false, true, 90); }
  if (!w.sent.lead && mins <= w.lead) { w.sent.lead = w.sent.conf = true; w.lastDelay = s.delay; w.lastAt = now; return out('lead', `Arriva tra ${mins} min a ${stop}, ${when}.`, false, false, Math.max(60, Math.min(900, Math.round((eta - now) / 1000)))); }
  if (!w.sent.conf) { w.sent.conf = true; w.lastDelay = s.delay; w.lastAt = now; return out('conf', `Ti avviso ${w.lead} min prima dell'arrivo a ${stop}. Previsto ${when}.`, true); }
  if (!w.sent.lead && s.delay != null && w.lastDelay != null && Math.abs(s.delay - w.lastDelay) >= DELAY_STEP && now - w.lastAt >= UPDATE_GAP_MS) {
    w.lastDelay = s.delay; w.lastAt = now; return out('update', `Ora previsto a ${stop} ${when}.`, true);
  }
  return {};
}

// ---- registro degli avvisi ----
let vapid = null, subject = 'mailto:noreply@example.invalid', getTrip = null, timer = null;
function init({ tripDetail, contact }) { vapid = push.loadVapid(); getTrip = tripDetail; if (contact) subject = contact; if (!vapid.fromEnv) console.log('push: chiavi VAPID temporanee (imposta VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY per conservarle tra i riavvii)'); }
const publicKey = () => (vapid ? push.b64u(vapid.pub) : null);

function create({ sub, src, tid, stop, stopName, lead, ip, url, style }) {
  const now = Date.now();
  for (const [k, w] of W) if (now - w.created > LIFE_MS) W.delete(k);
  if (W.size >= MAX_TOTAL) { const e = new Error('troppi avvisi attivi, riprova più tardi'); e.code = 429; throw e; }
  if ([...W.values()].filter(w => w.ip === ip).length >= MAX_PER_IP) { const e = new Error('troppi avvisi attivi da questo dispositivo'); e.code = 429; throw e; }
  // stesso dispositivo, stessa corsa e fermata: si sostituisce
  for (const [k, w] of W) if (w.src === src && w.tid === tid && w.stop === stop && ((sub && w.sub?.endpoint === sub.endpoint) || (!sub && w.ip === ip && !w.sub))) W.delete(k);
  const id = crypto.randomBytes(9).toString('base64url'), token = crypto.randomBytes(18).toString('base64url');
  const w = { id, token, sub: sub || null, src, tid, stop, stopName, lead, ip, url, style: style || null, created: now, sent: {}, queue: [], k: null, lastDelay: null, lastAt: 0 };
  W.set(id, w); ensureLoop(); tick(w).catch(() => {});
  return { id, token, mode: sub ? 'push' : 'poll' };
}
const find = (id, token) => { const w = W.get(String(id)); return w && crypto.timingSafeEqual(Buffer.from(w.token), Buffer.from(String(token).padEnd(w.token.length).slice(0, w.token.length))) ? w : null; };
function cancel(id, token) { const w = find(id, token); if (w) W.delete(w.id); return !!w; }
// canale "poll": messaggi in attesa (e stato) per l'app aperta
function poll(id, token) { const w = find(id, token); if (!w) return null; const q = w.queue.splice(0); if (w.ended) W.delete(w.id); return { active: !w.ended, messages: q }; }

async function deliver(w, msg) {
  const payload = { ...msg, tag: 'tpl-trip-' + w.id, url: w.url, id: w.id, token: w.token, ts: Date.now(), src: w.src, line: msg.line, style: w.style };
  if (!w.sub) { w.queue.push(payload); if (w.queue.length > 5) w.queue.shift(); return; }
  const body = push.encrypt(JSON.stringify(payload), w.sub.keys.p256dh, w.sub.keys.auth);
  const res = await fetch(w.sub.endpoint, { method: 'POST', body, signal: AbortSignal.timeout(10000),
    // TTL = per quanto il messaggio ha ancora senso (un preavviso consegnato dopo l'arrivo è inutile); Topic = un solo messaggio in attesa per corsa:
    // se il telefono è offline, quando torna riceve solo l'ultimo stato e non una pila di messaggi vecchi
    headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(msg.ttl ?? 120), Topic: ('trip' + w.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
      Urgency: msg.silent ? 'normal' : 'high', Authorization: push.vapidAuth(vapid, w.sub.endpoint, subject) } });
  if (res.status === 404 || res.status === 410) { W.delete(w.id); return; }          // iscrizione scaduta o revocata dall'utente
  if (!res.ok) console.log(`push: invio non riuscito (${res.status}) verso ${new URL(w.sub.endpoint).hostname}`);
}
async function tick(w) {
  let d; try { d = getTrip(w.src, w.tid); } catch { W.delete(w.id); return; }     // corsa non più nel GTFS in uso
  const r = step(w, d);
  if (r.msg) await deliver(w, r.msg).catch(e => console.log('push: errore di invio:', e.message));
  if (r.end) { if (w.sub) W.delete(w.id); else w.ended = Date.now(); }
}
function ensureLoop() {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const w of W.values()) { if (w.ended) { if (now - w.ended > 5 * 60e3) W.delete(w.id); continue; } tick(w).catch(() => {}); }
    if (!W.size) { clearInterval(timer); timer = null; }
  }, STEP_MS); timer.unref?.();
}
// il servizio di notifica ha rinnovato l'iscrizione del dispositivo (evento pushsubscriptionchange): gli avvisi attivi passano alla nuova
function resubscribe(oldEndpoint, sub) { let n = 0; for (const w of W.values()) if (w.sub && w.sub.endpoint === oldEndpoint) { w.sub = sub; n++; } return n; }
// lo stato di "poll" resta attivo finché la coda non è stata letta dopo la fine
module.exports = { step, init, create, cancel, poll, publicKey, resubscribe, _W: W };
