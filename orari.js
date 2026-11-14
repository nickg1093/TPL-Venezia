// ORARI DI UN'ALTRA DATA (modalità «Programmato», percorso in un altro giorno).
// Servono le corse del giorno prima, del giorno scelto e del successivo, dalla versione dei GTFS valida in quella data (gtfsstore.choose).
// Si leggono dallo ZIP in archivio, a pezzi e solo per quei giorni (gtfs.loadVersion): pochi MB di memoria.
const gtfs = require('./gtfs');
async function perData(id, pick, date) {
  return gtfs.loadVersion(id, pick, date);
}
module.exports = { perData };
