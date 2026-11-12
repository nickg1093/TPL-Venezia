# Sicurezza

## Come segnalare una vulnerabilità

Se trovi un problema di sicurezza in Venezia TPL live (sito <https://veneziatpl.onrender.com> o codice di questo repository):

- usa la segnalazione privata di GitHub: scheda **Security → Report a vulnerability** di questo repository, oppure
- scrivi al contatto indicato nella pagina **Informazioni** dell'app.

Descrivi il problema, come riprodurlo e, se possibile, l'impatto. Non renderlo pubblico prima che sia corretto (divulgazione responsabile):
riceverai una risposta appena possibile.

## Versioni supportate

Solo la versione pubblicata su `main` (quella in produzione) riceve correzioni.

## Ambito

Il servizio non ha account né database e non conserva dati personali oltre a quanto descritto nell'informativa privacy dell'app
(IP per circa 60 secondi per i limiti di frequenza; iscrizioni alle notifiche al massimo 3 ore). Le misure di protezione sono descritte nel
README, appendice C.

Dati scaricati da fuori dal sito (v25): fermate, linee, tracciati e rete pedonale arrivano anche dal CDN jsDelivr e da raw.githubusercontent.com
(ramo `dati` di questo repository). Sono **solo dati** (JSON, mai script: `script-src 'self'`) e il telefono li usa solo se l'impronta SHA-256
coincide con quella pubblicata dal server (`/api/fissi`). Una segnalazione su questa catena (ramo `dati`, workflow `dati.yml`, verifica delle
impronte in `public/js/fissi.js`) rientra nell'ambito.
