import { useCallback, useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { errorMessage } from '../errors';
import { markDrive, readCover, renderCover, saveCover } from '../library-meta';
import { isNativePdfDocument, subscribeNativePdfAnnotations } from '../nativePdf';
import { migrateLegacyNativePage } from '../native-session';
import { readOutline, readPageLabel, readPageLabels } from '../pdf';
import type { Annotation, LoadedDocument, OutlineEntry } from '../types';
import { annotationFingerprint } from './model';
import type { Notify } from './notices';
import { useLatest } from './latest';

/** Reads the document's outline when it opens (empty when it has none or it cannot be read). */
export function useOutlineLoader(doc: LoadedDocument | null, setOutline: (outline: OutlineEntry[]) => void) {
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    readOutline(doc.pdf)
      .then(data => {
        if (alive) setOutline(data);
      })
      .catch(() => {
        if (alive) setOutline([]);
      });
    return () => {
      alive = false;
    };
  }, [doc, setOutline]);
}

/** The outline heading a page belongs to. */
export function useOutlineSection(outline: OutlineEntry[] | null) {
  return useCallback(
    (target: number) => {
      let best: { title: string; page: number } | undefined;
      for (const entry of outline || [])
        if (entry.page !== null && entry.page <= target && (!best || entry.page >= best.page))
          best = { title: entry.title, page: entry.page };
      return best?.title;
    },
    [outline],
  );
}

/** The PDF's printed page labels (all of them, or only the current page's while they load). */
export function usePageLabels(pdf: PDFDocumentProxy | undefined, page: number) {
  const [labels, setLabels] = useState<string[] | null>(null);
  const [current, setCurrent] = useState('1');
  useEffect(() => {
    let alive = true;
    setLabels(null);
    if (pdf)
      void readPageLabels(pdf)
        .then(read => {
          if (alive) setLabels(read);
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pdf]);
  useEffect(() => {
    let alive = true;
    setCurrent(labels?.[page - 1] || String(page));
    if (pdf && !labels)
      void readPageLabel(pdf, page)
        .then(label => {
          if (alive) setCurrent(label);
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pdf, page, labels]);
  return { pageLabels: labels, currentPageLabel: current };
}

/** The library shows page one as each document's cover; it is rendered once, when idle. */
export function useLibraryCover(doc: LoadedDocument | null) {
  const latest = useLatest(doc);
  const id = doc?.id;
  useEffect(() => {
    const current = latest.current;
    if (!current || current.sample) return;
    if (current.drive) markDrive(current.id);
    let alive = true;
    const pdf = current.pdf,
      idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 600));
    void readCover(current.id).then(cover => {
      if (!cover && alive)
        idle(() => {
          if (alive)
            void renderCover(pdf).then(image => {
              if (image) void saveCover(current.id, image);
            });
        });
    });
    return () => {
      alive = false;
    };
  }, [id]);
}

/** iOS reads a file-backed PDF's own annotations page by page as PDFKit shows them: each
 * page's are added to Folio's (an older session's are matched up first) once. */
export function useNativeAnnotations(
  doc: LoadedDocument | null,
  annotations: {
    current: () => Annotation[];
    set: (next: Annotation[]) => void;
    shown: (doc: LoadedDocument) => boolean;
    notify: Notify;
  },
) {
  const live = useLatest(annotations);
  useEffect(() => {
    if (!doc || !isNativePdfDocument(doc.pdf)) return;
    return subscribeNativePdfAnnotations(doc.pdf, (number, originals) => {
      const { current, set, shown, notify } = live.current;
      if (!shown(doc)) return;
      const baseline = JSON.parse(doc.savedAnnotations) as unknown[][];
      const additions = JSON.parse(annotationFingerprint(originals)) as unknown[][];
      doc.savedAnnotations = JSON.stringify([
        ...baseline,
        ...additions.filter(item => !baseline.some(present => present[0] === item[0])),
      ]);
      if (doc.nativeKnownPages?.includes(number)) return;
      let next: Annotation[];
      try {
        next = doc.nativeLegacySession
          ? migrateLegacyNativePage(current(), number, originals)
          : [...current(), ...originals.filter(item => !current().some(present => present.id === item.id))];
      } catch (error) {
        notify(errorMessage(error, 'No se pudieron recuperar las anotaciones anteriores.'), 'error');
        return;
      }
      doc.nativeKnownPages = [...(doc.nativeKnownPages || []), number];
      doc.nativeOriginalRefs = [
        ...new Set([
          ...(doc.nativeOriginalRefs || []),
          ...originals.flatMap(item => (item.nativeSourceRef ? [item.nativeSourceRef] : [])),
        ]),
      ];
      if (doc.nativeKnownPages.length === doc.pdf.numPages) doc.nativeLegacySession = false;
      set([...next]);
    });
  }, [doc]);
}
