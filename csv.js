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
  let n = 0;
  for (let s = nl + 1; s < buf.length;) {
    let e = buf.indexOf(10, s); if (e < 0) e = buf.length;
    let ln = buf.toString('utf8', s, e); s = e + 1;
    if (ln.charCodeAt(ln.length - 1) === 13) ln = ln.slice(0, -1);
    if (!ln) continue;
    const f = splitLine(ln), o = {};
    fields.forEach((k, j) => { o[k] = idx[j] >= 0 ? f[idx[j]] : undefined; });
    fn(o);
    if (++n % 20000 === 0) await tick();
  }
}
module.exports = { splitLine, eachRow, tick };
