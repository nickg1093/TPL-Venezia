const test = require('node:test');
const assert = require('node:assert');
const sec = require('../security');

test('validatori: accettano codici reali, rifiutano manipolazioni', () => {
  assert.deepEqual(sec.vFullId('aut:AUT_ACTV_793_44025', ['nav', 'aut']), ['aut', 'AUT_ACTV_793_44025']);
  for (const x of ['__proto__:x', 'aut:', 'aut:../../etc/passwd', 'aut:a b', 'aut:<script>', 'zzz:1', ':1', 'aut:' + 'a'.repeat(200), null, 5])
    assert.equal(sec.vFullId(x, ['nav', 'aut']), null, String(x));
  assert.equal(sec.vSecs('3600'), 3600); assert.equal(sec.vSecs('-1'), false); assert.equal(sec.vSecs('1e9'), false); assert.equal(sec.vSecs(null), null);
  assert.equal(sec.vDate('20261028'), '20261028'); assert.equal(sec.vDate('20261332'), false); assert.equal(sec.vDate('2026-10-28'), false);
});
test('token: senza segreto (o troppo corto) l\'endpoint resta chiuso; con segreto confronto esatto', () => {
  const req = t => ({ headers: t ? { authorization: 'Bearer ' + t } : {} });
  assert.equal(sec.tokenOk(req('qualsiasi'), ''), false);
  assert.equal(sec.tokenOk(req('corto'), 'corto'), false);
  const S = 'un-segreto-abbastanza-lungo';
  assert.equal(sec.tokenOk(req(S), S), true); assert.equal(sec.tokenOk(req(S + 'x'), S), false); assert.equal(sec.tokenOk(req(), S), false);
});
test('limite di frequenza: dopo la soglia risponde con i secondi da attendere', () => {
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.9' } };
  let blocked = 0; for (let i = 0; i < sec.LIMITS.admin + 3; i++) if (sec.limit(req, 'admin')) blocked++;
  assert.equal(blocked, 3);
});
test('limite SSE per IP', () => {
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.50' } }, rel = [];
  for (let i = 0; i < 10; i++) rel.push(sec.sseAcquire(req));
  assert.ok(rel.every(Boolean)); assert.equal(sec.sseAcquire(req), null);
  rel[0](); assert.ok(sec.sseAcquire(req));
});
test('la CSP vieta script in linea e frame esterni', () => {
  assert.match(sec.CSP, /script-src 'self'(;|$)/); assert.doesNotMatch(sec.CSP, /script-src[^;]*unsafe/); assert.match(sec.CSP, /frame-ancestors 'none'/);
});
