import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Highlighter, MessageSquare } from 'lucide-react';
import { selectedTextRects } from '../text-selection';
import { visibleBounds } from '../mobile';
import { copyNativeText, isIOS, isNative } from '../platform';
import './TextSelectionMenu.css';

type Props = {
  enabled: boolean;
  canAnnotate: boolean;
  color: string;
  onHighlight: () => void;
  onComment: () => void;
  onNotify: (message: string, error?: boolean) => void;
};
type SelectedText = { range: Range; text: string; left: number; right: number; top: number; bottom: number };

function selectionDetails(): SelectedText | null {
  if (document.querySelector('dialog[open]')) return null;
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const layerFor = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>('.textLayer[data-copy-allowed=true]');
  if (!layerFor(range.startContainer)?.isConnected || !layerFor(range.endContainer)?.isConnected) return null;
  const selected = [...document.querySelectorAll<HTMLElement>('.textLayer[data-copy-allowed=true]')]
    .map(layer => {
      const geometry = selectedTextRects(layer, range);
      if (!geometry) return null;
      const bounds = document.createRange(); bounds.selectNodeContents(layer);
      const clipped = range.cloneRange();
      if (clipped.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) clipped.setStart(bounds.startContainer, bounds.startOffset);
      if (clipped.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) clipped.setEnd(bounds.endContainer, bounds.endOffset);
      const content = clipped.cloneContents();
      // PDF.js inserts line breaks independently from its text items. Preserve
      // those breaks without including page captions or the annotation limit.
      for (const br of content.querySelectorAll('br')) br.replaceWith('\n');
      return { ...geometry, text: content.textContent || '' };
    }).filter(item => !!item);
  const text = selected.map(item => item!.text).join('\n');
  const rects = selected.flatMap(item => item!.rects).filter(rect => rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth);
  if (!text.trim() || !rects.length) return null;
  const last = rects.at(-1)!;
  return { range, text, left: last.left, right: last.right, top: last.top, bottom: last.bottom };
}

export default function TextSelectionMenu({ enabled, canAnnotate, color, onHighlight, onComment, onNotify }: Props) {
  const [selected, setSelected] = useState<SelectedText | null>(null);
  const [position, setPosition] = useState({ left: -1000, top: -1000 });
  const menu = useRef<HTMLDivElement>(null);
  const moving = useRef(false);
  const touchHandled = useRef(false), ignoreClickUntil = useRef(0);

  useEffect(() => {
    if (!enabled) { setSelected(null); return; }
    let frame = 0, settle: ReturnType<typeof setTimeout> | undefined, escaped = false;
    const update = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = 0; setSelected(moving.current ? null : selectionDetails()); });
    };
    const pointerDown = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node)) return;
      moving.current = true; setSelected(null);
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
    };
    const pointerUp = () => { moving.current = false; update(); };
    // WebKit cancels a pointer when its native word-selection handles take
    // over. The Range remains valid and must still expose Folio's actions.
    const cancel = () => { moving.current = false; update(); };
    const dismiss = () => { setSelected(null); clearTimeout(settle); if (frame) { cancelAnimationFrame(frame); frame = 0; } };
    // Hide while the page moves and bring the menu back next to a selection
    // that is still visible once scrolling or zooming settles.
    const moved = () => { dismiss(); if (!escaped) settle = setTimeout(update, 150); };
    const selectionChange = () => { escaped = false; update(); };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { escaped = true; dismiss(); return; }
      if ((event.ctrlKey || event.metaKey) && ['+', '=', '-'].includes(event.key)) moved();
    };
    document.addEventListener('selectionchange', selectionChange);
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('pointerup', pointerUp);
    document.addEventListener('mouseup', pointerUp);
    document.addEventListener('touchend', pointerUp, { passive: true });
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('scroll', moved, true);
    document.addEventListener('wheel', moved, { passive: true });
    document.addEventListener('keydown', keyDown);
    window.addEventListener('resize', moved);
    window.addEventListener('folio:text-selection-finished', pointerUp);
    window.addEventListener('folio:pinch-start', dismiss);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(settle);
      document.removeEventListener('selectionchange', selectionChange);
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('pointerup', pointerUp);
      document.removeEventListener('mouseup', pointerUp);
      document.removeEventListener('touchend', pointerUp);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('scroll', moved, true);
      document.removeEventListener('wheel', moved);
      document.removeEventListener('keydown', keyDown);
      window.removeEventListener('resize', moved);
      window.removeEventListener('folio:text-selection-finished', pointerUp);
      window.removeEventListener('folio:pinch-start', dismiss);
    };
  }, [enabled]);

  useLayoutEffect(() => {
    if (!selected || !menu.current) return;
    const box = menu.current.getBoundingClientRect();
    const bounds = visibleBounds();
    const left = Math.max(bounds.left + 8, Math.min(bounds.right - box.width - 8, (selected.left + selected.right - box.width) / 2));
    const below = selected.bottom + 8;
    const top = Math.max(bounds.top + 8, Math.min(bounds.bottom - box.height - 8, below + box.height + 8 <= bounds.bottom ? below : selected.top - box.height - 8));
    setPosition({ left, top });
  }, [selected, canAnnotate]);

  function restoreSelection() {
    if (!selected || !selected.range.startContainer.isConnected || !selected.range.endContainer.isConnected) return false;
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(selected.range);
    return !!selection;
  }
  async function copy() {
    if (!selected || !restoreSelection()) return;
    let copied = false;
    try { if (isNative && isIOS) await copyNativeText(selected.text); else await navigator.clipboard.writeText(selected.text); copied = true; } catch {
      const active = document.activeElement as HTMLElement | null;
      const input = document.createElement('textarea');
      input.value = selected.text; input.setAttribute('aria-hidden', 'true'); input.tabIndex = -1;
      Object.assign(input.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
      document.body.append(input); input.select();
      try { copied = document.execCommand('copy'); } catch { copied = false; } finally { input.remove(); active?.focus({ preventScroll: true }); restoreSelection(); }
    }
    onNotify(copied ? 'Texto copiado.' : 'No se pudo copiar el texto.', !copied);
  }
  function touchAction(event: React.PointerEvent<HTMLButtonElement> | React.TouchEvent<HTMLButtonElement>, action: () => void) {
    if ('pointerType' in event && event.pointerType !== 'touch') return;
    event.preventDefault(); event.stopPropagation();
    if (touchHandled.current) return;
    touchHandled.current = true; ignoreClickUntil.current = Date.now() + 700; action();
  }
  const highlight = () => { if (restoreSelection()) onHighlight(); };
  const comment = () => { if (restoreSelection()) onComment(); };
  const clickAction = (action: () => void) => { if (Date.now() >= ignoreClickUntil.current) action(); };

  if (!enabled || !selected) return null;
  return createPortal(<div ref={menu} className="text-selection-menu" role="toolbar" aria-label="Herramientas del texto seleccionado" style={position} onPointerDown={event => { touchHandled.current = false; event.preventDefault(); }} onTouchStart={() => { touchHandled.current = false; }} onMouseDown={event => event.preventDefault()} onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') || [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowLeft' ? buttons.length - 1 : 1)) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  }}>
    <button aria-label="Copiar" onPointerUp={event => touchAction(event, () => void copy())} onTouchEnd={event => touchAction(event, () => void copy())} onClick={() => clickAction(() => void copy())}><Copy size={15} /><span>Copiar</span></button>
    {canAnnotate && <><button aria-label="Resaltar" onPointerUp={event => touchAction(event, highlight)} onTouchEnd={event => touchAction(event, highlight)} onClick={() => clickAction(highlight)}><Highlighter size={15} /><span>Resaltar</span><i style={{ backgroundColor: color }} /></button><button aria-label="Comentar" onPointerUp={event => touchAction(event, comment)} onTouchEnd={event => touchAction(event, comment)} onClick={() => clickAction(comment)}><MessageSquare size={15} /><span>Comentar</span></button></>}
  </div>, document.body);
}
