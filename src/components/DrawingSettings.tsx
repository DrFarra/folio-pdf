import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Eraser } from 'lucide-react';
import { visibleBounds } from '../mobile';
import './DrawingSettings.css';

type Props = {
  mode: 'draw' | 'eraser'; color: string; width: number; eraserSize: number;
  penOnly: boolean; showFingerOption: boolean; onColor: (value: string) => void; onWidth: (value: number) => void;
  onEraserSize: (value: number) => void; onPenOnly: (value: boolean) => void; disabled?: boolean;
};
const colors = [['Grafito', '#303843'], ['Azul', '#2455b5'], ['Rojo', '#c64b43'], ['Verde', '#338765'], ['Violeta', '#8759af'], ['Naranja', '#d58a32']] as const;

export default function DrawingSettings({ mode, color, width, eraserSize, penOnly, showFingerOption, onColor, onWidth, onEraserSize, onPenOnly, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: -1000, top: -1000 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const id = useId(), name = mode === 'draw' ? 'Lápiz' : 'Goma';
  useEffect(() => { setOpen(false); }, [mode, disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect(), box = panel.current.getBoundingClientRect(), bounds = visibleBounds();
      setPosition({ left: Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - box.width - 8)), top: Math.max(bounds.top + 8, Math.min(bounds.bottom - box.height - 8, anchor.bottom + box.height + 8 < bounds.bottom ? anchor.bottom + 6 : anchor.top - box.height - 6)) });
    };
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); trigger.current?.focus({ preventScroll: true }); } };
    place(); document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', place); window.visualViewport?.addEventListener('resize', place);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place); };
  }, [open]);
  return <>
    <button ref={trigger} className="drawing-settings-trigger" aria-label={mode === 'draw' ? 'Opciones del lápiz' : 'Opciones de la goma'} title={mode === 'draw' ? 'Opciones del lápiz' : 'Opciones de la goma'} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(value => !value)}>
      {mode === 'draw' ? <span style={{ background: color }} /> : <Eraser size={16} />}<ChevronDown size={12} />
    </button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={name} className="drawing-settings-popup" style={position}>
      <strong>{name}</strong>
      {mode === 'draw' ? <>
        <div className="drawing-colors" role="group" aria-label="Color del lápiz">{colors.map(([label, value]) => <button key={value} aria-label={label} aria-pressed={color.toLowerCase() === value} onClick={() => onColor(value)}><span style={{ background: value }}>{color.toLowerCase() === value && <Check size={14} />}</span></button>)}<label className="drawing-custom-color" title="Color personalizado"><input aria-label="Color personalizado del lápiz" type="color" value={color} onChange={event => onColor(event.target.value)} /></label></div>
        <div className="drawing-widths" role="group" aria-label="Grosor del lápiz">{[1, 2, 3, 5].map(value => <button key={value} aria-label={`${value} puntos`} aria-pressed={width === value} onClick={() => onWidth(value)}><span style={{ height: value, background: color }} /><small>{value}</small></button>)}</div>
      </> : <>
        <div className="drawing-eraser-sizes" role="group" aria-label="Tamaño de la goma">{[[8, 'Fina'], [16, 'Media'], [28, 'Amplia']].map(([value, label]) => <button key={value} aria-label={String(label)} aria-pressed={eraserSize === value} onClick={() => onEraserSize(Number(value))}><span style={{ width: Number(value), height: Number(value) }} /><small>{label}</small></button>)}</div>
        <p>Borra los trazos que recorrés, sin levantar el lápiz.</p>
      </>}
      {showFingerOption && <><label className="drawing-finger-toggle"><span>Usar el dedo</span><input type="checkbox" checked={!penOnly} onChange={event => onPenOnly(!event.target.checked)} /></label>
      <p>{penOnly ? 'Lápiz para marcar; dedo para desplazar.' : 'Lápiz o dedo para marcar. Dos dedos para ampliar.'}</p></>}
    </div>, document.body)}
  </>;
}
