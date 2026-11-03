// PIANIFICA PERCORSO (percorso.js): GTFS sintetico con due servizi.
//   aut, linea 10: M0 → M1 → M2 (corse ogni 10 min dalle 08:00, 5 min tra fermate)
//   nav, linea 1: P0 → P1 → P2 (ogni 20 min dalle 08:00) — P0 è a 200 m da M2 (cambio a piedi in terraferma)
//   nav, linea 2: P2 → P0 (ritorno)
const test = require('node:test');
const assert = require('node:assert');
const percorso = require('../percorso');

const LAT = 45.49;
const lonAt = m => 12.20 + m / (111320 * Math.cos(LAT * Math.PI / 180));
function makeG(lines, stopsM) {
  const G = { routes: {}, trips: {}, stops: {}, stopLoc: {}, stopTimes: new Map(), stopIndex: {}, tripIds: [], shapePts: {}, meta: { hash: Math.random().toString(36) } };
  for (const [sid, m] of Object.entries(stopsM)) { G.stops[sid] = 'Fermata ' + sid; G.stopLoc[sid] = [LAT, lonAt(m)]; }
  for (const L of lines) {
    G.routes[L.route] = { name: L.name, color: '#123456' };
    const s = L.stops;
    for (let k = 0; k < L.n; k++) {
      const t0 = L.start + k * L.every, d = s.map((_, j) => t0 + j * L.hop), tid = `${L.route}_${k}`;
      G.trips[tid] = { route: L.route, headsign: 'Capolinea', service: 'S', shape: null };
      G.stopTimes.set(tid, { s, q: Int32Array.from(s.map((_, j) => j + 1)), a: Int32Array.from(d), d: Int32Array.from(d), start: d[0], end: d[d.length - 1] });
    }
  }
  G.tripIds = [...G.stopTimes.keys()];
  const idx = {}; G.tripIds.forEach((tid, n) => G.stopTimes.get(tid).s.forEach((sid, k) => (idx[sid] ||= []).push(n, k)));
  for (const k in idx) G.stopIndex[k] = Int32Array.from(idx[k]);
  return G;
}
const aut = makeG([{ route: 'A10', name: '10', stops: ['M0', 'M1', 'M2'], start: 8 * 3600, every: 600, hop: 300, n: 30 }], { M0: 0, M1: 1500, M2: 3000 });
const nav = makeG([{ route: 'N1', name: '1', stops: ['P0', 'P1', 'P2'], start: 8 * 3600, every: 1200, hop: 600, n: 15 },
  { route: 'N2', name: '2', stops: ['P2', 'P1', 'P0'], start: 8 * 3600 + 300, every: 1200, hop: 600, n: 15 }], { P0: 3200, P1: 5000, P2: 7000 });
percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [] });

test('una corsa: partenza, arrivo, nessun cambio', () => {
  const r = percorso.plan({ da: [['aut:M0', 0]], a: [['aut:M2', 0]], secs: 8 * 3600 + 120, date: '20261102' });
  const o = r.soluzioni[0];
  assert.equal(o.parti, '08:10'); assert.equal(o.arrivi, '08:20'); assert.equal(o.cambi, 0);
  assert.equal(o.tratte.filter(t => t.tipo === 'mezzo').length, 1);
});

test('bus + battello con cambio a piedi in terraferma (200 m) e margine per il battello', () => {
  const r = percorso.plan({ da: [['aut:M0', 0]], a: [['nav:P2', 0]], secs: 8 * 3600, date: '20261102' });
  const o = r.soluzioni[0], legs = o.tratte;
  assert.equal(o.cambi, 1);
  assert.deepEqual(legs.map(t => t.tipo), ['mezzo', 'piedi', 'mezzo']);
  // bus 08:00 → M2 08:10; a piedi ~3-4 min; battello delle 08:20 (non quello delle 08:00)
  assert.equal(legs[2].da.sched, '08:20'); assert.equal(o.arrivi, '08:40');
});

test('stessa linea a orari diversi: una sola proposta («famiglia») con le partenze successive', () => {
  const r = percorso.plan({ da: [['aut:M0', 0]], a: [['aut:M2', 0]], secs: 8 * 3600, date: '20261102' });
  assert.equal(r.soluzioni.length, 1);
  const o = r.soluzioni[0]; assert.equal(o.parti, '08:00');
  assert.deepEqual(o.poi.map(x => x.parti), ['08:10', '08:20', '08:30']);
  assert.match(o.famiglia, /^aut:A10@/); assert.deepEqual(o.rotte, ['aut:A10']);
});

test('partenza da un punto: fermata più vicina a piedi (linea d\'aria × 1,3), niente fermate oltre 1,5 km', () => {
  const r = percorso.plan({ da: [['aut:M1', 500]], a: [['aut:M2', 0]], secs: 8 * 3600, date: '20261102' });
  const w = r.soluzioni[0].tratte[0];
  assert.equal(w.tipo, 'piedi'); assert.ok(w.min >= 8 && w.min <= 10, 'circa 9 minuti per 500 m'); assert.equal(w.estremo, 'partenza');
  const n = percorso.plan({ da: [['aut:M0', 1600]], a: [['aut:M2', 0]], secs: 8 * 3600, date: '20261102' });
  assert.ok(n.soluzioni.length >= 1, 'la distanza viene limitata ma la fermata resta (il telefono manda solo quelle entro 1,5 km)');
});

test('dopo mezzanotte: corse del giorno di servizio precedente (orari 24:xx)', () => {
  const late = makeG([{ route: 'N', name: 'N', stops: ['M0', 'M2'], start: 24 * 3600 + 1800, every: 3600, hop: 900, n: 2 }], { M0: 0, M2: 3000 });
  percorso.init({ G: i => (i === 'aut' ? late : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [] });
  const r = percorso.plan({ da: [['aut:M0', 0]], a: [['aut:M2', 0]], secs: 1200, date: '20261103' });
  assert.equal(r.soluzioni[0].parti, '00:30'); assert.equal(r.soluzioni[0].arrivi, '00:45');
  percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [] });
});

test('in laguna niente scorciatoie: fermate non collegate dalla rete pedonale non si raggiungono a piedi', () => {
  // dati di prova propri (non i file veri, che cambiano a ogni rigenerazione): due pontili a 195 m in linea d'aria su rive opposte
  const os = require('os'), fs = require('fs'), path = require('path');
  const { walkTo } = percorso._t;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedonale-'));
  const G = makeG([{ route: 'X', name: 'X', stops: ['5042', '5043'], start: 8 * 3600, every: 600, hop: 300, n: 2 }], { 5042: 0, 5043: 195 });
  const ctx = { G: i => (i === 'nav' ? G : aut), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [], walkDir: dir };
  try {
    // nessun cammino tra le due rive nel file: dal punto si raggiunge solo il pontile della propria riva
    fs.writeFileSync(path.join(dir, 'pedonale-laguna.txt'), '# prova\nn5042,n5043\n\n');
    percorso.init(ctx); percorso.build();
    let m = walkTo([['nav:5043', 40], ['nav:5042', 170]]);
    assert.ok(m.has(percorso._t.IX.gid.get('nav:5043')));
    assert.ok(!m.has(percorso._t.IX.gid.get('nav:5042')), 'l\'altra riva non è raggiungibile dal punto');
    // con un cammino vero (giro dal ponte, 1622 m) l'altra riva si raggiunge, ma con il tempo del giro, non della linea d'aria
    fs.writeFileSync(path.join(dir, 'pedonale-laguna.txt'), `# prova\nn5042,n5043\n0.1.${(1622).toString(36)}\n`);
    percorso.init(ctx); percorso.build();
    m = walkTo([['nav:5043', 40], ['nav:5042', 170]]);
    const s = m.get(percorso._t.IX.gid.get('nav:5042'));
    assert.ok(s > 15 * 60, 'a piedi lungo il giro: ' + s + ' s');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [] });
  }
});

test('tempo reale: un ritardo del mezzo sposta la coincidenza', () => {
  // la corsa A10_0 (08:00) è in ritardo di 12 min: con il tempo reale arriva a M2 alle 08:22 e perde il battello delle 08:20
  const now = Date.now(), cal = require('../calendar'), T = cal.romeParts(now).secs;
  const shift = T - (8 * 3600 - 120);                                      // si sposta l'orario sintetico: "adesso" = 2 minuti prima delle 08:00
  const A = makeG([{ route: 'A10', name: '10', stops: ['M0', 'M1', 'M2'], start: 8 * 3600 + shift, every: 600, hop: 300, n: 3 }], { M0: 0, M1: 1500, M2: 3000 });
  const N = makeG([{ route: 'N1', name: '1', stops: ['P0', 'P1', 'P2'], start: 8 * 3600 + shift, every: 1200, hop: 600, n: 4 }], { P0: 3200, P1: 5000, P2: 7000 });
  const live = { A10_0: { delays: [720, 720, 720], cancelled: false, skipped: new Set(), firstJ: 0 } };
  percorso.init({ G: i => (i === 'aut' ? A : N), state: () => ({}), live: i => (i === 'aut' ? live : {}), serviceActive: () => true, actvPlan: () => null, rows: () => [] });
  const r = percorso.plan({ da: [['aut:M0', 0]], a: [['nav:P2', 0]], date: cal.romeYmd(now) });
  assert.ok(r.soluzioni.length, 'soluzioni trovate');
  for (const o of r.soluzioni) { const b = o.tratte.filter(t => t.tipo === 'mezzo'); if (b[0].tripId === 'A10_0') assert.notEqual(b[1]?.tripId, 'N1_1', 'con 12 minuti di ritardo il battello delle 08:20 non si prende'); }
  const nolive = (() => { percorso.init({ G: i => (i === 'aut' ? A : N), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [] }); return percorso.plan({ da: [['aut:M0', 0]], a: [['nav:P2', 1] /* chiave di cache diversa */], date: cal.romeYmd(now) }); })();
  assert.ok(nolive.soluzioni.some(o => o.tratte.filter(t => t.tipo === 'mezzo').map(t => t.tripId).join() === 'A10_0,N1_1'), 'senza ritardo la coincidenza delle 08:20 c\'è');
  percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [] });
});

test('arrivo entro le: partenze il più tardi possibile, nessun arrivo oltre l\'orario', () => {
  percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [] });
  // bus ogni 10 min, 10 min di viaggio M0 → M2: per arrivare entro le 09:05 l'ultima corsa utile parte alle 08:50 (arrivo 09:00)
  const r = percorso.plan({ da: [['aut:M0', 0]], a: [['aut:M2', 0]], secs: 9 * 3600 + 300, date: '20261102', entro: true });
  assert.equal(r.entro, '09:05');
  assert.ok(r.soluzioni.length >= 1);
  for (const o of r.soluzioni) assert.ok(o.arrivi <= '09:05', 'arrivo ' + o.arrivi);
  assert.equal(r.soluzioni[0].parti, '08:50');                     // la partenza più tarda, con quelle prima tra gli «altri orari»
  assert.deepEqual(r.soluzioni[0].poi.map(x => x.parti), ['08:40', '08:30', '08:20']);
  // con cambio bus + battello (battello ogni 20 min): entro le 09:00 → battello delle 08:20 da P0 (arrivo 08:40); quello delle 08:40 arriva alle 09:00
  const b = percorso.plan({ da: [['aut:M0', 0]], a: [['nav:P2', 0]], secs: 9 * 3600, date: '20261102', entro: true });
  const last = b.soluzioni[0];
  assert.equal(last.arrivi, '09:00'); assert.equal(last.tratte.filter(t => t.tipo === 'mezzo')[1].da.sched, '08:40');
});

test('ogni tratta indica le posizioni di salita e discesa nella corsa', () => {
  const r = percorso.plan({ da: [['aut:M1', 0]], a: [['aut:M2', 0]], secs: 8 * 3600, date: '20261102' });
  const t = r.soluzioni[0].tratte.find(x => x.tipo === 'mezzo');
  assert.deepEqual(t.pos, [1, 2]); assert.equal(t.stops.length, 2);
});

test('terraferma: con la rete pedonale (pedonale-terraferma.txt) i cambi seguono le strade, non la linea d\'aria', () => {
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedonale-'));
  const ctx = { G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [], walkDir: dir };
  try {
    // M2 e P0 sono a 200 m in linea d'aria, ma a piedi (es. sottopasso della ferrovia) ce ne vogliono 650: 8-9 minuti, si perde il battello delle 08:20
    fs.writeFileSync(path.join(dir, 'pedonale-terraferma.txt'), '# prova\naM0,aM1,aM2,nP0,nP1,nP2\n2.3.i2\n');
    percorso.init(ctx);
    const o = percorso.plan({ da: [['aut:M0', 0]], a: [['nav:P2', 0]], secs: 8 * 3600, date: '20261102' }).soluzioni[0];
    assert.equal(o.tratte[1].tipo, 'piedi'); assert.ok(o.tratte[1].min >= 8 && o.tratte[1].min <= 9, 'a piedi ' + o.tratte[1].min + ' min');
    assert.equal(o.tratte[2].da.sched, '08:40'); assert.equal(o.arrivi, '09:00');
    // nessun cammino sulla rete (fiume, ferrovia senza passaggi): niente cambio a piedi, anche se vicine in linea d'aria
    fs.writeFileSync(path.join(dir, 'pedonale-terraferma.txt'), '# prova\naM0,aM1,aM2,nP0,nP1,nP2\n\n');
    percorso.init(ctx);
    assert.equal(percorso.plan({ da: [['aut:M0', 0]], a: [['nav:P2', 0]], secs: 8 * 3600, date: '20261102' }).soluzioni.length, 0);
    // fermata lontana dalla rete (riga 3): torna la linea d'aria × 1,3
    fs.writeFileSync(path.join(dir, 'pedonale-terraferma.txt'), '# prova\naM0,aM1,aM2,nP0,nP1,nP2\n\n2\n');
    percorso.init(ctx);
    assert.equal(percorso.plan({ da: [['aut:M0', 0]], a: [['nav:P2', 0]], secs: 8 * 3600, date: '20261102' }).soluzioni[0].arrivi, '08:40');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [] });
  }
});

test('filtri: mezzi ammessi, cambi massimi, passo', () => {
  const base = { da: [['aut:M0', 0]], a: [['nav:P2', 0]], secs: 8 * 3600, date: '20261102' };
  assert.equal(percorso.plan({ ...base, prefs: { mezzi: new Set(['bus']) } }).soluzioni.length, 0, 'senza battelli non si arriva a P2');
  assert.equal(percorso.plan({ ...base, prefs: { cambi: 0 } }).soluzioni.length, 0, 'solo diretti: nessuna soluzione');
  assert.equal(percorso.plan({ ...base, prefs: { cambi: 1 } }).soluzioni[0].arrivi, '08:40');
  const walk = passo => percorso.plan({ da: [['aut:M1', 500]], a: [['aut:M2', 0]], secs: 8 * 3600, date: '20261102', prefs: { passo } }).soluzioni[0].tratte[0].min;
  assert.ok(walk('veloce') < walk('normale') && walk('normale') < walk('lento'), `${walk('veloce')} < ${walk('normale')} < ${walk('lento')}`);
});

test('niente cambi inutili: una linea che arriva 30 s prima non vale un cambio', () => {
  const lat = 45.49, lon = m => 12.20 + m / (111320 * Math.cos(lat * Math.PI / 180));
  const mk = (route, name, stops, times, n) => ({ route, name, stops, times, n });
  const G = { routes: { L1: { name: '1', color: '#111111', type: 3 }, L2: { name: '2', color: '#222222', type: 3 } }, trips: {}, stops: {}, stopLoc: {}, stopTimes: new Map(), stopIndex: {}, tripIds: [], shapePts: {}, meta: { hash: 'inutili' } };
  for (const [sid, m] of Object.entries({ S0: 0, S1: 1500, S2: 3000 })) { G.stops[sid] = 'Fermata ' + sid; G.stopLoc[sid] = [lat, lon(m)]; }
  // linea 1: S0 08:00 → S1 08:05 → S2 08:10; linea 2: S1 08:06 → S2 08:09:30 (arriva 30 s prima, ma bisogna scendere e cambiare)
  for (const L of [mk('L1', '1', ['S0', 'S1', 'S2'], [0, 300, 600], 8 * 3600), mk('L2', '2', ['S1', 'S2'], [0, 210], 8 * 3600 + 360)]) {
    const d = L.times.map(x => L.n + x), tid = L.route + '_0';
    G.trips[tid] = { route: L.route, headsign: 'S2', service: 'S', shape: null };
    G.stopTimes.set(tid, { s: L.stops, q: Int32Array.from(L.stops.map((_, j) => j + 1)), a: Int32Array.from(d), d: Int32Array.from(d), start: d[0], end: d[d.length - 1] });
  }
  G.tripIds = [...G.stopTimes.keys()];
  const idx = {}; G.tripIds.forEach((tid, n) => G.stopTimes.get(tid).s.forEach((sid, k) => (idx[sid] ||= []).push(n, k)));
  for (const k in idx) G.stopIndex[k] = Int32Array.from(idx[k]);
  const empty = { routes: {}, trips: {}, stops: {}, stopLoc: {}, stopTimes: new Map(), stopIndex: {}, tripIds: [], shapePts: {}, meta: { hash: 'vuoto' } };
  try {
    percorso.init({ G: i => (i === 'aut' ? G : empty), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [] });
    for (const pref of ['equilibrata', 'veloce']) {
      const r = percorso.plan({ da: [['aut:S0', 0]], a: [['aut:S2', 0]], secs: 8 * 3600 - 60, date: '20261102', prefs: { pref } });
      assert.equal(r.soluzioni.length, 1, pref); assert.equal(r.soluzioni[0].cambi, 0, pref); assert.equal(r.soluzioni[0].arrivi, '08:10');
    }
  } finally {
    percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [] });
  }
});

test('alternative di una soluzione: stesso percorso ad altri orari', () => {
  const p = { da: [['aut:M0', 0]], a: [['nav:P2', 0]], secs: 8 * 3600 + 1500, date: '20261102' };
  const o = percorso.plan(p).soluzioni[0];
  const s = percorso.simili({ ...p, fam: o.famiglia, rotte: o.rotte });
  assert.ok(s.stesso.length >= 3, 'altri orari: ' + s.stesso.length);
  assert.ok(s.stesso.every(x => x.famiglia === o.famiglia));
  assert.ok(s.stesso.some(x => x.parti < o.parti) && s.stesso.some(x => x.parti > o.parti), 'prima e dopo: ' + s.stesso.map(x => x.parti));
  assert.deepEqual(s.altre, []);                                // nessun'altra linea collega M0 e P2
});

test('tutto a piedi: anche passando per altre fermate della rete pedonale (copertura oltre le coppie precalcolate)', () => {
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedonale-'));
  try {
    // M0-M1 e M1-M2 collegate a piedi (600 m ciascuna), M0-M2 no: a piedi si va comunque, passando da M1 (1200 m)
    fs.writeFileSync(path.join(dir, 'pedonale-terraferma.txt'), '# prova\naM0,aM1,aM2,nP0,nP1,nP2\n0.1.go 1.2.go\n');
    percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [], walkDir: dir });
    const r = percorso.plan({ da: [['aut:M0', 0]], a: [['aut:M2', 0]], secs: 8 * 3600, date: '20261102' });
    assert.equal(r.piedi, Math.round(1200 / percorso.C.V_MAIN / 60));
    const v = percorso.plan({ da: [['aut:M0', 0]], a: [['aut:M2', 0]], secs: 8 * 3600, date: '20261102', prefs: { passo: 'veloce' } });
    assert.ok(v.piedi < r.piedi, 'passo svelto: meno minuti');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, actvPlan: () => null, rows: () => [] });
  }
});
