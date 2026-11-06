// MOVIMENTO DEL MEZZO: velocità dai rilevamenti GPS. (La posizione rispetto alle fermate è in tracker.js.)
const { dist } = require('./geo');


// Velocità (m/s) da due rilevamenti GPS successivi, divisa per la differenza dei loro TIMESTAMP (del veicolo o dell'intestazione
// del feed), non per l'orario in cui li abbiamo scaricati: così polling più o meno frequenti non falsano il valore.
//  - dt <= 0: rilevamento già visto, velocità invariata
//  - v > 35 m/s: salto GPS, ignorato
//  - media esponenziale con costante 6 s: filtra il rumore senza ritardare troppo le ripartenze
// arrMs = istante (orologio del server) in cui è arrivato l'ultimo rilevamento NUOVO: serve a stabilire se i dati sono vecchi.
// POSIZIONE BLOCCATA (registrazione del 6/11/2026): un GPS vero oscilla di 1-2 m anche da fermo; coordinate IDENTICHE ripetute sono
// normali solo in fermata (il sistema ACTV aggancia il mezzo al punto della fermata, a 0-1 m, anche per 45 minuti). Si tiene quindi
// da quando il mezzo dà le stesse identiche coordinate (same) e se le ha ridate dopo un silenzio di almeno GAP_S (sameAfterGap):
// il battello 191 della 4.2, sparito alle 17:33, è ricomparso alle 18:10 con le coordinate delle 17:30. La decisione (lontano dalle
// fermate) è in live.js, che conosce le fermate.
// fixes: ultima posizione di ogni mezzo, conservata più a lungo della traccia (che si cancella dopo 10 minuti di assenza): serve a
// riconoscere le coordinate ricomparse identiche dopo una lunga assenza.
const GAP_S = 300;
function updateSpeed(track, key, lat, lon, tsMs, arrMs, fixes = null) {
  const p = track.get(key), f = fixes?.get(key);
  if (fixes && (!f || tsMs > f.t)) {
    if (f && f.lat === lat && f.lon === lon) { if ((tsMs - f.t) / 1000 >= GAP_S) f.afterGap = true; f.t = tsMs; }
    else fixes.set(key, { lat, lon, t: tsMs, same: tsMs, afterGap: false });
  }
  if (!p) {
    // mezzo di nuovo visibile: se ricompare con le stesse identiche coordinate di prima, la posizione è bloccata da allora
    const g = f && f.lat === lat && f.lon === lon ? fixes.get(key) : null;
    track.set(key, { lat, lon, t: tsMs, arr: arrMs, speed: null, moved: tsMs, same: g ? g.same : tsMs, sameAfterGap: !!g?.afterGap });
    return null;
  }
  const dt = (tsMs - p.t) / 1000;
  if (dt <= 0) return p.speed;
  if (lat === p.lat && lon === p.lon) { if (dt >= GAP_S) p.sameAfterGap = true; }
  else { p.same = tsMs; p.sameAfterGap = false; }
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

// Coordinate identiche: da quanti secondi (di feed) e se sono ricomparse uguali dopo un silenzio
const sameFor = (track, key) => { const p = track.get(key); return p ? { s: Math.max(0, (p.t - (p.same ?? p.t)) / 1000), afterGap: !!p.sameAfterGap } : { s: 0, afterGap: false }; };

module.exports = { updateSpeed, instSpeed, stillFor, sameFor, GAP_S };
