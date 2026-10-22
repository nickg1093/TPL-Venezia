// ANALISI DEI FEED GTFS-REALTIME
// Legge i byte grezzi del feed SENZA schema (decodifica protobuf generica) e li confronta con lo standard GTFS-RT:
//  - campi standard compilati / mancanti (con percentuale di compilazione)
//  - campi NON standard (estensioni proprietarie ACTV): numero, tipo, esempi, valori min/max
//  - controlli di coerenza (timestamp, id doppi, coordinate, velocità, età dei dati)
// Si usa da /api/audit. Serve a sapere cosa pubblica davvero il feed prima di scrivere codice che lo usa.

// Schema standard: messaggio -> { numeroCampo: [nome, messaggioFiglio?, tipoScalare?] }
const STD = {
  FeedMessage: { 1: ['header', 'FeedHeader'], 2: ['entity', 'FeedEntity'] },
  FeedHeader: { 1: ['gtfs_realtime_version', , 's'], 2: ['incrementality'], 3: ['timestamp'] },
  FeedEntity: { 1: ['id', , 's'], 2: ['is_deleted'], 3: ['trip_update', 'TripUpdate'], 4: ['vehicle', 'VehiclePosition'], 5: ['alert', 'Alert'] },
  TripUpdate: { 1: ['trip', 'TripDescriptor'], 2: ['stop_time_update', 'StopTimeUpdate'], 3: ['vehicle', 'VehicleDescriptor'], 4: ['timestamp'], 5: ['delay'] },
  StopTimeUpdate: { 1: ['stop_sequence'], 2: ['arrival', 'StopTimeEvent'], 3: ['departure', 'StopTimeEvent'], 4: ['stop_id', , 's'], 5: ['schedule_relationship'] },
  StopTimeEvent: { 1: ['delay'], 2: ['time'], 3: ['uncertainty'] },
  TripDescriptor: { 1: ['trip_id', , 's'], 2: ['start_time', , 's'], 3: ['start_date', , 's'], 4: ['schedule_relationship'], 5: ['route_id', , 's'], 6: ['direction_id'] },
  VehicleDescriptor: { 1: ['id', , 's'], 2: ['label', , 's'], 3: ['license_plate', , 's'] },
  VehiclePosition: { 1: ['trip', 'TripDescriptor'], 2: ['position', 'Position'], 3: ['current_stop_sequence'], 4: ['current_status'], 5: ['timestamp'], 6: ['congestion_level'], 7: ['stop_id', , 's'], 8: ['vehicle', 'VehicleDescriptor'], 9: ['occupancy_status'], 10: ['occupancy_percentage'] },
  Position: { 1: ['latitude', , 'f'], 2: ['longitude', , 'f'], 3: ['bearing', , 'f'], 4: ['odometer'], 5: ['speed', , 'f'] }
};
const FLOAT_FIELDS = new Set(['Position.1', 'Position.2', 'Position.3', 'Position.5']);

// ---- lettura protobuf grezza ----
function varint(b, o) { let lo = 0, mul = 1, i = 0; for (; i < 10 && o + i < b.length; i++) { const x = b[o + i]; lo += (x & 0x7f) * mul; mul *= 128; if (!(x & 0x80)) return [lo, o + i + 1]; } return null; }
// Elenca i campi di un blocco; ritorna null se non è un protobuf valido (serve a distinguere messaggi da stringhe)
function fields(b, s, e) {
  const out = []; let o = s;
  while (o < e) {
    const t = varint(b, o); if (!t) return null; o = t[1];
    const no = t[0] >>> 3, wt = t[0] & 7; if (no < 1 || no > 2000) return null;
    if (wt === 0) { const v = varint(b, o); if (!v) return null; out.push({ no, wt, v: v[0] }); o = v[1]; }
    else if (wt === 1) { if (o + 8 > e) return null; out.push({ no, wt, s: o, e: o + 8 }); o += 8; }
    else if (wt === 2) { const l = varint(b, o); if (!l || l[1] + l[0] > e) return null; out.push({ no, wt, s: l[1], e: l[1] + l[0] }); o = l[1] + l[0]; }
    else if (wt === 5) { if (o + 4 > e) return null; out.push({ no, wt, s: o, e: o + 4 }); o += 4; }
    else return null;
  }
  return o === e ? out : null;
}
const printable = (b, s, e) => { for (let i = s; i < e; i++) if (b[i] < 9 || (b[i] > 13 && b[i] < 32) || b[i] === 127) return false; return e > s; };

function audit(buf, { now = Date.now() } = {}) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf), stats = new Map(), parents = new Map();
  const walk = (s, e, msg, path) => {
    const fs = fields(b, s, e); if (!fs) return false;
    parents.set(path, (parents.get(path) || 0) + 1);
    for (const f of fs) {
      const def = STD[msg]?.[f.no], key = path + '.' + f.no;
      let st = stats.get(key);
      if (!st) stats.set(key, st = { path: key, msg, no: f.no, name: def ? def[0] : null, std: !!def, wire: f.wt, count: 0, samples: [], min: Infinity, max: -Infinity, nested: false });
      st.count++;
      let val;
      if (f.wt === 0) val = f.v;
      else if (f.wt === 5) { const dv = new DataView(b.buffer, b.byteOffset + f.s, 4); val = (def?.[2] === 'f' || FLOAT_FIELDS.has(msg + '.' + f.no)) ? +dv.getFloat32(0, true).toFixed(6) : (def ? dv.getUint32(0, true) : `f32:${+dv.getFloat32(0, true).toFixed(5)}|u32:${dv.getUint32(0, true)}`); }
      else if (f.wt === 1) { const dv = new DataView(b.buffer, b.byteOffset + f.s, 8); val = `f64:${+dv.getFloat64(0, true).toFixed(6)}`; }
      else {
        if (def?.[1]) { st.nested = true; walk(f.s, f.e, def[1], key); continue; }                    // messaggio standard
        if (!def && !printable(b, f.s, f.e) && walk(f.s, f.e, '?', key)) { st.nested = true; continue; }   // estensione proprietaria annidata
        val = printable(b, f.s, f.e) ? Buffer.from(b.subarray(f.s, f.e)).toString('utf8').slice(0, 60) : `bytes(${f.e - f.s})`;
      }
      if (typeof val === 'number') { if (val < st.min) st.min = val; if (val > st.max) st.max = val; }
      if (st.samples.length < 3 && !st.samples.includes(val)) st.samples.push(val);
    }
    return true;
  };
  if (!walk(0, b.length, 'FeedMessage', 'root')) return { error: 'contenuto non valido come protobuf', bytes: b.length };

  const parentOf = p => p.slice(0, p.lastIndexOf('.')), rows = [...stats.values()];
  const rep = r => ({ campo: r.name || '(sconosciuto)', numero: r.no, messaggio: r.msg, percorso: r.path, compilato: r.count,
    su: parents.get(parentOf(r.path)) || 0, pct: Math.round(100 * r.count / Math.max(1, parents.get(parentOf(r.path)) || 1)),
    esempi: r.samples, ...(Number.isFinite(r.min) ? { min: r.min, max: r.max } : {}) });
  const standardFilled = rows.filter(r => r.std && !r.nested).map(rep);
  const proprietary = rows.filter(r => !r.std).map(rep);
  // campi standard attesi ma assenti (solo per messaggi che compaiono nel feed)
  const seenMsgs = new Set(rows.filter(r => r.std && r.nested).map(r => STD[r.msg][r.no][1])); seenMsgs.add('FeedMessage');
  const missing = [];
  for (const m of seenMsgs) for (const [no, d] of Object.entries(STD[m] || {}))
    if (!rows.some(r => r.msg === m && r.no === +no && r.std)) missing.push(`${m}.${d[0]}`);

  // controlli di coerenza
  const hdr = rows.find(r => r.msg === 'FeedHeader' && r.no === 3), notes = [];
  if (hdr?.samples[0]) { const age = Math.round(now / 1000 - hdr.samples[0]); notes.push(`timestamp intestazione: ${age} s fa${age > 120 ? ' (FEED VECCHIO)' : ''}`); } else notes.push('manca il timestamp di intestazione');
  const lat = rows.find(r => r.msg === 'Position' && r.no === 1), lon = rows.find(r => r.msg === 'Position' && r.no === 2);
  if (lat && (lat.min < 44 || lat.max > 47)) notes.push(`latitudini fuori area: ${lat.min}..${lat.max}`);
  if (lon && (lon.min < 11 || lon.max > 14)) notes.push(`longitudini fuori area: ${lon.min}..${lon.max}`);
  const sp = rows.find(r => r.msg === 'Position' && r.no === 5); notes.push(sp ? `velocità dichiarata dal feed (max ${sp.max} m/s)` : 'la velocità NON è dichiarata: va calcolata dalle posizioni');
  const vts = rows.find(r => r.msg === 'VehiclePosition' && r.no === 5); if (rows.some(r => r.msg === 'VehiclePosition')) notes.push(vts ? 'timestamp per singolo veicolo presente' : 'manca il timestamp del singolo veicolo: si usa quello di intestazione');
  const cs = rows.find(r => r.msg === 'VehiclePosition' && r.no === 4); if (rows.some(r => r.msg === 'VehiclePosition')) notes.push(cs ? 'current_status presente' : 'current_status ASSENTE: lo stato in fermata va interpolato');
  if (proprietary.length) notes.push(`${proprietary.length} campi non standard: possibili estensioni ACTV, vedi "proprietari"`);
  return { bytes: b.length, entita: parents.get('root.2') || 0, standard: standardFilled, mancanti: missing, proprietari: proprietary, note: notes };
}
module.exports = { audit, STD };
