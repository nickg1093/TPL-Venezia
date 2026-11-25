// PAGINE LEGALI (/privacy, /terms) sul server vero: risposta, intestazioni di sicurezza, contatto inserito e HTML-escapato, nessun segnaposto,
// coerenza con skill.json e con il comportamento reale (nessun cookie, nessuno script), service worker che non le salva al posto dell'app.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), net = require('net');
const ROOT = path.join(__dirname, '..');
const porta = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function avvia(env) {
  const port = await porta(), base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(port), METEO: '0', ...env }, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/healthz')).ok) return { base, proc }; } catch (e) { /* non ancora pronto */ } await new Promise(r => setTimeout(r, 500)); }
  proc.kill(); throw new Error('il server non è partito');
}
test('pagine legali: 200, HTML, sicurezza, contatto e titolare inseriti con escape, nessun segnaposto', async () => {
  const { base, proc } = await avvia({ APP_CONTACT: 'privacy@example.org', APP_OWNER: 'Mario <b>Rossi</b>' });
  try {
    for (const p of ['/privacy', '/terms', '/privacy/', '/terms/']) {
      const r = await fetch(base + p), t = await r.text();
      assert.equal(r.status, 200, p); assert.match(r.headers.get('content-type'), /text\/html; charset=utf-8/);
      assert.match(r.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(!r.headers.get('set-cookie'), 'nessun cookie');
      assert.doesNotMatch(t, /\{\{|<script/i); assert.match(t, /<meta name="viewport"/);
      assert.match(t, /mailto:privacy@example\.org/); assert.match(t, /Mario &lt;b&gt;Rossi&lt;\/b&gt;/); assert.doesNotMatch(t, /Mario <b>Rossi/);
    }
    assert.match(await (await fetch(base + '/privacy')).text(), /Informativa privacy/); assert.match(await (await fetch(base + '/terms')).text(), /Condizioni d'uso/);
    assert.equal((await fetch(base + '/privacy.html')).status, 404, 'un solo indirizzo per pagina');
    const gz = await fetch(base + '/privacy', { headers: { 'Accept-Encoding': 'gzip' } }); assert.equal(gz.status, 200);
  } finally { proc.kill(); }
});
test('pagine legali senza APP_OWNER/APP_CONTACT: nessun nome inventato', async () => {
  const { base, proc } = await avvia({ APP_CONTACT: '', APP_OWNER: '' });
  try { const t = await (await fetch(base + '/privacy')).text(); assert.match(t, /scheda «Informazioni»/); assert.doesNotMatch(t, /mailto:/); } finally { proc.kill(); }
});
test('skill.json punta alle pagine, link incrociati e service worker coerenti', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'alexa/skill-package/skill.json'), 'utf8')).manifest.privacyAndCompliance.locales['it-IT'];
  assert.equal(j.privacyPolicyUrl, 'https://veneziatpl.onrender.com/privacy'); assert.equal(j.termsOfUseUrl, 'https://veneziatpl.onrender.com/terms');
  const pr = fs.readFileSync(path.join(ROOT, 'public/privacy.html'), 'utf8'), te = fs.readFileSync(path.join(ROOT, 'public/terms.html'), 'utf8');
  for (const t of [pr, te]) { assert.doesNotMatch(t, /<script|https?:\/\/(?!www\.(amazon|garanteprivacy|openstreetmap))/); assert.match(t, /href="\/terms|href="\/privacy/); }
  assert.match(pr, /href="\/terms#fonti"/); assert.match(te, /id="fonti"/); assert.match(te, /id="redistribuzione"/);
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8'); assert.match(sw, /p === '\/privacy' \|\| p === '\/terms'/);
});
