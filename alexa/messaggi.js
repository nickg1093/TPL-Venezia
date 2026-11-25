'use strict';
// CATALOGO UNICO DELLE FRASI FISSE della skill (benvenuto, presentazione, aiuto, errori, chiusura).
// Lo usano il server (alexa/skill.js) e la funzione Lambda (alexa/lambda/index.js): nella Lambda c'è una COPIA GENERATA da
// `node alexa/scripts/prepara-lambda.js` (la prova tests/alexa-lambda.test.js controlla che sia identica). Modificare solo qui.
// Testo semplice, senza SSML: l'escape XML si fa una sola volta, al momento della risposta.
const M = {
  benvenuto: 'Ciao! Cosa vuoi sapere?',
  cosaVuoi: 'Cosa vuoi sapere?',
  aiuto: 'Puoi chiedermi partenze, percorsi, marea, meteo o avvisi. Su cosa vuoi una mano?',
  aiutoRiprompt: 'Dimmi: partenze, percorsi, marea, avvisi o riepilogo.',
  presentazione: 'Sono Venezia TPL, un servizio indipendente di informazioni sui trasporti e sulla marea di Venezia. Non sono un servizio ufficiale ACTV. Uso gli orari e il tempo reale pubblicati da ACTV e i dati delle maree e del meteo del Comune di Venezia, del porto e dell\'aeroporto.',
  aiutoCategoria: {
    partenze: 'Puoi dire: quando passa il due alle Zattere? Ogni quanto passa il tram a San Marco Cattaneo? Oppure: qual è l\'ultimo vaporetto da Rialto a Piazzale Roma?',
    percorsi: 'Prova a dire: come arrivo a Rialto da Piazzale Roma? Oppure: quando devo partire per arrivare a Rialto entro le nove?',
    marea: 'Puoi chiedermi il livello attuale, il prossimo colmo, il MOSE o la previsione di acqua alta.',
    avvisi: 'Puoi chiedere: ci sono problemi sulla linea uno? Oppure: ci sono scioperi domani?',
    meteo: 'Puoi chiedere: com\'è la visibilità in laguna? C\'è nebbia a San Servolo? Quanto vento c\'è a San Giorgio? Che temperatura c\'è? Che tempo fa all\'aeroporto?',
    riepilogo: 'Dimmi: riepilogo della mattina da Zattere, con la tua fermata. Puoi usare questa frase anche in una routine dell\'app Alexa.'
  },
  tuttiComandi: 'Posso spiegarti una categoria alla volta: partenze, percorsi, marea, meteo, avvisi o riepilogo. Quale vuoi? La guida completa è nell\'app Venezia TPL, nella pagina Informazioni.',
  chiusura: 'A presto!',
  nonCapito: 'Non ho capito. Dimmi una fermata, oppure chiedimi la marea.',
  nonCapitoAncora: 'Scusa, non ho ancora capito. Prova a dire: quando passa il due alle Zattere? Oppure: com\'è la marea?',
  nonSupportato: 'Questa funzione è disponibile nell\'app, ma non ancora a voce.',
  origineMancante: 'Da quale fermata parti?',
  destinazioneMancante: 'Dove vuoi arrivare?',
  fermataMancante: 'Da quale fermata?',
  lineaOFermata: 'Di quale linea o fermata?',
  giornoMancante: 'Per quale giorno?',
  contestoAssente: 'A quale fermata o percorso ti riferisci?',
  nienteDaRipetere: 'Non ho niente da ripetere. Cosa vuoi sapere?',
  soloItaliano: 'Questa skill funziona solo in italiano.',
  // errori e attese
  progressiva: 'Sto controllando gli orari.',
  caricamento: 'Sto caricando gli orari di {giorno}. Vuoi riprovare tra poco?',
  caricamentoAncora: 'Gli orari di {giorno} non sono ancora pronti. Riprova tra poco.',
  nonRisponde: 'Il servizio non risponde ancora. Riprova tra poco.',
  occupato: 'Il servizio è momentaneamente occupato. Riprova tra poco.',
  datiIncompleti: 'Non riesco a leggere tutti i dati in questo momento.',
  configurazione: 'Il servizio ha un problema di configurazione.',
  nonConfigurata: 'La skill non è ancora configurata.',
  richiestaNonValida: 'Richiesta non valida.',
  nessunaRichiesta: 'Non ho una richiesta da ripetere. Cosa vuoi sapere?',
  vuoiRiprovare: 'Vuoi riprovare?'
};
module.exports = M;
