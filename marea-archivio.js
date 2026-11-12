// ARCHIVIO DELLA MAREA: i livelli già letti non si perdono più con un riavvio o un nuovo deploy di Render (disco non permanente).
//  · SCRITTURA: solo il workflow GitHub «archivio-marea» (scripts/archivia-marea.js), sul ramo separato «archivio-marea»: legge il livello
//    dal Centro Maree ogni 5 minuti e aggiunge le letture nuove. Il server non scrive mai (nessuna credenziale su Render).
//  · LETTURA: il server legge i file pubblici del ramo (raw.githubusercontent.com) all'avvio e ricostruisce le ultime ore (tide.js).
//  · FORMATO: marea/AAAA-MM-GG.jsonl (giorno UTC), una riga per lettura, in ordine di tempo:
//      { t: istante in ms UTC, cm: livello in cm (null = dato mancante), st: id della stazione, f: "cpsm", s: "grezzo" | "mancante" }
//    «grezzo»: valore così come pubblicato dal Centro Maree (non validato). Nessun duplicato: una riga per stazione e istante.
//  · CONSERVAZIONE: 400 giorni (circa 12 kB al giorno), i file più vecchi si cancellano dal ramo.
const KEEP_DAYS = 400, STATI = new Set(['grezzo', 'mancante']), MAX_FILE = 2e6;
const dayOf = t => new Date(t).toISOString().slice(0, 10);
const valid = r => r && typeof r === 'object' && Number.isFinite(r.t) && r.t > 946684800000 && r.t < 4102444800000
  && (r.cm === null || (Number.isInteger(r.cm) && r.cm > -400 && r.cm < 500)) && /^\d{3,6}$/.test(String(r.st || '')) && r.f === 'cpsm' && STATI.has(r.s);

// righe d'archivio dalle letture del portale (forma di tide.parseLevels): la stazione principale e le due di riserva, come il server
function rowsFrom(levels, ids = ['1025', '1045', '1029']) {
  const out = [];
  for (const id of ids) {
    const s = (levels || []).find(x => x && x.id === id && Number.isFinite(x.ts)); if (!s) continue;
    out.push({ t: s.ts, cm: Number.isFinite(s.cm) ? s.cm : null, st: id, f: 'cpsm', s: Number.isFinite(s.cm) ? 'grezzo' : 'mancante' });
  }
  return out;
}
// testo JSONL -> righe valide (le altre si ignorano)
function parse(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) { if (!line.trim()) continue; let r; try { r = JSON.parse(line); } catch { continue; } if (valid(r)) out.push(r); }
  return out;
}
// aggiunge le righe nuove a un file: niente duplicati (stessa stazione e istante); un dato arrivato dopo uno «mancante» lo sostituisce
function merge(text, rows) {
  const by = new Map(); for (const r of parse(text)) by.set(r.st + '|' + r.t, r);
  let added = 0;
  for (const r of rows) {
    if (!valid(r)) continue;
    const k = r.st + '|' + r.t, old = by.get(k);
    if (!old || (old.cm === null && r.cm !== null)) { by.set(k, r); added++; }
  }
  const all = [...by.values()].sort((a, b) => a.t - b.t || a.st.localeCompare(b.st));
  return { text: all.map(r => JSON.stringify({ t: r.t, cm: r.cm, st: r.st, f: r.f, s: r.s })).join('\n') + (all.length ? '\n' : ''), added };
}
// file da cancellare (più vecchi di KEEP_DAYS)
const expired = (names, now = Date.now(), keep = KEEP_DAYS) => names.filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && Date.parse(n.slice(0, 10) + 'T00:00:00Z') < now - keep * 864e5);
// storia per il grafico: per ogni istante la stazione principale se c'è, altrimenti la prima di riserva; solo valori veri, ultime «ms»
function history(rows, now = Date.now(), ms = 6 * 3600e3, order = ['1025', '1045', '1029']) {
  const by = new Map();
  for (const r of rows) {
    if (r.cm === null || r.t < now - ms || r.t > now + 600e3) continue;
    const o = by.get(r.t); if (!o || order.indexOf(r.st) < order.indexOf(o.st)) by.set(r.t, r);
  }
  return [...by.values()].sort((a, b) => a.t - b.t).map(r => ({ t: r.t, cm: r.cm }));
}
// lettura dal ramo pubblico: oggi e ieri (UTC), per coprire le ultime ore anche subito dopo la mezzanotte
async function restore({ repo, fetchFn = globalThis.fetch, now = Date.now(), ms = 6 * 3600e3 } = {}) {
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo || '') || !fetchFn) return [];
  const rows = [];
  for (const d of [...new Set([dayOf(now - ms), dayOf(now)])]) {
    try {
      const r = await fetchFn(`https://raw.githubusercontent.com/${repo}/archivio-marea/marea/${d}.jsonl`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const txt = await r.text(); if (txt.length > MAX_FILE) continue;
      rows.push(...parse(txt));
    } catch { /* archivio irraggiungibile: si riparte dalle sole letture nuove, come prima */ }
  }
  return history(rows, now, ms);
}
module.exports = { KEEP_DAYS, dayOf, rowsFrom, parse, merge, expired, history, restore, valid };
