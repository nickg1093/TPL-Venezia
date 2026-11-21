// GENERA I DATI DELL'ACQUA ALTA per i telefoni (vedi scripts/acqua-core.js per il metodo e README, «Acqua alta»).
//   node scripts/genera-acqua.js <uscita> [--mattonelle <cartella>] [--ramses <curve-livello-shp.zip | cartella con .shp/.dbf>]
// <uscita>/acqua/{passerelle,quote,indice}.json. Per la prova in locale: <uscita> = public (il server li serve come file statici).
// Rete pedonale: --mattonelle <cartella> con i file «<cella>.json» oppure una copia del ramo «dati» (pedoni/ultimo.json, pedoni/i, pedoni/m);
// senza --mattonelle le mattonelle della zona si scaricano dal ramo «dati» su GitHub (DATI_REPO, predefinito nickg1093/TPL-Venezia).
// Dati di partenza: data/acqua/passerelle-atlante.json e data/acqua/quote-riferimenti.json (con le fonti).
// I file in <uscita>/acqua (indice, quote STIMATE, passerelle) sono sempre gli stessi, con o senza --ramses: sono quelli pubblicabili.
// --ramses: in più le quote MISURATE della pavimentazione (rilievo RAMSES, «Fonte informativa: Insula spa»; scripts/ramses-core.js) in
// tessere di ~1,2 km in <uscita>/acqua/rilievo/ (indice + <riga_colonna>.json), che il telefono scarica solo per la zona che serve.
// DIRITTI: le condizioni d'uso del sito di Insula consentono uso, riproduzione ed elaborazione, anche parziale, con «Fonte informativa:
// Insula spa»; vietano vendita e cessione a terzi dei DATI: l'archivio originale (dati-ramses/) non va mai su GitHub. README, appendice D.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const A = require('./acqua-core');
const P = require('./pedoni-core');
const RC = require('./ramses-core');

const ROOT = path.join(__dirname, '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const get = url => new Promise((ok, ko) => https.get(url, { headers: { 'User-Agent': 'TPL-Venezia genera-acqua' } }, r => {
  if (r.statusCode !== 200) { r.resume(); return ko(new Error(`${url}: HTTP ${r.statusCode}`)); }
  const b = []; r.on('data', d => b.push(d)); r.on('end', () => ok(Buffer.concat(b)));
}).on('error', ko));

// celle delle mattonelle che toccano le zone del modello
function celleZone(zone) {
  const out = new Set();
  for (const z of zone) { const [s, w, n, e] = z.box; for (let la = s; la <= n + P.CL; la += P.CL / 2) for (let lo = w; lo <= e + P.CO; lo += P.CO / 2) out.add(P.cellOf(Math.min(la, n), Math.min(lo, e))); }
  return out;
}

async function mattonelle(dir, celle) {
  const tiles = {};
  if (dir && fs.existsSync(path.join(dir, 'pedoni', 'ultimo.json'))) {          // copia del ramo «dati»
    const u = JSON.parse(fs.readFileSync(path.join(dir, 'pedoni', 'ultimo.json'), 'utf8'));
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'pedoni', 'i', u.v + '.json'), 'utf8'));
    for (const c of celle) if (idx.t[c]) tiles[c] = JSON.parse(fs.readFileSync(path.join(dir, 'pedoni', 'm', idx.t[c] + '.json'), 'utf8'));
    return { tiles, rete: u.v };
  }
  if (dir) {                                                                     // cartella con «<cella>.json»
    for (const c of celle) { const f = path.join(dir, c + '.json'); if (fs.existsSync(f)) tiles[c] = JSON.parse(fs.readFileSync(f, 'utf8')); }
    return { tiles, rete: 'locale' };
  }
  const repo = process.env.DATI_REPO || 'nickg1093/TPL-Venezia', raw = `https://raw.githubusercontent.com/${repo}`;
  const ind = JSON.parse(await get(`${raw}/dati/indice.json`)), base = `${raw}/${ind.commit}`;
  const idx = JSON.parse(await get(`${base}/pedoni/i/${ind.pedoni.v}.json`));
  for (const c of celle) if (idx.t[c]) tiles[c] = JSON.parse(await get(`${base}/pedoni/m/${idx.t[c]}.json`));
  return { tiles, rete: ind.pedoni.v };
}

async function main() {
  const args = process.argv.slice(2), out = args[0];
  if (!out) { console.error('uso: genera-acqua.js <uscita> [--mattonelle <cartella>]'); process.exit(2); }
  const mi = args.indexOf('--mattonelle'), dir = mi > 0 ? path.resolve(args[mi + 1]) : null;
  const ri = args.indexOf('--ramses'), fonteR = ri > 0 ? path.resolve(args[ri + 1] || '') : null;
  const atl = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'acqua', 'passerelle-atlante.json'), 'utf8'));
  const rif = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'acqua', 'quote-riferimenti.json'), 'utf8'));

  const { tiles, rete } = await mattonelle(dir, celleZone(rif.zone));
  const R = A.rete(tiles, P.CL, P.CO), near = A.indiceNodi(R);
  console.log(`acqua: ${Object.keys(tiles).length} mattonelle (rete ${rete}), ${R.edges.length} tratti, ${R.edges.filter(e => e.ponte).length} tratti di ponte`);

  // 1. passerelle
  // tracciati georeferenziati dalle tavole dell'Atlante (data/acqua/passerelle-tavole.json, verificati): hanno la precedenza sul ricalco
  const TAV = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'acqua', 'passerelle-tavole.json'), 'utf8')); } catch { return null; } })();
  const tav = new Map((TAV?.percorsi || []).map(t => [t.id.replace(/\s/g, ''), t]));
  const percorsi = atl.percorsi.map(p => {
    const t = tav.get(p.id.replace(/\s/g, ''));
    if (t && t.segmenti?.length) return { ...p, k: 't', m: Math.round(t.m_tavola), g: t.segmenti[0], g2: t.segmenti.slice(1), daTavola: true };
    return { ...p, ...A.ricalca(R, near, { a: p.a, b: p.b, m: p.metri, geo: p.geo }) };
  });
  console.log(`passerelle: ${percorsi.filter(p => p.daTavola).length} tracciati dalle tavole georeferenziate, gli altri ricalcati sulla rete`);
  const nt = percorsi.filter(p => p.k === 't').length;
  for (const p of percorsi) if (p.k !== 't') console.log(`  indicativo ${p.id} (${p.geo}): ufficiali ${p.metri} m, sulla rete ${p.m ?? '—'} m — ${p.descrizione}`);
  console.log(`passerelle: ${percorsi.length} percorsi, ${nt} tracciati sulla rete, ${percorsi.length - nt} indicativi`);

  // 2-3. quote STIMATE (sempre: sono i file pubblicabili e la riserva dove il rilievo manca)
  const G = rif.griglia;
  const celle = A.quote(R, { G, zone: rif.zone, curva: rif.curva, punti: rif.punti, percorsi: percorsi.map(p => ({ g: p.g, q: p.quota })) });
  const prova = cl => [90, 100, 110, 120, 130, 140].map(cm => `${cm}: ${A.allagata(cl, cm, () => true).toFixed(1)}%`).join(' · ');
  console.log(`quote stimate: ${celle.length} celle di ~20 m; allagato nella città storica a ${[90, 100, 110, 120, 130, 140].map(cm => `${cm}: ${A.allagata(celle, cm).toFixed(1)}% (curva ${A.percento(rif.curva, cm).toFixed(1)}%)`).join(' · ')}`);
  const righe = A.codifica(celle, G);
  const fonteQ = 'Stima indicativa TPL Venezia da: ' + rif.curva_fonte + ' ' + rif.punti_fonte + ' Quote di posa delle passerelle: ' + atl.fonte + '. Rete pedonale © OpenStreetMap contributors (ODbL).';
  const quote = { f: 1, fonte: fonteQ, nota: rif.note, g: G, zone: rif.zone.map(z => ({ id: z.id, nome: z.nome, box: z.box, curva: !!z.curva })), curva: rif.curva, r: righe };
  const pass = { f: 1, fonte: atl.fonte + '. Tracciati: dalle tavole dell\'Atlante georeferenziate sulle curve RAMSES (Fonte informativa: Insula spa) dove verificati, altrove ricalcati sulla rete pedonale © OpenStreetMap contributors (ODbL), indicativi.', stagione: atl.stagione, garantiti: atl.garantiti,
    p: percorsi.map(p => ({ id: p.id, t: p.tavola, s: p.sestiere, d: p.descrizione, m: p.metri, q: p.quota, k: p.k, l: A.linea(p.g), ...(p.g2?.length ? { l2: p.g2.map(A.linea) } : {}), ...(p.daTavola ? { o: 'tavola' } : {}) })) };

  const dirOut = path.join(path.resolve(out), 'acqua'); fs.mkdirSync(dirOut, { recursive: true });
  const files = {};
  for (const [nome, obj] of [['passerelle', pass], ['quote', quote]]) {
    const buf = Buffer.from(JSON.stringify(obj)); const h = sha(buf);
    fs.writeFileSync(path.join(dirOut, nome + '.json'), buf);
    files[nome] = { sha: h, bytes: buf.length };
  }
  const indice = { formato: 1, v: sha(JSON.stringify(files)).slice(0, 12), creato: new Date().toISOString(), rete, files };
  fs.writeFileSync(path.join(dirOut, 'indice.json'), JSON.stringify(indice, null, 1) + '\n');
  console.log(`scritti in ${dirOut}: passerelle ${files.passerelle.bytes} B, quote ${files.quote.bytes} B, versione ${indice.v}`);

  // 4. quote MISURATE (solo con --ramses): tessere in acqua/rilievo/, cartella esclusa da GitHub (.gitignore) finché i diritti non sono chiari
  if (!fonteR) return;
  const RL = await RC.carica(fonteR, console.log);
  console.log(`ramses: ${RL.curve} curve, ${RL.vertici} vertici, quote ${RL.livelli[0]}…${RL.livelli[1]} cm ZMPS, LIVELLO_PS − LIVELLO_GE = ${RL.diffGe.map(([d, n]) => `${d} cm (${n})`).join(', ')}`);
  const GR = rif.griglia_rilievo, mis = [];
  const st = A.rilievo(R, mis, { G: GR, zone: rif.zone, quota: (la, lo) => RC.quotaIn(RL, la, lo), basso: RC.mediana });
  console.log(`quote misurate: ${st.misurate} celle di ~10 m (${st.parziali} con meno di metà dei punti misurati: restano stimate); lunghezza di calli allagata a ${prova(mis)}`);
  const dirR = path.join(dirOut, 'rilievo'); fs.mkdirSync(dirR, { recursive: true });
  const R0 = rif.rilievo, tf = {}, tess = A.tessere(mis, GR, rif.tessera);
  for (const t of tess) {
    const buf = Buffer.from(JSON.stringify({ f: 1, g: t.g, r: t.r }));
    fs.writeFileSync(path.join(dirR, t.id + '.json'), buf);
    tf[t.id] = { sha: sha(buf), bytes: buf.length, celle: t.n };
  }
  for (const f of fs.readdirSync(dirR)) if (/^\d+_\d+\.json$/.test(f) && !tf[f.slice(0, -5)]) fs.unlinkSync(path.join(dirR, f));   // tessere vecchie
  const ir = { formato: 1, v: sha(JSON.stringify(tf)).slice(0, 12), creato: new Date().toISOString(),
    rilievo: { nome: R0.nome, fonte: R0.fonte, attribuzione: R0.attribuzione, data: R0.data, riferimento: 'ZMPS', licenza: R0.licenza, pubblicabile: !!R0.pubblicabile, nota: rif.note_rilievo },
    g: { lat0: GR.lat0, lon0: GR.lon0, dlat: +(GR.dlat * rif.tessera).toFixed(7), dlon: +(GR.dlon * rif.tessera).toFixed(7) }, files: tf };
  fs.writeFileSync(path.join(dirR, 'indice.json'), JSON.stringify(ir, null, 1) + '\n');
  const tot = Object.values(tf).reduce((a, f) => a + f.bytes, 0);
  console.log(`scritte in ${dirR}: ${tess.length} tessere, ${tot} B in tutto (max ${Math.max(...Object.values(tf).map(f => f.bytes))} B), versione ${ir.v}`);
  console.log(R0.pubblicabile ? 'rilievo: elaborati pubblicabili con «Fonte informativa: Insula spa» (condizioni d\'uso di Insula); l\'archivio originale resta fuori da GitHub.' : 'ATTENZIONE: rilievo non pubblicabile: non mettere acqua/rilievo su GitHub.');
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
