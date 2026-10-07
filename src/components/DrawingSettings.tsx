import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Eraser, Highlighter, PenLine, Plus } from 'lucide-react';
import { visibleBounds } from '../mobile';
import './DrawingSettings.css';

export type InkKind = 'pen' | 'marker';
/** Each tool remembers its own color, width (PDF points) and opacity. */
export type InkStyle = { color: string; width: number; opacity: number };
export const INK_DEFAULTS: Record<InkKind, InkStyle> = { pen: { color: '#2455b5', width: 2, opacity: 1 }, marker: { color: '#f2c94c', width: 14, opacity: .35 } };
const TOOLS: Record<InkKind, { label: string; min: number; max: number; step: number; sizes: number[]; colors: readonly (readonly [string, string])[] }> = {
  pen: { label: 'Bolígrafo', min: .5, max: 12, step: .5, sizes: [1, 2, 4],
    colors: [['Negro', '#1f2328'], ['Azul', '#2455b5'], ['Rojo', '#c64b43'], ['Verde', '#338765'], ['Naranja', '#d58a32'], ['Violeta', '#8759af'], ['Gris', '#6b7280'], ['Blanco', '#ffffff']] },
  marker: { label: 'Rotulador', min: 4, max: 40, step: 1, sizes: [8, 14, 24],
    colors: [['Amarillo', '#f2c94c'], ['Verde', '#6fcf97'], ['Celeste', '#56ccf2'], ['Rosa', '#f28cb1'], ['Naranja', '#f2994a'], ['Violeta', '#bb8ff7'], ['Rojo', '#eb5757'], ['Gris', '#bdbdbd']] },
};
export const inkRange = (kind: InkKind) => TOOLS[kind];
const points = (value: number) => `${value.toLocaleString('es', { maximumFractionDigits: 1 })} pt`;

type Props = {
  mode: 'draw' | 'eraser'; kind: InkKind; style: InkStyle; recentColors: string[]; eraserSize: number;
  penOnly: boolean; showFingerOption: boolean; onKind: (kind: InkKind) => void; onStyle: (style: Partial<InkStyle>) => void;
  onCustomColor: (color: string) => void; onEraserSize: (value: number) => void; onPenOnly: (value: boolean) => void; disabled?: boolean;
};

export default function DrawingSettings({ mode, kind, style, recentColors, eraserSize, penOnly, showFingerOption, onKind, onStyle, onCustomColor, onEraserSize, onPenOnly, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: -1000, top: -1000, origin: 'top left' });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), keyboard = useRef(false);
  const id = useId(), name = mode === 'draw' ? 'Lápiz' : 'Goma', tool = TOOLS[kind];
  const color = style.color.toLowerCase(), presets = tool.colors.map(([, value]) => value), recent = recentColors.filter(value => !presets.includes(value)).slice(0, 5);
  useEffect(() => { setOpen(false); }, [mode, disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      // offset sizes ignore the entry scale, which would place the panel partly off screen.
      const anchor = trigger.current.getBoundingClientRect(), box = { width: panel.current.offsetWidth, height: panel.current.offsetHeight }, bounds = visibleBounds();
      const below = anchor.bottom + box.height + 8 < bounds.bottom, left = Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - box.width - 8));
      // The panel grows out of its trigger.
      setPosition({ left, top: Math.max(bounds.top + 8, Math.min(bounds.bottom - box.height - 8, below ? anchor.bottom + 6 : anchor.top - box.height - 6)),
        origin: `${Math.round(anchor.left + anchor.width / 2 - left)}px ${below ? 'top' : 'bottom'}` });
    };
    const outside = (event: PointerEvent) => {
      if (panel.current?.contains(event.target as Node) || trigger.current?.contains(event.target as Node)) return;
      // A tap on the page only closes the panel; it must not leave a dot of ink.
      if (event.target instanceof Element && event.target.closest('.pdf-page')) { event.preventDefault(); event.stopPropagation(); }
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); trigger.current?.focus({ preventScroll: true }); } };
    // Tabbing out of the panel closes it.
    const leave = (event: FocusEvent) => { const next = event.relatedTarget as Node | null; if (next && !panel.current?.contains(next) && !trigger.current?.contains(next)) setOpen(false); };
    place(); document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true); panel.current?.addEventListener('focusout', leave);
    // Opened from the keyboard, focus starts on the current choice.
    if (keyboard.current) (panel.current?.querySelector<HTMLElement>('[aria-pressed=true]') ?? panel.current?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    window.addEventListener('resize', place); window.visualViewport?.addEventListener('resize', place);
    const node = panel.current;
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); node?.removeEventListener('focusout', leave); window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place); };
  }, [open]);
  // Shown at about its size on the page at 100 %.
  // Size dots grow with the width across the tool's range, readable at a glance.
  const dot = (value: number) => Math.round(5 + 19 * Math.sqrt((value - tool.min) / (tool.max - tool.min)));
  const previewWidth = Math.min(30, style.width * 1.33);
  return <>
    <button ref={trigger} className="drawing-settings-trigger" aria-label={mode === 'draw' ? 'Opciones del lápiz' : 'Opciones de la goma'} title={mode === 'draw' ? 'Opciones del lápiz' : 'Opciones de la goma'} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={event => { keyboard.current = event.detail === 0; setOpen(value => !value); }}>
      {mode === 'draw' ? <span className={kind} style={{ '--ink': style.color, '--ink-opacity': style.opacity } as React.CSSProperties}>{kind === 'marker' ? <Highlighter size={13} /> : <PenLine size={13} />}</span> : <Eraser size={16} />}<ChevronDown size={12} />
    </button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={name} className={`drawing-settings-popup ${mode}`} style={{ left: position.left, top: position.top, transformOrigin: position.origin }}>
      {mode === 'draw' ? <>
        <div className="drawing-kinds" role="group" aria-label="Tipo de lápiz">{(['pen', 'marker'] as const).map(value => <button key={value} aria-pressed={kind === value} onClick={() => onKind(value)}>{value === 'pen' ? <PenLine size={17} /> : <Highlighter size={17} />}<span>{TOOLS[value].label}</span></button>)}</div>
        <svg className={`drawing-preview ${kind}`} viewBox="0 0 260 56" aria-hidden="true"><path d="M18 36 C 58 6, 96 8, 128 28 S 202 52, 242 20" stroke={style.color} strokeWidth={previewWidth} strokeOpacity={style.opacity} /></svg>
        <div className="drawing-row"><span>Grosor</span><output>{points(style.width)}</output></div>
        <input className="drawing-slider" type="range" aria-label="Grosor" min={tool.min} max={tool.max} step={tool.step} value={style.width} style={{ '--fill': `${(style.width - tool.min) / (tool.max - tool.min) * 100}%` } as React.CSSProperties} onChange={event => onStyle({ width: Number(event.target.value) })} />
        <div className="drawing-sizes" role="group" aria-label="Grosores rápidos">{tool.sizes.map(value => <button key={value} aria-label={points(value)} aria-pressed={style.width === value} onClick={() => onStyle({ width: value })}><span style={{ width: dot(value), height: dot(value), background: style.color, opacity: Math.max(.45, style.opacity) }} /></button>)}</div>
        <div className="drawing-row"><span>Opacidad</span><output>{Math.round(style.opacity * 100)} %</output></div>
        <input className="drawing-slider" type="range" aria-label="Opacidad" min={10} max={100} step={5} value={Math.round(style.opacity * 100)} style={{ '--fill': `${(style.opacity * 100 - 10) / 90 * 100}%` } as React.CSSProperties} onChange={event => onStyle({ opacity: Number(event.target.value) / 100 })} />
        <div className="drawing-row"><span>Color</span></div>
        <div className="drawing-colors" role="group" aria-label="Color del lápiz">
          {tool.colors.map(([label, value]) => <button key={value} aria-label={label} aria-pressed={color === value} onClick={() => onStyle({ color: value })}><span style={{ background: value }}>{color === value && <Check size={14} />}</span></button>)}
          {recent.map(value => <button key={value} aria-label={`Color reciente ${value}`} aria-pressed={color === value} onClick={() => onStyle({ color: value })}><span style={{ background: value }}>{color === value && <Check size={14} />}</span></button>)}
          <label className="drawing-custom-color" title="Color personalizado"><Plus size={16} /><input aria-label="Color personalizado del lápiz" type="color" value={style.color} onChange={event => onStyle({ color: event.target.value.toLowerCase() })} onBlur={event => onCustomColor(event.target.value.toLowerCase())} /></label>
        </div>
      </> : <>
        <strong>{name}</strong>
        <div className="drawing-eraser-sizes" role="group" aria-label="Tamaño de la goma">{[[8, 'Fina'], [16, 'Media'], [28, 'Amplia']].map(([value, label]) => <button key={value} aria-label={String(label)} aria-pressed={eraserSize === value} onClick={() => onEraserSize(Number(value))}><span style={{ width: Number(value), height: Number(value) }} /><small>{label}</small></button>)}</div>
        <p>Pasa la goma sobre un trazo para borrarlo entero.</p>
      </>}
      {showFingerOption && <><label className="drawing-finger-toggle"><span>Usar el dedo</span><input type="checkbox" checked={!penOnly} onChange={event => onPenOnly(!event.target.checked)} /></label>
      <p>{penOnly ? `Lápiz para ${mode === 'draw' ? 'dibujar' : 'borrar'}; dedo para desplazar.` : `Lápiz o dedo para ${mode === 'draw' ? 'dibujar' : 'borrar'}; dos dedos para desplazar o ampliar.`}</p></>}
    </div>, document.body)}
  </>;
}
