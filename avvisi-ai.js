// INTERPRETAZIONE AI DELLE COMUNICAZIONI ACTV (Cloudflare Workers AI) — sistema ibrido:
//  · LLM: legge l'intera comunicazione e restituisce un JSON secondo SCHEMA (servizio, tipo, linee, periodi, relazioni con comunicazioni precedenti),
//    con una CITAZIONE testuale per ogni dato;
//  · regole esistenti (avvisi.js): passate al modello come lettura automatica di supporto e catalogo delle linee GTFS; restano il fallback;
//  · codice (validate qui, applicazione in avvisi.js): accetta solo dati citati nel testo, linee esistenti nel servizio dichiarato, relazioni verso
//    comunicazioni effettivamente proposte; certezza «bassa» = nessun effetto. L'AI non crea mai da sola collegamenti, chiusure o ripristini.
// INFERENZA solo nel workflow GitHub (scripts/interpreta-avvisi.js) o nelle prove locali: il server su Render legge i risultati già pronti
// dal ramo «archivio-avvisi» (avvisi/ai/), non chiama mai il modello e non conosce credenziali.
// Archivio originale (avvisi/indice.json, avvisi/comunicazioni/*.jsonl) mai modificato: le interpretazioni stanno in avvisi/ai/.
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const cal = require('./calendar');

const FORMATO = 1;
const PROMPT_VER = 'p1-2026-11-09';
// Modelli confrontati (catalogo e prezzi Workers AI verificati il 9/11/2026, developers.cloudflare.com/workers-ai/platform/pricing):
// neuroni per milione di token (piano gratuito: 10.000 neuroni al giorno, poi le richieste falliscono; nessun addebito sul piano Free).
const MODELLI = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { nin: 26668, nout: 204805, nome: 'Llama 3.3 70B (Meta)' },
  '@cf/google/gemma-4-26b-a4b-it': { nin: 9091, nout: 27273, nome: 'Gemma 4 26B A4B (Google)' },
};
const MODELLO_PREDEFINITO = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const TIPI = ['sospensione', 'deviazione', 'limitazione', 'spostamento_fermata', 'modifica_orari', 'potenziamento', 'ritardi', 'sciopero',
  'ripristino', 'ripristino_parziale', 'ripristino_progressivo', 'revoca', 'rettifica', 'informativa', 'altro'];
const RELAZIONI = ['aggiorna', 'ripristina', 'revoca', 'rettifica', 'stessa_notizia', 'indipendente'];
const SERVIZI = ['navigazione', 'automobilistico', 'entrambi', 'nessuno'];
const CERTEZZE = ['alta', 'media', 'bassa'];
// effetto dell'avviso (classify in avvisi.js) per tipo: usato solo quando le regole non riconoscono l'effetto («Avviso» generico)
const EFFETTO = { sospensione: 'no_service', deviazione: 'detour', limitazione: 'reduced', spostamento_fermata: 'stop_moved', modifica_orari: 'modified',
  potenziamento: 'additional', ritardi: 'delays', sciopero: 'strike' };

const SCHEMA = {
  type: 'object',
  properties: {
    servizio: { type: 'string', enum: SERVIZI },
    tipo: { type: 'string', enum: TIPI },
    linee: { type: 'array', items: { type: 'object', properties: {
      linea: { type: 'string' }, servizio: { type: 'string', enum: ['navigazione', 'automobilistico'] }, direzione: { type: ['string', 'null'] }, citazione: { type: 'string' } },
      required: ['linea', 'servizio', 'citazione'] } },
    fermate: { type: 'array', items: { type: 'object', properties: { nome: { type: 'string' }, citazione: { type: 'string' } }, required: ['nome', 'citazione'] } },
    periodi: { type: 'array', items: { type: 'object', properties: {
      inizio: { type: 'string' }, fine: { type: ['string', 'null'] }, citazione: { type: 'string' } }, required: ['inizio', 'citazione'] } },
    tratto: { type: ['string', 'null'] },
    relazioni: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, tipo: { type: 'string', enum: RELAZIONI }, motivo: { type: 'string' } }, required: ['id', 'tipo', 'motivo'] } },
    certezza: { type: 'string', enum: CERTEZZE },
    note: { type: 'string' },
  },
  required: ['servizio', 'tipo', 'linee', 'periodi', 'relazioni', 'certezza'],
};

// ---------------------------------------------------------------------------------------------------------------------
// PROMPT: istruzioni generali + conoscenze già presenti nel progetto (parole e simboli del servizio, convenzioni del canale, pontili con lettera)
// ---------------------------------------------------------------------------------------------------------------------
const SISTEMA = `Sei l'analista degli avvisi del trasporto pubblico ACTV di Venezia (navigazione: vaporetti, motonavi, ferry; automobilistico: autobus urbani ed extraurbani, tram T1/T2).
Leggi UNA comunicazione (notizia del sito ACTV o messaggio del canale Telegram «muoversivenezia») e restituisci SOLO un oggetto JSON conforme allo schema.

REGOLE
1. Interpreta il significato complessivo del testo. Non inventare: ogni linea, periodo e fermata deve avere una "citazione" copiata ESATTAMENTE dal testo (poche parole, senza modifiche).
2. Servizio. Navigazione: pontile, imbarcadero, approdo, vaporetto, battello, motonave, ferry, laguna, Lido, Giudecca, Murano, Burano, Pellestrina, emoji ⛴ 🛳 🚤 ⚓. Automobilistico: bus, autobus, tram, Mestre, Marghera, terraferma, capolinea, deviazione stradale, emoji 🚍 🚌 🚋. L'emoji 🚏 (fermata) NON indica il servizio: il canale la usa anche come punto elenco. Nell'intestazione Telegram «#muoversivenezia 🚍 | …» o «#muoversivenezia 🛳 | …» l'emoji prima di «|» indica il servizio.
3. Linee. Lo stesso numero può esistere in entrambi i servizi (es. linea 2 vaporetto e linea 2 bus): scegli il servizio dal contesto della frase. Una lettera tra virgolette dopo il nome di un approdo (P.le Roma "G", Rialto “C”) è la lettera del PONTILE, non una linea. Le date e gli orari non sono linee. Indica solo linee citate esplicitamente.
4. Periodi: data e ora locali di Venezia in formato AAAA-MM-GGTHH:MM. Usa l'anno della pubblicazione salvo indicazione diversa. "fine" null se non indicata. "Fino a inizio/termine servizio" senza ora: usa la data con 05:00 / 02:00 del giorno dopo solo se il testo lo giustifica, altrimenti null.
5. Tipo: sospensione (linea, fermata o approdo non servito), deviazione, limitazione (corse ridotte, tratta limitata), spostamento_fermata (fermata/capolinea provvisorio altrove), modifica_orari, potenziamento, ritardi, sciopero, ripristino (servizio tornato COMPLETAMENTE regolare), ripristino_parziale (solo alcune linee, una direzione o un tratto), ripristino_progressivo («sta tornando progressivamente regolare»), revoca (evento annullato o confermato regolare), rettifica, informativa (notizia senza effetto sul servizio), altro.
   Dichiara un ripristino SOLO se il testo lo afferma esplicitamente.
6. Relazioni: valuta solo le COMUNICAZIONI PRECEDENTI elencate (usa il loro id). "aggiorna", "ripristina", "revoca", "rettifica" solo se il testo riguarda chiaramente LO STESSO evento (stessa linea E stesso fatto, stesso giorno o stesso luogo, o riferimento esplicito/risposta). "stessa_notizia" se riporta la stessa notizia. "indipendente" per comunicazioni simili ma su eventi diversi (es. stessa linea, altro giorno o altro tratto). Nel dubbio non indicare relazioni.
7. certezza: "alta" solo se il testo è chiaro; "bassa" se mancano elementi.
La LETTURA AUTOMATICA DELLE REGOLE che ricevi è un supporto e può contenere errori: correggila se il testo dice altro.`;

const fmtRome = ms => { const p = cal.romeParts(ms), y = p.ymd; const h = Math.floor(p.secs / 3600), m = Math.floor(p.secs / 60) % 60;
  return `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

// testo completo di un record d'archivio (pagina ACTV se presente; per le risposte Telegram anche il messaggio citato, separato)
function testoDi(rec) {
  if (rec.src === 'rss') return { titolo: rec.title || '', corpo: String(rec.page || rec.text || '') };
  return { titolo: '', corpo: String(rec.text || ''), citato: rec.quote ? String(rec.quote) : '' };
}

function userPrompt(rec, { regole = null, catalogo = [], candidati = [] } = {}) {
  const t = testoDi(rec), out = [];
  out.push(`COMUNICAZIONE id=${rec.id} fonte=${rec.src === 'rss' ? 'sito ACTV' : 'Telegram'} pubblicata=${fmtRome(rec.pub)} (ora di Venezia)`);
  if (rec.src === 'tg' && rec.replyTo) { const k = candidati.findIndex(c => c.id === `tg:${rec.replyTo}`);
    out.push(`È una RISPOSTA al messaggio Telegram tg:${rec.replyTo}${k >= 0 ? ` (C${k + 1} tra le comunicazioni precedenti)` : ''}${t.citato ? `, che diceva: «${clip(t.citato, 400)}»` : ''}`); }
  if (rec.links?.length) out.push(`Link nel messaggio: ${rec.links.slice(0, 3).join(' ')}`);
  if (t.titolo) out.push(`TITOLO: ${t.titolo}`);
  out.push(`TESTO:\n${clip(t.corpo, 6000)}`);
  if (catalogo.length) out.push(`LINEE ESISTENTI (GTFS) per i numeri presenti nel testo: ${catalogo.map(c => `${c.n}=${c.s.map(s => s === 'nav' ? 'navigazione' : 'automobilistico').join('+')}`).join('; ')}`);
  if (regole) out.push(`LETTURA AUTOMATICA DELLE REGOLE (supporto, può sbagliare): linee ${regole.linee.join(', ') || 'nessuna'}; fermate ${regole.fermate.join(', ') || 'nessuna'}; periodo ${regole.periodo || 'non trovato'}; effetto ${regole.effetto || '?'}`);
  if (candidati.length) {
    out.push('COMUNICAZIONI PRECEDENTI (possibili relazioni):');
    candidati.forEach((c, i) => out.push(`- id=C${i + 1} ${c.src === 'rss' ? 'sito' : `Telegram tg:${String(c.id).slice(3)}`} ${fmtRome(c.pub)}: ${clip(c.sintesi, 380).replace(/\n+/g, ' ')}`));
    out.push('Nelle relazioni usa questi id (C1, C2, …).');
  } else out.push('COMUNICAZIONI PRECEDENTI: nessuna da valutare (relazioni: []).');
  out.push('Rispondi con il solo JSON.');
  return out.join('\n');
}

// id delle relazioni restituiti dal modello (C1… o, per tolleranza, l'id originale anche abbreviato «rss:10605») -> id d'archivio; sconosciuti invariati
function mapRelazioni(ai, candidati) {
  if (!ai || !Array.isArray(ai.relazioni)) return ai;
  const ids = candidati.map(c => c.id ?? c);
  const one = x => { const s = String(x || '').trim(), m = /^C(\d{1,2})$/i.exec(s); if (m) return ids[+m[1] - 1] ?? s;
    return ids.find(id => id === s || id.startsWith(s + ' ')) ?? s; };
  return { ...ai, relazioni: ai.relazioni.map(r => (r && typeof r === 'object' ? { ...r, id: one(r.id) } : r)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// CHIAMATA A WORKERS AI (REST): POST /accounts/{id}/ai/run/{modello}; credenziali solo da variabili d'ambiente, mai registrate nei log
// ---------------------------------------------------------------------------------------------------------------------
class QuotaError extends Error {}
class TransientError extends Error {}
class OutputError extends Error {}
const neuroniDi = (model, usage) => {
  const m = MODELLI[model]; if (!m || !usage) return null;
  const i = +usage.prompt_tokens || 0, o = +usage.completion_tokens || 0;
  return Math.round((i * m.nin + o * m.nout) / 1e6 * 10) / 10;
};
// estrae il JSON dalla risposta: oggetto già decodificato (JSON mode), stringa, formato OpenAI (choices), con eventuali ``` attorno
function parseOutput(result) {
  let r = result?.response ?? result?.choices?.[0]?.message?.content ?? result?.output_text ?? result;
  if (r && typeof r === 'object' && !Array.isArray(r) && ('servizio' in r || 'tipo' in r)) return r;
  if (typeof r !== 'string') throw new OutputError('risposta senza testo');
  r = r.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const a = r.indexOf('{'), b = r.lastIndexOf('}');
  if (a < 0 || b < a) throw new OutputError('risposta senza JSON');
  try { return JSON.parse(r.slice(a, b + 1)); } catch { throw new OutputError('JSON non valido'); }
}
async function chiama({ accountId, token, model = MODELLO_PREDEFINITO, messages, fetchImpl = fetch, timeoutMs = 90000 }) {
  if (!accountId || !token) throw new Error('credenziali Cloudflare mancanti');
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error('Account ID Cloudflare non valido (32 caratteri esadecimali)');
  if (!MODELLI[model]) throw new Error('modello non previsto: ' + model);
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const body = { messages, temperature: 0, max_tokens: 900, response_format: { type: 'json_schema', json_schema: SCHEMA } };
  const pulisci = s => String(s || '').split(token).join('***').slice(0, 300);
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { throw new TransientError('rete: ' + pulisci(e.message)); }
  let j = null; const raw = await res.text().catch(() => '');
  try { j = JSON.parse(raw); } catch { /* risposta non JSON */ }
  const errs = (j?.errors || []).map(e => `${e.code || ''} ${e.message || ''}`.trim()).join('; ');
  const msg = pulisci(errs || raw);
  if (res.status === 429 || /neuron|daily free allocation|quota|rate limit/i.test(errs)) throw new QuotaError(`quota Workers AI esaurita o limite raggiunto (HTTP ${res.status}): ${msg}`);
  if (res.status === 401 || res.status === 403) throw new Error(`accesso negato da Cloudflare (HTTP ${res.status}): controlla token e Account ID`);
  if (res.status >= 500) throw new TransientError(`Cloudflare HTTP ${res.status}: ${msg}`);
  if (!res.ok || !j?.success) {
    if (/json mode couldn't be met|json/i.test(msg)) throw new OutputError('il modello non ha prodotto il JSON richiesto: ' + msg);
    throw new Error(`Cloudflare HTTP ${res.status}: ${msg}`);
  }
  const usage = j.result?.usage || null;
  return { json: parseOutput(j.result), usage, neuroni: neuroniDi(model, usage) };
}

// ---------------------------------------------------------------------------------------------------------------------
// VALIDAZIONE (anche sul server, con i GTFS in uso): la validità formale del JSON non basta, ogni dato deve essere sostenuto dal testo
// ---------------------------------------------------------------------------------------------------------------------
const plain = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[“”«»„″]/g, '"').replace(/[‘’`´]/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const LINE_RE = /^(?:[A-Z]{0,3}\d{1,3}(?:\.\d)?[A-Z]{0,3}|[A-Z]{1,3})$/;
const LINE_WORD = /\b(?:line[ae]|bus|autobus|tram|navett\w*|vaporett\w*|motonav\w*|ferry|corse?)\b/;
// ora locale di Venezia (AAAA-MM-GGTHH:MM) -> ms
function romeLocalMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || '')); if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number); if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const ymd = `${m[1]}${m[2]}${m[3]}`, secs = h * 3600 + mi * 60;
  for (const off of [60, 120]) { const ms = Date.UTC(y, mo - 1, d, h, mi) - off * 60e3, p = cal.romeParts(ms); if (p.ymd === ymd && p.secs === secs) return ms; }
  return null;
}
// ai: JSON del modello; rec: record d'archivio interpretato; ctx: contesto GTFS (known: numero -> [{n,s,c}]); candidati: id proposti al modello
function validate(ai, rec, ctx = null, candidati = []) {
  const scarti = [], out = { ok: false, formale: false, servizio: null, tipo: null, effetto: null, linee: [], periodo: null, relazioni: [], certezza: null, scarti };
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) { scarti.push('risposta non è un oggetto'); return out; }
  if (!SERVIZI.includes(ai.servizio)) { scarti.push('servizio non valido'); return out; }
  if (!TIPI.includes(ai.tipo)) { scarti.push('tipo non valido'); return out; }
  if (!CERTEZZE.includes(ai.certezza)) { scarti.push('certezza non valida'); return out; }
  out.formale = true;   // struttura corretta: da qui in poi si scartano i singoli dati non sostenuti dal testo
  out.servizio = ai.servizio; out.tipo = ai.tipo; out.certezza = ai.certezza; out.effetto = EFFETTO[ai.tipo] || null;
  const t = testoDi(rec), full = plain([t.titolo, t.corpo].join('\n')), cites = c => { const p = plain(c); return p.length >= 2 && full.includes(p); };
  // LINEE: citazione presente nel testo, numero nella citazione, parola di linea nella citazione, servizio dichiarato in cui la linea esiste
  const seen = new Set();
  for (const l of Array.isArray(ai.linee) ? ai.linee : []) {
    const n = String(l?.linea || '').toUpperCase().replace(/^(?:LINEA|LINEE|BUS|TRAM)\s+/, '').trim(), s = l?.servizio === 'navigazione' ? 'nav' : l?.servizio === 'automobilistico' ? 'aut' : null;
    if (!LINE_RE.test(n) || !s) { scarti.push(`linea "${clip(l?.linea, 12)}": formato o servizio non valido`); continue; }
    if (!cites(l.citazione)) { scarti.push(`linea ${n}: citazione non presente nel testo`); continue; }
    const pc = plain(l.citazione);
    if (!new RegExp(`(?:^|[^a-z0-9.])${n.toLowerCase().replace(/\./g, '\\.')}(?![a-z0-9])`).test(pc)) { scarti.push(`linea ${n}: non compare nella citazione`); continue; }
    // numeri semplici e lettere (2, 13, N, G) si confondono con date, orari e pontili: servono «linea/linee/bus…» nella citazione; codici come T1, 4.1, 6E no
    if (/^(?:\d{1,3}|[A-Z]{1,2})$/.test(n) && !LINE_WORD.test(pc)) { scarti.push(`linea ${n}: la citazione non parla di linee`); continue; }
    if (new RegExp(`"\\s*${n.toLowerCase()}\\s*"`).test(pc) && n.length <= 2 && /^[A-Z]+$/.test(n)) { scarti.push(`linea ${n}: lettera di pontile tra virgolette`); continue; }
    const kn = ctx?.known?.get(n);
    if (ctx?.known && !(kn || []).some(x => x.s === s)) { scarti.push(`linea ${n}: non esiste nel servizio ${l.servizio}`); continue; }
    if (seen.has(s + ':' + n)) continue; seen.add(s + ':' + n);
    out.linee.push({ n: kn?.find(x => x.s === s)?.n || n, s, c: kn?.find(x => x.s === s)?.c || null });
  }
  // PERIODI: citazione nel testo con il giorno indicato; anno plausibile rispetto alla pubblicazione; fine dopo l'inizio
  let from = null, to = null;
  for (const p of Array.isArray(ai.periodi) ? ai.periodi : []) {
    const a = romeLocalMs(p?.inizio), b = p?.fine == null ? null : romeLocalMs(p.fine);
    if (a == null || (p?.fine != null && b == null)) { scarti.push('periodo: data non valida'); continue; }
    if (!cites(p.citazione)) { scarti.push('periodo: citazione non presente nel testo'); continue; }
    const day = +String(p.inizio).slice(8, 10);
    if (!new RegExp(`(?:^|\\D)0?${day}(?!\\d)`).test(plain(p.citazione)) && !/\boggi\b|\bstasera\b|\bdomani\b/.test(plain(p.citazione))) { scarti.push('periodo: il giorno non compare nella citazione'); continue; }
    if (a < rec.pub - 45 * 864e5 || a > rec.pub + 400 * 864e5) { scarti.push('periodo: data lontana dalla pubblicazione'); continue; }
    const yr = String(p.inizio).slice(0, 4);
    if (yr !== cal.romeYmd(rec.pub).slice(0, 4) && a > rec.pub + 90 * 864e5 && !plain(p.citazione).includes(yr)) { scarti.push('periodo: anno diverso non indicato nel testo'); continue; }
    if (b != null && b <= a) { scarti.push('periodo: fine prima dell\'inizio'); continue; }
    from = from == null ? a : Math.min(from, a); if (b != null) to = to == null ? b : Math.max(to, b);
  }
  if (from != null && to != null) out.periodo = { from, to };
  // RELAZIONI: solo verso comunicazioni proposte al modello
  const cset = new Set(candidati);
  for (const r of Array.isArray(ai.relazioni) ? ai.relazioni : []) {
    if (!RELAZIONI.includes(r?.tipo)) { scarti.push('relazione: tipo non valido'); continue; }
    if (r.id === rec.id || !cset.has(r.id)) { scarti.push(`relazione verso ${clip(r?.id, 20)}: comunicazione non proposta`); continue; }
    if (!out.relazioni.some(x => x.id === r.id)) out.relazioni.push({ id: r.id, tipo: r.tipo });
  }
  // relazioni contraddittorie sullo stesso evento (es. «aggiorna» A e «aggiorna» B): nessuna scelta automatica
  if (out.relazioni.filter(r => r.tipo !== 'indipendente' && r.tipo !== 'stessa_notizia').length > 1) { scarti.push('più eventi indicati: relazioni ignorate'); out.relazioni = out.relazioni.filter(r => r.tipo === 'indipendente'); }
  // citazioni inventate per almeno metà dei dati citati: la risposta non descrive questo testo, non si usa nulla (nemmeno servizio e tipo)
  const inventate = scarti.filter(x => /citazione non presente/.test(x)).length, buone = out.linee.length + (out.periodo ? 1 : 0);
  out.ok = out.certezza !== 'bassa' && !(inventate && inventate >= buone);
  if (out.certezza === 'bassa') scarti.push('certezza bassa: interpretazione non usata');
  else if (!out.ok) scarti.push('citazioni non presenti nel testo: interpretazione non usata');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// ARCHIVIO DELLE INTERPRETAZIONI: <cartella>/indice.json + <cartella>/interpretazioni/AAAA-MM.jsonl (mese della comunicazione)
// riga: { id, hash, v, modello, prompt, at, esito: 'ok'|'non_valido'|'errore', ai?, candidati, neuroni?, motivo? }
// ---------------------------------------------------------------------------------------------------------------------
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const monthOf = ms => { const y = cal.romeYmd(ms); return `${y.slice(0, 4)}-${y.slice(4, 6)}`; };
const MAX_TENTATIVI = 2;   // risposte non valide per la stessa versione: poi si rinuncia (resta il funzionamento a regole) salvo --forza
function mergeAi(text, into = new Map()) {
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.id !== 'string' || typeof r.hash !== 'string') continue;
    const k = r.id + '|' + r.hash, e = into.get(k) || { last: null, ok: null, tentativi: 0 };
    e.tentativi++; e.last = r; if (r.esito === 'ok') e.ok = r;
    into.set(k, e);
  }
  return into;
}
function openAiDir(dir) {
  const map = new Map(), files = path.join(dir, 'interpretazioni');
  if (fs.existsSync(files)) for (const f of fs.readdirSync(files).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()) mergeAi(fs.readFileSync(path.join(files, f), 'utf8'), map);
  const added = [];
  return {
    map,
    // già interpretata (o rinunciata dopo MAX_TENTATIVI risposte non valide) questa versione del testo?
    fatto(id, hash) { const e = map.get(id + '|' + hash); return !!e && (!!e.ok || e.tentativi >= MAX_TENTATIVI); },
    add(row, pub) { added.push({ row, pub }); mergeAi(JSON.stringify(row), map); },
    save(now, info = {}) {
      if (!added.length) return false;
      fs.mkdirSync(files, { recursive: true });
      const byMonth = new Map(); for (const { row, pub } of added) { const k = monthOf(pub); (byMonth.get(k) || byMonth.set(k, []).get(k)).push(row); }
      for (const [k, rows] of byMonth) fs.appendFileSync(path.join(files, `${k}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      const list = fs.readdirSync(files).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().map(f => {
        const t = fs.readFileSync(path.join(files, f), 'utf8'); return { nome: f, righe: t.split('\n').filter(Boolean).length, sha: sha(t).slice(0, 16) };
      });
      fs.writeFileSync(path.join(dir, 'indice.json'), JSON.stringify({ formato: FORMATO, aggiornato: now, ...info, file: list }, null, 1) + '\n');
      added.length = 0; return true;
    },
  };
}
// consumo giornaliero stimato (giorno UTC, come l'azzeramento della quota Cloudflare)
function consumo(dir) {
  const f = path.join(dir, 'consumo.json'), oggi = new Date().toISOString().slice(0, 10);
  let c = { giorno: oggi, neuroni: 0, richieste: 0 };
  try { const x = JSON.parse(fs.readFileSync(f, 'utf8')); if (x.giorno === oggi) c = x; } catch { /* nuovo */ }
  return { get: () => c, add(n) { c.neuroni = Math.round((c.neuroni + (n || 0)) * 10) / 10; c.richieste++; }, save() { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(c, null, 1) + '\n'); } };
}

module.exports = { mapRelazioni, FORMATO, PROMPT_VER, MODELLI, MODELLO_PREDEFINITO, TIPI, RELAZIONI, SCHEMA, SISTEMA, EFFETTO, userPrompt, testoDi, chiama, parseOutput, neuroniDi,
  validate, romeLocalMs, plain, mergeAi, openAiDir, consumo, monthOf, QuotaError, TransientError, OutputError, MAX_TENTATIVI };
