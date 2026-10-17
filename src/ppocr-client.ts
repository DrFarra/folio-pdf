// Folio's OCR engine in workers. With WebGPU one worker reads on the graphics card;
// without it a few workers read a page's lines in parallel (WebAssembly runs one
// thread per worker here).
import { assemble, type Found, type OcrLine, type Pixels, type Prepared, type Read } from './ppocr';
import { assetUrl } from './assets';
import type { Job } from './ppocr.worker';

export class OcrEngine {
  private workers: Worker[] = [];
  private calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private next = 0;
  private base = assetUrl('/ocr/ppocr/');
  private ready: Promise<boolean> | null = null;

  private spawn() {
    const worker = new Worker(new URL('./ppocr.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const call = this.calls.get(data.id); if (!call) return;
      this.calls.delete(data.id);
      if (data.error) call.reject(new Error(data.error)); else call.resolve(data);
    };
    worker.onerror = event => { for (const call of this.calls.values()) call.reject(new Error(event.message || 'El motor de OCR se detuvo.')); this.calls.clear(); };
    this.workers.push(worker);
    return worker;
  }

  private call<T>(worker: Worker, request: Job, transfer: Transferable[] = []): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => { this.calls.set(id, { resolve, reject }); worker.postMessage({ ...request, id, base: this.base, gpu: this.gpu }, transfer); });
  }
  private gpu = false;

  /** One worker on the graphics card, or up to four on the processor. */
  private start() {
    return this.ready ??= this.call<{ gpu: boolean }>(this.spawn(), { job: 'probe' }).then(({ gpu }) => {
      this.gpu = gpu;
      if (!gpu) for (let i = 1; i < Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)); i++) this.spawn();
      return gpu;
    });
  }

  /** A page's text lines in reading order, with word and letter positions in its pixels. */
  async recognize(image: Pixels & { data: Uint8ClampedArray }, signal?: AbortSignal): Promise<OcrLine[]> {
    const abort = () => { for (const call of this.calls.values()) call.reject(new DOMException('Operación cancelada', 'AbortError')); this.calls.clear(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.start();
      // The page goes to the first worker whole (transferred, not copied).
      const { found, lines } = await this.call<{ found: Found[]; lines: Prepared[] }>(this.workers[0], { job: 'lines', image }, [image.data.buffer]);
      // Each worker gets about the same total width of lines to read.
      const shares: number[][] = this.workers.map(() => []), load = this.workers.map(() => 0);
      lines.map((line, i) => ({ i, width: line.width })).sort((a, b) => b.width - a.width).forEach(({ i, width }) => {
        const k = load.indexOf(Math.min(...load)); shares[k].push(i); load[k] += width;
      });
      const parts = await Promise.all(shares.map((share, k) => share.length
        ? this.call<{ read: Read[] }>(this.workers[k], { job: 'read', lines: share.map(i => lines[i]) }, share.map(i => lines[i].input.buffer))
        : Promise.resolve({ read: [] })));
      const read: Read[] = [];
      shares.forEach((share, k) => share.forEach((i, j) => { read[i] = parts[k].read[j]; }));
      const { read: fitted } = await this.call<{ read: Read[] }>(this.workers[0], { job: 'fit', found, read });
      return assemble(found, fitted);
    } finally { signal?.removeEventListener('abort', abort); }
  }

  terminate() { for (const worker of this.workers) worker.terminate(); this.workers = []; this.calls.clear(); this.ready = null; }
}
