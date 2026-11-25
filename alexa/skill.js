'use strict';
// SKILLA ALEXA «Venezia TPL»: riceve la richiesta di Alexa (JSON), sceglie il gestore, costruisce la risposta (SSML + scheda APL).
// Nessuna persistenza: tutto il contesto del dialogo sta negli attributi di sessione, che Alexa restituisce a ogni turno e dimentica a fine
// sessione. Nessun identificativo (utente, dispositivo) viene letto, registrato o salvato; nessuna frase pronunciata viene scritta nei log.
const P = require('./parlato');
const L = require('./luoghi');
const T = require('./tempo');
const U = require('./util');
const Ctx = require('./contesto');
const APL = require('./apl');
const D = require('./partenze');
const I = require('./itinerari');
const M = require('./marea');
const S = require('./servizio');
const R = require('./riepilogo');

const MAX_SSML = 6500;          // limite Alexa 8000 caratteri: margine per i tag
const MAX_ATTRIBUTI = 9000;     // byte di sessione: oltre, si tiene solo lo stretto necessario
const TOLLERANZA_MS = 150e3;    // Amazon: richieste con marca temporale più vecchia di 150 s = rifiutate

const AIUTO = 'Puoi chiedermi le prossime partenze, per esempio: quando passa il due alle Zattere. Oppure un percorso: come arrivo a Rialto da Piazzale Roma. Oppure la marea, il MOSE, gli avvisi di servizio o il riepilogo della mattina. Cosa vuoi sapere?';
const BENVENUTO = 'Venezia T P L, un servizio indipendente, non ufficiale A C T V. Chiedimi partenze, percorsi, marea o avvisi. Per esempio: quando passa il due alle Zattere?';

// ---- risposta ----
const ssml = inner => `<speak>${inner}</speak>`;
function limita(v) {
  if (v.length <= MAX_SSML) return v;
  const cut = v.slice(0, MAX_SSML), p = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
  return (p > 500 ? cut.slice(0, p + 1) : cut.replace(/<[^>]*$/, '').replace(/\s+\S*$/, '')) + ' Il resto è nella scheda.';
}
function risposta(env, { voce, reprompt = null, fine = true, scheda = null, attributi = {} }) {
  voce = limita(voce);
  const out = { version: '1.0', sessionAttributes: stringaOk(attributi), response: { outputSpeech: { type: 'SSML', ssml: ssml(voce) }, shouldEndSession: !!fine } };
  if (!fine) out.response.reprompt = { outputSpeech: { type: 'SSML', ssml: ssml(P.esc(reprompt || 'Cosa vuoi sapere?')) } };
  if (scheda) { const d = APL.direttiva(scheda, env); if (d) out.response.directives = [d]; }
  return out;
}
function stringaOk(a) {
  let s = JSON.stringify(a);
  if (s.length > MAX_ATTRIBUTI) { const { ultimo, ...resto } = a; s = JSON.stringify(resto); if (s.length > MAX_ATTRIBUTI) return {}; return resto; }
  return a;
}

// ---- slot ----
function slot(intent, nome) {
  const s = intent && intent.slots && intent.slots[nome]; if (!s) return null;
  const rs = s.resolutions && s.resolutions.resolutionsPerAuthority;
  const ok = rs && rs.find(a => a.status && a.status.code === 'ER_SUCCESS_MATCH');
  const v = ok && ok.values && ok.values[0] && ok.values[0].value;
  const raw = s.value != null && String(s.value).trim() ? String(s.value).trim() : null;
  if (!raw && !v) return null;
  return { raw, id: v ? v.id : null, nome: v ? v.name : null };
}
const testoSlot = (intent, nome) => { const s = slot(intent, nome); return s ? (s.nome || s.raw) : null; };
const MEZZI = { nav: 'nav', aut: 'aut', tram: 'aut', bus: 'aut' };
const mezzoDa = (intent) => { const s = slot(intent, 'mezzo'); if (!s) return null; return MEZZI[s.id] || MEZZI[String(s.raw || '').toLowerCase()] || null; };
const lineaDa = (intent) => { const s = slot(intent, 'linea'); if (!s) return null; return L.parseLinea(s.id || s.nome || s.raw || ''); };
const quandoDa = (C, intent, entro = false) => T.quando({ data: slot(intent, 'data')?.raw, ora: slot(intent, 'ora')?.raw, adesso: C.adesso(), entro });
// «oggi» detto senza ora = il resto della giornata (per marea e avvisi)
function quandoGiorno(C, intent) {
  const q = quandoDa(C, intent), d = slot(intent, 'data')?.raw;
  if (q.adesso && d && T.risolviData(d)) return { adesso: false, ymd: q.ymd, secs: 0, hhmm: '00:00', conOra: false, oggi: q.ymd, tipoData: 'giorno' };
  return q;
}
const prefDa = (intent) => { const s = slot(intent, 'preferenza'); const v = (s && (s.id || s.raw) || '').toLowerCase(); return v === 'veloce' || v === 'cambi' || v === 'piedi' ? v : null; };

// ---- luoghi: risoluzione, ambiguità, dati mancanti ----
const CAMPI = { luogo: 'la fermata', da: 'la partenza', a: 'la destinazione', dir: 'la direzione' };
const DOMANDE = {
  partenze: 'Da quale fermata?', ritardo: 'Di quale linea o fermata?', ultima: 'Da quale fermata?', stivali: null, passerelle: null,
  itinerario: { da: 'Da dove parti?', a: 'Dove vuoi andare?' }
};
function risolviCampo(C, req, campo) {
  const v = req[campo]; if (v == null) return { ok: null };
  if (typeof v === 'object' && v.chiave) { const g = C.luoghi.gruppoPerChiave(v.chiave); return g ? { ok: g } : { nessuno: v.chiave }; }
  const r = C.luoghi.cerca(String(v), { mezzo: req.mezzo || null });
  if (r.ok) return { ok: r.ok };
  if (r.ambiguo) return { ambiguo: r.ambiguo.slice(0, 4) };
  return { nessuno: String(v) };
}
function elencoOpzioni(g) { return P.elenco(g.map(x => x.parlato)); }

// ---- esecuzione di una richiesta ----
// req: { tipo, luogo|da|a|dir (testo o {chiave}), linea, mezzo, quando, cambi, pref, indice, off, ... }
async function esegui(C, env, req, att) {
  const tipo = req.tipo;
  const campiNecessari = { partenze: ['luogo'], ultima: ['luogo'], itinerario: ['da', 'a'], ritardo: [], stivali: [], passerelle: [], avvisi: [] }[tipo] || [];
  const gruppi = {};
  for (const campo of ['luogo', 'da', 'a']) {
    if (req[campo] == null) continue;
    const r = risolviCampo(C, req, campo);
    if (r.ambiguo) {
      att.pend = { req: { ...req, [campo]: undefined }, campo, opzioni: r.ambiguo.map(g => g.chiave) };
      const v = `Ho trovato più fermate: ${elencoOpzioni(r.ambiguo)}. Quale intendi? Puoi dire il nome, oppure il numero, da uno a ${P.parole(r.ambiguo.length)}.`;
      return { voce: P.esc(v).replace(/&apos;/g, "'"), reprompt: `Quale intendi? ${elencoOpzioni(r.ambiguo)}.`, fine: false, attributi: att, pendente: true };
    }
    if (r.nessuno) {
      att.pend = { req: { ...req, [campo]: undefined }, campo };
      const v = `Non conosco la fermata «${P.senzaTag(String(r.nessuno)).slice(0, 40)}». Prova con un altro nome, per esempio una fermata vicina.`;
      return { voce: P.esc(v), reprompt: 'Dimmi un altro nome.', fine: false, attributi: att, pendente: true };
    }
    gruppi[campo] = r.ok;
  }
  for (const campo of campiNecessari) {
    if (!gruppi[campo]) {
      att.pend = { req: { ...req }, campo };
      const dom = typeof DOMANDE[tipo] === 'object' ? DOMANDE[tipo][campo] : DOMANDE[tipo];
      return { voce: P.esc(dom), reprompt: dom, fine: false, attributi: att, pendente: true };
    }
  }
  if (tipo === 'ritardo' && !req.linea && !gruppi.luogo) {
    att.pend = { req: { ...req }, campo: 'lineaOLuogo' };
    return { voce: P.esc('Di quale linea o fermata?'), reprompt: 'Di quale linea o fermata?', fine: false, attributi: att, pendente: true };
  }
  delete att.pend;
  const mezzo = req.mezzo || null;
  let r;
  switch (tipo) {
    case 'partenze': r = await D.partenze(C, { gruppo: gruppi.luogo, linea: req.linea || null, mezzo, dir: req.dirTesto || null, dirNome: req.dirTesto || null, off: req.off || 0, quando: req.quando || null }); break;
    case 'ritardo': r = await D.ritardo(C, { gruppo: gruppi.luogo || null, linea: req.linea || null, mezzo }); break;
    case 'ultima': r = await D.ultima(C, { gruppo: gruppi.luogo, linea: req.linea || null, mezzo, dir: req.dirTesto || null }); break;
    case 'itinerario': r = await I.itinerario(C, { da: gruppi.da, a: gruppi.a, quando: req.quando || null, mezzo, cambi: req.cambi ?? null, pref: req.pref || null, indice: req.indice || 0 }); break;
    case 'marea': r = await M.marea(C); break;
    case 'colmo': r = await M.colmo(C); break;
    case 'acquaalta': r = await M.acquaAlta(C, { quando: req.quando || null }); break;
    case 'mose': r = await M.mose(C); break;
    case 'stivali': r = await M.stivali(C, { gruppo: gruppi.luogo || null }); break;
    case 'passerelle': r = await M.passerelle(C, { gruppo: gruppi.luogo || null }); break;
    case 'avvisi': r = await S.avvisi(C, { linea: req.linea || null, gruppo: gruppi.luogo || null, dataRichiesta: req.dataRichiesta || null, soloSciopero: !!req.soloSciopero, tutti: !!req.tutti }); break;
    case 'riepilogo': r = await R.riepilogo(C, { momento: req.momento || null, gruppo: gruppi.luogo || null }); break;
    default: return { voce: P.esc('Non ho capito.'), fine: false, attributi: att };
  }
  // contesto per i seguiti: la richiesta (testo o chiavi) e ciò che è stato detto
  att.ctx = { ...(r.ctx || {}), req: richiestaCompatta(req, gruppi) };
  att.ultimo = r.voce;
  const reprompt = r.reprompt || (r.vuoto ? 'Vuoi provare con altro?' : null);
  return { voce: r.voce, scheda: r.scheda || null, reprompt, fine: !reprompt, attributi: att };
}
function richiestaCompatta(req, gruppi) {
  const o = { tipo: req.tipo };
  for (const k of ['luogo', 'da', 'a']) if (gruppi[k]) o[k] = { chiave: gruppi[k].chiave };
  for (const k of ['linea', 'mezzo', 'cambi', 'pref', 'indice', 'quando', 'dirTesto', 'dataRichiesta', 'soloSciopero', 'momento']) if (req[k] != null) o[k] = req[k];
  return o;
}

// ---- gestori per intento ----
const QUANDO_SERIALE = q => (q && !q.adesso ? { adesso: false, ymd: q.ymd, secs: q.secs, hhmm: q.hhmm, conOra: q.conOra, fascia: q.fascia, nomeFascia: q.nomeFascia, tipoData: q.tipoData, entro: !!q.entro, oggi: q.oggi } : null);

function richiestaDa(C, intent, nome, att) {
  const luogo = testoSlot(intent, 'luogo'), da = testoSlot(intent, 'partenza'), a = testoSlot(intent, 'arrivo'), dir = testoSlot(intent, 'direzione');
  const linea = lineaDa(intent), mezzo = mezzoDa(intent);
  const entro = /Entro/.test(nome);
  switch (nome) {
    case 'PartenzeIntent': return { tipo: 'partenze', luogo, linea, mezzo, dirTesto: dir, quando: QUANDO_SERIALE(quandoDa(C, intent)) };
    case 'RitardoIntent': return { tipo: 'ritardo', luogo, linea, mezzo };
    case 'UltimaCorsaIntent': return { tipo: 'ultima', luogo, linea, mezzo, dirTesto: dir };
    case 'ItinerarioIntent': case 'ItinerarioEntroIntent': {
      const q = quandoDa(C, intent, entro && !!slot(intent, 'ora'));
      const c = slot(intent, 'cambi'); const nc = c && c.raw != null && /^\d+$/.test(c.raw) ? +c.raw : null;
      return { tipo: 'itinerario', da, a, mezzo, quando: QUANDO_SERIALE(q), cambi: nc, pref: prefDa(intent) };
    }
    case 'MareaIntent': return { tipo: 'marea' };
    case 'ColmoIntent': return { tipo: 'colmo' };
    case 'AcquaAltaIntent': return { tipo: 'acquaalta', quando: QUANDO_SERIALE(quandoGiorno(C, intent)) };
    case 'MoseIntent': return { tipo: 'mose' };
    case 'StivaliIntent': return { tipo: 'stivali', luogo };
    case 'PasserelleIntent': return { tipo: 'passerelle', luogo };
    case 'AvvisiIntent': return { tipo: 'avvisi', luogo, linea, dataRichiesta: slot(intent, 'data')?.raw || null };
    case 'ScioperoIntent': return { tipo: 'avvisi', linea, soloSciopero: true, dataRichiesta: slot(intent, 'data')?.raw || null };
    case 'RiepilogoIntent': return { tipo: 'riepilogo', luogo, momento: /mattina/i.test(String(slot(intent, 'momento')?.raw || '')) ? 'mattina' : null };
    default: return null;
  }
}

// seguiti: modificano l'ultima richiesta
async function seguito(C, env, intent, att, nome) {
  const c = att.ctx && att.ctx.req;
  const manca = () => ({ voce: P.esc('Prima dimmi cosa cerchi, per esempio: quando passa il due alle Zattere.'), reprompt: 'Cosa vuoi sapere?', fine: false, attributi: att });
  if (!c) return manca();
  const req = { ...c };
  if (nome === 'AMAZON.NextIntent' || nome === 'AltreCorseIntent') {
    if (c.tipo === 'partenze') { req.off = att.ctx.off || 0; return esegui(C, env, req, att); }
    if (c.tipo === 'itinerario') { req.indice = (att.ctx.indice || 1); return esegui(C, env, req, att); }
    if (c.tipo === 'avvisi') { req.tutti = true; return esegui(C, env, req, att); }
    return { voce: P.esc('Non ho altro da aggiungere. Chiedimi pure qualcos\'altro.').replace(/&apos;/g, "'"), reprompt: 'Cosa vuoi sapere?', fine: false, attributi: att };
  }
  if (nome === 'RitornoIntent') {
    if (c.tipo === 'itinerario') { [req.da, req.a] = [req.a, req.da]; req.indice = 0; return esegui(C, env, req, att); }
    return { voce: P.esc('Per il ritorno dimmi da dove parti e dove vai, per esempio: come arrivo a Piazzale Roma da Rialto.'), reprompt: 'Da dove parti e dove vai?', fine: false, attributi: att };
  }
  if (nome === 'DomaniIntent') {
    const q = T.quando({ data: slot(intent, 'data')?.raw || addGiorni(C, 1), ora: slot(intent, 'ora')?.raw || (c.quando && c.quando.conOra ? c.quando.hhmm : null), adesso: C.adesso(), entro: !!(c.quando && c.quando.entro) });
    if (['partenze', 'itinerario', 'ultima'].includes(c.tipo)) { req.quando = QUANDO_SERIALE(q); req.indice = 0; req.off = 0; if (c.tipo === 'ultima') return { voce: P.esc('Per le ultime corse di domani non posso dirti di più: gli orari programmati cambiano giorno per giorno. Chiedimi le partenze di domani sera.'), fine: false, reprompt: 'Cosa vuoi sapere?', attributi: att }; return esegui(C, env, req, att); }
    if (['acquaalta'].includes(c.tipo)) { req.quando = QUANDO_SERIALE(quandoGiornoDa(C, slot(intent, 'data')?.raw || addGiorni(C, 1))); return esegui(C, env, req, att); }
    if (c.tipo === 'avvisi') { req.dataRichiesta = slot(intent, 'data')?.raw || addGiorni(C, 1); return esegui(C, env, req, att); }
    if (['marea', 'colmo', 'mose', 'stivali'].includes(c.tipo)) { req.tipo = 'acquaalta'; req.quando = QUANDO_SERIALE(quandoGiornoDa(C, addGiorni(C, 1))); return esegui(C, env, req, att); }
    return manca();
  }
  if (nome === 'SenzaCambiIntent') {
    if (c.tipo !== 'itinerario') return manca();
    req.cambi = 0; req.indice = 0; return esegui(C, env, req, att);
  }
  if (nome === 'AlternativaIntent') {
    if (c.tipo !== 'itinerario') return manca();
    const pref = prefDa(intent);
    if (pref) { req.pref = pref; req.indice = 0; req.cambi = pref === 'cambi' ? null : req.cambi ?? null; } else req.indice = att.ctx.indice || 1;
    return esegui(C, env, req, att);
  }
  return manca();
}
const addGiorni = (C, n) => { const d = T.adessoRoma(C.adesso()).ymd; const y = +d.slice(0, 4), m = +d.slice(4, 6) - 1, g = +d.slice(6, 8), dt = new Date(Date.UTC(y, m, g + n)); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`; };
const quandoGiornoDa = (C, data) => { const q = T.quando({ data, ora: null, adesso: C.adesso() }); return q.adesso && T.risolviData(data) ? { adesso: false, ymd: q.ymd, secs: 0, hhmm: '00:00', conOra: false, oggi: q.ymd, tipoData: 'giorno' } : q; };

// risposta dell'utente a una domanda in sospeso (fermata mancante o ambigua)
async function rispostaInSospeso(C, env, intent, att, nome) {
  const pend = att.pend; if (!pend) return null;
  let testo = null;
  if (nome === 'LuogoIntent') testo = testoSlot(intent, 'luogo');
  else if (nome === 'SceltaIntent') {
    const n = slot(intent, 'numero') || slot(intent, 'ordinale'), v = n ? (n.id || n.raw) : null, i = v != null && /^\d+$/.test(String(v)) ? +v : null;
    if (pend.opzioni && i && i >= 1 && i <= pend.opzioni.length) return esegui(C, env, { ...pend.req, [pend.campo]: { chiave: pend.opzioni[i - 1] } }, att);
    return { voce: P.esc(`Dimmi un numero da uno a ${P.parole((pend.opzioni || []).length || 1)}, oppure il nome della fermata.`), reprompt: 'Quale intendi?', fine: false, attributi: att };
  } else if (nome === 'PartenzeIntent' || nome === 'ItinerarioIntent') testo = null;   // nuova richiesta completa: vince
  if (!testo) return null;
  if (pend.campo === 'lineaOLuogo') {
    const ln = L.parseLinea(testo);
    if (ln && L.infoLinea(C.routes, ln).length) return esegui(C, env, { ...pend.req, linea: ln }, att);
    return esegui(C, env, { ...pend.req, luogo: testo }, att);
  }
  return esegui(C, env, { ...pend.req, [pend.campo]: testo }, att);
}

// intenti propri equivalenti ai predefiniti (non dipendono dal supporto dei predefiniti nella lingua)
const ALIAS_INTENTI = { RipetiIntent: 'AMAZON.RepeatIntent', ProssimoIntent: 'AMAZON.NextIntent', ConfermaIntent: 'AMAZON.YesIntent', RifiutoIntent: 'AMAZON.NoIntent' };

// richieste contemporanee (il server gratuito ha 512 MB e una CPU ridotta: la skill non deve toglierli a mappa e notifiche)
const MAX_CONTEMPORANEE = 6; let inCorso = 0;

// ---- punto d'ingresso ----
// env: { call, stops, routes, versione?, adesso?, skillId?, verificaApplicationId? }
async function gestisci(envelope, ambiente) {
  inCorso++;
  try { return await gestisciInterna(envelope, ambiente); } finally { inCorso--; }
}
async function gestisciInterna(envelope, ambiente) {
  const adesso = ambiente.adesso || Date.now;
  const rich = envelope && envelope.request;
  if (!envelope || envelope.version !== '1.0' || !rich || typeof rich.type !== 'string') return { status: 400 };
  if (ambiente.skillId) { const id = envelope.session?.application?.applicationId || envelope.context?.System?.application?.applicationId; if (id !== ambiente.skillId) return { status: 403 }; }
  const ts = Date.parse(rich.timestamp);
  if (!Number.isFinite(ts) || Math.abs(adesso() - ts) > TOLLERANZA_MS) return { status: 400 };
  const att = { ...(envelope.session && envelope.session.attributes || {}) };
  delete att.errori;
  if (rich.type === 'IntentRequest' && (inCorso > MAX_CONTEMPORANEE || (ambiente.occupato && ambiente.occupato()))) return { status: 200, body: risposta(envelope, { voce: P.esc(U.erroreParlato({ code: 503 })), reprompt: 'Vuoi riprovare?', fine: false, attributi: att }) };
  if (rich.type === 'SessionEndedRequest') return { status: 200, body: { version: '1.0', response: {} } };
  const locale = String(rich.locale || 'it-IT');
  if (!/^it(-|$)/i.test(locale)) return { status: 200, body: risposta(envelope, { voce: P.esc('Questa skill funziona solo in italiano.'), fine: true }) };
  if (rich.type === 'LaunchRequest') return { status: 200, body: risposta(envelope, { voce: P.esc(BENVENUTO), reprompt: 'Cosa vuoi sapere?', fine: false, attributi: {} }) };
  if (rich.type !== 'IntentRequest' || !rich.intent) return { status: 200, body: risposta(envelope, { voce: P.esc('Non ho capito.'), fine: true }) };
  const intent = rich.intent, nome = ALIAS_INTENTI[String(intent.name || '')] || String(intent.name || '');
  let C;
  try { C = await Ctx.crea({ ...ambiente, adesso }); }
  catch (e) { return { status: 200, body: risposta(envelope, { voce: P.esc(U.erroreParlato(e)), fine: true, attributi: att }) }; }
  try {
    let out = null;
    if (nome === 'AMAZON.StopIntent' || nome === 'AMAZON.CancelIntent' || nome === 'AMAZON.NavigateHomeIntent' || nome === 'AMAZON.NoIntent') return { status: 200, body: risposta(envelope, { voce: P.esc('A presto!'), fine: true }) };
    if (nome === 'AMAZON.HelpIntent') out = { voce: P.esc(AIUTO), reprompt: 'Cosa vuoi sapere?', fine: false, attributi: att };
    else if (nome === 'AMAZON.RepeatIntent') out = att.ultimo ? { voce: att.ultimo, reprompt: 'Vuoi altro?', fine: false, attributi: att } : { voce: P.esc('Non ho niente da ripetere. Cosa vuoi sapere?'), reprompt: 'Cosa vuoi sapere?', fine: false, attributi: att };
    else if (nome === 'AMAZON.YesIntent') out = { voce: P.esc('Dimmi pure cosa vuoi sapere.'), reprompt: 'Cosa vuoi sapere?', fine: false, attributi: att };
    else if (['AMAZON.NextIntent', 'AltreCorseIntent', 'RitornoIntent', 'DomaniIntent', 'SenzaCambiIntent', 'AlternativaIntent'].includes(nome)) out = await seguito(C, envelope, intent, att, nome);
    else if (nome === 'LuogoIntent' || nome === 'SceltaIntent') {
      out = await rispostaInSospeso(C, envelope, intent, att, nome);
      if (!out && nome === 'LuogoIntent') out = await esegui(C, envelope, { tipo: 'partenze', luogo: testoSlot(intent, 'luogo') }, att);   // un nome detto da solo = partenze da lì
      if (!out) out = { voce: P.esc('Non ho capito. ' + AIUTO), reprompt: 'Cosa vuoi sapere?', fine: false, attributi: att };
    } else if (nome === 'AMAZON.FallbackIntent') {
      const n = (att.fallback || 0) + 1; att.fallback = n;
      out = { voce: P.esc(n >= 2 ? 'Scusa, non ho ancora capito. Prova a dire: partenze dalle Zattere, oppure: com\'è la marea.' : 'Non ho capito. Puoi chiedermi partenze, percorsi, marea o avvisi.').replace(/&apos;/g, "'"), reprompt: 'Cosa vuoi sapere?', fine: false, attributi: att };
    } else {
      const req = richiestaDa(C, intent, nome, att);
      if (!req) out = { voce: P.esc('Non ho capito. ' + AIUTO), reprompt: 'Cosa vuoi sapere?', fine: false, attributi: att };
      else { delete att.pend; out = await esegui(C, envelope, req, att); }
    }
    if (out && nome !== 'AMAZON.FallbackIntent') delete att.fallback;
    return { status: 200, body: risposta(envelope, { ...out, attributi: out.attributi || att }) };
  } catch (e) {
    return { status: 200, body: risposta(envelope, { voce: P.esc(U.erroreParlato(e)), reprompt: 'Vuoi riprovare?', fine: false, attributi: att }) };
  }
}

module.exports = { gestisci, slot, richiestaDa, BENVENUTO, AIUTO, TOLLERANZA_MS };
