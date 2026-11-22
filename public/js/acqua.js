// ACQUA ALTA: regole e calcoli sul telefono (quote stimate delle calli, passerelle, stagione, MOSE). Modulo puro: nessun import, nessun
// accesso alla pagina né alla rete, così si prova anche fuori dal browser (tests/acqua.test.js). I file li prepara scripts/genera-acqua.js
// (metodo e fonti in scripts/acqua-core.js); li carica e li disegna livelli.js; il pianificatore li usa per i tratti a piedi (camminata.js).
//
// Livello «in città». La previsione CPSM è il livello che ci sarebbe a Punta della Salute SENZA il MOSE. Se il MOSE è programmato, in
// movimento o sollevato e la previsione supera la soglia di sollevamento (110 cm), in città si conta al massimo LIV_MOSE (le barriere
// tengono la laguna più bassa: con il MOSE in funzione il livello in laguna è rimasto sotto i 90 cm). Il livello osservato è sempre quello vero.
export const SOGLIA_MOSE = 110, LIV_MOSE = 88, MIN_ACQUA = 80;
export const ALFA = (() => { let s = ''; for (let c = 35; s.length < 80; c++) if (c !== 92) s += String.fromCharCode(c); return s; })();   // come scripts/acqua-core.js

const U = 1e6, R = 111320;
const mDist = (la1, lo1, la2, lo2) => { const k = Math.cos((la1 + la2) / 2 * Math.PI / 180); return Math.hypot((la1 - la2) * R, (lo1 - lo2) * R * k); };

// ---- file delle quote: griglia di celle di ~20 m (stima) o tessera del rilievo (~10 m, quote misurate); valore = quota in cm sullo zero
// di Punta della Salute (ZMPS, lo stesso riferimento della marea) ----
export function quoteDa(j) {
  if (!j || j.f !== 1 || !j.g || !Array.isArray(j.r)) return null;
  const G = j.g, n = G.righe * G.colonne;
  if (!(n > 0 && n < 2e6)) return null;
  const v = new Uint8Array(n).fill(255);
  let celle = 0;
  for (const row of j.r) {
    if (!Array.isArray(row) || row.length !== 3) continue;
    const [r, c0, s] = row; if (!(Number.isInteger(r) && r >= 0 && r < G.righe && Number.isInteger(c0) && c0 >= 0) || typeof s !== 'string') continue;
    for (let i = 0; i < s.length && c0 + i < G.colonne; i++) { const k = ALFA.indexOf(s[i]); if (k >= 0) { if (v[r * G.colonne + c0 + i] === 255) celle++; v[r * G.colonne + c0 + i] = k; } }
  }
  const zone = (j.zone || []).filter(z => Array.isArray(z.box) && z.box.length === 4);
  const cella = (lat, lon) => { const r = Math.floor((lat - G.lat0) / G.dlat), c = Math.floor((lon - G.lon0) / G.dlon); return r < 0 || c < 0 || r >= G.righe || c >= G.colonne ? -1 : r * G.colonne + c; };
  return {
    G, zone, curva: Array.isArray(j.curva) ? j.curva : [], fonte: String(j.fonte || ''), nota: String(j.nota || ''), v,
    n: celle, rilievo: null, nMis: 0,
    // quota della cella (cm) o null se lì non ci sono calli nel modello
    at(lat, lon) { const k = cella(lat, lon); return k < 0 || v[k] === 255 ? null : 50 + v[k] * 2; },
    misurata() { return false; },                                 // la stima: mai misurata (vedi composta)
    zonaDi(lat, lon) { return zone.find(z => lat >= z.box[0] && lat <= z.box[2] && lon >= z.box[1] && lon <= z.box[3]) || null; },
    // percentuale di città storica allagata a un livello (curva ufficiale), per i testi
    percento(cm) { return percento(this.curva, cm); }
  };
}
// ---- quote STIMATE (Qb, file «quote») + tessere del RILIEVO (quote misurate, caricate a richiesta) ----
// ril: { g: { lat0, lon0, dlat, dlon } griglia delle tessere, t: Map «riga_colonna» -> quoteDa(tessera), meta: { nome, attribuzione, … } }.
// Dove una tessera caricata ha la cella, vale la quota misurata; altrimenti la stima. Stessa interfaccia di quoteDa.
export function composta(Qb, ril) {
  if (!Qb || !ril || !ril.g || !(ril.t instanceof Map)) return Qb;
  const g = ril.g, tess = (la, lo) => ril.t.get(`${Math.floor((la - g.lat0) / g.dlat)}_${Math.floor((lo - g.lon0) / g.dlon)}`);
  const mis = (la, lo) => { const t = tess(la, lo); return t ? t.at(la, lo) : null; };
  return Object.create(Qb, {
    rilievo: { value: ril.meta || null },
    nMis: { get() { let n = 0; for (const t of ril.t.values()) n += t.n; return n; } },
    at: { value: (la, lo) => { const h = mis(la, lo); return h != null ? h : Qb.at(la, lo); } },
    misurata: { value: (la, lo) => mis(la, lo) != null },
  });
}

export function percento(curva, cm) {
  if (!curva.length || cm < curva[0][0] - 10) return 0;
  if (cm <= curva[0][0]) return curva[0][1] * (cm - (curva[0][0] - 10)) / 10;
  for (let i = 1; i < curva.length; i++) if (cm <= curva[i][0]) { const [x0, y0] = curva[i - 1], [x1, y1] = curva[i]; return y0 + (y1 - y0) * (cm - x0) / (x1 - x0); }
  return curva[curva.length - 1][1];
}

// ---- file delle passerelle: percorsi del piano comunale, con quota di posa e tracciato (k: 't' ricalcato sulla rete, 'i' indicativo) ----
export function passerelleDa(j) {
  if (!j || j.f !== 1 || !Array.isArray(j.p)) return null;
  const list = [];
  for (const p of j.p) {
    if (!p || typeof p.id !== 'string' || !(p.q >= 50 && p.q <= 200) || !Array.isArray(p.l) || p.l.length < 4) continue;
    const dec = l => { const out = []; let y = 0, x = 0; for (let i = 0; i + 1 < l.length; i += 2) { y += l[i]; x += l[i + 1]; out.push([y / 1e5, x / 1e5]); } return out; };
    const pts = dec(p.l), parti = [pts, ...(Array.isArray(p.l2) ? p.l2.filter(l => Array.isArray(l) && l.length >= 4).map(dec) : [])];   // l2: rami (percorsi a «Y» delle tavole)
    list.push({ id: p.id, t: p.t || null, s: String(p.s || ''), d: String(p.d || ''), m: +p.m || 0, q: +p.q, k: p.k === 't' ? 't' : 'i', pts, parti, tavola: p.o === 'tavola' });
  }
  const st = j.stagione && /^\d\d-\d\d$/.test(j.stagione.da) && /^\d\d-\d\d$/.test(j.stagione.a) ? j.stagione : { da: '09-15', a: '04-30' };
  return { list, stagione: st, garantiti: +j.garantiti || 120, fonte: String(j.fonte || '') };
}

// ---- stagione delle passerelle (data di Venezia) ----
export function romeMD(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = t => p.find(x => x.type === t)?.value;
  return `${g('month')}-${g('day')}`;
}
export function inStagione(ms, st = { da: '09-15', a: '04-30' }) {
  const md = romeMD(ms);
  return st.da <= st.a ? md >= st.da && md <= st.a : md >= st.da || md <= st.a;
}

// ---- livello da usare in città: { cm, kind, mose } (mose: true se il livello è stato limitato per le barriere) ----
const MOSE_ON = new Set(['programmato', 'sollevamento', 'sollevata']);
export function livelloCitta(v, moseStato) {
  if (!v || !Number.isFinite(v.cm)) return null;
  if (v.kind === 'previsto' && v.cm >= SOGLIA_MOSE && MOSE_ON.has(moseStato)) return { cm: Math.min(v.cm, LIV_MOSE), kind: v.kind, mose: true, mare: v.cm };
  return { cm: v.cm, kind: v.kind, mose: false };
}

// ---- passerelle: stato del servizio e percorsi posati a un livello ----
// 'fuori' fuori stagione · 'no' marea sotto la quota più bassa · 'si' posate dove la marea arriva · 'oltre' sopra il livello garantito
export function statoPasserelle(P, cm, ms) {
  if (!P) return null;
  if (!inStagione(ms, P.stagione)) return 'fuori';
  const min = Math.min(...P.list.map(p => p.q));
  if (!(cm >= min)) return 'no';
  return cm > P.garantiti ? 'oltre' : 'si';
}
export const posate = (P, cm, ms) => (P && inStagione(ms, P.stagione) && Number.isFinite(cm) ? P.list.filter(p => cm >= p.q) : []);

// indice dei tratti di passerella posati, per sapere se un punto della rete pedonale ci sta sopra (entro «raggio» metri).
// byId: passerelle posate per codice (gli archi aggiunti alla rete da pedoni.js le ritrovano così); garantiti: livello fino a cui il
// servizio è garantito (oltre, i metri su passerella si contano anche in «oltre»: possono essere sommersi, da verificare sul posto)
export function indicePasserelle(list, raggio = 9, garantiti = null) {
  const S = 0.0003, M = new Map(), key = (la, lo) => Math.floor(la / S) + ',' + Math.floor(lo / S);
  const segs = [];
  for (const p of list) for (const pts of p.parti || [p.pts]) for (let i = 1; i < pts.length; i++) {
    const s = { p, a: pts[i - 1], b: pts[i] }; segs.push(s);
    const la0 = Math.min(s.a[0], s.b[0]), la1 = Math.max(s.a[0], s.b[0]), lo0 = Math.min(s.a[1], s.b[1]), lo1 = Math.max(s.a[1], s.b[1]);
    for (let la = Math.floor(la0 / S); la <= Math.floor(la1 / S); la++) for (let lo = Math.floor(lo0 / S); lo <= Math.floor(lo1 / S); lo++) { const k = la + ',' + lo; let l = M.get(k); if (!l) M.set(k, l = []); l.push(s); }
  }
  return {
    size: segs.length, byId: new Map(list.map(p => [p.id, p])), garantiti: Number.isFinite(garantiti) ? garantiti : null,
    near(lat, lon) {
      const r = Math.floor(lat / S), q = Math.floor(lon / S), kx = R * Math.cos(lat * Math.PI / 180);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const s of M.get((r + a) + ',' + (q + b)) || []) {
        const ax = (s.a[1] - lon) * kx, ay = (s.a[0] - lat) * R, bx = (s.b[1] - lon) * kx, by = (s.b[0] - lat) * R, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        if (Math.hypot(ax + t * dx, ay + t * dy) <= raggio) return s.p;
      }
      return null;
    }
  };
}

// ---- tratti della rete pedonale (public/js/pedoni.js): { a, b, w, s, g: [[lat, lon] in milionesimi] } ----
// Ponte, sempre asciutto: segno 2 nelle mattonelle; nelle mattonelle vecchie le scale (1) e il piano corto tra due scale. Come scripts/acqua-core.js.
export function ponte(e) {
  if (e.s & 3) return true;
  if (!(e.w <= 40)) return false;
  const scale = n => n.adj?.some(x => x !== e && (x.s & 1));
  return !!(scale(e.a) && scale(e.b));
}
// Metri bagnati di un tratto al livello «cm»: campioni ogni ~6 m; asciutti i ponti, le celle senza quota (fuori modello) e i punti su una
// passerella posata. { bagnati, passerella, prof, pp, stimati } (prof: profondità massima in cm, pp: passerelle usate, stimati: metri
// bagnati dove la quota è una stima e non una misura del rilievo, per i testi)
export function bagnato(e, cm, Q, pass) {
  const out = { bagnati: 0, passerella: 0, prof: 0, pp: new Set(), stimati: 0, oltre: 0 };
  const sopra = pass && pass.garantiti != null && cm > pass.garantiti;   // oltre il livello garantito: passerelle forse sommerse
  if (e.s & 4) {                                                // arco di passerella aggiunto alla rete (pedoni.js): tutto su passerella, mai bagnato
    const p = pass?.byId?.get(e.p); if (!p || !Number.isFinite(cm)) return out;
    out.passerella = e.w; out.pp.add(p); if (sopra) out.oltre = e.w;
    return out;
  }
  if (!Q || !Number.isFinite(cm) || cm < MIN_ACQUA - 15 || ponte(e)) return out;
  const g = e.g; let tot = 0;
  for (let i = 1; i < g.length; i++) tot += mDist(g[i - 1][0] / U, g[i - 1][1] / U, g[i][0] / U, g[i][1] / U);
  if (!(tot > 0)) return out;
  const k = e.w / tot;                                          // metri «a piedi» per metro reale (scale)
  for (let i = 1; i < g.length; i++) {
    const la0 = g[i - 1][0] / U, lo0 = g[i - 1][1] / U, la1 = g[i][0] / U, lo1 = g[i][1] / U, L = mDist(la0, lo0, la1, lo1), n = Math.max(1, Math.ceil(L / 6));
    for (let j = 0; j < n; j++) {
      const f = (j + 0.5) / n, la = la0 + (la1 - la0) * f, lo = lo0 + (lo1 - lo0) * f, h = Q.at(la, lo);
      if (h == null || cm - h < 2) continue;                    // asciutto, o appena un velo d'acqua
      const seg = L / n * k;
      const p = pass && pass.near(la, lo);
      if (p) { out.passerella += seg; out.pp.add(p); if (sopra) out.oltre += seg; } else { out.bagnati += seg; out.prof = Math.max(out.prof, cm - h); if (!Q.misurata?.(la, lo)) out.stimati += seg; }
    }
  }
  return out;
}
// Costo in più (metri equivalenti) per il calcolo del percorso: un metro con l'acqua vale PENALE metri; sulla passerella il passo è
// un po' più lento (folla, una persona per senso). Un tratto bagnato resta possibile se non c'è altra strada. Oltre il livello garantito
// la passerella resta preferita al guado (è comunque più alta del terreno), ma costa di più (OLTRE_PASS): può essere sommersa o chiusa.
export const PENALE = 8, LENTO_PASS = 0.15, OLTRE_PASS = 1.5;
export const costo = b => b.bagnati * (PENALE - 1) + b.passerella * LENTO_PASS + (b.oltre || 0) * OLTRE_PASS;

// Riassunto dei tratti di un percorso a piedi (archi di pedoni.js): metri bagnati e su passerella, profondità, passerelle usate, e le parti
// da evidenziare sulla mappa ({ k: 'acqua' | 'passerella', pts: [[lat, lon], …] }, tratti interi)
export function riassunto(archi, cm, Q, pass) {
  const out = { bagnati: 0, passerella: 0, prof: 0, passerelle: [], parti: [], stimati: 0, oltre: 0 }, ids = new Set();
  for (const e of archi || []) {
    const b = bagnato(e, cm, Q, pass); if (!b.bagnati && !b.passerella) continue;
    out.bagnati += b.bagnati; out.passerella += b.passerella; out.prof = Math.max(out.prof, b.prof); out.stimati += b.stimati; out.oltre += b.oltre;
    for (const p of b.pp) if (!ids.has(p.id)) { ids.add(p.id); out.passerelle.push(p); }
    out.parti.push({ k: b.bagnati >= b.passerella ? 'acqua' : 'passerella', pts: e.g.map(([la, lo]) => [la / U, lo / U]) });
  }
  out.bagnati = Math.round(out.bagnati); out.passerella = Math.round(out.passerella); out.stimati = Math.round(out.stimati); out.oltre = Math.round(out.oltre);
  return out;
}
