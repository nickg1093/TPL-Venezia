// COPIA DI SICUREZZA DEI PREFERITI (public/js/fav.js: exportData / importData), v34: file validi, parziali, rovinati, incompatibili, molto
// grandi, con doppioni e valori anomali, memoria piena. Nessun ripristino fallito deve cambiare i preferiti già presenti.
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
async function apri(mem, piena = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pref-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'js', 'fav.js'), path.join(dir, 'fav.js'));
  const M = new Map(Object.entries(mem)), S = { piena };
  globalThis.localStorage = { getItem: k => (M.has(k) ? M.get(k) : null), setItem: (k, v) => { if (S.piena) throw new Error('QuotaExceededError'); M.set(k, String(v)); }, removeItem: k => M.delete(k) };
  globalThis.window = globalThis; globalThis.addEventListener = () => {};
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  return { F: await import('file://' + path.join(dir, 'fav.js')), M, S };
}
const base = () => ({ 'tpl.favorites': JSON.stringify({ v: 1, items: [{ k: 'stop:aut:510', name: 'VENEZIA', src: 'aut', at: 1 }] }),
  'tpl.percorsi': JSON.stringify({ v: 1, items: [{ from: { kind: 'stop', id: 'aut:510', label: 'VENEZIA' }, to: { kind: 'me', label: 'x' }, at: 1 }] }) });

test('esporta e reimporta: niente doppioni, conteggio delle sole voci nuove', async () => {
  const { F } = await apri(base());
  const d = F.exportData();
  assert.deepStrictEqual(F.importData(JSON.parse(JSON.stringify(d))), { fermate: 0, percorsi: 0 }, 'stessa copia: niente di nuovo');
  d.fermate.push({ k: 'zone:nav:5032', name: 'Rialto', src: 'nav', at: 5 }, { k: 'zone:nav:5032', name: 'Rialto bis', src: 'nav' });
  assert.deepStrictEqual(F.importData(d), { fermate: 1, percorsi: 0 });
  assert.strictEqual(F.all().length, 2);
});

test('file rovinati, incompatibili o con valori anomali: rifiutati senza toccare i preferiti', async () => {
  const { F, M } = await apri(base()); const prima = M.get('tpl.favorites');
  for (const bad of [null, 'x', 42, [], {}, { app: 'altro', v: 1 }, { app: 'tpl-venezia', v: 2, fermate: [] }]) {
    assert.throws(() => F.importData(bad), /non riconosciuto/); assert.strictEqual(M.get('tpl.favorites'), prima);
  }
  const strani = [{ k: 'stop:aut:<script>', name: 'x' }, { k: 'stop:', name: 'x' }, { k: 'altro:aut:1', name: 'x' }, { k: 'stop:aut:1', name: 5 }, { k: 'stop:aut:1', name: '   ' },
    { k: 'stop:xyz:1', name: 'x' }, { k: 'stop:aut:' + 'a'.repeat(300), name: 'x' }, 'testo', null, { k: 'stop:aut:77', name: 'Ok\u0000\u0007', at: 'ieri' }];
  const r = F.importData({ app: 'tpl-venezia', v: 1, fermate: strani, percorsi: [{ from: { kind: 'x' }, to: {} }, { from: { kind: 'point', label: 'A', lat: 'a', lon: 1 }, to: { kind: 'me', label: 'B' } },
    { from: { kind: 'stop', id: 'aut:1', label: 'A' }, to: { kind: 'stop', id: 'aut:1', label: 'A' } }] });
  assert.deepStrictEqual(r, { fermate: 1, percorsi: 0 }, 'solo la voce valida (nome ripulito); percorso con partenza = arrivo scartato');
  const nuova = F.all().find(x => x.k === 'stop:aut:77'); assert.strictEqual(nuova.name, 'Ok'); assert.ok(nuova.at > 1e12);
});

test('file molto grande: al massimo 100 fermate e 30 percorsi, quelle presenti hanno la precedenza', async () => {
  const { F } = await apri(base());
  const fermate = Array.from({ length: 5000 }, (_, i) => ({ k: 'stop:aut:' + (1000 + i), name: 'F' + i, src: 'aut' }));
  const percorsi = Array.from({ length: 500 }, (_, i) => ({ from: { kind: 'point', label: 'P' + i, lat: 45.4 + i / 1e3, lon: 12.3 }, to: { kind: 'me', label: 'Io' } }));
  const r = F.importData({ app: 'tpl-venezia', v: 1, fermate, percorsi });
  assert.deepStrictEqual(r, { fermate: 99, percorsi: 29 }, 'conteggio = voci davvero aggiunte');
  assert.strictEqual(F.all().length, 100); assert.strictEqual(F.all()[0].k, 'stop:aut:510', 'la fermata presente resta, in cima');
  assert.strictEqual(F.allRoutes().length, 30);
});

test('memoria piena durante il ripristino: tutto com\'era, anche nell\'elenco in uso', async () => {
  const { F, M, S } = await apri(base()); const p1 = M.get('tpl.favorites'), p2 = M.get('tpl.percorsi');
  S.piena = true;
  assert.throws(() => F.importData({ app: 'tpl-venezia', v: 1, fermate: [{ k: 'stop:aut:9', name: 'Nove' }] }), /nulla è stato cambiato/);
  assert.strictEqual(M.get('tpl.favorites'), p1); assert.strictEqual(M.get('tpl.percorsi'), p2);
  assert.strictEqual(F.all().length, 1, 'elenco in uso invariato');
  S.piena = false;
  assert.deepStrictEqual(F.importData({ app: 'tpl-venezia', v: 1, fermate: [{ k: 'stop:aut:9', name: 'Nove' }] }), { fermate: 1, percorsi: 0 });
});
