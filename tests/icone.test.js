// SIMBOLI DELL'APP (v33.4): il file dei simboli deve essere XML valido (un errore rende invisibili TUTTE le icone, v32.4 online)
// e ogni icona usata dall'app deve esistere nel file.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');
const sprite = fs.readFileSync(path.join(pub, 'icons', 'sprite.svg'), 'utf8');

test('sprite.svg: un solo documento, tutti i simboli dentro <svg>', () => {
  const body = sprite.replace(/<!--[\s\S]*?-->/g, '').trim();
  assert.match(body, /^<svg\b[^>]*>/);
  assert.ok(body.endsWith('</svg>'), 'dopo </svg> non deve esserci nulla');
  assert.strictEqual((body.match(/<\/svg>/g) || []).length, 1);
  assert.strictEqual((body.match(/<symbol\b/g) || []).length, (body.match(/<\/symbol>/g) || []).length);
  for (const m of body.matchAll(/<symbol\b[^>]*>([\s\S]*?)<\/symbol>/g)) assert.doesNotMatch(m[1], /<symbol\b/, 'simbolo non chiuso');
  // niente colori dentro i simboli: il colore viene dal testo (currentColor)
  assert.doesNotMatch(body, /<symbol\b[^>]*\b(?:fill|stroke)="#/);
});

test('ogni icona usata in pagine e script esiste in sprite.svg', () => {
  const ids = new Set([...sprite.matchAll(/<symbol id="i-([\w-]+)"/g)].map(m => m[1]));
  assert.ok(ids.has('strike') && ids.has('warn') && ids.has('ext'));
  const files = ['index.html', ...fs.readdirSync(path.join(pub, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f)];
  const missing = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(pub, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of s.matchAll(/sprite\.svg#i-([\w-]+)/g)) if (!ids.has(m[1])) missing.push(f + ': ' + m[1]);
    for (const m of s.matchAll(/\bicon\('([\w-]+)'/g)) if (!ids.has(m[1])) missing.push(f + ': ' + m[1]);
  }
  assert.deepStrictEqual(missing, []);
});
