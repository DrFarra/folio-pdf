import { useCallback, useEffect, useState } from 'react';
import { INK_DEFAULTS, inkRange, type InkKind, type InkStyle } from '../components/DrawingSettings';
import { preference } from '../preferences';

// Fingers draw until a pen appears; an explicit choice always wins. The old
// folio.ink.penOnly default was stored unasked, so only its 'false' is a choice.
const penMode = () => preference('folio.ink.penMode', preference('folio.ink.penOnly', '') === 'false' ? 'finger' : '');

function savedStyles(): Record<InkKind, InkStyle> {
  // Older versions kept one pen color and width; they become the pen's style.
  const legacy = { ...INK_DEFAULTS.pen, color: preference('folio.ink.color', INK_DEFAULTS.pen.color), width: Number(preference('folio.ink.width', '2')) || 2 };
  let saved: Partial<Record<InkKind, Partial<InkStyle>>> = {};
  try { saved = JSON.parse(preference('folio.ink.styles', '{}')) || {}; } catch {}
  const valid = (kind: InkKind, style: Partial<InkStyle> | undefined, fallback: InkStyle): InkStyle => {
    const range = inkRange(kind), width = Number(style?.width), opacity = Number(style?.opacity);
    return { color: typeof style?.color === 'string' && /^#[0-9a-f]{6}$/i.test(style.color) ? style.color.toLowerCase() : fallback.color,
      width: Number.isFinite(width) ? Math.min(range.max, Math.max(range.min, width)) : fallback.width, opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(.1, opacity)) : fallback.opacity };
  };
  return { pen: valid('pen', saved.pen, legacy), marker: valid('marker', saved.marker, INK_DEFAULTS.marker) };
}

function savedRecentColors(): string[] {
  try { const value = JSON.parse(preference('folio.ink.recentColors', '[]')); return Array.isArray(value) ? value.filter(item => typeof item === 'string' && /^#[0-9a-f]{6}$/.test(item)).slice(0, 5) : []; } catch { return []; }
}

/** The drawing tools' choices (pen or marker, each one's style, recent colours, eraser size,
 * whether only a pen draws), kept across sessions. The first pen seen makes the pen the one
 * that draws, unless that was already chosen. */
export function useInkPreferences() {
  const [inkKind, setInkKind] = useState<InkKind>(() => preference('folio.ink.kind', 'pen') === 'marker' ? 'marker' : 'pen');
  const [inkStyles, setInkStyles] = useState(savedStyles);
  const [inkRecentColors, setInkRecentColors] = useState(savedRecentColors);
  const [eraserSize, setEraserSize] = useState(() => Number(preference('folio.ink.eraserSize', '16')) || 16);
  const [penOnly, setPenOnly] = useState(() => penMode() === 'pen');
  const choosePenOnly = useCallback((value: boolean) => { setPenOnly(value); try { localStorage.setItem('folio.ink.penMode', value ? 'pen' : 'finger'); } catch {} }, []);
  const [penDetected, setPenDetected] = useState(false);
  useEffect(() => {
    const detect = (event: PointerEvent) => { if (event.pointerType !== 'pen') return; setPenDetected(true); if (!penMode()) choosePenOnly(true); };
    window.addEventListener('pointerover', detect, { passive: true, capture: true });
    window.addEventListener('pointerdown', detect, { passive: true, capture: true });
    return () => { window.removeEventListener('pointerover', detect, true); window.removeEventListener('pointerdown', detect, true); };
  }, [choosePenOnly]);
  useEffect(() => { try { localStorage.setItem('folio.ink.kind', inkKind); localStorage.setItem('folio.ink.styles', JSON.stringify(inkStyles)); localStorage.setItem('folio.ink.recentColors', JSON.stringify(inkRecentColors)); localStorage.setItem('folio.ink.eraserSize', String(eraserSize)); } catch {} }, [inkKind, inkStyles, inkRecentColors, eraserSize]);
  return { inkKind, setInkKind, inkStyles, setInkStyles, inkStyle: inkStyles[inkKind], inkRecentColors, setInkRecentColors, eraserSize, setEraserSize, penOnly, choosePenOnly, penDetected };
}
