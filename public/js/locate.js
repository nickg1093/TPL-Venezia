// POSIZIONE DELL'UTENTE (GPS). Usa l'API standard del browser (navigator.geolocation) e ne rispetta le regole:
//  · parte SOLO da un tocco dell'utente (mai da sola all'apertura) e lascia al sistema la richiesta del permesso;
//  · se il permesso è negato o il GPS del telefono è spento lo dice, spiegando cosa fare, senza insistere;
//  · se la precisione alta non risponde riprova con la rete (Wi-Fi/celle); a pagina nascosta sospende la lettura (batteria) e la riprende al ritorno.
// Il pulsante ha tre stati, come nelle mappe di sistema:  spento → acceso (punto sulla mappa, UNA centratura) → segue (la mappa ti accompagna) → spento.
// La centratura NON è continua: la mappa si muove da sola solo nello stato «segue», e quello stato finisce appena l'utente trascina la mappa,
// apre una fermata o segue un mezzo (così non c'è più il rimbalzo tra la tua posizione e l'inseguimento del mezzo).
const LABELS = {
  off: 'Mostra la mia posizione',
  wait: 'Cerco la tua posizione… tocca per annullare',
  on: 'Segui la mia posizione',
  follow: 'Smetti di seguire e spegni la posizione'
};

// notify(testo, ms?)  mostra un avviso breve; onFix({lat, lng, accuracy, first, follow}); onState(stato); centerOn(latlng, zoom)
export function createLocator({ button, notify, onFix, onState, centerOn }) {
  let state = 'off', watchId = null, lowAcc = false, last = null, firstFix = true;

  const set = s => {
    state = s;
    button.dataset.state = s;
    button.setAttribute('aria-pressed', String(s === 'on' || s === 'follow'));
    button.setAttribute('aria-busy', String(s === 'wait'));
    button.setAttribute('aria-label', LABELS[s]); button.title = LABELS[s];
    onState?.(s);
  };

  const stopWatch = () => { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } };
  function off(msg) { stopWatch(); last = null; firstFix = true; lowAcc = false; set('off'); onFix?.(null); if (msg) notify?.(msg, 9000); }

  function startWatch() {
    stopWatch();
    const opts = lowAcc ? { enableHighAccuracy: false, maximumAge: 30000, timeout: 30000 } : { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 };
    watchId = navigator.geolocation.watchPosition(pos => {
      const c = pos.coords; if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
      last = { lat: c.latitude, lng: c.longitude, accuracy: Math.max(0, c.accuracy || 0) };
      const first = firstFix; firstFix = false;
      if (state === 'wait') set('on');
      onFix?.({ ...last, first, follow: state === 'follow' });
      if (first && state === 'on') centerOn?.({ lat: last.lat, lng: last.lng }, 16);          // l'unica centratura automatica: alla prima posizione
    }, err => {
      if (err.code === 1) return off('Permesso di posizione negato. Per attivarlo, consenti la posizione a questo sito dalle impostazioni del browser (icona accanto all\'indirizzo) e, se serve, a quelle del telefono.');
      if (err.code === 3 && !lowAcc && firstFix) { lowAcc = true; return startWatch(); }       // GPS lento (es. al chiuso): secondo tentativo con la rete
      if (err.code === 2 && firstFix) { notify?.('Posizione non disponibile: controlla che la Posizione (GPS) del telefono sia attiva e di avere segnale.', 9000); if (!lowAcc) { lowAcc = true; startWatch(); } return; }
      if (firstFix && state === 'wait') off('Non riesco a ottenere la posizione. Riprova all\'aperto o attiva la Posizione del telefono.');
      // a posizione già trovata, un errore momentaneo (galleria, segnale perso) non spegne nulla: si continua ad aspettare
    }, opts);
  }

  async function start() {
    if (!('geolocation' in navigator)) return notify?.('Questo browser o dispositivo non supporta la geolocalizzazione.', 8000);
    if (window.isSecureContext === false) return notify?.('La posizione funziona solo su una connessione sicura (HTTPS).', 8000);
    let perm = null;
    try { perm = navigator.permissions?.query ? await navigator.permissions.query({ name: 'geolocation' }) : null; } catch { /* non supportata (es. alcune versioni di Safari): si chiede direttamente */ }
    if (perm?.state === 'denied') return notify?.('Permesso di posizione negato: consentilo a questo sito dalle impostazioni del browser (icona accanto all\'indirizzo) e del telefono, poi riprova.', 10000);
    if (perm) { perm.onchange = () => { if (perm.state === 'denied' && state !== 'off') off('Hai tolto il permesso di posizione.'); }; }
    firstFix = true; lowAcc = false; set('wait'); startWatch();                                  // il sistema mostra qui la richiesta del permesso
  }

  button.dataset.state = 'off'; button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => {
    if (state === 'off') start();
    else if (state === 'wait') off();
    else if (state === 'on') { set('follow'); if (last) centerOn?.({ lat: last.lat, lng: last.lng }, 16); }
    else off();
  });

  // a pagina nascosta niente GPS acceso; al ritorno si riprende (senza nuove richieste di permesso: è già stato concesso)
  document.addEventListener('visibilitychange', () => {
    if (state === 'off') return;
    if (document.hidden) stopWatch(); else if (watchId == null) { startWatch(); }
  });

  return {
    get state() { return state; },
    get last() { return last; },
    // chiamata quando l'utente fa altro con la mappa (trascina, apre una fermata, segue un mezzo): resta il punto, finisce l'inseguimento
    release() { if (state === 'follow') set('on'); },
    stop: () => { if (state !== 'off') off(); }
  };
}
