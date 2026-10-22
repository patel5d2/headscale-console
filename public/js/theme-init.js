// Applied before first paint to avoid a light/dark flash.
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('hsconsole:theme') || '"system"');
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (_) { /* ignore */ }
})();
