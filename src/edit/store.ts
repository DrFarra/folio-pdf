import { useSyncExternalStore } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getPageContent, readPagePlate } from '../engine/client';
import { EditSession } from '../engine/session';
import type { Area, Operation, PageContentInfo, PageContentItem } from '../engine/operations.ts';
import type { Annotation, LoadedDocument } from '../types';

// State of Editar inside the reader, shared by every page's EditLayer and the
// toolbar. Pages subscribe to it directly, so selecting or dragging never
// re-renders the page stack.

export type Rect = Area['rect'];
export type EditTool = 'select' | 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'arrow';
export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow';
export type ContentKind = 'text' | 'image' | 'graphic';
/** `others`: more items of the same page selected with `item`, changed together with it. */
export type Selection =
  | { kind: ContentKind; page: number; item: PageContentItem; others?: PageContentItem[] }
  | { kind: 'shape'; page: number; id: string };
/** `family` is a fonts.ts family value; 'original' keeps the replaced text's font. */
export type TextStyle = {
  family: string;
  bold: boolean;
  italic: boolean;
  size: number;
  color: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
};
/** Text being typed on the page; `source` is the paragraph it replaces. A
 * `written` draft stays on show, read-only, until the page shows the result. */
export type TextDraft = {
  page: number;
  rect: Rect;
  text: string;
  style: TextStyle;
  source?: PageContentItem;
  original?: { text: string; style: TextStyle };
  written?: boolean;
};
export type ShapeStyle = { color: string; fill: string | null; strokeWidth: number; opacity: number };
/** What a page shows while its edit is being written: the content at its new place (a drawing in its new `colors`). */
export type Ghost = {
  page: number;
  kind: ContentKind;
  item: PageContentItem;
  rect: Rect;
  rotation?: number;
  opacity?: number;
  copy?: boolean;
  removed?: boolean;
  colors?: Colors;
  others?: { item: PageContentItem; rect: Rect }[];
};
export type Colors = { fill?: string; stroke?: string };
/** A picture drawn by the live document, as a URL, and the PDF area it covers. */
export type Picture = { url: string; rect: Rect };
export type PendingImage = { bytes: Uint8Array; width: number; height: number; name: string };
/** Editar's live document (`EditSession`): the reader's copy `pdf` it draws
 * over, and how many times each page has changed in it. A changed page is read
 * and drawn from the live document until the reader opens the written result. */
export type Live = { id: number; pdf: PDFDocumentProxy; versions: Record<number, number> };

export type EditState = {
  tool: EditTool;
  selection: Selection | null;
  draft: TextDraft | null;
  ghost: Ghost | null;
  committing: boolean;
  notice: string;
  shapeStyle: ShapeStyle;
  image: PendingImage | null;
  /** After a commit the page selects the item that best covers this rect. */
  reselect: {
    page: number;
    kind: ContentKind;
    rect: Rect;
    from: string;
    others?: { kind: ContentKind; rect: Rect }[];
  } | null;
  live: Live | null;
};

export type EditActions = {
  /** Writes an edit (or several to one page, as one) to the PDF; resolves with an error message, or null. */
  commit: (operation: Operation | Operation[]) => Promise<string | null>;
  shapes: () => Annotation[];
  addShape: (shape: Omit<Annotation, 'id' | 'created' | 'text'>) => string | undefined;
  updateShape: (id: string, patch: Partial<Annotation>) => void;
  removeShape: (id: string) => void;
  notify: (message: string, kind?: 'info' | 'error' | 'success') => void;
};

const initial: EditState = {
  tool: 'select',
  selection: null,
  draft: null,
  ghost: null,
  committing: false,
  notice: '',
  shapeStyle: { color: '#c0392b', fill: null, strokeWidth: 2, opacity: 1 },
  image: null,
  reselect: null,
  live: null,
};

export class EditStore {
  state: EditState = initial;
  doc: LoadedDocument | null = null;
  actions: EditActions | null = null;
  session: EditSession | null = null;
  private lives = 0;
  private listeners = new Set<() => void>();
  private cache = new Map<string, { key: string; request: Promise<PageContentInfo> }>();
  private queue: Promise<unknown> = Promise.resolve();
  private pictures = new Map<string, Promise<Picture | null>>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(patch: Partial<EditState> | ((state: EditState) => Partial<EditState>)) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
    for (const listener of [...this.listeners]) listener();
  }
  // The live document is not closed here: the app writes it out first (LiveEdit.close).
  reset() {
    this.dropPictures();
    this.cache.clear();
    this.state = { ...initial, shapeStyle: this.state.shapeStyle };
    for (const listener of [...this.listeners]) listener();
  }

  /** Opens the live document for `doc`, unless it is open for it already. */
  open(doc: LoadedDocument) {
    if (this.session && !this.session.broken && this.state.live?.pdf === doc.pdf) return this.session;
    this.close();
    this.session = new EditSession(doc.bytes, doc.password);
    this.set({ live: { id: ++this.lives, pdf: doc.pdf, versions: {} } });
    return this.session;
  }
  /** The reader now shows what the live document holds: its pages are drawn by the reader again. */
  rebind(pdf: PDFDocumentProxy) {
    if (this.state.live) this.set({ live: { id: ++this.lives, pdf, versions: {} } });
  }
  /** Closes the live document. Its pages stay drawn until the reader shows another copy. */
  close() {
    this.session?.close();
    this.session = null;
  }
  /** A page changed in the live document: it is read and drawn again. */
  changed(page: number) {
    const live = this.state.live;
    if (!live) return;
    this.set({ live: { ...live, versions: { ...live.versions, [page]: (live.versions[page] ?? 0) + 1 } } });
  }
  private live(doc: LoadedDocument) {
    return this.session && this.state.live?.pdf === doc.pdf ? this.state.live : null;
  }
  /** What a page's items, selection and pixels belong to: a revision, or a state of the live document. */
  key(doc: LoadedDocument, page: number) {
    const live = this.live(doc);
    return live ? `live${live.id}:${live.versions[page] ?? 0}` : doc.revision;
  }
  /** The page as the live document draws it, at this scale and turn. */
  render(page: number, scale: number, rotation: number) {
    return this.session
      ? this.session.render(page, scale, rotation)
      : Promise.reject(new Error('No hay sesión de edición.'));
  }

  /** Editable regions of a page as it is now. Without a live document requests
   * run one at a time: each copies the document into the engine. */
  items(doc: LoadedDocument, page: number): Promise<PageContentInfo> {
    const key = this.key(doc, page),
      slot = `${doc.id}:${page}`,
      cached = this.cache.get(slot);
    if (cached?.key === key) return cached.request;
    const session = this.live(doc) && this.session;
    const request = session
      ? session.content(page)
      : this.queue.catch(() => {}).then(() => getPageContent(doc.bytes, page, doc.password, undefined, true));
    if (!session) this.queue = request;
    // Other documents and older states of this page are not needed again.
    for (const old of [...this.cache.keys()]) if (!old.startsWith(`${doc.id}:`)) this.cache.delete(old);
    this.cache.set(slot, { key, request });
    request.catch(() => {
      if (this.cache.get(slot)?.request === request) this.cache.delete(slot);
    });
    return request;
  }

  /** The page around an item without it, for the item's old place while it moves. */
  plate(doc: LoadedDocument, page: number, item: PageContentItem, scale: number) {
    const session = this.live(doc) && this.session,
      target = { id: item.id, kind: item.kind, rect: item.rect };
    return this.picture(doc, page, `plate:${item.id}:${scale}`, () =>
      session ? session.plate(page, target, scale) : readPagePlate(doc.bytes, page, target, scale, doc.password),
    );
  }
  /** The item alone, to move on screen; only the live document draws it. */
  sprite(doc: LoadedDocument, page: number, item: PageContentItem, scale: number, colors?: Colors) {
    const session = this.live(doc) && this.session;
    return this.picture(doc, page, `sprite:${item.id}:${scale}:${colors?.fill}:${colors?.stroke}`, () =>
      session
        ? session.sprite(page, { id: item.id, kind: item.kind, rect: item.rect }, scale, colors)
        : Promise.resolve(null),
    );
  }
  // Pictures of one state of one page are kept, the latest 40; another page or state drops them.
  private picture(
    doc: LoadedDocument,
    page: number,
    name: string,
    draw: () => Promise<{ png: Uint8Array; rect: Rect } | null>,
  ) {
    const state = `${doc.id}:${this.key(doc, page)}:${page}:`,
      key = state + name;
    let request = this.pictures.get(key);
    if (!request) {
      if (![...this.pictures.keys()].every(old => old.startsWith(state))) this.dropPictures();
      for (const [old, picture] of [...this.pictures].slice(0, Math.max(0, this.pictures.size - 39))) {
        this.pictures.delete(old);
        void picture.then(found => {
          if (found) URL.revokeObjectURL(found.url);
        });
      }
      request = draw()
        .then(
          found =>
            found && {
              url: URL.createObjectURL(new Blob([found.png as Uint8Array<ArrayBuffer>], { type: 'image/png' })),
              rect: found.rect,
            },
        )
        .catch(() => null);
      this.pictures.set(key, request);
    }
    return request;
  }
  private dropPictures() {
    for (const request of this.pictures.values())
      void request.then(picture => {
        if (picture) URL.revokeObjectURL(picture.url);
      });
    this.pictures.clear();
  }
}

export function useEdit<T>(store: EditStore, select: (state: EditState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.state));
}

const unsubscribed = () => () => {};
/** How many times this page changed in the live document drawn over `pdf`; 0 draws it from `pdf`. */
export function useLiveVersion(store: EditStore | undefined, pdf: PDFDocumentProxy, page: number) {
  return useSyncExternalStore(store?.subscribe ?? unsubscribed, () => {
    const live = store?.state.live;
    return live?.pdf === pdf ? (live.versions[page] ?? 0) : 0;
  });
}
