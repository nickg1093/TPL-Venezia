const test = require('node:test');
const assert = require('node:assert');
const tracker = require('../tracker');
const schedule = require('../schedule');
const { makeG, veh, feed, BASE } = require('./helpers');

const ctx = makeG(6);
// esegue il tracker in tempo reale: i campioni sono "ago" secondi prima di adesso; tNow finale = BASE + 270
function run(samples, lvAt = k => feed(2)) {
  const real = Date.now(), vs = {}; let last;
  for (const [ago, m, v, ts] of samples) {
    last = tracker.update({ G: ctx.G, trip: ctx.trip, st: ctx.st, lv: lvAt(ago), hist: null, veh: veh(m, v, { ts }), tNow: BASE + 270 - ago, nowMs: real - ago * 1000, vs });
  }
  return last;
}

test('righe "partito": il mezzo appena ripartito resta 2 minuti, con l\'orario effettivo, poi sparisce', () => {
  const state = { T1: run([[40, 1000, 0, 1000], [30, 1000, 0, 1010], [20, 1000, 0, 1020], [8, 1014, 2.5, 1032], [0, 1050, 4, 1040]]) };
  assert.equal(state.T1.cur, 3, 'dopo la ripartenza la corsa è alla fermata successiva');
  const rows = schedule.departures(ctx.G, null, 'S2', BASE + 270, '20261028', state);
  const done = rows.find(r => r.done);
  assert.ok(done, 'riga partita presente');
  assert.equal(done.phase, 'departed');
  assert.ok(done.expMs <= Date.now() && Date.now() - done.expMs < 60000);
  assert.match(done.exp, /^\d\d:\d\d$/);
  // la stessa riga, ma partita da oltre 2 minuti: non c'è più
  state.T1.dep = { ...state.T1.dep, 2: Date.now() - 130000 };
  assert.ok(!schedule.departures(ctx.G, null, 'S2', BASE + 270, '20261028', state).some(r => r.done), 'dopo 2 minuti la riga sparisce');
});

test('mezzo ancora in fermata: la riga NON è "partita" ed è la prossima partenza', () => {
  const state = { T1: run([[30, 1000, 0, 1000], [10, 1000, 0, 1020], [0, 1000, 0, 1030]]) };
  assert.equal(state.T1.cur, 2);
  const rows = schedule.departures(ctx.G, null, 'S2', BASE + 270, '20261028', state);
  assert.ok(rows.length && !rows.some(r => r.done));
  assert.ok(rows.find(r => r.atStop || r.phase === 'at' || r.phase === 'departing'));
});

test('corsa senza stato live: solo orario, nessuna riga partita', () => {
  const rows = schedule.departures(ctx.G, null, 'S2', BASE + 270, '20261028', null);
  assert.ok(rows.every(r => !r.done));
});

test('date e orari invalidi ricadono su "adesso" senza errori', () => {
  assert.doesNotThrow(() => schedule.departures(ctx.G, null, 'S2', 'abc', 'zzz', null));
});
