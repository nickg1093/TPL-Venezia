// NOTIFICHE DI ARRIVO DI UNA CORSA (Web Push standard, anche con l'app chiusa).
// L'utente sceglie una corsa da una fermata e chiede di essere avvisato N minuti prima: il browser crea un'iscrizione push (endpoint del
// servizio di notifiche del telefono: Google, Mozilla, Apple, Microsoft) e la manda qui. Il server segue la corsa e invia POCHI messaggi:
//   1. conferma (silenziosa)                         "Ti avviso 5 min prima · prevista alle 13:37"
//   2. N minuti prima dell'arrivo (con suono)        "Arriva tra 5 min a Piazzale Roma"
//   3. variazioni importanti prima di (2), silenziose: ritardo cambiato di almeno 3 min, al massimo una ogni 4 min
//   4. mezzo in arrivo / alla fermata (con suono)    "In arrivo ora"
//   5. corsa soppressa o fermata saltata (con suono), poi fine
// Tutti con lo stesso "tag": ogni messaggio sostituisce il precedente nel centro notifiche (niente pile di notifiche).
// Suoni, vibrazione, "non disturbare", anteprime sulla schermata di blocco: decide il telefono secondo le impostazioni dell'utente.
// Il contenuto è cifrato per il solo dispositivo (RFC 8291, aes128gcm) e firmato con la chiave del server (VAPID, RFC 8292): i servizi di
// notifica non leggono nulla. Nessun dato personale: l'iscrizione vive in memoria fino all'arrivo della corsa (max 3 ore).
// Chiavi VAPID: variabili VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, formato della libreria web-push). Se mancano se ne crea una
// coppia all'avvio: funziona, ma dopo un riavvio le iscrizioni vanno rifatte (l'app lo fa da sola quando si riapre la corsa).
const crypto = require('crypto');

const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ---- chiavi VAPID ----
function loadVapid(env = process.env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    const pub = unb64u(env.VAPID_PUBLIC_KEY), d = unb64u(env.VAPID_PRIVATE_KEY);
    if (pub.length === 65 && pub[0] === 4 && d.length === 32) {
      const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
      return { pub, key, fromEnv: true };
    }
    console.error('push: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY non validi, uso una coppia temporanea');
  }
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), j = privateKey.export({ format: 'jwk' });
  return { pub: Buffer.concat([Buffer.from([4]), unb64u(j.x), unb64u(j.y)]), key: privateKey, fromEnv: false, privB64: j.d };
}

// ---- cifratura del messaggio (RFC 8291) ----
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
function encrypt(payload, p256dh, auth, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  if (ua.length !== 65 || secret.length < 16) throw new Error('chiavi dell\'iscrizione non valide');
  const as = ecdh || crypto.createECDH('prime256v1'); if (!ecdh) as.generateKeys();
  const asPub = as.getPublicKey(), shared = as.computeSecret(ua);
  const ikm = hmac(hmac(secret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = 65;
  return Buffer.concat([head, asPub, body]);
}

// ---- firma VAPID (JWT ES256) ----
function vapidAuth(vapid, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const data = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' + b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(data), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${b64u(vapid.pub)}`;
}

// solo servizi di notifica noti, in HTTPS (niente richieste del server verso indirizzi scelti da chi chiama)
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.api\.chrome\.com$/];
function validSub(s) {
  try {
    const u = new URL(s.endpoint);
    if (u.protocol !== 'https:' || !PUSH_HOSTS.some(re => re.test(u.hostname)) || s.endpoint.length > 1000) return false;
    return unb64u(s.keys?.p256dh).length === 65 && unb64u(s.keys?.auth).length >= 16;
  } catch { return false; }
}

module.exports = { b64u, unb64u, loadVapid, encrypt, vapidAuth, validSub, PUSH_HOSTS };
