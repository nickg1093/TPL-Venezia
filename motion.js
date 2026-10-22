// MOVIMENTO DEL MEZZO: velocità istantanea e stato rispetto alle fermate (in sosta / già partito).
// Incrocia tre fonti: posizione GPS, tracciato della linea e orario programmato + ritardo reale.
const M_LAT = 111000, M_LON = 78000;               // metri per grado a ~45°N (Venezia)
const dist = (aLat, aLon, bLat, bLon) => Math.hypot((aLat - bLat) * M_LAT, (aLon - bLon) * M_LON);

const AT_STOP_M = 60;      // entro questa distanza dalla fermata il mezzo può essere "in fermata"
const STILL_MS = 1.2;      // m/s (~4 km/h): sotto questa soglia il mezzo è considerato fermo
const MOVING_MS = 2.0;     // m/s (~7 km/h): sopra questa soglia è chiaramente in marcia
const ORIGIN_M = 250;      // area del capolinea: i bus sostano anche oltre il pallino della fermata
const STILL_SEC = 45;      // fermo da almeno tanti secondi = in sosta (non semplice coda/semaforo)
const PASSED_M = 80;       // oltre questa distanza dalla fermata (e dopo di essa sul tracciato) è già transitato

// Velocità istantanea (m/s) da due campioni consecutivi, lisciata (media esponenziale).
// Evita valori impazziti: campioni troppo vicini nel tempo o salti GPS irrealistici vengono scartati.
function updateSpeed(track, key, lat, lon, now) {
  const p = track.get(key);
  if (!p) { track.set(key, { lat, lon, t: now, speed: null, moved: now }); return null; }
  const dt = (now - p.t) / 1000;
  if (dt < 2) return p.speed;
  const d = dist(lat, lon, p.lat, p.lon), v = d / dt;
  if (v > 30) { Object.assign(p, { lat, lon, t: now }); return p.speed; }   // >108 km/h: salto GPS
  const sp = p.speed == null ? v : p.speed * 0.5 + v * 0.5;
  if (d > 8) p.moved = now;                     // oltre il rumore GPS: il mezzo si è mosso davvero
  Object.assign(p, { lat, lon, t: now, speed: sp });
  return sp;
}

// Da quanti secondi il mezzo è fermo (0 se in movimento o sconosciuto).
const stillFor = (track, key, now) => { const p = track.get(key); return p ? Math.max(0, (now - p.moved) / 1000) : 0; };

// Stato rispetto alle fermate della corsa. Ritorna { cur, atStop }:
//   cur    = indice della prossima fermata non ancora transitata
//   atStop = indice della fermata in cui il mezzo è fermo adesso, oppure -1
// stopLoc(k) -> [lat, lon]; fracBeyond(k) -> frazione 0..1 percorsa dopo la fermata k verso k+1 (dal tracciato)
function locate({ n, cur, veh, stopLoc, fracBeyond, planDep, nowS }) {
  if (!veh || !Number.isFinite(veh.lat)) return { cur, atStop: -1 };
  const sp = Number.isFinite(veh.speed) ? veh.speed : null;
  const dTo = k => { const L = stopLoc(k); return L ? dist(veh.lat, veh.lon, L[0], L[1]) : Infinity; };

  // 1) Il feed può essere in ritardo: se il mezzo è chiaramente oltre la prossima fermata, scala avanti.
  for (let guard = 0; guard < 3 && cur < n - 1; guard++) {
    const beyond = fracBeyond(cur);
    if (beyond != null && beyond > 0.2 && dTo(cur) > PASSED_M && (sp == null || sp > STILL_MS)) cur++; else break;
  }
  // 1b) CAPOLINEA: fermo da >= 45 s entro 250 m dal primo punto = in sosta al capolinea, anche se non è sul pallino.
  //     Vale finché non riparte (velocità > soglia) e anche se il feed è fermo o indietro.
  if (cur <= 1 && (veh.stillS || 0) >= STILL_SEC && dTo(0) <= ORIGIN_M && (sp == null || sp < STILL_MS))
    return { cur: 0, atStop: 0, waiting: planDep(0) - nowS > 0 };
  // 2) Fermo in una fermata? Si guardano l'ultima transitata e la prossima.
  for (const k of [cur, cur - 1]) {
    if (k < 0 || k >= n || dTo(k) > AT_STOP_M) continue;
    const still = sp != null ? sp < STILL_MS : true;            // senza velocità: basta la vicinanza
    const timeLeft = planDep(k) - nowS;                          // >0: la partenza prevista (con ritardo) è futura
    if (still && !(sp != null && sp >= MOVING_MS)) {
      // Capolinea/fermata: finché non parte resta "in fermata". Se l'orario è già passato da molto e non si muove, resta comunque lì.
      return { cur: k, atStop: k, waiting: timeLeft > 0 };
    }
    if (k === cur - 1 && sp != null && sp >= MOVING_MS) return { cur, atStop: -1 };   // appena ripartito: transitata
  }
  return { cur, atStop: -1 };
}
module.exports = { updateSpeed, stillFor, locate, dist };
