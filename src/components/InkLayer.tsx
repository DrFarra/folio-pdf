import { useEffect, useRef, useState } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { Annotation, Tool } from '../types';
import type { AnnotationDraft } from '../text-selection';
import './InkLayer.css';

type Props = {
  viewport: PageViewport; page: number; annotations: Annotation[]; tool: Tool;
  color: string; width: number; penOnly: boolean; enabled: boolean;
  onAdd: (draft: AnnotationDraft) => void; onRemove: (id: string) => void;
};

function distance(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

export default function InkLayer({ viewport, page, annotations, tool, color, width, penOnly, enabled, onAdd, onRemove }: Props) {
  const [preview, setPreview] = useState<number[]>([]);
  const active = useRef<{ id: number; points: number[]; erase: boolean; target?: string } | null>(null);
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
  function targetAt(p: number[]) {
    const tolerance = 10 / viewport.scale;
    return [...annotations].reverse().find(a => a.kind === 'ink' && a.inkPaths?.some(path => {
      for (let i = 0; i < path.length - 2; i += 2) if (distance(p[0], p[1], path[i], path[i + 1], path[i + 2], path[i + 3]) <= tolerance + (a.strokeWidth || 2) / 2) return true;
      return false;
    }))?.id;
  }
  function append(event: React.PointerEvent<SVGSVGElement>) {
    const stroke = active.current;
    if (!stroke || stroke.id !== event.pointerId) return;
    const events = event.nativeEvent.getCoalescedEvents?.() || [];
    for (const sample of events.length ? events : [event]) {
      const p = point(sample, event.currentTarget);
      if (stroke.erase) { stroke.target = targetAt(p) || stroke.target; continue; }
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
      active.current = { id: event.pointerId, points, erase, target: erase ? targetAt(points) : undefined };
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
      if (stroke.erase) { if (stroke.target) onRemove(stroke.target); }
      else {
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
