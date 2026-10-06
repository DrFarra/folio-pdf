// Applies the saved or system theme before the first paint; App keeps it in sync afterwards.
try {
  const choice = localStorage.getItem('folio.themeChoice') || (localStorage.getItem('folio.theme') === 'dark' ? 'dark' : 'system');
  document.documentElement.dataset.theme = choice === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : choice;
} catch { /* App applies the theme when it starts. */ }
