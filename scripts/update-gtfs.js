// AGGIORNAMENTO DEI GTFS STATICI (per GitHub Actions o a mano: `npm run update-gtfs`).
// NON sovrascrive mai nulla: ogni versione scaricata con contenuto nuovo viene AGGIUNTA in data/gtfs/<nav|aut>/<inizio-validità>_<hash>.zip.
// È poi il server a scegliere la versione giusta in base al calendario (servizi attivi oggi, coerenza col feed in tempo reale, vedi gtfsstore.js).
// Variabile GTFS_FORCE=1: ignora l'ETag e scarica comunque. Uscita: 0 anche se la rete è irraggiungibile (si riprova al giro successivo),
// 1 solo per errori di programma. Stampa "CHANGES=1" se ci sono file nuovi o eliminati.
const store = require('../gtfsstore');
(async () => {
  let changes = 0;
  for (const src of Object.keys(store.SOURCES)) {
    const r = await store.download(src, { force: process.env.GTFS_FORCE === '1' });
    console.log(`[${src}] ${r.status}${r.file ? ' ' + r.file : ''}${r.from ? ' (valida dal ' + r.from + ')' : ''}${r.error ? ' — ' + r.error : ''}`);
    if (r.status === 'nuova') changes++;
    const del = await store.prune(src);
    if (del?.length) { console.log(`[${src}] eliminate versioni scadute: ${del.join(', ')}`); changes++; }
    const l = await store.list(src);
    console.log(`[${src}] in archivio: ` + l.map(c => `${c.info?.from ?? '?'}→${c.info?.cover?.max ?? '?'}${c.legacy ? ' (vecchio file)' : ''}`).join(' | '));
  }
  console.log('CHANGES=' + (changes ? 1 : 0));
})().catch(e => { console.error(e); process.exit(1); });
