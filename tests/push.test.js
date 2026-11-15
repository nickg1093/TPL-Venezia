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
  assert.deepEqual(Wt.step(w, D(5, {}, 4, now + 15.5 * 60e3), now + 15.5 * 60e3), {});                  // prima volta entro la soglia: si aspetta conferma
  r = Wt.step(w, D(5, {}, 4, now + 16 * 60e3), now + 16 * 60e3); assert.equal(r.msg.kind, 'lead'); assert.ok(!r.msg.silent); assert.match(r.msg.body, /Arriva tra 5 min a Piazzale Roma A7/);
  assert.deepEqual(Wt.step(w, D(3, {}, 4, now + 18 * 60e3), now + 18 * 60e3), {});
  r = Wt.step(w, D(1, { phase: 'approaching' }, 4, now + 20 * 60e3), now + 20 * 60e3); assert.equal(r.msg.kind, 'arrive'); assert.ok(r.end);
  const w2 = { ...w, sent: {}, k: null }; r = Wt.step(w2, { ...D(10), cancelled: true }, now, '14:40'); assert.equal(r.msg.kind, 'cancel'); assert.ok(r.end && !r.msg.silent); assert.match(r.msg.body, /Prossima corsa della linea 80: alle 14:40/);
  const w3 = { ...w, sent: {}, k: null, src: 'nav' }; r = Wt.step(w3, D(3), now); assert.equal(r.msg.kind, 'lead'); assert.ok(r.msg.ttl >= 60 && r.msg.ttl <= 900);   // già entro il preavviso: subito quello
});
test('dati del mezzo non aggiornati (stima senza dati): un solo messaggio, nessun preavviso né «in arrivo» su un orario vecchio', () => {
  const now = Date.UTC(2026, 10, 6, 17, 0), w = { stop: 'nav:5050', stopName: 'Fondamente Nove', src: 'nav', lead: 5, created: now, sent: { conf: true }, k: null, lastDelay: 4, lastAt: now };
  const D = (mins, stale, at) => ({ live: true, detected: true, stale, trip: { line: '4.1', headsign: 'Murano' },
    stops: [{ id: 'nav:5050', state: 'upcoming', expMs: at + mins * 60000, delay: 4, phase: null }, { id: 'nav:9', state: 'upcoming' }] });
  let r = Wt.step(w, D(2, { why: 'nodata', min: 11 }, now), now);
  assert.equal(r.msg.kind, 'update'); assert.match(r.msg.body, /non aggiornati da 11 min/);
  assert.deepEqual(Wt.step(w, D(-1, { why: 'nodata', min: 14 }, now + 3 * 60e3), now + 3 * 60e3), {}, 'orario vecchio passato: niente «in arrivo»');
  r = Wt.step(w, D(1, null, now + 5 * 60e3), now + 5 * 60e3);                     // tornano i dati: l'avviso riprende
  assert.equal(r.msg.kind, 'arrive');
  // mezzo fermo col GPS fresco: il dato è vero, l'avviso funziona come sempre
  const w2 = { ...w, sent: { conf: true }, k: null };
  assert.equal(Wt.step(w2, D(1, { why: 'fermo', min: 12 }, now), now).msg.kind, 'arrive');
});

test('mittente delle notifiche (VAPID «sub»): indirizzo valido o niente (Apple rifiuta quelli finti con 403)', () => {
  const { subjectFrom } = require('../push');
  assert.strictEqual(subjectFrom({}), null);
  assert.strictEqual(subjectFrom({ PUSH_CONTACT: 'mailto:noreply@example.invalid' }), null);
  assert.strictEqual(subjectFrom({ APP_CONTACT: 'nome@gmail.com' }), 'mailto:nome@gmail.com');
  assert.strictEqual(subjectFrom({ RENDER_EXTERNAL_URL: 'https://veneziatpl.onrender.com/', APP_CONTACT: 'a@b.it' }), 'https://veneziatpl.onrender.com');
  assert.strictEqual(subjectFrom({ PUSH_CONTACT: 'mailto:io@esempio.it', RENDER_EXTERNAL_URL: 'https://x.onrender.com' }), 'mailto:io@esempio.it');
});

test('viaggio guidato: testi per «esci», «cambio», «scendi»; una conferma sola; titolo «In viaggio»', () => {
  const now = Date.UTC(2026, 10, 15, 12, 0), base = { stop: 'aut:512', stopName: 'Piazzale Roma A7', src: 'aut', created: now, k: null, lastDelay: null, lastAt: 0 };
  const D = (mins, extra = {}, at = now) => ({ live: true, detected: true, trip: { line: '2', headsign: 'Lido' }, stops: [{ id: 'aut:512', state: 'upcoming', expMs: at + mins * 60000, delay: 0, phase: null, ...extra }, { id: 'aut:9', state: 'upcoming' }] });
  const esci = { ...base, ruolo: 'esci', walk: 6, lead: 8, sent: {} };
  let r = Wt.step(esci, D(20), now); assert.equal(r.msg.kind, 'conf'); assert.match(r.msg.body, /Viaggio iniziato: ti avviso quando uscire/); assert.match(r.msg.title, /^In viaggio · linea 2/);
  Wt.step(esci, D(8, {}, now + 12 * 60e3), now + 12 * 60e3);
  r = Wt.step(esci, D(7, {}, now + 13 * 60e3), now + 13 * 60e3); assert.equal(r.msg.kind, 'lead'); assert.match(r.msg.body, /^Esci ora: la linea 2 passa da Piazzale Roma A7 tra 7 min \(a piedi 6 min\)\./);
  const cambio = { ...base, ruolo: 'cambio', walk: 2, lead: 5, sent: {} };
  assert.deepEqual(Wt.step(cambio, D(20), now), {}, 'nessuna seconda conferma');
  Wt.step(cambio, D(4, {}, now + 16 * 60e3), now + 16 * 60e3); r = Wt.step(cambio, D(4, {}, now + 16.5 * 60e3), now + 16.5 * 60e3);
  assert.match(r.msg.body, /^Cambio: la linea 2 passa da Piazzale Roma A7 tra 4 min/);
  const scendi = { ...base, ruolo: 'scendi', lead: 2, sent: {} };
  Wt.step(scendi, D(20), now); r = Wt.step(scendi, D(1, { phase: 'approaching' }, now + 19 * 60e3), now + 19 * 60e3);
  assert.equal(r.msg.kind, 'arrive'); assert.equal(r.msg.body, 'Scendi ora: Piazzale Roma A7.');
  assert.deepEqual(Wt.step({ ...scendi, sent: { conf: true }, k: null }, D(5, { state: 'passed' }), now), { end: true }, 'discesa già passata: nessun messaggio');
});

test('passaggio degli avvisi a una nuova istanza: firma obbligatoria e a tempo, stato completo, niente doppioni', () => {
  const Wt = require('../watch');
  const prev = process.env.VAPID_PRIVATE_KEY; process.env.VAPID_PRIVATE_KEY = 'chiave-di-prova-0123456789';
  try {
    const body = JSON.stringify({ items: [] }), ts = Date.now(), sig = Wt.handoffSig(ts, body);
    assert.ok(Wt.handoffOk(ts, body, sig), 'firma valida');
    assert.ok(!Wt.handoffOk(ts, body + ' ', sig), 'corpo cambiato');
    assert.ok(!Wt.handoffOk(ts - 5 * 60e3, body, Wt.handoffSig(ts - 5 * 60e3, body)), 'troppo vecchia');
    assert.ok(!Wt.handoffOk(ts, body, 'x'), 'firma falsa');
    delete process.env.VAPID_PRIVATE_KEY; assert.ok(!Wt.handoffOk(ts, body, sig), 'senza chiave: mai');
  } finally { if (prev == null) delete process.env.VAPID_PRIVATE_KEY; else process.env.VAPID_PRIVATE_KEY = prev; }
  const W = Wt._W; W.clear();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } };
  const it = { id: 'abcdefgh12', token: 'tokentokentoken1234', sub, src: 'aut', tid: 'T1', stop: 'aut:510', stopName: 'VENEZIA', lead: 5, ip: 'x', url: '/?apri=viaggio', style: null,
    ruolo: 'esci', viaggio: 'viaggio123', walk: 3, created: Date.now() - 60e3, sent: { conf: true, lead: true }, k: 'lead', lastDelay: null, lastAt: 0, queue: [] };
  assert.equal(Wt.importAll([it, { ...it, id: 'bad id!' }, { ...it, id: 'vecchiovecchio', created: Date.now() - 4 * 3600e3 }]), 1, 'solo quello valido e non scaduto');
  assert.equal(Wt.importAll([it]), 0, 'già presente: niente doppioni');
  const ex = Wt.exportAll(); assert.equal(ex.length, 1); assert.deepEqual([ex[0].ruolo, ex[0].viaggio, ex[0].sent.lead], ['esci', 'viaggio123', true]);
  W.clear();
});

test('ripristino dal telefono con una nuova iscrizione (notifiche riattivate): l\'avviso esistente passa alla nuova', () => {
  const Wt = require('../watch'); const W = Wt._W; W.clear();
  const old = { endpoint: 'https://fcm.googleapis.com/fcm/send/vecchia', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } }, neu = { ...old, endpoint: 'https://fcm.googleapis.com/fcm/send/nuova' };
  Wt.importAll([{ id: 'idid1234ab', token: 'tok1234567890abc', sub: old, src: 'aut', tid: 'T1', stop: 'aut:510', lead: 5, ip: 'x', created: Date.now(), sent: { conf: true } }]);
  assert.equal(Wt.restore({ id: 'idid1234ab', token: 'altrotoken12345', sub: neu }), 'diverso', 'token sbagliato: niente');
  assert.equal(W.get('idid1234ab').sub.endpoint, old.endpoint);
  assert.equal(Wt.restore({ id: 'idid1234ab', token: 'tok1234567890abc', sub: neu }), 'attivo');
  assert.equal(W.get('idid1234ab').sub.endpoint, neu.endpoint);
  W.clear();
});
