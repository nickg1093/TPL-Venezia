// FLUSSO DEI MEZZI (flusso.js): differenze tra un invio e il successivo, applicate dal telefono, danno sempre lo stesso elenco del server.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { PassThrough } = require('stream');
const F = require('../flusso');

const v = (id, o = {}) => ({ id, src: 'aut', line: '7', lat: 45.49, lon: 12.24, ts: 1, ...o });
const asMap = list => new Map(list.map(x => [x.id, x]));

test('le differenze applicate ricostruiscono l\'elenco del server, campo per campo', () => {
  const D = F.makeDiffer(), phone = new Map();
  const steps = [
    [v('a'), v('b', { old: true })],                                                    // primo invio: tutti nuovi
    [v('a', { lat: 45.5, ts: 2 }), v('b'), v('c', { line: '2' })],                       // a si muove, b perde «old», c arriva
    [v('a', { lat: 45.5, ts: 2 }), v('c', { line: '2', path: [[45, 12], [45.1, 12.1]] })], // b sparisce, c ha un percorso
    [v('a', { lat: 45.5, ts: 2 }), v('c', { line: '2', path: [[45, 12], [45.1, 12.1]] })]  // nulla cambia
  ];
  for (const list of steps) {
    const { set, del } = D.diff(list);
    F.apply(phone, { t: 'd', s: set, d: del });
    assert.deepStrictEqual(phone, asMap(list));
  }
  assert.deepStrictEqual(D.diff(steps[3]), { set: [], del: [] }, 'nessun cambiamento = messaggio vuoto');
});
test('un mezzo che cambia solo posizione manda solo quei campi', () => {
  const D = F.makeDiffer(); D.diff([v('a')]);
  const { set } = D.diff([v('a', { lat: 45.6, ts: 9 })]);
  assert.deepStrictEqual(set, [{ id: 'a', lat: 45.6, ts: 9 }]);
});
test('all\'apertura l\'elenco completo coincide con lo stato da cui partono le differenze', () => {
  const D = F.makeDiffer(); D.diff([v('a'), v('b')]);
  const phone = new Map(); F.apply(phone, { t: 'f', v: D.all() });
  const { set, del } = D.diff([v('b', { lat: 1 })]);
  F.apply(phone, { t: 'd', s: set, d: del });
  assert.deepStrictEqual(phone, asMap([v('b', { lat: 1 })]));
});
test('id doppi o non validi si ignorano', () => {
  const D = F.makeDiffer(), { set } = D.diff([v('a'), v('a', { lat: 1 }), { id: 3 }, null]);
  assert.equal(set.length, 1);
});
test('collegamento compresso: ogni messaggio arriva subito e si decomprime', async () => {
  const res = new PassThrough(); res.writableLength = 0;
  const conn = F.connection(res, { gzip: true }), gun = zlib.createGunzip(); res.pipe(gun);
  let got = ''; gun.on('data', c => { got += c; });
  conn.send(F.event({ t: 'm', m: { updated: 1 } }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(got, 'data: {"t":"m","m":{"updated":1}}\n\n', 'svuotato senza aspettare altri dati');
  conn.close();
});
test('cliente lento: oltre il limite il collegamento si chiude (si ricollegherà)', () => {
  let ended = false; const res = { writableLength: 600 * 1024, write() { return true; }, end() { ended = true; } };
  const conn = F.connection(res, { gzip: false });
  assert.equal(conn.send('x'), false); assert.ok(ended); assert.equal(conn.open, false);
});
