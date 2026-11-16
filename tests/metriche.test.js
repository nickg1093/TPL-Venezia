// Misure per giorno (metriche.js): persone stimate senza conservare IP, operazioni contate, cambio di giorno all'ora di Venezia.
const test = require('node:test'), assert = require('node:assert');
const m = require('../metriche');
const { EventEmitter } = require('events');
function fakeRes(code = 200) { const r = new EventEmitter(); r.statusCode = code; r.write = () => true; r.end = () => r.emit('close'); return r; }
function req(name, ip, code) { const r = fakeRes(code); m.begin(r, ip).name(name); r.end('x'); }

test('persone diverse e operazioni del giorno, senza IP in chiaro', () => {
  req('/api/percorso', '1.2.3.4'); req('/api/percorso', '1.2.3.4'); req('/api/stop', '5.6.7.8'); req('/healthz', '9.9.9.9');
  req('/api/percorso', '7.7.7.7', 429);                                  // rifiutata: non conta come operazione né come persona
  const g = m.giorni().oggi;
  assert.strictEqual(g.persone, 2);
  assert.strictEqual(g.operazioni['viaggi pianificati'], 2);
  assert.strictEqual(g.operazioni['fermate consultate'], 1);
  assert.ok(!g.richieste['/healthz']);
  assert.ok(!JSON.stringify(m.giorni()).includes('1.2.3.4'));
  const day = m._giornata();
  assert.ok(![...day.viste].some(v => v.includes('1.2.3.4')));
});

test('a mezzanotte di Venezia il giorno si chiude e restano solo i numeri', () => {
  const t = Date.parse('2030-03-10T22:30:00Z');                          // 23:30 a Venezia
  m._visita('1.1.1.1', t); m._visita('2.2.2.2', t);
  const prima = m._giornata(t);
  assert.strictEqual(prima.data, '20300310');
  m._visita('1.1.1.1', t + 3600e3);                                      // 00:30 dell'11 a Venezia
  const r = m.giorni();
  const chiuso = r.giorni.find(x => x.data === '2030-03-10');
  assert.strictEqual(chiuso.persone, 2);
  assert.ok(!('viste' in chiuso) && !('sale' in chiuso));
  assert.strictEqual(m._giornata(t + 3600e3).data, '20300311');
});
