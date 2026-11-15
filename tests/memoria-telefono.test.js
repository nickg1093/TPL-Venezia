// MEMORIA DEL TELEFONO RILETTA ALL'APERTURA: avvisi attivi (notify.js), preferiti (fav.js), viaggio in corso e «I miei viaggi» (viaggio.js).
// Difetto trovato il 15/11/2026: dalla v24 gli avvisi attivi non si rileggevano mai (la lettura avveniva prima di definire una funzione usata
// per controllarli, l'errore era assorbito e la lista ripartiva vuota). Qui ogni modulo si carica con la memoria già piena, come all'apertura.
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');

async function apri(mem) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const f of ['util.js', 'notify.js', 'fav.js', 'viaggio.js']) fs.copyFileSync(path.join(__dirname, '..', 'public', 'js', f), path.join(dir, f));
  const M = new Map(Object.entries(mem));
  globalThis.localStorage = { getItem: k => (M.has(k) ? M.get(k) : null), setItem: (k, v) => M.set(k, String(v)), removeItem: k => M.delete(k) };
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'Linux', maxTouchPoints: 0 }, configurable: true });
  globalThis.document = { hidden: true, addEventListener() {}, visibilityState: 'hidden', getElementById: () => null };
  globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.matchMedia = () => ({ matches: false });
  const imp = f => import('file://' + path.join(dir, f));
  return { N: await imp('notify.js'), F: await imp('fav.js'), V: await imp('viaggio.js') };
}

test('all\'apertura si rileggono avvisi attivi (anche del viaggio), preferiti, viaggio in corso e viaggi salvati', async () => {
  const now = Date.now(), at = h => new Date(now + h * 3600e3);
  const ymd = d => d.toISOString().slice(0, 10);
  const snap = (h, id) => ({ v: 1, id, date: ymd(at(h)), from: { kind: 'point', label: 'Casa', lat: 45.43, lon: 12.32 }, to: { kind: 'stop', id: 'aut:901', label: 'Ufficio', src: 'aut', lat: 45.47, lon: 12.21 },
    parti: '08:17', arrivi: '08:56', minuti: 39, cambi: 0, piedi: 3, leaveMs: now + h * 3600e3, arriveMs: now + h * 3600e3 + 39 * 60e3,
    legs: [{ t: 'w', min: 3, to: 'VENEZIA' }, { t: 'r', src: 'aut', trip: 'T_2', line: '2', color: null, hs: 'Mestre', n: 8, pos: null,
      da: { id: 'aut:510', name: 'VENEZIA', hm: '08:20', ms: now + h * 3600e3 + 3 * 60e3 }, a: { id: 'aut:162', name: 'Mestre', hm: '08:52', ms: now + h * 3600e3 + 35 * 60e3 } }] });
  const { N, F, V } = await apri({
    'tpl.watches': JSON.stringify([
      { id: 'abcdefgh12', token: 'tokentokentoken12', mode: 'push', trip: 'aut:T_2', stop: 'aut:510', stopName: 'VENEZIA', lead: 5, line: '2', headsign: 'Mestre', until: now + 3600e3 },
      { id: 'viaggio001', token: 'tokentokentoken13', mode: 'poll', trip: 'aut:T_2', stop: 'aut:162', stopName: 'Mestre', lead: 2, line: '2', headsign: 'Mestre', until: now + 3600e3, ruolo: 'scendi', viaggio: 'viaggioABC', walk: 0 },
      { id: 'scadutoxx1', token: 'tokentokentoken14', mode: 'push', trip: 'aut:X', stop: 'aut:1', lead: 5, until: now - 1000 }]),
    'tpl.favorites': JSON.stringify({ v: 1, items: [{ k: 'stop:aut:510', name: 'VENEZIA', src: 'aut', at: 1 }] }),
    'tpl.viaggio': JSON.stringify({ ...snap(0.2, 'oggi'), started: now, viaggio: 'viaggioABC', notif: 'ok', mode: 'poll' }),
    'tpl.viaggi': JSON.stringify([snap(30, 'domani')])
  });
  assert.equal(N.all().length, 1, 'avviso singolo riletto (lo scaduto no)');
  assert.equal(N.ofJourney('viaggioABC').length, 1, 'avviso del viaggio riletto');
  assert.ok(N.find('aut:T_2', 'aut:510'), 'campanella accesa dopo la riapertura');
  assert.equal(F.all().length, 1, 'preferito riletto');
  assert.ok(V.active() && V.active().viaggio === 'viaggioABC', 'viaggio in corso riletto');
  assert.equal(V.savedList().length, 1, 'viaggio salvato riletto');
});
