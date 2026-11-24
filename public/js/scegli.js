// SCELTA DEL GIORNO E DELL'ORA (v28), al posto dei selettori del browser.
// Perché: i selettori nativi cambiano da browser a browser, in alcuni casi escono dallo schermo (finestra del calendario aperta in fondo
// alla pagina) e la loro icona può sparire con il tema scuro. Questi sono dell'app: stesso aspetto ovunque, icone con il contrasto del tema,
// sempre dentro lo schermo (sul telefono foglio dal basso, sul computer finestrella accanto al campo, spostata se non c'è posto).
// Accessibili: finestra di dialogo, Esc chiude, frecce per muoversi tra i giorni, il fuoco torna al campo.
import { esc, icon, romeP } from './util.js';

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const GG = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const todayIso = () => romeP().iso;
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

// testo del campo: «Oggi», «Domani», altrimenti «lun 17/11»
export function dayLabel(s) {
  if (!s || s === todayIso()) return 'Oggi';
  if (s === addDays(todayIso(), 1)) return 'Domani';
  const d = parse(s); return d ? `${GG[(d.getUTCDay() + 6) % 7]} ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}` : s;
}

let cur = null;
export function close(restore = true) {
  if (!cur) return;
  const { back, box, anchor, onResize, onKey } = cur; cur = null;
  back.remove(); box.remove();
  removeEventListener('resize', onResize); document.removeEventListener('keydown', onKey, true);
  if (restore && anchor?.isConnected) anchor.focus({ preventScroll: true });
}
export const isOpen = () => !!cur;

function place(box, anchor) {
  const vw = innerWidth, vh = innerHeight;
  box.classList.toggle('sheet', vw <= 640);
  if (vw <= 640) { box.style.left = box.style.top = ''; return; }
  const r = anchor.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
  let top, left;
  if (r.bottom + 6 + h <= vh - 8) { top = r.bottom + 6; left = r.left; }              // sotto il campo
  else if (r.top - 6 - h >= 8) { top = r.top - 6 - h; left = r.left; }                 // sopra
  else {                                                                               // né sotto né sopra: accanto, senza coprire il campo
    left = r.right + 8 + w <= vw - 8 ? r.right + 8 : r.left - 8 - w;
    top = r.top + r.height / 2 - h / 2;
  }
  box.style.left = Math.max(8, Math.min(left, vw - w - 8)) + 'px'; box.style.top = Math.max(8, Math.min(top, vh - h - 8)) + 'px';
}
function open(anchor, label, render, keys) {
  close(false);
  const back = document.createElement('div'), box = document.createElement('div');
  back.className = 'sc-back'; box.className = 'sc';
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', label);
  document.body.append(back, box);
  const onResize = () => place(box, anchor);
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else keys?.(e); };
  cur = { back, box, anchor, onResize, onKey };
  back.addEventListener('click', () => close());
  addEventListener('resize', onResize); document.addEventListener('keydown', onKey, true);
  render(box); place(box, anchor);
  return box;
}

// GIORNO: calendario del mese, giorni fuori dalle date con orari disattivati; «Oggi» e «Domani» in un tocco
export function giorno(anchor, { value, min, max, onPick, label = 'Scegli il giorno' }) {
  const t = todayIso(), ok = s => (!min || s >= min) && (!max || s <= max);
  let view = (parse(value) || parse(t)); view = new Date(Date.UTC(view.getUTCFullYear(), view.getUTCMonth(), 1));
  const pick = s => { if (!ok(s)) return; close(); onPick(s); };
  const draw = box => {
    const y = view.getUTCFullYear(), m = view.getUTCMonth(), first = (view.getUTCDay() + 6) % 7, n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const prevOk = !min || iso(new Date(Date.UTC(y, m, 0))) >= min, nextOk = !max || iso(new Date(Date.UTC(y, m + 1, 1))) <= max;
    let cells = '';
    for (let k = 0; k < first; k++) cells += '<span></span>';
    for (let d = 1; d <= n; d++) {
      const s = `${y}-${pad(m + 1)}-${pad(d)}`, on = s === value;
      cells += `<button type="button" class="sc-d${on ? ' on' : ''}${s === t ? ' today' : ''}" data-d="${s}"${ok(s) ? '' : ' disabled'} aria-pressed="${on}" aria-label="${d} ${MESI[m]}${s === t ? ', oggi' : ''}" tabindex="${on || (!value && s === t) ? 0 : -1}">${d}</button>`;
    }
    const quick = [[t, 'Oggi'], [addDays(t, 1), 'Domani']].filter(([s]) => ok(s));
    box.innerHTML = `<div class="sc-h">${icon('cal')}<b>${esc(label)}</b><button type="button" class="ibtn sm sc-x" aria-label="Chiudi">${icon('close')}</button></div>`
      + (quick.length ? `<div class="sc-q">${quick.map(([s, l]) => `<button type="button" class="chip${s === value ? ' on' : ''}" data-d="${s}">${l}</button>`).join('')}</div>` : '')
      + `<div class="sc-m"><button type="button" class="ibtn sm" data-mv="-1" aria-label="Mese precedente"${prevOk ? '' : ' disabled'}>${icon('back')}</button>`
      + `<b aria-live="polite">${MESI[m]} ${y}</b><button type="button" class="ibtn sm" data-mv="1" aria-label="Mese successivo"${nextOk ? '' : ' disabled'}>${icon('next')}</button></div>`
      + `<div class="sc-w" aria-hidden="true">${GG.map(g => `<span>${g.slice(0, 2)}</span>`).join('')}</div><div class="sc-g" role="group" aria-label="${MESI[m]} ${y}">${cells}</div>`;
    box.querySelector('.sc-x').onclick = () => close();
    box.querySelectorAll('[data-mv]').forEach(b => { b.onclick = () => { view = new Date(Date.UTC(y, m + +b.dataset.mv, 1)); draw(box); place(box, anchor); box.querySelector(`[data-mv="${b.dataset.mv}"]`)?.focus(); }; });
    box.querySelectorAll('[data-d]').forEach(b => { b.onclick = () => pick(b.dataset.d); });
  };
  const box = open(anchor, label, draw, e => {                     // frecce: giorno prima/dopo, settimana prima/dopo
    const a = document.activeElement; if (!a?.matches?.('.sc-d')) return;
    const dd = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]; if (!dd) return;
    e.preventDefault();
    const s = addDays(a.dataset.d, dd); if (!ok(s)) return;
    const d = parse(s);
    if (d.getUTCMonth() !== view.getUTCMonth()) { view = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); draw(cur.box); place(cur.box, anchor); }
    cur.box.querySelector(`.sc-d[data-d="${s}"]`)?.focus();
  });
  (box.querySelector('.sc-d.on:not([disabled])') || box.querySelector('.sc-d.today:not([disabled])') || box.querySelector('.sc-d:not([disabled])'))?.focus({ preventScroll: true });
}

// ORA: due colonne (ore, minuti a passi di `step`), scorciatoie («Adesso», «+15 min», «+1 ora»), «Fatto» conferma
export function ora(anchor, { value, step = 5, onPick, label = 'Scegli l\'ora' }) {
  const now = () => { const d = romeP(Date.now() + (step * 60000 - 1)); return [d.h, Math.floor(d.mi / step) * step]; };
  let [h, mi] = /^(\d{1,2}):(\d{2})$/.test(value || '') ? value.split(':').map(Number) : now();
  mi = Math.round(mi / step) * step; if (mi >= 60) { mi = 0; h = (h + 1) % 24; }
  const txt = () => `${pad(h)}:${pad(mi)}`;
  const shift = min => { const t = (h * 60 + mi + min + 1440) % 1440; h = Math.floor(t / 60); mi = Math.floor(t % 60 / step) * step; };
  const draw = (box, focusCol = null) => {
    const hs = Array.from({ length: 24 }, (_, k) => k), ms = Array.from({ length: 60 / step }, (_, k) => k * step);
    box.innerHTML = `<div class="sc-h">${icon('clock')}<b>${esc(label)}</b><button type="button" class="ibtn sm sc-x" aria-label="Chiudi">${icon('close')}</button></div>`
      + `<div class="sc-q"><button type="button" class="chip" data-q="now">Adesso</button><button type="button" class="chip" data-q="15">+15 min</button><button type="button" class="chip" data-q="60">+1 ora</button></div>`
      + `<div class="sc-t" aria-live="polite">${txt()}</div>`
      + `<div class="sc-cols"><div class="sc-col" role="listbox" aria-label="Ore">${hs.map(x => `<button type="button" role="option" class="sc-o${x === h ? ' on' : ''}" data-h="${x}" aria-selected="${x === h}">${pad(x)}</button>`).join('')}</div>`
      + `<div class="sc-col" role="listbox" aria-label="Minuti">${ms.map(x => `<button type="button" role="option" class="sc-o${x === mi ? ' on' : ''}" data-m="${x}" aria-selected="${x === mi}">${pad(x)}</button>`).join('')}</div></div>`
      + `<div class="sc-f"><button type="button" class="btn sc-ok">Fatto</button></div>`;
    box.querySelector('.sc-x').onclick = () => close();
    box.querySelector('.sc-ok').onclick = () => { const v = txt(); close(); onPick(v); };
    box.querySelectorAll('[data-q]').forEach(b => { b.onclick = () => { if (b.dataset.q === 'now') [h, mi] = now(); else shift(+b.dataset.q); draw(box); }; });
    box.querySelectorAll('[data-h]').forEach(b => { b.onclick = () => { h = +b.dataset.h; draw(box, 'h'); }; });
    box.querySelectorAll('[data-m]').forEach(b => { b.onclick = () => { mi = +b.dataset.m; draw(box, 'm'); }; });
    for (const el of box.querySelectorAll('.sc-o.on')) el.parentNode.scrollTop = el.offsetTop - el.parentNode.clientHeight / 2 + el.offsetHeight / 2;   // selezione al centro
    if (focusCol) box.querySelector(`.sc-o.on[data-${focusCol}]`)?.focus({ preventScroll: true });
  };
  const box = open(anchor, label, b => draw(b), e => {
    const a = document.activeElement; if (!a?.matches?.('.sc-o')) return;
    const d = { ArrowUp: -1, ArrowDown: 1 }[e.key]; if (!d) return;
    e.preventDefault();
    if (a.dataset.h != null) { h = (h + d + 24) % 24; draw(cur.box, 'h'); } else { mi = (mi + d * step + 60) % 60; draw(cur.box, 'm'); }
  });
  box.querySelector('.sc-ok').focus({ preventScroll: true });
}
