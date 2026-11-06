// TURNO DEL MEZZO (turni.js): mezzo molto in ritardo sulla corsa del feed che fa di fatto la corsa successiva.
// GTFS sintetico: linea T1, fermate F0..F3, corse ogni N minuti; la fermata considerata è F1 (indice 1).
const test = require('node:test');
const assert = require('node:assert');
const cal = require('../calendar');
const ids = require('../ids');
const turni = require('../turni');

const now = Date.now(), S0 = cal.romeParts(now).secs, base = Math.floor(S0 / 60) * 60;
const tNowOf = () => S0 + (now % 1000) / 1000, activeNow = () => true;
// trips: [{ id, off: minuti della partenza da F1 rispetto ad adesso, stops?: elenco fermate }]
function makeG(trips) {
  const G = { routes: { R: { name: 'T1' } }, trips: {}, stops: {}, stopLoc: {}, stopTimes: new Map(), stopIndex: {}, tripIds: [], stopBaseNames: new Map() };
  for (const t of trips) {
    const s = t.stops || ['F0', 'F1', 'F2', 'F3'], t1 = base + t.off * 60, d = s.map((_, k) => t1 + (k - 1) * 120);
    G.trips[t.id] = { route: 'R', headsign: 'Favaro', service: 'SV', shape: null };
    G.stopTimes.set(t.id, { s, a: Int32Array.from(d), d: Int32Array.from(d), start: d[0], end: d[d.length - 1] });
    for (const x of s) G.stops[x] = x;
  }
  G.tripIds = [...G.stopTimes.keys()];
  const idx = {}; G.tripIds.forEach((tid, n) => G.stopTimes.get(tid).s.forEach((sid, k) => (idx[sid] ||= []).push(n, k)));
  for (const k in idx) G.stopIndex[k] = Int32Array.from(idx[k]);
  ids.attach(G);
  return G;
}
// stato del ciclo precedente: il mezzo `veh` sulla corsa tid, prossima fermata F1, atteso fra etaMin minuti (o fermo in F1)
// tempi sulla stessa griglia degli orari (minuti dall'inizio del minuto corrente)
const at = m => now + ((base - S0) + m * 60) * 1000 - (now % 1000);
// come lo stato vero del tracker per un mezzo col GPS fresco sul percorso (sVeh = posizione lungo il tracciato, stima confermata)
const ps = (veh, etaMin, atStop = false, extra = {}) => ({ vehKey: veh, label: veh, cur: 1, atStop: atStop ? 1 : -1, etaMs: [NaN, atStop ? now : at(etaMin), NaN, NaN], dayOff: 0, sVeh: 500, stale: null, fixAt: null, ...extra });
const veh = (key, tripId, ts = 1) => ({ key, tripId, ts });
function run({ G, vehicles, prev, vehOfTu = new Map(), mem = new Map(), check = null, times = 2 }) {
  let out;
  for (let k = 0; k < times; k++) { vehicles.forEach(v => { v.ts = (v.ts || 0) + 1; }); out = turni.plan({ G, vehicles, prev, vehOfTu, mem, nowMs: now, tNowOf, activeNow, check }); }
  return out;
}

test('tram dichiarato sulla corsa delle +5 che passa alle +21: fa la corsa delle +20 (dopo 2 rilevamenti)', () => {
  const G = makeG([{ id: 'A', off: 5 }, { id: 'B', off: 20 }]), mem = new Map(), vehicles = [veh('TRAM_12', 'A')], prev = { A: ps('TRAM_12', 21.5) };
  assert.equal(run({ G, vehicles, prev, mem, times: 1 }).size, 0, 'un solo rilevamento: nessun cambio');
  const out = run({ G, vehicles, prev, mem, times: 1 });
  assert.deepEqual(out.get('TRAM_12'), { from: 'A', to: 'B', k: 1 });
});

test('ritardo fino a 10 minuti: nessun cambio (due mezzi ravvicinati veri)', () => {
  const G = makeG([{ id: 'A', off: 5 }, { id: 'B', off: 14 }]);
  assert.equal(run({ G, vehicles: [veh('BUS_1', 'A')], prev: { A: ps('BUS_1', 14.5) } }).size, 0);
});

test('corsa candidata già fatta da un altro mezzo (posizione o previsione ACTV): nessun cambio', () => {
  const G = makeG([{ id: 'A', off: 5 }, { id: 'B', off: 20 }]);
  assert.equal(run({ G, vehicles: [veh('T1', 'A'), veh('T2', 'B')], prev: { A: ps('T1', 21.5), B: ps('T2', 30) } }).has('T1'), false);
  assert.equal(run({ G, vehicles: [veh('T1', 'A')], prev: { A: ps('T1', 21.5) }, vehOfTu: new Map([['B', 'T9']]) }).size, 0);
});

test('percorso diverso da quella fermata in poi (altra direzione o deviazione): nessun cambio', () => {
  const G = makeG([{ id: 'A', off: 5 }, { id: 'B', off: 20, stops: ['F0', 'F1', 'X2', 'F3'] }]);
  assert.equal(run({ G, vehicles: [veh('T1', 'A')], prev: { A: ps('T1', 21.5) } }).size, 0);
});

test('fuori finestra (oltre 5 min dopo o 2 min prima dell\'orario): nessun cambio', () => {
  const G = makeG([{ id: 'A', off: 5 }, { id: 'B', off: 20 }]);
  assert.equal(run({ G, vehicles: [veh('T1', 'A')], prev: { A: ps('T1', 26) } }).size, 0);
  assert.equal(run({ G, vehicles: [veh('T1', 'A')], prev: { A: ps('T1', 17.5) } }).size, 0);
});

test('tram fermo al capolinea con la corsa di 86 min prima: la prima corsa che parte entro 15 minuti', () => {
  const G = makeG([{ id: 'A', off: -86 }, { id: 'B', off: 4 }, { id: 'C', off: 19 }]);
  const out = run({ G, vehicles: [veh('TRAM_06', 'A')], prev: { A: ps('TRAM_06', 0.2, true) } });
  assert.equal(out.get('TRAM_06').to, 'B');
});

test('la centrale ACTV dà la corsa candidata in tempo reale a un altro istante: nessun cambio', () => {
  const G = makeG([{ id: 'A', off: 5 }, { id: 'B', off: 20 }]);
  assert.equal(run({ G, vehicles: [veh('T1', 'A')], prev: { A: ps('T1', 21.5) }, check: () => 'contro' }).size, 0);
});

test('scelta mantenuta nei cicli successivi (stato sulla corsa nuova), con margine più largo', () => {
  const G = makeG([{ id: 'A', off: 5 }, { id: 'B', off: 20 }]), mem = new Map(), vehicles = [veh('T1', 'A')];
  run({ G, vehicles, prev: { A: ps('T1', 21.5) }, mem });
  // ciclo dopo: il feed dice ancora A; lo stato è su B (il mezzo ora arriva alle +26: 6 min dopo B, dentro il margine di 8)
  const out = run({ G, vehicles, prev: { B: ps('T1', 26) }, mem, times: 1 });
  assert.equal(out.get('T1')?.to, 'B');
  // il mezzo recupera il ritardo sulla corsa del feed (arriva alle +12, +7 su A): torna su A
  assert.equal(run({ G, vehicles, prev: { B: ps('T1', 12) }, mem, times: 1 }).size, 0);
});

test('un mezzo per corsa: due mezzi in ritardo, la corsa al primo che passa', () => {
  const G = makeG([{ id: 'A1', off: 2 }, { id: 'A2', off: 3 }, { id: 'B', off: 20 }]);
  const out = run({ G, vehicles: [veh('T1', 'A1'), veh('T2', 'A2')], prev: { A1: ps('T1', 21), A2: ps('T2', 22) } });
  assert.equal(out.get('T1')?.to, 'B'); assert.equal(out.has('T2'), false);
});

test('fermo al capolinea oltre l\'orario della corsa scelta (partenza in ritardo): la scelta resta, niente rimbalzi', () => {
  const G = makeG([{ id: 'A', off: -86 }, { id: 'B', off: 2 }, { id: 'C', off: 17 }]), mem = new Map(), vehicles = [veh('TRAM_06', 'A')];
  assert.equal(run({ G, vehicles, prev: { A: ps('TRAM_06', 0, true) }, mem }).get('TRAM_06').to, 'B');
  // 4 minuti dopo: la partenza di B (+2) è passata da 2 minuti, il tram è ancora fermo
  const later = { B: { ...ps('TRAM_06', 0, true) } };
  assert.equal(turni.plan({ G, vehicles, prev: later, mem, nowMs: now + 4 * 60e3, tNowOf: () => tNowOf() + 240, activeNow }).get('TRAM_06')?.to, 'B');
});

// ---- prudenza (registrazione del 6/11/2026) ----
test('nessuno spostamento senza GPS fresco sul percorso, con GPS bloccato o con stima senza dati', () => {
  const G = makeG([{ id: 'A', off: 5 }, { id: 'B', off: 20 }]);
  assert.equal(run({ G, vehicles: [veh('T1', 'A')], prev: { A: ps('T1', 21.5, false, { sVeh: null }) } }).size, 0, 'senza posizione sul percorso');
  assert.equal(run({ G, vehicles: [{ ...veh('T1', 'A'), frozen: true }], prev: { A: ps('T1', 21.5) } }).size, 0, 'GPS bloccato');
  assert.equal(run({ G, vehicles: [veh('T1', 'A')], prev: { A: ps('T1', 21.5, false, { stale: { why: 'nodata' } }) } }).size, 0, 'stima senza dati');
  assert.equal(run({ G, vehicles: [veh('T1', 'A')], prev: { A: ps('T1', 21.5, false, { stale: { why: 'fermo' } }) } }).get('T1')?.to, 'B', 'mezzo fermo col GPS fresco: la regola resta valida');
});

test('posizione corretta all\'indietro da poco: nessuno spostamento per 5 minuti', () => {
  const G = makeG([{ id: 'A', off: 5 }, { id: 'B', off: 20 }]);
  assert.equal(run({ G, vehicles: [veh('T1', 'A')], prev: { A: ps('T1', 21.5, false, { fixAt: now - 60e3 }) } }).size, 0);
  assert.equal(run({ G, vehicles: [veh('T1', 'A')], prev: { A: ps('T1', 21.5, false, { fixAt: now - 400e3 }) } }).get('T1')?.to, 'B', 'correzione vecchia: vale di nuovo');
});

test('mezzo che va all\'indietro lungo il percorso: nessuno spostamento', () => {
  const G = makeG([{ id: 'A', off: 5 }, { id: 'B', off: 20 }]), mem = new Map(), vehicles = [veh('T1', 'A')];
  run({ G, vehicles, prev: { A: ps('T1', 21.5, false, { sVeh: 2000 }) }, mem, times: 1 });
  assert.equal(run({ G, vehicles, prev: { A: ps('T1', 21.5, false, { sVeh: 1500 }) }, mem, times: 1 }).size, 0);
});

test('spostamento annullato: per 5 minuti nessun nuovo spostamento (niente avanti e indietro)', () => {
  const G = makeG([{ id: 'A', off: 5 }, { id: 'B', off: 20 }]), mem = new Map(), vehicles = [veh('T1', 'A')];
  assert.equal(run({ G, vehicles, prev: { A: ps('T1', 21.5) }, mem }).get('T1')?.to, 'B');
  // il ciclo dopo il mezzo è sulla corsa B ma la sua posizione non è più utilizzabile: lo spostamento si annulla
  assert.equal(run({ G, vehicles, prev: { B: ps('T1', 21.5, false, { sVeh: null }) }, mem, times: 1 }).size, 0);
  // torna il GPS buono: per 5 minuti niente nuovo spostamento
  assert.equal(run({ G, vehicles, prev: { A: ps('T1', 21.5) }, mem }).size, 0);
  assert.ok(mem.get('T1').coolUntil > now);
});
