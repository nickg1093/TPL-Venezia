// DATI FISSI SUL TELEFONO: fermate, linee e tracciati delle linee (vedi fissi.js sul server e README, «Dati sul telefono e CDN»).
// Si scaricano UNA volta per versione dei GTFS e restano salvati nel telefono (Cache Storage del sito, «tpl-fissi-1»): alle aperture
// successive non si scarica nulla. Da dove:
//   1. dal telefono stesso, se il file con quell'impronta è già salvato;
//   2. dal CDN (jsDelivr, poi raw.githubusercontent.com), solo se il server dice che quella versione c'è e solo se l'impronta SHA-256
//      del file scaricato coincide con quella data dal server (un file diverso si scarta);
//   3. dal server (/api/fisso), con la stessa impronta;
//   4. se anche questo non va: i vecchi indirizzi (/api/stops, /api/routes, /api/shapes), come prima.
// Le funzioni restituiscono esattamente quello che restituivano i vecchi indirizzi: il resto dell'app non cambia.
import { api } from './util.js';

const CACHE = 'tpl-fissi-1', HEX64 = /^[0-9a-f]{64}$/, TIMEOUT = 15000;
let manP = null, man = null;
const parsed = new Map();                                       // impronta -> contenuto già letto (in questa sessione)
const secure = () => typeof isSecureContext !== 'undefined' && isSecureContext && !!globalThis.crypto?.subtle;
const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async buf => hex(await crypto.subtle.digest('SHA-256', buf));
export async function openCache() { try { return secure() && globalThis.caches ? await caches.open(CACHE) : null; } catch { return null; } }
const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT) : undefined);

// indice del server: impronte dei file della versione in uso, indirizzi del CDN, rete pedonale. Riletto quando cambia la versione dei GTFS.
export function manifest(force = false) {
  if (manP && !force) return manP;
  manP = fetch('/api/fissi', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).then(m => {
    man = m && m.formato === 1 && Array.isArray(m.src) ? m : null;
    if (man) prune();
    return man;
  }).catch(() => (man = null));
  return manP;
}
export const current = () => man;
// basi del CDN ammesse: solo i due indirizzi previsti (stessi della politica di sicurezza del sito)
export const cdnBases = m => (Array.isArray(m?.cdn) ? m.cdn.filter(b => typeof b === 'string' && /^https:\/\/(cdn\.jsdelivr\.net\/gh|raw\.githubusercontent\.com)\/[\w.-]+\/[\w.-]+[@/][0-9a-f]{40}$/.test(b)) : []);

// un file (Buffer) con impronta nota (h: SHA-256 intera, o le prime 16 cifre per le mattonelle pedonali): dal telefono, dal CDN, dal server
export async function getVerified(key, h, urls) {
  if (!/^[0-9a-f]{16,64}$/.test(h || '')) throw new Error('impronta non valida');
  const c = await openCache();
  if (c) {
    try { const hit = await c.match(key); if (hit) { const b = await hit.arrayBuffer(); if ((await sha256(b)).startsWith(h)) return b; c.delete(key); } } catch { /* cache illeggibile: si scarica */ }
  }
  for (const u of urls) {
    const ext = !u.startsWith('/');
    if (ext && !secure()) continue;                              // senza verifica dell'impronta niente CDN
    try {
      const r = await fetch(u, ext ? { cache: 'force-cache', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: signal() } : { cache: 'force-cache', signal: signal() });
      if (!r.ok) continue;
      const b = await r.arrayBuffer();
      if (secure() && !(await sha256(b)).startsWith(h)) continue;   // file diverso da quello atteso: scartato
      if (c) c.put(key, new Response(b, { headers: { 'Content-Type': 'application/json' } })).catch(() => {});
      return b;
    } catch { /* prossima fonte */ }
  }
  throw new Error('file non disponibile');
}
async function fileOf(m, s, name) {
  const h = s[name]; if (!HEX64.test(h || '')) throw new Error('impronta mancante');
  if (parsed.has(h)) return parsed.get(h);
  const urls = (s.cdn ? cdnBases(m).map(b => `${b}/fissi/${s.id}/${s.v}/${name}.json`) : []).concat(`/api/fisso?src=${encodeURIComponent(s.id)}&f=${name}&h=${h}`);
  const v = JSON.parse(new TextDecoder().decode(await getVerified('/__fissi/' + h, h, urls)));
  parsed.set(h, v);
  return v;
}

// file salvati di versioni non più in uso: tolti (le mattonelle pedonali le gestisce pedoni.js)
async function prune() {
  const c = await openCache(); if (!c || !man) return;
  const keep = new Set(man.src.flatMap(s => [s.stops, s.routes, s.shapes]));
  for (const h of parsed.keys()) if (!keep.has(h)) parsed.delete(h);
  try { for (const req of await c.keys()) { const p = new URL(req.url).pathname; if (p.startsWith('/__fissi/') && !keep.has(p.slice(9))) c.delete(req); } } catch { /* niente */ }
}

// ---- stesse risposte dei vecchi indirizzi ----
// fermate: [["src:id", nome, lat, lon, src], …] (come /api/stops)
export async function stops(force) {
  const m = await manifest(force);
  if (m?.src.length) {
    try { return (await Promise.all(m.src.map(async s => (await fileOf(m, s, 'stops')).map(r => [`${s.id}:${r[0]}`, r[1], r[2], r[3], s.id])))).flat(); }
    catch { /* si ripiega sul server */ }
  }
  return api('/api/stops', { cache: 'no-cache' });
}
// linee: {"src:route": {name, color, type, src}} (come /api/routes)
export async function routes() {
  const m = await manifest();
  if (m?.src.length) {
    try {
      const out = {};
      for (const s of m.src) { const r = await fileOf(m, s, 'routes'); for (const k in r) out[`${s.id}:${k}`] = { ...r[k], src: s.id }; }
      return out;
    } catch { /* si ripiega sul server */ }
  }
  return api('/api/routes', { cache: 'no-cache' });
}
// tracciati di una linea «src:route»: [[[lat, lon], …], …] (come /api/shapes .shapes). Il file con tutti i tracciati di un servizio si
// scarica la prima volta che serve una linea di quel servizio, poi resta sul telefono.
export async function shapes(id) {
  const m = await manifest(), k = String(id).indexOf(':'), src = String(id).slice(0, k), rid = String(id).slice(k + 1), s = m?.src.find(x => x.id === src);
  if (s) {
    try { const all = await fileOf(m, s, 'shapes'); return Object.hasOwn(all, rid) ? all[rid].map(decode) : []; }
    catch { /* si ripiega sul server */ }
  }
  return (await api('/api/shapes?id=' + encodeURIComponent(id))).shapes;
}
// tracciato codificato («encoded polyline», 5 decimali) -> [[lat, lon], …]
export function decode(s) {
  const out = []; let i = 0, la = 0, ln = 0;
  const d = () => { let r = 0, sh = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20 && i < s.length); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < s.length) { la += d(); ln += d(); out.push([la / 1e5, ln / 1e5]); }
  return out;
}
