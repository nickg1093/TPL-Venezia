// NAVIGAZIONE CON IL TASTO E IL GESTO «INDIETRO» DEL SISTEMA (Android, iPhone/iPad, browser del computer).
// L'app è una pagina sola: ogni livello aperto (pannello della fermata o della corsa, pagina del pianificatore, finestre di avvisi, marea,
// preferiti e informazioni, ricerca) corrisponde a una voce nella cronologia del browser. «Indietro» chiude il livello più in alto, oppure
// torna al pannello precedente; con nulla aperto, esce dall'app come sempre.
//   · levels(): quanti livelli sono aperti adesso (calcolato da app.js sullo stato reale dell'interfaccia);
//   · back(): chiude il livello più in alto (stesso ordine del tasto Esc);
//   · sync(): da chiamare dopo ogni cambiamento dell'interfaccia: aggiunge o toglie voci perché la cronologia corrisponda ai livelli aperti.
// Le voci non cambiano l'indirizzo della pagina (nessun #frammento) e non contengono dati.
// PROTEZIONE DALL'USCITA PER SBAGLIO (app installata, Android e computer; non su iPhone/iPad, dove l'app installata non ha il gesto «indietro»):
// con niente aperto, il primo «indietro» non chiude l'app ma mostra «Premi di nuovo indietro per uscire»; il secondo esce come sempre.
// Funziona con una voce di cronologia in più, aggiunta AL PRIMO TOCCO: Chrome e Safari saltano le voci aggiunte senza un gesto dell'utente
// (history manipulation intervention). Dopo l'avviso la voce si riaggiunge al tocco successivo, mai da sola: chi preme di nuovo «indietro» esce.
// Nel browser normale (scheda) niente protezione: «indietro» porta alla pagina precedente, come ci si aspetta da un sito.
let depth = 0, skip = 0, queued = false, levelsFn = () => 0, backFn = () => {}, hintFn = () => {};
const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => { try { return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: minimal-ui)').matches; } catch { return false; } };
let guard = false;                                                      // protezione attiva: la voce di base ha tpl -1, la protezione tpl 0

export function init({ levels, back, hint }) {
  levelsFn = levels; backFn = back; hintFn = hint || hintFn;
  guard = !iOS && standalone();
  depth = guard ? -1 : 0;
  try { history.replaceState({ ...(history.state || {}), tpl: depth }, ''); } catch { /* cronologia non disponibile: «indietro» del sistema esce dall'app */ }
  addEventListener('popstate', e => {
    const to = Number.isInteger(e.state?.tpl) ? e.state.tpl : (guard ? -1 : 0);
    if (skip > 0) { skip--; depth = to; sync(); return; }               // voci tolte da noi (livello chiuso dall'app): nessuna azione
    const steps = Math.max(0, depth - Math.max(to, 0)); depth = to;
    for (let i = 0; i < steps; i++) backFn();                           // di solito una sola: il tasto o il gesto «indietro»
    if (guard && to < 0) hintFn();                                      // arrivati alla voce di base: il prossimo «indietro» esce
    sync();
  });
  if (guard) {
    // la protezione si (ri)aggiunge solo dentro un gesto: tocco, clic o tasto (mai da un timer)
    const arm = () => { if (depth < 0 && skip === 0) { try { history.pushState({ ...(history.state || {}), tpl: 0 }, ''); depth = 0; } catch { /* ignora */ } } };
    for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, arm, { capture: true, passive: true });
  }
}
// porta la cronologia al numero di livelli aperti (una volta per giro dell'interfaccia, anche se chiamata più volte)
export function sync() {
  if (queued) return; queued = true;
  queueMicrotask(() => {
    queued = false;
    if (skip > 0) return;                                               // si aspetta la fine del «go» in corso: poi si richiama da sé
    let want = Math.max(0, Math.min(30, levelsFn() | 0));
    if (guard && depth < 0 && want === 0) want = -1;                    // sulla voce di base senza niente aperto: la protezione torna solo con un gesto
    try {
      if (want > depth) while (depth < want) history.pushState({ ...(history.state || {}), tpl: ++depth }, '');
      else if (want < depth) { skip++; const n = depth - want; depth = want; history.go(-n); }
    } catch { /* ignora */ }
  });
}
// sostituzione dell'indirizzo senza perdere il livello della cronologia (link aperti, notifiche)
export function replaceUrl(url) { try { history.replaceState({ ...(history.state || {}), tpl: depth }, '', url); } catch { /* ignora */ } }
export const guarded = () => guard;
