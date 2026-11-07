// MODELLO DEGLI EVENTI SU COMUNICAZIONI REALI (tests/avvisi-corpus.json: feed RSS e 95 messaggi Telegram ACTV dal 13/10 al 7/11/2026).
// Si simula il funzionamento del server: «in diretta» ci sono solo gli ultimi 20 messaggi Telegram pubblicati (come la pagina pubblica) e le notizie RSS;
// l'archivio (avvisi-archivio.js) contiene tutte le comunicazioni già pubblicate. I casi citati sono reali, salvo quelli marcati SINTETICO.
const test = require('node:test'), assert = require('node:assert');
const A = require('../avvisi'), AR = require('../avvisi-archivio');
const C = require('./avvisi-corpus.json');

const LINES = { aut: ['T1', 'T2', '2', '2E', '4L', '5E', '6', '6E', '6L', '7', '7E', '8E', '9E', '9H', '9S', '10', '14E', '15', '19', '21', '31H', '32H', '43', '44', '48H', '53', '53E', '56E', '57E', '58E', '58RE', 'HE'],
  nav: ['1', '2', '3', '5.1', '5.2', '6', '11', '12', '13', '14', '15', '17', 'DE', 'N', 'NLN'] };
const known = new Map();
for (const s in LINES) for (const n of LINES[s]) (known.get(n.toUpperCase()) || known.set(n.toUpperCase(), []).get(n.toUpperCase())).push({ n, s, c: null });
const ctx = { known, byName: new Map(), lineStops: new Map(), nameOf: id => id };
const at = s => Date.parse(s);
const tgOf = n => C.tg.find(m => m.id === n);
const rec = (src, m) => ({ ...AR.recordOf(src, m, src === 'rss' ? C.pages[m.url] : null, C.letto), v: 1 });
// stato del server all'istante now: live = pagina pubblica (ultimi 20 messaggi), archivio = tutto il pubblicato fino a now
function load(now, { archive = true, live = true, tg = C.tg, rss = C.rss } = {}) {
  const T = tg.filter(m => m.pubMs <= now), R = rss.filter(r => r.pubMs <= now);
  AR._setRecords(archive ? [...R.map(r => rec('rss', r)), ...T.map(m => rec('tg', m))] : []);
  A.setContext(() => ctx); A.setTideSource(() => null);
  A._load(live ? { rss: R, tg: T.slice(-20), pages: C.pages } : {});
}
const avvisi = now => A.build(now, { interni: true });
const eventi = now => A.eventi(now);
const evOf = (list, key) => list.find(e => e.comunicazioni.some(m => m.key === key));
const roles = e => e.comunicazioni.map(m => `${m.key}:${m.ruolo}`);
test.afterEach(() => { AR._setRecords([]); A._load({}); });

test('eventi · guasti T1 reali: guasto + «torna progressivamente regolare» = un evento, chiusura tecnica dopo 60 min, eventi di giorni diversi distinti', () => {
  const now = at('2026-11-07T15:45:00+01:00'); load(now); const E = eventi(now);
  const pairs = [[11797, 11798], [11800, 11801], [11821, 11822], [11827, 11828], [11894, 11895]];
  const ids = new Set();
  for (const [g, r] of pairs) {
    const e = evOf(E, 'tg:' + g); assert.ok(e, `evento del guasto ${g}`);
    assert.deepEqual(roles(e), [`tg:${g}:origine`, `tg:${r}:ripristino in corso`]);
    assert.equal(e.stato, 'concluso'); assert.equal(e.chiusura, 'tecnica'); assert.equal(e.periodo.fine, tgOf(r).pubMs + 3600e3);
    assert.deepEqual(e.linee, ['aut:T1']); ids.add(e.id);
  }
  assert.equal(ids.size, pairs.length, 'cinque guasti in giorni diversi = cinque eventi');
});

test('eventi · corteo del 16/10 (risposte): ripristino parziale della T2, ripristino non collegabile senza modifiche, chiusura finale', () => {
  const t1 = tgOf(11810).pubMs + 60e3; load(t1);
  let e = evOf(eventi(t1), 'tg:11806');
  assert.ok(roles(e).includes('tg:11810:ripristino parziale'), 'La Linea T2 riprende regolare');
  assert.equal(e.stato, 'in corso'); assert.ok(!e.linee.includes('aut:T2'), 'la T2 non è più nell\'evento'); assert.ok(e.linee.includes('aut:15'));
  const a = avvisi(t1); assert.ok(a.some(x => x.eventId === e.id && !x.resolved && !x.lines.some(l => l.n === 'T2')), 'l\'avviso resta senza la T2');
  const t2 = tgOf(11811).pubMs + 60e3; load(t2);
  const before = evOf(eventi(t1), 'tg:11806');
  e = evOf(eventi(t2), 'tg:11806'); assert.deepEqual(e.linee, before.linee, '«la linea 4l riprende regolare»: linea non dell\'evento, nessuna modifica');
  const n = evOf(eventi(t2), 'tg:11811'); assert.equal(n.incerte.length, 1);
  const t3 = tgOf(11814).pubMs + 60e3; load(t3);
  e = evOf(eventi(t3), 'tg:11806');
  assert.equal(e.chiusura, 'esplicita'); assert.ok(roles(e).includes('tg:11814:ripristino completo'));
  assert.equal(e.comunicazioni.find(m => m.key === 'tg:11814').certezza, 'esplicita', 'risposta Telegram = riferimento esplicito');
});

test('eventi · corteo del 30/10: «✅ T1 regolare» parziale, «✅ linea T2 regolare» chiude, la nuova interruzione T1 compare', () => {
  const t1 = tgOf(11865).pubMs + 60e3; load(t1);
  let a = avvisi(t1), main = a.find(x => x.lines.some(l => l.n === 'T2') && !x.resolved);
  assert.ok(main && !main.lines.some(l => l.n === 'T1'), 'resta aperto solo per la T2');
  assert.ok(a.some(x => x.resolved && /T1 regolare/.test(x.title)), 'notizia «T1 regolare»');
  assert.ok(!a.some(x => !x.resolved && /T1 regolare/.test(x.title)), '«T1 regolare» non è mai un disservizio');
  const t2 = tgOf(11866).pubMs + 60e3; load(t2);
  assert.ok(!avvisi(t2).some(x => !x.resolved && x.lines.some(l => l.n === 'T2')), 'la T2 è regolare: evento chiuso');
  const t3 = tgOf(11867).pubMs + 60e3; load(t3);
  const t1i = avvisi(t3).find(x => /Linea T1 interrotta/.test(x.title));
  assert.ok(t1i && t1i.effect === 'no_service' && t1i.state === 'active', 'nuova interruzione T1 visibile');
});

test('eventi · sciopero del 30/10 precettato: «servizi confermati come regolari» annulla l\'evento futuro', () => {
  const now = at('2026-10-30T10:00:00+01:00'); load(now);
  const e = evOf(eventi(now), 'tg:11833');
  assert.equal(e.stato, 'annullato'); assert.ok(roles(e).includes('tg:11857:annullamento'));
  assert.ok(!avvisi(now).some(x => x.eventId === e.id && !x.resolved), 'lo sciopero annullato non compare tra gli avvisi');
});

test('eventi · rinvio (ferry linea 11, 24/10) e ripristino programmato (tram T2 dal 27/10)', () => {
  let now = tgOf(11841).pubMs + 60e3; load(now);
  let e = evOf(eventi(now), 'tg:11839');
  assert.deepEqual([e.stato, e.chiusura], ['concluso', 'rinviato']); assert.ok(roles(e).includes('tg:11841:rinvio'));
  assert.ok(!avvisi(now).some(x => x.eventId === e.id && !x.resolved));
  now = at('2026-10-26T18:00:00+01:00'); load(now);
  e = evOf(eventi(now), 'tg:11838');
  assert.ok(roles(e).includes('tg:11851:ripristino programmato')); assert.ok(e.periodo.fine <= at('2026-10-27T00:00:00+01:00'));
  assert.ok(!avvisi(now).some(x => /da inizio servizi del 27 ottobre/.test(x.title + ' ' + x.text)), 'il ripristino programmato non diventa un nuovo avviso');
});

test('eventi · avvisi futuri e passati conservati; il sostitutivo T1 di lunedì resta separato dal guasto (correzione T1)', () => {
  const now = at('2026-11-07T15:45:00+01:00'); load(now); const E = eventi(now);
  const mon = evOf(E, 'rss:10605 at https://actv.avmspa.it');
  assert.equal(mon.stato, 'programmato'); assert.deepEqual(roles(mon), ['rss:10605 at https://actv.avmspa.it:origine']);
  assert.ok(E.filter(e => e.stato === 'programmato').length >= 5, 'eventi futuri');
  assert.ok(E.filter(e => e.stato === 'concluso').length >= 50, 'eventi passati conservati');
  for (const e of E) { assert.ok(e.cronologia.length >= 1); assert.ok(e.comunicazioni[0].ruolo === 'origine'); }
  assert.ok(avvisi(now).some(x => x.eventId === mon.id && x.state === 'upcoming'));
});

test('archivio · avvisi ancora validi usciti dalla pagina Telegram restano; stessa uscita con e senza duplicati', () => {
  const now = at('2026-11-25T12:00:00+01:00');
  // SINTETICO: 20 messaggi successivi riempiono la pagina pubblica; via Pio X (11880, fino al 30/11) non è più in diretta
  const extra = Array.from({ length: 20 }, (_, i) => ({ key: 'tg:' + (12000 + i), id: 12000 + i, text: 'Park Candiani temporaneamente al completo', links: [], pubMs: at('2026-11-24T08:00:00+01:00') + i * 60e3, url: 'https://t.me/muoversivenezia/' + (12000 + i) }));
  const tg = [...C.tg, ...extra];
  load(now, { tg, archive: false }); assert.ok(!avvisi(now).some(x => /Pio X/.test(x.title)), 'senza archivio l\'avviso si perde (comportamento v23)');
  load(now, { tg }); const withArc = avvisi(now); assert.ok(withArc.some(x => /Pio X/.test(x.title) && x.state === 'active'), 'con l\'archivio resta fino al 30/11');
  load(now, { tg, live: false }); assert.deepEqual(avvisi(now), withArc, 'solo archivio (fonti irraggiungibili) = stesso risultato');
});

test('archivio · ricostruzione dopo un riavvio: dall\'archivio solo, stessi eventi e stessi avvisi', () => {
  const now = at('2026-11-07T15:45:00+01:00');
  load(now); const ev1 = eventi(now).map(e => [e.id, e.stato, e.chiusura, roles(e).join()]), av1 = avvisi(now);
  load(now, { live: false }); const ev2 = eventi(now).map(e => [e.id, e.stato, e.chiusura, roles(e).join()]), av2 = avvisi(now);
  assert.deepEqual(ev2, ev1); assert.deepEqual(av2, av1);
});

test('archivio · messaggio modificato da ACTV: vale l\'ultima versione, la precedente resta nella cronologia', () => {
  const now = at('2026-11-07T15:45:00+01:00'), m = tgOf(11893);
  load(now);
  const v2 = { ...m, text: m.text.replace('linee 15 e 9H', 'linee 15, 19 e 9H') };   // SINTETICO: correzione dell'elenco delle linee
  const r1 = rec('tg', m), r2 = { ...AR.recordOf('tg', v2, null, at('2026-11-06T18:00:00+01:00')), v: 2 };
  AR._setRecords([...C.rss.map(r => rec('rss', r)), ...C.tg.filter(x => x.id !== 11893).map(x => rec('tg', x)), r1, r2]);
  A._load({ rss: C.rss, pages: C.pages, tg: [] });
  const e = evOf(eventi(now), 'tg:11893');
  assert.ok(e.cronologia.some(h => /testo modificato dalla fonte \(versione 2\)/.test(h.azione)));
  assert.equal(e.comunicazioni.find(x => x.key === 'tg:11893').versioni, 2);
});

test('archivio · fonte in diretta temporaneamente vuota: nessun avviso perso', () => {
  const now = at('2026-11-07T15:45:00+01:00');
  load(now); const full = avvisi(now);
  AR._setRecords([...C.rss.map(r => rec('rss', r)), ...C.tg.map(m => rec('tg', m))]);
  A._load({ rss: [], tg: C.tg.filter(m => m.pubMs <= now).slice(-20), pages: {} });   // feed RSS non raggiungibile
  assert.deepEqual(avvisi(now).map(x => x.id).sort(), full.map(x => x.id).sort());
});

test('eventi · due disservizi contemporanei sulla stessa linea restano distinti; un ripristino generico non ne chiude nessuno (SINTETICI)', () => {
  const t = at('2026-11-20T09:00:00+01:00');
  const mk = (id, text, pub, extra = {}) => ({ key: 'tg:' + id, id, text, links: [], pubMs: pub, url: 'https://t.me/muoversivenezia/' + id, ...extra });
  const a1 = mk(13001, 'Tram T1: incidente in via Cappuccina, servizio sospeso', t), a2 = mk(13002, 'Tram T1: corteo in piazza Ferretto, servizio deviato', t + 5 * 60e3);
  const g = mk(13003, 'Tram T1: servizio ripristinato', t + 30 * 60e3), r = mk(13004, '✅ T1 regolare', t + 40 * 60e3, { replyTo: 13002 });
  load(t + 35 * 60e3, { tg: [...C.tg, a1, a2, g] });
  let E = eventi(t + 35 * 60e3), e1 = evOf(E, 'tg:13001'), e2 = evOf(E, 'tg:13002');
  assert.notEqual(e1.id, e2.id); assert.deepEqual([e1.stato, e2.stato], ['in corso', 'in corso']);
  assert.equal(evOf(E, 'tg:13003').incerte.length, 1, 'collegamento incerto registrato, non applicato');
  load(t + 45 * 60e3, { tg: [...C.tg, a1, a2, g, r] });
  E = eventi(t + 45 * 60e3); e1 = evOf(E, 'tg:13001'); e2 = evOf(E, 'tg:13002');
  assert.equal(e1.stato, 'in corso'); assert.equal(e2.chiusura, 'esplicita', 'la risposta chiude solo l\'evento citato');
});
