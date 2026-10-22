// GTFS statico ACTV: scarica gli ZIP e li legge in strutture compatte
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const ids = require('./ids');

const BASE = 'https://actv.avmspa.it/sites/default/files/attachments/opendata/';
const DIR = path.join(__dirname, 'data');
const SOURCES = {
  nav: { url: BASE + 'navigazione/actv_nav.zip', file: path.join(DIR, 'actv_nav.zip') },
  aut: { url: BASE + 'automobilistico/actv_aut.zip', file: path.join(DIR, 'actv_aut.zip') }
};
const loaded = {};

const empty = () => ({ routes: {}, trips: {}, stops: {}, stopLoc: {}, routeShapes: {}, shapePts: {}, calendar: {},
  exByDate: {}, stopTimes: new Map(), stopIndex: {}, tripIds: [], tripPrefixes: [], nameToStopIds: new Map(), stopBaseNames: new Map(), stopIsRequest: new Map() });

const toLL = p => {
  if (!p) return null;
  const o = new Array(p.length >> 1);
  for (let i = 0; i < o.length; i++) o[i] = [+p[2 * i].toFixed(5), +p[2 * i + 1].toFixed(5)];
  return o;
};

function splitLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const tick = () => new Promise(r => setImmediate(r));

async function eachRow(buf, fields, fn) {
  if (!buf || !buf.length) return;
  let nl = buf.indexOf(10); if (nl < 0) nl = buf.length;
  const head = splitLine(buf.toString('utf8', 0, nl).replace(/^\uFEFF/, '').replace(/\r$/, '')).map(h => h.trim());
  const idx = fields.map(f => head.indexOf(f));
  let n = 0;
  for (let s = nl + 1; s < buf.length;) {
    let e = buf.indexOf(10, s); if (e < 0) e = buf.length;
    let ln = buf.toString('utf8', s, e); s = e + 1;
    if (ln.charCodeAt(ln.length - 1) === 13) ln = ln.slice(0, -1);
    if (!ln) continue;
    const f = splitLine(ln), o = {};
    fields.forEach((k, j) => { o[k] = idx[j] >= 0 ? f[idx[j]] : undefined; });
    fn(o);
    if (++n % 20000 === 0) await tick();
  }
}

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

// DOWNLOAD GTFS dal sito ACTV (che rifiuta le richieste senza User-Agent da browser).
// - fino a 3 tentativi con attesa crescente; timeout lungo solo al primo avvio
// - ETag / Last-Modified: se il file non è cambiato il server risponde 304 e non si scarica nulla
// - il file viene accettato SOLO se è uno ZIP intero con i file GTFS indispensabili
// - sostituzione atomica (scrive .tmp e rinomina): un download interrotto non rovina mai la copia buona
const REQUIRED = ['trips.txt', 'stop_times.txt', 'stops.txt', 'routes.txt'];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/zip,application/octet-stream;q=0.9,*/*;q=0.8', 'Accept-Language': 'it-IT,it;q=0.9'
};
function validZip(buf) {
  if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) return 'la risposta non è un file ZIP';
  try {
    const names = new AdmZip(buf).getEntries().map(e => e.entryName.toLowerCase());
    const miss = REQUIRED.filter(n => !names.some(x => x === n || x.endsWith('/' + n)));
    return miss.length ? 'ZIP incompleto, mancano: ' + miss.join(', ') : null;
  } catch (e) { return 'ZIP danneggiato (' + e.message + ')'; }
}
const metaFile = src => src.file + '.meta.json';
const readMeta = src => { try { return JSON.parse(fs.readFileSync(metaFile(src), 'utf8')); } catch { return {}; } };

async function getZip(src) {
  fs.mkdirSync(DIR, { recursive: true });
  const exists = fs.existsSync(src.file), meta = exists ? readMeta(src) : {};
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const h = { ...HEADERS };
      if (meta.etag) h['If-None-Match'] = meta.etag;
      if (meta.lastModified) h['If-Modified-Since'] = meta.lastModified;
      const res = await fetch(src.url, { signal: AbortSignal.timeout(exists ? 30000 : 120000), redirect: 'follow', headers: h });
      if (res.status === 304) break;                       // invariato: si usa la copia locale
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const bad = validZip(buf); if (bad) throw new Error(bad);
      const oldHash = exists ? crypto.createHash('md5').update(fs.readFileSync(src.file)).digest('hex') : '';
      if (crypto.createHash('md5').update(buf).digest('hex') !== oldHash) {
        fs.writeFileSync(src.file + '.tmp', buf); fs.renameSync(src.file + '.tmp', src.file);
        console.log('GTFS statico scaricato e aggiornato:', path.basename(src.file));
      }
      fs.writeFileSync(metaFile(src), JSON.stringify({ etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') }));
      lastErr = null; break;
    } catch (e) {
      lastErr = e.message + (e.cause ? ', ' + (e.cause.code || e.cause.message) : '');
      console.log(`Download GTFS ${path.basename(src.file)} tentativo ${attempt}/3 fallito: ${lastErr}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  if (lastErr && !exists) throw new Error(`download fallito (${lastErr}): scaricalo a mano in data/${path.basename(src.file)}`);
  return fs.readFileSync(src.file);
}

async function load(srcId) {
  const t0 = Date.now(), log = m => console.log(`GTFS [${srcId}]: ${m} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const buf = await getZip(SOURCES[srcId]);
  const sig = crypto.createHash('md5').update(buf).digest('hex');
  if (loaded[srcId] === sig) return null;

  const entries = new AdmZip(buf).getEntries();
  const read = name => { const e = entries.find(x => { const n = x.entryName.toLowerCase(); return n === name || n.endsWith('/' + name); }); return e ? e.getData() : null; };
  const pool = new Map(), intern = x => { let v = pool.get(x); if (v === undefined) pool.set(x, v = x); return v; };
  const G = empty(), { routes, trips, stops, stopLoc, shapePts, calendar, exByDate, nameToStopIds, stopBaseNames, stopIsRequest } = G;
  const usedShapes = new Set(), shapesByRoute = {};

  await eachRow(read('routes.txt'), ['route_id', 'route_short_name', 'route_long_name', 'route_color'], r => {
    routes[r.route_id] = { name: r.route_short_name || r.route_long_name || r.route_id, color: r.route_color ? '#' + r.route_color : null };
  });
  
  await eachRow(read('stops.txt'), ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], s => {
    const sId = intern(s.stop_id);
    const sName = s.stop_name || '';
    
    stops[sId]  = sName;
    if (s.stop_lat && s.stop_lon && isFinite(+s.stop_lat) && isFinite(+s.stop_lon)) stopLoc[s.stop_id] = [+s.stop_lat, +s.stop_lon];
    
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

  const ymd = x => String(x || '').replace(/\D/g, '').slice(0, 8);
  await eachRow(read('calendar.txt'), ['service_id', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'start_date', 'end_date'], c => {
    calendar[(c.service_id || '').trim()] = {
      days: [c.sunday, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday].map(x => String(x).trim() === '1'),
      start: ymd(c.start_date), end: ymd(c.end_date) };
  });
  await eachRow(read('calendar_dates.txt'), ['date', 'service_id', 'exception_type'], c => {
    (exByDate[ymd(c.date)] ||= []).push([(c.service_id || '').trim(), +c.exception_type]);
  });

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

  const pre = new Set();
  for (const id in trips) { const m = /^[A-Za-z]+_/.exec(id); if (m) pre.add(m[0]); }
  G.tripPrefixes = [...pre];

  for (const rid in shapesByRoute) {
    G.routeShapes[rid] = [...shapesByRoute[rid]].filter(s => shapePts[s]).sort((a, b) => shapePts[b].length - shapePts[a].length).slice(0, 4).map(s => shapePts[s]);
  }
  ids.attach(G);
  loaded[srcId] = sig;
  log(`PRONTO: ${Object.keys(routes).length} linee, ${Object.keys(trips).length} viaggi, ${Object.keys(stops).length} fermate, ${stopTimes.size} corse con orari`);
  return G;
}
module.exports = { load, empty, toLL };
