import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { LoaderCircle, MessageSquare } from 'lucide-react';
import type { Annotation, Tool, SearchResult, PDFNavigationTarget } from '../types';
import { TextLayer, pageTextModel, findTextMatches, resolvePDFDestination, safePDFLink } from '../pdf';
import type { Area } from '../engine/operations.mjs';
import { DEFAULT_HIGHLIGHT_OPACITY } from '../engine/highlight-style.mjs';
import { highlightSelection, selectedTextRects, textCaretAtPoint } from '../text-selection';
import type { AnnotationDraft, HighlightSelectionRequest, TextSelectionRequest } from '../text-selection';
import HighlightAnnotationMenu from './HighlightAnnotationMenu';
import { isMobile } from '../platform';
import { isNativePdfDocument } from '../nativePdf';
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
  activeSearch?: SearchResult | null;
  pageLabel?: string;
  onNavigate?: (destination: PDFNavigationTarget) => void;
  canCopy: boolean;
  canAnnotate: boolean;
  onAnnotate: (annotation: AnnotationDraft | AnnotationDraft[]) => void;
  onNoteClick: (id: string) => void;
  onRemoveAnnotation: (id: string) => void;
  onUpdateAnnotation?: (id: string, patch: Partial<Pick<Annotation, 'color' | 'text'>>) => void;
  onCommentHighlight?: (annotation: Annotation) => void;
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
    <div className="page-caption">Página {props.pageLabel || (page as PDFPageProxy & { label?: string } | null)?.label || props.number} <span>de {props.pdf.numPages}</span></div>
  </div>;
}

function PageContent({ pdf, page, scale, rotation, annotations, tool, color, query, activeSearch, onNavigate, canCopy, canAnnotate, onAnnotate, onNoteClick, onRemoveAnnotation, onUpdateAnnotation, onCommentHighlight, onArea, redactions, number }: Props & { page: PDFPageProxy }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);
  const [highlightMenu, setHighlightMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const pointerOrigin = useRef<{ x: number; y: number; at: number; pointerId: number } | null>(null);
  const rendering = useRef(false);
  const [drag, setDrag] = useState<{ x: number; y: number; ex: number; ey: number } | null>(null);
  const dragRef = useRef<typeof drag>(null);
  const selectionCleanup = useRef<(() => void) | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const activeSearchRef = useRef(activeSearch);
  activeSearchRef.current = activeSearch;
  const lastSearchScroll = useRef('');
  const [links, setLinks] = useState<{ rect: number[]; target: PDFNavigationTarget }[]>([]);
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });

  function revealActiveSearch() {
    const active = activeSearchRef.current;
    if (!active || active.page !== number || !queryRef.current.trim()) { lastSearchScroll.current = ''; return; }
    const key = `${active.offset}:${queryRef.current}`;
    if (lastSearchScroll.current === key) return;
    const mark = textRef.current?.querySelector<HTMLElement>(`mark[data-search-offset="${active.offset}"]`);
    if (!mark) return;
    lastSearchScroll.current = key;
    requestAnimationFrame(() => { if (mark.isConnected) mark.scrollIntoView({ block: 'center', inline: 'nearest' }); });
  }

  useEffect(() => {
    let alive = true;
    void page.getAnnotations({ intent: 'display' }).then(async annotations => {
      const resolved = await Promise.all(annotations.filter(annotation => annotation.subtype === 'Link' || annotation.annotationType === 2).map(async annotation => {
        if (!Array.isArray(annotation.rect) || annotation.rect.length !== 4 || !annotation.rect.every(Number.isFinite)) return null;
        const url = safePDFLink(annotation.url);
        const target = url ? { url } : await resolvePDFDestination(pdf, annotation.dest);
        return target ? { rect: annotation.rect as number[], target } : null;
      }));
      if (alive) setLinks(resolved.filter((link): link is NonNullable<typeof link> => link !== null));
    }).catch(() => { if (alive) setLinks([]); });
    return () => { alive = false; };
  }, [page, pdf]);

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
      const model = pageTextModel(source);
      nextText.dataset.searchText = model.text;
      textLayer.textDivs.forEach((span, index) => {
        const segment = model.segments[index];
        if (segment) { span.dataset.original = segment.text; span.dataset.searchStart = String(segment.start); span.dataset.searchEnd = String(segment.end); }
      });
      return true;
    }).catch(error => { if (alive && error?.name !== 'AbortException') console.error('No se pudo preparar la selección de texto.', error); return false; });
    void Promise.all([renderTask.promise, textReady]).then(([, textAvailable]) => {
      if (!alive) return;
      canvas.width = surface.width; canvas.height = surface.height;
      canvas.getContext('2d')?.drawImage(surface, 0, 0);
      if (textAvailable) {
        container.style.cssText = nextText.style.cssText;
        container.setAttribute('data-main-rotation', nextText.getAttribute('data-main-rotation') || '0');
        container.dataset.searchText = nextText.dataset.searchText;
        container.replaceChildren(...nextText.childNodes);
        markSearch(container, queryRef.current, activeSearchRef.current?.page === number ? activeSearchRef.current.offset : undefined);
        revealActiveSearch();
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

  useEffect(() => {
    if (textRef.current) markSearch(textRef.current, query, activeSearch?.page === number ? activeSearch.offset : undefined);
    revealActiveSearch();
  }, [query, activeSearch?.page, activeSearch?.offset, number]);
  useEffect(() => {
    const reveal = (event: Event) => {
      const destination = (event as CustomEvent<{ page: number; offset: number }>).detail;
      if (destination?.page !== number || destination.offset !== activeSearchRef.current?.offset) return;
      lastSearchScroll.current = '';
      revealActiveSearch();
    };
    window.addEventListener('folio:reveal-search-result', reveal);
    return () => window.removeEventListener('folio:reveal-search-result', reveal);
  }, [number]);
  useEffect(() => { setHighlightMenu(null); }, [page, scale, rotation, tool, canAnnotate]);
  useEffect(() => { if (highlightMenu && !annotations.some(annotation => annotation.id === highlightMenu.id)) setHighlightMenu(null); }, [annotations, highlightMenu]);

  useEffect(() => {
    const applySelection = (event: Event) => {
      if (!canCopy || rendering.current || !textRef.current || !frameRef.current) return;
      const request = (event as CustomEvent<HighlightSelectionRequest>).detail;
      const selection = selectedTextRects(textRef.current, request.range);
      if (!selection) return;
      const frame = frameRef.current.getBoundingClientRect();
      const quads = selection.rects.map((rect, index) => {
        const left = Math.max(0, rect.left - frame.left), top = Math.max(0, rect.top - frame.top);
        const right = Math.min(viewport.width, rect.right - frame.left), bottom = Math.min(viewport.height, rect.bottom - frame.top);
        const corners = [[left, top], [right, top], [left, bottom], [right, bottom]];
        // QuadPoints follow the text's upper/lower edges, even in a rotated view.
        // Screen-corner order at 90° would make MuPDF's end caps span the line width.
        const orders = [[0, 1, 2, 3], [1, 3, 0, 2], [3, 2, 1, 0], [2, 0, 3, 1]];
        return orders[Math.round(selection.angles[index] / 90) % 4].flatMap(i => viewport.convertToPdfPoint(corners[i][0], corners[i][1]));
      });
      const points = quads.flat(), xs = points.filter((_, i) => i % 2 === 0), ys = points.filter((_, i) => i % 2 === 1);
      request.annotations.push({ page: number, kind: 'highlight', rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], color, opacity: DEFAULT_HIGHLIGHT_OPACITY, text: selection.text, quads });
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
    const cancelGesture = () => { pointerOrigin.current = null; dragRef.current = null; setDrag(null); setHighlightMenu(null); selectionCleanup.current?.(); };
    window.addEventListener('folio:pinch-start', cancelGesture);
    return () => window.removeEventListener('folio:pinch-start', cancelGesture);
  }, []);

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
    pointerOrigin.current = { x: event.clientX, y: event.clientY, at: Date.now(), pointerId: event.pointerId };
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
      // A second finger can turn the first touch into a pinch. Add a mobile
      // note only after a short tap ends, so zoom cannot accidentally add one.
      if (event.pointerType === 'touch') return;
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
    if (event.pointerType !== 'touch' && tool === 'select') event.currentTarget.setAttribute('data-over-link', String(!!linkAt(event.clientX, event.clientY)));
    if (!dragRef.current) return;
    const p = localPoint(event);
    dragRef.current = { ...dragRef.current, ex: p.x, ey: p.y };
    setDrag(dragRef.current);
  }
  function pointerUp(event: React.PointerEvent) {
    if (event.pointerType === 'touch' && tool === 'note') {
      const origin = pointerOrigin.current;
      pointerOrigin.current = null;
      if (canAnnotate && origin?.pointerId === event.pointerId && Date.now() - origin.at < 400 &&
          Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 5) {
        const point = localPoint(event), coordinates = viewport.convertToPdfPoint(point.x, point.y);
        onAnnotate({ page: number, kind: 'note', rect: [coordinates[0], coordinates[1], coordinates[0], coordinates[1]], color, text: '' });
      }
      return;
    }
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
    window.dispatchEvent(new Event('folio:reader-interaction'));
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
    if (!['select', 'highlight'].includes(tool) || !pointerOrigin.current || window.getSelection()?.isCollapsed === false) return;
    if (Math.hypot(event.clientX - pointerOrigin.current.x, event.clientY - pointerOrigin.current.y) > 3) return;
    const target = highlightAt(event.clientX, event.clientY);
    if (canAnnotate && target?.dataset.annotationId) { event.stopPropagation(); openHighlight(target.dataset.annotationId, event.clientX, event.clientY); return; }
    if (tool !== 'select' || Date.now() - pointerOrigin.current.at > 450) return;
    const link = linkAt(event.clientX, event.clientY);
    if (link && onNavigate) { event.stopPropagation(); navigateLink(link.target); }
  }
  function navigateLink(destination: PDFNavigationTarget) {
    window.dispatchEvent(new Event('folio:reader-interaction'));
    onNavigate?.(destination);
  }
  function linkAt(x: number, y: number) {
    const frame = frameRef.current?.getBoundingClientRect();
    if (!frame) return;
    const point = viewport.convertToPdfPoint(x - frame.left, y - frame.top);
    return links.find(link => point[0] >= Math.min(link.rect[0], link.rect[2]) && point[0] <= Math.max(link.rect[0], link.rect[2]) && point[1] >= Math.min(link.rect[1], link.rect[3]) && point[1] <= Math.max(link.rect[1], link.rect[3]));
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
    {tool === 'select' && onNavigate && <div className="pdf-link-layer">{links.map((link, index) => {
      const first = viewport.convertToViewportPoint(link.rect[0], link.rect[1]), second = viewport.convertToViewportPoint(link.rect[2], link.rect[3]);
      const left = Math.min(first[0], second[0]), top = Math.min(first[1], second[1]);
      // Pointer taps are hit-tested by the page so link text remains selectable
      // through native long-press, drags and pinch. The anchor serves keyboards
      // and assistive technology without covering the browser's text layer.
      return <a key={index} className="pdf-document-link" href={'url' in link.target ? link.target.url : `#page=${link.target.page}`} aria-label={'url' in link.target ? `Abrir enlace: ${link.target.url}` : `Ir a página ${link.target.page}`} style={{ left, top, width: Math.abs(second[0] - first[0]), height: Math.abs(second[1] - first[1]) }} onClick={event => { event.preventDefault(); event.stopPropagation(); navigateLink(link.target); }} />;
    })}</div>}
    <div className="highlight-layer">
      {annotations.filter(a => a.kind === 'highlight').map(a => {
        // Older native drafts omitted opacity; their native exporter uses .35.
        // New selections carry an explicit opacity, and imported values survive.
        const opacity = a.opacity ?? (isNativePdfDocument(pdf) ? .35 : DEFAULT_HIGHLIGHT_OPACITY);
        const p1 = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
        const p2 = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
        return a.quads?.length ? a.quads.map((q, index) => {
          const points = [0, 2, 4, 6].map(i => viewport.convertToViewportPoint(q[i], q[i + 1]));
          const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
          const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top;
          const clipPath = width && height ? `polygon(${[0, 1, 3, 2].map(i => `${(points[i][0] - left) / width * 100}% ${(points[i][1] - top) / height * 100}%`).join(',')})` : undefined;
          return <div key={`${a.id}-${index}`} className="highlight-annotation" {...highlightAccess(a, index === 0)} style={{ left, top, width, height, clipPath, background: a.color, opacity }} />;
        }) : <div key={a.id} className="highlight-annotation" {...highlightAccess(a)} style={{ left: Math.min(p1[0], p2[0]), top: Math.min(p1[1], p2[1]), width: Math.abs(p2[0] - p1[0]), height: Math.abs(p2[1] - p1[1]), background: a.color, opacity }} />;
      })}
    </div>
    <div className="annotation-layer">
      {redactions.filter(area => area.page === number).map((area, index) => {
        const a = viewport.convertToViewportPoint(area.rect[0], area.rect[1]), b = viewport.convertToViewportPoint(area.rect[2], area.rect[3]);
        return <div key={index} className="redaction-preview" style={{ left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) }}>Censurar</div>;
      })}
      {annotations.filter(a => a.kind === 'note').map(a => {
        const p = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
        return <button key={a.id} className="note-marker" aria-label={`Ver nota en página ${number}`} style={{ left: Math.max(0, Math.min(p[0], viewport.width - (isMobile ? 44 : 28))), top: Math.max(0, Math.min(p[1], viewport.height - (isMobile ? 44 : 28))) }} onPointerDown={e => e.stopPropagation()} onClick={event => { event.stopPropagation(); onNoteClick(a.id); }}><MessageSquare size={15} fill="currentColor" /></button>;
      })}
      {drag && tool !== 'highlight' && <div className={`highlight-annotation preview ${tool === 'redact' ? 'redaction-preview' : ''}`} style={{ left: Math.min(drag.x, drag.ex), top: Math.min(drag.y, drag.ey), width: Math.abs(drag.ex - drag.x), height: Math.abs(drag.ey - drag.y) }} />}
    </div>
    {!rendered && <div className="page-loading">{failed ? 'No se pudo renderizar la página.' : <LoaderCircle size={22} className="spin" />}</div>}
    {rendered && failed && <div className="page-render-error" role="alert">No se pudo actualizar esta página.</div>}
    {highlightMenu && canAnnotate && <HighlightAnnotationMenu x={highlightMenu.x} y={highlightMenu.y} onClose={closeHighlight} color={annotations.find(annotation => annotation.id === highlightMenu.id)?.color} onColorChange={onUpdateAnnotation ? (next: string) => { onUpdateAnnotation(highlightMenu.id, { color: next }); } : undefined} onComment={onCommentHighlight ? () => { const annotation = annotations.find(annotation => annotation.id === highlightMenu.id); if (annotation) onCommentHighlight(annotation); setHighlightMenu(null); } : undefined} onRemove={() => { onRemoveAnnotation(highlightMenu.id); setHighlightMenu(null); }} />}
  </div>;
}

export function markSearch(container: HTMLElement, query: string, activeOffset?: number) {
  const spans = [...container.querySelectorAll<HTMLElement>('span[data-search-start]')];
  const matches = findTextMatches(container.dataset.searchText || '', query);
  for (const span of spans) {
    const original = span.dataset.original ?? span.textContent ?? '';
    const base = Number(span.dataset.searchStart), end = base + original.length;
    const fragments = matches.filter(match => match.start < end && match.end > base);
    const existing = span.querySelectorAll<HTMLElement>('mark');
    // Changing only the active occurrence preserves an existing DOM Selection.
    if (span.dataset.searchQuery === query) { for (const mark of existing) mark.dataset.searchActive = String(Number(mark.dataset.searchOffset) === activeOffset); continue; }
    span.dataset.searchQuery = query;
    span.replaceChildren();
    let start = 0;
    for (const match of fragments) {
      const offset = Math.max(0, match.start - base), finish = Math.min(original.length, match.end - base);
      span.append(document.createTextNode(original.slice(start, offset)));
      const mark = document.createElement('mark');
      mark.textContent = original.slice(offset, finish);
      mark.dataset.searchOffset = String(match.start);
      mark.dataset.searchActive = String(match.start === activeOffset);
      span.append(mark);
      start = finish;
    }
    span.append(document.createTextNode(original.slice(start)));
  }
}

export function Thumbnail({ pdf, number, selected, onClick, pageLabel }: { pdf: PDFDocumentProxy; number: number; selected: boolean; onClick: () => void; pageLabel?: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nearby = useNearby(frame, number < 5);
  const [ratio, setRatio] = useState(1.414);
  const [nativeLabel, setNativeLabel] = useState<string>();
  useEffect(() => {
    if (!selected) return;
    // Scroll the thumbnail grid only; scrollIntoView could also move the viewer.
    const node = button.current;
    let grid = node?.parentElement;
    while (grid && (grid.scrollHeight <= grid.clientHeight || !['auto', 'scroll'].includes(getComputedStyle(grid).overflowY))) grid = grid.parentElement;
    if (!node || !grid) return;
    const rect = node.getBoundingClientRect(), parent = grid.getBoundingClientRect();
    if (rect.top < parent.top || rect.bottom > parent.bottom) grid.scrollTop += rect.top - parent.top - (parent.height - rect.height) / 2;
  }, [selected]);
  useEffect(() => {
    if (!nearby) return;
    let alive = true;
    let renderTask: RenderTask | null = null;
    pdf.getPage(number).then(page => {
      if (!alive || !canvasRef.current) return;
      setNativeLabel((page as PDFPageProxy & { label?: string }).label);
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
  const label = pageLabel || nativeLabel || String(number);
  return <button ref={button} className={`thumbnail-item ${selected ? 'selected' : ''}`} onClick={onClick} aria-label={`Ir a página ${label}`} aria-current={selected ? 'page' : undefined}>
    <div className="thumbnail-frame" ref={frame} style={{ aspectRatio: `1 / ${ratio}` }}>
      {nearby && <canvas ref={canvasRef} />}
      {selected && <span className="thumbnail-active-dot" />}
    </div>
    <span className="thumbnail-label">{label}</span>
  </button>;
}
