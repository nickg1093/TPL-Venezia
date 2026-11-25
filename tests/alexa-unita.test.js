// SKILL ALEXA: prove sulle funzioni di base (date e orari con ora legale, numeri e nomi parlati, flash briefing). Nessuna rete.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../alexa/tempo');
const P = require('../alexa/parlato');
const Flash = require('../alexa/flash');
const F = require('./alexa-fixtures');

test('tempo: ora legale 2026 (29 marzo e 25 ottobre): le 03:00 di Venezia corrispondono all\'istante giusto', () => {
  assert.equal(new Date(T.inizioMs('20260328', 3 * 3600)).toISOString(), '2026-03-28T02:00:00.000Z');   // CET (UTC+1)
  assert.equal(new Date(T.inizioMs('20260329', 3 * 3600)).toISOString(), '2026-03-29T01:00:00.000Z');   // CEST (UTC+2)
  assert.equal(new Date(T.inizioMs('20261025', 3 * 3600)).toISOString(), '2026-10-25T02:00:00.000Z');   // tornati a CET
  assert.equal(new Date(T.inizioMs('20261026', 0)).toISOString(), '2026-10-25T23:00:00.000Z');
});
test('tempo: cambio di giorno — dopo mezzanotte e prima delle 04:00 vale il giorno di servizio precedente (orari 24:xx)', () => {
  assert.deepEqual(T.giornoDiServizio(Date.UTC(2026, 10, 25, 23, 10)), { ymd: '20261125', secs: 24 * 3600 + 10 * 60, notte: true });   // 00:10 del 26
  assert.deepEqual(T.giornoDiServizio(Date.UTC(2026, 10, 25, 22, 59)), { ymd: '20261125', secs: 23 * 3600 + 59 * 60, notte: false });
  assert.equal(T.giornoDiServizio(Date.UTC(2026, 10, 26, 3, 5)).notte, false);                                                               // 04:05 → nuovo giorno
  // la notte del cambio all'ora solare (25 ottobre): le 02:30 esistono due volte, il giorno di servizio resta il 24
  assert.equal(T.giornoDiServizio(Date.UTC(2026, 9, 25, 0, 30)).ymd, '20261024');
  assert.equal(T.giornoDiServizio(Date.UTC(2026, 9, 25, 1, 30)).ymd, '20261024');
});
test('tempo: AMAZON.DATE / AMAZON.TIME — giorno, weekend, settimana, mese, fasce, valori non validi', () => {
  assert.deepEqual(T.risolviData('2026-11-26'), { da: '20261126', a: '20261126', tipo: 'giorno' });
  assert.deepEqual(T.risolviData('2026-W48-WE'), { da: '20261128', a: '20261129', tipo: 'weekend' });
  assert.deepEqual(T.risolviData('2026-W48'), { da: '20261123', a: '20261129', tipo: 'settimana' });
  assert.deepEqual(T.risolviData('2026-02'), { da: '20260201', a: '20260228', tipo: 'mese' });
  assert.equal(T.risolviData('2026-13-40'), null); assert.equal(T.risolviData('2026-02-30'), null); assert.equal(T.risolviData('boh'), null); assert.equal(T.risolviData(''), null);
  assert.equal(T.risolviOra('MO').secs, 8 * 3600); assert.equal(T.risolviOra('NI').nomeFascia, 'notte');
  assert.equal(T.risolviOra('08:30').secs, 8 * 3600 + 1800); assert.equal(T.risolviOra('24:00').secs, 0);
  assert.equal(T.risolviOra('25:00'), null); assert.equal(T.risolviOra('12:75'), null); assert.equal(T.risolviOra(null), null);
});
test('tempo: «quando» — senza dati = adesso; ora già passata oggi = domani; data futura senza ora = mattina', () => {
  const ADESSO = Date.UTC(2026, 10, 25, 9, 10);   // mercoledì 10:10 a Venezia
  assert.equal(T.quando({ adesso: ADESSO }).adesso, true);
  const q = T.quando({ ora: '08:00', adesso: ADESSO });
  assert.equal(q.ymd, '20261126'); assert.equal(q.spostatoADomani, true);
  assert.equal(T.quando({ ora: '10:30', adesso: ADESSO }).ymd, '20261125');
  const d = T.quando({ data: '2026-11-27', adesso: ADESSO }); assert.equal(d.ymd, '20261127'); assert.equal(d.secs, 8 * 3600);
  assert.equal(T.quando({ data: '2026-11-25', adesso: ADESSO }).adesso, true);
});
test('parlato: numeri, attese e durate in italiano corrente', () => {
  assert.equal(P.parole(0), 'zero'); assert.equal(P.parole(21), 'ventuno'); assert.equal(P.parole(101), 'centouno');
  assert.equal(P.attesa(0), 'adesso'); assert.equal(P.attesa(1), 'tra un minuto'); assert.equal(P.attesa(75), 'tra un\'ora e quindici minuti');
  assert.equal(P.durata(95), 'un\'ora e trentacinque');
  assert.equal(P.oraParlata('08:15'), 'alle otto e quindici'); assert.equal(P.oraParlata('01:00'), 'all\'una'); assert.equal(P.oraParlata('00:10'), 'a mezzanotte e dieci');
});
test('parlato: linee e fermate veneziane (punto decimale, pontile, abbreviazioni, apostrofo)', () => {
  assert.equal(P.lineaParlata('4.1'), 'quattro punto uno'); assert.equal(P.lineaParlata('5.2'), 'cinque punto due'); assert.equal(P.lineaParlata('6'), 'sei'); assert.equal(P.lineaParlata('T1'), 'T uno');
  assert.equal(P.fermataParlata('S. Marco-San Zaccaria "F"'), 'San Marco, San Zaccaria, pontile F');
  assert.equal(P.fermataParlata('Lido S.M.E. "B"'), 'Lido Santa Maria Elisabetta, pontile B');
  assert.equal(P.fermataParlata('P.le Roma "C"'), 'Piazzale Roma, pontile C');
  assert.equal(P.fermataParlata('Ca\' Rezzonico "B"'), 'Ca\' Rezzonico, pontile B');
});
test('parlato: giorni relativi', () => {
  assert.equal(P.giornoParlato('20261126', '20261125'), 'domani'); assert.equal(P.giornoParlato('20261127', '20261125'), 'dopodomani');
  assert.match(P.giornoParlato('20261130', '20261125'), /lunedì 30 novembre/);
});
test('flash briefing: due voci con testo semplice, identificativi stabili, risposta in memoria per un minuto', async () => {
  Flash._reset();
  const amb = F.ambiente({ '/api/avvisi': { updated: F.ADESSO, stale: false, items: [F.avviso({ title: 'Linea 2 deviata', effect: 'detour', lines: [{ n: '2', s: 'nav' }] })] }, '/api/tide': F.marea({ cm: 60, extremes: [F.estremo('max', 90, 3)] }), '/api/mose': F.mose('recesso') });
  const a = await Flash.feed(amb), b = await Flash.feed(amb);
  assert.ok(Array.isArray(a) && a.length === 2);
  for (const v of a) { assert.ok(v.uid && v.updateDate && v.titleText && v.mainText && v.redirectionUrl === undefined || v.redirectionUrl); assert.doesNotMatch(v.mainText, /<[^>]+>|&\w+;|https?:/); assert.ok(v.mainText.length <= 4500); }
  assert.deepEqual(a, b);
  assert.equal(amb.chiamate.filter(c => c.startsWith('/api/avvisi')).length, 1, 'il secondo giro usa la memoria');
});
test('flash briefing: se i dati non ci sono, voce di cortesia e non errore', async () => {
  Flash._reset();
  const a = await Flash.feed(F.ambiente({}));
  assert.ok(Array.isArray(a) && a.length >= 1);
  for (const v of a) assert.doesNotMatch(v.mainText, /undefined|Error|404/);
});
