'use strict';
// PICCOLE UTILITÀ COMUNI ai gestori della skill.
const P = require('./parlato');

// errore dell'API interna -> frase onesta (mai testi tecnici)
function erroreParlato(e) {
  const c = e && e.code;
  if (c === 409) return 'Sto ancora caricando gli orari. Riprova tra qualche istante.';
  if (c === 503 || (e && e.busy)) return 'Il servizio è molto occupato in questo momento. Riprova tra qualche secondo.';
  if (c === 404) return 'Non trovo questa informazione nei dati disponibili.';
  if (c === 429) return 'Troppe richieste in poco tempo. Riprova tra un minuto.';
  return 'Non riesco a leggere i dati in questo momento. Riprova tra poco.';
}
// colore del testo leggibile sopra uno sfondo #RRGGBB
function coloreTesto(bg) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(bg || '')); if (!m) return '#FFFFFF';
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#101820' : '#FFFFFF';
}
const colore = c => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c).toUpperCase() : '#4A5A6A');
// secondi del giorno -> istante di «adesso» in minuti: stringa «hh:mm» a partire da un istante
const hhmmMs = (ms, tz = 'Europe/Rome') => new Intl.DateTimeFormat('it-IT', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
// età di un dato in minuti, in parole
function etaDato(ms, adesso) {
  if (!ms) return null;
  const m = Math.max(0, Math.round((adesso - ms) / 60000));
  return m;
}
// una frase che dice quanto è vecchio un dato, solo se serve (oltre `soglia` minuti)
function frasEta(ms, adesso, soglia = 5, cosa = 'I dati') {
  const m = etaDato(ms, adesso);
  if (m == null || m < soglia) return '';
  return `${cosa} risalgono a ${P.minutiParlati(m)} fa.`;
}
const unico = a => [...new Set(a)];

module.exports = { erroreParlato, coloreTesto, colore, hhmmMs, etaDato, frasEta, unico };
