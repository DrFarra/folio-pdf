import { pdfAssetSettings } from './assets';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractText } from './engine/client';
import { jpegOrientation, orientationMatrix } from './engine/jpeg-orientation.mjs';
import { getDocument } from './pdf';

export type ConversionFormat = 'txt' | 'docx' | 'png';
export type ConversionScope = 'current' | 'all' | 'range';
export type PngExportOptions = { dpi: 72 | 144 | 200 | 300; background: 'white' | 'transparent' };
export const DEFAULT_PNG_EXPORT_OPTIONS: PngExportOptions = { dpi: 144, background: 'white' };
export const PNG_EXPORT_LIMITS = { pixelsPerPage: 16_000_000, dimension: 16_384, archiveBytes: 110 * 1024 * 1024, pages: 10_000 } as const;

function pageCount(totalPages: number) {
  if (!Number.isSafeInteger(totalPages) || totalPages < 1) throw new Error('El documento no contiene páginas válidas.');
}

/** All conversion formats use the same validated page selection and order. */
export function validateExportPages(pages: number[], totalPages: number): number[] {
  pageCount(totalPages);
  if (!Array.isArray(pages) || !pages.length) throw new Error('Selecciona al menos una página para exportar.');
  if (pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > totalPages)) throw new Error('La selección contiene páginas que no existen.');
  const unique = [...new Set(pages)];
  if (unique.length > PNG_EXPORT_LIMITS.pages) throw new Error(`Exporta como máximo ${PNG_EXPORT_LIMITS.pages.toLocaleString('es')} páginas por trabajo.`);
  return unique;
}

export function parsePageRange(range: string, totalPages: number): number[] {
  pageCount(totalPages);
  if (typeof range !== 'string' || !range.trim()) throw new Error('Escribe las páginas que quieres exportar, por ejemplo 1-3, 6.');
  if (range.length > 50_000) throw new Error('El intervalo es demasiado largo. Divide la exportación en varios trabajos.');
  const pages = new Set<number>();
  for (const token of range.split(',')) {
    const match = token.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('Intervalo inválido. Usa por ejemplo 1-3, 6.');
    const first = Number(match[1]), last = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last > totalPages) throw new Error('El intervalo contiene páginas que no existen.');
    if (last < first) throw new Error('El inicio de cada intervalo debe ser menor o igual que su final.');
    if (last - first + 1 > PNG_EXPORT_LIMITS.pages) throw new Error(`Exporta como máximo ${PNG_EXPORT_LIMITS.pages.toLocaleString('es')} páginas por trabajo.`);
    for (let page = first; page <= last; page++) {
      pages.add(page);
      if (pages.size > PNG_EXPORT_LIMITS.pages) throw new Error(`Exporta como máximo ${PNG_EXPORT_LIMITS.pages.toLocaleString('es')} páginas por trabajo.`);
    }
  }
  return validateExportPages([...pages], totalPages);
}

export function conversionPages(scope: ConversionScope, range: string, currentPage: number, totalPages: number): number[] {
  pageCount(totalPages);
  if (scope === 'current') return validateExportPages([currentPage], totalPages);
  if (scope === 'range') return parsePageRange(range, totalPages);
  if (scope !== 'all') throw new Error('Alcance de exportación inválido.');
  if (totalPages > PNG_EXPORT_LIMITS.pages) throw new Error(`Exporta como máximo ${PNG_EXPORT_LIMITS.pages.toLocaleString('es')} páginas por trabajo.`);
  return Array.from({ length: totalPages }, (_, index) => index + 1);
}

function pngOptions(options?: PngExportOptions): PngExportOptions {
  const value = { ...DEFAULT_PNG_EXPORT_OPTIONS, ...options };
  if (![72, 144, 200, 300].includes(value.dpi)) throw new Error('Elige una resolución de 72, 144, 200 o 300 ppp.');
  if (value.background !== 'white' && value.background !== 'transparent') throw new Error('Elige fondo blanco o transparente.');
  return value;
}

export function pngPageDimensions(widthPoints: number, heightPoints: number, dpi: PngExportOptions['dpi']) {
  pngOptions({ dpi, background: 'white' });
  if (![widthPoints, heightPoints].every(value => Number.isFinite(value) && value > 0)) throw new Error('La página no tiene un tamaño válido.');
  const scale = dpi / 72, width = Math.ceil(widthPoints * scale), height = Math.ceil(heightPoints * scale);
  if (width > PNG_EXPORT_LIMITS.dimension || height > PNG_EXPORT_LIMITS.dimension || width * height > PNG_EXPORT_LIMITS.pixelsPerPage) {
    throw new Error(`La página requiere ${width.toLocaleString('es')} × ${height.toLocaleString('es')} píxeles a ${dpi} ppp. El límite es 16 millones de píxeles y ${PNG_EXPORT_LIMITS.dimension.toLocaleString('es')} píxeles por lado. Elige una resolución menor.`);
  }
  return { width, height, scale, rgbaBytes: width * height * 4 };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

// Canvas serialization uses 96 dpi. Store the requested density without
// changing pixels or discarding the PNG's color profile and other chunks.
function pngResolution(bytes: Uint8Array, dpi: number): Uint8Array {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error('No se pudo codificar la imagen PNG.');
  const physical = new Uint8Array(21), view = new DataView(physical.buffer);
  view.setUint32(0, 9); physical.set([112, 72, 89, 115], 4);
  const perMeter = Math.round(dpi / .0254);
  view.setUint32(8, perMeter); view.setUint32(12, perMeter); physical[16] = 1;
  view.setUint32(17, crc32(physical.subarray(4, 17)));
  const parts = [bytes.subarray(0, 8)], input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, header = false, end = false;
  while (offset + 12 <= bytes.length) {
    const length = input.getUint32(offset), next = offset + length + 12;
    if (next > bytes.length) throw new Error('No se pudo codificar la imagen PNG.');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type !== 'pHYs') parts.push(bytes.subarray(offset, next));
    if (type === 'IHDR') { parts.push(physical); header = true; }
    offset = next;
    if (type === 'IEND') { end = true; break; }
  }
  if (!header || !end || offset !== bytes.length) throw new Error('No se pudo codificar la imagen PNG.');
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let position = 0;
  for (const part of parts) { result.set(part, position); position += part.length; }
  return result;
}

function canvasPng(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Operación cancelada', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    const finish = (blob: Blob | null) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { abort(); return; }
      blob ? resolve(blob) : reject(new Error('No se pudo crear la imagen. Elige una resolución menor.'));
    };
    try { canvas.toBlob(finish, 'image/png'); }
    catch (error) { signal.removeEventListener('abort', abort); reject(error); }
  });
}

export async function convertPdf(bytes: Uint8Array, pdf: PDFDocumentProxy, password: string | undefined, format: ConversionFormat, pages: number[], progress: (message: string) => void, signal: AbortSignal, options?: PngExportOptions): Promise<Uint8Array> {
  signal.throwIfAborted();
  const selection = validateExportPages(pages, pdf.numPages);
  if (!['txt', 'docx', 'png'].includes(format)) throw new Error('Formato de exportación inválido.');
  if (format !== 'png') {
    progress(`Extrayendo texto de ${selection.length} ${selection.length === 1 ? 'página' : 'páginas'}…`);
    const texts = await extractText(bytes, password, signal), selected = selection.map(page => texts[page - 1]); signal.throwIfAborted();
    if (selected.some(text => typeof text !== 'string')) throw new Error('El archivo no contiene todas las páginas seleccionadas.');
    if (format === 'txt') return new TextEncoder().encode(selected.join('\n\n\f\n\n'));
    const { Document, Paragraph, TextRun, Packer } = await import('docx'); signal.throwIfAborted();
    progress('Preparando Word…'); signal.throwIfAborted();
    // MuPDF separates text blocks with a blank line. Each block becomes one
    // reflowable paragraph; a line-end hyphen before a lowercase letter is a break.
    const paragraphs = selected.flatMap((text, page) => {
      const blocks = text.split(/\n[ \t]*\n/).map(block => block.trim()).filter(Boolean);
      return (blocks.length ? blocks : ['']).map((block, index) => new Paragraph({
        pageBreakBefore: page > 0 && index === 0,
        children: [new TextRun(block.replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1').replace(/\s*\n\s*/g, ' '))],
      }));
    });
    const document = new Document({ sections: [{ children: paragraphs }] });
    const output = new Uint8Array(await (await Packer.toBlob(document)).arrayBuffer());
    signal.throwIfAborted(); return output;
  }
  const settings = pngOptions(options), { Zip, ZipPassThrough } = await import('fflate');
  signal.throwIfAborted();
  // Render the actual export bytes, which include current comments and edits.
  const loading = getDocument({ data: new Uint8Array(bytes), password, ...pdfAssetSettings() });
  let archive: InstanceType<typeof Zip> | undefined;
  const abort = () => { archive?.terminate(); void loading.destroy(); }; signal.addEventListener('abort', abort, { once: true });
  try {
    const renderedPdf = await loading.promise; signal.throwIfAborted();
    validateExportPages(selection, renderedPdf.numPages);
    const plans = [];
    for (const number of selection) {
      signal.throwIfAborted(); progress(`Comprobando página ${number}…`); signal.throwIfAborted();
      const page = await renderedPdf.getPage(number), base = page.getViewport({ scale: 1 });
      try { plans.push({ number, ...pngPageDimensions(base.width, base.height, settings.dpi) }); }
      catch (error) { throw new Error(`Página ${number}: ${(error as Error).message}`); }
    }
    // Check archive limits while streaming pages. The completed chunks are
    // assembled once into the contiguous byte array required by saveExport.
    const chunks: Uint8Array[] = [];
    let archiveBytes = 0, archiveError: Error | null = null;
    archive = new Zip((error, chunk) => {
      if (error) { archiveError = error; return; }
      archiveBytes += chunk.length;
      if (archiveBytes > PNG_EXPORT_LIMITS.archiveBytes) {
        archiveError = new Error('El ZIP supera 110 MB. Elige menos páginas o una resolución menor.');
        archive?.terminate(); return;
      }
      chunks.push(chunk);
    });
    for (let index = 0; index < plans.length; index++) {
      const plan = plans[index]; signal.throwIfAborted();
      progress(`Convirtiendo página ${plan.number} (${index + 1} de ${plans.length}) a ${settings.dpi} ppp…`);
      signal.throwIfAborted();
      const page = await renderedPdf.getPage(plan.number), viewport = page.getViewport({ scale: plan.scale });
      const canvas = document.createElement('canvas'); canvas.width = plan.width; canvas.height = plan.height;
    try {
      const canvasContext = canvas.getContext('2d', { alpha: settings.background === 'transparent' });
      if (!canvasContext) throw new Error('No se pudo preparar la imagen. Elige una resolución menor.');
      const rendering = page.render({ canvas, canvasContext, viewport, background: settings.background === 'transparent' ? 'rgba(0,0,0,0)' : '#ffffff' });
      const cancel = () => rendering.cancel(); signal.addEventListener('abort', cancel, { once: true });
      try { await rendering.promise; } finally { signal.removeEventListener('abort', cancel); }
      signal.throwIfAborted();
      const blob = await canvasPng(canvas, signal);
      const encoded = pngResolution(new Uint8Array(await blob.arrayBuffer()), settings.dpi);
      signal.throwIfAborted();
      const entry = new ZipPassThrough(`pagina-${String(plan.number).padStart(4, '0')}.png`);
      archive.add(entry); entry.push(encoded, true);
      if (archiveError) throw archiveError;
    } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); }
    }
    signal.throwIfAborted(); progress('Preparando ZIP…'); signal.throwIfAborted(); archive.end();
    if (archiveError) throw archiveError;
    signal.throwIfAborted();
    const output = new Uint8Array(archiveBytes);
    let position = 0;
    for (const chunk of chunks) { output.set(chunk, position); position += chunk.length; }
    signal.throwIfAborted(); return output;
  } catch (error) { signal.throwIfAborted(); throw error; }
  finally { archive?.terminate(); signal.removeEventListener('abort', abort); await loading.destroy(); }
}

export async function createImagePdf(files: File[]): Promise<Uint8Array> {
  const { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = await import('pdf-lib'), doc = await PDFDocument.create();
  if (!files.length) { doc.addPage([595, 842]); return doc.save(); }
  let total = 0;
  for (const file of files) {
    total += file.size; if (total > 80 * 1024 * 1024) throw new Error('Las imágenes superan 80 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    // System pickers may report an empty or generic type; the signature decides.
    const png = [0x89, 0x50, 0x4e, 0x47].every((value, index) => bytes[index] === value), jpeg = [0xff, 0xd8, 0xff].every((value, index) => bytes[index] === value);
    if (!png && !jpeg) throw new Error('Solo se admiten imágenes PNG o JPEG.');
    let image;
    try { image = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes); }
    catch { throw new Error(`No se pudo leer la imagen «${file.name}».`); }
    // Camera photos keep the orientation the gallery shows; PDF viewers ignore EXIF.
    const orientation = jpeg ? jpegOrientation(bytes) : 1, turned = orientation >= 5;
    const imageWidth = turned ? image.height : image.width, imageHeight = turned ? image.width : image.height;
    const page = doc.addPage(imageWidth > imageHeight ? [842, 595] : [595, 842]);
    const scale = Math.min((page.getWidth() - 48) / imageWidth, (page.getHeight() - 48) / imageHeight);
    const width = imageWidth * scale, height = imageHeight * scale, x = (page.getWidth() - width) / 2, y = (page.getHeight() - height) / 2;
    if (orientation === 1) { page.drawImage(image, { x, y, width, height }); continue; }
    // orientationMatrix uses y-down image space; conjugating it with a vertical
    // flip gives the same mapping in PDF's y-up image space.
    const [a, b, c, d, e, f] = orientationMatrix(orientation);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(width, 0, 0, height, x, y), concatTransformationMatrix(a, -b, -c, d, c + e, 1 - d - f), drawObject(page.node.newXObject('Image', image.ref)), popGraphicsState());
  }
  return doc.save();
}
