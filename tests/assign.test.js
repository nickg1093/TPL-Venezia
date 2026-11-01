// Corsa del mezzo: si segue ACTV (posizione e previsioni); nessuna corsa indovinata dal GPS; staccato solo il mezzo fermo al capolinea ben oltre l'orario.
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
const P = (vehs, now, mem = new Map(), tu = new Map()) => A.plan({ G, vehicles: vehs.map(v => ({ ts: now, ...v })), mem, tuOfVeh: tu, tNowOf: () => now });

test('adattamento: ritardo misurato dal GPS lungo il percorso', () => {
  const f = A.fitTrip(G, 'T1040', lat, at(0.5), () => (10 * 60 + 52) * 60);           // a metà alle 10:52 (previsto 10:50)
  assert.ok(f.lat < 5 && Math.abs(f.delay - 120) < 15);
});
test('ritardo grande ma in viaggio (blocco, coda): si segue la corsa dichiarata, nessuna corsa "più coerente" indovinata', () => {
  const mem = new Map(), now = (10 * 60 + 52) * 60;                                     // dichiara la corsa delle 9:00, a metà percorso alle 10:52
  for (let k = 0; k < 4; k++) assert.deepEqual(P([{ key: 'V', tripId: 'T0900', lat, lon: at(0.5 + k * 0.01), ts: now + k * 15 }], now + k * 15, mem).get('V'), { tid: 'T0900', why: 'feed' });
});
test('previsione ACTV sullo stesso mezzo con un\'altra corsa: vale dopo 2 rilevamenti', () => {
  const mem = new Map(), now = (11 * 60 + 5) * 60, tu = new Map([['V', 'T1100']]);
  assert.equal(P([{ key: 'V', tripId: 'T0900', lat, lon: at(0.25), ts: now }], now, mem, tu).get('V').tid, 'T0900');
  assert.deepEqual(P([{ key: 'V', tripId: 'T0900', lat, lon: at(0.26), ts: now + 15 }], now + 15, mem, tu).get('V'), { tid: 'T1100', why: 'tu' });
});
test('attesa al capolinea prima della partenza (anche lunga): associato', () => {
  const mem = new Map(), now = (10 * 60 + 5) * 60;
  for (let k = 0; k < 3; k++) assert.equal(P([{ key: 'W', tripId: 'T1040', lat, lon: at(0), stillS: 1200, ts: now + k * 15 }], now + k * 15, mem).get('W').tid, 'T1040');
});
test('fermo al capolinea da oltre 40 minuti dopo la partenza: staccato dalla corsa; riparte = di nuovo associato', () => {
  const mem = new Map(), now = (9 * 60 + 50) * 60;                                       // corsa delle 9:00, fermo al capolinea alle 9:50
  let r = P([{ key: 'X', tripId: 'T0900', lat, lon: at(0), stillS: 900, ts: now }], now, mem).get('X');
  assert.equal(r.tid, 'T0900', 'serve una conferma');
  r = P([{ key: 'X', tripId: 'T0900', lat, lon: at(0), stillS: 915, ts: now + 15 }], now + 15, mem).get('X');
  assert.ok(r.idle);
  r = P([{ key: 'X', tripId: 'T0900', lat, lon: at(0.02), stillS: 0, ts: now + 30 }], now + 30, mem).get('X');
  assert.equal(r.tid, 'T0900');
});
test('fermo al capolinea 30 minuti dopo la partenza (blocco della linea): resta associato, il ritardo è vero', () => {
  const mem = new Map(), now = (9 * 60 + 30) * 60;
  for (let k = 0; k < 3; k++) assert.equal(P([{ key: 'Y', tripId: 'T0900', lat, lon: at(0), stillS: 1500, ts: now + k * 15 }], now + k * 15, mem).get('Y').tid, 'T0900');
});
