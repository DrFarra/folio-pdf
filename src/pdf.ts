import './stream-compat';
import { GlobalWorkerOptions, getDocument, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { OutlineEntry, SearchResult } from './types';

GlobalWorkerOptions.workerSrc = workerUrl;
export { getDocument, TextLayer };

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function downloadBytes(bytes: Uint8Array, name: string): void {
  const blob = new Blob([new Uint8Array(bytes).buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}

export async function readOutline(pdf: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const outline = await pdf.getOutline();
  const entries: OutlineEntry[] = [];
  async function walk(items: NonNullable<typeof outline>, depth = 0) {
    for (const item of items) {
      try {
        const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        if (dest?.[0] != null) {
          const index = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
          entries.push({ title: item.title, page: index + 1, depth });
        }
      } catch { /* An invalid destination must not stop other entries. */ }
      if (item.items?.length) await walk(item.items, depth + 1);
    }
  }
  if (outline) await walk(outline);
  return entries;
}

export async function buildTextIndex(pdf: PDFDocumentProxy, alive: () => boolean): Promise<string[]> {
  const texts: string[] = [];
  for (let p = 1; p <= pdf.numPages && alive(); p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    texts.push(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''));
  }
  return texts;
}

export const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');

export function searchText(texts: string[], query: string): SearchResult[] {
  const term = normalize(query.trim());
  if (!term) return [];
  return texts.flatMap((text, index) => {
    const normalized = normalize(text);
    let offset = 0;
    let count = 0;
    let first = -1;
    while ((offset = normalized.indexOf(term, offset)) !== -1) {
      if (first === -1) first = offset;
      count++;
      offset += term.length;
    }
    if (!count) return [];
    const start = Math.max(0, first - 32);
    return [{ page: index + 1, count, text: `${start ? '…' : ''}${text.slice(start, first + term.length + 90).replace(/\s+/g, ' ')}…` }];
  });
}

export { exportAnnotated } from './engine/client';
