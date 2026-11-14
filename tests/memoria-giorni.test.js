// Memoria del server: corse dei soli giorni utili (gtfs.js), lettura a pezzi (zip.js, csv.js), pulizia dell'archivio (gtfsstore.prune),
// protezione della memoria (memoria.js). Prove sui GTFS veri in archivio: risultati IDENTICI al file intero, con molta meno memoria.
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfs-'));
process.env.GTFS_DATA_DIR = tmp;                         // prima di caricare gtfsstore: l'archivio di prova è una copia
const SRC = path.join(__dirname, '..', 'data');
fs.cpSync(SRC, tmp, { recursive: true });
const test = require('node:test'), assert = require('node:assert');
const store = require('../gtfsstore'), gtfs = require('../gtfs'), sch = require('../schedule'), fissi = require('../fissi');
const { Zip } = require('../zip'), { eachRow, eachRowStream } = require('../csv');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('lettura a pezzi = lettura intera (stessi byte, stesse righe); CRC sbagliato = errore', async () => {
  const c = (await store.list('nav'))[0], z = new Zip(c.file), e = z.getEntries().find(x => /stop_times\.txt$/.test(x.entryName));
  const parts = []; for await (const p of e.stream()) parts.push(p);
  assert.ok(Buffer.concat(parts).equals(new Zip(c.file).getEntries().find(x => /stop_times\.txt$/.test(x.entryName)).getData()));
  const a = [], b = [], F = ['trip_id', 'stop_id', 'arrival_time'];
  await eachRow(e.getData(), F, r => a.push(r)); await eachRowStream(new Zip(c.file).getEntries().find(x => /stop_times\.txt$/.test(x.entryName)), F, r => b.push(r));
  assert.deepStrictEqual(b, a);
  const buf = fs.readFileSync(c.file), bad = Buffer.from(buf), z2 = new Zip(bad), e2 = z2.getEntries().find(x => /stop_times\.txt$/.test(x.entryName));
  e2.h.crc = (e2.h.crc + 1) >>> 0;
  if (typeof zlib.crc32 === 'function') await assert.rejects(async () => { for await (const _ of e2.stream()); }, /CRC/);
});

test('solo le corse di ieri, oggi e domani: partenze, posizioni e dati fissi identici al file intero', async () => {
  const c = (await store.list('nav')).find(x => x.info.cover.min <= '20261115' && x.info.cover.max >= '20261116') || (await store.list('nav'))[0];
  const day = c.info.cover.min > '20261115' ? c.info.cover.min : '20261115';
  const full = await gtfs.loadVersion('nav', c, day, { full: true }), win = await gtfs.loadVersion('nav', c, day);
  assert.ok(win.tripIds.length < full.tripIds.length, 'meno corse in memoria');
  assert.deepStrictEqual(Object.keys(win.stopIndex).sort(), Object.keys(full.stopIndex).sort(), 'tutte le fermate restano');
  const fa = fissi.files(full, gtfs.toLL), fb = fissi.files(win, gtfs.toLL);
  for (const k of fissi.NOMI) assert.ok(fa[k].equals(fb[k]), `dati fissi ${k} identici (stesse impronte per il CDN)`);
  for (const secs of [6 * 3600, 12 * 3600 + 777, 23 * 3600 + 40 * 60, 24 * 3600 + 20 * 60])
    for (const s of Object.keys(full.stopIndex).slice(0, 60)) {
      const k = d => d.tripId + d.sched + d.headsign;
      assert.deepStrictEqual(sch.departures(win, null, s, secs, day).map(k), sch.departures(full, null, s, secs, day).map(k), `partenze ${s} ${secs}`);
    }
  assert.deepStrictEqual(win.meta.days, gtfs.window3(day));
  assert.match(win.meta.key, /@\d{8}$/);
});

test('protezione della memoria: livelli e «c\'è spazio per un lavoro pesante?»', () => {
  const m = require('../memoria');
  const s = m.stato(); assert.ok(s.rss_MB > 0 && s.soglie_MB.alto < s.soglie_MB.critico);
  assert.strictEqual(m.libera(1e6), false, 'un lavoro enorme non parte');
  let chiamata = 0; m.quando(() => { chiamata++; });
  assert.strictEqual(typeof m.libera(1), 'boolean');
  assert.ok(['ok', 'alto', 'critico'].includes(m._misura()));
  assert.ok(chiamata >= 0);
});

test('orari per giorno (CDN): ricostruzione identica alla lettura dallo ZIP; file alterati o di un\'altra versione rifiutati', async () => {
  const orari = require('../orari');
  for (const [src, name, date] of [['nav', '20261102_189116ae.zip', '20261118'], ['aut', '20261116_6010d7cd.zip', '20261125']]) {
    const c = (await store.list(src)).find(x => x.file.endsWith(name)); assert.ok(c, `${name} in archivio`);
    const full = await gtfs.loadVersion(src, c, date, { full: true });
    const { indice, files } = orari.versione(full, src, gtfs.window3(date));
    const idx = orari.checkIndice(JSON.parse(indice), src, c.hash); assert.ok(idx, 'indice valido');
    assert.strictEqual(orari.checkIndice(JSON.parse(indice), src, 'f'.repeat(32)), null, 'indice di un\'altra versione: rifiutato');
    const giorni = gtfs.window3(date).map(d => idx.giorni[d]).filter(Boolean).map(n => {
      assert.strictEqual(orari.sha16(files.get(n)), n); return orari.checkGiorno(JSON.parse(files.get(n)), src, c.hash.slice(0, 12));
    });
    assert.ok(giorni.every(Boolean));
    assert.strictEqual(orari.checkGiorno(JSON.parse(files.get(idx.giorni[date])), src, '000000000000'), null, 'file di un\'altra versione: rifiutato');
    const base = await gtfs.loadVersion(src, c, gtfs.window3(date)[0] < c.info.cover.min ? c.info.cover.min : date);   // orari «in uso» della stessa versione
    const cdn = orari.ricostruisci(base, giorni, date), zip = await gtfs.loadVersion(src, c, date);
    assert.deepStrictEqual(cdn.tripIds, zip.tripIds, `${src}: stesse corse, stesso ordine`);
    for (const secs of [5 * 3600, 9 * 3600 + 321, 18 * 3600, 24 * 3600 + 30 * 60])
      for (const s of Object.keys(zip.stopIndex).filter((_, k) => k % 7 === 0).slice(0, 80)) {
        const k = d => d.tripId + d.sched + d.headsign + d.seq;
        assert.deepStrictEqual(sch.departures(cdn, null, s, secs, date).map(k), sch.departures(zip, null, s, secs, date).map(k), `${src} partenze ${s} ${secs}`);
      }
    const pos = G => sch.positionsNow(G, 12 * 3600, date).map(p => `${p.tripId}:${p.lat}:${p.lon}`).sort().join();
    assert.strictEqual(pos(cdn), pos(zip), `${src}: stesse posizioni dei mezzi`);
    assert.deepStrictEqual(Object.keys(cdn.stopIndex).sort(), Object.keys(zip.stopIndex).sort());
  }
});

test('server: orari di un\'altra data scaricati dal CDN (finto, locale); file alterato o CDN spento = lettura dallo ZIP, stessi risultati', async () => {
  const http = require('http'), orari = require('../orari');
  const c = (await store.list('nav')).find(x => x.file.endsWith('20261102_189116ae.zip')), date = '20261118', v = c.hash.slice(0, 12);
  const full = await gtfs.loadVersion('nav', c, date, { full: true }), { indice, files } = orari.versione(full, 'nav', gtfs.window3(date));
  const served = new Map([[`/orari/nav/${v}.json`, indice], ...[...files].map(([n, b]) => [`/orari/nav/g/${n}.json`, b])]);
  let guasto = null, richieste = 0;
  const srv = http.createServer((q, r) => { richieste++; let b = served.get(q.url); if (!b) { r.writeHead(404); return r.end(); } if (guasto && q.url.includes('/g/')) b = Buffer.concat([b, Buffer.from(' ')]); r.end(b); });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const fake = { get: () => ({ commit: 'a'.repeat(40), orari: new Set([`nav/${v}`]) }), bases: () => [base] };
  try {
    orari.init({ remote: fake });
    const oggi = await gtfs.loadVersion('nav', c, '20261114');
    const G = await orari.perData('nav', c, date, oggi);
    assert.ok(G.meta.cdn, 'dal CDN'); assert.ok(richieste >= 2);
    const zip = await gtfs.loadVersion('nav', c, date);
    assert.deepStrictEqual(G.tripIds, zip.tripIds);
    guasto = true; orari.init({ remote: fake });
    const G2 = await orari.perData('nav', c, '20261119', oggi);
    assert.ok(!G2.meta.cdn, 'file alterato: dallo ZIP');
    orari.init({ remote: { get: () => null, bases: () => [] } });
    const G3 = await orari.perData('nav', c, date, oggi);
    assert.ok(!G3.meta.cdn); assert.deepStrictEqual(G3.tripIds, zip.tripIds, 'CDN spento: stessi orari dallo ZIP');
    const altra = { ...oggi, meta: { ...oggi.meta, hash: 'f'.repeat(32) } };
    orari.init({ remote: fake }); guasto = null;
    assert.ok(!(await orari.perData('nav', c, date, altra)).meta.cdn, 'versione in uso diversa: dallo ZIP');
  } finally { srv.close(); orari.init({ remote: null }); }
});

// per ultima: cancella file dalla copia dell'archivio
test('archivio: restano solo le versioni usate da oggi in avanti (e quella in uso); mai cancellato tutto', async () => {
  const names = async s => (await store.list(s)).map(c => path.basename(c.file)).sort();
  const before = await names('aut');
  const del = await store.prune('aut', '20261116');
  const after = await names('aut');
  for (const d of ['20261116', '20261201', '20270110']) {
    const p = store.choose(await store.list('aut'), d).pick; assert.ok(p, `una versione per il ${d}`);
  }
  assert.ok(after.length >= 1 && after.length + del.length === before.length, 'cancellate solo quelle non più usate');
  const inUse = (await store.list('nav'))[0];
  await store.prune('nav', '20991231', [inUse.hash]);        // nessuna versione valida: si tiene quella in uso
  assert.ok((await store.list('nav')).some(c => c.hash === inUse.hash));
});
