# Passaggio di consegne — Venezia TPL live v33.11 (21/11/2026)

Documento autonomo per riprendere il progetto in una nuova conversazione. Dopo questo leggere `STATO.md` (stato e regole), `CRITERI.md`
(regole obbligatorie per ogni modifica) e, quando serve un dettaglio, `README.md` (riferimento completo a sezioni numerate).

## 1. Cos'è
PWA gratuita, personale e indipendente (non ufficiale ACTV) con mappa in tempo reale di autobus, tram e vaporetti di Venezia:
pannelli di fermate e corse, «Programmato» per altri giorni, pianificatore (RAPTOR) con viaggio guidato e percorsi a piedi lungo le strade,
avvisi di arrivo (notifiche push), avvisi di servizio ACTV (RSS e Telegram, scioperi), marea CPSM e MOSE, **acqua alta** (zone
potenzialmente allagabili e passerelle dell'Atlante del Comune), preferiti, percorsi e viaggi salvati, uso senza rete con dati salvati.

## 2. Dove sta

| | |
|---|---|
| Sito | https://veneziatpl.onrender.com — Render gratuito (512 MB, Virginia); `/api/about` mostra versione e contatto |
| Codice | https://github.com/nickg1093/TPL-Venezia (pubblico). Rami: `main` (codice), `dati` (file per i telefoni via CDN jsDelivr), `archivio-avvisi`, `archivio-marea` (archivi dei workflow), `ripristino-v33.10` (punto di ripristino prima dell'audit) |
| PC dell'utente | `D:\Downloads\TPL-Venezia` = clone di GitHub (quello che va online). `D:\Downloads\TPL-Venezia-LOCALE` = copia di lavoro locale (contiene anche i dati solo locali sotto) |
| Solo sul PC, mai su GitHub | `dati-ramses/curve-livello-shp.zip` (rilievo RAMSES di Insula, 333 MB), `dati-passerelle/*.pdf` (Atlante passerelle), `tmp-atlante/` |
| Versione | `ABOUT_VERSION` in `server.js`, `VERSION` in `public/sw.js` e `public/js/sistema.js` (tutte **v33.11**); `GUIDA_VER` in `public/js/guida.js` (`v33`) |

## 3. Architettura
- **Server** Node.js 22, nessun framework né database, nessuna scrittura su disco tranne l'archivio GTFS; dipendenze solo `leaflet` e
  `protobufjs` (7.x; la 8 è un salto di versione non provato). `server.js` = instradamento, tabella `API`, file statici in memoria
  (compressi), flusso SSE a differenze `/api/stream`. Moduli principali: `live.js` (tempo reale), `tracker.js`/`assign.js`/`turni.js`,
  `gtfs*.js`, `orari.js`, `percorso.js` (pianificatore), `avvisi*.js`, `watch.js`/`push.js` (notifiche), `tide.js`/`mose.js`,
  `memoria.js` (protezione dei 512 MB), `metriche.js` (misure aggregate in memoria), `security.js` (intestazioni, limiti, token, validazione).
- **Telefono** `public/`: moduli ES senza build; Leaflet servito da `/vendor`; `sw.js` (guscio in cache versionata, `/api/*` e `/acqua/*`
  sempre dalla rete); `js/fissi.js` e `js/pedoni.js` salvano dati fissi e rete pedonale (CDN, impronta SHA-256); `js/acqua.js` e
  `js/livelli.js` per l'acqua alta; `js/guida.js` guida, novità e storico; `js/info.js` pagina Informazioni (testi in `index.html`).
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
`MEM_CRITICO_MB`, `DATI_REPO`, `MAREA_ARCHIVIO`. Segreti di GitHub: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`. Tabella completa: README §6.

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

## 10. Limiti noti e verifiche da fare
- Non provati su dispositivi veri: Safari iOS (installata e non), Android, Firefox e Safari desktop. Su iPhone le notifiche esistono solo
  con l'app nella schermata Home; «Schermo intero» non c'è (Fullscreen API non disponibile).
- Lo zoom con due dita è disattivato (`user-scalable=no`) per non interferire con la mappa; al suo posto c'è «Dimensione del testo».
- Avvisi aperti di CodeQL: da controllare in GitHub → Security (non leggibili dall'IA senza accesso autenticato).
- Ramo `dependabot/npm_and_yarn/adm-zip-0.6.1` obsoleto (adm-zip non è più usato): da eliminare a mano su GitHub.
- Passerelle non georeferenziate dalle tavole (San Marco 1.3–1.11, isole) restano ricostruite sulle calli; quote di posa del piano, non posa reale.
- Informativa e condizioni: testi prudenziali scritti senza consulenza legale; verifica professionale consigliata (vedi rapporto finale).

## 11. Regole per le modifiche future
Leggere `CRITERI.md`; modificare solo i file necessari; nessuna funzione persa; prove nuove per ogni novità e `npm test` verde prima del
push; con modifiche all'interfaccia anche le prove di `tests/ui/` (anche con `TESTO=1.3`); aggiornare versione, `CHANGELOG.md`, README §12,
`STATO.md` e questo file; mai deploy senza l'utente; risposte all'utente in italiano, brevi, con «Cosa è cambiato / Cosa devi fare tu / Cosa
non è stato verificato» e comandi PowerShell.
