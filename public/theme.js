// Applies the saved or system theme before the first paint; App keeps it in sync afterwards.
try {
  const choice = localStorage.getItem('folio.themeChoice') || (localStorage.getItem('folio.theme') === 'dark' ? 'dark' : 'system');
  document.documentElement.dataset.theme = choice === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : choice;
} catch { /* App applies the theme when it starts. */ }
// The accent and reduced motion chosen in Ajustes, before the first paint too.
try {
  const reading = JSON.parse(localStorage.getItem('folio.readingPreferences') || '{}');
  if (['blue', 'green', 'violet', 'amber', 'graphite'].includes(reading.accent)) document.documentElement.dataset.accent = reading.accent;
  if (reading.reduceMotion === true) document.documentElement.dataset.motion = 'reduced';
} catch { /* App applies them when it starts. */ }
