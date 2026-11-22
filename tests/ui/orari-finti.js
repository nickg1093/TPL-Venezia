// Per tests/ui/offline.py: file degli orari per giorno (come il ramo «dati» del CDN, orari.js) di OGGI per le versioni dei GTFS che il
// server di prova usa, scritti in <cartella>/orari/<src>/<versione>.json e <cartella>/orari/<src>/g/<impronta>.json.
//   node tests/ui/orari-finti.js <cartella>      stampa { src: versione }
'use strict';
const fs = require('fs'), path = require('path');
const store = require('../../gtfsstore'), gtfs = require('../../gtfs'), orari = require('../../orari'), cal = require('../../calendar');
(async () => {
  const out = process.argv[2]; if (!out) throw new Error('cartella mancante');
  const oggi = cal.romeYmd(), res = {};
  for (const src of ['nav', 'aut']) {
    const sel = await store.select(src); if (!sel.pick) continue;
    const full = await gtfs.loadVersion(src, sel.pick, oggi, { full: true }), v = sel.pick.hash.slice(0, 12);
    const { indice, files } = orari.versione(full, src, [oggi]);
    fs.mkdirSync(path.join(out, 'orari', src, 'g'), { recursive: true });
    fs.writeFileSync(path.join(out, 'orari', src, v + '.json'), indice);
    for (const [n, b] of files) fs.writeFileSync(path.join(out, 'orari', src, 'g', n + '.json'), b);
    res[src] = v;
  }
  console.log(JSON.stringify({ oggi, v: res }));
})().catch(e => { console.error(e.message); process.exit(1); });
