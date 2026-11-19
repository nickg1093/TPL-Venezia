// Prove sugli avvisi: date in italiano, linee/fermate citate, lettura RSS e Telegram (esempi costruiti sulla struttura nota delle due fonti), unione delle fonti.
const test = require('node:test'), assert = require('node:assert');
const K = a => new Map(a.map(x => [x, [{ n: x, s: 'aut', c: '#d00000' }]]));
const L = r => r.map(x => x.n).sort();
const FL = (text, known) => A.analyze(text, '', { known }).lines;
const FS = (text, byName) => [...new Set([...A.stopMentions(text, byName).values()].flatMap(v => v.ids))].sort();
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
  assert.deepEqual(L(FL(t, known)), ['31H', '32H', '43', 'T2']);          // T2 (tram) riconosciuto anche senza "linea": i bus sostitutivi riguardano il tram
  assert.deepEqual(L(FL('Linea 7E deviata in via Cavin di Sala', known)), ['7E']);
});
test('fermate: nomi tra virgolette e dopo «fermata», solo uguaglianza di nome', () => {
  const by = new Map([[A.norm('Forte Marghera Gerlin'), ['aut:1', 'aut:2']], [A.norm('Cattaneo'), ['aut:3']]]);
  const t = 'Sospesa la fermata "Forte Marghera Gerlin" in entrambe le direzioni. Usare la fermata Cattaneo.';
  assert.deepEqual(FS(t, by).sort(), ['aut:1', 'aut:2', 'aut:3']);
  assert.deepEqual(FS('Fermata “Inventata Nome Lungo”', by), []);
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
test('proroga su Telegram che rimanda a una notizia ACTV vecchia (stessa pagina aggiornata): compare il messaggio nuovo', () => {
  const now = Date.now();
  A.setContext(() => ({ known: K(['24']), byName: new Map() }));
  A._load({
    rss: [{ key: 'rss:9', title: 'MESTRE - CHIUSURA DI VIA PIO X: ULTERIORE PROROGA LAVORI', url: 'https://actv.avmspa.it/it/content/pio-x', text: 'fino al 31 ottobre 2026', pubMs: now - 54 * 864e5 }],
    pages: { 'https://actv.avmspa.it/it/content/pio-x': 'Chiusura di via Pio X prorogata fino al 31 ottobre 2026. Linee deviate.' },
    tg: [{ key: 'tg:20', id: 20, text: '⚠️ #muoversivenezia | Mestre - via Pio X\n\nViene ulteriormente prorogata, fino al termine dei servizi di sabato 30 novembre 2026, la chiusura di via Pio X. I bus continueranno ad effettuare le deviazioni in corso.',
      links: ['https://actv.avmspa.it/it/content/pio-x'], pubMs: now - 3600e3, url: 'https://t.me/muoversivenezia/20' }]
  });
  const r = A.getAvvisi().items, pio = r.filter(x => /pio x/i.test(x.title));
  assert.equal(pio.length, 1, 'un solo avviso, quello nuovo'); assert.equal(pio[0].source, 'telegram'); assert.equal(pio[0].state, 'active');
  A._load({});
});
test('link: solo https verso domini ACTV/Telegram', () => {
  assert.ok(A.safeUrl('https://t.me/muoversivenezia/1')); assert.equal(A.safeUrl('http://actv.avmspa.it/x'), null);
  assert.equal(A.safeUrl('javascript:alert(1)'), null); assert.equal(A.safeUrl('https://actv.avmspa.it.evil.com/x'), null);
});

test('linee: elenco dopo i due punti, niente sigle da parole (Cimitero ≠ C), sciopero con più fasce = giornata intera', () => {
  const known = K(['1', '2', '12', 'NLN', 'DE', 'C', '13']);
  assert.deepEqual(L(FL('linea 7 sospesa da lunedì 2 novembre 2026 Modifiche alle linee: 1, 2, 12, NLN: Nella news', known)), ['1', '12', '2', 'NLN']);
  assert.deepEqual(L(FL('con la linea DE inoltre fermata di Cimitero e linea 13', known)), ['13', 'DE']);
  const v = A.parseValidity('30 ottobre 2026 dalle ore 06:00 e fino alle ore 08:59 e a partire dalle ore 16:30 fino alle ore 19:29', pub);
  assert.ok(!v.open); assert.equal(v.to - v.from, 864e5 - 1000);
});

test('testi codificati due volte e linee solo da elenchi dopo "linea"', () => {
  assert.equal(A.toText('&lt;img src="x" alt=""&gt; &lt;label&gt;Lingua &lt;/label&gt; Undefined fino al termine'), 'fino al termine');
  const known = K(['17', 'N', '5', 'V', '9S', '21', '56E']);
  assert.deepEqual(L(FL('Garantite le linee 17 N 5 e V corse; Linea 9S: soppressa. Linea 21: nuova. Linea 56E La corsa', known)), ['17', '21', '56E', '9S']);
});

test('linea 13 bus o battello dalle fermate citate; pontili “B” non sono linee; sciopero senza linee né fermate', () => {
  const known = new Map([['13', [{ n: '13', s: 'aut', c: '#d00000' }, { n: '13', s: 'nav', c: '#e5a000' }]], ['DE', [{ n: 'DE', s: 'nav', c: '#999999' }]], ['B', [{ n: 'B', s: 'nav', c: '#111111' }]]]);
  const byName = new Map([[A.norm('Fondamente Nove'), ['nav:1']], [A.norm('Cimitero'), ['nav:2', 'aut:7']], [A.norm('Corso del Popolo'), ['aut:3']]]);
  const lineStops = new Map([['nav:13', new Set(['nav:1', 'nav:2'])], ['aut:13', new Set(['aut:3'])], ['nav:DE', new Set(['nav:2'])]]);
  const ctx = { known, byName, lineStops, nameOf: id => id };
  const r = A.analyze('Commemorazione dei defunti: fermata straordinaria di linea 13', 'Da Fondamente Nove “B” a Cimitero “B”. LINEA ‘DE’ Fondamente Nove – Cimitero. Fermata straordinaria linea 13 a Cimitero.', ctx);
  assert.deepEqual(r.lines.map(l => l.s + ':' + l.n).sort(), ['nav:13', 'nav:DE']);
  assert.ok(r.stops.every(i => i.startsWith('nav:')) && r.stops.length === 2);
  assert.equal(r.stopNames.length, 2);
  const s = A.analyze('Sciopero generale 30 ottobre', 'Linea 13 e fermata Cimitero garantite', ctx);
  assert.deepEqual([s.lines, s.stops], [[], []]);
});

test('precisione: la fermata Crea di terraferma non entra con la linea DE; "Lido" in un testo su Mestre non è una fermata; numeri ambigui senza prove sono scartati', () => {
  const known = new Map([['DE', [{ n: 'DE', s: 'nav', c: '#999' }]], ['9', [{ n: '9', s: 'aut', c: '#d00' }, { n: '9', s: 'nav', c: '#fa0' }]]]);
  const byName = new Map([[A.norm('Crea'), ['nav:5', 'aut:8']], [A.norm('Lido'), ['nav:9']], [A.norm('Corso del Popolo'), ['aut:3']]]);
  const lineStops = new Map([['nav:DE', new Set(['nav:5'])], ['aut:9', new Set(['aut:3'])]]);
  const ctx = { known, byName, lineStops, nameOf: id => id };
  const r = A.analyze('Cimitero', 'LINEA ‘DE’ P.le Roma – Crea – Cimitero. Fermata Crea.', ctx);
  assert.deepEqual(r.stops, ['nav:5']);
  const m = A.analyze('Mestre: deviazione', 'Gli autobus della linea 9 in Corso del Popolo deviano. Il Lido non è interessato.', ctx);
  assert.deepEqual(m.lines.map(l => l.s), ['aut']); assert.deepEqual(m.stops, ['aut:3']);
  assert.deepEqual(A.analyze('Avviso', 'La linea 9 subisce ritardi', ctx).lines, []);
});

test('regole generali: "A partire" non è la linea A; pontile senza lettera = pontile della linea; strade non sono fermate; un servizio estraneo viene scartato', () => {
  const known = new Map([['13', [{ n: '13', s: 'nav', c: '#57419A' }]], ['DE', [{ n: 'DE', s: 'nav', c: null }]], ['A', [{ n: 'A', s: 'aut', c: '#EF7F1A' }]], ['31H', [{ n: '31H', s: 'aut', c: '#E31E24' }]]]);
  const byName = new Map([
    [A.norm('Riva de Biasio "A"'), ['nav:10']], [A.norm('Riva de Biasio "B"'), ['nav:11']], [A.norm('Riva de Biasio'), ['nav:10', 'nav:11']],
    [A.norm('Ferrovia'), ['nav:20']], [A.norm('Guglie'), ['nav:21']], [A.norm('Torino'), ['aut:30']], [A.norm('Corso del Popolo'), ['aut:31']]]);
  const lineStops = new Map([['nav:DE', new Set(['nav:11', 'nav:20', 'nav:21'])], ['nav:13', new Set(['nav:21'])], ['aut:A', new Set(['aut:99'])], ['aut:31H', new Set(['aut:31'])]]);
  const ctx = { known, byName, lineStops, nameOf: id => ({ 'nav:10': 'Riva de Biasio "A"', 'nav:11': 'Riva de Biasio "B"' }[id] || id) };
  const r = A.analyze('Defunti', 'Linea 13 - A partire da sabato. LINEA ‘DE’ Ferrovia – Riva de Biasio – Guglie – Cimitero (e ritorno).', ctx);
  assert.deepEqual(L(r.lines), ['13', 'DE']);
  assert.deepEqual(r.stops.sort(), ['nav:11', 'nav:20', 'nav:21']);                     // solo il pontile B di Riva de Biasio: è quello servito dalla linea DE
  assert.deepEqual(r.stopNames.map(s => s.n).sort(), ['Riva de Biasio "B"', 'nav:20', 'nav:21']);
  const m = A.analyze('Mestre', 'Linea 31H: deviazione in via Torino e Corso del Popolo.', ctx);
  assert.deepEqual(m.stops, ['aut:31']);                                                   // "via Torino" è una strada
});

// ---- v12: date più precise, riconoscimento universale delle linee, fili di avvisi ----
test('validità: «dalle ore 8.30 di venerdì 30 ottobre … fino al termine della manifestazione»', () => {
  const v = A.parseValidity('dalle ore 8.30 di venerdì 30 ottobre 2026 e fino al termine della manifestazione per un corteo', pub, 'tg');
  assert.equal(v.from, utc(2026, 10, 30, 7, 30)); assert.equal(v.to, utc(2026, 10, 30, 22, 59, 59)); assert.ok(v.untilEnd && !v.open);
});
test('validità: date relative, fasce senza data, «fino a nuova comunicazione», guasti brevi', () => {
  let v = A.parseValidity('Domani dalle 9.00 alle 12.00 deviazione', pub, 'tg');
  assert.equal(v.from, utc(2026, 10, 28, 8, 0)); assert.equal(v.to, utc(2026, 10, 28, 11, 0));
  v = A.parseValidity('Ponte chiuso dalle 21.00 alle 5.00', pub, 'tg'); assert.equal(v.from, utc(2026, 10, 27, 20, 0)); assert.equal(v.to, utc(2026, 10, 28, 4, 0));
  v = A.parseValidity('Fermata sospesa fino a nuova comunicazione', pub, 'tg'); assert.ok(v.open);
  v = A.parseValidity('Linea 2: rallentamenti per guasto', pub, 'tg'); assert.equal(v.to - v.from, 2 * 3600e3);
  v = A.parseValidity('Sabato 31 ottobre 2026 dalle 9.30 fino alle 18.00 di domenica 1 novembre 2026', pub);
  assert.equal(v.from, utc(2026, 10, 31, 8, 30)); assert.equal(v.to, utc(2026, 11, 1, 17, 0));
});
test('linee: parole di servizio, elenchi, unità, emoji (automobilistico o navigazione)', () => {
  const known = new Map([['2', [{ n: '2', s: 'aut' }, { n: '2', s: 'nav' }]], ['4.1', [{ n: '4.1', s: 'nav' }]], ['4.2', [{ n: '4.2', s: 'nav' }]], ['10', [{ n: '10', s: 'aut' }]],
    ['7E', [{ n: '7E', s: 'aut' }]], ['7H', [{ n: '7H', s: 'aut' }]], ['T1', [{ n: 'T1', s: 'aut' }]]]);
  const F = t => A.analyze(t, '', { known }).lines.map(l => l.s + ':' + l.n).sort();
  assert.deepEqual(F('Il vaporetto 2 non ferma a Rialto'), ['nav:2']);
  assert.deepEqual(F('Il bus 2 è deviato'), ['aut:2']);
  assert.deepEqual(F('Sospese le linee 4.1 4.2 per nebbia'), ['nav:4.1', 'nav:4.2']);
  assert.deepEqual(F('Bus con 10 minuti di ritardo'), []);
  assert.deepEqual(F('Linee interessate: 7E, 7H'), ['aut:7E', 'aut:7H']);
  assert.deepEqual(F('🚌 Linea 2 deviata'), ['aut:2']);
  assert.deepEqual(F('⛴ Linea 2 limitata'), ['nav:2']);
  assert.deepEqual(F('Linea 2 modificata'), []);                         // ambiguo senza indizi: nessuna
  assert.deepEqual(F('Tram T1 sostituito da bus'), ['aut:T1']);
});
test('fili: titolo Telegram ripulito, messaggi di servizio esclusi, aggiornamento sostituisce, ripristino chiude', () => {
  const now = Date.now(), known = new Map([['2', [{ n: '2', s: 'nav' }]]]);
  A.setContext(() => ({ known, byName: new Map() }));
  A._load({ tg: [
    { key: 'tg:10', id: 10, text: '#muoversivenezia | 📢 Mestre centro manifestazione\nCorteo in piazza', links: [], pubMs: now - 50 * 60e3, url: 'https://t.me/muoversivenezia/10' },
    { key: 'tg:11', id: 11, text: 'AVM/Actv Venezia pinned a photo', links: [], pubMs: now - 49 * 60e3, url: 'https://t.me/muoversivenezia/11' },
    { key: 'tg:12', id: 12, text: 'Linea 2 navigazione: guasto al pontile, servizio sospeso tra Rialto e San Marco', links: [], pubMs: now - 40 * 60e3, url: 'https://t.me/muoversivenezia/12' },
    { key: 'tg:13', id: 13, text: 'Linea 2 navigazione: servizio ripristinato', links: [], pubMs: now - 10 * 60e3, url: 'https://t.me/muoversivenezia/13' },
    { key: 'tg:14', id: 14, text: 'Acqua alta: picco previsto +110 cm alle 9.00', links: [], pubMs: now - 30 * 60e3, url: 'https://t.me/muoversivenezia/14' },
    { key: 'tg:15', id: 15, text: 'Aggiornamento acqua alta: picco previsto +120 cm', links: [], pubMs: now - 5 * 60e3, url: 'https://t.me/muoversivenezia/15' }] });
  const r = A.getAvvisi().items, t = r.map(x => x.title);
  assert.ok(t.includes('Mestre centro manifestazione')); assert.ok(!t.some(x => /pinned/.test(x)));
  assert.ok(!t.some(x => /guasto/.test(x)));                                     // chiuso dal ripristino
  const ok = r.find(x => /ripristinato/.test(x.title)); assert.ok(ok.resolved && ok.lines.length === 1);
  const aa = r.filter(x => /acqua alta/i.test(x.title)); assert.equal(aa.length, 1); assert.equal(aa[0].water.level, 120); assert.ok(aa[0].updated);
  A._load({});
});
test('fine degli avvisi: chiusure isolate, revoca sciopero, nebbia diradata, «fino alle» senza data', () => {
  const now = Date.now();
  A.setContext(() => ({ known: new Map(), byName: new Map() }));
  A._load({ tg: [
    { key: 'tg:20', id: 20, text: 'Sciopero del personale navigazione venerdì', links: [], pubMs: now - 50 * 60e3, url: 'https://t.me/muoversivenezia/20' },
    { key: 'tg:21', id: 21, text: 'Revoca dello sciopero del personale navigazione', links: [], pubMs: now - 30 * 60e3, url: 'https://t.me/muoversivenezia/21' },
    { key: 'tg:22', id: 22, text: 'Nebbia in laguna: servizi di navigazione rallentati', links: [], pubMs: now - 40 * 60e3, url: 'https://t.me/muoversivenezia/22' },
    { key: 'tg:23', id: 23, text: 'Nebbia diradata: servizi di navigazione regolari', links: [], pubMs: now - 5 * 60e3, url: 'https://t.me/muoversivenezia/23' },
    { key: 'tg:24', id: 24, text: 'Servizio ripristinato sul Ponte della Libertà', links: [], pubMs: now - 20 * 60e3, url: 'https://t.me/muoversivenezia/24' }] });
  const r = A.getAvvisi().items, warn = r.filter(x => !x.resolved).map(x => x.title);
  assert.deepEqual(warn, []); assert.equal(r.filter(x => x.resolved).length, 3);
  A._load({});
  const v = A.parseValidity('Fermata sospesa fino alle 23.00', pub, 'tg'); assert.equal(v.to, utc(2026, 10, 27, 22, 0));
});
test('effetto e gravità (modello GTFS-Realtime)', () => {
  const C = (title, text = '', extra = {}) => A.classify({ title, text, ...extra });
  assert.deepEqual([C('Linea 2 sospesa tra Rialto e San Marco').effect, C('Linea 2 sospesa').severity], ['no_service', 'severe']);
  assert.equal(C('Linea 7E deviata in via Cappuccina').effect, 'detour');
  assert.equal(C('Fermata provvisoria in via Torino').effect, 'stop_moved');
  assert.equal(C('Rallentamenti sulla linea 4.1').effect, 'delays');
  assert.deepEqual([C('Corse aggiuntive per la Festa').effect, C('Corse aggiuntive per la Festa').severity], ['additional', 'info']);
  assert.equal(C('Sciopero di 24 ore').effect, 'strike');
  assert.equal(C('Servizio ripristinato', '', { resolved: true }).severity, 'info');
  assert.equal(C('Acqua alta', '', { water: { level: 150 } }).severity, 'severe');
  assert.equal(C('Nuovi orari invernali', '', { general: true }).severity, 'info');
});

test('«People Mover» è la linea PM automobilistica, anche senza «linea PM»; il ripristino del People Mover chiude solo la PM', () => {
  const A = require('../avvisi');
  const known = new Map([['PM', [{ n: 'PM', s: 'aut', c: 'E31E24' }]], ['2', [{ n: '2', s: 'nav', c: null }, { n: '2', s: 'aut', c: null }]], ['5.1', [{ n: '5.1', s: 'nav', c: null }]]]);
  const ctx = { known, byName: new Map(), lineStops: new Map(), nameOf: id => id };
  const L = r => r.lines.map(l => l.s + ' ' + l.n).sort();
  assert.deepEqual(L(A.analyze('People Mover sospeso', 'Per manutenzione straordinaria il servizio People Mover è sospeso dalle 9.00 alle 13.00.', ctx)), ['aut PM']);
  assert.deepEqual(L(A.analyze('Avviso', 'Il people-mover Tronchetto - P.le Roma non è in servizio. Linea 5.1 regolare.', ctx)), ['aut PM', 'nav 5.1']);
  assert.deepEqual(L(A.analyze('Lavori', 'Linea PM: corse sostituite da bus navetta.', ctx)), ['aut PM']);
  assert.deepEqual(L(A.analyze('Lavori', 'Nessuna linea interessata, lavori in area Tronchetto.', ctx)), []);
});

test('«People Mover» in un elenco di reti (sciopero, personale) non diventa la linea PM', () => {
  const A = require('../avvisi');
  const ctx = { known: new Map([['PM', [{ n: 'PM', s: 'aut', c: null }]]]), byName: new Map(), lineStops: new Map(), nameOf: id => id };
  assert.deepEqual(A.analyze('Aggiornamento', 'I servizi di trasporto pubblico locale nelle reti di navigazione, automobilistico, tranviario e People Mover vengono confermati come regolari.', ctx).lines, []);
  assert.deepEqual(A.analyze('Avviso', 'Coinvolto il personale AVM dei parcheggi in struttura e people mover.', ctx).lines, []);
});

test('testi leggibili: titoli tutti maiuscoli resi normali (sigle, numeri romani, linee, nomi dopo via/San); niente emoji né indirizzi nel testo', () => {
  const A = require('../avvisi'), now = Date.now();
  A.setContext(() => ({ known: K(['24', 'T1']), byName: new Map([['mestre centro', ['aut:1']], ['lido s m e', ['nav:2']]]) }));
  A._load({
    rss: [{ key: 'rss:1', title: 'MESTRE - CHIUSURA DI VIA PIO X: LINEA T1 E BUS ACTV DEVIATI AL LIDO', url: 'https://actv.avmspa.it/it/content/x1', text: 'dal 10 al 30 novembre 2026', pubMs: now - 3600e3 }],
    tg: [{ key: 'tg:5', id: 5, text: '⚠️ #muoversivenezia | Mestre\n\n👉 Linea 24 deviata fino al 30 novembre 2026. tutte le info 🔗 https://actv.avmspa.it/it/content/x2 ✅ grazie', links: [], pubMs: now - 600e3, url: 'https://t.me/muoversivenezia/5' }]
  });
  const r = A.getAvvisi().items, a = r.find(x => x.source === 'actv'), t = r.find(x => x.source === 'telegram');
  assert.equal(a.title, 'Mestre - Chiusura di via Pio X: Linea T1 e bus ACTV deviati al Lido');
  assert.doesNotMatch(t.text, /https?:|[\u{1F300}-\u{1FAFF}✅⚠]/u); assert.match(t.text, /Linea 24 deviata fino al 30 novembre 2026\./);
  A._load({});
});

test('proroga annunciata su Telegram con il link a una notizia ACTV più vecchia ancora in corso (caso via Pio X): un solo avviso, quello nuovo', () => {
  const A = require('../avvisi'), now = Date.parse('2026-11-15T17:00:00+01:00');
  A.setContext(() => ({ known: K(['24']), byName: new Map() }));
  const url = 'https://actv.avmspa.it/it/content/mestre-chiusura-di-pio-x-ulteriore-proroga-lavori';
  A._load({
    rss: [{ key: 'rss:9', title: 'MESTRE - CHIUSURA DI VIA PIO X: ULTERIORE PROROGA LAVORI', url, text: 'fino al termine dei servizi di lunedì 30 novembre 2026', pubMs: Date.parse('2026-09-08T15:03:00+02:00') }],
    pages: { [url]: 'Chiusura di via Pio X prorogata fino al termine dei servizi di lunedì 30 novembre 2026. Linee deviate.' },
    tg: [{ key: 'tg:11880', id: 11880, text: '⚠️ #muoversivenezia | Mestre - via Pio X\n\n👉 Viene ulteriormente prorogata, fino al termine dei servizi di sabato 30 novembre 2026, la chiusura di via Pio X. I bus continueranno ad effettuare le deviazioni in corso. tutte le info 🔗 ' + url,
      links: [url], pubMs: Date.parse('2026-11-01T15:10:00+01:00'), url: 'https://t.me/muoversivenezia/11880' }]
  });
  const pio = A.build(now).filter(x => /pio x/i.test(x.title));
  assert.equal(pio.length, 1, 'un solo avviso'); assert.equal(pio[0].tgUrl, 'https://t.me/muoversivenezia/11880'); assert.equal(pio[0].url, url, 'con il link alla pagina ACTV');
  A._load({});
});

test('linee e fermate citate come ALTERNATIVA («sarà possibile accedere…», «potranno utilizzare…») non diventano linee colpite (caso People Mover)', () => {
  const A = require('../avvisi');
  const known = new Map([['2', [{ n: '2', s: 'nav', c: null }, { n: '2', s: 'aut', c: null }]], ['N', [{ n: 'N', s: 'nav', c: null }]], ['PM', [{ n: 'PM', s: 'aut', c: null }]],
    ['12', [{ n: '12', s: 'nav', c: null }]], ['4.1', [{ n: '4.1', s: 'nav', c: null }]], ['T1', [{ n: 'T1', s: 'aut', c: null }]]]);
  const ctx = { known, byName: new Map([['p.le roma g', ['nav:5031']], ['tronchetto mercato', ['nav:5004']], ['tronchetto', ['nav:5005']]]), lineStops: new Map(), nameOf: x => x };
  const L = r => r.lines.map(l => l.s + ':' + l.n).sort();
  const pm = A.analyze('People Mover chiusura temporanea impianto per manutenzione',
    'AVM/Actv informa che mercoledì 18 e 25 novembre 2026 dalle 9:00 alle 17:00 c.a. , l’impianto People Mover rimarrà chiuso per manutenzione.\n\nDurante tutta la durata della sospensione, sarà possibile accedere al servizio di navigazione di linea 2 e linea N , esclusivamente negli approdi di P.le Roma G, Tronchetto Mercato e Tronchetto e limitatamente alla percorrenza inclusa tra tali fermate, anche con il biglietto automobilistico da € 1,50 .', ctx);
  assert.deepEqual([L(pm), pm.stops], [['aut:PM'], []], 'solo il People Mover, niente approdi dell\'alternativa');
  assert.deepEqual(L(A.analyze('Avviso', 'Linea 4.1 sospesa per avaria. I passeggeri potranno utilizzare la linea 12 da Fondamente Nove.', ctx)), ['nav:4.1']);
  assert.deepEqual(L(A.analyze('Avviso', 'In alternativa si consiglia la linea 2. Resta sospesa la linea N fino a domani.', ctx)), ['nav:N']);
  // il servizio sostitutivo della linea X riguarda la linea X: resta
  assert.deepEqual(L(A.analyze('Tram: servizio sostitutivo linea T1', 'viene sospesa la linea T1 Favaro – Venezia e attivato il servizio sostitutivo con bus.', ctx)), ['aut:T1']);
});

test('la proroga su Telegram che sostituisce la notizia ACTV eredita linee e fermate se non ne cita di sue', () => {
  const A = require('../avvisi'), now = Date.parse('2026-11-15T17:00:00+01:00');
  A.setContext(() => ({ known: K(['24', '53E']), byName: new Map(), lineStops: new Map(), nameOf: x => x }));
  const url = 'https://actv.avmspa.it/it/content/mestre-chiusura-via-x';
  A._load({
    rss: [{ key: 'rss:9', title: 'MESTRE - CHIUSURA DI VIA X', url, text: 'chiusura di via X', pubMs: Date.parse('2026-09-08T15:03:00+02:00') }],
    pages: { [url]: 'Chiusura di via X fino a lunedì 30 novembre 2026. Deviate le linee 24 e 53E.' },
    tg: [{ key: 'tg:2', id: 2, text: 'Mestre - via X: viene ulteriormente prorogata, fino a lunedì 30 novembre 2026, la chiusura di via X. I bus delle linee interessate continueranno le deviazioni. info ' + url,
      links: [url], pubMs: Date.parse('2026-11-01T15:10:00+01:00'), url: 'https://t.me/muoversivenezia/2' }]
  });
  const r = A.build(now).filter(x => /via x/i.test(x.title));
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].lines.map(l => l.n).sort(), ['24', '53E'], 'linee ereditate dalla notizia sostituita');
  A._load({});
});

test('date: elenco di giorni non consecutivi («mercoledì 18 e 25 novembre») = giorni separati; «sabato 21 e domenica 22» = due giorni', () => {
  const A = require('../avvisi'), pub = Date.parse('2026-11-09T10:00:00+01:00'), h = ms => new Date(ms).toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  const pm = A.parseValidity('AVM/Actv informa che mercoledì 18 e 25 novembre 2026 dalle 9:00 alle 17:00 c.a. , l’impianto People Mover rimarrà chiuso.', pub, 'rss');
  assert.deepEqual(pm.giorni.map(([a, b]) => [h(a), h(b)]), [['18/11/2026, 09:00:00', '18/11/2026, 17:00:00'], ['25/11/2026, 09:00:00', '25/11/2026, 17:00:00']]);
  const we = A.parseValidity('sabato 21 e domenica 22 novembre 2026 servizio aggiuntivo', pub, 'rss');
  assert.deepEqual([h(we.from), h(we.to), we.giorni], ['21/11/2026, 00:00:00', '22/11/2026, 23:59:59', undefined], 'giorni consecutivi: periodo continuo, dal sabato');
  assert.equal(A.parseValidity('lavori il 10, 11 e 12 novembre 2026', pub, 'rss').giorni, undefined);
  assert.equal(A.parseValidity('corse sospese il 7, 14 e 21 dicembre 2026', pub, 'rss').giorni.length, 3);
  assert.equal(A.parseValidity('chiusa dal 2 al 4 dicembre 2026', pub, 'rss').giorni, undefined);
});

test('promemoria di un altro avviso («Si ricorda che…») non dà date, linee né fermate; People Mover in «servizio regolare» non è la linea PM', () => {
  const A = require('../avvisi'), pub = Date.parse('2026-11-16T10:57:00+01:00'), h = ms => new Date(ms).toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  A.setContext(() => ({ known: new Map([['1', [{ n: '1', s: 'nav', c: null }]], ['2', [{ n: '2', s: 'nav', c: null }]], ['PM', [{ n: 'PM', s: 'aut', c: null }]]]),
    byName: new Map([['s. maria del giglio', ['nav:9']], ['salute', ['nav:8']]]), lineStops: new Map(), nameOf: x => x }));
  const url = 'https://actv.avmspa.it/it/content/madonna-della-salute-servizi-di-trasporto-pubblico';
  A._load({ rss: [{ key: 'rss:7526', title: 'Madonna della Salute: servizi di trasporto pubblico e mobilità', url, text: 'x', pubMs: pub }],
    pages: { [url]: 'AVM/Actv informa che in occasione della festa della Madonna della Salute, da inizio servizi di venerdì 20 novembre 2026 sino a fine servizi di lunedì 23 novembre 2026 , l’utilizzo degli impianti della Salute viene modificato come segue:\n\nLinea 1 in direzione P. Roma approderà alla fermata di Salute.\n\nSi ricorda che da dalle ore 07:00 di martedì 17 novembre fino alle ore 17:00 di lunedì 30 novembre 2026 viene sospesa la fermata di S. Maria del Giglio per la presenza del ponte votivo.\n\nMentre i servizi di trasporto pubblico urbano (autobus, tram, navigazione e people mover) seguiranno il normale orario feriale.' },
    tg: [{ key: 'tg:11914', id: 11914, text: 'Madonna della Salute\n\nsabato 21 e domenica 22 novembre 2026\n\nsono effettuati collegamenti aggiuntivi linea 1 nel tratto San Tomà-Lido SME.\nNella news linee e orari https://actv.avmspa.it/it/content/madonna-della-salute-servizi-di-trasporto-pubblico-e-mobilita',
      links: ['https://actv.avmspa.it/it/content/madonna-della-salute-servizi-di-trasporto-pubblico-e-mobilita'], pubMs: pub + 6 * 60e3, url: 'https://t.me/muoversivenezia/11914' }] });
  const r = A.build(pub + 2 * 864e5).filter(x => /salute/i.test(x.title));   // (si pubblicano gli avvisi che iniziano entro 3 giorni)
  assert.equal(r.length, 1, 'Telegram e ACTV uniti anche con l\'indirizzo della pagina allungato');
  assert.equal(r[0].source, 'both');
  assert.deepEqual([h(r[0].from), h(r[0].to)], ['20/11/2026, 00:00:00', '23/11/2026, 23:59:59'], 'periodo della festa, non quello del promemoria');
  assert.deepEqual(r[0].lines.map(l => l.s + ':' + l.n), ['nav:1'], 'niente PM (servizio regolare)');
  assert.ok(!r[0].stops.includes('nav:9'), 'S. Maria del Giglio (promemoria) non è una fermata di questo avviso');
  A._load({});
});

// ---------------------------------------------------------------------------------------------------------------------
// CASI REALI (v33.1, tests/avvisi-casi-reali.json: testi del ramo archivio-avvisi, ottobre-novembre 2026, con fermate e linee vere dei GTFS)
// ---------------------------------------------------------------------------------------------------------------------
{
  const R = require('./avvisi-casi-reali.json'), aiv = require('../avvisi-ai');
  const known = new Map();
  for (const s of ['nav', 'aut']) for (const n of R.ctx.lines[s]) (known.get(n.toUpperCase()) || known.set(n.toUpperCase(), []).get(n.toUpperCase())).push({ n, s, c: null });
  const byName = new Map(), add = (k, id) => { if (k) (byName.get(k) || byName.set(k, []).get(k)).push(id); };
  for (const [id, nm] of Object.entries(R.ctx.stops)) { const k1 = A.norm(nm), k2 = A.norm(nm.replace(/\s*"[A-Z0-9]+"\s*$/, '')); add(k1, id); if (k2 !== k1) add(k2, id); }
  const lineStops = new Map(Object.entries(R.ctx.lineStops).map(([k, v]) => [k, new Set(v)]));
  const ctx = { known, byName, lineStops, nameOf: id => R.ctx.stops[id] };
  const load = () => { A.setContext(() => ctx); A.setTideSource(() => null); A._load({ rss: R.rss, tg: R.tg, pages: R.pages }); };
  const evs = () => { load(); return A.eventi(Date.parse('2026-11-19T20:00:00+01:00')); };
  const ev = re => evs().filter(e => re.test(e.titolo));
  const at = s => Date.parse(s);

  test('casi reali · pontile sospeso: «San Basilio» = S. Basilio del GTFS; le fermate «in direzione P.le Roma» non sono toccate', () => {
    const e = ev(/sospensione fermata San Basilio/)[0];
    assert.deepEqual(e.fermate, ['S. Basilio']); assert.deepEqual(e.linee.sort(), ['nav:2', 'nav:6']);
  });
  test('casi reali · fermata sostitutiva: «utilizzeranno il vicino impianto di Zattere "A"» resta fuori', () => {
    assert.deepEqual(ev(/Zattere/)[0].fermate, ['Zattere "B"']);
  });
  test('casi reali · «San Marco Giardinetti» trovata (prima: solo le fermate di Rialto dell\'alternativa)', () => {
    assert.deepEqual(ev(/Giardinetti/)[0].fermate, ['S. Marco Giardinetti "A"']);
  });
  test('casi reali · settore: «i bus della linea 9» non è il battello 9; capilinea nel nome della linea non sono fermate', () => {
    assert.deepEqual(ev(/^Marcon/)[0].linee, []);
    const m = ev(/Maerne: chiusura/)[0];
    assert.deepEqual(m.linee.sort(), ['aut:48H', 'aut:5E', 'aut:HE']); assert.deepEqual(m.fermate, []);
  });
  test('casi reali · settore dall\'AI: in un avviso di navigazione la «linea 7» senza indizi non diventa il bus 7', () => {
    const { ai, rec } = R.ai['rss:10658'], v = aiv.validate(ai, { ...rec, id: rec.id }, ctx, []);
    assert.ok(!v.linee.some(l => l.n === '7')); assert.ok(v.linee.some(l => l.s === 'nav' && l.n === '6'));
    assert.ok(!ev(/orari invernali/)[0].linee.includes('aut:7'));
  });
  test('casi reali · date: giorno senza mese, elenco con i nomi dei giorni e fascia giornaliera, «dalle 8.00 di martedì 10»', () => {
    const c = ev(/^Mestre$/).find(e => e.fermate.includes('Ca\' Solaro'));
    assert.equal(c.periodo.inizio, at('2026-10-19T00:00:00+02:00'), '«di lunedì 19 e … di martedì 20 ottobre»');
    load(); const ch = A.build(at('2026-11-05T12:00:00+01:00')).find(o => /Chioggia/.test(o.title));
    assert.deepEqual(ch.giorni, [4, 5, 6].map(d => [at(`2026-11-0${d}T08:30:00+01:00`), at(`2026-11-0${d}T18:30:00+01:00`)]));
    assert.equal(ev(/Lido San Nicol/)[0].periodo.inizio, at('2026-11-10T08:00:00+01:00'));
  });
  test('casi reali · fusioni: aggiornamento Telegram della stessa pagina ACTV (cantiere Mestre FS) e «ripristino ora solare»', () => {
    const c = ev(/Cantiere Stazione Mestre FS|avvio lavori nuova stazione/);
    assert.equal(c.length, 1, 'un solo evento');
    assert.equal(c[0].periodo.fine, at('2026-11-09T00:00:00+01:00'), 'finisce quando il messaggio dice «viene ristabilito»');
    assert.equal(ev(/ora solare/).length, 1);
  });
  test('casi reali · propagazione: sospensione di un pontile = ambito «fermate» (non su tutte le fermate della linea)', () => {
    load();
    const crea = A.build(at('2026-11-19T10:00:00+01:00')).find(o => /Crea/.test(o.title));
    assert.equal(crea.ambito, 'fermate');
    const sb = A.build(at('2026-11-24T10:00:00+01:00')).find(o => /San Basilio/.test(o.title));
    assert.equal(sb.ambito, 'fermate'); assert.deepEqual(sb.stopNames.map(x => x.n), ['S. Basilio']);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// SCIOPERO (v33.3): testi reali dello sciopero del 20/11/2026 (tests/avvisi-1911.json: comunicato ACTV del 6/11 e messaggi Telegram 11907, 11920)
// ---------------------------------------------------------------------------------------------------------------------
{
  const J = require('./avvisi-1911.json');
  const ctx = { known: new Map(), byName: new Map(), lineStops: new Map(), nameOf: id => id };
  const at = s => Date.parse(s);
  const run = (now, extraTg = []) => { A.setContext(() => ctx); A.setTideSource(() => null); A._load({ rss: J.rss, tg: [...J.tg, ...extraTg], pages: J.pages }); return A.build(now).filter(o => o.effect === 'strike'); };

  test('sciopero · riconosciuto, un solo avviso, fasce garantite dal testo e link ufficiali (solo ACTV e Telegram)', () => {
    const s = run(at('2026-11-19T20:00:00+01:00'));
    assert.equal(s.length, 1);
    const x = s[0].sciopero;
    assert.equal(x.inizio, at('2026-11-20T00:00:00+01:00')); assert.equal(x.fine, at('2026-11-20T23:59:59+01:00'));
    assert.deepEqual(x.fasce, [['06:00', '08:59'], ['16:30', '19:29']]);
    assert.deepEqual(x.link.map(l => l.label), ['Comunicato ACTV', 'Messaggio sul canale Telegram ACTV']);
    assert.ok(x.link.every(l => /^https:\/\/(actv\.avmspa\.it|t\.me)\//.test(l.url)), 'nessun link esterno (bit.ly scartato)');
  });
  test('sciopero · finestra di esposizione: da 8 ore prima alle 05:00 del giorno dopo', () => {
    const x = run(at('2026-11-19T20:00:00+01:00'))[0].sciopero;
    assert.equal(x.da, at('2026-11-19T16:00:00+01:00')); assert.equal(x.fino, at('2026-11-21T05:00:00+01:00'));
    assert.equal(run(at('2026-11-21T04:30:00+01:00')).length, 1, 'alle 4:30 del giorno dopo è ancora tra gli avvisi');
    assert.equal(run(at('2026-11-21T04:30:00+01:00'))[0].state, 'active');
    assert.equal(run(at('2026-11-21T05:30:00+01:00')).length, 0, 'alle 5:30 non più');
  });
  test('sciopero · un PDF ACTV citato in un messaggio diventa un link «Documento ACTV (PDF)»', () => {
    const extra = { key: 'tg:99001', id: 99001, pubMs: at('2026-11-19T12:00:00+01:00'), url: 'https://t.me/muoversivenezia/99001',
      text: '⚠️ #muoversivenezia | SCIOPERO GENERALE NAZIONALE 24H\n\n🗓 venerdì 20 novembre 2026\n\nlocandina dei servizi minimi garantiti 👉 https://actv.avmspa.it/sites/default/files/sciopero-20-11.pdf',
      links: ['https://actv.avmspa.it/sites/default/files/sciopero-20-11.pdf', 'https://bit.ly/abc'] };
    const x = run(at('2026-11-19T20:00:00+01:00'), [extra])[0].sciopero;
    assert.ok(x.link.some(l => l.label === 'Documento ACTV (PDF)' && /sciopero-20-11\.pdf$/.test(l.url)), JSON.stringify(x.link));
    assert.ok(!x.link.some(l => /bit\.ly/.test(l.url)));
  });
}
