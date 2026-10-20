const http = require('http');
const fs = require('fs');
const path = path = require('path');
const zlib = require('zlib');
const protobuf = require('protobufjs');
const gtfs = require('./gtfs');
const schedule = require('./schedule');
const { secsOfDayRome, hhmm } = schedule;

const PORT = process.env.PORT || 3000;
const REFRESH_MS = 8000;
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
message Position { optional float latitude = 1; optional float longitude = 2; }
message VehiclePosition { optional TripDescriptor trip = 1; optional Position position = 2; optional VehicleDescriptor vehicle = 8; }
`).root.lookupType('FeedMessage');

const D = {}, S = {}, ready = {};
for (const id of IDS) {
  D[id] = gtfs.empty(); ready[id] = false;
  S[id] = { updated: 0, error: null, vehicles: [], live: {}, hist: new Map() };
}

// CACHE PRE-SERIALIZZATA E COMPRESSA IN RAM (Punto 2)
let cachedStopsGzip = null;
let version = 0;

// OTTIMIZZAZIONE MATEMATICA: DISTANZA QUADRATO MANHATTAN (Punto 1 - Zero Math.sqrt)
function isNearby(lat1, lon1, lat2, lon2, maxMeters) {
  const dLat = Math.abs(lat1 - lat2) * 111000;
  if (dLat > maxMeters) return false;
  const dLon = Math.abs(lon1 - lon2) * 78000;
  if (dLon > maxMeters) return false;
  return (dLat * dLat + dLon * dLon) <= (maxMeters * maxMeters);
}

async function loadStatic() {
  for (const id of IDS) {
    try {
      const g = await gtfs.load(id);
      if (!g) continue;
      D[id] = g; S[id].hist.clear(); ready[id] = true; version++;
      cachedStopsGzip = null; // Invalida la cache per rigenerarla al primo accesso
      refresh(id);
    } catch (e) { console.error(`GTFS statico [${id}]:`, e.message); }
  }
}

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const wrap = x => ((x + 43200) % 86400 + 86400) % 86400 - 43200;
const delayOf = (ev, sched) => {
  if (!ev) return null;
  if (has(ev, 'delay')) return Number(ev.delay);
  if (has(ev, 'time') && ev.time > 0) return wrap(secsOfDayRome(ev.time * 1000) - sched % 86400);
  return null;
};

function resolveTrip(G, td) {
  if (!td) return null;
  const id = td.tripId;
  if (id && G.stopTimes.has(id)) return id;
  if (id) {
    const body = id.replace(/^[A-Za-z]+_/, '');
    for (const p of G.tripPrefixes) if (G.stopTimes.has(p + body)) return p + body;
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
    }
    s8.live = live;
    s8.vehicles = pos.filter(e => Number.isFinite(e.vehicle?.position?.latitude) && Number.isFinite(e.vehicle.position.longitude))
      .map(e => {
        const v = e.vehicle, tripId = resolveTrip(G, v.trip), trip = G.trips[tripId] || {};
        const routeKey = trip.route || v.trip?.routeId || null, r = G.routes[routeKey] || {};
        return { id: `${id}:${v.vehicle?.id || e.id}`, src: id, label: v.vehicle?.label || null,
          lat: +v.position.latitude.toFixed(5), lon: +v.position.longitude.toFixed(5),
          line: r.name || routeKey || '?', color: r.color || null, tripId,
          routeId: routeKey ? `${id}:${routeKey}` : null, headsign: trip.headsign || null };
      });
    s8.updated = now; s8.error = null;
  } catch (err) { s8.error = `${id}: ${err.message}`; }
}

function tripDetail(i, tid, live) {
  const G = D[i], st = G.stopTimes.get(tid), trip = G.trips[tid], r = G.routes[trip.route] || {}, n = st.s.length;
  const tNow = secsOfDayRome(Date.now());
  const lv = live ? S[i].live[tid] : null;
  const at = k => (k === n - 1 ? st.a[k] : st.d[k]);
  
  let cur = lv && lv.firstJ >= 0 ? lv.firstJ : 0;
  if (!(lv && lv.firstJ >= 0)) while (cur < n && at(cur) <= tNow) cur++;

  const veh = live ? S[i].vehicles.find(x => x.tripId === tid) : null;
  const departureTime = st.d[0] ?? st.a[0];

  // Controllo vicinanza capolinea ottimizzato senza radici quadrate (Punto 1)
  const originLoc = G.stopLoc[st.s[0]];
  const isAtOriginBeforeDeparture = (tNow < departureTime) || 
    (cur === 0 && veh && originLoc && isNearby(veh.lat, veh.lon, originLoc[0], originLoc[1], 100));

  if (isAtOriginBeforeDeparture) cur = 0;

  const stops = new Array(n);
  for (let k = 0; k < n; k++) {
    const sid = st.s[k], ts = at(k);
    let dl = live ? (k >= cur ? (lv ? lv.delays[k] : null) : null) : null;
    if (isAtOriginBeforeDeparture) dl = 0;

    stops[k] = { 
      name: G.stops[sid] || sid, 
      lat: G.stopLoc[sid]?.[0] ?? null, lon: G.stopLoc[sid]?.[1] ?? null,
      sched: hhmm(ts), exp: dl != null ? hhmm(ts + dl) : null, delay: dl != null ? Math.round(dl / 60) : null,
      inMin: Math.round((ts + (dl ?? 0) - tNow) / 60),
      state: k < cur ? 'passed' : (k === cur ? 'next' : 'upcoming'), 
      skipped: !!lv?.skipped.has(k) 
    };
  }

  const dn = isAtOriginBeforeDeparture ? 0 : (lv && cur < n ? lv.delays[cur] : null);

  return { 
    live, progress: { from: Math.max(0, cur - 1), frac: 0 }, cancelled: !!lv?.cancelled,
    delayNow: dn != null ? Math.round(dn / 60) : null,
    trip: { src: i, line: r.name || trip.route, color: r.color || null, headsign: trip.headsign || G.stops[st.s[n - 1]] || null, vehicle: veh?.label || null },
    shape: gtfs.toLL(G.shapePts[trip.shape]), stops 
  };
}

const wanted = u => (u.searchParams.get('src') || IDS.join(',')).split(',').filter(x => IDS.includes(x));
const splitId = f => { const k = (f || '').indexOf(':'); return k < 0 ? [null, f] : [f.slice(0, k), f.slice(k + 1)]; };
const q = (u, k) => u.searchParams.get(k);

const API = {
  '/api/vehicles': u => ({ updated: Math.max(0, ...wanted(u).map(i => S[i].updated)), ready, vehicles: wanted(u).flatMap(i => S[i].vehicles) }),
  '/api/stops': (u, req, res) => {
    // RISPOSTA DIRETTAMENTE DAL BUFFER PRE-COMPRESSO IN RAM (Punto 2)
    if (!cachedStopsGzip) {
      const out = [];
      for (const i of IDS) {
        for (const s in D[i].stopIndex) {
          const l = D[i].stopLoc[s];
          if (l) out.push([`${i}:${s}`, D[i].stops[s], l[0], l[1], i]);
        }
      }
      const raw = Buffer.from(JSON.stringify(out));
      cachedStopsGzip = zlib.gzipSync(raw);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
    res.end(cachedStopsGzip);
    return null;
  },
  '/api/trip': u => {
    const [i, tid] = splitId(q(u, 'id'));
    return tripDetail(i, tid, q(u, 'mode') !== 'sched');
  },
  '/api/routes': () => {
    const out = {};
    for (const i of IDS) for (const r in D[i].routes) out[`${i}:${r}`] = { ...D[i].routes[r], src: i };
    return out;
  }
};

function send(req, res, obj) {
  const body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const pageFile = path.join(__dirname, 'index.html');
const page = fs.existsSync(pageFile) ? fs.readFileSync(pageFile) : null;

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost'), handler = API[u.pathname];
  if (handler) {
    const result = handler(u, req, res);
    if (result !== null) send(req, res, result);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page || 'index.html mancante');
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));

for (const id of IDS) setInterval(() => refresh(id), REFRESH_MS);
loadStatic();
