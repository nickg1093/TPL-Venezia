'use strict';
// SKILL ALEXA «Venezia TPL»: riceve la richiesta di Alexa (JSON), sceglie il gestore, costruisce la risposta (SSML + scheda APL).
// Nessuna persistenza: tutto il contesto del dialogo sta negli attributi di sessione, che Alexa restituisce a ogni turno e dimentica a fine
// sessione. Nessun identificativo (utente, dispositivo) viene letto, registrato o salvato; nessuna frase pronunciata viene scritta nei log.
//
// Contesto strutturato (att.ctx): la richiesta completa (intento, luogo, destinazione, mezzo, linea, data, ora, quantità, preferenze) e le
// corse già dette (identità della corsa, non posizione nell'elenco). I seguiti («e quello dopo?», «e domani?», «e alle sette?», «no, verso
// Venezia», «solo vaporetti», «senza cambi», «e al ritorno?», «e l'ultimo?») cambiano SOLO il parametro detto; una domanda completa nuova
// sostituisce il contesto. Una richiesta non riuscita per caricamento o carico del server resta in att.riprova: «riprova» o «sì» la ripetono.
const P = require('./parlato');
const L = require('./luoghi');
const T = require('./tempo');
const U = require('./util');
const MSG = require('./messaggi');
const Ctx = require('./contesto');
const APL = require('./apl');
const D = require('./partenze');
const I = require('./itinerari');
const M = require('./marea');
const MT = require('./meteo');
const S = require('./servizio');
const R = require('./riepilogo');
const cal = require('../calendar');

const MAX_SSML = 6500;          // limite Alexa 8000 caratteri: margine per i tag
const MAX_ATTRIBUTI = 9000;     // byte di sessione: oltre, si tiene solo lo stretto necessario
const TOLLERANZA_MS = 150e3;    // Amazon: richieste con marca temporale più vecchia di 150 s = rifiutate
const BENVENUTO = MSG.benvenuto, AIUTO = MSG.aiuto;
// domanda finale: no (risposte brevi, microfono aperto per i seguiti). Per la certificazione dello store, se Amazon chiede una domanda
// esplicita quando la sessione resta aperta, basta mettere true: la domanda di riserva viene detta in coda.
const DOMANDA_FINALE = false;
const RIPROMPT = { frequenza: 'Vuoi sapere altro?', partenze: 'Vuoi la corsa successiva?', ultima: 'Vuoi sapere altro?', prima: 'Vuoi sapere altro?', itinerario: 'Vuoi i dettagli, o il ritorno?', avvisi: 'Vuoi sapere altro?' };

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
  if (!fine) out.response.reprompt = { outputSpeech: { type: 'SSML', ssml: ssml(P.esc(reprompt || MSG.cosaVuoi)) } };
  if (scheda) { const d = APL.direttiva(scheda, env); if (d) out.response.directives = [d]; }
  return out;
}
function stringaOk(a) {
  let s = JSON.stringify(a);
  if (s.length <= MAX_ATTRIBUTI) return a;
  const { ultimo, ...resto } = a; s = JSON.stringify(resto);
  if (s.length <= MAX_ATTRIBUTI) return resto;
  if (resto.ctx) { const { visti, ...c } = resto.ctx; resto.ctx = c; }
  return JSON.stringify(resto).length <= MAX_ATTRIBUTI ? resto : {};
}
const testo = (t, extra = {}) => ({ voce: P.esc(t), ...extra });

// ---- slot ----
function slot(intent, nome) {
  const s = intent && intent.slots && intent.slots[nome]; if (!s) return null;
  const rs = s.resolutions && s.resolutions.resolutionsPerAuthority;
  const ok = rs && rs.find(a => a.status && a.status.code === 'ER_SUCCESS_MATCH');
  const v = ok && ok.values && ok.values[0] && ok.values[0].value;
  const raw = s.value != null && String(s.value).trim() ? String(s.value).trim() : null;
  if (!raw && !v) return null;
  const alt = ok && ok.values ? ok.values.map(x => x.value).filter(Boolean) : [];
  return { raw, id: v ? v.id : null, nome: v ? v.name : null, alt };
}
// testo di un luogo: il nome risolto da Alexa, ma se l'utente ha detto anche il pontile o il numero («San Marco Cattaneo uno») si tiene ciò che ha detto
// Per una fermata conta l'identificativo risolto da Alexa (chiave del gruppo nei dati), salvo quando ciò che è stato detto contiene più
// parole del valore risolto (Alexa ha scelto un nome più corto: «San Marco Cattaneo» non è «San Marco») o un pontile/numero.
const nParole = s => L.normalizza(s).split(' ').filter(Boolean).length;
function testoSlot(intent, nome) {
  const s = slot(intent, nome); if (!s) return null;
  // un luogo speciale detto per intero («Venezia», «San Marco», «Lido») vale più dei valori di Alexa: per «Venezia» Alexa restituisce
  // solo alcune delle fermate del centro (al massimo cinque) e la prima non è per forza quella servita dal mezzo richiesto
  const sp = s.raw ? L.normalizza(s.raw) : '';
  if (sp && L.LUOGHI_SPECIALI[sp]) return nome === 'direzione' ? s.raw : { chiave: sp, testo: L.LUOGHI_SPECIALI[sp].nome };
  if (s.raw && etichettaDetta(s.raw)) return s.raw;
  if (s.raw && s.nome && nParole(s.raw) > nParole(s.nome)) return s.raw;
  const chiaveDi = id => (id.startsWith('speciale:') ? id.slice(9) : id.replace(/_/g, ' '));
  if (s.id && nome !== 'direzione') {
    // nome detto in parte («Cattaneo»): Alexa propone più fermate e mette per prima una qualsiasi; si sceglie dopo, con il mezzo o la linea
    const parziale = s.raw && L.normalizza(s.raw) !== L.normalizza(s.nome || '') && s.alt.length > 1;
    const simili = parziale ? s.alt.filter(x => L.normalizza(x.name || '').split(' ').some(w => L.normalizza(s.raw).split(' ').includes(w))) : [];
    if (simili.length > 1) return { chiave: chiaveDi(s.id), testo: s.nome || s.raw, alt: simili.slice(0, 4).map(x => chiaveDi(x.id)) };
    return { chiave: chiaveDi(s.id), testo: s.nome || s.raw };
  }
  return s.nome || s.raw;
}
const MEZZI_SLOT = { nav: 'nav', aut: 'aut', bus: 'bus', tram: 'tram', vaporetto: 'nav', vaporetti: 'nav', battello: 'nav', battelli: 'nav', autobus: 'bus' };
const NUM_PAROLA = { un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6 };
// «3 vaporetti», «tre autobus»: Alexa a volte mette il numero dentro lo slot del mezzo
const mezzoNumero = raw => { const m = /^(\d+|un|uno|una|due|tre|quattro|cinque|sei)\s+(.+)$/i.exec(String(raw || '').trim()); return m ? { n: /^\d+$/.test(m[1]) ? +m[1] : NUM_PAROLA[m[1].toLowerCase()], resto: m[2].toLowerCase() } : null; };
const MEZZI_TESTO = [[/^(vaporett|battell|barc|motonav|motoscaf|lanc)/, 'nav'], [/^(autobus|bus|corrier|pullman|filobus)/, 'bus'], [/^(tram|tranvi)/, 'tram']];
const mezzoDaTesto = t => { const x = String(t || '').toLowerCase().replace(/^(il|lo|la|i|gli|le)\s+/, ''); if (MEZZI_SLOT[x]) return MEZZI_SLOT[x]; const m = MEZZI_TESTO.find(([re]) => re.test(x)); return m ? m[1] : null; };
const mezzoDa = intent => { const s = slot(intent, 'mezzo'); if (!s) return null; const mn = mezzoNumero(s.raw); return MEZZI_SLOT[s.id] || mezzoDaTesto(s.raw) || (mn && mezzoDaTesto(mn.resto)) || null; };
// linea detta: valore di Alexa, poi ciò che è stato trascritto («t. one», «tram uno»), anche dentro lo slot del mezzo («il tram uno»);
// tra le varianti possibili vale la prima che esiste davvero negli orari
function lineaDa(intent, C) {
  const s = slot(intent, 'linea'), m = slot(intent, 'mezzo');
  const testi = [s && s.id, s && s.raw, s && s.nome, m && m.raw && /\d|\buno\b|\bdue\b|\btre\b/i.test(m.raw) ? m.raw : null].filter(Boolean);
  const cand = [...new Set(testi.flatMap(t => L.candidatiLinea(t)))];
  if (!cand.length) return null;
  const esiste = c => !C || !C.routes || L.infoLinea(C.routes, c).length > 0;
  return cand.find(esiste) || (s ? cand[0] : null);
}
const numeroDa = intent => {
  const s = slot(intent, 'numero'); const v = s && (s.id || s.raw);
  if (v != null && /^\d+$/.test(String(v))) return Math.max(1, Math.min(+v, 6));
  const mn = mezzoNumero(slot(intent, 'mezzo')?.raw); return mn && mn.n ? Math.max(1, Math.min(mn.n, 6)) : null;
};
// F3: Alexa a volte mette partenza e destinazione nello stesso slot («mestre per venezia», «rialto piazzale roma»).
// Se il testo non è un luogo riconosciuto, si prova a dividerlo in due luoghi noti (con o senza «per», «a», «verso»).
const SEP_DIR = /^(in direzione( di)?|verso|direzione)$/;
function dividiLuoghi(C, raw) {
  const w = L.normalizza(raw).split(' ').filter(Boolean), orig = String(raw).toLowerCase().split(/\s+/).filter(Boolean);
  if (!C.luoghi || orig.length < 2) return null;
  const forte = t => { const r = C.luoghi.cerca(t); return r.ok && (r.ok.punteggio == null || r.ok.punteggio >= 0.9) ? r.ok : null; };
  if (forte(raw)) return null;
  const SEP = ['in direzione di', 'in direzione', 'direzione', 'verso', 'per', 'fino a', 'a', 'al', 'alla', 'allo', 'ai', 'alle', 'agli', 'all\'', 'e'];
  for (let i = 1; i < orig.length; i++) {
    for (const sep of ['', ...SEP]) {
      const sw = sep ? sep.split(' ') : [];
      if (sw.length && orig.slice(i, i + sw.length).join(' ') !== sep) continue;
      const sx = orig.slice(0, i).join(' '), dx = orig.slice(i + sw.length).join(' ');
      if (!sx || !dx) continue;
      const a = forte(sx), b = forte(dx);
      if (a && b && a.chiave !== b.chiave) return { da: sx, a: dx, verso: SEP_DIR.test(sep) };
    }
  }
  void w; return null;
}
const quandoDa = (C, intent, entro = false) => T.quando({ data: slot(intent, 'data')?.raw, ora: slot(intent, 'ora')?.raw, adesso: C.adesso(), entro });
// «oggi» detto senza ora = il resto della giornata (per marea e avvisi)
function quandoGiorno(C, intent) {
  const q = quandoDa(C, intent), d = slot(intent, 'data')?.raw;
  if (q.adesso && d && T.risolviData(d)) return { adesso: false, ymd: q.ymd, secs: 0, hhmm: '00:00', conOra: false, oggi: q.ymd, tipoData: 'giorno' };
  return q;
}
const prefDa = intent => { const s = slot(intent, 'preferenza'); const v = (s && (s.id || s.raw) || '').toLowerCase(); return v === 'veloce' || v === 'cambi' || v === 'piedi' ? v : null; };

// pontile o numero detto insieme al nome: «Rialto pontile C», «San Marco Cattaneo uno», «Zattere B»
const NUMERI = { uno: '1', due: '2', tre: '3', quattro: '4', cinque: '5', sei: '6', primo: '1', secondo: '2', terzo: '3' };
function etichettaDetta(t) {
  const m = /(?:\b(?:pontile|corsia|fermata|lato|palo)\s+([a-z]\d?|\d{1,2}|uno|due|tre|quattro|cinque|sei)|\s(\d{1,2}|uno|due|tre|quattro|primo|secondo|terzo|[a-h]))$/i.exec(String(t || '').trim());
  if (!m) return null;
  const v = (m[1] || m[2]).toLowerCase();
  return { etichetta: (NUMERI[v] || v).toUpperCase(), base: String(t).trim().slice(0, m.index).trim() };
}

// ---- luoghi: risoluzione, ambiguità, dati mancanti ----
const DOMANDE = { frequenza: MSG.fermataMancante, partenze: MSG.fermataMancante, ultima: MSG.fermataMancante, prima: MSG.fermataMancante, linee: MSG.fermataMancante, itinerario: { da: MSG.origineMancante, a: MSG.destinazioneMancante } };
function risolviCampo(C, req, campo) {
  const v = req[campo]; if (v == null) return { ok: null };
  if (typeof v === 'object' && v.chiave) {
    const g = C.luoghi.gruppoPerChiave(v.chiave);
    if (g) return { ok: g, ids: v.ids || null };
    if (!v.testo) return { nessuno: v.chiave };
    return risolviCampo(C, { ...req, [campo]: v.testo }, campo);
  }
  const e = etichettaDetta(v);
  const src = req.mezzo ? (D.mezzoInfo(req.mezzo) || {}).src || null : null;
  let r = C.luoghi.cerca(String(v), { mezzo: src });
  // il pontile o il numero detti restringono le fermate del luogo (solo se esistono davvero con quell'etichetta)
  if (e) {
    const r2 = C.luoghi.cerca(e.base, { mezzo: src }), g = (r2.ok || r.ok);
    if (g && C.zone) { const ids = g.ids.filter(id => (C.zone.etichetta(id) || (C.luoghi.stopPerId(id) || {}).pontile || '').toUpperCase() === e.etichetta); if (ids.length) return { ok: g, ids }; }
    if (r2.ok) r = r2;
  }
  if (r.ok) return { ok: r.ok };
  if (r.ambiguo) return { ambiguo: r.ambiguo.slice(0, 4) };
  return { nessuno: String(v) };
}
const elencoOpzioni = g => P.elenco(g.map(x => x.parlato));
// più fermate proposte da Alexa per un nome detto in parte: restano quelle servite dal mezzo o dalla linea chiesti (orari di oggi);
// una sola -> quella; più di una -> si chiede quale
async function scegliAlternativa(C, req, campo) {
  let gs = req[campo].alt.map(k => C.luoghi.gruppoPerChiave(k)).filter(Boolean);
  if (gs.length < 2) return { ok: gs[0] || null };
  const mz = req.mezzo ? D.mezzoInfo(req.mezzo) : null;
  if (mz) gs = gs.filter(g => g.srcs.has(mz.src));
  if ((mz && mz.tipi) || req.linea) {
    const ymd = T.giornoDiServizio(C.adesso()).ymd, servite = [];
    for (const g of gs) {
      try { const r = await C.diretti({ da: C.luoghi.idsDi(g, mz ? mz.src : null), ymd, linee: req.linea ? [req.linea] : null, tipi: mz && mz.tipi ? mz.tipi : null, max: 1 }); if (r.righe.length) servite.push(g); } catch { servite.push(g); }
    }
    if (servite.length) gs = servite;
  }
  if (gs.length === 1) return { ok: gs[0] };
  return gs.length ? { ambiguo: gs.slice(0, 3) } : { ok: null };
}

// ---- esecuzione di una richiesta ----
// req: { tipo, luogo|da|a (testo o {chiave, ids}), dirTesto, linea, mezzo, quando, n, cambi, pref, indice, visti, dopoMs, dopoSecs, dettagli, quale, ... }
async function esegui(C, env, req, att) {
  const tipo = req.tipo;
  req = { ...req };
  const campiNecessari = { partenze: ['luogo'], ultima: ['luogo'], prima: ['luogo'], linee: ['luogo'], frequenza: ['luogo'], itinerario: ['da', 'a'] }[tipo] || [];
  const gruppi = {}, idsScelti = {};
  for (const campo of ['luogo', 'da', 'a']) {
    if (req[campo] == null) continue;
    if (typeof req[campo] === 'object' && req[campo].alt) { const sc = await scegliAlternativa(C, req, campo); req = { ...req, [campo]: sc.ok ? { chiave: sc.ok.chiave } : { chiave: req[campo].chiave, testo: req[campo].testo } }; if (sc.ambiguo) { att.pend = { req: { ...req, [campo]: undefined }, campo, opzioni: sc.ambiguo.map(g => g.chiave) }; const v = sc.ambiguo.length === 2 ? `Intendi ${sc.ambiguo[0].parlato} o ${sc.ambiguo[1].parlato}?` : `Intendi ${elencoOpzioni(sc.ambiguo).replace(/ e ([^,]+)$/, ' o $1')}?`; return { voce: P.esc(v), reprompt: v, fine: false, attributi: att, pendente: true }; } }
    const r = risolviCampo(C, req, campo);
    // nome che corrisponde a più fermate: prima si prova a scegliere con il mezzo o la linea chiesti
    if (r.ambiguo && (req.mezzo || req.linea)) { const sc = await scegliAlternativa(C, { ...req, [campo]: { alt: r.ambiguo.map(g => g.chiave) } }, campo); if (sc.ok) { delete r.ambiguo; r.ok = sc.ok; } else if (sc.ambiguo) r.ambiguo = sc.ambiguo; }
    if (r.ambiguo) {
      att.pend = { req: { ...req, [campo]: undefined }, campo, opzioni: r.ambiguo.map(g => g.chiave) };
      const v = r.ambiguo.length === 2 ? `Intendi ${r.ambiguo[0].parlato} o ${r.ambiguo[1].parlato}?` : `Intendi ${elencoOpzioni(r.ambiguo).replace(/ e ([^,]+)$/, ' o $1')}?`;
      return { voce: P.esc(v), reprompt: v, fine: false, attributi: att, pendente: true };
    }
    if (r.nessuno) {
      att.pend = { req: { ...req, [campo]: undefined }, campo };
      const v = `Non conosco la fermata ${P.senzaTag(String(r.nessuno)).slice(0, 40)}. Prova con un altro nome, per esempio una fermata vicina.`;
      return { voce: P.esc(v), reprompt: 'Dimmi un altro nome.', fine: false, attributi: att, pendente: true };
    }
    gruppi[campo] = r.ok; if (r.ids) idsScelti[campo] = r.ids;
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
    return { voce: P.esc(MSG.lineaOFermata), reprompt: MSG.lineaOFermata, fine: false, attributi: att, pendente: true };
  }
  delete att.pend;
  const mezzo = req.mezzo || null;
  // destinazione detta come luogo d'arrivo («da Rialto a Piazzale Roma») o come direzione («verso Venezia»)
  const dir = req.dirTesto || (gruppi.a && tipo !== 'itinerario' ? gruppi.a : null);
  let r;
  try {
    switch (tipo) {
      case 'partenze': r = await D.partenze(C, { gruppo: gruppi.luogo, ids: idsScelti.luogo, linea: req.linea || null, mezzo, dir, escludiDir: req.escludiDir || null, stessoCapolinea: req.stessoCapolinea || null, escludiCapolinea: req.escludiCapolinea || null, verso: !!req.dirTesto, n: req.n || 1, visti: req.visti, dopoMs: req.dopoMs, dopoSecs: req.dopoSecs, quando: req.quando || null }); break;
      case 'ritardo': r = await D.ritardo(C, { gruppo: gruppi.luogo || null, ids: idsScelti.luogo, linea: req.linea || null, mezzo, dir }); break;
      case 'ultima': case 'prima': r = await D.estremo(C, { quale: tipo, gruppo: gruppi.luogo, ids: idsScelti.luogo, linea: req.linea || null, mezzo, dir, verso: !!req.dirTesto, escludiCapolinea: req.escludiCapolinea || null, quando: req.quando || null }); break;
      case 'linee': r = await D.linee(C, { gruppo: gruppi.luogo, mezzo }); break;
      case 'frequenza': r = await D.frequenza(C, { gruppo: gruppi.luogo, ids: idsScelti.luogo, linea: req.linea || null, mezzo, dir, verso: !!req.dirTesto, capolinea: req.capolinea || null, quando: req.quando || null }); break;
      case 'itinerario': r = await I.itinerario(C, { da: gruppi.da, a: gruppi.a, quando: req.quando || null, mezzo, cambi: req.cambi ?? null, pref: req.pref || null, indice: req.indice || 0, dettagli: !!req.dettagli, durata: !!req.durata }); break;
      case 'meteo': r = await MT.meteo(C, { grandezza: req.grandezza || null, stazione: req.stazione || null, confronto: !!req.confronto }); break;
      case 'marea': r = await M.marea(C); break;
      case 'colmo': r = await M.colmo(C, { minimo: !!req.minimo }); break;
      case 'acquaalta': r = await M.acquaAlta(C, { quando: req.quando || null }); break;
      case 'mose': r = await M.mose(C); break;
      case 'stivali': r = await M.stivali(C, { gruppo: gruppi.luogo || null }); break;
      case 'passerelle': r = await M.passerelle(C, { gruppo: gruppi.luogo || null }); break;
      case 'avvisi': r = await S.avvisi(C, { linea: req.linea || null, gruppo: gruppi.luogo || null, mezzo, dataRichiesta: req.dataRichiesta || null, soloSciopero: !!req.soloSciopero, tutti: !!req.tutti }); break;
      case 'riepilogo': r = await R.riepilogo(C, { momento: req.momento || null, gruppo: gruppi.luogo || null, mezzo, dir: req.dirTesto || null }); break;
      default: return { voce: P.esc(MSG.nonCapito), fine: false, attributi: att };
    }
  } catch (e) { return erroreRichiesta(C, req, e, att); }
  delete att.riprova;
  // contesto per i seguiti: la richiesta (luoghi come chiavi) e ciò che è stato detto
  const rc = richiestaCompatta(req, gruppi, idsScelti);
  if (r.ctx && r.ctx.visti) { rc.visti = r.ctx.visti; rc.dopoMs = r.ctx.dopoMs; rc.dopoSecs = r.ctx.dopoSecs; }
  if (r.ctx && r.ctx.dirEffettiva) { rc.dirTesto = r.ctx.dirEffettiva; delete rc.escludiDir; delete rc.escludiCapolinea; }
  // una sola corsa detta senza direzione («quando passa il due alle Zattere»): i seguiti restano su quel capolinea («e quello dopo?»)
  // e «nell'altra direzione» vuol dire gli altri capolinea
  if (r.ctx && r.ctx.capolinea && !rc.dirTesto && !rc.a) rc.capolinea = r.ctx.capolinea; else delete rc.capolinea;
  att.ctx = { ...(r.ctx || {}), req: rc };
  delete att.ctx.visti; delete att.ctx.dopoMs; delete att.ctx.dopoSecs; delete att.ctx.dirEffettiva; delete att.ctx.capolinea;
  if (r.proponi) att.proponi = r.proponi; else delete att.proponi;
  att.ultimo = r.voce; att.ultimoLive = ['partenze', 'ritardo', 'riepilogo'].includes(tipo) && !(req.quando && !req.quando.adesso);
  // la sessione resta aperta per i seguiti («e il prossimo?»), senza una domanda in coda a ogni risposta; il riepilogo (routine) chiude
  const reprompt = r.reprompt || (r.proponi ? 'Vuoi che cerchi un percorso con cambi?' : tipo === 'riepilogo' ? null : (RIPROMPT[tipo] || 'Vuoi sapere altro?'));
  const voce = DOMANDA_FINALE && reprompt && !r.reprompt && !r.proponi ? `${r.voce} ${P.esc(reprompt)}` : r.voce;
  return { voce, scheda: r.scheda || null, reprompt, fine: !reprompt, attributi: att };
}
function richiestaCompatta(req, gruppi, ids) {
  const o = { tipo: req.tipo };
  for (const k of ['luogo', 'da', 'a']) if (gruppi[k]) o[k] = ids[k] ? { chiave: gruppi[k].chiave, ids: ids[k] } : { chiave: gruppi[k].chiave };
  for (const k of ['linea', 'mezzo', 'cambi', 'pref', 'indice', 'quando', 'durata', 'dirTesto', 'escludiDir', 'escludiCapolinea', 'capolinea', 'dataRichiesta', 'soloSciopero', 'momento', 'n', 'minimo', 'grandezza', 'stazione', 'confronto']) if (req[k] != null) o[k] = req[k];
  return o;
}
// errori ripetibili: la richiesta resta pronta per «riprova» / «sì»
function erroreRichiesta(C, req, e, att) {
  const code = e && e.code;
  const ripetibile = code === 409 || code === 503 || code === 429 || (e && e.busy);
  if (!ripetibile) return { voce: P.esc(U.erroreParlato(e)), reprompt: MSG.cosaVuoi, fine: false, attributi: att };
  const giaInCorso = att.riprova && JSON.stringify(att.riprova) === JSON.stringify(req) && code === 409;
  att.riprova = req;
  if (code === 409) {
    const oggi = T.adessoRoma(C.adesso()).ymd, ymd = req.quando && !req.quando.adesso ? req.quando.ymd : oggi;
    const t = (giaInCorso ? MSG.caricamentoAncora : MSG.caricamento).replace('{giorno}', P.giornoParlato(ymd, oggi));
    return { voce: P.esc(t), reprompt: MSG.vuoiRiprovare, fine: false, attributi: att };
  }
  return { voce: P.esc(MSG.occupato), reprompt: MSG.vuoiRiprovare, fine: false, attributi: att };
}

// ---- gestori per intento ----
const QUANDO_SERIALE = q => (q && !q.adesso ? { adesso: false, ymd: q.ymd, secs: q.secs, hhmm: q.hhmm, conOra: q.conOra, fascia: q.fascia, nomeFascia: q.nomeFascia, tipoData: q.tipoData, entro: !!q.entro, oggi: q.oggi } : null);

function richiestaDa(C, intent, nome, att) {
  let luogo = testoSlot(intent, 'luogo'), da = testoSlot(intent, 'partenza'), a = testoSlot(intent, 'arrivo'), dir = testoSlot(intent, 'direzione');
  for (const campo of ['luogo', 'partenza']) {
    const s = slot(intent, campo);
    if (!s || s.id || !s.raw || (campo === 'luogo' ? a || dir : a)) continue;
    const dv = dividiLuoghi(C, s.raw); if (!dv) continue;
    if (campo === 'luogo') { luogo = dv.da; if (dv.verso) dir = dv.a; else a = dv.a; } else { da = dv.da; a = dv.a; }
  }
  const linea = lineaDa(intent, C), mezzo = mezzoDa(intent) || (lineaDa(intent, C) && /^T\d/.test(lineaDa(intent, C)) ? 'tram' : null), n = numeroDa(intent);
  const entro = /Entro/.test(nome);
  const c = att.ctx && att.ctx.req;
  // domanda senza fermata dopo una risposta su una fermata («e l'ultimo?», «quali linee passano?»): luogo, direzione e filtri dal contesto
  const eredita = req => {
    if (req.luogo || !c || !c.luogo) return req;
    // «ultima corsa del cinque punto due» dopo una domanda su un'altra linea: la fermata di prima non c'entra, si chiede
    if (req.linea && !(c.linea && L.stessaLinea(c.linea, req.linea))) return req;
    const out = { ...req, luogo: c.luogo };
    const filtroNuovo = (req.mezzo && req.mezzo !== c.mezzo);
    if (!req.dirTesto && !req.a && !filtroNuovo) { if (c.dirTesto) out.dirTesto = c.dirTesto; if (c.a) out.a = c.a; }
    if (!req.linea && !req.mezzo) { if (c.linea) out.linea = c.linea; if (c.mezzo) out.mezzo = c.mezzo; }
    return out;
  };
  switch (nome) {
    case 'PartenzeIntent': case 'ProssimaCorsaIntent': {
      const q = quandoDa(C, intent);
      return eredita({ tipo: 'partenze', luogo: luogo || da, a: a || null, linea, mezzo, dirTesto: dir, n: n || (nome === 'ProssimaCorsaIntent' ? 1 : 3), quando: QUANDO_SERIALE(q) });
    }
    case 'RitardoIntent': return { tipo: 'ritardo', luogo, linea, mezzo, dirTesto: dir };
    case 'UltimaCorsaIntent': case 'PrimaCorsaIntent': {
      const q = quandoDa(C, intent);
      return eredita({ tipo: nome === 'UltimaCorsaIntent' ? 'ultima' : 'prima', luogo: luogo || da, a: a || null, linea, mezzo, dirTesto: dir, quando: QUANDO_SERIALE(q) });
    }
    case 'LineeIntent': return eredita({ tipo: 'linee', luogo, mezzo });
    case 'FrequenzaIntent': {
      // «ogni quanto passa?» dopo una risposta: stessa fermata, linea, direzione (o lo stesso capolinea della corsa detta)
      const q = quandoDa(C, intent);
      const r = eredita({ tipo: 'frequenza', luogo: luogo || da, a: a || null, linea, mezzo, dirTesto: dir, quando: QUANDO_SERIALE(q) });
      if (!luogo && !da && c && !r.dirTesto && !r.a && c.capolinea) r.capolinea = c.capolinea;
      return r;
    }
    case 'ItinerarioIntent': case 'ItinerarioEntroIntent': case 'DurataIntent': {
      const q = quandoDa(C, intent, entro && !!slot(intent, 'ora'));
      const cs = slot(intent, 'cambi'); const nc = cs && cs.raw != null && /^\d+$/.test(cs.raw) ? +cs.raw : null;
      // «quanto ci metto da Rialto al Lido?»: lo stesso percorso, con la durata detta per prima
      return { tipo: 'itinerario', da, a, mezzo, quando: QUANDO_SERIALE(q), cambi: nc, pref: prefDa(intent), ...(nome === 'DurataIntent' ? { durata: true } : {}) };
    }
    case 'MareaIntent': return { tipo: 'marea' };
    // METEO: grandezza (vento, raffiche, direzione, visibilità, nebbia, temperatura, acqua, umidità, pressione, condizioni) e stazione facoltative
    case 'MeteoIntent': case 'MeteoConfrontoIntent': case 'MeteoRecenteIntent': case 'MeteoDirezioneIntent': {
      const gs = slot(intent, 'grandezza'), ss = slot(intent, 'stazione');
      const grandezza = nome === 'MeteoRecenteIntent' ? 'recente' : nome === 'MeteoDirezioneIntent' ? 'direzione' : (gs && (gs.id || MT.grandezzaDaTesto(gs.raw))) || null;
      const stazione = (ss && (ss.id || MT.stazioneDaTesto(ss.raw))) || null;
      return { tipo: 'meteo', grandezza, stazione, confronto: nome === 'MeteoConfrontoIntent' || undefined };
    }
    // «e le raffiche?», «e a Marittima?» dopo una risposta meteo: cambia solo ciò che è detto
    case 'MeteoSeguitoIntent': {
      const gs = slot(intent, 'grandezza'), ss = slot(intent, 'stazione');
      const grandezza = (gs && (gs.id || MT.grandezzaDaTesto(gs.raw))) || null, stazione = (ss && (ss.id || MT.stazioneDaTesto(ss.raw))) || null;
      const prima = c && c.tipo === 'meteo' ? c : {};
      return { tipo: 'meteo', grandezza: grandezza || prima.grandezza || null, stazione: stazione || (grandezza ? prima.stazione : null) || null };
    }
    case 'ColmoIntent': return { tipo: 'colmo' };
    case 'MinimoIntent': return { tipo: 'colmo', minimo: true };
    case 'AcquaAltaIntent': return { tipo: 'acquaalta', quando: QUANDO_SERIALE(quandoGiorno(C, intent)) };
    case 'MoseIntent': return { tipo: 'mose' };
    case 'StivaliIntent': return { tipo: 'stivali', luogo };
    case 'PasserelleIntent': return { tipo: 'passerelle', luogo };
    case 'AvvisiIntent': return { tipo: 'avvisi', luogo, linea, mezzo, dataRichiesta: slot(intent, 'data')?.raw || null };
    case 'ScioperoIntent': return { tipo: 'avvisi', linea, mezzo, soloSciopero: true, dataRichiesta: slot(intent, 'data')?.raw || null };
    case 'RiepilogoIntent': return { tipo: 'riepilogo', luogo, mezzo, dirTesto: dir, momento: /mattina/i.test(String(slot(intent, 'momento')?.raw || slot(intent, 'momento')?.id || '')) ? 'mattina' : null };
    default: return null;
  }
}

const addGiorni = (C, n) => { const d = cal.addDays(T.adessoRoma(C.adesso()).ymd, n); return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; };
const quandoGiornoDa = (C, data) => { const q = T.quando({ data, ora: null, adesso: C.adesso() }); return q.adesso && T.risolviData(data) ? { adesso: false, ymd: q.ymd, secs: 0, hhmm: '00:00', conOra: false, oggi: q.ymd, tipoData: 'giorno' } : q; };
const ORARI = ['partenze', 'itinerario', 'ultima', 'prima', 'frequenza'];
const ricomincia = req => { const r = { ...req }; delete r.visti; delete r.dopoMs; delete r.dopoSecs; r.indice = 0; return r; };

// seguiti: modificano solo il parametro detto dell'ultima richiesta
async function seguito(C, env, intent, att, nome) {
  const c = att.ctx && att.ctx.req;
  const manca = () => ({ voce: P.esc(MSG.contestoAssente), reprompt: MSG.cosaVuoi, fine: false, attributi: att });
  if (!c) return manca();
  const req = { ...c };
  switch (nome) {
    case 'AMAZON.NextIntent': case 'AltreCorseIntent': {
      if (c.tipo === 'partenze') { req.n = nome === 'AltreCorseIntent' ? Math.max(3, numeroDa(intent) || 3) : 1; if (c.linea && c.capolinea) req.stessoCapolinea = c.capolinea; return esegui(C, env, req, att); }
      if (c.tipo === 'itinerario') { req.indice = att.ctx.indice || 1; delete req.dettagli; return esegui(C, env, req, att); }
      if (c.tipo === 'avvisi') { req.tutti = true; return esegui(C, env, req, att); }
      if (c.tipo === 'ultima' || c.tipo === 'prima') return esegui(C, env, ricomincia({ ...req, tipo: 'partenze', n: 3 }), att);
      return testo('Non ho altro da aggiungere. Chiedimi pure qualcos\'altro.', { reprompt: MSG.cosaVuoi, fine: false, attributi: att });
    }
    case 'RitornoIntent':
      if (c.tipo === 'itinerario') { const r = ricomincia(req); [r.da, r.a] = [req.a, req.da]; return esegui(C, env, r, att); }
      if (['partenze', 'ultima', 'prima'].includes(c.tipo) && c.a) { const r = ricomincia(req); [r.luogo, r.a] = [c.a, c.luogo]; delete r.dirTesto; return esegui(C, env, r, att); }
      return testo('Per il ritorno dimmi da dove parti e dove vai, per esempio: come arrivo a Piazzale Roma da Rialto.', { reprompt: 'Da dove parti e dove vai?', fine: false, attributi: att });
    case 'DomaniIntent': {
      const dataDetta = slot(intent, 'data')?.raw, oraDetta = slot(intent, 'ora')?.raw;
      if (ORARI.includes(c.tipo)) {
        const base = c.quando && !c.quando.adesso ? `${c.quando.ymd.slice(0, 4)}-${c.quando.ymd.slice(4, 6)}-${c.quando.ymd.slice(6, 8)}` : null;
        const data = dataDetta || (oraDetta ? base : addGiorni(C, 1));
        const ora = oraDetta || (dataDetta || !oraDetta ? (c.quando && c.quando.conOra ? c.quando.hhmm : null) : null);
        const q = T.quando({ data, ora, adesso: C.adesso(), entro: !!(c.quando && c.quando.entro) });
        const r = ricomincia(req); r.quando = QUANDO_SERIALE(q);
        if (r.tipo === 'partenze' && !r.quando) r.n = c.n || 1;
        return esegui(C, env, r, att);
      }
      if (c.tipo === 'acquaalta' || ['marea', 'colmo', 'mose', 'stivali'].includes(c.tipo)) { req.tipo = 'acquaalta'; req.quando = QUANDO_SERIALE(quandoGiornoDa(C, dataDetta || addGiorni(C, 1))); return esegui(C, env, req, att); }
      if (c.tipo === 'avvisi') { req.dataRichiesta = dataDetta || addGiorni(C, 1); return esegui(C, env, req, att); }
      return manca();
    }
    case 'SenzaCambiIntent':
      if (c.tipo === 'itinerario') { const r = ricomincia(req); r.cambi = 0; return esegui(C, env, r, att); }
      if (['partenze', 'ultima', 'prima'].includes(c.tipo)) return testo('Le partenze che ti ho detto sono già corse dirette da quella fermata.', { reprompt: MSG.cosaVuoi, fine: false, attributi: att });
      return manca();
    case 'AlternativaIntent': {
      if (c.tipo !== 'itinerario') return manca();
      const pref = prefDa(intent), r = { ...req }; delete r.dettagli;
      if (pref) { r.pref = pref; r.indice = 0; r.cambi = pref === 'cambi' ? null : r.cambi ?? null; } else r.indice = att.ctx.indice || 1;
      return esegui(C, env, r, att);
    }
    case 'CorrezioneIntent': {
      // dopo una risposta meteo, «e a Marittima?» è un'altra stazione meteo, non una fermata
      if (c.tipo === 'meteo') { const raw = (slot(intent, 'luogo') || slot(intent, 'direzione') || {}).raw; const st = raw && MT.stazioneDaTesto(raw); if (st) return esegui(C, env, { ...ricomincia(req), stazione: st }, att); }
      // «no, verso Venezia», «solo vaporetti», «con la linea due», «no, intendevo Rialto»: cambia solo ciò che è detto
      const dir = testoSlot(intent, 'direzione'), luogo = testoSlot(intent, 'luogo'), mezzo = mezzoDa(intent), linea = lineaDa(intent, C);
      if (!dir && !luogo && !mezzo && !linea) return manca();
      const r = ricomincia(req);
      if (dir) { if (c.tipo === 'itinerario') r.a = dir; else { r.dirTesto = dir; delete r.a; delete r.escludiDir; } }
      if (luogo) { if (c.tipo === 'itinerario') r.da = luogo; else r.luogo = luogo; }
      if (mezzo) { r.mezzo = mezzo; if (!linea) delete r.linea; }
      if (linea) r.linea = linea;
      return esegui(C, env, r, att);
    }
    case 'AltraDirezioneIntent': {
      if (!['partenze', 'ultima', 'prima', 'frequenza'].includes(c.tipo)) return manca();
      const r = ricomincia(req);
      if (c.a) { [r.luogo, r.a] = [c.a, c.luogo]; return esegui(C, env, r, att); }
      // prima/ultima corsa: l'altra direzione è quella che non va al capolinea appena detto
      if ((c.tipo === 'ultima' || c.tipo === 'prima') && att.ctx.capoEstremo) { r.escludiCapolinea = att.ctx.capoEstremo; delete r.dirTesto; delete r.escludiDir; return esegui(C, env, r, att); }
      if (!c.dirTesto && c.capolinea) { r.escludiCapolinea = c.capolinea; delete r.capolinea; return esegui(C, env, r, att); }
      if (!c.dirTesto) return testo('In quale direzione?', { reprompt: 'Dimmi la direzione, per esempio: verso Lido.', fine: false, attributi: att });
      // direzione opposta: le corse che NON vanno verso la direzione detta prima
      r.escludiDir = c.dirTesto; delete r.dirTesto;
      return esegui(C, env, r, att);
    }
    case 'DettagliIntent':
      if (c.tipo === 'itinerario') { const r = { ...req, dettagli: true, indice: Math.max(0, (att.ctx.indice || 1) - 1) }; return esegui(C, env, r, att); }
      if (c.tipo === 'partenze') { const r = ricomincia(req); r.n = 3; return esegui(C, env, r, att); }
      if (c.tipo === 'avvisi') { req.tutti = true; return esegui(C, env, req, att); }
      return testo('Non ho altri dettagli su questa risposta.', { reprompt: MSG.cosaVuoi, fine: false, attributi: att });
    case 'AggiornaIntent':
      return esegui(C, env, ricomincia(req), att);
    default: return manca();
  }
}

// risposta dell'utente a una domanda in sospeso (fermata mancante o ambigua)
async function rispostaInSospeso(C, env, intent, att, nome) {
  const pend = att.pend; if (!pend) return null;
  let t = null;
  if (nome === 'LuogoIntent') t = testoSlot(intent, 'luogo');
  else if (nome === 'SceltaIntent') {
    const n = slot(intent, 'numero') || slot(intent, 'ordinale'), v = n ? (n.id || n.raw) : null, i = v != null && /^\d+$/.test(String(v)) ? +v : null;
    if (pend.opzioni && i && i >= 1 && i <= pend.opzioni.length) return esegui(C, env, { ...pend.req, [pend.campo]: { chiave: pend.opzioni[i - 1] } }, att);
    return testo(`Dimmi il nome della fermata, oppure un numero da uno a ${P.parole((pend.opzioni || []).length || 1)}.`, { reprompt: 'Quale intendi?', fine: false, attributi: att });
  }
  if (!t) return null;
  if (pend.campo === 'lineaOLuogo') {
    const ln = L.parseLinea(t);
    if (ln && L.infoLinea(C.routes, ln).length) return esegui(C, env, { ...pend.req, linea: ln }, att);
    return esegui(C, env, { ...pend.req, luogo: t }, att);
  }
  return esegui(C, env, { ...pend.req, [pend.campo]: t }, att);
}

// aiuto, presentazione e guida (stessi testi della funzione Lambda, che li dice anche con il server irraggiungibile)
function aiuto(intent, nome, att) {
  if (nome === 'PresentatiIntent') return testo(MSG.presentazione, { reprompt: MSG.cosaVuoi, fine: false, attributi: att });
  if (nome === 'TuttiComandiIntent') return testo(MSG.tuttiComandi, { reprompt: MSG.aiutoRiprompt, fine: false, attributi: att });
  const s = nome === 'AiutoIntent' ? slot(intent, 'categoria') : null, cat = s && (s.id || String(s.raw || '').toLowerCase());
  if (cat && MSG.aiutoCategoria[cat]) return testo(MSG.aiutoCategoria[cat], { reprompt: MSG.cosaVuoi, fine: false, attributi: att });
  return testo(AIUTO, { reprompt: MSG.aiutoRiprompt, fine: false, attributi: att });
}

// intenti propri equivalenti ai predefiniti (non dipendono dal supporto dei predefiniti nella lingua)
const ALIAS_INTENTI = { RipetiIntent: 'AMAZON.RepeatIntent', ProssimoIntent: 'AMAZON.NextIntent', ConfermaIntent: 'AMAZON.YesIntent', RifiutoIntent: 'AMAZON.NoIntent' };
const SEGUITI = ['AMAZON.NextIntent', 'AltreCorseIntent', 'RitornoIntent', 'DomaniIntent', 'SenzaCambiIntent', 'AlternativaIntent', 'CorrezioneIntent', 'AltraDirezioneIntent', 'DettagliIntent', 'AggiornaIntent'];

// richieste contemporanee (il server gratuito ha 512 MB e una CPU ridotta: la skill non deve toglierli a mappa e notifiche)
const MAX_CONTEMPORANEE = 6; let inCorso = 0;

// ---- punto d'ingresso ----
// env: { call, stops, routes, diretti?, versione?, adesso?, skillId?, occupato? }
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
  delete att.errori; delete att.rifai;
  if (rich.type === 'SessionEndedRequest') return { status: 200, body: { version: '1.0', response: {} } };
  const locale = String(rich.locale || 'it-IT');
  if (!/^it(-|$)/i.test(locale)) return { status: 200, body: risposta(envelope, { voce: P.esc(MSG.soloItaliano), fine: true }) };
  if (rich.type === 'LaunchRequest') return { status: 200, body: risposta(envelope, { voce: P.esc(BENVENUTO), reprompt: MSG.cosaVuoi, fine: false, attributi: {} }) };
  if (rich.type !== 'IntentRequest' || !rich.intent) return { status: 200, body: risposta(envelope, { voce: P.esc(MSG.nonCapito), fine: true }) };
  const intent = rich.intent, nome = ALIAS_INTENTI[String(intent.name || '')] || String(intent.name || '');
  // chiusura e aiuto: sempre, anche con il server sotto carico
  if (['AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent'].includes(nome) || (nome === 'AMAZON.NoIntent' && !att.pend)) return { status: 200, body: risposta(envelope, { voce: P.esc(MSG.chiusura), fine: true }) };
  if (['AMAZON.HelpIntent', 'AiutoIntent', 'PresentatiIntent', 'TuttiComandiIntent'].includes(nome)) return { status: 200, body: risposta(envelope, aiuto(intent, nome, att)) };
  if (inCorso > MAX_CONTEMPORANEE || (ambiente.occupato && ambiente.occupato())) return { status: 200, body: risposta(envelope, { voce: P.esc(MSG.occupato), reprompt: MSG.vuoiRiprovare, fine: false, attributi: att }) };
  let C;
  try { C = await Ctx.crea({ ...ambiente, adesso }); }
  catch (e) { return { status: 200, body: risposta(envelope, { voce: P.esc(U.erroreParlato(e)), fine: true, attributi: att }) }; }
  try {
    let out = null;
    if (nome === 'AMAZON.RepeatIntent') {
      out = att.ultimo ? { voce: (att.ultimoLive ? P.esc('Ripeto la risposta di prima.') + ' ' : '') + att.ultimo, reprompt: att.ultimoLive ? 'Per i dati aggiornati, dimmi: aggiorna.' : MSG.cosaVuoi, fine: false, attributi: att }
        : testo(MSG.nienteDaRipetere, { reprompt: MSG.cosaVuoi, fine: false, attributi: att });
    } else if (nome === 'RiprovaIntent' || nome === 'AMAZON.YesIntent') {
      if (att.riprova) out = await esegui(C, envelope, att.riprova, att);
      else if (nome === 'AMAZON.YesIntent' && att.proponi) { const p = att.proponi; delete att.proponi; out = await esegui(C, envelope, p, att); }
      else if (nome === 'RiprovaIntent' && att.ctx && att.ctx.req) out = await esegui(C, envelope, ricomincia(att.ctx.req), att);
      else if (nome === 'AMAZON.YesIntent' && att.pend) out = testo(att.pend.opzioni ? 'Quale intendi? Dimmi il nome.' : 'Dimmi il nome della fermata.', { reprompt: 'Quale fermata?', fine: false, attributi: att });
      else out = testo(nome === 'RiprovaIntent' ? MSG.nessunaRichiesta : 'Dimmi pure cosa vuoi sapere.', { reprompt: MSG.cosaVuoi, fine: false, attributi: att });
    } else if (nome === 'AMAZON.NoIntent') { delete att.pend; out = testo(MSG.chiusura, { fine: true, attributi: att }); }
    else if (nome === 'NonSupportatoIntent') out = testo(MSG.nonSupportato, { reprompt: MSG.cosaVuoi, fine: false, attributi: att });
    else if (nome === 'CorrezioneIntent' && att.pend && slot(intent, 'luogo')) out = await rispostaInSospeso(C, envelope, { ...intent, name: 'LuogoIntent' }, att, 'LuogoIntent');
    else if (SEGUITI.includes(nome)) out = await seguito(C, envelope, intent, att, nome);
    else if (nome === 'LuogoIntent' || nome === 'SceltaIntent') {
      out = await rispostaInSospeso(C, envelope, intent, att, nome);
      // un nome detto da solo dopo una risposta meteo = quella stazione meteo; altrimenti la prossima partenza da lì
      const stMeteo = !out && nome === 'LuogoIntent' && att.ctx && att.ctx.tipo === 'meteo' ? MT.stazioneDaTesto((slot(intent, 'luogo') || {}).raw) : null;
      if (stMeteo) out = await esegui(C, envelope, { tipo: 'meteo', grandezza: att.ctx.req && att.ctx.req.grandezza || null, stazione: stMeteo }, att);
      if (!out && nome === 'LuogoIntent') out = await esegui(C, envelope, { tipo: 'partenze', luogo: testoSlot(intent, 'luogo'), n: 1 }, att);
      if (!out) out = testo(MSG.nonCapito, { reprompt: MSG.cosaVuoi, fine: false, attributi: att });
    } else if (nome === 'AMAZON.FallbackIntent') {
      const n = (att.fallback || 0) + 1; att.fallback = n;
      out = testo(n >= 2 ? MSG.nonCapitoAncora : MSG.nonCapito, { reprompt: MSG.cosaVuoi, fine: false, attributi: att });
    } else {
      const req = richiestaDa(C, intent, nome, att);
      if (!req) out = testo(MSG.nonCapito, { reprompt: MSG.cosaVuoi, fine: false, attributi: att });
      else { delete att.pend; delete att.riprova; out = await esegui(C, envelope, req, att); }
    }
    if (out && nome !== 'AMAZON.FallbackIntent') delete att.fallback;
    return { status: 200, body: risposta(envelope, { ...out, attributi: out.attributi || att }) };
  } catch (e) {
    return { status: 200, body: risposta(envelope, { voce: P.esc(U.erroreParlato(e)), reprompt: MSG.vuoiRiprovare, fine: false, attributi: att }) };
  }
}

module.exports = { gestisci, slot, richiestaDa, etichettaDetta, BENVENUTO, AIUTO, TOLLERANZA_MS };
