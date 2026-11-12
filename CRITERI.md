# Criteri permanenti per ogni aggiornamento della PWA

Valgono per **ogni** modifica, piccola o grande, senza bisogno di richiamarli. Prima di pubblicare, ogni cambiamento si valuta su tutti i punti.

## 1. Funzionalità prima di tutto
- Nessuna funzione esistente si perde o peggiora. In particolare gli **avvisi di arrivo** devono restare pronti e puntuali: dipendono dal server
  (feed letto di continuo, controllo ogni 15 s, notifica push), non dall'app aperta; nessun limite o blocco deve toccare `/api/watch/*`,
  il flusso dei mezzi o i file dell'app per gli utenti normali (anche molti dietro lo stesso IP).
- Se una contromisura può bloccare utenti normali, prima si segnala e si decide insieme.

## 2. Sicurezza
- Limiti per IP ed endpoint, 429 con `Retry-After`, blocco progressivo solo sulle richieste costose, tetto a richieste contemporanee e flussi SSE.
- Validazione rigorosa di ogni parametro (caratteri ammessi, lunghezze, intervalli); URL lunghi rifiutati; nessun accesso a file per percorso.
- Errori senza dettagli interni; nessuna credenziale nel codice; endpoint riservati chiusi da token (disattivati se il token manca).
- Non si considerano prove di «utente umano» user-agent, Referer, CORS o JavaScript del client: si falsificano. Un agente IA con la sessione
  dell'utente agisce come l'utente: le difese sono su costo e quantità, non sull'identità del client.
- CSP senza script esterni né in linea; dati da fonti esterne usati solo dopo il controllo dell'impronta.

## 3. Banda, carico di Render, CPU, memoria, batteria, traffico dati
- Solo dati cambiati (flusso a differenze), compressione, ETag/304, cache per richieste identiche, dati fissi sul telefono e dal CDN.
- Niente richieste duplicate o a raffica: riconnessioni con attesa crescente, richieste obsolete scartate.
- Pagina nascosta: niente flusso, polling, GPS, animazioni e timer non indispensabili; ripresa immediata al ritorno.
- Rispetto di «riduci movimento» e «risparmio dati»; attenzione a telefoni lenti e connessioni a consumo.
- Misure solo aggregate e temporanee (`/api/metriche`, in memoria): nessun registro delle singole richieste, nessun dato personale.

## 4. Interfaccia
- Desktop, tablet, smartphone; tema chiaro e scuro; testo ingrandito; orizzontale; tastiera aperta; aree sicure.
- Bersagli di tocco ≥ 44 px, nessuno scorrimento orizzontale, nessun elemento che si sovrappone o si sposta in modo inatteso.

## 5. Prove
- `npm test` e `tests/ui/run.py` (6 dimensioni di schermo) devono passare; ogni novità aggiunge le sue prove (casi normali, anomali, limiti).
