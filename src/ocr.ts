import { assetUrl } from './assets';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Operation } from './engine/operations.mjs';
import { flatTilt, flatten, flattenField, inkMask, marginTilt, shrink, skewAngle } from './straighten';

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Operación cancelada', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * A scanned page made straight for reading: turned by its tilt, then flattened when
 * its lines curve. Only a flattened page needs its new pixels; a turn is redone on the
 * PDF's own content, without recompressing the scan.
 */
// shortcut: runs on the main thread (a few hundred ms per page); move it to a worker if pages feel stuck.
function straighten(canvas: HTMLCanvasElement) {
  const read = (source: HTMLCanvasElement) => {
    const image = source.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, source.width, source.height);
    const sample = shrink({ data: image.data, width: image.width, height: image.height, channels: 4 });
    return { image, sample, mask: inkMask(sample) };
  };
  let page = canvas, { image, sample, mask } = read(canvas);
  const turn = (degrees: number) => {
    if (page !== canvas) { page.width = 0; page.height = 0; }
    page = canvas;
    if (Math.abs(degrees) >= .1) {
      page = document.createElement('canvas'); page.width = canvas.width; page.height = canvas.height;
      const context = page.getContext('2d', { willReadFrequently: true })!;
      context.fillStyle = '#fff'; context.fillRect(0, 0, page.width, page.height);
      context.translate(page.width / 2, page.height / 2); context.rotate(degrees * Math.PI / 180); context.translate(-page.width / 2, -page.height / 2);
      context.drawImage(canvas, 0, 0);
    }
    ({ image, sample, mask } = read(page));
  };
  let angle = skewAngle(mask, sample.width, sample.height);
  if (angle) turn(angle);
  let field = flattenField(mask, sample.width, sample.height);
  if (field) {
    // A curve pulls the page's angle: the margin, which stays straight, says the true turn.
    const extra = marginTilt(mask, sample.width, sample.height) ?? flatTilt(mask, sample.width, sample.height);
    if (extra) { angle = Math.round((angle + extra) * 100) / 100; turn(angle); field = flattenField(mask, sample.width, sample.height); }
  }
  if (field) {
    image.data.set(flatten({ data: image.data, width: image.width, height: image.height, channels: 4 }, field, 1 / sample.scale));
    page.getContext('2d')!.putImageData(image, 0, 0);
  }
  return { page, angle, flattened: !!field };
}

export async function recognizePdf(pdf: PDFDocumentProxy, pages: number[], language: 'spa' | 'eng' | 'spa+eng',
  progress: (message: string) => void, signal: AbortSignal, straightened = false): Promise<Operation & { operation: 'ocr' }> {
  const { createWorker } = await import('tesseract.js');
  let pageNumber = pages[0];
  const pendingWorker = createWorker(language, 1, {
    workerPath: assetUrl('/ocr/worker.min.js'),
    corePath: assetUrl('/ocr/core/'),
    langPath: assetUrl('/ocr'),
    gzip: false, cacheMethod: 'none', workerBlobURL: false,
    logger: event => progress(`Página ${pageNumber} · ${Math.round(event.progress * 100)} %`),
  });
  // A canceled initialization must also terminate the worker once it becomes available.
  void pendingWorker.then(worker => { if (signal.aborted) void worker.terminate(); }, () => {});
  const worker = await cancellable(pendingWorker, signal);
  const abort = () => { void worker.terminate(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result: Extract<Operation, { operation: 'ocr' }> = { operation: 'ocr', pages: [] };
    for (const number of pages) {
      signal.throwIfAborted(); pageNumber = number;
      const page = await pdf.getPage(number);
      const basic = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.sqrt(12_000_000 / (basic.width * basic.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      let read = canvas, angle = 0, flattened = false;
      try {
        await page.render({ canvas, viewport, intent: 'print' }).promise;
        if (straightened) {
          progress(`Página ${number} · enderezando`); await new Promise(resolve => setTimeout(resolve));
          ({ page: read, angle, flattened } = straighten(canvas)); signal.throwIfAborted();
        }
        const { data } = await cancellable(worker.recognize(read, {}, { blocks: true, text: true }), signal);
        // A flattened page becomes an upright page of the size it was seen at.
        const width = viewport.width / scale, height = viewport.height / scale;
        const toPdf = (x: number, y: number) => flattened ? [x / scale, height - y / scale] : viewport.convertToPdfPoint(x, y);
        const words = (data.blocks || []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words))).filter(word => word.text.trim()).map(word => {
          const a = toPdf(word.bbox.x0, word.bbox.y0), b = toPdf(word.bbox.x1, word.bbox.y1);
          return { text: word.text, rect: [a[0], a[1], b[0], b[1]] as [number, number, number, number] };
        });
        if (flattened) {
          const blob = await new Promise<Blob | null>(resolve => read.toBlob(resolve, 'image/jpeg', .9));
          if (!blob) throw new Error('No se pudo guardar la página enderezada.');
          result.pages.push({ page: number, words, image: new Uint8Array(await blob.arrayBuffer()), size: [width, height] });
        } else result.pages.push({ page: number, words, ...(angle ? { angle } : {}) });
      } finally { canvas.width = 0; canvas.height = 0; read.width = 0; read.height = 0; }
    }
    signal.throwIfAborted();
    if (!result.pages.some(page => page.words.length)) throw new Error('No se reconoció texto en las páginas seleccionadas.');
    const response = await fetch(assetUrl('/fonts/dm-sans-regular.ttf')); result.font = new Uint8Array(await response.arrayBuffer());
    return result;
  } finally { signal.removeEventListener('abort', abort); await worker.terminate(); }
}
