import type { Annotation, BookmarkNode } from '../types';
import { trimHistory, type History } from './model';

/** What undo needs from the app around it. */
export type HistoryHost = {
  /** The memory snapshots of the PDF may use (less on a phone). */
  budget: () => number;
  /** Something else holds the document now (an unapplied edit, an operation, Editar writing). */
  blocked: () => boolean;
  /** Undo or redo of Editar's live document, and whether one is open. */
  liveOpen: () => boolean; stepLive: (direction: 'undo' | 'redo') => void; writeLive: () => Promise<void>;
  /** The document as an undo step that holds its PDF. */
  snapshot: () => History;
  /** Reopens a PDF snapshot; on failure the step goes back where it came from. */
  restore: (step: History, from: History[], to: History[]) => Promise<void>;
  /** The annotations and bookmarks now, and setting them back. */
  current: () => { annotations: Annotation[]; bookmarks: BookmarkNode[] };
  apply: (annotations: Annotation[], bookmarks?: BookmarkNode[]) => void;
  /** The stacks changed: the undo and redo buttons follow. */
  changed: () => void;
};

/** One tab's undo and redo. A step holds annotations and bookmarks, or the whole PDF
 * before a change to it (`bytes`), or marks a change in Editar's live document (`session`). */
export class UndoHistory {
  /** Set on each render, as EditStore's actions are. */
  host!: HistoryHost;
  /** The active tab's stacks; each tab keeps its own, swapped in when it is shown. */
  undo: History[] = [];
  redo: History[] = [];
  // A gesture (a drag, a slider) records one step however many changes it makes.
  private gesture: string | undefined;

  /** At most 50 steps, 20 of them PDF snapshots, within the memory budget. */
  trim(stack: History[]) { trimHistory(stack, this.host.budget()); }

  /** Records a step (one per `gesture`) and forgets what was undone. False when the step is too large to keep. */
  record(step: History, gesture?: string) {
    if (!gesture || this.gesture !== gesture) this.undo.push(step);
    this.gesture = gesture;
    this.trim(this.undo); this.redo = []; this.host.changed();
    return !!gesture || this.undo.at(-1) === step;
  }

  /** Undoes or redoes one step; the state it replaces goes to the other stack. */
  step(direction: 'undo' | 'redo') {
    const { host } = this;
    if (host.blocked()) return;
    const [from, to] = direction === 'undo' ? [this.undo, this.redo] : [this.redo, this.undo];
    const step = from.pop();
    if (!step) return;
    this.gesture = undefined;
    if (step.session) { to.push(step); host.stepLive(direction); return; }
    // The PDF before Editar replaces the live document's: what it holds now is written first, to redo.
    if (direction === 'undo' && step.bytes && host.liveOpen()) { void host.writeLive().catch(() => {}).then(() => { to.push(host.snapshot()); this.trim(to); return host.restore(step, from, to); }); return; }
    to.push(step.bytes ? host.snapshot() : { ...host.current() });
    this.trim(to);
    if (step.bytes) { void host.restore(step, from, to); return; }
    host.apply(step.annotations, step.bookmarks); host.changed();
  }
}
