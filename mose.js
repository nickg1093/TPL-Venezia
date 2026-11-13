// STATO DEL MO.S.E. (barriere mobili alle bocche di porto della laguna) per il pannello della marea.
// FONTE: Autorità per la Laguna di Venezia, pagina pubblica «Operatività M.O.S.E.» (https://www.autoritalaguna.it/operativita-m-o-s-e/):
// tabella «Bocche di porto · Barriere · Stato» e tabella «Evento del…» (data e orario del sollevamento programmato). Si legge SOLO lo stato
// (un fatto, con la fonte citata e il collegamento alla pagina); niente altro della pagina viene riprodotto.
// Stati usati dalla fonte (con i suoi colori): «Paratoie in recesso» (verde), «Programmato sollevamento di salvaguardia» (giallo),
// «Barriera in fase di sollevamento» (arancio), «Barriera sollevata» (rosso). Qui diventano semafori: verde, giallo fisso (programmato),
// giallo lampeggiante (in movimento), rosso (sollevata). Un testo diverso si mostra così com'è, con il semaforo grigio.
// CARICO: la pagina pesa ~55 kB compressi. Si legge solo quando serve (pannello marea aperto, oppure marea prevista alta: tide.js),
// al massimo ogni 10 minuti con le barriere a riposo e ogni 4 minuti quando si muovono; in caso di errore si riprova dopo 5 minuti
// e si continua a mostrare l'ultimo stato letto, segnato come non aggiornato.
const SRC_URL = 'https://www.autoritalaguna.it/operativita-m-o-s-e/';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; TPL-Venezia/1.0; +https://github.com/nickg1093/TPL-Venezia)', Accept: 'text/html' };
const TTL_CALM = 10 * 60e3, TTL_ACTIVE = 4 * 60e3, TTL_ERR = 5 * 60e3, MAX_HTML = 3e6, STALE_MS = 45 * 60e3;

// ordine: si prova dall'alto (il testo del «programmato» contiene anche «sollevamento»)
const STATI = [
  { re: /programmat/i, k: 'programmato', sem: 'giallo', lab: 'Sollevamento programmato' },
  { re: /fase di sollevamento|in sollevamento/i, k: 'sollevamento', sem: 'lampeggia', lab: 'In sollevamento' },
  { re: /abbassament|in rientro|fase di rientro/i, k: 'abbassamento', sem: 'lampeggia', lab: 'In abbassamento' },
  { re: /sollevat|alzat|chius/i, k: 'sollevata', sem: 'rosso', lab: 'Sollevata' },
  { re: /recesso|a riposo|abbassat|apert/i, k: 'recesso', sem: 'verde', lab: 'In recesso' }
];
const RANK = { sconosciuto: 0, recesso: 1, programmato: 2, abbassamento: 3, sollevamento: 4, sollevata: 5 };
const classify = txt => { const t = String(txt || '').trim(); for (const s of STATI) if (s.re.test(t)) return s; return { k: 'sconosciuto', sem: 'grigio', lab: t || 'Non disponibile' }; };

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', agrave: 'à', egrave: 'è', eacute: 'é', igrave: 'ì', ograve: 'ò', ugrave: 'ù', Agrave: 'À', Egrave: 'È' };
const text = h => String(h).replace(/<[^>]*>/g, ' ').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m)).replace(/\s+/g, ' ').trim();
// tabelle della pagina: { head: [intestazioni], rows: [[celle]] }
function tables(html) {
  const out = [];
  for (const m of String(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const t = m[1], head = [...(t.match(/<thead\b[\s\S]*?<\/thead>/i)?.[0] || '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(x => text(x[1]));
    const body = t.match(/<tbody\b[\s\S]*?(<\/tbody>|$)/i)?.[0] || t;
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => [...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x => text(x[1]))).filter(r => r.length);
    out.push({ head, rows });
  }
  return out;
}
// «13/11/2026 02:03 AM» (ora di Roma) -> ms
function romeMs(s) {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i); if (!m) return null;
  let h = +m[4]; if (m[6]) { h %= 12; if (/pm/i.test(m[6])) h += 12; }
  const guess = Date.UTC(+m[3], +m[2] - 1, +m[1], h, +m[5]);
  const off = t => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t)); const g = k => +p.find(x => x.type === k).value; return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) - t; };
  return guess - off(guess - off(guess));
}
// dalla pagina allo stato: { stato, sem, titolo, barriere: [{ bocca, barriera, stato, sem, testo }], evento, aggiornato } (null se la tabella manca)
function parse(html) {
  const ts = tables(html), col = (t, re) => t.head.findIndex(h => re.test(h));
  const bt = ts.find(t => col(t, /^barriere$/i) >= 0 && col(t, /^stato$/i) >= 0); if (!bt) return null;
  const iB = col(bt, /^bocche di porto$/i), iR = col(bt, /^barriere$/i), iS = col(bt, /^stato$/i), iT = col(bt, /last_edited_at/i);
  const barriere = [], times = [];
  for (const r of bt.rows) {
    const barriera = r[iR] || ''; if (!barriera) continue;
    const c = classify(r[iS]);
    barriere.push({ bocca: (iB >= 0 && r[iB]) || '', barriera, stato: c.k, sem: c.sem, testo: (r[iS] || '').slice(0, 120) });
    const t = iT >= 0 ? romeMs(r[iT]) : null; if (t) times.push(t);
  }
  if (!barriere.length) return null;
  let evento = null;
  const et = ts.find(t => col(t, /^data$/i) >= 0 && col(t, /^orario$/i) >= 0);
  if (et) { const r = et.rows.find(x => (x[col(et, /^data$/i)] || x[col(et, /^orario$/i)])); if (r) evento = { data: r[col(et, /^data$/i)].slice(0, 40), orario: r[col(et, /^orario$/i)].slice(0, 40) }; }
  const worst = barriere.reduce((m, b) => (RANK[b.stato] > RANK[m.stato] ? b : m), barriere[0]);
  const all = k => barriere.every(b => b.stato === k), some = k => barriere.some(b => b.stato === k);
  // concordanza: «1 barriera sollevata», «2 barriere sollevate», «tutte le barriere sollevate» (barriera e paratoia: femminili)
  const n = k => barriere.filter(b => b.stato === k).length, N = barriere.length;
  const quante = (k, sing, plur) => { const x = n(k); return x === N && N > 1 ? `tutte le barriere ${plur}` : x === 1 ? `1 barriera ${sing} su ${N}` : `${x} barriere ${plur} su ${N}`; };
  const titolo = all('recesso') ? (N === 1 ? 'MOSE non attivo: paratoia in recesso' : 'MOSE non attivo: paratoie in recesso')
    : some('sollevata') ? `MOSE attivo: ${quante('sollevata', 'sollevata', 'sollevate')}`
    : some('sollevamento') ? `MOSE in attivazione: ${quante('sollevamento', 'in sollevamento', 'in sollevamento')}`
    : some('abbassamento') ? `MOSE in rientro: ${quante('abbassamento', 'in abbassamento', 'in abbassamento')}`
    : some('programmato') ? 'Sollevamento del MOSE programmato'
    : 'Stato del MOSE non riconosciuto';
  return { stato: worst.stato, sem: worst.sem, titolo, barriere, evento, aggiornato: times.length ? Math.max(...times) : null };
}

let cur = null, at = 0, failAt = 0, busy = null;
const ttl = () => (cur && cur.stato !== 'recesso' ? TTL_ACTIVE : TTL_CALM);
async function refresh({ fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  if (busy) return busy;
  if (now - at < ttl() || now - failAt < TTL_ERR) return cur;
  busy = (async () => {
    try {
      const r = await fetchFn(SRC_URL, { headers: HEADERS, signal: AbortSignal.timeout(12000), redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = await r.text(); if (html.length > MAX_HTML) throw new Error('pagina troppo grande');
      const p = parse(html); if (!p) throw new Error('tabella non trovata');
      cur = p; at = Date.now(); failAt = 0;
    } catch { failAt = Date.now(); }
    finally { busy = null; }
    return cur;
  })();
  return busy;
}
// risposta per /api/mose (e riassunto per /api/tide): stato letto più quando e da dove
function snapshot(now = Date.now()) {
  if (!cur) return null;
  return { ...cur, letto: at, stale: now - at > STALE_MS, fonte: { nome: 'Autorità per la Laguna di Venezia', url: SRC_URL } };
}
const brief = (now = Date.now()) => (cur && now - at <= STALE_MS ? { stato: cur.stato, sem: cur.sem } : null);
module.exports = { parse, classify, romeMs, refresh, snapshot, brief, SRC_URL, _reset: () => { cur = null; at = 0; failAt = 0; busy = null; } };
