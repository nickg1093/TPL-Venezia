// RILIEVO ALTIMETRICO RAMSES (Comune di Venezia – Insula S.p.A.): lettura delle curve di livello della pavimentazione e quota della
// pavimentazione in un punto. Solo Node, nessuna dipendenza; usato da scripts/genera-acqua.js (opzione --ramses). Nulla gira sul server.
//
// DATI (verificati il 20/11/2026 sull'archivio scaricato da maps.ramses.it/media/download/curve-livello-shp.zip, 332.908.824 byte,
// file del 21/06/2011, data sul server 21/09/2015):
//   curve_livello_polyline.shp/.dbf/.prj · 426.184 polilinee (419.834 chiuse), 45,5 milioni di vertici, 2.290 km di curve;
//   campi ID, LIVELLO_GE (cm sul riferimento di Genova, IGM) e LIVELLO_PS (cm sullo Zero Mareografico di Punta della Salute, ZMPS 1897);
//   LIVELLO_PS − LIVELLO_GE = 23 cm in tutte le curve; equidistanza 1 cm; quote da 43 a 351 cm ZMPS;
//   coordinate EPSG:3004 (Monte Mario / Italy zone 2, Gauss-Boaga fuso Est), riquadro 2309700–2313907 E, 5033457–5036283 N.
//   Copertura: città storica e Giudecca (non Tronchetto, Santa Marta e area portuale, Sant'Elena est, San Giorgio, isole).
// Usiamo LIVELLO_PS: è lo stesso riferimento delle previsioni e misure di marea del Centro Maree (cm su ZMPS).
//
// METODO. Le curve si disegnano su una griglia di 0,5 m nel loro sistema (dove più curve cadono nello stesso pixel resta la più bassa: a
// favore di sicurezza). La quota di un punto è quella della curva più vicina: con curve ogni centimetro, tra due curve la quota è compresa
// tra i loro valori, e dentro l'ultima curva chiusa (cunetta o dosso) differisce al più di 1 cm. Se nessuna curva è entro MAX_M metri il
// punto NON è misurato (edifici, acqua, zone fuori rilievo): lì resta la stima di sempre. La posizione dei punti WGS84 si porta in EPSG:3004
// con la trasformazione «Monte Mario to WGS 84 (4)» (EPSG:1660, Helmert a 7 parametri, accuratezza dichiarata ~4 m) e la proiezione
// di Gauss (formule di Krüger): stessi risultati di PROJ entro 1 mm (prova in tests/ramses.test.js).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RES = 0.5;                      // metri per pixel della griglia delle curve
const MAX_M = 8;                      // oltre questa distanza dalla curva più vicina il punto non è misurato

// ---------------- coordinate: WGS84 (gradi) -> EPSG:3004 (metri) ----------------
const WGS = { a: 6378137, f: 1 / 298.257223563 }, INTL = { a: 6378388, f: 1 / 297 };
// Monte Mario -> WGS84 (EPSG:1660, convenzione «position vector»); qui serve il verso opposto, calcolato invertendo la matrice
const H = { x: -104.1, y: -49.1, z: -9.9, rx: 0.971, ry: -2.917, rz: 0.714, s: -11.68 };
const AS = Math.PI / 180 / 3600;
function cart(lat, lon, E) {
  const e2 = E.f * (2 - E.f), sl = Math.sin(lat), N = E.a / Math.sqrt(1 - e2 * sl * sl);
  return [N * Math.cos(lat) * Math.cos(lon), N * Math.cos(lat) * Math.sin(lon), N * (1 - e2) * sl];
}
function geo(X, Y, Z, E) {
  const e2 = E.f * (2 - E.f), p = Math.hypot(X, Y), lon = Math.atan2(Y, X);
  let lat = Math.atan2(Z, p * (1 - e2));
  for (let i = 0; i < 8; i++) { const sl = Math.sin(lat), N = E.a / Math.sqrt(1 - e2 * sl * sl); lat = Math.atan2(Z + e2 * N * sl, p); }
  return [lat, lon];
}
// matrice Monte Mario -> WGS84 (position vector): X' = T + (1+s)·R·X, con R = [[1, −rz, ry], [rz, 1, −rx], [−ry, rx, 1]]
const M = (() => {
  const rx = H.rx * AS, ry = H.ry * AS, rz = H.rz * AS, k = 1 + H.s * 1e-6;
  return [[k, -rz * k, ry * k], [rz * k, k, -rx * k], [-ry * k, rx * k, k]];
})();
const MI = (() => {                    // inversa esatta della matrice 3×3
  const [[a, b, c], [d, e, f], [g, h, i]] = M, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
})();
// Gauss (Krüger, serie al 4° ordine in n: errore sotto il millimetro a pochi gradi dal meridiano centrale)
function tmerc(lat, lon, E, lon0, k0, x0) {
  const n = E.f / (2 - E.f), A = E.a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
  const al = [n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16 + 41 * n ** 4 / 180, 13 * n * n / 48 - 3 * n ** 3 / 5 + 557 * n ** 4 / 1440, 61 * n ** 3 / 240 - 103 * n ** 4 / 140, 49561 * n ** 4 / 161280];
  const e = Math.sqrt(E.f * (2 - E.f)), t = Math.sinh(Math.atanh(Math.sin(lat)) - e * Math.atanh(e * Math.sin(lat)));
  const dl = lon - lon0, xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let X = xi, Y = eta;
  for (let j = 1; j <= 4; j++) { X += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); Y += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
  return [x0 + k0 * A * Y, k0 * A * X];
}
// [lat, lon] WGS84 in gradi -> [E, N] EPSG:3004 in metri
function wgsA3004(lat, lon) {
  const d = Math.PI / 180, [X, Y, Z] = cart(lat * d, lon * d, WGS);
  const v = [X - H.x, Y - H.y, Z - H.z], P = MI.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  const [la, lo] = geo(P[0], P[1], P[2], INTL);
  return tmerc(la, lo, INTL, 15 * d, 0.9996, 2520000);
}

// ---------------- lettura dell'archivio: ZIP (in streaming, senza estrarre) o cartella ----------------
// Restituisce { nome -> () => ReadableStream } per i file .shp, .dbf, .prj della prima serie trovata.
function apri(sorgente) {
  const st = fs.statSync(sorgente);
  if (st.isDirectory()) {
    const out = {};
    for (const f of fs.readdirSync(sorgente)) { const m = /\.(shp|dbf|prj)$/i.exec(f); if (m && !out[m[1].toLowerCase()]) out[m[1].toLowerCase()] = { nome: f, flusso: () => fs.createReadStream(path.join(sorgente, f)) }; }
    return out;
  }
  // ZIP: indice centrale in fondo al file (niente ZIP64: le voci sono sotto i 4 GB)
  const fd = fs.openSync(sorgente, 'r'), size = st.size, tail = Buffer.alloc(Math.min(size, 65557));
  fs.readSync(fd, tail, 0, tail.length, size - tail.length);
  let eo = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
  if (eo < 0) throw new Error('archivio ZIP non valido');
  const n = tail.readUInt16LE(eo + 10), cdSize = tail.readUInt32LE(eo + 12), cdOff = tail.readUInt32LE(eo + 16);
  const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
  const out = {};
  for (let p = 0, k = 0; k < n; k++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('indice ZIP non valido');
    const metodo = cd.readUInt16LE(p + 10), comp = cd.readUInt32LE(p + 20), ln = cd.readUInt16LE(p + 28), lx = cd.readUInt16LE(p + 30), lc = cd.readUInt16LE(p + 32), off = cd.readUInt32LE(p + 42);
    const nome = cd.toString('utf8', p + 46, p + 46 + ln); p += 46 + ln + lx + lc;
    const m = /\.(shp|dbf|prj)$/i.exec(nome); if (!m || out[m[1].toLowerCase()]) continue;
    if (metodo !== 0 && metodo !== 8) throw new Error(`${nome}: compressione non gestita`);
    const lh = Buffer.alloc(30); fs.readSync(fd, lh, 0, 30, off);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('voce ZIP non valida');
    const inizio = off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    out[m[1].toLowerCase()] = { nome, flusso: () => { const s = fs.createReadStream(sorgente, { start: inizio, end: inizio + comp - 1 }); return metodo === 8 ? s.pipe(zlib.createInflateRaw()) : s; } };
  }
  fs.closeSync(fd);
  return out;
}
const tutto = s => new Promise((ok, ko) => { const b = []; s.on('data', d => b.push(d)); s.on('end', () => ok(Buffer.concat(b))); s.on('error', ko); });

// DBF: valori del campo «campo» (numerico) per ogni record, nell'ordine
function leggiDbf(buf, campo) {
  const nRec = buf.readUInt32LE(4), hLen = buf.readUInt16LE(8), rLen = buf.readUInt16LE(10);
  let off = 1, pos = -1, len = 0;
  for (let p = 32; p < hLen - 1 && buf[p] !== 0x0d; p += 32) {
    const nome = buf.toString('latin1', p, p + 11).replace(/\0.*$/, '').trim(), l = buf[p + 16];
    if (nome.toUpperCase() === campo) { pos = off; len = l; }
    off += l;
  }
  if (pos < 0) throw new Error(`campo ${campo} assente nel DBF`);
  const out = new Int16Array(nRec);
  for (let i = 0; i < nRec; i++) {
    const r = hLen + i * rLen, v = parseFloat(buf.toString('latin1', r + pos, r + pos + len));
    out[i] = buf[r] === 0x2a || !Number.isFinite(v) ? -32768 : Math.round(v);   // record cancellato o vuoto
  }
  return out;
}

// SHP (polilinee) in streaming: chiama ogni(indice, parti, punti Float64Array [x0, y0, x1, y1…])
function leggiShp(flusso, ogni) {
  return new Promise((ok, ko) => {
    let buf = Buffer.alloc(0), header = false, i = 0;
    flusso.on('data', d => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      let p = 0;
      if (!header) { if (buf.length < 100) return; if (buf.readInt32BE(0) !== 9994) return ko(new Error('file .shp non valido')); header = true; p = 100; }
      while (buf.length - p >= 8) {
        const len = buf.readInt32BE(p + 4) * 2; if (buf.length - p - 8 < len) break;
        const c = p + 8, tipo = buf.readInt32LE(c);
        if (tipo === 3 || tipo === 13 || tipo === 23) {
          const np = buf.readInt32LE(c + 36), nv = buf.readInt32LE(c + 40), parti = new Int32Array(np), pt = new Float64Array(nv * 2);
          for (let k = 0; k < np; k++) parti[k] = buf.readInt32LE(c + 44 + 4 * k);
          const b0 = c + 44 + 4 * np; for (let k = 0; k < nv * 2; k++) pt[k] = buf.readDoubleLE(b0 + 8 * k);
          ogni(i, parti, pt);
        }
        i++; p = c + len;
      }
      buf = buf.subarray(p);
    });
    flusso.on('end', () => ok(i)); flusso.on('error', ko);
  });
}

// ---------------- griglia delle curve ----------------
// Disegna le curve (quota cm ZMPS, 0 = nessuna curva) su una griglia di RES metri; dove più curve cadono nello stesso pixel resta la più bassa.
class Griglia {
  constructor(box) {
    this.x0 = Math.floor(box[0]) - 5; this.y1 = Math.ceil(box[3]) + 5;
    this.W = Math.ceil((Math.ceil(box[2]) + 5 - this.x0) / RES) + 1; this.H = Math.ceil((this.y1 - (Math.floor(box[1]) - 5)) / RES) + 1;
    this.q = new Int16Array(this.W * this.H);
  }
  px(x, y) { return [(x - this.x0) / RES, (this.y1 - y) / RES]; }
  metti(c, r, v) { if (c < 0 || r < 0 || c >= this.W || r >= this.H) return; const k = r * this.W + c, o = this.q[k]; if (o === 0 || v < o) this.q[k] = v; }
  linea(pt, a, b, v) {
    let [px, py] = this.px(pt[2 * a], pt[2 * a + 1]); this.metti(Math.floor(px), Math.floor(py), v);
    for (let k = a + 1; k < b; k++) {
      const [qx, qy] = this.px(pt[2 * k], pt[2 * k + 1]), n = Math.ceil(Math.max(Math.abs(qx - px), Math.abs(qy - py)) * 2);
      for (let j = 1; j <= n; j++) this.metti(Math.floor(px + (qx - px) * j / n), Math.floor(py + (qy - py) * j / n), v);
      px = qx; py = qy;
    }
  }
  // quota della curva più vicina al punto (E, N in metri) entro maxM: { cm, d } oppure null
  vicina(x, y, maxM = MAX_M) {
    const [fx, fy] = this.px(x, y), c0 = Math.floor(fx), r0 = Math.floor(fy), R = Math.ceil(maxM / RES);
    let best = null, bd = Infinity, limite = R;
    for (let k = 0; k <= limite; k++) {
      for (let dr = -k; dr <= k; dr++) {
        const passo = Math.abs(dr) === k ? 1 : 2 * k;
        for (let dc = -k; dc <= k; dc += passo || 1) {
          const c = c0 + dc, r = r0 + dr; if (c < 0 || r < 0 || c >= this.W || r >= this.H) continue;
          const v = this.q[r * this.W + c]; if (!v) continue;
          const d = Math.hypot((c + 0.5 - fx), (r + 0.5 - fy)) * RES;
          if (d < bd || (d === bd && v < best)) { bd = d; best = v; }
        }
      }
      if (best != null && limite === R) limite = Math.min(R, Math.ceil(k * Math.SQRT2) + 1);   // un pixel in diagonale può essere più vicino
    }
    return best != null && bd <= maxM ? { cm: best, d: bd } : null;
  }
}

// Carica il rilievo: { g: Griglia, curve, vertici, box, livelli: [min, max], campo, prj }
async function carica(sorgente, log = () => {}) {
  const f = apri(sorgente);
  if (!f.shp || !f.dbf) throw new Error('nell\'archivio mancano i file .shp o .dbf');
  const prj = f.prj ? (await tutto(f.prj.flusso())).toString('latin1') : '';
  if (prj && !/Monte.?Mario/i.test(prj)) throw new Error('sistema di coordinate inatteso (serve EPSG:3004, Monte Mario / Italy zone 2): ' + prj.slice(0, 80));
  const dbf = await tutto(f.dbf.flusso()), quote = leggiDbf(dbf, 'LIVELLO_PS');
  let ge = null; try { ge = leggiDbf(dbf, 'LIVELLO_GE'); } catch { /* facoltativo */ }
  // riquadro dall'intestazione del .shp
  const h = await new Promise((ok, ko) => { const s = f.shp.flusso(); let b = Buffer.alloc(0); s.on('data', d => { b = Buffer.concat([b, d]); if (b.length >= 100) { s.destroy(); ok(b); } }); s.on('error', ko); s.on('close', () => ok(b)); });
  if (h.length < 100 || h.readInt32BE(0) !== 9994) throw new Error('file .shp non valido');
  const box = [h.readDoubleLE(36), h.readDoubleLE(44), h.readDoubleLE(52), h.readDoubleLE(60)];
  if (!(box[2] - box[0] > 1 && box[2] - box[0] < 50000 && box[3] - box[1] > 1 && box[3] - box[1] < 50000)) throw new Error('riquadro del rilievo non plausibile');
  const g = new Griglia(box);
  log(`ramses: ${quote.length} curve, griglia ${g.W}×${g.H} a ${RES} m (${(g.q.byteLength / 1e6).toFixed(0)} MB)`);
  // prima le quote alte, poi le basse (vince comunque la più bassa: l'ordine non cambia il risultato, conta solo il «min»)
  let vertici = 0, mn = Infinity, mx = -Infinity, diff = new Map();
  const n = await leggiShp(f.shp.flusso(), (i, parti, pt) => {
    const v = quote[i]; if (!(v > 0 && v < 1000)) return;
    if (v < mn) mn = v; if (v > mx) mx = v;
    if (ge) { const d = v - ge[i]; diff.set(d, (diff.get(d) || 0) + 1); }
    vertici += pt.length / 2;
    for (let k = 0; k < parti.length; k++) g.linea(pt, parti[k], k + 1 < parti.length ? parti[k + 1] : pt.length / 2, v);
  });
  if (n !== quote.length) throw new Error(`.shp e .dbf non corrispondono (${n} contro ${quote.length} record)`);
  return { g, curve: n, vertici, box, livelli: [mn, mx], diffGe: [...diff.entries()].sort((a, b) => b[1] - a[1]), prj: prj.slice(0, 60) };
}

// quota in un punto WGS84 (gradi): { cm, d } o null se non misurato
function quotaIn(rl, lat, lon, maxM = MAX_M) { const [x, y] = wgsA3004(lat, lon); return rl.g.vicina(x, y, maxM); }

// valore della cella: MEDIANA dei campioni misurati (ogni metro di calle dentro la cella). Scelta verificata sui dati: la lunghezza di calli
// allagate a ogni livello resta quella dei campioni (a +110 cm 17,0 % contro 16,9 %), mentre il minimo o il 10° percentile la gonfiano
// (23 % a +110 cm) segnando bagnate intere celle per un avvallamento. I punti più bassi di una cella si bagnano qualche cm prima.
function mediana(vals) { const s = [...vals].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; }

module.exports = { RES, MAX_M, wgsA3004, apri, leggiDbf, leggiShp, Griglia, carica, quotaIn, mediana };
