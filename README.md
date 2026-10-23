# ACTV live

Mappa 2D leggera dei mezzi ACTV in tempo reale (GTFS-Realtime).

## Avvio
    npm install
    npm start        # poi apri http://localhost:3000

Richiede Node 18+.

## Dati statici (GTFS)
Due servizi, ciascuno con il suo feed:

| Servizio | GTFS statico (in `data/`) | Realtime |
|---|---|---|
| Navigazione | `actv_nav.zip` | `tpl.actv.it/nav/GTFSRT/` |
| Automobilistico | `actv_aut.zip` | `tpl.actv.it/aut/GTFSRT/` |
| Alilaguna | `alilaguna.zip` | nessuno: solo orari (posizioni stimate) |

Al primo avvio il server scarica gli ZIP in `data/` e li rilegge ogni 24 ore. Se un download fallisce,
scaricalo a mano e salvalo con il nome indicato. I due servizi sono tenuti separati, quindi gli ID non si mescolano.

## Uso
- Clicca un mezzo: vedi linea, destinazione, prossima fermata, ritardo e il tracciato della linea.
- Scrivi il nome esatto di una linea nel filtro (es. `5.1`): vedi solo quei mezzi e il suo percorso.

## Modalità
- **Live**: posizioni e ritardi reali dal feed GTFS-RT.
- **Orario programmato**: posizioni teoriche calcolate da `stop_times.txt` e dai calendari (`calendar.txt`,
  `calendar_dates.txt`), seguendo il tracciato della linea. I marker hanno il bordo tratteggiato.

## Filtri e movimento
- I due pulsanti **Navigazione / Automobilistico** si possono attivare insieme o singolarmente (almeno uno resta attivo).
  Valgono per mezzi, fermate e tracciati, sia in Live sia in Orario programmato.
- I battelli sono pallini arrotondati, i bus rettangoli con angoli stondati.
- Tra un aggiornamento e il successivo i mezzi si spostano in modo fluido.

## Fermate e transiti
Dallo zoom 14 in su compaiono le fermate. Cliccane una: il pannello mostra i prossimi 90 minuti di passaggi.
- In modalità **Live** vedi l'orario previsto con i ritardi in tempo reale (e quello programmato tra parentesi),
  oppure "da orario" se per quella corsa non ci sono aggiornamenti. Segnala anche corse soppresse e fermate saltate.
- In modalità **Orario programmato** vedi solo gli orari da GTFS.
Il pulsante "Dove sono" centra la mappa sulla tua posizione (il browser la consente su `localhost` o HTTPS).

## Note
- Il server interroga ACTV ogni 15 secondi, indipendentemente dal numero di utenti.
- Controlla i termini d'uso dei dati open data ACTV prima di pubblicare l'app.

## Keep-alive su Render (piano gratuito)
Render addormenta il servizio dopo 15 minuti senza richieste in ingresso. Tre livelli, dal più affidabile:
1. **Pinger esterno (consigliato)**: UptimeRobot o cron-job.org, ogni 5 minuti su `https://veneziatpl.onrender.com/healthz`.
2. Workflow GitHub `keepalive.yml` (ogni 10 minuti, ma GitHub può ritardare i cron).
3. Auto-ping interno ogni 10 minuti (usa `RENDER_EXTERNAL_URL`, impostato da Render): tiene sveglio il server solo finché è già acceso.
Nota: il piano gratuito ha 750 ore/mese, sufficienti per un solo servizio sempre acceso.

## ID universali
`ids.js` collega corse e linee del realtime a quelle del GTFS statico per suffissi univoci, senza prefissi fissi:
un aggiornamento del file `actv_aut.zip` con codici diversi non rompe più il collegamento.

## Analisi dei feed realtime: /api/audit
Apri `https://<tuo-sito>/api/audit` (o `?src=aut`). Mostra, per ogni feed:
- `collegamentoGtfsStatico`: quante corse/veicoli del realtime trovano la corrispondenza nel GTFS statico (se "collegati" è molto più basso di "total", la versione del file in `data/` non è quella giusta);
- campi standard GTFS-RT compilati (con percentuale), campi standard mancanti e **campi proprietari ACTV** (con numero, tipo ed esempi);
- note di coerenza (età del feed, timestamp per veicolo, velocità dichiarata, `current_status` presente o no).
Intervallo di lettura: 3 s (variabile `RT_POLL_MS`); i feed invariati non vengono rielaborati e in caso di errori il server rallenta da solo.

## Aggiornamento a spinta (/api/stream)
Il server avvisa i browser collegati (Server-Sent Events) a ogni ciclo di lettura dei feed: mezzi e pannelli aperti si ricaricano subito
(al massimo ogni 600 ms). I timer del browser restano come rete di sicurezza e scattano solo se lo stream tace da oltre 6 secondi.

## Corse dopo mezzanotte
Le corse con orari 24:xx appartengono al giorno di servizio precedente. Lo stato del tracker porta con sé il proprio giorno (`dayOff`)
e `departures()` lo applica all'istanza corretta della corsa.
