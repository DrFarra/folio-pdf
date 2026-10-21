import { useEffect } from 'react';
import { flushNudge } from '../edit/actions';
import { usePastedImages } from '../edit/paste';
import type { EditStore } from '../edit/store';
import { errorMessage } from '../errors';
import { isNativePdfDocument } from '../nativePdf';
import type { Annotation, LoadedDocument } from '../types';
import type { Notify } from './notices';
import { PARK_LIMIT, type History } from './model';

/** What the live document needs from the app around it. */
export type LiveEditHost = {
  store: EditStore;
  /** The document in front, and whether Editar is open on it. */
  current: () => LoadedDocument | null;
  editing: () => boolean;
  touch: () => boolean;
  /** The document's state as an undo step, and the memory undo may use. */
  snapshot: () => History;
  historyBudget: () => number;
  trim: (stack: History[]) => void;
  /** The undo and redo stacks of the tab holding `doc` (the active tab's when none does). */
  stacks: (doc: LoadedDocument | null) => [History[], History[]];
  historyChanged: () => void;
  /** `next` (the written PDF) replaces `previous` wherever it is held, without reopening it. */
  written: (previous: LoadedDocument, next: LoadedDocument) => void;
  /** The reader opens `doc` (the PDF written last) in place of its copy. */
  reopen: (doc: LoadedDocument) => Promise<void>;
  /** A tab in the background holds `doc`, written after the reader opened it: it reloads when shown. */
  outdated: (doc: LoadedDocument) => void;
  notify: Notify;
};

/** Editar's live document on desktop. While Editar is open, the document stays open in a
 * worker of its own (EditSession): each change is made there and its page drawn from
 * there, with nothing copied or reopened. The PDF is written out after a pause, before
 * saving or switching documents, and when Editar closes, which is when the reader opens
 * it again. Leaving Editar parks a document up to PARK_LIMIT: it stays live, so its
 * changes still undo one by one and Editar opens again at once; switching documents closes it. */
export class LiveEdit {
  /** Set on each render, as EditStore's actions are. */
  host!: LiveEditHost;
  // The document it was opened for, its latest written copy, the PDF before it and its depth in its own undo steps.
  private start: LoadedDocument | null = null;
  private doc: LoadedDocument | null = null;
  private base: History | null = null;
  private depth = 0;
  // The document as its file holds it, when Editar opened on it unchanged: undoing every change returns to it.
  private origin: LoadedDocument | null = null;
  // How long the last write took (ms), whether a change waits to be written, and the writes.
  private writeMs = 0;
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private parking: Promise<void> | null = null;
  // The reader is reopening the parked document's PDF.
  private rebinding = false;
  /** The document a save gave a new id (its file's): still the same document, so Editar is not started afresh. */
  renamed: LoadedDocument | null = null;

  /** Parking or closing is under way: history steps wait for it. */
  get settling() {
    return !!this.closing || !!this.parking;
  }

  /** Whether Editar keeps `doc` live (not on touch layouts, nor for PDFs PDFKit reads from their file). */
  editable(doc: LoadedDocument | null) {
    return !!doc && !this.host.touch() && doc.canEdit && !isNativePdfDocument(doc.pdf);
  }

  /** Follows Editar opening and closing, and the document in front changing. */
  sync(editing: boolean, doc: LoadedDocument | null) {
    const { store } = this.host;
    if (editing && this.editable(doc)) {
      if (!this.settling) this.open(doc!);
    } else if (
      store.session &&
      doc &&
      !this.host.touch() &&
      store.state.live?.pdf === doc.pdf &&
      doc.bytes.length <= PARK_LIMIT
    )
      void this.park();
    else if (!this.rebinding) void this.close();
  }

  open(current: LoadedDocument) {
    const { store } = this.host;
    if (store.session && !store.session.broken && store.state.live?.pdf === current.pdf) return;
    // The reader opened another copy under Editar (a save, an undo past its start): the old live document is closed first.
    if (store.session) {
      void this.close();
      return;
    }
    const session = store.open(current);
    this.start = this.doc = current;
    this.origin = current.modified ? null : current;
    this.depth = 0;
    this.pending = false;
    // Until a write is timed, about a millisecond per MB (a 238 MB book: ~250 ms here, longer on a laptop).
    this.writeMs = current.bytes.length / 1048576;
    // Too large a PDF is not kept to undo, as with any change (trimHistory).
    this.base = current.bytes.length <= this.host.historyBudget() ? this.host.snapshot() : null;
    session.ready.catch(error =>
      this.host.notify(errorMessage(error, 'No se pudo abrir el documento para editarlo.'), 'error'),
    );
  }

  /** A change was made on `page` of the live document, with `annotations` alongside: its undo step,
   * the first one marked as the return to the PDF before Editar. */
  changed(page: number, annotations: Annotation[]): History {
    const step: History = { annotations, session: true, ...(this.depth++ === 0 ? { base: true as const } : {}) };
    this.host.store.changed(page);
    this.scheduleWrite();
    // Written on the way out of Editar (a nudge): the reader opens it at once, after any park under way.
    if (!this.host.editing()) void (this.parking ?? Promise.resolve()).then(() => this.park());
    return step;
  }

  // Writing holds the live document, so a change made meanwhile waits for it («Guardando el
  // cambio…»): a book that takes seconds to write waits for a longer pause than a short PDF.
  private scheduleWrite() {
    this.pending = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        void this.write().catch(() => {});
      },
      Math.min(15000, Math.max(800, this.writeMs * 4)),
    );
  }

  /** Writes the live document's PDF and makes it the document's bytes (and its draft). The reader keeps its copy. */
  write(): Promise<void> {
    clearTimeout(this.timer);
    const { store } = this.host,
      session = store.session;
    if (!session || !this.pending) return this.writing;
    this.pending = false;
    const write = this.writing
      .catch(() => {})
      .then(async () => {
        // Every change undone: the document is its file again, with nothing to write or save.
        const origin = this.depth === 0 ? this.origin : null;
        if (origin && this.doc) {
          const previous = this.doc,
            next =
              this.start === origin
                ? origin
                : { ...previous, bytes: origin.bytes, revision: origin.revision, size: origin.size, modified: false };
          if (next === previous) return;
          this.doc = next;
          this.host.written(previous, next);
          return;
        }
        const started = performance.now(),
          { bytes, revision } = await session.save();
        this.writeMs = performance.now() - started;
        const previous = this.doc;
        if (store.session !== session || !previous) return;
        const next: LoadedDocument = { ...previous, bytes, revision, size: bytes.length, modified: true };
        this.doc = next;
        this.host.written(previous, next);
      });
    this.writing = write;
    write.catch(error => {
      if (store.session === session) this.pending = true;
      this.host.notify(errorMessage(error, 'No se pudieron guardar los cambios de Editar.'), 'error');
    });
    return write;
  }

  /** `next` (a save of `previous`'s bytes) is now the document's file: undoing every later change returns to it. */
  saved(previous: LoadedDocument, next: LoadedDocument) {
    this.renamed = next;
    if (this.start === previous) this.start = next;
    if (this.doc !== previous) return;
    this.doc = next;
    if (this.base?.bytes) this.base.modified = this.base.revision !== next.revision;
    if (!this.pending) {
      this.origin = next;
      this.depth = 0;
    }
  }

  /** Undoes or redoes one change in the live document. */
  step(direction: 'undo' | 'redo') {
    this.host.historyChanged();
    const { store } = this.host,
      session = store.session;
    if (!session) return;
    this.depth += direction === 'undo' ? -1 : 1;
    void session[direction]().then(
      page => {
        if (!page) return;
        store.changed(page);
        this.scheduleWrite();
        // Outside Editar the reader opens the result at once.
        if (!this.host.editing()) void this.park();
      },
      error =>
        this.host.notify(
          errorMessage(
            error,
            direction === 'undo' ? 'No se pudo deshacer el cambio.' : 'No se pudo rehacer el cambio.',
          ),
          'error',
        ),
    );
  }

  /** Keeps the live document open outside Editar: writes it, and the reader
   * opens what was written and draws its pages again. */
  park(): Promise<void> {
    return (this.parking ??= (async () => {
      try {
        await this.write().catch(() => {});
        const current = this.doc;
        if (!current || current === this.start || this.host.current() !== current) return;
        this.rebinding = true;
        try {
          await this.host.reopen(current);
        } finally {
          this.rebinding = false;
        }
        const shown = this.host.current(),
          { store } = this.host;
        if (store.session && shown && shown !== current && shown.id === current.id) {
          store.rebind(shown.pdf);
          this.start = this.doc = shown;
        }
      } finally {
        this.parking = null;
      }
    })());
  }

  /** Closes the live document: writes it, folds its steps into one return to
   * the PDF before Editar, and has the reader open what was written. */
  close(): Promise<void> {
    const { store } = this.host;
    if (!store.session) return Promise.resolve();
    if (this.parking) return this.parking.then(() => this.close());
    return (this.closing ??= (async () => {
      try {
        await this.write().catch(() => {});
        const current = this.doc,
          base = this.base;
        const [undo, redo] = this.host.stacks(current);
        for (const [stack, keepBase] of [
          [undo, true],
          [redo, false],
        ] as const) {
          stack.splice(
            0,
            stack.length,
            ...stack.flatMap(entry =>
              !entry.session
                ? [entry]
                : keepBase && entry.base && base
                  ? [{ ...base, annotations: entry.annotations }]
                  : [],
            ),
          );
          this.host.trim(stack);
        }
        this.host.historyChanged();
        if (!current || current === this.start) return;
        if (this.host.current() === current) await this.host.reopen(current);
        else this.host.outdated(current);
      } finally {
        store.close();
        store.set({ live: null });
        this.closing = null;
        // Editar may be open on another copy or document by now: it gets its own live document.
        const shown = this.host.current();
        if (this.host.editing() && this.editable(shown)) this.open(shown!);
      }
    })());
  }
}

/** Editar's lifecycle around the document in front: each document starts Editar afresh;
 * on desktop its document stays live (LiveEdit) while Editar is open; leaving Editar drops
 * the selection and any pending image; while it is open, pasted images are placed. */
export function useLiveEditing(
  editing: boolean,
  doc: LoadedDocument | null,
  touch: boolean,
  store: EditStore,
  live: LiveEdit,
  notify: Notify,
) {
  useEffect(() => {
    if (doc && live.renamed === doc) return;
    store.reset();
  }, [doc?.id, store]);
  useEffect(() => {
    live.sync(editing, doc);
  }, [editing, doc, touch, live]);
  useEffect(() => {
    if (!editing) {
      flushNudge(store);
      store.set({ selection: null, draft: null, ghost: null, tool: 'select', image: null, notice: '', reselect: null });
    }
  }, [editing, store]);
  usePastedImages(editing, store, message => notify(message, 'error'));
}
