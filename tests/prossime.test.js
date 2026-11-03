// FERMATE SUCCESSIVE (prossime.js): nomi di base, destinazione esclusa in fondo, raggruppamenti, limite, chiavi condivise.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../prossime');

test('in fondo si tolgono le fermate con nome uguale o simile alla destinazione', () => {
  assert.deepEqual(P.build(['Arsenale "A"', 'Giardini', 'S.Elena-Stadio Penzo', 'Lido S.M.E. "B"', 'Lido S.M.E. "A"'], 'Lido S.M.E. "A"').s, ['Arsenale', 'Giardini', 'S.Elena-Stadio Penzo']);
  assert.deepEqual(P.build(['Olivi', 'MESTRE CENTRO B3'], 'Mestre Centro B1').s, ['Olivi']);
  assert.deepEqual(P.build(['Zitelle', 'Redentore'], 'Murano Museo').s, ['Zitelle', 'Redentore'], 'nomi diversi restano');
});
test('raggruppamento per inizio comune (mai su un inizio generico da solo)', () => {
  const r = P.build(['San Marco Manuzio', 'San Marco Cattaneo', 'San Marco Musatti', 'Forte Marghera', 'Via Piave', 'Via Cappuccina'], 'Venezia');
  assert.deepEqual(r.s, [['San Marco', ['Manuzio', 'Cattaneo', 'Musatti']], 'Forte Marghera', 'Via Piave', 'Via Cappuccina']);
  assert.deepEqual(P.build(['Castellana Santa Chiara', 'Castellana Cipressina', 'Zelarino'], 'Noale').s, [['Castellana', ['Santa Chiara', 'Cipressina']], 'Zelarino']);
});
test('al massimo 12 nomi, poi «altre» (m)', () => {
  const names = Array.from({ length: 20 }, (_, k) => 'Fermata' + k);
  const r = P.build(names, 'Capolinea'); assert.equal(r.s.length, 12); assert.equal(r.m, true);
  assert.equal(P.build(names.slice(0, 12), 'Capolinea').m, undefined);
});
test('doppioni di fila uniti (pontili diversi della stessa fermata)', () => {
  assert.deepEqual(P.build(['Rialto "A"', 'Rialto "B"', 'Ca\' d\'Oro'], 'P.le Roma').s, ['Rialto', 'Ca\' d\'Oro']);
});
test('attach: corse con le stesse fermate condividono lo stesso elenco; nessun elenco per gli arrivi', () => {
  const s = ['A', 'B', 'C', 'D'];
  const G = { stopTimes: new Map([['t1', { s }], ['t2', { s }]]), trips: { t1: { headsign: 'Delta' }, t2: { headsign: 'Delta' } }, stops: { A: 'Alfa', B: 'Beta', C: 'Gamma', D: 'Delta' }, stopBaseNames: new Map() };
  const rows = [{ tripId: 't1', seq: 0 }, { tripId: 't2', seq: 0 }, { tripId: 't1', seq: 3, arrival: true }];
  for (const r of rows) Object.defineProperty(r, '_G', { value: G, enumerable: false });
  const nexts = P.attach(rows);
  assert.equal(rows[0].nx, rows[1].nx); assert.equal(rows[2].nx, undefined);
  assert.deepEqual(nexts[rows[0].nx].s, ['Beta', 'Gamma']);
  assert.equal(JSON.stringify(rows[0]).includes('_G'), false, 'la versione del GTFS non va nella risposta');
});
