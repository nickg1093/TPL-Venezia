// MOTORE TEMPO REALE. Legge i feed GTFS-RT di ACTV, li collega al GTFS statico e mantiene per ogni corsa uno stato unico
// (dove si trova il mezzo, in quale fase, quando arriva) da cui dipendono mappa, pannello fermata e dettaglio corsa.
// L'HTTP sta in server.js; qui non c'è nulla di web. Gli aggiornamenti si annunciano con l'evento 'push' (vedi events).
const { EventEmitter } = require('events');
const crypto = require('crypto');
const protobuf = require('protobufjs');
const gtfs = require('./gtfs');
const store = require('./gtfsstore');
const schedule = require('./schedule');
const cal = require('./calendar');
const ids = require('./ids');
const motion = require('./motion');
const tracker = require('./tracker');
const { inArea } = require('./geo');
const { secsOfDayRome, hhmm } = schedule;

const events = new EventEmitter();
// Intervallo massimo di lettura dei feed (la lettura si adatta al ritmo di pubblicazione di ACTV, minimo 1 s). Limiti per evitare valori assurdi da variabile d'ambiente.
const REFRESH_MS = Math.min(30000, Math.max(1000, +process.env.RT_POLL_MS || 2000));
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
    cache: {}, raw: {}, match: {}, errCount: 0, feedTs: null, sim: false, lastAgree: null };
}
let version = 0;        // cresce a ogni nuovo GTFS statico caricato: il client ricarica fermate e linee
let cachedStopsGzip = null;
const dropStopsCache = () => { cachedStopsGzip = null; };

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const wrap = x => ((x + 43200) % 86400 + 86400) % 86400 - 43200;
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
    const G = D[id], live = {}, now = Date.now(), pos = P.ents, upd = U.ents;
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

    // 2) TRIP UPDATE
    for (const e of upd) {
      if (e.isDeleted) { skippedDeleted++; continue; }
      const tu = e.tripUpdate;
      if (!tu?.trip || (!tu.trip.tripId && !tu.trip.startTime)) continue;
      if (!dayOk(tu.trip.startDate)) { wrongDay++; continue; }
      const tid = resolveTrip(G, tu.trip, strict, tally); if (!tid) continue;
      tuOk++;
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
      const sig = delays.join(','), pv = s8.sig.get(tid), changedAt = pv && pv.sig === sig ? pv.t : now; s8.sig.set(tid, { sig, t: changedAt });
      live[tid] = { delays, cancelled: tu.trip.scheduleRelationship === 3, skipped, firstJ, changedAt };
      let h = s8.hist.get(tid); if (!h) s8.hist.set(tid, h = { delays: new Array(n).fill(null), seen: 0 });
      for (let k = 0; k < n; k++) if (explicit[k] != null) h.delays[k] = explicit[k];
      h.seen = now;
    }
    for (const [k, h] of s8.hist) if (now - h.seen > 3 * 3600 * 1000) { s8.hist.delete(k); s8.sig.delete(k); }
    s8.live = live;

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
        speed: (calc => Number.isFinite(v.position.speed) && v.position.speed >= 0 && v.position.speed < 45 ? v.position.speed : calc)(motion.updateSpeed(s8.track, key, v.position.latitude, v.position.longitude, ts, now)),
        stillS: motion.stillFor(s8.track, key), vInst: motion.instSpeed(s8.track, key), key, ts, old: now - ts > OLD_FLAG_MS, bearing: v.position.bearing ?? null,
        status: v.currentStatus ?? null, seq: v.currentStopSequence ?? null,
        line: r.name || routeKey || '?', color: r.color || null, tripId,
        routeId: routeKey && has(G.routes, routeKey) ? `${id}:${routeKey}` : null, headsign: trip.headsign || null };
    });
    for (const [k, p] of s8.track) if (now - p.arr > 600000) { s8.track.delete(k); s8.snap.delete(k); }   // mezzi non più visti
    s8.lastAgree = tally;
    s8.match = { tripUpdates: { total: upd.length, collegati: tuOk, altroGiorno: wrongDay, eliminati: skippedDeleted },
      veicoli: { total: pos.length, collegati: vOk, posizioneNonValida: bad, datoTroppoVecchio: ghost },
      coerenzaCodici: { coerenti: tally.ok, incoerenti: tally.bad, controlloAttivo: strict } };
    s8.updated = now; s8.goodAt = now; s8.error = null; s8.sim = false;
    pickOwners(id); buildStates(id); events.emit('push', true);
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
    live, progress, atStop, phase: ss.phase, vehKey: ss.vehKey ?? null, others, speedKmh: ss.speed != null ? Math.round(ss.speed * 3.6) : null, cancelled: !!lv?.cancelled, note: noteOf(G),
    delayNow: dn != null ? Math.round(dn / 60) : null,
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
const busy = {};      // un solo caricamento alla volta per servizio (rivalutazione periodica, ricarica manuale)
async function adopt(id, { force = false } = {}) {
  if (busy[id]) return busy[id];
  return (busy[id] = (async () => {
    try {
      const g = await gtfs.load(id, { sample: rtSample(id), force });
      if (!g) return false;
      D[id] = g; const s8 = S[id];
      s8.hist.clear(); s8.vs.clear(); s8.snap.clear(); s8.sig.clear(); s8.owner.clear(); s8.state = {}; s8.live = {};
      ready[id] = true; version++; dropStopsCache();
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
    const base = Math.min(REFRESH_MS, Math.max(1000, (S[id].pubMs || REFRESH_MS * 3) / 3));
    setTimeout(loop, Math.max(500, Math.min(30000, base * 2 ** Math.min(S[id].errCount, 4)) - (Date.now() - t0)));
  })();
}

module.exports = { Feed, events, D, S, ready, IDS, REFRESH_MS, refresh, tripDetail, noteOf, startStatic, startLoops, adopt, syncStatic, gtfsStatus,
  version: () => version, stopsCache: () => cachedStopsGzip, setStopsCache: v => { cachedStopsGzip = v; } };
