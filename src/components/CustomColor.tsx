import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import './CustomColor.css';

// Folio's own custom colour chooser: the system's (a dialog on Android, a
// sheet on iOS) is small, unlike the rest of the app, and reports no clear "done".

type Hsv = { h: number; s: number; v: number };
const clamp = (value: number) => Math.min(1, Math.max(0, value));
export const validColor = (hex: string) => /^#[0-9a-f]{6}$/i.test(hex);

export function toHsv(hex: string): Hsv {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b),
    delta = max - Math.min(r, g, b);
  let h = !delta ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  h *= 60;
  return { h: h < 0 ? h + 360 : h, s: max ? delta / max : 0, v: max };
}
export function toHex({ h, s, v }: Hsv) {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return '#' + [5, 3, 1].map(n => channel(n).toString(16).padStart(2, '0')).join('');
}

/** Saturation/brightness area, hue slider and hex field. Nothing is applied
 * until «Usar color», so a menu that closes on a choice is not closed mid-drag. */
export default function CustomColor({
  value,
  label,
  onPick,
  onCancel,
}: {
  value: string;
  label: string;
  onPick: (hex: string) => void;
  onCancel: () => void;
}) {
  const [hsv, setHsv] = useState(() => toHsv(validColor(value) ? value.toLowerCase() : '#3b82f6'));
  const [typed, setTyped] = useState(() => toHex(hsv).slice(1));
  const area = useRef<HTMLDivElement>(null);
  const hex = toHex(hsv);
  const update = (next: Hsv) => {
    setHsv(next);
    setTyped(toHex(next).slice(1));
  };
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = area.current!.getBoundingClientRect();
    update({
      h: hsv.h,
      s: clamp((event.clientX - box.left) / box.width),
      v: 1 - clamp((event.clientY - box.top) / box.height),
    });
  };
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02,
      move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
    if (!move) return;
    event.preventDefault();
    event.stopPropagation();
    update({ h: hsv.h, s: clamp(hsv.s + move[0]), v: clamp(hsv.v + move[1]) });
  };
  return (
    <div className="custom-color" role="group" aria-label={label}>
      <div
        ref={area}
        className="custom-color-area"
        role="slider"
        tabIndex={0}
        aria-label="Saturación y brillo"
        aria-valuetext={`Saturación ${Math.round(hsv.s * 100)} %, brillo ${Math.round(hsv.v * 100)} %`}
        style={{ '--hue': `hsl(${hsv.h} 100% 50%)` } as React.CSSProperties}
        onPointerDown={event => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus({ preventScroll: true });
          fromPointer(event);
        }}
        onPointerMove={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event);
        }}
        onKeyDown={nudge}
      >
        <span style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }} />
      </div>
      <input
        className="custom-color-hue"
        type="range"
        aria-label="Tono"
        min={0}
        max={359}
        value={Math.round(hsv.h)}
        onChange={event => update({ ...hsv, h: Number(event.target.value) })}
      />
      <div className="custom-color-row">
        <span className="custom-color-preview" style={{ background: hex }} aria-hidden="true" />
        <label className="custom-color-hex">
          <span>#</span>
          <input
            aria-label="Código hexadecimal"
            maxLength={6}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            value={typed}
            onChange={event => {
              const next = event.target.value.replace(/[^0-9a-f]/gi, '').toLowerCase();
              setTyped(next);
              if (next.length === 6) setHsv(toHsv(`#${next}`));
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onPick(hex);
              }
            }}
          />
        </label>
      </div>
      <div className="custom-color-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancelar
        </button>
        <button type="button" className="primary-button" onClick={() => onPick(hex)}>
          Usar color
        </button>
      </div>
    </div>
  );
}

/** The custom colours chosen last, newest first, kept per viewer under `key`. */
export function recentColors(key: string, limit: number): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value)
      ? value.filter(item => typeof item === 'string' && validColor(item)).slice(0, limit)
      : [];
  } catch {
    return [];
  }
}
export const withRecent = (colors: string[], hex: string, limit: number) =>
  [hex, ...colors.filter(item => item !== hex)].slice(0, limit);
