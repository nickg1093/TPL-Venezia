// Calendari, posizioni teoriche lungo il tracciato e passaggi alle fermate.
// I tracciati sono Float32Array piatti: [lat0, lon0, lat1, lon1, ...].
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const hhmm = s => { s = ((Math.round(s / 60) * 60 % 86400) + 86400) % 86400;   // al minuto più vicino: niente 00:12:59 -> 00:12
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}`; };
const DAY = 86400000;
const dateOf = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const dowOf = s => dateOf(s).getUTCDay();

const FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function romeNow(ms = Date.now()) {
  const o = {}; for (const x of FMT.formatToParts(new Date(ms))) o[x.type] = x.value;
  return { d: new Date(Date.UTC(+o.year, +o.month - 1, +o.day)), secs: +o.hour * 3600 + +o.minute * 60 + +o.second };
}
// Istante richiesto (secondi del giorno + data YYYYMMDD) con ritorno a "adesso" se mancano o sono invalidi
function when(secs, date) {
  const b = romeNow(), s = secs == null ? NaN : +secs;
  return { secs: Number.isFinite(s) ? s : b.secs, day: /^\d{8}$/.test(date || '') ? dateOf(date) : b.d };
}

// Le chiavi di G.trips e G.stopTimes sono gli ID statici: nessuna normalizzazione necessaria qui.
const getTrip = (G, id) => G.trips[id] || null;
const getStopTime = (G, id) => G.stopTimes.get(id) || null;

// Servizi attivi in una data. mode 'approx' = data fuori dal periodo coperto dai calendari:
// si usa il solo giorno della settimana.
function servicesFor(G, date) {
  const cache = (G._svc ||= new Map());
  let r = cache.get(date); if (r) return r;
  const dow = dowOf(date), set = new Set(), ex = G.exByDate[date];
  for (const sid in G.calendar) { const c = G.calendar[sid]; if (c.days[dow] && date >= c.start && date <= c.end) set.add(sid); }
  for (const [sid, type] of ex || []) { if (type === 1) set.add(sid); else if (type === 2) set.delete(sid); }
  const cov = (G._cov ||= (() => {
    let min = '99999999', max = '00000000';
    for (const sid in G.calendar) { const c = G.calendar[sid]; if (c.start && c.start < min) min = c.start; if (c.end && c.end > max) max = c.end; }
    return { min, max };
  })());
  if (set.size || ex || (date >= cov.min && date <= cov.max)) r = { set, mode: 'ok' };
  else {
    const loose = new Set();
    for (const sid in G.calendar) if (G.calendar[sid].days[dow]) loose.add(sid);
    r = { set: loose, mode: 'approx' };
  }
  if (cache.size > 60) cache.clear();
  cache.set(date, r); return r;
}
const serviceActive = (G, sid, date) => servicesFor(G, date).set.has(sid);

// ---- geometria sui tracciati ----
const K = 0.7;   // correzione approssimata della longitudine
const d2 = (x0, y0, x1, y1) => ((y0 - y1) * K) ** 2 + (x0 - x1) ** 2;
const lerp = (A, B, f) => [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f];
const seg = (p, k) => Math.sqrt(d2(p[2 * k], p[2 * k + 1], p[2 * k + 2], p[2 * k + 3]));
function nearest(p, P, from = 0, to = (p.length >> 1) - 1) {
  let best = from, bd = Infinity;
  for (let i = from; i <= to; i++) { const d = d2(p[2 * i], p[2 * i + 1], P[0], P[1]); if (d < bd) { bd = d; best = i; } }
  return best;
}
// Tratto del tracciato compreso tra due fermate (indici dei punti), con cache
function span(G, shapeId, sidA, sidB, A, B) {
  const p = G.shapePts[shapeId];
  if (!p || p.length < 4) return null;
  const cache = (G._idx ||= new Map());
  const get = (sid, P) => { const k = shapeId + '|' + sid; let i = cache.get(k); if (i === undefined) cache.set(k, i = nearest(p, P)); return i; };
  const ia = get(sidA, A); let ib = get(sidB, B);
  if (ib <= ia) ib = nearest(p, B, ia);
  return ib > ia ? { p, ia, ib } : null;
}
function along(G, shapeId, sidA, sidB, A, B, f) {
  const s = span(G, shapeId, sidA, sidB, A, B);
  if (!s) return lerp(A, B, f);
  const { p, ia, ib } = s, lens = []; let total = 0;
  for (let k = ia; k < ib; k++) { const l = seg(p, k); lens.push(l); total += l; }
  const target = total * f; let acc = 0;
  for (let k = 0; k < lens.length; k++) {
    if (acc + lens[k] >= target) {
      const i = ia + k;
      return lerp([p[2 * i], p[2 * i + 1]], [p[2 * i + 2], p[2 * i + 3]], lens[k] ? (target - acc) / lens[k] : 0);
    }
    acc += lens[k];
  }
  return [p[2 * ib], p[2 * ib + 1]];
}
// Frazione (0..1) del percorso A->B in cui si trova il punto V (posizione GPS)
function fracOnShape(G, shapeId, sidA, sidB, A, B, V) {
  const clamp = x => Math.min(1, Math.max(0, x));
  const proj = (x0, y0, x1, y1) => {
    const px = (y1 - y0) * K, py = x1 - x0, wx = (V[1] - y0) * K, wy = V[0] - x0, den = px * px + py * py;
    const t = den > 0 ? clamp((wx * px + wy * py) / den) : 0, dx = wx - px * t, dy = wy - py * t;
    return { t, d: dx * dx + dy * dy };
  };
  const s = span(G, shapeId, sidA, sidB, A, B);
  if (s) {
    const { p, ia, ib } = s, iv = nearest(p, V, ia, ib), pre = [0];
    for (let k = ia; k < ib; k++) pre.push(pre[pre.length - 1] + seg(p, k));
    let best = null;
    for (let k = Math.max(ia, iv - 1); k <= Math.min(ib - 1, iv); k++) {
      const r = proj(p[2 * k], p[2 * k + 1], p[2 * k + 2], p[2 * k + 3]);
      if (!best || r.d < best.d) best = { k, t: r.t, d: r.d };
    }
    const tot = pre[pre.length - 1];
    if (best && tot > 0) return clamp((pre[best.k - ia] + best.t * seg(p, best.k)) / tot);
  }
  return proj(A[0], A[1], B[0], B[1]).t;
}

// ---- corse in viaggio a un dato istante ----
function candidates(G, t) {
  const bk = (G._bk ||= (() => {
    const m = new Map();
    for (const [id, st] of G.stopTimes)
      for (let b = Math.floor(st.start / 600); b <= Math.floor(st.end / 600); b++) { let l = m.get(b); if (!l) m.set(b, l = []); l.push(id); }
    return m;
  })());
  return bk.get(Math.floor(t / 600)) || [];
}

function positionsNow(G, secsParam = null, date = null) {
  const { secs, day } = when(secsParam, date), out = [], seen = new Set();
  for (const [off, dd] of [[0, day], [86400, new Date(day - DAY)]]) {
    const t = secs + off, ds = ymd(dd);
    for (const tripId of candidates(G, t)) {
      const st = getStopTime(G, tripId);
      if (!st || t < st.start || t > st.end || seen.has(tripId)) continue;
      const trip = getTrip(G, tripId);
      if (!trip || !serviceActive(G, trip.service, ds)) continue;
      const n = st.d.length; let i = 0;
      while (i < n && t > st.d[i]) i++;
      if (i >= n) i = n - 1;
      let pos;
      if (t >= st.a[i]) { pos = G.stopLoc[st.s[i]]; if (!pos) continue; }
      else {
        if (i === 0) continue;
        const A = G.stopLoc[st.s[i - 1]], B = G.stopLoc[st.s[i]]; if (!A || !B) continue;
        const span_ = st.a[i] - st.d[i - 1];
        pos = along(G, trip.shape, st.s[i - 1], st.s[i], A, B, span_ > 0 ? (t - st.d[i - 1]) / span_ : 1);
      }
      const r = G.routes[trip.route] || {};
      seen.add(tripId);
      out.push({ id: tripId, lat: +pos[0].toFixed(5), lon: +pos[1].toFixed(5), line: r.name || trip.route,
        color: r.color || null, routeId: trip.route, headsign: trip.headsign });
    }
  }
  return out;
}

// ---- passaggi a una fermata ----
function departures(G, live, stopId, secsParam = null, date = null, state = null) {
  const list = G.stopIndex[stopId];
  if (!list) return [];
  const { secs, day } = when(secsParam, date), out = [], nowMs = Date.now();
  for (const [off, dd] of [[0, day], [86400, new Date(day - DAY)], [-86400, new Date(+day + DAY)]]) {
    const tNow = secs + off, ds = ymd(dd);
    for (let p = 0; p < list.length; p += 2) {
      const rawTripId = G.tripIds[list[p]], i = list[p + 1];
      const st = getStopTime(G, rawTripId);
      if (!st) continue;
      const last = i === st.s.length - 1, ts = last ? st.a[i] : st.d[i];
      // Quale istanza della corsa è quella VIVA? Dopo mezzanotte le corse del giorno di servizio precedente hanno orari 24:xx e
      // compaiono con off = 86400: lo stato del tracker porta con sé il proprio giorno (dayOff) e si applica a quella istanza.
      const ps0 = state?.[rawTripId], liveInst = ps0 ? ps0.dayOff === off : off >= 0;
      const lv0 = liveInst && off >= 0 ? live?.[rawTripId] : null;
      const trip = getTrip(G, rawTripId);
      if (!trip || !serviceActive(G, trip.service, ds)) continue;
      const r = G.routes[trip.route] || {};
      // Una corsa può essere svolta da PIÙ mezzi insieme (rinforzi, uno dietro l'altro): ognuno ha il proprio stato e il proprio passaggio.
      // La corsa resta in elenco finché NON è passato anche l'ultimo mezzo.
      for (const ps of (ps0 && liveInst ? [ps0, ...(ps0.co || [])] : [null])) {
        const lv = ps && ps !== ps0 ? null : lv0;            // il trip update del feed descrive il mezzo principale, non i rinforzi
        if (ps && i < ps.cur) continue;                       // questo mezzo è già transitato da questa fermata
        // Con stato live (tracker.js): ETA fusa feed + GPS + orario, già corretta per le regole di partenza.
        let dl = lv ? lv.delays[i] : null, expMs = null, em;
        if (ps && i >= ps.cur && ps.etaMs && Number.isFinite(ps.etaMs[i])) { expMs = ps.etaMs[i]; em = (expMs - nowMs) / 1000; dl = em - (ts - tNow); }
        const sm = ts - tNow; em ??= ts + (dl ?? 0) - tNow;
        const dm = dl != null ? Math.round(dl / 60) : null;     // ritardo in minuti interi: l'orario previsto si ricava da questo, così sono sempre coerenti
        if ((sm < -180 || sm > 7200) && (em < -180 || em > 7200)) continue;
        out.push({ tripId: rawTripId, line: r.name || trip.route, color: r.color || null,
          headsign: trip.headsign || G.stops[st.s[st.s.length - 1]] || null,
          sched: hhmm(ts), exp: hhmm(ts + (dm ?? 0) * 60),
          schedIn: Math.round(sm / 60), expIn: Math.round(em / 60),
          delay: dm, live: dl != null, veh: ps?.vehKey ?? null, vehLabel: ps?.label ?? null,
          atStop: !!ps && ps.atStop === i, phase: ps && i >= ps.cur ? (i === ps.cur ? ps.phase : 'enroute') : null, expMs, expSec: em,
          cancel: lv0?.cancelled ? 'trip' : (lv0?.skipped.has(i) ? 'stop' : null), arrival: last });
      }
    }
  }
  return out.sort((a, b) => (a.expSec - b.expSec) || (a.schedIn - b.schedIn)).slice(0, 80);
}

const isActiveToday = (G, tripId) => { const t = getTrip(G, tripId); return !!t && serviceActive(G, t.service, ymd(romeNow().d)); };
const scheduleMode = (G, date) => servicesFor(G, /^\d{8}$/.test(date || '') ? date : ymd(romeNow().d)).mode;
const secsOfDayRome = ms => romeNow(ms).secs;
module.exports = { positionsNow, departures, secsOfDayRome, isActiveToday, scheduleMode, fracOnShape, hhmm };
