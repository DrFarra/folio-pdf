import { normalizeBookmarks } from '../bookmarks';
import type { DriveBinding } from '../drive';
import { isNative } from '../platform';
import type { Annotation, BookmarkNode, LoadedDocument, Session } from '../types';
import type { ReadDocument } from './document-reader';
import { annotationFingerprint } from './model';

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
