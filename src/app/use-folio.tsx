import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../errors';
import { isNativePdfDocument } from '../nativePdf';
import { annotationFingerprint, fileSaveLabel, here, saveAdvice, savesInPlace, searchTerm, uid, type DocumentTab, type History, type TabView } from './model';
import type { Area, Operation, PageEntry } from '../engine/operations.ts';
import { type PasswordRequest } from '../components/DocumentDialogs';
import { useInkPreferences } from './ink-preferences';
import { useDesktopWindow } from './desktop-window';
import { useTheme } from './theme';
import { useNotices } from './notices';
import { useReaderZoom, useViewportSize } from './reader-zoom';
import { usePageTracking, useReaderTaps, useSwipePages } from './reader-navigation';
import { useReaderPosition } from './reader-position';
import { usePanels } from './panels';
import { LiveEdit } from './live-edit';
import { Persistence } from './persistence';
import { paletteCommands } from './palette-commands';
import { DocumentOutput } from './document-output';
import { Library } from './library';
import { Tabs } from './tabs';
import { DocumentOpener } from './opener';
import { UndoHistory } from './history';
import { useTabView } from './tab-view';
import { commentFor, patched, toggledBookmark, useMarks, withAdded, withNote, without } from './marks';
import { useDialogs, useDriveState, useNoteEditor } from './dialogs';
import { ToolSections } from './tool-sections';
import { useAutosave } from './autosave';
import { useAppPreferences } from './app-preferences';
import { useLibraryCover, useNativeAnnotations, useOutlineLoader, useOutlineSection, usePageLabels } from './document-data';
import { usePastedImages } from '../edit/paste';
import { DocumentChanges } from './document-changes';
import { useDocumentSearch } from './search';
import { readShortcut, useKeyboard, type Shortcut } from './shortcuts';
import { useAndroidBack, useKeepAwake, useSystemBars, useDesktopDrops, useMacMenu, usePreserveOnLeave, useSystemOpens, useWindowCloseGuard } from './native-events';
import { hasBookmarkPage } from '../bookmarks';
import { highlightSelection } from '../text-selection';
import type { AnnotationDraft } from '../text-selection';
import { EditStore } from '../edit/store';
import { editKey } from '../edit/keys';
import { useExit } from '../motion';
import { useEdgeSwipeBack } from '../edge-swipe';
import { useDeviceLayout } from '../mobile';
import { useDocumentTabDrag } from '../useDocumentTabDrag';
import { isNative, isMobile, pickNativeDocuments, haptic, type Anchor } from '../platform';
import { touchDocument } from '../storage';
import type { Annotation, LoadedDocument, PDFNavigationTarget, RecentDocument, Tool } from '../types';

/** Folio's state and the coordination between its parts: the open documents and their tabs,
 * the reader, the panels and dialogs, and the controllers that open, change, store and save
 * documents. `App` draws it. */
export function useFolio() {
  const layout = useDeviceLayout(), phone = layout === 'phone', tablet = layout === 'tablet', touchLayout = phone || tablet;
  const { mobileActions, setMobileActions, mobileTabs, setMobileTabs, creating, setCreating, pageJump, setPageJump, viewSettings, setViewSettings,
    annotationOptions, setAnnotationOptions, capabilityNotice, setCapabilityNotice, deleteTarget, setDeleteTarget, help, setHelp, settings, setSettings,
    confirmClear, setConfirmClear, info, setInfo, palette, setPalette, whatsNew, setWhatsNew, shortcutsOpen, setShortcutsOpen, closeBlocked, setCloseBlocked } = useDialogs();
  const { driveAvailable, driveLibrary, setDriveLibrary, driveMessage, setDriveMessage, driveConflicts, setDriveConflicts, driveRefresh, setDriveRefresh } = useDriveState();
  // Editar inside the reader (desktop): the pages stay, with an edit layer and toolbar.
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing); editingRef.current = editing;
  const editStore = useMemo(() => new EditStore(), []);
  const tabStore = useMemo(() => new Tabs(), []);
  const opener = useMemo(() => new DocumentOpener(), []);
  const history = useMemo(() => new UndoHistory(), []);
  const changes = useMemo(() => new DocumentChanges(), []);
  const toolSections = useMemo(() => new ToolSections(), []);
  const liveEdit = useMemo(() => new LiveEdit(), []);
  const persistence = useMemo(() => new Persistence(), []);
  const output = useMemo(() => new DocumentOutput(), []);
  const libraryStore = useMemo(() => new Library(), []);
  const [readerChromeHidden, setReaderChromeHidden] = useState(false);
  const [doc, setDoc] = useState<LoadedDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'download' | 'print' | 'edit' | 'close' | null>(null);
  const [workbench, setWorkbench] = useState<string | null>(null);
  const workbenchRef = useRef(workbench); workbenchRef.current = workbench;
  const [editorDraft, setEditorDraft] = useState(false);
  const editorDraftRef = useRef(editorDraft); editorDraftRef.current = editorDraft;
  const { page, setPage, dimensions, rotation, setRotation, readingMode, setReadingMode, annotating: mobileAnnotating, setAnnotating: setMobileAnnotating,
    tool, setTool, color, setColor, sidebar, setSidebar, sideTab, setSideTab, notesOpen, setNotesOpen, outline, setOutline, activeNote, setActiveNote,
    redactions, setRedactions, editArea, setEditArea, sessionFailed, setSessionFailed, draftFailed, setDraftFailed, apply: applyTabView } = useTabView();
  const { inkKind, setInkKind, setInkStyles, inkStyle, inkRecentColors, setInkRecentColors, eraserSize, setEraserSize, penOnly, choosePenOnly, penDetected } = useInkPreferences();
  const { annotations, annotationRef, showAnnotations, commitAnnotations, bookmarks, bookmarkRef, showBookmarks, commitBookmarks } = useMarks(
    (step, gesture) => history.record(step, gesture), () => { if (docRef.current) unreadSessions.current.delete(docRef.current.id); });
  const [bookmarkEditingId, setBookmarkEditingId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [library, setLibrary] = useState(true);
  const libraryRef = useRef(library); libraryRef.current = library;
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [recents, setRecents] = useState<RecentDocument[]>([]);
  const { rememberRecent, setRememberRecent, defaultZoom, setDefaultZoom, readingPreferences, setReadingPreferences, readingPreferencesRef, preferencesRef } = useAppPreferences();
  const { noteDraft, setNoteDraft, noteText, setNoteText, noteOrigin, noteAnchor, editNote: openNote } = useNoteEditor();
  const [password, setPassword] = useState<PasswordRequest | null>(null);
  const passwordRef = useRef(password); passwordRef.current = password;
  const [dragOver, setDragOver] = useState(false);
  // Drawers and notices stay mounted while they animate out.
  const sidebarLeaving = useExit(touchLayout && sidebar), notesLeaving = useExit(touchLayout && notesOpen);
  const [drawerSwap, setDrawerSwap] = useState(false);
  // Only the drawer open last slides away; one replaced by a tab switch is already gone.
  const lastDrawer = useRef<'sidebar' | 'notes'>('sidebar');
  if (sidebar) lastDrawer.current = 'sidebar'; else if (notesOpen) lastDrawer.current = 'notes';
  const sidebarShown = sidebar || sidebarLeaving && lastDrawer.current === 'sidebar', notesShown = notesOpen || notesLeaving && lastDrawer.current === 'notes';
  useEffect(() => { if (!sidebar && !notesOpen) setDrawerSwap(false); }, [sidebar, notesOpen]);
  const storageFailed = sessionFailed || draftFailed;
  const [, setHistoryTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const picking = useRef(false);
  const viewer = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const loadingRef = useRef(loading); loadingRef.current = loading;
  const docRef = useRef<LoadedDocument | null>(null);
  const readingState = useRef({ page });
  readingState.current = { page };
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const dragCounter = useRef(0);
  // Web documents whose edited PDF was downloaded as it is now: their tab no longer reads as unsaved.
  const downloadedDrafts = useRef(new WeakSet<LoadedDocument>());
  // Documents whose stored session could not be read: nothing rewrites it until the user changes something.
  const unreadSessions = useRef(new Set<string>());
  const phoneRef = useRef(phone); phoneRef.current = phone;
  const touchRef = useRef(touchLayout); touchRef.current = touchLayout;
  const chromeHiddenRef = useRef(readerChromeHidden); chromeHiddenRef.current = readerChromeHidden;
  const viewportSize = useViewportSize(viewer, doc, () => chromeHiddenRef.current);
  const fittedWidth = useRef(viewportSize.width); fittedWidth.current = viewportSize.width;
  const activityLabel = busy === 'download' ? doc?.drive ? driveMessage || 'Guardando en Google Drive…' : savesInPlace ? 'Guardando el PDF…' : isNative ? 'Guardando una copia…' : 'Preparando el PDF…'
    : busy === 'print' ? 'Preparando la impresión…' : busy === 'edit' ? 'Aplicando los cambios…' : '';
  const { toast, notify, dismiss: dismissToast, activity, activityDone } = useNotices(activityLabel);
  const search = useDocumentSearch(doc, searchOpen, notify);
  const { textIndex, setTextIndex, indexing, setIndexing, query, setQuery, searchQuery, setSearchQuery, resultIndex, setResultIndex,
    resultLimit, setResultLimit, results, occurrences, history: searchHistory, setHistory: setSearchHistory } = search;
  // Two pages side by side share the width.
  const spread = readingMode === 'spread' && !phone;
  const { zoomMode, setZoomMode, customScale, setCustomScale, scale, currentScale, readingAnchor, changeZoom, toggleTapZoom } = useReaderZoom({ viewer, documentId: doc?.id, currentId: () => docRef.current?.id,
    dimensions, rotation, viewportSize, phone, touchLayout, spread, pageGap: readingPreferences.pageGap, wheelSpeed: () => readingPreferencesRef.current.wheelSpeed,
    pinchable: !library, canPinch: () => !busyRef.current && !loadingRef.current, currentPage: () => readingState.current.page });
  const activeView = useRef<TabView>(null!);
  activeView.current = { page, dimensions, zoomMode, customScale, rotation, readingMode, annotating: mobileAnnotating, tool, color, sidebar, sideTab, notesOpen, outline, textIndex, indexing, searchOpen, query, resultIndex, activeNote, redactions, editArea, sessionFailed, draftFailed };
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

  // Each document starts Editar afresh; leaving it drops the selection and any pending image.
  useEffect(() => { editStore.reset(); }, [doc?.id, editStore]);
  // Editar on desktop keeps its document live (see LiveEdit).
  useEffect(() => { liveEdit.sync(editing, doc); }, [editing, doc, touchLayout, liveEdit]);
  useEffect(() => { if (!editing) editStore.set({ selection: null, draft: null, ghost: null, tool: 'select', image: null, notice: '', reselect: null }); }, [editing, editStore]);
  usePastedImages(editing, editStore, message => notify(message, 'error'));

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
  useOutlineLoader(doc, setOutline);
  useNativeAnnotations(doc, { notify, current: () => annotationRef.current, shown: current => docRef.current?.pdf === current.pdf,
    set: showAnnotations });
  useEffect(() => {
    let alive = true;
    if (library || mobileTabs) { setLibraryLoading(true); libraryStore.list().then(items => { if (alive) setRecents(items); }).catch(() => { if (alive) { setRecents([]); notify('No se pudo abrir la biblioteca local.', 'error'); } }).finally(() => { if (alive) setLibraryLoading(false); }); }
    return () => { alive = false; };
  }, [library, mobileTabs, notify]);
  const { pageLabels, currentPageLabel } = usePageLabels(doc?.pdf, page);
  // The screen stays on while a document is being read, never in the library.
  const reading = !!doc && !library && readingPreferences.keepAwake;
  useKeepAwake(reading);
  // The palette's commands, built when it opens.
  const commands = () => paletteCommands({ doc, idle: !busy && !loading, pageName, saveLabel, bookmarked: hasBookmarkPage(bookmarks, page),
    canUndo: history.undo.length > 0, canRedo: history.redo.length > 0, returnPage,
    pageTone: readingPreferences.pageTone, outline, driveAvailable,
    tabs: tabs.filter(tab => tab.key !== activeTabKey).map(tab => ({ key: tab.key, name: tab.doc.name })),
    recents: recents.filter(item => !tabs.some(tab => tab.doc.id === item.id)),
    run: { save: () => void download(), print: () => void printDocument(), share: () => void shareDocument(), edit: openEditor, tools: openTools,
      split: () => { openTools(); setWorkbench('split'); }, info: () => setInfo(true), close: closeActiveTab,
      jump: () => { setPageInput(String(page)); setPageJump(true); }, goTo: number => goToPage(number), back: returnToLocation, bookmark: toggleBookmark,
      chapter: number => { if (!returnLocation) rememberLocation(); goToPage(number, false); },
      search: openSearch, explorer: openExplorer, annotations: () => { if (touchLayout) showExplorerTab('annotations'); else setNotesOpen(true); },
      highlight: () => { setMobileAnnotating(true); activateHighlight(); }, tool: next => { if (next !== 'select') setMobileAnnotating(true); setTool(next); }, undo, redo,
      zoom: changeZoom, fit: setZoomMode, actualSize: () => { setCustomScale(1); setZoomMode('custom'); }, tone: pageTone => setReadingPreferences(current => ({ ...current, pageTone })),
      view: () => setViewSettings(true), switchTab: key => void switchTab(key), reopen: recent => void reopenRecent(recent),
      open: () => void chooseFile(), create: () => setCreating(true), drive: () => { setLibrary(true); setDriveLibrary(true); }, library: () => void returnToLibrary(),
      theme: chooseTheme, settings: () => setSettings(true), shortcuts: () => setShortcutsOpen(true), help: () => setHelp(true) } });
  // The outline heading a page belongs to, shown while scrubbing.
  const outlineSection = useOutlineSection(outline);
  useLibraryCover(doc);
  useSystemBars(systemChromeVisible);
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


  const recordStep = (step: History, gesture?: string) => history.record(step, gesture);
  const trimHistory = (stack: History[]) => history.trim(stack);
  const undo = useCallback(() => history.step('undo'), [history]);
  const redo = useCallback(() => history.step('redo'), [history]);
  const toggleBookmark = useCallback(() => {
    if (!docRef.current || busyRef.current || loadingRef.current) return;
    haptic('light');
    // On touch the filled bookmark toggles; Deshacer restores a removed one.
    const next = toggledBookmark(bookmarkRef.current, page, touchRef.current);
    commitBookmarks(next.bookmarks);
    if (!next.added) notify('Marcador eliminado.', 'success');
    else if (touchRef.current) notify('Marcador guardado.', 'success');
    else { setSidebar(true); setSearchOpen(false); setSideTab('bookmarks'); setBookmarkEditingId(next.added); }
  }, [page, commitBookmarks, notify]);
  function activateHighlight() {
    if (!docRef.current?.canAnnotate || !docRef.current.canCopy || busyRef.current || loadingRef.current) return;
    if (highlightSelection()) setTool('select');
    else setTool(previous => previous === 'highlight' ? 'select' : 'highlight');
  }

  // Finds in the library, or in the document.
  function find() { if (library) document.querySelector<HTMLInputElement>('.document-library-search input')?.focus(); else if (docRef.current) openSearch(); }
  function runShortcut(shortcut: Shortcut, modal: Element | undefined) {
    switch (shortcut.run) {
      case 'close-dialog': modal?.dispatchEvent(new Event('cancel', { cancelable: true })); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'switch-tab': void switchTab(tabStore.neighbour(shortcut.step).key); break;
      case 'close-tab': if (tabStore.activeKey) void closeTab(tabStore.activeKey); break;
      case 'save': void download({ keepEditing: shortcut.keepEditing, copy: shortcut.copy }); break;
      case 'palette': setPalette(value => !value); break;
      case 'open': void chooseFile(); break;
      case 'find': find(); break;
      case 'print': void printDocument(); break;
      case 'search-step': stepResult(shortcut.step); break;
      case 'shortcuts': setShortcutsOpen(true); break;
      case 'zoom': changeZoom(shortcut.delta); break;
      case 'actual-size': setCustomScale(1); setZoomMode('custom'); break;
      case 'scroll': viewer.current?.scrollBy({ left: shortcut.left }); break;
      case 'turn': goToPage(shortcut.forward ? page + (spread ? 2 - (page + 1) % 2 : 1) : Math.max(1, page - (spread ? (page % 2 ? 2 : 3) : 1))); break;
      case 'tool':
        if (shortcut.tool === 'highlight') activateHighlight();
        else { if (shortcut.tool === 'draw') setMobileAnnotating(true); setTool(shortcut.tool); }
        break;
      case 'escape': setReaderChromeHidden(false); setMobileAnnotating(false); setTool('select'); if (searchOpen) closeSearch(); break;
    }
  }
  useKeyboard(e => {
    const target = e.target as HTMLElement, field = !!target.closest('input,textarea,select,[contenteditable]');
    const modal = [...document.querySelectorAll('dialog[open]')].at(-1);
    const { prevent, shortcut } = readShortcut(e, { field, searchField: target === searchInput.current, modal: !!modal,
      editor: workbenchRef.current === 'edit-pdf' && !phoneRef.current, draft: editorDraftRef.current, busy: !!busyRef.current, loading: loadingRef.current,
      library, tabs: tabStore.list.length, tab: !!tabStore.activeKey, searchResults: searchOpen && results.length > 0, canAnnotate: !!docRef.current?.canAnnotate,
      overflows: () => !!viewer.current && viewer.current.scrollWidth > viewer.current.clientWidth + 4,
      editKeys: () => editingRef.current && !field && !modal && editKey(editStore, e, () => setEditing(false)) });
    if (prevent) e.preventDefault();
    if (shortcut) runShortcut(shortcut, modal);
  });

  async function openFiles(files: File[]) {
    if (editorDraftRef.current) { notify('Aplica o descarta la edición antes de abrir otro documento.'); return; }
    if (busyRef.current) return;
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') { notify('Solo se pueden abrir archivos PDF.', 'error'); continue; }
      await openDocument(file, file.name);
    }
  }
  async function chooseFile() {
    if (editorDraftRef.current) { notify('Aplica o descarta la edición antes de abrir otro documento.'); return; }
    if (busyRef.current || loadingRef.current || picking.current) return;
    if (!isNative) { fileInput.current?.click(); return; }
    // The system picker is modal; «Abriendo PDF…» waits until a file loads.
    picking.current = true;
    try {
      const files = await pickNativeDocuments();
      for (const file of files) await openDocument(file, file.name, false, file.token);
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { picking.current = false; }
  }
  const reopenRecent = (recent: RecentDocument) => libraryStore.reopen(recent);
  function onAnnotate(annotation: AnnotationDraft | AnnotationDraft[]) {
    if (!doc?.canAnnotate || busyRef.current || loadingRef.current) return;
    if (Array.isArray(annotation)) {
      // A selection spanning several pages is one action in the document history.
      // Highlights over a highlight of the same color join it.
      commitAnnotations(withAdded(annotationRef.current, annotation));
      if (annotation.some(item => item.kind === 'highlight')) haptic('light');
      return;
    }
    if (annotation.kind === 'note') { openNote(annotation, 'document', ''); return; }
    commitAnnotations(withAdded(annotationRef.current, [annotation]));
    if (annotation.kind === 'highlight') haptic('light');
  }
  const removeAnnotation = useCallback((id: string, gesture?: string) => {
    if (!docRef.current?.canAnnotate || busyRef.current || loadingRef.current || !annotationRef.current.some(annotation => annotation.id === id)) return;
    commitAnnotations(without(annotationRef.current, id), gesture);
    setActiveNote(current => current === id ? null : current);
  }, [commitAnnotations]);
  const snapshot = () => changes.snapshot();
  const reopenWritten = (current: LoadedDocument) => changes.reopenWritten(current);
  const applyOperation = (operation: Operation, signal?: AbortSignal, context?: { keepEditing?: boolean; page?: number; quiet?: boolean }) => changes.apply(operation, signal, context);
  const annotatedBytes = (current: LoadedDocument, items?: Annotation[], incremental?: boolean) => output.annotated(current, items, incremental);
  const download = (options?: { keepEditing?: boolean; copy?: boolean }) => output.save(options);
  const printDocument = (anchor?: Anchor) => output.print(anchor);
  const shareDocument = (anchor?: Anchor) => output.share(anchor);
  const replaceDocument = (bytes: Uint8Array, context?: { extraction?: { name: string; plan: PageEntry[] } }) => changes.replace(bytes, context);
  function onArea(area: Area) {
    if (!doc?.canEdit || busy) return;
    if (tool === 'redact') { setRedactions(previous => [...previous, area]); return; }
    setEditArea(area); setWorkbench(tool);
  }
  // Keyboard and screen-reader access to the area tools: crop keeps most of the
  // page, the others mark a band across its centre; Cambiar área draws another.
  // The band is placed as the page is shown, /Rotate included, then converted to PDF space.
  async function centerArea() {
    const current = docRef.current; if (!current) return;
    const view = (await current.pdf.getPage(page)).getViewport({ scale: 1 }), [left, top, right, bottom] = tool === 'crop' ? [.1, .1, .9, .9] : [.25, .425, .75, .575];
    const [ax, ay] = view.convertToPdfPoint(view.width * left, view.height * top), [bx, by] = view.convertToPdfPoint(view.width * right, view.height * bottom);
    onArea({ page, rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] });
  }
  function saveNote() {
    if (!doc?.canAnnotate || !noteDraft || !noteText.trim()) return;
    const { list, note } = withNote(annotationRef.current, noteDraft, noteText);
    commitAnnotations(list);
    setNoteDraft(null); setActiveNote(note.id);
    if (noteOrigin.current === 'list') setNotesOpen(true);
    if (!mobileAnnotating) setTool('select');
  }
  // Mobile keeps private copies of opened PDFs; those of forgotten entries are deleted.
  const retireLibraryEntry = (id: string) => libraryStore.retire(id);
  // iPad anchors Share and Print to the control that opened them.
  const anchorOf = (element: Element | null): Anchor | undefined => { const box = element?.getBoundingClientRect(); return box && { left: box.left, top: box.top, width: box.width, height: box.height }; };
  function showDrive() { setDriveLibrary(true); setLibrary(true); }
  function closeActiveTab() { if (tabStore.activeKey) void closeTab(tabStore.activeKey); }
  function returnToLocation() { returnToPlace(() => { if (searchOpen) closeSearch(); }); }
  const mobilePage = showPage;
  const navigatePDF = navigate;
  function startAnnotating() {
    if (!doc?.canAnnotate) { setCapabilityNotice(true); return; }
    setEditing(false);
    if (touchRef.current) closeMobilePanel(); setReaderChromeHidden(false); setMobileAnnotating(true); setTool('select');
  }
  const editNote = (annotation: Annotation, origin: 'document' | 'list') => openNote(annotation, origin, annotation.text);
  const updateAnnotation = useCallback((id: string, patch: Partial<Pick<Annotation, 'color' | 'text' | 'rect'>>) => {
    if (!docRef.current?.canAnnotate || busyRef.current || loadingRef.current) return;
    commitAnnotations(patched(annotationRef.current, id, patch));
  }, [commitAnnotations]);
  // The comment's 20 pt PDF icon stays on the page.
  async function commentHighlight(annotation: Annotation) {
    openNote(commentFor(annotation, (await docRef.current?.pdf.getPage(annotation.page).catch(() => null))?.view), 'document', '');
  }
  function openTools() { if (!doc || isNativePdfDocument(doc.pdf)) { setCapabilityNotice(true); return; } setMobileAnnotating(false); setTool('select'); setWorkbench('home'); }
  function openEditor() {
    if (!doc || isNativePdfDocument(doc.pdf) || busyRef.current) return;
    if (!touchLayout) { setMobileAnnotating(false); setTool('select'); setWorkbench(null); setReaderChromeHidden(false); setEditing(true); return; }
    toolSections.remember({ revision: String(doc.revision), page, top: viewer.current?.scrollTop || 0, left: viewer.current?.scrollLeft || 0 });
    setSidebar(false); setSearchOpen(false); setNotesOpen(false); setMobileAnnotating(false); setReaderChromeHidden(false); setTool('select'); setWorkbench('edit-pdf');
  }
  const closeWorkbench = () => toolSections.close();
  const selectWorkbenchTool = (next: Tool) => toolSections.selectTool(next);
  const openWorkbenchSection = (next: string) => toolSections.openSection(next);
  async function returnToLibrary() {
    if (editorDraftRef.current) { notify('Aplica o descarta la edición antes de salir del editor.'); return; }
    if (busyRef.current || loadingRef.current) return;
    const current = captureTab();
    tabStore.retain(); tabStore.publish(); closeMobilePanel(); setReaderChromeHidden(false); setMobileAnnotating(false); setTool('select'); setLibrary(true);
    if (current) tabStore.storeInBackground(current);
  }
  // Back steps out of panels, tool sections, annotation mode and hidden controls, and only then the document.
  useAndroidBack({ root: () => library && !driveLibrary, back: toolsBack => {
    if (mobileTabs) setMobileTabs(false);
    else if (sidebar || notesOpen || searchOpen) closeMobilePanel();
    else if (library) setDriveLibrary(false);
    else if (workbench) { if (toolsBack) toolsBack.click(); else if (editorDraftRef.current) notify('Aplica o descarta la edición antes de salir del editor.'); else void closeWorkbench(); }
    else if (mobileAnnotating || tool !== 'select') { setMobileAnnotating(false); setTool('select'); setRedactions([]); }
    else if (readerChromeHidden) setReaderChromeHidden(false);
    else void returnToLibrary();
  } });
  const cancelPassword = () => opener.cancel();
  async function fullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { notify('No se pudo activar la pantalla completa.', 'error'); }
  }
  async function clearLibrary() {
    if (!confirmClear) { setConfirmClear(true); return; }
    if (await libraryStore.clear()) setConfirmClear(false);
  }
  async function forgetRecent(recent: RecentDocument) { if (await libraryStore.forget(recent)) setDeleteTarget(null); }
  // The phone shows the library when the document in front was removed from it.
  function discardOpenTabs(ids: Set<string>) { if (tabStore.discard(ids) && tabStore.list.length && phoneRef.current) setLibrary(true); }

  const inlineEditing = !phone && workbench === 'edit-pdf';

  const saveLabel = doc?.drive ? 'Guardar en Drive' : fileSaveLabel;
  // Only an opened file can be updated; otherwise Guardar already asks where to save.
  const savesOriginal = savesInPlace && !!doc?.nativeSource && !doc.drive && !doc.draftSource && !doc.sample;
  const sessionStatus = storageFailed ? `No se pudieron guardar tus cambios en ${here}. ${saveAdvice}` : `Los cambios se conservan en ${here}.`;
  const driveDirty = !!doc?.drive && (doc.modified || annotationFingerprint(annotations) !== doc.savedAnnotations);
  // A tab shows its unsaved dot, and Guardar lights up, exactly when this holds.
  const unsaved = (document: LoadedDocument, items: Annotation[]) => document.modified && !downloadedDrafts.current.has(document) || annotationFingerprint(items) !== document.savedAnnotations;
  const docDirty = !!doc && unsaved(doc, annotations);
  const driveStatus = busy === 'download' && driveMessage ? driveMessage : driveDirty ? 'Google Drive: cambios pendientes de guardar' : 'Documento de Google Drive';

  // Positions are physical page numbers; a printed label that differs follows them.
  const pageName = (number: number) => { const label = pageLabels?.[number - 1]; return label && label !== String(number) ? `${number} (${label})` : String(number); };
  const pageCounter = doc ? `${page} / ${doc.pdf.numPages}${currentPageLabel !== String(page) ? ` · ${currentPageLabel}` : ''}` : undefined;
  const listedResults = Math.max(resultLimit, resultIndex + 1);
  const sideCount = sideTab === 'pages' ? doc?.pdf.numPages : sideTab === 'bookmarks' ? bookmarks.filter(node => node.page !== null).length : 0;
  // The macOS menu bar's commands behave as their keyboard shortcuts.
  useMacMenu(id => {
    const modal = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (id === 'close-tab') { if (modal) modal.dispatchEvent(new Event('cancel', { cancelable: true })); else if (tabStore.activeKey) void closeTab(tabStore.activeKey); return; }
    // As with the keyboard, a dialog in front or the inline editor keeps the reader's commands.
    if (modal || workbenchRef.current === 'edit-pdf' && !['settings', 'help', 'save', 'save-copy'].includes(id)) return;
    if (id === 'settings') { setConfirmClear(false); setSettings(true); }
    else if (id === 'help') setHelp(true);
    else if (id === 'save' || id === 'save-copy') void download({ keepEditing: true, copy: id === 'save-copy' });
    else if (id === 'print') void printDocument();
    else if (id === 'find') find();
    else if (id === 'zoom-in' || id === 'zoom-out') { if (docRef.current) changeZoom(id === 'zoom-in' ? .1 : -.1); }
    else if (id === 'zoom-reset' && docRef.current) { setCustomScale(1); setZoomMode('custom'); }
  });
  const capabilitySummary = doc?.signed ? 'Este PDF está firmado. Puedes leerlo, buscar y añadir marcadores; editarlo invalidaría la firma.'
    : doc?.drive && !doc.drive.editable ? 'Este archivo de Google Drive es de solo lectura. Puedes leerlo, buscar y añadir marcadores.'
    : !doc?.canAnnotate ? 'El autor de este PDF no permite anotarlo. Puedes leerlo, buscar y añadir marcadores.'
    : 'PDF grande: puedes leer, buscar, resaltar, dibujar y añadir notas. No se pueden editar páginas ni formularios.';
  // Stable handlers let memoized pages skip renders that change nothing on them.
  const pageEvents = useRef({ onAnnotate, onArea, navigatePDF, commentHighlight, mobilePage, openNote: (_id: string) => {} });
  // Editar writes content edits to the PDF in place and keeps shapes as Folio annotations.
  editStore.doc = doc;
  // Undo keeps less on a phone.
  toolSections.host = { section: () => workbenchRef.current, setSection: setWorkbench, inline: () => !phoneRef.current, draft: () => editorDraftRef.current,
    page: () => readingState.current.page, revision: () => docRef.current?.revision, activeKey: () => tabStore.activeKey, tool: () => tool, setTool, clearArea: () => setEditArea(null),
    cancelScrollRestore,
    showAt: (number, top, left) => { setPage(number); setPageInput(String(number)); viewer.current?.scrollTo({ top, left, behavior: 'instant' }); }, goToPage: number => goToPage(number, false) };
  history.host = { budget: () => (phoneRef.current ? 40 : 200) * 1024 * 1024, changed: () => setHistoryTick(v => v + 1),
    blocked: () => editorDraftRef.current || !!busyRef.current || loadingRef.current || editStore.state.committing || liveEdit.settling,
    liveOpen: () => !!editStore.session, stepLive: direction => liveEdit.step(direction), writeLive: () => liveEdit.write(), snapshot,
    restore: (step, from, to) => changes.restore(step, from, to), current: () => ({ annotations: annotationRef.current, bookmarks: bookmarkRef.current }),
    apply: (annotations, bookmarks) => { if (bookmarks) showBookmarks(bookmarks); showAnnotations(annotations); } };
  changes.host = { current: () => docRef.current, annotations: () => annotationRef.current, setAnnotations: showAnnotations,
    reading: () => ({ page: readingState.current.page, bookmarks: bookmarkRef.current }), annotated: current => annotatedBytes(current), open: openDocument, setBusy: busy => setBusy(busy ? 'edit' : null),
    workbench: () => workbenchRef.current === 'edit-pdf', editing: () => editingRef.current, setWorkbench, resetTool: () => setTool('select'),
    record: step => recordStep(step), isRedo: stack => stack === history.redo, changed: () => setHistoryTick(v => v + 1), notify };
  opener.host = { tabs: tabStore, persistence, draft: () => editorDraftRef.current, notify, askPassword: setPassword, current: () => docRef.current,
    leaveEditor: async () => { if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) await closeWorkbench(); },
    setLoading: (loading, cover) => { loadingRef.current = loading; if (cover || !loading) setLoading(loading); },
    view: () => activeView.current, history: () => ({ undo: history.undo, redo: history.redo }), capture: captureTab, show: activateTab, present: presentTab,
    preferences: () => ({ restorePage: readingPreferencesRef.current.restorePage, mode: readingPreferencesRef.current.mode, defaultZoom: preferencesRef.current.defaultZoom,
      panel: readingPreferencesRef.current.initialPanel, rememberRecent: preferencesRef.current.rememberRecent }),
    forgotten: libraryStore.forgotten, unread: unreadSessions.current,
    remember: store => libraryStore.enqueue(store, () => notify('No se pudo guardar este PDF en la biblioteca.', 'error')) };
  tabStore.host = { capture: captureTab, show: activateTab, empty: showNoDocument, publish: setTabs, persistence, notify,
    draft: () => editorDraftRef.current, occupied: () => !!busyRef.current || loadingRef.current || !!document.querySelector('dialog[open]'),
    leaveEditor: async live => {
      if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) await closeWorkbench();
      if (live && editStore.session) { setEditing(false); editingRef.current = false; await liveEdit.close(); }
    },
    setClosing: closing => { busyRef.current = closing ? 'close' : null; setBusy(closing ? 'close' : null); }, closeBlocked: setCloseBlocked, storeFailed: () => setSessionFailed(true),
    // The library lists documents by last use. Drafts and pending native edits keep their own entries.
    used: used => {
      if (preferencesRef.current.rememberRecent && !used.sample && !used.draftSource && !(used.modified && used.nativeSource) && !libraryStore.forgotten.has(used.id))
        libraryStore.enqueue(() => touchDocument({ id: used.id, pages: used.pdf.numPages, nativeSource: used.nativeSource }));
    } };
  libraryStore.host = { tabs: () => tabStore.list, activeKey: () => tabStore.activeKey, retain: () => tabStore.retain(), switchTab, closeTab: key => closeTab(key),
    open: (source, name, token, context) => openDocument(source, name, false, token, context), showLibrary: setLibrary, showDrive: setDriveLibrary,
    driveAvailable: () => driveAvailable, setTransfer: setDriveRefresh, notify,
    removed: ids => setRecents(items => ids === 'all' ? [] : items.filter(item => !ids.includes(item.id))), discard: discardOpenTabs, draftsWritten: () => persistence.draftsWritten };
  output.host = { current: () => docRef.current, annotations: () => annotationRef.current, reading: () => ({ page: readingState.current.page, bookmarks: bookmarkRef.current }), draft: () => editorDraftRef.current,
    busy: () => !!busyRef.current, loading: () => loadingRef.current, setBusy, setDriveMessage, writeLive: () => editStore.session ? liveEdit.write() : Promise.resolve(),
    editing: () => workbenchRef.current === 'edit-pdf' && !phoneRef.current, reopen: (source, name, token, context) => openDocument(source, name, false, token, context),
    draftsWritten: () => persistence.draftsWritten, retire: retireLibraryEntry, downloaded: current => { downloadedDrafts.current.add(current); tabStore.publish(); },
    driveConflict: id => { setDriveConflicts(ids => [...new Set([...ids, id])]); setDriveLibrary(true); setLibrary(true); }, notify, dismissNotice: dismissToast };
  persistence.host = { forgotten: id => libraryStore.forgotten.has(id), unread: id => unreadSessions.current.has(id),
    held: document => docRef.current === document || tabStore.list.some(tab => tab.doc === document), annotated: (document, items) => annotatedBytes(document, items, true) };
  liveEdit.host = { store: editStore, current: () => docRef.current, editing: () => editingRef.current, touch: () => touchRef.current, notify,
    snapshot, historyBudget: () => history.host.budget(), trim: trimHistory, historyChanged: () => setHistoryTick(v => v + 1), reopen: reopenWritten,
    stacks: current => { const owner = tabStore.list.find(tab => tab.doc === current); return !owner || owner.key === tabStore.activeKey ? [history.undo, history.redo] : [owner.undo, owner.redo]; },
    written: (previous, next) => {
      tabStore.list = tabStore.list.map(tab => tab.doc === previous ? { ...tab, doc: next } : tab);
      if (docRef.current === previous) { docRef.current = next; setDoc(next); }
    },
    outdated: current => {
      const owner = tabStore.list.find(tab => tab.doc === current); if (!owner) return;
      const tab = { ...owner, doc: { ...current, outdated: true } }; tabStore.list = tabStore.list.map(item => item === owner ? tab : item); tabStore.storeInBackground(tab);
    } };
  editStore.actions = {
    commit: async operation => {
      try {
        const session = editStore.session;
        if (!session) { if (Array.isArray(operation)) return 'Edita los elementos de uno en uno.'; await applyOperation(operation, undefined, { quiet: true }); return null; }
        const page = await session.edit(operation);
        recordStep(liveEdit.changed(page, annotationRef.current));
        return null;
      } catch (error) { return errorMessage(error, 'No se pudo aplicar el cambio.'); }
    },
    shapes: () => annotationRef.current.filter(annotation => annotation.kind === 'shape'),
    addShape: shape => {
      if (!docRef.current?.canAnnotate || busyRef.current || loadingRef.current) { notify('Los permisos de este PDF no permiten añadir formas.'); return undefined; }
      const id = uid(); commitAnnotations([...annotationRef.current, { ...shape, id, created: Date.now(), text: '' } as Annotation]); return id;
    },
    updateShape: (id, patch) => { if (docRef.current?.canAnnotate && !busyRef.current && !loadingRef.current) commitAnnotations(annotationRef.current.map(item => item.id === id ? { ...item, ...patch } : item)); },
    removeShape: id => removeAnnotation(id),
    notify,
  };
  pageEvents.current = { onAnnotate, onArea, navigatePDF, commentHighlight, mobilePage, openNote: id => {
    const annotation = annotationRef.current.find(item => item.id === id);
    if (annotation && docRef.current?.canAnnotate) editNote(annotation, 'document'); else { setNotesOpen(true); setActiveNote(id); }
  } };
  const pageHandlers = useMemo(() => ({ onAnnotate: (annotation: AnnotationDraft | AnnotationDraft[]) => pageEvents.current.onAnnotate(annotation), onArea: (area: Area) => pageEvents.current.onArea(area),
    onNavigate: (destination: PDFNavigationTarget) => pageEvents.current.navigatePDF(destination), onCommentHighlight: (annotation: Annotation) => void pageEvents.current.commentHighlight(annotation), onNoteClick: (id: string) => pageEvents.current.openNote(id) }), []);
  const thumbnailClicks = useMemo(() => pages.map(number => () => pageEvents.current.mobilePage(number)), [pages]);

  // Swiping in from the left edge goes back: from a document to the library, out of Google Drive.
  useEdgeSwipeBack(touchLayout && !!doc && !library && !inlineEditing && !workbench && !(mobileAnnotating && (tool === 'draw' || tool === 'eraser')), () => void returnToLibrary(), '.app-shell');
  useEdgeSwipeBack(touchLayout && library && driveLibrary, () => setDriveLibrary(false), '.drive-browser');
  return { activateHighlight, activeNote, activeTabKey, activity, activityDone, anchorOf, annotationOptions, annotationPages, annotations, applyOperation, bookmarkEditingId, bookmarks, busy,
    cancelPassword, capabilityNotice, capabilitySummary, centerArea, changeZoom, chooseFile, choosePenOnly, chooseTheme, clearLibrary, closeActiveTab, closeBlocked,
    closeMobilePanel, closeSearch, closeTab, closeWorkbench, color, commands, commitBookmarks, commitPageInput, confirmClear, creating, defaultZoom, deleteTarget, dimensions,
    dismissToast, doc, docDirty, download, dragCounter, dragOver, drawerSwap, driveAvailable, driveConflicts, driveDirty, driveLibrary, driveRefresh, driveStatus, editArea,
    editing, editNote, editorDraft, editPageInput, editStore, eraserSize, fileInput, focusRail, forgetRecent, fullscreen, goToPage, goToResult, help, history, indexing, info,
    inkKind, inkRecentColors, inkStyle, inlineEditing, layout, library, libraryLoading, libraryStore, listedResults, loading, mobileActions, mobileAnnotating, mobilePage,
    mobileTabs, noteAnchor, noteDraft, notesLeaving, notesOpen, notesShown, noteText, notify, occurrences, openDocument, openEditor, openExplorer, openFiles, openSearch, openTools,
    openWorkbenchSection, outline, outlineSection, output, page, pageCounter, pageHandlers, pageInput, pageInputDirty, pageJump, pageLabels, pageName, pages, palette, password,
    penDetected, penOnly, phone, printDocument, query, readerChromeHidden, readingMode, readingPreferences, readingState, recents, redactions, redo, rememberLocation,
    rememberRecent, removeAnnotation, reopenRecent, replaceDocument, resultIndex, results, returnLocation, returnPage, returnToLibrary, returnToLocation, rotation, saveLabel,
    saveNote, savesOriginal, scale, searchHistory, searchInput, searchOpen, searchQuery, selectWorkbenchTool, sessionStatus, setActiveNote, setAnnotationOptions,
    setBookmarkEditingId, setCapabilityNotice, setCloseBlocked, setColor, setConfirmClear, setCreating, setCustomScale, setDefaultZoom, setDeleteTarget, setDragOver,
    setDriveConflicts, setDriveLibrary, setEditArea, setEditing, setEditorDraft, setEraserSize, setHelp, setInfo, setInkKind, setInkRecentColors, setInkStyles, setLibrary,
    setMobileActions, setMobileAnnotating, setMobileTabs, setNoteDraft, setNotesOpen, setNoteText, setPage, setPageInput, setPageJump, setPalette, setPassword, setQuery,
    setReadingMode, setReadingPreferences, setRedactions, setRememberRecent, setResultLimit, setRotation, setSearchHistory, setSearchOpen, setSettings, setShortcutsOpen,
    setSidebar, settings, setTool, setViewSettings, setWhatsNew, setWorkbench, setZoomMode, shareDocument, shortcutsOpen, showBookmarks, showDrive, showExplorerTab, sidebar,
    sidebarLeaving, sidebarShown, sideCount, sideTab, spread, startAnnotating, storageFailed, submitSearch, switchTab, tabDrag, tablet, tabs, tabStore, textIndex, theme,
    thumbnailClicks, toast, toggleBookmark, toggleSidePanel, tool, touchLayout, typeQuery, undo, unsaved, updateAnnotation, viewer, viewSettings, whatsNew, windowAction,
    windowState, workbench, zoomMode };
}
