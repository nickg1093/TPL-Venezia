// AVVISI REALI DEL 19/11/2026 (tests/avvisi-1911.json, testi del ramo archivio-avvisi) confrontati con il sito pubblicato (v32.1):
//  · Crea «giovedì 19 e venerdì 20 novembre, dalle 08:00 alle 17:00 di entrambi i giorni» letto come periodo continuo dal 19 alle 8 al 20 alle 17;
//  · sciopero del 20/11 esteso dal 19 al 21 (date accessorie nella pagina) e mostrato due volte (ACTV + Telegram), più un messaggio senza data leggibile;
//  · People Mover due volte: il messaggio Telegram con «per aggiornamenti 👉 link» non si univa alla notizia (e prendeva la linea 2 dell'alternativa);
//  · Madonna della Salute: lo stesso messaggio Telegram ripubblicato 3 giorni dopo diventava un avviso nuovo; fine «sino a fine servizi di lunedì 23» persa;
//  · Zattere «B» «dalle 09:00 alle 12:30 … e comunque fino al termine dei lavori» mostrata fino alle 13:00;
//  · messaggi di soli hashtag («Avviso» vuoto), notizia stampa sulla linea 8E, parcheggio pieno tra gli avvisi.
const test = require('node:test'), assert = require('node:assert');
const A = require('../avvisi');
const J = require('./avvisi-1911.json');

const lines = { nav: ['1', '2', 'N', '4.1', '4.2', '5.1', '6', '17'], aut: ['PM', '8E', '2', 'N'] };
const known = new Map();
for (const s in lines) for (const n of lines[s]) (known.get(n.toUpperCase()) || known.set(n.toUpperCase(), []).get(n.toUpperCase())).push({ n, s, c: null });
const ctx = { known, byName: new Map(), lineStops: new Map(), nameOf: id => id };
const at = s => Date.parse(s);
function run(now) { A.setContext(() => ctx); A.setTideSource(() => null); A._load({ rss: J.rss, tg: J.tg, pages: J.pages }); return A.build(now); }
const find = (out, re) => out.filter(o => re.test(o.title));
const hm = ms => new Date(ms).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });

test('19/11 · Crea: due giorni con la stessa fascia oraria = giorni separati, non un periodo continuo', () => {
  const out = run(at('2026-11-19T12:00:00+01:00')), c = find(out, /Crea/);
  assert.equal(c.length, 1, 'un solo avviso (ACTV + Telegram)');
  assert.deepEqual(c[0].giorni, [[at('2026-11-19T08:00:00+01:00'), at('2026-11-19T17:00:00+01:00')], [at('2026-11-20T08:00:00+01:00'), at('2026-11-20T17:00:00+01:00')]]);
  assert.equal(c[0].source, 'both');
});

test('19/11 · sciopero: vale il giorno del titolo, un solo avviso anche con i messaggi Telegram (anche quello senza data leggibile)', () => {
  const out = run(at('2026-11-19T20:00:00+01:00')), s = out.filter(o => o.effect === 'strike');
  assert.equal(s.length, 1);
  assert.equal(s[0].from, at('2026-11-20T00:00:00+01:00')); assert.equal(s[0].to, at('2026-11-20T23:59:59+01:00'));
  assert.equal(s[0].state, 'upcoming');
  const sera17 = run(at('2026-11-17T21:00:00+01:00')).filter(o => o.effect === 'strike');
  assert.ok(sera17.every(o => o.state === 'upcoming'), '«venerdì 202026» non fa diventare lo sciopero «in corso» il 17 sera');
});

test('19/11 · People Mover: «per aggiornamenti 👉 link» è un rimando, il messaggio si unisce alla notizia', () => {
  const out = run(at('2026-11-18T10:00:00+01:00')), p = find(out, /People Mover/);
  assert.equal(p.length, 1);
  assert.equal(p[0].source, 'both');
  assert.equal(p[0].effect, 'no_service', '«l\'impianto rimarrà chiuso»');
  assert.equal(p[0].giorni.length, 2);
});

test('19/11 · Madonna della Salute: messaggio ripubblicato = stessa notizia; fino a fine servizi di lunedì 23', () => {
  const out = run(at('2026-11-19T20:00:00+01:00')), m = find(out, /Madonna della Salute/);
  assert.equal(m.length, 1);
  assert.equal(m[0].to, at('2026-11-23T23:59:59+01:00'));
  assert.notEqual(m[0].effect, 'no_service', 'la sospensione di S. Maria del Giglio è un promemoria (avviso a parte)');
});

test('19/11 · Zattere «B»: vale l\'ora di fine scritta, anche con «comunque fino al termine dei lavori»', () => {
  const out = run(at('2026-11-21T10:00:00+01:00')), z = find(out, /Zattere/);
  assert.equal(z.length, 1); assert.equal(hm(z[0].from), '09:00'); assert.equal(hm(z[0].to), '12:30');
});

test('19/11 · niente «Avviso» vuoti, notizie stampa e parcheggi pieni; titolo lungo con la frase intera nel testo', () => {
  const all = [at('2026-11-08T17:00:00+01:00'), at('2026-11-12T09:30:00+01:00'), at('2026-11-17T22:30:00+01:00'), at('2026-11-19T19:30:00+01:00')].flatMap(run);
  assert.equal(find(all, /^Avviso$/).length, 0);
  assert.equal(find(all, /Aggressione|Conducente/i).length, 0);
  assert.equal(find(all, /al completo/i).length, 0);
  const r = find(all, /Romea/)[0];
  assert.ok(r && /salti corsa/.test(r.text), 'la frase intera è nel testo');
});
