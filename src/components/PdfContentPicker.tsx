import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import { AlertCircle, ChevronLeft, ChevronRight, ImagePlus, LoaderCircle, Minus, MousePointer2, Plus, Type } from 'lucide-react';
import { pdfAssetSettings } from '../assets';
import { getPageContent } from '../engine/client';
import type { Area, PageContentInfo, PageContentItem } from '../engine/operations.mjs';
import type { ContentEditorKind } from './ContentEditor';
import { getDocument, plural } from '../pdf';
import { errorMessage } from '../errors';
import type { LoadedDocument } from '../types';
import './PdfContentPicker.css';

type Props = {
  doc: LoadedDocument;
  page: number;
  getBytes: () => Promise<Uint8Array>;
  busy: boolean;
  onSelect: (item: PageContentItem) => void;
  onAdd: (kind: ContentEditorKind, area: Area) => void;
  onPageChange?: (page: number) => void;
};
type Mode = 'select' | 'add-text' | 'add-image';
type Point = { x: number; y: number };
type Draw = { pointer: number; start: Point; end: Point };
type View = { page: number; viewport: PageViewport; scale: number; key: string };
const normalized = (rect: Area['rect']): Area['rect'] => [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
const pageNumber = (page: number, total: number) => Math.max(1, Math.min(total, Math.round(Number.isFinite(page) ? page : 1)));
function itemBox(viewport: PageViewport, rect: Area['rect']) {
  const corners = [[rect[0], rect[1]], [rect[0], rect[3]], [rect[2], rect[1]], [rect[2], rect[3]]].map(([x, y]) => viewport.convertToViewportPoint(x, y));
  const left = Math.max(0, Math.min(...corners.map(point => point[0]))), top = Math.max(0, Math.min(...corners.map(point => point[1])));
  const right = Math.min(viewport.width, Math.max(...corners.map(point => point[0]))), bottom = Math.min(viewport.height, Math.max(...corners.map(point => point[1])));
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
function itemLabel(item: PageContentItem) {
  const label = item.kind === 'image' ? 'Imagen' : item.level === 'paragraph' ? 'Párrafo' : 'Texto';
  return label + (item.text?.trim() ? ': ' + item.text.trim().replace(/\s+/g, ' ').slice(0, 120) : '') + (!item.editable ? '. ' + (item.reason || 'Este elemento no se puede editar de forma segura.') : '');
}

/** Selects content from an immutable document snapshot. Rendering and inspection
 * use independent copies; selecting an element never modifies the PDF. */
export default function PdfContentPicker({ doc, page, getBytes, busy, onSelect, onAdd, onPageChange }: Props) {
  const [currentPage, setCurrentPage] = useState(() => pageNumber(page, doc.pdf.numPages));
  const [pageInput, setPageInput] = useState(String(currentPage));
  const [mode, setMode] = useState<Mode>('select');
  const [level, setLevel] = useState<'line' | 'paragraph'>('paragraph');
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [hostSize, setHostSize] = useState({ width: 600, height: 420, insetX: 32, insetY: 32 });
  const [snapshot, setSnapshot] = useState<Uint8Array | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [info, setInfo] = useState<{ page: number; value: PageContentInfo } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [inspecting, setInspecting] = useState(true);
  const [rendering, setRendering] = useState(true);
  const [sourceError, setSourceError] = useState('');
  const [inspectError, setInspectError] = useState('');
  const [renderError, setRenderError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [drawing, setDrawing] = useState<Draw | null>(null);
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null);
  const draw = useRef<Draw | null>(null), renderSequence = useRef(0);
  const cache = useRef(new Map<number, PageContentInfo>());
  const getBytesRef = useRef(getBytes); getBytesRef.current = getBytes;
  const renderKey = `${doc.revision}:${currentPage}:${zoom}:${hostSize.width}:${hostSize.height}:${hostSize.insetX}:${hostSize.insetY}`;

  useEffect(() => { setCurrentPage(pageNumber(page, doc.pdf.numPages)); }, [page, doc.pdf.numPages]);
  useEffect(() => {
    setPageInput(String(currentPage)); setSelected(null); setFeedback(''); setUnavailable(false); draw.current = null; setDrawing(null);
  }, [currentPage]);
  useEffect(() => {
    let alive = true; setSnapshot(null); setPdf(null); setInfo(null); setView(null); setInspecting(true); setRendering(true); setSelected(null); setFeedback(''); setUnavailable(false); setSourceError(''); cache.current.clear();
    void getBytesRef.current().then(bytes => { if (alive) setSnapshot(new Uint8Array(bytes)); }).catch(error => { if (alive) setSourceError(errorMessage(error)); });
    return () => { alive = false; };
  }, [doc.id, doc.revision]);
  useEffect(() => {
    if (!snapshot) return;
    let alive = true; setPdf(null); setSourceError('');
    const loading = getDocument({ ...pdfAssetSettings(), data: new Uint8Array(snapshot), password: doc.password });
    void loading.promise.then(value => { if (alive) setPdf(value); }).catch(error => { if (alive) setSourceError(errorMessage(error)); });
    return () => { alive = false; void loading.destroy(); };
  }, [snapshot, doc.password]);
  useEffect(() => {
    if (!snapshot) return;
    const saved = cache.current.get(currentPage); setInfo(saved ? { page: currentPage, value: saved } : null); setInspectError('');
    if (saved) { setInspecting(false); return; }
    const controller = new AbortController(); setInspecting(true);
    void getPageContent(snapshot, currentPage, doc.password, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      cache.current.set(currentPage, value); setInfo({ page: currentPage, value });
    }).catch(error => { if (!controller.signal.aborted) setInspectError(errorMessage(error)); }).finally(() => { if (!controller.signal.aborted) setInspecting(false); });
    return () => controller.abort();
  }, [snapshot, currentPage, doc.password]);
  useEffect(() => {
    const element = host.current; if (!element) return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        const style = getComputedStyle(element), insetX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight), insetY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        setHostSize(previous => previous.width === element.clientWidth && previous.height === element.clientHeight && previous.insetX === insetX && previous.insetY === insetY ? previous : { width: element.clientWidth, height: element.clientHeight, insetX, insetY });
      }
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setView(null); setRendering(true); setRenderError('');
    if (!pdf) return;
    let cancelled = false, task: RenderTask | null = null;
    const generation = ++renderSequence.current;
    void (async () => {
      const surface = document.createElement('canvas'); let target: PDFPageProxy | null = null;
      try {
        target = await pdf.getPage(currentPage); if (cancelled) return;
        const base = target.getViewport({ scale: 1 });
        const scale = zoom === 'fit' ? Math.max(.05, Math.min((hostSize.width - hostSize.insetX) / base.width, (hostSize.height - hostSize.insetY) / base.height, 3)) : zoom;
        const viewport = target.getViewport({ scale }), ratio = Math.min(2, window.devicePixelRatio || 1);
        // Keep exceptionally large pages within a bounded render allocation.
        const pixelRatio = Math.min(ratio, Math.sqrt(24_000_000 / Math.max(1, viewport.width * viewport.height)), 16384 / viewport.width, 16384 / viewport.height);
        surface.width = Math.ceil(viewport.width * pixelRatio); surface.height = Math.ceil(viewport.height * pixelRatio);
        task = target.render({ canvas: surface, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
        await task.promise;
        if (cancelled || generation !== renderSequence.current || !canvas.current) return;
        canvas.current.width = surface.width; canvas.current.height = surface.height; canvas.current.getContext('2d')!.drawImage(surface, 0, 0);
        setView({ page: currentPage, viewport, scale, key: renderKey }); setRendering(false);
      } catch (error) { if (!cancelled && generation === renderSequence.current) { setRenderError(errorMessage(error, 'No se pudo mostrar la página.')); setRendering(false); } }
      finally { surface.width = 0; surface.height = 0; target?.cleanup(); }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, currentPage, zoom, hostSize, renderKey]);

  const pageInfo = info?.page === currentPage ? info.value : null;
  const ready = view?.page === currentPage && view.key === renderKey && !rendering && !sourceError && !renderError;
  const allItems = pageInfo?.items || [];
  const hasParagraphs = allItems.some(item => item.kind === 'text' && item.level === 'paragraph');
  const visibleItems = useMemo(() => {
    return allItems.filter(item => item.kind === 'image' || (level === 'paragraph' && hasParagraphs ? item.level === 'paragraph' : item.level !== 'paragraph'))
      .sort((a, b) => { const x = normalized(a.rect), y = normalized(b.rect); return (y[2] - y[0]) * (y[3] - y[1]) - (x[2] - x[0]) * (x[3] - x[1]); });
  }, [allItems, level, hasParagraphs]);
  const textCount = visibleItems.filter(item => item.kind === 'text').length, imageCount = visibleItems.filter(item => item.kind === 'image').length;
  const error = sourceError || renderError || inspectError;
  const selectedItem = unavailable && doc.canEdit ? allItems.find(item => item.id === selected && item.areaReplaceable) : undefined;
  function navigate(next: number) {
    if (busy) return;
    const bounded = pageNumber(next, doc.pdf.numPages); setPageInput(String(bounded));
    if (bounded !== currentPage) { setCurrentPage(bounded); onPageChange?.(bounded); }
  }
  function setTool(next: Mode) { if (!busy) { setMode(next); setFeedback(''); setUnavailable(false); draw.current = null; setDrawing(null); } }
  function choose(item: PageContentItem) {
    if (busy || !ready || !pageInfo || mode !== 'select') return;
    if (!doc.canEdit) { setFeedback('Este PDF no permite editar su contenido.'); setUnavailable(true); return; }
    setSelected(item.id); setUnavailable(!item.editable);
    if (!item.editable) { setFeedback(item.reason || 'Este elemento no se puede editar de forma segura.'); return; }
    setFeedback(item.kind === 'image' ? 'Imagen seleccionada.' : 'Texto seleccionado.'); onSelect(item);
  }
  function localPoint(event: ReactPointerEvent<HTMLDivElement>): Point | null {
    if (!stage.current || !view || !ready) return null;
    const box = stage.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(view.viewport.width, event.clientX - box.left)), y: Math.max(0, Math.min(view.viewport.height, event.clientY - box.top)) };
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (busy || !doc.canEdit || mode === 'select' || event.button !== 0 || !event.isPrimary) return;
    const point = localPoint(event); if (!point) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    draw.current = { pointer: event.pointerId, start: point, end: point }; setDrawing(draw.current); setFeedback(''); setUnavailable(false);
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (draw.current?.pointer !== event.pointerId) return;
    const point = localPoint(event); if (point) { draw.current = { ...draw.current, end: point }; setDrawing(draw.current); }
  }
  function pointerEnd(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const value = draw.current; if (value?.pointer !== event.pointerId) return;
    draw.current = null; setDrawing(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel || !view || busy || mode === 'select') return;
    if (Math.abs(value.end.x - value.start.x) < 5 || Math.abs(value.end.y - value.start.y) < 5) { setFeedback('Arrastra para marcar el área donde quieres añadir ' + (mode === 'add-text' ? 'el texto.' : 'la imagen.')); return; }
    const a = view.viewport.convertToPdfPoint(value.start.x, value.start.y), b = view.viewport.convertToPdfPoint(value.end.x, value.end.y);
    onAdd(mode, { page: currentPage, rect: normalized([a[0], a[1], b[0], b[1]]) });
  }
  // From the keyboard or a screen reader, adding starts with a centred area that
  // the editor's fields then adjust; a pointer draws the area instead.
  function chooseAdd(next: 'add-text' | 'add-image', keyboard: boolean) {
    if (!keyboard || !view) { setTool(next); return; }
    if (busy || !doc.canEdit) return;
    const [x0, y0, x1, y1] = view.viewport.viewBox, w = x1 - x0, h = y1 - y0;
    onAdd(next, { page: currentPage, rect: [x0 + w * .25, y0 + h * .425, x0 + w * .75, y0 + h * .575] });
  }
  const touch = document.documentElement.dataset.touch === 'true';
  const hint = mode === 'select' ? `${touch ? 'Toca' : 'Haz clic en'} un texto o una imagen para editarlo.` : `Arrastra en la página para marcar dónde irá ${mode === 'add-text' ? 'el texto' : 'la imagen'}.`;
  return <div className="pdf-content-picker" data-page={currentPage} data-mode={mode} data-picker-state={error ? 'error' : ready && !inspecting ? 'ready' : 'loading'} onKeyDown={event => {
    if (event.key === 'Escape' && (draw.current || mode !== 'select')) { event.preventDefault(); event.stopPropagation(); draw.current = null; setDrawing(null); setMode('select'); setFeedback('Selección de área cancelada.'); }
  }}>
    <div className="pdf-picker-toolbar" role="toolbar" aria-label="Editar contenido del PDF">
      <div className="pdf-picker-tools">
        <button type="button" aria-pressed={mode === 'select'} disabled={busy} onClick={() => setTool('select')}><MousePointer2 size={16} aria-hidden="true" />Seleccionar</button>
        <button type="button" aria-label="Añadir texto" aria-pressed={mode === 'add-text'} disabled={busy || !doc.canEdit} onClick={event => chooseAdd('add-text', event.detail === 0)}><Type size={16} aria-hidden="true" /><span className="pdf-picker-full-label">Añadir texto</span><span className="pdf-picker-short-label">Texto</span></button>
        <button type="button" aria-label="Añadir imagen" aria-pressed={mode === 'add-image'} disabled={busy || !doc.canEdit} onClick={event => chooseAdd('add-image', event.detail === 0)}><ImagePlus size={16} aria-hidden="true" /><span className="pdf-picker-full-label">Añadir imagen</span><span className="pdf-picker-short-label">Imagen</span></button>
      </div>
      <div className="pdf-picker-zoom" aria-label="Zoom del selector">
        <button type="button" aria-label="Ajustar página" aria-pressed={zoom === 'fit'} disabled={busy} onClick={() => setZoom('fit')}><span className="pdf-picker-full-label">Ajustar página</span><span className="pdf-picker-short-label">Ajustar</span></button>
        <button type="button" aria-pressed={zoom === 1} disabled={busy} onClick={() => setZoom(1)}>100 %</button>
        <button type="button" aria-label="Alejar página del editor" disabled={busy || (view?.scale || .05) <= .1} onClick={() => setZoom(Math.max(.1, (view?.scale || 1) / 1.25))}><Minus size={16} aria-hidden="true" /></button>
        <span aria-label="Zoom actual">{Math.round((view?.scale || 1) * 100)} %</span>
        <button type="button" aria-label="Acercar página del editor" disabled={busy || (view?.scale || 1) >= 4} onClick={() => setZoom(Math.min(4, (view?.scale || 1) * 1.25))}><Plus size={16} aria-hidden="true" /></button>
      </div>
      <form className="pdf-picker-pagination" onSubmit={event => { event.preventDefault(); navigate(Number(pageInput)); }}>
        <button type="button" aria-label="Página anterior del editor" disabled={busy || currentPage <= 1} onClick={() => navigate(currentPage - 1)}><ChevronLeft size={17} aria-hidden="true" /></button>
        <input type="number" aria-label="Página del editor" value={pageInput} min={1} max={doc.pdf.numPages} disabled={busy} onChange={event => setPageInput(event.target.value)} onBlur={() => navigate(Number(pageInput))} />
        <span>de {doc.pdf.numPages}</span>
        <button type="button" aria-label="Página siguiente del editor" disabled={busy || currentPage >= doc.pdf.numPages} onClick={() => navigate(currentPage + 1)}><ChevronRight size={17} aria-hidden="true" /></button>
      </form>
      {hasParagraphs && <label className="pdf-picker-level"><span>Texto</span><select aria-label="Seleccionar texto por" value={level} disabled={busy} onChange={event => { setLevel(event.target.value as typeof level); setSelected(null); setFeedback(''); setUnavailable(false); }}><option value="paragraph">Párrafos</option><option value="line">Líneas</option></select></label>}
    </div>
    <div className="pdf-picker-viewport" ref={host} aria-label="Página PDF para seleccionar contenido">
      <div className="pdf-picker-stage" ref={stage} data-drawing={mode !== 'select'} style={{ width: view?.viewport.width || 0, height: view?.viewport.height || 0, visibility: ready ? 'visible' : 'hidden' }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => pointerEnd(event)} onPointerCancel={event => pointerEnd(event, true)}>
        <canvas ref={canvas} aria-label={'Página ' + currentPage + ' del PDF'} style={{ width: view?.viewport.width || 0, height: view?.viewport.height || 0 }} />
        {ready && view && mode === 'select' && visibleItems.map(item => {
          const box = itemBox(view.viewport, item.rect); if (box.width < .5 || box.height < .5) return null;
          return <button type="button" key={item.id} className={'pdf-content-item' + (selected === item.id ? ' is-selected' : '')} data-content-id={item.id} data-kind={item.kind} data-editable={item.editable} data-level={item.level} title={itemLabel(item)} aria-label={itemLabel(item)} aria-disabled={!item.editable} disabled={busy} style={box} onClick={() => choose(item)} />;
        })}
        {drawing && <div className="pdf-picker-draw-box" aria-hidden="true" style={{ left: Math.min(drawing.start.x, drawing.end.x), top: Math.min(drawing.start.y, drawing.end.y), width: Math.abs(drawing.end.x - drawing.start.x), height: Math.abs(drawing.end.y - drawing.start.y) }} />}
      </div>
      {!ready && !error && <div className="pdf-picker-loading" role="status"><LoaderCircle size={20} className="spin" aria-hidden="true" />Preparando página…</div>}
      {(sourceError || renderError) && <div className="pdf-picker-loading pdf-picker-error"><AlertCircle size={20} aria-hidden="true" />{sourceError || renderError}</div>}
    </div>
    <div className="pdf-picker-footer">
      <p className={unavailable || error ? 'pdf-picker-unavailable' : undefined} role={unavailable || error ? 'alert' : 'status'}>{(unavailable || error) && <AlertCircle size={16} aria-hidden="true" />}{error || feedback || hint}</p>
      {selectedItem && <button type="button" className="secondary-button" disabled={busy} onClick={() => onAdd(selectedItem.kind === 'text' ? 'replace-text' : 'replace-image', { page: currentPage, rect: selectedItem.rect })}>Reemplazar esta zona</button>}
      <span className="pdf-picker-count">{inspecting ? 'Detectando contenido…' : `${plural(textCount, 'texto', 'textos')} · ${plural(imageCount, 'imagen', 'imágenes')}`}</span>
      {!inspecting && pageInfo && !allItems.length && <p className="pdf-picker-note">No se detectó contenido seleccionable en esta página. Puedes añadir texto o una imagen.</p>}
      {!!pageInfo?.warnings.length && <details className="pdf-picker-warnings"><summary>{plural(pageInfo.warnings.length, 'aviso', 'avisos')} en esta página</summary><ul>{pageInfo.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    </div>
  </div>;
}
