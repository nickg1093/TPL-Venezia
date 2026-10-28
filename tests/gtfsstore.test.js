const test = require('node:test');
const assert = require('node:assert');
const store = require('../gtfsstore');
const cal = require('../calendar');

// versione di prova: periodo [start, end] su tutti i giorni della settimana
const ver = (hash, start, end, o = {}) => ({ hash, file: `/x/${hash}.zip`, addedAt: o.addedAt ?? 0, match: o.match ?? null,
  info: { calendar: { S: { days: Array(7).fill(true), start, end } }, exByDate: o.ex || {}, feedStart: start, feedEnd: end, cover: cal.coverage({ S: { start, end } }, o.ex), from: start } });

test('sceglie la versione valida oggi, non l\'ultima scaricata', () => {
  const vecchia = ver('old', '20260101', '20261231'), futura = ver('new', '20261201', '20271130', { addedAt: 9 });
  const r = store.choose([vecchia, futura], '20261028');
  assert.equal(r.pick.hash, 'old'); assert.equal(r.approx, false);
  assert.deepEqual(r.pending.map(p => p.hash), ['new']);
});
test('la versione futura entra in vigore da sola alla sua data', () => {
  const vecchia = ver('old', '20260101', '20261231'), futura = ver('new', '20261201', '20271130');
  assert.equal(store.choose([vecchia, futura], '20261201').pick.hash, 'new');
});
test('tra due versioni valide prevale quella più recente in vigore', () => {
  assert.equal(store.choose([ver('a', '20261001', '20271001'), ver('b', '20261022', '20271021')], '20261028').pick.hash, 'b');
});
test('tra due valide, se il realtime combacia solo con la meno recente, si usa quella', () => {
  const r = store.choose([ver('a', '20261001', '20271001', { match: 0.95 }), ver('b', '20261022', '20271021', { match: 0.05 })], '20261028');
  assert.equal(r.pick.hash, 'a');
});
test('nessuna valida: si usa la più vicina e si segnala l\'approssimazione', () => {
  const r = store.choose([ver('scaduta', '20250101', '20251231'), ver('lontana', '20300101', '20301231')], '20261028');
  assert.equal(r.pick.hash, 'scaduta'); assert.equal(r.approx, true);
});
test('una versione con periodo valido ma senza servizi quel giorno non conta (eccezione di calendario)', () => {
  const v = ver('v', '20261001', '20271001', { ex: { '20261028': [['S', 2]] } });   // servizio soppresso proprio oggi
  const r = store.choose([v, ver('w', '20250101', '20251231')], '20261028');
  assert.equal(r.all.find(x => x.hash === 'v').valid, false);
});
test('nessuna versione: nessuna scelta, nessun errore', () => {
  const r = store.choose([], '20261028'); assert.equal(r.pick, null);
});
test('calendar.activeServices applica giorno della settimana, periodo ed eccezioni', () => {
  const c = { A: { days: [0, 1, 0, 0, 0, 0, 0].map(Boolean), start: '20261001', end: '20261231' } };
  assert.equal(cal.activeServices(c, {}, '20261026').size, 1);          // lunedì
  assert.equal(cal.activeServices(c, {}, '20261027').size, 0);          // martedì
  assert.equal(cal.activeServices(c, { '20261027': [['A', 1]] }, '20261027').size, 1);
  assert.equal(cal.activeServices(c, { '20261026': [['A', 2]] }, '20261026').size, 0);
});
