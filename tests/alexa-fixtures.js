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
  ['aut:2301', 'Mestre FS "C"', 45.4825, 12.2318, 'aut'], ['aut:2302', 'Mestre Via Dante', 45.4900, 12.2400, 'aut'],
  ['aut:6057', 'San Marco Cattaneo', 45.490131, 12.251319, 'aut'], ['aut:6058', 'San Marco Cattaneo', 45.490158, 12.251495, 'aut'], ['aut:3001', 'Monte Celo Favaro', 45.5100, 12.2900, 'aut']
];
const routes = {
  'nav:R1': { name: '1', color: '#F4C20D', src: 'nav' }, 'nav:R2': { name: '2', color: '#E1342A', src: 'nav' }, 'nav:R51': { name: '5.1', color: '#8FD2BF', src: 'nav' },
  'nav:R52': { name: '5.2', color: '#8FD2BF', src: 'nav' }, 'nav:R41': { name: '4.1', color: '#4A90D9', src: 'nav' }, 'nav:RN': { name: 'N', color: '#25408D', src: 'nav' },
  'aut:B6': { name: '6', color: '#00A0A0', src: 'aut' }, 'aut:B6E': { name: '6E', color: '#00A0A0', src: 'aut' }, 'aut:T1': { name: 'T1', color: '#B0003A', src: 'aut' }
};
for (const [k, r] of Object.entries(routes)) r.type = r.src === 'nav' ? 4 : r.name === 'T1' ? 0 : 3;   // route_type GTFS: 4 battello, 0 tram, 3 autobus
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

// GTFS SINTETICO per le prove del motore delle corse dirette (alexa/diretti.js), con le stesse strutture di gtfs.js.
// corse: { nav: [{ id, route: 'R1', service: 'FER', headsign, stops: [['1101', '08:15'], …] }], aut: […] } (orari anche oltre le 24:00)
// servizi: { '20261125': ['FER'], … } · live: { nav: { tripId: { cancelled, skipped: Set } } }
const secsDi = h => { const [a, b] = h.split(':').map(Number); return a * 3600 + b * 60; };
function gtfs(corse, servizi = {}, live = {}) {
  const G = {};
  for (const src of ['nav', 'aut']) {
    const g = { stopIndex: {}, stopTimes: new Map(), trips: {}, routes: {}, stops: {}, stopBaseNames: new Map(), tripIds: [] };
    for (const [id, nome, , , s] of stops) if (s === src) { const sid = id.slice(src.length + 1); g.stops[sid] = nome; g.stopBaseNames.set(sid, nome.replace(/\s+"\w"$/, '')); g.stopIndex[sid] = []; }
    for (const [k, r] of Object.entries(routes)) if (r.src === src) g.routes[k.slice(src.length + 1)] = { name: r.name, color: r.color, type: r.type };
    for (const c of corse[src] || []) {
      g.trips[c.id] = { route: c.route, headsign: c.headsign || null, service: c.service || 'FER' };
      const s = c.stops.map(x => x[0]), a = Int32Array.from(c.stops.map(x => secsDi(x[1]))), d = Int32Array.from(c.stops.map(x => secsDi(x[2] || x[1])));
      g.stopTimes.set(c.id, { s, a, d, start: d[0], end: a[a.length - 1] });
      const n = g.tripIds.push(c.id) - 1;
      s.forEach((sid, i) => (g.stopIndex[sid] ||= []).push(n, i));
    }
    G[src] = g;
  }
  return { G, motore: { G: async src => G[src] || null, serviceActive: (g, svc, ymd) => (servizi[ymd] || []).includes(svc), equivalentStops: (g, s) => [s], live: src => live[src] || null, oggi: () => '20261125' } };
}
// riga di /api/zone con la versione dei GTFS collegata (come nel server: proprietà non enumerabile _G)
const conG = (d, G, seq) => { Object.defineProperty(d, '_G', { value: G, enumerable: false }); d.seq = seq; return d; };

// ambiente simulato: ogni API risponde con la funzione dello scenario (u = URL della richiesta); le altre sono errore 404
// opzioni: gtfs = risultato di gtfs() (motore delle corse dirette); errDiretti = errore da lanciare (es. 409) prima del motore
function ambiente(scen = {}, { adesso = ADESSO, occupato = false, gtfs: gt = null, errDiretti = null } = {}) {
  const chiamate = [];
  const call = async pq => {
    const u = new URL(pq, 'http://x'); chiamate.push(pq);
    const f = scen[u.pathname]; if (!f) { const e = new Error('non trovato'); e.code = 404; throw e; }
    const r = typeof f === 'function' ? await f(u) : f; if (r instanceof Error) throw r; return r;
  };
  const amb = { call, stops: async () => stops, routes: async () => routes, versione: () => 'test', adesso: () => adesso, skillId: SKILL_ID, occupato: () => occupato, chiamate, richiesteDirette: [] };
  amb.diretti = async q => {
    amb.richiesteDirette.push(q);
    const e = typeof errDiretti === 'function' ? errDiretti(q) : errDiretti; if (e) throw e;
    return Dir.cerca(gt ? gt.motore : { G: async () => null }, q);
  };
  return amb;
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
const parlato = r => require('../alexa/parlato').senzaTag(r && r.body && r.body.response && r.body.response.outputSpeech ? r.body.response.outputSpeech.ssml : '');
const Dir = require('../alexa/diretti');
// METEO: /api/meteo prodotto dal vero meteo.js con fonti finte (stessa forma della produzione). Sostituzioni per fonte: { vento: [[id, '76 gradi, 5.5 m/s, 7.6 m/s', minutiFa]], ... }
async function meteo(o = {}, { adesso = ADESSO } = {}) {
  const Mt = require('../meteo');
  const p = n => String(n).padStart(2, '0'), cp = ms => { const d = new Date(ms + 3600e3); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`; };
  const righe = (l, fa = 3) => l.map(([id, valore, m = fa]) => ({ ID_stazione: id, data: cp(adesso - m * 60e3), valore }));
  const d = {
    vento: righe(o.vento || [['1039', '76 gradi, 5.5 m/s, 7.6 m/s'], ['1029', '60 gradi, 3 m/s, 4.5 m/s'], ['1047', '70 gradi, 4.2 m/s, 6 m/s'], ['1049', '50 gradi, 6.5 m/s, 9 m/s']]),
    temparia: righe(o.temparia || [['1026', '9.4'], ['1039', '9.1']]), tempacqua: righe(o.tempacqua || [['1025', '13.2']]),
    umidita: righe(o.umidita || [['1026', '88'], ['1039', '90']]), pressione: righe(o.pressione || [['1026', '1012.3']]),
    veporto: (o.veporto || [['SAN SERVOLO', 12000], ['MARITTIMA', 650], ["SANT'ANDREA", 3500]]).map(([nome, v, m = 2]) => ({ nome, ultimoDato: new Date(adesso - m * 60e3).toISOString(), meterDetails: [{ tipo: 'VISIBILIMETER', visibilita: v }] })),
    metar: o.metar === null ? [] : [{ icaoId: 'LIPZ', obsTime: Math.floor((adesso - (o.metarFa ?? 20) * 60e3) / 1000), rawOb: o.metar || 'METAR LIPZ 250650Z 02009KT 9000 -RA BKN025 09/08 Q1011 NOSIG' }]
  };
  const tok = 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(adesso / 1000) + 3600 })).toString('base64url') + '.x';
  Mt._reset();
  Mt._opz({ adesso: () => adesso, veporto: true, log: () => {}, fetch: async url => {
    if (/\/auth$/.test(url)) return new Response('{}', { headers: { Authorization: 'Bearer ' + tok } });
    const k = /aviationweather/.test(url) ? 'metar' : /veporto/.test(url) ? 'veporto' : /\/(\w+)\.json$/.exec(url)[1];
    return new Response(JSON.stringify(d[k]));
  } });
  for (const f of Mt.FEED) if (!(o.spente || []).includes(f.id)) await Mt.controlla(f);
  return JSON.parse(JSON.stringify(Mt.snapshot()));
}
module.exports = { meteo, gtfs, conG, secsDi, SKILL_ID, stops, routes, ADESSO, MS, partenza, zona, marea, estremo, avviso, mose, soluzione, percorso, ambiente, richiesta, parlato };
