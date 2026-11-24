// Storico delle novità (Informazioni → «Novità delle versioni», public/js/guida.js: storico()): versioni dalla più recente, nessun titolo
// ripetuto, nessuna voce della guida di base (v23), testi fissi senza dati esterni.
const test = require('node:test'), assert = require('node:assert'), path = require('path'), { pathToFileURL } = require('url');
test('storico delle novità: ordinato, senza doppioni, solo dalla v24, con la v34', async () => {
  const { storico } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'guida.js')).href);
  const s = storico(), vs = s.map(g => +g.v.slice(1)), titoli = s.flatMap(g => g.items.map(i => i.title));
  assert.ok(s.length >= 5, 'più versioni');
  assert.deepStrictEqual(vs, [...vs].sort((a, b) => b - a), 'dalla più recente');
  assert.ok(vs.every(v => v >= 24), 'niente guida di base');
  assert.strictEqual(new Set(titoli).size, titoli.length, 'nessun titolo ripetuto');
  assert.strictEqual(s[0].v, 'v34'); assert.ok(titoli.includes('Fermate sospese e corse incerte') && titoli.includes('Anche senza connessione') && titoli.includes('Acqua alta sulla mappa'));
  assert.ok(s.every(g => g.items.every(i => i.title && i.html && !/<script|on\w+=/i.test(i.html))), 'testi fissi, niente script');
});
