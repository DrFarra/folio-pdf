import type { Annotation } from './types';

type Box = { x1: number; y1: number; x2: number; y2: number };
// Folio writes upright quads as top-left, top-right, bottom-left, bottom-right in PDF space.
const upright = (quad: number[]) => quad.length === 8 && quad[1] === quad[3] && quad[5] === quad[7] && quad[0] === quad[4] && quad[2] === quad[6] && quad[1] > quad[5] && quad[2] > quad[0];
const box = (quad: number[]): Box => ({ x1: quad[0], y1: quad[5], x2: quad[2], y2: quad[1] });
const quad = (b: Box) => [b.x1, b.y2, b.x2, b.y2, b.x1, b.y1, b.x2, b.y1];
const height = (b: Box) => b.y2 - b.y1;
const sameLine = (a: Box, b: Box) => Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > Math.min(height(a), height(b)) * .5;
const touching = (a: Box, b: Box) => sameLine(a, b) && Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2) < Math.min(height(a), height(b)) * .4;

/** Only highlights made in Folio with upright quads are merged; ones read
 * from the PDF keep their identity so saving never rewrites the original's. */
function mergeable(annotation: Annotation) {
  return annotation.kind === 'highlight' && !annotation.sourceRef && !annotation.nativeSourceRef && !annotation.originalName && !!annotation.quads?.length && annotation.quads.every(upright);
}
/** One box per line: overlapping or touching boxes on a line become one. */
function normalize(boxes: Box[]) {
  const lines: Box[] = [];
  for (const next of [...boxes].sort((a, b) => b.y2 - a.y2 || a.x1 - b.x1)) {
    const line = lines.find(current => touching(current, next));
    if (line) { line.x1 = Math.min(line.x1, next.x1); line.x2 = Math.max(line.x2, next.x2); line.y1 = Math.min(line.y1, next.y1); line.y2 = Math.max(line.y2, next.y2); }
    else lines.push({ ...next });
  }
  return lines.sort((a, b) => b.y2 - a.y2 || a.x1 - b.x1);
}

// Overlapping selections share words: «a b c» + «b c d» reads «a b c d».
function joinOverlap(text: string, next: string) {
  if (!text) return next;
  const a = text.split(/\s+/), b = next.split(/\s+/);
  for (let k = Math.min(a.length, b.length); k > 0; k--) if (a.slice(-k).join(' ') === b.slice(0, k).join(' ')) return [...a, ...b.slice(k)].join(' ');
  return `${text} ${next}`;
}
/** Adds highlights, joining each new one with existing highlights of the same
 * color it overlaps or extends on a line, instead of stacking a darker layer.
 * The joined highlight keeps the earliest one's identity. */
export function addHighlights(existing: Annotation[], incoming: Annotation[]): Annotation[] {
  let list = [...existing];
  for (const next of incoming) {
    if (!mergeable(next)) { list.push(next); continue; }
    const boxes = next.quads!.map(box);
    const joined = list.filter(item => mergeable(item) && item.page === next.page && item.color.toLowerCase() === next.color.toLowerCase() && (item.opacity ?? 0) === (next.opacity ?? 0)
      && item.quads!.map(box).some(a => boxes.some(b => touching(a, b))));
    if (!joined.length) { list.push(next); continue; }
    const all = [next, ...joined], first = joined.reduce((a, b) => a.created <= b.created ? a : b);
    const lines = normalize(all.flatMap(item => item.quads!.map(box)));
    // Text in reading order: highest first line first; a text containing another replaces it.
    const texts = all.map(item => ({ text: item.text, top: Math.max(...item.quads!.map(q => q[1])), left: Math.min(...item.quads!.map(q => q[0])) }))
      .sort((a, b) => b.top - a.top || a.left - b.left).map(item => item.text.trim()).filter(Boolean);
    const text = texts.filter((value, index) => !texts.some((other, j) => j !== index && other.length > value.length && other.includes(value))).reduce(joinOverlap, '');
    const merged: Annotation = { ...first, quads: lines.map(quad), text,
      rect: [Math.min(...lines.map(b => b.x1)), Math.min(...lines.map(b => b.y1)), Math.max(...lines.map(b => b.x2)), Math.max(...lines.map(b => b.y2))] };
    list = list.filter(item => !joined.includes(item));
    list.push(merged);
  }
  return list;
}
