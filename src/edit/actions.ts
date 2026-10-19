import type { Operation, PageContentItem } from '../engine/operations.ts';
import type { Annotation } from '../types';
import type { Colors, ContentKind, EditStore, Rect, Selection, TextDraft, TextStyle } from './store';
import { fontFields, originalCovers, parseFontName } from './fonts';

// Every change made in Editar goes through here: content edits are written to
// the PDF (one undo step each), shapes change Folio's annotations at once.

// After a commit the page selects whatever now covers this rect.
const reselectAt = (store: EditStore, page: number, kind: ContentKind, rect: Rect) => ({
  page,
  kind,
  rect,
  from: store.doc ? store.key(store.doc, page) : '',
});
export const shift = (rect: Rect, dx: number, dy: number): Rect => [
  rect[0] + dx,
  rect[1] + dy,
  rect[2] + dx,
  rect[3] + dy,
];
const round = (value: number) => Math.round(value * 10) / 10;
export const defaultStyle: TextStyle = {
  family: 'helvetica',
  bold: false,
  italic: false,
  size: 12,
  color: '#202020',
  align: 'left',
  lineHeight: 1.25,
};

export function styleFrom(item: PageContentItem, align: TextStyle['align'] = 'left'): TextStyle {
  const parsed = parseFontName(item.fontName || 'Helvetica');
  return {
    family: 'original',
    bold: parsed.bold,
    italic: parsed.italic,
    size: round(item.size ?? 12),
    color: item.color || '#202020',
    align,
    lineHeight: Math.max(0.8, Math.min(3, Math.round((item.lineHeight ?? 1.2) * 100) / 100)),
  };
}

/** A paragraph's text with its soft line breaks joined, and its alignment, from its lines. */
export function paragraphText(
  item: PageContentItem,
  items: PageContentItem[],
): { text: string; align: TextStyle['align'] } {
  const text = item.text ?? '';
  if (item.level !== 'paragraph') return { text, align: 'left' };
  const block = item.id.replace('text-paragraph-', ''),
    index = (id: string) => Number(id.split('-l')[1]);
  const lines = items
    .filter(other => other.level === 'line' && other.id.startsWith(`text-line-${block}-`))
    .sort((a, b) => index(a.id) - index(b.id));
  if (lines.length < 2) return { text, align: 'left' };
  const width = item.rect[2] - item.rect[0],
    tolerance = Math.max(1.5, (item.size ?? 12) * 0.25);
  let joined = '';
  lines.forEach((line, i) => {
    let value = line.text ?? '';
    const next = lines[i + 1];
    if (!next) {
      joined += value;
      return;
    }
    // A line that reaches the paragraph's width wrapped by itself; a short one ended there.
    const full = line.rect[2] - line.rect[0] >= width * 0.85;
    if (full && /\p{L}-$/u.test(value) && /^\p{Ll}/u.test(next.text ?? '')) value = value.slice(0, -1);
    else if (full) value = value.replace(/\s*$/, ' ');
    joined += value + (full ? '' : '\n');
  });
  const body = lines.slice(0, -1),
    spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  const lefts = body.map(line => line.rect[0]),
    rights = body.map(line => line.rect[2]),
    centers = lines.map(line => (line.rect[0] + line.rect[2]) / 2);
  const align =
    spread(lefts) <= tolerance
      ? 'left'
      : spread(rights) <= tolerance
        ? 'right'
        : spread(centers) <= tolerance
          ? 'center'
          : 'left';
  return { text: joined, align };
}

/** The selected items: one, or a group on one page. */
export const groupItems = (selection: Selection | null) =>
  selection && selection.kind !== 'shape' ? [selection.item, ...(selection.others ?? [])] : [];
export const selectItems = (page: number, items: PageContentItem[]): Selection | null =>
  items.length
    ? { kind: items[0].kind, page, item: items[0], ...(items.length > 1 ? { others: items.slice(1) } : {}) }
    : null;

async function run(store: EditStore, operation: Operation | Operation[], retry?: Operation): Promise<boolean> {
  const actions = store.actions!;
  store.set({ committing: true });
  try {
    let error = await actions.commit(operation);
    if (error && retry) error = await actions.commit(retry);
    if (error) {
      actions.notify(error, 'error');
      store.set({ ghost: null, reselect: null, draft: null });
      return false;
    }
    return true;
  } finally {
    store.set({ committing: false });
  }
}

/** Write the text being typed. `rect` is where it was shown; `room` the most it may take. */
export async function commitDraft(store: EditStore, rect: Rect, room: Rect) {
  const draft = store.state.draft;
  if (!draft) return;
  const text = draft.text.replace(/\s+$/u, ''),
    source = draft.source,
    style = draft.style;
  const unchanged =
    source &&
    draft.original &&
    draft.original.text.replace(/\s+$/u, '') === text &&
    JSON.stringify(draft.original.style) === JSON.stringify(style) &&
    Math.abs(rect[0] - draft.rect[0]) < 0.5 &&
    Math.abs(rect[2] - draft.rect[2]) < 0.5 &&
    Math.abs(rect[3] - draft.rect[3]) < 0.5;
  const done = unchanged || !text.trim();
  store.set({ draft: done ? null : { ...draft, written: true }, notice: '' });
  if (unchanged || (!source && !text.trim())) return;
  if (source && !text.trim()) {
    await removeItem(store, draft.page, 'text', source);
    return;
  }
  const parsed = source && parseFontName(source.fontName || '');
  const original =
    source &&
    style.family === 'original' &&
    parsed &&
    parsed.bold === style.bold &&
    parsed.italic === style.italic &&
    originalCovers(text, source.fontGlyphs);
  const fallback = await fontFields(style, source?.fontName).catch(() => ({
    fields: { fontName: 'Helvetica' as const },
    label: 'Helvetica',
  }));
  const base = {
    page: draft.page,
    text,
    size: style.size,
    color: style.color,
    align: style.align,
    lineHeight: style.lineHeight,
    wrap: true,
  };
  const make = (fields: object, area: Rect): Operation =>
    (source
      ? {
          operation: 'replace-text',
          ...base,
          ...fields,
          rect: area,
          sourceId: source.id,
          sourceRect: source.rect,
          ...(source.baselineOffset !== undefined
            ? { baselineOffset: (source.baselineOffset * style.size) / (source.size || style.size) }
            : {}),
        }
      : { operation: 'add-text', ...base, ...fields, rect: area }) as Operation;
  store.set({ selection: null, reselect: reselectAt(store, draft.page, 'text', rect) });
  // The shown box first; if the engine finds it short, all the room down the page.
  const first = make(original ? { originalFont: true } : fallback.fields, rect);
  const ok = await run(store, first, original ? make(fallback.fields, room) : make(fallback.fields, room));
  if (ok && source && style.family === 'original' && !original)
    store.actions!.notify(`Se usó ${fallback.label}: la fuente del PDF no incluye todas esas letras.`);
}

async function removeItem(store: EditStore, page: number, kind: ContentKind, item: PageContentItem) {
  // Nothing is selected afterwards; the reselect only keeps the mask until the page is redrawn.
  store.set({
    selection: null,
    ghost: { page, kind, item, rect: item.rect, removed: true },
    reselect: reselectAt(store, page, kind, [0, 0, 0, 0]),
  });
  await run(
    store,
    kind === 'graphic'
      ? { operation: 'remove-graphic', page, sourceId: item.id, sourceRect: item.rect, rect: item.rect }
      : { operation: 'remove-content', page, id: item.id, kind, rect: item.rect },
  );
}

export async function deleteSelection(store: EditStore) {
  const selection = store.state.selection;
  if (!selection || store.state.committing) return;
  if (selection.kind === 'shape') {
    store.actions!.removeShape(selection.id);
    store.set({ selection: null });
    return;
  }
  if (!selection.others?.length) {
    await removeItem(store, selection.page, selection.kind, selection.item);
    return;
  }
  const { page, kind, item } = selection,
    others = selection.others;
  store.set({
    selection: null,
    ghost: {
      page,
      kind,
      item,
      rect: item.rect,
      removed: true,
      others: others.map(other => ({ item: other, rect: other.rect })),
    },
    reselect: reselectAt(store, page, kind, [0, 0, 0, 0]),
  });
  await run(
    store,
    [item, ...others].map(each =>
      each.kind === 'graphic'
        ? ({
            operation: 'remove-graphic',
            page,
            sourceId: each.id,
            sourceRect: each.rect,
            rect: each.rect,
          } as Operation)
        : { operation: 'remove-content', page, id: each.id, kind: each.kind as 'text' | 'image', rect: each.rect },
    ),
  );
}

const moveOperation = (page: number, item: PageContentItem, rect: Rect, copy?: boolean): Operation =>
  item.kind === 'image'
    ? { operation: 'move-image', page, sourceId: item.id, sourceRect: item.rect, rect, copy }
    : {
        operation: item.kind === 'text' ? 'move-text' : 'move-graphic',
        page,
        sourceId: item.id,
        sourceRect: item.rect,
        rect,
        copy,
      };

/** Move (or copy) several items of one page, the first being the one in front, as one change. */
export async function moveItems(
  store: EditStore,
  page: number,
  moves: { item: PageContentItem; rect: Rect }[],
  copy?: boolean,
) {
  if (!moves.length || store.state.committing) return;
  const [first, ...others] = moves,
    still = (move: typeof first) => move.rect.every((value, i) => Math.abs(value - move.item.rect[i]) < 0.01);
  const operations = moves
    .filter(move => copy || !still(move))
    .map(move => moveOperation(page, move.item, move.rect, copy));
  if (!operations.length) return;
  store.set({
    ghost: { page, kind: first.item.kind, item: first.item, rect: first.rect, copy, others },
    reselect: {
      ...reselectAt(store, page, first.item.kind, first.rect),
      others: others.map(move => ({ kind: move.item.kind, rect: move.rect })),
    },
  });
  await run(store, operations);
}

/** Shift the selected group (in PDF units). */
export function moveGroup(store: EditStore, dx: number, dy: number, copy?: boolean) {
  const selection = store.state.selection;
  if (!selection || selection.kind === 'shape') return;
  return moveItems(
    store,
    selection.page,
    groupItems(selection).map(item => ({ item, rect: shift(item.rect, dx, dy) })),
    copy,
  );
}

/** Line the selected items up with the edge or centre of the box around them all. */
export function alignSelection(store: EditStore, edge: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') {
  const selection = store.state.selection;
  if (!selection || selection.kind === 'shape' || !selection.others?.length) return;
  const group = groupItems(selection),
    x0 = Math.min(...group.map(item => item.rect[0])),
    x1 = Math.max(...group.map(item => item.rect[2])),
    y0 = Math.min(...group.map(item => item.rect[1])),
    y1 = Math.max(...group.map(item => item.rect[3]));
  void moveItems(
    store,
    selection.page,
    group.map(item => {
      const [a, b, c, d] = item.rect,
        w = c - a,
        h = d - b;
      const x = edge === 'left' ? x0 : edge === 'right' ? x1 - w : edge === 'center' ? (x0 + x1 - w) / 2 : a;
      const y = edge === 'bottom' ? y0 : edge === 'top' ? y1 - h : edge === 'middle' ? (y0 + y1 - h) / 2 : b;
      return { item, rect: [x, y, x + w, y + h] as Rect };
    }),
  );
}

/** Move (or copy) the selected text or image to `rect`, keeping it exactly as it is. A group moves along. */
export async function moveSelection(
  store: EditStore,
  rect: Rect,
  options: { copy?: boolean; rotation?: 0 | 90 | 180 | 270; opacity?: number } = {},
) {
  const selection = store.state.selection;
  if (!selection || selection.kind === 'shape' || store.state.committing) return;
  const { page, kind, item } = selection;
  if (selection.others?.length) return moveGroup(store, rect[0] - item.rect[0], rect[1] - item.rect[1], options.copy);
  store.set({
    ghost: { page, kind, item, rect, copy: options.copy, rotation: options.rotation, opacity: options.opacity },
    reselect: reselectAt(store, page, kind, rect),
  });
  await run(
    store,
    kind !== 'image'
      ? {
          operation: kind === 'text' ? 'move-text' : 'move-graphic',
          page,
          sourceId: item.id,
          sourceRect: item.rect,
          rect,
          copy: options.copy,
        }
      : {
          operation: 'move-image',
          page,
          sourceId: item.id,
          sourceRect: item.rect,
          rect,
          copy: options.copy,
          rotation: options.rotation,
          opacity: options.opacity,
        },
  );
}

const shapeMove = (shape: Annotation, dx: number, dy: number): Partial<Annotation> => ({
  rect: shift(shape.rect, dx, dy),
  ...(shape.line
    ? { line: [shape.line[0] + dx, shape.line[1] + dy, shape.line[2] + dx, shape.line[3] + dy] as Annotation['line'] }
    : {}),
});

export function duplicateSelection(store: EditStore) {
  const selection = store.state.selection;
  if (!selection) return;
  if (selection.kind === 'shape') {
    const shape = store.actions!.shapes().find(item => item.id === selection.id);
    if (!shape) return;
    const { id: _id, created: _created, text: _text, ...rest } = shape;
    const id = store.actions!.addShape({ ...rest, ...shapeMove(shape, 12, -12) });
    if (id) store.set({ selection: { kind: 'shape', page: shape.page, id } });
    return;
  }
  void moveSelection(store, shift(selection.item.rect, 12, -12), { copy: true });
}

// Arrow-key nudges of text or images (or a group) are written together once the keys pause.
let nudge: { timer: ReturnType<typeof setTimeout>; dx: number; dy: number } | null = null;
export function nudgeSelection(store: EditStore, dx: number, dy: number) {
  const selection = store.state.selection;
  if (!selection || store.state.committing) return;
  if (selection.kind === 'shape') {
    const shape = store.actions!.shapes().find(item => item.id === selection.id);
    if (shape) store.actions!.updateShape(shape.id, shapeMove(shape, dx, dy));
    return;
  }
  const x = (nudge?.dx ?? 0) + dx,
    y = (nudge?.dy ?? 0) + dy,
    rect = shift(selection.item.rect, x, y);
  if (nudge) clearTimeout(nudge.timer);
  store.set({
    ghost: {
      page: selection.page,
      kind: selection.kind,
      item: selection.item,
      rect,
      others: selection.others?.map(item => ({ item, rect: shift(item.rect, x, y) })),
    },
  });
  nudge = {
    dx: x,
    dy: y,
    timer: setTimeout(() => {
      nudge = null;
      void moveSelection(store, rect);
    }, 400),
  };
}

// Colour picks arrive while the picker is dragged: each shows at once, drawn by
// the live document without changing it, and the last is written once they pause.
let recolor: {
  timer: ReturnType<typeof setTimeout>;
  colors: Colors;
  selection: { page: number; item: PageContentItem };
} | null = null;
export function recolorSelection(store: EditStore, colors: Colors) {
  const current = store.state.selection;
  if (current?.kind !== 'graphic' && !recolor) return;
  if (recolor) clearTimeout(recolor.timer);
  const selection = recolor?.selection ?? (current as { page: number; item: PageContentItem }),
    next = { ...recolor?.colors, ...colors },
    { page, item } = selection;
  store.set({ ghost: { page, kind: 'graphic', item, rect: item.rect, colors: next } });
  recolor = {
    colors: next,
    selection,
    timer: setTimeout(() => {
      if (store.state.committing) {
        recolorSelection(store, {});
        return;
      }
      recolor = null;
      store.set({ reselect: reselectAt(store, page, 'graphic', item.rect) });
      void run(store, {
        operation: 'recolor-graphic',
        page,
        sourceId: item.id,
        sourceRect: item.rect,
        rect: item.rect,
        ...next,
      });
    }, 300),
  };
}

/** Turn the selected image a quarter clockwise about its centre. */
export function rotateSelection(store: EditStore) {
  const selection = store.state.selection;
  if (selection?.kind !== 'image') return;
  const [x0, y0, x1, y1] = selection.item.rect,
    cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2,
    w = x1 - x0,
    h = y1 - y0;
  void moveSelection(store, [cx - h / 2, cy - w / 2, cx + h / 2, cy + w / 2], { rotation: 90 });
}

export function fadeSelection(store: EditStore, opacity: number) {
  const selection = store.state.selection;
  if (selection?.kind !== 'image') return;
  void moveSelection(store, selection.item.rect, { opacity: Math.max(0, Math.min(1, opacity)) });
}

export async function replaceImage(store: EditStore, bytes: Uint8Array) {
  const selection = store.state.selection;
  if (selection?.kind !== 'image' || store.state.committing) return;
  const { page, item } = selection;
  store.set({ reselect: reselectAt(store, page, 'image', item.rect) });
  await run(store, {
    operation: 'replace-image',
    page,
    rect: item.rect,
    sourceRect: item.rect,
    image: bytes,
    fit: 'contain',
  });
}

export async function placeImage(store: EditStore, page: number, rect: Rect, bytes: Uint8Array) {
  if (store.state.committing) return;
  store.set({ image: null, tool: 'select', selection: null, reselect: reselectAt(store, page, 'image', rect) });
  await run(store, { operation: 'add-image', page, rect, image: bytes, fit: 'contain' });
}

/** Start typing over a paragraph, keeping its look. */
export function editText(
  store: EditStore,
  page: number,
  item: PageContentItem,
  items: PageContentItem[],
  style?: Partial<TextStyle>,
) {
  const { text, align } = paragraphText(item, items),
    base = styleFrom(item, align);
  const draft: TextDraft = {
    page,
    rect: item.rect,
    text,
    style: { ...base, ...style },
    source: item,
    original: { text, style: base },
  };
  store.set({
    draft,
    selection: null,
    notice: item.mixedStyle
      ? 'Este párrafo mezcla estilos: si lo cambias, quedará con uno solo. Para conservarlos, muévelo sin escribir.'
      : '',
  });
}
