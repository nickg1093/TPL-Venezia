// Scarica e legge il GTFS statico ACTV (zip): linee, viaggi, tracciati, fermate.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const BASE_URL = 'https://actv.avmspa.it/sites/default/files/attachments/opendata/';
const SOURCES = {
  nav: { url: BASE_URL + 'navigazione/actv_nav.zip', cache: path.join(__dirname, 'data', 'actv_nav.zip') },
  aut: { url: BASE_URL + 'automobilistico/actv_aut.zip', cache: path.join(__dirname, 'data', 'actv_aut.zip') },
  ali: { url: 'https://alilaguna.it/attuale/alilaguna.zip', cache: path.join(__dirname, 'data', 'alilaguna.zip') }
};
const MAX_AGE_MS = 24 * 3600 * 1000;

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

// Legge un CSV selezionando solo le colonne necessarie per consumare meno RAM
async function eachRowFields(buf, fields, fn) {
  if (!buf || !buf.length) return;
  let nl = buf.indexOf(10); if (nl < 0) nl = buf.length;
  const head = splitLine(buf.toString('utf8', 0, nl).replace(/^\uFEFF/, '').replace(/\r$/, '')).map(h => h.trim());
  const idxs = {};
  for (const f of fields) idxs[f] = head.indexOf(f);

  let n = 0;
  for (let s = nl + 1; s < buf.length;) {
    let e = buf.indexOf(10, s); if (e < 0) e = buf.length;
    let ln = buf.toString('utf8', s, e); s = e + 1;
    if (ln.charCodeAt(ln.length - 1) === 13) ln = ln.slice(0, -1);
    if (!ln) continue;
    const f = splitLine(ln), o = {};
    for (const field of fields) {
      const idx = idxs[field];
      o[field] = idx >= 0 ? f[idx] : undefined;
    }
    fn(o);
    if (++n % 20000 === 0) await tick();
  }
}

async function readStopTimes(buf) {
  const tm = x => { if (!x || !x.trim()) return null; const p = x.trim().split(':'); return +p[0] * 3600 + +p[1] * 60 + +(p[2] || 0); };
  const out = new Map(), unsorted = new Set(), intern = new Map();
  await eachRowFields(buf, ['trip_id', 'stop_sequence', 'stop_id', 'arrival_time', 'departure_time'], r => {
    let st = out.get(r.trip_id);
    if (!st) { st = { q: [], s: [], a: [], d: [] }; out.set(r.trip_id, st); }
    const q = +r.stop_sequence;
    if (st.q.length && q < st.q[st.q.length - 1]) unsorted.add(r.trip_id);
    let a = tm(r.arrival_time), d = tm(r.departure_time);
    if (a == null) a = d; if (d == null) d = a;
    if (a == null) a = d = st.d.length ? st.d[st.d.length - 1] : 0;
    let sid = intern.get(r.stop_id); if (sid === undefined) { sid = r.stop_id; intern.set(sid, sid); }
    st.q.push(q); st.s.push(sid); st.a.push(a); st.d.push(d);
  });
  for (const id of unsorted) {
    const st = out.get(id), ord = st.q.map((_, k) => k).sort((x, y) => st.q[x] - st.q[y]);
    for (const key of ['q', 's', 'a', 'd']) st[key] = ord.map(k => st[key][k]);
  }
  for (const st of out.values()) { st.start = st.d[0]; st.end = st.a[st.a.length - 1]; }
  return out;
}

async function getZipBuffer(src) {
  if (!fs.existsSync(path.dirname(src.cache))) {
    fs.mkdirSync(path.dirname(src.cache), { recursive: true });
  }
  const fresh = fs.existsSync(src.cache) && Date.now() - fs.statSync(src.cache).mtimeMs < MAX_AGE_MS;
  if (!fresh) {
    try {
      const res = await fetch(src.url, {
        signal: AbortSignal.timeout(120000),
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': 'application/zip,application/octet-stream,*/*'
        }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('la risposta non è un file ZIP');
      fs.writeFileSync(src.cache, buf);
      console.log('GTFS statico scaricato:', path.basename(src.cache));
    } catch (e) {
      const why = e.message + (e.cause ? ', ' + (e.cause.code || e.cause.message) : '');
      if (!fs.existsSync(src.cache)) throw new Error(`download fallito (${why}): scaricalo a mano in data/${path.basename(src.cache)}`);
      console.log('Download GTFS fallito, uso la copia locale:', why);
    }
  }
  return fs.readFileSync(src.cache);
}

async function load(srcId) {
  const t0 = Date.now(), log = m => console.log(`GTFS [${srcId}]: ${m} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const zip = new AdmZip(await getZipBuffer(SOURCES[srcId]));
  const entries = zip.getEntries();
  const read = name => { const e = entries.find(x => x.entryName.toLowerCase().endsWith('/' + name) || x.entryName.toLowerCase() === name); return e ? e.getData() : null; };
  const routes = {}, trips = {}, stops = {}, stopLoc = {}, shapePts = {}, shapesByRoute = {};

  await eachRowFields(read('routes.txt'), ['route_id', 'route_short_name', 'route_long_name', 'route_color'], r => {
    routes[r.route_id] = { name: r.route_short_name || r.route_long_name || r.route_id, color: r.route_color ? '#' + r.route_color : null };
  });

  await eachRowFields(read('stops.txt'), ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], s => {
    stops[s.stop_id] = s.stop_name;
    if (s.stop_lat && s.stop_lon && isFinite(+s.stop_lat) && isFinite(+s.stop_lon)) stopLoc[s.stop_id] = [+s.stop_lat, +s.stop_lon];
  });

  await eachRowFields(read('trips.txt'), ['trip_id', 'route_id', 'trip_headsign', 'service_id', 'shape_id', 'direction_id'], t => {
    trips[t.trip_id] = { route: t.route_id, headsign: t.trip_headsign || null, service: (t.service_id || '').trim(), shape: t.shape_id || null,
      dir: (t.direction_id === undefined || t.direction_id === '') ? null : t.direction_id };
    if (t.shape_id) (shapesByRoute[t.route_id] ||= new Set()).add(t.shape_id);
  });

  log(`${Object.keys(routes).length} linee, ${Object.keys(trips).length} viaggi, ${Object.keys(stops).length} fermate: leggo i tracciati`);
  const raw = {};
  await eachRowFields(read('shapes.txt'), ['shape_id', 'shape_pt_sequence', 'shape_pt_lat', 'shape_pt_lon'], p =>
    (raw[p.shape_id] ||= []).push([+p.shape_pt_sequence, +(+p.shape_pt_lat).toFixed(5), +(+p.shape_pt_lon).toFixed(5)]));
  for (const id in raw) shapePts[id] = raw[id].sort((a, b) => a[0] - b[0]).map(p => [p[1], p[2]]);

  const calendar = {}, exByDate = {};
  const ymd = x => String(x || '').replace(/\D/g, '').slice(0, 8);
  
  await eachRowFields(read('calendar.txt'), ['service_id', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'start_date', 'end_date'], c => {
    calendar[(c.service_id || '').trim()] = { days: [c.sunday, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday].map(x => String(x).trim() === '1'),
                                              start: ymd(c.start_date), end: ymd(c.end_date) };
  });

  await eachRowFields(read('calendar_dates.txt'), ['date', 'service_id', 'exception_type'], c => { 
    (exByDate[ymd(c.date)] ||= []).push([(c.service_id || '').trim(), +c.exception_type]); 
  });

  log('leggo gli orari (stop_times)');
  const stopTimes = await readStopTimes(read('stop_times.txt'));
  await tick();

  const byStart = {};
  for (const [tid, st] of stopTimes) {
    const t = trips[tid]; if (!t) continue;
    (byStart[`${t.route}||${st.d[0]}`] ||= []).push(tid);
    if (t.dir != null) (byStart[`${t.route}|${t.dir}|${st.d[0]}`] ||= []).push(tid);
  }
  const tripPrefixes = [...new Set(Object.keys(trips).map(id => (/^[A-Za-z]+_/.exec(id) || [''])[0]).filter(Boolean))];
  const stopIndex = {};
  for (const [tid, st] of stopTimes) for (let i = 0; i < st.s.length; i++) (stopIndex[st.s[i]] ||= []).push(tid, i);

  const routeShapes = {};
  for (const rid in shapesByRoute) {
    routeShapes[rid] = [...shapesByRoute[rid]].filter(s => shapePts[s])
      .sort((a, b) => shapePts[b].length - shapePts[a].length).slice(0, 4).map(s => shapePts[s]);
  }
  log(`PRONTO: ${Object.keys(routes).length} linee, ${Object.keys(trips).length} viaggi, ${Object.keys(stops).length} fermate, ${stopTimes.size} corse con orari`);
  return { routes, trips, stops, stopLoc, routeShapes, shapePts, calendar, exByDate, stopTimes, stopIndex, byStart, tripPrefixes };
}

module.exports = { load };