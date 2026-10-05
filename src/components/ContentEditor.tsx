import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PageViewport, RenderTask } from 'pdfjs-dist';
import { LoaderCircle, Move, Upload, ZoomIn, ZoomOut } from 'lucide-react';
import { assetUrl, pdfAssetSettings } from '../assets';
import { getDocument } from '../pdf';
import { processPdf, readAreaContent, readPageImage } from '../engine/client';
import type { Area, AreaContentInfo, Operation, PageContentItem } from '../engine/operations.mjs';
import type { LoadedDocument } from '../types';
import './ContentEditor.css';

export type ContentEditorKind = 'add-text' | 'replace-text' | 'add-image' | 'replace-image';
type Props = { doc: LoadedDocument; area: Area; initialItem?: PageContentItem; cancelLabel?: string; kind: ContentEditorKind; active: boolean; busy: boolean; getBytes: () => Promise<Uint8Array>; onApply: (operation: Operation) => Promise<void>; onCancel: () => void };
type Box = { x: number; y: number; width: number; height: number };
type Handle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type FontChoice = string;
const fontChoices = [
  ['dm-sans-regular', 'DM Sans regular'], ['dm-sans-semibold', 'DM Sans seminegrita'],
  ['Helvetica', 'Helvetica'], ['Helvetica-Bold', 'Helvetica negrita'], ['Helvetica-Oblique', 'Helvetica cursiva'], ['Helvetica-BoldOblique', 'Helvetica negrita cursiva'],
  ['Times-Roman', 'Times'], ['Times-Bold', 'Times negrita'], ['Times-Italic', 'Times cursiva'], ['Times-BoldItalic', 'Times negrita cursiva'],
  ['Courier', 'Courier'], ['Courier-Bold', 'Courier negrita'], ['Courier-Oblique', 'Courier cursiva'], ['Courier-BoldOblique', 'Courier negrita cursiva'],
] as const;
function matchingFont(name: string): { font: FontChoice; exact: boolean } {
  const original = name.replace(/^[A-Z]{6}\+/, '');
  if (fontChoices.some(([value]) => value === original)) return { font: original, exact: true };
  if (/dm.?sans/i.test(original)) return { font: /bold|semi/i.test(original) ? 'dm-sans-semibold' : 'dm-sans-regular', exact: true };
  const family = /helvetica|arial/i.test(original) ? 'Helvetica' : /times/i.test(original) ? 'Times' : /courier/i.test(original) ? 'Courier' : null;
  if (!family) return { font: 'dm-sans-regular', exact: false };
  const bold = /bold|semi/i.test(original), italic = /italic|oblique/i.test(original);
  const suffix = family === 'Times' ? bold && italic ? '-BoldItalic' : bold ? '-Bold' : italic ? '-Italic' : '-Roman' : bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '';
  return { font: family + suffix, exact: false };
}
const handles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const normalize = (rect: Area['rect']): Area['rect'] => [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
const rounded = (value: number) => Math.round(value * 100) / 100;
function boxFor(viewport: PageViewport, rect: Area['rect']): Box {
  const a = viewport.convertToViewportPoint(rect[0], rect[1]), b = viewport.convertToViewportPoint(rect[2], rect[3]);
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
}
function rectFor(viewport: PageViewport, box: Box): Area['rect'] {
  const a = viewport.convertToPdfPoint(box.x, box.y), b = viewport.convertToPdfPoint(box.x + box.width, box.y + box.height);
  return normalize([a[0], a[1], b[0], b[1]]);
}
function boundBox(box: Box, viewport: PageViewport): Box {
  const width = Math.max(1, Math.min(viewport.width, box.width)), height = Math.max(1, Math.min(viewport.height, box.height));
  return { x: Math.max(0, Math.min(viewport.width - width, box.x)), y: Math.max(0, Math.min(viewport.height - height, box.y)), width, height };
}

/** A draft is always rendered from the original snapshot, never from a preview.
 * PDF coordinates remain authoritative across view rotation, crop and resizing. */
export default function ContentEditor({ doc, area, initialItem, cancelLabel = 'Cancelar', kind, active, busy, getBytes, onApply, onCancel }: Props) {
  const isText = kind === 'add-text' || kind === 'replace-text';
  const replacing = kind === 'replace-text' || kind === 'replace-image';
  const sourceRect = useRef(normalize(area.rect)).current;
  const [rect, setRect] = useState<Area['rect']>(() => normalize(area.rect));
  const [snapshot, setSnapshot] = useState<Uint8Array | null>(null);
  const [previewBase, setPreviewBase] = useState<{ bytes: Uint8Array; page: number } | null>(null);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [hostSize, setHostSize] = useState({ width: 600, height: 450 });
  const [geometry, setGeometry] = useState({ width: 0, height: 0, scale: 1 });
  const [text, setText] = useState(initialItem?.text || '');
  const [font, setFont] = useState<FontChoice>(() => initialItem?.fontName ? matchingFont(initialItem.fontName).font : 'dm-sans-regular');
  const [fontBytes, setFontBytes] = useState<{ name: FontChoice; bytes: Uint8Array } | null>(null);
  const [fontError, setFontError] = useState('');
  const fontCache = useRef(new Map<FontChoice, Uint8Array>());
  const [size, setSize] = useState(initialItem?.size || 12);
  const [color, setColor] = useState(initialItem?.color || '#202020');
  const [align, setAlign] = useState<'left' | 'center' | 'right'>('left');
  const [lineHeight, setLineHeight] = useState(initialItem?.lineHeight || 1.25);
  const [wrap, setWrap] = useState(true);
  const [zoom, setZoom] = useState<'page' | 'area' | number>(() => initialItem ? 'area' : 'page');
  const inputTouched = useRef(!!initialItem);
  const imageFormatTouched = useRef({ fit: false, opacity: false, rotation: false });
  const manualImageChosen = useRef(false), originalImageController = useRef<AbortController | null>(null);
  const [suggestion, setSuggestion] = useState<AreaContentInfo | null>(null);
  const [suggestionError, setSuggestionError] = useState('');
  const [readingArea, setReadingArea] = useState(false);
  const [image, setImage] = useState<{ bytes: Uint8Array; url: string; name: string; width: number; height: number } | null>(null);
  const [fit, setFit] = useState<'contain' | 'cover' | 'stretch'>('contain');
  const [opacity, setOpacity] = useState(100);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [lockRatio, setLockRatio] = useState(true);
  const [imageLoading, setImageLoading] = useState(false);
  const [inputError, setInputError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [previewResult, setPreviewResult] = useState<{ key: string; error?: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null), host = useRef<HTMLDivElement>(null);
  const sequence = useRef(0), imageSequence = useRef(0);
  const drag = useRef<{ id: number; x: number; y: number; box: Box; handle: Handle; scale: number } | null>(null);
  const getBytesRef = useRef(getBytes); getBytesRef.current = getBytes;
  const viewportRef = useRef(viewport); viewportRef.current = viewport;
  const imageUrl = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getBytesRef.current().then(bytes => { if (alive) setSnapshot(new Uint8Array(bytes)); }).catch(error => { if (alive) setSourceError(error.message); });
    return () => { alive = false; imageSequence.current++; if (imageUrl.current) URL.revokeObjectURL(imageUrl.current); };
  }, []);
  useEffect(() => {
    let alive = true;
    void doc.pdf.getPage(area.page).then(page => { if (alive) setViewport(page.getViewport({ scale: 1 })); }).catch(error => { if (alive) setSourceError(error.message); });
    return () => { alive = false; };
  }, [doc.pdf, area.page]);
  useEffect(() => {
    if (!snapshot) return;
    const controller = new AbortController();
    if (!doc.canAssemble) { setPreviewBase({ bytes: snapshot, page: area.page }); return; }
    // Extract once, with assembly permission, so changing a property does not
    // repeatedly parse and rewrite every page of a large document.
    void processPdf(snapshot, { operation: 'pages', plan: [{ page: area.page }] }, doc.password, controller.signal).then(bytes => {
      if (!controller.signal.aborted) setPreviewBase({ bytes, page: 1 });
    }).catch(() => { if (!controller.signal.aborted) setPreviewBase({ bytes: snapshot, page: area.page }); });
    return () => controller.abort();
  }, [snapshot, doc.canAssemble, doc.password, area.page]);
  useEffect(() => {
    const element = host.current; if (!element) return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0 && element.clientHeight > 0) setHostSize(previous => previous.width === element.clientWidth && previous.height === element.clientHeight ? previous : { width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!isText || !font.startsWith('dm-sans')) { setFontError(''); return; }
    const cached = fontCache.current.get(font);
    if (cached) { setFontBytes({ name: font, bytes: cached }); setFontError(''); return; }
    const controller = new AbortController(); setFontError('');
    void fetch(assetUrl('/fonts/' + font + '.ttf'), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('No se pudo cargar la fuente.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!controller.signal.aborted) { fontCache.current.set(font, bytes); setFontBytes({ name: font, bytes }); }
    }).catch(error => { if (!controller.signal.aborted) setFontError(error.message); });
    return () => controller.abort();
  }, [font, isText]);
  useEffect(() => {
    if (kind !== 'replace-text' || !doc.canCopy || !snapshot) return;
    const controller = new AbortController(); setReadingArea(true); setSuggestionError('');
    void readAreaContent(snapshot, { page: area.page, rect: sourceRect }, doc.password, controller.signal).then(info => {
      if (!controller.signal.aborted) {
        setSuggestion(info);
        if (!inputTouched.current && info.text && !info.rotated) { useInfo(info); inputTouched.current = true; }
      }
    }).catch(error => { if (!controller.signal.aborted) setSuggestionError(error.message); }).finally(() => { if (!controller.signal.aborted) setReadingArea(false); });
    return () => controller.abort();
  }, [snapshot, kind, doc.canCopy, doc.password, area.page, sourceRect]);
  useEffect(() => {
    if (kind !== 'replace-image' || initialItem?.kind !== 'image' || !doc.canCopy || !snapshot || manualImageChosen.current) return;
    const controller = new AbortController(), request = ++imageSequence.current;
    originalImageController.current = controller;
    setImageLoading(true); setInputError('');
    void readPageImage(snapshot, area.page, initialItem.id, doc.password, controller.signal).then(info => {
      if (controller.signal.aborted || request !== imageSequence.current) return;
      const bytes = new Uint8Array(info.bytes), url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current); imageUrl.current = url;
      setImage({ bytes, url, name: 'Imagen original', width: info.width, height: info.height });
      if (!imageFormatTouched.current.fit) setFit('stretch');
      if (!imageFormatTouched.current.opacity) setOpacity(rounded(info.opacity * 100));
      if (!imageFormatTouched.current.rotation) setRotation(info.rotation);
    }).catch(error => { if (!controller.signal.aborted && request === imageSequence.current) setInputError((error as Error).message); }).finally(() => { if (!controller.signal.aborted && request === imageSequence.current) setImageLoading(false); });
    return () => controller.abort();
  }, [snapshot, kind, initialItem, doc.canCopy, doc.password, area.page]);

  const validRect = rect.every(Number.isFinite) && rect[2] - rect[0] >= .1 && rect[3] - rect[1] >= .1;
  const fontReady = !font.startsWith('dm-sans') || fontBytes?.name === font;
  const validation = !validRect ? 'Selecciona un área válida.' : isText ? !text.trim() ? 'Escribe el texto que quieres colocar.' : !Number.isFinite(size) || size < 4 || size > 200 ? 'El tamaño debe estar entre 4 y 200 puntos.' : !Number.isFinite(lineHeight) || lineHeight < .8 || lineHeight > 3 ? 'El interlineado debe estar entre 0,8 y 3.' : '' : !image ? 'Elige una imagen PNG o JPEG.' : !Number.isFinite(opacity) || opacity < 0 || opacity > 100 ? 'La opacidad debe estar entre 0 y 100 %.' : '';
  const operation = useMemo<Operation | null>(() => {
    if (validation || isText && !fontReady) return null;
    if (isText) return { operation: kind as 'add-text' | 'replace-text', page: area.page, rect, ...(replacing ? { sourceRect } : {}), text, size, color, align, lineHeight, wrap,
      ...(initialItem?.baselineOffset !== undefined && initialItem.size ? { baselineOffset: initialItem.baselineOffset * size / initialItem.size } : {}),
      ...(font.startsWith('dm-sans') ? { font: fontBytes!.bytes } : { fontName: font }) };
    return { operation: kind as 'add-image' | 'replace-image', page: area.page, rect, ...(replacing ? { sourceRect } : {}), image: image!.bytes, fit, opacity: opacity / 100, rotation };
  }, [kind, area.page, rect, sourceRect, text, size, color, align, lineHeight, wrap, font, fontBytes, image, fit, opacity, rotation, replacing, isText, validation, fontReady, initialItem]);
  const draftKey = JSON.stringify({ rect, text, size, color, align, lineHeight, wrap, font, image: image?.url, fit, opacity, rotation, fontReady, validation });
  const renderKey = draftKey + ':' + hostSize.width + ':' + hostSize.height + ':' + zoom;
  const previewReady = previewResult?.key === renderKey && !previewResult.error && !dragging;
  const previewError = previewResult?.key === renderKey ? previewResult.error : '';
  const failureMessage = inputError || sourceError || fontError || previewError;
  const canApply = !!operation && !!snapshot && previewReady && !busy && !dragging && !imageLoading && !inputError;
  const previewState = sourceError || fontError || previewError || inputError || validation ? 'error' : previewReady && !imageLoading ? 'ready' : 'updating';

  useEffect(() => {
    if (!active || dragging || !previewBase || !viewport) return;
    const controller = new AbortController(), generation = ++sequence.current;
    let loading: ReturnType<typeof getDocument> | null = null;
    let rendering: RenderTask | null = null;
    const abort = () => { rendering?.cancel(); if (loading) void loading.destroy(); };
    controller.signal.addEventListener('abort', abort, { once: true });
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const previewOperation = operation && { ...operation, page: previewBase.page } as Operation;
          const bytes = previewOperation ? await processPdf(previewBase.bytes, previewOperation, doc.password, controller.signal) : new Uint8Array(previewBase.bytes);
          controller.signal.throwIfAborted();
          loading = getDocument({ ...pdfAssetSettings(), data: new Uint8Array(bytes), password: doc.password });
          const pdf = await loading.promise; controller.signal.throwIfAborted();
          const page = await pdf.getPage(previewBase.page), base = page.getViewport({ scale: 1 });
          const areaBox = boxFor(viewport, rect);
          const desiredScale = typeof zoom === 'number' ? zoom : zoom === 'area' ? Math.min((hostSize.width - 64) / Math.max(80, areaBox.width + 48), (hostSize.height - 64) / Math.max(80, areaBox.height + 48), 4) : Math.min((hostSize.width - 32) / base.width, (hostSize.height - 32) / base.height, 1.5);
          const ratio = Math.min(2, window.devicePixelRatio || 1);
          const scale = Math.max(.1, Math.min(desiredScale, Math.sqrt(16_000_000 / (base.width * base.height * ratio * ratio))));
          const view = page.getViewport({ scale });
          const surface = document.createElement('canvas'); surface.width = Math.ceil(view.width * ratio); surface.height = Math.ceil(view.height * ratio);
          try {
            rendering = page.render({ canvas: surface, viewport: view, transform: [ratio, 0, 0, ratio, 0, 0] });
            await rendering.promise; controller.signal.throwIfAborted();
            if (generation !== sequence.current || !canvas.current) return;
            canvas.current.width = surface.width; canvas.current.height = surface.height;
            canvas.current.getContext('2d')!.drawImage(surface, 0, 0);
            setGeometry({ width: view.width, height: view.height, scale }); setPreviewResult({ key: renderKey });
            if (zoom === 'area') requestAnimationFrame(() => { if (host.current) { host.current.scrollLeft = (areaBox.x + areaBox.width / 2) * scale - host.current.clientWidth / 2 + 16; host.current.scrollTop = (areaBox.y + areaBox.height / 2) * scale - host.current.clientHeight / 2 + 16; } });
          } finally { surface.width = 0; surface.height = 0; }
        } catch (error) {
          if (!controller.signal.aborted && generation === sequence.current) setPreviewResult({ key: renderKey, error: (error as Error).message });
        } finally {
          controller.signal.removeEventListener('abort', abort);
          if (loading) await loading.destroy();
        }
      })();
    }, operation ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [active, dragging, previewBase, viewport, operation, renderKey, doc.password, hostSize, zoom, rect]);

  const box = viewport ? boxFor(viewport, rect) : null;
  const originalBox = viewport ? boxFor(viewport, sourceRect) : null;
  function updateBox(next: Box) { const view = viewportRef.current; if (view) setRect(rectFor(view, boundBox(next, view))); }
  function resizeWithRatio(next: Box, axis: 'width' | 'height') {
    if (!box || !viewport) return;
    if (!isText && lockRatio && image) {
      const aspect = box.width / box.height;
      if (axis === 'width') next.height = next.width / aspect; else next.width = next.height * aspect;
      const factor = Math.min(1, viewport.width / next.width, viewport.height / next.height); next.width *= factor; next.height *= factor;
    }
    updateBox(next);
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement | HTMLButtonElement>, handle: Handle) {
    if (busy || !box || !viewport || !geometry.width || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, box, handle, scale: geometry.scale };
    setDragging(true);
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement | HTMLButtonElement>) {
    const active = drag.current; if (!active || active.id !== event.pointerId || !viewport) return;
    const dx = (event.clientX - active.x) / active.scale, dy = (event.clientY - active.y) / active.scale;
    const original = active.box;
    if (active.handle === 'move') { updateBox({ ...original, x: original.x + dx, y: original.y + dy }); return; }
    let left = original.x, top = original.y, right = left + original.width, bottom = top + original.height;
    if (active.handle.includes('w')) left = Math.max(0, Math.min(right - 1, left + dx));
    if (active.handle.includes('e')) right = Math.min(viewport.width, Math.max(left + 1, right + dx));
    if (active.handle.includes('n')) top = Math.max(0, Math.min(bottom - 1, top + dy));
    if (active.handle.includes('s')) bottom = Math.min(viewport.height, Math.max(top + 1, bottom + dy));
    if (!isText && lockRatio && image) {
      const aspect = original.width / original.height;
      let width = right - left, height = bottom - top;
      if (active.handle === 'n' || active.handle === 's') width = height * aspect; else height = width / aspect;
      const factor = Math.min(1, viewport.width / width, viewport.height / height); width *= factor; height *= factor;
      left = active.handle.includes('w') ? original.x + original.width - width : left;
      top = active.handle.includes('n') ? original.y + original.height - height : top;
      right = left + width; bottom = top + height;
    }
    updateBox({ x: left, y: top, width: right - left, height: bottom - top });
  }
  function pointerEnd(event: ReactPointerEvent<HTMLDivElement | HTMLButtonElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  async function chooseImage(file?: File) {
    if (!file) return;
    manualImageChosen.current = true; originalImageController.current?.abort();
    const request = ++imageSequence.current; setImageLoading(true); setInputError('');
    let url: string | null = null;
    try {
      if (!/image\/(png|jpeg)/i.test(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) throw new Error('Elige una imagen PNG o JPEG.');
      url = URL.createObjectURL(file);
      const element = new Image(); element.src = url; await element.decode();
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (request !== imageSequence.current) { URL.revokeObjectURL(url); return; }
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current); imageUrl.current = url;
      setImage({ bytes, url, name: file.name, width: element.naturalWidth, height: element.naturalHeight });
      if (!imageFormatTouched.current.fit) setFit('contain');
    } catch (error) { if (url) URL.revokeObjectURL(url); if (request === imageSequence.current) setInputError((error as Error).message); }
    finally { if (request === imageSequence.current) setImageLoading(false); }
  }
  function useSuggestion() {
    if (!suggestion?.text) return;
    inputTouched.current = true; useInfo(suggestion);
  }
  function useInfo(info: AreaContentInfo) {
    setText(info.text);
    if (info.size >= 4 && info.size <= 200) setSize(rounded(info.size));
    if (/^#[\da-f]{6}$/i.test(info.color)) setColor(info.color);
    setFont(matchingFont(info.fontName).font);
  }
  return <div className="content-editor" data-preview-state={previewState} data-kind={kind} data-preview-base-bytes={previewBase?.bytes.length} data-source-rect={sourceRect.join(',')} data-destination-rect={rect.join(',')}>
    <div className="content-zoom-toolbar"><button type="button" className="secondary-button" onClick={() => setZoom('page')}>Página completa</button><button type="button" className="secondary-button" onClick={() => setZoom('area')}>Al área</button><button type="button" className="secondary-button" onClick={() => setZoom(1)}>100 %</button><button type="button" aria-label="Alejar vista previa" onClick={() => setZoom(Math.max(.1, geometry.scale / 1.25))}><ZoomOut size={17} /></button><button type="button" aria-label="Acercar vista previa" onClick={() => setZoom(Math.min(4, geometry.scale * 1.25))}><ZoomIn size={17} /></button><span>{Math.round(geometry.scale * 100)} %</span></div>
    <div className="content-editor-body">
      <div className="content-preview" ref={host} aria-label="Vista previa del PDF">
        <div className="content-page" style={{ width: geometry.width || undefined, height: geometry.height || undefined }}>
          <canvas ref={canvas} aria-label={'Vista previa de la página ' + area.page} style={{ width: geometry.width, height: geometry.height }} />
          {replacing && originalBox && geometry.width > 0 && <div className="content-source-box" aria-hidden="true" style={{ left: originalBox.x * geometry.scale, top: originalBox.y * geometry.scale, width: originalBox.width * geometry.scale, height: originalBox.height * geometry.scale }} />}
          {box && geometry.width > 0 && <div className={'content-box' + (dragging ? ' is-dragging' : '')} data-role="destination" role="group" tabIndex={0} aria-label="Área de destino. Arrastra para mover; usa las flechas para ajustar." style={{ left: box.x * geometry.scale, top: box.y * geometry.scale, width: box.width * geometry.scale, height: box.height * geometry.scale }} onPointerDown={event => pointerDown(event, 'move')} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onKeyDown={event => {
            if (busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault(); const step = event.shiftKey ? 10 : 1;
            updateBox({ ...box, x: box.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), y: box.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) });
          }}>{handles.map(handle => <button type="button" key={handle} className="content-box-handle" data-handle={handle} disabled={busy} tabIndex={-1} aria-label={'Redimensionar área ' + handle} onPointerDown={event => pointerDown(event, handle)} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} />)}</div>}
        </div>
        {!geometry.width && <div className="content-preview-placeholder"><LoaderCircle className="spin" size={22} />Preparando página…</div>}
        {!previewReady && !previewError && !sourceError && <div className="content-preview-badge" role="status"><LoaderCircle className="spin" size={14} />Actualizando vista previa…</div>}
      </div>
      <div className="content-inspector">
        <p className="content-editor-help"><Move size={15} aria-hidden="true" />Mueve el área y ajusta sus esquinas. Página {area.page}.</p>
        {replacing && <p className="content-editor-note">{isText ? 'Se quita el texto del área marcada con línea discontinua. Puedes mover el texto nuevo.' : 'Se quitan sólo los píxeles de imagen del área marcada con línea discontinua. Otras imágenes solapadas podrían verse afectadas. Puedes mover la imagen nueva.'}</p>}
        <fieldset disabled={busy} onChangeCapture={() => { inputTouched.current = true; }}>
          {isText ? <>
            <label>Texto<textarea aria-label="Texto" value={text} maxLength={50000} onChange={event => { inputTouched.current = true; setText(event.target.value); }} rows={5} placeholder="Escribe el texto" /></label>
            {kind === 'replace-text' && doc.canCopy && <div className="content-suggestion"><button type="button" className="secondary-button" disabled={readingArea || !suggestion?.text} onClick={useSuggestion}>{readingArea ? 'Leyendo texto del área…' : 'Usar texto del área'}</button>{suggestion && <p>{suggestion.text ? 'Fuente original: ' + (suggestion.fontName || 'no identificada') + '.' : 'No se encontró texto extraíble en esta área.'}{suggestion.mixedStyle ? ' El área mezcla estilos; revisa el formato.' : ''}{suggestion.rotated ? ' El texto original tiene rotación.' : ''}</p>}{suggestionError && <p role="alert">{suggestionError}</p>}</div>}
            {(initialItem?.fontName || suggestion?.fontName) && !matchingFont(initialItem?.fontName || suggestion!.fontName).exact && <p className="content-editor-note">La fuente original no está disponible como fuente de edición. Se usará {fontChoices.find(([value]) => value === font)?.[1] || font}; revisa la vista previa.</p>}
            <label>Fuente<select aria-label="Fuente" value={font} onChange={event => { inputTouched.current = true; setFont(event.target.value); }}>{fontChoices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <div className="content-property-row"><label>Tamaño<input aria-label="Tamaño" type="number" min={4} max={200} step={.5} value={size} onChange={event => setSize(Number(event.target.value))} /></label><label>Color<input aria-label="Color" type="color" value={color} onChange={event => setColor(event.target.value)} /></label></div>
            <label>Alineación<select aria-label="Alineación" value={align} onChange={event => setAlign(event.target.value as typeof align)}><option value="left">Izquierda</option><option value="center">Centro</option><option value="right">Derecha</option></select></label>
            <label>Interlineado<input aria-label="Interlineado" type="number" min={.8} max={3} step={.05} value={lineHeight} onChange={event => setLineHeight(Number(event.target.value))} /></label>
            <label className="check-option"><input aria-label="Ajustar líneas" type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} />Ajustar líneas al ancho del área</label>
          </> : <>
            <label className="file-choice content-image-choice"><Upload size={16} aria-hidden="true" />Imagen PNG o JPEG<input aria-label="Imagen PNG o JPEG" type="file" accept="image/png,image/jpeg" onChange={event => { void chooseImage(event.target.files?.[0]); event.target.value = ''; }} /></label>
            {image && <figure className="content-image-info"><img src={image.url} alt="Imagen elegida" /><figcaption>{image.name}<small>{image.width} × {image.height} píxeles</small></figcaption></figure>}
            <label>Ajuste de imagen<select aria-label="Ajuste de imagen" value={fit} onChange={event => { imageFormatTouched.current.fit = true; setFit(event.target.value as typeof fit); }}><option value="contain">Encajar sin deformar</option><option value="cover">Cubrir el área</option><option value="stretch">Estirar al área</option></select></label>
            <label className="check-option"><input type="checkbox" aria-label="Bloquear proporción" checked={lockRatio} onChange={event => setLockRatio(event.target.checked)} />Bloquear proporción del marco</label>
            <label>Opacidad (%)<input aria-label="Opacidad" type="number" min={0} max={100} value={opacity} onChange={event => { imageFormatTouched.current.opacity = true; setOpacity(Number(event.target.value)); }} /></label>
            <label>Rotación<select aria-label="Rotación" value={rotation} onChange={event => { imageFormatTouched.current.rotation = true; setRotation(Number(event.target.value) as typeof rotation); }}><option value={0}>0°</option><option value={90}>90°</option><option value={180}>180°</option><option value={270}>270°</option></select></label>
          </>}
          {box && <><h3>Posición y dimensiones</h3><p className="content-editor-note">Puntos desde la esquina superior izquierda de la página visible.</p><div className="content-property-row"><label>Posición X<input aria-label="Posición X" type="number" min={0} step={.5} value={rounded(box.x)} onChange={event => updateBox({ ...box, x: Number(event.target.value) })} /></label><label>Posición Y<input aria-label="Posición Y" type="number" min={0} step={.5} value={rounded(box.y)} onChange={event => updateBox({ ...box, y: Number(event.target.value) })} /></label></div><div className="content-property-row"><label>Ancho<input aria-label="Ancho" type="number" min={1} step={.5} value={rounded(box.width)} onChange={event => resizeWithRatio({ ...box, width: Number(event.target.value) }, 'width')} /></label><label>Alto<input aria-label="Alto" type="number" min={1} step={.5} value={rounded(box.height)} onChange={event => resizeWithRatio({ ...box, height: Number(event.target.value) }, 'height')} /></label></div></>}
        </fieldset>
        {failureMessage && <p className="operation-error">{failureMessage}</p>}
        {validation && <p className="content-editor-note">{validation}</p>}
      </div>
    </div>
    <div className="content-editor-footer"><span className={failureMessage ? 'content-footer-error' : undefined} role={failureMessage ? 'alert' : 'status'}>{busy ? 'Aplicando cambios…' : failureMessage || (imageLoading ? 'Leyendo imagen…' : previewReady && operation ? 'Vista previa lista. El PDF aún no se ha modificado.' : validation || 'Preparando vista previa…')}</span><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{cancelLabel}</button><button type="button" className="primary-button" disabled={!canApply} onClick={() => { if (canApply) void onApply(operation!); }}>{busy && <LoaderCircle size={16} className="spin" />}Aplicar cambios</button></div>
  </div>;
}
