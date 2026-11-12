// NAVIGAZIONE CON IL TASTO E IL GESTO «INDIETRO» DEL SISTEMA (Android, iPhone/iPad, browser del computer).
// L'app è una pagina sola: ogni livello aperto (pannello della fermata o della corsa, pagina del pianificatore, finestre di avvisi, marea,
// preferiti e informazioni, ricerca) corrisponde a una voce nella cronologia del browser. «Indietro» chiude il livello più in alto, oppure
// torna al pannello precedente; con nulla aperto, esce dall'app come sempre.
//   · levels(): quanti livelli sono aperti adesso (calcolato da app.js sullo stato reale dell'interfaccia);
//   · back(): chiude il livello più in alto (stesso ordine del tasto Esc);
//   · sync(): da chiamare dopo ogni cambiamento dell'interfaccia: aggiunge o toglie voci perché la cronologia corrisponda ai livelli aperti.
// Le voci non cambiano l'indirizzo della pagina (nessun #frammento) e non contengono dati.
let depth = 0, skip = 0, queued = false, levelsFn = () => 0, backFn = () => {};

export function init({ levels, back }) {
  levelsFn = levels; backFn = back;
  try { history.replaceState({ ...(history.state || {}), tpl: 0 }, ''); } catch { /* cronologia non disponibile: «indietro» del sistema esce dall'app */ }
  addEventListener('popstate', e => {
    const to = Number.isInteger(e.state?.tpl) ? e.state.tpl : 0;
    if (skip > 0) { skip--; depth = to; sync(); return; }               // voci tolte da noi (livello chiuso dall'app): nessuna azione
    const steps = Math.max(0, depth - to); depth = to;
    for (let i = 0; i < steps; i++) backFn();                           // di solito una sola: il tasto o il gesto «indietro»
    sync();
  });
}
// porta la cronologia al numero di livelli aperti (una volta per giro dell'interfaccia, anche se chiamata più volte)
export function sync() {
  if (queued) return; queued = true;
  queueMicrotask(() => {
    queued = false;
    if (skip > 0) return;                                               // si aspetta la fine del «go» in corso: poi si richiama da sé
    const want = Math.max(0, Math.min(30, levelsFn() | 0));
    try {
      if (want > depth) while (depth < want) history.pushState({ ...(history.state || {}), tpl: ++depth }, '');
      else if (want < depth) { skip++; const n = depth - want; depth = want; history.go(-n); }
    } catch { /* ignora */ }
  });
}
// sostituzione dell'indirizzo senza perdere il livello della cronologia (link aperti, notifiche)
export function replaceUrl(url) { try { history.replaceState({ ...(history.state || {}), tpl: depth }, '', url); } catch { /* ignora */ } }
