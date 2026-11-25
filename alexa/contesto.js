'use strict';
// CONTESTO di una richiesta: come i gestori leggono i dati. Niente copie: `call` esegue le API già presenti nel server (in processo) o,
// nelle prove, un server vero via HTTP. L'indice dei luoghi si costruisce una volta per versione dei dati; le regole dell'acqua alta
// sono quelle del telefono (public/js/acqua.js, caricato così com'è) con i file delle quote e delle passerelle già nel repository.
const fs = require('fs');
const path = require('path');
const L = require('./luoghi');
const T = require('./tempo');
const Z = require('./zone');

const RADICE = path.join(__dirname, '..');
let _luoghi = null;   // { chiave, idx }
let _acqua = null;    // Promise

async function luoghiPer(env) {
  const stops = await env.stops(), routes = await env.routes();
  const chiave = `${env.versione ? env.versione() : ''}|${stops.length}|${Object.keys(routes).length}`;
  if (!_luoghi || _luoghi.chiave !== chiave) _luoghi = { chiave, idx: L.crea(stops, routes), routes, zone: await Z.crea(stops, chiave, env.radice) };
  return _luoghi;
}
// regole e dati dell'acqua alta: una sola lettura per processo (≈2 MB di griglia), solo stima (senza il rilievo a tessere)
function acqua(radice = RADICE) {
  if (!_acqua) _acqua = (async () => {
    const src = fs.readFileSync(path.join(radice, 'public/js/acqua.js'), 'utf8');
    const A = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
    const leggi = n => JSON.parse(fs.readFileSync(path.join(radice, 'public/acqua', n + '.json'), 'utf8'));
    return { A, Q: A.quoteDa(leggi('quote')), P: A.passerelleDa(leggi('passerelle')) };
  })().catch(() => null);
  return _acqua;
}
// env: { call(pathQuery) -> oggetto, stops() -> [[id,nome,lat,lon,src]], routes() -> {…}, versione?(), adesso?() }
async function crea(env) {
  const l = await luoghiPer(env);
  const adesso = env.adesso || Date.now;
  return { call: env.call, luoghi: l.idx, routes: l.routes, zone: l.zone, diretti: env.diretti || null, adesso, acqua: () => acqua(env.radice), T };
}
module.exports = { crea, acqua, _reset: () => { _luoghi = null; _acqua = null; Z._reset(); } };
