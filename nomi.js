// NOMI DAI DATI ACTV, scritti in italiano corretto (fermate e destinazioni). Usato dal server (gtfs.js, orari.js) e quindi anche dai file
// generati per i telefoni (fissi, orari per giorno): stessi nomi ovunque.
//  · accento al posto dell'apostrofo a fine parola: «Liberta'» → «Libertà», «Scorze'» → «Scorzè», «Nicolo'» → «Nicolò», «Pieta'» → «Pietà»;
//    restano le elisioni vere: «Ca'» (una o due lettere prima della vocale), «Sant'», «dell'», «d'» (consonante prima dell'apostrofo);
//  · destinazioni: parola ripetuta di seguito una volta sola («Tronchetto Tronchetto Fer» → «Tronchetto Fer»).
// Idempotente (applicato due volte dà lo stesso risultato). I preferiti non cambiano: le chiavi delle zone sul telefono riportano gli accenti
// alla forma con l'apostrofo (zones.js, norm).
const ACC = { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' };
function nome(s) {
  if (typeof s !== 'string' || !s.includes("'")) return s;
  return s.replace(/(\p{L}{2,})([aeiouAEIOU])'(?=$|[\s,.;:()\-/"])/gu, (m, a, v) => a + ACC[v]);
}
function destinazione(s) {
  if (typeof s !== 'string' || !s) return s;
  const out = [];
  for (const w of nome(s).split(' ')) if (!w || !out.length || out[out.length - 1].toLowerCase() !== w.toLowerCase()) out.push(w);
  return out.join(' ');
}
module.exports = { nome, destinazione };
