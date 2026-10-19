import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { LoadedDocument } from '../types';
import { inView } from '../components/PDFPage';
import { useLatest } from './latest';

type Viewer = RefObject<HTMLDivElement | null>;
// Menus and sheets over the reader keep their taps to themselves.
const overlays =
  'dialog[open],.document-switcher,.highlight-annotation-menu,.highlight-color-palette,.text-selection-menu';

/** Touch reading: a tap on a page hides or shows the reader's controls, a double tap zooms.
 * `idle` is false while a tool, panel or task takes the taps. Any reader interaction
 * (`folio:reader-interaction`) shows the controls again. */
export function useReaderTaps(
  viewer: Viewer,
  active: boolean,
  idle: boolean,
  handlers: { doubleTap: (event: PointerEvent) => void; toggleChrome: () => void; showChrome: () => void },
) {
  const live = useLatest(handlers);
  useEffect(() => {
    const root = viewer.current;
    if (!active || !root) return;
    let origin: { id: number; x: number; y: number; top: number; left: number; at: number } | null = null;
    const doubleTapWindow = 350;
    let timer = 0,
      lastTap = 0;
    const cancel = () => {
      origin = null;
      if (timer) clearTimeout(timer);
      timer = 0;
    };
    const down = (event: PointerEvent) => {
      if (timer) clearTimeout(timer);
      timer = 0;
      if (event.pointerType !== 'touch' || !event.isPrimary || !idle) {
        origin = null;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (
        !target?.closest('.page-content') ||
        target.closest('button,a,input,textarea,[role="button"],.highlight-annotation') ||
        !window.getSelection()?.isCollapsed
      ) {
        origin = null;
        return;
      }
      if (Date.now() - lastTap < doubleTapWindow) {
        origin = null;
        lastTap = 0;
        live.current.doubleTap(event);
        return;
      }
      origin = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        top: root.scrollTop,
        left: root.scrollLeft,
        at: Date.now(),
      };
    };
    const up = (event: PointerEvent) => {
      const start = origin;
      origin = null;
      if (
        !start ||
        event.pointerId !== start.id ||
        Date.now() - start.at > 250 ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6 ||
        Math.abs(root.scrollTop - start.top) > 3 ||
        Math.abs(root.scrollLeft - start.left) > 3 ||
        !window.getSelection()?.isCollapsed ||
        document.querySelector(overlays)
      )
        return;
      lastTap = Date.now();
      timer = window.setTimeout(() => {
        timer = 0;
        if (window.getSelection()?.isCollapsed && !document.querySelector(overlays)) live.current.toggleChrome();
      }, doubleTapWindow);
    };
    const selection = () => {
      if (!window.getSelection()?.isCollapsed) cancel();
    };
    const action = () => {
      cancel();
      live.current.showChrome();
    };
    root.addEventListener('pointerdown', down, true);
    root.addEventListener('pointerup', up, true);
    root.addEventListener('pointercancel', cancel, true);
    window.addEventListener('folio:pinch-start', cancel);
    document.addEventListener('selectionchange', selection);
    window.addEventListener('folio:reader-interaction', action);
    return () => {
      cancel();
      root.removeEventListener('pointerdown', down, true);
      root.removeEventListener('pointerup', up, true);
      root.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('folio:pinch-start', cancel);
      window.removeEventListener('folio:reader-interaction', action);
      document.removeEventListener('selectionchange', selection);
    };
  }, [viewer, active, idle]);
}

/** Single-page reading on touch: a horizontal swipe turns the page (`turn(1)` forward). */
export function useSwipePages(viewer: Viewer, enabled: boolean, turn: (step: 1 | -1) => void) {
  const live = useLatest(turn);
  useEffect(() => {
    const root = viewer.current;
    if (!enabled || !root) return;
    let start: { x: number; y: number; at: number } | null = null;
    const down = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.touches.length !== 1 ||
        root.scrollWidth > root.clientWidth + 4 ||
        target?.closest('button,a,input,.highlight-annotation') ||
        !window.getSelection()?.isCollapsed
      ) {
        start = null;
        return;
      }
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY, at: Date.now() };
    };
    const end = (event: TouchEvent) => {
      const origin = start;
      start = null;
      if (!origin || !event.changedTouches[0] || !window.getSelection()?.isCollapsed) return;
      const dx = event.changedTouches[0].clientX - origin.x,
        dy = event.changedTouches[0].clientY - origin.y;
      if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.7 && Date.now() - origin.at < 600)
        live.current(dx < 0 ? 1 : -1);
    };
    const cancel = () => {
      start = null;
    };
    root.addEventListener('touchstart', down, { passive: true });
    root.addEventListener('touchend', end, { passive: true });
    root.addEventListener('touchcancel', cancel);
    return () => {
      root.removeEventListener('touchstart', down);
      root.removeEventListener('touchend', end);
      root.removeEventListener('touchcancel', cancel);
    };
  }, [viewer, enabled]);
}

type Tracking = {
  viewer: Viewer;
  doc: LoadedDocument | null;
  readingMode: string;
  page: number;
  /** False while the reader is hidden (Editar's inline editor). */
  enabled: boolean;
  /** True while the view is being restored and its pages are not where they will be. */
  paused: () => boolean;
  /** The page that fills most of the reader. */
  onPage: (page: number) => void;
  /** The page point at the reader's centre (x, y as fractions of the page), with the reader's width. */
  onCenter: (page: number, x: number, y: number, width: number) => void;
};

/** Follows the page being read as the reader scrolls or its pages change size, and
 * scrolls the reader by `distance` (`scrollBy`; null only stops a jump), smoothly if asked: while that animation passes other
 * pages the current page stays the target, and tracking resumes when it ends or the user scrolls. */
export function usePageTracking({ viewer, doc, readingMode, page, enabled, ...callbacks }: Tracking) {
  const live = useLatest(callbacks);
  const smoothJump = useRef(0),
    smoothJumps = useRef(0),
    track = useRef(() => {});
  useEffect(() => {
    const root = viewer.current;
    if (!doc || !root || !enabled) return;
    // Found by a binary search over the pages rather than observed: a 4000-page
    // book would otherwise have the browser recompute every page on each frame.
    const wraps = [...root.querySelectorAll('.pdf-page-wrap')];
    let frame = 0;
    const update = () => {
      frame = 0;
      if (live.current.paused() || smoothJump.current) return;
      const bounds = root.getBoundingClientRect(),
        visible = inView(wraps, node => node, bounds.top, bounds.bottom);
      const candidates = [...visible]
        .map(node => {
          const box = node.getBoundingClientRect();
          return {
            node,
            height: Math.max(0, Math.min(bounds.bottom, box.bottom) - Math.max(bounds.top, box.top)),
            distance: Math.abs(box.top - bounds.top),
          };
        })
        .filter(item => item.height > 0)
        .sort((a, b) => b.height - a.height || a.distance - b.distance);
      if (candidates[0]) live.current.onPage(Number((candidates[0].node as HTMLElement).dataset.pageNumber));
      const centerX = bounds.left + root.clientWidth / 2,
        centerY = bounds.top + root.clientHeight / 2;
      let anchor: { node: HTMLElement; box: DOMRect; gap: number } | null = null;
      for (const node of visible) {
        const box = node.querySelector('.pdf-page')?.getBoundingClientRect(),
          gap = box ? Math.max(box.top - centerY, centerY - box.bottom, 0) : Infinity;
        if (box?.height && (!anchor || gap < anchor.gap)) anchor = { node: node as HTMLElement, box, gap };
      }
      if (anchor)
        live.current.onCenter(
          Number(anchor.node.dataset.pageNumber),
          (centerX - anchor.box.left) / anchor.box.width,
          (centerY - anchor.box.top) / anchor.box.height,
          root.clientWidth,
        );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    track.current = schedule;
    // Zoom and pages taking their real size move pages without scrolling.
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    const stack = root.querySelector('.pdf-stack');
    if (stack) observer.observe(stack);
    root.addEventListener('scroll', schedule, { passive: true });
    return () => {
      observer.disconnect();
      root.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
      if (track.current === schedule) track.current = () => {};
    };
    // A single page is its own stack, so each page is tracked anew.
  }, [viewer, doc, readingMode, readingMode === 'single' ? page : null, enabled]);
  const scrollBy = useCallback((root: HTMLElement, distance: number | null, smooth: boolean) => {
    smoothJump.current = 0;
    if (distance === null) return;
    if (smooth) {
      const jump = (smoothJump.current = ++smoothJumps.current),
        events = ['scrollend', 'wheel', 'touchstart', 'pointerdown', 'keydown'];
      const end = () => {
        clearTimeout(timer);
        for (const type of events) root.removeEventListener(type, end);
        if (smoothJump.current === jump) {
          smoothJump.current = 0;
          track.current();
        }
      };
      for (const type of events) root.addEventListener(type, end, { passive: true });
      const timer = window.setTimeout(end, 1000);
    }
    root.scrollTo({ top: root.scrollTop + distance, behavior: smooth ? 'smooth' : 'instant' });
  }, []);
  return scrollBy;
}
