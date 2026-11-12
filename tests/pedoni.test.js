// Percorsi a piedi sul telefono: mattonelle generate da scripts/pedoni-core.js e ricerca di public/js/pedoni.js su una rete di prova.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../scripts/pedoni-core');

// public/js/pedoni.js è un modulo ES del browser: lo si importa da una copia .mjs
async function load() {
  const f = path.join(os.tmpdir(), `pedoni-${process.pid}.mjs`);
  fs.writeFileSync(f, fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pedoni.js')));
  return import('file://' + f);
}

// griglia di strade ogni ~100 m attorno a (45.4300, 12.3300), a cavallo di più mattonelle; un «canale» tra le colonne 5 e 6
// attraversato da un solo ponte (riga 9) con le scale. Restituisce il testo OPL come lo produce osmium.
const LAT0 = 45.4250, LON0 = 12.3250, DLAT = 0.0009, DLON = 0.00128, NR = 12, NC = 12;
function grid() {
  const L = [], id = (r, c) => 1 + r * NC + c;
  for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) L.push(`n${id(r, c)} x${(LON0 + c * DLON).toFixed(7)} y${(LAT0 + r * DLAT).toFixed(7)}`);
  let w = 1;
  for (let r = 0; r < NR; r++) {                                 // vie est-ovest, interrotte dal canale tranne al ponte
    const left = [], right = [];
    for (let c = 0; c < NC; c++) (c <= 5 ? left : right).push('n' + id(r, c));
    L.push(`w${w++} Thighway=footway N${left.join(',')}`);
    L.push(`w${w++} Thighway=footway N${right.join(',')}`);
    if (r === 9) L.push(`w${w++} Thighway=steps,bridge=yes Nn${id(r, 5)},n${id(r, 6)}`);
  }
  for (let c = 0; c < NC; c++) { const ns = []; for (let r = 0; r < NR; r++) ns.push('n' + id(r, c)); L.push(`w${w++} Thighway=residential N${ns.join(',')}`); }
  L.push(`w${w++} Thighway=motorway Nn${id(0, 5)},n${id(0, 6)}`);   // non percorribile a piedi
  L.push(`w${w++} Thighway=footway,foot=no Nn${id(1, 5)},n${id(1, 6)}`);
  return L;
}
function build() {
  const R = P.lettore(); for (const l of grid()) R.line(l);
  const r = R.done(), { tiles } = P.mattonelle(r, () => true);
  return { tiles, ways: r.ways.length };
}
const pt = (r, c) => ({ lat: LAT0 + r * DLAT, lon: LON0 + c * DLON });
const mDist = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));

test('mattonelle: solo le vie percorribili, tratti in entrambe le mattonelle dei capi', () => {
  const { tiles, ways } = build();
  assert.strictEqual(ways, 2 * NR + 1 + NC);                      // autostrada e «foot=no» scartate
  assert.ok(Object.keys(tiles).length >= 2, 'la griglia attraversa più mattonelle');
  for (const [c, txt] of Object.entries(tiles)) { const T = JSON.parse(txt); assert.strictEqual(T.t, c); assert.strictEqual(T.n.length % 2, 0); for (const e of T.e) { assert.ok(e[0] < T.n.length / 2 && e[1] < T.n.length / 2); assert.ok(e[2] > 0); } }
});

test('percorso a piedi: lungo le strade, attraverso l\'unico ponte, con caricamento delle mattonelle solo quando servono', async () => {
  const { createNet } = await load(), { tiles } = build(), asked = [];
  const net = createNet({ CL: P.CL, CO: P.CO, loadTile: async c => { asked.push(c); return tiles[c] ? JSON.parse(tiles[c]) : null; } });
  // stessa riva: distanza «a scacchiera»
  const a = pt(2, 1), b = pt(4, 3), r1 = await net.route(a, b, 3000);
  const manh = mDist(a, pt(4, 1)) + mDist(pt(4, 1), b);
  assert.ok(Math.abs(r1.m - manh) < 3, `${r1.m} ≈ ${manh}`);
  assert.deepStrictEqual(r1.pts[0], [a.lat, a.lon]); assert.deepStrictEqual(r1.pts.at(-1), [b.lat, b.lon]);
  // rive opposte del canale: si passa dal ponte della riga 9 (scale × 1,3), molto più lungo della linea d'aria
  const c = pt(2, 5), d = pt(2, 6), r2 = await net.route(c, d, 5000);
  const via = 2 * mDist(pt(2, 5), pt(9, 5)) + mDist(pt(9, 5), pt(9, 6)) * 1.3;
  assert.ok(Math.abs(r2.m - via) < 3, `${r2.m} ≈ ${via}`);
  assert.ok(r2.pts.some(p => Math.abs(p[0] - pt(9, 5).lat) < 1e-6), 'passa dal ponte');
  // oltre il limite: nessun percorso
  assert.strictEqual(await net.route(c, d, 500), null);
  // punto a metà di una via (non su un incrocio) e ritorno sulla stessa via
  const e = { lat: (pt(3, 2).lat + pt(3, 3).lat) / 2, lon: (pt(3, 2).lon + pt(3, 3).lon) / 2 + 0.0001 }, f = pt(3, 3);
  const r3 = await net.route(e, f, 1000);
  assert.ok(Math.abs(r3.m - mDist(e, f)) < 2, `${r3.m} ≈ ${mDist(e, f)}`);
  assert.ok(asked.length <= Object.keys(tiles).length + 9);
});

test('distanze verso più fermate: come il percorso singolo, irraggiungibili escluse', async () => {
  const { createNet } = await load(), { tiles } = build();
  const net = createNet({ CL: P.CL, CO: P.CO, loadTile: async c => (tiles[c] ? JSON.parse(tiles[c]) : null) });
  const da = pt(2, 2), mete = [{ ...pt(2, 4), key: 'x' }, { ...pt(6, 2), key: 'y' }, { ...pt(2, 8), key: 'z' }, { lat: 45.6, lon: 12.6, key: 'lontana' }];
  const m = await net.distances(da, mete, 1500);
  const r = await net.route(da, pt(2, 4), 1500);
  assert.strictEqual(m.get('x'), r.m);
  assert.ok(Math.abs(m.get('y') - mDist(da, pt(6, 2))) < 3);
  assert.ok(!m.has('z'), 'oltre il canale: più di 1,5 km dal ponte');
  assert.ok(!m.has('lontana'));
});

test('punto lontano da ogni strada: nessun aggancio', async () => {
  const { createNet } = await load(), { tiles } = build();
  const net = createNet({ CL: P.CL, CO: P.CO, loadTile: async c => (tiles[c] ? JSON.parse(tiles[c]) : null) });
  assert.strictEqual(await net.route({ lat: 45.40, lon: 12.30 }, pt(2, 2), 3000), null);
});

test('lettore OPL: tag con caratteri speciali e accesso privato', () => {
  assert.deepStrictEqual(P.tagsOf('highway=footway,name=Calle%20%del%2c%Forno'), { highway: 'footway', name: 'Calle del,Forno' });
  assert.strictEqual(P.walkable({ highway: 'service', access: 'private' }), false);
  assert.strictEqual(P.walkable({ highway: 'service', access: 'private', foot: 'yes' }), true);
  assert.strictEqual(P.walkable({ highway: 'motorway' }), false);
});
