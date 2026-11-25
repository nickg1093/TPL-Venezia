// SKILL ALEXA — MOTORE DELLE CORSE E DIALOGO (revisione 2): corse dirette sull'intero GTFS della data, direzione verificata sulla sequenza
// delle fermate, mezzo da route_type, singolare/plurale/quantità, seguiti con identità delle corse, prima/ultima corsa (anche dopo mezzanotte),
// caricamento e «riprova», aiuto per categoria, presentazione, itinerario sintetico e dettagli. Dati inventati e riproducibili (alexa-fixtures).
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./alexa-fixtures');
const Dir = require('../alexa/diretti');
const MSG = require('../alexa/messaggi');
const { gestisci, etichettaDetta } = require('../alexa/skill');
const Ctx = require('../alexa/contesto');

const ORA = (h, m) => F.MS(2026, 11, 25, h - 1, m);   // ora di Venezia (UTC+1) del 25/11/2026
// rete sintetica: Rialto C (1101) → Piazzale Roma F (1201); tram T1 e autobus 6 a San Marco Cattaneo (6057 = «1», 6058 = «2»)
const CORSE = {
  nav: [
    { id: 'L1a', route: 'R1', headsign: 'P.le Roma "F"', stops: [['1101', '08:30'], ['1201', '08:45']] },
    { id: 'L2', route: 'R2', headsign: 'S. Marco-San Zaccaria "F"', stops: [['1201', '09:00'], ['1101', '09:15'], ['1301', '09:30'], ['1201', '10:00'], ['1101', '10:15']] },   // circolare
    { id: 'L1b', route: 'R1', headsign: 'P.le Roma "F"', stops: [['1101', '23:30'], ['1201', '23:45']] },
    { id: 'NN', route: 'RN', headsign: 'P.le Roma "F"', stops: [['1101', '25:10'], ['1201', '25:25']] },                         // dopo mezzanotte (giorno di servizio precedente)
    { id: 'L1fest', route: 'R1', service: 'FES', headsign: 'P.le Roma "F"', stops: [['1101', '23:55'], ['1201', '24:10']] },     // solo festivi: non vale mercoledì
    { id: 'L1inv', route: 'R1', headsign: 'Rialto "C"', stops: [['1201', '07:00'], ['1101', '07:15']] },                         // passa da P.le Roma PRIMA di Rialto, finisce a Rialto
    { id: 'L51', route: 'R51', headsign: 'Lido S.M.E. "B"', stops: [['1101', '08:20'], ['1501', '08:50']] }
  ],
  aut: [
    { id: 'T1v', route: 'T1', headsign: 'Venezia', stops: [['3001', '08:00'], ['6057', '08:15'], ['2201', '08:35']] },
    { id: 'T1f', route: 'T1', headsign: 'Monte Celo Favaro', stops: [['2201', '07:55'], ['6058', '08:14'], ['3001', '08:30']] },
    { id: 'B6v', route: 'B6', headsign: 'Piazzale Roma', stops: [['6057', '08:13'], ['2201', '08:40']] },
    { id: 'T1n', route: 'T1', headsign: 'Venezia', stops: [['3001', '24:05'], ['6057', '24:20'], ['2201', '24:40']] }
  ]
};
const SERVIZI = { 20261125: ['FER'], 20261126: ['FER'], 20261208: ['FES'] };
const rete = (live = {}) => F.gtfs(CORSE, SERVIZI, live);
const dire = (amb, adesso = F.ADESSO) => {
  let att = {};
  return async (intent, slots = {}, extra = {}) => {
    const r = await gestisci(F.richiesta(intent, slots, { adesso, attributi: att, ...extra }), amb);
    att = r.body.sessionAttributes || {};
    return { r, testo: F.parlato(r), att, fine: r.body.response.shouldEndSession };
  };
};
test.beforeEach(() => Ctx._reset());

// ---------- motore delle corse dirette ----------
test('motore: corse dirette Rialto → Piazzale Roma su tutta la giornata di servizio, nell\'ordine giusto', async () => {
  const { motore } = rete();
  const r = await Dir.cerca(motore, { da: ['nav:1101'], a: ['nav:1201'], ymd: '20261125' });
  assert.deepEqual(r.righe.map(x => x.tripId), ['L1a', 'L2', 'L1b', 'NN']);
  const nn = r.righe.at(-1);
  assert.equal(nn.dep, F.secsDi('25:10')); assert.equal(nn.arr, F.secsDi('25:25')); assert.equal(nn.to, 'nav:1201');
  // circolare: si sale alla prima Rialto (a metà corsa) e si arriva alla seconda Piazzale Roma; dall'ultima Rialto (capolinea) non si sale
  const l2 = r.righe.find(x => x.tripId === 'L2'); assert.equal(l2.i, 1); assert.equal(l2.j, 3);
  assert.ok(!r.righe.some(x => x.tripId === 'L1fest'), 'servizio festivo escluso di mercoledì');
  assert.ok(!r.righe.some(x => x.tripId === 'L1inv'), 'una corsa che passa da Piazzale Roma prima di Rialto non porta a Piazzale Roma');
  const fest = await Dir.cerca(motore, { da: ['nav:1101'], a: ['nav:1201'], ymd: '20261208' });
  assert.deepEqual(fest.righe.map(x => x.tripId), ['L1fest'], 'calendario: nei festivi solo il servizio festivo');
});
test('motore: direzione a testo, linee, route_type (tram ≠ autobus), soppressioni dal tempo reale, nessun GTFS', async () => {
  const { motore } = rete({ aut: { T1v: { cancelled: true, skipped: new Set() }, B6v: { cancelled: false, skipped: new Set([0]) } } });
  const tram = await Dir.cerca(motore, { da: ['aut:6057', 'aut:6058'], ymd: '20261125', tipi: [0] });
  assert.deepEqual(tram.righe.map(x => x.tripId).sort(), ['T1f', 'T1n', 'T1v']);
  const bus = await Dir.cerca(motore, { da: ['aut:6057', 'aut:6058'], ymd: '20261125', tipi: [3] });
  assert.deepEqual(bus.righe.map(x => x.tripId), ['B6v']); assert.equal(bus.righe[0].cancel, 'stop');
  const verso = await Dir.cerca(motore, { da: ['aut:6057', 'aut:6058'], ymd: '20261125', dirTesto: 'Favaro' });
  assert.deepEqual(verso.righe.map(x => x.tripId), ['T1f']);
  assert.equal(tram.righe.find(x => x.tripId === 'T1v').cancel, 'trip');
  const linea = await Dir.cerca(motore, { da: ['nav:1101'], ymd: '20261125', linee: ['5.1'] });
  assert.deepEqual(linea.righe.map(x => x.tripId), ['L51']);
  const vuoto = await Dir.cerca({ ...motore, G: async () => null }, { da: ['nav:1101'], ymd: '20261125' });
  assert.deepEqual(vuoto.nessunGtfs, ['nav']);
});

// ---------- caso di regressione: San Marco Cattaneo, tram verso Venezia ----------
function zonaCattaneo(G) {
  return F.zona([
    F.conG(F.partenza({ stop: 'aut:6058', line: 'T1', tripId: 'T1f', headsign: 'Monte Celo Favaro', schedIn: 4, delay: 0 }), G.aut, 1),
    F.conG(F.partenza({ stop: 'aut:6057', line: '6', tripId: 'B6v', headsign: 'Piazzale Roma', schedIn: 3, delay: 0 }), G.aut, 0),
    F.conG(F.partenza({ stop: 'aut:6057', line: 'T1', tripId: 'T1v', headsign: 'Venezia', schedIn: 5, delay: 0 }), G.aut, 1)
  ]);
}
test('regressione: «tra quanto passa il prossimo tram a San Marco Cattaneo in direzione Venezia» → T1, fermata 1, mai l\'altra direzione né l\'autobus', async () => {
  const gt = rete(), amb = F.ambiente({ '/api/zone': zonaCattaneo(gt.G), '/api/avvisi': { items: [] } }, { gtfs: gt }), d = dire(amb);
  const a = await d('ProssimaCorsaIntent', { mezzo: 'tram', luogo: 'San Marco Cattaneo', direzione: 'Venezia' });
  assert.equal(a.testo, 'Il tram ti uno per Venezia passa tra cinque minuti, alle otto e quindici, dalla fermata San Marco Cattaneo 1.');
  assert.match(amb.chiamate.find(c => c.startsWith('/api/zone')), /aut%3A6057.*aut%3A6058|aut:6057.*aut:6058/);
  // «nell'altra direzione»: la stessa fermata, l'altro senso di marcia (fermata 2), poi «e l'ultimo?» resta in quella direzione
  const b = await d('AltraDirezioneIntent');
  assert.equal(b.testo, 'Il tram ti uno per Monte Celo Favaro passa tra quattro minuti, alle otto e quattordici, dalla fermata San Marco Cattaneo 2.');
  const c = await d('UltimaCorsaIntent');
  assert.match(c.testo, /^L'ultima corsa da San Marco Cattaneo verso Monte Celo Favaro parte alle otto e quattordici, con il tram ti uno per Monte Celo Favaro, dalla fermata San Marco Cattaneo 2\. È un orario programmato\.$/);
  // «no, verso Venezia» cambia solo la direzione; l'ultima di oggi è dopo mezzanotte e lo dice
  const e = await d('CorrezioneIntent', { direzione: 'Venezia' });
  assert.match(e.testo, /^L'ultima corsa da San Marco Cattaneo verso Venezia parte a mezzanotte e venti, nella notte tra mercoledì e giovedì, con il tram ti uno per Venezia, dalla fermata San Marco Cattaneo 1\./);
});
test('pontile o numero detto con il nome: «San Marco Cattaneo uno» usa solo quella fermata', async () => {
  assert.deepEqual(etichettaDetta('San Marco Cattaneo uno'), { etichetta: '1', base: 'San Marco Cattaneo' });
  assert.deepEqual(etichettaDetta('Rialto pontile C'), { etichetta: 'C', base: 'Rialto' });
  assert.equal(etichettaDetta('Zattere'), null);
  const gt = rete(), amb = F.ambiente({ '/api/zone': zonaCattaneo(gt.G), '/api/avvisi': { items: [] } }, { gtfs: gt }), d = dire(amb);
  await d('ProssimaCorsaIntent', { luogo: 'San Marco Cattaneo due' });
  const q = amb.chiamate.find(c => c.startsWith('/api/zone'));
  assert.ok(q.includes('6058') && !q.includes('6057'), q);
});

// ---------- singolare, plurale, quantità, seguiti con identità delle corse ----------
const tre = () => [F.partenza({ tripId: 'A', line: '5.1', schedIn: 3, delay: 0 }), F.partenza({ tripId: 'B', line: '2', headsign: 'S. Marco-San Zaccaria "F"', schedIn: 6, delay: 4 }), F.partenza({ tripId: 'C', line: '6', headsign: 'P.le Roma "F"', schedIn: 9, live: false }), F.partenza({ tripId: 'D', line: '5.1', schedIn: 14, delay: 0 })];
test('una corsa per la domanda singolare, tre per la plurale, il numero detto è rispettato', async () => {
  const amb = F.ambiente({ '/api/zone': F.zona(tre()), '/api/avvisi': { items: [] } }), d = dire(amb);
  const uno = await d('ProssimaCorsaIntent', { luogo: 'Zattere' });
  assert.equal(uno.testo, 'La linea cinque punto uno per Lido Santa Maria Elisabetta passa tra tre minuti, alle otto e tredici, dal pontile B, in orario.'.replace(', in orario', ''));
  const piu = await d('PartenzeIntent', { luogo: 'Zattere' });
  assert.equal((piu.testo.match(/\blinea\b/gi) || []).length, 3, piu.testo);
  assert.match(piu.testo, /Poi la linea due per San Marco, San Zaccaria tra dieci minuti, alle otto e venti, pontile B, con quattro minuti di ritardo\. Infine la linea sei per Piazzale Roma tra nove minuti, alle otto e diciannove, pontile B\./);
  assert.match(piu.testo, /Per la corsa delle otto e diciannove non ho una previsione aggiornata\./);
  const due = await d('PartenzeIntent', { luogo: 'Zattere', numero: '2' });
  assert.equal((due.testo.match(/\blinea\b/gi) || []).length, 2);
  assert.equal(due.fine, false, 'microfono aperto per i seguiti');
  assert.doesNotMatch(due.testo, /\?$/, 'nessuna domanda in coda');
});
test('«e quello dopo?» non ripete né salta corse anche se l\'elenco cambia ordine (identità della corsa)', async () => {
  let giro = 0;
  const amb = F.ambiente({ '/api/zone': () => (giro++ === 0 ? F.zona(tre()) : F.zona([F.partenza({ tripId: 'B', line: '2', headsign: 'S. Marco-San Zaccaria "F"', schedIn: 5, delay: 4 }), F.partenza({ tripId: 'A', line: '5.1', schedIn: 3, delay: 4, expIn: 7 }), F.partenza({ tripId: 'C', line: '6', headsign: 'P.le Roma "F"', schedIn: 8, live: false })])), '/api/avvisi': { items: [] } }), d = dire(amb);
  await d('ProssimaCorsaIntent', { luogo: 'Zattere' });
  const p = await d('ProssimoIntent');
  assert.match(p.testo, /^Poi la linea due per San Marco, San Zaccaria passa tra/);
  const q = await d('ProssimoIntent');
  assert.match(q.testo, /^Poi la linea sei per Piazzale Roma/, 'la A (ora in ritardo) non torna');
});
test('mezzo e stato: in fermata, soppressa (con la successiva utilizzabile), stima vecchia, ritardo oltre l\'ora', async () => {
  const deps = [F.partenza({ tripId: 'X', line: '2', schedIn: 1, cancel: 'trip' }), F.partenza({ tripId: 'Y', line: '2', schedIn: 4, delay: 0, stale: { min: 7, why: 'gps' } }), F.partenza({ tripId: 'Z', line: '2', schedIn: 0, atStop: true })];
  const amb = F.ambiente({ '/api/zone': F.zona(deps), '/api/avvisi': { items: [] } }), d = dire(amb);
  const a = await d('ProssimaCorsaIntent', { linea: 'due', luogo: 'Zattere' });
  assert.match(a.testo, /delle otto e undici è soppressa/); assert.match(a.testo, /l'ultima previsione risale a sette minuti fa/);
  const amb2 = F.ambiente({ '/api/zone': F.zona([F.partenza({ tripId: 'Z', line: '2', schedIn: 0, atStop: true })]), '/api/avvisi': { items: [] } });
  assert.match((await dire(amb2)('ProssimaCorsaIntent', { luogo: 'Zattere' })).testo, /^La linea due per Lido Santa Maria Elisabetta è in fermata, al pontile B\.$/);
  const amb3 = F.ambiente({ '/api/zone': F.zona([F.partenza({ tripId: 'R', line: '2', schedIn: 2, delay: 75 })]), '/api/avvisi': { items: [] } });
  assert.match((await dire(amb3)('ProssimaCorsaIntent', { luogo: 'Zattere' })).testo, /con un'ora e quindici di ritardo/);
});
test('nessuna corsa: lo dice con l\'intervallo vero; con un filtro dice che passano altre corse', async () => {
  const amb = F.ambiente({ '/api/zone': F.zona([F.partenza({ line: '5.1' })]), '/api/avvisi': { items: [] } });
  const a = await dire(amb)('ProssimaCorsaIntent', { linea: 'quattro punto uno', luogo: 'Zattere' });
  assert.equal(a.testo, 'Non risultano partenze della linea quattro punto uno da Zattere nelle prossime due ore. Da qui passano però altre corse.');
});

// ---------- prima e ultima corsa ----------
test('ultima corsa Rialto → Piazzale Roma: la più tarda dell\'intera giornata di servizio, anche dopo mezzanotte', async () => {
  const amb = F.ambiente({}, { gtfs: rete() }), d = dire(amb);
  const a = await d('UltimaCorsaIntent', { mezzo: 'vaporetto', luogo: 'Rialto', arrivo: 'Piazzale Roma' });
  assert.equal(a.testo, 'L\'ultimo collegamento diretto parte all\'una e dieci, nella notte tra mercoledì e giovedì, con la linea enne per Piazzale Roma, dal pontile C. Arriva all\'una e venticinque. È un orario programmato.');
  assert.equal(amb.richiesteDirette[0].ymd, '20261125');
  assert.deepEqual(amb.richiesteDirette[0].a.sort(), ['nav:1201']);
  // «e domani?» cambia solo il giorno
  const b = await d('DomaniIntent');
  assert.match(b.testo, /^Domani, l'ultimo collegamento diretto parte all'una e dieci, nella notte tra giovedì e venerdì/);
  // data esplicita festiva: altro calendario
  const c = await d('UltimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma', data: '2026-12-08' });
  assert.match(c.testo, /^Martedì 8 dicembre, l'ultimo collegamento diretto parte alle ventitré e cinquantacinque/);
});
test('ultima corsa già passata (all\'una e mezza di notte) e prima corsa di domani', async () => {
  const amb = F.ambiente({}, { gtfs: rete(), adesso: F.MS(2026, 11, 26, 0, 30) });
  const a = await dire(amb, F.MS(2026, 11, 26, 0, 30))('UltimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma' });
  assert.equal(a.testo, 'L\'ultima corsa programmata da Rialto a Piazzale Roma era all\'una e dieci. Non ne risultano altre per oggi.');
  const amb2 = F.ambiente({}, { gtfs: rete() });
  const b = await dire(amb2)('PrimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma' });
  assert.equal(b.testo, 'Domani, il primo collegamento diretto parte alle otto e trenta, con la linea uno per Piazzale Roma, dal pontile C. Arriva alle otto e quarantacinque. È un orario programmato.');
});
test('nessun collegamento diretto → propone il percorso con cambi; «sì» lo calcola', async () => {
  const amb = F.ambiente({ '/api/percorso': F.percorso([F.soluzione()]), '/api/avvisi': { items: [] }, '/api/tide': F.marea() }, { gtfs: rete() }), d = dire(amb);
  const a = await d('UltimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Mestre' });
  assert.equal(a.testo, 'Non risultano collegamenti diretti da Rialto a Mestre stazione oggi. Vuoi che cerchi un percorso con cambi?');
  const b = await d('ConfermaIntent');
  assert.match(b.testo, /^Ti consiglio la linea due/);
  assert.ok(amb.chiamate.some(c => c.startsWith('/api/percorso')));
});
test('orari programmati di un altro giorno: dall\'intero GTFS della data, «e il prossimo» continua da lì', async () => {
  const amb = F.ambiente({ '/api/avvisi': { items: [] } }, { gtfs: rete() }), d = dire(amb);
  const a = await d('ProssimaCorsaIntent', { luogo: 'Rialto', data: '2026-11-26', ora: '08:00' });
  assert.equal(a.testo, 'Domani, dalle otto, la prima corsa è la linea cinque punto uno per Lido Santa Maria Elisabetta alle otto e venti, pontile C. È un orario programmato.');
  const b = await d('ProssimoIntent');
  assert.equal(b.testo, 'Poi c\'è la linea uno per Piazzale Roma alle otto e trenta, pontile C.');
  const c = await d('DomaniIntent', { ora: '23:00' });
  assert.match(c.testo, /^Domani, dalle ventitré, la prima corsa è la linea uno per Piazzale Roma alle ventitré e trenta/);
});

// ---------- caricamento, riprova, errori ----------
test('orari in caricamento (409): lo dice con il giorno, «riprova» ripete la stessa richiesta; di nuovo in caricamento → «non ancora pronti»', async () => {
  let n = 0;
  const err = () => (n++ < 2 ? Object.assign(new Error('carico'), { code: 409 }) : null);
  const amb = F.ambiente({}, { gtfs: rete(), errDiretti: err }), d = dire(amb);
  const a = await d('UltimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma', data: '2026-12-08' });
  assert.equal(a.testo, 'Sto caricando gli orari di martedì 8 dicembre. Vuoi riprovare tra poco?');
  assert.equal(a.fine, false);
  const b = await d('RiprovaIntent');
  assert.equal(b.testo, 'Gli orari di martedì 8 dicembre non sono ancora pronti. Riprova tra poco.');
  const c = await d('AMAZON.YesIntent');
  assert.match(c.testo, /^Martedì 8 dicembre, l'ultimo collegamento diretto/);
  assert.ok(amb.richiesteDirette.every(q => q.ymd === '20261208'), 'stessi parametri a ogni tentativo');
});
test('server occupato o sovraccarico → frase onesta, richiesta conservata; aiuto e chiusura funzionano lo stesso', async () => {
  const amb = F.ambiente({ '/api/zone': () => Object.assign(new Error('x'), { code: 503 }) }), d = dire(amb);
  const a = await d('ProssimaCorsaIntent', { luogo: 'Zattere' });
  assert.equal(a.testo, MSG.occupato); assert.equal(a.att.riprova.tipo, 'partenze');
  const amb2 = F.ambiente({}, { occupato: true }), d2 = dire(amb2);
  assert.equal((await d2('ProssimaCorsaIntent', { luogo: 'Zattere' })).testo, MSG.occupato);
  assert.equal((await d2('AMAZON.HelpIntent')).testo, MSG.aiuto);
  assert.equal((await d2('AMAZON.StopIntent')).testo, MSG.chiusura);
});

// ---------- apertura, aiuto, presentazione ----------
test('apertura «Ciao! Cosa vuoi sapere?»; aiuto breve e per categoria; presentazione; tutti i comandi', async () => {
  const amb = F.ambiente({}), d = dire(amb);
  assert.equal((await d(null, {}, { tipo: 'LaunchRequest' })).testo, 'Ciao! Cosa vuoi sapere?');
  assert.equal((await d('AMAZON.HelpIntent')).testo, 'Puoi chiedermi partenze, percorsi, marea o avvisi. Su cosa vuoi una mano?');
  for (const [cat, re] of [['partenze', /quando passa il due alle Zattere/], ['percorsi', /come arrivo a Rialto da Piazzale Roma/], ['marea', /prossimo colmo, il MOSE/], ['avvisi', /scioperi domani/], ['riepilogo', /routine/]]) {
    const r = await d('AiutoIntent', { categoria: { value: cat, resolutions: { resolutionsPerAuthority: [{ status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { id: cat, name: cat } }] }] } } });
    assert.match(r.testo, re, cat); assert.equal(r.fine, false);
  }
  const p = await d('PresentatiIntent');
  assert.match(p.testo, /^Sono Venezia TPL, un servizio indipendente/); assert.match(p.testo, /Non sono un servizio ufficiale ACTV/);
  assert.match((await d('TuttiComandiIntent')).testo, /una categoria alla volta/);
  // invocazione diretta con domanda: nessun benvenuto
  const amb2 = F.ambiente({ '/api/tide': F.marea(), '/api/mose': F.mose('recesso') });
  assert.doesNotMatch((await dire(amb2)('MareaIntent')).testo, /Ciao/);
});

// ---------- seguiti ----------
test('seguiti: ripeti (segnala che è una risposta di prima), aggiorna (ricalcola), «solo vaporetti», contesto assente', async () => {
  let giro = 0;
  const amb = F.ambiente({ '/api/zone': () => F.zona([F.partenza({ tripId: 'BUS', stop: 'aut:2201', line: '6', headsign: 'Mestre FS "C"', schedIn: 2 }), F.partenza({ tripId: 'A' + giro++, stop: 'nav:1201', line: '5.1', schedIn: 5 })]), '/api/avvisi': { items: [] } }), d = dire(amb);
  assert.equal((await d('ProssimoIntent')).testo, MSG.contestoAssente);
  const a = await d('ProssimaCorsaIntent', { luogo: 'Piazzale Roma' });
  assert.match(a.testo, /^La linea sei/);
  const r = await d('RipetiIntent');
  assert.equal(r.testo, 'Ripeto la risposta di prima. ' + a.testo);
  const v = await d('CorrezioneIntent', { mezzo: 'vaporetto' });
  assert.match(v.testo, /^La linea cinque punto uno/);
  const g = await d('AggiornaIntent');
  assert.match(g.testo, /^La linea cinque punto uno/); assert.ok(giro >= 3, 'ha riletto i dati');
});
test('itinerario sintetico; «dimmi i dettagli» dà le tappe; «e al ritorno» inverte; destinazione mancante', async () => {
  const sol = F.soluzione();
  const amb = F.ambiente({ '/api/percorso': F.percorso([sol]), '/api/avvisi': { items: [] }, '/api/tide': F.marea() }), d = dire(amb);
  const a = await d('ItinerarioIntent', { partenza: 'Zattere', arrivo: 'San Marco' });
  assert.equal(a.testo, 'Ti consiglio la linea due, alle otto e quattordici, dal pontile B. Arriverai alle otto e trentatré, tra circa ventuno minuti. Parte con due minuti di ritardo.');
  const b = await d('DettagliIntent');
  assert.match(b.testo, /Cammina un minuto fino a Zattere, pontile B\. Prendi la linea due/); assert.match(b.testo, /stimati in linea d'aria/);
  await d('RitornoIntent');
  const q = amb.chiamate.filter(c => c.startsWith('/api/percorso')).at(-1);
  assert.match(decodeURIComponent(q), /da=nav:13.*a=nav:100/);
  const c = await d('ItinerarioIntent', { partenza: 'Zattere' });
  assert.equal(c.testo, MSG.destinazioneMancante);
});
test('itinerario con cambio a rischio, arrivo entro un orario, acqua alta sul tragitto', async () => {
  const s = F.soluzione();
  const m2 = { tipo: 'mezzo', src: 'nav', mode: 'nav', line: '5.2', color: '#8FD2BF', headsign: 'Lido S.M.E. "B"', da: { id: 'nav:1102', name: 'Rialto "D"', exp: '08:25', sched: '08:25', live: true, delay: 0 }, a: { id: 'nav:1501', name: 'Lido S.M.E. "B"', exp: '08:50', sched: '08:50' }, aRischio: true, cambioMin: 1 };
  s.tratte.splice(2, 0, m2); s.cambi = 1; s.arrivi = '08:52';
  const amb = F.ambiente({ '/api/percorso': F.percorso([{ ...s, margine: 8 }]), '/api/avvisi': { items: [] }, '/api/tide': F.marea({ cm: 105, extremes: [F.estremo('max', 115, 1)] }) });
  const a = await dire(amb)('ItinerarioEntroIntent', { partenza: 'Zattere', arrivo: 'Lido', ora: '09:00' });
  assert.match(a.testo, /^Ti consiglio di partire alle otto e dodici con la linea due, dal pontile B\. Arriverai alle otto e cinquantadue, con otto minuti di margine\./);
  assert.match(a.testo, /Attenzione: hai solo un minuto per il cambio a Rialto, pontile D\./);
  assert.match(a.testo, /alcuni tratti a piedi potrebbero essere allagati/);
});

// ---------- riepilogo e routine ----------
test('riepilogo con fermata: prima la corsa, poi marea e avviso principale; la sessione si chiude (routine)', async () => {
  const gt = rete();
  const amb = F.ambiente({ '/api/zone': zonaCattaneo(gt.G), '/api/tide': F.marea({ cm: 70 }), '/api/mose': F.mose('recesso'), '/api/avvisi': { updated: F.ADESSO, items: [F.avviso({ title: 'Linea 2 deviata', effect: 'detour', lines: [{ n: '2', s: 'nav' }] }), F.avviso({ title: 'Linea 6 ritardi', lines: [{ n: '6', s: 'aut' }] })] } }, { gtfs: gt });
  const a = await dire(amb)('RiepilogoIntent', { momento: 'mattina', luogo: 'San Marco Cattaneo', mezzo: 'tram', direzione: 'Venezia' });
  assert.match(a.testo, /^Il tram ti uno per Venezia passa tra cinque minuti/);
  assert.ok(a.testo.indexOf('marea') > 0 && a.testo.indexOf('avvisi') > a.testo.indexOf('marea'), a.testo);
  assert.match(a.testo, /Ci sono due avvisi; il più importante:/);
  assert.equal(a.fine, true);
});

// ---------- qualità della voce ----------
test('voce: nessuna doppia preposizione o punteggiatura sbagliata, SSML con un solo escape, attributi senza identificativi', async () => {
  const gt = rete();
  const amb = F.ambiente({ '/api/zone': zonaCattaneo(gt.G), '/api/avvisi': { items: [] }, '/api/percorso': F.percorso([F.soluzione()]), '/api/tide': F.marea() }, { gtfs: gt });
  const d = dire(amb), risposte = [];
  for (const [i, s] of [['ProssimaCorsaIntent', { mezzo: 'tram', luogo: 'San Marco Cattaneo', direzione: 'Venezia' }], ['PartenzeIntent', { luogo: 'San Marco Cattaneo' }], ['UltimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma' }],
    ['PrimaCorsaIntent', { luogo: 'Rialto' }], ['LineeIntent', { luogo: 'Rialto' }], ['ItinerarioIntent', { partenza: 'Zattere', arrivo: 'San Marco' }], ['ProssimaCorsaIntent', { luogo: 'Rialto', data: '2026-11-26', ora: '18:00' }]]) risposte.push(await d(i, s));
  for (const x of risposte) {
    const ssml = x.r.body.response.outputSpeech.ssml;
    assert.doesNotMatch(ssml, /&amp;(amp|apos|quot|lt|gt);/, 'doppio escape');
    assert.doesNotMatch(ssml, /&(?!(amp|apos|quot|lt|gt);)/, 'carattere & non protetto');
    assert.doesNotMatch(x.testo, /\b(le le|dalle le|alle le|a alle|Su la|di il|fino a alle)\b|\s[,.;:]|\.\.|,\./, x.testo);
    assert.doesNotMatch(x.testo, /undefined|null|NaN|\[object|https?:|"/, x.testo);
    const att = JSON.stringify(x.att);
    assert.doesNotMatch(att, /amzn1\.ask\.(account|device)|SEGRETO/);
    assert.ok(att.length < 9000);
  }
  assert.match(risposte[4].testo, /^Oggi da Rialto passano le linee/);
});
