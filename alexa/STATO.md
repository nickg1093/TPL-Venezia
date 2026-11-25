# Skill Alexa — stato e decisioni (da leggere per primo per riprendere il lavoro)

Aggiornato il **25/11/2026**. Ramo: `feature/alexa` (derivato dalla v34; **non** pubblicato su `main`, Render o store). Guida per l'utente: [`README.md`](README.md).

## 1. Stato

| Parte | Stato |
|---|---|
| Logica della skill (`alexa/*.js`) | fatta: partenze, ritardo, ultima corsa, percorsi (RAPTOR), marea/colmo/acqua alta/MOSE/stivali/passerelle, avvisi/scioperi, riepilogo, seguiti («e il prossimo?», «e al ritorno?», «e domani?», «senza cambi», «altre corse»), ripeti/aiuto/stop, APL, flash briefing |
| Server (`server.js`, `security.js`) | fatto: `POST /api/alexa`, `GET /api/alexa/flash`, limite `alexa: 90`, `stopsOut()`/`routesOut()` estratte; spento senza `ALEXA_TOKEN` |
| Funzione Lambda (`lambda/`) | fatta e provata con server finto |
| Modello `it-IT` + manifesto + icone | fatti (modello generato dal server con `scripts/genera-modello.js`) |
| Prove | `tests/alexa-*.test.js` (skill, modello, lambda, server, unità): tutte verdi; `npm test` completo verde |
| Privacy/attribuzioni | aggiunte in `public/index.html` (Note legali → «Skill Alexa»; Privacy → «Skill Alexa») |
| **Da fare dall'utente** | account Amazon, creazione skill, import del modello, codice+segreto, token su Render, prove su Echo, routine, (facoltativi) Flash Briefing e pubblicazione: vedi `README.md` §3 |
| **Non verificato** | tutto ciò che richiede Amazon: compilazione del modello, pronuncia, riconoscimento reale delle fermate, comportamento sul dispositivo, schermate della console, certificazione |

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

## 3. Misure (feed simulato, server locale, Linux)

* Latenza di `/api/alexa` su 40 richieste (partenze e marea): mediana ≈ 15 ms, 95° percentile ≈ 60 ms, massimo ≈ 250 ms. In produzione si aggiungono la rete Lambda→Render (Irlanda→Virginia, stima ~100 ms, non misurata) e, dopo 15 minuti di inattività, l'avvio a freddo di Render (30–50 s: coperto da «si sta svegliando, riprova»).
* Memoria del server: ≈ 230 MB prima, ≈ 240 MB dopo 60 richieste simultanee (limite Render 512 MB, soglie interne 400/450 MB).
* 60 richieste simultanee: nessun crash, solo 200 (o 429/503 con messaggio); il server resta vivo.
* Durante il carico della skill la PWA risponde (`/healthz`, `/api/vehicles`) entro 2 s.
* Costi verificati: Alexa-hosted, console e simulatore gratuiti, nessun account AWS né carta richiesti per creare la skill ([documentazione ufficiale](https://developer.amazon.com/en-US/docs/alexa/hosted-skills/build-a-skill-end-to-end-using-an-alexa-hosted-skill.html)); Render invariato (piano gratuito).

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
