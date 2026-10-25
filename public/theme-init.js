(() => {
  try {
    const stored = localStorage.getItem('dss.theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme =
      stored === 'dark' || stored === 'light' ? stored : prefersDark ? 'dark' : 'light';
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
