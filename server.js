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
const { audit } = require('./feedaudit');
const crypto = require('crypto');
const tide = require('./tide');
const { secsOfDayRome, hhmm } = schedule;

const PORT = process.env.PORT || 3000;
// Intervallo di lettura dei feed ACTV. 3 s: i dati cambiano ogni pochi secondi; i feed invariati NON vengono rielaborati
// (ETag/If-Modified-Since + confronto del contenuto). In caso di errori si rallenta da sé (vedi loop in fondo).
const REFRESH_MS = +process.env.RT_POLL_MS || 2000;   // massimo; la lettura si adatta al ritmo di pubblicazione del feed (min 1 s)
const RT = { nav: 'https://tpl.actv.it/nav/GTFSRT/', aut: 'https://tpl.actv.it/aut/GTFSRT/' };
const IDS = Object.keys(RT);
const NOTES = { approx: 'data fuori dal calendario GTFS: orari indicativi' };

const Feed = protobuf.parse(`syntax = "proto2";
message FeedHeader { optional string gtfs_realtime_version = 1; optional uint32 incrementality = 2; optional uint64 timestamp = 3; }
message FeedMessage { optional FeedHeader header = 1; repeated FeedEntity entity = 2; }
message FeedEntity { optional string id = 1; optional TripUpdate trip_update = 3; optional VehiclePosition vehicle = 4; }
message TripUpdate { optional TripDescriptor trip = 1; repeated StopTimeUpdate stop_time_update = 2; optional int32 delay = 5; }
message StopTimeEvent { optional int32 delay = 1; optional int64 time = 2; optional int32 uncertainty = 3; }
message StopTimeUpdate { optional uint32 stop_sequence = 1; optional StopTimeEvent arrival = 2; optional StopTimeEvent departure = 3; optional string stop_id = 4; optional int32 schedule_relationship = 5; }
message TripDescriptor { optional string trip_id = 1; optional string start_time = 2; optional int32 schedule_relationship = 4; optional string route_id = 5; optional uint32 direction_id = 6; }
message VehicleDescriptor { optional string id = 1; optional string label = 2; }
message Position { optional float latitude = 1; optional float longitude = 2; optional float bearing = 3; optional float speed = 5; }
message VehiclePosition { optional TripDescriptor trip = 1; optional Position position = 2; optional uint32 current_stop_sequence = 3; optional int32 current_status = 4; optional uint64 timestamp = 5; optional string stop_id = 7; optional VehicleDescriptor vehicle = 8; optional int32 congestion_level = 6; optional int32 occupancy_status = 9; }
`).root.lookupType('FeedMessage');

const D = {}, S = {}, ready = {};
for (const id of IDS) {
  D[id] = gtfs.empty(); ready[id] = false;
  S[id] = { updated: 0, error: null, vehicles: [], live: {}, hist: new Map(), track: new Map(), vs: new Map(), state: {}, snap: new Map(), sig: new Map(), owner: new Map(), cache: {}, raw: {}, match: {}, errCount: 0, feedTs: null };
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
      D[id] = g; S[id].hist.clear(); S[id].vs.clear(); S[id].snap.clear(); S[id].state = {}; ready[id] = true; version++;
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

// Lettura di un feed GTFS-RT. Ritorna { ents, headerTs, changed }:
//  - richiesta condizionale (ETag / If-Modified-Since): 304 = nessun dato nuovo
//  - se i byte sono identici al giro precedente non si decodifica nulla (changed = false)
//  - i byte grezzi restano disponibili per /api/audit
async function pull(id, name) {
  const s8 = S[id], c = (s8.cache[name] ||= {}), h = {};
  if (c.etag) h['If-None-Match'] = c.etag;
  if (c.lm) h['If-Modified-Since'] = c.lm;
  const res = await fetch(RT[id] + name, { signal: AbortSignal.timeout(8000), headers: h });
  if (res.status === 304 && c.ents) return { ents: c.ents, headerTs: c.headerTs, changed: false };
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  s8.raw[name] = { buf, at: Date.now() };
  c.etag = res.headers.get('etag'); c.lm = res.headers.get('last-modified');
  const hash = crypto.createHash('md5').update(buf).digest('hex');
  if (hash === c.hash && c.ents) return { ents: c.ents, headerTs: c.headerTs, changed: false };
  const o = Feed.toObject(Feed.decode(new Uint8Array(buf)), { longs: Number });
  Object.assign(c, { hash, ents: o.entity || [], headerTs: o.header?.timestamp ? Number(o.header.timestamp) : null });
  return { ents: c.ents, headerTs: c.headerTs, changed: true };
}

async function refresh(id) {
  const s8 = S[id];
  try {
    // i due feed si leggono in parallelo
    const [P, U] = await Promise.all([pull(id, 'vehiclePositions'), pull(id, 'tripUpdates')]);
    const G = D[id], live = {}, now = Date.now(), pos = P.ents, upd = U.ents;
    s8.errCount = 0; s8.feedTs = P.headerTs ? P.headerTs * 1000 : null;
    if (P.changed) {   // ritmo con cui ACTV pubblica davvero nuovi dati: si legge ~3 volte più spesso, senza sprechi
      if (s8.lastChange) { const iv = Math.min(60000, Math.max(500, now - s8.lastChange)); s8.pubMs = s8.pubMs ? 0.7 * s8.pubMs + 0.3 * iv : iv; }
      s8.lastChange = now;
    }
    if (!P.changed && !U.changed && s8.vehicles.length && s8.updated) {   // nessun dato nuovo: si aggiorna solo il tempo trascorso
      s8.updated = now; buildStates(id); push(false); return;
    }
    let tuOk = 0, vOk = 0;
    for (const e of upd) {
      const tu = e.tripUpdate;
      if (!tu?.trip?.tripId) continue;
      const tid = resolveTrip(G, tu.trip); if (!tid) continue;
      tuOk++;
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
      // quando il feed ha cambiato per l'ultima volta i ritardi di questa corsa: ne misura l'"età" (peso nelle stime)
      const sig = delays.join(','), pv = s8.sig.get(tid), changedAt = pv && pv.sig === sig ? pv.t : now; s8.sig.set(tid, { sig, t: changedAt });
      live[tid] = { delays, cancelled: tu.trip.scheduleRelationship === 3, skipped, firstJ, changedAt };
      let h = s8.hist.get(tid); if (!h) s8.hist.set(tid, h = { delays: new Array(n).fill(null), seen: 0 });
      for (let k = 0; k < n; k++) if (explicit[k] != null) h.delays[k] = explicit[k];
      h.seen = now;
    }
    for (const [k, h] of s8.hist) if (now - h.seen > 3 * 3600 * 1000) { s8.hist.delete(k); s8.sig.delete(k); }
    s8.live = live;
    s8.vehicles = pos.filter(e => Number.isFinite(e.vehicle?.position?.latitude) && Number.isFinite(e.vehicle.position.longitude))
      .map(e => {
        const v = e.vehicle, tripId = resolveTrip(G, v.trip), trip = G.trips[tripId] || {}, key = v.vehicle?.id || e.id;
        if (tripId) vOk++;
        // istante del rilevamento: del veicolo, altrimenti dell'intestazione del feed, altrimenti di scarico (nell'ordine)
        const ts = v.timestamp ? Number(v.timestamp) * 1000 : (P.headerTs ? P.headerTs * 1000 : now);
        const routeKey = trip.route || ids.resolveRouteId(G, v.trip?.routeId) || v.trip?.routeId || null, r = G.routes[routeKey] || {};
        return { id: `${id}:${v.vehicle?.id || e.id}`, src: id, label: v.vehicle?.label || null,
          lat: +v.position.latitude.toFixed(5), lon: +v.position.longitude.toFixed(5),
          // velocità: dichiarata dal feed se c'è, altrimenti da due rilevamenti successivi / differenza dei loro timestamp
          speed: (calc => Number.isFinite(v.position.speed) ? v.position.speed : calc)(motion.updateSpeed(s8.track, key, v.position.latitude, v.position.longitude, ts, now)),
          stillS: motion.stillFor(s8.track, key), vInst: motion.instSpeed(s8.track, key), key, ts, bearing: v.position.bearing ?? null,
          status: v.currentStatus ?? null, seq: v.currentStopSequence ?? null,
          line: r.name || routeKey || '?', color: r.color || null, tripId,
          routeId: routeKey ? `${id}:${routeKey}` : null, headsign: trip.headsign || null };
      });
    for (const [k, p] of s8.track) if (now - p.arr > 600000) { s8.track.delete(k); s8.snap.delete(k); }   // mezzi non più visti
    s8.match = { tripUpdates: { total: upd.length, collegati: tuOk }, veicoli: { total: pos.length, collegati: vOk } };
    s8.updated = now; s8.error = null;
    pickOwners(id); buildStates(id); push(true);
  } catch (err) {
    s8.errCount++; s8.error = `${id}: ${err.message} (Fallback attivo)`;
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
const tripNow = st => { const ms = Date.now(), nowS = secsOfDayRome(ms) + (ms % 1000) / 1000, fits = t => t >= st.start - 3600 && t <= st.end + 3600; return !fits(nowS) && fits(nowS + 86400) ? nowS + 86400 : nowS; };
// Ricalcolato a ogni polling per tutte le corse con dati live (feed e/o GPS). Lo leggono pannello fermata e dettaglio corsa:
// una sola fonte di verità, con memoria persistente per corsa (vedi tracker.js).
// AGGANCIO AL TRACCIATO. Il GPS resta la verità: se il mezzo è a meno di 45 m dalla linea lo si disegna SULLA linea
// (nei canali e nelle calli un rettilineo tra due punti attraverserebbe terra o acqua); oltre, resta la posizione grezza.
// A ogni nuovo rilevamento si calcola il tratto di tracciato percorso dal rilevamento precedente: il client muove il mezzo
// lungo quel tratto, mai in rettilineo e mai oltre l'ultimo punto realmente ricevuto.
const SNAP_MAX_M = 45;
function snapToRoute(i, G, trip, veh, ss) {
  veh.rlat ??= veh.lat; veh.rlon ??= veh.lon;   // posizione GPS grezza, conservata
  if (ss.sVeh == null || ss.lateral > SNAP_MAX_M) { S[i].snap.delete(veh.key); return; }
  const sh = tracker.shapeInfo(G, trip.shape), prev = S[i].snap.get(veh.key), here = tracker.pointAt(sh, ss.sVeh);
  veh.lat = +here[0].toFixed(5); veh.lon = +here[1].toFixed(5);
  if (prev && prev.shape === trip.shape && prev.ts !== veh.ts) {
    const d = ss.sVeh - prev.s;
    if (d > 0.5 && d < 4000) veh.path = tracker.slice(sh, prev.s, ss.sVeh);
  }
  if (!prev || prev.ts !== veh.ts) S[i].snap.set(veh.key, { s: ss.sVeh, shape: trip.shape, ts: veh.ts });
}

// MEZZI MULTIPLI SULLA STESSA CORSA. Possono essere legittimi (rinforzi, due mezzi uno dietro l'altro) oppure un errore di assegnazione
// (mezzo che non ha chiuso la corsa precedente, ID sbagliato). Si distinguono dalla COERENZA col percorso:
//  - il PRINCIPALE è il più coerente: distanza dal tratto in cui la corsa dovrebbe trovarsi (secondo il feed; senza feed, l'orario),
//    distanza dal tracciato, età del dato, bonus di continuità (nessun rimbalzo)
//  - un altro mezzo è RINFORZO (v.co) se è sul tracciato, nel tratto atteso (tolleranza 600 m) e a non più di 2,5 km dal principale:
//    mantiene la corsa, con stato e passaggio propri (max 3)
//  - altrimenti è un DOPPIONE (v.dup): resta sulla mappa ma senza corsa, per non falsare nessuno stato
const CO_GAP_M = 2500, CO_DEV_M = 600, CO_MAX = 3;
function pickOwners(i) {
  const G = D[i], s8 = S[i], now = Date.now(), groups = new Map();
  for (const v of s8.vehicles) { v.co = false; v.dup = null; if (v.tripId) { let a = groups.get(v.tripId); if (!a) groups.set(v.tripId, a = []); a.push(v); } }
  for (const [tid, list] of groups) {
    if (list.length === 1) { s8.owner.set(tid, list[0].key); continue; }
    const st = G.stopTimes.get(tid), trip = G.trips[tid], lv = s8.live[tid];
    const offs = st && trip ? tracker.stopOffsets(G, trip, st) : null, sh = offs ? tracker.shapeInfo(G, trip.shape) : null;
    let lo = 0, hi = Infinity;
    if (offs) {
      const n = st.s.length; let c = lv && lv.firstJ >= 0 ? lv.firstJ : 0;
      if (!(lv && lv.firstJ >= 0)) { const t = tripNow(st); while (c < n - 1 && st.d[c] <= t) c++; }
      const w = lv && lv.firstJ >= 0 ? 300 : 800;   // senza feed la finestra è più larga (il ritardo è ignoto)
      lo = offs[Math.max(0, c - 1)] - w; hi = offs[Math.min(n - 1, c)] + w;
    }
    const prev = s8.owner.get(tid);
    const info = v => {
      let sc = Math.min(300, (now - (s8.track.get(v.key)?.arr || now)) / 1000) * 8, s = null, dev = Infinity;
      const pr = sh ? tracker.project(sh, v.lat, v.lon, null) : null;
      if (pr && pr.lat <= 120) { s = pr.s; dev = pr.s < lo ? lo - pr.s : pr.s > hi ? pr.s - hi : 0; sc += dev + pr.lat; } else sc += sh ? 3000 : 1000;
      return { v, s, dev, sc: v.key === prev ? sc - 400 : sc };
    };
    const ranked = list.map(info).sort((a, b) => a.sc - b.sc), win = ranked[0];
    s8.owner.set(tid, win.v.key);
    let nco = 0;
    for (const r of ranked.slice(1)) {
      if (r.s != null && win.s != null && r.dev <= CO_DEV_M && Math.abs(r.s - win.s) <= CO_GAP_M && nco < CO_MAX) { r.v.co = true; nco++; }
      else { r.v.dup = tid; r.v.dupWith = win.v.label || win.v.key; r.v.tripId = null; }
    }
  }
  for (const k of [...s8.owner.keys()]) if (!groups.has(k)) s8.owner.delete(k);
}

function buildStates(i) {
  const G = D[i], out = {}, now = Date.now(), byTrip = new Map();
  for (const v of S[i].vehicles) if (v.tripId && !v.co) { const o = byTrip.get(v.tripId); if (!o || (v.ts || 0) > (o.ts || 0)) byTrip.set(v.tripId, v); }   // doppioni: il rilevamento più fresco
  for (const tid of new Set([...Object.keys(S[i].live), ...byTrip.keys()])) {
    const st = G.stopTimes.get(tid), trip = G.trips[tid]; if (!st || !trip) continue;
    let vs = S[i].vs.get(tid); if (!vs) S[i].vs.set(tid, vs = {});
    const veh = byTrip.get(tid), tp = veh && S[i].track.get(veh.key);
    if (veh && vs.ownerKey && vs.ownerKey !== veh.key) for (const k of Object.keys(vs)) delete vs[k];   // cambio di mezzo: la memoria dell'altro non vale
    if (veh) vs.ownerKey = veh.key;
    const lv0 = S[i].live[tid]; if (lv0) lv0.ageS = (now - (lv0.changedAt || now)) / 1000;
    if (veh) veh.ageS = tp ? (now - tp.arr) / 1000 : 0;               // secondi dall'ultimo rilevamento NUOVO (orologio nostro)
    try {
      out[tid] = tracker.update({ G, trip, st, lv: S[i].live[tid], hist: S[i].hist.get(tid)?.delays, veh, tNow: tripNow(st), nowMs: now, vs });
      if (veh) snapToRoute(i, G, trip, veh, out[tid]);
    }
    catch (e) { console.error('stato corsa', tid, e.message); }
  }
  // rinforzi: stato proprio per ogni mezzo (senza trip update: il feed descrive il principale), annidato nello stato della corsa
  for (const v of S[i].vehicles) {
    if (!v.co || !v.tripId) continue;
    const st = G.stopTimes.get(v.tripId), trip = G.trips[v.tripId], prim = out[v.tripId]; if (!st || !trip || !prim) continue;
    const vk = v.tripId + '|' + v.key; let vs = S[i].vs.get(vk); if (!vs) S[i].vs.set(vk, vs = {});
    const tp = S[i].track.get(v.key); v.ageS = tp ? (now - tp.arr) / 1000 : 0;
    try { const r = tracker.update({ G, trip, st, lv: null, hist: null, veh: v, tNow: tripNow(st), nowMs: now, vs }); snapToRoute(i, G, trip, v, r); (prim.co ||= []).push(r); }
    catch (e) { console.error('stato rinforzo', v.key, e.message); }
  }
  for (const [k, vs] of S[i].vs) if (now - (vs.seen || 0) > 900000) S[i].vs.delete(k);
  S[i].state = out;
}

function tripDetail(i, tid, live, vehKey = null) {
  const G = D[i], st = G.stopTimes.get(tid), trip = G.trips[tid], r = G.routes[trip.route] || {}, n = st.s.length;
  const tNow = tripNow(st), nowMs = Date.now();
  // mezzo di cui si mostra la corsa: quello richiesto (dal marker o dal pannello fermata) se è un rinforzo, altrimenti il principale
  const prim = live ? S[i].state[tid] : null;
  const pick = prim && vehKey && prim.vehKey !== vehKey ? (prim.co || []).find(c => c.vehKey === vehKey) : null;
  const sel = pick || prim;
  const lv = live ? S[i].live[tid] : null, hist = live && !pick ? S[i].hist.get(tid)?.delays : null;   // feed e storico descrivono il principale
  const at = k => (k === n - 1 ? st.a[k] : st.d[k]);
  const veh = live ? (sel?.vehKey ? S[i].vehicles.find(x => x.key === sel.vehKey) : S[i].vehicles.find(x => x.tripId === tid && !x.co)) : null;
  // stesso stato usato dal pannello fermata; in modalità orario si calcola solo da orario programmato
  const ss = sel || tracker.update({ G, trip, st, lv, hist, veh, tNow, nowMs, vs: {} });
  const others = live && prim ? [prim, ...(prim.co || [])].filter(x => x.vehKey !== ss.vehKey).map(x => x.label).filter(Boolean) : [];
  const cur = ss.cur, atStop = ss.atStop, offs = tracker.stopOffsets(G, trip, st);

  const stops = new Array(n); let prevAct = -Infinity;
  for (let k = 0; k < n; k++) {
    const sid = st.s[k], ts = at(k), future = k >= cur && Number.isFinite(ss.etaMs[k]);
    // dopo la fermata corrente: ritardo/anticipo dall'ETA stimata (feed + GPS); prima: ultima stima nota
    // ritardo: fermate future = ETA stimata; fermate transitate = istante in cui abbiamo visto il mezzo ripartire, altrimenti l'ultima
    // stima del feed MAI nel futuro; i passaggi non possono tornare indietro nel tempo
    let dlS = null;
    if (live) {
      if (future) dlS = (ss.etaMs[k] - nowMs) / 1000 - (ts - tNow);
      else if (ss.dep?.[k]) dlS = (tNow - (nowMs - ss.dep[k]) / 1000) - ts;
      else if (hist?.[k] != null) dlS = Math.min(hist[k], tNow - ts);
      if (dlS != null && k < cur) { dlS = Math.max(dlS, prevAct - ts); prevAct = ts + dlS; }
    }
    stops[k] = {
      name: G.stops[sid] || sid,
      lat: G.stopLoc[sid]?.[0] ?? null, lon: G.stopLoc[sid]?.[1] ?? null,
      sched: hhmm(ts), exp: dlS != null ? hhmm(ts + Math.round(dlS / 60) * 60) : null, delay: dlS != null ? Math.round(dlS / 60) : null,   // stessa regola del pannello fermata
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
    live, progress, atStop, phase: ss.phase, vehKey: ss.vehKey ?? null, others, speedKmh: ss.speed != null ? Math.round(ss.speed * 3.6) : null, cancelled: !!lv?.cancelled, note: noteOf(G),
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

// AGGIORNAMENTO A SPINTA (Server-Sent Events): a ogni ciclo il server avvisa i browser collegati.
// "1" = dati nuovi dal feed (ricaricare mezzi e pannelli); "0" = solo tempo trascorso (ricaricare i pannelli aperti).
const sse = new Set();
const push = changed => { const m = `data: ${changed ? 1 : 0}\n\n`; for (const r of sse) { try { r.write(m); } catch { sse.delete(r); } } };
setInterval(() => { for (const r of sse) { try { r.write(': ping\n\n'); } catch { sse.delete(r); } } }, 20000);   // evita che i proxy chiudano la connessione

// risposta marea con cache breve: più utenti = una sola richiesta al portale
let tideCache = { t: 0, v: null };
async function getTideCached(debug) {
  if (!debug && tideCache.v && Date.now() - tideCache.t < 30000) return tideCache.v;
  const v = await tide.getTide({ debug }); if (!debug) tideCache = { t: Date.now(), v }; return v;
}

const API = {
  // Endpoint per forzare il ricaricamento dei GTFS statici aggiornati
  '/api/reload-gtfs': async (u, req, res) => {
    await loadStatic();
    return { success: true, message: "GTFS ricaricati con successo!" };
  },
  '/api/vehicles': u => {
    const list = wanted(u), errors = list.map(i => S[i].error).filter(Boolean);
    return { updated: Math.max(0, ...list.map(i => S[i].updated)), feedTs: Math.max(0, ...list.map(i => S[i].feedTs || 0)) || null,
             error: errors.join('; ') || null, version, ready, vehicles: list.flatMap(i => S[i].vehicles) };
  },
  // MAREA: livello attuale, tendenza e prossimi estremi (CPSM Venezia, open data). ?debug=1 mostra un campione grezzo della previsione.
  '/api/tide': async u => getTideCached(u.searchParams.get('debug') === '1'),
  // ANALISI FEED: campi standard compilati/mancanti, campi proprietari ACTV, collegamento con il GTFS statico.
  // Apri /api/audit (o /api/audit?src=aut) e inviami il risultato per tarare il software sul feed reale.
  '/api/audit': u => Object.fromEntries(wanted(u).map(i => [i, {
    intervalloLetturaMs: REFRESH_MS, periodoPubblicazioneStimatoMs: S[i].pubMs ? Math.round(S[i].pubMs) : null, ultimoAggiornamento: S[i].updated ? new Date(S[i].updated).toISOString() : null,
    etaFeedSecondi: S[i].feedTs ? Math.round((Date.now() - S[i].feedTs) / 1000) : null,
    collegamentoGtfsStatico: S[i].match,                      // "collegati" vicino a "total" = versione GTFS statica corretta
    veicoli: S[i].raw.vehiclePositions ? audit(S[i].raw.vehiclePositions.buf) : null,
    tripUpdates: S[i].raw.tripUpdates ? audit(S[i].raw.tripUpdates.buf) : null
  }])),
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
    for (const d of allDepartures) uniqueMap.set(`${d.tripId}|${d.veh ?? ''}`, d);   // stessa corsa con più mezzi: un passaggio per mezzo
    allDepartures = Array.from(uniqueMap.values());
    allDepartures.sort(byExpected);

    const cleanName = G.stopBaseNames?.get(sid) || G.stops[sid] || sid;

    return { 
      stop: { id: full, name: cleanName, src: i }, 
      liveUpdated: S[i].updated, 
      note: noteOf(G, q(u, 'date')),
      departures: allDepartures.map(x => ({ ...x, src: i, vehicle: x.vehLabel || labels.get(x.tripId) || null })) 
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
          out.push({ ...x, src: i, stop: full, vehicle: x.vehLabel || lab[i].get(x.tripId) || null, isRequest: isReq });
        }
      }
      note = noteOf(G, q(u, 'date')); liveUpdated = Math.max(liveUpdated, S[i].updated);
    }
    const zoneMap = new Map();
    for (const d of out) zoneMap.set(`${d.tripId}_${d.schedIn}_${d.veh ?? ''}`, d);
    const uniqueOut = Array.from(zoneMap.values());
    uniqueOut.sort(byExpected);
    return { liveUpdated, note, departures: uniqueOut.slice(0, 300) };
  },
  '/api/trip': u => {
    const [i, tid] = splitId(q(u, 'id'));
    if (!D[i] || !D[i].stopTimes.has(tid)) throw fail(404, 'corsa sconosciuta');
    return tripDetail(i, tid, q(u, 'mode') !== 'sched', q(u, 'veh'));
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

// FILE STATICI della cartella public/ (pagina, manifest, service worker, icone), letti una volta all'avvio e già compressi.
// Il service worker e la pagina non vanno tenuti in cache dal browser (si aggiornano subito); le icone sì.
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const statics = new Map();
(function load(dir, base = '') {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name), url = base + '/' + f.name;
    if (f.isDirectory()) { load(full, url); continue; }
    const ext = path.extname(f.name).toLowerCase(), body = fs.readFileSync(full), text = /^\.(html|js|webmanifest|json|svg)$/.test(ext);
    const head = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.png' ? 'public, max-age=604800' : 'no-cache' };
    if (f.name === 'sw.js') head['Service-Worker-Allowed'] = '/';
    statics.set(url, { head, body, gz: text ? zlib.gzipSync(body) : null });
  }
})(PUB);
const page = statics.get('/index.html');
function serveStatic(req, res, ent) {
  const gz = ent.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, gz ? { ...ent.head, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' } : ent.head);
  res.end(req.method === 'HEAD' ? undefined : (gz ? ent.gz : ent.body));
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost'), handler = API[u.pathname];
  if (u.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n'); sse.add(res); req.on('close', () => sse.delete(res)); return;
  }
  if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); }
  if (handler) {
    try {
      const resVal = await handler(u, req, res);
      if (resVal !== null) send(req, res, resVal);
    } catch (e) { send(req, res, { error: e.message }, e.code || 500); }
    return;
  }
  const ent = statics.get(u.pathname === '/' ? '/index.html' : u.pathname);
  if (ent) return serveStatic(req, res, ent);
  if (u.pathname.includes('.') && !u.pathname.endsWith('.html')) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Non trovato'); }   // file inesistente: 404 vero
  if (page) return serveStatic(req, res, page);
  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('public/index.html mancante');
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));

// Ogni feed ha il proprio ciclo: indipendenti e in parallelo; un ciclo lento non ne blocca né ne sovrappone un altro.
for (const id of IDS) (async function loop() { const t0 = Date.now(); await refresh(id); const base = Math.min(REFRESH_MS, Math.max(1000, (S[id].pubMs || REFRESH_MS * 3) / 3)); setTimeout(loop, Math.max(500, Math.min(30000, base * 2 ** Math.min(S[id].errCount, 4)) - (Date.now() - t0))); })();
loadStatic();
setInterval(loadStatic, 24 * 3600 * 1000);
tide.start();   // raccolta periodica del livello di marea: costruisce la storia da cui si ricava la tendenza

// KEEP-ALIVE Render (piano gratuito): si addormenta dopo 15 min senza richieste HTTP in ingresso.
// Il server si auto-contatta dall'esterno (URL pubblico) ogni 10 min finché è sveglio;
// per svegliarlo da spento serve comunque un pinger esterno su /healthz (vedi README).
const SELF = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL;
if (SELF) setInterval(() => fetch(SELF.replace(/\/$/, '') + '/healthz', { signal: AbortSignal.timeout(15000) }).catch(() => {}), 10 * 60 * 1000);
