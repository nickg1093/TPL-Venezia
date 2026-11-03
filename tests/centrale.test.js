// CENTRALE ACTV: lettura delle partenze di oraritemporeale.actv.it e fusione con i nostri passaggi (centrale.js).
// GTFS sintetico: linea T1, 4 fermate, una corsa ogni 10 minuti; la fermata del pannello è la 2ª ("Molmenti", codice 6063).
const test = require('node:test');
const assert = require('node:assert');
const cal = require('../calendar');
const ids = require('../ids');
const centrale = require('../centrale');
const { serviceActive } = require('../schedule');

const NAMES = ['Capolinea Favaro', 'San Marco Molmenti', 'San Marco Boerio', 'VENEZIA CORSIA C'], CODES = ['6000', '6063', '6065', '6084'];
const now = Date.now(), S0 = cal.romeParts(now).secs, R = s => Math.round(s);
// corse: partenza dalla fermata del pannello alle (adesso + off) minuti; l'orario intero della corsa è allineato al minuto
function makeG(offsMin) {
  const base = Math.floor(S0 / 60) * 60, trips = {}, stopTimes = new Map(), stops = {}, stopLoc = {}, stopIndex = {};
  CODES.forEach((c, k) => { stops[c] = NAMES[k]; stopLoc[c] = [45.49 + k * 0.003, 12.24]; });
  offsMin.forEach((m, n) => {
    const tid = 'AUT_ACTV_795_' + (17000 + n), t1 = base + m * 60;
    const d = [t1 - 120, t1, t1 + 60, t1 + 600]; trips[tid] = { route: 'R', headsign: 'VENEZIA', service: 'SV', shape: null };
    stopTimes.set(tid, { s: CODES.slice(), a: Int32Array.from(d), d: Int32Array.from(d), q: Int32Array.from([1, 2, 3, 4]), start: d[0], end: d[3] });
  });
  const tripIds = [...stopTimes.keys()], cnt = {};
  tripIds.forEach((tid, n) => stopTimes.get(tid).s.forEach((sid, k) => { (cnt[sid] ||= []).push(n, k); }));
  for (const sid in cnt) stopIndex[sid] = Int32Array.from(cnt[sid]);
  const G = { routes: { R: { name: 'T1', color: '#E31E24' } }, trips, stops, stopLoc, stopTimes, stopIndex, tripIds, stopBaseNames: new Map(), stopIsRequest: new Map(),
    calendar: { SV: { days: [1, 1, 1, 1, 1, 1, 1].map(Boolean), start: '20200101', end: '20991231' } }, exByDate: {}, shapePts: {}, routeShapes: {} };
  ids.attach(G);
  return { G, base, tripIds };
}
const hm = secs => { secs = ((Math.round(secs) % 86400) + 86400) % 86400; return `${String(Math.floor(secs / 3600)).padStart(2, '0')}:${String(Math.floor(secs % 3600 / 60)).padStart(2, '0')}`; };
// risposta ACTV di prova
function actv(passages) {
  const catalog = [{ name: '6063-6064-web-aut', description: 'San Marco Molmenti [6063] [6064]', lines: [{ alias: 'T1' }] }, { name: 'terminal-x-web', description: 'Terminal', lines: [] }];
  return async url => {
    if (url.endsWith('/aut/backend/page/stops')) return new Response(JSON.stringify(catalog));
    if (url.includes('/aut/backend/passages/6063-6064-web-aut')) return new Response(JSON.stringify(passages));
    return new Response('[]');
  };
}
const row = (time, real, extra = {}) => ({ lineId: 1, line: 'T1_UM', destination: 'VENEZIA', time, stop: '6063', real, timingPoints: [], vehicle: null, ...extra });
// righe come le produce schedule.departures (solo i campi usati)
function siteRows(G, tripIds, base, state) {
  return tripIds.map(tid => {
    const st = G.stopTimes.get(tid), ts = st.d[1], sm = ts - S0, ps = state[tid], live = ps && Number.isFinite(ps.etaMs[1]);
    const em = live ? (ps.etaMs[1] - now) / 1000 : sm, dm = live ? Math.round((em - sm) / 60) : null;
    return { tripId: tid, seq: 1, line: 'T1', headsign: 'VENEZIA', sched: hm(ts), exp: hm(ts + (dm ?? 0) * 60), schedIn: R(sm / 60), schedSec: sm, expIn: R(em / 60), expSec: em,
      expMs: live ? ps.etaMs[1] : null, delay: dm, live: !!live, veh: ps?.vehKey ?? null, vehicle: ps?.label ?? null, atStop: false, phase: live ? 'enroute' : null, done: false, arrival: false, cancel: null, src: 'aut', stop: 'aut:6063' };
  });
}
const psOf = (etaAtStop, veh) => ({ cur: 1, atStop: -1, etaMs: Float64Array.from([NaN, etaAtStop, etaAtStop + 60e3, etaAtStop + 600e3]), vehKey: veh, label: veh, dayOff: 0 });
function setup(offs, state, passages, vacated = new Map()) {
  const { G, base, tripIds } = makeG(offs), T = centrale._t.st;
  T.pages.clear(); T.memo.clear(); T.store.clear(); T.wants.clear(); for (const k in T.catalog) delete T.catalog[k];
  centrale.init({ G: () => G, state: () => state, vacated: () => vacated, serviceActive, version: () => 1 }, { background: false });
  global.fetch = actv(passages);
  return { G, base, tripIds };
}

test('tempi ACTV: minuti (per difetto, contati a metà), "in partenza", orario', () => {
  const t = centrale._t.timeOf, at = Date.UTC(2026, 10, 1, 19, 0, 0);   // 20:00 a Venezia
  assert.equal(t("5'", at), at + 330000);
  assert.equal(t('departure', at), at);
  assert.equal(t('20:15', at, false), at + 15 * 60000, 'programmata: orario esatto');
  assert.equal(t('20:15', at), at + 15.5 * 60000, 'tempo reale: a metà del minuto');
  assert.equal(t('00:10', Date.UTC(2026, 10, 1, 22, 50, 0), false), Date.UTC(2026, 10, 1, 23, 10, 0), 'dopo mezzanotte: giorno dopo');
  assert.equal(t('boh', at), null);
});

test('elenco fermate ACTV: i "terminal" (es. Mestre Centro + 27 Ottobre) non si usano; vince la pagina più specifica', () => {
  const m = centrale._t.buildCatalog([{ name: 'terminal-cialdini-web', lines: [] }, { name: '167-web-aut', lines: [] }, { name: '167-168-web-aut', lines: [] }, { name: '5009-5013-S.Marco-nav-web', lines: [] }]);
  assert.equal(m.get('167').page, '167-web-aut');
  assert.equal(m.get('168').page, '167-168-web-aut');
  assert.deepEqual(m.get('5013').codes, ['5009', '5013']);
  assert.ok(![...m.values()].some(e => /terminal/.test(e.page)));
});

test('battelli: la lettera del pontile si traduce nel codice GTFS dal nome della fermata', () => {
  const G = { stops: { 5009: 'S. Marco-San Zaccaria "A"', 5013: 'S. Marco-San Zaccaria "F"', 5076: 'S. Marco-San Zaccaria "B"', 5203: 'S. Marco-San Zaccaria "B"' } };
  const ent = { codes: ['5009', '5013', '5076', '5203'] };
  assert.deepEqual(centrale._t.codesOf(G, ent, 'F'), ['5013']);
  assert.deepEqual(centrale._t.codesOf(G, ent, 'B'), ['5076', '5203']);
  assert.deepEqual(centrale._t.codesOf(G, { codes: ['611'] }, null), ['611']);
  assert.deepEqual(centrale._t.codesOf(G, ent, null), [], 'pagina con più paline e riga senza palina: non si indovina');
});

const same = (a, b) => assert.deepEqual(a, b);

test('corse con un nostro mezzo invariate; corsa senza mezzo col tempo reale della centrale; programmata resta da orario', async () => {
  // corse alle +2, +12, +22 min; la prima ha il mezzo (GPS: +3 min); ACTV: +3 (il mezzo), +19 (la 2ª: il mezzo del turno è in ritardo), +22 programmata
  const state = {}, b = Math.floor(S0 / 60) * 60;
  const { G, base, tripIds } = setup([2, 12, 22], state, [row("2'", true), row(hm(b + 19 * 60), true), row(hm(b + 22 * 60), false)]);
  state[tripIds[0]] = psOf(now + 3 * 60e3, 'TRAM_09');
  await centrale.prepareStops([['aut', '6063']]);
  const before = siteRows(G, tripIds, base, state), rows = centrale.mergeStop('aut', '6063', siteRows(G, tripIds, base, state), now);
  const r = id => rows.find(x => x.tripId === id);
  same(r(tripIds[0]), before[0]);
  assert.equal(r(tripIds[1]).live, true); assert.equal(r(tripIds[1]).delay, 7); assert.equal(r(tripIds[1]).vehicle, null, 'nessun mezzo inventato');
  same(r(tripIds[2]), before[2]);
});

test('partenza fasulla: corsa senza mezzo che la centrale, nel suo orizzonte, non elenca si toglie', async () => {
  // corse alle +5 e +15; la +5 non è né reale né programmata per ACTV, che elenca la +15 (programmata) e una +40 (orizzonte)
  const state = {}, b = Math.floor(S0 / 60) * 60;
  const { G, base, tripIds } = setup([5, 15, 40], state, [row(hm(b + 15 * 60), false), row(hm(b + 40 * 60), false)]);
  await centrale.prepareStops([['aut', '6063']]);
  const rows = centrale.mergeStop('aut', '6063', siteRows(G, tripIds, base, state), now);
  assert.deepEqual(rows.map(x => x.tripId), [tripIds[1], tripIds[2]]);
});

test('linea che la centrale non elenca a quella palina: nessuna corsa tolta', async () => {
  const state = {}, b = Math.floor(S0 / 60) * 60;
  const { G, base, tripIds } = setup([5, 15], state, [row(hm(b + 40 * 60), false, { line: '2_UM' })]);
  await centrale.prepareStops([['aut', '6063']]);
  assert.equal(centrale.mergeStop('aut', '6063', siteRows(G, tripIds, base, state), now).length, 2);
});

test('corsa del feed vecchia (T1 a +113): resta com\'è; il passaggio ACTV va alla corsa dell\'orario senza mezzo', async () => {
  const state = {}, b = Math.floor(S0 / 60) * 60;
  const { G, base, tripIds } = setup([-110, 8], state, [row(hm(b + 14 * 60), true)]);
  state[tripIds[0]] = psOf(now + 3 * 60e3, 'TRAM_04');
  await centrale.prepareStops([['aut', '6063']]);
  const before = siteRows(G, tripIds, base, state), rows = centrale.mergeStop('aut', '6063', siteRows(G, tripIds, base, state), now);
  same(rows.find(x => x.tripId === tripIds[0]), before[0]);
  assert.equal(rows.find(x => x.tripId === tripIds[1]).delay, 6);
});

test('orari alle fermate successive con nomi non riconosciuti da nessuna corsa: si abbina per orario', async () => {
  const state = {};
  const { G, base, tripIds } = setup([10], state, [row(hm(Math.floor(S0 / 60) * 60 + 12 * 60), true, { timingPoints: [{ time: '00:00', stop: 'San Marco Molmenti' }, { time: '00:01', stop: 'Monte Celo Favaro' }] })]);
  await centrale.prepareStops([['aut', '6063']]);
  const r = centrale.mergeStop('aut', '6063', siteRows(G, tripIds, base, state), now)[0];
  assert.equal(r.live, true); assert.equal(r.delay, 2);
});

test('tempo reale "HH:MM" al minuto per difetto: un minuto prima dell\'orario conta "in orario"', async () => {
  const state = {}, b = Math.floor(S0 / 60) * 60;
  const { G, base, tripIds } = setup([16], state, [row(hm(b + 15 * 60), true)]);
  await centrale.prepareStops([['aut', '6063']]);
  assert.equal(centrale.mergeStop('aut', '6063', siteRows(G, tripIds, base, state), now)[0].delay, 0);
});

test('centrale non raggiungibile: il pannello resta identico', async () => {
  const state = {};
  const { G, base, tripIds } = setup([5, 15], state, []);
  global.fetch = async () => { throw new Error('rete'); };
  await centrale.prepareStops([['aut', '6063']]);
  same(centrale.mergeStop('aut', '6063', siteRows(G, tripIds, base, state), now), siteRows(G, tripIds, base, state));
});

test('pannello del mezzo, corsa senza mezzo: orari ACTV alle fermate successive, interpolati tra i punti noti', async () => {
  const state = {}, b = Math.floor(S0 / 60) * 60;
  const { G, tripIds } = setup([4], state, [row(hm(b + 9 * 60), true, { timingPoints: [{ time: hm(b + 9 * 60), stop: 'San Marco Molmenti' }, { time: hm(b + 22 * 60), stop: 'VENEZIA CORSIA C' }] })]);
  await centrale.prepareTrip('aut', tripIds[0]);
  const st = G.stopTimes.get(tripIds[0]);
  const d = { live: true, detected: false, delayNow: null, vehKey: null, stops: CODES.map((c, k) => ({ sched: hm(st.d[k]), state: k === 0 ? 'passed' : k === 1 ? 'next' : 'upcoming', expMs: null, delay: null, exp: null, inMin: null })) };
  centrale.mergeTrip('aut', tripIds[0], d, now);
  assert.equal(d.stops[1].delay, 5, 'fermata abbinata: +5');
  assert.equal(d.stops[3].delay, 8, 'capolinea dagli orari ACTV: +8');
  assert.ok(d.stops[2].delay >= 5 && d.stops[2].delay <= 6, 'fermata intermedia interpolata');
  assert.equal(d.detected, true); assert.equal(d.delayNow, 5);
  assert.equal(d.stops[0].delay, null, 'fermate già passate: invariate');
});

test('pannello del mezzo, corsa con un nostro mezzo: invariato', async () => {
  const state = {}, b = Math.floor(S0 / 60) * 60;
  const { G, tripIds } = setup([4], state, [row(hm(b + 9 * 60), true)]);
  state[tripIds[0]] = psOf(now + 5 * 60e3, 'TRAM_01');
  await centrale.prepareTrip('aut', tripIds[0]);
  const d = { live: true, detected: true, delayNow: 1, vehKey: 'TRAM_01', stops: CODES.map(() => ({ sched: '00:00', state: 'upcoming', expMs: 1, delay: 1 })) }, copy = JSON.parse(JSON.stringify(d));
  same(centrale.mergeTrip('aut', tripIds[0], d, now), copy);
});

test('prudenza: passaggio ACTV della stessa linea non agganciato vicino all\'orario: la corsa non si toglie', async () => {
  // ACTV: una riga reale +6 con fermate successive di un altro percorso (non compatibile) e una +40 (orizzonte)
  const state = {}, b = Math.floor(S0 / 60) * 60;
  const { G, base, tripIds } = setup([5, 40], state, [row(hm(b + 6 * 60), true, { timingPoints: [{ time: hm(b + 6 * 60), stop: 'San Marco Molmenti' }, { time: hm(b + 9 * 60), stop: 'San Marco Boerio' }, { time: hm(b + 59 * 60), stop: 'VENEZIA CORSIA C' }] }), row(hm(b + 40 * 60), false)]);
  await centrale.prepareStops([['aut', '6063']]);
  const rows = centrale.mergeStop('aut', '6063', siteRows(G, tripIds, base, state), now);
  assert.ok(rows.some(x => x.tripId === tripIds[0]));
});

test('corsa con la sola previsione del feed (+15) e la centrale in orario: vale la centrale', async () => {
  const state = {}, b = Math.floor(S0 / 60) * 60;
  const { G, base, tripIds } = setup([19], state, [row(hm(b + 19 * 60), true)]);
  state[tripIds[0]] = psOf(now + 34 * 60e3, null);
  await centrale.prepareStops([['aut', '6063']]);
  const site = siteRows(G, tripIds, base, state); site[0].veh = null; site[0].vehicle = null;
  const r = centrale.mergeStop('aut', '6063', site, now)[0];
  assert.equal(r.delay, 0); assert.equal(r.live, true);
});

test('corsa lasciata dal mezzo per quella del suo turno: senza centrale non compare; con la centrale solo se elencata', async () => {
  const b = Math.floor(S0 / 60) * 60;
  // senza centrale
  let state = {}, s1 = setup([12], state, [], new Map());
  global.fetch = async () => { throw new Error('rete'); };
  centrale._t.st.ctx.vacated = () => new Map([[s1.tripIds[0], 'TRAM_04']]);
  await centrale.prepareStops([['aut', '6063']]);
  assert.equal(centrale.mergeStop('aut', '6063', siteRows(s1.G, s1.tripIds, s1.base, state), now).length, 0);
  // con la centrale che la elenca in tempo reale (un altro tram, alle +13)
  state = {}; const s2 = setup([12, 40], state, [row(hm(b + 13 * 60), true), row(hm(b + 40 * 60), false)]);
  centrale._t.st.ctx.vacated = () => new Map([[s2.tripIds[0], 'TRAM_04']]);
  await centrale.prepareStops([['aut', '6063']]);
  const r = centrale.mergeStop('aut', '6063', siteRows(s2.G, s2.tripIds, s2.base, state), now).find(x => x.tripId === s2.tripIds[0]);
  assert.ok(r && r.live && r.delay === 1);
  // con la centrale che NON la elenca
  state = {}; const s3 = setup([12, 40], state, [row(hm(b + 40 * 60), false)]);
  centrale._t.st.ctx.vacated = () => new Map([[s3.tripIds[0], 'TRAM_04']]);
  await centrale.prepareStops([['aut', '6063']]);
  assert.equal(centrale.mergeStop('aut', '6063', siteRows(s3.G, s3.tripIds, s3.base, state), now).find(x => x.tripId === s3.tripIds[0]), undefined);
});

test('controllo dei turni: "contro" se un altro passaggio reale è più vicino all\'orario della corsa candidata', async () => {
  const b = Math.floor(S0 / 60) * 60, state = {};
  setup([20], state, [row(hm(b + 20 * 60), true), row(hm(b + 23 * 60), true)]);
  await centrale.prepareStops([['aut', '6063']]);
  const sched = now + (b + 20 * 60 - S0) * 1000;
  assert.equal(centrale.checkTurno('aut', '6063', 'T1', now + (b + 23 * 60 + 30 - S0) * 1000, sched), 'contro', 'il passaggio delle 20 è di un altro mezzo');
  assert.equal(centrale.checkTurno('aut', '6063', 'T1', now + (b + 20 * 60 + 30 - S0) * 1000, sched), 'ok');
  assert.equal(centrale.checkTurno('aut', '9999', 'T1', now, sched), null, 'fermata senza dati: nessun parere');
});

test('pannello fermata e pannello della corsa concordano anche alle fermate senza pagina ACTV (orari ACTV delle altre fermate)', async () => {
  const state = {}, b = Math.floor(S0 / 60) * 60;
  const { G, tripIds } = setup([4], state, [row(hm(b + 9 * 60), true, { timingPoints: [{ time: hm(b + 9 * 60), stop: 'San Marco Molmenti' }, { time: hm(b + 22 * 60), stop: 'VENEZIA CORSIA C' }] })]);
  await centrale.prepareStops([['aut', '6063']]);
  centrale.mergeStop('aut', '6063', siteRows(G, tripIds, null, state), now);           // la centrale legge la palina 6063 (+5)
  const st = G.stopTimes.get(tripIds[0]), ts = st.d[3], sm = ts - S0;
  // capolinea VENEZIA CORSIA C (6084): nessuna pagina ACTV; riga «Da orario» nel pannello fermata
  const x = { tripId: tripIds[0], seq: 3, line: 'T1', sched: hm(ts), exp: hm(ts), schedIn: R(sm / 60), schedSec: sm, expIn: R(sm / 60), expSec: sm, expMs: null, delay: null, live: false, veh: null, vehicle: null, done: false, arrival: false, cancel: null, src: 'aut', stop: 'aut:6084' };
  const r = centrale.mergeStop('aut', '6084', [x], now)[0];
  const d = { live: true, detected: false, delayNow: null, vehKey: null, stops: CODES.map((c, k) => ({ sched: hm(st.d[k]), state: k === 0 ? 'passed' : k === 1 ? 'next' : 'upcoming', expMs: null, delay: null, exp: null, inMin: null })) };
  centrale.mergeTrip('aut', tripIds[0], d, now);
  assert.equal(r.live, true);
  assert.equal(r.delay, d.stops[3].delay, 'stesso ritardo nei due pannelli'); assert.equal(r.exp, d.stops[3].exp);
});

test('pannello della corsa: un orario «Da orario» non conta come previsione che coincide (diventa in tempo reale come nel pannello fermata)', async () => {
  const state = {}, b = Math.floor(S0 / 60) * 60;
  const { G, tripIds } = setup([4], state, [row(hm(b + 4 * 60), true)]);
  await centrale.prepareTrip('aut', tripIds[0]);
  const st = G.stopTimes.get(tripIds[0]);
  const d = { live: true, detected: false, delayNow: null, vehKey: null, stops: CODES.map((c, k) => ({ sched: hm(st.d[k]), state: k === 0 ? 'next' : 'upcoming', expMs: now + (st.d[k] - S0) * 1000, delay: null, exp: null, inMin: null })) };
  centrale.mergeTrip('aut', tripIds[0], d, now);
  assert.equal(d.stops[1].delay, 0); assert.equal(d.detected, true);
});

test('un passaggio, una riga: previsione del feed senza mezzo (+20) che la centrale non elenca si toglie; se la elenca resta', async () => {
  const b = Math.floor(S0 / 60) * 60;
  // corse alle +5 e +30; la prima ha solo la previsione del feed a +25 (ritardo trascinato), la centrale elenca solo il passaggio delle +30
  let state = {}, s = setup([5, 30], state, [row(hm(b + 30 * 60), true)]);
  state[s.tripIds[0]] = psOf(now + 25 * 60e3, null);
  await centrale.prepareStops([['aut', '6063']]);
  let site = siteRows(s.G, s.tripIds, s.base, state); site[0].veh = null;
  let rows = centrale.mergeStop('aut', '6063', site, now);
  assert.equal(rows.find(x => x.tripId === s.tripIds[0]), undefined, 'tolta');
  assert.ok(rows.find(x => x.tripId === s.tripIds[1]), 'la corsa elencata resta');
  // stessa situazione, ma la centrale elenca anche un passaggio a +25: la previsione è confermata e resta
  state = {}; s = setup([5, 30], state, [row(hm(b + 25 * 60), true), row(hm(b + 30 * 60), true)]);
  state[s.tripIds[0]] = psOf(now + 25 * 60e3, null);
  await centrale.prepareStops([['aut', '6063']]);
  site = siteRows(s.G, s.tripIds, s.base, state); site[0].veh = null;
  rows = centrale.mergeStop('aut', '6063', site, now);
  assert.ok(rows.find(x => x.tripId === s.tripIds[0]), 'resta');
});
