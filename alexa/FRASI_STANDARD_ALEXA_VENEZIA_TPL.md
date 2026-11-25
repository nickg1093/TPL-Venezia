# Venezia TPL — Specifica del dialogo vocale e guida comandi

**Stato (25/11/2026):** specifica applicata nella revisione 2 della skill (ramo `feature/alexa-voce`). Le sezioni 1–10 restano il
riferimento di progetto; le frasi davvero pronunciate sono nel **catalogo generato** in fondo (§ 11), prodotto eseguendo la skill su scenari
riproducibili (`node alexa/scripts/catalogo.js`). Le frasi fisse (benvenuto, aiuto, errori) stanno in un solo file, `alexa/messaggi.js`,
copiato automaticamente nella funzione Lambda (`node alexa/scripts/prepara-lambda.js`). Differenze volute rispetto alla proposta: la sessione
resta aperta senza domanda finale per permettere i seguiti (vedi `alexa/STATO.md`); «aiuto riepilogo» usa una fermata d'esempio invece del segnaposto.

## 1. Regole editoriali e di comportamento

- Risposta diretta prima, avvertenza rilevante subito dopo. Una richiesta singolare restituisce una sola corsa; plurale due o tre; numero esplicito rispettato, entro un limite ragionevole con paginazione su richiesta. Mai leggere automaticamente tutto un pannello.
- Indicazioni orientative: partenza semplice 1–2 frasi (10–15 s); itinerario sintetico 2–3 frasi (15–25 s); help per categoria 2–3 esempi. La sicurezza e le eccezioni rilevanti prevalgono sulla brevità. Misurare anche l'audio reale.
- Non ripetere domanda, provenienza, data o direzione se già chiare, salvo conferma utile a evitare un errore. Nei seguiti dire solo ciò che cambia. Non ripetere una formula di cortesia dopo ogni risposta.
- Italiano naturale: «tra un minuto», «alle otto e cinque», «all'una», «a mezzanotte», «linea cinque punto due», «tram ti uno», «meno tre centimetri». Verificare pronunce veneziane su Echo e Audio Sandbox. Gestire zero, plurali, apostrofi, punteggiatura, abbreviazioni e ora legale.
- Generare testo semantico prima del rendering vocale. Una sola fase di escape XML; SSML valido, tag e attributi ammessi in it-IT, pause brevi solo se utili. Mai leggere HTML, markdown, URL, ID tecnici o stringhe incomplete. Separare testo APL da SSML.
- Non dire «in orario» senza evidenza; distinguere previsione ACTV, stima del progetto, orario programmato, GPS vecchio, feed assente. Non dedurre ritardo dal solo orario. Mantenere le stesse regole della PWA.
- Disambiguare prima di rispondere: mezzo effettivo, linea, gruppo/ID della fermata, direzione, destinazione successiva sulla stessa corsa, calendario, data e ora. Non scegliere in base al primo nome simile; non confondere pontili, fermate 1/2 e capolinea.
- Le frasi «verso» e «per» richiedono una destinazione/area semanticamente coerente. Verificare la sequenza delle fermate dopo la salita e possibilità di salita/discesa; se una destinazione è generica, risolverla in un insieme verificato di fermate. Se rimane ambiguità reale, una sola domanda mirata.
- Date esplicite non vanno cambiate in silenzio. Esplicitare il giorno di calendario per servizi oltre mezzanotte; non imporre un'ora arbitraria di fine servizio. Distinguere «ultimo di oggi» da «ultimo disponibile da adesso» e «ultima corsa di questa notte».
- Se una richiesta non è supportata, dirlo chiaramente e proporre la funzione realmente disponibile. Non promettere percorsi pedonali sicuri, navigazione GPS, preferiti sincronizzati o notifiche vocali senza implementazione verificata.

## 2. Apertura, guida e gestione dialogo

| Comandi naturali | Risposta standard |
|---|---|
| Apri Venezia TPL | Ciao! Cosa vuoi sapere? |
| Aiuto / Che cosa posso chiederti? | Puoi chiedermi partenze, percorsi, marea o avvisi. Su cosa vuoi una mano? |
| Presentati / Che cos'è Venezia TPL? | Sono Venezia TPL, un servizio indipendente di informazioni sui trasporti e sulla marea di Venezia. Non sono un servizio ufficiale ACTV. |
| Aiuto partenze / Come chiedo gli orari? | Puoi dire: quando passa il due alle Zattere? Oppure: qual è l'ultimo vaporetto da Rialto a Piazzale Roma? |
| Aiuto percorsi | Prova a dire: come arrivo a Rialto da Piazzale Roma? Oppure: quando devo partire per arrivare a Rialto entro le nove? |
| Aiuto marea | Puoi chiedermi il livello attuale, il prossimo colmo, il MOSE o la previsione di acqua alta. |
| Aiuto avvisi | Puoi chiedere: ci sono problemi sulla linea uno? Oppure: ci sono scioperi domani? |
| Aiuto riepilogo | Dimmi: riepilogo della mattina da {fermata}. Puoi usare questa frase anche in una routine compatibile. |
| Tutti i comandi | Posso spiegarti una categoria alla volta: partenze, percorsi, marea, avvisi o riepilogo. La guida completa è nella scheda, se disponibile. |
| Ripeti | Riprodurre l'ultima risposta utile; per dati live segnalare se si tratta di una risposta precedente. |
| Aggiorna / Adesso? | Ricalcolare la richiesta precedente con i dati correnti; non ripetere una vecchia attesa. |
| No, intendevo {correzione} | Applicare la correzione al solo campo indicato; conservare gli altri. |
| Basta / Chiudi / Annulla | A presto! |
| Richiesta non riconosciuta | Non ho capito. Dimmi una fermata, oppure chiedimi la marea. |
| Richiesta non supportata | Questa funzione è disponibile nell'app, ma non ancora a voce. |
| Origine mancante | Da quale fermata parti? |
| Destinazione mancante | Dove vuoi arrivare? |
| Ambiguità reale | Intendi {opzione A} o {opzione B}? |
| Ora ambigua | Intendi le {ora A} o le {ora B}? |
| Giorno ambiguo | Per quale giorno? |
| Contesto assente | A quale fermata o percorso ti riferisci? |

L'invocazione diretta «Alexa, chiedi a Venezia TPL …» non deve riprodurre il benvenuto. Mantenere help e stop operativi anche senza Render. Nome di invocazione: usare quello effettivamente compilato sulla console. Le formule degli esempi non garantiscono che il wake word venga riconosciuto da ogni dispositivo.

## 3. Partenze, ritardi e servizio

| Comando / situazione | Modello di risposta |
|---|---|
| Tra quanto passa il prossimo tram a San Marco Cattaneo verso Venezia? | Il prossimo tram T1 passa tra {attesa}, alle {ora}, dalla fermata San Marco Cattaneo 1. {Stato, solo se utile e noto}. |
| Quando passa il prossimo autobus da {fermata} per {destinazione}? | La linea {linea} passa tra {attesa}, alle {ora}. {Fermata esatta se necessaria}. |
| Quando passa il 2 alle Zattere? | La linea 2 per {destinazione} passa tra {attesa}, alle {ora}, dal pontile {pontile}. |
| Prossimi tre vaporetti da Rialto per Piazzale Roma | {Linea}, alle {ora}, pontile {pontile}. Poi {linea}, alle {ora}, pontile {pontile}. Infine {linea}, alle {ora}, pontile {pontile}. |
| E quello dopo? / E il successivo? | Il successivo passa alle {ora}, tra {attesa}. {Pontile o linea se cambiati}. |
| E verso Mestre? / E nell'altra direzione? | {Ricalcolare con nuova direzione e stessa fermata/mezzo/data}. |
| E domani alle sette? | Domani, dalle sette, la prima corsa è alle {ora}, linea {linea}. È un orario programmato. |
| Il 5.2 è in ritardo a {fermata}? | La prossima corsa ha {ritardo} di ritardo. È prevista alle {ora}. |
| Il mezzo è già in fermata | La linea {linea} è in fermata, direzione {destinazione}. |
| Ritardo noto | Ha {ritardo} di ritardo. |
| Anticipo noto | Risulta in anticipo di {anticipo}. |
| Puntualità verificata | Risulta in orario. |
| Tempo reale assente | Da orario, passa alle {ora}. Non ho una previsione aggiornata. |
| Stima GPS | Il passaggio è stimato alle {ora}. |
| Dato vecchio | L'ultima previsione risale a {età} fa. |
| Corsa soppressa | La corsa delle {ora} è soppressa. La prima successiva utilizzabile è {ora e linea}, se disponibile. |
| Fermata saltata | Questa corsa non ferma a {fermata}. {Alternativa verificata, se presente}. |
| Fermata sospesa/spostata | Attenzione: la fermata {nome} risulta sospesa/spostata. Il passaggio resta in orario, ma il mezzo potrebbe non fermarsi. |
| Nessuna partenza nella finestra | Non risultano partenze per {destinazione} nelle prossime {durata effettiva}. |
| Nessuna corsa programmata nella data | Non risultano corse per {destinazione} il {giorno}, secondo gli orari disponibili. |
| Linea/destinazione incompatibile | La linea {linea} non serve {destinazione} dopo {fermata}, per gli orari richiesti. |
| Ritardi di un'intera linea | Sulla linea {linea}, {numero noto} corse hanno ritardi rilevati. {Sintesi del massimo/intervallo se rappresentativo}. Vuoi sapere di una fermata precisa? |
| Che linee passano da {fermata}? | Da {fermata} passano le linee {elenco breve}. {Altre su richiesta}. |

**Caso di regressione:** San Marco Cattaneo 1/2 e T1 verso Venezia: l'esito atteso dall'utente è fermata 1. Validare con i GTFS della data e le fermate successive effettive; non hardcodare questa corrispondenza. Se in futuro cambia il servizio, deve cambiare la risposta.

## 4. Prima/ultima corsa e orari programmati

| Comando / situazione | Modello di risposta |
|---|---|
| Qual è l'ultimo vaporetto da Rialto a Piazzale Roma? | L'ultimo collegamento diretto parte alle {ora}, con la linea {linea}, dal pontile {pontile}. Arriva alle {ora arrivo}. È un orario programmato. |
| Ultimo vaporetto domani da Rialto a Piazzale Roma | Domani, l'ultimo collegamento diretto parte alle {ora}, linea {linea}. Arriva alle {ora arrivo}. |
| E l'ultima corsa della linea 1? | L'ultima corsa della linea 1 per {destinazione} parte alle {ora}. |
| Ultima corsa già passata | L'ultima corsa programmata era alle {ora}. Non ne risultano altre per il periodo richiesto. |
| Ultima corsa dopo mezzanotte | Parte alle {ora}, nella notte tra {giorno A} e {giorno B}. |
| Prima corsa domattina | Domani la prima corsa per {destinazione} parte alle {ora}, linea {linea}. |
| Quali sono gli orari domani dalle 18? | Domani, dalle diciotto: {prime corse richieste}. |
| Nessun collegamento diretto | Non risultano collegamenti diretti. Vuoi che cerchi un percorso con cambi? |
| Orari oltre copertura | Non ho ancora orari validi per il {giorno}. |

**Regola obbligatoria:** ricerca sull'intero insieme di corse attive per le date rilevanti, con calendar/calendar_dates, servizio oltre le 24, pickup/drop-off, stop_sequence e ordine temporale assoluto. Non scorrere finestre di due ore né dedurre l'ultima corsa dal pannello. Calcolare arrivo e stop effettivi. Se ci sono frequenze GTFS, gestirle secondo la semantica del feed, senza inventare orari esatti. Un servizio cancellato o con fermata saltata non è un collegamento utilizzabile quando l'informazione è disponibile. Per un orario programmato futuro non garantire la corsa.

## 5. Pianificatore sintetico

| Comando / situazione | Modello di risposta |
|---|---|
| Come arrivo a Rialto da Piazzale Roma? | Ti consiglio la linea {linea}, alle {partenza}, dal pontile {pontile}. Arriverai alle {arrivo}, tra circa {durata}. |
| Devo arrivare a Rialto entro le nove, partendo dalle Zattere | Ti consiglio di partire alle {partenza} con la linea {linea}. Arriverai alle {arrivo}, con {margine} di margine. |
| Parto da {origine} domani alle diciotto per {destinazione} | Domani, la prima soluzione utile dalle diciotto parte alle {partenza}, linea {linea}. Arrivo alle {arrivo}. |
| Percorso con un cambio | Parti alle {partenza} con la linea {linea A}. Cambia a {fermata} con la linea {linea B}. Arrivo alle {arrivo}. |
| Coincidenza a rischio | Attenzione: hai solo {margine} per il cambio a {fermata}. |
| Coincidenza persa | Con i ritardi attuali non riesci a prendere la coincidenza. {Alternativa verificata, se presente}. |
| Senza cambi | Il miglior collegamento diretto parte alle {partenza}, linea {linea}. Arrivo alle {arrivo}. |
| Altra soluzione / Alternativa | Un'alternativa parte alle {partenza}, linea {linea}. Arrivo alle {arrivo}. |
| E al ritorno? | {Invertire origine/destinazione, ricalcolare per l'orario coerente; chiedere l'ora se necessaria}. |
| Mi dici i dettagli? | Sali a {fermata/pontile} alle {ora}. {Cambi essenziali}. Scendi a {fermata} alle {ora}. |
| Nessuna soluzione entro l'ora | Non trovo un percorso che arrivi entro le {ora}. La prima soluzione disponibile arriva alle {ora}, se verificata. |
| Opzione tutto a piedi | Il motore stima circa {durata} a piedi, in linea d'aria. Per il percorso reale usa l'app. |
| Possibile acqua alta sul tragitto | Con la marea prevista, alcuni tratti a piedi potrebbero essere allagati. Verifica il percorso nell'app. |

Non dettare tutte le tappe, la distanza di ogni camminata o tutte le alternative senza richiesta. Non omettere la fermata di salita quando diversa da quella attesa, il pontile utile o un rischio di servizio determinante. Conservare su Echo Show/scheda dettagli verificati. Distinguere tempo reale e programmato.

## 6. Marea, MOSE, acqua alta e passerelle

| Comando / situazione | Modello di risposta |
|---|---|
| Com'è la marea? | La marea è a {livello} centimetri, {tendenza}. Il prossimo colmo è previsto alle {ora}, a {livello previsto} centimetri. |
| A che ora è il prossimo colmo? | Il prossimo massimo è previsto alle {ora}, a {livello} centimetri. |
| E il minimo? | Il prossimo minimo è previsto alle {ora}, a {livello} centimetri. |
| Domani mattina c'è acqua alta? | {Previsione per la fascia richiesta, livello e ora}. {Stato MOSE pertinente e incertezza}. |
| Ci sarà acqua alta stasera? | {Previsione disponibile per la fascia serale, distinguendo livello osservato e previsione}. |
| Il MOSE è sollevato? | {Stato verificato delle barriere}. Ultimo aggiornamento alle {ora}, se utile. |
| Servono gli stivali a San Marco? | Con {livello} centimetri, a {zona} è possibile trovare acqua. {Consiglio prudente basato sulle quote realmente disponibili}. |
| Ci sono passerelle alle Zattere? | Per {zona} è prevista la posa di passerelle da {soglia} centimetri. Non posso confermare che siano effettivamente posate. |
| Dati vecchi | L'ultimo dato della marea risale alle {ora}. Non ho una misura più recente. |
| Previsione insufficiente | Non ho una previsione disponibile per quella fascia oraria. |
| MOSE non disponibile | Non riesco a verificare lo stato del MOSE in questo momento. |

Usare classificazioni, fonti e regole PWA, non soglie inventate. Distinguere previsione senza MOSE, livello interno laguna e stato effettivo delle barriere. Non dichiarare una calle sicuramente asciutta o una passerella sicuramente presente. Non trasformare stime altimetriche in misure.

## 7. Avvisi e scioperi

| Comando / situazione | Modello di risposta |
|---|---|
| Ci sono problemi oggi? | {Numero di eventi rilevanti e sintesi dei principali, senza duplicati}. |
| Ci sono problemi sulla linea 5.2? | Sulla linea cinque punto due, {effetto e periodo}. |
| Ci sono avvisi a {fermata}? | A {fermata}, {effetto, durata se nota, alternativa ufficiale se disponibile}. |
| Ci sono scioperi questa settimana? | {Giorno, fascia dello sciopero, servizi interessati e fasce garantite se pubblicate}. {Limite di copertura}. |
| Quali sono le fasce garantite? | Per {servizio}, le fasce garantite pubblicate sono {fasce}. |
| E per i vaporetti? | {Filtrare il precedente evento per il servizio navigazione}. |
| Ci sono problemi per nebbia? | {Disservizio attivo pertinente, se presente}. |
| Il servizio è tornato regolare? | {Stato del ripristino, solo se confermato dal dato}. |
| Nessun avviso pertinente | Non risultano avvisi attivi per {ambito}, nei dati disponibili. |
| Dati avvisi indisponibili | Non riesco a controllare gli avvisi in questo momento. |
| Dettagli / Leggi l'avviso | {Sintesi più estesa e link ufficiale nella scheda, senza leggere URL a voce}. |

Non confondere assenza di avvisi con garanzia di regolarità. Filtrare per date, fermate, linee, direzione e servizio. Non leggere integralmente comunicati, duplicati o avvisi scaduti come se fossero attuali. Fasce garantite soltanto se esplicitamente pubblicate.

## 8. Riepilogo e routine

| Comando / situazione | Modello di risposta |
|---|---|
| Riepilogo della mattina | La marea è a {livello} centimetri. {Avviso rilevante o assenza nei dati}. |
| Riepilogo da San Marco Cattaneo verso Venezia | {Prossimo tram e attesa}. {Marea}. {Avvisi rilevanti}. |
| Come sono i trasporti oggi? | {Sintesi rete, criticità e indicazione sulla disponibilità dati}. |
| Routine con fermata esplicita | Risposta autonoma, senza domanda finale se non necessaria. |
| Routine senza fermata | Non inventare una fermata; riepilogo generale o configurazione esplicita nella frase della routine. |

## 9. Caricamento, indisponibilità e recupero

| Condizione | Risposta |
|---|---|
| Lavorazione in corso (progressive response, se utile) | Sto controllando gli orari. |
| HTTP 409 / giorno in caricamento | Sto caricando gli orari di {giorno}. Vuoi riprovare tra poco? |
| Ripetizione mentre il caricamento continua | Gli orari di {giorno} non sono ancora pronti. Riprova tra poco. |
| Render non raggiungibile (causa non certa) | Il servizio non risponde ancora. Riprova tra poco. |
| Avvio a freddo effettivamente riconoscibile | Il servizio si sta avviando. Riprova tra poco. |
| Server occupato / 429 / 503 | Il servizio è momentaneamente occupato. Riprova tra poco. |
| Risposta incompleta o non valida | Non riesco a leggere tutti i dati in questo momento. |
| GTFS assente per data | Non ho orari disponibili per il {giorno}. |
| Errore configurazione | Il servizio ha un problema di configurazione. |
| Riprova / Sì (con operazione pendente) | Ripetere la stessa interrogazione con tutti i parametri originali; mantenere il contesto se fallisce ancora. |
| Nessun dato realtime | Posso darti gli orari programmati, ma non i ritardi attuali. |

Alexa impone circa 8 secondi per la risposta complessiva: un messaggio progressivo non estende il limite. La Lambda può usare il token direttive solo localmente e in memoria, senza trasmetterlo a Render. Per caricamenti lunghi restituire una risposta finale controllata e mantenere la richiesta pendente nella sessione. Se la sessione si chiude, non promettere una risposta automatica futura. Verificare l'eventuale strategia di precaricamento nei limiti di memoria e costo. Non creare cicli di retry aggressivi.

## 10. Criteri di collaudo

- Confrontare l'esito semantico con i dati PWA per ogni intent, su almeno due date diverse e un giorno con eccezioni di calendario. Separare test deterministici, dati reali e verifiche Amazon.
- Partenze: singolare/plurale, attesa, direzioni intermedie, fermate 1/2, pontili, stesso nome in aree diverse, route_type, corsa circolare, destinazione prima/dopo salita, salite/discese vietate, feed assente e vecchio.
- Ultime corse: giornata intera, lunghi buchi, oltre mezzanotte, festivi, domani, data esplicita, ultima corsa già passata, cancellazione, direzioni non dirette. Confrontare con una ricerca indipendente su GTFS della data.
- Contesto: «e quello dopo», «e domani», «e al ritorno», «no, verso Mestre», «ripeti», «aggiorna», «riprova», nuova richiesta completa dopo una richiesta pendente. Usare identità corsa/data, non semplici offset instabili della lista.
- Pianificatore: partenza adesso, partenza a ora futura, arrivo entro, cambi, diretto, alternativa, mancata coincidenza, servizi sospesi, caricamento programmato.
- Voce: validità SSML, escaping singolo, niente doppia punteggiatura, niente frasi monche, plurali e pronunce; misurare lunghezza e ascoltare con simulatore/Echo. Testare frasi non identiche ai sample utterances e registrare errori di riconoscimento vs errori di backend senza dati personali.
- Robustezza: 409, 429, 503, timeout, cold start, JSON malformato, date fuori copertura, memoria e concorrenza; verifica regressioni PWA/Web Push.
- Build del modello it-IT e test in console Amazon non equivalgono a test unitari. Separare pass/fail effettivi da prove ancora da fare su dispositivo. Nessuna pubblicazione automatica senza consenso.

## Fonti normative e di progettazione

- Amazon, Voice fundamentals: https://developer.amazon.com/en-US/alexa/alexa-haus/voice-fundamentals
- Amazon, Be brief: https://developer.amazon.com/en-US/alexa/alexa-haus/design-principles/be-brief
- Amazon, SSML: https://developer.amazon.com/en-US/docs/alexa/custom-skills/speech-synthesis-markup-language-ssml-reference.html
- Amazon, Entity resolution: https://developer.amazon.com/en-US/docs/alexa/custom-skills/entity-resolution.html
- Amazon, Dynamic entities: https://developer.amazon.com/en-US/docs/alexa/custom-skills/use-dynamic-entities-for-customized-interactions.html
- Amazon, Progressive response: https://developer.amazon.com/en-US/docs/alexa/custom-skills/send-the-user-a-progressive-response.html
- GTFS Schedule: https://gtfs.org/documentation/schedule/reference/
- GTFS Schedule Best Practices: https://gtfs.org/documentation/schedule/schedule-best-practices/
- Community (riscontro sul timeout, subordinato alle specifiche ufficiali): https://stackoverflow.com/questions/45967444/is-there-a-way-to-handle-a-long-duration-request-response-for-alexa

## 11. Catalogo delle risposte effettive (generato)

Generato da `node alexa/scripts/catalogo.js` con dati inventati e orologio fisso (mercoledì 25/11/2026, 08:10): nomi, orari e linee sono
illustrativi. Rigenerare dopo ogni modifica alle frasi; la prova `tests/alexa-modello.test.js` segnala un catalogo non aggiornato.

<!-- CATALOGO:INIZIO -->

#### Apertura e guida

| Condizione | Risposta effettiva |
|---|---|
| Apertura senza domanda | Ciao! Cosa vuoi sapere? |
| Aiuto | Puoi chiedermi partenze, percorsi, marea o avvisi. Su cosa vuoi una mano? |
| Aiuto partenze | Puoi dire: quando passa il due alle Zattere? Oppure: qual è l'ultimo vaporetto da Rialto a Piazzale Roma? |
| Aiuto percorsi | Prova a dire: come arrivo a Rialto da Piazzale Roma? Oppure: quando devo partire per arrivare a Rialto entro le nove? |
| Aiuto marea | Puoi chiedermi il livello attuale, il prossimo colmo, il MOSE o la previsione di acqua alta. |
| Aiuto avvisi | Puoi chiedere: ci sono problemi sulla linea uno? Oppure: ci sono scioperi domani? |
| Aiuto riepilogo | Dimmi: riepilogo della mattina da Zattere, con la tua fermata. Puoi usare questa frase anche in una routine dell'app Alexa. |
| Presentati / che cos'è Venezia TPL | Sono Venezia TPL, un servizio indipendente di informazioni sui trasporti e sulla marea di Venezia. Non sono un servizio ufficiale ACTV. Uso gli orari e il tempo reale pubblicati da ACTV e i dati delle maree del Comune di Venezia. |
| Tutti i comandi | Posso spiegarti una categoria alla volta: partenze, percorsi, marea, avvisi o riepilogo. Quale vuoi? La guida completa è nell'app Venezia TPL, nella pagina Informazioni. |
| Basta / Chiudi / Annulla | A presto! |
| Richiesta non riconosciuta (prima volta) | Non ho capito. Dimmi una fermata, oppure chiedimi la marea. |
| Richiesta non riconosciuta (seconda volta) | Scusa, non ho ancora capito. Prova a dire: quando passa il due alle Zattere? Oppure: com'è la marea? |
| Seguito senza contesto («e il prossimo?» come prima frase) | A quale fermata o percorso ti riferisci? |

#### Partenze

| Condizione | Risposta effettiva |
|---|---|
| Una corsa, tram con direzione verificata sulle fermate successive | Il tram ti uno per Venezia passa tra cinque minuti, alle otto e quindici, dalla fermata San Marco Cattaneo 1. |
| «E nell'altra direzione?» | Il tram ti uno per Monte Celo Favaro passa tra quattro minuti, alle otto e quattordici, dalla fermata San Marco Cattaneo 2. |
| Una corsa (domanda singolare) | La linea cinque punto uno per Lido Santa Maria Elisabetta passa tra tre minuti, alle otto e tredici, dal pontile B. |
| Più corse (domanda plurale), stati diversi | La linea cinque punto uno per Lido Santa Maria Elisabetta tra tre minuti, alle otto e tredici, pontile B. Poi la linea due per San Marco, San Zaccaria tra dieci minuti, alle otto e venti, pontile B, con quattro minuti di ritardo. Infine la linea sei per Piazzale Roma tra nove minuti, alle otto e diciannove, pontile B. Per la corsa delle otto e diciannove non ho una previsione aggiornata. |
| «E quello dopo?» | Poi la linea due per San Marco, San Zaccaria passa tra dieci minuti, alle otto e venti, dal pontile B, con quattro minuti di ritardo. |
| Ripeti (dato in tempo reale) | Ripeto la risposta di prima. La linea cinque punto uno per Lido Santa Maria Elisabetta passa tra tre minuti, alle otto e tredici, dal pontile B. |
| Mezzo in fermata | La linea due per Lido Santa Maria Elisabetta è in fermata, al pontile B. |
| Corsa soppressa e stima non aggiornata | La linea due per Lido Santa Maria Elisabetta delle otto e undici è soppressa. Infine la linea due per Lido Santa Maria Elisabetta tra quattro minuti, alle otto e quattordici, pontile B, l'ultima previsione risale a sette minuti fa. |
| Solo orario programmato (nessun tempo reale) | La linea sei per Lido Santa Maria Elisabetta passa alle otto e diciotto, tra otto minuti, dal pontile B. È l'orario programmato: non ho una previsione aggiornata. |
| Nessuna partenza con il filtro | Non risultano partenze della linea quattro punto uno da Zattere nelle prossime due ore. Da qui passano però altre corse. |
| Orari di un altro giorno da un'ora | Domani, dalle otto, la prima corsa è la linea cinque punto uno per Lido Santa Maria Elisabetta alle otto e venti, pontile C. È un orario programmato. |
| Fermata ambigua | Intendi Murano Colonna, Murano Faro o Murano Museo? |
| Fermata mancante | Da quale fermata? |
| Fermata sconosciuta | Non conosco la fermata Xyzzy. Prova con un altro nome, per esempio una fermata vicina. |
| Linee di una fermata | Oggi da Rialto passano le linee uno, cinque punto uno ed enne. |

#### Prima e ultima corsa

| Condizione | Risposta effettiva |
|---|---|
| Ultimo collegamento diretto (dopo mezzanotte) | L'ultimo collegamento diretto parte alle ventitré e trenta, con la linea uno per Piazzale Roma, dal pontile C. Arriva alle ventitré e quarantacinque. Di notte c'è anche la linea enne: l'ultima corsa parte all'una e dieci, nella notte tra mercoledì e giovedì. È un orario programmato. |
| «E domani?» dopo l'ultima corsa | Domani, l'ultimo collegamento diretto parte alle ventitré e trenta, con la linea uno per Piazzale Roma, dal pontile C. Arriva alle ventitré e quarantacinque. Di notte c'è anche la linea enne: l'ultima corsa parte all'una e dieci, nella notte tra giovedì e venerdì. È un orario programmato. |
| Ultima corsa già passata | L'ultima corsa programmata da Rialto a Piazzale Roma era alle ventitré e trenta. Non ne risultano altre per oggi. |
| Prima corsa di domani | Domani, il primo collegamento diretto parte alle otto e trenta, con la linea uno per Piazzale Roma, dal pontile C. Arriva alle otto e quarantacinque. È un orario programmato. |
| Senza destinazione: una risposta per direzione | L'ultima corsa da Rialto parte alle ventitré e trenta, con la linea uno per Piazzale Roma, dal pontile C. Verso Lido Santa Maria Elisabetta, l'ultima è alle otto e venti, linea cinque punto uno. Di notte c'è anche la linea enne: l'ultima corsa parte all'una e dieci, nella notte tra mercoledì e giovedì. È un orario programmato. |
| Nessun collegamento diretto | Non risultano collegamenti diretti da Rialto a Mestre stazione oggi. Vuoi che cerchi un percorso con cambi? |
| Nessun orario per la data | Non ho ancora orari validi per venerdì 25 dicembre. |

#### Percorsi

| Condizione | Risposta effettiva |
|---|---|
| Percorso sintetico | Ti consiglio la linea due, alle otto e quattordici, dal pontile B. Arriverai alle otto e trentatré, tra circa ventuno minuti. Parte con due minuti di ritardo. |
| «Dimmi i dettagli» | Cammina un minuto fino a Zattere, pontile B. Prendi la linea due per San Marco, San Zaccaria da Zattere, pontile B, alle otto e quattordici, con due minuti di ritardo. Scendi a San Marco Vallaresso, pontile A, alle otto e trentuno. Poi cammina due minuti fino a destinazione. In tutto ventuno minuti, di cui tre minuti a piedi, stimati in linea d'aria. Altre partenze utili: alle otto e ventisette, con arrivo alle otto e quarantotto. |
| Arrivo entro un orario | Ti consiglio di partire alle otto e dodici con la linea due, dal pontile B. Arriverai alle otto e trentatré, con dodici minuti di margine. Parte con due minuti di ritardo. È un orario programmato. |
| Destinazione mancante | Dove vuoi arrivare? |
| Nessuna soluzione | Non trovo un collegamento da Zattere a San Marco nelle prossime ore. |

#### Marea

| Condizione | Risposta effettiva |
|---|---|
| Livello e prossimo colmo | A Punta della Salute la marea misurata è settantadue centimetri sullo zero mareografico, in crescita. Misura di tre minuti fa. Il prossimo colmo è previsto alle dieci e dieci, intorno a novantacinque centimetri. |
| Prossimo colmo | Il prossimo colmo è previsto alle dieci e dieci: circa novantacinque centimetri, marea sostenuta. Sono previsioni del Centro Maree e possono cambiare. |
| Prossimo minimo | Il prossimo minimo è previsto alle sedici e dieci, a venti centimetri. È una previsione del Centro Maree. |
| MOSE | Il MOSE non è sollevato: le barriere sono a riposo, in recesso. Fonte: Autorità per la Laguna di Venezia. |
| Acqua alta stasera | Per stasera non ho ancora una previsione: quella disponibile arriva fino alle sedici e dieci. Adesso la marea misurata è settantadue centimetri. |

#### Avvisi

| Condizione | Risposta effettiva |
|---|---|
| Nessun avviso | Non risultano avvisi di servizio, nei dati disponibili. Controllo gli avvisi in corso e dei prossimi tre giorni. |
| Avviso su una linea | C'è un avviso sulla linea due. Deviazione: Linea 2 deviata per lavori. In corso fino a oggi alle tredici e dieci. |

#### Riepilogo

| Condizione | Risposta effettiva |
|---|---|
| Riepilogo della mattina | La marea a Punta della Salute è settantadue centimetri, in crescita. Nelle prossime dodici ore è previsto un massimo di novantacinque centimetri alle dieci e dieci: marea sostenuta. Non risultano avvisi di servizio, nei dati disponibili. |

#### Errori e attese

| Condizione | Risposta effettiva |
|---|---|
| Orari in caricamento | Sto caricando gli orari di martedì 8 dicembre. Vuoi riprovare tra poco? |
| Server occupato | Il servizio è momentaneamente occupato. Riprova tra poco. |
| Dati non leggibili | Non riesco a leggere i dati in questo momento. Riprova tra poco. |
<!-- CATALOGO:FINE -->
