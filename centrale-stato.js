// CENTRALE ACTV — costanti, memoria condivisa e strumenti comuni ai moduli centrale-*.js (vedi centrale.js per il quadro generale).
const C = {
  // lettura
  FRESH_MS: 25000,          // la pagina ACTV si aggiorna ogni 30 s: oltre 25 s si rilegge
  STALE_MS: 120000,         // oltre 2 minuti il dato non si usa più
  WAIT_MS: 1500,            // attesa massima della prima lettura quando un utente apre un pannello (ACTV risponde in ~40 ms)
  TIMEOUT_MS: 4000,
  CATALOG_MS: 6 * 3600e3,   // elenco delle fermate ACTV
  FAIL_MAX: 5, PAUSE_MS: 5 * 60e3,                      // 5 errori di fila: pausa di 5 minuti (niente raffiche verso ACTV)
  MAX_PER_MIN: 240, MAX_PARALLEL: 6, MAX_PAGES_WAIT: 24, // 24 = fermate di una zona (P.le Roma ne ha 15)
  BG_EVERY_MS: 10000,       // controllo continuo in sottofondo
  BG_PER_MIN: Math.max(0, +process.env.ACTV_CENTRALE_RPM || 60),   // letture al minuto del controllo continuo (0 = spento)
  // interpretazione
  REL_BIAS_S: 30,           // i tempi reali ACTV ("N'" e "HH:MM") sono al minuto, per difetto: si contano a metà minuto
  AGREE_S: 75,              // entro 75 s (arrotondamento ACTV al minuto) due tempi coincidono
  SAME_S: 90,               // passaggio ACTV entro 90 s dal tempo di un nostro mezzo: è quel mezzo
  EARLY_MAX_MIN: 3,         // una corsa non passa più di 3 minuti prima dell'orario
  STALE_DELAY_MIN: 40,      // una corsa SENZA mezzo non si aggancia a un passaggio ACTV oltre 40 min dopo l'orario (battello 3 a Ferrovia, +71)
  STRONG_MIN: 3,            // nostro mezzo con ritardo del feed oltre 40 min: il passaggio ACTV è suo solo entro 3 min dal suo tempo
  SKIP_ROW: 25, SKIP_LIVE: 10, SKIP_SCHED: 3,           // costi dell'abbinamento (minuti equivalenti)
  WINDOW_S: 3 * 3600,
  DOUBT_MS: 10 * 60e3       // passaggio ACTV non agganciato entro 10 min da una corsa: quella corsa non si toglie
};

const st = {
  ctx: null,                // { G(src), state(src), vehicles(src), vacated(src), serviceActive(G, sid, ymd), version() } da server.js
  pages: new Map(),         // `${src}|${pagina}` -> { t, rows, p, err }
  catalog: {},              // src -> { t, byCode: Map(codice -> { page, codes, lines }), p }
  store: new Map(),         // `${src}:${corsa}` -> orari ACTV noti della corsa (pannello del mezzo)
  memo: new Map(),          // `${src}|${fermata}` -> ultimo abbinamento
  wants: new Map(),         // `${src}|${fermata}` -> ultima richiesta di controllo (turni.js): priorità nel controllo continuo
  stat: { letture: 0, errori: 0, timeout: 0, ultimoErrore: null, pausaFino: 0, erroriDiFila: 0,
    righe: 0, programmateAbbinate: 0, realiAbbinate: 0, righeNonAbbinate: 0, partenzeTolte: 0, tempiSostituiti: 0, turnoContro: 0,
    confronto: { mezzi: 0, entro75s: 0, entro3min: 0, oltre3min: 0, senzaPassaggio: 0, casi: [] } }
};

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/a\s*richiesta\w*/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const lineOf = s => String(s || '').replace(/_[A-Z]{2}$/i, '').trim().toUpperCase();     // "T1_UM" -> "T1", "4.2_UN" -> "4.2"
const fresh = e => !!(e && e.rows && Date.now() - e.t < C.STALE_MS);
const SRC = new Set(['aut', 'nav']);
const pad = n => String(n).padStart(2, '0');
const addMin = (hhmm, m) => { const [h, mi] = hhmm.split(':').map(Number); const t = ((h * 60 + mi + m) % 1440 + 1440) % 1440; return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };
// minuti di ritardo: a metà minuto (tempo ACTV contato a metà del suo minuto) si arrotonda verso lo zero, come mostra ACTV; 2,4 s di tolleranza
const minutes = s => { const v = s / 60; return Math.sign(v) * Math.round(Math.abs(v) - 0.04) || 0; };

module.exports = { C, st, norm, lineOf, fresh, SRC, addMin, minutes };
