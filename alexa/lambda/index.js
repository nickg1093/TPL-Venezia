'use strict';
// FUNZIONE LAMBDA DI ALEXA-HOSTED (gratuita, nessun account AWS, nessuna carta): fa solo da ponte verso il server Render.
// Alexa → questa funzione → POST https://veneziatpl.onrender.com/api/alexa → risposta ad Alexa. Nessuna logica di dominio qui.
//  · Privacy: prima dell'inoltro si tolgono tutti gli identificativi (utente, dispositivo, sessione, token di accesso): il server non li vede.
//  · Nessun log del contenuto delle richieste (solo la categoria dell'errore).
//  · Avvio, Aiuto, Stop e Annulla sono gestiti qui: funzionano anche se Render è «addormentato». All'avvio si sveglia Render in anticipo.
//  · Render gratuito: dopo 15 minuti senza richieste si addormenta e riparte in ~30-50 s, più degli ~8 s concessi da Alexa. Se il server non
//    risponde in tempo, l'utente sente un invito a riprovare (la richiesta ha comunque avviato il risveglio).
// Il segreto (indirizzo, token, ID della skill) sta in segreto.js: NON è nel repository (vedi segreto.esempio.js).
const https = require('https');
const http = require('http');

let segreto = {};
try { segreto = require('./segreto'); } catch (e) { /* senza segreto.js: risposta di cortesia */ }

const TIMEOUT_MS = Number(process.env.TPL_TIMEOUT_MS || segreto.timeoutMs || 6000);   // Alexa attende ~8 s in tutto
const BENVENUTO = 'Venezia T P L, un servizio indipendente, non ufficiale A C T V. Chiedimi partenze, percorsi, marea o avvisi. Per esempio: quando passa il due alle Zattere?';
const AIUTO = 'Puoi chiedermi le prossime partenze, per esempio: quando passa il due alle Zattere. Oppure un percorso: come arrivo a Rialto da Piazzale Roma. Oppure la marea, il MOSE, gli avvisi di servizio o il riepilogo della mattina. Cosa vuoi sapere?';

const ssml = t => ({ type: 'SSML', ssml: `<speak>${t}</speak>` });
const risposta = (testo, { fine = true, reprompt = null, attributi = {} } = {}) => ({
  version: '1.0', sessionAttributes: attributi,
  response: { outputSpeech: ssml(testo), ...(fine ? {} : { reprompt: { outputSpeech: ssml(reprompt || 'Cosa vuoi sapere?') } }), shouldEndSession: fine }
});

// solo ciò che serve al server: nessun identificativo
function sanifica(ev) {
  const sys = (ev.context && ev.context.System) || {}, sess = ev.session || {};
  const out = {
    version: ev.version,
    session: { new: !!sess.new, attributes: sess.attributes || {}, application: { applicationId: (sess.application && sess.application.applicationId) || (sys.application && sys.application.applicationId) } },
    context: { System: { device: { supportedInterfaces: (sys.device && sys.device.supportedInterfaces) || {} } } },
    request: { type: ev.request.type, requestId: 'x', timestamp: ev.request.timestamp, locale: ev.request.locale }
  };
  if (ev.context && ev.context.Viewport) { const v = ev.context.Viewport; out.context.Viewport = { shape: v.shape, pixelWidth: v.pixelWidth, pixelHeight: v.pixelHeight, dpi: v.dpi }; }
  if (ev.request.intent) out.request.intent = { name: ev.request.intent.name, slots: ev.request.intent.slots || {} };
  return out;
}

function inoltra(corpo) {
  return new Promise((ok, ko) => {
    let u; try { u = new URL(segreto.url); } catch (e) { return ko(Object.assign(new Error('config'), { cat: 'config' })); }
    const lib = u.protocol === 'http:' ? http : https, dati = Buffer.from(JSON.stringify(corpo));
    const req = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', 'Content-Length': dati.length, Authorization: 'Bearer ' + segreto.token, 'User-Agent': 'venezia-tpl-alexa/1' } }, res => {
      const parti = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > 200000) { req.destroy(Object.assign(new Error('grande'), { cat: 'grande' })); } else parti.push(c); });
      res.on('end', () => {
        if (res.statusCode !== 200) return ko(Object.assign(new Error('http'), { cat: 'http' + res.statusCode }));
        try { ok(JSON.parse(Buffer.concat(parti).toString('utf8'))); } catch (e) { ko(Object.assign(new Error('json'), { cat: 'json' })); }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(Object.assign(new Error('timeout'), { cat: 'timeout' })));
    req.on('error', e => ko(e.cat ? e : Object.assign(new Error('rete'), { cat: 'rete' })));
    req.end(dati);
  });
}
// sveglia Render (richiesta leggera, senza attendere la risposta oltre pochi secondi)
function sveglia() {
  return new Promise(ok => {
    try {
      const u = new URL(segreto.url), lib = u.protocol === 'http:' ? http : https;
      const req = lib.request({ method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: '/healthz', timeout: 2500 }, res => { res.resume(); res.on('end', ok); });
      req.on('timeout', () => { req.destroy(); ok(); }); req.on('error', () => ok()); req.end();
    } catch (e) { ok(); }
  });
}

exports.handler = async (event) => {
  const rich = event && event.request;
  if (!rich) return risposta('Non ho capito.');
  const attrs = (event.session && event.session.attributes) || {};
  // l'ID della skill, se configurato, deve coincidere (la piattaforma lo verifica già: difesa in più)
  if (segreto.skillId) { const id = (event.session && event.session.application && event.session.application.applicationId) || (event.context && event.context.System && event.context.System.application && event.context.System.application.applicationId); if (id !== segreto.skillId) return risposta('Richiesta non valida.'); }
  if (rich.type === 'SessionEndedRequest') return { version: '1.0', response: {} };
  if (rich.type === 'LaunchRequest') { await sveglia(); return risposta(BENVENUTO, { fine: false, reprompt: 'Cosa vuoi sapere?' }); }
  const nome = rich.intent && rich.intent.name;
  if (rich.type === 'IntentRequest') {
    if (['AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent', 'RifiutoIntent', 'AMAZON.NoIntent'].includes(nome)) return risposta('A presto!');
    if (nome === 'AMAZON.HelpIntent') return risposta(AIUTO, { fine: false, reprompt: 'Cosa vuoi sapere?', attributi: attrs });
  }
  if (!segreto.url || !segreto.token) return risposta('La skill non è ancora configurata. Controlla il file segreto del server.');
  try {
    return await inoltra(sanifica(event));
  } catch (e) {
    const cat = (e && e.cat) || 'errore';
    console.log('inoltro non riuscito:', cat);          // solo la categoria: mai il contenuto della richiesta
    if (cat === 'timeout' || cat === 'rete' || cat === 'http502' || cat === 'http503' || cat === 'http504') return risposta('Il servizio si sta svegliando, ci mette qualche secondo. Riprova tra mezzo minuto.', { fine: false, reprompt: 'Riprova tra qualche secondo: cosa vuoi sapere?', attributi: attrs });
    if (cat === 'http401') return risposta('C\'è un problema di configurazione della skill. Avvisa chi gestisce il servizio.');
    return risposta('Non riesco a leggere i dati in questo momento. Riprova tra poco.', { fine: false, reprompt: 'Vuoi riprovare?', attributi: attrs });
  }
};
exports._test = { sanifica };
