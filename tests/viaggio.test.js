// VIAGGIO GUIDATO e I MIEI VIAGGI (public/js/viaggio.js): orari di Venezia, fasi del viaggio, avvisi da attivare, testo da condividere,
// proposta esatta (salvataggio e link), viaggi salvati e memoria del dispositivo manomessa.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// moduli ES del browser: copiati in una cartella temporanea «type: module», con localStorage/navigator/document minimi
async function load() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viaggio-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const f of ['util.js', 'notify.js', 'viaggio.js']) fs.copyFileSync(path.join(__dirname, '..', 'public', 'js', f), path.join(dir, f));
  const mem = new Map();
  globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'Linux', maxTouchPoints: 0 }, configurable: true });
  globalThis.document = { hidden: true, addEventListener() {}, visibilityState: 'hidden' };
  globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.matchMedia = () => ({ matches: false });
  const V = await import('file://' + path.join(dir, 'viaggio.js'));
  return { V, mem };
}

// soluzione come la dà /api/percorso: a piedi 3 min, linea 2 (08:20 → 08:34), cambio a piedi 2 min, linea 6 (08:40 → 08:52), a piedi 4 min
const SOL = {
  parti: '08:17', arrivi: '08:56', minuti: 39, cambi: 1, piedi: 9,
  tratte: [
    { tipo: 'piedi', min: 3, a: { id: 'aut:510', name: 'VENEZIA' } },
    { tipo: 'mezzo', src: 'aut', tripId: 'T_2', line: '2', color: '#E31E24', headsign: 'Mestre', fermate: 8, pos: [0, 8], da: { id: 'aut:510', name: 'VENEZIA', sched: '08:20' }, a: { id: 'aut:162', name: 'Mestre FS C4', sched: '08:34' } },
    { tipo: 'piedi', min: 2, a: { id: 'aut:6073', name: 'Stazione Mestre FS' } },
    { tipo: 'mezzo', src: 'aut', tripId: 'T_6', line: '6', color: null, headsign: 'Marghera', fermate: 5, pos: [2, 7], da: { id: 'aut:6073', name: 'Stazione Mestre FS', sched: '08:40' }, a: { id: 'aut:900', name: 'Marghera', sched: '08:52' } },
    { tipo: 'piedi', min: 4, estremo: 'arrivo' }]
};
const FROM = { kind: 'point', label: 'Casa', lat: 45.43, lon: 12.32 }, TO = { kind: 'stop', id: 'aut:901', label: 'Ufficio', src: 'aut', lat: 45.47, lon: 12.21 };

test('orari di Venezia: ora solare e legale, indipendenti dal fuso del dispositivo; giorno dopo oltre la mezzanotte', async () => {
  const { V } = await load();
  assert.equal(new Date(V.romeMs('2026-11-16', '08:20')).toISOString(), '2026-11-16T07:20:00.000Z');   // CET
  assert.equal(new Date(V.romeMs('2026-07-01', '08:20')).toISOString(), '2026-07-01T06:20:00.000Z');   // CEST
  assert.equal(new Date(V.romeMs('2026-03-29', '03:30')).toISOString(), '2026-03-29T01:30:00.000Z');   // dopo il cambio dell'ora
  assert.equal(V.romeYmd(Date.parse('2026-11-16T23:30:00Z')), '2026-11-17');
  const night = { ...SOL, parti: '23:50', arrivi: '00:20', tratte: [{ tipo: 'mezzo', src: 'nav', tripId: 'N1', line: 'N', headsign: 'Lido', fermate: 3, da: { id: 'nav:1', name: 'A', sched: '23:55' }, a: { id: 'nav:2', name: 'B', sched: '00:15' } }] };
  const s = V.snapshot(night, { date: '2026-11-16', from: FROM, to: TO });
  assert.equal(new Date(s.legs[0].a.ms).toISOString(), '2026-11-16T23:15:00.000Z');
  assert.equal(new Date(s.arriveMs).toISOString(), '2026-11-16T23:20:00.000Z');
});

test('fasi del viaggio: esci, linea, a bordo, scendi, cambio (anche a rischio con il tempo reale), ultimo tratto, arrivo', async () => {
  const { V } = await load();
  const s = V.snapshot(SOL, { date: '2026-11-16', from: FROM, to: TO }), at = hm => V.romeMs('2026-11-16', hm);
  const P = hm => V.phase(s, at(hm));
  assert.deepEqual([P('08:00').kind, P('08:00').title], ['esci', 'Esci alle 08:17']);
  assert.match(P('08:00').sub, /a piedi 3 min fino a VENEZIA, poi linea 2 per Mestre alle 08:20/);
  assert.equal(P('08:00').short, 'Esci tra 17 min');
  assert.deepEqual([P('08:17').kind, P('08:17').title], ['sali', 'Linea 2 alle 08:20']);
  assert.deepEqual([P('08:25').kind, P('08:25').title], ['bordo', 'Sei sulla linea 2']);
  assert.deepEqual([P('08:32').kind, P('08:32').title], ['scendi', 'Scendi a Mestre FS C4']);
  assert.deepEqual([P('08:35').kind, P('08:35').title, P('08:35').warn], ['cambio', 'Cambio: linea 6 alle 08:40', null]);
  assert.match(P('08:35').sub, /^a piedi 2 min fino a Stazione Mestre FS/);
  assert.equal(P('08:45').kind, 'bordo');
  assert.deepEqual([P('08:53').kind, P('08:53').title], ['piedi', 'Ultimo tratto a piedi']);
  assert.equal(P('08:57').kind, 'fine');
  // tempo reale: la linea 2 arriva alle 08:39, con 2 min a piedi il cambio delle 08:40 è a rischio
  s.legs[1].a.live = at('08:39');
  assert.match(V.phase(s, at('08:30')).title, /Sei sulla linea 2/);
  assert.match(V.phase(s, at('08:30')).warn || '', /arrivi alle 08:39: il cambio con la linea 6 delle 08:40 è a rischio/);   // avvisato già a bordo
  assert.match(V.phase(s, at('08:39')).warn || '', /cambio è a rischio/);
});

test('si può iniziare da 2 ore prima a 10 minuti dopo la partenza; avvisi per esci, cambio e scendi con i minuti a piedi', async () => {
  const { V } = await load();
  const s = V.snapshot(SOL, { date: '2026-11-16', from: FROM, to: TO }), at = hm => V.romeMs('2026-11-16', hm);
  assert.equal(V.startable(s, at('06:16')), false);
  assert.equal(V.startable(s, at('06:18')), true);
  assert.equal(V.startable(s, at('08:29')), true);
  assert.equal(V.startable(s, at('08:31')), false);
  const it = V.watchItems(s, at('08:00'));
  assert.deepEqual(it.map(x => [x.ruolo, x.stop, x.lead, x.walk, x.trip]), [
    ['esci', 'aut:510', 5, 3, 'aut:T_2'], ['scendi', 'aut:162', 2, 0, 'aut:T_2'], ['cambio', 'aut:6073', 5, 2, 'aut:T_6'], ['scendi', 'aut:900', 2, 0, 'aut:T_6']]);
  // già a bordo della prima corsa: niente «esci» (il server direbbe «già passata»)
  assert.deepEqual(V.watchItems(s, at('08:25')).map(x => x.ruolo), ['scendi', 'cambio', 'scendi']);
  // preavviso al massimo 45 minuti anche con una camminata lunga
  const long = V.snapshot({ ...SOL, tratte: [{ tipo: 'piedi', min: 50 }, ...SOL.tratte.slice(1)] }, { date: '2026-11-16', from: FROM, to: TO });
  assert.equal(V.watchItems(long, at('06:00'))[0].lead, 45);
});

test('testo da condividere: ordinato, simbolo del mezzo, linee tra parentesi, cambi, link alla proposta', async () => {
  const { V } = await load();
  const s = V.snapshot({ ...SOL, famiglia: 'aut:2_UL@venezia>mestre fs c4|aut:6_UL@stazione mestre fs>marghera', rotte: ['aut:2_UL', 'aut:6_UL'] }, { date: '2026-11-16', from: FROM, to: TO });
  const link = 'https://veneziatpl.onrender.com/?da=p:45.43,12.32&a=f:aut:901&sol=aut:T_2%3Eaut:T_6';
  const t = V.shareText(s, link);
  assert.match(t, /^🧭 Casa → Ufficio\n📅 Lunedì 16 novembre · 08:17 → 08:56 \(39 min, 1 cambio, 9 min a piedi\)\n\n/);
  assert.match(t, /🚶 08:17  a piedi 3 min\n🚌 08:20  \[2\] direzione Mestre\n      sali a VENEZIA\n   08:34  scendi a Mestre FS C4 · 8 fermate\n🔁 cambio a piedi 2 min\n🚌 08:40  \[6\]/);
  assert.match(t, /🚶 a piedi 4 min fino all'arrivo\n🏁 08:56  Ufficio/);
  assert.match(t, /Linee: 🚌 2  🚌 6/);
  assert.ok(t.endsWith('Apri questa proposta: ' + link));
  const nav = V.snapshot({ ...SOL, tratte: SOL.tratte.map(x => (x.tipo === 'mezzo' && x.line === '2' ? { ...x, src: 'nav', tripId: 'N_1' } : x.line === '6' ? { ...x, line: 'T1' } : x)) }, { date: '2026-11-16', from: FROM, to: TO });
  assert.match(V.shareText(nav, null), /⛴️ 08:20  \[2\][\s\S]*🚊 08:40  \[T1\]/);
  assert.equal(typeof V.icsUrl, 'undefined', 'calendario tolto'); assert.equal(typeof V.addToCalendar, 'undefined');
});

test('proposta esatta: firma, link, lettura sicura del link e modo di riapertura (valida, passata, più avanti)', async () => {
  const { V } = await load();
  const s = V.snapshot({ ...SOL, famiglia: 'aut:2_UL@venezia>mestre fs c4|aut:6_UL@stazione mestre fs>marghera', rotte: ['aut:2_UL', 'aut:6_UL'] }, { date: '2026-11-16', from: FROM, to: TO });
  assert.equal(V.snapTrips(s), 'aut:T_2>aut:T_6'); assert.equal(V.solTrips(SOL), 'aut:T_2>aut:T_6');
  const P = V.linkParams(s);
  assert.deepEqual(P, { quando: 'partenza', ora: '0817', data: '20261116', arr: '0856', sol: 'aut:T_2>aut:T_6', fam: s.fam, rotte: 'aut:2_UL,aut:6_UL' });
  const u = new URLSearchParams(P), w = V.parseWant(k => u.get(k));
  assert.equal(w.trips, 'aut:T_2>aut:T_6'); assert.equal(w.parti, '08:17'); assert.equal(w.arrivi, '08:56'); assert.deepEqual(w.rotte, ['aut:2_UL', 'aut:6_UL']);
  assert.equal(w.leaveMs, V.romeMs('2026-11-16', '08:17'));
  // link manomessi o incompleti: nessuna proposta (si apre il tragitto normale), mai un errore
  for (const bad of [{ ...P, sol: '<script>' }, { ...P, sol: 'aut:T_2>' + 'x'.repeat(5) }, { ...P, ora: '2561' }, { ...P, data: 'oggi' }, { quando: 'partenza' }]) {
    const q = new URLSearchParams(bad); assert.equal(V.parseWant(k => q.get(k)), null, JSON.stringify(bad).slice(0, 60));
  }
  const w2 = V.wantOf(s), dep = s.legs.find(l => l.t === 'r').da.ms;
  assert.equal(V.reopenMode(w2, dep + 5 * 60e3), 'passata', 'corsa già partita: alternative di adesso');
  assert.equal(V.reopenMode(w2, dep - 30 * 60e3), 'adesso', 'entro 90 minuti: ricerca in tempo reale');
  assert.equal(V.reopenMode(w2, dep - 5 * 3600e3), 'orario', 'più avanti: ricerca all\'orario della proposta');
  // il viaggio salvato porta famiglia e linee anche dopo la rilettura dalla memoria
  assert.deepEqual(V.clean(JSON.parse(JSON.stringify(s))).rotte, ['aut:2_UL', 'aut:6_UL']);
  assert.equal(V.clean({ ...JSON.parse(JSON.stringify(s)), rotte: ['<b>'] }).rotte, undefined);
});

test('I miei viaggi: salvati in ordine, al massimo 10, via da soli dopo l\'arrivo; memoria manomessa ignorata', async () => {
  const { V, mem } = await load();
  const base = V.romeMs('2026-11-16', '00:00');
  const mk = (d, hm) => V.snapshot({ ...SOL, parti: hm, tratte: SOL.tratte.map(t => (t.tipo === 'mezzo' ? { ...t, tripId: t.tripId + hm } : t)) }, { date: d, from: FROM, to: TO });
  const a = mk('2099-01-02', '08:17'), b = mk('2099-01-01', '08:17');
  assert.deepEqual(V.toggleSaved(a), { saved: true }); assert.deepEqual(V.toggleSaved(b), { saved: true });
  assert.deepEqual(V.savedList(base).map(x => x.date), ['2099-01-01', '2099-01-02']);
  assert.ok(V.isSaved(a.id)); assert.deepEqual(V.toggleSaved(a), { saved: false }); assert.ok(!V.isSaved(a.id));
  for (let i = 0; i < 9; i++) V.toggleSaved(mk('2099-02-0' + (i + 1), '09:00'));
  assert.match(V.toggleSaved(mk('2099-03-01', '09:00')).error, /10 viaggi/);
  assert.equal(V.savedList(Date.parse('2099-01-01T12:00:00Z')).length, 9);       // quello del 1° gennaio è passato
  assert.equal(V.clean({ ...b, legs: [{ t: 'r', trip: '<img>', da: b.legs[1].da, a: b.legs[1].a }] }), null);
  assert.equal(V.clean({ ...b, from: { kind: 'stop', id: 'javascript:alert(1)' } }).from, null);
  assert.equal(V.clean({ ...b, leaveMs: 'x' }), null);
  assert.match(V.savedHtml(base), /I miei viaggi/); assert.doesNotMatch(V.savedHtml(base), /<img/);
  assert.ok(mem.has('tpl.viaggi'));
});

test('avvisi per un viaggio: legati al giorno e alle ore del viaggio (non alla pubblicazione), alle sue linee e fermate; sciopero su tutto', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avvisi-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const f of ['util.js', 'avvisi.js']) fs.copyFileSync(path.join(__dirname, '..', 'public', 'js', f), path.join(dir, f));
  globalThis.document = { getElementById: () => null, hidden: true, addEventListener() {} };
  const A = await import('file://' + path.join(dir, 'avvisi.js'));
  const H = 3600e3, now = Date.parse('2026-11-15T10:00:00+01:00'), trip = { lines: [{ s: 'aut', n: '2' }], stops: ['aut:510', 'aut:162'] };
  const day2 = Date.parse('2026-11-17T08:00:00+01:00');
  const it = (id, o) => ({ id, title: id, severity: 'warning', effect: 'detour', lines: [], stops: [], published: now - H, ...o });
  A._setData({ items: [
    it('lavori-17', { dated: true, from: Date.parse('2026-11-17T00:00:00+01:00'), to: Date.parse('2026-11-17T23:59:00+01:00'), lines: [{ s: 'aut', n: '2' }] }),
    it('lavori-16', { dated: true, from: Date.parse('2026-11-16T00:00:00+01:00'), to: Date.parse('2026-11-16T23:59:00+01:00'), lines: [{ s: 'aut', n: '2' }] }),
    it('guasto-ora', { dated: false, from: now - H, to: now + 3 * H, lines: [{ s: 'aut', n: '2' }] }),
    it('vaporetto-2', { dated: true, from: now, to: now + 72 * H, lines: [{ s: 'nav', n: '2' }] }),
    it('fermata', { dated: true, from: now, to: now + 72 * H, stops: ['aut:162'] }),
    it('sciopero', { dated: true, effect: 'strike', from: Date.parse('2026-11-17T00:00:00+01:00'), to: Date.parse('2026-11-17T23:59:00+01:00') }),
    it('risolto', { dated: true, resolved: true, effect: 'resolved', from: now, to: now + 72 * H, lines: [{ s: 'aut', n: '2' }] }),
    it('orari-rete', { dated: true, general: true, effect: 'modified', from: now, to: now + 72 * H, lines: [{ s: 'aut', n: '2' }] })] });
  const ids = (a, b, t = now) => A.forJourney({ ...trip, fromMs: a, toMs: b }, t).map(x => x.id).sort();
  assert.deepEqual(ids(day2, day2 + H), ['fermata', 'lavori-17', 'sciopero']);              // viaggio di martedì: niente lavori di lunedì né guasto di adesso
  assert.deepEqual(ids(now + H, now + 2 * H), ['fermata', 'guasto-ora']);                     // viaggio tra un'ora: il guasto in corso conta
  assert.deepEqual(ids(now + 5 * H, now + 6 * H), ['fermata']);                               // stasera: il guasto di adesso no
  // v34: avvisi generali che possono far saltare corse o fermate (nebbia, acqua alta) entrano nel viaggio, dopo quelli specifici e segnati;
  // i generali informativi (nuovi orari) no. Fermate di salita/discesa sospese: frase esplicita «il mezzo potrebbe non fermarsi».
  A._setData({ items: [
    it('sospesa', { dated: true, effect: 'no_service', severity: 'severe', from: now, to: now + 72 * H, stops: ['aut:162'] }),
    it('nebbia', { dated: false, general: true, effect: 'reduced', title: 'Nebbia: navigazione rallentata', from: now - H, to: now + 4 * H }),
    it('acqua', { dated: true, general: true, effect: 'water', from: now, to: now + 6 * H }),
    it('nuovi-orari', { dated: true, general: true, effect: 'modified', from: now, to: now + 72 * H })] });
  const av = A.forJourney({ ...trip, fromMs: now + H, toMs: now + 2 * H }, now);
  assert.deepEqual(av.map(x => x.id), ['sospesa', 'nebbia', 'acqua']);
  assert.ok(av[1].generale && av[2].generale && !av[0].generale);
  const sosp = A.fermateSospese(av, [{ id: 'aut:510', name: 'VENEZIA' }, { id: 'aut:162', name: 'Mestre FS' }]);
  assert.deepEqual(sosp.map(f => [f.id, f.label]), [['aut:162', 'sospesa']]);
  assert.match(A.sospesaTxt(sosp[0]), /Mestre FS.*sospesa.*potrebbe non fermarsi/);
  assert.match(A.NOTA_INCERTA, /acqua alta, nebbia/);
  assert.deepEqual(A.forJourney({ ...trip, fromMs: now + 10 * H, toMs: now + 11 * H }, now).map(x => x.id), ['sospesa'], 'nebbia di adesso: non per stasera');
});

test('posizione durante il viaggio: accesa solo a piedi verso la fermata, nei cambi a piedi e prima di scendere; spenta a bordo', async () => {
  const { V } = await load();
  const sol = { ...SOL, tratte: SOL.tratte.map(t => (t.tipo === 'mezzo' ? { ...t, da: { ...t.da, lat: 45.44, lon: 12.32 }, a: { ...t.a, lat: 45.48, lon: 12.23 } } : t)) };
  const s = V.snapshot(sol, { date: '2026-11-16', from: FROM, to: TO }), at = hm => V.romeMs('2026-11-16', hm);
  assert.equal(s.legs[1].da.lat, 45.44, 'coordinate della fermata nell\'istantanea (restano sul telefono)');
  const tg = hm => { const ph = V.phase(s, at(hm)); return { k: ph.kind, t: V.gpsTarget(s, ph, at(hm)) }; };
  assert.equal(tg('08:00').t, null, 'esci tra 17 minuti: ancora spenta');
  assert.equal(tg('08:13').t.stop.name, 'VENEZIA', 'esci tra 4 minuti: accesa verso la fermata');
  assert.equal(tg('08:25').k, 'bordo'); assert.equal(tg('08:25').t, null, 'a bordo: spenta');
  assert.equal(tg('08:32').k, 'scendi'); assert.equal(tg('08:32').t.stop.name, 'Mestre FS C4', 'prima di scendere: accesa');
  assert.equal(tg('08:36').k, 'cambio'); assert.equal(tg('08:36').t.stop.name, 'Stazione Mestre FS', 'cambio a piedi: accesa');
  assert.equal(tg('08:54').t, null, 'ultimo tratto a piedi: spenta');
});

test('alternativa più veloce: si cerca solo con soppressione, cambio perso o arrivo in ritardo di 8 minuti o più', async () => {
  const { V } = await load();
  const s = V.snapshot(SOL, { date: '2026-11-16', from: FROM, to: TO }), at = hm => V.romeMs('2026-11-16', hm);
  assert.equal(V.altNeed(s, at('08:25')), null, 'tutto in orario');
  const R = s.legs.filter(l => l.t === 'r');
  R[1].a.live = R[1].a.ms + 5 * 60e3; assert.equal(V.altNeed(s, at('08:25')), null, '5 minuti di ritardo: niente');
  R[1].a.live = R[1].a.ms + 9 * 60e3; R[1].da.live = R[1].da.ms + 9 * 60e3;
  assert.equal(V.altNeed(s, at('08:25')).why, 'ritardo');
  delete R[1].a.live; delete R[1].da.live; R[0].a.live = R[0].a.ms + 6 * 60e3;   // arriva 08:40, 2 min a piedi, il 6 parte alle 08:40
  assert.equal(V.altNeed(s, at('08:30')).why, 'cambio'); assert.equal(V.altNeed(s, at('08:30')).arrive, Infinity);
  delete R[0].a.live; R[1].cancel = true;
  assert.equal(V.altNeed(s, at('08:30')).why, 'soppressa');
  assert.equal(V.altNeed(s, at('09:10')), null, 'viaggio finito');
});
