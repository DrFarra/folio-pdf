import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { visibleBounds } from '../mobile';
import { setHighlightLabel, useHighlightLabels } from '../highlight-labels';
import './HighlightColorPicker.css';

type Props = { color: string; onChange: (hex: string) => void; disabled?: boolean };
export const HIGHLIGHT_PRESETS = [
  ['Amarillo', '#f5d164'], ['Verde', '#91c6a5'], ['Rosa', '#eea1b7'], ['Violeta', '#bea9e4'],
  ['Azul', '#8bbaf0'], ['Naranja', '#f2af74'], ['Rojo', '#eba08e'], ['Menta', '#82d0bf'],
  ['Cian', '#8bd7e7'], ['Índigo', '#9cabe8'], ['Lima', '#c7d67d'], ['Gris', '#c5c9d1'],
] as const;
const validColor = (hex: string) => /^#[0-9a-f]{6}$/i.test(hex);

export default function HighlightColorPicker({ color, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: -1000, top: -1000 });
  const trigger = useRef<HTMLButtonElement>(null), palette = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false), selection = useRef<Range | null>(null);
  const id = useId();
  const chosen = validColor(color) ? color.toLowerCase() : HIGHLIGHT_PRESETS[0][1];
  const labels = useHighlightLabels(), presetName = HIGHLIGHT_PRESETS.find(([, hex]) => hex === chosen)?.[0] || 'Personalizado';

  function rememberSelection() {
    const current = window.getSelection();
    selection.current = current?.rangeCount && !current.isCollapsed ? current.getRangeAt(0).cloneRange() : null;
  }
  function preserveSelection() {
    const range = selection.current;
    if (!range?.startContainer.isConnected || !range.endContainer.isConnected) return;
    const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(range);
  }
  function dismiss(returnFocus = false) {
    setOpen(false);
    if (returnFocus) { trigger.current?.focus({ preventScroll: true }); preserveSelection(); }
  }
  function choose(hex: string, close = true) {
    if (!validColor(hex) || disabled) return;
    onChange(hex.toLowerCase()); preserveSelection();
    if (close) dismiss(restoreFocus.current);
  }
  function show(keyboard: boolean) {
    if (disabled) return;
    rememberSelection(); restoreFocus.current = keyboard; setOpen(true);
  }

  useLayoutEffect(() => {
    if (!open || !palette.current || !trigger.current) return;
    const update = () => {
      const anchor = trigger.current!.getBoundingClientRect(), box = palette.current!.getBoundingClientRect();
      const bounds = visibleBounds();
      setPosition({ left: Math.max(bounds.left + 8, Math.min(bounds.right - box.width - 8, anchor.left)), top: Math.max(bounds.top + 8, Math.min(bounds.bottom - box.height - 8, anchor.bottom + box.height + 8 <= bounds.bottom ? anchor.bottom + 5 : anchor.top - box.height - 5)) });
    };
    update();
    if (restoreFocus.current) palette.current.querySelector<HTMLButtonElement>('button[aria-pressed=true]')?.focus({ preventScroll: true });
    if (restoreFocus.current && !palette.current.contains(document.activeElement)) palette.current.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => { window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (palette.current?.contains(event.target as Node) || trigger.current?.contains(event.target as Node)) return;
      // A tap on the page only closes the palette, without starting a selection.
      if (event.target instanceof Element && event.target.closest('.pdf-page')) { event.preventDefault(); event.stopPropagation(); }
      dismiss();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(restoreFocus.current); } };
    // Tabbing out of the palette closes it.
    const leave = (event: FocusEvent) => { const next = event.relatedTarget as Node | null; if (next && !palette.current?.contains(next) && !trigger.current?.contains(next)) dismiss(); };
    const node = palette.current;
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape); node?.addEventListener('focusout', leave);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); node?.removeEventListener('focusout', leave); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return <>
    <button ref={trigger} className={`highlight-color-trigger ${open ? 'active' : ''}`} aria-label="Color del resaltador" title="Color del resaltador" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={event => open ? dismiss() : show(event.detail === 0)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); show(true); } }}><span className="highlight-color-current" style={{ backgroundColor: chosen }} /><ChevronDown size={10} /></button>
    {open && createPortal(<div ref={palette} id={id} className="highlight-color-palette" role="dialog" aria-label="Colores del resaltador" style={position} onMouseDown={event => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); }} onKeyDown={event => {
      if (event.target instanceof HTMLInputElement) return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.highlight-color-presets button')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement), index = Math.max(0, current);
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -6 : 6) + buttons.length) % buttons.length;
      buttons[target]?.focus({ preventScroll: true });
    }}>
      <strong>Resaltador</strong><div className="highlight-color-presets">{HIGHLIGHT_PRESETS.map(([name, hex]) => <button key={name} aria-label={`Color ${name}`} title={labels[hex] ? `${name} · ${labels[hex]}` : name} aria-pressed={chosen === hex} onClick={() => choose(hex)}><span style={{ backgroundColor: hex }}>{chosen === hex && <Check size={14} />}</span></button>)}</div>
      {/* What the chosen color means; shown in the annotations list and the exported summary. */}
      <label className="highlight-meaning" style={{ '--swatch': chosen } as React.CSSProperties}><span aria-hidden="true" /><input aria-label={`Significado del color ${presetName}`} placeholder={`Significado del ${presetName.toLowerCase()}`} maxLength={40} value={labels[chosen] || ''} onChange={event => setHighlightLabel(chosen, event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); dismiss(restoreFocus.current); } }} /></label>
      <label className="highlight-color-custom"><span>Personalizado</span><input type="color" aria-label="Color personalizado del resaltador" value={chosen} onChange={event => choose(event.target.value, false)} /></label>
    </div>, document.body)}
  </>;
}
