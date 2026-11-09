// ARCHIVIO DELLE COMUNICAZIONI (avvisi ACTV e messaggi Telegram): conserva i testi originali per ricostruire gli eventi dopo un riavvio
// e per non perdere gli avvisi ancora validi quando escono dalle pagine pubbliche (Telegram ne mostra circa 20, il feed RSS 30).
//  · SCRITTURA: solo il workflow GitHub «archivio-avvisi» (scripts/archivia-avvisi.js), sul ramo separato «archivio-avvisi». Il server non scrive mai.
//  · LETTURA: il server legge i file pubblici del ramo (raw.githubusercontent.com) all'avvio e ogni 15 minuti, solo quelli cambiati (sha nell'indice).
//    Archivio irraggiungibile: resta l'ultima copia letta; se non è mai stata letta, valgono le sole fonti in diretta (come la v23).
//  · FORMATO: avvisi/indice.json + avvisi/comunicazioni/AAAA-MM.jsonl (mese di pubblicazione, ora di Venezia), una riga JSON per versione:
//      { id, src: 'rss'|'tg', v, hash, pub, seen, title?, url, text, page?, links?, replyTo?, quote? }
//    id stabile (rss:<guid> / tg:<numero>); una riga nuova solo se il testo cambia (hash): le versioni precedenti restano (cronologia delle modifiche).
//    Solo testo semplice, mai HTML.
//  · INTERPRETAZIONI AI (facoltative): avvisi/ai/indice.json + avvisi/ai/interpretazioni/AAAA-MM.jsonl, separate dalle comunicazioni (avvisi-ai.js).
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const cal = require('./calendar');

const FORMATO = 1;
const DEFAULT_URL = 'https://raw.githubusercontent.com/nickg1093/TPL-Venezia/archivio-avvisi/avvisi';
const OK_HOST = 'raw.githubusercontent.com';
const MAX_FILE = 5e6, KEEP_MONTHS = 6;   // il server legge al massimo gli ultimi 6 mesi (le comunicazioni più vecchie restano nel ramo)

const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex');
// impronta del contenuto: cambia solo se cambia il testo (non la data di lettura)
const hashOf = r => sha(JSON.stringify([r.title || '', r.text || '', r.page || '', r.replyTo || null, (r.links || []).join(' ')])).slice(0, 12);
const monthOf = ms => { const y = cal.romeYmd(ms); return `${y.slice(0, 4)}-${y.slice(4, 6)}`; };

// record d'archivio da una comunicazione letta (forma di parseRss / parseTelegram, più la pagina per l'RSS)
function recordOf(src, m, page, now) {
  const r = src === 'rss'
    ? { id: m.key, src, pub: m.pubMs, title: m.title, url: m.url, text: m.text, ...(page ? { page } : {}) }
    : { id: m.key, src, pub: m.pubMs, url: m.url, text: m.text, links: m.links || [], ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.quote ? { quote: m.quote } : {}) };
  r.hash = hashOf(r); r.seen = now; return r;
}
// righe JSONL -> mappa id -> { last, versions: [{ v, hash, seen }] }  (righe non valide ignorate)
function mergeLines(text, into = new Map()) {
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.id !== 'string' || (r.src !== 'rss' && r.src !== 'tg') || !Number.isFinite(r.pub)) continue;
    const e = into.get(r.id) || { last: null, versions: [] };
    if (!e.versions.some(x => x.hash === r.hash)) e.versions.push({ v: r.v || 1, hash: r.hash, seen: r.seen || r.pub });
    if (!e.last || (r.v || 1) >= (e.last.v || 1)) e.last = r;
    into.set(r.id, e);
  }
  for (const e of into.values()) e.versions.sort((a, b) => a.v - b.v);
  return into;
}

// ---- SCRITTURA (workflow): cartella locale del ramo ----
function openDir(dir) {
  const recs = new Map(), files = path.join(dir, 'comunicazioni');
  if (fs.existsSync(files)) for (const f of fs.readdirSync(files).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()) mergeLines(fs.readFileSync(path.join(files, f), 'utf8'), recs);
  const added = [];
  return {
    recs,
    // aggiunge la comunicazione se è nuova o se il testo è cambiato; ritorna 'nuova' | 'modificata' | null
    add(rec) {
      const e = recs.get(rec.id);
      if (e && e.versions.some(x => x.hash === rec.hash)) return null;
      const v = e ? Math.max(...e.versions.map(x => x.v)) + 1 : 1;
      const r = { ...rec, v }; added.push(r); mergeLines(JSON.stringify(r), recs);
      return e ? 'modificata' : 'nuova';
    },
    save(now) {
      if (!added.length) return false;
      fs.mkdirSync(files, { recursive: true });
      const byMonth = new Map(); for (const r of added) { const k = monthOf(r.pub); (byMonth.get(k) || byMonth.set(k, []).get(k)).push(r); }
      for (const [k, rows] of byMonth) fs.appendFileSync(path.join(files, `${k}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      const list = fs.readdirSync(files).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().map(f => {
        const t = fs.readFileSync(path.join(files, f), 'utf8');
        return { nome: f, righe: t.split('\n').filter(Boolean).length, sha: sha(t).slice(0, 16) };
      });
      fs.writeFileSync(path.join(dir, 'indice.json'), JSON.stringify({ formato: FORMATO, aggiornato: now, file: list }, null, 1) + '\n');
      added.length = 0; return true;
    },
  };
}

// ---- LETTURA (server) ----
const AR = { url: null, recs: new Map(), files: new Map(), loadedAt: 0, okAt: 0, error: null, version: 0 };
function baseUrl() {
  const v = process.env.AVVISI_ARCHIVIO;
  if (v === '0' || v === 'off') return null;
  return v || DEFAULT_URL;
}
async function readRemote(base, name) {
  if (/^https:/.test(base)) {
    const u = new URL(`${base}/${name}`); if (u.hostname !== OK_HOST) throw new Error('indirizzo dell\'archivio non ammesso');
    const res = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > MAX_FILE) throw new Error('file troppo grande');
    return buf.toString('utf8');
  }
  const f = path.join(base.replace(/^file:\/\//, ''), name);       // cartella locale (prove in locale e test)
  if (fs.statSync(f).size > MAX_FILE) throw new Error('file troppo grande');
  return fs.readFileSync(f, 'utf8');
}
// legge l'indice e solo i file cambiati; in caso di errore conserva quanto già letto
async function refresh(base = baseUrl()) {
  AR.url = base; AR.loadedAt = Date.now();
  if (!base) { AR.error = 'archivio disattivato (AVVISI_ARCHIVIO=0)'; return false; }
  try {
    const idx = JSON.parse(await readRemote(base, 'indice.json'));
    if (!idx || idx.formato !== FORMATO || !Array.isArray(idx.file)) throw new Error('indice non valido');
    const wanted = idx.file.filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f.nome)).slice(-KEEP_MONTHS);
    let changed = false;
    for (const f of wanted) {
      if (AR.files.get(f.nome)?.sha === f.sha) continue;
      AR.files.set(f.nome, { sha: f.sha, text: await readRemote(base, `comunicazioni/${f.nome}`) }); changed = true;
    }
    for (const k of [...AR.files.keys()]) if (!wanted.some(f => f.nome === k)) { AR.files.delete(k); changed = true; }
    if (changed) { const m = new Map(); for (const f of [...AR.files.keys()].sort()) mergeLines(AR.files.get(f).text, m); AR.recs = m; AR.version++; }
    AR.okAt = Date.now(); AR.error = null;
    if (await refreshAi(base)) changed = true;
    return changed;
  } catch (e) { AR.error = e.message || String(e); return false; }
}
// INTERPRETAZIONI AI (avvisi/ai/, scritte dal workflow con Cloudflare Workers AI): stesse regole di lettura (solo file cambiati, ultimi 6 mesi).
// Cartella assente (AI non configurata) o illeggibile: nessun errore, si conserva quanto già letto e gli avvisi usano le sole regole.
async function refreshAi(base) {
  try {
    const idx = JSON.parse(await readRemote(base, 'ai/indice.json'));
    if (!idx || idx.formato !== 1 || !Array.isArray(idx.file)) throw new Error('indice AI non valido');
    const wanted = idx.file.filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f.nome)).slice(-KEEP_MONTHS);
    let changed = false;
    for (const f of wanted) {
      if (AI.files.get(f.nome)?.sha === f.sha) continue;
      AI.files.set(f.nome, { sha: f.sha, text: await readRemote(base, `ai/interpretazioni/${f.nome}`) }); changed = true;
    }
    for (const k of [...AI.files.keys()]) if (!wanted.some(f => f.nome === k)) { AI.files.delete(k); changed = true; }
    if (changed) { const m = new Map(); for (const f of [...AI.files.keys()].sort()) aiMerge(AI.files.get(f).text, m); AI.map = m; AI.version++; }
    AI.okAt = Date.now(); AI.error = null; return changed;
  } catch (e) { AI.error = e.message || String(e); return false; }
}
// righe JSONL delle interpretazioni -> mappa "id|hash" -> ultima interpretazione riuscita (esito 'ok')
function aiMerge(text, into = new Map()) {
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.id !== 'string' || typeof r.hash !== 'string' || r.esito !== 'ok' || !r.ai || typeof r.ai !== 'object') continue;
    into.set(r.id + '|' + r.hash, r);
  }
  return into;
}
const AI = { files: new Map(), map: new Map(), okAt: 0, error: null, version: 0 };
function _setAi(rows) { AI.map = aiMerge((rows || []).map(r => JSON.stringify(r)).join('\n')); AI.version++; AI.okAt = Date.now(); AI.error = null; }
const aiRecords = () => AI.map;
const aiStatus = () => ({ interpretazioni: AI.map.size, file: [...AI.files.keys()], lettoAlle: AI.okAt || null, errore: AI.error });
// per i test: carica righe già pronte
function _setRecords(lines) { AR.recs = mergeLines(Array.isArray(lines) ? lines.map(r => JSON.stringify(r)).join('\n') : lines); AR.version++; AR.okAt = Date.now(); AR.error = null; }
const records = () => AR.recs;
const status = () => ({ url: AR.url, comunicazioni: AR.recs.size, file: [...AR.files.keys()], lettoAlle: AR.okAt || null, errore: AR.error });

module.exports = { FORMATO, hashOf, recordOf, mergeLines, monthOf, openDir, refresh, records, status, baseUrl, _setRecords, aiRecords, aiStatus, _setAi, version: () => AR.version + AI.version };
