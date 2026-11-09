// INTERPRETAZIONE AI (avvisi-ai.js, scripts/interpreta-avvisi.js, uso in avvisi.js). Nessuna chiamata reale a Cloudflare: le risposte del modello
// sono SIMULATE (scritte qui, indicate come tali), i testi delle comunicazioni sono REALI (tests/avvisi-ai.json, dal ramo archivio-avvisi) salvo i
// messaggi SINTETICI costruiti per provare le regole di collegamento. Si prova che il codice accetta solo ciò che il testo sostiene e che,
// senza interpretazioni o con interpretazioni scartate, tutto resta come prima. La qualità del modello si misura a parte (--casi --confronta).
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const AI = require('../avvisi-ai'), AR = require('../avvisi-archivio'), A = require('../avvisi');
const J = require('./avvisi-ai.json');
const R = Object.fromEntries(J.record.map(r => [r.id.split(' ')[0], r]));

const known = new Map([
  ['T1', [{ n: 'T1', s: 'aut', c: null }]], ['T2', [{ n: 'T2', s: 'aut', c: null }]],
  ['1', [{ n: '1', s: 'nav', c: null }, { n: '1', s: 'aut', c: null }]], ['2', [{ n: '2', s: 'nav', c: null }, { n: '2', s: 'aut', c: null }]],
  ['N', [{ n: 'N', s: 'nav', c: null }, { n: 'N', s: 'aut', c: null }]], ['5.1', [{ n: '5.1', s: 'nav', c: null }]], ['5.2', [{ n: '5.2', s: 'nav', c: null }]]]);
const ctx = { v: 1, known, byName: new Map(), lineStops: new Map(), nameOf: id => id };
const at = s => Date.parse(s);

// risposta SIMULATA corretta per il messaggio reale 11897
const GOOD_11897 = { servizio: 'navigazione', tipo: 'sospensione', certezza: 'alta', relazioni: [], fermate: [{ nome: 'Piazzale Roma "G"', citazione: 'Piazzale Roma "G"' }],
  linee: [{ linea: '2', servizio: 'navigazione', direzione: null, citazione: 'le linee 2 e N utilizzeranno' }, { linea: 'N', servizio: 'navigazione', direzione: null, citazione: 'le linee 2 e N utilizzeranno' }],
  periodi: [{ inizio: '2026-11-09T22:30', fine: '2026-11-10T01:30', citazione: 'dalle ore 22:30 di lunedì 9 novembre alle ore 01:30 di martedì 10 novembre 2026' }] };

// ---------------------------------------------------------------------------------------------------------------------
test('AI · validazione: risposta corretta sul messaggio reale 11897 (linee della navigazione, periodo citato)', () => {
  const v = AI.validate(GOOD_11897, R['tg:11897'], ctx, []);
  assert.equal(v.ok, true, v.scarti.join('; '));
  assert.deepEqual(v.linee.map(l => l.s + ':' + l.n), ['nav:2', 'nav:N']);
  assert.equal(v.periodo.from, at('2026-11-09T22:30:00+01:00')); assert.equal(v.periodo.to, at('2026-11-10T01:30:00+01:00'));
  assert.equal(v.effetto, 'no_service');
});

test('AI · validazione: dati non sostenuti dal testo vengono scartati uno per uno', () => {
  const bad = { ...GOOD_11897, linee: [
    { linea: '7', servizio: 'navigazione', citazione: 'la linea 7 è sospesa' },                       // citazione inventata
    { linea: '1', servizio: 'navigazione', citazione: 'le linee 2 e N utilizzeranno' },               // numero assente dalla citazione
    { linea: 'G', servizio: 'navigazione', citazione: 'Piazzale Roma "G"' },                          // lettera del pontile
    { linea: 'T1', servizio: 'navigazione', citazione: 'le linee 2 e N' },                           // non compare / servizio sbagliato
    { linea: '2', servizio: 'navigazione', citazione: 'le linee 2 e N utilizzeranno' }] };
  const v = AI.validate(bad, R['tg:11897'], ctx, []);
  assert.deepEqual(v.linee.map(l => l.s + ':' + l.n), ['nav:2']);
  assert.equal(v.scarti.filter(s => s.startsWith('linea')).length, 4, v.scarti.join('; '));
  const tram = AI.validate({ ...GOOD_11897, linee: [{ linea: 'T1', servizio: 'navigazione', citazione: 'Linea T1 nel tratto VENEZIA' }] }, R['tg:11894'], ctx, []);
  assert.deepEqual(tram.linee, [], 'T1 non esiste nella navigazione');
});

test('AI · validazione: periodi (giorno nella citazione, anno plausibile, fine dopo inizio, ora legale/solare)', () => {
  const p = (inizio, fine, citazione) => AI.validate({ ...GOOD_11897, periodi: [{ inizio, fine, citazione }] }, R['tg:11897'], ctx, []).periodo;
  assert.equal(p('2026-11-08T22:30', '2026-11-10T01:30', 'dalle ore 22:30 di lunedì 9 novembre'), null, 'giorno diverso dalla citazione');
  assert.equal(p('2027-11-09T22:30', '2027-11-10T01:30', 'dalle ore 22:30 di lunedì 9 novembre'), null, 'anno lontano');
  assert.equal(p('2026-11-09T22:30', '2026-11-09T21:00', 'dalle ore 22:30 di lunedì 9 novembre'), null, 'fine prima dell\'inizio');
  assert.equal(p('2026-11-09T22:30', null, 'dalle ore 22:30 di lunedì 9 novembre'), null, 'senza fine non si usa');
  assert.equal(AI.romeLocalMs('2026-07-01T10:00'), at('2026-07-01T10:00:00+02:00'));
  assert.equal(AI.romeLocalMs('2026-12-01T10:00'), at('2026-12-01T10:00:00+01:00'));
  assert.equal(AI.romeLocalMs('2026-13-01T10:00'), null);
});

test('AI · validazione: relazioni solo verso comunicazioni proposte; due eventi diversi indicati = nessuna scelta; certezza bassa = non usata', () => {
  const cand = ['tg:11894', 'rss:10605 at https://actv.avmspa.it'];
  const mapped = AI.mapRelazioni({ relazioni: [{ id: 'C1', tipo: 'ripristina', motivo: '' }, { id: 'rss:10605', tipo: 'indipendente', motivo: '' }, { id: 'C9', tipo: 'aggiorna', motivo: '' }] }, cand);
  assert.deepEqual(mapped.relazioni.map(r => r.id), ['tg:11894', 'rss:10605 at https://actv.avmspa.it', 'C9']);
  const base = { servizio: 'automobilistico', tipo: 'ripristino_progressivo', certezza: 'alta', linee: [], periodi: [] };
  let v = AI.validate({ ...base, relazioni: mapped.relazioni }, R['tg:11895'], ctx, cand);
  assert.deepEqual(v.relazioni, [{ id: 'tg:11894', tipo: 'ripristina' }, { id: 'rss:10605 at https://actv.avmspa.it', tipo: 'indipendente' }]);
  v = AI.validate({ ...base, relazioni: [{ id: 'tg:11894', tipo: 'aggiorna' }, { id: 'rss:10605 at https://actv.avmspa.it', tipo: 'aggiorna' }] }, R['tg:11895'], ctx, cand);
  assert.deepEqual(v.relazioni, [], 'due eventi indicati: nessuno');
  v = AI.validate({ ...base, certezza: 'bassa', relazioni: [] }, R['tg:11895'], ctx, cand);
  assert.equal(v.ok, false);
  assert.equal(AI.validate({ ...base, tipo: 'boh' }, R['tg:11895'], ctx, cand).formale, false);
  assert.equal(AI.validate(null, R['tg:11895'], ctx, cand).formale, false);
});

test('AI · lettura della risposta: JSON mode, testo, formato OpenAI, blocchi ``` e ragionamento <think>', () => {
  assert.equal(AI.parseOutput({ response: { servizio: 'navigazione', tipo: 'altro' } }).servizio, 'navigazione');
  assert.equal(AI.parseOutput({ response: '```json\n{"servizio":"nessuno","tipo":"altro"}\n```' }).servizio, 'nessuno');
  assert.equal(AI.parseOutput({ choices: [{ message: { content: '<think>…</think>{"servizio":"entrambi","tipo":"altro"}' } }] }).servizio, 'entrambi');
  assert.throws(() => AI.parseOutput({ response: 'non lo so' }), AI.OutputError);
});

// fetch SIMULATO di Cloudflare
const fakeFetch = (fn) => async (url, opt) => { const r = fn(url, JSON.parse(opt.body), opt); return { status: r.status || 200, ok: (r.status || 200) < 400, text: async () => JSON.stringify(r.body) }; };
const ACC = '0123456789abcdef0123456789abcdef', TOK = 'segreto-di-prova-123';

test('AI · chiamata a Workers AI: richiesta corretta, neuroni dai token, errori distinti, token mai nei messaggi', async () => {
  let seen;
  const ok = fakeFetch((url, body, opt) => { seen = { url, body, auth: opt.headers.Authorization }; return { body: { success: true, result: { response: GOOD_11897, usage: { prompt_tokens: 1000, completion_tokens: 200 } } } }; });
  const r = await AI.chiama({ accountId: ACC, token: TOK, messages: [{ role: 'user', content: 'x' }], fetchImpl: ok });
  assert.equal(seen.url, `https://api.cloudflare.com/client/v4/accounts/${ACC}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`);
  assert.equal(seen.auth, `Bearer ${TOK}`); assert.equal(seen.body.response_format.type, 'json_schema'); assert.equal(seen.body.temperature, 0);
  assert.equal(r.json.servizio, 'navigazione'); assert.equal(r.neuroni, Math.round((1000 * 26668 + 200 * 204805) / 1e6 * 10) / 10);
  const err = (status, body) => AI.chiama({ accountId: ACC, token: TOK, messages: [], fetchImpl: fakeFetch(() => ({ status, body })) });
  await assert.rejects(err(429, { success: false, errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] }), AI.QuotaError);
  await assert.rejects(err(400, { success: false, errors: [{ message: "JSON Mode couldn't be met" }] }), AI.OutputError);
  await assert.rejects(err(503, { success: false, errors: [{ message: 'busy' }] }), AI.TransientError);
  await assert.rejects(err(401, { success: false, errors: [{ message: `bad token ${TOK}` }] }), e => !e.message.includes(TOK) && /accesso negato/.test(e.message));
  await assert.rejects(err(400, { success: false, errors: [{ message: `echo ${TOK}` }] }), e => !e.message.includes(TOK));
  await assert.rejects(AI.chiama({ accountId: 'x', token: TOK, messages: [], fetchImpl: ok }), /Account ID/);
});

// ---------------------------------------------------------------------------------------------------------------------
// SCRIPT (workflow e prove locali) su una copia temporanea dell'archivio reale
function tmpArchive(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-')), d = AR.openDir(dir);
  for (const r of records) d.add({ ...r, v: undefined }); d.save(Date.now()); return dir;
}
const filesHash = dir => { const f = path.join(dir, 'comunicazioni'); return fs.readdirSync(f).map(n => n + ':' + require('crypto').createHash('sha1').update(fs.readFileSync(path.join(f, n))).digest('hex')).join() + fs.readFileSync(path.join(dir, 'indice.json'), 'utf8'); };
async function runScript(argv, fetchFn, env = {}) {
  const S = require('../scripts/interpreta-avvisi'), old = { ...process.env }, log = console.log; const outLines = [];
  Object.assign(process.env, { GITHUB_ACTIONS: 'true', CLOUDFLARE_ACCOUNT_ID: ACC, CLOUDFLARE_API_TOKEN: TOK, ...env });
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  console.log = (...a) => outLines.push(a.join(' '));
  try { const r = await S.main(argv, { fetchImpl: fetchFn, ctx, pausa: 0 }); return { ...r, out: outLines.join('\n') }; }
  finally { console.log = log; process.env = old; }
}

test('AI · script: solo comunicazioni nuove, poi niente; --forza rielabora; archivio originale intatto; credenziali mai stampate', async () => {
  const dir = tmpArchive([R['tg:11897'], R['tg:11894'], R['tg:11895']]), before = filesHash(dir), out = path.join(dir, 'ai');
  let calls = 0; const f = fakeFetch(() => { calls++; return { body: { success: true, result: { response: GOOD_11897, usage: { prompt_tokens: 1500, completion_tokens: 250 } } } }; });
  let r = await runScript(['--archivio', dir, '--out', out], f);
  assert.equal(calls, 3); assert.equal(r.changes, true); assert.match(r.out, /AI_CHANGES=1/); assert.ok(!r.out.includes(TOK));
  assert.equal(filesHash(dir), before, 'comunicazioni originali e indice invariati');
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'indice.json'), 'utf8')); assert.equal(idx.formato, 1); assert.equal(idx.file.length, 1);
  const rows = fs.readFileSync(path.join(out, 'interpretazioni', '2026-11.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3); assert.ok(rows.every(x => x.esito === 'ok' && x.hash && x.modello && x.prompt === AI.PROMPT_VER));
  assert.equal(rows.find(x => x.id === 'tg:11897').verifica.usabile, true);
  assert.equal(rows.find(x => x.id === 'tg:11894').verifica.usabile, false, 'la stessa risposta non regge sul testo di 11894');
  r = await runScript(['--archivio', dir, '--out', out], f); assert.equal(calls, 3, 'già interpretate: nessuna chiamata'); assert.match(r.out, /AI_CHANGES=0/);
  r = await runScript(['--archivio', dir, '--out', out, '--id', 'tg:11897', '--forza'], f); assert.equal(calls, 4);
});

test('AI · script: quota esaurita, risposte non valide, errori temporanei, limite giornaliero, credenziali assenti', async () => {
  const dir = tmpArchive([R['tg:11897'], R['tg:11894'], R['tg:11895']]), out = path.join(dir, 'ai');
  let r = await runScript(['--archivio', dir, '--out', out], fakeFetch(() => ({ status: 429, body: { success: false, errors: [{ message: 'daily free allocation' }] } })));
  assert.match(r.stop, /quota/); assert.equal(r.changes, false); assert.ok(!fs.existsSync(path.join(out, 'interpretazioni')), 'nulla di scritto');
  let n = 0; r = await runScript(['--archivio', dir, '--out', out], fakeFetch(() => (++n, { status: 400, body: { success: false, errors: [{ message: "JSON Mode couldn't be met" }] } })));
  assert.equal(n, 3); r = await runScript(['--archivio', dir, '--out', out], fakeFetch(() => (++n, { status: 400, body: { success: false, errors: [{ message: "JSON Mode couldn't be met" }] } })));
  assert.equal(n, 6, 'secondo tentativo'); r = await runScript(['--archivio', dir, '--out', out], fakeFetch(() => (++n, { body: {} })));
  assert.equal(n, 6, `dopo ${AI.MAX_TENTATIVI} risposte non valide si rinuncia (resta il funzionamento a regole)`);
  const dir2 = tmpArchive([R['tg:11897'], R['tg:11894']]); n = 0;
  r = await runScript(['--archivio', dir2, '--out', path.join(dir2, 'ai')], fakeFetch(() => (++n, { status: 502, body: {} })));
  assert.equal(n, 4, 'un nuovo tentativo per comunicazione'); assert.ok(!fs.existsSync(path.join(dir2, 'ai', 'interpretazioni')), 'errore temporaneo: si riprova alla prossima esecuzione');
  n = 0; r = await runScript(['--archivio', dir2, '--out', path.join(dir2, 'ai')], fakeFetch(() => (++n, { body: { success: true, result: { response: GOOD_11897, usage: { prompt_tokens: 20000, completion_tokens: 2000 } } } })), { AI_MAX_NEURONI_GIORNO: '900' });
  assert.equal(n, 1, 'stop al limite giornaliero stimato'); assert.match(r.stop, /limite giornaliero/);
  r = await runScript(['--archivio', dir2, '--out', path.join(dir2, 'ai')], fakeFetch(() => assert.fail('nessuna chiamata')), { CLOUDFLARE_API_TOKEN: undefined });
  assert.equal(r.motivo, 'credenziali'); assert.match(r.out, /AI_CHANGES=0/);
});

test('AI · script in locale: non scrive mai dentro l\'archivio', async () => {
  const dir = tmpArchive([R['tg:11897']]);
  await assert.rejects(runScript(['--archivio', dir, '--out', path.join(dir, 'ai')], fakeFetch(() => ({})), { GITHUB_ACTIONS: undefined }).catch(e => { throw e; }), /dentro la cartella dell'archivio/);
});

// ---------------------------------------------------------------------------------------------------------------------
// USO SUL SERVER (avvisi.js): interpretazioni pronte nel ramo, validate e applicate solo nelle direzioni ammesse
const aiRow = (rec, ai, candidati = []) => ({ id: rec.id, hash: rec.hash, v: 1, modello: AI.MODELLO_PREDEFINITO, prompt: AI.PROMPT_VER, at: 0, esito: 'ok', ai, candidati });
function server(records, aiRows, now) {
  A.setContext(() => ctx); A.setTideSource(() => null); A._load({ rss: [], tg: [], pages: {} });
  AR._setRecords(records); AR._setAi(aiRows);
  return { items: A.build(now), eventi: A.eventi(now) };
}
const NOW = at('2026-11-08T11:00:00+01:00');
test.after(() => { AR._setRecords([]); AR._setAi([]); });

test('AI · server: 11897 da solo, effetto riconosciuto («sospensione approdo») e periodo invariato; senza AI resta «Avviso»', () => {
  const base = server([R['tg:11897']], [], NOW).items, withAi = server([R['tg:11897']], [aiRow(R['tg:11897'], GOOD_11897)], NOW);
  assert.equal(base[0].effect, 'other');
  assert.equal(withAi.items[0].effect, 'no_service');
  assert.deepEqual(withAi.items[0].lines.map(l => l.s + ':' + l.n), ['nav:2', 'nav:N']);
  assert.equal(withAi.items[0].from, base[0].from); assert.equal(withAi.items[0].to, base[0].to);
  const info = withAi.eventi[0].comunicazioni[0].ai; assert.equal(info.esito, 'usata');
  assert.ok(!('ai' in withAi.items[0]) && !('aiInfo' in withAi.items[0]), 'formato di /api/avvisi invariato');
});

test('AI · server: servizio corretto per lo stesso numero (2 bus -> 2 vaporetto); interpretazione di un\'altra versione del testo ignorata', () => {
  const rec = AR.recordOf('tg', { key: 'tg:99001', pubMs: at('2026-11-08T09:00:00+01:00'), url: 'u', text: '🚍 #muoversivenezia | Venezia\n\noggi dalle 10:00 alle 12:00 la linea 2 non ferma a Rialto per lavori al pontile.', links: [] }, null, 0);   // SINTETICO
  const base = server([rec], [], NOW).items[0];
  assert.deepEqual(base.lines.map(l => l.s + ':' + l.n), ['aut:2'], 'le regole leggono il bus (emoji 🚍)');
  const ai = { servizio: 'navigazione', tipo: 'sospensione', certezza: 'alta', relazioni: [], periodi: [], linee: [{ linea: '2', servizio: 'navigazione', citazione: 'la linea 2 non ferma a Rialto' }] };
  assert.deepEqual(server([rec], [aiRow(rec, ai)], NOW).items[0].lines.map(l => l.s + ':' + l.n), ['nav:2']);
  assert.deepEqual(server([rec], [{ ...aiRow(rec, ai), hash: 'altraversione' }], NOW).items[0].lines.map(l => l.s + ':' + l.n), ['aut:2'], 'impronta diversa: solo regole');
  assert.deepEqual(server([rec], [aiRow(rec, { ...ai, certezza: 'bassa' })], NOW).items[0].lines.map(l => l.s + ':' + l.n), ['aut:2'], 'certezza bassa: solo regole');
  const e = server([rec], [aiRow(rec, { ...ai, certezza: 'bassa' })], NOW).eventi[0].comunicazioni[0].ai; assert.equal(e.esito, 'scartata');
});

// messaggi SINTETICI per i collegamenti (linea 5.1 della navigazione, tram T2)
const tg = (id, text, iso, replyTo) => ({ ...AR.recordOf('tg', { key: 'tg:' + id, pubMs: at(iso), url: 'https://t.me/muoversivenezia/' + id, text, links: [], ...(replyTo ? { replyTo } : {}) }, null, 0), v: 1 });
const T0 = '2026-11-08T';

test('AI · server: due avvisi simili ma per l\'AI eventi diversi → nessuna fusione; senza AI le regole li fondono', () => {
  const a = tg(99101, '⚠️ #muoversivenezia ⛴ | Lido\n\nlinea 5.1 sospesa per lavori al pontile Lido S.M.E. fino alle 13:00', T0 + '09:00:00+01:00');
  const b = tg(99102, '⚠️ #muoversivenezia ⛴ | Lido\n\nlinea 5.1 sospesa per lavori al pontile Lido S.M.E. fino alle 15:00', T0 + '09:30:00+01:00');
  const now = at(T0 + '10:00:00+01:00');
  assert.equal(server([a, b], [], now).items.length, 1, 'regole: aggiornamento');
  const ai = { servizio: 'navigazione', tipo: 'sospensione', certezza: 'alta', linee: [], periodi: [], relazioni: [{ id: a.id, tipo: 'indipendente', motivo: 'pontile diverso' }] };
  assert.equal(server([a, b], [aiRow(b, ai, [a.id])], now).items.length, 2, 'AI: eventi indipendenti');
  assert.equal(server([a, b], [aiRow(b, { ...ai, relazioni: [{ id: a.id, tipo: 'indipendente' }] }, [])], now).items.length, 1, 'relazione verso una comunicazione non proposta: ignorata');
});

test('AI · server: ripristino completo per le regole, ma l\'AI legge parziale / progressivo / nessun ripristino', () => {
  const a = tg(99201, '#muoversivenezia | 📢 Mestre centro\n\nlinea T2 momentaneamente sospesa per manifestazione', T0 + '09:00:00+01:00');
  const b = tg(99202, '✅ linea T2 regolare', T0 + '09:40:00+01:00', 99201);
  const now = at(T0 + '10:00:00+01:00'), ai = tipo => [aiRow(b, { servizio: 'automobilistico', tipo, certezza: 'alta', linee: [], periodi: [], relazioni: [] }, [a.id])];
  const st = r => r.eventi.find(e => e.comunicazioni.some(m => m.key === a.id)).stato;
  assert.equal(st(server([a, b], [], now)), 'concluso', 'regole: chiuso dal ripristino');
  assert.equal(st(server([a, b], ai('ripristino'), now)), 'concluso', 'AI d\'accordo');
  assert.equal(st(server([a, b], ai('ripristino_parziale'), now)), 'in corso', 'parziale: evento aperto');
  assert.equal(st(server([a, b], ai('ripristino_progressivo'), now)), 'ripristino in corso');
  const r = server([a, b], ai('deviazione'), now), e = r.eventi.find(x => x.comunicazioni.some(m => m.key === a.id));
  assert.equal(e.stato, 'in corso', 'disaccordo: nessuna modifica'); assert.match(r.eventi.flatMap(x => x.incerte).map(x => x.motivo).join(), /non confermato/);
  assert.equal(st(server([a, b], [aiRow(b, { servizio: 'automobilistico', tipo: 'ripristino_parziale', certezza: 'media', linee: [], periodi: [], relazioni: [] }, [a.id])], now)), 'concluso', 'certezza media: prevalgono le regole');
});

test('AI · server: l\'AI non crea collegamenti che le regole non vedono', () => {
  const a = tg(99301, '⚠️ #muoversivenezia ⛴ | Murano\n\nlinea 5.2 deviata per regata', T0 + '09:00:00+01:00');
  const b = tg(99302, '⚠️ #muoversivenezia 🚍 | Mestre\n\nvia Piave chiusa per lavori', T0 + '09:30:00+01:00');
  const now = at(T0 + '10:00:00+01:00');
  const ai = { servizio: 'automobilistico', tipo: 'ripristino', certezza: 'alta', linee: [], periodi: [], relazioni: [{ id: a.id, tipo: 'ripristina', motivo: '' }] };
  const r = server([a, b], [aiRow(b, ai, [a.id])], now);
  assert.equal(r.items.length, 2); assert.equal(r.eventi.find(e => e.comunicazioni.some(m => m.key === a.id)).stato, 'in corso');
});

test('AI · server: più eventi collegabili (le regole non scelgono) → l\'AI indica quale', () => {
  const a1 = tg(99401, '⚠️ #muoversivenezia ⛴ | Lido\n\nlinea 5.1 direzione Lido sospesa per lavori al pontile', T0 + '09:00:00+01:00');
  const a2 = tg(99402, '⚠️ #muoversivenezia ⛴ | Lido\n\nlinea 5.1 direzione Venezia sospesa per lavori al pontile', T0 + '09:05:00+01:00');
  const b = tg(99403, '⚠️ #muoversivenezia ⛴ | Lido\n\nlavori al pontile: sospensione prorogata fino alle 14:00', T0 + '09:30:00+01:00');
  const now = at(T0 + '10:00:00+01:00');
  const r0 = server([a1, a2, b], [], now), inc = r0.eventi.flatMap(e => e.incerte);
  assert.ok(inc.some(x => x.msg === b.id), 'regole: incerta, nessuna modifica'); assert.equal(r0.items.length, 3);
  const ai = { servizio: 'navigazione', tipo: 'sospensione', certezza: 'alta', linee: [], periodi: [], relazioni: [{ id: a2.id, tipo: 'aggiorna', motivo: '' }] };
  const r = server([a1, a2, b], [aiRow(b, ai, [a1.id, a2.id])], now);
  assert.equal(r.items.length, 2, 'b aggiorna a2'); const ev = r.eventi.find(e => e.comunicazioni.some(m => m.key === b.id));
  assert.ok(ev.comunicazioni.some(m => m.key === a2.id) && !ev.comunicazioni.some(m => m.key === a1.id));
  assert.equal(ev.comunicazioni.find(m => m.key === b.id).certezza, 'regole+ai');
});

test('AI · casi di riferimento: file valido e coerente con l\'archivio (id reali, valori ammessi)', () => {
  const C = require('./avvisi-ai-casi.json');
  for (const c of C.casi) {
    assert.match(c.id, /^(?:tg:\d+|rss:\d+ at https:\/\/actv\.avmspa\.it)$/);
    for (const t of c.tipo) assert.ok(AI.TIPI.includes(t), t);
    for (const r of [...(c.attese || []), ...(c.vietate || [])]) for (const t of r.tipi) assert.ok(AI.RELAZIONI.includes(t), t);
  }
  const S = require('../scripts/interpreta-avvisi');
  const v = AI.validate(GOOD_11897, R['tg:11897'], ctx, []);
  assert.ok(S.score(C.casi.find(c => c.id === 'tg:11897'), v, []).every(x => x.ok));
});

test('AI · lettura sul server: avvisi/ai letta come l\'archivio (solo righe riuscite); cartella assente = nessun errore', async () => {
  AR._setAi([]); const dir = tmpArchive([R['tg:11897'], R['tg:11894']]);
  assert.equal(await AR.refresh(dir), true); assert.equal(AR.aiRecords().size, 0); assert.match(AR.aiStatus().errore || '', /ENOENT|no such file/i);
  assert.equal(AR.status().errore, null, 'archivio delle comunicazioni letto normalmente');
  const st = AI.openAiDir(path.join(dir, 'ai'));
  st.add(aiRow(R['tg:11897'], GOOD_11897), R['tg:11897'].pub);
  st.add({ ...aiRow(R['tg:11894'], null), esito: 'non_valido', ai: undefined }, R['tg:11894'].pub);
  st.save(Date.now(), { modello: AI.MODELLO_PREDEFINITO });
  const v0 = AR.version();
  assert.equal(await AR.refresh(dir), true); assert.ok(AR.version() > v0, 'cambia la versione: le cache degli avvisi si rinnovano');
  assert.deepEqual([...AR.aiRecords().keys()], [R['tg:11897'].id + '|' + R['tg:11897'].hash]);
  assert.equal(await AR.refresh(dir), false, 'file invariati: non si rileggono');
  AR._setRecords([]); AR._setAi([]);
});

test('AI · percorso completo simulato: workflow (script) -> ramo (cartella) -> server (lettura, validazione, avviso)', async () => {
  AR._setAi([]); const dir = tmpArchive([R['tg:11897']]);
  const r = await runScript(['--archivio', dir, '--out', path.join(dir, 'ai')], fakeFetch(() => ({ body: { success: true, result: { response: GOOD_11897, usage: { prompt_tokens: 1800, completion_tokens: 300 } } } })));
  assert.equal(r.changes, true);
  A.setContext(() => ctx); A.setTideSource(() => null); A._load({ rss: [], tg: [], pages: {} });
  assert.equal(await AR.refresh(dir), true);
  const it = A.build(NOW)[0];
  assert.equal(it.effect, 'no_service'); assert.deepEqual(it.lines.map(l => l.s + ':' + l.n), ['nav:2', 'nav:N']);
  assert.equal(A.eventiDiag().ai.interpretazioni, 1);
  AR._setRecords([]); AR._setAi([]);
});
