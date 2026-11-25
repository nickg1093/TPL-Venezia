// FUNZIONE LAMBDA (alexa/lambda): privacy dell'inoltro, esiti in caso di errore/timeout, gestione locale di Avvio/Aiuto/Stop. Server finto locale.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path'), fs = require('fs');

const SEGRETO = path.join(__dirname, '..', 'alexa', 'lambda', 'segreto.js');
const avevaSegreto = fs.existsSync(SEGRETO);
assert.ok(!avevaSegreto, 'segreto.js non deve esistere durante i test (è fuori dal repository): rinominalo e rilancia');

// server finto: registra le richieste e risponde secondo la modalità
function finto() {
  const st = { corpi: [], intest: [], sveglie: 0, modo: 'ok' };
  const srv = http.createServer((req, res) => {
    if (req.url === '/healthz') { st.sveglie++; return res.end('ok'); }
    const p = []; req.on('data', c => p.push(c)); req.on('end', () => {
      st.corpi.push(JSON.parse(Buffer.concat(p).toString())); st.intest.push(req.headers);
      if (st.modo === 'lento') return;                                            // non risponde mai
      if (st.modo !== 'ok') { res.statusCode = +st.modo; return res.end('x'); }
      if (st.modo === 'ok') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: '1.0', response: { outputSpeech: { type: 'SSML', ssml: '<speak>ok</speak>' }, shouldEndSession: true } })); }
    });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, st, url: `http://127.0.0.1:${srv.address().port}/api/alexa` })));
}
function carica(url, extra = {}) {
  process.env.TPL_TIMEOUT_MS = String(extra.timeoutMs || 800);
  Object.keys(require.cache).filter(k => k.includes(path.join('alexa', 'lambda'))).forEach(k => delete require.cache[k]);
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...a) { if (req === './segreto') return { url, token: 'T'.repeat(20), ...extra }; return orig.call(this, req, ...a); };
  try { return require('../alexa/lambda/index.js'); } finally { Module._load = orig; }
}
const evento = (tipo, intent, extra = {}) => ({
  version: '1.0',
  session: { new: true, sessionId: 'amzn1.echo-api.session.SEGRETO', user: { userId: 'amzn1.ask.account.UTENTE' }, application: { applicationId: 'amzn1.ask.skill.X' }, attributes: { ctx: 1 } },
  context: { System: { application: { applicationId: 'amzn1.ask.skill.X' }, user: { userId: 'amzn1.ask.account.UTENTE', accessToken: 'TOKEN' }, device: { deviceId: 'amzn1.ask.device.DISP', supportedInterfaces: { 'Alexa.Presentation.APL': {} } }, apiAccessToken: 'API', apiEndpoint: 'https://x' }, Viewport: { shape: 'RECTANGLE', pixelWidth: 1024, pixelHeight: 600, dpi: 160, extra: 'no' } },
  request: { type: tipo, requestId: 'amzn1.echo-api.request.R', timestamp: new Date().toISOString(), locale: 'it-IT', ...(intent ? { intent: { name: intent, slots: { luogo: { name: 'luogo', value: 'zattere' } } } } : {}) }, ...extra
});
const voce = r => r.response.outputSpeech.ssml;

test('lambda: l\'inoltro non contiene identificativi di utente, dispositivo, sessione o token', async () => {
  const { srv, st, url } = await finto();
  try {
    const { handler } = carica(url);
    const r = await handler(evento('IntentRequest', 'PartenzeIntent'));
    assert.match(voce(r), /ok/);
    assert.equal(st.corpi.length, 1);
    const testo = JSON.stringify(st.corpi[0]);
    for (const vietato of ['UTENTE', 'DISP', 'SEGRETO', 'TOKEN', 'userId', 'deviceId', 'sessionId', 'accessToken', 'apiAccessToken', 'amzn1.echo-api.request', 'extra']) assert.ok(!testo.includes(vietato), 'trapela: ' + vietato);
    assert.equal(st.corpi[0].request.intent.slots.luogo.value, 'zattere');
    assert.equal(st.corpi[0].context.Viewport.pixelWidth, 1024);
    assert.ok('Alexa.Presentation.APL' in st.corpi[0].context.System.device.supportedInterfaces);
    assert.equal(st.intest[0].authorization, 'Bearer ' + 'T'.repeat(20));
  } finally { srv.close(); }
});
test('lambda: Avvio «Ciao! Cosa vuoi sapere?» e sveglia il server; aiuto, categorie, presentazione e chiusura senza chiamarlo', async () => {
  const { srv, st, url } = await finto();
  try {
    const { handler } = carica(url);
    const a = await handler(evento('LaunchRequest'));
    assert.equal(voce(a), `<speak>${'Ciao! Cosa vuoi sapere?'}</speak>`); assert.equal(a.response.shouldEndSession, false);
    await new Promise(r => setTimeout(r, 150)); assert.equal(st.sveglie, 1);
    assert.match(voce(await handler(evento('IntentRequest', 'AMAZON.HelpIntent'))), /partenze, percorsi, marea, meteo o avvisi/);
    const cat = evento('IntentRequest', 'AiutoIntent'); cat.request.intent.slots = { categoria: { name: 'categoria', value: 'orari', resolutions: { resolutionsPerAuthority: [{ status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { id: 'partenze', name: 'partenze' } }] }] } } };
    assert.match(voce(await handler(cat)), /quando passa il due alle Zattere/);
    assert.match(voce(await handler(evento('IntentRequest', 'PresentatiIntent'))), /servizio indipendente/);
    assert.equal((await handler(evento('IntentRequest', 'AMAZON.StopIntent'))).response.shouldEndSession, true);
    assert.equal((await handler(evento('IntentRequest', 'AMAZON.CancelIntent'))).response.shouldEndSession, true);
    assert.equal(st.corpi.length, 0, 'nessuna richiesta inoltrata');
  } finally { srv.close(); }
});
test('lambda: le frasi fisse sono la copia esatta di alexa/messaggi.js (unico catalogo)', () => {
  const { generato, FILE } = require('../alexa/scripts/prepara-lambda');
  const fs = require('fs'), testo = fs.readFileSync(FILE, 'utf8');
  assert.equal(generato(testo), testo, 'esegui: node alexa/scripts/prepara-lambda.js');
  const { handler, _test } = carica('http://127.0.0.1:1/x');
  assert.deepEqual(_test.M(), require('../alexa/messaggi'));
  assert.ok(handler);
});
test('lambda: server che non risponde → frase onesta entro il tempo limite; «riprova» ripete la stessa richiesta', async () => {
  const { srv, st, url } = await finto(); st.modo = 'lento';
  try {
    const { handler } = carica(url, { timeoutMs: 400 });
    const ev = evento('IntentRequest', 'PartenzeIntent');
    const t0 = Date.now(), r = await handler(ev);
    assert.ok(Date.now() - t0 < 2000, 'troppo lenta');
    assert.equal(voce(r), '<speak>Il servizio non risponde ancora. Riprova tra poco.</speak>'); assert.equal(r.response.shouldEndSession, false);
    assert.doesNotMatch(voce(r), /svegli/, 'mai una causa non verificata');
    assert.equal(r.sessionAttributes.ctx, 1, 'il contesto della conversazione si conserva');
    assert.equal(r.sessionAttributes.rifai.name, 'PartenzeIntent');
    st.modo = 'ok';
    const ev2 = evento('IntentRequest', 'RiprovaIntent'); ev2.session.attributes = r.sessionAttributes; ev2.request.intent.slots = {};
    assert.match(voce(await handler(ev2)), /ok/);
    const inoltrata = st.corpi.at(-1);
    assert.equal(inoltrata.request.intent.name, 'PartenzeIntent'); assert.equal(inoltrata.request.intent.slots.luogo.value, 'zattere');
    assert.ok(!('rifai' in inoltrata.session.attributes));
  } finally { srv.closeAllConnections?.(); srv.close(); }
});
test('lambda: 503/429 → occupato; 502/504 → non risponde; 401 → configurazione; 500 → dati incompleti; mai testo tecnico', async () => {
  const { srv, st, url } = await finto();
  try {
    const { handler } = carica(url);
    for (const [codice, atteso] of [['503', /momentaneamente occupato/], ['429', /momentaneamente occupato/], ['502', /non risponde ancora/], ['504', /non risponde ancora/], ['401', /problema di configurazione/], ['500', /Non riesco a leggere tutti i dati/]]) {
      st.modo = codice;
      const r = await handler(evento('IntentRequest', 'MareaIntent'));
      assert.match(voce(r), atteso, codice);
      assert.doesNotMatch(voce(r), /HTTP|http|Error|undefined|token|Bearer|svegli/);
      if (codice === '401') assert.equal(r.response.shouldEndSession, true);
    }
  } finally { srv.close(); }
});
test('lambda: server irraggiungibile → non risponde; senza configurazione → messaggio chiaro; ID skill diverso → rifiutata', async () => {
  const { handler } = carica('http://127.0.0.1:1/api/alexa');
  assert.match(voce(await handler(evento('IntentRequest', 'MareaIntent'))), /non risponde ancora/);
  const h2 = carica('', { token: '' }).handler;
  assert.match(voce(await h2(evento('IntentRequest', 'MareaIntent'))), /non è ancora configurata/);
  const { srv, st, url } = await finto();
  try {
    const h3 = carica(url, { skillId: 'amzn1.ask.skill.ALTRA' }).handler;
    assert.match(voce(await h3(evento('IntentRequest', 'MareaIntent'))), /non valida/);
    assert.equal(st.corpi.length, 0);
  } finally { srv.close(); }
});
test('lambda: risposta progressiva «Sto controllando gli orari» solo se il server tarda, con il token di Alexa che non va a Render', async () => {
  const { srv, st, url } = await finto(); st.modo = 'ok';
  const prog = []; const alexa = http.createServer((req, res) => { const p = []; req.on('data', c => p.push(c)); req.on('end', () => { prog.push({ h: req.headers, b: JSON.parse(Buffer.concat(p)) }); res.statusCode = 204; res.end(); }); });
  await new Promise(ok => alexa.listen(0, '127.0.0.1', ok));
  const ep = `http://127.0.0.1:${alexa.address().port}`;
  try {
    process.env.TPL_PROGRESSIVA_MS = '100';
    const { handler } = carica(url);
    const lento = http.createServer((req, res) => { const p = []; req.on('data', c => p.push(c)); req.on('end', () => setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: '1.0', response: { outputSpeech: { type: 'SSML', ssml: '<speak>ok</speak>' }, shouldEndSession: true } })); }, 400)); });
    await new Promise(ok => lento.listen(0, '127.0.0.1', ok));
    const h2 = carica(`http://127.0.0.1:${lento.address().port}/api/alexa`).handler;
    const ev = evento('IntentRequest', 'UltimaCorsaIntent'); ev.context.System.apiEndpoint = ep; ev.context.System.apiAccessToken = 'TOKEN-ALEXA';
    assert.match(voce(await h2(ev)), /ok/);
    assert.equal(prog.length, 1); assert.equal(prog[0].h.authorization, 'Bearer TOKEN-ALEXA');
    assert.equal(prog[0].b.directive.type, 'VoicePlayer.Speak'); assert.match(prog[0].b.directive.speech, /Sto controllando gli orari/);
    assert.equal(prog[0].b.header.requestId, 'amzn1.echo-api.request.R');
    // server veloce: nessuna risposta progressiva
    const ev2 = evento('IntentRequest', 'UltimaCorsaIntent'); ev2.context.System.apiEndpoint = ep; ev2.context.System.apiAccessToken = 'TOKEN-ALEXA';
    await handler(ev2); await new Promise(r => setTimeout(r, 200));
    assert.equal(prog.length, 1);
    lento.close();
  } finally { delete process.env.TPL_PROGRESSIVA_MS; alexa.close(); srv.close(); }
});
test('lambda: SessionEnded e richiesta vuota non provocano errori', async () => {
  const { handler } = carica('http://127.0.0.1:1/x');
  assert.deepEqual((await handler(evento('SessionEndedRequest'))).response, {});
  assert.match(voce(await handler({})), /Non ho capito/);
});
