// MISURE AGGREGATE DEL SERVER (solo in memoria, si azzerano a ogni riavvio; nessun dato personale, nessun registro delle singole richieste).
// Servono a capire banda e carico: richieste e byte inviati per endpoint, durata media e P95, codici HTTP, connessioni SSE e riconnessioni,
// richieste contemporanee, CPU e memoria. Lette con /api/metriche (riservato, DIAG_TOKEN).
//   endpoint: il percorso /api/… conosciuto (un nome fisso), «file» per i file dell'app, «pagina», «altro» (404, metodi sbagliati)
//   riconnessioni: aperture del flusso dallo stesso IP entro 30 s dalla chiusura precedente (l'IP resta in memoria al massimo 60 s)
//   giorni: per ogni giorno (ora di Venezia) persone diverse stimate e richieste per endpoint; lette con /api/metriche/giorni (DIAG_TOKEN).
//     Le persone si contano con un'impronta dell'IP mescolata a un sale casuale che cambia ogni giorno e non esce mai dalla memoria:
//     non si risale all'IP né si collegano due giorni; a fine giornata restano solo i numeri (ultimi 60 giorni). Più persone dietro lo
//     stesso IP (wifi pubblico, rete mobile) contano come una, una persona che cambia rete conta più volte: è una stima.
const crypto = require('crypto'), { romeYmd } = require('./calendar');
const RING = 256;                                                        // ultime durate per endpoint (per media e P95)
const M = { since: Date.now(), ep: new Map(), sse: { attivi: 0, aperti: 0, rifiutati: 0, riconnessioni: 0, byte: 0 }, conc: { ora: 0, max: 0 }, bloccati: 0, rinviati: 0, min: [] };
const closes = new Map();                                                // ip -> istante dell'ultima chiusura del flusso (60 s)
const streams = new Set();                                               // flussi aperti: byte inviati finora

function ep(name) {
  let e = M.ep.get(name);
  if (!e) M.ep.set(name, e = { n: 0, byte: 0, codici: {}, dur: new Float32Array(RING), k: 0 });
  return e;
}
// conteggio dei byte in uscita: avvolge write/end della risposta (con la compressione: byte compressi, cioè quelli veri in rete)
function track(res) {
  let bytes = 0;
  const w = res.write, e = res.end, len = c => (c == null || typeof c === 'function' ? 0 : typeof c === 'string' ? Buffer.byteLength(c) : c.length || 0);
  res.write = function (c, ...a) { bytes += len(c); return w.call(this, c, ...a); };
  res.end = function (c, ...a) { bytes += len(c); return e.call(this, c, ...a); };
  return () => bytes;
}
// ---- GIORNI ----
const MAX_IMPRONTE = 50000;                                              // tetto alla memoria (circa 3 MB): oltre, il conteggio diventa «almeno»
const GIORNI = [];                                                       // giornate concluse, solo numeri
let oggi = null;
function giornata(now = Date.now()) {
  const d = romeYmd(now);
  if (!oggi || oggi.data !== d) {
    if (oggi) { GIORNI.push(riassunto(oggi)); if (GIORNI.length > 60) GIORNI.shift(); }
    oggi = { data: d, sale: crypto.randomBytes(16), viste: new Set(), oltre: false, richieste: {}, byte: 0, flussi: 0 };
  }
  return oggi;
}
// operazioni leggibili (nome -> endpoint): solo richieste andate a buon fine
const OPERAZIONI = { 'aperture app (flusso mezzi)': '/api/stream', 'fermate consultate': '/api/stop', 'zone consultate': '/api/zone',
  'viaggi pianificati': '/api/percorso', 'corse aperte': '/api/trip', 'avvisi di arrivo attivati': '/api/watch', 'avvisi di arrivo annullati': '/api/watch/cancel',
  'aggiunte al calendario': '/api/ics', 'marea': '/api/tide', 'avvisi ACTV letti': '/api/avvisi', 'MOSE': '/api/mose', 'errori segnalati dai telefoni': '/api/errore' };
function riassunto(g) {
  const fmt = `${g.data.slice(0, 4)}-${g.data.slice(4, 6)}-${g.data.slice(6, 8)}`;
  return { data: fmt, persone: g.viste.size, persone_almeno: g.oltre || undefined, flussi_aperti: g.flussi,
    operazioni: Object.fromEntries(Object.entries(OPERAZIONI).map(([k, e]) => [k, g.richieste[e] || 0])), MB: +(g.byte / 1e6).toFixed(1),
    richieste: Object.fromEntries(Object.entries(g.richieste).sort((a, b) => b[1] - a[1])) };
}
function visita(ip, now) {
  if (!ip) return;
  const g = giornata(now);
  if (g.viste.size >= MAX_IMPRONTE) { g.oltre = true; return; }
  g.viste.add(crypto.createHmac('sha256', g.sale).update(String(ip)).digest('base64').slice(0, 12));
}
function giorni() { return { nota: 'persone = dispositivi/reti diversi stimati nel giorno (ora di Venezia); i dati si perdono a ogni riavvio del server', oggi: riassunto(giornata()), giorni: GIORNI.slice().reverse() }; }

function begin(res, ip) {
  M.conc.ora++; if (M.conc.ora > M.conc.max) M.conc.max = M.conc.ora;
  const t0 = performance.now(), bytes = track(res);
  let name = 'altro';
  const live = () => bytes();
  res.once('close', () => {
    if (!streams.has(live)) M.conc.ora--; streams.delete(live);
    const e = ep(name), d = performance.now() - t0, b = bytes();
    e.n++; e.byte += b; e.codici[res.statusCode] = (e.codici[res.statusCode] || 0) + 1;
    if (name !== '/api/stream') { e.dur[e.k % RING] = d; e.k++; }
    minute(b);
    if (name !== '/healthz' && res.statusCode < 400) { const g = giornata(); g.richieste[name] = (g.richieste[name] || 0) + 1; g.byte += b; visita(ip); }
  });
  return { name: n => { name = n; if (n === '/api/stream') { M.conc.ora--; streams.add(live); } } };   // un flusso aperto non è una richiesta «in corso»
}
function minute(b) {
  const m = Math.floor(Date.now() / 60000), last = M.min[M.min.length - 1];
  if (last && last[0] === m) { last[1]++; last[2] += b; } else { M.min.push([m, 1, b]); if (M.min.length > 60) M.min.shift(); }
}
// flusso SSE: apertura (con riconoscimento delle riconnessioni) e chiusura
function sseOpen(ip, now = Date.now()) {
  M.sse.aperti++; M.sse.attivi++; giornata(now).flussi++;
  const c = closes.get(ip); if (c && now - c < 30000) M.sse.riconnessioni++;
  closes.delete(ip);
}
function sseClose(ip, now = Date.now()) {
  M.sse.attivi = Math.max(0, M.sse.attivi - 1);
  if (closes.size > 5000) closes.clear();
  closes.set(ip, now);
}
setInterval(() => { const now = Date.now(); for (const [k, t] of closes) if (now - t > 60000) closes.delete(k); }, 60000).unref();

let cpu0 = process.cpuUsage(), cpuT = Date.now(), cpuPct = 0;
setInterval(() => { const c = process.cpuUsage(cpu0), dt = Date.now() - cpuT; cpuPct = (c.user + c.system) / 1000 / dt * 100; cpu0 = process.cpuUsage(); cpuT = Date.now(); }, 30000).unref();

function snapshot() {
  const mem = process.memoryUsage(), out = {};
  for (const [k, e] of [...M.ep].sort((a, b) => b[1].byte - a[1].byte)) {
    const n = Math.min(e.k, RING), d = Array.from(e.dur.subarray(0, n)).sort((a, b) => a - b);
    out[k] = { richieste: e.n, kB: Math.round(e.byte / 1000), kB_medi: e.n ? +(e.byte / e.n / 1000).toFixed(2) : 0, ms_media: n ? Math.round(d.reduce((a, b) => a + b, 0) / n) : null, ms_p95: n ? Math.round(d[Math.min(n - 1, Math.floor(n * 0.95))]) : null, codici: e.codici };
  }
  const ore = (Date.now() - M.since) / 3600e3;
  return {
    da: new Date(M.since).toISOString(), ore: +ore.toFixed(2),
    totale: { richieste: [...M.ep.values()].reduce((a, e) => a + e.n, 0), MB: +([...M.ep.values()].reduce((a, e) => a + e.byte, 0) / 1e6).toFixed(2) },
    ultima_ora: { richieste: M.min.reduce((a, m) => a + m[1], 0), MB: +(M.min.reduce((a, m) => a + m[2], 0) / 1e6).toFixed(2) },
    endpoint: out, sse: { ...M.sse, kB_flussi_aperti: Math.round([...streams].reduce((a, f) => a + f(), 0) / 1000) }, contemporanee: M.conc, bloccati: M.bloccati, pianificatore_rinviati: M.rinviati,
    errori_telefoni: Object.fromEntries([...ERR].sort((a, b) => b[1] - a[1]).slice(0, 30)), cpu_pct: +cpuPct.toFixed(1), memoria_MB: { rss: Math.round(mem.rss / 1e6), heap: Math.round(mem.heapUsed / 1e6) }, protezione_memoria: require('./memoria').stato()
  };
}
// errori imprevisti segnalati dai telefoni (sistema.js): solo un conteggio per messaggio tecnico e punto del codice, al massimo 60 voci, in memoria
const ERR = new Map();
function errore({ k, m, w, v }) {
  const key = `${v} · ${k} · ${m}${w ? ' @ ' + w : ''}`;
  if (!ERR.has(key) && ERR.size >= 60) return;
  ERR.set(key, (ERR.get(key) || 0) + 1);
}
module.exports = { begin, giorni, _giornata: giornata, _visita: visita, sseOpen, sseClose, snapshot, errore, count: k => { M[k]++; }, _M: M, _ERR: ERR };
