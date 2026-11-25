'use strict';
// GENERA IL MODELLO DI INTERAZIONE it-IT (alexa/skill-package/interactionModels/custom/it-IT.json).
// Le fermate e le linee non sono scritte a mano: si leggono da /api/stops e /api/routes di un server già in funzione (per impostazione
// predefinita quello di produzione), così il modello segue i dati ACTV. Uso:
//   node alexa/scripts/genera-modello.js [URL_SERVER]          (predefinito: https://veneziatpl.onrender.com)
// Nessuna dipendenza: solo Node 22. Ripetere dopo un cambio di orari ACTV (nuove fermate o linee), poi reimportare il JSON nella console.
const fs = require('fs');
const path = require('path');
const L = require('../luoghi');
const P = require('../parlato');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://veneziatpl.onrender.com').replace(/\/$/, '');
const USCITA = path.join(__dirname, '..', 'skill-package', 'interactionModels', 'custom', 'it-IT.json');
const NOME_INVOCAZIONE = process.env.NOME_INVOCAZIONE || 'venezia t. p. l.';
const MAX_VALORI = 5000;   // ben sotto il limite di Amazon per i tipi personalizzati

const get = async p => { const r = await fetch(BASE + p, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
const valore = (nome, id, sin = []) => ({ id: String(id).trim().replace(/\s+/g, '_'), name: { value: nome, synonyms: [...new Set(sin.filter(s => s && s.toLowerCase() !== nome.toLowerCase()))].slice(0, 20) } });
const unici = vals => { const v = new Set(), out = []; for (const x of vals) { const k = x.name.value.toLowerCase(); if (!v.has(k)) { v.add(k); out.push(x); } } return out; };

// ---- campioni di frase ----
const FR = {
  // più corse (elenco): «le prossime partenze», «i prossimi tre vaporetti»
  PartenzeIntent: [
    'prossimi {mezzo} da {luogo}', 'prossimi {mezzo} a {luogo}', 'i prossimi {mezzo} da {luogo}', 'i prossimi {numero} {mezzo} da {luogo}', 'prossimi {numero} {mezzo} da {luogo} per {arrivo}', 'i prossimi {numero} {mezzo} da {luogo} a {arrivo}',
    'prossime partenze da {luogo}', 'prossime partenze a {luogo}', 'le prossime {numero} partenze da {luogo}', 'prossime {numero} corse da {luogo}', 'partenze da {luogo}', 'partenze {luogo}', 'partenze da {luogo} per {direzione}', 'partenze da {luogo} verso {direzione}',
    'cosa passa a {luogo}', 'cosa passa da {luogo}', 'orari del {linea} a {luogo}', 'orari del {linea} da {luogo}', 'orari {luogo}', 'dammi le partenze da {luogo}', 'prossimi {mezzo} da {luogo} per {arrivo}', 'prossimi {mezzo} da {luogo} verso {direzione}',
    'partenze da {luogo} {data}', 'partenze da {luogo} alle {ora}', 'partenze da {luogo} {data} alle {ora}', 'partenze da {luogo} {data} dalle {ora}', 'quali sono gli orari {data} dalle {ora} da {luogo}', 'orari da {luogo} {data} dalle {ora}', 'orari del {linea} {data} da {luogo}',
    'quando passano i {mezzo} a {luogo}', 'quando passano i prossimi {mezzo} da {luogo}'
  ],
  // una corsa: «quando passa il due alle Zattere», «tra quanto passa il prossimo tram a San Marco Cattaneo in direzione Venezia»
  ProssimaCorsaIntent: [
    'quando passa il {linea} a {luogo}', 'quando passa il {linea} alle {luogo}', 'quando passa il {linea} al {luogo}', 'quando passa il {linea} alla {luogo}', 'quando passa il {linea} da {luogo}', 'quando passa il {linea}',
    'quando passa il {linea} da {luogo} per {direzione}', 'il {linea} per {direzione} da {luogo}', 'il {linea} verso {direzione} da {luogo}', 'quando passa il prossimo {linea} a {luogo}',
    'quando parte il prossimo {mezzo} da {luogo}', 'quando passa il prossimo {mezzo} da {luogo}', 'quando passa il prossimo {mezzo} a {luogo}', 'quando passa il prossimo {mezzo} alla fermata {luogo}',
    'tra quanto passa il prossimo {mezzo} alla fermata {luogo} in direzione {direzione}', 'tra quanto passa il prossimo {mezzo} a {luogo} in direzione {direzione}', 'tra quanto passa il prossimo {mezzo} a {luogo} verso {direzione}', 'tra quanto passa il {mezzo} a {luogo}',
    'tra quanto passa il {linea} a {luogo}', 'tra quanto passa il prossimo {mezzo} da {luogo} per {direzione}', 'quando passa il prossimo {mezzo} da {luogo} per {arrivo}', 'quando passa il prossimo {mezzo} da {luogo} verso {direzione}',
    'prossimo {mezzo} per {direzione}', 'quando passa il prossimo {mezzo} per {direzione}', 'prossimo {mezzo} per {direzione} da {luogo}', 'il prossimo {mezzo} verso {direzione}', 'prossimo {mezzo} da {luogo}', 'prossimo {mezzo} da {luogo} a {arrivo}',
    'quando passa il {linea} a {luogo} {data}', 'quando passa il {linea} a {luogo} alle {ora}', 'quando passa il {linea} a {luogo} {data} alle {ora}', 'quando c\'è il prossimo {mezzo} da {luogo} a {arrivo}', 'a che ora passa il {linea} a {luogo}'
  ],
  LineeIntent: ['che linee passano da {luogo}', 'quali linee passano a {luogo}', 'quali linee passano da {luogo}', 'quali {mezzo} passano da {luogo}', 'quali linee passano', 'che linee ci sono a {luogo}', 'linee di {luogo}'],
  RitardoIntent: [
    'il {linea} è in ritardo', 'il {linea} è in orario', 'c\'è ritardo sul {linea}', 'ci sono ritardi sul {linea}', 'com\'è il {linea}', 'come va il {linea}', 'ritardi del {linea}', 'ritardo del {linea}', 'dov\'è il {linea}',
    'il {linea} è in ritardo a {luogo}', 'ci sono ritardi a {luogo}', 'ritardi a {luogo}', 'è in ritardo il {linea}', 'quanto ritardo ha il {linea}', 'il {mezzo} è in ritardo', 'i {mezzo} sono in ritardo'
  ],
  UltimaCorsaIntent: [
    'ultimo {mezzo}', 'ultimo {mezzo} da {luogo}', 'a che ora è l\'ultimo {mezzo} da {luogo}', 'a che ora passa l\'ultimo {mezzo} da {luogo}', 'ultima corsa del {linea} da {luogo}', 'ultimo {linea} da {luogo}',
    'l\'ultimo {mezzo} per {direzione} da {luogo}', 'quando passa l\'ultimo {linea} a {luogo}', 'quando passa l\'ultimo {mezzo} a {luogo}', 'ultima corsa da {luogo}', 'ultima partenza da {luogo}', 'ultima corsa del {linea}', 'ultimo {mezzo} per {direzione}',
    'qual è l\'ultimo {mezzo} da {luogo} a {arrivo}', 'ultimo {mezzo} da {luogo} a {arrivo}', 'ultimo {mezzo} {data} da {luogo} a {arrivo}', 'ultimo {mezzo} da {luogo} a {arrivo} {data}', 'qual è l\'ultimo {mezzo} {data} da {luogo}', 'ultima corsa {data} da {luogo}',
    'e l\'ultimo', 'e l\'ultima', 'l\'ultima corsa', 'qual è l\'ultima corsa', 'e l\'ultima corsa {data}', 'ultima corsa del {linea} per {direzione}', 'a che ora è l\'ultimo {linea} da {luogo} per {direzione}'
  ],
  PrimaCorsaIntent: [
    'prima corsa da {luogo}', 'primo {mezzo} da {luogo}', 'primo {mezzo} da {luogo} per {direzione}', 'primo {mezzo} {data} da {luogo}', 'a che ora parte il primo {mezzo} da {luogo}', 'a che ora parte il primo {mezzo} da {luogo} a {arrivo}',
    'prima corsa domattina da {luogo}', 'prima corsa {data} da {luogo}', 'primo {linea} da {luogo}', 'prima corsa del {linea}', 'e il primo', 'e la prima', 'la prima corsa', 'qual è la prima corsa {data}', 'primo {mezzo} da {luogo} a {arrivo} {data}',
    'primo {mezzo} {data} dopo le {ora} da {luogo}', 'prima corsa dopo le {ora} da {luogo}'
  ],
  ItinerarioIntent: [
    'come arrivo a {arrivo} da {partenza}', 'come arrivo a {arrivo}', 'come vado a {arrivo} da {partenza}', 'come si va da {partenza} a {arrivo}', 'come si arriva a {arrivo} da {partenza}', 'percorso da {partenza} a {arrivo}', 'da {partenza} a {arrivo}',
    'voglio andare da {partenza} a {arrivo}', 'devo andare a {arrivo} da {partenza}', 'vorrei andare a {arrivo}', 'come arrivo a {arrivo} da {partenza} {data}', 'come arrivo a {arrivo} da {partenza} {data} alle {ora}', 'come arrivo a {arrivo} da {partenza} alle {ora}',
    'come arrivo a {arrivo} {data} {ora}', 'come arrivo a {arrivo} {data}', 'come arrivo a {arrivo} {ora}', 'come arrivo a {arrivo} da {partenza} con {preferenza}', 'come arrivo a {arrivo} con {preferenza}', 'come arrivo a {arrivo} da {partenza} in {mezzo}', 'come arrivo a {arrivo} in {mezzo}',
    'come arrivo a {arrivo} da {partenza} con al massimo {cambi} cambi', 'come arrivo a {arrivo} da {partenza} con {cambi} cambi', 'da {partenza} a {arrivo} {data}', 'da {partenza} a {arrivo} alle {ora}', 'da {partenza} a {arrivo} {data} alle {ora}', 'da {partenza} a {arrivo} con {preferenza}',
    'che {mezzo} devo prendere per {arrivo} da {partenza}', 'cosa prendo per andare a {arrivo} da {partenza}', 'itinerario da {partenza} a {arrivo}', 'pianifica un percorso da {partenza} a {arrivo}'
  ],
  ItinerarioEntroIntent: [
    'come arrivo a {arrivo} entro le {ora}', 'come arrivo a {arrivo} da {partenza} entro le {ora}', 'voglio arrivare a {arrivo} entro le {ora}', 'devo essere a {arrivo} entro le {ora}', 'devo essere a {arrivo} per le {ora}', 'devo essere a {arrivo} per le {ora} da {partenza}',
    'arrivare a {arrivo} per le {ora}', 'arrivare a {arrivo} da {partenza} per le {ora}', 'da {partenza} a {arrivo} entro le {ora}', 'da {partenza} a {arrivo} entro le {ora} {data}', 'come arrivo a {arrivo} entro le {ora} {data}', 'come arrivo a {arrivo} da {partenza} entro le {ora} {data}',
    'a che ora devo partire per essere a {arrivo} entro le {ora}', 'a che ora devo partire da {partenza} per essere a {arrivo} per le {ora}', '{arrivo} entro le {ora}', '{arrivo} entro le {ora} {data}', 'devo essere a {arrivo} {data} entro le {ora}'
  ],
  ProssimoIntent: ['e il prossimo', 'il prossimo', 'dimmi il prossimo', 'e dopo', 'e poi', 'quello dopo', 'e quello dopo', 'e il successivo', 'il successivo'],
  AltreCorseIntent: ['altre {numero} corse', 'dimmene altre {numero}', 'altre corse', 'altre partenze', 'dimmi altre corse', 'altre', 'ce ne sono altre', 'e le altre', 'che altro', 'mostrami altre corse'],
  AlternativaIntent: ['alternativa', 'un\'alternativa', 'c\'è un\'alternativa', 'altra soluzione', 'un\'altra soluzione', 'altre soluzioni', 'un altro percorso', 'alternativa {preferenza}', 'l\'alternativa {preferenza}', 'un\'alternativa {preferenza}', 'e con {preferenza}', 'fammi vedere quella {preferenza}', 'dammi quella {preferenza}', 'la soluzione {preferenza}', 'voglio un percorso {preferenza}'],
  SenzaCambiIntent: ['senza cambi', 'e senza cambi', 'senza nessun cambio', 'senza cambiare', 'con un percorso diretto', 'percorso diretto', 'solo diretti', 'diretto'],
  RitornoIntent: ['e al ritorno', 'il ritorno', 'e per il ritorno', 'percorso di ritorno', 'e per tornare', 'e per ritornare', 'come torno', 'e il ritorno', 'e per il viaggio di ritorno'],
  DomaniIntent: ['e domani', 'e per domani', 'e dopodomani', 'e {data}', 'e domani {ora}', 'e {data} alle {ora}', 'e alle {ora}', 'vale anche domani', 'e domani mattina', 'e domani sera', 'e per {data}', 'e per {data} alle {ora}'],
  MareaIntent: ['com\'è la marea', 'come è la marea', 'a quanto è la marea', 'livello della marea', 'a che livello è la marea', 'quanto è alta la marea', 'marea', 'la marea', 'marea a venezia', 'com\'è la marea adesso', 'che marea c\'è', 'la marea sta salendo', 'sta salendo o scendendo la marea', 'quanto è la marea', 'com\'è l\'acqua'],
  ColmoIntent: ['quando è il picco', 'quando è il colmo', 'prossimo colmo', 'a che ora è il picco di marea', 'quando arriva il picco', 'picco di marea', 'quando sarà la massima', 'a che ora è la massima', 'a che ora è il colmo', 'quando c\'è il picco di marea', 'quando è il prossimo picco', 'quando è la prossima alta marea', 'a che ora arriva la marea massima'],
  AcquaAltaIntent: ['ci sarà acqua alta', 'ci sarà acqua alta {data}', 'ci sarà acqua alta {ora}', 'ci sarà acqua alta {data} {ora}', 'ci sarà acqua alta nelle prossime ore', 'ci sarà l\'acqua alta {data}', 'c\'è acqua alta', 'c\'è acqua alta oggi', 'acqua alta', 'è prevista acqua alta', 'è prevista acqua alta {data}', 'è prevista acqua alta {ora}', '{data} ci sarà acqua alta', '{data} {ora} ci sarà acqua alta', 'alta marea {data}', 'alta marea {ora}', 'prevista alta marea', 'ci sarà alta marea {data}', 'ci sarà alta marea {ora}', 'c\'è acqua alta {data}', 'sale l\'acqua alta {data}'],
  MoseIntent: ['il mose è alzato', 'stato del mose', 'è alzato il mose', 'mose', 'lo stato del mose', 'hanno alzato il mose', 'il mose è in funzione', 'il mose è attivo', 'sollevano il mose', 'barriere del mose', 'il mose si alza', 'com\'è il mose', 'il mose è sollevato', 'come sta il mose', 'è in funzione il mose'],
  StivaliIntent: ['servono gli stivali', 'servono gli stivali a {luogo}', 'devo mettere gli stivali', 'stivali', 'serve lo stivale a {luogo}', 'è allagato a {luogo}', 'è allagata {luogo}', 'si cammina a {luogo}', 'devo prendere gli stivali per {luogo}', 'servono gli stivali per {luogo}', 'servono gli stivali oggi', 'ci vogliono gli stivali', 'ci vogliono gli stivali a {luogo}', 'serve la barca a {luogo}'],
  PasserelleIntent: ['ci sono le passerelle', 'ci sono le passerelle a {luogo}', 'passerelle', 'hanno montato le passerelle', 'dove ci sono le passerelle', 'sono montate le passerelle a {luogo}', 'le passerelle a {luogo}', 'stato delle passerelle', 'passerelle a {luogo}', 'hanno steso le passerelle', 'ci sono passerelle vicino a {luogo}', 'sono montate le passerelle'],
  AvvisiIntent: ['ci sono avvisi per i {mezzo}', 'ci sono avvisi sui {mezzo}', 'ci sono problemi per i {mezzo}', 'avvisi per i {mezzo}', 'ci sono problemi sui {mezzo} {data}', 'ci sono avvisi', 'ci sono avvisi sul {linea}', 'ci sono avvisi a {luogo}', 'ci sono problemi sul {linea}', 'ci sono disservizi', 'avvisi di servizio', 'ci sono avvisi {data}', 'avvisi {data}', 'il {linea} è sospeso', 'è sospeso il {linea}', 'ci sono variazioni sul {linea}', 'ci sono deviazioni', 'cosa succede sul {linea}', 'ci sono problemi a {luogo}', 'avvisi del {linea}', 'avvisi per il {linea}', 'avvisi per {luogo}', 'ci sono avvisi per il {linea} {data}', 'novità sul servizio', 'ci sono interruzioni'],
  ScioperoIntent: ['c\'è sciopero per i {mezzo}', 'lo sciopero riguarda i {mezzo}', 'c\'è sciopero sui {mezzo} {data}', 'fasce garantite per i {mezzo}', 'c\'è sciopero', 'c\'è sciopero {data}', 'ci sono scioperi', 'quando è il prossimo sciopero', 'c\'è uno sciopero {data}', 'c\'è sciopero sul {linea}', 'sciopero', 'ci sono scioperi {data}', 'fasce garantite dello sciopero', 'quali sono le fasce garantite', 'gli orari garantiti dello sciopero', 'c\'è uno sciopero dei trasporti', 'ci sarà uno sciopero {data}', 'è previsto uno sciopero'],
  RiepilogoIntent: ['riepilogo della {momento} da {luogo} verso {direzione}', 'riepilogo da {luogo} verso {direzione}', 'riepilogo della {momento} da {luogo} in {mezzo} verso {direzione}', 'riepilogo da {luogo} in {mezzo}', 'riepilogo della {momento} in {mezzo} da {luogo}', 'riepilogo dei {mezzo} da {luogo}', 'riepilogo con i {mezzo}', 'riepilogo della {momento} da {luogo}', 'dammi il riepilogo', 'riepilogo', 'come sono i trasporti oggi', 'com\'è la situazione dei trasporti', 'come vanno i trasporti', 'come sono i trasporti', 'situazione trasporti', 'il riepilogo di oggi', 'riepilogo di oggi', 'dammi il riepilogo della {momento}', 'buongiorno riepilogo', 'riepilogo e partenze da {luogo}', 'com\'è la situazione oggi'],
  MinimoIntent: ['e il minimo', 'quando è il minimo', 'prossimo minimo', 'quando è la bassa marea', 'a che ora è la minima', 'quando c\'è la bassa marea', 'a che ora è il prossimo minimo'],
  AiutoIntent: ['aiuto {categoria}', 'aiuto per {categoria}', 'aiuto sulle {categoria}', 'aiuto sui {categoria}', 'aiuto sulla {categoria}', 'aiuto sugli {categoria}', 'come chiedo {categoria}', 'come chiedo gli {categoria}', 'come chiedo le {categoria}', 'spiegami {categoria}', 'come funzionano le {categoria}', 'come funziona la {categoria}', 'che cosa posso chiederti', 'cosa posso chiederti', 'cosa sai fare', 'che cosa sai fare', 'come funzioni'],
  PresentatiIntent: ['presentati', 'che cos\'è venezia t. p. l.', 'chi sei', 'cosa sei', 'sei ufficiale', 'sei dell\'actv', 'sei un servizio ufficiale', 'che cos\'è questa skill', 'di chi sei', 'da dove prendi i dati'],
  TuttiComandiIntent: ['tutti i comandi', 'elenco dei comandi', 'quali comandi ci sono', 'tutti i comandi disponibili', 'la guida completa', 'dimmi tutti i comandi', 'lista dei comandi'],
  RiprovaIntent: ['riprova', 'prova di nuovo', 'riprova adesso', 'prova ancora', 'ritenta', 'riprova per favore'],
  AggiornaIntent: ['aggiorna', 'e adesso', 'aggiornami', 'dati aggiornati', 'ricontrolla', 'aggiorna per favore', 'adesso com\'è'],
  DettagliIntent: ['dimmi i dettagli', 'mi dici i dettagli', 'dettagli', 'più dettagli', 'tutti i passaggi', 'leggi l\'avviso', 'spiegami meglio', 'i dettagli', 'dammi i dettagli'],
  CorrezioneIntent: ['no verso {direzione}', 'verso {direzione}', 'e verso {direzione}', 'no in direzione {direzione}', 'in direzione {direzione}', 'no per {direzione}', 'e per {direzione}', 'no intendevo {luogo}', 'intendevo da {luogo}', 'no da {luogo}',
    'solo {mezzo}', 'solo i {mezzo}', 'e per i {mezzo}', 'e in {mezzo}', 'e con il {mezzo}', 'con il {linea}', 'e il {linea}', 'solo la linea {linea}', 'e la linea {linea}', 'no il {linea}'],
  AltraDirezioneIntent: ['e nell\'altra direzione', 'nell\'altra direzione', 'e dall\'altra parte', 'direzione opposta', 'e al contrario', 'e nella direzione opposta', 'l\'altra direzione'],
  NonSupportatoIntent: ['avvisami quando arriva il {linea}', 'avvisami quando passa', 'mandami una notifica', 'salva questa fermata', 'aggiungi ai preferiti', 'i miei preferiti', 'portami a {luogo}', 'navigatore per {luogo}', 'guidami a piedi fino a {luogo}', 'compra il biglietto', 'quanto costa il biglietto', 'dove compro il biglietto', 'dov\'è il vaporetto adesso'],
  LuogoIntent: ['{luogo}', 'a {luogo}', 'da {luogo}', 'vicino a {luogo}', 'quello di {luogo}', 'intendo {luogo}', 'fermata {luogo}'],
  SceltaIntent: ['il numero {numero}', '{numero}', 'numero {numero}', 'la {ordinale}', 'il {ordinale}', '{ordinale}', 'quello {ordinale}', 'quella {ordinale}', 'scelgo il {numero}', 'scelgo il {ordinale}', 'il {ordinale} per favore'],
  RipetiIntent: ['ripeti', 'puoi ripetere', 'ripetilo', 'di nuovo', 'come hai detto', 'non ho capito ripeti', 'ripeti per favore', 'ripeti l\'ultima risposta', 'ridimmelo', 'puoi ripeterlo'],
  ConfermaIntent: ['sì', 'certo', 'volentieri', 'va bene', 'ok', 'sì grazie', 'sì per favore', 'esatto', 'proprio quello', 'dimmi'],
  RifiutoIntent: ['no', 'no grazie', 'niente', 'nient\'altro', 'è tutto', 'basta così', 'va bene così', 'grazie basta', 'grazie']
};
const SLOT = {
  PartenzeIntent: { luogo: 'FERMATA', arrivo: 'FERMATA', linea: 'LINEA', direzione: 'FERMATA', mezzo: 'MEZZO', numero: 'AMAZON.NUMBER', data: 'AMAZON.DATE', ora: 'AMAZON.TIME' },
  ProssimaCorsaIntent: { luogo: 'FERMATA', arrivo: 'FERMATA', linea: 'LINEA', direzione: 'FERMATA', mezzo: 'MEZZO', data: 'AMAZON.DATE', ora: 'AMAZON.TIME' },
  LineeIntent: { luogo: 'FERMATA', mezzo: 'MEZZO' },
  RitardoIntent: { linea: 'LINEA', luogo: 'FERMATA', mezzo: 'MEZZO' },
  UltimaCorsaIntent: { luogo: 'FERMATA', arrivo: 'FERMATA', linea: 'LINEA', direzione: 'FERMATA', mezzo: 'MEZZO', data: 'AMAZON.DATE' },
  PrimaCorsaIntent: { luogo: 'FERMATA', arrivo: 'FERMATA', linea: 'LINEA', direzione: 'FERMATA', mezzo: 'MEZZO', data: 'AMAZON.DATE', ora: 'AMAZON.TIME' },
  ItinerarioIntent: { partenza: 'FERMATA', arrivo: 'FERMATA', data: 'AMAZON.DATE', ora: 'AMAZON.TIME', mezzo: 'MEZZO', preferenza: 'PREFERENZA', cambi: 'AMAZON.NUMBER' },
  ItinerarioEntroIntent: { partenza: 'FERMATA', arrivo: 'FERMATA', data: 'AMAZON.DATE', ora: 'AMAZON.TIME' },
  AlternativaIntent: { preferenza: 'PREFERENZA' },
  AltreCorseIntent: { numero: 'AMAZON.NUMBER' },
  DomaniIntent: { data: 'AMAZON.DATE', ora: 'AMAZON.TIME' },
  AcquaAltaIntent: { data: 'AMAZON.DATE', ora: 'AMAZON.TIME' },
  StivaliIntent: { luogo: 'FERMATA' },
  PasserelleIntent: { luogo: 'FERMATA' },
  AvvisiIntent: { luogo: 'FERMATA', linea: 'LINEA', mezzo: 'MEZZO', data: 'AMAZON.DATE' },
  ScioperoIntent: { linea: 'LINEA', mezzo: 'MEZZO', data: 'AMAZON.DATE' },
  RiepilogoIntent: { momento: 'MOMENTO', luogo: 'FERMATA', mezzo: 'MEZZO', direzione: 'FERMATA' },
  AiutoIntent: { categoria: 'CATEGORIA' },
  NonSupportatoIntent: { linea: 'LINEA', luogo: 'FERMATA' },
  CorrezioneIntent: { direzione: 'FERMATA', luogo: 'FERMATA', mezzo: 'MEZZO', linea: 'LINEA' },
  LuogoIntent: { luogo: 'FERMATA' },
  SceltaIntent: { numero: 'AMAZON.NUMBER', ordinale: 'ORDINALE' }
};

(async () => {
  const [stops, routes] = await Promise.all([get('/api/stops'), get('/api/routes')]);
  const idx = L.crea(stops, routes);
  // FERMATA: un valore per gruppo di fermate (stesso nome), nome parlato + nome nei dati + alias detti a voce
  const alias = new Map();   // chiave gruppo -> sinonimi dai luoghi speciali
  for (const [k, sp] of Object.entries(L.LUOGHI_SPECIALI)) { for (const c of sp.chiavi || []) { if (!alias.has(c)) alias.set(c, new Set()); alias.get(c).add(k); } }
  const fermate = idx.gruppi.map(g => {
    const sin = [g.nome, g.nome.replace(/\s+/g, ' ').toLowerCase(), ...(alias.get(g.chiave) || [])];
    return valore(g.parlato.replace(/<[^>]+>/g, ''), g.chiave, sin);
  });
  for (const [k, sp] of Object.entries(L.LUOGHI_SPECIALI)) fermate.push(valore(sp.nome.replace(/<[^>]+>/g, ''), 'speciale:' + k, [k]));
  // LINEA: nome come nei dati (4.1, 5.2, N, T1, 12E…) + forma detta a voce
  const nomiLinea = [...new Set(Object.values(routes).map(r => String(r.name || '').trim()).filter(Boolean))];
  const linee = nomiLinea.map(n => { const parlato = P.senzaTag(P.lineaParlata(n)); return valore(parlato, n, [n, /^\d+\.\d+$/.test(n) ? n.replace('.', ' e ') : null, /^\d+\.\d+$/.test(n) ? n.replace('.', ' ') : null, /^\d+$/.test(n) ? `linea ${n}` : null]); });
  const tipi = [
    { name: 'FERMATA', values: unici(fermate).slice(0, MAX_VALORI) },
    { name: 'LINEA', values: unici(linee) },
    { name: 'MEZZO', values: [valore('vaporetto', 'nav', ['vaporetti', 'battello', 'battelli', 'barca', 'barche', 'motonave', 'motoscafo', 'lancia', 'acqua', 'linea d\'acqua', 'navigazione']), valore('autobus', 'bus', ['bus', 'corriera', 'corriere', 'pullman', 'filobus']), valore('tram', 'tram', ['tranvia', 'tramvia', 'il tram']), valore('mezzi su gomma', 'aut', ['autobus e tram', 'mezzi di terra', 'gomma'])] },
    { name: 'CATEGORIA', values: [valore('partenze', 'partenze', ['orari', 'corse', 'partenza', 'orario', 'vaporetti', 'autobus', 'ultima corsa']), valore('percorsi', 'percorsi', ['percorso', 'itinerari', 'itinerario', 'viaggi', 'come arrivare']), valore('marea', 'marea', ['maree', 'acqua alta', 'mose', 'livello dell\'acqua']), valore('avvisi', 'avvisi', ['avviso', 'scioperi', 'sciopero', 'problemi', 'disservizi']), valore('riepilogo', 'riepilogo', ['riepiloghi', 'routine', 'riassunto'])] },
    { name: 'PREFERENZA', values: [valore('più veloce', 'veloce', ['veloce', 'più rapida', 'rapida', 'più rapido', 'rapido', 'più breve', 'breve', 'che arriva prima', 'arrivo prima', 'più svelta']), valore('meno cambi', 'cambi', ['pochi cambi', 'con meno cambi', 'meno trasbordi', 'meno coincidenze']), valore('meno a piedi', 'piedi', ['meno strada a piedi', 'meno camminata', 'meno cammino', 'camminare meno', 'poca strada a piedi'])] },
    { name: 'MOMENTO', values: [valore('mattina', 'mattina', ['mattino', 'questa mattina', 'di mattina']), valore('sera', 'sera', ['serata', 'stasera']), valore('giornata', 'giornata', ['oggi', 'giorno'])] },
    { name: 'ORDINALE', values: [['primo', '1', ['prima', 'uno', 'il primo', 'la prima', 'quello in alto']], ['secondo', '2', ['seconda', 'due', 'il secondo', 'la seconda']], ['terzo', '3', ['terza', 'tre', 'il terzo', 'la terza']], ['quarto', '4', ['quarta', 'quattro', 'il quarto', 'la quarta', 'ultimo', 'ultima']]].map(([n, id, s]) => valore(n, id, s)) }
  ];
  const intents = [
    { name: 'AMAZON.CancelIntent', samples: [] }, { name: 'AMAZON.HelpIntent', samples: [] }, { name: 'AMAZON.StopIntent', samples: [] },
    { name: 'AMAZON.NavigateHomeIntent', samples: [] }, { name: 'AMAZON.FallbackIntent', samples: [] },
    ...Object.entries(FR).map(([name, samples]) => ({ name, slots: Object.entries(SLOT[name] || {}).map(([n, type]) => ({ name: n, type })), samples: [...new Set(samples)] }))
  ].map(i => (i.slots && !i.slots.length ? { name: i.name, samples: i.samples } : i));
  // controllo: ogni {slot} usato in un esempio è dichiarato
  for (const i of intents) for (const s of i.samples || []) for (const m of s.matchAll(/\{(\w+)\}/g)) if (!(i.slots || []).some(x => x.name === m[1])) throw new Error(`${i.name}: slot {${m[1]}} non dichiarato in «${s}»`);
  const modello = { interactionModel: { languageModel: { invocationName: NOME_INVOCAZIONE, intents, types: tipi } } };
  fs.mkdirSync(path.dirname(USCITA), { recursive: true });
  fs.writeFileSync(USCITA, JSON.stringify(modello, null, 2) + '\n');
  const tot = intents.reduce((n, i) => n + (i.samples || []).length, 0);
  console.log(`Modello scritto: ${path.relative(process.cwd(), USCITA)}\n  server letto: ${BASE}\n  intenti: ${intents.length}, frasi di esempio: ${tot}\n  FERMATA: ${tipi[0].values.length} valori · LINEA: ${tipi[1].values.length} valori\n  nome di invocazione: «${NOME_INVOCAZIONE}»`);
})().catch(e => { console.error('Errore:', e.message); process.exit(1); });
