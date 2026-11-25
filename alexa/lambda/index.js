'use strict';
// FUNZIONE LAMBDA DI ALEXA-HOSTED (gratuita, nessun account AWS, nessuna carta): fa solo da ponte verso il server Render.
// Alexa → questa funzione → POST https://veneziatpl.onrender.com/api/alexa → risposta ad Alexa. Nessuna logica di dominio qui.
//  · Privacy: prima dell'inoltro si tolgono tutti gli identificativi (utente, dispositivo, sessione, token di accesso): il server non li vede.
//    Il token per la risposta progressiva («Sto controllando gli orari») resta qui, in memoria, e non va a Render.
//  · Nessun log del contenuto delle richieste (solo la categoria dell'errore).
//  · Benvenuto, presentazione, aiuto e chiusura sono risposti qui: funzionano anche se Render non risponde.
//  · Se il server non risponde in tempo, la richiesta resta nella sessione: «riprova» o «sì» la ripetono identica.
// Il segreto (indirizzo, token, ID della skill) sta in segreto.js: NON è nel repository (vedi segreto.esempio.js).
const https = require('https');
const http = require('http');

let segreto = {};
try { segreto = require('./segreto'); } catch (e) { /* senza segreto.js: risposta di cortesia */ }

const TIMEOUT_MS = Number(process.env.TPL_TIMEOUT_MS || segreto.timeoutMs || 6500);   // Alexa attende ~8 s in tutto (la risposta progressiva non lo allunga)
const PROGRESSIVA_MS = Number(process.env.TPL_PROGRESSIVA_MS || 1200);               // «Sto controllando gli orari» solo se il server tarda

// ==MESSAGGI== copia generata da alexa/messaggi.js con `node alexa/scripts/prepara-lambda.js`: non modificare a mano
const M = {"benvenuto":"Ciao! Cosa vuoi sapere?","cosaVuoi":"Cosa vuoi sapere?","aiuto":"Puoi chiedermi partenze, percorsi, marea o avvisi. Su cosa vuoi una mano?","aiutoRiprompt":"Dimmi: partenze, percorsi, marea, avvisi o riepilogo.","presentazione":"Sono Venezia TPL, un servizio indipendente di informazioni sui trasporti e sulla marea di Venezia. Non sono un servizio ufficiale ACTV. Uso gli orari e il tempo reale pubblicati da ACTV e i dati delle maree del Comune di Venezia.","aiutoCategoria":{"partenze":"Puoi dire: quando passa il due alle Zattere? Oppure: qual è l'ultimo vaporetto da Rialto a Piazzale Roma?","percorsi":"Prova a dire: come arrivo a Rialto da Piazzale Roma? Oppure: quando devo partire per arrivare a Rialto entro le nove?","marea":"Puoi chiedermi il livello attuale, il prossimo colmo, il MOSE o la previsione di acqua alta.","avvisi":"Puoi chiedere: ci sono problemi sulla linea uno? Oppure: ci sono scioperi domani?","riepilogo":"Dimmi: riepilogo della mattina da Zattere, con la tua fermata. Puoi usare questa frase anche in una routine dell'app Alexa."},"tuttiComandi":"Posso spiegarti una categoria alla volta: partenze, percorsi, marea, avvisi o riepilogo. Quale vuoi? La guida completa è nell'app Venezia TPL, nella pagina Informazioni.","chiusura":"A presto!","nonCapito":"Non ho capito. Dimmi una fermata, oppure chiedimi la marea.","nonCapitoAncora":"Scusa, non ho ancora capito. Prova a dire: quando passa il due alle Zattere? Oppure: com'è la marea?","nonSupportato":"Questa funzione è disponibile nell'app, ma non ancora a voce.","origineMancante":"Da quale fermata parti?","destinazioneMancante":"Dove vuoi arrivare?","fermataMancante":"Da quale fermata?","lineaOFermata":"Di quale linea o fermata?","giornoMancante":"Per quale giorno?","contestoAssente":"A quale fermata o percorso ti riferisci?","nienteDaRipetere":"Non ho niente da ripetere. Cosa vuoi sapere?","soloItaliano":"Questa skill funziona solo in italiano.","progressiva":"Sto controllando gli orari.","caricamento":"Sto caricando gli orari di {giorno}. Vuoi riprovare tra poco?","caricamentoAncora":"Gli orari di {giorno} non sono ancora pronti. Riprova tra poco.","nonRisponde":"Il servizio non risponde ancora. Riprova tra poco.","occupato":"Il servizio è momentaneamente occupato. Riprova tra poco.","datiIncompleti":"Non riesco a leggere tutti i dati in questo momento.","configurazione":"Il servizio ha un problema di configurazione.","nonConfigurata":"La skill non è ancora configurata.","richiestaNonValida":"Richiesta non valida.","nessunaRichiesta":"Non ho una richiesta da ripetere. Cosa vuoi sapere?","vuoiRiprovare":"Vuoi riprovare?"};
// ==FINE MESSAGGI==

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const ssml = t => ({ type: 'SSML', ssml: `<speak>${esc(t)}</speak>` });
const risposta = (testo, { fine = true, reprompt = null, attributi = {} } = {}) => ({
  version: '1.0', sessionAttributes: attributi,
  response: { outputSpeech: ssml(testo), ...(fine ? {} : { reprompt: { outputSpeech: ssml(reprompt || M.cosaVuoi) } }), shouldEndSession: fine }
});

// intenti risposti qui (anche con il server irraggiungibile)
const CHIUSURA = ['AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent', 'RifiutoIntent', 'AMAZON.NoIntent'];
const LOCALI = ['AMAZON.HelpIntent', 'AiutoIntent', 'PresentatiIntent', 'TuttiComandiIntent'];
// intenti che leggono orari (risposta progressiva se il server tarda)
const ORARI = ['PartenzeIntent', 'ProssimaCorsaIntent', 'UltimaCorsaIntent', 'PrimaCorsaIntent', 'ItinerarioIntent', 'ItinerarioEntroIntent', 'LineeIntent', 'RiepilogoIntent', 'DomaniIntent', 'ProssimoIntent', 'AltreCorseIntent', 'AggiornaIntent', 'RiprovaIntent'];
const RIPETI = ['RiprovaIntent', 'AMAZON.YesIntent', 'ConfermaIntent'];

function valoreSlot(intent, nome) {
  const s = intent && intent.slots && intent.slots[nome]; if (!s) return null;
  const rs = s.resolutions && s.resolutions.resolutionsPerAuthority, ok = rs && rs.find(a => a.status && a.status.code === 'ER_SUCCESS_MATCH');
  return (ok && ok.values && ok.values[0] && ok.values[0].value && ok.values[0].value.id) || (s.value ? String(s.value).toLowerCase() : null);
}
function locale(nome, intent, attrs) {
  if (nome === 'PresentatiIntent') return risposta(M.presentazione, { fine: false, reprompt: M.cosaVuoi, attributi: attrs });
  if (nome === 'TuttiComandiIntent') return risposta(M.tuttiComandi, { fine: false, reprompt: M.aiutoRiprompt, attributi: attrs });
  const cat = nome === 'AiutoIntent' ? valoreSlot(intent, 'categoria') : null;
  if (cat && M.aiutoCategoria[cat]) return risposta(M.aiutoCategoria[cat], { fine: false, reprompt: M.cosaVuoi, attributi: attrs });
  return risposta(M.aiuto, { fine: false, reprompt: M.aiutoRiprompt, attributi: attrs });
}

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
    const req = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', 'Content-Length': dati.length, Authorization: 'Bearer ' + segreto.token, 'User-Agent': 'venezia-tpl-alexa/2' } }, res => {
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
// sveglia Render all'apertura (senza attendere: il benvenuto non deve tardare)
function sveglia() {
  try {
    const u = new URL(segreto.url), lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({ method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: '/healthz', timeout: 2500 }, res => res.resume());
    req.on('timeout', () => req.destroy()); req.on('error', () => {}); req.end();
  } catch (e) { /* nessun indirizzo: niente da svegliare */ }
}
// risposta progressiva di Alexa (Progressive Response API): solo con l'endpoint e il token che Alexa manda in questa richiesta
function progressiva(event) {
  return new Promise(ok => {
    try {
      const sys = event.context && event.context.System, ep = sys && sys.apiEndpoint, tok = sys && sys.apiAccessToken, rid = event.request && event.request.requestId;
      if (!ep || !tok || !rid) return ok(false);
      const u = new URL('/v1/directives', ep), lib = u.protocol === 'http:' ? http : https;
      const dati = Buffer.from(JSON.stringify({ header: { requestId: rid }, directive: { type: 'VoicePlayer.Speak', speech: `<speak>${esc(M.progressiva)}</speak>` } }));
      const req = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname, timeout: 1500, headers: { 'Content-Type': 'application/json', 'Content-Length': dati.length, Authorization: 'Bearer ' + tok } }, res => { res.resume(); res.on('end', () => ok(res.statusCode === 204 || res.statusCode === 200)); });
      req.on('timeout', () => { req.destroy(); ok(false); }); req.on('error', () => ok(false)); req.end(dati);
    } catch (e) { ok(false); }
  });
}
// errore di inoltro -> frase (mai «si sta svegliando» se la causa non è nota)
function erroreInoltro(cat) {
  if (cat === 'http503' || cat === 'http429') return { testo: M.occupato, rifai: true };
  if (cat === 'timeout' || cat === 'rete' || cat === 'http502' || cat === 'http504') return { testo: M.nonRisponde, rifai: true };
  if (cat === 'http401' || cat === 'http403' || cat === 'http404' || cat === 'config') return { testo: M.configurazione, rifai: false, fine: true };
  return { testo: M.datiIncompleti, rifai: true };
}

exports.handler = async (event) => {
  const rich = event && event.request;
  if (!rich) return risposta(M.nonCapito);
  const attrs = Object.assign({}, (event.session && event.session.attributes) || {});
  // l'ID della skill, se configurato, deve coincidere (la piattaforma lo verifica già: difesa in più)
  if (segreto.skillId) { const id = (event.session && event.session.application && event.session.application.applicationId) || (event.context && event.context.System && event.context.System.application && event.context.System.application.applicationId); if (id !== segreto.skillId) return risposta(M.richiestaNonValida); }
  if (rich.type === 'SessionEndedRequest') return { version: '1.0', response: {} };
  if (rich.type === 'LaunchRequest') { sveglia(); return risposta(M.benvenuto, { fine: false, reprompt: M.cosaVuoi }); }
  const nome = rich.intent && rich.intent.name;
  if (rich.type === 'IntentRequest') {
    if (CHIUSURA.includes(nome)) return risposta(M.chiusura);
    if (LOCALI.includes(nome)) return locale(nome, rich.intent, attrs);
  }
  if (!segreto.url || !segreto.token) return risposta(M.nonConfigurata);
  // «riprova» / «sì» dopo un mancato inoltro: si ripete la stessa richiesta, con tutti i suoi parametri
  let ev = event;
  if (rich.type === 'IntentRequest' && RIPETI.includes(nome) && attrs.rifai && attrs.rifai.name) {
    ev = Object.assign({}, event, { request: Object.assign({}, rich, { intent: { name: attrs.rifai.name, slots: attrs.rifai.slots || {} } }), session: Object.assign({}, event.session, { attributes: Object.assign({}, attrs, { rifai: undefined }) }) });
    delete ev.session.attributes.rifai;
  } else if (attrs.rifai) { delete attrs.rifai; ev = Object.assign({}, event, { session: Object.assign({}, event.session, { attributes: attrs }) }); }
  const nomeEff = ev.request.intent && ev.request.intent.name;
  let timer = null;
  try {
    const p = inoltra(sanifica(ev));
    if (ORARI.includes(nomeEff)) timer = setTimeout(() => { timer = null; progressiva(event); }, PROGRESSIVA_MS);
    return await p;
  } catch (e) {
    const cat = (e && e.cat) || 'errore';
    console.log('inoltro non riuscito:', cat);          // solo la categoria: mai il contenuto della richiesta
    const er = erroreInoltro(cat), a = Object.assign({}, attrs);
    if (er.rifai && ev.request.intent) a.rifai = { name: ev.request.intent.name, slots: ev.request.intent.slots || {} };
    if (er.fine) return risposta(er.testo);
    return risposta(er.testo, { fine: false, reprompt: M.vuoiRiprovare, attributi: a });
  } finally { if (timer) clearTimeout(timer); }
};
exports._test = { sanifica, erroreInoltro, M: () => M };
