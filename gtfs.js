// LETTURA DEL GTFS STATICO in strutture compatte (tracciati come Float32Array, orari come Int32Array).
// Quale file leggere lo decide gtfsstore.js (validità nel calendario + coerenza col realtime): qui non c'è più alcun download.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const ids = require('./ids');
const store = require('./gtfsstore');
const { eachRow } = require('./csv');
const { inArea } = require('./geo');

const loaded = {};   // servizio -> hash del file attualmente in memoria

const empty = () => ({ routes: {}, trips: {}, stops: {}, stopLoc: {}, routeShapes: {}, shapePts: {}, calendar: {},
  exByDate: {}, stopTimes: new Map(), stopIndex: {}, tripIds: [], meta: null, nameToStopIds: new Map(), stopBaseNames: new Map(), stopIsRequest: new Map() });

const toLL = p => {
  if (!p) return null;
  const o = new Array(p.length >> 1);
  for (let i = 0; i < o.length; i++) o[i] = [+p[2 * i].toFixed(5), +p[2 * i + 1].toFixed(5)];
  return o;
};

const tm = x => { if (!x || !x.trim()) return null; const p = x.trim().split(':'); return +p[0] * 3600 + +p[1] * 60 + +(p[2] || 0); };

async function readStopTimes(buf, intern) {
  const out = new Map(), pats = new Map();
  let id = null, q = [], s = [], a = [], d = [];
  const flush = () => {
    if (id === null) return;
    const n = q.length; let ok = true;
    for (let k = 1; k < n; k++) if (q[k] < q[k - 1]) { ok = false; break; }
    if (!ok) { const o = q.map((_, k) => k).sort((x, y) => q[x] - q[y]); [q, s, a, d] = [q, s, a, d].map(v => o.map(k => v[k])); }
    const key = s.join(',') + '|' + q.join(',');
    let p = pats.get(key); if (!p) pats.set(key, p = { s, q: Int32Array.from(q) });
    out.set(id, { s: p.s, q: p.q, a: Int32Array.from(a), d: Int32Array.from(d), start: d[0], end: a[n - 1] });
  };
  await eachRow(buf, ['trip_id', 'stop_sequence', 'stop_id', 'arrival_time', 'departure_time'], r => {
    if (r.trip_id !== id) {
      flush(); id = r.trip_id;
      const old = out.get(id);
      if (old) { q = [...old.q]; s = [...old.s]; a = [...old.a]; d = [...old.d]; } else { q = []; s = []; a = []; d = []; }
    }
    let ar = tm(r.arrival_time), de = tm(r.departure_time);
    if (ar == null) ar = de;
    if (de == null) de = ar;
    if (ar == null) ar = de = d.length ? d[d.length - 1] : 0;
    q.push(+r.stop_sequence); s.push(intern(r.stop_id)); a.push(ar); d.push(de);
  });
  flush();
  return out;
}

// Legge la versione scelta da gtfsstore.js. Ritorna null se è la stessa già in memoria (nessun lavoro inutile).
// opts.sample = campione del realtime { tripId, routeId }[] per scegliere tra più versioni valide; opts.force rilegge comunque.
async function load(srcId, opts = {}) {
  const t0 = Date.now(), log = m => console.log(`GTFS [${srcId}]: ${m} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const sel = await store.select(srcId, { sample: opts.sample });
  if (!sel.pick) throw new Error('nessun GTFS valido in archivio: attendo il download (o copia lo ZIP in data/)');
  if (!opts.force && loaded[srcId] === sel.pick.hash) return null;
  log(`versione scelta ${path.basename(sel.pick.file)}: ${sel.reason}`);
  const buf = fs.readFileSync(sel.pick.file), sig = sel.pick.hash;

  const entries = new AdmZip(buf).getEntries();
  const read = name => { const e = entries.find(x => { const n = x.entryName.toLowerCase(); return n === name || n.endsWith('/' + name); }); return e ? e.getData() : null; };
  const pool = new Map(), intern = x => { let v = pool.get(x); if (v === undefined) pool.set(x, v = x); return v; };
  const G = empty(), { routes, trips, stops, stopLoc, shapePts, nameToStopIds, stopBaseNames, stopIsRequest } = G;
  const usedShapes = new Set(), shapesByRoute = {};

  await eachRow(read('routes.txt'), ['route_id', 'route_short_name', 'route_long_name', 'route_color'], r => {
    routes[r.route_id] = { name: r.route_short_name || r.route_long_name || r.route_id, color: r.route_color ? '#' + r.route_color : null };
  });
  
  await eachRow(read('stops.txt'), ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], s => {
    const sId = intern(s.stop_id);
    const sName = s.stop_name || '';
    
    stops[sId]  = sName;
    if (inArea(+s.stop_lat, +s.stop_lon)) stopLoc[s.stop_id] = [+s.stop_lat, +s.stop_lon];   // coordinate vuote, a zero o fuori area = fermata senza posizione
    
    const isReq = /a\s*richiesta/i.test(sName);
    stopIsRequest.set(s.stop_id, isReq);

    const cleanName = sName.replace(/\s+a\s*richiesta\w*/gi, '').replace(/\.$/, '').trim();
    stopBaseNames.set(s.stop_id, cleanName || sName);
    
    if (cleanName) {
      if (!nameToStopIds.has(cleanName)) nameToStopIds.set(cleanName, []);
      nameToStopIds.get(cleanName).push(s.stop_id);
    }
  });

  await eachRow(read('trips.txt'), ['trip_id', 'route_id', 'trip_headsign', 'service_id', 'shape_id', 'direction_id'], t => {
    const route = intern(t.route_id), shape = t.shape_id ? intern(t.shape_id) : null;
    trips[t.trip_id] = { route, headsign: t.trip_headsign ? intern(t.trip_headsign) : null, service: intern((t.service_id || '').trim()), shape,
      dir: t.direction_id ? intern(t.direction_id) : null };
    if (shape) { usedShapes.add(shape); (shapesByRoute[route] ||= new Set()).add(shape); }
  });
  log(`${Object.keys(routes).length} linee, ${Object.keys(trips).length} viaggi, ${Object.keys(stops).length} fermate: leggo i tracciati`);

  const raw = {};
  await eachRow(read('shapes.txt'), ['shape_id', 'shape_pt_sequence', 'shape_pt_lat', 'shape_pt_lon'], p => {
    if (usedShapes.has(p.shape_id)) (raw[p.shape_id] ||= []).push(+p.shape_pt_sequence, +p.shape_pt_lat, +p.shape_pt_lon);
  });
  for (const id in raw) {
    const r = raw[id], n = r.length / 3, ord = Array.from({ length: n }, (_, k) => k);
    let sorted = true;
    for (let k = 1; k < n; k++) if (r[3 * k] < r[3 * k - 3]) { sorted = false; break; }
    if (!sorted) ord.sort((x, y) => r[3 * x] - r[3 * y]);
    const f = new Float32Array(2 * n);
    ord.forEach((k, j) => { f[2 * j] = r[3 * k + 1]; f[2 * j + 1] = r[3 * k + 2]; });
    shapePts[id] = f; delete raw[id];
  }

  G.calendar = sel.pick.info.calendar; G.exByDate = sel.pick.info.exByDate;   // già letti da gtfsstore (stessi dati usati per scegliere la versione)

  log('leggo gli orari (stop_times)');
  G.stopTimes = await readStopTimes(read('stop_times.txt'), intern);
  const { stopTimes } = G;

  G.tripIds = [...stopTimes.keys()];
  const cnt = {};
  for (const tid of G.tripIds) for (const sid of stopTimes.get(tid).s) cnt[sid] = (cnt[sid] || 0) + 1;
  for (const sid in cnt) G.stopIndex[sid] = new Int32Array(cnt[sid] * 2);
  const pos = {};
  G.tripIds.forEach((tid, n) => {
    const s = stopTimes.get(tid).s;
    for (let i = 0; i < s.length; i++) { const p = pos[s[i]] || 0, arr = G.stopIndex[s[i]]; arr[p] = n; arr[p + 1] = i; pos[s[i]] = p + 2; }
  });

  for (const rid in shapesByRoute) {
    G.routeShapes[rid] = [...shapesByRoute[rid]].filter(s => shapePts[s]).sort((a, b) => shapePts[b].length - shapePts[a].length).slice(0, 4).map(s => shapePts[s]);
  }
  ids.attach(G);
  G.meta = { file: path.basename(sel.pick.file), hash: sig, from: sel.pick.info.from, feedEnd: sel.pick.info.feedEnd, coverage: sel.pick.info.cover,
    approx: sel.approx, reason: sel.reason, today: sel.today, loadedAt: Date.now() };
  loaded[srcId] = sig;
  log(`PRONTO: ${Object.keys(routes).length} linee, ${Object.keys(trips).length} viaggi, ${Object.keys(stops).length} fermate, ${stopTimes.size} corse con orari`);
  return G;
}
module.exports = { load, empty, toLL, loaded };
