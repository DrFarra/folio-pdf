import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { haptic } from '../platform';

type Page = { key: string; label: string };
type Drop = { key: string; side: 'before' | 'after'; index: number };
type Gesture = {
  pointerId: number;
  keys: string[];
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  cleanup: () => void;
};

// Pointer gestures also work in desktop WebViews that reserve native drag/drop for files.
export function usePagePlanDrag<T extends Page>(
  plan: T[],
  selected: string[],
  disabled: boolean,
  onChange: (plan: T[]) => void,
) {
  const grid = useRef<HTMLDivElement>(null);
  const current = useRef({ plan, disabled, onChange });
  current.current = { plan, disabled, onChange };
  const gesture = useRef<Gesture | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const suppressClick = useRef(false);
  const [draggingKeys, setDraggingKeys] = useState<string[]>([]);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [location, setLocation] = useState({ x: 0, y: 0 });

  function cancel(keepClickSuppressed = false) {
    const active = gesture.current;
    gesture.current = null;
    active?.cleanup();
    setDraggingKeys([]);
    setDrop(null);
    dropRef.current = null;
    if (!keepClickSuppressed) suppressClick.current = false;
  }
  useEffect(
    () => () => {
      gesture.current?.cleanup();
    },
    [],
  );
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);

  function updateDrop(x: number, y: number) {
    const container = grid.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    let next: Drop | null = null;
    if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
      const cards = [...container.querySelectorAll<HTMLElement>('[data-plan-key]')].map((element, index) => ({
        element,
        index,
        bounds: element.getBoundingClientRect(),
      }));
      // Choose the closest row/card so the gaps between thumbnails are valid drop areas too.
      const closest = cards.reduce<(typeof cards)[number] | null>((best, card) => {
        const distance = (item: typeof card) =>
          Math.max(item.bounds.top - y, y - item.bounds.bottom, 0) * 10000 +
          Math.max(item.bounds.left - x, x - item.bounds.right, 0);
        return !best || distance(card) < distance(best) ? card : best;
      }, null);
      if (closest) {
        const after = x >= closest.bounds.left + closest.bounds.width / 2;
        next = {
          key: closest.element.dataset.planKey!,
          side: after ? 'after' : 'before',
          index: closest.index + (after ? 1 : 0),
        };
      }
    }
    if (dropRef.current?.key !== next?.key || dropRef.current?.side !== next?.side) {
      dropRef.current = next;
      setDrop(next);
    }
  }

  function begin(event: ReactPointerEvent<HTMLElement>, key: string) {
    if (
      current.current.disabled ||
      event.button !== 0 ||
      !event.isPrimary ||
      (event.target as Element).closest('input, label, .plan-move')
    )
      return;
    cancel();
    const source = event.currentTarget;
    // Touch and pen pick a page up by holding it still, so a swipe still scrolls the grid.
    const touch = event.pointerType !== 'mouse';
    const keys = selected.includes(key)
      ? plan.filter(page => selected.includes(page.key)).map(page => page.key)
      : [key];
    const active: Gesture = {
      pointerId: event.pointerId,
      keys,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
      cleanup: () => {},
    };
    gesture.current = active;
    let scrollFrame = 0,
      holdTimer = 0;
    const activate = () => {
      active.active = true;
      suppressClick.current = true;
      source.setPointerCapture?.(active.pointerId);
      document.getSelection()?.removeAllRanges();
      setDraggingKeys(keys);
      setLocation({ x: active.x, y: active.y });
      updateDrop(active.x, active.y);
      scrollFrame = requestAnimationFrame(autoScroll);
    };
    const autoScroll = () => {
      if (gesture.current !== active || !active.active) return;
      const container = grid.current;
      if (container) {
        const bounds = container.getBoundingClientRect();
        if (
          active.x >= bounds.left &&
          active.x <= bounds.right &&
          active.y >= bounds.top &&
          active.y <= bounds.bottom
        ) {
          const edge = Math.min(42, bounds.height / 4);
          const speed =
            active.y < bounds.top + edge
              ? -Math.ceil((bounds.top + edge - active.y) / 4)
              : active.y > bounds.bottom - edge
                ? Math.ceil((active.y - bounds.bottom + edge) / 4)
                : 0;
          if (speed) {
            container.scrollTop += speed;
            updateDrop(active.x, active.y);
          }
        }
      }
      scrollFrame = requestAnimationFrame(autoScroll);
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== active.pointerId) return;
      active.x = pointer.clientX;
      active.y = pointer.clientY;
      if (!active.active) {
        const moved = Math.hypot(active.x - active.startX, active.y - active.startY);
        // A finger that moves before the hold completes is scrolling: let it go.
        if (touch) {
          if (moved > 10) cancel();
          return;
        }
        if (moved < 5) return;
        activate();
      }
      pointer.preventDefault();
      setLocation({ x: active.x, y: active.y });
      updateDrop(active.x, active.y);
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== active.pointerId) return;
      if (active.active) {
        pointer.preventDefault();
        // A lifted finger can report no position; the last move is where the page is.
        updateDrop(active.x, active.y);
        const { plan: pages, disabled, onChange } = current.current;
        const destination = dropRef.current;
        if (!disabled && destination) {
          const moving = pages.filter(page => keys.includes(page.key)),
            remaining = pages.filter(page => !keys.includes(page.key));
          const index =
            destination.index - pages.slice(0, destination.index).filter(page => keys.includes(page.key)).length;
          const next = [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
          if (next.some((page, position) => page.key !== pages[position].key)) onChange(next);
        }
        setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
      cancel(active.active);
    };
    const abort = () => {
      const wasActive = active.active;
      cancel(wasActive);
      if (wasActive)
        setTimeout(() => {
          suppressClick.current = false;
        }, 0);
    };
    const keyDown = (keyboard: KeyboardEvent) => {
      if (keyboard.key === 'Escape' && active.active) {
        keyboard.preventDefault();
        keyboard.stopPropagation();
        abort();
      }
    };
    // Once a page is held, the finger drags it instead of panning the grid.
    const touchMove = (touchEvent: TouchEvent) => {
      if (active.active && touchEvent.cancelable) touchEvent.preventDefault();
    };
    const contextMenu = (menu: Event) => menu.preventDefault();
    if (touch)
      holdTimer = window.setTimeout(() => {
        if (gesture.current !== active) return;
        haptic('medium');
        activate();
      }, 380);
    active.cleanup = () => {
      window.clearTimeout(holdTimer);
      cancelAnimationFrame(scrollFrame);
      document.removeEventListener('touchmove', touchMove);
      source.removeEventListener('contextmenu', contextMenu);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', finish, true);
      document.removeEventListener('pointercancel', abort, true);
      document.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('blur', abort);
      if (source.hasPointerCapture?.(active.pointerId)) source.releasePointerCapture(active.pointerId);
    };
    if (touch) {
      document.addEventListener('touchmove', touchMove, { passive: false });
      source.addEventListener('contextmenu', contextMenu);
    }
    document.addEventListener('pointermove', move, { capture: true, passive: false });
    document.addEventListener('pointerup', finish, true);
    document.addEventListener('pointercancel', abort, true);
    document.addEventListener('keydown', keyDown, true);
    window.addEventListener('blur', abort);
  }

  function clickCapture(event: MouseEvent<HTMLDivElement>) {
    if (suppressClick.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  const first = plan.find(page => draggingKeys.includes(page.key));
  const destinationPosition = drop
    ? drop.index - plan.slice(0, drop.index).filter(page => draggingKeys.includes(page.key)).length + 1
    : null;
  return {
    grid,
    begin,
    clickCapture,
    draggingKeys,
    drop,
    location,
    label: draggingKeys.length > 1 ? `${draggingKeys.length} páginas` : first?.label,
    destinationPosition,
  };
}
