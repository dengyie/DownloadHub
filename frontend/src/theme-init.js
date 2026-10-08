// Runs before CSS. Only a display preference is persisted; credentials never are.
(function () {
  let mode = 'auto';
  try { mode = localStorage.getItem('mango-theme') || 'auto'; } catch {}
  if (!['auto', 'light', 'dark'].includes(mode)) mode = 'auto';
  const hour = new Date().getHours();
  const systemDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = mode === 'auto' ? (systemDark || hour >= 19 || hour < 7 ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = mode;
  document.documentElement.dataset.resolvedTheme = resolved;
  document.documentElement.style.colorScheme = resolved;
})();
