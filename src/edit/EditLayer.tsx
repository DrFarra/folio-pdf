import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PageViewport, PDFPageProxy } from 'pdfjs-dist';
import type { PageContentItem } from '../engine/operations.mjs';
import type { Annotation, LoadedDocument } from '../types';
import { errorMessage } from '../errors';
import { useEdit, type EditStore, type Rect, type ShapeKind, type TextDraft } from './store';
import { commitDraft, defaultStyle, editText, moveSelection, placeImage } from './actions';
import { parseFontName } from './fonts';
import { ShapeSvg } from './ShapeLayer';
import './edit.css';

type Point = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'start' | 'end';
type Target = { kind: 'text' | 'image'; item: PageContentItem } | { kind: 'shape'; shape: Annotation };
type Gesture =
  | { mode: 'move'; target: Target; start: Point; now: Point; moved: boolean; wasSelected: boolean }
  | { mode: 'resize'; target: Target; handle: Handle; start: Point; now: Point; free: boolean }
  | { mode: 'create'; tool: 'text' | 'image' | ShapeKind; start: Point; now: Point; free: boolean };
type Props = { store: EditStore; doc: LoadedDocument; number: number; viewport: PageViewport; page: PDFPageProxy; canvas: React.RefObject<HTMLCanvasElement | null>; shapes: Annotation[] };

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const area = (box: Box) => box.w * box.h;
const inside = (box: Box, p: Point, pad = 0) => p.x >= box.x - pad && p.x <= box.x + box.w + pad && p.y >= box.y - pad && p.y <= box.y + box.h + pad;
const overlap = (a: Rect, b: Rect) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - w * h;
  return union > 0 ? w * h / union : 0;
};
const segmentDistance = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y, t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};

/** The family the browser shows while typing: the PDF's own font as PDF.js loaded it, or a close one. */
function usePreviewFamily(page: PDFPageProxy, draft: TextDraft | null) {
  const [loaded, setLoaded] = useState<string>();
  const name = draft?.source?.fontName;
  useEffect(() => {
    setLoaded(undefined);
    if (!name) return;
    let alive = true;
    const plain = (value: string) => value.replace(/^[A-Z]{6}\+/, '').toLowerCase();
    void page.getTextContent().then(content => {
      for (const id of Object.keys(content.styles)) {
        try { const font = page.commonObjs.get(id) as { name?: string } | undefined; if (font?.name && plain(font.name) === plain(name)) { if (alive) setLoaded(id); return; } } catch { /* not loaded */ }
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [page, name]);
  if (!draft) return '';
  const { family } = draft.style, kind = name ? parseFontName(name).kind : 'sans';
  const generic = family === 'times' || family === 'original' && kind === 'serif' ? '"Times New Roman", Times, serif' : family === 'courier' || family === 'original' && kind === 'mono' ? '"Courier New", Courier, monospace' : 'Helvetica, Arial, sans-serif';
  if (family === 'original') return loaded ? `"${loaded}", ${generic}` : `"${parseFontName(name || '').family}", ${generic}`;
  if (family === 'dm-sans') return '"DM Sans", sans-serif';
  if (family.startsWith('system:')) return `"${family.slice(7)}", ${generic}`;
  return generic;
}

/** A copy of the page's own pixels, shown where content is going while the PDF is rewritten. */
function Snapshot({ canvas, viewport, from, to, rotation = 0, opacity }: { canvas: HTMLCanvasElement | null; viewport: PageViewport; from: Box; to: Box; rotation?: number; opacity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const turned = rotation === 90 || rotation === 270, w = turned ? to.h : to.w, h = turned ? to.w : to.h;
  useLayoutEffect(() => {
    const node = ref.current; if (!node || !canvas?.width) return;
    const k = canvas.width / viewport.width, dpr = Math.min(window.devicePixelRatio || 1, 2);
    node.width = Math.max(1, Math.round(w * dpr)); node.height = Math.max(1, Math.round(h * dpr));
    node.getContext('2d')?.drawImage(canvas, from.x * k, from.y * k, from.w * k, from.h * k, 0, 0, node.width, node.height);
  }, [canvas, viewport, from.x, from.y, from.w, from.h, w, h]);
  return <canvas ref={ref} className="edit-snapshot" style={{ left: to.x + (to.w - w) / 2, top: to.y + (to.h - h) / 2, width: w, height: h, transform: rotation ? `rotate(${rotation}deg)` : undefined, opacity }} aria-hidden="true" />;
}

/** The colour just outside a box, to cover content that has moved away. */
function background(canvas: HTMLCanvasElement | null, viewport: PageViewport, box: Box) {
  try {
    if (!canvas?.width) return '#fff';
    const k = canvas.width / viewport.width, x = Math.max(0, Math.round((box.x - 3) * k)), y = Math.max(0, Math.round((box.y - 3) * k));
    const [r, g, b] = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  } catch { return '#fff'; }
}

export default function EditLayer({ store, doc, number, viewport, page, canvas, shapes }: Props) {
  const tool = useEdit(store, state => state.tool);
  const selection = useEdit(store, state => state.selection?.page === number ? state.selection : null);
  const draft = useEdit(store, state => state.draft?.page === number ? state.draft : null);
  const ghost = useEdit(store, state => state.ghost?.page === number ? state.ghost : null);
  const reselect = useEdit(store, state => state.reselect?.page === number ? state.reselect : null);
  const committing = useEdit(store, state => state.committing);
  const pendingImage = useEdit(store, state => state.image);
  const shapeStyle = useEdit(store, state => state.shapeStyle);
  const layer = useRef<HTMLDivElement>(null);
  // Items belong to the revision they were read from; a newer one reads them again.
  const [loaded, setLoaded] = useState<{ revision: string; items: PageContentItem[] } | null>(null);
  const items = loaded?.revision === doc.revision ? loaded.items : null;
  const [wanted, setWanted] = useState(false);
  const [hover, setHover] = useState<Target | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const update = (next: Gesture | null) => { gestureRef.current = next; setGesture(next); };

  const toBox = (rect: Rect): Box => {
    const a = viewport.convertToViewportPoint(rect[0], rect[1]), b = viewport.convertToViewportPoint(rect[2], rect[3]);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
  };
  const toRect = (box: Box): Rect => {
    const a = viewport.convertToPdfPoint(box.x, box.y), b = viewport.convertToPdfPoint(box.x + box.w, box.y + box.h);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  };
  const toRectRef = useRef(toRect); toRectRef.current = toRect;
  const toPoint = (x: number, y: number): Point => { const [px, py] = viewport.convertToViewportPoint(x, y); return { x: px, y: py }; };
  const local = (event: { clientX: number; clientY: number }): Point => {
    const box = layer.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(viewport.width, event.clientX - box.left)), y: Math.max(0, Math.min(viewport.height, event.clientY - box.top)) };
  };

  // Content is read for the current revision once the page is used in Editar.
  useEffect(() => { setHover(null); }, [doc.revision]);
  const need = wanted || !!reselect || !!selection;
  useEffect(() => {
    if (!need || items) return;
    let alive = true;
    store.items(doc, number).then(info => { if (alive) setLoaded({ revision: doc.revision, items: info.items }); }).catch(error => { if (alive) store.set({ notice: errorMessage(error, 'No se pudo leer el contenido de esta página.') }); });
    return () => { alive = false; };
  }, [store, doc, number, need, items]);
  // After a commit the moved, written or added content is selected again.
  useEffect(() => {
    if (!reselect || !items || reselect.from === doc.revision) return;
    const best = items.filter(item => item.kind === reselect.kind && (item.kind === 'image' || item.level === 'paragraph'))
      .map(item => ({ item, score: overlap(item.rect, reselect.rect) })).sort((a, b) => b.score - a.score)[0];
    store.set({ reselect: null, ghost: null, selection: best && best.score > .2 ? { kind: reselect.kind, page: number, item: best.item } : null });
  }, [store, items, reselect, number, doc.revision]);
  // A selection from an older revision no longer matches the page.
  const revision = useRef(doc.revision);
  useEffect(() => {
    if (revision.current === doc.revision) return;
    revision.current = doc.revision;
    const state = store.state;
    if (state.selection?.page === number && state.selection.kind !== 'shape' && !state.reselect) store.set({ selection: null });
    if (state.ghost?.page === number && !state.reselect && !state.committing) store.set({ ghost: null });
  }, [store, doc.revision, number]);

  /** A click places an image at its own size, at most half the page, centred on the click. */
  function naturalBox(p: Point, image: { width: number; height: number }): Box {
    const scale = Math.min(1, viewport.width * .5 / image.width, viewport.height * .5 / image.height), w = image.width * scale, h = image.height * scale;
    return { x: Math.max(0, Math.min(viewport.width - w, p.x - w / 2)), y: Math.max(0, Math.min(viewport.height - h, p.y - h / 2)), w, h };
  }
  // An image dropped on this page lands where it was dropped.
  const dropRef = useRef(naturalBox); dropRef.current = naturalBox;
  useEffect(() => {
    const place = (event: Event) => {
      const { image, clientX, clientY } = (event as CustomEvent<{ image: { bytes: Uint8Array; width: number; height: number }; clientX: number; clientY: number }>).detail;
      const box = layer.current?.getBoundingClientRect();
      if (!box || clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return;
      void placeImage(store, number, toRectRef.current(dropRef.current({ x: clientX - box.left, y: clientY - box.top }, image)), image.bytes);
    };
    window.addEventListener('folio:edit-place-image', place);
    return () => window.removeEventListener('folio:edit-place-image', place);
  }, [store, number]);

  function hitTest(p: Point): Target | null {
    for (const shape of [...shapes].reverse()) {
      if (shape.line) { const a = toPoint(shape.line[0], shape.line[1]), b = toPoint(shape.line[2], shape.line[3]); if (segmentDistance(p, a, b) <= Math.max(6, (shape.strokeWidth || 1) * viewport.scale / 2 + 4)) return { kind: 'shape', shape }; }
      else if (inside(toBox(shape.rect), p, 3)) return { kind: 'shape', shape };
    }
    if (!items) return null;
    const texts = items.filter(item => item.kind === 'text' && item.level === 'paragraph' && inside(toBox(item.rect), p, 1)).sort((a, b) => area(toBox(a.rect)) - area(toBox(b.rect)));
    for (const paragraph of texts) {
      if (paragraph.editable) return { kind: 'text', item: paragraph };
      const line = items.find(item => item.kind === 'text' && item.level === 'line' && item.editable && item.id.startsWith(paragraph.id.replace('paragraph', 'line') + '-') && inside(toBox(item.rect), p, 1));
      return { kind: 'text', item: line || paragraph };
    }
    const image = items.filter(item => item.kind === 'image' && inside(toBox(item.rect), p)).sort((a, b) => area(toBox(a.rect)) - area(toBox(b.rect)))[0];
    return image ? { kind: 'image', item: image } : null;
  }
  const same = (a: Target | null, b: Target | null) => !!a && !!b && a.kind === b.kind && (a.kind === 'shape' ? a.shape.id === (b as { shape: Annotation }).shape.id : a.item.id === (b as { item: PageContentItem }).item.id);
  const selected: Target | null = !selection ? null : selection.kind === 'shape' ? (shapes.find(shape => shape.id === selection.id) ? { kind: 'shape', shape: shapes.find(shape => shape.id === selection.id)! } : null) : { kind: selection.kind, item: selection.item };
  const targetBox = (target: Target) => target.kind === 'shape' ? toBox(target.shape.rect) : toBox(target.item.rect);

  /** The box (or line ends) a gesture is showing. */
  function preview(current: Gesture): { box: Box; line?: [Point, Point] } {
    const dx = current.now.x - current.start.x, dy = current.now.y - current.start.y;
    if (current.mode === 'create') {
      const box = { x: Math.min(current.start.x, current.now.x), y: Math.min(current.start.y, current.now.y), w: Math.abs(dx), h: Math.abs(dy) };
      if (current.tool === 'image' && pendingImage && !current.free && box.w > 4) { const ratio = pendingImage.height / pendingImage.width; box.h = box.w * ratio; if (current.now.y < current.start.y) box.y = current.start.y - box.h; }
      return { box, ...(current.tool === 'line' || current.tool === 'arrow' ? { line: [current.start, current.now] as [Point, Point] } : {}) };
    }
    const target = current.target, base = targetBox(target);
    if (current.mode === 'move') {
      // Content stays on its page: beyond the edge it would be cut off.
      const box = { ...base, x: Math.max(Math.min(0, base.x), Math.min(base.x + dx, Math.max(viewport.width, base.x + base.w) - base.w)), y: Math.max(Math.min(0, base.y), Math.min(base.y + dy, Math.max(viewport.height, base.y + base.h) - base.h)) };
      if (target.kind === 'shape' && target.shape.line) { const a = toPoint(target.shape.line[0], target.shape.line[1]), b = toPoint(target.shape.line[2], target.shape.line[3]), mx = box.x - base.x, my = box.y - base.y; return { box, line: [{ x: a.x + mx, y: a.y + my }, { x: b.x + mx, y: b.y + my }] }; }
      return { box };
    }
    if (target.kind === 'shape' && target.shape.line) {
      const a = toPoint(target.shape.line[0], target.shape.line[1]), b = toPoint(target.shape.line[2], target.shape.line[3]);
      const line: [Point, Point] = current.handle === 'start' ? [current.now, b] : [a, current.now];
      return { box: { x: Math.min(line[0].x, line[1].x), y: Math.min(line[0].y, line[1].y), w: Math.abs(line[0].x - line[1].x), h: Math.abs(line[0].y - line[1].y) }, line };
    }
    let { x, y, w, h } = base; const handle = current.handle;
    if (handle.includes('w')) { x += dx; w -= dx; } if (handle.includes('e')) w += dx;
    if (target.kind !== 'text') { if (handle.includes('n')) { y += dy; h -= dy; } if (handle.includes('s')) h += dy; }
    // Images keep their proportions unless Shift is held; corners lead.
    if (target.kind === 'image' && !current.free && handle.length === 2) {
      const ratio = base.h / base.w, height = w * ratio;
      if (handle.includes('n')) y = base.y + base.h - height; h = height;
    }
    w = Math.max(8, w); h = Math.max(8, h);
    return { box: { x, y, w, h } };
  }

  function finish(current: Gesture) {
    const { box, line } = preview(current);
    const pdfLine = line && [...viewport.convertToPdfPoint(line[0].x, line[0].y), ...viewport.convertToPdfPoint(line[1].x, line[1].y)] as Annotation['line'];
    if (current.mode === 'create') {
      const actions = store.actions!;
      if (current.tool === 'text') {
        const scale = viewport.scale, width = Math.max(box.w, 160 * scale), height = defaultStyle.size * scale * defaultStyle.lineHeight * 1.2;
        const top = box.w > 8 ? box.y : current.start.y - height * .6;
        store.set({ selection: null, draft: { page: number, rect: toRect({ x: Math.min(current.start.x, viewport.width - 40), y: Math.max(0, top), w: Math.min(width, viewport.width - Math.min(current.start.x, viewport.width - 40)), h: height }), text: '', style: { ...defaultStyle } } });
        return;
      }
      if (current.tool === 'image') {
        if (!pendingImage) return;
        void placeImage(store, number, toRect(box.w > 8 ? box : naturalBox(current.start, pendingImage)), pendingImage.bytes);
        return;
      }
      const shape = current.tool, click = box.w < 4 && box.h < 4, scale = viewport.scale;
      const shown = click ? { x: current.start.x - 50 * scale, y: current.start.y - 30 * scale, w: 100 * scale, h: 60 * scale } : box;
      const ends = shape === 'line' || shape === 'arrow' ? (click ? [...viewport.convertToPdfPoint(current.start.x - 60 * scale, current.start.y), ...viewport.convertToPdfPoint(current.start.x + 60 * scale, current.start.y)] as Annotation['line'] : pdfLine) : undefined;
      const id = actions.addShape({ page: number, kind: 'shape', shape, rect: ends ? [Math.min(ends[0], ends[2]), Math.min(ends[1], ends[3]), Math.max(ends[0], ends[2]), Math.max(ends[1], ends[3])] : toRect(shown), ...(ends ? { line: ends } : {}),
        color: shapeStyle.color, fill: ends ? null : shapeStyle.fill, strokeWidth: shapeStyle.strokeWidth, opacity: shapeStyle.opacity });
      if (id) store.set({ tool: 'select', selection: { kind: 'shape', page: number, id } });
      return;
    }
    const target = current.target;
    if (current.mode === 'move' && !current.moved) {
      // A second click on selected text starts typing in it.
      if (current.wasSelected && target.kind === 'text' && target.item.editable && items) editText(store, number, target.item, items);
      return;
    }
    if (target.kind === 'shape') {
      const rect = line && pdfLine ? [Math.min(pdfLine[0], pdfLine[2]), Math.min(pdfLine[1], pdfLine[3]), Math.max(pdfLine[0], pdfLine[2]), Math.max(pdfLine[1], pdfLine[3])] as Rect : toRect(box);
      store.actions!.updateShape(target.shape.id, { rect, ...(pdfLine ? { line: pdfLine } : {}) });
      return;
    }
    if (target.kind === 'text' && current.mode === 'resize') {
      // A wider or narrower paragraph is written again, wrapped to its new width.
      if (!items) return;
      editText(store, number, target.item, items);
      const draft = store.state.draft; if (!draft) return;
      const rect = toRect({ ...box, h: viewport.height - box.y });
      store.set({ draft: { ...draft, rect: [rect[0], draft.rect[1], rect[2], draft.rect[3]] } });
      return;
    }
    void moveSelection(store, toRect(box));
  }

  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    if ((event.target as Element).closest('.edit-draft')) return;
    event.preventDefault();
    setWanted(true);
    const p = local(event);
    if (store.state.draft) return;
    if (store.state.committing) return;
    const handle = (event.target as HTMLElement).dataset.handle as Handle | undefined;
    if (handle && selected) { event.currentTarget.setPointerCapture(event.pointerId); update({ mode: 'resize', target: selected, handle, start: p, now: p, free: event.shiftKey }); return; }
    const target = hitTest(p);
    if (tool !== 'select' && !(tool === 'text' && target?.kind === 'text')) {
      if (tool === 'image' && !pendingImage) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      update({ mode: 'create', tool, start: p, now: p, free: event.shiftKey });
      return;
    }
    if (!target) { store.set({ selection: null, notice: '' }); return; }
    if (target.kind !== 'shape' && !target.item.editable) { store.set({ selection: null, notice: target.item.reason || 'Este contenido no se puede editar.' }); return; }
    if (tool === 'text' && target.kind === 'text' && items) { editText(store, number, target.item, items); return; }
    const wasSelected = same(target, selected);
    store.set({ notice: '', selection: target.kind === 'shape' ? { kind: 'shape', page: number, id: target.shape.id } : { kind: target.kind, page: number, item: target.item } });
    event.currentTarget.setPointerCapture(event.pointerId);
    update({ mode: 'move', target, start: p, now: p, moved: false, wasSelected });
  }
  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (!wanted) setWanted(true);
    const p = local(event), current = gestureRef.current;
    if (current) {
      const moved = current.mode !== 'move' || current.moved || Math.hypot(p.x - current.start.x, p.y - current.start.y) > 3;
      update({ ...current, now: p, ...(current.mode === 'move' ? { moved } : {}), ...(current.mode !== 'move' ? { free: event.shiftKey } : {}) } as Gesture);
      return;
    }
    const target = tool === 'select' || tool === 'text' ? hitTest(p) : null;
    if (!same(target, hover) && !(target === null && hover === null)) setHover(target);
  }
  function pointerUp(event: React.PointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    const current = gestureRef.current; if (!current) return;
    update(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    finish({ ...current, now: local(event) } as Gesture);
  }
  function doubleClick(event: React.MouseEvent) {
    event.stopPropagation();
    const target = hitTest(local(event));
    if (target?.kind === 'text' && target.item.editable && items && !store.state.committing) editText(store, number, target.item, items);
  }

  const live = gesture && (gesture.mode !== 'move' || gesture.moved) ? preview(gesture) : null;
  const liveTarget = gesture && gesture.mode !== 'create' ? gesture.target : null;
  // Reading pixels back from the page is slow, so each spot is sampled once per revision.
  const sampled = useRef(new Map<string, string>());
  const pageBackground = (box: Box) => {
    const key = `${doc.revision}:${Math.round(box.x)}:${Math.round(box.y)}`;
    let value = sampled.current.get(key);
    if (!value) { if (sampled.current.size > 50) sampled.current.clear(); value = background(canvas.current, viewport, box); sampled.current.set(key, value); }
    return value;
  };
  const cursor = tool === 'select' ? (gesture?.mode === 'move' && gesture.moved ? 'grabbing' : hover && (hover.kind === 'shape' || hover.item.editable) ? 'move' : 'default') : tool === 'text' ? 'text' : tool === 'image' && !pendingImage ? 'default' : 'crosshair';

  return <div ref={layer} className={`edit-layer${committing ? ' committing' : ''}`} style={{ cursor }} data-edit-page={number} data-edit-state={items ? 'ready' : need ? 'loading' : 'idle'}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => update(null)} onPointerLeave={() => { if (!gestureRef.current) setHover(null); }} onDoubleClick={doubleClick} onClick={event => event.stopPropagation()}>
    {hover && !gesture && !same(hover, selected) && !draft && (() => {
      const box = targetBox(hover), editable = hover.kind === 'shape' || hover.item.editable;
      return <div className={`edit-hover${editable ? '' : ' locked'}`} style={{ left: box.x, top: box.y, width: box.w, height: box.h }} title={editable ? undefined : (hover as { item: PageContentItem }).item.reason} />;
    })()}
    {ghost && (() => {
      const from = toBox(ghost.item.rect), to = toBox(ghost.rect);
      return <>
        {!ghost.copy && <div className="edit-mask" style={{ left: from.x - 1, top: from.y - 1, width: from.w + 2, height: from.h + 2, background: pageBackground(from) }} />}
        {!ghost.removed && <Snapshot canvas={canvas.current} viewport={viewport} from={from} to={to} rotation={ghost.rotation} opacity={ghost.opacity} />}
        <div className="edit-progress" style={{ left: to.x, top: to.y, width: to.w, height: to.h }} />
      </>;
    })()}
    {live && liveTarget && liveTarget.kind !== 'shape' && (() => {
      const from = targetBox(liveTarget);
      return <>
        {liveTarget.kind === 'image' || gesture?.mode === 'move' ? <>
          <div className="edit-mask" style={{ left: from.x - 1, top: from.y - 1, width: from.w + 2, height: from.h + 2, background: pageBackground(from) }} />
          <Snapshot canvas={canvas.current} viewport={viewport} from={from} to={live.box} />
        </> : null}
        <div className="edit-selection dragging" style={{ left: live.box.x, top: live.box.y, width: live.box.w, height: live.box.h }} />
      </>;
    })()}
    {live && (liveTarget?.kind === 'shape' || gesture?.mode === 'create' && gesture.tool !== 'text' && gesture.tool !== 'image') && <ShapeSvg viewport={viewport} className="edit-shape-preview" shapes={[{
      ...(liveTarget?.kind === 'shape' ? liveTarget.shape : { id: 'preview', page: number, kind: 'shape', shape: (gesture as { tool: ShapeKind }).tool, color: shapeStyle.color, fill: shapeStyle.fill, strokeWidth: shapeStyle.strokeWidth, opacity: shapeStyle.opacity, text: '', created: 0 }),
      rect: toRect(live.box), ...(live.line ? { line: [...viewport.convertToPdfPoint(live.line[0].x, live.line[0].y), ...viewport.convertToPdfPoint(live.line[1].x, live.line[1].y)] as Annotation['line'] } : {}),
    } as Annotation]} />}
    {live && gesture?.mode === 'create' && (gesture.tool === 'text' || gesture.tool === 'image') && <div className="edit-selection dragging" style={{ left: live.box.x, top: live.box.y, width: live.box.w, height: live.box.h }} />}
    {selected && !draft && !ghost && !(gesture && gesture.mode !== 'move' || gesture?.moved) && (() => {
      const box = targetBox(selected), line = selected.kind === 'shape' && selected.shape.line ? [toPoint(selected.shape.line[0], selected.shape.line[1]), toPoint(selected.shape.line[2], selected.shape.line[3])] : null;
      const handles: Handle[] = line ? [] : selected.kind === 'text' ? ['w', 'e'] : HANDLES;
      return <div className={`edit-selection kind-${selected.kind}`} style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
        {handles.map(handle => <span key={handle} className={`edit-handle handle-${handle}`} data-handle={handle} />)}
        {line && line.map((end, i) => <span key={i} className="edit-handle handle-end" data-handle={i ? 'end' : 'start'} style={{ left: end.x - box.x, top: end.y - box.y }} />)}
      </div>;
    })()}
    {draft && <DraftBox key={`${draft.source?.id || 'new'}`} store={store} draft={draft} page={page} viewport={viewport} toBox={toBox} toRect={toRect} background={pageBackground} />}
  </div>;
}

function DraftBox({ store, draft, page, viewport, toBox, toRect, background }: { store: EditStore; draft: TextDraft; page: PDFPageProxy; viewport: PageViewport; toBox: (rect: Rect) => Box; toRect: (box: Box) => Rect; background: (box: Box) => string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const family = usePreviewFamily(page, draft);
  const box = toBox(draft.rect), scale = viewport.scale, { style } = draft;
  const [fill] = useState(() => background(toBox(draft.source?.rect ?? draft.rect)));
  const composing = useRef(false);
  // A single line grows as it is typed, from the side its alignment keeps still.
  const single = !draft.text.includes('\n') && !(draft.source?.text ?? '').includes('\n');
  const [width, setWidth] = useState(box.w);
  const left = single && style.align === 'right' ? box.x + box.w - width : single && style.align === 'center' ? box.x + (box.w - width) / 2 : box.x;
  const fit = () => {
    const node = ref.current; if (!node) return;
    if (single) {
      node.style.width = '0px';
      const next = Math.min(viewport.width, Math.max(box.w, node.scrollWidth + style.size * scale * .5));
      node.style.width = ''; if (Math.abs(next - width) > .5) setWidth(next);
    }
    node.style.height = '0px'; node.style.height = `${Math.max(node.scrollHeight, style.size * scale * style.lineHeight)}px`;
  };
  useLayoutEffect(fit);
  useEffect(() => { const node = ref.current; if (!node) return; node.focus({ preventScroll: true }); node.setSelectionRange(node.value.length, node.value.length); }, []);
  const commit = () => {
    const node = ref.current; if (!node || !store.state.draft) return;
    const height = node.offsetHeight + style.size * scale * .3, shown = { ...box, x: left, w: single ? width : box.w, h: height };
    void commitDraft(store, toRect(shown), toRect({ ...shown, h: Math.max(height, viewport.height - box.y) }));
  };
  // Clicking anywhere else, except the controls that format this text, writes it.
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest('.edit-draft, .edit-properties, dialog, .toast')) return;
      commit();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  });
  const resize = (event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault(); event.stopPropagation();
    const start = event.clientX, width = box.w, target = event.currentTarget; target.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const current = store.state.draft; if (!current) return;
      const rect = toRect({ ...box, w: Math.max(24, Math.min(viewport.width - box.x, width + next.clientX - start)) });
      store.set({ draft: { ...current, rect: [rect[0], current.rect[1], rect[2], current.rect[3]] } });
    };
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
  };
  return <div className="edit-draft" style={{ left, top: box.y, width: single ? width : box.w }} onPointerDown={event => event.stopPropagation()}>
    {draft.source && (() => { const source = toBox(draft.source.rect); return <div className="edit-mask" style={{ left: source.x - left - 1, top: source.y - box.y - 1, width: source.w + 2, height: source.h + 2, background: fill }} />; })()}
    <textarea ref={ref} aria-label={draft.source ? 'Texto del párrafo' : 'Texto nuevo'} spellCheck value={draft.text} placeholder="Escribe aquí"
      style={{ fontFamily: family, fontSize: style.size * scale, lineHeight: style.lineHeight, color: style.color, textAlign: style.align, fontWeight: style.bold ? 700 : 400, fontStyle: style.italic ? 'italic' : 'normal', background: fill, whiteSpace: single ? 'pre' : undefined }}
      onChange={event => { const current = store.state.draft; if (current) store.set({ draft: { ...current, text: event.target.value } }); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        event.stopPropagation();
        if (composing.current) return;
        const current = store.state.draft, letter = event.key.toLowerCase();
        if (event.key === 'Escape') { event.preventDefault(); store.set({ draft: null, notice: '' }); }
        else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); }
        else if ((event.ctrlKey || event.metaKey) && (letter === 'b' || letter === 'i') && current) {
          event.preventDefault();
          store.set({ draft: { ...current, style: { ...current.style, ...(letter === 'b' ? { bold: !current.style.bold } : { italic: !current.style.italic }) } } });
        }
      }} />
    <span className="edit-handle handle-e draft-width" title="Ancho del texto" onPointerDown={resize} />
  </div>;
}
