# Venezia TPL live

Mappa in tempo reale di autobus, tram e vaporetti ACTV di Venezia, con pannelli delle fermate e delle corse, pianificatore di percorso,
avvisi di servizio, avvisi di arrivo (notifiche), marea e preferiti. È una **PWA** (si installa come app) servita da un **server Node.js
senza database**, che gira gratis su Render oppure su un computer di casa.

Indirizzo pubblico: <https://veneziatpl.onrender.com> · Repository: <https://github.com/nickg1093/TPL-Venezia> · Versione: **v27** · Criteri permanenti per ogni aggiornamento: [CRITERI.md](CRITERI.md)

---

## Indice

1. [Come funziona, in breve](#1-come-funziona-in-breve)
2. [Struttura del progetto: ogni file, cosa fa, come modificarlo](#2-struttura-del-progetto)
3. [Le funzioni dell'app, una per una](#3-le-funzioni-dellapp)
4. [Cosa resta salvato e dove (persistenza)](#4-cosa-resta-salvato-e-dove)
5. [API del server](#5-api-del-server)
6. [Configurazione: variabili d'ambiente](#6-configurazione)
7. [GitHub: workflow, rami, segreti, impostazioni](#7-github)
8. [Render: impostazioni del servizio](#8-render)
9. [Prove e test: comandi da digitare](#9-prove-e-test)
10. [Modifiche frequenti: ricette](#10-modifiche-frequenti)
11. [Pubblicare una nuova versione e tornare indietro](#11-pubblicare-e-tornare-indietro)
12. [Novità della v27](#12-novità-della-v27) · [v26](#novità-della-v26) · [v25](#novità-della-v25) · [v24](#novità-della-v24)
- Appendici tecniche: [A. GTFS statici](#a-gtfs-statici-perché-non-si-sovrascrivono-più) · [B. Regole del motore tempo reale](#b-eccezioni-e-contromisure-del-codice-elenco-dettagliato) · [C. Sicurezza](#c-sicurezza-securityjs-serverjs) · [D. Dati sul telefono e CDN](#d-dati-sul-telefono-e-cdn-ramo-dati)

---

## 1. Come funziona, in breve

```
 FONTI ESTERNE                         SERVER (Node.js, server.js)                        TELEFONO / BROWSER (public/)
 ───────────────                       ─────────────────────────────                     ──────────────────────────────
 GTFS statici ACTV (zip) ──► data/gtfs ─► gtfsstore.js sceglie la versione ─► gtfs.js ─┐
 GTFS-Realtime ACTV (ogni 5 s) ─────────► live.js + tracker.js + turni.js + assign.js ──┼─► /api/* e flusso SSE ─► app.js (mappa,
 RSS ACTV + Telegram ───────────────────► avvisi.js (+ archivio GitHub, + AI facoltativa)│                          pannelli, pianificatore,
 Marea CPSM (dati.venezia.it) ──────────► tide.js                                       │                          preferiti, notifiche)
 Rete pedonale OSM (pedonale-*.txt) ────► percorso.js (RAPTOR) ─────────────────────────┘                          service worker sw.js
 Servizi Web Push (Google, Apple…) ◄──── watch.js + push.js (avvisi di arrivo)

 GitHub Actions «dati» ─► ramo «dati» (fermate, linee, tracciati, rete pedonale OSM in mattonelle) ─► CDN jsDelivr ─► telefono
                          (il server pubblica solo le impronte in /api/fissi: il telefono usa un file solo se coincide)   (salvati sul dispositivo;
                                                                                                                             percorsi a piedi calcolati lì)
```

- **Il server** legge i dati ACTV, li collega tra loro e risponde alle richieste. Non salva nulla su disco durante il funzionamento
  (su Render il disco è temporaneo): tutto ciò che deve durare sta in **GitHub** (GTFS e archivio avvisi) o **sul telefono** (preferiti,
  impostazioni, avvisi di arrivo attivi).
- **La pagina** (`public/`) è un'app a pagina singola: niente framework, moduli JavaScript nativi, Leaflet per la mappa, nessuno script
  di terze parti, CSP rigida.
- **GitHub Actions** scarica le nuove versioni dei GTFS (ogni 6 ore), archivia gli avvisi (ogni 20 minuti), prepara i dati fissi e la rete
  pedonale per i telefoni (ramo `dati`) e tiene sveglio il server.
- **Il telefono** tiene salvati fermate, linee, tracciati e la rete pedonale e li riscarica solo quando cambiano, dal **CDN** e non dal server
  (appendice [D](#d-dati-sul-telefono-e-cdn-ramo-dati)); i percorsi a piedi li calcola lui.

---

## 2. Struttura del progetto

### 2.1 Server (cartella principale)

| File | Cosa fa | Quando lo modifichi |
|---|---|---|
| `server.js` | Server web: instradamento delle richieste, tabella delle API (`API`), file statici in memoria, flusso SSE, avvio dei moduli. | nuova API, nuovo parametro, cambio di comportamento di un endpoint |
| `env.js` | Legge `.env.local` (solo in locale) prima di tutto il resto. | mai, di solito |
| `security.js` | Intestazioni di sicurezza (CSP, HSTS…), limiti di frequenza per IP, controllo dei token, validazione degli identificativi. | cambiare limiti (`LIMITS`) o la CSP |
| `live.js` | **Motore tempo reale**: legge i feed GTFS-RT, collega mezzi e corse, mantiene lo stato di ogni corsa, sceglie i GTFS per data (`dataFor`). | regole dei mezzi, frequenza di lettura |
| `tracker.js` | Stima dove si trova ogni corsa (fermata attuale, fase, arrivi previsti) fondendo GPS, previsioni e orario. | etichette «in arrivo/in fermata», stime |
| `assign.js` | Decide a quale corsa appartiene un mezzo (si segue ACTV, con controlli). | casi di mezzi associati male |
| `turni.js` | Mezzo molto in ritardo che di fatto fa la corsa successiva del suo turno. | regole dei turni |
| `motion.js`, `geo.js` | Velocità dai rilevamenti GPS; distanze e geometria comuni. | raramente |
| `schedule.js`, `calendar.js` | Orari programmati, passaggi alle fermate, calendario dei servizi (date di Venezia). | regole degli orari |
| `gtfs.js`, `gtfsstore.js`, `csv.js`, `zip.js`, `ids.js` | Lettura dei GTFS (zip in memoria), archivio e scelta della versione, collegamento degli identificativi feed ↔ GTFS. | formati nuovi di ACTV |
| `stopgroups.js`, `prossime.js`, `area.js` | Fermate equivalenti (stesso palo), fermate successive mostrate nei pannelli, area servita sulla mappa. | raramente |
| `mose.js` | **Stato del MOSE**: legge la tabella «Bocche di porto · Barriere · Stato» della pagina «Operatività M.O.S.E.» dell'Autorità per la Laguna di Venezia, la traduce in semafori, cache 4-10 min | se la pagina cambia struttura: `parse()` e `tests/mose.test.js` |
| `fissi.js` | **Dati fissi per i telefoni**: file di fermate, linee e tracciati per versione dei GTFS con impronta SHA-256 (`/api/fissi`, `/api/fisso`), lettura dell'indice del ramo `dati`. Usato anche dal workflow, così i byte coincidono. | formato dei file (cambiare anche `FORMATO`) |
| `percorso.js` | **Pianificatore** (algoritmo RAPTOR): soluzioni con cambi e tratti a piedi, preferenze, alternative; usa gli orari della data scelta. | parametri del calcolo (oggetto `C`) |
| `pedonale-laguna.txt`, `pedonale-terraferma.txt` | Distanze a piedi tra fermate sulla rete pedonale di OpenStreetMap (generate da `scripts/pedonale.js`). | dopo grandi cambi di fermate |
| `avvisi.js` | Avvisi di servizio: legge RSS ACTV e Telegram, riconosce linee, fermate, date ed eventi (aggiornamenti, ripristini, annullamenti). | regole di riconoscimento |
| `avvisi-archivio.js` | Legge l'archivio degli avvisi dal ramo `archivio-avvisi` di GitHub (sola lettura) e le interpretazioni AI. | raramente |
| `avvisi-ai.js` | Interpretazione AI facoltativa degli avvisi (Cloudflare Workers AI): prompt, schema, validazione. | prompt o regole di validazione |
| `watch.js`, `push.js` | Avvisi di arrivo: regole dei messaggi, ciclo di controllo, ripristino dopo un riavvio, invio Web Push cifrato (VAPID). | testi delle notifiche, tempi |
| `tide.js` | Marea CPSM: livello, tendenza, estremi, storia. | soglie e testi della marea |
| `flusso.js` | Flusso SSE dei mezzi: elenco completo all'apertura, poi solo le differenze, compresso. | raramente |
| `feedaudit.js` | Diagnosi dei feed GTFS-RT (riservata). | mai |
| `avvia-windows.bat`, `avvia.command`, `avvia.sh` | Avvio con doppio clic in locale (Windows, macOS, Linux). | mai |

### 2.2 Interfaccia (`public/`)

| File | Cosa fa |
|---|---|
| `index.html` | Struttura della pagina: mappa, controlli, schede (marea, avvisi, preferiti, informazioni), pannello con la linguetta dei comandi, barra in basso. Testi legali e privacy. |
| `css/app.css` | Tutto lo stile. In testa le variabili (colori dei due temi, misure); in fondo le sezioni **v24** (scala, linguetta, preferiti, pianificatore) e **v25** (scheda «tutto a piedi»). |
| `js/app.js` | App principale: mappa e mezzi in movimento, ricerca, pannelli fermata/zona/corsa, navigazione tra pannelli e tasto «indietro», mezzi «?», collegamento di tutti i moduli. |
| `js/nav.js` | Tasto e gesto **«indietro»** del sistema: una voce di cronologia per ogni livello aperto. |
| `js/percorso.js` | Pianificatore lato telefono: punti di partenza/arrivo, quando, opzioni, soluzioni, dettaglio, disegno sulla mappa. |
| `js/fissi.js` | **Dati fissi sul telefono**: fermate, linee e tracciati salvati nella cache del sito (`tpl-fissi-1`), scaricati dal CDN con controllo dell'impronta, o dal server. Restituisce gli stessi dati dei vecchi `/api/stops`, `/api/routes`, `/api/shapes`. |
| `js/pedoni.js` | **Percorsi a piedi**: rete pedonale in mattonelle caricate quando servono, aggancio dei punti alla strada, ricerca del percorso (Dijkstra/A*). Puro, senza import (provato anche con `node --test`). |
| `js/camminata.js` | Collega `pedoni.js` al CDN e al pianificatore: distanze verso le fermate vicine e percorsi da disegnare, entro 30 minuti a passo svelto; se la rete non c'è, linea d'aria come prima. |
| `js/fav.js` | Memoria dei preferiti (fermate e percorsi), copia di sicurezza (esporta/importa). |
| `js/favs.js` | Pannello **Preferiti** (stella in basso a destra): schede Fermate/Percorsi, modifica, copia. |
| `js/notify.js` | Avvisi di arrivo sul telefono: permessi, iscrizione push, elenco attivo, ripristino dopo un riavvio del server. |
| `js/avvisi.js`, `js/tide.js`, `js/info.js` | Finestre Avvisi, Marea e Informazioni. |
| `js/zones.js` | Zone di fermate (pali dello stesso luogo, es. Piazzale Roma A, B, C…). |
| `js/locate.js` | Posizione GPS (solo su richiesta, resta sul telefono). |
| `js/guida.js` | Guida interattiva della prima apertura e delle novità (`GUIDA_VER`, campo `since` dei passi). |
| `js/pwa.js`, `sw.js`, `manifest.webmanifest` | Installazione come app, service worker (cache e notifiche), scorciatoie dall'icona. |
| `js/theme-init.js` | Tema chiaro/scuro prima del primo disegno; altezza reale dello schermo e tastiera aperta. |
| `js/util.js` | Funzioni comuni: testo sicuro (`esc`), icone (`icon`), mattonelle delle linee (`badge`), colori, etichette di stato, `api()`. |
| `icons/sprite.svg` | **Tutte** le icone dell'interfaccia (`<symbol id="i-nome">`). Icone dell'app: i PNG nella stessa cartella. |

### 2.3 Altre cartelle

| Cartella | Contenuto |
|---|---|
| `data/gtfs/<nav\|aut>/` | Archivio dei GTFS statici (`<inizio validità>_<hash>.zip`), aggiornato dal workflow. `data/actv_*.zip` sono versioni storiche ancora usate per le date vecchie: **non cancellarle**. |
| `scripts/` | `update-gtfs.js` (scarica i GTFS), `archivia-avvisi.js` e `interpreta-avvisi.js` (workflow degli avvisi), `pedonale.js` (distanze a piedi tra fermate), `genera-dati.js` e `pedoni-core.js` (file del ramo `dati`: dati fissi e rete pedonale in mattonelle), `vapid-keys.js` (chiavi delle notifiche). |
| `tests/` | Prove automatiche (`*.test.js`, `node --test`), feed simulato (`fakefeed.js`), prove dell'interfaccia (`ui/run.py`, Playwright). |
| `.github/workflows/` | `update-gtfs.yml`, `archivio-avvisi.yml`, `dati.yml`, `keepalive.yml` (vedi [7](#7-github)). |

---

## 3. Le funzioni dell'app

### 3.1 Mappa e mezzi
- Simboli: **cerchi** = battelli, **mattonelle** = bus e tram, colori della linea. Bordo tratteggiato = posizione da orario; grigio = mezzo non associato a una corsa.
- Il mezzo si muove lungo il tracciato tra due rilevamenti, senza mai superare l'ultimo punto ricevuto (nessuna posizione inventata).
- **Mezzi senza linea («?»)**: mezzi che il feed ACTV non associa a nessuna linea. Sono **nascosti** di norma; il terzo pulsante del gruppo
  servizi (icona «?») li mostra, **grigi e trasparenti**. La scelta resta sul telefono (`tpl.mezziSenzaLinea`). Codice: `isUnk`, `showUnk` in `app.js`.
- Pulsanti a destra: battelli · bus/tram · mezzi «?» | ricerca · posizione · tema | avvisi · marea · installa. In basso a destra: **preferiti** (stella),
  avvisi di arrivo attivi (campanella, solo se ce ne sono), informazioni («i»).
- Il pulsante **«Percorso»** sta sopra i crediti della mappa all'apertura; quando i crediti si riducono (dopo 5 secondi o alla prima mossa) scende al bordo.

### 3.2 Pannello fermata, zona e corsa
- **Linguetta dei comandi**: preferito, condividi, percorso da qui, avviso di arrivo, segui il mezzo e chiudi stanno in una linguetta **fuori dal
  pannello** (a destra su schermi larghi, sopra il bordo sul telefono). Il **nome** resta su **una riga**: se non entra scorre avanti e indietro.
  La parte di mappa coperta dalla linguetta è esclusa quando l'app centra un mezzo o una fermata (`freeBox` in `app.js`).
- Righe dei passaggi (tre righe): destinazione · **fermate successive** (scorrono di continuo verso sinistra se non entrano, `ticker`) ·
  pontile/corsia, stato e mezzo (**avanti e indietro** se non entra, `marquee`). Con «riduci movimento» del sistema non scorre nulla.
- Viste «Orario» e «Per linea», «Partiti da poco», campanella per l'avviso di arrivo su ogni passaggio, avvisi di servizio in cima.

### 3.3 Navigazione e tasto «indietro»
Ogni livello aperto (pannello, pannello precedente, pagine del pianificatore, avvisi, marea, preferiti, informazioni, ricerca, scelta sulla mappa)
ha una voce nella cronologia del browser (`nav.js`). Il **tasto o gesto «indietro»** del telefono (e il tasto **Esc** sul computer) chiude il livello
più in alto o torna al pannello precedente; con nulla aperto esce dall'app. L'ordine è in `backOne()`, il conteggio dei livelli in `levels()` (`app.js`).

### 3.4 Pianificatore di percorso
- **Quando**: interruttore *Adesso · Partenza · Arrivo*; con un orario scelto compaiono **giorno** e **ora**. Le date ammesse sono quelle coperte
  dai GTFS in archivio (le stesse della modalità *Programmato*, `/api/dates`) e per ogni data si usano **gli orari di quella data**
  (`plannerGtfs` in `server.js` → `live.dataFor`): stesso motore di caricamento della modalità Programmato.
- **Opzioni** (salvate sul telefono): mezzi (battelli · autobus e tram), preferenza (equilibrata, più veloce, meno cambi, meno a piedi), cambi
  (qualsiasi, al massimo 2, al massimo 1, solo diretti), camminata massima per tratto, passo, tempo per i cambi.
- **Sul telefono**, mentre si scelgono partenza, arrivo e opzioni il pianificatore occupa **tutto lo schermo** (la tastiera non copre nulla e la barra in
  basso si toglie); con le soluzioni torna un foglio in basso e la mappa mostra il percorso. «Scegli sulla mappa» lo toglie di mezzo.
- **Mezzi sulla mappa**: con il pianificatore aperto si vedono **solo i mezzi delle corse della soluzione mostrata** (la prima dell'elenco o quella
  aperta); per un orario futuro i mezzi compaiono quando le corse entrano in servizio. Chiudendo il pianificatore tornano tutti.
- **Percorsi preferiti**: stella nella linguetta; nel pannello Preferiti (scheda Percorsi) si possono **rinominare** («Casa → Lavoro»), riordinare ed eliminare.
- Tempo reale per le partenze di adesso, orari programmati per gli altri orari; «a piedi» sulla rete pedonale OSM.
- **A piedi lungo le strade** (v25): dal punto di partenza (posizione o punto sulla mappa) alle fermate vicine e dalle fermate all'arrivo il telefono
  misura la distanza **lungo calli, ponti e marciapiedi** (fino a 30 minuti a passo svelto, circa 3 km) e la manda al server al posto della linea
  d'aria (`~r`); anche «tutto a piedi» (`piedi=…&piedir=1`). I tratti a piedi sulla mappa seguono le strade e nel dettaglio ne compare la lunghezza;
  la scheda «A piedi: circa …» si tocca per vedere il percorso. La posizione non esce dal telefono. Senza rete pedonale (CDN irraggiungibile,
  browser senza HTTPS) tutto funziona come prima, in linea d'aria.

### 3.5 Preferiti
Stella in basso a destra → pannello con schede **Fermate** e **Percorsi**. Un tocco apre; **Modifica** per riordinare, rinominare (percorsi) ed eliminare;
**Salva una copia** scarica un file JSON; **Ripristina** lo rilegge e lo **unisce** a quelli presenti (cambio di telefono o di browser).

### 3.6 Avvisi di arrivo (notifiche)
Campanella su un passaggio o nel pannello della corsa → scelta del preavviso (2, 5, 10, 15 min). Notifica di sistema anche ad app chiusa (Web Push);
dove non c'è Web Push (iPhone senza app installata) l'app aperta mostra i messaggi. Dopo un **riavvio o un aggiornamento del server** il telefono
ripresenta da solo gli avvisi attivi (`/api/watch/restore`), all'apertura dell'app, al ritorno in primo piano e quando il flusso si ricollega.

### 3.7 Avvisi di servizio, marea, modalità Programmato, guida, link
- **Avvisi**: sito ACTV + Telegram, collegati a linee e fermate (bordo rosso sulla mappa, «!» nei pannelli); archivio storico nel ramo `archivio-avvisi`.
- **Marea**: livello CPSM, tendenza, prossimi estremi, grafico con cursore.
- **Programmato** (barra in basso): posizioni e orari di un altro giorno o di un'altra ora, con riproduzione accelerata.
- **Guida**: alla prima apertura e, dopo un aggiornamento, solo le novità (`guida.js`, `GUIDA_VER = 'v25'`).
- **Link condivisibili**: `?fermata=nav:5013`, `?zona=…`, `?corsa=nav:…`, `?da=…&a=…`; scorciatoie `?apri=percorso|vicine|preferiti`.

### 3.8 Scala della grafica
La dimensione di base del testo segue lo schermo: 16 px da circa 720 px di larghezza, in proporzione fino a 14 px sui telefoni stretti e in orizzontale;
tutto ciò che è in `rem` (testi, righe, mattonelle) si adegua insieme, e chi ingrandisce il testo dalle impostazioni del telefono lo trova ingrandito.
I bersagli di tocco restano tra 44 e 48 px. La regola è in testa alla sezione v24 di `app.css` (`html{font-size:clamp(...)}`).

---

## 4. Cosa resta salvato e dove

| Dato | Dove | Dura | Note |
|---|---|---|---|
| Fermate e percorsi preferiti, nomi dei percorsi | telefono (`localStorage`: `tpl.favorites`, `tpl.percorsi`) | finché non si cancellano i dati del sito | `navigator.storage.persist()` chiesto all'avvio; copia di sicurezza dal pannello Preferiti |
| Tema, vista dei passaggi, opzioni del pianificatore, mezzi «?», guida vista | telefono (`localStorage`) | come sopra | sopravvivono agli aggiornamenti dell'app |
| Avvisi di arrivo attivi | telefono (`tpl.watches`) **e** memoria del server | al massimo 3 ore | dopo un riavvio del server il telefono li ripresenta (`watch.restore`) |
| Chiavi delle notifiche (VAPID) | variabili d'ambiente su Render | sempre | senza, le iscrizioni non valgono più dopo un riavvio |
| GTFS statici | repository GitHub (`data/gtfs/`) | sempre | aggiunti dal workflow, mai sovrascritti |
| Archivio avvisi e interpretazioni AI | ramo GitHub `archivio-avvisi` | 6 mesi letti dal server | scritto solo dal workflow |
| Fermate, linee, tracciati, rete pedonale | telefono (cache del sito `tpl-fissi-1`) | finché non cambiano | riscaricati solo con una nuova versione dei GTFS o della rete; le versioni vecchie si cancellano da sole |
| File per i telefoni (dati fissi, mattonelle) | ramo GitHub `dati`, letto dal CDN jsDelivr | sempre | scritto solo dal workflow `dati.yml` |
| Stato tempo reale, cache | memoria del server | fino al riavvio | si ricostruisce in pochi secondi |

**Perché niente database**: il piano gratuito di Render ha disco temporaneo e il Postgres gratuito scade dopo 30 giorni; tutto ciò che è
personale resta sul dispositivo dell'utente (privacy) e ciò che è pubblico sta su GitHub.

---

## 5. API del server

| Endpoint | Metodo | Cosa restituisce |
|---|---|---|
| `/api/vehicles?src=nav,aut` | GET | mezzi in tempo reale (risposta condivisa, ETag) |
| `/api/stream?d=1&src=…` | GET (SSE) | flusso dei mezzi: elenco completo, poi differenze |
| `/api/scheduled?src=…&secs=…&date=AAAAMMGG` | GET | posizioni da orario (modalità Programmato) |
| `/api/metriche` | GET | **riservato (DIAG_TOKEN)**: misure aggregate dall'ultimo avvio (richieste e kB per endpoint, durata media/P95, codici, flusso, CPU, memoria) |
| `/api/mose` | GET | stato delle barriere del MOSE (Autorità per la Laguna di Venezia), con fonte e ora; letto al massimo ogni 4-10 minuti |
| `/api/fissi` | GET | indice dei dati fissi: impronte SHA-256 dei file della versione in uso, indirizzi del CDN, rete pedonale (ETag) |
| `/api/fisso?src=nav&f=stops\|routes\|shapes&h=<impronta>` | GET | un file dei dati fissi (se l'impronta è quella in uso; in cache per sempre) |
| `/api/stops`, `/api/routes`, `/api/shapes?id=…`, `/api/area` | GET | fermate, linee, tracciati, area servita (per le app non aggiornate e come riserva; stops e routes con ETag) |
| `/api/stop?id=nav:5013`, `/api/zone?ids=…` | GET | passaggi di una fermata o di una zona (`&secs=&date=` per Programmato) |
| `/api/trip?id=nav:<corsa>` | GET | dettaglio di una corsa |
| `/api/percorso?da=…&a=…[&secs=&date=&arrivo=1&mezzi=nav,aut&pref=…&cambi=…&piedimax=…&passo=…&margine=…&piedi=…&piedir=1]` | GET | soluzioni del pianificatore. `da`/`a`: `src:id~metri` (linea d'aria) o `src:id~metri~r` (lungo le strade, misurati dal telefono) |
| `/api/percorso-simili?…&fam=…&rotte=…&arr=hh:mm` | GET | alternative di una soluzione |
| `/api/dates` | GET | date coperte dai GTFS in archivio |
| `/api/avvisi`, `/api/tide`, `/api/about`, `/api/push-key` | GET | avvisi, marea, versione e contatto, chiave pubblica VAPID |
| `/api/watch`, `/api/watch/cancel`, `/api/watch/resub`, `/api/watch/restore` | POST | avvisi di arrivo: crea, annulla, nuova iscrizione, ripristino dopo un riavvio |
| `/api/watch/poll?id=&token=` | GET | messaggi per i dispositivi senza Web Push |
| `/api/audit`, `/api/gtfs`, `/api/avvisi-eventi`, `/api/whoami`, `/api/tide?debug=1` | GET, **DIAG_TOKEN** | diagnosi |
| `/api/reload-gtfs` | POST, **ADMIN_TOKEN** | ricontrolla e ricarica i GTFS |
| `/healthz` | GET | `ok` (controllo di salute di Render e keep-alive) |

---

## 6. Configurazione

### 6.1 Variabili d'ambiente (Render → servizio → *Environment*; in locale: file `.env.local`)

| Variabile | Obbligatoria | A cosa serve |
|---|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | **sì** per le notifiche | chiavi delle notifiche; si generano con `node scripts/vapid-keys.js`. Senza, cambiano a ogni riavvio e le iscrizioni si perdono |
| `DIAG_TOKEN` | consigliata | abilita le API di diagnosi (stringa casuale di almeno 16 caratteri) |
| `ADMIN_TOKEN` | consigliata | abilita `POST /api/reload-gtfs` |
| `FORCE_HTTPS` | `1` in produzione | reindirizza a HTTPS e attiva HSTS |
| `TRUST_PROXY` | `1` su Render | numero di proxy fidati: serve a leggere l'IP vero per i limiti di frequenza |
| `APP_CONTACT` | consigliata | contatto mostrato nella pagina Informazioni (privacy e segnalazioni) |
| `PUSH_CONTACT` | facoltativa | `mailto:…` per i servizi di notifica |
| `RT_POLL_MS` | facoltativa | intervallo massimo di lettura dei feed (default 5000, minimo 3000) |
| `AVVISI_ARCHIVIO` | facoltativa | indirizzo della cartella `avvisi` dell'archivio, oppure `0` per non usarlo |
| `DATI_CDN` | facoltativa | `0` = niente CDN: dati fissi solo dal server e niente percorsi a piedi lungo le strade (prove) |
| `DATI_REPO` | facoltativa | repository del ramo `dati` (`utente/nome`); predefinito quello da cui Render prende il codice |
| `MAREA_ARCHIVIO` | facoltativa | `0` = all'avvio non si recupera la storia della marea dal ramo `archivio-marea` (prove) |
| `KEEPALIVE_URL` | facoltativa | su Render basta `RENDER_EXTERNAL_URL`, impostata da Render |
| `PORT`, `HOST`, `TLS_CERT`, `TLS_KEY` | solo in locale | porta, indirizzo di ascolto, HTTPS in rete di casa |

> **Non più usate dalla v24** (si possono cancellare da Render): `ACTV_CENTRALE`, `ACTV_CENTRALE_RPM` — il confronto con la centrale ACTV
> era spento (`ACTV_CENTRALE=0`) ed è stato tolto dal codice.

Come si usano i token (mai nell'indirizzo, mai nel browser), da **PowerShell**:
```powershell
$h = @{ Authorization = "Bearer IL_TUO_DIAG_TOKEN" }
Invoke-RestMethod -Uri https://veneziatpl.onrender.com/api/gtfs -Headers $h | ConvertTo-Json -Depth 6
```

### 6.2 File `.env.local` (solo in locale, mai su GitHub)
Copia `.env.local.esempio` come `.env.local` e togli il `#` davanti alle righe che servono. Lo legge `env.js` all'avvio; le credenziali
Cloudflare servono solo alle prove locali dell'interpretazione AI.

---

## 7. GitHub

### 7.1 Workflow (scheda *Actions*)
| Workflow | Quando | Cosa fa |
|---|---|---|
| **Aggiorna GTFS ACTV** (`update-gtfs.yml`) | ogni 6 ore e a mano | scarica le versioni nuove dei GTFS in `data/gtfs/` senza sovrascrivere; commit su `main` solo se c'è qualcosa di nuovo |
| **Archivio avvisi ACTV** (`archivio-avvisi.yml`) | ogni 20 minuti e a mano | salva RSS e Telegram nel ramo `archivio-avvisi`; se ci sono i segreti Cloudflare, interpreta con l'AI le comunicazioni nuove |
| **Dati per i telefoni (CDN)** (`dati.yml`) | dopo ogni aggiornamento dei GTFS, ogni lunedì (rete pedonale) e a mano | scrive nel ramo `dati` fermate, linee e tracciati di ogni versione dei GTFS e, il lunedì, la rete pedonale da OpenStreetMap (Geofabrik + osmium, 2-3 minuti). A mano: *Run workflow*, con `pedoni = 1` per rifare subito la rete |
| **Archivio marea** (`archivio-marea.yml`) | ogni 15 minuti (3 letture a 5 minuti) | scrive nel ramo `archivio-marea` i livelli di marea (un file al giorno, 30 giorni); il server li rilegge all'avvio |
| **Keep-alive Render** (`keepalive.yml`) | ogni 10 minuti | chiama `/healthz` perché il servizio gratuito non si addormenti (GitHub può ritardare: consigliato anche un pinger esterno, es. UptimeRobot ogni 5 min) |

### 7.2 Rami
- `main`: codice e GTFS. È il ramo che Render pubblica.
- `archivio-avvisi`: solo dati degli avvisi (scritto dal workflow). **Non** unirlo a `main`.
- `archivio-marea`: solo letture della marea (scritto dal workflow `archivio-marea.yml`). **Non** unirlo a `main`.
- `dati`: solo file per i telefoni (scritto dal workflow `dati.yml`, letto dal CDN). **Non** unirlo a `main` e non modificarlo a mano.
- `dependabot/npm_and_yarn/adm-zip-0.6.1`: **obsoleto** (adm-zip non è più una dipendenza dalla sostituzione con `zip.js`): chiudi la richiesta di
  modifica e cancella il ramo (*Pull requests* → la richiesta di Dependabot → *Close*; poi *Delete branch*).

### 7.3 Segreti (Settings → Secrets and variables → Actions)
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (solo per l'interpretazione AI degli avvisi). Facoltativa la variabile `AI_MODELLO`.

### 7.4 Impostazioni consigliate (verificate il 12/11/2026)
| Dove | Ora | Consiglio | Perché |
|---|---|---|---|
| Settings → Actions → General → *Workflow permissions* | Read and write | **Read repository contents** | i workflow che scrivono (`update-gtfs`, `archivio-avvisi`) dichiarano già `contents: write`: tutto il resto resta in sola lettura (minimo privilegio) |
| stessa pagina → *Allow GitHub Actions to create and approve pull requests* | attivo | **disattivato** | nessun workflow ne ha bisogno |
| stessa pagina → *Actions permissions* | tutte le azioni | facoltativo: **solo azioni di GitHub** (`actions/checkout`, `actions/setup-node`) | riduce il rischio di azioni di terzi compromesse |
| Security → *Secret scanning* | disattivato | **attivarlo** (gratis per i repository pubblici) | avvisa se per errore si carica una chiave o un token |
| Security → *Security policy* | assente | aggiunto il file `SECURITY.md` | dice come segnalare una vulnerabilità |
| Rulesets / branch protection su `main` | nessuna | facoltativo: impedire la cancellazione e il push forzato su `main` | protezione da errori; i commit dei workflow continuano a funzionare |
| Visibilità | pubblico | resta pubblico | il server legge l'archivio avvisi da `raw.githubusercontent.com` senza credenziali; nel repository non ci sono segreti |

### 7.5 File che non devono stare nel repository
`.env.local`, `node_modules/`, `certs/`, `tmp/`, file `*.log` (già in `.gitignore`). Nella v24 sono stati tolti `data/alilaguna.zip` (non usato)
e i moduli della centrale ACTV.

---

## 8. Render

Impostazioni del servizio **VeneziaTPL** (verificate il 12/11/2026):

| Impostazione | Valore | Giudizio |
|---|---|---|
| Piano | Free (512 MB di memoria) | ok per il traffico attuale; vedi nota sulla memoria |
| Regione | Virginia (US East) | **consiglio Frankfurt (EU Central)**: utenti in Italia (circa 90-100 ms in meno a ogni richiesta) e dati in Europa. La regione non si cambia: bisogna creare un nuovo servizio (stesse impostazioni e variabili) e poi eliminare il vecchio; l'indirizzo `onrender.com` cambierebbe |
| Branch | `main` | ok |
| Build command | `npm ci` | ok (installa esattamente `package-lock.json`) |
| Start command | `npm start` | ok |
| Health check path | `/healthz` | ok |
| Auto-Deploy | Off (deploy manuale) | ok, voluto: si pubblica quando si decide |
| Variabili | `ADMIN_TOKEN`, `APP_CONTACT`, `DIAG_TOKEN`, `FORCE_HTTPS`, `TRUST_PROXY`, `VAPID_*` | ok; **cancellare** `ACTV_CENTRALE` e `ACTV_CENTRALE_RPM` (non più usate) |

**Memoria**: il 9/11/2026 alle 00:21 Render ha riavviato il servizio per «memoria oltre 512 MB» (scheda *Events*). I picchi arrivano quando si
caricano insieme gli orari in uso e quelli di un'altra data (modalità Programmato o pianificatore). La v24 riduce il consumo togliendo la centrale
ACTV (pagine e indici in memoria) e limita gli indici del pianificatore a due. Se capita ancora: *Events* mostra l'ora; si può valutare un piano
a pagamento con più memoria.

**Manutenzione annunciata da Render**: 18 novembre 2026, 3:00 (ora italiana): possibile breve interruzione.

---

## 9. Prove e test

Tutti i comandi sono per **PowerShell** di Windows, dalla cartella del progetto (es. `cd D:\Downloads\TPL-Venezia`). Serve **Node.js 22**
(`node -v` deve dire `v22.x`).

### 9.1 Installazione e prove automatiche
```powershell
npm ci                                   # installa le librerie esattamente come su Render (la prima volta e dopo un cambio di package-lock.json)
npm test                                 # tutte le prove (atteso: «# fail 0»)
node --test tests/percorso.test.js       # un solo file di prove
node --test --test-name-pattern="v25"    # solo le prove il cui nome contiene «v25»
node --test tests/pedoni.test.js tests/fissi.test.js   # percorsi a piedi e dati fissi
```

Rigenerare in locale i file del ramo `dati` (di solito lo fa il workflow):
```powershell
node scripts/genera-dati.js fissi C:\temp\dati              # fermate, linee e tracciati di ogni GTFS in data/gtfs
# la rete pedonale richiede osmium (https://osmcode.org/osmium-tool/) e l'estratto Geofabrik: vedi i passi in .github/workflows/dati.yml
```

### 9.2 Avviare l'app sul computer
```powershell
npm start                                # poi apri http://localhost:3000
```
Oppure doppio clic su `avvia-windows.bat`. Per cambiare porta: `$env:PORT=3111; npm start`.

### 9.3 App con dati simulati (senza internet per i feed ACTV)
```powershell
$env:PORT=3111; $env:TRUST_PROXY=1; $env:AVVISI_ARCHIVIO=0; $env:DATI_CDN=0
node -r ./tests/fakefeed.js server.js    # mezzi, avvisi e marea simulati: utile per provare l'interfaccia
```
Per richiudere: `Ctrl+C`. Per tornare alle impostazioni normali nella stessa finestra: `Remove-Item Env:PORT, Env:TRUST_PROXY, Env:AVVISI_ARCHIVIO, Env:DATI_CDN`.
Senza `DATI_CDN=0` l'app usa il CDN anche in locale (serve internet): così si provano i percorsi a piedi lungo le strade.

### 9.4 Prove dell'interfaccia (6 dimensioni di schermo, con screenshot)
Una volta sola: `pip install playwright` e `python -m playwright install chromium`. Poi, con l'app simulata avviata (9.3) in un'altra finestra:
```powershell
python tests/ui/run.py http://localhost:3111 C:\temp\ui     # atteso: «FALLITI: 0»; gli screenshot finiscono in C:\temp\ui
```

### 9.5 Provare le API dal computer (PowerShell) o dal browser
```powershell
Invoke-RestMethod https://veneziatpl.onrender.com/api/about
Invoke-RestMethod "https://veneziatpl.onrender.com/api/dates"
(Invoke-RestMethod "https://veneziatpl.onrender.com/api/vehicles?src=nav,aut").vehicles.Count
Invoke-RestMethod "https://veneziatpl.onrender.com/api/stop?id=nav:5013" | Select-Object -ExpandProperty departures | Select-Object -First 5 line, headsign, sched, exp
Invoke-RestMethod "https://veneziatpl.onrender.com/api/percorso?da=nav:5013~0&a=nav:5031~0&secs=36000&date=20261120"
```
Le stesse richieste GET si possono incollare nella barra del browser (es. `https://veneziatpl.onrender.com/api/dates`).

### 9.6 Prove sul telefono
- **Tasto indietro**: apri una fermata, poi una corsa: «indietro» torna alla fermata, di nuovo «indietro» chiude il pannello.
- **Pianificatore**: tocca «Percorso», poi «Dove vuoi andare?»: il pannello occupa tutto lo schermo e la tastiera non copre il campo.
- **Notifiche**: attiva un avviso; dopo un nuovo deploy riapri l'app: la campanella resta accesa e la notifica arriva.
- **Preferiti**: stella in basso a destra → «Salva una copia» scarica il file; «Ripristina» lo rilegge.

### 9.7 Interpretazione AI degli avvisi (facoltativa, in locale)
```powershell
node scripts/interpreta-avvisi.js --casi --senza-ai      # prepara i prompt senza usare la quota
node scripts/interpreta-avvisi.js --casi --confronta     # confronta i due modelli (serve .env.local con le credenziali Cloudflare)
```
Risultati in `tmp\ai-test\`.

---

## 10. Modifiche frequenti

| Voglio… | Dove | Come |
|---|---|---|
| aggiungere un'icona | `public/icons/sprite.svg` | nuovo `<symbol id="i-nome" viewBox="0 0 24 24">` con soli tracciati; nel codice `icon('nome')`; poi aumenta `VERSION` in `public/sw.js` |
| cambiare un colore o una misura | `public/css/app.css` | variabili in testa (`:root` e tema scuro `[data-theme="dark"]`); le coppie testo/sfondo devono restare leggibili (contrasto ≥ 4,5:1) |
| cambiare la dimensione generale dei testi | `app.css`, sezione v24 | regola `html{font-size:clamp(87.5%, …, 100%)}` |
| cambiare un testo dell'interfaccia | `public/index.html` (testi fissi) o il modulo in `public/js/` | cerca il testo con *Cerca nei file* dell'editor |
| aggiungere un passo alla guida | `public/js/guida.js` | aggiungi un oggetto a `GUIDA_MAPPA`/`GUIDA_PANNELLO` (o `NOVITA_EXTRA`) con `since` uguale alla nuova `GUIDA_VER` |
| cambiare i limiti del pianificatore | `percorso.js`, oggetto `C` | es. `HORIZON_S` (ore di ricerca), `TRANSFER_MAX_S` (cambio a piedi), `PREF` (pesi delle preferenze) |
| aggiungere un'opzione del pianificatore | `public/js/percorso.js` (`OPZ0`, `renderOpz`, `opzQs`) e `server.js` (`planParams`) e `percorso.js` (`normPref`) | |
| un nuovo livello che si chiude con «indietro» | `public/js/app.js` | aggiungilo a `levels()` e a `backOne()` |
| una nuova API | `server.js`, tabella `API` | `{ fn: u => … }`; parametri validati con `security.js`; per i POST aggiungi il percorso a `POSTS` |
| una nuova variabile d'ambiente | il modulo che la usa + questo README (6.1) + `.env.local.esempio` | |
| aggiornare la versione mostrata | `server.js` (`ABOUT_VERSION`), `public/sw.js` (`VERSION`), `public/js/guida.js` (`GUIDA_VER`) | |

Dopo ogni modifica: `npm test`; se hai toccato l'interfaccia, anche le prove 9.4.

---

## 11. Pubblicare e tornare indietro

1. Prove in locale: `npm test` (e 9.4 se cambia l'interfaccia).
2. Carica le modifiche su `main` (GitHub Desktop: *Commit to main* → *Push origin*; oppure `git add -A; git commit -m "messaggio"; git push`).
3. Render → servizio → **Manual Deploy → Deploy latest commit**. Dopo 1-2 minuti: *Events* deve dire «Deploy live».
4. Controllo: apri l'app, `https://veneziatpl.onrender.com/api/about` deve mostrare la versione nuova.

**Tornare alla versione precedente**: Render → *Events* → sul deploy precedente **Rollback** (immediato). Per annullare anche su GitHub:
GitHub Desktop → *History* → tasto destro sul commit → *Revert changes in commit*, poi *Push*.

**Aggiornare la copia sul computer** (cartella collegata a GitHub): GitHub Desktop → *Fetch origin* → *Pull origin*, oppure `git pull`.

---

## 12. Novità della v27

- **MOSE nella marea** (`mose.js`, `/api/mose`): un semaforo per barriera (Treporti, San Nicolò, Malamocco, Chioggia): verde in recesso, giallo
  programmato, giallo lampeggiante in movimento, rosso sollevata (senza lampeggio con «riduci movimento»); titolo chiaro quando il MOSE è attivo;
  orario del sollevamento programmato (se pubblicato) e soglia di 110 cm nel grafico; anello colorato sul pulsante della marea. Fonte citata
  con collegamento. La pagina dell'Autorità si legge solo a finestra aperta o con marea prevista oltre 90 cm.
- **Grafico della marea**: niente cursore sotto; si trascina sul grafico (dito o mouse) o si usano le frecce (±5 min), Pagina su/giù (±1 h), Inizio/Fine.
- **Pianificatore**: preferenze come le app di trasporto (Migliore, Meno cambi, Meno a piedi; tolti «Più veloce» e il tetto ai cambi); un cambio
  vale 8 minuti nella Migliore e 20 in Meno cambi; con «Arrivo» niente proposte che arrivano oltre 20 minuti prima (o 15 oltre la più vicina);
  inquadratura nella zona libera anche quando è piccola e di nuovo quando il foglio cambia altezza; × per togliere partenza o arrivo.
- **Interfaccia**: colonna unica dei pulsanti a destra (preferiti e informazioni compresi) che scorre col dito e con la rotella quando lo spazio
  manca (tastiera, Programmato, schermi bassi); niente pulsanti +/− dello zoom; solo la mappa si ingrandisce (pizzico, doppio tocco e Ctrl
  bloccati sul resto; la dimensione del testo del sistema vale ancora); × per cancellare il testo nei campi; tolti «ora / Ns fa» accanto
  all'orologio e l'ora nel titolo del pannello fermata.
- **Temi**: i controlli nativi (calendario, orologio, menu, barre di scorrimento) seguono il tema del sito e non quello del sistema (icone di
  data e ora invisibili in chiaro con il telefono in scuro); «Opzioni» attivo leggibile anche sotto il puntatore; numerini rossi leggibili in scuro;
  etichetta «Ritardi» più scura in chiaro; simboli centrati sulla riga di testo.
- Prove: `tests/mose.test.js`, nuovi casi del pianificatore; in `tests/ui/run.py` colonna che scorre, zoom, × nei campi, MOSE, grafico con la tastiera.

### Novità della v26

Analisi misurata sul servizio pubblicato: il **flusso dei mezzi** è la voce principale di banda (~17 kB/min compressi per app aperta), di cui
un terzo è il tratto di linea dei mezzi (`path`); il **pianificatore** è la voce principale di CPU (~50 ms per calcolo nuovo, molto di più su Render).
- **Flusso**: `path` solo a zoom ≥ 14 e mai con «risparmio dati» (`&p=0`, −34 % di byte); `path` legato al rilevamento GPS, non più tolto e
  rimesso a ogni lettura del feed (un messaggio e un ridisegno in meno a ciclo); riconnessioni con attesa crescente (5 → 60 s).
- **Sicurezza e carico** (`security.js`): classi `plan` (90/min) e `sse` (30 aperture/min); blocco progressivo 1 → 5 → 15 → 60 minuti dopo 3
  sforamenti in 10 minuti o 3 token sbagliati, **solo** sulle richieste costose (avvisi di arrivo, flusso e file dell'app restano sempre serviti);
  massimo 24 richieste contemporanee per IP (avvisi di arrivo esclusi); budget di CPU del pianificatore (503 + Retry-After, l'app riprova da sola).
- **Misure aggregate** (`metriche.js`, `/api/metriche` con DIAG_TOKEN): solo in memoria, azzerate al riavvio.
- **Marea persistente**: workflow `archivio-marea.yml` → ramo `archivio-marea` (`marea/AAAA-MM-GG.jsonl`, 30 giorni, senza doppioni, valori
  mancanti segnati); all'avvio il server recupera le ultime 6 ore (`marea-archivio.js`): grafico e tendenza subito disponibili dopo un deploy.
- **Pagina nascosta**: fermi anche orologio, «tra N min», finestra marea aperta e riproduzione del Programmato; «riduci movimento»: i mezzi
  saltano alla nuova posizione invece di scorrere (meno CPU).
- **Interfaccia**: pannello e linguetta come un pezzo solo (bordo a filo, angolo arrotondato all'esterno, curva concava, ombra solo verso la
  mappa); ricerca vuota senza preferiti; con la tastiera aperta Percorso e crediti non salgono più sopra la tastiera e i risultati scorrono
  nell'area visibile; inquadratura del percorso con tutti i tratti (anche a piedi), che si ricentra solo quando cambi soluzione o punti.
- **Criteri permanenti** per ogni aggiornamento: [CRITERI.md](CRITERI.md).
- Prove: `tests/marea-archivio.test.js`, nuovi casi in `security.test.js` e `flusso.test.js`; in `tests/ui/run.py` linguetta, ricerca, tastiera,
  flusso a zoom basso, pagina nascosta e ripresa.

### Novità della v25

- **Dati fissi sul telefono**: fermate, linee e tracciati non si riscaricano più a ogni apertura (prima ~36 KB ogni volta solo per le fermate):
  restano salvati e si aggiornano solo con una nuova versione dei GTFS, scaricati dal **CDN jsDelivr** (ramo `dati`) invece che dal server.
  Il server pubblica solo le impronte (`/api/fissi`, poche centinaia di byte, di solito «non cambiato»). Riserve: raw.githubusercontent.com,
  poi il server (`/api/fisso`), poi i vecchi indirizzi. `/api/stops` e `/api/routes` ora rispondono «non cambiato» (ETag) a chi li ha già.
- **Percorsi a piedi lungo le strade**, calcolati sul telefono sulla rete pedonale di OpenStreetMap (mattonelle dal CDN, caricate solo dove
  servono): distanze vere verso le fermate vicine e per «tutto a piedi», fino a 30 minuti a passo svelto; tratti a piedi disegnati lungo calli e
  ponti, con la lunghezza, a pallini con un alone (colori diversi per mappa chiara e scura: la mappa disegna su canvas, quindi i colori
  sono in `percorso.js`, `draw()`, e si ridisegna al cambio di tema); scheda «A piedi» da toccare per vederlo sulla mappa. Il server non fa nessun calcolo in più.
- Workflow **`dati.yml`** e ramo **`dati`**; `fissi.js`, `scripts/genera-dati.js`, `scripts/pedoni-core.js`; `public/js/fissi.js`, `pedoni.js`, `camminata.js`.
- Sicurezza: la CSP ammette jsDelivr e raw.githubusercontent.com **solo per scaricare dati** (`connect-src`), mai script; ogni file è controllato
  con l'impronta SHA-256 data dal server prima dell'uso. Informativa privacy aggiornata (jsDelivr e GitHub come fonti dei file).
- Novità nella guida; service worker `v25`.
- **Da fare su Render dopo il deploy**: nulla (nessuna variabile nuova obbligatoria).

### Novità della v24

- **Centrale ACTV tolta** (era spenta con `ACTV_CENTRALE=0`): via `centrale*.js`, `/api/centrale` e le relative prove; il comportamento resta quello
  con la centrale spenta. Meno memoria e meno codice.
- **Tasto/gesto «indietro»** del sistema su tutti i livelli (`nav.js`).
- **Pannello**: comandi nella **linguetta** esterna, nome su una riga con scorrimento; verificati gli scorrimenti delle righe (continuo per le
  fermate successive, avanti e indietro per mezzo e stato).
- **Scala** proporzionata allo schermo (testi da 14 a 16 px di base, misure omogenee).
- **Mezzi «?»** nascosti di norma, pulsante per mostrarli in grigio.
- **Preferiti**: pannello dedicato (stella), percorsi con nome, riordino, copia di sicurezza e ripristino.
- **Persistenza**: gli avvisi di arrivo sopravvivono ai riavvii del server; memoria del browser «persistente».
- **Pianificatore**: «Programmato» al posto di «Pianificato»; date e orari della data scelta con lo stesso motore della modalità Programmato;
  mezzi *battelli / autobus e tram* (via il pulsante tram); cambi «al massimo 2»; controlli compatti; *Adesso · Partenza · Arrivo* con giorno e ora;
  a tutto schermo sul telefono mentre si scrive (tastiera); solo i mezzi del percorso sulla mappa; nuovo tentativo automatico mentre si caricano
  gli orari di un'altra data.
- Pulsante **«Percorso»** che scende quando spariscono i crediti della mappa.
- `SECURITY.md`; tolti `data/alilaguna.zip` e il riferimento ad adm-zip nei crediti.

---

## A. GTFS statici: perché non si sovrascrivono più

Problema risolto: scaricare e sovrascrivere il GTFS può mettere in uso un file **non ancora valido oggi** (o scaduto), e allora corse, fermate e codici non combaciano col feed in tempo reale.

**Archivio**: `data/gtfs/<nav|aut>/<inizio validità>_<hash>.zip`. Ogni versione con contenuto nuovo si *aggiunge*; i file vecchi `data/actv_nav.zip` / `actv_aut.zip` restano leggibili e **non vengono mai cancellati**. Le versioni si riconoscono dal contenuto (hash), quindi lo stesso file scaricato due volte non si duplica.

**Scelta della versione** (`gtfsstore.choose`, funzione pura e testata), per ogni servizio, in quest'ordine:
1. solo versioni che hanno **servizi attivi oggi** (data di Venezia, `calendar.txt` + `calendar_dates.txt` con aggiunte e rimozioni);
2. fra queste, quella che **combacia col feed realtime**: si confrontano i codici di corse/linee di un campione del feed con quelli di ogni versione; sotto il 50 % di corrispondenza la versione passa in coda;
3. a parità, quella con inizio di validità più recente già in vigore, poi la più recente aggiunta;
4. se **nessuna** è valida oggi: si usa la più vicina e il sistema lo segnala (`approx`, visibile in `/api/gtfs` e nei log).
Una versione **futura** resta in archivio e si attiva da sola alla sua data (il server rivaluta ogni 10 minuti, scarica ogni 3 ore).

**Pulizia**: restano le versioni valide, le future e **una** scaduta (la più recente), massimo 5 per servizio.
**Download**: ETag, 3 tentativi, scrittura atomica (file temporaneo + rinomina), controllo che sia davvero un ZIP con i file necessari. Un download fallito non tocca nulla.

---

## B. Eccezioni e contromisure del codice (elenco dettagliato)

### B.1 Distanze dalle fermate (`tracker.js`, `geo.js`)
Distanze in metri con approssimazione piana (111 000 m/° lat, 78 000 m/° lon a 45° N): precisa a ~0,3 % su scala urbana.
- **Zona di fermata**: da 40 m prima a 55 m dopo il palo (`ARR_BACK_M`, `PASS_M`). Oltre → "transitato".
- **Capolinea di partenza**: il mezzo sosta fino a 300 m prima / 250 m dopo il pallino (`TERM_BACK_M`, `TERM_M`).
- **Sosta lunga** (pensilina, fila): chi ha già sostato in fermata resta "in fermata" fino a **140 m** dopo il palo (`DWELL_FWD_M`) finché non c'è una prova di partenza.
- **Fuori tracciato**: oltre 120 m dalla linea (`OFFROUTE_M`) la proiezione sul percorso si ignora (deviazione).
- **Posizione lungo il tracciato**, non in linea d'aria: due fermate vicine in linea d'aria ma lontane sul percorso (calli, canali) non si confondono. Aggancio del GPS al tracciato entro 45 m (`SNAP_MAX_M`).
- **Fermi/in marcia**: sotto 1,2 m/s = fermo, sopra 2,5 m/s = in marcia; al capolinea la marcia deve durare 6 s per contare come partenza (manovre escluse).
- **Fermate equivalenti** (`stopgroups.js`): pali a ≤ 2 m con nomi compatibili sono la stessa fermata (stesse fermate duplicate nel GTFS). Griglia spaziale, niente confronto a coppie.
- **Zone** (`public/js/zones.js`): pali con lo stesso nome entro 300 m formano una zona con lettere (A, B…; "pontili" per i battelli).

### B.2 Gestione del feed realtime (`live.js`)
- **Coordinate fuori area** (fuori da lat 44,6–46,2 / lon 11,3–13,6, o 0,0): mezzo scartato ("fantasma").
- **Rilevamento vecchio**: > 3 min → disegnato ma segnalato "dato non aggiornato" (marker attenuato); > 20 min → non disegnato.
- **Timestamp nel futuro** oltre 1 min: orologio del feed sballato, si usa l'ora di arrivo.
- **Ritardi** oltre 4 ore: dato incoerente, ignorato. **Previsione stantia** (passata da > 4 min senza aggiornarsi): scartata.
- **Duplicati**: un mezzo che compare due volte vale per il rilevamento più recente. Una corsa assegnata a due mezzi diversi: si segue il più coerente col percorso; l'altro è segnalato come "duplicato" e non ruba la corsa.
- **Corsa di un altro giorno**: aggiornamenti con `start_date` diverso da oggi (servizio ancora aperto dopo mezzanotte compreso) sono saltati. Entità `is_deleted` saltate.
- **Collegamento universale degli ID** (`ids.js`): i codici del feed possono avere prefissi diversi dal GTFS (es. `…_792_…` vs `…_793_…`): si cerca per **suffisso unico**. Controllo di **coerenza** (stessa linea e orario di partenza entro 10 minuti, `START_TOL_S`) per non agganciare una corsa sbagliata; una **valvola di sicurezza** disattiva il collegamento per suffisso se troppe corse risultano incoerenti. Anche le fermate del feed si risolvono per suffisso.
- **Dimensione risposta** massima 20 MB; timeout; errori mai propagati al pubblico.
- **Fallback da orario** (`sim`): solo dopo 3 errori consecutivi o 3 minuti senza dati validi; i mezzi sono marcati `sim` e il pannello di stato lo dice ("posizioni da orario"). Appena il feed torna, si passa ai dati veri.
- **Feed fermo** (nessun dato nuovo da minuti): `stale` → avviso nella barra di stato.
- **Corse con più mezzi** (rinforzi in colonna): fino a 3 per corsa (`CO_MAX`), ciascuno col proprio stato e proprio passaggio; la corsa resta in elenco finché non è passato l'ultimo.
- **Nomi dei mezzi** (`util.js: vehName`): autobus `BUS n`, tram `TRAM n`, battelli `M/B` (1–99), `M/S` (100–300), `N/T` (navi traghetto riconosciute dal nome), altrimenti `M/N`.

### B.3 Etichette «in arrivo / in partenza / in fermata / tra N min» (`tracker.js`, `util.js: etaText`)
Macchina a stati monotona (la fermata corrente non torna mai indietro, salvo reset dopo 15 min di silenzio):
- `scheduled` lontano → `enroute` → **`approaching` "In arrivo"** (entro 150 m, oppure entro 350 m e < 75 s) → **`at` "In fermata"** (fermo nella zona) → **`departing` "In partenza"** (in marcia, o negli ultimi 30 s prima della partenza prevista) → **`departed` "Partito"**.
- Altrimenti "tra N min" (si aggiorna ogni secondo nel browser; sotto 45 s diventa "In arrivo").
- **Etichetta sempre neutra**: nel pannello fermata il testo sotto l'orario non prende più il colore di ritardo/anticipo (come nel pannello del mezzo). Il colore resta solo sull'orario.

### B.4 Mezzo ancora fermo in fermata (richiesta k)
Il feed toglie la fermata appena il mezzo arriva e indicherebbe già la successiva; il mezzo, però, è ancora lì.
- **Fermata trattenuta**: se il mezzo è stato visto fermo in una fermata, né il feed né l'orologio possono farla "avanzare" finché non c'è una prova di partenza (GPS oltre la zona, marcia sostenuta).
- **Senza GPS** la fermata si considera lasciata solo 20 s dopo la partenza prevista (orario + ritardo del feed, `HOLD_S`).
- Risultato: la fermata resta "In fermata" nel suo pannello, e la successiva non è segnata come "in arrivo" finché il mezzo non è davvero partito.

### B.5 Partenze appena avvenute (richiesta l)
- Nel pannello di una fermata restano per **2 minuti** (`DONE_MS`) le corse appena partite, con l'**orario reale di partenza** (rilevato da GPS/feed e registrato dal tracker), stessa formattazione delle altre ma **tutta in grigio**, etichetta "Partito", orario programmato barrato se c'è scostamento.
- Si registrano solo partenze di corse **seguite dall'inizio** (flag `known`): una corsa vista per la prima volta a metà percorso non genera false righe "partito".
- Le righe grigie si possono aprire come le altre.

### B.5b Un passaggio, una riga (`live.js: chooseTU, dedupePassages`)
Caso reale (Guglie, 4.1, 3/11): le corse delle 13:49 «in ritardo di 140 min» e delle 14:29 «+101» erano il battello della 16:09 (M/S 225): ACTV pubblica previsioni anche per corse che nessun mezzo fa e vi trascina il ritardo fino al primo mezzo che passa. Contromisure, valide anche per i mezzi senza GPS (non tutte le corse sono tracciate: il confronto è con il passaggio, non con il mezzo):
- la previsione di una corsa che cita un mezzo che il GPS mostra su **un'altra** corsa non vale per questa;
- corsa con la sola previsione del feed (nessun mezzo) e almeno 10 min di ritardo, la cui previsione cade sul passaggio di una corsa successiva della stessa linea con le stesse fermate fino al capolinea (±3 min dal suo tempo se ha dati propri; da 3 min prima a 20 min dopo l'orario se è solo programmata) e il cui ritardo «copre» la distanza tra i due orari: è un doppione, la previsione si scarta. La corsa successiva resta (mezzo o previsione propria); se non ha dati prende quel tempo quando differisce dall'orario di oltre un minuto, altrimenti resta «Da orario». Due mezzi localizzati non si toccano mai;
- oltre 40 min di ritardo senza una corsa su cui cadere: la previsione resta (non c'è una fonte indipendente per smentirla: il confronto con la centrale ACTV è stato tolto nella v24).

### B.6 Orari e calendario (`schedule.js`, `calendar.js`)
- Data/ora **di Venezia** (Europe/Rome) per ogni confronto, indipendente dal fuso del server.
- Corse oltre la mezzanotte (orari 24:xx del giorno di servizio precedente) gestite per entrambi i giorni.
- Data fuori dal periodo coperto dai calendari: si usa solo il giorno della settimana e il pannello lo segnala ("approssimato").
- Ritardo mostrato in **minuti interi** e orario previsto ricavato da quello: sempre coerenti fra loro.

---

## C. Sicurezza (`security.js`, `server.js`)
- **Intestazioni**: Content-Security-Policy rigida (`script-src 'self'`: **nessuno script in linea**; stili in linea ammessi solo per gli attributi generati dalla mappa), HSTS (con HTTPS), `nosniff`, `X-Frame-Options: DENY` + `frame-ancestors 'none'`, Referrer-Policy, Permissions-Policy (solo geolocalizzazione), COOP/CORP `same-origin`.
- **Dipendenze ridotte al minimo** (v22.6): niente più `adm-zip` (8 vulnerabilità segnalate da Dependabot). I GTFS si leggono con `zip.js`, un lettore ZIP interno basato su zlib di Node: solo lettura in memoria (nessuna estrazione su disco), metodi stored/deflate, niente cifratura né ZIP64, tetto per file (256 MB) imposto a zlib senza credere alla dimensione dichiarata («zip bomb»), controllo di dimensione e CRC-32, al massimo 2000 voci; download dei GTFS al massimo 120 MB. Restano solo `leaflet` e `protobufjs`.
- **Dati salvati nel browser** (v22.6): preferiti, percorsi salvati e avvisi di arrivo letti dalla memoria del browser vengono ricostruiti campo per campo (tipi, intervalli e lunghezze) e passano sempre da `esc()` prima di entrare nella pagina: un valore alterato non può diventare HTML.
- **Risposte dati** (`/api`): CSP `default-src 'none'; frame-ancestors 'none'`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, CORP `same-origin` (OWASP REST Security); le pagine tengono la CSP completa.
- **Token**: l'intestazione `Authorization: Bearer …` si legge senza espressioni regolari e con lunghezza limitata (nessun rischio di tempi esplosivi su intestazioni costruite ad arte).
- **HTTPS** forzato con `FORCE_HTTPS=1`; **TRUST_PROXY** per l'IP reale (l'intestazione `X-Forwarded-For` è ignorata se non c'è proxy fidato, altrimenti chiunque potrebbe falsificarla).
- **Limiti di frequenza** per IP e classe: API 1200/min, pesanti 300/min, statici 900/min, amministrazione 6/min (risposta 429 con `Retry-After`). Tabella con tetto di memoria.
- **SSE** (`/api/stream`): max 10 connessioni per IP e 400 totali.
- **Endpoint sensibili** con token `Bearer` (≥ 16 caratteri, confronto a tempo costante): `/api/audit`, `/api/gtfs`, debug marea (`DIAG_TOKEN`); ricarica GTFS solo `POST` con `ADMIN_TOKEN`. Senza token impostato: disattivati.
- **Validazione dei parametri** (id, orari, date, liste) con regole rigide; routing con `hasOwn` (nessun accesso a proprietà ereditate); errori interni mascherati ("errore interno"), dettagli solo nei log.
- **Risposta pubblica dei mezzi** limitata a campi in whitelist.
- **Timeout** anti-slowloris, chiusura ordinata (SIGTERM), file statici in memoria con ETag, niente elenco di cartelle, niente file fuori da `public/`.
- **Interfaccia**: tutto il testo che arriva da fuori passa da `esc()` prima di `innerHTML`; colori delle linee accettati solo come `#RRGGBB`; link esterni con `rel="noopener noreferrer"`; Leaflet servito dal proprio server (nessuno script da CDN esterne, quindi niente rischio di script compromessi); service worker che non intercetta mai `/api`.
- **CDN per i dati (v25)**: `connect-src` ammette `https://cdn.jsdelivr.net` e `https://raw.githubusercontent.com` solo per scaricare JSON
  (fermate, linee, tracciati, rete pedonale). `script-src` resta `'self'`: nessun codice arriva dal CDN. Gli indirizzi usano il numero di commit
  (immutabili) e il telefono controlla l'impronta SHA-256 data dal server prima di usare un file: un file alterato si scarta e si riscarica dal server.
  Le richieste al CDN partono senza cookie né pagina di provenienza (`credentials: 'omit'`, `referrerPolicy: 'no-referrer'`). Il contenuto
  passa comunque da `esc()` prima di entrare nella pagina, come ogni altro dato.
- **Accessibilità**: bersagli di tocco ≥ 44 px, contrasti WCAG AA, tastiera (Invio/Spazio sulle righe, Esc chiude), movimento ridotto rispettato, nessuna informazione solo a colori.

---

---

## D. Dati sul telefono e CDN (ramo `dati`)

**Perché.** Il piano gratuito di Render ha un tetto di banda in uscita. Le parti dei dati che cambiano di rado (fermate, linee, tracciati,
rete pedonale) non devono passare ogni volta dal server: le scarica il telefono **una volta** dal CDN jsDelivr, che le legge dal ramo `dati`
di GitHub, e le tiene salvate.

**Chi produce i file.** Il workflow `dati.yml` con `scripts/genera-dati.js`:
- `fissi/<nav|aut>/<versione>/{stops,routes,shapes}.json` per **ogni** GTFS in archivio (`versione` = prime 12 cifre dell'md5 dello ZIP),
  calcolati con `fissi.js`, lo **stesso** codice del server: i byte coincidono e quindi anche le impronte;
- `pedoni/m/<impronta>.json`: mattonelle di circa 1,1 × 1,1 km della rete pedonale OSM (stesse strade di `pedonale-core.js`; scale × 1,3),
  solo nella zona servita (entro ~3 km da una fermata). Oggi circa 1.600 mattonelle, 8 MB in tutto (3,7 MB compressi); quella più grande in
  centro storico ~90 kB. Il nome è l'impronta: una mattonella che non cambia resta lo stesso file e i telefoni non la riscaricano;
- `pedoni/i/<versione>.json` (indice delle mattonelle) e `pedoni/ultimo.json`;
- `indice.json`, scritto **dopo** il commit dei file, con il suo numero: gli indirizzi del CDN usano quel commit (`…/gh/utente/repo@<commit>/…`),
  quindi sono immutabili e restano in cache per sempre.

**Chi decide cosa è valido.** Il server legge `indice.json` da GitHub ogni 30 minuti e in `/api/fissi` pubblica, per la versione dei GTFS
**che sta usando**, l'impronta SHA-256 di ogni file e se quella versione è già sul CDN. Il telefono (`public/js/fissi.js`):
1. usa il file salvato se l'impronta coincide;
2. altrimenti lo scarica dal CDN (jsDelivr, poi raw.githubusercontent.com) e lo accetta solo se l'impronta coincide;
3. altrimenti dal server (`/api/fisso`), poi i vecchi indirizzi (`/api/stops`…). Il resto dell'app riceve gli stessi dati di prima.

**Allineamento.** Una versione dei GTFS scaricata dal server ma non ancora elaborata dal workflow non è «sul CDN» e si serve dal server finché
il workflow non la pubblica (parte da solo dopo «Aggiorna GTFS ACTV»). Quando cambia la versione in uso, l'app ricarica l'indice e scarica
solo i file nuovi; quelli vecchi si cancellano dal telefono.

**Percorsi a piedi** (`public/js/pedoni.js`, `camminata.js`). Le mattonelle si caricano quando la ricerca ci arriva (di solito 1-6 per un
percorso in centro storico, già salvate dalla seconda volta). Ogni punto si aggancia ai tratti di strada più vicini (entro 200 m; più di uno,
così un parcheggio o la strada del terminal non isolano il punto); poi Dijkstra (verso le fermate vicine, fermandosi alle 14 più vicine) o A*
(tra due punti), fino a 3 km. Se la rete non risponde entro 4 secondi si usa la linea d'aria e la rete servirà la volta dopo.

**Se il CDN non va.** Nulla si rompe: dati fissi dal server, percorsi a piedi in linea d'aria. Per spegnerlo apposta: `DATI_CDN=0`.
**Rifare subito i file**: GitHub → *Actions* → «Dati per i telefoni (CDN)» → *Run workflow* (`pedoni = 1` per la rete pedonale).
Licenze: rete pedonale © OpenStreetMap contributors, ODbL (i file derivati restano ODbL, vedi `LEGGIMI.md` nel ramo `dati`).

