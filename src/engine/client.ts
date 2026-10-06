import type { Annotation } from '../types';
import type { Inspection } from './mupdf-engine.mjs';
import type { Operation, Field, Area, AreaContentInfo, PageContentInfo, PageImageInfo } from './operations.mjs';

// Starting a worker loads ~10 MB of WASM, so idle workers are reused. A worker
// runs one request at a time; cancelling or timing out a request terminates its
// worker, and an aborted preview gets a warm replacement for the next request.
const idle: Worker[] = [];
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const spawn = () => new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
function release(worker: Worker) {
  if (idle.length >= 2) { worker.terminate(); return; }
  // A worker that fails while idle, e.g. while loading, is dropped instead of reused.
  worker.onerror = () => { idle.splice(idle.indexOf(worker), 1); worker.terminate(); };
  idle.push(worker); clearTimeout(idleTimer);
  // The WASM heap only grows; give its memory back after a quiet period.
  idleTimer = setTimeout(() => { for (const worker of idle.splice(0)) worker.terminate(); }, 30_000);
}
function run<T>(operation: 'inspect' | 'annotate' | 'operate', bytes: Uint8Array, password?: string, annotations?: Annotation[], signal?: AbortSignal, options?: Operation, incremental?: boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Operación cancelada', 'AbortError')); return; }
    const worker = idle.pop() ?? spawn();
    const stop = (reuse: boolean) => {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort); worker.onmessage = worker.onerror = null;
      if (reuse) release(worker); else worker.terminate();
    };
    const abort = () => { stop(false); if (!idle.length) release(spawn()); reject(new DOMException('Operación cancelada', 'AbortError')); };
    const timeout = setTimeout(() => { stop(false); reject(new Error('La operación tardó demasiado y se canceló. El documento no cambió.')); }, 90_000);
    signal?.addEventListener('abort', abort, { once: true });
    // A large document leaves a large heap behind; that worker is not kept.
    worker.onmessage = event => { stop(!event.data.fatal && bytes.length < 32 * 1024 * 1024); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result); };
    worker.onerror = () => { stop(false); reject(new Error('No se pudo completar la operación. El documento no cambió.')); };
    const copy = new Uint8Array(bytes);
    worker.postMessage({ operation, bytes: copy, password, annotations, options, incremental }, [copy.buffer]);
  });
}
export const inspectPdf = (bytes: Uint8Array, password?: string, signal?: AbortSignal) => run<Inspection>('inspect', bytes, password, undefined, signal);
export const exportAnnotated = (bytes: Uint8Array, annotations: Annotation[], password?: string, signal?: AbortSignal, incremental?: boolean) => run<Uint8Array>('annotate', bytes, password, annotations, signal, undefined, incremental);
export const processPdf = (bytes: Uint8Array, options: Operation, password?: string, signal?: AbortSignal) => run<Uint8Array>('operate', bytes, password, undefined, signal, options);
export const readFields = (bytes: Uint8Array, password?: string, signal?: AbortSignal) => run<Field[]>('operate', bytes, password, undefined, signal, { operation: 'fields' });
export const extractText = (bytes: Uint8Array, password?: string, signal?: AbortSignal) => run<string[]>('operate', bytes, password, undefined, signal, { operation: 'text' });
export const readAreaContent = (bytes: Uint8Array, area: Area, password?: string, signal?: AbortSignal) => run<AreaContentInfo>('operate', bytes, password, undefined, signal, { operation: 'area-info', ...area });
export const getPageContent = (bytes: Uint8Array, page: number, password?: string, signal?: AbortSignal) => run<PageContentInfo>('operate', bytes, password, undefined, signal, { operation: 'page-content', page });
export const readPageImage = (bytes: Uint8Array, page: number, id: string, password?: string, signal?: AbortSignal) => run<PageImageInfo>('operate', bytes, password, undefined, signal, { operation: 'page-image', page, id });
