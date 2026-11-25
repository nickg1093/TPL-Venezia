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
  const ora = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(new Date(adesso)));
  parti.push(ric.momento === 'mattina' ? 'Ecco il riepilogo della mattina.' : ora >= 18 || ora < 5 ? 'Ecco il riepilogo.' : 'Ecco il riepilogo di oggi.');
  // 1) avvisi di servizio
  const av = await S.avvisi(C, { breve: true });
  if (av.vuoto) { parti.push('Non risultano avvisi di servizio in corso o nei prossimi giorni.'); righe.push({ badge: 'OK', colore: '#2E7D6B', testo: 'Nessun avviso di servizio', dett: '', ora: '', attesa: '', stato: 'ok' }); }
  else { parti.push(av.voce); righe.push(...av.scheda.righe.slice(0, 2)); if (av.n > 2) parti.push(`Gli avvisi sono ${P.parole(av.n)} in tutto: chiedimi gli avvisi per sentirli.`); }
  // 2) marea
  try { const m = await M.sintesi(C); parti.push(m.voce); righe.push(m.riga); }
  catch (e) { parti.push(P.esc('Non riesco a leggere la marea in questo momento.')); }
  // 3) una fermata, se richiesta
  let ctx = { tipo: 'riepilogo' };
  if (ric.gruppo) { const p = await D.partenze(C, { gruppo: ric.gruppo, n: 2 }); parti.push(p.voce); ctx = p.ctx; if (p.scheda && p.scheda.righe) righe.push(...p.scheda.righe.slice(0, 2)); }
  return { voce: parti.join(' '), scheda: { titolo: 'Riepilogo', sottotitolo: new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(adesso)), righe, nota: '', fonte: 'ACTV (avvisi) · Centro Maree Venezia · servizio indipendente, non ufficiale' }, ctx, fine: false };
}
module.exports = { riepilogo };
