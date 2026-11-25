// SKILL ALEXA: prove di tutti gli intenti con dati simulati e riproducibili (tests/alexa-fixtures.js). Nessuna rete, nessun orologio reale.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./alexa-fixtures');
const { gestisci } = require('../alexa/skill');
const APL = require('../alexa/apl');

// una richiesta e la sua risposta; la sessione si porta dietro gli attributi come fa Alexa
function sessione(scen, opz = {}) {
  const amb = F.ambiente(scen, opz); let attr = {};
  const dire = async (intent, slots = {}, extra = {}) => {
    const r = await gestisci(F.richiesta(intent, slots, { adesso: opz.adesso ?? F.ADESSO, attributi: attr, ...extra }), amb);
    assert.equal(r.status, 200, `stato ${r.status} per ${intent}`);
    attr = r.body.sessionAttributes || {};
    return { ...r, testo: F.parlato(r), fine: r.body.response.shouldEndSession, attr };
  };
  return { dire, amb };
}
const SCEN_BASE = (extra = {}) => ({ '/api/avvisi': { updated: F.ADESSO - 60e3, stale: false, items: [] }, '/api/tide': F.marea(), '/api/mose': F.mose('recesso'), ...extra });

// ---------------------------------------------------------------- PARTENZE
test('partenze: filtri per linea e per direzione, nome con errore di riconoscimento, linea detta a parole', async () => {
  const zone = F.zona([F.partenza({ line: '5.1', schedIn: 2 }), F.partenza({ line: '2', headsign: 'S. Marco-San Zaccaria "F"', schedIn: 4 }), F.partenza({ line: '2', headsign: 'Giudecca Palanca "A"', schedIn: 9 })], { nexts: { n0: { s: ['Rialto'] } } });
  const { dire } = sessione(SCEN_BASE({ '/api/zone': zone }));
  const a = await dire('PartenzeIntent', { luogo: 'zatere', linea: { value: 'due', resolutions: { resolutionsPerAuthority: [{ status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { id: '2', name: 'due' } }] }] } } });
  assert.match(a.testo, /linea due per San Marco/i);
  assert.doesNotMatch(a.testo, /cinque punto uno/);
  const b = await dire('PartenzeIntent', { luogo: 'Zattere', direzione: 'Giudecca' });
  assert.match(b.testo, /Giudecca/);
  assert.doesNotMatch(b.testo, /San Marco/);
});
test('partenze: manca la fermata → la chiede; il nome detto da solo la completa', async () => {
  const { dire } = sessione(SCEN_BASE({ '/api/zone': F.zona([F.partenza({ line: '5.2' })]) }));
  const q = await dire('PartenzeIntent', { linea: '5.2' });
  assert.equal(q.testo, 'Da quale fermata?');
  const r = await dire('LuogoIntent', { luogo: 'Zattere' });
  assert.match(r.testo, /linea cinque punto due/);
});
test('partenze: fermata sconosciuta → ammette di non conoscerla', async () => {
  const { dire } = sessione(SCEN_BASE({ '/api/zone': F.zona([]) }));
  const r = await dire('PartenzeIntent', { luogo: 'Xyzzyqwk' });
  assert.match(r.testo, /Non conosco la fermata/);
});
test('partenze: avviso di fermata sospesa in corso viene detto', async () => {
  const av = { updated: F.ADESSO, stale: false, items: [F.avviso({ title: 'Fermata Zattere B sospesa per lavori', effect: 'no_service', severity: 'severe', stops: ['nav:1002'], ambito: 'fermate' })] };
  const { dire } = sessione(SCEN_BASE({ '/api/zone': F.zona([F.partenza({})]), '/api/avvisi': av }));
  const r = await dire('PartenzeIntent', { luogo: 'Zattere' });
  assert.match(r.testo, /Attenzione: Fermata Zattere B sospesa per lavori/);
});

// ---------------------------------------------------------------- ULTIMA CORSA, RITARDI, NOTTE
test('ritardo senza linea né fermata → chiede; con la linea detta dopo risponde', async () => {
  const { dire } = sessione(SCEN_BASE({ '/api/vehicles': { vehicles: [] } }));
  const q = await dire('RitardoIntent', {});
  assert.equal(q.testo, 'Di quale linea o fermata?');
  const r = await dire('LuogoIntent', { luogo: 'il 5.2' });
  assert.match(r.testo, /Adesso non vedo mezzi in servizio sulla linea cinque punto due/);
});

// ---------------------------------------------------------------- ITINERARI
test('itinerario: nessuna soluzione, solo a piedi, fermate assenti; senza cambi e preferenze nella richiesta', async () => {
  let s = sessione(SCEN_BASE({ '/api/percorso': F.percorso([], { piedi: 14 }) }));
  let r = await s.dire('ItinerarioIntent', { partenza: 'Zattere', arrivo: 'Rialto', cambi: { value: '0' } });
  assert.match(s.amb.chiamate[0], /cambi=0/);
  assert.match(r.testo, /Non trovo un collegamento da Zattere a Rialto nelle prossime ore senza cambi/);
  assert.match(r.testo, /A piedi servirebbero circa quattordici minuti, in linea d'aria/);
  s = sessione(SCEN_BASE({ '/api/percorso': F.percorso([], { senzaFermate: 'a' }) }));
  r = await s.dire('ItinerarioIntent', { partenza: 'Zattere', arrivo: 'Rialto' });
  assert.match(r.testo, /Non trovo fermate utilizzabili vicino a Rialto/);
  s = sessione(SCEN_BASE({ '/api/percorso': F.percorso([F.soluzione()]) }));
  await s.dire('ItinerarioIntent', { partenza: 'Zattere', arrivo: 'San Marco', preferenza: { value: 'meno cambi', resolutions: { resolutionsPerAuthority: [{ status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { id: 'cambi', name: 'meno cambi' } }] }] } } });
  const perc = () => s.amb.chiamate.filter(c => c.startsWith('/api/percorso'));
  assert.match(perc()[0], /pref=cambi/);
  await s.dire('SenzaCambiIntent');
  assert.match(perc()[1], /cambi=0/);
  await s.dire('RitornoIntent');
  assert.match(perc()[2], /^\/api\/percorso\?da=nav%3A130[12].*&a=nav%3A100[12]/, 'il ritorno inverte partenza e arrivo');
});
test('marea: livello, tendenza, prossimo colmo e fonte; dato vecchio segnalato', async () => {
  const t = F.marea({ cm: 62, trend: 'up', extremes: [F.estremo('max', 96, 3)] });
  let r = await sessione(SCEN_BASE({ '/api/tide': t })).dire('MareaIntent');
  assert.match(r.testo, /marea misurata è sessantadue centimetri.*in crescita/);
  assert.match(r.testo, /prossimo colmo è previsto alle undici e dieci, intorno a novantasei centimetri/);
  r = await sessione(SCEN_BASE({ '/api/tide': F.marea({ cm: 62, ageMin: 45, stale: true }) })).dire('MareaIntent');
  assert.match(r.testo, /Attenzione: l'ultima misura risale a quarantacinque minuti fa/);
});
for (const [livello, atteso, nome, senzaMose] of [[105, /marea sostenuta/, '+105 cm', false], [120, /acqua alta/, '+120 cm', true]]) {
  test(`acqua alta simulata a ${nome}: stati, MOSE e stivali`, async () => {
    const t = F.marea({ cm: livello - 20, trend: 'up', extremes: [F.estremo('max', livello, 2), F.estremo('min', 30, 8)] });
    const s = sessione(SCEN_BASE({ '/api/tide': t }));
    const a = await s.dire('AcquaAltaIntent', {});
    assert.match(a.testo, atteso);
    assert.match(a.testo, /massimo previsto è .* centimetri, alle dieci e dieci/);
    if (senzaMose) assert.match(a.testo, /senza MOSE/); else assert.doesNotMatch(a.testo, /senza MOSE/);
    assert.doesNotMatch(a.testo, /fino a alle/);
    assert.match(a.testo, /Sono previsioni e possono cambiare/);
    const st = await s.dire('StivaliIntent', {});
    assert.match(st.testo, /Sì, conviene averli/);
    const c = await s.dire('ColmoIntent', {});
    assert.match(c.testo, atteso.source.includes('sostenuta') ? /marea sostenuta/ : /acqua alta/);
  });
}
test('acqua alta: marea bassa → nessuna acqua alta; previsione che non copre la finestra → lo dichiara', async () => {
  let r = await sessione(SCEN_BASE({ '/api/tide': F.marea({ cm: 40, extremes: [F.estremo('max', 70, 3)] }) })).dire('AcquaAltaIntent', {});
  assert.match(r.testo, /Non è prevista acqua alta/);
  r = await sessione(SCEN_BASE({ '/api/tide': F.marea({ cm: 40, extremes: [F.estremo('max', 70, 3), F.estremo('min', 20, 9)] }) })).dire('AcquaAltaIntent', { data: '2026-11-27' });
  assert.match(r.testo, /Per dopodomani non ho ancora una previsione: quella disponibile arriva fino a/);
  r = await sessione(SCEN_BASE({ '/api/tide': F.marea({ cm: 40, extremes: [] }) })).dire('AcquaAltaIntent', {});
  assert.match(r.testo, /Non ho previsioni di marea/);
});
test('acqua alta per una parte del giorno (stasera): finestra serale', async () => {
  const t = F.marea({ cm: 50, extremes: [F.estremo('max', 85, 11), F.estremo('min', 20, 17)] });
  const r = await sessione(SCEN_BASE({ '/api/tide': t })).dire('AcquaAltaIntent', { ora: 'EV' });
  assert.match(r.testo, /Per stasera il massimo previsto/);
});
test('MOSE: recesso, sollevato, errore di lettura, dato non aggiornato', async () => {
  let r = await sessione(SCEN_BASE({ '/api/mose': F.mose('recesso') })).dire('MoseIntent');
  assert.match(r.testo, /Il MOSE non è sollevato/);
  assert.match(r.body.response.outputSpeech.ssml, /<phoneme alphabet="ipa" ph="ˈmɔze">MOSE<\/phoneme>/, 'pronuncia «mòze»');
  r = await sessione(SCEN_BASE({ '/api/mose': F.mose('sollevata') })).dire('MoseIntent');
  assert.match(r.testo, /Il MOSE è sollevato/);
  r = await sessione(SCEN_BASE({ '/api/mose': F.mose('sollevata', { stale: true, letto: F.ADESSO - 50 * 60e3 }) })).dire('MoseIntent');
  assert.match(r.testo, /non è aggiornato da cinquanta minuti/);
  r = await sessione(SCEN_BASE({ '/api/mose': { error: 'non disponibile' } })).dire('MoseIntent');
  assert.match(r.testo, /non riesco a leggere lo stato del/);
});
test('con MOSE sollevato e marea prevista alta, la città conta il livello limitato (88 cm), con la dicitura', async () => {
  const t = F.marea({ cm: 95, trend: 'up', extremes: [F.estremo('max', 125, 2)], mose: { stato: 'sollevata', sem: 'rosso' } });
  const r = await sessione(SCEN_BASE({ '/api/tide': t })).dire('StivaliIntent', {});
  assert.match(r.testo, /Il MOSE è in funzione: in città conto al massimo ottantotto centimetri/);
});
test('stivali per un luogo: quota stimata del suolo e dicitura «stima»', async () => {
  const t = F.marea({ cm: 95, trend: 'up', extremes: [F.estremo('max', 110, 2)] });
  const r = await sessione(SCEN_BASE({ '/api/tide': t })).dire('StivaliIntent', { luogo: 'San Marco' });
  assert.match(r.testo, /Per San Marco, la quota stimata del suolo è circa .* centimetri/);
  assert.match(r.testo, /È una stima, non una misura/);
});
test('passerelle: stagione, quota di posa, e mai conferma della posa reale', async () => {
  const r = await sessione(SCEN_BASE({ '/api/tide': F.marea({ cm: 95, extremes: [F.estremo('max', 120, 2)] }) })).dire('PasserelleIntent', { luogo: 'San Marco' });
  assert.match(r.testo, /Vicino a San Marco ci sono .* percorsi su passerella, con quota di posa/);
  assert.match(r.testo, /dal quindici settembre al trenta aprile/);
  assert.match(r.testo, /Non posso confermare che siano davvero montate/);
  const fuori = await sessione(SCEN_BASE({}), { adesso: F.MS(2026, 7, 10, 10, 0) }).dire('PasserelleIntent', {});
  assert.match(fuori.testo, /fuori da quel periodo: di norma le passerelle non vengono montate/);
  assert.match(fuori.testo, /Non posso confermare/);
});

// ---------------------------------------------------------------- AVVISI, SCIOPERI, RIEPILOGO
test('avvisi: sospensione, linea, validità, nessun testo intero né indirizzo', async () => {
  const av = { updated: F.ADESSO, stale: false, items: [F.avviso({ title: 'Linea 5.2 sospesa tra Lido e Ferrovia per lavori https://actv.avmspa.it/x', text: 'testo lunghissimo '.repeat(50), effect: 'no_service', severity: 'severe', lines: [{ n: '5.2', s: 'nav' }], to: F.ADESSO + 6 * 3600e3 })] };
  const r = await sessione(SCEN_BASE({ '/api/avvisi': av })).dire('AvvisiIntent', { linea: '5.2' });
  assert.match(r.testo, /C'è un avviso sulla linea cinque punto due/);
  assert.match(r.testo, /Linea 5\.2 sospesa tra Lido e Ferrovia per lavori/);
  assert.match(r.testo, /In corso fino a oggi alle quattordici e dieci/);
  assert.doesNotMatch(r.testo, /https?:|lunghissimo/);
});
test('avvisi: niente avvisi → lo dice e dichiara la copertura dei dati; dati non aggiornati → lo segnala', async () => {
  let r = await sessione(SCEN_BASE({})).dire('AvvisiIntent', {});
  assert.match(r.testo, /Non risultano avvisi di servizio/);
  assert.match(r.testo, /in corso e dei prossimi tre giorni/);
  r = await sessione(SCEN_BASE({ '/api/avvisi': { updated: F.ADESSO - 3 * 3600e3, stale: true, items: [] } })).dire('AvvisiIntent', {});
  assert.match(r.testo, /non si aggiornano da un po'/);
  r = await sessione(SCEN_BASE({})).dire('AvvisiIntent', { data: '2026-12-20' });
  assert.match(r.testo, /oltre non ho dati/, 'oltre i tre giorni lo dichiara');
});
test('sciopero: giorno intero, fasce garantite, anche se generale; fasce assenti → lo dice', async () => {
  const sc = (fasce) => F.avviso({ title: 'Sciopero generale ACTV 24 ore', effect: 'strike', general: true, state: 'upcoming', from: F.MS(2026, 11, 26, 23, 0), to: F.MS(2026, 11, 27, 22, 59), sciopero: { inizio: F.MS(2026, 11, 26, 23, 0), fine: F.MS(2026, 11, 27, 22, 59, 59), da: F.MS(2026, 11, 26, 15, 0), fino: F.MS(2026, 11, 28, 4, 0), fasce } });
  let r = await sessione(SCEN_BASE({ '/api/avvisi': { updated: F.ADESSO, stale: false, items: [sc([['05:00', '08:00'], ['17:00', '20:00']])] } })).dire('ScioperoIntent', {});
  assert.match(r.testo, /per tutto il giorno, dopodomani/i);
  assert.match(r.testo, /Fasce garantite indicate: dalle cinque alle otto e dalle diciassette alle venti/);
  assert.match(r.body.response.outputSpeech.ssml, /<say-as interpret-as="characters">ACTV<\/say-as>/);
  r = await sessione(SCEN_BASE({ '/api/avvisi': { updated: F.ADESSO, stale: false, items: [sc([])] } })).dire('ScioperoIntent', {});
  assert.match(r.testo, /fasce garantite non risultano nei dati/);
  r = await sessione(SCEN_BASE({})).dire('ScioperoIntent', {});
  assert.match(r.testo, /Non risultano scioperi comunicati/);
});
test('sicurezza: ID skill diverso, richiesta vecchia (replay), futura, versione e lingua errate', async () => {
  const amb = F.ambiente(SCEN_BASE({ '/api/zone': F.zona([]) }));
  assert.equal((await gestisci(F.richiesta('MareaIntent', {}, { appId: 'amzn1.ask.skill.altra' }), amb)).status, 403);
  assert.equal((await gestisci(F.richiesta('MareaIntent', {}, { ts: F.ADESSO - 151e3 }), amb)).status, 400, 'oltre 150 s = rifiutata');
  assert.equal((await gestisci(F.richiesta('MareaIntent', {}, { ts: F.ADESSO + 151e3 }), amb)).status, 400);
  assert.equal((await gestisci(F.richiesta('MareaIntent', {}, { ts: F.ADESSO - 140e3 }), amb)).status, 200, 'entro 150 s va bene');
  assert.equal((await gestisci({ version: '2.0', request: { type: 'IntentRequest' } }, amb)).status, 400);
  assert.equal((await gestisci(null, amb)).status, 400);
  assert.equal((await gestisci({ version: '1.0', request: {} }, amb)).status, 400);
  const inglese = await gestisci(F.richiesta('MareaIntent', {}, { locale: 'en-US' }), amb);
  assert.match(F.parlato(inglese), /solo in italiano/);
});
test('SSML: ogni risposta è ben formata (tag chiusi, niente &, niente URL) e sotto il limite di Alexa', async () => {
  const sosp = Array.from({ length: 40 }, (_, i) => F.partenza({ line: i % 2 ? '2' : '5.1', schedIn: i + 1 }));
  const { dire } = sessione(SCEN_BASE({ '/api/zone': F.zona(sosp) }));
  for (const [i, s] of [['PartenzeIntent', { luogo: "Piazzale Roma" }], ['MareaIntent', {}], ['MoseIntent', {}], ['AvvisiIntent', {}], ['RiepilogoIntent', {}]]) {
    const r = await dire(i, s), ssml = r.body.response.outputSpeech.ssml;
    assert.ok(ssml.startsWith('<speak>') && ssml.endsWith('</speak>'));
    assert.ok(ssml.length < 8000);
    assert.doesNotMatch(ssml.replace(/&(amp|lt|gt|apos|quot);/g, ''), /&/);
    assert.doesNotMatch(ssml, /https?:\/\//);
    const aperti = (ssml.match(/<(?!\/|break|speak)[a-z-]+[^>]*>/g) || []).length, chiusi = (ssml.match(/<\/(?!speak)[a-z-]+>/g) || []).length;
    assert.equal(aperti, chiusi, `tag SSML bilanciati in ${i}`);
  }
});

// ---------------------------------------------------------------- SCHERMO (APL)
test('APL: senza schermo nessuna direttiva; con schermo una scheda valida per ogni profilo', async () => {
  const sc = SCEN_BASE({ '/api/zone': F.zona([F.partenza({}), F.partenza({ line: '2', schedIn: 6, delay: 3 }), F.partenza({ line: '1', schedIn: 9, cancel: 'trip' })]) });
  const senza = await sessione(sc).dire('PartenzeIntent', { luogo: 'Zattere' });
  assert.equal(senza.body.response.directives, undefined);
  assert.match(senza.testo, /linea cinque punto uno/i, 'tutta l\'informazione è nella voce');
  for (const [nome, vp, righe] of [['rotondo', { shape: 'ROUND', pixelWidth: 480 }, 3], ['piccolo', { shape: 'RECTANGLE', pixelWidth: 480 }, 3], ['medio', { shape: 'RECTANGLE', pixelWidth: 1024 }, 3], ['largo', { shape: 'RECTANGLE', pixelWidth: 1920 }, 3]]) {
    const r = await sessione(sc).dire('PartenzeIntent', { luogo: 'Zattere' }, { schermo: true, viewport: vp });
    const d = r.body.response.directives[0];
    assert.equal(d.type, 'Alexa.Presentation.APL.RenderDocument');
    assert.equal(d.datasources.dati.righe.length, righe, nome);
    assert.equal(d.document.version, '1.9');
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(d)));
    assert.equal(d.datasources.dati.titolo, 'Zattere');
    for (const riga of d.datasources.dati.righe) { assert.match(riga.colore, /^#[0-9A-F]{6}$/); assert.match(riga.testoBadge, /^#[0-9A-F]{6}$/); assert.doesNotMatch(JSON.stringify(riga), /<|>/); }
  }
  assert.equal(APL.profilo({ context: { Viewport: { shape: 'ROUND', pixelWidth: 480 } } }), 'rotondo');
  assert.equal(APL.profilo({}), 'medio');
});
test('APL: schede per itinerario, marea, MOSE, avvisi e riepilogo', async () => {
  const sc = SCEN_BASE({ '/api/percorso': F.percorso([F.soluzione()]), '/api/tide': F.marea({ cm: 80, extremes: [F.estremo('max', 100, 2)] }), '/api/mose': F.mose('sollevata'), '/api/avvisi': { updated: F.ADESSO, stale: false, items: [F.avviso({ title: 'Linea 2 deviata', effect: 'detour', lines: [{ n: '2', s: 'nav' }] })] } });
  const { dire } = sessione(sc);
  for (const [i, s] of [['ItinerarioIntent', { partenza: 'Zattere', arrivo: 'San Marco' }], ['MareaIntent', {}], ['MoseIntent', {}], ['AvvisiIntent', {}], ['RiepilogoIntent', {}], ['AcquaAltaIntent', {}]]) {
    const r = await dire(i, s, { schermo: true, viewport: { shape: 'RECTANGLE', pixelWidth: 1280 } });
    const d = r.body.response.directives && r.body.response.directives[0];
    assert.ok(d, `scheda per ${i}`);
    assert.ok(d.datasources.dati.titolo.length > 0);
    assert.doesNotMatch(JSON.stringify(d.datasources), /<speak|<phoneme|<say-as|&apos;/, 'nella scheda niente tag di voce');
  }
});
