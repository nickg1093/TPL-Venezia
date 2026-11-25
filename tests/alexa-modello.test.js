// MODELLO DI INTERAZIONE ALEXA: coerenza del file it-IT.json generato e collegamento con skill.js. Nessuna rete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const F = require('./alexa-fixtures');
const { gestisci } = require('../alexa/skill');

const FILE = path.join(__dirname, '..', 'alexa', 'skill-package', 'interactionModel'.replace('interactionModel', 'interactionModels/custom'), 'it-IT.json');
const M = JSON.parse(fs.readFileSync(FILE, 'utf8')).interactionModel.languageModel;
const BUILTIN_TIPI = new Set(['AMAZON.DATE', 'AMAZON.TIME', 'AMAZON.NUMBER', 'AMAZON.Ordinal']);

test('modello: nome di invocazione valido per Alexa (minuscole, almeno due parole, nessuna cifra)', () => {
  assert.match(M.invocationName, /^[a-zà-ù'. ]+$/);
  assert.ok(M.invocationName.split(' ').length >= 2);
  assert.doesNotMatch(M.invocationName, /\d/);
});
test('modello: ogni {slot} negli esempi è dichiarato e ogni tipo esiste; nessun esempio duplicato', () => {
  const tipi = new Set((M.types || []).map(t => t.name));
  const visti = new Map();
  for (const it of M.intents) {
    const slots = new Set((it.slots || []).map(s => s.name));
    for (const s of it.slots || []) assert.ok(tipi.has(s.type) || BUILTIN_TIPI.has(s.type), `${it.name}.${s.name}: tipo ${s.type} sconosciuto`);
    for (const smp of it.samples || []) {
      for (const m of smp.matchAll(/\{(\w+)\}/g)) assert.ok(slots.has(m[1]), `${it.name}: {${m[1]}} non dichiarato in «${smp}»`);
      const k = smp.toLowerCase();
      assert.ok(!visti.has(k), `esempio duplicato «${smp}» in ${it.name} e ${visti.get(k)}`);
      visti.set(k, it.name);
      assert.doesNotMatch(smp, /[0-9]/, `cifre in «${smp}»: Alexa vuole i numeri scritti a lettere`);
    }
  }
  assert.ok(visti.size >= 300, 'esempi insufficienti: ' + visti.size);
});
test('modello: tipi personalizzati con valori e sinonimi; fermate e linee presenti; ID unici', () => {
  const per = Object.fromEntries(M.types.map(t => [t.name, t.values]));
  for (const n of ['FERMATA', 'LINEA', 'MEZZO', 'PREFERENZA', 'MOMENTO', 'ORDINALE']) assert.ok(per[n] && per[n].length, 'manca il tipo ' + n);
  assert.ok(per.FERMATA.length > 500 && per.LINEA.length > 50);
  for (const t of M.types) {
    const ids = t.values.map(v => v.id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, 'ID duplicati in ' + t.name);
    for (const v of t.values) assert.ok(v.id && !/\s/.test(v.id), `ID con spazi o vuoto in ${t.name}: «${v.id}» (Amazon lo rifiuta)`);
    for (const v of t.values) assert.ok(v.name && v.name.value && v.name.value.length <= 140, t.name + ': valore vuoto o troppo lungo');
  }
  // Alexa accetta al massimo 50.000 valori in tutto e 100 intent
  assert.ok(M.types.reduce((n, t) => n + t.values.length, 0) < 50000);
  assert.ok(M.intents.length <= 100);
});
test('modello: gli intent di sistema richiesti da Alexa ci sono', () => {
  const nomi = new Set(M.intents.map(i => i.name));
  for (const n of ['AMAZON.CancelIntent', 'AMAZON.HelpIntent', 'AMAZON.StopIntent', 'AMAZON.NavigateHomeIntent', 'AMAZON.FallbackIntent']) assert.ok(nomi.has(n), n);
});
test('modello ↔ skill: ogni intent del modello riceve una risposta valida (mai eccezioni, mai stato diverso da 200)', async () => {
  const amb = F.ambiente({ '/api/avvisi': { updated: F.ADESSO, stale: false, items: [] }, '/api/tide': F.marea(), '/api/mose': F.mose('recesso'), '/api/zone': F.zona([F.partenza({})]) });
  for (const it of M.intents) {
    const r = await gestisci(F.richiesta(it.name, {}, { adesso: F.ADESSO }), amb);
    assert.equal(r.status, 200, it.name);
    const o = r.body.response.outputSpeech;
    assert.ok(o && /^<speak>.+<\/speak>$/s.test(o.ssml), 'voce mancante per ' + it.name);
    assert.equal(typeof r.body.response.shouldEndSession, 'boolean');
    assert.doesNotMatch(o.ssml, /undefined|null|\[object|NaN/, it.name);
  }
});
test('modello ↔ skill: un intent sconosciuto non manda in errore la skill', async () => {
  const amb = F.ambiente({});
  const r = await gestisci(F.richiesta('IntentCheNonEsiste', {}, { adesso: F.ADESSO }), amb);
  assert.equal(r.status, 200);
  assert.match(F.parlato(r), /non ho capito/i);
});
test('manifesto: esempi di frasi tratti dagli esempi del modello, categoria valida, immagini PNG delle dimensioni richieste, nessun segreto', () => {
  const dir = path.join(__dirname, '..', 'alexa', 'skill-package');
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8')).manifest, loc = man.publishingInformation.locales['it-IT'];
  assert.equal(man.publishingInformation.category, 'PUBLIC_TRANSPORTATION');
  assert.deepEqual(man.publishingInformation.distributionCountries, ['IT']);
  assert.equal(man.privacyAndCompliance.usesPersonalInfo, false); assert.equal(man.privacyAndCompliance.allowsPurchases, false);
  assert.match(loc.description, /non ufficiale/i); assert.match(loc.description, /ACTV/);
  assert.ok(loc.summary.length <= 160 && loc.examplePhrases.length >= 3);
  const campioni = M.intents.flatMap(i => (i.samples || []).map(s => new RegExp('^' + s.toLowerCase().replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '.+') + '$')));
  for (const f of loc.examplePhrases) {
    const m = /^alexa, (?:chiedi a|apri) (?:venezia t\. p\. l\.)\s*(.*)$/i.exec(f); assert.ok(m, 'forma non valida: ' + f);
    if (m[1]) assert.ok(campioni.some(r => r.test(m[1].toLowerCase())), `«${m[1]}» non corrisponde a nessun esempio del modello`);
  }
  for (const [f, n] of [['it-IT_smallIcon.png', 108], ['it-IT_largeIcon.png', 512]]) {
    const b = fs.readFileSync(path.join(dir, 'assets', f)); assert.equal(b.readUInt32BE(16), n); assert.equal(b.readUInt32BE(20), n);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'), /Bearer|token|secret|password/i);
});
