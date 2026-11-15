// GENERA I FILE DEL RAMO «dati» (scaricati dai telefoni tramite CDN: vedi fissi.js e README, sezione «Dati sul telefono e CDN»).
// Gira nel workflow GitHub .github/workflows/dati.yml; si può provare anche in locale.
//   node scripts/genera-dati.js fissi <cartella>            fermate, linee e tracciati di OGNI versione dei GTFS in data/gtfs
//   node scripts/genera-dati.js pedoni <rete.opl> <cartella> mattonelle della rete pedonale da un estratto OSM (formato OPL, osmium)
//   node scripts/genera-dati.js orari <cartella>            orari per giorno di ogni versione dei GTFS in archivio, da ieri in avanti (orari.js)
//   node scripts/genera-dati.js indice <cartella> <commit>   indice.json: commit con i file, versioni presenti, rete pedonale in uso
// Struttura della cartella (= contenuto del ramo «dati»):
//   fissi/<nav|aut>/<versione>/{stops,routes,shapes}.json   versione = prime 12 cifre dell'impronta md5 dello ZIP dei GTFS
//   pedoni/m/<impronta>.json   mattonelle (il nome è l'impronta: una mattonella che non cambia resta lo stesso file)
//   pedoni/i/<versione>.json   indice delle mattonelle: { f, v, lat, lon, osm, t: { cella: impronta } }
//   pedoni/ultimo.json         rete pedonale in uso: { v, indice (SHA-256 del file indice), lat, lon }
//   orari/<nav|aut>/<versione>.json  indice degli orari per giorno di una versione: { f, src, v, h, giorni: { AAAAMMGG: file | 0 } }
//   orari/<nav|aut>/g/<file>.json    corse di un giorno (nome = impronta del contenuto)
//   indice.json                letto dal server (fissi.js): { formato, commit, fissi: ["nav/<versione>", …], orari: [...], pedoni }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const gtfs = require('../gtfs');
const store = require('../gtfsstore');
const fissi = require('../fissi');
const P = require('./pedoni-core');
const orari = require('../orari');
const cal = require('../calendar');

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const rmrf = f => fs.rmSync(f, { recursive: true, force: true });

async function generaFissi(out) {
  const keep = new Set();
  for (const src of ['nav', 'aut']) {
    for (const c of (await store.list(src)).filter(x => x.ok)) {
      const G = await gtfs.loadVersion(src, c, c.info.from || '00000000', { full: true }), v = fissi.versione(G), dir = path.join(out, 'fissi', src, v);
      keep.add(`${src}/${v}`);
      // già presenti E uguali a quelli che il server calcola con il codice attuale (es. nomi corretti in una nuova versione dell'app): altrimenti si riscrivono
      const f = fissi.files(G, gtfs.toLL);
      if (fissi.NOMI.every(k => { try { return fs.readFileSync(path.join(dir, k + '.json')).equals(f[k]); } catch { return false; } })) { console.log(`fissi ${src}/${v}: già presenti`); continue; }
      for (const k of fissi.NOMI) write(path.join(dir, k + '.json'), f[k]);
      console.log(`fissi ${src}/${v} (${path.basename(c.file)}): fermate ${f.stops.length} B, linee ${f.routes.length} B, tracciati ${f.shapes.length} B`);
    }
  }
  // versioni non più in archivio: tolte dal ramo (restano nella cronologia, quindi gli indirizzi già dati continuano a funzionare)
  for (const src of ['nav', 'aut']) {
    const d = path.join(out, 'fissi', src); if (!fs.existsSync(d)) continue;
    for (const v of fs.readdirSync(d)) if (!keep.has(`${src}/${v}`)) { rmrf(path.join(d, v)); console.log(`fissi ${src}/${v}: tolta (non più in archivio)`); }
  }
}

// Orari per giorno. Per ogni data da domani alla fine dell'ultimo periodo coperto, la versione è quella che sceglie il server
// (gtfsstore.choose, la stessa regola): di quella versione servono il giorno, il precedente e il successivo. Solo quei giorni.
// Si rigenera tutto a ogni giro (pochi minuti): i file che non cambiano hanno lo stesso nome (impronta) e git non li vede come novità;
// i giorni passati e le versioni non più usate spariscono dal ramo.
async function generaOrari(out) {
  const oggi = cal.romeYmd(), keep = new Set(), base = path.join(out, 'orari');
  for (const src of ['nav', 'aut']) {
    const cands = (await store.list(src)).filter(x => x.ok && x.info), need = new Map();
    const end = cands.reduce((m, c) => (c.info.cover.max > m ? c.info.cover.max : m), oggi);
    for (let d = cal.addDays(oggi, 1), k = 0; d <= end && k < 800; d = cal.addDays(d, 1), k++) {
      const r = store.choose(cands, d); if (!r.pick || r.approx) continue;
      const s = need.get(r.pick) || new Set(); need.set(r.pick, s); for (const x of gtfs.window3(d)) s.add(x);
    }
    for (const [c, days] of need) {
      const G = await gtfs.loadVersion(src, c, c.info.from || '00000000', { full: true }), v = String(G.meta.hash).slice(0, 12);
      const { indice, files } = orari.versione(G, src, [...days]);
      write(path.join(base, src, v + '.json'), indice); keep.add(`${src}/${v}.json`);
      let nuovi = 0, tot = 0;
      for (const [name, buf] of files) { const f = path.join(base, src, 'g', name + '.json'); keep.add(`${src}/g/${name}.json`); tot += buf.length; if (!fs.existsSync(f)) { write(f, buf); nuovi++; } }
      const g = JSON.parse(indice).giorni, n = Object.keys(g).length;
      console.log(`orari ${src}/${v} (${path.basename(c.file)}): ${n} giorni (${Object.keys(g)[0]}…${Object.keys(g)[n - 1]}), ${files.size} file diversi (${(tot / 1e6).toFixed(1)} MB), ${nuovi} nuovi`);
    }
  }
  // tutto ciò che non serve più: giorni passati, versioni non più in archivio
  let tolti = 0;
  for (const src of ['nav', 'aut']) for (const sub of ['', 'g']) {
    const d = path.join(base, src, sub); if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) { const rel = `${src}/${sub ? sub + '/' : ''}${f}`; if (f.endsWith('.json') && !keep.has(rel)) { fs.rmSync(path.join(d, f)); tolti++; } }
  }
  console.log(`orari: ${tolti} file non più necessari tolti`);
}

async function generaPedoni(opl, out) {
  // fermate di tutte le versioni in archivio: la rete copre la zona di ognuna
  const stops = [];
  for (const src of ['nav', 'aut']) for (const c of (await store.list(src)).filter(x => x.ok)) {
    const G = await gtfs.loadVersion(src, c, c.info.from || '00000000', { full: true });
    for (const s in G.stopIndex) if (G.stopLoc[s]) stops.push(G.stopLoc[s]);
  }
  const cover = P.copertura(stops);
  console.log(`pedoni: ${stops.length} fermate, ${cover.size} mattonelle di copertura`);
  const R = P.lettore(), rl = readline.createInterface({ input: fs.createReadStream(opl), crlfDelay: Infinity });
  for await (const L of rl) R.line(L);
  const r = R.done();
  console.log(`pedoni: ${r.n} nodi, ${r.ways.length} vie percorribili`);
  const { tiles, edges } = P.mattonelle(r, c => cover.has(c));
  const idx = {}; let tot = 0, max = 0, maxC = '';
  for (const c in tiles) {
    const buf = Buffer.from(tiles[c]), h = sha(buf).slice(0, 16), f = path.join(out, 'pedoni', 'm', h + '.json');
    idx[c] = h; tot += buf.length; if (buf.length > max) { max = buf.length; maxC = c; }
    if (!fs.existsSync(f)) write(f, buf);
  }
  const used = new Set(Object.values(idx)), md = path.join(out, 'pedoni', 'm');
  let tolte = 0; for (const f of fs.readdirSync(md)) if (!used.has(f.replace(/\.json$/, ''))) { fs.rmSync(path.join(md, f)); tolte++; }
  const base = { f: 1, lat: P.CL, lon: P.CO, osm: process.env.OSM_DATA || null, t: idx };
  const v = sha(JSON.stringify(idx)).slice(0, 16), ibuf = Buffer.from(JSON.stringify({ ...base, v }));
  rmrf(path.join(out, 'pedoni', 'i'));
  write(path.join(out, 'pedoni', 'i', v + '.json'), ibuf);
  write(path.join(out, 'pedoni', 'ultimo.json'), JSON.stringify({ v, indice: sha(ibuf), lat: P.CL, lon: P.CO }));
  console.log(`pedoni: ${Object.keys(idx).length} mattonelle, ${edges} tratti, ${(tot / 1e6).toFixed(1)} MB in tutto (la più grande ${maxC}: ${(max / 1e3).toFixed(0)} kB), ${tolte} mattonelle vecchie tolte, versione ${v}`);
}

function generaIndice(out, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('commit non valido');
  const list = [];
  for (const src of ['nav', 'aut']) { const d = path.join(out, 'fissi', src); if (fs.existsSync(d)) for (const v of fs.readdirSync(d).sort()) if (fs.existsSync(path.join(d, v, 'shapes.json'))) list.push(`${src}/${v}`); }
  const pf = path.join(out, 'pedoni', 'ultimo.json'), pedoni = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : null;
  const orariList = [];
  for (const src of ['nav', 'aut']) { const d = path.join(out, 'orari', src); if (fs.existsSync(d)) for (const f of fs.readdirSync(d).sort()) if (/^[0-9a-f]{12}\.json$/.test(f)) orariList.push(`${src}/${f.slice(0, 12)}`); }
  const j = { formato: fissi.FORMATO, commit, creato: new Date().toISOString(), fissi: list, orari: orariList, pedoni };
  if (!fissi.parseIndice(j)) throw new Error('indice non valido');
  write(path.join(out, 'indice.json'), JSON.stringify(j, null, 1) + '\n');
  console.log(`indice: commit ${commit.slice(0, 10)}, ${list.length} versioni dei GTFS, orari per giorno di ${orariList.length} versioni, rete pedonale ${pedoni ? pedoni.v : 'assente'}`);
}

(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'fissi' && a) await generaFissi(path.resolve(a));
  else if (cmd === 'orari' && a) await generaOrari(path.resolve(a));
  else if (cmd === 'pedoni' && a && b) await generaPedoni(path.resolve(a), path.resolve(b));
  else if (cmd === 'indice' && a) generaIndice(path.resolve(a), b);
  else { console.error('uso: genera-dati.js fissi <cartella> | orari <cartella> | pedoni <rete.opl> <cartella> | indice <cartella> <commit>'); process.exit(2); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
