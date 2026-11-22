// PERCORSI A PIEDI CALCOLATI SUL TELEFONO lungo la rete pedonale di OpenStreetMap (© OpenStreetMap contributors, ODbL).
// Nessun calcolo e nessun dato sul server: la rete arriva dal CDN in mattonelle (scripts/pedoni-core.js) caricate solo quando servono
// e salvate sul telefono. Anche la posizione resta sul telefono: al server vanno, come prima, solo le fermate vicine con i metri.
//
// Il modulo è puro (nessun import): riceve da fuori la funzione che carica una mattonella, così si prova anche fuori dal browser.
//   createNet({ CL, CO, loadTile })  rete vuota; loadTile(cella) -> contenuto della mattonella o null (fuori zona)
//   net.distances(da, mete, limite, enough, costo)  metri lungo la rete da un punto a più punti (fermate): Map(chiave -> metri)
//   net.route(da, a, limite, costo)  percorso tra due punti: { m, pts: [[lat, lon], …], archi } o null
// costo(tratto) facoltativo: metri «in più» per scegliere la strada (acqua alta: acqua.js); i metri restituiti restano quelli veri.
// Punti: { lat, lon } in gradi. Metri «a piedi»: le scale contano 1,3 volte (come le distanze tra fermate del pianificatore).
// La ricerca è un Dijkstra (A* quando la meta è una sola) che carica le mattonelle man mano che la frontiera ci arriva.
const U = 1e6;
const SNAP_M = 200;                                              // un punto più lontano di così da ogni strada non si aggancia alla rete
const EQUIV = 2 / 7;                                              // acqua alta: 1 m con l'acqua conta 3 m per il pianificatore (acqua.js: PENALE 8)
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
      const e = { a, b, w, s: row[3] | 0, g };          // s: 1 scale, 2 ponte (scripts/pedoni-core.js)
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
    const p = Promise.resolve().then(() => loadTile(c)).then(T => addTile(c, T), () => null).then(v => { tiles.set(c, v); if (pend.size) integraPendenti(); return v; });
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
  async function search(SS, T, limit, h, enough = T.length, costo = null) {
    const dist = new Map(), prev = new Map(), Q = heap(), done = new Set();
    const set = (n, d, pe) => { if (d < (dist.get(n) ?? Infinity) && d <= limit) { dist.set(n, d); prev.set(n, pe); Q.push(d + h(n), n); } };
    // pezzi di tratto ai capi (dal punto agganciato all'incrocio): anche loro pagano il costo in più, in proporzione ai metri (prima erano
    // gratis: un percorso di due tratti con l'acqua sembrava asciutto). pc = parte di costo, tolta poi dai metri veri.
    const pc = (e, m) => (costo && e.w > 0 ? costo(e) * Math.min(1, m / e.w) : 0);
    for (const S of SS) { const ca = pc(S.e, S.pa), cb = pc(S.e, S.pb); set(S.e.a, S.d + S.pa + ca, { from: S, pc: ca }); set(S.e.b, S.d + S.pb + cb, { from: S, pc: cb }); }
    const best = new Map(), ends = new Map();                     // ends: nodo -> [meta, aggancio della meta, metri dal nodo alla meta]
    for (const t of T) {
      t.need = new Set();
      for (const ts of t.snaps) {
        for (const S of SS) if (ts.e === S.e) {                   // stesso tratto della partenza: diretto lungo il tratto
          const lungo = Math.abs(ts.at - S.at) * S.k, c = pc(S.e, lungo), m = S.d + lungo + ts.d + c, b = best.get(t.key);
          if (!b || m < b.m) best.set(t.key, { m, via: null, S, ts, pc: c });
        }
        for (const [n, part] of [[ts.e.a, ts.pa], [ts.e.b, ts.pb]]) { const c = pc(ts.e, part); let l = ends.get(n); if (!l) ends.set(n, l = []); l.push([t, ts, part + ts.d + c, c]); t.need.add(n); }
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
      for (const [t, ts, off, c] of ends.get(u) || []) {
        const m = du + off, b = best.get(t.key);
        if (!b || m < b.m) best.set(t.key, { m, via: u, ts, pc: c });
        if (t.need.delete(u) && !t.need.size) open--;
      }
      for (const e of u.adj) {
        if (e.v && !(costo && costo.ok && costo.ok(e))) continue;  // passerella (arco aggiunto): solo se posata al livello del calcolo
        const v = e.a === u ? e.b : e.a; if (!done.has(v)) set(v, du + e.w + (costo ? costo(e) : 0), { e });
      }
    }
    return { best, prev };
  }

  // tratti interi del percorso verso una meta (dal primo incrocio all'ultimo), e metri veri (senza il costo in più)
  function archi(b, prev, interi = false) {
    if (!b.via) return interi && b.S ? [b.S.e] : [];
    const out = []; let n = b.via, S = null;
    for (;;) { const pe = prev.get(n); if (!pe) break; if (pe.from) { S = pe.from; break; } out.push(pe.e); n = pe.e.a === n ? pe.e.b : pe.e.a; }
    out.reverse();
    // con i tratti agganciati ai capi, se il percorso li percorre davvero (più di 3 m dal punto agganciato all'incrocio)
    if (interi) {
      if (S && S.e !== out[0] && (n === S.e.a ? S.pa : S.pb) > 3) out.unshift(S.e);
      if (b.ts && b.ts.e !== out[out.length - 1] && (b.via === b.ts.e.a ? b.ts.pa : b.ts.pb) > 3) out.push(b.ts.e);
    }
    return out;
  }
  // metri veri: senza il costo dei tratti interi e dei pezzi ai capi (pc della meta e della partenza)
  function veri(b, prev, costo) {
    if (!costo) return b.m;
    let m = b.m - archi(b, prev).reduce((s, e) => s + costo(e), 0) - (b.pc || 0);
    if (b.via) { let n = b.via; for (;;) { const pe = prev.get(n); if (!pe) break; if (pe.from) { m -= pe.pc || 0; break; } n = pe.e.a === n ? pe.e.b : pe.e.a; } }
    return m;
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

  // PASSERELLE COME ARCHI DELLA RETE (acqua alta). Un percorso su passerelle può passare dove OpenStreetMap non ha una strada (attraverso
  // un campo, verso un pontile) o più lontano di qualche metro dalla linea della calle: per non perderlo, il tracciato diventa una catena
  // di archi aggiunti (e.v = 1, e.s = 4, e.p = codice), agganciati alla rete ai due capi (incrocio entro AGG_NODO m, altrimenti punto
  // del tratto più vicino entro AGG_MAX m) e lungo il tracciato agli incroci entro AGG_NODO m. Gli archi aggiunti non cambiano la rete:
  // la ricerca li usa solo se il costo li ammette (costo.ok, cioè la passerella è posata al livello di quel calcolo), quindi d'estate
  // o con la marea bassa tutto resta come prima. Ogni passerella si aggiunge una volta, quando le mattonelle che tocca sono caricate.
  const AGG_NODO = 6, AGG_MAX = 30, PASSI = 8, pend = new Map(), fatte = new Map();
  const kxOf = la => 111320 / U * Math.cos(la / U * Math.PI / 180), KY = 111320 / U;
  const vnode = (la, lo) => ({ la, lo, adj: [], cell: cellOf(la, lo), v: 1 });
  const vedge = (a, b, g, w, s, p) => { const e = { a, b, w: Math.max(0.1, w), s, g, v: 1, p }; a.adj.push(e); if (b !== a) b.adj.push(e); return e; };
  const lenG = g => { let m = 0; for (let i = 1; i < g.length; i++) m += Math.hypot((g[i][1] - g[i - 1][1]) * kxOf(g[i][0]), (g[i][0] - g[i - 1][0]) * KY); return m; };
  const cellsOfPts = (pts, ring = 1) => { const c = new Set(); for (const [la, lo] of pts) { const r = Math.floor(la / U / CL), q = Math.floor(lo / U / CO); for (let a = -ring; a <= ring; a++) for (let b = -ring; b <= ring; b++) c.add(`${r + a}_${q + b}`); } return [...c]; };
  // incrocio della rete più vicino entro «max» metri (solo mattonelle caricate)
  function nodoVicino(la, lo, max) {
    let best = null, bd = max;
    for (const c of cellsOfPts([[la, lo]])) { const t = tiles.get(c); if (!t || t instanceof Promise) continue;
      for (const e of t.edges) for (const n of [e.a, e.b]) { const d = Math.hypot((n.lo - lo) * kxOf(la), (n.la - la) * KY); if (d < bd) { bd = d; best = n; } } }
    return best ? { n: best, d: bd } : null;
  }
  // punto del tratto più vicino entro «max» metri: { e, i, pt, d, at, len }
  function trattoVicino(la, lo, max) {
    let best = null; const kx = kxOf(la);
    for (const c of cellsOfPts([[la, lo]])) { const t = tiles.get(c); if (!t || t instanceof Promise) continue;
      for (const e of t.edges) { let along = 0;
        for (let i = 1; i < e.g.length; i++) {
          const [y0, x0] = e.g[i - 1], [y1, x1] = e.g[i], ax = (x0 - lo) * kx, ay = (y0 - la) * KY, bx = (x1 - lo) * kx, by = (y1 - la) * KY, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
          let f = L2 ? -(ax * dx + ay * dy) / L2 : 0; f = Math.max(0, Math.min(1, f)); const d = Math.hypot(ax + f * dx, ay + f * dy);
          if (d <= max && (!best || d < best.d)) best = { e, i, d, at: along + f * L, pt: [Math.round(y0 + f * (y1 - y0)), Math.round(x0 + f * (x1 - x0))] };
          along += L;
        }
        if (best && best.e === e) best.len = along; } }
    return best;
  }
  // aggancio di un capo della passerella: incrocio vicino, oppure nodo aggiunto sul tratto più vicino (due archi aggiunti verso i suoi capi,
  // con la forma del tratto: si valutano con le quote come la strada vera) e un breve arco diritto dal capo al tratto
  function aggancia(n, id) {
    const nv = nodoVicino(n.la, n.lo, AGG_NODO);
    if (nv) { vedge(n, nv.n, [[n.la, n.lo], [nv.n.la, nv.n.lo]], nv.d, 0, id); return true; }
    const tv = trattoVicino(n.la, n.lo, AGG_MAX); if (!tv) return false;
    const e = tv.e, k = tv.len > 0 ? e.w / tv.len : 1, m = vnode(tv.pt[0], tv.pt[1]);
    vedge(m, e.a, [tv.pt, ...e.g.slice(0, tv.i).reverse()], tv.at * k, e.s & 3, id);
    vedge(m, e.b, [tv.pt, ...e.g.slice(tv.i)], (tv.len - tv.at) * k, e.s & 3, id);
    if (tv.d > 0.5) vedge(n, m, [[n.la, n.lo], tv.pt], tv.d, 0, id);
    else { for (const x of m.adj) { x.a === m ? (x.a = n) : (x.b = n); n.adj.push(x); } m.adj.length = 0; }
    return true;
  }
  function integra(p) {
    const parti = p.parti.map(pts => pts.map(([la, lo]) => [Math.round(la * U), Math.round(lo * U)])).filter(g => g.length > 1);
    if (!parti.length || cellsOfPts(parti.flat(), 0).some(c => !loaded(c))) return false;   // le mattonelle dei punti (le vicine se ci sono)
    const fatti = [];
    for (const g of parti) {
      // vertici del tracciato, con punti in più ogni PASSI metri per agganciare gli incroci attraversati
      const pts = [g[0]];
      for (let i = 1; i < g.length; i++) { const L = lenG([g[i - 1], g[i]]), n = Math.max(1, Math.ceil(L / PASSI)); for (let j = 1; j <= n; j++) pts.push([Math.round(g[i - 1][0] + (g[i][0] - g[i - 1][0]) * j / n), Math.round(g[i - 1][1] + (g[i][1] - g[i - 1][1]) * j / n)]); }
      const N = pts.map(([la, lo]) => vnode(la, lo));
      for (let i = 1; i < N.length; i++) vedge(N[i - 1], N[i], [pts[i - 1], pts[i]], lenG([pts[i - 1], pts[i]]), 4, p.id);
      let ok = aggancia(N[0], p.id); ok = aggancia(N[N.length - 1], p.id) || ok;
      for (let i = 1; i < N.length - 1; i++) { const nv = nodoVicino(N[i].la, N[i].lo, AGG_NODO); if (nv) { vedge(N[i], nv.n, [pts[i], [nv.n.la, nv.n.lo]], nv.d, 0, p.id); ok = true; } }
      fatti.push(ok);
    }
    fatte.set(p.id, { sig: p.sig, agganciata: fatti.some(Boolean) });
    return true;
  }
  function integraPendenti() { for (const [id, p] of pend) if (integra(p)) pend.delete(id); }

  return {
    ensure, snap, nodes, tiles,
    // passerelle da aggiungere come archi: [{ id, parti: [[[lat, lon], …], …] }] (acqua.js: passerelleDa). Una passerella già aggiunta con
    // lo stesso tracciato non si ripete; un tracciato cambiato (dati nuovi) si aggiunge con il codice nuovo «id~sig». Restituisce quante
    // passerelle sono già nella rete.
    passerelle(list) {
      for (const p of list || []) {
        if (!p || typeof p.id !== 'string' || !Array.isArray(p.parti)) continue;
        const sig = p.parti.flat().length + ':' + (p.parti[0]?.[0] || []).join(',');
        if (fatte.get(p.id)?.sig === sig || pend.get(p.id)?.sig === sig) continue;
        pend.set(p.id, { id: p.id, parti: p.parti, sig });
      }
      integraPendenti();
      return fatte.size;
    },
    // mattonelle che servono alle passerelle in attesa dentro un riquadro [s, w, n, e] (gradi): caricate, poi le passerelle si aggiungono
    async preparaPasserelle(box, max = 12) {
      const need = new Set();
      for (const p of pend.values()) { const ll = p.parti.flat(); if (ll.some(([la, lo]) => la >= box[0] && la <= box[2] && lo >= box[1] && lo <= box[3])) for (const c of cellsOfPts(ll.map(([la, lo]) => [la * U, lo * U]))) if (!loaded(c)) need.add(c); }
      if (need.size && need.size <= max) await Promise.all([...need].map(ensure));
      integraPendenti();
    },
    passerelleAggiunte: () => new Map(fatte),
    // metri a piedi da «da» a ciascuna meta (entro limite); mete: [{ lat, lon, key }]. enough: bastano le N mete più vicine
    async distances(da, mete, limit, enough = mete.length, costo = null) {
      await prefetch([da], 1);
      const SS = await snap(da); if (!SS) return null;
      const T = [];
      for (const m of mete) { const s = await snap(m); if (s) T.push({ snaps: s, key: m.key }); }
      const { best, prev } = await search(SS, T, costo ? limit * 2.5 : limit, () => 0, enough, costo);   // con il costo: più margine
      const out = new Map();
      // con il costo (acqua alta): metri veri più una parte del costo (EQUIV), così le fermate raggiungibili solo con l'acqua «sembrano» più
      // lontane al pianificatore e i minuti a piedi tengono conto del passo più lento (acqua, passerelle); il limite resta sui metri veri
      for (const t of T) { const b = best.get(t.key); if (!b) continue; const m = veri(b, prev, costo); if (m <= limit) out.set(t.key, Math.round(costo ? m + (b.m - m) * EQUIV : m)); }
      return out;
    },
    // percorso tra due punti: metri e forma (con i due tratti in linea retta tra il punto e la strada)
    // tratti delle mattonelle che coprono un riquadro [s, w, n, e] (gradi), al massimo «max» mattonelle; null se sono troppe
    async edgesIn(s, w, n, e, max = 16) {
      const cells = [];
      for (let r = Math.floor(s / CL); r <= Math.floor(n / CL); r++) for (let q = Math.floor(w / CO); q <= Math.floor(e / CO); q++) cells.push(`${r}_${q}`);
      if (cells.length > max) return null;
      const ts = await Promise.all(cells.map(ensure)), out = [];
      for (const t of ts) if (t) out.push(...t.edges);
      return out;
    },
    async route(da, a, limit, costo = null) {
      const n = Math.min(8, Math.ceil(Math.hypot((a.lat - da.lat) / CL, (a.lon - da.lon) / CO)));
      await prefetch(Array.from({ length: n + 1 }, (_, i) => ({ lat: da.lat + (a.lat - da.lat) * i / (n || 1), lon: da.lon + (a.lon - da.lon) * i / (n || 1) })), 0);
      const SS = await snap(da), AA = await snap(a); if (!SS || !AA) return null;
      const kx = 111320 / U * Math.cos(a.lat * Math.PI / 180), ky = 111320 / U;
      const h = n => { let x = Infinity; for (const s of AA) x = Math.min(x, Math.hypot((n.lo - s.pt[1]) * kx, (n.la - s.pt[0]) * ky) + s.d); return x; };
      const { best, prev } = await search(SS, [{ snaps: AA, key: 'a' }], costo ? limit * 2.5 : limit, h, 1, costo);
      const b = best.get('a'); if (!b) return null;
      const m = veri(b, prev, costo); if (m > limit) return null;
      return { m: Math.round(m), pts: [[da.lat, da.lon], ...shape(b, prev), [a.lat, a.lon]], archi: archi(b, prev, true) };
    }
  };
}
