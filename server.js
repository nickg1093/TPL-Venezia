// Proxy leggero ACTV: navigazione + automobilistico (GTFS statico + GTFS-RT) esposti come JSON.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { transit_realtime } = require('gtfs-realtime-bindings');
const gtfs = require('./gtfs');
const schedule = require('./schedule');
const { secsOfDayRome } = schedule;

const PORT = process.env.PORT || 3000;
const REFRESH_MS = 15000; // non scendere sotto i 10s: rispetta il server ACTV
const RT = { nav: 'https://tpl.actv.it/nav/GTFSRT/', aut: 'https://tpl.actv.it/aut/GTFSRT/', ali: null };   // ali (Alilaguna): solo orari, nessun feed realtime
const IDS = Object.keys(RT);

// Ogni servizio ha il suo dataset statico (D) e il suo stato realtime (S): gli ID non si mescolano mai.
const emptyData = () => ({ routes: {}, trips: {}, stops: {}, stopLoc: {}, stopIndex: {}, routeShapes: {}, shapePts: {},
  calendar: {}, exceptions: {}, stopTimes: new Map(), exByDate: {}, byStart: {}, tripPrefixes: [] });
const D = {}, S = {};
for (const id of IDS) {
  D[id] = emptyData();
  S[id] = { updated: 0, error: null, vehicles: [], live: {}, diag: null, raw: {}, n: 0, hist: new Map(), sched: { ts: 0, vehicles: [], error: null } };
}
let stopsBody = null;

// Alilaguna usa quasi tutti i pontili ACTV: le sue fermate che coincidono (per nome o per posizione) con una fermata ACTV non si disegnano
// due volte, e i suoi passaggi compaiono nel pannello della fermata ACTV. Quelle senza fermata ACTV vicina restano visibili da sole.
const ALI_MAX_M = 200, ALI_SAME_SPOT_M = 40;
let ALIAS = new Map(), REV = new Map(), ALIAS_REPORT = { matched: [], unmatched: [] };      // ALIAS: fermata Alilaguna → fermata ACTV; REV: l'inverso
function buildAlias() {
  ALIAS = new Map(); REV = new Map(); ALIAS_REPORT = { matched: [], unmatched: [] };
  const N = D.nav, A = D.ali; if (!N || !A) return;
  const words = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(w => w.length > 2 && !['san', 'santa', 'sant', 'del', 'della', 'dei', 'delle', 'venezia'].includes(w));
  const meters = (p, q) => Math.hypot((p[1] - q[1]) * 111320 * Math.cos(p[0] * Math.PI / 180), (p[0] - q[0]) * 110540);
  const nServed = Object.keys(N.stopIndex).length > 0, aServed = Object.keys(A.stopIndex).length > 0;
  const navStops = Object.keys(N.stops).filter(s => N.stopLoc[s] && (!nServed || N.stopIndex[s])).map(s => ({ id: s, w: words(N.stops[s]) }));
  for (const aid of Object.keys(A.stops)) {
    if (!A.stopLoc[aid] || (aServed && !A.stopIndex[aid])) continue;
    const aw = words(A.stops[aid]);
    const c = navStops.map(n => {
      const common = aw.filter(w => n.w.includes(w)).length;
      return { id: n.id, m: meters(A.stopLoc[aid], N.stopLoc[n.id]), score: aw.length && n.w.length ? common / Math.min(aw.length, n.w.length) : 0 };
    }).filter(x => x.m <= ALI_MAX_M);
    const byName = c.filter(x => x.score >= 0.5).sort((x, y) => y.score - x.score || x.m - y.m)[0];     // stesso nome entro 200 m
    const near = c.filter(x => x.m <= ALI_SAME_SPOT_M).sort((x, y) => x.m - y.m)[0];                      // oppure stessa posizione entro 40 m
    const hit = byName || near;
    if (hit) {
      ALIAS.set(aid, hit.id);
      if (!REV.has(hit.id)) REV.set(hit.id, []);
      REV.get(hit.id).push(aid);
      ALIAS_REPORT.matched.push(`${A.stops[aid]} → ${N.stops[hit.id]} (${Math.round(hit.m)} m, ${byName ? 'stesso nome' : 'stessa posizione'})`);
    } else {
      const nearest = c.slice().sort((x, y) => x.m - y.m)[0];
      ALIAS_REPORT.unmatched.push(`${A.stops[aid]}${nearest ? ` (la più vicina: ${N.stops[nearest.id]}, ${Math.round(nearest.m)} m)` : ''}`);
    }
  }
  console.log(`Fermate Alilaguna: ${ALIAS.size} agganciate a fermate ACTV, ${ALIAS_REPORT.unmatched.length} restano visibili da sole`);
}

let version = 0;                       // cambia ogni volta che un GTFS statico è stato (ri)letto: il browser ricarica fermate e linee
const ready = Object.fromEntries(IDS.map(i => [i, false]));
async function loadStatic() {
  for (const id of IDS) {
    try { D[id] = await gtfs.load(id); S[id].sched.ts = 0; ready[id] = true; if (RT[id]) refresh(id); } // riallinea subito i mezzi live
    catch (e) { console.error(`GTFS statico [${id}]:`, e.message); }
    buildAlias(); stopsBody = null; version++;
  }
}
loadStatic();
setInterval(loadStatic, 24 * 3600 * 1000);

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k); // i campi assenti valgono 0 nel prototipo
const wrap = x => ((x + 43200) % 86400 + 86400) % 86400 - 43200;
const delayOf = (ev, sched) => {
  if (!ev) return null;
  if (has(ev, 'delay')) return Number(ev.delay);
  if (has(ev, 'time') && Number(ev.time) > 0) return wrap(secsOfDayRome(Number(ev.time) * 1000) - sched % 86400);
  return null;
};

// Collega una corsa del feed realtime a una corsa del GTFS statico (dello stesso servizio).
// 1) stesso trip_id  2) stesso numero con prefisso diverso (AUT_ ↔ NAV_)  3) stessa linea + direzione + ora di partenza
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
      if (!rs) {
        if (dg.unknownTripIds.length < 5) dg.unknownTripIds.push({ tripId: tu.trip.tripId, routeId: tu.trip.routeId,
          startTime: tu.trip.startTime, directionId: has(tu.trip, 'directionId') ? tu.trip.directionId : null });
        continue;
      }
      const tid = rs.id, st = G.stopTimes.get(tid);
      dg.tripKnown++;
      const n = st.s.length, explicit = new Array(n), skipped = new Set(); let cur = 0, firstJ = -1;
      for (const u of tu.stopTimeUpdate || []) {
        dg.updates++;
        if (u.scheduleRelationship === 2) continue;             // NO_DATA
        let j = -1;
        if (u.stopId) {                                         // 1) per stop_id
          j = st.s.indexOf(u.stopId, cur); if (j < 0) j = st.s.indexOf(u.stopId);
          if (j >= 0) dg.matchedByStopId++;
        }
        if (j < 0 && has(u, 'stopSequence')) {                  // 2) per stop_sequence
          j = st.q.indexOf(Number(u.stopSequence));
          if (j >= 0) dg.matchedBySeq++;
        }
        if (j < 0) {
          dg.unmatched++;
          if (dg.unmatchedStops.length < 5) dg.unmatchedStops.push({ trip: tid, stopId: u.stopId || null,
            stopSequence: has(u, 'stopSequence') ? Number(u.stopSequence) : null, staticStops: st.s.slice(0, 4), staticSeq: st.q.slice(0, 4) });
          continue;
        }
        cur = j + 1;
        if (firstJ < 0) firstJ = j;
        if (u.scheduleRelationship === 1) skipped.add(j);       // SKIPPED
        let dly = delayOf(u.arrival, st.a[j]); if (dly == null) dly = delayOf(u.departure, st.d[j]);
        if (dly != null) { explicit[j] = dly; dg.updatesWithDelayOrTime++; }
      }
      let c = has(tu, 'delay') ? Number(tu.delay) : null;       // ritardo a livello di corsa
      const arr = [];
      for (let k = 0; k < n; k++) { if (explicit[k] != null) c = explicit[k]; arr.push(c); }
      const cancelled = tu.trip.scheduleRelationship === 3;
      if (cancelled) dg.cancelled++;
      if (arr.some(x => x != null)) dg.tripsWithDelay++;
      lv[tid] = { delays: arr, cancelled, skipped, firstJ };
      let h = st8.hist.get(tid); if (!h) st8.hist.set(tid, h = { delays: new Array(n).fill(null), seen: 0 });
      for (let k = 0; k < n; k++) if (explicit[k] != null) h.delays[k] = explicit[k];   // ultima previsione nota
      h.seen = Date.now();
      if (firstJ >= 0 && G.stops[st.s[firstJ]]) nextStop[tid] = G.stops[st.s[firstJ]];
      const first = arr.find(x => x != null);
      if (first != null) delays[tid] = first;
    }
    for (const [k, h] of st8.hist) if (Date.now() - h.seen > 4 * 3600e3) st8.hist.delete(k);
    st8.diag = { at: new Date().toISOString(), ...dg };
    if (st8.n++ % 20 === 0)
      console.log(`Live [${id}]: ${dg.entities} corse nel feed, ${dg.tripKnown} riconosciute nel GTFS, ${dg.tripsWithDelay} con ritardo ` +
                  `(aggiornamenti: ${dg.updates}, per stop_id ${dg.matchedByStopId}, per sequence ${dg.matchedBySeq}, non associati ${dg.unmatched})` +
                  ` · collegamento corse: ${JSON.stringify(dg.resolved)}`);
    try {
      const cut = e => { const o = transit_realtime.FeedEntity.toObject(e, { longs: String, enums: String });
                         if (o.tripUpdate?.stopTimeUpdate) o.tripUpdate.stopTimeUpdate = o.tripUpdate.stopTimeUpdate.slice(0, 3); return o; };
      st8.raw = { tripUpdate: upd.entity.length ? cut(upd.entity.find(e => e.tripUpdate?.stopTimeUpdate?.length) || upd.entity[0]) : null,
                  vehicle: pos.entity.length ? transit_realtime.FeedEntity.toObject(pos.entity[0], { longs: String, enums: String }) : null };
    } catch (e) { st8.raw = { error: e.message }; }
    st8.live = lv;
    st8.vehicles = pos.entity
      .filter(e => e.vehicle?.position && Number.isFinite(e.vehicle.position.latitude) && Number.isFinite(e.vehicle.position.longitude))
      .map(e => {
        const v = e.vehicle, rs = resolveTrip(G, v.trip), tripId = rs?.id || null, trip = G.trips[tripId] || {};
        const routeKey = trip.route || v.trip?.routeId || null;
        const r = G.routes[routeKey] || {};
        return {
          id: `${id}:${v.vehicle?.id || e.id}`,
          src: id,
          label: v.vehicle?.label || null,
          lat: v.position.latitude,
          lon: v.position.longitude,
          bearing: v.position.bearing ?? null,
          line: r.name || routeKey || '?',
          color: r.color || null,
          tripId,
          routeId: routeKey ? `${id}:${routeKey}` : null,
          headsign: trip.headsign || null,
          nextStop: nextStop[tripId] || null,
          delay: tripId in delays ? delays[tripId] : null, // secondi
          ts: v.timestamp ? Number(v.timestamp) : null
        };
      });
    st8.updated = Date.now();
    st8.error = null;
  } catch (err) {
    st8.error = `${id}: ${err.message}`;
    console.error(`Errore aggiornamento [${id}]:`, err.message);
  }
}
for (const id of IDS) if (RT[id]) { refresh(id); setInterval(() => refresh(id), REFRESH_MS); }

const hm = s => { s = ((s % 86400) + 86400) % 86400; return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`; };
// Quanta strada del tratto A→B il mezzo ha già fatto (0..1): lo proietto sul tracciato della corsa
function projectFrac(G, trip, A, B, V) {
  const k = 0.7, pts = G.shapePts?.[trip.shape];            // 0.7 ≈ cos(latitudine) per il Veneto
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
  const ax = (B[1] - A[1]) * k, ay = B[0] - A[0], vx = (V[1] - A[1]) * k, vy = V[0] - A[0], den = ax * ax + ay * ay;   // senza tracciato: retta A→B
  return den > 0 ? clamp((vx * ax + vy * ay) / den) : 0;
}
function tripDetail(i, tid, live) {
  const G = D[i], st = G.stopTimes.get(tid), trip = G.trips[tid], r = G.routes[trip.route] || {}, n = st.s.length;
  const nowS = schedule.secsOfDayRome(Date.now());
  const fits = t => t >= st.start - 3600 && t <= st.end + 3600;
  const tNow = !fits(nowS) && fits(nowS + 86400) ? nowS + 86400 : nowS;           // corse che passano la mezzanotte
  const lv = live ? S[i].live[tid] : null, hist = live ? S[i].hist.get(tid)?.delays : null;
  let cur;                                                                          // indice della prossima fermata
  if (lv && lv.firstJ >= 0) cur = lv.firstJ;
  else { cur = st.s.findIndex((_, k) => (k === n - 1 ? st.a[k] : st.d[k]) > tNow); if (cur < 0) cur = n; }
  const stops = st.s.map((sid, k) => {
    const ts = k === n - 1 ? st.a[k] : st.d[k];
    let dl = null;                                                                   // ritardo in secondi
    if (live) dl = k >= cur ? (lv ? lv.delays[k] : null) : (hist ? hist[k] : null);
    return { id: sid, name: G.stops[sid] || sid, lat: G.stopLoc[sid]?.[0] ?? null, lon: G.stopLoc[sid]?.[1] ?? null,
      sched: hm(ts), exp: dl != null ? hm(ts + dl) : null, delay: dl != null ? Math.round(dl / 60) : null,
      inMin: Math.round((ts + (dl ?? 0) - tNow) / 60), state: k < cur ? 'passed' : (k === cur ? 'next' : 'upcoming'),
      skipped: !!lv?.skipped.has(k) };
  });
  const veh = live ? S[i].vehicles.find(x => x.tripId === tid) : null;
  const dn = lv && cur < n ? lv.delays[cur] : null;
  let progress;                                                                     // dove si trova il mezzo tra una fermata e la successiva
  if (cur >= n) progress = { from: n - 1, frac: 0, gps: false };
  else if (cur === 0) progress = { from: 0, frac: 0, gps: false };
  else {
    const A = G.stopLoc[st.s[cur - 1]], B = G.stopLoc[st.s[cur]];
    let frac, gps = false;
    if (veh && A && B && Number.isFinite(veh.lat) && Number.isFinite(veh.lon)) { frac = projectFrac(G, trip, A, B, [veh.lat, veh.lon]); gps = true; }
    else {                                                                          // senza posizione: stima dagli orari
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
// Posizioni teoriche da orario (cache 10 s) per un servizio
function schedVehicles(i) {
  const c = S[i].sched;
  if (Date.now() - c.ts <= 10000) return c;
  try {
    const t0 = Date.now();
    c.vehicles = schedule.positionsNow(D[i]).filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lon))
      .map(v => ({ ...v, tripId: v.id, id: `${i}:${v.id}`, src: i, routeId: v.routeId ? `${i}:${v.routeId}` : null }));
    if (!c.logged || Date.now() - t0 > 1500) { console.log(`Orario programmato [${i}]: ${c.vehicles.length} corse in servizio (${Date.now() - t0} ms)`); c.logged = true; }
    c.error = null;
  } catch (e) { console.error(`Orario programmato [${i}]:`, e); c.vehicles = []; c.error = `${i}: ${e.message}`; }
  c.ts = Date.now();
  return c;
}
const wanted = url => (url.searchParams.get('src') || IDS.join(',')).split(',').filter(x => IDS.includes(x));
const splitId = full => { const i = (full || '').indexOf(':'); return i < 0 ? [null, full] : [full.slice(0, i), full.slice(i + 1)]; };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/vehicles') {
      const list = wanted(url), live = list.filter(i => RT[i]), noLive = list.filter(i => !RT[i]);
      const errors = live.map(i => S[i].error).filter(Boolean);
      const estimated = noLive.flatMap(i => schedVehicles(i).vehicles.map(v => ({ ...v, estimated: true })));   // senza feed live: posizione stimata
      return send(res, { updated: Math.max(noLive.length ? Date.now() : 0, ...live.map(i => S[i].updated)),
                         error: errors.length ? errors.join('; ') : null, version, ready,
                         vehicles: [...live.flatMap(i => S[i].vehicles), ...estimated] });
    }
    if (url.pathname === '/api/scheduled') {
      const list = wanted(url), cs = list.map(i => schedVehicles(i)), errors = cs.map(c => c.error).filter(Boolean);
      return send(res, { updated: Date.now(), error: errors.length ? errors.join('; ') : null, version, ready,
                         notes: list.map(i => ({ src: i, mode: schedule.scheduleMode(D[i]) })).filter(n => n.mode !== 'ok'),
                         vehicles: cs.flatMap(c => c.vehicles) });
    }
    if (url.pathname === '/api/stops') {
      if (!stopsBody) {
        const out = [];
        for (const i of IDS) {
          const G = D[i], served = Object.keys(G.stopIndex).length ? s => G.stopIndex[s] : () => true;
          for (const s of Object.keys(G.stops)) if (G.stopLoc[s] && served(s) && !(i === 'ali' && ALIAS.has(s))) out.push([`${i}:${s}`, G.stops[s], G.stopLoc[s][0], G.stopLoc[s][1], i, i === 'nav' && REV.has(s) ? 'ali' : null]);
        }
        stopsBody = JSON.stringify(out);
      }
      return send(res, stopsBody, 'no-store');
    }
    if (url.pathname === '/api/stop') {
      const full = url.searchParams.get('id'), [i, sid] = splitId(full);
      if (!D[i]) return send(res, { error: 'fermata sconosciuta' }, 'no-store', 404);
      const labels = new Map(S[i].vehicles.filter(x => x.tripId && x.label).map(x => [x.tripId, x.label]));   // numero del mezzo per corsa
      const extra = i === 'nav' ? (REV.get(sid) || []).flatMap(a => schedule.departures(D.ali, S.ali.live, a).map(x => ({ ...x, src: 'ali', vehicle: null }))) : [];   // passaggi Alilaguna allo stesso pontile
      return send(res, { stop: { id: full, name: D[i].stops[sid] || sid, src: i }, updated: Date.now(), liveUpdated: S[i].updated,
                         note: [schedule.scheduleMode(D[i]), extra.length ? schedule.scheduleMode(D.ali) : 'ok'].map((m, k) => m === 'ok' ? null : (k ? '🛥️ ' : '') + m).filter(Boolean).join(' · ') || null,
                         departures: [...schedule.departures(D[i], S[i].live, sid).map(x => ({ ...x, src: i, vehicle: labels.get(x.tripId) || null })), ...extra] });
    }
    if (url.pathname === '/api/trip') {
      const full = url.searchParams.get('id'), [i, tid] = splitId(full);
      if (!D[i] || !D[i].stopTimes.has(tid)) return send(res, { error: 'corsa sconosciuta' }, 'no-store', 404);
      return send(res, tripDetail(i, tid, url.searchParams.get('mode') !== 'sched'));
    }
    if (url.pathname === '/api/routes') {          // solo nome/colore: i tracciati si chiedono a richiesta
      const out = {};
      for (const i of IDS) for (const r in D[i].routes) out[`${i}:${r}`] = { ...D[i].routes[r], src: i };
      return send(res, out, 'no-store');
    }
    if (url.pathname === '/api/shapes') {
      const [i, rid] = splitId(url.searchParams.get('id'));
      return send(res, { shapes: D[i]?.routeShapes[rid] || [] }, 'no-store');
    }
    if (url.pathname === '/api/debug') {
      const out = {};
      for (const i of IDS) {
        const G = D[i], ids = [...G.stopTimes.keys()], vs = S[i].vehicles;
        out[i] = { static: { trips: Object.keys(G.trips).length, tripsWithStopTimes: ids.length, sampleTripIds: ids.slice(0, 5),
                             sampleStopIds: Object.keys(G.stops).slice(0, 5) },
                   tripUpdates: S[i].diag,
                   vehicles: { total: vs.length, withTripId: vs.filter(v => v.tripId).length, sampleTripIds: vs.slice(0, 5).map(v => v.tripId) },
                   rawFeedSamples: S[i].raw, lastError: S[i].error,
                   schedule: (() => { try { return schedule.diagnose(G); } catch (e) { return { error: e.message }; } })(),
                   ready: ready[i], stopsCount: Object.keys(G.stops).length, scheduledNow: S[i].sched.vehicles.length };
      }
      out.stopAlias = ALIAS_REPORT;
      return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }), res.end(JSON.stringify(out, null, 2));
    }
  } catch (e) {
    console.error('Errore API:', e);
    return send(res, { error: e.message }, 'no-store', 500);
  }
  const page = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f));
  fs.readFile(page || '', (err, html) => {
    if (err) { res.writeHead(500); return res.end('index.html mancante: mettilo in public/ oppure accanto a server.js'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
