import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { visibleBounds } from '../mobile';
import './HighlightAnnotationMenu.css';

type Props = { x: number; y: number; onRemove: () => void; onClose: () => void };

export default function HighlightAnnotationMenu({ x, y, onRemove, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y + 8 });
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const bounds = visibleBounds();
    setPosition({ left: Math.max(bounds.left + 8, Math.min(x, bounds.right - box.width - 8)), top: Math.max(bounds.top + 8, Math.min(y + 8, bounds.bottom - box.height - 8)) });
    element.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
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
  return createPortal(<div ref={menu} role="menu" aria-label="Resaltado" className="highlight-annotation-menu" style={position}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); onRemove(); }
    }}>
    <button role="menuitem" aria-label="Eliminar resaltado" onClick={onRemove}><Trash2 size={15} /><span>Eliminar resaltado</span></button>
  </div>, document.body);
}
