// ARCHIVIO DELLE COMUNICAZIONI E ACQUISIZIONE AUTOMATICA (avvisi-archivio.js, scripts/archivia-avvisi.js).
// Le fonti sono simulate (fetch sostituito) con testi reali di tests/avvisi-corpus.json; l'HTML della risposta Telegram è quello reale del messaggio 11865.
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const A = require('../avvisi'), AR = require('../avvisi-archivio'), S = require('../scripts/archivia-avvisi');
const C = require('./avvisi-corpus.json');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'archivio-'));
const tgOf = n => C.tg.find(m => m.id === n);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tgHtml = msgs => msgs.map(m => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="muoversivenezia/${m.id}">`
  + `<div class="tgme_widget_message_text js-message_text" dir="auto">${esc(m.text).replace(/\n/g, '<br/>')}</div><div class="tgme_widget_message_footer compact js-message_footer">`
  + `<a class="tgme_widget_message_date" href="https://t.me/muoversivenezia/${m.id}"><time datetime="${new Date(m.pubMs).toISOString()}" class="time">x</time></a></div></div></div>`).join('\n');
const rssXml = items => `<?xml version="1.0"?><rss><channel>${items.map(r => `<item><title>${esc(r.title)}</title><link>${r.url}</link><description>${esc(r.text)}</description>`
  + `<pubDate>${new Date(r.pubMs).toUTCString()}</pubDate><guid isPermaLink="false">${r.key.slice(4)}</guid></item>`).join('')}</channel></rss>`;
// fonti simulate: { rss: [...], pages: {url: testo}, tg: [...] (tutti i messaggi; la pagina mostra gli ultimi 20, ?before=N i 20 precedenti) }
function stub(src) {
  const calls = [];
  global.fetch = async url => {
    url = String(url); calls.push(url);
    let body = null;
    if (/rss-news\.xml/.test(url)) body = rssXml(src.rss);
    else if (/actv\.avmspa\.it\/it\/content\//.test(url)) body = src.pages[url] != null ? `<h1>${esc(src.title?.[url] || '')}</h1><p>${esc(src.pages[url]).replace(/\n/g, '<br>')}</p><footer>x</footer>` : null;
    else if (/t\.me\/s\/muoversivenezia/.test(url)) {
      const b = /before=(\d+)/.exec(url), list = src.tg.filter(m => !b || m.id < +b[1]).sort((x, y) => x.id - y.id).slice(-20);
      body = src.replyHtml && !b ? tgHtml(list) + src.replyHtml : tgHtml(list);
    }
    if (body == null) return { ok: false, status: 404, url, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, url, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  return calls;
}
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; AR._setRecords([]); });
const quiet = async fn => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

test('archivio · righe nuove solo per testi nuovi o modificati, versioni conservate, indice con sha', () => {
  const dir = tmp(), m = tgOf(11894), now = Date.parse('2026-11-07T12:00:00Z');
  let a = AR.openDir(dir);
  assert.equal(a.add(AR.recordOf('tg', m, null, now)), 'nuova');
  assert.equal(a.add(AR.recordOf('tg', m, null, now + 1000)), null, 'stesso testo letto di nuovo: nessuna riga');
  assert.equal(a.add(AR.recordOf('tg', { ...m, text: m.text + ' (agg.)' }, null, now + 2000)), 'modificata');
  assert.ok(a.save(now)); assert.ok(!a.save(now), 'niente di nuovo: nessuna scrittura');
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'indice.json'), 'utf8'));
  assert.equal(idx.formato, 1); assert.deepEqual(idx.file.map(f => [f.nome, f.righe]), [['2026-11.jsonl', 2]]); assert.match(idx.file[0].sha, /^[0-9a-f]{16}$/);
  a = AR.openDir(dir); const e = a.recs.get('tg:11894');
  assert.deepEqual(e.versions.map(v => v.v), [1, 2]); assert.match(e.last.text, /\(agg\.\)$/);
  assert.equal(AR.mergeLines('non json\n{"id":1}\n' + JSON.stringify(e.last)).size, 1, 'righe non valide ignorate');
});

test('archivio · lettura incrementale (solo file cambiati) e archivio irraggiungibile', async () => {
  const dir = tmp(), a = AR.openDir(dir), now = Date.now();
  for (const m of C.tg.slice(0, 30)) a.add(AR.recordOf('tg', m, null, now)); a.save(now);
  assert.equal(await AR.refresh(dir), true); const n1 = AR.records().size, v1 = AR.version();
  assert.equal(n1, 30); assert.equal(await AR.refresh(dir), false, 'nessun cambiamento: nessuna rilettura'); assert.equal(AR.version(), v1);
  const b = AR.openDir(dir); for (const m of C.tg.slice(30, 40)) b.add(AR.recordOf('tg', m, null, now)); b.save(now);
  assert.equal(await AR.refresh(dir), true); assert.equal(AR.records().size, 40);
  assert.equal(await AR.refresh(path.join(dir, 'non-esiste')), false);
  assert.ok(AR.status().errore, 'errore registrato'); assert.equal(AR.records().size, 40, 'resta l\'ultima copia letta');
  process.env.AVVISI_ARCHIVIO = 'https://example.org/avvisi';
  try { assert.equal(await AR.refresh(), false); assert.match(AR.status().errore, /non ammesso/); } finally { delete process.env.AVVISI_ARCHIVIO; }
});

test('acquisizione · prima esecuzione con recupero delle pagine Telegram precedenti, poi solo novità (idempotente)', async () => {
  const dir = tmp(), rss = C.rss.slice(0, 5), pages = Object.fromEntries(rss.map(r => [r.url, C.pages[r.url]]).filter(([, t]) => t));
  const src = { rss, pages, tg: C.tg.filter(m => m.id <= 11896) };
  const calls = stub(src);
  const r1 = await quiet(() => S.main(dir, undefined, { pausa: 0 })); const a1 = AR.openDir(dir);
  assert.ok(r1.saved); assert.ok(calls.some(u => /before=/.test(u)), 'archivio vuoto: lette le pagine precedenti');
  const tgKeys = [...a1.recs.keys()].filter(k => k.startsWith('tg:'));
  assert.ok(tgKeys.length > 60, `messaggi recuperati: ${tgKeys.length}`);
  assert.equal([...a1.recs.keys()].filter(k => k.startsWith('rss:')).length, 5);
  assert.ok(a1.recs.get(rss[0].key).last.page, 'testo della pagina ACTV archiviato (solo testo)');
  assert.ok(!/<[a-z]/i.test(fs.readFileSync(path.join(dir, 'comunicazioni', '2026-11.jsonl'), 'utf8')), 'nessun HTML nell\'archivio');
  stub(src); const r2 = await quiet(() => S.main(dir, undefined, { pausa: 0 }));
  assert.deepEqual([r2.saved, r2.nuove, r2.modificate], [false, 0, 0], 'seconda esecuzione: nessuna riga nuova');
  // nuovo messaggio e messaggio modificato da ACTV
  const nuovo = { key: 'tg:11897', id: 11897, text: 'Linea T1 regolare in entrambe le direzioni', links: [], pubMs: Date.parse('2026-11-07T16:00:00Z'), url: 'https://t.me/muoversivenezia/11897' };
  const mod = { ...tgOf(11896), text: tgOf(11896).text + '\nAGGIORNAMENTO' };
  stub({ ...src, tg: [...src.tg.filter(m => m.id !== 11896), mod, nuovo] }); const r3 = await quiet(() => S.main(dir, undefined, { pausa: 0 }));
  assert.deepEqual([r3.saved, r3.nuove, r3.modificate], [true, 1, 1]);
  const a3 = AR.openDir(dir); assert.deepEqual(a3.recs.get('tg:11896').versions.map(v => v.v), [1, 2]);
});

test('acquisizione · fonti non raggiungibili: niente cancellato, nessuna scrittura', async () => {
  const dir = tmp(); stub({ rss: C.rss.slice(0, 3), pages: {}, tg: C.tg.slice(-20) }); await quiet(() => S.main(dir, 0, { pausa: 0 }));
  const before = AR.openDir(dir).recs.size;
  global.fetch = async url => (/t\.me/.test(String(url)) ? { ok: false, status: 503, url: String(url), arrayBuffer: async () => new ArrayBuffer(0) } : { ok: false, status: 500, url: String(url), arrayBuffer: async () => new ArrayBuffer(0) });
  const r = await quiet(() => S.main(dir, 0, { pausa: 0 }));
  assert.equal(r.saved, false); assert.equal(r.errors.length, 2); assert.equal(AR.openDir(dir).recs.size, before);
});

test('Telegram · risposta reale (11865 a 11863): testo proprio e riferimento al messaggio citato', () => {
  const html = '<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="muoversivenezia/11865">'
    + '<div class="tgme_widget_message_author accent_color"><a class="tgme_widget_message_owner_name" href="https://t.me/muoversivenezia"><span dir="auto">AVM/Actv Venezia</span></a></div>\n\n'
    + '<a class="tgme_widget_message_reply user-color-default" href="https://t.me/muoversivenezia/11863" ">\n<div class="tgme_widget_message_author accent_color">\n  <span class="tgme_widget_message_author_name" dir="auto">AVM/Actv Venezia</span>\n</div>\n'
    + '<div class="tgme_widget_message_text js-message_reply_text" dir="auto">Servizio tranviario T1 e T2 temporaneamente fermi per manifestazione. - corso del Popolo bloccato bus deviati su percorso alternativo</div>\n</a>\n'
    + '<div class="tgme_widget_message_text js-message_text" dir="auto"><i class="emoji" ><b>✅</b></i> T1 regolare</div>\n<div class="tgme_widget_message_reactions js-message_reactions"><span class="tgme_reaction"><i class="emoji" ><b>👍</b></i>2</span></div>'
    + '<div class="tgme_widget_message_footer compact js-message_footer">\n  \n  <div class="tgme_widget_message_info short js-message_info">\n    <span class="tgme_widget_message_views">3.38K</span><span class="copyonly"> views</span><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/muoversivenezia/11865"><time datetime="2026-10-30T09:00:36+00:00" class="time">09:00</time></a></span>\n  </div>\n</div>\n  </div>\n  \n</div></div>';
  const [m] = A.parseTelegram(html);
  assert.deepEqual([m.id, m.replyTo, m.text], [11865, 11863, '✅ T1 regolare']); assert.match(m.quote, /T1 e T2 temporaneamente fermi/);
  const [plain] = A.parseTelegram(tgHtml([tgOf(11894)]));
  assert.equal(plain.replyTo, undefined); assert.equal(plain.text, tgOf(11894).text);
});
