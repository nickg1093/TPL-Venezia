// AVVISI DI INFOMOBILITÀ (client): pulsante con contatore, finestra con l'elenco, e interrogazioni per fermata (usate da mappa e pannello fermata).
// I dati arrivano da /api/avvisi (sito ACTV + canale Telegram, già uniti e con linee/fermate collegate). Tutto il testo è mostrato come testo semplice (esc).
import { $, esc, icon, srcIcon, api, badge } from './util.js';

const btn = $('avvisi-btn'), card = $('avvisi'), body = $('avvisi-body'), cnt = $('avvisi-count');
let data = null, err = null, timer = null, highlight = null, onChange = () => {};
const byStop = new Map(), byLine = new Map();                      // fermata "src:id" / linea "src:NOME" -> [avviso, …]  (solo avvisi in corso)

const now = () => Date.now();
// giorni: avviso valido solo in giorni separati («mercoledì 18 e 25 novembre»): [[inizio, fine], …]; tra un giorno e l'altro non è in corso
const okGiorni = g => Array.isArray(g) && g.length >= 2 && g.length <= 40 && g.every(x => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1]));
const overlaps = (a, x, y) => (okGiorni(a.giorni) ? a.giorni.some(([p, q]) => p <= y && q >= x) : a.from <= y && a.to >= x);
// sciopero (v33.3): «in corso» dall'inizio alle 05:00 del giorno dopo (prime corse del mattino), come lo espone il server
const okSc = a => a.sciopero && Number.isFinite(a.sciopero.inizio) && Number.isFinite(a.sciopero.fino) && Number.isFinite(a.sciopero.da);
const isActive = a => (okSc(a) ? a.from <= now() && a.sciopero.fino >= now() : a.from <= now() && a.to >= now() && overlaps(a, now(), now()));
// avviso che "pesa" su fermate e mezzi: in corso, non risolto, non generale (es. nuovi orari di tutta la rete)
const isWarn = a => isActive(a) && !a.resolved && !a.general;
const two = n => String(n).padStart(2, '0');
const hmOf = ms => { const d = new Date(ms); return `${d.getHours()}:${two(d.getMinutes())}`; };
const dayOf = ms => new Date(ms).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
const midnight = ms => { const d = new Date(ms); return d.getHours() === 0 && d.getMinutes() === 0; };
const endOfDay = ms => { const d = new Date(ms); return d.getHours() === 23 && d.getMinutes() === 59; };
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const fmt = ms => `${dayOf(ms)}, ${hmOf(ms)}`;
const safeUrl = u => (/^https:\/\/(actv\.avmspa\.it|avm\.avmspa\.it|t\.me|telegram\.me)\//.test(u) ? u : null);
const SRC = { actv: 'ACTV', telegram: 'Telegram', both: 'ACTV · Telegram', auto: 'Calcolato dal livello di marea' };

// periodo in forma breve e precisa: "ven 30 ott, 8:30–12:00", "ven 30 ott dalle 8:30 fino al termine", "dal sab 31 ott al dom 1 nov"
function validity(a) {
  if (a.source === 'auto') return 'In base alla marea';
  if (a.resolved) return `Risolto alle ${hmOf(a.published)}`;
  const up = a.updated ? ' · aggiornato' : '';
  if (!a.dated) return `Pubblicato ${fmt(a.published)}${up}`;
  const f = midnight(a.from) ? dayOf(a.from) : fmt(a.from), t = endOfDay(a.to) ? dayOf(a.to) : fmt(a.to);
  if (a.open) return `Dal ${f}${up}`;
  if (a.untilEnd) return `${midnight(a.from) ? dayOf(a.from) : `${dayOf(a.from)} dalle ${hmOf(a.from)}`} fino al termine${up}`;
  if (okSc(a)) return `${dayOf(a.sciopero.inizio)}${sameDay(a.sciopero.inizio, a.sciopero.fine) ? '' : ` – ${dayOf(a.sciopero.fine)}`} · effetti fino alle ${hmOf(a.sciopero.fino)} del giorno dopo${up}`;
  if (okGiorni(a.giorni)) {                                          // «mer 18 e mer 25 nov, 9:00–17:00»
    const g = a.giorni, ds = g.map(([p]) => dayOf(p)), list = ds.length > 1 ? `${ds.slice(0, -1).join(', ')} e ${ds[ds.length - 1]}` : ds[0];
    const [p0, q0] = g[0], same = g.every(([p, q]) => hmOf(p) === hmOf(p0) && hmOf(q) === hmOf(q0));
    return same && !(midnight(p0) && endOfDay(q0)) ? `${list}, ${hmOf(p0)}–${hmOf(q0)}${up}` : `${list}${up}`;
  }
  if (sameDay(a.from, a.to)) return midnight(a.from) && endOfDay(a.to) ? `${dayOf(a.from)}${up}` : `${dayOf(a.from)}, ${hmOf(a.from)}–${hmOf(a.to)}${up}`;
  return `Dal ${f} al ${t}${up}`;
}
const lineKey = (s, n) => `${s}:${String(n).toUpperCase()}`;
// da dove viene il livello: misura, previsione, avviso ufficiale (vale il più alto)
function waterSrc(w) {
  const p = [w.measured != null ? `misurato ora ${w.measured} cm` : null, w.forecast ? `previsto ${w.forecast.cm} cm alle ${hmOf(w.forecast.ts)}` : null,
    w.official != null ? `avviso ufficiale ${w.official} cm` : w.confirmed ? 'confermato da avviso ufficiale' : null].filter(Boolean);
  return p.length ? `<span class="av-wsrc muted">${esc(p.join(' · '))}</span>` : '';
}
function reindex() {
  byStop.clear(); byLine.clear();
  for (const a of data?.items || []) {
    if (!isWarn(a)) continue;
    for (const id of a.stops || []) (byStop.get(id) || byStop.set(id, []).get(id)).push(a);
    if (a.ambito === 'fermate') continue;                          // solo pontili/fermate citati: non su tutte le fermate e i mezzi della linea
    for (const l of a.lines || []) { const k = lineKey(l.s, l.n); (byLine.get(k) || byLine.set(k, []).get(k)).push(a); }
  }
}
const uniq = list => { const seen = new Set(); return list.filter(a => isWarn(a) && !seen.has(a.id) && seen.add(a.id)); };
// avvisi in corso che citano esplicitamente una delle fermate indicate
export const _setData = d => { data = d; reindex(); };              // solo per le prove
export const forStops = ids => uniq(ids.flatMap(id => byStop.get(id) || []));
// avvisi in corso su una delle linee indicate ([{ s: 'aut', n: '7E' }]): valgono in ogni fermata in cui la linea ferma e sul mezzo
export const forLines = list => uniq(list.flatMap(l => byLine.get(lineKey(l.s, l.n)) || []));
// AVVISI PER UN VIAGGIO DEL PIANIFICATORE (linee e fermate della soluzione, nel SUO giorno e nelle SUE ore; mai la data di pubblicazione):
//  · avvisi con un periodo (lavori, manifestazioni, scioperi, acqua alta prevista): solo se il periodo si sovrappone al viaggio;
//  · avvisi senza periodo (guasti, ritardi del momento): solo se sono in corso adesso e il viaggio parte entro 3 ore;
//  · sciopero: avviso di rete (senza linee), vale per ogni viaggio nel suo periodo; esclusi gli avvisi risolti e quelli generali.
// Il server pubblica gli avvisi in corso e quelli che iniziano entro 3 giorni: per viaggi più lontani l'elenco può essere incompleto.
const SEV_ORD = { severe: 0, warning: 1, info: 2 };
export function forJourney({ lines = [], stops = [], fromMs, toMs }, t = now()) {
  const lk = new Set(lines.map(l => lineKey(l.s, l.n))), sk = new Set(stops), out = [];
  for (const a of data?.items || []) {
    if (a.resolved || a.effect === 'resolved') continue;
    const strike = a.effect === 'strike';
    if (a.general && !strike) continue;
    const byL = a.ambito !== 'fermate' && (a.lines || []).some(l => lk.has(lineKey(l.s, l.n)));   // avviso di fermata: solo se la soluzione usa quella fermata
    if (!(strike ? a.dated : byL || (a.stops || []).some(id => sk.has(id)))) continue;
    if (a.dated || a.source === 'auto') { if (!overlaps(a, fromMs, toMs)) continue; }
    else if (!(a.from <= t && a.to >= t && fromMs <= t + 3 * 3600e3 && a.to >= fromMs)) continue;
    out.push(a);
  }
  return out.sort((a, b) => (SEV_ORD[a.severity] ?? 1) - (SEV_ORD[b.severity] ?? 1) || a.from - b.from).slice(0, 6);
}
// triangolo (mappa, titolo della fermata, riga del passaggio): solo avvisi gravi o di attenzione, non quelli informativi
const isAlarm = a => isWarn(a) && a.severity !== 'info';
export const lineHasAlert = (s, n) => (byLine.get(lineKey(s, n)) || []).some(isAlarm);
export const hasAlert = id => (byStop.get(id) || []).some(isAlarm);
export const anyAlarm = list => list.some(isAlarm);
const sevIcon = a => icon(a.severity === 'info' ? 'info' : 'warn', 'sm');
const effTag = a => (a.effectLabel ? `<span class="av-eff" data-sev="${esc(a.severity || 'warning')}">${esc(a.effectLabel)}</span>` : '');
// avviso di acqua alta da aprire dal pannello della marea: prima quello ufficiale, poi quello automatico (in corso o in arrivo)
export const waterAlertId = () => { const l = (data?.items || []).filter(a => a.water && a.to >= now()); return (l.find(a => a.source !== 'auto') || l[0])?.id || null; };
// riga cliccabile per il pannello di una fermata: apre l'avviso nella finestra
// riga cliccabile (pannello fermata e pannello mezzo): apre l'avviso nella finestra. "only" = linee da citare (quelle della fermata o del mezzo)
export const rowHtml = (a, only = null) => {
  const ls = (a.lines || []).filter(l => !only || only.has(lineKey(l.s, l.n))).map(l => l.n);
  const ln = ls.length ? `${ls.length === 1 ? 'Linea' : 'Linee'} ${ls.slice(0, 4).join(', ')}${ls.length > 4 ? '…' : ''} · ` : '';
  return `<button type="button" class="alert-row" data-av="${esc(a.id)}" data-sev="${esc(a.severity || 'warning')}">${sevIcon(a)}<span>${effTag(a)}<b>${esc(a.title)}</b><small>${esc(ln + validity(a))} · tocca per leggere</small></span></button>`;
};
export const keyOf = lineKey;

// ---- SCIOPERO (v33.3): scheda iniziale, pulsante sulla mappa, note nei pannelli e nel pianificatore ----
const KEY_SC = 'tpl.sciopero', SC_REPEAT_MS = 6 * 3600e3;
const strikes = () => (data?.items || []).filter(okSc);
// sciopero da mettere in evidenza adesso (da 8 ore prima dell'inizio alle 05:00 del giorno dopo)
export const strikeNow = (t = now()) => strikes().find(a => t >= a.sciopero.da && t <= a.sciopero.fino) || null;
// sciopero che tocca un intervallo (un viaggio, le partenze di una fermata)
export const strikeFor = (x, y) => strikes().find(a => a.sciopero.inizio <= y && a.sciopero.fino >= x) || null;
const scSig = a => [a.id, a.updated || 0, a.sciopero.inizio, (a.sciopero.fasce || []).join(','), (a.sciopero.link || []).map(l => l.url).join(',')].join('|');
// la scheda si apre da sola una volta per comunicato; di nuovo se il comunicato cambia o dopo 6 ore
export function strikeShouldOpen(a, t = now()) {
  let s = null; try { s = JSON.parse(localStorage.getItem(KEY_SC) || 'null'); } catch { s = null; }
  return !s || s.sig !== scSig(a) || !(t - s.at < SC_REPEAT_MS);
}
export function strikeSeen(a, t = now()) { try { localStorage.setItem(KEY_SC, JSON.stringify({ sig: scSig(a), at: t })); } catch { /* facoltativo */ } }
const longDay = ms => new Date(ms).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
const scPhase = (a, t = now()) => (t < a.sciopero.inizio ? 'prima' : t <= a.sciopero.fine ? 'durante' : 'dopo');
export function strikeTitle(a, t = now()) {
  const p = scPhase(a, t), d = longDay(a.sciopero.inizio);
  return p === 'prima' ? `Sciopero ${sameDay(a.sciopero.inizio, t + 864e5) && !sameDay(a.sciopero.inizio, t) ? 'domani' : d}` : p === 'durante' ? 'Sciopero in corso' : 'Sciopero appena terminato';
}
const scLinks = a => (a.sciopero.link || []).filter(l => safeUrl(l.url))
  .map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${icon('ext', 'sm')}<span>${esc(l.label || 'Avviso ACTV')}</span></a></li>`).join('');
// aggiornamenti del giorno dal canale Telegram ACTV (corse aggiuntive, effettuate o soppresse): sempre dentro la scheda dello sciopero
const scUpd = a => (a.sciopero.aggiornamenti || []).filter(u => u && u.testo).slice(0, 4);
const scUpdHtml = a => { const u = scUpd(a); return u.length ? `<div class="st-upd"><p><b>Aggiornamenti ACTV sulle corse</b></p><ul>${u.map(x => `<li><small>${esc(Number.isFinite(x.at) ? `${dayOf(x.at)}, ${hmOf(x.at)}` : '')}</small> ${esc(x.testo)}${safeUrl(x.url) ? ` <a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${icon('ext', 'sm')}<span>messaggio</span></a>` : ''}</li>`).join('')}</ul></div>` : ''; };
// contenuto della scheda (tutto il testo passa da esc; link solo ACTV/Telegram)
export function strikeCardHtml(a, t = now()) {
  const x = a.sciopero, p = scPhase(a, t), f = x.fasce || [];
  const quando = `${longDay(x.inizio).replace(/^./, c => c.toUpperCase())}${sameDay(x.inizio, x.fine) ? '' : ` – ${longDay(x.fine)}`}`;
  const lead = p === 'dopo' ? `Lo sciopero è terminato: il servizio torna regolare con le prime corse del mattino. Fino alle ${hmOf(x.fino)} alcune corse notturne o del primo mattino possono mancare.`
    : 'A causa dello sciopero le corse non sono regolari.';
  return `<p class="st-when"><b>${esc(quando)}</b>${p === 'prima' ? ` · inizia ${esc(hmOf(x.inizio) === '0:00' ? 'a inizio giornata' : 'alle ' + hmOf(x.inizio))}` : ''}</p>`
    + `<p class="st-lead">${esc(lead)}</p>`
    + `<p>Gli orari che vedi nell'app sono quelli <b>programmati</b> (o previsti dal tempo reale, dove i mezzi trasmettono la posizione): <b>non tutte le corse sono garantite o effettuate</b>.</p>`
    + (f.length ? `<p class="st-fasce">Fasce garantite indicate da ACTV: <b>${f.map(([s, e]) => `${esc(s)}–${esc(e)}`).join(' · ')}</b>. Controlla nel comunicato a quali servizi si riferiscono (autobus, tram, navigazione).</p>` : '')
    + `<p>Per le fasce di garanzia e gli aggiornamenti fa fede ACTV:</p><ul>${scLinks(a) || '<li>Comunicato non disponibile: controlla il sito ACTV.</li>'}</ul>`
    + scUpdHtml(a)
    + `<p class="muted">Puoi riaprire questa scheda dal pulsante «Sciopero» sulla mappa.</p>`;
}
// nota per i pannelli fermata/corsa e per il pianificatore (data-sciopero apre la scheda)
export function strikeNoteHtml(a, ctx = 'orari') {
  if (!a) return '';
  const day = dayOf(a.sciopero.inizio);
  const u = scUpd(a)[0], agg = u && Number.isFinite(u.at) ? ` Ultimo aggiornamento ACTV alle ${hmOf(u.at)}.` : '';
  const txt = ctx === 'viaggio' ? 'il viaggio cade durante lo sciopero: le corse indicate possono non essere effettuate.' : 'gli orari mostrati sono programmati e alcune corse possono essere soppresse.';
  return `<p class="strike-note" role="note">${icon('strike', 'sm')}<span><b>Sciopero ${esc(day)}</b>: ${esc(txt + agg)} <button type="button" class="nlink" data-sciopero>Dettagli e fasce garantite</button></span></p>`;
}

function render() {
  const items = data?.items || [], act = items.filter(isActive), up = items.filter(a => !isActive(a));
  cnt.textContent = act.length ? String(act.length) : ''; cnt.hidden = !act.length;
  const label = act.length ? `Avvisi di servizio: ${act.length} in corso` : 'Avvisi di servizio: nessuno in corso';
  btn.setAttribute('aria-label', label); btn.title = label;
  if (card.hidden) return;
  if (!data) { body.innerHTML = err ? `<p class="av-note">Avvisi non disponibili: ${esc(err)}</p>` : 'Caricamento…'; return; }
  const item = a => {
    const links = [safeUrl(a.url) && `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${/^https:\/\/(t|telegram)\.me\//.test(a.url) ? 'Apri il messaggio' : 'Leggi l\'avviso completo'}</a>`,
      a.tgUrl && a.tgUrl !== a.url && safeUrl(a.tgUrl) && `<a href="${esc(a.tgUrl)}" target="_blank" rel="noopener noreferrer">Messaggio Telegram</a>`].filter(Boolean).join('');
    return `<article class="av${a.id === highlight ? ' hl' : ''}${a.resolved ? ' ok' : ''}" id="av-${esc(a.id)}"><div class="av-top"><span class="av-src">${a.resolved ? icon('check', 'sm') : ''}${esc(SRC[a.source] || '')}</span>${effTag(a)}<span class="av-when">${esc(validity(a))}</span></div>`
      + `<h3>${esc(a.title)}</h3>${a.text ? `<p>${esc(a.text)}</p>` : ''}`
      + (a.water ? `<div class="av-plan"><strong>Piano acqua alta ACTV per +${esc(a.water.level)} cm</strong>${waterSrc(a.water)}<ul>${(a.water.plan || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul><a href="${esc(a.water.url)}" target="_blank" rel="noopener noreferrer">Servizi di navigazione previsti</a> · verifica sempre l'avviso ufficiale.</div>` : '')
      + ((a.lines || []).length ? `<div class="av-lines"><span class="muted">Linee</span>${a.lines.map(l => badge(l.n, l.c, l.s)).join('')}</div>` : '')
      + ((a.stopNames || []).length ? `<div class="av-stops"><span class="muted">${a.stopNames.length === 1 ? 'Fermata' : 'Fermate'} ${icon('warn', 'sm')}</span>${a.stopNames.map(s => `<span class="av-stop">${srcIcon(s.s, 'sm')}${esc(s.n)}</span>`).join('')}</div>` : '')
      + (okSc(a) ? (scLinks(a) ? `<ul class="st-links">${scLinks(a)}</ul>` : '') + scUpdHtml(a) : '')
      + (links && !okSc(a) ? `<div class="av-links">${links}</div>` : '') + '</article>';
  };
  body.innerHTML = (data.salvati ? `<p class="av-note" role="status"><b>Senza connessione: avvisi salvati</b> alle ${new Date(data.salvati).toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', hour: '2-digit', minute: '2-digit' })}. Potrebbero essere cambiati.</p>` : '')
    + (data.stale && !data.salvati ? '<p class="av-note" role="status">Gli avvisi non si aggiornano da un po\': potrebbero non essere completi.</p>' : '')
    + (act.length ? `<h2 class="av-h">In corso</h2>${act.map(item).join('')}` : '<p class="muted pad">Nessun avviso in corso.</p>')
    + (up.length ? `<h2 class="av-h">In arrivo</h2>${up.map(item).join('')}` : '')
    + '<p class="tide-foot">Fonti: notizie del sito ACTV e canale Telegram ufficiale «AVM/Actv Venezia». Raccolta automatica: per le informazioni ufficiali fa fede il sito ACTV.</p>';
  if (highlight) { const el = body.querySelector('.hl'); if (el) el.scrollIntoView({ block: 'start' }); }
}
// SENZA RETE: ultimi avvisi validi salvati nel telefono (24 ore al massimo), mostrati con l'ora del salvataggio
const SALVA = 'tpl.avvisi', MAX_SALVATI = 24 * 3600e3;
async function load() {
  try {
    const d = await api('/api/avvisi'); if (d.error) throw new Error(d.error); data = d; err = null; reindex();
    try { localStorage.setItem(SALVA, JSON.stringify({ t: Date.now(), d })); } catch { /* memoria piena o non disponibile */ }
  } catch (e) {
    if (!e.busy) err = e.message;
    if (!e.busy && (!data || data.salvati)) {
      try { const s = JSON.parse(localStorage.getItem(SALVA) || 'null'); if (s?.d?.items && Date.now() - s.t < MAX_SALVATI) { data = { ...s.d, salvati: s.t }; reindex(); } } catch { /* niente */ }
    }
  }
  render(); onChange();
}
function position() {                                                // allineata al pulsante, come la scheda della marea
  const w = $('wrap').getBoundingClientRect(), b = btn.getBoundingClientRect(), h = card.offsetHeight, g = 12;
  card.style.top = Math.max(g, Math.min(b.top - w.top - 8, w.height - h - g)) + 'px';
}
export const isOpen = () => !card.hidden;
export function open(id = null, beforeOpen) {
  if (beforeOpen) beforeOpen();
  highlight = id; card.hidden = false; btn.setAttribute('aria-expanded', 'true'); render(); position(); card.focus({ preventScroll: true }); load();
}
export function close() { if (card.hidden) return; card.hidden = true; highlight = null; btn.setAttribute('aria-expanded', 'false'); }
let before = () => {};
export function init(beforeOpen, changed) {
  before = beforeOpen || before; onChange = changed || onChange;
  btn.onclick = () => (card.hidden ? open(null, before) : close());
  $('avvisi-close').onclick = () => { close(); btn.focus(); };
  window.addEventListener('resize', () => { if (!card.hidden) position(); });
  load(); timer = setInterval(() => { if (!document.hidden) load(); }, 120000);
}
export const openAlert = id => open(id, before);
