'use strict';
// METEO a voce: legge /api/meteo (cache del server, nessuna richiesta esterna) e risponde alla grandezza chiesta, per una stazione o con una
// sintesi rappresentativa. Regole: solo misure fresche (Centro Maree e vePORTO entro 25 min, METAR entro 100 min); una misura vecchia si
// dice con la sua ora; l'assenza di dati non diventa «tutto normale»; l'aeroporto (METAR) non è la laguna; la direzione è di provenienza,
// detta per esteso; la raffica è il massimo dell'intervallo di misura, non un record.
const P = require('./parlato');

const FONTE = 'Centro Maree del Comune di Venezia, vePORTO e METAR dell\'aeroporto Marco Polo';
// stazioni dette -> nomi nella cache (/api/meteo); «laguna» e «Venezia» = sintesi
const STAZIONI = {
  san_servolo: { nome: 'San Servolo', sensori: ['San Servolo'] },
  marittima: { nome: 'Marittima', sensori: ['Marittima'] },
  santandrea: { nome: "Sant'Andrea", sensori: ["Sant'Andrea"] },
  san_giorgio: { nome: 'San Giorgio', sensori: ['San Giorgio'] },
  misericordia: { nome: 'Misericordia', sensori: ['Misericordia'] },
  palazzo_cavalli: { nome: 'Palazzo Cavalli', sensori: ['Palazzo Cavalli'] },
  punta_salute: { nome: 'Punta della Salute', sensori: ['Punta della Salute'] },
  piattaforma: { nome: 'la piattaforma Acqua Alta', sensori: ['Piattaforma Acqua Alta'] },
  aeroporto: { nome: "l'aeroporto Marco Polo", sensori: ['Aeroporto Marco Polo'] }
};
// testo libero (es. dallo slot FERMATA di «e a Marittima?») -> chiave della stazione
const SINONIMI = [[/servolo/, 'san_servolo'], [/marittima|porto passeggeri/, 'marittima'], [/andrea/, 'santandrea'], [/giorgio/, 'san_giorgio'], [/misericordia|cannaregio/, 'misericordia'],
  [/cavalli|rialto|centro storico/, 'palazzo_cavalli'], [/salute|dogana/, 'punta_salute'], [/piattaforma/, 'piattaforma'], [/aeroporto|marco polo|tessera|lipz/, 'aeroporto']];
// grandezza detta a parole (se Alexa non risolve lo slot)
const GRANDEZZE = [[/raffic/, 'raffica'], [/direzion|da dove|provien/, 'direzione'], [/nebbia|foschia/, 'nebbia'], [/visibil|si vede/, 'visibilita'], [/vento|ventoso|tira/, 'vento'],
  [/acqua|mare/, 'tempacqua'], [/umid/, 'umidita'], [/pression|barometr/, 'pressione'], [/temperatur|gradi|caldo|freddo/, 'temparia'], [/recent|ultimo dato/, 'recente'], [/tempo|meteo|condizion/, 'meteo']];
function grandezzaDaTesto(t) { const n = norm(t); const g = GRANDEZZE.find(([re]) => re.test(n)); return g ? g[1] : null; }
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, ' ');
function stazioneDaTesto(t) { const n = norm(t); if (/laguna|venezia|fuori|citta/.test(n) && !SINONIMI.some(([re]) => re.test(n))) return 'laguna'; const s = SINONIMI.find(([re]) => re.test(n)); return s ? s[1] : null; }

// ---- numeri parlati ----
const intero = x => P.parole(Math.round(x));
// «del» / «dell'» davanti al numero detto (dell'ottantotto, dell'undici)
const delNum = n => { const t = intero(n); return /^[aeiouò]/.test(t) ? `dell'${t}` : `del ${t}`; };
const kmh = x => (Math.round(x) === 1 ? 'un chilometro orario' : `${intero(x)} chilometri orari`);
const gradi = x => { const r = Math.round(x); return `${r === 1 ? 'un grado' : r === -1 ? 'meno un grado' : intero(r) + ' gradi'}`; };
function distanza(v, limite) {
  const t = v < 1000 ? `${intero(Math.round(v / 10) * 10)} metri` : v < 10000 && v % 1000 ? `${intero(Math.round(v / 100) * 100)} metri` : `${intero(v / 1000)} ${Math.round(v / 1000) === 1 ? 'chilometro' : 'chilometri'}`;
  return limite === 'almeno' ? `oltre ${t}` : limite === 'meno di' ? `meno di ${t}` : t;
}
const delle = iso => { const d = new Date(iso); return P.delleOra(new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)); };
const hhmm = iso => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
function anzianita(x) {
  const m = Math.round((x.etaS || 0) / 60);
  if (m < 90) return P.minutiParlati(m);
  if (m < 48 * 60) { const h = Math.floor(m / 60), mezza = m % 60 >= 30 && h < 6; return `${h === 1 ? "un'ora" : intero(h) + ' ore'}${mezza ? ' e mezza' : ''}`; }
  return `${intero(m / 1440)} giorni`;
}
const dove = x => (x.stazione === 'Aeroporto Marco Polo' ? "all'aeroporto Marco Polo" : x.stazione === 'Piattaforma Acqua Alta' ? 'alla piattaforma Acqua Alta' : `a ${x.stazione}`);
// classi di visibilità (definizioni meteorologiche: nebbia sotto 1 km, foschia/visibilità ridotta fino a 5 km)
const classeVis = v => (v < 200 ? 'nebbia fitta' : v < 1000 ? 'nebbia' : v < 5000 ? 'ridotta' : 'buona');

async function leggi(C) {
  const j = await C.call('/api/meteo');
  if (!j || !j.misure) { const e = new Error('meteo non disponibile'); e.code = 503; throw e; }
  return j.misure;
}
const fresche = l => (l || []).filter(x => x.disponibile);
const perStazione = (l, k) => (l || []).filter(x => STAZIONI[k].sensori.includes(x.stazione));
// frase per una misura vecchia (mai spacciata per attuale)
const vecchia = (cosa, x) => `L'ultima misura ${cosa} ${dove(x)} è ${delle(x.misurato)}, di ${anzianita(x)} fa: non è aggiornata.`;

// ---- frasi per categoria ----
function fraseVento(x, { soloRaffica = false, soloDirezione = false } = {}) {
  if (x.calmo) return `${P.maiuscola(dove(x))} c'è calma di vento${x.raffica >= 5 ? `, con raffiche fino a ${kmh(x.raffica)}` : ''}.`;
  const da = x.variabile ? 'vento variabile' : x.direzione ? `il vento soffia da ${x.direzione.cardinale}` : 'il vento, di direzione non disponibile,';
  if (soloDirezione) return `${P.maiuscola(dove(x))} ${x.variabile ? 'il vento è variabile' : x.direzione ? `il vento soffia da ${x.direzione.cardinale}` : 'la direzione del vento non è disponibile'}.`;
  if (soloRaffica) return x.raffica != null ? `${P.maiuscola(dove(x))} le raffiche arrivano a ${kmh(x.raffica)}, con vento medio a ${kmh(x.velocita)}.`
    : x.fonte === 'METAR LIPZ' ? `${P.maiuscola(dove(x))} non sono segnalate raffiche: vento a ${kmh(x.velocita)}.` : `${P.maiuscola(dove(x))} non ho il dato delle raffiche: vento medio a ${kmh(x.velocita)}.`;
  const variaz = x.variazione && x.variazione.da && x.variazione.a ? `, con direzione tra ${x.variazione.da.cardinale} e ${x.variazione.a.cardinale}` : '';
  return `${P.maiuscola(dove(x))} ${da} a ${kmh(x.velocita)}${x.raffica != null ? `, con raffiche fino a ${intero(x.raffica)}` : ''}${variaz}.`;
}
function fraseVis(x) { return `${P.maiuscola(dove(x))} la visibilità è di ${distanza(x.valore, x.limite)}${classeVis(x.valore) === 'nebbia' || classeVis(x.valore) === 'nebbia fitta' ? `: c'è ${classeVis(x.valore)}` : classeVis(x.valore) === 'ridotta' ? ', quindi ridotta' : ''}.`; }
const FRASI = {
  temparia: x => `${P.maiuscola(dove(x))} ci sono ${gradi(x.valore)}.`.replace(/ci sono un grado/, "c'è un grado"),
  tempacqua: x => `L'acqua ${x.stazione === 'Punta della Salute' ? 'della laguna a Punta della Salute' : dove(x)} è a ${gradi(x.valore)}.`,
  umidita: x => `${P.maiuscola(dove(x))} l'umidità è ${delNum(x.valore)} per cento${x.derivato ? ', calcolata da temperatura e punto di rugiada' : ''}.`,
  pressione: x => `${P.maiuscola(dove(x))} la pressione è di ${intero(x.valore)} ettopascal${x.tipo === 'QNH' ? ', riportata al livello del mare' : ''}.`,
  visibilita: fraseVis, vento: x => fraseVento(x)
};
const NOMI_CAT = { temparia: 'della temperatura', tempacqua: "della temperatura dell'acqua", umidita: "dell'umidità", pressione: 'della pressione', visibilita: 'della visibilità', vento: 'del vento' };
const valoreDi = (cat, x) => (cat === 'vento' ? x.velocita : x.valore);
// stazioni preferite per la sintesi generica di ciascuna grandezza (prima la città, poi la laguna; l'aeroporto solo in mancanza, detto come tale)
const ORDINE = { temparia: ['Palazzo Cavalli', 'San Giorgio', 'Piattaforma Acqua Alta', 'Aeroporto Marco Polo'], umidita: ['Palazzo Cavalli', 'San Giorgio', 'Aeroporto Marco Polo'],
  pressione: ['Palazzo Cavalli', 'Aeroporto Marco Polo'], tempacqua: ['Punta della Salute'] };

// misura di una grandezza in una stazione detta
function inStazione(m, cat, k) {
  const tutte = perStazione(m[cat], k);
  const x = tutte.find(z => z.disponibile && valoreDi(cat, z) != null);
  if (x) return { voce: FRASI[cat](x), righe: [x] };
  const v = tutte.filter(z => valoreDi(cat, z) != null).sort((a, b) => (b.misurato || '').localeCompare(a.misurato || ''))[0];
  if (v) return { voce: vecchia(NOMI_CAT[cat], v), righe: [v] };
  return { voce: `Non ho misure ${NOMI_CAT[cat]} a ${STAZIONI[k].nome.replace(/^l'/, '')}: quella stazione non la rileva o il dato non è disponibile.`.replace(/a la /, 'alla ').replace(/a aeroporto/, "all'aeroporto"), righe: [], vuoto: true };
}
function generica(m, cat) {
  const ok = fresche(m[cat]).filter(x => valoreDi(cat, x) != null);
  if (!ok.length) return { voce: `Non ho misure recenti ${NOMI_CAT[cat]} in questo momento.`, righe: [], vuoto: true };
  const ordine = ORDINE[cat];
  if (ordine) { const x = ordine.map(n => ok.find(z => z.stazione === n)).find(Boolean) || ok[0]; return { voce: FRASI[cat](x).replace(/^A Palazzo Cavalli/, 'A Venezia, a Palazzo Cavalli,'), righe: [x] }; }
  return null;
}
// visibilità generica: i visibilimetri della laguna; senza di loro, l'aeroporto detto come tale
function visibilitaGenerica(m) {
  const lag = fresche(m.visibilita).filter(x => x.fonte === 'vePORTO' && x.valore != null);
  if (!lag.length) {
    const a = fresche(m.visibilita).find(x => x.fonte === 'METAR LIPZ' && x.valore != null);
    return a ? { voce: `Non ho misure recenti dei visibilimetri in laguna. ${fraseVis(a)}`, righe: [a] } : { voce: 'Non ho misure recenti della visibilità in questo momento.', righe: [], vuoto: true };
  }
  const nebbia = lag.filter(x => x.valore < 1000), ridotta = lag.filter(x => x.valore >= 1000 && x.valore < 5000);
  const el = l => P.elenco(l.map(x => `${dove(x)} ${distanza(x.valore, x.limite)}`));
  let v;
  if (nebbia.length) { const altre = lag.filter(x => !nebbia.includes(x)); v = `C'è nebbia ${P.elenco(nebbia.map(x => `${dove(x)}, con ${distanza(x.valore, x.limite)} di visibilità`))}.${altre.length ? ` ${P.maiuscola(el(altre))}.` : ''}`; }
  else if (ridotta.length) v = `In laguna la visibilità è ridotta: ${el(lag)}.`;
  else v = `In laguna la visibilità è buona: ${el(lag)}.`;
  return { voce: v, righe: lag };
}
// vento generico: direzione prevalente, intervallo delle medie e raffica massima tra le stazioni del Centro Maree (misure confrontabili)
function ventoGenerico(m, { soloRaffica = false, soloDirezione = false } = {}) {
  let ok = fresche(m.vento).filter(x => x.velocita != null && x.fonte === 'Centro Maree');
  if (!ok.length) { const a = fresche(m.vento).find(x => x.velocita != null); return a ? { voce: `Non ho misure recenti del vento in laguna. ${fraseVento(a, { soloRaffica, soloDirezione })}`, righe: [a] } : { voce: 'Non ho misure recenti del vento in questo momento.', righe: [], vuoto: true }; }
  ok = comparabili(ok);
  if (ok.length === 1) return { voce: fraseVento(ok[0], { soloRaffica, soloDirezione }), righe: ok };
  const dirs = ok.filter(x => !x.calmo && x.direzione).map(x => x.direzione.cardinale);
  const prev = dirs.sort((a, b) => dirs.filter(d => d === b).length - dirs.filter(d => d === a).length)[0];
  const tutteUguali = dirs.length && dirs.every(d => d === prev);
  const vel = ok.map(x => x.velocita), min = Math.min(...vel), max = Math.max(...vel);
  const rf = ok.filter(x => x.raffica != null).sort((a, b) => b.raffica - a.raffica)[0];
  const eccezioni = ok.filter(x => x.direzione && x.direzione.cardinale !== prev);
  if (soloDirezione) return { voce: !dirs.length ? 'In laguna c\'è calma di vento.' : tutteUguali ? `In laguna il vento soffia da ${prev}.` : `In laguna il vento soffia soprattutto da ${prev}; ${P.elenco(eccezioni.map(x => `${dove(x)} da ${x.direzione.cardinale}`))}.`, righe: ok };
  if (soloRaffica) return { voce: rf ? `Le raffiche più forti arrivano a ${kmh(rf.raffica)} ${dove(rf)}.` : 'Non ho dati recenti sulle raffiche.', righe: ok };
  if (max < 1) return { voce: 'In laguna c\'è calma di vento.', righe: ok };
  const dirTxt = prev ? `Vento ${tutteUguali ? '' : 'prevalente '}da ${prev}` : 'Vento';
  const velTxt = Math.round(min) === Math.round(max) ? `a ${kmh(max)}` : `tra ${intero(min)} e ${kmh(max)}`;
  return { voce: `${dirTxt}, ${velTxt} nelle stazioni della laguna${rf ? `; raffiche fino a ${intero(rf.raffica)} ${dove(rf)}` : ''}.`, righe: ok };
}
// misure confrontabili: entro 15 minuti dalla più recente
function comparabili(l) { const t = Math.max(...l.map(x => Date.parse(x.misurato))); return l.filter(x => t - Date.parse(x.misurato) <= 15 * 60e3); }
function confronto(m, cat = 'vento') {
  if (cat === 'temparia' || cat === 'freddo' || cat === 'caldo') {
    const ok = comparabili(fresche(m.temparia).filter(x => x.valore != null && x.fonte === 'Centro Maree'));
    if (ok.length < 2) return { voce: 'Non ho abbastanza misure recenti di temperatura per un confronto.', righe: ok, vuoto: true };
    const s = [...ok].sort((a, b) => a.valore - b.valore), x = cat === 'caldo' ? s[s.length - 1] : s[0];
    return { voce: `Fa più ${cat === 'caldo' ? 'caldo' : 'freddo'} ${dove(x)}: ${gradi(x.valore)}.`, righe: s };
  }
  if (cat === 'visibilita' || cat === 'nebbia') {
    const ok = comparabili(fresche(m.visibilita).filter(x => x.valore != null && x.fonte === 'vePORTO'));
    if (!ok.length) return { voce: 'Non ho misure recenti dei visibilimetri in laguna.', righe: [], vuoto: true };
    const x = [...ok].sort((a, b) => a.valore - b.valore)[0];
    return { voce: `La visibilità più bassa è ${dove(x)}: ${distanza(x.valore, x.limite)}.`, righe: ok };
  }
  const ok = comparabili(fresche(m.vento).filter(x => x.velocita != null && x.fonte === 'Centro Maree'));
  if (ok.length < 2) return ok.length ? { voce: `Ho una sola misura recente. ${fraseVento(ok[0])}`, righe: ok } : { voce: 'Non ho misure recenti del vento in laguna.', righe: [], vuoto: true };
  const s = [...ok].sort((a, b) => b.velocita - a.velocita || (b.raffica || 0) - (a.raffica || 0)), x = s[0];
  if (cat === 'raffica') { const r = ok.filter(z => z.raffica != null).sort((a, b) => b.raffica - a.raffica)[0]; if (r) return { voce: `Le raffiche più forti sono ${dove(r)}: fino a ${kmh(r.raffica)}.`, righe: s }; }
  return { voce: `Il vento soffia più forte ${dove(x)}: ${kmh(x.velocita)}${x.raffica != null ? `, raffiche fino a ${intero(x.raffica)}` : ''}. Segue ${s[1].stazione} con ${intero(s[1].velocita)}.`, righe: s };
}
// METAR completo dell'aeroporto
function aeroporto(m) {
  const met = (m.metar || [])[0];
  if (!met) return { voce: "Non ho l'ultima osservazione dell'aeroporto Marco Polo.", righe: [], vuoto: true };
  const p = [], trova = c => (m[c] || []).find(x => x.stazione === 'Aeroporto Marco Polo');
  if (met.fenomeni && met.fenomeni.length) p.push(P.elenco(met.fenomeni.map(f => f.testo)));
  else if (met.cavok) p.push('cielo e visibilità buoni');
  const vi = trova('visibilita'); if (vi && vi.valore != null) p.push(`visibilità ${distanza(vi.valore, vi.limite)}`);
  const ve = trova('vento'); if (ve && ve.velocita != null) p.push(ve.calmo ? 'calma di vento' : `vento ${ve.variabile ? 'variabile' : ve.direzione ? 'da ' + ve.direzione.cardinale : ''} a ${kmh(ve.velocita)}${ve.raffica != null ? `, raffiche a ${intero(ve.raffica)}` : ''}`.replace(/ {2}/g, ' '));
  const t = trova('temparia'); if (t && t.valore != null) p.push(gradi(t.valore));
  const u = trova('umidita'); if (u && u.valore != null) p.push(`umidità ${delNum(u.valore)} per cento`);
  const pr = trova('pressione'); if (pr && pr.valore != null) p.push(`pressione ${intero(pr.valore)} ettopascal`);
  const intro = met.fresco ? `All'aeroporto Marco Polo, osservazione ${delle(met.misurato)}` : `L'ultima osservazione dell'aeroporto Marco Polo è ${delle(met.misurato)}, di ${anzianita(met)} fa, e non è aggiornata`;
  return { voce: `${intro}: ${p.join('; ')}.`, righe: [vi, ve, t].filter(Boolean) };
}
// condizioni generali: temperatura, vento, visibilità in laguna in tre frasi brevi; fenomeni dell'aeroporto se ci sono
function condizioni(m) {
  const parti = [], righe = [];
  const t = generica(m, 'temparia'); if (!t.vuoto) { parti.push(t.voce); righe.push(...t.righe); }
  const v = ventoGenerico(m); if (!v.vuoto) { parti.push(v.voce); righe.push(...v.righe.slice(0, 2)); }
  const vi = visibilitaGenerica(m); if (!vi.vuoto) { parti.push(vi.voce); righe.push(...vi.righe.slice(0, 1)); }
  const met = (m.metar || [])[0];
  if (met && met.fresco && met.fenomeni && met.fenomeni.length) parti.push(`All'aeroporto: ${P.elenco(met.fenomeni.map(f => f.testo))}.`);
  if (!parti.length) return { voce: 'Non ho misure meteo recenti in questo momento.', righe: [], vuoto: true };
  return { voce: parti.join(' '), righe };
}
// il dato più recente fra tutti i sensori
function recente(m) {
  const tutte = Object.entries(m).filter(([c]) => FRASI[c]).flatMap(([c, l]) => l.filter(x => x.disponibile && valoreDi(c, x) != null).map(x => ({ c, x })));
  if (!tutte.length) return { voce: 'Non ho misure meteo recenti in questo momento.', righe: [], vuoto: true };
  const { c, x } = tutte.sort((a, b) => b.x.misurato.localeCompare(a.x.misurato))[0];
  return { voce: `Il dato più recente è ${delle(x.misurato)}. ${FRASI[c](x)}`, righe: [x] };
}

// ric: { grandezza, stazione, confronto }
async function meteo(C, ric = {}) {
  const m = await leggi(C);
  const g0 = ric.grandezza || 'meteo', g = !ric.confronto && (g0 === 'caldo' || g0 === 'freddo') ? 'temparia' : g0, k = ric.stazione && ric.stazione !== 'laguna' ? ric.stazione : null;
  let r;
  if (ric.confronto) r = confronto(m, g === 'meteo' ? 'vento' : g === 'direzione' ? 'vento' : g);
  else if (g === 'recente') r = recente(m);
  else if (k === 'aeroporto' && (g === 'meteo' || g === 'condizioni')) r = aeroporto(m);
  else if (g === 'meteo' || g === 'condizioni') r = k ? stazioneTutto(m, k) : condizioni(m);
  else if (g === 'nebbia') r = nebbia(m, k);
  else if (g === 'vento' || g === 'raffica' || g === 'direzione') {
    const o = { soloRaffica: g === 'raffica', soloDirezione: g === 'direzione' };
    if (k) { const x = perStazione(m.vento, k).find(z => z.disponibile && z.velocita != null); r = x ? { voce: fraseVento(x, o), righe: [x] } : inStazione(m, 'vento', k); }
    else r = ventoGenerico(m, o);
  } else if (g === 'visibilita') r = k ? inStazione(m, 'visibilita', k) : visibilitaGenerica(m);
  else if (FRASI[g]) r = k ? inStazione(m, g, k) : generica(m, g);
  else r = condizioni(m);
  const righe = (r.righe || []).filter(Boolean).slice(0, 4).map(riga);
  return { voce: P.esc(r.voce), scheda: { titolo: 'Meteo', sottotitolo: k ? STAZIONI[k].nome.replace(/^l'/, '').replace(/^la /, '') : 'Venezia e laguna', righe, nota: 'Misure delle stazioni, non previsioni.', fonte: FONTE },
    ctx: { tipo: 'meteo', grandezza: g, stazione: ric.stazione || null }, fine: false, vuoto: !!r.vuoto };
}
// tutte le grandezze misurate in una stazione
function stazioneTutto(m, k) {
  if (k === 'aeroporto') return aeroporto(m);
  const p = [], righe = [];
  for (const c of ['visibilita', 'vento', 'temparia', 'tempacqua', 'umidita', 'pressione']) {
    const x = perStazione(m[c], k).find(z => z.disponibile && valoreDi(c, z) != null);
    if (x) { p.push(FRASI[c](x)); righe.push(x); }
  }
  if (!p.length) return { voce: `Non ho misure recenti a ${STAZIONI[k].nome}.`, righe: [], vuoto: true };
  return { voce: p.join(' '), righe };
}
function nebbia(m, k) {
  if (!k) { const g = visibilitaGenerica(m); if (g.vuoto) return g; return { ...g, voce: /^C'è nebbia/.test(g.voce) ? `Sì. ${g.voce}` : g.voce.replace(/^In laguna/, 'No, in laguna non c\'è nebbia. La visibilità') .replace(/La visibilità la visibilità/, 'La visibilità') }; }
  const x = perStazione(m.visibilita, k).find(z => z.disponibile && z.valore != null);
  if (!x) return inStazione(m, 'visibilita', k);
  const cl = classeVis(x.valore);
  return { voce: cl === 'nebbia' || cl === 'nebbia fitta' ? `Sì, ${dove(x)} c'è ${cl}: visibilità ${distanza(x.valore, x.limite)}.` : `No, ${dove(x)} non c'è nebbia: la visibilità è di ${distanza(x.valore, x.limite)}${cl === 'ridotta' ? ', comunque ridotta' : ''}.`, righe: [x] };
}
function riga(x) {
  const val = x.categoria === 'vento' ? (x.calmo ? 'calmo' : `${Math.round(x.velocita)} km/h`) : x.categoria === 'visibilita' ? (x.valore >= 1000 ? `${x.limite === 'almeno' ? '≥' : ''}${Math.round(x.valore / 100) / 10} km` : `${x.limite === 'meno di' ? '<' : ''}${x.valore} m`)
    : `${Math.round(x.valore)}${x.unita === '%' ? '%' : x.unita === 'hPa' ? ' hPa' : '°C'}`;
  const dett = x.categoria === 'vento' ? [x.direzione ? 'da ' + x.direzione.cardinale : x.variabile ? 'variabile' : '', x.raffica != null ? `raffiche ${Math.round(x.raffica)} km/h` : ''].filter(Boolean).join(' · ') : x.fonte;
  return { badge: val, colore: x.categoria === 'visibilita' && x.valore < 1000 ? '#C0392B' : '#2E5E8C', testo: x.stazione, dett, ora: x.misurato ? hhmm(x.misurato) : '', attesa: '', stato: x.fresco ? 'live' : 'prog' };
}
// per il riepilogo: solo condizioni rilevanti (nebbia, visibilità molto ridotta, vento forte); altrimenti null
async function notevole(C) {
  let m; try { m = await leggi(C); } catch { return null; }
  const p = [];
  const neb = fresche(m.visibilita).filter(x => x.valore != null && x.valore < 1000 && x.fonte === 'vePORTO');
  if (neb.length) p.push(`nebbia ${P.elenco(neb.map(x => `${dove(x)}, ${distanza(x.valore, x.limite)}`))}`);
  const rf = comparabili(fresche(m.vento).filter(x => x.raffica != null && x.fonte === 'Centro Maree').concat()).filter(x => x.raffica >= 50).sort((a, b) => b.raffica - a.raffica)[0];
  const forte = rf || fresche(m.vento).filter(x => x.velocita != null && x.velocita >= 35 && x.fonte === 'Centro Maree').sort((a, b) => b.velocita - a.velocita)[0];
  if (forte) p.push(`vento forte, ${rf ? `raffiche fino a ${kmh(rf.raffica)}` : kmh(forte.velocita)} ${dove(forte)}`);
  return p.length ? { voce: P.esc(`Meteo: ${p.join('; ')}.`), riga: riga(neb[0] || forte) } : null;
}
module.exports = { meteo, notevole, stazioneDaTesto, grandezzaDaTesto, STAZIONI, distanza };
