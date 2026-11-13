// Stato del MOSE (mose.js): lettura della tabella dell'Autorità per la Laguna, semafori, evento programmato, errori della fonte
const test = require('node:test'), assert = require('node:assert');
const mose = require('../mose');

// stessa struttura della pagina vera (wpDataTables: intestazioni con le colonne tecniche, segnaposto di caricamento, celle senza classi)
const head = cols => `<thead> <tr> ${['wdt_ID', 'wdt_created_by', 'wdt_created_at', 'wdt_last_edited_by', 'wdt_last_edited_at', ...cols].map(c => `<th class=" wdtheader sort " style=""> ${c}</th>`).join(' ')} </tr> </thead>`;
const row = (i, ed, cells) => `<tr id="table_2_row_${i}" data-row-index="${i}"> <td style="">${i + 1}</td> <td style="">admin</td> <td style="">10/10/2025 11:25 AM</td> <td style="">MOSEGEST</td> <td style="">${ed}</td> ${cells.map(c => `<td style="">${c}</td>`).join(' ')} </tr>`;
const loader = '<div data-id="2" class="wdt-timeline-item"><div class="wdt-table-loader"><div class="wdt-table-loader-row"></div></div></div>';
const page = (stati, ev = ['', '']) => `<html><body><h1>M.O.S.E.</h1>
<table id="table_1" class=" display nowrap wpDataTable wpDataTableID-25 ">${head(['Data', 'Orario'])}<tbody>${loader}${row(0, '13/11/2026 02:04 AM', ev)}</tbody></table>
<table id="table_2" class=" display nowrap wpDataTable wpDataTableID-2 ">${head(['BOCCHE DI PORTO', 'BARRIERE', 'STATO'])}<tbody>${loader}
${row(0, '13/11/2026 02:03 AM', ['Bocca di Lido', 'Barriera di Treporti', stati[0]])} ${row(1, '13/11/2026 02:03 AM', ['Bocca di Lido', 'Barriera di San Nicol&ograve;', stati[1]])}
${row(2, '13/11/2026 02:03 AM', ['Bocca di Malamocco', 'Barriera di Malamocco', stati[2]])} ${row(3, '13/11/2026 02:03 AM', ['Bocca di Chioggia', 'Barriera di Chioggia', stati[3]])}
${row(4, '21/04/2026 06:29 AM', ['', '', ''])}</tbody></table>
<table id="table_3">${head(['Stagione', 'Sollevamenti'])}<tbody><tr><td>1</td><td>a</td><td>b</td><td>c</td><td>d</td><td>2020/2021</td><td>20</td></tr></tbody></table></body></html>`;
const R = 'Paratoie in recesso', P = 'Programmato sollevamento di salvaguardia', F = 'Barriera in fase di sollevamento', S = 'Barriera sollevata';

test('tutte in recesso: verde, quattro barriere, righe vuote ignorate, entità HTML decodificate', () => {
  const p = mose.parse(page([R, R, R, R]));
  assert.strictEqual(p.stato, 'recesso'); assert.strictEqual(p.sem, 'verde');
  assert.strictEqual(p.titolo, 'MOSE non attivo: paratoie in recesso');
  assert.deepStrictEqual(p.barriere.map(b => b.barriera), ['Barriera di Treporti', 'Barriera di San Nicolò', 'Barriera di Malamocco', 'Barriera di Chioggia']);
  assert.deepStrictEqual(p.barriere.map(b => b.bocca), ['Bocca di Lido', 'Bocca di Lido', 'Bocca di Malamocco', 'Bocca di Chioggia']);
  assert.strictEqual(p.evento, null);
  assert.strictEqual(new Date(p.aggiornato).toISOString(), '2026-11-13T01:03:00.000Z');   // 02:03 ora di Roma (inverno, UTC+1)
});

test('stati della fonte -> semafori: programmato giallo, in sollevamento lampeggiante, sollevata rossa; il più grave decide il titolo', () => {
  assert.strictEqual(mose.classify(P).sem, 'giallo');
  assert.strictEqual(mose.classify(F).sem, 'lampeggia');
  assert.strictEqual(mose.classify(S).sem, 'rosso');
  assert.strictEqual(mose.classify('Testo nuovo mai visto').sem, 'grigio');
  const a = mose.parse(page([S, F, R, R])); assert.strictEqual(a.stato, 'sollevata'); assert.strictEqual(a.titolo, 'MOSE attivo: 1 barriera sollevata su 4');
  assert.strictEqual(mose.parse(page([S, S, F, R])).titolo, 'MOSE attivo: 2 barriere sollevate su 4');
  assert.strictEqual(mose.parse(page([R, F, R, R])).titolo, 'MOSE in attivazione: 1 barriera in sollevamento su 4');
  const b = mose.parse(page([S, S, S, S])); assert.strictEqual(b.titolo, 'MOSE attivo: tutte le barriere sollevate');
  const c = mose.parse(page([F, F, R, R])); assert.strictEqual(c.sem, 'lampeggia'); assert.match(c.titolo, /in sollevamento/);
  const d = mose.parse(page([P, P, P, P], ['14/11/2026', '06:30'])); assert.strictEqual(d.sem, 'giallo');
  assert.deepStrictEqual(d.evento, { data: '14/11/2026', orario: '06:30' });
});

test('pagina cambiata o vuota: nessuno stato inventato', () => {
  assert.strictEqual(mose.parse('<html><body>Manutenzione</body></html>'), null);
  assert.strictEqual(mose.parse(page(['', '', '', '']).replace(/Barriera di \w+( Nicol&ograve;)?/g, '')), null);
});

test('lettura: cache, errori della fonte senza perdere l\'ultimo stato, letture più frequenti con le barriere in movimento', async () => {
  mose._reset();
  let n = 0, html = page([R, R, R, R]), fail = false;
  const fetchFn = async () => { n++; if (fail) throw new Error('rete'); return { ok: true, text: async () => html }; };
  const t0 = Date.now();
  await mose.refresh({ fetchFn, now: t0 }); assert.strictEqual(n, 1); assert.strictEqual(mose.snapshot().stato, 'recesso');
  await mose.refresh({ fetchFn, now: Date.now() + 60e3 }); assert.strictEqual(n, 1, 'entro 10 minuti: dalla cache');
  fail = true; await mose.refresh({ fetchFn, now: Date.now() + 11 * 60e3 }); assert.strictEqual(n, 2);
  assert.strictEqual(mose.snapshot().stato, 'recesso', 'fonte giù: resta l\'ultimo stato letto');
  assert.ok(mose.snapshot().fonte.url.startsWith('https://www.autoritalaguna.it/'));
  assert.deepStrictEqual(mose.brief(), { stato: 'recesso', sem: 'verde' });
  assert.strictEqual(mose.brief(Date.now() + 3600e3), null, 'dato vecchio: niente semaforo sul pulsante');
  mose._reset();
});
