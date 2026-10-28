const test = require('node:test'), assert = require('node:assert');
const { buildCurve } = require('../tide');
const now = Date.UTC(2026, 9, 28, 12, 0), H = 3600e3;
test('curva prevista: mezza cosinusoide fra gli estremi, corretta sul livello misurato e smorzata', () => {
  const ex = [{ type: 'min', cm: -20, ts: now - 3 * H }, { type: 'max', cm: 60, ts: now + 3 * H }, { type: 'min', cm: -10, ts: now + 9 * H }];
  const c = buildCurve(ex, [{ t: now - 60e3, cm: 35 }], now);
  assert.equal(c[0][0], now); assert.equal(c[0][1], 35);                      // parte dal livello misurato (il modello darebbe 20: scarto +15)
  assert.equal(c.length, 37); assert.equal(c[18][1], 66);                    // all'estremo il modello dà 60, più lo scarto smorzato (15·e^-1 ≈ 5,5)
  assert.ok(c.every((p, i) => !i || p[0] - c[i - 1][0] === 600e3));
});
test('curva prevista: senza estremo precedente si parte dal livello misurato; senza dati nulla', () => {
  const c = buildCurve([{ type: 'max', cm: 60, ts: now + 3 * H }], [{ t: now - 60e3, cm: 35 }], now);
  assert.equal(c[0][1], 35); assert.ok(c[c.length - 1][0] <= now + 3 * H);   // si ferma all'ultimo estremo noto
  assert.deepEqual(buildCurve([], [], now), []);
});
