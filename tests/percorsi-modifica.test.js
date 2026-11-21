// MODIFICA E CREAZIONE DEI PERCORSI SALVATI (fav.js, v33.5): la modifica tiene posizione, data e nome; la creazione aggiunge in cima;
// niente doppioni (né modificando né creando) e nessuna sovrascrittura di un altro percorso.
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const P = (label, lat, lon) => ({ kind: 'point', label, lat, lon });
const A = P('A', 45.438, 12.32), B = P('B', 45.434, 12.339), C = P('C', 45.43, 12.33), D = P('D', 45.441, 12.326);
const Z = { kind: 'zone', key: 'nav:Rialto', label: 'Rialto', src: 'nav', lat: 45.438, lon: 12.336 };
async function apri(mem) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'percorsi-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const f of ['util.js', 'fav.js']) fs.copyFileSync(path.join(__dirname, '..', 'public', 'js', f), path.join(dir, f));
  const M = new Map(Object.entries(mem));
  globalThis.localStorage = { getItem: k => (M.has(k) ? M.get(k) : null), setItem: (k, v) => M.set(k, String(v)), removeItem: k => M.delete(k) };
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'Linux', maxTouchPoints: 0 }, configurable: true });
  globalThis.document = { hidden: true, addEventListener() {}, getElementById: () => null };
  globalThis.window = globalThis; globalThis.addEventListener = () => {};
  return { F: await import('file://' + path.join(dir, 'fav.js')), M };
}
test('percorsi salvati: modifica, creazione, doppioni', async () => {
  const { F, M } = await apri({});
  assert.equal(F.toggleRoute(A, B), true); assert.equal(F.toggleRoute(C, D), true);   // elenco: C>D, A>B
  const [cd, ab] = F.allRoutes();
  F.renameRoute(ab.k, 'Casa');
  // modifica dell'arrivo: stessa posizione (seconda), stesso nome e data, chiave nuova
  assert.equal(F.updateRoute(ab.k, A, Z), 'ok');
  let l = F.allRoutes();
  assert.equal(l.length, 2); assert.equal(l[1].to.label, 'Rialto'); assert.equal(l[1].name, 'Casa'); assert.equal(l[1].at, ab.at);
  assert.equal(F.routeByKey(ab.k), null, 'la vecchia chiave non esiste più');
  // nome cambiato o tolto nella stessa modifica
  assert.equal(F.updateRoute(l[1].k, A, Z, '  Casa → Rialto <b> '), 'ok'); assert.equal(F.allRoutes()[1].name, 'Casa → Rialto b');
  assert.equal(F.updateRoute(F.allRoutes()[1].k, A, Z, ''), 'ok'); assert.equal(F.allRoutes()[1].name, undefined);
  // modifica che coinciderebbe con un ALTRO salvato: rifiutata, niente cambia
  const before = M.get('tpl.percorsi');
  assert.equal(F.updateRoute(F.allRoutes()[1].k, C, D), 'dup'); assert.equal(M.get('tpl.percorsi'), before);
  assert.equal(F.updateRoute(cd.k, D, D), 'same');
  assert.equal(F.updateRoute('nessuno', A, B), 'missing');
  // creazione: in cima; doppione rifiutato
  assert.equal(F.addRoute(B, A, 'Ritorno'), 'ok'); l = F.allRoutes();
  assert.equal(l.length, 3); assert.equal(l[0].name, 'Ritorno'); assert.equal(l[0].from.label, 'B');
  assert.equal(F.addRoute(C, D), 'dup'); assert.equal(F.allRoutes().length, 3);
  // memoria riletta: i dati restano coerenti (chiavi ricalcolate uguali)
  const { F: F2 } = await apri({ 'tpl.percorsi': M.get('tpl.percorsi') });
  assert.deepEqual(F2.allRoutes().map(r => r.k), F.allRoutes().map(r => r.k));
});
