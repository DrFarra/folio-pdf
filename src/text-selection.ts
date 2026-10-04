import type { Annotation } from './types';

export type AnnotationDraft = Omit<Annotation, 'id' | 'created'>;
export type TextSelectionRequest = { range: Range; applied: boolean };
export type HighlightSelectionRequest = TextSelectionRequest & { annotations: AnnotationDraft[]; commit?: (annotations: AnnotationDraft[]) => void };

/** Resolve a caret from measured characters instead of Chromium's absolute-span gaps. */
export function textCaretAtPoint(x: number, y: number, start?: Element): Range | null {
  const eligible = (element: Element | null) => element?.closest('.textLayer[data-copy-allowed=true]') && element.closest('.page-content:is(.tool-select,.tool-highlight)');
  let span = (start || document.elementFromPoint(x, y))?.closest('span') as HTMLElement | null;
  if (!span || !eligible(span) || span.querySelector('span')) {
    span = null;
    let nearest = Infinity;
    for (const candidate of document.querySelectorAll<HTMLElement>('.page-content:is(.tool-select,.tool-highlight) .textLayer[data-copy-allowed=true] span')) {
      if (candidate.querySelector('span') || !candidate.textContent?.trim()) continue;
      const box = candidate.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const dx = Math.max(box.left - x, 0, x - box.right), dy = Math.max(box.top - y, 0, y - box.bottom);
      const distance = dx * dx + dy * dy;
      if (distance < nearest) { nearest = distance; span = candidate; }
    }
  }
  if (!span) return null;
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = []; while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const length = nodes.reduce((n, node) => n + node.length, 0);
  if (!length) return null;
  const character = (index: number) => {
    let offset = index;
    for (const node of nodes) {
      if (offset < node.length) {
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
        return { range, rect: range.getBoundingClientRect(), node, offset };
      }
      offset -= node.length;
    }
    return null;
  };
  const first = character(0)!, last = character(length - 1)!;
  let dx = (last.rect.left + last.rect.right - first.rect.left - first.rect.right) / 2;
  let dy = (last.rect.top + last.rect.bottom - first.rect.top - first.rect.bottom) / 2;
  if (length === 1 || Math.abs(dx) + Math.abs(dy) < .01) {
    const layer = span.closest('.textLayer')!;
    const angle = (Number(layer.getAttribute('data-main-rotation')) + parseFloat(getComputedStyle(span).getPropertyValue('--rotate') || '0')) * Math.PI / 180;
    dx = Math.cos(angle); dy = Math.sin(angle);
    if (span.dir === 'rtl') { dx *= -1; dy *= -1; }
  }
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  // A PDF text item is a line. Binary search its logical caret positions; RTL
  // items can mix logical directions, so inspect their individual characters.
  let closest = first;
  if (span.dir !== 'rtl' && length > 1) {
    const increasing = horizontal ? dx >= 0 : dy >= 0;
    const pointer = horizontal ? x : y;
    let low = 0, high = length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2), part = character(middle)!;
      const center = horizontal ? (part.rect.left + part.rect.right) / 2 : (part.rect.top + part.rect.bottom) / 2;
      if ((pointer > center) === increasing) low = middle + 1; else high = middle;
    }
    const candidates = [character(Math.max(0, low - 1))!, character(low)!];
    const distance = (part: typeof first) => Math.max(part.rect.left - x, 0, x - part.rect.right) ** 2 + Math.max(part.rect.top - y, 0, y - part.rect.bottom) ** 2;
    closest = candidates.sort((a, b) => distance(a) - distance(b))[0];
  } else if (length > 1) {
    let nearest = Infinity;
    for (let i = 0; i < length; i++) {
      const part = character(i)!;
      const distance = ((part.rect.left + part.rect.right) / 2 - x) ** 2 + ((part.rect.top + part.rect.bottom) / 2 - y) ** 2;
      if (distance < nearest) { nearest = distance; closest = part; }
    }
  }
  const center = horizontal ? (closest.rect.left + closest.rect.right) / 2 : (closest.rect.top + closest.rect.bottom) / 2;
  const after = ((horizontal ? x : y) > center) === (horizontal ? dx >= 0 : dy >= 0);
  const caret = document.createRange(); caret.setStart(closest.node, closest.offset + (after ? 1 : 0)); caret.collapse(true);
  return caret;
}

/** Apply the current text selection through the existing highlight action. */
export function highlightSelection(): boolean {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0).cloneRange();
  const textLayer = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest('.textLayer');
  if (!textLayer(range.startContainer) || !textLayer(range.endContainer)) return false;
  const request: HighlightSelectionRequest = { range, applied: false, annotations: [] };
  window.dispatchEvent(new CustomEvent<HighlightSelectionRequest>('folio:highlight-selection', { detail: request }));
  if (request.annotations.length) request.commit?.(request.annotations);
  if (request.applied) selection.removeAllRanges();
  return request.applied;
}

/** Anchor a comment to the first selected character through the normal note editor. */
export function commentSelection(): boolean {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0).cloneRange();
  const layer = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest('.textLayer[data-copy-allowed=true]');
  if (!layer(range.startContainer) || !layer(range.endContainer)) return false;
  const request: TextSelectionRequest = { range, applied: false };
  window.dispatchEvent(new CustomEvent<TextSelectionRequest>('folio:comment-selection', { detail: request }));
  if (request.applied) selection.removeAllRanges();
  return request.applied;
}

/** Clip a selection to this page and measure text nodes, excluding search-mark wrappers. */
export function selectedTextRects(container: HTMLElement, original: Range): { text: string; rects: DOMRect[]; angles: number[] } | null {
  if (!original.intersectsNode(container)) return null;
  const boundary = document.createRange();
  boundary.selectNodeContents(container);
  const range = original.cloneRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, boundary) < 0) range.setStart(boundary.startContainer, boundary.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, boundary) > 0) range.setEnd(boundary.endContainer, boundary.endOffset);
  if (range.collapsed || !range.toString().trim()) return null;
  const fragments: { rect: DOMRect; vertical: boolean; angle: number }[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const mainRotation = Number(container.dataset.mainRotation || 0);
  const angles = new Map<Element, number>();
  while (walker.nextNode() && fragments.length < 5000) {
    const node = walker.currentNode;
    if (!range.intersectsNode(node)) continue;
    const part = document.createRange();
    part.selectNodeContents(node);
    if (part.compareBoundaryPoints(Range.START_TO_START, range) < 0) part.setStart(range.startContainer, range.startOffset);
    if (part.compareBoundaryPoints(Range.END_TO_END, range) > 0) part.setEnd(range.endContainer, range.endOffset);
    if (part.collapsed || !part.toString()) continue;
    const span = node.parentElement?.closest('span');
    if (span && !angles.has(span)) angles.set(span, ((mainRotation + parseFloat(getComputedStyle(span).getPropertyValue('--rotate') || '0')) % 360 + 360) % 360);
    const angle = span ? angles.get(span)! : mainRotation;
    for (const rect of part.getClientRects()) if (rect.width > .5 && rect.height > .5) fragments.push({ rect, vertical: angle % 180 > 45 && angle % 180 < 135, angle });
  }
  const runs = mergeTextLineRects(fragments);
  return runs.length ? { text: range.toString().slice(0, 5000), rects: runs.map(run => run.rect), angles: runs.map(run => run.angle) } : null;
}

/** Close word/search-wrapper gaps on one line, leaving columns and line spacing clear. */
function mergeTextLineRects(fragments: { rect: DOMRect; vertical: boolean; angle: number }[]): typeof fragments {
  const cross = (rect: DOMRect, vertical: boolean) => vertical ? [rect.left, rect.right] : [rect.top, rect.bottom];
  const inline = (rect: DOMRect, vertical: boolean) => vertical ? [rect.top, rect.bottom] : [rect.left, rect.right];
  fragments.sort((a, b) => Number(a.vertical) - Number(b.vertical) ||
    cross(a.rect, a.vertical).reduce((sum, n) => sum + n) - cross(b.rect, b.vertical).reduce((sum, n) => sum + n) ||
    inline(a.rect, a.vertical)[0] - inline(b.rect, b.vertical)[0]);
  const runs: typeof fragments = [];
  for (const fragment of fragments) {
    const { rect, vertical, angle } = fragment;
    const [start, end] = cross(rect, vertical), size = end - start;
    const [left, right] = inline(rect, vertical);
    // DOM rectangles bound oblique text; joining those would fill outside its ink.
    const cardinal = Math.abs(angle - Math.round(angle / 90) * 90) < 1;
    let merged = false;
    for (let i = runs.length - 1; cardinal && i >= Math.max(0, runs.length - 32); i--) {
      const run = runs[i];
      if (run.vertical !== vertical || Math.abs(run.angle - angle) > 1) continue;
      const [runStart, runEnd] = cross(run.rect, vertical), minSize = Math.min(size, runEnd - runStart);
      if (Math.abs(start + end - runStart - runEnd) > minSize * .5 ||
          Math.min(end, runEnd) - Math.max(start, runStart) < minSize * .7) continue;
      const [runLeft, runRight] = inline(run.rect, vertical);
      // A normal inter-word gap is at most about one text height. Wider gaps
      // usually separate columns or table cells, which must keep separate quads.
      if (Math.max(left - runRight, runLeft - right) > minSize) continue;
      run.rect = new DOMRect(Math.min(rect.left, run.rect.left), Math.min(rect.top, run.rect.top),
        Math.max(rect.right, run.rect.right) - Math.min(rect.left, run.rect.left),
        Math.max(rect.bottom, run.rect.bottom) - Math.min(rect.top, run.rect.top));
      merged = true;
      break;
    }
    if (!merged) runs.push(fragment);
  }
  return runs;
}
