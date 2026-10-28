// Tema scelto PRIMA del primo disegno della pagina (nessun lampo di tema sbagliato): preferenza salvata, altrimenti quella del sistema.
// File separato (non in linea) perché la Content-Security-Policy vieta gli script nella pagina.
(function () {
  var r = document.documentElement, t;
  try { t = localStorage.getItem('theme'); } catch (e) { /* navigazione privata: si usa il sistema */ }
  if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  r.dataset.theme = t;
  var m = document.querySelector('meta[name=theme-color]');
  if (m) m.content = t === 'dark' ? '#121a28' : '#ffffff';
})();
