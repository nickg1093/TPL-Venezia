// RETE PEDONALE IN MATTONELLE per i percorsi a piedi calcolati sul telefono (public/js/pedoni.js).
// Funzioni pure, senza dipendenze; usate da scripts/genera-dati.js nel workflow GitHub «dati».
//
// Ingresso: estratto di OpenStreetMap in formato OPL (righe «n…» con le coordinate e righe «w…» con i tag e i nodi), ottenuto con osmium
// dalle sole strade percorribili a piedi della zona servita. Uscita: mattonelle di circa 1,1 × 1,1 km (0,01° di latitudine × 0,014° di
// longitudine), ognuna con gli incroci che contiene e i tratti di strada che li toccano, e un indice con l'impronta di ogni mattonella.
//
// Come è fatta una mattonella (JSON, compresso dal CDN):
//   { f: 1, t: "4543_885", n: [dlat, dlon, …], e: [[a, b, w, s, dlat, dlon, …], …] }
//   n   incroci (e capi dei tratti che escono dalla mattonella) in milionesimi di grado, rispetto all'angolo sud-ovest della mattonella
//   e   tratti: a, b = posizione dei due capi in n; w = lunghezza «a piedi» in decimetri (scale × 1,3); s = 1 se scale;
//       poi i punti intermedi, ognuno come differenza dal punto precedente (partendo da a), in milionesimi di grado
// Un tratto sta nelle mattonelle di ENTRAMBI i suoi capi: caricata la mattonella di un incrocio si conoscono tutte le sue strade.
// Gli incroci si riconoscono tra mattonelle diverse dalle coordinate (in milionesimi di grado).
// Dati © OpenStreetMap contributors, licenza ODbL.
(function (root) {
  const CL = 0.01, CO = 0.014;                                   // dimensione delle mattonelle (gradi)
  const U = 1e6;                                                 // unità delle coordinate: milionesimi di grado (~11 cm)
  // stesse strade di scripts/pedonale-core.js (distanze tra fermate del pianificatore), così i due calcoli concordano
  const HW = new Set(['footway', 'pedestrian', 'path', 'steps', 'living_street', 'residential', 'service', 'unclassified', 'tertiary', 'secondary', 'primary', 'track',
    'cycleway', 'corridor', 'platform', 'road', 'tertiary_link', 'secondary_link', 'primary_link']);
  const STEPS = 1.3;
  const cellOf = (lat, lon) => `${Math.floor(lat / CL)}_${Math.floor(lon / CO)}`;
  const mDist = (la1, lo1, la2, lo2) => { const k = Math.cos((la1 + la2) / 2 * Math.PI / 180); return Math.hypot((la1 - la2) * 111320, (lo1 - lo2) * 111320 * k); };

  // una via è percorribile a piedi? (tag di OSM)
  function walkable(t) {
    if (!HW.has(t.highway)) return false;
    const foot = t.foot || '';
    if (foot === 'no') return false;
    if (/^(private|no)$/.test(t.access || '') && !/^(yes|designated|permissive)$/.test(foot)) return false;
    return true;
  }
  // tag in formato OPL: «k=v,k2=v2» con i caratteri speciali come %xx%
  const unesc = s => s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  function tagsOf(s) { const t = {}; if (!s) return t; for (const kv of s.split(',')) { const i = kv.indexOf('='); if (i > 0) t[unesc(kv.slice(0, i))] = unesc(kv.slice(i + 1)); } return t; }

  // raccoglitore: .line(riga OPL) per ogni riga, poi .done() -> { nodi, vie }
  function lettore() {
    let ids = new Float64Array(1 << 20), la = new Int32Array(1 << 20), lo = new Int32Array(1 << 20), n = 0, sorted = true;
    const ways = [];
    const grow = () => { const m = ids.length * 2; const a = new Float64Array(m); a.set(ids); ids = a; const b = new Int32Array(m); b.set(la); la = b; const c = new Int32Array(m); c.set(lo); lo = c; };
    return {
      line(L) {
        if (!L) return;
        const c = L.charCodeAt(0);
        if (c === 110) {                                         // n<id> … x<lon> y<lat>
          const p = L.split(' '); let x = null, y = null;
          for (const f of p) { if (f[0] === 'x') x = +f.slice(1); else if (f[0] === 'y') y = +f.slice(1); }
          if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) return;
          if (n === ids.length) grow();
          const id = +p[0].slice(1); if (n && id < ids[n - 1]) sorted = false;
          ids[n] = id; la[n] = Math.round(y * U); lo[n] = Math.round(x * U); n++;
        } else if (c === 119) {                                  // w<id> … T<tag> N<nodi>
          const p = L.split(' '); let T = '', N = '';
          for (const f of p) { if (f[0] === 'T') T = f.slice(1); else if (f[0] === 'N') N = f.slice(1); }
          const t = tagsOf(T); if (!walkable(t) || !N) return;
          ways.push({ steps: t.highway === 'steps', nodes: N.split(',').map(x => +x.slice(1)) });
        }
      },
      done() {
        if (!sorted) { const o = Array.from({ length: n }, (_, k) => k).sort((a, b) => ids[a] - ids[b]); ids = Float64Array.from(o, k => ids[k]); la = Int32Array.from(o, k => la[k]); lo = Int32Array.from(o, k => lo[k]); }
        const find = id => { let a = 0, b = n - 1; while (a <= b) { const m = (a + b) >> 1; if (ids[m] === id) return m; if (ids[m] < id) a = m + 1; else b = m - 1; } return -1; };
        return { n, la, lo, find, ways };
      }
    };
  }

  // semplificazione di una linea (Douglas-Peucker) con tolleranza in metri; pts = [[lat, lon] in milionesimi]
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const k = Math.cos(pts[0][0] / U * Math.PI / 180), sx = 111320 / U * k, sy = 111320 / U;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [i, j] = st.pop(); let best = -1, bd = tol;
      const ax = pts[i][1] * sx, ay = pts[i][0] * sy, bx = pts[j][1] * sx, by = pts[j][0] * sy, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      for (let m = i + 1; m < j; m++) {
        const px = pts[m][1] * sx, py = pts[m][0] * sy;
        let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px - ax - t * dx, py - ay - t * dy); if (d > bd) { bd = d; best = m; }
      }
      if (best > 0) { keep[best] = 1; st.push([i, best], [best, j]); }
    }
    return pts.filter((_, m) => keep[m]);
  }

  // grafo: incroci e tratti tra incroci (con la forma), poi mattonelle.
  // inCover(cella) -> true per le mattonelle da pubblicare (zona servita). tol: semplificazione della forma (m).
  function mattonelle(R, inCover, tol = 1) {
    const { la, lo, find, ways } = R;
    // quante volte compare ogni nodo (nelle vie) e capi delle vie: lì ci sono gli incroci
    const uses = new Map(), ends = new Set();
    const ix = ways.map(w => w.nodes.map(find));
    ix.forEach(ns => { const ok = ns.filter(i => i >= 0); ns.length = 0; ns.push(...ok); });
    for (const ns of ix) { if (ns.length < 2) continue; ends.add(ns[0]); ends.add(ns[ns.length - 1]); for (const i of ns) uses.set(i, (uses.get(i) || 0) + 1); }
    const isJ = i => ends.has(i) || uses.get(i) > 1;
    const tiles = new Map();                                     // cella -> { nodes: Map(chiave -> [la, lo]), edges: [] }
    const tileOf = c => { let t = tiles.get(c); if (!t) tiles.set(c, t = { nodes: new Map(), edges: [] }); return t; };
    const seen = new Set();
    let nEdges = 0;
    ways.forEach((w, k) => {
      const ns = ix[k]; if (ns.length < 2) return;
      let start = 0;
      for (let j = 1; j < ns.length; j++) {
        if (!isJ(ns[j]) && j < ns.length - 1) continue;
        const seg = ns.slice(start, j + 1); start = j;
        if (seg[0] === seg[seg.length - 1] && seg.length < 3) continue;
        let len = 0; for (let m = 1; m < seg.length; m++) len += mDist(la[seg[m - 1]] / U, lo[seg[m - 1]] / U, la[seg[m]] / U, lo[seg[m]] / U);
        if (len < 0.05) continue;
        const pts = simplify(seg.map(i => [la[i], lo[i]]), tol), A = pts[0], B = pts[pts.length - 1];
        const ka = A[0] + ',' + A[1], kb = B[0] + ',' + B[1], w10 = Math.max(1, Math.round(len * (w.steps ? STEPS : 1) * 10));
        const sig = (ka < kb ? ka + '|' + kb : kb + '|' + ka) + '|' + w10; if (seen.has(sig)) continue; seen.add(sig);   // vie doppie (stessa strada mappata due volte)
        const ca = cellOf(A[0] / U, A[1] / U), cb = cellOf(B[0] / U, B[1] / U);
        if (!inCover(ca) && !inCover(cb)) continue;
        const e = { A, B, w: w10, s: w.steps ? 1 : 0, mid: pts.slice(1, -1) };
        for (const c of new Set([ca, cb])) if (inCover(c)) { const t = tileOf(c); t.nodes.set(ka, A); t.nodes.set(kb, B); t.edges.push(e); }
        nEdges++;
      }
    });
    const out = {};
    for (const [c, t] of [...tiles].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      const [r, q] = c.split('_').map(Number), bla = Math.round(r * CL * U), blo = Math.round(q * CO * U);
      const keys = [...t.nodes.keys()].sort(), pos = new Map(keys.map((kk, i) => [kk, i])), n = [];
      for (const kk of keys) { const p = t.nodes.get(kk); n.push(p[0] - bla, p[1] - blo); }
      const e = t.edges.map(x => { const row = [pos.get(x.A[0] + ',' + x.A[1]), pos.get(x.B[0] + ',' + x.B[1]), x.w, x.s]; let pl = x.A[0], pn = x.A[1]; for (const p of x.mid) { row.push(p[0] - pl, p[1] - pn); pl = p[0]; pn = p[1]; } return row; });
      e.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
      out[c] = JSON.stringify({ f: 1, t: c, n, e });
    }
    return { tiles: out, edges: nEdges };
  }

  // celle da pubblicare: entro «raggio» mattonelle da una fermata (raggio 3 ≈ 3,3 km: 30 minuti a passo svelto più l'aggancio)
  function copertura(stops, raggio = 3) {
    const cov = new Set();
    for (const [lat, lon] of stops) { const r = Math.floor(lat / CL), q = Math.floor(lon / CO); for (let a = -raggio; a <= raggio; a++) for (let b = -raggio; b <= raggio; b++) cov.add(`${r + a}_${q + b}`); }
    return cov;
  }

  const api = { CL, CO, U, HW, walkable, tagsOf, lettore, simplify, mattonelle, copertura, cellOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PedoniCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
