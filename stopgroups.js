// FERMATE EQUIVALENTI. Nel GTFS lo stesso palo può comparire con più codici (es. "A richiesta" e ordinaria, o due codici nello stesso punto):
// i passaggi di una fermata si cercano su tutti i codici che stanno entro 2 m con nome compatibile.
// Prima si scorreva l'intero elenco fermate a ogni richiesta; ora c'è una griglia spaziale costruita una volta per feed statico.
const { isNear } = require('./geo');

const CELL = 0.00004;                                   // ≈ 4,4 m in latitudine: più della distanza di raggruppamento (2 m)
const cellOf = v => Math.round(v / CELL);
const clean = n => String(n).toLowerCase().replace(/a\s*richiesta\w*/gi, '').replace(/[^\w\s]/g, '').trim();

function namesCompatible(n1, n2) {
  const a = clean(n1), b = clean(n2);
  if (a.includes(b) || b.includes(a)) return true;
  const ta = a.split(/\s+/).filter(w => w.length > 2), tb = b.split(/\s+/).filter(w => w.length > 2);
  return ta.some(t => tb.includes(t));
}

function grid(G) {
  if (G._grid) return G._grid;
  const m = new Map();
  for (const sid in G.stopLoc) {
    const [la, lo] = G.stopLoc[sid], k = cellOf(la) + ',' + cellOf(lo);
    let l = m.get(k); if (!l) m.set(k, l = []); l.push(sid);
  }
  return (G._grid = m);
}

// codici di fermata equivalenti a sid (sid compreso)
function equivalentStops(G, sid) {
  const loc = G.stopLoc[sid]; if (!loc) return [sid];
  const g = grid(G), cy = cellOf(loc[0]), cx = cellOf(loc[1]), name = G.stops[sid] || '', out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const o of g.get((cy + dy) + ',' + (cx + dx)) || []) {
      const l = G.stopLoc[o];
      if (isNear(loc[0], loc[1], l[0], l[1], 2) && namesCompatible(name, G.stops[o] || '')) out.push(o);
    }
  }
  return out.length ? out : [sid];
}
module.exports = { equivalentStops, namesCompatible };
