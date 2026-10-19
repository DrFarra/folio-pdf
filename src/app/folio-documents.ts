import { useCallback, useEffect, useMemo } from 'react';
import { errorMessage } from '../errors';
import { searchTerm, type DocumentTab, type TabView } from './model';
import { useDesktopWindow } from './desktop-window';
import { useTheme } from './theme';
import { useAutosave } from './autosave';
import { useLibraryCover, useNativeAnnotations } from './document-data';
import { useKeepAwake, useSystemBars, useDesktopDrops, usePreserveOnLeave, useSystemOpens, useWindowCloseGuard } from './native-events';
import { useDocumentTabDrag } from '../useDocumentTabDrag';
import { isNative, isMobile } from '../platform';
import type { LoadedDocument } from '../types';
import { useLibraryList } from './library';
import { useLiveEditing } from './live-edit';
import type { useFolioState } from './folio-state';
import type { useFolioReader } from './folio-reader';

type Layer2 = ReturnType<typeof useFolioState> & ReturnType<typeof useFolioReader>;

/** The open documents: their tabs and views, opening and showing them, storing them, and the events of the native app around them. */
export function useFolioDocuments(f: Layer2) {
  const { activeTabKey, activeView, annotationRef, annotations, applyTabView, bookmarkRef, bookmarks, busy, busyRef, changes, doc, docRef, dragCounter, editStore, editing,
    editingRef, editorDraftRef, help, history, info, library, libraryRef, libraryStore, liveEdit, loading, loadingRef, mobileActions, mobileTabs, noteDraft, notify,
    opener, page, pageJump, passwordRef, persistence, phone, phoneRef, readerChromeHidden, readingPreferences, readingState, restoreScroll, setActiveTabKey,
    setAnnotationOptions, setBookmarkEditingId, setCapabilityNotice, setCloseBlocked, setCustomScale, setDoc, setDraftFailed, setDragOver, setEditArea, setEditing,
    setHistoryTick, setIndexing, setInfo, setLibrary, setLoading, setMobileAnnotating, setNoteDraft, setNotesOpen, setOutline, setPage, setPageJump, setPassword,
    setQuery, setReaderChromeHidden, setRedactions, setResultIndex, setReturnLocation, setSearchOpen, setSearchQuery, setSessionFailed, setSidebar, setTextIndex, setTool,
    setViewSettings, setWorkbench, setZoomMode, settings, showAnnotations, showBookmarks, showPageInput, tabStore, tabs, toolSections, touchLayout, touchRef,
    unreadSessions, viewer, workbench, workbenchRef } = f;
  const tabDrag = useDocumentTabDrag({ keys: tabs.map(tab => tab.key), activeKey: activeTabKey, disabled: phone || !!busy || loading,
    onReorder: keys => { if (!busyRef.current && !loadingRef.current) tabStore.reorder(keys, workbenchRef.current !== 'edit-pdf' || phoneRef.current); } });
  function captureTab(): DocumentTab | null {
    // Commit an inline bookmark name before a keyboard switch, close or open.
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('bookmark-name-input')) document.activeElement.blur();
    const current = docRef.current, key = tabStore.activeKey;
    if (!current || !key) return null;
    return { ...activeView.current, key, doc: current, annotations: annotationRef.current, bookmarks: bookmarkRef.current,
      undo: history.undo, redo: history.redo, scrollTop: viewer.current?.scrollTop || 0, scrollLeft: viewer.current?.scrollLeft || 0 };
  }
  function activateTab(tab: DocumentTab, focusSelectedTab = document.activeElement?.getAttribute('role') === 'tab') {
    if (tab.key !== tabStore.activeKey) setEditing(false);
    tabStore.activeKey = tab.key; setActiveTabKey(tab.key);
    docRef.current = tab.doc; readingState.current = { page: tab.page };
    history.undo = tab.undo; history.redo = tab.redo;
    restoreScroll.current = { key: tab.key, top: tab.scrollTop, left: tab.scrollLeft };
    setReaderChromeHidden(false); setDoc(tab.doc); showAnnotations(tab.annotations); showBookmarks(tab.bookmarks); setReturnLocation(null);
    applyView(tab, touchRef.current);
    setWorkBenchClosed(); setHistoryTick(v => v + 1); window.getSelection()?.removeAllRanges();
    if (focusSelectedTab) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.document-tab[data-tab-key="${CSS.escape(tab.key)}"] [role=tab]`)?.focus({ preventScroll: true }));
    if (tab.doc.outdated) void reopenWritten(tab.doc);
  }
  /** Shows a tab's view of its document: page, zoom, mode, tool, panels and search. On touch
   * layouts (`closeDrawers`) the drawers start closed, whatever the tab had open. */
  function applyView(view: TabView, closeDrawers: boolean) {
    applyTabView(view, closeDrawers); showPageInput(view.page); setZoomMode(view.zoomMode); setCustomScale(view.customScale);
    setTextIndex(view.textIndex); setIndexing(view.indexing); setSearchOpen(view.searchOpen); setQuery(view.query); setSearchQuery(searchTerm(view.query)); setResultIndex(view.resultIndex);
    setBookmarkEditingId(null);
  }
  /** The last document closed: the reader empties and the library shows. */
  function showNoDocument() {
    showPageInput(1); setPage(1);
    tabStore.activeKey = null; setActiveTabKey(null); docRef.current = null; history.undo = []; history.redo = [];
    setReaderChromeHidden(false); setDoc(null); showAnnotations([]); showBookmarks([]); setOutline(null); setTextIndex([]); setQuery(''); setSearchOpen(false); setNotesOpen(false); setSidebar(false);
    setTool('select'); setRedactions([]); setEditArea(null); setMobileAnnotating(false); setReturnLocation(null); setWorkBenchClosed(); setLibrary(true);
  }
  function setWorkBenchClosed() { setWorkbench(null); setInfo(false); setLibrary(false); setNoteDraft(null); setPageJump(false); setViewSettings(false); setAnnotationOptions(false); setCapabilityNotice(false); }
  const switchTab = (key: string) => tabStore.switchTo(key);
  const closeTab = (key: string, discard = false) => tabStore.close(key, discard);
  const openDocument = useMemo(() => opener.open.bind(opener), [opener]);
  /** Shows a document that just opened, in its new tab or in place of its earlier copy. */
  function presentTab(tab: DocumentTab, { replacing, quiet, resumeEditing, previous }: { replacing: boolean; quiet: boolean; resumeEditing: boolean; previous: DocumentTab | null }) {
    tabStore.activeKey = tab.key; setActiveTabKey(tab.key);
    if (quiet && viewer.current) restoreScroll.current = { key: tab.key, top: viewer.current.scrollTop, left: viewer.current.scrollLeft };
    if (!replacing) setEditing(false);
    docRef.current = tab.doc; readingState.current = { page: tab.page };
    history.undo = tab.undo; history.redo = tab.redo;
    setDoc(tab.doc); setReaderChromeHidden(false); showAnnotations(tab.annotations); showBookmarks(tab.bookmarks);
    applyView(tab, touchRef.current && !replacing); setHistoryTick(v => v + 1);
    const editor = resumeEditing && !phoneRef.current;
    if (editor) toolSections.remember({ revision: String(tab.doc.revision), page: tab.page, top: previous?.scrollTop || 0, left: previous?.scrollLeft || 0 });
    setLibrary(false); setWorkbench(editor ? 'edit-pdf' : null); setNoteDraft(null); setPassword(null); setInfo(false);
  }
  useAutosave(doc, annotations, bookmarks, page, { persistence, notify, forgotten: id => libraryStore.forgotten.has(id), unread: id => unreadSessions.current.has(id),
    shown: current => docRef.current?.id === current.id && docRef.current?.revision === current.revision,
    draftStored: stored => setDraftFailed(!stored), sessionStored: stored => setSessionFailed(!stored) });
  useLiveEditing(editing, doc, touchLayout, editStore, liveEdit, notify);
  const systemChromeVisible = !readerChromeHidden || !doc || library || !!workbench || !!noteDraft || mobileActions || mobileTabs || pageJump || settings || help || info;
  const { theme, chooseTheme } = useTheme(library ? '--bg' : systemChromeVisible ? '--surface' : '--canvas');
  usePreserveOnLeave(() => {
    tabStore.retain();
    for (const tab of tabStore.list) void persistence.tab(tab, false).catch(() => { setSessionFailed(true); });
    // The system may end a backgrounded app; startup reopens these from the library.
    if (isNative && isMobile) try { localStorage.setItem('folio.openTabs', JSON.stringify({ ids: tabStore.list.map(tab => tab.doc.id), active: docRef.current?.id, library: libraryRef.current })); } catch { /* Only the reopening is lost. */ }
  });
  useEffect(() => { if (!isNative) setLoading(false); }, []);
  useSystemOpens({ notify, open: file => openDocument(file, file.name, false, file.token),
    busy: () => !!busyRef.current, opening: () => loadingRef.current && opener.requests > 0,
    received: () => { setDragOver(false); dragCounter.current = 0; },
    ready: async (nothingOpened, alive) => {
      if (nothingOpened && isMobile) await libraryStore.restoreOpenTabs(alive);
      if (alive() && opener.requests === 0) setLoading(false);
    },
    failed: () => { if (opener.requests === 0) setLoading(false); notify('No se pudo preparar la apertura de documentos.', 'error'); } });
  useDesktopDrops({ hover: setDragOver, editing: () => editingRef.current, notify });
  useWindowCloseGuard({ notify, guarded: () => tabStore.list.length > 0 || tabStore.closing.size > 0, close: async () => {
    if (editorDraftRef.current) { notify('Aplica o descarta la edición antes de cerrar Folio.'); return false; }
    // A pending password request is not an operation: closing cancels it.
    if (passwordRef.current) cancelPassword();
    if (busyRef.current || loadingRef.current || document.querySelector('.workbench .operation-loading')) { notify('Espera a que termine la operación antes de cerrar.'); return false; }
    // A closed Drive tab whose edit could not be prepared keeps Folio open, with its notice.
    if (tabStore.closing.size) { notify('Guardando en Drive…'); if ((await Promise.all(tabStore.closing)).includes(false)) return false; }
    // Every tab is stored; the first one that fails is shown, so the dialog saves that document.
    await liveEdit.write().catch(() => {});
    const failed = await tabStore.storeAll();
    if (!failed) return true;
    if (tabStore.activeKey !== failed.tab.key) { activateTab(failed.tab); tabStore.publish(); }
    notify(errorMessage(failed.cause), 'error'); setCloseBlocked('window');
    return false;
  } });
  const windowError = useCallback(() => notify('No se pudo cambiar el estado de la ventana.', 'error'), [notify]);
  const { windowState, windowAction } = useDesktopWindow(doc?.name, windowError);
  useNativeAnnotations(doc, { notify, current: () => annotationRef.current, shown: current => docRef.current?.pdf === current.pdf,
    set: showAnnotations });
  const { recents, setRecents, libraryLoading } = useLibraryList(library || mobileTabs, libraryStore, notify);
  // The screen stays on while a document is being read, never in the library.
  const reading = !!doc && !library && readingPreferences.keepAwake;
  useKeepAwake(reading);
  useLibraryCover(doc);
  useSystemBars(systemChromeVisible);
  const reopenWritten = (current: LoadedDocument) => changes.reopenWritten(current);
  const cancelPassword = () => opener.cancel();
  return { recents, setRecents, libraryLoading, activateTab, applyView, cancelPassword, captureTab, chooseTheme, closeTab, openDocument, presentTab, reading, reopenWritten, setWorkBenchClosed, showNoDocument,
    switchTab, systemChromeVisible, tabDrag, theme, windowAction, windowError, windowState };
}
