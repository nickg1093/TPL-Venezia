// AVVIO (eseguito prima del primo disegno): 1) tema scelto — preferenza salvata, altrimenti quella del sistema, senza lampi di tema sbagliato; 2) altezza reale dell'app (vedi sotto).
// File separato (non in linea) perché la Content-Security-Policy vieta gli script nella pagina.
(function () {
  var r = document.documentElement, t;
  try { t = localStorage.getItem('theme'); } catch (e) { /* navigazione privata: si usa il sistema */ }
  if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  r.dataset.theme = t;
  var m = document.querySelector('meta[name=theme-color]');
  if (m) m.content = t === 'dark' ? '#121a28' : '#ffffff';
})();

// Altezza dell'app = altezza REALE dell'area visibile (window.innerHeight). Su Android, all'apertura, 100vh/100dvh possono includere lo spazio dei tasti di sistema
// e coprire il dock in basso finché non cambia qualcosa (tocco, rotazione): qui si legge la misura vera subito e la si riverifica poco dopo l'avvio.
// TASTIERA APERTA (campo di testo attivo e area visibile ridotta di oltre 120 px): l'app si adatta all'area sopra la tastiera (anche su iPhone,
// dove la tastiera copre la pagina invece di ridurla) e la classe «kbd» nasconde la barra in basso, che servirebbe a poco.
(function () {
  var r = document.documentElement, last = 0, full = 0;
  function typing() { var a = document.activeElement; return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|email|url|tel|number)$/.test(a.type || 'text'))); }
  function fit(notify) {
    var vv = window.visualViewport, ih = Math.round(window.innerHeight), h = ih;
    if (!typing()) full = Math.max(ih, vv ? Math.round(vv.height) : 0);
    if (typing() && vv) h = Math.min(ih, Math.round(vv.height));
    var kbd = typing() && full - h > 120;
    r.classList.toggle('kbd', kbd);
    if (!h || h === last) return;
    last = h; r.style.setProperty('--app-h', h + 'px');
    if (notify) window.dispatchEvent(new Event('resize'));   // la mappa (Leaflet) ricalcola le sue dimensioni
  }
  document.addEventListener('focusin', function () { setTimeout(function () { fit(true); }, 250); });
  document.addEventListener('focusout', function () { setTimeout(function () { fit(true); }, 250); });
  fit(false);
  window.addEventListener('resize', function () { fit(false); });
  window.addEventListener('orientationchange', function () { setTimeout(function () { fit(true); }, 150); });
  window.addEventListener('pageshow', function () { fit(true); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', function () { fit(true); });
  [100, 300, 700, 1500, 3000].forEach(function (ms) { setTimeout(function () { fit(true); }, ms); });   // la barra di sistema si assesta pochi istanti dopo l'apertura
})();

// SOLO LA MAPPA SI INGRANDISCE: l'interfaccia (pannelli, pulsanti, testi) non si zooma con il pizzico, il doppio tocco o Ctrl+rotella/+/−.
// Sulla mappa pizzico, rotella e doppio tocco/clic restano e ingrandiscono la mappa (li gestisce Leaflet). La dimensione del testo
// scelta nelle impostazioni del telefono o del browser continua a valere (l'interfaccia è in rem).
// Telefono: viewport con user-scalable=no (Android) + touch-action: pan-x pan-y (CSS: niente pizzico né doppio tocco sulla pagina; la mappa
// ha il suo touch-action) + gesture* di Safari, che ignora user-scalable. Tocchi rapidi sui pulsanti: mai bloccati.
(function () {
  ['gesturestart', 'gesturechange'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); }, { passive: false }); });
  // Ctrl+rotella (anche il pizzico del touchpad): fuori dalla mappa non fa nulla; sulla mappa ingrandisce la mappa e non la pagina
  window.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  window.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && /^(\+|=|-|_|0|Add|Subtract)$/.test(e.key)) e.preventDefault();
  });
})();
