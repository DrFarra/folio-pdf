import type { PDFDocument } from 'mupdf';
import type { Operation } from './operations.ts';

// Editar's live document: opened once when Editar starts and changed in place,
// each change one step of MuPDF's journal (undo/redo). It is written out only
// when asked (`save`), never per change. Requests are answered in order.
export type SessionRequest =
  | { type: 'open'; bytes: Uint8Array; password?: string }
  | { type: 'content'; page: number }
  | {
      type: 'plate';
      page: number;
      id: string;
      kind: 'text' | 'image' | 'graphic';
      rect: [number, number, number, number];
      scale: number;
    }
  | {
      type: 'sprite';
      page: number;
      id: string;
      kind: 'text' | 'image' | 'graphic';
      rect: [number, number, number, number];
      scale: number;
      fill?: string;
      stroke?: string;
      opaque?: boolean;
    }
  | { type: 'edit'; operation: Operation | Operation[] }
  | { type: 'render'; page: number; scale: number; rotation: number }
  | { type: 'undo' | 'redo' | 'save' };

const engine = Promise.all([import('mupdf'), import('./mupdf-engine.mjs'), import('./operations.ts')]);
let doc: PDFDocument | null = null;
// A large PDF is read from these bytes on demand, so they live as long as the document.
let source: Uint8Array | null = null;
// Journal steps are named `operation:page`, so undo and redo know the page they change.
const stepPage = (name?: string) => Number(name?.split(':').at(-1)) || null;

self.onmessage = async (event: MessageEvent<{ id: number; request: SessionRequest }>) => {
  const { id, request } = event.data;
  try {
    const [mupdf, { open, save }, { editDocument, editDocumentAll, readPage, pagePlate, renderPage, itemSprite }] =
      await engine;
    if (request.type === 'open') {
      source = request.bytes;
      doc = open(source, request.password);
      doc.enableJournal();
      self.postMessage({ id, result: doc.countPages() });
      return;
    }
    if (!doc) throw new Error('La sesión de edición no está abierta.');
    if (request.type === 'content') {
      self.postMessage({
        id,
        result: readPage(doc, { operation: 'page-content', page: request.page, graphics: true }),
      });
      return;
    }
    if (request.type === 'plate') {
      // Drawn by removing the item and undoing that, which would drop the steps to redo.
      if (doc.canRedo()) {
        self.postMessage({ id, result: null });
        return;
      }
      doc.beginOperation('plate');
      let plate;
      try {
        plate = pagePlate(doc, {
          operation: 'page-plate',
          page: request.page,
          id: request.id,
          kind: request.kind,
          rect: request.rect,
          scale: request.scale,
        });
      } finally {
        doc.abandonOperation();
      }
      self.postMessage({ id, result: plate }, { transfer: [plate.png.buffer] });
      return;
    }
    if (request.type === 'sprite') {
      // Read only: drawn whatever there is to redo.
      const { type: _, ...options } = request,
        sprite = itemSprite(doc, options);
      self.postMessage({ id, result: sprite }, { transfer: [sprite.png.buffer] });
      return;
    }
    if (request.type === 'edit') {
      const operation = request.operation,
        several = Array.isArray(operation),
        page = ((several ? operation[0] : operation) as { page?: number }).page;
      doc.beginOperation(`${several ? 'batch' : operation.operation}:${page}`);
      // A change that fails its checks is undone at once (all of a batch): the document stays as it was.
      try {
        if (several) editDocumentAll(doc, operation);
        else editDocument(doc, operation);
        doc.endOperation();
      } catch (error) {
        doc.abandonOperation();
        throw error;
      }
      self.postMessage({ id, result: page });
      return;
    }
    if (request.type === 'undo' || request.type === 'redo') {
      const journal = doc.getJournal(),
        name = request.type === 'undo' ? journal.steps[journal.position - 1] : journal.steps[journal.position];
      if (request.type === 'undo' ? !doc.canUndo() : !doc.canRedo()) {
        self.postMessage({ id, result: null });
        return;
      }
      if (request.type === 'undo') doc.undo();
      else doc.redo();
      self.postMessage({ id, result: stepPage(name) });
      return;
    }
    if (request.type === 'render') {
      // The page as the reader shows it at this scale and turn, as RGBA pixels.
      const page = doc.loadPage(request.page - 1);
      let pixmap;
      try {
        const turn = mupdf.Matrix.concat(
          mupdf.Matrix.scale(request.scale, request.scale),
          mupdf.Matrix.rotate(request.rotation),
        );
        const bounds = mupdf.Rect.transform(page.getBounds(), turn),
          matrix = mupdf.Matrix.concat(turn, mupdf.Matrix.translate(-bounds[0], -bounds[1]));
        pixmap = renderPage(
          page,
          matrix,
          [0, 0, Math.ceil(bounds[2] - bounds[0]), Math.ceil(bounds[3] - bounds[1])],
          true,
        );
        const pixels = new Uint8ClampedArray(pixmap.getPixels());
        self.postMessage(
          { id, result: { pixels, width: pixmap.getWidth(), height: pixmap.getHeight() } },
          { transfer: [pixels.buffer] },
        );
      } finally {
        pixmap?.destroy();
        page.destroy();
      }
      return;
    }
    // Unused objects are dropped (a removed text's old stream is not kept), but
    // nothing is renumbered: deeper garbage collection breaks the journal.
    const bytes = save(doc, 'garbage=1,compress=yes,encrypt=keep');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
      .map(n => n.toString(16).padStart(2, '0'))
      .join('');
    self.postMessage({ id, result: { bytes, revision: digest } }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ id, error: (error instanceof Error && error.message) || 'No se pudo completar la operación.' });
  }
};
