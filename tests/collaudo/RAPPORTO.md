# Audit funzionale v34 — rapporto di lavoro (aggiornato progressivamente)

Base: v33.13 (`c76ea34`) + correzione `dati.yml` (non pubblicata). Ramo locale `audit-v34`. Ambiente: server di prova con feed simulato
(`tests/fakefeed.js`), Chromium headless (Playwright 1.63), rete pedonale e dati del ramo `dati` copiati in locale. Nessun push, nessun deploy.

## 1. Problemi trovati

| # | Gravità | Area | Problema | Causa | Correzione | Prova |
|---|---|---|---|---|---|---|
| 1 | Media | Preferiti, ripristino | Con memoria piena il ripristino cambiava l'elenco in uso ma non la memoria (stato incoerente, una sola delle due chiavi scritta) | `importData` modificava gli elenchi prima di salvare | Preparazione a parte, scrittura insieme, ritorno allo stato precedente se fallisce | `tests/preferiti-copia.test.js` |
| 2 | Bassa | Preferiti, ripristino | Conteggio «ripristinati» falso oltre i 100/30 elementi; chiavi non valide accettate (`stop:` vuoto, spazi, `<>`); nomi vuoti o con caratteri di controllo | controllo solo del prefisso | Formato della chiave controllato, nomi ripuliti, conteggio delle voci davvero aggiunte | idem |
| 3 | Bassa | Preferiti, ripristino | File non JSON: messaggio tecnico in inglese («Unexpected token…») | errore di `JSON.parse` mostrato com'era | Messaggio comprensibile, «i preferiti presenti non sono cambiati» | idem / `tests/ui/copertura.py` |
| 4 | Bassa | Preferiti, copia | `exportData` restituiva gli elenchi interni (modificabili da fuori) | riferimento invece di copia | Copia | idem |

## 2. Misure

Prima (v33.13, `tests/ui/prestazioni.py`, 90 s, telefono 390×844, Leaflet vero, feed simulato): `tests/collaudo/prestazioni-prima.json`.
