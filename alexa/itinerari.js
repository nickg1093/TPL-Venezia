'use strict';
// ITINERARI: usa /api/percorso (RAPTOR, lo stesso motore e le stesse regole della PWA). Qui si traducono richiesta e risposta in parole.
// Non si dichiarano percorsi a piedi precisi né «sicuri dall'acqua alta»: i tratti a piedi sono quelli stimati dal pianificatore (linea d'aria).
const P = require('./parlato');
const L = require('./luoghi');
const T = require('./tempo');
const U = require('./util');
const M = require('./marea');

const PREF = { equilibrata: 'equilibrata', veloce: 'veloce', cambi: 'cambi', piedi: 'piedi' };

function costruisciQuery(C, ric) {
  const q = [`da=${encodeURIComponent(C.luoghi.paramPercorso(ric.da, ric.mezzo || null))}`, `a=${encodeURIComponent(C.luoghi.paramPercorso(ric.a, ric.mezzo || null))}`];
  const w = ric.quando;
  if (w && !w.adesso) { q.push(`secs=${w.secs}`, `date=${w.ymd}`); if (w.entro) q.push('arrivo=1'); }
  else if (w && w.entro) { /* «entro» senza orario: non ha senso, si ignora */ }
  if (ric.mezzo === 'nav' || ric.mezzo === 'aut') q.push(`mezzi=${ric.mezzo}`);
  if (Number.isInteger(ric.cambi) && ric.cambi >= 0 && ric.cambi <= 4) q.push(`cambi=${ric.cambi}`);
  if (ric.pref && PREF[ric.pref]) q.push(`pref=${PREF[ric.pref]}`);
  return '/api/percorso?' + q.join('&');
}

const nomeFermata = f => P.fermataParlata ? P.fermataParlata(f.name) : P.nomeParlato(f.name);
const ritardoTxt = x => (x && x.live && x.delay != null && !x.stale ? (x.delay >= 2 ? `con ${P.minutiParlati(x.delay)} di ritardo` : x.delay <= -1 ? `in anticipo di ${P.minutiParlati(-x.delay)}` : '') : '');

// avvisi in corso che toccano le linee della soluzione (scioperi, sospensioni): una frase breve, mai l'intero testo
async function avvisiLinee(C, sol) {
  try {
    const A = await C.call('/api/avvisi'), mie = new Set(sol.tratte.filter(t => t.tipo === 'mezzo').map(t => `${t.src}:${String(t.line).toUpperCase()}`));
    return (A.items || []).filter(a => a.state === 'active' && ['no_service', 'strike', 'detour', 'reduced', 'stop_moved', 'restoring'].includes(a.effect) && !a.general && (a.lines || []).some(l => mie.has(`${l.s}:${String(l.n).toUpperCase()}`)));
  } catch { return []; }
}

// frase di una tratta; la prima è completa, le altre più brevi
function fraseTratta(C, t, i, primaTratta) {
  if (t.tipo === 'piedi') {
    const min = P.minutiParlati(t.min);
    if (t.estremo === 'partenza') return `Cammina ${min} fino a ${nomeFermata(t.a)}`;
    if (t.estremo === 'arrivo') return `Poi cammina ${min} fino a destinazione`;
    return `Cammina ${min} da ${nomeFermata(t.da)} a ${nomeFermata(t.a)}`;
  }
  const dest = P.destinazioneParlata(t.headsign || '');
  const rit = ritardoTxt(t.da);
  let s = `${primaTratta ? 'Prendi' : 'Poi prendi'} la linea ${P.lineaParlata(t.line)} per ${dest}`;
  s += ` da ${nomeFermata(t.da)}, ${P.oraParlata(t.da.exp)}${rit ? ', ' + rit : ''}`;
  if (t.da.cancel) s += `. Attenzione: questa corsa risulta ${t.da.cancel === 'trip' ? 'soppressa' : 'senza fermata qui'}`;
  s += `. Scendi a ${nomeFermata(t.a)}, ${P.oraParlata(t.a.exp)}`;
  return s;
}

function rigaScheda(t) {
  if (t.tipo === 'piedi') return { badge: 'A piedi', colore: '#4A5A6A', testo: t.estremo === 'arrivo' ? 'Fino a destinazione' : t.estremo === 'partenza' ? `Fino a ${P.senzaTag(P.nomeParlato(t.a.name))}` : `Fino a ${P.senzaTag(P.nomeParlato(t.a.name))}`, dett: P.minutiParlati(t.min), ora: '', attesa: '', stato: 'prog' };
  const rit = ritardoTxt(t.da), st = t.da.cancel ? 'soppressa' : t.da.live ? (t.da.delay >= 2 ? 'ritardo' : 'ok') : 'prog';
  return { badge: String(t.line), colore: U.colore(t.color), testo: `${P.senzaTag(P.nomeParlato(t.da.name))} → ${P.senzaTag(P.nomeParlato(t.a.name))}`, dett: [rit, `arrivo ${t.a.exp}`].filter(Boolean).join(' · '), ora: t.da.exp, attesa: '', stato: st };
}

// ---- ITINERARIO ----
// ric: { da, a, quando, mezzo, cambi, pref, indice, soloAlternative }
async function itinerario(C, ric) {
  const adesso = C.adesso();
  if (!ric.da || !ric.a) return { voce: P.esc('Mi servono sia la partenza sia la destinazione.'), fine: false, ctx: null };
  if (ric.da.chiave === ric.a.chiave) return { voce: P.esc('Partenza e destinazione coincidono.'), fine: false, ctx: null };
  const R = await C.call(costruisciQuery(C, ric));
  const w = ric.quando && !ric.quando.adesso ? ric.quando : null, oggi = T.adessoRoma(adesso).ymd;
  const idx = Math.max(0, ric.indice || 0), sols = R.soluzioni || [];
  const nome = { da: ric.da.parlato, a: ric.a.parlato };
  const ctx = { tipo: 'itinerario', da: ric.da.chiave, a: ric.a.chiave, quando: w ? { ymd: w.ymd, secs: w.secs, entro: !!w.entro } : null, mezzo: ric.mezzo || null, cambi: Number.isInteger(ric.cambi) ? ric.cambi : null, pref: ric.pref || null, indice: idx + 1, n: sols.length };
  const scheda0 = { titolo: `${P.senzaTag(nome.da)} → ${P.senzaTag(nome.a)}`, sottotitolo: '', righe: [], nota: '', fonte: 'Orari e tempo reale ACTV · servizio indipendente, non ufficiale' };

  if (R.senzaFermate) {
    const chi = R.senzaFermate === 'da' ? nome.da : nome.a;
    const v = `Non trovo fermate utilizzabili vicino a ${chi}${ric.mezzo ? ' per il mezzo richiesto' : ''}.`;
    return { voce: P.esc(v), scheda: { ...scheda0, nota: v }, ctx: null, fine: false, vuoto: true };
  }
  const aPiedi = R.piedi != null ? `A piedi servirebbero circa ${P.minutiParlati(R.piedi)}, in linea d'aria.` : '';
  if (!sols.length || idx >= sols.length) {
    let v;
    if (!sols.length) {
      v = `Non trovo un collegamento da ${nome.da} a ${nome.a}${w ? ` ${w.entro ? 'per arrivare entro ' + P.oraSenzaPrep(w.hhmm) : 'con partenza ' + P.oraParlata(w.hhmm)}${w.ymd !== oggi ? ' ' + P.giornoParlato(w.ymd, oggi) : ''}` : ' nelle prossime ore'}${ric.cambi === 0 ? ' senza cambi' : ''}.`;
      if (ric.cambi === 0 || ric.mezzo) v += ' Posso riprovare togliendo i limiti.';
      if (aPiedi) v += ' ' + aPiedi;
    } else v = 'Non ho altre soluzioni da proporti per questo percorso.';
    return { voce: P.esc(v), scheda: { ...scheda0, nota: v }, ctx: { ...ctx, indice: Math.min(idx, sols.length) }, fine: false, vuoto: true };
  }
  const s = sols[idx], parti = [];
  const eti = s.etichetta && sols.length > 1 ? ({ 'Consigliata': 'La soluzione consigliata', 'Arrivo prima': 'La più veloce', 'Parti più tardi': 'Quella che ti fa partire più tardi', 'Meno cambi': 'Quella con meno cambi', 'Meno a piedi': 'Quella con meno strada a piedi' })[s.etichetta] : null;
  const intro = idx === 0 ? (eti || 'Ti consiglio questo percorso') : (eti || `Alternativa numero ${P.parole(idx + 1)}`);
  const cambi = s.cambi === 0 ? 'senza cambi' : s.cambi === 1 ? 'un cambio' : `${P.parole(s.cambi)} cambi`;
  const testa = w && w.entro
    ? `${intro}, per arrivare a ${nome.a} entro ${P.oraSenzaPrep(w.hhmm)}: parti ${P.oraParlata(s.parti)} da ${nome.da} e arrivi ${P.oraParlata(s.arrivi)}${s.margine != null ? `, con ${P.minutiParlati(s.margine)} di margine` : ''}.`
    : `${intro}: parti ${P.oraParlata(s.parti)} da ${nome.da} e arrivi ${P.oraParlata(s.arrivi)} a ${nome.a}.`;
  parti.push(P.esc(testa));
  parti.push(P.esc(`In tutto ${P.minutiParlati(s.minuti)}, ${cambi}${s.piedi >= 1 ? `, ${P.minutiParlati(s.piedi)} a piedi` : ''}.`));
  const mezzi = s.tratte.filter(t => t.tipo === 'mezzo');
  let k = 0;
  const frasi = s.tratte.map(t => { const f = fraseTratta(C, t, k, k === 0 && t.tipo === 'mezzo'); if (t.tipo === 'mezzo') k++; return f; });
  const lungo = frasi.length > 5;
  parti.push(P.esc(frasi.slice(0, lungo ? 5 : frasi.length).join('. ') + '.'));
  if (lungo) parti.push(P.esc('Il resto del percorso è nella scheda della skill o nell\'app.'));
  // cambi stretti o persi: sempre detti
  const stretti = mezzi.filter(t => t.aRischio || t.persa);
  if (stretti.length) {
    const t = stretti[0];
    parti.push(P.esc(t.persa ? `Attenzione: con i ritardi attuali la coincidenza a ${nomeFermata(t.da)} è persa.` : `Attenzione: il cambio a ${nomeFermata(t.da)} è stretto, ${t.cambioMin === 0 ? 'senza margine' : 'solo ' + P.minutiParlati(t.cambioMin)} per prendere la linea ${P.lineaParlata(t.line)}.`));
  }
  if (s.limite && w && w.entro && !stretti.length) parti.push(P.esc('Il margine è molto stretto: se vuoi stare tranquillo, parti prima.'));
  // alternative nello stesso percorso (altri orari)
  if (s.poi && s.poi.length) parti.push(P.esc(`Altre partenze utili: ${s.poi.slice(0, 2).map(x => `${P.oraParlata(x.parti)}, con arrivo ${P.oraParlata(x.arrivi)}`).join('; oppure ')}.`));
  // avvisi e stato dei dati
  const avv = await avvisiLinee(C, s);
  if (avv.length) parti.push(P.esc(`Attenzione: c'è un avviso in corso sulla linea ${P.lineaParlata(String(avv[0].lines.find(l => mezzi.some(t => String(t.line).toUpperCase() === String(l.n).toUpperCase()))?.n || mezzi[0].line))}: ${P.frasePulita(avv[0].title, 110)}.`));
  const tuttiProg = mezzi.every(t => !(t.da.live && t.da.delay != null));
  if (w) parti.push(P.esc(`Sono orari programmati ${P.giornoParlato(w.ymd, oggi)}, senza tempo reale.`));
  else if (tuttiProg) parti.push(P.esc('Non ho il tempo reale per queste corse: sono orari programmati.'));
  // acqua alta: solo nota, mai un percorso «sicuro»
  let nota = '';
  try {
    if (!w || w.ymd === oggi) {
      const t = await C.call('/api/tide'), r = await M.livelloRif(C, t, 4);
      if (r.max >= 100 && s.piedi >= 1) { nota = `Con la marea attuale o prevista (${M.cmParlato(r.max)}) i tratti a piedi possono essere allagati: non calcolo percorsi sicuri dall'acqua alta.`; parti.push(P.esc(nota)); }
    }
  } catch { /* senza marea: nessuna nota */ }
  if (s.piedi >= 1) parti.push(P.esc('I tratti a piedi sono stime in linea d\'aria.'));
  if (aPiedi && R.piedi != null && R.piedi < s.minuti) parti.push(P.esc(aPiedi));
  const scheda = { ...scheda0, sottotitolo: `${P.senzaTag(P.oraParlata(s.parti)).replace(/^alle |^all'|^a /, '')} → ${s.arrivi} · ${s.minuti} min · ${s.cambi === 0 ? 'diretto' : s.cambi + (s.cambi === 1 ? ' cambio' : ' cambi')}`,
    grande: `${s.parti} → ${s.arrivi}`, righe: s.tratte.slice(0, 6).map(rigaScheda), nota: [nota, s.piedi >= 1 ? 'Tratti a piedi in linea d\'aria.' : '', w ? 'Orari programmati.' : ''].filter(Boolean).join(' '), indice: idx + 1, n: sols.length };
  const reprompt = idx + 1 < sols.length ? 'Vuoi un\'alternativa?' : 'Vuoi altro?';
  return { voce: parti.join(' '), scheda, ctx, fine: false, reprompt };
}

module.exports = { itinerario, costruisciQuery, fraseTratta };
