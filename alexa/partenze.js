'use strict';
// PARTENZE, RITARDI, PRIMA E ULTIMA CORSA, LINEE DI UNA FERMATA.
//  · Adesso: /api/zone (stessi dati e stesse regole del pannello della PWA: tempo reale, stime, soppressioni).
//  · Altri orari e date, prima/ultima corsa: ricerca sull'intero GTFS della data (alexa/diretti.js, nel server), mai dedotta dal pannello.
//  · Direzione: la corsa deve passare DOPO la fermata di salita da una fermata del luogo detto (sequenza GTFS), oppure — se il luogo detto
//    non è una fermata nota — da una fermata o un capolinea il cui nome lo contiene. Mai il primo nome simile.
//  · Mezzo: vaporetto, autobus, tram distinti con route_type del GTFS (0 tram, 3 autobus, 4 battello), non solo con il servizio.
const P = require('./parlato');
const L = require('./luoghi');
const T = require('./tempo');
const U = require('./util');
const Dir = require('./diretti');
const cal = require('../calendar');

// ---- mezzo ----
const MEZZI = {
  nav: { src: 'nav', tipi: null, nome: 'vaporetto', plurale: 'vaporetti' },
  bus: { src: 'aut', tipi: [3], nome: 'autobus', plurale: 'autobus' },
  tram: { src: 'aut', tipi: [0], nome: 'tram', plurale: 'tram' },
  aut: { src: 'aut', tipi: null, nome: 'autobus o tram', plurale: 'autobus e tram' }
};
const mezzoInfo = m => MEZZI[m] || null;
// tipo GTFS di una riga del pannello: dalla versione dei GTFS della riga (in processo) o, in mancanza, dall'elenco delle linee
function tipoRiga(C, d) {
  const G = d._G, t = G && G.trips && G.trips[d.tripId], r = t && G.routes[t.route];
  if (r && r.type != null) return r.type;
  const i = L.infoLinea(C.routes, d.line).find(x => x.src === d.src && x.type != null);
  return i ? i.type : (d.src === 'nav' ? 4 : 3);
}
const tipoOk = (mz, tipo, src) => !mz || (src === mz.src && (!mz.tipi || mz.tipi.includes(tipo)));
const nomeMezzoTipo = (tipo, src) => (src === 'nav' || tipo === 4 ? 'vaporetto' : tipo === 0 ? 'tram' : 'autobus');

// ---- fermata esatta (come la PWA: pontile, numero o corsia) ----
function fermataEsatta(C, id) {
  const sp = C.luoghi.stopPerId(id); if (!sp) return { con: '', breve: '' };
  const lab = (C.zone && C.zone.etichetta(id)) || sp.pontile || '';
  if (!lab) return { con: '', breve: '' };
  if (sp.src === 'nav') return { con: `dal pontile ${lab}`, breve: `pontile ${lab}` };
  const z = C.zone && C.zone.zona(id), nome = P.nomeParlato(z ? z.nome : P.dividiPontile(sp.nome).base);
  if (/^\d+$/.test(lab)) return { con: `dalla fermata ${nome} ${lab}`, breve: `fermata ${nome} ${lab}` };
  return { con: `dalla corsia ${lab}`, breve: `corsia ${lab}` };
}

// ---- destinazione/direzione detta: fermate di arrivo verificabili (src -> Set di codici) e testo per i casi non risolti ----
function destinazione(C, testo, gOrig) {
  if (!testo) return null;
  if (typeof testo === 'object' && testo.ids) { const g0 = testo; testo = g0.nome; return conGruppo(g0, testo, gOrig); }
  const r = C.luoghi.cerca(testo);
  return conGruppo(r.ok || null, testo, gOrig);
}
function conGruppo(g, testo, gOrig) {
  const orig = new Set(gOrig ? gOrig.ids : []);
  const sids = new Map();
  if (g) for (const id of g.ids) { if (orig.has(id)) continue; const k = id.indexOf(':'); (sids.get(id.slice(0, k)) || sids.set(id.slice(0, k), new Set()).get(id.slice(0, k))).add(id.slice(k + 1)); }
  return { testo, gruppo: g, sids, nome: g ? g.parlato : P.nomeParlato(testo), ids: g ? g.ids.filter(id => !orig.has(id)) : null };
}
// la riga del pannello va verso la destinazione? Sequenza GTFS della corsa (preferita) oppure capolinea e fermate successive per nome
function vaVerso(d, nexts, dest) {
  if (!dest) return true;
  if (d._G && d.tripId != null && d.seq != null) {
    const set = dest.sids.get(d.src);
    const r = Dir.proseguePer(d._G, d.tripId, d.seq, set, null);
    if (r === true) return true;
    const t = Dir.proseguePer(d._G, d.tripId, d.seq, null, dest.testo);
    if (r === false && !t) return false;
    if (t != null) return t;
  }
  const k = L.normalizza(dest.gruppo ? dest.gruppo.nome : dest.testo), k2 = L.normalizza(dest.testo);
  const alvo = [d.headsign, ...((nexts && nexts[d.nx] && nexts[d.nx].s) || [])].map(x => L.normalizza(P.dividiPontile(x || '').base));
  return alvo.some(x => [k, k2].some(q => q && (x === q || x.split(' ').includes(q) || (q.length > 3 && x.includes(q)))));
}
// avvisi di fermata sospesa o spostata che toccano queste fermate (solo in corso)
async function avvisiFermate(C, ids) {
  try {
    const A = await C.call('/api/avvisi'), set = new Set(ids);
    return (A.items || []).filter(a => a.state === 'active' && ['no_service', 'stop_moved'].includes(a.effect) && (a.stops || []).some(s => set.has(s)) && a.ambito === 'fermate');
  } catch { return []; }
}

// ---- stato di una partenza (regole della PWA: mai «in orario» senza tempo reale) ----
function descriviStato(d) {
  if (d.cancel === 'trip') return { testo: 'corsa soppressa', stato: 'soppressa' };
  if (d.cancel === 'stop') return { testo: 'questa corsa non ferma qui', stato: 'soppressa' };
  if (d.live && d.delay != null) {
    if (d.stale) return { testo: d.stale.min ? `l'ultima previsione risale a ${P.minutiParlati(d.stale.min)} fa` : 'previsione non aggiornata', stato: 'stima' };
    if (d.delay >= 2) return { testo: `con ${P.durata(d.delay)} di ritardo`, stato: 'ritardo' };
    if (d.delay <= -1) return { testo: `in anticipo di ${P.minutiParlati(-d.delay)}`, stato: 'ok' };
    return { testo: 'in orario', stato: 'ok' };
  }
  return { testo: 'da orario programmato', stato: 'prog' };
}
const chiave = d => `${d.src}:${d.tripId}`;

// frase di una partenza: forma completa (una corsa) o breve (elenco)
function frasePartenza(C, d, { completa = true, programmato = false, primo = true, conFermata = true, conDest = true } = {}) {
  const st = programmato ? { testo: '', stato: 'prog' } : descriviStato(d);
  const fe = conFermata ? fermataEsatta(C, d.stop) : { con: '', breve: '' };
  const dest = P.destinazioneParlata(d.headsign || '');
  const ora = !programmato && d.live ? d.exp : d.sched, min = !programmato && d.live ? d.expIn : d.schedIn;
  const tipo = tipoRiga(C, d), sogg = tipo === 0 ? `il tram ${P.lineaParlata(d.line)}` : `la linea ${P.lineaParlata(d.line)}`;
  const riga = { badge: String(d.line), colore: U.colore(d.color), testo: P.senzaTag(dest), dett: [fe.breve ? P.maiuscola(fe.breve) : null, st.testo].filter(Boolean).join(' · '), ora: d.cancel ? '—' : ora, attesa: programmato ? '' : (d.atStop ? 'in fermata' : P.attesa(min).replace('tra ', '')), stato: st.stato };
  let voce;
  if (d.cancel) voce = `${completa ? P.maiuscola(sogg) : sogg}${conDest ? ' per ' + dest : ''} ${P.delleOra(d.sched)} ${d.cancel === 'trip' ? 'è soppressa' : 'non ferma qui'}`;
  else if (completa) {
    if (!programmato && d.atStop) voce = `${P.maiuscola(sogg)} per ${dest} è in fermata${fe.con ? ', ' + fe.con.replace(/^dal(la)? /, 'al$1 ') : ''}`;
    else if (programmato || !d.live || d.delay == null) voce = `${P.maiuscola(sogg)}${conDest ? ' per ' + dest : ''} passa ${P.oraParlata(ora)}${programmato ? '' : ', ' + P.attesa(min)}${fe.con ? ', ' + fe.con : ''}`;
    else voce = `${P.maiuscola(sogg)}${conDest ? ' per ' + dest : ''} passa ${P.attesa(min)}, ${P.oraParlata(ora)}${fe.con ? ', ' + fe.con : ''}`;
    if (!programmato && !d.atStop) {
      if (!d.live || d.delay == null) voce += '. È l\'orario programmato: non ho una previsione aggiornata';
      else if (st.stato === 'ritardo' || st.stato === 'stima' || d.delay <= -1) voce += `, ${st.testo}`;
    }
  } else {
    voce = `${primo ? P.maiuscola(sogg) : sogg}${conDest ? ' per ' + dest : ''} ${programmato ? '' : P.attesa(min) + ', '}${P.oraParlata(ora)}${fe.breve ? ', ' + fe.breve : ''}`;
    if (!programmato && st.stato !== 'ok' && st.stato !== 'prog') voce += `, ${st.testo}`;
  }
  return { voce: voce.replace(/\s+,/g, ',').replace(/\s{2,}/g, ' '), riga };
}

// ---- PARTENZE ----
// ric: { gruppo, linea, mezzo, dir, n, visti, dopoMs, quando, ids? }
async function partenze(C, ric) {
  const g = ric.gruppo, adesso = C.adesso(), mz = mezzoInfo(ric.mezzo);
  const n = Math.max(1, Math.min(ric.n || 1, 6));
  let src = mz ? mz.src : null;
  if (ric.linea && !src) { const s = L.infoLinea(C.routes, ric.linea).map(x => x.src).filter(x => g.srcs.has(x)); if (new Set(s).size === 1) src = s[0]; }
  const ids = ric.ids && ric.ids.length ? ric.ids : C.luoghi.idsDi(g, src);
  if (!ids.length) return { voce: P.esc(`A ${g.parlato} non ci sono fermate ${mz ? 'del ' + mz.nome : 'di questo servizio'}.`), fine: false, ctx: null, vuoto: true };
  const dest = destinazione(C, ric.dir, g);
  const programmato = !!(ric.quando && !ric.quando.adesso);
  if (programmato) return partenzeProgrammate(C, { ...ric, n, ids, dest, mz });
  const Z = await C.call(`/api/zone?ids=${ids.map(encodeURIComponent).join(',')}`);
  const visti = new Set(ric.visti || []), dopo = ric.dopoMs || 0;
  const absMs = d => adesso + (Number.isFinite(d.expSec) ? d.expSec : (d.live ? d.expIn : d.schedIn) * 60) * 1000;
  let lista = (Z.departures || []).filter(d => !d.done && !d.arrival && (d.expIn > -2 || d.schedIn > -2));
  const tutte = lista.length;
  if (ric.linea) lista = lista.filter(d => L.stessaLinea(d.line, ric.linea));
  if (mz) lista = lista.filter(d => tipoOk(mz, tipoRiga(C, d), d.src));
  if (dest) lista = lista.filter(d => vaVerso(d, Z.nexts, dest));
  const esclusa = ric.escludiDir ? destinazione(C, ric.escludiDir, g) : null;
  if (esclusa) lista = lista.filter(d => !vaVerso(d, Z.nexts, esclusa));
  const filtrate = lista.length;
  if (visti.size) lista = lista.filter(d => !visti.has(chiave(d)) && absMs(d) >= dopo - 60000);
  // una corsa soppressa si dice, ma non conta come «la prossima»: si aggiunge la prima successiva utilizzabile
  let mostra = [];
  for (const d of lista) { mostra.push(d); if (mostra.filter(x => !x.cancel).length >= n) break; }
  const nuoviVisti = [...visti, ...mostra.map(chiave)].slice(-12);
  const ctx = { tipo: 'partenze', visti: nuoviVisti, dopoMs: mostra.length ? absMs(mostra[mostra.length - 1]) : dopo, n };
  if (esclusa && mostra[0]) ctx.dirEffettiva = P.destinazioneParlata(mostra[0].headsign || '');   // «nell'altra direzione» diventa una direzione precisa per i seguiti
  const scheda = { titolo: g.parlato, sottotitolo: dest ? `Verso ${P.senzaTag(dest.nome)}` : 'Prossime partenze', righe: [], nota: '', fonte: 'Orari e tempo reale ACTV · servizio indipendente, non ufficiale' };
  const chi = descriviFiltro(ric, mz, dest) + (esclusa ? `${descriviFiltro(ric, mz, dest) ? ' ' : ''}nell'altra direzione` : '');
  if (!mostra.length) {
    let v;
    if (visti.size && filtrate) v = 'Non ci sono altre corse nelle prossime due ore.';
    else v = `Non risultano partenze${chi ? ' ' + chi : ''} da ${g.parlato} nelle prossime due ore.`;
    if (!visti.size && (ric.linea || mz || dest) && tutte) v += ' Da qui passano però altre corse.';
    else if (Z.note) v += ` ${Z.note}.`;
    return { voce: P.esc(v), scheda: { ...scheda, nota: v }, ctx, fine: false, vuoto: true, dati: { totale: 0 } };
  }
  const conDest = true;
  const frasi = mostra.map((d, i) => frasePartenza(C, d, { completa: mostra.length === 1 || (n === 1 && i === 0), primo: i === 0, conDest }));
  scheda.righe = frasi.map(f => f.riga);
  let voce;
  const stessa = mostra.length > 1 && mostra.every(d => d.line === mostra[0].line && d.headsign === mostra[0].headsign && d.stop === mostra[0].stop && !d.cancel);
  const prog = mostra.filter(d => !d.cancel && !(d.live && d.delay != null));
  if (frasi.length === 1) voce = P.esc(visti.size ? 'Poi ' + frasi[0].voce.replace(/^[A-Z]/, c => c.toLowerCase()) : frasi[0].voce) + '.';
  else if (stessa) {
    // stessa linea, destinazione e pontile: si dicono una volta, poi solo gli orari
    const d0 = mostra[0], fe = fermataEsatta(C, d0.stop), tipo = tipoRiga(C, d0);
    const sogg = `${tipo === 0 ? 'Il tram' : 'La linea'} ${P.lineaParlata(d0.line)} per ${P.destinazioneParlata(d0.headsign || '')}${fe.breve ? ', ' + fe.breve : ''}`;
    const ora = d => `${P.oraParlata(d.live ? d.exp : d.sched)}${d.live && d.delay != null && (d.delay >= 2 || d.delay <= -1 || d.stale) ? ' (' + descriviStato(d).testo + ')' : ''}`;
    voce = P.esc(`${visti.size ? 'Poi ' + sogg.replace(/^[A-Z]/, c => c.toLowerCase()) : sogg}: ${P.attesa(mostra[0].live ? mostra[0].expIn : mostra[0].schedIn)}, ${ora(mostra[0])}; poi ${P.elenco(mostra.slice(1).map(ora))}.`).replace(/ \(/g, ', ').replace(/\)/g, '');
  } else voce = frasi.map((f, i) => P.esc(i === 0 ? (visti.size ? 'Poi ' + f.voce.replace(/^[A-Z]/, c => c.toLowerCase()) : P.maiuscola(f.voce)) : (i === frasi.length - 1 ? 'Infine ' : 'Poi ') + f.voce) + '.').join(' ');
  if (mostra.length > 1 && prog.length === mostra.filter(d => !d.cancel).length) voce += ' ' + P.esc('Sono orari programmati: non ho previsioni aggiornate.');
  else if (mostra.length > 1 && prog.length) voce += ' ' + P.esc(`Per ${prog.length === 1 ? 'la corsa' : 'le corse'} ${P.elenco(prog.map(d => P.oraParlata(d.sched).replace(/^alle |^all'|^a /, m => m === "all'" ? "dell'" : m === 'a ' ? 'di ' : 'delle ')))} non ho una previsione aggiornata.`);
  const eta = U.frasEta(Z.liveUpdated, adesso, 5, 'Il tempo reale');
  if (eta && mostra.some(d => d.live)) voce += ' ' + P.esc(eta.replace('risalgono', 'risale'));
  const sospese = await avvisiFermate(C, ids);
  if (sospese.length) voce += ` ${P.pausa(200)}${P.esc(`Attenzione: ${P.frasePulita(sospese[0].title, 110)}. Il mezzo potrebbe non fermarsi.`)}`;
  scheda.nota = [eta, ...sospese.slice(0, 1).map(a => 'Avviso: ' + P.frasePulita(a.title, 120))].filter(Boolean).join(' ');
  return { voce, scheda, ctx, fine: false, dati: { corse: mostra.map(d => ({ id: chiave(d), line: d.line, stop: d.stop, ora: d.live ? d.exp : d.sched, cancel: d.cancel || null })) } };
}
function descriviFiltro(ric, mz, dest) {
  const p = [];
  if (ric.linea) p.push(`della linea ${P.lineaParlata(ric.linea)}`); else if (mz) p.push(`di ${mz.plurale}`);
  if (dest) p.push(`verso ${dest.nome}`);
  return p.join(' ');
}

// orari programmati di un altro momento o giorno: dall'intero GTFS della data
async function partenzeProgrammate(C, ric) {
  const g = ric.gruppo, w = ric.quando, oggi = T.adessoRoma(C.adesso()).ymd;
  const res = await direttiDa(C, { ids: ric.ids, dest: ric.dest, ymd: w.ymd, linea: ric.linea, mz: ric.mz, daSecs: w.secs, aSecs: w.secs + 6 * 3600 });
  const visti = new Set(ric.visti || []);
  const lista = res.righe.filter(r => !visti.has(`${r.src}:${r.tripId}`) && r.dep >= (ric.dopoSecs ?? -1));
  const mostra = lista.slice(0, ric.n);
  const giorno = P.giornoParlato(w.ymd, oggi), dalle = P.dalleOra(T.hhmmDa(w.secs));
  const ctx = { tipo: 'partenze', visti: [...visti, ...mostra.map(r => `${r.src}:${r.tripId}`)].slice(-12), dopoSecs: mostra.length ? mostra[mostra.length - 1].dep : (ric.dopoSecs ?? null), n: ric.n };
  const scheda = { titolo: g.parlato, sottotitolo: `${P.maiuscola(giorno)}, dalle ${T.hhmmDa(w.secs)} · orari programmati`, righe: [], nota: 'Orari programmati: non garantiscono la corsa.', fonte: 'Orari ACTV · servizio indipendente, non ufficiale' };
  if (res.nessunGtfs.length && !res.righe.length) return { voce: P.esc(`Non ho ancora orari validi per ${giorno}.`), scheda, ctx, fine: false, vuoto: true };
  if (!mostra.length) {
    const v = visti.size ? 'Non risultano altre corse in quelle ore.' : `Non risultano partenze${descriviFiltro(ric, ric.mz, ric.dest) ? ' ' + descriviFiltro(ric, ric.mz, ric.dest) : ''} da ${g.parlato} ${giorno} ${dalle}, secondo gli orari disponibili.`;
    return { voce: P.esc(v), scheda: { ...scheda, nota: v }, ctx, fine: false, vuoto: true };
  }
  const testa = visti.size ? 'Poi' : `${P.maiuscola(giorno)}, ${dalle}`;
  const frasi = mostra.map((r, i) => {
    const fe = fermataEsatta(C, r.from), lin = r.type === 0 ? `tram ${P.lineaParlata(r.line)}` : `linea ${P.lineaParlata(r.line)}`;
    const dest = P.destinazioneParlata(r.headsign || '');
    scheda.righe.push({ badge: String(r.line), colore: U.colore(r.color), testo: P.senzaTag(dest), dett: [fe.breve ? P.maiuscola(fe.breve) : null, r.arr != null ? `arrivo ${T.hhmmDa(r.arr)}` : null, r.cancel ? 'soppressa' : null].filter(Boolean).join(' · '), ora: T.hhmmDa(r.dep), attesa: '', stato: r.cancel ? 'soppressa' : 'prog' });
    return `${lin} per ${dest} ${P.oraParlata(T.hhmmDa(r.dep))}${fe.breve ? ', ' + fe.breve : ''}${r.arr != null && ric.dest ? `, arrivo ${P.oraParlata(T.hhmmDa(r.arr))}` : ''}${r.cancel ? ', soppressa' : ''}${notte(r, w.ymd)}`;
  });
  const voce = mostra.length === 1
    ? P.esc(visti.size ? `Poi c'è la ${frasi[0]}.` : `${testa}, la prima corsa è la ${frasi[0]}. È un orario programmato.`)
    : P.esc(`${testa}: ${frasi.join('; poi ')}. Sono orari programmati.`);
  return { voce, scheda, ctx, fine: false };
}
// corse oltre la mezzanotte: si dice il giorno di calendario
const notte = (r, ymd) => (r.dep >= 86400 ? `, nella notte tra ${P.giornoSettimana(ymd)} e ${P.giornoSettimana(cal.addDays(ymd, 1))}` : '');

// chiamata al motore delle corse dirette (nel server); senza motore (prove con dati finti) nessuna corsa
async function direttiDa(C, { ids, dest, ymd, linea, mz, daSecs, aSecs }) {
  if (!C.diretti) throw Object.assign(new Error('motore orari assente'), { code: 503 });
  const q = { da: ids, ymd, linee: linea ? [linea] : null, tipi: mz && mz.tipi ? mz.tipi : null, daSecs, aSecs };
  if (dest && dest.ids && dest.ids.length) q.a = mz ? dest.ids.filter(id => id.startsWith(mz.src + ':')) : dest.ids; else if (dest) q.dirTesto = dest.testo;
  if (q.a && !q.a.length) delete q.a;
  const r = await C.diretti(q);
  if (mz && !mz.tipi) r.righe = r.righe.filter(x => x.src === mz.src);
  return r;
}

// ---- RITARDO ----
async function ritardo(C, ric) {
  const { linea } = ric;
  if (ric.gruppo) {                                      // con la fermata: la prossima corsa di quella linea
    const r = await partenze(C, { ...ric, n: 1 });
    if (r.vuoto || !r.dati || !r.dati.corse) return r;
    return r;
  }
  const info = L.infoLinea(C.routes, linea);
  if (!info.length) return { voce: P.esc(`Non trovo la linea ${P.lineaParlata(linea)} negli orari.`), fine: false };
  const srcs = U.unico(info.map(x => x.src));
  const veic = [];
  for (const s of srcs) { const V = await C.call(`/api/vehicles?src=${s}`); for (const v of V.vehicles || []) if (L.stessaLinea(v.line, linea) && v.tripId) veic.push({ ...v, V }); }
  const scheda0 = { titolo: `Linea ${linea}`, sottotitolo: 'Ritardi in tempo reale', righe: [], nota: '', fonte: 'Tempo reale ACTV · servizio indipendente, non ufficiale' };
  if (!veic.length) {
    const A = await C.call('/api/avvisi').catch(() => ({ items: [] })), sul = (A.items || []).filter(a => a.state === 'active' && (a.lines || []).some(l => L.stessaLinea(l.n, linea)));
    let v = `Adesso non vedo mezzi in servizio sulla linea ${P.lineaParlata(linea)}: può essere fuori orario, oppure i mezzi non trasmettono la posizione.`;
    if (sul.length) v += ` C'è un avviso: ${P.frasePulita(sul[0].title, 110)}.`;
    return { voce: P.esc(v), scheda: { ...scheda0, nota: v }, ctx: { tipo: 'ritardo' }, fine: false };
  }
  const dettagli = [];
  for (const v of veic.slice(0, 6)) {
    try { dettagli.push({ v, t: await C.call(`/api/trip?id=${encodeURIComponent(v.src + ':' + v.tripId)}&veh=${encodeURIComponent(v.key || '')}&lite=1`) }); } catch { /* una corsa non letta non blocca le altre */ }
  }
  if (!dettagli.length) return { voce: P.esc(`Vedo mezzi sulla linea ${P.lineaParlata(linea)}, ma non riesco a leggerne i ritardi.`), fine: false };
  const noti = dettagli.filter(x => !x.t.cancelled && x.t.live && x.t.delayNow != null && !x.t.stale);
  const inRitardo = noti.filter(x => x.t.delayNow >= 2), sopp = dettagli.filter(x => x.t.cancelled);
  const righe = dettagli.map(({ v, t }) => ({ badge: String(linea), colore: U.colore(info[0].color), testo: P.senzaTag(P.destinazioneParlata(t.trip?.headsign || v.headsign || '')),
    dett: t.cancelled ? 'Corsa soppressa' : (t.live && t.delayNow != null ? 'Tempo reale' : 'Da orario'), ora: t.cancelled ? 'soppressa' : (t.live && t.delayNow != null ? (t.delayNow >= 2 ? `+${t.delayNow} min` : t.delayNow <= -1 ? `${t.delayNow} min` : 'in orario') : 'da orario'), attesa: '', stato: t.cancelled ? 'soppressa' : (t.delayNow >= 2 ? 'ritardo' : t.live ? 'ok' : 'prog') }));
  let v;
  const nome = `linea ${P.lineaParlata(linea)}`;
  if (!noti.length) v = `Per la ${nome} non ho previsioni aggiornate sui mezzi in servizio.`;
  else if (!inRitardo.length) v = `Sulla ${nome} ${noti.length === 1 ? 'il mezzo con tempo reale risulta in orario' : `i ${P.parole(noti.length)} mezzi con tempo reale risultano in orario`}.`;
  else {
    const max = Math.max(...inRitardo.map(x => x.t.delayNow)), dest = P.destinazioneParlata(inRitardo.find(x => x.t.delayNow === max).t.trip?.headsign || '');
    v = inRitardo.length === 1 ? `Sulla ${nome}, la corsa per ${dest} ha ${P.minutiParlati(max)} di ritardo.`
      : `Sulla ${nome}, ${P.parole(inRitardo.length)} corse su ${P.parole(noti.length)} hanno ritardi; il massimo è ${P.minutiParlati(max)}, per ${dest}.`;
  }
  if (sopp.length) v += ` ${sopp.length === 1 ? 'Una corsa risulta soppressa' : P.maiuscola(P.parole(sopp.length)) + ' corse risultano soppresse'}.`;
  if (veic.length > 1) v += ' Vuoi sapere di una fermata precisa?';
  return { voce: P.esc(v), scheda: { ...scheda0, righe }, ctx: { tipo: 'ritardo' }, fine: false, reprompt: veic.length > 1 ? 'Di quale fermata?' : null };
}

// ---- PRIMA E ULTIMA CORSA (intero GTFS della data) ----
// ric: { gruppo, dir, linea, mezzo, quando, quale: 'ultima'|'prima' }
async function estremo(C, ric) {
  const g = ric.gruppo, adesso = C.adesso(), mz = mezzoInfo(ric.mezzo), quale = ric.quale === 'prima' ? 'prima' : 'ultima';
  const now = T.adessoRoma(adesso), ds = T.giornoDiServizio(adesso);
  const w = ric.quando && !ric.quando.adesso ? ric.quando : null;
  // giorno di servizio richiesto: quello detto; senza giorno l'ultima è di oggi (di stanotte, se è già dopo mezzanotte), la prima di domani se oggi è già iniziato
  const ymd = w ? w.ymd : (quale === 'ultima' ? ds.ymd : (now.secs > 5 * 3600 ? cal.addDays(now.ymd, 1) : now.ymd));
  const oggiServizio = !w && quale === 'ultima';
  let src = mz ? mz.src : null;
  if (ric.linea && !src) { const s = L.infoLinea(C.routes, ric.linea).map(x => x.src).filter(x => g.srcs.has(x)); if (new Set(s).size === 1) src = s[0]; }
  const ids = ric.ids && ric.ids.length ? ric.ids : C.luoghi.idsDi(g, src);
  const dest = destinazione(C, ric.dir, g);
  const daSecs = quale === 'prima' && w && w.conOra ? w.secs : null;
  const res = await direttiDa(C, { ids, dest, ymd, linea: ric.linea, mz, daSecs });
  const giorno = oggiServizio ? 'oggi' : P.giornoParlato(ymd, now.ymd);
  const ctxBase = { tipo: quale, ymd };
  const scheda = { titolo: g.parlato, sottotitolo: `${quale === 'ultima' ? 'Ultima corsa' : 'Prima corsa'} · ${giorno}`, righe: [], nota: 'Orari programmati: possono cambiare con ritardi o variazioni.', fonte: 'Orari ACTV · servizio indipendente, non ufficiale' };
  const tratta = `${dest ? `da ${g.parlato} ${ric.verso ? 'verso' : 'a'} ${dest.nome}` : `da ${g.parlato}`}${ric.linea ? ` con la linea ${P.lineaParlata(ric.linea)}` : ''}`;
  if (res.nessunGtfs.length && !res.righe.length) return { voce: P.esc(`Non ho ancora orari validi per ${giorno}.`), scheda, ctx: ctxBase, fine: false, vuoto: true };
  const utili = res.righe.filter(r => !r.cancel);
  if (!utili.length) {
    if (dest && dest.ids && dest.ids.length && !ric.verso) {
      const v = `Non risultano collegamenti diretti ${tratta} ${giorno}. Vuoi che cerchi un percorso con cambi?`;
      return { voce: P.esc(v), scheda: { ...scheda, nota: v }, ctx: ctxBase, fine: false, vuoto: true, proponi: { tipo: 'itinerario', da: { chiave: g.chiave }, a: { chiave: dest.gruppo.chiave }, quando: w || null } };
    }
    return { voce: P.esc(`Non risultano corse ${tratta} ${giorno}, secondo gli orari disponibili.`), scheda, ctx: ctxBase, fine: false, vuoto: true };
  }
  // senza destinazione né linea: una risposta per direzione (al massimo due), la più tarda/presto per prima
  const scegli = list => (quale === 'ultima' ? list[list.length - 1] : list[0]);
  let gruppi;
  if (dest || ric.linea) gruppi = [scegli(utili)];
  else {
    const per = new Map();
    for (const r of utili) { const k = L.normalizza(P.destinazioneParlata(r.headsign || '')); const x = per.get(k); if (!x || (quale === 'ultima' ? r.dep > x.dep : r.dep < x.dep)) per.set(k, r); }
    gruppi = [...per.values()].sort((a, b) => (quale === 'ultima' ? b.dep - a.dep : a.dep - b.dep)).slice(0, 2);
  }
  const r0 = gruppi[0], fe = fermataEsatta(C, r0.from), lin = r0.type === 0 ? `il tram ${P.lineaParlata(r0.line)}` : `la linea ${P.lineaParlata(r0.line)}`;
  const nowSec = oggiServizio ? ds.secs : null;
  let v;
  if (quale === 'ultima' && nowSec != null && r0.dep < nowSec) {
    v = `L'ultima corsa programmata ${tratta} era ${P.oraParlata(T.hhmmDa(r0.dep))}. Non ne risultano altre per oggi.`;
  } else {
    const cosa = dest && !ric.verso ? (quale === 'ultima' ? 'l\'ultimo collegamento diretto' : 'il primo collegamento diretto') : `${quale === 'ultima' ? 'l\'ultima corsa' : 'la prima corsa'} ${tratta}`;
    const testa = oggiServizio ? P.maiuscola(cosa) : `${P.maiuscola(giorno)}, ${cosa}`;
    v = `${testa} parte ${P.oraParlata(T.hhmmDa(r0.dep))}${notte(r0, ymd)}, con ${lin} per ${P.destinazioneParlata(r0.headsign || '')}${fe.con ? ', ' + fe.con : ''}.`;
    if (r0.arr != null && !ric.verso) v += ` Arriva ${P.oraParlata(T.hhmmDa(r0.arr))}.`;
    if (gruppi[1]) { const r1 = gruppi[1]; v += ` Verso ${P.destinazioneParlata(r1.headsign || '')}, ${quale === 'ultima' ? 'l\'ultima' : 'la prima'} è ${P.oraParlata(T.hhmmDa(r1.dep))}${notte(r1, ymd)}, ${r1.type === 0 ? 'tram' : 'linea'} ${P.lineaParlata(r1.line)}.`; }
    v += ' È un orario programmato.';
  }
  const soppressa = res.righe.find(r => r.cancel && (quale === 'ultima' ? r.dep > r0.dep : r.dep < r0.dep));
  if (soppressa) v += ` La corsa ${P.oraParlata(T.hhmmDa(soppressa.dep))} risulta soppressa.`;
  scheda.righe = gruppi.map(r => ({ badge: String(r.line), colore: U.colore(r.color), testo: P.senzaTag(P.destinazioneParlata(r.headsign || '')), dett: [fermataEsatta(C, r.from).breve, r.arr != null ? `arrivo ${T.hhmmDa(r.arr)}` : null, 'orario programmato'].filter(Boolean).map(P.maiuscola).join(' · '), ora: T.hhmmDa(r.dep), attesa: '', stato: 'prog' }));
  return { voce: P.esc(v.replace(/\s{2,}/g, ' ').replace(/ ,/g, ',')), scheda, ctx: { ...ctxBase, dep: r0.dep, trip: `${r0.src}:${r0.tripId}` }, fine: false, dati: { corse: gruppi.map(r => ({ id: `${r.src}:${r.tripId}`, line: r.line, dep: r.dep, arr: r.arr, from: r.from, to: r.to })) } };
}

// ---- LINEE DI UNA FERMATA (orari di oggi) ----
async function linee(C, ric) {
  const g = ric.gruppo, mz = mezzoInfo(ric.mezzo), ds = T.giornoDiServizio(C.adesso());
  const ids = C.luoghi.idsDi(g, mz ? mz.src : null);
  const res = await direttiDa(C, { ids, ymd: ds.ymd, mz });
  const nomi = [...new Set(res.righe.map(r => r.line))].sort((a, b) => String(a).localeCompare(String(b), 'it', { numeric: true }));
  if (!nomi.length) return { voce: P.esc(`Oggi da ${g.parlato} non risultano corse, secondo gli orari disponibili.`), fine: false, vuoto: true, ctx: { tipo: 'linee' } };
  const max = 8, detti = nomi.slice(0, max).map(n => P.lineaParlata(n));
  const v = `Oggi da ${g.parlato} ${nomi.length === 1 ? 'passa la linea' : 'passano le linee'} ${P.elenco(detti)}${nomi.length > max ? `, e altre ${P.parole(nomi.length - max)}` : ''}.`;
  return { voce: P.esc(v), scheda: { titolo: g.parlato, sottotitolo: 'Linee di oggi', righe: nomi.slice(0, 12).map(n => ({ badge: String(n), colore: U.colore((L.infoLinea(C.routes, n)[0] || {}).color), testo: '', dett: '', ora: '', attesa: '', stato: 'prog' })), nota: '', fonte: 'Orari ACTV · servizio indipendente, non ufficiale' }, ctx: { tipo: 'linee' }, fine: false };
}

module.exports = { partenze, ritardo, estremo, linee, frasePartenza, descriviStato, vaVerso, avvisiFermate, fermataEsatta, destinazione, mezzoInfo, MEZZI, tipoRiga };
