import { assetUrl } from './assets';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Operation } from './engine/operations.ts';
import { OcrEngine } from './ppocr-client';
import { cleanPaper, rebuildLines, wordChecker } from './rebuild';
import { flatTilt, flatten, flattenField, inkMask, marginTilt, shrink, skewAngle } from './straighten';

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Operación cancelada', 'AbortError'));
    if (signal.aborted) {
      abort();
      return;
    }
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
    const image = source
      .getContext('2d', { willReadFrequently: true })!
      .getImageData(0, 0, source.width, source.height);
    const sample = shrink({ data: image.data, width: image.width, height: image.height, channels: 4 });
    return { image, sample, mask: inkMask(sample) };
  };
  let page = canvas,
    { image, sample, mask } = read(canvas);
  const turn = (degrees: number) => {
    if (page !== canvas) {
      page.width = 0;
      page.height = 0;
    }
    page = canvas;
    if (Math.abs(degrees) >= 0.1) {
      page = document.createElement('canvas');
      page.width = canvas.width;
      page.height = canvas.height;
      const context = page.getContext('2d', { willReadFrequently: true })!;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, page.width, page.height);
      context.translate(page.width / 2, page.height / 2);
      context.rotate((degrees * Math.PI) / 180);
      context.translate(-page.width / 2, -page.height / 2);
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
    if (extra) {
      angle = Math.round((angle + extra) * 100) / 100;
      turn(angle);
      field = flattenField(mask, sample.width, sample.height);
    }
  }
  if (field) {
    image.data.set(
      flatten({ data: image.data, width: image.width, height: image.height, channels: 4 }, field, 1 / sample.scale),
    );
    page.getContext('2d')!.putImageData(image, 0, 0);
  }
  return { page, angle, flattened: !!field };
}

type Box = [number, number, number, number];
/** The word list a rebuilt page's words are checked against (see scripts/build-wordlist.py). */
async function loadWords() {
  const response = await fetch(assetUrl('/ocr/words.bin'));
  if (!response.ok || !response.body) throw new Error('No se pudo cargar el diccionario del OCR.');
  return wordChecker(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text());
}
type Line = {
  text: string;
  box: Box;
  score: number;
  words: { text: string; box: Box; score: number; letters?: [number, number][] }[];
};
type Reader = { read: (canvas: HTMLCanvasElement, page: number) => Promise<Line[]>; close: () => void };
/** What OCR leaves: invisible text over the page as it is, or the page rebuilt as real, editable text. */
export type OcrResult = 'search' | 'edit';

/** Folio's engine (PP-OCRv5 in a few workers): reads Spanish, English and other Latin-script text alike. */
function engineReader(signal: AbortSignal): Reader {
  const engine = new OcrEngine();
  return {
    read: async canvas => {
      const image = canvas
        .getContext('2d', { willReadFrequently: true })!
        .getImageData(0, 0, canvas.width, canvas.height);
      const lines = await engine.recognize(
        { data: image.data, width: image.width, height: image.height, channels: 4 },
        signal,
      );
      return lines.map(line => ({
        text: line.text,
        box: line.box,
        score: line.score,
        words: line.words.map(word => ({ text: word.text, box: word.box, score: word.score, letters: word.letters })),
      }));
    },
    close: () => engine.terminate(),
  };
}

/** Tesseract, kept for a device where the engine cannot start. */
async function tesseractReader(
  language: 'spa' | 'eng' | 'spa+eng',
  progress: (page: number, share: number) => void,
  signal: AbortSignal,
): Promise<Reader> {
  const { createWorker } = await import('tesseract.js');
  let pageNumber = 0;
  const pendingWorker = createWorker(language, 1, {
    workerPath: assetUrl('/ocr/worker.min.js'),
    corePath: assetUrl('/ocr/core/'),
    langPath: assetUrl('/ocr'),
    gzip: false,
    cacheMethod: 'none',
    workerBlobURL: false,
    logger: event => progress(pageNumber, event.progress),
  });
  // A canceled initialization must also terminate the worker once it becomes available.
  void pendingWorker.then(
    worker => {
      if (signal.aborted) void worker.terminate();
    },
    () => {},
  );
  const worker = await cancellable(pendingWorker, signal);
  const abort = () => {
    void worker.terminate();
  };
  signal.addEventListener('abort', abort, { once: true });
  return {
    read: async (canvas, page) => {
      pageNumber = page;
      const { data } = await cancellable(worker.recognize(canvas, {}, { blocks: true, text: true }), signal);
      const box = ({ bbox }: { bbox: { x0: number; y0: number; x1: number; y1: number } }): Box => [
        bbox.x0,
        bbox.y0,
        bbox.x1,
        bbox.y1,
      ];
      return (data.blocks || [])
        .flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines))
        .filter(line => line.text.trim())
        .map(line => ({
          text: line.text.trim(),
          box: box(line),
          score: line.confidence / 100,
          words: line.words
            .filter(word => word.text.trim())
            .map(word => ({ text: word.text, box: box(word), score: word.confidence / 100 })),
        }));
    },
    close: () => {
      signal.removeEventListener('abort', abort);
      void worker.terminate();
    },
  };
}

export async function recognizePdf(
  pdf: PDFDocumentProxy,
  pages: number[],
  language: 'spa' | 'eng' | 'spa+eng',
  progress: (message: string) => void,
  signal: AbortSignal,
  straightened = false,
  outcome: OcrResult = 'search',
): Promise<Operation & { operation: 'ocr' }> {
  let reader = engineReader(signal),
    fallback = false,
    known: ((word: string) => boolean) | undefined;
  try {
    const result: Extract<Operation, { operation: 'ocr' }> = { operation: 'ocr', pages: [] };
    for (const number of pages) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      const basic = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.sqrt(12_000_000 / (basic.width * basic.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      let read = canvas,
        angle = 0,
        flattened = false;
      try {
        progress(`Página ${number} · preparando`);
        await page.render({ canvas, viewport, intent: 'print' }).promise;
        if (straightened) {
          progress(`Página ${number} · enderezando`);
          await new Promise(resolve => setTimeout(resolve));
          ({ page: read, angle, flattened } = straighten(canvas));
          signal.throwIfAborted();
        }
        progress(`Página ${number} · reconociendo`);
        let found: Line[];
        try {
          found = await reader.read(read, number);
        } catch (error) {
          if (signal.aborted || fallback) throw error;
          // The engine could not start here (an old WebView, no WebAssembly SIMD): Tesseract takes over.
          console.warn('Motor de OCR no disponible; se usa Tesseract.', error);
          reader.close();
          fallback = true;
          reader = await tesseractReader(
            language,
            (n, share) => progress(`Página ${n} · ${Math.round(share * 100)} %`),
            signal,
          );
          found = await reader.read(read, number);
        }
        // A flattened or rebuilt page becomes an upright page of the size it was seen at.
        const width = viewport.width / scale,
          height = viewport.height / scale,
          upright = flattened || outcome === 'edit';
        const toPdf = (x: number, y: number) =>
          upright ? [x / scale, height - y / scale] : viewport.convertToPdfPoint(x, y);
        const pdfWords = (lines: Line[]) =>
          lines
            .flatMap(line => line.words)
            .map(({ text, box }) => {
              const a = toPdf(box[0], box[1]),
                b = toPdf(box[2], box[3]);
              return { text, rect: [a[0], a[1], b[0], b[1]] as Box };
            });
        if (outcome === 'edit') {
          progress(`Página ${number} · reconstruyendo`);
          // Lines far taller than the page's text (turned text, a figure) stay in the image, searchable.
          const heights = found.map(line => line.box[3] - line.box[1]).sort((a, b) => a - b),
            usual = heights[heights.length >> 1] || 0;
          const level = found.filter(line => line.box[3] - line.box[1] <= usual * 2.5);
          const jpeg = async () => {
            const blob = await new Promise<Blob | null>(resolve => read.toBlob(resolve, 'image/jpeg', 0.9));
            if (!blob) throw new Error('No se pudo guardar la página reconstruida.');
            return new Uint8Array(await blob.arrayBuffer());
          };
          // The page as scanned goes too: the engine matches each line's face against its letters.
          const original = await jpeg();
          const context = read.getContext('2d', { willReadFrequently: true })!,
            pixels = context.getImageData(0, 0, read.width, read.height);
          known ??= await loadWords();
          const styles = rebuildLines(
            { data: pixels.data, width: pixels.width, height: pixels.height, channels: 4 },
            level.map(line => ({ text: line.text, box: line.box, score: line.score, words: line.words })),
            known,
          );
          // What stays as image no longer looks scanned: white paper, black ink.
          cleanPaper({ data: pixels.data, width: pixels.width, height: pixels.height, channels: 4 });
          context.putImageData(pixels, 0, 0);
          // Rewritten lines without their doubtful words, which stay in the image and searchable.
          const rebuilt = level.flatMap((line, i) => {
            const style = styles[i];
            if (!style) return [];
            const { kept: doubtful, box: lineBox, colors, ...colours } = style,
              words = line.words.flatMap((word, n) =>
                doubtful.includes(n) ? [] : [{ ...word, color: colors[n] ?? undefined }],
              );
            return [
              {
                text: words.map(word => word.text).join(' '),
                box: lineBox.map(v => v / scale) as Box,
                ...colours,
                words: words.map(word => ({
                  text: word.text,
                  box: word.box.map(v => v / scale) as Box,
                  color: word.color,
                  letters: word.letters?.map(([a, b]) => [a / scale, b / scale] as [number, number]),
                })),
              },
            ];
          });
          const kept = [
            ...found.filter(line => !level.includes(line) || !styles[level.indexOf(line)]),
            ...level.flatMap((line, i) =>
              styles[i] ? [{ ...line, words: line.words.filter((_, n) => styles[i]!.kept.includes(n)) }] : [],
            ),
          ];
          result.pages.push({
            page: number,
            words: pdfWords(kept),
            image: await jpeg(),
            size: [width, height],
            lines: rebuilt,
            original,
          });
          continue;
        }
        const words = pdfWords(found);
        if (flattened) {
          const blob = await new Promise<Blob | null>(resolve => read.toBlob(resolve, 'image/jpeg', 0.9));
          if (!blob) throw new Error('No se pudo guardar la página enderezada.');
          result.pages.push({
            page: number,
            words,
            image: new Uint8Array(await blob.arrayBuffer()),
            size: [width, height],
          });
        } else result.pages.push({ page: number, words, ...(angle ? { angle } : {}) });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        read.width = 0;
        read.height = 0;
      }
    }
    signal.throwIfAborted();
    if (!result.pages.some(page => page.words.length || page.lines?.length))
      throw new Error('No se reconoció texto en las páginas seleccionadas.');
    // Open fonts like books' own, for the engine to match rebuilt lines against.
    if (outcome === 'edit') {
      const { faces } = (await (await fetch(assetUrl('/fonts/ocr/faces.json'))).json()) as {
        faces: { family: string; name: string; bold: boolean; italic: boolean; file: string }[];
      };
      result.faces = await Promise.all(
        faces.map(async ({ file, ...face }) => ({
          ...face,
          file: new Uint8Array(await (await fetch(assetUrl(`/fonts/ocr/${file}`))).arrayBuffer()),
        })),
      );
    }
    const response = await fetch(assetUrl('/fonts/dm-sans-regular.ttf'));
    result.font = new Uint8Array(await response.arrayBuffer());
    return result;
  } finally {
    reader.close();
  }
}
