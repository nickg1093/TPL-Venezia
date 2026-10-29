// AVVISI DI INFOMOBILITÀ — raccolta automatica da due fonti pubbliche e collegamento a linee e fermate.
//   1) ACTV, notizie del sito ufficiale:  https://actv.avmspa.it/it/rss-news.xml  (RSS; per ogni notizia nuova si legge anche la pagina, dove stanno linee, fermate e periodi)
//   2) Canale Telegram ufficiale «AVM/Actv Venezia»:  https://t.me/s/muoversivenezia  (anteprima web pubblica, non serve né l'app né un account)
// Per ogni avviso si ricavano: validità (da/a), linee citate (solo quelle che esistono nel GTFS) e fermate citate (per nome, solo corrispondenze esatte).
// Tutto è automatico: aggiornamento periodico, un errore di rete non cancella l'ultimo elenco, nessun avviso scaduto resta in elenco.
// SICUREZZA: si scaricano solo i due siti sopra (HTTPS, timeout, dimensione massima); il testo viene ripulito dal codice HTML e il client lo mostra come testo semplice;
// i link usciti da qui sono sempre dei domini ACTV/Telegram.
const crypto = require('crypto');
const cal = require('./calendar');

const SRC = {
  rss: 'https://actv.avmspa.it/it/rss-news.xml',
  tg: 'https://t.me/s/muoversivenezia', tgBase: 'https://t.me/muoversivenezia/',
};
const OK_HOSTS = new Set(['actv.avmspa.it', 'avm.avmspa.it', 't.me', 'telegram.me']);
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'it-IT,it;q=0.9' };
const MAX_BYTES = 2e6, DAY = 864e5;
const RSS_EVERY = 10 * 60e3, TG_EVERY = 5 * 60e3, STALE_AFTER = 45 * 60e3;
const UNDATED_TG_MS = 6 * 3600e3, UNDATED_RSS_MS = 3 * DAY, OPEN_ENDED_MS = 7 * DAY, KEEP_EXPIRED_MS = 0;
const UPCOMING_MS = 3 * DAY;     // avvisi che iniziano entro 3 giorni sono "in arrivo"

// ---------------------------------------------------------------------------------------------------------------------
// TESTO
// ---------------------------------------------------------------------------------------------------------------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', egrave: 'è', eacute: 'é', agrave: 'à', ograve: 'ò', ugrave: 'ù', igrave: 'ì', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', deg: '°' };
const decode = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
  return ENT[e.toLowerCase()] ?? m;
});
// HTML -> testo semplice (a capo per <br> e paragrafi); niente tag, niente script
function toText(html) {
  const strip = h => decode(String(h)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<[^>]*>/g, ' '));
  let t = strip(html); for (let i = 0; i < 2 && /<\/?[a-z][^>]*>/i.test(t); i++) t = strip(t);   // testi codificati due volte (&lt;img…&gt;)
  return t.replace(/\bLingua\s+Undefined\b/gi, ' ')
    .replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const noAccents = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = s => noAccents(String(s).toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();

// link ammessi: https verso i soli domini ACTV / Telegram
function safeUrl(u) {
  try { const x = new URL(String(u).trim()); return x.protocol === 'https:' && OK_HOSTS.has(x.hostname) ? x.href : null; } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------------
// VALIDITÀ: date in italiano nel testo ("sabato 31 ottobre 2026 dalle 9.30 alle 16.30", "dal 28 ottobre al 3 novembre", "da lunedì 2 novembre", "1-2 novembre")
// ---------------------------------------------------------------------------------------------------------------------
const MONTHS = { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12 };
const MON_RE = '(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)';
// mezzanotte (ora di Venezia) di una data, in ms UTC: si prova con +1 e +2 ore di scarto (ora solare / legale) e si controlla con calendar.romeParts
function romeMs(y, m, d, secs = 0) {
  const ymd = `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  for (const off of [1, 2]) {
    const ms = Date.UTC(y, m - 1, d) + secs * 1000 - off * 3600e3, p = cal.romeParts(ms);
    if (p.ymd === ymd && p.secs === secs % 86400) return ms;
  }
  return Date.UTC(y, m - 1, d) + secs * 1000 - 3600e3;
}
const secsOf = (h, m) => (+h * 3600 + +m * 60);

function findDates(text, pubMs) {
  const t = noAccents(text.toLowerCase()), out = [], pubY = +cal.romeYmd(pubMs).slice(0, 4);
  const push = (d, mon, y, idx) => {
    const m = MONTHS[mon.slice(0, 3)]; d = +d; if (!m || d < 1 || d > 31) return;
    let yy = y ? +y : pubY;
    if (!y && romeMs(yy, m, d) < pubMs - 90 * DAY) yy++;           // senza anno: la prima occorrenza nel futuro prossimo
    out.push({ y: yy, m, d, idx });
  };
  // intervalli compatti "1-2 novembre [2026]" / "1 e 2 novembre"
  const used = [];
  for (const r of t.matchAll(new RegExp(`(\\d{1,2})\\s*(?:-|–|—|e|al)\\s*(\\d{1,2})\\s+${MON_RE}(?:\\s+(\\d{4}))?`, 'g'))) {
    push(r[1], r[3], r[4], r.index); push(r[2], r[3], r[4], r.index + 1); used.push([r.index, r.index + r[0].length]);
  }
  for (const r of t.matchAll(new RegExp(`(\\d{1,2})\\s*(?:°|º)?\\s+${MON_RE}(?:\\s+(\\d{4}))?`, 'g'))) {
    if (used.some(([a, b]) => r.index >= a && r.index < b)) continue;
    push(r[1], r[2], r[3], r.index);
  }
  return out.sort((a, b) => a.idx - b.idx);
}

// -> { from, to, open, dated } in ms. Senza date: dalla pubblicazione, con durata breve (Telegram) o media (sito).
function parseValidity(text, pubMs, kind = 'rss') {
  const dates = findDates(text, pubMs), t = noAccents(text.toLowerCase());
  // orari: una sola fascia "dalle 9.30 alle 16.30" vale per il periodo; più fasce (es. sciopero con servizi garantiti) -> giornata intera
  const tms = [...t.matchAll(/dalle?\s+(?:ore\s+)?(\d{1,2})[.:](\d{2})\s+(?:alle?|fino\s+alle?)\s+(?:ore\s+)?(\d{1,2})[.:](\d{2})/g)];
  const times = (t.match(/\b\d{1,2}[.:]\d{2}\b/g) || []).length;
  const one = tms.length === 1 && times <= 2 ? tms[0] : null;
  const t0 = one ? secsOf(one[1], one[2]) : 0, t1 = one ? secsOf(one[3], one[4]) : 86399;
  if (!dates.length) {
    const len = kind === 'tg' ? UNDATED_TG_MS : UNDATED_RSS_MS;
    return { from: pubMs, to: pubMs + len, open: false, dated: false };
  }
  const key = d => d.y * 10000 + d.m * 100 + d.d, sorted = dates.slice().sort((a, b) => key(a) - key(b));
  const first = sorted[0], last = sorted[sorted.length - 1];
  const upTo = /\b(fino al|sino al|fino a|entro il)\b/.test(t) && dates.length === 1;
  const D = '\\d{1,2}\\s*(?:°|º)?\\s+' + MON_RE;
  const fromDate = new RegExp('\\b(?:dal|da|a partire dal|a partire da|a decorrere dal)\\s+(?:inizio\\s+servizi\\s+di\\s+|inizio\\s+servizio\\s+di\\s+)?(?:[a-z]+\\s+)?' + D).test(t);
  const toDate = new RegExp('\\b(?:al|fino al|sino al|entro il)\\s+(?:[a-z]+\\s+)?' + D + '|\\b\\d{1,2}\\s*(?:-|–|—)\\s*\\d{1,2}\\s+' + MON_RE).test(t);
  if (upTo) return { from: pubMs, to: romeMs(last.y, last.m, last.d, t1), open: false, dated: true };
  if (fromDate && !toDate) {                                   // "dal 1 novembre", "da inizio servizi di lunedì 2 novembre": senza fine, vale a lungo
    const from = romeMs(first.y, first.m, first.d, t0);
    return { from, to: Math.max(from, romeMs(last.y, last.m, last.d, 0)) + OPEN_ENDED_MS, open: true, dated: true };
  }
  return { from: romeMs(first.y, first.m, first.d, t0), to: romeMs(last.y, last.m, last.d, t1), open: false, dated: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// LINEE E FERMATE CITATE
// ---------------------------------------------------------------------------------------------------------------------
// Le regole sono generali, non per singolo avviso: vedi i commenti di analyze(). Prima di cercare le linee si tolgono date e orari ("31 ottobre", "9.30"), che sembrerebbero linee.
const LIST_TOK = '[A-Z0-9][A-Z0-9./]{0,5}';
const LIST_RE = new RegExp(`^[:'‘’]?\\s*(${LIST_TOK}(?:\\s*(?:,|/|e|-|–)\\s*${LIST_TOK})*)`);
// parole che indicano il tipo di servizio (usate solo per scegliere tra due linee con lo stesso numero, e come indizio per le fermate)
const AUT_WORDS = /\b(bus|autobus|automobilistic\w*|tranvia\w*|tram|mestre|marghera|favaro|chirignago|terraferma|extraurban\w*|urban[oa]|rotatoria|deviazion\w*|capolinea)\b/gi;
const NAV_WORDS = /\b(pontil\w*|imbarcader\w*|vaporett\w*|battell\w*|navigazione|lagun\w*|motonav\w*|lido|giudecca|murano|burano|pellestrina|torcello|san michele|cimitero di s\.?)\b/gi;
const count = (re, t) => (t.match(re) || []).length;

// Fermate citate in qualunque punto del testo: sequenze di 1-5 parole che iniziano con la maiuscola e coincidono con il nome di una fermata del GTFS.
// byName contiene il nome completo ("Riva de Biasio "A"") e il nome senza lettera di pontile ("Riva de Biasio"): senza lettera valgono tutti i pontili omonimi.
// Ritorna Map(nome normalizzato -> { ids, strong }): "strong" = nome sicuro (più parole, tra virgolette, dopo "fermata/pontile/capolinea", o in un percorso "A – B – C").
const STREET = /(?:\b(?:via|viale|v\.le|piazza|p\.za|piazzale|p\.le|corso|largo|calle|strada|ponte|rio|riva|campo|fondamenta|salizada)\s+)$/i;   // "via Torino", "rio Terà": una strada, non la fermata omonima
const CUE = /(?:fermat\w*|pontil\w*|capolinea|capilinea|stazione|[“«"'‘])\s*(?:di\s+|del\s+|della\s+|dello\s+|dei\s+|a\s+)?$/i;
function stopMentions(text, byName) {
  const found = new Map(), hits = []; if (!byName?.size) return found;
  const toks = [...text.matchAll(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9.'’]*/g)].map(m => ({ w: m[0], at: m.index, end: m.index + m[0].length }));
  for (let i = 0; i < toks.length;) {
    let hit = null;
    if (/^[A-ZÀ-Ý]/.test(toks[i].w)) for (let n = Math.min(5, toks.length - i); n >= 1; n--) {
      const k = norm(toks.slice(i, i + n).map(t => t.w).join(' ')); if (k.length < 4) continue;
      if (byName.has(k)) { hit = { k, n }; break; }
    }
    if (hit) {
      const first = toks[i], last = toks[i + hit.n - 1], before = text.slice(Math.max(0, first.at - 40), first.at);
      if (hit.n === 1 && STREET.test(before)) { i++; continue; }
      hits.push({ k: hit.k, n: hit.n, at: first.at, end: last.end, cue: CUE.test(before) }); i += hit.n;
    } else i++;
  }
  // un nome di una sola parola ("Crea", "Lido") è un luogo, non una fermata, a meno che sia introdotto da un indizio o stia in un percorso "Ferrovia – Riva de Biasio – Guglie"
  hits.forEach((h, j) => {
    const linked = (x, y) => x && y && /^\s*(?:[–—→>-]|,)\s*$/.test(text.slice(x.end, y.at));
    h.strong = h.n > 1 || h.cue || linked(h, hits[j + 1]) || linked(hits[j - 1], h);
    const prev = found.get(h.k); found.set(h.k, { ids: byName.get(h.k), strong: h.strong || !!prev?.strong });
  });
  return found;
}

// Analisi completa del testo di un avviso: linee (con servizio corretto), fermate (con nome e servizio). Sciopero: nessuna linea né fermata.
// Regole generali (valgono per qualunque avviso):
//  · una linea è tale solo se segue "linea/linee/navetta" ed esiste nel GTFS; una lettera sola ("A") solo in prima posizione e non seguita da una parola minuscola ("A partire dalle…");
//  · se il numero esiste in entrambi i servizi, si sceglie dalle fermate citate che la linea serve davvero; senza prove, nessuna delle due;
//  · se le fermate sicure del testo sono tutte di un servizio, una linea dell'altro servizio che non ne serve nessuna viene scartata;
//  · con linee nell'avviso restano solo le fermate (id) realmente servite da quelle linee.
function analyze(title, text, ctx) {
  const r = analyzeBase(title, text, ctx); return withWater(r, title + '\n' + text, ctx);
}
function analyzeBase(title, text, ctx) {
  const full = title + '\n' + text, empty = { lines: [], stops: [], stopNames: [] };
  if (/sciopero/i.test(title) || /^\s*[^\n]{0,80}\bsciopero\b/i.test(text)) return empty;
  const known = ctx.known, mentions = stopMentions(full, ctx.byName), strongIds = new Set(), mSrc = new Set();
  for (const v of mentions.values()) if (v.strong) for (const id of v.ids) { strongIds.add(id); mSrc.add(id.split(':')[0]); }
  const gAut = count(AUT_WORDS, full), gNav = count(NAV_WORDS, full);
  const served = x => ctx.lineStops?.get(x.s + ':' + String(x.n).toUpperCase());
  const hits = x => { const sv = served(x); let n = 0; if (sv) for (const id of strongIds) if (sv.has(id)) n++; return n; };
  const lines = new Map();
  const clean = full.replace(new RegExp(`\\d{1,2}\\s*(?:-|–|e)?\\s*\\d{0,2}\\s+${MON_RE}(?:\\s+\\d{4})?`, 'gi'), ' ').replace(/\b\d{1,2}[.:]\d{2}\b/g, ' ')
    .replace(/[“"]\s*[A-Z]\s*[”"]/g, ' ');                      // "B", "D" tra virgolette doppie = lettera del pontile, non una linea
  const decide = (tok, around) => {
    const c = known?.get(tok.replace(/[./]+$/, '').toUpperCase()); if (!c) return;
    let pick = c;
    if (c.length > 1) {
      const la = count(AUT_WORDS, around), ln = count(NAV_WORDS, around);
      const sc = c.map(x => hits(x) * 4 + (mSrc.size === 1 && mSrc.has(x.s) ? 3 : 0) + (x.s === 'aut' ? 2 * la + gAut : 2 * ln + gNav));
      const best = Math.max(...sc), top = c.filter((_, i) => sc[i] === best);
      pick = top.length === 1 && best > 0 ? top : [];   // numero ambiguo senza prove: meglio non indicare la linea che indicarne una sbagliata
    }
    for (const x of pick) {
      if (mSrc.size === 1 && !mSrc.has(x.s) && served(x) && !hits(x)) continue;   // altro servizio, e nessuna delle fermate citate è sua
      lines.set(x.s + ':' + x.n, { n: x.n, s: x.s, c: x.c || null });
    }
  };
  // linee: solo elenchi che seguono "linea/linee/navetta" ("linee 9S, 21 e 56E")
  for (const m of clean.matchAll(/\b(?:linee|linea|navetta|navette)\b\s*/gi)) {
    const rest = clean.slice(m.index + m[0].length), l = LIST_RE.exec(rest); if (!l) continue;
    const around = clean.slice(Math.max(0, m.index - 150), m.index + 250), after = rest.slice(l[0].length);
    l[1].split(/\s*(?:,|\/|e|-|–)\s*/).forEach((tok, j) => {
      if (tok !== tok.toUpperCase()) return;
      if (/^[A-Z]$/.test(tok) && (j > 0 || /^\s*[a-zà-ÿ]/.test(after))) return;   // "linea 13 e A partire…": non è la linea A
      decide(tok, around);
    });
  }
  const lead = /^\s*(?:linea\s+)?([A-Z0-9][A-Z0-9.]{0,5})\s*[:–-]/.exec(text); if (lead && !/^[A-Z]$/.test(lead[1])) decide(lead[1], full.slice(0, 400));
  const lineList = [...lines.values()].slice(0, 20), srcs = new Set(lineList.map(l => l.s));
  // fermate: con linee nell'avviso, solo le fermate (id) servite da almeno una di quelle linee; senza linee, solo nomi sicuri del servizio indicato dal testo
  let want = null; if (!srcs.size) { if (gNav >= gAut + 2) want = new Set(['nav']); else if (gAut >= gNav + 2) want = new Set(['aut']); }
  const ids = [], names = new Map();
  for (const [k, v] of mentions) for (const id of v.ids) {
    const src = id.split(':')[0];
    if (srcs.size) {
      if (!lineList.some(l => l.s === src && (served(l)?.has(id) ?? true))) continue;
    } else if (!v.strong || (want && !want.has(src))) continue;
    const nm = ctx.nameOf ? ctx.nameOf(id) : k; ids.push(id); names.set(src + '|' + nm, { n: nm, s: src });
  }
  // avvisi generali sugli orari (centinaia di fermate citate di passaggio): niente segnalazione sulle fermate
  const general = /\borari\b|modifiche ai? serviz/i.test(title) || names.size > 30;
  return { lines: lineList, stops: general ? [] : ids.slice(0, 80), stopNames: general ? [] : [...names.values()].slice(0, 30) };
}


// ---------------------------------------------------------------------------------------------------------------------
// ACQUA ALTA — piano ACTV «Acqua alta: servizi di navigazione previsti» (https://actv.avmspa.it/it/content/acqua-alta-servizi-di-navigazione-previsti)
// Quando un avviso (sito o Telegram) parla di acqua alta con un livello previsto, si applicano le disposizioni della pagina ACTV per quel livello:
// i limiti valgono "oltre" la soglia e sono cumulativi. Le linee e i pontili sono quelli del GTFS di navigazione; il testo dell'avviso ufficiale resta sempre prevalente.
// ---------------------------------------------------------------------------------------------------------------------
const AA_URL = 'https://actv.avmspa.it/it/content/acqua-alta-servizi-di-navigazione-previsti';
const AA_RE = /acqua\s+alta|alta\s+marea|picco\s+di\s+marea|\bmarea\b/i;
// livello previsto (cm): "+120", "110 cm", "tra 100 e 120 cm" -> il massimo. Si ignorano le soglie ("oltre 85 cm", "sopra i 110", ">100") e valori fuori scala.
function waterLevel(text) {
  const t = String(text), vals = [];
  for (const m of t.matchAll(/(?:\+\s*(\d{2,3})\b|\b(\d{2,3})\s*(?:cm|centimetri)\b)/gi)) {
    const v = +(m[1] || m[2]), before = t.slice(Math.max(0, m.index - 22), m.index).toLowerCase();
    if (/(oltre|sopra|superiore\s+a|superiori\s+a|soglia|>|almeno|da)\s*(?:i|a|di|ai|ad)?\s*$/.test(before) && !/\+/.test(m[0])) continue;
    if (v >= 80 && v <= 200) vals.push(v);
  }
  return vals.length ? Math.max(...vals) : null;
}
// disposizioni cumulative per soglia. lines: numeri di linea di navigazione; stops: [espressione sul nome normalizzato]; txt: riga mostrata
const AA_RULES = [
  { over: 85, stops: [/^s marcuola casino b$/], txt: 'S. Marcuola (direzione Rialto / S. Marco): fermata sospesa.' },
  { over: 95, lines: ['2', '3', '4.1', '4.2', '5.1', '5.2', '6'], stops: [/^ferrovia c$/, /^ferrovia d$/],
    txt: 'Linea 2 limitata a S. Zaccaria "B" – Tronchetto e S. Marco Giardinetti – P.le Roma (spola fino a +135 cm); linea 3 sospesa; 4.1 da Fondamente Nove a Tre Archi; 4.2 da Fondamente Nove a S. Zaccaria; 5.1 limitata a Lido S.M.E. "A" – Ospedale – Fondamente Nove – Tre Archi; 5.2 e 6 deviate via Canal Grande tra P.le Roma "D" e Lido S.M.E. "B" (a Ferrovia fermano a "C" verso P.le Roma e a "D" verso Lido). Le altre linee sono regolari. Di notte (20–7) sospesi gli approdi Murano Colonna "A" e "B".' },
  { over: 120, stops: [/^zattere b$/], txt: 'Zattere (direzione S. Marco – Lido): fermata sospesa.' },
  { over: 125, stops: [/^rialto c$/, /^rialto d$/], txt: 'Rialto "C" e "D" (linea 2): passerelle non più agibili.' },
  { over: 135, stops: [/^murano colonna [abc]$/, /^murano venier$/], txt: 'Murano: stop al transito sotto il ponte Vivarini; linee 4.1 e 4.2 sospese tra Colonna e Venier.' },
  { over: 140, allNav: true, txt: 'Servizio di linea sospeso: restano solo collegamenti con le isole dagli impianti ancora accessibili.' },
];
function waterPlan(full, ctx) {
  if (!AA_RE.test(full)) return null;
  const level = waterLevel(full); if (level == null) return null;
  return planForLevel(level, ctx);
}
function planForLevel(level, ctx) {
  if (!(level > 85)) return null;
  const lines = new Map(), ids = [], names = new Map(), plan = [];
  for (const r of AA_RULES) {
    if (level <= r.over) continue;
    plan.push(r.txt);
    for (const n of r.lines || []) for (const x of ctx.known?.get(n.toUpperCase()) || []) if (x.s === 'nav') lines.set('nav:' + x.n, { n: x.n, s: 'nav', c: x.c || null });
    if (r.allNav) for (const l of ctx.known?.values() || []) for (const x of l) if (x.s === 'nav') lines.set('nav:' + x.n, { n: x.n, s: 'nav', c: x.c || null });
    for (const re of r.stops || []) for (const [k, list] of ctx.byName || []) if (re.test(k)) for (const id of list) {
      if (!id.startsWith('nav:') || ids.includes(id)) continue;
      const nm = ctx.nameOf ? ctx.nameOf(id) : k; ids.push(id); names.set('nav|' + nm, { n: nm, s: 'nav' });
    }
  }
  return { level, lines: [...lines.values()], stops: ids, stopNames: [...names.values()], plan, planUrl: AA_URL };
}
// AVVISO AUTOMATICO dal livello di marea (misurato ora o previsto nelle prossime 12 ore): serve quando ACTV non pubblica nulla.
// Ha la precedenza ogni comunicazione ufficiale con un piano acqua alta (sito ACTV o Telegram): in quel caso l'automatico sparisce e l'avviso ufficiale riporta il livello misurato come conferma.
let tideSource = () => null;
function setTideSource(fn) { tideSource = fn; ST.cache = null; }
const hhmm = ms => { const p = cal.romeParts(ms), s = p.secs; return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0'); };
function autoWater(now, ctx, official) {
  let snap = null; try { snap = tideSource(); } catch { /* dato non disponibile */ }
  if (!snap) return { measured: null, item: null };
  const measured = snap.stale ? null : snap.cm, peak = snap.peak && snap.peak.cm > 85 ? snap.peak : null;
  const level = Math.max(measured ?? -999, peak ? peak.cm : -999), plan = planForLevel(level, ctx);
  if (!plan || official) return { measured, item: null };
  const nowHigh = measured != null && measured > 85, from = nowHigh ? now - 60e3 : Math.max(now - 60e3, peak.ts - 2 * 3600e3);
  const parts = [measured != null ? `Livello misurato ${measured} cm` : null, peak ? `picco previsto ${peak.cm} cm alle ${hhmm(peak.ts)}` : null].filter(Boolean).join(', ');
  return { measured, item: { id: 'auto-acqua-alta', source: 'auto', title: `Acqua alta: marea oltre 85 cm (${level} cm)`, text: `${parts}. Nessun avviso ufficiale rilevato: sono indicate le disposizioni del piano ACTV per questo livello. Fa fede la comunicazione ufficiale.`,
    url: AA_URL, published: now, from, to: nowHigh ? now + 20 * 60e3 : peak.ts + 2 * 3600e3, open: false, dated: false,
    lines: plan.lines, stops: plan.stops, stopNames: plan.stopNames, water: { level, plan: plan.plan, url: AA_URL, measured } } };
}
// unisce il piano acqua alta al risultato di analyze()
function withWater(res, full, ctx) {
  const w = waterPlan(full, ctx); if (!w) return res;
  const lines = new Map(res.lines.map(l => [l.s + ':' + l.n, l]));
  for (const l of w.lines) if (!lines.has(l.s + ':' + l.n)) lines.set(l.s + ':' + l.n, l);
  const names = new Map(res.stopNames.map(s => [s.s + '|' + s.n, s])); for (const s of w.stopNames) names.set(s.s + '|' + s.n, s);
  return { lines: [...lines.values()].slice(0, 40), stops: [...new Set([...res.stops, ...w.stops])].slice(0, 100), stopNames: [...names.values()].slice(0, 40),
    water: { level: w.level, plan: w.plan, url: w.planUrl } };
}

// ---------------------------------------------------------------------------------------------------------------------
// LETTURA DELLE FONTI
// ---------------------------------------------------------------------------------------------------------------------
const why = e => { const c = e && e.cause, d = c && (c.code || c.message); return (e && e.name === 'TimeoutError' ? 'timeout' : (e && e.message) || 'errore') + (d ? ` (${d})` : ''); };
async function fetchOnce(url, ms) {
  const u = new URL(url); if (u.protocol !== 'https:' || !OK_HOSTS.has(u.hostname)) throw new Error('dominio non ammesso');
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(ms), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const fin = res.url ? new URL(res.url) : u; if (!OK_HOSTS.has(fin.hostname)) throw new Error('reindirizzamento non ammesso');
  const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > MAX_BYTES) throw new Error('risposta troppo grande');
  return buf.toString('utf8');
}
// più indirizzi alternativi (stesso contenuto), timeout generoso (il piano gratuito di Render e il sito ACTV possono essere lenti) e un secondo tentativo
async function fetchText(url, alts = [], ms = 25000) {
  let last;
  for (const [i, x] of [url, ...alts].entries()) {
    for (let t = 0; t < (i === 0 ? 2 : 1); t++) {
      try { return await fetchOnce(x, ms); } catch (e) { last = new Error(`${new URL(x).hostname}: ${why(e)}`); if (/HTTP 4|non ammesso/.test(last.message)) break; }
    }
  }
  throw last;
}
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : ''; };

// RSS: [{ key, title, url, text, pubMs }]
function parseRss(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const it = m[1], title = toText(tag(it, 'title')), url = safeUrl(toText(tag(it, 'link'))), pubMs = Date.parse(tag(it, 'pubDate')), guid = toText(tag(it, 'guid'));
    if (!title || !url || !Number.isFinite(pubMs)) continue;
    out.push({ key: 'rss:' + (guid || url), title: title.slice(0, 200), url, text: toText(tag(it, 'description')).replace(/^\s*Lingua\b[^\n]*\n?/im, '').trim(), pubMs });
  }
  return out;
}
// Telegram: [{ key, id, text, links, pubMs, url }]  (struttura nota della pagina pubblica: div.tgme_widget_message[data-post], div.tgme_widget_message_text, time[datetime])
function parseTelegram(html) {
  const out = [];
  const parts = String(html).split(/(?=<div class="tgme_widget_message_wrap)/);
  for (const p of parts) {
    const post = /data-post="[^"/]+\/(\d+)"/.exec(p); if (!post) continue;
    const body = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div class="tgme_widget_message_(?:footer|reactions)|<div class="tgme_widget_message_info|<\/div>)/.exec(p) || /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(p);
    const tm = /<time[^>]*datetime="([^"]+)"/.exec(p); const pubMs = tm ? Date.parse(tm[1]) : NaN;
    if (!body || !Number.isFinite(pubMs)) continue;
    const links = [...body[1].matchAll(/href="([^"]+)"/g)].map(x => safeUrl(decode(x[1]))).filter(Boolean);
    out.push({ key: 'tg:' + post[1], id: +post[1], text: toText(body[1]), links, pubMs, url: SRC.tgBase + post[1] });
  }
  return out;
}
// Pagina di una notizia ACTV: dal primo titolo al piè di pagina, ripulita dal codice
function articleText(html) {
  let h = String(html); const i = h.search(/<h1\b/i); if (i >= 0) h = h.slice(i);
  const j = h.search(/<footer\b|id="footer"|class="footer"/i); if (j > 0) h = h.slice(0, j);
  return toText(h).slice(0, 6000);
}

// ---------------------------------------------------------------------------------------------------------------------
// STATO E CICLO DI AGGIORNAMENTO
// ---------------------------------------------------------------------------------------------------------------------
const ST = { rss: [], tg: [], pages: new Map(), rssAt: 0, tgAt: 0, rssOk: 0, tgOk: 0, errors: {}, logged: {}, ctx: () => ({ known: new Map(), byName: new Map() }) };
const idOf = key => crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);

// contesto per riconoscere linee e fermate: forniti da server.js (dipendono dai GTFS in uso)
function setContext(fn) { ST.ctx = fn; ST.cache = null; }

// una riga di log solo quando lo stato cambia (nuovo errore, errore risolto, primo caricamento)
function note(src, err, ok) {
  const prev = ST.errors[src], first = !ST.logged[src]; ST.errors[src] = err; ST.logged[src] = true;
  if (err ? err !== prev : (prev || first)) console.log(`avvisi [${src === 'rss' ? 'sito ACTV' : 'Telegram'}]: ${err ? 'errore: ' + err : 'ok, ' + ok}`);
}
async function refreshRss() {
  ST.rssAt = Date.now();
  try {
    ST.rss = parseRss(await fetchText(SRC.rss, ['https://actv.avmspa.it/it/rss-news-feed'])).slice(0, 40);
    ST.rssOk = Date.now(); note('rss', null, `${ST.rss.length} notizie`);
    let n = 0;
    for (const it of ST.rss) {                                              // pagina completa solo per le notizie nuove (max 12 a giro)
      if (ST.pages.has(it.url) || n >= 12 || Date.now() - it.pubMs > 30 * DAY) continue;
      n++; try { ST.pages.set(it.url, articleText(await fetchText(it.url, [], 12000))); } catch { /* si usa il riassunto del feed */ }
    }
    for (const k of [...ST.pages.keys()]) if (!ST.rss.some(i => i.url === k)) ST.pages.delete(k);
  } catch (e) { note('rss', e.message); }
  ST.cache = null;
}
async function refreshTg() {
  ST.tgAt = Date.now();
  try { ST.tg = parseTelegram(await fetchText(SRC.tg, ['https://telegram.me/s/muoversivenezia'])).slice(-40); ST.tgOk = Date.now(); note('tg', null, `${ST.tg.length} messaggi`); }
  catch (e) { note('tg', e.message); }
  ST.cache = null;
}

const short = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s\S*$/, '') + '…' : s; };

// Elenco finale: unisce le due fonti (un messaggio Telegram che rimanda a una notizia ACTV è la stessa cosa), calcola validità, linee, fermate
function build(now = Date.now()) {
  const ctx = ST.ctx() || {}, items = [], byUrl = new Map();
  for (const r of ST.rss) {
    const body = ST.pages.get(r.url) || r.text, full = r.title + '\n' + body, v = parseValidity(full, r.pubMs, 'rss');
    const it = { id: idOf(r.key), source: 'actv', title: r.title, text: short(body.replace(r.title, '').trim() || r.text, 700), url: r.url, published: r.pubMs, ...v,
      ...analyze(r.title, body, ctx) };
    items.push(it); byUrl.set(r.url, it);
  }
  for (const m of ST.tg) {
    const first = m.links.find(l => byUrl.has(l));
    if (first) { const it = byUrl.get(first); it.source = 'both'; it.tgUrl = m.url; continue; }   // già presente dal sito ACTV
    const lines = m.text.split('\n').filter(Boolean), title = short(lines[0] || 'Avviso', 110), v = parseValidity(m.text, m.pubMs, 'tg');
    items.push({ id: idOf(m.key), source: 'telegram', title, text: short(lines.slice(title === lines[0] ? 1 : 0).join(' ') || m.text, 700), url: m.links.find(l => /actv|avm/.test(l)) || m.url, tgUrl: m.url,
      published: m.pubMs, ...v, ...analyze(title, m.text, ctx) });
  }
  const officialWater = items.some(it => it.water && it.from <= now + UPCOMING_MS && it.to >= now);
  const aw = autoWater(now, ctx, officialWater);
  if (aw.item) items.push(aw.item);
  else if (aw.measured != null) for (const it of items) if (it.water) it.water.measured = aw.measured;     // conferma con il livello misurato
  const out = [];
  for (const it of items) {
    if (it.to < now - KEEP_EXPIRED_MS) continue;                            // scaduto
    const state = it.from <= now ? 'active' : it.from - now <= UPCOMING_MS ? 'upcoming' : null;
    if (!state) continue;                                                   // troppo lontano nel tempo
    out.push({ ...it, state });
  }
  out.sort((a, b) => (a.state === b.state ? 0 : a.state === 'active' ? -1 : 1) || b.published - a.published);
  return out.slice(0, 40);
}

function getAvvisi() {
  const now = Date.now();
  const stale = Math.max(ST.rssOk, ST.tgOk) === 0 ? true : now - Math.max(ST.rssOk, ST.tgOk) > STALE_AFTER;
  return { updated: Math.max(ST.rssOk, ST.tgOk) || null, stale, errors: { ...ST.errors }, items: build(now) };
}

let started = false;
function start() {
  if (started) return; started = true;
  const run = (fn, every) => { fn().catch(() => {}); setInterval(() => fn().catch(() => {}), every).unref?.(); };
  run(refreshRss, RSS_EVERY); run(refreshTg, TG_EVERY);
}
// per i test
function _load({ rss = [], tg = [], pages = {} } = {}) { ST.rss = rss; ST.tg = tg; ST.pages = new Map(Object.entries(pages)); ST.rssOk = ST.tgOk = Date.now(); }
module.exports = { setTideSource, planForLevel, autoWater, analyze, waterLevel, waterPlan, stopMentions, start, getAvvisi, setContext, parseRss, parseTelegram, parseValidity, articleText, toText, safeUrl, norm, build, _load, refreshRss, refreshTg };
