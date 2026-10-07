import { useEffect, useState } from 'react';
import { selectedTextRects } from '../text-selection';

/** While a selection is kept to one column, the browser would still paint
 * the text in between (another column's line). Its native color is hidden
 * and the kept lines are drawn instead, exactly what a highlight will cover. */
export function ColumnSelectionPreview() {
  const [preview, setPreview] = useState<{ rects: DOMRect[]; highlight: boolean } | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const selection = window.getSelection(), root = document.documentElement;
      let next: typeof preview = null;
      if (selection?.rangeCount && !selection.isCollapsed) {
        const range = selection.getRangeAt(0), layers = document.querySelectorAll<HTMLElement>('.textLayer[data-copy-allowed=true]');
        const rects: DOMRect[] = []; let clipped = false;
        for (const layer of layers) { const result = selectedTextRects(layer, range); if (result) { rects.push(...result.rects); clipped ||= result.clipped; } }
        const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
        if (clipped) next = { rects, highlight: !!start?.closest('.page-content.tool-highlight') };
      }
      root.classList.toggle('selection-clipped', !!next);
      setPreview(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    document.addEventListener('selectionchange', schedule); window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('selectionchange', schedule); window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); document.documentElement.classList.remove('selection-clipped'); };
  }, []);
  if (!preview) return null;
  return <div className={`column-selection-preview${preview.highlight ? ' highlight' : ''}`} aria-hidden="true">
    {preview.rects.map((rect, index) => <span key={index} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />)}
  </div>;
}
