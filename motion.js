// MOVIMENTO DEL MEZZO: velocità dai rilevamenti GPS. (La posizione rispetto alle fermate è in tracker.js.)
const { dist } = require('./geo');


// Velocità (m/s) da due rilevamenti GPS successivi, divisa per la differenza dei loro TIMESTAMP (del veicolo o dell'intestazione
// del feed), non per l'orario in cui li abbiamo scaricati: così polling più o meno frequenti non falsano il valore.
//  - dt <= 0: rilevamento già visto, velocità invariata
//  - v > 35 m/s: salto GPS, ignorato
//  - media esponenziale con costante 6 s: filtra il rumore senza ritardare troppo le ripartenze
// arrMs = istante (orologio del server) in cui è arrivato l'ultimo rilevamento NUOVO: serve a stabilire se i dati sono vecchi.
function updateSpeed(track, key, lat, lon, tsMs, arrMs) {
  const p = track.get(key);
  if (!p) { track.set(key, { lat, lon, t: tsMs, arr: arrMs, speed: null, moved: tsMs }); return null; }
  const dt = (tsMs - p.t) / 1000;
  if (dt <= 0) return p.speed;
  p.arr = arrMs;
  const d = dist(lat, lon, p.lat, p.lon), v = d / dt;
  if (v > 35) { Object.assign(p, { lat, lon, t: tsMs }); return p.speed; }
  p.inst = v;                                       // istantanea: serve a vedere subito una ripartenza
  p.speed = p.speed == null ? v : p.speed + (v - p.speed) * (1 - Math.exp(-dt / 6));   // lisciata: per le stime ETA
  if (d > 8) p.moved = tsMs;                       // oltre il rumore GPS: si è mosso davvero
  Object.assign(p, { lat, lon, t: tsMs });
  return p.speed;
}

// Da quanti secondi il mezzo è fermo (0 se in movimento o sconosciuto).
const instSpeed = (track, key) => track.get(key)?.inst ?? null;
const stillFor = (track, key) => { const p = track.get(key); return p ? Math.max(0, (p.t - p.moved) / 1000) : 0; };   // secondi (di feed) senza spostamenti

module.exports = { updateSpeed, instSpeed, stillFor };
