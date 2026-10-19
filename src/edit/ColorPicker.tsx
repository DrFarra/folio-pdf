import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Pipette } from 'lucide-react';
import { visibleBounds } from '../mobile';

// Editar's colour field: a swatch that opens document colours and a custom one.

const PRESETS = [
  ['Negro', '#000000'],
  ['Gris oscuro', '#404040'],
  ['Gris', '#7f7f7f'],
  ['Gris claro', '#bfbfbf'],
  ['Blanco', '#ffffff'],
  ['Rojo', '#d32f2f'],
  ['Naranja', '#ef6c00'],
  ['Amarillo', '#f9c623'],
  ['Verde', '#2e7d32'],
  ['Turquesa', '#00838f'],
  ['Azul', '#1565c0'],
  ['Azul marino', '#1a237e'],
  ['Violeta', '#6a1b9a'],
  ['Rosa', '#c2185b'],
  ['Marrón', '#6d4c41'],
] as const;
const COLUMNS = 5;
const validColor = (hex: string) => /^#[0-9a-f]{6}$/i.test(hex);
type Dropper = { open: () => Promise<{ sRGBHex: string }> };
const EyeDropper = (window as unknown as { EyeDropper?: new () => Dropper }).EyeDropper;

export default function ColorPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: -1000, top: -1000 });
  const [typed, setTyped] = useState('');
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null),
    keyboard = useRef(false);
  const current = value && validColor(value) ? value.toLowerCase() : null;

  function dismiss(returnFocus = keyboard.current) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus({ preventScroll: true });
  }
  function choose(hex: string, close: boolean) {
    if (!validColor(hex)) return;
    onChange(hex.toLowerCase());
    if (close) dismiss();
  }

  useEffect(() => {
    if (open) setTyped(current?.slice(1) ?? '');
  }, [open, current]);
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect(),
      box = panel.current.getBoundingClientRect(),
      bounds = visibleBounds();
    setPosition({
      left: Math.max(bounds.left + 8, Math.min(bounds.right - box.width - 8, anchor.left)),
      top:
        anchor.bottom + box.height + 6 <= bounds.bottom
          ? anchor.bottom + 6
          : Math.max(bounds.top + 8, anchor.top - box.height - 6),
    });
    if (keyboard.current)
      (
        panel.current.querySelector<HTMLButtonElement>('[aria-pressed=true]') ?? panel.current.querySelector('button')
      )?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
      // A click on the page only closes the colours, without selecting something else.
      if (target instanceof Element && target.closest('.pdf-page')) {
        event.preventDefault();
        event.stopPropagation();
      }
      dismiss(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`edit-color ${open ? 'open' : ''}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={event => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={event => {
          keyboard.current = event.detail === 0;
          if (open) dismiss(false);
          else setOpen(true);
        }}
      >
        <span className={current ? '' : 'empty'} style={current ? { background: current } : undefined} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            className="edit-color-panel"
            role="dialog"
            aria-label={label}
            style={position}
            // Inside a portal React still bubbles to the toolbar: keep its handlers out.
            onMouseDown={event => {
              event.stopPropagation();
              if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
            }}
            onPointerDown={event => event.stopPropagation()}
            onKeyDown={event => {
              event.stopPropagation();
              if (
                event.target instanceof HTMLInputElement ||
                !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
              )
                return;
              event.preventDefault();
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('.edit-color-presets button'),
              ];
              const index = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
              const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS }[event.key]!;
              buttons[(index + step + buttons.length) % buttons.length]?.focus({ preventScroll: true });
            }}
          >
            <strong>{label}</strong>
            <div className="edit-color-presets">
              {PRESETS.map(([name, hex]) => (
                <button
                  key={hex}
                  type="button"
                  aria-label={name}
                  title={name}
                  aria-pressed={current === hex}
                  style={{ '--swatch': hex } as React.CSSProperties}
                  onClick={() => choose(hex, true)}
                >
                  {current === hex && <Check size={13} />}
                </button>
              ))}
            </div>
            <div className="edit-color-custom">
              <label
                className="edit-color-native"
                title="Elegir cualquier color"
                style={{ '--swatch': current ?? '#ffffff' } as React.CSSProperties}
              >
                <input
                  type="color"
                  aria-label="Color personalizado"
                  value={current ?? '#ffffff'}
                  onChange={event => choose(event.target.value, false)}
                />
              </label>
              <label className="edit-color-hex">
                <span>#</span>
                <input
                  aria-label="Código hexadecimal"
                  maxLength={6}
                  spellCheck={false}
                  value={typed}
                  onChange={event => {
                    const hex = event.target.value.replace(/[^0-9a-f]/gi, '');
                    setTyped(hex);
                    if (hex.length === 6) choose(`#${hex}`, false);
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      dismiss();
                    }
                  }}
                />
              </label>
              {EyeDropper && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Tomar un color de la pantalla"
                  title="Tomar un color de la pantalla"
                  onClick={() =>
                    void new EyeDropper().open().then(
                      found => choose(found.sRGBHex, false),
                      () => undefined,
                    )
                  }
                >
                  <Pipette size={15} />
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
