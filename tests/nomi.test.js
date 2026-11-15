// NOMI DAI DATI ACTV (nomi.js): accenti al posto dell'apostrofo finale, elisioni vere intatte, destinazioni senza parole ripetute;
// chiavi delle zone sul telefono invariate (preferiti salvati prima continuano a funzionare).
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { nome, destinazione } = require('../nomi');

test('accento al posto dell\'apostrofo a fine parola; elisioni («Ca\'», «Sant\'», «dell\'», «d\'») intatte; idempotente', () => {
  const casi = { "Liberta' Righi": 'Libertà Righi', "Scorze' IV Novembre": 'Scorzè IV Novembre', "San Nicolo'": 'San Nicolò', "Pieta'": 'Pietà', "Casino'": 'Casinò',
    "Brenta d'Abba'": "Brenta d'Abbà", "Vetrego Pra'": 'Vetrego Prà', "Fosso' Callesette": 'Fossò Callesette', "LIBERTA'": 'LIBERTÀ', "Universita',": 'Università,',
    "Ca' Rezzonico": "Ca' Rezzonico", "Cavarzere Sant' Antonio": "Cavarzere Sant' Antonio", "dell' Elettronica Silos": "dell' Elettronica Silos",
    "Ospedale dell'Angelo": "Ospedale dell'Angelo", "Quarto d'Altino FS": "Quarto d'Altino FS", 'Piazzale Roma': 'Piazzale Roma' };
  for (const [a, b] of Object.entries(casi)) { assert.equal(nome(a), b, a); assert.equal(nome(nome(a)), b, a + ' (due volte)'); }
  assert.equal(nome(null), null); assert.equal(nome(''), '');
});

test('destinazioni: parola ripetuta di seguito una volta sola', () => {
  assert.equal(destinazione('Tronchetto Tronchetto Fer'), 'Tronchetto Fer');
  assert.equal(destinazione("Monte Cervino San Dona'"), 'Monte Cervino San Donà');
  assert.equal(destinazione('Lido S.M.E.'), 'Lido S.M.E.');
  assert.equal(destinazione('San Marco San Zaccaria'), 'San Marco San Zaccaria');
});

test('telefono: chiave di zona uguale con il nome vecchio («Liberta\'») e nuovo («Libertà»); ricerca con o senza accento', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'js', 'zones.js'), path.join(dir, 'zones.js'));
  const Z = await import('file://' + path.join(dir, 'zones.js'));
  assert.equal(Z.norm('Libertà Righi'), Z.norm("Liberta' Righi"));
  assert.equal(Z.norm("Ca' Rezzonico"), "ca' rezzonico");
  assert.ok(Z.norm("Liberta' Righi").includes(Z.norm('liberta')) && Z.norm("Liberta' Righi").includes(Z.norm('libertà')));
});
