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
test('risposte dati (/api): intestazioni essenziali, nessun contenuto eseguibile', () => {
  const sec = require('../security'), set = {}, res = { setHeader: (k, v) => { set[k] = v; } };
  sec.securityHeaders({ url: '/api/vehicles', headers: {}, socket: {} }, res);
  assert.equal(set['Content-Security-Policy'], "default-src 'none'; frame-ancestors 'none'");
  assert.equal(set['X-Content-Type-Options'], 'nosniff'); assert.equal(set['X-Frame-Options'], 'DENY');
  const page = {}; sec.securityHeaders({ url: '/', headers: {}, socket: {} }, { setHeader: (k, v) => { page[k] = v; } });
  assert.match(page['Content-Security-Policy'], /script-src 'self'/, 'le pagine tengono la CSP completa');
});

// ---- v26: blocco progressivo, richieste contemporanee, budget di CPU, classi ----
test('v26: classi dedicate per pianificatore e flusso', () => {
  assert.strictEqual(sec.classOf('/api/percorso'), 'plan');
  assert.strictEqual(sec.classOf('/api/percorso-simili'), 'plan');
  assert.strictEqual(sec.classOf('/api/stream'), 'sse');
  assert.strictEqual(sec.classOf('/api/stop'), 'heavy');
  assert.strictEqual(sec.classOf('/api/watch/poll'), 'api');
});
test('v26: tre errori di token di fila = blocco temporaneo, poi più lungo', () => {
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.77' } }, now = Date.now();
  assert.strictEqual(sec.blocked(req, now), 0);
  sec.authFailed(req); sec.authFailed(req); assert.strictEqual(sec.blocked(req, now), 0);
  sec.authFailed(req); const b1 = sec.blocked(req, Date.now()); assert.ok(b1 > 50 && b1 <= 60, String(b1));
  for (let k = 0; k < 3; k++) sec.authFailed(req);
  assert.ok(sec.blocked(req, Date.now()) > 250, 'secondo blocco: 5 minuti');
  assert.strictEqual(sec.blocked({ headers: {}, socket: { remoteAddress: '203.0.113.78' } }), 0, 'gli altri IP non sono toccati');
});
test('v26: tetto alle richieste contemporanee per IP, liberato alla fine', () => {
  const req = { headers: {}, socket: { remoteAddress: '198.51.100.9' } }, out = [];
  for (let k = 0; k < sec.INFLIGHT_PER_IP; k++) out.push(sec.enter(req));
  assert.ok(out.every(Boolean)); assert.strictEqual(sec.enter(req), null);
  out[0](); out[0](); assert.ok(sec.enter(req), 'liberata una sola volta, poi di nuovo ammessa');
});
test('v26: budget di CPU del pianificatore', () => {
  const t = Date.now() + 1e6;                                                       // finestra futura, isolata dalle altre prove
  assert.strictEqual(sec.cpuBusy(t), false);
  for (let k = 0; k < 60; k++) sec.cpuSpent(100, t);
  assert.strictEqual(sec.cpuBusy(t), true);
  assert.strictEqual(sec.cpuBusy(t + 11000), false, 'dopo 10 secondi si riparte');
});
