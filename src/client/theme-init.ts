// Applied before first paint to avoid a light/dark flash. Loaded as a classic script.
(function themeInit(): void {
  try {
    const t: unknown = JSON.parse(localStorage.getItem('hsconsole:theme') || '"system"');
    const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch { /* storage unavailable: keep the default */ }
})();
