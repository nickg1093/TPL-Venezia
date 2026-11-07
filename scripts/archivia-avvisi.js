#!/usr/bin/env node
// ARCHIVIAZIONE DELLE COMUNICAZIONI ACTV (eseguito dal workflow .github/workflows/archivio-avvisi.yml, ogni 20 minuti, sul ramo «archivio-avvisi")
//   node scripts/archivia-avvisi.js <cartella dell'archivio> [--indietro N]
// Legge il feed RSS ACTV (con il testo delle pagine) e la pagina pubblica del canale Telegram, aggiunge all'archivio solo le comunicazioni nuove
// o modificate (avvisi-archivio.js: id stabile + hash del testo) e aggiorna l'indice. Incrementale e idempotente: rieseguirlo non duplica nulla.
//  · Pagine ACTV: lette per le notizie nuove (ultimi 60 giorni) e rilette per 3 giorni dalla pubblicazione (ACTV le aggiorna: «AGGIORNAMENTO 30/10»).
//  · Telegram: la pagina pubblica mostra circa 20 messaggi; con archivio vuoto (prima esecuzione) o con --indietro N si leggono anche le pagine
//    precedenti (?before=). Verificato il 7/11/2026: si risale solo di circa 4 settimane, poi la pagina salta al messaggio n. 1 del 2016
//    (i messaggi oltre questo salto non si recuperano).
// Stampa CHANGES=0|1 per il workflow. Un errore di una fonte non blocca l'altra e non cancella nulla.
const A = require('../avvisi'), AR = require('../avvisi-archivio');

const DAY = 864e5, PAGE_NEW_DAYS = 60, PAGE_REFRESH_DAYS = 3, TG_BACK_MAX_DAYS = 120;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SERVICE = /\b(?:pinned (?:a |an )?(?:photo|message|video|file|poll|sticker|gif|audio)|ha fissato)\b/i;

async function main(dir, back, { pausa = 1 } = {}) {   // pausa: moltiplicatore delle attese tra le richieste (0 nei test)
  const now = Date.now(), arc = AR.openDir(dir), count = { nuove: 0, modificate: 0 }, errors = [];
  const add = r => { const x = arc.add(r); if (x === 'nuova') count.nuove++; else if (x === 'modificata') count.modificate++; };
  try {
    const rss = A.parseRss(await A.fetchText(A.SRC.rss, ['https://actv.avmspa.it/it/rss-news-feed'])).slice(0, 40);
    for (const it of rss) {
      const prev = arc.recs.get(it.key)?.last, age = now - it.pubMs;
      let page = prev?.page || null;
      if (age < PAGE_NEW_DAYS * DAY && (!page || age < PAGE_REFRESH_DAYS * DAY)) {
        try { page = A.articleText(await A.fetchText(it.url, [], 15000)); } catch (e) { errors.push(`pagina ${it.url}: ${e.message}`); }
        await sleep(400 * pausa);
      }
      add(AR.recordOf('rss', it, page, now));
    }
  } catch (e) { errors.push('RSS: ' + e.message); }
  try {
    const tg = A.parseTelegram(await A.fetchText(A.SRC.tg, ['https://telegram.me/s/muoversivenezia'])).filter(m => !SERVICE.test(m.text));
    for (const m of tg) add(AR.recordOf('tg', m, null, now));
    const hadTg = [...arc.recs.keys()].some(k => k.startsWith('tg:') && !tg.some(m => m.key === k));
    let pages = back ?? (hadTg ? 0 : 6), min = tg.length ? Math.min(...tg.map(m => m.id)) : NaN;
    while (pages-- > 0 && Number.isFinite(min)) {
      await sleep(1000 * pausa);
      const older = A.parseTelegram(await A.fetchText(`${A.SRC.tg}?before=${min}`))
        .filter(m => m.id < min && m.id > min - 200 && now - m.pubMs < TG_BACK_MAX_DAYS * DAY && !SERVICE.test(m.text));   // il salto a messaggi di anni fa si ignora
      if (!older.length) break;
      for (const m of older) add(AR.recordOf('tg', m, null, now));
      min = Math.min(...older.map(m => m.id));
    }
  } catch (e) { errors.push('Telegram: ' + e.message); }
  const saved = arc.save(now);
  console.log(`archivio: ${arc.recs.size} comunicazioni, ${count.nuove} nuove, ${count.modificate} modificate${errors.length ? `; errori: ${errors.join(' | ')}` : ''}`);
  console.log(`CHANGES=${saved ? 1 : 0}`);
  return { saved, ...count, errors };
}

if (require.main === module) {
  const dir = process.argv[2], i = process.argv.indexOf('--indietro'), back = i > 0 ? Math.max(0, +process.argv[i + 1] || 0) : undefined;
  if (!dir) { console.error('uso: node scripts/archivia-avvisi.js <cartella dell\'archivio> [--indietro N]'); process.exit(2); }
  main(dir, back).catch(e => { console.error('archivio: errore', e); process.exit(1); });
}
module.exports = { main };
