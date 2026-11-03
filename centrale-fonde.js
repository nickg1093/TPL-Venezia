// CENTRALE ACTV — correzione dei passaggi di una fermata e del pannello di una corsa con i dati della centrale.
//
// Cosa si corregge (le corse con un NOSTRO mezzo localizzato non si toccano mai: orario e mezzo vengono dal tracciamento; il mezzo molto in
// ritardo che fa di fatto la corsa successiva del turno è già sistemato a monte, per tutti i pannelli, da turni.js):
//  · corsa senza mezzo ("da orario") che la centrale dà in tempo reale: prende quel tempo (di solito il ritardo passato dalla corsa precedente
//    del turno, che il feed non pubblica: 6L, 33H, 34H, 2, 6, T1 il 1/11, 5-13 minuti);
//  · corsa senza mezzo che la centrale dà programmata: resta da orario;
//  · corsa senza mezzo che la centrale NON elenca, pur vedendo quell'ora e quella linea a quella palina: non parte a quell'ora (PARTENZA
//    FASULLA), la riga si toglie. Prudenza: se un passaggio ACTV della stessa linea entro 10 minuti non si è agganciato a nessuna corsa
//    (percorso o destinazione non riconosciuti), la corsa potrebbe essere quella: non si toglie;
//  · corsa lasciata da un mezzo per quella del suo turno (turni.js): compare solo se la centrale ne elenca un passaggio; senza centrale no
//    (il suo mezzo è quello in ritardo, che la mappa e i pannelli mostrano sulla corsa che fa davvero);
//  · corsa con la sola previsione del feed (nessun mezzo localizzato) e la centrale in tempo reale con un tempo diverso: vale la centrale
//    (P.le Roma C il 1/11: feed +15, centrale in orario); non si toglie mai.
// Le righe ACTV senza corsa nel nostro GTFS non si aggiungono. Grafica invariata, nessuna indicazione della fonte.
// Stesso calcolo nei due pannelli (2/11): l'orario ACTV di una corsa a una fermata viene dalla riga ACTV di quella palina se c'è, altrimenti
// dagli orari ACTV noti alle altre fermate della corsa (actvPlan). Prima il pannello della corsa estendeva il ritardo alle fermate senza
// pagina ACTV (es. Libertà 11380) mentre il pannello fermata le lasciava «Da orario».
const cal = require('./calendar');
const { C, st, lineOf, addMin, minutes, SRC } = require('./centrale-stato');
const { prepareStops } = require('./centrale-lettura');
const { match } = require('./centrale-abbina');

// rows: righe di schedule.departures già arricchite (src, stop) di UNA fermata (con le equivalenti). -> righe corrette
function mergeStop(src, sid, rows, nowMs = Date.now()) {
  if (!st.ctx || !SRC.has(src)) return rows;
  const state = st.ctx.state(src) || {}, vacated = st.ctx.vacated?.(src) || new Map(), s = st.stat;
  let M = null; try { M = match(src, sid, nowMs); } catch (e) { s.ultimoErrore = 'abbinamento: ' + e.message; }
  const drop = new Set(), plans = new Map();
  // orario ACTV della corsa a questa fermata ricavato dagli orari ACTV noti alle ALTRE fermate: lo stesso calcolo del pannello della corsa,
  // così i due pannelli dicono la stessa cosa anche dove la palina non ha una pagina ACTV o la riga ACTV non si è agganciata
  const planAt = x => {
    if (!plans.has(x.tripId)) plans.set(x.tripId, actvPlan(src, x.tripId, nowMs));
    const P = plans.get(x.tripId); return P && x.seq >= P.k0 && x.seq < P.n ? Math.max(P.msAt(x.seq), nowMs) : null;
  };
  for (const x of rows) {
    if (x.done || x.arrival || !x.tripId || x.cancel || x.veh) continue;        // partite, arrivi, soppresse, nostri mezzi: invariate
    const v = M?.res.get(x.tripId), left = vacated.has(x.tripId) && !x.live;
    const ms = v?.kind === 'tr' ? v.row.ms : planAt(x);
    if (state[x.tripId] && x.live && !left) {                                  // sola previsione del feed: vale ACTV se diversa
      if (ms != null && Math.abs((ms - nowMs) / 1000 - (x.expSec ?? 0)) > C.AGREE_S) { put(x, ms, nowMs); s.tempiSostituiti++; }
      // un passaggio, una riga (3/11): previsione del feed con ritardo di almeno 10 min che la centrale NON elenca (né in tempo reale né
      // programmata), pur vedendo quella linea a quella palina a quell'ora: è un ritardo trascinato su una corsa che nessuno fa, si toglie.
      // Stessa prudenza delle partenze fasulle: un passaggio ACTV della linea entro 10 min non agganciato a nessuna corsa la salva.
      else if (ms == null && !v && M && (x.delay ?? 0) >= C.DRAGGED_MIN) {
        const t = nowMs + (x.expSec ?? 0) * 1000, line = lineOf(x.line);
        if (t > nowMs + 60e3 && t <= M.horizon - 60e3 && M.lineCodes.has(line) && !M.loose.some(r => r.line === line && Math.abs(r.ms - t) <= C.DOUBT_MS)) { drop.add(x); s.partenzeTolte++; }
      }
      continue;
    }
    if (ms != null) { put(x, ms, nowMs); x.phase = null; s.tempiSostituiti++; continue; }   // in tempo reale per la centrale
    if (!M) { if (left) drop.add(x); continue; }                               // senza centrale: la corsa lasciata dal mezzo del turno non compare
    if (v) continue;                                                           // programmata anche per la centrale
    const t = nowMs + (x.expSec ?? x.schedSec ?? 0) * 1000, line = lineOf(x.line);
    const doubt = M.loose.some(r => r.line === line && Math.abs(r.ms - t) <= C.DOUBT_MS);
    if ((t > nowMs + 60e3 && t <= M.horizon - 60e3 && M.lineCodes.has(line) && !doubt) || (left && t <= M.horizon - 60e3)) { drop.add(x); s.partenzeTolte++; }
  }
  return drop.size ? rows.filter(x => !drop.has(x)) : rows;
}
// la riga prende il tempo ACTV ms (ritardo rispetto all'orario della SUA corsa, coerente con il pannello della corsa)
function put(x, ms, nowMs) {
  const a = (ms - nowMs) / 1000, dm = minutes(a - (x.schedSec ?? x.schedIn * 60));
  Object.assign(x, { expSec: a, expMs: ms, expIn: Math.round(a / 60), delay: dm, exp: addMin(x.sched, dm), live: true });
}

// Orari ACTV di una corsa a tutte le fermate, dai punti noti (fermate abbinate e orari successivi delle righe ACTV): ritardo interpolato tra i
// punti, costante prima del primo e dopo l'ultimo. -> { k0, n, sAt(j), msAt(j) } | null. Usato da entrambi i pannelli.
function actvPlan(src, tid, nowMs) {
  const v = st.store.get(src + ':' + tid); if (!v || nowMs - v.t > C.STALE_MS || !v.pts.size) return null;
  const G = st.ctx.G(src), s = G?.stopTimes.get(tid); if (!s) return null;
  const n = s.s.length, at = j => (j === n - 1 ? s.a[j] : s.d[j]), k0 = Math.min(...v.pts.keys()), base = s.d[k0];
  const sched0 = nowMs + (base - (cal.romeParts(nowMs).secs + (nowMs % 1000) / 1000 + v.off)) * 1000;   // istante programmato della prima fermata nota
  const sAt = j => sched0 + (at(j) - base) * 1000;
  const anchors = [...v.pts].map(([j, ms]) => ({ j, d: ms - sAt(j) })).sort((a, b) => a.j - b.j);
  const delayAt = j => {
    if (j <= anchors[0].j) return anchors[0].d;
    for (let q = 1; q < anchors.length; q++) if (j <= anchors[q].j) { const A = anchors[q - 1], B = anchors[q], f = (at(j) - at(A.j)) / Math.max(1, at(B.j) - at(A.j)); return A.d + (B.d - A.d) * f; }
    return anchors[anchors.length - 1].d;
  };
  return { k0, n, sAt, msAt: j => sAt(j) + delayAt(j) };
}

// ---- pannello della corsa: solo corse SENZA nostro mezzo (come nel pannello fermata) ----
// Prepara la pagina ACTV delle prossime due fermate della corsa e la abbina (gli orari ACTV alle fermate successive restano in memoria).
async function prepareTrip(src, tid) {
  if (!st.ctx || !SRC.has(src)) return;
  try {
    const G = st.ctx.G(src), s = G?.stopTimes.get(tid); if (!s || st.ctx.state(src)?.[tid]?.vehKey) return;
    const ps = st.ctx.state(src)?.[tid], now = Date.now(), secs = cal.romeParts(now).secs;
    let k = ps ? ps.cur : 0;
    if (!ps) { const t = s.start - 3600 <= secs && secs <= s.end + 3600 ? secs : secs + 86400; while (k < s.s.length - 2 && s.d[k] < t) k++; }
    const list = []; for (let q = k; q < Math.min(s.s.length - 1, k + 2); q++) list.push([src, s.s[q]]);
    await prepareStops(list);
    for (const [, sid] of list) match(src, sid, now);
  } catch { /* facoltativo */ }
}
// d: live.tripDetail in tempo reale. Fermate non ancora servite: orari ACTV (interpolati tra i punti noti, mai indietro nel tempo).
function mergeTrip(src, tid, d, nowMs = Date.now()) {
  if (!st.ctx || !d || !d.live || d.vehKey || st.ctx.state(src)?.[tid]?.vehKey) return d;
  const P = actvPlan(src, tid, nowMs); if (!P || P.n !== d.stops.length) return d;
  let changed = false, last = -Infinity;
  d.stops.forEach((x, j) => {
    if (j < P.k0 || x.state === 'passed' || x.skipped) return;
    if (x.state === 'at') { last = Math.max(last, x.expMs ?? nowMs); return; }
    const ms = Math.max(P.msAt(j), last, nowMs);
    // coincide con la previsione in tempo reale che c'è già (un orario «Da orario», senza ritardo, non conta: diventa in tempo reale come
    // nel pannello fermata)
    if (x.delay != null && x.expMs != null && Math.abs(x.expMs - ms) <= C.AGREE_S * 1000) { last = Math.max(last, x.expMs); return; }
    last = ms;
    const dm = minutes((ms - P.sAt(j)) / 1000);
    Object.assign(x, { expMs: Math.round(ms), inMin: Math.round((ms - nowMs) / 60000), delay: dm, exp: addMin(x.sched, dm) }); changed = true;
  });
  if (changed) {
    if (d.detected === false) d.detected = true;
    const nx = d.stops.find((x, j) => j >= P.k0 && x.state !== 'passed' && x.delay != null);   // ritardo della corsa: prima fermata con tempo ACTV
    if (nx) d.delayNow = nx.delay;
  }
  return d;
}

module.exports = { mergeStop, prepareTrip, mergeTrip, actvPlan };
