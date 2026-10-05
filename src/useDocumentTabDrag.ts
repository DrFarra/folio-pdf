import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { isMobile } from './platform';

type Drop = { key: string; side: 'before' | 'after'; index: number };
type Options = { keys: string[]; activeKey: string | null; disabled: boolean; onReorder: (keys: string[]) => void };
type Gesture = { pointerId: number; key: string; startX: number; startY: number; x: number; y: number; active: boolean; cleanup: () => void };

export function useDocumentTabDrag(options: Options) {
  const strip = useRef<HTMLDivElement>(null);
  const current = useRef(options); current.current = options;
  const gesture = useRef<Gesture | null>(null);
  const destination = useRef<Drop | null>(null);
  const suppressClick = useRef(false);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [location, setLocation] = useState({ x: 0, y: 0 });

  function cancel() {
    const active = gesture.current; gesture.current = null; active?.cleanup();
    destination.current = null; setDrop(null); setDraggingKey(null);
  }
  useEffect(() => () => { gesture.current?.cleanup(); }, []);
  useEffect(() => { if (options.disabled) cancel(); }, [options.disabled]);
  useEffect(() => { if (gesture.current && !options.keys.includes(gesture.current.key)) cancel(); }, [options.keys]);

  function updateDrop(x: number, y: number) {
    const container = strip.current;
    let next: Drop | null = null;
    if (container) {
      const bounds = container.getBoundingClientRect();
      if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
        const tabs = [...container.querySelectorAll<HTMLElement>('[data-tab-key]')];
        let nearest: { element: HTMLElement; index: number; distance: number } | null = null;
        for (const [index, element] of tabs.entries()) {
          const rect = element.getBoundingClientRect();
          const distance = Math.max(rect.left - x, x - rect.right, 0);
          if (!nearest || distance < nearest.distance) nearest = { element, index, distance };
        }
        if (nearest) {
          const tab = nearest.element;
          const rect = tab.getBoundingClientRect(), after = x >= rect.left + rect.width / 2;
          next = { key: tab.dataset.tabKey!, side: after ? 'after' : 'before', index: nearest.index + (after ? 1 : 0) };
        }
      }
    }
    if (destination.current?.key !== next?.key || destination.current?.side !== next?.side) {
      destination.current = next; setDrop(next);
    }
  }

  function begin(event: ReactPointerEvent<HTMLElement>, key: string) {
    suppressClick.current = false;
    if (isMobile || current.current.disabled || current.current.keys.length < 2 || event.button !== 0 || event.pointerType !== 'mouse' ||
        (event.target as Element).closest('.document-tab-close')) return;
    cancel();
    const source = event.currentTarget;
    const initialKeys = [...current.current.keys];
    const active: Gesture = { pointerId: event.pointerId, key, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, cleanup: () => {} };
    gesture.current = active;
    let frame = 0;
    const autoScroll = () => {
      if (gesture.current !== active || !active.active) return;
      const container = strip.current;
      if (container) {
        const bounds = container.getBoundingClientRect(), edge = Math.min(40, bounds.width / 4);
        if (active.y >= bounds.top && active.y <= bounds.bottom && active.x >= bounds.left && active.x <= bounds.right) {
          const speed = active.x < bounds.left + edge ? -Math.ceil((bounds.left + edge - active.x) / 4)
            : active.x > bounds.right - edge ? Math.ceil((active.x - bounds.right + edge) / 4) : 0;
          if (speed) { container.scrollLeft += speed; updateDrop(active.x, active.y); }
        }
      }
      frame = requestAnimationFrame(autoScroll);
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== active.pointerId) return;
      active.x = pointer.clientX; active.y = pointer.clientY;
      if (!active.active) {
        if (Math.hypot(active.x - active.startX, active.y - active.startY) < 5) return;
        active.active = true; suppressClick.current = true;
        source.setPointerCapture?.(active.pointerId); document.getSelection()?.removeAllRanges();
        setDraggingKey(key); frame = requestAnimationFrame(autoScroll);
      }
      pointer.preventDefault(); setLocation({ x: active.x, y: active.y }); updateDrop(active.x, active.y);
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== active.pointerId) return;
      if (active.active) {
        pointer.preventDefault(); updateDrop(pointer.clientX, pointer.clientY);
        const { keys, disabled, onReorder } = current.current;
        const target = destination.current;
        if (!disabled && target && keys.length === initialKeys.length && keys.every((item, index) => item === initialKeys[index])) {
          const from = keys.indexOf(key), remaining = keys.filter(item => item !== key);
          const index = target.index - (from < target.index ? 1 : 0);
          const next = [...remaining.slice(0, index), key, ...remaining.slice(index)];
          if (next.some((item, position) => item !== keys[position])) onReorder(next);
        }
        // A pointerup generates a click immediately afterward; consume that click only.
        setTimeout(() => { suppressClick.current = false; }, 0);
      }
      cancel();
    };
    const abort = () => { cancel(); };
    const keyDown = (keyboard: KeyboardEvent) => {
      if (keyboard.key === 'Escape' && active.active) { keyboard.preventDefault(); keyboard.stopPropagation(); abort(); }
    };
    active.cleanup = () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerup', finish, true);
      document.removeEventListener('pointercancel', abort, true); document.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('blur', abort);
      if (source.hasPointerCapture?.(active.pointerId)) source.releasePointerCapture(active.pointerId);
    };
    document.addEventListener('pointermove', move, { capture: true, passive: false }); document.addEventListener('pointerup', finish, true);
    document.addEventListener('pointercancel', abort, true); document.addEventListener('keydown', keyDown, true);
    window.addEventListener('blur', abort);
  }

  function clickCapture(event: MouseEvent<HTMLDivElement>) {
    if (suppressClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
  }
  return { strip, begin, clickCapture, draggingKey, drop, location, enabled: !isMobile };
}
