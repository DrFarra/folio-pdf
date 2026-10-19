import { useLayoutEffect, useState } from 'react';
import { isMobile, isNative } from '../platform';
import { preference } from '../preferences';

// The theme follows the system until chosen. The old folio.theme was stored
// unasked as 'light', so only its 'dark' is a choice.
const themeChoice = () => preference('folio.themeChoice', preference('folio.theme', '') === 'dark' ? 'dark' : 'system');

/** The chosen theme ('system', 'light' or 'dark'), applied to the page. `statusBar` is the
 * colour token at the top of the current screen, which Android paints its status bar with. */
export function useTheme(statusBar: '--bg' | '--surface' | '--canvas') {
  const [theme, setTheme] = useState(themeChoice);
  const chooseTheme = (value: string) => { setTheme(value); try { localStorage.setItem('folio.themeChoice', value); } catch { /* The theme still applies to this session. */ } };
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const root = document.documentElement, resolved = theme === 'system' ? media.matches ? 'dark' : 'light' : theme;
      root.dataset.theme = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
      // 'system' keeps the next cold start following the system. iOS ignores the colour.
      // With the reader chrome hidden it is the reading area's, so the kept strip blends in.
      if (isNative && isMobile) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_mobile_theme', { theme: theme === 'system' ? 'system' : resolved, background: getComputedStyle(root).getPropertyValue(statusBar).trim() })).catch(() => {});
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme, statusBar]);
  return { theme, chooseTheme };
}
