import { isDesktop, isMac } from './platform';

// A borderless Windows window can extend behind a taskbar. Use the actual
// monitor work area, not a guessed taskbar height, to position its dialogs.
export function watchDesktopModalViewport(dialog: HTMLDialogElement): () => void {
  if (!isDesktop || isMac) return () => {};
  let disposed = false;
  let revision = 0;
  let frame = 0;
  const unlisten: Array<() => void> = [];
  const release = (stop: () => void) => { try { void Promise.resolve(stop()).catch(() => {}); } catch { /* The native window may already be closed. */ } };
  const reset = () => {
    for (const name of ['top', 'left', 'width', 'height']) dialog.style.removeProperty(`--modal-visible-${name}`);
  };
  let update = () => {};
  const schedule = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; update(); });
  };
  window.addEventListener('resize', schedule);
  document.addEventListener('fullscreenchange', schedule);
  void import('@tauri-apps/api/window').then(async ({ currentMonitor, getCurrentWindow }) => {
    if (disposed) return;
    const nativeWindow = getCurrentWindow();
    update = () => {
      const current = ++revision;
      void Promise.all([currentMonitor(), nativeWindow.innerPosition(), nativeWindow.innerSize(), nativeWindow.isFullscreen()])
        .then(([monitor, position, size, fullscreen]) => {
          if (disposed || current !== revision) return;
          if (!monitor || fullscreen || document.fullscreenElement || !size.width || !size.height) { reset(); return; }
          // Physical/CSS ratios also account for WebView zoom, in addition to
          // monitor DPI, and avoid mixing coordinates on secondary monitors.
          const scaleX = innerWidth / size.width, scaleY = innerHeight / size.height;
          const area = monitor.workArea;
          const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value));
          const left = clamp((area.position.x - position.x) * scaleX, innerWidth);
          const top = clamp((area.position.y - position.y) * scaleY, innerHeight);
          const right = clamp((area.position.x + area.size.width - position.x) * scaleX, innerWidth);
          const bottom = clamp((area.position.y + area.size.height - position.y) * scaleY, innerHeight);
          if (right <= left || bottom <= top) { reset(); return; }
          for (const [name, value] of Object.entries({ left, top, width: right - left, height: bottom - top })) {
            dialog.style.setProperty(`--modal-visible-${name}`, `${value}px`);
          }
        }).catch(() => { if (!disposed && current === revision) reset(); });
    };
    update();
    await Promise.allSettled([
      nativeWindow.onMoved(schedule), nativeWindow.onResized(schedule),
      nativeWindow.onScaleChanged(schedule), nativeWindow.onFocusChanged(schedule),
    ].map(async registration => {
      const stop = await registration;
      if (disposed) release(stop); else unlisten.push(stop);
    }));
  }).catch(() => { if (!disposed) reset(); });
  return () => {
    disposed = true;
    ++revision;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('fullscreenchange', schedule);
    for (const stop of unlisten) release(stop);
    reset();
  };
}
