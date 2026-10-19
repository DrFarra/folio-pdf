import { useMemo } from 'react';
import { usePageTracking, useReaderTaps, useSwipePages } from './reader-navigation';
import { useReaderPosition } from './reader-position';
import { usePanels } from './panels';
import { useOutlineLoader, useOutlineSection, usePageLabels } from './document-data';
import type { Annotation } from '../types';
import type { useFolioState } from './folio-state';

type Layer1 = ReturnType<typeof useFolioState>;

/** The reader: where it is, its page tracking and gestures, the side panels and search. */
export function useFolioReader(f: Layer1) {
  const { activeView, annotations, bookmarkEditingId, busy, currentScale, doc, docRef, fittedWidth, library, loading, mobileAnnotating, mobileTabs, notesOpen, notify, outline,
    page, phone, readingAnchor, readingMode, readingPreferencesRef, readingState, rotation, search, searchInput, searchOpen, setDrawerSwap, setMobileAnnotating,
    setNotesOpen, setOutline, setPage, setReaderChromeHidden, setSearchOpen, setSideTab, setSidebar, setTool, sideTab, sidebar, tabStore, toggleTapZoom, tool,
    toolSections, touchLayout, viewer, workbench } = f;
  useOutlineLoader(doc, setOutline);
  const { pageLabels, currentPageLabel } = usePageLabels(doc?.pdf, page);
  // The outline heading a page belongs to, shown while scrubbing.
  const outlineSection = useOutlineSection(outline);
  useReaderTaps(viewer, touchLayout && !!doc, tool === 'select' && !busy && !loading && !mobileAnnotating && !searchOpen && !library && !sidebar && !notesOpen && !mobileTabs,
    { doubleTap: toggleTapZoom, toggleChrome: () => setReaderChromeHidden(value => !value), showChrome: () => setReaderChromeHidden(false) });
  const scrollReaderBy = usePageTracking({ viewer, doc, readingMode, page, enabled: phone || workbench !== 'edit-pdf', paused: () => toolSections.restoring, onPage: setPage,
    onCenter: (number, x, y, width) => {
      // A resize not yet applied to the zoom would anchor the wrong point.
      if (docRef.current && width === fittedWidth.current) readingAnchor.current = { id: docRef.current.id, page: number, x, y, rotation: activeView.current.rotation };
    } });
  const pages = useMemo(() => Array.from({ length: doc?.pdf.numPages || 0 }, (_, i) => i + 1), [doc]);
  const annotationPages = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    annotations.forEach(a => { const list = map.get(a.page) || []; list.push(a); map.set(a.page, list); });
    return map;
  }, [annotations]);
  const { pageInput, setPageInput, pageInputDirty, editPageInput, showPageInput, commitPageInput, goToPage, restoreScroll, cancelScrollRestore,
    returnLocation, setReturnLocation, returnPage, rememberLocation, returnToLocation: returnToPlace, navigate } = useReaderPosition({ viewer, doc, page, setPage, readingMode, rotation, phone,
    current: () => docRef.current, currentPage: () => readingState.current.page, activeKey: () => tabStore.activeKey, scale: () => currentScale.current,
    smoothScroll: () => readingPreferencesRef.current.smoothScroll, scrollBy: scrollReaderBy, notify });
  const { goToResult, submitSearch, stepResult, typeQuery, openSearch, closeSearch, closeMobilePanel, openExplorer, toggleSidePanel, showExplorerTab, showPage, focusRail } = usePanels({
    touch: touchLayout, phone, sidebar, setSidebar, sideTab, setSideTab, notesOpen, setNotesOpen, searchOpen, setSearchOpen, search, input: searchInput, bookmarkEditing: !!bookmarkEditingId,
    setTool, setAnnotating: setMobileAnnotating, showChrome: () => setReaderChromeHidden(false), setDrawerSwap, activeKey: () => tabStore.activeKey, goToPage,
    hasReturn: () => !!returnLocation, rememberLocation });
  useSwipePages(viewer, touchLayout && !!doc && readingMode === 'single' && tool === 'select' && !mobileAnnotating && !library && !sidebar && !notesOpen && !busy && !loading,
    step => goToPage(readingState.current.page + step, false));
  return { annotationPages, cancelScrollRestore, closeMobilePanel, closeSearch, commitPageInput, currentPageLabel, editPageInput, focusRail, goToPage, goToResult, navigate,
    openExplorer, openSearch, outlineSection, pageInput, pageInputDirty, pageLabels, pages, rememberLocation, restoreScroll, returnLocation, returnPage, returnToPlace,
    scrollReaderBy, setPageInput, setReturnLocation, showExplorerTab, showPage, showPageInput, stepResult, submitSearch, toggleSidePanel, typeQuery };
}
