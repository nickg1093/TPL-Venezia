// Calcolo delle distanze a piedi tra fermate lungo la rete pedonale di OpenStreetMap (usato da scripts/pedonale.js).
// Funzioni pure, senza dipendenze: girano uguali in Node e in un browser.
//   aree(fermate)            -> rettangoli [s, o, n, e] che coprono le fermate con un margine (~400-550 m)
//   query(rettangoli, hw)    -> testo della richiesta Overpass per quei rettangoli
//   rete()                   -> raccoglitore: .add(elementi Overpass) più volte (ways e nodi senza doppioni), .done() -> grafo compatto
//   coppie(fermate, grafo, limite, aggancio) -> [[i, j, metri]] con i < j, distanza lungo la rete fino a «limite» metri
(function (root) {
  const HW = 'footway|pedestrian|path|steps|living_street|residential|service|unclassified|tertiary|secondary|primary|track|cycleway|corridor|platform|road|tertiary_link|secondary_link|primary_link';

  function aree(ST, CL = 0.005, CO = 0.007) {
    const cells = new Set();
    for (const s of ST) { const a = Math.floor(s.la / CL), b = Math.floor(s.lo / CO); for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) cells.add((a + x) + ':' + (b + y)); }
    const rows = new Map();
    for (const c of cells) { const [a, b] = c.split(':').map(Number); (rows.get(a) || rows.set(a, []).get(a)).push(b); }
    const R = [];
    for (const [a, bs] of [...rows].sort((x, y) => x[0] - y[0])) {
      bs.sort((x, y) => x - y);
      let b0 = bs[0];
      for (let k = 1; k <= bs.length; k++) if (k === bs.length || bs[k] !== bs[k - 1] + 1) {
        R.push([+(a * CL).toFixed(4), +(b0 * CO).toFixed(4), +((a + 1) * CL).toFixed(4), +((bs[k - 1] + 1) * CO).toFixed(4)]);
        b0 = bs[k];
      }
    }
    return R;
  }
  const query = (R, hw = HW) => '[out:json][timeout:180];(' + R.map(b => `way["highway"~"^(${hw})$"]["foot"!="no"]["access"!~"^(private|no)$"](${b.join(',')});`).join('') + ');out body;>;out skel qt;';

  function rete() {
    const idx = new Map(), lat = [], lon = [], ways = new Set(), ea = [], eb = [], ew = [];
    const pending = [];
    return {
      add(E) {
        for (const e of E) if (e.type === 'node' && !idx.has(e.id)) { idx.set(e.id, lat.length); lat.push(e.lat); lon.push(e.lon); }
        for (const e of E) if (e.type === 'way' && !ways.has(e.id)) { ways.add(e.id); pending.push([e.nodes, e.tags && e.tags.highway === 'steps' ? 1.3 : 1]); }   // scale: un po' più lente
      },
      done() {
        const M = (a, b) => Math.hypot((lat[a] - lat[b]) * 111320, (lon[a] - lon[b]) * 111320 * Math.cos(lat[a] * Math.PI / 180));
        for (const [nodes, k] of pending) {
          const ns = nodes.map(n => idx.get(n)).filter(x => x != null);
          for (let j = 1; j < ns.length; j++) { ea.push(ns[j - 1]); eb.push(ns[j]); ew.push(M(ns[j - 1], ns[j]) * k); }
        }
        const N = lat.length, deg = new Int32Array(N + 1);
        for (let e = 0; e < ea.length; e++) { deg[ea[e] + 1]++; deg[eb[e] + 1]++; }
        for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
        const to = new Int32Array(deg[N]), w = new Float32Array(deg[N]), f = deg.slice();
        for (let e = 0; e < ea.length; e++) { let o = f[ea[e]]++; to[o] = eb[e]; w[o] = ew[e]; o = f[eb[e]]++; to[o] = ea[e]; w[o] = ew[e]; }
        return { N, lat: Float64Array.from(lat), lon: Float64Array.from(lon), st: deg, to, w, ways: ways.size };
      }
    };
  }

  function coppie(ST, g, LIM = 1000, SNAP = 150) {
    // ogni fermata al nodo della rete più vicino (entro SNAP metri), con una griglia
    const grid = new Map(), key = (a, b) => a + ':' + b;
    for (let i = 0; i < g.N; i++) if (g.st[i + 1] > g.st[i]) { const k = key(Math.floor(g.lat[i] / 0.001), Math.floor(g.lon[i] / 0.0014)); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
    for (const s of ST) {
      let best = -1, bd = Infinity; const ci = Math.floor(s.la / 0.001), cj = Math.floor(s.lo / 0.0014);
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const i of grid.get(key(ci + a, cj + b)) || []) {
        const d = Math.hypot((s.la - g.lat[i]) * 111320, (s.lo - g.lon[i]) * 111320 * Math.cos(s.la * Math.PI / 180)); if (d < bd) { bd = d; best = i; }
      }
      s.n = best; s.sd = bd;
    }
    const at = new Map(); ST.forEach((s, k) => { if (s.n >= 0 && s.sd <= SNAP) (at.get(s.n) || at.set(s.n, []).get(s.n)).push(k); });
    const dist = new Float64Array(g.N).fill(Infinity), touched = [], best = new Map();
    // coda con priorità (heap binario) di [distanza, nodo]
    const hd = [], hn = [];
    const push = (d, n) => { let i = hd.length; hd.push(d); hn.push(n); while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= d) break; hd[i] = hd[p]; hn[i] = hn[p]; i = p; } hd[i] = d; hn[i] = n; };
    const pop = () => { const d = hd[0], n = hn[0], ld = hd.pop(), ln = hn.pop(); if (hd.length) { let i = 0; const L = hd.length; for (;;) { let c = 2 * i + 1; if (c >= L) break; if (c + 1 < L && hd[c + 1] < hd[c]) c++; if (hd[c] >= ld) break; hd[i] = hd[c]; hn[i] = hn[c]; i = c; } hd[i] = ld; hn[i] = ln; } return [d, n]; };
    for (let k = 0; k < ST.length; k++) {
      const s = ST[k]; if (s.n < 0 || s.sd > SNAP) continue;
      dist[s.n] = s.sd; touched.push(s.n); push(s.sd, s.n);
      while (hd.length) {
        const [d, u] = pop(); if (d > dist[u]) continue;
        for (const j of at.get(u) || []) if (j > k) { const m = Math.round(d + ST[j].sd), kk = k * 100000 + j; if (m <= LIM && (!best.has(kk) || best.get(kk) > m)) best.set(kk, m); }
        for (let o = g.st[u]; o < g.st[u + 1]; o++) { const v = g.to[o], nd = d + g.w[o]; if (nd <= LIM && nd < dist[v]) { if (dist[v] === Infinity) touched.push(v); dist[v] = nd; push(nd, v); } }
      }
      for (const v of touched) dist[v] = Infinity; touched.length = 0;
    }
    return [...best].map(([kk, m]) => [Math.floor(kk / 100000), kk % 100000, m]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  const testo = (ST, P) => ST.map(s => s.id).join(',') + '\n' + P.map(p => p[0].toString(36) + '.' + p[1].toString(36) + '.' + p[2].toString(36)).join(' ');

  const api = { HW, aree, query, rete, coppie, testo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PedonaleCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
