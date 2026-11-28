'use strict';
// METEO — decodifica delle fonti, senza rete (riusa le regole di Intranet-BIS: services/cpsm-meteo, visibility, metar-visibility).
//  · Centro Maree (CPSM, Open Data Comune di Venezia): vento, pressione, temperatura aria e acqua, umidità. Orari in UTC+1 FISSO (ora solare
//    tutto l'anno), feed automatici non validati: -999, campi assenti e valori fuori scala diventano null (mai inventati).
//  · vePORTO: visibilimetri di San Servolo, Marittima e Sant'Andrea (sensore VISIBILIMETER, scelto per nome e tipo, non per posizione).
//  · METAR LIPZ (aeroporto Marco Polo, NOAA AWC): visibilità prevalente, vento, raffiche, temperatura, rugiada, QNH, fenomeni, nubi.
//    Solo la parte osservativa: TREND/RMK esclusi. 9999/CAVOK = almeno 10 km, 0000 = meno di 50 m. Umidità = derivata (Magnus), non misurata.

const CARDINALI = ['Nord', 'Nord-Nord-Est', 'Nord-Est', 'Est-Nord-Est', 'Est', 'Est-Sud-Est', 'Sud-Est', 'Sud-Sud-Est',
  'Sud', 'Sud-Sud-Ovest', 'Sud-Ovest', 'Ovest-Sud-Ovest', 'Ovest', 'Ovest-Nord-Ovest', 'Nord-Ovest', 'Nord-Nord-Ovest'];
const SIGLE = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
// direzione di PROVENIENZA in gradi (convenzione meteorologica, 0/360 = da Nord) -> settore su 16
function cardinale(gradi) {
  if (typeof gradi !== 'number' || !Number.isFinite(gradi) || gradi < 0 || gradi > 360) return null;
  const i = Math.round(gradi / 22.5) % 16;
  return { gradi: Math.round(gradi), cardinale: CARDINALI[i], sigla: SIGLE[i] };
}
const KMH_MS = 3.6, KMH_KT = 1.852;
const r1 = x => Math.round(x * 10) / 10;

// «2026-11-25 19:50:00» in UTC+1 fisso -> ms; data impossibile -> null
function cpsmMs(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];
  const ms = Date.UTC(y, mo - 1, d, h - 1, mi, se), c = new Date(ms + 3600e3);
  return c.getUTCFullYear() === y && c.getUTCMonth() + 1 === mo && c.getUTCDate() === d && c.getUTCHours() === h && c.getUTCMinutes() === mi && c.getUTCSeconds() === se ? ms : null;
}
function numero(v, min, max) {
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(?:°C|°|hPa|%|m\/s|W\/mq|W\/m2)?\s*$/i.exec(String(v ?? '').replace(/[  ]/g, ' '));
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) && n !== -999 && n >= min && n <= max ? n : null;
}

// ---- CPSM ----
// nomi parlati delle stazioni (il feed ha nomi tecnici); stazioni non elencate: nome del feed
const NOMI_CPSM = { 1039: 'San Giorgio', 1029: 'Misericordia', 1047: 'Marittima', 1049: "Sant'Andrea", 1026: 'Palazzo Cavalli', 1025: 'Punta della Salute',
  1021: 'Piattaforma Acqua Alta', 1046: 'Meda Abate', 1045: 'Giudecca' };
const LIMITI = { pressione: [850, 1100], tempacqua: [-5, 45], umidita: [0, 100], temparia: [-50, 60] };
const UNITA = { vento: 'km/h', visibilita: 'm', pressione: 'hPa', tempacqua: '°C', temparia: '°C', umidita: '%', rugiada: '°C' };
// la lettura più recente di ciascuna stazione (il feed pubblica di solito una riga per stazione, l'ordine non conta)
function ultimePerStazione(rows) {
  const per = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = String(r?.ID_stazione ?? '').trim(); if (!id) continue;
    const ms = cpsmMs(r.data); const p = per.get(id);
    if (!p || (ms != null && (p.ms == null || ms > p.ms))) per.set(id, { r, ms });
  }
  return per;
}
// vento: «76 gradi, 5.5 m/s, 7.6 m/s» = direzione, media, raffica (massimo del periodo)
function ventoCpsm(valore) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:gradi|°|deg)\s*,\s*(-?\d+(?:[.,]\d+)?)\s*m\s*\/\s*s\s*(?:,\s*(-?\d+(?:[.,]\d+)?)\s*m\s*\/\s*s\s*)?$/i
    .exec(String(valore ?? '').replace(/[  ]/g, ' '));
  if (!m) return null;
  const dir = numero(m[1], 0, 360), med = numero(m[2], 0, 150), raf = m[3] != null ? numero(m[3], 0, 150) : null;
  if (med == null) return null;
  const calmo = med < 0.3;
  return { velocita: r1(med * KMH_MS), raffica: raf != null && raf >= med ? r1(raf * KMH_MS) : null, direzione: calmo ? null : cardinale(dir), calmo, variabile: false };
}
// categoria -> [{ idStazione, stazione, misuratoMs, ...valori }]
function parseCpsm(categoria, rows) {
  const out = [];
  for (const [id, { r, ms }] of ultimePerStazione(rows)) {
    const base = { idStazione: id, stazione: NOMI_CPSM[id] || String(r.stazione || r.nome_abbr || id).trim(), misuratoMs: ms };
    if (categoria === 'vento') { const v = ventoCpsm(r.valore); out.push({ ...base, ...(v || { velocita: null, raffica: null, direzione: null, calmo: false, variabile: false }), valore: v ? v.velocita : null }); }
    else { const [lo, hi] = LIMITI[categoria]; out.push({ ...base, valore: numero(r.valore, lo, hi) }); }
  }
  return out;
}

// ---- vePORTO ----
const VIS = [['SAN SERVOLO', 'San Servolo'], ['MARITTIMA', 'Marittima'], ["SANT'ANDREA", "Sant'Andrea"]];
const nomeVp = v => String(v || '').trim().toUpperCase().replace(/[’‘]/g, "'");
function parseVeporto(rows) {
  if (!Array.isArray(rows)) throw new Error('vePORTO: formato non riconosciuto');
  const t = r => { const raw=r?.ultimoDato; if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw))return -Infinity; const x=Date.parse(raw);return Number.isFinite(x)?x:-Infinity; };
  const ord = [...rows].sort((a, b) => t(b) - t(a));
  return VIS.map(([k, nome]) => {
    for (const r of ord) {
      if (nomeVp(r?.nome) !== k || !Array.isArray(r.meterDetails)) continue;
      const s = r.meterDetails.find(x => x?.tipo === 'VISIBILIMETER'); if (!s) continue;
      const v = typeof s.visibilita === 'number' && Number.isFinite(s.visibilita) && s.visibilita >= 0 && s.visibilita <= 100000 ? Math.round(s.visibilita) : null;
      return { idStazione: k, stazione: nome, misuratoMs: Number.isFinite(t(r)) ? t(r) : null, valore: v };
    }
    return { idStazione: k, stazione: nome, misuratoMs: null, valore: null };
  });
}

// ---- METAR ----
const FENOMENI = { DZ: 'pioviggine', RA: 'pioggia', SN: 'neve', SG: 'neve granulosa', IC: 'aghi di ghiaccio', PL: 'pioggia gelata', GR: 'grandine', GS: 'grandine piccola',
  UP: 'precipitazione', BR: 'foschia', FG: 'nebbia', FU: 'fumo', VA: 'cenere vulcanica', DU: 'polvere', SA: 'sabbia', HZ: 'caligine', PY: 'spruzzi',
  PO: 'mulinelli di polvere', SQ: 'groppo', FC: 'tromba d\'aria', SS: 'tempesta di sabbia', DS: 'tempesta di polvere' };
const DESCR = { MI: 'bassa', BC: 'a banchi', PR: 'parziale', DR: 'scaccianeve basso', BL: 'scaccianeve alto', SH: 'rovesci di', TS: 'temporale', FZ: 'gelata' };
function fenomeno(tok) {
  const m = /^([+-]|VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)?$/.exec(tok);
  if (!m || (!m[2] && !m[3])) return null;
  const nomi = (m[3] || '').match(/.{2}/g)?.map(x => FENOMENI[x]) || [];
  let t;
  if (m[2] === 'TS') t = nomi.length ? `temporale con ${nomi.join(' e ')}` : 'temporale';
  else if (m[2] === 'SH') t = `rovesci di ${nomi.join(' e ') || 'pioggia'}`;
  else if (m[2] === 'FZ') t = `${nomi.join(' e ')} congelantesi`;
  else if (m[2]) t = `${nomi.join(' e ')} ${DESCR[m[2]]}`.trim();
  else t = nomi.join(' e ');
  if (m[1] === '-') t += ' debole'; else if (m[1] === '+') t += ' forte'; else if (m[1] === 'VC') t += ' nelle vicinanze';
  return { codice: tok, testo: t };
}
const NUBI = { FEW: 'poche nubi', SCT: 'nubi sparse', BKN: 'molto nuvoloso', OVC: 'coperto', VV: 'cielo non visibile' };
const tempMetar = s => (s == null || s === '//' ? null : (s[0] === 'M' ? -1 : 1) * Number(s.replace('M', '')));
// umidità relativa dalla temperatura e dal punto di rugiada (Magnus–Tetens, costanti di Alduchov e Eskridge): valore derivato
function umiditaDa(t, td) {
  if (!Number.isFinite(t) || !Number.isFinite(td) || td > t + 0.5) return null;
  const e = x => Math.exp(17.625 * x / (243.04 + x));
  return Math.max(0, Math.min(100, Math.round(100 * e(Math.min(td, t)) / e(t))));
}
function decodificaMetar(raw) {
  if (typeof raw !== 'string') return null;
  const tok = raw.trim().replace(/=$/, '').split(/\s+/);
  const st = tok.indexOf('LIPZ');
  if (st < 0 || !/^\d{6}Z$/.test(tok[st + 1] || '')) return null;
  const fine = ['RMK', 'NOSIG', 'BECMG', 'TEMPO', 'PROB30', 'PROB40'].map(t => tok.indexOf(t, st + 2)).filter(p => p >= 0).reduce((a, b) => Math.min(a, b), tok.length);
  const obs = tok.slice(st + 2, fine).filter(t => t !== 'AUTO' && t !== 'COR');
  const out = { codice: tok.slice(st).join(' '), vento: null, visibilita: null, fenomeni: [], nubi: [], cavok: false, temperatura: null, rugiada: null, umidita: null, qnh: null };
  let i = obs.findIndex(t => /^(?:\d{3}|VRB|\/{3})(?:\d{2,3}|\/\/)(?:G\d{2,3})?(?:KT|MPS)$/.test(t));
  if (i >= 0) {
    const m = /^(VRB|\d{3}|\/{3})(\d{2,3}|\/\/)(?:G(\d{2,3}))?(KT|MPS)$/.exec(obs[i]), f = m[4] === 'KT' ? KMH_KT : KMH_MS;
    const vel = m[2] === '//' ? null : r1(+m[2] * f), dir = /^\d{3}$/.test(m[1]) && +m[1] <= 360 ? +m[1] : null;
    if (vel != null) {
      const calmo = vel === 0, varTok = /^(\d{3})V(\d{3})$/.exec(obs[i + 1] || '');
      out.vento = { velocita: vel, raffica: m[3] ? r1(+m[3] * f) : null, direzione: calmo || m[1] === 'VRB' ? null : cardinale(dir), calmo, variabile: m[1] === 'VRB',
        variazione: varTok ? { da: cardinale(+varTok[1]), a: cardinale(+varTok[2]) } : null, codice: obs[i] };
    }
    obs.splice(0, i + 1);
  }
  for (const t of obs) {
    if (/^\d{3}V\d{3}$/.test(t)) continue;
    if (t === 'CAVOK') { out.cavok = true; out.visibilita = out.visibilita || { valore: 10000, limite: 'almeno', codice: t }; continue; }
    if (/^\d{4}$/.test(t) && !out.visibilita) { const v = +t; out.visibilita = v === 9999 ? { valore: 10000, limite: 'almeno', codice: t } : v === 0 ? { valore: 50, limite: 'meno di', codice: t } : v >= 50 ? { valore: v, limite: null, codice: t } : null; continue; }
    let m = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU)?$/.exec(t);
    if (m) { out.nubi.push({ codice: t, testo: NUBI[m[1]] + (m[3] === 'CB' ? ' con cumulonembi' : m[3] === 'TCU' ? ' con cumuli torreggianti' : ''), quotaM: /\d/.test(m[2]) ? Math.round(+m[2] * 30.48) : null }); continue; }
    if (/^(NSC|NCD|SKC|CLR)$/.test(t)) continue;
    m = /^(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)?$/.exec(t);
    if (m) { out.temperatura = tempMetar(m[1]); out.rugiada = tempMetar(m[2] || null); continue; }
    m = /^Q(\d{4})$/.exec(t); if (m) { const q = +m[1]; out.qnh = q >= 850 && q <= 1100 ? q : null; continue; }
    m = /^A(\d{4})$/.exec(t); if (m) { const q = Math.round(+m[1] / 100 * 33.8639); out.qnh = q >= 850 && q <= 1100 ? q : null; continue; }
    if (/^R\d{2}/.test(t) || /^WS/.test(t) || /^RE/.test(t)) continue;   // pista, wind shear, fenomeni recenti: non sono condizioni attuali
    const f = fenomeno(t); if (f) out.fenomeni.push(f);
  }
  out.umidita = umiditaDa(out.temperatura, out.rugiada);
  return out;
}
function tempoMetar(v) {
  let ms;
  if (typeof v === 'number') ms = v < 1e11 ? v * 1000 : v;
  else if (typeof v === 'string' && /^\d{10,13}$/.test(v)) ms = +v < 1e11 ? +v * 1000 : +v;
  else ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}
// righe JSON di aviationweather.gov -> osservazione più recente decodificata (o null)
function parseMetar(rows, adesso = Date.now()) {
  if (!Array.isArray(rows)) throw new Error('METAR: formato non riconosciuto');
  const v = rows.filter(r => r?.icaoId === 'LIPZ' && typeof r.rawOb === 'string').map(r => ({ r, ms: tempoMetar(r.obsTime) }))
    .filter(x => x.ms != null && x.ms <= adesso + 5 * 60e3).sort((a, b) => b.ms - a.ms);
  if (!v.length) return null;
  const d = decodificaMetar(v[0].r.rawOb);
  return d ? { misuratoMs: v[0].ms, ...d } : null;
}

module.exports = { cardinale, CARDINALI, cpsmMs, numero, parseCpsm, ventoCpsm, parseVeporto, decodificaMetar, parseMetar, umiditaDa, fenomeno, UNITA, NOMI_CPSM };
