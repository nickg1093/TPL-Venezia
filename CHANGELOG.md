# Novità di Venezia TPL live

Riepilogo per versione delle modifiche che contano per chi usa o mantiene l'app. I dettagli tecnici sono in `README.md` §12; lo storico per
gli utenti è nell'app (Informazioni → Novità, generato da `public/js/guida.js`).

## v34 — 24/11/2026 (audit funzionale e simulazioni sul campo)
- **Fermate sospese e corse incerte**: gli avvisi non cambiano i percorsi (giusto: la fermata sospesa resta negli orari), ma ora lo si dice
  chiaramente. Nel pianificatore la soluzione con una fermata di salita o discesa sospesa/spostata ha una riga in evidenza; nel dettaglio,
  sopra «Inizia il viaggio», la frase «il passaggio resta in orario, ma il mezzo potrebbe non fermarsi» e una nota fissa sulle corse che
  possono saltare (acqua alta, nebbia, scioperi). Gli **avvisi generali** che possono far saltare corse (nebbia, maltempo, acqua alta,
  bassa marea, deviazioni, servizio ridotto) entrano nel viaggio come «Tutta la rete»; quelli informativi (nuovi orari) no. Stessa
  chiarezza nella schermata «In viaggio» e nel pannello della fermata.
- **Controlli sul campo con la posizione** (viaggio guidato, solo suggerimenti): per 4 minuti dopo la partenza, se sei ancora al pontile
  «Sei ancora a …? Se la linea non è passata può essere in ritardo o non fermarsi; se l'hai persa, tocca «Ricalcola da qui»»; per 6 minuti
  dopo l'arrivo, se ti allontani dalla fermata più in fretta di chi cammina, «se non sei sceso, scendi alla prossima». Servono due letture
  precise e concordi (un salto del GPS non basta). «Ricalcola da qui» parte dalla posizione del viaggio quando la mappa non ce l'ha
  (prima ripartiva dalla fermata di arrivo stimata anche se eri rimasto al pontile).
- **Marea nel pianificatore**: con dati vecchi la nota lo dice («Dati della marea non aggiornati, ultimo di 5 ore fa»); il colmo durante il
  viaggio considera anche gli istanti dei dati (prima un massimo tra due passi di 5 minuti poteva sfuggire di qualche cm).
- **Preferiti**: ripristino tutto-o-niente (con memoria piena nulla cambia), chiavi e nomi controllati, conteggio vero, messaggi chiari per
  file rovinati o estranei; la copia non espone più gli elenchi interni.
- **Workflow «dati per i telefoni»** (fallito il 23/11 per un 404 di Geofabrik): download con tentativi anche sui 404 e indirizzo di
  riserva; se Geofabrik non risponde, avviso e si tiene la rete pedonale già pubblicata invece di fallire.
- Prove nuove: `tests/notifiche-catena.test.js` (catena push isolata), `tests/preferiti-copia.test.js`, `tests/ui/viaggio-gps.py`
  (GPS progressivo con orologio simulato), `tests/ui/marea-scenari.py`, `tests/ui/avvisi-campo.py`, `tests/ui/copertura.py`,
  `tests/ui/guasti.py`, `tests/ui/prestazioni.py`, `tests/ui/tutte.sh`; rapporto in `tests/collaudo/RAPPORTO.md`.

## v33.13 — 22/11/2026 (passerelle legate alle calli, simulazione a +110 cm)
- Simulazione del pianificatore a +110 cm (16 percorsi a piedi, rete pedonale vera e rilievo): con la v33.12 le passerelle comparivano solo dove
  il terreno sotto risultava allagato; alle Zattere (terreno a +111/121 cm), alla Giudecca e ai Tolentini non comparivano mai. Ora un tratto
  su passerella posata conta come «su passerella» anche con il terreno asciutto (senza rallentare il calcolo).
- Tracciati legati alle calli di OpenStreetMap (`scripts/acqua-core.js: allinea`): 89 parti su 102 coincidono con la rete pedonale (Zattere
  comprese); le 13 restanti (Piazza San Marco, pontili di Piazzale Roma, qualche pontile della Riva) restano disegnate e diventano archi
  propri della rete sul telefono. Raggio di riconoscimento sul telefono da 9 a 6 m.
- Testo del pianificatore: «su passerella per circa 120 m: da Ponte Longo a Rio Terà Foscarini (posata da 105 cm)»; con più percorsi
  il numero vero e il primo nome. Finestra della passerella: «sulle calli di OpenStreetMap» quando il tracciato è legato alla rete.
- Rete pedonale del ramo `dati` controllata: aggiornata il 21/11/2026, copre città storica, isole, Lido, Pellestrina, Chioggia e
  terraferma; su un campione di 83 ponti OSM tutti quelli pubblici hanno il segno «ponte» (i 5 senza: 4 ponti privati e la carreggiata del Ponte della Libertà vietata ai pedoni, esclusi apposta).
- Prove: `tests/ui/passerelle.py` (nuova, con una copia del ramo `dati`), `tests/acqua.test.js`.

## v33.12 — 22/11/2026 (verifica e correzioni finali)
- Passerelle: tracciati confrontati con le tavole dell'Atlante e con OpenStreetMap (nomi e geometrie dall'API ufficiale di OSM); corretti
  T1.3A (Fondamenta Corner Zaguri), T1.4A (Ponte e Campo de la Guerra, prima ~170 m più a sud), T2.3A (Barbaria de le Tole), T5.2B e T5.2C
  (Tolentini, la C era ~200 m fuori), T6.1A (Calle del Tragheto fino alla lunghezza ufficiale). Zattere (T6.2A/B) verificate: coerenti con la
  tavola 6.2 e con OSM, nessuna correzione necessaria.
- Pianificatore con l'acqua alta: le passerelle posate diventano archi della rete pedonale (anche dove OSM non ha la calle, es. attraverso un
  campo o verso un pontile), usati solo se posate a quel livello; i pezzi di strada ai capi di un percorso a piedi ora pagano l'acqua come gli
  altri (prima un percorso di due tratti allagati poteva sembrare asciutto); oltre +120 cm la passerella resta preferita al guado ma il testo
  avverte che può essere sommersa o chiusa. Ponti sempre asciutti; avvertenza che la posa effettiva non è verificabile in tempo reale.
- Senza rete: fermate e linee dai dati salvati anche all'apertura senza connessione; pannello della fermata con gli **orari programmati di
  oggi** salvati dal CDN (oggi, e domani dopo le 20; ieri per le corse dopo mezzanotte), dichiarati «Senza rete · orari programmati».
- Pannello della corsa: «Posizione aggiornata 25 secondi fa / 4 minuti fa», contata ogni secondo; «dato non recente» da 3 minuti; mezzo senza
  ora del rilevamento: «Ora della posizione non trasmessa dal mezzo».
- Schede (Preferiti, marea, avvisi, menu della mappa): posizione e altezza ricalcolate a ogni cambio di contenuto (schede Fermate/Percorsi,
  Modifica), rotazione o tastiera aperta.
- Prove: `tests/orarioggi.test.js`, `tests/posizione.test.js`, nuove prove in `tests/acqua.test.js`, `tests/ui/offline.py`, `tests/ui/run.py`,
  `tests/ui/modifica.py`.

## v33.11 — 21/11/2026 (audit finale)
- Informazioni: privacy allineata al funzionamento reale (conteggio giornaliero delle persone con impronta dell'IP a sale giornaliero, solo in
  memoria); «niente statistiche di terzi» al posto di «niente statistiche»; fonte dell'Atlante passerelle (Comune di Venezia – Centro Maree, con
  Gruppo Veritas) e avvertenza sulla posa effettiva; nuova sezione «Novità delle versioni».
- Guida: novità «Anche senza connessione»; «zone potenzialmente allagabili» al posto di «zone allagate».
- Server: versione registrata correttamente nelle segnalazioni di errore (`v33.10`); intestazione `Origin` non valida → 403 (prima errore 500).
- GitHub Actions: valori dell'evento passati come variabili d'ambiente in `dati.yml`; nuovo indirizzo Geofabrik; `update-gtfs.yml` con tempo
  massimo di 20 minuti.
- Prove: `tests/memoria-giorni.test.js` non dipende più da una versione dei GTFS che scade.

## v33.10 — 21/11/2026 (prima pubblicazione della v33)
- Acqua alta: zone potenzialmente allagabili (quote misurate del rilievo RAMSES, fonte Insula spa, e stime), passerelle dell'Atlante del
  Comune con 32 tracciati dalle tavole, pianificatore che evita i tratti allagati.
- Uso senza rete: avviso «Senza connessione», marea e avvisi salvati mostrati con l'ora.
- Ponti nella rete pedonale (non si allagano), crediti della mappa per 5 secondi, donazioni tolte.
- v33.1–v33.9 (sviluppate in locale, pubblicate con la v33.10): scioperi ad alta visibilità, proposta esatta nei viaggi salvati, schermo
  intero, ultimo rilevamento del mezzo, modifica dei percorsi salvati, avvisi più precisi.

## Versioni precedenti
v32 (avvisi dai casi reali), v31 (testo grande, «indietro»), v30 (viaggio guidato), v28–v29 (memoria del server, orari dal CDN, MOSE),
v24–v27 (preferiti, pianificatore, percorsi a piedi reali, dati fissi dal CDN). Dettagli in `STATO.md` §5 e nella storia di Git.
