import type { Area } from '../engine/operations.ts';
import type { DriveBinding } from '../drive';
import { isAndroid, isDesktop, isIOS, isMac, isNative, shortcutLabel } from '../platform';
import type { Annotation, BookmarkNode, LoadedDocument, OutlineEntry, SideTab, Tool } from '../types';

export const SAMPLE_NAME = 'Guía de Folio.pdf';
export const DEFAULT_HIGHLIGHT_COLOR = '#f5d164';
// Small print stays readable: the visible part of the page is repainted at screen density.
export const MAX_ZOOM = 8;
// A live document is kept after leaving Editar up to this size (one more copy of it stays in memory).
export const PARK_LIMIT = 512 * 1024 * 1024;

// Windows, macOS and Android save over the opened file; iOS saves copies through its sheets and the web downloads.
export const savesInPlace = isNative && (isAndroid || isDesktop);
export const fileSaveLabel = savesInPlace ? 'Guardar' : isNative ? 'Guardar una copia' : 'Descargar';
// Where unsaved changes are kept, and how to keep them in a PDF when that fails.
export const here = isDesktop ? 'este equipo' : isNative ? 'este dispositivo' : 'este navegador';
export const saveAdvice = savesInPlace
  ? 'Guarda el PDF para no perderlos.'
  : isNative
    ? 'Guarda una copia del PDF para no perderlos.'
    : 'Descarga el PDF para no perderlos.';
export const redoShortcut = isMac || isIOS ? shortcutLabel('Z', true) : shortcutLabel('Y');

// Annotation arrays are replaced, never mutated, so one serialization per array
// serves every render, tab badge and save check.
const fingerprints = new WeakMap<Annotation[], string>();
export const annotationFingerprint = (items: Annotation[]) => {
  let fingerprint = fingerprints.get(items);
  if (fingerprint === undefined)
    fingerprints.set(
      items,
      (fingerprint = JSON.stringify(
        items.map(a => [
          a.id,
          a.page,
          a.kind,
          a.rect,
          a.text,
          a.color,
          a.quads,
          a.inkPaths,
          a.strokeWidth,
          a.opacity,
          a.shape,
          a.fill,
          a.line,
        ]),
      )),
    );
  return fingerprint;
};
export const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const searchTerm = (value: string) => (value.trim().length >= 2 ? value : '');
// Saving a copy of a copy keeps a single suffix.
export const copyName = (name: string) => `${name.replace(/\.pdf$/i, '').replace(/( — copia)+$/, '')} — copia.pdf`;

export type ToastKind = 'success' | 'info' | 'error';
export type NoteDraft = Omit<Annotation, 'id' | 'created'> & { id?: string };
export type OpenContext = {
  drive?: DriveBinding;
  savedCopy?: boolean;
  keepEditing?: boolean;
  draftSource?: boolean;
  id?: string;
  password?: string;
  modified?: boolean;
  /** The bytes' revision, when it is already known (Editar computed it while writing them). */
  revision?: string;
  useSession?: boolean;
  preserveHistory?: boolean;
  page?: number;
  bookmarks?: BookmarkNode[];
  quiet?: boolean;
};
/** `session`: a change in Editar's live document, undone there; `base` marks the
 * first one, which becomes a return to the PDF before Editar once it closes. */
export type History = {
  annotations: Annotation[];
  bytes?: Uint8Array;
  password?: string;
  /** Whether `bytes` differ from the document's file, and their revision. */
  modified?: boolean;
  revision?: string;
  page?: number;
  bookmarks?: BookmarkNode[];
  session?: true;
  base?: true;
};
export type TabView = {
  page: number;
  dimensions: { width: number; height: number; rotation: number };
  zoomMode: string;
  customScale: number;
  rotation: number;
  readingMode: 'continuous' | 'single' | 'spread';
  annotating: boolean;
  tool: Tool;
  color: string;
  sidebar: boolean;
  sideTab: SideTab;
  notesOpen: boolean;
  outline: OutlineEntry[] | null;
  textIndex: string[];
  indexing: boolean;
  searchOpen: boolean;
  query: string;
  resultIndex: number;
  activeNote: string | null;
  redactions: Area[];
  editArea: Area | null;
  sessionFailed: boolean;
  draftFailed: boolean;
};
export type DocumentTab = TabView & {
  key: string;
  doc: LoadedDocument;
  annotations: Annotation[];
  bookmarks: BookmarkNode[];
  undo: History[];
  redo: History[];
  scrollTop: number;
  scrollLeft: number;
};

/** At most 50 steps, 20 of them PDF snapshots, within `budget` bytes. Trimming
 * starts at the oldest step: earlier steps never outlive a later snapshot. */
export function trimHistory(stack: History[], budget: number) {
  const snapshots = () => stack.filter(item => item.bytes);
  while (
    stack.length > 50 ||
    snapshots().length > 20 ||
    snapshots().reduce((total, item) => total + item.bytes!.length, 0) > budget
  )
    stack.shift();
}
