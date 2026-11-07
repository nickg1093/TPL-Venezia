// CASO T1 DEL 6-7/11/2026 (tests/avvisi-0711.json, testi reali): due messaggi Telegram sul guasto del tram nella notte tra venerdì e sabato
// (11894 «Attivato servizio automobilistico sostitutivo…», 11895 «…il servizio torna progressivamente regolare») avevano sostituito l'avviso ACTV
// del servizio sostitutivo T1 programmato per lunedì 9/11 dalle 20.30. Regole provate qui (avvisi.js, thread()):
//  · un messaggio non chiude, non sostituisce e non fonde un avviso che inizia dopo di lui, salvo riferimento esplicito (stessa pagina ACTV o stesso giorno);
//  · nel dubbio (più avvisi collegabili) non si modifica nulla; direzione o tratto diversi = eventi diversi;
//  · ripristino completo = chiusura esplicita; ripristino in corso = «Ripristino in corso» e chiusura tecnica dopo 60 min; ripristino parziale = l'avviso resta.
// I messaggi indicati come SINTETICI sono costruiti per il test (variazioni dei testi reali), non pubblicati da ACTV.
const test = require('node:test'), assert = require('node:assert');
const A = require('../avvisi');
const J = require('./avvisi-0711.json'), J6 = require('./avvisi-0611.json');

const known = new Map([['T1', [{ n: 'T1', s: 'aut', c: null }]], ['2', [{ n: '2', s: 'nav', c: null }]]]);
const ctx = { known, byName: new Map(), lineStops: new Map(), nameOf: id => id };
const at = s => Date.parse(s);                                   // istanti in ora italiana (CET = +01:00)
const MIN = 60e3, P = 60 * MIN;
const [M94, M95] = J.tg;
const PAGE_0711 = J.page, PAGE_0611 = J6.items[0].title + '\n' + J6.items[0].text;   // stessa notizia letta il 7/11 e il 6/11 (testi diversi)
const tgMsg = (id, text, pubMs, links = []) => ({ key: 'tg:' + id, id, text, links, pubMs, url: 'https://t.me/muoversivenezia/' + id });
const variant = (m, id, text, pubMs) => tgMsg(id, text, pubMs ?? m.pubMs);

// come il server: solo i messaggi già pubblicati all'istante «now»
function run(now, { tg = [], rss = true, page = PAGE_0711, interni = false } = {}) {
  A.setContext(() => ctx); A.setTideSource(() => null);
  A._load({ rss: rss ? [J.rss] : [], tg: tg.filter(m => m.pubMs <= now), pages: rss ? { [J.rss.url]: page } : {} });
  return A.build(now, { interni });
}
const monday = out => out.filter(o => /servizio sostitutivo linea T1/.test(o.title));
const others = out => out.filter(o => !/servizio sostitutivo linea T1/.test(o.title));
const strip = o => { const { source, tgUrl, ...rest } = o; return rest; };
const MON_FROM = at('2026-11-09T20:30:00+01:00'), MON_TO = at('2026-11-10T00:30:00+01:00');
function assertMonday(out, now, msg) {
  const m = monday(out); assert.equal(m.length, 1, `${msg}: l'avviso di lunedì deve esserci, una volta sola`);
  assert.deepEqual(strip(m[0]), strip(monday(run(now))[0]), `${msg}: l'avviso di lunedì deve essere identico a quello senza messaggi Telegram`);
  assert.equal(m[0].from, MON_FROM); assert.equal(m[0].to, MON_TO); assert.equal(m[0].effect, 'no_service');
  assert.deepEqual(m[0].lines.map(l => l.s + ':' + l.n), ['aut:T1']);
  return m[0];
}

test('T1 · 1) notte tra venerdì e sabato (00:30): guasto in corso e lunedì separato, in arrivo', () => {
  const now = at('2026-11-07T00:30:00+01:00'), out = run(now, { tg: [M94, M95] });
  assert.equal(assertMonday(out, now, '00:30').state, 'upcoming');
  const g = others(out); assert.equal(g.length, 1, 'il guasto è un avviso a sé');
  assert.equal(g[0].state, 'active'); assert.equal(g[0].from, M94.pubMs); assert.ok(g[0].to < MON_FROM, 'il guasto non eredita il periodo di lunedì');
  assert.deepEqual(g[0].lines.map(l => l.n), ['T1']); assert.equal(g[0].updated, undefined);
});

test('T1 · 2) sabato 15:45 (situazione vista in produzione): lunedì presente e identico, nessun avviso fino a lunedì sera', () => {
  const now = at('2026-11-07T15:45:00+01:00'), out = run(now, { tg: [M94, M95] });
  assert.equal(assertMonday(out, now, '15:45').state, 'upcoming');
  assert.deepEqual(others(out), [], '11894 e 11895 sono scaduti: nessun avviso T1 «in corso» fino al 10/11');
});

test('T1 · 3) lunedì 21:00: l\'avviso di lunedì è in corso', () => {
  const now = at('2026-11-09T21:00:00+01:00');
  assert.equal(assertMonday(run(now, { tg: [M94, M95] }), now, 'lunedì').state, 'active');
});

test('T1 · 4) stesso esito con il testo della pagina del 6/11 (fusione) e del 7/11 (sostituzione)', () => {
  for (const now of [at('2026-11-07T00:30:00+01:00'), at('2026-11-07T01:30:00+01:00'), at('2026-11-07T15:45:00+01:00'), at('2026-11-09T21:00:00+01:00')]) {
    const a = run(now, { tg: [M94, M95], page: PAGE_0611 }), b = run(now, { tg: [M94, M95], page: PAGE_0711 });
    assertMonday(a, now, 'pagina 6/11'); assertMonday(b, now, 'pagina 7/11');
    assert.equal(monday(a)[0].source, 'actv', 'nessuna fusione con il guasto');
    assert.deepEqual(others(a).map(o => [o.title, o.from, o.to, o.effect]), others(b).map(o => [o.title, o.from, o.to, o.effect]));
  }
});

test('T1 · 5) ripristino completo (SINTETICO): chiude il guasto con chiusura esplicita, lunedì invariato', () => {
  const B = variant(M95, 90001, M95.text.replace('il servizio torna progressivamente regolare', 'servizio ripristinato'));
  const now = B.pubMs + 5 * MIN, out = run(now, { tg: [M94, B] });
  assertMonday(out, now, 'dopo il ripristino');
  const g = others(out); assert.equal(g.length, 1); assert.ok(g[0].resolved, 'resta solo la notizia «Risolto»'); assert.equal(g[0].effect, 'resolved');
  assert.deepEqual(g[0].lines.map(l => l.n), ['T1']);
  const guasto = others(run(B.pubMs, { tg: [M94, B], interni: true })).find(o => o.title === 'SERVIZIO INFOMOBILITÀ' && !o.resolved);
  assert.equal(guasto.closure, 'esplicita'); assert.equal(guasto.to, B.pubMs);
  assert.ok(!('closure' in run(B.pubMs, { tg: [M94, B] })[0]), 'il dato interno non esce dall\'API');
});

test('T1 · 6) ripristino in corso (11895 reale): «Ripristino in corso» e chiusura tecnica dopo 60 minuti', () => {
  for (const [now, visible] of [[M95.pubMs + 4 * MIN, true], [M95.pubMs + P - 1000, true], [M95.pubMs + P + 60e3, false]]) {
    const out = run(now, { tg: [M94, M95] }); assertMonday(out, now, 'ripristino in corso');
    const g = others(out);
    if (!visible) { assert.deepEqual(g, [], 'dopo 60 minuti senza altri messaggi: chiusura tecnica'); continue; }
    assert.equal(g.length, 1, 'il guasto è sostituito dal ripristino in corso');
    assert.deepEqual([g[0].effect, g[0].effectLabel, g[0].from, g[0].to], ['restoring', 'Ripristino in corso', M94.pubMs, M95.pubMs + P]);
    assert.deepEqual(g[0].lines.map(l => l.n), ['T1']); assert.ok(!g[0].resolved);
  }
  const g = others(run(M95.pubMs + 4 * MIN, { tg: [M94, M95], interni: true }))[0]; assert.equal(g.closure, 'tecnica');
});

test('T1 · 6b) aggiornamento prima della scadenza: decide il contenuto (SINTETICI)', () => {
  const t = M95.pubMs + 30 * MIN;
  // nuovo «progressivamente»: nuova scadenza da quel messaggio
  const C1 = variant(M95, 90011, M95.text, t), o1 = others(run(t + MIN, { tg: [M94, M95, C1] }));
  assert.equal(o1.length, 1); assert.equal(o1[0].effect, 'restoring'); assert.equal(o1[0].to, t + P);
  // ripristino completo: chiusura esplicita (resta solo «Risolto»)
  const C2 = variant(M95, 90012, M95.text.replace('il servizio torna progressivamente regolare', 'servizio regolare'), t), o2 = others(run(t + MIN, { tg: [M94, M95, C2] }));
  assert.equal(o2.length, 1); assert.ok(o2[0].resolved);
  const in2 = others(run(t, { tg: [M94, M95, C2], interni: true })).find(o => o.effect === 'restoring'); assert.equal(in2.closure, 'esplicita');
  // nuovo disservizio: aggiornamento normale, il timer non vale più
  const C3 = variant(M94, 90013, M94.text, t), o3 = others(run(t + MIN, { tg: [M94, M95, C3], interni: true }));
  assert.equal(o3.length, 1); assert.notEqual(o3[0].effect, 'restoring'); assert.ok(o3[0].to > t + P, 'vale la durata del nuovo messaggio'); assert.equal(o3[0].closure, undefined);
  for (const now of [t + MIN, t + 2 * P]) assertMonday(run(now, { tg: [M94, M95, C1, C2, C3] }), now, 'aggiornamenti');
});

test('T1 · 7) ripristino parziale (SINTETICO): l\'avviso senza direzione resta aperto, senza timer', () => {
  const g0 = tgMsg(90021, 'Tram T1: attivato servizio sostitutivo con bus tra Venezia e Favaro', at('2026-11-07T08:00:00+01:00'));
  const pf = tgMsg(90022, 'Linea T1 direzione Favaro: servizio ripristinato', at('2026-11-07T08:30:00+01:00'));
  const pp = tgMsg(90023, 'Linea T1 direzione Favaro: il servizio torna progressivamente regolare', at('2026-11-07T08:30:00+01:00'));
  const now = at('2026-11-07T08:40:00+01:00'), base = others(run(now, { tg: [g0] }))[0];
  for (const B of [pf, pp]) {
    const out = run(now, { tg: [g0, B] }), g = others(out).find(o => o.title === base.title);
    assert.ok(g, 'l\'avviso resta'); assert.deepEqual([g.state, g.from, g.to, g.effect, g.resolved], [base.state, base.from, base.to, base.effect, base.resolved]);
    assertMonday(out, now, 'parziale');
  }
  const later = others(run(at('2026-11-07T10:00:00+01:00'), { tg: [g0, pp] })).find(o => o.title === base.title);
  assert.ok(later && !later.resolved, 'nessuna chiusura tecnica dopo 60 minuti per il ripristino parziale');
});

test('T1 · 8) riferimento esplicito: link alla pagina ACTV (fusione) e stesso giorno (SINTETICI)', () => {
  const link = tgMsg(90031, 'Tram T1: lunedì servizio sostitutivo con bus. Info: ' + J.rss.url, at('2026-11-07T10:00:00+01:00'), [J.rss.url]);
  const m = monday(run(at('2026-11-07T10:30:00+01:00'), { tg: [link] }));
  assert.equal(m.length, 1); assert.equal(m[0].source, 'both'); assert.equal(m[0].tgUrl, link.url); assert.equal(m[0].from, MON_FROM);
  // stesso giorno citato: il messaggio può toccare l'avviso futuro (qui, come nella v23, è unito alla notizia del sito)
  const day = tgMsg(90032, 'Tram T1: servizio sostitutivo previsto lunedì 9 novembre', at('2026-11-08T10:00:00+01:00'));
  const md = monday(run(at('2026-11-08T10:30:00+01:00'), { tg: [day] }));
  assert.equal(md.length, 1); assert.equal(md[0].source, 'both'); assert.equal(md[0].tgUrl, day.url); assert.equal(md[0].from, MON_FROM);
  // senza riferimento: lo stesso testo senza la data non tocca l'avviso futuro, e nemmeno un ripristino generico
  for (const text of ['Tram T1: servizio sostitutivo previsto', 'Tram T1: servizio ripristinato']) {
    const now = at('2026-11-08T10:30:00+01:00'), x = tgMsg(90033, text, at('2026-11-08T10:00:00+01:00'));
    assert.equal(assertMonday(run(now, { tg: [x] }), now, text).source, 'actv');
  }
});

test('T1 · 9) due eventi in corso sulla stessa linea: un ripristino generico non cambia nulla; la direzione decide (SINTETICI)', () => {
  const t = at('2026-11-07T09:00:00+01:00');
  const a1 = tgMsg(90041, 'Tram T1: incidente in via Cappuccina, servizio sospeso', t), a2 = tgMsg(90042, 'Tram T1: corteo in piazza Ferretto, servizio deviato', t + 5 * MIN);
  const gen = tgMsg(90043, 'Tram T1: servizio ripristinato', t + 30 * MIN);
  const before = others(run(t + 31 * MIN, { tg: [a1, a2] })), after = others(run(t + 31 * MIN, { tg: [a1, a2, gen] }));
  for (const x of before) {
    const y = after.find(o => o.id === x.id); assert.ok(y, `${x.title}: deve restare`);
    assert.deepEqual([y.from, y.to, y.effect, y.resolved], [x.from, x.to, x.effect, x.resolved], `${x.title}: invariato`);
  }
  assert.equal(after.filter(o => o.resolved).length, 1, 'il ripristino compare da solo come «Risolto»');
  const d1 = tgMsg(90044, 'Linea T1 direzione Favaro: servizio sospeso per guasto', t), d2 = tgMsg(90045, 'Linea T1 direzione Venezia: servizio sospeso per guasto', t + 5 * MIN);
  const rv = tgMsg(90046, 'Linea T1 direzione Venezia: servizio ripristinato', t + 30 * MIN);
  const o = others(run(t + 31 * MIN, { tg: [d1, d2, rv] }));
  assert.ok(o.some(x => /direzione Favaro/.test(x.title) && !x.resolved), 'la direzione Favaro resta aperta');
  assert.ok(!o.some(x => /direzione Venezia: servizio sospeso/.test(x.title)), 'la direzione Venezia è chiusa');
  assertMonday(run(t + 31 * MIN, { tg: [a1, a2, gen, d1, d2, rv] }), t + 31 * MIN, 'eventi contemporanei');
});
