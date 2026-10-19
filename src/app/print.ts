import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfAssetSettings } from '../assets';
import { getDocument } from '../pdf';
import { isDesktop } from '../platform';

// The pages of the print in progress, removed once it is printed or replaced.
let cleanup: (() => void) | null = null;

/** Prints a PDF through the system dialog: its pages are drawn as images into a
 * print-only container (styled by `.print-document`), released after printing. */
export async function printRendered(data: Uint8Array, password: string | undefined, progress: (page: number, total: number) => void, ready: () => void) {
  cleanup?.();
  const container = document.createElement('div'); container.className = 'print-document'; document.body.append(container);
  const images: string[] = [];
  const release = cleanup = () => { container.remove(); images.forEach(url => URL.revokeObjectURL(url)); if (cleanup === release) cleanup = null; };
  let printable: PDFDocumentProxy | null = null;
  try {
    printable = await getDocument({ data, password, ...pdfAssetSettings() }).promise;
    let total = 0;
    for (let p = 1; p <= printable.numPages; p++) {
      progress(p, printable.numPages);
      // 200 ppp keeps text sharp on paper while each canvas stays within mobile limits.
      const pdfPage = await printable.getPage(p), size = pdfPage.getViewport({ scale: 1 }), viewport = pdfPage.getViewport({ scale: Math.min(200 / 72, 4096 / Math.max(size.width, size.height)) });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      try {
        await pdfPage.render({ canvas, viewport, intent: 'print' }).promise;
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
        if (!blob) throw new Error('No se pudo preparar la impresión.');
        total += blob.size; if (total > 300 * 1024 * 1024) throw new Error('El trabajo de impresión es demasiado grande. Extrae un intervalo de páginas para imprimirlo.');
        const image = document.createElement('img'); image.src = URL.createObjectURL(blob); images.push(image.src); image.alt = `Página ${p}`;
        const sheet = document.createElement('div'); sheet.className = 'print-sheet'; sheet.append(image); container.append(sheet); await image.decode();
      } finally { canvas.width = 0; canvas.height = 0; pdfPage.cleanup(); }
    }
    ready();
    window.addEventListener('afterprint', release, { once: true });
    if (isDesktop) { const { invoke } = await import('@tauri-apps/api/core'); await invoke('print_document'); }
    else window.print();
  } catch (error) { release(); throw error; }
  finally { await printable?.loadingTask.destroy(); }
}
