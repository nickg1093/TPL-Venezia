// Archivio della marea (marea-archivio.js) e ripristino dopo un riavvio (tide.js)
const test = require('node:test'), assert = require('node:assert');
const A = require('../marea-archivio');
const T0 = Date.UTC(2026, 10, 12, 20, 0), M5 = 5 * 60e3;
const lv = (t, cm, id = '1025') => ({ id, name: 'x', cm, ts: t });

test('righe: stazione principale e riserve, valore mancante segnato come tale', () => {
  const r = A.rowsFrom([lv(T0, 79), lv(T0, null, '1045'), lv(T0, 81, '9999')]);
  assert.deepStrictEqual(r, [{ t: T0, cm: 79, st: '1025', f: 'cpsm', s: 'grezzo' }, { t: T0, cm: null, st: '1045', f: 'cpsm', s: 'mancante' }]);
});

test('unione: nessun duplicato, ordine di tempo, il dato vero sostituisce il mancante, righe non valide scartate', () => {
  let m = A.merge('', A.rowsFrom([lv(T0, 79)]));
  assert.strictEqual(m.added, 1);
  m = A.merge(m.text, A.rowsFrom([lv(T0, 79)]));                                   // stessa lettura riletta: nessun doppione
  assert.strictEqual(m.added, 0);
  m = A.merge(m.text, [...A.rowsFrom([lv(T0 - M5, null)]), ...A.rowsFrom([lv(T0 + M5, 85)])]);
  m = A.merge(m.text + 'non json\n{"t":1,"cm":5}\n', A.rowsFrom([lv(T0 - M5, 74)]));
  const rows = A.parse(m.text);
  assert.deepStrictEqual(rows.map(r => [r.t, r.cm]), [[T0 - M5, 74], [T0, 79], [T0 + M5, 85]]);
});

test('conservazione: file oltre 30 giorni da cancellare, gli altri restano', () => {
  const names = ['2025-09-01.jsonl', '2026-10-12.jsonl', '2026-10-14.jsonl', '2026-11-12.jsonl', 'LEGGIMI.md'];
  assert.strictEqual(A.KEEP_DAYS, 30);
  assert.deepStrictEqual(A.expired(names, T0), ['2025-09-01.jsonl', '2026-10-12.jsonl']);
});

test('ripristino: ultime 6 ore da oggi e ieri, principale preferita, valori mancanti e file guasti ignorati', async () => {
  const now = Date.UTC(2026, 10, 12, 2, 0), asked = [];
  const files = {
    '2026-11-11': A.merge('', [...A.rowsFrom([lv(now - 3 * 3600e3, 60)]), ...A.rowsFrom([lv(now - 9 * 3600e3, 10)])]).text,
    '2026-11-12': A.merge('', [...A.rowsFrom([lv(now - 600e3, 70), lv(now - 600e3, 99, '1045')]), ...A.rowsFrom([lv(now - 300e3, null)])]).text + '{rotto\n'
  };
  const fetchFn = async url => { asked.push(url); const d = url.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/)[1]; return files[d] ? { ok: true, text: async () => files[d] } : { ok: false }; };
  const h = await A.restore({ repo: 'utente/repo', fetchFn, now });
  assert.deepStrictEqual(h, [{ t: now - 3 * 3600e3, cm: 60 }, { t: now - 600e3, cm: 70 }]);
  assert.ok(asked.every(u => u.startsWith('https://raw.githubusercontent.com/utente/repo/archivio-marea/marea/')));
  assert.deepStrictEqual(await A.restore({ repo: 'utente/repo', fetchFn: async () => { throw new Error('rete'); }, now }), []);
  assert.deepStrictEqual(await A.restore({ repo: '../x', fetchFn, now }), []);
});

test('dopo un riavvio la storia recuperata si unisce alle letture nuove: grafico e tendenza subito disponibili', () => {
  delete require.cache[require.resolve('../tide')];
  const tide = require('../tide'), now = Date.now();
  assert.strictEqual(tide._S.hist.length, 0);                                     // processo appena avviato: memoria vuota
  const archived = [0, 1, 2, 3, 4, 5, 6].map(k => ({ t: now - (40 - k * 5) * 60e3, cm: 50 + k * 3 }));
  tide._S.hist.push({ t: now - 5 * 60e3, cm: 71 });                               // prima lettura del nuovo processo
  assert.strictEqual(tide.mergeHist([...archived, archived[2]], now), 8);         // senza doppioni
  assert.deepStrictEqual(tide._S.hist.map(p => p.t), [...archived.map(p => p.t), now - 5 * 60e3].sort((a, b) => a - b));
  assert.strictEqual(tide.trendOf(tide._S.hist).dir, 'up');
  tide.mergeHist([{ t: now - 7 * 3600e3, cm: 1 }], now);                         // oltre le 6 ore: non entra
  assert.ok(tide._S.hist.every(p => p.t >= now - 6 * 3600e3));
});
