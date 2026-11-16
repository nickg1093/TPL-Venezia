// Scarica le misure per giorno dal server (/api/metriche/giorni, riservato) e le aggiunge a un file sul TUO computer.
// Il server tiene i numeri solo in memoria (si perdono a ogni riavvio o deploy): lanciando questo script ogni sera si conserva lo storico.
//
// Uso (Windows, dalla cartella del progetto):
//   set DIAG_TOKEN=il-tuo-token
//   node scripts/metriche-giorno.js
// Facoltativi: URL=https://veneziatpl.onrender.com  FILE=metriche-giorni.csv
//
// Nel file CSV c'è una riga per giorno; se il giorno c'è già si tiene il valore più alto (la giornata di oggi cresce fino a mezzanotte).
const fs = require('fs'), path = require('path');
const URL_BASE = (process.env.URL || 'https://veneziatpl.onrender.com').replace(/\/$/, '');
const TOKEN = process.env.DIAG_TOKEN || '';
const FILE = path.resolve(process.env.FILE || 'metriche-giorni.csv');
const COLS = ['data', 'persone', 'aperture app (flusso mezzi)', 'fermate consultate', 'zone consultate', 'viaggi pianificati', 'corse aperte',
  'avvisi di arrivo attivati', 'avvisi di arrivo annullati', 'aggiunte al calendario', 'marea', 'avvisi ACTV letti', 'MOSE', 'errori segnalati dai telefoni', 'MB'];

(async () => {
  if (!TOKEN) { console.error('Manca DIAG_TOKEN (lo stesso impostato su Render).'); process.exit(1); }
  const r = await fetch(URL_BASE + '/api/metriche/giorni', { headers: { Authorization: 'Bearer ' + TOKEN }, signal: AbortSignal.timeout(90000) });
  if (!r.ok) { console.error('Risposta del server:', r.status, r.status === 401 ? '(token sbagliato o non impostato su Render)' : ''); process.exit(1); }
  const d = await r.json();
  const rows = new Map();
  if (fs.existsSync(FILE)) for (const line of fs.readFileSync(FILE, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const v = line.split(';'); rows.set(v[0], v);
  }
  for (const g of [...d.giorni, d.oggi]) {
    const v = [g.data, String(g.persone) + (g.persone_almeno ? '+' : ''), ...COLS.slice(2, -1).map(k => String(g.operazioni?.[k] ?? 0)), String(g.MB)];
    const old = rows.get(g.data);
    if (!old || (parseFloat(v[1]) || 0) >= (parseFloat(old[1]) || 0)) rows.set(g.data, v);   // stesso giorno: tiene la lettura più completa
  }
  const out = [COLS.join(';'), ...[...rows.keys()].sort().map(k => rows.get(k).join(';'))].join('\r\n') + '\r\n';
  fs.writeFileSync(FILE, out);
  const o = d.oggi;
  console.log(`Salvato in ${FILE}. Oggi (${o.data}): ${o.persone} persone, ${o.operazioni['viaggi pianificati']} viaggi pianificati, ${o.operazioni['fermate consultate']} fermate consultate.`);
})().catch(e => { console.error('Errore:', e.message); process.exit(1); });
