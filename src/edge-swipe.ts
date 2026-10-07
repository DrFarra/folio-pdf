import { useEffect, useRef } from 'react';

/** iOS-style back gesture: a swipe that starts at the left screen edge drags
 * the reader to the right; letting go past a third of the width, or with a
 * quick flick, completes it and calls `onBack`, otherwise it settles back.
 * Android's own edge gesture (system back) takes precedence where enabled. */
export function useEdgeSwipeBack(enabled: boolean, onBack: () => void, selector = '.reader') {
  const back = useRef(onBack); back.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    let gesture: { x: number; y: number; at: number; engaged: boolean; target: HTMLElement; dx: number; lastX: number; lastAt: number } | null = null;
    const edge = () => 24 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-left')) || 0);
    const reset = (element: HTMLElement) => { element.style.removeProperty('transform'); element.style.removeProperty('transition'); element.style.removeProperty('box-shadow'); document.documentElement.classList.remove('edge-swiping'); };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1 || document.querySelector('dialog[open], .mobile-drawer, .document-switcher')) return;
      const touch = event.touches[0], target = document.querySelector<HTMLElement>(selector);
      if (!target || touch.clientX > edge()) return;
      gesture = { x: touch.clientX, y: touch.clientY, at: performance.now(), engaged: false, target, dx: 0, lastX: touch.clientX, lastAt: performance.now() };
    };
    const move = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0], dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
      if (!gesture.engaged) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > dx) { gesture = null; return; }
        if (dx < 10) return;
        gesture.engaged = true; document.documentElement.classList.add('edge-swiping');
        gesture.target.style.transition = 'none'; gesture.target.style.boxShadow = '-14px 0 40px #0006';
      }
      event.preventDefault();
      gesture.dx = Math.max(0, dx); gesture.lastX = touch.clientX; gesture.lastAt = performance.now();
      gesture.target.style.transform = `translate3d(${gesture.dx}px,0,0)`;
    };
    const end = (event: TouchEvent) => {
      const active = gesture; gesture = null;
      if (!active?.engaged) return;
      const width = window.innerWidth, velocity = (active.lastX - active.x) / Math.max(1, active.lastAt - active.at);
      const complete = active.dx > width / 3 || velocity > .5 && active.dx > 40;
      active.target.style.transition = 'transform .24s cubic-bezier(.32,.72,0,1)';
      active.target.style.transform = complete ? `translate3d(${width}px,0,0)` : 'translate3d(0,0,0)';
      window.setTimeout(() => { if (complete) back.current(); window.setTimeout(() => reset(active.target), complete ? 60 : 0); }, 240);
      if (event.cancelable) event.preventDefault();
    };
    const cancel = () => { const active = gesture; gesture = null; if (active?.engaged) { active.target.style.transition = 'transform .2s ease-out'; active.target.style.transform = 'translate3d(0,0,0)'; window.setTimeout(() => reset(active.target), 200); } };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end, { passive: false });
    window.addEventListener('touchcancel', cancel);
    return () => { window.removeEventListener('touchstart', start); window.removeEventListener('touchmove', move); window.removeEventListener('touchend', end); window.removeEventListener('touchcancel', cancel); };
  }, [enabled, selector]);
}
