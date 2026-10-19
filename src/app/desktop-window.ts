import { useCallback, useEffect, useState } from 'react';
import { isDesktop } from '../platform';

/** The desktop app's own window, which Folio draws the controls of: its title follows the
 * open document, and its state (maximized, full screen) follows the window. */
export function useDesktopWindow(documentName: string | undefined, onError: () => void) {
  const [windowState, setWindowState] = useState({ maximized: false, fullscreen: false });
  useEffect(() => {
    if (isDesktop) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(documentName ? `${documentName} — Folio` : 'Folio')).catch(() => {});
  }, [documentName]);
  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    const listener = import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const window = getCurrentWindow();
      const sync = () => void Promise.all([window.isMaximized(), window.isFullscreen()]).then(([maximized, fullscreen]) => { if (alive) setWindowState({ maximized, fullscreen }); }).catch(() => {});
      sync(); return window.onResized(sync);
    });
    return () => { alive = false; void listener.then(unlisten => unlisten()).catch(() => {}); };
  }, []);
  const windowAction = useCallback(async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow()[action]();
    } catch { onError(); }
  }, [onError]);
  return { windowState, windowAction };
}
