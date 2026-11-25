'use strict';
// ETICHETTE DEI PALI E DEI PONTILI, uguali a quelle della PWA: si usa public/js/zones.js così com'è (lettere «A», «B»…; corsie di Piazzale
// Roma «A1»…; numeri «1», «2» per pali con lo stesso nome in punti diversi, come San Marco Cattaneo 1 e 2). Nessuna regola duplicata.
const fs = require('fs');
const path = require('path');

let _mod = null, _chiave = null, _idx = null;
async function modulo(radice) {
  if (!_mod) {
    const src = fs.readFileSync(path.join(radice || path.join(__dirname, '..'), 'public/js/zones.js'), 'utf8');
    _mod = import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  }
  return _mod;
}
// stops: [[id, nome, lat, lon, src]] (come /api/stops) -> { etichetta(id), zona(id) -> { nome, src, etichette } }
async function crea(stops, chiave, radice) {
  if (_idx && _chiave === chiave) return _idx;
  let Z;
  try { Z = await modulo(radice); } catch { Z = null; }
  if (!Z) return (_idx = { etichetta: () => '', zona: () => null });
  Z.buildZones(stops);
  const lab = new Map(), zon = new Map();
  for (const z of Z.zones.values()) {
    const info = { nome: z.name, src: z.src, etichette: z.letters };
    for (const [id, l] of z.letterOf) { lab.set(id, l || ''); zon.set(id, info); }
  }
  Z.zones.clear(); Z.zoneOf.clear(); Z.snorm.clear();   // le mappe del modulo non servono più: restano solo le etichette
  _chiave = chiave;
  return (_idx = { etichetta: id => lab.get(id) || '', zona: id => zon.get(id) || null });
}
module.exports = { crea, _reset: () => { _mod = null; _chiave = null; _idx = null; } };
