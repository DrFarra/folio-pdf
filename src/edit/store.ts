import { useSyncExternalStore } from 'react';
import { getPageContent } from '../engine/client';
import type { Area, Operation, PageContentInfo, PageContentItem } from '../engine/operations.mjs';
import type { Annotation, LoadedDocument } from '../types';

// State of Editar inside the reader, shared by every page's EditLayer and the
// toolbar. Pages subscribe to it directly, so selecting or dragging never
// re-renders the page stack.

export type Rect = Area['rect'];
export type EditTool = 'select' | 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'arrow';
export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow';
export type Selection = { kind: 'text' | 'image'; page: number; item: PageContentItem } | { kind: 'shape'; page: number; id: string };
/** `family` is a fonts.ts family value; 'original' keeps the replaced text's font. */
export type TextStyle = { family: string; bold: boolean; italic: boolean; size: number; color: string; align: 'left' | 'center' | 'right'; lineHeight: number };
/** Text being typed on the page; `source` is the paragraph it replaces. */
export type TextDraft = { page: number; rect: Rect; text: string; style: TextStyle; source?: PageContentItem; original?: { text: string; style: TextStyle } };
export type ShapeStyle = { color: string; fill: string | null; strokeWidth: number; opacity: number };
/** What a page shows while its edit is being written: the content at its new place. */
export type Ghost = { page: number; kind: 'text' | 'image'; item: PageContentItem; rect: Rect; rotation?: number; opacity?: number; copy?: boolean; removed?: boolean };
export type PendingImage = { bytes: Uint8Array; width: number; height: number; name: string };

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
  reselect: { page: number; kind: 'text' | 'image'; rect: Rect; from: string } | null;
};

export type EditActions = {
  /** Writes an edit to the PDF; resolves with an error message, or null. */
  commit: (operation: Operation) => Promise<string | null>;
  shapes: () => Annotation[];
  addShape: (shape: Omit<Annotation, 'id' | 'created' | 'text'>) => string | undefined;
  updateShape: (id: string, patch: Partial<Annotation>) => void;
  removeShape: (id: string) => void;
  notify: (message: string, kind?: 'info' | 'error' | 'success') => void;
};

const initial: EditState = {
  tool: 'select', selection: null, draft: null, ghost: null, committing: false, notice: '',
  shapeStyle: { color: '#c0392b', fill: null, strokeWidth: 2, opacity: 1 }, image: null, reselect: null,
};

export class EditStore {
  state: EditState = initial;
  doc: LoadedDocument | null = null;
  actions: EditActions | null = null;
  private listeners = new Set<() => void>();
  private cache = new Map<string, Promise<PageContentInfo>>();
  private queue: Promise<unknown> = Promise.resolve();

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(patch: Partial<EditState> | ((state: EditState) => Partial<EditState>)) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
    for (const listener of [...this.listeners]) listener();
  }
  reset() { this.cache.clear(); this.state = { ...initial, shapeStyle: this.state.shapeStyle }; for (const listener of [...this.listeners]) listener(); }

  /** Editable regions of a page of the current revision. Requests run one at a
   * time: each copies the document into the engine. */
  items(doc: LoadedDocument, page: number): Promise<PageContentInfo> {
    const key = `${doc.id}:${doc.revision}:${page}`;
    let request = this.cache.get(key);
    if (!request) {
      request = this.queue.catch(() => {}).then(() => getPageContent(doc.bytes, page, doc.password));
      this.queue = request;
      this.cache.set(key, request);
      request.catch(() => { if (this.cache.get(key) === request) this.cache.delete(key); });
      // Older revisions are not needed again.
      for (const old of [...this.cache.keys()]) if (!old.startsWith(`${doc.id}:${doc.revision}:`)) this.cache.delete(old);
    }
    return request;
  }
}

export function useEdit<T>(store: EditStore, select: (state: EditState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.state));
}
