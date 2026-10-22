export type ReadingPreferences = {
  /** spread: two pages side by side, continuous; tablets and desktop. */
  mode: 'continuous' | 'single' | 'spread';
  initialPanel: 'closed' | 'pages' | 'outline' | 'bookmarks';
  panelWidth: number;
  pageGap: number;
  smoothScroll: boolean;
  restorePage: boolean;
  wheelSpeed: number;
  /** Page color while reading: as printed, warm paper, or inverted for the dark. */
  pageTone: 'normal' | 'sepia' | 'dark';
  /** Phones and tablets keep the screen on while a document is open. */
  keepAwake: boolean;
  /** Desktop: the page bar stays on screen instead of hiding until the pointer nears it. */
  pinPageBar: boolean;
  /** «Página N de M» under each page (desktop and tablets). */
  pageCaptions: boolean;
  /** Desktop: entering Anotar opens the annotations beside the pages. */
  openNotesOnAnnotate: boolean;
  /** The interface's accent colour (redesign-desktop.css), and animations kept to nearly nothing. */
  accent: Accent;
  reduceMotion: boolean;
};
export type Accent = 'coral' | 'blue' | 'green' | 'violet' | 'amber' | 'graphite';
/** Ajustes' accent choices: value, name and swatch. */
export const ACCENTS: [Accent, string, string][] = [
  ['coral', 'Coral', '#b0473a'],
  ['blue', 'Azul', '#2f5bd3'],
  ['green', 'Verde', '#1f7a4a'],
  ['violet', 'Violeta', '#6b4bc4'],
  ['amber', 'Ámbar', '#a35f00'],
  ['graphite', 'Grafito', '#3b4250'],
];

export const defaultReadingPreferences: ReadingPreferences = {
  mode: 'continuous',
  initialPanel: 'closed',
  panelWidth: 220,
  pageGap: 19,
  smoothScroll: true,
  restorePage: true,
  wheelSpeed: 100,
  pageTone: 'normal',
  keepAwake: true,
  pinPageBar: false,
  pageCaptions: true,
  openNotesOnAnnotate: false,
  accent: 'coral',
  reduceMotion: false,
};
export function readReadingPreferences(): ReadingPreferences {
  try {
    const raw = JSON.parse(localStorage.getItem('folio.readingPreferences') || '{}');
    const clamp = (value: unknown, fallback: number, min: number, max: number) =>
      typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    return {
      mode: raw.mode === 'single' || raw.mode === 'spread' ? raw.mode : 'continuous',
      initialPanel: ['closed', 'pages', 'outline', 'bookmarks'].includes(raw.initialPanel)
        ? raw.initialPanel
        : 'closed',
      panelWidth: clamp(raw.panelWidth, 220, 180, 360),
      pageGap: clamp(raw.pageGap, 19, 8, 40),
      smoothScroll: raw.smoothScroll !== false,
      restorePage: raw.restorePage !== false,
      wheelSpeed: clamp(raw.wheelSpeed, 100, 50, 150),
      pageTone: raw.pageTone === 'sepia' || raw.pageTone === 'dark' ? raw.pageTone : 'normal',
      keepAwake: raw.keepAwake !== false,
      pinPageBar: raw.pinPageBar === true,
      pageCaptions: raw.pageCaptions !== false,
      openNotesOnAnnotate: raw.openNotesOnAnnotate === true,
      accent: ACCENTS.some(([value]) => value === raw.accent) ? raw.accent : 'coral',
      reduceMotion: raw.reduceMotion === true,
    };
  } catch {
    return { ...defaultReadingPreferences };
  }
}
