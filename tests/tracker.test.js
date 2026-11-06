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

test('sosta in anticipo poco oltre il palo: in fermata, non "partito in anticipo"; la partenza vera vale', () => {
  const vs = vsNew();
  // arriva alla fermata 2 (1000 m) con 70 s di anticipo e si ferma 100 m oltre il palo (banchina lunga). Partenza programmata BASE+270
  let r = step(tracker, ctx, veh(960, 6, { ts: 1 }), feed(2), { tNow: BASE + 195, vs });
  r = step(tracker, ctx, veh(1100, 0, { ts: 2 }), feed(2), { tNow: BASE + 200, vs });
  assert.equal(r.cur, 2, 'non deve risultare partito'); assert.equal(r.atStop, 2, 'deve risultare in fermata');
  r = step(tracker, ctx, veh(1100, 0, { ts: 3 }), feed(3), { tNow: BASE + 240, vs });   // anche se il feed toglie la fermata
  assert.equal(r.cur, 2);
  r = step(tracker, ctx, veh(1160, 5, { ts: 4 }), feed(3), { tNow: BASE + 272, vs });    // parte in orario
  assert.equal(r.cur, 3);
  const dep = vs.dep[2], depS = (dep - (Date.UTC(2026, 9, 28, 10, 0, 0) + 0)) / 1000 - 0;
  assert.ok(dep >= Date.UTC(2026, 9, 28, 10, 0, 0) + 270 * 1000 - 5000, 'partenza registrata all\'orario, non in anticipo');
});
test('corsa non ancora partita: nessun anticipo sulle fermate successive; ritardo solo se la partenza è già in ritardo', () => {
  let vs = vsNew();
  // 5 minuti prima della partenza, feed con anticipi a valle e mezzo lontano (ancora sulla corsa precedente)
  let r = step(tracker, ctx, veh(2400, 8, { ts: 1 }), feed(0, -120), { tNow: BASE - 300, vs });
  for (let k = 0; k < 6; k++) assert.ok(r.etaMs[k] >= Date.UTC(2026, 9, 28, 10, 0, 0) + (ctx.st.d[k] - BASE) * 1000 - 1000, 'fermata ' + k + ' in anticipo');
  assert.ok(r.preStart);
  // fermo al capolinea 90 s dopo l'orario di partenza: le fermate successive slittano di almeno 90 s
  vs = vsNew();
  r = step(tracker, ctx, veh(0, 0, { ts: 1 }), null, { tNow: BASE + 120, vs });
  for (let k = 1; k < 6; k++) assert.ok(r.etaMs[k] >= Date.UTC(2026, 9, 28, 10, 0, 0) + (ctx.st.a[k] + 85 - BASE) * 1000, 'fermata ' + k + ' senza ritardo di partenza');
});

// ---- correzioni dal debug del 1° novembre 2026 ----
const T0 = Date.UTC(2026, 9, 28, 10, 0, 0), msAt = t => T0 + (t - BASE) * 1000;
test('capolinea, prima della partenza: il ritardo ACTV trascinato (+40) non vale, la partenza è all\'orario', () => {
  const vs = vsNew();
  let r = step(tracker, ctx, veh(0, 0, { ts: 1 }), feed(0, 2400), { tNow: BASE - 600, vs });
  r = step(tracker, ctx, veh(0, 0, { ts: 2 }), feed(0, 2400), { tNow: BASE - 580, vs });
  assert.equal(r.atStop, 0);
  assert.ok(Math.abs(r.etaMs[0] - msAt(ctx.st.d[0])) < 2000, 'partenza all\'orario');
  for (let k = 1; k < 6; k++) assert.ok(r.etaMs[k] - msAt(ctx.st.a[k]) < 60000, 'fermata ' + k + ' senza i 40 minuti trascinati');
});
test('previsione ACTV incoerente col GPS per oltre 2 minuti (mezzo in orario, ACTV +40): vale il ritardo misurato', () => {
  const vs = vsNew(); let r;
  for (let i = 0; i <= 16; i++) { const t = BASE + 140 + i * 10; r = step(tracker, ctx, veh(530 + i * 40, 4, { ts: 100 + i }), feed(2, 2400), { tNow: t, vs }); }
  const late = (r.etaMs[3] - msAt(ctx.st.a[3])) / 60000;
  assert.ok(late < 10, 'ritardo mostrato ' + late.toFixed(1) + ' min: non deve seguire i +40 di ACTV');
});
test('anticipo solo se confermato dalla posizione: mezzo in orario, ACTV -3 min, nessun anticipo', () => {
  const vs = vsNew(); let r;
  for (let i = 0; i < 4; i++) r = step(tracker, ctx, veh(620 + i * 30, 5, { ts: 200 + i }), feed(2, -180), { tNow: BASE + 160 + i * 6, vs });
  assert.ok(r.etaMs[2] >= msAt(ctx.st.a[2]) - 5000, 'nessun arrivo prima dell\'orario');
});
test('il ritardo non si recupera da solo: le fermate lontane non tornano in orario', () => {
  const vs = vsNew(), lv = feed(2, 300); lv.delays = [300, 300, 300, 240, 120, 0];   // ACTV prevede il recupero a valle
  let r; for (let i = 0; i < 3; i++) r = step(tracker, ctx, veh(700 + i * 30, 6, { ts: 300 + i }), lv, { tNow: BASE + 420 + i * 6, vs });
  const d2 = r.etaMs[2] - msAt(ctx.st.d[2]), d5 = r.etaMs[5] - msAt(ctx.st.a[5]);   // il tracker prevede la PARTENZA dalle fermate intermedie, l'arrivo al capolinea
  assert.ok(d5 >= d2 - 1000, 'ritardo a valle ' + Math.round(d5 / 1000) + ' s non inferiore a quello attuale ' + Math.round(d2 / 1000) + ' s');
});
test('arrivo al capolinea: fermo 200 m prima dell\'ultima fermata (altro stallo) = corsa conclusa', () => {
  const vs = vsNew(); let r;
  for (let i = 0; i < 3; i++) r = step(tracker, ctx, veh(2300, 0, { ts: 400 + i }), feed(5, 0), { tNow: BASE + 600 + i * 10, vs });
  assert.equal(r.phase, 'arrived');
});
// linea circolare: partenza e arrivo nello stesso punto
test('linea circolare: al capolinea il mezzo è all\'inizio del giro, non alla fine', () => {
  const { M_LON } = require('../geo'), ids = require('../ids'), LAT = 45.45, lonAt = m => 12.30 + m / M_LON;
  const pts = []; for (let m = 0; m <= 1500; m += 50) pts.push(LAT, lonAt(m)); for (let m = 1500; m >= 0; m -= 50) pts.push(LAT + 0.00004, lonAt(m));   // andata e ritorno affiancati
  const s = ['L0', 'L1', 'L2', 'L3', 'L4', 'L0'], pos = [0, 500, 1000, 1500, 750, 0], stopLoc = {};
  s.forEach((sid, k) => { stopLoc[sid] = [k >= 4 || k === 5 ? LAT + 0.00004 : LAT, lonAt(pos[k])]; }); stopLoc.L0 = [LAT + 0.00002, lonAt(0)];
  const d = [0, 120, 240, 360, 480, 600].map(x => BASE + x);
  const G = { routes: { R: { name: '24' } }, trips: { C: { route: 'R', shape: 'SH' } }, stops: {}, stopLoc, shapePts: { SH: Float32Array.from(pts) }, routeShapes: {}, calendar: {}, exByDate: {},
    stopTimes: new Map([['C', { s, q: Int32Array.from([1, 2, 3, 4, 5, 6]), a: Int32Array.from(d), d: Int32Array.from(d), start: d[0], end: d[5] }]]), stopIndex: {}, tripIds: ['C'], stopBaseNames: new Map(), stopIsRequest: new Map() };
  ids.attach(G);
  const c2 = { G, trip: G.trips.C, st: G.stopTimes.get('C') };
  const r = step(tracker, c2, { ...veh(0, 0, { ts: 1 }), lat: LAT + 0.00002, lon: lonAt(0) }, feed(0, 0, 6), { tNow: BASE - 60, vs: vsNew() });
  assert.equal(r.cur, 0, 'non deve risultare a fine giro');
});

// ---- registrazione del 6/11/2026 ----
test('capolinea raggiunto: un mezzo che riparte all\'indietro con la stessa corsa NON la riapre (niente riavvolgimenti)', () => {
  const vs = vsNew(), n = ctx.st.s.length, last = (n - 1) * 500;
  step(tracker, ctx, veh(last - 150, 6, { ts: 1000 }), feed(n - 1), { tNow: BASE + 590, vs });
  let r = step(tracker, ctx, veh(last, 0, { ts: 1010 }), feed(n - 1), { tNow: BASE + 600, vs });
  assert.equal(r.atStop, n - 1); assert.equal(r.phase, 'arrived');
  // riparte in senso opposto: 300, 600, 900 m indietro, rilevamenti nuovi
  for (const [k, back] of [[1, 300], [2, 600], [3, 900], [4, 1200]]) {
    r = step(tracker, ctx, veh(last - back, 6, { ts: 1010 + k * 15 }), null, { tNow: BASE + 600 + k * 15, vs });
    assert.ok(r.cur >= n - 1, `fermata tornata indietro a ${r.cur}`); assert.notEqual(r.src, 'gps-fix');
  }
});

test('previsione ACTV che cresce come l\'orologio, senza mezzo: dopo 10 minuti il ritardo non cresce più ed è «non confermato»', () => {
  const vs = vsNew(); let r;
  for (let m = 0; m <= 20; m++) {
    const lv = feed(2, 120 + m * 60);                                    // +1 minuto di ritardo ogni minuto
    r = step(tracker, ctx, null, lv, { tNow: BASE + 200 + m * 60, vs });
    if (m < 10) assert.equal(r.stale, null, `minuto ${m}: ancora confermato`);
  }
  assert.equal(r.stale?.why, 'nodata');
  assert.ok(r.delayS <= 180, `ritardo bloccato all'ultimo provato, non ${r.delayS} s (ACTV: ${120 + 20 * 60} s)`);
});

test('previsione ACTV stabile (mezzo in viaggio senza GPS nel feed): resta confermata', () => {
  const vs = vsNew(); let r;
  for (let m = 0; m <= 15; m++) r = step(tracker, ctx, null, feed(Math.min(5, 1 + Math.floor(m / 2)), 180), { tNow: BASE + 100 + m * 60, vs });
  assert.equal(r.stale, null);
});

test('mezzo fermo col GPS fresco lontano dalla fermata per oltre 10 minuti: «fermo», il ritardo (vero) continua a crescere', () => {
  const vs = vsNew(); let r, first = null;
  for (let m = 0; m <= 14; m++) {
    r = step(tracker, ctx, veh(1250 + (m % 2), 0, { ts: 1000 + m * 60, stillS: m * 60 }), null, { tNow: BASE + 300 + m * 60, vs });
    if (m === 1) first = r.delayS;
  }
  assert.equal(r.stale?.why, 'fermo');
  assert.ok(r.delayS > first + 600, 'il mezzo non si muove: il ritardo cresce davvero');
});

test('mezzo che non trasmette più, senza previsioni ACTV: dopo 10 minuti la stima è «senza dati» e il ritardo non cresce', () => {
  const long = makeG(6, { headway: 900 }), vs = vsNew();
  let r = step(tracker, long, veh(995, 0, { ts: 1000 }), null, { tNow: BASE + 1800, vs });
  const d0 = r.delayS;
  for (let m = 1; m <= 30; m++) r = step(tracker, long, veh(995, 0, { ts: 1000, ageS: m * 60 }), null, { tNow: BASE + 1800 + m * 60, vs });
  assert.equal(r.stale?.why, 'nodata');
  assert.ok(r.delayS <= d0 + 60, `ritardo cresciuto da ${d0} a ${r.delayS} s senza dati`);
});
