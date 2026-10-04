import { invoke } from '@tauri-apps/api/core';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { GetViewportParameters, RenderParameters, TextContent } from 'pdfjs-dist/types/src/display/api';
import type { Annotation } from './types';
import type { NativeDocument } from './platform';

/** PDFKit remains the owner of the file. Only page metadata, text and bounded
 * rasters cross IPC; this adapter never asks for the original PDF's bytes.
 * It implements the PDF.js proxy methods used by Folio's reader, not its editor.
 */
export type NativePdfPageInfo = {
  view: [number, number, number, number];
  rotation: number;
  annotations?: Annotation[];
};
export type NativePdfMetadata = {
  id: string;
  revision: string;
  size: number;
  numPages: number;
  locked: boolean;
  signed: boolean;
  permissions: {
    canCopy: boolean; canPrint: boolean; canAnnotate: boolean;
    canEdit: boolean; canAssemble: boolean; canFill: boolean;
  };
  firstPage?: NativePdfPageInfo & { page: 1 };
};
export type NativePdfText = {
  lines: { text: string; bounds: [number, number, number, number]; direction?: 'ltr' | 'rtl'; hasEOL?: boolean }[];
  lang?: string | null;
};
export type NativePdfBridge = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type AnnotationListener = (page: number, annotations: Annotation[]) => void;
export type NativePdfOptions = { bridge?: NativePdfBridge; onPageAnnotations?: AnnotationListener };

export class NativePdfPasswordError extends Error {
  readonly metadata: NativePdfMetadata;
  readonly retry: boolean;
  constructor(metadata: NativePdfMetadata, retry: boolean) {
    super(retry ? 'La contraseña del PDF no es correcta.' : 'Este PDF necesita una contraseña.');
    this.name = 'NativePdfPasswordError'; this.metadata = metadata; this.retry = retry;
  }
}
export const isNativePdfPasswordError = (error: unknown): error is NativePdfPasswordError => error instanceof NativePdfPasswordError;

const documents = new WeakMap<PDFDocumentProxy, {
  metadata: NativePdfMetadata;
  subscribe: (listener: AnnotationListener) => () => void;
  annotations: (page: number) => Promise<Annotation[]>;
}>();
export const isNativePdfDocument = (pdf: PDFDocumentProxy) => documents.has(pdf);
export const nativePdfMetadata = (pdf: PDFDocumentProxy) => documents.get(pdf)?.metadata;
export function subscribeNativePdfAnnotations(pdf: PDFDocumentProxy, listener: AnnotationListener): () => void {
  const native = documents.get(pdf);
  if (!native) throw new Error('El documento no usa el lector nativo.');
  return native.subscribe(listener);
}
export function nativePdfPageAnnotations(pdf: PDFDocumentProxy, page: number): Promise<Annotation[]> {
  const native = documents.get(pdf);
  if (!native) return Promise.reject(new Error('El documento no usa el lector nativo.'));
  return native.annotations(page);
}

function abortError() { return new DOMException('La operación se canceló.', 'AbortError'); }
function renderCancelled() { const error = new Error('El renderizado se canceló.'); error.name = 'RenderingCancelledException'; return error; }
function nativeError(error: unknown): Error { return error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'El lector nativo no pudo completar la operación.'); }
function rotationDegrees(value: number) {
  const rotation = ((value % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rotation)) throw new Error('La rotación de la página no es válida.');
  return rotation;
}

/** Coordinates match PageViewport: the PDF origin is bottom-left and the
 * viewport origin is top-left. Crop-box offsets and all quarter turns are kept.
 */
class NativeViewport {
  readonly viewBox: number[];
  readonly userUnit = 1;
  readonly scale: number;
  readonly rotation: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly dontFlip: boolean;
  readonly transform: number[];
  readonly width: number;
  readonly height: number;
  readonly rawDims: { pageWidth: number; pageHeight: number; pageX: number; pageY: number };

  constructor(view: NativePdfPageInfo['view'], { scale, rotation = 0, offsetX = 0, offsetY = 0, dontFlip = false }: GetViewportParameters) {
    if (!Number.isFinite(scale) || scale <= 0 || !view.every(Number.isFinite) || view[2] <= view[0] || view[3] <= view[1]) throw new Error('Las dimensiones de la página no son válidas.');
    this.viewBox = [...view]; this.scale = scale; this.rotation = rotationDegrees(rotation);
    this.offsetX = offsetX; this.offsetY = offsetY; this.dontFlip = dontFlip;
    const matrices: Record<number, number[]> = { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] };
    const [a, b, originalC, originalD] = matrices[this.rotation].map(value => value * scale);
    const c = dontFlip ? -originalC : originalC, d = dontFlip ? -originalD : originalD;
    const corners = [[view[0], view[1]], [view[2], view[1]], [view[0], view[3]], [view[2], view[3]]];
    const xs = corners.map(([x, y]) => a * x + c * y), ys = corners.map(([x, y]) => b * x + d * y);
    const x = Math.min(...xs), y = Math.min(...ys);
    this.transform = [a, b, c, d, offsetX - x, offsetY - y];
    this.width = Math.max(...xs) - x; this.height = Math.max(...ys) - y;
    this.rawDims = { pageWidth: view[2] - view[0], pageHeight: view[3] - view[1], pageX: view[0], pageY: view[1] };
  }
  clone(options: Partial<GetViewportParameters> = {}) {
    return new NativeViewport(this.viewBox as NativePdfPageInfo['view'], { scale: this.scale, rotation: this.rotation, offsetX: this.offsetX, offsetY: this.offsetY, dontFlip: this.dontFlip, ...options });
  }
  convertToViewportPoint(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.transform; return [a * x + c * y + e, b * x + d * y + f];
  }
  convertToViewportRectangle(rect: number[]): number[] {
    return [...this.convertToViewportPoint(rect[0], rect[1]), ...this.convertToViewportPoint(rect[2], rect[3])];
  }
  convertToPdfPoint(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.transform, determinant = a * d - b * c;
    return [(d * (x - e) - c * (y - f)) / determinant, (a * (y - f) - b * (x - e)) / determinant];
  }
}

function textContent(text: NativePdfText): TextContent {
  const items: TextContent['items'] = [];
  for (const line of text.lines) {
    const [x0, y0, x1, y1] = line.bounds, height = y1 - y0;
    if (!line.text || !line.bounds.every(Number.isFinite) || height <= 0 || x1 <= x0) continue;
    items.push({ str: line.text, dir: line.direction || 'ltr', transform: [height, 0, 0, height, x0, y0 + height * .2], width: x1 - x0, height, fontName: 'native-pdf-text', hasEOL: line.hasEOL ?? true });
  }
  return { items, styles: { 'native-pdf-text': { fontFamily: 'sans-serif', ascent: .8, descent: -.2, vertical: false } }, lang: text.lang || null };
}

async function pngImage(bytes: Uint8Array, signal: AbortSignal): Promise<{ image: HTMLImageElement; release: () => void }> {
  if (signal.aborted) throw renderCancelled();
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'image/png' }));
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const release = () => { signal.removeEventListener('abort', cancel); image.onload = null; image.onerror = null; };
      const cancel = () => { release(); image.removeAttribute('src'); reject(renderCancelled()); };
      image.onload = () => { release(); resolve(); };
      image.onerror = () => { release(); reject(new Error('No se pudo decodificar la página del PDF.')); };
      signal.addEventListener('abort', cancel, { once: true }); image.src = url;
    });
    return { image, release: () => { URL.revokeObjectURL(url); image.removeAttribute('src'); } };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

export async function openNativePdf(source: NativeDocument, password?: string, signal?: AbortSignal, options: NativePdfOptions = {}): Promise<{ pdf: PDFDocumentProxy; metadata: NativePdfMetadata }> {
  signal?.throwIfAborted();
  const bridge: NativePdfBridge = options.bridge || invoke;
  const metadata = await bridge<NativePdfMetadata>('native_pdf_open', { token: source.token, password: password || '' }).catch(error => { throw nativeError(error); });
  if (signal?.aborted) { await bridge('native_pdf_close', { token: source.token }).catch(() => {}); throw abortError(); }
  if (metadata.locked) {
    await bridge('native_pdf_close', { token: source.token }).catch(() => {});
    throw new NativePdfPasswordError(metadata, !!password);
  }
  if (!Number.isInteger(metadata.numPages) || metadata.numPages < 1 || !metadata.firstPage) {
    await bridge('native_pdf_close', { token: source.token }).catch(() => {});
    throw new Error('El lector nativo no encontró páginas en el PDF.');
  }
  new NativeViewport(metadata.firstPage.view, { scale: 1, rotation: metadata.firstPage.rotation });

  let destroyed = false, renderQueue = Promise.resolve();
  const pages = new Map<number, PDFPageProxy>(), infoCache = new Map<number, NativePdfPageInfo>(), textCache = new Map<number, TextContent>();
  const infoPending = new Map<number, Promise<NativePdfPageInfo>>(), textPending = new Map<number, Promise<TextContent>>();
  const listeners = new Set<AnnotationListener>();
  const renders = new Set<AbortController>();
  if (options.onPageAnnotations) listeners.add(options.onPageAnnotations);
  const checkAlive = () => { if (destroyed) throw abortError(); };
  const checkPage = (page: number) => { checkAlive(); if (!Number.isInteger(page) || page < 1 || page > metadata.numPages) throw new Error('La página solicitada no existe.'); };
  const cache = <T>(map: Map<number, T>, page: number, value: T, limit = 16) => {
    map.delete(page); map.set(page, value);
    while (map.size > limit) map.delete(map.keys().next().value!);
    return value;
  };
  async function pageInfo(page: number): Promise<NativePdfPageInfo> {
    checkPage(page);
    const existing = infoCache.get(page); if (existing) return cache(infoCache, page, existing);
    const pending = infoPending.get(page); if (pending) return pending;
    const request = bridge<NativePdfPageInfo>('native_pdf_page_info', { token: source.token, page }).then(info => {
      checkAlive(); new NativeViewport(info.view, { scale: 1, rotation: info.rotation });
      cache(infoCache, page, info);
      for (const listener of listeners) listener(page, info.annotations || []);
      return info;
    }).catch(error => { throw nativeError(error); }).finally(() => { infoPending.delete(page); });
    infoPending.set(page, request); return request;
  }
  async function pageText(page: number): Promise<TextContent> {
    checkPage(page);
    const existing = textCache.get(page); if (existing) return cache(textCache, page, existing, 8);
    const pending = textPending.get(page); if (pending) return pending;
    if (!metadata.permissions.canCopy) return { items: [], styles: {}, lang: null };
    const request = bridge<NativePdfText>('native_pdf_text', { token: source.token, page }).then(text => { checkAlive(); return cache(textCache, page, textContent(text), 8); })
      .catch(error => { throw nativeError(error); }).finally(() => { textPending.delete(page); });
    textPending.set(page, request); return request;
  }
  function render(page: number, parameters: RenderParameters): RenderTask {
    const controller = new AbortController(); renders.add(controller);
    let settled = false;
    let rejectRender: (reason: unknown) => void;
    const canceled = () => { if (!settled) { settled = true; rejectRender(renderCancelled()); } };
    const promise = new Promise<void>((resolve, reject) => {
      rejectRender = reject;
      controller.signal.addEventListener('abort', canceled, { once: true });
      // PDFKit renders serially to bound transient raster memory during fast zoom.
      const work = async () => {
        let decoded: Awaited<ReturnType<typeof pngImage>> | undefined;
        try {
          checkPage(page); if (controller.signal.aborted) throw renderCancelled();
          const canvas = parameters.canvas || parameters.canvasContext?.canvas;
          if (!canvas) throw new Error('No hay una superficie para dibujar la página.');
          const context = parameters.canvasContext || canvas.getContext('2d');
          if (!context) throw new Error('No se pudo preparar la página del PDF.');
          const desiredWidth = canvas.width, desiredHeight = canvas.height;
          if (!desiredWidth || !desiredHeight) throw new Error('La superficie de la página está vacía.');
          const ratio = Math.min(1, 4096 / desiredWidth, 4096 / desiredHeight, Math.sqrt(4_000_000 / (desiredWidth * desiredHeight)));
          const width = Math.max(1, Math.floor(desiredWidth * ratio)), height = Math.max(1, Math.floor(desiredHeight * ratio));
          const response = await bridge<ArrayBuffer | number[] | Uint8Array>('native_pdf_render', { token: source.token, page, width, height, rotation: rotationDegrees(parameters.viewport.rotation) });
          if (controller.signal.aborted || destroyed) throw renderCancelled();
          const bytes = response instanceof Uint8Array ? response : new Uint8Array(response);
          if (!bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024) throw new Error('El lector nativo devolvió una imagen de página inválida.');
          decoded = await pngImage(bytes, controller.signal);
          if (controller.signal.aborted || destroyed) throw renderCancelled();
          context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.fillStyle = '#fff'; context.fillRect(0, 0, desiredWidth, desiredHeight);
          context.drawImage(decoded.image, 0, 0, desiredWidth, desiredHeight); context.restore();
          if (!settled) { settled = true; resolve(); }
        } catch (error) { if (!settled) { settled = true; reject(nativeError(error)); } }
        finally { decoded?.release(); renders.delete(controller); controller.signal.removeEventListener('abort', canceled); }
      };
      renderQueue = renderQueue.catch(() => {}).then(work);
    });
    return { promise, cancel: () => controller.abort(), onContinue: null, onError: null, separateAnnots: false } as unknown as RenderTask;
  }
  async function getPage(page: number): Promise<PDFPageProxy> {
    checkPage(page);
    const existing = pages.get(page); if (existing) return cache(pages, page, existing);
    const info = await pageInfo(page);
    const proxy = {
      pageNumber: page, rotate: info.rotation, view: info.view, userUnit: 1, ref: { num: page, gen: 0 },
      getViewport: (parameters: GetViewportParameters) => new NativeViewport(info.view, { rotation: info.rotation, ...parameters }),
      render: (parameters: RenderParameters) => render(page, parameters),
      getTextContent: () => pageText(page),
      getAnnotations: async () => (await pageInfo(page)).annotations || [],
      cleanup: () => { textCache.delete(page); return true; },
    } as unknown as PDFPageProxy;
    return cache(pages, page, proxy);
  }
  type Outline = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>;
  let outlinePromise: Promise<Outline | null> | undefined;
  async function getOutline(): Promise<Outline | null> {
    checkAlive();
    return outlinePromise ||= bridge<{ title: string; page: number; depth: number }[]>('native_pdf_outline', { token: source.token }).then(entries => {
      checkAlive(); const outline: Outline = [], parents: Outline[number][] = [];
      for (const entry of entries) {
        if (!Number.isInteger(entry.page) || entry.page < 1 || entry.page > metadata.numPages) continue;
        const item = { title: entry.title, dest: [entry.page - 1, { name: 'Fit' }], url: null, unsafeUrl: undefined, newWindow: false, color: new Uint8ClampedArray([0, 0, 0]), count: undefined, bold: false, italic: false, items: [] } as unknown as Outline[number];
        const depth = Math.max(0, Math.min(parents.length, Math.floor(entry.depth) || 0));
        (depth && parents[depth - 1] ? parents[depth - 1].items : outline).push(item); parents.length = depth; parents.push(item);
      }
      return outline.length ? outline : null;
    }).catch(error => { outlinePromise = undefined; throw nativeError(error); });
  }
  let closePromise: Promise<void> | undefined;
  function destroy(): Promise<void> {
    if (closePromise) return closePromise;
    destroyed = true; for (const controller of renders) controller.abort(); listeners.clear();
    pages.clear(); infoCache.clear(); textCache.clear(); infoPending.clear(); textPending.clear();
    closePromise = bridge<void>('native_pdf_close', { token: source.token }).catch(error => { throw nativeError(error); });
    return closePromise;
  }
  const pdf = {
    numPages: metadata.numPages, fingerprints: [metadata.id, null], isPureXfa: false,
    getPage, getOutline, destroy,
    getDestination: async () => null,
    getPageIndex: async (ref: { num: number }) => { checkPage(ref.num); return ref.num - 1; },
    getDownloadInfo: async () => ({ length: metadata.size }),
    getPermissions: async () => {
      const permissions = metadata.permissions, flags: number[] = [];
      if (permissions.canPrint) flags.push(4, 2048); if (permissions.canEdit) flags.push(8);
      if (permissions.canCopy) flags.push(16, 512); if (permissions.canAnnotate) flags.push(32);
      if (permissions.canFill) flags.push(256); if (permissions.canAssemble) flags.push(1024);
      return flags;
    },
    getData: async () => { throw new Error('Este PDF se lee directamente desde el archivo. Usa la exportación nativa para guardar una copia.'); },
    cleanup: async () => { textCache.clear(); },
  } as unknown as PDFDocumentProxy;
  Object.defineProperty(pdf, 'loadingTask', { value: { docId: `native:${source.token}:${metadata.revision}`, promise: Promise.resolve(pdf), destroy } });
  documents.set(pdf, { metadata,
    subscribe: listener => { checkAlive(); listeners.add(listener); for (const [page, info] of infoCache) listener(page, info.annotations || []); return () => { listeners.delete(listener); }; },
    annotations: async page => (await pageInfo(page)).annotations || [],
  });
  return { pdf, metadata };
}
