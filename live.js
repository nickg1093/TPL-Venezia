// MOTORE TEMPO REALE. Legge i feed GTFS-RT di ACTV, li collega al GTFS statico e mantiene per ogni corsa uno stato unico
// (dove si trova il mezzo, in quale fase, quando arriva) da cui dipendono mappa, pannello fermata e dettaglio corsa.
// L'HTTP sta in server.js; qui non c'è nulla di web. Gli aggiornamenti si annunciano con l'evento 'push' (vedi events).
const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const protobuf = require('protobufjs');
const gtfs = require('./gtfs');
const store = require('./gtfsstore');
const schedule = require('./schedule');
const cal = require('./calendar');
const ids = require('./ids');
const motion = require('./motion');
const tracker = require('./tracker');
const assign = require('./assign');
const turni = require('./turni');
const { inArea } = require('./geo');
const { secsOfDayRome, hhmm } = schedule;

const events = new EventEmitter();
// LETTURA DEI FEED: UNA sola lettura per servizio, condivisa da tutti gli utenti (gli utenti non contattano mai ACTV).
// Ritmo: quello di pubblicazione del feed, ma non più spesso di MIN_POLL_MS (3 s) né più raramente di REFRESH_MS (5 s, RT_POLL_MS per cambiarlo).
// ACTV rigenera il feed circa ogni secondo, ma ogni mezzo trasmette la sua posizione ogni 10-30 s: leggere ogni 3-5 s non perde dati e,
// con richieste condizionali (304 se nulla è cambiato), pesa pochissimo sui server degli open data (prassi delle app di settore: 5-30 s).
const MIN_POLL_MS = 3000;
const REFRESH_MS = Math.min(30000, Math.max(MIN_POLL_MS, +process.env.RT_POLL_MS || 5000));
const RT = { nav: 'https://tpl.actv.it/nav/GTFSRT/', aut: 'https://tpl.actv.it/aut/GTFSRT/' };
const IDS = Object.keys(RT);
const NOTES = { approx: 'data fuori dal calendario GTFS: orari indicativi' };

// ---- CONTROMISURE SUI DATI IN ARRIVO (soglie) ----
const LAG_DROP_MS = 20 * 60e3;      // rilevamento più vecchio di 20 min: mezzo "fantasma", non si disegna
const OLD_FLAG_MS = 3 * 60e3;       // più vecchio di 3 min: si disegna ma segnalato come non aggiornato
const FUTURE_TS_MS = 60e3;          // timestamp nel futuro oltre 1 min: orologio del feed sballato, si usa l'ora di arrivo
const MAX_DELAY_S = 4 * 3600;       // ritardi oltre 4 ore: dato incoerente, ignorato
const SIM_AFTER_ERRORS = 3;         // errori consecutivi di lettura prima di passare alle posizioni da orario...
const SIM_AFTER_MS = 3 * 60e3;      // ...oppure nessun dato valido da 3 minuti
const START_TOL_S = 600;            // tolleranza fra l'orario di partenza dichiarato dal feed e quello della corsa trovata per codice
// POSIZIONE BLOCCATA (registrazione del 6/11/2026): coordinate identiche per oltre 10 minuti, oppure ricomparse identiche dopo un silenzio,
// LONTANO dalle fermate (in fermata sono normali: il sistema ACTV aggancia il mezzo al punto della fermata, osservati 0-14 m).
// Il caso reale: battello 191 a 169 m dalla fermata, coordinate delle 17:30 ripresentate alle 18:10 con l'orario aggiornato.
const FROZEN_SAME_S = 600, FROZEN_STOP_M = 60;
// CORSA CONCLUSA ANCHE PER ACTV: mezzo fermo da 2 minuti davanti all'ultima fermata, la cui previsione ACTV (che c'era) è sparita da 1 minuto.
const END_STILL_S = 120, END_TU_GONE_MS = 60e3, ENDED_KEEP_MS = 6 * 3600e3;

// Schema GTFS-RT (solo i campi usati). I nomi diventano camelCase in uscita (tripUpdate, stopTimeUpdate, ...).
const Feed = protobuf.parse(`syntax = "proto2";
message FeedHeader { optional string gtfs_realtime_version = 1; optional uint32 incrementality = 2; optional uint64 timestamp = 3; }
message FeedMessage { optional FeedHeader header = 1; repeated FeedEntity entity = 2; }
message FeedEntity { optional string id = 1; optional bool is_deleted = 2; optional TripUpdate trip_update = 3; optional VehiclePosition vehicle = 4; }
message TripUpdate { optional TripDescriptor trip = 1; repeated StopTimeUpdate stop_time_update = 2; optional VehicleDescriptor vehicle = 3; optional uint64 timestamp = 4; optional int32 delay = 5; }
message StopTimeEvent { optional int32 delay = 1; optional int64 time = 2; optional int32 uncertainty = 3; }
message StopTimeUpdate { optional uint32 stop_sequence = 1; optional StopTimeEvent arrival = 2; optional StopTimeEvent departure = 3; optional string stop_id = 4; optional int32 schedule_relationship = 5; }
message TripDescriptor { optional string trip_id = 1; optional string start_time = 2; optional string start_date = 3; optional int32 schedule_relationship = 4; optional string route_id = 5; optional uint32 direction_id = 6; }
message VehicleDescriptor { optional string id = 1; optional string label = 2; }
message Position { optional float latitude = 1; optional float longitude = 2; optional float bearing = 3; optional float speed = 5; }
message VehiclePosition { optional TripDescriptor trip = 1; optional Position position = 2; optional uint32 current_stop_sequence = 3; optional int32 current_status = 4; optional uint64 timestamp = 5; optional string stop_id = 7; optional VehicleDescriptor vehicle = 8; optional int32 congestion_level = 6; optional int32 occupancy_status = 9; }
`).root.lookupType('FeedMessage');

// D = GTFS statico per servizio; S = stato tempo reale per servizio
const D = {}, S = {}, ready = {};
for (const id of IDS) {
  D[id] = gtfs.empty(); ready[id] = false;
  S[id] = { updated: 0, goodAt: 0, error: null, vehicles: [], live: {}, hist: new Map(), track: new Map(), vs: new Map(), state: {}, snap: new Map(), sig: new Map(), owner: new Map(),
    cache: {}, raw: {}, match: {}, errCount: 0, feedTs: null, sim: false, lastAgree: null,
    fixes: new Map(),   // ultima posizione di ogni mezzo (anche dopo che è sparito): coordinate ricomparse identiche = GPS bloccato (motion.js)
    ended: new Map() }; // corse CONCLUSE (capolinea raggiunto): corsa -> { veh, at }. Non si riaprono: il mezzo che le dichiara ancora ne è staccato
}
let version = 0;        // cresce a ogni nuovo GTFS statico caricato: il client ricarica fermate e linee
let cachedStopsGzip = null;
const dropStopsCache = () => { cachedStopsGzip = null; };

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const wrap = x => ((x + 43200) % 86400 + 86400) % 86400 - 43200;

// Distanza (m) dalla fermata più vicina del servizio. Griglia di celle di ~0,005° costruita una volta per GTFS: si guardano le 9 celle attorno
// (oltre ~400 m il valore esatto non serve: basta sapere che è lontano).
function nearStopM(G, lat, lon) {
  const K = 200;                                                                  // celle per grado (~550 m in latitudine)
  let g = G._sgrid;
  if (!g) {
    g = new Map();
    for (const sid in G.stopLoc) { const L = G.stopLoc[sid]; if (!L) continue; const c = Math.floor(L[0] * K) + ':' + Math.floor(L[1] * K); (g.get(c) || g.set(c, []).get(c)).push(L); }
    Object.defineProperty(G, '_sgrid', { value: g, enumerable: false });
  }
  const ci = Math.floor(lat * K), cj = Math.floor(lon * K), mLon = 111320 * Math.cos(lat * Math.PI / 180);
  let best = Infinity;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const L of g.get((ci + a) + ':' + (cj + b)) || []) {
    const d = Math.hypot((L[0] - lat) * 111320, (L[1] - lon) * mLon); if (d < best) best = d;
  }
  return best;
}
// GPS bloccato? same = { s: secondi con coordinate identiche, afterGap: ricomparse identiche dopo un silenzio } (motion.sameFor)
const frozenAt = (G, lat, lon, same) => (same.afterGap || same.s >= FROZEN_SAME_S) && nearStopM(G, lat, lon) > FROZEN_STOP_M;
// ritardo (s) di un evento: dichiarato dal feed, oppure ricavato dall'orario assoluto; null se manca o è assurdo
const delayOf = (ev, sched) => {
  if (!ev) return null;
  let d = null;
  if (has(ev, 'delay')) d = Number(ev.delay);
  else if (has(ev, 'time') && ev.time > 0) d = wrap(secsOfDayRome(ev.time * 1000) - sched % 86400);
  return d != null && Number.isFinite(d) && Math.abs(d) <= MAX_DELAY_S ? d : null;
};

// ---- COLLEGAMENTO REALTIME -> STATICO ----
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
const startSecs = td => { if (!td?.startTime) return null; const [h, m, s = 0] = td.startTime.split(':').map(Number); const v = h * 3600 + m * 60 + s; return Number.isFinite(v) ? v : null; };

// La corsa trovata per codice è davvero quella del feed? Se un aggiornamento del GTFS ha rinumerato le corse lo stesso codice può indicare
// un'altra corsa: si confrontano linea e orario di partenza dichiarati dal feed. Ritorna true/false (true se il feed non dichiara nulla da confrontare).
function agrees(G, tid, td) {
  const t = G.trips[tid], st = G.stopTimes.get(tid), rid = td.routeId ? ids.resolveRouteId(G, td.routeId) : null;
  if (rid && t && rid !== t.route) return false;
  const s = startSecs(td);
  if (s != null && st) { const d = Math.abs((st.start - s) % 86400); if (Math.min(d, 86400 - d) > START_TOL_S) return false; }
  return true;
}

// RISOLUZIONE CORSA: 1) per codice (esatto o per suffisso univoco, immune ai cambi di prefisso) PURCHÉ coerente con linea e orario;
// 2) per linea + orario di partenza (+ direzione). strict=false: il controllo di coerenza è sospeso (vedi valvola in refresh).
function resolveTrip(G, td, strict = true, tally = null) {
  if (!td || !G.idx) return null;
  const byId = ids.resolveTripId(G, td.tripId);
  if (byId && G.stopTimes.has(byId)) {
    const ok = agrees(G, byId, td);
    if (tally) ok ? tally.ok++ : tally.bad++;
    if (ok || !strict) return byId;
  }
  const secs = startSecs(td);
  if (secs != null) {
    const route = ids.resolveRouteId(G, td.routeId), bs = byStart(G);
    if (route) for (const k of [has(td, 'directionId') ? `${route}|${td.directionId}|${secs}` : null, `${route}||${secs}`]) {
      const c = k && bs[k];
      if (c?.length) return c.find(x => schedule.isActiveToday(G, x)) || c[0];
    }
  }
  return null;
}

const MAX_FEED_BYTES = 20e6;   // un feed reale pesa poche centinaia di KB: oltre 20 MB è un errore o un abuso
// Lettura di un feed GTFS-RT. Ritorna { ents, headerTs, changed }:
//  - richiesta condizionale (ETag / If-Modified-Since): 304 = nessun dato nuovo
//  - se i byte sono identici al giro precedente non si decodifica nulla (changed = false)
//  - i byte grezzi restano disponibili per /api/audit
async function pull(id, name) {
  const s8 = S[id], c = (s8.cache[name] ||= {}), h = {};
  if (c.etag) h['If-None-Match'] = c.etag;
  if (c.lm) h['If-Modified-Since'] = c.lm;
  const res = await fetch(RT[id] + name, { signal: AbortSignal.timeout(8000), headers: h });
  const len = +res.headers.get('content-length') || 0;
  if (len > MAX_FEED_BYTES) throw new Error(`${name}: risposta troppo grande (${len} byte)`);
  if (res.status === 304 && c.ents) return { ents: c.ents, headerTs: c.headerTs, changed: false };
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FEED_BYTES) throw new Error(`${name}: risposta troppo grande`);
  s8.raw[name] = { buf, at: Date.now() };
  c.etag = res.headers.get('etag'); c.lm = res.headers.get('last-modified');
  const hash = crypto.createHash('md5').update(buf).digest('hex');
  if (hash === c.hash && c.ents) return { ents: c.ents, headerTs: c.headerTs, changed: false };
  const o = Feed.toObject(Feed.decode(new Uint8Array(buf)), { longs: Number });
  Object.assign(c, { hash, ents: o.entity || [], headerTs: o.header?.timestamp ? Number(o.header.timestamp) : null });
  return { ents: c.ents, headerTs: c.headerTs, changed: true };
}
// ---- CICLO DI LETTURA DI UN SERVIZIO ----
// 1) scarica i due feed in parallelo; 2) trip update -> ritardi per fermata di ogni corsa; 3) posizioni -> mezzi validi;
// 4) sceglie il mezzo "titolare" di ogni corsa; 5) ricalcola lo stato di ogni corsa; 6) avvisa i browser.
async function refresh(id) {
  const s8 = S[id];
  try {
    const [P, U] = await Promise.all([pull(id, 'vehiclePositions'), pull(id, 'tripUpdates')]);
    const G = D[id], now = Date.now(), pos = P.ents, upd = U.ents;
    s8.errCount = 0; s8.feedTs = P.headerTs ? P.headerTs * 1000 : null;
    if (P.changed) {   // ritmo con cui ACTV pubblica davvero nuovi dati: si legge ~3 volte più spesso, senza sprechi
      if (s8.lastChange) { const iv = Math.min(60000, Math.max(500, now - s8.lastChange)); s8.pubMs = s8.pubMs ? 0.7 * s8.pubMs + 0.3 * iv : iv; }
      s8.lastChange = now;
    }
    if (!P.changed && !U.changed && s8.vehicles.length && s8.updated && !s8.sim) {   // nessun dato nuovo: si aggiorna solo il tempo trascorso
      s8.updated = now; buildStates(id); events.emit('push', false); return;
    }
    const today = cal.romeYmd(now), yesterday = cal.addDays(today, -1);
    const dayOk = sd => !sd || sd === today || sd === yesterday;     // un trip update di altri giorni non descrive la corsa di oggi
    // Valvola: se quasi tutti i collegamenti per codice risultano incoerenti, probabilmente il feed dichiara l'orario in un altro modo
    // (non quello di partenza): meglio fidarsi dei codici che scartare tutto.
    const la = s8.lastAgree, strict = !(la && la.ok + la.bad >= 10 && la.bad / (la.ok + la.bad) > 0.8), tally = { ok: 0, bad: 0 };
    let tuOk = 0, vOk = 0, wrongDay = 0, skippedDeleted = 0;
    const tuOfVeh = new Map(), vehOfTu = new Map(), tuCand = new Map();                   // il trip update dice anche QUALE mezzo fa la corsa: serve a verificare le corse dichiarate

    // 2) TRIP UPDATE
    for (const e of upd) {
      if (e.isDeleted) { skippedDeleted++; continue; }
      const tu = e.tripUpdate;
      if (!tu?.trip || (!tu.trip.tripId && !tu.trip.startTime)) continue;
      if (!dayOk(tu.trip.startDate)) { wrongDay++; continue; }
      const tid = resolveTrip(G, tu.trip, strict, tally); if (!tid) continue;
      tuOk++;
      const tvk = tu.vehicle?.id ? String(tu.vehicle.id) : null; if (tvk) { tuOfVeh.set(tvk, tid); vehOfTu.set(tid, tvk); }
      const st = G.stopTimes.get(tid), n = st.s.length, explicit = new Array(n), skipped = new Set();
      let cur = 0, firstJ = -1;
      for (const u of tu.stopTimeUpdate || []) {
        if (u.scheduleRelationship === 2) continue;                       // NO_DATA: nessuna informazione per questa fermata
        // fermata: per codice (anche con prefisso diverso), altrimenti per numero di sequenza
        let j = -1; const sid = u.stopId ? (ids.resolveStopId(G, u.stopId) || u.stopId) : null;
        if (sid) { j = st.s.indexOf(sid, cur); if (j < 0) j = st.s.indexOf(sid); }
        if (j < 0 && has(u, 'stopSequence')) j = st.q.indexOf(u.stopSequence);
        if (j < 0) continue;
        cur = j + 1;
        if (firstJ < 0) firstJ = j;
        if (u.scheduleRelationship === 1) skipped.add(j);                 // SKIPPED: fermata saltata
        let dly = delayOf(u.arrival, st.a[j]); if (dly == null) dly = delayOf(u.departure, st.d[j]);
        if (dly != null) explicit[j] = dly;
      }
      let c = has(tu, 'delay') ? Number(tu.delay) : null;
      if (c != null && Math.abs(c) > MAX_DELAY_S) c = null;
      const delays = new Array(n);
      for (let k = 0; k < n; k++) { if (explicit[k] != null) c = explicit[k]; delays[k] = c; }
      // quando il feed ha cambiato per l'ultima volta i ritardi di questa corsa: ne misura l'"età" (peso nelle stime)
      // ACTV pubblica una previsione PER MEZZO: due mezzi sulla stessa corsa = due previsioni. Si sceglie dopo (chooseTU), quando si sa
      // quale mezzo fa davvero la corsa: la previsione di un altro mezzo (es. fermo al capolinea) non deve finire sulla corsa giusta.
      (tuCand.get(tid) || tuCand.set(tid, []).get(tid)).push({ veh: tvk, explicit, entry: { delays, cancelled: tu.trip.scheduleRelationship === 3, skipped, firstJ } });
    }

    // 3) POSIZIONI: solo rilevamenti sensati. Per ogni mezzo si tiene il più recente (il feed può ripeterlo).
    const byKey = new Map(); let bad = 0, ghost = 0;
    for (const e of pos) {
      const v = e.vehicle; if (e.isDeleted || !v?.position) continue;
      const lat = v.position.latitude, lon = v.position.longitude;
      if (!inArea(lat, lon)) { bad++; continue; }                        // 0,0 / coordinate scambiate / fuori area
      let ts = v.timestamp ? Number(v.timestamp) * 1000 : (P.headerTs ? P.headerTs * 1000 : now);
      if (ts > now + FUTURE_TS_MS) ts = now;
      if (now - ts > LAG_DROP_MS) { ghost++; continue; }                 // mezzo fermo da ore con dato vecchio
      const key = v.vehicle?.id || e.id; if (!key) continue;
      const prev = byKey.get(key); if (!prev || ts > prev.ts) byKey.set(key, { e, ts });
    }
    s8.vehicles = [...byKey.values()].map(({ e, ts }) => {
      const v = e.vehicle, tripId = resolveTrip(G, v.trip, strict, tally), trip = G.trips[tripId] || {}, key = v.vehicle?.id || e.id;
      if (tripId) vOk++;
      const routeKey = trip.route || ids.resolveRouteId(G, v.trip?.routeId) || v.trip?.routeId || null, r = G.routes[routeKey] || {};
      return { id: `${id}:${key}`, src: id, label: v.vehicle?.label || null,
        lat: +v.position.latitude.toFixed(5), lon: +v.position.longitude.toFixed(5),
        // velocità: dichiarata dal feed se plausibile (0..45 m/s), altrimenti da due rilevamenti successivi / differenza dei loro timestamp
        speed: (calc => Number.isFinite(v.position.speed) && v.position.speed >= 0 && v.position.speed < 45 ? v.position.speed : calc)(motion.updateSpeed(s8.track, key, v.position.latitude, v.position.longitude, ts, now, s8.fixes)),
        stillS: motion.stillFor(s8.track, key), vInst: motion.instSpeed(s8.track, key), key, ts, old: now - ts > OLD_FLAG_MS, bearing: v.position.bearing ?? null,
        frozen: frozenAt(G, v.position.latitude, v.position.longitude, motion.sameFor(s8.track, key)),
        status: v.currentStatus ?? null, seq: v.currentStopSequence ?? null,
        line: r.name || routeKey || '?', color: r.color || null, tripId,
        routeId: routeKey && has(G.routes, routeKey) ? `${id}:${routeKey}` : null, headsign: trip.headsign || null };
    });
    for (const [k, p] of s8.track) if (now - p.arr > 600000) { s8.track.delete(k); s8.snap.delete(k); }   // mezzi non più visti
    for (const [k, f] of s8.fixes) if (now - f.t > 3 * 3600e3) s8.fixes.delete(k);
    for (const v of s8.vehicles) if (v.frozen) v.old = true;            // posizione bloccata: sulla mappa come dato non aggiornato
    s8.lastAgree = tally;
    s8.match = { tripUpdates: { total: upd.length, collegati: tuOk, altroGiorno: wrongDay, eliminati: skippedDeleted },
      veicoli: { total: pos.length, collegati: vOk, posizioneNonValida: bad, datoTroppoVecchio: ghost },
      coerenzaCodici: { coerenti: tally.ok, incoerenti: tally.bad, controlloAttivo: strict } };
    s8.updated = now; s8.goodAt = now; s8.error = null; s8.sim = false;
    const idle = verifyTrips(id, tuOfVeh), vacated = applyTurni(id, vehOfTu, now);
    pickOwners(id); chooseTU(id, tuCand, idle, vacated, now); dedupePassages(id, now); buildStates(id); events.emit('push', true);
  } catch (err) {
    s8.errCount++; s8.error = `${id}: ${err.message}`;
    // I dati reali restano finché sono recenti; solo dopo vari errori (o 3 minuti senza dati) si passa alle posizioni da orario, dichiarate come tali.
    if (s8.sim || (s8.errCount >= SIM_AFTER_ERRORS || Date.now() - s8.goodAt > SIM_AFTER_MS)) {
      try {
        s8.vehicles = schedule.positionsNow(D[id]).map(v => ({ ...v, tripId: v.id, id: `${id}:${v.id}`, src: id, sim: true, routeId: v.routeId ? `${id}:${v.routeId}` : null }));
        s8.sim = true; s8.state = {}; s8.live = {};
      } catch { /* senza GTFS non c'è nulla da simulare */ }
    }
  }
}

// CORSA DEL MEZZO (vedi assign.js): si segue ACTV. Ritorna l'insieme dei mezzi staccati dalla corsa (fermi al capolinea ben oltre l'orario).
function verifyTrips(i, tuOfVeh) {
  const G = D[i], s8 = S[i], mem = (s8.assign ||= new Map()), idle = new Set();
  const list = s8.vehicles.filter(v => !v.sim && v.tripId);
  for (const v of list) v.feedTripId = v.tripId;
  let plan = new Map();
  try { plan = assign.plan({ G, vehicles: list, mem, tuOfVeh, tNowOf: tripNow }); } catch (e) { console.error('corsa dei mezzi:', e.message); }
  for (const v of list) {
    const r = plan.get(v.key); if (!r) continue;
    const from = G.stopTimes.get(v.tripId);
    if (r.idle) { v.idle = { why: r.idle.why, trip: from ? schedule.hhmm(from.start) : null }; v.tripId = null; idle.add(String(v.key)); continue; }
    if (r.tid === v.tripId) continue;
    const trip = G.trips[r.tid], rt = G.routes[trip.route] || {};
    v.tripId = r.tid; v.line = rt.name || v.line; v.color = rt.color || v.color; v.headsign = trip.headsign || v.headsign;
    v.routeId = has(G.routes, trip.route) ? `${i}:${trip.route}` : v.routeId;
    v.reassigned = { from: from ? schedule.hhmm(from.start) : null, why: r.why };
  }
  // POSIZIONE BLOCCATA o CORSA GIÀ CONCLUSA: il mezzo resta sulla mappa ma si stacca dalla corsa (che non riapre e non riceve posizioni
  // o ritardi falsi). Registrazione del 6/11: battello 16 arrivato a P.le Roma e ripartito con la corsa finita (riavvolta fino a +66 min);
  // battello 191 con le coordinate di 40 minuti prima (corsa finita riaperta a +43 min). Si riassocia da solo quando dichiara un'altra corsa.
  for (const v of list) {
    if (!v.tripId) continue;
    const why = v.frozen ? 'posizione bloccata' : s8.ended.has(v.tripId) ? 'corsa conclusa' : null;
    if (!why) continue;
    const from = G.stopTimes.get(v.tripId);
    v.idle = { why, trip: from ? schedule.hhmm(from.start) : null }; v.tripId = null; idle.add(String(v.key));
  }
  if (s8.match) {
    s8.match.corseDaTripUpdate = s8.vehicles.filter(v => v.reassigned?.why === 'tu').map(v => ({ mezzo: v.label || v.key, posizione: v.feedTripId, tripUpdate: v.tripId }));
    s8.match.nonAssociati = s8.vehicles.filter(v => v.idle).map(v => ({ mezzo: v.label || v.key, corsa: v.feedTripId, motivo: v.idle.why }));
  }
  return idle;
}

// TURNO DEL MEZZO (vedi turni.js): mezzo molto in ritardo sulla corsa del feed che di fatto fa la corsa successiva. Si applica qui, una volta
// per lettura e prima dello stato delle corse, perché mappa, pannello fermata e pannello del mezzo dicano la stessa cosa.
// Ritorna Map(corsa lasciata -> mezzo): quelle corse restano senza mezzo e senza le previsioni che erano del mezzo.
let turnoCheck = null;                                  // controllo esterno facoltativo dei turni (non collegato dalla v24: era la centrale ACTV)
const setTurnoCheck = f => { turnoCheck = f; };
const activeNow = (G, tid, st) => { const t = G.trips[tid], ymd = cal.romeYmd(); return !!t && schedule.serviceActive(G, t.service, tripNow(st) >= 86400 ? cal.addDays(ymd, -1) : ymd); };
function applyTurni(i, vehOfTu, now) {
  const G = D[i], s8 = S[i], mem = (s8.turni ||= new Map()), vacated = new Map();
  const list = s8.vehicles.filter(v => !v.sim && v.tripId);
  let p = new Map();
  try { p = turni.plan({ G, vehicles: list, prev: s8.state, vehOfTu, mem, nowMs: now, tNowOf: tripNow, activeNow, check: turnoCheck ? (sid, line, eta, sched) => turnoCheck(i, sid, line, eta, sched) : null }); }
  catch (e) { console.error('turni dei mezzi:', e.message); }
  for (const v of list) {
    const r = p.get(v.key); if (!r) continue;
    const from = G.stopTimes.get(r.from), trip = G.trips[r.to];
    v.tripId = r.to; v.headsign = trip.headsign || v.headsign;
    v.reassigned = { from: from ? schedule.hhmm(from.start) : null, why: 'turno' };
    vacated.set(r.from, String(v.key));
  }
  s8.vacated = vacated;
  if (s8.match) s8.match.corseDelTurno = list.filter(v => v.reassigned?.why === 'turno').map(v => ({ mezzo: v.label || v.key, corsaDelFeed: v.feedTripId, corsaVera: v.tripId }));
  return vacated;
}

// PREVISIONE ACTV DI OGNI CORSA: quella del mezzo che fa la corsa (titolare scelto da pickOwners); altrimenti quella senza mezzo o di un
// mezzo non staccato; mai quella di un mezzo staccato (i suoi "ritardi" erano solo il tempo che passava al capolinea).
function chooseTU(i, cand, idle, vacated, now) {
  const s8 = S[i], live = {}, onTrip = new Map();
  for (const v of s8.vehicles) if (v.tripId && !v.sim) onTrip.set(String(v.key), v.tripId);
  for (const [tid, list] of cand) {
    if (s8.ended.has(tid)) continue;                                      // corsa conclusa: le previsioni rimaste aperte non la riaprono
    // escluse: previsioni di mezzi staccati e quelle del mezzo che ha lasciato questa corsa per quella del suo turno (turni.js)
    // e quelle di un mezzo che il GPS mostra su UN'ALTRA corsa (ACTV continua a prevedere corse vecchie con quel mezzo: 4.1 a Guglie il 3/11,
    // corse delle 13:49 e 14:29 «in ritardo di 140 e 101 min» = il battello della 16:09)
    const owner = s8.owner.get(tid), ok = list.filter(x => !(x.veh && (idle.has(x.veh) || vacated.get(tid) === x.veh || (onTrip.has(x.veh) && onTrip.get(x.veh) !== tid))));
    const pick = ok.find(x => owner != null && x.veh === String(owner)) || ok.find(x => !x.veh) || ok[0];
    if (!pick) continue;
    const e = pick.entry, n = e.delays.length;
    const sig = e.delays.join(','), pv = s8.sig.get(tid), changedAt = pv && pv.sig === sig ? pv.t : now; s8.sig.set(tid, { sig, t: changedAt });
    live[tid] = { ...e, changedAt, veh: pick.veh };
    let h = s8.hist.get(tid); if (!h) s8.hist.set(tid, h = { delays: new Array(n).fill(null), seen: 0 });
    for (let k = 0; k < n; k++) if (pick.explicit[k] != null) h.delays[k] = pick.explicit[k];
    h.seen = now;
  }
  for (const [k, h] of s8.hist) if (now - h.seen > 3 * 3600 * 1000) { s8.hist.delete(k); s8.sig.delete(k); }
  s8.live = live;
}

// UN PASSAGGIO, UNA RIGA (3/11/2026). ACTV pubblica previsioni anche per corse che nessun mezzo fa (o che il suo sistema tiene «aperte»):
// il ritardo viene trascinato fino al primo mezzo che passerà davvero. A Guglie la 4.1 delle 13:49 «+140» e quella delle 14:29 «+101» erano
// il battello della 16:09: tre righe per un passaggio. Vale anche per i mezzi SENZA GPS (non tutte le corse sono tracciate): il confronto si fa
// con il passaggio, non con il mezzo.
// Corsa X con la sola previsione del feed (nessun mezzo la fa) e ritardo di almeno 10 minuti alla prossima fermata:
//   a) se la sua previsione cade sul passaggio di una corsa Y successiva della stessa linea, con le stesse fermate fino al capolinea (±3 min
//      dal tempo di Y se Y ha dati propri; da 3 min prima a 20 min dopo l'orario se Y è solo programmata, cioè senza GPS né previsione),
//      e il ritardo di X «copre» la distanza tra i due orari, X è un doppione di Y: la previsione di X si scarta. Y resta com'è (mezzo
//      localizzato o previsione propria); se non ha dati prende il tempo di X quando differisce dal suo orario di oltre un minuto (è un dato del
//      feed), altrimenti resta «Da orario». Due mezzi localizzati non si toccano mai (X non ne ha per definizione);
//   b) senza Y e con oltre 40 minuti di ritardo: resta, salvo che un controllo esterno facoltativo (passCheck) la smentisca. Dalla v24 nessun
//      controllo è collegato (era la centrale ACTV, spenta), quindi resta.
const DEDUP = { MIN_DELAY_S: 600, NEAR_S: 180, LATE_S: 20 * 60, BIG_DELAY_S: 40 * 60 };
let passCheck = null;                                   // controllo esterno facoltativo dei passaggi (non collegato dalla v24: era la centrale ACTV)
const setPassCheck = f => { passCheck = f; };
function dedupePassages(i, now) {
  const G = D[i], s8 = S[i], prev = s8.state || {}, busy = new Set();
  for (const v of s8.vehicles) if (v.tripId && !v.sim) busy.add(v.tripId);
  const stat = (s8.dedup ||= { doppioni: 0, presiDallaCorsaDopo: 0, ritardiNonConfermati: 0 });
  for (const tid of Object.keys(s8.live)) {
    const lv = s8.live[tid]; if (busy.has(tid) || !lv || lv.cancelled || lv.derived) continue;
    const st = G.stopTimes.get(tid), trip = G.trips[tid]; if (!st || !trip) continue;
    const n = st.s.length, tN = tripNow(st);
    let k = -1; for (let j = Math.max(0, lv.firstJ); j < n - 1; j++) if (lv.delays[j] != null && st.d[j] + lv.delays[j] >= tN - 60) { k = j; break; }
    if (k < 0 || lv.delays[k] < DEDUP.MIN_DELAY_S) continue;
    const dX = lv.delays[k], pX = now + (st.d[k] + dX - tN) * 1000, schedX = now + (st.d[k] - tN) * 1000;
    let hit = null;
    try {
      for (const y of turni.slotsAt(G, tid, k, now, tripNow, activeNow)) {
        if (y.schedMs <= schedX || dX * 1000 < y.schedMs - schedX - DEDUP.NEAR_S * 1000) continue;
        const py = prev[y.tid]?.etaMs?.[y.k], ly = s8.live[y.tid]?.delays?.[y.k];
        // Y con dati propri (mezzo localizzato o previsione): stesso passaggio se entro ±3 min dal suo tempo. Y solo programmata (non
        // tracciata): la previsione di X può anche essere il SUO ritardo, fino a 20 min dopo l'orario (vince la corsa con l'orario più vicino)
        const known = Number.isFinite(py) || ly != null, predY = Number.isFinite(py) ? py : ly != null ? y.schedMs + ly * 1000 : y.schedMs;
        const d = pX - predY, ok = known ? Math.abs(d) <= DEDUP.NEAR_S * 1000 : d >= -DEDUP.NEAR_S * 1000 && d <= DEDUP.LATE_S * 1000;
        const score = Math.abs(d) - (known ? 3600e3 : 0);                                // a parità, i passaggi con dati propri prima
        if (ok && (!hit || score < hit.d)) hit = { y, d: score };
      }
    } catch (e) { console.error('passaggi doppi:', e.message); }
    if (hit) {
      delete s8.live[tid]; s8.hist.delete(tid); stat.doppioni++;
      const y = hit.y, Y = G.stopTimes.get(y.tid), dY = Math.round((pX - y.schedMs) / 1000);
      if (Y && !busy.has(y.tid) && !s8.live[y.tid] && Math.abs(dY) > 60) {
        s8.live[y.tid] = { delays: Array.from({ length: Y.s.length }, (_, j) => (j >= y.k ? dY : null)), cancelled: false, skipped: new Set(), firstJ: y.k, changedAt: lv.changedAt, veh: null, derived: tid };
        stat.presiDallaCorsaDopo++;
      }
      continue;
    }
    if (dX > DEDUP.BIG_DELAY_S && passCheck) {
      let r = null; try { r = passCheck(i, st.s[k], G.routes[trip.route]?.name || trip.route, pX); } catch { r = null; }
      if (r === 'no') { delete s8.live[tid]; s8.hist.delete(tid); stat.ritardiNonConfermati++; }
    }
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
  // il tratto vale per QUEL rilevamento: finché non ne arriva uno nuovo resta uguale (prima spariva alla lettura successiva del feed:
  // un messaggio in più nel flusso e un ridisegno sul telefono a ogni ciclo, per nulla)
  if (prev && prev.ts === veh.ts) { if (prev.path) veh.path = prev.path; return; }
  let p = null;
  if (prev && prev.shape === trip.shape) { const d = ss.sVeh - prev.s; if (d > 0.5 && d < 4000) p = veh.path = tracker.slice(sh, prev.s, ss.sVeh); }
  S[i].snap.set(veh.key, { s: ss.sVeh, shape: trip.shape, ts: veh.ts, ...(p ? { path: p } : {}) });
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

// Stato di una corsa CONCLUSA: tutte le fermate passate, nessun mezzo, nessuna previsione. Restano le partenze registrate (vs.dep), così
// le righe «partito da poco» del pannello fermata e i passaggi del pannello corsa non spariscono di colpo.
function endedState(st, vs, nowMs) {
  const n = st.s.length; vs.seen = nowMs;
  return { vehKey: null, label: null, cur: n, atStop: -1, phase: 'arrived', stage: 4, etaMs: new Float64Array(n).fill(NaN), dayOff: tripNow(st) >= 86400 ? 86400 : 0,
    src: 'ended', sVeh: null, lateral: null, delayS: vs.delay ?? 0, atOrigin: false, waiting: false, speed: null, dep: vs.dep || {}, preStart: false, feedPre: false, ended: true, stale: null };
}
// CORSA CONCLUSA: dopo il calcolo degli stati. Prove fisiche, non la sola previsione ACTV (nei bus la previsione «a zero fermate» compare anche
// a metà corsa: 78 casi in 2 ore, fino a 9 minuti di fila): (a) il mezzo che fa la corsa ha raggiunto l'ultima fermata o l'ha superata;
// (b) è fermo da 2 minuti davanti all'ultima fermata e la previsione ACTV della corsa, che c'era, non c'è più da 1 minuto.
function markEnded(i, out, now) {
  const G = D[i], s8 = S[i];
  for (const tid in out) {
    const ps = out[tid]; if (!ps || ps.ended || !ps.vehKey || s8.ended.has(tid)) continue;
    const st = G.stopTimes.get(tid), n = st.s.length;
    const arrived = ps.cur >= n || (ps.atStop === n - 1 && ps.phase === 'arrived');
    let gone = false;
    if (!arrived && ps.cur >= n - 1 && !s8.live[tid]) {
      const h = s8.hist.get(tid), v = s8.vehicles.find(x => x.key === ps.vehKey);
      gone = !!h && now - h.seen >= END_TU_GONE_MS && (v?.stillS || 0) >= END_STILL_S;
    }
    if (arrived || gone) s8.ended.set(tid, { veh: ps.vehKey, at: now, why: arrived ? 'arrivo' : 'previsione chiusa' });
  }
  for (const [tid, e] of s8.ended) if (now - e.at > ENDED_KEEP_MS) s8.ended.delete(tid);
}

function buildStates(i) {
  const G = D[i], out = {}, now = Date.now(), byTrip = new Map();
  for (const v of S[i].vehicles) if (v.tripId && !v.co) { const o = byTrip.get(v.tripId); if (!o || (v.ts || 0) > (o.ts || 0)) byTrip.set(v.tripId, v); }   // doppioni: il rilevamento più fresco
  for (const tid of new Set([...Object.keys(S[i].live), ...byTrip.keys(), ...S[i].ended.keys()])) {
    const st = G.stopTimes.get(tid), trip = G.trips[tid]; if (!st || !trip) continue;
    let vs = S[i].vs.get(tid); if (!vs) S[i].vs.set(tid, vs = {});
    if (S[i].ended.has(tid)) { out[tid] = endedState(st, vs, now); continue; }
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
  markEnded(i, out, now);
  S[i].state = out;
}

// when = { secs, date }: modalità Pianificato, la corsa si mostra all'ora e nel giorno SCELTI (fermate passate/da fare e avvisi sul calendario)
function tripDetail(i, tid, live, vehKey = null, G = D[i], when = null) {
  const st = G.stopTimes.get(tid), trip = G.trips[tid], r = G.routes[trip.route] || {}, n = st.s.length;
  const fits = t => t >= st.start - 3600 && t <= st.end + 3600;
  const tNow = !live && when?.secs != null ? (!fits(when.secs) && fits(when.secs + 86400) ? when.secs + 86400 : when.secs) : tripNow(st), nowMs = Date.now();
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
      else if (hist?.[k] != null) dlS = Math.min(Math.max(0, hist[k]), tNow - ts);       // arrivo in anticipo dal feed ≠ partenza in anticipo
      if (future && ss.preStart && !ss.feedPre && dlS < 60) dlS = ss.vehKey ? 0 : null;    // non partita, senza feed: nessun anticipo; col mezzo «In orario», senza «Da orario»
      if (dlS != null && k < cur) { dlS = Math.max(dlS, prevAct - ts); prevAct = ts + dlS; }
    }
    stops[k] = {
      name: G.stops[sid] || sid, id: `${i}:${sid}`,
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
    reassigned: live && veh?.reassigned ? veh.reassigned : null,
    live, detected: !live || !!(sel || lv), progress, atStop, phase: ss.phase, vehKey: ss.vehKey ?? null, others, speedKmh: ss.speed != null ? Math.round(ss.speed * 3.6) : null, cancelled: !!lv?.cancelled, note: noteOf(G, when?.date),
    // corsa conclusa (capolinea raggiunto) e stima non confermata (tracker.js: da quanti minuti mancano prove e perché)
    ended: live && !!ss.ended, stale: live && ss.stale && cur < n ? { why: ss.stale.why, min: Math.max(0, Math.floor((nowMs - ss.stale.since) / 60000)) } : null,
    // stato della corsa in testa al pannello: lo stesso delle righe (prima fermata non ancora servita con un ritardo); senza = «Da orario»
    delayNow: (nx => nx ? (dn != null && ss.vehKey ? Math.round(dn / 60) : nx.delay) : null)(stops.find(s => s.state !== 'passed' && s.delay != null)),
    historyKnown: stops.some(s => s.state === 'passed' && s.delay != null),
    trip: { src: i, id: `${i}:${tid}`, line: r.name || trip.route, color: r.color || null, headsign: trip.headsign || G.stops[st.s[n - 1]] || null, vehicle: veh?.label || null },
    shape: gtfs.toLL(G.shapePts[trip.shape]), stops
  };
}

// Nota da mostrare accanto agli orari: versione GTFS non valida oggi, oppure data fuori dai calendari
const noteOf = (G, date) => (G.meta?.approx ? 'GTFS non valido per oggi: orari indicativi' : NOTES[schedule.scheduleMode(G, date)] || null);

// ---- GTFS STATICO: caricamento, download e rivalutazione della versione ----
// Campione dei codici che il realtime usa adesso: serve a scegliere, tra più GTFS validi nel calendario, quello che combacia.
function rtSample(id) {
  const out = [], push = (t, r) => { if (t || r) out.push({ tripId: t, routeId: r }); };
  for (const e of S[id].cache.tripUpdates?.ents || []) { if (out.length >= 300) break; push(e.tripUpdate?.trip?.tripId, e.tripUpdate?.trip?.routeId); }
  for (const e of S[id].cache.vehiclePositions?.ents || []) { if (out.length >= 300) break; push(e.vehicle?.trip?.tripId, e.vehicle?.trip?.routeId); }
  return out;
}
// ---- GTFS PER DATA (modalità "Pianificato") ----
// In memoria c'è la versione in uso OGGI (D). Per una data diversa si sceglie nell'archivio la versione con servizi quel giorno (più recente tra le valide);
// se è un'altra si carica a richiesta in `alt` (UNA sola alternativa per servizio: la memoria di Render gratuito è limitata) e intanto si risponde "in caricamento".
const catalog = {};   // servizio -> versioni in archivio (con calendari), aggiornato a ogni rivalutazione
const alt = {}, altBusy = {}, altErr = {};
async function refreshCatalog(id) { try { catalog[id] = await store.list(id); } catch (e) { console.error(`archivio GTFS [${id}]:`, e.message); } }
// Ritorna { G } pronto, { loading: true } (caricamento in corso), { none: true } (nessuna versione copre la data) o { error }
function dataFor(id, date) {
  if (!cal.isYmd(date) || date === cal.romeYmd()) return { G: D[id] };
  const r = store.choose(catalog[id] || [], date);
  if (!r.pick || r.approx) return { none: true };
  const hash = r.pick.hash;
  if (D[id].meta?.hash === hash) return { G: D[id] };
  if (alt[id]?.hash === hash) return { G: alt[id].G };
  if (altErr[id]?.hash === hash && Date.now() - altErr[id].t < 30000) return { error: altErr[id].msg };
  if (!altBusy[id]) {
    alt[id] = null;                                                         // libera la precedente prima di caricare la nuova
    altBusy[id] = gtfs.loadVersion(id, r.pick, date).then(G => { alt[id] = { hash, G }; delete altErr[id]; })
      .catch(e => { altErr[id] = { hash, t: Date.now(), msg: e.message }; console.error(`GTFS [${id}] versione per ${date}:`, e.message); })
      .finally(() => { delete altBusy[id]; });
  }
  return { loading: true };
}
// Date selezionabili: dal primo all'ultimo giorno coperto dalle versioni in archivio (calendari + eccezioni), per ciascun servizio e in totale.
function dateRange() {
  const per = {}; let min = '99999999', max = '00000000';
  for (const id of IDS) {
    const c = (catalog[id] || []).filter(x => x.info), a = c.map(x => x.info.cover.min).sort()[0], b = c.map(x => x.info.cover.max).sort().pop();
    per[id] = { min: a || null, max: b || null, versions: c.map(x => ({ file: path.basename(x.file), from: x.info.from, to: x.info.cover.max })).sort((p, q) => p.from.localeCompare(q.from)) };
    if (a && a < min) min = a;
    if (b && b > max) max = b;
  }
  return { min: min < '99999999' ? min : null, max: max > '00000000' ? max : null, today: cal.romeYmd(), per };
}
const busy = {};      // un solo caricamento alla volta per servizio (rivalutazione periodica, ricarica manuale)
async function adopt(id, { force = false } = {}) {
  if (busy[id]) return busy[id];
  return (busy[id] = (async () => {
    try {
      await refreshCatalog(id);
      const g = await gtfs.load(id, { sample: rtSample(id), force });
      if (!g) return false;
      D[id] = g; const s8 = S[id];
      s8.hist.clear(); s8.vs.clear(); s8.snap.clear(); s8.sig.clear(); s8.owner.clear(); s8.ended.clear(); s8.state = {}; s8.live = {};
      ready[id] = true; version++; dropStopsCache(); alt[id] = null;
      refresh(id);
      console.log(`GTFS statico [${id}] in uso: ${g.meta.file} (${g.meta.reason})`);
      return true;
    } finally { delete busy[id]; }
  })());
}
// Scarica l'eventuale nuova versione nell'archivio (senza toccare le altre) e rivaluta quale usare
async function syncStatic(id) {
  const r = await store.download(id);
  if (r.status === 'nuova') await store.prune(id).catch(() => {});
  const switched = await adopt(id);
  return { download: r, switched };
}
async function reselect() {
  for (const id of IDS) { try { await adopt(id); } catch (e) { console.error(`GTFS statico [${id}]:`, e.message); } }
}
// Avvio: prima si usa ciò che c'è su disco (partenza immediata), poi si controlla il sito ACTV; senza nulla su disco si scarica e basta.
async function startStatic() {
  await Promise.all(IDS.map(async id => {
    try { await adopt(id); } catch (e) { console.log(`GTFS statico [${id}]: nulla di utilizzabile su disco (${e.message})`); }
    try { await syncStatic(id); } catch (e) { console.error(`GTFS statico [${id}]:`, e.message); }
  }));
  setInterval(reselect, 10 * 60e3).unref();                                        // cambio di giorno, versione futura che entra in vigore, realtime che cambia codici
  setInterval(() => IDS.forEach(id => syncStatic(id).catch(() => {})), 3 * 3600e3).unref();   // controllo del sito ACTV (richiesta condizionale: di solito 304)
}
async function gtfsStatus() {
  const out = {};
  for (const id of IDS) {
    const sel = await store.select(id, { sample: rtSample(id) }).catch(e => ({ error: e.message }));
    out[id] = { inUso: D[id].meta, scelta: sel.error ? { error: sel.error } : { motivo: sel.reason, approssimata: sel.approx, oggi: sel.today, versioni: sel.all, inAttesa: sel.pending } };
  }
  return out;
}

// ---- CICLI ----
// Ogni servizio ha il proprio ciclo: indipendenti e in parallelo; un ciclo lento non ne blocca né ne sovrappone un altro.
function startLoops() {
  for (const id of IDS) (async function loop() {
    const t0 = Date.now(); await refresh(id);
    const base = Math.min(REFRESH_MS, Math.max(MIN_POLL_MS, S[id].pubMs || REFRESH_MS));
    setTimeout(loop, Math.max(500, Math.min(30000, base * 2 ** Math.min(S[id].errCount, 4)) - (Date.now() - t0)));
  })();
}

module.exports = { Feed, events, D, S, ready, IDS, REFRESH_MS, refresh, tripDetail, setTurnoCheck, setPassCheck, dedupePassages, tripNow, noteOf, dataFor, dateRange, startStatic, startLoops, adopt, syncStatic, gtfsStatus,
  version: () => version, stopsCache: () => cachedStopsGzip, setStopsCache: v => { cachedStopsGzip = v; } };
