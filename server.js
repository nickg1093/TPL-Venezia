const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const protobuf = require('protobufjs');
const gtfs = require('./gtfs');
const schedule = require('./schedule');
const ids = require('./ids');
const motion = require('./motion');
const tracker = require('./tracker');
const { secsOfDayRome, hhmm } = schedule;

const PORT = process.env.PORT || 3000;
const REFRESH_MS = 6000;
const RT = { nav: 'https://tpl.actv.it/nav/GTFSRT/', aut: 'https://tpl.actv.it/aut/GTFSRT/' };
const IDS = Object.keys(RT);
const NOTES = { approx: 'data fuori dal calendario GTFS: orari indicativi' };

const Feed = protobuf.parse(`syntax = "proto2";
message FeedMessage { repeated FeedEntity entity = 2; }
message FeedEntity { optional string id = 1; optional TripUpdate trip_update = 3; optional VehiclePosition vehicle = 4; }
message TripUpdate { optional TripDescriptor trip = 1; repeated StopTimeUpdate stop_time_update = 2; optional int32 delay = 5; }
message StopTimeEvent { optional int32 delay = 1; optional int64 time = 2; }
message StopTimeUpdate { optional uint32 stop_sequence = 1; optional StopTimeEvent arrival = 2; optional StopTimeEvent departure = 3; optional string stop_id = 4; optional int32 schedule_relationship = 5; }
message TripDescriptor { optional string trip_id = 1; optional string start_time = 2; optional int32 schedule_relationship = 4; optional string route_id = 5; optional uint32 direction_id = 6; }
message VehicleDescriptor { optional string id = 1; optional string label = 2; }
message Position { optional float latitude = 1; optional float longitude = 2; optional float bearing = 3; optional float speed = 5; }
message VehiclePosition { optional TripDescriptor trip = 1; optional Position position = 2; optional uint32 current_stop_sequence = 3; optional int32 current_status = 4; optional uint64 timestamp = 5; optional string stop_id = 7; optional VehicleDescriptor vehicle = 8; }
`).root.lookupType('FeedMessage');

const D = {}, S = {}, ready = {};
for (const id of IDS) {
  D[id] = gtfs.empty(); ready[id] = false;
  S[id] = { updated: 0, error: null, vehicles: [], live: {}, hist: new Map(), track: new Map(), vs: new Map(), state: {} };
}

let cachedStopsGzip = null;
let version = 0;

function isNearby(lat1, lon1, lat2, lon2, maxMeters) {
  const dLat = Math.abs(lat1 - lat2) * 111000;
  if (dLat > maxMeters) return false;
  const dLon = Math.abs(lon1 - lon2) * 78000;
  if (dLon > maxMeters) return false;
  return (dLat * dLat + dLon * dLon) <= (maxMeters * maxMeters);
}

// Caricamento GTFS statico: i feed partono in parallelo; ognuno viene sostituito solo a lettura completata.
async function loadStatic() {
  await Promise.all(IDS.map(async id => {
    try {
      const g = await gtfs.load(id);
      if (!g) return;
      D[id] = g; S[id].hist.clear(); S[id].vs.clear(); S[id].state = {}; ready[id] = true; version++;
      cachedStopsGzip = null;
      refresh(id);
      console.log(`GTFS statico [${id}] caricato/aggiornato con successo.`);
    } catch (e) { console.error(`GTFS statico [${id}]:`, e.message); }
  }));
}

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const wrap = x => ((x + 43200) % 86400 + 86400) % 86400 - 43200;
const delayOf = (ev, sched) => {
  if (!ev) return null;
  if (has(ev, 'delay')) return Number(ev.delay);
  if (has(ev, 'time') && ev.time > 0) return wrap(secsOfDayRome(ev.time * 1000) - sched % 86400);
  return null;
};

function byStart(G) {
  if (G._bs) return G._bs;
  const bs = (G._bs = {});
  for (const [tid, st] of G.stopTimes) {
    const t = G.trips[tid]; if (!t) continue;
    (bs[`${t.route}||${st.start}`] ||= []).push(tid);
    if (t.dir != null) (bs[`${t.route}|${t.dir}|${st.start}`] ||= []).push(tid);
  }
  return bs;
}

// RISOLUZIONE CORSA: collega la corsa del realtime a quella del GTFS statico (vedi ids.js).
// 1) per ID (esatto o per suffisso univoco, immune a cambi di prefisso); 2) per linea + orario di partenza.
function resolveTrip(G, td) {
  if (!td || !G.idx) return null;
  const byId = ids.resolveTripId(G, td.tripId);
  if (byId && G.stopTimes.has(byId)) return byId;
  if (td.startTime) {
    const route = ids.resolveRouteId(G, td.routeId);
    const [h, m, s = 0] = td.startTime.split(':').map(Number), secs = h * 3600 + m * 60 + s, bs = byStart(G);
    if (route) for (const k of [has(td, 'directionId') ? `${route}|${td.directionId}|${secs}` : null, `${route}||${secs}`]) {
      const c = k && bs[k];
      if (c?.length) return c.find(x => schedule.isActiveToday(G, x)) || c[0];
    }
  }
  return null;
}

async function pull(base, name) {
  const res = await fetch(base + name, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const msg = Feed.decode(new Uint8Array(await res.arrayBuffer()));
  return Feed.toObject(msg, { longs: Number }).entity || [];
}

async function refresh(id) {
  const s8 = S[id];
  try {
    const [pos, upd] = await Promise.all([pull(RT[id], 'vehiclePositions'), pull(RT[id], 'tripUpdates')]);
    const G = D[id], live = {}, now = Date.now();
    for (const e of upd) {
      const tu = e.tripUpdate;
      if (!tu?.trip?.tripId) continue;
      const tid = resolveTrip(G, tu.trip); if (!tid) continue;
      const st = G.stopTimes.get(tid), n = st.s.length, explicit = new Array(n), skipped = new Set();
      let cur = 0, firstJ = -1;
      for (const u of tu.stopTimeUpdate || []) {
        if (u.scheduleRelationship === 2) continue;
        let j = -1;
        if (u.stopId) { j = st.s.indexOf(u.stopId, cur); if (j < 0) j = st.s.indexOf(u.stopId); }
        if (j < 0 && has(u, 'stopSequence')) j = st.q.indexOf(u.stopSequence);
        if (j < 0) continue;
        cur = j + 1;
        if (firstJ < 0) firstJ = j;
        if (u.scheduleRelationship === 1) skipped.add(j);
        let dly = delayOf(u.arrival, st.a[j]); if (dly == null) dly = delayOf(u.departure, st.d[j]);
        if (dly != null) explicit[j] = dly;
      }
      let c = has(tu, 'delay') ? Number(tu.delay) : null;
      const delays = new Array(n);
      for (let k = 0; k < n; k++) { if (explicit[k] != null) c = explicit[k]; delays[k] = c; }
      live[tid] = { delays, cancelled: tu.trip.scheduleRelationship === 3, skipped, firstJ };
      let h = s8.hist.get(tid); if (!h) s8.hist.set(tid, h = { delays: new Array(n).fill(null), seen: 0 });
      for (let k = 0; k < n; k++) if (explicit[k] != null) h.delays[k] = explicit[k];
      h.seen = now;
    }
    for (const [k, h] of s8.hist) if (now - h.seen > 3 * 3600 * 1000) s8.hist.delete(k);
    s8.live = live;
    s8.vehicles = pos.filter(e => Number.isFinite(e.vehicle?.position?.latitude) && Number.isFinite(e.vehicle.position.longitude))
      .map(e => {
        const v = e.vehicle, tripId = resolveTrip(G, v.trip), trip = G.trips[tripId] || {};
        const routeKey = trip.route || ids.resolveRouteId(G, v.trip?.routeId) || v.trip?.routeId || null, r = G.routes[routeKey] || {};
        return { id: `${id}:${v.vehicle?.id || e.id}`, src: id, label: v.vehicle?.label || null,
          lat: +v.position.latitude.toFixed(5), lon: +v.position.longitude.toFixed(5),
          // velocità: quella dichiarata dal feed se c'è, altrimenti calcolata dagli spostamenti; ts = istante del rilevamento GPS
          speed: (calc => Number.isFinite(v.position.speed) ? v.position.speed : calc)(motion.updateSpeed(s8.track, v.vehicle?.id || e.id, v.position.latitude, v.position.longitude, now)),
          stillS: motion.stillFor(s8.track, v.vehicle?.id || e.id, now),
          ts: v.timestamp ? Number(v.timestamp) * 1000 : now, bearing: v.position.bearing ?? null,
          status: v.currentStatus ?? null, seq: v.currentStopSequence ?? null,
          line: r.name || routeKey || '?', color: r.color || null, tripId,
          routeId: routeKey ? `${id}:${routeKey}` : null, headsign: trip.headsign || null };
      });
    for (const [k, p] of s8.track) if (now - p.t > 600000) s8.track.delete(k);   // mezzi non più visti
    s8.updated = now; s8.error = null;
    buildStates(id);
  } catch (err) {
    s8.error = `${id}: ${err.message} (Fallback attivo)`;
    try {
      const scheduledFallback = schedule.positionsNow(D[id]);
      s8.vehicles = scheduledFallback.map(v => ({
        ...v, tripId: v.id, id: `${id}:${v.id}`, src: id, routeId: v.routeId ? `${id}:${v.routeId}` : null
      }));
    } catch (_) {}
  }
}

// STATO UNICO DI UNA CORSA (fonte di verità condivisa da pannello fermata, dettaglio corsa e mappa):
//   cur = prossima fermata non ancora transitata; atStop = fermata in cui il mezzo è fermo ora (-1 se nessuna).
// Ordine delle prove: 1) indicazione del feed (prima fermata con previsione), 2) orario programmato se non c'è feed,
// 3) correzione con GPS + velocità + tracciato (motion.js), che prevale se il feed è in ritardo sul mezzo.
const tripNow = st => { const nowS = secsOfDayRome(Date.now()), fits = t => t >= st.start - 3600 && t <= st.end + 3600; return !fits(nowS) && fits(nowS + 86400) ? nowS + 86400 : nowS; };
// Ricalcolato a ogni polling per tutte le corse con dati live (feed e/o GPS). Lo leggono pannello fermata e dettaglio corsa:
// una sola fonte di verità, con memoria persistente per corsa (vedi tracker.js).
function buildStates(i) {
  const G = D[i], out = {}, now = Date.now(), byTrip = new Map();
  for (const v of S[i].vehicles) if (v.tripId) { const o = byTrip.get(v.tripId); if (!o || (v.ts || 0) > (o.ts || 0)) byTrip.set(v.tripId, v); }   // doppioni: il rilevamento più fresco
  for (const tid of new Set([...Object.keys(S[i].live), ...byTrip.keys()])) {
    const st = G.stopTimes.get(tid), trip = G.trips[tid]; if (!st || !trip) continue;
    let vs = S[i].vs.get(tid); if (!vs) S[i].vs.set(tid, vs = {});
    try { out[tid] = tracker.update({ G, trip, st, lv: S[i].live[tid], hist: S[i].hist.get(tid)?.delays, veh: byTrip.get(tid), tNow: tripNow(st), nowMs: now, vs }); }
    catch (e) { console.error('stato corsa', tid, e.message); }
  }
  for (const [k, vs] of S[i].vs) if (now - (vs.seen || 0) > 900000) S[i].vs.delete(k);
  S[i].state = out;
}

function tripDetail(i, tid, live) {
  const G = D[i], st = G.stopTimes.get(tid), trip = G.trips[tid], r = G.routes[trip.route] || {}, n = st.s.length;
  const tNow = tripNow(st), nowMs = Date.now();
  const lv = live ? S[i].live[tid] : null, hist = live ? S[i].hist.get(tid)?.delays : null;
  const at = k => (k === n - 1 ? st.a[k] : st.d[k]);
  const veh = live ? S[i].vehicles.find(x => x.tripId === tid) : null;
  // stesso stato usato dal pannello fermata; in modalità orario si calcola solo da orario programmato
  const ss = (live && S[i].state[tid]) || tracker.update({ G, trip, st, lv, hist, veh, tNow, nowMs, vs: {} });
  const cur = ss.cur, atStop = ss.atStop, offs = tracker.stopOffsets(G, trip, st);

  const stops = new Array(n);
  for (let k = 0; k < n; k++) {
    const sid = st.s[k], ts = at(k), future = k >= cur && Number.isFinite(ss.etaMs[k]);
    // dopo la fermata corrente: ritardo/anticipo dall'ETA stimata (feed + GPS); prima: ultima stima nota
    const dlS = live ? (future ? (ss.etaMs[k] - nowMs) / 1000 - (ts - tNow) : (hist?.[k] ?? null)) : null;
    stops[k] = {
      name: G.stops[sid] || sid,
      lat: G.stopLoc[sid]?.[0] ?? null, lon: G.stopLoc[sid]?.[1] ?? null,
      sched: hhmm(ts), exp: dlS != null ? hhmm(ts + dlS) : null, delay: dlS != null ? Math.round(dlS / 60) : null,
      expMs: future ? Math.round(ss.etaMs[k]) : null,
      inMin: future ? Math.round((ss.etaMs[k] - nowMs) / 60000) : Math.round((ts - tNow) / 60),
      state: k < cur ? 'passed' : (k === atStop ? 'at' : k === cur ? 'next' : 'upcoming'),
      phase: k === cur ? ss.phase : null, skipped: !!lv?.skipped.has(k)
    };
  }

  // posizione del mezzo tra due fermate: dal GPS lungo il tracciato se disponibile, altrimenti dagli orari
  let progress;
  if (atStop >= 0) progress = { from: atStop, frac: 0 };
  else if (cur >= n) progress = { from: n - 1, frac: 0 };
  else if (cur === 0) progress = { from: 0, frac: 0 };
  else {
    let frac;
    if (ss.sVeh != null && offs && offs[cur] > offs[cur - 1]) frac = (ss.sVeh - offs[cur - 1]) / (offs[cur] - offs[cur - 1]);
    else { const t0 = st.d[cur - 1], t1 = st.a[cur] + (ss.delayS || 0); frac = t1 > t0 ? (tNow - t0) / (t1 - t0) : 0; }
    progress = { from: cur - 1, frac: Math.min(1, Math.max(0, frac)) };
  }

  const dn = live && cur < n ? ss.delayS : null;
  return {
    live, progress, atStop, phase: ss.phase, speedKmh: ss.speed != null ? Math.round(ss.speed * 3.6) : null, cancelled: !!lv?.cancelled, note: noteOf(G),
    delayNow: dn != null ? Math.round(dn / 60) : null,
    historyKnown: stops.some(s => s.state === 'passed' && s.delay != null),
    trip: { src: i, line: r.name || trip.route, color: r.color || null, headsign: trip.headsign || G.stops[st.s[n - 1]] || null, vehicle: veh?.label || null },
    shape: gtfs.toLL(G.shapePts[trip.shape]), stops
  };
}

const noteOf = (G, date) => NOTES[schedule.scheduleMode(G, date)] || null;
const wanted = u => (u.searchParams.get('src') || IDS.join(',')).split(',').filter(x => IDS.includes(x));
const splitId = f => { const k = (f || '').indexOf(':'); return k < 0 ? [null, f] : [f.slice(0, k), f.slice(k + 1)]; };
const fail = (code, msg) => Object.assign(new Error(msg), { code });
const q = (u, k) => u.searchParams.get(k);
// Ordine di passaggio: per orario PREVISTO (con ritardo/anticipo reale), poi per orario programmato.
const byExpected = (a, b) => (a.expSec - b.expSec) || (a.schedIn - b.schedIn);
const mode = u => (q(u, 'secs') != null ? 'sched' : 'live');   // in modalità orario non c'è stato live

const getEquivalentStopIds = (G, sid) => {
  const loc = G.stopLoc[sid];
  if (!loc) return [sid];
  const nameA = G.stops[sid] || '';
  const equivalent = [];
  for (const sId in G.stops) {
    const sLoc = G.stopLoc[sId];
    if (!sLoc) continue;
    if (isNearby(loc[0], loc[1], sLoc[0], sLoc[1], 2)) {
      const nameB = G.stops[sId] || '';
      if (namesAreCompatible(nameA, nameB)) equivalent.push(sId);
    }
  }
  return equivalent.length > 0 ? equivalent : [sid];
};

function namesAreCompatible(n1, n2) {
  const clean1 = n1.toLowerCase().replace(/a\s*richiesta\w*/gi, '').replace(/[^\w\s]/g, '').trim();
  const clean2 = n2.toLowerCase().replace(/a\s*richiesta\w*/gi, '').replace(/[^\w\s]/g, '').trim();
  if (clean1.includes(clean2) || clean2.includes(clean1)) return true;
  const tokens1 = clean1.split(/\s+/).filter(w => w.length > 2);
  const tokens2 = clean2.split(/\s+/).filter(w => w.length > 2);
  return tokens1.some(t => tokens2.includes(t));
}

const API = {
  // Endpoint per forzare il ricaricamento dei GTFS statici aggiornati
  '/api/reload-gtfs': async (u, req, res) => {
    await loadStatic();
    return { success: true, message: "GTFS ricaricati con successo!" };
  },
  '/api/vehicles': u => {
    const list = wanted(u), errors = list.map(i => S[i].error).filter(Boolean);
    return { updated: Math.max(0, ...list.map(i => S[i].updated)), error: errors.join('; ') || null, version, ready,
             vehicles: list.flatMap(i => S[i].vehicles) };
  },
  '/api/scheduled': u => {
    const errors = [], vehicles = [];
    for (const i of wanted(u)) {
      try {
        for (const v of schedule.positionsNow(D[i], q(u, 'secs'), q(u, 'date')))
          vehicles.push({ ...v, tripId: v.id, id: `${i}:${v.id}`, src: i, routeId: v.routeId ? `${i}:${v.routeId}` : null });
      } catch (e) { errors.push(`${i}: ${e.message}`); }
    }
    return { updated: Date.now(), error: errors.join('; ') || null, version, ready, vehicles };
  },
  '/api/stops': (u, req, res) => {
    if (!cachedStopsGzip) {
      const out = [];
      for (const i of IDS) {
        const G = D[i];
        for (const s in G.stopIndex) { 
          const cleanName = G.stopBaseNames?.get(s) || G.stops[s];
          const l = G.stopLoc[s]; 
          if (l && cleanName) out.push([`${i}:${s}`, cleanName, l[0], l[1], i]); 
        }
      }
      cachedStopsGzip = zlib.gzipSync(Buffer.from(JSON.stringify(out)));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
    res.end(cachedStopsGzip);
    return null;
  },
  '/api/stop': u => {
    const full = q(u, 'id'), [i, sid] = splitId(full);
    const G = D[i];
    if (!G) throw fail(404, 'fermata sconosciuta');
    const labels = new Map(S[i].vehicles.filter(x => x.tripId && x.label).map(x => [x.tripId, x.label]));
    
    const equivalentSids = getEquivalentStopIds(G, sid);
    let allDepartures = [];
    for (const equivSid of equivalentSids) {
      const isReq = G.stopIsRequest?.get(equivSid) || false;
      for (const d of schedule.departures(G, S[i].live, equivSid, q(u, 'secs'), q(u, 'date'), mode(u) === 'sched' ? null : S[i].state)) {
        allDepartures.push({ ...d, isRequest: isReq });
      }
    }

    const uniqueMap = new Map();
    for (const d of allDepartures) uniqueMap.set(d.tripId, d);
    allDepartures = Array.from(uniqueMap.values());
    allDepartures.sort(byExpected);

    const cleanName = G.stopBaseNames?.get(sid) || G.stops[sid] || sid;

    return { 
      stop: { id: full, name: cleanName, src: i }, 
      liveUpdated: S[i].updated, 
      note: noteOf(G, q(u, 'date')),
      departures: allDepartures.map(x => ({ ...x, src: i, vehicle: labels.get(x.tripId) || null })) 
    };
  },
  '/api/zone': u => {
    const ids = (q(u, 'ids') || '').split(',').slice(0, 24), out = [], lab = {};
    if (!ids.some(f => D[splitId(f)[0]])) throw fail(404, 'zona sconosciuta');
    let note = null, liveUpdated = 0;
    for (const full of ids) {
      const [i, sid] = splitId(full); const G = D[i]; if (!G) continue;
      lab[i] ||= new Map(S[i].vehicles.filter(x => x.tripId && x.label).map(x => [x.tripId, x.label]));
      
      const equivalentSids = getEquivalentStopIds(G, sid);
      for (const equivSid of equivalentSids) {
        const isReq = G.stopIsRequest?.get(equivSid) || false;
        for (const x of schedule.departures(G, S[i].live, equivSid, q(u, 'secs'), q(u, 'date'), mode(u) === 'sched' ? null : S[i].state)) {
          out.push({ ...x, src: i, stop: full, vehicle: lab[i].get(x.tripId) || null, isRequest: isReq });
        }
      }
      note = noteOf(G, q(u, 'date')); liveUpdated = Math.max(liveUpdated, S[i].updated);
    }
    const zoneMap = new Map();
    for (const d of out) zoneMap.set(`${d.tripId}_${d.schedIn}`, d);
    const uniqueOut = Array.from(zoneMap.values());
    uniqueOut.sort(byExpected);
    return { liveUpdated, note, departures: uniqueOut.slice(0, 300) };
  },
  '/api/trip': u => {
    const [i, tid] = splitId(q(u, 'id'));
    if (!D[i] || !D[i].stopTimes.has(tid)) throw fail(404, 'corsa sconosciuta');
    return tripDetail(i, tid, q(u, 'mode') !== 'sched');
  },
  '/api/routes': () => {
    const out = {};
    for (const i of IDS) for (const r in D[i].routes) out[`${i}:${r}`] = { ...D[i].routes[r], src: i };
    return out;
  },
  '/api/shapes': u => {
    const [i, rid] = splitId(q(u, 'id'));
    return { shapes: (D[i]?.routeShapes[rid] || []).map(p => gtfs.toLL(p)) };
  }
};

function send(req, res, obj, code = 200) {
  const body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  const head = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (body.length < 1024 || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(code, head); return res.end(body); }
  zlib.gzip(body, (err, z) => { res.writeHead(code, err ? head : { ...head, 'Content-Encoding': 'gzip' }); res.end(err ? body : z); });
}

const pageFile = ['public/index.html', 'index.html'].map(f => path.join(__dirname, f)).find(f => fs.existsSync(f));
const page = pageFile ? fs.readFileSync(pageFile) : null;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost'), handler = API[u.pathname];
  if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); }
  if (handler) {
    try {
      const resVal = await handler(u, req, res);
      if (resVal !== null) send(req, res, resVal);
    } catch (e) { send(req, res, { error: e.message }, e.code || 500); }
    return;
  }
  res.writeHead(page ? 200 : 500, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page || 'index.html mancante');
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));

// Ogni feed ha il proprio ciclo: indipendenti e in parallelo; un ciclo lento non ne blocca né ne sovrappone un altro.
for (const id of IDS) (async function loop() { const t0 = Date.now(); await refresh(id); setTimeout(loop, Math.max(1000, REFRESH_MS - (Date.now() - t0))); })();
loadStatic();
setInterval(loadStatic, 24 * 3600 * 1000);

// KEEP-ALIVE Render (piano gratuito): si addormenta dopo 15 min senza richieste HTTP in ingresso.
// Il server si auto-contatta dall'esterno (URL pubblico) ogni 10 min finché è sveglio;
// per svegliarlo da spento serve comunque un pinger esterno su /healthz (vedi README).
const SELF = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL;
if (SELF) setInterval(() => fetch(SELF.replace(/\/$/, '') + '/healthz', { signal: AbortSignal.timeout(15000) }).catch(() => {}), 10 * 60 * 1000);
