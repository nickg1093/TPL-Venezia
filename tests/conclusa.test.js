// CORSA CONCLUSA e POSIZIONE BLOCCATA (live.js + motion.js + tracker.js), dalla registrazione del 6/11/2026:
//  - battello 16 (linea 1): arrivato a P.le Roma, riparte in senso opposto dichiarando ancora la corsa finita -> riavvolta fino a +66 min
//  - battello 191 (linea 4.2): sparito alle 17:33, ricompare alle 18:10 con le coordinate delle 17:30 -> corsa finita riaperta a +43 min
// Feed GTFS-RT sintetici (codificati come quelli veri) passati per l'intero ciclo di lettura, con l'orologio controllato.
const test = require('node:test');
const assert = require('node:assert');
const cal = require('../calendar');
const ids = require('../ids');
const live = require('../live');
const { M_LON } = require('../geo');

const LAT = 45.45, LON0 = 12.30, lonAt = m => LON0 + m / M_LON;
const realNow = Date.now;
let NOW = realNow();
const S0 = cal.romeParts(NOW).secs;

// linea rettilinea, 6 fermate a 500 m; T1 arriva al capolinea adesso, T2 è a metà percorso
function makeG() {
  const stopLoc = {}, stops = {}, s = [];
  for (let k = 0; k < 6; k++) { const sid = 'S' + k; stopLoc[sid] = [LAT, lonAt(k * 500)]; stops[sid] = 'Fermata ' + k; s.push(sid); }
  const pts = []; for (let m = -400; m <= 2900; m += 50) pts.push(LAT, lonAt(m));
  const G = { routes: { R1: { name: '1', color: '#cc0000' } }, trips: {}, stops, stopLoc, shapePts: { SH: Float32Array.from(pts) }, routeShapes: {},
    calendar: { SV: { days: [1, 1, 1, 1, 1, 1, 1].map(Boolean), start: '20200101', end: '20991231' } }, exByDate: {},
    stopTimes: new Map(), stopIndex: {}, tripIds: [], stopBaseNames: new Map(), stopIsRequest: new Map(), meta: {} };
  const add = (id, lastAt) => {
    const a = s.map((_, k) => lastAt - (5 - k) * 120), d = a.map((x, k) => (k === 5 ? x : x + 30));
    G.trips[id] = { route: 'R1', headsign: 'Capolinea', service: 'SV', shape: 'SH', dir: '0' };
    G.stopTimes.set(id, { s, q: Int32Array.from([1, 2, 3, 4, 5, 6]), a: Int32Array.from(a), d: Int32Array.from(d), start: d[0], end: a[5] });
  };
  add('T1', S0); add('T2', S0 + 300); add('T3', S0 + 240);
  G.tripIds = [...G.stopTimes.keys()];
  const idx = {}; G.tripIds.forEach((tid, n) => G.stopTimes.get(tid).s.forEach((sid, k) => (idx[sid] ||= []).push(n, k)));
  for (const k in idx) G.stopIndex[k] = Int32Array.from(idx[k]);
  ids.attach(G);
  return G;
}
// feed: posizioni [{ id, trip, m (metri lungo la linea), ts (s) }]; previsioni vuote
let VP = [];
const enc = o => Buffer.from(live.Feed.encode(o).finish());
global.fetch = async url => {
  const head = { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: Math.floor(NOW / 1000) };
  if (String(url).endsWith('tripUpdates')) return new Response(enc({ header: head, entity: [] }));
  return new Response(enc({ header: head, entity: VP.map((v, k) => ({ id: 'E' + k, vehicle: { trip: { tripId: v.trip }, position: { latitude: LAT, longitude: lonAt(v.m) }, timestamp: v.ts, vehicle: { id: v.id, label: v.id } } })) }));
};
async function tick(list, advanceS) {
  NOW += advanceS * 1000; Date.now = () => NOW;
  VP = list.map(v => ({ ts: Math.floor(NOW / 1000), ...v }));
  await live.refresh('nav');
  return live.S.nav;
}
function reset() {
  NOW = realNow(); Date.now = () => NOW;
  live.D.nav = makeG();
  const s8 = live.S.nav;
  Object.assign(s8, { vehicles: [], live: {}, state: {}, hist: new Map(), track: new Map(), vs: new Map(), snap: new Map(), sig: new Map(), owner: new Map(), cache: {}, raw: {},
    fixes: new Map(), ended: new Map(), assign: new Map(), turni: new Map(), errCount: 0, goodAt: NOW, sim: false });
}
test.after(() => { Date.now = realNow; });

test('arrivato al capolinea: la corsa si chiude; ripartendo all\'indietro con la stessa corsa il mezzo ne è staccato e la corsa non si riapre', async () => {
  reset();
  let s8 = await tick([{ id: 'V16', trip: 'T1', m: 2380 }], 0);
  s8 = await tick([{ id: 'V16', trip: 'T1', m: 2500 }], 10);
  s8 = await tick([{ id: 'V16', trip: 'T1', m: 2500 }], 10);
  assert.ok(s8.ended.has('T1'), 'arrivo al capolinea: corsa conclusa');
  for (const [k, back] of [[1, 300], [2, 600], [3, 900]]) {
    s8 = await tick([{ id: 'V16', trip: 'T1', m: 2500 - back }], 15);
    const v = s8.vehicles.find(x => x.key === 'V16');
    assert.equal(v.tripId, null, `passo ${k}: il mezzo non deve tornare sulla corsa finita`);
    assert.equal(v.idle?.why, 'corsa conclusa');
    assert.equal(s8.state.T1?.ended, true); assert.equal(s8.state.T1.cur, 6);
  }
  // dichiara un'altra corsa: si riassocia
  s8 = await tick([{ id: 'V16', trip: 'T3', m: 1000 }], 15);
  assert.equal(s8.vehicles.find(x => x.key === 'V16').tripId, 'T3');
});

test('coordinate identiche per oltre 10 minuti LONTANO dalle fermate: posizione bloccata, il mezzo si stacca; in fermata è normale', async () => {
  reset();
  let s8;
  for (let k = 0; k <= 11; k++) s8 = await tick([{ id: 'V191', trip: 'T2', m: 1250 }, { id: 'VSTOP', trip: 'T3', m: 1000 }], k ? 60 : 0);
  const f = s8.vehicles.find(x => x.key === 'V191'), p = s8.vehicles.find(x => x.key === 'VSTOP');
  assert.equal(f.frozen, true); assert.equal(f.old, true); assert.equal(f.idle?.why, 'posizione bloccata'); assert.equal(f.tripId, null);
  assert.equal(p.frozen, false, 'mezzo agganciato al punto della fermata (come fa il sistema ACTV): non è un GPS bloccato');
});

test('ricompare dopo un lungo silenzio con le STESSE coordinate di prima: posizione bloccata subito', async () => {
  reset();
  let s8 = await tick([{ id: 'V191', trip: 'T2', m: 1250 }], 0);
  s8 = await tick([{ id: 'V191', trip: 'T2', m: 1250 }], 20);
  assert.equal(s8.vehicles.find(x => x.key === 'V191').frozen, false, 'pochi secondi: niente di strano');
  for (let k = 0; k < 4; k++) s8 = await tick([], 600);                       // 40 minuti senza posizione (la traccia del mezzo si cancella)
  s8 = await tick([{ id: 'V191', trip: 'T2', m: 1250 }], 60);
  const v = s8.vehicles.find(x => x.key === 'V191');
  assert.equal(v.frozen, true); assert.equal(v.idle?.why, 'posizione bloccata');
  // si muove di nuovo davvero: torna normale
  s8 = await tick([{ id: 'V191', trip: 'T2', m: 1290 }], 20);
  assert.equal(s8.vehicles.find(x => x.key === 'V191').frozen, false);
});
