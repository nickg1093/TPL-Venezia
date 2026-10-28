// Prove sugli avvisi: date in italiano, linee/fermate citate, lettura RSS e Telegram (esempi costruiti sulla struttura nota delle due fonti), unione delle fonti.
const test = require('node:test'), assert = require('node:assert');
const K = a => new Map(a.map(x => [x, [{ n: x, s: 'aut', c: '#d00000' }]]));
const L = r => r.map(x => x.n).sort();
const A = require('../avvisi');
const pub = Date.UTC(2026, 9, 27, 13, 43);   // 27/10/2026 14:43 a Venezia
const utc = (y, m, d, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s);   // ora solare (CET = UTC+1) dopo il 25/10/2026: sottrarre 1 ora

test('validità: giorno singolo con fascia oraria', () => {
  const v = A.parseValidity('Chiusura rotatoria. Sabato 31 ottobre 2026, dalle 9.30 alle 16.30', pub);
  assert.equal(v.from, utc(2026, 10, 31, 8, 30)); assert.equal(v.to, utc(2026, 10, 31, 15, 30)); assert.ok(v.dated && !v.open);
});
test('validità: da una data in poi (senza fine)', () => {
  const v = A.parseValidity('Automobilistico: modifiche ai servizi. Da lunedì 2 novembre 2026', pub);
  assert.equal(v.from, utc(2026, 11, 1, 23, 0)); assert.ok(v.open); assert.equal(v.to - v.from, 7 * 864e5);
});
test('validità: intervalli compatti e «dal … al …»', () => {
  let v = A.parseValidity('Orari invernali 1-2 novembre 2026', pub);
  assert.equal(v.from, utc(2026, 10, 31, 23, 0)); assert.equal(v.to, utc(2026, 11, 2, 22, 59, 59));
  v = A.parseValidity('Dal 28 ottobre al 3 novembre i battelli fanno', pub);
  assert.equal(v.from, utc(2026, 10, 27, 23, 0)); assert.equal(v.to, utc(2026, 11, 3, 22, 59, 59));
});
test('validità: «fino al» e senza date', () => {
  const v = A.parseValidity('Fermata sospesa fino al 5 novembre', pub);
  assert.equal(v.from, pub); assert.equal(v.to, utc(2026, 11, 5, 22, 59, 59));
  const u = A.parseValidity('People Mover sospeso per controlli', pub, 'tg'); assert.equal(u.to - u.from, 6 * 3600e3); assert.ok(!u.dated);
});
test('validità: senza anno si sceglie il prossimo futuro (passaggio d\'anno)', () => {
  const v = A.parseValidity('Dal 2 al 4 gennaio servizio festivo', utc(2026, 12, 30, 10));
  assert.equal(v.from, utc(2027, 1, 1, 23, 0));
});
test('linee: solo codici noti, mai le date', () => {
  const known = K(['31', '31H', '32H', '43', '7E', 'T2']);
  const t = 'Sabato 31 ottobre 2026 dalle 9.30 alle 16.30 le linee 31H, 32H e 43 deviano. Bus sostitutivi per T2.';
  assert.deepEqual(L(A.findLines(t, known)), ['31H', '32H', '43']);
  assert.deepEqual(L(A.findLines('Linea 7E deviata in via Cavin di Sala', known)), ['7E']);
});
test('fermate: nomi tra virgolette e dopo «fermata», solo uguaglianza di nome', () => {
  const by = new Map([[A.norm('Forte Marghera Gerlin'), ['aut:1', 'aut:2']], [A.norm('Cattaneo'), ['aut:3']]]);
  const t = 'Sospesa la fermata "Forte Marghera Gerlin" in entrambe le direzioni. Usare la fermata Cattaneo.';
  assert.deepEqual(A.findStops(t, by).sort(), ['aut:1', 'aut:2', 'aut:3']);
  assert.deepEqual(A.findStops('Fermata “Inventata Nome Lungo”', by), []);
});
test('RSS: elementi, entità, data di pubblicazione, link ammessi', () => {
  const xml = `<rss><channel><item><title>Mestre: chiusura &amp; deviazioni</title><link>https://actv.avmspa.it/it/content/x</link>
    <description>&lt;p&gt;Lingua&lt;/p&gt;&lt;p&gt;Sabato 31 ottobre 2026&lt;/p&gt;</description><pubDate>Tue, 27 Oct 2026 13:43:00 +0000</pubDate><guid isPermaLink="false">10661 at https://actv.avmspa.it</guid></item>
    <item><title>Link esterno</title><link>https://evil.example/x</link><pubDate>Tue, 27 Oct 2026 13:43:00 +0000</pubDate></item></channel></rss>`;
  const r = A.parseRss(xml); assert.equal(r.length, 1); assert.equal(r[0].title, 'Mestre: chiusura & deviazioni'); assert.equal(r[0].pubMs, pub);
  assert.match(r[0].text, /Sabato 31 ottobre 2026/);
});
test('Telegram: messaggi, testo, data, link', () => {
  const html = `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="muoversivenezia/11652">
    <div class="tgme_widget_message_text js-message_text" dir="auto">⚠️ People Mover sospeso per controlli.<br/>Navetta linea 2 tra Piazzale Roma e Tronchetto. <a href="https://actv.avmspa.it/it/content/pm">dettagli</a></div>
    <div class="tgme_widget_message_footer"><a class="tgme_widget_message_date" href="https://t.me/muoversivenezia/11652"><time datetime="2026-10-28T14:06:00+00:00" class="time">15:06</time></a></div></div></div>
    <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="muoversivenezia/11653"><div class="tgme_widget_message_text">Ripreso <b>servizio</b></div><time datetime="2026-10-29T05:42:00+00:00"></time></div></div>`;
  const m = A.parseTelegram(html); assert.equal(m.length, 2); assert.equal(m[0].id, 11652); assert.match(m[0].text, /People Mover sospeso/); assert.deepEqual(m[0].links, ['https://actv.avmspa.it/it/content/pm']);
  assert.equal(m[1].text, 'Ripreso servizio');
});
test('unione: un messaggio che rimanda alla notizia ACTV non duplica; scaduti esclusi; fermate collegate', () => {
  const now = Date.now(), d = new Date(now + 864e5), ds = `${d.getUTCDate()} ${['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const by = new Map([[A.norm('Forte Marghera Gerlin'), ['aut:9']]]);
  A.setContext(() => ({ known: K(['31H']), byName: by }));
  A._load({
    rss: [{ key: 'rss:1', title: 'Deviazione linea 31H', url: 'https://actv.avmspa.it/it/content/a', text: 'x', pubMs: now - 3600e3 },
          { key: 'rss:2', title: 'Vecchio avviso', url: 'https://actv.avmspa.it/it/content/b', text: '1 gennaio 2020', pubMs: now - 9e9 }],
    pages: { 'https://actv.avmspa.it/it/content/a': `Deviazione linea 31H. Sospesa la fermata "Forte Marghera Gerlin" fino al ${ds}.` },
    tg: [{ key: 'tg:1', id: 1, text: 'Deviazione, vedi sito', links: ['https://actv.avmspa.it/it/content/a'], pubMs: now - 1800e3, url: 'https://t.me/muoversivenezia/1' },
         { key: 'tg:2', id: 2, text: 'Avviso solo su Telegram', links: [], pubMs: now - 600e3, url: 'https://t.me/muoversivenezia/2' }]
  });
  const r = A.getAvvisi().items;
  assert.equal(r.length, 2); const a = r.find(x => x.title.startsWith('Deviazione'));
  assert.equal(a.source, 'both'); assert.deepEqual(a.stops, ['aut:9']); assert.deepEqual(L(a.lines), ['31H']); assert.equal(a.state, 'active');
  assert.ok(r.some(x => x.source === 'telegram'));
});
test('link: solo https verso domini ACTV/Telegram', () => {
  assert.ok(A.safeUrl('https://t.me/muoversivenezia/1')); assert.equal(A.safeUrl('http://actv.avmspa.it/x'), null);
  assert.equal(A.safeUrl('javascript:alert(1)'), null); assert.equal(A.safeUrl('https://actv.avmspa.it.evil.com/x'), null);
});

test('linee: elenco dopo i due punti, niente sigle da parole (Cimitero ≠ C), sciopero con più fasce = giornata intera', () => {
  const known = K(['1', '2', '12', 'NLN', 'DE', 'C', '13']);
  assert.deepEqual(L(A.findLines('linea 7 sospesa da lunedì 2 novembre 2026 Modifiche alle linee: 1, 2, 12, NLN: Nella news', known)), ['1', '12', '2', 'NLN']);
  assert.deepEqual(L(A.findLines('con la linea DE inoltre fermata di Cimitero e linea 13', known)), ['13', 'DE']);
  const v = A.parseValidity('30 ottobre 2026 dalle ore 06:00 e fino alle ore 08:59 e a partire dalle ore 16:30 fino alle ore 19:29', pub);
  assert.ok(!v.open); assert.equal(v.to - v.from, 864e5 - 1000);
});

test('testi codificati due volte e linee solo da elenchi dopo "linea"', () => {
  assert.equal(A.toText('&lt;img src="x" alt=""&gt; &lt;label&gt;Lingua &lt;/label&gt; Undefined fino al termine'), 'fino al termine');
  const known = K(['17', 'N', '5', 'V', '9S', '21', '56E']);
  assert.deepEqual(L(A.findLines('Garantite le linee 17 N 5 e V corse; Linea 9S: soppressa. Linea 21: nuova. Linea 56E La corsa', known)), ['17', '21', '56E', '9S']);
});
