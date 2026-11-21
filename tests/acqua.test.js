// Acqua alta: dati (scripts/acqua-core.js, scripts/genera-acqua.js, segno «ponte» nelle mattonelle) e regole sul telefono (public/js/acqua.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const A = require('../scripts/acqua-core');
const P = require('../scripts/pedoni-core');

// public/js/acqua.js e pedoni.js sono moduli ES del browser: si importano da una copia .mjs
async function load(name) {
  const f = path.join(os.tmpdir(), `${name}-${process.pid}.mjs`);
  fs.writeFileSync(f, fs.readFileSync(path.join(__dirname, '..', 'public', 'js', name + '.js')));
  return import('file://' + f);
}

// rete di prova: griglia di calli ogni ~50 m intorno a San Marco, un canale tra le colonne 3 e 4 con un ponte (scale + piano) alla riga 2
const LAT0 = 45.4320, LON0 = 12.3330, DLAT = 0.00045, DLON = 0.00064, NR = 8, NC = 8;
function opl({ bridgeTag = true } = {}) {
  const L = [], id = (r, c) => 1 + r * NC + c; let n = 1000;
  for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) L.push(`n${id(r, c)} x${(LON0 + c * DLON).toFixed(7)} y${(LAT0 + r * DLAT).toFixed(7)}`);
  let w = 1;
  for (let r = 0; r < NR; r++) {
    const left = [], right = []; for (let c = 0; c < NC; c++) (c <= 3 ? left : right).push('n' + id(r, c));
    L.push(`w${w++} Thighway=footway N${left.join(',')}`, `w${w++} Thighway=footway N${right.join(',')}`);
    if (r === 2) {                                                // scale, piano del ponte, scale
      const a = id(r, 3), b = id(r, 4), m1 = ++n, m2 = ++n;
      L.push(`n${m1} x${(LON0 + 3.3 * DLON).toFixed(7)} y${(LAT0 + r * DLAT).toFixed(7)}`, `n${m2} x${(LON0 + 3.7 * DLON).toFixed(7)} y${(LAT0 + r * DLAT).toFixed(7)}`);
      L.push(`w${w++} Thighway=steps${bridgeTag ? ',bridge=yes' : ''} Nn${a},n${m1}`, `w${w++} Thighway=footway${bridgeTag ? ',bridge=yes' : ''} Nn${m1},n${m2}`, `w${w++} Thighway=steps${bridgeTag ? ',bridge=yes' : ''} Nn${m2},n${b}`);
    }
  }
  for (let c = 0; c < NC; c++) { const ns = []; for (let r = 0; r < NR; r++) ns.push('n' + id(r, c)); L.push(`w${w++} Thighway=footway N${ns.join(',')}`); }
  // i nodi devono precedere le vie (come nel file di osmium): si riordina
  return [...L.filter(l => l[0] === 'n'), ...L.filter(l => l[0] === 'w')];
}
function tilesOf(lines) { const R = P.lettore(); for (const l of lines) R.line(l); const { tiles } = P.mattonelle(R.done(), () => true); const o = {}; for (const [c, t] of Object.entries(tiles)) o[c] = JSON.parse(t); return o; }
const pt = (r, c) => [LAT0 + r * DLAT, LON0 + c * DLON];

test('mattonelle: segno «ponte» (2) accanto alle scale (1); le vie normali restano 0', () => {
  const T = tilesOf(opl()), segni = new Set();
  for (const t of Object.values(T)) for (const e of t.e) segni.add(e[3]);
  assert.deepStrictEqual([...segni].sort(), [0, 2, 3], 'piano del ponte 2, scale del ponte 3, calli 0');
  const T2 = tilesOf(opl({ bridgeTag: false })), s2 = new Set(); for (const t of Object.values(T2)) for (const e of t.e) s2.add(e[3]);
  assert.deepStrictEqual([...s2].sort(), [0, 1], 'senza tag bridge: solo le scale');
});

test('ponti: riconosciuti dal segno e, nelle mattonelle vecchie, dalle scale; stessa regola sul telefono', async () => {
  const { ponte } = await load('acqua');
  for (const bridgeTag of [true, false]) {
    const R = A.rete(tilesOf(opl({ bridgeTag })), P.CL, P.CO);
    const pont = R.edges.filter(e => e.ponte);
    assert.strictEqual(pont.length, 3, `scale + piano (${bridgeTag ? 'con' : 'senza'} segno)`);
    for (const e of R.edges) assert.strictEqual(ponte({ ...e, w: e.len }), e.ponte, 'telefono e generatore concordano');
  }
});

test('passerelle: ricalcate sulla rete; lunghezza che torna = «tracciato», altrimenti «indicativo»', () => {
  const R = A.rete(tilesOf(opl()), P.CL, P.CO), near = A.indiceNodi(R);
  const ok = A.ricalca(R, near, { a: [pt(5, 0)], b: [pt(5, 2)], m: 100, geo: 'osm' });
  assert.strictEqual(ok.k, 't'); assert.ok(Math.abs(ok.m - 100) < 5, ok.m); assert.ok(ok.g.length >= 3);
  // ufficiale 20 m, sulla rete 100 m: la passerella parte dal capo «da» verso «a» per 20 m, lungo la calle
  const lungo = A.ricalca(R, near, { a: [pt(5, 0)], b: [pt(5, 2)], m: 20, geo: 'osm' });
  assert.strictEqual(lungo.k, 't'); assert.strictEqual(lungo.m, 20);
  let gl = 0; for (let i = 1; i < lungo.g.length; i++) gl += A.mDist(lungo.g[i - 1][0], lungo.g[i - 1][1], lungo.g[i][0], lungo.g[i][1]);
  assert.ok(Math.abs(gl - 20) < 1.5 && A.mDist(lungo.g[0][0], lungo.g[0][1], ...pt(5, 0)) < 3, `${gl} m dal capo «da»`);
  // a metà di un tratto (capi lontani dai nodi): aggancio sul tratto, non sul nodo più vicino
  const meta = A.ricalca(R, near, { a: [[pt(5, 0)[0], pt(5, 0)[1] + 0.00016]], b: [[pt(5, 0)[0], pt(5, 0)[1] + 0.00040]], m: 19, geo: 'osm' });
  assert.ok(meta.k === 't' && Math.abs(meta.m - 19) < 3, JSON.stringify(meta.m));
  const incerto = A.ricalca(R, near, { a: [pt(5, 0)], b: [pt(5, 2)], m: 100, geo: 'incerto' });
  assert.strictEqual(incerto.k, 'i');
  // tra più punti candidati si sceglie la coppia con la lunghezza più vicina a quella ufficiale
  const scelta = A.ricalca(R, near, { a: [pt(5, 0)], b: [pt(5, 6), pt(5, 2)], m: 100, geo: 'osm' });
  assert.ok(Math.abs(scelta.m - 100) < 5);
  const fuori = A.ricalca(R, near, { a: [[45.5, 12.5]], b: [[45.5, 12.51]], m: 50, geo: 'osm' });
  assert.strictEqual(fuori.k, 'i'); assert.strictEqual(fuori.m, null);
});

test('quote: calibrate sulla curva ufficiale; vicino alle passerelle resta la quota di posa; ponti esclusi', () => {
  const R = A.rete(tilesOf(opl()), P.CL, P.CO);
  const G = { lat0: LAT0 - 0.001, lon0: LON0 - 0.001, dlat: 0.00018, dlon: 0.00026, righe: 40, colonne: 40 };
  const zone = [{ id: 'z', box: [LAT0 - 0.001, LON0 - 0.001, LAT0 + 0.005, LON0 + 0.006], curva: true, fondo: 128 }];
  const curva = [[80, 0.1], [90, 1.84], [100, 5.17], [110, 14.04], [120, 28.75], [130, 43.15], [140, 54.39], [150, 70], [200, 95]];
  const pass = [{ g: [pt(6, 5), pt(6, 7)], q: 100 }];
  const celle = A.quote(R, { G, zone, curva, punti: [{ lat: pt(1, 1)[0], lon: pt(1, 1)[1], cm: 70, r: 60 }], percorsi: pass });
  for (const cm of [110, 120, 130, 140]) assert.ok(Math.abs(A.allagata(celle, cm) - A.percento(curva, cm)) < 4, `${cm}: ${A.allagata(celle, cm)} vs ${A.percento(curva, cm)}`);
  const vicino = celle.filter(o => o.fissa != null); assert.ok(vicino.length > 0 && vicino.every(o => o.cm === 97), 'quota di posa − 3 cm');
  // la cella più bassa è vicino al punto noto a +70 (in basso a sinistra), non dall'altra parte
  const low = celle.reduce((m, o) => (o.cm < m.cm ? o : m)), r = Math.floor(low.k / G.colonne), c = low.k % G.colonne;
  assert.ok(G.lat0 + r * G.dlat < pt(4, 0)[0] && G.lon0 + c * G.dlon < pt(0, 4)[1], 'zona bassa intorno al punto noto');
  // codifica compatta: andata e ritorno a ±1 cm
  const back = A.decodifica(A.codifica(celle, G), G);
  assert.strictEqual(back.size, celle.length);
  for (const o of celle) assert.ok(Math.abs(back.get(o.k) - o.cm) <= 1.01 || o.cm < 50 || o.cm > 208);
});

test('file generati in public/acqua: impronte, contenuto e limiti', async () => {
  const dir = path.join(__dirname, '..', 'public', 'acqua');
  if (!fs.existsSync(path.join(dir, 'indice.json'))) return;     // non generati: niente da controllare
  const ind = JSON.parse(fs.readFileSync(path.join(dir, 'indice.json'), 'utf8'));
  for (const [n, f] of Object.entries(ind.files)) {
    const b = fs.readFileSync(path.join(dir, n + '.json'));
    assert.strictEqual(crypto.createHash('sha256').update(b).digest('hex'), f.sha, `impronta di ${n}`);
    assert.ok(b.length < 60000, `${n} leggero (${b.length} B)`);
  }
  const { quoteDa, passerelleDa } = await load('acqua');
  const Q = quoteDa(JSON.parse(fs.readFileSync(path.join(dir, 'quote.json'), 'utf8')));
  const Pp = passerelleDa(JSON.parse(fs.readFileSync(path.join(dir, 'passerelle.json'), 'utf8')));
  assert.ok(Pp.list.length >= 60, 'percorsi del piano');
  assert.ok(Pp.list.every(p => p.q >= 60 && p.q <= 140 && p.pts.length >= 2), 'quote di posa (San Marco 2023: T1.1 F da +65)');
  assert.ok(Pp.list.filter(p => p.tavola).length >= 25 && Pp.list.every(p => p.parti.every(s => s.length >= 2)), 'tracciati dalle tavole georeferenziate, con i rami');
  assert.ok(Pp.list.filter(p => p.k === 't').length >= Pp.list.length * 0.75, 'quasi tutti ricalcati sulla rete');
  assert.ok(Q.at(45.43455, 12.33925) <= 80, 'davanti alla Basilica: tra le quote più basse');
  assert.ok(Q.at(45.4115, 12.37) === null, 'Lido fuori modello');
  assert.ok(Q.percento(110) > 13 && Q.percento(110) < 15);
});

test('telefono: stagione, MOSE, passerelle posate, metri bagnati di un tratto', async () => {
  const X = await load('acqua');
  const ms = s => Date.parse(s);
  assert.strictEqual(X.inStagione(ms('2026-11-17T10:00:00Z')), true);
  assert.strictEqual(X.inStagione(ms('2026-04-30T21:30:00Z')), true, '30 aprile, ora di Venezia');
  assert.strictEqual(X.inStagione(ms('2026-04-30T22:30:00Z')), false, 'già 1° maggio a Venezia');
  assert.strictEqual(X.inStagione(ms('2026-09-14T12:00:00Z')), false);
  assert.strictEqual(X.inStagione(ms('2026-09-15T00:30:00+02:00')), true);
  // MOSE: la previsione oltre 110 non è il livello in città se le barriere sono (o saranno) alzate; l'osservato sì
  assert.deepStrictEqual(X.livelloCitta({ cm: 125, kind: 'previsto' }, 'programmato'), { cm: X.LIV_MOSE, kind: 'previsto', mose: true, mare: 125 });
  assert.strictEqual(X.livelloCitta({ cm: 125, kind: 'previsto' }, 'recesso').cm, 125);
  assert.strictEqual(X.livelloCitta({ cm: 95, kind: 'previsto' }, 'sollevata').cm, 95, 'sotto la soglia: invariato');
  assert.strictEqual(X.livelloCitta({ cm: 112, kind: 'osservato' }, 'sollevata').cm, 112);
  // passerelle
  const Pp = X.passerelleDa({ f: 1, stagione: { da: '09-15', a: '04-30' }, garantiti: 120, p: [
    { id: 'A', q: 85, k: 't', l: [4543400, 1233800, 0, 30] }, { id: 'B', q: 110, k: 'i', l: [4543500, 1233900, 10, 0] }, { id: 'X', q: 300, l: [1, 2, 3, 4] }] });
  assert.strictEqual(Pp.list.length, 2, 'voce non valida scartata');
  const nov = ms('2026-11-17T10:00:00Z'), giu = ms('2026-06-17T10:00:00Z');
  assert.deepStrictEqual(X.posate(Pp, 100, nov).map(p => p.id), ['A']);
  assert.deepStrictEqual(X.posate(Pp, 115, nov).map(p => p.id), ['A', 'B']);
  assert.deepStrictEqual(X.posate(Pp, 115, giu), [], 'fuori stagione nessuna passerella');
  assert.strictEqual(X.statoPasserelle(Pp, 70, nov), 'no');
  assert.strictEqual(X.statoPasserelle(Pp, 125, nov), 'oltre');
  assert.strictEqual(X.statoPasserelle(Pp, 100, giu), 'fuori');
  // tratto bagnato: griglia con quota 90 ovunque, tratto di ~50 m; con passerella posata sopra non conta come bagnato
  const G = { lat0: 45.433, lon0: 12.337, dlat: 0.00018, dlon: 0.00026, righe: 20, colonne: 20 };
  const riga = X.ALFA[20].repeat(20), Q = X.quoteDa({ f: 1, g: G, r: Array.from({ length: 20 }, (_, i) => [i, 0, riga]) });
  assert.strictEqual(Q.at(45.434, 12.338), 90);
  const a = { adj: [] }, b = { adj: [] }, e = { a, b, s: 0, w: 50, g: [[45434000, 12338000], [45434000, 12338640]] };
  const asc = X.bagnato(e, 85, Q, null); assert.strictEqual(asc.bagnati, 0, 'marea sotto la quota');
  const wet = X.bagnato(e, 100, Q, null); assert.ok(Math.abs(wet.bagnati - 50) < 1 && wet.prof === 10, JSON.stringify(wet));
  const idx = X.indicePasserelle([{ pts: [[45.434, 12.338], [45.434, 12.33864]] }]);
  const sopra = X.bagnato(e, 100, Q, idx); assert.ok(sopra.bagnati < 1 && sopra.passerella > 49, JSON.stringify(sopra));
  assert.strictEqual(X.bagnato({ ...e, s: 2 }, 120, Q, null).bagnati, 0, 'ponte sempre asciutto');
  assert.ok(X.costo(wet) > 300 && X.costo(sopra) < 10);
});

test('percorso a piedi con l\'acqua alta: evita la calle allagata, usa la passerella posata, metri veri', async () => {
  const X = await load('acqua'), { createNet } = await load('pedoni');
  const T = tilesOf(opl()), net = createNet({ CL: P.CL, CO: P.CO, loadTile: async c => T[c] || null });
  // quote: la riga 5 della griglia di calli è bassa (+90), il resto alto (+130)
  const G = { lat0: LAT0 - 0.0005, lon0: LON0 - 0.0005, dlat: 0.00018, dlon: 0.00026, righe: 30, colonne: 30 };
  const r = [];
  for (let i = 0; i < G.righe; i++) { const lat = G.lat0 + (i + 0.5) * G.dlat; r.push([i, 0, X.ALFA[Math.abs(lat - pt(5, 0)[0]) < 0.00012 ? 20 : 40].repeat(G.colonne)]); }
  const Q = X.quoteDa({ f: 1, g: G, r }), A0 = { lat: pt(5, 0)[0], lon: pt(5, 0)[1] }, B0 = { lat: pt(5, 3)[0], lon: pt(5, 3)[1] };
  const costoDi = acqua => { const m = new Map(); return e => { if (!m.has(e)) m.set(e, X.costo(X.bagnato(e, acqua.cm, acqua.Q, acqua.pass))); return m.get(e); }; };
  const asciutto = await net.route(A0, B0, 3000);
  assert.ok(Math.abs(asciutto.m - 150) < 5, `diretto ${asciutto.m}`);
  const evita = await net.route(A0, B0, 3000, costoDi({ cm: 100, Q, pass: null }));
  assert.ok(evita.m > 220 && evita.m < 280, `giro asciutto: ${evita.m} m veri`);
  const r1 = X.riassunto(evita.archi, 100, Q, null); assert.ok(r1.bagnati < 40, `solo l'uscita dalla calle bassa: ${r1.bagnati}`);   // partenza e arrivo sono sulla calle bassa
  const pass = X.indicePasserelle([{ id: 'P', d: 'Da A a B', q: 95, pts: [pt(5, 0), pt(5, 3)] }]);
  const su = await net.route(A0, B0, 3000, costoDi({ cm: 100, Q, pass }));
  assert.ok(Math.abs(su.m - 150) < 5, `sulla passerella: ${su.m}`);
  const r2 = X.riassunto(su.archi, 100, Q, pass); assert.ok(r2.passerella > 100 && r2.passerelle[0].id === 'P' && r2.bagnati < 10, JSON.stringify({ ...r2, parti: r2.parti.length }));
  // distanze verso le fermate: metri veri del percorso più asciutto
  const d = await net.distances(A0, [{ key: 'b', ...B0 }], 3000, 1, costoDi({ cm: 100, Q, pass: null }));
  assert.ok(Math.abs(d.get('b') - evita.m) < 3, `${d.get('b')} ≈ ${evita.m}`);
});
