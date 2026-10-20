const tz = 'Europe/Rome';

/**
 * Restituisce i secondi trascorsi dall'inizio della giornata nel fuso orario di Roma.
 */
function secsOfDayRome(ts = Date.now()) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false }).formatToParts(d);
  let h = 0, m = 0, s = 0;
  for (const p of parts) {
    if (p.type === 'hour') h = +p.value;
    if (p.type === 'minute') m = +p.value;
    if (p.type === 'second') s = +p.value;
  }
  return h * 3600 + m * 60 + s;
}

/**
 * Converte i secondi del giorno in stringa "HH:MM".
 */
function hhmm(secs) {
  const h = Math.floor(secs / 3600) % 24;
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function scheduleMode() { return 'normal'; }
function isActiveToday() { return true; }

/**
 * Calcola in modo efficiente le partenze previste per una fermata.
 */
function departures(G, liveMap, sid, targetSecsStr, dateStr) {
  const nowS = targetSecsStr != null ? +targetSecsStr : secsOfDayRome();
  const out = [];

  // Scansione diretta sulle corse indicizzate in memoria
  for (const [tid, st] of G.stopTimes) {
    // Ricerca dell'indice della fermata nell'array tipizzato
    const idx = st.s.indexOf(sid);
    if (idx < 0) continue;

    const t = G.trips[tid];
    if (!t) continue;
    const r = G.routes[t.route] || {};

    const schedSecs = st.d[idx] || st.a[idx];
    const lv = liveMap ? liveMap[tid] : null;
    const delay = (lv && lv.delays[idx] != null) ? lv.delays[idx] : 0;
    const expSecs = schedSecs + delay;

    const tIn = Math.round((expSecs - nowS) / 60);
    const schedIn = Math.round((schedSecs - nowS) / 60);

    // Finestra temporale rigorosa [-30 min, +180 min] per alleggerire la risposta JSON
    if (tIn < -30 || tIn > 180) continue;

    out.push({
      tripId: tid,
      routeId: t.route,
      line: r.name || t.route,
      color: r.color || null,
      headsign: t.headsign || G.stops[st.s[st.s.length - 1]] || null,
      sched: hhmm(schedSecs),
      exp: hhmm(expSecs),
      delay: Math.round(delay / 60),
      schedIn,
      expIn: tIn,
      live: !!(lv && lv.delays[idx] != null),
      cancel: lv?.cancelled ? 'trip' : (lv?.skipped?.has(idx) ? 'stop' : null),
      stop: sid
    });
  }

  return out;
}

/**
 * Restituisce le posizioni stimate dei mezzi in base all'orario (modalità programmata).
 */
function positionsNow(G, targetSecsStr) {
  const nowS = targetSecsStr != null ? +targetSecsStr : secsOfDayRome();
  const res = [];
  for (const [tid, st] of G.stopTimes) {
    if (nowS >= st.start && nowS <= st.end) {
      const t = G.trips[tid];
      if (!t) continue;
      const r = G.routes[t.route] || {};
      const pt = G.shapePts[t.shape]?.[0] || [45.437, 12.335];
      res.push({
        id: tid,
        lat: pt[0],
        lon: pt[1],
        line: r.name || t.route,
        color: r.color || null,
        headsign: t.headsign || null,
        routeId: t.route
      });
    }
  }
  return res;
}

function fracOnShape() { return 0.5; }

module.exports = { secsOfDayRome, hhmm, scheduleMode, isActiveToday, departures, positionsNow, fracOnShape };
