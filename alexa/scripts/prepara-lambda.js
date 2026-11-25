// Copia il catalogo delle frasi fisse (alexa/messaggi.js) dentro alexa/lambda/index.js, tra i segni «==MESSAGGI==» e «==FINE MESSAGGI==».
// Così nella console Alexa si incolla un solo file. Uso (PowerShell, cartella del progetto): node alexa/scripts/prepara-lambda.js
// Con --verifica non scrive nulla: esce con errore se la copia non è aggiornata (lo fa anche la prova tests/alexa-lambda.test.js).
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'lambda', 'index.js');
const M = require('../messaggi');
const inizio = '// ==MESSAGGI==', fine = '// ==FINE MESSAGGI==';
function generato(testo) {
  const a = testo.indexOf(inizio), b = testo.indexOf(fine);
  if (a < 0 || b < a) throw new Error('segni ==MESSAGGI== non trovati in lambda/index.js');
  const riga = testo.slice(a, testo.indexOf('\n', a) + 1);
  return testo.slice(0, a) + riga + 'const M = ' + JSON.stringify(M) + ';\n' + testo.slice(b);
}
if (require.main === module) {
  const t = fs.readFileSync(FILE, 'utf8'), n = generato(t);
  if (process.argv.includes('--verifica')) { if (n !== t) { console.error('lambda/index.js non aggiornato: esegui node alexa/scripts/prepara-lambda.js'); process.exit(1); } console.log('lambda/index.js aggiornato'); }
  else { fs.writeFileSync(FILE, n); console.log('Frasi copiate in alexa/lambda/index.js'); }
}
module.exports = { generato, FILE };
