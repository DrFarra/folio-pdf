export type ReadingPreferences = {
  mode: 'continuous' | 'single';
  initialPanel: 'closed' | 'pages' | 'outline' | 'bookmarks';
  panelWidth: number;
  pageGap: number;
  smoothScroll: boolean;
  restorePage: boolean;
  wheelSpeed: number;
  /** Page color while reading: as printed, warm paper, or inverted for the dark. */
  pageTone: 'normal' | 'sepia' | 'dark';
};

export const defaultReadingPreferences: ReadingPreferences = {
  mode: 'continuous', initialPanel: 'closed', panelWidth: 220,
  pageGap: 19, smoothScroll: true, restorePage: true, wheelSpeed: 100, pageTone: 'normal',
};
export function readReadingPreferences(): ReadingPreferences {
  try {
    const raw = JSON.parse(localStorage.getItem('folio.readingPreferences') || '{}');
    const clamp = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    return {
      mode: raw.mode === 'single' ? 'single' : 'continuous',
      initialPanel: ['closed', 'pages', 'outline', 'bookmarks'].includes(raw.initialPanel) ? raw.initialPanel : 'closed',
      panelWidth: clamp(raw.panelWidth, 220, 180, 360), pageGap: clamp(raw.pageGap, 19, 8, 40),
      smoothScroll: raw.smoothScroll !== false, restorePage: raw.restorePage !== false,
      wheelSpeed: clamp(raw.wheelSpeed, 100, 50, 150),
      pageTone: raw.pageTone === 'sepia' || raw.pageTone === 'dark' ? raw.pageTone : 'normal',
    };
  } catch { return { ...defaultReadingPreferences }; }
}
