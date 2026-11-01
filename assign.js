// CORSA DEL MEZZO: si segue ACTV.
// Debug del 1° novembre 2026 (1h35 di feed ACTV e sito registrati insieme): le corse "riconosciute" dal GPS al posto di quella dichiarata
// sbagliavano proprio nei casi difficili (tram fermi per un blocco, mezzi in coda al capolinea, binari delle due direzioni sulla stessa strada:
// corse di altri mezzi, perfino in direzione opposta) e, togliendo il mezzo alla sua corsa, la facevano avanzare "da orario" mentre il mezzo
// vero era indietro (29 corse, ~150 passaggi segnati in anticipo). ACTV non pubblica i turni macchina (block_id vuoto): nessun algoritmo può
// sapere con certezza quale corsa fa un mezzo. Regole, ricalcolate a ogni lettura e senza decisioni permanenti:
//   1. la corsa è quella della posizione del mezzo (vehicle position);
//   2. se la previsione ACTV (trip update) attribuisce lo STESSO mezzo a un'altra corsa per 2 rilevamenti nuovi di fila, vale quella;
//   3. un solo caso è chiaramente impossibile e si stacca: mezzo FERMO al capolinea di partenza della sua corsa da oltre 5 minuti, oltre 40
//      minuti dopo l'orario di partenza (es. bus fermo un'ora e mezza con la corsa delle 15:35, ritardo ACTV che cresce di un minuto al minuto).
//      Resta sulla mappa ma non dà posizione né ritardi alla corsa, che torna alle previsioni ACTV o all'orario. Si riassocia appena riparte.
const tracker = require('./tracker');

const ON_ROUTE_M = 200, AT_START_M = 300, WAIT_MAX_S = 40 * 60, STILL_S = 300, NEED = 2;

// Adattamento di un punto a una corsa: tra i tratti del percorso vicini al punto, quello col ritardo più piccolo in valore assoluto.
// -> { lat, s, delay, atStart } | { lat, s: null, delay: null } | null
function fitTrip(G, tid, lat, lon, tNowOf) {
  const trip = G.trips[tid], st = G.stopTimes.get(tid); if (!trip || !st) return null;
  const sh = tracker.shapeInfo(G, trip.shape), offs = sh && tracker.stopOffsets(G, trip, st); if (!sh || !offs) return null;
  const tNow = tNowOf(st), { p, cum } = sh, M_LAT = 111320, M_LON = 111320 * Math.cos(lat * Math.PI / 180);
  let best = null, nearest = Infinity;
  for (let i = 0; i < sh.n - 1; i++) {
    const x0 = p[2 * i], y0 = p[2 * i + 1], dx = (p[2 * i + 2] - x0) * M_LAT, dy = (p[2 * i + 3] - y0) * M_LON, wx = (lat - x0) * M_LAT, wy = (lon - y0) * M_LON, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.min(1, Math.max(0, (wx * dx + wy * dy) / L2)) : 0, d = Math.hypot(wx - dx * t, wy - dy * t);
    if (d < nearest) nearest = d;
    if (d > ON_ROUTE_M) continue;
    const s = cum[i] + t * Math.sqrt(L2), delay = tNow - tracker.schedAt(offs, st, s);
    if (!best || Math.abs(delay) + d < Math.abs(best.delay) + best.lat) best = { lat: d, s, delay, atStart: s <= offs[0] + AT_START_M };
  }
  return best || { lat: nearest, s: null, delay: null };
}

// Fermo al capolinea di partenza ben oltre l'orario? (unico caso in cui la corsa dichiarata si considera impossibile)
function waitingTooLong(G, tid, v, tNowOf) {
  if ((v.stillS || 0) < STILL_S || !Number.isFinite(v.lat)) return false;
  const st = G.stopTimes.get(tid); if (!st) return false;
  if (tNowOf(st) - st.start <= WAIT_MAX_S) return false;
  const L = G.stopLoc[st.s[0]]; if (!L) return false;
  const M_LON = 111320 * Math.cos(v.lat * Math.PI / 180);
  return Math.hypot((v.lat - L[0]) * 111320, (v.lon - L[1]) * M_LON) <= AT_START_M;
}

// vehicles: [{ key, tripId (dal vehicle position), lat, lon, ts, stillS, old }], mem: Map(key -> memoria), tuOfVeh: Map(key -> corsa del trip update)
// -> Map(key -> { tid, why: 'feed'|'tu' } | { idle: { why } })
function plan({ G, vehicles, mem, tuOfVeh = new Map(), tNowOf }) {
  const out = new Map(), keys = new Set();
  for (const v of vehicles) {
    if (!v.tripId) continue;
    keys.add(v.key);
    const m = mem.get(v.key) || mem.set(v.key, {}).get(v.key), fresh = m.ts !== v.ts; m.ts = v.ts;
    const tu = tuOfVeh.get(String(v.key));
    if (tu && tu !== v.tripId && G.stopTimes.has(tu)) { if (fresh) m.tuN = m.tuTid === tu ? (m.tuN || 0) + 1 : 1; m.tuTid = tu; }
    else { m.tuTid = null; m.tuN = 0; }
    const tid = m.tuTid && m.tuN >= NEED ? m.tuTid : v.tripId;
    const bad = !v.old && waitingTooLong(G, tid, v, tNowOf);
    if (bad) { if (fresh) m.badN = (m.badN || 0) + 1; } else m.badN = 0;
    out.set(v.key, bad && m.badN >= NEED ? { idle: { why: 'fermo al capolinea' } } : { tid, why: tid === v.tripId ? 'feed' : 'tu' });
  }
  for (const k of [...mem.keys()]) if (!keys.has(k)) mem.delete(k);
  return out;
}

module.exports = { plan, fitTrip, waitingTooLong, C: { ON_ROUTE_M, AT_START_M, WAIT_MAX_S, STILL_S, NEED } };
