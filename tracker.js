// STIMATORE DI STATO DELLA CORSA
// Fonde: trip update (feed), posizione GPS, velocità, tracciato della linea, orario programmato e STORIA del mezzo.
// Per ogni corsa produce: prossima fermata non transitata (cur), fermata in cui è fermo (atStop), fase, ETA per ogni fermata.
//
// FASI  scheduled  = mezzo non ancora visto / lontano       at        = fermo in fermata
//       enroute    = in viaggio verso la fermata            departing = in fermata, sta per partire / si muove
//       approaching= in arrivo (vicino e <75 s)             arrived   = capolinea di arrivo raggiunto
//       (i mezzi già transitati hanno cur > indice fermata: "partito")
//
// REGOLE DI FIDUCIA (dalla più alla meno affidabile):
//  1. GPS fresco e sul tracciato  -> prevale: posizione LUNGO il tracciato (non distanza in linea d'aria) rispetto alle fermate
//  2. Stato dichiarato dal feed (current_status/current_stop_sequence), se presente e coerente col GPS
//  3. Feed trip update (prima fermata con previsione), scartato se "stantio" (previsione passata da oltre 4 min)
//  4. Orario programmato
//  La fermata corrente NON torna mai indietro (monotona) salvo reset della corsa dopo 15 min di silenzio.
const { dist } = require('./motion');

const C = {
  FRESH_MS: 90000,     // GPS più vecchio di così = non affidabile
  OFFROUTE_M: 120,     // oltre: il mezzo è fuori tracciato (deviazione), si ignora la proiezione
  ARR_BACK_M: 40,      // zona di fermata: da 40 m prima...
  PASS_M: 55,          // ...a 55 m dopo il palo; oltre = transitato
  TERM_BACK_M: 300,    // capolinea di partenza: il bus sosta anche 300 m prima / 250 m dopo il pallino
  TERM_M: 250,
  STILL: 1.2,          // m/s: sotto = fermo
  MOVE: 2.5,           // m/s: sopra = in marcia
  MOVE_SUSTAIN_MS: 10000, // al capolinea la marcia deve durare 10 s per contare come partenza (manovre escluse)
  APPROACH_M: 350, APPROACH_S: 75,
  STALE_S: 240,        // previsione del feed superata da oltre 4 min senza aggiornamenti = stantia
  DEPART_S: 30         // ultimi secondi prima della partenza prevista: "in partenza"
};
const M_LAT = 111000, M_LON = 78000;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ---- geometria lungo il tracciato (distanze in metri dall'inizio del tracciato) ----
function shapeInfo(G, shapeId) {
  const cache = (G._shc ||= new Map());
  let v = cache.get(shapeId);
  if (v === undefined) {
    const p = G.shapePts[shapeId];
    if (!p || p.length < 4) v = null;
    else {
      const n = p.length >> 1, cum = new Float64Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot((p[2 * i] - p[2 * i - 2]) * M_LAT, (p[2 * i + 1] - p[2 * i - 1]) * M_LON);
      v = { p, cum, n };
    }
    cache.set(shapeId, v);
  }
  return v;
}
// distanza laterale e ascissa curvilinea del punto sul segmento i
function onSeg(sh, i, lat, lon) {
  const { p, cum } = sh, x0 = p[2 * i], y0 = p[2 * i + 1];
  const dx = (p[2 * i + 2] - x0) * M_LAT, dy = (p[2 * i + 3] - y0) * M_LON, wx = (lat - x0) * M_LAT, wy = (lon - y0) * M_LON, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? clamp((wx * dx + wy * dy) / L2, 0, 1) : 0;
  return { d: Math.hypot(wx - dx * t, wy - dy * t), s: cum[i] + t * Math.sqrt(L2) };
}
// Posizione del mezzo sul tracciato. 'hint' = ultima ascissa nota: penalizza i salti all'indietro (percorsi sovrapposti / anelli).
function project(sh, lat, lon, hint) {
  let best = null;
  for (let i = 0; i < sh.n - 1; i++) {
    const r = onSeg(sh, i, lat, lon);
    let score = r.d;
    if (hint != null) { if (r.s < hint - 150) score += (hint - r.s) * 0.5; else if (r.s > hint + 2500) score += (r.s - hint - 2500) * 0.05; }
    if (!best || score < best.score) best = { s: r.s, lat: r.d, score };
  }
  return best;
}
// Ascissa di ogni fermata sul tracciato, in ordine crescente (gestisce fermate ripetute e anelli). Cache per corsa.
function stopOffsets(G, trip, st) {
  if (st._off !== undefined && st._offShape === trip.shape) return st._off;
  const sh = trip.shape ? shapeInfo(G, trip.shape) : null;
  let off = null;
  if (sh) {
    off = new Float64Array(st.s.length); let from = 0, prev = 0, bad = 0;
    for (let k = 0; k < off.length; k++) {
      const L = G.stopLoc[st.s[k]]; if (!L) { off[k] = prev; continue; }
      let min = Infinity; const ds = [];
      for (let i = from; i < sh.n - 1; i++) { const d = onSeg(sh, i, L[0], L[1]).d; ds.push(d); if (d < min) min = d; }
      let pick = ds.findIndex(d => d <= min + 15); if (pick < 0) pick = 0;
      const r = onSeg(sh, from + pick, L[0], L[1]);
      if (r.d > 200) bad++;
      off[k] = Math.max(prev, r.s); prev = off[k]; from = Math.max(0, from + pick - 1);
    }
    if (bad > off.length / 3) off = null;           // tracciato inaffidabile per questa corsa
  }
  st._off = off; st._offShape = trip.shape;
  return off;
}

// ---- stima ----
// x: { G, trip, st, lv, hist, veh, tNow, nowMs, vs }   vs = memoria persistente della corsa (oggetto, viene aggiornato)
function update(x) {
  const { G, trip, st, lv, hist, veh, tNow, nowMs } = x, vs = x.vs || (x.vs = {});
  const n = st.s.length, at = k => (k === n - 1 ? st.a[k] : st.d[k]);
  const dly = k => lv?.delays[k] ?? hist?.[k] ?? vs.delay ?? 0;
  const dTo = k => { const L = G.stopLoc[st.s[k]]; return L && veh ? dist(veh.lat, veh.lon, L[0], L[1]) : Infinity; };

  if (vs.seen && nowMs - vs.seen > 900000) Object.keys(vs).forEach(k => delete vs[k]);   // corsa riusata: memoria azzerata

  // 1) FEED / ORARIO: prima fermata attesa
  let feedCur;
  if (lv && lv.firstJ >= 0) { feedCur = lv.firstJ; while (feedCur < n - 1 && tNow - (at(feedCur) + dly(feedCur)) > C.STALE_S) feedCur++; }
  else { feedCur = 0; while (feedCur < n && at(feedCur) <= tNow) feedCur++; }

  // 2) GPS: posizione lungo il tracciato
  const sp = veh && Number.isFinite(veh.speed) ? veh.speed : null, still = veh?.stillS || 0;
  const fresh = !!veh && Number.isFinite(veh.lat) && !(veh.ageS != null && veh.ageS * 1000 > C.FRESH_MS);   // età misurata col nostro orologio
  const offs = fresh ? stopOffsets(G, trip, st) : null;
  let sv = null, lateral = null;
  if (offs) { const pr = project(shapeInfo(G, trip.shape), veh.lat, veh.lon, vs.sMax ?? null); if (pr && pr.lat <= C.OFFROUTE_M) { sv = pr.s; lateral = pr.lat; } }
  if (sp != null && sp >= C.MOVE) vs.moveSince ??= nowMs; else vs.moveSince = null;
  const sustained = vs.moveSince != null && nowMs - vs.moveSince >= C.MOVE_SUSTAIN_MS;

  const prevCur = vs.cur ?? 0;
  let cur = Math.max(prevCur, feedCur), src = 'feed';
  if (sv != null) {
    let pc = prevCur; src = 'gps';
    while (pc < n - 1) {
      const dk = sv - offs[pc], term = pc === 0;
      let gone = dk > (term ? C.TERM_M : C.PASS_M);
      if (!gone && sp != null && sp >= C.MOVE) gone = term ? dk > 90 && sustained : dk > 20;
      if (!gone) break; pc++;
    }
    // il feed più avanti di 2+ fermate mentre il bus corre = proiezione GPS dubbia (percorsi sovrapposti): ci si fida del feed
    cur = (feedCur - pc >= 2 && (sp == null || sp >= C.MOVE)) ? Math.max(prevCur, feedCur) : Math.max(prevCur, pc);
    if (cur !== pc) src = 'feed';
  }
  // stato dichiarato dal feed (STOPPED_AT / IN_TRANSIT_TO) con stop_sequence: conferma la fermata solo se non contraddice il GPS
  if (veh?.seq != null && sv == null) { const j = st.q.indexOf(veh.seq); if (j >= 0) cur = Math.max(cur, j); }
  cur = clamp(cur, 0, n);

  // 3) IN FERMATA?
  let atStop = -1;
  if (veh && cur < n) {
    const k = cur, term = k === 0, dk = sv != null ? sv - offs[k] : null;
    const stopped = sp != null ? sp < C.STILL : (veh.status === 1 || still >= 5);
    const inZone = dk != null ? (dk >= -(term ? C.TERM_BACK_M : C.ARR_BACK_M) && dk <= (term ? C.TERM_M : C.PASS_M)) : dTo(k) <= (term ? 120 : 50);
    if (inZone && stopped) atStop = k;
  }

  // 4) ETA per ogni fermata, in ms assoluti
  const pred = k => at(k) + dly(k);
  let etaCur = cur < n ? pred(cur) : 0;
  const remaining = sv != null && cur < n ? offs[cur] - sv : null;
  if (atStop === cur && cur < n) etaCur = Math.max(at(cur) + Math.max(dly(cur), 0), tNow);          // si parte non prima dell'orario; oltre l'orario: ora
  else if (remaining != null && remaining > 0 && cur > 0) {
    const vSched = (offs[cur] - offs[cur - 1]) / Math.max(30, st.a[cur] - st.d[cur - 1]);
    const vEff = sp != null && sp >= C.STILL ? 0.5 * clamp(sp, 2.5, 14) + 0.5 * vSched : 0.6 * vSched;  // fermo in coda: ritmo ridotto
    const gps = tNow + remaining / Math.max(1.5, vEff), stalePred = lv == null || pred(cur) < tNow - 30;   // senza feed o previsione già superata: conta solo il GPS
    const w = stalePred ? 1 : clamp(1 - remaining / 1200, 0, 0.85);
    etaCur = w * gps + (1 - w) * pred(cur);
  } else if (cur === 0 && !veh) etaCur = Math.max(pred(0), at(0));                               // niente partenza anticipata
  if (cur < n) etaCur = Math.max(etaCur, tNow);

  const etaMs = new Float64Array(n).fill(NaN), effD = cur < n ? etaCur - at(cur) : 0;   // ritardo effettivo alla fermata corrente
  for (let k = cur, last = 0; k < n; k++) {
    let e = k === cur ? etaCur : at(k) + effD + (dly(k) - dly(cur));   // ritardo effettivo + variazione prevista dal feed lungo la corsa
    e = Math.max(e, last); last = e; etaMs[k] = nowMs + (e - tNow) * 1000;
  }

  // 5) FASE della fermata corrente
  let phase = 'scheduled';
  if (cur >= n) phase = 'arrived';
  else if (cur === 0 && sv != null && sp != null && sp >= C.MOVE && sv - offs[0] > 60) phase = 'departing';
  else if (atStop === cur) phase = cur === n - 1 ? 'arrived' : (etaCur - tNow <= C.DEPART_S || (sp != null && sp >= C.STILL) ? 'departing' : 'at');
  else if (veh && sv != null && remaining != null && remaining <= C.APPROACH_M && etaCur - tNow <= C.APPROACH_S) phase = 'approaching';
  else if (veh) phase = etaCur - tNow <= 45 ? 'approaching' : 'enroute';
  else if (etaCur - tNow <= 45) phase = 'approaching';

  // 6) MEMORIA (monotona)
  vs.dep ??= {}; for (let k = prevCur; k < cur && k < n; k++) vs.dep[k] ??= nowMs;
  vs.cur = cur; vs.seen = nowMs; vs.delay = cur < n ? Math.round(etaCur - at(cur)) : vs.delay;
  if (sv != null) vs.sMax = Math.max(vs.sMax ?? 0, sv);

  return { cur, atStop, phase, etaMs, src, sVeh: sv, lateral, delayS: vs.delay ?? 0,
    atOrigin: atStop === 0 || (!veh && cur === 0 && tNow < at(0)), waiting: atStop === cur && etaCur - tNow > 0, speed: sp, dep: vs.dep };
}
// Punto del tracciato all'ascissa s, e tratto di tracciato tra due ascisse (per muovere il mezzo SULLA linea, non in rettilineo).
const rnd = q => [+q[0].toFixed(5), +q[1].toFixed(5)];
function seg(sh, s) { let lo = 0, hi = sh.n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sh.cum[m] <= s) lo = m; else hi = m; } return lo; }
function pointAt(sh, s) {
  s = clamp(s, 0, sh.cum[sh.n - 1]); const i = seg(sh, s), L = sh.cum[i + 1] - sh.cum[i], t = L > 0 ? (s - sh.cum[i]) / L : 0, p = sh.p;
  return [p[2 * i] + (p[2 * i + 2] - p[2 * i]) * t, p[2 * i + 1] + (p[2 * i + 3] - p[2 * i + 1]) * t];
}
function slice(sh, s0, s1, maxPts = 60) {
  const out = [pointAt(sh, s0)];
  for (let i = seg(sh, s0) + 1; i < sh.n && sh.cum[i] < s1; i++) out.push([sh.p[2 * i], sh.p[2 * i + 1]]);
  out.push(pointAt(sh, s1));
  if (out.length <= maxPts) return out.map(rnd);
  const step = (out.length - 1) / (maxPts - 1); return Array.from({ length: maxPts }, (_, k) => rnd(out[Math.round(k * step)]));
}
module.exports = { update, project, stopOffsets, shapeInfo, pointAt, slice, C };
