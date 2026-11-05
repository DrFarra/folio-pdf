import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import type { Annotation } from '../types';
import { DEFAULT_HIGHLIGHT_OPACITY } from '../engine/highlight-style.mjs';
import { ArrowLeftRight, FolderOpen, Minus, Plus, X } from 'lucide-react';
import IconButton from './IconButton';
import './SplitView.css';

type Option = { key: string; name: string };
type Watch = (node: Element, listener: (near: boolean) => void) => () => void;

/** A second document (or the same one at another page) beside the reader, to
 * read and compare at once. It only reads: annotating and tools stay in the reader. */
const NONE: Annotation[] = [];

export default function SplitView({
  pdf,
  annotations,
  current,
  options,
  onChoose,
  onOpen,
  onSwap,
  onClose,
}: {
  pdf: PDFDocumentProxy;
  /** Folio's own marks, which the PDF.js copy leaves out: they are drawn over the pages. */
  annotations: Annotation[];
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
  const byPage = useMemo(() => {
    const pages = new Map<number, Annotation[]>();
    for (const annotation of annotations)
      pages.set(annotation.page, [...(pages.get(annotation.page) ?? []), annotation]);
    return pages;
  }, [annotations]);
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
            <SplitPage
              key={index + 1}
              pdf={pdf}
              number={index + 1}
              width={pageWidth}
              ratio={ratio}
              watch={watch}
              annotations={byPage.get(index + 1) ?? NONE}
            />
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
  annotations,
}: {
  pdf: PDFDocumentProxy;
  number: number;
  width: number;
  ratio: number;
  watch: Watch;
  annotations: Annotation[];
}) {
  const node = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [view, setView] = useState<PageViewport | null>(null);
  const height = view?.height ?? null;
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
        setView(view);
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
      {near && view && annotations.length > 0 && <Marks view={view} annotations={annotations} />}
    </div>
  );
});

/** Highlights, ink, shapes and note markers as the reader draws them, without their controls. */
function Marks({ view, annotations }: { view: PageViewport; annotations: Annotation[] }) {
  const at = (x: number, y: number) => view.convertToViewportPoint(x, y) as [number, number];
  const box = (rect: number[]) => {
    const [a, b] = [at(rect[0], rect[1]), at(rect[2], rect[3])];
    return {
      x: Math.min(a[0], b[0]),
      y: Math.min(a[1], b[1]),
      width: Math.abs(a[0] - b[0]),
      height: Math.abs(a[1] - b[1]),
    };
  };
  const points = (values: number[]) => {
    const out: string[] = [];
    for (let i = 0; i + 1 < values.length; i += 2) out.push(at(values[i], values[i + 1]).join(','));
    return out.join(' ');
  };
  return (
    <svg className="split-view-marks" viewBox={`0 0 ${view.width} ${view.height}`} aria-hidden="true">
      {annotations.map(mark => {
        const opacity = mark.opacity ?? DEFAULT_HIGHLIGHT_OPACITY;
        if (mark.kind === 'highlight')
          return mark.quads?.length ? (
            mark.quads.map((quad, index) => (
              <polygon
                key={`${mark.id}-${index}`}
                className="split-view-highlight"
                // A quad's corners run top-left, top-right, bottom-left, bottom-right.
                points={points([quad[0], quad[1], quad[2], quad[3], quad[6], quad[7], quad[4], quad[5]])}
                fill={mark.color}
                opacity={opacity}
              />
            ))
          ) : (
            <rect
              key={mark.id}
              className="split-view-highlight"
              {...box(mark.rect)}
              fill={mark.color}
              opacity={opacity}
            />
          );
        if (mark.kind === 'ink')
          return (mark.inkPaths ?? []).map((path, index) => (
            <polyline
              key={`${mark.id}-${index}`}
              points={points(path)}
              fill="none"
              stroke={mark.color}
              strokeWidth={(mark.strokeWidth ?? 2) * view.scale}
              strokeOpacity={mark.opacity ?? 1}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ));
        if (mark.kind === 'shape') {
          const stroke = {
            stroke: mark.color,
            strokeWidth: (mark.strokeWidth ?? 1) * view.scale,
            fill: mark.fill || 'none',
          };
          if ((mark.shape === 'line' || mark.shape === 'arrow') && mark.line)
            return <polyline key={mark.id} points={points(mark.line)} {...stroke} fill="none" />;
          const area = box(mark.rect);
          return mark.shape === 'ellipse' ? (
            <ellipse
              key={mark.id}
              cx={area.x + area.width / 2}
              cy={area.y + area.height / 2}
              rx={area.width / 2}
              ry={area.height / 2}
              {...stroke}
            />
          ) : (
            <rect key={mark.id} {...area} {...stroke} />
          );
        }
        const [x, y] = at(mark.rect[0], mark.rect[1]);
        return (
          <rect key={mark.id} className="split-view-note" x={x} y={y} width={14} height={14} rx={3} fill={mark.color} />
        );
      })}
    </svg>
  );
}
