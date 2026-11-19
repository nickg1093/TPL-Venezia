# STATO DEL PROGETTO — da leggere per primo in ogni nuova conversazione

Aggiornato il **19/11/2026** (v32.4 pronta, da pubblicare a mano), ultimo commit di codice `0842dd0`. Questo file dice dove siamo, come si lavora e dove guardare.
I dettagli stanno in **README.md** (riferimento completo, con sezioni numerate) e **CRITERI.md** (regole obbligatorie): qui non si ripetono,
si indica la sezione. Chi modifica il progetto aggiorna anche questo file (sezioni 5, 8 e 9).

---

## 1. Cos'è

**Venezia TPL live**: PWA con mappa in tempo reale di autobus, tram e vaporetti ACTV di Venezia, pannelli di fermate e corse, pianificatore
di percorso con viaggio guidato, avvisi di arrivo (notifiche push), avvisi di servizio ACTV, marea, MOSE, preferiti.

| | |
|---|---|
| Sito | https://veneziatpl.onrender.com (Render, piano gratuito, 512 MB, regione Virginia) |
| Codice | https://github.com/nickg1093/TPL-Venezia, ramo `main` (repository pubblico) |
| Copia sul PC dell'utente | `D:\Downloads\TPL-Venezia` (Windows, clone git, aggiornata con GitHub Desktop) |
| Versione | **v32.4** (da pubblicare) (`ABOUT_VERSION` in `server.js`, `VERSION` in `public/sw.js` e `public/js/sistema.js`; `GUIDA_VER` in `public/js/guida.js` è `v31`) |
| Tecnologia | Node.js 22, **nessun framework, nessun database**; dipendenze: solo `leaflet` e `protobufjs` |

## 2. Regole di lavoro (non negoziabili)

1. **Costo 0 €**: solo Render gratuito, GitHub (Actions, rami, CDN jsDelivr) e la PWA. Niente servizi a pagamento, niente carta di credito,
   niente servizi esterni nuovi. Unica eccezione già in uso: Cloudflare Workers AI gratuito, solo dentro GitHub Actions, per gli avvisi.
2. **La funzionalità viene prima di tutto**: nessuna funzione esistente si perde o peggiora. Gli **avvisi di arrivo** devono restare puntuali.
3. **Il server Render non deve mai andare in crash** (512 MB): vedi `memoria.js` e CRITERI.md §3.
4. **Privacy**: solo misure aggregate e temporanee, nessun dato personale, nessun cookie, nessuno script di terzi, nessuna pubblicità.
5. Se una modifica può **bloccare utenti normali**, prima si segnala e si decide con l'utente.
6. **CRITERI.md vale per ogni modifica**: sicurezza, banda, carico di Render, CPU, memoria, batteria, traffico dati, testo grande, tasto «indietro».
7. **Il deploy lo fa sempre l'utente a mano** (Render → Manual Deploy). L'IA può fare commit e push su `main`, mai il deploy.
8. I GTFS scaduti e i file non più necessari si eliminano sempre; `data/gtfs/` lo aggiorna il workflow, non a mano.
9. Ogni novità porta le sue prove; prima del push devono passare `npm test` e, se cambia l'interfaccia, le prove di `tests/ui/`.
10. L'utente non è programmatore: risposte in italiano, brevi, con cosa è cambiato, cosa deve fare lui e cosa non è stato verificato.
    Comandi per lui sempre in **PowerShell/Windows**.

## 3. Come è fatto (in 10 righe)

- **Server** (`server.js` + moduli nella cartella principale): legge i GTFS-Realtime ACTV ogni 5 s, li collega ai GTFS statici, serve le API
  (tabella `API` in `server.js`) e un flusso SSE compresso a differenze (`/api/stream`). Nessuna scrittura su disco.
- **Interfaccia** (`public/`): app a pagina singola, moduli JavaScript nativi, Leaflet, service worker, CSP rigida.
- **GitHub Actions** (5 workflow): GTFS ogni 6 ore, archivio avvisi ogni 20 min, archivio marea ogni 15 min, dati per i telefoni (ramo `dati`,
  letto dal CDN jsDelivr), keep-alive ogni 10 min.
- **Rami di soli dati**, mai da unire a `main`: `archivio-avvisi`, `archivio-marea`, `dati`.
- **Ciò che deve durare** sta su GitHub (GTFS, archivi) o sul telefono (`localStorage` con chiavi `tpl.*`, cache `tpl-fissi-1`).
  La memoria del server si azzera a ogni riavvio o deploy.

Dove guardare nel README: schema §1 · ogni file e cosa fa §2 · funzioni §3 · dati salvati §4 · API §5 · variabili d'ambiente §6 ·
GitHub §7 · Render §8 · comandi di prova §9 · ricette per modifiche frequenti §10 · pubblicare e tornare indietro §11 · novità per versione §12 ·
regole del tempo reale app. B · sicurezza app. C · CDN e dati sul telefono app. D · memoria e orari per giorno app. E.

## 4. File principali (per trovare subito il punto giusto)

**Server**
| Argomento | File |
|---|---|
| Instradamento, API, SSE, spegnimento con passaggio degli avvisi | `server.js`, `flusso.js`, `security.js` (limiti per IP, token, CSP) |
| Tempo reale | `live.js`, `tracker.js`, `assign.js`, `turni.js`, `motion.js`, `geo.js` |
| GTFS e orari | `gtfs.js`, `gtfsstore.js`, `zip.js`, `csv.js`, `ids.js`, `schedule.js`, `calendar.js` (ora di Venezia), `orari.js`, `nomi.js` |
| Pianificatore (RAPTOR) | `percorso.js`, `pedonale-*.txt` |
| Avvisi di servizio | `avvisi.js` (regole, 1082 righe), `avvisi-archivio.js`, `avvisi-ai.js` (validazione delle risposte AI) |
| Avvisi di arrivo e viaggio guidato | `watch.js`, `push.js` (Web Push VAPID) |
| Marea, MOSE | `tide.js`, `marea-archivio.js`, `mose.js` (il calendario `ics.js` è stato tolto nella v32.3) |
| Dati fissi per i telefoni | `fissi.js`, `scripts/genera-dati.js` |
| Memoria e misure | `memoria.js`, `metriche.js` |

**Interfaccia (`public/js/`)**
| Argomento | File |
|---|---|
| Mappa, pannelli, navigazione | `app.js` (1460 righe), `nav.js` (tasto «indietro»), `zones.js`, `locate.js`, `util.js` |
| Pianificatore e viaggio guidato | `percorso.js`, `viaggio.js`, `pedoni.js`, `camminata.js`, `scegli.js` |
| Notifiche | `notify.js`, `../sw.js` |
| Preferiti | `fav.js`, `favs.js` |
| Finestre | `avvisi.js`, `tide.js`, `info.js` (anche donazione), `guida.js` |
| Sistema | `sistema.js` (barra dei messaggi, errori, aggiornamento), `scorri.js` (testi che scorrono), `theme-init.js` (tema, dimensione del testo), `pwa.js`, `fissi.js` |
| Stile e icone | `../css/app.css`, `../icons/sprite.svg`, `../index.html` |

## 5. Stato attuale

- **v32.4 (20/11/2026, da pubblicare)**: v32.3 + sciopero ad alta visibilità (README §3.7): scheda all'accesso, pulsante «Sciopero»,
  avvertenze in pannelli e pianificatore, finestra da 8 ore prima alle 05:00 del giorno dopo, fasce garantite e link ufficiali.
- **v32.3 (19/11/2026 sera)**: v32.2 + proposta esatta in «I miei viaggi» e nei link (riapertura nel dettaglio, oppure messaggio e
  alternative), testo condiviso nuovo, calendario tolto, posizione a fasi e spiegazioni nel viaggio guidato, riquadro «alternativa più veloce»,
  «Arrivo entro» con più soluzioni e margine («al limite»): README §12 e §3.4. La stessa parte è nella v33.2 di prova sul PC.
- **v32.2 (19/11/2026)**: avvisi (settore nav/aut, fermate toccate, date, fusioni Telegram↔ACTV, propagazione per fermata) e
  pianificatore (camminate lunghe, consigliata stabile, soppressioni e fermate saltate, coincidenze irrealistiche, «arrivo entro»): README §12 e §3.4.
  La stessa parte è nella v33.1 di prova sul PC (con l'acqua alta).
- **Online**: v32.1 (grafico della marea, deploy confermato dall'utente il 19/11/2026); misure per giorno (verificato il 16/11/2026 alle 21:25: `/api/metriche/giorni` risponde con il token dell'utente).
- **Prove (20/11/2026, v32.4)**: `npm test` → 287 passate, 0 fallite; `run.py` (con le prove dello sciopero), `viaggio.py`, `sistema.py`
  anche con `TESTO=1.3`. `tests/memoria-giorni.test.js` usa la versione dei GTFS `20261102_189116ae.zip`, che il server toglie dopo la sua scadenza
  (20/11/2026): se manca, la prova fallisce senza che ci siano errori nel codice. **(Prima, v32.3)**: `npm test` → 284 passate, 0 fallite. `run.py`, `viaggio.py` passate anche con `TESTO=1.3`; `marea.py` passata;
  `sistema.py` a testo normale si ferma dopo le 22:30 alla prova del pannello di una corsa (dipende dall'ora, succede anche sulla v32.2).
- **Da confermare da parte dell'utente**:
  - `metriche.bat` scelta 2 dopo la correzione del commit `0842dd0` (lo script PowerShell non è eseguibile nell'ambiente dell'IA: non è stato provato);
  - che `https://paypal.me/olocing` si apra correttamente dal pulsante della donazione (l'IA non può aprire quel sito);
  - viaggio guidato e riattivazione delle notifiche su un iPhone vero.

### Ultime versioni (dettagli in README §12)
- **v32.4**: sciopero ad alta visibilità (scheda, pulsante, avvertenze, finestra, fasce, link).
- **v32.3**: proposta esatta salvata e condivisa, condivisione nuova, calendario tolto, GPS a fasi, alternativa più veloce, «Arrivo entro» con margine.
- **v32.2**: avvisi e pianificatore rivisti sui casi reali dell'archivio e sugli orari veri (README §12, §3.4 «Scelta delle soluzioni»).
- **v32.1**: grafico della marea con etichette senza sovrapposizioni (soglia e orario del MOSE, massimi e minimi).
- **Dopo la v32, senza cambio di versione** (solo server e script): misure per giorno. `metriche.js` stima le persone diverse con un'impronta
  dell'IP a sale giornaliero mai salvato e conta le operazioni riuscite; `/api/metriche/giorni` (DIAG_TOKEN) dà oggi e gli ultimi 60 giorni;
  `/healthz` è escluso. Per lo storico sul PC: `metriche.bat` (menu: CSV, vista nel browser senza salvare, cambio token) con
  `scripts/metriche.ps1`, oppure `node scripts/metriche-giorno.js`. Token cifrato in `%LOCALAPPDATA%\TPL-Venezia`; CSV e token esclusi da `.gitignore`.
- **v32**: donazione volontaria PayPal discreta (cuore accanto alla «i» dal 3° giorno d'uso); regole nuove degli avvisi ricavate dall'archivio
  reale (frasi di alternativa, promemoria, giorni non consecutivi, People Mover, indirizzi allungati, eredità di linee alla sostituzione,
  scarto delle linee citate dall'AI solo come alternativa); aggiornamento dell'app con 304 sui file invariati.
- **v31 / v31.1**: «indietro» che non chiude l'app installata; barra di sistema; passaggio degli avvisi alla nuova istanza nei deploy
  (`/api/watch/handoff`); notifiche perse riattivabili; «Dimensione del testo»; testi che scorrono ovunque; nomi con accenti corretti.
- **v30**: viaggio guidato, «I miei viaggi», calendario (`/api/ics`), condivisione come testo, avvisi e marea sulla soluzione.
- **v28–v29**: protezione della memoria, orari per giorno dal CDN, MOSE. **v24–v27**: preferiti, pianificatore, percorsi a piedi reali, dati fissi dal CDN.

## 6. Come si lavora e si prova

**Ambiente dell'IA (Linux)**: clonare il repository con permesso di push, `npm ci`, poi:
```bash
npm test                                   # atteso: fail 0
# server di prova con dati simulati (parte in circa 40 s):
AVVISI_ARCHIVIO=0 DATI_CDN=0 MAREA_ARCHIVIO=0 TRUST_PROXY=1 PORT=3111 DIAG_TOKEN=<almeno16caratteri> node --expose-gc -r ./tests/fakefeed.js server.js
python3 tests/ui/run.py http://localhost:3111 /tmp/ui        # atteso «FALLITI: 0»; ripetere con TESTO=1.3
python3 tests/ui/viaggio.py http://localhost:3111 /tmp/ui    # atteso «Tutto ok»
python3 tests/ui/sistema.py http://localhost:3111 /tmp/ui
```
Senza `AVVISI_ARCHIVIO=0` il server legge l'archivio vero degli avvisi (utile per controllare le regole sui casi reali).

**Pubblicazione**: commit e push su `main` → l'utente fa il pull sul PC e il deploy manuale su Render → controllo con `/api/about`.
Il workflow dei GTFS fa commit su `main` da solo: prima del push serve spesso `git fetch` + `git rebase origin/main`.

**Cambio di versione** (quando cambia l'interfaccia): `ABOUT_VERSION` in `server.js`, `VERSION` in `public/sw.js`, versione in `public/index.html`,
intestazione e §12 del README; `GUIDA_VER` solo se si aggiungono passi alla guida.

**Token riservati**: `DIAG_TOKEN` (diagnosi e misure) e `ADMIN_TOKEN` stanno solo su Render; mai nel codice, mai negli indirizzi.

## 7. Trappole già incontrate (non ripetere)

- **Ordine di inizializzazione nei moduli del telefono**: `notify.js` leggeva la memoria prima di definire le funzioni che usa (avvisi persi
  alla riapertura dalla v24 alla v30). Prova: `tests/memoria-telefono.test.js`.
- **Avvisi di servizio**: date, linee e fermate si ricavano solo dalla frase che descrive la modifica, mai da frasi di alternativa o di
  promemoria; le risposte dell'AI passano sempre da `avvisi-ai.js: validate`. Ogni regola nuova va provata sui casi reali dell'archivio.
- **Safari/iOS**: ogni push deve mostrare una notifica (dopo 3 silenziose l'iscrizione viene revocata); permessi e aperture di file solo dentro
  il tocco; le notifiche esistono solo con l'app installata.
- **Render**: SIGTERM 60 s dopo l'avvio della nuova istanza; lo spegnimento ha 25 s per passare gli avvisi.
- **CSS**: `#info #info-body a` ha specificità alta e schiaccia i pulsanti nuovi nelle Informazioni.
- **Prove d'interfaccia**: a certe ore un pontile può non avere partenze; `run.py` ripiega su «tutti i pontili».
- **PowerShell**: nomi di funzione corti coincidono con alias di sistema (`H` = cronologia); usare nomi lunghi con verbo.
- **Tasto «indietro»**: Chromium ignora le voci di cronologia aggiunte senza un gesto dell'utente; la protezione si aggiunge solo dopo un tocco.

## 8. Questioni aperte (decide l'utente)

1. **Banda di Render**: secondo l'analisi del 16/11/2026 il piano gratuito include 5 GB al mese; il flusso SSE pesa circa 139 KB ogni 120 s con
   tutti i servizi e l'app circa 176 KB compressi alla prima apertura; stima del tetto: 500–800 aperture al giorno. Proposta non implementata:
   **inviare il tempo reale solo per la zona visibile**. Alternativa esclusa dalle regole: carta di credito su Render.
2. **Sonno di Render** (spegnimento dopo 15 min senza visite; risveglio in circa 40 s): il keep-alive di GitHub ritarda; un pinger esterno
   gratuito sarebbe un servizio in più, da decidere.
3. **Misure per giorno**: si perdono a ogni riavvio; lo storico dipende dallo script lanciato dall'utente (anche con l'Utilità di pianificazione).
4. **Regione di Render** (Virginia → Francoforte): richiede un servizio nuovo e cambierebbe l'indirizzo. Non deciso.
5. **Regole degli avvisi**: rilettura periodica dei casi nuovi nell'archivio.
6. **Proseguire sullo stesso mezzo al capolinea** (richiesto il 19/11/2026, rinviato): nei GTFS ACTV `block_id` è vuoto e il tempo reale non dice
   la corsa successiva del mezzo. Si riprende se ACTV pubblica i turni.
7. **Push per una coincidenza persa**: il server avvisa di soppressioni, fermate saltate e ritardi della singola corsa; un avviso «il cambio salta»
   calcolato sul server richiederebbe di confrontare due corse dello stesso viaggio (non fatto). Con l'app aperta lo dice già.
8. **`sistema.py` dopo le 22:30**: la prova del pannello di una corsa dipende dall'ora; si può renderla indipendente.
9. **Sciopero**: fasce garantite dal comunicato (di solito autobus e tram); la locandina dei servizi minimi della navigazione non si legge (link).
   `tests/memoria-giorni.test.js` dipende da una versione dei GTFS scaduta il 20/11/2026: da aggiornare.
10. **Parcheggi pieni** («Park … al completo») tolti dagli avvisi dal 19/11: se servono, si possono rimettere in una sezione a parte.
11. Pulizia consigliata e non confermata: variabili `ACTV_CENTRALE*` su Render, ramo `dependabot/...adm-zip`, impostazioni di GitHub (README §7.4).

## 9. Per iniziare una nuova conversazione

Messaggio da incollare:

> Progetto «Venezia TPL live», repository GitHub `nickg1093/TPL-Venezia` (ramo `main`). Leggi prima `STATO.md`, poi `CRITERI.md`; del
> `README.md` leggi solo le sezioni che servono alla richiesta. Rispetta le regole di lavoro di `STATO.md` §2. Richiesta: …

Per risparmiare token: non rileggere tutto il codice; partire dalla tabella dei file (§4) e dalla sezione del README indicata; fare una sola
richiesta per volta; a fine lavoro aggiornare `STATO.md`.
Per gli avvisi: provare le regole sull'archivio vero (server avviato senza `AVVISI_ARCHIVIO=0`, poi `/api/avvisi-eventi` con il token) e
aggiungere i casi in `tests/avvisi-casi-reali.json` / `tests/avvisi.test.js`. Per il pianificatore: provare su orari reali tra gruppi di fermate.
Per «I miei viaggi» e i link: la riapertura è in `public/js/percorso.js` (`show` con `want`, `findWanted`) e la firma in `public/js/viaggio.js`
(`wantOf`, `linkParams`, `parseWant`, `reopenMode`); provare sempre un link valido e uno scaduto (`tests/ui/viaggio.py`).
Per lo sciopero: metadati in `avvisi.js` (`fasceOf`, `addStrikeInfo`, `strikeMeta`), scheda e pulsante in `public/js/app.js` (`strikeUpdate`,
`strikeLayout`) e testi in `public/js/avvisi.js` (`strikeCardHtml`, `strikeNoteHtml`); le prove d'interfaccia fingono lo sciopero intercettando `/api/avvisi`.
