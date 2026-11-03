// AREA SERVITA (area.js): contorno che racchiude tutte le fermate, segue i gruppi lontani, senza buchi interni.
const test = require('node:test');
const assert = require('node:assert');
const A = require('../area');

const inAny = (r, p) => r.rings.some(g => A.inside(g, p[0], p[1]));
test('tutte le fermate stanno dentro, con margine', () => {
  const pts = []; for (let i = 0; i < 40; i++) pts.push([45.4 + i * 0.004, 12.2 + (i % 7) * 0.01]);
  const r = A.outline(pts);
  assert.ok(r.rings.length >= 1);
  for (const p of pts) assert.ok(inAny(r, p), 'fermata fuori ' + p);
  for (const p of pts) assert.ok(inAny(r, [p[0] + 0.012, p[1]]), 'margine di circa 1 km a nord');   // 0,012° ≈ 1,3 km < 2,5 km
});
test('gruppi lontani = anelli separati; il vuoto tra loro resta fuori', () => {
  const a = [[45.40, 12.30], [45.41, 12.31]], b = [[45.80, 12.30], [45.81, 12.31]];
  const r = A.outline([...a, ...b]);
  assert.equal(r.rings.length, 2);
  assert.ok(!inAny(r, [45.6, 12.3]), 'tra i due gruppi: fuori');
});
test('i buchi interni si riempiono (anello di fermate: il centro è dentro)', () => {
  const pts = []; for (let k = 0; k < 72; k++) { const t = k / 72 * 2 * Math.PI; pts.push([45.5 + 0.12 * Math.sin(t), 12.3 + 0.17 * Math.cos(t)]); }
  const r = A.outline(pts);
  assert.equal(r.rings.length, 1); assert.ok(inAny(r, [45.5, 12.3]));
});
test('dati vuoti o non validi: nessun anello, nessun errore', () => {
  assert.deepStrictEqual(A.outline([]), { rings: [], bbox: null });
  assert.deepStrictEqual(A.outline([[NaN, 1], ['x', 2], null]), { rings: [], bbox: null });
});
test('riquadro coerente con gli anelli', () => {
  const r = A.outline([[45.4, 12.3], [45.5, 12.4]]), [s, w, n, e] = r.bbox;
  for (const g of r.rings) for (const [la, lo] of g) assert.ok(la >= s && la <= n && lo >= w && lo <= e);
  assert.ok(s < 45.4 && n > 45.5 && w < 12.3 && e > 12.4);
});
