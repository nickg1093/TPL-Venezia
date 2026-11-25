'use strict';
// PARLATO: tutto ciò che trasforma dati in italiano pronunciabile (numeri, orari, linee, nomi di fermate, SSML).
// Modulo puro, senza rete né stato: si prova in tests/alexa-parlato.test.js.

const UNITA = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici', 'tredici',
  'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'];
const DECINE = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];

// numero intero in parole (0-999); oltre, cifre
function parole(n) {
  n = Math.trunc(Number(n));
  if (!Number.isFinite(n)) return '';
  if (n < 0) return 'meno ' + parole(-n);
  if (n < 20) return UNITA[n];
  if (n < 100) {
    const d = Math.floor(n / 10), u = n % 10, base = DECINE[d];
    if (!u) return base;
    return (u === 1 || u === 8 ? base.slice(0, -1) : base) + (u === 3 ? 'tré' : UNITA[u]);
  }
  if (n < 1000) {
    const c = Math.floor(n / 100), r = n % 100, cento = c === 1 ? 'cento' : UNITA[c] + 'cento';
    if (!r) return cento;
    const rp = parole(r);
    return (r < 100 && (Math.floor(r / 10) === 8 || r === 8 || (r >= 80 && r < 90)) ? cento.slice(0, -1) : cento) + rp;
  }
  return String(n);
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const speak = inner => `<speak>${inner}</speak>`;
const pausa = (ms = 350) => `<break time="${ms}ms"/>`;
// testo semplice (schede e cartoline): senza tag
// toglie i tag <…> scorrendo i caratteri (niente espressioni regolari: nessun residuo tipo «<scr<b>ipt>»)
const togliTag = s => { let o = '', dentro = false; for (const c of String(s ?? '')) { if (c === '<') dentro = true; else if (c === '>' && dentro) dentro = false; else if (!dentro) o += c; } return o; };
const ENT = { apos: "'", quot: '"', lt: '<', gt: '>', amp: '&' };
const senzaTag = s => togliTag(s).replace(/&(apos|quot|lt|gt|amp);/g, (m, n) => ENT[n]).replace(/\s+/g, ' ').trim();

// ---- orari ----
const hm = s => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? [+m[1] % 24, +m[2]] : null; };
// «08:15» -> «alle otto e quindici»; 00:00 -> «a mezzanotte»; 12:00 -> «a mezzogiorno»; 01:10 -> «all'una e dieci»
function oraParlata(s) {
  const t = hm(s); if (!t) return '';
  const [h, m] = t;
  const base = h === 0 ? 'a mezzanotte' : h === 12 ? 'a mezzogiorno' : h === 1 ? "all'una" : 'alle ' + parole(h);
  return m === 0 ? base : `${base} e ${parole(m)}`;
}
// «08:15» -> «le otto e quindici»; 00:30 -> «mezzanotte e trenta»; 01:00 -> «l'una» (senza preposizione: «entro le nove», «da mezzanotte»)
function oraSenzaPrep(s) {
  const t = hm(s); if (!t) return '';
  const [h, m] = t, base = h === 0 ? 'mezzanotte' : h === 12 ? 'mezzogiorno' : h === 1 ? "l'una" : 'le ' + parole(h);
  return m === 0 ? base : `${base} e ${parole(m)}`;
}
// «08:15» -> «dalle otto e quindici»; 01:00 -> «dall'una»; 00:10 -> «da mezzanotte e dieci»
const dalleOra = s => oraParlata(s).replace(/^alle /, 'dalle ').replace(/^all'/, "dall'").replace(/^a /, 'da ');
// «alle otto» -> «delle otto»; «all'una» -> «dell'una»; «a mezzanotte» -> «di mezzanotte»
const delleOra = s => oraParlata(s).replace(/^alle /, 'delle ').replace(/^all'/, "dell'").replace(/^a /, 'di ');
const minutiParlati = n => { n = Math.round(n); return n === 1 ? 'un minuto' : `${parole(n)} minuti`; };
// attesa: «adesso», «tra un minuto», «tra cinque minuti» (n = minuti da adesso, anche negativo)
function attesa(n) {
  if (!Number.isFinite(n)) return '';
  if (n <= 0) return 'adesso';
  if (n === 1) return 'tra un minuto';
  if (n < 60) return `tra ${parole(n)} minuti`;
  const h = Math.floor(n / 60), m = n % 60;
  return `tra ${h === 1 ? "un'ora" : parole(h) + ' ore'}${m ? ' e ' + minutiParlati(m) : ''}`;
}
// durata di un viaggio: «venti minuti», «un'ora e dieci»
function durata(min) {
  min = Math.round(min);
  if (min < 60) return minutiParlati(min);
  const h = Math.floor(min / 60), m = min % 60;
  return (h === 1 ? "un'ora" : parole(h) + ' ore') + (m ? ' e ' + parole(m) : '');
}
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const ymdDate = ymd => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
const diffGiorni = (a, b) => Math.round((ymdDate(a) - ymdDate(b)) / 864e5);
// «oggi», «domani», «dopodomani», «lunedì 30 novembre»
function giornoParlato(ymd, oggi) {
  const d = diffGiorni(ymd, oggi);
  if (d === 0) return 'oggi';
  if (d === 1) return 'domani';
  if (d === 2) return 'dopodomani';
  if (d === -1) return 'ieri';
  const dt = ymdDate(ymd);
  return `${GIORNI[dt.getUTCDay()]} ${dt.getUTCDate()} ${MESI[dt.getUTCMonth()]}`;
}

// ---- linee ----
const LETTERE = { a: 'a', b: 'bi', c: 'ci', d: 'di', e: 'e', f: 'effe', g: 'gi', h: 'acca', i: 'i', l: 'elle', m: 'emme', n: 'enne', o: 'o', p: 'pi', r: 'erre', s: 'esse', t: 'ti', u: 'u', v: 'vu', z: 'zeta' };
// «4.1» -> «quattro punto uno»; «T1» -> «ti uno»; «N» -> «enne»; «5.2» -> «cinque punto due»; «2/» -> «due barrato»; «N» -> «N»; «12E» -> «dodici E»
function lineaParlata(nome) {
  const s = String(nome ?? '').trim();
  if (!s) return '';
  const out = [];
  for (const m of s.matchAll(/(\d+)|([A-Za-z])|(\.)|(\/)/g)) {
    if (m[1]) out.push(parole(+m[1]));
    else if (m[2]) out.push(LETTERE[m[2].toLowerCase()] || m[2].toUpperCase());
    else if (m[3]) out.push('punto');
    else if (m[4]) out.push('barrato');
  }
  return out.join(' ');
}

// ---- nomi delle fermate ----
const FEMMINILI = new Set(['marta', 'maria', 'lucia', 'giustina', 'croce', 'chiara', 'caterina', 'margherita', 'agnese', 'barbara', 'marina', 'teresa', 'fosca', 'sofia']);
const VOCALE = /^[aeiouàèéìòù]/i;
const santo = p => { const k = p.toLowerCase(); return VOCALE.test(p) ? `Sant'${p}` : FEMMINILI.has(k) ? `Santa ${p}` : `San ${p}`; };
// nome della fermata come si pronuncia: «P.le Roma» -> «Piazzale Roma», «S. Marta» -> «Santa Marta», «S.M.E.» -> «Santa Maria Elisabetta»
function nomeParlato(nome) {
  let s = String(nome ?? '').replace(/\s+/g, ' ').trim();
  if (!/[a-zà-ÿ]/.test(s)) s = s.toLowerCase().replace(/(^|[\s-])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());   // «MESTRE CENTRO B2» -> «Mestre Centro B2»
  s = s.replace(/\bFS\b/g, 'F S').replace(/\bS\.M\.E\.?/g, 'Santa Maria Elisabetta')
    .replace(/\bP\.le\b/gi, 'Piazzale').replace(/\bF\.te\b/gi, 'Fondamente')
    .replace(/\bS\.\s?([A-Za-zÀ-ÿ]+)/g, (m, p) => santo(p))
    .replace(/\bA RICHIEST[A]?\b/g, 'a richiesta')
    .replace(/\s*-\s*/g, ', ')
    ;
  return s;
}
// «Rialto "D"» -> { base: 'Rialto', pontile: 'D' }
function dividiPontile(nome) {
  const s = String(nome ?? '').trim();
  const m = /^(.*?)\s+"([A-Za-z0-9]{1,2})"$/.exec(s) || /^(.*?)\s+corsia\s+([A-Za-z0-9]{1,3})$/i.exec(s);
  return m ? { base: m[1].trim(), pontile: m[2].toUpperCase() } : { base: s, pontile: null };
}
// la fermata con il pontile: «Rialto, pontile D»
function fermataParlata(nome) {
  const { base, pontile } = dividiPontile(nome);
  return nomeParlato(base) + (pontile ? `, pontile ${pontile}` : '');
}
// destinazione di una corsa («Lido S.M.E. "D"»): il pontile di arrivo non interessa a chi sale
const destinazioneParlata = nome => nomeParlato(dividiPontile(nome).base);

// elenco: «a, b e c»
function elenco(v) {
  const a = v.filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  const ult = a[a.length - 1];
  return a.slice(0, -1).join(', ') + (/^e/i.test(P_senza(ult)) ? ' ed ' : ' e ') + ult;
}
const P_senza = s => togliTag(s).trim();
const maiuscola = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
// frase di un avviso ACTV ripulita per la voce: niente indirizzi, hashtag, emoji, sigle in maiuscolo prolungate, lunghezza limitata
function frasePulita(t, max = 160) {
  let s = String(t ?? '').replace(/https?:\/\/\S+/g, ' ').replace(/#\w+/g, ' ').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  if (s.length > max) { const cut = s.slice(0, max), p = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; ')); s = (p > 60 ? cut.slice(0, p) : cut.replace(/\s+\S*$/, '')).replace(/[,:;–-]\s*$/, ''); }
  return s;
}

// giorno della settimana di una data «20261125» -> «mercoledì»
const giornoSettimana = ymd => GIORNI[ymdDate(ymd).getUTCDay()];
module.exports = { delleOra, dalleOra, parole, giornoSettimana, esc, speak, pausa, senzaTag, togliTag, oraParlata, oraSenzaPrep, minutiParlati, attesa, durata, giornoParlato, diffGiorni, lineaParlata,
  nomeParlato, dividiPontile, fermataParlata, destinazioneParlata, elenco, maiuscola, frasePulita, MESI, GIORNI, LETTERE, hm };
