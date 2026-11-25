# Passaggio di consegne — Venezia TPL live v34 (24/11/2026)

Documento autonomo per riprendere il progetto in una nuova conversazione. Dopo questo leggere `STATO.md` (stato e regole), `CRITERI.md`
(regole obbligatorie per ogni modifica) e, quando serve un dettaglio, `README.md` (riferimento completo a sezioni numerate).

## 1. Cos'è
PWA gratuita, personale e indipendente (non ufficiale ACTV) con mappa in tempo reale di autobus, tram e vaporetti di Venezia:
pannelli di fermate e corse, «Programmato» per altri giorni, pianificatore (RAPTOR) con viaggio guidato e percorsi a piedi lungo le strade,
avvisi di arrivo (notifiche push), avvisi di servizio ACTV (RSS e Telegram, scioperi), marea CPSM e MOSE, **acqua alta** (zone
potenzialmente allagabili e passerelle dell'Atlante del Comune), preferiti, percorsi e viaggi salvati, uso senza rete con dati salvati
(dalla v33.12 anche fermate, linee e **orari programmati di oggi** nel pannello della fermata).

## 2. Dove sta

| | |
|---|---|
| Sito | https://veneziatpl.onrender.com — Render gratuito (512 MB, Virginia); `/api/about` mostra versione e contatto |
| Codice | https://github.com/nickg1093/TPL-Venezia (pubblico). Rami: `main` (codice), `dati` (file per i telefoni via CDN jsDelivr), `archivio-avvisi`, `archivio-marea` (archivi dei workflow), `ripristino-v33.10` (punto di ripristino prima dell'audit) |
| PC dell'utente | `D:\Downloads\TPL-Venezia` = clone di GitHub (quello che va online). `D:\Downloads\TPL-Venezia-LOCALE` = copia di lavoro locale (contiene anche i dati solo locali sotto) |
| Solo sul PC, mai su GitHub | `dati-ramses/curve-livello-shp.zip` (rilievo RAMSES di Insula, 333 MB), `dati-passerelle/*.pdf` (Atlante passerelle), `tmp-atlante/` |
| Versione | `ABOUT_VERSION` in `server.js`, `VERSION` in `public/sw.js` e `public/js/sistema.js` (tutte **v34**, su `main` dal 24/11/2026); `GUIDA_VER` in `public/js/guida.js` (`v33.12`) |

## 3. Architettura
- **Server** Node.js 22, nessun framework né database, nessuna scrittura su disco tranne l'archivio GTFS; dipendenze solo `leaflet` e
  `protobufjs` (7.x; la 8 è un salto di versione non provato). `server.js` = instradamento, tabella `API`, file statici in memoria
  (compressi), flusso SSE a differenze `/api/stream`. Moduli principali: `live.js` (tempo reale), `tracker.js`/`assign.js`/`turni.js`,
  `gtfs*.js`, `orari.js`, `percorso.js` (pianificatore), `avvisi*.js`, `watch.js`/`push.js` (notifiche), `tide.js`/`mose.js`,
  `memoria.js` (protezione dei 512 MB), `metriche.js` (misure aggregate in memoria), `security.js` (intestazioni, limiti, token, validazione).
- **Telefono** `public/`: moduli ES senza build; Leaflet servito da `/vendor`; `sw.js` (guscio in cache versionata, `/api/*` e `/acqua/*`
  sempre dalla rete); `js/fissi.js` e `js/pedoni.js` salvano dati fissi e rete pedonale (CDN, impronta SHA-256); `js/orarioggi.js`
  salva gli orari per giorno del CDN (oggi/domani/ieri) e calcola le partenze programmate senza rete; `js/acqua.js` e
  `js/livelli.js` per l'acqua alta (le passerelle posate diventano archi del grafo pedonale in `js/pedoni.js`); `js/guida.js` guida, novità e storico; `js/info.js` pagina Informazioni (testi in `index.html`).
- **Acqua alta**: preparata sul computer con `scripts/genera-acqua.js` (+ `acqua-core.js`, `ramses-core.js`) → `public/acqua/`
  (indice, quote stimate, passerelle, tessere del rilievo). Il server non calcola nulla; il telefono scarica i file solo quando serve.
  Analisi delle tavole dell'Atlante (georeferenziazione, criteri, tabella dei 32 tracciati, comandi Python di `scripts/atlante/`): nel
  `PASSAGGIO_CONSEGNE.md` del ramo `ripristino-v33.10` e in `data/acqua/passerelle-tavole.json → metodo`. Non serve rifarla per lavorare sull'app.
- **Fonti dati**: GTFS e GTFS-RT ACTV; avvisi RSS ACTV e Telegram «AVM/Actv Venezia» (+ interpretazione facoltativa con Cloudflare Workers AI
  solo dentro GitHub Actions, validata da `avvisi-ai.js`); marea CPSM (dati.venezia.it, CC BY); MOSE dal sito del Comune; OpenStreetMap
  (mappa e rete pedonale, ODbL); rilievo RAMSES («Fonte informativa: Insula spa»); Atlante passerelle (Comune di Venezia – Centro Maree, Veritas).

## 4. Automazioni (GitHub Actions)
| Workflow | Quando | Cosa fa |
|---|---|---|
| `update-gtfs.yml` | ogni 6 ore | scarica i GTFS nuovi in `data/gtfs/` su `main` (commit del bot: fare `git pull` prima di lavorare) |
| `dati.yml` | dopo i GTFS, ogni notte, push su file dei dati, a mano | pubblica sul ramo `dati` fermate/linee/tracciati, orari per giorno e (lunedì, a mano con `1`, o con `[pedoni]` nel messaggio del commit) la rete pedonale da Geofabrik |
| `archivio-avvisi.yml` | ogni 20 min | archivia RSS e Telegram nel ramo `archivio-avvisi` (+ AI se ci sono i segreti Cloudflare) |
| `archivio-marea.yml` | ogni 15 min | storia della marea nel ramo `archivio-marea` (30 giorni) |
| `keepalive.yml` | ogni 10 min | sveglia Render (`/healthz`) |
| CodeQL (impostazione predefinita di GitHub) | push e settimanale | analisi del codice; gli avvisi si vedono in Security → Code scanning |

## 5. Configurazione (Render → Environment; in locale `.env.local`, mai su GitHub)
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (notifiche, `node scripts/vapid-keys.js`), `DIAG_TOKEN` e `ADMIN_TOKEN` (≥ 16 caratteri: API
riservate, con `Authorization: Bearer`), `FORCE_HTTPS=1`, `TRUST_PROXY=1`, `APP_CONTACT` (email del titolare mostrata in Informazioni:
necessaria per l'informativa privacy), facoltative `PUSH_CONTACT`, `RT_POLL_MS`, `AVVISI_ARCHIVIO`, `DATI_CDN`, `MEM_ALTO_MB`,
`MEM_CRITICO_MB`, `DATI_REPO`, `MAREA_ARCHIVIO`, `VEPORTO_ENABLED` (`true` = visibilimetri vePORTO), `METEO` (`0` = meteo spento, prove); per la skill Alexa `ALEXA_TOKEN` (≥ 16 caratteri, stesso valore di `alexa/lambda/segreto.js`) e, facoltativa, `ALEXA_SKILL_ID`. Segreti di GitHub: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`. Tabella completa: README §6.

## 6. Comandi
```powershell
# PC dell'utente (Windows, PowerShell)
cd D:\Downloads\TPL-Venezia
git pull origin main
npm ci
npm test                      # atteso: fail 0
.\avvia-windows.bat           # app in locale su http://localhost:3000
# rigenerare i file dell'acqua alta (solo nella cartella con dati-ramses):
node scripts\genera-acqua.js public --ramses dati-ramses\curve-livello-shp.zip
```
```bash
# ambiente dell'IA (Linux): server di prova con feed simulato e prove dell'interfaccia (Playwright + Chrome)
DATI_CDN=0 MAREA_ARCHIVIO=0 AVVISI_ARCHIVIO=0 TRUST_PROXY=1 PORT=3111 node --expose-gc -r ./tests/fakefeed.js server.js
python3 tests/ui/run.py http://localhost:3111 /tmp/ui   # anche sistema, offline, acqua, marea, viaggio, modifica; ripetere con TESTO=1.3
```
**Pubblicazione**: commit e push su `main` → **deploy manuale dell'utente** su Render (Manual Deploy → Deploy latest commit) → controllo di
`/api/about`. Tornare indietro: deploy del commit precedente da Render, oppure il ramo `ripristino-v33.10`.

## 7. Versioni e aggiornamento dell'app
Cambio di versione quando cambia ciò che arriva al telefono: i tre punti del §2. Il service worker riscarica il guscio solo con una
`VERSION` nuova; i dati fissi e dell'acqua cambiano solo se cambia la loro impronta. **Novità per gli utenti**: passi della guida con
`since: 'vNN'` o voci in `NOVITA_EXTRA` (`guida.js`); chi aveva visto una versione precedente le vede **una sola volta** all'apertura, poi
restano nello storico (Informazioni → Novità). Correzioni puramente tecniche: nessuna voce, nessuna schermata. Registro: `CHANGELOG.md`.

## 8. Decisioni importanti (non rimettere in discussione senza l'utente)
Costo 0 € (Render gratuito + GitHub + PWA, niente servizi nuovi); nessun dato personale, cookie, pubblicità o script di terzi; calcoli
pesanti sul telefono o in GitHub Actions, non su Render; dati di terzi solo con attribuzione (archivi originali RAMSES e PDF mai su GitHub);
testi sull'acqua alta sempre «potenzialmente allagabili», mai allagamento certo; app dichiaratamente indipendente e non ufficiale.

## 9. Audit finale del 21/11/2026 (v33.11)
- **Verificato**: nessun segreto nei file e nella storia Git; `npm audit` 0 vulnerabilità; CSP rigida senza script esterni, HSTS, limiti
  per IP, token a tempo costante, errori interni mai al client, notifiche solo verso servizi push noti (niente SSRF), testo esterno sempre
  passato da `esc()` nel telefono.
- **Corretto**: versione nelle segnalazioni di errore; `Origin` non valida → 403; iniezione nei workflow (`dati.yml`); indirizzo Geofabrik;
  tempo massimo `update-gtfs.yml`; prova `memoria-giorni` indipendente dai GTFS; informativa privacy allineata ai conteggi giornalieri;
  fonte dell'Atlante passerelle; storico delle novità; testi della guida.
- **Prove**: `npm test` 308/308; prove dell'interfaccia in Chrome (vista iPhone e desktop) — risultati in `STATO.md` §5 e nel rapporto.

## 9 bis. Verifica e correzioni del 22/11/2026 (v33.12)
- **Passerelle**: i 41 tracciati ricalcolati confrontati con le pagine delle tavole PDF (render a 70–110 dpi, affiancate alla rete OSM) e
  con l'API ufficiale di OpenStreetMap (`api.openstreetmap.org/api/0.6/map`, dal browser: Overpass era saturo). Per ogni tracciato: nomi
  delle vie entro 10 m e pontili entro 45 m dai capi, confrontati con la descrizione ufficiale. **Corretti** (capi da nodi OSM, campo
  `verifica` in `data/acqua/passerelle-atlante.json`): T1.3A (era verso Santa Maria del Giglio, ora Fondamenta Corner Zaguri), T1.4A (era
  ~170 m a sud, ora Ponte e Campo de la Guerra), T2.3A (era su Calle de l'Ospedaleto, ora Barbaria de le Tole verso est), T5.2B e T5.2C
  (Tolentini: la C era ~200 m fuori), T6.1A (allungata sulla Calle del Tragheto). **Zattere** T6.2A/B (dalla tavola 6.2): forma e posizione
  coerenti con tavola e OSM (rio terà, fondamenta, due pontili), nessuna correzione. I 32 tracciati dalle tavole non sono cambiati.
  Rigenerati `public/acqua/{indice,passerelle,quote}.json` con `node scripts/genera-acqua.js public --mattonelle <copia del ramo dati>`
  (rete `b2f1bb3e30622032`; il rilievo `public/acqua/rilievo/` non dipende dalle passerelle e non è cambiato).
- **Perché alcune passerelle erano ignorate dal percorso**: (1) la passerella contava solo se un punto della calle OSM stava entro 9 m dal
  tracciato: dove OSM non ha la calle (attraverso un campo, verso un pontile, es. T1.1E al 26 %, T5.1B al 69 %) non c'era strada da usare;
  (2) i pezzi di tratto ai capi del percorso a piedi erano gratis per il costo dell'acqua: un percorso corto su calli allagate poteva battere
  la passerella. Corretto in `pedoni.js` (passerelle come archi aggiunti, solo se posate; costo proporzionale ai capi, tolto dai metri veri).
- **Acqua alta**: ponti sempre asciutti (segno «ponte» delle mattonelle; 1.918 tratti di ponte nella rete attuale), passerelle mai bagnate,
  oltre +120 cm (livello garantito) passerella ancora preferita al guado ma segnalata «da verificare sul posto»; la posa effettiva e le
  chiusure non sono verificabili (non esiste un dato pubblico in tempo reale): lo dicono il menu Livelli e il pianificatore.
- **Orari senza rete**: `/api/fissi` dice per ogni servizio i giorni con orari per giorno della stessa versione (`src[].orari`); il telefono
  salva oggi (e domani dopo le 20, non con «risparmio dati»), tiene ieri per le corse dopo mezzanotte, verifica ogni file con l'impronta;
  senza rete il pannello della fermata mostra «Senza rete · orari programmati», righe «Da orario», mai ritardi/mezzi/soppressioni. Prova
  sui GTFS veri: partenze del telefono identiche a `schedule.departures` del server (navigazione e autobus, 4 orari, fino a 60 fermate per servizio).
- **Schede**: Preferiti (Fermate/Percorsi), marea, avvisi, Mezzi e Livelli si riposizionano a ogni cambio di altezza, rotazione e
  tastiera (`util.js: seguiScheda`, `altezzaUtile`). Misurato prima: passando a «Percorsi» la scheda restava in alto con 294 px vuoti sotto.
- **Posizione del mezzo**: «Posizione aggiornata N secondi fa / N minuti fa» (`util.js: etaPosizione`), ogni secondo con il pannello aperto.
- **Prove**: `npm test` 315/315; interfaccia (Chrome headless, 6 dimensioni in `run.py`): `run.py`, `sistema.py`, `acqua.py`, `marea.py`,
  `viaggio.py`, `modifica.py`, `offline.py` passate, anche con `TESTO=1.3` (dopo il cambio di versione ripetute `run`, `sistema`,
  `viaggio`, `modifica`, `offline`).

## 9 ter. Passerelle nel pianificatore, simulazione a +110 cm (22/11/2026, v33.13)
- **Problema trovato**: con il terreno sotto la passerella più alto del livello (dati del rilievo: Zattere +111/121 cm) il tratto non
  contava né bagnato né su passerella: a +110 cm il percorso Rio Terà Foscarini → Zattere diceva solo «a piedi». Su 16 percorsi simulati
  (rete pedonale del ramo `dati`, rilievo, passerelle posate a +110) prima: 0 m di passerella a Zattere, Giudecca, Tolentini; ora: 122 m
  (T6.2A), 158 m (T7.1A), 58 m (T5.2B/C) e in tutti gli altri casi il percorso dichiara le passerelle usate.
- **Tracciati legati alla rete**: `allinea` sostituisce ogni parte del tracciato con le calli OSM che gli corrono sopra (89/102 parti;
  Zattere T6.2A: scarto prima 2–3 m, ora coincide; i due tratti T6.2B verso i pontili sono legati alle passerelle dei pontili in OSM).
  Restano disegnati (e diventano archi propri sul telefono): T1.1B/C/E e T1.2A (Piazza e Piazzetta San Marco, area senza calli in OSM),
  T1.2C, T2.1A (un tratto), T5.1A/B/C (pontili di Piazzale Roma: in OSM sono aree, non percorsi). Elenco a ogni `genera-acqua.js`.
- **Rete pedonale (ramo `dati`)**: versione `b2f1bb3e30622032` del 21/11/2026, 1.603 mattonelle; controllo su 83 ponti OSM: tutti i
  pubblici hanno il segno «ponte»; i 5 senza sono 4 ponti `access=private` e la carreggiata del Ponte della Libertà (`foot=no`), esclusi apposta dalla rete.
- **Prove**: `npm test` 316/316; `tests/ui/passerelle.py` (DATI_DIR), `acqua.py` (anche `TESTO=1.3`), `offline.py`, `run.py`.

## 9 quinquies. Meteo da Intranet-BIS (25/11/2026)
`meteo-parse.js` riprende le regole di `cpsm-meteo.service.js`, `visibility.service.js` e `metar-visibility.service.js` (verificate con gli stessi
campioni: stessi valori; unica differenza voluta, il vento calmo non ha direzione). Da `meteo-history.service.js` solo l'idea dei cicli per fonte:
niente SQLite, niente storico. `meteo.js`: un ciclo per feed (7), polling adattivo (impara periodo e ritardo di pubblicazione, torna 30 s prima
del dato atteso, poi ogni 30-60 s), 304 economici, attesa crescente sugli errori, una richiesta alla volta per feed. API `/api/meteo*` leggono
solo la cache. Skill: `alexa/meteo.js`, intenti `MeteoIntent`, `MeteoSeguitoIntent`, `MeteoDirezioneIntent`, `MeteoConfrontoIntent`,
`MeteoRecenteIntent`; tipi `METEO_GRANDEZZA`, `METEO_STAZIONE`. Prove: `tests/meteo.test.js`, `tests/alexa-meteo.test.js`.

## 9 quater. Audit funzionale e simulazioni sul campo (24/11/2026, v34)
- **Rapporto completo**: `tests/collaudo/RAPPORTO.md` (inventario e copertura, scenari, problemi con gravità/causa/correzione, misure,
  limiti). Tre commit su `main` il 24/11/2026 (correzione di `dati.yml` compresa), con l'autorizzazione dell'utente; il ramo
  `audit-v34` resta su GitHub come punto di ripristino. Il deploy su Render lo fa l'utente a mano.
- **Avvisi e percorsi**: gli avvisi testuali (fermata sospesa, nebbia, acqua alta) non cambiano i percorsi, per scelta: ACTV lascia la
  corsa negli orari. Il server esclude solo ciò che il GTFS-RT dichiara (corse soppresse, fermate saltate). Ora lo si dice in modo chiaro
  ovunque (pianificatore, viaggio, pannello della fermata) e gli avvisi generali che possono far saltare corse entrano nel viaggio.
- **Viaggio guidato sul campo**: `checkRide`/`gpsWarn` in `viaggio.js` (mezzo perso, discesa mancata; solo suggerimenti, mai azioni
  automatiche); «Ricalcola da qui» usa la posizione del viaggio. Il GPS resta spento a bordo dopo i primi 4 minuti e con l'app nascosta.
- **Prove**: `npm test` (con `notifiche-catena.test.js`, catena push isolata con iscrizioni di prova e invio intercettato) e
  `tests/ui/tutte.sh` / `tutte.ps1` (13 prove d'interfaccia, anche `TESTO=1.3`). Il server di prova tiene i file statici in memoria:
  dopo una modifica a `public/` va **riavviato** prima delle prove d'interfaccia. Le prove usano un IP diverso per persona simulata
  (`X-Forwarded-For` con `TRUST_PROXY=1`), altrimenti scattano i limiti di frequenza («Troppe richieste»), che è il comportamento giusto.

## 9 quinquies. Skill Alexa «Venezia TPL» (25/11/2026, ramo `feature/alexa`, non pubblicata)
Cartella `alexa/` (guida per l'utente `alexa/README.md`, decisioni e stato `alexa/STATO.md`). Architettura: Alexa → funzione Lambda gratuita
di Alexa-hosted (`alexa/lambda`, toglie gli identificativi, gestisce Avvio/Aiuto/Stop) → `POST /api/alexa` su Render (`ALEXA_TOKEN`) → `alexa/skill.js`,
che riusa in processo `/api/zone`, `/api/percorso`, `/api/tide`, `/api/mose`, `/api/avvisi`, ecc. Nessun dato duplicato, nessun LLM, nessuna
dipendenza nuova, nessun dato personale salvato. Modifiche al server: solo `POSTS`, costanti `ALEXA_*`, `alexaAmbiente`, `stopsOut()`/`routesOut()`
(estratte dai gestori esistenti) e due ingressi API; `security.js`: limite `alexa: 90`. Push e tempo reale non toccati. Da verificare solo con
Amazon e un Echo: compilazione del modello (1328 fermate), pronuncia, schede APL, risveglio di Render al primo uso.

Revisione 2 (ramo `feature/alexa-voce`): `alexa/diretti.js` (corse dirette sull'intero GTFS della data, via `gtfsAlexa` in `server.js`),
`alexa/zone.js` (etichette dei pali dalla PWA), `alexa/messaggi.js` (frasi fisse, copiate nella Lambda da `alexa/scripts/prepara-lambda.js`),
catalogo generato da `alexa/scripts/catalogo.js`. In `gtfs.js` si legge ora `route_type`.

## 10. Limiti noti e verifiche da fare
- Non provati su dispositivi veri: Safari iOS (installata e non), Android, Firefox e Safari desktop. Su iPhone le notifiche esistono solo
  con l'app nella schermata Home; «Schermo intero» non c'è (Fullscreen API non disponibile).
- Lo zoom con due dita è disattivato (`user-scalable=no`) per non interferire con la mappa; al suo posto c'è «Dimensione del testo» (fino al
  130%). WCAG 1.4.4 chiede il testo leggibile al 200%: decisione dell'utente (vedi `STATO.md` §8).
- Avvisi aperti di CodeQL: da controllare in GitHub → Security (non leggibili dall'IA senza accesso autenticato).
- Ramo `dependabot/npm_and_yarn/adm-zip-0.6.1` obsoleto (adm-zip non è più usato): da eliminare a mano su GitHub.
- Passerelle non georeferenziate dalle tavole (San Marco 1.3–1.11, isole) restano ricostruite sulle calli; quote di posa del piano, non posa reale.
  Da guardare sul posto: T3.2A (Ferrovia, tracciato con un tratto lungo la fondamenta che nella tavola non c'è) e T9.2B (Burano, «Calle
  Daffan» non trovata tra i nomi OSM lungo il tracciato). Isole senza rilievo: confronto solo a vista (precisione di qualche metro).
- Orari senza rete: solo se l'app è stata aperta con la rete nello stesso giorno (o dopo le 20 del giorno prima); al cambio di versione dei
  GTFS a mezzanotte domani non si scarica (versione diversa): senza rete il pannello dice che gli orari non sono salvati.
- Non provati su dispositivi veri: ResizeObserver/visualViewport con la tastiera su iPhone e Android, orari senza rete su Safari iOS.
- Informativa e condizioni: testi prudenziali scritti senza consulenza legale; verifica professionale consigliata (vedi rapporto finale).

## 11. Regole per le modifiche future
Leggere `CRITERI.md`; modificare solo i file necessari; nessuna funzione persa; prove nuove per ogni novità e `npm test` verde prima del
push; con modifiche all'interfaccia anche le prove di `tests/ui/` (anche con `TESTO=1.3`); aggiornare versione, `CHANGELOG.md`, README §12,
`STATO.md` e questo file; mai deploy senza l'utente; risposte all'utente in italiano, brevi, con «Cosa è cambiato / Cosa devi fare tu / Cosa
non è stato verificato» e comandi PowerShell.
