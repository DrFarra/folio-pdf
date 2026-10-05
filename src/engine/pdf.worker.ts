import type { Annotation } from '../types';
import type { Operation } from './operations.mjs';

const engine = import('./mupdf-engine.mjs');
self.onmessage = async (event: MessageEvent<{ operation: 'inspect' | 'annotate' | 'operate'; bytes: Uint8Array; password?: string; annotations?: Annotation[]; options?: Operation }>) => {
  try {
    const { inspectDocument, writeAnnotations } = await engine;
    const request = event.data;
    const result = request.operation === 'operate'
      ? (await import('./operations.mjs')).operateDocument(request.bytes, request.options!, request.password)
      : request.operation === 'inspect'
      ? inspectDocument(request.bytes, request.password)
      : writeAnnotations(request.bytes, request.annotations || [], request.password);
    const buffer = result instanceof Uint8Array ? result.buffer : !Array.isArray(result) && 'previewBytes' in result ? result.previewBytes?.buffer : undefined;
    self.postMessage({ result }, { transfer: buffer ? [buffer] : [] });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'El motor PDF no pudo completar la operación.' }); }
};
