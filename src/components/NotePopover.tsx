import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StickyNote, Trash2, X } from 'lucide-react';
import { HIGHLIGHT_PRESETS } from './HighlightColorPicker';
import { visibleBounds } from '../mobile';
import './NotePopover.css';

type Box = { left: number; top: number; right: number; bottom: number };
type Props = {
  /** The marker (or the spot clicked for a new note) the card opens beside; centred without one. */
  anchor: Box | null; page: string; text: string; color: string; isNew: boolean; shortcut: string;
  onText: (text: string) => void; onColor: (color: string) => void; onSave: () => void; onCancel: () => void; onRemove?: () => void;
};

// The note being written, as a card beside its marker: the page stays in view and
// nothing is dimmed. Clicking elsewhere keeps what was written; Esc discards it.
export default function NotePopover({ anchor, page, text, color, isNew, shortcut, onText, onColor, onSave, onCancel, onRemove }: Props) {
  const card = useRef<HTMLDivElement>(null), field = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const node = card.current; if (!node) return;
    const bounds = visibleBounds(), { width, height } = node.getBoundingClientRect(), gap = 10;
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const at = anchor ?? { left: (bounds.left + bounds.right) / 2, right: (bounds.left + bounds.right) / 2, top: (bounds.top + bounds.bottom - height) / 2, bottom: 0 };
    let left = anchor ? at.right + gap : at.left - width / 2;
    if (anchor && left + width > bounds.right - 8) left = at.left - gap - width;
    setPosition({ left: clamp(left, bounds.left + 8, bounds.right - width - 8), top: clamp(at.top - 6, bounds.top + 8, bounds.bottom - height - 8) });
  }, [anchor]);
  // After the click that opened it has finished: the page would take the focus back.
  useEffect(() => {
    const timer = setTimeout(() => { const node = field.current; if (!node) return; node.focus({ preventScroll: true }); node.setSelectionRange(node.value.length, node.value.length); });
    return () => clearTimeout(timer);
  }, []);
  const latest = useRef({ text, onSave, onCancel }); latest.current = { text, onSave, onCancel };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (card.current?.contains(event.target as Node)) return;
      // A click on the page only closes the card: with the note tool it would start another note.
      if (event.target instanceof Element && event.target.closest('.pdf-page')) { event.preventDefault(); event.stopPropagation(); }
      const current = latest.current; if (current.text.trim()) current.onSave(); else current.onCancel();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, []);
  return createPortal(<div ref={card} role="dialog" aria-label={isNew ? 'Añadir nota' : 'Editar nota'} className="note-popover" style={{ '--note': color, ...(position ?? { left: -9999, top: 0 }) } as React.CSSProperties}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && text.trim()) { event.preventDefault(); onSave(); }
    }}>
    <div className="note-popover-heading"><StickyNote size={14} /><span>{isNew ? 'Nota nueva' : 'Nota'} · página {page}</span><button type="button" className="icon-button" aria-label="Cancelar" title="Cancelar (Esc)" onClick={onCancel}><X size={14} /></button></div>
    <textarea ref={field} aria-label="Texto de la nota" placeholder="Escribe una nota…" value={text} maxLength={5000} onChange={event => onText(event.target.value)} />
    <div className="note-popover-footer">
      <div role="radiogroup" aria-label="Color de la nota">{HIGHLIGHT_PRESETS.slice(0, 6).map(([name, hex]) => <button key={hex} type="button" role="radio" aria-checked={color === hex} aria-label={`Color ${name}`} title={name} onClick={() => onColor(hex)}><span style={{ background: hex }} /></button>)}</div>
      {onRemove && <button type="button" className="icon-button" aria-label="Eliminar nota" title="Eliminar nota" onClick={onRemove}><Trash2 size={15} /></button>}
      <button type="button" className="primary-button" aria-label="Guardar nota" title={`Guardar (${shortcut})`} disabled={!text.trim()} onClick={onSave}>Guardar</button>
    </div>
  </div>, document.body);
}
