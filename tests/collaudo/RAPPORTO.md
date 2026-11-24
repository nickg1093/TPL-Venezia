# Audit funzionale v34 — rapporto (24/11/2026)

Base: v33.13 (`c76ea34`) + correzione `dati.yml`. Ramo **locale** `audit-v34` (nessun push, nessun deploy). Ambiente: server di prova con
feed simulato (`tests/fakefeed.js`, mezzi, avvisi e marea finti), Chromium headless (Playwright 1.63) su schermi da 320 a 1440 px, rete
pedonale e dati del ramo `dati` copiati in locale (`DATI_DIR`). Nessun dato reale modificato, nessuna notifica a utenti reali (la catena
push è provata con iscrizioni generate nella prova e invio intercettato), nessun servizio esterno nuovo, nessuna dipendenza nuova.

**Cosa NON significa questo rapporto**: non è una copertura del 100%. Ogni comando dell'interfaccia è toccato da almeno una prova
automatica (sezione 1), ma non ogni combinazione; nessuna prova su telefoni veri, su Safari/WebKit o Firefox, né con i feed ACTV veri.

## 1. Inventario dei comandi e copertura

Comandi fissi della pagina (`public/index.html`, 47 con `id`) e prova che li usa (`tests/ui/*.py`):

| Gruppo | Comandi | Prove |
|---|---|---|
| Barra e mappa | plan-btn, search-toggle-btn, filter, search-clear, nearchip, linefilter, locate, mezzi-btn, livelli-btn, theme-btn | run, modifica, copertura, acqua, offline, viaggio |
| Finestre | avvisi-btn/close, tide-btn/close, sciopero-btn/close/ok, mezzi-close, livelli-close, info-btn/close/guide, install-btn | run, sistema, copertura, marea, acqua, offline |
| Preferiti | favs-btn/close, fv-tab-stops/routes, favs-file (salva/ripristina, file rovinati o estranei) | run, modifica, copertura, `preferiti-copia.test.js` |
| Pannello | pplan («Percorso da qui»), pshare, pfav, pnotify, pfollow, pclose, pback, watch-btn | run, copertura, viaggio |
| Livelli | lv-all, lv-pass, unk-toggle | acqua, copertura |
| Programmato | tl-date-btn, tl-date, tl-play, tl-now, tl-range | run, copertura |
| Sistema | sysbar-act/close, snack-install/close | sistema, copertura |
| Pianificatore (dinamici) | campi, opzioni, soluzioni, dettaglio, Inizia/Salva/Condividi, simili, «Anche alle», Modifica | run, modifica, viaggio, avvisi-campo, marea-scenari |
| Viaggio guidato (dinamici) | Ricalcola da qui, Termina (doppio tocco), posizione, schermo acceso, alternative | viaggio, viaggio-gps, guasti |

Tutti i 47 comandi fissi compaiono in almeno una prova (controllo: `grep` di ogni `id` in `tests/ui/`, 24/11/2026).

## 2. Scenari

| Scenario | Prova | Esito |
|---|---|---|
| A — bassa marea (−70 cm) | `marea-scenari.py` | nessuna nota di acqua alta; soluzioni normali |
| B — acqua alta 105 cm | `marea-scenari.py`, `acqua.py` | nota con livello e indicazioni per i tratti a piedi; passerelle sulla mappa |
| B+ — 110/115/120 cm, MOSE | `passerelle.py`, `avvisi-campo.py`, `viaggio.py` | passerelle nel percorso; nota sull'incertezza delle corse dal colmo di 110 |
| C — marea in salita durante il viaggio | `marea-scenari.py` | si usa il colmo previsto nel viaggio (116), non la misura di adesso (80) |
| C — dati vecchi / assenti / rovinati | `marea-scenari.py`, `guasti.py` | **prima**: dati di 5 ore fa presentati come attuali; **ora** «non aggiornati»; assenti o rovinati: nessuna nota inventata |
| Viaggio: salita regolare, a bordo | `viaggio-gps.py` | GPS acceso verso la fermata e 4 min dopo la partenza; nessun avviso falso |
| Viaggio: mezzo perso (ancora al pontile) | `viaggio-gps.py`, `viaggio.test.js` | **nuovo** avviso «Sei ancora a …?» con `role=alert`; con ritardo in tempo reale niente avviso |
| Viaggio: discesa mancata | `viaggio-gps.py`, `viaggio.test.js` | **nuovo** avviso «se non sei sceso…»; a piedi vicino alla fermata niente |
| Salto del GPS / una sola lettura / lettura imprecisa | `viaggio.test.js`, `viaggio-gps.py` | nessun avviso |
| GPS negato | `viaggio-gps.py` | guida con i soli orari, riga chiara |
| App in secondo piano e ritorno | `viaggio-gps.py` | GPS spento e riacceso |
| Rete assente un minuto durante il viaggio | `viaggio-gps.py`, `offline.py` | la guida resta con gli orari salvati |
| Corsa soppressa dal tempo reale | `viaggio-gps.py`, `notifiche-catena.test.js` | avviso nella guida e notifica «Corsa soppressa» |
| Ricalcola dopo il mezzo perso | `viaggio-gps.py` | **prima** ripartiva dalla fermata di arrivo stimata; **ora** dalla posizione |
| Fermata sospesa / nebbia / acqua alta (avvisi) | `avvisi-campo.py`, `viaggio-gps.py`, `viaggio.test.js` | percorsi invariati (giusto); detto chiaramente ovunque |
| Notifiche: conferma → preavviso → arrivo, soppressa, iscrizione revocata, «Esci ora», senza Web Push | `notifiche-catena.test.js` | ok (invio intercettato, messaggi decifrati come sul telefono) |
| Risposte rovinate o 500 (avvisi, marea, MOSE, fermate, dati fissi, mezzi), servizio lento | `guasti.py` | app usabile, nessun errore non gestito |
| Memoria del browser piena | `guasti.py`, `preferiti-copia.test.js` | **prima** «Salvato» falso per i viaggi; **ora** detto |
| Due schede, stesso viaggio | `guasti.py` | stessa guida; chiuso in una, chiuso nell'altra al ricaricamento |
| Telefono su un altro fuso orario | `guasti.py`, `fuso.test.js` | **prima** orologio e alcune date sul fuso del telefono; **ora** sempre Venezia |
| Testo «Molto grande» (`TESTO=1.3`), 320–1440 px, chiaro/scuro | `run.py`, `sistema.py`, `copertura.py`, `viaggio-gps.py`… | vedi §5 |

## 3. Problemi trovati

| # | Gravità | Area | Problema | Causa | Correzione | Prova |
|---|---|---|---|---|---|---|
| 1 | Media | Preferiti | Con memoria piena il ripristino cambiava l'elenco in uso ma non la memoria | elenchi cambiati prima di salvare | tutto-o-niente con ritorno allo stato precedente | `preferiti-copia.test.js` |
| 2 | Bassa | Preferiti | Conteggio falso oltre 100/30; chiavi e nomi non controllati | controllo solo del prefisso | formato della chiave, nomi ripuliti | idem |
| 3 | Bassa | Preferiti | File non JSON: messaggio tecnico in inglese | errore di `JSON.parse` mostrato | messaggio chiaro | idem, `copertura.py` |
| 4 | Bassa | Preferiti | La copia esponeva gli elenchi interni | riferimento invece di copia | copia | idem |
| 5 | Alta | Avvisi nel pianificatore | Avvisi generali (nebbia, acqua alta) mai mostrati per un percorso; fermata sospesa solo come avviso generico, senza dire che il mezzo può non fermarsi; niente nella schermata «In viaggio» | `forJourney` scartava gli avvisi senza linee/fermate | avvisi generali rilevanti come «Tutta la rete»; frase esplicita; nota fissa sull'incertezza | `viaggio.test.js`, `avvisi-campo.py` |
| 6 | Media | Viaggio guidato | Mezzo perso: la guida diceva «Sei sulla linea …» anche se eri rimasto al pontile | fasi solo a orario, GPS spento a bordo | controllo per 4 min dopo la partenza, solo suggerimento | `viaggio.test.js`, `viaggio-gps.py` |
| 7 | Media | Viaggio guidato | Discesa mancata non segnalata | idem | controllo per 6 min dopo l'arrivo | idem |
| 8 | Media | Viaggio guidato | «Ricalcola da qui» senza la posizione della mappa ripartiva dalla fermata di arrivo stimata (anche col mezzo perso) | `vgFrom` non usava il GPS del viaggio | usa la posizione del viaggio recente e precisa | `viaggio-gps.py` |
| 9 | Media | Marea | Dati della marea di 5 ore fa usati nel pianificatore senza dirlo | nota senza età del dato | «Dati della marea non aggiornati (ultimo di N ore fa)» | `marea-scenari.py` |
| 10 | Bassa | Marea | Colmo durante il viaggio sottostimato di qualche cm (passi di 5 min) | campionamento | anche gli istanti dei dati e la fine dell'intervallo | `viaggio.py` (era intermittente: 119 invece di 120) |
| 11 | Media | Viaggi salvati | Memoria piena: «Salvato in I miei viaggi» ma il viaggio spariva alla riapertura | errore di scrittura ignorato | messaggio onesto, suggerito «Condividi» | `guasti.py` |
| 12 | Media | Fuso orario | Telefono su un altro fuso: orologio dell'app, data di oggi, «parti alle», date e ore degli avvisi e della marea sul fuso del telefono (gli orari dei percorsi invece su Venezia) | `getHours`/`toLocale…` senza `timeZone` | `romeP` in `util.js`, usato ovunque | `fuso.test.js`, `guasti.py` |
| 13 | Bassa | Avvisi | «Bassa marea» non riconosciuta come avviso che può far saltare corse | parola mancante | aggiunta | `viaggio.test.js` |
| 14 | Media | Workflow `dati.yml` | Fallito il 23/11: 404 di Geofabrik bloccava tutto | `curl` senza tentativi sui 404 | tentativi, indirizzo di riserva, avviso e uscita senza errore | non eseguibile in locale (vedi §6) |
| 15 | Bassa | Documentazione | Commento in `index.html` diceva «niente user-scalable=no» mentre c'è | commento vecchio | corretto | — |
| — | Da decidere | Accessibilità | Zoom con due dita bloccato; «Dimensione del testo» arriva al 130%, WCAG 1.4.4 chiede 200% | scelta del progetto | **non cambiato**: decisione dell'utente (STATO.md §8.13) | — |

## 4. Confronto con Google Maps (trasporto pubblico)

Già presenti nell'app: partenze in tempo reale, pianificatore con alternative e preferenze (arrivare prima, camminare meno, meno cambi,
andatura), partenza/arrivo a un'ora, viaggio guidato con avvisi «esci/cambio/scendi» anche ad app chiusa, corse soppresse, condivisione,
uso senza rete. **Aggiunti ora** (compatibili con costo 0 e privacy): avviso di mezzo perso e di discesa mancata dalla posizione, ricalcolo
dalla posizione, avvisi di servizio nel percorso. **Non aggiunti, da decidere** (cambiamenti grandi): percorso «senza ponti/accessibile»
(Venezia: i ponti contano più dei gradini; richiede segni nella rete pedonale e nei cambi del server), condivisione dell'avanzamento del
viaggio in diretta (richiederebbe di mandare la posizione al server: contro la regola sulla privacy), affollamento (nessun dato ACTV).

## 5. Prove: prima e dopo

| | Prima (v33.13) | Dopo (v34) |
|---|---|---|
| `npm test` | 316 prove, 0 fallite | 324 prove, 0 fallite |
| Prove d'interfaccia | 8 (run, sistema, acqua, marea, modifica, offline, viaggio, passerelle) | 13 (+ marea-scenari, viaggio-gps, avvisi-campo, copertura, guasti): tutte ok (`tutte.sh`, 24/11 ore 22:3x) |
| Con `TESTO=1.3` | run, sistema, acqua, offline | run, sistema, acqua, offline, viaggio, viaggio-gps, avvisi-campo, marea-scenari, copertura: tutte ok |

Nessuna prova esistente è stata indebolita. Asserzioni cambiate perché il comportamento è cambiato apposta: «ultimo tratto a piedi:
GPS spento» (ora acceso per 6 minuti dopo la discesa, poi spento: provato), «novità più recente v33» → v34, ordine degli avvisi generali.

## 6. Misure (`tests/ui/prestazioni.py`, 90 s, telefono 390×844, feed simulato)

Stesse condizioni (server appena avviato, seconda misura, stessa macchina): v33.13 da `c76ea34` contro v34.

| | v33.13 | v34 |
|---|---|---|
| Pagina pronta (fermate disegnate) | 542 ms | 479 ms |
| DOMContentLoaded / load | 265 / 445 ms | 244 / 342 ms |
| Richieste e dati nei primi 30 s | 80 · 346 KB | 80 · 351 KB (+5 KB di codice nuovo, compresso) |
| Richieste dopo i primi 30 s (90 s) | 0 | 0 |
| Memoria JS della pagina inizio → fine | 4 → 6 MB | 4 → 6 MB |
| Nodi DOM | 862 | 858 |
| Compiti lunghi (> 50 ms) | 1, max 83 ms | 1, max 66 ms |
| Memoria del server (RSS) inizio → fine | 207 → 257 MB | 216 → 262 MB (codice del server invariato: differenza = variabilità) |

File: `prestazioni-prima-stesse-condizioni.json`, `prestazioni-dopo.json` (e `prestazioni-prima.json`, prima misura, condizioni diverse).
Le differenze di tempo sono nel rumore della macchina: nessun peggioramento misurabile. GPS: acceso al massimo 10 minuti in più per
viaggio (4 dopo ogni partenza, 6 dopo ogni discesa) e solo con l'app davanti. Sicurezza: `security.test.js` verde; la posizione non va
al server (il ricalcolo manda solo fermate vicine con le distanze, come prima); nessuna richiesta di rete nuova.

## 7. Cosa non è stato verificato

- Telefoni veri (Android Chrome, iPhone Safari installata e non), Firefox, Safari desktop; GPS vero (precisione, salti, consumo di
  batteria delle finestre di controllo); notifiche push reali (FCM, Apple) — la catena è provata solo fino alla richiesta HTTP cifrata.
- Feed ACTV veri e avvisi reali di nebbia/bassa marea: soglie dei controlli sul campo (90 s, 80 m, 300 m + 150 m/min) da confermare sul campo.
- Workflow `dati.yml` su GitHub (serve il push): la correzione è provata solo leggendo lo script.
- Lettori di schermo veri (TalkBack, VoiceOver): controllati solo ruoli e testi.

## 8. Limiti noti

- Gli avvisi testuali non cambiano i percorsi: se ACTV sospende una fermata senza toglierla dal GTFS-RT, la soluzione resta proposta
  (con la frase chiara). È la scelta giusta finché gli avvisi sono testo libero.
- I controlli sul campo servono il permesso di posizione e l'app aperta; con lo schermo spento lavorano solo le notifiche del server.
- Con l'app nascosta il GPS è spento: una discesa mancata con il telefono in tasca non viene vista.

## 9. File modificati e nuovi

Codice: `public/js/{avvisi,percorso,viaggio,tide,util,app,scegli,livelli,fav,favs,guida,sistema}.js`, `public/css/app.css`,
`public/index.html`, `public/sw.js`, `server.js` (solo versione), `.github/workflows/dati.yml`.
Prove nuove: `tests/{notifiche-catena,preferiti-copia,fuso}.test.js`, `tests/ui/{viaggio-gps,marea-scenari,avvisi-campo,copertura,guasti,prestazioni}.py`,
`tests/ui/tutte.{sh,ps1}`, `tests/collaudo/`. Prove aggiornate: `tests/viaggio.test.js`, `tests/novita.test.js`, versione della guida nei `tests/ui/*.py`.
Documenti: `CHANGELOG.md`, `README.md` (§9.4, §12), `STATO.md`, `PASSAGGIO_CONSEGNE.md`.

## 10. Prove a mano sul telefono (dopo il deploy, quando autorizzato)

1. Pianifica un percorso con partenza da un pontile e **Inizia il viaggio** con la posizione permessa; resta al pontile dopo la partenza:
   entro 2–4 minuti deve comparire «Sei ancora a …?»; «Ricalcola da qui» deve partire da «La mia posizione».
2. Su un vaporetto, resta a bordo oltre la fermata di discesa: entro 6 minuti «se non sei sceso…».
3. Giorno con avviso di nebbia o acqua alta: nel dettaglio della soluzione «Tutta la rete · …» e la nota sulle corse incerte.
4. Imposta il telefono su un altro fuso (Impostazioni → Data e ora): l'orologio dell'app resta sull'ora di Venezia.
5. Android: con la batteria in risparmio energetico controlla che «Esci/Cambio/Scendi» arrivino ad app chiusa; iPhone: solo con l'app
   nella schermata Home.
