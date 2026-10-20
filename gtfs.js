const fs = require('fs');
const path = require('path');
const readline = require('readline');
const AdmZip = require('adm-zip');

/**
 * Estrae automaticamente i file ZIP presenti nella cartella 'data' 
 * (es. data/actv_aut.zip -> data/aut/)
 */
function extractZipFiles() {
  const dataDir = path.join(__dirname, 'data');
  const services = ['aut', 'nav'];

  for (const s of services) {
    const zipPath = path.join(dataDir, `actv_${s}.zip`);
    const targetDir = path.join(dataDir, s);

    if (fs.existsSync(zipPath)) {
      try {
        console.log(`Decompressione automatica di actv_${s}.zip...`);
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(targetDir, true);
      } catch (err) {
        console.error(`Errore nella decompressione di actv_${s}.zip:`, err.message);
      }
    }
  }
}

async function parseCsv(filePath) {
  const rows = [];
  if (!fs.existsSync(filePath)) return rows;
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headers = [];
  for await (const line of rl) {
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    if (!headers.length) { headers = cols; continue; }
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = cols[i] || '';
    rows.push(obj);
  }
  return rows;
}

function empty() {
  return {
    stops: {}, stopLoc: {}, stopIndex: {}, stopBaseNames: new Map(), stopIsRequest: new Map(),
    routes: {}, trips: {}, stopTimes: new Map(), tripPrefixes: [], routeShapes: {}, shapePts: {}
  };
}

async function load(src) {
  // Esegue l'estrazione dai file .zip prima di leggere i CSV
  extractZipFiles();

  const dir = path.join(__dirname, 'data', src);
  if (!fs.existsSync(dir)) return null;

  const [stopsRaw, routesRaw, tripsRaw, stopTimesRaw, shapesRaw] = await Promise.all([
    parseCsv(path.join(dir, 'stops.txt')),
    parseCsv(path.join(dir, 'routes.txt')),
    parseCsv(path.join(dir, 'trips.txt')),
    parseCsv(path.join(dir, 'stop_times.txt')),
    parseCsv(path.join(dir, 'shapes.txt'))
  ]);

  const G = empty();

  for (const s of stopsRaw) {
    const id = s.stop_id;
    if (!id) continue;
    G.stops[id] = s.stop_name;
    G.stopLoc[id] = [parseFloat(s.stop_lat), parseFloat(s.stop_lon)];
    G.stopIndex[id] = true;
    G.stopBaseNames.set(id, s.stop_name);
    if (/richiesta/i.test(s.stop_name)) G.stopIsRequest.set(id, true);
  }

  for (const r of routesRaw) {
    G.routes[r.route_id] = { name: r.route_short_name || r.route_long_name, color: r.route_color ? `#${r.route_color}` : null };
  }

  for (const t of tripsRaw) {
    G.trips[t.trip_id] = { route: t.route_id, headsign: t.trip_headsign, dir: t.direction_id != null ? +t.direction_id : null, shape: t.shape_id };
  }

  const stMap = new Map();
  for (const st of stopTimesRaw) {
    const tid = st.trip_id;
    let list = stMap.get(tid);
    if (!list) { list = []; stMap.set(tid, list); }
    const parseTime = t => {
      if (!t) return 0;
      const [h, m, s] = t.split(':').map(Number);
      return h * 3600 + m * 60 + (s || 0);
    };
    list.push({
      sid: st.stop_id,
      seq: +st.stop_sequence,
      arr: parseTime(st.arrival_time),
      dep: parseTime(st.departure_time)
    });
  }

  for (const [tid, list] of stMap) {
    list.sort((a, b) => a.seq - b.seq);
    const n = list.length;
    const s = new Array(n), q = new Uint16Array(n), a = new Int32Array(n), d = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      s[i] = list[i].sid;
      q[i] = list[i].seq;
      a[i] = list[i].arr;
      d[i] = list[i].dep;
    }
    G.stopTimes.set(tid, { s, q, a, d, start: a[0], end: a[n - 1] });
  }

  const shMap = {};
  for (const sh of shapesRaw) {
    const id = sh.shape_id;
    (shMap[id] ||= []).push({ seq: +sh.shape_pt_sequence, pt: [+sh.shape_pt_lat, +sh.shape_pt_lon] });
  }
  for (const id in shMap) {
    shMap[id].sort((x, y) => x.seq - y.seq);
    G.shapePts[id] = shMap[id].map(p => p.pt);
  }

  return G;
}

function toLL(pts) { return pts; }

module.exports = { empty, load, toLL };
