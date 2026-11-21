# Novità di Venezia TPL live

Riepilogo per versione delle modifiche che contano per chi usa o mantiene l'app. I dettagli tecnici sono in `README.md` §12; lo storico per
gli utenti è nell'app (Informazioni → Novità, generato da `public/js/guida.js`).

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
