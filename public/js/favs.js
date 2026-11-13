// PANNELLO PREFERITI (stella in basso a destra, sopra la campanella e la «i»): fermate e percorsi salvati, divisi in due schede.
//  · un tocco apre la fermata o il percorso; «Modifica» permette di riordinare, rinominare (percorsi) ed eliminare;
//  · copia di sicurezza: «Salva una copia» scarica un file con i preferiti, «Ripristina» lo rilegge e lo unisce a quelli presenti
//    (utile cambiando telefono o browser, o dopo aver cancellato i dati del sito). Nessun dato esce dal dispositivo.
// Tutti i testi che arrivano dalla memoria del browser passano da esc(): non sono mai HTML.
import { $, esc, icon, srcIcon } from './util.js';
import * as Fav from './fav.js';

const btn = $('favs-btn'), card = $('favs'), body = $('favs-body'), file = $('favs-file');
let tab = 'stops', edit = false, renaming = null, before = () => {}, X = { openStop: () => {}, openRoute: () => {}, toast: () => {} };
const TAB_KEY = 'tpl.preferiti.scheda';
try { if (localStorage.getItem(TAB_KEY) === 'routes') tab = 'routes'; } catch { /* facoltativo */ }

export const isOpen = () => !card.hidden;
export function open(which) {
  before(); if (which) tab = which;
  card.hidden = false; btn.setAttribute('aria-expanded', 'true'); edit = false; renaming = null; render(); position(); card.focus({ preventScroll: true });
}
export function close() { if (card.hidden) return; card.hidden = true; btn.setAttribute('aria-expanded', 'false'); edit = false; renaming = null; }
export const refresh = () => { if (!card.hidden) render(); };
// in basso, allineata al pulsante (come marea e avvisi lo sono ai loro)
function position() {
  const w = $('wrap').getBoundingClientRect(), b = btn.getBoundingClientRect(), h = card.offsetHeight, g = 12;
  card.style.top = Math.max(g, Math.min(b.bottom - w.top - h, w.height - h - g)) + 'px';
}

const routeIcon = ep => (ep.kind === 'me' ? icon('locate', 'sm') : ep.kind === 'point' ? icon('pin', 'sm') : srcIcon(ep.src, 'sm'));
function render() {
  for (const t of card.querySelectorAll('[data-tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
  const stops = Fav.all(), routes = Fav.allRoutes(), list = tab === 'stops' ? stops : routes, n = list.length;
  let h = '';
  if (!n) h = tab === 'stops'
    ? `<p class="fv-empty">${icon('star')}<span>Nessuna fermata preferita.<small>Apri una fermata e tocca la stella nella linguetta del pannello.</small></span></p>`
    : `<p class="fv-empty">${icon('route')}<span>Nessun percorso salvato.<small>Nel pianificatore scegli partenza e arrivo, poi tocca la stella.</small></span></p>`;
  else h = `<ul class="fv-list${edit ? ' editing' : ''}">` + list.map((x, i) => {
    const main = tab === 'stops'
      ? `${srcIcon(x.src)}<span class="fv-t">${esc(x.name)}</span>`
      : `${icon('route')}<span class="fv-t">${esc(Fav.routeTitle(x))}${x.name ? `<small>${routeIcon(x.from)}${esc(x.from.label)} → ${routeIcon(x.to)}${esc(x.to.label)}</small>` : ''}</span>`;
    if (!edit) return `<li><button type="button" class="fv-it" data-open="${esc(x.k)}">${main}${icon('next', 'sm fv-go')}</button></li>`;
    const ren = tab === 'routes' && renaming === x.k
      ? `<form class="fv-ren" data-k="${esc(x.k)}"><span class="xwrap"><input type="text" maxlength="60" value="${esc(x.name || '')}" placeholder="Nome (es. Casa → Lavoro)" aria-label="Nome del percorso"><button type="button" class="ibtn sm xbtn" data-x aria-label="Cancella il testo"${x.name ? '' : ' hidden'}>${icon('close', 'sm')}</button></span><button type="submit" class="nlink">Salva</button></form>` : '';
    return `<li class="fv-ed"><span class="fv-it static">${main}</span><span class="fv-acts">`
      + (tab === 'routes' ? `<button type="button" class="ibtn sm" data-ren="${esc(x.k)}" aria-label="Rinomina">${icon('edit', 'sm')}</button>` : '')
      + `<button type="button" class="ibtn sm" data-mv="-1" data-k="${esc(x.k)}" aria-label="Sposta su"${i ? '' : ' disabled'}>${icon('up', 'sm')}</button>`
      + `<button type="button" class="ibtn sm" data-mv="1" data-k="${esc(x.k)}" aria-label="Sposta giù"${i < n - 1 ? '' : ' disabled'}>${icon('down', 'sm')}</button>`
      + `<button type="button" class="ibtn sm fv-del" data-del="${esc(x.k)}" aria-label="Elimina">${icon('trash', 'sm')}</button></span>${ren}</li>`;
  }).join('') + '</ul>';
  h += `<div class="fv-foot">${n ? `<button type="button" class="nlink" data-edit>${edit ? 'Fine' : `${icon('edit', 'sm')}Modifica`}</button>` : '<span></span>'}`
    + `<span class="fv-bk"><button type="button" class="nlink" data-export title="Scarica un file con i preferiti">${icon('download', 'sm')}Salva una copia</button>`
    + `<button type="button" class="nlink" data-import title="Ripristina i preferiti da un file salvato">${icon('upload', 'sm')}Ripristina</button></span></div>`;
  body.innerHTML = h;
  const inp = body.querySelector('.fv-ren input'); if (inp) inp.focus();
}

function exportFile() {
  const blob = new Blob([JSON.stringify(Fav.exportData(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a'), d = new Date();
  a.href = URL.createObjectURL(blob); a.download = `preferiti-tpl-venezia-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  X.toast('Copia dei preferiti salvata nei download.', 3500);
}
async function importFile(f) {
  if (!f) return;
  if (f.size > 200000) { X.toast('File troppo grande: non è una copia dei preferiti.', 5000); return; }
  try { const r = Fav.importData(JSON.parse(await f.text())); X.toast(`Ripristinati ${r.fermate} ${r.fermate === 1 ? 'fermata' : 'fermate'} e ${r.percorsi} ${r.percorsi === 1 ? 'percorso' : 'percorsi'} (quelli già presenti restano).`, 6000); X.changed?.(); }
  catch (e) { X.toast('Ripristino non riuscito: ' + e.message + '.', 6000); }
  render();
}

export function init(beforeOpen, ctx) {
  before = beforeOpen || before; X = { ...X, ...ctx };
  btn.onclick = () => (card.hidden ? open() : close());
  $('favs-close').onclick = () => { close(); btn.focus(); };
  card.querySelector('.fv-tabs').addEventListener('click', e => {
    const t = e.target.closest('[data-tab]'); if (!t) return;
    tab = t.dataset.tab; edit = false; renaming = null; try { localStorage.setItem(TAB_KEY, tab); } catch { /* facoltativo */ } render();
  });
  card.querySelector('.fv-tabs').addEventListener('keydown', e => {   // schede: frecce sinistra/destra (WAI-ARIA tabs)
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    tab = tab === 'stops' ? 'routes' : 'stops'; render(); card.querySelector(`[data-tab="${tab}"]`)?.focus();
  });
  body.addEventListener('click', e => {
    const t = e.target;
    const o = t.closest('[data-open]'); if (o) { const k = o.dataset.open; close(); if (tab === 'stops') X.openStop(k); else X.openRoute(k); return; }
    if (t.closest('[data-edit]')) { edit = !edit; renaming = null; render(); return; }
    if (t.closest('[data-export]')) { exportFile(); return; }
    if (t.closest('[data-import]')) { file.value = ''; file.click(); return; }
    const mv = t.closest('[data-mv]'); if (mv) { (tab === 'stops' ? Fav.move : Fav.moveRoute)(mv.dataset.k, +mv.dataset.mv); X.changed?.(); render(); return; }
    const del = t.closest('[data-del]'); if (del) { (tab === 'stops' ? Fav.remove : Fav.removeRoute)(del.dataset.del); X.changed?.(); render(); return; }
    const ren = t.closest('[data-ren]'); if (ren) { renaming = renaming === ren.dataset.ren ? null : ren.dataset.ren; render(); }
  });
  body.addEventListener('submit', e => {
    const f = e.target.closest('.fv-ren'); if (!f) return; e.preventDefault();
    Fav.renameRoute(f.dataset.k, f.querySelector('input').value); renaming = null; X.changed?.(); render();
  });
  file.addEventListener('change', () => importFile(file.files?.[0]));
}
