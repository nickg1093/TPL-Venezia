'use strict';
// LUOGHI E LINEE: da ciò che l'utente dice («Zattere», «stazione», «il quattro punto uno») alle fermate e alle linee dei dati veri.
// Nessun elenco duplicato: l'indice si costruisce dall'elenco delle fermate e delle linee che il server già ha (come /api/stops e /api/routes).
const P = require('./parlato');

const senzaAccenti = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const SANTI = new Set(['san', 'santa', 'sant', 'santo', 's']);
const VUOTE = new Set(['di', 'del', 'della', 'dei', 'delle', 'dello', 'degli', 'de', 'd', 'da', 'la', 'il', 'lo', 'le', 'i', 'gli', 'l', 'a', 'al', 'alla', 'ai', 'alle', 'allo',
  'in', 'su', 'sul', 'sulla', 'per', 'fermata', 'pontile', 'stazione', 'piazza', 'campo', 'fondamenta', 'riva']);
// forme dette a voce -> chiave dei dati (dopo normalizza)
const ALIAS_TESTO = [
  [/\bp\.?\s?le\b/g, ' piazzale '], [/\bs\.?\s?m\.?\s?e\b/g, ' santa maria elisabetta '], [/\bf\.?te\b/g, ' fondamente '], [/\bfondamente\b/g, ' fondamente '],
  [/\bpiazza le\b/g, ' piazzale '], [/\bspirito santo\b/g, ' spirito santo ']
];
// una chiave per confrontare nomi: minuscolo, senza accenti né punteggiatura, santi e articoli tolti
function normalizza(s) {
  let t = senzaAccenti(s).toLowerCase().replace(/[’']/g, ' ').replace(/["“”]/g, ' ');
  for (const [re, to] of ALIAS_TESTO) t = t.replace(re, to);
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();
  const tok = t.split(' ').filter(x => x && !SANTI.has(x));
  const util = tok.filter(x => !VUOTE.has(x));
  return (util.length ? util : tok).join(' ');
}
const base = nome => P.dividiPontile(nome).base;

// luoghi che si dicono in un modo e nei dati si chiamano in un altro (chiavi già normalizzate): { nome parlato, chiavi dei dati }
const LUOGHI_SPECIALI = {
  'marco': { nome: 'San Marco', chiavi: ['marco vallaresso', 'marco zaccaria', 'marco giardinetti'], src: 'nav' },
  'marco zaccaria': { nome: 'San Marco, San Zaccaria', chiavi: ['marco zaccaria'], src: 'nav' },
  'zaccaria': { nome: 'San Zaccaria', chiavi: ['marco zaccaria'], src: 'nav' },
  'lido': { nome: 'Lido', chiavi: ['lido maria elisabetta'], src: 'nav' },
  'ferrovia': { nome: 'Ferrovia, Santa Lucia', chiavi: ['ferrovia'], src: 'nav' },
  'lucia': { nome: 'Ferrovia, Santa Lucia', chiavi: ['ferrovia'], src: 'nav' },
  'venezia lucia': { nome: 'Ferrovia, Santa Lucia', chiavi: ['ferrovia'], src: 'nav' },
  'treni': { nome: 'Ferrovia, Santa Lucia', chiavi: ['ferrovia'], src: 'nav' },
  'stazione': { nome: 'Ferrovia, Santa Lucia', chiavi: ['ferrovia'], src: 'nav' },
  'mestre': { nome: 'Mestre stazione', chiavi: [], prefissi: ['mestre fs'], src: 'aut' },
  'mestre fs': { nome: 'Mestre stazione', chiavi: [], prefissi: ['mestre fs'], src: 'aut' },
  'biennale': { nome: 'Giardini Biennale', chiavi: ['giardini biennale'], src: 'nav' },
  'ca oro': { nome: "Ca' d'Oro", chiavi: ['ca oro'], src: 'nav' },
  'maria elisabetta': { nome: 'Lido', chiavi: ['lido maria elisabetta'], src: 'nav' },
  'roma': { nome: 'Piazzale Roma', chiavi: ['piazzale roma'] },
  'arsenale': { nome: 'Arsenale', chiavi: ['arsenale'], src: 'nav' },
  // «Venezia» detto come direzione (da Mestre, dal Lido, dalle isole): il centro storico, cioè le fermate principali dove arrivano tram, autobus e vaporetti
  'venezia': { nome: 'Venezia', chiavi: ['piazzale roma', 'venezia', 'ferrovia', 'marco zaccaria', 'marco vallaresso', 'rialto', 'fondamente nove', 'zattere', 'tronchetto'] }
};
// Levenshtein sulle stringhe corte: tollera errori di riconoscimento vocale («zatere», «rialtto»)
function distanza(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const simil = (a, b) => (a === b ? 1 : 1 - distanza(a, b) / Math.max(a.length, b.length, 1));

const R = 6371000, rad = x => x * Math.PI / 180;
const metri = (a, b) => { const k = Math.cos(rad((a[0] + b[0]) / 2)); return Math.hypot(rad(a[0] - b[0]) * R, rad(a[1] - b[1]) * R * k); };

// Indice: stops = [[id, nome, lat, lon, src], …] (formato di /api/stops); routes = { 'src:id': { name, color, src } }
function crea(stops, routes = {}) {
  const gruppi = new Map(), perId = new Map();
  for (const [id, nome, lat, lon, src] of stops) {
    const k = normalizza(base(nome)); if (!k) continue;
    let g = gruppi.get(k);
    if (!g) gruppi.set(k, g = { chiave: k, nomi: new Map(), ids: [], pos: [], srcs: new Set() });
    g.ids.push(id); g.pos.push([lat, lon]); g.srcs.add(src);
    const b = base(nome), peso = src === 'nav' ? 1000 : 0; g.nomi.set(b, (g.nomi.get(b) || 0) + 1 + peso);
    perId.set(id, { id, nome, src, lat, lon, chiave: k, pontile: P.dividiPontile(nome).pontile });
  }
  for (const g of gruppi.values()) {
    g.nome = [...g.nomi.entries()].sort((a, b) => b[1] - a[1])[0][0];
    g.parlato = P.nomeParlato(g.nome);
    g.centro = [g.pos.reduce((s, p) => s + p[0], 0) / g.pos.length, g.pos.reduce((s, p) => s + p[1], 0) / g.pos.length];
  }
  const elenco = [...gruppi.values()];

  // gruppo «virtuale» per i luoghi speciali (San Marco = più pontili con nomi diversi)
  function speciale(k, mezzo) {
    const sp = LUOGHI_SPECIALI[k]; if (!sp) return null;
    const gs = [...sp.chiavi.map(c => gruppi.get(c)).filter(Boolean), ...(sp.prefissi || []).flatMap(p => elenco.filter(g => g.chiave.startsWith(p)))]; if (!gs.length) return null;
    if (mezzo && sp.src && sp.src !== mezzo) return null;
    const ids = gs.flatMap(g => g.ids), pos = gs.flatMap(g => g.pos);
    return { chiave: k, nome: sp.nome, parlato: sp.nome, ids, pos, srcs: new Set(gs.flatMap(g => [...g.srcs])), centro: [pos.reduce((s, p) => s + p[0], 0) / pos.length, pos.reduce((s, p) => s + p[1], 0) / pos.length], punteggio: 1 };
  }

  // cerca(testo, { mezzo: 'nav'|'aut' }) -> { ok: gruppo } | { ambiguo: [gruppi] } | { nessuno: true }
  function cerca(testo, { mezzo = null } = {}) {
    const k = normalizza(testo); if (!k) return { nessuno: true };
    const sp = speciale(k, mezzo); if (sp) return { ok: sp };
    const qt = k.split(' '), cand = [];
    for (const g of elenco) {
      if (mezzo && !g.srcs.has(mezzo)) continue;
      let s;
      if (g.chiave === k) s = 1;
      else {
        const nt = g.chiave.split(' ');
        const dentro = qt.every(t => nt.some(x => x === t || (t.length > 3 && simil(t, x) >= 0.85)));
        const dentro2 = nt.every(t => qt.some(x => x === t || (t.length > 3 && simil(t, x) >= 0.85)));
        if (dentro) s = 0.55 + 0.35 * qt.length / nt.length;
        else if (dentro2) s = 0.5 + 0.3 * nt.length / qt.length;
        else s = simil(k, g.chiave) >= 0.8 ? 0.75 * simil(k, g.chiave) : 0;
      }
      if (s > 0) cand.push({ g, s: s + (g.srcs.has('nav') ? 0.001 : 0) });
    }
    cand.sort((a, b) => b.s - a.s);
    if (!cand.length || cand[0].s < 0.55) return { nessuno: true };
    if (cand[0].s >= 0.99) return { ok: { ...cand[0].g, punteggio: cand[0].s } };
    const vicini = cand.filter(c => c.s >= cand[0].s - 0.08);
    // un solo vincitore netto, oppure poche varianti dello stesso luogo
    if (vicini.length === 1) return { ok: { ...cand[0].g, punteggio: cand[0].s } };
    return { ambiguo: vicini.slice(0, 4).map(c => c.g) };
  }
  // fermata con id preciso (da entity resolution o da un contesto di sessione)
  const stopPerId = id => perId.get(id) || null;
  // gruppo per chiave già nota (sessione)
  const gruppoPerChiave = k => speciale(k, null) || gruppi.get(k) || null;
  // gruppo di un id fermata
  const gruppoDiId = id => { const s = perId.get(id); return s ? gruppi.get(s.chiave) || null : null; };
  // fermate di un gruppo, eventualmente solo di un servizio; al massimo n
  const idsDi = (g, mezzo = null, n = 24) => g.ids.filter(id => !mezzo || id.startsWith(mezzo + ':')).slice(0, n);
  // fermate con distanza dal centro del gruppo (m, linea d'aria) nel formato del pianificatore: «src:id~metri»
  const paramPercorso = (g, mezzo = null, n = 16) => {
    const v = g.ids.map((id, i) => ({ id, m: Math.round(metri(g.centro, g.pos[i])) })).filter(x => !mezzo || x.id.startsWith(mezzo + ':')).sort((a, b) => a.m - b.m).slice(0, n);
    return v.map(x => `${x.id}~${Math.min(x.m, 2000)}`).join(',');
  };
  return { cerca, stopPerId, gruppoPerChiave, gruppoDiId, idsDi, paramPercorso, gruppi: elenco, nStop: stops.length };
}

// ---- linee ----
const PAROLE_NUM = (() => { const m = new Map(); for (let i = 0; i <= 99; i++) m.set(P.parole(i), String(i)); m.set('un', '1'); m.set('uno', '1'); return m; })();
const LETTERE_PAROLE = { enne: 'N', notturno: 'N', ti: 'T', tram: 'T', elle: 'L', effe: 'F', acca: 'H', esse: 'S', erre: 'R', emme: 'M', di: 'D', pi: 'P', bi: 'B', ci: 'C', gi: 'G', vu: 'V', zeta: 'Z' };
// «quattro punto uno» -> «4.1»; «t uno» -> «T1»; «cinque e due» -> «5.2»; «dodici e» -> «12E»; «2 barrato» -> «2/»; «enne» -> «N»
function parseLinea(testo) {
  let t = senzaAccenti(testo).toLowerCase().replace(/[’']/g, ' ').replace(/\b(linea|il|lo|la|numero|n\.|autobus|bus|vaporetto|battello|tram)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const tok = t.split(/[\s]+/).map(x => PAROLE_NUM.has(x) ? PAROLE_NUM.get(x) : x);
  let s = tok.join(' ').replace(/\s*(punto|virgola)\s*/g, '.').replace(/(\d)\s+e\s+(\d)/g, '$1.$2').replace(/\s*barrato\s*/g, '/');
  s = s.split(' ').map(x => LETTERE_PAROLE[x] || x).join(' ');
  s = s.replace(/(\d)\s+e\b/, '$1E').replace(/\b([a-z])\s+(\d)/gi, '$1$2').replace(/(\d)\s+(\d)/g, '$1.$2').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9./]{1,6}$/.test(s) ? s : null;
}
// nome di una linea senza varianti («2/» -> «2»), per confrontare con ciò che si è detto
const lineaBase = n => String(n ?? '').toUpperCase().replace(/\/+$/, '').replace(/\s+/g, '');
const stessaLinea = (a, b) => lineaBase(a) === lineaBase(b);
// colore e servizi di una linea
function infoLinea(routes, nome) {
  const out = [];
  for (const [id, r] of Object.entries(routes || {})) if (stessaLinea(r.name, nome)) out.push({ id, src: r.src, color: r.color, name: r.name, type: r.type ?? null });
  return out;
}

module.exports = { crea, normalizza, parseLinea, lineaBase, stessaLinea, infoLinea, metri, simil, LUOGHI_SPECIALI, senzaAccenti };
