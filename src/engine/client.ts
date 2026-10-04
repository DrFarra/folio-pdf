import type { Annotation } from '../types';
import type { Inspection } from './mupdf-engine.mjs';
import type { Operation, Field } from './operations.mjs';

function run<T>(operation: 'inspect' | 'annotate' | 'operate', bytes: Uint8Array, password?: string, annotations?: Annotation[], signal?: AbortSignal, options?: Operation): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Operación cancelada', 'AbortError')); return; }
    const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
    const stop = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { stop(); reject(new DOMException('Operación cancelada', 'AbortError')); };
    const timeout = setTimeout(() => { stop(); reject(new Error('El motor PDF excedió el tiempo permitido. El original está intacto.')); }, 90_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => { stop(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result); };
    worker.onerror = () => { stop(); reject(new Error('No se pudo iniciar el motor PDF. El original está intacto.')); };
    const copy = new Uint8Array(bytes);
    worker.postMessage({ operation, bytes: copy, password, annotations, options }, [copy.buffer]);
  });
}
export const inspectPdf = (bytes: Uint8Array, password?: string, signal?: AbortSignal) => run<Inspection>('inspect', bytes, password, undefined, signal);
export const exportAnnotated = (bytes: Uint8Array, annotations: Annotation[], password?: string, signal?: AbortSignal) => run<Uint8Array>('annotate', bytes, password, annotations, signal);
export const processPdf = (bytes: Uint8Array, options: Operation, password?: string, signal?: AbortSignal) => run<Uint8Array>('operate', bytes, password, undefined, signal, options);
export const readFields = (bytes: Uint8Array, password?: string, signal?: AbortSignal) => run<Field[]>('operate', bytes, password, undefined, signal, { operation: 'fields' });
export const extractText = (bytes: Uint8Array, password?: string, signal?: AbortSignal) => run<string[]>('operate', bytes, password, undefined, signal, { operation: 'text' });
