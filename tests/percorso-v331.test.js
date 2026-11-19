// PIANIFICATORE v33.1 (GTFS sintetico): camminate lunghe che pesano di più e «Consigliata» stabile tra un aggiornamento e l'altro in tempo reale.
const test = require('node:test');
const assert = require('node:assert');
const percorso = require('../percorso');
const cal = require('../calendar');

const LAT = 45.49;
const lonAt = m => 12.20 + m / (111320 * Math.cos(LAT * Math.PI / 180));
function makeG(trips, stopsM) {   // trips: [{ tid, route, name, stops, dep: [s…] }]
  const G = { routes: {}, trips: {}, stops: {}, stopLoc: {}, stopTimes: new Map(), stopIndex: {}, tripIds: [], shapePts: {}, meta: { hash: Math.random().toString(36) } };
  for (const [sid, m] of Object.entries(stopsM)) { G.stops[sid] = 'Fermata ' + sid; G.stopLoc[sid] = [LAT, lonAt(m)]; }
  for (const t of trips) {
    G.routes[t.route] = { name: t.name, color: '#123456' };
    G.trips[t.tid] = { route: t.route, headsign: 'Capolinea', service: 'S', shape: null };
    G.stopTimes.set(t.tid, { s: t.stops, q: Int32Array.from(t.stops.map((_, j) => j + 1)), a: Int32Array.from(t.dep), d: Int32Array.from(t.dep), start: t.dep[0], end: t.dep[t.dep.length - 1] });
  }
  G.tripIds = [...G.stopTimes.keys()];
  const idx = {}; G.tripIds.forEach((tid, n) => G.stopTimes.get(tid).s.forEach((sid, k) => (idx[sid] ||= []).push(n, k)));
  for (const k in idx) G.stopIndex[k] = Int32Array.from(idx[k]);
  return G;
}
const nav = makeG([], {});
const hhmm = s => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`;

test('camminata lunga: il diretto che arriva 10 minuti dopo vince su 2 minuti di bus e 20 minuti a piedi', () => {
  const T = 8 * 3600;
  const aut = makeG([
    { tid: 'L1_0', route: 'L1', name: '1', stops: ['O', 'D'], dep: [T + 60, T + 60 + 32 * 60] },
    { tid: 'L2_0', route: 'L2', name: '2', stops: ['O', 'E'], dep: [T + 60, T + 60 + 120] }
  ], { O: 0, D: 9000, E: 6000 });
  percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, rows: () => [] });
  const r = percorso.plan({ da: [['aut:O', 0, true]], a: [['aut:D', 0, true], ['aut:E', Math.round(20 * 60 * percorso.C.V_MAIN), true]], secs: T, date: '20261123' });
  const top = r.soluzioni[0];
  assert.deepEqual(top.tratte.filter(t => t.tipo === 'mezzo').map(t => t.line), ['1'], 'consigliato il diretto');
  assert.ok(r.soluzioni.some(o => o.piedi >= 19), 'la soluzione con la camminata resta tra le proposte');
});

test('tempo reale: la «Consigliata» non cambia per un minuto di differenza, cambia se l\'altra diventa molto migliore', () => {
  const T = cal.romeParts(Date.now()).secs, t0 = T + 5 * 60;
  // due linee dirette quasi equivalenti: X parte fra 5 minuti e arriva in 20, Y parte un minuto dopo e arriva 30 secondi prima
  const aut = makeG([
    { tid: 'X_0', route: 'X', name: 'X', stops: ['O', 'D'], dep: [t0, t0 + 20 * 60] },
    { tid: 'Y_0', route: 'Y', name: 'Y', stops: ['O', 'D'], dep: [t0 + 60, t0 + 60 + 1110] }
  ], { O: 0, D: 9000 });
  let delayY = 0;
  const lv = () => ({ Y_0: { delays: [0, delayY] } });
  const rows = (i, sid) => (sid === 'D' ? [{ tripId: 'Y_0', live: true, arrival: true, exp: hhmm(t0 + 60 + 1110 + delayY), delay: Math.round(delayY / 60), expMs: Date.now() + (t0 + 60 + 1110 + delayY - T) * 1000 }] : []);
  percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: i => (i === 'aut' ? lv() : {}), serviceActive: () => true, rows });
  const q = { da: [['aut:O', 0, true]], a: [['aut:D', 0, true]] };
  const lineOf = r => r.soluzioni[0].tratte.find(t => t.tipo === 'mezzo').line;
  assert.equal(lineOf(percorso.plan(q)), 'Y', 'all\'inizio Y è la migliore');
  delayY = 120; percorso._t.clearCache();                      // Y in ritardo di 2 minuti: X è migliore di circa un minuto e mezzo
  assert.equal(lineOf(percorso.plan(q)), 'Y', 'resta Y: differenza piccola');
  delayY = 420; percorso._t.clearCache();                      // 7 minuti: X molto migliore
  assert.equal(lineOf(percorso.plan(q)), 'X');
});
