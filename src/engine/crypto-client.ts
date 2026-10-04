import type { SignatureResult } from './signatures.mjs';
type Request = { operation: 'sign' | 'verify'; bytes: Uint8Array; password?: string; pfx?: Uint8Array; reason?: string; roots?: Uint8Array[] };
function run<T>(request: Request, signal?: AbortSignal, progress?: (message: string) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Operación cancelada', 'AbortError')); return; }
    const worker = new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' });
    const stop = () => { worker.terminate(); clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
    const abort = () => { stop(); reject(new DOMException('Operación cancelada', 'AbortError')); };
    const timeout = setTimeout(() => { stop(); reject(new Error('El proceso de firma excedió dos minutos.')); }, 120000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => { if (event.data.progress) { progress?.(event.data.progress); return; } stop(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result); };
    worker.onerror = () => { stop(); reject(new Error('No se pudo iniciar el motor de certificados.')); };
    const bytes = new Uint8Array(request.bytes), pfx = request.pfx ? new Uint8Array(request.pfx) : undefined;
    worker.postMessage({ ...request, bytes, pfx }, pfx ? [bytes.buffer, pfx.buffer] : [bytes.buffer]);
  });
}
export const signPdf = (bytes: Uint8Array, pfx: Uint8Array, password: string, reason: string, signal?: AbortSignal, progress?: (message: string) => void) => run<Uint8Array>({ operation: 'sign', bytes, pfx, password, reason }, signal, progress);
export const checkSignatures = (bytes: Uint8Array, password?: string, roots?: Uint8Array[], signal?: AbortSignal) => run<SignatureResult[]>({ operation: 'verify', bytes, password, roots }, signal);
