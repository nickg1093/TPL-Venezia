// ACQUA ALTA: quote stimate delle calli e percorsi su passerelle, per l'app sul telefono (public/js/acqua.js).
// Funzioni pure, senza dipendenze; usate da scripts/genera-acqua.js. Nessun dato e nessun calcolo sul server.
//
// DATI DI PARTENZA (cartella data/acqua, con le fonti):
//   passerelle-atlante.json  i percorsi della tabella ufficiale del Comune (Centro Maree / Veritas): tavola, quota di posa, lunghezza,
//                            descrizione, più i punti di partenza e arrivo cercati per nome su OpenStreetMap (o stimati, segnati)
//   quote-riferimenti.json   curva ufficiale del suolo allagato per livello di marea, pochi punti di quota noti, zone del modello
// RETE: le mattonelle della rete pedonale già pubblicate per i telefoni (scripts/pedoni-core.js), le stesse usate dai percorsi a piedi.
//
// METODO (stima indicativa, dichiarata come tale nell'app). È la riserva dove manca il rilievo RAMSES delle pavimentazioni (opzione
// --ramses di genera-acqua.js, funzione rilievo() qui sotto e scripts/ramses-core.js), che dove c'è sostituisce la stima con le quote misurate:
//  1. ogni percorso su passerelle si ricalca sulla rete pedonale (percorso più breve tra partenza e arrivo, scegliendo la coppia di punti
//     la cui lunghezza è più vicina a quella ufficiale): se la lunghezza torna, «tracciato»; altrimenti «indicativo»;
//  2. la quota di posa di ogni percorso è un punto certo: lì la calle si bagna intorno a quel livello. Con i punti noti del Comune
//     (San Marco, Rialto, stazione) si stima una quota per ogni tratto (media pesata sulla distanza, con una quota di fondo per le zone
//     lontane dai punti noti);
//  3. nella città storica le quote stimate si «calibrano» sulla curva ufficiale: l'ordine dal più basso al più alto resta quello della
//     stima, ma la lunghezza di calli allagate a ogni livello coincide con la percentuale pubblicata. Vicino alle passerelle resta la quota
//     di posa. Murano, Burano-Mazzorbo e San Michele usano solo la stima. Fuori dalle zone del modello (Lido, Pellestrina, terraferma…) nulla;
//  4. ponti: sempre asciutti (scale e piano del ponte), dal segno nelle mattonelle o, nelle mattonelle vecchie, dalle scale.
// Dati derivati da OpenStreetMap (© OpenStreetMap contributors, ODbL) e dalle pubblicazioni del Comune di Venezia.
'use strict';

const U = 1e6;                                                   // coordinate delle mattonelle: milionesimi di grado
const E5 = 1e5;                                                  // coordinate dei file prodotti: centomillesimi di grado (~1 m)
const mDist = (la1, lo1, la2, lo2) => { const k = Math.cos((la1 + la2) / 2 * Math.PI / 180); return Math.hypot((la1 - la2) * 111320, (lo1 - lo2) * 111320 * k); };

// ---- rete pedonale dalle mattonelle (stesso formato letto da public/js/pedoni.js) ----
function rete(tiles, CL, CO) {
  const nodes = new Map(), edges = [], sigs = new Set();
  const node = (la, lo) => { const k = la * 1e8 + lo; let n = nodes.get(k); if (!n) nodes.set(k, n = { id: nodes.size, la, lo, adj: [] }); return n; };
  for (const [c, T] of Object.entries(tiles)) {
    if (!T || T.f !== 1 || !Array.isArray(T.n) || !Array.isArray(T.e)) continue;
    const [r, q] = c.split('_').map(Number), bla = Math.round(r * CL * U), blo = Math.round(q * CO * U), N = [];
    for (let i = 0; i + 1 < T.n.length; i += 2) N.push(node(bla + T.n[i], blo + T.n[i + 1]));
    for (const row of T.e) {
      const a = N[row[0]], b = N[row[1]]; if (!a || !b || !(row[2] > 0)) continue;
      const sig = (a.la * 1e8 + a.lo) + '|' + (b.la * 1e8 + b.lo) + '|' + row[2]; if (sigs.has(sig)) continue; sigs.add(sig);
      const g = [[a.la, a.lo]]; let pl = a.la, pn = a.lo;
      for (let i = 4; i + 1 < row.length; i += 2) { pl += row[i]; pn += row[i + 1]; g.push([pl, pn]); }
      g.push([b.la, b.lo]);
      let len = 0; for (let i = 1; i < g.length; i++) len += mDist(g[i - 1][0] / U, g[i - 1][1] / U, g[i][0] / U, g[i][1] / U);
      const e = { id: edges.length, a, b, w: row[2] / 10, s: row[3] | 0, g, len };
      edges.push(e); a.adj.push(e); if (b !== a) b.adj.push(e);
    }
  }
  for (const e of edges) e.ponte = ponte(e);
  return { nodes: [...nodes.values()], edges };
}

// Ponte (sempre asciutto): segno 2 nelle mattonelle nuove; nelle vecchie le scale (bit 1) e il piano corto tra due scale.
// La stessa regola è in public/js/acqua.js (prova di coerenza in tests/acqua.test.js).
function ponte(e) {
  if (e.s & 2 || e.s & 1) return true;
  if (e.len > 40) return false;
  const scale = n => n.adj.some(x => x !== e && (x.s & 1));
  return scale(e.a) && scale(e.b);
}

// ---- percorso più breve (Dijkstra sui metri reali) tra due nodi ----
function cammino(R, from, to, limite = 3000) {
  if (from === to) return { m: 0, nodi: [from], archi: [] };
  const dist = new Map([[from, 0]]), prev = new Map(), done = new Set(), Q = [[0, from]];
  while (Q.length) {
    let bi = 0; for (let i = 1; i < Q.length; i++) if (Q[i][0] < Q[bi][0]) bi = i;
    const [d, u] = Q.splice(bi, 1)[0];
    if (done.has(u)) continue; done.add(u);
    if (u === to) break;
    if (d > limite) return null;
    for (const e of u.adj) {
      const v = e.a === u ? e.b : e.a, nd = d + e.len;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, e); Q.push([nd, v]); }
    }
  }
  if (!prev.has(to)) return null;
  const archi = [], nodi = [to]; let n = to;
  while (n !== from) { const e = prev.get(n); archi.push(e); n = e.a === n ? e.b : e.a; nodi.push(n); }
  return { m: dist.get(to), nodi: nodi.reverse(), archi: archi.reverse() };
}

// indice spaziale dei nodi (celle di ~50 m) per agganciare un punto al nodo più vicino
function indiceNodi(R) {
  const S = 0.0005, M = new Map(), key = (la, lo) => Math.floor(la / U / S) + ',' + Math.floor(lo / U / S);
  for (const n of R.nodes) { if (!n.adj.length) continue; const k = key(n.la, n.lo); let l = M.get(k); if (!l) M.set(k, l = []); l.push(n); }
  return (lat, lon, maxM = 60) => {
    const r = Math.floor(lat / S), q = Math.floor(lon / S); let best = null, bd = maxM;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const n of M.get((r + a) + ',' + (q + b)) || []) {
      const d = mDist(lat, lon, n.la / U, n.lo / U); if (d < bd) { bd = d; best = n; }
    }
    return best ? { n: best, d: bd } : null;
  };
}

// geometria di un cammino (punti in gradi), unendo le forme degli archi nel verso giusto
function forma(path) {
  const out = [[path.nodi[0].la / U, path.nodi[0].lo / U]];
  path.archi.forEach((e, i) => { const g = path.nodi[i] === e.a ? e.g : [...e.g].reverse(); for (let k = 1; k < g.length; k++) out.push([g[k][0] / U, g[k][1] / U]); });
  return out;
}

// aggancio di un punto al TRATTO più vicino (proiezione sul segmento, non solo sui nodi): i percorsi brevi stanno spesso a metà di una riva
function indiceTratti(R, conPonti = false) {
  const S = 0.0004, M = new Map(), key = (r, q) => r + ',' + q;
  for (const e of R.edges) {
    if (e.ponte && !conPonti) continue;
    let along = 0;
    for (let i = 1; i < e.g.length; i++) {
      const a = [e.g[i - 1][0] / U, e.g[i - 1][1] / U], b = [e.g[i][0] / U, e.g[i][1] / U], L = mDist(a[0], a[1], b[0], b[1]);
      const sg = { e, i, a, b, L, at: along }; along += L;
      for (let r = Math.floor(Math.min(a[0], b[0]) / S); r <= Math.floor(Math.max(a[0], b[0]) / S); r++)
        for (let q = Math.floor(Math.min(a[1], b[1]) / S); q <= Math.floor(Math.max(a[1], b[1]) / S); q++) { const k = key(r, q); let l = M.get(k); if (!l) M.set(k, l = []); l.push(sg); }
    }
  }
  return (lat, lon, maxM = 60) => {
    const r = Math.floor(lat / S), q = Math.floor(lon / S), kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320; let best = null;
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (const sg of M.get(key(r + x, q + y)) || []) {
      const ax = (sg.a[1] - lon) * kx, ay = (sg.a[0] - lat) * ky, bx = (sg.b[1] - lon) * kx, by = (sg.b[0] - lat) * ky, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d <= maxM && (!best || d < best.d)) best = { e: sg.e, d, along: sg.at + t * sg.L, pt: [sg.a[0] + t * (sg.b[0] - sg.a[0]), sg.a[1] + t * (sg.b[1] - sg.a[1])], i: sg.i };
    }
    return best;
  };
}
// pezzo di geometria di un tratto tra due distanze dall'inizio (m), nel verso da «da» a «a»
function pezzo(e, da, a) {
  const g = e.g.map(([la, lo]) => [la / U, lo / U]), out = []; const lo = Math.min(da, a), hi = Math.max(da, a); let along = 0;
  const at = d => { let s = 0; for (let i = 1; i < g.length; i++) { const L = mDist(g[i - 1][0], g[i - 1][1], g[i][0], g[i][1]); if (s + L >= d || i === g.length - 1) { const f = L ? Math.min(1, Math.max(0, (d - s) / L)) : 0; return [g[i - 1][0] + (g[i][0] - g[i - 1][0]) * f, g[i - 1][1] + (g[i][1] - g[i - 1][1]) * f]; } s += L; } return g[0]; };
  out.push(at(lo));
  for (let i = 1; i < g.length - 1; i++) { along += mDist(g[i - 1][0], g[i - 1][1], g[i][0], g[i][1]); if (along > lo && along < hi) out.push(g[i]); }
  out.push(at(hi));
  return da <= a ? out : out.reverse();
}
// percorso tra due agganci: stesso tratto (pezzo), oppure pezzo + cammino tra nodi + pezzo; { m, g }
function traAgganci(R, A, B, limite) {
  if (A.e === B.e) return { m: Math.abs(A.along - B.along), g: pezzo(A.e, A.along, B.along) };
  let best = null;
  for (const [na, ma] of [[A.e.a, A.along], [A.e.b, A.e.len - A.along]]) for (const [nb, mb] of [[B.e.a, B.along], [B.e.b, B.e.len - B.along]]) {
    const c = cammino(R, na, nb, limite); if (!c) continue;
    const m = ma + c.m + mb; if (best && m >= best.m) continue;
    const g1 = pezzo(A.e, A.along, na === A.e.a ? 0 : A.e.len), g3 = pezzo(B.e, nb === B.e.a ? 0 : B.e.len, B.along);
    best = { m, g: [...g1, ...(c.archi.length ? forma(c).slice(1, -1) : []), ...g3] };
  }
  return best;
}

// ---- 1 bis. tracciati LEGATI ALLA RETE PEDONALE (v33.12) ----
// Un tracciato (dalla tavola dell'Atlante o ricalcato) si sostituisce con la strada della rete OSM che gli corre sopra: stessa geometria
// delle calli usate dal pianificatore, così il telefono riconosce senza ambiguità i tratti percorsi su passerella. Ricerca del cammino
// tra le proiezioni dei due capi sui tratti più vicini, con un costo che cresce con la distanza dal tracciato (gli archi lontani più di
// FUORI m non si usano). Il risultato vale solo se resta vicino al tracciato in ogni punto e nei due sensi (scarto massimo MAXD, medio
// MEDD) e con lunghezza simile; altrimenti (OSM non ha la calle: attraverso un campo, verso un pontile) resta il tracciato disegnato e il
// telefono lo aggiunge alla rete come archi propri (public/js/pedoni.js). Ritorna { g, ok, max, medio, L, Lp }.
const FUORI = 22, MAXD = 14, MEDD = 6;
function distLinea(P) {                                          // distanza (m) di un punto [lat, lon] dalla polilinea P (gradi)
  return (la, lo) => {
    const kx = 111320 * Math.cos(la * Math.PI / 180); let best = Infinity;
    for (let i = 1; i < P.length; i++) {
      const ax = (P[i - 1][1] - lo) * kx, ay = (P[i - 1][0] - la) * 111320, bx = (P[i][1] - lo) * kx, by = (P[i][0] - la) * 111320, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  };
}
const lunghezza = g => { let m = 0; for (let i = 1; i < g.length; i++) m += mDist(g[i - 1][0], g[i - 1][1], g[i][0], g[i][1]); return m; };
function scarti(A, B) {                                          // scarti dei punti di A (ogni 2 m) dalla linea B: { max, medio }
  const d = distLinea(B), pts = lungo(A, 2); let mx = 0, sum = 0;
  for (const [la, lo] of pts) { const x = d(la, lo); mx = Math.max(mx, x); sum += x; }
  return { max: mx, medio: pts.length ? sum / pts.length : 0 };
}
function allinea(R, P) {
  const Lp = lunghezza(P);
  if (!(P.length >= 2 && Lp > 0.5)) return { g: P, ok: false, max: 0, medio: 0, L: 0, Lp };
  const snapT = R._snapTP || (R._snapTP = indiceTratti(R, true)), d = distLinea(P), memo = new Map();   // anche i ponti: un percorso può partire dal piede di un ponte
  const peso = e => {                                            // metri «di costo»: lunghezza × (1 + penalità per la distanza dal tracciato)
    let c = memo.get(e); if (c != null) return c;
    const pts = e.g.map(([la, lo]) => [la / U, lo / U]), sm = lungo(pts, 4); let sum = 0, mn = Infinity;
    for (const [la, lo] of sm) { const x = d(la, lo); sum += x; mn = Math.min(mn, x); }
    const med = sum / sm.length; c = mn > FUORI ? Infinity : e.len * (1 + Math.pow(Math.max(0, med - 3) / 3, 2));
    memo.set(e, c); return c;
  };
  const A = snapT(P[0][0], P[0][1], FUORI), B = snapT(P[P.length - 1][0], P[P.length - 1][1], FUORI);
  if (!A || !B) return { g: P, ok: false, max: Infinity, medio: Infinity, L: 0, Lp };
  let g;
  if (A.e === B.e) g = pezzo(A.e, A.along, B.along);
  else {
    // Dijkstra con il costo pesato, dai due capi del tratto di partenza ai due del tratto d'arrivo
    const dist = new Map(), prev = new Map(), H = [];
    const push = (n, c, pe) => { if (c < (dist.get(n) ?? Infinity)) { dist.set(n, c); prev.set(n, pe); H.push([c, n]); } };
    const kA = A.e.len > 0 ? peso(A.e) / A.e.len : 1;
    push(A.e.a, A.along * kA, null); push(A.e.b, (A.e.len - A.along) * kA, null);
    const kB = B.e.len > 0 ? peso(B.e) / B.e.len : 1, fine = new Map([[B.e.a, B.along * kB], [B.e.b, (B.e.len - B.along) * kB]]);
    let best = null; const lim = Lp * 4 + 300;
    while (H.length) {
      let bi = 0; for (let i = 1; i < H.length; i++) if (H[i][0] < H[bi][0]) bi = i;
      const [c, u] = H.splice(bi, 1)[0]; if (c > (dist.get(u) ?? Infinity) || c > lim) continue;
      if (best && c >= best.c) break;
      if (fine.has(u)) { const t = c + fine.get(u); if (!best || t < best.c) best = { c: t, n: u }; }
      for (const e of u.adj) { if (e === A.e || e === B.e) continue; const w = peso(e); if (!Number.isFinite(w)) continue; push(e.a === u ? e.b : e.a, c + w, e); }
    }
    if (!best) return { g: P, ok: false, max: Infinity, medio: Infinity, L: 0, Lp };
    const archi = [], nodi = [best.n]; let n = best.n;
    while (prev.get(n)) { const e = prev.get(n); archi.push(e); n = e.a === n ? e.b : e.a; nodi.push(n); }
    archi.reverse(); nodi.reverse();
    const g1 = pezzo(A.e, A.along, nodi[0] === A.e.a ? 0 : A.e.len), g3 = pezzo(B.e, best.n === B.e.a ? 0 : B.e.len, B.along);
    g = [...g1, ...(archi.length ? forma({ nodi, archi }).slice(1, -1) : []), ...g3];
  }
  const L = lunghezza(g), s1 = scarti(P, g), s2 = scarti(g, P), max = Math.max(s1.max, s2.max), medio = Math.max(s1.medio, s2.medio);
  const ok = max <= MAXD && medio <= MEDD && L <= Lp * 1.4 + 8 && L >= Lp * 0.75 - 2;
  if (ok) return { g, ok, max, medio, L, Lp };
  const par = parallelo(R, P, Lp) || perNodi(R, P, Lp);         // tratto diritto (es. dalla riva al pontile): il tratto OSM parallelo e vicino
  return par || { g: P, ok: false, max, medio, L, Lp };
}
// tratti corti: dagli incroci della rete più vicini ai due capi (entro 12 m), se il cammino tra loro somiglia al disegno
function perNodi(R, P, Lp) {
  if (Lp > 40) return null;
  const near = R._nearN || (R._nearN = indiceNodi(R)), A = near(P[0][0], P[0][1], 12), B = near(P[P.length - 1][0], P[P.length - 1][1], 12);
  if (!A || !B || A.n === B.n) return null;
  const c = cammino(R, A.n, B.n, Lp * 2 + 20); if (!c) return null;
  const g = forma(c), L = lunghezza(g); if (L < Lp * 0.5 || L > Lp * 1.5 + 5) return null;
  const s1 = scarti(P, g), s2 = scarti(g, P), max = Math.max(s1.max, s2.max), medio = Math.max(s1.medio, s2.medio);
  return max <= 14 && medio <= 10 ? { g, ok: true, max, medio, L, Lp, nodi: true } : null;
}
// Per i tratti quasi diritti e corti (passerelle verso i pontili, attraversamenti di una riva) la ricerca del cammino può non bastare: il
// pontile in OSM è un tratto a sé, parallelo al disegno a qualche metro. Si cerca il segmento della rete con la stessa direzione (entro
// 30°), entrambi i capi del disegno entro PAR_D m dalla sua retta e sovrapposto per almeno 3/4 della lunghezza: il tracciato diventa la
// parte di quel segmento che corrisponde al disegno.
const PAR_D = 15;
function parallelo(R, P, Lp) {
  if (Lp > 70 || Lp < 2) return null;
  const a = P[0], b = P[P.length - 1], ch = distLinea([a, b]);
  if (P.some(([la, lo]) => ch(la, lo) > 3)) return null;          // non diritto
  const la0 = (a[0] + b[0]) / 2, kx = 111320 * Math.cos(la0 * Math.PI / 180), xy = q => [(q[1] - a[1]) * kx, (q[0] - a[0]) * 111320];
  const B = xy(b), vl = Math.hypot(B[0], B[1]); if (!vl) return null;
  const v = [B[0] / vl, B[1] / vl], near = (q, m) => Math.abs(q[0] - la0) < m / 111320 && Math.abs(q[1] - a[1]) < m / kx;
  let best = null;
  for (const e of R.edges) {
    const g = e.g.map(([y, x]) => [y / U, x / U]); if (!g.some(q => near(q, Lp + 60))) continue;
    for (let i = 1; i < g.length; i++) {
      const p0 = xy(g[i - 1]), p1 = xy(g[i]), sx = p1[0] - p0[0], sy = p1[1] - p0[1], sl = Math.hypot(sx, sy); if (sl < 1) continue;
      const u = [sx / sl, sy / sl], cos = Math.abs(u[0] * v[0] + u[1] * v[1]); if (cos < Math.cos(Math.PI / 6)) continue;
      const dl = q => Math.abs((q[0] - p0[0]) * u[1] - (q[1] - p0[1]) * u[0]), t = q => ((q[0] - p0[0]) * u[0] + (q[1] - p0[1]) * u[1]) / sl;
      const d0 = dl([0, 0]), d1 = dl(B); if (d0 > PAR_D || d1 > PAR_D) continue;
      const t0 = Math.max(0, Math.min(t([0, 0]), t(B))), t1 = Math.min(1, Math.max(t([0, 0]), t(B))), ov = (t1 - t0) * sl;
      if (ov < Lp * 0.75) continue;
      const sc = (d0 + d1) / 2; if (best && sc >= best.sc) continue;
      const at = f => [g[i - 1][0] + (g[i][0] - g[i - 1][0]) * f, g[i - 1][1] + (g[i][1] - g[i - 1][1]) * f];
      const fa = Math.max(0, Math.min(1, t([0, 0]))), fb = Math.max(0, Math.min(1, t(B)));
      best = { sc, g: [at(fa), at(fb)] };
    }
  }
  if (!best) return null;
  const L = lunghezza(best.g), s1 = scarti(P, best.g), s2 = scarti(best.g, P);
  return { g: best.g, ok: true, max: Math.max(s1.max, s2.max), medio: Math.max(s1.medio, s2.medio), L, Lp, parallelo: true };
}

// ---- 1. percorsi su passerelle ricalcati sulla rete ----
// p: { id, a: [[lat, lon]…], b: [[lat, lon]…], m (metri ufficiali), geo: 'osm' | 'stima' | 'incerto' }
// near: indiceTratti(R) (aggancio ai tratti); per compatibilità anche indiceNodi(R)
function ricalca(R, near, p) {
  const snapT = R._snapT || (R._snapT = indiceTratti(R));
  let best = null;
  for (const A of p.a) for (const B of p.b) {
    const sa = snapT(A[0], A[1]), sb = snapT(B[0], B[1]); if (!sa || !sb) continue;
    const c = traAgganci(R, sa, sb, Math.max(600, p.m * 4)); if (!c) continue;
    const L = c.m, err = p.m < 20 ? Math.abs(L - p.m) / 20 : Math.abs(Math.log(Math.max(L, 3) / p.m));
    if (!best || err < best.err) best = { c, L, err };
  }
  if (!best) return { k: 'i', m: null, g: [p.a[0], p.b[0]] };      // nessun aggancio: segmento tra i due punti dichiarati
  let g = best.c.g, L = best.L; if (g.length < 2) g = [p.a[0], p.b[0]];
  // più lungo dell'ufficiale (il capo d'arrivo è un edificio o un punto approssimato): la passerella parte dal capo «da» e va verso
  // «a» per la sua lunghezza ufficiale, lungo le calli
  if (L > p.m * 1.15 + 5) { g = taglia(g, p.m); L = p.m; }
  const ok = Math.abs(L - p.m) <= Math.max(15, p.m * 0.4);
  return { k: ok && p.geo !== 'incerto' ? 't' : 'i', m: Math.round(L), g };
}

// prima parte di una linea (gradi), lunga «m» metri
function taglia(g, m) {
  const out = [g[0]]; let rest = m;
  for (let i = 1; i < g.length; i++) {
    const L = mDist(g[i - 1][0], g[i - 1][1], g[i][0], g[i][1]);
    if (L >= rest) { const f = L ? rest / L : 0; out.push([g[i - 1][0] + (g[i][0] - g[i - 1][0]) * f, g[i - 1][1] + (g[i][1] - g[i - 1][1]) * f]); return out; }
    out.push(g[i]); rest -= L;
  }
  return out;
}
// punti ogni «passo» metri lungo una linea (gradi)
function lungo(g, passo) {
  const out = [g[0]];
  let resto = passo;
  for (let i = 1; i < g.length; i++) {
    const [y0, x0] = g[i - 1], [y1, x1] = g[i], L = mDist(y0, x0, y1, x1); let t = 0;
    while (L > 0 && resto <= L - t) { t += resto; resto = passo; const f = t / L; out.push([y0 + (y1 - y0) * f, x0 + (x1 - x0) * f]); }
    resto -= (L - t);
  }
  out.push(g[g.length - 1]);
  return out;
}

// ---- 2-3. griglia delle quote ----
// G: { lat0, lon0, dlat, dlon, righe, colonne }; zone: [{ id, box: [s, w, n, e], curva: bool, fondo, escludi?: [box…] }]
function zonaDi(zone, lat, lon) {
  for (const z of zone) {
    const [s, w, n, e] = z.box; if (lat < s || lat > n || lon < w || lon > e) continue;
    if ((z.escludi || []).some(([s2, w2, n2, e2]) => lat >= s2 && lat <= n2 && lon >= w2 && lon <= e2)) continue;
    return z;
  }
  return null;
}

// curva ufficiale [[cm, %], …] (crescente): percentuale allagata a un livello, e livello per una percentuale
function percento(curva, cm) {
  if (cm <= curva[0][0]) return curva[0][1] * Math.max(0, (cm - (curva[0][0] - 10)) / 10);
  for (let i = 1; i < curva.length; i++) if (cm <= curva[i][0]) { const [x0, y0] = curva[i - 1], [x1, y1] = curva[i]; return y0 + (y1 - y0) * (cm - x0) / (x1 - x0); }
  return curva[curva.length - 1][1];
}

function quote(R, opz) {
  const { G, zone, curva, punti, percorsi, passo = 5 } = opz;
  // ancore: punti noti e percorsi su passerelle (quota di posa − 3 cm, ogni 10 m lungo il tracciato)
  const anc = punti.map(p => ({ lat: p.lat, lon: p.lon, h: p.cm, r: p.r || 60 }));
  for (const p of percorsi) for (const [lat, lon] of lungo(p.g, 10)) anc.push({ lat, lon, h: p.q - 3, r: 35, pass: p.q - 3 });
  const AS = 0.003, AM = new Map(), akey = (la, lo) => Math.floor(la / AS) + ',' + Math.floor(lo / AS);
  for (const a of anc) { const k = akey(a.lat, a.lon); let l = AM.get(k); if (!l) AM.set(k, l = []); l.push(a); }
  // stima in un punto: media pesata delle ancore entro ~700 m (peso 1/(1+(d/r)^2)) più la quota di fondo della zona
  function stima(lat, lon, z) {
    let sw = z.pesoFondo ?? 0.06, sh = sw * z.fondo, fissa = null;
    const r = Math.floor(lat / AS), q = Math.floor(lon / AS);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const x of AM.get((r + a) + ',' + (q + b)) || []) {
      const d = mDist(lat, lon, x.lat, x.lon), w = 1 / (1 + (d / x.r) ** 2); sw += w; sh += w * x.h;
      if (x.pass != null && d <= 15) fissa = fissa == null ? x.pass : Math.min(fissa, x.pass);
    }
    return { h: sh / sw, fissa };
  }
  // campioni lungo i tratti non di ponte, raccolti per cella: quota minima della cella (lì l'acqua arriva prima)
  const celle = new Map();
  for (const e of R.edges) {
    if (e.ponte) continue;
    const g = e.g.map(([la, lo]) => [la / U, lo / U]);
    const pts = lungo(g, passo), wlen = e.len / pts.length;
    for (const [lat, lon] of pts) {
      const z = zonaDi(zone, lat, lon); if (!z) continue;
      const r = Math.floor((lat - G.lat0) / G.dlat), c = Math.floor((lon - G.lon0) / G.dlon);
      if (r < 0 || c < 0 || r >= G.righe || c >= G.colonne) continue;
      const k = r * G.colonne + c; let o = celle.get(k);
      if (!o) { o = { k, z, raw: Infinity, fissa: null, len: 0 }; celle.set(k, o); }
      const s = stima(lat, lon, z);
      if (s.h < o.raw) o.raw = s.h;
      if (s.fissa != null) o.fissa = o.fissa == null ? s.fissa : Math.min(o.fissa, s.fissa);
      o.len += wlen;
    }
  }
  const all = [...celle.values()];
  for (const o of all) o.cm = o.fissa != null ? o.fissa : o.raw;
  // calibrazione sulla curva ufficiale (solo zone con curva): ordine della stima, lunghezze allagate come la curva
  for (const zid of new Set(all.filter(o => o.z.curva).map(o => o.z.id))) {
    const Z = all.filter(o => o.z.id === zid), tot = Z.reduce((s, o) => s + o.len, 0);
    const fisse = Z.filter(o => o.fissa != null).sort((a, b) => a.cm - b.cm), libere = Z.filter(o => o.fissa == null).sort((a, b) => a.raw - b.raw || a.k - b.k);
    // lunghezza fissa allagata fino al livello L
    const fl = L => { let s = 0; for (const o of fisse) { if (o.cm > L) break; s += o.len; } return s; };
    // livello a cui le celle libere devono arrivare per avere «cum» metri liberi allagati: il primo L con target(L) − fisse(L) ≥ cum
    const LIV = []; for (let L = 50; L <= 220; L++) LIV.push([L, Math.max(0, percento(curva, L) / 100 * tot - fl(L))]);
    for (let i = 1; i < LIV.length; i++) if (LIV[i][1] < LIV[i - 1][1]) LIV[i][1] = LIV[i - 1][1];
    let cum = 0, j = 0;
    for (const o of libere) {
      const mid = cum + o.len / 2; cum += o.len;
      while (j < LIV.length - 1 && LIV[j][1] < mid) j++;
      o.cm = LIV[j][1] >= mid ? LIV[j][0] : Math.max(LIV[LIV.length - 1][0], o.raw);
    }
  }
  return all;
}

// percentuale di lunghezza allagata (zone con curva) a un livello, per la prova della calibrazione
function allagata(celle, cm, filtro = o => o.z.curva) {
  const Z = celle.filter(filtro), tot = Z.reduce((s, o) => s + o.len, 0);
  return tot ? 100 * Z.filter(o => o.cm <= cm).reduce((s, o) => s + o.len, 0) / tot : 0;
}

// ---- quote MISURATE (rilievo RAMSES, scripts/ramses-core.js) al posto della stima, dove il rilievo c'è ----
// quota(lat, lon) -> { cm } | null (non misurato); basso(valori) -> valore della cella (ramses-core: mediana). Campioni ogni metro lungo i tratti non di ponte.
// Una cella è «misurata» se almeno metà dei suoi campioni lo sono: valore = basso() dei campioni misurati, segno o.mis = true.
// Le celle senza abbastanza misure restano con la stima (e senza segno); con celle = [] restano solo le celle misurate (le tessere).
// Restituisce i conteggi per il riepilogo.
function rilievo(R, celle, opz) {
  const { G, zone, quota, basso, passo = 1 } = opz;
  const per = new Map(), byK = new Map(celle.map(o => [o.k, o]));
  for (const e of R.edges) {
    if (e.ponte) continue;
    const g = e.g.map(([la, lo]) => [la / U, lo / U]);
    for (const [lat, lon] of lungo(g, passo)) {
      const z = zonaDi(zone, lat, lon); if (!z) continue;
      const r = Math.floor((lat - G.lat0) / G.dlat), c = Math.floor((lon - G.lon0) / G.dlon);
      if (r < 0 || c < 0 || r >= G.righe || c >= G.colonne) continue;
      const k = r * G.colonne + c; let o = per.get(k); if (!o) per.set(k, o = { z, n: 0, v: [] });
      o.n++; const q = quota(lat, lon); if (q) o.v.push(q.cm);
    }
  }
  let misurate = 0, nuove = 0, parziali = 0;
  for (const [k, o] of per) {
    if (!o.v.length) continue;
    if (o.v.length * 2 < o.n) { parziali++; continue; }
    let c = byK.get(k);
    if (!c) { c = { k, z: o.z, raw: Infinity, fissa: null, len: o.n * passo }; celle.push(c); byK.set(k, c); nuove++; }
    c.stima = c.cm; c.cm = basso(o.v); c.mis = true; misurate++;
  }
  return { misurate, nuove, parziali, celle: celle.length };
}
// ---- codifica compatta della griglia ----
// valore = round((cm − 50) / 2), 0…79 (cm 50…208), scritto con un carattere di ALFA; spazio = nessun dato.
// righe: [[riga, colonna iniziale, "caratteri"], …] (i tratti vuoti lunghi spezzano la riga)
const ALFA = (() => { let s = ''; for (let c = 35; s.length < 80; c++) if (c !== 92) s += String.fromCharCode(c); return s; })();
const codice = cm => ALFA[Math.max(0, Math.min(79, Math.round((cm - 50) / 2)))];
const valore = ch => { const i = ALFA.indexOf(ch); return i < 0 ? null : 50 + i * 2; };

// salto: vuoto più lungo di così = riga nuova (con le celle piccole del rilievo conviene uno spazio in più che una riga in più)
function codifica(celle, G, salto = 6) {
  const per = new Map();
  for (const o of celle) { const r = Math.floor(o.k / G.colonne), c = o.k % G.colonne; let m = per.get(r); if (!m) per.set(r, m = new Map()); m.set(c, codice(o.cm)); }
  const righe = [];
  for (const r of [...per.keys()].sort((a, b) => a - b)) {
    const m = per.get(r), cols = [...m.keys()].sort((a, b) => a - b);
    let start = cols[0], s = '', prev = cols[0] - 1;
    for (const c of cols) {
      if (c - prev > salto) { righe.push([r, start, s]); start = c; s = ''; }
      else s += ' '.repeat(c - prev - 1);
      s += m.get(c); prev = c;
    }
    righe.push([r, start, s]);
  }
  return righe;
}
// TESSERE del rilievo: le celle misurate (griglia G) divise in quadrati di T×T celle, ognuna un piccolo file «quote» (f: 1) con la sua
// griglia: il telefono scarica solo quelle che servono (vista della mappa, zona del percorso). id = «riga_colonna» della tessera.
function tessere(celle, G, T) {
  const per = new Map();
  for (const o of celle) {
    const r = Math.floor(o.k / G.colonne), c = o.k % G.colonne, tr = Math.floor(r / T), tc = Math.floor(c / T), id = `${tr}_${tc}`;
    let t = per.get(id); if (!t) per.set(id, t = { id, tr, tc, celle: [] });
    t.celle.push({ k: (r - tr * T) * T + (c - tc * T), cm: o.cm });
  }
  return [...per.values()].sort((a, b) => a.tr - b.tr || a.tc - b.tc).map(t => {
    const g = { lat0: +(G.lat0 + t.tr * T * G.dlat).toFixed(7), lon0: +(G.lon0 + t.tc * T * G.dlon).toFixed(7), dlat: G.dlat, dlon: G.dlon, righe: T, colonne: T };
    return { id: t.id, g, n: t.celle.length, r: codifica(t.celle, g, 14) };
  });
}

function decodifica(righe, G) {
  const out = new Map();
  for (const [r, c0, s] of righe) for (let i = 0; i < s.length; i++) { const v = valore(s[i]); if (v != null) out.set(r * G.colonne + c0 + i, v); }
  return out;
}

// geometria in interi (centomillesimi di grado) con differenze: [lat0, lon0, dlat1, dlon1, …]
function linea(g) {
  const out = []; let pl = 0, pn = 0;
  g.forEach(([la, lo], i) => { const y = Math.round(la * E5), x = Math.round(lo * E5); if (i && y === pl && x === pn) return; out.push(y - pl, x - pn); pl = y; pn = x; });
  return out;
}

const api = { U, E5, mDist, rete, ponte, cammino, indiceNodi, indiceTratti, pezzo, forma, ricalca, allinea, distLinea, scarti, lungo, zonaDi, percento, quote, allagata, rilievo, tessere, ALFA, codice, valore, codifica, decodifica, linea };
module.exports = api;
