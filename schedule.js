// Posizioni teoriche dei mezzi, calcolate dall'orario statico (stop_times + calendari).
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const hhmm = s => { s %= 86400; return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}`; };

function romeNow(ms = Date.now()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const o = {}; for (const x of p) o[x.type] = x.value;
  return { d: new Date(Date.UTC(+o.year, +o.month - 1, +o.day)), secs: +o.hour * 3600 + +o.minute * 60 + +o.second };
}
const dayNum = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 86400000;
const dowOf = d => new Date(dayNum(d) * 86400000).getUTCDay();
// Servizi attivi in una data. Se il calendario del feed non ne dà nessuno per oggi (feed scaduto, solo calendar_dates
// che non coprono oggi...) ripiego su un "giorno tipo" invece di mostrare un orario vuoto, e lo segnalo in `mode`.
function servicesFor(G, date) {
  const dow = dowOf(date);
  const cache = (G._svc ||= new Map());
  let r = cache.get(date); if (r) return r;
  const strict = new Set();
  for (const sid in G.calendar) { const c = G.calendar[sid]; if (c.days[dow] && date >= c.start && date <= c.end) strict.add(sid); }
  for (const [sid, type] of G.exByDate?.[date] || []) { if (type === 1) strict.add(sid); else if (type === 2) strict.delete(sid); }
  const cov = (G._cov ||= (() => {            // intervallo di date coperto dal calendario del feed
    const cs = Object.values(G.calendar).filter(c => c.start && c.end);
    return { min: cs.length ? cs.map(c => c.start).sort()[0] : '99999999', max: cs.length ? cs.map(c => c.end).sort().pop() : '00000000' };
  })());
  const covered = (date >= cov.min && date <= cov.max) || !!G.exByDate?.[date];
  if (strict.size || covered) r = { set: strict, mode: 'ok' };   // se il feed copre oggi e dice "nessun servizio", è vero
  else {
    const loose = new Set();
    for (const sid in G.calendar) if (G.calendar[sid].days[dow]) loose.add(sid);
    if (loose.size) r = { set: loose, mode: 'calendario del feed scaduto: uso il giorno tipo' };
    else {
      let best = null, bd = Infinity;
      for (const d2 of Object.keys(G.exByDate || {})) {
        if (!d2 || dowOf(d2) !== dow) continue;
        const diff = Math.abs(dayNum(d2) - dayNum(date)); if (diff < bd) { bd = diff; best = d2; }
      }
      r = best ? { set: new Set(G.exByDate[best].filter(x => x[1] === 1).map(x => x[0])), mode: `calendario del feed non copre oggi: uso il ${best}` }
               : { set: new Set(), mode: 'nessun calendario nel feed' };
    }
  }
  cache.set(date, r); return r;
}
const serviceActive = (G, sid, date) => servicesFor(G, date).set.has(sid);
const lerp = (A, B, f) => [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f];
const d2 = (P, Q) => { const dx = (P[1] - Q[1]) * 0.7, dy = P[0] - Q[0]; return dx * dx + dy * dy; };
function nearest(pts, P, from = 0) {
  let best = from, bd = Infinity;
  for (let i = from; i < pts.length; i++) { const d = d2(pts[i], P); if (d < bd) { bd = d; best = i; } }
  return best;
}
// Posizione tra due fermate, seguendo il tracciato (shape) invece della retta.
function along(G, shapeId, sidA, sidB, A, B, f) {
  const pts = G.shapePts?.[shapeId];
  if (!pts || pts.length < 2) return lerp(A, B, f);
  const cache = (G._idx ||= new Map());
  const get = (sid, P) => { const k = shapeId + '|' + sid; let i = cache.get(k); if (i === undefined) { i = nearest(pts, P); cache.set(k, i); } return i; };
  const ia = get(sidA, A); let ib = get(sidB, B);
  if (ib <= ia) ib = nearest(pts, B, ia);
  if (ib <= ia) return lerp(A, B, f);
  const seg = []; let total = 0;
  for (let k = ia; k < ib; k++) { const l = Math.sqrt(d2(pts[k], pts[k + 1])); seg.push(l); total += l; }
  const target = total * f; let acc = 0;
  for (let k = 0; k < seg.length; k++) {
    if (acc + seg[k] >= target) return lerp(pts[ia + k], pts[ia + k + 1], seg[k] ? (target - acc) / seg[k] : 0);
    acc += seg[k];
  }
  return pts[ib];
}

function positionsNow(G) {
  const { d, secs } = romeNow();
  const out = [], seen = new Set();
  // oggi, e ieri (per le corse con orari oltre le 24:00)
  for (const [off, day] of [[0, d], [86400, new Date(d.getTime() - 86400000)]]) {
    const t = secs + off, date = ymd(day), dow = day.getUTCDay(), active = {};
    for (const [tripId, st] of G.stopTimes || []) {
      if (t < st.start || t > st.end || seen.has(tripId)) continue;
      const trip = G.trips[tripId]; if (!trip) continue;
      if (!(active[trip.service] ??= serviceActive(G, trip.service, date))) continue;
      const n = st.d.length; let i = 0;
      while (i < n && t > st.d[i]) i++;
      if (i >= n) i = n - 1;
      let pos, at = null, ni;
      if (t >= st.a[i]) {                       // fermo in banchina
        pos = G.stopLoc[st.s[i]]; if (!pos) continue;
        at = G.stops[st.s[i]] || null; ni = i + 1 < n ? i + 1 : null;
      } else {                                  // in viaggio verso la fermata i
        if (i === 0) continue;
        const A = G.stopLoc[st.s[i - 1]], B = G.stopLoc[st.s[i]]; if (!A || !B) continue;
        const span = st.a[i] - st.d[i - 1];
        pos = along(G, trip.shape, st.s[i - 1], st.s[i], A, B, span > 0 ? (t - st.d[i - 1]) / span : 1);
        ni = i;
      }
      const r = G.routes[trip.route] || {};
      seen.add(tripId);
      out.push({ id: tripId, label: null, lat: pos[0], lon: pos[1], line: r.name || trip.route, color: r.color || null,
        routeId: trip.route, headsign: trip.headsign, at,
        nextStop: ni != null ? (G.stops[st.s[ni]] || null) : null,
        nextTime: ni != null ? hhmm(st.a[ni]) : null, delay: null });
    }
  }
  return out;
}
// Prossimi transiti a una fermata: orario programmato e orario previsto (con ritardo live).
function departures(G, live, stopId) {
  const list = G.stopIndex?.[stopId];
  if (!list) return [];
  const { d, secs } = romeNow(), out = [];
  for (const [off, day] of [[0, d], [86400, new Date(d.getTime() - 86400000)], [-86400, new Date(d.getTime() + 86400000)]]) {
    const tNow = secs + off, date = ymd(day), dow = day.getUTCDay(), active = {};
    for (let p = 0; p < list.length; p += 2) {
      const tripId = list[p], i = list[p + 1], st = G.stopTimes.get(tripId);
      const last = i === st.s.length - 1, ts = last ? st.a[i] : st.d[i];
      const lv = off >= 0 ? live?.[tripId] : null;          // il live vale per le corse di oggi/ieri
      const dl = lv ? lv.delays[i] : null;
      const sm = ts - tNow, em = ts + (dl ?? 0) - tNow;      // secondi da adesso
      if ((sm < -60 || sm > 5400) && (em < -60 || em > 5400)) continue;
      const trip = G.trips[tripId]; if (!trip) continue;
      if (!(active[trip.service] ??= serviceActive(G, trip.service, date))) continue;
      const r = G.routes[trip.route] || {};
      out.push({ tripId, line: r.name || trip.route, color: r.color || null,
        headsign: trip.headsign || G.stops[st.s[st.s.length - 1]] || null,
        sched: hhmm(ts), exp: hhmm(ts + (dl ?? 0)),
        schedIn: Math.round(sm / 60), expIn: Math.round(em / 60),
        delay: dl != null ? Math.round(dl / 60) : null, live: dl != null,
        cancel: lv?.cancelled ? 'trip' : (lv?.skipped.has(i) ? 'stop' : null), arrival: last });
    }
  }
  return out.sort((a, b) => Math.min(a.schedIn, a.expIn) - Math.min(b.schedIn, b.expIn)).slice(0, 80);
}
function isActiveToday(G, tripId) {
  const trip = G.trips[tripId]; if (!trip) return false;
  const { d } = romeNow();
  return serviceActive(G, trip.service, ymd(d));
}
const scheduleMode = G => servicesFor(G, ymd(romeNow().d)).mode;
function diagnose(G) {
  const { d, secs } = romeNow(), date = ymd(d), sv = servicesFor(G, date);
  const cal = Object.values(G.calendar), starts = cal.map(c => c.start).sort(), ends = cal.map(c => c.end).sort();
  const exDates = Object.keys(G.exByDate || {}).sort(), exSvc = new Set();
  for (const k of exDates) for (const x of G.exByDate[k]) exSvc.add(x[0]);
  const tripSvc = new Set(Object.values(G.trips).map(t => t.service));
  const orphan = [...tripSvc].filter(x => !(x in G.calendar) && !exSvc.has(x));
  let onActive = 0, inWindow = 0;
  for (const [tid, st] of G.stopTimes) {
    const t = G.trips[tid];
    if (t && sv.set.has(t.service)) { onActive++; if (secs >= st.start && secs <= st.end) inWindow++; }
  }
  return { today: date, nowSecs: secs, mode: sv.mode, activeServices: sv.set.size, servicesInCalendar: cal.length,
    calendarRange: cal.length ? [starts[0], ends[ends.length - 1]] : null,
    exceptionDates: exDates.length ? { first: exDates[0], last: exDates[exDates.length - 1], count: exDates.length } : null,
    servicesUsedByTrips: tripSvc.size, tripServicesMissingFromCalendar: orphan.length, missingSample: orphan.slice(0, 5),
    calendarSample: Object.keys(G.calendar).slice(0, 5), tripsOnActiveServices: onActive, tripsInWindowNow: inWindow };
}
const secsOfDayRome = ms => romeNow(ms).secs;
module.exports = { positionsNow, departures, secsOfDayRome, isActiveToday, scheduleMode, diagnose };
