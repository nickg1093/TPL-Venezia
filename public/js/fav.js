// FERMATE PREFERITE. Restano nel dispositivo (memoria del browser per questo sito): sopravvivono agli aggiornamenti dell'app,
// ai riavvii e alla chiusura; si perdono solo cancellando i dati del sito o usando un altro indirizzo. Al primo preferito si chiede al
// browser di non cancellare la memoria da solo quando lo spazio scarseggia (navigator.storage.persist).
// Formato versionato ("v": 1) per poterlo aggiornare in futuro senza perdere nulla.
const KEY = 'tpl.favorites';
let list = load();
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (d && d.v === 1 && Array.isArray(d.items)) return d.items.filter(x => x && typeof x.k === 'string' && x.k.length <= 220 && typeof x.name === 'string').slice(0, 100)
      .map(x => ({ k: x.k, name: x.name.slice(0, 160), src: x.src === 'nav' ? 'nav' : 'aut', at: Number(x.at) || 0 }));
  } catch { /* memoria non disponibile o dato rovinato: si riparte vuoti */ }
  return [];
}
function save() { try { localStorage.setItem(KEY, JSON.stringify({ v: 1, items: list })); return true; } catch { return false; } }
// chiave stabile: zona per nome ("zone:aut|venezia") o fermata singola ("stop:aut:512")
export const keyOf = e => (e.t === 'zone' ? 'zone:' + e.key : 'stop:' + (e.id || ''));
export const all = () => list.slice();
export const has = e => list.some(x => x.k === keyOf(e));
export function toggle(e, name, src) {
  const k = keyOf(e), i = list.findIndex(x => x.k === k);
  if (i >= 0) { list.splice(i, 1); save(); return false; }
  list.unshift({ k, name, src, at: Date.now() }); list = list.slice(0, 100);
  const ok = save();
  try { navigator.storage?.persist?.(); } catch { /* facoltativo */ }
  return ok ? true : null;                                              // null = memoria del browser non disponibile (es. navigazione privata)
}
export function remove(k) { list = list.filter(x => x.k !== k); save(); }
// altre schede/finestre: stesso elenco
window.addEventListener('storage', ev => { if (ev.key === KEY) list = load(); });

// PERCORSI PREFERITI (pianificatore): partenza e arrivo, nello stesso dispositivo. Punti: fermata, zona, «la mia posizione» (senza coordinate:
// si usa quella del momento) o un punto della mappa (coordinate arrotondate a ~10 m, restano solo qui).
const KEY_R = 'tpl.percorsi';
// la memoria del browser non è affidabile: tipi e lunghezze controllati, poi il punto si ricostruisce (epClean)
const sOk = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n, nOk = v => v == null || Number.isFinite(+v);
const epOk = p => !!p && typeof p === 'object' && sOk(p.label, 160) && (
  p.kind === 'me' || (p.kind === 'point' && Number.isFinite(+p.lat) && Number.isFinite(+p.lon))
  || (p.kind === 'zone' && sOk(p.key, 200) && nOk(p.lat) && nOk(p.lon)) || (p.kind === 'stop' && sOk(p.id, 200) && nOk(p.lat) && nOk(p.lon)));
const epClean = p => (p.kind === 'me' ? { kind: 'me', label: 'La mia posizione' }
  : p.kind === 'point' ? { kind: 'point', label: p.label, lat: +(+p.lat).toFixed(4), lon: +(+p.lon).toFixed(4) }
  : p.kind === 'zone' ? { kind: 'zone', key: p.key, label: p.label, src: p.src, lat: p.lat, lon: p.lon }
  : { kind: 'stop', id: p.id, label: p.label, src: p.src, lat: p.lat, lon: p.lon });
export const epKey = p => (p.kind === 'zone' ? 'zone:' + p.key : p.kind === 'stop' ? 'stop:' + p.id : p.kind === 'me' ? 'me' : `pt:${(+p.lat).toFixed(4)},${(+p.lon).toFixed(4)}`);
export const routeKey = (from, to) => epKey(from) + '>' + epKey(to);
let routes = loadR();
function loadR() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY_R) || 'null');
    if (d && d.v === 1 && Array.isArray(d.items)) return d.items.filter(x => x && epOk(x.from) && epOk(x.to)).slice(0, 30).map(x => { const from = epClean(x.from), to = epClean(x.to); return { k: routeKey(from, to), from, to, at: Number(x.at) || 0 }; });
  } catch { /* niente */ }
  return [];
}
function saveR() { try { localStorage.setItem(KEY_R, JSON.stringify({ v: 1, items: routes })); return true; } catch { return false; } }
export const allRoutes = () => routes.slice();
export const hasRoute = (from, to) => !!from && !!to && routes.some(x => x.k === routeKey(from, to));
// -> true (salvato) | false (tolto) | null (memoria non disponibile)
export function toggleRoute(from, to) {
  const k = routeKey(from, to), i = routes.findIndex(x => x.k === k);
  if (i >= 0) { routes.splice(i, 1); saveR(); return false; }
  routes.unshift({ k, from: epClean(from), to: epClean(to), at: Date.now() }); routes = routes.slice(0, 30);
  const ok = saveR();
  try { navigator.storage?.persist?.(); } catch { /* facoltativo */ }
  return ok ? true : null;
}
export const routeByKey = k => routes.find(x => x.k === k) || null;
window.addEventListener('storage', ev => { if (ev.key === KEY_R) routes = loadR(); });
