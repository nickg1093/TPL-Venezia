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
// opts.skip = { key, keep, also, onSkip, onSkipNum }: righe da scartare riconosciute leggendo solo i byte delle colonne key/also (es.
// trip_id di una corsa di un altro giorno): niente scomposizione della riga. Per quelle si chiama onSkipNum(numero) se il valore di also
// è un numero semplice (es. stop_id «4521»), altrimenti onSkip(testo). Su CPU lente (Render
// gratuito) è la differenza tra ~40 s e pochi secondi per i GTFS ACTV lunghi. Righe con virgolette: lettura normale.
async function eachRowStream(entry, fields, fn, opts = {}) {
  if (!entry) return;
  let idx = null, rest = null, n = 0, last = Date.now(), head = null;
  const sk = opts.skip || null; let kc = -1, ac = -1, lastKey = null, lastKeep = true;
  const fast = (b, s, e) => {                                    // true = riga gestita (scartata) senza scomporla
    const maxc = kc > ac ? kc : ac;
    let col = 0, start = s, ks = -1, ke = -1, as = -1, ae = -1;
    for (let i = s; i <= e; i++) {                               // solo i byte fino alla colonna più a destra che serve
      const ch = i < e ? b[i] : 44;
      if (ch === 34) return false;                               // virgolette: lettura normale
      if (ch !== 44 && ch !== 13) continue;
      if (col === kc) { ks = start; ke = i; }
      if (col === ac) { as = start; ae = i; }
      if (col >= maxc) break;
      col++; start = i + 1;
    }
    if (ks < 0 || (ac >= 0 && as < 0)) return false;
    const kb = b.subarray(ks, ke);
    if (!lastKey || !kb.equals(lastKey)) { lastKey = Buffer.from(kb); lastKeep = sk.keep.has(b.toString('utf8', ks, ke)); }
    if (lastKeep) return false;
    if (as < 0) return true;
    if (sk.onSkipNum) {                                          // valore numerico letto dai byte (senza creare testo): cifre, senza zeri iniziali
      let v = 0, ok = ae > as && ae - as <= 9 && !(b[as] === 48 && ae - as > 1);
      for (let i = as; ok && i < ae; i++) { const c = b[i] - 48; if (c < 0 || c > 9) ok = false; else v = v * 10 + c; }
      if (ok) { sk.onSkipNum(v); return true; }
    }
    if (sk.onSkip) sk.onSkip(b.toString('utf8', as, ae));
    return true;
  };
  const line = (b, s, e) => {
    if (sk && idx !== null && kc >= 0 && fast(b, s, e)) return;
    let ln = b.toString('utf8', s, e);
    if (ln.charCodeAt(ln.length - 1) === 13) ln = ln.slice(0, -1);
    if (idx === null) {
      head = splitLine(ln.replace(/^\uFEFF/, '')).map(h => h.trim()); idx = fields.map(f => head.indexOf(f));
      if (sk) { kc = head.indexOf(sk.key); ac = sk.also ? head.indexOf(sk.also) : -1; if (sk.also && ac < 0) kc = -1; }
      return;
    }
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
