const test = require('node:test'), assert = require('node:assert');
const av = require('../avvisi');
const ctx = {
  known: new Map(['2', '3', '4.1', '4.2', '5.1', '5.2', '6', '1'].map(n => [n, [{ n, s: 'nav', c: null }]])),
  byName: new Map([['s marcuola casino b', ['nav:5132']], ['s marcuola casino a', ['nav:5035']], ['zattere b', ['nav:5049']], ['rialto c', ['nav:5039']], ['rialto d', ['nav:5038']],
    ['ferrovia c', ['nav:5088']], ['ferrovia d', ['nav:5089']], ['murano venier', ['nav:5066']]]),
  lineStops: new Map(), nameOf: id => id
};
test('livello acqua alta: massimo previsto, soglie ignorate', () => {
  assert.equal(av.waterLevel('Acqua alta: picco +110 cm alle 7.30, poi 95 cm'), 110);
  assert.equal(av.waterLevel('servizi previsti oltre 85 cm'), null);
  assert.equal(av.waterLevel('marea prevista 600 cm'), null);
});
test('piano acqua alta cumulativo', () => {
  assert.equal(av.waterPlan('Previsione di maltempo', ctx), null);
  const a = av.waterPlan('Acqua alta prevista +90 cm', ctx); assert.deepEqual(a.stops, ['nav:5132']); assert.equal(a.lines.length, 0);
  const b = av.waterPlan('Acqua alta prevista +123 cm', ctx);
  assert.ok(b.stops.includes('nav:5049') && !b.stops.includes('nav:5039')); assert.ok(b.lines.some(l => l.n === '3'));
  const c = av.waterPlan('Acqua alta +150 cm', ctx); assert.ok(c.stops.includes('nav:5039') && c.stops.includes('nav:5066')); assert.equal(c.lines.length, 8);
});
test('analyze unisce il piano', () => {
  const r = av.analyze('Acqua alta', 'Marea prevista +100 cm alle 8', ctx); assert.ok(r.water && r.water.level === 100 && r.lines.length === 7);
});
test('avviso automatico dal livello misurato o previsto', () => {
  const now = Date.now();
  av.setTideSource(() => ({ cm: 92, ts: now, stale: false, peak: { cm: 105, ts: now + 3 * 3600e3 } }));
  let r = av.autoWater(now, ctx, false); assert.equal(r.item.water.level, 105); assert.equal(r.item.source, 'auto'); assert.ok(r.item.stops.includes('nav:5132')); assert.ok(r.item.lines.length === 7);
  assert.equal(av.autoWater(now, ctx, true).item, null);                                  // c'è già un avviso ufficiale: l'automatico non compare
  av.setTideSource(() => ({ cm: 60, ts: now, stale: false, peak: { cm: 88, ts: now + 5 * 3600e3 } }));
  r = av.autoWater(now, ctx, false); assert.ok(r.item.from > now + 2 * 3600e3 && r.item.water.level === 88);   // solo previsto: "in arrivo"
  av.setTideSource(() => ({ cm: 60, ts: now, stale: false, peak: { cm: 70, ts: now + 3600e3 } }));
  assert.equal(av.autoWater(now, ctx, false).item, null);
  av.setTideSource(() => ({ cm: 120, ts: now - 3 * 3600e3, stale: true, peak: null }));   // dato vecchio: non si usa
  assert.equal(av.autoWater(now, ctx, false).item, null);
  av.setTideSource(() => null);
});
