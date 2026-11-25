'use strict';
// MAREA, ACQUA ALTA, MOSE, STIVALI, PASSERELLE. Livelli e previsioni vengono da /api/tide e /api/mose (CPSM e Autorità per la Laguna); le regole
// dell'acqua alta (soglie, stagione, quote stimate, passerelle) sono quelle del telefono: public/js/acqua.js, caricato così com'è (nessuna copia).
const P = require('./parlato');
const L = require('./luoghi');
const T = require('./tempo');
const U = require('./util');

const SOGLIA_BASSA = 80, SOGLIA_ALTA = 110, SOGLIA_ECC = 140;
const cmParlato = cm => { cm = Math.round(cm); const a = Math.abs(cm); return `${cm < 0 ? 'meno ' : ''}${a === 1 ? 'un centimetro' : P.parole(a) + ' centimetri'}`; };
const cmScheda = cm => `${Math.round(cm) > 0 ? '+' : ''}${Math.round(cm)} cm`;
// «MOSE» si pronuncia «mòze»
const conMose = s => String(s).replace(/\bMOSE\b|\bM\.O\.S\.E\.?/g, '<phoneme alphabet="ipa" ph="ˈmɔze">MOSE</phoneme>');
const FONTE_MAREA = 'Centro Previsioni e Segnalazioni Maree – Comune di Venezia';

async function leggiMarea(C) {
  const t = await C.call('/api/tide');
  if (!t || t.cm == null) { const e = new Error('marea non disponibile'); e.code = 503; throw e; }
  return t;
}
const tendenza = tr => (!tr ? null : tr.dir === 'up' ? 'in crescita' : tr.dir === 'down' ? 'in calo' : 'stabile');

// livello previsto in un istante, dalla curva tra gli estremi previsti (stessa forma usata dal grafico dell'app)
function livelloAl(ex, t) {
  for (let i = 0; i < ex.length - 1; i++) if (t >= ex[i].ts && t <= ex[i + 1].ts) { const f = (t - ex[i].ts) / (ex[i + 1].ts - ex[i].ts); return (ex[i].cm + ex[i + 1].cm) / 2 + (ex[i].cm - ex[i + 1].cm) / 2 * Math.cos(Math.PI * f); }
  return null;
}
// massimo previsto in [t0, t1]: { cm, ts } o null se la previsione non copre la finestra; coperto = ultimo istante coperto
function massimoPrevisto(ex, t0, t1) {
  if (!ex.length) return null;
  const fine = ex[ex.length - 1].ts, inizio = ex[0].ts;
  const a = Math.max(t0, inizio), b = Math.min(t1, fine);
  if (b < a) return { cm: null, coperto: false, fine };
  let best = null;
  for (let t = a; t <= b; t += 10 * 60e3) { const v = livelloAl(ex, t); if (v != null && (!best || v > best.cm)) best = { cm: v, ts: t }; }
  const vb = livelloAl(ex, b); if (vb != null && (!best || vb > best.cm)) best = { cm: vb, ts: b };
  for (const e of ex) if (e.ts >= t0 && e.ts <= t1 && (!best || e.cm > best.cm)) best = { cm: e.cm, ts: e.ts };
  return best ? { ...best, coperto: t1 <= fine && t0 >= inizio, fine, parziale: t1 > fine } : null;
}
async function estremi(C, t) {
  const ex = (t.chart && t.chart.extremes && t.chart.extremes.length ? t.chart.extremes : t.next || []).map(n => ({ type: n.type, cm: n.cm, ts: n.ts }));
  return ex.filter(e => e && Number.isFinite(e.ts) && Number.isFinite(e.cm)).sort((a, b) => a.ts - b.ts);
}
const classe = cm => (cm >= SOGLIA_ECC ? 'eccezionale' : cm >= SOGLIA_ALTA ? 'alta' : cm >= SOGLIA_BASSA ? 'sostenuta' : 'normale');
const orariOra = (ms) => U.hhmmMs(ms);
const dataDi = ms => T.adessoRoma(ms).ymd;
// «fino alle otto», «fino a domani alle sette», «fino a mezzanotte»
const fino = s => (/^(alle|all'|a )/.test(s) ? 'fino ' + s : 'fino a ' + s);
// momento previsto in parole: «oggi alle otto», «domani alle sette e quaranta»
function momento(C, ms) { const oggi = T.adessoRoma(C.adesso()).ymd, g = dataDi(ms); return `${g === oggi ? '' : P.giornoParlato(g, oggi) + ' '}${P.oraParlata(orariOra(ms))}`.trim(); }

// ---- COM'È LA MAREA ----
async function marea(C) {
  const t = await leggiMarea(C), ex = await estremi(C, t), adesso = C.adesso();
  const age = t.ageMin ?? U.etaDato(t.ts, adesso);
  const tr = tendenza(t.trend), prossimo = ex.find(e => e.ts > adesso - 5 * 60e3);
  let v = `A Punta della Salute la marea misurata è ${cmParlato(t.cm)}${t.cm < -1 ? ' sotto' : ''} ${t.cm < -1 ? 'lo zero' : 'sullo zero mareografico'}${tr ? `, ${tr}${t.trend.basis === 'previsione' ? ' secondo la previsione' : ''}` : ''}.`;
  if (t.stale || age >= 20) v += ` Attenzione: l'ultima misura risale a ${P.minutiParlati(age)} fa e potrebbe non essere aggiornata.`;
  else if (age >= 1) v += ` Misura di ${P.minutiParlati(age)} fa.`;
  const cls = classe(t.cm);
  if (cls !== 'normale') v += ` ${cls === 'sostenuta' ? 'È una marea sostenuta: i punti più bassi della città possono iniziare ad allagarsi.' : 'Siamo in acqua alta.'}`;
  const righe = [{ badge: cmScheda(t.cm), colore: cls === 'normale' ? '#2E7D6B' : cls === 'sostenuta' ? '#C99A2E' : '#C0392B', testo: 'Misurata', dett: `Punta della Salute · ${age} min fa`, ora: tr || '', attesa: '', stato: cls === 'normale' ? 'ok' : 'ritardo' }];
  if (prossimo) {
    v += ` Il prossimo ${prossimo.type === 'max' ? 'colmo' : 'minimo'} è previsto ${momento(C, prossimo.ts)}, intorno a ${cmParlato(prossimo.cm)}.`;
    righe.push({ badge: cmScheda(prossimo.cm), colore: '#4A5A6A', testo: prossimo.type === 'max' ? 'Prossimo colmo (previsione)' : 'Prossimo minimo (previsione)', dett: momento(C, prossimo.ts), ora: orariOra(prossimo.ts), attesa: '', stato: 'prog' });
  } else v += ' Non ho previsioni per le prossime ore.';
  const m = t.mose && t.mose.stato && t.mose.stato !== 'recesso' ? ` Il MOSE risulta ${({ programmato: 'programmato per il sollevamento', sollevamento: 'in sollevamento', sollevata: 'sollevato', abbassamento: 'in abbassamento' })[t.mose.stato] || 'attivo'}.` : '';
  v += m;
  return { voce: conMose(P.esc(v).replace(/&apos;/g, "'")), scheda: { titolo: 'Marea a Venezia', sottotitolo: 'Punta della Salute', grande: cmScheda(t.cm), righe, nota: 'Misura e previsione del Centro Maree: le previsioni possono cambiare con vento e pressione.', fonte: FONTE_MAREA }, ctx: { tipo: 'marea' }, fine: false };
}

// ---- SINTESI (per il riepilogo): una o due frasi ----
async function sintesi(C) {
  const t = await leggiMarea(C), ex = await estremi(C, t), adesso = C.adesso(), tr = tendenza(t.trend), mx = massimoPrevisto(ex, adesso, adesso + 12 * 3600e3);
  let v = `La marea a Punta della Salute è ${cmParlato(t.cm)}${tr ? ', ' + tr : ''}.`;
  const age = t.ageMin ?? U.etaDato(t.ts, adesso);
  if (t.stale || age >= 20) v += ` La misura risale a ${P.minutiParlati(age)} fa.`;
  if (mx && mx.cm != null) {
    const cls = classe(mx.cm);
    v += cls === 'normale' ? ` Nelle prossime dodici ore non è prevista acqua alta: massimo ${cmParlato(mx.cm)}.` : ` Nelle prossime dodici ore è previsto un massimo di ${cmParlato(mx.cm)} ${momento(C, mx.ts)}${cls === 'sostenuta' ? ': marea sostenuta' : ': acqua alta'}.`;
  } else v += ' Non ho previsioni per le prossime ore.';
  const ms = t.mose && t.mose.stato && t.mose.stato !== 'recesso' ? ` Il MOSE risulta ${({ programmato: 'programmato', sollevamento: 'in sollevamento', sollevata: 'sollevato', abbassamento: 'in abbassamento' })[t.mose.stato] || 'attivo'}.` : '';
  return { voce: conMose(P.esc(v + ms).replace(/&apos;/g, "'")), cm: t.cm, max: mx && mx.cm != null ? Math.round(mx.cm) : null, trend: tr, riga: { badge: cmScheda(t.cm), colore: mx && mx.cm >= SOGLIA_ALTA ? '#C0392B' : mx && mx.cm >= SOGLIA_BASSA ? '#C99A2E' : '#2E7D6B', testo: 'Marea ora', dett: mx && mx.cm != null ? `Massimo 12 ore: ${cmScheda(mx.cm)}` : '', ora: '', attesa: '', stato: mx && mx.cm >= SOGLIA_BASSA ? 'ritardo' : 'ok' } };
}

// ---- PROSSIMO COLMO ----
async function colmo(C, ric = {}) {
  const t = await leggiMarea(C), ex = await estremi(C, t), adesso = C.adesso();
  if (ric.minimo) {                                   // «e il minimo?»
    const min = ex.filter(e => e.type === 'min' && e.ts > adesso - 5 * 60e3)[0];
    if (!min) return { voce: P.esc('Non ho una previsione del prossimo minimo. Il livello misurato adesso è ' + cmParlato(t.cm) + '.'), fine: false, ctx: { tipo: 'marea' } };
    const v = `Il prossimo minimo è previsto ${momento(C, min.ts)}, a ${cmParlato(min.cm)}. È una previsione del Centro Maree.`;
    return { voce: P.esc(v).replace(/&apos;/g, "'"), scheda: { titolo: 'Prossimo minimo', sottotitolo: 'Previsione, Punta della Salute', grande: cmScheda(min.cm), righe: [], nota: 'Previsione: può cambiare.', fonte: FONTE_MAREA }, ctx: { tipo: 'colmo' }, fine: false };
  }
  const max = ex.filter(e => e.type === 'max' && e.ts > adesso - 5 * 60e3).slice(0, 2);
  if (!max.length) return { voce: P.esc('Non ho previsioni di colmo per le prossime ore. Il livello misurato adesso è ' + cmParlato(t.cm) + '.'), fine: false, ctx: { tipo: 'marea' } };
  const f = (e, primo) => `${primo ? 'Il prossimo colmo' : 'Il successivo'} è previsto ${momento(C, e.ts)}: circa ${cmParlato(e.cm)}${e.cm >= SOGLIA_ALTA ? ', cioè acqua alta' : e.cm >= SOGLIA_BASSA ? ', marea sostenuta' : ''}.`;
  let v = max.map((e, i) => f(e, i === 0)).join(' ');
  const hi = Math.max(...max.map(e => e.cm));
  if (hi >= SOGLIA_ALTA) v += ' La previsione è calcolata senza MOSE: se le barriere vengono sollevate, in città il livello resta più basso.';
  v += ' Sono previsioni del Centro Maree e possono cambiare.';
  const righe = max.map((e, i) => ({ badge: cmScheda(e.cm), colore: e.cm >= SOGLIA_ALTA ? '#C0392B' : e.cm >= SOGLIA_BASSA ? '#C99A2E' : '#2E7D6B', testo: i ? 'Colmo successivo' : 'Prossimo colmo', dett: momento(C, e.ts), ora: orariOra(e.ts), attesa: '', stato: 'prog' }));
  return { voce: conMose(P.esc(v).replace(/&apos;/g, "'")), scheda: { titolo: 'Prossimo colmo', sottotitolo: 'Previsione, Punta della Salute', grande: cmScheda(max[0].cm), righe, nota: 'Previsione senza MOSE. Può cambiare.', fonte: FONTE_MAREA }, ctx: { tipo: 'marea' }, fine: false };
}

// finestra da richiesta: { t0, t1, testo }
function finestra(C, q) {
  const adesso = C.adesso(), n = T.adessoRoma(adesso);
  if (!q || q.adesso) return { t0: adesso, t1: adesso + 24 * 3600e3, testo: 'le prossime ventiquattro ore', senzaRichiesta: true };
  const ymd = q.ymd;
  const fasce = { MO: [6, 12], AF: [12, 18], EV: [18, 24], NI: [0, 6] };
  let da, a, nome;
  if (q.fascia) { const [h0, h1] = fasce[q.fascia]; da = T.inizioMs(ymd, h0 * 3600); a = T.inizioMs(ymd, h1 * 3600); nome = ymd === n.ymd ? ({ mattina: 'stamattina', pomeriggio: 'oggi pomeriggio', sera: 'stasera', notte: 'stanotte' })[q.nomeFascia] : `${P.giornoParlato(ymd, n.ymd)} ${q.nomeFascia}`; }
  else if (q.conOra && q.hhmm) { da = T.inizioMs(ymd, q.secs - 5400); a = T.inizioMs(ymd, q.secs + 5400); nome = `${P.giornoParlato(ymd, n.ymd)} intorno ${P.oraParlata(q.hhmm)}`; }
  else { da = T.inizioMs(ymd, 0); a = T.inizioMs(ymd, 86400); nome = P.giornoParlato(ymd, n.ymd); }
  return { t0: Math.max(da, adesso), t1: a, testo: nome, passato: a < adesso };
}

// ---- ACQUA ALTA IN UNA FINESTRA ----
// «l'uno», «l'otto», «l'undici», «l'ottanta», altrimenti «il venti»
const artPerc = n => { const w = P.parole(n); return /^[aeiouàèéìòù]/i.test(w) ? `l'${w}` : `il ${w}`; };
async function acquaAlta(C, ric) {
  const t = await leggiMarea(C), ex = await estremi(C, t), adesso = C.adesso(), w = finestra(C, ric.quando);
  if (w.passato) return { voce: P.esc('Quel momento è già passato.'), fine: false, ctx: { tipo: 'marea' } };
  const mx = massimoPrevisto(ex, w.t0, w.t1);
  const cap = ex.length ? ex[ex.length - 1].ts : null;
  if (!mx || mx.cm == null) {
    const v = cap ? `Per ${w.testo} non ho ancora una previsione: quella disponibile arriva ${fino(momento(C, cap))}.` : `Non ho previsioni di marea per ${w.testo}.`;
    return { voce: P.esc(v + ' Adesso la marea misurata è ' + cmParlato(t.cm) + '.'), fine: false, ctx: { tipo: 'marea' } };
  }
  const A = await C.acqua(), perc = A?.Q ? A.Q.percento(mx.cm) : null;
  let v = `Per ${w.testo} il massimo previsto è ${cmParlato(mx.cm)}, ${momento(C, mx.ts)}.`;
  const cls = classe(mx.cm);
  if (cls === 'normale') v += ` Non è prevista acqua alta: sotto i ${P.parole(SOGLIA_BASSA)} centimetri le zone più basse restano di norma asciutte.`;
  else if (cls === 'sostenuta') v += ` È prevista marea sostenuta: i punti più bassi possono allagarsi${perc != null && perc >= 0.5 ? `, circa ${artPerc(Math.max(1, Math.round(perc)))} per cento della città storica` : ''}.`;
  else v += ` È prevista acqua alta${perc != null ? `: circa ${artPerc(Math.round(perc))} per cento della città storica potenzialmente allagabile` : ''}${cls === 'eccezionale' ? ', una marea eccezionale' : ''}.`;
  if (cls !== 'normale' && mx.cm >= SOGLIA_ALTA) v += ' La previsione è calcolata senza MOSE: con le barriere sollevate in città il livello resta più basso.';
  if (mx.parziale || (cap && w.t1 > cap)) v += ` Attenzione: la previsione copre solo ${fino(momento(C, cap))}.`;
  v += ' Sono previsioni e possono cambiare.';
  const righe = [{ badge: cmScheda(mx.cm), colore: cls === 'normale' ? '#2E7D6B' : cls === 'sostenuta' ? '#C99A2E' : '#C0392B', testo: `Massimo previsto, ${w.testo}`, dett: momento(C, mx.ts), ora: orariOra(mx.ts), attesa: '', stato: cls === 'normale' ? 'ok' : 'ritardo' }];
  if (perc != null && perc > 0.1) righe.push({ badge: `${Math.round(perc)}%`, colore: '#4A5A6A', testo: 'Città storica potenzialmente allagabile', dett: 'Stima, non una misura', ora: '', attesa: '', stato: 'prog' });
  return { voce: conMose(P.esc(v).replace(/&apos;/g, "'")), scheda: { titolo: 'Acqua alta?', sottotitolo: w.testo, grande: cmScheda(mx.cm), righe, nota: 'Previsione senza MOSE. Zone potenzialmente allagabili: stima.', fonte: FONTE_MAREA }, ctx: { tipo: 'marea' }, fine: false };
}

// ---- MOSE ----
async function mose(C) {
  let m = null;
  try { m = await C.call('/api/mose'); } catch { /* sotto */ }
  const adesso = C.adesso();
  if (!m || m.error || !m.stato) return { voce: P.esc('Adesso non riesco a leggere lo stato del MOSE dalla pagina dell\'Autorità per la Laguna. Il sollevamento delle barriere viene deciso quando la marea prevista supera i centodieci centimetri.').replace(/&apos;/g, "'").replace(/MOSE/g, '<phoneme alphabet="ipa" ph="ˈmɔze">MOSE</phoneme>'), fine: false, ctx: { tipo: 'marea' } };
  const frasi = { recesso: 'Il MOSE non è sollevato: le barriere sono a riposo, in recesso.', programmato: 'È programmato un sollevamento del MOSE.', sollevamento: 'Il MOSE si sta sollevando.', sollevata: 'Il MOSE è sollevato.', abbassamento: 'Il MOSE si sta abbassando.', sconosciuto: 'Lo stato del MOSE non è riconosciuto.' };
  let v = frasi[m.stato] || frasi.sconosciuto;
  if (['sollevata', 'sollevamento', 'abbassamento'].includes(m.stato) && m.titolo) v += ' ' + m.titolo.replace(/^MOSE (attivo|in attivazione|in rientro):\s*/i, '') + '.';
  if (m.evento && m.evento.data && ['programmato', 'recesso'].includes(m.stato) && m.stato === 'programmato') v += ` Evento: ${m.evento.data}${m.evento.orario ? ', ' + m.evento.orario : ''}.`;
  const eta = m.letto ? U.etaDato(m.letto, adesso) : null;
  if (m.stale) v += ` Attenzione: lo stato non è aggiornato da ${P.minutiParlati(eta)}.`;
  else if (eta != null && eta >= 10) v += ` Dato letto ${P.minutiParlati(eta)} fa.`;
  v += ' Fonte: Autorità per la Laguna di Venezia.';
  const righe = (m.barriere || []).slice(0, 4).map(b => ({ badge: b.sem === 'verde' ? 'OK' : b.sem === 'rosso' ? 'ALTA' : '···', colore: b.sem === 'verde' ? '#2E7D6B' : b.sem === 'rosso' ? '#C0392B' : '#C99A2E', testo: b.bocca || b.barriera, dett: b.barriera, ora: b.testo ? b.testo.slice(0, 40) : '', attesa: '', stato: b.sem === 'verde' ? 'ok' : 'ritardo' }));
  return { voce: conMose(P.esc(v).replace(/&apos;/g, "'")), scheda: { titolo: 'MOSE', sottotitolo: m.titolo || '', righe, nota: m.stale ? 'Dato non aggiornato.' : '', fonte: 'Autorità per la Laguna di Venezia' }, ctx: { tipo: 'marea' }, fine: false };
}

// livello di riferimento per stivali e passerelle: il maggiore tra misura e massimo previsto nelle prossime ore
async function livelloRif(C, t, ore = 6) {
  const ex = await estremi(C, t), adesso = C.adesso(), mx = massimoPrevisto(ex, adesso, adesso + ore * 3600e3);
  const prev = mx && mx.cm != null ? mx : null;
  return { misurato: t.cm, previsto: prev ? Math.round(prev.cm) : null, tsPrev: prev?.ts || null, max: Math.max(t.cm, prev ? prev.cm : -999), mose: t.mose?.stato || null };
}

// quota minima stimata attorno a un punto (celle di ~20 m, raggio ~40 m): null se non ci sono calli nel modello
function quotaVicina(Q, lat, lon) {
  let min = null;
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) { const q = Q.at(lat + i * 0.00018, lon + j * 0.00026); if (q != null && (min == null || q < min)) min = q; }
  return min;
}

// ---- STIVALI ----
async function stivali(C, ric) {
  const t = await leggiMarea(C), r = await livelloRif(C, t), A = await C.acqua();
  const cm = r.max, perc = A?.Q ? A.Q.percento(cm) : null;
  let v, stato = 'ok';
  const lv = A?.A ? A.A.livelloCitta({ cm: r.previsto != null && r.previsto > r.misurato ? r.previsto : r.misurato, kind: r.previsto != null && r.previsto > r.misurato ? 'previsto' : 'misurato' }, r.mose) : null;
  const uso = lv ? lv.cm : cm;
  if (lv?.mose) v = `Il MOSE è in funzione: in città conto al massimo ${cmParlato(uso)}.`;
  else v = '';
  const g = ric.gruppo;
  let locale = null;
  if (g && A?.Q) {
    const q = quotaVicina(A.Q, g.centro[0], g.centro[1]);
    locale = q;
    if (q != null) v += ` Per ${g.parlato}, la quota stimata del suolo è circa ${cmParlato(q)}${uso >= q ? `: con ${cmParlato(uso)} è potenzialmente allagato` : `: con ${cmParlato(uso)} dovrebbe restare asciutto`}. È una stima, non una misura.`;
    else v += ` Per ${g.parlato} non ho una quota affidabile.`;
  }
  if (uso < 60 && !(locale != null && uso >= locale)) { v = `No, per ora non servono: la marea è ${cmParlato(r.misurato)}${r.previsto != null && r.previsto >= SOGLIA_BASSA ? `, ma è previsto un massimo di ${cmParlato(r.previsto)} ${momento(C, r.tsPrev)}` : ''}.` + (v ? ' ' + v.trim() : ''); }
  else if (uso < SOGLIA_BASSA && !(locale != null && uso >= locale)) { v = `Di solito non servono: la marea è ${cmParlato(r.misurato)}${r.previsto != null ? ` e nelle prossime ore arriva a ${cmParlato(r.previsto)}` : ''}; sotto gli ottanta centimetri solo pochi punti molto bassi si bagnano.` + (v ? ' ' + v.trim() : ''); }
  else { stato = 'ritardo'; v = `Sì, conviene averli${uso >= SOGLIA_ALTA ? ', meglio se alti' : ''}: la marea è ${cmParlato(r.misurato)}${r.previsto != null && r.previsto > r.misurato ? `, con un massimo previsto di ${cmParlato(r.previsto)} ${momento(C, r.tsPrev)}` : ''}${perc != null && perc >= 0.5 ? `, e circa ${artPerc(Math.max(1, Math.round(perc)))} per cento della città storica è potenzialmente allagabile` : ''}.` + (v ? ' ' + v.trim() : ''); }
  if (locale == null) v += ' Sono stime sul livello di marea, non una garanzia sulla singola calle.';
  const righe = [{ badge: cmScheda(r.misurato), colore: '#4A5A6A', testo: 'Misurata ora', dett: 'Punta della Salute', ora: '', attesa: '', stato: 'ok' }];
  if (r.previsto != null) righe.push({ badge: cmScheda(r.previsto), colore: '#4A5A6A', testo: 'Massimo previsto, 6 ore', dett: momento(C, r.tsPrev), ora: orariOra(r.tsPrev), attesa: '', stato: 'prog' });
  return { voce: conMose(P.esc(v).replace(/&apos;/g, "'")), scheda: { titolo: 'Servono gli stivali?', sottotitolo: g ? g.parlato : 'Città storica', grande: stato === 'ok' ? 'NO' : 'SÌ', righe, nota: 'Stima sul livello di marea, non sulla singola calle.', fonte: FONTE_MAREA }, ctx: { tipo: 'marea' }, fine: false };
}

// ---- PASSERELLE ----
async function passerelle(C, ric) {
  const A = await C.acqua(), adesso = C.adesso();
  if (!A?.P) return { voce: P.esc('Non ho i dati sulle passerelle in questo momento.'), fine: false, ctx: { tipo: 'marea' } };
  const t = await leggiMarea(C).catch(() => null), r = t ? await livelloRif(C, t, 12) : null;
  const g = ric.gruppo, stagione = A.P.stagione, inStag = A.A.inStagione(adesso, stagione);
  const giorno = n => (+n === 1 ? 'primo' : P.parole(+n)), md = s => `${giorno(s.slice(3))} ${P.MESI[+s.slice(0, 2) - 1]}`;
  const stagioneTxt = `Il piano comunale le prevede dal ${md(stagione.da)} al ${md(stagione.a)}`;
  let elenco = A.P.list;
  if (g) elenco = A.P.list.filter(p => p.parti.some(pt => pt.some(([la, lo]) => L.metri(g.centro, [la, lo]) <= 250)));
  const nomeLuogo = g ? g.parlato : 'in città';
  let v = '';
  if (g && !elenco.length) v = `Nel piano comunale non risultano percorsi su passerella vicini a ${nomeLuogo}.`;
  else {
    if (g) {
      const qs = elenco.map(p => p.q), lo = Math.min(...qs), hi = Math.max(...qs);
      v = `Vicino a ${nomeLuogo} ${elenco.length === 1 ? 'c\'è un percorso su passerella' : 'ci sono ' + P.parole(elenco.length) + ' percorsi su passerella'}, con quota di posa ${lo === hi ? P.parole(lo) : 'da ' + P.parole(lo) + ' a ' + P.parole(hi)} centimetri.`;
    } else v = 'Il piano comunale prevede diversi percorsi su passerella nel centro storico e nelle isole.';
    v += ` ${stagioneTxt}.`;
    if (!inStag) v += ' Oggi siamo fuori da quel periodo: di norma le passerelle non vengono montate.';
    else if (r) {
      const quote = elenco.map(p => p.q), min = quote.length ? Math.min(...quote) : null, cm = Math.max(r.misurato, r.previsto ?? -999);
      if (min != null && r.misurato >= min) v += ` Con la marea misurata di ${cmParlato(r.misurato)}, secondo il piano dovrebbero essere posate.`;
      else if (min != null && cm >= min) v += ` Con il massimo previsto di ${cmParlato(cm)} ${r.tsPrev ? momento(C, r.tsPrev) : ''} potrebbero servire.`;
      else if (min != null) v += ` Con la marea attuale di ${cmParlato(r.misurato)} e il massimo previsto di ${cmParlato(Math.max(cm, r.misurato))} non dovrebbero servire.`;
      else v += ` Adesso la marea è ${cmParlato(r.misurato)}.`;
    }
    v += ' Non posso confermare che siano davvero montate: non esiste un dato pubblico in tempo reale sulla posa.';
  }
  const righe = elenco.slice(0, 4).map(p => ({ badge: p.id, colore: '#4A5A6A', testo: p.d, dett: `${p.m} metri · posa da ${p.q} cm`, ora: '', attesa: '', stato: 'prog' }));
  return { voce: P.esc(v).replace(/&apos;/g, "'"), scheda: { titolo: 'Passerelle', sottotitolo: nomeLuogo, righe, nota: 'Posa non verificabile in tempo reale.', fonte: 'Comune di Venezia, Centro Maree' }, ctx: { tipo: 'marea' }, fine: false };
}

module.exports = { sintesi, marea, colmo, acquaAlta, mose, stivali, passerelle, livelloRif, massimoPrevisto, livelloAl, cmParlato, cmScheda, conMose, finestra, classe, quotaVicina };
