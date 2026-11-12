// MISURE AGGREGATE DEL SERVER (solo in memoria, si azzerano a ogni riavvio; nessun dato personale, nessun registro delle singole richieste).
// Servono a capire banda e carico: richieste e byte inviati per endpoint, durata media e P95, codici HTTP, connessioni SSE e riconnessioni,
// richieste contemporanee, CPU e memoria. Lette con /api/metriche (riservato, DIAG_TOKEN).
//   endpoint: il percorso /api/… conosciuto (un nome fisso), «file» per i file dell'app, «pagina», «altro» (404, metodi sbagliati)
//   riconnessioni: aperture del flusso dallo stesso IP entro 30 s dalla chiusura precedente (l'IP resta in memoria al massimo 60 s)
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
function begin(res) {
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
  });
  return { name: n => { name = n; if (n === '/api/stream') { M.conc.ora--; streams.add(live); } } };   // un flusso aperto non è una richiesta «in corso»
}
function minute(b) {
  const m = Math.floor(Date.now() / 60000), last = M.min[M.min.length - 1];
  if (last && last[0] === m) { last[1]++; last[2] += b; } else { M.min.push([m, 1, b]); if (M.min.length > 60) M.min.shift(); }
}
// flusso SSE: apertura (con riconoscimento delle riconnessioni) e chiusura
function sseOpen(ip, now = Date.now()) {
  M.sse.aperti++; M.sse.attivi++;
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
    cpu_pct: +cpuPct.toFixed(1), memoria_MB: { rss: Math.round(mem.rss / 1e6), heap: Math.round(mem.heapUsed / 1e6) }
  };
}
module.exports = { begin, sseOpen, sseClose, snapshot, count: k => { M[k]++; }, _M: M };
