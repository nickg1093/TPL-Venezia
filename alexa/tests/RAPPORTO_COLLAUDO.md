# Rapporto di collaudo — skill Alexa «Venezia TPL» (revisione 3, 25/11/2026)

## Dove sono state fatte le prove
| Ambiente | Versione | Cosa |
|---|---|---|
| Simulatore Amazon (Development) + Skill I/O | **pubblicata**: GitHub `main` b570735, modello importato dall'utente | ~45 domande spontanee e 3 conversazioni; intento, slot e risoluzione letti dal JSON di ingresso |
| Server locale con i GTFS ACTV veri (senza tempo reale, rete esterna chiusa) | **aggiornata** (questa cartella) | ~45 richieste e 6 conversazioni con la risoluzione delle entità simulata dal modello (`/tmp/ask2.js` → `tests/alexa-dialogo.test.js`) |
| `npm test` (node --test) | aggiornata | 417 prove, tutte superate |

**Non verificato** sulla versione aggiornata: comprensione (NLU) di Amazon con il nuovo modello, Utterance Profiler, latenze reali su
Render, Echo Show, pronuncia ascoltata. Il campione inedito (`alexa/tests/frasi-inedite.json`, 34 frasi non presenti nel modello) va eseguito
nel simulatore dopo l'importazione del modello con `alexa/tests/collaudo-simulatore.js`. L'obiettivo del 98% non è quindi ancora misurato.

## Difetti trovati nel simulatore (versione pubblicata) e correzione
| # | Domanda | Risposta pubblicata | Causa | Correzione (versione aggiornata) |
|---|---|---|---|---|
| 1 | ogni quanto passa il T1 / ogni quanti minuti passa il tram a San Marco Cattaneo | «Non ho capito» (Fallback) | nessun intento di frequenza | `FrequenzaIntent` + `partenze.frequenza`: intervalli reali degli orari programmati, per linea e capolinea |
| 2 | quanto devo aspettare il tram per Venezia | Fallback | attesa non modellata | esempi di attesa in `ProssimaCorsaIntent` (attesa = prossima corsa) |
| 3 | quando ho il prossimo tram da Cattaneo | «Non risultano tram da Vespucci Cattaneo» | Alexa mette per primo un valore qualsiasi tra più fermate | nome parziale: si sceglie tra i valori di Alexa la fermata servita dal mezzo o dalla linea (orari GTFS di oggi), altrimenti si chiede quale |
| 4 | il tram uno è in ritardo | «Di quale linea o fermata?» (linea nello slot del mezzo) | «tram 1» finito in `mezzo` | linea estratta anche dallo slot del mezzo; varianti «ti uno», «t uno», «t. one», «tram uno» come sinonimi e in `parseLinea`; si tiene solo una linea esistente |
| 5 | ogni quanti minuti passa linea t. one | Fallback | trascrizione inglese | come 1 e 4 |
| 6 | quanto ci metto da Rialto al Lido | partenze da Rialto (slot fuso «rialto al lido») | durata non modellata | `DurataIntent`: «Ci vogliono circa …», poi il percorso; divisione degli slot fusi già attiva |
| 7 | a che ora devo partire da San Marco Cattaneo per arrivare alle Zattere alle 20 | soluzione con cambio di 1 minuto; cambi non detti | prima soluzione del pianificatore | «arrivo entro»: prima le soluzioni senza cambi a rischio, poi quelle con più tempo per il cambio; i cambi sono detti |
| 8 | ultima corsa → «nell'altra direzione» | due direzioni insieme | l'altra direzione non era gestita per prima/ultima | si esclude il capolinea appena detto |
| 9 | percorso Rialto → Piazzale Roma con la linea 2 | «la linea due» senza verso | circolare | linea con capolinea («la linea due per San Marco, San Zaccaria»); salita in altra fermata con i minuti a piedi |
| 10 | «posso partire più tardi?» dopo un percorso | «Non ho altre soluzioni» | partenze successive non usate | si propongono le partenze successive dello stesso percorso |

Difetti già corretti nella revisione precedente (verificati sulla versione pubblicata il 25/11 alle 18:00 circa, ora risolti online): tram
«verso Venezia» nella direzione opposta, slot fusi «mestre per venezia», ultima corsa = linea N delle 4:34, «dopo le sei» detto alle 17,
seguiti sulla stessa direzione.

## Confronto con i dati
- Frequenza T1 a San Marco Cattaneo (25/11, 18:45–20:45): ogni 10 minuti in entrambe le direzioni dai GTFS; la PWA mostra le stesse partenze.
- Ultima corsa Rialto → Piazzale Roma: confrontata con una ricerca indipendente sui GTFS (`tests/alexa-gtfs-reale.js`) per oggi, domani e
  un giorno con eccezioni di calendario.
- Arrivo entro le 20 da San Marco Cattaneo alle Zattere: le tre soluzioni del pianificatore (stesso RAPTOR della PWA) hanno tutte un cambio di
  1–2 minuti; la skill ora propone quella con più margine (T1 18:55 + linea 6, arrivo 19:33) e lo segnala.

## Limiti residui
- Una domanda secca con «chiedi a venezia t. p. l. come arrivo…» può essere presa dal navigatore di Alexa: aprire prima la skill.
- Il nome di invocazione con le iniziali («t. p. l.») è poco naturale da dire; cambiarlo richiede una nuova certificazione in caso di pubblicazione.
- Frequenza e durata usano gli orari programmati (la durata quella del pianificatore, con il tempo reale se disponibile).
- Tratti a piedi stimati in linea d'aria dal server, come nella PWA.

## Come ripetere il collaudo
1. `npm test` (prove deterministiche, dati inventati e GTFS veri in `data/gtfs`).
2. Simulatore: aprire Test → Alexa Simulator, attivare Skill I/O, incollare `alexa/tests/collaudo-simulatore.js` nella console del browser,
   poi `await collaudoInedite(<contenuto di frasi-inedite.json>)`: stampa intento, slot, risposta e la percentuale di comprensione.
