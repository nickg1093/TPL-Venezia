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
test('lambda: Avvio sveglia il server e risponde subito in locale; Aiuto e Stop non chiamano il server', async () => {
  const { srv, st, url } = await finto();
  try {
    const { handler } = carica(url);
    const a = await handler(evento('LaunchRequest'));
    assert.match(voce(a), /non ufficiale/i); assert.equal(a.response.shouldEndSession, false); assert.equal(st.sveglie, 1);
    const h = await handler(evento('IntentRequest', 'AMAZON.HelpIntent'));
    assert.match(voce(h), /partenze/i); assert.equal(h.response.shouldEndSession, false);
    const s = await handler(evento('IntentRequest', 'AMAZON.StopIntent'));
    assert.equal(s.response.shouldEndSession, true);
    const c = await handler(evento('IntentRequest', 'AMAZON.CancelIntent'));
    assert.equal(c.response.shouldEndSession, true);
    assert.equal(st.corpi.length, 0, 'nessuna richiesta inoltrata');
  } finally { srv.close(); }
});
test('lambda: server che non risponde → invito a riprovare entro il tempo limite (nessun blocco)', async () => {
  const { srv, st, url } = await finto(); st.modo = 'lento';
  try {
    const { handler } = carica(url, { timeoutMs: 400 });
    const t0 = Date.now(), r = await handler(evento('IntentRequest', 'PartenzeIntent'));
    assert.ok(Date.now() - t0 < 2000, 'troppo lenta');
    assert.match(voce(r), /si sta svegliando/i); assert.equal(r.response.shouldEndSession, false);
    assert.deepEqual(r.sessionAttributes, { ctx: 1 }, 'il contesto della conversazione si conserva');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});
test('lambda: 503/502 → riprova; 401 → problema di configurazione; 500 → messaggio generico; mai testo tecnico', async () => {
  const { srv, st, url } = await finto();
  try {
    const { handler } = carica(url);
    for (const [codice, atteso] of [['503', /svegliando/], ['502', /svegliando/], ['401', /configurazione/], ['500', /Non riesco a leggere i dati/]]) {
      st.modo = codice;
      const r = await handler(evento('IntentRequest', 'MareaIntent'));
      assert.match(voce(r), atteso, codice);
      assert.doesNotMatch(voce(r), /HTTP|http|Error|undefined|token|Bearer/);
    }
  } finally { srv.close(); }
});
test('lambda: server irraggiungibile → riprova; senza configurazione → messaggio chiaro; ID skill diverso → rifiutata', async () => {
  const { handler } = carica('http://127.0.0.1:1/api/alexa');
  assert.match(voce(await handler(evento('IntentRequest', 'MareaIntent'))), /svegliando/);
  const h2 = carica('', { token: '' }).handler;
  assert.match(voce(await h2(evento('IntentRequest', 'MareaIntent'))), /non è ancora configurata/);
  const { srv, st, url } = await finto();
  try {
    const h3 = carica(url, { skillId: 'amzn1.ask.skill.ALTRA' }).handler;
    assert.match(voce(await h3(evento('IntentRequest', 'MareaIntent'))), /non valida/);
    assert.equal(st.corpi.length, 0);
  } finally { srv.close(); }
});
test('lambda: SessionEnded e richiesta vuota non provocano errori', async () => {
  const { handler } = carica('http://127.0.0.1:1/x');
  assert.deepEqual((await handler(evento('SessionEndedRequest'))).response, {});
  assert.match(voce(await handler({})), /Non ho capito/);
});
