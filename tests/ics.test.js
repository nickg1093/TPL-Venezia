// FILE PER IL CALENDARIO (ics.js, /api/ics): dati controllati, orari UTC, promemoria, righe piegate a 75 ottetti, testo con escape.
const test = require('node:test'), assert = require('node:assert');
const I = require('../ics');
const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Date.parse('2026-11-15T12:00:00Z'), S = Date.parse('2026-11-16T07:17:00Z'), E = Date.parse('2026-11-16T07:56:00Z');

test('file valido: orari UTC, promemoria 10 minuti prima, link, escape e righe piegate', () => {
  const d = I.parse(enc({ t: 'Casa → Ufficio (linea 2 alle 08:20)', d: 'Percorso: Casa → Ufficio\n08:20  Linea 2, da VENEZIA; poi a piedi\n' + 'x'.repeat(300), s: S, e: E, u: '/?da=f:aut:510&a=f:aut:901' }), NOW);
  const f = I.build(d, 'https://veneziatpl.onrender.com', NOW);
  assert.match(f, /DTSTART:20261116T071700Z\r\nDTEND:20261116T075600Z/);
  assert.match(f, /TRIGGER:-PT10M/);
  assert.match(f, /URL:https:\/\/veneziatpl\.onrender\.com\/\?da=f:aut:510&a=f:aut:901/);
  assert.ok(f.replace(/\r\n /g, '').includes('Linea 2\\, da VENEZIA\\; poi a piedi'), 'virgole e punti e virgola con escape');   // (righe ricomposte)
  assert.ok(f.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'righe al massimo di 75 ottetti');
  assert.equal(I.fileName(S), 'viaggio-20261116-0817.ics');
});

test('dati non validi: rifiutati', () => {
  assert.equal(I.parse('', NOW), null);
  assert.equal(I.parse('a'.repeat(5000), NOW), null);
  assert.equal(I.parse('%%%', NOW), null);
  assert.equal(I.parse(enc({ t: '', s: S, e: E }), NOW), null);
  assert.equal(I.parse(enc({ t: 'x', s: E, e: S }), NOW), null);                                   // fine prima dell'inizio
  assert.equal(I.parse(enc({ t: 'x', s: S, e: S + 13 * 3600e3 }), NOW), null);                    // più di 12 ore
  assert.equal(I.parse(enc({ t: 'x', s: NOW - 3 * 864e5, e: NOW - 3 * 864e5 + 6e4 }), NOW), null);   // nel passato
  assert.equal(I.parse(enc({ t: 'x', s: S, e: E, u: 'https://altro.sito/' }), NOW).link, null);   // link solo verso l'app
  assert.equal(I.parse(enc({ t: 'x', s: S, e: E, u: '/?a="><script>' }), NOW).link, null);
  assert.doesNotMatch(I.build(I.parse(enc({ t: 'a\r\nBEGIN:VEVENT', s: S, e: E }), NOW), null, NOW), /\r\nBEGIN:VEVENT\r\nBEGIN/);   // niente righe iniettate
});
