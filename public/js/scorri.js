// TESTI SU UNA RIGA CHE NON ENTRANO: scorrono avanti e indietro (circa 28 px/s, pause agli estremi) invece di essere tagliati coi puntini.
// Vale in tutta l'app e con ogni dimensione del testo: destinazioni e righe dei passaggi, fermate della corsa, titolo del pannello, campi e
// riepiloghi del pianificatore, righe degli avvisi nei pannelli, preferiti, «torna a…».
//  · si ricalcola da solo quando cambia il contenuto (MutationObserver), la larghezza (ResizeObserver: rotazione, pannello, finestra) o la
//    dimensione del testo scelta nelle Informazioni (tutto());
//  · la fase dell'animazione dipende dall'orologio: gli aggiornamenti ogni pochi secondi non la fanno ripartire da capo;
//  · un testo che entra non si muove; con «riduci movimento» (impostazione del sistema) niente animazioni: puntini come prima.
// Costo: una lettura delle misure e una scrittura per giro, solo nei contenitori osservati e solo quando cambiano.
const SEL = '.dh,.nm,.d1n,.ph-tx,.dn>span:last-child,.alert-row small,.linkback span,.pp-v>span,.pp-sum-p>span,.pp-sum-w,.pp-hs,.fv-n,.fv-t small';
const still = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

export function run(root) {
  if (!root || !root.isConnected || still()) return;
  // 1) i testi da far scorrere che non hanno ancora il loro «nastro» (span.mq): lo si aggiunge solo se il testo non entra
  for (const h of root.querySelectorAll(SEL)) {
    if (h.firstElementChild?.classList.contains('mq') && h.childNodes.length === 1) continue;
    if (h.querySelector(':scope > .mq') || h.scrollWidth - h.clientWidth <= 2 || !h.childNodes.length) continue;
    const s = document.createElement('span'); s.className = 'mq'; s.append(...h.childNodes); h.append(s);
  }
  // 2) misure (tutte le letture insieme), poi animazioni (tutte le scritture insieme)
  const items = [...root.querySelectorAll('.mq')].map(el => { const box = el.parentElement; return { el, box, over: box ? box.scrollWidth - box.clientWidth : 0 }; });
  for (const { el, box, over } of items) {
    if (!box) continue;
    if (over <= 2) { if (el.classList.contains('run')) { el.classList.remove('run'); el.style.animationDuration = ''; el.style.removeProperty('--mq-d'); } box.classList.remove('mq-on'); continue; }
    const d = `-${Math.round(over + 6)}px`;
    if (el.classList.contains('run') && el.style.getPropertyValue('--mq-d') === d) continue;   // già giusto: non ripartire
    const t = Math.max(3, over / 28 + 1.5);                                  // secondi per un passaggio
    el.classList.add('run'); box.classList.add('mq-on'); el.style.setProperty('--mq-d', d);
    el.style.animationDuration = t.toFixed(2) + 's'; el.style.animationDelay = `-${((Date.now() / 1000) % (2 * t)).toFixed(2)}s`;
  }
}

const roots = new Set(), queued = new Set();
let raf = 0;
function schedule(r) {
  if (!r) return; queued.add(r);
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; const q = [...queued]; queued.clear(); for (const x of q) run(x); });
}
const rootOf = n => { for (let x = n; x; x = x.parentNode) if (roots.has(x)) return x; return null; };
const mo = typeof MutationObserver === 'function' ? new MutationObserver(recs => {
  for (const rec of recs) {
    const a = rec.addedNodes;
    if (a.length === 1 && a[0].nodeType === 1 && a[0].classList.contains('mq') && rec.target.matches?.(SEL)) continue;   // il nastro aggiunto qui sopra
    schedule(rootOf(rec.target));
  }
}) : null;
const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(es => { for (const e of es) schedule(e.target); }) : null;

// contenitori da seguire (pannello, titolo, preferiti, risultati della ricerca…)
export function watch(...els) {
  for (const el of els) {
    if (!el || roots.has(el)) continue;
    roots.add(el); mo?.observe(el, { childList: true, subtree: true }); ro?.observe(el); schedule(el);
  }
}
// tutto da ricalcolare (dimensione del testo cambiata, caratteri caricati, «riduci movimento» cambiato)
export function tutto() { for (const r of roots) schedule(r); }
try { matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { for (const r of roots) for (const el of r.querySelectorAll('.mq.run')) { el.classList.remove('run'); el.parentElement?.classList.remove('mq-on'); } tutto(); }); } catch { /* vecchi browser */ }
document.fonts?.ready?.then(tutto).catch(() => {});
