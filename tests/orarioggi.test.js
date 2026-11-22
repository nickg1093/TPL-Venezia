// Orari programmati di oggi SENZA RETE sul telefono (public/js/orarioggi.js): file per giorno del CDN (orari.js) letti sul telefono.
// Prove: stesse partenze del server (schedule.js) sui GTFS veri in archivio, fuso di Venezia e cambio dell'ora, corse dopo mezzanotte
// (file di ieri), finestra di 2 ore, file di un'altra versione rifiutati, fermate successive uguali a prossime.js, campi «programmati».
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orarioggi-'));
process.env.GTFS_DATA_DIR = tmp;
fs.cpSync(path.join(__dirname, '..', 'data'), tmp, { recursive: true });
const test = require('node:test'), assert = require('node:assert');
const store = require('../gtfsstore'), gtfs = require('../gtfs'), sch = require('../schedule'), orari = require('../orari'), prossime = require('../prossime');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function load() {
  const f = path.join(os.tmpdir(), `orarioggi-${process.pid}.mjs`);
  // il modulo importa fissi.js solo per la memoria del telefono: per le prove basta un sostituto vuoto
  fs.writeFileSync(f, fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'orarioggi.js'), 'utf8').replace("import * as Fissi from './fissi.js';", 'const Fissi = {};'));
  return import('file://' + f);
}

test('ore di Venezia: giorno, inizio del giorno di servizio (anche nei giorni del cambio d\'ora), giorni dopo', async () => {
  const O = await load();
  assert.strictEqual(O.ymd8(Date.parse('2026-11-22T23:30:00Z')), '20261123', 'già 23 novembre a Venezia');
  assert.strictEqual(O.ymd8(Date.parse('2026-11-22T22:59:00Z')), '20261122');
  assert.strictEqual(new Date(O.zeroMs('20261122')).toISOString(), '2026-11-21T23:00:00.000Z', 'mezzanotte di Venezia (CET)');
  assert.strictEqual(new Date(O.zeroMs('20260715')).toISOString(), '2026-07-14T22:00:00.000Z', 'estate (CEST)');
  // 29/03/2026, ora legale: 08:00 di servizio = 08:00 di Venezia (06:00 UTC)
  assert.strictEqual(new Date(O.zeroMs('20260329') + 8 * 3600e3).toISOString(), '2026-03-29T06:00:00.000Z');
  assert.strictEqual(new Date(O.zeroMs('20261025') + 8 * 3600e3).toISOString(), '2026-10-25T07:00:00.000Z', 'ritorno all\'ora solare');
  assert.strictEqual(O.addDays8('20261231', 1), '20270101');
  assert.strictEqual(O.addDays8('20260301', -1), '20260228');
});

test('partenze di prova: finestra, capolinea, corse dopo mezzanotte dal file di ieri, campi solo programmati, file sbagliati rifiutati', async () => {
  const O = await load();
  const mk = t => ({ f: 1, src: 'nav', v: 'aaaaaaaaaaaa', p: [[['A', 'B', 'C'], [1, 2, 3]]], t });
  // corsa delle 23:50 (arrivi relativi 0, 10, 20 min; sosta di 1 min in B) e corsa «24:20» del giorno prima
  const oggi = mk([[0, 'T1', 'R1', 'Verso C', 'S', 'sh', 0, 0, 23 * 3600 + 50 * 60, [0, 600, 1200], [0, 60, 0]]]);
  const ieri = mk([[0, 'T0', 'R1', '', 'S', 'sh', 0, 0, 24 * 3600 + 20 * 60, [0, 600, 1200], 0]]);
  assert.ok(O.leggiGiorno(oggi, 'nav', 'aaaaaaaaaaaa'));
  assert.strictEqual(O.leggiGiorno(oggi, 'nav', 'bbbbbbbbbbbb'), null, 'altra versione: rifiutato');
  assert.strictEqual(O.leggiGiorno(oggi, 'aut', 'aaaaaaaaaaaa'), null, 'altro servizio: rifiutato');
  assert.strictEqual(O.leggiGiorno({ f: 2 }, 'nav', 'aaaaaaaaaaaa'), null);
  const info = { nome: f => ({ 'nav:A': 'Alfa "A"', 'nav:B': 'Beta', 'nav:C': 'Capolinea "B"' })[f], linea: (s, r) => (r === 'R1' ? { name: '1', color: '#123456' } : null) };
  const z = O.zeroMs('20261122'), now = z + (23 * 3600 + 55 * 60) * 1000;   // 23:55 del 22/11
  const r = O.partenze([{ ymd: '20261122', src: 'nav', d: oggi }], ['nav:B', 'nav:C'], now, info);
  const b = r.departures.find(x => x.stop === 'nav:B');
  assert.strictEqual(b.sched, '00:01', 'partenza da B: arrivo 00:00 + 1 minuto di sosta');
  assert.strictEqual(b.line, '1'); assert.strictEqual(b.color, '#123456'); assert.strictEqual(b.headsign, 'Verso C');
  assert.ok(b.live === false && b.delay === null && b.veh === null && b.cancel === null && b.programmato, 'mai dati in tempo reale');
  assert.strictEqual(b.schedIn, 6); assert.strictEqual(b.expSec, b.schedSec);
  const c = r.departures.find(x => x.stop === 'nav:C'); assert.ok(c.arrival && c.sched === '00:10' && !c.nx, 'capolinea: arrivo, niente fermate successive');
  assert.deepStrictEqual(r.nexts[b.nx], prossime.build(['Capolinea "B"'], 'Verso C'));
  // il 23/11 alle 00:25: la corsa «24:20» di ieri (= 00:20) è partita da A 5 minuti fa (fuori), da B alle 00:30 (dentro); la destinazione
  // senza headsign è il nome dell'ultima fermata
  const z2 = O.zeroMs('20261123'), now2 = z2 + 25 * 60e3;
  const r2 = O.partenze([{ ymd: '20261122', src: 'nav', d: ieri }], ['nav:A', 'nav:B'], now2, info);
  assert.deepStrictEqual(r2.departures.map(x => `${x.stop} ${x.sched}`), ['nav:B 00:30']);
  assert.strictEqual(r2.departures[0].headsign, 'Capolinea "B"');
  // finestra: oltre 2 ore non compare, partita da più di 3 minuti nemmeno
  assert.strictEqual(O.partenze([{ ymd: '20261122', src: 'nav', d: oggi }], ['nav:A'], z + 21 * 3600e3, info).departures.length, 0);
  assert.strictEqual(O.partenze([{ ymd: '20261122', src: 'nav', d: oggi }], ['nav:A'], z + (23 * 3600 + 54 * 60) * 1000, info).departures.length, 0);
  assert.strictEqual(O.partenze([{ ymd: '20261122', src: 'nav', d: oggi }], ['nav:A'], z + (23 * 3600 + 52 * 60) * 1000, info).departures.length, 1, 'partita da 2 minuti: ancora in elenco');
  assert.strictEqual(O.partenze([{ ymd: '20261122', src: 'aut', d: oggi }], ['nav:A'], now, info).departures.length, 0, 'servizio diverso');
});

test('fermate successive: stessa regola del server (prossime.js)', async () => {
  const O = await load();
  const casi = [
    [['San Marco Vallaresso "A"', 'San Marco Giardinetti', 'Salute', 'Lido S.M.E. "B"'], 'Lido S.M.E. "A"'],
    [['MESTRE CENTRO B3', 'Via Piave A', 'Via Piave B', 'Stazione FS'], 'Stazione'],
    [Array.from({ length: 20 }, (_, i) => `Fermata ${i}`), 'Capolinea'],
    [['Rialto "B"', 'Rialto "C"', 'Ca\' d\'Oro'], 'Ferrovia'],
    [['P.le Roma', 'F.te Nove', 'S. Zaccaria'], 'Lido']
  ];
  for (const [n, d] of casi) assert.deepStrictEqual(O.build(n, d), prossime.build(n, d), JSON.stringify(n));
  for (const s of ['Àèìòù "A"', 'S. Marco', 'P.le Roma', 'F.te Nove']) assert.strictEqual(O.norm(s), prossime.norm(s));
});

test('GTFS veri: le partenze calcolate sul telefono dai file per giorno coincidono con quelle del server', async () => {
  const O = await load(); let fatti = 0;
  for (const src of ['nav', 'aut']) {
    const l = await store.list(src), c = l.find(x => /^\d{8}_/.test(path.basename(x.file))) || l[0];
    const d0 = c.info.cover.min, day = O.addDays8(d0, 3);
    if (day > c.info.cover.max) continue;
    const full = await gtfs.loadVersion(src, c, day, { full: true }), v = c.hash.slice(0, 12);
    const { indice, files } = orari.versione(full, src, gtfs.window3(day));
    const idx = JSON.parse(indice), giorni = gtfs.window3(day).filter(d => idx.giorni[d]).map(d => ({ ymd: d, src, d: O.leggiGiorno(JSON.parse(files.get(idx.giorni[d])), src, v) }));
    assert.ok(giorni.length === 3 && giorni.every(g => g.d), `${src}: tre giorni validi`);
    const info = { nome: f => full.stops[f.slice(src.length + 1)] || '', linea: (s, r) => full.routes[r] || null };
    let confronti = 0;
    for (const secs of [6 * 3600, 12 * 3600 + 777, 23 * 3600 + 40 * 60, 24 * 3600 + 20 * 60]) {
      const now = O.zeroMs(day) + secs * 1000;
      for (const s of Object.keys(full.stopIndex).filter((_, k) => k % 11 === 0).slice(0, 60)) {
        const srv = sch.departures(full, null, s, secs >= 86400 ? secs - 86400 : secs, secs >= 86400 ? O.addDays8(day, 1) : day);
        if (srv.length >= 80) continue;                         // il server ne restituisce al massimo 80
        const tel = O.partenze(giorni, [`${src}:${s}`], now, info).departures;
        const k = x => `${x.tripId}|${x.seq}|${x.sched}|${x.arrival}|${x.headsign}|${x.line}`;
        assert.deepStrictEqual(tel.map(k).sort(), srv.map(k).sort(), `${src} ${s} ${secs}`);
        confronti++;
      }
    }
    assert.ok(confronti > 50, `${src}: ${confronti} confronti`); fatti++;
  }
  assert.strictEqual(fatti, 2, 'confronto fatto per navigazione e autobus');
});
