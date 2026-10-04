import { assetUrl } from './assets';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Operation } from './engine/operations.mjs';

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Operación cancelada', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function recognizePdf(pdf: PDFDocumentProxy, pages: number[], language: 'spa' | 'eng' | 'spa+eng',
  progress: (message: string) => void, signal: AbortSignal): Promise<Operation & { operation: 'ocr' }> {
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
      try {
        await page.render({ canvas, viewport, intent: 'print' }).promise;
        const { data } = await cancellable(worker.recognize(canvas, {}, { blocks: true, text: true }), signal);
        const words = (data.blocks || []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words))).filter(word => word.text.trim()).map(word => {
          const a = viewport.convertToPdfPoint(word.bbox.x0, word.bbox.y0), b = viewport.convertToPdfPoint(word.bbox.x1, word.bbox.y1);
          return { text: word.text, rect: [a[0], a[1], b[0], b[1]] as [number, number, number, number] };
        });
        result.pages.push({ page: number, words });
      } finally { canvas.width = 0; canvas.height = 0; }
    }
    signal.throwIfAborted();
    if (!result.pages.some(page => page.words.length)) throw new Error('No se reconoció texto en las páginas seleccionadas.');
    const response = await fetch(assetUrl('/fonts/dm-sans-regular.ttf')); result.font = new Uint8Array(await response.arrayBuffer());
    return result;
  } finally { signal.removeEventListener('abort', abort); await worker.terminate(); }
}
