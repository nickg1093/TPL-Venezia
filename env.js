// Impostazioni locali facoltative: file .env.local accanto a server.js (una per riga, NOME=valore; righe con # ignorate).
// Le variabili già presenti nell'ambiente (es. su Render) hanno la precedenza. Va caricato PRIMA di ogni altro modulo.
const fs = require('fs'), path = require('path');
const file = path.join(__dirname, '.env.local');
try {
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line); if (!m) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch (e) { if (e.code !== 'ENOENT') console.error('.env.local non leggibile:', e.message); }
