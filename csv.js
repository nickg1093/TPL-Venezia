// LETTURA CSV (file GTFS). Estratta da gtfs.js per poterla usare anche da gtfsstore.js senza dipendenze circolari.
function splitLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
// cede il controllo al ciclo degli eventi: durante la lettura di file grandi il server continua a rispondere
const tick = () => new Promise(r => setImmediate(r));

// Legge un CSV da buffer e chiama fn({campo: valore}) per ogni riga, restituendo solo le colonne richieste (assenti = undefined)
async function eachRow(buf, fields, fn) {
  if (!buf || !buf.length) return;
  let nl = buf.indexOf(10); if (nl < 0) nl = buf.length;
  const head = splitLine(buf.toString('utf8', 0, nl).replace(/^﻿/, '').replace(/\r$/, '')).map(h => h.trim());
  const idx = fields.map(f => head.indexOf(f));
  let n = 0, last = Date.now();
  for (let s = nl + 1; s < buf.length;) {
    let e = buf.indexOf(10, s); if (e < 0) e = buf.length;
    let ln = buf.toString('utf8', s, e); s = e + 1;
    if (ln.charCodeAt(ln.length - 1) === 13) ln = ln.slice(0, -1);
    if (!ln) continue;
    const f = splitLine(ln), o = {};
    fields.forEach((k, j) => { o[k] = idx[j] >= 0 ? f[idx[j]] : undefined; });
    fn(o);
    // cede il passo ogni ~8 ms di lavoro continuo (non ogni N righe): su CPU lente (piano gratuito) le richieste degli utenti non restano bloccate
    if (++n % 500 === 0 && Date.now() - last > 8) { await tick(); last = Date.now(); }
  }
}
// Come eachRow, ma da una voce ZIP letta a pezzi (zip.js: entry.stream()): niente buffer con tutto il file decompresso.
// Le righe si separano sui byte «a capo» (10): un carattere UTF-8 su più byte non viene mai spezzato.
async function eachRowStream(entry, fields, fn) {
  if (!entry) return;
  let idx = null, rest = null, n = 0, last = Date.now();
  const line = (b, s, e) => {
    let ln = b.toString('utf8', s, e);
    if (ln.charCodeAt(ln.length - 1) === 13) ln = ln.slice(0, -1);
    if (idx === null) { const head = splitLine(ln.replace(/^\uFEFF/, '')).map(h => h.trim()); idx = fields.map(f => head.indexOf(f)); return; }
    if (!ln) return;
    const f = splitLine(ln), o = {};
    fields.forEach((k, j) => { o[k] = idx[j] >= 0 ? f[idx[j]] : undefined; });
    fn(o);
  };
  for await (const chunk of entry.stream()) {
    const b = rest ? Buffer.concat([rest, chunk]) : chunk;
    let s = 0;
    for (let e = b.indexOf(10, s); e >= 0; e = b.indexOf(10, s)) {
      line(b, s, e); s = e + 1;
      if (++n % 500 === 0 && Date.now() - last > 8) { await tick(); last = Date.now(); }
    }
    rest = s < b.length ? Buffer.from(b.subarray(s)) : null;        // copia: non trattiene il pezzo intero
  }
  if (rest && rest.length) line(rest, 0, rest.length);
}
module.exports = { splitLine, eachRow, eachRowStream, tick };
