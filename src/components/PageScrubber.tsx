import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import './PageScrubber.css';

type Props = {
  pdf: PDFDocumentProxy; page: number; pages: number; viewer: HTMLElement | null; continuous: boolean;
  label: (page: number) => string; section?: (page: number) => string | undefined; onJump: (page: number) => void;
};

/** Touch page scrubber on the right edge. It appears while the document
 * scrolls and fades after a moment, so it never sits on the page while
 * reading; dragging it previews the target page and jumps on release. */
export function PageScrubber({ pdf, page, pages, viewer, continuous, label, section, onJump }: Props) {
  const [shown, setShown] = useState(false);
  const [scrolled, setScrolled] = useState(0);
  const [drag, setDrag] = useState<{ fraction: number; target: number } | null>(null);
  const track = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), hide = useRef(0), pointer = useRef<number | null>(null);
  const reveal = (ms = 1400) => { setShown(true); window.clearTimeout(hide.current); hide.current = window.setTimeout(() => setShown(false), ms); };
  useEffect(() => {
    if (!viewer) return;
    const scroll = () => { const max = viewer.scrollHeight - viewer.clientHeight; setScrolled(max > 0 ? viewer.scrollTop / max : 0); if (pointer.current === null) reveal(); };
    viewer.addEventListener('scroll', scroll, { passive: true });
    return () => { viewer.removeEventListener('scroll', scroll); window.clearTimeout(hide.current); };
  }, [viewer]);
  // A continuous document follows its scroll; single-page reading follows the page.
  const position = drag ? drag.fraction : continuous ? scrolled : pages > 1 ? (page - 1) / (pages - 1) : 0;

  // The preview renders the page under the finger, replacing any earlier render.
  useEffect(() => {
    if (!drag || !canvas.current) return;
    let task: RenderTask | null = null, alive = true;
    const timer = window.setTimeout(() => {
      void pdf.getPage(drag.target).then(loaded => {
        const node = canvas.current; if (!alive || !node) return;
        const unscaled = loaded.getViewport({ scale: 1 }), view = loaded.getViewport({ scale: 76 / unscaled.width }), dpr = Math.min(window.devicePixelRatio || 1, 2);
        node.width = Math.round(view.width * dpr); node.height = Math.round(view.height * dpr); node.style.aspectRatio = `${view.width} / ${view.height}`;
        task = loaded.render({ canvas: node, viewport: view, transform: [dpr, 0, 0, dpr, 0, 0] });
        task.promise.catch(() => {});
      }).catch(() => {});
    }, 50);
    return () => { alive = false; window.clearTimeout(timer); task?.cancel(); };
  }, [drag?.target, pdf]);

  const at = (clientY: number) => {
    const box = track.current!.getBoundingClientRect(), fraction = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
    return { fraction, target: Math.min(pages, Math.max(1, Math.round(fraction * (pages - 1)) + 1)) };
  };
  if (pages < 3) return null;
  const target = drag?.target ?? page, chapter = section?.(target);
  return <div className={`page-scrubber${shown || drag ? ' shown' : ''}${drag ? ' dragging' : ''}`} aria-hidden="true">
    <div ref={track} className="page-scrubber-track"
      onPointerDown={event => { if (!event.isPrimary) return; event.preventDefault(); event.stopPropagation(); pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); setDrag(at(event.clientY)); setShown(true); window.clearTimeout(hide.current); }}
      onPointerMove={event => { if (pointer.current !== event.pointerId) return; event.preventDefault(); setDrag(at(event.clientY)); }}
      onPointerUp={event => { if (pointer.current !== event.pointerId) return; pointer.current = null; const end = at(event.clientY); setDrag(null); reveal(1200); if (end.target !== page) onJump(end.target); }}
      onPointerCancel={() => { pointer.current = null; setDrag(null); reveal(800); }}>
      <span className="page-scrubber-handle" style={{ top: `${position * 100}%` }}>
        {drag && <span className="page-scrubber-bubble">
          <canvas ref={canvas} />
          <span><strong>Pág. {label(target)}</strong><small>de {pages}</small>{chapter && <em>{chapter}</em>}</span>
        </span>}
      </span>
    </div>
  </div>;
}
