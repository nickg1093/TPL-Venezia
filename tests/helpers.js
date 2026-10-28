// Strumenti di prova: costruiscono un piccolo GTFS sintetico (linea rettilinea con fermate ogni 500 m) per verificare tracker e orari
// senza dipendere dai dati reali. Latitudine costante, si avanza in longitudine (1 m = 1/78000 gradi).
const { M_LON } = require('../geo');
const ids = require('../ids');

const LAT = 45.45, LON0 = 12.30;
const lonAt = m => LON0 + m / M_LON;                 // ascissa in metri -> longitudine
const BASE = 12 * 3600;                              // le corse di prova partono alle 12:00:00

// n fermate (0..n-1) a 500 m l'una; partenze ogni 120 s dalla 1ª; shape lunga abbastanza da contenere un tratto prima e uno dopo
function makeG(n = 6, { spacing = 500, headway = 120 } = {}) {
  const stopLoc = {}, stops = {}, s = [], q = [], a = [], d = [];
  for (let k = 0; k < n; k++) {
    const sid = 'S' + k; stopLoc[sid] = [LAT, lonAt(k * spacing)]; stops[sid] = 'Fermata ' + k;
    s.push(sid); q.push(k + 1); a.push(BASE + k * headway); d.push(BASE + k * headway + (k === n - 1 ? 0 : 30));   // sosta programmata di 30 s
  }
  const pts = [];
  for (let m = -400; m <= (n - 1) * spacing + 400; m += 50) pts.push(LAT, lonAt(m));
  const G = {
    routes: { R1: { name: '1', color: '#cc0000' } }, trips: { T1: { route: 'R1', headsign: 'Capolinea', service: 'SV', shape: 'SH', dir: '0' } },
    stops, stopLoc, shapePts: { SH: Float32Array.from(pts) }, routeShapes: {}, calendar: { SV: { days: [1, 1, 1, 1, 1, 1, 1].map(Boolean), start: '20200101', end: '20991231' } }, exByDate: {},
    stopTimes: new Map([['T1', { s, q: Int32Array.from(q), a: Int32Array.from(a), d: Int32Array.from(d), start: d[0], end: a[n - 1] }]]),
    stopIndex: {}, tripIds: ['T1'], stopBaseNames: new Map(), stopIsRequest: new Map()
  };
  G.stopTimes.get('T1').s.forEach((sid, i) => { G.stopIndex[sid] = Int32Array.from([0, i]); });
  ids.attach(G);
  return { G, trip: G.trips.T1, st: G.stopTimes.get('T1') };
}

// mezzo di prova: posizione in metri lungo la linea, velocità in m/s, età del dato in s
function veh(m, v = 0, o = {}) {
  return { key: 'V1', label: '100', lat: LAT, lon: lonAt(m), ts: o.ts ?? 1000, speed: v, vInst: v, stillS: v < 1 ? (o.stillS ?? 30) : 0, ageS: o.ageS ?? 0, status: null, seq: null, ...o.extra };
}
// stato del feed: ritardi (s) per ogni fermata a partire da firstJ
function feed(firstJ, delay = 0, n = 6) { return { delays: Array.from({ length: n }, () => delay), cancelled: false, skipped: new Set(), firstJ, changedAt: 0, ageS: 0 }; }

// un passo del tracker: tNow in secondi del giorno di servizio; l'istante "assoluto" è BASE_MS + tNow
const T0_MS = Date.UTC(2026, 9, 28, 10, 0, 0);
function step(tracker, ctx, vehicle, lv, { tNow, vs, hist = null }) {
  const nowMs = T0_MS + (tNow - BASE) * 1000;
  return tracker.update({ G: ctx.G, trip: ctx.trip, st: ctx.st, lv, hist, veh: vehicle, tNow, nowMs, vs });
}
module.exports = { makeG, veh, feed, step, lonAt, BASE, T0_MS, LAT };
