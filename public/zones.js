// ZONE DI FERMATE. Una "zona" raggruppa i pali dello stesso luogo (es. Piazzale Roma A, B, C...) per mostrarli in un unico pannello con le lettere.
//
// Come si costruisce (buildZones), per ogni servizio separatamente:
//  1. NOME BASE: dal nome si toglie "A RICHIESTA" e la lettera/corsia finale (virgolette "A", CORSIA 3, o sigla tipo "C12"); il nome si normalizza
//     (minuscole, f.te -> fondamente, p.le -> piazzale, S. -> san) e si applicano gli ALIAS (nomi diversi dello stesso luogo).
//  2. DISTANZA: pali con lo stesso nome base si uniscono in un gruppo se almeno uno dista <= ZONE_M (300 m) da un altro del gruppo
//     (catena: A vicino a B e B vicino a C = un solo gruppo).
//  3. ETICHETTE: se i pali hanno lettere nel nome si usano quelle; altrimenti, se stanno in punti diversi, si numerano 1, 2, 3... per posizione.
//  4. SCARTO: il gruppo è una zona solo se ha almeno 2 etichette diverse; altrimenti i pali restano fermate singole.
export const ZONE_M = 300;
export const ALIAS = { 'favretti mestre fs': 'stazione mestre fs' };
// "NOME "A"" | "NOME CORSIA 3" | "NOME C12"  ->  [tutto, nome, lettera tra virgolette, corsia, sigla]
export const LETTER = /^(.*?)\s*(?:"([^"]+)"|\bCORSIA\s+([A-Z0-9]+)|\s([A-Z]\d{1,2}))\s*$/i;

export const norm = s => s.toLowerCase().replace(/"/g, '').replace(/f\.te\b/g, 'fondamente').replace(/p\.le\b/g, 'piazzale').replace(/\bs\.\s*/g, 'san ').replace(/\s+/g, ' ').trim();
const nice = n => n === n.toUpperCase() && /[A-Z]/.test(n) ? n.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : n;
const meters = (a, b) => Math.hypot((a.lat - b.lat) * 111000, (a.lon - b.lon) * 78000);

// ETICHETTE FISSE (corsie e pontili che nel GTFS non hanno la lettera nel nome). Chiave: servizio|nome base normalizzato.
// labels: id fermata completo -> etichetta. Valgono solo se almeno due codici dell'elenco sono presenti nel gruppo; altrimenti si usa la numerazione per posizione.
//  · Venezia (Piazzale Roma, autobus): corsie ricavate abbinando le linee che servono ogni palo al cartello delle corsie di Piazzale Roma (A1-A8, B1-B5, B7, C).
//  · Tronchetto Mercato (navigazione): A verso S. Zaccaria (via Giudecca), B verso S. Marco (via Canal Grande).
export const FIXED = {
  'aut|venezia': { title: 'Piazzale Roma (Venezia)', labels: { 'aut:506': 'A1', 'aut:507': 'A2', 'aut:508': 'A3', 'aut:509': 'A4', 'aut:510': 'A5', 'aut:511': 'A6', 'aut:512': 'A7', 'aut:501': 'A8',
    'aut:514': 'B1', 'aut:505': 'B2', 'aut:516': 'B3', 'aut:515': 'B4', 'aut:517': 'B5', 'aut:503': 'B7', 'aut:6084': 'C' } },
  'nav|tronchetto mercato': { title: 'Tronchetto Mercato', labels: { 'nav:5075': 'A', 'nav:5210': 'B' } }
};

export const unitOf = z => z.src === 'nav' ? ['Pontile', 'pontili'] : ['Fermata', 'fermate'];

export const zones = new Map();     // chiave zona -> zona
export const zoneOf = new Map();    // id fermata -> zona
export const snorm = new Map();     // id fermata -> nome normalizzato (per la ricerca)

// stops: [[id, nome, lat, lon, servizio], ...]
export function buildZones(stops) {
  const byName = new Map(); snorm.clear(); zones.clear(); zoneOf.clear();
  for (const [id, name, lat, lon, src] of stops) {
    snorm.set(id, norm(name));
    const strip = x => x.replace(/\s+A RICHIEST\w*\s*$/i, '').trim(), m = LETTER.exec(name), base = strip(m ? m[1] : name), n = norm(base), key = src + '|' + (ALIAS[n] || n);
    let l = byName.get(key); if (!l) byName.set(key, l = []);
    l.push({ id, name: base, full: strip(name), src, letter: m ? (m[2] || m[3] || m[4]).toUpperCase() : '', lat, lon });
  }
  const cmp = (a, b) => (!a) - (!b) || a.localeCompare(b, 'it', { numeric: true });
  // assegna l'etichetta a ogni palo del gruppo: lettera del nome (codes) oppure numero di posizione
  const assign = (c, codes) => {
    const pk = i => i.lat.toFixed(5) + ',' + i.lon.toFixed(5), places = new Map();
    for (const i of c) if (!(codes && i.letter) && !places.has(pk(i))) places.set(pk(i), String(places.size + 1));
    for (const i of c) i.label = (codes && i.letter) || (places.size >= 2 ? places.get(pk(i)) : '');
    return [...new Set(c.map(i => i.label))].sort(cmp);
  };
  for (const [key, items] of byName) {
    const cl = [];
    for (const it of items) {                                   // raggruppamento per distanza (a catena)
      let cur = [it];
      for (let k = cl.length - 1; k >= 0; k--) if (cl[k].some(o => meters(o, it) <= ZONE_M)) cur = cur.concat(cl.splice(k, 1)[0]);
      cl.push(cur);
    }
    for (const c of cl) {
      if (c.length < 2) continue;
      c.sort((a, b) => a.id.localeCompare(b.id, 'it', { numeric: true }));
      const fx = FIXED[key], fxHit = fx ? c.filter(i => fx.labels[i.id]).length : 0;
      let letters, name = c[0].name;
      if (fxHit >= 2) {                                         // etichette fisse (vedi FIXED)
        for (const i of c) i.label = fx.labels[i.id] || i.letter || '';
        letters = [...new Set(c.map(i => i.label).filter(Boolean))].sort(cmp); name = fx.title || name;
      } else {
        letters = assign(c, true);
        if (letters.length < 2) { letters = assign(c, false); name = c[0].full; }
      }
      if (letters.length < 2) continue;
      const z = { key: c[0].id, name: nice(name), src: c[0].src, items: c, pick: '*', letters,
        letterOf: new Map(c.map(i => [i.id, i.label])),
        center: [c.reduce((s, i) => s + i.lat, 0) / c.length, c.reduce((s, i) => s + i.lon, 0) / c.length] };
      z.norm = norm(z.name);
      zones.set(z.key, z); for (const i of c) zoneOf.set(i.id, z);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// DOPPIONI: lo stesso palo con più codici (ordinario + "A RICHIESTA", codici 15xxx...) deve comparire UNA volta in mappa e in ricerca.
// Si uniscono i pali dello stesso servizio con lo stesso nome completo (lettera compresa) a meno di MERGE_M metri l'uno dall'altro.
// Il pannello della fermata unita mostra i passaggi di tutti i codici (ogni corsa punta comunque al suo codice, con l'indicazione "a richiesta").
// Pali distinti anche se vicini (es. S. Marco-San Zaccaria "B", a 20 m da un altro) restano separati.
export const MERGE_M = 5;
export const groups = new Map();     // id principale -> tutti i codici del palo (almeno 2)
export const aliasOf = new Map();    // id secondario -> id principale
const isReq = n => /\sA RICHIEST\w*\s*$/i.test(n);
export function mergeDuplicates(stops) {
  groups.clear(); aliasOf.clear();
  const by = new Map();
  for (const s of stops) { const k = s[4] + '|' + norm(s[1].replace(/\s+A RICHIEST\w*\s*$/i, '')); (by.get(k) || by.set(k, []).get(k)).push(s); }
  const drop = new Set();
  for (const list of by.values()) {
    if (list.length < 2) continue;
    const cl = [];
    for (const s of list) {
      let cur = [s];
      for (let k = cl.length - 1; k >= 0; k--) if (cl[k].some(o => meters({ lat: o[2], lon: o[3] }, { lat: s[2], lon: s[3] }) <= MERGE_M)) cur = cur.concat(cl.splice(k, 1)[0]);
      cl.push(cur);
    }
    for (const c of cl) {
      if (c.length < 2) continue;
      c.sort((a, b) => isReq(a[1]) - isReq(b[1]) || a[0].localeCompare(b[0], 'it', { numeric: true }));     // principale: ordinaria, codice più basso
      groups.set(c[0][0], c.map(x => x[0]));
      for (const o of c.slice(1)) { aliasOf.set(o[0], c[0][0]); drop.add(o[0]); }
    }
  }
  return stops.filter(s => !drop.has(s[0]));
}
