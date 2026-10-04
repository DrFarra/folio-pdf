import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { LoaderCircle, MessageSquare } from 'lucide-react';
import type { Annotation, Tool } from '../types';
import { normalize, TextLayer } from '../pdf';
import type { Area } from '../engine/operations.mjs';
import { highlightSelection, selectedTextRects, textCaretAtPoint } from '../text-selection';
import type { AnnotationDraft, HighlightSelectionRequest, TextSelectionRequest } from '../text-selection';
import HighlightAnnotationMenu from './HighlightAnnotationMenu';
import { isMobile } from '../platform';
import './PDFPage.css';

function useNearby(ref: React.RefObject<HTMLDivElement | null>, first = false) {
  const [nearby, setNearby] = useState(first);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), { rootMargin: isMobile ? '350px 100px' : '800px 200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return nearby;
}

type Props = {
  pdf: PDFDocumentProxy;
  number: number;
  scale: number;
  rotation: number;
  dimensions: { width: number; height: number; rotation: number };
  annotations: Annotation[];
  tool: Tool;
  color: string;
  query: string;
  canCopy: boolean;
  canAnnotate: boolean;
  onAnnotate: (annotation: AnnotationDraft | AnnotationDraft[]) => void;
  onNoteClick: (id: string) => void;
  onRemoveAnnotation: (id: string) => void;
  onArea: (area: Area) => void;
  redactions: Area[];
};

export default function PDFPage(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const nearby = useNearby(ref, props.number === 1);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!nearby || page) return;
    let alive = true;
    props.pdf.getPage(props.number).then(p => { if (alive) setPage(p); }).catch(() => { if (alive) setError('No se pudo cargar esta página.'); });
    return () => { alive = false; };
  }, [nearby, page, props.pdf, props.number]);
  const rotated = props.rotation % 180 !== 0;
  const viewport = page?.getViewport({ scale: props.scale, rotation: (page.rotate + props.rotation) % 360 });
  const width = viewport?.width ?? (rotated ? props.dimensions.height : props.dimensions.width) * props.scale;
  const height = viewport?.height ?? (rotated ? props.dimensions.width : props.dimensions.height) * props.scale;
  return <div className="pdf-page-wrap" ref={ref} data-page-number={props.number} style={{ width }}>
    <div className="pdf-page" style={{ width, height }}>
      {nearby && page ? <PageContent {...props} page={page} /> : <div className="page-loading">{error || <LoaderCircle size={22} className="spin" />}</div>}
    </div>
    <div className="page-caption">Página {props.number} <span>de {props.pdf.numPages}</span></div>
  </div>;
}

function PageContent({ page, scale, rotation, annotations, tool, color, query, canCopy, canAnnotate, onAnnotate, onNoteClick, onRemoveAnnotation, onArea, redactions, number }: Props & { page: PDFPageProxy }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);
  const [highlightMenu, setHighlightMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const pointerOrigin = useRef<{ x: number; y: number } | null>(null);
  const rendering = useRef(false);
  const [drag, setDrag] = useState<{ x: number; y: number; ex: number; ey: number } | null>(null);
  const dragRef = useRef<typeof drag>(null);
  const selectionCleanup = useRef<(() => void) | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });

  useEffect(() => {
    let alive = true;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    const canvas = canvasRef.current;
    const container = textRef.current;
    if (!canvas || !container) return;
    setFailed(false);
    rendering.current = true;
    canvas.dataset.rendering = 'true';
    const view = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
    const pixelBudget = isMobile ? 4_000_000 : 16_000_000;
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(pixelBudget / (view.width * view.height)));
    // The visible bitmap survives zoom and canceled renders. Prepare pixels and
    // text separately, then publish both in one task before the next paint.
    const surface = document.createElement('canvas');
    surface.width = Math.ceil(view.width * ratio);
    surface.height = Math.ceil(view.height * ratio);
    const nextText = container.cloneNode(false) as HTMLDivElement;
    renderTask = page.render({ canvas: surface, viewport: view, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
    const textReady = page.getTextContent().then(async source => {
      if (!alive) return false;
      textLayer = new TextLayer({ textContentSource: source, container: nextText, viewport: view });
      await textLayer.render();
      return true;
    }).catch(error => { if (alive && error?.name !== 'AbortException') console.error('No se pudo preparar la selección de texto.', error); return false; });
    void Promise.all([renderTask.promise, textReady]).then(([, textAvailable]) => {
      if (!alive) return;
      canvas.width = surface.width; canvas.height = surface.height;
      canvas.getContext('2d')?.drawImage(surface, 0, 0);
      if (textAvailable) {
        container.style.cssText = nextText.style.cssText;
        container.setAttribute('data-main-rotation', nextText.getAttribute('data-main-rotation') || '0');
        container.replaceChildren(...nextText.childNodes);
        markSearch(container, queryRef.current);
      } else container.replaceChildren();
      canvas.dataset.renderScale = String(scale);
      canvas.dataset.renderRotation = String(rotation);
      canvas.dataset.rendering = 'false'; rendering.current = false;
      setRendered(true);
    }).catch(err => {
      if (alive && err?.name !== 'RenderingCancelledException') {
        setFailed(true); rendering.current = false; canvas.dataset.rendering = 'false';
      }
    }).finally(() => { surface.width = 0; surface.height = 0; });
    return () => { alive = false; renderTask?.cancel(); textLayer?.cancel(); };
    // Search is updated separately to avoid rerendering the PDF canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, scale, rotation]);

  useEffect(() => { if (textRef.current) markSearch(textRef.current, query); }, [query]);
  useEffect(() => { setHighlightMenu(null); }, [page, scale, rotation, tool, canAnnotate]);
  useEffect(() => { if (highlightMenu && !annotations.some(annotation => annotation.id === highlightMenu.id)) setHighlightMenu(null); }, [annotations, highlightMenu]);

  useEffect(() => {
    const applySelection = (event: Event) => {
      if (!canCopy || rendering.current || !textRef.current || !frameRef.current) return;
      const request = (event as CustomEvent<HighlightSelectionRequest>).detail;
      const selection = selectedTextRects(textRef.current, request.range);
      if (!selection) return;
      const frame = frameRef.current.getBoundingClientRect();
      const quads = selection.rects.map(rect => {
        const left = Math.max(0, rect.left - frame.left), top = Math.max(0, rect.top - frame.top);
        const right = Math.min(viewport.width, rect.right - frame.left), bottom = Math.min(viewport.height, rect.bottom - frame.top);
        return [[left, top], [right, top], [left, bottom], [right, bottom]].flatMap(([x, y]) => viewport.convertToPdfPoint(x, y));
      });
      const points = quads.flat(), xs = points.filter((_, i) => i % 2 === 0), ys = points.filter((_, i) => i % 2 === 1);
      request.annotations.push({ page: number, kind: 'highlight', rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], color, text: selection.text, quads });
      request.commit ||= onAnnotate;
      request.applied = true;
    };
    const comment = (event: Event) => {
      const request = (event as CustomEvent<TextSelectionRequest>).detail;
      if (request.applied || !canCopy || rendering.current || !textRef.current?.contains(request.range.startContainer) || !frameRef.current) return;
      const selection = selectedTextRects(textRef.current, request.range);
      if (!selection) return;
      const rect = selection.rects[0], frame = frameRef.current.getBoundingClientRect();
      const point = viewport.convertToPdfPoint(rect.left - frame.left, rect.top - frame.top);
      onAnnotate({ page: number, kind: 'note', rect: [point[0], point[1], point[0], point[1]], color, text: '' });
      request.applied = true;
    };
    window.addEventListener('folio:highlight-selection', applySelection);
    window.addEventListener('folio:comment-selection', comment);
    return () => { window.removeEventListener('folio:highlight-selection', applySelection); window.removeEventListener('folio:comment-selection', comment); };
  }, [canCopy, color, number, onAnnotate, viewport]);
  useEffect(() => () => selectionCleanup.current?.(), [tool, canCopy, scale, rotation, query]);

  useEffect(() => {
    // iOS owns the long-press selection and its handles. Wait for a stable
    // selection after fingers lift instead of replacing it with mouse carets.
    if (!isMobile || tool !== 'highlight' || !canCopy || !canAnnotate) return;
    let fingers = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (fingers || rendering.current) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed ||
          !textRef.current?.contains(selection.getRangeAt(0).startContainer)) return;
      timer = setTimeout(() => {
        if (!fingers && !rendering.current && !document.querySelector('dialog[open]')) highlightSelection();
      }, 450);
    };
    const touched = (event: TouchEvent) => { fingers = event.touches.length; schedule(); };
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('touchstart', touched, { passive: true });
    document.addEventListener('touchend', touched, { passive: true });
    document.addEventListener('touchcancel', touched, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('touchstart', touched);
      document.removeEventListener('touchend', touched);
      document.removeEventListener('touchcancel', touched);
    };
  }, [tool, canCopy, canAnnotate, scale, rotation]);

  function localPoint(event: React.PointerEvent) {
    const rect = frameRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(viewport.width, event.clientX - rect.left)), y: Math.max(0, Math.min(viewport.height, event.clientY - rect.top)) };
  }
  function pointerDown(event: React.PointerEvent) {
    if (event.button !== 0) return;
    pointerOrigin.current = { x: event.clientX, y: event.clientY };
    if (tool === 'select' || tool === 'highlight') {
      if (rendering.current) { event.preventDefault(); return; }
      if (event.pointerType === 'touch') return;
      // Let the browser select characters naturally, including across lines/pages.
      // A gesture on an image or a blank margin never creates an area highlight.
      selectionCleanup.current?.();
      if (!canCopy || !textRef.current?.contains(event.target as Node) || !(event.target as Element).closest('span')) return;
      const anchor = textCaretAtPoint(event.clientX, event.clientY, event.target as Element);
      if (!anchor) return;
      const origin = { x: event.clientX, y: event.clientY };
      let point = origin, moved = false, frame = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const update = () => {
        frame = 0;
        if (!moved || !anchor.startContainer.isConnected) return;
        const end = textCaretAtPoint(point.x, point.y);
        if (end) window.getSelection()?.setBaseAndExtent(anchor.startContainer, anchor.startOffset, end.startContainer, end.startOffset);
      };
      const move = (next: PointerEvent) => {
        point = { x: next.clientX, y: next.clientY };
        moved ||= Math.hypot(point.x - origin.x, point.y - origin.y) > 3;
        if (!frame) frame = requestAnimationFrame(update);
      };
      const finish = (up: MouseEvent) => {
        point = { x: up.clientX, y: up.clientY };
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        update();
        if (tool === 'select') { window.dispatchEvent(new Event('folio:text-selection-finished')); cleanup(); return; }
        timer = setTimeout(() => { update(); if (tool === 'highlight') highlightSelection(); cleanup(); }, 0);
      };
      const cleanup = () => { document.removeEventListener('pointermove', move); document.removeEventListener('mouseup', finish); document.removeEventListener('pointercancel', cleanup); if (timer) clearTimeout(timer); if (frame) cancelAnimationFrame(frame); selectionCleanup.current = null; };
      selectionCleanup.current = cleanup;
      document.addEventListener('pointermove', move);
      document.addEventListener('mouseup', finish, { once: true });
      document.addEventListener('pointercancel', cleanup, { once: true });
      return;
    }
    const p = localPoint(event);
    if (tool === 'note') {
      const coords = viewport.convertToPdfPoint(p.x, p.y);
      onAnnotate({ page: number, kind: 'note', rect: [coords[0], coords[1], coords[0], coords[1]], color, text: '' });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { ...p, ex: p.x, ey: p.y };
    setDrag(dragRef.current);
    event.preventDefault();
  }
  function pointerMove(event: React.PointerEvent) {
    if (!dragRef.current) return;
    const p = localPoint(event);
    dragRef.current = { ...dragRef.current, ex: p.x, ey: p.y };
    setDrag(dragRef.current);
  }
  function pointerUp(event: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d || Math.abs(d.ex - d.x) < 4 || Math.abs(d.ey - d.y) < 3) return;
    const a = viewport.convertToPdfPoint(d.x, d.y);
    const b = viewport.convertToPdfPoint(d.ex, d.ey);
    onArea({ page: number, rect: [a[0], a[1], b[0], b[1]] });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function openHighlight(id: string, x: number, y: number) {
    if (!canAnnotate) return;
    window.getSelection()?.removeAllRanges();
    setHighlightMenu({ id, x, y });
  }
  function highlightAt(x: number, y: number) {
    return [...(frameRef.current?.querySelectorAll<HTMLElement>('.highlight-annotation[data-annotation-id]') || [])].reverse().find(element => {
      const box = element.getBoundingClientRect();
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    });
  }
  function clickHighlight(event: React.MouseEvent) {
    if (!canAnnotate || !['select', 'highlight'].includes(tool) || !pointerOrigin.current || !window.getSelection()?.isCollapsed) return;
    if (Math.hypot(event.clientX - pointerOrigin.current.x, event.clientY - pointerOrigin.current.y) > 3) return;
    const target = highlightAt(event.clientX, event.clientY);
    if (target?.dataset.annotationId) openHighlight(target.dataset.annotationId, event.clientX, event.clientY);
  }
  const closeHighlight = () => setHighlightMenu(null);
  function highlightAccess(annotation: Annotation, first = true) {
    return { 'data-annotation-id': annotation.id, 'data-selected': highlightMenu?.id === annotation.id,
      role: first && canAnnotate ? 'button' : undefined, tabIndex: first && canAnnotate ? 0 : undefined,
      'aria-hidden': !first || !canAnnotate ? true : undefined,
      'aria-label': first && canAnnotate ? `Opciones del resaltado en página ${number}` : undefined,
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); event.stopPropagation();
        const box = event.currentTarget.getBoundingClientRect(); openHighlight(annotation.id, box.left, box.bottom);
      } };
  }
  return <div ref={frameRef} className={`page-content tool-${tool}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onClick={clickHighlight} onContextMenu={event => {
    if (!canAnnotate) return;
    const target = highlightAt(event.clientX, event.clientY);
    if (target?.dataset.annotationId) { event.preventDefault(); openHighlight(target.dataset.annotationId, event.clientX, event.clientY); }
  }} onPointerCancel={() => { dragRef.current = null; setDrag(null); pointerOrigin.current = null; }}>
    <canvas ref={canvasRef} aria-label={`Página ${number} del documento`} style={{ width: viewport.width, height: viewport.height }} />
    <div ref={textRef} className="textLayer" data-copy-allowed={canCopy} style={{ '--scale-factor': scale, '--total-scale-factor': scale, ...(canCopy ? {} : { userSelect: 'none', WebkitUserSelect: 'none' }) } as React.CSSProperties} />
    <div className="annotation-layer">
      {redactions.filter(area => area.page === number).map((area, index) => {
        const a = viewport.convertToViewportPoint(area.rect[0], area.rect[1]), b = viewport.convertToViewportPoint(area.rect[2], area.rect[3]);
        return <div key={index} className="redaction-preview" style={{ left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) }}>Censurar</div>;
      })}
      {annotations.map(a => {
        const p1 = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
        const p2 = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
        return a.kind === 'highlight' ? a.quads?.length ? a.quads.map((q, index) => {
          const points = [0, 2, 4, 6].map(i => viewport.convertToViewportPoint(q[i], q[i + 1]));
          const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
          return <div key={`${a.id}-${index}`} className="highlight-annotation" {...highlightAccess(a, index === 0)} style={{ left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), background: a.color }} />;
        }) : <div key={a.id} className="highlight-annotation" {...highlightAccess(a)} style={{ left: Math.min(p1[0], p2[0]), top: Math.min(p1[1], p2[1]), width: Math.abs(p2[0] - p1[0]), height: Math.abs(p2[1] - p1[1]), background: a.color }} /> :
          <button key={a.id} className="note-marker" aria-label={`Ver nota en página ${number}`} style={{ left: Math.min(p1[0], viewport.width - 28), top: Math.min(p1[1], viewport.height - 28) }} onPointerDown={e => e.stopPropagation()} onClick={() => onNoteClick(a.id)}><MessageSquare size={15} fill="currentColor" /></button>;
      })}
      {drag && tool !== 'highlight' && <div className={`highlight-annotation preview ${tool === 'redact' ? 'redaction-preview' : ''}`} style={{ left: Math.min(drag.x, drag.ex), top: Math.min(drag.y, drag.ey), width: Math.abs(drag.ex - drag.x), height: Math.abs(drag.ey - drag.y) }} />}
    </div>
    {!rendered && <div className="page-loading">{failed ? 'No se pudo renderizar la página.' : <LoaderCircle size={22} className="spin" />}</div>}
    {rendered && failed && <div className="page-render-error" role="alert">No se pudo actualizar esta página.</div>}
    {highlightMenu && canAnnotate && <HighlightAnnotationMenu x={highlightMenu.x} y={highlightMenu.y} onClose={closeHighlight} onRemove={() => { onRemoveAnnotation(highlightMenu.id); setHighlightMenu(null); }} />}
  </div>;
}

function markSearch(container: HTMLElement, query: string) {
  const term = normalize(query.trim());
  for (const span of container.querySelectorAll('span')) {
    if (span.querySelector('span')) continue;
    const original = span.dataset.original ?? span.textContent ?? '';
    span.dataset.original = original;
    span.replaceChildren();
    if (!term) { span.textContent = original; continue; }
    const normalized = normalize(original);
    let start = 0;
    let offset: number;
    while ((offset = normalized.indexOf(term, start)) !== -1) {
      span.append(document.createTextNode(original.slice(start, offset)));
      const mark = document.createElement('mark');
      mark.textContent = original.slice(offset, offset + term.length);
      span.append(mark);
      start = offset + term.length;
    }
    span.append(document.createTextNode(original.slice(start)));
  }
}

export function Thumbnail({ pdf, number, selected, onClick }: { pdf: PDFDocumentProxy; number: number; selected: boolean; onClick: () => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nearby = useNearby(frame, number < 5);
  const [ratio, setRatio] = useState(1.414);
  useEffect(() => {
    if (!nearby) return;
    let alive = true;
    let renderTask: RenderTask | null = null;
    pdf.getPage(number).then(page => {
      if (!alive || !canvasRef.current) return;
      const unscaled = page.getViewport({ scale: 1 });
      const view = page.getViewport({ scale: 145 / unscaled.width });
      setRatio(view.height / view.width);
      const canvas = canvasRef.current;
      canvas.width = Math.round(view.width * 1.5);
      canvas.height = Math.round(view.height * 1.5);
      renderTask = page.render({ canvas, viewport: view, transform: [1.5, 0, 0, 1.5, 0, 0] });
      renderTask.promise.catch(() => {});
    }).catch(() => {});
    return () => { alive = false; renderTask?.cancel(); };
  }, [pdf, number, nearby]);
  return <button className={`thumbnail-item ${selected ? 'selected' : ''}`} onClick={onClick} aria-label={`Ir a página ${number}`} aria-current={selected ? 'page' : undefined}>
    <div className="thumbnail-frame" ref={frame} style={{ aspectRatio: `1 / ${ratio}` }}>
      {nearby && <canvas ref={canvasRef} />}
      {selected && <span className="thumbnail-active-dot" />}
    </div>
    <span className="thumbnail-label">{number < 10 ? `0${number}` : number} {number === 1 && <span>Portada</span>}</span>
  </button>;
}
