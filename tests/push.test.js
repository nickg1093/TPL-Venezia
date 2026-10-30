// Notifiche di arrivo: cifratura Web Push (RFC 8291) verificata decifrando come farebbe il telefono, firma VAPID, regole dei messaggi.
const test = require('node:test'), assert = require('node:assert'), crypto = require('crypto');
const P = require('../push'), Wt = require('../watch');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

test('cifratura aes128gcm: il dispositivo decifra il messaggio', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16);
  const body = P.encrypt('{"title":"Linea 80 → Martellago"}', P.b64u(ua.getPublicKey()), P.b64u(auth));
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const ikm = hmac(hmac(auth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm), cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2); assert.equal(plain.subarray(0, -1).toString(), '{"title":"Linea 80 → Martellago"}');
});
test('firma VAPID verificabile con la chiave pubblica; chiavi da variabili d\'ambiente', () => {
  const v = P.loadVapid({}); const h = P.vapidAuth(v, 'https://fcm.googleapis.com/fcm/send/abc', 'mailto:x@y.z');
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h); const [a, b, s] = jwt.split('.');
  assert.equal(JSON.parse(P.unb64u(b)).aud, 'https://fcm.googleapis.com'); assert.deepEqual(P.unb64u(k), v.pub);
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: P.b64u(v.pub.subarray(1, 33)), y: P.b64u(v.pub.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(a + '.' + b), { key: pub, dsaEncoding: 'ieee-p1363' }, P.unb64u(s)));
  const again = P.loadVapid({ VAPID_PUBLIC_KEY: P.b64u(v.pub), VAPID_PRIVATE_KEY: v.privB64 }); assert.ok(again.fromEnv); assert.deepEqual(again.pub, v.pub);
});
test('iscrizioni: solo servizi di notifica noti in https', () => {
  const ok = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: P.b64u(Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)])), auth: P.b64u(crypto.randomBytes(16)) } };
  assert.ok(P.validSub(ok)); assert.ok(P.validSub({ ...ok, endpoint: 'https://web.push.apple.com/abc' }));
  assert.ok(!P.validSub({ ...ok, endpoint: 'https://evil.example/x' })); assert.ok(!P.validSub({ ...ok, endpoint: 'http://fcm.googleapis.com/x' })); assert.ok(!P.validSub({ ...ok, keys: { p256dh: 'x', auth: 'y' } }));
});
test('regole: conferma, aggiornamento ponderato, preavviso, arrivo, soppressione', () => {
  const now = Date.UTC(2026, 9, 30, 12, 0), w = { stop: 'aut:512', stopName: 'Piazzale Roma A7', src: 'aut', lead: 5, created: now, sent: {}, k: null, lastDelay: null, lastAt: 0 };
  const D = (mins, extra = {}, delay = 0, at = now) => ({ live: true, detected: true, trip: { line: '80', headsign: 'Martellago' },
    stops: [{ id: 'aut:512', state: 'upcoming', expMs: at + mins * 60000, delay, phase: null, ...extra }, { id: 'aut:9', state: 'upcoming' }] });
  let r = Wt.step(w, D(20), now); assert.equal(r.msg.kind, 'conf'); assert.ok(r.msg.silent); assert.equal(r.msg.title, 'Linea 80 → Martellago'); assert.ok(!/\p{Extended_Pictographic}/u.test(r.msg.title));
  assert.deepEqual(Wt.step(w, D(19, {}, 1, now + 60e3), now + 60e3), {});                                                // +1 min: nessun messaggio
  assert.deepEqual(Wt.step(w, D(18, {}, 4, now + 2 * 60e3), now + 2 * 60e3), {});                                            // +4 min ma troppo presto (min. 4 min tra aggiornamenti)
  r = Wt.step(w, D(16, {}, 4, now + 5 * 60e3), now + 5 * 60e3); assert.equal(r.msg.kind, 'update'); assert.match(r.msg.body, /ritardo 4 min/);
  r = Wt.step(w, D(5, {}, 4, now + 16 * 60e3), now + 16 * 60e3); assert.equal(r.msg.kind, 'lead'); assert.ok(!r.msg.silent); assert.match(r.msg.body, /Arriva tra 5 min a Piazzale Roma A7/);
  assert.deepEqual(Wt.step(w, D(3, {}, 4, now + 18 * 60e3), now + 18 * 60e3), {});
  r = Wt.step(w, D(1, { phase: 'approaching' }, 4, now + 20 * 60e3), now + 20 * 60e3); assert.equal(r.msg.kind, 'arrive'); assert.ok(r.end);
  const w2 = { ...w, sent: {}, k: null }; r = Wt.step(w2, { ...D(10), cancelled: true }, now); assert.equal(r.msg.kind, 'cancel'); assert.ok(r.end && !r.msg.silent);
  const w3 = { ...w, sent: {}, k: null, src: 'nav' }; r = Wt.step(w3, D(3), now); assert.equal(r.msg.kind, 'lead'); assert.ok(r.msg.ttl >= 60 && r.msg.ttl <= 900);   // già entro il preavviso: subito quello
});
