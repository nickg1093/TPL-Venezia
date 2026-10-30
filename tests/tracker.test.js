const test = require('node:test');
const assert = require('node:assert');
const tracker = require('../tracker');
const { makeG, veh, feed, step, BASE } = require('./helpers');

const ctx = makeG(6);
const vsNew = () => ({});

test('fasi in ordine: in viaggio -> in arrivo -> in fermata -> in partenza, mai all\'indietro', () => {
  const vs = vsNew(), seen = [];
  // il bus arriva alla fermata 1 (a 500 m) e la lascia dopo la sosta; la partenza programmata è BASE+150
  const track = [[300, 8], [380, 8], [450, 3], [490, 1], [500, 0], [500, 0], [500, 0], [500, 0], [500, 0], [500, 0], [510, 1.5], [540, 5], [600, 8]];
  track.forEach(([m, v], i) => {
    const r = step(tracker, ctx, veh(m, v), feed(1), { tNow: BASE + 60 + i * 8, vs });
    seen.push(r.phase + (r.cur === 1 ? '' : '>' + r.cur));
  });
  const order = ['enroute', 'approaching', 'at', 'departing'];
  let last = -1;
  for (const p of seen.filter(x => !x.includes('>'))) {   // le voci "fase>N" riguardano la fermata successiva (nuovo ciclo)
    const k = order.indexOf(p); if (k >= 0) { assert.ok(k >= last, 'fase tornata indietro: ' + seen.join(' ')); last = k; } }
  console.log('      fasi osservate:', seen.join(' > '));
  assert.ok(seen.some(x => x.startsWith('at')), 'deve passare da "in fermata": ' + seen.join(' '));
});

test('mezzo fermo alla fermata: il feed che avanza NON sposta la fermata corrente (senza GPS valido)', () => {
  const vs = vsNew();
  // fermo alla fermata 2 (1000 m): stato "in fermata"
  let r = step(tracker, ctx, veh(1000, 0), feed(2), { tNow: BASE + 250, vs });
  assert.equal(r.atStop, 2); assert.equal(r.cur, 2);
  // il GPS tace (nessun veicolo) e il feed toglie la fermata 2 (ora la prima è la 3): prima della partenza prevista si resta alla 2
  r = step(tracker, ctx, null, feed(3), { tNow: BASE + 255, vs });
  assert.equal(r.cur, 2, 'la fermata successiva non deve comparire prima della partenza');
  // passata la partenza prevista + 20 s si può passare oltre
  r = step(tracker, ctx, null, feed(3), { tNow: BASE + 245 + 30 + 40, vs });
  assert.equal(r.cur, 3);
});

test('mezzo fermo a 25 m dopo il palo: resta alla fermata, la successiva non viene segnata', () => {
  const vs = vsNew();
  step(tracker, ctx, veh(990, 2), feed(2), { tNow: BASE + 244, vs });
  const r1 = step(tracker, ctx, veh(1025, 0), feed(2), { tNow: BASE + 252, vs });
  assert.equal(r1.cur, 2);
  const r2 = step(tracker, ctx, veh(1025, 0, { extra: { seq: 4 } }), feed(3), { tNow: BASE + 258, vs });   // il mezzo dichiara già la fermata successiva
  assert.equal(r2.cur, 2, 'dichiarazione del mezzo e feed non bastano se è ancora fermo lì');
  assert.equal(r2.atStop, 2);
});

test('fermo 90 m dopo il palo dopo una sosta (pensilina lunga): ancora in fermata', () => {
  const vs = vsNew();
  step(tracker, ctx, veh(1000, 0), feed(2), { tNow: BASE + 250, vs });
  const r = step(tracker, ctx, veh(1090, 0), feed(2), { tNow: BASE + 262, vs });
  assert.equal(r.cur, 2); assert.equal(r.atStop, 2);
});

test('partenza provata dallo spostamento: la fermata passa a transitata e si registra l\'istante', () => {
  const vs = vsNew();
  step(tracker, ctx, veh(1000, 0), feed(2), { tNow: BASE + 250, vs });
  step(tracker, ctx, veh(1000, 0), feed(2), { tNow: BASE + 262, vs });
  step(tracker, ctx, veh(1012, 2, { ts: 1010 }), feed(2), { tNow: BASE + 268, vs });
  const r = step(tracker, ctx, veh(1040, 3, { ts: 1014 }), feed(2), { tNow: BASE + 272, vs });
  assert.equal(r.cur, 3);
  assert.ok(r.dep[2] > 0, 'istante di partenza registrato');
});

test('capolinea: movimenti di manovra non contano come partenza anticipata', () => {
  const vs = vsNew();
  const r = step(tracker, ctx, veh(5, 0.5), feed(0), { tNow: BASE - 600, vs });
  assert.equal(r.cur, 0);
  const r2 = step(tracker, ctx, veh(35, 1.8), feed(0), { tNow: BASE - 590, vs });
  assert.equal(r2.cur, 0, 'una manovra di 30 m non è una partenza');
});

test('senza mezzo né feed: stato da orario, ETA non nel passato', () => {
  const r = step(tracker, ctx, null, null, { tNow: BASE + 10, vs: vsNew() });
  assert.equal(r.vehKey, null);
  assert.ok(Number.isFinite(r.etaMs[r.cur]));
});

test('autocorrezione: fermate date per superate (feed avanti) tornano "in arrivo" se il GPS dice che il mezzo non ci è arrivato', () => {
  const vs = vsNew();
  // il feed (sbagliato) dice che la prima fermata con previsione è la 4, mentre il mezzo è fermo in coda a 700 m (tra la 1 e la 2)
  let r;
  for (let i = 0; i < 2; i++) r = step(tracker, ctx, veh(700, 0, { ts: 2000 + i }), feed(4), { tNow: BASE + 200 + i * 10, vs });
  // senza GPS affidabile accumulato il feed può aver spinto avanti; dopo qualche rilevamento coerente si torna indietro da soli
  for (let i = 2; i < 7; i++) r = step(tracker, ctx, veh(700 + i * 5, 3, { ts: 2000 + i }), feed(4), { tNow: BASE + 200 + i * 10, vs });
  assert.equal(r.cur, 2, 'la prossima fermata reale è la 2 (a 1000 m), non la 4');
  assert.ok(!r.dep || !Object.keys(r.dep).some(k => +k >= 2), 'nessuna partenza registrata dalle fermate non raggiunte');
});
test('autocorrezione stabile: dopo il ritorno indietro il feed sbagliato non rimanda avanti (niente oscillazioni)', () => {
  const vs = vsNew(), seq = [];
  for (let i = 0; i < 3; i++) seq.push(step(tracker, ctx, null, feed(4), { tNow: BASE + 200 + i * 10, vs }).cur);   // solo feed: fermata 4
  for (let i = 0; i < 8; i++) seq.push(step(tracker, ctx, veh(700 + i * 40, 4, { ts: 3000 + i }), feed(4), { tNow: BASE + 240 + i * 10, vs }).cur);
  assert.deepEqual(seq.slice(-6), [2, 2, 2, 2, 2, 2], seq.join(' '));
});
