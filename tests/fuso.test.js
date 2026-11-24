// v34: ora e data di Venezia anche con il telefono su un altro fuso orario (gli orari ACTV sono sempre di Venezia).
const test = require('node:test'), assert = require('node:assert'), path = require('path'), { pathToFileURL } = require('url');

test('ora di Venezia con il telefono a New York: orologio, data, «hh:mm», cambio di giorno e ora legale', async () => {
  const prima = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    const U = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'util.js')).href);
    assert.equal(new Date(Date.UTC(2026, 10, 24, 23, 30)).getHours(), 18, 'il processo è davvero su New York');
    assert.deepEqual(U.romeP(Date.UTC(2026, 10, 24, 23, 30)), { y: 2026, mo: 11, d: 25, h: 0, mi: 30, s: 0, iso: '2026-11-25' }, 'mezzanotte e mezza a Venezia: già il 25');
    assert.equal(U.romeP(Date.UTC(2026, 6, 1, 22, 0)).h, 0, 'luglio: ora legale (UTC+2)');
    assert.equal(U.hm(Date.UTC(2026, 10, 24, 7, 20)), '08:20');
    assert.match(U.localDate(), /^\d{4}-\d{2}-\d{2}$/);
    const r = U.romeP(), s = U.nowSecs(); assert.ok(Math.abs(s - (r.h * 3600 + r.mi * 60 + r.s)) <= 1);
  } finally { if (prima === undefined) delete process.env.TZ; else process.env.TZ = prima; }
});
