# STATO DEL PROGETTO — da leggere per primo in ogni nuova conversazione

Aggiornato il **24/11/2026** (v34 su `main` e sul ramo `audit-v34`, pubblicata su GitHub il 24/11 alle 23:14: audit funzionale, avvisi chiari su fermate sospese e corse incerte, controlli sul campo con la posizione, correzione di `dati.yml`; deploy su Render fatto dall'utente; vedi PASSAGGIO_CONSEGNE.md §9 quater e `tests/collaudo/RAPPORTO.md`). Questo file dice dove siamo, come si lavora e dove guardare.
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
| Versione | **v34** su `main` (e ramo `audit-v34`) / online: la v34 dopo il deploy manuale dell'utente, prima v33.10 (`ABOUT_VERSION` in `server.js`, `VERSION` in `public/sw.js` e `public/js/sistema.js`; `GUIDA_VER` in `public/js/guida.js` è `v33.12`) |
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
| Skill Alexa (voce) | `alexa/` (`skill.js`, moduli, `lambda/`, `skill-package/`), ingressi `/api/alexa` in `server.js`; prove `tests/alexa-*.test.js` |
| Avvisi di servizio | `avvisi.js` (regole, 1082 righe), `avvisi-archivio.js`, `avvisi-ai.js` (validazione delle risposte AI) |
| Avvisi di arrivo e viaggio guidato | `watch.js`, `push.js` (Web Push VAPID) |
| Marea, MOSE | `tide.js`, `marea-archivio.js`, `mose.js` (il calendario `ics.js` è stato tolto nella v33.2) |
| Acqua alta (dati) | `scripts/genera-acqua.js`, `scripts/acqua-core.js`, `data/acqua/` → `public/acqua/` |
| Dati fissi per i telefoni | `fissi.js`, `scripts/genera-dati.js` |
| Memoria e misure | `memoria.js`, `metriche.js` |

**Interfaccia (`public/js/`)**
| Argomento | File |
|---|---|
| Mappa, pannelli, navigazione | `app.js` (1460 righe), `nav.js` (tasto «indietro»), `zones.js`, `locate.js`, `util.js` |
| Pianificatore e viaggio guidato | `percorso.js`, `viaggio.js`, `pedoni.js`, `camminata.js`, `scegli.js` |
| Filtri e acqua alta sulla mappa | `livelli.js` (menu Mezzi e Livelli, disegno), `acqua.js` (regole pure) |
| Notifiche | `notify.js`, `../sw.js` |
| Preferiti | `fav.js`, `favs.js` |
| Finestre | `avvisi.js`, `tide.js`, `info.js`, `guida.js` |
| Sistema | `sistema.js` (barra dei messaggi, errori, aggiornamento), `scorri.js` (testi che scorrono), `theme-init.js` (tema, dimensione del testo), `pwa.js`, `fissi.js` |
| Stile e icone | `../css/app.css`, `../icons/sprite.svg`, `../index.html` |

## 5. Stato attuale

- **Skill Alexa, revisione 2 (25/11/2026, ramo `feature/alexa-voce`, NON pubblicata)**: prima/ultima corsa sull'intero GTFS, direzione verificata, dialogo e voce rivisti (vedi `alexa/STATO.md`); corretto `route_type` in `gtfs.js`.
- **Skill Alexa (25/11/2026, pubblicata su `main` dall'utente)**: cartella `alexa/` (guida `alexa/README.md`, stato `alexa/STATO.md`). Ponte Alexa-hosted gratuito → `POST /api/alexa` → logica in processo che riusa le API della PWA; spenta senza `ALEXA_TOKEN`. Prove verdi; da fare dall'utente: account Amazon, creazione skill, import del modello, token, prove su Echo. Non toccati: Web Push, PWA, versione (resta v34).
- **v34 (24/11/2026, audit funzionale)**: fermate sospese e avvisi generali (nebbia, acqua/bassa marea) detti
  chiaramente nel pianificatore, nel viaggio e nella fermata («il mezzo potrebbe non fermarsi»); viaggio guidato con controlli sul campo
  (mezzo perso, discesa mancata) e «Ricalcola da qui» dalla posizione; marea vecchia dichiarata; ripristino dei preferiti tutto-o-niente;
  `dati.yml` robusto ai 404 di Geofabrik. Rapporto: `tests/collaudo/RAPPORTO.md`; prove: `tests/ui/tutte.sh`/`tutte.ps1`.
- **v33.13 (22/11/2026)**: simulazione a +110 cm: le passerelle non comparivano dove il terreno sotto era asciutto (Zattere, Giudecca,
  Tolentini); ora compaiono; tracciati legati alle calli OSM (89/102 parti). Prova `tests/ui/passerelle.py` con una copia del ramo `dati`.
- **v33.12 (22/11/2026, verifica e correzioni finali)**: passerelle confrontate con tavole e OpenStreetMap (6 capi corretti, Zattere
  verificate), passerelle come archi del grafo pedonale e costo dell'acqua anche ai capi dei percorsi a piedi, avviso oltre +120 cm,
  orari programmati di oggi senza rete (`public/js/orarioggi.js`), fermate e linee salvate usate all'apertura senza rete, «Posizione
  aggiornata N secondi/minuti fa», schede agganciate ai pulsanti ricalcolate a ogni cambio. Dettagli in README §12 e CHANGELOG.md.
  Prove: vedi PASSAGGIO_CONSEGNE.md §9.
- **v33.11 (21/11/2026, audit finale)**: correzioni di sicurezza e privacy, «Novità delle versioni» nelle Informazioni, fonte dell'Atlante
  passerelle; dettagli in README §12 e CHANGELOG.md. **v33.10 pubblicata il 21/11/2026**: acqua alta, passerelle, rilievo RAMSES, uso senza rete.
- **v33.8 (21/11/2026)**: v33.7 con il rilievo in tessere caricate a richiesta (`public/acqua/rilievo/`, pubblicabili
  con «Fonte informativa: Insula spa») e i file `acqua/*.json` della sola stima; attribuzione Insula; analisi dei diritti in README appendice D.
- **v33.7 (20/11/2026, solo locale per la licenza)**: v33.6 + quote misurate dell'acqua alta dal rilievo RAMSES
  (Comune di Venezia – Insula) nella città storica e alla Giudecca, stima altrove; mappa continua/tratteggiata; dati dell'acqua anche senza rete.
  Il rilievo (`dati-ramses/curve-livello-shp.zip`) sta solo sul PC. README §12 e appendice D.
- **v33.6 (20/11/2026)**: v33.5 + Informazioni (Instagram @olocin_g, testi allineati). Online: **v32.6**.
- **v33.5 (20/11/2026)**: v33.4 + schermo intero a scelta (Fullscreen API, non su iPhone), ora dell'ultimo
  rilevamento del mezzo nel pannello della corsa (solo tempo reale, solo se il mezzo la trasmette), modifica dei percorsi recenti e salvati
  nel pianificatore (README §12). Portata sull'online nella v32.6.
- **v33.4 (20/11/2026)**: v33.3 + sciopero sempre visibile nel giorno stesso (gli aggiornamenti Telegram restano
  dentro l'avviso, che si toglie solo per revoca o differimento), link al comunicato ACTV sempre presente, icone di nuovo visibili (README §12).
  Per l'online: **v32.5**.
- **v33.3 (20/11/2026)**: v33.2 + sciopero ad alta visibilità (README §3.7): scheda all'accesso, pulsante «Sciopero»,
  avvertenze in pannelli e pianificatore, finestra da 8 ore prima alle 05:00 del giorno dopo, fasce garantite e link ufficiali. Per l'online: **v32.4**.
- **v33.2 (19/11/2026)**: v33.1 + proposta esatta in «I miei viaggi» e nei link (riapertura nel dettaglio, oppure
  messaggio e alternative), testo condiviso nuovo, calendario tolto, posizione a fasi e spiegazioni nel viaggio guidato, riquadro «alternativa più
  veloce», «Arrivo entro» con più soluzioni e margine («al limite»). File: `public/js/viaggio.js`, `public/js/percorso.js`, `public/js/app.js`,
  `public/css/app.css`, `percorso.js`, `server.js`, `metriche.js`, versione in `public/sw.js` e `public/js/sistema.js`; tolti `ics.js` e
  `tests/ics.test.js`; prove in `tests/viaggio.test.js`, `tests/percorso.test.js`, `tests/ui/viaggio.py`. Per l'online: **v32.3** (senza acqua alta).
- **v33.1 (19/11/2026)**: v33 + avvisi (settore nav/aut, fermate toccate, date, fusioni, propagazione per fermata) e
  pianificatore (camminate lunghe, consigliata stabile, soppressioni e fermate saltate, coincidenze irrealistiche, «arrivo entro»). File:
  `avvisi.js`, `avvisi-ai.js`, `percorso.js`, `public/js/avvisi.js`, versione in `server.js`, `public/sw.js`, `public/js/sistema.js`; prove in
  `tests/avvisi.test.js` (+ `tests/avvisi-casi-reali.json`), `tests/avvisi-1911.test.js`, `tests/percorso.test.js`, `tests/percorso-v28.test.js`,
  `tests/percorso-v331.test.js`. La stessa parte (senza acqua alta) è pronta per l'online come **v32.2**.
- **Online**: v32.1 (grafico della marea, deploy confermato dall'utente il 19/11/2026); misure per giorno (verificato il 16/11/2026 alle 21:25: `/api/metriche/giorni` risponde con il token dell'utente).
- **Prove (21/11/2026, v33.10)**: `npm test` 308/308 (con il GTFS del 02/11 ripristinato); 7 prove dell'interfaccia (con la nuova `offline.py`)
  passate anche con `TESTO=1.3` (14/14). 32 tracciati dell'Atlante georeferenziati e controllati (criteri e risultati in `PASSAGGIO_CONSEGNE.md`).
- **Prove (21/11/2026, v33.9)**: `npm test` 306/306 (con il GTFS del 02/11 ripristinato); le 6 prove dell'interfaccia passate anche con
  `TESTO=1.3`. Passerelle confrontate con `tot_pass.pdf` (Comune, 08/11/2019, 38.298 byte): 74 righe, nel progetto 72 = tutte tranne le due di
  lunghezza 0 (T1.1 E, T1.7 D, escluse apposta); codici, metri e quote identici; descrizioni uguali (nel PDF due sono tagliate). I tracciati
  sulla mappa non sono nel PDF (solo nelle tavole per sestiere): restano da controllare a vista.
- **Prove (21/11/2026, v33.8)**: `npm test` 306/306 (con il GTFS del 02/11 ripristinato); tutte le 6 prove dell'interfaccia passate, anche con
  `TESTO=1.3`; `acqua.py` anche senza `public/acqua/rilievo/` (versione pubblicabile). Con Leaflet vero: a San Marco 2 tessere scaricate,
  crediti Insula visibili. Non provato su un telefono vero.
- **Prove (20/11/2026, v33.7)**: `npm test` → 306 passate su 306 (con `data/gtfs/nav/20261102_189116ae.zip` ripristinato; senza, falliscono
  solo le 2 prove note che lo usano); `run.py`, `viaggio.py`, `sistema.py`, `modifica.py`, `acqua.py`, `marea.py` passate, anche con
  `TESTO=1.3` (`viaggio.py` con `TESTO=1.3`: nota della marea al secondo tentativo, come sempre). Controllo a occhio con Leaflet vero e la rete
  pedonale: linee continue e tratteggiate corrette. Non provato su un telefono vero.
- **Prove (20/11/2026, v33.5)**: `npm test` → 301 passate, 0 fallite; `modifica.py` (nuova), `run.py`, `sistema.py` passate anche con
  `TESTO=1.3`; `viaggio.py` (con `TESTO=1.3` la nota della marea al secondo tentativo), `acqua.py`, `marea.py` passate. `sistema.py`: la prova
  dello sciopero usa ora un IP suo (con un file in più dell'app, le prove precedenti dallo stesso IP arrivavano al limite di 900 file al minuto).
- **Prove (20/11/2026, v33.4)**: `npm test` → 300 passate, 0 fallite; `run.py` (con il controllo delle icone) e `sistema.py` passate anche con
  `TESTO=1.3`; `viaggio.py` passata (con `TESTO=1.3` la nota della marea è passata al secondo tentativo: dipende dall'ora); `acqua.py`, `marea.py`
  passate. **(Prima, v33.3)**: `npm test` → 294 passate, 0 fallite; `run.py` (con le 6 prove dello sciopero), `viaggio.py`, `sistema.py`
  passate anche con `TESTO=1.3`; `acqua.py`, `marea.py` passate. Attenzione: il server, dopo la mezzanotte del 20/11, toglie da `data/gtfs/nav` la
  versione scaduta `20261102_189116ae.zip` che `tests/memoria-giorni.test.js` usa: va ripristinata (`git checkout -- data/gtfs`) o la prova va
  aggiornata a una versione presente (fatto il 21/11/2026: la prova usa la versione datata più recente in archivio; `npm test` 308 su 308). **(Prima, v33.2)**: `npm test` → 291 passate, 0 fallite. `run.py` e `viaggio.py` passate anche con `TESTO=1.3`; `acqua.py`,
  `marea.py` e `sistema.py` con `TESTO=1.3` passate. `sistema.py` a testo normale si ferma alla prova del pannello di una corsa dopo le 22:30 (la corsa
  simulata ha meno di 3 fermate): succede uguale sulla v32.2 non modificata; da ripetere di giorno. Prove d'interfaccia (`run.py`, `viaggio.py`, `sistema.py`, `acqua.py`, `marea.py`) passate sulla v33, anche con `TESTO=1.3`.
- **Da confermare da parte dell'utente**:
  - `metriche.bat` scelta 2 dopo la correzione del commit `0842dd0` (lo script PowerShell non è eseguibile nell'ambiente dell'IA: non è stato provato);
  - viaggio guidato e riattivazione delle notifiche su un iPhone vero.

### Ultime versioni (dettagli in README §12)
- **Meteo (25/11/2026, non pubblicato)**: `meteo.js`/`meteo-parse.js` portati da Intranet-BIS; cicli indipendenti per feed, ultima misura per sensore in RAM, API `/api/meteo*`, skill Alexa (intenti `Meteo*`). Nessuna modifica alla PWA. vePORTO solo con `VEPORTO_ENABLED=true`.
- **v33.10 (pubblicazione online preparata il 21/11/2026: acqua alta, passerelle e rilievo RAMSES vanno online insieme al resto della v33)**: tavole dell'Atlante georeferenziate (32 tracciati), San Marco 2023, crediti 5 s, marea e avvisi salvati per l'uso senza rete. Vedi `PASSAGGIO_CONSEGNE.md`.
- **v33.9**: donazioni tolte; Instagram (profilo dello sviluppatore) in alto nelle Informazioni, segnalazioni solo via email; crediti della mappa sempre visibili.
- **v33.8**: tessere del rilievo a richiesta, pubblicabili con la fonte Insula; archivio originale fuori da GitHub.
- **v33.7**: quote misurate RAMSES per l'acqua alta, distinte dalle stime; livelli dell'acqua anche senza rete.
- **v33.5**: schermo intero, ultimo rilevamento del mezzo, modifica dei percorsi recenti e salvati.
- **v33.4**: sciopero visibile tutto il giorno con gli aggiornamenti Telegram, link ACTV sempre presente, icone corrette.
- **v33.3**: sciopero ad alta visibilità (scheda, pulsante, avvertenze, finestra, fasce, link).
- **v33.2**: proposta esatta salvata e condivisa, condivisione nuova, calendario tolto, GPS a fasi, alternativa più veloce, «Arrivo entro» con margine.
- **v33.1**: avvisi e pianificatore rivisti sui casi reali (README §12 e §3.4, «Scelta delle soluzioni»).
- **Correzioni del 19/11 (server)**, dal confronto tra l'archivio degli avvisi e il sito pubblicato:
  - avvisi: «giovedì 19 e venerdì 20, dalle 8 alle 17» = due giorni separati (non un periodo continuo); sciopero con il giorno nel titolo = quel
    giorno (le date accessorie della pagina lo allungavano dal 19 al 21); messaggi Telegram uniti alla notizia ACTV anche con «per aggiornamenti 👉»,
    con lo stesso sciopero (anche senza data leggibile) e quando lo stesso messaggio viene ripubblicato; «sino a fine servizi di lunedì 23» letto
    come fine; ora di fine scritta rispettata anche con «comunque fino al termine dei lavori»; «rimarrà chiuso» = sospeso; effetto calcolato senza i
    promemoria («Si ricorda che…»); esclusi i messaggi di soli hashtag, i parcheggi pieni e le notizie di cronaca; titoli lunghi con la frase intera
    nel testo; «?» delle emoji perse tolti. Sull'archivio del 19/11: da 12 a 8 avvisi, senza doppioni.
  - pianificatore: oltre 10 minuti a piedi in tutto ogni minuto pesa un minuto in più (`C.WALK_OK_S`, `C.WALK_EXTRA`); a costi equivalenti
    (meno di 1 minuto, `C.TIE_S`) si consiglia chi ha meno cambi, poi meno strada a piedi, e il diretto non viene scartato; in tempo reale la
    «Consigliata» resta la stessa famiglia agli aggiornamenti se costa al massimo 3 minuti più della migliore (`C.STICKY_S`; memoria del server:
    massimo 500 tragitti per 10 minuti, nessun dato personale).
- **v33**: menu «Mezzi sulla mappa» e «Livelli della mappa»; allagamento stimato e passerelle dell'Atlante del Comune, automatici
  da +80 cm e con il MOSE; percorsi a piedi che evitano l'acqua e usano le passerelle; segno «ponte» nelle mattonelle della rete pedonale.
  Correzioni del 17/11: allagamento disegnato solo su calli e campi (niente acqua su case e canali; mappa lontana: nessun disegno); le schede
  del pianificatore dicono asciutto / passerella / acqua e le fermate raggiungibili solo con l'acqua pesano di più; 72 passerelle su 72 tracciate.
- **v32.1 (online e locale)**: grafico della marea senza scritte sovrapposte (massimi/minimi, «MOSE 110», orario di sollevamento).
- **Dopo la v32, senza cambio di versione** (solo server e script): misure per giorno. `metriche.js` stima le persone diverse con un'impronta
  dell'IP a sale giornaliero mai salvato e conta le operazioni riuscite; `/api/metriche/giorni` (DIAG_TOKEN) dà oggi e gli ultimi 60 giorni;
  `/healthz` è escluso. Per lo storico sul PC: `metriche.bat` (menu: CSV, vista nel browser senza salvare, cambio token) con
  `scripts/metriche.ps1`, oppure `node scripts/metriche-giorno.js`. Token cifrato in `%LOCALAPPDATA%\TPL-Venezia`; CSV e token esclusi da `.gitignore`.
- **v32**: donazione volontaria PayPal discreta (tolta nella v33.9) (cuore accanto alla «i» dal 3° giorno d'uso); regole nuove degli avvisi ricavate dall'archivio
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

**Cambio di versione** (quando cambia l'interfaccia): `ABOUT_VERSION` in `server.js`, `VERSION` in `public/sw.js`, `VERSION` in `public/js/sistema.js`,
intestazione e §12 del README, CHANGELOG.md; `GUIDA_VER` solo se si aggiungono passi alla guida.

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

0. **Skill Alexa**: unire `feature/alexa` a `main` e fare il deploy (decide l'utente), poi seguire `alexa/README.md` §3; pubblicazione nello store e Flash Briefing solo se li vuole.
1. **Banda di Render**: secondo l'analisi del 16/11/2026 il piano gratuito include 5 GB al mese; il flusso SSE pesa circa 139 KB ogni 120 s con
   tutti i servizi e l'app circa 176 KB compressi alla prima apertura; stima del tetto: 500–800 aperture al giorno. Proposta non implementata:
   **inviare il tempo reale solo per la zona visibile**. Alternativa esclusa dalle regole: carta di credito su Render.
2. **Sonno di Render** (spegnimento dopo 15 min senza visite; risveglio in circa 40 s): il keep-alive di GitHub ritarda; un pinger esterno
   gratuito sarebbe un servizio in più, da decidere.
3. **Misure per giorno**: si perdono a ogni riavvio; lo storico dipende dallo script lanciato dall'utente (anche con l'Utilità di pianificazione).
4. **Regione di Render** (Virginia → Francoforte): richiede un servizio nuovo e cambierebbe l'indirizzo. Non deciso.
5. **Regole degli avvisi**: rilettura periodica dei casi nuovi nell'archivio.
6. **Acqua alta (pubblicata con la v33.10; restano solo i punti d ed e)**: (a) provare in locale; (b) aggiungere `genera-acqua.js` a `dati.yml` e pubblicare i file sul ramo `dati`
   (CDN) invece che da `public/acqua`; (c) **rilievo RAMSES** (v33.7–v33.9 in locale): le condizioni d'uso del sito di Insula consentono uso, riproduzione ed elaborazione,
   anche parziale, con «Fonte informativa: Insula spa»; le tessere `public/acqua/rilievo/` sono pubblicabili insieme all'acqua alta (quando l'utente lo dice);
   l'archivio originale `dati-ramses/` resta fuori da GitHub; (d) i capi delle passerelle sono rivisti a mano (`data/acqua/passerelle-atlante.json`; il 22/11/2026 tutti i
   ricalcolati confrontati con tavole e OSM, 6 corretti; restano da guardare sul posto T3.2A e T9.2B, vedi PASSAGGIO_CONSEGNE.md §10); (e) i cambi a piedi tra fermate calcolati dal server non considerano ancora l'acqua.
7. **Proseguire sullo stesso mezzo al capolinea** (richiesto il 19/11/2026, rinviato): nei GTFS ACTV `block_id` è vuoto in tutte le corse e il
   tempo reale non dice quale corsa farà dopo lo stesso mezzo. Si riprende se ACTV pubblica i turni.
8. **Push per una coincidenza persa**: oggi il server avvisa di soppressioni, fermate saltate e ritardi della singola corsa; un avviso «il cambio
   salta» calcolato sul server richiederebbe di confrontare due corse dello stesso viaggio (proposta non fatta). Con l'app aperta lo dice già.
9. **`sistema.py` dopo le 22:30**: la prova del pannello di una corsa dipende dall'ora (corse simulate a fine servizio); si può renderla indipendente.
10. **Sciopero**: un aggiornamento Telegram che non è una risposta e non contiene «sciopero» (né nel giorno dello sciopero, né parole simili al
    comunicato) resta un avviso a sé; la revoca si riconosce solo dalle parole (revoca, annullamento, differimento, rinvio, precettazione). Le fasce garantite sono quelle scritte nel comunicato (di solito autobus e tram); per la navigazione ACTV pubblica una
    locandina dei servizi minimi che l'app non legge (si rimanda al link).
11. **Parcheggi pieni** («Park … al completo») tolti dagli avvisi dal 19/11: se servono, si possono rimettere in una sezione a parte.
13. **Zoom con due dita** (v34, audit): oggi bloccato (`user-scalable=no` + `touch-action`) e sostituito da «Dimensione del testo» fino al
    130%; WCAG 1.4.4 chiede il testo usabile al 200%. Opzioni: (a) lasciare così; (b) portare «Dimensione del testo» fino al 200% (va
    provata tutta l'interfaccia); (c) riattivare lo zoom della pagina (la mappa ha già i suoi gesti, ma i pannelli si ingrandirebbero con lo
    zoom del browser). Non deciso.
14. **Deploy della v34**: codice su `main` dal 24/11; il deploy su Render lo fa l'utente a mano (README §11).
12. Pulizia consigliata e non confermata: variabili `ACTV_CENTRALE*` su Render, ramo `dependabot/...adm-zip`, impostazioni di GitHub (README §7.4).

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
Schermo intero: `public/js/schermo.js` (scelta in Informazioni). Ultimo rilevamento del mezzo: `live.js` (`noTs`), `public/js/app.js`
(`vehUpdHtml`) e `public/js/util.js` (`etaPosizione`, testo «N secondi/minuti fa»). Modifica dei percorsi: `public/js/percorso.js` (`lstRow`, `draftHtml`, `saveDraft`, `updateRecent`) e `public/js/fav.js`
(`updateRoute`, `addRoute`); prova d'interfaccia `tests/ui/modifica.py`.
Aggiornamenti dello sciopero: `thread` in `avvisi.js` (ramo «SCIOPERO», `STRIKE_STOP_RE`, `strikeUpdText`). Icone: ogni simbolo va DENTRO `<svg>`
in `public/icons/sprite.svg` (`tests/icone.test.js`); un file non valido rende vuote tutte le icone.
