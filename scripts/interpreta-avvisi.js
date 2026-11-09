#!/usr/bin/env node
// INTERPRETAZIONE AI DELLE COMUNICAZIONI ARCHIVIATE (Cloudflare Workers AI). Stesso codice per il workflow GitHub e per le prove locali.
//
// NEL WORKFLOW (.github/workflows/archivio-avvisi.yml, dopo l'archiviazione):
//   node scripts/interpreta-avvisi.js --archivio archivio/avvisi --out archivio/avvisi/ai
//   Interpreta solo le comunicazioni nuove o modificate (id + impronta del testo non ancora interpretati), dalle più recenti, entro i limiti
//   per esecuzione e per giorno. Scrive SOLO in avvisi/ai/ (le comunicazioni originali non si toccano). Stampa AI_CHANGES=0|1.
//
// IN LOCALE (Windows/macOS/Linux, Node 22): legge l'archivio da GitHub (o da una cartella) e scrive in tmp/ai-test/. Non modifica nulla altrove.
//   node scripts/interpreta-avvisi.js --id tg:11897              una o più comunicazioni (separate da virgola)
//   node scripts/interpreta-avvisi.js --mese 2026-11             un mese (mese di pubblicazione, ora di Venezia)
//   node scripts/interpreta-avvisi.js --tutto                    tutto l'archivio (attenzione alla quota giornaliera)
//   node scripts/interpreta-avvisi.js --casi                     i casi di riferimento (tests/avvisi-ai-casi.json), con punteggio
//   node scripts/interpreta-avvisi.js --casi --confronta         i casi con i due modelli candidati, uno dopo l'altro, e confronto
//   altre opzioni: --forza (rielabora anche ciò che è già interpretato), --max N, --modello <id>, --archivio <cartella|github>,
//                  --out <cartella>, --senza-ai (prepara i prompt senza chiamare il modello: nessuna quota)
// Credenziali: CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN dall'ambiente (GitHub Secrets) o dal file .env.local (escluso da Git). Mai stampate.
const fs = require('fs'), path = require('path');
const A = require('../avvisi'), AR = require('../avvisi-archivio'), AI = require('../avvisi-ai');

const ROOT = path.join(__dirname, '..'), DAY = 864e5;
const SERVICE = /\b(?:pinned (?:a |an )?(?:photo|message|video|file|poll|sticker|gif|audio)|ha fissato)\b/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function args(argv) {
  const o = { ids: null, mese: null, tutto: false, casi: false, forza: false, confronta: false, senzaAi: false, max: null, modello: null, archivio: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--id') o.ids = String(next() || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--mese') o.mese = next();
    else if (a === '--tutto') o.tutto = true;
    else if (a === '--casi') o.casi = true;
    else if (a === '--forza') o.forza = true;
    else if (a === '--confronta') o.confronta = true;
    else if (a === '--senza-ai') o.senzaAi = true;
    else if (a === '--max') o.max = Math.max(1, +next() || 1);
    else if (a === '--modello') o.modello = next();
    else if (a === '--archivio') o.archivio = next();
    else if (a === '--out') o.out = next();
    else throw new Error('opzione sconosciuta: ' + a);
  }
  if (o.mese && !/^\d{4}-\d{2}$/.test(o.mese)) throw new Error('--mese vuole AAAA-MM');
  return o;
}
// .env.local: righe CHIAVE=valore (solo le chiavi previste; le variabili d'ambiente già impostate hanno la precedenza)
function envLocal(file = path.join(ROOT, '.env.local')) {
  const keys = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'AI_MODELLO', 'AI_MAX_NEURONI_GIORNO', 'AI_MAX_PER_ESECUZIONE'];
  let t = ''; try { t = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of t.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line); if (!m || !keys.includes(m[1]) || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ARCHIVIO: cartella locale (workflow) o lettura pubblica da GitHub (prove locali), sempre in sola lettura
async function loadArchive(src) {
  if (src && src !== 'github') { const d = AR.openDir(path.resolve(src)); return d.recs; }
  const base = AR.baseUrl() || 'https://raw.githubusercontent.com/nickg1093/TPL-Venezia/archivio-avvisi/avvisi';
  const get = async name => { const r = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`archivio GitHub: HTTP ${r.status} per ${name}`); return r.text(); };
  const idx = JSON.parse(await get('indice.json')), recs = new Map();
  for (const f of idx.file || []) if (/^\d{4}-\d{2}\.jsonl$/.test(f.nome)) AR.mergeLines(await get(`comunicazioni/${f.nome}`), recs);
  return recs;
}

// CONTESTO GTFS (come server.js): catalogo delle linee per servizio, nomi delle fermate, fermate servite. Facoltativo: senza, il prompt non ha il catalogo.
async function loadCtx() {
  try {
    const gtfs = require('../gtfs'), log = console.log; console.log = () => {};
    let D; try { D = { nav: await gtfs.load('nav', { force: true }), aut: await gtfs.load('aut', { force: true }) }; } finally { console.log = log; }
    const known = new Map(), byName = new Map(), lineStops = new Map(), names = new Map(); const add = (k, id) => { if (k) (byName.get(k) || byName.set(k, []).get(k)).push(id); };
    for (const i of ['nav', 'aut']) { const G = D[i]; if (!G?.routes) continue;
      for (const r of Object.values(G.routes)) if (r?.name) { const k = String(r.name).toUpperCase(), l = known.get(k) || known.set(k, []).get(k); if (!l.some(x => x.s === i)) l.push({ n: r.name, s: i, c: r.color || null }); }
      const nm = s => G.stopBaseNames?.get(s) || G.stops[s] || '';
      for (const s in G.stopIndex || {}) { const id = `${i}:${s}`, full = nm(s), bare = full.replace(/\s*[“"'‘’”]\s*[A-Za-z0-9]{1,2}\s*[“"'‘’”]\s*$/, ''); names.set(id, full); const k1 = A.norm(full), k2 = A.norm(bare); add(k1, id); if (k2 && k2 !== k1) add(k2, id); }
      const byRoute = new Map(), seen = new Set();
      for (const tid of G.tripIds || []) { const tr = G.trips[tid], st = G.stopTimes.get(tid); if (!tr || !st) continue; const key = `${tr.route}|${tr.shape}|${st.s.length}`; if (seen.has(key)) continue; seen.add(key); const set = byRoute.get(tr.route) || byRoute.set(tr.route, new Set()).get(tr.route); for (const sid of st.s) set.add(`${i}:${sid}`); }
      for (const [rid, set] of byRoute) { const r = G.routes[rid]; if (!r?.name) continue; const k = `${i}:${String(r.name).toUpperCase()}`, out = lineStops.get(k) || lineStops.set(k, new Set()).get(k); for (const id of set) out.add(id); } }
    return { v: 1, known, byName, lineStops, nameOf: id => names.get(id) || id };
  } catch (e) { console.log(`ai: GTFS non disponibili (${e.message}): il prompt non avrà il catalogo delle linee`); return null; }
}

// supporto delle regole esistenti per il prompt: linee, fermate, periodo ed effetto letti da avvisi.js
function rulesOf(rec, ctx) {
  const t = AI.testoDi(rec), full = (t.titolo ? t.titolo + '\n' : '') + t.corpo;
  try {
    const an = ctx ? A.analyze(t.titolo || t.corpo.split('\n')[0], t.corpo, ctx) : { lines: [], stopNames: [] };
    const pv = A.parseValidity(full, rec.pub, rec.src === 'rss' ? 'rss' : 'tg', ctx);
    const f = ms => { const p = new Date(ms).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); return p; };
    const eff = A.classify({ title: t.titolo, text: t.corpo });
    return { linee: an.lines.map(l => `${l.n} (${l.s === 'nav' ? 'navigazione' : 'automobilistico'})`), lk: an.lines.map(l => l.s + ':' + l.n),
      fermate: (an.stopNames || []).map(x => x.n).slice(0, 12), periodo: pv.dated ? `${f(pv.from)} → ${f(pv.to)}` : null, effetto: eff.effectLabel };
  } catch { return null; }
}
// numeri di linea citati nel testo (dopo «linea/linee/bus/tram…») con i servizi in cui esistono
function catalogOf(rec, ctx) {
  if (!ctx?.known) return [];
  const t = AI.testoDi(rec), s = `${t.titolo}\n${t.corpo}`, out = new Map();
  for (const m of s.matchAll(/\b(?:line[ae]|bus|autobus|tram|navett\w*|vaporett\w*)\b([^.;:\n]{0,80})/gi))
    for (const x of m[1].matchAll(/(?<![\w.])([A-Za-z]{0,3}\d{1,3}(?:\.\d)?[A-Za-z]{0,3}|[A-Z]{1,2})(?![\w])/g)) {
      const k = x[1].toUpperCase(), c = ctx.known.get(k); if (c && !out.has(k)) out.set(k, { n: k, s: [...new Set(c.map(y => y.s))] });
    }
  return [...out.values()].slice(0, 20);
}
// comunicazioni precedenti da proporre come possibili relazioni (al massimo 8): risposta, stesso link, linee o parole in comune, ultimi 21 giorni
const WORD = /[a-zà-ù]{5,}/g;
function candidatesOf(rec, all) {
  const t = AI.testoDi(rec), txt = AI.plain(`${t.titolo} ${t.corpo}`), words = new Set(txt.match(WORD) || []);
  const nums = new Set((txt.match(/\b(?:t[12]|\d{1,2}[a-z]?)\b/g) || []));
  const out = [];
  for (const e of all.values()) {
    const c = e.last; if (c.id === rec.id || c.pub >= rec.pub) continue;
    const reply = rec.src === 'tg' && rec.replyTo && c.id === `tg:${rec.replyTo}`;
    const link = (rec.links || []).some(l => c.url === l);
    if (!reply && !link && rec.pub - c.pub > 21 * DAY) continue;
    const ct = AI.testoDi(c), cx = AI.plain(`${ct.titolo} ${ct.corpo}`), cw = new Set(cx.match(WORD) || []);
    let common = 0; for (const w of words) if (cw.has(w)) common++;
    const ov = words.size ? common / Math.min(words.size, cw.size || 1) : 0;
    const cn = new Set((cx.match(/\b(?:t[12]|\d{1,2}[a-z]?)\b/g) || [])), lw = /\bline[ae]\b/.test(cx) && /\bline[ae]\b/.test(txt);
    let sn = 0; if (lw) for (const n of nums) if (cn.has(n)) sn++;   // numeri in comune contano solo se entrambi i testi parlano di linee (non date o orari)
    const recent = Math.max(0, 6 - 2 * (rec.pub - c.pub) / DAY);   // a parità di somiglianza, prima le più vicine nel tempo (stesso giorno +6, dopo 3 giorni 0)
    const score = (reply ? 100 : 0) + (link ? 50 : 0) + ov * 20 + Math.min(sn, 3) * 2 + (ov >= 0.15 || sn ? recent : 0);
    if (score < 6 && !reply && !link) continue;
    out.push({ id: c.id, src: c.src, pub: c.pub, sintesi: (ct.titolo ? ct.titolo + ' — ' : '') + ct.corpo, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

// riepilogo leggibile di un'interpretazione validata
function summary(v) {
  if (!v) return '—';
  const p = v.periodo ? `${new Date(v.periodo.from).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })} → ${new Date(v.periodo.to).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}` : 'nessun periodo';
  return `${v.ok ? 'USABILE' : 'NON USATA'} · servizio ${v.servizio} · tipo ${v.tipo} · linee ${v.linee.map(l => l.s + ':' + l.n).join(', ') || 'nessuna'} · ${p} · relazioni ${v.relazioni.map(r => `${r.tipo}→${r.id.split(' ')[0]}`).join(', ') || 'nessuna'} · certezza ${v.certezza}${v.scarti.length ? ` · scarti: ${v.scarti.join('; ')}` : ''}`;
}
// punteggio rispetto a un caso di riferimento (tests/avvisi-ai-casi.json)
function score(caso, v, candIds) {
  const res = [];
  const ok = (nome, cond) => res.push({ nome, ok: !!cond });
  if (!v) { ok('risposta valida', false); return res; }
  ok('servizio', caso.servizio.includes(v.servizio));
  ok('tipo', caso.tipo.includes(v.tipo));
  if (caso.linee) ok('linee', JSON.stringify(v.linee.map(l => l.s + ':' + l.n).sort()) === JSON.stringify([...caso.linee].sort()));
  for (const a of caso.attese || []) if (candIds.includes(a.id)) ok(`relazione attesa ${a.id.split(' ')[0]}`, v.relazioni.some(r => r.id === a.id && a.tipi.includes(r.tipo)));
  for (const a of caso.vietate || []) ok(`nessuna relazione ${a.id.split(' ')[0]}`, !v.relazioni.some(r => r.id === a.id && a.tipi.includes(r.tipo)));
  ok('usabile (certezza non bassa)', v.ok);
  return res;
}

async function main(argv = process.argv.slice(2), { fetchImpl = fetch, ctx: ctxIn, now = Date.now(), pausa = 1 } = {}) {
  const CI = !!process.env.GITHUB_ACTIONS;   // nel workflow GitHub
  const o = args(argv); envLocal();
  const out = path.resolve(o.out || (CI ? '' : path.join(ROOT, 'tmp', 'ai-test')));
  if (!o.out && CI) throw new Error('nel workflow serve --out');
  if (!o.archivio && CI) throw new Error('nel workflow serve --archivio');
  const arcDir = o.archivio && o.archivio !== 'github' ? path.resolve(o.archivio) : null;
  // in locale non si scrive mai dentro l'archivio (né nelle sue sottocartelle): solo nella cartella delle prove
  if (!CI && arcDir && (out + path.sep).startsWith(arcDir + path.sep)) throw new Error('in locale i risultati non si scrivono dentro la cartella dell\'archivio: usa --out tmp/ai-test');
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  const modelli = o.confronta ? Object.keys(AI.MODELLI) : [o.modello || process.env.AI_MODELLO || AI.MODELLO_PREDEFINITO];
  for (const m of modelli) if (!AI.MODELLI[m]) throw new Error('modello non previsto: ' + m + ' (ammessi: ' + Object.keys(AI.MODELLI).join(', ') + ')');
  const maxRun = o.max || +process.env.AI_MAX_PER_ESECUZIONE || (CI ? 12 : 25);
  const budget = +process.env.AI_MAX_NEURONI_GIORNO || 8000;
  if (!o.senzaAi && (!accountId || !token)) {
    console.log('ai: credenziali Cloudflare non configurate (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN): nessuna interpretazione, gli avvisi usano le sole regole');
    console.log('AI_CHANGES=0'); return { changes: false, motivo: 'credenziali' };
  }

  const recs = await loadArchive(o.archivio || 'github');
  const casi = o.casi ? JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'avvisi-ai-casi.json'), 'utf8')).casi : null;
  let sel = [...recs.values()].map(e => e.last).filter(r => !(r.src === 'tg' && SERVICE.test(r.text || '')) && (r.text || r.page || r.title));
  if (o.ids) sel = sel.filter(r => o.ids.includes(r.id) || o.ids.some(x => r.id.startsWith(x + ' ')));
  else if (casi) sel = sel.filter(r => casi.some(c => c.id === r.id));
  else if (o.mese) sel = sel.filter(r => AI.monthOf(r.pub) === o.mese);
  sel.sort((a, b) => b.pub - a.pub);

  const ctx = sel.length ? (ctxIn !== undefined ? ctxIn : await loadCtx()) : null;
  const report = [], stats = {};
  let changes = false, stop = null;
  const cons = AI.consumo(out);
  for (const modello of modelli) {
    const dir = o.confronta ? path.join(out, 'confronto', modello.replace(/[^a-z0-9.-]+/gi, '_')) : out;
    const store = AI.openAiDir(dir), st = stats[modello] = { richieste: 0, valide: 0, usabili: 0, nonValide: 0, errori: 0, neuroni: 0, ms: 0, punti: 0, puntiMax: 0 };
    let todo = (o.forza || o.ids || casi) ? sel : sel.filter(r => !store.fatto(r.id, r.hash));
    if (!o.tutto && !o.ids && !casi && !o.mese && !CI) todo = todo.slice(0, maxRun);   // in locale senza selezione: solo le più recenti
    let n = 0;
    for (const rec of todo) {
      if (n >= maxRun && !o.ids && !casi) { report.push(`limite di ${maxRun} comunicazioni per esecuzione raggiunto (le altre alla prossima)`); break; }
      const c = cons.get();
      if (!o.senzaAi && c.neuroni + (st.richieste ? st.neuroni / st.richieste : 250) > budget) { stop = `limite giornaliero stimato di ${budget} neuroni raggiunto (${c.neuroni} usati oggi): riprende domani`; break; }
      const cand = candidatesOf(rec, recs), regole = rulesOf(rec, ctx), catalogo = catalogOf(rec, ctx);
      const messages = [{ role: 'system', content: AI.SISTEMA }, { role: 'user', content: AI.userPrompt(rec, { regole, catalogo, candidati: cand }) }];
      if (o.senzaAi) {
        fs.mkdirSync(path.join(out, 'prompt'), { recursive: true });
        fs.writeFileSync(path.join(out, 'prompt', rec.id.split(' ')[0].replace(/[^a-z0-9]+/gi, '_') + '.txt'), messages.map(m => `### ${m.role}\n${m.content}`).join('\n\n') + '\n');
        report.push(`${rec.id.split(' ')[0]}: prompt preparato (${messages[1].content.length} caratteri)`); n++; continue;
      }
      n++; st.richieste++;
      const row = { id: rec.id, hash: rec.hash, v: rec.v || 1, modello, prompt: AI.PROMPT_VER, at: now, candidati: cand.map(x => x.id) };
      const t0 = Date.now();
      let res = null, err = null;
      for (let tent = 0; tent < 2 && !res; tent++) {
        try { res = await AI.chiama({ accountId, token, model: modello, messages, fetchImpl }); }
        catch (e) { err = e; if (e instanceof AI.TransientError && tent === 0) { await sleep(5000 * pausa); continue; } break; }
      }
      st.ms += Date.now() - t0;
      if (!res) {
        if (err instanceof AI.QuotaError) { stop = err.message; st.richieste--; break; }
        if (err instanceof AI.OutputError) { st.nonValide++; store.add({ ...row, esito: 'non_valido', motivo: err.message.slice(0, 200) }, rec.pub); changes = true; report.push(`${rec.id.split(' ')[0]} [${modello}]: risposta non valida (${err.message.slice(0, 120)})`); continue; }
        if (err instanceof AI.TransientError) { st.errori++; report.push(`${rec.id.split(' ')[0]} [${modello}]: errore temporaneo, riprova alla prossima esecuzione (${err.message.slice(0, 120)})`); continue; }
        stop = err.message; st.errori++; break;   // credenziali o richiesta rifiutata: inutile continuare
      }
      st.neuroni += res.neuroni || 0; cons.add(res.neuroni);
      res.json = AI.mapRelazioni(res.json, row.candidati);   // C1, C2… -> id d'archivio (così il server rivalida senza il prompt)
      const v = AI.validate(res.json, rec, ctx, row.candidati);
      const formale = v.formale;
      if (formale) st.valide++; else st.nonValide++;
      if (v.ok) st.usabili++;
      store.add({ ...row, esito: formale ? 'ok' : 'non_valido', ai: res.json, neuroni: res.neuroni, verifica: { usabile: v.ok, scarti: v.scarti.slice(0, 10) } }, rec.pub);
      changes = true;
      let line = `${rec.id.split(' ')[0]} [${modello}] (${res.neuroni ?? '?'} neuroni)\n   AI     : ${summary(v)}\n   regole : linee ${regole?.lk.join(', ') || 'nessuna'} · periodo ${regole?.periodo || 'non trovato'} · effetto ${regole?.effetto || '?'}`;
      const caso = casi?.find(x => x.id === rec.id);
      if (caso) { const sc = score(caso, v, row.candidati), p = sc.filter(x => x.ok).length; st.punti += p; st.puntiMax += sc.length; line += `\n   caso   : ${p}/${sc.length} ${sc.filter(x => !x.ok).map(x => '✗ ' + x.nome).join(', ')}`; }
      report.push(line);
      await sleep(500 * pausa);
    }
    store.save(now, { modello, prompt: AI.PROMPT_VER });
    if (stop) break;
  }
  if (!o.senzaAi) cons.save();
  // rapporto
  const head = [`Interpretazione AI · ${new Date(now).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })} · archivio ${o.archivio || 'github'} · risultati in ${out}`];
  for (const [m, s] of Object.entries(stats)) head.push(`${m}: ${s.richieste} richieste, ${s.valide} JSON validi, ${s.usabili} usabili, ${s.nonValide} non validi, ${s.errori} errori, ${Math.round(s.neuroni)} neuroni (media ${s.richieste ? Math.round(s.neuroni / s.richieste) : 0}), ${s.richieste ? Math.round(s.ms / s.richieste) : 0} ms per richiesta${s.puntiMax ? `, casi di riferimento ${s.punti}/${s.puntiMax}` : ''}`);
  head.push(`consumo stimato oggi (UTC, solo da questa cartella): ${cons.get().neuroni} neuroni su ${budget} di limite prudenziale (quota gratuita Cloudflare: 10.000)`);
  if (stop) head.push('INTERROTTO: ' + stop);
  const text = head.join('\n') + '\n\n' + report.join('\n') + '\n';
  console.log(text);
  if (!CI) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `rapporto-${new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`), text); }
  console.log(`AI_CHANGES=${changes ? 1 : 0}`);
  return { changes, stats, stop, report };
}

if (require.main === module) main().catch(e => { console.error('ai: errore: ' + e.message); console.log('AI_CHANGES=0'); process.exit(process.env.GITHUB_ACTIONS ? 0 : 1); });
module.exports = { main, args, candidatesOf, catalogOf, rulesOf, score, envLocal };
