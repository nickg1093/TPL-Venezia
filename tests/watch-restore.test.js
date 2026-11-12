// AVVISI DI ARRIVO dopo un riavvio del server (watch.restore): il telefono ripresenta i suoi avvisi con la stessa identità.
const test = require('node:test'), assert = require('node:assert');
const watch = require('../watch');

watch.init({ tripDetail: () => ({ live: true, trip: { line: '1', headsign: 'Lido' }, stops: [{ id: 'nav:1', state: 'upcoming', expMs: Date.now() + 20 * 60e3, delay: 0 }] }), contact: null });
const base = { src: 'nav', tid: 'T1', stop: 'nav:1', stopName: 'Fermata', lead: 5, ip: '1.2.3.4', url: '/', sub: null };

test('avviso perso dopo il riavvio: ripristinato con lo stesso id e token, senza ripetere la conferma', () => {
  watch._W.clear();
  const r = watch.restore({ ...base, id: 'abcdefgh123', token: 'tokentokentoken123', created: Date.now() - 60e3 });
  assert.equal(r, 'ripristinato');
  const w = watch._W.get('abcdefgh123');
  assert.ok(w && w.token === 'tokentokentoken123' && w.sent.conf === true);
  assert.equal(watch.restore({ ...base, id: 'abcdefgh123', token: 'tokentokentoken123' }), 'attivo', 'già presente');
  assert.equal(watch.restore({ ...base, id: 'abcdefgh123', token: 'altrotokenaltrotoken' }), 'diverso', 'token sbagliato: nessuna modifica');
  assert.equal(watch._W.get('abcdefgh123').token, 'tokentokentoken123');
});

test('avviso scaduto (oltre 3 ore) o identità non valida: non si ripristina', () => {
  watch._W.clear();
  assert.equal(watch.restore({ ...base, id: 'abcdefgh999', token: 'tokentokentoken999', created: Date.now() - 4 * 3600e3 }), 'scaduto');
  assert.equal(watch.restore({ ...base, id: 'x', token: 'y' }), 'diverso');
  assert.equal(watch._W.size, 0);
});
