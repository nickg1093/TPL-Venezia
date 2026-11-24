// CATENA COMPLETA DELLE NOTIFICHE (v34), isolata: iscrizione di prova con chiavi generate qui, invio intercettato (nessuna richiesta di rete,
// nessun utente vero), orologio simulato. Si controlla ciò che il telefono riceverebbe davvero: messaggio cifrato, decifrato con la chiave
// del «telefono» di prova, intestazioni (TTL, Topic, Urgency, firma VAPID), sequenza conferma → preavviso → in arrivo, soppressione,
// iscrizione revocata (410) che cancella l'avviso, viaggio guidato con il testo «Esci ora».
const test = require('node:test'), assert = require('node:assert'), crypto = require('crypto');
const P = require('../push'), Wt = require('../watch');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

function telefono() {                                   // chiavi del browser di prova (come le crea PushManager)
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/PROVA-ISOLATA-' + crypto.randomBytes(4).toString('hex'), keys: { p256dh: P.b64u(ua.getPublicKey()), auth: P.b64u(auth) } };
  const leggi = body => {
    const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const ikm = hmac(hmac(auth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
    const prk = hmac(salt, ikm), cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    return JSON.parse(plain.subarray(0, -1).toString());
  };
  return { sub, leggi };
}
const attesa = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

test('catena delle notifiche con iscrizione di prova: cifratura, intestazioni, sequenza, soppressione, iscrizione revocata', async t => {
  const T0 = Date.UTC(2026, 10, 24, 17, 0);
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: T0 });
  const inviati = [], risposta = { status: 201 };
  const veraFetch = global.fetch;
  global.fetch = async (url, o) => { inviati.push({ url, headers: o.headers, body: Buffer.from(o.body) }); return { status: risposta.status, ok: risposta.status < 300, text: async () => '' }; };
  t.after(() => { global.fetch = veraFetch; for (const k of [...Wt._W.keys()]) Wt._W.delete(k); });
  // corsa simulata: arrivo alla fermata tra 20 minuti, poi si avvicina; soppressione su richiesta
  const corsa = { eta: T0 + 20 * 60e3, cancelled: false };
  Wt.init({ tripDetail: () => ({ live: true, detected: true, cancelled: corsa.cancelled, trip: { line: '2', headsign: 'Lido' },
    stops: [{ id: 'nav:5031', state: 'upcoming', expMs: corsa.eta, delay: 0, phase: null }, { id: 'nav:9', state: 'upcoming' }] }), contact: 'prove@example.org' });

  const tel = telefono();
  const w = Wt.create({ sub: tel.sub, src: 'nav', tid: 'T1', stop: 'nav:5031', stopName: 'Piazzale Roma', lead: 5, ip: '10.0.0.1', url: '/?fermata=nav:5031' });
  await attesa();
  assert.equal(w.mode, 'push'); assert.equal(inviati.length, 1, 'conferma subito');
  let m = tel.leggi(inviati[0].body), h = inviati[0].headers;
  assert.equal(m.kind, 'conf'); assert.ok(m.silent, 'la conferma non suona'); assert.match(m.body, /Ti avviso 5 min prima dell'arrivo a Piazzale Roma/);
  assert.equal(m.tag, 'tpl-trip-' + w.id); assert.equal(m.url, '/?fermata=nav:5031');
  assert.equal(h['Content-Encoding'], 'aes128gcm'); assert.equal(h.Urgency, 'normal'); assert.match(h.Authorization, /^vapid t=.+, k=.+$/);
  assert.ok(/^[A-Za-z0-9_-]{1,32}$/.test(h.Topic), 'Topic valido: un solo messaggio in attesa per corsa');
  assert.ok(inviati.every(x => x.url === tel.sub.endpoint), 'tutto verso l\'iscrizione di prova');

  // a 6 minuti dall'arrivo ancora niente; entrando nei 5 minuti, preavviso che suona (stima stabile: due controlli di fila)
  t.mock.timers.tick(14 * 60e3); await attesa();
  assert.deepEqual(inviati.map(x => tel.leggi(x.body).kind), ['conf'], 'a 6 minuti: nessun preavviso');
  const prima = inviati.length;
  for (let i = 0; i < 6 && inviati.length === prima; i++) { t.mock.timers.tick(15000); await attesa(); }
  m = tel.leggi(inviati[inviati.length - 1].body);
  assert.ok(inviati.length > prima); assert.equal(m.kind, 'lead'); assert.ok(!m.silent); assert.match(m.body, /Arriva tra [45] min a Piazzale Roma/);
  assert.equal(inviati[inviati.length - 1].headers.Urgency, 'high');
  // all'arrivo: «in arrivo ora» e l'avviso si chiude
  t.mock.timers.tick(4 * 60e3); await attesa();
  m = tel.leggi(inviati[inviati.length - 1].body);
  assert.equal(m.kind, 'arrive'); assert.ok(!Wt._W.has(w.id), 'avviso chiuso dopo «in arrivo»');

  // soppressione: messaggio subito, che suona, TTL lungo
  corsa.eta = Date.now() + 30 * 60e3; corsa.cancelled = true;
  const tel2 = telefono();
  const w2 = Wt.create({ sub: tel2.sub, src: 'nav', tid: 'T2', stop: 'nav:5031', stopName: 'Piazzale Roma', lead: 5, ip: '10.0.0.1', url: '/' });
  await attesa();
  const ult = inviati[inviati.length - 1]; m = tel2.leggi(ult.body);
  assert.equal(m.kind, 'cancel'); assert.match(m.body, /Corsa soppressa: non passerà da Piazzale Roma/); assert.equal(ult.headers.TTL, '900'); assert.ok(!Wt._W.has(w2.id));

  // iscrizione revocata dall'utente (410): l'avviso si cancella, nessun altro invio
  corsa.cancelled = false; risposta.status = 410;
  const tel3 = telefono();
  const w3 = Wt.create({ sub: tel3.sub, src: 'nav', tid: 'T3', stop: 'nav:5031', stopName: 'Piazzale Roma', lead: 5, ip: '10.0.0.2', url: '/' });
  await attesa();
  assert.ok(!Wt._W.has(w3.id), '410: avviso rimosso');
  const n410 = inviati.filter(x => x.url === tel3.sub.endpoint).length; t.mock.timers.tick(60e3); await attesa();
  assert.equal(inviati.filter(x => x.url === tel3.sub.endpoint).length, n410, 'niente altri invii a un\'iscrizione revocata');

  // viaggio guidato: ruolo «esci» con il tempo a piedi
  risposta.status = 201; corsa.eta = Date.now() + 4 * 60e3;
  const tel4 = telefono();
  Wt.create({ sub: tel4.sub, src: 'nav', tid: 'T4', stop: 'nav:5031', stopName: 'Piazzale Roma', lead: 8, ip: '10.0.0.3', url: '/?apri=viaggio', ruolo: 'esci', viaggio: 'v1', walk: 3 });
  await attesa();
  m = tel4.leggi(inviati[inviati.length - 1].body);
  assert.equal(m.kind, 'lead'); assert.match(m.body, /^Esci ora: la linea 2 passa da Piazzale Roma tra 4 min \(a piedi 3 min\)\./);
  assert.equal(m.tag, 'tpl-viaggio-v1'); assert.match(m.title, /^In viaggio · linea 2/);
});

test('senza Web Push (iPhone senza app installata): stessi messaggi in coda per l\'app aperta, nessun invio', async t => {
  const T0 = Date.UTC(2026, 10, 24, 18, 0);
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: T0 });
  const veraFetch = global.fetch; let reti = 0;
  global.fetch = async () => { reti++; return { status: 201, ok: true, text: async () => '' }; };
  t.after(() => { global.fetch = veraFetch; for (const k of [...Wt._W.keys()]) Wt._W.delete(k); });
  Wt.init({ tripDetail: () => ({ live: true, detected: true, trip: { line: '5.1', headsign: 'Lido' }, stops: [{ id: 'nav:1', state: 'upcoming', expMs: T0 + 3 * 60e3, delay: 0 }] }) });
  const w = Wt.create({ sub: null, src: 'nav', tid: 'P1', stop: 'nav:1', stopName: 'Fondamente Nove', lead: 5, ip: '10.0.0.9', url: '/' });
  await attesa();
  assert.equal(w.mode, 'poll'); assert.equal(reti, 0, 'nessuna richiesta di rete');
  const q = Wt.poll(w.id, w.token); assert.equal(q.messages.length, 1); assert.equal(q.messages[0].kind, 'lead');
  assert.equal(Wt.poll(w.id, 'token-sbagliato-xxxxxxxx'), null, 'token sbagliato: niente');
});
