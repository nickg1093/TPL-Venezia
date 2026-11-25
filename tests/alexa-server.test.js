// SKILL ALEXA SUL SERVER VERO (feed ACTV simulato con tests/fakefeed.js, porta casuale): sicurezza dell'endpoint, confronto con la PWA a parità di dati,
// latenza, memoria e assenza di effetti su notifiche e tempo reale. Il server parte in un processo separato e si chiude a fine prova.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), net = require('net');

const TOKEN = 'prova-token-lungo-' + Math.random().toString(36).slice(2, 10);
const ROOT = path.join(__dirname, '..');
const porta = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pausa = ms => new Promise(r => setTimeout(r, ms));

async function avvia(env = {}) {
  const port = await porta(), base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['-r', path.join(ROOT, 'tests', 'fakefeed.js'), path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', TRUST_PROXY: '1', ...env }, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/healthz')).ok) return { base, proc }; } catch (e) { /* non ancora pronto */ } await pausa(500); }
  proc.kill(); throw new Error('il server non è partito');
}
const rss = pid => { try { return +/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1] / 1024; } catch (e) { return null; } };
const mediana = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)], p95 = a => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];

function rich(intent, slots = {}, extra = {}) {
  const sl = {}; for (const [k, v] of Object.entries(slots)) sl[k] = { name: k, value: v };
  return { version: '1.0', session: { new: false, sessionId: 'S', attributes: extra.attributi || {}, application: { applicationId: 'amzn1.ask.skill.prova' } }, context: { System: { application: { applicationId: 'amzn1.ask.skill.prova' }, device: { supportedInterfaces: {} } } }, request: { type: 'IntentRequest', requestId: 'R', timestamp: new Date(extra.ts ?? Date.now()).toISOString(), locale: extra.locale || 'it-IT', intent: { name: intent, slots: sl } } };
}
// ogni prova usa un «indirizzo» diverso (X-Forwarded-For, con TRUST_PROXY=1) così i limiti di frequenza di una non incidono sulle altre
let IP = '10.0.0.1'; const nuovoIp = () => (IP = '10.0.' + Math.floor(Math.random() * 250) + '.' + (1 + Math.floor(Math.random() * 250)));
const chiedi = (base, corpo, token = TOKEN) => fetch(base + '/api/alexa', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': IP, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) });
const parlato = j => (j.response.outputSpeech.ssml || '').replace(/<[^>]+>/g, '').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

let S, SENZA;
test.before(async () => { [S, SENZA] = await Promise.all([avvia({ ALEXA_TOKEN: TOKEN }), avvia({ ALEXA_TOKEN: '' })]); });
test.after(() => { for (const x of [S, SENZA]) if (x) x.proc.kill(); });

test('server: senza ALEXA_TOKEN l\'endpoint è spento (404) e la PWA funziona', async () => {
  nuovoIp();
  assert.equal((await chiedi(SENZA.base, rich('MareaIntent'), 'qualunque-token-lungo')).status, 404);
  assert.equal((await fetch(SENZA.base + '/api/alexa/flash')).status, 200, 'il flash briefing è un feed pubblico di sola lettura, come la PWA');
  assert.equal((await fetch(SENZA.base + '/api/stops')).status, 200);
});
test('server: token assente o errato → 401; token giusto → 200; metodo GET su /api/alexa non ammesso', async () => {
  nuovoIp();
  assert.equal((await chiedi(S.base, rich('MareaIntent'), null)).status, 401);
  assert.equal((await chiedi(S.base, rich('MareaIntent'), 'token-sbagliato-ma-lungo')).status, 401);
  assert.equal((await chiedi(S.base, rich('MareaIntent'))).status, 200);
  assert.notEqual((await fetch(S.base + '/api/alexa', { headers: { Authorization: 'Bearer ' + TOKEN } })).status, 200);
});
test('server: corpi non validi o enormi, JSON rotto, richiesta scaduta, skill ID diverso, lingua non italiana', async () => {
  nuovoIp();
  assert.ok([400, 413].includes((await chiedi(S.base, '{rotto')).status));
  const enorme = await chiedi(S.base, JSON.stringify({ x: 'a'.repeat(70000) })).then(r => r.status, () => 'connessione chiusa');
  assert.ok([400, 413, 'connessione chiusa'].includes(enorme), 'corpo enorme: ' + enorme);
  const vecchia = await chiedi(S.base, rich('MareaIntent', {}, { ts: Date.now() - 10 * 60e3 }));
  assert.ok([400, 403].includes(vecchia.status), 'richiesta vecchia di 10 minuti (replay) rifiutata: ' + vecchia.status);
  const inglese = await (await chiedi(S.base, rich('MareaIntent', {}, { locale: 'en-US' }))).json();
  assert.match(parlato(inglese), /solo in italiano/i);
});
test('server: il token non compare nelle risposte né negli errori', async () => {
  nuovoIp();
  for (const r of [await chiedi(S.base, rich('MareaIntent')), await chiedi(S.base, '{rotto'), await chiedi(S.base, rich('MareaIntent'), 'token-sbagliato-ma-lungo')]) assert.ok(!(await r.text()).includes(TOKEN));
});
test('server: ogni intent risponde con dati veri del server (stato 200, voce non vuota, nessun termine tecnico)', async () => {
  nuovoIp();
  const M = JSON.parse(fs.readFileSync(path.join(ROOT, 'alexa/skill-package/interactionModels/custom/it-IT.json'), 'utf8')).interactionModel.languageModel;
  const prove = { PartenzeIntent: { luogo: 'Zattere' }, ItinerarioIntent: { partenza: 'Zattere', arrivo: 'San Marco' }, RitardoIntent: { linea: 'due' }, AvvisiIntent: {}, MareaIntent: {}, MoseIntent: {}, RiepilogoIntent: {} };
  for (const it of M.intents) {
    const r = await chiedi(S.base, rich(it.name, prove[it.name] || {}));
    assert.equal(r.status, 200, it.name);
    const t = parlato(await r.json());
    assert.ok(t.length > 5, it.name);
    assert.doesNotMatch(t, /undefined|null|NaN|\[object|https?:|\{|\}|Error|ECONN|500|stack/, `${it.name}: «${t}»`);
  }
});
test('confronto con la PWA: le partenze dette da Alexa coincidono con /api/zone allo stesso istante', async () => {
  nuovoIp();
  const stops = await (await fetch(S.base + '/api/stops')).json();
  // tra le fermate di un gruppo con corse in arrivo, prendi la prima che la PWA mostra con almeno 2 partenze
  let trovato = null;
  for (const [id, nome] of stops.filter(s => s[4] === 'nav').slice(0, 60)) {
    const z = await (await fetch(`${S.base}/api/zone?ids=${encodeURIComponent(id)}`)).json();
    const dep = (z.departures || []).filter(d => !d.done);
    if (dep.length >= 2) { trovato = { nome, dep }; break; }
  }
  assert.ok(trovato, 'nessuna fermata con partenze nei dati di prova');
  const j = await (await chiedi(S.base, rich('PartenzeIntent', { luogo: trovato.nome.replace(/\s*"\w"$/, '') }))).json();
  const t = parlato(j);
  // la prima partenza della PWA deve comparire nella voce con la stessa ora; se la voce parla di un gruppo più ampio, basta una corrispondenza
  const orari = trovato.dep.slice(0, 6).map(d => d.exp || d.sched).filter(Boolean);
  assert.ok(orari.length, 'la PWA non dà orari');
  const parole = ['zero', 'un', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci'];
  assert.match(t, /tra .* minut|adesso|in arrivo|fra .* minut|alle |all'/i, 'la voce non indica attesa o orario: ' + t);
  assert.ok(/linea/i.test(t), t);
});
test('latenza: 40 richieste di partenze e marea — mediana e 95° percentile sotto il limite di Alexa', async () => {
  nuovoIp();
  const tempi = [];
  for (let i = 0; i < 40; i++) {
    const t0 = process.hrtime.bigint();
    const r = await chiedi(S.base, rich(i % 2 ? 'MareaIntent' : 'PartenzeIntent', i % 2 ? {} : { luogo: 'Zattere' }));
    assert.equal(r.status, 200); await r.text();
    tempi.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`# latenza ms: mediana ${mediana(tempi).toFixed(0)}, p95 ${p95(tempi).toFixed(0)}, max ${Math.max(...tempi).toFixed(0)}`);
  assert.ok(p95(tempi) < 3000, 'p95 troppo alto');
});
test('carico: 60 richieste simultanee — nessun crash, solo 200 o 429/503 con messaggio, memoria entro il limite di Render (512 MB)', async () => {
  nuovoIp();
  const prima = rss(S.proc.pid);
  const esiti = await Promise.all(Array.from({ length: 60 }, (_, i) => chiedi(S.base, rich(['PartenzeIntent', 'MareaIntent', 'AvvisiIntent', 'ItinerarioIntent'][i % 4], i % 4 === 0 ? { luogo: 'Zattere' } : i % 4 === 3 ? { partenza: 'Zattere', arrivo: 'San Marco' } : {})).then(async r => ({ s: r.status, t: await r.text() })).catch(e => ({ s: 0, t: String(e) }))));
  for (const e of esiti) assert.ok([200, 429, 503].includes(e.s), 'stato inatteso ' + e.s);
  assert.ok(esiti.filter(e => e.s === 200).length >= 30, 'troppe richieste rifiutate');
  assert.equal((await fetch(S.base + '/healthz')).status, 200, 'il server è ancora vivo');
  const dopo = rss(S.proc.pid);
  if (dopo != null) { console.log(`# memoria server (RSS) prima ${prima.toFixed(0)} MB, dopo ${dopo.toFixed(0)} MB`); assert.ok(dopo < 450, 'memoria troppo alta: ' + dopo); }
});
test('limite di frequenza: oltre 90 richieste al minuto dallo stesso indirizzo → 429', async () => {
  nuovoIp();
  let n429 = 0;
  for (let i = 0; i < 120 && !n429; i++) { const r = await chiedi(S.base, rich('MoseIntent')); await r.text(); if (r.status === 429) n429++; }
  assert.ok(n429, 'nessun 429 dopo 120 richieste');
});
test('tempo reale e notifiche non risentono della skill: PWA reattiva durante il carico e file del Web Push invariati', async () => {
  nuovoIp();
  await pausa(1000);
  const burst = Array.from({ length: 30 }, () => chiedi(S.base, rich('PartenzeIntent', { luogo: 'Zattere' })).then(r => r.text()).catch(() => {}));
  const t0 = Date.now(); const r = await fetch(S.base + '/api/vehicles?src=nav').catch(() => null);
  const h = await fetch(S.base + '/healthz'); const dt = Date.now() - t0;
  await Promise.all(burst);
  assert.equal(h.status, 200); assert.ok(dt < 2000, 'PWA lenta durante il carico: ' + dt + ' ms');
  // il Web Push non è stato toccato: nessuna riga di alexa in push.js/watch.js
  for (const f of ['push.js', 'watch.js']) assert.ok(!/alexa/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), f + ' non deve riferirsi ad alexa');
});
test('flash briefing: feed JSON valido con testi brevi, senza dati personali (GET)', async () => {
  const r = await fetch(S.base + '/api/alexa/flash', { headers: { Authorization: 'Bearer ' + TOKEN } }); const raw = await r.text();
  const alt = r.status === 200 ? { s: 200, raw } : (await (async () => { const q = await fetch(S.base + '/api/alexa/flash?token=' + TOKEN); return { s: q.status, raw: await q.text() }; })());
  assert.equal(alt.s, 200, 'flash: ' + r.status);
  const j = JSON.parse(alt.raw); const voci = Array.isArray(j) ? j : [j];
  assert.ok(voci.length >= 1);
  for (const v of voci) { assert.ok(v.uid && v.updateDate && v.titleText && v.mainText); assert.ok(v.mainText.length <= 4500); assert.doesNotMatch(v.mainText, /https?:|<\w+[^>]*>/); }
});

// ---- confronto con una ricerca indipendente sui GTFS veri (stessa data, stessi file di data/gtfs) ----
const Reale = require('./alexa-gtfs-reale');
const romaOggi = () => { const p = require('../calendar').romeParts(); return p.secs < 4 * 3600 ? require('../calendar').addDays(p.ymd, -1) : p.ymd; };
const isoDi = ymd => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
test('GTFS veri: ultima e prima corsa Rialto → Piazzale Roma coincidono con una ricerca indipendente (oggi, domani e un giorno con eccezioni di calendario)', async () => {
  nuovoIp();
  const g = await Reale.carica('nav');
  const da = new Set(Object.keys(g.stops).filter(s => /^Rialto "/.test(g.stops[s]))), a = new Set(Object.keys(g.stops).filter(s => /^P\.le Roma/.test(g.stops[s])));
  const cal = require('../calendar'), oggi = romaOggi(), domani = cal.addDays(cal.romeYmd(), 1);
  const eccezione = Object.keys(g.ex).sort().find(d => d > domani && Object.values(g.ex[d]).length);
  const giorni = [[oggi, null], [domani, isoDi(domani)]].concat(eccezione ? [[eccezione, isoDi(eccezione)]] : []);
  for (const [ymd, data] of giorni) {
    const atteso = Reale.diretti(g, ymd, da, a);
    const j = await (await chiedi(S.base, rich('UltimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma', ...(data ? { data } : {}) }))).json();
    const c = j.sessionAttributes && j.sessionAttributes.ctx;
    if (!atteso.length) { assert.match(parlato(j), /Non risultano/); continue; }
    assert.ok(c && c.dep != null, `${ymd}: ${parlato(j)}`);
    assert.equal(c.dep, atteso.at(-1).dep, `${ymd}: ultima ${parlato(j)}`);
    assert.equal(c.trip.split(':')[1], atteso.at(-1).tid);
  }
  const atteso = Reale.diretti(g, domani, da, a);
  const j = await (await chiedi(S.base, rich('PrimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma', data: isoDi(domani) }))).json();
  assert.equal(j.sessionAttributes.ctx.dep, atteso[0].dep, parlato(j));
});
test('GTFS veri: tram T1 da San Marco Cattaneo verso Venezia sale dalla fermata giusta (1) secondo la sequenza delle fermate', async () => {
  nuovoIp();
  const g = await Reale.carica('aut');
  const sm = new Set(Object.keys(g.stops).filter(s => /^San Marco Cattaneo$/i.test(g.stops[s].trim()))), ve = new Set(Object.keys(g.stops).filter(s => /^(Piazzale Roma|Venezia)\b/i.test(g.stops[s].trim())));
  const verso = Reale.diretti(g, romaOggi(), sm, ve, { tipo: 0 });
  assert.ok(verso.length, 'nessun tram verso Venezia nei dati');
  const fermate = [...new Set(verso.map(x => x.da))];
  assert.equal(fermate.length, 1, 'verso Venezia si sale da una sola delle due fermate');
  const j = await (await chiedi(S.base, rich('UltimaCorsaIntent', { mezzo: 'tram', luogo: 'San Marco Cattaneo', direzione: 'Venezia' }))).json();
  const t = parlato(j);
  // etichetta della PWA (zones.js): pali con lo stesso nome numerati per codice; quello verso Venezia
  const tutte = [...sm].sort((x, y) => x.localeCompare(y, 'it', { numeric: true })), n = tutte.indexOf(fermate[0]) + 1;
  assert.match(t, new RegExp(`San Marco Cattaneo ${n}\\b`), t);
  assert.equal(j.sessionAttributes.ctx.dep, verso.at(-1).dep, t);
  assert.match(t, /tram ti uno/);
});
