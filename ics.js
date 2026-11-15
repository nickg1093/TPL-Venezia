// FILE PER IL CALENDARIO (.ics) di un viaggio del pianificatore: /api/ics?v=<dati>[&dl=1]
// Il server non salva niente: riceve titolo, descrizione, inizio, fine e link (dal telefono, codificati in base64url) e restituisce il file.
// Serve un indirizzo vero perché su iPhone/iPad Safari (anche nell'app installata) apre un .ics da un indirizzo con «Aggiungi al calendario»,
// mentre un file creato nella pagina spesso non si apre. dl=1: scaricamento (computer, Android); senza: apertura diretta (iPhone, iPad).
// Ogni campo è controllato (tipo, lunghezza, caratteri, date plausibili); il testo diventa testo del calendario con gli escape previsti (RFC 5545).
const MAX_V = 4000, DAY = 864e5;
const icsEsc = v => String(v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// righe al massimo di 75 ottetti (UTF-8), continuazione con uno spazio, senza spezzare i caratteri
function fold(line) {
  const out = []; let cur = '', n = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (n + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; n = 0; }
    cur += ch; n += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const clean = (s, n, nl = false) => (typeof s === 'string' ? s.replace(nl ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');

// v (base64url di JSON { t, d, s, e, u }) -> { title, desc, start, end, link } oppure null
function parse(v, now = Date.now()) {
  if (typeof v !== 'string' || !v || v.length > MAX_V || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  let o; try { o = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const title = clean(o.t, 160).trim(), desc = clean(o.d, 2500, true), start = o.s, end = o.e;
  if (!title || !Number.isInteger(start) || !Number.isInteger(end) || end <= start || end - start > 12 * 3600e3 || start < now - DAY || start > now + 400 * DAY) return null;
  const link = typeof o.u === 'string' && /^\/\?[\x21-\x7e]{1,400}$/.test(o.u) && !/[<>"'\\]/.test(o.u) ? o.u : null;
  return { title, desc, start, end, link };
}
function build({ title, desc, start, end, link }, origin, now = Date.now()) {
  const url = link && origin ? origin + link : null;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Venezia TPL live//Percorso//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${start}-${require('crypto').createHash('sha1').update(title + start).digest('hex').slice(0, 16)}@veneziatpl`, `DTSTAMP:${icsTime(now)}`, `DTSTART:${icsTime(start)}`, `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsEsc(title)}`, `DESCRIPTION:${icsEsc(desc + (url ? '\n' + url : ''))}`, ...(url ? [`URL:${url}`] : []),
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc('Tra 10 minuti: ' + title)}`, 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'];
  return lines.map(fold).join('\r\n') + '\r\n';
}
// nome del file: viaggio-AAAAMMGG-HHMM.ics (ora di Venezia)
function fileName(start) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(start)).map(x => [x.type, x.value]));
  return `viaggio-${p.year}${p.month}${p.day}-${p.hour}${p.minute}.ics`;
}
module.exports = { parse, build, fileName, fold };
