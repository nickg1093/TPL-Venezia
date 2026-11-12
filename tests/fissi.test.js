// Dati fissi per i telefoni (fissi.js): file per versione dei GTFS, impronte, indice del ramo «dati», tracciati codificati.
const test = require('node:test');
const assert = require('node:assert');
const fissi = require('../fissi');
const gtfs = require('../gtfs');

const G = { meta: { hash: 'abcdef0123456789abcdef0123456789' }, stopIndex: { S1: 1, S2: 1, S3: 1 }, stops: { S1: 'Uno', S2: 'Due a richiesta', S3: 'Senza posizione' },
  stopBaseNames: new Map([['S2', 'Due']]), stopLoc: { S1: [45.43, 12.33], S2: [45.44, 12.34] }, routes: { R1: { name: '1', color: '#ff0000', type: 4 } },
  routeShapes: { R1: [Float32Array.from([45.43001, 12.33001, 45.43502, 12.33803, 45.44, 12.34])] } };

test('file: come le vecchie risposte (fermate con posizione, nomi senza «a richiesta», linee), tracciati codificati senza perdita', () => {
  const f = fissi.files(G, gtfs.toLL);
  assert.deepStrictEqual(JSON.parse(f.stops), [['S1', 'Uno', 45.43, 12.33], ['S2', 'Due', 45.44, 12.34]]);
  assert.deepStrictEqual(JSON.parse(f.routes), G.routes);
  const sh = JSON.parse(f.shapes);
  assert.deepStrictEqual(fissi.decode(sh.R1[0]), gtfs.toLL(G.routeShapes.R1[0]));
  assert.strictEqual(fissi.versione(G), 'abcdef012345');
});

test('store: impronta SHA-256 dei byte esatti, ricalcolata solo con un GTFS diverso', () => {
  const st = fissi.store(gtfs.toLL), a = st.get('nav', G), f = fissi.files(G, gtfs.toLL);
  assert.strictEqual(a.files.stops.sha, fissi.sha256(f.stops));
  assert.strictEqual(require('zlib').gunzipSync(a.files.shapes.gz).toString(), f.shapes.toString());
  assert.strictEqual(st.get('nav', G), a);
  assert.notStrictEqual(st.get('nav', { ...G, meta: { hash: 'ffff' + G.meta.hash } }), a);
  assert.strictEqual(st.get('nav', { meta: null }), null);
});

test('indice del ramo dati: solo valori ben formati', () => {
  const ok = { formato: 1, commit: 'a'.repeat(40), fissi: ['nav/0123456789ab', 'aut/../../x', 'xyz/0123456789ab'], pedoni: { v: 'e180f63508c0613f', indice: 'b'.repeat(64), lat: 0.01, lon: 0.014 } };
  const p = fissi.parseIndice(ok);
  assert.deepStrictEqual([...p.fissi], ['nav/0123456789ab']);
  assert.strictEqual(p.pedoni.v, 'e180f63508c0613f');
  assert.strictEqual(fissi.parseIndice({ ...ok, commit: 'main' }), null);
  assert.strictEqual(fissi.parseIndice({ ...ok, formato: 2 }), null);
  assert.strictEqual(fissi.parseIndice({ ...ok, pedoni: { ...ok.pedoni, indice: 'x' } }).pedoni, null);
});

test('indice remoto: CDN legato al commit, errori di rete ignorati', async () => {
  const body = JSON.stringify({ formato: 1, commit: 'c'.repeat(40), fissi: [], pedoni: null });
  let calls = 0;
  const r = fissi.remote({ repo: 'utente/repo', fetchFn: async () => { calls++; if (calls === 2) throw new Error('rete'); return { ok: true, status: 200, text: async () => body, headers: { get: () => '"e1"' } }; } });
  assert.deepStrictEqual(r.bases(), []);
  await r.poll(); assert.deepStrictEqual(r.bases(), ['https://cdn.jsdelivr.net/gh/utente/repo@' + 'c'.repeat(40), 'https://raw.githubusercontent.com/utente/repo/' + 'c'.repeat(40)]);
  await r.poll(); assert.strictEqual(r.get().commit, 'c'.repeat(40), 'GitHub irraggiungibile: resta l\'ultimo indice');
});
