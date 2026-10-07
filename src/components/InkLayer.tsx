import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { Annotation, Tool } from '../types';
import type { AnnotationDraft } from '../text-selection';
import './InkLayer.css';

type Props = {
  viewport: PageViewport; page: number; annotations: Annotation[]; tool: Tool;
  color: string; width: number; opacity?: number; eraserSize?: number; penOnly: boolean; enabled: boolean;
  onAdd: (draft: AnnotationDraft) => void; onRemove: (id: string, gesture?: string) => void;
};

// One momentum glide for the whole reader: a press anywhere, also on another
// page, between pages or on the toolbar, stops it as native scrolling does.
let stopGlide: (() => void) | null = null;

function distance(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}
function pathData(path: number[], viewport: PageViewport) {
  const points = [];
  for (let i = 0; i < path.length; i += 2) points.push(viewport.convertToViewportPoint(path[i], path[i + 1]).join(','));
  return points.join(' ');
}

export default function InkLayer({ viewport, page, annotations, tool, color, width, opacity = 1, eraserSize = 16, penOnly, enabled, onAdd, onRemove }: Props) {
  const [preview, setPreview] = useState<number[]>([]);
  const active = useRef<{ id: number; points: number[]; erase: boolean; erased: Set<string>; group: string } | null>(null);
  const pan = useRef<{ id: number; x: number; y: number; at: number; vx: number; vy: number } | null>(null);
  const frame = useRef(0);
  const glide = useRef<(() => void) | null>(null);
  const stylus = useRef(-Infinity); // No stylus yet: no touch is taken for a resting palm.
  const interactive = enabled && (tool === 'draw' || tool === 'eraser');
  // Stops only a glide this page started: a page mounting mid-glide must not end it.
  const clear = () => { active.current = null; pan.current = null; cancelAnimationFrame(frame.current); frame.current = 0; glide.current?.(); setPreview([]); };
  // A pen detected mid-stroke may switch the app to pen-only; keep that stroke.
  useEffect(() => { clear(); }, [tool, enabled, viewport]);
  useEffect(() => {
    const background = () => { if (document.visibilityState === 'hidden') clear(); };
    window.addEventListener('folio:pinch-start', clear);
    window.addEventListener('blur', clear); window.addEventListener('pagehide', clear); document.addEventListener('visibilitychange', background);
    return () => { cancelAnimationFrame(frame.current); glide.current?.(); window.removeEventListener('folio:pinch-start', clear); window.removeEventListener('blur', clear); window.removeEventListener('pagehide', clear); document.removeEventListener('visibilitychange', background); };
  }, []);
  function point(event: { clientX: number; clientY: number }, svg: SVGSVGElement) {
    const box = svg.getBoundingClientRect();
    // Hundredths of a point are far below pen precision and keep sessions small.
    return viewport.convertToPdfPoint(Math.max(0, Math.min(viewport.width, (event.clientX - box.left) * viewport.width / box.width)), Math.max(0, Math.min(viewport.height, (event.clientY - box.top) * viewport.height / box.height))).map(value => Math.round(value * 100) / 100);
  }
  function eraseBetween(from: number[], to: number[], stroke: NonNullable<typeof active.current>) {
    const radius = eraserSize / (2 * viewport.scale);
    for (const annotation of annotations) {
      if (annotation.kind !== 'ink' || stroke.erased.has(annotation.id)) continue;
      const tolerance = radius + (annotation.strokeWidth || 2) / 2;
      const hit = annotation.inkPaths?.some(path => {
        for (let i = 0; i < path.length - 2; i += 2) {
          const [ax, ay, bx, by] = path.slice(i, i + 4);
          // Sweep the complete segment between samples, including fast moves.
          const cross = (x: number, y: number, a: number[], b: number[]) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
          const a = [ax, ay], b = [bx, by];
          const crosses = cross(ax, ay, from, to) * cross(bx, by, from, to) < 0 && cross(from[0], from[1], a, b) * cross(to[0], to[1], a, b) < 0;
          if (crosses || Math.min(distance(from[0], from[1], ax, ay, bx, by), distance(to[0], to[1], ax, ay, bx, by), distance(ax, ay, from[0], from[1], to[0], to[1]), distance(bx, by, from[0], from[1], to[0], to[1])) <= tolerance) {
            stroke.erased.add(annotation.id); onRemove(annotation.id, stroke.group); return true;
          }
        }
        return false;
      });
      if (hit) continue;
    }
  }
  function append(event: React.PointerEvent<SVGSVGElement>) {
    const stroke = active.current;
    if (!stroke || stroke.id !== event.pointerId) return;
    const events = event.nativeEvent.getCoalescedEvents?.() || [];
    for (const sample of events.length ? events : [event]) {
      const p = point(sample, event.currentTarget);
      if (stroke.erase) { eraseBetween(stroke.points, p, stroke); stroke.points = p; continue; }
      const points = stroke.points;
      if (points.length < 20000 && (points.length < 2 || Math.hypot(p[0] - points.at(-2)!, p[1] - points.at(-1)!) >= .3 / viewport.scale)) points.push(...p);
    }
    if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; if (active.current && !active.current.erase) setPreview([...active.current.points]); });
  }
  // Saved strokes do not change while a new one is previewed every frame.
  const strokes = useMemo(() => annotations.filter(a => a.kind === 'ink').map(a => <g key={a.id} data-ink-id={a.id} className={(a.opacity ?? 1) < 1 ? 'ink-translucent' : undefined} stroke={a.color} strokeWidth={(a.strokeWidth || 2) * viewport.scale} opacity={a.opacity ?? 1}>{a.inkPaths?.map((path, index) => <polyline key={index} points={pathData(path, viewport)} />)}</g>), [annotations, viewport]);
  function release(reader: Element, vx: number, vy: number) {
    // Finger scrolling in pen-only mode keeps its momentum like native scrolling.
    stopGlide?.();
    let last = performance.now(), id = 0;
    const stop = () => { cancelAnimationFrame(id); window.removeEventListener('pointerdown', stop, true); if (stopGlide === stop) stopGlide = null; };
    const step = (now: number) => {
      const elapsed = now - last, decay = .95 ** (elapsed / 16);
      last = now; reader.scrollLeft -= vx * elapsed; reader.scrollTop -= vy * elapsed; vx *= decay; vy *= decay;
      if (Math.hypot(vx, vy) > .02) id = requestAnimationFrame(step); else stop();
    };
    // Capture runs before any handler, so the press that stops it never draws on a sliding page.
    stopGlide = glide.current = stop; window.addEventListener('pointerdown', stop, true);
    id = requestAnimationFrame(step);
  }
  return <svg className={`ink-layer${interactive ? ' ink-interactive' : ''}`} aria-label={interactive ? tool === 'eraser' ? 'Borrar con la goma' : 'Dibujar con el lápiz' : 'Dibujos del PDF'} data-pen-only={penOnly} viewBox={`0 0 ${viewport.width} ${viewport.height}`}
    onPointerDown={event => {
      event.stopPropagation();
      if (!interactive) return;
      if (event.pointerType === 'pen') stylus.current = performance.now();
      // Palm rejection: a fingertip reports ~30–50 px and more when it lands fast, a resting palm far more.
      if (event.pointerType === 'touch' && (active.current || event.width > 80 || event.height > 80 || performance.now() - stylus.current < 400)) return;
      if (event.pointerType === 'touch' && penOnly) { pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), vx: 0, vy: 0 }; event.currentTarget.setPointerCapture(event.pointerId); return; }
      if (active.current || event.button !== 0 && event.button !== 5) return;
      event.preventDefault(); window.getSelection()?.removeAllRanges();
      const points = point(event, event.currentTarget), erase = tool === 'eraser' || event.button === 5 || !!(event.buttons & 32);
      active.current = { id: event.pointerId, points, erase, erased: new Set(), group: crypto.randomUUID() };
      if (erase) eraseBetween(points, points, active.current);
      event.currentTarget.setPointerCapture(event.pointerId); setPreview(erase ? [] : [...points]);
    }} onPointerMove={event => {
      event.stopPropagation();
      if (event.pointerType === 'pen') stylus.current = performance.now();
      if (pan.current?.id === event.pointerId && !active.current) {
        const reader = event.currentTarget.closest('.reading-area'), now = performance.now();
        const dx = event.clientX - pan.current.x, dy = event.clientY - pan.current.y, elapsed = Math.max(1, now - pan.current.at);
        if (reader) { reader.scrollLeft -= dx; reader.scrollTop -= dy; }
        pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: now, vx: .8 * dx / elapsed + .2 * pan.current.vx, vy: .8 * dy / elapsed + .2 * pan.current.vy };
      } else append(event);
    }} onPointerUp={event => {
      event.stopPropagation();
      if (pan.current?.id === event.pointerId) {
        const { at, vx, vy } = pan.current, reader = event.currentTarget.closest('.reading-area');
        pan.current = null;
        if (reader && performance.now() - at < 100) release(reader, vx, vy);
      }
      const stroke = active.current;
      if (!stroke || stroke.id !== event.pointerId) return;
      append(event);
      if (!stroke.erase) {
        const points = stroke.points;
        if (points.length === 2) points.push(points[0] + .01, points[1]);
        const xs = points.filter((_, i) => i % 2 === 0), ys = points.filter((_, i) => i % 2 === 1);
        onAdd({ page, kind: 'ink', rect: [Math.min(...xs) - width, Math.min(...ys) - width, Math.max(...xs) + width, Math.max(...ys) + width], inkPaths: [[...points]], strokeWidth: width, color, opacity, text: '' });
      }
      clear(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={event => { if (active.current?.id === event.pointerId || pan.current?.id === event.pointerId) clear(); }} onLostPointerCapture={event => { if (active.current?.id === event.pointerId) clear(); }} onClick={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
    {strokes}
    {preview.length > 0 && <polyline className="ink-preview" points={pathData(preview.length === 2 ? [...preview, preview[0] + .01, preview[1]] : preview, viewport)} stroke={color} strokeWidth={width * viewport.scale} opacity={opacity} />}
  </svg>;
}
