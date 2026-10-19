import { useRef } from 'react';

/** A ref holding `value` as of the latest render, for code that runs between renders
 * (listeners, timers, controllers) and must not see a stale one. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
