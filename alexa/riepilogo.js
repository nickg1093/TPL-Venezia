'use strict';
// RIEPILOGO («riepilogo della mattina», «come sono i trasporti oggi»): avvisi in corso + marea in due frasi. Nessun dato personale: niente
// «fermate preferite» salvate; se si nomina una fermata, si aggiungono le sue prossime partenze.
const P = require('./parlato');
const U = require('./util');
const S = require('./servizio');
const M = require('./marea');
const D = require('./partenze');

async function riepilogo(C, ric = {}) {
  const adesso = C.adesso(), parti = [], righe = [];
  let ctx = { tipo: 'riepilogo' };
  // 1) la fermata detta (routine «riepilogo da San Marco Cattaneo verso Venezia»): la prossima corsa, per prima
  if (ric.gruppo) {
    try { const p = await D.partenze(C, { gruppo: ric.gruppo, mezzo: ric.mezzo || null, dir: ric.dir || null, n: 1 }); parti.push(p.voce); ctx = p.ctx || ctx; if (p.scheda && p.scheda.righe) righe.push(...p.scheda.righe.slice(0, 1)); }
    catch (e) { parti.push(P.esc(`Non riesco a leggere le partenze da ${ric.gruppo.parlato}.`)); }
  }
  // 2) marea
  try { const m = await M.sintesi(C); parti.push(m.voce); righe.push(m.riga); }
  catch (e) { parti.push(P.esc('Non riesco a leggere la marea in questo momento.')); }
  // 3) avvisi di servizio
  const av = await S.avvisi(C, { breve: true });
  if (av.vuoto) { parti.push(P.esc('Non risultano avvisi di servizio, nei dati disponibili.')); righe.push({ badge: 'OK', colore: '#2E7D6B', testo: 'Nessun avviso di servizio', dett: '', ora: '', attesa: '', stato: 'ok' }); }
  else { parti.push(av.voce); righe.push(...av.scheda.righe.slice(0, 2)); }
  return { voce: parti.join(' '), scheda: { titolo: 'Riepilogo', sottotitolo: new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(adesso)), righe, nota: '', fonte: 'ACTV (orari e avvisi) · Centro Maree Venezia · servizio indipendente, non ufficiale' }, ctx, fine: true };
}
module.exports = { riepilogo };
