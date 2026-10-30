// VERIFICA DELLA CORSA DICHIARATA DAL MEZZO.
// Problema reale del feed: a volte il mezzo trasmette l'identificativo di un'altra corsa (non cambiata al capolinea, corsa del turno precedente…):
// l'app mostrerebbe "100 minuti di ritardo" quando il mezzo in realtà fa, quasi in orario, la corsa successiva della stessa linea.
// Come le centrali operative, si confrontano la POSIZIONE GPS lungo il percorso e l'ORARIO di tutte le corse plausibili:
//   1. la corsa dichiarata "regge" se il mezzo è sul suo percorso e il ritardo misurato dal GPS è plausibile (−4 … +25 min): nessun intervento;
//   2. se il feed stesso (trip update) indica che QUESTO mezzo fa un'altra corsa, quella è la candidata più forte (dato dell'azienda);
//   3. altrimenti si cercano le corse della stessa linea attive adesso: sul percorso (≤ 60 m) e con ritardo GPS piccolo;
//   4. si cambia SOLO con prove ripetute (isteresi): 2 rilevamenti nuovi per la candidata del feed, 3 per una candidata trovata dal GPS,
//      e solo se la differenza è netta (almeno 12 minuti di ritardo in meno, o corsa dichiarata fuori percorso);
//   5. la scelta resta finché regge; se il feed cambia la corsa dichiarata, si torna a seguire il feed (i dati che arrivano hanno la precedenza).
// Un ritardo VERO (mezzo davvero in coda) non viene toccato: in quel caso nessuna altra corsa della linea è più coerente con posizione e orario.
const tracker = require('./tracker');
const schedule = require('./schedule');

const ON_ROUTE_M = 60, OFF_ROUTE_M = 120;
const OK_EARLY_S = -240, OK_LATE_S = 25 * 60;        // finestra di plausibilità del ritardo della corsa dichiarata
const GAIN_S = 12 * 60;                              // differenza minima per preferire un'altra corsa
const NEED_GPS = 3, NEED_FEED = 2;                   // rilevamenti nuovi di conferma

// Adattamento di un punto a una corsa: tra tutti i tratti del percorso vicini al punto (i percorsi ad anello o con andata e ritorno sulla
// stessa strada passano più volte vicino), quello con il ritardo più piccolo in valore assoluto. -> { lat, s, delay } | null
function fitTrip(G, tid, lat, lon, tNowOf) {
  const trip = G.trips[tid], st = G.stopTimes.get(tid); if (!trip || !st) return null;
  const sh = tracker.shapeInfo(G, trip.shape), offs = sh && tracker.stopOffsets(G, trip, st); if (!sh || !offs) return null;
  const tNow = tNowOf(st), { p, cum } = sh, M_LAT = 111320, M_LON = 111320 * Math.cos(lat * Math.PI / 180);
  let best = null, nearest = Infinity;
  for (let i = 0; i < sh.n - 1; i++) {
    const x0 = p[2 * i], y0 = p[2 * i + 1], dx = (p[2 * i + 2] - x0) * M_LAT, dy = (p[2 * i + 3] - y0) * M_LON, wx = (lat - x0) * M_LAT, wy = (lon - y0) * M_LON, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.min(1, Math.max(0, (wx * dx + wy * dy) / L2)) : 0, d = Math.hypot(wx - dx * t, wy - dy * t);
    if (d < nearest) nearest = d;
    if (d > OFF_ROUTE_M) continue;
    const s = cum[i] + t * Math.sqrt(L2), delay = tNow - tracker.schedAt(offs, st, s);
    if (!best || Math.abs(delay) + d < Math.abs(best.delay) + best.lat) best = { lat: d, s, delay, atStart: s <= offs[0] + 300 };
  }
  return best || { lat: nearest, s: null, delay: null };
}
// plausibile = sul percorso, con ritardo nella finestra; al capolinea di partenza l'attesa (anticipo) è normale fino a 90 minuti
const plausible = f => !!f && f.delay != null && f.lat <= ON_ROUTE_M && ((f.delay >= OK_EARLY_S && f.delay <= OK_LATE_S) || (f.atStart && f.delay < 0 && f.delay > -90 * 60));

// corse della stessa linea attive oggi, in servizio ora (± margini), indicizzate una volta per GTFS
function candidates(G, route, tNowOf) {
  const idx = (G._byRoute ||= (() => { const m = new Map(); for (const tid of G.tripIds || Object.keys(G.trips)) { const r = G.trips[tid]?.route; if (r != null) (m.get(r) || m.set(r, []).get(r)).push(tid); } return m; })());
  const out = [];
  for (const tid of idx.get(route) || []) {
    const st = G.stopTimes.get(tid); if (!st) continue;
    const t = tNowOf(st); if (t < st.start - 20 * 60 || t > st.end + 40 * 60) continue;
    if (schedule.isActiveToday(G, tid)) out.push(tid);
  }
  return out;
}

// Valuta un mezzo. mem = memoria del mezzo (persistente tra i cicli). tuTid = corsa che il feed (trip update) associa a questo mezzo, se diversa.
// owners: Map(tid -> { key, fit }) delle corse già seguite da altri mezzi con buon adattamento.  -> { tid, why, delay } | null
function check({ G, v, mem, tuTid, owners, tNowOf }) {
  const declared = v.feedTripId;
  if (!declared || !Number.isFinite(v.lat) || v.old) return null;
  if (mem.declared !== declared) { mem.declared = declared; mem.chosen = null; mem.cand = null; mem.n = 0; }   // il feed ha cambiato corsa: si segue il feed
  if (mem.ts === v.ts) return mem.chosen;                                                                // nessun rilevamento nuovo: decisione invariata
  mem.ts = v.ts;
  if (mem.chosen) {                                                                                      // la scelta precedente regge ancora?
    const f = fitTrip(G, mem.chosen.tid, v.lat, v.lon, tNowOf);
    if (plausible(f)) { mem.chosen.delay = f.delay; return mem.chosen; }
    mem.chosen = null; mem.n = 0;
  }
  const own = fitTrip(G, declared, v.lat, v.lon, tNowOf);
  if (plausible(own)) { mem.cand = null; mem.n = 0; return null; }                                       // la corsa dichiarata è coerente: nulla da fare
  const ownBad = !own || own.delay == null || own.lat > OFF_ROUTE_M, ownAbs = ownBad ? Infinity : Math.abs(own.delay);
  let pick = null;
  // 2) candidata del feed
  if (tuTid && tuTid !== declared) { const f = fitTrip(G, tuTid, v.lat, v.lon, tNowOf); if (f && f.delay != null && f.lat <= OFF_ROUTE_M && Math.abs(f.delay) <= 30 * 60) pick = { tid: tuTid, why: 'feed', delay: f.delay, need: NEED_FEED }; }
  // 3) candidate dal GPS
  if (!pick) {
    const route = G.trips[declared]?.route;
    for (const tid of candidates(G, route, tNowOf)) {
      if (tid === declared) continue;
      const o = owners.get(tid); if (o && o.key !== v.key && o.good) continue;                           // già seguita bene da un altro mezzo
      const f = fitTrip(G, tid, v.lat, v.lon, tNowOf); if (!plausible(f)) continue;
      if (!pick || Math.abs(f.delay) + f.lat * 2 < Math.abs(pick.delay) + pick.lat * 2) pick = { tid, why: 'gps', delay: f.delay, lat: f.lat, need: NEED_GPS };
    }
    if (pick && !(ownBad || ownAbs - Math.abs(pick.delay) >= GAIN_S)) pick = null;                        // differenza non netta: è un ritardo vero
  }
  if (!pick) { mem.cand = null; mem.n = 0; return null; }
  mem.n = mem.cand === pick.tid ? mem.n + 1 : 1; mem.cand = pick.tid;
  if (mem.n < pick.need) return null;
  mem.chosen = { tid: pick.tid, why: pick.why, delay: pick.delay, from: declared, since: Date.now() };
  return mem.chosen;
}

module.exports = { check, fitTrip, candidates, plausible, C: { ON_ROUTE_M, OFF_ROUTE_M, OK_EARLY_S, OK_LATE_S, GAIN_S, NEED_GPS, NEED_FEED } };
