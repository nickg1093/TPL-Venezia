// ORARI DELLA CENTRALE ACTV (oraritemporeale.actv.it): confronto continuo con i nostri dati e correzione delle corse senza mezzo.
//
// Perché: debug del 1° novembre 2026 (4.422 passaggi confrontati con la centrale alla stessa palina e nello stesso minuto). Il feed GTFS-RT
// non pubblica i turni e non sposta il ritardo sulla corsa successiva: corse "da orario" 5-13 minuti prima del vero passaggio, partenze che
// non avvengono a quell'ora (partenze fasulle), mezzi "in ritardo di 90 minuti" perché associati a una corsa vecchia.
//
// Moduli:
//   centrale-stato.js    costanti, memoria condivisa, strumenti comuni
//   centrale-lettura.js  lettura delle pagine ACTV (limiti, pause dopo errori, controllo continuo in sottofondo)
//   centrale-abbina.js   righe ACTV -> corse del GTFS statico di una fermata; controllo per turni.js; confronto continuo (diagnosi)
//   centrale-fonde.js    correzione del pannello fermata e del pannello della corsa (solo corse senza nostro mezzo)
//   turni.js             (a parte, usato da live.js) mezzo in ritardo che fa la corsa successiva del turno: vale per mappa e pannelli
//
// Il GTFS statico resta il riferimento (nessuna fermata, corsa o nome nuovo). La centrale è facoltativa: se non risponde o cambia formato,
// il sito funziona con i soli dati del feed. ACTV_CENTRALE=0 la spegne; ACTV_CENTRALE_RPM regola il controllo continuo (letture/minuto).
const { C, st } = require('./centrale-stato');
const lettura = require('./centrale-lettura');
const abbina = require('./centrale-abbina');
const fonde = require('./centrale-fonde');

const ENABLED = process.env.ACTV_CENTRALE !== '0';
const off = (f, dflt) => (ENABLED ? f : dflt);

// ctx: { G(src), state(src), vacated(src), serviceActive(G, service, ymd), version() } — dati del motore tempo reale (live.js)
// background: false nelle prove (niente letture periodiche)
function init(ctx, { background = true } = {}) {
  st.ctx = ctx;
  if (ENABLED && background) lettura.startBackground(() => abbina.compareAll());
}

const status = () => ({
  attivo: ENABLED, indirizzo: lettura.BASE, controlloContinuoLettureMinuto: ENABLED ? C.BG_PER_MIN : 0,
  ...st.stat, pausaFino: st.stat.pausaFino ? new Date(st.stat.pausaFino).toISOString() : null,
  pagineInMemoria: st.pages.size, fermateCatalogo: Object.fromEntries(Object.entries(st.catalog).map(([k, v]) => [k, v.byCode.size])), corseConOrariACTV: st.store.size
});

module.exports = {
  init, status, C, enabled: ENABLED,
  prepareStops: off(lettura.prepareStops, async () => {}),
  prepareTrip: off(fonde.prepareTrip, async () => {}),
  mergeStop: off(fonde.mergeStop, (src, sid, rows) => rows),
  mergeTrip: off(fonde.mergeTrip, (src, tid, d) => d),
  checkTurno: off(abbina.checkTurno, () => null),
  // per le prove
  _t: { st, ...abbina, buildCatalog: lettura.buildCatalog, tick: lettura.tick }
};
