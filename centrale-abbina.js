// CENTRALE ACTV — interpretazione delle righe ACTV e abbinamento alle corse del GTFS statico di una fermata.
// Il GTFS statico resta il riferimento: ogni riga ACTV si aggancia a una NOSTRA corsa (linea, codice palina con le fermate equivalenti,
// orario), oppure resta non abbinata. Nessuna fermata, corsa o nome nuovo.
const cal = require('./calendar');
const { equivalentStops } = require('./stopgroups');
const { C, st, norm, lineOf, fresh } = require('./centrale-stato');
const { pagesFor } = require('./centrale-lettura');

// ---- tempi ACTV ----
// "N'" (minuti, per difetto), "departure" (in partenza), "HH:MM" (ora di Venezia) -> istante in ms. I tempi in tempo reale sono al minuto
// per difetto: si contano a metà minuto (real = true). Le programmate "HH:MM" sono l'orario esatto.
function timeOf(s, at, real = true) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{1,3})'$/); if (m) return at + (+m[1] * 60 + C.REL_BIAS_S) * 1000;
  if (/^departure$/i.test(s)) return at;
  m = s.match(/^(\d{1,2}):(\d{2})$/); if (!m) return null;
  let d = +m[1] * 3600 + +m[2] * 60 - cal.romeParts(at).secs;
  if (d < -43200) d += 86400; else if (d > 43200) d -= 86400;                // a cavallo della mezzanotte
  return at + (d + (real ? C.REL_BIAS_S : 0)) * 1000;
}
// codici GTFS della palina di una riga: numero (bus), lettera del pontile (battelli: dal nome GTFS, S. Zaccaria "F" = 5013), oppure l'unica
// palina della pagina. Pagina con più paline e riga senza palina: nessun codice (non si indovina).
function codesOf(G, ent, stop) {
  const s = stop == null ? '' : String(stop).trim();
  if (/^\d+$/.test(s)) return [s];
  if (!s) return ent.codes.length === 1 ? ent.codes : [];
  const re = new RegExp(`["“”'‘’]\\s*${s.replace(/[^A-Za-z0-9]/g, '')}\\s*["“”'‘’]\\s*$`, 'i');
  return ent.codes.filter(c => re.test(G.stops[c] || ''));
}
function parseRows(G, ent, raw, at) {
  const out = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!x || typeof x !== 'object') continue;
    const real = !!x.real, ms = timeOf(x.time, at, real); if (ms == null) continue;
    out.push({ line: lineOf(x.line), dest: String(x.destination || '').trim(), ms, real, codes: codesOf(G, ent, x.stop), raw: String(x.time || ''),
      tps: (Array.isArray(x.timingPoints) ? x.timingPoints : []).map(p => ({ ms: timeOf(p && p.time, at, real), name: norm(p && p.stop) })).filter(p => p.ms != null && p.name) });
  }
  return out;
}
// righe ACTV fresche di una fermata (con le equivalenti): { rows, horizon, lines, at } | null
function rowsAt(src, sid) {
  const G = st.ctx.G(src); if (!G?.stopIndex?.[sid]) return null;
  const eqs = new Set(equivalentStops(G, sid)), es = pagesFor(src, sid).map(ent => [ent, st.pages.get(src + '|' + ent.page)]).filter(([, e]) => fresh(e));
  if (!es.length) return null;
  const rows = [], lines = new Set(); let horizon = -Infinity, at = Infinity;
  for (const [ent, e] of es) {
    for (const l of ent.lines) lines.add(l);
    for (const r of parseRows(G, ent, e.rows, e.t)) { horizon = Math.max(horizon, r.ms); lines.add(r.line); if (r.codes.some(c => eqs.has(c))) rows.push(r); }
    at = Math.min(at, e.t);
  }
  return { rows, horizon, lines, at, key: es.map(([ent, e]) => ent.page + e.t).join(',') };
}

// ---- corse GTFS che passano dalla fermata (con lo stato tempo reale: nostro mezzo, previsione) ----
function candidates(src, sid, nowMs) {
  const G = st.ctx.G(src), state = st.ctx.state(src) || {}, b = cal.romeParts(nowMs), secs = b.secs + (nowMs % 1000) / 1000, out = [];
  for (const eq of equivalentStops(G, sid)) {
    const list = G.stopIndex[eq]; if (!list) continue;
    for (let p = 0; p < list.length; p += 2) {
      const tid = G.tripIds[list[p]], k = list[p + 1], stt = G.stopTimes.get(tid), trip = G.trips[tid];
      if (!stt || !trip || k >= stt.s.length - 1) continue;                    // ACTV elenca partenze: niente arrivi al capolinea
      for (const [off, ds] of [[0, b.ymd], [86400, cal.addDays(b.ymd, -1)]]) {   // dopo mezzanotte: corse 24:xx del giorno prima
        if (!st.ctx.serviceActive(G, trip.service, ds)) continue;
        const tNow = secs + off, schedMs = nowMs + (stt.d[k] - tNow) * 1000;
        if (Math.abs(schedMs - nowMs) > C.WINDOW_S * 1000) continue;
        const ps0 = state[tid], ps = ps0 && ps0.dayOff === off ? ps0 : null;
        const ourMs = ps && k >= ps.cur && Number.isFinite(ps.etaMs?.[k]) ? ps.etaMs[k] : null;
        const r = G.routes[trip.route] || {};
        out.push({ tid, k, off, st: stt, line: lineOf(r.name || trip.route), schedMs, passed: !!ps && k < ps.cur, ourMs, veh: ps?.vehKey || null,
          stale: ourMs != null && (ourMs - schedMs) / 60000 > C.STALE_DELAY_MIN });
      }
    }
  }
  return out;
}

// orari ACTV alle fermate successive -> indici delle fermate della corsa e scarti rispetto all'orario (minuti)
function tpFit(G, c, row) {
  const s = c.st, n = s.s.length, at = j => (j === n - 1 ? s.a[j] : s.d[j]), pts = [];
  let j = c.k + 1;
  for (const tp of row.tps) {
    for (let q = j; q < n; q++) {
      const nm = norm(G.stopBaseNames?.get(s.s[q]) || G.stops[s.s[q]]);
      if (nm && nm === tp.name) { pts.push({ j: q, ms: tp.ms, off: (tp.ms - (c.schedMs + (at(q) - s.d[c.k]) * 1000)) / 60000 }); j = q + 1; break; }
    }
  }
  return pts;
}

// ---- abbinamento righe ACTV <-> corse GTFS di una fermata ----
// 1) programmate: alla corsa con lo stesso orario (al minuto);
// 2) tempo reale, per linea e destinazione, rispettando l'ordine dei passaggi (programmazione dinamica): ai NOSTRI mezzi se il passaggio cade
//    vicino al loro tempo (è quello che già vediamo), poi alle corse senza mezzo (il ritardo più piccolo, mai oltre 40 minuti); gli orari ACTV
//    alle fermate successive escludono direzioni e percorsi diversi (se per la linea almeno una corsa ne riconosce i nomi).
// -> { res: Map(corsa -> { row, c, kind: 'prog'|'tr', pts }), loose: righe non abbinate, horizon, lines, at }
function match(src, sid, nowMs) {
  const R = rowsAt(src, sid); if (!R) return null;
  const G = st.ctx.G(src);
  const mk = R.key + '|' + Math.floor(nowMs / 5000) + '|' + (st.ctx.version?.() ?? '');
  const mm = st.memo.get(src + '|' + sid); if (mm && mm.key === mk) return mm.res;
  const { rows, horizon } = R, s = st.stat;
  const cands = candidates(src, sid, nowMs).filter(c => !c.passed);
  const used = new Set(), res = new Map(), loose = [], keyOf = c => c.tid + '|' + c.k;
  const fitCache = new Map(), fit = (c, r) => { const k = keyOf(c) + '|' + r.ms + r.dest; let v = fitCache.get(k); if (!v) fitCache.set(k, v = tpFit(G, c, r)); return v; };
  const tpUsable = new Map();
  for (const r of rows) if (r.tps.length > 1 && !tpUsable.has(r.line)) tpUsable.set(r.line, cands.some(c => c.line === r.line && fit(c, r).length > 0));
  const compatible = (c, r) => {
    if (c.line !== r.line) return false;
    if (r.tps.length > 1 && tpUsable.get(r.line)) {
      const f = fit(c, r); if (!f.length) return false;                           // direzione o percorso diversi
      const offs = f.map(p => p.off); if (Math.max(...offs) - Math.min(...offs) > 6) return false;
    }
    return true;
  };
  // 1) programmate
  for (const r of rows.filter(x => !x.real)) {
    let best = null, bd = Infinity;
    for (const c of cands) {
      if (used.has(keyOf(c)) || !compatible(c, r)) continue;
      const d = Math.abs(r.ms - c.schedMs - (r.raw.endsWith("'") ? C.REL_BIAS_S * 1000 : 0));
      if (d <= 61000 && d < bd) { bd = d; best = c; }
    }
    if (best) { used.add(keyOf(best)); res.set(best.tid, { row: r, c: best, kind: 'prog' }); s.programmateAbbinate++; } else loose.push(r);
  }
  // 2) tempo reale
  const groups = new Map();
  for (const r of rows.filter(x => x.real)) { const g = r.line + '|' + r.dest; (groups.get(g) || groups.set(g, []).get(g)).push(r); }
  for (const rs of groups.values()) {
    rs.sort((a, b) => a.ms - b.ms);
    const cs = cands.filter(c => !used.has(keyOf(c)) && rs.some(r => compatible(c, r))).sort((a, b) => a.schedMs - b.schedMs);
    const n = rs.length, m = cs.length, INF = 1e9, first = rs[0].ms;
    const cost = (r, c) => {
      if (!compatible(c, r)) return INF;
      const d = (r.ms - c.schedMs) / 60000; if (d < -C.EARLY_MAX_MIN) return INF;
      if (c.ourMs != null) {                                    // nostro mezzo: il passaggio ACTV è il suo se cade vicino al suo tempo
        const dd = Math.abs(r.ms - c.ourMs) / 60000;
        if (!c.stale) return Math.min(dd, 30);
        if (dd <= C.STRONG_MIN) return dd;
      }
      return d > C.STALE_DELAY_MIN ? INF : 1 + Math.max(0, d) * 0.1;
    };
    // saltare una corsa costa: un nostro mezzo dentro l'orizzonte ACTV dovrebbe esserci
    const skipC = c => { const t = c.ourMs ?? c.schedMs; if (t > horizon + 60e3 || (c.ourMs == null && t < first - 10 * 60e3)) return 0; return c.ourMs != null ? C.SKIP_LIVE : C.SKIP_SCHED; };
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1)), bk = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
      if (!i && !j) continue; let best = INF * 10, b = 0;
      if (i) { const v = dp[i - 1][j] + C.SKIP_ROW; if (v < best) { best = v; b = 1; } }
      if (j) { const v = dp[i][j - 1] + skipC(cs[j - 1]); if (v < best) { best = v; b = 2; } }
      if (i && j) { const cc = cost(rs[i - 1], cs[j - 1]); if (cc < INF) { const v = dp[i - 1][j - 1] + cc; if (v < best) { best = v; b = 3; } } }
      dp[i][j] = best; bk[i][j] = b;
    }
    for (let i = n, j = m; i || j;) {
      const b = bk[i][j];
      if (b === 3) { const r = rs[i - 1], c = cs[j - 1]; used.add(keyOf(c)); res.set(c.tid, { row: r, c, kind: 'tr', pts: fit(c, r) }); s.realiAbbinate++; i--; j--; }
      else if (b === 1) { loose.push(rs[i - 1]); i--; }
      else j--;
    }
  }
  s.righe += rows.length; s.righeNonAbbinate += loose.length;
  // orari ACTV noti delle corse (fermata abbinata + fermate successive), uniti a quelli delle altre fermate lette: pannello del mezzo
  for (const [tid, v] of res) {
    if (v.kind !== 'tr') continue;
    const k = src + ':' + tid, o = st.store.get(k), pts = new Map(o && o.off === v.c.off && nowMs - o.t < C.STALE_MS ? o.pts : []);
    pts.set(v.c.k, v.row.ms); for (const p of v.pts || []) if (!pts.has(p.j)) pts.set(p.j, p.ms);
    st.store.set(k, { t: Math.max(R.at, o?.t || 0), off: v.c.off, pts });
  }
  if (st.store.size > 5000) for (const [k, v] of st.store) if (nowMs - v.t > C.STALE_MS) st.store.delete(k);
  const out = { res, loose, horizon, lines: R.lines, lineCodes: new Set(rows.map(r => r.line)), at: R.at };
  st.memo.set(src + '|' + sid, { key: mk, res: out }); if (st.memo.size > 2000) st.memo.clear();
  return out;
}

// ---- controllo per turni.js: la corsa B (orario schedMs) la fa un ALTRO mezzo? ----
// 'contro' se la centrale ha un passaggio in tempo reale della linea, lontano dal tempo del nostro mezzo (oltre 90 s) e più vicino
// all'orario di B (entro 3 min) di quanto lo sia il mezzo. Senza dati freschi: null (decide il resto della regola). Registra la fermata per il
// controllo continuo, così al giro dopo i dati ci sono.
function checkTurno(src, sid, line, etaMs, schedMs) {
  if (!st.ctx) return null;
  st.wants.set(src + '|' + sid, Date.now());
  let R; try { R = rowsAt(src, sid); } catch { return null; }
  if (!R) return null;
  const L = lineOf(line), dm = Math.abs(etaMs - schedMs);
  const other = R.rows.some(r => r.real && r.line === L && Math.abs(r.ms - etaMs) > C.SAME_S * 1000 && Math.abs(r.ms - schedMs) <= 180e3 && Math.abs(r.ms - schedMs) < dm);
  if (other) st.stat.turnoContro++;
  return other ? 'contro' : 'ok';
}

// ---- confronto continuo (diagnosi): tempo di ogni nostro mezzo alla prossima fermata vs passaggio ACTV più vicino della stessa linea ----
function compareAll() {
  const c = { mezzi: 0, entro75s: 0, entro3min: 0, oltre3min: 0, senzaPassaggio: 0, casi: [] }, now = Date.now();
  for (const src of ['aut', 'nav']) {
    const G = st.ctx.G(src), state = st.ctx.state(src) || {}; if (!G) continue;
    for (const tid in state) {
      const ps = state[tid], s = G.stopTimes.get(tid); if (!ps?.vehKey || !s || ps.cur >= s.s.length - 1) continue;
      const R = rowsAt(src, s.s[ps.cur]), eta = ps.etaMs?.[ps.cur]; if (!R || !Number.isFinite(eta) || eta > R.horizon) continue;
      const line = lineOf(G.routes[G.trips[tid]?.route]?.name), near = R.rows.filter(r => r.real && r.line === line).map(r => Math.abs(r.ms - eta)).sort((a, b) => a - b)[0];
      c.mezzi++;
      if (near == null) c.senzaPassaggio++;
      else if (near <= C.AGREE_S * 1000) c.entro75s++;
      else if (near <= 180e3) c.entro3min++;
      else { c.oltre3min++; if (c.casi.length < 20) c.casi.push({ servizio: src, corsa: tid, mezzo: ps.label || ps.vehKey, fermata: s.s[ps.cur], scartoMin: Math.round(near / 6e3) / 10 }); }
    }
  }
  c.ora = new Date(now).toISOString();
  st.stat.confronto = c;
}

module.exports = { timeOf, codesOf, parseRows, rowsAt, candidates, tpFit, match, checkTurno, compareAll };
