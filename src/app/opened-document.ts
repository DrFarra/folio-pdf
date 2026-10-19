import { normalizeBookmarks } from '../bookmarks';
import type { DriveBinding } from '../drive';
import { isNative } from '../platform';
import { readSession } from '../storage';
import type { Annotation, BookmarkNode, LoadedDocument, Session, SideTab } from '../types';
import type { ReadDocument } from './document-reader';
import { MAX_ZOOM, annotationFingerprint, type DocumentTab, type History, type TabView } from './model';

type Details = {
  name: string; sample: boolean; drive?: DriveBinding;
  /** The document is a recovered draft or one made in Folio, with no file of its own yet. */
  draftSource?: boolean;
  /** `session` was made for these bytes (an edit reopening them), not read from storage. */
  fresh: boolean;
};

/** The document Folio shows for a PDF it read, and what its stored `session` restores:
 * annotations, bookmarks and the page it was left on. A session written for another
 * revision of the PDF keeps only the PDF's own annotations. */
export function openedDocument(read: ReadDocument, session: Session, { name, sample, drive, draftSource, fresh }: Details): { doc: LoadedDocument; annotations: Annotation[]; bookmarks: BookmarkNode[]; page: number } {
  const { pdf, bytes, id, revision, modified, size, password, nativeSource, inspection, fileBacked } = read;
  const doc: LoadedDocument = { pdf, bytes, id, revision, modified, savedAnnotations: annotationFingerprint(inspection.annotations), bytesAnnotations: annotationFingerprint(inspection.annotations),
    draftSource: draftSource || (!nativeSource && modified && isNative), name, size, sample, password, nativeSource, canAnnotate: inspection.canAnnotate, canEdit: inspection.canEdit,
    canAssemble: inspection.canAssemble, canFill: inspection.canFill, canCopy: inspection.canCopy, canPrint: inspection.canPrint, signed: inspection.signed, initialPage: session.lastPage,
    hadAnnotations: inspection.annotations.length > 0, drive };
  if (drive && !drive.editable) { doc.canAnnotate = false; doc.canEdit = false; doc.canAssemble = false; doc.canFill = false; }
  const matches = session.documentRevision === revision || (!session.documentRevision && !modified) || fresh;
  // PDFKit reads a file-backed PDF's own annotations page by page; the session tracks which.
  doc.nativeKnownPages = fileBacked && matches ? session.nativeKnownPages || [] : [];
  doc.nativeLegacySession = fileBacked && matches && (session.nativeLegacySession || (session.version || 0) >= 2 && !session.nativeKnownPages && !session.nativeOriginalRefs);
  doc.nativeOriginalRefs = fileBacked && matches ? session.nativeOriginalRefs || [] : [];
  if (fileBacked && matches && session.nativeSavedAnnotations) doc.savedAnnotations = session.nativeSavedAnnotations;
  // Version 2 sessions hold every annotation; older ones only those Folio added.
  const restored = !matches ? inspection.annotations : (session.version || 0) >= 2 ? session.annotations : [...inspection.annotations, ...session.annotations.filter(a => !inspection.annotations.some(b => b.id === a.id))];
  return { doc, annotations: restored.filter(a => a.page <= pdf.numPages), bookmarks: normalizeBookmarks(session.bookmarks, pdf.numPages), page: Math.max(1, Math.min(pdf.numPages, session.lastPage)) };
}

/** The session a document opens with: the stored one, or `fresh` (an edit reopening its
 * bytes, with the annotations they hold). `unread` when the stored one could not be read. */
export async function openingSession(id: string, annotations: Annotation[], fresh: { page?: number; bookmarks?: BookmarkNode[] } | null, restorePage: boolean): Promise<{ session: Session; unread: boolean }> {
  if (fresh) return { session: { annotations, bookmarks: fresh.bookmarks || [], lastPage: fresh.page || 1, version: 2 }, unread: false };
  let unread = false;
  const session: Session = await readSession(id).catch(() => { unread = true; return { annotations: [], bookmarks: [], lastPage: 1 }; });
  if (!restorePage) session.lastPage = 1;
  return { session, unread };
}

type TabStart = {
  key: string; doc: LoadedDocument; opened: ReturnType<typeof openedDocument>; dimensions: TabView['dimensions'];
  /** The view in front, and the tab it belonged to, when the document reopens in its own tab (an edit, a save). */
  current: TabView; previous: DocumentTab | null; replacing: boolean;
  undo: History[]; redo: History[];
  preferences: { mode: TabView['readingMode']; defaultZoom: string; panel: SideTab | 'closed' };
};

/** The tab a document opens in. A reopened document keeps its tab's view and history (and
 * the highlighter, if it can still highlight); a new one starts from the preferences. */
export function openedTab({ key, doc, opened, dimensions, current, previous, replacing, undo, redo, preferences: { mode, defaultZoom, panel } }: TabStart): DocumentTab {
  const zoom = Number(defaultZoom);
  return { ...current, key, doc, annotations: opened.annotations, bookmarks: opened.bookmarks, page: opened.page, dimensions,
    undo: replacing ? undo : [], redo: replacing ? redo : [],
    scrollTop: replacing ? previous?.scrollTop || 0 : 0, scrollLeft: replacing ? previous?.scrollLeft || 0 : 0,
    outline: null, textIndex: [], indexing: true, redactions: [], editArea: null, sessionFailed: false, draftFailed: false,
    tool: replacing && previous?.tool === 'highlight' && doc.canAnnotate && doc.canCopy ? 'highlight' : 'select',
    ...(replacing ? {} : { annotating: false, readingMode: mode, rotation: 0, zoomMode: zoom ? 'custom' : defaultZoom, customScale: zoom ? Math.max(.25, Math.min(MAX_ZOOM, zoom / 100)) : 1,
      sidebar: panel !== 'closed', sideTab: panel === 'closed' ? 'pages' : panel, searchOpen: false, query: '', resultIndex: 0, notesOpen: false, activeNote: null }) };
}
