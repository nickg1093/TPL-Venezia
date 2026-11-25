// SKILL ALEXA — meteo: risposte, seguiti, misure vecchie o assenti, confronti tra stazioni, riepilogo. /api/meteo prodotto dal vero meteo.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./alexa-fixtures');
const S = require('../alexa/skill');

async function dire(meteoOpz = {}, altro = {}) {
  const amb = F.ambiente({ '/api/meteo': await F.meteo(meteoOpz), '/api/avvisi': { items: [] }, '/api/tide': F.marea(), ...altro });
  let att = {};
  const d = async (intent, slots = {}) => { const r = await S.gestisci(F.richiesta(intent, slots, { attributi: att }), amb); att = r.body.sessionAttributes || {}; return { testo: F.parlato(r), r }; };
  return d;
}

test('visibilità: sintesi dei visibilimetri della laguna; nebbia sì/no per stazione; metri e chilometri, «oltre» per i limiti', async () => {
  const d = await dire();
  assert.equal((await d('MeteoIntent', { grandezza: 'visibilità', stazione: 'laguna' })).testo, "C'è nebbia a Marittima, con seicentocinquanta metri di visibilità. A San Servolo dodici chilometri e a Sant'Andrea 3500 metri.");
  assert.equal((await d('MeteoIntent', { grandezza: 'nebbia', stazione: 'San Servolo' })).testo, "No, a San Servolo non c'è nebbia: la visibilità è di dodici chilometri.");
  assert.equal((await d('MeteoIntent', { grandezza: 'nebbia', stazione: 'Marittima' })).testo, "Sì, a Marittima c'è nebbia: visibilità seicentocinquanta metri.");
  const buona = await dire({ veporto: [['SAN SERVOLO', 15000], ['MARITTIMA', 9000], ["SANT'ANDREA", 20000]] });
  assert.equal((await buona('MeteoIntent', { grandezza: 'visibilità' })).testo, "In laguna la visibilità è buona: a Marittima nove chilometri, a San Servolo quindici chilometri e a Sant'Andrea venti chilometri.");
  const met = await dire({ metar: 'METAR LIPZ 250650Z 02009KT CAVOK 09/08 Q1011', spente: ['veporto'] });
  assert.equal((await met('MeteoIntent', { grandezza: 'visibilità' })).testo, "Non ho misure recenti dei visibilimetri in laguna. All'aeroporto Marco Polo la visibilità è di oltre dieci chilometri.");
});
test('vento: sintesi confrontabile, direzione per esteso, raffiche, stazione più ventosa; mai sigle', async () => {
  const d = await dire();
  assert.equal((await d('MeteoIntent', { grandezza: 'vento', stazione: 'Venezia' })).testo, "Vento prevalente da Est-Nord-Est, tra undici e ventitré chilometri orari nelle stazioni della laguna; raffiche fino a trentadue a Sant'Andrea.");
  assert.equal((await d('MeteoDirezioneIntent')).testo, "In laguna il vento soffia soprattutto da Est-Nord-Est; a Sant'Andrea da Nord-Est.");
  assert.equal((await d('MeteoIntent', { grandezza: 'raffiche' })).testo, "Le raffiche più forti arrivano a trentadue chilometri orari a Sant'Andrea.");
  assert.equal((await d('MeteoConfrontoIntent')).testo, "Il vento soffia più forte a Sant'Andrea: ventitré chilometri orari, raffiche fino a trentadue. Segue San Giorgio con venti.");
  const t = (await d('MeteoIntent', { grandezza: 'vento', stazione: 'San Giorgio' })).testo;
  assert.equal(t, 'A San Giorgio il vento soffia da Est-Nord-Est a venti chilometri orari, con raffiche fino a ventisette.');
  assert.doesNotMatch(t, /\b(NNE|ENE|ONO|WSW)\b/);
});
test('confronto: una stazione con misura vecchia è esclusa; calma di vento e vento variabile senza direzione inventata', async () => {
  const d = await dire({ vento: [['1039', '76 gradi, 5.5 m/s, 7.6 m/s', 3], ['1049', '50 gradi, 12 m/s, 15 m/s', 40], ['1047', '0 gradi, 0 m/s, 0.2 m/s', 3]] });
  assert.equal((await d('MeteoConfrontoIntent')).testo, 'Il vento soffia più forte a San Giorgio: venti chilometri orari, raffiche fino a ventisette. Segue Marittima con zero.');
  assert.equal((await d('MeteoIntent', { grandezza: 'vento', stazione: 'Marittima' })).testo, "A Marittima c'è calma di vento.");
  assert.equal((await d('MeteoIntent', { grandezza: 'vento', stazione: "Sant'Andrea" })).testo, "L'ultima misura del vento a Sant'Andrea è delle sette e trenta, di quaranta minuti fa: non è aggiornata.");
  const v = await dire({ metar: 'METAR LIPZ 250650Z VRB03KT 9999 09/08 Q1011' });
  assert.match((await v('MeteoIntent', { stazione: 'aeroporto' })).testo, /vento variabile a sei chilometri orari/);
  assert.equal((await v('MeteoIntent', { grandezza: 'raffiche', stazione: 'aeroporto' })).testo, "All'aeroporto Marco Polo non sono segnalate raffiche: vento a sei chilometri orari.");
});
test('temperatura, acqua, umidità, pressione; misure assenti dette come tali (mai «normale»)', async () => {
  const d = await dire();
  assert.equal((await d('MeteoIntent', { grandezza: 'temperatura' })).testo, 'A Venezia, a Palazzo Cavalli, ci sono nove gradi.');
  assert.equal((await d('MeteoIntent', { grandezza: 'acqua' })).testo, "L'acqua della laguna a Punta della Salute è a tredici gradi.");
  assert.equal((await d('MeteoIntent', { grandezza: 'umidità' })).testo, "A Venezia, a Palazzo Cavalli, l'umidità è dell'ottantotto per cento.");
  assert.equal((await d('MeteoIntent', { grandezza: 'pressione' })).testo, 'A Venezia, a Palazzo Cavalli, la pressione è di 1012 ettopascal.');
  assert.equal((await d('MeteoIntent', { grandezza: 'umidità', stazione: 'Punta della Salute' })).testo, "Non ho misure dell'umidità a Punta della Salute: quella stazione non la rileva o il dato non è disponibile.");
  const vuoto = await dire({ spente: ['cpsm-vento', 'cpsm-temparia', 'cpsm-tempacqua', 'cpsm-umidita', 'cpsm-pressione', 'veporto', 'metar'] });
  assert.equal((await vuoto('MeteoIntent', { grandezza: 'vento' })).testo, 'Non ho misure recenti del vento in questo momento.');
  assert.equal((await vuoto('MeteoIntent', { grandezza: 'meteo' })).testo, 'Non ho misure meteo recenti in questo momento.');
});
test('aeroporto (METAR): fenomeni, visibilità, vento, temperatura, umidità derivata, QNH; osservazione vecchia dichiarata', async () => {
  const d = await dire();
  assert.equal((await d('MeteoIntent', { stazione: 'aeroporto' })).testo, "All'aeroporto Marco Polo, osservazione delle sette e cinquanta: pioggia debole; visibilità nove chilometri; vento da Nord-Nord-Est a diciassette chilometri orari; nove gradi; umidità del novantatré per cento; pressione 1011 ettopascal.");
  const v = await dire({ metarFa: 150 });
  assert.match((await v('MeteoIntent', { stazione: 'aeroporto' })).testo, /^L'ultima osservazione dell'aeroporto Marco Polo è delle cinque e quaranta, di due ore e mezza fa, e non è aggiornata:/);
});
test('seguiti: «e le raffiche?», «e a Marittima?» (anche come fermata detta da sola), dato più recente', async () => {
  const d = await dire();
  await d('MeteoIntent', { grandezza: 'vento', stazione: 'San Giorgio' });
  assert.equal((await d('MeteoSeguitoIntent', { grandezza: 'raffiche' })).testo, 'A San Giorgio le raffiche arrivano a ventisette chilometri orari, con vento medio a venti chilometri orari.');
  assert.equal((await d('CorrezioneIntent', { luogo: 'Marittima' })).testo, 'A Marittima le raffiche arrivano a ventidue chilometri orari, con vento medio a quindici chilometri orari.');
  assert.equal((await d('MeteoSeguitoIntent', { stazione: 'San Servolo' })).testo, "Non ho misure del vento a San Servolo: quella stazione non la rileva o il dato non è disponibile.");
  await d('MeteoIntent', { grandezza: 'temperatura' });
  assert.equal((await d('LuogoIntent', { luogo: 'San Giorgio' })).testo, 'A San Giorgio ci sono nove gradi.');
  assert.equal((await d('MeteoRecenteIntent')).testo, 'Il dato più recente è delle otto e otto. A Marittima la visibilità è di seicentocinquanta metri: c\'è nebbia.');
});
test('riepilogo: il meteo entra solo se rilevante (nebbia o vento forte)', async () => {
  const d = await dire();
  assert.match((await d('RiepilogoIntent')).testo, /Meteo: nebbia a Marittima, seicentocinquanta metri\./);
  const calmo = await dire({ veporto: [['SAN SERVOLO', 15000], ['MARITTIMA', 9000], ["SANT'ANDREA", 20000]] });
  assert.doesNotMatch((await calmo('RiepilogoIntent')).testo, /Meteo/);
  const forte = await dire({ vento: [['1049', '220 gradi, 11 m/s, 16 m/s']], veporto: [['SAN SERVOLO', 15000]] });
  assert.match((await forte('RiepilogoIntent')).testo, /Meteo: vento forte, raffiche fino a cinquantotto chilometri orari a Sant'Andrea\./);
});
test('Echo Show: scheda meteo con valore, stazione e ora; SSML valido senza sigle', async () => {
  const d = await dire();
  const { r } = await d('MeteoIntent', { grandezza: 'vento', stazione: 'laguna' });
  assert.match(r.body.response.outputSpeech.ssml, /^<speak>.*<\/speak>$/s);
  assert.doesNotMatch(r.body.response.outputSpeech.ssml, /&(?!amp;|apos;|quot;|lt;|gt;)/);
});
