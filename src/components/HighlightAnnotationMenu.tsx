import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, Pencil, Trash2 } from 'lucide-react';
import HighlightColorPicker, { HIGHLIGHT_PRESETS } from './HighlightColorPicker';
import { visibleBounds } from '../mobile';
import './HighlightAnnotationMenu.css';

// `note` relabels it for a note: editing it instead of commenting.
type Props = { x: number; y: number; onRemove: () => void; onClose: (restoreFocus?: unknown) => void; color?: string; onColorChange?: (color: string) => void; onComment?: () => void; note?: boolean };

export default function HighlightAnnotationMenu({ x, y, onRemove, onClose, color, onColorChange, onComment, note }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y + 8 });
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    // Layout size: the pop-in animation scales the menu while it is measured.
    const box = { width: element.offsetWidth, height: element.offsetHeight };
    const bounds = visibleBounds();
    setPosition({ left: Math.max(bounds.left + 8, Math.min(x, bounds.right - box.width - 8)), top: Math.max(bounds.top + 8, Math.min(y + 8, bounds.bottom - box.height - 8)) });
    element.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !(event.target instanceof Element && event.target.closest('.highlight-color-palette'))) onClose(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return createPortal(<div ref={menu} role="menu" aria-label={note ? 'Nota' : 'Resaltado'} className="highlight-annotation-menu" style={position}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')], current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? items.length - 1 : 1)) % items.length;
        items[next]?.focus();
      }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); onRemove(); }
    }}>
    {onColorChange && (note ? HIGHLIGHT_PRESETS.slice(0, 6).map(([name, hex]) => <button key={hex} role="menuitemradio" className="note-color" aria-checked={color === hex} aria-label={`Color ${name}`} title={name} onClick={() => { onColorChange(hex); onClose(true); }}><span style={{ background: hex }} /></button>)
      : <HighlightColorPicker color={color || '#f5d164'} onChange={value => { onColorChange(value); onClose(true); }} />)}
    {onComment && (note ? <button role="menuitem" aria-label="Editar nota" onClick={onComment}><Pencil size={15} /><span>Editar</span></button>
      : <button role="menuitem" aria-label="Comentar resaltado" onClick={onComment}><MessageSquare size={15} /><span>Comentar</span></button>)}
    <button role="menuitem" aria-label={note ? 'Eliminar nota' : 'Eliminar resaltado'} onClick={onRemove}><Trash2 size={15} /><span>{note ? 'Eliminar nota' : 'Eliminar resaltado'}</span></button>
  </div>, document.body);
}
