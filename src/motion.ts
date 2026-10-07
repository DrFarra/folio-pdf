import { useEffect, useState } from 'react';

/** Exit durations in motion.css: phones close sheets, wider screens fade. */
export const exitDuration = () => document.documentElement.hasAttribute('data-phone') ? 220 : 150;

/** Keeps a conditionally rendered element on screen while it plays its exit.
 * Returns true from the render where `shown` turns false until the exit ends,
 * so the element never unmounts and remounts (its scroll position is kept). */
export function useExit(shown: boolean, duration = exitDuration()) {
  const [leaving, setLeaving] = useState(false);
  const [previous, setPrevious] = useState(shown);
  if (previous !== shown) { setPrevious(shown); setLeaving(!shown); }
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(false), duration);
    return () => clearTimeout(timer);
  }, [leaving, duration]);
  return leaving;
}
