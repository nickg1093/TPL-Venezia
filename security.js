// SICUREZZA DELL'APP WEB. Tutto ciò che riguarda protezione di richieste, risposte e accessi è qui, così è verificabile in un posto solo.
// Riferimenti: OWASP ASVS / Secure Headers Project / OWASP API Security Top 10.
//   - intestazioni di sicurezza (CSP rigida senza script inline, HSTS, nosniff, anti-clickjacking, politiche di referrer e permessi)
//   - HTTPS obbligatorio dietro proxy (reindirizzamento 308) se FORCE_HTTPS=1
//   - limitazione di frequenza per IP e per classe di richiesta (anti abuso/DoS applicativo); tetto alle connessioni SSE e alle aperture
//   - blocco temporaneo progressivo di chi sfora di continuo; tetto alle richieste contemporanee per IP; budget di CPU del pianificatore
//   - endpoint amministrativi/diagnostici chiusi da token (confronto a tempo costante); se il token non è impostato l'endpoint è DISATTIVATO
//   - validazione rigorosa di ogni parametro in ingresso (lista di caratteri ammessi, lunghezze e intervalli)
const crypto = require('crypto');

// ---- IP del client ----
// Dietro il proxy di Render l'IP vero è nell'ultimo elemento di X-Forwarded-For aggiunto dal proxy fidato. Senza proxy fidato l'intestazione
// si ignora (altrimenti chiunque potrebbe falsificarla per aggirare i limiti). TRUST_PROXY = numero di proxy fidati (Render: 1).
const TRUST = process.env.TRUST_PROXY != null ? Math.max(0, +process.env.TRUST_PROXY || 0) : (process.env.RENDER ? 1 : 0);
function clientIp(req) {
  if (TRUST > 0) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[Math.max(0, parts.length - TRUST)].slice(0, 64);
  }
  return req.socket.remoteAddress || 'sconosciuto';
}
const isHttps = req => !!req.socket.encrypted || (TRUST > 0 && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

// ---- intestazioni ----
// Le mattonelle della mappa vengono da OpenStreetMap; tutto il resto è dello stesso sito (Leaflet incluso, servito da /vendor).
// connect-src: oltre al sito, SOLO i due CDN da cui il telefono scarica i dati fissi e la rete pedonale (fissi.js), e solo come DATI
// (fetch di JSON, controllati con l'impronta SHA-256 prima dell'uso): nessuno script esterno, script-src resta 'self'.
// style-src 'unsafe-inline': Leaflet e i colori delle linee impostano stili in linea (attributi style). Gli SCRIPT invece non possono essere in linea.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https://tile.openstreetmap.org",
  "connect-src 'self' https://cdn.jsdelivr.net https://raw.githubusercontent.com", "font-src 'self'", "manifest-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'none'",
  "form-action 'none'", "frame-ancestors 'none'", 'upgrade-insecure-requests'
].join('; ');
const HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'X-DNS-Prefetch-Control': 'off'
};
// Risposte dati (/api): non sono pagine, quindi bastano le intestazioni che contano per i dati (OWASP REST Security):
// nessun contenuto eseguibile, niente incorniciamento, niente sniffing, solo stesso sito. Circa 600 byte in meno a risposta.
const API_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin'
};
function securityHeaders(req, res) {
  const H = String(req.url || '').startsWith('/api/') ? API_HEADERS : HEADERS;
  for (const k in H) res.setHeader(k, H[k]);
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
// HTTP -> HTTPS (solo se richiesto; /healthz resta raggiungibile in HTTP per i controlli di Render e dei pinger)
function httpsRedirect(req, res, pathname) {
  if (process.env.FORCE_HTTPS !== '1' || isHttps(req) || pathname === '/healthz') return false;
  const host = String(req.headers.host || '').replace(/[^\w.:\-\[\]]/g, '');
  if (!host) return false;
  res.writeHead(308, { Location: `https://${host}${req.url}`, 'Cache-Control': 'no-store' }); res.end();
  return true;
}

// ---- limitazione di frequenza (finestra di 60 s per IP e classe) ----
// plan: calcoli del pianificatore (CPU): un utente ne fa ~5-15 al minuto (aggiornamento ogni 60 s, alternative, modifiche); sse: aperture del flusso
const LIMITS = { api: 1200, heavy: 300, plan: 90, sse: 30, static: 900, admin: 6, watch: 20 };   // watch: attivazione/annullamento degli avvisi di arrivo   // un utente con pannello aperto fa ~30 richieste/min; il margine copre più schede o dispositivi dietro lo stesso IP
const hits = new Map();         // "classe|ip" -> { n, reset }
const MAX_TRACKED = 50000;      // oltre questo numero di IP distinti la tabella si svuota (memoria limitata anche sotto attacco)
function limit(req, cls) {
  const now = Date.now(), key = cls + '|' + clientIp(req);
  let h = hits.get(key);
  if (!h || now >= h.reset) { if (hits.size >= MAX_TRACKED) hits.clear(); hits.set(key, h = { n: 0, reset: now + 60000 }); }
  h.n++;
  const max = LIMITS[cls] ?? LIMITS.api;
  if (h.n <= max) return 0;
  if (h.n === max + 1) strike(clientIp(req), now);                       // primo sforamento della finestra: conta per il blocco progressivo
  return Math.max(1, Math.ceil((h.reset - now) / 1000));                // secondi da attendere
}

// ---- blocco temporaneo progressivo ----
// Chi supera i limiti 3 volte in 10 minuti (o sbaglia 3 volte il token degli endpoint riservati) resta bloccato per 1, 5, 15, poi 60 minuti;
// il livello torna a zero dopo un'ora senza sforamenti. Gli utenti normali non arrivano mai al primo sforamento (limiti ampi).
// In memoria e per poco tempo: si tiene solo l'IP con i contatori, niente altro.
const STRIKES_N = 3, STRIKES_MS = 10 * 60e3, BLOCK_S = [60, 300, 900, 3600], FORGET_MS = 3600e3;
const abuse = new Map();                                                 // ip -> { t: [istanti degli sforamenti], level, until, last }
function strike(ip, now = Date.now()) {
  let a = abuse.get(ip);
  if (!a) { if (abuse.size >= MAX_TRACKED) abuse.clear(); abuse.set(ip, a = { t: [], level: 0, until: 0, last: 0 }); }
  if (now - a.last > FORGET_MS) a.level = 0;
  a.last = now; a.t = a.t.filter(x => now - x < STRIKES_MS); a.t.push(now);
  if (a.t.length >= STRIKES_N) { a.until = now + BLOCK_S[Math.min(a.level, BLOCK_S.length - 1)] * 1000; a.level++; a.t = []; }
}
// secondi di blocco rimasti (0 = libero)
function blocked(req, now = Date.now()) { const a = abuse.get(clientIp(req)); return a && a.until > now ? Math.ceil((a.until - now) / 1000) : 0; }
const authFailed = req => strike(clientIp(req));
setInterval(() => { const now = Date.now(); for (const [k, a] of abuse) if (a.until <= now && now - a.last > FORGET_MS) abuse.delete(k); }, 5 * 60e3).unref();

// ---- richieste contemporanee per IP (il flusso SSE ha un tetto suo) ----
const INFLIGHT_PER_IP = 24, inflight = new Map();
function enter(req) {
  const ip = clientIp(req), n = inflight.get(ip) || 0;
  if (n >= INFLIGHT_PER_IP) return null;
  inflight.set(ip, n + 1);
  let done = false;
  return () => { if (done) return; done = true; const m = (inflight.get(ip) || 1) - 1; m ? inflight.set(ip, m) : inflight.delete(ip); };
}

// ---- budget di CPU del pianificatore (globale) ----
// Un calcolo nuovo costa decine di millisecondi (centinaia sulla CPU ridotta del piano gratuito). Se negli ultimi 10 secondi i calcoli hanno
// occupato più di metà del tempo, i nuovi si rimandano di qualche secondo (503 + Retry-After: l'app riprova da sola): il server resta
// reattivo per tutti gli altri (mezzi, fermate) anche se uno script chiede migliaia di percorsi.
const CPU_WIN_MS = 10000, CPU_MAX_MS = 5000, cpuLog = [];
function cpuBusy(now = Date.now()) { while (cpuLog.length && now - cpuLog[0][0] > CPU_WIN_MS) cpuLog.shift(); let s = 0; for (const [, d] of cpuLog) s += d; return s > CPU_MAX_MS; }
function cpuSpent(ms, now = Date.now()) { if (ms >= 2) { cpuLog.push([now, ms]); if (cpuLog.length > 5000) cpuLog.shift(); } }
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now >= h.reset) hits.delete(k); }, 60000).unref();
// classe di una richiesta: le chiamate costose (zone, corse, orari) hanno un limite più stretto
const HEAVY = new Set(['/api/zone', '/api/trip', '/api/stop', '/api/scheduled', '/api/audit', '/api/gtfs']);
const PLAN = new Set(['/api/percorso', '/api/percorso-simili']);
const classOf = pathname => (pathname.startsWith('/api/') ? (PLAN.has(pathname) ? 'plan' : pathname === '/api/stream' ? 'sse' : HEAVY.has(pathname) ? 'heavy' : 'api') : 'static');

// ---- connessioni SSE (flusso a spinta) ----
const SSE_PER_IP = 10, SSE_TOTAL = 400, sseByIp = new Map(); let sseTotal = 0;
function sseAcquire(req) {
  const ip = clientIp(req), n = sseByIp.get(ip) || 0;
  if (n >= SSE_PER_IP || sseTotal >= SSE_TOTAL) return null;
  sseByIp.set(ip, n + 1); sseTotal++;
  let done = false;
  return () => { if (done) return; done = true; sseTotal--; const m = (sseByIp.get(ip) || 1) - 1; m ? sseByIp.set(ip, m) : sseByIp.delete(ip); };
}

// ---- token (endpoint riservati) ----
// Confronto a tempo costante sugli hash (nessuna fuga di informazioni dalla durata del confronto). Token non impostato = endpoint disattivato.
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function tokenOk(req, secret) {
  if (!secret || secret.length < 16) return false;                         // un token corto o assente non protegge: l'endpoint resta chiuso
  // «Bearer <token>» letto senza espressioni regolari (nessun rischio di tempi esplosivi su intestazioni costruite ad arte), lunghezza limitata
  const h = String(req.headers.authorization || '').slice(0, 1024), bearer = h.slice(0, 7).toLowerCase() === 'bearer ' ? h.slice(7).trim() : '';
  const given = bearer || String(req.headers['x-token'] || '').slice(0, 1024).trim();
  return !!given && crypto.timingSafeEqual(sha(given), sha(secret));
}

// ---- validazione parametri ----
const ID_RE = /^[A-Za-z0-9_.:|\-]{1,128}$/;
const vId = s => typeof s === 'string' && ID_RE.test(s);                              // codice di corsa/fermata/linea (senza prefisso servizio)
const vFullId = (s, services) => {                                                    // "servizio:codice"
  if (typeof s !== 'string' || s.length > 160) return null;
  const k = s.indexOf(':'); if (k < 1) return null;
  const src = s.slice(0, k), id = s.slice(k + 1);
  return services.includes(src) && vId(id) ? [src, id] : null;
};
const vVeh = s => s == null || s === '' || vId(s);
const vSecs = s => { if (s == null) return null; if (!/^\d{1,6}$/.test(s) || +s > 172800) return false; return +s; };    // false = non valido, null = assente
const vDate = s => {
  if (s == null) return null;
  if (!/^\d{8}$/.test(s)) return false;
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8), t = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? s : false;
};
const bad = (msg = 'richiesta non valida') => Object.assign(new Error(msg), { code: 400 });

module.exports = { API_HEADERS, clientIp, isHttps, securityHeaders, httpsRedirect, limit, LIMITS, classOf, sseAcquire, blocked, authFailed, enter, cpuBusy, cpuSpent, INFLIGHT_PER_IP, tokenOk, vId, vFullId, vVeh, vSecs, vDate, bad, CSP };
