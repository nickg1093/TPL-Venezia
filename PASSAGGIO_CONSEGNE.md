# Passaggio di consegne — Venezia TPL live, versione locale v33.10 (21/11/2026)

Documento autonomo per riprendere il lavoro in una nuova conversazione. Leggere poi `STATO.md` (stato e regole), `CRITERI.md` (regole
obbligatorie) e `README.md` (riferimento; novità in §12, acqua alta e passerelle nell'appendice D).

## 1. Cos'è, regole e comunicazione

- **PWA** con mappa in tempo reale di autobus, tram e vaporetti ACTV di Venezia: pannelli di fermate e corse, pianificatore (RAPTOR) con
  viaggio guidato, avvisi di arrivo push, avvisi di servizio ACTV, marea e MOSE, **acqua alta** (zone potenzialmente allagabili e passerelle,
  solo nella versione locale v33), preferiti, percorsi e viaggi salvati.
- **Regole non negoziabili**: costo 0 € (Render gratuito 512 MB + GitHub Actions/rami dati/CDN jsDelivr + PWA); Render non deve mai andare in
  crash; nessuna funzione persa; niente dati personali, cookie, pubblicità o script di terzi (niente AdSense; donazioni tolte nella v33.9);
  deploy **solo a mano** dall'utente; push solo con prove verdi; non modificare GitHub/Render senza autorizzazione esplicita.
- **Con l'utente**: italiano, risposte brevi, comandi PowerShell; chiudere con «Cosa è cambiato / Cosa devi fare tu / Cosa non è stato
  verificato». Instagram @olocin_g = profilo di chi ha sviluppato l'app (non un contatto); contatti e segnalazioni solo all'email della
  variabile d'ambiente su Render (`/api/about` → `contact`).

## 2. Dove sta

| | |
|---|---|
| Sito online | https://veneziatpl.onrender.com (v32.5 online; v32.6 pronta da pubblicare; `/api/about` mostra la versione) |
| Codice | https://github.com/nickg1093/TPL-Venezia, ramo `main` (pubblico) |
| Copia collegata a GitHub | `D:\Downloads\TPL-Venezia` (versione online, v32.x, **senza acqua alta**) |
| Copia locale | `D:\Downloads\TPL-Venezia-LOCALE` → **v33.10** (acqua alta, passerelle, rilievo RAMSES); non va su GitHub finché l'utente non lo dice |
| Dati solo sul computer (in `.gitignore`) | `dati-ramses/curve-livello-shp.zip` (rilievo RAMSES, 332.908.824 B), `dati-passerelle/*.pdf` (Atlante passerelle), `tmp-atlante/` |

## 3. Architettura (parti toccate da questo lavoro)

- **Server** Node.js 22 senza framework né database (`server.js`, dipendenze `leaflet`, `protobufjs`); serve `public/` come file statici
  (compressi gzip). Non fa calcoli per l'acqua alta: tutto è preparato sul computer e calcolato sul telefono.
- **Interfaccia** `public/`: moduli ES nativi, Leaflet, service worker `public/sw.js` (guscio dell'app in cache versionata `VERSION`;
  `/api/*` e `/acqua/*` sempre dalla rete), CSP rigida.
- **Acqua alta (solo v33)**:
  - `scripts/genera-acqua.js` (preparazione sul computer): rete pedonale (mattonelle del ramo `dati`), passerelle
    (`data/acqua/passerelle-atlante.json` + `data/acqua/passerelle-tavole.json`), quote stimate (`data/acqua/quote-riferimenti.json`),
    con `--ramses` le quote misurate in tessere. Uscita: `public/acqua/{indice,quote,passerelle}.json` e `public/acqua/rilievo/`.
  - `scripts/acqua-core.js` (stima, ricalco delle passerelle sulla rete, codifiche), `scripts/ramses-core.js` (lettura ZIP/SHP/DBF in
    streaming, EPSG:3004, quota della curva più vicina).
  - Telefono: `public/js/acqua.js` (lettura dei file, `composta()` stima + tessere, passerelle con rami `parti`, metri bagnati),
    `public/js/livelli.js` (menu Livelli, disegno su calli e passerelle, cache «tpl-fissi-1» con impronta SHA-256, tessere a richiesta,
    uso senza rete), `public/js/percorso.js` (pianificatore: tratti allagati evitati, passerelle usate).
- **Versione** in tre punti: `ABOUT_VERSION` (`server.js`), `VERSION` (`public/sw.js`, `public/js/sistema.js`) = **v33.10**.

## 4. Stato iniziale di questa sessione e modifiche

Stato iniziale: v33.9 locale (rilievo RAMSES in tessere pubblicabili con «Fonte informativa: Insula spa», donazioni tolte, Instagram come
profilo dello sviluppatore, crediti della mappa sempre visibili in forma breve). Modifiche della v33.10:

1. **Atlante passerelle (Centro Maree)** — analisi dei 10 PDF, georeferenziazione, confronto e integrazione (§5).
   - `data/acqua/passerelle-tavole.json` (nuovo, 15 kB): 32 tracciati verificati + elenco dei non usati con il motivo.
   - `data/acqua/passerelle-atlante.json`: San Marco aggiornato alle **schede 2023** (20 percorsi con lunghezza/quota/descrizione nuove,
     campo `agg: '2023'`), **T1.1 E** aggiunto (48 m, +80, posizione dalla tavola), note aggiornate. Ora 73 percorsi.
   - `scripts/genera-acqua.js`: usa il tracciato della tavola dove c'è (`o: 'tavola'`, rami in `l2`), altrimenti ricalca sulla rete come prima.
   - `public/js/acqua.js`: `passerelleDa()` legge `l2` (rami) in `parti`; `indicePasserelle()` usa tutti i rami.
   - `public/js/livelli.js`: disegna tutti i rami; nel fumetto «Tracciato dalla tavola dell'Atlante passerelle».
   - `scripts/atlante/` (nuovo): strumenti Python dell'analisi (vedi §9), solo sul computer.
2. **Crediti della mappa**: ripristinato il comportamento precedente (visibili all'apertura, spariscono dopo 5 s o alla prima interazione;
   il pulsante «Percorso» scende al loro posto). In più: quando le quote misurate compaiono per la prima volta sulla mappa, i crediti
   tornano visibili per 5 s con «Fonte informativa: Insula spa» (evento `tpl:crediti`). Crediti completi e diciture sempre in Informazioni
   («Fonti e licenze», scheda «Quote delle calli»). File: `public/js/info.js`, `public/js/livelli.js`, `public/css/app.css`, `public/index.html`.
3. **Senza connessione** (v. §6): avviso «Senza connessione» sulla mappa (`public/js/pwa.js`, `#offline-bar`); marea e avvisi salvati e
   mostrati come «dati salvati» con l'ora (`public/js/tide.js`, `public/js/avvisi.js`).
4. Prove nuove/aggiornate: `tests/passerelle-tavole.test.js` (nuova), `tests/ui/offline.py` (nuova), `tests/acqua.test.js`,
   `tests/ui/sistema.py` (crediti 5 s). Documentazione: `README.md` §12, `STATO.md`, questo file. `.gitignore`: `dati-passerelle/`, `tmp-atlante/`.

## 5. PDF analizzati, informazioni ricavate e confronti geografici

**Fonte**: Comune di Venezia, Centro Previsioni e Segnalazioni Maree / Gruppo Veritas, «Atlante dei percorsi in quota su passerelle del
centro storico e delle isole di Venezia», `https://www.comune.venezia.it/sites/comune.venezia.it/files/documenti/centro_maree/bibliografia/`.
Il sito impedisce la lettura automatica (robots): i PDF sono stati scaricati dall'utente con PowerShell in `dati-passerelle/`.

| File | Pagine | Data | Contenuto |
|---|---|---|---|
| `1_sanmarco_20230417.pdf` | 24 | creato 21/09/2026, aggiornamento 17/04/2023 | per tavola: mappa (21 immagini a mosaico, percorsi disegnati nell'immagine) + scheda dei percorsi (lunghezza, quota, n. tavole e cavalletti); in fondo la tabella riassuntiva **ancora con i valori 2019** |
| `2_castello.pdf` … `10_cimitero.pdf` | 4–16 | 19/08/2019 | per tavola: localizzazione + mappa con percorsi **vettoriali** colorati ed etichette «Percorso X»; in fondo la tabella riassuntiva (uguale a `tot_pass.pdf`) |

- **Fondo delle mappe**: immagine raster derivata dal rilievo **RAMSES** (curve di livello colorate, edifici, nomi delle calli), orientata a
  nord nel sistema EPSG:3004, pixel quadrati; sulla pagina l'immagine è a volte deformata (rapporto 0,74), i tracciati sono disegnati sopra.
  Nessuna griglia di coordinate né scala: le coordinate **non** si ricavano dall'immagine da sola.
- **Georeferenziazione** (affidabile, ripetibile): le curve colorate dell'immagine sono state registrate sulle curve RAMSES vere (raster a 0,5 m
  da `curve-livello-shp.zip`) con correlazione normalizzata su più scale (70 passi + affinamento ±5 %, sotto-pixel), senza rotazione (le
  mappe sono a nord); qualità = picco della correlazione e distacco dal secondo picco. Sovrapposizioni controllate a vista (Castello 2.1,
  San Marco 1.1: curve coincidenti). Precisione stimata 1–3 m.
- **Tracciati**: 2019 dai vettori della pagina (spessore ≥ 3 pt, un colore per percorso, etichette assegnate con il metodo ungherese sulla
  distanza); San Marco 2023 dai colori della legenda delle schede (pallini colorati) estratti dall'immagine, scheletro e tratti.
- **Criteri per usare un tracciato**: corrispondenza ≥ 0,60 e ≥ 0,12 sopra il secondo picco; lunghezza entro max(8 m, 25 %) di quella
  ufficiale (scheda 2023 per San Marco, tabella 2019 altrove); scarto massimo dal tracciato precedente ≤ 60 m (oltre: possibile etichetta
  sbagliata, da verificare a vista).
- **Testo**: `tot_pass.pdf` (2019) e le tabelle dei sestieri coincidono (74 righe; nel progetto tutte tranne T1.7 D). Le **schede San Marco 2023**
  cambiano 20 percorsi, tra cui T1.1 F (24 m, **+65 cm**, prima 70 m +80), T1.7 A (124 m, prima 75), T1.7 B (72 m, +110, prima 49 m +105),
  T1.9 B (40 m, prima 28), T1.2 B (posa da +90 a +110: usato +110 = percorso completo), e danno lunghezza a T1.1 E (48 m, +80) e T1.7 D (8 m, +100).
  Scelta: valgono le schede (più recenti e specifiche); la tabella in fondo allo stesso PDF è rimasta quella 2019.

**Confronto con i tracciati del progetto** (prima ricalcati sulla rete pedonale OSM a partire dai nomi): 32 percorsi georeferenziati e
verificati. Discrepanze importanti corrette (il tracciato della tavola sostituisce il ricalco): T2.1 D (risale Calle de le Rasse invece di
correre sulla Riva, scarto medio 19 m), T2.1 F (dal percorso E al pontile Jolanda, 30 m), T1.1 C (Campanile, 26 m), T1.2 A (molo dei
Giardini Reali), T1.2 C (verso l'ingresso di Palazzo Ducale invece che verso il bacino, 36 m), T4.1 B/C/D (Rialto Mercato, 12–23 m),
T5.1 B (32 m), T6.2 B (pontili delle Zattere, 24 m). Concordano entro pochi metri: T1.1 A/B/D, T2.1 A/B/E, T3.1 A, T3.5 A, T3.6 A, T4.2 A,
T6.2 A, T7.1 A.

Tracciati usati:

| Percorso | Fonte | Corrisp. | m tavola | m uff. | scarto medio / max dal tracciato precedente |
|---|---|---|---|---|---|
| T1.1A | 1_sanmarco_20230417.pdf p.2 | 0.78 | 23.9 | 30 | 1.6 / 2.2 m |
| T1.1B | 1_sanmarco_20230417.pdf p.2 | 0.78 | 113.5 | 120 | 2.2 / 9.6 m |
| T1.1C | 1_sanmarco_20230417.pdf p.2 | 0.78 | 35.6 | 36 | 26.3 / 39.4 m |
| T1.1D | 1_sanmarco_20230417.pdf p.2 | 0.78 | 7.7 | 12 | 1.4 / 4.6 m |
| T1.1E | 1_sanmarco_20230417.pdf p.2 | 0.78 | 50.9 | 48 | None / None m |
| T1.1G | 1_sanmarco_20230417.pdf p.2 | 0.78 | 9.0 | 12 | 1.1 / 12.7 m |
| T1.2A | 1_sanmarco_20230417.pdf p.4 | 0.65 | 36.1 | 32 | 14.8 / 19.0 m |
| T1.2B | 1_sanmarco_20230417.pdf p.4 | 0.65 | 108.1 | 105 | 2.2 / 16.3 m |
| T1.2C | 1_sanmarco_20230417.pdf p.4 | 0.65 | 15.7 | 16 | 36.0 / 38.0 m |
| T2.1A | 2_castello.pdf p.3 | 0.95 | 30.0 | 28 | 3.7 / 8.5 m |
| T2.1B | 2_castello.pdf p.3 | 0.95 | 79.5 | 84 | 4.3 / 7.2 m |
| T2.1C | 2_castello.pdf p.3 | 0.95 | 56.5 | 70 | 6.1 / 31.4 m |
| T2.1D | 2_castello.pdf p.3 | 0.95 | 37.9 | 49 | 18.6 / 37.3 m |
| T2.1E | 2_castello.pdf p.3 | 0.95 | 34.0 | 35 | 2.1 / 6.9 m |
| T2.1F | 2_castello.pdf p.3 | 0.95 | 19.0 | 17.5 | 30.0 / 39.4 m |
| T3.1A | 3_cannaregio.pdf p.3 | 0.71 | 40.9 | 42 | 3.6 / 6.8 m |
| T3.3A | 3_cannaregio.pdf p.7 | 0.76 | 22.8 | 21 | 12.1 / 23.3 m |
| T3.4A | 3_cannaregio.pdf p.9 | 0.93 | 27.3 | 31.5 | 5.2 / 18.0 m |
| T3.5A | 3_cannaregio.pdf p.11 | 0.73 | 116.1 | 122.5 | 2.2 / 16.0 m |
| T3.6A | 3_cannaregio.pdf p.13 | 0.78 | 82.3 | 77 | 1.3 / 5.2 m |
| T4.1A | 4_san_polo.pdf p.3 | 0.72 | 24.5 | 28 | 3.4 / 9.5 m |
| T4.1B | 4_san_polo.pdf p.3 | 0.72 | 30.8 | 24.5 | 12.0 / 25.0 m |
| T4.1C | 4_san_polo.pdf p.3 | 0.72 | 24.5 | 28 | 18.9 / 34.2 m |
| T4.1D | 4_san_polo.pdf p.3 | 0.72 | 21.7 | 17.5 | 22.9 / 28.2 m |
| T4.2A | 4_san_polo.pdf p.5 | 0.66 | 74.5 | 87.5 | 1.0 / 22.7 m |
| T4.3A | 4_san_polo.pdf p.7 | 0.93 | 16.1 | 14 | 10.6 / 18.6 m |
| T5.1A | 5_santa_croce.pdf p.3 | 0.77 | 49.2 | 42 | 5.8 / 13.4 m |
| T5.1B | 5_santa_croce.pdf p.3 | 0.77 | 35.1 | 42 | 32.5 / 42.0 m |
| T5.1C | 5_santa_croce.pdf p.3 | 0.77 | 16.6 | 24.5 | 6.1 / 19.3 m |
| T6.2A | 6_dorsoduro.pdf p.5 | 0.85 | 122.6 | 140 | 1.0 / 14.3 m |
| T6.2B | 6_dorsoduro.pdf p.5 | 0.85 | 18.2 | 14 | 23.8 / 33.9 m |
| T7.1A | 7_giudecca.pdf p.3 | 0.93 | 165.0 | 161 | 1.9 / 14.8 m |

Non usati (restano ricalcati sulla rete come prima, `k: 't'` o `'i'`): l'elenco completo con il motivo è in
`data/acqua/passerelle-tavole.json → non_usati`. In sintesi: **isole** (Murano 8.x, Burano 9.x, Cimitero 10.1) fuori dal rilievo RAMSES:
non georeferenziabili con questo metodo; **San Marco** 1.3–1.9 e 1.11 A: correlazione debole o colori non estratti (mosaico di immagini,
tavole con molte curve); 1.10 A: georeferenziata (0,82) ma colore del percorso non trovato; 1.11 B: scarto 94 m (etichetta dubbia);
**altri**: 2.2, 2.4, 3.2, 5.2, 6.1, 6.3 (picco non netto), 2.1 G, 2.3 A, 3.1 B/C (lunghezza incoerente: tratto in parte fuori dall'immagine
o colore condiviso), 3.7 (percorso disegnato nell'immagine, non vettoriale), 7.2 (fuori dall'immagine del rilievo).

## 6. Automatismi e funzionamento con e senza rete

- **Acqua alta** (`livelli.js`): livello in città = marea osservata/prevista (CPSM) limitato dal MOSE se attivo; si accende da solo da +80 cm.
  Quote: stima (20 m) + tessere RAMSES misurate (10 m, scaricate per la vista o la zona del percorso). Passerelle posate se il livello
  raggiunge la quota di posa e siamo in stagione (15/09–30/04). Linea continua = quota misurata, tratteggio = stima. Testi: «zone
  potenzialmente allagabili», non allagamento certo.
- **Cache e versioni**: guscio dell'app nel service worker (`VERSION`); dati dell'acqua (indice, quote, passerelle, indice e tessere del
  rilievo) in «tpl-fissi-1» con impronta SHA-256; indici salvati per l'uso senza rete; file di versioni vecchie tolti (`prune`). Dati fissi e
  rete pedonale: `fissi.js`/`pedoni.js` (cache propria). Aggiornamento: a ogni versione nuova il service worker riscarica il guscio; i dati
  con impronta cambiano solo se cambia l'indice.
- **Senza rete** (prova `tests/ui/offline.py`): l'app si apre dal service worker; avviso «Senza connessione: niente dati in tempo reale…»;
  la marea salvata (al massimo 36 ore) è dichiarata «dati salvati alle hh:mm» (scheda, etichetta del pulsante, niente «adesso»/«ora» sul
  grafico); gli avvisi salvati (24 ore) con l'ora; l'acqua alta usa la previsione salvata e i file già scaricati. **Non** funzionano senza rete
  (per natura): posizioni dei mezzi e arrivi in tempo reale, pianificatore (calcolo sul server), mattonelle della mappa non già nella cache
  del browser (OpenStreetMap non permette lo scarico in blocco), tessere del rilievo mai viste (lì resta la stima).
- **Render**: nessun cambiamento lato server oltre al numero di versione; file statici in più ~15 kB (`passerelle-tavole.json` non è servito:
  sta in `data/`); `passerelle.json` 13,5 kB (4,2 kB compressi).
- Versione online (cartella `D:\Downloads\TPL-Venezia`, v32.x): **non toccata**. Le stesse migliorie senza rete (marea/avvisi salvati,
  avviso di connessione, crediti) sono indipendenti dall'acqua alta e si possono portare sulla v32 quando l'utente lo chiede.

## 7. Prove eseguite (risultati reali, 21/11/2026)

- `npm test` (node --test): **308 su 308** in una copia con `data/gtfs/nav/20261102_189116ae.zip` ripristinato (sul PC: `git checkout --
  data/gtfs`); senza quel file falliscono solo le 2 prove note che lo usano.
- Interfaccia (Playwright, server di prova `DATI_CDN=0 MAREA_ARCHIVIO=0 AVVISI_ARCHIVIO=0 TRUST_PROXY=1 PORT=3111 node --expose-gc -r
  ./tests/fakefeed.js server.js`): **tutte passate** (21/11/2026, prima esecuzione, nessun ripetuto): `offline.py` (nuova), `run.py`, `viaggio.py`, `sistema.py`, `modifica.py`, `acqua.py`, `marea.py`, sia a testo normale sia con `TESTO=1.3` (14 su 14). Note: `viaggio.py` con `TESTO=1.3` e il pannello della corsa in `sistema.py` sono a volte instabili (in passato passavano al secondo tentativo).
- Controlli a occhio con Leaflet vero e la rete pedonale: passerelle di San Marco sui tracciati delle tavole, zone allagabili continue/tratteggiate.
- **Non verificato**: un telefono vero; le tavole non usate (§5) a vista una per una; T1.7 D.

## 8. Licenze, attribuzioni e limiti

- **Atlante passerelle**: pubblicato dal Comune di Venezia (Centro Maree) con Veritas; usato come fonte citata (`fonte` nei file e nel
  fumetto della passerella); i PDF non si ridistribuiscono (`dati-passerelle/` fuori da GitHub); si pubblicano solo i tracciati derivati.
- **Rilievo RAMSES**: le condizioni d'uso del sito di Insula consentono uso, riproduzione ed elaborazione, anche parziale, con «Fonte
  informativa: Insula spa»; vietate vendita e cessione a terzi dei dati: l'archivio originale non va su GitHub, le tessere derivate sì.
- **OpenStreetMap** © contributori (ODbL): crediti 5 s sulla mappa (linee guida OSMF) e sempre in Informazioni.
- **Limiti scientifici**: georeferenziazione 1–3 m; tracciati San Marco dai colori dell'immagine (rami brevi possono mancare); le quote di
  posa sono quelle del piano (il Comune può cambiarle); quota sotto la marea = acqua possibile, non certa; rilievo 2011, difese successive
  non considerate.

## 9. Come riprendere senza ripetere le analisi

- Tutto ciò che serve all'app è già in `data/acqua/` e `public/acqua/`: **non serve rifare l'analisi dei PDF** per lavorare sull'app.
- Rigenerare i file dell'acqua (sul PC, con Node):
  ```powershell
  cd D:\Downloads\TPL-Venezia-LOCALE
  node scripts\genera-acqua.js public --ramses dati-ramses\curve-livello-shp.zip
  npm test
  ```
- Rifare o estendere l'analisi delle tavole (solo se cambiano i PDF): Python 3 con `pip install pymupdf opencv-python-headless scikit-image
  scipy shapely pyproj pyshp pillow`; poi, dalla cartella del progetto:
  ```powershell
  $env:ATLANTE_PDF="dati-passerelle"; $env:ATLANTE_OUT="tmp-atlante"; $env:RAMSES_NPZ="tmp-atlante\raster.npz"
  python scripts\atlante\raster.py dati-ramses\curve_livello_polyline tmp-atlante\raster.npz   # shapefile estratto dallo ZIP
  # progetto.json: tracciati attuali (id, pts) da public/acqua/passerelle.json con passerelleDa() di public/js/acqua.js
  python scripts\atlante\atlante.py; python scripts\atlante\sanmarco.py; python scripts\atlante\confronto.py
  python scripts\atlante\qa.py 2.1,1.1          # immagini di controllo in tmp-atlante
  ```
  Il passo che produce `data/acqua/passerelle-tavole.json` da `confronto.json` (criteri del §5, semplificazione 0,7 m) è descritto in
  `passerelle-tavole.json → metodo`; ripeterlo con gli stessi criteri.
- Prossimi passi possibili: (1) verificare a vista e, se serve, posizionare a mano i percorsi non usati (San Marco 1.3–1.11, T1.7 D, isole)
  partendo dalle immagini di controllo; (2) chiedere al Centro Maree i tracciati vettoriali o i file sorgente dell'Atlante; (3) quando
  l'utente lo autorizza, portare acqua alta, passerelle e uso senza rete sulla versione online e pubblicare (deploy a mano); (4) prova su
  telefono (Android installata, iPhone) di uso senza rete e crediti.
