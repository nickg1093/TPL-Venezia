# Venezia TPL live

Mappa in tempo reale di autobus, tram e battelli ACTV (GTFS statico + GTFS-Realtime), con marea, installabile come app (PWA).
Server Node.js senza database; pensato per il piano gratuito di Render.

---

## 1. Operazioni da fare (in ordine)

### 1.1 Prima installazione o dopo aver sostituito i file
1. Copia tutti i file di questo progetto nel repository (la cartella `data/` esistente **resta com'è**: contiene i GTFS già scaricati).
2. `npm install` — **obbligatorio**: Leaflet ora è una dipendenza npm (serve in locale da `/vendor/leaflet`, non più da unpkg) e `package-lock.json` va rigenerato. Fai commit anche di `package-lock.json`.
3. `npm test` — deve passare tutto (47 test).
4. `npm start`, apri `http://localhost:3000`.

### 1.2 Variabili d'ambiente su Render (Dashboard → Environment)
| Variabile | Valore | Perché |
|---|---|---|
| `ADMIN_TOKEN` | stringa casuale ≥ 16 caratteri (es. `openssl rand -hex 24`) | abilita `POST /api/reload-gtfs`. Se manca, l'endpoint è **disattivato** |
| `DIAG_TOKEN` | altra stringa casuale ≥ 16 caratteri | abilita `/api/audit`, `/api/gtfs`, `/api/tide?debug=1` (diagnostica). Se manca, sono **disattivati** |
| `TRUST_PROXY` | `1` (Render lo imposta da solo se c'è `RENDER`) | numero di proxy fidati davanti al server: serve a leggere l'IP vero del visitatore per i limiti di frequenza. Se il server fosse esposto senza proxy: `0` |
| `FORCE_HTTPS` | `1` (consigliato in produzione) | reindirizza HTTP→HTTPS e attiva HSTS |
| `KEEPALIVE_URL` | `https://<tuo-servizio>.onrender.com/healthz` (opzionale) | il server si "autopinga"; di solito `RENDER_EXTERNAL_URL` basta |
| `RT_POLL_MS` | opzionale, default 3000 | intervallo di lettura dei feed realtime |
| `PORT` | gestita da Render | |

Usa i token così (mai nell'URL, mai nel browser): `curl -H "Authorization: Bearer $DIAG_TOKEN" https://…/api/gtfs`.

### 1.3 GitHub
- **Actions → «Aggiorna GTFS ACTV»**: ora *aggiunge* le versioni nuove in `data/gtfs/<nav|aut>/` e non sovrascrive nulla. Per il primo giro lancialo a mano (Run workflow). I permessi `contents: write` sono già nel file.
- **Actions → «Keep-alive Render»**: controlla che l'URL dentro il file sia il tuo. GitHub può ritardare i cron di molti minuti: aggiungi anche un pinger esterno (UptimeRobot, intervallo 5 min, URL `/healthz`).
- Dopo il commit Render ridistribuisce da solo.

### 1.4 Dopo ogni modifica ai file dell'interfaccia
Se cambi icone, manifest o l'elenco `SHELL` di `public/sw.js`, incrementa `VERSION` in `public/sw.js` (ora `v3`). I file `/js` e `/css` si aggiornano da soli (rete prima).

### 1.5 Dove salvare simboli e immagini
- **Simboli dell'interfaccia** (battello, bus, tram, lente, ecc.): *tutti* in `public/icons/sprite.svg`, un `<symbol id="i-nome">` ciascuno (24×24, tratto 1.75, `currentColor`). Nel codice si usano con `icon('nome')` (in `public/js/util.js`); in `index.html` con `<svg class="ic"><use href="/icons/sprite.svg#i-nome"/></svg>`. **Non usare emoji**: cambiano da sistema a sistema.
- **Icone dell'app** (PWA/schermata Home): file PNG in `public/icons/` (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `favicon-48.png`, `icon.svg`), già collegati in `manifest.webmanifest` e `index.html`.
- **Mezzo che cambia icona** (es. nuovo tipo di mezzo): funzione `vehIconName` in `util.js`.

---

## 2. GTFS statici: perché non si sovrascrivono più

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

## 3. Eccezioni e contromisure del codice (elenco dettagliato)

### 3.1 Distanze dalle fermate (`tracker.js`, `geo.js`)
Distanze in metri con approssimazione piana (111 000 m/° lat, 78 000 m/° lon a 45° N): precisa a ~0,3 % su scala urbana.
- **Zona di fermata**: da 40 m prima a 55 m dopo il palo (`ARR_BACK_M`, `PASS_M`). Oltre → "transitato".
- **Capolinea di partenza**: il mezzo sosta fino a 300 m prima / 250 m dopo il pallino (`TERM_BACK_M`, `TERM_M`).
- **Sosta lunga** (pensilina, fila): chi ha già sostato in fermata resta "in fermata" fino a **140 m** dopo il palo (`DWELL_FWD_M`) finché non c'è una prova di partenza.
- **Fuori tracciato**: oltre 120 m dalla linea (`OFFROUTE_M`) la proiezione sul percorso si ignora (deviazione).
- **Posizione lungo il tracciato**, non in linea d'aria: due fermate vicine in linea d'aria ma lontane sul percorso (calli, canali) non si confondono. Aggancio del GPS al tracciato entro 45 m (`SNAP_MAX_M`).
- **Fermi/in marcia**: sotto 1,2 m/s = fermo, sopra 2,5 m/s = in marcia; al capolinea la marcia deve durare 6 s per contare come partenza (manovre escluse).
- **Fermate equivalenti** (`stopgroups.js`): pali a ≤ 2 m con nomi compatibili sono la stessa fermata (stesse fermate duplicate nel GTFS). Griglia spaziale, niente confronto a coppie.
- **Zone** (`public/js/zones.js`): pali con lo stesso nome entro 300 m formano una zona con lettere (A, B…; "pontili" per i battelli).

### 3.2 Gestione del feed realtime (`live.js`)
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

### 3.3 Etichette «in arrivo / in partenza / in fermata / tra N min» (`tracker.js`, `util.js: etaText`)
Macchina a stati monotona (la fermata corrente non torna mai indietro, salvo reset dopo 15 min di silenzio):
- `scheduled` lontano → `enroute` → **`approaching` "In arrivo"** (entro 150 m, oppure entro 350 m e < 75 s) → **`at` "In fermata"** (fermo nella zona) → **`departing` "In partenza"** (in marcia, o negli ultimi 30 s prima della partenza prevista) → **`departed` "Partito"**.
- Altrimenti "tra N min" (si aggiorna ogni secondo nel browser; sotto 45 s diventa "In arrivo").
- **Etichetta sempre neutra**: nel pannello fermata il testo sotto l'orario non prende più il colore di ritardo/anticipo (come nel pannello del mezzo). Il colore resta solo sull'orario.

### 3.4 Mezzo ancora fermo in fermata (richiesta k)
Il feed toglie la fermata appena il mezzo arriva e indicherebbe già la successiva; il mezzo, però, è ancora lì.
- **Fermata trattenuta**: se il mezzo è stato visto fermo in una fermata, né il feed né l'orologio possono farla "avanzare" finché non c'è una prova di partenza (GPS oltre la zona, marcia sostenuta).
- **Senza GPS** la fermata si considera lasciata solo 20 s dopo la partenza prevista (orario + ritardo del feed, `HOLD_S`).
- Risultato: la fermata resta "In fermata" nel suo pannello, e la successiva non è segnata come "in arrivo" finché il mezzo non è davvero partito.

### 3.5 Partenze appena avvenute (richiesta l)
- Nel pannello di una fermata restano per **2 minuti** (`DONE_MS`) le corse appena partite, con l'**orario reale di partenza** (rilevato da GPS/feed e registrato dal tracker), stessa formattazione delle altre ma **tutta in grigio**, etichetta "Partito", orario programmato barrato se c'è scostamento.
- Si registrano solo partenze di corse **seguite dall'inizio** (flag `known`): una corsa vista per la prima volta a metà percorso non genera false righe "partito".
- Le righe grigie si possono aprire come le altre.

### 3.6 Orari e calendario (`schedule.js`, `calendar.js`)
- Data/ora **di Venezia** (Europe/Rome) per ogni confronto, indipendente dal fuso del server.
- Corse oltre la mezzanotte (orari 24:xx del giorno di servizio precedente) gestite per entrambi i giorni.
- Data fuori dal periodo coperto dai calendari: si usa solo il giorno della settimana e il pannello lo segnala ("approssimato").
- Ritardo mostrato in **minuti interi** e orario previsto ricavato da quello: sempre coerenti fra loro.

---

## 4. Sicurezza (`security.js`, `server.js`)
- **Intestazioni**: Content-Security-Policy rigida (`script-src 'self'`: **nessuno script in linea**; stili in linea ammessi solo per gli attributi generati dalla mappa), HSTS (con HTTPS), `nosniff`, `X-Frame-Options: DENY` + `frame-ancestors 'none'`, Referrer-Policy, Permissions-Policy (solo geolocalizzazione), COOP/CORP `same-origin`.
- **HTTPS** forzato con `FORCE_HTTPS=1`; **TRUST_PROXY** per l'IP reale (l'intestazione `X-Forwarded-For` è ignorata se non c'è proxy fidato, altrimenti chiunque potrebbe falsificarla).
- **Limiti di frequenza** per IP e classe: API 1200/min, pesanti 300/min, statici 900/min, amministrazione 6/min (risposta 429 con `Retry-After`). Tabella con tetto di memoria.
- **SSE** (`/api/stream`): max 10 connessioni per IP e 400 totali.
- **Endpoint sensibili** con token `Bearer` (≥ 16 caratteri, confronto a tempo costante): `/api/audit`, `/api/gtfs`, debug marea (`DIAG_TOKEN`); ricarica GTFS solo `POST` con `ADMIN_TOKEN`. Senza token impostato: disattivati.
- **Validazione dei parametri** (id, orari, date, liste) con regole rigide; routing con `hasOwn` (nessun accesso a proprietà ereditate); errori interni mascherati ("errore interno"), dettagli solo nei log.
- **Risposta pubblica dei mezzi** limitata a campi in whitelist.
- **Timeout** anti-slowloris, chiusura ordinata (SIGTERM), file statici in memoria con ETag, niente elenco di cartelle, niente file fuori da `public/`.
- **Interfaccia**: tutto il testo che arriva da fuori passa da `esc()` prima di `innerHTML`; colori delle linee accettati solo come `#RRGGBB`; link esterni con `rel="noopener noreferrer"`; Leaflet servito dal proprio server (nessuna dipendenza da CDN esterne, quindi niente rischio di script compromessi); service worker che non intercetta mai `/api`.
- **Accessibilità**: bersagli di tocco ≥ 44 px, contrasti WCAG AA, tastiera (Invio/Spazio sulle righe, Esc chiude), movimento ridotto rispettato, nessuna informazione solo a colori.

---

## 5. Interfaccia: comportamento

- **Pannelli** (fermata, zona, corsa): cliccando una riga si passa all'altro pannello (fermata → corsa, corsa → fermata) e in alto compare il **link blu «indietro»** con il nome del pannello precedente (fino a 20 livelli). Aprire un pannello dalla mappa riparte da zero.
- **X**: chiude il pannello, deseleziona il mezzo e **toglie la shape del percorso** (due livelli separati: percorsi della ricerca e percorso della corsa).
- **Segui** (pulsante accanto alla X, solo nel pannello della corsa, stesso stile degli altri pulsanti, `aria-pressed`): il mezzo viene tenuto al centro della **zona libera della mappa**, cioè il rettangolo non coperto da pannello, colonna controlli, scheda marea e ricerca, ricalcolato dalle misure reali (vale per ogni schermo e orientamento). Scorrimento morbido; trascinare la mappa a mano ferma l'inseguimento; passando a un altro pannello si spegne.
- **Pianificato e GTFS per data**: il selettore di data ammette solo i giorni coperti dai GTFS in archivio (`/api/dates`: dal primo all'ultimo giorno dei calendari in `data/gtfs/aut|nav`). Per ogni data il server sceglie la versione con servizi in quel giorno (la più recente tra le valide). Quella in uso oggi è sempre in memoria; se la data richiede un'altra versione, questa si carica a richiesta (una sola alternativa per servizio, per la memoria di Render) e l'interfaccia mostra «Carico gli orari della data scelta…» riprovando da sola. Senza una versione che copra la data, la barra di stato lo dice. L'archivio si compatta da solo (`prune`): restano le versioni valide oggi, quelle future, la più recente scaduta e quelle scadute da meno di 60 giorni (massimo 6).
- **Pianificato**: barra compatta (selettore + data/velocità, una riga con play · ora · cursore · ORA), contenuto largo al massimo 760 px e centrato, uguale su schermi grandi.
- **Controlli a destra**, in tre blocchi: servizi · cerca, posizione, tema scuro · avvisi, marea (e «Installa» quando disponibile).
- **Ricerca**: scrivendo un numero le linee passano prima delle fermate, divise in «Automobilistico e tram» (mattonelle) e «Navigazione» (cerchi). Scegliendo una linea la mappa mostra solo i suoi mezzi e il suo percorso (pillola «solo linea X» in alto a sinistra per tornare a tutto).
- **Posizione (GPS)** (`public/js/locate.js`): parte solo da un tocco, chiede il permesso al sistema e ne rispetta il rifiuto (messaggio con cosa fare); tre stati del pulsante: spento → acceso (punto sulla mappa, una sola centratura) → segue → spento. Trascinare la mappa, aprire una fermata o seguire un mezzo termina «segue»: niente più rimbalzo tra la tua posizione e il mezzo. Sospesa a pagina nascosta.
- **Attesa visibile**: ogni richiesta lenta (`api()` in `util.js`) accende una barra in alto (`#busybar`); gli avvisi brevi usano `#toast`.
- **Fermate doppie**: la stessa fermata presente due volte (entro ~25 m, stesso nome) è unificata in ricerca e mappa; il pannello mostra le partenze di entrambi i codici (`mergeDuplicates` in `zones.js`). Corsie fisse in `FIXED` (Piazzale Roma A1…C da linee GTFS, PM a parte; Tronchetto Mercato A = 5075, B = 5210): dipendono dagli id del GTFS in uso.
- **Acqua alta**: oltre 85 cm (attuale o prevista) la scheda marea mostra il link ai servizi di navigazione previsti. Gli avvisi che citano acqua alta con un livello (`+110 cm`) ricevono il piano ACTV per quel livello (linee e pontili, tabella `AA_RULES` in `avvisi.js`, trascritta dalla pagina ACTV: da verificare se la pagina cambia).
- **Avviso acqua alta automatico**: se ACTV/Telegram non pubblicano nulla, con marea misurata o prevista (prossime 12 h) oltre 85 cm compare un avviso «Calcolato dal livello di marea» con il piano ACTV per quel livello (stessa tabella `AA_RULES`). Se esiste già un avviso ufficiale con piano acqua alta, l'automatico non compare e quello ufficiale mostra il livello misurato come conferma.
- **Prestazioni**: la lettura dei GTFS cede il passo ogni ~8 ms; `/api/stop` e `/api/zone` identiche entro 1,5 s condividono un solo calcolo.
- **Fermate vicine**: con la posizione attiva, in alto a sinistra compare una pillola con la fermata più vicina entro 250 m e la distanza (con «+N» se sono di più; al tocco si apre la fermata o l'elenco). Se non ce ne sono, la pillola dice quanto dista la più vicina; se la posizione non arriva, mostra il motivo (permesso negato, segnale assente: secondo tentativo con precisione ridotta).
- **Marea**: livello, tendenza, prossime alte/basse con pallino di colore (stesse soglie del dato corrente) e grafico da 6 ore prima a 18 ore dopo, con promemoria breve ai servizi di navigazione previsti quando la marea supera 85 cm con cursore (osservato / previsto). La parte futura è ricavata dagli estremi pubblicati da CPSM (interpolazione), quella passata dalla storia che il server accumula dal suo avvio.
- **Avvisi di servizio** (`avvisi.js`, `public/js/avvisi.js`): raccolta automatica dalle notizie del sito ACTV (RSS + pagina) e dal canale Telegram pubblico, ogni 5-10 minuti. Per ogni avviso si ricavano validità (date in italiano), linee e fermate con regole generali: la linea deve seguire «linea/linee/navetta» ed esistere nel GTFS; numeri presenti in entrambi i servizi si risolvono dalle fermate citate e da ciò che le linee servono davvero (altrimenti si scartano); le fermate valgono solo se servite da quelle linee; nomi di una sola parola e strade («via Torino») non bastano da soli; scioperi e avvisi generali sugli orari non segnano fermate. Le fermate con avviso in corso hanno il simbolo (!) in mappa e nel pannello, con riga che apre l'avviso.
- **Altezza all'avvio** (`theme-init.js`): l'altezza dell'app è la misura reale della finestra, riletta alcune volte nei primi secondi, così su Android i tasti di sistema non coprono la barra in basso.
- Installazione (PWA), tema chiaro/scuro (segue il sistema finché non scegli).

---

## 6. Struttura dei file
```
server.js        HTTP, API, SSE, statici          security.js   intestazioni, limiti, token, validatori
live.js          lettura feed RT, difese, stato    tracker.js    macchina a stati della corsa
schedule.js      orari, posizioni teoriche, passaggi   motion.js     velocità dai GPS
gtfs.js          lettura di un GTFS                 gtfsstore.js  archivio e scelta delle versioni
calendar.js      servizi attivi, data di Venezia    ids.js        collegamento universale degli ID
stopgroups.js    fermate equivalenti                geo.js, csv.js  utilità
tide.js, avvisi.js, feedaudit.js  marea / avvisi di servizio / verifica del feed
scripts/update-gtfs.js   aggiornamento archivio (usato dal workflow)
public/index.html (solo struttura) · css/app.css · js/{app,util,zones,tide,avvisi,pwa,theme-init}.js · icons/ · sw.js · manifest.webmanifest
public/js/locate.js  GPS e stati del pulsante
tests/           test unitari (node --test) e prove dell'interfaccia (tests/ui)
```

## 7. Test
- `npm test` — 47 test (tracker, orari, archivio GTFS, sicurezza, marea, avvisi).
- Simulazione completa: `node -r ./tests/fakefeed.js server.js` (feed finto costruito dalle corse in servizio adesso, con fantasmi e rilevamenti vecchi).
- Interfaccia: con quel server avviato (`TRUST_PROXY=1`), `python3 tests/ui/run.py http://localhost:3000 <cartella>` (Playwright; usa un Leaflet finto in `tests/ui/leaflet-stub.js`): 6 formati di schermo, X, indietro, segui, dock, nessuno script in linea.

## 8. Limiti noti
- Le soglie (distanze, secondi) sono stime ragionate, non tarate sui dati reali ACTV: osserva i primi giorni e correggi `C` in `tracker.js` se serve.
- Le prove dell'interfaccia usano un Leaflet finto: la mappa vera (tessere, gesti) va verificata a mano una volta.
- Il formato della marea (`tide.js`) e le pagine reali di ACTV/Telegram (`avvisi.js`) non sono stati verificati con le fonti vere in questo ambiente: dopo il deploy controlla `/api/tide` e `/api/avvisi`. Lo storico della marea riparte da zero a ogni riavvio del server.
- Su Render gratuito il server si addormenta senza traffico: serve il pinger esterno; dopo il risveglio i primi secondi non hanno dati.

Dati: © OpenStreetMap contributors · ACTV (GTFS/GTFS-RT) · CPSM Venezia.
