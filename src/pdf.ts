import './stream-compat';
import { GlobalWorkerOptions, getDocument, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { OutlineEntry, SearchResult, PDFNavigationTarget } from './types';

GlobalWorkerOptions.workerSrc = workerUrl;
export { getDocument, TextLayer };

/** Leaves out of PDF.js's rendering the annotations Folio draws itself, by their
 * PDF.js ids. PDF.js skips the ids its editors report as modified; Folio reports
 * these instead of rewriting a large PDF to remove them. */
export function hideAnnotations(pdf: PDFDocumentProxy, ids: string[]) {
  if (!ids.length) return;
  const modified = { ids: new Set(ids), hash: `folio:${ids.join(',')}` };
  Object.defineProperty(pdf.annotationStorage, 'modifiedIds', { configurable: true, get: () => modified });
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toLocaleString('es', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
export const plural = (count: number, one: string, many: string) => `${count.toLocaleString('es')} ${count === 1 ? one : many}`;

export function downloadBytes(bytes: Uint8Array, name: string): void {
  const blob = new Blob([new Uint8Array(bytes).buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}

// One request per document: switching tabs reuses the same entries (and the
// outline's folded chapters) instead of resolving every destination again.
const outlineRequests = new WeakMap<PDFDocumentProxy, Promise<OutlineEntry[]>>();
export function readOutline(pdf: PDFDocumentProxy): Promise<OutlineEntry[]> {
  let request = outlineRequests.get(pdf);
  if (!request) {
    request = pdf.getOutline().then(outline => {
      const items: { item: NonNullable<typeof outline>[number]; depth: number }[] = [];
      const walk = (level: NonNullable<typeof outline>, depth = 0) => { for (const item of level) { items.push({ item, depth }); if (item.items?.length) walk(item.items, depth + 1); } };
      if (outline) walk(outline);
      // A PDF outline heading can group chapters without having a destination.
      // Keep it in the tree; inventing a page would misrepresent the document.
      return Promise.all(items.map(async ({ item, depth }) => {
        const destination = await resolvePDFDestination(pdf, item.dest);
        return { title: item.title, page: destination && 'page' in destination ? destination.page : null, depth };
      }));
    });
    outlineRequests.set(pdf, request);
    request.catch(() => { if (outlineRequests.get(pdf) === request) outlineRequests.delete(pdf); });
  }
  return request;
}

export const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');

/** Shared extraction model for indexing and the DOM text layer. It keeps the
 * original UTF-16 offsets while joining PDF chunks at their actual word gaps. */
export function pageTextModel(content: Pick<TextContent, 'items'>): { text: string; segments: { text: string; start: number; end: number }[] } {
  const items = content.items.filter((item): item is TextItem => 'str' in item);
  const segments: { text: string; start: number; end: number }[] = [];
  let text = '';
  for (let index = 0; index < items.length; index++) {
    const item = items[index], next = items[index + 1];
    segments.push({ text: item.str, start: text.length, end: text.length + item.str.length });
    text += item.str;
    if (!next) continue;
    if (item.hasEOL) { text += '\n'; continue; }
    if (/\s$/.test(item.str) || /^\s/.test(next.str) || !item.str) continue;
    const transform = item.transform, other = next.transform;
    if (!transform?.length || !other?.length) { text += ' '; continue; }
    const angle = Math.atan2(transform[1], transform[0]);
    const dx = other[4] - transform[4], dy = other[5] - transform[5];
    const lineGap = Math.abs(-Math.sin(angle) * dx + Math.cos(angle) * dy);
    const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]));
    const advance = Math.cos(angle) * dx + Math.sin(angle) * dy;
    const gap = item.dir === 'rtl' ? Math.abs(advance) - item.width : advance - item.width;
    if (lineGap > fontHeight * .5) text += '\n';
    else if (gap > fontHeight * .12) text += ' ';
  }
  return { text, segments };
}

export const pageText = (content: Pick<TextContent, 'items'>) => pageTextModel(content).text;

function normalizedOffsets(text: string) {
  let folded = '';
  const starts: number[] = [], ends: number[] = [];
  let offset = 0;
  for (const character of text) {
    const end = offset + character.length;
    // ASCII needs no decomposition; skipping normalize() keeps long pages fast.
    const normalized = /\s/.test(character) ? ' ' : character < '\x80' ? character.toLowerCase() : normalize(character);
    if (!normalized) { if (ends.length) ends[ends.length - 1] = end; }
    else if (normalized === ' ' && folded.endsWith(' ')) ends[ends.length - 1] = end;
    else for (let index = 0; index < normalized.length; index++) { folded += normalized[index]; starts.push(offset); ends.push(end); }
    offset = end;
  }
  return { text: folded, starts, ends };
}

export function findTextMatches(text: string, query: string): { start: number; end: number }[] {
  const term = normalizedOffsets(query.trim()).text;
  if (!term) return [];
  const normalized = normalizedOffsets(text), matches: { start: number; end: number }[] = [];
  let offset = 0;
  while ((offset = normalized.text.indexOf(term, offset)) !== -1) {
    matches.push({ start: normalized.starts[offset], end: normalized.ends[offset + term.length - 1] });
    offset += term.length;
  }
  return matches;
}

// Folded page text keyed by its content, so each keystroke and each partial
// index of the same document reuse it. Bounded to release closed documents.
const foldedPages = new Map<string, string>();
function foldedPage(text: string) {
  let folded = foldedPages.get(text);
  if (folded === undefined) {
    foldedPages.set(text, folded = normalizedOffsets(text).text);
    if (foldedPages.size > 4000) foldedPages.delete(foldedPages.keys().next().value!);
  }
  return folded;
}

/** Counts every occurrence but builds at most `limit` results, so a frequent
 * term in a long document never produces thousands of entries. */
export function searchText(texts: string[], query: string, limit = Infinity): { results: SearchResult[]; total: number } {
  const term = normalizedOffsets(query.trim()).text, results: SearchResult[] = [];
  let total = 0;
  if (!term) return { results, total };
  texts.forEach((text, index) => {
    const folded = foldedPage(text);
    let found = 0;
    for (let offset = folded.indexOf(term); offset !== -1; offset = folded.indexOf(term, offset + term.length)) found++;
    total += found;
    if (!found || results.length >= limit) return;
    for (const match of findTextMatches(text, query).slice(0, limit - results.length)) {
      const start = Math.max(0, match.start - 32), end = Math.min(text.length, match.end + 90);
      results.push({ page: index + 1, count: 1, offset: match.start, index: results.length, text: `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}` });
    }
  });
  return { results, total };
}

const labelRequests = new WeakMap<PDFDocumentProxy, Promise<string[] | null>>();
export function readPageLabels(pdf: PDFDocumentProxy): Promise<string[] | null> {
  let request = labelRequests.get(pdf);
  if (!request) {
    request = typeof pdf.getPageLabels === 'function' ? pdf.getPageLabels().then(labels => labels?.length === pdf.numPages ? labels : null).catch(() => null) : Promise.resolve(null);
    labelRequests.set(pdf, request);
  }
  return request;
}
export async function readPageLabel(pdf: PDFDocumentProxy, number: number): Promise<string> {
  const labels = await readPageLabels(pdf);
  if (labels) return labels[number - 1] || String(number);
  const page = await pdf.getPage(number) as PDFPageProxy & { label?: string };
  return page.label || String(number);
}

/** Resolve PDF destinations without conflating a zero-based PDF reference with
 * the one-based page numbers used by reader navigation. */
export async function resolvePDFDestination(pdf: PDFDocumentProxy, destination: unknown): Promise<PDFNavigationTarget | null> {
  try {
    const dest = typeof destination === 'string' ? await pdf.getDestination(destination) : destination;
    if (!Array.isArray(dest) || dest[0] == null) return null;
    const index = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
    if (!Number.isInteger(index) || index < 0 || index >= pdf.numPages) return null;
    const target: { page: number; left?: number; top?: number } = { page: index + 1 };
    if (dest[1]?.name === 'XYZ') { if (Number.isFinite(dest[2])) target.left = dest[2]; if (Number.isFinite(dest[3])) target.top = dest[3]; }
    else if (['FitH', 'FitBH'].includes(dest[1]?.name) && Number.isFinite(dest[2])) target.top = dest[2];
    else if (['FitV', 'FitBV'].includes(dest[1]?.name) && Number.isFinite(dest[2])) target.left = dest[2];
    return target;
  } catch { return null; }
}

export function safePDFLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

export { exportAnnotated } from './engine/client';
