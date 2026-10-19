import { useEffect, useRef, useState } from 'react';
import { preference } from '../preferences';
import { readReadingPreferences } from '../reading-preferences';
import { useLatest } from './latest';

/** The settings people choose in Ajustes, kept across sessions: whether opened PDFs stay in
 * the library, the default zoom, and the reading preferences. The refs hold the latest
 * values for code that runs outside a render. */
export function useAppPreferences() {
  const [rememberRecent, setRememberRecent] = useState(() => preference('folio.remember', 'true') !== 'false');
  const [defaultZoom, setDefaultZoom] = useState(() => preference('folio.defaultZoom', 'page'));
  const [readingPreferences, setReadingPreferences] = useState(readReadingPreferences);
  const readingPreferencesRef = useLatest(readingPreferences);
  const preferencesRef = useRef({ rememberRecent, defaultZoom });
  useEffect(() => {
    preferencesRef.current = { rememberRecent, defaultZoom };
    try { localStorage.setItem('folio.remember', String(rememberRecent)); localStorage.setItem('folio.defaultZoom', defaultZoom); } catch { /* Settings are still usable for this session. */ }
  }, [rememberRecent, defaultZoom]);
  useEffect(() => {
    try { localStorage.setItem('folio.readingPreferences', JSON.stringify(readingPreferences)); } catch { /* Preferences remain active for this session. */ }
  }, [readingPreferences]);
  return { rememberRecent, setRememberRecent, defaultZoom, setDefaultZoom, readingPreferences, setReadingPreferences, readingPreferencesRef, preferencesRef };
}
