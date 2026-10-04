import { pdfAssetSettings } from './assets';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractText } from './engine/client';
import { getDocument } from './pdf';

export async function convertPdf(bytes: Uint8Array, pdf: PDFDocumentProxy, password: string | undefined, format: 'txt' | 'docx' | 'png', pages: number[], progress: (message: string) => void, signal: AbortSignal): Promise<Uint8Array> {
  if (format !== 'png') {
    const texts = await extractText(bytes, password, signal), selected = pages.map(p => texts[p - 1]); signal.throwIfAborted();
    if (format === 'txt') return new TextEncoder().encode(selected.join('\n\n\f\n\n'));
    const { Document, Paragraph, TextRun, Packer } = await import('docx');
    const document = new Document({ sections: selected.map(text => ({ children: text.split('\n').map(line => new Paragraph({ children: [new TextRun(line)] })) })) });
    return new Uint8Array(await (await Packer.toBlob(document)).arrayBuffer());
  }
  const { zipSync } = await import('fflate'), files: Record<string, Uint8Array> = {};
  if (pages.some(p => p < 1 || p > pdf.numPages)) throw new Error('Página inválida.');
  // Render the actual export bytes, which include current comments and edits.
  const loading = getDocument({ data: new Uint8Array(bytes), password, ...pdfAssetSettings() });
  const abort = () => { void loading.destroy(); }; signal.addEventListener('abort', abort, { once: true });
  try {
  const renderedPdf = await loading.promise;
  let total = 0;
  for (const number of pages) {
    signal.throwIfAborted(); progress(`Convirtiendo página ${number}`);
    const page = await renderedPdf.getPage(number), base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, Math.sqrt(16_000_000 / (base.width * base.height))) });
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    try {
      const rendering = page.render({ canvas, viewport });
      const cancel = () => rendering.cancel(); signal.addEventListener('abort', cancel, { once: true });
      try { await rendering.promise; } finally { signal.removeEventListener('abort', cancel); }
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('No se pudo crear la imagen.')), 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer()); total += bytes.length;
      if (total > 110 * 1024 * 1024) throw new Error('Las imágenes exceden 110 MiB. Exporta un intervalo menor.');
      files[`pagina-${String(number).padStart(4, '0')}.png`] = bytes;
    } finally { canvas.width = 0; canvas.height = 0; }
  }
  signal.throwIfAborted(); return zipSync(files, { level: 0 });
  } finally { signal.removeEventListener('abort', abort); await loading.destroy(); }
}

export async function createImagePdf(files: File[]): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib'), doc = await PDFDocument.create();
  if (!files.length) { doc.addPage([595, 842]); return doc.save(); }
  let total = 0;
  for (const file of files) {
    total += file.size; if (total > 80 * 1024 * 1024) throw new Error('Las imágenes exceden 80 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = file.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const landscape = image.width > image.height;
    const page = doc.addPage(landscape ? [842, 595] : [595, 842]);
    const scale = Math.min((page.getWidth() - 48) / image.width, (page.getHeight() - 48) / image.height);
    const width = image.width * scale, height = image.height * scale;
    page.drawImage(image, { x: (page.getWidth() - width) / 2, y: (page.getHeight() - height) / 2, width, height });
  }
  return doc.save();
}
