import type { Annotation } from '../types';
import type { Inspection } from './mupdf-engine.mjs';
import type { Operation, Field, Area, AreaContentInfo, PageContentInfo, PageImageInfo } from './operations.mjs';

// Starting a worker loads ~10 MB of WASM, so idle workers are reused. A worker
// runs one request at a time and is reused only after a successful result: an
// error can leave MuPDF's heap inconsistent, or come from an engine that failed
// to load. Cancelling or timing out a request terminates its worker too, and an
// aborted preview gets a warm replacement for the next request.
const idle: Worker[] = [];
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const spawn = () => new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
function release(worker: Worker) {
  if (idle.length >= 2) { worker.terminate(); return; }
  // A worker that crashes while idle is dropped instead of reused.
  worker.onerror = () => { idle.splice(idle.indexOf(worker), 1); worker.terminate(); };
  idle.push(worker); clearTimeout(idleTimer);
  // The WASM heap only grows; give its memory back after a quiet period.
  idleTimer = setTimeout(() => { for (const worker of idle.splice(0)) worker.terminate(); }, 30_000);
}
function run<T>(operation: 'inspect' | 'annotate' | 'operate', bytes: Uint8Array, password?: string, annotations?: Annotation[], signal?: AbortSignal, options?: Operation, incremental?: boolean, lend = false): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Operación cancelada', 'AbortError')); return; }
    const worker = idle.pop() ?? spawn();
    const stop = (reuse: boolean) => {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort); worker.onmessage = worker.onerror = null;
      if (reuse) release(worker); else worker.terminate();
    };
    const abort = () => { stop(false); if (!idle.length) release(spawn()); reject(new DOMException('Operación cancelada', 'AbortError')); };
    // The limit catches a stuck engine; a large book on a slow disk gets time in proportion.
    const timeout = setTimeout(() => { stop(false); reject(new Error('La operación tardó demasiado y se canceló. El documento no cambió.')); }, 90_000 + bytes.length / 1024 / 1024 * 500);
    signal?.addEventListener('abort', abort, { once: true });
    // A large document leaves a large heap behind; that worker is not kept.
    worker.onmessage = event => { stop(!event.data.error && bytes.length < 32 * 1024 * 1024); event.data.error ? reject(new Error(event.data.error)) : resolve(lend ? { ...event.data.result, bytes: event.data.bytes } : event.data.result); };
    worker.onerror = () => { stop(false); reject(new Error('No se pudo completar la operación. El documento no cambió.')); };
    const copy = lend ? bytes : new Uint8Array(bytes);
    worker.postMessage({ operation, bytes: copy, password, annotations, options, incremental, lend }, [copy.buffer]);
  });
}
export const inspectPdf = (bytes: Uint8Array, password?: string, signal?: AbortSignal) => run<Inspection>('inspect', bytes, password, undefined, signal);
/** Lends `bytes` to the worker instead of copying them and returns them with the result:
 * opening a 1 GB PDF then holds two copies (Folio's and PDF.js's), not three. The
 * caller must own the buffer; it is detached until this resolves, and lost if it fails. */
export const inspectOwnedPdf = (bytes: Uint8Array, password?: string, signal?: AbortSignal) => run<Inspection & { bytes: Uint8Array }>('inspect', bytes, password, undefined, signal, undefined, undefined, true);
export const exportAnnotated = (bytes: Uint8Array, annotations: Annotation[], password?: string, signal?: AbortSignal, incremental?: boolean) => run<Uint8Array>('annotate', bytes, password, annotations, signal, undefined, incremental);
export const processPdf = (bytes: Uint8Array, options: Operation, password?: string, signal?: AbortSignal) => run<Uint8Array>('operate', bytes, password, undefined, signal, options);
export const readFields = (bytes: Uint8Array, password?: string, signal?: AbortSignal) => run<Field[]>('operate', bytes, password, undefined, signal, { operation: 'fields' });
export const extractText = (bytes: Uint8Array, password?: string, signal?: AbortSignal) => run<string[]>('operate', bytes, password, undefined, signal, { operation: 'text' });
export const readAreaContent = (bytes: Uint8Array, area: Area, password?: string, signal?: AbortSignal) => run<AreaContentInfo>('operate', bytes, password, undefined, signal, { operation: 'area-info', ...area });
export const getPageContent = (bytes: Uint8Array, page: number, password?: string, signal?: AbortSignal) => run<PageContentInfo>('operate', bytes, password, undefined, signal, { operation: 'page-content', page });
export const readPageImage = (bytes: Uint8Array, page: number, id: string, password?: string, signal?: AbortSignal) => run<PageImageInfo>('operate', bytes, password, undefined, signal, { operation: 'page-image', page, id });
