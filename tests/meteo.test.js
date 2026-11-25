// METEO: decodifica delle fonti (Centro Maree, vePORTO, METAR) e cicli di acquisizione indipendenti con cache RAM. Nessuna rete: fetch finto.
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../meteo-parse');
const M = require('../meteo');

const T0 = Date.UTC(2026, 10, 25, 18, 52);                 // 19:52 a Roma (ora solare = UTC+1, come il CPSM)
const cpsmData = ms => { const d = new Date(ms + 3600e3); const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`; };
const risposta = (obj, { status = 200, etag = null } = {}) => new Response(status === 304 ? null : JSON.stringify(obj), { status, headers: etag ? { ETag: etag } : {} });

// ---- decodifica ----
test('direzione del vento su 16 settori, per esteso', () => {
  const att = ['Nord', 'Nord-Nord-Est', 'Nord-Est', 'Est-Nord-Est', 'Est', 'Est-Sud-Est', 'Sud-Est', 'Sud-Sud-Est', 'Sud', 'Sud-Sud-Ovest', 'Sud-Ovest', 'Ovest-Sud-Ovest', 'Ovest', 'Ovest-Nord-Ovest', 'Nord-Ovest', 'Nord-Nord-Ovest'];
  att.forEach((n, i) => assert.equal(X.cardinale(i * 22.5).cardinale, n));
  assert.equal(X.cardinale(360).cardinale, 'Nord'); assert.equal(X.cardinale(11).cardinale, 'Nord'); assert.equal(X.cardinale(12).cardinale, 'Nord-Nord-Est');
  assert.equal(X.cardinale(-1), null); assert.equal(X.cardinale(361), null); assert.equal(X.cardinale(NaN), null);
});
test('Centro Maree: UTC+1 fisso anche d\'estate, m/s → km/h, -999 e righe fuori formato = dato assente, la riga più recente per stazione', () => {
  assert.equal(new Date(X.cpsmMs('2026-07-25 19:50:00')).toISOString(), '2026-07-25T18:50:00.000Z');
  assert.equal(X.cpsmMs('2026-02-30 10:00:00'), null);
  const v = X.parseCpsm('vento', [{ ID_stazione: '1039', data: '2026-11-25 19:45:00', valore: '70 gradi, 4 m/s, 6 m/s' }, { ID_stazione: '1039', data: '2026-11-25 19:50:00', valore: '76 gradi, 5.5 m/s, 7.6 m/s' },
    { ID_stazione: '1047', data: '2026-11-25 19:50:00', valore: '-999' }, { ID_stazione: '1029', data: '2026-11-25 19:50:00', valore: '0 gradi, 0 m/s, 0.4 m/s' }]);
  const sg = v.find(x => x.idStazione === '1039');
  assert.deepEqual([sg.stazione, sg.velocita, sg.raffica, sg.direzione.cardinale], ['San Giorgio', 19.8, 27.4, 'Est-Nord-Est']);
  assert.equal(v.find(x => x.idStazione === '1047').velocita, null);
  const calmo = v.find(x => x.idStazione === '1029'); assert.equal(calmo.calmo, true); assert.equal(calmo.direzione, null);
  const t = X.parseCpsm('temparia', [{ ID_stazione: '1026', data: '2026-11-25 19:50:00', valore: '9.4 °C' }, { ID_stazione: '1039', data: '2026-11-25 19:50:00', valore: '' }, { ID_stazione: '1021', data: '2026-11-25 19:50:00', valore: '180' }]);
  assert.deepEqual(t.map(x => [x.stazione, x.valore]), [['Palazzo Cavalli', 9.4], ['San Giorgio', null], ['Piattaforma Acqua Alta', null]]);
  assert.equal(X.parseCpsm('pressione', [{ ID_stazione: '1026', data: '2026-11-25 19:50:00', valore: '1012,3 hPa' }])[0].valore, 1012.3);
});
test('METAR: visibilità con limiti, vento calmo/variabile/raffiche/variazione, temperatura, rugiada, QNH, umidità derivata, fenomeni; TREND escluso', () => {
  const a = X.decodificaMetar('METAR LIPZ 251850Z 02009KT 9000 -RA BKN025 09/09 Q1011 TEMPO 3000 BR');
  assert.deepEqual([a.visibilita.valore, a.vento.velocita, a.vento.direzione.cardinale, a.temperatura, a.rugiada, a.umidita, a.qnh], [9000, 16.7, 'Nord-Nord-Est', 9, 9, 100, 1011]);
  assert.deepEqual(a.fenomeni.map(f => f.testo), ['pioggia debole'], 'BR del TEMPO non è un fenomeno osservato');
  const b = X.decodificaMetar('LIPZ 241200Z AUTO VRB02KT 0000 FG VV001 M01/M02 A3012');
  assert.equal(b.vento.variabile, true); assert.equal(b.vento.direzione, null);
  assert.deepEqual([b.visibilita.valore, b.visibilita.limite], [50, 'meno di']); assert.equal(b.temperatura, -1); assert.equal(b.qnh, 1020);
  const c = X.decodificaMetar('LIPZ 241200Z 00000KT CAVOK 12/05 Q1020');
  assert.equal(c.vento.calmo, true); assert.deepEqual([c.visibilita.valore, c.visibilita.limite], [10000, 'almeno']); assert.equal(c.umidita, 62);
  const d = X.decodificaMetar('LIPZ 241200Z 22015G28KT 180V250 9999 +TSRA SCT020CB 25/18 Q1008');
  assert.deepEqual([d.vento.raffica, d.vento.variazione.da.cardinale, d.vento.variazione.a.cardinale, d.fenomeni[0].testo], [51.9, 'Sud', 'Ovest-Sud-Ovest', 'temporale con pioggia forte']);
  assert.equal(X.decodificaMetar('LIPZ 241200Z /////KT //// 12/05 Q1020').vento, null, 'vento mancante: nessun valore inventato');
  assert.equal(X.decodificaMetar('KJFK 241200Z 00000KT'), null);
  const rows = [{ icaoId: 'LIPZ', obsTime: T0 / 1000 - 1800, rawOb: 'METAR LIPZ 251820Z 03010KT 6000 -RA 09/09 Q1012' }, { icaoId: 'LIPZ', obsTime: T0 / 1000 - 120, rawOb: 'METAR LIPZ 251850Z 02009KT 9000 -RA 09/09 Q1011' }];
  assert.equal(X.parseMetar(rows, T0).visibilita.valore, 9000, 'la più recente, non la prima');
});
test('vePORTO: sensore scelto per nome e tipo, il timestamp più recente; valori fuori scala = assenti', () => {
  const r = X.parseVeporto([{ nome: 'SAN SERVOLO', ultimoDato: '2026-11-25T18:40:00Z', meterDetails: [{ tipo: 'VISIBILIMETER', visibilita: 800 }] },
    { nome: 'SAN SERVOLO', ultimoDato: '2026-11-25T18:50:00Z', meterDetails: [{ tipo: 'ANEMOMETER' }, { tipo: 'VISIBILIMETER', visibilita: 650.4 }] },
    { nome: 'Sant’Andrea', ultimoDato: '2026-11-25T18:50:00Z', meterDetails: [{ tipo: 'VISIBILIMETER', visibilita: -3 }] }]);
  assert.deepEqual(r.map(x => [x.stazione, x.valore]), [['San Servolo', 650], ['Marittima', null], ["Sant'Andrea", null]]);
});

// ---- acquisizione ----
function fonteFinta() {
  const f = { temparia: [], vento: [], pressione: [], tempacqua: [], umidita: [], metar: [], veporto: [], chiamate: [], blocca: null, etag: {} };
  f.fetch = async (url, o = {}) => {
    f.chiamate.push({ url, h: o.headers || {} });
    if (f.blocca && f.blocca.test(url)) return new Promise(() => {});   // fonte che non risponde mai
    if (/\/auth$/.test(url)) return new Response('{}', { headers: { Authorization: 'Bearer e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(T0 / 1000) + 3600 })).toString('base64url') + '.x' } });
    const k = /aviationweather/.test(url) ? 'metar' : /veporto/.test(url) ? 'veporto' : /\/(\w+)\.json$/.exec(url)[1];
    const corpo = JSON.stringify(f[k]), etag = '"' + require('crypto').createHash('sha1').update(corpo).digest('hex').slice(0, 16) + '"';
    if (o.headers && o.headers['If-None-Match'] === etag) return risposta(null, { status: 304 });
    return risposta(f[k], { etag });
  };
  return f;
}
const avvia = (f, ora) => { M._reset(); M._opz({ fetch: f.fetch, adesso: () => ora.t, veporto: true, log: () => {} }); };
const feed = id => M.FEED.find(x => x.id === id);

test('ogni sensore si aggiorna da solo: nuovo orario anche a valore invariato; gli altri sensori restano com\'erano', async () => {
  const f = fonteFinta(), ora = { t: T0 }; avvia(f, ora);
  f.temparia = [{ ID_stazione: '1026', data: cpsmData(T0 - 120e3), valore: '9.4' }, { ID_stazione: '1039', data: cpsmData(T0 - 120e3), valore: '9.1' }];
  f.vento = [{ ID_stazione: '1039', data: cpsmData(T0 - 120e3), valore: '76 gradi, 5.5 m/s, 7.6 m/s' }];
  await M.controlla(feed('cpsm-temparia')); await M.controlla(feed('cpsm-vento'));
  const prima = M.misure();
  ora.t = T0 + 240e3;
  f.temparia = [{ ID_stazione: '1026', data: cpsmData(T0 + 180e3), valore: '9.4' }, { ID_stazione: '1039', data: cpsmData(T0 - 120e3), valore: '9.1' }];
  await M.controlla(feed('cpsm-temparia'));
  const dopo = M.misure();
  const pc = x => x.temparia.find(y => y.stazione === 'Palazzo Cavalli'), sg = x => x.temparia.find(y => y.stazione === 'San Giorgio');
  assert.notEqual(pc(dopo).misurato, pc(prima).misurato); assert.equal(pc(dopo).valore, 9.4);
  assert.equal(pc(dopo).acquisito, new Date(T0 + 240e3).toISOString()); assert.equal(pc(dopo).ritardoAcquisizioneS, 60);
  assert.equal(sg(dopo).acquisito, sg(prima).acquisito, 'San Giorgio senza nuova misura non cambia');
  assert.deepEqual(dopo.vento, prima.vento.map(v => ({ ...v, etaS: v.etaS + 240 })), 'il vento non è toccato da un aggiornamento della temperatura');
});
test('richieste condizionali: un secondo controllo senza novità è un 304 e non tocca la cache', async () => {
  const f = fonteFinta(), ora = { t: T0 }; avvia(f, ora);
  f.pressione = [{ ID_stazione: '1026', data: cpsmData(T0 - 60e3), valore: '1012' }];
  await M.controlla(feed('cpsm-pressione')); await M.controlla(feed('cpsm-pressione'));
  assert.ok(f.chiamate.at(-1).h['If-None-Match']); assert.equal(M.diagnosi().feed['cpsm-pressione'].nonModificati304, 1);
  assert.equal(M.misure().pressione[0].valore, 1012);
});
test('una fonte che non risponde non blocca le altre; mai due richieste sovrapposte sullo stesso feed', async () => {
  const f = fonteFinta(), ora = { t: T0 }; avvia(f, ora);
  f.blocca = /veporto/; f.umidita = [{ ID_stazione: '1026', data: cpsmData(T0 - 60e3), valore: '88 %' }];
  M.controlla(feed('veporto')); M.controlla(feed('veporto'));
  await M.controlla(feed('cpsm-umidita'));
  assert.equal(M.misure().umidita[0].valore, 88);
  assert.equal(f.chiamate.filter(c => /veporto.*meteo-station|\/auth/.test(c.url)).length, 1);
});
test('errore di una fonte: la misura precedente resta con il suo orario, poi diventa «non fresca»; attesa crescente', async () => {
  const f = fonteFinta(), ora = { t: T0 }; avvia(f, ora);
  f.tempacqua = [{ ID_stazione: '1025', data: cpsmData(T0 - 60e3), valore: '13.2' }];
  await M.controlla(feed('cpsm-tempacqua'));
  f.fetch = async () => { throw new Error('rete giù'); }; M._opz({ fetch: f.fetch });
  ora.t = T0 + 30 * 60e3; await M.controlla(feed('cpsm-tempacqua'));
  const v = M.misure().tempacqua[0];
  assert.equal(v.valore, 13.2); assert.equal(v.fresco, false); assert.equal(v.disponibile, false);
  assert.equal(M.snapshot().stato['cpsm-tempacqua'].ok, false);
  const s = M._stato.get('cpsm-tempacqua'); s.erroriConsecutivi = 3;
  assert.ok(M.attesa(feed('cpsm-tempacqua'), s, ora.t) >= 200e3);
});
test('polling adattivo: impara periodo e ritardo e torna poco prima del dato atteso; se la fonte tarda, controlla ogni 30 s', async () => {
  const f = fonteFinta(), ora = { t: T0 }; avvia(f, ora); const fd = feed('cpsm-vento');
  for (let k = 0; k < 4; k++) {
    const mis = T0 + k * 300e3; ora.t = mis + 70e3;
    f.vento = [{ ID_stazione: '1039', data: cpsmData(mis), valore: '76 gradi, 5 m/s, 7 m/s' }];
    await M.controlla(fd);
  }
  const s = M._stato.get('cpsm-vento');
  const d = M.attesa(fd, s, ora.t);                         // ultimo dato T0+15 min letto a +70 s: il prossimo è atteso a +5 min +70 s
  assert.ok(d >= 200e3 && d <= 300e3, `attesa ${d}`);
  assert.equal(M.attesa(fd, s, T0 + 900e3 + 300e3 + 80e3), 30e3);
  assert.equal(M.attesa(fd, s, T0 + 900e3 + 3 * 3600e3), fd.lento, 'fonte ferma da ore: controlli radi');
});
test('METAR e vePORTO in cache: unità, limiti, umidità derivata, token rinnovato dopo 401', async () => {
  const f = fonteFinta(), ora = { t: T0 }; avvia(f, ora);
  f.metar = [{ icaoId: 'LIPZ', obsTime: T0 / 1000 - 120, rawOb: 'METAR LIPZ 251850Z 02009KT 9999 -RA 09/08 Q1011' }];
  await M.controlla(feed('metar'));
  const m = M.misure({ fonte: 'metar' });
  assert.deepEqual([m.visibilita[0].valore, m.visibilita[0].limite, m.umidita[0].valore, m.umidita[0].derivato, m.pressione[0].tipo], [10000, 'almeno', 93, true, 'QNH']);
  assert.equal(m.vento[0].direzione.cardinale, 'Nord-Nord-Est'); assert.equal(m.metar[0].fenomeni[0].testo, 'pioggia debole');
  let n = 0; const base = f.fetch;
  M._opz({ fetch: async (url, o) => (/meteo-station/.test(url) && n++ === 0 ? new Response(null, { status: 401 }) : base(url, o)) });
  f.veporto = [{ nome: 'MARITTIMA', ultimoDato: new Date(T0 - 60e3).toISOString(), meterDetails: [{ tipo: 'VISIBILIMETER', visibilita: 420 }] }];
  await M.controlla(feed('veporto'));
  assert.equal(M.misure({ stazione: 'marittima', fonte: 'veporto' }).visibilita[0].valore, 420);
  assert.equal(f.chiamate.filter(c => /\/auth$/.test(c.url)).length, 2);
  assert.doesNotMatch(JSON.stringify(M.snapshot()) + JSON.stringify(M.diagnosi()), /Bearer|e30\./, 'nessun token esposto');
});
test('riavvio: la cache si ricostruisce da sola al primo giro, in parallelo su tutte le fonti', async () => {
  const f = fonteFinta(), ora = { t: T0 }; M._reset();
  f.temparia = [{ ID_stazione: '1026', data: cpsmData(T0 - 60e3), valore: '9' }];
  f.metar = [{ icaoId: 'LIPZ', obsTime: T0 / 1000 - 60, rawOb: 'METAR LIPZ 251850Z 02009KT 9999 09/08 Q1011' }];
  M.start({ fetch: f.fetch, adesso: () => ora.t, veporto: false, log: () => {} });
  await new Promise(r => setTimeout(r, 50));
  const s = M.snapshot();
  assert.equal(s.misure.temparia.length, 2); assert.equal(s.stato.veporto.attivo, false);
  assert.ok(f.chiamate.some(c => /aviationweather/.test(c.url)) && f.chiamate.some(c => /temparia/.test(c.url)));
  M.stop();
});
