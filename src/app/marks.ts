import { useCallback, useRef, useState } from 'react';
import type { Annotation, BookmarkNode } from '../types';
import type { History } from './model';

/** The document's annotations and bookmarks: what is shown, and the latest value (refs) for
 * code that runs between renders. `commit…` changes them as a user's edit, with an undo step
 * (one per `gesture`); `show…` replaces them without one (a tab switch, an undo). */
export function useMarks(record: (step: History, gesture?: string) => void, edited: () => void) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkNode[]>([]);
  const annotationRef = useRef<Annotation[]>([]), bookmarkRef = useRef<BookmarkNode[]>([]);
  const live = useRef({ record, edited }); live.current = { record, edited };
  const showAnnotations = useCallback((next: Annotation[]) => { annotationRef.current = next; setAnnotations(next); }, []);
  const showBookmarks = useCallback((next: BookmarkNode[]) => { bookmarkRef.current = next; setBookmarks(next); }, []);
  const commitAnnotations = useCallback((next: Annotation[], gesture?: string) => {
    live.current.record({ annotations: annotationRef.current }, gesture); live.current.edited();
    showAnnotations(next);
  }, [showAnnotations]);
  const commitBookmarks = useCallback((next: BookmarkNode[], gesture?: string) => {
    if (JSON.stringify(next) === JSON.stringify(bookmarkRef.current)) return;
    live.current.record({ annotations: annotationRef.current, bookmarks: bookmarkRef.current }, gesture); live.current.edited();
    showBookmarks(next);
  }, [showBookmarks]);
  return { annotations, annotationRef, showAnnotations, commitAnnotations, bookmarks, bookmarkRef, showBookmarks, commitBookmarks };
}
