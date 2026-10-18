const http = require('http');
const fs = require('fs');
const path = require('path');
const { transit_realtime } = require('gtfs-realtime-bindings');
const gtfs = require('./gtfs');
const schedule = require('./schedule');
const { secsOfDayRome } = schedule;

const PORT = process.env.PORT || 3000;
const REFRESH_MS = 15000;
const RT = { nav: 'https://tpl.actv.it/nav/GTFSRT/', aut: 'https://tpl.actv.it/aut/GTFSRT/' };
const IDS = Object.keys(RT);

const emptyData = () => ({ routes: {}, trips: {}, stops: {}, stopLoc: {}, stopIndex: {}, routeShapes: {}, shapePts: {},
  calendar: {}, exceptions: {}, stopTimes: new Map(), exByDate: {}, byStart: {}, tripPrefixes: [] });
const D = {}, S = {};
for (const id of IDS) {
  D[id] = emptyData();
  S[id] = { updated: 0, error: null, vehicles: [], live: {}, diag: null, raw: {}, n: 0, hist: new Map(), sched: { ts: 0, vehicles: [], error: null } };
}
let stopsBody = null;

let version = 0;
const ready = Object.fromEntries(IDS.map(i => [i, false]));
async function loadStatic() {
  for (const id of IDS) {
    try { D[id] = await gtfs.load(id); S[id].sched.ts = 0; ready[id] = true; if (RT[id]) refresh(id); }
    catch (e) { console.error(`GTFS statico [${id}]:`, e.message); }
    stopsBody = null; version++;
  }
}
loadStatic();
setInterval(loadStatic, 24 * 3600 * 1000);

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const wrap = x => ((x + 43200) % 86400 + 86400) % 86400 - 43200;
const delayOf = (ev, sched) => {
  if (!ev) return null;
  if (has(ev, 'delay')) return Number(ev.delay);
  if (has(ev, 'time') && Number(ev.time) > 0) return wrap(secsOfDayRome(Number(ev.time) * 1000) - sched % 86400);
  return null;
};

function resolveTrip(G, td, dg) {
  if (!td) return null;
  const id = td.tripId;
  const hit = (how, tid) => { if (dg) dg.resolved[how] = (dg.resolved[how] || 0) + 1; return { id: tid, how }; };
  if (id && G.stopTimes.has(id)) return hit('byId', id);
  if (id) {
    const body = id.replace(/^[A-Za-z]+_/, '');
    for (const p of G.tripPrefixes || []) if (G.stopTimes.has(p + body)) return hit('byPrefix', p + body);
  }
  if (td.routeId && td.startTime) {
    const t = td.startTime.split(':'), secs = +t[0] * 3600 + +t[1] * 60 + +(t[2] || 0);
    const keys = (has(td, 'directionId') ? [`${td.routeId}|${td.directionId}|${secs}`] : []).concat(`${td.routeId}||${secs}`);
    for (const k of keys) {
      const c = G.byStart?.[k];
      if (c?.length) return hit('byRouteAndStart', c.find(x => schedule.isActiveToday(G, x)) || c[0]);
    }
  }
  return null;
}

async function pull(base, name) {
  const res = await fetch(base + name, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
}

async function refresh(id) {
  const st8 = S[id];
  try {
    const [pos, upd] = await Promise.all([pull(RT[id], 'vehiclePositions'), pull(RT[id], 'tripUpdates')]);
    const G = D[id], delays = {}, nextStop = {}, lv = {};
    const dg = { entities: 0, withTripId: 0, tripKnown: 0, updates: 0, matchedByStopId: 0, matchedBySeq: 0, unmatched: 0,
                 updatesWithDelayOrTime: 0, tripsWithDelay: 0, cancelled: 0, resolved: {}, unknownTripIds: [], unmatchedStops: [] };
    for (const e of upd.entity) {
      const tu = e.tripUpdate; if (!tu) continue;
      dg.entities++;
      if (!tu.trip?.tripId) continue;
      dg.withTripId++;
      const rs = resolveTrip(G, tu.trip, dg);
      if (!rs) continue;
      const tid = rs.id, st = G.stopTimes.get(tid);
      dg.tripKnown++;
      const n = st.s.length, explicit = new Array(n), skipped = new Set(); let cur = 0, firstJ = -1;
      for (const u of tu.stopTimeUpdate || []) {
        dg.updates++;
        if (u.scheduleRelationship === 2) continue;
        let j = -1;
        if (u.stopId) { j = st.s.indexOf(u.stopId, cur); if (j < 0) j = st.s.indexOf(u.stopId); }
        if (j < 0 && has(u, 'stopSequence')) j = st.q.indexOf(Number(u.stopSequence));
        if (j < 0) continue;
        cur = j + 1;
        if (firstJ < 0) firstJ = j;
        if (u.scheduleRelationship === 1) skipped.add(j);
        let dly = delayOf(u.arrival, st.a[j]); if (dly == null) dly = delayOf(u.departure, st.d[j]);
        if (dly != null) explicit[j] = dly;
      }
      let c = has(tu, 'delay') ? Number(tu.delay) : null;
      const arr = [];
      for (let k = 0; k < n; k++) { if (explicit[k] != null) c = explicit[k]; arr.push(c); }
      const cancelled = tu.trip.scheduleRelationship === 3;
      if (cancelled) dg.cancelled++;
      lv[tid] = { delays: arr, cancelled, skipped, firstJ };
      let h = st8.hist.get(tid); if (!h) st8.hist.set(tid, h = { delays: new Array(n).fill(null), seen: 0 });
      for (let k = 0; k < n; k++) if (explicit[k] != null) h.delays[k] = explicit[k];
      h.seen = Date.now();
      if (firstJ >= 0 && G.stops[st.s[firstJ]]) nextStop[tid] = G.stops[st.s[firstJ]];
      const first = arr.find(x => x != null);
      if (first != null) delays[tid] = first;
    }
    st8.diag = { at: new Date().toISOString(), ...dg };
    st8.live = lv;
    st8.vehicles = pos.entity
      .filter(e => e.vehicle?.position && Number.isFinite(e.vehicle.position.latitude) && Number.isFinite(e.vehicle.position.longitude))
      .map(e => {
        const v = e.vehicle, rs = resolveTrip(G, v.trip), tripId = rs?.id || null, trip = G.trips[tripId] || {};
        const routeKey = trip.route || v.trip?.routeId || null;
        const r = G.routes[routeKey] || {};
        return {
          id: `${id}:${v.vehicle?.id || e.id}`, src: id, label: v.vehicle?.label || null,
          lat: v.position.latitude, lon: v.position.longitude, bearing: v.position.bearing ?? null,
          line: r.name || routeKey || '?', color: r.color || null, tripId,
          routeId: routeKey ? `${id}:${routeKey}` : null, headsign: trip.headsign || null,
          nextStop: nextStop[tripId] || null, delay: tripId in delays ? delays[tripId] : null, ts: v.timestamp ? Number(v.timestamp) : null
        };
      });
    st8.updated = Date.now();
    st8.error = null;
  } catch (err) { st8.error = `${id}: ${err.message}`; }
}
for (const id of IDS) if (RT[id]) { refresh(id); setInterval(() => refresh(id), REFRESH_MS); }

const hm = s => { s = ((s % 86400) + 86400) % 86400; return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`; };

function projectFrac(G, trip, A, B, V) {
  const k = 0.7, pts = G.shapePts?.[trip.shape];
  const d2 = (P, Q) => ((P[1] - Q[1]) * k) ** 2 + (P[0] - Q[0]) ** 2;
  const clamp = x => Math.min(1, Math.max(0, x));
  const nearest = (P, from, to) => { let bi = from, bd = Infinity; for (let i = from; i <= to; i++) { const d = d2(pts[i], P); if (d < bd) { bd = d; bi = i; } } return bi; };
  const segProj = (P, Q) => {
    const px = (Q[1] - P[1]) * k, py = Q[0] - P[0], vx = (V[1] - P[1]) * k, vy = V[0] - P[0], den = px * px + py * py;
    const t = den > 0 ? clamp((vx * px + vy * py) / den) : 0, dx = vx - px * t, dy = vy - py * t;
    return { t, d: dx * dx + dy * dy };
  };
  if (pts && pts.length > 1) {
    const ia = nearest(A, 0, pts.length - 1), ib = nearest(B, ia, pts.length - 1);
    if (ib > ia) {
      const len = j => Math.sqrt(d2(pts[j], pts[j + 1])), pre = [0];
      for (let j = ia; j < ib; j++) pre.push(pre[pre.length - 1] + len(j));
      const iv = nearest(V, ia, ib); let best = null;
      for (let s = Math.max(ia, iv - 1); s <= Math.min(ib - 1, iv); s++) {
        const r = segProj(pts[s], pts[s + 1]); if (!best || r.d < best.d) best = { s, t: r.t, d: r.d };
      }
      const tot = pre[pre.length - 1];
      if (best && tot > 0) return clamp((pre[best.s - ia] + best.t * len(best.s)) / tot);
    }
  }
  const ax = (B[1] - A[1]) * k, ay = B[0] - A[0], vx = (V[1] - A[1]) * k, vy = V[0] - A[0], den = ax * ax + ay * ay;
  return den > 0 ? clamp((vx * ax + vy * ay) / den) : 0;
}

function tripDetail(i, tid, live) {
  const G = D[i], st = G.stopTimes.get(tid), trip = G.trips[tid], r = G.routes[trip.route] || {}, n = st.s.length;
  const nowS = schedule.secsOfDayRome(Date.now());
  const fits = t => t >= st.start - 3600 && t <= st.end + 3600;
  const tNow = !fits(nowS) && fits(nowS + 86400) ? nowS + 86400 : nowS;
  const lv = live ? S[i].live[tid] : null, hist = live ? S[i].hist.get(tid)?.delays : null;
  let cur;
  if (lv && lv.firstJ >= 0) cur = lv.firstJ;
  else { cur = st.s.findIndex((_, k) => (k === n - 1 ? st.a[k] : st.d[k]) > tNow); if (cur < 0) cur = n; }
  const stops = st.s.map((sid, k) => {
    const ts = k === n - 1 ? st.a[k] : st.d[k];
    let dl = null;
    if (live) dl = k >= cur ? (lv ? lv.delays[k] : null) : (hist ? hist[k] : null);
    return { id: sid, name: G.stops[sid] || sid, lat: G.stopLoc[sid]?.[0] ?? null, lon: G.stopLoc[sid]?.[1] ?? null,
      sched: hm(ts), exp: dl != null ? hm(ts + dl) : null, delay: dl != null ? Math.round(dl / 60) : null,
      inMin: Math.round((ts + (dl ?? 0) - tNow) / 60), state: k < cur ? 'passed' : (k === cur ? 'next' : 'upcoming'),
      skipped: !!lv?.skipped.has(k) };
  });
  const veh = live ? S[i].vehicles.find(x => x.tripId === tid) : null;
  const dn = lv && cur < n ? lv.delays[cur] : null;
  let progress;
  if (cur >= n) progress = { from: n - 1, frac: 0, gps: false };
  else if (cur === 0) progress = { from: 0, frac: 0, gps: false };
  else {
    const A = G.stopLoc[st.s[cur - 1]], B = G.stopLoc[st.s[cur]];
    let frac, gps = false;
    if (veh && A && B && Number.isFinite(veh.lat) && Number.isFinite(veh.lon)) { frac = projectFrac(G, trip, A, B, [veh.lat, veh.lon]); gps = true; }
    else {
      const dPrev = live ? (hist?.[cur - 1] ?? lv?.delays[cur] ?? 0) : 0, dCur = live ? (lv?.delays[cur] ?? 0) : 0;
      const t0 = st.d[cur - 1] + dPrev, t1 = st.a[cur] + dCur;
      frac = t1 > t0 ? (tNow - t0) / (t1 - t0) : 0;
    }
    progress = { from: cur - 1, frac: Math.min(1, Math.max(0, frac)), gps };
  }
  return { live, liveUpdated: S[i].updated, cur, progress, cancelled: !!lv?.cancelled,
    note: (m => m === 'ok' ? null : m)(schedule.scheduleMode(G)),
    delayNow: dn != null ? Math.round(dn / 60) : null,
    historyKnown: stops.some(s => s.state === 'passed' && s.delay != null),
    trip: { id: `${i}:${tid}`, src: i, line: r.name || trip.route, color: r.color || null,
            headsign: trip.headsign || G.stops[st.s[n - 1]] || null, vehicle: veh?.label || null },
    shape: G.shapePts[trip.shape] || null, stops };
}

const send = (res, obj, cache = 'no-store', code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
};

function schedVehicles(i, secs, date) {
  try {
    const vehicles = schedule.positionsNow(D[i], secs, date).filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lon))
      .map(v => ({ ...v, tripId: v.id, id: `${i}:${v.id}`, src: i, routeId: v.routeId ? `${i}:${v.routeId}` : null }));
    return { vehicles, error: null };
  } catch (e) {
    return { vehicles: [], error: `${i}: ${e.message}` };
  }
}

const wanted = url => (url.searchParams.get('src') || IDS.join(',')).split(',').filter(x => IDS.includes(x));
const splitId = full => { const i = (full || '').indexOf(':'); return i < 0 ? [null, full] : [full.slice(0, i), full.slice(i + 1)]; };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/vehicles') {
      const list = wanted(url), live = list.filter(i => RT[i]), noLive = list.filter(i => !RT[i]);
      const errors = live.map(i => S[i].error).filter(Boolean);
      const estimated = noLive.flatMap(i => schedVehicles(i, null, null).vehicles.map(v => ({ ...v, estimated: true })));
      return send(res, { updated: Math.max(noLive.length ? Date.now() : 0, ...live.map(i => S[i].updated)),
                         error: errors.length ? errors.join('; ') : null, version, ready,
                         vehicles: [...live.flatMap(i => S[i].vehicles), ...estimated] });
    }
    if (url.pathname === '/api/scheduled') {
      const list = wanted(url);
      const secsParam = url.searchParams.get('secs');
      const dateParam = url.searchParams.get('date');
      const secs = secsParam !== null ? +secsParam : null;
      const date = dateParam || null;

      const cs = list.map(i => schedVehicles(i, secs, date));
      const errors = cs.map(c => c.error).filter(Boolean);
      return send(res, { updated: Date.now(), error: errors.length ? errors.join('; ') : null, version, ready,
                         notes: list.map(i => ({ src: i, mode: schedule.scheduleMode(D[i]) })).filter(n => n.mode !== 'ok'),
                         vehicles: cs.flatMap(c => c.vehicles) });
    }
    if (url.pathname === '/api/stops') {
      if (!stopsBody) {
        const out = [];
        for (const i of IDS) {
          const G = D[i], served = Object.keys(G.stopIndex).length ? s => G.stopIndex[s] : () => true;
          for (const s of Object.keys(G.stops)) if (G.stopLoc[s] && served(s)) out.push([`${i}:${s}`, G.stops[s], G.stopLoc[s][0], G.stopLoc[s][1], i, null]);
        }
        stopsBody = JSON.stringify(out);
      }
      return send(res, stopsBody, 'no-store');
    }
    if (url.pathname === '/api/stop') {
      const full = url.searchParams.get('id'), [i, sid] = splitId(full);
      if (!D[i]) return send(res, { error: 'fermata sconosciuta' }, 'no-store', 404);
      
      const secsParam = url.searchParams.get('secs');
      const dateParam = url.searchParams.get('date');
      const secs = secsParam !== null ? +secsParam : null;
      const date = dateParam || null;

      const labels = new Map(S[i].vehicles.filter(x => x.tripId && x.label).map(x => [x.tripId, x.label]));
      return send(res, { stop: { id: full, name: D[i].stops[sid] || sid, src: i }, updated: Date.now(), liveUpdated: S[i].updated,
                         note: schedule.scheduleMode(D[i]) === 'ok' ? null : schedule.scheduleMode(D[i]),
                         departures: schedule.departures(D[i], S[i].live, sid, secs, date).map(x => ({ ...x, src: i, vehicle: labels.get(x.tripId) || null })) });
    }
    if (url.pathname === '/api/trip') {
      const full = url.searchParams.get('id'), [i, tid] = splitId(full);
      if (!D[i] || !D[i].stopTimes.has(tid)) return send(res, { error: 'corsa sconosciuta' }, 'no-store', 404);
      return send(res, tripDetail(i, tid, url.searchParams.get('mode') !== 'sched'));
    }
    if (url.pathname === '/api/routes') {
      const out = {};
      for (const i of IDS) for (const r in D[i].routes) out[`${i}:${r}`] = { ...D[i].routes[r], src: i };
      return send(res, out, 'no-store');
    }
    if (url.pathname === '/api/shapes') {
      const [i, rid] = splitId(url.searchParams.get('id'));
      return send(res, { shapes: D[i]?.routeShapes[rid] || [] }, 'no-store');
    }
  } catch (e) {
    return send(res, { error: e.message }, 'no-store', 500);
  }
  const page = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f));
  fs.readFile(page || '', (err, html) => {
    if (err) { res.writeHead(500); return res.end('index.html mancante'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
