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
(function () {
  var r = document.documentElement, last = 0;
  function fit(notify) {
    var h = Math.round(window.innerHeight);
    if (!h || h === last) return;
    last = h; r.style.setProperty('--app-h', h + 'px');
    if (notify) window.dispatchEvent(new Event('resize'));   // la mappa (Leaflet) ricalcola le sue dimensioni
  }
  fit(false);
  window.addEventListener('resize', function () { fit(false); });
  window.addEventListener('orientationchange', function () { setTimeout(function () { fit(true); }, 150); });
  window.addEventListener('pageshow', function () { fit(true); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', function () { fit(true); });
  [100, 300, 700, 1500, 3000].forEach(function (ms) { setTimeout(function () { fit(true); }, ms); });   // la barra di sistema si assesta pochi istanti dopo l'apertura
})();
