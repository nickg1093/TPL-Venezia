'use strict';
// AVVISI DI SERVIZIO: dal sistema avvisi della PWA (/api/avvisi: sito ACTV + canale Telegram, già unificati, con validità, linee, fermate,
// scioperi e fasce garantite). Qui si scelgono quelli utili e si dicono in poche parole: mai l'intero comunicato, mai indirizzi web.
const P = require('./parlato');
const L = require('./luoghi');
const T = require('./tempo');
const U = require('./util');
const M = require('./marea');

const COPERTURA_GIORNI = 3;   // come avvisi.js: in corso + in arrivo entro 3 giorni
const GRAVI = { severe: 0, warning: 1, info: 2 };
const ETICHETTA = { strike: 'sciopero', no_service: 'servizio sospeso', detour: 'deviazione', stop_moved: 'fermata spostata', delays: 'ritardi', reduced: 'servizio ridotto', additional: 'servizio aggiuntivo', modified: 'servizio modificato', water: 'acqua alta', restoring: 'ripristino in corso', resolved: 'servizio ripristinato', other: 'avviso' };

const hhmm = ms => U.hhmmMs(ms);
const ymdDi = ms => T.adessoRoma(ms).ymd;
// testo dell'avviso adatto alla voce: senza link, sigle lette bene, breve
function testoVoce(t, max = 130) {
  let s = P.esc(P.frasePulita(t, max).replace(/[\s.;,:–-]+$/, '')).replace(/&apos;/g, "'");
  s = s.replace(/\b(ACTV|AVM|ATVO|FS|PMV|ZTL)\b/g, '<say-as interpret-as="characters">$1</say-as>');
  return M.conMose(s);
}
// «dalle sei», «dall'una», «da mezzogiorno», «dalla mezzanotte»
function dalle(hm) {
  const h = +String(hm).slice(0, 2), m = String(hm).slice(3, 5), resto = +m ? ` e ${P.parole(+m)}` : '';
  return (h === 0 ? 'dalla mezzanotte' : h === 12 ? 'da mezzogiorno' : h === 1 ? "dall'una" : `dalle ${P.parole(h)}`) + resto;
}
function giornoOra(ms, oggi) { return `${P.giornoParlato(ymdDi(ms), oggi)} ${P.oraParlata(hhmm(ms))}`; }
// quando vale l'avviso, in parole
function validita(it, oggi) {
  const sc = it.sciopero;
  if (sc) {
    const a = ymdDi(sc.inizio), b = ymdDi(Math.max(sc.inizio, sc.fine - 1000));
    const giornoIntero = hhmm(sc.inizio) === '00:00' && hhmm(sc.fine - 1000) >= '23:55';
    if (giornoIntero && a === b) return `per tutto il giorno, ${P.giornoParlato(a, oggi)}`;
    if (a === b) return `${P.giornoParlato(a, oggi)}, ${dalle(hhmm(sc.inizio))} ${P.oraParlata(hhmm(sc.fine))}`;
    return `da ${giornoOra(sc.inizio, oggi)} a ${giornoOra(sc.fine, oggi)}`;
  }
  if (it.state === 'upcoming') return `da ${giornoOra(it.from, oggi)}`;
  if (it.open || !it.dated && (it.to - it.from) > 6 * 24 * 3600e3) return 'in corso, senza una data di fine indicata';
  return `in corso fino a ${giornoOra(it.to, oggi)}`;
}
const fasceTesto = f => (f && f.length ? `Fasce garantite indicate: ${P.elenco(f.map(([x, y]) => `${dalle(x)} ${P.oraParlata(y)}`))}.` : '');

// i nomi di una fermata/gruppo si confrontano con quelli dell'avviso
function toccaGruppo(it, g) {
  const ids = new Set(g.ids);
  if ((it.stops || []).some(s => ids.has(s))) return true;
  return (it.stopNames || []).some(x => L.normalizza(x.n || x) === g.chiave);
}
function toccaLinea(it, linea, srcs) {
  return (it.lines || []).some(l => L.stessaLinea(String(l.n), linea) && (!srcs || !srcs.size || srcs.has(l.s)));
}

// ric: { linea?, gruppo?, quando?(periodo), soloSciopero?, mezzo?, tutti? }
async function avvisi(C, ric = {}) {
  const adesso = C.adesso(), oggi = T.adessoRoma(adesso).ymd;
  let A;
  try { A = await C.call('/api/avvisi'); } catch (e) { return { voce: P.esc(U.erroreParlato(e)), fine: false, ctx: { tipo: 'avvisi' } }; }
  const per = T.periodo(ric.dataRichiesta, adesso, COPERTURA_GIORNI);
  const da = T.inizioMs(per.da, 0), a = T.inizioMs(per.a, 86400), srcs = ric.linea ? new Set(L.infoLinea(C.routes, ric.linea).map(x => x.src)) : null;
  const fine = it => (it.sciopero ? it.sciopero.fino : it.to) || Infinity, inizio = it => (it.sciopero ? it.sciopero.da : it.from);
  let lista = (A.items || []).filter(it => it.effect !== 'resolved' || it.state === 'active');
  lista = lista.filter(it => inizio(it) < a && fine(it) > Math.max(da, adesso));
  if (ric.soloSciopero) lista = lista.filter(it => it.effect === 'strike');
  else lista = lista.filter(it => it.effect !== 'water' && it.effect !== 'additional');   // acqua alta: c'è la marea; aggiuntivi: non sono problemi
  const generali = it => it.general || (!(it.lines || []).length && !(it.stops || []).length);
  let filtro = '';
  if (ric.linea) { lista = lista.filter(it => toccaLinea(it, ric.linea, srcs) || (it.effect === 'strike' && generali(it)) || (generali(it) && it.severity !== 'info')); filtro = `sulla linea ${P.lineaParlata(ric.linea)}`; }
  else if (ric.gruppo) { lista = lista.filter(it => toccaGruppo(it, ric.gruppo) || (it.effect === 'strike' && generali(it))); filtro = `per ${ric.gruppo.parlato}`; }
  if (ric.mezzo) {                                   // «e per i vaporetti?»: avvisi di quel servizio e generali
    const src = ric.mezzo === 'nav' ? 'nav' : 'aut';
    lista = lista.filter(it => generali(it) || (it.lines || []).some(l => l.s === src));
    filtro = `${filtro ? filtro + ' ' : ''}per ${src === 'nav' ? 'i vaporetti' : ric.mezzo === 'tram' ? 'il tram' : 'autobus e tram'}`;
  }
  lista.sort((x, y) => GRAVI[x.severity] - GRAVI[y.severity] || inizio(x) - inizio(y));
  const dati = U.frasEta(A.updated, adesso, 45, 'Gli avvisi');
  const limite = per.a > T.adessoRoma(adesso + COPERTURA_GIORNI * 86400e3).ymd ? ` Considero solo gli avvisi in corso e dei prossimi ${P.parole(COPERTURA_GIORNI)} giorni: oltre non ho dati.` : '';
  const quando = per.tipo === 'prossimi' ? '' : ` ${P.giornoParlato(per.da, oggi)}`;
  const ctx = { tipo: 'avvisi', linea: ric.linea || null, g: ric.gruppo ? ric.gruppo.chiave : null, soloSciopero: !!ric.soloSciopero };
  const scheda = { titolo: ric.soloSciopero ? 'Scioperi' : 'Avvisi di servizio', sottotitolo: filtro.replace(/^per |^sulla /, ''), righe: [], nota: '', fonte: 'Avvisi ACTV (sito e canale Telegram) · servizio indipendente, non ufficiale' };

  if (!lista.length) {
    let v = ric.soloSciopero ? `Non risultano scioperi comunicati${filtro ? ' ' + filtro : ''}${quando}.` : `Non risultano avvisi ${filtro || 'di servizio'}${quando}, nei dati disponibili.`;
    v += limite || ` Controllo gli avvisi in corso e dei prossimi ${P.parole(COPERTURA_GIORNI)} giorni.`;
    if (A.stale) v += ' Attenzione: gli avvisi non si aggiornano da un po\': potrebbero mancare le ultime comunicazioni.';
    else if (dati) v += ' ' + dati;
    scheda.nota = v;
    return { voce: P.esc(v).replace(/&apos;/g, "'"), scheda, ctx, fine: false, vuoto: true };
  }
  const mostra = lista.slice(0, ric.tutti ? 5 : ric.breve ? 1 : 3);
  const parti = [];
  const intro = ric.breve ? (lista.length === 1 ? 'C\'è un avviso.' : `Ci sono ${P.parole(lista.length)} avvisi; il più importante:`) : lista.length === 1 ? `C'è un avviso ${filtro}${quando}.` : `Ci sono ${P.parole(lista.length)} avvisi ${filtro}${quando}${lista.length > mostra.length ? `: ti dico i primi ${P.parole(mostra.length)}` : ''}.`;
  parti.push(P.esc(intro).replace(/&apos;/g, "'").replace(/\s+([.:;])/g, '$1'));
  for (const it of mostra) {
    const et = ETICHETTA[it.effect] || 'avviso', linee = (it.lines || []).filter(l => l.s === 'nav' || l.s).map(l => l.n);
    const chi = linee.length && linee.length <= 3 && !ric.linea ? ` linea ${P.elenco(linee.map(P.lineaParlata))}` : '';
    const tl = L.normalizza(it.title), eti = tl.includes(L.normalizza(et).split(' ')[0]) ? '' : `${P.maiuscola(et)}${linee.length && !linee.some(n => tl.split(' ').includes(L.normalizza(String(n)))) ? chi : ''}: `;
    let f = `${eti}${testoVoce(it.title)}. ${P.esc(P.maiuscola(validita(it, oggi))).replace(/&apos;/g, "'")}.`;
    if (it.effect === 'strike') { const ft = fasceTesto(it.sciopero && it.sciopero.fasce); if (ft) f += ' ' + P.esc(ft).replace(/&apos;/g, "'"); else f += ' Le fasce garantite non risultano nei dati: controlla il comunicato ACTV.'.replace(/ACTV/, '<say-as interpret-as="characters">ACTV</say-as>'); }
    parti.push(f);
    scheda.righe.push({ badge: (ETICHETTA[it.effect] || 'Avviso').slice(0, 10), colore: it.severity === 'severe' ? '#C0392B' : it.severity === 'warning' ? '#C99A2E' : '#4A5A6A', testo: P.frasePulita(it.title, 70), dett: validita(it, oggi), ora: '', attesa: '', stato: it.severity === 'severe' ? 'soppressa' : 'ritardo' });
  }
  if (A.stale) parti.push(P.esc('Attenzione: gli avvisi non si aggiornano da un po\': potrebbero mancare le ultime comunicazioni.').replace(/&apos;/g, "'"));
  else if (dati && !ric.breve) parti.push(P.esc(dati));
  if (limite && !ric.breve) parti.push(P.esc(limite.trim()));
  scheda.nota = limite.trim() || `Avvisi in corso e dei prossimi ${COPERTURA_GIORNI} giorni.`;
  return { voce: parti.join(' '), scheda, ctx, fine: false, reprompt: lista.length > mostra.length && !ric.breve ? 'Vuoi sentire gli altri?' : null, n: lista.length };
}

module.exports = { avvisi, validita, fasceTesto, COPERTURA_GIORNI };
