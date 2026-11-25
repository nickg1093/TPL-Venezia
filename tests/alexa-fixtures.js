// FIXTURE PER LE PROVE DELLA SKILL ALEXA: una piccola rete di fermate/linee inventata (nomi veri di Venezia, id finti), costruttori delle risposte
// delle API del server (stessa forma di /api/zone, /api/tide, /api/avvisi, /api/mose, /api/percorso) e richieste Alexa simulate.
// Nessuna rete, nessun orario del giorno: ogni prova fissa «adesso» e stabilisce i dati, così i risultati sono riproducibili.
const SKILL_ID = 'amzn1.ask.skill.test-venezia-tpl';
const stops = [
  ['nav:1001', 'Zattere "A"', 45.4287, 12.3256, 'nav'], ['nav:1002', 'Zattere "B"', 45.4288, 12.3262, 'nav'],
  ['nav:1101', 'Rialto "C"', 45.4382, 12.3358, 'nav'], ['nav:1102', 'Rialto "D"', 45.4384, 12.3362, 'nav'],
  ['nav:1201', 'P.le Roma "F"', 45.4386, 12.3190, 'nav'], ['aut:2201', 'Piazzale Roma', 45.4390, 12.3178, 'aut'], ['aut:2202', 'Piazzale Roma', 45.4392, 12.3181, 'aut'],
  ['nav:1301', 'S. Marco-San Zaccaria "F"', 45.4333, 12.3438, 'nav'], ['nav:1302', 'S. Marco Vallaresso "A"', 45.4331, 12.3393, 'nav'],
  ['nav:1401', 'Murano Colonna "A"', 45.4586, 12.3534, 'nav'], ['nav:1402', 'Murano Faro "B"', 45.4631, 12.3571, 'nav'], ['nav:1403', 'Murano Museo "A"', 45.4570, 12.3520, 'nav'],
  ['nav:1501', 'Lido S.M.E. "B"', 45.4064, 12.3636, 'nav'], ['nav:1601', 'Ferrovia "D"', 45.4410, 12.3208, 'nav'],
  ['aut:2301', 'Mestre FS "C"', 45.4825, 12.2318, 'aut'], ['aut:2302', 'Mestre Via Dante', 45.4900, 12.2400, 'aut']
];
const routes = {
  'nav:R1': { name: '1', color: '#F4C20D', src: 'nav' }, 'nav:R2': { name: '2', color: '#E1342A', src: 'nav' }, 'nav:R51': { name: '5.1', color: '#8FD2BF', src: 'nav' },
  'nav:R52': { name: '5.2', color: '#8FD2BF', src: 'nav' }, 'nav:R41': { name: '4.1', color: '#4A90D9', src: 'nav' }, 'nav:RN': { name: 'N', color: '#25408D', src: 'nav' },
  'aut:B6': { name: '6', color: '#00A0A0', src: 'aut' }, 'aut:B6E': { name: '6E', color: '#00A0A0', src: 'aut' }, 'aut:T1': { name: 'T1', color: '#B0003A', src: 'aut' }
};
// ora fissa: mercoledì 25 novembre 2026, 08:10 a Venezia (UTC+1)
const MS = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const ADESSO = MS(2026, 11, 25, 7, 10);

// una partenza come la dà /api/zone
function partenza(o) {
  const stop = o.stop || 'nav:1002', sched = o.schedIn ?? 3, delay = o.delay ?? 0, live = o.live ?? true;
  const expIn = o.expIn ?? (live ? sched + delay : sched), hhmm = min => { const t = new Date(ADESSO + min * 60000); return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t); };
  return { tripId: o.tripId || `T${Math.round(Math.random() * 1e6)}`, line: o.line || '5.1', color: o.color || '#8FD2BF', headsign: o.headsign || 'Lido S.M.E. "B"', sched: hhmm(sched), arrival: !!o.arrival, exp: hhmm(expIn), schedIn: sched, schedSec: sched * 60, expIn, delay: live ? delay : null, live, stale: o.stale || null, atStop: !!o.atStop, done: !!o.done, cancel: o.cancel || null, src: stop.split(':')[0], stop, nx: 'n0', ...(o.extra || {}) };
}
const zona = (deps, extra = {}) => ({ liveUpdated: ADESSO - 30e3, note: null, departures: deps, nexts: { n0: { s: ['Giardini Biennale', 'Lido S.M.E.'] } }, ...extra });
// marea: livello misurato e curva prevista come /api/tide (extremes: [{type, cm, ts}])
function marea({ cm = 62, trend = 'steady', ageMin = 3, extremes = [], mose = null, stale = false } = {}) {
  return { station: 'Punta Salute Canal Grande', cm, ts: ADESSO - ageMin * 60e3, ageMin, stale, category: { key: 'normale' }, trend: trend ? { dir: trend === 'up' ? 'up' : trend === 'down' ? 'down' : 'flat', rate: 3 } : null,
    next: extremes.filter(e => e.ts > ADESSO).slice(0, 4), history: [], chart: { now: ADESSO, observed: [], forecast: [], extremes }, source: { name: 'CPSM' }, mose };
}
const estremo = (tipo, cm, ore) => ({ type: tipo, cm, ts: ADESSO + ore * 3600e3 });
const avviso = (o) => ({ title: 'Avviso', text: '', state: 'active', from: ADESSO - 3600e3, to: ADESSO + 5 * 3600e3, open: false, dated: true, lines: [], stops: [], stopNames: [], effect: 'delays', effectLabel: 'Ritardi', severity: 'warning', published: ADESSO - 3600e3, ...o });
const mose = (stato, extra = {}) => ({ stato, sem: stato === 'recesso' ? 'verde' : 'rosso', titolo: stato === 'recesso' ? 'MOSE non attivo: paratoie in recesso' : 'MOSE attivo: tutte le barriere sollevate', barriere: [{ bocca: 'Lido', barriera: 'Lido Nord', stato, sem: stato === 'recesso' ? 'verde' : 'rosso', testo: 'x' }], evento: null, aggiornato: ADESSO - 5 * 60e3, letto: ADESSO - 60e3, stale: false, ...extra });
// una soluzione del pianificatore (forma di /api/percorso)
function soluzione(o = {}) {
  const mezzo = { tipo: 'mezzo', src: 'nav', route: 'nav:R2', mode: 'nav', line: '2', color: '#E1342A', headsign: 'S. Marco-San Zaccaria "F"', da: { id: 'nav:1002', name: 'Zattere "B"', exp: '08:14', sched: '08:12', delay: 2, live: true }, a: { id: 'nav:1302', name: 'S. Marco Vallaresso "A"', exp: '08:31', sched: '08:29', delay: 2, live: true }, fermate: 5 };
  return { parti: '08:12', arrivi: '08:33', partiMs: ADESSO + 2 * 60e3, minuti: 21, cambi: 0, piedi: 3, rischio: false, aRischio: 0, famiglia: 'f1', rotte: ['nav:R2'], tratte: [{ tipo: 'piedi', min: 1, a: { id: 'nav:1002', name: 'Zattere "B"' }, estremo: 'partenza' }, mezzo, { tipo: 'piedi', min: 2, da: { id: 'nav:1302', name: 'S. Marco Vallaresso "A"' }, estremo: 'arrivo' }], poi: [{ parti: '08:27', arrivi: '08:48' }], etichetta: 'Consigliata', ...o };
}
const percorso = (sols, extra = {}) => ({ aggiornato: ADESSO, live: true, ora: '08:10', data: '20261125', entro: null, piedi: null, senzaFermate: null, preferenza: 'equilibrata', soluzioni: sols, ...extra });

// ambiente simulato: ogni API risponde con la funzione dello scenario (u = URL della richiesta); le altre sono errore 404
function ambiente(scen = {}, { adesso = ADESSO, occupato = false } = {}) {
  const chiamate = [];
  const call = async pq => {
    const u = new URL(pq, 'http://x'); chiamate.push(pq);
    const f = scen[u.pathname]; if (!f) { const e = new Error('non trovato'); e.code = 404; throw e; }
    const r = typeof f === 'function' ? await f(u) : f; if (r instanceof Error) throw r; return r;
  };
  return { call, stops: async () => stops, routes: async () => routes, versione: () => 'test', adesso: () => adesso, skillId: SKILL_ID, occupato: () => occupato, chiamate };
}
// richiesta Alexa simulata
let n = 0;
function richiesta(intent, slots = {}, { adesso = ADESSO, attributi = {}, schermo = false, viewport = null, tipo = 'IntentRequest', locale = 'it-IT', appId = SKILL_ID, nuova = false, ts = null } = {}) {
  const sl = {}; for (const [k, v] of Object.entries(slots)) sl[k] = typeof v === 'object' ? { name: k, ...v } : { name: k, value: v };
  return {
    version: '1.0', session: { new: nuova, sessionId: 'S' + ++n, attributes: attributi, application: { applicationId: appId }, user: { userId: 'amzn1.ask.account.SEGRETO' } },
    context: { System: { application: { applicationId: appId }, user: { userId: 'amzn1.ask.account.SEGRETO' }, device: { deviceId: 'amzn1.ask.device.SEGRETO', supportedInterfaces: schermo ? { 'Alexa.Presentation.APL': { runtime: { maxVersion: '2024.3' } } } : {} } }, ...(viewport ? { Viewport: viewport } : {}) },
    request: { type: tipo, requestId: 'amzn1.echo-api.request.' + n, timestamp: new Date(ts ?? adesso).toISOString(), locale, ...(tipo === 'IntentRequest' ? { intent: { name: intent, slots: sl } } : {}) }
  };
}
const parlato = r => (r && r.body && r.body.response && r.body.response.outputSpeech ? r.body.response.outputSpeech.ssml : '').replace(/<[^>]+>/g, '').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
module.exports = { SKILL_ID, stops, routes, ADESSO, MS, partenza, zona, marea, estremo, avviso, mose, soluzione, percorso, ambiente, richiesta, parlato };
