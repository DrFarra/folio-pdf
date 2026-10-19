import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { isMac } from '../platform';
import { MAX_ZOOM } from './model';

type Size = { width: number; height: number };
/** A page point (x, y as fractions of the page) and where on the reader it should stay. */
type ZoomAnchor = { id: string; page: number; x: number; y: number; pointerX: number; pointerY: number };
/** The page point at the centre of the reader, updated while reading, so zoom,
 * rotation and size changes keep the same place in view. */
export type ReadingAnchor = { id: string; page: number; x: number; y: number; rotation: number };
type Point = { clientX: number; clientY: number; target: EventTarget | null };

type ZoomOptions = {
  viewer: RefObject<HTMLDivElement | null>;
  /** The shown document's id, and the one of the document in front right now (it changes before a render does). */
  documentId: string | undefined; currentId: () => string | undefined;
  /** The first page's size, the view's rotation and the reader's size. */
  dimensions: Size; rotation: number; viewportSize: Size;
  phone: boolean; touchLayout: boolean;
  /** Two pages side by side, `pageGap` apart. */
  spread: boolean; pageGap: number;
  /** Ctrl+wheel speed, in percent. */
  wheelSpeed: () => number;
  /** Two-finger pinches work outside the library while nothing else is running. */
  pinchable: boolean; canPinch: () => boolean;
  /** The page a pinch centres on when no page is under the fingers. */
  currentPage: () => number;
};

/** The reader's zoom: a mode ('page', 'width' or 'custom' at `customScale`), the scale it
 * gives, and the wheel, trackpad and pinch gestures that change it keeping a point in place. */
export function useReaderZoom(options: ZoomOptions) {
  const { viewer, documentId, dimensions, rotation, viewportSize, phone, touchLayout, spread, pageGap } = options;
  const live = useRef(options); live.current = options;
  const [zoomMode, setZoomMode] = useState('page');
  const [customScale, setCustomScale] = useState(1);
  const zoomModeRef = useRef(zoomMode); zoomModeRef.current = zoomMode;
  const { scale, fitScale } = useMemo(() => {
    const rotated = rotation % 180 !== 0;
    const w = (rotated ? dimensions.height : dimensions.width) * (spread ? 2 : 1) + (spread ? pageGap : 0);
    const h = rotated ? dimensions.width : dimensions.height;
    const fit = Math.max(.25, Math.min(2, (viewportSize.width - (phone ? 16 : 54)) / w, (viewportSize.height - (phone ? 160 : 76)) / h));
    // A phone held sideways fits the width: fitting the page height leaves it unreadable.
    if (zoomMode === 'width' || zoomMode === 'page' && phone && viewportSize.width > viewportSize.height) return { scale: Math.max(.25, Math.min(3, (viewportSize.width - (phone ? 16 : viewportSize.width < 600 ? 30 : 100)) / w)), fitScale: fit };
    return { scale: zoomMode === 'page' ? fit : customScale, fitScale: fit };
  }, [zoomMode, customScale, viewportSize, dimensions, rotation, phone, spread, pageGap]);
  const currentScale = useRef(scale); currentScale.current = scale;
  // The fitted-page scale a double tap zooms from and returns to.
  const fitScaleRef = useRef(fitScale); fitScaleRef.current = fitScale;
  const pointerAnchor = useRef<ZoomAnchor | null>(null);
  const readingAnchor = useRef<ReadingAnchor | null>(null);

  // Zooms keeping the point under the pointer or finger in place. The scale is
  // kept unrounded so many small trackpad steps add up.
  const zoomAt = useCallback((value: number, point: Point) => {
    const id = live.current.currentId(), root = viewer.current, next = Math.max(.25, Math.min(MAX_ZOOM, value));
    if (!id || !root || next === currentScale.current) return;
    const node = point.target instanceof Element ? point.target.closest<HTMLElement>('.pdf-page') : null;
    if (node) {
      const bounds = node.getBoundingClientRect();
      const frame = root.getBoundingClientRect();
      pointerAnchor.current = { id, page: Number(node.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber),
        x: (point.clientX - bounds.left) / bounds.width, y: (point.clientY - bounds.top) / bounds.height,
        pointerX: point.clientX - frame.left, pointerY: point.clientY - frame.top };
    }
    currentScale.current = next;
    setCustomScale(next); setZoomMode('custom');
  }, [viewer]);
  const changeZoom = useCallback((delta: number) => { setCustomScale(Math.max(.25, Math.min(MAX_ZOOM, Math.round((scale + delta) * 100) / 100))); setZoomMode('custom'); }, [scale]);
  // A double tap zooms in on that point; another one returns to the fitted page.
  const toggleTapZoom = useCallback((point: Point) => {
    if (zoomModeRef.current === 'custom' && currentScale.current > fitScaleRef.current * 1.15) setZoomMode('page');
    else zoomAt(Math.max(currentScale.current * 2, fitScaleRef.current * 2), point);
  }, [zoomAt]);

  useLayoutEffect(() => {
    const pointer = pointerAnchor.current, reading = readingAnchor.current, root = viewer.current;
    pointerAnchor.current = null;
    if (!root) return;
    // Wheel and pinch keep the point under the fingers; buttons, keys, rotation and
    // size changes keep the page point that was at the centre of the reader.
    const anchor = pointer || reading && { ...reading, pointerX: root.clientWidth / 2, pointerY: root.clientHeight / 2 };
    if (!anchor || anchor.id !== documentId) return;
    let { x, y } = anchor;
    if (!pointer && reading) for (let turn = (rotation - reading.rotation + 360) % 360; turn > 0; turn -= 90) [x, y] = [1 - y, x];
    const node = root.querySelector<HTMLElement>(`[data-page-number="${anchor.page}"] .pdf-page`);
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    const frame = root.getBoundingClientRect();
    root.scrollLeft += bounds.left + bounds.width * x - frame.left - anchor.pointerX;
    root.scrollTop += bounds.top + bounds.height * y - frame.top - anchor.pointerY;
  }, [scale, rotation, documentId, viewer]);

  useEffect(() => {
    const root = viewer.current;
    const shell = document;
    if (!root) return;
    let gestureScale = 0;
    const onWheel = (event: Event) => {
      const wheel = event as WheelEvent;
      if (!wheel.ctrlKey && !(isMac && wheel.metaKey)) return;
      wheel.preventDefault();
      if (gestureScale || !wheel.deltaY) return;
      // A trackpad pinch arrives as small pixel deltas and follows the fingers
      // (Chromium's convention); wheel notches use the configured speed.
      const pinch = wheel.deltaMode === 0 && Math.abs(wheel.deltaY) < 50;
      const delta = wheel.deltaY * (wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? root.clientHeight : 1);
      zoomAt(currentScale.current * Math.exp(pinch ? -delta / 100 : -Math.max(-200, Math.min(200, delta)) * .001 * live.current.wheelSpeed() / 100), wheel);
    };
    // WebKit on macOS reports trackpad pinches as gesture events, not ctrl+wheel.
    // Touch layouts handle two-finger pinches with touch events instead.
    const onGesture = (event: Event) => {
      const gesture = event as Event & { scale: number; clientX: number; clientY: number };
      event.preventDefault();
      if (event.type === 'gesturestart') gestureScale = currentScale.current;
      else if (event.type === 'gestureend') gestureScale = 0;
      else if (gestureScale && live.current.currentId()) zoomAt(gestureScale * gesture.scale, gesture);
    };
    const gestures = touchLayout ? [] : ['gesturestart', 'gesturechange', 'gestureend'];
    shell.addEventListener('wheel', onWheel, { passive: false });
    for (const type of gestures) shell.addEventListener(type, onGesture, { passive: false });
    return () => { shell.removeEventListener('wheel', onWheel); for (const type of gestures) shell.removeEventListener(type, onGesture); };
  }, [touchLayout, viewer, zoomAt]);

  // Two fingers pan, or zoom once their spacing clearly changes, on any touch
  // screen: with Lápiz or Goma a single finger draws.
  const { pinchable } = options;
  useEffect(() => {
    const root = viewer.current;
    if (!root || !pinchable) return;
    type Pinch = { stack: HTMLElement; distance: number; scale: number; next: number; pinched: boolean; originX: number; originY: number; centerX: number; centerY: number; pointerX: number; pointerY: number; page: number; x: number; y: number; id: string; frame: number };
    let gesture: Pinch | null = null;
    const geometry = (event: TouchEvent) => {
      const a = event.touches[0], b = event.touches[1];
      return { distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    };
    const clearPreview = (active: Pinch) => {
      cancelAnimationFrame(active.frame); active.stack.style.removeProperty('transform'); active.stack.style.removeProperty('transform-origin');
      root.classList.remove('pinching');
    };
    const start = (event: TouchEvent) => {
      const id = live.current.currentId();
      if (event.touches.length !== 2 || gesture || !id || !live.current.canPinch() || document.querySelector('dialog[open], .mobile-drawer')) return;
      const center = geometry(event), stack = root.querySelector<HTMLElement>('.pdf-stack');
      const node = document.elementFromPoint(center.x, center.y)?.closest<HTMLElement>('.pdf-page') || root.querySelector<HTMLElement>(`[data-page-number="${live.current.currentPage()}"] .pdf-page`);
      if (!stack || !node) return;
      event.preventDefault(); document.getSelection()?.removeAllRanges(); window.dispatchEvent(new Event('folio:pinch-start'));
      const bounds = node.getBoundingClientRect(), stackBounds = stack.getBoundingClientRect();
      gesture = { stack, distance: center.distance, scale: currentScale.current, next: currentScale.current, pinched: false, originX: center.x - stackBounds.left, originY: center.y - stackBounds.top,
        centerX: center.x, centerY: center.y, pointerX: center.x, pointerY: center.y, page: Number(node.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber),
        x: (center.x - bounds.left) / bounds.width, y: (center.y - bounds.top) / bounds.height, id, frame: 0 };
      stack.style.transformOrigin = `${gesture.originX}px ${gesture.originY}px`; root.classList.add('pinching');
    };
    const move = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 2) return;
      event.preventDefault(); const center = geometry(event), active = gesture;
      // Fingers drift while scrolling: only a clear change of spacing starts the zoom, which then follows the whole gesture.
      if (!active.pinched && Math.abs(center.distance - active.distance) > Math.max(6, active.distance * .08)) active.pinched = true;
      if (active.pinched) active.next = Math.max(.25, Math.min(MAX_ZOOM, active.scale * center.distance / active.distance));
      active.pointerX = center.x; active.pointerY = center.y;
      if (active.frame) cancelAnimationFrame(active.frame);
      active.frame = requestAnimationFrame(() => { active.stack.style.transform = `translate(${active.pointerX - active.centerX}px, ${active.pointerY - active.centerY}px) scale(${active.next / active.scale})`; });
    };
    const finish = (event: TouchEvent) => {
      if (!gesture || event.touches.length >= 2) return;
      event.preventDefault(); const active = gesture; gesture = null; clearPreview(active);
      if (live.current.currentId() !== active.id) return;
      const frame = root.getBoundingClientRect(), next = Math.round(active.next * 1000) / 1000;
      // A pan keeps the zoom mode, so Ajustar página still refits.
      if (!active.pinched || Math.abs(next - currentScale.current) < .0005 && zoomModeRef.current === 'custom') {
        const node = root.querySelector<HTMLElement>(`[data-page-number="${active.page}"] .pdf-page`), bounds = node?.getBoundingClientRect();
        if (bounds) { root.scrollLeft += bounds.left + bounds.width * active.x - active.pointerX; root.scrollTop += bounds.top + bounds.height * active.y - active.pointerY; }
        return;
      }
      pointerAnchor.current = { id: active.id, page: active.page, x: active.x, y: active.y, pointerX: active.pointerX - frame.left, pointerY: active.pointerY - frame.top };
      currentScale.current = next; setCustomScale(next); setZoomMode('custom');
    };
    const cancel = () => { if (gesture) { clearPreview(gesture); gesture = null; } };
    const background = () => { if (document.visibilityState === 'hidden') cancel(); };
    root.addEventListener('touchstart', start, { passive: false }); root.addEventListener('touchmove', move, { passive: false }); root.addEventListener('touchend', finish, { passive: false }); root.addEventListener('touchcancel', cancel);
    window.addEventListener('blur', cancel); window.addEventListener('pagehide', cancel); document.addEventListener('visibilitychange', background);
    return () => { cancel(); root.removeEventListener('touchstart', start); root.removeEventListener('touchmove', move); root.removeEventListener('touchend', finish); root.removeEventListener('touchcancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('pagehide', cancel); document.removeEventListener('visibilitychange', background); };
  }, [pinchable, viewer]);

  return { zoomMode, setZoomMode, customScale, setCustomScale, scale, currentScale, readingAnchor, zoomAt, changeZoom, toggleTapZoom };
}

/** The reader's size, which page and width fits follow. `keepWidth`: the reader chrome or
 * Android's system bars are hidden, and the height they free does not refit the page. */
export function useViewportSize(viewer: RefObject<HTMLDivElement | null>, layoutKey: unknown, keepWidth: () => boolean) {
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const keep = useRef(keepWidth); keep.current = keepWidth;
  useEffect(() => {
    const root = viewer.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      // The reader remains mounted while editing; hiding it must not change its fit zoom.
      if (root.clientWidth > 0 && root.clientHeight > 0) setSize(previous => keep.current() && previous.width === root.clientWidth ? previous : { width: root.clientWidth, height: root.clientHeight });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [viewer, layoutKey]);
  return size;
}
