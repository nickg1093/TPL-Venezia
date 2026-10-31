// Verifica delle corse dichiarate: corsa sbagliata nel feed (ritardo "finto") corretta con prove ripetute; ritardo vero lasciato com'è.
const test = require('node:test'), assert = require('node:assert');
const schedule = require('../schedule'); schedule.isActiveToday = () => true;           // nei test tutte le corse sono attive
const A = require('../assign');
// linea rettilinea di ~5,6 km verso est, 5 fermate ogni ~1,4 km; corse da 20 minuti
const lat = 45.49, lon0 = 12.20, dLon = 0.018;
const G = { routes: { R: { name: '19' } }, trips: {}, stopTimes: new Map(), shapePts: { SH: [] }, stopLoc: {}, tripIds: [] };
for (let k = 0; k <= 40; k++) G.shapePts.SH.push(lat, lon0 + dLon * k / 10);
['a', 'b', 'c', 'd', 'e'].forEach((s, k) => { G.stopLoc[s] = [lat, lon0 + dLon * k]; });
const addTrip = (tid, startMin) => {
  const d = [0, 5, 10, 15, 20].map(m => (startMin + m) * 60);
  G.trips[tid] = { route: 'R', shape: 'SH' }; G.tripIds.push(tid);
  G.stopTimes.set(tid, { s: ['a', 'b', 'c', 'd', 'e'], q: [1, 2, 3, 4, 5], a: Int32Array.from(d), d: Int32Array.from(d), start: d[0], end: d[4] });
};
addTrip('T0900', 9 * 60); addTrip('T1040', 10 * 60 + 40); addTrip('T1100', 11 * 60);
const at = (frac) => lon0 + dLon * 4 * frac;                                           // punto lungo la linea (0 = a, 1 = e)
const run = (mem, now, f, extra = {}) => A.check({ G, v: { key: 'V1', feedTripId: 'T0900', lat, lon: at(f), ts: now, ...extra }, mem, tuTid: extra.tu || null, owners: new Map(), tNowOf: () => now });

test('adattamento: ritardo misurato dal GPS lungo il percorso', () => {
  const f = A.fitTrip(G, 'T1040', lat, at(0.5), () => (10 * 60 + 52) * 60);           // a metà alle 10:52 (previsto 10:50)
  assert.ok(f.lat < 5 && Math.abs(f.delay - 120) < 15);
});
test('corsa sbagliata (100 min di "ritardo"): si passa alla corsa giusta dopo 3 rilevamenti', () => {
  const mem = {}, now = (10 * 60 + 52) * 60;                                            // il mezzo dichiara la corsa delle 9:00 ma è a metà alle 10:52
  assert.equal(run(mem, now, 0.5), null); assert.equal(run(mem, now + 15, 0.52), null);
  const r = run(mem, now + 30, 0.54); assert.equal(r.tid, 'T1040'); assert.equal(r.why, 'gps'); assert.ok(Math.abs(r.delay) < 300);
  assert.equal(run(mem, now + 45, 0.56).tid, 'T1040');                                 // la scelta regge
  // il feed cambia la corsa dichiarata: si torna a seguire il feed
  assert.equal(A.check({ G, v: { key: 'V1', feedTripId: 'T1040', lat, lon: at(0.6), ts: now + 60 }, mem, owners: new Map(), tNowOf: () => now + 60 }), null);
});
test('ritardo vero: nessuna altra corsa più coerente, nessun intervento', () => {
  const mem = {}, now = (9 * 60 + 30) * 60;                                            // corsa delle 9:00 a metà alle 9:30 = 20 min di ritardo
  for (let k = 0; k < 5; k++) assert.equal(run(mem, now + k * 15, 0.5 + k * 0.01), null);
});
test('candidata indicata dal trip update del feed: bastano 2 rilevamenti', () => {
  const mem = {}, now = (11 * 60 + 5) * 60;
  assert.equal(run(mem, now, 0.25, { tu: 'T1100' }), null);
  const r = run(mem, now + 15, 0.26, { tu: 'T1100' }); assert.equal(r.tid, 'T1100'); assert.equal(r.why, 'feed');
});
test('attesa al capolinea prima della partenza: è normale, nessun intervento', () => {
  const mem = {}, now = (10 * 60 + 25) * 60;                                           // mezzo al capolinea, dichiara la corsa delle 10:40
  for (let k = 0; k < 4; k++) assert.equal(A.check({ G, v: { key: 'V2', feedTripId: 'T1040', lat, lon: at(0), ts: now + k * 15 }, mem, owners: new Map(), tNowOf: () => now + k * 15 }), null);
});
