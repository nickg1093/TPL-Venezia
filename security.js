// SICUREZZA DELL'APP WEB. Tutto ciò che riguarda protezione di richieste, risposte e accessi è qui, così è verificabile in un posto solo.
// Riferimenti: OWASP ASVS / Secure Headers Project / OWASP API Security Top 10.
//   - intestazioni di sicurezza (CSP rigida senza script inline, HSTS, nosniff, anti-clickjacking, politiche di referrer e permessi)
//   - HTTPS obbligatorio dietro proxy (reindirizzamento 308) se FORCE_HTTPS=1
//   - limitazione di frequenza per IP e per classe di richiesta (anti abuso/DoS applicativo); tetto alle connessioni SSE
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
// style-src 'unsafe-inline': Leaflet e i colori delle linee impostano stili in linea (attributi style). Gli SCRIPT invece non possono essere in linea.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https://tile.openstreetmap.org",
  "connect-src 'self'", "font-src 'self'", "manifest-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'none'",
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
function securityHeaders(req, res) {
  for (const k in HEADERS) res.setHeader(k, HEADERS[k]);
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
const LIMITS = { api: 1200, heavy: 300, static: 900, admin: 6, watch: 20 };   // watch: attivazione/annullamento degli avvisi di arrivo   // un utente con pannello aperto fa ~30 richieste/min; il margine copre più schede o dispositivi dietro lo stesso IP
const hits = new Map();         // "classe|ip" -> { n, reset }
const MAX_TRACKED = 50000;      // oltre questo numero di IP distinti la tabella si svuota (memoria limitata anche sotto attacco)
function limit(req, cls) {
  const now = Date.now(), key = cls + '|' + clientIp(req);
  let h = hits.get(key);
  if (!h || now >= h.reset) { if (hits.size >= MAX_TRACKED) hits.clear(); hits.set(key, h = { n: 0, reset: now + 60000 }); }
  h.n++;
  return h.n <= (LIMITS[cls] ?? LIMITS.api) ? 0 : Math.max(1, Math.ceil((h.reset - now) / 1000));   // 0 = ok; altrimenti secondi da attendere
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now >= h.reset) hits.delete(k); }, 60000).unref();
// classe di una richiesta: le chiamate costose (zone, corse, orari) hanno un limite più stretto
const HEAVY = new Set(['/api/zone', '/api/trip', '/api/stop', '/api/scheduled', '/api/audit', '/api/gtfs']);
const classOf = pathname => (pathname.startsWith('/api/') ? (HEAVY.has(pathname) ? 'heavy' : 'api') : 'static');

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
  const h = String(req.headers.authorization || ''), given = /^Bearer\s+(.+)$/i.exec(h)?.[1] || String(req.headers['x-token'] || '');
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

module.exports = { clientIp, isHttps, securityHeaders, httpsRedirect, limit, LIMITS, classOf, sseAcquire, tokenOk, vId, vFullId, vVeh, vSecs, vDate, bad, CSP };
