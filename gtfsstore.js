// ARCHIVIO DEI GTFS STATICI E SCELTA DELLA VERSIONE.
//
// PROBLEMA RISOLTO. Il file pubblicato da ACTV cambia nel tempo: può arrivare in anticipo (valido da una data futura), restare online dopo
// la scadenza, oppure il realtime può continuare a usare per qualche giorno i codici della versione precedente. Sovrascrivere sempre il file
// locale con l'ultimo scaricato porta a orari di un periodo sbagliato e a corse che "non combaciano" con il realtime.
//
// SOLUZIONE. Nessun file viene mai sovrascritto: ogni versione scaricata e valida si conserva (cartella data/gtfs/<servizio>/) e la versione IN USO
// si SCEGLIE ogni volta con questi criteri, in ordine:
//   1. VALIDITÀ NEL CALENDARIO: la versione deve avere servizi attivi OGGI (calendar.txt + calendar_dates.txt, data di Venezia).
//   2. COERENZA COL REALTIME: tra più versioni valide si preferisce quella i cui codici combaciano con quelli del feed realtime in questo momento
//      (corse e linee del realtime trovate nel file, con la linea coerente). Serve nei giorni di passaggio da una versione all'altra.
//   3. La più recente tra quelle già entrate in vigore (feed_start_date / primo giorno dei calendari più alto), poi la più recente scaricata.
//   Se nessuna ha servizi oggi si usa la più vicina nel tempo e il sistema lo segnala (orari indicativi).
// Le versioni con inizio futuro restano in archivio e si attivano da sole quando arriva la data (la scelta si rifà ogni pochi minuti).
// Si compatta l'archivio: restano le versioni valide oggi, quelle future, la più recente scaduta e quelle scadute da meno di 60 giorni (massimo 6).
// In modalità "Pianificato" le date selezionabili sono solo quelle coperte da queste versioni, e per ogni data si usa la versione con servizi quel giorno.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { eachRow } = require('./csv');
const cal = require('./calendar');
const ids = require('./ids');

const DIR = path.join(__dirname, 'data');
const BASE = 'https://actv.avmspa.it/sites/default/files/attachments/opendata/';
const SOURCES = {
  nav: { url: BASE + 'navigazione/actv_nav.zip', legacy: 'actv_nav.zip' },
  aut: { url: BASE + 'automobilistico/actv_aut.zip', legacy: 'actv_aut.zip' }
};
const REQUIRED = ['trips.txt', 'stop_times.txt', 'stops.txt', 'routes.txt'];
const KEEP_MAX = 6, KEEP_DAYS = 60;   // archivio: massimo 6 versioni; le scadute restano 60 giorni (si possono ancora consultare in "Pianificato")
// il sito ACTV rifiuta le richieste senza User-Agent da browser
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/zip,application/octet-stream;q=0.9,*/*;q=0.8', 'Accept-Language': 'it-IT,it;q=0.9'
};

const dirOf = src => path.join(DIR, 'gtfs', src);
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');
const entryOf = (zip, name) => zip.getEntries().find(e => { const n = e.entryName.toLowerCase(); return n === name || n.endsWith('/' + name); });

// ZIP integro e con i file indispensabili? Ritorna null se va bene, altrimenti il motivo.
function validZip(buf) {
  if (!buf || buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) return 'la risposta non è un file ZIP';
  try {
    const names = new AdmZip(buf).getEntries().map(e => e.entryName.toLowerCase());
    const miss = REQUIRED.filter(n => !names.some(x => x === n || x.endsWith('/' + n)));
    return miss.length ? 'ZIP incompleto, mancano: ' + miss.join(', ') : null;
  } catch (e) { return 'ZIP danneggiato (' + e.message + ')'; }
}

// Legge SOLO i file piccoli (calendari e feed_info): serve a capire la validità senza leggere i 50 MB di orari.
async function inspect(buf) {
  const zip = new AdmZip(buf), get = n => { const e = entryOf(zip, n); return e ? e.getData() : null; };
  const calendar = {}, exByDate = {}, ymd = x => String(x || '').replace(/\D/g, '').slice(0, 8);
  await eachRow(get('calendar.txt'), ['service_id', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'start_date', 'end_date'], c => {
    calendar[(c.service_id || '').trim()] = { days: [c.sunday, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday].map(x => String(x).trim() === '1'), start: ymd(c.start_date), end: ymd(c.end_date) };
  });
  await eachRow(get('calendar_dates.txt'), ['date', 'service_id', 'exception_type'], c => { (exByDate[ymd(c.date)] ||= []).push([(c.service_id || '').trim(), +c.exception_type]); });
  let feedStart = null, feedEnd = null;
  await eachRow(get('feed_info.txt'), ['feed_start_date', 'feed_end_date'], r => { feedStart = ymd(r.feed_start_date) || null; feedEnd = ymd(r.feed_end_date) || null; });
  const cover = cal.coverage(calendar, exByDate);
  return { calendar, exByDate, feedStart, feedEnd, cover, from: feedStart || (cover.min < '99999999' ? cover.min : '') };
}

// ---- elenco delle versioni presenti su disco ----
const infoCache = new Map();    // file|dimensione|data -> { hash, info }
async function describe(file, legacy) {
  const st = fs.statSync(file), key = `${file}|${st.size}|${st.mtimeMs}`;
  let c = infoCache.get(key);
  if (!c) {
    const buf = fs.readFileSync(file), bad = validZip(buf);
    c = { ok: !bad, error: bad, hash: md5(buf), info: bad ? null : await inspect(buf) };
    infoCache.set(key, c);
  }
  return { file, legacy, size: st.size, addedAt: st.mtimeMs, ...c };
}
async function list(src) {
  const out = [], seen = new Set(), S = SOURCES[src], dir = dirOf(src);
  const files = [];
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.zip')) files.push([path.join(dir, f), false]);
  if (S.legacy && fs.existsSync(path.join(DIR, S.legacy))) files.push([path.join(DIR, S.legacy), true]);   // copia storica in data/ (la versione nel repository)
  for (const [file, legacy] of files) {
    try {
      const c = await describe(file, legacy);
      if (!c.ok || seen.has(c.hash)) continue;       // illeggibile o doppione identico
      seen.add(c.hash); out.push(c);
    } catch (e) { console.log('GTFS archivio: file ignorato', path.basename(file), e.message); }
  }
  return out;
}

// ---- scelta ----
// Distanza in giorni fra oggi e il periodo coperto (0 = oggi è dentro)
function gapDays(cover, today) {
  if (cover.min > cover.max) return Infinity;
  if (today < cover.min) return (+cal.dateOfYmd(cover.min) - +cal.dateOfYmd(today)) / 864e5;
  if (today > cover.max) return (+cal.dateOfYmd(today) - +cal.dateOfYmd(cover.max)) / 864e5;
  return 0;
}
// Funzione pura (verificata dai test). cands: [{ hash, addedAt, info, match? }], today: AAAAMMGG.
// match = quota 0..1 di corse/linee del realtime che combaciano col file (null se non misurata).
function choose(cands, today) {
  const rows = cands.filter(c => c.info).map(c => {
    const services = cal.activeServices(c.info.calendar, c.info.exByDate, today).size;
    return { c, services, valid: services > 0, future: c.info.from > today, gap: gapDays(c.info.cover, today) };
  });
  const valid = rows.filter(r => r.valid);
  const poorMatch = r => (r.c.match != null && r.c.match < 0.5 ? 1 : 0);        // misurata e scarsa: passa dopo le altre
  const byQuality = (a, b) => poorMatch(a) - poorMatch(b) || (b.c.info.from > a.c.info.from ? 1 : b.c.info.from < a.c.info.from ? -1 : 0) || b.c.addedAt - a.c.addedAt;
  let pick = null, reason = '';
  if (valid.length) {
    valid.sort(byQuality); pick = valid[0];
    reason = valid.length > 1 ? `valida oggi (${valid.length} versioni valide: ${valid[0].c.match != null ? 'prevale la coerenza col realtime, poi la più recente' : 'prevale la più recente in vigore'})` : 'unica versione valida oggi';
  } else if (rows.length) {
    rows.sort((a, b) => a.gap - b.gap || b.c.addedAt - a.c.addedAt); pick = rows[0];
    reason = `nessuna versione ha servizi oggi: scelta la più vicina (${Math.round(pick.gap)} giorni di distanza), orari indicativi`;
  }
  return {
    pick: pick ? pick.c : null, reason, approx: !!pick && !pick.valid,
    pending: rows.filter(r => r.future && !r.valid).map(r => ({ hash: r.c.hash, from: r.c.info.from })),
    all: rows.map(r => ({ hash: r.c.hash, file: path.basename(r.c.file), from: r.c.info.from, feedEnd: r.c.info.feedEnd, coverage: r.c.info.cover, servicesToday: r.services, valid: r.valid, future: r.future, match: r.c.match ?? null, picked: pick ? r === pick : false }))
  };
}

// ---- coerenza col realtime ----
// sample: [{ tripId, routeId }] dal feed realtime. Si leggono solo trips.txt e routes.txt del candidato (pochi MB).
const matchCache = new Map();
async function matchScore(cand, sample) {
  if (!sample || sample.length < 20) return null;
  const key = cand.hash + '|' + md5(sample.map(s => s.tripId + '>' + s.routeId).join('|'));
  if (matchCache.has(key)) return matchCache.get(key);
  const zip = new AdmZip(cand.file), get = n => { const e = entryOf(zip, n); return e ? e.getData() : null; };
  const tripRoute = new Map(), routes = [];
  await eachRow(get('trips.txt'), ['trip_id', 'route_id'], t => tripRoute.set(t.trip_id, t.route_id));
  await eachRow(get('routes.txt'), ['route_id'], r => routes.push(r.route_id));
  const tIdx = { set: new Set(tripRoute.keys()), map: ids.buildIndex([...tripRoute.keys()]) }, rIdx = { set: new Set(routes), map: ids.buildIndex(routes) };
  let ok = 0;
  for (const s of sample) {
    const tid = ids.resolve(tIdx.map, tIdx.set, s.tripId); if (!tid) continue;
    const rr = s.routeId ? ids.resolve(rIdx.map, rIdx.set, s.routeId) : null;
    if (!s.routeId || !rr || rr === tripRoute.get(tid)) ok++;     // linea dichiarata dal feed diversa da quella del file = stesso codice, corsa diversa
  }
  const v = ok / sample.length; matchCache.set(key, v);
  if (matchCache.size > 40) matchCache.delete(matchCache.keys().next().value);
  return v;
}

// Sceglie la versione da usare adesso. sample: vedi matchScore (facoltativo).
async function select(src, { sample = null, ymd = cal.romeYmd() } = {}) {
  const cands = await list(src);
  const validNow = cands.filter(c => c.info && cal.activeServices(c.info.calendar, c.info.exByDate, ymd).size > 0);
  if (validNow.length > 1 && sample) for (const c of validNow) c.match = await matchScore(c, sample);   // la coerenza si misura solo se serve a decidere
  const r = choose(cands, ymd);
  return { ...r, today: ymd, candidates: cands };
}

// ---- download ----
const metaFile = src => path.join(dirOf(src), '.meta.json');
const readMeta = src => { try { return JSON.parse(fs.readFileSync(metaFile(src), 'utf8')); } catch { return {}; } };

// Scarica la versione pubblicata e la AGGIUNGE all'archivio se è nuova. Non cancella e non sovrascrive nulla.
// Ritorna { status: 'nuova' | 'invariata' | 'gia-presente' | 'errore', ... }
async function download(src, { force = false } = {}) {
  const S = SOURCES[src], dir = dirOf(src); fs.mkdirSync(dir, { recursive: true });
  const meta = readMeta(src), have = (await list(src)).length > 0;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const h = { ...HEADERS };
      if (!force && have && meta.etag) h['If-None-Match'] = meta.etag;
      if (!force && have && meta.lastModified) h['If-Modified-Since'] = meta.lastModified;
      const res = await fetch(S.url, { signal: AbortSignal.timeout(have ? 30000 : 120000), redirect: 'follow', headers: h });
      if (res.status === 304) return { status: 'invariata' };
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer()), bad = validZip(buf); if (bad) throw new Error(bad);
      const hash = md5(buf);
      fs.writeFileSync(metaFile(src), JSON.stringify({ etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), checkedAt: Date.now() }));
      if ((await list(src)).some(c => c.hash === hash)) return { status: 'gia-presente', hash };
      const info = await inspect(buf), name = `${info.from || 'na'}_${hash.slice(0, 8)}.zip`, file = path.join(dir, name);
      fs.writeFileSync(file + '.tmp', buf); fs.renameSync(file + '.tmp', file);          // scrittura atomica: un download interrotto non lascia file a metà
      console.log(`GTFS [${src}]: nuova versione archiviata ${name} (copre ${info.cover.min}..${info.cover.max})`);
      return { status: 'nuova', file: name, hash, from: info.from };
    } catch (e) {
      lastErr = e.message + (e.cause ? ', ' + (e.cause.code || e.cause.message) : '');
      console.log(`GTFS [${src}]: download tentativo ${attempt}/3 fallito: ${lastErr}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  return { status: 'errore', error: lastErr };
}

// Compatta l'archivio: tiene le versioni valide oggi, quelle future, la più recente scaduta e quelle scadute da meno di KEEP_DAYS giorni (max KEEP_MAX). Non tocca mai la copia storica in data/.
async function prune(src, ymd = cal.romeYmd()) {
  const rows = (await list(src)).filter(c => c.info && !c.legacy).map(c => ({ c, valid: cal.activeServices(c.info.calendar, c.info.exByDate, ymd).size > 0, future: c.info.from > ymd }));
  const keep = new Set(rows.filter(r => r.valid || r.future).map(r => r.c.hash));
  const expired = rows.filter(r => !keep.has(r.c.hash)).sort((a, b) => b.c.info.cover.max.localeCompare(a.c.info.cover.max));
  if (expired[0]) keep.add(expired[0].c.hash);
  const limit = cal.addDays(ymd, -KEEP_DAYS);
  for (const r of expired) if (r.c.info.cover.max >= limit) keep.add(r.c.hash);
  const order = rows.slice().sort((a, b) => b.c.info.from.localeCompare(a.c.info.from));
  let n = 0; const removed = [];
  for (const r of order) {
    if (keep.has(r.c.hash) && ++n <= KEEP_MAX) continue;
    try { fs.unlinkSync(r.c.file); removed.push(path.basename(r.c.file)); } catch { /* già rimosso */ }
  }
  return removed;
}

module.exports = { SOURCES, validZip, inspect, list, choose, select, download, prune, matchScore, dirOf };
