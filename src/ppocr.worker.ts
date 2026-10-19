// A worker of Folio's OCR engine. With WebGPU one worker reads whole pages on the
// graphics card, lines in batches. Without it several workers share the work: the first
// finds a page's lines and cuts them out, then every worker reads a share of them.
import * as ort from 'onnxruntime-web/webgpu';
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { PaddleOcr, fitWords, type Found, type Options, type Pixels, type Prepared, type Read } from './ppocr';

ort.env.wasm.wasmPaths = { wasm };
// Threads need a cross-origin isolated page, which Folio is not: it runs several workers instead.
ort.env.wasm.numThreads = 1;

export type Job =
  | { job: 'probe' }
  | { job: 'lines'; image: Pixels }
  | { job: 'read'; lines: Prepared[] }
  | { job: 'fit'; found: Found[]; read: Read[] };
export type Request = { id: number; base: string; gpu: boolean } & Job;
let finder: Promise<PaddleOcr> | null = null,
  reader: Promise<PaddleOcr> | null = null;
// The page this worker found lines in, kept to fit the words to its ink once they are read.
let page: Pixels | null = null;
const model = async (base: string, name: string) => {
  const response = await fetch(new URL(name, base));
  if (!response.ok) throw new Error(`No se pudo cargar el modelo de OCR ${name}.`);
  return new Uint8Array(await response.arrayBuffer());
};
const dictionary = async (base: string) => (await fetch(new URL('dict-latin.txt', base))).text();
// On the graphics card when there is one; a model it cannot run there stays on the processor.
const engine = async (models: Parameters<typeof PaddleOcr.create>[1], gpu: boolean) => {
  const cpu: Options = { providers: ['wasm'], batch: 1 };
  if (!gpu) return PaddleOcr.create(ort, models, cpu);
  try {
    return await PaddleOcr.create(ort, models, { providers: ['webgpu'], batch: 8 });
  } catch {
    return PaddleOcr.create(ort, models, cpu);
  }
};
const hasGpu = async () => {
  try {
    return !!(await (
      navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }
    ).gpu?.requestAdapter());
  } catch {
    return false;
  }
};

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    if (data.job === 'probe') postMessage({ id: data.id, gpu: await hasGpu() });
    else if (data.job === 'lines') {
      finder ??= Promise.all([model(data.base, 'det.onnx'), model(data.base, 'cls.onnx'), dictionary(data.base)]).then(
        ([det, cls, dict]) => engine({ det, cls, dict }, data.gpu),
      );
      page = data.image;
      const found = await (await finder).lines(data.image),
        lines = found.map(line => PaddleOcr.cut(data.image, line));
      postMessage({ id: data.id, found, lines }, { transfer: lines.map(line => line.input.buffer) });
    } else if (data.job === 'fit') {
      postMessage({ id: data.id, read: page ? fitWords(page, data.found, data.read) : data.read });
      page = null;
    } else {
      reader ??= Promise.all([model(data.base, 'rec-latin.onnx'), dictionary(data.base)]).then(([rec, dict]) =>
        engine({ rec, dict }, data.gpu),
      );
      postMessage({ id: data.id, read: await (await reader).read(data.lines) });
    }
  } catch (error) {
    postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
