import { useEffect, useRef, useState } from 'react';
import { Eraser, Highlighter, PenLine, StickyNote, Undo2, Brush } from 'lucide-react';
import { haptic } from '../platform';
import './PencilPalette.css';

export type PencilAction = 'pen' | 'marker' | 'highlight' | 'eraser' | 'note' | 'undo';
const ITEMS: { id: PencilAction; label: string; icon: React.ReactNode }[] = [
  { id: 'pen', label: 'Bolígrafo', icon: <PenLine size={20} /> },
  { id: 'marker', label: 'Rotulador', icon: <Brush size={20} /> },
  { id: 'highlight', label: 'Resaltar texto', icon: <Highlighter size={20} /> },
  { id: 'eraser', label: 'Goma', icon: <Eraser size={20} /> },
  { id: 'note', label: 'Nota', icon: <StickyNote size={20} /> },
  { id: 'undo', label: 'Deshacer', icon: <Undo2 size={20} /> },
];
const RADIUS = 66;

/** Quick tools at the pen tip. Opens with a stylus barrel button (Android S Pen,
 * Wacom, Surface: pointer button 2, also hovering) or, on iPad, the Apple
 * Pencil double tap or squeeze relayed by the native plugin as
 * `folio:pencil-palette`. It appears where the pen points. */
export function PencilPalette({ enabled, active, inkColor, canUndo, onAction }: { enabled: boolean; active?: PencilAction; inkColor: string; canUndo: boolean; onAction: (action: PencilAction) => void }) {
  const [at, setAt] = useState<{ x: number; y: number; key: number } | null>(null);
  const [hovered, setHovered] = useState<PencilAction | null>(null);
  const lastPen = useRef<{ x: number; y: number } | null>(null), buttons = useRef(0), node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) { setAt(null); return; }
    const open = (x: number, y: number) => {
      const margin = RADIUS + 34;
      setAt({ x: Math.min(innerWidth - margin, Math.max(margin, x)), y: Math.min(innerHeight - margin, Math.max(margin, y)), key: Date.now() });
      setHovered(null); haptic('medium');
    };
    const pointer = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;
      lastPen.current = { x: event.clientX, y: event.clientY };
      // The barrel button reads as button 2, pressed while touching or hovering.
      const barrel = (event.buttons & 2) !== 0 && (buttons.current & 2) === 0 || event.type === 'pointerdown' && event.button === 2;
      buttons.current = event.buttons;
      if (barrel && !node.current?.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); open(event.clientX, event.clientY); }
    };
    const context = (event: MouseEvent) => { if ((event as PointerEvent).pointerType === 'pen' || lastPen.current && Math.hypot(event.clientX - lastPen.current.x, event.clientY - lastPen.current.y) < 4) event.preventDefault(); };
    const native = (event: Event) => { const detail = (event as CustomEvent<{ x?: number; y?: number }>).detail || {}; const point = Number.isFinite(detail.x) ? { x: detail.x!, y: detail.y! } : lastPen.current || { x: innerWidth / 2, y: innerHeight / 2 }; open(point.x, point.y); };
    window.addEventListener('pointerdown', pointer, true); window.addEventListener('pointermove', pointer, true); window.addEventListener('contextmenu', context, true);
    window.addEventListener('folio:pencil-palette', native);
    return () => { window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('pointermove', pointer, true); window.removeEventListener('contextmenu', context, true); window.removeEventListener('folio:pencil-palette', native); };
  }, [enabled]);
  useEffect(() => {
    if (!at) return;
    const outside = (event: PointerEvent) => { if (!node.current?.contains(event.target as Node)) setAt(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setAt(null); } };
    const timer = window.setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape); }, 0);
    return () => { window.clearTimeout(timer); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); };
  }, [at?.key]);
  if (!at) return null;
  const items = ITEMS.filter(item => item.id !== 'undo' || canUndo);
  const label = ITEMS.find(item => item.id === hovered)?.label;
  return <div ref={node} key={at.key} className="pencil-palette" style={{ left: at.x, top: at.y }} role="toolbar" aria-label="Herramientas del lápiz">
    <span className="pencil-palette-core" style={{ '--ink': inkColor } as React.CSSProperties} aria-hidden="true" />
    {items.map((item, index) => {
      const angle = -Math.PI / 2 + index * (2 * Math.PI / items.length);
      return <button key={item.id} type="button" className={`pencil-palette-item${active === item.id ? ' active' : ''}`} aria-label={item.label} title={item.label}
        style={{ '--dx': `${Math.cos(angle) * RADIUS}px`, '--dy': `${Math.sin(angle) * RADIUS}px`, '--delay': `${index * 28}ms` } as React.CSSProperties}
        onPointerEnter={() => setHovered(item.id)} onPointerLeave={() => setHovered(current => current === item.id ? null : current)} onFocus={() => setHovered(item.id)}
        onClick={() => { setAt(null); haptic('light'); onAction(item.id); }}>{item.icon}</button>;
    })}
    {label && <span className="pencil-palette-label">{label}</span>}
  </div>;
}
