// CATALOGO DELLE RISPOSTE EFFETTIVE: esegue la skill vera (alexa/skill.js) su scenari riproducibili (dati inventati di tests/alexa-fixtures.js,
// orologio fisso mercoledì 25/11/2026 08:10) e scrive in alexa/FRASI_STANDARD_ALEXA_VENEZIA_TPL.md, tra i segni «CATALOGO», ogni risposta con la
// sua condizione. Così il catalogo è sempre uguale a ciò che Alexa dice. Uso: node alexa/scripts/catalogo.js   (--verifica: solo controllo)
'use strict';
const fs = require('fs');
const path = require('path');
const F = require('../../tests/alexa-fixtures');
const MSG = require('../messaggi');
const { gestisci } = require('../skill');
const Ctx = require('../contesto');

const FILE = path.join(__dirname, '..', 'FRASI_STANDARD_ALEXA_VENEZIA_TPL.md');
const CORSE = {
  nav: [
    { id: 'L1a', route: 'R1', headsign: 'P.le Roma "F"', stops: [['1101', '08:30'], ['1201', '08:45']] },
    { id: 'L1b', route: 'R1', headsign: 'P.le Roma "F"', stops: [['1101', '23:30'], ['1201', '23:45']] },
    { id: 'NN', route: 'RN', headsign: 'P.le Roma "F"', stops: [['1101', '25:10'], ['1201', '25:25']] },
    { id: 'L51', route: 'R51', headsign: 'Lido S.M.E. "B"', stops: [['1101', '08:20'], ['1501', '08:50']] }
  ],
  aut: [
    { id: 'T1v', route: 'T1', headsign: 'Venezia', stops: [['3001', '08:00'], ['6057', '08:15'], ['2201', '08:35']] },
    { id: 'T1f', route: 'T1', headsign: 'Monte Celo Favaro', stops: [['2201', '07:55'], ['6058', '08:14'], ['3001', '08:30']] }
  ]
};
const rete = () => F.gtfs(CORSE, { 20261125: ['FER'], 20261126: ['FER'] });
const zonaTram = G => F.zona([F.conG(F.partenza({ stop: 'aut:6058', line: 'T1', tripId: 'T1f', headsign: 'Monte Celo Favaro', schedIn: 4 }), G.aut, 1), F.conG(F.partenza({ stop: 'aut:6057', line: 'T1', tripId: 'T1v', headsign: 'Venezia', schedIn: 5 }), G.aut, 1)]);
const tre = () => [F.partenza({ tripId: 'A', line: '5.1', schedIn: 3 }), F.partenza({ tripId: 'B', line: '2', headsign: 'S. Marco-San Zaccaria "F"', schedIn: 6, delay: 4 }), F.partenza({ tripId: 'C', line: '6', headsign: 'P.le Roma "F"', schedIn: 9, live: false })];
const er = (id) => ({ value: id, resolutions: { resolutionsPerAuthority: [{ status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { id, name: id } }] }] } });
const base = gt => ({ '/api/zone': gt ? zonaTram(gt.G) : F.zona(tre()), '/api/avvisi': { updated: F.ADESSO, items: [] }, '/api/tide': F.marea({ cm: 72, trend: 'up', extremes: [F.estremo('max', 95, 2), F.estremo('min', 20, 8)] }), '/api/mose': F.mose('recesso'), '/api/percorso': F.percorso([F.soluzione()]), '/api/vehicles': { vehicles: [] } });

// [sezione, condizione, passi: [[intent, slots]], opzioni]
const SCENARI = [
  ['Apertura e guida', 'Apertura senza domanda', [['@Launch']]],
  ['Apertura e guida', 'Aiuto', [['AMAZON.HelpIntent']]],
  ...Object.keys(MSG.aiutoCategoria).map(c => ['Apertura e guida', `Aiuto ${c}`, [['AiutoIntent', { categoria: er(c) }]]]),
  ['Apertura e guida', 'Presentati / che cos\'è Venezia TPL', [['PresentatiIntent']]],
  ['Apertura e guida', 'Tutti i comandi', [['TuttiComandiIntent']]],
  ['Apertura e guida', 'Basta / Chiudi / Annulla', [['AMAZON.StopIntent']]],
  ['Apertura e guida', 'Richiesta non riconosciuta (prima volta)', [['AMAZON.FallbackIntent']]],
  ['Apertura e guida', 'Richiesta non riconosciuta (seconda volta)', [['AMAZON.FallbackIntent'], ['AMAZON.FallbackIntent']]],
  ['Apertura e guida', 'Seguito senza contesto («e il prossimo?» come prima frase)', [['ProssimoIntent']]],
  ['Partenze', 'Una corsa, tram con direzione verificata sulle fermate successive', [['ProssimaCorsaIntent', { mezzo: 'tram', luogo: 'San Marco Cattaneo', direzione: 'Venezia' }]], { gtfs: true }],
  ['Partenze', '«E nell\'altra direzione?»', [['ProssimaCorsaIntent', { mezzo: 'tram', luogo: 'San Marco Cattaneo', direzione: 'Venezia' }], ['AltraDirezioneIntent']], { gtfs: true }],
  ['Partenze', 'Una corsa (domanda singolare)', [['ProssimaCorsaIntent', { luogo: 'Zattere' }]]],
  ['Partenze', 'Più corse (domanda plurale), stati diversi', [['PartenzeIntent', { luogo: 'Zattere' }]]],
  ['Partenze', '«E quello dopo?»', [['ProssimaCorsaIntent', { luogo: 'Zattere' }], ['ProssimoIntent']]],
  ['Partenze', 'Ripeti (dato in tempo reale)', [['ProssimaCorsaIntent', { luogo: 'Zattere' }], ['RipetiIntent']]],
  ['Partenze', 'Mezzo in fermata', [['ProssimaCorsaIntent', { luogo: 'Zattere' }]], { zone: [F.partenza({ line: '2', schedIn: 0, atStop: true })] }],
  ['Partenze', 'Corsa soppressa e stima non aggiornata', [['PartenzeIntent', { luogo: 'Zattere', numero: '2' }]], { zone: [F.partenza({ tripId: 'X', line: '2', schedIn: 1, cancel: 'trip' }), F.partenza({ tripId: 'Y', line: '2', schedIn: 4, stale: { min: 7, why: 'gps' } })] }],
  ['Partenze', 'Solo orario programmato (nessun tempo reale)', [['ProssimaCorsaIntent', { luogo: 'Zattere' }]], { zone: [F.partenza({ line: '6', schedIn: 8, live: false })] }],
  ['Partenze', 'Nessuna partenza con il filtro', [['ProssimaCorsaIntent', { linea: 'quattro punto uno', luogo: 'Zattere' }]]],
  ['Partenze', 'Orari di un altro giorno da un\'ora', [['ProssimaCorsaIntent', { luogo: 'Rialto', data: '2026-11-26', ora: '08:00' }]], { gtfs: true }],
  ['Partenze', 'Fermata ambigua', [['ProssimaCorsaIntent', { luogo: 'Murano' }]]],
  ['Partenze', 'Fermata mancante', [['ProssimaCorsaIntent', { linea: 'due' }]]],
  ['Partenze', 'Fermata sconosciuta', [['ProssimaCorsaIntent', { luogo: 'Xyzzy' }]]],
  ['Partenze', 'Linee di una fermata', [['LineeIntent', { luogo: 'Rialto' }]], { gtfs: true }],
  ['Frequenza', '«Ogni quanto passa il tram a San Marco Cattaneo verso Venezia?»', [['FrequenzaIntent', { mezzo: 'tram', luogo: 'San Marco Cattaneo', direzione: 'Venezia' }]], { gtfs: true }],
  ['Frequenza', '«Ogni quanto passa?» come seguito di una corsa detta', [['ProssimaCorsaIntent', { mezzo: 'tram', luogo: 'San Marco Cattaneo', direzione: 'Venezia' }], ['FrequenzaIntent']], { gtfs: true }],
  ['Frequenza', 'Frequenza senza fermata', [['FrequenzaIntent', { linea: 'ti uno' }]]],
  ['Prima e ultima corsa', '«E nell\'altra direzione?» dopo l\'ultima corsa', [['UltimaCorsaIntent', { mezzo: 'tram', luogo: 'San Marco Cattaneo', direzione: 'Venezia' }], ['AltraDirezioneIntent']], { gtfs: true }],
  ['Prima e ultima corsa', 'Ultimo collegamento diretto (dopo mezzanotte)', [['UltimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma' }]], { gtfs: true }],
  ['Prima e ultima corsa', '«E domani?» dopo l\'ultima corsa', [['UltimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma' }], ['DomaniIntent']], { gtfs: true }],
  ['Prima e ultima corsa', 'Ultima corsa già passata', [['UltimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma' }]], { gtfs: true, adesso: F.MS(2026, 11, 26, 0, 30) }],
  ['Prima e ultima corsa', 'Prima corsa di domani', [['PrimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma' }]], { gtfs: true }],
  ['Prima e ultima corsa', 'Senza destinazione: una risposta per direzione', [['UltimaCorsaIntent', { luogo: 'Rialto' }]], { gtfs: true }],
  ['Prima e ultima corsa', 'Nessun collegamento diretto', [['UltimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Mestre' }]], { gtfs: true }],
  ['Prima e ultima corsa', 'Nessun orario per la data', [['UltimaCorsaIntent', { luogo: 'Rialto', data: '2026-12-25' }]], {}],
  ['Percorsi', 'Percorso sintetico', [['ItinerarioIntent', { partenza: 'Zattere', arrivo: 'San Marco' }]]],
  ['Percorsi', '«Quanto ci metto da Zattere a San Marco?»', [['DurataIntent', { partenza: 'Zattere', arrivo: 'San Marco' }]]],
  ['Percorsi', '«Dimmi i dettagli»', [['ItinerarioIntent', { partenza: 'Zattere', arrivo: 'San Marco' }], ['DettagliIntent']]],
  ['Percorsi', 'Arrivo entro un orario', [['ItinerarioEntroIntent', { partenza: 'Zattere', arrivo: 'San Marco', ora: '09:00' }]], { percorso: F.percorso([{ ...F.soluzione(), margine: 12 }]) }],
  ['Percorsi', 'Destinazione mancante', [['ItinerarioIntent', { partenza: 'Zattere' }]]],
  ['Percorsi', 'Nessuna soluzione', [['ItinerarioIntent', { partenza: 'Zattere', arrivo: 'San Marco' }]], { percorso: F.percorso([]) }],
  ['Marea', 'Livello e prossimo colmo', [['MareaIntent']]],
  ['Marea', 'Prossimo colmo', [['ColmoIntent']]],
  ['Marea', 'Prossimo minimo', [['MinimoIntent']]],
  ['Marea', 'MOSE', [['MoseIntent']]],
  ['Marea', 'Acqua alta stasera', [['AcquaAltaIntent', { ora: 'EV' }]]],
  ['Avvisi', 'Nessun avviso', [['AvvisiIntent']]],
  ['Avvisi', 'Avviso su una linea', [['AvvisiIntent', { linea: 'due' }]], { avvisi: [F.avviso({ title: 'Linea 2 deviata per lavori', effect: 'detour', lines: [{ n: '2', s: 'nav' }] })] }],
  ['Riepilogo', 'Riepilogo della mattina', [['RiepilogoIntent', { momento: 'mattina' }]]],
  ['Errori e attese', 'Orari in caricamento', [['UltimaCorsaIntent', { luogo: 'Rialto', arrivo: 'Piazzale Roma', data: '2026-12-08' }]], { gtfs: true, err409: true }],
  ['Errori e attese', 'Server occupato', [['ProssimaCorsaIntent', { luogo: 'Zattere' }]], { occupato: true }],
  ['Errori e attese', 'Dati non leggibili', [['ProssimaCorsaIntent', { luogo: 'Zattere' }]], { zoneErr: 500 }]
];

async function genera() {
  const righe = [];
  let sez = null;
  for (const [s, cond, passi, o = {}] of SCENARI) {
    Ctx._reset();
    const gt = o.gtfs ? (() => { const r = rete(); return r; })() : null;
    const sc = base(gt);
    if (o.zone) sc['/api/zone'] = F.zona(o.zone);
    if (o.percorso) sc['/api/percorso'] = o.percorso;
    if (o.avvisi) sc['/api/avvisi'] = { updated: F.ADESSO, items: o.avvisi };
    if (o.zoneErr) sc['/api/zone'] = () => Object.assign(new Error('x'), { code: o.zoneErr });
    const adesso = o.adesso || F.ADESSO;
    const amb = F.ambiente(sc, { gtfs: gt, adesso, occupato: !!o.occupato, errDiretti: o.err409 ? Object.assign(new Error('carico'), { code: 409 }) : null });
    let att = {}, t = '';
    for (const [intent, slots = {}] of passi) {
      const rq = intent === '@Launch' ? F.richiesta(null, {}, { tipo: 'LaunchRequest', adesso }) : F.richiesta(intent, Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, v])), { adesso, attributi: att });
      const r = await gestisci(rq, amb); att = r.body.sessionAttributes || {}; t = F.parlato(r);
    }
    if (s !== sez) { righe.push(`\n#### ${s}\n\n| Condizione | Risposta effettiva |\n|---|---|`); sez = s; }
    righe.push(`| ${cond} | ${t.replace(/\|/g, '/')} |`);
  }
  return righe.join('\n');
}
const INIZIO = '<!-- CATALOGO:INIZIO -->', FINE = '<!-- CATALOGO:FINE -->';
(async () => {
  const testo = fs.readFileSync(FILE, 'utf8'), a = testo.indexOf(INIZIO), b = testo.indexOf(FINE);
  if (a < 0 || b < a) throw new Error('segni CATALOGO non trovati');
  const nuovo = testo.slice(0, a + INIZIO.length) + '\n' + (await genera()) + '\n' + testo.slice(b);
  if (process.argv.includes('--verifica')) { if (nuovo !== testo) { console.error('catalogo non aggiornato: node alexa/scripts/catalogo.js'); process.exit(1); } console.log('catalogo aggiornato'); return; }
  fs.writeFileSync(FILE, nuovo); console.log(`Catalogo scritto: ${SCENARI.length} risposte`);
})().catch(e => { console.error(e); process.exit(1); });
