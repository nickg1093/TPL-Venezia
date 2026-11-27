// Fonti della marea: portale del Comune bloccato (HTTP 403) -> pausa crescente e riserva ISPRA (Punta della Salute); archivio con righe ISPRA.
const test = require('node:test'), assert = require('node:assert');
const A = require('../marea-archivio');

const xml = (dt, v) => `<?xml version="1.0"?>\n<markers>\n<marker id = "99" lat = "1" long = "2" name = "CanalAncora" desc = "" dismiss="0">\n<instrument id = "1" type = "Marea" name = "OTT" desc = "" tipo_dati_id="1" unita_misura="cm">\n      <value datetime = "${dt}">\n        64\n      </value>\n    </instrument>\n  </marker>\n  <marker id = "129" lat = "45.43" long = "12.33" name = "Punta della Salute" desc = "" dismiss="0">\n<instrument id = "7" type = "Vento" name = "X" desc = "" tipo_dati_id="2" unita_misura="m/s">\n      <value datetime = "${dt}">\n        3\n      </value>\n    </instrument>\n<instrument id = "24" type = "Marea" name = "SIAP" desc = "" tipo_dati_id="1" unita_misura="cm">\n      <value datetime = "${dt}">\n        ${v}\n      </value>\n    </instrument>\n  </marker>\n</markers>`;

function fresh() { delete require.cache[require.resolve('../tide')]; return require('../tide'); }

test('ISPRA: legge Punta della Salute (marea), ora solare -> UTC; ignora le altre stazioni e strumenti', () => {
  const t = fresh(), now = Date.UTC(2026, 10, 27, 8, 0);
  const p = t.parseIspra(xml('27/11/2026 08:55:00', 68), now);              // 08:55 solari = 07:55 UTC
  assert.deepEqual(p, { id: 'I129', name: 'Punta della Salute (ISPRA)', cm: 68, ts: Date.UTC(2026, 10, 27, 7, 55), src: 'ispra' });
  assert.equal(t.parseIspra(xml('27/11/2026 08:55:00', -23), now).cm, -23);
  assert.equal(t.parseIspra('<markers></markers>', now), null);
  assert.equal(t.parseIspra(xml('27/11/2026 12:00:00', 68), now), null);     // nel futuro anche togliendo un'ora: scartato
});

test('portale bloccato: una sola richiesta, poi pausa; livello dalla riserva ISPRA e tendenza solo con dati recenti', async () => {
  const t = fresh(), real = global.fetch, now = Date.now(), calls = [];
  const solare = ms => { const d = new Date(ms + 3600e3); const z = n => String(n).padStart(2, '0'); return `${z(d.getUTCDate())}/${z(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:00`; };
  global.fetch = async url => { calls.push(String(url)); return /isprambiente/.test(url) ? { ok: true, status: 200, text: async () => xml(solare(now - 5 * 60e3), 68) } : { ok: false, status: 403 }; };
  try {
    const d = await t.getTide();
    assert.equal(d.cm, 68); assert.equal(d.station, 'Punta della Salute (ISPRA)'); assert.equal(d.stale, false);
    assert.equal(d.source.url, t.SOURCES.ispra.url); assert.equal(d.fonte.ok, true); assert.equal(d.fonte.riserva, true);
    assert.equal(calls.filter(u => /dati\.venezia/.test(u)).length, 1);      // 403: niente secondo tentativo in http:// né previsione
    assert.ok(t._B.until > now && t._B.wait === 5 * 60e3);
    await t.getJson('previsione.json').then(() => assert.fail('doveva essere in pausa'), e => assert.match(e.message, /pausa/));
    assert.equal(calls.filter(u => /dati\.venezia/.test(u)).length, 1);
  } finally { global.fetch = real; }
});

test('dato vecchio: la tendenza «osservata» non viene più mostrata', async () => {
  const t = fresh(), real = global.fetch, now = Date.now();
  global.fetch = async () => ({ ok: false, status: 503 });
  t._S.level = { id: '1025', name: 'Punta Salute Canal Grande', cm: 3, ts: now - 15 * 3600e3, src: 'cpsm', others: [] };
  t._S.levelAt = now; t._S.hist = [0, 1, 2, 3].map(k => ({ t: now - 15 * 3600e3 - (3 - k) * 5 * 60e3, cm: 50 - k * 15 }));
  try {
    const d = await t.getTide();
    assert.equal(d.stale, true); assert.equal(d.trend, null);
  } finally { global.fetch = real; }
});

test('archivio: righe ISPRA valide, usate nel grafico solo se manca la stazione principale', () => {
  const t0 = Date.UTC(2026, 10, 27, 7, 55), r = A.rowFromIspra({ id: 'I129', cm: 68, ts: t0 });
  assert.deepEqual(r, { t: t0, cm: 68, st: 'I129', f: 'ispra', s: 'grezzo' });
  assert.ok(A.valid(r)); assert.ok(!A.valid({ ...r, f: 'altro' })); assert.ok(!A.valid({ ...r, st: 'X1' }));
  const m = A.merge('', [r, { t: t0, cm: 70, st: '1025', f: 'cpsm', s: 'grezzo' }, { t: t0 + 300e3, cm: 66, st: 'I129', f: 'ispra', s: 'grezzo' }]);
  assert.equal(m.added, 3);
  assert.deepEqual(A.history(A.parse(m.text), t0 + 600e3), [{ t: t0, cm: 70 }, { t: t0 + 300e3, cm: 66 }]);
});
