// UN PASSAGGIO, UNA RIGA (live.js: chooseTU + dedupePassages). Caso reale del 3/11/2026, Guglie, linea 4.1: alle 15:33 il pannello mostrava
// la corsa delle 13:49 «in ritardo di 140 min» (16:09), quella delle 16:09 «in orario · M/S 225» e quella delle 14:29 «in ritardo di 101 min»
// (16:10): tre righe per un battello. Si prova con il battello tracciato e SENZA GPS (non tutte le corse sono tracciate).
const test = require('node:test');
const assert = require('node:assert');
const cal = require('../calendar');
const ids = require('../ids');
const live = require('../live');

const now = Date.now(), S0 = cal.romeParts(now).secs, base = Math.floor(S0 / 60) * 60;
// corse della 4.1: partenza dalla fermata F1 (Guglie) a (adesso + off) minuti; stessa sequenza di fermate
function makeG(trips) {
  const G = { routes: { R: { name: '4.1', color: '#A23C8E' } }, trips: {}, stops: {}, stopLoc: {}, stopTimes: new Map(), stopIndex: {}, tripIds: [], stopBaseNames: new Map(), stopIsRequest: new Map(),
    calendar: { SV: { days: [1, 1, 1, 1, 1, 1, 1].map(Boolean), start: '20200101', end: '20991231' } }, exByDate: {}, shapePts: {}, routeShapes: {} };
  for (const t of trips) {
    const s = ['F0', 'F1', 'F2', 'F3'], t1 = base + t.off * 60, d = s.map((_, k) => t1 + (k - 1) * 180);
    G.trips[t.id] = { route: 'R', headsign: 'Murano Museo', service: 'SV', shape: null };
    G.stopTimes.set(t.id, { s, q: Int32Array.from([1, 2, 3, 4]), a: Int32Array.from(d), d: Int32Array.from(d), start: d[0], end: d[3] });
    for (const x of s) G.stops[x] = x;
  }
  G.tripIds = [...G.stopTimes.keys()];
  const idx = {}; G.tripIds.forEach((tid, n) => G.stopTimes.get(tid).s.forEach((sid, k) => (idx[sid] ||= []).push(n, k)));
  for (const k in idx) G.stopIndex[k] = Int32Array.from(idx[k]);
  ids.attach(G);
  return G;
}
// previsione del feed per una corsa: ritardo costante (s) da F1 in poi, senza mezzo (veh null) o di un mezzo
const tu = (delayS, veh = null) => ({ delays: [null, delayS, delayS, delayS], cancelled: false, skipped: new Set(), firstJ: 1, changedAt: now, veh });
function setup({ trips, liveMap, vehicles = [], state = {} }) {
  const G = makeG(trips), s8 = live.S.nav;
  live.D.nav = G;
  Object.assign(s8, { vehicles, live: liveMap, state, hist: new Map(), dedup: null });
  return s8;
}
const at = m => now + ((base - S0) + m * 60) * 1000 - (now % 1000);

test('battello tracciato sulla 16:09: le previsioni orfane delle 13:49 (+140) e 14:29 (+101) si scartano', () => {
  const s8 = setup({
    trips: [{ id: 'X1349', off: -104 }, { id: 'X1429', off: -64 }, { id: 'Y1609', off: 36 }],
    liveMap: { X1349: tu(140 * 60), X1429: tu(101 * 60) },
    vehicles: [{ key: 'MS225', tripId: 'Y1609', ts: 1 }],
    state: { Y1609: { vehKey: 'MS225', cur: 1, atStop: -1, etaMs: [NaN, at(36), at(39), at(42)], dayOff: 0 } }
  });
  live.dedupePassages('nav', now);
  assert.deepEqual(Object.keys(s8.live), [], 'resta solo la corsa del battello (che ha il suo stato dal GPS)');
  assert.equal(s8.dedup.doppioni, 2);
});

test('battello SENZA GPS: la 16:09 resta (da orario se la previsione coincide), le orfane si scartano', () => {
  const s8 = setup({ trips: [{ id: 'X1349', off: -104 }, { id: 'X1429', off: -64 }, { id: 'Y1609', off: 36 }], liveMap: { X1349: tu(140 * 60), X1429: tu(101 * 60) } });
  live.dedupePassages('nav', now);
  assert.equal(s8.live.X1349, undefined); assert.equal(s8.live.X1429, undefined);
  assert.equal(s8.live.Y1609, undefined, 'previsione entro un minuto dall\'orario: «Da orario»');
});

test('battello SENZA GPS in ritardo: la corsa che passa davvero prende il tempo del feed (dato del feed: in ritardo di 5 min)', () => {
  const s8 = setup({ trips: [{ id: 'X1349', off: -104 }, { id: 'Y1609', off: 36 }], liveMap: { X1349: tu(145 * 60) } });
  live.dedupePassages('nav', now);
  assert.equal(s8.live.X1349, undefined);
  assert.equal(s8.live.Y1609.delays[1], 300); assert.equal(s8.live.Y1609.derived, 'X1349');
});

test('due corse vicine da orario, o ritardi piccoli: niente si tocca', () => {
  const s8 = setup({ trips: [{ id: 'A', off: 10 }, { id: 'B', off: 12 }, { id: 'C', off: 30 }], liveMap: { A: tu(5 * 60), C: tu(2 * 60) } });
  live.dedupePassages('nav', now);
  assert.deepEqual(Object.keys(s8.live).sort(), ['A', 'C']);
});

test('ritardo vero che non cade su un\'altra corsa: resta (anche oltre 40 min, se la centrale non lo smentisce)', () => {
  const trips = [{ id: 'X', off: -50 }, { id: 'Z', off: 60 }];
  let s8 = setup({ trips, liveMap: { X: tu(70 * 60) } });
  live.setPassCheck(null); live.dedupePassages('nav', now);
  assert.ok(s8.live.X, 'senza centrale resta');
  live.setPassCheck(() => 'si'); s8 = setup({ trips, liveMap: { X: tu(70 * 60) } }); live.dedupePassages('nav', now);
  assert.ok(s8.live.X, 'confermato dalla centrale');
  live.setPassCheck(() => 'no'); s8 = setup({ trips, liveMap: { X: tu(70 * 60) } }); live.dedupePassages('nav', now);
  assert.equal(s8.live.X, undefined, 'la centrale vede la linea a quell\'ora e non lo elenca: si scarta');
  live.setPassCheck(null);
});

test('direzione o percorso diversi: non è lo stesso passaggio', () => {
  const G0 = setup({ trips: [{ id: 'X', off: -104 }, { id: 'Y', off: 36 }], liveMap: { X: tu(140 * 60) } });
  const Y = live.D.nav.stopTimes.get('Y'); Y.s = ['F0', 'F1', 'F2', 'F9'];       // capolinea diverso
  live.dedupePassages('nav', now);
  assert.ok(G0.live.X);
});
