// ERRORI DI LETTURA DEL TEMPO REALE (live.js): un timeout isolato di ACTV non deve accendere il banner rosso se i dati sono freschi;
// dopo 3 errori di fila (o dati vecchi di oltre 45 s) sì, in italiano; alla prima lettura riuscita l'errore sparisce anche se ACTV dice «304».
const test = require('node:test');
const assert = require('node:assert/strict');
const live = require('../live');
test('timeout isolato nascosto, errori ripetuti mostrati in italiano, cancellati alla lettura riuscita (anche 304)', async () => {
  const orig = global.fetch, s = live.S.nav;
  try {
    global.fetch = async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
    s.errCount = 0; s.goodAt = Date.now(); s.error = null;
    await live.refresh('nav');
    assert.equal(s.error, null, 'un solo timeout con dati freschi: nessun banner'); assert.match(s.lastError, /ACTV non risponde/);
    await live.refresh('nav'); assert.equal(s.error, null);
    await live.refresh('nav'); assert.match(s.error, /^nav: ACTV non risponde \(tempo scaduto\)$/, 'terzo errore di fila: banner');
    s.errCount = 0; s.error = null; s.goodAt = Date.now() - 60e3;
    await live.refresh('nav'); assert.match(s.error, /ACTV non risponde/, 'dati vecchi di oltre 45 s: banner subito');
    // ACTV torna e risponde «nessun dato nuovo» (304): l'errore si cancella
    for (const n of ['vehiclePositions', 'tripUpdates']) s.cache[n] = { etag: '"x"', ents: [], headerTs: null };
    global.fetch = async () => new Response(null, { status: 304 });
    s.vehicles = [{ id: 'nav:1' }]; s.updated = Date.now(); s.sim = false;
    await live.refresh('nav');
    assert.equal(s.error, null); assert.equal(s.errCount, 0);
  } finally { global.fetch = orig; s.vehicles = []; s.error = null; s.errCount = 0; }
});
