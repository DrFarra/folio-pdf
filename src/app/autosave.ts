import { useEffect, useRef } from 'react';
import { errorMessage } from '../errors';
import { isNativePdfDocument } from '../nativePdf';
import { saveSession } from '../storage';
import type { Annotation, BookmarkNode, LoadedDocument } from '../types';
import { here, saveAdvice } from './model';
import type { Notify } from './notices';
import type { Persistence } from './persistence';
import { useLatest } from './latest';

type Autosave = {
  persistence: Persistence;
  /** The document still in front (a later revision or another document makes a result stale). */
  shown: (doc: LoadedDocument) => boolean;
  /** Removed from the library: nothing is written for it. */
  forgotten: (id: string) => boolean;
  /** Its stored session could not be read: it is kept until the user changes something. */
  unread: (id: string) => boolean;
  /** Whether the latest draft and session writes succeeded. */
  draftStored: (stored: boolean) => void;
  sessionStored: (stored: boolean) => void;
  notify: Notify;
};

/** Keeps the document in front stored while it is read and changed: each modified revision
 * as a draft, and the session (annotations, bookmarks, page) shortly after it changes; while
 * scrolling only the page changes, so that waits for reading to settle. */
export function useAutosave(
  doc: LoadedDocument | null,
  annotations: Annotation[],
  bookmarks: BookmarkNode[],
  page: number,
  options: Autosave,
) {
  const live = useLatest(options);
  const saved = useRef<{ doc: LoadedDocument; annotations: Annotation[]; bookmarks: BookmarkNode[] } | null>(null);
  const previous = useRef<LoadedDocument | null>(null);
  useEffect(() => {
    const { persistence, shown, forgotten, draftStored, notify } = live.current;
    const before = previous.current;
    previous.current = doc;
    // Every change undone: its draft would bring them back when the file is opened again.
    if (doc && !doc.modified && !doc.draftSource && before?.id === doc.id && before.modified)
      void persistence.discard(doc.id).catch(() => {});
    if (!doc?.modified || isNativePdfDocument(doc.pdf) || forgotten(doc.id)) return;
    void persistence
      .draft(doc)
      .then(() => {
        if (shown(doc)) draftStored(true);
      })
      .catch(error => {
        if (!shown(doc)) return;
        // Saving a PDF over the size limit would fail too, so its message replaces the advice.
        const message = errorMessage(error, '');
        draftStored(false);
        notify(
          /supera 1 GB/.test(message) ? message : `No se pudieron guardar tus cambios en ${here}. ${saveAdvice}`,
          'error',
        );
      });
  }, [doc]);
  useEffect(() => {
    const skipped = (id: string) => live.current.forgotten(id) || live.current.unread(id);
    if (!doc || skipped(doc.id)) return;
    // Closing and backgrounding persist the session immediately.
    const previous = saved.current,
      pageOnly = previous?.doc === doc && previous.annotations === annotations && previous.bookmarks === bookmarks;
    const timeout = setTimeout(
      () => {
        const { shown, sessionStored } = live.current;
        if (skipped(doc.id)) return;
        saved.current = { doc, annotations, bookmarks };
        void saveSession(doc.id, {
          annotations,
          bookmarks,
          lastPage: page,
          documentRevision: doc.revision,
          nativeKnownPages: doc.nativeKnownPages,
          nativeOriginalRefs: doc.nativeOriginalRefs,
          nativeSavedAnnotations: doc.savedAnnotations,
          nativeLegacySession: doc.nativeLegacySession,
        }).then(success => {
          if (shown(doc)) sessionStored(success);
        });
      },
      pageOnly ? 1500 : 200,
    );
    return () => clearTimeout(timeout);
  }, [doc, annotations, bookmarks, page]);
}
