import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronDown, ChevronLeft, Cloud, Info, LoaderCircle, Maximize, Minimize, MessageSquare, Minus, MoreHorizontal, Plus, Redo2, Undo2, Upload, X, Wrench, Hash } from 'lucide-react';
import PDFPage, { Thumbnail } from './components/PDFPage';
import Modal, { SheetHandle } from './components/Modal';
import IconButton from './components/IconButton';
import DocumentLibrary from './components/DocumentLibrary';
import NotePopover from './components/NotePopover';
import { DriveBrowser, TransferCard } from './components/DriveBrowser';
import DocumentSwitcher from './components/DocumentSwitcher';
import DocumentTabStrip from './components/DocumentTabStrip';
import DocumentOutline from './components/DocumentOutline';
import ViewSettings from './components/ViewSettings';
import { plural } from './pdf';
import { errorMessage } from './errors';
import { isNativePdfDocument } from './nativePdf';

import { annotationFingerprint, fileSaveLabel, here, saveAdvice, savesInPlace, searchTerm, uid, type DocumentTab, type History, type TabView } from './app/model';
import type { Area, Operation, PageEntry } from './engine/operations.ts';
import Workbench from './components/Workbench';
import CreatePDF from './components/CreatePDF';
import { HelpDialog, ShortcutsDialog } from './components/HelpDialogs';
import SearchPanel from './components/SearchPanel';
import ToolRail from './components/ToolRail';
import { DesktopDocumentActions, TouchDocumentActions } from './components/DocumentActions';
import { CapabilityNotice, CloseBlockedDialog, DocumentInfoDialog, ForgetDocumentDialog, NoteDialog, PageJumpDialog, PasswordDialog, type PasswordRequest } from './components/DocumentDialogs';
import { AnnotationToolbar, ReaderToolbar } from './components/ReaderToolbar';
import { PhoneAnnotationToolbar, PhoneReadingBar } from './components/PhoneReaderControls';
import BookmarkTree from './components/BookmarkTree';
import TextSelectionMenu from './components/TextSelectionMenu';
import HighlightColorPicker from './components/HighlightColorPicker';
import DrawingSettings from './components/DrawingSettings';
import ReadingSettings from './components/ReadingSettings';
import { useInkPreferences } from './app/ink-preferences';
import { useDesktopWindow } from './app/desktop-window';
import { useTheme } from './app/theme';
import { Notices, useNotices } from './app/notices';
import { useReaderZoom, useViewportSize } from './app/reader-zoom';
import { usePageTracking, useReaderTaps, useSwipePages } from './app/reader-navigation';
import { useReaderPosition } from './app/reader-position';
import { usePanels } from './app/panels';
import ExplorerTabs from './components/ExplorerTabs';
import { LiveEdit } from './app/live-edit';
import { Persistence } from './app/persistence';
import { paletteCommands } from './app/palette-commands';
import { DocumentOutput } from './app/document-output';
import { Library } from './app/library';
import { Tabs } from './app/tabs';
import { DocumentOpener } from './app/opener';
import { UndoHistory } from './app/history';
import { useTabView } from './app/tab-view';
import { commentFor, patched, toggledBookmark, useMarks, withAdded, withNote, without } from './app/marks';
import { useDialogs, useDriveState, useNoteEditor } from './app/dialogs';
import { ToolSections } from './app/tool-sections';
import { useAutosave } from './app/autosave';
import { useAppPreferences } from './app/app-preferences';
import { useLibraryCover, useNativeAnnotations, useOutlineLoader, useOutlineSection, usePageLabels } from './app/document-data';
import { usePastedImages } from './edit/paste';
import { DocumentChanges } from './app/document-changes';
import { useDocumentSearch } from './app/search';
import { readShortcut, useKeyboard, type Shortcut } from './app/shortcuts';
import { useAndroidBack, useKeepAwake, useSystemBars, useDesktopDrops, useMacMenu, usePreserveOnLeave, useSystemOpens, useWindowCloseGuard } from './app/native-events';
import { hasBookmarkPage } from './bookmarks';
import { commentSelection, highlightSelection } from './text-selection';
import type { AnnotationDraft } from './text-selection';
import { EditStore } from './edit/store';
import EditToolbar, { readImage } from './edit/EditToolbar';
import { editKey } from './edit/keys';
import './tabs.css';
import './mac-platform.css';
import './mobile.css';
import './desktop.css';
import './tablet.css';
import './motion.css';
import { useExit } from './motion';
import { PageScrubber } from './components/PageScrubber';
import { ActivityPill } from './components/ActivityPill';
import { ColumnSelectionPreview } from './components/ColumnSelectionPreview';
import { AnnotationsPanel } from './components/AnnotationsPanel';
import { CommandPalette } from './components/CommandPalette';
import { WhatsNew } from './components/WhatsNew';
import { useEdgeSwipeBack } from './edge-swipe';
import { PencilPalette, type PencilAction } from './components/PencilPalette';
import { clearRecentSearches } from './search-snippet';
import { TabletReaderHeader, TabletAnnotationDock, TabletSearchBar } from './components/TabletReaderControls';
import { useDeviceLayout } from './mobile';
import { useDocumentTabDrag } from './useDocumentTabDrag';
import { isDesktop, isNative, isIOS, isMobile, isMac, shortcutLabel, pickNativeDocuments, copyNativeText, saveExport, haptic, type Anchor } from './platform';
import { touchDocument } from './storage';
import type { Annotation, LoadedDocument, PDFNavigationTarget, RecentDocument, Tool } from './types';

const NO_ANNOTATIONS: Annotation[] = [];

export default function App() {
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
  // A drawer sliding away keeps showing the tab it was on.
  const explorerTabs = <ExplorerTabs onSelect={showExplorerTab} selected={id => id === 'annotations' ? notesShown : sidebarShown && !searchOpen && sideTab === id} />;
  const libraryContent = <DocumentLibrary onDrive={driveAvailable ? () => setDriveLibrary(true) : undefined} documents={recents} loading={libraryLoading} activeDocument={doc && !doc.sample ? { id: doc.id, name: doc.name, page, pages: doc.pdf.numPages } : undefined} busy={!!busy || loading} onContinue={doc ? () => setLibrary(false) : undefined} onOpen={recent => void reopenRecent(recent)} onImport={() => requestAnimationFrame(() => void chooseFile())} onCreate={() => setCreating(true)} onDelete={setDeleteTarget} onSettings={() => { setConfirmClear(false); setSettings(true); }} onHelp={() => setHelp(true)} onDemo={() => void openDocument('sample')} />;

  const inlineEditing = !phone && workbench === 'edit-pdf';
  const workbenchPanel = workbench && doc && !isNativePdfDocument(doc.pdf) ? <Workbench key={`${doc.revision}-${workbench}`} doc={doc} page={page} section={workbench} inline={inlineEditing} documentBusy={!!busy} area={editArea} onAreaChange={setEditArea} redactions={redactions} onClose={closeWorkbench} onSelectTool={next => { void selectWorkbenchTool(next); }} onOpenEditor={openEditor} onOpenSection={next => { void openWorkbenchSection(next); }} onDraftChange={setEditorDraft} onEditPageChange={next => { readingState.current.page = next; setPage(next); setPageInput(String(next)); }} onApply={applyOperation} getBytes={() => output.currentBytes()} onNotify={message => notify(message, 'success')} onSave={() => { void download({ keepEditing: true }); }} canSave={!busy && !loading && !editorDraft} onHistory={direction => { if (!busy) { if (direction === 'undo') undo(); else redo(); } }} canUndo={!!history.undo.length} canRedo={!!history.redo.length} onReplace={replaceDocument} /> : null;

  const saveLabel = doc?.drive ? 'Guardar en Drive' : fileSaveLabel;
  // Only an opened file can be updated; otherwise Guardar already asks where to save.
  const savesOriginal = savesInPlace && !!doc?.nativeSource && !doc.drive && !doc.draftSource && !doc.sample;
  const sessionStatus = storageFailed ? `No se pudieron guardar tus cambios en ${here}. ${saveAdvice}` : `Los cambios se conservan en ${here}.`;
  const driveDirty = !!doc?.drive && (doc.modified || annotationFingerprint(annotations) !== doc.savedAnnotations);
  // A tab shows its unsaved dot, and Guardar lights up, exactly when this holds.
  const unsaved = (document: LoadedDocument, items: Annotation[]) => document.modified && !downloadedDrafts.current.has(document) || annotationFingerprint(items) !== document.savedAnnotations;
  const docDirty = !!doc && unsaved(doc, annotations);
  const driveStatus = busy === 'download' && driveMessage ? driveMessage : driveDirty ? 'Google Drive: cambios pendientes de guardar' : 'Documento de Google Drive';
  const driveIndicator = doc?.drive && <span className={`drive-document-indicator${driveDirty ? ' pending' : ''}`} role="status" aria-label={driveStatus} title={driveStatus}>{busy === 'download' ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Cloud size={15} aria-hidden="true" />}</span>;

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
  // Scrolling changes the current page many times a second. The stack does not
  // depend on it (except in single-page mode), so a long book's thousands of
  // pages are not re-rendered on every page change.
  const stackPage = readingMode === 'single' ? page : 0;
  const editEnvironment = useMemo(() => editing && doc && !touchLayout ? { store: editStore, doc } : undefined, [editing, doc, touchLayout, editStore]);
  const pageStack = useMemo(() => doc && <div className={`pdf-stack${spread ? ' spread' : ''}`} key={doc.id} style={{ gap: readingPreferences.pageGap }}>{doc.sample && <div className="sample-hint"><BookOpen size={13} /><span>PDF de ejemplo</span></div>}{(readingMode === 'single' ? [page] : pages).map(number => <PDFPage key={number} pdf={doc.pdf} edit={editEnvironment} live={editStore} number={number} pageLabel={pageName(number)} scale={scale} rotation={rotation} dimensions={dimensions} annotations={annotationPages.get(number) || NO_ANNOTATIONS} tool={tool} color={color} inkColor={inkStyle.color} inkWidth={inkStyle.width} inkOpacity={inkStyle.opacity} eraserSize={eraserSize} penOnly={penOnly} query={searchOpen ? searchQuery : ''} activeSearch={searchOpen && (!touchLayout || !sidebar) ? results[resultIndex] : null} canCopy={doc.canCopy} canAnnotate={doc.canAnnotate && !busy && !loading} onRemoveAnnotation={removeAnnotation} onUpdateAnnotation={updateAnnotation} redactions={redactions} {...pageHandlers} />)}</div>, [doc, spread, readingPreferences.pageGap, readingMode, stackPage, pages, pageLabels, scale, rotation, dimensions, annotationPages, tool, color, inkStyle, eraserSize, penOnly, searchOpen, searchQuery, touchLayout, sidebar, results, resultIndex, busy, loading, removeAnnotation, updateAnnotation, redactions, pageHandlers, editEnvironment, editStore]);
  const annotationSettings = tool === 'highlight' ? <HighlightColorPicker color={color} onChange={setColor} disabled={!doc?.canAnnotate || !doc?.canCopy || !!busy || loading} /> : (tool === 'draw' || tool === 'eraser') ? <DrawingSettings mode={tool} kind={inkKind} style={inkStyle} recentColors={inkRecentColors} eraserSize={eraserSize} penOnly={penOnly} showFingerOption={isMobile || penDetected} onKind={setInkKind} onStyle={change => setInkStyles(styles => ({ ...styles, [inkKind]: { ...styles[inkKind], ...change } }))} onCustomColor={value => setInkRecentColors(colors => [value, ...colors.filter(item => item !== value)].slice(0, 5))} onEraserSize={setEraserSize} onPenOnly={choosePenOnly} disabled={!doc?.canAnnotate || !!busy || loading} /> : null;
  // On touch, tools without options keep their slot so no button moves under the finger.
  const annotationSlot = annotationSettings || <span className="drawing-settings-trigger" aria-hidden="true" style={{ visibility: 'hidden' }} />;

  // Swiping in from the left edge goes back: from a document to the library, out of Google Drive.
  useEdgeSwipeBack(touchLayout && !!doc && !library && !inlineEditing && !workbench && !(mobileAnnotating && (tool === 'draw' || tool === 'eraser')), () => void returnToLibrary(), '.app-shell');
  useEdgeSwipeBack(touchLayout && library && driveLibrary, () => setDriveLibrary(false), '.drive-browser');
  return <div className={`app-shell page-tone-${readingPreferences.pageTone}${isDesktop && isMac ? ' native-mac' : ''}${isDesktop && isMac && windowState.fullscreen ? ' mac-fullscreen' : ''}${phone ? ' phone-layout' : tablet ? ' tablet-layout' : ''}${readerChromeHidden ? ' reader-chrome-hidden' : ''}${library ? ' library-visible' : ''}`} onDragEnter={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragCounter.current++; setDragOver(true); } }} onDragLeave={e => { e.preventDefault(); if (--dragCounter.current <= 0) { dragCounter.current = 0; setDragOver(false); } }} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => {
      e.preventDefault(); dragCounter.current = 0; setDragOver(false);
      const image = editing ? Array.from(e.dataTransfer.files).find(file => /^image\/(png|jpeg)$/.test(file.type)) : undefined, point = { clientX: e.clientX, clientY: e.clientY };
      if (image) { void readImage(image).then(value => window.dispatchEvent(new CustomEvent('folio:edit-place-image', { detail: { image: value, ...point } }))).catch(error => notify(errorMessage(error), 'error')); return; }
      if (!isDesktop) void openFiles(Array.from(e.dataTransfer.files));
    }}>
    {closeBlocked && <CloseBlockedDialog name={doc?.name} window={closeBlocked === 'window'} saveLabel={saveLabel} onBack={() => setCloseBlocked(null)}
      onSave={() => { setCloseBlocked(null); void download({ copy: !savesInPlace }); }}
      onDiscard={() => {
        const key = closeBlocked; setCloseBlocked(null);
        if (key === 'window') void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().destroy());
        else requestAnimationFrame(() => void closeTab(key, true));
      }} />}
    <header className="app-header" data-tauri-drag-region inert={touchLayout && (library || sidebar || notesOpen)}>
      {!touchLayout && <div className="brand"><img src="/folio.svg" alt="Folio" /></div>}
      <h1 className="sr-only">{doc?.name || 'Folio'}</h1>
      {tablet ? <TabletReaderHeader nameAdornment={driveIndicator} documentsOpen={mobileTabs} name={doc?.name || 'Folio'} count={tabs.length} page={pageCounter} pageStep={readingMode === 'single' && doc ? { previous: page > 1 ? () => goToPage(page - 1, false) : undefined, next: page < doc.pdf.numPages ? () => goToPage(page + 1, false) : undefined } : undefined} annotating={mobileAnnotating} disabled={!!busy || loading} draft={editorDraft || inlineEditing} canUndo={!!history.undo.length} canRedo={!!history.redo.length} bookmarked={!!doc && hasBookmarkPage(bookmarks, page)} onBookmark={toggleBookmark} onLibrary={() => void returnToLibrary()} onDocuments={() => setMobileTabs(value => !value)} onPage={() => { setPageInput(String(page)); setPageJump(true); }} onPages={() => openExplorer()} onSearch={openSearch} onAnnotate={startAnnotating} onDone={() => { setMobileAnnotating(false); setTool('select'); }} onUndo={undo} onRedo={redo} onMore={() => setMobileActions(true)} /> : phone ? <>
        <IconButton label="Volver a la biblioteca" disabled={!!busy || loading} onClick={() => void returnToLibrary()}><ChevronLeft size={24} /></IconButton>
        <button id="document-switcher-trigger" className="mobile-document-selector" aria-label="Documentos abiertos y recientes" aria-haspopup="dialog" aria-expanded={mobileTabs} aria-controls="document-switcher" disabled={!!busy || loading || !tabs.length} onClick={() => setMobileTabs(value => !value)}><span>{doc?.name || 'Folio'}</span>{driveIndicator}{tabs.length > 1 && <span className="mobile-tab-count">{tabs.length}</span>}<ChevronDown size={16} /></button>
        {mobileAnnotating ? <><IconButton label="Deshacer" disabled={!!busy || !history.undo.length} onClick={undo}><Undo2 size={21} /></IconButton><IconButton label="Rehacer" disabled={!!busy || !history.redo.length} onClick={redo}><Redo2 size={21} /></IconButton><button className="mobile-done" onClick={() => { setMobileAnnotating(false); setTool('select'); }}>Listo</button></> : <IconButton label="Más acciones" onClick={() => setMobileActions(true)}><MoreHorizontal size={23} /></IconButton>}
      </> : <>
      <DocumentTabStrip tabs={tabs} activeKey={activeTabKey} disabled={!!busy || loading || editorDraft} driveIndicator={driveIndicator} drag={tabDrag}
        modified={tab => unsaved(tab.doc, tab.key === activeTabKey ? annotations : tab.annotations)}
        onShow={() => setLibrary(false)} onSwitch={key => void switchTab(key)} onClose={key => void closeTab(key)} />
      {tabs.length > 0 && <IconButton label="Abrir PDF" disabled={!!busy || loading || editorDraft} onClick={() => void chooseFile()} className="new-document-tab"><Plus size={19} /></IconButton>}
      <div className="header-drag-space" data-tauri-drag-region />
      {/* Document information lives in Más acciones and creation in the library. */}
      <div className="header-actions">
        {storageFailed && <button className="session-warning" title={sessionStatus} onClick={() => void download()}><Info size={15} />Cambios sin guardar</button>}
      </div>
      {isDesktop && !isMac && <div className="window-actions">
        <IconButton label="Minimizar ventana" onClick={() => void windowAction('minimize')}><Minus size={16} /></IconButton>
        <IconButton label={windowState.maximized ? 'Restaurar ventana' : 'Maximizar ventana'} onClick={() => void windowAction('toggleMaximize')}>{windowState.maximized ? <Minimize size={14} /> : <Maximize size={14} />}</IconButton>
        <IconButton label="Cerrar ventana" onClick={() => void windowAction('close')} className="window-close"><X size={17} /></IconButton>
      </div>}
      </>}
      <input ref={fileInput} type="file" multiple accept="application/pdf,.pdf" className="sr-only" aria-label="Elegir archivo PDF" tabIndex={-1} aria-hidden="true" onChange={e => { const input = e.currentTarget; void openFiles(Array.from(input.files || [])).finally(() => { input.value = ''; }); }} />
    </header>

    <div className="workspace" inert={library}>
      {!touchLayout && <ToolRail library={library} hasDocument={!!doc} panel={sidebar && !searchOpen ? sideTab : null} searching={searchOpen && sidebar} notesOpen={notesOpen} annotations={annotations.length} inert={inlineEditing}
        onLibrary={() => setLibrary(true)} onPanel={toggleSidePanel} onSearch={() => { if (searchOpen && sidebar) closeSearch(); else openSearch(); }}
        onNotes={() => { if (window.innerWidth < 1000) { setSidebar(false); setSearchOpen(false); } setNotesOpen(v => !v); }}
        onSettings={() => { setSettings(true); setConfirmClear(false); }} onHelp={() => setHelp(true)} />}
      {touchLayout && (sidebar || notesOpen || sidebarLeaving || notesLeaving) && <button className={`mobile-panel-backdrop${sidebar || notesOpen ? '' : ' closing'}`} aria-label="Cerrar panel lateral" tabIndex={-1} onClick={closeMobilePanel} />}
      {sidebarShown && <aside className={`sidebar${touchLayout ? ' mobile-drawer' : ''}${sidebarLeaving ? ' closing' : ''}${drawerSwap ? ' drawer-swap' : ''}`} role={touchLayout ? 'dialog' : undefined} aria-modal={touchLayout ? true : undefined} aria-label={touchLayout ? searchOpen ? 'Buscar en el PDF' : 'Explorar documento' : undefined} style={touchLayout ? undefined : { width: readingPreferences.panelWidth, minWidth: readingPreferences.panelWidth }}>
        {touchLayout && <><SheetHandle onClose={closeMobilePanel} label="Cerrar explorador" /><div className="mobile-drawer-heading"><h2>{searchOpen ? 'Buscar' : 'Explorar'}</h2><IconButton label={searchOpen ? 'Cerrar búsqueda' : 'Cerrar panel'} onClick={closeMobilePanel}><X size={20} /></IconButton></div>{!searchOpen && explorerTabs}</>}
        {searchOpen ? <SearchPanel touch={touchLayout} input={searchInput} query={query} searchQuery={searchQuery} onClose={closeSearch}
          onQuery={typeQuery} onClear={() => setQuery('')}
          onSubmit={backwards => submitSearch(backwards ? -1 : phone ? 0 : 1)}
          history={searchHistory} onClearHistory={() => { clearRecentSearches(); setSearchHistory([]); }}
          indexing={indexing} indexed={textIndex} pages={doc?.pdf.numPages || 0} results={results} occurrences={occurrences} selected={resultIndex}
          listed={listedResults} onShowMore={() => setResultLimit(listedResults + 200)} onResult={goToResult} pageName={pageName} section={outlineSection}
          onRecognize={doc?.canEdit && !isNativePdfDocument(doc.pdf) ? () => { closeSearch(); void openWorkbenchSection('ocr'); } : undefined} />
          : <>
          {!touchLayout && <div className="sidebar-title"><span>{sideTab === 'pages' ? 'Páginas' : sideTab === 'outline' ? 'Índice' : 'Marcadores'}</span>{!!sideCount && <span className="page-total">{sideCount}</span>}<IconButton label="Cerrar panel" onClick={() => { setSidebar(false); focusRail(sideTab === 'pages' ? 'Páginas' : sideTab === 'outline' ? 'Índice' : 'Marcadores'); }}><X size={16} /></IconButton></div>}

          <div className={`sidebar-scroll ${sideTab === 'pages' ? 'thumbnails' : 'outline-list'}`} id={touchLayout ? 'explorer-panel' : undefined} role={touchLayout ? 'tabpanel' : undefined}>
            {sideTab === 'pages' && doc && pages.map(number => <Thumbnail key={`${doc.pdf.loadingTask.docId}-${number}`} pdf={doc.pdf} number={number} rotation={rotation} pageLabel={pageName(number)} selected={page === number} onClick={thumbnailClicks[number - 1]} />)}
            {sideTab === 'outline' && (outline ? <DocumentOutline outline={outline} page={page} onNavigate={mobilePage} /> : <div className="empty-panel"><LoaderCircle size={26} className="spin" /><p>Cargando índice…</p></div>)}
            {sideTab === 'bookmarks' && <BookmarkTree key={activeTabKey} bookmarks={bookmarks} onChange={commitBookmarks} onFold={showBookmarks} page={page} onGoToPage={mobilePage} disabled={!!busy || loading} startEditingId={bookmarkEditingId} onEditingComplete={() => setBookmarkEditingId(null)} />}
          </div>
        </>}
      </aside>}

      <main className={`reader${phone && mobileAnnotating ? ' mobile-annotating' : ''}`} id="document-reader" inert={library || touchLayout && (sidebar || notesOpen)}>
        {!touchLayout && !inlineEditing && <ReaderToolbar doc={doc} busy={!!busy} loading={loading} mode={editing ? 'edit' : mobileAnnotating ? 'annotate' : 'read'}
          onRead={() => { setEditing(false); setMobileAnnotating(false); setTool('select'); }} onAnnotate={startAnnotating} onEdit={openEditor} onTools={openTools}
          canUndo={!!history.undo.length} canRedo={!!history.redo.length} onUndo={undo} onRedo={redo}
          page={page} pageInput={pageInput} onPageInput={editPageInput} onPageCommit={commitPageInput} onPageBlur={() => { if (pageInputDirty.current) commitPageInput(); }} onPage={goToPage}
          zoomMode={zoomMode} scale={scale} onZoom={changeZoom} onZoomChoice={value => { if (['page', 'width'].includes(value)) setZoomMode(value); else { setCustomScale(Number(value) / 100); setZoomMode('custom'); } }}
          bookmarked={hasBookmarkPage(bookmarks, page)} onBookmark={toggleBookmark} saveLabel={saveLabel} unsaved={docDirty} onSave={() => void download()} onMore={() => setMobileActions(true)} />}
        {!touchLayout && !inlineEditing && doc && editing && <EditToolbar store={editStore} doc={doc} onDone={() => setEditing(false)} />}
        {!touchLayout && !inlineEditing && doc && mobileAnnotating && !editing && <AnnotationToolbar doc={doc} disabled={!!busy || loading} tool={tool} onTool={setTool} onHighlight={activateHighlight}
          settings={annotationSettings} onDone={() => { setMobileAnnotating(false); setTool('select'); }} />}

        {tablet && doc && mobileAnnotating && !inlineEditing && <TabletAnnotationDock tool={tool} setTool={setTool} disabled={!doc.canAnnotate || !!busy || loading} canCopy={doc.canCopy} settings={annotationSlot} hasSettings={!!annotationSettings} onHighlight={activateHighlight} />}
        {tablet && doc && searchOpen && !sidebar && !inlineEditing && <TabletSearchBar results={results.length} result={resultIndex} onResult={goToResult} onResults={() => setSidebar(true)} onClose={closeSearch} />}
        {inlineEditing && workbenchPanel}
        <div className="reading-area" hidden={inlineEditing} style={inlineEditing ? { display: 'none' } : undefined} ref={viewer} aria-label="Área de lectura del PDF" tabIndex={-1}>
          {doc ? pageStack : !loading && <div className="welcome"><div className="welcome-icon"><BookOpen size={38} /></div><h2>Abrir PDF</h2><p>{!touchLayout ? 'Selecciona un archivo o arrástralo a esta ventana.' : isIOS ? 'Selecciona un PDF desde Archivos.' : 'Selecciona un PDF para abrirlo.'}</p></div>}
          {loading && <div className="loading-overlay" role="status"><svg className="activity-ring large" viewBox="0 0 24 24" aria-hidden="true"><circle className="activity-ring-track" cx="12" cy="12" r="9" /><circle className="activity-ring-arc" cx="12" cy="12" r="9" /></svg><span>Abriendo PDF…</span></div>}
        </div>
        {touchLayout && doc && !inlineEditing && !loading && !(mobileAnnotating && (tool === 'draw' || tool === 'eraser')) && <PageScrubber pdf={doc.pdf} page={page} pages={doc.pdf.numPages} viewer={viewer.current} continuous={readingMode !== 'single'} label={pageName} section={outlineSection} onJump={target => { if (!returnLocation) rememberLocation(); goToPage(target, false); }} />}
        {touchLayout && doc && returnPage !== null && <button className="touch-return-location" onClick={returnToLocation}><ChevronLeft size={18} /><span>Volver a p. {pageName(returnPage)}</span></button>}

        {phone && doc && <PhoneReadingBar doc={doc} disabled={!!busy || loading} page={page} counter={pageCounter ?? ''} singlePage={readingMode === 'single'} onPage={next => goToPage(next, false)}
          onJump={() => { setPageInput(String(page)); setPageJump(true); }} bookmarked={hasBookmarkPage(bookmarks, page)} onBookmark={toggleBookmark} annotating={mobileAnnotating}
          searching={searchOpen && !sidebar} results={results.length} result={resultIndex} onResult={goToResult} onResults={() => setSidebar(true)} onCloseSearch={closeSearch}
          onPages={() => openExplorer()} onSearch={openSearch} onAnnotate={startAnnotating} onShare={button => void shareDocument(anchorOf(button))} />}
        {!touchLayout && doc && returnPage !== null && <button className="desktop-return-location" onClick={returnToLocation}><ChevronLeft size={16} /><span>Volver a p. {returnPage}</span></button>}
        {phone && doc && mobileAnnotating && <PhoneAnnotationToolbar doc={doc} disabled={!!busy || loading} tool={tool} onTool={setTool} onHighlight={activateHighlight} settings={annotationSlot} onMore={() => setAnnotationOptions(true)} />}

        {tool !== 'select' && tool !== 'highlight' && tool !== 'draw' && tool !== 'eraser' && doc && (touchLayout || !mobileAnnotating) && <div className="annotation-tool-hint">
          <span>{tool === 'note' ? touchLayout ? 'Toca la página para añadir una nota' : 'Haz clic en la página para añadir una nota' : tool === 'redact' ? 'Marca las áreas que quieres censurar' : tool === 'crop' ? 'Arrastra sobre la página para elegir el área visible' : 'Arrastra para seleccionar el área'}</span>
          {!phone && tool !== 'note' && (tool !== 'redact' || !redactions.length) && <button className="secondary-button" disabled={!doc.canEdit || !!busy} onClick={() => void centerArea()}>Usar un área centrada</button>}
          {tool === 'redact' && redactions.length > 0 && <><button className="secondary-button" onClick={() => setRedactions(previous => previous.slice(0, -1))}>Quitar última área</button><button className="primary-button" onClick={() => setWorkbench('redact')}>Revisar {plural(redactions.length, 'área', 'áreas')}</button></>}
          {!(touchLayout && mobileAnnotating && tool === 'note') && <IconButton label="Terminar herramienta" onClick={() => { setTool('select'); setRedactions([]); }}><X size={15} /></IconButton>}
        </div>}


      </main>

      {notesShown && <aside className={`notes-panel${touchLayout ? ' mobile-drawer' : ''}${notesLeaving ? ' closing' : ''}${drawerSwap ? ' drawer-swap' : ''}`} role={touchLayout ? 'dialog' : undefined} aria-modal={touchLayout ? true : undefined} aria-label={touchLayout ? 'Anotaciones' : undefined}>{touchLayout && <><SheetHandle onClose={closeMobilePanel} label="Cerrar explorador" /><div className="mobile-drawer-heading"><h2>Explorar</h2><IconButton label="Cerrar panel" onClick={closeMobilePanel}><X size={20} /></IconButton></div>{explorerTabs}</>}{!touchLayout && <div className="notes-heading"><div><MessageSquare size={17} /><h2>Anotaciones</h2><span>{annotations.length}</span></div><IconButton label="Cerrar anotaciones" onClick={() => { setNotesOpen(false); focusRail('Anotaciones'); }}><X size={16} /></IconButton></div>}<div className="notes-scroll" id={touchLayout ? 'explorer-panel' : undefined} role={touchLayout ? 'tabpanel' : undefined}>{doc && <AnnotationsPanel annotations={annotations} documentName={doc.name} activeId={activeNote} editable={!!doc.canAnnotate && !busy && !loading} pageName={pageName}
          onSelect={item => { mobilePage(item.page); setActiveNote(item.id); }} onDelete={item => { removeAnnotation(item.id); notify(item.kind === 'note' ? 'Nota eliminada.' : item.kind === 'ink' ? 'Dibujo eliminado.' : 'Resaltado eliminado.', 'info', { label: 'Deshacer', run: undo }); }} onEditNote={item => editNote(item, 'list')}
          onCopy={async text => { if (isNative && isIOS) await copyNativeText(text); else await navigator.clipboard.writeText(text); }}
          onSave={(text, name) => saveExport(new TextEncoder().encode(text), name, 'txt', doc.nativeSource)} />}</div></aside>}
    </div>

    {touchLayout && <DocumentSwitcher open={mobileTabs && !library} documents={tabs.map(tab => ({ key: tab.key, id: tab.doc.id, name: tab.doc.name, page: tab.key === activeTabKey ? page : tab.page, pages: tab.doc.pdf.numPages }))} recents={recents} activeKey={activeTabKey} disabled={!!busy || loading || editorDraft} onDismiss={() => setMobileTabs(false)} onSelect={key => { setMobileTabs(false); requestAnimationFrame(() => { closeMobilePanel(); if (key === activeTabKey) setLibrary(false); else void switchTab(key); }); }} onRecent={recent => { setMobileTabs(false); requestAnimationFrame(() => { closeMobilePanel(); void reopenRecent(recent); }); }} onCloseDocument={key => { setMobileTabs(false); requestAnimationFrame(() => void closeTab(key)); }} onImport={() => { setMobileTabs(false); requestAnimationFrame(() => void chooseFile()); }} onLibrary={() => { setMobileTabs(false); void returnToLibrary(); }} />}
    {touchLayout && mobileActions && <TouchDocumentActions doc={doc} busy={!!busy} loading={loading} status={sessionStatus} storageFailed={storageFailed} onClose={() => setMobileActions(false)}
      tablet={tablet} saveLabel={saveLabel} savesOriginal={savesOriginal} capabilitySummary={capabilitySummary} canUndo={history.undo.length > 0} canRedo={history.redo.length > 0}
      on={{ save: () => void download(), saveCopy: () => void download({ copy: true }), undo, redo, drive: showDrive, share: anchor => void shareDocument(anchor), edit: openEditor,
        view: () => setViewSettings(true), tools: openTools, print: anchor => void printDocument(anchor), info: () => setInfo(true), close: closeActiveTab }} />}
    {!touchLayout && mobileActions && <DesktopDocumentActions doc={doc} busy={!!busy} loading={loading} status={sessionStatus} storageFailed={storageFailed} onClose={() => setMobileActions(false)}
      singlePage={readingMode === 'single'} on={{ drive: showDrive, saveCopy: () => void download({ copy: true }), toggleSinglePage: () => setReadingMode(readingMode === 'single' ? 'continuous' : 'single'),
        rotate: () => setRotation(value => (value + 90) % 360), print: () => void printDocument(), fullscreen: () => void fullscreen(), info: () => setInfo(true), close: closeActiveTab }} />}
    {phone && annotationOptions && <Modal title="Opciones de anotación" onClose={() => setAnnotationOptions(false)}><div className="mobile-action-grid"><button onClick={() => { setAnnotationOptions(false); setSidebar(false); setNotesOpen(true); }}><MessageSquare size={21} />Ver anotaciones ({annotations.length})</button><button onClick={() => { setAnnotationOptions(false); openTools(); }}><Wrench size={21} />Herramientas</button></div></Modal>}
    {touchLayout && pageJump && doc && <PageJumpDialog pages={doc.pdf.numPages} page={page} value={pageInput} onValue={setPageInput} onCancel={() => setPageJump(false)}
      onGo={next => { rememberLocation(); setPageJump(false); requestAnimationFrame(() => goToPage(next, false)); }} />}

    {viewSettings && <ViewSettings touch={touchLayout} phone={phone} mode={readingMode} onMode={setReadingMode} zoom={zoomMode} scale={scale} onZoom={value => { if (['width', 'page'].includes(value)) setZoomMode(value); else { setCustomScale(Number(value) / 100); setZoomMode('custom'); } }} rotation={rotation} onRotate={() => setRotation(value => (value + 90) % 360)} pageTone={readingPreferences.pageTone} onPageTone={pageTone => setReadingPreferences(current => ({ ...current, pageTone }))} keepAwake={readingPreferences.keepAwake} onKeepAwake={isNative && isMobile ? keepAwake => setReadingPreferences(current => ({ ...current, keepAwake })) : undefined} onClose={() => setViewSettings(false)} />}
    {capabilityNotice && <CapabilityNotice summary={capabilitySummary} onClose={() => setCapabilityNotice(false)} />}
    <TextSelectionMenu key={doc?.pdf.loadingTask.docId} enabled={!!doc?.canCopy && !editing && !mobileActions && tool === 'select' && !loading && !busy && !noteDraft && !workbench && !creating && !library && !settings && !help && !info && !password && !closeBlocked && !pageJump && !viewSettings && !annotationOptions && !capabilityNotice && !deleteTarget && !(touchLayout && (sidebar || notesOpen || mobileActions || mobileTabs))} canAnnotate={!!doc?.canAnnotate} color={color} onHighlight={() => { highlightSelection(); }} onComment={() => { commentSelection(); }} onNotify={(message, error) => notify(message, error ? 'error' : 'success')} />
    {dragOver && <div className="drop-overlay"><div><Upload size={38} /><h2>Suelta para abrir</h2><p>Archivos PDF</p></div></div>}
    {creating && <CreatePDF onClose={() => setCreating(false)} onCreate={async (bytes, name) => { await openDocument(bytes, name, false, undefined, { modified: true, useSession: false }); setCreating(false); }} />}
    <ActivityPill working={activity} done={activityDone} />
    <PencilPalette enabled={!!doc?.canAnnotate && !library && !busy && !loading && !workbench} inkColor={inkStyle.color} canUndo={history.undo.length > 0}
      active={tool === 'draw' ? inkKind : tool === 'eraser' || tool === 'highlight' || tool === 'note' ? tool as PencilAction : undefined}
      onAction={action => {
        if (action === 'undo') { undo(); return; }
        setMobileAnnotating(true);
        if (action === 'pen' || action === 'marker') { setInkKind(action); setTool('draw'); }
        else if (action === 'highlight') activateHighlight();
        else setTool(action);
      }} />
    {whatsNew && <WhatsNew touch={touchLayout} onClose={() => setWhatsNew(false)} />}
    {palette && <CommandPalette commands={commands()} onClose={() => setPalette(false)} pageCommand={number => doc && number >= 1 && number <= doc.pdf.numPages ? { id: 'page-number', group: 'Navegación', title: `Ir a la página ${number}`, icon: <Hash size={16} />, run: () => { if (!returnLocation) rememberLocation(); goToPage(number, false); } } : null} />}
    {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    {doc && <ColumnSelectionPreview />}
    <Notices toast={toast} onDismiss={dismissToast} />

    {library && <div className={`library-screen${phone ? '' : ' desktop-library-screen'}`}>{driveLibrary ? <DriveBrowser onClose={() => setDriveLibrary(false)} onOpen={(file, pending) => libraryStore.openDrive(file, pending)} onSynced={file => { libraryStore.synced(file); tabStore.publish(); }} conflicts={driveConflicts} onConflicts={setDriveConflicts} /> : libraryContent}</div>}
    {driveRefresh && <TransferCard transfer={driveRefresh} />}
    {deleteTarget && <ForgetDocumentDialog target={deleteTarget} open={tabs.some(tab => tab.doc.id === deleteTarget.id)} disabled={!!busy || loading} onCancel={() => setDeleteTarget(null)} onConfirm={() => void forgetRecent(deleteTarget)} />}
    {!inlineEditing && workbenchPanel}
    {noteDraft && touchLayout && <NoteDialog isNew={!noteDraft.id} page={pageName(noteDraft.page)} text={noteText} onText={setNoteText} onSave={saveNote} onCancel={() => setNoteDraft(null)} />}
    {noteDraft && !touchLayout && <NotePopover anchor={noteAnchor} page={pageName(noteDraft.page)} text={noteText} color={noteDraft.color} isNew={!noteDraft.id} shortcut={shortcutLabel('↵')} onText={setNoteText}
      onColor={color => setNoteDraft(draft => draft && { ...draft, color })} onSave={saveNote} onCancel={() => setNoteDraft(null)} onRemove={noteDraft.id ? () => { removeAnnotation(noteDraft.id!); setNoteDraft(null); } : undefined} />}
    {password && <PasswordDialog request={password} onSubmitted={() => setPassword(null)} onCancel={cancelPassword} />}
    {info && doc && <DocumentInfoDialog doc={doc} annotations={annotations.length} bookmarks={bookmarks.length} onClose={() => setInfo(false)} />}
    {settings && <ReadingSettings layout={layout} theme={theme} onTheme={chooseTheme} zoom={defaultZoom} onZoom={setDefaultZoom} preferences={readingPreferences} onPreferences={setReadingPreferences} rememberRecent={rememberRecent} onRemember={setRememberRecent} openDocuments={tabs.length} confirmClear={confirmClear} onClear={() => void clearLibrary()} onCancelClear={() => setConfirmClear(false)} onClose={() => setSettings(false)} />}
    {help && <HelpDialog touch={touchLayout} onClose={() => setHelp(false)} />}
  </div>;
}
