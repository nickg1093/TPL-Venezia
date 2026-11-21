// Rilievo RAMSES (scripts/ramses-core.js) e quote misurate nei file dell'acqua alta (scripts/acqua-core.js, public/js/acqua.js).
// Le prove usano un piccolo shapefile costruito qui (nessun file esterno): coordinate, lettura .shp/.dbf da cartella e da ZIP, curva più
// vicina, cella misurata o stimata, codifica parallela «mis» letta dal telefono (anche dal codice vecchio, che la ignora).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const RC = require('../scripts/ramses-core');
const A = require('../scripts/acqua-core');

async function load(name) {
  const f = path.join(os.tmpdir(), `${name}-ramses-${process.pid}.mjs`);
  fs.writeFileSync(f, fs.readFileSync(path.join(__dirname, '..', 'public', 'js', name + '.js')));
  return import('file://' + f);
}

// ---- shapefile di prova: polilinee in EPSG:3004 con LIVELLO_GE / LIVELLO_PS ----
function shapefile(linee) {               // linee: [{ ps, pts: [[x, y], …] }]
  const recs = linee.map((l, i) => {
    const nv = l.pts.length, c = Buffer.alloc(44 + 4 + 16 * nv);
    c.writeInt32LE(3, 0);
    const xs = l.pts.map(p => p[0]), ys = l.pts.map(p => p[1]);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, k) => c.writeDoubleLE(v, 4 + 8 * k));
    c.writeInt32LE(1, 36); c.writeInt32LE(nv, 40); c.writeInt32LE(0, 44);
    l.pts.forEach(([x, y], k) => { c.writeDoubleLE(x, 48 + 16 * k); c.writeDoubleLE(y, 56 + 16 * k); });
    const h = Buffer.alloc(8); h.writeInt32BE(i + 1, 0); h.writeInt32BE(c.length / 2, 4);
    return Buffer.concat([h, c]);
  });
  const body = Buffer.concat(recs), head = Buffer.alloc(100);
  const all = linee.flatMap(l => l.pts);
  head.writeInt32BE(9994, 0); head.writeInt32BE((100 + body.length) / 2, 24); head.writeInt32LE(1000, 28); head.writeInt32LE(3, 32);
  [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])), Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))].forEach((v, k) => head.writeDoubleLE(v, 36 + 8 * k));
  // DBF: ID, LIVELLO_GE, LIVELLO_PS (N 10)
  const campi = ['ID', 'LIVELLO_GE', 'LIVELLO_PS'], hLen = 32 + 32 * campi.length + 1, rLen = 1 + 10 * campi.length;
  const dbf = Buffer.alloc(hLen + rLen * linee.length + 1, 0x20);
  dbf.fill(0, 0, hLen); dbf[0] = 3; dbf.writeUInt32LE(linee.length, 4); dbf.writeUInt16LE(hLen, 8); dbf.writeUInt16LE(rLen, 10);
  campi.forEach((n, k) => { dbf.write(n, 32 + 32 * k, 'latin1'); dbf[32 + 32 * k + 11] = 0x4e; dbf[32 + 32 * k + 16] = 10; });
  dbf[hLen - 1] = 0x0d;
  linee.forEach((l, i) => { const r = hLen + i * rLen; dbf[r] = 0x20; [i + 1, l.ps - 23, l.ps].forEach((v, k) => dbf.write(String(v).padStart(10), r + 1 + 10 * k, 'latin1')); });
  dbf[dbf.length - 1] = 0x1a;
  const prj = Buffer.from('PROJCS["Monte Mario / Italy zone 2",GEOGCS["MonteMario"]]');
  return { shp: Buffer.concat([head, body]), dbf, prj };
}
function zip(files, deflate = true) {      // ZIP minimo (senza CRC: il lettore non lo usa)
  const loc = [], cen = []; let off = 0;
  for (const [nome, dati] of Object.entries(files)) {
    const data = deflate ? zlib.deflateRawSync(dati) : dati, n = Buffer.from(nome), m = deflate ? 8 : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(m, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(dati.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(m, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(dati.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    loc.push(lh, n, data); cen.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(cen), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...loc, cd, e]);
}

// punto di riferimento: davanti alla Basilica di San Marco (valori di PROJ 9, «Monte Mario to WGS 84 (4)» + Italy zone 2)
const BAS = [45.43455, 12.33925], BAS_EN = [2311889.554, 5034686.919];

test('coordinate: WGS84 -> EPSG:3004 come PROJ (entro 1 cm)', () => {
  for (const [ll, en] of [[BAS, BAS_EN], [[45.4411, 12.3211], [2310494.167, 5035461.768]], [[45.49, 12.42], [2318403.501, 5040641.270]]]) {
    const [x, y] = RC.wgsA3004(...ll);
    assert.ok(Math.abs(x - en[0]) < 0.01 && Math.abs(y - en[1]) < 0.01, `${ll}: ${x.toFixed(3)} ${y.toFixed(3)}`);
  }
});

// tre curve chiuse concentriche (cunetta: 70 al centro, 72, 74) attorno alla Basilica e una curva lontana a 120
const [X0, Y0] = BAS_EN, sq = (r, ps) => ({ ps, pts: [[X0 - r, Y0 - r], [X0 + r, Y0 - r], [X0 + r, Y0 + r], [X0 - r, Y0 + r], [X0 - r, Y0 - r]] });
const LINEE = [sq(20, 74), sq(10, 72), sq(3, 70), { ps: 120, pts: [[X0 + 200, Y0], [X0 + 260, Y0]] }];

test('lettura del rilievo da cartella e da ZIP (compresso o no): stesse quote, campo LIVELLO_PS, differenza con Genova', async () => {
  const f = shapefile(LINEE), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ramses-'));
  fs.writeFileSync(path.join(dir, 'c.shp'), f.shp); fs.writeFileSync(path.join(dir, 'c.dbf'), f.dbf); fs.writeFileSync(path.join(dir, 'c.prj'), f.prj);
  const zd = path.join(dir, 'c.zip'), zs = path.join(dir, 's.zip');
  fs.writeFileSync(zd, zip({ 'c.shp': f.shp, 'c.dbf': f.dbf, 'c.prj': f.prj }));
  fs.writeFileSync(zs, zip({ 'c.prj': f.prj, 'c.dbf': f.dbf, 'c.shp': f.shp }, false));
  for (const src of [path.join(dir), zd, zs]) {
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'ramses-d-'));
    const from = src === dir ? (() => { for (const e of ['shp', 'dbf', 'prj']) fs.copyFileSync(path.join(dir, 'c.' + e), path.join(sub, 'c.' + e)); return sub; })() : src;
    const rl = await RC.carica(from);
    assert.strictEqual(rl.curve, 4);
    assert.deepStrictEqual(rl.livelli, [70, 120]);
    assert.deepStrictEqual(rl.diffGe, [[23, 4]], 'LIVELLO_PS − LIVELLO_GE = 23 cm');
    // al centro (dentro la curva 70): 70; a 6 m dal centro, tra 70 (3 m) e 72 (10 m): la più vicina, 70; a 15 m: tra 72 e 74
    assert.strictEqual(RC.quotaIn(rl, ...BAS).cm, 70);
    assert.strictEqual(rl.g.vicina(X0 + 9, Y0).cm, 72);
    assert.ok([72, 74].includes(rl.g.vicina(X0 + 15, Y0).cm));
    // lontano da ogni curva (oltre MAX_M): non misurato
    assert.strictEqual(rl.g.vicina(X0 + 100, Y0), null);
    assert.strictEqual(rl.g.vicina(X0 + 230, Y0 + 2).cm, 120);
  }
});

test('rilievo: due curve nello stesso pixel = vince la più bassa; sistema di coordinate sbagliato = errore chiaro', async () => {
  const g = new RC.Griglia([0, 0, 100, 100]);
  g.linea(new Float64Array([10, 10, 30, 10]), 0, 2, 90); g.linea(new Float64Array([10, 10, 30, 10]), 0, 2, 85);
  assert.strictEqual(g.vicina(20, 10).cm, 85);
  const f = shapefile(LINEE), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ramses-p-'));
  fs.writeFileSync(path.join(dir, 'c.shp'), f.shp); fs.writeFileSync(path.join(dir, 'c.dbf'), f.dbf); fs.writeFileSync(path.join(dir, 'c.prj'), 'PROJCS["WGS 84 / UTM zone 33N"]');
  await assert.rejects(RC.carica(dir), /sistema di coordinate/);
  fs.writeFileSync(path.join(dir, 'c.prj'), f.prj); fs.writeFileSync(path.join(dir, 'c.dbf'), f.dbf.subarray(0, 40));
  await assert.rejects(RC.carica(dir));
});

test('celle misurate (mediana, almeno metà della calle) -> tessere -> telefono: quota misurata dove c\'è, stima altrove', async () => {
  const G = { lat0: 45.430, lon0: 12.330, dlat: 0.00009, dlon: 0.00013, righe: 100, colonne: 100 }, T = 10;
  const zone = [{ id: 'venezia', box: [45.43, 12.33, 45.44, 12.345], curva: true, fondo: 128 }];
  const E = (la0, lo0, la1, lo1, ponte = false) => ({ g: [[Math.round(la0 * 1e6), Math.round(lo0 * 1e6)], [Math.round(la1 * 1e6), Math.round(lo1 * 1e6)]], ponte, len: 300 });
  // tre calli est-ovest (righe 0, 10 e 20 della griglia): la prima tutta misurata, la seconda per un terzo, la terza è un ponte
  const R = { edges: [E(45.43005, 12.3301, 45.43005, 12.3340), E(45.43095, 12.3301, 45.43095, 12.3340), E(45.43185, 12.3301, 45.43185, 12.3340, true)] };
  const quota = (la, lo) => (la < 45.4301 ? { cm: 80 + Math.round((lo - 12.3301) * 1e4) } : la < 45.4310 && lo < 12.3314 ? { cm: 95 } : null);
  const mis = [], st = A.rilievo(R, mis, { G, zone, quota, basso: RC.mediana });
  const riga = r => mis.filter(o => Math.floor(o.k / G.colonne) === r).sort((a, b) => a.k - b.k);
  assert.ok(riga(0).length >= 25 && riga(0).every(o => o.mis), 'prima calle: tutta misurata');
  assert.ok(riga(0).slice(1, -1).every(o => Math.abs(o.cm - (80 + ((o.k % G.colonne) * G.dlon + G.lon0 + G.dlon / 2 - 12.3301) * 1e4)) <= 2), 'valore = mediana della cella');
  assert.ok(riga(10).length >= 8 && riga(10).length <= 12 && riga(10).every(o => o.cm === 95), 'seconda calle: solo dove c\'è il rilievo');
  assert.strictEqual(riga(20).length, 0, 'ponti esclusi');
  assert.strictEqual(st.misurate, mis.length);
  // tessere di 10×10 celle; telefono: stima (file «quote» di prova, 120 cm ovunque sulla griglia) + tessere caricate
  const ts = A.tessere(mis, G, T);
  assert.deepStrictEqual(ts.map(t => t.id).sort(), [...new Set(mis.map(o => `${Math.floor(Math.floor(o.k / G.colonne) / T)}_${Math.floor((o.k % G.colonne) / T)}`))].sort());
  assert.strictEqual(ts.reduce((a, t) => a + t.n, 0), mis.length);
  const X = await load('acqua');
  const stima = X.quoteDa({ f: 1, g: G, r: [0, 10, 20].map(r => [r, 0, A.codice(120).repeat(40)]) });
  const ril = { g: { lat0: G.lat0, lon0: G.lon0, dlat: G.dlat * T, dlon: G.dlon * T }, t: new Map(), meta: { nome: 'RAMSES', attribuzione: 'Fonte informativa: Insula spa' } };
  const Q = X.composta(stima, ril), centro = o => [G.lat0 + (Math.floor(o.k / G.colonne) + 0.5) * G.dlat, G.lon0 + (o.k % G.colonne + 0.5) * G.dlon];
  const o0 = riga(0)[5];
  assert.strictEqual(Q.at(...centro(o0)), 120, 'tessera non ancora caricata: stima');
  assert.strictEqual(Q.misurata(...centro(o0)), false);
  for (const t of ts) ril.t.set(t.id, X.quoteDa({ f: 1, g: t.g, r: t.r }));
  for (const o of mis) { assert.strictEqual(Q.at(...centro(o)), A.valore(A.codice(o.cm))); assert.strictEqual(Q.misurata(...centro(o)), true); }
  const fuori = riga(10).at(-1).k + 3;                               // seconda calle, oltre il tratto misurato: stima
  assert.strictEqual(Q.at(G.lat0 + 10.5 * G.dlat, G.lon0 + (fuori % G.colonne + 0.5) * G.dlon), 120);
  assert.strictEqual(Q.nMis, mis.length); assert.strictEqual(Q.rilievo.attribuzione, 'Fonte informativa: Insula spa');
  assert.strictEqual(Q.G, stima.G, 'il resto dell\'interfaccia è quello della stima');
  assert.strictEqual(X.composta(stima, null), stima, 'senza rilievo: la stima, come prima');
  // metri bagnati: quelli su quote stimate si contano a parte (testi del pianificatore)
  const e = { a: {}, b: {}, w: 400, s: 0, g: R.edges[1].g };
  const b = X.bagnato(e, 140, Q, null);
  assert.ok(b.bagnati > 250 && b.stimati > 150 && b.stimati < b.bagnati, `bagnati ${b.bagnati}, su stima ${b.stimati}`);
  assert.strictEqual(Math.round(X.bagnato({ ...e, g: R.edges[0].g }, 140, Q, null).stimati), 0);
});

test('file della stima senza rilievo; tessere del rilievo (se generate) piccole, verificabili, attribuite; archivio originale fuori da GitHub', async () => {
  const dir = path.join(__dirname, '..', 'public', 'acqua');
  const ind = JSON.parse(fs.readFileSync(path.join(dir, 'indice.json'), 'utf8')), q = JSON.parse(fs.readFileSync(path.join(dir, 'quote.json'), 'utf8'));
  assert.ok(!ind.rilievo && !q.rilievo && !q.mis && !/RAMSES|Insula spa/.test(q.fonte), 'indice e quote pubblicabili: solo stima');
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(gi, /^dati-ramses\/$/m, 'archivio originale escluso da GitHub');
  assert.doesNotMatch(gi, /^public\/acqua\/rilievo/m, 'tessere pubblicabili (con la fonte Insula)');
  const dr = path.join(dir, 'rilievo');
  if (!fs.existsSync(path.join(dr, 'indice.json'))) return;          // versione senza rilievo: niente altro da controllare
  const ir = JSON.parse(fs.readFileSync(path.join(dr, 'indice.json'), 'utf8')), X = await load('acqua'), crypto = require('crypto');
  assert.strictEqual(ir.rilievo.attribuzione, 'Fonte informativa: Insula spa');
  assert.strictEqual(ir.rilievo.pubblicabile, true);
  assert.ok(/Punta della Salute/.test(ir.rilievo.fonte) && /cessione a terzi/.test(ir.rilievo.licenza));
  const ril = { g: ir.g, t: new Map(), meta: ir.rilievo }; let tot = 0, fuori = 0;
  const BOX = [2309700.32, 5033456.74, 2313906.81, 5036282.95], M = RC.MAX_M + 8;
  for (const [id, f] of Object.entries(ir.files)) {
    const b = fs.readFileSync(path.join(dr, id + '.json'));
    assert.strictEqual(crypto.createHash('sha256').update(b).digest('hex'), f.sha, `${id}: impronta`);
    assert.ok(b.length < 20000, `${id}: ${b.length} B`); tot += b.length;
    const t = X.quoteDa(JSON.parse(b)); assert.strictEqual(t.n, f.celle); ril.t.set(id, t);
    const [tr, tc] = id.split('_').map(Number);
    assert.ok(Math.abs(t.G.lat0 - (ir.g.lat0 + tr * ir.g.dlat)) < 1e-6 && Math.abs(t.G.lon0 - (ir.g.lon0 + tc * ir.g.dlon)) < 1e-6, `${id}: posizione`);
    for (let k = 0; k < t.v.length; k++) if (t.v[k] !== 255) {
      const [x, y] = RC.wgsA3004(t.G.lat0 + (Math.floor(k / t.G.colonne) + 0.5) * t.G.dlat, t.G.lon0 + (k % t.G.colonne + 0.5) * t.G.dlon);
      if (x < BOX[0] - M || x > BOX[2] + M || y < BOX[1] - M || y > BOX[3] + M) fuori++;
    }
  }
  assert.ok(tot < 120000, `tessere in tutto ${tot} B`);
  assert.strictEqual(fuori, 0, 'celle misurate solo nel riquadro del rilievo (EPSG:3004)');
  const Q = X.composta(X.quoteDa(q), ril);
  assert.ok(Q.nMis > 15000, `celle misurate ${Q.nMis}`);
  const vicino = (la, lo) => { for (let d = 0; d <= 0.0003; d += 0.00005) for (const [a, b] of [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]]) { const h = Q.at(la + a, lo + b); if (h != null) return { h, m: Q.misurata(la + a, lo + b) }; } return null; };
  const piazza = vicino(45.43415, 12.3379); assert.ok(piazza.m && piazza.h >= 74 && piazza.h <= 90, `Piazza San Marco ${piazza.h}`);
  const murano = vicino(45.4565, 12.3530); assert.ok(murano && !murano.m, 'Murano: stima');
  assert.strictEqual(Q.at(45.4115, 12.37), null, 'Lido: fuori modello');
});
