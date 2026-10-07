import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { haptic } from '../platform';
import './ActivityPill.css';

export type ActivityStep = { id: number; label: string };

/** A floating capsule for work in progress (saving, syncing, printing…).
 * `working` is the running task; when it ends, `done` (its real outcome, if
 * any) turns the looping ring into a drawn check before the capsule leaves.
 * The parent only passes `done` when the capsule had time to appear. */
export function ActivityPill({ working, done }: { working: ActivityStep | null; done: ActivityStep | null }) {
  const [shown, setShown] = useState<{ step: ActivityStep; phase: 'working' | 'done' | 'leaving' } | null>(null);
  const appeared = useRef(0), node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (working) { setShown(current => { if (current?.step.id !== working.id) appeared.current = performance.now(); return { step: working, phase: 'working' }; }); return; }
    if (done) { setShown({ step: done, phase: 'done' }); haptic('success'); return; }
    // Ended without an outcome to show: quick work leaves no trace.
    setShown(current => !current || current.phase !== 'working' ? current : performance.now() - appeared.current < 260 ? null : { ...current, phase: 'leaving' });
  }, [working?.id, working?.label, done?.id]);
  useEffect(() => {
    if (!shown || shown.phase === 'working') return;
    const timer = window.setTimeout(() => setShown(current => current?.phase === 'done' ? { ...current, phase: 'leaving' } : null), shown.phase === 'done' ? 1600 : 220);
    return () => window.clearTimeout(timer);
  }, [shown?.phase, shown?.step.id]);
  // Above any open dialog, like the notices.
  useLayoutEffect(() => {
    const element = node.current as (HTMLDivElement & { showPopover?: () => void }) | null;
    if (element?.showPopover && !element.matches(':popover-open')) element.showPopover();
  });
  if (!shown) return null;
  return <div ref={node} popover="manual" className={`activity-pill ${shown.phase}`} role="status" aria-live="polite">
    <svg className="activity-ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="activity-ring-track" cx="12" cy="12" r="9" />
      <circle className="activity-ring-arc" cx="12" cy="12" r="9" />
      <path className="activity-check" d="M7.5 12.3l3 3 6-6.6" />
    </svg>
    <span key={shown.phase === 'working' ? 'working' : 'done'} className="activity-label">{shown.step.label}</span>
    <span className="activity-line" aria-hidden="true"><span /></span>
  </div>;
}
