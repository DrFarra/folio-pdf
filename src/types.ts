import type { PDFDocumentProxy } from 'pdfjs-dist';

export type Tool = 'select' | 'highlight' | 'note' | 'draw' | 'eraser' | 'remove-image' | 'redact' | 'crop' | 'create-field';
export type SideTab = 'pages' | 'outline' | 'bookmarks';
export type Annotation = {
  id: string;
  page: number;
  kind: 'highlight' | 'note' | 'ink' | 'shape';
  rect: [number, number, number, number];
  color: string;
  text: string;
  created: number;
  author?: string;
  opacity?: number;
  sourceRef?: number;
  nativeSourceRef?: string;
  originalName?: string;
  quads?: number[][];
  /** PDF coordinates; each path is [x, y, x, y, ...], independent of zoom. */
  inkPaths?: number[][];
  strokeWidth?: number;
  /** Shapes drawn in Editar: border `color`, optional `fill`, and for lines their two ends in PDF coordinates. */
  shape?: 'rect' | 'ellipse' | 'line' | 'arrow';
  fill?: string | null;
  line?: [number, number, number, number];
};
export type BookmarkNode = {
  id: string;
  title: string;
  page: number | null;
  parentId: string | null;
  color: string;
  order: number;
  collapsed?: boolean;
};
export type Session = {
  version?: number;
  documentRevision?: string;
  annotations: Annotation[];
  bookmarks: BookmarkNode[];
  lastPage: number;
  nativeKnownPages?: number[];
  nativeOriginalRefs?: string[];
  nativeSavedAnnotations?: string;
  nativeLegacySession?: boolean;
};
export type LoadedDocument = {
  /** Fingerprint of the annotations inside `bytes`, fixed when the bytes are loaded. */
  bytesAnnotations?: string;
  drive?: import('./drive').DriveBinding;
  pdf: PDFDocumentProxy;
  bytes: Uint8Array;
  id: string;
  name: string;
  size: number;
  sample: boolean;
  password?: string;
  nativeSource?: string;
  nativeKnownPages?: number[];
  nativeOriginalRefs?: string[];
  nativeLegacySession?: boolean;
  canAnnotate: boolean;
  signed: boolean;
  initialPage: number;
  hadAnnotations: boolean;
  canEdit: boolean;
  canAssemble: boolean;
  canFill: boolean;
  canCopy: boolean;
  canPrint: boolean;
  modified: boolean;
  revision: string;
  savedAnnotations: string;
  draftSource: boolean;
};
export type RecentDocument = {
  id: string;
  name: string;
  size: number;
  pages: number;
  openedAt: number;
  data?: Blob;
  nativeSource?: string;
  draft?: boolean;
  hidden?: boolean;
};
/** offset is a UTF-16 position in pageText(), before search normalization. */
export type SearchResult = { page: number; text: string; count: 1; offset: number; index?: number };
export type PDFNavigationTarget = { page: number; left?: number; top?: number } | { url: string };
export type OutlineEntry = { title: string; page: number | null; depth: number };
