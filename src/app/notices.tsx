import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Info, X } from 'lucide-react';
import type { ActivityStep } from '../components/ActivityPill';
import { useExit } from '../motion';
import type { ToastKind } from './model';

type ToastAction = { label: string; run: () => void };
export type Toast = { message: string; kind: ToastKind; id: number; action?: ToastAction };
export type Notify = (message: string, kind?: ToastKind, action?: ToastAction) => void;

/** Notices and the activity capsule. ✓ confirms a completed action and «i» explains a
 * blocked one; errors stay until closed. While `activityLabel` names a running task
 * (saving, syncing, printing, applying edits) the capsule shows it, and its outcome
 * waits for the capsule, which shows it in place. */
export function useNotices(activityLabel: string) {
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityRun = useRef<{ started: number; result?: { message: string; kind: ToastKind } } | null>(null);
  const notify = useCallback<Notify>((message, kind = 'info', action) => {
    if (activityRun.current && kind !== 'error' && !action) {
      activityRun.current.result = { message, kind };
      return;
    }
    setToast(previous => ({ message, kind, id: (previous?.id || 0) + 1, action }));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    // A notice with an action stays longer, so there is time to use it.
    toastTimer.current = kind === 'error' ? null : setTimeout(() => setToast(null), action ? 6000 : 3500);
  }, []);
  const dismiss = useCallback(() => setToast(null), []);
  const [activity, setActivity] = useState<ActivityStep | null>(null);
  const [activityDone, setActivityDone] = useState<ActivityStep | null>(null);
  useEffect(() => {
    if (activityLabel) {
      if (!activityRun.current) {
        activityRun.current = { started: performance.now() };
        setActivityDone(null);
        setActivity({ id: Date.now(), label: activityLabel });
      } else setActivity(current => current && { ...current, label: activityLabel });
      return;
    }
    const run = activityRun.current;
    if (!run) return;
    activityRun.current = null;
    setActivity(null);
    // Quick work keeps its usual notice; longer work shows its outcome in the capsule.
    if (run.result && performance.now() - run.started >= 260)
      setActivityDone({ id: Date.now(), label: run.result.message });
    else if (run.result) notify(run.result.message, run.result.kind);
  }, [activityLabel, notify]);
  return { toast, notify, dismiss, activity, activityDone };
}

/** The current notice, which stays while it animates out; screen readers hear every notice through the live regions. */
export function Notices({ toast, onDismiss }: { toast: Toast | null; onDismiss: () => void }) {
  const leaving = useExit(!!toast, 150);
  const last = useRef(toast);
  if (toast) last.current = toast;
  const shown = toast || (leaving ? last.current : null);
  const node = useRef<HTMLDivElement>(null);
  // The toast joins the top layer again on each notice, above any dialog opened since.
  useLayoutEffect(() => {
    const element = node.current;
    if (!element?.showPopover) return;
    if (element.matches(':popover-open')) element.hidePopover();
    element.showPopover();
  }, [toast]);
  return (
    <>
      {shown && (
        <div
          key={shown.id}
          ref={node}
          popover="manual"
          className={`toast ${shown.kind === 'error' ? 'error' : ''}${toast ? '' : ' closing'}`}
        >
          {shown.kind === 'error' ? (
            <CircleAlert size={18} />
          ) : shown.kind === 'info' ? (
            <Info size={18} />
          ) : (
            <Check size={18} />
          )}
          <span>{shown.message}</span>
          {shown.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                const action = shown.action!;
                onDismiss();
                action.run();
              }}
            >
              {shown.action.label}
            </button>
          )}
          <button aria-label="Cerrar aviso" onClick={onDismiss}>
            <X size={15} />
          </button>
        </div>
      )}
      <div className="sr-only" role="status">
        {toast && toast.kind !== 'error' && <span key={toast.id}>{toast.message}</span>}
      </div>
      <div className="sr-only" role="alert">
        {toast?.kind === 'error' && <span key={toast.id}>{toast.message}</span>}
      </div>
    </>
  );
}
