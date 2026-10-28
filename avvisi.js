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
  return decode(String(html)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<[^>]*>/g, ' '))
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
  const tm = /dalle?\s+(?:ore\s+)?(\d{1,2})[.:](\d{2})\s+(?:alle?|fino\s+alle?)\s+(?:ore\s+)?(\d{1,2})[.:](\d{2})/.exec(t);
  const t0 = tm ? secsOf(tm[1], tm[2]) : 0, t1 = tm ? secsOf(tm[3], tm[4]) : 86399;
  if (!dates.length) {
    const len = kind === 'tg' ? UNDATED_TG_MS : UNDATED_RSS_MS;
    return { from: pubMs, to: pubMs + len, open: false, dated: false };
  }
  const key = d => d.y * 10000 + d.m * 100 + d.d, sorted = dates.slice().sort((a, b) => key(a) - key(b));
  const first = sorted[0], last = sorted[sorted.length - 1];
  const upTo = /\b(fino al|sino al|fino a|entro il)\b/.test(t) && dates.length === 1;
  const fromOpen = /\b(dal|da|a partire da|a decorrere da)\b/.test(t) && !/\b(al|fino)\b\s+(?:\w+\s+)?\d{1,2}\s/.test(t.slice(t.indexOf(String(first.d)))) && dates.length === 1;
  if (upTo) return { from: pubMs, to: romeMs(last.y, last.m, last.d, t1), open: false, dated: true };
  if (dates.length === 1 && fromOpen) {
    const from = romeMs(first.y, first.m, first.d, tm ? t0 : 0);
    return { from, to: from + OPEN_ENDED_MS, open: true, dated: true };
  }
  return { from: romeMs(first.y, first.m, first.d, t0), to: romeMs(last.y, last.m, last.d, t1), open: false, dated: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// LINEE E FERMATE CITATE
// ---------------------------------------------------------------------------------------------------------------------
// Linee: nei tratti di testo che seguono "linea/linee/navetta" si prendono i codici maiuscoli e si tengono solo quelli che esistono nel GTFS.
// Prima si tolgono le date ("31 ottobre"), che altrimenti sembrerebbero la linea 31.
function findLines(text, known) {
  const out = new Set(); if (!known?.size) return [];
  const clean = text.replace(new RegExp(`\\d{1,2}\\s*(?:-|–|e)?\\s*\\d{0,2}\\s+${MON_RE}(?:\\s+\\d{4})?`, 'gi'), ' ').replace(/\b\d{1,2}[.:]\d{2}\b/g, ' ');
  for (const seg of clean.matchAll(/\b(?:linee|linea|line|navetta|navette)\b([^\n.;:]{0,140})/gi)) {
    for (const tok of seg[1].matchAll(/[A-Z0-9][A-Z0-9./]*[A-Z0-9]|[A-Z0-9]/g)) {
      const k = tok[0].replace(/\/+$/, '').toUpperCase(); if (known.has(k)) out.add(known.get(k));
    }
  }
  // titolo del tipo "7E: ..." o "Linea 7E"
  const lead = /^\s*(?:linea\s+)?([A-Z0-9][A-Z0-9.]{0,5})\s*[:–-]/.exec(text); if (lead && known.has(lead[1].toUpperCase())) out.add(known.get(lead[1].toUpperCase()));
  return [...out].slice(0, 20);
}
// Fermate: nomi tra virgolette (“…”, «…», "...") o dopo "fermata/fermate/pontile", confrontati con i nomi del GTFS (uguaglianza dei nomi normalizzati)
function stopCandidates(text) {
  const c = new Set();
  for (const r of text.matchAll(/[“«"]([^”»"\n]{4,60})[”»"]/g)) c.add(r[1]);
  for (const r of text.matchAll(/\b(?:fermata|fermate|pontile|pontili)\s+(?:di\s+|del\s+|della\s+|dello\s+|dei\s+)?([A-ZÀ-Ý][^,.;:()\n]{3,50})/g)) c.add(r[1]);
  return [...c].map(s => norm(s)).filter(s => s.length >= 4);
}
function findStops(text, byName) {
  const ids = new Set();
  if (!byName?.size) return [];
  for (const c of stopCandidates(text)) {
    const hit = byName.get(c); if (hit) { hit.forEach(i => ids.add(i)); continue; }
    const words = c.split(' ');                                               // "Forte Marghera Gerlin in entrambe le direzioni": si accorcia da destra
    for (let n = words.length - 1; n >= 2; n--) { const h = byName.get(words.slice(0, n).join(' ')); if (h) { h.forEach(i => ids.add(i)); break; } }
  }
  return [...ids].slice(0, 80);
}

// ---------------------------------------------------------------------------------------------------------------------
// LETTURA DELLE FONTI
// ---------------------------------------------------------------------------------------------------------------------
async function fetchText(url) {
  const u = new URL(url); if (u.protocol !== 'https:' || !OK_HOSTS.has(u.hostname)) throw new Error('dominio non ammesso');
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const fin = res.url ? new URL(res.url) : u; if (!OK_HOSTS.has(fin.hostname)) throw new Error('reindirizzamento non ammesso');
  const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > MAX_BYTES) throw new Error('risposta troppo grande');
  return buf.toString('utf8');
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
const ST = { rss: [], tg: [], pages: new Map(), rssAt: 0, tgAt: 0, rssOk: 0, tgOk: 0, errors: {}, ctx: () => ({ known: new Map(), byName: new Map() }) };
const idOf = key => crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);

// contesto per riconoscere linee e fermate: forniti da server.js (dipendono dai GTFS in uso)
function setContext(fn) { ST.ctx = fn; ST.cache = null; }

async function refreshRss() {
  ST.rssAt = Date.now();
  try {
    ST.rss = parseRss(await fetchText(SRC.rss)).slice(0, 40);
    ST.rssOk = Date.now(); ST.errors.rss = null;
    let n = 0;
    for (const it of ST.rss) {                                              // pagina completa solo per le notizie nuove (max 12 a giro)
      if (ST.pages.has(it.url) || n >= 12 || Date.now() - it.pubMs > 30 * DAY) continue;
      n++; try { ST.pages.set(it.url, articleText(await fetchText(it.url))); } catch { /* si usa il riassunto del feed */ }
    }
    for (const k of [...ST.pages.keys()]) if (!ST.rss.some(i => i.url === k)) ST.pages.delete(k);
  } catch (e) { ST.errors.rss = e.message; }
  ST.cache = null;
}
async function refreshTg() {
  ST.tgAt = Date.now();
  try { ST.tg = parseTelegram(await fetchText(SRC.tg)).slice(-40); ST.tgOk = Date.now(); ST.errors.tg = null; }
  catch (e) { ST.errors.tg = e.message; }
  ST.cache = null;
}

const short = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s\S*$/, '') + '…' : s; };

// Elenco finale: unisce le due fonti (un messaggio Telegram che rimanda a una notizia ACTV è la stessa cosa), calcola validità, linee, fermate
function build(now = Date.now()) {
  const ctx = ST.ctx() || {}, items = [], byUrl = new Map();
  for (const r of ST.rss) {
    const body = ST.pages.get(r.url) || r.text, full = r.title + '\n' + body, v = parseValidity(full, r.pubMs, 'rss');
    const it = { id: idOf(r.key), source: 'actv', title: r.title, text: short(body.replace(r.title, '').trim() || r.text, 700), url: r.url, published: r.pubMs, ...v,
      lines: findLines(full, ctx.known), stops: findStops(full, ctx.byName) };
    items.push(it); byUrl.set(r.url, it);
  }
  for (const m of ST.tg) {
    const first = m.links.find(l => byUrl.has(l));
    if (first) { const it = byUrl.get(first); it.source = 'both'; it.tgUrl = m.url; continue; }   // già presente dal sito ACTV
    const lines = m.text.split('\n').filter(Boolean), title = short(lines[0] || 'Avviso', 110), v = parseValidity(m.text, m.pubMs, 'tg');
    items.push({ id: idOf(m.key), source: 'telegram', title, text: short(lines.slice(title === lines[0] ? 1 : 0).join(' ') || m.text, 700), url: m.links.find(l => /actv|avm/.test(l)) || m.url, tgUrl: m.url,
      published: m.pubMs, ...v, lines: findLines(m.text, ctx.known), stops: findStops(m.text, ctx.byName) });
  }
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
module.exports = { start, getAvvisi, setContext, parseRss, parseTelegram, parseValidity, findLines, findStops, articleText, toText, safeUrl, norm, build, _load, refreshRss, refreshTg };
