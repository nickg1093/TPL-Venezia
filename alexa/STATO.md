# Skill Alexa — stato e decisioni (da leggere per primo per riprendere il lavoro)

Aggiornato il **25/11/2026**. Versione pubblicata (prima revisione): su `main` e su Render, configurata dall'utente nella console Amazon.
**Revisione 2** (motore orari, dialogo, voce): ramo `feature/alexa-voce`, non pubblicata. Guida: [`README.md`](README.md) · comandi:
[`GUIDA_COMANDI.md`](GUIDA_COMANDI.md) · specifica e catalogo delle frasi: [`FRASI_STANDARD_ALEXA_VENEZIA_TPL.md`](FRASI_STANDARD_ALEXA_VENEZIA_TPL.md).

## 1. Stato

| Parte | Stato |
|---|---|
| Motore orari (`diretti.js` + `gtfsAlexa` in `server.js`) | prima/ultima corsa, orari programmati, linee di una fermata: ricerca sull'intero GTFS della data (calendario, eccezioni, orari oltre le 24, sequenza delle fermate, salita non al capolinea, soppressioni del tempo reale) |
| Direzione | verificata sulla sequenza GTFS della corsa (righe di `/api/zone` in processo con `_G`); a testo solo se il luogo non è una fermata nota |
| Mezzo | vaporetto / autobus / tram da `route_type` (corretto `gtfs.js`, che non leggeva `route_type`) |
| Etichette dei pali | quelle della PWA (`public/js/zones.js` caricato così com'è): «San Marco Cattaneo 1», «pontile C», «corsia A1» |
| Dialogo | contesto strutturato, seguiti che cambiano un solo parametro, corse già dette per identità, «riprova/aggiorna/ripeti/dettagli/nell'altra direzione/solo vaporetti/e l'ultimo?» |
| Voce | frasi fisse in `messaggi.js` (copia generata nella Lambda), benvenuto «Ciao! Cosa vuoi sapere?», aiuto per categoria, presentazione, risposte brevi; catalogo effettivo generato (`scripts/catalogo.js`) |
| Affidabilità | 409 con attesa breve nel server (≤ 4 s) e poi «Sto caricando gli orari di …», 429/503/timeout distinti, richiesta conservata per «riprova», risposta progressiva nella Lambda |
| Prove | `tests/alexa-*.test.js` (dialogo, skill, modello, lambda, server con GTFS veri, unità): `npm test` verde |
| **Da fare dall'utente** | pubblicare il ramo e fare il deploy; nella console Amazon reimportare il modello e incollare la nuova `lambda/index.js`; provare sul simulatore e su Echo |
| **Non verificato** | compilazione del nuovo modello nella console, pronunce e riconoscimento reale, risposta progressiva su un dispositivo vero, tempi su Render |

## 2. Decisioni (e perché)

1. **Alexa-hosted (Lambda gratuita) come ponte → `/api/alexa` su Render → logica in processo.** Confronto: *endpoint HTTPS diretto su Render* (più semplice, ma obbliga a verificare firma/certificato di ogni richiesta, espone un URL pubblico per Alexa, e senza ponte non risponde nemmeno a Stop/Aiuto quando Render dorme); *tutto in Alexa-hosted* (nessuna dipendenza da Render ma obbligherebbe a duplicare GTFS, RAPTOR, marea e avvisi: vietato dal progetto e oltre i limiti di spazio/memoria). Il ponte è gratuito, senza account AWS, e tiene un solo motore di dati.
2. **Segreto in `lambda/segreto.js`** (non nel repository): Alexa-hosted non ha variabili d'ambiente. Token ≥ 16 caratteri, confronto a tempo costante (`sec.tokenOk`), errori di autenticazione conteggiati (`sec.authFailed`).
3. **Privacy per costruzione**: la funzione scarta userId, deviceId, sessionId e token di accesso; il server non li legge; nessun registro delle frasi; nessuna preferenza salvata. Il contesto del dialogo sta solo negli attributi di sessione (`ctx`, `pend`, `ultimo`, `fallback`).
4. **Nessuna modifica al Web Push né alla PWA**: `push.js` e `watch.js` non nominano Alexa (controllato da un test). Le chiamate della skill rispettano il bilancio CPU/memoria del server (`occupato()`); se il server è sotto pressione la skill rinuncia.
5. **Nessun LLM, nessuna dipendenza nuova**: CommonJS puro; nessun ASK SDK (la logica è piccola e testabile da sola, la funzione Lambda usa solo `https`).
6. **Dialogo gestito in proprio** (non con il Dialog Model di Alexa): `esegui()` risolve i luoghi, chiede «Da quale fermata?» o «Quale intendi?» e conserva la scelta in `att.pend`. Più controllo sui nomi veneziani omonimi.
7. **Marea**: etichette parlate con soglie CPSM (normale <80; sostenuta 80–109; acqua alta ≥110; eccezionale ≥140). A ≥110 cm si dice «senza MOSE» perché la previsione CPSM è senza barriere; il MOSE limita il livello in città a 88 cm. Passerelle: stagione 15 settembre–30 aprile, mai date per posate.
8. **Percorsi**: la skill dice solo ciò che dice il motore della PWA; a marea ≥100 cm avverte che non calcola percorsi a prova di acqua alta; tratti a piedi «in linea d'aria».
9. **Intent «Ripeti/Prossimo/Sì/No» propri**, mappati in `skill.js` (`ALIAS_INTENTI`) agli equivalenti standard: i built-in italiani non sono stati verificati.
10. **Flash Briefing separato**: feed pubblico `GET /api/alexa/flash` (2 voci: avvisi e marea, in memoria 60 s), senza dati personali.
11. **Routine**: create dall'utente nell'app Alexa (l'API Routines Kit è dismessa). La frase «riepilogo della mattina» è pensata per quello.

12. **Prima/ultima corsa dall'intero GTFS** (revisione 2): mai dal pannello. `diretti.js` scorre solo le corse delle fermate di partenza
    (`stopIndex`), per la versione dei GTFS della data (per oggi e domani quella in memoria, se ha la stessa impronta; altrimenti quella della
    modalità «Programmato», `live.dataFor`). Nessun archivio in più in memoria oltre a quello che la PWA già carica per le altre date.
13. **`pickup_type`/`drop_off_type` non sono letti dal server** (non sono in memoria): si esclude solo la salita al capolinea d'arrivo e la
    discesa prima della salita. Le fermate «a richiesta» restano valide (come nella PWA).
14. **Ultima corsa «di oggi» = giornata di servizio** (orari GTFS oltre le 24:00 compresi, detti come «nella notte tra … e …»). Prima delle
    04:00 vale la giornata precedente (regola già usata da tutta la skill); se l'ultima è già passata lo dice.
15. **Microfono aperto senza domanda finale** dopo le risposte, per i seguiti; il riepilogo chiude (routine). Se la certificazione dello store
    chiedesse una domanda esplicita: `DOMANDA_FINALE = true` in `skill.js`.
16. **Risposta progressiva** («Sto controllando gli orari») solo dalla Lambda, solo se il server non ha risposto entro 1,2 s; il token di Alexa
    resta nella Lambda. Il limite complessivo di ~8 s non cambia: timeout dell'inoltro 6,5 s.
17. **Errori**: nessuna causa inventata («si sta svegliando» tolto): «non risponde ancora» (timeout/rete/502/504), «momentaneamente occupato»
    (429/503), «problema di configurazione» (401/403/404). La richiesta resta in sessione (`rifai` nella Lambda, `riprova` nel server).

## 3. Misure (server locale con GTFS veri e feed simulato, Linux)

* Partenze adesso e marea: mediana ≈ 15 ms, 95° percentile ≈ 60 ms (40 richieste).
* Ultima/prima corsa sull'intero GTFS di oggi (Rialto → Piazzale Roma, tram a San Marco Cattaneo, linee di Piazzale Roma): 60–170 ms.
* Prima corsa in una data da caricare (20 dicembre, versione dei GTFS da caricare): ≈ 0,6 s (attesa del caricamento compresa).
* Memoria del server ≈ 255 MB dopo le prove (limite Render 512 MB, soglie interne 400/450 MB); nessuna struttura nuova permanente.
* 60 richieste simultanee: nessun crash, solo 200 o 429/503 con messaggio; la PWA risponde entro 2 s; `push.js` e `watch.js` non toccati.
* In produzione si aggiungono la rete Lambda → Render (stima ~100 ms, non misurata) e l'eventuale avvio a freddo di Render.
* Costi: 0 € (Alexa-hosted, console e simulatore gratuiti; Render invariato; nessun modello linguistico).

## 4. Limiti noti / possibili lavori futuri

* Verifica su un vero Echo (pronuncia, riconoscimento delle fermate, schede APL, tempi).
* Se la compilazione del modello fosse rifiutata per dimensione: ridurre le fermate in `genera-modello.js`.
* Le fermate nuove non si riconoscono finché non si rigenera e reimporta il modello.
* Limite 90 richieste/min comune a tutti gli utenti (indirizzo della Lambda condiviso): da rivedere se la skill diventa pubblica e molto usata.
* Quote RAMSES (rilievo) non usate dalla voce.
* Lingue diverse dall'italiano: risposta di cortesia «funziona solo in italiano».

## 5. Come riprendere

```powershell
git checkout feature/alexa
npm test                                    # atteso: «# fail 0»
node alexa/scripts/genera-modello.js        # (server locale in ascolto) rigenera il modello
```
File chiave: `skill.js` (smistamento e dialogo), `contesto.js` (accesso ai dati), `partenze.js`, `itinerari.js`, `marea.js`, `servizio.js` (avvisi), `riepilogo.js`, `apl.js`, `parlato.js`/`tempo.js`/`luoghi.js` (lingua, tempo, nomi), `lambda/index.js`. Prove e dati finti: `tests/alexa-fixtures.js` (orologio fisso: mercoledì 25/11/2026 08:10 a Venezia).
