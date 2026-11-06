// AVVISI REALI DEL 6/11/2026 (tests/avvisi-0611.json): gli errori trovati sull'app pubblicata e le regole generali che li correggono.
//  · data di pubblicazione sotto il titolo della pagina ACTV presa come inizio dell'evento (T1 sostituito da bus «in corso» 3 giorni prima)
//  · «linea 9E 27 Ottobre – Altinia» letto come «dal 9 al 27 ottobre», e la 9E cancellata come se fosse parte della data
//  · «linee 1, 2 e N»: la N persa; «linee 15 Mestre FS - Aeroporto e 19 Venezia - Altinia»: la 19 persa
//  · «SERVIZIO AUTOMOBILISTICO … linee 2, 4L, 6, 6L e 7»: 2 e 6 presi come vaporetti
//  · «fermata di Mestre FS C3 ID164»: collegate le altre fermate «Stazione Mestre FS» e non la C3
//  · ritardo di UNA corsa (ferry-boat delle 15:20) attivo fino a mezzanotte; notizia aziendale (selezioni del personale) tra gli avvisi
//  · capolinea provvisorio presentato come «Sospeso»
const test = require('node:test'), assert = require('node:assert');
const A = require('../avvisi');
const J = require('./avvisi-0611.json');

// contesto minimo con le linee e le fermate che servono (come lo costruisce server.js dal GTFS)
const lines = { aut: ['T1', '2', '2E', '4L', '6', '6L', '7', '15', '19', '9E'], nav: ['1', '2', 'N', '6', '14', '15', '17'] };
const known = new Map();
for (const s in lines) for (const n of lines[s]) (known.get(n.toUpperCase()) || known.set(n.toUpperCase(), []).get(n.toUpperCase())).push({ n, s, c: null });
const stops = { 'nav:5031': 'P.le Roma "G"', 'nav:5030': 'P.le Roma "F"', 'nav:5099': 'P.le Roma "E"', 'aut:2674': 'Rio San Martino', 'aut:164': 'Stazione MESTRE FS C3', 'aut:3588': 'Stazione MESTRE FS',
  'aut:6073': 'Stazione Mestre FS', 'aut:507': 'VENEZIA', 'aut:505': 'VENEZIA', 'aut:900': '27 Ottobre D4', 'nav:5075': 'Tronchetto Mercato' };
const byName = new Map();
for (const [id, nm] of Object.entries(stops)) for (const k of new Set([A.norm(nm), A.norm(nm.replace(/\s*"[A-Z]"$/, ''))])) (byName.get(k) || byName.set(k, []).get(k)).push(id);
const lineStops = new Map([['nav:1', new Set(['nav:5031', 'nav:5030'])], ['nav:2', new Set(['nav:5031', 'nav:5075'])], ['nav:N', new Set(['nav:5031'])], ['aut:2E', new Set(['aut:2674'])],
  ['nav:14', new Set(['nav:5200'])], ['aut:2', new Set(['aut:507'])], ['aut:19', new Set(['aut:505'])], ['aut:6', new Set(['aut:507'])]]);
const ctx = { known, byName, lineStops, nameOf: id => stops[id] };

function load() {
  const rss = [], tg = [], pages = {};
  J.items.forEach((it, k) => {
    if (it.source === 'telegram') tg.push({ key: 'tg:' + k, id: k, text: it.title + '\n' + it.text, links: [it.url].filter(u => /actv/.test(u)), pubMs: it.published, url: it.tgUrl });
    else { rss.push({ key: 'rss:' + it.url, title: it.title, url: it.url, text: it.text.slice(0, 200), pubMs: it.published }); pages[it.url] = it.title + '\n' + it.text; }
  });
  A.setContext(() => ctx); A._load({ rss, tg, pages });
}
const at = s => Date.parse(s);                                         // istanti in ora italiana (CET = +01:00)
const find = (out, re) => out.find(o => re.test(o.title));
const L = o => o.lines.map(l => l.s + ' ' + l.n).sort();

test('la data di pubblicazione in testa alla pagina non è l\'inizio dell\'evento', () => {
  load();
  const fri = A.build(at('2026-11-06T21:00:00+01:00'));
  const t1 = find(fri, /T1/);
  assert.equal(t1.state, 'upcoming', 'T1 sostituito da bus lunedì: venerdì sera è «in arrivo», non in corso');
  assert.equal(t1.from, at('2026-11-09T20:30:00+01:00'));
  assert.equal(t1.effect, 'no_service'); assert.deepEqual(L(t1), ['aut T1']);
  assert.equal(t1.untilEnd, true, '«dalle ore 20.30 al termine dei servizi»'); assert.equal(t1.to, at('2026-11-10T00:30:00+01:00'));
  assert.ok(!find(fri, /Pio X/).untilEnd, '«fino al termine dei servizi di sabato 30 novembre»: si mostra la data di fine');
  for (const re of [/IAT/, /Candiani/, /piazzale Roma/]) assert.equal(find(fri, re), undefined, `${re}: inizia fra più di 3 giorni`);
  const sat = A.build(at('2026-11-07T23:30:00+01:00'));
  const g = find(sat, /piazzale Roma/);
  assert.equal(g.from, at('2026-11-09T22:30:00+01:00')); assert.equal(g.to, at('2026-11-10T01:30:00+01:00'));
  assert.equal(find(sat, /IAT/).from, at('2026-11-10T00:00:00+01:00'));
  assert.equal(find(sat, /Candiani/).from, at('2026-11-10T00:00:00+01:00'), '«nei giorni 10, 11 e 12 novembre»: dal primo giorno');
  assert.equal(find(sat, /Candiani/).to, at('2026-11-12T23:59:59+01:00'));
});

test('nomi di luogo che sembrano date e fasce «dalle … alle … di domenica 8 novembre»', () => {
  load();
  const c = find(A.build(at('2026-11-06T21:00:00+01:00')), /Campalto/);
  assert.equal(c.from, at('2026-11-08T06:30:00+01:00'), 'non dal 9 ottobre («9E 27 Ottobre»), non dalla pubblicazione');
  assert.equal(c.to, at('2026-11-08T22:30:00+01:00'));
  assert.equal(c.state, 'upcoming');
  const pub = Date.parse('2026-11-06T09:00:00Z'), v = A.parseValidity('📆 Sabato 25 Aprile - Regata', pub, 'tg', ctx);
  assert.equal(new Date(v.from).getUTCDate(), 24, 'una data vera con la maiuscola resta una data');
});

test('linee: elenchi con la lettera N, elenchi «codice + percorso», servizio deciso dall\'elenco', () => {
  load();
  const sat = A.build(at('2026-11-07T23:30:00+01:00'));
  assert.deepEqual(L(find(sat, /piazzale Roma/)), ['nav 1', 'nav 2', 'nav N']);
  assert.deepEqual(find(sat, /piazzale Roma/).stops, ['nav:5031']);
  assert.deepEqual(L(find(sat, /Campalto/)), ['aut 15', 'aut 19', 'aut 9E']);
  const fri = A.build(at('2026-11-06T21:00:00+01:00')), p = find(fri, /Partita/);
  assert.deepEqual(L(p), ['aut 2', 'aut 4L', 'aut 6', 'aut 6L', 'aut 7', 'nav 14'], '2 e 6 sono bus come 4L, 6L e 7');
  assert.equal(p.effect, 'detour');
  assert.deepEqual(p.stops, [], '«in direzione Venezia» non è la fermata VENEZIA');
  // regole che restano: «A partire» non è la linea A
  assert.deepEqual(A.analyze('Avviso', 'Linee 1 e A partire da lunedì cambiano orario', ctx).lines.map(l => l.n), ['1']);
});

test('fermata indicata con il codice (ID164): solo quella', () => {
  load();
  const m = find(A.build(at('2026-11-07T08:00:00+01:00')), /Mestre FS/);
  assert.deepEqual(m.stops, ['aut:164']); assert.equal(m.effect, 'stop_moved'); assert.equal(m.state, 'active');
});

test('una sola corsa in ritardo: l\'avviso finisce poco dopo; notizie aziendali escluse; capolinea provvisorio = fermata spostata', () => {
  load();
  const f = find(A.build(at('2026-11-06T16:00:00+01:00')), /Ferry/);
  assert.ok(f, 'alle 16 il ritardo della corsa delle 15:20 è in corso');
  assert.equal(f.to, at('2026-11-06T18:20:00+01:00'), '15:20 + un\'ora di ritardo + 2 ore');
  const eve = A.build(at('2026-11-06T21:00:00+01:00'));
  assert.equal(find(eve, /Ferry/), undefined);
  assert.equal(find(eve, /selezioni/), undefined);
  const r = find(eve, /Rio San Martino/);
  assert.equal(r.effect, 'stop_moved'); assert.equal(r.severity, 'warning'); assert.deepEqual(L(r), ['aut 2E']); assert.deepEqual(r.stops, ['aut:2674']);
  assert.equal(find(eve, /Pio X/).effect, 'detour');
});
