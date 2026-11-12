// FLUSSO DEI MEZZI (SSE, /api/stream?d=1): invece di avvisare «dati nuovi» e far riscaricare a ogni telefono l'elenco completo dei mezzi,
// il server manda solo le DIFFERENZE rispetto all'invio precedente, già nello stesso collegamento:
//   · all'apertura: l'elenco completo dei servizi scelti            {"t":"f","v":[mezzi…],"m":{stato}}
//   · a ogni lettura del feed con cambiamenti: solo i campi cambiati  {"t":"d","s":[{id, campi cambiati…, x:[campi tolti]}],"d":[id tolti],"m":{…}}
//   · a ogni lettura senza cambiamenti: solo lo stato               {"t":"m","m":{…}}
// Il collegamento è compresso (gzip con svuotamento a ogni messaggio, finestra piccola): nomi dei campi e valori ripetuti costano quasi nulla.
// Le differenze si calcolano UNA volta per lettura del feed e per servizio, poi si spediscono a tutti i collegati.
// Un telefono che perde il collegamento si ricollega e riceve di nuovo l'elenco completo: nessuno stato da riallineare.
const zlib = require('zlib');

// confronto tra l'ultimo elenco inviato e quello nuovo (per un servizio)
function makeDiffer() {
  let prev = new Map();                                                   // id -> { o: oggetto inviato, j: Map(campo -> JSON) }
  return {
    diff(list) {
      const next = new Map(), set = [];
      for (const v of list) {
        if (!v || typeof v.id !== 'string' || next.has(v.id)) continue;
        const j = new Map(); for (const k in v) j.set(k, JSON.stringify(v[k]));
        next.set(v.id, { o: v, j });
        const old = prev.get(v.id);
        if (!old) { set.push({ ...v, n: 1 }); continue; }                   // n: mezzo nuovo (oggetto intero)
        let d = null;
        for (const [k, s] of j) if (old.j.get(k) !== s) (d || (d = { id: v.id }))[k] = v[k];
        const gone = []; for (const k of old.j.keys()) if (!j.has(k)) gone.push(k);
        if (gone.length) (d || (d = { id: v.id })).x = gone;
        if (d) set.push(d);
      }
      const del = []; for (const id of prev.keys()) if (!next.has(id)) del.push(id);
      prev = next;
      return { set, del };
    },
    all: () => [...prev.values()].map(e => e.o)                            // l'elenco così come l'hanno i collegati
  };
}

// applica un messaggio a una mappa id -> mezzo (stessa logica del telefono; usata nei test)
function apply(map, msg) {
  if (msg.t === 'f') { map.clear(); for (const v of msg.v || []) map.set(v.id, v); return true; }
  if (msg.t !== 'd') return false;
  for (const d of msg.s || []) {
    const { n, x, ...rest } = d;
    if (n || !map.has(d.id)) { map.set(d.id, rest); continue; }
    const o = { ...map.get(d.id), ...rest }; if (x) for (const k of x) delete o[k];
    map.set(d.id, o);
  }
  for (const id of msg.d || []) map.delete(id);
  return true;
}

// un collegamento: compressione facoltativa, scrittura protetta (cliente lento o sparito = chiuso, si ricollegherà)
const MAX_BUFFER = 512 * 1024;
function connection(res, { gzip }) {
  const z = gzip ? zlib.createGzip({ level: 6, windowBits: 13, memLevel: 6, flush: zlib.constants.Z_SYNC_FLUSH }) : null;
  if (z) { z.on('error', () => { try { res.destroy(); } catch { /* già chiusa */ } }); z.pipe(res); }
  let open = true;
  return {
    send(s) {
      if (!open) return false;
      if (res.writableLength > MAX_BUFFER) { this.close(); return false; }
      try { (z || res).write(s); return true; } catch { this.close(); return false; }
    },
    close() { if (!open) return; open = false; try { z ? z.end() : res.end(); } catch { /* già chiusa */ } },
    get open() { return open; }
  };
}
const event = obj => `data: ${JSON.stringify(obj)}\n\n`;

// senza il tratto di linea (flusso con p=0): oggetti nuovi senza «path»; nelle differenze «path» e la sua rimozione si tolgono,
// e le voci rimaste vuote (solo id) si scartano
const noPath = v => { if (!v || v.path === undefined) return v; const { path, ...o } = v; return o; };
function strip(set, on) {
  if (!on) return set;
  const out = [];
  for (const d of set) {
    let o = d.path !== undefined ? noPath(d) : d;
    if (o.x) { const x = o.x.filter(k => k !== 'path'); if (x.length !== o.x.length) { o = { ...o }; if (x.length) o.x = x; else delete o.x; } }
    if (Object.keys(o).length > 1) out.push(o);
  }
  return out;
}

module.exports = { makeDiffer, apply, connection, event, noPath, strip };
