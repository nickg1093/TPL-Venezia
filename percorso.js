// PIANIFICA PERCORSO: da un punto (o una fermata) a un altro con autobus, tram e battelli, cambi a piedi compresi.
//
// Algoritmo RAPTOR (Delling, Pajor, Werneck, Microsoft Research 2012), quello delle app di trasporto: a ogni "giro" si aggiunge una corsa;
// il primo giro dà gli arrivi con una sola corsa, il secondo con un cambio, e così via. Ne escono le soluzioni migliori per numero di cambi
// (meno cambi / arrivo prima), senza grafo pesante in memoria.
//
// Leggero per il server (Render gratuito, poca memoria):
//   · gli orari NON si copiano: le "linee-percorso" (corse con le stesse fermate) puntano agli array già in memoria di gtfs.js;
//   · l'indice si costruisce alla prima richiesta e solo quando cambia il GTFS (≈ 1-2 MB per ~900 percorsi, ~52.000 corse);
//   · una ricerca usa qualche array grande quanto le fermate (≈ 2.500), dura pochi millisecondi ed è messa in cache 30 s;
//   · la posizione dell'utente NON arriva al server: il telefono manda solo le fermate vicine con la distanza in linea d'aria, oppure
//     («~r») misurata da lui lungo le strade sulla rete pedonale scaricata dal CDN (public/js/camminata.js): allora si usa così com'è.
//
// A piedi: le distanze tra fermate vengono dalla rete pedonale di OpenStreetMap, precalcolate in pedonale-laguna.txt (centro storico,
// Giudecca, isole, Lido, Pellestrina, Chioggia: niente scorciatoie attraverso i canali) e pedonale-terraferma.txt (tutte le altre zone
// servite: niente scorciatoie attraverso ferrovia, fiumi, tangenziali). Solo le poche fermate lontane da ogni strada usano la linea d'aria × 1,3.
// Tempo reale: per le partenze di adesso si usano gli stessi tempi dei pannelli (mezzi localizzati e previsioni del feed);
// per gli orari scelti, l'orario programmato. Le tratte proposte riportano poi, fermata per fermata, i dati del pannello fermata.
const fs = require('fs');
const path = require('path');
const cal = require('./calendar');
const tracker = require('./tracker');

const C = {
  ROUNDS: 5,                 // al massimo 5 corse (4 cambi)
  V_LAG: 1.25, V_MAIN: 1.33, // passo «normale» (m/s): 4,5 km/h in laguna (ponti, scale, folla), 4,8 in terraferma (come le app di mappe)
  PASSO: { lento: 1.3, normale: 1, veloce: 0.8 },   // tempi a piedi × fattore: tranquillo ≈ 3,5-3,7 km/h, veloce ≈ 5,6-6 km/h
  MARGINE_LARGO_S: 120,      // andatura «con calma» (bagagli, passeggini, bambini): almeno 2 minuti per ogni cambio
  // COINCIDENZA A RISCHIO (v28): nessun tempo fisso per salire (conta solo l'andatura); un cambio con meno di 2 minuti di margine (oltre a
  // quello dell'andatura) si propone lo stesso, segnato «coincidenza a rischio», e costa 5 minuti in più: vince solo se fa guadagnare tempo.
  RISCHIO_S: 120, RISCHIO_PEN_S: 300,
  // INTERSCAMBI TRA SERVIZI (v33.1: P.le Roma, Ferrovia, Lido, Tronchetto, Mestre): da bus/tram/People Mover a battello o viceversa serve
  // 1 minuto in più di margine per non essere «a rischio» (biglietterie, varchi, pontili lontani dal capolinea): 3 minuti in tutto.
  RISCHIO_MODALE_S: 60,
  // COINCIDENZA IRREALISTICA: tra servizi diversi con meno di 1 minuto di margine (bus che arriva alle 8:41, 3 minuti a piedi, battello alle 8:45):
  // vale come 4 coincidenze a rischio. Resta tra le proposte (segnata), ma non è più la consigliata se c'è altro.
  IRREALE_S: 60, IRREALE_PESO: 4,
  // «ARRIVO ENTRO»: una coincidenza a rischio, se salta, fa arrivare tardi: pesa 15 minuti invece di 5 (vince solo se fa partire molto più tardi).
  RISCHIO_PEN_ENTRO_S: 900,
  // CORSA BREVISSIMA in una soluzione con cambi (meno di 3 minuti, es. una fermata di tram per prendere un altro bus): 2 minuti in più di costo.
  BREVE_S: 180, BREVE_PEN_S: 120,
  // «ADESSO»: niente proposte che chiederebbero di essere già partiti (partenza da casa più di 30 s fa) né, se ce ne sono altre, con una
  // coincidenza già persa secondo i tempi aggiornati.
  PASSATA_S: 30,
  // COSTO PERCEPITO di una soluzione (in secondi), come ragiona una persona:
  //   partenza «alle» / adesso:  arrivo + A × durata + TP × cambi + (WW − 1) × secondi a piedi
  //   «arrivo entro»:          − partenza + A × durata + TP × cambi + (WW − 1) × secondi a piedi
  // Prima conta arrivare presto (o partire il più tardi possibile), ma la durata conta sempre: A = 0,25 vuol dire che 4 minuti di viaggio
  // in più valgono 1 minuto di arrivo in più (o di partenza anticipata). Un cambio pesa TP, un minuto a piedi WW minuti.
  //   equilibrata  «Arrivare prima»  (predefinita): un cambio = 8 minuti, a piedi × 1,5 (camminare stanca più che stare seduti)
  //   piedi        «Camminare meno»: a piedi × 3, e ogni tratto a piedi tra due mezzi al massimo 10 minuti
  //   cambi        «Meno cambi»:     un cambio = 20 minuti (meglio aspettare il diretto)
  // «veloce» (prima della v27) vale come «equilibrata».
  PREF: { equilibrata: { TP: 480, WW: 1.5, A: 0.25 }, veloce: { TP: 480, WW: 1.5, A: 0.25 }, cambi: { TP: 1200, WW: 1.5, A: 0.25 }, piedi: { TP: 480, WW: 3, A: 0.25, maxT: 600 } },
  // CAMMINATE LUNGHE (v33.1, prove sugli orari reali del 19/11/2026): oltre 10 minuti a piedi in tutto, ogni minuto in più pesa un minuto in più
  // (con «Arrivare prima» 2,5 invece di 1,5). Prima vinceva chi arrivava 5 minuti prima camminando mezz'ora: Mestre → S. Marco con il bus, 13 minuti
  // a piedi fino a S. Tomà, una sola fermata di battello e altri 16 minuti a piedi, invece del battello fino a S. Marco.
  WALK_OK_S: 600, WALK_EXTRA: 1,
  // STABILITÀ (v33.1): due soluzioni con costi a meno di 1 minuto sono equivalenti: si consiglia quella con meno cambi, poi meno strada a piedi;
  // in tempo reale la «Consigliata» resta la stessa famiglia agli aggiornamenti successivi se costa al massimo 3 minuti più della migliore
  // (prima cambiava a ogni minuto per pochi secondi di differenza nelle previsioni). Memoria: al massimo 500 tragitti, 10 minuti.
  TIE_S: 60, STICKY_S: 180, STICKY_MS: 10 * 60e3, STICKY_MAX: 500,
  BY_EARLY_S: 40 * 60,       // «arrivo entro»: niente proposte che fanno partire più di 40 min prima dell'ultima partenza utile (se ce ne sono altre;
                             // v33.2: prima 25, nascondeva le alternative con meno cambi o meno strada a piedi di poco prima)
  BY_COMODO_S: 60 * 60,      // ...fino a 60 min per chi ha meno cambi o almeno 5 minuti in meno a piedi (come le darebbe «Partenza alle»)
  // ARRIVO AL LIMITE (v33.2): con «arrivo entro», meno di 5 minuti tra l'arrivo e l'orario chiesto (o un cambio a rischio) = «al limite»: si
  // mostra con una dicitura chiara e pesa un po' (ogni secondo di margine mancante vale 1,5 s di partenza anticipata), così a parità di
  // comodità si consiglia chi parte un paio di minuti prima ma arriva con margine.
  LIMITE_S: 300, LIMITE_PESO: 1.5,
  LATE_S: 30 * 60,           // partenza «alle»: niente proposte che arrivano più di 30 min dopo la prima (50 con «meno cambi» o «camminare meno»)
  BETTER_S: 30,              // una soluzione ne rende inutile un'altra se è migliore di almeno 30 s di costo (e non chiede di partire prima)
  DETOUR: 1.3,               // linea d'aria -> percorso a piedi (terraferma, accesso alla prima fermata)
  MAIN_M: 450,               // fermate fuori dalla rete pedonale: cambi a piedi fino a 450 m in linea d'aria
  CHANGE_AUT_S: 0, CHANGE_NAV_S: 0,      // v28: nessun tempo fisso per salire (prima 1 min autobus/tram, 2 battello): conta l'andatura
  TRANSFER_MAX_S: 15 * 60,   // un cambio a piedi tra due mezzi: al massimo 15 minuti (i tratti più lunghi servono a «tutto a piedi»)
  ALT_LATER_S: 30 * 60,      // alternative di una soluzione: al massimo 30 minuti più tardi
  WALK_ONLY_MAX_S: 40 * 60,  // «tutto a piedi» lungo la rete, anche passando per altre fermate: fino a 40 minuti
  ACCESS_MAX_M: 1500,        // fermate di partenza/arrivo fino a 1,5 km in linea d'aria
  REAL_MAX_M: 3500,          // distanze misurate dal telefono lungo le strade (camminata.js: fino a 30 minuti a passo svelto)
  LIVE_BACK_S: 1800,         // in tempo reale si guardano anche corse fino a 30 min prima (in ritardo)
  HORIZON_S: 5 * 3600,       // viaggi fino a 5 ore
  CACHE_MS: 30000, CACHE_MAX: 300,
  OPTIONS: 5,                // soluzioni proposte (una per «famiglia»: stesse linee e stessi punti di cambio)
  SHORT_WALK_S: 6 * 60,      // ricerca «meno a piedi»: cambi e tratti finali fino a 6 minuti
  BY_BACK_S: 2 * 3600,       // «arrivo entro»: l'ultima partenza utile si cerca nelle 2 ore prima dell'orario (5 se non basta)
  BY_SCAN_S: 30 * 60         // ...e le partenze una per una nella mezz'ora prima di quella
};
const INF = 1e9;
const SRC = ['aut', 'nav'];

let ctx = null;              // { G(i), state(i), live(i), serviceActive, rows(i, sid, tid, when) }
const init = c => { ctx = c; IX = null; IXS.clear(); cache.clear(); STICK.clear(); };   // c.walkDir (facoltativo, per le prove): cartella dei file pedonale-*.txt

// ---------------------------------------------------------------------------------------------------------------------
// INDICE (una volta per versione dei GTFS)
// ---------------------------------------------------------------------------------------------------------------------
let IX = null;
// Indici in memoria: quello degli orari in uso e, al massimo, uno per un'altra data (modalità «Programmato» o percorso in un altro giorno,
// con la versione dei GTFS valida in quella data: stessa scelta di live.dataFor). Ogni indice pesa 1-2 MB.
const IXS = new Map();
// memoria alta: resta solo l'indice degli orari in uso adesso (gli altri si ricostruiscono alla prossima richiesta)
require('./memoria').quando(() => { const live = SRC.map(i => ctx?.G(i)?.meta?.key || ctx?.G(i)?.meta?.hash || '').join('|'); for (const k of [...IXS.keys()]) if (k !== live) IXS.delete(k); });
// file delle distanze a piedi: riga 1 fermate (n=navigazione, a=automobilistico), riga 2 coppie «i.j.metri» in base 36,
// riga 3 (facoltativa) fermate lontane da ogni strada della rete (indici in base 36): per quelle resta la linea d'aria
function walkFile(name) {
  try {
    const L = fs.readFileSync(path.join(ctx?.walkDir || __dirname, name), 'utf8').split('\n').filter(l => !l.startsWith('#'));   // righe vuote comprese: «nessuna coppia» è una riga vuota
    const ids = L[0].split(',').map(x => (x[0] === 'n' ? 'nav:' : 'aut:') + x.slice(1));
    const pairs = (L[1] || '').split(' ').filter(Boolean).map(p => { const [a, b, m] = p.split('.').map(v => parseInt(v, 36)); return [ids[a], ids[b], m]; });
    const loose = new Set((L[2] || '').split(' ').filter(Boolean).map(v => ids[parseInt(v, 36)]));
    return { ids: new Set(ids.filter(x => !loose.has(x))), pairs };
  } catch { return { ids: new Set(), pairs: [] }; }
}
const distM = (la1, lo1, la2, lo2) => Math.hypot((la1 - la2) * 111320, (lo1 - lo2) * 111320 * Math.cos(la1 * Math.PI / 180));

function build(Gs = SRC.map(i => ctx.G(i))) {
  const key = Gs.map(G => G?.meta?.key || G?.meta?.hash || '').join('|');   // key: versione + giorni caricati
  if (IX && IX.key === key) return IX;
  const hit = IXS.get(key); if (hit) return (IX = hit);
  const t0 = Date.now(), ids = [], gid = new Map(), lat = [], lon = [], srcOf = [];
  SRC.forEach((i, si) => { const G = Gs[si]; if (!G) return;
    for (const sid in G.stopIndex) { const L = G.stopLoc[sid]; const g = ids.length; gid.set(i + ':' + sid, g); ids.push(i + ':' + sid); lat.push(L ? L[0] : NaN); lon.push(L ? L[1] : NaN); srcOf.push(si); } });
  const N = ids.length;
  // percorsi: corse della stessa linea con le stesse fermate (stesso array di gtfs.js), ordinate e divise in catene senza sorpassi
  const pats = [];
  SRC.forEach((i, si) => { const G = Gs[si]; if (!G) return;
    const by = new Map();
    G.tripIds.forEach((tid, n) => {
      const st = G.stopTimes.get(tid), tr = G.trips[tid]; if (!st || !tr || st.s.length < 2) return;
      let m = by.get(st.s); if (!m) by.set(st.s, m = new Map());
      let l = m.get(tr.route); if (!l) m.set(tr.route, l = []); l.push(n);
    });
    for (const [s, m] of by) for (const [route, list] of m) {
      const sts = list.map(n => G.stopTimes.get(G.tripIds[n]));
      const ord = list.map((n, k) => k).sort((x, y) => sts[x].d[0] - sts[y].d[0]);
      const chains = [];                                       // RAPTOR vuole corse che non si sorpassano: catene "FIFO"
      for (const k of ord) {
        const st = sts[k]; let c = chains.find(ch => { const p = sts[ch[ch.length - 1]]; for (let q = 0; q < s.length; q++) if (st.d[q] < p.d[q] || st.a[q] < p.a[q]) return false; return true; });
        if (!c) chains.push(c = []); c.push(k);
      }
      const stops = Int32Array.from(s.map(x => gid.get(i + ':' + x)));
      const type = G.routes[route]?.type, mode = si === 1 ? 'nav' : type === 0 ? 'tram' : 'bus';
      for (const ch of chains) pats.push({ si, i, route, rk: i + ':' + route, mode, stops, n: Int32Array.from(ch.map(k => list[k])), st: ch.map(k => sts[k]) });
    }
  });
  // fermata -> (percorso, posizione)
  const cnt = new Int32Array(N + 1);
  for (const p of pats) for (const g of p.stops) cnt[g + 1]++;
  for (let g = 0; g < N; g++) cnt[g + 1] += cnt[g];
  const spP = new Int32Array(cnt[N]), spK = new Int32Array(cnt[N]), fill = cnt.slice();
  pats.forEach((p, pi) => p.stops.forEach((g, k) => { const o = fill[g]++; spP[o] = pi; spK[o] = k; }));
  // cambi a piedi
  // isLag: fermata in laguna (passo più lento); isNet: fermata sulla rete pedonale (laguna o terraferma) -> solo cammini veri
  const lag = walkFile('pedonale-laguna.txt'), ter = walkFile('pedonale-terraferma.txt'), tr = Array.from({ length: N }, () => []);
  const isLag = new Uint8Array(N), isNet = new Uint8Array(N);
  for (const x of lag.ids) { const g = gid.get(x); if (g != null) isLag[g] = isNet[g] = 1; }
  for (const x of ter.ids) { const g = gid.get(x); if (g != null) isNet[g] = 1; }
  const best = new Map(), addB = (a, b, s) => { if (a === b) return; const k = a < b ? a * N + b : b * N + a; if (!best.has(k) || best.get(k) > s) best.set(k, s); };
  for (const F of [lag, ter]) for (const [x, y, m] of F.pairs) {
    const a = gid.get(x), b = gid.get(y); if (a != null && b != null) addB(a, b, Math.round(m / (isLag[a] || isLag[b] ? C.V_LAG : C.V_MAIN)));
  }
  // fermate fuori dalla rete (in terraferma): linea d'aria × 1,3 verso le fermate vicine
  const cell = (la, lo) => Math.floor(la / 0.005) + ':' + Math.floor(lo / 0.007), grid = new Map();
  for (let g = 0; g < N; g++) if (!isLag[g] && Number.isFinite(lat[g])) { const k = cell(lat[g], lon[g]); (grid.get(k) || grid.set(k, []).get(k)).push(g); }
  for (let g = 0; g < N; g++) {
    if (isNet[g] || !Number.isFinite(lat[g])) continue;
    const ci = Math.floor(lat[g] / 0.005), cj = Math.floor(lon[g] / 0.007);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const h of grid.get((ci + a) + ':' + (cj + b)) || []) {
      if (h === g || (!isNet[h] && h < g)) continue; const d = distM(lat[g], lon[g], lat[h], lon[h]);
      if (d <= C.MAIN_M) addB(g, h, Math.round(d * C.DETOUR / C.V_MAIN));
    }
  }
  for (const [k, s] of best) { const a = Math.floor(k / N), b = k % N; tr[a].push(b, s); tr[b].push(a, s); }
  const trS = new Int32Array(N + 1); for (let g = 0; g < N; g++) trS[g + 1] = trS[g] + tr[g].length;
  const trA = new Int32Array(trS[N]); for (let g = 0; g < N; g++) trA.set(tr[g], trS[g]);
  IX = { key, Gs: [...Gs], ids, gid, lat: Float64Array.from(lat), lon: Float64Array.from(lon), srcOf: Uint8Array.from(srcOf), isLag, isNet, pats, spS: cnt, spP, spK, trS, trA, svc: new Map() };
  const liveKey = SRC.map(i => ctx.G(i)?.meta?.key || ctx.G(i)?.meta?.hash || '').join('|');
  IXS.set(key, IX);
  for (const k of [...IXS.keys()]) if (IXS.size > 2 && k !== key && k !== liveKey) IXS.delete(k);   // al massimo 2 indici (memoria di Render)
  console.log(`percorsi: indice pronto in ${Date.now() - t0} ms (${N} fermate, ${pats.length} percorsi, ${trS[N] / 4} cambi a piedi)`);
  return IX;
}
// corse in servizio in una data (per servizio, in cache)
function activeOf(si, ymd) {
  const k = si + '|' + ymd; let m = IX.svc.get(k);
  if (!m) { if (IX.svc.size > 12) IX.svc.clear(); IX.svc.set(k, m = new Map()); }
  return n => { const G = IX.Gs[si], s = G.trips[G.tripIds[n]].service; let v = m.get(s); if (v === undefined) m.set(s, v = ctx.serviceActive(G, s, ymd)); return v; };
}

// ---------------------------------------------------------------------------------------------------------------------
// TEMPO REALE: orario previsto di una corsa a una fermata (stesse fonti dei pannelli). null = orario programmato; NaN = già passata
// ---------------------------------------------------------------------------------------------------------------------
function liveFn(q, si, n) {
  const key = si * 1e7 + n; if (q.lc.has(key)) return q.lc.get(key);
  const i = SRC[si], G = IX.Gs[si], tid = G.tripIds[n], ps = ctx.state(i)?.[tid], lv = ctx.live(i)?.[tid];
  let f = null;
  // f(p, orario programmato) -> orario previsto (s), null = orario programmato, NaN = fermata già passata dal mezzo
  // (v33.1) corsa soppressa o fermata saltata nel feed: non si sale né si scende lì (prima la soluzione la proponeva e la segnava solo «soppressa»)
  if (lv?.cancelled) { f = () => NaN; f.off = () => true; }
  else if (ps && ps.dayOff === 0 && ps.etaMs) f = p => (p < ps.cur ? NaN : Number.isFinite(ps.etaMs[p]) ? q.T + (ps.etaMs[p] - q.nowMs) / 1000 : null);
  else if (lv && lv.delays) f = (p, sched) => (lv.delays[p] != null ? sched + lv.delays[p] : null);
  if (f && !f.off && lv?.skipped?.size) { const g = f; f = (p, sched) => (lv.skipped.has(p) ? NaN : g(p, sched)); f.off = p => lv.skipped.has(p); }
  q.lc.set(key, f); return f;
}
// orario (s del giorno della ricerca) di partenza (dep) o arrivo dalla posizione p della corsa j del percorso P, nello strato L
function timeAt(q, P, j, p, L, dep) {
  const st = P.st[j], sched = (dep ? st.d[p] : st.a[p]) + L.off;
  if (!q.live || L.off !== 0) return sched;
  const f = liveFn(q, P.si, P.n[j]); if (!f) return sched;
  const v = f(p, sched); if (v == null) return sched;
  if (Number.isNaN(v)) return dep || f.off?.(p) ? INF : sched;
  return dep && p === 0 ? Math.max(v, sched) : v;              // dal capolinea non si parte prima dell'orario
}
// prima corsa del percorso P che parte dalla posizione p non prima di t -> { j, L, dep } | null
function earliest(q, P, p, t) {
  let best = null;
  for (const L of q.layers) {
    const act = L.act[P.si], lo0 = (q.live && L.off === 0 ? t - C.LIVE_BACK_S : t) - L.off;
    let lo = 0, hi = P.st.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (P.st[m].d[p] < lo0) lo = m + 1; else hi = m; }
    for (let j = lo; j < P.st.length; j++) {
      const sched = P.st[j].d[p] + L.off; if (best && sched - (q.live ? 120 : 0) > best.dep) break;
      if (sched > t + C.HORIZON_S) break;
      if (!act(P.n[j])) continue;
      const dep = timeAt(q, P, j, p, L, true); if (dep < t || dep >= INF) continue;   // già passata, soppressa o fermata saltata
      if (!best || dep < best.dep) best = { j, L, dep };
      if (!q.live || L.off !== 0) break;                       // senza tempo reale la prima valida è la migliore (niente sorpassi)
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// RAPTOR
// ---------------------------------------------------------------------------------------------------------------------
// q: { T (s del giorno), live, nowMs, layers, access: [[g, s]], egress: Map(g -> s), lc,
//      K (corse al massimo), wf (fattore del passo), maxT (cambio a piedi più lungo), extra (margine in più per i cambi), allow(P) (mezzi e linee ammessi),
//      noWalkCut (non scartare i mezzi che arrivano dopo chi va tutto a piedi: «arrivo entro» e «camminare meno») }
function raptor(q) {
  const N = IX.ids.length, K = q.K ?? C.ROUNDS, wf = q.wf ?? 1, extra = q.extra || 0, arr = [], lab = [];
  const best = new Float64Array(N).fill(INF);
  for (let k = 0; k <= K; k++) { arr.push(new Float64Array(N).fill(INF)); lab.push({ kind: new Int8Array(N), a: new Int32Array(N), b: new Int32Array(N), c: new Int32Array(N), d: new Int32Array(N), e: new Int32Array(N) }); }
  let marked = new Set(), target = INF;
  const tgt = k => { for (const [g, s] of q.egress) { const t = arr[k][g] + s; if (t < target) target = t; } };
  const walk = (k, from) => {                                  // cambi a piedi dalle fermate raggiunte con una corsa (o dall'origine)
    const add = [];
    for (const g of from) {
      const t0 = arr[k][g];
      for (let o = IX.trS[g]; o < IX.trS[g + 1]; o += 2) {
        const w = IX.trA[o + 1] * wf; if (w > q.maxT || w > C.TRANSFER_MAX_S) continue;   // camminata massima (filtro, «meno a piedi»; i cambi a piedi non oltre 15 min)
        const h = IX.trA[o], t = t0 + Math.round(w);
        if (t < arr[k][h] && t < best[h] && t < target) { arr[k][h] = t; best[h] = t; lab[k].kind[h] = 2; lab[k].a[h] = g; add.push(h); }
      }
    }
    for (const h of add) from.add(h);
  };
  for (const [g, s] of q.access) { const t = q.T + s; if (t < arr[0][g]) { arr[0][g] = t; best[g] = t; lab[0].kind[g] = 3; lab[0].a[g] = s; marked.add(g); } }
  walk(0, marked); if (!q.noWalkCut) tgt(0);                    // noWalkCut: i mezzi si cercano anche se a piedi (via le fermate) si arriva prima
  for (let k = 1; k <= K && marked.size; k++) {
    const Q = new Map();
    for (const g of marked) for (let o = IX.spS[g]; o < IX.spS[g + 1]; o++) { const pi = IX.spP[o], p = IX.spK[o]; const v = Q.get(pi); if (v === undefined || p < v) Q.set(pi, p); }
    const nm = new Set();
    for (const [pi, p0] of Q) {
      const P = IX.pats[pi]; if (q.allow && !q.allow(P)) continue;
      const n = P.stops.length, chg = (P.si === 1 ? C.CHANGE_NAV_S : C.CHANGE_AUT_S) + extra;
      let cur = null;
      for (let p = p0; p < n; p++) {
        const g = P.stops[p];
        if (cur && p > cur.p) {
          const ta = timeAt(q, P, cur.j, p, cur.L, false);
          if (ta < arr[k][g] && ta < best[g] && ta < target) {
            arr[k][g] = ta; best[g] = ta; const l = lab[k]; l.kind[g] = 1; l.a[g] = pi; l.b[g] = cur.j; l.c[g] = cur.Li; l.d[g] = cur.p; l.e[g] = p; nm.add(g);
          }
        }
        const prev = arr[k - 1][g];
        if (prev < INF && p < n - 1) {
          const t = prev + (k === 1 && lab[k - 1].kind[g] === 3 && lab[k - 1].a[g] === 0 ? 0 : chg);
          const curDep = cur ? timeAt(q, P, cur.j, p, cur.L, true) : INF;      // la corsa che si sta seguendo, a questa fermata
          if (t <= curDep) {
            const e = earliest(q, P, p, t);
            if (e && e.dep < curDep) cur = { j: e.j, L: e.L, Li: q.layers.indexOf(e.L), p };
          }
        }
      }
    }
    walk(k, nm); marked = nm; tgt(k);
  }
  return { arr, lab };
}
// ricostruzione della soluzione arrivata in k giri alla fermata g
function journey(q, R, k, g) {
  const legs = [];
  while (k >= 0) {
    const l = R.lab[k], kind = l.kind[g];
    if (kind === 3) { legs.unshift({ t: 'acc', g, s: l.a[g] }); break; }
    if (kind === 2) { const f = l.a[g]; legs.unshift({ t: 'walk', from: f, to: g, s: R.arr[k][g] - R.arr[k][f] }); g = f; continue; }
    if (kind === 1) { const P = IX.pats[l.a[g]], j = l.b[g], L = q.layers[l.c[g]], p0 = l.d[g], p1 = l.e[g];
      legs.unshift({ t: 'ride', P, j, L, p0, p1, dep: timeAt(q, P, j, p0, L, true), arr: R.arr[k][g] }); g = P.stops[p0]; k--; continue; }
    return null;
  }
  return legs;
}

// AGGIUSTAMENTI DI UNA SOLUZIONE (stesse corse, stessi orari dei mezzi). RAPTOR fa salire alla PRIMA fermata da cui raggiunge una corsa e
// scendere alla prima utile: può far camminare fino a una fermata lontana per prendere una corsa che passa poco dopo sotto casa. Una persona
// sceglie invece la fermata più comoda. Per ogni soluzione:
//   1) cambi: tra due corse, la coppia discesa/salita con meno strada a piedi (a parità, più tempo per il cambio, fino a 10 minuti);
//   2) partenza: sulla prima corsa la fermata con il costo più basso (meno strada a piedi e partenza da casa più tardi);
//   3) arrivo: si resta a bordo fino alla fermata da cui si cammina meno, se costa meno (arrivo + strada a piedi pesata).
// Ogni cambio rispetta lo stesso margine della ricerca (1 min bus e tram, 2 min battello, +3 con calma) e lo stesso limite a piedi.
function walkMap(q, g) {
  const m = new Map([[g, 0]]), lim = Math.min(q.maxT ?? INF, C.TRANSFER_MAX_S), wf = q.wf ?? 1;
  for (let o = IX.trS[g]; o < IX.trS[g + 1]; o += 2) { const w = Math.round(IX.trA[o + 1] * wf), h = IX.trA[o]; if (w <= lim && !(m.get(h) <= w)) m.set(h, w); }
  return m;
}
function refine(q, legs, egr, W) {
  const R = []; legs.forEach((l, i) => { if (l.t === 'ride') R.push(i); });
  if (!R.length) return;
  const chgOf = P => (P.si === 1 ? C.CHANGE_NAV_S : C.CHANGE_AUT_S) + (q.extra || 0);
  const sumS = (i0, i1) => legs.slice(i0, i1).reduce((s, l) => s + (l.s || 0), 0);
  const replace = (i0, i1, items, from) => { const d = items.length - (i1 - i0); legs.splice(i0, i1 - i0, ...items); for (let k = from; k < R.length; k++) R[k] += d; };
  // 1) cambi
  for (let r = 0; r + 1 < R.length; r++) {
    const A = legs[R[r]], B = legs[R[r + 1]], chg = chgOf(B), w0 = sumS(R[r] + 1, R[r + 1]);
    let best = { a: A.p1, b: B.p0, w: w0, slack: B.dep - (A.arr + w0 + chg), ta: A.arr, tb: B.dep };
    for (let a = A.p0 + 1; a < A.P.stops.length; a++) {
      const ta = timeAt(q, A.P, A.j, a, A.L, false); if (!(ta < INF)) continue;
      const wm = walkMap(q, A.P.stops[a]);
      for (let b = 0; b < B.p1; b++) {
        const w = wm.get(B.P.stops[b]); if (w == null) continue;
        const tb = timeAt(q, B.P, B.j, b, B.L, true); if (!(tb < INF)) continue;
        const slack = tb - (ta + w + chg); if (slack < 0) continue;
        if (w < best.w - 30 || (Math.abs(w - best.w) <= 30 && Math.min(slack, 600) > Math.min(best.slack, 600) + 30)) best = { a, b, w, slack, ta, tb };
      }
    }
    if (best.a !== A.p1 || best.b !== B.p0) {
      const ga = A.P.stops[best.a], gb = B.P.stops[best.b];
      A.p1 = best.a; A.arr = best.ta; B.p0 = best.b; B.dep = best.tb;
      replace(R[r] + 1, R[r + 1], ga === gb ? [] : [{ t: 'walk', from: ga, to: gb, s: best.w }], r + 1);
    }
  }
  // 2) partenza (stesso margine di salita della ricerca: nessuno se si parte proprio dalla fermata)
  const F = legs[R[0]], pre = sumS(0, R[0]), accM = new Map(q.access), chgF = chgOf(F);
  let bestA = { b: F.p0, s: pre, tb: F.dep, c: W.WW * pre - F.dep };
  for (let b = 0; b < F.p1; b++) {
    const s = accM.get(F.P.stops[b]); if (s == null) continue;
    const tb = timeAt(q, F.P, F.j, b, F.L, true); if (!(tb < INF) || tb < q.T + s + (s ? chgF : 0)) continue;
    const c = W.WW * s - tb; if (c < bestA.c - 30) bestA = { b, s, tb, c };
  }
  if (bestA.b !== F.p0 || bestA.s !== pre) { F.p0 = bestA.b; F.dep = bestA.tb; replace(0, R[0], [{ t: 'acc', g: F.P.stops[bestA.b], s: bestA.s }], 0); }
  // 3) arrivo
  const Lr = legs[R[R.length - 1]], tail = sumS(R[R.length - 1] + 1, legs.length), cost = (t, w) => t + (W.WW - 1) * w;
  let cur = { t: Lr.arr + tail, w: tail, p: -1, g: -1 };
  for (let p = Lr.p0 + 1; p < Lr.P.stops.length; p++) {
    if (p === Lr.p1) continue;
    const g = Lr.P.stops[p], w = egr.get(g); if (w == null) continue;
    const ta = timeAt(q, Lr.P, Lr.j, p, Lr.L, false); if (!(ta < INF)) continue;
    if (cost(ta + w, w) < cost(cur.t, cur.w) - 30) cur = { t: ta + w, w, p, g };
  }
  if (cur.p >= 0) { Lr.p1 = cur.p; Lr.arr = cur.t - cur.w; legs.splice(R[R.length - 1] + 1, legs.length, { t: 'egr', g: cur.g, s: cur.w }); }
}

// ---------------------------------------------------------------------------------------------------------------------
// RICERCA
// ---------------------------------------------------------------------------------------------------------------------
// orario previsto dalla ricerca (s del giorno) al posto di quello programmato, se diverso di almeno 1 minuto (solo in tempo reale)
const liveAt = (x, sched, s) => (x.expMs != null && Number.isFinite(s) && s < INF && Math.abs(s - sched) >= 60
  ? { ...x, exp: hhmm(s), delay: Math.round((s - sched) / 60), expMs: x.expMs + (s - sched) * 1000 } : x);
const hhmm = s => { s = ((Math.round(s) % 86400) + 86400) % 86400; return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`; };
// candidati di partenza/arrivo: [[ "src:sid", metri in linea d'aria ]] -> Map(g -> secondi a piedi). In laguna: dal più vicino, lungo le calli.
// Candidati [[ "src:sid", metri, 1 ]]: metri GIÀ lungo le strade (calcolati dal telefono sulla rete pedonale): usati così come sono.
// wf: fattore del passo; maxS: camminata massima (filtro)
function walkTo(cands, wf = 1, maxS = INF) {
  const out = new Map();
  for (const [id, m, real] of cands) {
    if (!real) continue;
    const g = IX.gid.get(id); if (g == null) continue;
    const s = Math.round(Math.max(0, Math.min(C.REAL_MAX_M, m)) / (IX.isLag[g] ? C.V_LAG : C.V_MAIN) * wf);
    if (s <= maxS && (!out.has(g) || out.get(g) > s)) out.set(g, s);
  }
  if (out.size || cands.some(c => c[2])) return out;
  const list = cands.map(([id, m]) => [IX.gid.get(id), Math.max(0, Math.min(C.ACCESS_MAX_M, m))]).filter(([g]) => g != null);
  if (!list.length) return out;
  list.sort((a, b) => a[1] - b[1]);
  // dal punto si arriva in linea d'aria × 1,3 solo alle fermate più vicine; alle altre lungo la rete pedonale passando da quelle
  // (in laguna: la più vicina, a pari distanza; in terraferma anche quelle entro ~100 m in più)
  const m0 = list[0][1], nearL = list.filter(([, m]) => m <= Math.max(60, m0 + 20)), nearT = list.filter(([, m]) => m <= Math.max(150, m0 + 100));
  for (const [g, m] of list) {
    let s;
    const v = IX.isLag[g] ? C.V_LAG : C.V_MAIN, near = IX.isLag[g] ? nearL : nearT;
    if (IX.isNet[g] && m > 0 && !near.some(([h]) => h === g)) {
      s = INF;
      for (const [h, mh] of near) {
        const vh = IX.isLag[h] ? C.V_LAG : C.V_MAIN;
        for (let o = IX.trS[h]; o < IX.trS[h + 1]; o += 2) if (IX.trA[o] === g) s = Math.min(s, mh * C.DETOUR / vh + IX.trA[o + 1]);
      }
      if (s >= INF) continue;                                  // non raggiungibile a piedi dalle fermate più vicine (altra riva, oltre la ferrovia…)
    } else s = m * C.DETOUR / v;
    s = Math.round(s * wf); if (s > maxS) continue;
    if (!out.has(g) || out.get(g) > s) out.set(g, s);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// PREFERENZE (filtri del pannello, tutti facoltativi)
//   mezzi: Set('nav','bus','tram') · cambi: 0..4 · piediMax: minuti per ogni tratto a piedi · passo: lento|normale|veloce
//   margine: normale|largo · pref: equilibrata|veloce|cambi|piedi · escludi / solo: Set("src:route") (alternative)
// ---------------------------------------------------------------------------------------------------------------------
function normPref(o = {}) {
  const pref = C.PREF[o.pref] ? o.pref : 'equilibrata';
  return { mezzi: o.mezzi && o.mezzi.size && o.mezzi.size < 3 ? o.mezzi : null, cambi: Number.isInteger(o.cambi) ? Math.max(0, Math.min(C.ROUNDS - 1, o.cambi)) : C.ROUNDS - 1,
    piediMax: o.piediMax > 0 ? o.piediMax * 60 : INF, trMax: C.PREF[pref].maxT || INF, wf: C.PASSO[o.passo] || 1, extra: o.margine === 'largo' ? C.MARGINE_LARGO_S : 0,
    pref, W: C.PREF[pref], escludi: o.escludi?.size ? o.escludi : null, solo: o.solo?.size ? o.solo : null };
}
// costo percepito (vedi C.PREF): D = orario di «arrivo entro» (null = partenza «alle» / adesso)
const cost = (D, arr, leave, cambi, walkS, W, risky = 0, brevi = 0) => (D == null ? arr : -leave) + W.A * (arr - leave) + W.TP * cambi + (W.WW - 1) * walkS
  + C.WALK_EXTRA * Math.max(0, walkS - C.WALK_OK_S) + (D == null ? C.RISCHIO_PEN_S : C.RISCHIO_PEN_ENTRO_S) * risky + C.BREVE_PEN_S * brevi;
// margine minimo di un cambio dalla corsa A alla corsa B (indici dei servizi: 0 = aut, 1 = nav)
const marginOf = (siA, siB) => C.RISCHIO_S + (siA !== siB ? C.RISCHIO_MODALE_S : 0);
// corse brevissime di una soluzione con almeno un cambio
const brevi = list => (list.length > 1 ? list.filter(([d, a]) => a - d < C.BREVE_S).length : 0);
// cambi «a rischio» di una soluzione (orari programmati o aggiornati della ricerca): margine sotto C.RISCHIO_S oltre a quello dell'andatura
function risky(legs, extra = 0) {
  let n = 0, prev = null, walk = 0;
  for (const l of legs) {
    if (l.t === 'ride') {
      const slack = prev ? l.dep - (prev.arr + walk) - extra : INF;
      if (slack < marginOf(prev?.P.si, l.P.si)) n += prev.P.si !== l.P.si && slack < C.IRREALE_S ? C.IRREALE_PESO : 1;
      prev = l; walk = 0;
    } else if (prev) walk += l.s || 0;
  }
  return n;
}
const prefKey = pr => [pr.mezzi ? [...pr.mezzi].sort().join('+') : '', pr.cambi, pr.piediMax, pr.wf, pr.extra, pr.pref, pr.escludi ? [...pr.escludi].sort().join('+') : '', pr.solo ? [...pr.solo].sort().join('+') : ''].join('|');

// «famiglia» di una soluzione: stesse linee, saliti e scesi alle stesse fermate (lettere dei pontili e corsie a parte)
function baseName(g) { const id = IX.ids[g], G = IX.Gs[IX.srcOf[g]], sid = id.slice(4); return (G.stopBaseNames?.get(sid) || G.stops[sid] || sid).toLowerCase(); }
const famOf = legs => legs.filter(l => l.t === 'ride').map(l => l.P.rk + '@' + baseName(l.P.stops[l.p0]) + '>' + baseName(l.P.stops[l.p1])).join('|');

// ---------------------------------------------------------------------------------------------------------------------
// RICERCA: più passate di RAPTOR (all'ora chiesta, «meno a piedi», partenze successive, linee diverse) -> soluzioni candidate
// ---------------------------------------------------------------------------------------------------------------------
function search({ da, a, secs = null, date = null, piediM = null, piediReale = false, entro = false, pr, nowMs, runsMax = 6, discover = true, from = null }) {
  const live = secs == null, ymd = date || cal.romeYmd(nowMs);
  const D = entro && !live ? secs : null;                      // «arrivo entro le»
  const DL = D == null ? null : D + 59;                        // «entro le 9:00» comprende le 9:00 e qualche secondo (orari al minuto)
  const T = live ? cal.romeParts(nowMs).secs : D != null ? D - C.BY_BACK_S : secs;
  const acc = walkTo(da, pr.wf, pr.piediMax), egr = walkTo(a, pr.wf, pr.piediMax);
  const L = [{ off: 0, ymd }], lo = D != null ? D - C.HORIZON_S : Math.min(T, from ?? T), hi = D != null ? D : T + C.HORIZON_S;
  if (lo < 6 * 3600) L.push({ off: -86400, ymd: cal.addDays(ymd, -1) });
  if (hi > 86400) L.push({ off: 86400, ymd: cal.addDays(ymd, 1) });
  for (const x of L) x.act = [0, 1].map(si => activeOf(si, x.ymd));
  const layers = L, opts = [], seen = new Set();
  const allowOf = ex => P => (!pr.mezzi || pr.mezzi.has(P.mode)) && (!pr.escludi || !pr.escludi.has(P.rk)) && (!pr.solo || pr.solo.has(P.rk)) && (!ex || !ex.has(P.rk));
  const short = m => { if (!m.size) return m; const mn = Math.min(...m.values()); return new Map([...m].filter(([, v]) => v <= Math.max(C.SHORT_WALK_S, mn))); };
  const scoreOf = o => cost(D, o.arr, o.leave, o.rides - 1, o.walkS, pr.W, o.risky, brevi(o.legs.filter(l => l.t === 'ride').map(l => [l.dep, l.arr])));
  const leaveOf = o => { const r0 = o.legs.find(l => l.t === 'ride'); return r0.dep - o.legs.slice(0, o.legs.indexOf(r0)).reduce((s, l) => s + (l.s || 0), 0); };
  // una ricerca all'orario ps.t: aggiunge le soluzioni nuove a opts e restituisce la più veloce di questa ricerca (o null)
  const runAt = ps => {
    const q = { T: ps.t, live, nowMs, layers, lc: new Map(), access: [...ps.acc], egress: ps.egr, maxT: Math.min(ps.maxT ?? INF, pr.piediMax, pr.trMax ?? INF),
      K: ps.K ?? pr.cambi + 1, wf: pr.wf, extra: pr.extra, allow: allowOf(ps.ex), noWalkCut: D != null || pr.pref === 'piedi' };
    const R = raptor(q);
    let first = null;
    for (let k = 1; k < R.arr.length; k++) {
      let bg = -1, bt = INF;
      for (const [g, s] of ps.egr) { const v = R.arr[k][g] + s; if (v < bt) { bt = v; bg = g; } }
      if (bg < 0 || bt >= INF) continue;
      let prevBest = INF; for (const [g, s] of ps.egr) for (let h = q.noWalkCut ? 1 : 0; h < k; h++) prevBest = Math.min(prevBest, R.arr[h][g] + s);   // (noWalkCut: il «tutto a piedi» non conta)
      if (bt >= prevBest) continue;                            // nessun miglioramento con un cambio in più
      const legs = journey(q, R, k, bg); if (!legs) continue;
      legs.push({ t: 'egr', g: bg, s: ps.egr.get(bg) });
      refine(q, legs, ps.egr, pr.W);                           // fermate più comode sulle stesse corse (vedi refine)
      { const li = legs.map(l => l.t).lastIndexOf('ride'); bt = legs[li].arr + legs.slice(li + 1).reduce((x, l) => x + (l.s || 0), 0); bg = legs[legs.length - 1].g; }
      const sig = legs.filter(l => l.t === 'ride').map(l => l.P.si + ':' + l.P.n[l.j] + '@' + l.p0 + '-' + l.p1).join('>');
      if (seen.has(sig)) continue; seen.add(sig);
      const o = { legs, arr: bt, rides: legs.filter(l => l.t === 'ride').length, walkS: legs.reduce((s, l) => s + (l.t === 'ride' ? 0 : l.s || 0), 0), fam: famOf(legs) };
      o.risky = risky(o.legs, pr.extra); o.leave = leaveOf(o); o.score = scoreOf(o); opts.push(o); if (!first || o.arr < first.arr) first = o;
    }
    return first;
  };
  const best = () => opts.filter(o => D == null || o.arr <= DL).reduce((m, o) => (!m || o.score < m.score ? o : m), null);
  if (acc.size && egr.size) {
    if (D == null) {
      let t = from ?? T, runs = 0;
      const passes = [{ t, acc, egr }, { t, acc: short(acc), egr: short(egr), maxT: C.SHORT_WALK_S }];
      while (runs < runsMax) {
        const ps = passes[runs] || { t, acc, egr }; runs++;
        const first = runAt(ps);
        if (runs === 2) continue;                              // dopo «meno a piedi» si riparte dalla più veloce
        if (!first) { t += 300; continue; }                    // niente di nuovo (es. la stessa corsa, in ritardo): 5 minuti dopo
        t = Math.max(t + 60, first.leave + 60);
        if (opts.length >= C.OPTIONS + 3) break;
      }
    } else {
      // ARRIVO ENTRO D (solo orari programmati: partendo più tardi non si arriva mai prima, quindi «si arriva in tempo?» cambia una volta sola).
      // 1) L'ULTIMA PARTENZA UTILE si trova per bisezione, al minuto (8 ricerche): con tutte le corse ammesse e con la sola corsa diretta.
      // 2) Le partenze una per una nella mezz'ora prima dell'ultima utile (al massimo 10 ricerche: ognuna riparte dopo la partenza trovata),
      //    così compaiono tutte le soluzioni sensate (es. il battello diretto che parte 2 minuti prima di un percorso tutto a piedi), poi
      //    una «meno a piedi».
      // Prima (fino alla v28) si andava avanti a passi da una partenza 45 minuti prima: con mezzi frequenti i passi finivano prima
      // dell'ultima partenza e si arrivava 10-30 minuti prima del necessario.
      const arrBy = (t, K, ps) => {
        const R = raptor({ T: t, live: false, nowMs, layers, lc: new Map(), access: [...ps.acc], egress: ps.egr, maxT: Math.min(pr.piediMax, pr.trMax ?? INF), K, wf: pr.wf, extra: pr.extra, allow: allowOf(null), noWalkCut: true });
        let b = INF; for (let k = 1; k < R.arr.length; k++) for (const [g, s] of ps.egr) b = Math.min(b, R.arr[k][g] + s);   // solo con i mezzi (a piedi: walkOnly)
        return b;
      };
      const latest = (K, ps) => {
        let lo = D - C.BY_BACK_S, hi = D;
        if (arrBy(lo, K, ps) > DL) { hi = lo; lo = D - C.HORIZON_S; if (arrBy(lo, K, ps) > DL) return null; }
        while (hi - lo > 60) { const mid = lo + Math.floor((hi - lo) / 120) * 60; if (arrBy(mid, K, ps) <= DL) lo = mid; else hi = mid; }
        return lo;
      };
      const tF = latest(pr.cambi + 1, { acc, egr });
      if (tF != null) {
        let t = tF - C.BY_SCAN_S, runs = 0, last = -INF;
        while (t <= tF && runs < 10) {
          runs++; const f = runAt({ t, acc, egr });
          if (!f) { t += 300; continue; }
          last = Math.max(last, t); t = Math.max(t + 60, f.leave + 60);
        }
        if (last < tF) runAt({ t: tF, acc, egr });
        runAt({ t: tF - 20 * 60, acc: short(acc), egr: short(egr), maxT: C.SHORT_WALK_S });   // meno a piedi
        // (v33.2) l'ultima partenza utile anche SENZA cambi e con UN cambio al massimo: le soluzioni più comode che «Partenza alle» darebbe e che
        // la sola scansione della mezz'ora prima di tF non trovava (es. il diretto che parte 35 minuti prima)
        for (const K of [1, 2]) {
          if (K >= pr.cambi + 1) break;
          const tK = latest(K, { acc, egr });
          if (tK != null && tK < tF && tF - tK <= C.BY_COMODO_S) runAt({ t: tK, acc, egr, K });
        }
      }
    }
    // linee diverse: senza le linee della soluzione migliore, poi senza la sua prima linea (altre «famiglie» da proporre)
    const b = discover && !pr.solo ? best() : null;
    if (b) {
      const rks = b.legs.filter(l => l.t === 'ride').map(l => l.P.rk), t0 = D == null ? (from ?? T) : Math.max(T, b.leave - 1800);
      runAt({ t: t0, acc, egr, ex: new Set(rks) });
      if (rks.length > 1) runAt({ t: t0, acc, egr, ex: new Set([rks[0]]) });
    }
  }
  if (D != null) for (let k = opts.length - 1; k >= 0; k--) if (opts[k].arr > DL) opts.splice(k, 1);
  // solo a piedi: fermate di partenza e arrivo collegate a piedi (laguna) o punti vicini in linea d'aria (terraferma)
  let walkOnly = null;
  if (piediReale && piediM != null && piediM <= C.REAL_MAX_M) {   // misurata dal telefono lungo le strade (anche in laguna: ponti compresi)
    const lag = IX && [...acc.keys(), ...egr.keys()].some(g => IX.isLag[g]);
    walkOnly = Math.round(piediM / (lag ? C.V_LAG : C.V_MAIN) * pr.wf);
  } else if (piediM != null && piediM <= 2500 && !(IX && [...acc.keys()].some(g => IX.isLag[g]))) walkOnly = Math.round(piediM * C.DETOUR / C.V_MAIN * pr.wf);
  // lungo la rete pedonale anche passando per altre fermate (catena di tratti tra fermate vicine), fino a 40 minuti: copre i tragitti
  // a piedi più lunghi di quelli precalcolati (es. P.le Roma -> S. Tomà). Dijkstra sulle sole fermate: poche centinaia di nodi in laguna.
  if (acc.size && egr.size) {
    const LIM = C.WALK_ONLY_MAX_S, dist = new Map(), heap = [];
    const push = (d, g) => { heap.push([d, g]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= d) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= heap.length) break; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++; if (heap[c][0] >= heap[i][0]) break; [heap[c], heap[i]] = [heap[i], heap[c]]; i = c; } } return top; };
    for (const [g, s0] of acc) if (s0 < (dist.get(g) ?? INF)) { dist.set(g, s0); push(s0, g); }
    let bestW = walkOnly ?? INF;
    while (heap.length) {
      const [d, g] = pop(); if (d > (dist.get(g) ?? INF) || d >= Math.min(LIM, bestW)) continue;
      const e = egr.get(g); if (e != null) bestW = Math.min(bestW, d + e);
      for (let o = IX.trS[g]; o < IX.trS[g + 1]; o += 2) { const h = IX.trA[o], nd = d + Math.round(IX.trA[o + 1] * pr.wf); if (nd < (dist.get(h) ?? INF) && nd < LIM) { dist.set(h, nd); push(nd, h); } }
    }
    if (bestW < INF) walkOnly = bestW;
  }
  return { opts, T, D, live, ymd, walkOnly, noStops: !acc.size ? 'da' : !egr.size ? 'a' : null };
}

const cache = new Map();
const cached = (key, nowMs, fn) => { const hit = cache.get(key); if (hit && nowMs - hit.at < C.CACHE_MS) return hit.v; const v = fn(); if (cache.size > C.CACHE_MAX) cache.clear(); cache.set(key, { at: nowMs, v }); return v; };
// famiglia consigliata per tragitto (solo in memoria, nessun dato personale: fermate vicine e preferenze, come la cache), vedi C.STICKY_S
const STICK = new Map();
function stickOf(key, nowMs) {
  return {
    get: () => { const v = STICK.get(key); return v && nowMs - v.at < C.STICKY_MS ? v.fam : null; },
    set: fam => { if (STICK.size >= C.STICKY_MAX) { for (const [k, v] of STICK) if (nowMs - v.at >= C.STICKY_MS) STICK.delete(k); if (STICK.size >= C.STICKY_MAX) STICK.clear(); } STICK.delete(key); STICK.set(key, { fam, at: nowMs }); }
  };
}
const timeKey = (secs, nowMs) => (secs == null ? 'now' + Math.floor(nowMs / C.CACHE_MS) : secs);

// da / a: [[ "src:sid", metri ]]; secs/date: orario scelto (null = adesso, tempo reale); piediM: distanza in linea d'aria tra i due punti (facoltativa)
// entro: secs è l'orario entro cui ARRIVARE (soluzioni che partono il più tardi possibile); prefs: filtri (vedi normPref)
// Gs (facoltativo): orari da usare [aut, nav] per la data scelta (server.js -> live.dataFor); assente = quelli in uso adesso
function plan({ da, a, secs = null, date = null, piediM = null, piediReale = false, entro = false, prefs = {}, Gs = null }) {
  if (!ctx) throw new Error('pianificatore non inizializzato');
  build(Gs || undefined);
  const nowMs = Date.now(), pr = normPref(prefs);
  const stick = secs == null ? stickOf(JSON.stringify([IX.key, da, a, piediM, piediReale, prefKey(pr)]), nowMs) : null;   // solo «adesso»
  return cached(JSON.stringify(['p', IX.key, da, a, timeKey(secs, nowMs), date, piediM, piediReale, entro, prefKey(pr)]), nowMs, () => {
    const r = search({ da, a, secs, date, piediM, piediReale, entro, pr, nowMs });
    return present({ ...r, nowMs, pr, stick });
  });
}

// ALTERNATIVE di una soluzione scelta (famiglia `fam`, linee `rotte`):
//   stesso: lo stesso percorso ad altri orari · varianti: una linea sostituita · altre: nessuna delle sue linee
// arr: arrivo della soluzione scelta («hh:mm»): le alternative non arrivano più di 30 minuti dopo (né, con «arrivo entro», oltre l'orario)
function simili({ da, a, secs = null, date = null, piediM = null, piediReale = false, entro = false, prefs = {}, fam, rotte = [], arr = null, Gs = null }) {
  if (!ctx) throw new Error('pianificatore non inizializzato');
  build(Gs || undefined);
  const nowMs = Date.now(), base = normPref(prefs), rs = [...new Set(rotte)].slice(0, 4);
  return cached(JSON.stringify(['s', IX.key, da, a, timeKey(secs, nowMs), date, entro, prefKey(base), fam, rs, arr]), nowMs, () => {
    // stesso percorso: solo quelle linee, da mezz'ora prima (orario scelto) o da adesso, per le partenze successive
    const live = secs == null, T0 = live ? null : entro ? secs - 2 * 3600 : secs - 1800;
    const same = search({ da, a, secs: live ? null : T0, date, entro: false, pr: { ...base, solo: new Set(rs), escludi: null }, nowMs, runsMax: 9, discover: false });
    same.opts = same.opts.filter(o => o.fam === fam && (!entro || o.arr < secs + 60));
    const stesso = present({ ...same, D: null, nowMs, pr: base, all: true }).soluzioni;
    // varianti: senza una delle sue linee (alla volta); altre linee: senza nessuna
    const famsSeen = new Set([fam]), varianti = [], altre = [];
    for (const rk of rs.length > 1 ? rs : []) {
      const r = search({ da, a, secs, date, piediM, piediReale, entro, pr: { ...base, escludi: new Set([...(base.escludi || []), rk]) }, nowMs, runsMax: 2, discover: false });
      const v = present({ ...r, nowMs, pr: base }).soluzioni.find(o => !famsSeen.has(o.famiglia) && o.rotte.some(x => rs.includes(x)));
      if (v) { famsSeen.add(v.famiglia); varianti.push(v); }
    }
    const r = search({ da, a, secs, date, piediM, piediReale, entro, pr: { ...base, escludi: new Set([...(base.escludi || []), ...rs]) }, nowMs, runsMax: 3, discover: false });
    for (const o of present({ ...r, nowMs, pr: base }).soluzioni) if (!famsSeen.has(o.famiglia) && altre.length < 3) { famsSeen.add(o.famiglia); altre.push(o); }
    if (arr) {
      const ref = toS(arr, live ? cal.romeParts(nowMs).secs : secs), near = o => toS(o.arrivi, ref) <= ref + C.ALT_LATER_S;
      return { aggiornato: nowMs, live, stesso, varianti: varianti.filter(near), altre: altre.filter(near) };
    }
    return { aggiornato: nowMs, live, stesso, varianti, altre };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// RISPOSTA: tratte con nomi, orari (gli stessi del pannello fermata), tracciato sulla mappa
// ---------------------------------------------------------------------------------------------------------------------
function stopInfo(g) {
  const id = IX.ids[g], si = IX.srcOf[g], G = IX.Gs[si], sid = id.slice(4);
  return { id, name: G.stops[sid] || sid, lat: Number.isFinite(IX.lat[g]) ? +IX.lat[g].toFixed(5) : null, lon: Number.isFinite(IX.lon[g]) ? +IX.lon[g].toFixed(5) : null };
}
// all: tutte le soluzioni in ordine di partenza (alternative «stesso percorso»), senza scegliere tra le famiglie
function present({ opts, T, live, ymd, nowMs, walkOnly, noStops, D = null, pr = normPref(), all = false, stick = null }) {
  const rowsCache = new Map();
  const out = opts.map(o => {
    const legs = [], rides = o.legs.filter(l => l.t === 'ride');
    let walkS = 0, prevArr = null, risk = false, walkSince = 0, nRisk = 0, nPen = 0, prevSi = null, persaAny = false;
    const times = [];
    for (const l of o.legs) {
      if (l.t !== 'ride' && prevArr != null) walkSince += Math.round(l.s || 0);
      const prevLeg = legs[legs.length - 1];
      if ((l.t === 'walk' || l.t === 'egr') && prevLeg && prevLeg.tipo === 'piedi' && !prevLeg.estremo) {   // due tratti a piedi di fila: uno solo
        const s = Math.round(l.s || 0); walkS += s; prevLeg.min = Math.max(1, Math.round((prevLeg.min * 60 + s) / 60));
        if (l.t === 'walk') prevLeg.a = stopInfo(l.to); else { delete prevLeg.a; prevLeg.estremo = 'arrivo'; }
        continue;
      }
      if (l.t === 'acc' || l.t === 'egr' || l.t === 'walk') {
        const s = Math.round(l.s || 0); walkS += s;
        if (l.t === 'walk') legs.push({ tipo: 'piedi', min: Math.max(1, Math.round(s / 60)), da: stopInfo(l.from), a: stopInfo(l.to) });
        else if (s >= 30) legs.push({ tipo: 'piedi', min: Math.max(1, Math.round(s / 60)), [l.t === 'acc' ? 'a' : 'da']: stopInfo(l.g), estremo: l.t === 'acc' ? 'partenza' : 'arrivo' });
        continue;
      }
      const P = l.P, st = P.st[l.j], G = IX.Gs[P.si], i = SRC[P.si], tid = G.tripIds[P.n[l.j]], trip = G.trips[tid], r = G.routes[trip.route] || {};
      const g0 = P.stops[l.p0], g1 = P.stops[l.p1];
      const sched0 = st.d[l.p0] + l.L.off, sched1 = st.a[l.p1] + l.L.off;
      // stato alla fermata di salita e di discesa: le righe del pannello fermata (stessi tempi, stesse diciture)
      // (una sola lettura per fermata, condivisa da tutte le soluzioni)
      const row = g => { if (!rowsCache.has(g)) rowsCache.set(g, ctx.rows?.(i, IX.ids[g].slice(4)) || []); const r = rowsCache.get(g).filter(x => x.tripId === tid && !x.done); return r.find(x => !x.arrival) || r[0] || null; };
      const r0 = live && l.L.off === 0 ? row(g0) : null, r1 = live && l.L.off === 0 ? row(g1) : null;
      const at = (x, sched) => x && x.live ? { sched: hhmm(sched), exp: x.exp, delay: x.delay, live: true, expMs: x.expMs ? Math.round(x.expMs) : null, phase: x.phase || null, cancel: x.cancel || null }
        : { sched: hhmm(sched), exp: hhmm(sched), delay: null, live: false, expMs: live ? nowMs + (sched - T) * 1000 : null, cancel: x?.cancel || null };
      // (v33.1) senza la riga del pannello fermata valgono i tempi usati dalla ricerca (ritardi e anticipi del feed), non l'orario programmato
      const dep = r0?.live ? at(r0, sched0) : liveAt(at(r0, sched0), sched0, l.dep), arr = r1?.live ? at(r1, sched1) : liveAt(at(r1, sched1), sched1, l.arr);
      const depS = dep.live && dep.expMs ? T + (dep.expMs - nowMs) / 1000 : sched0 + (dep.delay || 0) * 60;
      const arrS = arr.live && arr.expMs ? T + (arr.expMs - nowMs) / 1000 : sched1 + (arr.delay || 0) * 60;
      let cambioMin = null, aRischio = false, persa = false;
      if (prevArr != null) {                                  // margine del cambio: partenza di questa corsa − (arrivo della precedente + strada a piedi)
        const slack = depS - (prevArr + walkSince) - (pr.extra || 0);
        cambioMin = Math.max(0, Math.floor((depS - prevArr - walkSince) / 60)); aRischio = slack < marginOf(prevSi, P.si);
        if (slack < 0) { risk = true; persa = true; persaAny = true; }        // con i tempi aggiornati (ritardi) si arriva dopo la partenza: coincidenza persa
        if (aRischio) { nRisk++; nPen += prevSi !== P.si && slack < C.IRREALE_S ? C.IRREALE_PESO : 1; }
      }
      prevArr = arrS; walkSince = 0; prevSi = P.si; times.push([depS, arrS]);
      // tracciato della tratta (solo il pezzo percorso)
      let shape = null;
      try {
        const sh = trip.shape ? tracker.shapeInfo(G, trip.shape) : null, offs = sh ? tracker.stopOffsets(G, trip, st) : null;
        if (sh && offs) shape = tracker.slice(sh, offs[l.p0], offs[l.p1], 160);
      } catch { /* senza tracciato: si disegnano le fermate */ }
      const stopsOn = []; for (let p = l.p0; p <= l.p1; p++) { const x = stopInfo(P.stops[p]); stopsOn.push([x.lat, x.lon, x.name]); }
      legs.push({ tipo: 'mezzo', src: i, route: P.rk, mode: P.mode, tripId: tid, line: r.name || trip.route, color: r.color || null, headsign: trip.headsign || G.stops[st.s[st.s.length - 1]] || null,
        da: { ...stopInfo(g0), ...dep }, a: { ...stopInfo(g1), ...arr }, fermate: l.p1 - l.p0, pos: [l.p0, l.p1], veh: r0?.veh || null, vehicle: r0?.vehicle || null,
        trk: r0 ? (r0.trk ?? (r0.veh ? 3 : r0.live ? 2 : 0)) : 0, shape, stops: stopsOn, ...(cambioMin != null ? { cambioMin, aRischio, ...(persa ? { persa } : {}) } : {}) });
    }
    const first = legs.find(x => x.tipo === 'mezzo'), last = [...legs].reverse().find(x => x.tipo === 'mezzo');
    // a piedi prima della prima corsa e dopo l'ultima (anche i cambi a piedi fuori dai mezzi)
    const iF = o.legs.findIndex(l => l.t === 'ride'), iL = o.legs.length - 1 - [...o.legs].reverse().findIndex(l => l.t === 'ride');
    const accS = o.legs.slice(0, iF).reduce((x, l) => x + (l.s || 0), 0), egrS = o.legs.slice(iL + 1).reduce((x, l) => x + (l.s || 0), 0);
    // orari al minuto come nelle tratte (stesso arrotondamento del pannello fermata): partenza e arrivo coerenti con quel che si legge sotto
    const firstDep = first ? toS(first.da.exp, T) : T;
    const leaveS = firstDep - accS, arriveS = (last ? toS(last.a.exp, T) : T) + egrS;
    return { parti: hhmm(leaveS), arrivi: hhmm(arriveS), partiMs: live ? Math.round(nowMs + (leaveS - T) * 1000) : null, minuti: Math.max(1, Math.round((arriveS - leaveS) / 60)),
      cambi: Math.max(0, rides.length - 1), piedi: Math.round(walkS / 60), rischio: risk, aRischio: nRisk, famiglia: o.fam, rotte: rides.map(l => l.P.rk), tratte: legs,
      ...(D != null ? { margine: Math.max(0, Math.floor((D - arriveS) / 60)), limite: D - arriveS < C.LIMITE_S || nRisk > 0 } : {}),
      _arr: arriveS, _leave: leaveS, _persa: persaAny, _score: cost(D, arriveS, leaveS, Math.max(0, rides.length - 1), walkS, pr.W, nPen, brevi(times))
        + (D != null ? C.LIMITE_PESO * Math.max(0, C.LIMITE_S - (D - arriveS)) : 0) };
  }).filter(o => o.tratte.some(x => x.tipo === 'mezzo') && (D == null || o._arr < D + 60) && !(live && o._leave < T - C.PASSATA_S));
  // «adesso»: una coincidenza già persa con i tempi aggiornati si propone solo se non c'è altro
  if (live && out.some(o => !o._persa)) for (let k = out.length - 1; k >= 0; k--) if (out[k]._persa) out.splice(k, 1);   // «entro le 18:00»: va bene chi arriva alle 18:00 (orari al minuto)
  const clean = o => { delete o._arr; delete o._leave; delete o._score; delete o._persa; return o; };
  const head = { aggiornato: nowMs, live, ora: hhmm(T), data: ymd, entro: D != null ? hhmm(D) : null,
    piedi: walkOnly != null && walkOnly < INF && walkOnly <= 40 * 60 ? Math.max(1, Math.round(walkOnly / 60)) : null, senzaFermate: noStops };
  if (all) {                                                     // stesso percorso, altri orari: in ordine di partenza, una per orario
    const by = new Map(); for (const o of out.sort((x, y) => x._leave - y._leave || x._arr - y._arr)) { const k = o.parti + '>' + o.arrivi; if (!by.has(k)) by.set(k, o); }
    return { ...head, soluzioni: [...by.values()].slice(0, 10).map(clean) };
  }
  // 1) soluzioni inutili: un'altra non chiede di partire prima (o, con «arrivo entro», di arrivare dopo) e «costa» meno, contando cambi e
  //    strada a piedi con i pesi della preferenza (es. scendere per prendere un'altra linea che arriva 30 s prima: costa un cambio, si scarta)
  //    Si toglie solo se l'altra è almeno altrettanto buona sia nella partenza sia nell'arrivo (2 minuti di tolleranza): chi arriva prima resta
  //    proposto anche se la consigliata è un diretto che parte più tardi.
  // (v33.1) chi ha meno cambi si toglie solo se l'altra è migliore di almeno TIE_S + BETTER_S: a costi quasi uguali resta il diretto
  const useless = (b, o) => b !== o && b._score <= o._score - (o.cambi < b.cambi ? C.TIE_S + C.BETTER_S : C.BETTER_S) && b._leave >= o._leave - 120 && b._arr <= o._arr + 120;
  // ...e rispetto all'andare a piedi: chi arriva dopo chi parte adesso a piedi ha senso solo se diretto e senza lunghe camminate
  // (per chi non vuole camminare), non con cambi o con metà strada comunque a piedi
  const wo = walkOnly != null && walkOnly < INF ? walkOnly : null;
  const worse = o => wo != null && (D == null ? o._arr > T + wo : o._leave < D - wo) && (o.cambi > 0 || o.piedi * 60 >= wo / 2);   // con «arrivo entro»: a piedi si parte più tardi
  // «arrivo entro»: niente proposte che fanno partire molto prima dell'ultima partenza utile (come le app di trasporto);
  // partenza «alle»: niente proposte che arrivano molto dopo la prima. Restano tra gli «altri orari» delle proposte tenute; mai tutte.
  // (v33.1) riferimento senza coincidenze a rischio, se ce ne sono: una partenza «al limite» non deve far scartare le soluzioni sicure di poco prima
  const ref = out.some(o => !o.aRischio) ? out.filter(o => !o.aRischio) : out;
  const latestLeave = D == null || !ref.length ? 0 : Math.max(...ref.map(o => o._leave));
  const firstArr = D != null || !ref.length ? 0 : Math.min(...ref.map(o => o._arr));
  const lastRef = D == null || !ref.length ? null : ref.reduce((m, o) => (o._leave > m._leave ? o : m), ref[0]);
  const comodo = o => lastRef && (o.cambi < lastRef.cambi || o.piedi <= lastRef.piedi - 5);
  const early = o => D != null && latestLeave - o._leave > (comodo(o) ? C.BY_COMODO_S : C.BY_EARLY_S);
  const late = o => D == null && o._arr - firstArr > (pr.pref === 'cambi' || pr.pref === 'piedi' ? 50 * 60 : C.LATE_S);
  const stickFam = stick ? stick.get() : null;                 // la consigliata dell'aggiornamento precedente non si scarta come «inutile» (decide STICKY_S)
  const keep = out.filter(o => (o.famiglia === stickFam || !out.some(b => useless(b, o))) && !worse(o));
  // 2) famiglie (stesse linee, stesse fermate di salita e discesa): se ne propone una per tipo, la migliore, con gli altri orari della stessa
  const fams = new Map();
  for (const o of keep) (fams.get(o.famiglia) || fams.set(o.famiglia, []).get(o.famiglia)).push(o);
  const reps = [];
  for (const list of fams.values()) {
    list.sort((x, y) => x._score - y._score);
    const r = list[0], others = list.slice(1).filter(o => (D == null ? o._leave > r._leave : o._leave < r._leave)).sort((x, y) => (D == null ? x._leave - y._leave : y._leave - x._leave));
    r.poi = others.slice(0, 3).map(o => ({ parti: o.parti, arrivi: o.arrivi })); reps.push(r);
  }
  reps.sort((x, y) => x._score - y._score || x._leave - y._leave);
  // le proposte che fanno arrivare troppo presto si tolgono (restano tra gli «altri orari» di quelle tenute); mai tutte
  const near = reps.filter(o => !early(o) && !late(o));
  const pool = near.length ? near : reps;
  // costi equivalenti (meno di TIE_S): prima meno cambi, poi meno a piedi
  if (pool.length > 1) {
    const b0 = pool[0]._score, eq = pool.filter(o => o._score - b0 < C.TIE_S).sort((x, y) => x.cambi - y.cambi || x.piedi - y.piedi || x._score - y._score);
    if (eq[0] !== pool[0]) { pool.splice(pool.indexOf(eq[0]), 1); pool.unshift(eq[0]); }
  }
  // in tempo reale resta consigliata la famiglia dell'aggiornamento precedente, se è ancora valida e quasi buona come la migliore
  if (stick && pool.length > 1) {
    const o = stickFam && pool.find(x => x.famiglia === stickFam && !x.rischio);
    if (o && o !== pool[0] && o._score - pool[0]._score <= C.STICKY_S) { pool.splice(pool.indexOf(o), 1); pool.unshift(o); }
  }
  if (stick && pool.length) stick.set(pool[0].famiglia);
  const pick = pool.slice(0, C.OPTIONS);
  // 3) etichette: la consigliata (costo più basso con la preferenza scelta), poi chi arriva prima / parte più tardi, meno cambi, meno a piedi
  if (pick.length > 1) {
    const top = pick[0], by = f => pick.reduce((m, o) => (f(o) < f(m) ? o : m), pick[0]);
    top.etichetta = 'Consigliata';
    const fast = D == null ? by(o => o._arr * 10 + o.cambi) : by(o => -o._leave * 10 + o.cambi);
    if (fast !== top && (D == null ? fast._arr < top._arr - 59 : fast._leave > top._leave + 59)) fast.etichetta = D == null ? 'Arrivo prima' : 'Parti più tardi';
    const few = by(o => o.cambi * 1e6 + o._score); if (!few.etichetta && few.cambi < top.cambi) few.etichetta = 'Meno cambi';
    const walk = by(o => o.piedi * 1e6 + o._score); if (!walk.etichetta && walk.piedi <= top.piedi - 2) walk.etichetta = 'Meno a piedi';
  }
  return { ...head, preferenza: pr.pref, soluzioni: pick.map(clean) };
}
const toS = (hm, T) => { const [h, m] = String(hm).split(':').map(Number); let s = h * 3600 + m * 60; while (s < T - 43200) s += 86400; while (s > T + 43200) s -= 86400; return s; };

module.exports = { init, plan, simili, build, C, _t: { walkTo, raptor, get IX() { return IX; }, clearCache: () => cache.clear() } };
