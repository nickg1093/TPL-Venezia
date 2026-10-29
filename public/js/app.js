// APP PRINCIPALE: mappa, mezzi in movimento, ricerca, pannelli (fermata · zona · corsa) con navigazione e inseguimento.
// Moduli: util.js (testo, icone, nomi, colori, etichette) · zones.js (zone di fermate) · tide.js (marea) · pwa.js (installazione).
import { $, esc, p2, nowSecs, fmtSecs, localDate, icon, srcIcon, vehIcon, vehName, lum, colorInfo, badge, ptHtml, etaText, tickEta, delayInfo, api } from './util.js';
import { zones, zoneOf, snorm, buildZones, norm, unitOf } from './zones.js';
import * as Tide from './tide.js';
import * as Avvisi from './avvisi.js';
import * as Pwa from './pwa.js';

const POLL_MS = 2000, MIN_STOP_ZOOM = 14;

// ---------------------------------------------------------------------------------------------------------------------
// ELEMENTI E STATO
// ---------------------------------------------------------------------------------------------------------------------
const statusEl = $('status'), filterEl = $('filter'), resultsEl = $('search-results'), panel = $('panel'), plist = $('plist'), chipsArea = $('chips-area');
const pname = $('pname'), psub = $('psub'), pstatus = $('pstatus'), pbadge = $('pbadge'), pback = $('pback'), pfollow = $('pfollow');
const range = $('tl-range'), dateEl = $('tl-date');
const searchContainer = $('search-container'), searchToggleBtn = $('search-toggle-btn');

let mode = 'live', staticVer = -1, lastUpdate = Date.now(), lastLoadSecs = -1, isPlaying = false, playTimer = null;
const active = new Set(['nav', 'aut']);
let routesData = {}, stops = [], vehicles = [];
let lineFilter = null;   // {src, name, ids}: scelta dalla ricerca, mostra solo i mezzi (e il percorso) di quella linea
let selVeh = null, follow = false, routeToken = 0, vehMemo = { trip: null, y: 0 };

// Pannello aperto: current = { t:'stop'|'zone'|'trip', ... }; navStack = i pannelli da cui si è arrivati (per il link "indietro")
let current = null, lastDeps = null, lastTrip = null, panelTimer = null;
const navStack = [];

dateEl.value = localDate();
range.value = nowSecs();
const keyOf = () => [...active].join(',');
// Date selezionabili in "Pianificato": solo quelle coperte dai GTFS in archivio (il server le legge da data/gtfs/<servizio>/)
const ymdToIso = y => `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
fetch('/api/dates', { cache: 'no-store' }).then(r => r.json()).then(d => {
  if (d.min) dateEl.min = ymdToIso(d.min);
  if (d.max) dateEl.max = ymdToIso(d.max);
  clampDate();
}).catch(() => {});
function clampDate() {
  const v = dateEl.value; if (!v) { dateEl.value = localDate(); return false; }
  if (dateEl.min && v < dateEl.min) { dateEl.value = dateEl.min; return true; }
  if (dateEl.max && v > dateEl.max) { dateEl.value = dateEl.max; return true; }
  return false;
}
const schedQS = () => mode === 'sched' ? `&secs=${range.value}&date=${dateEl.value.replace(/-/g, '')}` : '';

// ---------------------------------------------------------------------------------------------------------------------
// MAPPA E LIVELLI
//   lineLayer = percorsi scelti dalla ricerca · tripLayer = percorso e fermate della corsa selezionata · stopLayer = pali delle fermate
// ---------------------------------------------------------------------------------------------------------------------
const map = L.map('map', { preferCanvas: true, zoomControl: false, attributionControl: false }).setView([45.437, 12.335], 12);
if (matchMedia('(pointer: fine)').matches) L.control.zoom({ position: 'bottomright', zoomInTitle: 'Ingrandisci', zoomOutTitle: 'Riduci' }).addTo(map);   // su touch si usa il pizzico
// l'attribuzione di OpenStreetMap è nel dock in basso (#credits): sempre visibile e mai coperta da pannelli o finestre
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
const lineLayer = L.layerGroup().addTo(map), tripLayer = L.layerGroup().addTo(map), stopLayer = L.layerGroup().addTo(map);
new ResizeObserver(() => map.invalidateSize({ animate: false })).observe($('wrap'));   // il dock cambia altezza (es. in modalità Pianificato): la mappa si adegua

// Linea sulla mappa con contorno: resta leggibile anche se il colore è chiaro (es. bianco della linea 1) e in entrambi i temi
function drawLine(pts, k, layer, op) {
  const light = lum(k.rail) > .5;
  L.polyline(pts, { color: light ? '#14232b' : '#ffffff', weight: 8, opacity: .8, interactive: false }).addTo(layer);
  L.polyline(pts, { color: k.rail, weight: 4.5, opacity: op, interactive: false }).addTo(layer);
}

// ---------------------------------------------------------------------------------------------------------------------
// ZONA LIBERA DELLA MAPPA E CENTRATURA
// Pannelli, colonna dei controlli, scheda marea e barra di ricerca coprono parti della mappa. Per centrare un elemento (mezzo seguito, fermata)
// si calcola il rettangolo che resta LIBERO e si porta l'elemento al suo centro. Il rettangolo si ricalcola ogni volta dalle misure reali
// degli elementi a schermo, quindi vale per qualsiasi dimensione, orientamento o lingua (testi più lunghi = pannelli più alti).
// ---------------------------------------------------------------------------------------------------------------------
const PAD = 14, MIN_FREE = 150;
function freeBox() {
  const m = $('map').getBoundingClientRect();
  let box = { l: 0, t: 0, r: m.width, b: m.height };
  const els = [panel, $('tide'), $('avvisi'), $('controls'), searchContainer, $('topleft')].filter(el => el && !el.hidden && el.offsetParent !== null && !(el === searchContainer && !el.classList.contains('expanded')));
  const rects = els.map(el => {
    let r = el.getBoundingClientRect();
    if (el.id === 'controls') {   // la colonna è trasparente tra un gruppo e l'altro: conta il riquadro dei soli gruppi
      const g = [...el.querySelectorAll('.group')].map(x => x.getBoundingClientRect()); if (!g.length) return null;
      r = { left: Math.min(...g.map(x => x.left)), right: Math.max(...g.map(x => x.right)), top: Math.min(...g.map(x => x.top)), bottom: Math.max(...g.map(x => x.bottom)) };
    }
    return { l: r.left - m.left, t: r.top - m.top, r: r.right - m.left, b: r.bottom - m.top };
  }).filter(Boolean).sort((a, b) => (b.r - b.l) * (b.b - b.t) - (a.r - a.l) * (a.b - a.t));
  for (const o of rects) {
    if (o.r <= box.l || o.l >= box.r || o.b <= box.t || o.t >= box.b) continue;                 // non interseca la zona libera
    // quattro modi di scansare l'elemento (tagliare un lato della zona libera): si sceglie quello che lascia più superficie
    const opts = [{ ...box, l: Math.max(box.l, o.r + PAD) }, { ...box, r: Math.min(box.r, o.l - PAD) }, { ...box, t: Math.max(box.t, o.b + PAD) }, { ...box, b: Math.min(box.b, o.t - PAD) }]
      .filter(x => x.r - x.l >= MIN_FREE && x.b - x.t >= MIN_FREE);
    if (!opts.length) continue;                                                                   // non scansabile senza ridurre troppo la zona: lo si ignora
    box = opts.sort((a, b) => (b.r - b.l) * (b.b - b.t) - (a.r - a.l) * (a.b - a.t))[0];
  }
  return { ...box, w: box.r - box.l, h: box.b - box.t, cx: (box.l + box.r) / 2, cy: (box.t + box.b) / 2 };
}
// Porta il punto ll al centro della zona libera (con zoom z, animato oppure no)
function focusOn(ll, z = map.getZoom(), animate = true) {
  const box = freeBox(), size = map.getSize(), off = L.point(box.cx - size.x / 2, box.cy - size.y / 2);
  const target = map.unproject(map.project(ll, z).subtract(off), z);
  if (!animate) map.setView(target, z, { animate: false });
  else if (z === map.getZoom()) map.panTo(target, { animate: true, duration: .6 });
  else map.flyTo(target, z, { duration: .8 });
}
// Se il punto è nascosto da un pannello o vicino al bordo della zona libera, lo si porta al centro; altrimenti non si muove nulla
function ensureVisible(ll) {
  const box = freeBox(), p = map.latLngToContainerPoint(ll), mx = Math.min(56, box.w / 4), my = Math.min(56, box.h / 4);
  if (p.x < box.l + mx || p.x > box.r - mx || p.y < box.t + my || p.y > box.b - my) focusOn(ll);
}
// i pannelli cambiano altezza quando arrivano i dati: se c'è qualcosa da tenere in vista lo si ricentra
let keepInView = null;                // () => LatLng | null
new ResizeObserver(() => { if (keepInView && !panel.hidden) { const ll = keepInView(); if (ll) ensureVisible(ll); } }).observe(panel);

// ---------------------------------------------------------------------------------------------------------------------
// OROLOGIO E MODALITÀ "PIANIFICATO"
// ---------------------------------------------------------------------------------------------------------------------
function updateClock() {
  if (mode !== 'live') return;
  const n = new Date();
  $('clock-time').innerHTML = `${p2(n.getHours())}:${p2(n.getMinutes())}:<small>${p2(n.getSeconds())}</small>`;
  const s = Math.floor((Date.now() - lastUpdate) / 1000);
  $('updated-ago').textContent = s <= 2 ? '· ora' : `· ${s}s fa`;
}
setInterval(updateClock, 1000);
setInterval(tickEta, 1000);

const syncPlay = () => { $('tl-play').innerHTML = icon(isPlaying ? 'pause' : 'play'); $('tl-play').setAttribute('aria-label', isPlaying ? 'Pausa' : 'Avvia'); };
const stopPlay = () => { isPlaying = false; clearInterval(playTimer); syncPlay(); };
function applyTime(secs, force) {
  range.value = secs; $('tl-time').textContent = fmtSecs(secs);
  if (force || Math.abs(secs - lastLoadSecs) >= 5) { lastLoadSecs = secs; load(); if (current && current.t !== 'trip') loadDepartures(); }
}
$('tl-play').onclick = () => {
  isPlaying = !isPlaying; syncPlay(); clearInterval(playTimer);
  if (isPlaying) playTimer = setInterval(() => { const v = +range.value + +$('tl-speed').value; applyTime(v > 86400 ? 0 : v); }, 1000);
};
$('tl-now').onclick = () => { stopPlay(); dateEl.value = localDate(); applyTime(nowSecs(), true); };
range.oninput = () => applyTime(+range.value);
dateEl.onchange = () => {
  const moved = clampDate();
  if (moved) { statusEl.className = 'warn'; statusEl.textContent = `Orari disponibili dal ${dateEl.min.split('-').reverse().join('/')} al ${dateEl.max.split('-').reverse().join('/')}`; }
  applyTime(+range.value, true);
};

// ---------------------------------------------------------------------------------------------------------------------
// MEZZI SULLA MAPPA
// ---------------------------------------------------------------------------------------------------------------------
const busHtml = v => badge(v.line, v.color, v.src, `${mode === 'sched' || v.sim ? ' sched' : ''}${v.old ? ' old' : ''}${v.id === selVeh ? ' sel' : ''}`);
const tip = v => `${vehIcon(v.src, v.label, 'sm', v.line)} <b>${esc(v.line)}</b>${v.headsign ? ' ' + icon('next', 'sm') + ' ' + esc(v.headsign) : ''}${v.label ? ' · ' + esc(vehName(v.src, v.label)) : ''}${v.old ? ' · dato non aggiornato' : ''}`;

// MOVIMENTO (fedele ai dati ricevuti)
// Regole: 1) la posizione vera è sempre l'ultimo rilevamento GPS; 2) il mezzo non va MAI oltre l'ultimo punto ricevuto
// (nessuna previsione: in laguna e in calle una proiezione in rettilineo darebbe posizioni inventate);
// 3) tra due rilevamenti percorre il tratto di linea inviato dal server (v.path, già agganciato al tracciato), a velocità
// costante e calibrata perché arrivi quando è atteso il rilevamento successivo; senza tracciato, va in linea retta fra i due punti.
// Il ritardo visivo è circa un intervallo di aggiornamento del feed: è il prezzo per non mostrare posizioni false.
const markers = new Map();
const SNAP_M = 300;        // distanza oltre la quale il marker salta direttamente (cambio corsa, riconnessione)
const MAX_MPS = 30;        // limite di velocità visiva (108 km/h): evita scatti se si accumula ritardo
const mDist = (aLat, aLon, bLat, bLon) => Math.hypot((aLat - bLat) * 111000, (aLon - bLon) * 78000);
const polyLen = p => { let L = 0; for (let i = 1; i < p.length; i++) L += mDist(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]); return L; };

function render() {
  const keep = new Set(), now = performance.now();
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    if (!active.has(v.src) || !Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    if (lineFilter && (v.src !== lineFilter.src || String(v.line) !== lineFilter.name)) continue;
    keep.add(v.id);
    const html = busHtml(v);
    let e = markers.get(v.id);

    if (!e) {   // nuovo mezzo
      const m = L.marker([v.lat, v.lon], { icon: L.divIcon({ className: 'bus-marker', iconSize: null, html }), keyboard: false })
        .bindTooltip(tip(v), { direction: 'top', offset: [0, -12] }).addTo(map), id = v.id;
      m.on('click', () => { const c = vehicles.find(x => x.id === id); if (c) openFromMap({ t: 'trip', v: vehSnap(c) }); });
      markers.set(v.id, { m, html, tipContent: tip(v), lat: v.lat, lon: v.lon, poly: [[v.lat, v.lon]], mps: 0, lastTs: v.ts || 0, lastArr: now, iv: POLL_MS * 2 });
      continue;
    }
    if (e.html !== html) { e.m.setIcon(L.divIcon({ className: 'bus-marker', iconSize: null, html })); e.html = html; }
    const newTip = tip(v);
    if (e.tipContent !== newTip) { e.m.setTooltipContent(newTip); e.tipContent = newTip; }

    if (mode !== 'live') { e.lat = v.lat; e.lon = v.lon; e.poly = [[v.lat, v.lon]]; e.m.setLatLng([v.lat, v.lon]); continue; }   // orario: posizione diretta

    // nuovo rilevamento? (si confronta col punto finale del percorso già in coda)
    const end = e.poly[e.poly.length - 1];
    if (mDist(end[0], end[1], v.lat, v.lon) < 3) continue;           // entro il rumore GPS: fermo
    if (mDist(e.lat, e.lon, v.lat, v.lon) > SNAP_M) { e.lat = v.lat; e.lon = v.lon; e.poly = [[v.lat, v.lon]]; e.m.setLatLng([v.lat, v.lon]); e.lastTs = v.ts || 0; e.lastArr = now; continue; }
    // intervallo tra rilevamenti: dai timestamp del feed se plausibili, altrimenti dagli arrivi
    const dFeed = v.ts && e.lastTs ? v.ts - e.lastTs : 0, dArr = now - e.lastArr;
    e.iv = Math.min(30000, Math.max(1500, 0.5 * e.iv + 0.5 * (dFeed >= 800 && dFeed <= 60000 ? dFeed : dArr)));
    e.lastTs = v.ts || e.lastTs; e.lastArr = now;
    // percorso: resto di quello in corso + tratto di linea fino al nuovo punto (o retta se il server non lo fornisce)
    const pts = Array.isArray(v.path) && v.path.length > 1 ? v.path.slice(1) : [];
    if (!pts.length || mDist(pts[pts.length - 1][0], pts[pts.length - 1][1], v.lat, v.lon) > 3) pts.push([v.lat, v.lon]);
    e.poly = e.poly.concat(pts);
    e.mps = Math.min(MAX_MPS, polyLen(e.poly) / (e.iv * 1.05 / 1000));
  }
  for (const [id, e] of markers) if (!keep.has(id)) { e.m.remove(); markers.delete(id); }
}

// Un fotogramma: avanza i mezzi lungo il loro percorso e, se l'inseguimento è attivo, scorre la mappa dolcemente verso il centro della zona libera
let lastFrame = performance.now();
requestAnimationFrame(function frame(t) {
  const dt = Math.min(100, t - lastFrame); lastFrame = t;
  if (mode === 'live' && !document.hidden) {
    for (const e of markers.values()) {
      if (e.poly.length < 2) continue;                                  // arrivato: nessun lavoro
      let adv = e.mps * dt / 1000;                                      // metri da percorrere in questo fotogramma
      while (adv > 0 && e.poly.length > 1) {
        const a = e.poly[0], b = e.poly[1], seg = mDist(a[0], a[1], b[0], b[1]);
        if (adv >= seg) { adv -= seg; e.poly.shift(); }
        else { const f = adv / seg; e.poly[0] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; adv = 0; }
      }
      e.lat = e.poly[0][0]; e.lon = e.poly[0][1];
      e.m.setLatLng([e.lat, e.lon]);
    }
  }
  if (follow && selVeh && !document.hidden && Date.now() >= followAfter) {
    const e = markers.get(selVeh);
    if (e) {
      const box = freeBox(), p = map.latLngToContainerPoint(e.m.getLatLng()), dx = p.x - box.cx, dy = p.y - box.cy;
      if (Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5) { const k = Math.min(1, dt / 350); map.panBy([dx * k, dy * k], { animate: false }); }   // scorrimento con attenuazione: nessuno scatto
    }
  }
  requestAnimationFrame(frame);
});

async function load() {
  const m = mode, key = keyOf();
  try {
    const d = await api(`/api/${m === 'sched' ? 'scheduled' : 'vehicles'}?src=${key}${schedQS()}`);
    if (m !== mode || key !== keyOf()) return;
    if (d.error && !d.vehicles) throw new Error(d.error);
    if (d.version !== undefined && d.version !== staticVer) { staticVer = d.version; loadStatics(); }
    vehicles = d.vehicles || []; lastUpdate = d.updated || Date.now(); render();
    const wait = [...active].filter(s => d.ready && !d.ready[s]);
    const counts = [...active].map(s => `<span class="cnt">${srcIcon(s, 'sm')}${vehicles.filter(v => v.src === s).length}</span>`).join('');
    const notes = [];
    if (m === 'live' && d.sim?.length) notes.push('dati in tempo reale non disponibili: posizioni da orario');
    if (m === 'live' && d.stale?.length) notes.push('il feed ACTV non si aggiorna da diversi minuti');
    if (wait.length) notes.push(`in caricamento: ${wait.join(', ')}`);
    if (d.error) notes.push(d.error);
    if (m === 'sched' && /Carico gli orari/.test(d.error || '')) setTimeout(() => { if (mode === 'sched') load(); }, 3000);   // versione del GTFS per quella data in caricamento
    statusEl.className = notes.length ? 'warn' : '';
    statusEl.innerHTML = `${counts}<span>${m === 'sched' ? 'pianificato' : 'mezzi'} · ${new Date(d.updated).toLocaleTimeString('it-IT')}</span>${notes.map(n => `<span class="note">${esc(n)}</span>`).join('')}`;
  } catch (e) { if (m === mode && !e.busy) { statusEl.className = 'err'; statusEl.textContent = 'Errore: ' + e.message; } }
}

// ---------------------------------------------------------------------------------------------------------------------
// FERMATE SULLA MAPPA
// ---------------------------------------------------------------------------------------------------------------------
// la fermata (o la zona) mostrata nel pannello si evidenzia sulla mappa
const isStopSelected = id => {
  if (!current || current.t === 'trip') return false;
  if (current.t === 'zone') { const z = zones.get(current.key); return !!z && zoneOf.get(id) === z && (z.pick === '*' || z.letterOf.get(id) === z.pick); }
  return id === current.id;
};
let drawTimer = null;
const drawStopsSoon = () => { clearTimeout(drawTimer); drawTimer = setTimeout(drawStops, 120); };   // durante scorrimenti e inseguimento non si ridisegna a ogni fotogramma
function drawStops() {
  stopLayer.clearLayers();
  if (map.getZoom() < MIN_STOP_ZOOM) return;
  const b = map.getBounds().pad(.1); let n = 0;
  for (let i = 0; i < stops.length; i++) {
    const [id, name, lat, lon, src] = stops[i];
    if (!active.has(src) || !b.contains([lat, lon])) continue;
    if (++n > 2500) break;
    const selected = isStopSelected(id), warn = Avvisi.hasAlert(id);
    L.circleMarker([lat, lon], { radius: selected ? 9 : warn ? 8 : 6, weight: selected ? 2.5 : warn ? 3.5 : 1.5, color: warn ? '#dc2626' : '#0f172a', fillColor: selected ? '#f5a623' : warn ? '#fde68a' : '#ffffff', fillOpacity: 0.95 })   // avviso in corso: bordo rosso e riempimento giallo
      .bindTooltip(`${srcIcon(src, 'sm')} ${esc(name)}${warn ? ' ' + icon('warn', 'sm') + ' avviso in corso' : ''}`).on('click', () => openFromMap(entryForStop(id, name, src))).addTo(stopLayer);
  }
}
map.on('moveend', drawStopsSoon);

// ---------------------------------------------------------------------------------------------------------------------
// DATI STATICI (linee, fermate) E PERCORSI
// ---------------------------------------------------------------------------------------------------------------------
const shapeCache = new Map();
function loadStatics() {
  shapeCache.clear();
  fetch('/api/routes', { cache: 'no-store' }).then(r => r.json()).then(d => { if (d && !d.error) routesData = d; }).catch(() => {});
  fetch('/api/stops', { cache: 'no-store' }).then(r => r.json()).then(d => { if (Array.isArray(d)) { stops = d; buildZones(stops); drawStops(); updateNear(); } }).catch(() => {});
}
async function showRoutes(ids, layer = lineLayer) {
  const tok = ++routeToken;
  layer.clearLayers();
  for (const id of ids) {
    if (!id) continue;
    let shapes = shapeCache.get(id);
    if (!shapes) {
      try { shapes = (await (await fetch('/api/shapes?id=' + encodeURIComponent(id), { cache: 'no-store' })).json()).shapes; if (shapes?.length) shapeCache.set(id, shapes); }
      catch { continue; }
    }
    if (tok !== routeToken) return;
    const r = routesData[id] || {};
    for (const pts of shapes || []) drawLine(pts, colorInfo(r.color, r.name), layer, .9);
  }
}
$('linefilter').onclick = () => clearSearchState(true);
function setLineFilter(f) {
  lineFilter = f; const chip = $('linefilter');
  if (f) { chip.hidden = false; chip.innerHTML = `${badge(f.name, routesData[f.ids[0]]?.color, f.src)}<span>solo linea ${esc(f.name)}</span>${icon('close', 'sm')}`; chip.setAttribute('aria-label', `Mostra di nuovo tutte le linee (ora solo la ${f.name})`); showRoutes(f.ids); }
  else { chip.hidden = true; chip.innerHTML = ''; }
  render();
}
const clearRoutes = () => { routeToken++; lineLayer.clearLayers(); };

// ---------------------------------------------------------------------------------------------------------------------
// RICERCA
// ---------------------------------------------------------------------------------------------------------------------
const searchOpen = () => searchContainer.classList.contains('expanded');
function collapseSearch() { searchContainer.classList.remove('expanded'); searchToggleBtn.setAttribute('aria-expanded', 'false'); resultsEl.classList.remove('active'); }
// azzera testo, risultati e percorso scelto dalla ricerca
function clearSearchState(force = false) { if (lineFilter && !force) return; setLineFilter(null); filterEl.value = ''; $('search-clear').hidden = true; resultsEl.classList.remove('active'); resultsEl.innerHTML = ''; clearRoutes(); }
function setSearch(on) {
  searchContainer.classList.toggle('expanded', on); searchToggleBtn.setAttribute('aria-expanded', String(on));
  if (on) { Tide.close(); Avvisi.close(); filterEl.focus(); } else clearSearchState(true);
}
searchToggleBtn.onclick = e => { e.stopPropagation(); setSearch(!searchOpen()); };
document.addEventListener('click', e => { if (searchOpen() && !searchContainer.contains(e.target) && !searchToggleBtn.contains(e.target)) collapseSearch(); });
$('search-clear').onclick = () => { filterEl.value = ''; filterEl.dispatchEvent(new Event('input')); filterEl.focus(); };

const zoneItem = z => `<div class="search-item" role="option" tabindex="0" data-type="zone" data-key="${esc(z.key)}" data-name="${esc(z.name)}">${srcIcon(z.src)} <span>${esc(z.name)}</span><span class="muted">${z.letters.length} ${unitOf(z)[1]}</span></div>`;
filterEl.addEventListener('input', () => {
  $('search-clear').hidden = !filterEl.value;
  const q = filterEl.value.trim().toLowerCase().slice(0, 80), qn = norm(q);
  if (!q) { resultsEl.classList.remove('active'); resultsEl.innerHTML = ''; setLineFilter(null); clearRoutes(); return; }
  const mzAll = [...zones.values()].filter(z => active.has(z.src) && z.norm.includes(qn)), mz = mzAll.slice(0, 8);
  const ms = stops.filter(s => active.has(s[4]) && snorm.get(s[0])?.includes(qn) && !mzAll.includes(zoneOf.get(s[0]))).slice(0, 8);
  const byLine = new Map();                                        // una voce per linea e servizio (le varianti con lo stesso numero si uniscono)
  for (const [id, r] of Object.entries(routesData)) if (active.has(r.src) && String(r.name).toLowerCase().includes(q)) {
    const k = r.src + '|' + r.name; (byLine.get(k) || byLine.set(k, { src: r.src, name: String(r.name), color: r.color, ids: [] }).get(k)).ids.push(id);
  }
  const rank = l => (l.name.toLowerCase() === q ? 0 : l.name.toLowerCase().startsWith(q) ? 1 : 2);
  const mrBy = src => [...byLine.values()].filter(l => l.src === src).sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name, 'it', { numeric: true })).slice(0, 14);
  let hs = '', hl = '';
  if (mz.length || ms.length) hs += '<div class="search-category">Fermate</div>' + mz.map(zoneItem).join('') + ms.map(s =>
    `<div class="search-item" role="option" tabindex="0" data-type="stop" data-id="${esc(s[0])}" data-name="${esc(s[1])}" data-lat="${+s[2]}" data-lon="${+s[3]}" data-src="${esc(s[4])}">${icon('pin')} <span>${esc(s[1])}</span></div>`).join('');
  for (const [src, title] of [['aut', 'Linee · Automobilistico e tram'], ['nav', 'Linee · Navigazione']]) {
    const list = mrBy(src); if (!list.length) continue;
    hl += `<div class="search-category">${title}</div>` + list.map(l =>
      `<div class="search-item" role="option" tabindex="0" data-type="route" data-src="${src}" data-ids="${esc(l.ids.join('\u0001'))}" data-name="${esc(l.name)}">${badge(l.name, l.color, src)} <span>Linea ${esc(l.name)}</span><span class="muted">solo questa linea</span></div>`).join('');
  }
  const linesFirst = [...byLine.values()].some(l => l.name.toLowerCase().startsWith(q));   // chi scrive "12" o "4L" cerca una linea: prima le linee
  const html = linesFirst ? hl + hs : hs + hl;
  resultsEl.innerHTML = html || '<div class="search-item muted">Nessun risultato trovato</div>';
  resultsEl.classList.add('active');
});
resultsEl.addEventListener('click', e => {
  const it = e.target.closest('.search-item');
  if (!it || !it.dataset.type) return;
  if (it.dataset.type === 'near') { collapseSearch(); const n = nearList[+it.dataset.k]; if (n) openNear(n); return; }
  filterEl.value = it.dataset.name; resultsEl.classList.remove('active');
  collapseSearch();
  if (it.dataset.type === 'zone') { const z = zones.get(it.dataset.key); if (z) { openFromMap({ t: 'zone', key: z.key, pick: '*' }); focusOn(L.latLng(z.center), 16); } }
  else if (it.dataset.type === 'stop') { openFromMap(entryForStop(it.dataset.id, it.dataset.name, it.dataset.src)); focusOn(L.latLng(+it.dataset.lat, +it.dataset.lon), 16); }
  else setLineFilter({ src: it.dataset.src, name: it.dataset.name, ids: it.dataset.ids.split('\u0001') });
});
// un tocco sulla mappa vuota chiude i percorsi della ricerca (se nessun pannello è aperto) e le finestre troppo grandi
map.on('click', () => { if (!current && !searchOpen()) clearSearchState(); if (narrow()) { Tide.close(); Avvisi.close(); } });

// ---------------------------------------------------------------------------------------------------------------------
// NAVIGAZIONE TRA PANNELLI
// Tre tipi di pannello: stop (fermata), zone (gruppo di pali), trip (corsa di un mezzo). Da un pannello si passa a un altro cliccando una riga
// (fermata -> corsa, corsa -> fermata): il pannello di partenza finisce in navStack e il link blu «indietro» lo riapre così com'era.
// Aprire un pannello dalla mappa (mezzo, palo, ricerca) riparte da zero.
// ---------------------------------------------------------------------------------------------------------------------
const NAV_MAX = 20;
const vehSnap = v => ({ id: v.id, key: v.key, src: v.src, tripId: v.tripId, routeId: v.routeId, line: v.line, color: v.color, label: v.label, headsign: v.headsign, dup: v.dup, dupWith: v.dupWith, lat: v.lat, lon: v.lon });
function entryForStop(id, name, src) {
  const z = zoneOf.get(id);
  return z ? { t: 'zone', key: z.key, pick: z.letterOf.get(id) || '*' } : { t: 'stop', id, name, src };
}
function describe(e) {   // testo del link «indietro»
  if (e.t === 'stop') return e.name;
  if (e.t === 'zone') return zones.get(e.key)?.name || 'Zona';
  return `Linea ${e.v.line}${e.v.headsign ? ' · ' + e.v.headsign : ''}`;
}
function updateBack() {
  const top = navStack[navStack.length - 1];
  pback.hidden = !top;
  if (top) { pback.innerHTML = `${icon('back', 'sm')}<span>${esc(describe(top))}</span>`; pback.setAttribute('aria-label', 'Indietro: ' + describe(top)); }
}
function openFromMap(e) { navStack.length = 0; show(e); }
function openFromPanel(e) {
  if (current) { navStack.push(current.t === 'trip' ? { ...current, follow } : current); if (navStack.length > NAV_MAX) navStack.shift(); }
  show(e);
}
function goBack() { const e = navStack.pop(); if (e) show(e); }
pback.onclick = e => { e.preventDefault(); goBack(); };

function show(e) {
  clearInterval(panelTimer); lastDeps = null; lastTrip = null;
  tripLayer.clearLayers(); setFollow(false);
  if (e.t !== 'trip') { selVeh = null; render(); }
  current = e; panel.hidden = false; document.body.classList.add('has-panel'); if (narrow()) { Tide.close(); Avvisi.close(); }
  chipsArea.innerHTML = ''; pstatus.textContent = ''; psub.textContent = ''; pbadge.innerHTML = '';
  pfollow.hidden = e.t !== 'trip';
  updateBack();
  if (e.t === 'trip') showTrip(e); else showStopPanel(e);
  drawStops();
}
function closePanel() {
  const hadTrip = current?.t === 'trip' || navStack.some(x => x.t === 'trip');
  navStack.length = 0; current = null; lastDeps = null; lastTrip = null; clearInterval(panelTimer);
  setFollow(false); tripLayer.clearLayers(); keepInView = null;
  if (selVeh) { selVeh = null; render(); }
  panel.hidden = true; document.body.classList.remove('has-panel'); chipsArea.innerHTML = '';
  if (hadTrip && !searchOpen()) clearSearchState();        // il percorso mostrato per la corsa sparisce; i percorsi di una ricerca ancora aperta restano
  drawStops();
}
$('pclose').onclick = closePanel;

const refreshPanel = () => { if (!current) return; if (current.t === 'trip') loadTrip(); else loadDepartures(); };
const startPanelTimer = () => { clearInterval(panelTimer); panelTimer = setInterval(() => { if (Date.now() - lastPushAt > 6000) refreshPanel(); }, 4000); };   // rete di sicurezza se lo stream non arriva

// ---------------------------------------------------------------------------------------------------------------------
// PANNELLO FERMATA / ZONA
// ---------------------------------------------------------------------------------------------------------------------
// ids delle fermate del pannello aperto e relativi avvisi in corso
const stopIds = e => (e.t === 'zone' ? (zones.get(e.key)?.items || []).map(i => i.id) : [e.id]);
const stopAlerts = e => Avvisi.forStops(stopIds(e));
const stopTitle = (e, z = e.t === 'zone' ? zones.get(e.key) : null) => `${srcIcon(z ? z.src : e.src)}<span>${esc(z ? z.name : e.name)}</span>${stopAlerts(e).length ? `<span class="warn-i" title="Avviso in corso">${icon('warn')}</span>` : ''}`;
function showStopPanel(e) {
  const z = e.t === 'zone' ? zones.get(e.key) : null;
  if (e.t === 'zone' && !z) { plist.innerHTML = '<p class="muted pad">Zona non più disponibile.</p>'; return; }
  if (z) z.pick = e.pick || '*';
  pname.innerHTML = stopTitle(e, z);
  plist.innerHTML = '<p class="muted pad">Caricamento…</p>';
  const ll = z ? L.latLng(z.center) : (() => { const s = stops.find(x => x[0] === e.id); return s ? L.latLng(s[2], s[3]) : null; })();
  keepInView = ll ? () => ll : null;
  loadDepartures(); startPanelTimer();
}
async function loadDepartures() {
  const e = current; if (!e || e.t === 'trip') return;
  const z = e.t === 'zone' ? zones.get(e.key) : null;
  const url = z ? '/api/zone?ids=' + encodeURIComponent(z.items.map(i => i.id).join(',')) : '/api/stop?id=' + encodeURIComponent(e.id);
  try {
    const d = await api(url + schedQS().replace('&', url.includes('?') ? '&' : '?'));
    if (d.error) throw new Error(d.error);
    if (current !== e) return;
    lastDeps = d; renderDepartures();
  } catch (err) { if (current === e && !(err.busy && lastDeps)) plist.innerHTML = `<p class="late pad">Dati non disponibili: ${esc(err.message)}</p>`; }
}

function depRow(x, z, live) {
  const src = x.src, done = !!x.done;
  let cls = '', subNote = '';
  if (x.cancel) { cls = 'late'; subNote = x.cancel === 'trip' ? 'Soppressa' : 'Saltata'; }
  else if (live) {
    if (!x.live) subNote = 'da orario';
    else { const di = delayInfo(x.delay); cls = di.cls; subNote = done ? di.txt.replace('in ', 'partito in ').replace('partito in orario', 'partito in orario') : di.txt; }
  }
  if (done) cls = '';                                                         // riga grigia: nessun colore di stato
  const reqHtml = x.isRequest ? '<span class="req-tag">A richiesta</span>' : '';
  const vName = (live && x.vehicle) ? vehName(src, x.vehicle) : '';
  const info = [subNote, vName].filter(Boolean).join(' · ');
  const timeHtml = (live && Math.abs(x.delay) >= 1)
    ? `<div class="dt-time-wrap"><span class="sched-crossed">${esc(x.sched)}</span><strong class="${cls}">${esc(x.exp)}</strong></div>`
    : `<div class="dt-time-wrap"><strong class="${cls}">${esc(live ? x.exp : x.sched)}</strong></div>`;
  const label = etaText(x.phase, x.expMs, x.tIn, live);
  // l'indicatore sotto l'orario ha SEMPRE il colore neutro (come nel pannello della corsa): il colore di stato è solo sull'orario
  return `<div class="dep go${x.cancel ? ' cx' : ''}${done ? ' gone' : ''}" data-trip="${esc(x.tripId)}" data-src="${esc(src)}" data-stop="${esc(x.stop || '')}" data-veh="${esc(x.veh || '')}" role="button" tabindex="0" title="${done ? 'Corsa già partita: apri il percorso' : 'Apri il percorso della corsa'}">`
    + badge(x.line, x.color, src)
    + `<div class="dm"><div class="dh">${esc(x.headsign || '')}</div><div class="dn ${cls}">${z ? ptHtml(z.letterOf.get(x.stop), true) : ''}${reqHtml}<span>${esc(info)}</span></div></div>`
    + `<div class="dt">${timeHtml}<div class="in-min" data-exp="${live && x.expMs ? Math.round(x.expMs) : ''}" data-ph="${live ? (x.phase || '') : ''}">${esc(label)}</div></div></div>`;
}
function renderDepartures() {
  if (!lastDeps || !current || current.t === 'trip') return;
  const live = mode === 'live', z = current.t === 'zone' ? zones.get(current.key) : null;
  psub.textContent = (z ? `${z.letters.length} ${unitOf(z)[1]} · ` : '') + (live ? `Live · ${new Date(lastDeps.liveUpdated).toLocaleTimeString('it-IT')}` : 'Orario') + (lastDeps.note ? ` · ${lastDeps.note}` : '');
  const rows = lastDeps.departures.map(x => ({ ...x, tIn: live ? x.expIn : x.schedIn, tSec: live ? x.expSec : x.schedIn * 60 }))
    .filter(x => !x.arrival && x.tIn >= -30 && x.tIn <= 120 && active.has(x.src) && (live || !x.done))
    .filter(x => !z || z.pick === '*' || z.letterOf.get(x.stop) === z.pick)
    .sort((a, b) => a.tSec - b.tSec).slice(0, z ? 60 : 30);
  chipsArea.innerHTML = z ? `<div class="chips"><span class="muted">${unitOf(z)[0]}</span>`
    + `<button class="chip${z.pick === '*' ? ' on' : ''}" data-p="*">Tutti</button>`
    + z.letters.map(l => `<button class="chip${z.pick === l ? ' on' : ''}" data-p="${esc(l)}">${ptHtml(l, true)}</button>`).join('') + '</div>' : '';
  const al = stopAlerts(current);                                                           // avvisi in corso su queste fermate: simbolo (!) nel titolo e righe cliccabili che aprono l'avviso
  pname.innerHTML = stopTitle(current, z);
  plist.innerHTML = al.map(Avvisi.rowHtml).join('') + (rows.map(x => depRow(x, z, live)).join('') || '<p class="muted pad center">Nessun passaggio.</p>');
}
chipsArea.addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (chip && current?.t === 'zone') { const z = zones.get(current.key); if (z) { z.pick = current.pick = chip.dataset.p; drawStops(); renderDepartures(); } }
});
plist.addEventListener('click', e => {
  const av = e.target.closest('.alert-row'); if (av) return Avvisi.openAlert(av.dataset.av);
  const dep = e.target.closest('.dep.go');
  if (dep && current && current.t !== 'trip') return openDeparture(dep.dataset);
  const row = e.target.closest('.st'); if (!row || !lastTrip) return;
  const s = lastTrip.stops[+row.dataset.i]; if (!s) return;
  openFromPanel(entryForStop(s.id, s.name, lastTrip.trip.src));          // dalla corsa alla fermata (con «indietro» alla corsa)
  if (s.lat != null) focusOn(L.latLng(s.lat, s.lon), Math.max(map.getZoom(), 16));
});

// Dalla riga di un passaggio si apre la corsa e si segue il mezzo (se la mappa ne ha la posizione)
function openDeparture(ds) {
  const src = ds.src, tripId = ds.trip, stop = ds.stop, veh = ds.veh;
  const x = lastDeps && lastDeps.departures.find(d => d.tripId === tripId && d.src === src && (!stop || d.stop === stop) && (!veh || (d.veh || '') === veh)); if (!x) return;
  const v = (veh && vehicles.find(c => c.src === src && c.key === veh)) || vehicles.find(c => c.src === src && c.tripId === tripId && !c.co)
    || { id: null, src, tripId, routeId: null, line: x.line, label: x.vehicle, headsign: x.headsign, color: x.color };
  openFromPanel({ t: 'trip', v: vehSnap(v), follow: !!v.id });
}

// ---------------------------------------------------------------------------------------------------------------------
// PANNELLO CORSA (mezzo)
// ---------------------------------------------------------------------------------------------------------------------
function showTrip(e) {
  const v = vehicles.find(x => x.id === e.v.id) || e.v;       // dati più freschi se il mezzo è ancora in elenco
  e.v = vehSnap(v); selVeh = v.id; render(); drawStops();
  pbadge.innerHTML = badge(v.line, v.color, v.src);
  pname.innerHTML = `${icon('next', 'sm')}<span>${v.headsign ? esc(v.headsign) : 'Linea ' + esc(v.line)}</span>`;
  psub.textContent = 'Caricamento dettagli…';
  pfollow.disabled = !v.id;
  keepInView = () => { const m = selVeh && markers.get(selVeh); return m ? m.m.getLatLng() : null; };
  if (!v.tripId) {
    plist.innerHTML = `<p class="muted pad">${v.dup ? `La corsa di questo mezzo risulta assegnata anche al mezzo ${esc(v.dupWith)}: il sistema segue quello più coerente col percorso.` : 'Dati corsa non disponibili per questo mezzo.'}</p>`;
    psub.textContent = ''; showRoutes([v.routeId], tripLayer); if (v.id) ensureVisible(L.latLng(v.lat, v.lon)); return;
  }
  e.drawn = false; plist.innerHTML = '<p class="muted pad">Caricamento…</p>';
  if (e.follow) { setFollow(true); const m = markers.get(selVeh); focusOn(m ? m.m.getLatLng() : L.latLng(v.lat, v.lon), Math.max(map.getZoom(), 15)); }
  else if (v.id && Number.isFinite(v.lat)) ensureVisible(L.latLng(v.lat, v.lon));
  loadTrip(); startPanelTimer();
}
async function loadTrip() {
  const e = current; if (!e || e.t !== 'trip' || !e.v.tripId) return;
  try {
    const d = await api(`/api/trip?id=${encodeURIComponent(e.v.src + ':' + e.v.tripId)}&mode=${mode}${e.v.key ? '&veh=' + encodeURIComponent(e.v.key) : ''}${schedQS()}`);
    if (d.error) throw new Error(d.error);
    if (current !== e) return;
    lastTrip = d; renderTrip(!e.drawn); e.drawn = true;
  } catch (err) {
    if (err.loading) { if (current === e) setTimeout(() => { if (current === e) loadTrip(); }, 3000); return; }
    if (current === e && !(err.busy && lastTrip)) plist.innerHTML = `<p class="late pad">Dati non disponibili: ${esc(err.message)}</p>`; }
}
function tripHtml(d) {
  const k = colorInfo(d.trip.color, d.trip.line), n = d.stops.length;
  const rows = d.stops.map((s, i) => {
    let timeHtml = '', sub = '';
    if (d.live && d.detected !== false && s.delay != null) {
      const di = delayInfo(s.delay); sub = di.txt;
      timeHtml = Math.abs(s.delay) >= 1
        ? `<div class="tm-time-wrap"><span class="sched-crossed">${esc(s.sched)}</span><strong class="${di.cls}">${esc(s.exp)}</strong></div>`
        : `<div class="tm-time-wrap"><strong class="${di.cls}">${esc(s.exp)}</strong></div>`;
    } else { sub = d.live && d.detected !== false ? 'da orario' : (d.live ? 'non rilevato' : ''); timeHtml = `<div class="tm-time-wrap"><strong>${esc(s.sched)}</strong></div>`; }
    const meta = s.skipped ? 'Fermata saltata' : (s.state === 'at' || s.state === 'next') ? etaText(s.phase, s.expMs, s.inMin, d.live && d.detected !== false) : (s.state === 'upcoming' && d.live && s.expMs ? `tra ${Math.max(1, Math.round((s.expMs - Date.now()) / 60000))} min` : '');
    return `<div class="st ${s.state}${s.skipped ? ' cx' : ''}${i === 0 ? ' first' : ''}${i === n - 1 ? ' last' : ''}" data-i="${i}" role="button" tabindex="0" title="Apri la fermata">`
      + `<div class="rail-col"><div class="rail-line"></div><span class="dot">${s.state === 'passed' ? icon('check') : ''}</span></div>`
      + `<div class="sn"><div class="nm">${esc(s.name)}</div>${meta ? `<div class="muted">${esc(meta)}</div>` : ''}</div>`
      + `<div class="tm">${timeHtml}<div class="muted">${esc(sub)}</div></div></div>`;
  }).join('');
  const weak = lum(k.rail) > .8 || lum(k.rail) < .03;   // bianco o nero puro non si vedono su uno dei due temi: si usa il colore del testo
  return `<div class="tl" style="--rc:${weak ? 'var(--fg)' : k.rail};--check-fg:${weak ? 'var(--bg)' : k.contrast}"><div class="trav"></div><div class="veh">${vehIcon(d.trip.src, d.trip.vehicle, '', d.trip.line)}</div>${rows}</div>`;
}
// posiziona il mezzo sulla linea del tempo, fra le due fermate in cui si trova, con scorrimento fluido
function placeVehicle(d, first) {
  const tl = plist.querySelector('.tl'), veh = tl && tl.querySelector('.veh'), trav = tl && tl.querySelector('.trav');
  if (!tl || !veh || !trav) return;
  const rows = tl.querySelectorAll('.st'), a = rows[d.progress.from], b = rows[d.progress.from + 1];
  if (!a) { veh.style.display = 'none'; trav.style.display = 'none'; return; }
  veh.style.display = ''; trav.style.display = '';
  const tlRect = tl.getBoundingClientRect();
  const dotCenter = row => { const r = row.querySelector('.dot').getBoundingClientRect(); return { x: r.left - tlRect.left + r.width / 2, y: r.top - tlRect.top + r.height / 2 }; };
  const firstCenter = dotCenter(rows[0]), ca = dotCenter(a).y, cb = b ? dotCenter(b).y : ca, y = ca + (cb - ca) * (b ? d.progress.frac : 0);
  veh.style.left = firstCenter.x + 'px'; trav.style.left = firstCenter.x + 'px'; trav.style.top = firstCenter.y + 'px';
  const from = !first && vehMemo.trip === current.v.tripId ? vehMemo.y : y;
  veh.style.transition = trav.style.transition = 'none';
  veh.style.top = from + 'px'; trav.style.height = Math.max(0, from - firstCenter.y) + 'px';
  void veh.offsetHeight;
  veh.style.transition = trav.style.transition = '';
  veh.style.top = y + 'px'; trav.style.height = Math.max(0, y - firstCenter.y) + 'px';
  vehMemo = { trip: current.v.tripId, y };
}
function renderTrip(first) {
  const d = lastTrip; if (!d || !current || current.t !== 'trip') return;
  let status = 'programmato';
  if (d.live && d.detected === false) status = 'Non rilevato';
  else if (d.live) status = d.delayNow == null ? 'live' : `<span class="${delayInfo(d.delayNow).cls}">${esc(delayInfo(d.delayNow).txt)}</span>`;
  pname.innerHTML = `${icon('next', 'sm')}<span>${d.trip.headsign ? esc(d.trip.headsign) : 'Linea ' + esc(d.trip.line)}</span>`;
  const o = d.stops[0];
  psub.innerHTML = (o ? `da ${esc(o.name)}${o.sched ? ', ' + esc(o.sched) : ''}` : '') + (d.note ? `<br>${esc(d.note)}` : '');
  pstatus.innerHTML = d.live && d.detected === false ? 'Non rilevato' : `${status} · ${esc(vehName(d.trip.src, d.trip.vehicle || current.v.label))}${d.live && d.detected !== false && d.speedKmh != null ? ` · ${+d.speedKmh} km/h` : ''}${d.others?.length ? ` · insieme a ${d.others.map(esc).join(', ')}` : ''}`;
  plist.innerHTML = (d.cancelled ? '<div class="banner">Corsa soppressa</div>' : '') + tripHtml(d)
    + (d.live && d.historyKnown ? '<p class="muted note-hist">Fermate passate: ultima stima.</p>' : '');
  placeVehicle(d, first);
  if (!first) return;
  // percorso della corsa e fermate sulla mappa (livello proprio: sparisce con la X)
  routeToken++; lineLayer.clearLayers(); tripLayer.clearLayers();
  drawLine(d.shape?.length ? d.shape : [], colorInfo(d.trip.color, d.trip.line), tripLayer, .95);
  if (!d.shape?.length) showRoutes([current.v.routeId], tripLayer);
  for (const s of d.stops) if (s.lat != null) L.circleMarker([s.lat, s.lon], { radius: 3.5, weight: 1.5, color: '#0f172a', fillColor: '#fff', fillOpacity: .9 }).bindTooltip(esc(s.name)).addTo(tripLayer);
  const veh = plist.querySelector('.veh'), row = veh && veh.style.display !== 'none' ? veh : plist.querySelector('.st.at, .st.next');
  if (row) row.scrollIntoView({ block: 'center' });
}

// ---------------------------------------------------------------------------------------------------------------------
// INSEGUIMENTO (pulsante accanto alla X del pannello del mezzo)
// ---------------------------------------------------------------------------------------------------------------------
let followAfter = 0;
function setFollow(on) {
  follow = !!on && !!selVeh;
  pfollow.setAttribute('aria-pressed', String(follow));
  pfollow.setAttribute('aria-label', follow ? 'Smetti di seguire il mezzo' : 'Segui il mezzo'); pfollow.title = follow ? 'Smetti di seguire il mezzo' : 'Segui il mezzo';
  if (follow) followAfter = Date.now() + 900;                    // il tempo del volo iniziale
}
pfollow.onclick = () => {
  setFollow(!follow);
  if (follow) { const m = markers.get(selVeh); if (m) focusOn(m.m.getLatLng(), Math.max(map.getZoom(), 15)); }
};
map.on('dragstart', () => setFollow(false));                     // l'utente sposta la mappa a mano: l'inseguimento si ferma

// ---------------------------------------------------------------------------------------------------------------------
// POSIZIONE DELL'UTENTE, FILTRI, MODALITÀ
// ---------------------------------------------------------------------------------------------------------------------
let me = null;
let meLL = null, watching = false, lowAcc = false;
function startLocate() {
  map.locate({ setView: true, maxZoom: 16, watch: true, enableHighAccuracy: !lowAcc, timeout: 20000, maximumAge: 5000 });
  watching = true; $('locate').setAttribute('aria-pressed', 'true');
}
$('locate').onclick = () => {
  if (watching && meLL) { map.setView(meLL, Math.max(map.getZoom(), 16)); return; }   // già attiva: ricentra
  if (watching) return;                                                                  // in attesa del primo segnale
  setNearNote('Cerco la tua posizione…'); startLocate();
};
// FERMATE VICINE: una piccola pillola accanto allo stato in alto a sinistra, che si apre con un tocco. Nessun elemento fisso in più sulla mappa.
// Entro NEAR_M si elencano tutte le fermate; se non ce n'è nessuna, la pillola dice quanto dista la più vicina (così c'è sempre una risposta).
const NEAR_M = 300, NEAR_FAR_M = 3000;
let nearList = [], nearFar = null;
function nearbyStops() {
  nearFar = null; if (!meLL) return [];
  const by = new Map();
  for (const s of stops) {
    if (!active.has(s[4])) continue;
    const d = mDist(meLL.lat, meLL.lng, +s[2], +s[3]); if (d > NEAR_FAR_M) continue;
    const z = zoneOf.get(s[0]), key = z ? 'z:' + z.key : 's:' + s[0], o = by.get(key);
    if (!o || d < o.d) by.set(key, { d, zone: z || null, stop: s });
  }
  const all = [...by.values()].sort((x, y) => x.d - y.d), near = all.filter(n => n.d <= NEAR_M);
  if (!near.length && all.length) nearFar = all[0];
  return near;
}
const nm = n => (n.zone ? n.zone.name : n.stop[1]), nsrc = n => (n.zone ? n.zone.src : n.stop[4]), rnd = d => (d < 100 ? Math.round(d / 5) * 5 : Math.round(d / 10) * 10);
function setNearNote(txt) { const chip = $('nearchip'); chip.hidden = false; chip.innerHTML = `${icon('pin', 'sm')}<span>${esc(txt)}</span>`; chip.dataset.k = 'note'; chip.setAttribute('aria-label', txt); }
function updateNear() {
  const chip = $('nearchip'); nearList = nearbyStops(); chip.dataset.k = '';
  if (!meLL) { chip.hidden = true; chip.innerHTML = ''; return; }
  if (!stops.length) { setNearNote('Cerco le fermate vicine…'); return; }
  if (nearList.length) {
    const n = nearList[0];
    chip.hidden = false;
    chip.innerHTML = `${srcIcon(nsrc(n), 'sm')}<span>${esc(nm(n))} · ${rnd(n.d)} m</span>${nearList.length > 1 ? `<span class="more">+${nearList.length - 1}</span>` : ''}`;
    chip.setAttribute('aria-label', nearList.length > 1 ? `Fermate vicine: ${nearList.length}, la più vicina è ${nm(n)}` : `Fermata vicina: ${nm(n)}, a circa ${Math.round(n.d)} metri`);
  } else if (nearFar) {
    chip.hidden = false; chip.dataset.k = 'far';
    chip.innerHTML = `${srcIcon(nsrc(nearFar), 'sm')}<span>Nessuna fermata entro ${NEAR_M} m · più vicina: ${esc(nm(nearFar))}, ${rnd(nearFar.d)} m</span>`;
    chip.setAttribute('aria-label', `Nessuna fermata entro ${NEAR_M} metri. La più vicina è ${nm(nearFar)}, a circa ${Math.round(nearFar.d)} metri`);
  } else setNearNote('Nessuna fermata vicina ai servizi attivi');
}
const openNear = n => { if (n.zone) { openFromMap({ t: 'zone', key: n.zone.key, pick: '*' }); focusOn(L.latLng(n.zone.center), 17); } else { openFromMap(entryForStop(n.stop[0], n.stop[1], n.stop[4])); focusOn(L.latLng(+n.stop[2], +n.stop[3]), 17); } };
$('nearchip').onclick = e => {
  e.stopPropagation();
  const k = $('nearchip').dataset.k;
  if (k === 'note') return;
  if (k === 'far') { openNear(nearFar); return; }
  if (nearList.length === 1) { openNear(nearList[0]); return; }
  setSearch(true);                                                        // più fermate: si riusa l'elenco della ricerca
  resultsEl.innerHTML = `<div class="search-category">Vicino a te (entro ${NEAR_M} m)</div>` + nearList.map((n, i) =>
    `<div class="search-item" role="option" tabindex="0" data-type="near" data-k="${i}">${srcIcon(nsrc(n))} <span>${esc(nm(n))}</span><span class="muted">${rnd(n.d)} m</span></div>`).join('');
  resultsEl.classList.add('active');
};
map.on('locationfound', e => {
  if (me) me.remove();
  meLL = e.latlng;
  me = L.circleMarker(e.latlng, { radius: 6, color: '#fff', weight: 2, fillColor: '#0284c7', fillOpacity: 1 }).addTo(map);
  updateNear();
});
map.on('locationerror', e => {
  if (e && e.code === 1) { map.stopLocate(); watching = false; meLL = null; $('locate').setAttribute('aria-pressed', 'false'); updateNear(); statusEl.className = 'err'; statusEl.textContent = 'Permesso di posizione negato: abilitalo nelle impostazioni del browser'; return; }
  if (!lowAcc) { lowAcc = true; map.stopLocate(); startLocate(); return; }                 // segnale GPS non disponibile (al chiuso, tempo scaduto): secondo tentativo con precisione ridotta
  map.stopLocate(); watching = false; meLL = null; $('locate').setAttribute('aria-pressed', 'false'); updateNear(); statusEl.className = 'err'; statusEl.textContent = 'Posizione non disponibile';
});

document.querySelectorAll('input[name=mode]').forEach(el => el.addEventListener('change', () => {
  mode = el.value; vehicles = [];
  const sched = mode === 'sched';
  document.body.classList.toggle('sched-mode', sched);
  if (sched) applyTime(+range.value, true); else { stopPlay(); load(); }
  render(); renderDepartures();
  if (current?.t === 'trip' && current.v.tripId) loadTrip();
  if (current && current.t !== 'trip') loadDepartures();
}));
document.querySelectorAll('input[name=src]').forEach(el => el.addEventListener('change', () => {
  if (el.checked) active.add(el.value); else active.delete(el.value);
  if (!active.size) { active.add(el.value); el.checked = true; }
  vehicles = vehicles.filter(v => active.has(v.src));
  render(); drawStops(); load(); updateNear();
}));

// AGGIORNAMENTO A SPINTA: il server avvisa (SSE) appena ci sono dati nuovi, così mezzi e pannelli si aggiornano subito.
// I timer restano come rete di sicurezza e scattano solo se lo stream tace da oltre 6 s. Massimo un aggiornamento ogni 1,5 s.
let lastPushAt = 0, lastPushRun = 0, lastPanelAt = 0, pushTimer = null;
function onPush(changed) {
  lastPushAt = Date.now();
  if (document.hidden || mode !== 'live') return;
  const wait = 1500 - (Date.now() - lastPushRun);
  if (wait > 0) { if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; onPush(changed); }, wait); return; }
  lastPushRun = Date.now();
  if (changed) load();
  if (Date.now() - lastPanelAt >= 4000) { lastPanelAt = Date.now(); refreshPanel(); }   // pannello: al massimo ogni 4 s (limita le richieste al server)
}
try { const es = new EventSource('/api/stream'); es.onmessage = e => onPush(e.data === '1'); } catch { /* si usano i timer */ }

// ---------------------------------------------------------------------------------------------------------------------
// TEMA · FINESTRE · TASTIERA
// ---------------------------------------------------------------------------------------------------------------------
const root = document.documentElement, themeBtn = $('theme-btn');
const narrow = () => matchMedia('(max-width: 759px)').matches;   // sotto questa larghezza le finestre sono mutuamente esclusive (non si sovrappongono)
function applyTheme(t, save) {
  root.dataset.theme = t; themeBtn.setAttribute('aria-pressed', String(t === 'dark'));
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = t === 'dark' ? '#121a28' : '#ffffff';
  if (save) { try { localStorage.setItem('theme', t); } catch { /* navigazione privata */ } }
}
themeBtn.setAttribute('aria-pressed', String(root.dataset.theme === 'dark'));
themeBtn.onclick = () => applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', e => {      // finché l'utente non sceglie, si segue il sistema
  try { if (localStorage.getItem('theme')) return; } catch { /* ignora */ }
  applyTheme(e.matches ? 'dark' : 'light');
});
Tide.init(() => { Avvisi.close(); if (narrow() && !panel.hidden) closePanel(); collapseSearch(); });
Avvisi.init(() => { Tide.close(); if (narrow() && !panel.hidden) closePanel(); collapseSearch(); }, () => { drawStops(); if (current && current.t !== 'trip') renderDepartures(); });   // quando arrivano avvisi nuovi si aggiornano mappa e pannello fermata
Pwa.init();

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {   // chiude la finestra più "in alto": marea, poi ricerca, poi pannello
    if (Avvisi.isOpen()) { const inside = $('avvisi').contains(document.activeElement); Avvisi.close(); if (inside) $('avvisi-btn').focus(); }
    else if (Tide.isOpen()) { const inside = $('tide').contains(document.activeElement); Tide.close(); if (inside) $('tide-btn').focus(); }
    else if (searchOpen()) { setSearch(false); searchToggleBtn.focus(); }
    else if (!panel.hidden) closePanel();
  } else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.dep.go,.st,.search-item')) { e.preventDefault(); e.target.click(); }   // righe cliccabili anche da tastiera
});

// ---------------------------------------------------------------------------------------------------------------------
// AVVIO
// ---------------------------------------------------------------------------------------------------------------------
$('tl-time').textContent = fmtSecs(+range.value); syncPlay(); setFollow(false); drawStops(); updateClock(); load();
setInterval(() => { if (Date.now() - lastPushAt > 6000) load(); }, POLL_MS);
