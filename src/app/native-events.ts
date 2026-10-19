import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readImage } from '../edit/EditToolbar';
import { errorMessage } from '../errors';
import { isAndroid, isDesktop, isMac, isMobile, isNative, setKeepAwake, setReaderChrome, startupDocuments, type NativeDocument } from '../platform';
import type { Notify } from './notices';

/** The latest value, so listeners registered once still see the current render's handlers. */
function useLatest<T>(value: T) { const ref = useRef(value); ref.current = value; return ref; }

type SystemOpens = {
  open: (file: NativeDocument) => Promise<unknown>;
  /** An operation is running: opening waits for it. */
  busy: () => boolean;
  /** A document is being opened. */
  opening: () => boolean;
  /** Files arrived (the drop overlay, if any, is done). */
  received: () => void;
  /** Startup's files were opened; `nothingOpened` when there were none. */
  ready: (nothingOpened: boolean, alive: () => boolean) => Promise<void>;
  /** The listeners could not be registered. */
  failed: () => void;
  notify: Notify;
};

/** Documents the system hands Folio (Finder or Explorer, a file dropped on the window,
 * the command line, Android's share sheet): queued and opened one at a time, when no
 * operation, open or dialog is in the way. The native app only. */
export function useSystemOpens(handlers: SystemOpens) {
  const live = useLatest(handlers);
  useEffect(() => {
    if (!isNative) return;
    let alive = true;
    const pending: NativeDocument[] = [];
    let draining = false, retry = 0;
    const drain = async () => {
      if (!alive || draining || !pending.length) return;
      if (live.current.busy() || live.current.opening() || document.querySelector('dialog[open]')) {
        retry = window.setTimeout(() => { retry = 0; void drain(); }, 200); return;
      }
      draining = true;
      try {
        while (alive && pending.length) {
          if (live.current.busy() || document.querySelector('dialog[open]')) break;
          await live.current.open(pending.shift()!);
        }
      } catch (error) { if (alive) live.current.notify(errorMessage(error), 'error'); }
      finally { draining = false; if (alive && pending.length) retry = window.setTimeout(() => { retry = 0; void drain(); }, 200); }
    };
    const openFiles = async (files: NativeDocument[]) => {
      pending.push(...files.filter(file => !pending.some(queued => queued.token === file.token)));
      await drain();
    };
    const listenerPromises = [
      import('@tauri-apps/api/event').then(({ listen }) => listen<NativeDocument[]>('folio-open-documents', event => {
        if (!alive) return;
        live.current.received();
        void openFiles(event.payload);
      })),
      import('@tauri-apps/api/event').then(({ listen }) => listen<string>('folio-open-error', event => { if (alive) live.current.notify(event.payload, 'error'); })),
    ];
    let released = false;
    const release = () => {
      if (released) return; released = true;
      void Promise.allSettled(listenerPromises).then(results => { for (const result of results) if (result.status === 'fulfilled') { try { result.value(); } catch { /* A closing WebView can already have removed its listeners. */ } } });
    };
    void Promise.all(listenerPromises).then(async () => {
      if (!alive) return;
      // Rust can now drain queued Finder/argv opens without losing an event.
      const files = await startupDocuments();
      if (!alive) return;
      await openFiles(files);
      if (alive) await live.current.ready(!files.length, () => alive);
    }).catch(() => {
      release();
      if (alive) live.current.failed();
    });
    return () => { alive = false; if (retry) clearTimeout(retry); release(); };
  }, [live]);
}

/** The desktop app takes file drops natively (Rust opens the PDFs), so the web drag events
 * never fire: its webview's events drive the drop overlay (`hover`). While Editar is open
 * (`editing`), a dropped image is placed on the page under the pointer instead. */
export function useDesktopDrops(handlers: { hover: (pdf: boolean) => void; editing: () => boolean; notify: Notify }) {
  const live = useLatest(handlers);
  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    const isPdf = (path: string) => /\.pdf$/i.test(path);
    const listener = import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (!alive) return;
      if (payload.type === 'enter') live.current.hover(payload.paths.some(isPdf));
      else if (payload.type !== 'over') live.current.hover(false);
      if (payload.type !== 'drop') return;
      const images = payload.paths.filter(path => /\.(png|jpe?g)$/i.test(path));
      if (live.current.editing() && images.length) {
        // Rust keeps the dropped images; the page under the pointer places the first one.
        const x = payload.position.x / (window.devicePixelRatio || 1), y = payload.position.y / (window.devicePixelRatio || 1);
        void invoke<ArrayBuffer>('dropped_image', { index: 0 }).then(data => readImage(new File([data], images[0].split(/[\/]/).pop() || 'imagen', { type: /\.png$/i.test(images[0]) ? 'image/png' : 'image/jpeg' })))
          .then(image => window.dispatchEvent(new CustomEvent('folio:edit-place-image', { detail: { image, clientX: x, clientY: y } }))).catch(error => live.current.notify(errorMessage(error), 'error'));
        return;
      }
      const rejected = payload.paths.filter(path => !isPdf(path)).length;
      if (rejected) live.current.notify('Solo se pueden abrir archivos PDF.', rejected === payload.paths.length ? 'error' : 'info');
    })).catch(() => null);
    return () => { alive = false; void listener.then(unlisten => unlisten?.()); };
  }, [live]);
}

/** Closing the desktop window: while `guarded()`, the window stays until `close()` resolves
 * true (everything was stored), and is then destroyed. */
export function useWindowCloseGuard(handlers: { guarded: () => boolean; close: () => Promise<boolean>; notify: Notify }) {
  const live = useLatest(handlers);
  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    const listener = import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const window = getCurrentWindow();
      return window.onCloseRequested(async event => {
        if (!alive || !live.current.guarded()) return;
        event.preventDefault();
        if (await live.current.close()) await window.destroy().catch(() => live.current.notify('No se pudo cerrar Folio.', 'error'));
      });
    });
    return () => { alive = false; void listener.then(unlisten => unlisten()); };
  }, [live]);
}

/** The macOS menu bar's commands, by id; its shortcuts reach it only when the page leaves them unhandled. */
export function useMacMenu(run: (id: string) => void) {
  const live = useLatest(run);
  useEffect(() => {
    if (!isDesktop || !isMac) return;
    let alive = true;
    const listener = import('@tauri-apps/api/event').then(({ listen }) => listen<string>('folio-menu', ({ payload }) => { if (alive) live.current(payload); }));
    return () => { alive = false; void listener.then(unlisten => unlisten()).catch(() => {}); };
  }, [live]);
}

/** Leaving the page or sending the app to the background stores what is open (`preserve`):
 * the system may end a backgrounded app. The desktop app stores it when its window closes instead. */
export function usePreserveOnLeave(preserve: () => void) {
  const live = useLatest(preserve);
  useEffect(() => {
    if (isDesktop) return;
    const store = () => live.current();
    const background = () => { if (document.visibilityState === 'hidden') store(); };
    window.addEventListener('beforeunload', store);
    window.addEventListener('pagehide', store);
    document.addEventListener('visibilitychange', background);
    return () => { window.removeEventListener('beforeunload', store); window.removeEventListener('pagehide', store); document.removeEventListener('visibilitychange', background); };
  }, [live]);
}

/** Android's Back button. Each press undoes one level: the dialog or menu in front,
 * a text selection, then the app's own levels (`back`, given the open tool section's
 * own Back button, if any). At the app's root (`root()`), Android backgrounds Folio. */
export function useAndroidBack(handlers: { root: () => boolean; back: (toolsBack: HTMLButtonElement | null) => void }) {
  const live = useLatest(handlers);
  useEffect(() => {
    if (!isNative || !isAndroid) return;
    const back = (event: Event) => {
      const modal = [...document.querySelectorAll('dialog[open]')].at(-1), popover = document.querySelector('.drawing-settings-popup,.highlight-color-palette,.highlight-annotation-menu,.bookmark-menu,.document-library-menu');
      const selection = !!document.querySelector('.text-selection-menu');
      if (!modal && !popover && !selection && live.current.root()) return;
      event.preventDefault();
      const toolsBack = (modal || document).querySelector<HTMLButtonElement>('.workbench .workbench-back:not(:disabled)');
      if (modal) { if (toolsBack) toolsBack.click(); else modal.dispatchEvent(new Event('cancel', { cancelable: true })); return; }
      if (popover) { (document.activeElement || document).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return; }
      if (selection) { window.getSelection()?.removeAllRanges(); return; }
      live.current.back(toolsBack);
    };
    window.addEventListener('folio:android-back', back);
    return () => window.removeEventListener('folio:android-back', back);
  }, [live]);
}

/** Phones and tablets keep the screen on while `on` (a document is being read). */
export function useKeepAwake(on: boolean) {
  useEffect(() => { void setKeepAwake(on); }, [on]);
  useEffect(() => () => { void setKeepAwake(false); }, []);
}

/** Phones and tablets show the system's status and navigation bars while `visible`; the page
 * hears `folio:system-bars-changed` once they have changed. */
export function useSystemBars(visible: boolean) {
  const update = useRef(Promise.resolve());
  useEffect(() => {
    if (!isNative || !isMobile) return;
    update.current = update.current.catch(() => {}).then(() => setReaderChrome(visible)).then(() => { window.dispatchEvent(new Event('folio:system-bars-changed')); }).catch(() => {});
  }, [visible]);
}
