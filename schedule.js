// ORARI PROGRAMMATI: posizioni teoriche lungo il tracciato e passaggi alle fermate (con lo stato live del tracker quando c'è).
// I tracciati sono Float32Array piatti: [lat0, lon0, lat1, lon1, ...]. Il calendario è in calendar.js.
const cal = require('./calendar');
const pad = n => String(n).padStart(2, '0');
const hhmm = s => { s = ((Math.round(s / 60) * 60 % 86400) + 86400) % 86400;   // al minuto più vicino: niente 00:12:59 -> 00:12
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}`; };

// Istante richiesto (secondi del giorno + data AAAAMMGG), con ritorno a "adesso" (ora di Venezia) se mancano o sono invalidi
function when(secs, date) {
  const b = cal.romeParts(), s = secs == null ? NaN : +secs;
  return { secs: Number.isFinite(s) && s >= 0 && s <= 172800 ? s : b.secs, ymd: cal.isYmd(date) ? date : b.ymd };
}

// Servizi attivi in una data. mode 'approx' = data fuori dal periodo coperto dai calendari: si usa il solo giorno della settimana.
function servicesFor(G, date) {
  const cache = (G._svc ||= new Map());
  let r = cache.get(date); if (r) return r;
  const set = cal.activeServices(G.calendar, G.exByDate, date), cov = (G._cov ||= cal.coverage(G.calendar, null));
  if (set.size || G.exByDate[date] || (date >= cov.min && date <= cov.max)) r = { set, mode: 'ok' };
  else {
    const loose = new Set(), dow = cal.dowOf(date);
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
  const { secs, ymd } = when(secsParam, date), out = [], seen = new Set();
  for (const [off, ds] of [[0, ymd], [86400, cal.addDays(ymd, -1)]]) {   // dopo mezzanotte le corse 24:xx del giorno prima sono ancora in viaggio
    const t = secs + off;
    for (const tripId of candidates(G, t)) {
      const st = G.stopTimes.get(tripId);
      if (!st || t < st.start || t > st.end || seen.has(tripId)) continue;
      const trip = G.trips[tripId];
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
// Ogni riga è un passaggio di UN mezzo (una corsa con più mezzi dà più righe). Righe "partite" (done): i mezzi già transitati dalla fermata
// negli ultimi DONE_MS ms, con l'istante REALE di partenza registrato dal tracker (GPS/feed), per non far sparire la corsa di colpo.
const DONE_MS = 120000;
function departures(G, live, stopId, secsParam = null, date = null, state = null) {
  const list = G.stopIndex[stopId];
  if (!list) return [];
  const { secs, ymd } = when(secsParam, date), out = [], nowMs = Date.now();
  for (const [off, ds] of [[0, ymd], [86400, cal.addDays(ymd, -1)], [-86400, cal.addDays(ymd, 1)]]) {
    const tNow = secs + off;
    for (let p = 0; p < list.length; p += 2) {
      const rawTripId = G.tripIds[list[p]], i = list[p + 1];
      const st = G.stopTimes.get(rawTripId);
      if (!st) continue;
      const last = i === st.s.length - 1, ts = last ? st.a[i] : st.d[i];
      // Quale istanza della corsa è quella VIVA? Dopo mezzanotte le corse del giorno di servizio precedente hanno orari 24:xx e
      // compaiono con off = 86400: lo stato del tracker porta con sé il proprio giorno (dayOff) e si applica a quella istanza.
      const ps0 = state?.[rawTripId], liveInst = ps0 ? ps0.dayOff === off : off >= 0;
      const lv0 = liveInst && off >= 0 ? live?.[rawTripId] : null;
      const trip = G.trips[rawTripId];
      if (!trip || !serviceActive(G, trip.service, ds)) continue;
      const r = G.routes[trip.route] || {};
      const base = { tripId: rawTripId, seq: i, line: r.name || trip.route, color: r.color || null, headsign: trip.headsign || G.stops[st.s[st.s.length - 1]] || null, sched: hhmm(ts), arrival: last };
      // Una corsa può essere svolta da PIÙ mezzi insieme (rinforzi, uno dietro l'altro): ognuno ha il proprio stato e il proprio passaggio.
      // La corsa resta in elenco finché NON è passato anche l'ultimo mezzo.
      for (const ps of (ps0 && liveInst ? [ps0, ...(ps0.co || [])] : [null])) {
        if (ps && i < ps.cur) {                                         // questo mezzo è già transitato da questa fermata
          const depAt = ps.dep?.[i];                                    // istante (ms) in cui è stato visto partire
          if (last || !depAt || nowMs - depAt > DONE_MS || depAt > nowMs + 1000) continue;
          const dl = (tNow - (nowMs - depAt) / 1000) - ts, dm = Math.round(dl / 60);   // ritardo effettivo alla partenza, in minuti interi
          out.push({ ...base, exp: hhmm(ts + dm * 60), schedIn: Math.round((ts - tNow) / 60), expIn: Math.round((depAt - nowMs) / 60000),
            delay: dm, live: true, veh: ps.vehKey ?? null, vehLabel: ps.label ?? null, atStop: false, phase: 'departed', done: true, expMs: depAt, expSec: (depAt - nowMs) / 1000, cancel: null });
          continue;
        }
        const lv = ps && ps !== ps0 ? null : lv0;            // il trip update del feed descrive il mezzo principale, non i rinforzi
        // Con stato live (tracker.js): ETA fusa feed + GPS + orario, già corretta per le regole di partenza.
        let dl = lv ? lv.delays[i] : null, expMs = null, em;
        if (ps && i >= ps.cur && ps.etaMs && Number.isFinite(ps.etaMs[i])) { expMs = ps.etaMs[i]; em = (expMs - nowMs) / 1000; dl = em - (ts - tNow); }
        const sm = ts - tNow; em ??= ts + (dl ?? 0) - tNow;
        const dm = dl != null ? Math.round(dl / 60) : null;     // ritardo in minuti interi: l'orario previsto si ricava da questo, così sono sempre coerenti
        if ((sm < -180 || sm > 7200) && (em < -180 || em > 7200)) continue;
        out.push({ ...base, exp: hhmm(ts + (dm ?? 0) * 60), schedIn: Math.round(sm / 60), expIn: Math.round(em / 60),
          delay: dm, live: dl != null, veh: ps?.vehKey ?? null, vehLabel: ps?.label ?? null,
          atStop: !!ps && ps.atStop === i, phase: ps && i >= ps.cur ? (i === ps.cur ? ps.phase : 'enroute') : null, done: false, expMs, expSec: em,
          cancel: lv0?.cancelled ? 'trip' : (lv0?.skipped.has(i) ? 'stop' : null) });
      }
    }
  }
  return out.sort((a, b) => (a.expSec - b.expSec) || (a.schedIn - b.schedIn)).slice(0, 80);
}

const isActiveToday = (G, tripId) => { const t = G.trips[tripId]; return !!t && serviceActive(G, t.service, cal.romeYmd()); };
const scheduleMode = (G, date) => servicesFor(G, cal.isYmd(date) ? date : cal.romeYmd()).mode;
const secsOfDayRome = ms => cal.romeParts(ms).secs;
module.exports = { positionsNow, departures, secsOfDayRome, isActiveToday, scheduleMode, hhmm, DONE_MS };
