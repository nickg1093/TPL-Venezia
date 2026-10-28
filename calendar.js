// CALENDARIO GTFS: quali servizi sono attivi in una data e quale periodo copre un feed statico.
// Unica implementazione, usata sia da schedule.js (orari, pannelli) sia da gtfsstore.js (scelta della versione del GTFS).
// Le date sono stringhe "AAAAMMGG": si confrontano come testo, senza fusi orari.
const pad = n => String(n).padStart(2, '0');
const ymdOfDate = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const dateOfYmd = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const dowOf = s => dateOfYmd(s).getUTCDay();                         // 0 = domenica
const addDays = (s, n) => ymdOfDate(new Date(+dateOfYmd(s) + n * 864e5));
const isYmd = s => /^\d{8}$/.test(s || '');

// Servizi attivi in una data: giorni della settimana + periodo di calendar.txt, poi le eccezioni di calendar_dates.txt (1 aggiunge, 2 toglie)
function activeServices(calendar, exByDate, ymd) {
  const dow = dowOf(ymd), set = new Set();
  for (const sid in calendar) { const c = calendar[sid]; if (c.days[dow] && ymd >= c.start && ymd <= c.end) set.add(sid); }
  for (const [sid, type] of exByDate?.[ymd] || []) { if (type === 1) set.add(sid); else if (type === 2) set.delete(sid); }
  return set;
}

// Primo e ultimo giorno coperti (calendario + date di eccezione)
function coverage(calendar, exByDate) {
  let min = '99999999', max = '00000000';
  for (const sid in calendar) { const c = calendar[sid]; if (c.start && c.start < min) min = c.start; if (c.end && c.end > max) max = c.end; }
  for (const d in exByDate || {}) { if (d < min) min = d; if (d > max) max = d; }
  return { min, max };
}
// Data e ora a Venezia (Europe/Rome) di un istante: il "giorno di servizio" si decide SEMPRE con questo fuso, mai con quello del server (UTC su Render)
const FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function romeParts(ms = Date.now()) {
  const o = {}; for (const x of FMT.formatToParts(new Date(ms))) o[x.type] = x.value;
  return { ymd: `${o.year}${o.month}${o.day}`, secs: +o.hour * 3600 + +o.minute * 60 + +o.second };
}
const romeYmd = ms => romeParts(ms).ymd;

module.exports = { romeParts, romeYmd, ymdOfDate, dateOfYmd, dowOf, addDays, isYmd, activeServices, coverage };
