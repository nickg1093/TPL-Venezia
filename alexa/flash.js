'use strict';
// FLASH BRIEFING: feed JSON pubblico (sola lettura) per «Alexa, quali sono le mie notizie?»: avvisi di servizio in corso e marea.
// Formato: https://developer.amazon.com/en-US/docs/alexa/flashbriefing/flash-briefing-skill-api-feed-reference.html (testo semplice, niente SSML).
// Nessun dato personale. Risposta in memoria per 60 s (il feed è pubblico: un solo calcolo per minuto qualunque sia il numero di richieste).
const crypto = require('crypto');
const P = require('./parlato');
const Ctx = require('./contesto');
const S = require('./servizio');
const M = require('./marea');

let memo = null;
const testo = s => P.senzaTag(String(s)).slice(0, 4000);

async function costruisci(ambiente) {
  const adesso = (ambiente.adesso || Date.now)(), C = await Ctx.crea({ ...ambiente, adesso: ambiente.adesso || Date.now });
  const aggiornato = new Date(Math.floor(adesso / 60000) * 60000).toISOString().replace(/\.\d+Z$/, '.0Z');
  const voci = [];
  try { const a = await S.avvisi(C, { breve: true }); voci.push({ k: 'avvisi', t: 'Avvisi di servizio a Venezia', v: a.vuoto ? 'Non risultano avvisi di servizio in corso.' : a.voce }); } catch { /* senza avvisi: si salta */ }
  try { const m = await M.sintesi(C); voci.push({ k: 'marea', t: 'Marea a Venezia', v: m.voce }); } catch { /* senza marea: si salta */ }
  const out = voci.map(x => { const mainText = testo(x.v) + ' Servizio indipendente, non ufficiale A.C.T.V.'; return { uid: `urn:venezia-tpl:${x.k}:${crypto.createHash('sha1').update(mainText).digest('hex').slice(0, 12)}`, updateDate: aggiornato, titleText: x.t, mainText, redirectionUrl: 'https://veneziatpl.onrender.com' }; });
  return out.length ? out : [{ uid: 'urn:venezia-tpl:nd', updateDate: aggiornato, titleText: 'Venezia TPL', mainText: 'Al momento non riesco a leggere gli avvisi e la marea. Riprova più tardi.', redirectionUrl: 'https://veneziatpl.onrender.com' }];
}
async function feed(ambiente) {
  const ora = (ambiente.adesso || Date.now)();
  if (memo && ora - memo.t < 60e3) return memo.v;
  const v = await costruisci(ambiente);
  memo = { t: ora, v };
  return v;
}
module.exports = { feed, costruisci, _reset: () => { memo = null; } };
