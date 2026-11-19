// PIANIFICATORE v28: salita alla fermata più comoda della stessa corsa, cambi con meno strada a piedi, «arrivo entro» = ultima partenza
// utile anche con mezzi molto frequenti, costo che conta la durata. GTFS sintetico (un solo processo per file di prova: indice proprio).
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
// aut, linea 10: M0 → M1 → M2 → M3 (ogni 10 min, 5 min tra fermate); linea 20: F0 → F1 molto frequente (ogni 2 min, 12 min di viaggio)
const aut = makeG([
  { route: 'A10', name: '10', stops: ['M0', 'M1', 'M2', 'M3'], start: 7 * 3600, every: 600, hop: 300, n: 60 },
  { route: 'A20', name: '20', stops: ['F0', 'F1'], start: 6 * 3600, every: 120, hop: 720, n: 400 }
], { M0: 0, M1: 400, M2: 3000, M3: 6000, F0: 20000, F1: 26000 });
const nav = makeG([], {});
percorso.init({ G: i => (i === 'aut' ? aut : nav), state: () => ({}), live: () => ({}), serviceActive: () => true, rows: () => [] });
const toS = hm => { const [h, m] = hm.split(':').map(Number); return h * 3600 + m * 60; };

test('sale alla fermata più vicina quando la stessa corsa ci passa poco dopo (non a quella più lontana)', () => {
  // alle 07:54:30: M0 a 250 m (≈ 4 min: corsa delle 08:00), M1 a 40 m (≈ 40 s: la corsa delle 07:55 è appena persa). La corsa delle
  // 08:00 da M0 passa da M1 alle 08:05: stessa corsa, stesso arrivo, 4 minuti a piedi in meno -> si sale a M1
  const r = percorso.plan({ da: [['aut:M0', 250], ['aut:M1', 40]], a: [['aut:M3', 0]], secs: 7 * 3600 + 54 * 60 + 30, date: '20261117' });
  const o = r.soluzioni[0], ride = o.tratte.find(t => t.tipo === 'mezzo');
  assert.equal(ride.da.id, 'aut:M1', 'sale a M1');
  assert.equal(ride.da.sched, '08:05'); assert.equal(o.arrivi, '08:15');
  assert.ok(o.piedi <= 1, `a piedi ${o.piedi} min`);
});

test('«arrivo entro» con mezzi ogni 2 minuti: l\'ultima partenza utile (prima si arrivava 10-30 minuti prima)', () => {
  const r = percorso.plan({ da: [['aut:F0', 0]], a: [['aut:F1', 0]], secs: 9 * 3600, date: '20261117', entro: true });
  const o = r.soluzioni[0];
  assert.equal(o.arrivi, '09:00'); assert.equal(o.parti, '08:48');
  assert.ok(r.soluzioni.every(s => toS(s.arrivi) <= 9 * 3600), 'nessuno arriva tardi');
  assert.ok(r.soluzioni.every(s => toS(s.parti) >= toS('08:48') - 25 * 60), 'nessuna proposta parte più di 25 minuti prima dell\'ultima utile');
});

test('«arrivo entro»: alle 09:00 va bene chi arriva alle 09:00 e qualche secondo (orari al minuto)', () => {
  // corsa delle 08:48, a F1 alle 09:00, poi 30 m a piedi (≈ 30 s): si legge «arrivo 09:00»
  const r = percorso.plan({ da: [['aut:F0', 0]], a: [['aut:F1', 30]], secs: 9 * 3600, date: '20261117', entro: true });
  assert.equal(r.soluzioni[0].arrivi, '09:00'); assert.equal(r.soluzioni[0].parti, '08:48');
});

test('preferenze v28: «Camminare meno» e «Meno cambi» accettate; «veloce» (vecchi link) come «Arrivare prima»', () => {
  for (const pref of ['equilibrata', 'piedi', 'cambi', 'veloce']) {
    const r = percorso.plan({ da: [['aut:M0', 0]], a: [['aut:M3', 0]], secs: 8 * 3600, date: '20261117', prefs: { pref } });
    assert.equal(r.soluzioni[0].arrivi, '08:15', pref);
  }
});

test('v28: nessun tempo fisso per salire: chi è già alla fermata alle 08:00 prende la corsa delle 08:00', () => {
  const r = percorso.plan({ da: [['aut:M0', 0]], a: [['aut:M3', 0]], secs: 8 * 3600, date: '20261117' });
  assert.equal(r.soluzioni[0].parti, '08:00');
});

// v33.1 · ANDATURE con un cambio a piedi tra bus e battello: «Svelta» prende la coincidenza stretta, «Con calma» (passo lento + 2 minuti) no
test('andature: Svelta, Normale e Con calma con un cambio bus → battello', () => {
  const A = makeG([{ route: 'B1', name: '1', stops: ['S0', 'S1'], start: 8 * 3600, every: 3600, hop: 600, n: 2 }], { S0: 0, S1: 3000 });
  const N = makeG([{ route: 'V1', name: '1', stops: ['W0', 'W1'], start: 8 * 3600 + 14 * 60, every: 900, hop: 600, n: 6 }], { W0: 3150, W1: 6000 });
  percorso.init({ G: i => (i === 'aut' ? A : N), state: () => ({}), live: () => ({}), serviceActive: () => true, rows: () => [] });
  const boatOf = p => { const r = percorso.plan({ da: [['aut:S0', 0]], a: [['nav:W1', 0]], secs: 8 * 3600, date: '20261102', prefs: p }); return r.soluzioni[0].tratte.filter(t => t.tipo === 'mezzo')[1].da.sched; };
  assert.equal(boatOf({ passo: 'veloce' }), '08:14');
  assert.equal(boatOf({}), '08:14');
  assert.equal(boatOf({ passo: 'lento', margine: 'largo' }), '08:29', 'con calma: il battello dopo');
});
