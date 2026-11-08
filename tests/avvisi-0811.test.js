// CASO P.LE ROMA "G" DELL'8/11/2026 (tests/avvisi-0811.json, testi reali): la notizia ACTV del 5/11 e il messaggio Telegram 11897 dell'8/11 che vi rimanda
// comparivano come due avvisi, il secondo con le linee 2 e N del servizio automobilistico. Regole provate qui (avvisi.js):
//  · 🚏 non indica il servizio; 🛳 e «approdo» indicano la navigazione;
//  · un messaggio con link alla pagina ACTV si unisce alla notizia anche dopo 2 giorni se ripete il suo periodo e non annuncia novità;
//  · date nuove (caso Pio X), variazioni o ripristini: il messaggio resta separato, come prima.
// I messaggi indicati come SINTETICI sono costruiti per il test (variazioni del testo reale), non pubblicati da ACTV.
const test = require('node:test'), assert = require('node:assert');
const A = require('../avvisi');
const J = require('./avvisi-0811.json');

const known = new Map([['1', [{ n: '1', s: 'nav', c: null }]], ['2', [{ n: '2', s: 'nav', c: null }, { n: '2', s: 'aut', c: null }]], ['N', [{ n: 'N', s: 'nav', c: null }, { n: 'N', s: 'aut', c: null }]]]);
const ctx = { known, byName: new Map(), lineStops: new Map(), nameOf: id => id };
const NOW = Date.parse('2026-11-08T11:00:00+01:00');
const FROM = Date.parse('2026-11-09T22:30:00+01:00'), TO = Date.parse('2026-11-10T01:30:00+01:00');
const tgVar = (id, text) => ({ ...J.tg, key: 'tg:' + id, id, url: 'https://t.me/muoversivenezia/' + id, text });
function run(tg, { rss = true, now = NOW } = {}) {
  A.setContext(() => ctx); A.setTideSource(() => null);
  A._load({ rss: rss ? [J.rss] : [], tg, pages: rss ? { [J.rss.url]: J.page } : {} });
  return A.build(now);
}
const lines = o => o.lines.map(l => l.s + ':' + l.n).sort();

test('P.le Roma · 1) messaggio da solo: linee 2 e N della navigazione, non dei bus', () => {
  const out = run([J.tg], { rss: false });
  assert.equal(out.length, 1);
  assert.deepEqual(lines(out[0]), ['nav:2', 'nav:N']);
  assert.equal(out[0].from, FROM); assert.equal(out[0].to, TO);
});

test('P.le Roma · 2) notizia ACTV + messaggio 3 giorni dopo con le stesse date: un solo avviso, quello ACTV, con il link Telegram', () => {
  const solo = run([]), out = run([J.tg]);
  assert.equal(out.length, 1, 'un solo avviso');
  const { source, tgUrl, ...rest } = out[0], { source: s0, tgUrl: t0, ...rest0 } = solo[0];
  assert.equal(source, 'both'); assert.equal(tgUrl, J.tg.url);
  assert.deepEqual(rest, rest0, 'contenuto identico alla sola notizia ACTV');
  assert.equal(out[0].effect, 'no_service');
  assert.deepEqual(lines(out[0]), ['nav:1', 'nav:2', 'nav:N']);
});

test('P.le Roma · 3) SINTETICO: stesso link ma date diverse (caso Pio X) → il messaggio resta separato', () => {
  const m = tgVar(91001, J.tg.text.replace('lunedì 9 novembre', 'lunedì 16 novembre').replace('martedì 10 novembre', 'martedì 17 novembre'));
  const out = run([m], { now: Date.parse('2026-11-15T11:00:00+01:00') });
  assert.ok(out.some(o => o.source === 'telegram' && o.tgUrl === m.url), 'messaggio separato');
});

test('P.le Roma · 4) SINTETICO: stesso link e stesse date ma con una novità (anticipata / ripristino) → non assorbito come «stessa notizia»', () => {
  for (const [id, extra] of [[91002, '\n\nLa sospensione è anticipata.'], [91003, '\n\nAggiornamento: ripristino della fermata alle 00:30.']]) {
    const m = tgVar(id, J.tg.text + extra), A0 = run([m]);
    assert.ok(!A0.some(o => o.source === 'both' && o.tgUrl === m.url && o.title.startsWith('Venezia: sospensione')), `${id}: non deve essere unito come stessa notizia`);
  }
});

test('P.le Roma · 5) SINTETICO: 🚏 insieme a 🚍 (avviso bus) → resta servizio automobilistico', () => {
  const m = tgVar(91004, '🔄 #muoversivenezia 🚍 | Mestre\n\n🔴 dalle ore 22:30 di lunedì 9 novembre alle ore 01:30 di martedì 10 novembre 2026\n\n🚏 la linea 2 è deviata.');
  const out = run([m], { rss: false });
  assert.deepEqual(lines(out[0]), ['aut:2']);
});
