// FERMATE PREFERITE. Restano nel dispositivo (memoria del browser per questo sito): sopravvivono agli aggiornamenti dell'app,
// ai riavvii e alla chiusura; si perdono solo cancellando i dati del sito o usando un altro indirizzo. Al primo preferito si chiede al
// browser di non cancellare la memoria da solo quando lo spazio scarseggia (navigator.storage.persist).
// Formato versionato ("v": 1) per poterlo aggiornare in futuro senza perdere nulla.
const KEY = 'tpl.favorites';
let list = load();
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (d && d.v === 1 && Array.isArray(d.items)) return d.items.filter(x => x && typeof x.k === 'string' && typeof x.name === 'string').slice(0, 100);
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
