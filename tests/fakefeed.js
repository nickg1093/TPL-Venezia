// FEED SIMULATO PER PROVE (non serve in produzione). Si carica con:  node -r ./tests/fakefeed.js server.js
// Intercetta le richieste ai feed ACTV e alla marea e risponde con dati costruiti dalle corse che, secondo l'orario, sono in servizio ADESSO:
//  - posizioni lungo il tracciato (con timestamp recente) e ritardi diversi per corsa (0, +90, -60, +300 s)
//  - i codici delle corse sono quelli del GTFS con il prefisso cambiato (793 -> 792): prova del collegamento universale
//  - un mezzo "fantasma" (coordinate a zero) e un rilevamento vecchio di un'ora: devono essere scartati
// Variabili: FAKE_TIME_OFFSET (secondi da aggiungere all'ora simulata), FAKE_STOPPED=1 (i mezzi restano fermi in fermata).
const live = require('../live');
const schedule = require('../schedule');
const real = global.fetch;
const OFF = +process.env.FAKE_TIME_OFFSET || 0;

function build(src, name) {
  const G = live.D[src], now = Date.now(), secs = require('../calendar').romeParts(now + OFF * 1000).secs;
  const entity = [];
  if (G.stopTimes.size) {
    let n = 0;
    for (const p of schedule.positionsNow(G, secs)) {
      if (n >= 60) break;
      const st = G.stopTimes.get(p.id), t = G.trips[p.id]; if (!st || !t) continue;
      n++;
      const swap = x => x.replace('_793_', '_792_'), delay = [0, 90, -60, 300][n % 4];
      const tripDesc = { tripId: swap(p.id), routeId: t.route, startTime: schedule.hhmm(st.start) + ':00' };
      if (name === 'vehiclePositions') {
        entity.push({ id: 'v' + n, vehicle: { trip: tripDesc, position: { latitude: p.lat, longitude: p.lon, bearing: 0 }, timestamp: Math.floor(now / 1000) - (n % 5), vehicle: { id: 'V' + n, label: String(4000 + n) } } });
      } else {
        let i = 0; const tNow = secs; while (i < st.s.length - 1 && st.d[i] + delay <= tNow) i++;
        const upd = [];
        for (let k = i; k < Math.min(st.s.length, i + 8); k++) upd.push({ stopId: st.s[k], stopSequence: st.q[k], arrival: { delay } , departure: { delay } });
        entity.push({ id: 't' + n, tripUpdate: { trip: tripDesc, stopTimeUpdate: upd, delay } });
      }
    }
    if (name === 'vehiclePositions') {
      entity.push({ id: 'ghost', vehicle: { position: { latitude: 0, longitude: 0 }, vehicle: { id: 'GHOST', label: '0' }, timestamp: Math.floor(now / 1000) } });
      entity.push({ id: 'old', vehicle: { position: { latitude: 45.43, longitude: 12.33 }, vehicle: { id: 'OLD', label: '9' }, timestamp: Math.floor(now / 1000) - 3600 } });
    }
  }
  return Buffer.from(live.Feed.encode({ header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: Math.floor(now / 1000) }, entity }).finish());
}

global.fetch = async (url, opts) => {
  const u = String(url), m = /tpl\.actv\.it\/(nav|aut)\/GTFSRT\/(\w+)/.exec(u);
  if (m) { const body = build(m[1], m[2]); return new Response(body, { status: 200, headers: { 'content-type': 'application/x-protobuf' } }); }
  if (/dati\.venezia\.it/.test(u)) {
    if (/livello/.test(u)) { const d = new Date(Date.now() - 4 * 60e3 + 3600e3).toISOString().slice(0, 19).replace('T', ' '); return Response.json([{ ID_stazione: '1025', stazione: 'Punta Salute Canal Grande', data: d, valore: '0.62 m' }]); }
    return Response.json([]);
  }
  if (/actv\.avmspa\.it/.test(u)) return new Response('no', { status: 503 });
  return real(url, opts);
};
