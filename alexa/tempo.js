'use strict';
// DATE E ORARI dalle risposte di Alexa (AMAZON.DATE, AMAZON.TIME), sempre nel fuso di Venezia (Europe/Rome).
const cal = require('../calendar');

const FASCE = { MO: 8 * 3600, AF: 15 * 3600, EV: 20 * 3600, NI: 23 * 3600 };
const NOME_FASCIA = { MO: 'mattina', AF: 'pomeriggio', EV: 'sera', NI: 'notte' };
const adessoRoma = ms => cal.romeParts(ms);
const hhmmDa = secs => { const s = ((Math.round(secs) % 86400) + 86400) % 86400; return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`; };

// AMAZON.TIME: «08:30», «MO», «AF», «EV», «NI» -> { secs, fascia } | null
function risolviOra(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toUpperCase();
  if (FASCE[s] != null) return { secs: FASCE[s], fascia: s, nomeFascia: NOME_FASCIA[s] };
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || +m[1] > 24 || +m[2] > 59) return null;
  return { secs: (+m[1] % 24) * 3600 + +m[2] * 60, fascia: null };
}
// lunedì della settimana ISO anno-settimana
function lunediIso(anno, sett) {
  const q = new Date(Date.UTC(anno, 0, 4)), dow = q.getUTCDay() || 7;
  return cal.ymdOfDate(new Date(q.getTime() + ((sett - 1) * 7 - (dow - 1)) * 864e5));
}
// AMAZON.DATE: «2026-11-26», «2026-W48», «2026-W48-WE», «2026-11», «2026» -> { da, a, tipo } | null
function risolviData(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toUpperCase();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) { const y = m[1] + m[2] + m[3]; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return cal.isYmd(y) && cal.ymdOfDate(d) === y ? { da: y, a: y, tipo: 'giorno' } : null; }
  if ((m = /^(\d{4})-W(\d{2})-WE$/.exec(s))) { const l = lunediIso(+m[1], +m[2]); return { da: cal.addDays(l, 5), a: cal.addDays(l, 6), tipo: 'weekend' }; }
  if ((m = /^(\d{4})-W(\d{2})$/.exec(s))) { const l = lunediIso(+m[1], +m[2]); return { da: l, a: cal.addDays(l, 6), tipo: 'settimana' }; }
  if ((m = /^(\d{4})-(\d{2})$/.exec(s))) { const da = m[1] + m[2] + '01', a = cal.addDays(cal.ymdOfDate(new Date(Date.UTC(+m[1], +m[2], 1))), -1); return { da, a, tipo: 'mese' }; }
  return null;
}
// data e ora richieste -> { ymd, secs, domani, fascia }; senza data né ora = adesso (ymd/secs null: il server usa il tempo reale)
function quando({ data, ora, adesso, entro = false }) {
  const now = adessoRoma(adesso), d = risolviData(data), o = risolviOra(ora);
  if (!d && !o) return { adesso: true, ymd: now.ymd, secs: null, oggi: now.ymd };
  let ymd = d ? d.da : now.ymd, secs = o ? o.secs : (d && d.da !== now.ymd ? FASCE.MO : now.secs);
  let spostato = false;
  // un'ora già passata oggi, senza giorno detto: si intende domani («entro le nove» detto alle 10)
  if (!d && o && secs < now.secs - 3600) { ymd = cal.addDays(ymd, 1); spostato = true; }
  if (!o && d && d.da === now.ymd) return { adesso: true, ymd: now.ymd, secs: null, oggi: now.ymd };
  return { adesso: false, ymd, secs, hhmm: hhmmDa(secs), conOra: !!o, fascia: o?.fascia || null, nomeFascia: o?.nomeFascia || null, spostatoADomani: spostato, oggi: now.ymd, tipoData: d?.tipo || null, entro };
}
// un periodo (per gli avvisi): «questa settimana», «domani», «oggi»; senza data = oggi e prossimi giorni
function periodo(data, adesso, giorniDefault = 3) {
  const now = adessoRoma(adesso), d = risolviData(data);
  if (!d) return { da: now.ymd, a: cal.addDays(now.ymd, giorniDefault), tipo: 'prossimi', oggi: now.ymd };
  return { ...d, oggi: now.ymd };
}
// mezzanotte e giorno di servizio: prima delle 04:00 le corse notturne appartengono al giorno precedente (orari «24:xx» nei GTFS)
function giornoDiServizio(adesso) {
  const n = adessoRoma(adesso);
  return n.secs < 4 * 3600 ? { ymd: cal.addDays(n.ymd, -1), secs: n.secs + 86400, notte: true } : { ymd: n.ymd, secs: n.secs, notte: false };
}
const inizioMs = (ymd, secs = 0) => {   // istante (ms) di un giorno e secondo di Roma, con ora legale
  const guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + secs * 1000;
  const off = t => { const p = cal.romeParts(t), g = Date.UTC(+p.ymd.slice(0, 4), +p.ymd.slice(4, 6) - 1, +p.ymd.slice(6, 8)) + p.secs * 1000; return g - t; };
  return guess - off(guess - off(guess));
};

module.exports = { risolviOra, risolviData, quando, periodo, giornoDiServizio, adessoRoma, hhmmDa, inizioMs, FASCE, NOME_FASCIA };
