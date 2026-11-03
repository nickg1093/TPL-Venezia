// RIGENERA le distanze a piedi tra fermate lungo la rete pedonale di OpenStreetMap:
//   pedonale-laguna.txt      centro storico, Giudecca, Tronchetto, Murano, Burano/Mazzorbo, Sant'Erasmo/Treporti, Lido/Pellestrina, Chioggia
//   pedonale-terraferma.txt  tutte le altre zone con fermate ACTV (Mestre, Marghera, Favaro, Riviera del Brenta, extraurbano…)
// Uso (dalla cartella del progetto, con i GTFS in data/; serve Node 18 o più recente e la connessione a Internet):
//   node scripts/pedonale.js               rigenera entrambi i file
//   node scripts/pedonale.js terraferma    solo la terraferma (circa 5-15 minuti: ~330 zone in 12 richieste a Overpass API)
//   node scripts/pedonale.js laguna        solo la laguna (una richiesta)
// Distanze fino a 2 km in laguna e 1,2 km in terraferma: così si propone anche «tutto a piedi» quando conviene (es. P.le Roma → S. Tomà).
// Quando: se cambiano molte fermate nei GTFS o la rete pedonale (nuovi ponti, sottopassi, chiusure lunghe). Poi si caricano i file su GitHub.
// Fermate lontane più di 150 m da ogni strada: restano con la linea d'aria × 1,3 (riga 3 del file). Dati © OpenStreetMap contributors (ODbL).
const fs = require('fs');
const path = require('path');
const gtfs = require('../gtfs');
const P = require('./pedonale-core');

const ROOT = path.join(__dirname, '..');
const BB = [[45.42, 12.29, 45.455, 12.37], [45.22, 12.29, 45.43, 12.43], [45.448, 12.33, 45.465, 12.365], [45.475, 12.40, 45.50, 12.425], [45.43, 12.37, 45.475, 12.47], [45.19, 12.26, 45.235, 12.31]];
const inB = (la, lo) => BB.some(b => la >= b[0] && la <= b[2] && lo >= b[1] && lo <= b[3]);
const EP = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const UA = 'TPL-Venezia-live/pedonale (rigenerazione occasionale delle distanze a piedi tra fermate)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const m = (a, b) => Math.hypot((a.la - b.la) * 111320, (a.lo - b.lo) * 78000);

async function overpass(R, label) {
  const net = P.rete(), CH = 30;
  for (let c = 0; c < R.length; c += CH) {
    const q = P.query(R.slice(c, c + CH));
    let ok = false, wait = 10000;
    for (let t = 0; t < 9 && !ok; t++) {
      const ep = EP[t % EP.length];
      try {
        const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, signal: AbortSignal.timeout(240000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = JSON.parse(await r.text());
        if (j.remark && /error|timed out/i.test(j.remark)) throw new Error(j.remark);
        net.add(j.elements); ok = true;
      } catch (e) { console.log(`  ${label}: ${new URL(ep).host} non risponde (${e.message}), riprovo tra ${wait / 1000} s`); await sleep(wait); wait = Math.min(wait * 2, 120000); }
    }
    if (!ok) throw new Error('Overpass API non disponibile: riprova più tardi');
    console.log(`  ${label}: zone ${Math.min(c + CH, R.length)}/${R.length}`);
    if (c + CH < R.length) await sleep(3000);                  // gentile con il servizio gratuito
  }
  return net.done();
}

function save(file, ST, pairs, loose) {
  const old = fs.existsSync(path.join(ROOT, file)) ? fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').filter(l => l.startsWith('#')) : [];
  const date = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  const head = old.length ? old.map(l => l.replace(/Generato il .*? da/, `Generato il ${date} da`))
    : [`# Distanze a piedi (metri) tra fermate ACTV lungo la rete pedonale di OpenStreetMap. Generato il ${date} da scripts/pedonale.js.`,
       '# Riga 1: fermate (n = navigazione, a = automobilistico). Riga 2: coppie «i.j.metri» in base 36. Riga 3: fermate lontane dalla rete.',
       '# Dati © OpenStreetMap contributors, licenza ODbL (https://www.openstreetmap.org/copyright).'];
  const body = P.testo(ST, pairs).split('\n');
  fs.writeFileSync(path.join(ROOT, file), [...head, ...body, loose.map(k => k.toString(36)).join(' '), ''].join('\n'));
  console.log(`${file}: ${ST.length} fermate, ${pairs.length} coppie, ${loose.length} fermate fuori rete`);
}

(async () => {
  const want = process.argv[2] || 'entrambi';
  const all = [];
  for (const [i, p] of [['nav', 'n'], ['aut', 'a']]) {
    const G = await gtfs.load(i, { force: true });
    for (const sid in G.stopIndex) { const L = G.stopLoc[sid]; if (L) all.push({ id: p + sid, la: L[0], lo: L[1] }); }
  }
  const lag = all.filter(s => inB(s.la, s.lo));
  if (want !== 'terraferma') {
    const ST = lag.map(s => ({ ...s }));
    console.log(`laguna: ${ST.length} fermate`);
    const g = await overpass(BB.map(b => [b[0], b[1], b[2], b[3]]), 'laguna');
    const pairs = P.coppie(ST, g, 2000, 150);
    save('pedonale-laguna.txt', ST, pairs, []);                // in laguna una fermata senza rete resta senza cambi a piedi (pontili isolati)
  }
  if (want !== 'laguna') {
    const terra = all.filter(s => !inB(s.la, s.lo));
    const edge = lag.filter(l => terra.some(t => m(l, t) <= 1200));   // pontili vicini alla terraferma: cambi bus ↔ battello (es. Chioggia, Punta Sabbioni)
    const ST = [...terra, ...edge].map(s => ({ ...s }));
    const R = P.aree(ST);
    console.log(`terraferma: ${terra.length} fermate (+${edge.length} pontili di confine), ${R.length} zone da scaricare`);
    const g = await overpass(R, 'terraferma');
    const pairs = P.coppie(ST, g, 1200, 150);
    save('pedonale-terraferma.txt', ST, pairs, ST.map((s, k) => (s.n >= 0 && s.sd <= 150 ? -1 : k)).filter(k => k >= 0));
  }
})().catch(e => { console.error(e.message); process.exit(1); });
