// TURNO DEL MEZZO: quale corsa sta facendo DAVVERO un mezzo molto in ritardo sulla corsa del feed.
//
// Il problema (debug del 1° novembre 2026, confronto con la centrale ACTV): il feed GTFS-RT non pubblica i turni e non sposta il ritardo sulla
// corsa successiva. Un tram dichiarato sulla corsa delle 21:26 che arriva alle 21:42 sta facendo, di fatto, la corsa delle 21:41: il sito lo
// mostrava "in ritardo di 16 min" e, un minuto prima, la corsa delle 21:41 "da orario" (un doppione: nessun mezzo la fa a quell'ora). Casi
// peggiori: T1 dati a +86/+92 per tutta la sera, battello 4.2 a +90, tram fermi al capolinea "in partenza" con la corsa di un'ora e mezza prima.
//
// Regola (ricalcolata a ogni lettura del feed, prima dello stato delle corse: mappa, pannello fermata e pannello del mezzo vedono la stessa
// corsa). Un mezzo passa dalla corsa A (del feed) alla corsa B solo se TUTTE queste condizioni valgono:
//   1. il mezzo ha oltre 10 minuti di ritardo sulla corsa A alla prossima fermata (dal suo stato al ciclo precedente: GPS + previsioni);
//   2. B è della stessa linea e fa ESATTAMENTE le stesse fermate di A da quella fermata fino al capolinea (stesso percorso, stessa direzione);
//   3. B è in servizio oggi e nessun altro mezzo la sta facendo (né per posizione né per previsione ACTV);
//   4. il mezzo passa da 2 minuti prima a 5 minuti dopo l'orario di B in quella fermata (la più vicina); se è FERMO in fermata (capolinea),
//      B è la prima corsa che parte entro 15 minuti: al capolinea il mezzo aspetta l'ora di partenza;
//   5. la centrale ACTV, se ha i dati di quella fermata, non dà B in tempo reale a un istante diverso da quello del mezzo (vorrebbe dire che B
//      la fa un altro mezzo, che noi non vediamo);
//   6. la stessa scelta per 2 rilevamenti GPS nuovi di fila (niente cambi su un dato isolato).
// Una volta scelta, B resta finché il mezzo passa da 3 minuti prima a 8 minuti dopo il suo orario (margine più largo: niente rimbalzi; fermo
// in fermata: finché non sono passati 8 minuti dall'orario di partenza di B).
// La corsa A resta senza mezzo: le sue previsioni (che erano di quel mezzo) non le si attribuiscono, e nel pannello fermata compare solo se la
// centrale ACTV ne elenca un passaggio (centrale-fonde.js). Il mezzo non sparisce mai dalla mappa.
const C = {
  DELAY_MIN: 10,                  // ritardo sulla corsa del feed oltre cui si cerca la corsa vera
  BEFORE_S: 120, AFTER_S: 300,    // finestra per scegliere B: da 2 min prima a 5 min dopo il suo orario
  KEEP_BEFORE_S: 180, KEEP_AFTER_S: 480,   // finestra per tenerla
  WAIT_S: 900, WAIT_ETA_S: 120,   // mezzo fermo in fermata (entro 2 min): la prima corsa che parte entro 15 min
  NEED: 2                         // conferme (rilevamenti GPS nuovi)
};

// Stesse fermate da kA (in A) e kB (in B) fino al capolinea
function sameRest(a, kA, b, kB) {
  if (a.s.length - kA !== b.s.length - kB) return false;
  for (let j = 0; kA + j < a.s.length; j++) if (a.s[kA + j] !== b.s[kB + j]) return false;
  return true;
}

// Corse candidate B per un mezzo alla fermata `sid` (indice kA nella corsa A). -> [{ tid, k, schedMs }]
function slotsAt(G, tidA, kA, nowMs, tNowOf, activeNow) {
  const A = G.stopTimes.get(tidA), tA = G.trips[tidA], sid = A.s[kA], list = G.stopIndex[sid], out = [];
  if (!list) return out;
  for (let p = 0; p < list.length; p += 2) {
    const tid = G.tripIds[list[p]], k = list[p + 1];
    if (tid === tidA) continue;
    const B = G.stopTimes.get(tid), tB = G.trips[tid];
    if (!B || !tB || tB.route !== tA.route || !sameRest(A, kA, B, k) || !activeNow(G, tid, B)) continue;
    out.push({ tid, k, schedMs: nowMs + (B.d[k] - tNowOf(B)) * 1000 });
  }
  return out;
}

// Calcola le corse "vere" dei mezzi. Non modifica nulla: restituisce il piano, applicato da live.js.
//  vehicles: mezzi con tripId (corsa del feed, dopo assign.plan) e ts (istante del rilevamento GPS)
//  prev: stato delle corse al ciclo precedente (live.js: S.state), per conoscere il passaggio previsto di ogni mezzo
//  vehOfTu: Map(corsa -> mezzo) dalle previsioni ACTV; mem: memoria per mezzo (conferme e scelta in corso)
//  check(sid, line, etaMs, schedMs): centrale ACTV -> 'contro' | altro (facoltativo)
// -> Map(chiave mezzo -> { from, to, k })
function plan({ G, vehicles, prev = {}, vehOfTu = new Map(), mem, nowMs = Date.now(), tNowOf, activeNow, check = null }) {
  const out = new Map(), busy = new Set(), seen = new Set();
  for (const v of vehicles) if (v.tripId) busy.add(v.tripId);
  const cands = [];
  for (const v of vehicles) {
    if (!v.tripId || v.co || v.sim) continue;
    seen.add(v.key);
    const m = mem.get(v.key) || mem.set(v.key, {}).get(v.key), fresh = m.ts !== v.ts; m.ts = v.ts;
    const A = G.stopTimes.get(v.tripId); if (!A || !G.trips[v.tripId]) { Object.assign(m, { to: null, cand: null, n: 0 }); continue; }
    // dove si trova il mezzo: stato del ciclo precedente, sulla corsa che aveva (A, oppure B se già spostato)
    const onB = m.from === v.tripId && m.to ? prev[m.to] : null;
    const ps = onB?.vehKey === v.key ? onB : prev[v.tripId]?.vehKey === v.key ? prev[v.tripId] : null;
    if (!ps) { Object.assign(m, { to: null, cand: null, n: 0 }); continue; }
    const T = ps === onB ? G.stopTimes.get(m.to) : A, kT = ps.atStop >= 0 ? ps.atStop : ps.cur;
    if (!T || kT >= T.s.length) { Object.assign(m, { to: null, cand: null, n: 0 }); continue; }
    const waiting = ps.atStop >= 0, eta = waiting ? Math.max(nowMs, ps.etaMs?.[kT] || nowMs) : ps.etaMs?.[kT];
    if (!Number.isFinite(eta)) continue;
    // stessa fermata nella corsa A (stesso percorso fino al capolinea)
    const kA = ps === onB ? kT - (m.kB - m.kA) : kT;
    if (kA < 0 || kA >= A.s.length || A.s[kA] !== T.s[kT]) { Object.assign(m, { to: null, cand: null, n: 0 }); continue; }
    const delayA = (eta - (nowMs + (A.d[kA] - tNowOf(A)) * 1000)) / 1000;
    if (delayA <= C.DELAY_MIN * 60) { Object.assign(m, { to: null, cand: null, n: 0 }); continue; }
    cands.push({ v, m, A, kA, eta, waiting: waiting && eta - nowMs <= C.WAIT_ETA_S * 1000, fresh });
  }
  // un mezzo per corsa: prima quelli che passano prima
  for (const c of cands.sort((a, b) => a.eta - b.eta)) {
    const { v, m, kA, eta, waiting, fresh } = c, line = G.routes[G.trips[v.tripId].route]?.name || '';
    const sticky = m.from === v.tripId ? m.to : null;
    let best = null, bd = Infinity;
    for (const s of slotsAt(G, v.tripId, kA, nowMs, tNowOf, activeNow)) {
      if (busy.has(s.tid) && s.tid !== sticky) continue;                                  // la fa già un altro mezzo
      const tuV = vehOfTu.get(s.tid); if (tuV != null && String(tuV) !== String(v.key)) continue;   // previsione ACTV di un altro mezzo
      const d = (eta - s.schedMs) / 1000, keep = s.tid === sticky;
      // fermo in fermata: parte all'orario di B (scelta in corso: si tiene anche se la partenza tarda, fino a 8 min dopo l'orario)
      const ok = waiting ? s.schedMs >= nowMs - (keep ? C.KEEP_AFTER_S * 1000 : 60e3) && -d <= C.WAIT_S
        : keep ? d >= -C.KEEP_BEFORE_S && d <= C.KEEP_AFTER_S : d >= -C.BEFORE_S && d <= C.AFTER_S;
      if (!ok) continue;
      const score = waiting ? s.schedMs : Math.abs(d) - (keep ? 60 : 0);                    // a parità, si tiene la scelta in corso
      if (score < bd) { bd = score; best = s; }
    }
    if (best && check && check(G.stopTimes.get(v.tripId).s[kA], line, eta, best.schedMs) === 'contro') best = null;
    if (!best) { Object.assign(m, { to: null, cand: null, n: 0 }); continue; }
    if (best.tid === sticky) { busy.add(best.tid); out.set(v.key, { from: v.tripId, to: best.tid, k: best.k }); continue; }
    if (m.cand === best.tid) { if (fresh) m.n++; } else { m.cand = best.tid; m.n = fresh ? 1 : 0; }
    if (m.n >= C.NEED) {
      Object.assign(m, { from: v.tripId, to: best.tid, kA, kB: best.k });
      busy.add(best.tid); out.set(v.key, { from: v.tripId, to: best.tid, k: best.k });
    }
  }
  for (const k of [...mem.keys()]) if (!seen.has(k)) mem.delete(k);
  return out;
}

module.exports = { plan, slotsAt, sameRest, C };
