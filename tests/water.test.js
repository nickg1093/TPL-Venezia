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
test('acqua alta: misura, previsione e avviso ufficiale insieme (vale il più alto)', () => {
  const now = Date.now(), off = (lv, extra = {}) => ({ id: 'o', source: 'telegram', title: 'Acqua alta', text: lv ? `previsto +${lv} cm` : 'acqua alta in arrivo', published: now - 6e5, from: now - 6e5, to: now + 36e5,
    lines: [], stops: [], stopNames: [], ...(lv ? { water: { level: lv } } : {}), ...extra });
  av.setTideSource(() => ({ cm: 92, ts: now, stale: false, peak: { cm: 105, ts: now + 3 * 3600e3 } }));
  let r = av.autoWater(now, ctx, []); assert.equal(r.item.water.level, 105); assert.equal(r.item.source, 'auto'); assert.ok(r.item.stops.includes('nav:5132')); assert.equal(r.item.lines.length, 7); assert.ok(!r.item.water.confirmed);
  // avviso ufficiale con livello più basso: resta solo quello, con il piano per 105 cm (previsione)
  let o = off(90); r = av.autoWater(now, ctx, [o]); assert.equal(r.item, null); assert.equal(o.water.level, 105); assert.equal(o.water.official, 90); assert.equal(o.lines.length, 7);
  // avviso ufficiale con livello più alto della marea: vale l'ufficiale
  o = off(130); r = av.autoWater(now, ctx, [o]); assert.equal(o.water.level, 130); assert.ok(o.stops.includes('nav:5049'));
  // avviso ufficiale senza livello: compare il calcolato, confermato, con il link al messaggio
  o = off(0, { tgUrl: 'https://t.me/muoversivenezia/9' }); r = av.autoWater(now, ctx, [o]); assert.ok(r.item.water.confirmed); assert.equal(r.item.tgUrl, 'https://t.me/muoversivenezia/9');
  av.setTideSource(() => ({ cm: 60, ts: now, stale: false, peak: { cm: 88, ts: now + 5 * 3600e3 } }));
  r = av.autoWater(now, ctx, []); assert.ok(r.item.from > now + 2 * 3600e3 && r.item.water.level === 88);   // solo previsto: "in arrivo"
  av.setTideSource(() => ({ cm: 60, ts: now, stale: false, peak: { cm: 70, ts: now + 3600e3 } }));
  assert.equal(av.autoWater(now, ctx, []).item, null);
  av.setTideSource(() => ({ cm: 120, ts: now - 3 * 3600e3, stale: true, peak: null }));   // dato vecchio: non si usa
  assert.equal(av.autoWater(now, ctx, []).item, null);
  av.setTideSource(() => null);
});
