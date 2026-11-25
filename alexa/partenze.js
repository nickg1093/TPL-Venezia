'use strict';
// PARTENZE, RITARDI, ULTIMA CORSA. Usa solo le API del server (/api/zone, /api/vehicles, /api/trip, /api/avvisi): stessi dati e stesse regole della PWA.
const P = require('./parlato');
const L = require('./luoghi');
const T = require('./tempo');
const U = require('./util');

const normDir = s => L.normalizza(s);
// una corsa «va verso» la destinazione detta se il capolinea o una fermata successiva la contiene
function vaVerso(d, nexts, dirChiave) {
  if (!dirChiave) return true;
  const alvo = [d.headsign, ...((nexts && nexts[d.nx] && nexts[d.nx].s) || [])].map(normDir);
  return alvo.some(x => x === dirChiave || x.split(' ').includes(dirChiave) || (dirChiave.length > 3 && x.includes(dirChiave)));
}
// avvisi di fermata sospesa che toccano queste fermate (solo in corso)
async function avvisiFermate(C, ids) {
  try {
    const A = await C.call('/api/avvisi'), set = new Set(ids);
    return (A.items || []).filter(a => a.state === 'active' && ['no_service', 'stop_moved'].includes(a.effect) && (a.stops || []).some(s => set.has(s)) && a.ambito === 'fermate');
  } catch { return []; }
}

// stato di una partenza in parole + stato per la scheda
function descriviStato(d) {
  if (d.cancel === 'trip') return { testo: 'corsa soppressa', stato: 'soppressa' };
  if (d.cancel === 'stop') return { testo: 'questa corsa non ferma qui', stato: 'soppressa' };
  if (d.live && d.delay != null) {
    if (d.stale) return { testo: `stima non aggiornata${d.stale.min ? ' da ' + P.minutiParlati(d.stale.min) : ''}`, stato: 'stima' };
    if (d.delay >= 2) return { testo: `con ${P.minutiParlati(d.delay)} di ritardo`, stato: 'ritardo' };
    if (d.delay <= -1) return { testo: `in anticipo di ${P.minutiParlati(-d.delay)}`, stato: 'ok' };
    return { testo: 'in orario', stato: 'ok' };
  }
  return { testo: 'da orario programmato', stato: 'prog' };
}
// una partenza: { voce, riga }; primo = frase completa, altri = più brevi
function frasePartenza(C, d, { completa = true, programmato = false } = {}) {
  const st = programmato ? { testo: null, stato: 'prog' } : descriviStato(d);
  const sp = C.luoghi.stopPerId(d.stop), pont = sp?.pontile;
  const dest = P.destinazioneParlata(d.headsign || '');
  const ora = d.live && !programmato ? d.exp : d.sched, minuti = d.live && !programmato ? d.expIn : d.schedIn;
  const att = programmato ? '' : (d.atStop ? 'in fermata' : P.attesa(minuti));
  const parti = [`linea ${P.lineaParlata(d.line)} per ${dest}`];
  if (pont && completa) parti.push(`dal pontile ${pont}`);
  let voce = parti.join(' ');
  if (d.cancel) voce += `: ${st.testo}`;
  else voce += `: ${[att, P.oraParlata(ora), st.testo].filter(Boolean).join(', ')}`;
  const riga = { badge: String(d.line), colore: U.colore(d.color), testo: (P.senzaTag(dest)), dett: [pont ? `Pontile ${pont}` : null, st.testo].filter(Boolean).join(' · '), ora: d.cancel ? '—' : ora, attesa: att.replace('tra ', ''), stato: st.stato };
  return { voce, riga };
}

// ---- PARTENZE ----
// ric: { gruppo, linea, mezzo, dir, dirNome, off, quando }
async function partenze(C, ric) {
  const g = ric.gruppo, adesso = C.adesso();
  let mezzo = ric.mezzo || null;
  if (ric.linea && !mezzo) {
    const srcs = L.infoLinea(C.routes, ric.linea).map(x => x.src).filter(s => g.srcs.has(s));
    if (new Set(srcs).size === 1) mezzo = srcs[0];
  }
  const ids = C.luoghi.idsDi(g, mezzo);
  if (!ids.length) return { voce: `A ${g.parlato} non ci sono fermate ${mezzo === 'aut' ? 'di autobus' : 'di vaporetto'}.`, fine: false, ctx: null };
  const q = ric.quando && !ric.quando.adesso ? `&secs=${ric.quando.secs}&date=${ric.quando.ymd}` : '';
  const Z = await C.call(`/api/zone?ids=${ids.map(encodeURIComponent).join(',')}${q}`);
  const dirChiave = ric.dir ? normDir(ric.dir) : null, programmato = !!q;
  let lista = (Z.departures || []).filter(d => !d.done && !d.arrival && (programmato || d.expIn > -2 || d.schedIn > -2));
  const tutte = lista.length;
  if (ric.linea) lista = lista.filter(d => L.stessaLinea(d.line, ric.linea));
  if (dirChiave) lista = lista.filter(d => vaVerso(d, Z.nexts, dirChiave));
  const off = Math.max(0, ric.off || 0), mostra = lista.slice(off, off + (ric.n || 3));
  const chi = [ric.linea ? `la linea ${P.lineaParlata(ric.linea)}` : null, mezzo === 'aut' && !ric.linea ? 'autobus' : null].filter(Boolean).join(' ');
  const ctx = { tipo: 'partenze', g: g.chiave, linea: ric.linea || null, mezzo, dir: ric.dir || null, dirNome: ric.dirNome || null, off: off + mostra.length, quando: ric.quando && !ric.quando.adesso ? { ymd: ric.quando.ymd, secs: ric.quando.secs } : null,
    prima: mostra[0] ? P.destinazioneParlata(mostra[0].headsign || '') : null };
  const scheda = { titolo: g.parlato, sottotitolo: 'Prossime partenze', righe: [], nota: '', fonte: 'Orari e tempo reale ACTV · servizio indipendente, non ufficiale' };
  if (!mostra.length) {
    let v = ric.linea ? `Non vedo altre partenze della linea ${P.lineaParlata(ric.linea)} da ${g.parlato}${ric.dirNome ? ' verso ' + P.nomeParlato(ric.dirNome) : ''} ${programmato ? 'in quell\'orario' : 'nelle prossime due ore'}.`
      : `Non vedo partenze da ${g.parlato}${ric.dirNome ? ' verso ' + P.nomeParlato(ric.dirNome) : ''} ${programmato ? 'in quell\'orario' : 'nelle prossime due ore'}.`;
    if (off > 0 && lista.length) v = `Non ci sono altre corse da mostrare entro le prossime due ore.`;
    else if (ric.linea && tutte) v += ' Posso dirti le altre linee che passano da qui.';
    else if (Z.note) v += ` ${Z.note}.`;
    return { voce: P.esc(v), scheda: { ...scheda, righe: [], nota: v }, ctx, fine: false, vuoto: true };
  }
  const frasi = mostra.map((d, i) => frasePartenza(C, d, { completa: true, programmato }));
  scheda.righe = frasi.map(f => f.riga);
  const tuttiProg = mostra.every(d => !(d.live && d.delay != null)) && !programmato;
  const sospese = await avvisiFermate(C, ids);
  const testa = [];
  if (programmato) testa.push(`Orari programmati ${P.giornoParlato(ric.quando.ymd, ric.quando.oggi || T.adessoRoma(adesso).ymd)} da ${P.oraParlata(T.hhmmDa(ric.quando.secs)).replace(/^alle |^all'/, '')}, senza tempo reale.`);
  else if (tuttiProg) testa.push('Non ho il tempo reale per queste corse: sono orari programmati.');
  const eta = U.frasEta(Z.liveUpdated, adesso, 3, 'Gli aggiornamenti in tempo reale');
  const intro = off === 0 ? `Da ${P.esc(g.parlato)}${chi ? ', ' + P.esc(chi) : ''}${ric.dirNome ? ', verso ' + P.esc(P.nomeParlato(ric.dirNome)) : ''}.` : '';
  const corpo = frasi.map((f, i) => (i ? `${P.pausa(250)}Poi ` : '') + P.esc(i ? f.voce : P.maiuscola(f.voce)) + '.').join(' ');
  let voce = [intro, testa.map(P.esc).join(' '), corpo].filter(Boolean).join(' ');
  if (eta) voce += ' ' + P.esc(eta);
  for (const a of sospese.slice(0, 1)) voce += ` ${P.pausa(250)}Attenzione: ${P.esc(P.frasePulita(a.title, 120))}.`;
  scheda.nota = [...testa, eta, ...sospese.slice(0, 1).map(a => 'Avviso: ' + P.frasePulita(a.title, 120))].filter(Boolean).join(' ');
  return { voce, scheda, ctx, fine: false, reprompt: 'Vuoi altre corse, o un\'altra fermata?' };
}

// ---- RITARDO di una linea (senza fermata: sui mezzi in servizio adesso) ----
async function ritardo(C, ric) {
  const { linea } = ric, adesso = C.adesso();
  if (ric.gruppo) {                                      // con la fermata: i passaggi di quella fermata
    const r = await partenze(C, { ...ric, n: 3 });
    return { ...r, voce: r.vuoto ? r.voce : r.voce };
  }
  const info = L.infoLinea(C.routes, linea);
  if (!info.length) return { voce: P.esc(`Non trovo la linea ${P.lineaParlata(linea)} nei dati.`), fine: false };
  const srcs = U.unico(info.map(x => x.src));
  const veic = [];
  for (const s of srcs) { const V = await C.call(`/api/vehicles?src=${s}`); for (const v of V.vehicles || []) if (L.stessaLinea(v.line, linea) && v.tripId) veic.push({ ...v, V }); }
  if (!veic.length) {
    const A = await C.call('/api/avvisi').catch(() => ({ items: [] })), sul = (A.items || []).filter(a => a.state === 'active' && (a.lines || []).some(l => L.stessaLinea(l.n, linea)));
    let v = `Adesso non vedo mezzi in servizio sulla linea ${P.lineaParlata(linea)}. Può essere fuori orario, oppure il mezzo non trasmette la posizione.`;
    if (sul.length) v += ` C'è un avviso: ${P.frasePulita(sul[0].title, 120)}.`;
    return { voce: P.esc(v), scheda: { titolo: `Linea ${linea}`, sottotitolo: 'Ritardi', righe: [], nota: v, fonte: '' }, ctx: { tipo: 'ritardo', linea }, fine: false };
  }
  const dettagli = [];
  for (const v of veic.slice(0, 4)) {
    try { dettagli.push({ v, t: await C.call(`/api/trip?id=${encodeURIComponent(v.src + ':' + v.tripId)}&veh=${encodeURIComponent(v.key || '')}&lite=1`) }); } catch { /* una corsa non letta non blocca le altre */ }
  }
  if (!dettagli.length) return { voce: P.esc(`Vedo ${veic.length} mezzi sulla linea ${P.lineaParlata(linea)} ma non riesco a leggerne i ritardi.`), fine: false };
  const frasi = [], righe = [];
  for (const { v, t } of dettagli) {
    const dest = P.destinazioneParlata(t.trip?.headsign || v.headsign || '');
    let s, stato = 'ok', att;
    if (t.cancelled) { s = `la corsa per ${dest} è soppressa`; stato = 'soppressa'; att = 'soppressa'; }
    else if (!t.live || t.delayNow == null) { s = `quella per ${dest} è da orario, senza tempo reale`; stato = 'prog'; att = 'da orario'; }
    else if (t.stale) { s = `per ${dest} la stima non è aggiornata`; stato = 'stima'; att = 'stima'; }
    else if (t.delayNow >= 2) { s = `quella per ${dest} ha ${P.minutiParlati(t.delayNow)} di ritardo`; stato = 'ritardo'; att = `+${t.delayNow} min`; }
    else if (t.delayNow <= -1) { s = `quella per ${dest} è in anticipo di ${P.minutiParlati(-t.delayNow)}`; att = `${t.delayNow} min`; }
    else { s = `quella per ${dest} è in orario`; att = 'in orario'; }
    frasi.push(s);
    righe.push({ badge: String(linea), colore: U.colore(info[0].color), testo: dest, dett: t.cancelled ? 'Corsa soppressa' : (t.live ? 'Tempo reale' : 'Da orario'), ora: att, attesa: '', stato });
  }
  const n = veic.length;
  const intro = `Sulla linea ${P.lineaParlata(linea)} ${n === 1 ? 'vedo un mezzo in servizio' : `vedo ${P.parole(n)} mezzi in servizio`}${dettagli.length < n ? `; ne controllo ${P.parole(dettagli.length)}` : ''}.`;
  const voce = P.esc(intro) + ' ' + frasi.map((f, i) => (i === 0 ? 'La prima: ' : i === frasi.length - 1 ? 'E l\'ultima: ' : 'Poi: ') + P.esc(f) + '.').join(' ');
  return { voce: dettagli.length === 1 ? P.esc(intro + ' Il mezzo: ' + frasi[0] + '.') : voce, scheda: { titolo: `Linea ${linea}`, sottotitolo: 'Ritardi in tempo reale', righe, nota: '', fonte: 'Tempo reale ACTV · servizio indipendente, non ufficiale' }, ctx: { tipo: 'ritardo', linea }, fine: false };
}

// ---- ULTIMA CORSA ----
async function ultima(C, ric) {
  const g = ric.gruppo, adesso = C.adesso(), ds = T.giornoDiServizio(adesso);
  let mezzo = ric.mezzo || null;
  if (ric.linea && !mezzo) { const s = L.infoLinea(C.routes, ric.linea).map(x => x.src).filter(x => g.srcs.has(x)); if (new Set(s).size === 1) mezzo = s[0]; }
  const ids = C.luoghi.idsDi(g, mezzo);
  const trovate = new Map();   // chiave linea|destinazione -> ultima (secondi assoluti del giorno di servizio)
  let vuoti = 0, calls = 0;
  for (let S = Math.max(0, ds.secs - 120); S <= 30 * 3600 && calls < 14; S += 7000) {
    calls++;
    const Z = await C.call(`/api/zone?ids=${ids.map(encodeURIComponent).join(',')}&secs=${S}&date=${ds.ymd}`);
    let n = 0;
    for (const d of Z.departures || []) {
      if (d.arrival || d.cancel === 'trip' || (ric.linea && !L.stessaLinea(d.line, ric.linea))) continue;
      if (ric.dir && !vaVerso(d, Z.nexts, normDir(ric.dir))) continue;
      const abs = S + d.schedSec; if (abs < ds.secs - 120) continue;
      n++;
      const k = `${d.line}|${normDir(P.destinazioneParlata(d.headsign || ''))}`, prev = trovate.get(k);
      if (!prev || abs > prev.abs) trovate.set(k, { abs, d });
    }
    vuoti = n ? 0 : vuoti + 1;
    if (vuoti >= 2) break;
  }
  const v = [...trovate.values()].sort((a, b) => b.abs - a.abs);
  const nome = `${ric.linea ? 'linea ' + P.lineaParlata(ric.linea) + ' da ' : 'da '}${g.parlato}`;
  if (!v.length) return { voce: P.esc(`Non trovo altre partenze ${nome} fino a stanotte. Il servizio potrebbe essere finito, oppure non c'è servizio con questi filtri.`), fine: false, ctx: { tipo: 'ultima', g: g.chiave, linea: ric.linea || null, mezzo } };
  const prima = v[0];
  const hh = T.hhmmDa(prima.abs);
  const sp = C.luoghi.stopPerId(prima.d.stop), pont = sp?.pontile;
  let voce = `L'ultima partenza ${P.esc(nome)} è ${P.esc(P.oraParlata(hh))}: linea ${P.esc(P.lineaParlata(prima.d.line))} per ${P.esc(P.destinazioneParlata(prima.d.headsign || ''))}${pont ? ', pontile ' + pont : ''}.`;
  const altre = v.slice(1, 3).map(x => `la linea ${P.lineaParlata(x.d.line)} per ${P.destinazioneParlata(x.d.headsign || '')} ${P.oraParlata(T.hhmmDa(x.abs))}`);
  if (altre.length && !ric.linea) voce += ` Altre ultime corse: ${P.esc(P.elenco(altre))}.`;
  voce += ` ${P.pausa(200)}È un orario programmato: in caso di ritardi o variazioni può cambiare.`;
  const righe = v.slice(0, 4).map(x => ({ badge: String(x.d.line), colore: U.colore(x.d.color), testo: P.destinazioneParlata(x.d.headsign || ''), dett: 'Ultima corsa · orario programmato', ora: T.hhmmDa(x.abs), attesa: '', stato: 'prog' }));
  return { voce, scheda: { titolo: g.parlato, sottotitolo: 'Ultima corsa', righe, nota: 'Orario programmato: può cambiare con ritardi o variazioni.', fonte: 'Orari ACTV · servizio indipendente, non ufficiale' }, ctx: { tipo: 'ultima', g: g.chiave, linea: ric.linea || null, mezzo }, fine: false };
}

module.exports = { partenze, ritardo, ultima, frasePartenza, descriviStato, vaVerso, avvisiFermate };
