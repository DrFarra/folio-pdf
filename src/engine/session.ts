import type { Operation, PageContentInfo, PagePlate } from './operations.mjs';
import type { SessionRequest } from './session.worker';

/** Editar's document, open in its own worker for as long as Editar is: a change
 * is applied there in place and answers with the page it changed, with no copy
 * of the PDF going back and forth. `save` writes the PDF out when it is needed. */
export class EditSession {
  private worker = new Worker(new URL('./session.worker.ts', import.meta.url), { type: 'module' });
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private next = 0;
  /** Set once the worker failed: the session cannot be used again. */
  broken = false;
  /** Resolves with the page count once the document is open. */
  ready: Promise<number>;

  constructor(bytes: Uint8Array, password: string | undefined, private size = bytes.length) {
    this.worker.onmessage = event => {
      const { id, result, error } = event.data, call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id); clearTimeout(call.timer);
      if (error) call.reject(new Error(error)); else call.resolve(result);
    };
    this.worker.onerror = () => this.fail(new Error('El editor se detuvo. Sal de Editar y vuelve a entrar.'));
    const copy = new Uint8Array(bytes);
    this.ready = this.call<number>({ type: 'open', bytes: copy, password }, [copy.buffer]);
  }

  private call<T>(request: SessionRequest, transfer: Transferable[] = []): Promise<T> {
    if (this.broken) return Promise.reject(new Error('El editor se detuvo. Sal de Editar y vuelve a entrar.'));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.next;
      // A stuck engine is stopped; a large book on a slow machine gets time in proportion.
      const timer = setTimeout(() => this.fail(new Error('El editor tardó demasiado y se detuvo.')), 90_000 + this.size / 1048576 * 500);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.worker.postMessage({ id, request }, transfer);
    });
  }
  private fail(error: Error) {
    this.broken = true; this.worker.terminate();
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
  }

  content(page: number) { return this.call<PageContentInfo>({ type: 'content', page }); }
  /** Null while there are undone changes: drawing it would drop them. */
  plate(page: number, item: { id: string; kind: 'text' | 'image' | 'graphic'; rect: [number, number, number, number] }, scale: number) { return this.call<PagePlate | null>({ type: 'plate', page, ...item, scale }); }
  /** One item drawn alone on transparent pixels, to move on screen; a drawing optionally in other colours. */
  sprite(page: number, item: { id: string; kind: 'text' | 'image' | 'graphic'; rect: [number, number, number, number] }, scale: number, colors?: { fill?: string; stroke?: string }) { return this.call<PagePlate>({ type: 'sprite', page, ...item, scale, ...colors }); }
  /** Applies a change; resolves with the page it changed. A change that fails leaves the document as it was. */
  edit(operation: Operation) { return this.call<number>({ type: 'edit', operation }); }
  /** Resolves with the page changed, or null when there was nothing to undo or redo. */
  undo() { return this.call<number | null>({ type: 'undo' }); }
  redo() { return this.call<number | null>({ type: 'redo' }); }
  async render(page: number, scale: number, rotation: number) {
    const { pixels, width, height } = await this.call<{ pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }>({ type: 'render', page, scale, rotation });
    return new ImageData(pixels, width, height);
  }
  /** The PDF as it is now, and its SHA-256 (a document's revision in Folio). */
  save() { return this.call<{ bytes: Uint8Array; revision: string }>({ type: 'save' }); }
  close() { this.fail(new Error('La sesión de edición se cerró.')); }
}
