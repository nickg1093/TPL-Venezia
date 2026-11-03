// FERMATE SUCCESSIVE di un passaggio (seconda riga del pannello fermata).
//   · nomi di base (senza la lettera del pontile o della corsia: «Rialto "B"» -> «Rialto», «MESTRE CENTRO B3» -> «MESTRE CENTRO»), doppioni di fila uniti;
//   · in fondo si tolgono le fermate con nome uguale o simile alla destinazione (es. «Lido S.M.E.» quando si va a Lido S.M.E. "A");
//   · fermate di fila con lo stesso inizio si raggruppano: «San Marco Manuzio, San Marco Cattaneo» -> ["San Marco", ["Manuzio", "Cattaneo"]].
//     Un inizio generico da solo («Via», «San», «Piazzale»…) non basta;
//   · al massimo MAX nomi (poi «…»): per gli extraurbani l'elenco intero scorrerebbe per un minuto.
// Le corse con le stesse fermate condividono lo stesso elenco: nella risposta ogni passaggio ha solo una chiave (nx) e gli elenchi sono
// scritti una volta sola (nexts). Calcolo in cache per versione del GTFS.
const MAX = 12, CACHE_MAX = 6000;
const GENERIC = new Set(['via', 'viale', 'piazza', 'piazzale', 'corso', 'riva', 'calle', 'campo', 'fondamenta', 'fondamente', 'ponte', 'strada',
  'san', 'santa', 'sant', 'santo', 'santi', 'stazione', 'largo', 'vicolo', 'rotonda', 'incrocio', 'zona', 'ss', 'sr', 'sp']);
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/["“”'‘’`]/g, ' ')
  .replace(/\bs\.\s*/g, 'san ').replace(/\bp\.le\b/g, 'piazzale').replace(/\bf\.te\b/g, 'fondamente').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// nome di base: senza lettera tra virgolette in fondo («"A"») né codice di corsia («B3», «A»)
const cleanName = s => String(s || '').slice(0, 120).replace(/\s*["“”'‘’][A-Za-z0-9]{1,2}["“”'‘’]\s*$/, '').replace(/\s+[A-Z][0-9]{0,2}$/, '').trim();
function similar(a, b) {
  const x = norm(a), y = norm(b); if (!x || !y) return false;
  if (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ')) return true;
  const wx = x.split(' '), wy = y.split(' ');
  let k = 0; while (k < wx.length && k < wy.length && wx[k] === wy[k]) k++;
  return k >= 2 || (k === 1 && !GENERIC.has(wx[0]) && wx[0].length >= 4);
}
// names: nomi delle fermate dopo quella del passaggio; dest: destinazione -> { s: [nome | [inizio, [resto…]]], m: true se tagliato }
function build(names, dest) {
  const L = [];
  for (const raw of names) { const n = cleanName(raw); if (n && (!L.length || norm(L[L.length - 1]) !== norm(n))) L.push(n); }
  while (L.length && similar(L[L.length - 1], dest)) L.pop();
  const out = []; let count = 0, more = false;
  for (let i = 0; i < L.length && !more;) {
    const w = L[i].split(' ');
    let best = null;
    for (let p = Math.min(3, w.length - 1); p >= 1 && !best; p--) {
      const pre = w.slice(0, p).join(' '), pn = norm(pre);
      if (!pn || (p === 1 && GENERIC.has(pn))) continue;
      let j = i + 1; while (j < L.length && norm(L[j]).startsWith(pn + ' ')) j++;
      if (j - i >= 2) best = { pre, j, p };
    }
    if (best) {
      const rest = L.slice(i, best.j).map(n => n.split(' ').slice(best.p).join(' ')).filter(Boolean), room = MAX - count;
      if (rest.length > room) { out.push([best.pre, rest.slice(0, Math.max(1, room))]); more = true; break; }
      out.push([best.pre, rest]); count += rest.length; i = best.j;
    } else {
      if (count >= MAX) { more = true; break; }
      out.push(L[i++]); count++;
    }
    if (count >= MAX && i < L.length) more = true;
  }
  return more ? { s: out, m: true } : { s: out };
}

const byG = new WeakMap();   // G -> { ids: WeakMap(array delle fermate -> numero), map: Map(chiave -> elenco) }
// chiave e elenco delle fermate dopo la posizione seq della corsa tid (null per un arrivo al capolinea)
function of(G, tid, seq) {
  const st = G?.stopTimes?.get(tid); if (!st || seq >= st.s.length - 1) return null;
  let c = byG.get(G); if (!c) byG.set(G, c = { ids: new WeakMap(), n: 0, map: new Map() });
  let id = c.ids.get(st.s); if (id == null) c.ids.set(st.s, id = ++c.n);
  const dest = G.trips[tid]?.headsign || G.stops[st.s[st.s.length - 1]] || '', key = `${id}.${seq}.${norm(dest).slice(0, 40)}`;
  let v = c.map.get(key);
  if (!v) {
    if (c.map.size > CACHE_MAX) c.map.clear();
    v = build(st.s.slice(seq + 1).map(s => G.stopBaseNames?.get(s) || G.stops[s] || ''), dest);
    c.map.set(key, v);
  }
  return { key, v };
}
// rows: passaggi (con la versione del GTFS in rows[i]._G, non enumerabile) -> aggiunge nx a ogni passaggio, ritorna { chiave breve -> elenco }
function attach(rows) {
  const nexts = {}, short = new Map();
  for (const x of rows) {
    if (x.arrival || !x._G) continue;
    const r = of(x._G, x.tripId, x.seq); if (!r || !r.v.s.length) continue;
    let k = short.get(r.key); if (!k) { k = 'n' + short.size.toString(36); short.set(r.key, k); nexts[k] = r.v; }
    x.nx = k;
  }
  return nexts;
}

module.exports = { build, of, attach, similar, cleanName, norm, MAX };
