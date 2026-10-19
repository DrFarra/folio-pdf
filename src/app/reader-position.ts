import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { openExternalUrl } from '../platform';
import type { LoadedDocument, PDFNavigationTarget } from '../types';
import type { Notify } from './notices';
import { useLatest } from './latest';

type ScrollTo = { key: string; top: number; left: number };
type ReturnLocation = { key: string; page: number; top: number; left: number };

type Position = {
  viewer: RefObject<HTMLDivElement | null>;
  doc: LoadedDocument | null; page: number; setPage: (page: number) => void;
  readingMode: string; rotation: number;
  /** The phone's header overlays the reader: pages are placed below it. */
  phone: boolean;
  /** The document and page in front right now (they change before a render does), and the tab. */
  current: () => LoadedDocument | null; currentPage: () => number; activeKey: () => string | null;
  /** The zoom the reader draws at, and whether jumps may scroll smoothly. */
  scale: () => number; smoothScroll: () => boolean;
  /** Scrolls the reader by a distance (see usePageTracking). */
  scrollBy: (root: HTMLElement, distance: number | null, smooth: boolean) => void;
  notify: Notify;
};

/** Where the reader is: the page it shows and jumps to, the page-number field, the scroll a
 * document reopens at, «Volver a p. N» after a jump, and the PDF's own links. */
export function useReaderPosition(options: Position) {
  const { viewer, doc, page, setPage, readingMode, rotation } = options;
  const live = useLatest(options);
  const [pageInput, setPageInput] = useState('1');
  // The field holds what is typed until it is committed.
  const pageInputDirty = useRef(false);
  /** Where a document shown next should scroll to (its tab's place), instead of its first page. */
  const restoreScroll = useRef<ScrollTo | null>(null);
  const restoreFrame = useRef<number | null>(null);
  const [returnLocation, setReturnLocation] = useState<ReturnLocation | null>(null);

  const cancelScrollRestore = useCallback(() => { if (restoreFrame.current !== null) { cancelAnimationFrame(restoreFrame.current); restoreFrame.current = null; } }, []);
  // The phone header overlays the reader and the notch; pages are placed below it.
  const readingInset = useCallback(() => {
    const header = live.current.phone ? document.querySelector('.app-header') : null;
    return header && viewer.current ? header.getBoundingClientRect().bottom - viewer.current.getBoundingClientRect().top + 12 : 16;
  }, [viewer]);
  const goToPage = useCallback((number: number, smooth = true, keepScrollRestore = false) => {
    const pdf = live.current.current()?.pdf;
    if (!pdf || !viewer.current) return;
    if (!keepScrollRestore) cancelScrollRestore();
    pageInputDirty.current = false;
    const next = Math.max(1, Math.min(pdf.numPages, number));
    setPage(next); setPageInput(String(next));
    const root = viewer.current, node = root.querySelector<HTMLElement>(`[data-page-number="${next}"]`);
    const distance = node ? node.getBoundingClientRect().top - root.getBoundingClientRect().top - readingInset() : null;
    // While a smooth jump passes other pages, the counter keeps the target and «Volver a p. N» stays.
    live.current.scrollBy(root, distance, smooth && distance !== null && live.current.smoothScroll() && Math.abs(distance) < root.clientHeight * 4 && !matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, [viewer, setPage, readingInset, cancelScrollRestore]);

  /** Typing in the page field; `commitPageInput` goes there (or puts the page back). */
  const editPageInput = useCallback((value: string) => { pageInputDirty.current = true; setPageInput(value); }, []);
  const showPageInput = useCallback((number: number) => { pageInputDirty.current = false; setPageInput(String(number)); }, []);
  const commitPageInput = () => {
    pageInputDirty.current = false;
    const next = Number(pageInput);
    if (Number.isInteger(next) && next > 0) goToPage(next);
    else setPageInput(String(page));
  };
  useEffect(() => { if (!pageInputDirty.current) setPageInput(String(page)); }, [page]);

  useLayoutEffect(() => {
    if (readingMode === 'single' && viewer.current) viewer.current.scrollTop = 0;
  }, [page, readingMode, viewer]);
  useEffect(() => {
    if (live.current.current()) goToPage(live.current.currentPage(), false, true);
  }, [readingMode, goToPage]);

  // A document the reader opens is shown where it was left; new bytes for the same
  // reader copy (Editar writing its changes) leave the view where it is.
  const scrolledPdf = useRef<PDFDocumentProxy | null>(null);
  useEffect(() => {
    if (!doc || scrolledPdf.current === doc.pdf) return;
    scrolledPdf.current = doc.pdf;
    const restored = restoreScroll.current;
    restoreScroll.current = null;
    const frame = requestAnimationFrame(() => {
      restoreFrame.current = null;
      if (restored?.key === live.current.activeKey() && viewer.current) viewer.current.scrollTo({ top: restored.top, left: restored.left, behavior: 'instant' });
      else goToPage(doc.initialPage, false);
    });
    restoreFrame.current = frame;
    return () => { cancelAnimationFrame(frame); if (restoreFrame.current === frame) restoreFrame.current = null; };
  }, [doc, goToPage, viewer]);

  // Reaching the remembered page again, by any means, retires «Volver a p. N»; so does another document.
  useEffect(() => { setReturnLocation(current => current?.page === page ? null : current); }, [page]);
  useEffect(() => setReturnLocation(null), [doc?.pdf]);
  /** Remembers where the reader is before a jump, for «Volver a p. N». */
  const rememberLocation = useCallback(() => {
    const key = live.current.activeKey();
    if (key && viewer.current) setReturnLocation({ key, page: live.current.currentPage(), top: viewer.current.scrollTop, left: viewer.current.scrollLeft });
  }, [viewer]);
  /** The page «Volver a p. N» returns to, when it is in this tab and not the page shown. */
  const returnPage = returnLocation && returnLocation.key === live.current.activeKey() && returnLocation.page !== page ? returnLocation.page : null;
  /** Goes back to the remembered place (`before` runs first, when there is one). */
  const returnToLocation = (before?: () => void) => {
    if (!returnLocation || returnLocation.key !== live.current.activeKey()) return;
    before?.();
    goToPage(returnLocation.page, false); const location = returnLocation; setReturnLocation(null);
    requestAnimationFrame(() => viewer.current?.scrollTo({ top: location.top, left: location.left, behavior: 'instant' }));
  };

  /** Follows a link in the PDF: to a place in it (remembered for «Volver»), or out to the web. */
  const navigate = (destination: PDFNavigationTarget) => {
    if ('url' in destination) { void openExternalUrl(destination.url).catch(() => live.current.notify('No se pudo abrir el enlace.', 'error')); return; }
    rememberLocation(); goToPage(destination.page, false);
    if (destination.top !== undefined && doc) void doc.pdf.getPage(destination.page).then(pdfPage => {
      requestAnimationFrame(() => {
        const node = viewer.current?.querySelector<HTMLElement>(`[data-page-number="${destination.page}"] .page-content`);
        if (!node || !viewer.current) return;
        const point = pdfPage.getViewport({ scale: live.current.scale(), rotation: (pdfPage.rotate + rotation) % 360 }).convertToViewportPoint(destination.left || 0, destination.top!);
        const box = node.getBoundingClientRect(), bounds = viewer.current.getBoundingClientRect();
        viewer.current.scrollTo({ top: viewer.current.scrollTop + box.top - bounds.top + point[1] - readingInset() - 8, behavior: 'instant' });
      });
    }).catch(() => {});
  };

  return { pageInput, setPageInput, pageInputDirty, editPageInput, showPageInput, commitPageInput, goToPage, restoreScroll, cancelScrollRestore,
    returnLocation, setReturnLocation, returnPage, rememberLocation, returnToLocation, navigate };
}
