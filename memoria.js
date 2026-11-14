// PROTEZIONE DELLA MEMORIA (piano gratuito di Render: 512 MB; oltre, la piattaforma chiude il processo senza preavviso).
// Ogni 5 s si misura la memoria del processo (RSS). Tre livelli:
//   ok       tutto normale;
//   alto     (MEM_ALTO_MB, 400) si libera ciò che si può ricostruire (orari di altre date, indici del pianificatore per altre date, cache)
//            e non si inizia nessun lavoro pesante nuovo: le richieste relative rispondono «occupato, riprova» (503 + Retry-After);
//   critico  (MEM_CRITICO_MB, 450) in più si rimandano anche i calcoli dei percorsi.
// Il servizio di OGGI (tempo reale, partenze, notifiche di arrivo) non viene mai toccato: è la funzione che deve restare sempre in piedi.
// Prima di un lavoro che occupa memoria (es. orari di un'altra data) si chiede libera(MB): sì solo se dopo resta sotto il livello «alto».
const MB = 1e6;
const ALTO = (+process.env.MEM_ALTO_MB || 400) * MB, CRITICO = (+process.env.MEM_CRITICO_MB || 450) * MB;
const azioni = [];
let livello = 'ok', picco = 0, eventi = 0;
const rss = () => process.memoryUsage.rss();
// raccolta della memoria liberata (solo se il processo è avviato con --expose-gc, come in package.json): al massimo ogni 30 s
let ultimaPulizia = 0;
const pulizia = () => { if (typeof global.gc === 'function' && Date.now() - ultimaPulizia > 30000) { ultimaPulizia = Date.now(); try { global.gc(); } catch { /* niente */ } } };
function misura() {
  const r = rss(), lv = r >= CRITICO ? 'critico' : r >= ALTO ? 'alto' : 'ok';
  if (r > picco) picco = r;
  if (lv !== livello) {
    console.log(`memoria: ${lv === 'ok' ? 'tornata normale' : `livello ${lv}`} (${Math.round(r / MB)} MB)${lv !== 'ok' ? ': libero le cache e rimando il lavoro pesante' : ''}`);
    if (lv !== 'ok') eventi++;
    livello = lv;
  }
  if (lv !== 'ok') {
    for (const f of azioni) { try { f(lv); } catch (e) { console.error('memoria: azione non riuscita', e.message); } }
    pulizia();
  }
  return lv;
}
const timer = setInterval(misura, 5000); timer.unref();
module.exports = {
  livello: () => livello,
  critico: () => misura() === 'critico',
  libera: (mb = 60) => misura() === 'ok' && rss() + mb * MB < ALTO,      // c'è spazio per un lavoro che occupa ~mb MB? (orari di un'altra data: ~50-60 MB)
  quando: fn => { azioni.push(fn); },                                    // da chiamare quando la memoria è alta (liberare cache ricostruibili)
  pulizia,
  stato: () => ({ rss_MB: Math.round(rss() / MB), picco_MB: Math.round(picco / MB), livello, eventi, soglie_MB: { alto: ALTO / MB, critico: CRITICO / MB } }),
  _misura: misura
};
