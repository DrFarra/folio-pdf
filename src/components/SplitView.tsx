import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { ArrowLeftRight, FolderOpen, Minus, Plus, X } from 'lucide-react';
import IconButton from './IconButton';
import './SplitView.css';

type Option = { key: string; name: string };
type Watch = (node: Element, listener: (near: boolean) => void) => () => void;

/** A second document (or the same one at another page) beside the reader, to
 * read and compare at once. It only reads: annotating and tools stay in the reader. */
export default function SplitView({
  pdf,
  current,
  options,
  onChoose,
  onOpen,
  onSwap,
  onClose,
}: {
  pdf: PDFDocumentProxy;
  current: string;
  options: Option[];
  onChoose: (key: string) => void;
  onOpen: () => void;
  /** Swaps this document with the reader's; absent when both show the same one. */
  onSwap?: () => void;
  onClose: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [ratio, setRatio] = useState(1.414);
  const [page, setPage] = useState(1);
  // One observer for every page: a long book would otherwise hold thousands.
  const [watch, setWatch] = useState<Watch | null>(null);
  useLayoutEffect(() => {
    const listeners = new Map<Element, (near: boolean) => void>();
    // Drawn within a screen of the visible area; released beyond it, so a long book stays light.
    const observer = new IntersectionObserver(
      entries => entries.forEach(entry => listeners.get(entry.target)?.(entry.isIntersecting)),
      { root: scroller.current, rootMargin: '100% 0px' },
    );
    setWatch(() => (node: Element, listener: (near: boolean) => void) => {
      listeners.set(node, listener);
      observer.observe(node);
      return () => {
        listeners.delete(node);
        observer.unobserve(node);
      };
    });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = scroller.current!;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Placeholders take the first page's shape until each page is drawn.
  useEffect(() => {
    let alive = true;
    setPage(1);
    scroller.current?.scrollTo({ top: 0 });
    void pdf
      .getPage(1)
      .then(first => {
        const view = first.getViewport({ scale: 1 });
        if (alive) setRatio(view.height / view.width);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pdf]);
  const pageWidth = Math.max(120, Math.round((width - 24) * zoom));
  const track = () => {
    const node = scroller.current;
    if (!node) return;
    const middle = node.scrollTop + node.clientHeight / 3;
    let found = 1;
    for (const child of node.querySelectorAll<HTMLElement>('[data-split-page]')) {
      if (child.offsetTop > middle) break;
      found = Number(child.dataset.splitPage);
    }
    setPage(found);
  };
  return (
    <section className="split-view" aria-label="Vista dividida">
      <header className="split-view-bar">
        <select
          aria-label="Documento de la vista dividida"
          value={current}
          onChange={event => onChoose(event.target.value)}
        >
          {options.map(option => (
            <option key={option.key} value={option.key}>
              {option.name}
            </option>
          ))}
        </select>
        {onSwap && (
          <IconButton label="Pasar este PDF al lector" onClick={onSwap}>
            <ArrowLeftRight size={17} />
          </IconButton>
        )}
        <IconButton label="Abrir otro PDF en el lector" onClick={onOpen}>
          <FolderOpen size={17} />
        </IconButton>
        <span className="split-view-page" aria-live="polite">
          {page} / {pdf.numPages}
        </span>
        <IconButton
          label="Reducir zoom de la vista dividida"
          disabled={zoom <= 0.5}
          onClick={() => setZoom(z => z - 0.25)}
        >
          <Minus size={16} />
        </IconButton>
        <IconButton
          label="Ampliar zoom de la vista dividida"
          disabled={zoom >= 3}
          onClick={() => setZoom(z => z + 0.25)}
        >
          <Plus size={16} />
        </IconButton>
        <IconButton label="Cerrar vista dividida" onClick={onClose}>
          <X size={17} />
        </IconButton>
      </header>
      <div className="split-view-pages" ref={scroller} onScroll={track} tabIndex={-1}>
        {width > 0 &&
          watch &&
          Array.from({ length: pdf.numPages }, (_, index) => (
            <SplitPage key={index + 1} pdf={pdf} number={index + 1} width={pageWidth} ratio={ratio} watch={watch} />
          ))}
      </div>
    </section>
  );
}

const SplitPage = memo(function SplitPage({
  pdf,
  number,
  width,
  ratio,
  watch,
}: {
  pdf: PDFDocumentProxy;
  number: number;
  width: number;
  ratio: number;
  watch: Watch;
}) {
  const node = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => watch(node.current!, setNear), [watch]);
  useEffect(() => {
    const target = canvas.current;
    if (!near || !target) return;
    let task: RenderTask | null = null,
      alive = true;
    void pdf
      .getPage(number)
      .then(loaded => {
        if (!alive) return;
        const view = loaded.getViewport({ scale: width / loaded.getViewport({ scale: 1 }).width }),
          dpr = Math.min(window.devicePixelRatio || 1, 2);
        setHeight(view.height);
        target.width = Math.round(view.width * dpr);
        target.height = Math.round(view.height * dpr);
        task = loaded.render({ canvas: target, viewport: view, transform: [dpr, 0, 0, dpr, 0, 0] });
        task.promise.catch(() => {});
      })
      .catch(() => {});
    return () => {
      alive = false;
      task?.cancel();
      target.width = 0;
      target.height = 0;
    };
  }, [near, pdf, number, width]);
  return (
    <div
      ref={node}
      className="split-view-page-frame"
      data-split-page={number}
      style={{ width, height: height ?? Math.round(width * ratio) }}
    >
      <canvas ref={canvas} aria-label={`Página ${number}`} />
    </div>
  );
});
