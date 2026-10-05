import { useEffect, useRef, useState } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { Annotation, Tool } from '../types';
import type { AnnotationDraft } from '../text-selection';
import './InkLayer.css';

type Props = {
  viewport: PageViewport; page: number; annotations: Annotation[]; tool: Tool;
  color: string; width: number; eraserSize?: number; penOnly: boolean; enabled: boolean;
  onAdd: (draft: AnnotationDraft) => void; onRemove: (id: string, gesture?: string) => void;
};

function distance(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

export default function InkLayer({ viewport, page, annotations, tool, color, width, eraserSize = 16, penOnly, enabled, onAdd, onRemove }: Props) {
  const [preview, setPreview] = useState<number[]>([]);
  const active = useRef<{ id: number; points: number[]; erase: boolean; erased: Set<string>; group: string } | null>(null);
  const pan = useRef<{ id: number; x: number; y: number } | null>(null);
  const frame = useRef(0);
  const stylus = useRef(0);
  const interactive = enabled && (tool === 'draw' || tool === 'eraser');
  const clear = () => { active.current = null; pan.current = null; cancelAnimationFrame(frame.current); frame.current = 0; setPreview([]); };
  useEffect(() => { clear(); }, [tool, enabled, viewport, penOnly]);
  useEffect(() => {
    window.addEventListener('folio:pinch-start', clear);
    return () => { cancelAnimationFrame(frame.current); window.removeEventListener('folio:pinch-start', clear); };
  }, []);
  function point(event: { clientX: number; clientY: number }, svg: SVGSVGElement) {
    const box = svg.getBoundingClientRect();
    return viewport.convertToPdfPoint(Math.max(0, Math.min(viewport.width, (event.clientX - box.left) * viewport.width / box.width)), Math.max(0, Math.min(viewport.height, (event.clientY - box.top) * viewport.height / box.height)));
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
  const pathData = (path: number[]) => {
    const points = [];
    for (let i = 0; i < path.length; i += 2) points.push(viewport.convertToViewportPoint(path[i], path[i + 1]).join(','));
    return points.join(' ');
  };
  return <svg className={`ink-layer${interactive ? ' ink-interactive' : ''}`} aria-label={interactive ? tool === 'eraser' ? 'Borrar trazos' : 'Dibujar en la página' : 'Dibujos del PDF'} data-pen-only={penOnly} viewBox={`0 0 ${viewport.width} ${viewport.height}`}
    onPointerDown={event => {
      event.stopPropagation();
      if (!interactive) return;
      if (event.pointerType === 'pen') stylus.current = performance.now();
      if (event.pointerType === 'touch' && (active.current || event.width > 35 || event.height > 35 || performance.now() - stylus.current < 400)) return;
      if (event.pointerType === 'touch' && penOnly) { pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); return; }
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
        const reader = event.currentTarget.closest('.reading-area');
        if (reader) { reader.scrollLeft -= event.clientX - pan.current.x; reader.scrollTop -= event.clientY - pan.current.y; }
        pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      } else append(event);
    }} onPointerUp={event => {
      event.stopPropagation();
      if (pan.current?.id === event.pointerId) pan.current = null;
      const stroke = active.current;
      if (!stroke || stroke.id !== event.pointerId) return;
      append(event);
      if (!stroke.erase) {
        const points = stroke.points;
        if (points.length === 2) points.push(points[0] + .01, points[1]);
        const xs = points.filter((_, i) => i % 2 === 0), ys = points.filter((_, i) => i % 2 === 1);
        onAdd({ page, kind: 'ink', rect: [Math.min(...xs) - width, Math.min(...ys) - width, Math.max(...xs) + width, Math.max(...ys) + width], inkPaths: [[...points]], strokeWidth: width, color, opacity: 1, text: '' });
      }
      clear(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={event => { if (active.current?.id === event.pointerId || pan.current?.id === event.pointerId) clear(); }} onLostPointerCapture={event => { if (active.current?.id === event.pointerId) clear(); }} onClick={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
    {annotations.filter(a => a.kind === 'ink').map(a => <g key={a.id} data-ink-id={a.id} stroke={a.color} strokeWidth={(a.strokeWidth || 2) * viewport.scale} opacity={a.opacity ?? 1}>{a.inkPaths?.map((path, index) => <polyline key={index} points={pathData(path)} />)}</g>)}
    {preview.length > 0 && <polyline className="ink-preview" points={pathData(preview.length === 2 ? [...preview, preview[0] + .01, preview[1]] : preview)} stroke={color} strokeWidth={width * viewport.scale} />}
  </svg>;
}
