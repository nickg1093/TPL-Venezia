# Accesso responsabile ai dati meteomarini

Progetto indipendente: https://veneziatpl.onrender.com/about-data.html

- Identità dichiarata, HTTPS, una richiesta alla volta verso dati.venezia.it, intervallo minimo 10 s fra gli avvii per processo, priorità marea, cache ETag e Last-Modified, orari originali delle misure.
- 403/429: pausa comune, 5/10/20/30 minuti, estesa a quanto chiesto da Retry-After (anche in formato data HTTP); 503 con Retry-After: stessa protezione. Non riprovare con HTTP, proxy o browser mascherati.
- `CPSM_OPEN_DATA_ENABLED=false` disabilita l'accesso diretto al portale (in Render e, separatamente, nell'ambiente del workflow archivio-marea). ISPRA resta una fonte indipendente per il livello. Le previsioni ufficiali non vengono inventate.
- L'intervallo e le pause sono per processo: Render, Intranet-BIS e GitHub Actions non condividono ancora stato persistente o coda. Non aumentare istanze o frequenza. L'eventuale consolidamento va collaudato prima di renderlo un punto di guasto comune.
- Il robots.txt del portale dati.venezia.it non è stato accessibile durante la verifica. Non equivale ad autorizzazione. Il sito istituzionale www.comune.venezia.it ha indicazioni separate (Crawl-delay 10 e limitazioni sui percorsi dei file); non inferire da questo le regole del portale Open Data. Richiedere conferma al gestore e documentare eventuali condizioni prima di ampliare il traffico.
- Il riutilizzo è subordinato alle condizioni delle fonti. Attribuzione e modifica dei dati sono descritte nella pagina pubblica. Configurare APP_CONTACT per un recapito verificato; non inventare un contatto.

Riferimento ufficiale: https://www.comune.venezia.it/it/node/7429
