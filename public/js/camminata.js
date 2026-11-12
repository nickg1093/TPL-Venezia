// PERCORSI A PIEDI DEL PIANIFICATORE, calcolati sul telefono (pedoni.js) con la rete pedonale scaricata dal CDN (fissi.js).
// Se la rete non c'è (CDN irraggiungibile, browser senza verifica delle impronte, punto fuori zona) tutto funziona come prima:
// linea d'aria e stima del server.
//   distanze(punto, fermate)  metri a piedi verso le fermate vicine (entro 30 minuti a passo svelto), oppure null
//   percorso(a, b)            { m, pts } per disegnare un tratto a piedi lungo le strade, oppure null
import * as Fissi from './fissi.js';
import { createNet } from './pedoni.js';

export const LIMITE_M = 3000;                                   // 30 minuti a passo svelto (circa 6 km/h)
let net = null, netV = null, netP = null;

async function rete() {
  const m = await Fissi.manifest(), p = m?.pedoni, bases = Fissi.cdnBases(m);
  if (!p || !bases.length || typeof isSecureContext === 'undefined' || !isSecureContext || !globalThis.crypto?.subtle) return null;
  if (netV === p.v) return netP;
  netV = p.v;
  netP = (async () => {
    const txt = b => new TextDecoder().decode(b);
    const idx = JSON.parse(txt(await Fissi.getVerified('/__pedoni/i/' + p.v, p.indice, bases.map(b => `${b}/pedoni/i/${p.v}.json`))));
    if (!idx || idx.f !== 1 || typeof idx.t !== 'object' || !(idx.lat > 0) || !(idx.lon > 0)) throw new Error('indice della rete non valido');
    net = createNet({
      CL: idx.lat, CO: idx.lon,
      loadTile: async c => {
        const h = Object.hasOwn(idx.t, c) ? idx.t[c] : null; if (!/^[0-9a-f]{16}$/.test(h || '')) return null;   // fuori zona
        return JSON.parse(txt(await Fissi.getVerified('/__pedoni/m/' + h, h, bases.map(b => `${b}/pedoni/m/${h}.json`))));
      }
    });
    pulisci(idx, p.v);
    return net;
  })().catch(() => { netV = null; return null; });
  return netP;
}
// mattonelle e indici di versioni vecchie: tolti dal telefono (le mattonelle uguali restano: stesso nome)
async function pulisci(idx, v) {
  const c = await Fissi.openCache(); if (!c) return;
  const keep = new Set(Object.values(idx.t));
  try {
    for (const req of await c.keys()) {
      const p = new URL(req.url).pathname;
      if ((p.startsWith('/__pedoni/m/') && !keep.has(p.slice(12))) || (p.startsWith('/__pedoni/i/') && p.slice(12) !== v)) c.delete(req);
    }
  } catch { /* niente */ }
}
// attesa massima: oltre, si usa la linea d'aria (la rete intanto continua a caricarsi e servirà la volta dopo)
const entro = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

// enough: bastano le N fermate più vicine lungo le strade (il pianificatore ne usa 14): la ricerca si ferma lì
export async function distanze(da, fermate, enough = 14, ms = 4000) {
  return entro((async () => { const n = await rete(); return n ? n.distances(da, fermate, LIMITE_M, enough) : null; })().catch(() => null), ms);
}
export async function percorso(a, b, ms = 6000) {
  return entro((async () => { const n = await rete(); return n ? n.route(a, b, LIMITE_M + 500) : null; })().catch(() => null), ms);
}
