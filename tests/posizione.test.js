// Pannello della corsa: «Posizione aggiornata N secondi/minuti fa» dall'ora del rilevamento del mezzo (public/js/util.js: etaPosizione).
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
async function load() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posizione-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'js', 'util.js'), path.join(dir, 'util.js'));
  return import('file://' + path.join(dir, 'util.js'));
}
test('tempo dall\'ultima posizione: secondi, minuti, dato non recente, ora futura o assente', async () => {
  const { etaPosizione: f } = await load(), now = Date.parse('2026-11-22T10:00:00Z');
  assert.deepStrictEqual(f(now - 25e3, now), { txt: 'Posizione aggiornata 25 secondi fa', vecchio: false });
  assert.strictEqual(f(now - 1e3, now).txt, 'Posizione aggiornata 1 secondo fa');
  assert.strictEqual(f(now + 20e3, now).txt, 'Posizione aggiornata 0 secondi fa', 'orologio del mezzo un po\' avanti: zero, non negativo');
  assert.strictEqual(f(now - 61e3, now).txt, 'Posizione aggiornata 1 minuto fa');
  assert.strictEqual(f(now - 150e3, now).txt, 'Posizione aggiornata 2 minuti fa');
  assert.deepStrictEqual(f(now - 180e3, now), { txt: 'Posizione aggiornata 3 minuti fa · dato non recente', vecchio: true });
  assert.strictEqual(f(now - 30e3, now, true).vecchio, true, 'segnato vecchio dal server');
  assert.strictEqual(f(now - 2 * 3600e3, now).txt, 'Posizione aggiornata più di un\'ora fa · dato non recente');
  assert.strictEqual(f(now + 5 * 60e3, now), null, 'ora futura: non si mostra');
  assert.strictEqual(f(NaN, now), null);
  assert.ok(!/alle|meno di/.test(f(now - 10e3, now).txt), 'niente «alle hh:mm» né «meno di un minuto»');
});
