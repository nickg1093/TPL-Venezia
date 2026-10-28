// GEOMETRIA CONDIVISA. Unico posto in cui vivono le costanti e le funzioni di distanza (prima erano copiate in 4 file).
// A Venezia (≈45,4°N) un grado di latitudine vale ~111 km e uno di longitudine ~78 km: approssimazione piana,
// più che sufficiente per le distanze in gioco (da pochi metri a qualche km).
const M_LAT = 111000, M_LON = 78000;

// distanza in metri fra due punti
const dist = (aLat, aLon, bLat, bLon) => Math.hypot((aLat - bLat) * M_LAT, (aLon - bLon) * M_LON);

// vero se i due punti distano al massimo `m` metri (con uscita rapida: evita la radice quadrata nei cicli su migliaia di fermate)
function isNear(aLat, aLon, bLat, bLon, m) {
  const dy = Math.abs(aLat - bLat) * M_LAT; if (dy > m) return false;
  const dx = Math.abs(aLon - bLon) * M_LON; if (dx > m) return false;
  return dx * dx + dy * dy <= m * m;
}

// riquadro entro cui ha senso una posizione (laguna, litorale ed entroterra serviti da ACTV): scarta zeri, scambi lat/lon, valori corrotti
const inArea = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= 44.6 && lat <= 46.2 && lon >= 11.3 && lon <= 13.6;

module.exports = { M_LAT, M_LON, dist, isNear, inArea };
