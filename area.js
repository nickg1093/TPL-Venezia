// AREA SERVITA: contorno che racchiude tutte le fermate (a RADIUS_M da ognuna), seguendo i corridoi delle linee.
// La mappa resta oscurata fuori e non ci si sposta oltre (meno mattonelle scaricate, nessun rischio di "perdersi").
//   1. griglia di celle (CELL_M) su un piano locale in metri; si segnano le celle entro il raggio da una fermata;
//   2. i "buchi" interni (zone tra linee lontane dalle fermate) si riempiono: conta solo il contorno esterno;
//   3. si percorrono i bordi delle celle segnate (verso antiorario, interno a sinistra); agli incroci diagonali si gira a sinistra,
//      così ogni anello è semplice; più gruppi di fermate lontani tra loro = più anelli;
//   4. il contorno a scalini si semplifica (Douglas-Peucker) e si arrotonda (Chaikin), restando ben oltre le fermate.
// Funzione pura: dati i punti [lat, lon] restituisce gli anelli [[lat, lon]…] e il riquadro. Calcolata una volta per versione del GTFS.
const RADIUS_M = 2500, CELL_M = 250, TOL_M = 300, MAX_CELLS = 4e6;

function outline(points, { radiusM = RADIUS_M, cellM = CELL_M, tolM = TOL_M } = {}) {
  const pts = points.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) < 85 && Math.abs(p[1]) <= 180);
  if (!pts.length) return { rings: [], bbox: null };
  const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length, ky = 110540, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
  const xs = pts.map(p => p[1] * kx), ys = pts.map(p => p[0] * ky);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  // la griglia non supera MAX_CELLS celle: aree enormi = celle più grandi
  while (((x1 - x0 + 2 * radiusM) / cellM + 6) * ((y1 - y0 + 2 * radiusM) / cellM + 6) > MAX_CELLS) cellM *= 1.5;
  const pad = radiusM + 3 * cellM; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const nx = Math.ceil((x1 - x0) / cellM), ny = Math.ceil((y1 - y0) / cellM), M = new Uint8Array(nx * ny);
  const r = radiusM / cellM, rc = Math.ceil(r), r2 = r * r;
  for (let i = 0; i < xs.length; i++) {                                    // celle entro il raggio (dal centro della cella)
    const cx = (xs[i] - x0) / cellM, cy = (ys[i] - y0) / cellM, ix = Math.floor(cx), iy = Math.floor(cy);
    for (let y = Math.max(0, iy - rc); y <= Math.min(ny - 1, iy + rc); y++) {
      const dy = y + 0.5 - cy;
      for (let x = Math.max(0, ix - rc); x <= Math.min(nx - 1, ix + rc); x++) { const dx = x + 0.5 - cx; if (dx * dx + dy * dy <= r2) M[y * nx + x] = 1; }
    }
  }
  // buchi: celle libere non raggiungibili dal bordo della griglia
  const out = new Uint8Array(nx * ny), stack = [];
  const seed = (x, y) => { const k = y * nx + x; if (!M[k] && !out[k]) { out[k] = 1; stack.push(k); } };
  for (let x = 0; x < nx; x++) { seed(x, 0); seed(x, ny - 1); }
  for (let y = 0; y < ny; y++) { seed(0, y); seed(nx - 1, y); }
  while (stack.length) {
    const k = stack.pop(), x = k % nx, y = (k - x) / nx;
    if (x > 0) seed(x - 1, y); if (x < nx - 1) seed(x + 1, y); if (y > 0) seed(x, y - 1); if (y < ny - 1) seed(x, y + 1);
  }
  for (let k = 0; k < M.length; k++) if (!out[k]) M[k] = 1;
  // bordi orientati (interno a sinistra) tra vertici della griglia
  const W = nx + 1, on = (x, y) => x >= 0 && y >= 0 && x < nx && y < ny && M[y * nx + x] === 1;
  const from = new Map();                                                   // vertice -> bordi che partono da lì
  const add = (ax, ay, bx, by) => { const a = ay * W + ax; (from.get(a) || from.set(a, []).get(a)).push({ ax, ay, bx, by, used: false }); };
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (!on(x, y)) continue;
    if (!on(x, y - 1)) add(x, y, x + 1, y);
    if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!on(x - 1, y)) add(x, y + 1, x, y);
  }
  const loops = [];
  for (const list of from.values()) for (const e0 of list) {
    if (e0.used) continue;
    const loop = []; let e = e0;
    while (e && !e.used) {
      e.used = true; loop.push([e.ax, e.ay]);
      const next = (from.get(e.by * W + e.bx) || []).filter(n => !n.used);
      if (next.length > 1) {                                                 // incrocio diagonale: prima a sinistra
        const dx = e.bx - e.ax, dy = e.by - e.ay, turn = n => { const ex = n.bx - n.ax, ey = n.by - n.ay, c = dx * ey - dy * ex; return c > 0 ? 0 : c === 0 ? 1 : 2; };
        next.sort((a, b) => turn(a) - turn(b));
      }
      e = next[0];
    }
    if (loop.length >= 4) loops.push(loop);
  }
  // da celle a metri, poi semplificazione e arrotondamento
  const rings = [];
  for (const loop of loops) {
    let p = loop.map(([x, y]) => [x0 + x * cellM, y0 + y * cellM]);
    p = dropCollinear(p);
    p = douglas(p, tolM);
    if (p.length < 3) continue;
    p = chaikin(chaikin(p));
    if (signedArea(p) <= 0) continue;                                        // solo contorni esterni (antiorari)
    rings.push(p.map(([x, y]) => [+(y / ky).toFixed(5), +(x / kx).toFixed(5)]));
  }
  rings.sort((a, b) => b.length - a.length);
  let s = 90, w = 180, n = -90, e = -180;
  for (const ring of rings) for (const [la, lo] of ring) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  return { rings, bbox: rings.length ? [s, w, n, e] : null };
}

const signedArea = p => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] * p[i][1] - p[i][0] * p[j][1]); return a / 2; };
function dropCollinear(p) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
  }
  return out;
}
// Douglas-Peucker su anello chiuso: si spezza nei due punti più lontani tra loro
function douglas(p, tol) {
  if (p.length < 4) return p;
  let far = 0, fd = -1; for (let i = 1; i < p.length; i++) { const d = (p[i][0] - p[0][0]) ** 2 + (p[i][1] - p[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const half = (a, b) => dp(p.slice(a, b + 1), tol);
  const A = half(0, far), B = dp([...p.slice(far), p[0]], tol);
  return [...A.slice(0, -1), ...B.slice(0, -1)];
}
function dp(p, tol) {
  if (p.length < 3) return p;
  const [ax, ay] = p[0], [bx, by] = p[p.length - 1], L = Math.hypot(bx - ax, by - ay) || 1;
  let idx = 0, md = -1;
  for (let i = 1; i < p.length - 1; i++) { const d = Math.abs((bx - ax) * (ay - p[i][1]) - (ax - p[i][0]) * (by - ay)) / L; if (d > md) { md = d; idx = i; } }
  if (md <= tol) return [p[0], p[p.length - 1]];
  const l = dp(p.slice(0, idx + 1), tol), r = dp(p.slice(idx), tol);
  return [...l.slice(0, -1), ...r];
}
function chaikin(p) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
  }
  return out;
}
// punto dentro l'anello (per i test e per chi usa l'area)
function inside(ring, lat, lon) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

module.exports = { outline, inside, RADIUS_M };
