import { useCallback, useRef, useState } from 'react';
import type { Annotation, BookmarkNode } from '../types';
import { addPageBookmark, deleteBookmark, hasBookmarkPage } from '../bookmarks';
import { addHighlights } from '../highlight-merge';
import type { AnnotationDraft } from '../text-selection';
import { uid, type History, type NoteDraft } from './model';

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

/** Adds what the user marked, as new annotations; highlights over one of the same colour join it. */
export const withAdded = (list: Annotation[], drafts: AnnotationDraft[]) => addHighlights(list, drafts.map(draft => ({ ...draft, id: uid(), created: Date.now() })));
export const without = (list: Annotation[], id: string) => list.filter(annotation => annotation.id !== id);
export const patched = (list: Annotation[], id: string, patch: Partial<Pick<Annotation, 'color' | 'text' | 'rect'>>) => list.map(item => item.id === id ? { ...item, ...patch } : item);

/** A note written in the note card: a new one added, or an existing one replaced. */
export function withNote(list: Annotation[], draft: NoteDraft, text: string) {
  const note = { ...draft, id: draft.id || uid(), text: text.trim(), created: Date.now() } as Annotation;
  return { list: draft.id ? list.map(item => item.id === note.id ? note : item) : [...list, note], note };
}

/** Where a highlight's comment goes: in the right margin of its page (`pageBox`, the page's
 * PDF box when known), level with the top of the highlight, so it does not cover the words. */
export function commentFor(highlight: Annotation, pageBox?: number[]): NoteDraft {
  const x = pageBox ? pageBox[2] - 24 : highlight.rect[2], y = Math.max(highlight.rect[1], highlight.rect[3]);
  return { page: highlight.page, kind: 'note', rect: [x, y, x, y], text: '', color: highlight.color };
}

/** The bookmark button: adds a bookmark for the page, or on touch (`toggle`) removes the page's
 * bookmarks when it has some. `added` is the new bookmark's id. */
export function toggledBookmark(bookmarks: BookmarkNode[], page: number, toggle: boolean): { bookmarks: BookmarkNode[]; added?: string } {
  if (toggle && hasBookmarkPage(bookmarks, page)) return { bookmarks: bookmarks.filter(node => node.page === page).reduce((nodes, node) => deleteBookmark(nodes, node.id), bookmarks) };
  const next = addPageBookmark(bookmarks, page);
  return { bookmarks: next.bookmarks, added: next.id };
}
