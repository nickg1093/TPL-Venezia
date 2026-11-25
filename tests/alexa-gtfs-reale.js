// RICERCA INDIPENDENTE SUI GTFS VERI (per le prove di confronto): legge direttamente gli ZIP di data/gtfs con un algoritmo diverso da quello
// della skill (scansione completa di stop_times, calendario applicato a mano) e restituisce le corse dirette da A a B in una data.
'use strict';
const fs = require('fs'), path = require('path');
const { Zip } = require('../zip');
const { eachRow, eachRowStream } = require('../csv');

async function carica(src) {
  const dir = path.join(__dirname, '..', 'data', 'gtfs', src);
  const file = fs.readdirSync(dir).filter(f => f.endsWith('.zip')).sort().at(-1);
  const z = new Zip(path.join(dir, file)), e = n => z.getEntries().find(x => x.entryName === n);
  const stops = {}, trips = {}, routes = {}, cal = {}, ex = {};
  await eachRow(e('stops.txt').getData(), ['stop_id', 'stop_name'], r => { stops[r.stop_id] = r.stop_name; });
  await eachRow(e('routes.txt').getData(), ['route_id', 'route_short_name', 'route_type'], r => { routes[r.route_id] = { name: r.route_short_name, type: +r.route_type }; });
  await eachRow(e('trips.txt').getData(), ['trip_id', 'route_id', 'service_id', 'trip_headsign'], r => { trips[r.trip_id] = { route: r.route_id, svc: r.service_id, hs: r.trip_headsign }; });
  if (e('calendar.txt')) await eachRow(e('calendar.txt').getData(), ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'], r => { cal[r.service_id] = r; });
  if (e('calendar_dates.txt')) await eachRow(e('calendar_dates.txt').getData(), ['service_id', 'date', 'exception_type'], r => { (ex[r.date] ||= {})[r.service_id] = r.exception_type; });
  const st = new Map();
  await eachRowStream(e('stop_times.txt'), ['trip_id', 'stop_sequence', 'stop_id', 'departure_time', 'arrival_time'], r => {
    let l = st.get(r.trip_id); if (!l) st.set(r.trip_id, l = []);
    const t = s => { const [h, m, x] = s.split(':').map(Number); return h * 3600 + m * 60 + (x || 0); };
    l.push([+r.stop_sequence, r.stop_id, t(r.departure_time || r.arrival_time), t(r.arrival_time || r.departure_time)]);
  });
  for (const l of st.values()) l.sort((a, b) => a[0] - b[0]);
  return { file, stops, trips, routes, cal, ex, st };
}
const GIORNI = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function attivo(g, svc, ymd) {
  const e = g.ex[ymd] && g.ex[ymd][svc]; if (e === '1') return true; if (e === '2') return false;
  const c = g.cal[svc]; if (!c) return false;
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  return c.start_date <= ymd && ymd <= c.end_date && c[GIORNI[d.getUTCDay()]] === '1';
}
// corse dirette: salita a una fermata di `da` (non all'ultima), discesa più avanti a una fermata di `a`
function diretti(g, ymd, da, a, { tipo = null } = {}) {
  const out = [];
  for (const [tid, l] of g.st) {
    const t = g.trips[tid]; if (!t || !attivo(g, t.svc, ymd)) continue;
    if (tipo != null && g.routes[t.route].type !== tipo) continue;
    for (let i = 0; i < l.length - 1; i++) {
      if (!da.has(l[i][1])) continue;
      const j = l.findIndex((x, k) => k > i && a.has(x[1]));
      if (j > i) { out.push({ tid, line: g.routes[t.route].name, dep: l[i][2], arr: l[j][3], da: l[i][1], a: l[j][1] }); break; }
    }
  }
  return out.sort((x, y) => x.dep - y.dep);
}
module.exports = { carica, diretti, attivo };
