// PERCORSI A PIEDI CALCOLATI SUL TELEFONO lungo la rete pedonale di OpenStreetMap (© OpenStreetMap contributors, ODbL).
// Nessun calcolo e nessun dato sul server: la rete arriva dal CDN in mattonelle (scripts/pedoni-core.js) caricate solo quando servono
// e salvate sul telefono. Anche la posizione resta sul telefono: al server vanno, come prima, solo le fermate vicine con i metri.
//
// Il modulo è puro (nessun import): riceve da fuori la funzione che carica una mattonella, così si prova anche fuori dal browser.
//   createNet({ CL, CO, loadTile })  rete vuota; loadTile(cella) -> contenuto della mattonella o null (fuori zona)
//   net.distances(da, mete, limite)  metri lungo la rete da un punto a più punti (fermate): Map(chiave -> metri)
//   net.route(da, a, limite)         percorso tra due punti: { m, pts: [[lat, lon], …] } o null
// Punti: { lat, lon } in gradi. Metri «a piedi»: le scale contano 1,3 volte (come le distanze tra fermate del pianificatore).
// La ricerca è un Dijkstra (A* quando la meta è una sola) che carica le mattonelle man mano che la frontiera ci arriva.
const U = 1e6;
const SNAP_M = 200;                                              // un punto più lontano di così da ogni strada non si aggancia alla rete
const SNAP_ALT = 40, SNAP_N = 6;                                  // agganci alternativi: fino a 40 m più lontani del più vicino, al massimo 6

export function createNet({ CL, CO, loadTile }) {
  const nodes = new Map(), tiles = new Map(), sigs = new Set();   // nodi per chiave; mattonelle (cella -> { edges } | null | Promise)
  const cellOf = (la, lo) => `${Math.floor((la / U) / CL)}_${Math.floor((lo / U) / CO)}`;   // stessa formula del generatore
  const keyOf = (la, lo) => la * 1e8 + lo;
  const node = (la, lo) => { const k = keyOf(la, lo); let n = nodes.get(k); if (!n) nodes.set(k, n = { la, lo, adj: [], cell: cellOf(la, lo) }); return n; };

  function addTile(c, T) {
    const t = { edges: [] };
    if (!T || T.f !== 1 || !Array.isArray(T.n) || !Array.isArray(T.e)) return t;
    const [r, q] = c.split('_').map(Number), bla = Math.round(r * CL * U), blo = Math.round(q * CO * U), N = [];
    for (let i = 0; i + 1 < T.n.length; i += 2) N.push(node(bla + T.n[i], blo + T.n[i + 1]));
    for (const row of T.e) {
      const a = N[row[0]], b = N[row[1]], w = row[2] / 10; if (!a || !b || !(w > 0)) continue;
      const g = [[a.la, a.lo]]; let pl = a.la, pn = a.lo;
      for (let i = 4; i + 1 < row.length; i += 2) { pl += row[i]; pn += row[i + 1]; g.push([pl, pn]); }
      g.push([b.la, b.lo]);
      const sig = (a.la * 1e8 + a.lo) + '|' + (b.la * 1e8 + b.lo) + '|' + row[2];
      if (sigs.has(sig)) { t.edges.push(null); continue; }       // stesso tratto già arrivato con la mattonella dell'altro capo
      sigs.add(sig);
      const e = { a, b, w, s: row[3] ? 1 : 0, g };
      a.adj.push(e); if (b !== a) b.adj.push(e);
      t.edges.push(e);
    }
    t.edges = t.edges.filter(Boolean);
    return t;
  }
  // carica (una volta) la mattonella di una cella; null se fuori zona o non disponibile
  async function ensure(c) {
    const t = tiles.get(c);
    if (t !== undefined) return t instanceof Promise ? t : t;
    const p = Promise.resolve().then(() => loadTile(c)).then(T => addTile(c, T), () => null).then(v => { tiles.set(c, v); return v; });
    tiles.set(c, p);
    return p;
  }
  const loaded = c => { const t = tiles.get(c); return t !== undefined && !(t instanceof Promise); };

  // aggancio di un punto alla rete: i tratti più vicini (fino a SNAP_ALT), non uno solo. Il più vicino può essere un'isola della rete
  // (parcheggio, strada del terminal di P.le Roma, banchina) senza passaggi pedonali vicini: con più agganci vince il migliore.
  async function snap(p) {
    const la = Math.round(p.lat * U), lo = Math.round(p.lon * U), kx = 111320 / U * Math.cos(p.lat * Math.PI / 180), ky = 111320 / U;
    const r = Math.floor(p.lat / CL), q = Math.floor(p.lon / CO), cells = [];
    const dLat = SNAP_M / 111320, dLon = SNAP_M / (111320 * Math.cos(p.lat * Math.PI / 180));
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const s = (r + a) * CL, w = (q + b) * CO;                    // la cella serve solo se il punto è entro SNAP_M dal suo bordo
      if (p.lat + dLat < s || p.lat - dLat > s + CL || p.lon + dLon < w || p.lon - dLon > w + CO) continue;
      cells.push(`${r + a}_${q + b}`);
    }
    const ts = await Promise.all(cells.map(ensure)), per = [];
    for (const t of ts) for (const e of t ? t.edges : []) {
      let along = 0, best = null, len = 0;
      for (let i = 1; i < e.g.length; i++) {
        const [y0, x0] = e.g[i - 1], [y1, x1] = e.g[i];
        const ax = (x0 - lo) * kx, ay = (y0 - la) * ky, bx = (x1 - lo) * kx, by = (y1 - la) * ky, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
        let t2 = L2 ? -(ax * dx + ay * dy) / L2 : 0; t2 = Math.max(0, Math.min(1, t2));
        const d = Math.hypot(ax + t2 * dx, ay + t2 * dy);
        if (d < SNAP_M && (!best || d < best.d)) best = { e, i, d, at: along + t2 * L, pt: [Math.round(y0 + t2 * (y1 - y0)), Math.round(x0 + t2 * (x1 - x0))] };
        along += L;
      }
      len = along;
      if (best) { const k = len > 0 ? e.w / len : 1; per.push({ ...best, pa: best.at * k, pb: Math.max(0, (len - best.at) * k), k }); }
    }
    if (!per.length) return null;
    per.sort((x, y) => x.d - y.d);
    return per.filter(x => x.d <= per[0].d + SNAP_ALT).slice(0, SNAP_N);
  }

  // coda con priorità (heap binario)
  function heap() {
    const d = [], n = [];
    return {
      get size() { return d.length; },
      push(x, v) { let i = d.length; d.push(x); n.push(v); while (i > 0) { const p = (i - 1) >> 1; if (d[p] <= x) break; d[i] = d[p]; n[i] = n[p]; i = p; } d[i] = x; n[i] = v; },
      pop() { const x = d[0], v = n[0], lx = d.pop(), lv = n.pop(); if (d.length) { let i = 0; const L = d.length; for (;;) { let c = 2 * i + 1; if (c >= L) break; if (c + 1 < L && d[c + 1] < d[c]) c++; if (d[c] >= lx) break; d[i] = d[c]; n[i] = n[c]; i = c; } d[i] = lx; n[i] = lv; } return [x, v]; }
    };
  }

  // ricerca dagli agganci della partenza (SS) verso le mete (T: [{ key, snaps }]); h(nodo) = stima per A* (0 = Dijkstra).
  // Le distanze comprendono i tratti in linea retta tra i punti e la strada (d degli agganci).
  async function search(SS, T, limit, h, enough = T.length) {
    const dist = new Map(), prev = new Map(), Q = heap(), done = new Set();
    const set = (n, d, pe) => { if (d < (dist.get(n) ?? Infinity) && d <= limit) { dist.set(n, d); prev.set(n, pe); Q.push(d + h(n), n); } };
    for (const S of SS) { set(S.e.a, S.d + S.pa, { from: S }); set(S.e.b, S.d + S.pb, { from: S }); }
    const best = new Map(), ends = new Map();                     // ends: nodo -> [meta, aggancio della meta, metri dal nodo alla meta]
    for (const t of T) {
      t.need = new Set();
      for (const ts of t.snaps) {
        for (const S of SS) if (ts.e === S.e) {                   // stesso tratto della partenza: diretto lungo il tratto
          const m = S.d + Math.abs(ts.at - S.at) * S.k + ts.d, b = best.get(t.key);
          if (!b || m < b.m) best.set(t.key, { m, via: null, S, ts });
        }
        for (const [n, off] of [[ts.e.a, ts.pa + ts.d], [ts.e.b, ts.pb + ts.d]]) { let l = ends.get(n); if (!l) ends.set(n, l = []); l.push([t, ts, off]); t.need.add(n); }
      }
    }
    let open = T.length;                                          // mete non ancora definitive (servono tutti i capi dei loro tratti)
    const stop = T.length - Math.min(enough, T.length);           // basta: le «enough» mete più vicine sono definitive
    while (Q.size && open > stop) {
      const [f, u] = Q.pop(), du = dist.get(u);
      if (done.has(u) || f > du + h(u) + 1e-9) continue;          // voce superata da una migliore
      if (du > limit) break;
      if (T.length === 1) { const b = best.get(T[0].key); if (b && f >= b.m) break; }   // A*: nessun percorso migliore possibile
      if (!loaded(u.cell)) await ensure(u.cell);                  // tutte le strade di questo incrocio
      done.add(u);
      for (const [t, ts, off] of ends.get(u) || []) {
        const m = du + off, b = best.get(t.key);
        if (!b || m < b.m) best.set(t.key, { m, via: u, ts });
        if (t.need.delete(u) && !t.need.size) open--;
      }
      for (const e of u.adj) { const v = e.a === u ? e.b : e.a; if (!done.has(v)) set(v, du + e.w, { e }); }
    }
    return { best, prev };
  }

  // forma del percorso trovato verso una meta: dal punto agganciato della partenza, lungo i tratti, al punto agganciato della meta
  function shape(b, prev) {
    const ll = p => [p[0] / U, p[1] / U];
    const piece = (s, toA) => [s.pt, ...(toA ? s.e.g.slice(0, s.i).reverse() : s.e.g.slice(s.i))];   // dal punto agganciato al capo a o b
    if (!b.via) {                                                 // stesso tratto
      const S = b.S, ts = b.ts, g = S.e.g, lo = Math.min(S.i, ts.i), hi = Math.max(S.i, ts.i), mid = g.slice(lo, hi);
      if (S.at > ts.at) mid.reverse();
      return [S.pt, ...mid, ts.pt].map(ll);
    }
    const chain = []; let n = b.via, S = null;
    for (;;) { const pe = prev.get(n); if (!pe) break; if (pe.from) { S = pe.from; break; } const e = pe.e, m = e.a === n ? e.b : e.a; chain.push([m, e]); n = m; }
    chain.reverse();
    const out = piece(S, n === S.e.a);                            // dalla partenza al primo incrocio
    for (const [from, e] of chain) { const g = e.a === from ? e.g : [...e.g].reverse(); out.push(...g.slice(1)); }
    out.push(...piece(b.ts, b.via === b.ts.e.a).reverse().slice(1));   // dall'ultimo incrocio alla meta
    return out.map(ll);
  }

  // mattonelle che serviranno di sicuro (attorno ai punti, lungo la linea retta): scaricate insieme invece che una alla volta
  function prefetch(pts, ring) {
    const cells = new Set();
    for (const p of pts) { const r = Math.floor(p.lat / CL), q = Math.floor(p.lon / CO); for (let a = -ring; a <= ring; a++) for (let b = -ring; b <= ring; b++) cells.add(`${r + a}_${q + b}`); }
    return Promise.all([...cells].map(ensure));
  }

  return {
    ensure, snap, nodes, tiles,
    // metri a piedi da «da» a ciascuna meta (entro limite); mete: [{ lat, lon, key }]. enough: bastano le N mete più vicine
    async distances(da, mete, limit, enough = mete.length) {
      await prefetch([da], 1);
      const SS = await snap(da); if (!SS) return null;
      const T = [];
      for (const m of mete) { const s = await snap(m); if (s) T.push({ snaps: s, key: m.key }); }
      const { best } = await search(SS, T, limit, () => 0, enough);
      const out = new Map();
      for (const t of T) { const b = best.get(t.key); if (b && b.m <= limit) out.set(t.key, Math.round(b.m)); }
      return out;
    },
    // percorso tra due punti: metri e forma (con i due tratti in linea retta tra il punto e la strada)
    async route(da, a, limit) {
      const n = Math.min(8, Math.ceil(Math.hypot((a.lat - da.lat) / CL, (a.lon - da.lon) / CO)));
      await prefetch(Array.from({ length: n + 1 }, (_, i) => ({ lat: da.lat + (a.lat - da.lat) * i / (n || 1), lon: da.lon + (a.lon - da.lon) * i / (n || 1) })), 0);
      const SS = await snap(da), AA = await snap(a); if (!SS || !AA) return null;
      const kx = 111320 / U * Math.cos(a.lat * Math.PI / 180), ky = 111320 / U;
      const h = n => { let x = Infinity; for (const s of AA) x = Math.min(x, Math.hypot((n.lo - s.pt[1]) * kx, (n.la - s.pt[0]) * ky) + s.d); return x; };
      const { best, prev } = await search(SS, [{ snaps: AA, key: 'a' }], limit, h);
      const b = best.get('a'); if (!b || b.m > limit) return null;
      return { m: Math.round(b.m), pts: [[da.lat, da.lon], ...shape(b, prev), [a.lat, a.lon]] };
    }
  };
}
