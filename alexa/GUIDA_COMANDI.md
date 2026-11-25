# Venezia TPL per Alexa — guida ai comandi

Skill **indipendente e non ufficiale** (non è di ACTV, AVM, Comune di Venezia né Amazon). Si apre con «Alexa, apri venezia t. p. l.» e
risponde «Ciao! Cosa vuoi sapere?». Si può anche chiedere direttamente: «Alexa, chiedi a venezia t. p. l. quando passa il due alle Zattere».
Dopo ogni risposta il microfono resta aperto qualche secondo per i seguiti («e quello dopo?»). La versione breve di questa guida è nell'app,
in *Informazioni → Skill Alexa*. Tra parentesi l'intento del modello `it-IT` (per la manutenzione).

## Partenze (`ProssimaCorsaIntent`, `PartenzeIntent`)
Una domanda al singolare dà **una** corsa; al plurale **tre**; un numero detto («i prossimi due») viene rispettato (al massimo sei a voce).

| Esempi | Note |
|---|---|
| quando passa il due alle Zattere? · tra quanto passa il prossimo tram a San Marco Cattaneo in direzione Venezia? · prossimo autobus da Mestre per Venezia | mezzo distinto per tipo GTFS: vaporetto, autobus, tram |
| prossime partenze da Rialto · i prossimi tre vaporetti da Rialto per Piazzale Roma · cosa passa a San Zaccaria | «per/verso» = la corsa deve passare dopo dalla destinazione (sequenza delle fermate) |
| partenze da Zattere domani alle diciotto · orari del due domani da Rialto | orari programmati dell'intero GTFS della data |
| Rialto pontile C · San Marco Cattaneo uno | il pontile o il numero restringono la fermata |
| quanto devo aspettare il tram per Venezia? · quando ho il prossimo tram da Cattaneo? · fra quanto passa il T1? | attesa = prossima corsa; un nome detto in parte («Cattaneo») si sceglie con il mezzo o la linea, altrimenti la skill chiede quale |
| il tram uno è in ritardo? · «ti uno», «t uno», «t. one» | le trascrizioni del riconoscimento vocale sono ricondotte alla linea che esiste (T1) |

Stati detti: in fermata, ritardo, anticipo, in orario (solo con tempo reale), stima non aggiornata, orario programmato, corsa soppressa,
fermata saltata, fermata sospesa da un avviso. Mai «in orario» senza dati in tempo reale.

## Frequenza (`FrequenzaIntent`)
| Esempi | Note |
|---|---|
| ogni quanto passa il T1 a San Marco Cattaneo? · ogni quanti minuti passa il tram verso Venezia? · quanto spesso passano i vaporetti dal Lido? | intervalli reali tra le partenze programmate: prossime due ore, due ore dall'ora detta, tre ore per una fascia («domani mattina») |
| ogni quanto passa? (dopo una risposta) · e domani mattina alle sette? | stessa fermata, linea e direzione della risposta precedente |

Intervalli regolari: «ogni dieci minuti». Variabili: «di solito ogni dodici minuti, con intervalli da otto a venti minuti»; con poche corse:
«a intervalli irregolari». Con una sola corsa lo dice. Mai una frequenza inventata.

## Meteo (`MeteoIntent`, `MeteoSeguitoIntent`, `MeteoDirezioneIntent`, `MeteoConfrontoIntent`, `MeteoRecenteIntent`)
| Esempi | Note |
|---|---|
| com'è la visibilità in laguna? · c'è nebbia a San Servolo? · quanti metri di visibilità ci sono a Sant'Andrea? | visibilimetri vePORTO; senza di loro, l'aeroporto detto come tale. Nebbia sotto 1 km, ridotta fino a 5 km |
| quanto vento c'è a Venezia? · da dove soffia il vento? · a quanto arrivano le raffiche? · dove soffia più forte? · quanto vento c'è a San Giorgio? | Centro Maree; direzione di provenienza per esteso (Nord-Nord-Est…); confronti solo tra misure fresche e vicine nel tempo |
| che temperatura c'è fuori? · quanto è calda l'acqua della laguna? · qual è l'umidità? · com'è la pressione atmosferica? | Palazzo Cavalli, San Giorgio, Punta della Salute; aeroporto se chiesto |
| che tempo fa all'aeroporto Marco Polo? · quali sono le condizioni meteo in laguna? · qual è il dato più recente? | METAR: fenomeni, visibilità, vento, temperatura, umidità calcolata, pressione QNH |
| e le raffiche? · e a Marittima? · e la temperatura? | seguiti: cambia solo ciò che si dice |

Solo misure, mai previsioni. Una misura vecchia si dice con la sua ora («non è aggiornata»); senza dati: «non ho misure recenti», mai
«tutto normale». Nel riepilogo il meteo compare solo con nebbia o vento forte (raffiche da 50 km/h o media da 35 km/h).

## Prima e ultima corsa, linee (`UltimaCorsaIntent`, `PrimaCorsaIntent`, `LineeIntent`)
| Esempi | Note |
|---|---|
| qual è l'ultimo vaporetto da Rialto a Piazzale Roma? · ultimo tram da San Marco Cattaneo verso Venezia · fino a che ora passa il T1? · e l'ultimo della sera? | intera giornata di servizio, anche dopo mezzanotte («nella notte tra … e …»); l'ultima corsa è quella delle linee diurne, le notturne (N…) sono citate a parte |
| ultimo vaporetto domani da Rialto a Piazzale Roma · ultima corsa lunedì da Lido | date, giorni della settimana, festivi (calendario GTFS) |
| prima corsa domattina da Lido · primo vaporetto domani da Rialto a Piazzale Roma · prima corsa dopo le sei da Zattere | |
| che linee passano da Rialto? | linee con corse oggi |

Se non c'è un collegamento diretto, la skill propone un percorso con cambi («sì» lo calcola).

## Percorsi (`ItinerarioIntent`, `ItinerarioEntroIntent`)
| Esempi | Note |
|---|---|
| come arrivo a Rialto da Piazzale Roma? · da Zattere a San Marco domani alle otto | risposta breve: linea, ora, pontile o fermata di salita, cambi essenziali, arrivo |
| devo essere a San Marco entro le nove partendo dalle Zattere · a che ora devo partire da San Marco Cattaneo per arrivare alle Zattere alle otto di stasera? | con il margine; prima le soluzioni con cambi sicuri, poi quelle con più tempo per il cambio |
| quanto ci metto da Rialto al Lido? · quanto ci vuole da Piazzale Roma a Murano? | `DurataIntent`: la durata per prima, poi il percorso |
| posso partire più tardi? · e più tardi? | soluzione successiva, poi le partenze successive dello stesso percorso |
| come arrivo a Lido con meno cambi · in vaporetto · con al massimo un cambio | preferenze del pianificatore della PWA |

Avvisa sempre di coincidenze a rischio o perse, corse soppresse, avvisi sulle linee e possibile acqua alta sui tratti a piedi. I tratti a
piedi sono stime in linea d'aria del server: per il percorso a piedi reale usare l'app.

## Marea, MOSE, acqua alta (`MareaIntent`, `ColmoIntent`, `MinimoIntent`, `AcquaAltaIntent`, `MoseIntent`, `StivaliIntent`, `PasserelleIntent`)
com'è la marea? · quando è il colmo? · e il minimo? · ci sarà acqua alta stasera / domani mattina? · il MOSE è alzato? ·
servono gli stivali a San Marco? · ci sono le passerelle alle Zattere?

Distingue misura, previsione (del Centro Maree, senza MOSE) e stima delle quote; non conferma mai che le passerelle siano posate né che una
calle sia asciutta.

## Avvisi e scioperi (`AvvisiIntent`, `ScioperoIntent`)
ci sono avvisi? · ci sono problemi sulla linea uno? · ci sono avvisi a Rialto? · ci sono scioperi domani? · quali sono le fasce garantite? ·
poi «e per i vaporetti?» o «dimmi i dettagli». Copre gli avvisi in corso e dei prossimi tre giorni; l'assenza di avvisi non garantisce il servizio regolare.

## Riepilogo e routine (`RiepilogoIntent`)
riepilogo della mattina · come sono i trasporti oggi? · riepilogo della mattina da San Marco Cattaneo verso Venezia (con il tram).
Risponde e chiude la conversazione: adatto alle **routine** dell'app Alexa (azione *Personalizzato*: «chiedi a venezia t. p. l. il riepilogo
della mattina da …»). Senza fermata dà marea e avvisi; non inventa fermate.

## Seguiti (cambiano solo ciò che si dice)
| Frase | Effetto |
|---|---|
| e quello dopo? · e il successivo? (`ProssimoIntent`) | la corsa dopo l'ultima detta (per identità della corsa, senza ripetere né saltare) |
| altre corse · dimmene altre tre (`AltreCorseIntent`) | altre corse dello stesso elenco |
| e domani? · e alle sette? · e domani alle sette? (`DomaniIntent`) | stessa richiesta, altro giorno o ora |
| no, verso Venezia · solo vaporetti · con il due · no, intendevo Rialto (`CorrezioneIntent`) | cambia direzione, mezzo, linea o fermata |
| e nell'altra direzione? (`AltraDirezioneIntent`) | stessa fermata, senso opposto |
| e l'ultimo? · e il primo? | prima/ultima corsa con fermata, direzione e filtri della domanda precedente |
| e al ritorno? (`RitornoIntent`) · senza cambi (`SenzaCambiIntent`) · un'alternativa (`AlternativaIntent`) | percorsi |
| dimmi i dettagli (`DettagliIntent`) | tappe del percorso, altre corse, avvisi completi |
| ripeti (`RipetiIntent`) · aggiorna (`AggiornaIntent`) · riprova (`RiprovaIntent`) · sì / no | ripete (segnala se è un dato di prima), ricalcola con i dati attuali, ripete una richiesta non riuscita |

## Guida e chiusura
aiuto · che cosa posso chiederti? · aiuto partenze / percorsi / marea / avvisi / riepilogo (`AiutoIntent`) · presentati · che cos'è venezia t. p. l.? (`PresentatiIntent`) ·
tutti i comandi (`TuttiComandiIntent`) · basta / annulla / stop. Funzionano anche quando il server non risponde.

## Cosa la skill non fa
Navigazione passo passo, percorsi pedonali precisi o a prova di acqua alta, preferiti salvati, notifiche vocali, acquisti, account. In questi
casi risponde che la funzione è disponibile nell'app ma non a voce.
