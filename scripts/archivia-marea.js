// ACQUISIZIONE DELLA MAREA PER L'ARCHIVIO (workflow GitHub «archivio-marea»): legge il livello dal Centro Maree a intervalli e aggiunge le
// letture nuove ai file del giorno, senza duplicati; cancella i file oltre il periodo di conservazione. Vedi marea-archivio.js.
//   node scripts/archivia-marea.js <cartella> [--letture 3] [--intervallo 300]
const fs = require('fs'), path = require('path');
const tide = require('../tide'), A = require('../marea-archivio');

(async () => {
  const dir = path.resolve(process.argv[2] || 'archivio/marea'), arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? +process.argv[i + 1] : d; };
  const n = Math.max(1, Math.min(6, arg('--letture', 1))), gap = Math.max(10, Math.min(600, arg('--intervallo', 300))) * 1000;
  fs.mkdirSync(dir, { recursive: true });
  let added = 0, errors = 0;
  for (let k = 0; k < n; k++) {
    if (k) await new Promise(r => setTimeout(r, gap));
    try {
      const rows = A.rowsFrom(tide.parseLevels(await tide.getJson('livello.json')));
      const byDay = new Map(); for (const r of rows) { const d = A.dayOf(r.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); }
      for (const [d, rs] of byDay) {
        const f = path.join(dir, d + '.jsonl'), m = A.merge(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', rs);
        if (m.added) { fs.writeFileSync(f, m.text); added += m.added; }
      }
      console.log(`lettura ${k + 1}/${n}: ${rows.map(r => `${r.st} ${r.cm ?? 'mancante'} cm alle ${new Date(r.t).toISOString().slice(11, 16)} UTC`).join(', ') || 'nessun dato'}`);
    } catch (e) { errors++; console.log(`lettura ${k + 1}/${n}: fonte non disponibile (${e.message})`); }
  }
  const old = A.expired(fs.readdirSync(dir)); for (const f of old) fs.rmSync(path.join(dir, f));
  console.log(`righe nuove: ${added}; file tolti (oltre ${A.KEEP_DAYS} giorni): ${old.length}${errors ? `; letture non riuscite: ${errors}` : ''}`);
  if (errors === n) process.exitCode = 1;                                // nessuna lettura riuscita: il workflow lo segnala
})();
