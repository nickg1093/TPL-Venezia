// ID UNIVERSALI: collega gli ID del feed realtime a quelli del GTFS statico,
// qualunque prefisso/versione usi ACTV (AUT_ACTV_791_, AUT_ACTV_793_, ...) e in futuro anche altri formati.
// Principio: nessun prefisso scritto a mano. Si confrontano i SUFFISSI dei segmenti separati da "_",
// dal più lungo al più corto, accettando solo corrispondenze UNIVOCHE.

const SEP = /[_:|\-.]/;

// "AUT_ACTV_791_44025" -> ["AUT_ACTV_791_44025","ACTV_791_44025","791_44025","44025"]
function suffixes(id) {
  const s = String(id ?? '').trim();
  if (!s) return [];
  const out = [s];
  for (let i = 0; i < s.length; i++) if (SEP.test(s[i]) && i + 1 < s.length) out.push(s.slice(i + 1));
  return out;
}

// Costruisce una mappa suffisso -> id statico (null se il suffisso è ambiguo).
function buildIndex(ids) {
  const map = new Map();
  for (const id of ids) {
    for (const k of suffixes(id)) {
      const cur = map.get(k);
      if (cur === undefined) map.set(k, id);
      else if (cur !== id) map.set(k, null); // ambiguo: mai usato per risolvere
    }
  }
  return map;
}

// Risolve un id del realtime in un id statico. Ritorna null se non c'è corrispondenza univoca.
function resolve(index, exactSet, rtId) {
  if (rtId == null || rtId === '') return null;
  const s = String(rtId).trim();
  if (exactSet.has(s)) return s;
  for (const k of suffixes(s)) {
    const hit = index.get(k);
    if (hit) return hit;
  }
  return null;
}

// Indice per le corse e per le linee di un feed statico G.
function attach(G) {
  const tripIds = Object.keys(G.trips);
  G.idx = {
    tripSet: new Set(tripIds), trip: buildIndex(tripIds),
    routeSet: new Set(Object.keys(G.routes)), route: buildIndex(Object.keys(G.routes)),
    routeByName: new Map()
  };
  for (const rid in G.routes) {
    const n = String(G.routes[rid].name).trim().toLowerCase();
    G.idx.routeByName.set(n, G.idx.routeByName.has(n) ? null : rid);
  }
}

const resolveTripId = (G, id) => resolve(G.idx.trip, G.idx.tripSet, id);
function resolveRouteId(G, id, shortName) {
  const r = resolve(G.idx.route, G.idx.routeSet, id);
  if (r) return r;
  return shortName ? (G.idx.routeByName.get(String(shortName).trim().toLowerCase()) || null) : null;
}

module.exports = { attach, resolveTripId, resolveRouteId, suffixes, buildIndex, resolve };
