# Skill Alexa «Venezia TPL»

Skill vocale (italiano, `it-IT`) per Alexa, **indipendente e non ufficiale** (non è di ACTV, AVM, Comune di Venezia, CPSM né Amazon).
Usa gli stessi dati, gli stessi motori (orari, tempo reale, RAPTOR, marea, avvisi) e le stesse regole della PWA «Venezia TPL live» v34:
non duplica GTFS, feed o archivi. Stato e decisioni: [`STATO.md`](STATO.md).

## 1. Cosa sa fare

| Dici | Risposta |
|---|---|
| «quando passa il due alle Zattere», «prossimo vaporetto da Rialto», «e il prossimo?» | prime tre partenze: destinazione, pontile, attesa, ora, ritardo; distingue tempo reale, stima, orario, dato vecchio, corsa soppressa |
| «il 5.2 è in ritardo?», «ultimo vaporetto da Rialto a Piazzale Roma», «prima corsa domattina da Lido», «che linee passano da Rialto?» | ritardo della linea; prima e ultima corsa cercate sull'intero GTFS della data (anche dopo mezzanotte, festivi, date esplicite) |
| «come arrivo a Rialto da Piazzale Roma», «devo arrivare a San Marco entro le nove», «senza cambi», «e al ritorno?», «e domani?» | percorsi con il motore RAPTOR della PWA: cambi, coincidenze strette, alternative, avvisi lungo la strada |
| «com'è la marea», «quando è il colmo», «ci sarà acqua alta stasera», «com'è il MOSE», «servono gli stivali a San Marco», «passerelle a Rialto» | livello, tendenza, picchi previsti, stato del MOSE, età del dato; misura, previsione e stima sempre distinte; le passerelle non sono mai date per posate |
| «com'è la visibilità in laguna», «c'è nebbia a San Servolo», «quanto vento c'è a San Giorgio», «da dove soffia il vento», «che temperatura c'è», «che tempo fa all'aeroporto», «e le raffiche?» | misure meteo (Centro Maree, vePORTO, METAR LIPZ) con ora di misura; mai previsioni |
| «ci sono avvisi», «sciopero domani», «avvisi sulla linea 1» | avvisi di servizio della PWA, con validità, linee, fermate, fasce di garanzia e limite di copertura |
| «riepilogo della mattina», «come sono i trasporti oggi» | avvisi + marea + meteo se rilevante (nebbia, vento forte) + partenze, in poche frasi (utilizzabile in una routine) |

Su Echo Show e simili compare anche una scheda (APL) adattata a schermo rotondo, piccolo, medio e grande; senza schermo la voce dice tutto.
Non fa: percorsi a piedi precisi o sicuri con l'acqua alta, geolocalizzazione, acquisti, account.

## 2. Come funziona (e perché così)

```
Alexa ──► Funzione Lambda (Alexa-hosted, gratuita) ──► POST https://veneziatpl.onrender.com/api/alexa ──► alexa/skill.js ──► API della PWA
          alexa/lambda/index.js: toglie ogni identificativo,   (token «Bearer» ALEXA_TOKEN)            (in processo, nessuna rete interna)
          gestisce Avvio/Aiuto/Stop anche a server spento
```

* **Alexa-hosted + ponte verso Render** invece di un endpoint HTTPS diretto: l'endpoint HTTPS diretto richiede un certificato e un indirizzo
  che Alexa verifichi e obbliga a controllare firma e certificato di ogni richiesta; il ponte Alexa-hosted è gratuito, **non richiede un
  account AWS né carte di credito**, la piattaforma verifica già firma, certificato e ID della skill, e la funzione toglie utente, dispositivo
  e sessione prima di inoltrare. Il server controlla comunque versione, orario (±150 s, anti-replay), ID della skill, lingua e token.
* **Nessuna modifica alla PWA né al Web Push**: il server ha solo l'ingresso `/api/alexa` (più `/api/alexa/flash`), spento senza `ALEXA_TOKEN`.
  Le richieste della skill passano dalla stessa protezione di CPU e memoria (`ambiente.occupato`): se il server è sotto pressione la skill
  risponde «riprova tra poco» e **lascia le risorse a mappa e notifiche**. Massimo 6 richieste contemporanee, 90 al minuto per indirizzo.
* **Privacy**: niente identificativi (la funzione li scarta), niente registri delle frasi dette, niente preferenze salvate. Il contesto del
  dialogo («e il prossimo?») vive solo negli attributi di sessione di Alexa. Informativa aggiornata in *Informazioni → Privacy* dell'app.
* **Costo**: 0 €. Alexa-hosted e Render gratuito; nessun servizio a pagamento, nessun modello linguistico in esecuzione.
* **Render gratuito si addormenta** dopo 15 minuti e si risveglia in 30–50 s, più degli ~8 s concessi da Alexa. Contromisure: all'apertura
  la funzione «sveglia» Render in anticipo; se non risponde entro 6,5 s Alexa dice «Il servizio non risponde ancora. Riprova tra poco» e «riprova» ripete la stessa domanda; per una skill usata spesso
  (o per la certificazione) conviene un controllo esterno gratuito su `/healthz` (vedi README principale §8).

## 3. Cosa devi fare tu (una tantum) — passo per passo

Non posso creare l'account Amazon né accedere con la tua password. Tutto il resto è pronto nel repository. Le schermate di Amazon cambiano
nel tempo: i nomi dei pulsanti sono quelli della documentazione ufficiale
([Create an Alexa-hosted skill](https://developer.amazon.com/en-US/docs/alexa/hosted-skills/alexa-hosted-skills-create.html)).

### Passo 0 — Pubblicare il codice sul server (solo dopo la tua approvazione)
Il ramo `feature/alexa` non è su `main` né su Render. Quando vuoi provarlo davvero: controlla le modifiche in GitHub Desktop, unisci il ramo
a `main` e lascia che Render faccia il deploy (come per ogni versione, vedi README §11). Fino ad allora la skill non può funzionare dal vivo.

### Passo 1 — Token segreto (PowerShell, non incollarlo in chat)
```powershell
$t = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'); $t; Set-Clipboard $t   # 64 caratteri casuali, copiati negli appunti
```
Render → servizio → *Environment* → **Add Environment Variable**: `ALEXA_TOKEN` = (Ctrl+V) → *Save* (il servizio riparte).
Tieni il valore: serve al Passo 5.

### Passo 2 — Account sviluppatore Amazon (gratuito)
1. Vai su <https://developer.amazon.com/alexa/console/ask> e accedi con **lo stesso account Amazon** dell'app Alexa (così la skill compare sui tuoi dispositivi).
2. Alla prima volta compila nome, paese (Italia) e accetta le condizioni. Non servono carta né account AWS.

### Passo 3 — Creare la skill
1. **Create Skill**. *Skill name*: `Venezia TPL`. *Default language*: Italiano (Italia). *Hosting region*: lascia il predefinito (Europa).
2. *Choose a model to add to your skill*: **Custom**. *Choose a method to host your skill's backend resources*: **Alexa-Hosted (Node.js)**.
3. **Create Skill** → scegli un modello qualsiasi (es. *Hello World*) → **Continue with template**. Dopo 1–2 minuti si apre la pagina **Build**.

### Passo 4 — Modello di interazione
1. **Build** → **Interaction Model** → **JSON Editor**. Apri sul PC `alexa\skill-package\interactionModels\custom\it-IT.json`, seleziona tutto, copia e incolla (o trascina il file).
2. **Save Model** → **Build Model**. Attendi «Full Build Successful».
   Se Amazon rifiuta il nome di invocazione `venezia t. p. l.`, cambialo nella scheda **Invocation** (alternative: `venezia trasporti`, `trasporti venezia`; vanno bene due-tre parole in minuscolo, niente cifre) e aggiorna di conseguenza gli esempi.
3. **Build** → **Interfaces** → attiva **Alexa Presentation Language** → **Save**. (Per le schede su Echo Show.)

### Passo 5 — Codice della funzione
1. Scheda **Code**. Nella cartella `lambda`:
   * sostituisci tutto il contenuto di `index.js` con quello di `alexa\lambda\index.js` (le frasi fisse sono già dentro: è l'unico file da copiare);
   * sostituisci `package.json` con `alexa\lambda\package.json`;
   * `segreto.js` resta quello già creato (indirizzo, token, ID della skill). La prima volta: tasto destro su `lambda` → *New file* → `segreto.js`, copiando `alexa\lambda\segreto.esempio.js`.
2. **Deploy**. Attendi «Deployment successful».
`segreto.js` resta nel deposito privato della tua skill su Amazon: **non** copiarlo nel repository (è in `.gitignore`).
3. (Consigliato) Su Render `ALEXA_SKILL_ID` = lo stesso ID: il server rifiuta richieste di altre skill.

### Passo 6 — Provare
1. Scheda **Test** → in alto scegli **Development** → scrivi o di' «apri venezia t. p. l.» (il simulatore parla italiano `it-IT`).
2. Prova: «quando passa il due alle Zattere», «com'è la marea», «ci sono avvisi», «come arrivo a Rialto da Piazzale Roma», «riepilogo della mattina», «e il prossimo?».
3. Sul dispositivo (Echo o app Alexa, stesso account): «Alexa, apri venezia t. p. l.». In *Test* con una prima richiesta lenta è normale sentire «il servizio non risponde ancora»: di' «riprova» dopo 30 secondi.
4. Se la prima volta risponde «problema di configurazione», il token di Render e quello di `segreto.js` non coincidono.

### Passo 7 — Routine (riepilogo ogni mattina)
App Alexa → **Altro** → **Routine** → **+** → *Quando*: ora (es. giorni feriali 7:30) → *Aggiungi azione* → **Personalizzato** (o *Alexa dice* → *Personalizzato*) →
`chiedi a venezia t. p. l. il riepilogo della mattina` → scegli il dispositivo → **Salva**. (L'API *Routines Kit* per le skill è dismessa: la routine si crea nell'app.)

### Passo 8 — Flash Briefing (facoltativo, è una skill separata)
Il Flash Briefing in italiano è ancora supportato ([documentazione](https://developer.amazon.com/en-US/docs/alexa/flashbriefing/understand-the-flash-briefing-skill-api.html)): console → **Create Skill** → tipo **Flash Briefing** →
*Content feed*: nome `Venezia TPL`, frequenza *Hourly*, tipo *Text*, formato *JSON*, indirizzo `https://veneziatpl.onrender.com/api/alexa/flash` → icona (`alexa\skill-package\assets\it-IT_largeIcon.png` 512×512). Il feed è pubblico e senza dati personali.
Limite: se Render dorme, Alexa può non ottenere il feed e saltare l'aggiornamento; funziona meglio con un controllo esterno su `/healthz`.

### Passo 9 — Pubblicare nello store (solo se vuoi; serve la tua decisione)
Con la skill funzionante in *Development* non serve altro per usarla tu. Per metterla nello store: scheda **Distribution** (testi pronti in
`alexa\skill-package\skill.json`: nome, riassunto, descrizione, frasi di esempio, categoria *Public transportation*, **solo Italia**, icone 108×108 e 512×512,
privacy: niente acquisti, niente dati personali, niente pubblicità, informativa `https://veneziatpl.onrender.com/privacy`, condizioni `https://veneziatpl.onrender.com/terms`) → **Certification** → *Submit for review*.
Prima della certificazione tieni il server sveglio (un avvio a freddo può far fallire il test). Non pubblicare senza aver letto i limiti qui sotto.

## 4. Manutenzione e recupero

| Situazione | Cosa fare |
|---|---|
| Cambiano fermate/linee (nuovo GTFS ACTV) | `node alexa/scripts/genera-modello.js https://veneziatpl.onrender.com` (da PowerShell, cartella del progetto), poi ripeti il Passo 4 con il nuovo `it-IT.json`. Le fermate nuove prima di questo passo non sono riconosciute a voce (le altre funzionano). |
| Cambiano le frasi fisse (benvenuto, aiuto, errori) | Modifica solo `alexa/messaggi.js`, poi `node alexa/scripts/prepara-lambda.js` (le copia nella Lambda), `node alexa/scripts/catalogo.js` (aggiorna il catalogo), `npm test`, deploy del server e Passo 5. |
| Cambiano le altre frasi o la logica | Modifica `alexa/*.js`, `node alexa/scripts/catalogo.js`, `npm test`, deploy del server. |
| Sospetti che il token sia trapelato | Nuovo token (Passo 1) su Render **e** in `segreto.js` (Deploy). |
| Spegnere subito la skill | Render → *Environment* → cancella `ALEXA_TOKEN` (o `ALEXA_SKILL_ID` sbagliato): `/api/alexa` risponde 404, la PWA non cambia. |
| «Il servizio non risponde ancora» a ogni richiesta | Render dorme: aspetta 30–50 s e riprova; considera il controllo esterno su `/healthz`. |
| Alexa dice «problema di configurazione» | token diverso tra Render e `segreto.js`. |
| Alexa dice «richiesta non valida» | `skillId` in `segreto.js` diverso da quello della skill. |
| Il modello non si compila | l'editor JSON mostra la riga: di solito un nome di invocazione non accettato; correggi e ricostruisci. |
| Disinstallare tutto | Console Alexa → elimina la skill; Render: cancella le variabili `ALEXA_*`; il resto del progetto non ne dipende (`alexa/` si può cancellare, `server.js` risponde 404 su `/api/alexa`). |

## 5. Prove

```powershell
npm test                                     # tutte le prove (le skill: tests/alexa-*.test.js)
node --test tests/alexa-dialogo.test.js      # motore delle corse, direzione, singolare/plurale, seguiti, prima/ultima corsa, 409 e riprova, aiuto
node --test tests/alexa-skill.test.js        # marea +105/+120 cm, MOSE, scioperi, sicurezza, SSML, APL
node --test tests/alexa-modello.test.js      # modello di interazione e manifesto
node --test tests/alexa-lambda.test.js       # funzione Lambda con server finto: privacy, timeout, 401/503
node --test tests/alexa-server.test.js       # server vero (GTFS veri, feed simulato): sicurezza, confronto con ricerca indipendente sui GTFS, latenza, memoria
node --test tests/alexa-unita.test.js        # date/ore (ora legale, cambio giorno), numeri e nomi parlati, flash briefing
```
Prova a mano contro il server locale (feed simulato): vedi `tests/alexa-server.test.js` per la forma della richiesta.

## 6. Limiti reali (da conoscere)

* **Nessun dispositivo Alexa disponibile durante lo sviluppo**: le prove usano richieste Alexa simulate. La pronuncia vera (nomi veneziani, «t. p. l.», numeri di linea come «cinque punto uno»), il riconoscimento delle fermate (1328 valori) e il comportamento di Render al primo risveglio vanno verificati da te nel simulatore e su un Echo.
* **Modello di grandi dimensioni** (~300 kB, 1328 fermate, 109 linee): rientra nei limiti noti di Amazon, ma la compilazione va confermata nella console. Se fosse rifiutato, si riduce l'elenco delle fermate (`genera-modello.js`).
* **Intent «Ripeti», «Prossimo», «Sì», «No»** sono definiti come intent propri e mappati a quelli standard: i built-in italiani non sono stati verificati nella documentazione.
* **Quote misurate delle calli (RAMSES)** non sono usate: la skill parla solo delle quote stimate pubbliche e non dice mai che un percorso è «a prova di acqua alta».
* **Tutti gli utenti condividono l'indirizzo della funzione Lambda**: il limite di 90 richieste al minuto è per tutta la skill, non per persona. Va bene per uso personale; per un uso pubblico va rivisto.
* **Flash Briefing e routine** dipendono dall'app/console Amazon (schermate soggette a cambiamenti) e, per il feed, dal risveglio di Render.
* Dati e limiti sono quelli della PWA: informazioni indicative, fanno fede le comunicazioni ufficiali di ACTV e del Comune di Venezia.
