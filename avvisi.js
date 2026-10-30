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

// Date nel testo con posizione, ruolo ("from"/"to") e orari vicini.
//   "dal 28 ottobre al 3 novembre", "1-2 novembre", "da lunedì 2 novembre", "fino al 5 novembre", "oggi", "domani",
//   "sabato 31 ottobre, dalle 9.30 alle 16.30", "dalle ore 8.30 di venerdì 30 ottobre", "fino alle 6 di lunedì 2 novembre"
const WD = '(?:lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)';
const TM = '(\\d{1,2})(?:[.:](\\d{2}))?';
const tsec = (h, m) => { h = +h; m = +(m || 0); return h >= 0 && h <= 24 && m < 60 ? Math.min(86399, h * 3600 + m * 60) : null; };
function findDates(text, pubMs) {
  const t = noAccents(text.toLowerCase()), out = [], pubY = +cal.romeYmd(pubMs).slice(0, 4);
  const push = (d, mon, y, idx, end, extra = {}) => {
    const m = typeof mon === 'number' ? mon : MONTHS[mon.slice(0, 3)]; d = +d; if (!m || d < 1 || d > 31) return;
    let yy = y ? +y : pubY;
    if (!y && romeMs(yy, m, d) < pubMs - 90 * DAY) yy++;           // senza anno: la prima occorrenza nel futuro prossimo
    out.push({ y: yy, m, d, idx, end, ...extra });
  };
  // intervalli compatti "1-2 novembre [2026]" / "1 e 2 novembre" / "dal 2 al 4 gennaio"
  const used = [];
  for (const r of t.matchAll(new RegExp(`(\\d{1,2})\\s*(?:-|–|—|e|al)\\s*(\\d{1,2})\\s+${MON_RE}(?:\\s+(\\d{4}))?`, 'g'))) {
    const end = r.index + r[0].length;
    push(r[1], r[3], r[4], r.index, end, { pair: 'from' }); push(r[2], r[3], r[4], r.index + 1, end, { pair: 'to' }); used.push([r.index, end]);
  }
  for (const r of t.matchAll(new RegExp(`(\\d{1,2})\\s*(?:°|º)?\\s+${MON_RE}(?:\\s+(\\d{4}))?`, 'g'))) {
    if (used.some(([a, b]) => r.index >= a && r.index < b)) continue;
    push(r[1], r[2], r[3], r.index, r.index + r[0].length);
  }
  // giorni relativi alla pubblicazione: solo se il testo non ha date esplicite (altrimenti "oggi 30 ottobre" la conterebbe due volte)
  if (!out.length) for (const r of t.matchAll(/\b(oggi|stamattina|stamane|stasera|stanotte|questa (?:mattina|sera|notte)|domani|domattina|dopodomani)\b/g)) {
    const add = r[1] === 'dopodomani' ? 2 : /domani|domattina/.test(r[1]) ? 1 : 0, p = cal.romeYmd(pubMs), dt = new Date(Date.UTC(+p.slice(0, 4), +p.slice(4, 6) - 1, +p.slice(6, 8) + add));
    push(dt.getUTCDate(), dt.getUTCMonth() + 1, String(dt.getUTCFullYear()), r.index, r.index + r[0].length, { rel: true });
  }
  out.sort((a, b) => a.idx - b.idx);
  for (const dt of out) {                                         // ruolo e orari vicini
    const before = t.slice(Math.max(0, dt.idx - 48), dt.idx), after = t.slice(dt.end, dt.end + 64);
    let m;
    if ((m = new RegExp(`\\b(?:fino alle|sino alle|alle)\\s*(?:ore\\s*)?${TM}\\s*(?:di|del|della|dello)\\s*(?:${WD}\\s*)?$`).exec(before))) { dt.e = tsec(m[1], m[2]); dt.role = 'to'; }   // "fino alle 6 di lunedì 2 novembre"
    else if ((m = new RegExp(`(?:\\bdalle|\\bdall'|a partire dalle|\\bore)\\s*(?:ore\\s*)?${TM}\\s*(?:di|del|della|dello)?\\s*(?:${WD}\\s*)?$`).exec(before))) dt.s = tsec(m[1], m[2]);   // "dalle ore 8.30 di venerdì 30 ottobre"
    if ((m = new RegExp(`^\\s*(?:\\d{4})?\\s*,?\\s*(?:\\(?${WD}\\)?\\s*,?\\s*)?(?:dalle ore|dalle|a partire dalle|dall'|alle ore|ore|alle)\\s*(?:ore\\s*)?${TM}(?:\\s*(?:alle|-|–|fino alle)\\s*(?:ore\\s*)?${TM})?`).exec(after))) {
      if (dt.s == null) dt.s = tsec(m[1], m[2]); if (m[3] != null) dt.e = tsec(m[3], m[4]);
    } else if ((m = new RegExp(`^\\s*(?:\\d{4})?\\s*,?\\s*(?:fino|sino) alle\\s*(?:ore\\s*)?${TM}`).exec(after))) dt.e = tsec(m[1], m[2]);
    if (!dt.role) dt.role = dt.pair || (new RegExp(`(?:\\bal|\\bfino al|\\bsino al|\\bentro il|\\bfino a|\\bentro)\\s+(?:${WD}\\s+)?$`).test(before) ? 'to' : 'from');
    dt.dal = new RegExp(`(?:\\bdal|\\bda|a partire dal|a partire da|a decorrere dal)\\s+(?:inizio servizi[oa]? (?:di\\s+)?)?(?:${WD}\\s+)?$`).test(before);
  }
  return out;
}

// -> { from, to, open, dated, untilEnd } in ms.
//  · senza date: dalla pubblicazione (o dall'orario indicato oggi), durata breve per Telegram (2 h per guasti/ritardi, 6 h altrimenti), media per il sito;
//  · "dal X" senza fine e "fino a nuova comunicazione": vale a lungo (open);  "fino al termine della manifestazione": fino a fine giornata (untilEnd);
//  · più fasce orarie nello stesso giorno (es. sciopero con fasce garantite): giornata intera.
const INCIDENT = /\b(guast\w*|incident\w*|rallentament\w*|ritard\w*|traffico|interruzion\w*|interrott\w*|bloccat\w*|avari\w*|soccorso|malore|code)\b/;
function parseValidity(text, pubMs, kind = 'rss') {
  const t = noAccents(text.toLowerCase()), dates = findDates(text, pubMs);
  const untilNotice = /fino a (?:nuov[oa] (?:avviso|comunicazione|disposizione)|diversa comunicazione|cessate esigenze|data da destinarsi|revoca)|fino al ripristino|a tempo indeterminato/.test(t);
  const untilEvent = /fino al(?:la)? (?:termine|fine|conclusione)\b/.test(t);
  const slots = [...t.matchAll(/(?:dalle?|a partire dalle)\s+(?:ore\s+)?(\d{1,2})(?:[.:](\d{2}))?\s*(?:,\s*|e\s+)?(?:alle?|fino\s+alle?|sino\s+alle?)\s+(?:ore\s+)?(\d{1,2})(?:[.:](\d{2}))?/g)];
  if (!dates.length) {
    const p = cal.romeYmd(pubMs), day = romeMs(+p.slice(0, 4), +p.slice(4, 6), +p.slice(6, 8));
    const len = kind === 'tg' ? (INCIDENT.test(t) ? 2 * 3600e3 : UNDATED_TG_MS) : UNDATED_RSS_MS;
    if (untilNotice) return { from: pubMs, to: pubMs + OPEN_ENDED_MS, open: true, dated: false };
    if (slots.length === 1) {
      const s = tsec(slots[0][1], slots[0][2]), e = tsec(slots[0][3], slots[0][4]);
      if (s != null && e != null) { const from = day + s * 1000, to = day + e * 1000 + (e <= s ? DAY : 0); if (to > pubMs) return { from: Math.min(from, Math.max(pubMs, from)), to, open: false, dated: true }; }
    }
    const st = /(?:dalle|a partire dalle)\s+(?:ore\s+)?(\d{1,2})[.:](\d{2})/.exec(t), s = st ? tsec(st[1], st[2]) : null;
    if (s != null && day + s * 1000 > pubMs - 3600e3) { const from = day + s * 1000; return { from, to: from + len, open: false, dated: true, untilEnd: untilEvent || undefined }; }
    return { from: pubMs, to: pubMs + len, open: false, dated: false };
  }
  if (slots.length > 1) for (const d of dates) { delete d.s; delete d.e; }      // più fasce: giornata intera
  const one = slots.length === 1 && (t.match(/\b\d{1,2}[.:]\d{2}\b/g) || []).length <= 2 ? slots[0] : null;
  const g0 = one ? tsec(one[1], one[2]) : null, g1 = one ? tsec(one[3], one[4]) : null;
  const key = d => d.y * 10000 + d.m * 100 + d.d, byKey = (a, b) => key(a) - key(b);
  const froms = dates.filter(d => d.role !== 'to').sort(byKey), tos = dates.filter(d => d.role === 'to').sort(byKey), all = dates.slice().sort(byKey);
  const first = froms[0] || null, last = tos.length ? tos[tos.length - 1] : all[all.length - 1];
  const from = first ? romeMs(first.y, first.m, first.d, first.s ?? g0 ?? 0) : pubMs;
  let to, open = false;
  const distinct = new Set(all.map(key)).size;
  if (tos.length) to = romeMs(last.y, last.m, last.d, last.e ?? (key(last) === key(first || last) ? g1 : null) ?? 86399);
  else if (untilNotice || (first?.dal && !untilEvent && distinct === 1 && first.e == null && g1 == null)) { to = Math.max(from, romeMs(last.y, last.m, last.d, 0)) + OPEN_ENDED_MS; open = true; }
  else to = romeMs(last.y, last.m, last.d, last.e ?? g1 ?? 86399);
  if (untilEvent && !open) to = Math.max(to, from + 4 * 3600e3);              // evento senza ora di fine: almeno 4 ore
  if (to <= from) to = Math.max(romeMs(last.y, last.m, last.d, 86399), from + 3600e3);
  return { from, to, open, dated: true, untilEnd: (untilEvent && !tos.some(d => d.e != null)) || undefined };
}

// ---------------------------------------------------------------------------------------------------------------------
// LINEE E FERMATE CITATE
// ---------------------------------------------------------------------------------------------------------------------
// Le regole sono generali, non per singolo avviso: vedi i commenti di analyze(). Prima di cercare le linee si tolgono date e orari ("31 ottobre", "9.30"), che sembrerebbero linee.
// parola che introduce una linea (e servizio che indica: "bus", "tram" = automobilistico; "vaporetto", "di navigazione" = navigazione)
const TRIG = /\b(?:linee|linea|navett[ae]|autobus|bus|tram|tranvi[ae]|vaporett[oi]|battell[oi]|motonav[ie])\b(?:\s+(?:di\s+navigazione|automobilistic[ahei]+|tranviari[ae]|urban[ae]|extraurban[ae]|notturn[ae]|interessat[ae]|coinvolt[ae]|deviat[ae]|sospes[ae]|soppress[ae]|modificat[ae]|limitat[ae]))*\s*(?:n\.|nr\.?|numero)?\s*[:'‘’]?\s*/gi;
const hintOf = w => /autobus|\bbus|tram|tranvi|automobilistic|extraurban|urban/i.test(w) ? 'aut' : /vaporett|battell|motonav|navigazione/i.test(w) ? 'nav' : null;
// codice di linea: 4.1, 31H, 6L, T1, N, NLN, 9S…  (solo maiuscole: "bus sostitutivi" non è una linea); non seguito da un'unità ("10 minuti")
const TOK = /^([A-Z]{0,3}\d{1,3}(?:\.\d)?[A-Z]{0,2}|[A-Z]{1,3})(?![A-Za-z0-9])(?!\s*(?:minut|min\b|ore\b|or[ae]\b|km|metri|m\b|cm\b|corse|%|°|euro|persone|giorni|volte))/;
const SEP = /^(?:\s*(?:,|\/|&|\+|-|–|\be\b|\bed\b)\s*|\s+)/;
// elenco di codici dopo la parola di linea; separati solo da spazio continuano solo se entrambi hanno cifre ("linee 4.1 4.2", non "linee 17 N 5")
function listAfter(s) {
  const toks = []; let i = 0;
  for (;;) {
    const m = TOK.exec(s.slice(i)); if (!m) break;
    toks.push(m[1]); i += m[0].length;
    const sp = SEP.exec(s.slice(i)); if (!sp) break;
    const nx = TOK.exec(s.slice(i + sp[0].length)); if (!nx) break;
    if (!sp[0].trim() && !(/\d/.test(m[1]) && /\d/.test(nx[1]))) break;
    i += sp[0].length;
  }
  return { toks, rest: s.slice(i) };
}
const AUT_EMO = /[\u{1F68C}\u{1F68D}\u{1F68E}\u{1F68B}\u{1F68A}\u{1F68F}\u{1F683}]/gu, NAV_EMO = /[\u26F4\u{1F6A4}\u{1F6E5}\u{1F6A2}\u2693]/gu;
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
  const gAut = count(AUT_WORDS, full) + 2 * count(AUT_EMO, full), gNav = count(NAV_WORDS, full) + 2 * count(NAV_EMO, full);
  const served = x => ctx.lineStops?.get(x.s + ':' + String(x.n).toUpperCase());
  const hits = x => { const sv = served(x); let n = 0; if (sv) for (const id of strongIds) if (sv.has(id)) n++; return n; };
  const lines = new Map();
  const clean = full.replace(new RegExp(`\\d{1,2}\\s*(?:-|–|e)?\\s*\\d{0,2}\\s+${MON_RE}(?:\\s+\\d{4})?`, 'gi'), ' ').replace(/\b\d{1,2}[.:]\d{2}\b/g, ' ')
    .replace(/[“"]\s*[A-Z]\s*[”"]/g, ' ');                      // "B", "D" tra virgolette doppie = lettera del pontile, non una linea
  const decide = (tok, around, hint) => {
    let c = known?.get(tok.replace(/[./]+$/, '').toUpperCase()); if (!c) return;
    if (hint && c.length > 1 && c.some(x => x.s === hint)) c = c.filter(x => x.s === hint);     // "bus 2", "vaporetto 2": il servizio è detto
    let pick = c;
    if (c.length > 1) {
      const la = count(AUT_WORDS, around) + 2 * count(AUT_EMO, around), ln = count(NAV_WORDS, around) + 2 * count(NAV_EMO, around);
      const sc = c.map(x => hits(x) * 4 + (mSrc.size === 1 && mSrc.has(x.s) ? 3 : 0) + (x.s === 'aut' ? 2 * la + gAut : 2 * ln + gNav));
      const best = Math.max(...sc), top = c.filter((_, i) => sc[i] === best);
      pick = top.length === 1 && best > 0 ? top : [];   // numero ambiguo senza prove: meglio non indicare la linea che indicarne una sbagliata
    }
    for (const x of pick) {
      if (mSrc.size === 1 && !mSrc.has(x.s) && served(x) && !hits(x)) continue;   // altro servizio, e nessuna delle fermate citate è sua
      lines.set(x.s + ':' + x.n, { n: x.n, s: x.s, c: x.c || null });
    }
  };
  // linee: elenchi che seguono una parola di linea ("linee 9S, 21 e 56E", "bus 7", "tram T1", "vaporetto 4.1", "linee interessate: 2, 6") e i tram T1/T2 ovunque
  for (const m of clean.matchAll(TRIG)) {
    const rest = clean.slice(m.index + m[0].length), { toks, rest: after } = listAfter(rest); if (!toks.length) continue;
    const around = clean.slice(Math.max(0, m.index - 150), m.index + 250), hint = hintOf(m[0]);
    toks.forEach((tok, j) => {
      if (/^[A-Z]$/.test(tok) && (j > 0 || /^\s*[a-zà-ÿ]/.test(after))) return;   // "linea 13 e A partire…": non è la linea A
      decide(tok, around, hint);
    });
  }
  for (const m of clean.matchAll(/(?<![A-Za-z0-9])(T[1-9])(?![A-Za-z0-9])/g)) decide(m[1], clean.slice(Math.max(0, m.index - 150), m.index + 250), 'aut');   // tram
  const lead = /^\s*(?:linea\s+)?([A-Z0-9][A-Z0-9.]{0,5})\s*[:–-]/.exec(text); if (lead && !/^[A-Z]$/.test(lead[1])) decide(lead[1], full.slice(0, 400), null);
  const lineList = [...lines.values()].slice(0, 40), srcs = new Set(lineList.map(l => l.s));
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
  // (e molte linee: avviso di rete, non di singole linee: resta nell'elenco ma non si appende a fermate e mezzi)
  const general = /\borari\b|modifiche ai? serviz/i.test(title) || names.size > 30 || lineList.length > 12;
  return { lines: lineList, stops: general ? [] : ids.slice(0, 80), stopNames: general ? [] : [...names.values()].slice(0, 30), general: general || undefined };
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
// Acqua alta: valgono INSIEME il livello misurato, la previsione (picco nelle prossime 12 ore) e gli avvisi ufficiali (Telegram / sito ACTV).
//  · livello di riferimento = il più alto fra misurato, previsto e indicato dall'avviso ufficiale; il piano ACTV si applica a quel livello;
//  · con un avviso ufficiale che indica il livello: resta solo quello, completato con il piano per il livello di riferimento e con misura e previsione;
//  · senza: compare l'avviso calcolato; se un avviso ufficiale parla di acqua alta senza livello, l'avviso calcolato risulta "confermato" e vi rimanda.
const AA_MENTION = /acqua\s+alta|alta\s+marea|picco\s+di\s+marea/i;
function autoWater(now, ctx, items = []) {
  let snap = null; try { snap = tideSource(); } catch { /* dato non disponibile */ }
  const measured = snap && !snap.stale ? snap.cm : null, peak = snap?.peak || null;
  const live = items.filter(it => it.source !== 'auto' && !it.drop && !it.resolved && it.from <= now + UPCOMING_MS && it.to >= now);
  const offs = live.filter(it => it.water).sort((x, y) => y.published - x.published), mentions = live.filter(it => !it.water && AA_MENTION.test(it.title + ' ' + it.text));
  const official = offs.length ? Math.max(...offs.map(it => it.water.level)) : null;
  const level = Math.max(measured ?? -999, peak ? peak.cm : -999, official ?? -999), plan = planForLevel(level, ctx);
  const water = { level, url: AA_URL, measured, forecast: peak && peak.cm > 85 ? peak : null, official, confirmed: !!(offs.length || mentions.length) };
  if (offs.length) {                                                         // avviso ufficiale con livello: si completa quello
    const main = offs[0], p = plan || planForLevel(official, ctx);
    if (p) {
      main.water = { ...water, plan: p.plan };
      const lk = new Set(main.lines.map(l => l.s + ':' + l.n)); for (const l of p.lines) if (!lk.has(l.s + ':' + l.n)) main.lines.push(l);
      main.stops = [...new Set([...main.stops, ...p.stops])]; const nk = new Set(main.stopNames.map(s => s.s + '|' + s.n)); for (const s of p.stopNames) if (!nk.has(s.s + '|' + s.n)) main.stopNames.push(s);
    }
    for (const it of offs.slice(1)) it.water = { ...it.water, measured, forecast: water.forecast };
    return { measured, item: null };
  }
  if (!plan || (measured == null || measured <= 85) && !(peak && peak.cm > 85)) return { measured, item: null };
  const nowHigh = measured != null && measured > 85, from = nowHigh ? now - 60e3 : Math.max(now - 60e3, peak.ts - 2 * 3600e3);
  const parts = [measured != null ? `Livello misurato ${measured} cm` : null, peak && peak.cm > 85 ? `picco previsto ${peak.cm} cm alle ${hhmm(peak.ts)}` : null].filter(Boolean).join(', ');
  const conf = mentions[0];
  return { measured, item: { id: 'auto-acqua-alta', source: 'auto', title: `Acqua alta: marea oltre 85 cm (${level} cm)`,
    text: `${parts}. ${conf ? `Confermato dall'avviso ufficiale «${short(conf.title, 80)}»` : 'Nessun avviso ufficiale rilevato'}: sono indicate le disposizioni del piano ACTV per questo livello. Fa fede la comunicazione ufficiale.`,
    url: AA_URL, tgUrl: conf ? (conf.tgUrl || conf.url) : undefined, published: now, from, to: nowHigh ? now + 20 * 60e3 : Math.max(peak.ts + 2 * 3600e3, now + 20 * 60e3), open: false, dated: false,
    lines: plan.lines, stops: plan.stops, stopNames: plan.stopNames, water: { ...water, plan: plan.plan } } };
}
// unisce il piano acqua alta al risultato di analyze()
function withWater(res, full, ctx) {
  const w = waterPlan(full, ctx); if (!w) return res;
  const lines = new Map(res.lines.map(l => [l.s + ':' + l.n, l]));
  for (const l of w.lines) if (!lines.has(l.s + ':' + l.n)) lines.set(l.s + ':' + l.n, l);
  const names = new Map(res.stopNames.map(s => [s.s + '|' + s.n, s])); for (const s of w.stopNames) names.set(s.s + '|' + s.n, s);
  return { ...res, general: undefined, lines: [...lines.values()].slice(0, 40), stops: [...new Set([...res.stops, ...w.stops])].slice(0, 100), stopNames: [...names.values()].slice(0, 40),
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

// ---------------------------------------------------------------------------------------------------------------------
// FILI DI AVVISI SULLO STESSO ARGOMENTO (come le app di navigazione: si vede l'ultima versione, e la fine quando l'evento finisce)
//  · un messaggio più recente sullo stesso argomento SOSTITUISCE il precedente ("aggiornamento"): il vecchio sparisce; se il nuovo non ha date eredita il periodo del vecchio;
//  · un messaggio di chiusura ("ripristinato", "servizio regolare", "terminata la manifestazione") CHIUDE i precedenti collegati e resta 1 ora come "risolto";
//  · un messaggio Telegram uguale a una notizia del sito ACTV non la duplica (si unisce, come quando contiene il link).
//  Stesso argomento = testo molto simile, oppure stesso tipo di evento con almeno una linea/fermata in comune o testo abbastanza simile.
//  Gli avvisi programmati lunghi (più di un giorno, es. lavori) si chiudono o si sostituiscono solo con testo molto simile: un guasto sulla stessa linea non li tocca.
// ---------------------------------------------------------------------------------------------------------------------
const SERVICE_MSG = /\b(?:pinned (?:a |an )?(?:photo|message|video|file|poll|sticker|gif|audio)|ha fissato|channel (?:photo|name) (?:updated|changed))\b/i;
const cleanTitle = s => String(s).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu, ' ')
  .replace(/^(?:\s*#[\p{L}\p{N}_]+\s*[|·:\-–—]?\s*)+/u, '').replace(/^[\s|·:\-–—]+|[\s|·:\-–—]+$/g, '').replace(/\s{2,}/g, ' ').trim();
const STOPW = new Set(('alla alle allo agli dalla dalle della delle degli nella nelle negli sulla sulle con per tra fra che non come anche oggi domani fino '
  + 'avviso avvisi informa informano informiamo comunica comunicano servizio servizi actv muoversivenezia venezia linea linee corsa corse fermata fermate causa seguito '
  + 'previsto prevista previsti previste sono sara saranno potranno potrebbe essere stato stata questo questa quella dopo prima circa').split(' '));
const KINDS = [/acqua alta|marea/, /manifestazion|corteo|presidio|sfilata|maratona|regata|concerto|partita|processione/, /nebbia|visibilit/, /sciopero/,
  /\bvento\b|bora|maltempo|temporal|neve|ghiaccio|mareggiat/, /guast|avari|incident|soccorso|malore/, /lavori|cantiere|asfaltatur|chiusura (?:strad|ponte|rotatoria)/, /people mover/];
const CLOSE_RE = /\b(?:ripristinat\w*|riattivat\w*|ripres[oaie]\b|riprend(?:e|ono)\b|tornat[oaie] (?:regolar\w*|in servizio|attiv\w*)|torna(?:no)? regolar\w*|regolarmente in servizio|(?:servizio|circolazione|transito) (?:e |sono )?(?:regolare|ripristinat\w*)|terminat[oaie]|conclus[oaie]|cessat[oaie]|revocat[oaie]|fine (?:dell[ae] )?(?:manifestazione|evento|emergenza|allerta))\b/;
const wordsOf = it => new Set(norm(it.title + ' ' + String(it.text || '').slice(0, 260)).split(' ').filter(w => w.length >= 4 && !STOPW.has(w) && !/\d/.test(w)));
const kindsOf = it => { const s = noAccents((it.title + ' ' + it.text).toLowerCase()); return new Set(KINDS.map((re, i) => (re.test(s) ? i : -1)).filter(i => i >= 0)); };
const overlap = (a, b) => { if (a.size < 2 || b.size < 2) return 0; let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.min(a.size, b.size); };
const shares = (a, b) => a.some(x => b.includes(x));
function thread(items) {
  const list = items.filter(i => i.source !== 'auto').sort((a, b) => a.published - b.published);
  for (const it of list) { it.words = wordsOf(it); it.kinds = kindsOf(it); it.lk = it.lines.map(l => l.s + ':' + l.n); }
  for (let j = 1; j < list.length; j++) {
    const B = list[j]; if (B.drop) continue;
    const closing = CLOSE_RE.test(noAccents((B.title + ' ' + String(B.text).slice(0, 200)).toLowerCase())) && !(B.dated && B.from > B.published + 3600e3);
    for (let i = j - 1; i >= 0; i--) {
      const A = list[i]; if (A.drop || A.to <= B.published || A.published > B.published) continue;
      const ov = overlap(A.words, B.words), sameKind = [...A.kinds].some(k => B.kinds.has(k)), common = shares(A.lk, B.lk) || shares(A.stops, B.stops);
      const longA = A.dated && A.to - A.from > DAY;
      const related = ov >= 0.6 || (!longA && ((sameKind && (common || ov >= 0.3)) || (common && ov >= 0.3)));
      if (!related) continue;
      if (closing) {                                                        // fine dell'evento: chiude il precedente
        A.to = Math.max(Math.min(A.to, B.published), A.from); if (A.from > B.published) A.drop = true;
        B.resolved = true; B.to = B.published + 3600e3; B.from = Math.min(B.from, B.published); B.stops = []; B.stopNames = [];
        if (!B.lines.length) B.lines = A.lines;
        continue;
      }
      if (A.source !== 'telegram' && B.source === 'telegram' && ov >= 0.5) { A.source = 'both'; A.tgUrl = A.tgUrl || B.tgUrl; B.drop = true; break; }   // stessa notizia del sito
      // aggiornamento: B sostituisce A
      if (!B.dated && A.dated) { B.from = Math.min(A.from, B.from); B.to = Math.max(A.to, B.to); B.dated = true; B.open = A.open; B.untilEnd = A.untilEnd; }
      if (!B.lines.length && A.lines.length) { B.lines = A.lines; B.lk = A.lk; }
      if (!B.stops.length && A.stops.length) { B.stops = A.stops; B.stopNames = A.stopNames; }
      if (!B.water && A.water) B.water = A.water;
      B.updated = (B.updated || 0) + 1 + (A.updated || 0); A.drop = true;
    }
  }
  for (const it of list) { delete it.words; delete it.kinds; delete it.lk; }
}

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
    if (SERVICE_MSG.test(m.text) || !m.text.trim()) continue;                // "… pinned a photo": messaggi di servizio del canale
    const rows = m.text.split('\n').map(s => s.trim()).filter(Boolean), k = rows.findIndex(r => cleanTitle(r).length >= 3);
    const title = short(cleanTitle(rows[k] ?? '') || 'Avviso', 110), body = rows.slice(k + 1).join(' '), v = parseValidity(m.text, m.pubMs, 'tg');
    items.push({ id: idOf(m.key), source: 'telegram', title, text: short(body || title, 700), url: m.links.find(l => /actv|avm/.test(l)) || m.url, tgUrl: m.url,
      published: m.pubMs, ...v, ...analyze(title, m.text, ctx) });
  }
  thread(items);
  const aw = autoWater(now, ctx, items);                                     // acqua alta: misura + previsione + avvisi ufficiali
  if (aw.item) items.push(aw.item);
  const out = [];
  for (const it of items) {
    if (it.drop || it.to < now - KEEP_EXPIRED_MS) continue;                 // unito a un altro, sostituito, chiuso o scaduto
    const state = it.from <= now ? 'active' : it.from - now <= UPCOMING_MS ? 'upcoming' : null;
    if (!state) continue;                                                   // troppo lontano nel tempo
    const { drop, words, ...pub } = it; out.push({ ...pub, state });
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
