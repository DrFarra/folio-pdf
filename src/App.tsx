import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Bookmark, ChevronDown, ChevronLeft, Cloud, Info, Layers, ListTree, LoaderCircle, Maximize, Minimize, MessageSquare, Minus, MoreHorizontal, Plus, Redo2, Undo2, Upload, X, Wrench, Hash } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import PDFPage, { Thumbnail } from './components/PDFPage';
import Modal, { SheetHandle } from './components/Modal';
import IconButton from './components/IconButton';
import DocumentLibrary from './components/DocumentLibrary';
import NotePopover from './components/NotePopover';
import { DriveBrowser, TransferCard, type Transfer } from './components/DriveBrowser';
import { driveStatus as readDriveStatus } from './drive';
import DocumentSwitcher from './components/DocumentSwitcher';
import DocumentTabStrip from './components/DocumentTabStrip';
import DocumentOutline from './components/DocumentOutline';
import ViewSettings from './components/ViewSettings';
import { formatSize, plural, readOutline, readPageLabels, readPageLabel } from './pdf';
import { errorMessage } from './errors';
import { isNativePdfDocument, subscribeNativePdfAnnotations } from './nativePdf';
import { migrateLegacyNativePage } from './native-session';
import { processPdf } from './engine/client';
import { DEFAULT_HIGHLIGHT_COLOR, annotationFingerprint, fileSaveLabel, here, saveAdvice, savesInPlace, searchTerm, trimHistory as trimSteps, uid, type DocumentTab, type History, type NoteDraft, type TabView } from './app/model';
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
import { readReadingPreferences } from './reading-preferences';
import { preference } from './preferences';
import { useInkPreferences } from './app/ink-preferences';
import { useDesktopWindow } from './app/desktop-window';
import { useTheme } from './app/theme';
import { Notices, useNotices } from './app/notices';
import { useReaderZoom } from './app/reader-zoom';
import { usePageTracking, useReaderTaps, useSwipePages } from './app/reader-navigation';
import { LiveEdit } from './app/live-edit';
import { Persistence } from './app/persistence';
import { paletteCommands } from './app/palette-commands';
import { DocumentOutput } from './app/document-output';
import { Library } from './app/library';
import { Tabs } from './app/tabs';
import { DocumentOpener } from './app/opener';
import { useDocumentSearch } from './app/search';
import { readShortcut, useKeyboard, type Shortcut } from './app/shortcuts';
import { useAndroidBack, useDesktopDrops, useMacMenu, usePreserveOnLeave, useSystemOpens, useWindowCloseGuard } from './app/native-events';
import { addPageBookmark, deleteBookmark, hasBookmarkPage, remapBookmarks } from './bookmarks';
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
import { markDrive, readCover, renderCover, saveCover } from './library-meta';
import { PageScrubber } from './components/PageScrubber';
import { ActivityPill } from './components/ActivityPill';
import { ColumnSelectionPreview } from './components/ColumnSelectionPreview';
import { addHighlights } from './highlight-merge';
import { AnnotationsPanel } from './components/AnnotationsPanel';
import { CommandPalette } from './components/CommandPalette';
import { WhatsNew, shouldShowWhatsNew } from './components/WhatsNew';
import { useEdgeSwipeBack } from './edge-swipe';
import { PencilPalette, type PencilAction } from './components/PencilPalette';
import { clearRecentSearches, rememberSearch } from './search-snippet';
import { TabletReaderHeader, TabletAnnotationDock, TabletSearchBar } from './components/TabletReaderControls';
import { useDeviceLayout } from './mobile';
import { useDocumentTabDrag } from './useDocumentTabDrag';
import { isDesktop, isNative, isIOS, isMobile, isMac, setReaderChrome, shortcutLabel, pickNativeDocuments, openExternalUrl, prunePrivateCopies, copyNativeText, saveExport, setKeepAwake, haptic, type Anchor } from './platform';
import { clearSavedState, forgetDocument, listLibrary, touchDocument, saveSession } from './storage';
import type { Annotation, BookmarkNode, LoadedDocument, OutlineEntry, PDFNavigationTarget, RecentDocument, SideTab, Tool } from './types';

const NO_ANNOTATIONS: Annotation[] = [];

export default function App() {
  const layout = useDeviceLayout(), phone = layout === 'phone', tablet = layout === 'tablet', touchLayout = phone || tablet;
  const [mobileActions, setMobileActions] = useState(false);
  const [mobileTabs, setMobileTabs] = useState(false);
  const [mobileAnnotating, setMobileAnnotating] = useState(false);
  // Editar inside the reader (desktop): the pages stay, with an edit layer and toolbar.
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing); editingRef.current = editing;
  const editStore = useMemo(() => new EditStore(), []);
  const tabStore = useMemo(() => new Tabs(), []);
  const opener = useMemo(() => new DocumentOpener(), []);
  const liveEdit = useMemo(() => new LiveEdit(), []);
  const persistence = useMemo(() => new Persistence(), []);
  const output = useMemo(() => new DocumentOutput(), []);
  const libraryOpener = useMemo(() => new Library(), []);
  const [readerChromeHidden, setReaderChromeHidden] = useState(false);
  const [doc, setDoc] = useState<LoadedDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'download' | 'print' | 'edit' | 'close' | null>(null);
  const [workbench, setWorkbench] = useState<string | null>(null);
  const workbenchRef = useRef(workbench); workbenchRef.current = workbench;
  const [editorDraft, setEditorDraft] = useState(false);
  const editorDraftRef = useRef(editorDraft); editorDraftRef.current = editorDraft;
  const editorReadingLocation = useRef<{ revision: string; page: number; top: number; left: number } | null>(null);
  const editorRestorePending = useRef(false);
  const editorRestoreRequest = useRef(0);
  const [creating, setCreating] = useState(false);
  const [editArea, setEditArea] = useState<Area | null>(null);
  const [redactions, setRedactions] = useState<Area[]>([]);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [dimensions, setDimensions] = useState({ width: 595, height: 842, rotation: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 1000, height: 700 });
  const [rotation, setRotation] = useState(0);
  const [readingMode, setReadingMode] = useState<'continuous' | 'single' | 'spread'>(() => readReadingPreferences().mode);
  const [tool, setTool] = useState<Tool>('select');
  const { inkKind, setInkKind, setInkStyles, inkStyle, inkRecentColors, setInkRecentColors, eraserSize, setEraserSize, penOnly, choosePenOnly, penDetected } = useInkPreferences();
  const [color, setColor] = useState(() => { const saved = preference('folio.highlightColor', DEFAULT_HIGHLIGHT_COLOR); return /^#[0-9a-f]{6}$/i.test(saved) ? saved : DEFAULT_HIGHLIGHT_COLOR; });
  const [sidebar, setSidebar] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>('pages');
  const [notesOpen, setNotesOpen] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkNode[]>([]);
  const [bookmarkEditingId, setBookmarkEditingId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const visitedSearch = useRef<string | null>(null);
  const submitPending = useRef(false);
  const sidebarBeforeSearch = useRef(false);
  const [library, setLibrary] = useState(true);
  const libraryRef = useRef(library); libraryRef.current = library;
  const [driveLibrary, setDriveLibrary] = useState(false);
  const [driveMessage, setDriveMessage] = useState('');
  const [driveConflicts, setDriveConflicts] = useState<string[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [pageLabels, setPageLabels] = useState<string[] | null>(null);
  const [currentPageLabel, setCurrentPageLabel] = useState('1');
  const [pageJump, setPageJump] = useState(false);
  const [viewSettings, setViewSettings] = useState(false);
  const [annotationOptions, setAnnotationOptions] = useState(false);
  const [capabilityNotice, setCapabilityNotice] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RecentDocument | null>(null);
  const [returnLocation, setReturnLocation] = useState<{ key: string; page: number; top: number; left: number } | null>(null);
  const [recents, setRecents] = useState<RecentDocument[]>([]);
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState(false);
  const [rememberRecent, setRememberRecent] = useState(() => preference('folio.remember', 'true') !== 'false');
  const [defaultZoom, setDefaultZoom] = useState(() => preference('folio.defaultZoom', 'page'));
  const [readingPreferences, setReadingPreferences] = useState(readReadingPreferences);
  const readingPreferencesRef = useRef(readingPreferences); readingPreferencesRef.current = readingPreferences;
  const [confirmClear, setConfirmClear] = useState(false);
  const [info, setInfo] = useState(false);
  const [palette, setPalette] = useState(false);
  const [whatsNew, setWhatsNew] = useState(shouldShowWhatsNew);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const noteOrigin = useRef<'document' | 'list'>('document');
  const [noteText, setNoteText] = useState('');
  // Where the note card opens: beside the note's marker, or where a new note was clicked.
  const [noteAnchor, setNoteAnchor] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const lastPointer = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const remember = (event: PointerEvent) => { lastPointer.current = { x: event.clientX, y: event.clientY }; };
    document.addEventListener('pointerdown', remember, true);
    return () => document.removeEventListener('pointerdown', remember, true);
  }, []);
  const noteKey = noteDraft ? noteDraft.id ?? 'new' : null;
  useLayoutEffect(() => {
    if (!noteKey) return;
    const marker = noteKey !== 'new' ? document.querySelector(`.note-marker[data-note-id="${CSS.escape(noteKey)}"]`)?.getBoundingClientRect() : null;
    const { x, y } = lastPointer.current;
    setNoteAnchor(marker ? (marker.bottom > 0 && marker.top < innerHeight ? marker : null) : x || y ? { left: x, top: y, right: x + 26, bottom: y + 27 } : null);
  }, [noteKey]);
  const [activeNote, setActiveNote] = useState<string | null>(null);
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
  const [driveAvailable, setDriveAvailable] = useState(isNative);
  const [driveRefresh, setDriveRefresh] = useState<Transfer | null>(null);
  const [sessionFailed, setSessionFailed] = useState(false);
  const [draftFailed, setDraftFailed] = useState(false);
  const storageFailed = sessionFailed || draftFailed;
  useEffect(() => { if (tool === 'highlight' || tool === 'note') setMobileAnnotating(true); }, [tool]);
  // The tab key, or 'window', whose closing waits because its session could not be saved.
  const [closeBlocked, setCloseBlocked] = useState<string | null>(null);
  const [, setHistoryTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const picking = useRef(false);
  const viewer = useRef<HTMLDivElement>(null);
  const pageInputDirty = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const loadingRef = useRef(loading); loadingRef.current = loading;
  const restoreScroll = useRef<{ key: string; top: number; left: number } | null>(null);
  const scrollRestoreFrame = useRef<number | null>(null);
  const docRef = useRef<LoadedDocument | null>(null);
  const annotationRef = useRef<Annotation[]>([]);
  const readingState = useRef({ page, bookmarks });
  readingState.current = { page, bookmarks };
  const undoStack = useRef<History[]>([]);
  const redoStack = useRef<History[]>([]);
  const sessionSaved = useRef<{ doc: LoadedDocument; annotations: Annotation[]; bookmarks: BookmarkNode[] } | null>(null);
  const librarySave = useRef<Promise<void>>(Promise.resolve());
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const dragCounter = useRef(0);
  const forgottenIds = useRef(new Set<string>());
  // Web documents whose edited PDF was downloaded as it is now: their tab no longer reads as unsaved.
  const downloadedDrafts = useRef(new WeakSet<LoadedDocument>());
  // Documents whose stored session could not be read: nothing rewrites it until the user changes something.
  const unreadSessions = useRef(new Set<string>());
  const preferencesRef = useRef({ rememberRecent, defaultZoom });
  const phoneRef = useRef(phone); phoneRef.current = phone;
  const touchRef = useRef(touchLayout); touchRef.current = touchLayout;
  const chromeHiddenRef = useRef(readerChromeHidden); chromeHiddenRef.current = readerChromeHidden;
  const fittedWidth = useRef(viewportSize.width); fittedWidth.current = viewportSize.width;
  const activityLabel = busy === 'download' ? doc?.drive ? driveMessage || 'Guardando en Google Drive…' : savesInPlace ? 'Guardando el PDF…' : isNative ? 'Guardando una copia…' : 'Preparando el PDF…'
    : busy === 'print' ? 'Preparando la impresión…' : busy === 'edit' ? 'Aplicando los cambios…' : '';
  const { toast, notify, dismiss: dismissToast, activity, activityDone } = useNotices(activityLabel);
  const { textIndex, setTextIndex, indexing, setIndexing, query, setQuery, searchQuery, setSearchQuery, searchNow, resultIndex, setResultIndex,
    resultLimit, setResultLimit, results, occurrences, history: searchHistory, setHistory: setSearchHistory } = useDocumentSearch(doc, searchOpen, notify);
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
    return { ...activeView.current, key, doc: current, annotations: annotationRef.current, bookmarks: readingState.current.bookmarks,
      undo: undoStack.current, redo: redoStack.current, scrollTop: viewer.current?.scrollTop || 0, scrollLeft: viewer.current?.scrollLeft || 0 };
  }
  function activateTab(tab: DocumentTab, focusSelectedTab = document.activeElement?.getAttribute('role') === 'tab') {
    pageInputDirty.current = false;
    if (tab.key !== tabStore.activeKey) setEditing(false);
    tabStore.activeKey = tab.key; setActiveTabKey(tab.key);
    docRef.current = tab.doc; annotationRef.current = tab.annotations; readingState.current = { page: tab.page, bookmarks: tab.bookmarks };
    undoStack.current = tab.undo; redoStack.current = tab.redo;
    restoreScroll.current = { key: tab.key, top: tab.scrollTop, left: tab.scrollLeft };
    setReaderChromeHidden(false); setDoc(tab.doc); setAnnotations(tab.annotations); setBookmarks(tab.bookmarks); setReturnLocation(null);
    applyView(tab, touchRef.current);
    setWorkBenchClosed(); setHistoryTick(v => v + 1); window.getSelection()?.removeAllRanges();
    if (focusSelectedTab) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.document-tab[data-tab-key="${CSS.escape(tab.key)}"] [role=tab]`)?.focus({ preventScroll: true }));
    if (tab.doc.outdated) void reopenWritten(tab.doc);
  }
  /** Shows a tab's view of its document: page, zoom, mode, tool, panels and search. On touch
   * layouts (`closeDrawers`) the drawers start closed, whatever the tab had open. */
  function applyView(view: TabView, closeDrawers: boolean) {
    setPage(view.page); setPageInput(String(view.page)); setDimensions(view.dimensions);
    setZoomMode(view.zoomMode); setCustomScale(view.customScale); setRotation(view.rotation); setReadingMode(view.readingMode);
    setTool(view.tool); setColor(view.color); setMobileAnnotating(view.annotating || view.tool === 'highlight' || view.tool === 'note');
    setSidebar(closeDrawers ? false : view.sidebar); setSideTab(view.sideTab); setNotesOpen(closeDrawers ? false : view.notesOpen); setOutline(view.outline);
    setTextIndex(view.textIndex); setIndexing(view.indexing); setSearchOpen(view.searchOpen); setQuery(view.query); setSearchQuery(searchTerm(view.query)); setResultIndex(view.resultIndex);
    setActiveNote(view.activeNote); setRedactions(view.redactions); setEditArea(view.editArea); setSessionFailed(view.sessionFailed); setDraftFailed(view.draftFailed); setBookmarkEditingId(null);
  }
  /** The last document closed: the reader empties and the library shows. */
  function showNoDocument() {
    pageInputDirty.current = false; setPageInput('1'); setPage(1);
    tabStore.activeKey = null; setActiveTabKey(null); docRef.current = null; annotationRef.current = []; undoStack.current = []; redoStack.current = [];
    setReaderChromeHidden(false); setDoc(null); setAnnotations([]); setBookmarks([]); setOutline(null); setTextIndex([]); setQuery(''); setSearchOpen(false); setNotesOpen(false); setSidebar(false);
    setTool('select'); setRedactions([]); setEditArea(null); setMobileAnnotating(false); setReturnLocation(null); setWorkBenchClosed(); setLibrary(true);
  }
  function setWorkBenchClosed() { setWorkbench(null); setInfo(false); setLibrary(false); setNoteDraft(null); setPageJump(false); setViewSettings(false); setAnnotationOptions(false); setCapabilityNotice(false); }
  const switchTab = (key: string) => tabStore.switchTo(key);
  const closeTab = (key: string, discard = false) => tabStore.close(key, discard);


  const openDocument = useMemo(() => opener.open.bind(opener), [opener]);
  /** Shows a document that just opened, in its new tab or in place of its earlier copy. */
  function presentTab(tab: DocumentTab, { replacing, quiet, resumeEditing, previous }: { replacing: boolean; quiet: boolean; resumeEditing: boolean; previous: DocumentTab | null }) {
    tabStore.activeKey = tab.key; setActiveTabKey(tab.key);
    pageInputDirty.current = false;
    if (quiet && viewer.current) restoreScroll.current = { key: tab.key, top: viewer.current.scrollTop, left: viewer.current.scrollLeft };
    if (!replacing) setEditing(false);
    docRef.current = tab.doc; annotationRef.current = tab.annotations; readingState.current = { page: tab.page, bookmarks: tab.bookmarks };
    undoStack.current = tab.undo; redoStack.current = tab.redo;
    setDoc(tab.doc); setReaderChromeHidden(false); setAnnotations(tab.annotations); setBookmarks(tab.bookmarks);
    applyView(tab, touchRef.current && !replacing); setHistoryTick(v => v + 1);
    const editor = resumeEditing && !phoneRef.current;
    if (editor) editorReadingLocation.current = { revision: String(tab.doc.revision), page: tab.page, top: previous?.scrollTop || 0, left: previous?.scrollLeft || 0 };
    setLibrary(false); setWorkbench(editor ? 'edit-pdf' : null); setNoteDraft(null); setPassword(null); setInfo(false);
  }

  useEffect(() => {
    if (!doc?.modified || isNativePdfDocument(doc.pdf) || forgottenIds.current.has(doc.id)) return;
    void persistence.draft(doc).then(() => { if (docRef.current?.id === doc.id && docRef.current?.revision === doc.revision) setDraftFailed(false); })
      .catch(error => {
        if (docRef.current?.id !== doc.id || docRef.current?.revision !== doc.revision) return;
        // Saving a PDF over the size limit would fail too, so its message replaces the advice.
        const message = errorMessage(error, '');
        setDraftFailed(true); notify(/supera 1 GB/.test(message) ? message : `No se pudieron guardar tus cambios en ${here}. ${saveAdvice}`, 'error');
      });
  }, [doc, notify]);

  // Each document starts Editar afresh; leaving it drops the selection and any pending image.
  useEffect(() => { editStore.reset(); }, [doc?.id, editStore]);
  // Editar on desktop keeps its document live (see LiveEdit).
  useEffect(() => { liveEdit.sync(editing, doc); }, [editing, doc, touchLayout, liveEdit]);
  useEffect(() => { if (!editing) editStore.set({ selection: null, draft: null, ghost: null, tool: 'select', image: null, notice: '', reselect: null }); }, [editing, editStore]);
  // A pasted screenshot or image lands in the middle of the view, on the page
  // shown there; with no page in view, the next click places it.
  useEffect(() => {
    if (!editing) return;
    const paste = (event: ClipboardEvent) => {
      if (editStore.state.draft || (event.target as HTMLElement | null)?.closest?.('dialog')) return;
      const file = [...(event.clipboardData?.files || [])].find(item => /^image\/(png|jpeg)$/.test(item.type));
      if (!file) return;
      event.preventDefault();
      void readImage(file).then(image => {
        const view = document.querySelector('.reading-area')?.getBoundingClientRect();
        const shown = (box: DOMRect) => view ? Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top)) : 0;
        const page = [...document.querySelectorAll('.edit-layer')].map(node => node.getBoundingClientRect()).sort((a, b) => shown(b) - shown(a))[0];
        if (!view || !page || !shown(page)) { editStore.set({ image: { ...image, name: 'la imagen pegada' }, tool: 'image', selection: null, notice: '' }); return; }
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
        window.dispatchEvent(new CustomEvent('folio:edit-place-image', { detail: { image, clientX: clamp(view.left + view.width / 2, page.left + 1, page.right - 1), clientY: clamp(view.top + view.height / 2, Math.max(page.top, view.top) + 1, Math.min(page.bottom, view.bottom) - 1) } }));
      }).catch(error => notify(errorMessage(error), 'error'));
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [editing, editStore, notify]);

  // Builds without Google's OAuth client cannot connect to Drive.
  useEffect(() => { if (isNative) void readDriveStatus().then(status => setDriveAvailable(status.available !== false)).catch(() => {}); }, []);
  useEffect(() => {
    preferencesRef.current = { rememberRecent, defaultZoom };
    try { localStorage.setItem('folio.remember', String(rememberRecent)); localStorage.setItem('folio.defaultZoom', defaultZoom); } catch { /* Settings are still usable for this session. */ }
  }, [rememberRecent, defaultZoom]);
  const systemChromeVisible = !readerChromeHidden || !doc || library || !!workbench || !!noteDraft || mobileActions || mobileTabs || pageJump || settings || help || info;
  const { theme, chooseTheme } = useTheme(library ? '--bg' : systemChromeVisible ? '--surface' : '--canvas');
  useEffect(() => {
    try { localStorage.setItem('folio.readingPreferences', JSON.stringify(readingPreferences)); } catch { /* Preferences remain active for this session. */ }
  }, [readingPreferences]);
  useEffect(() => { try { localStorage.setItem('folio.highlightColor', color); } catch { /* The selected color still works for this session. */ } }, [color]);
  useEffect(() => { if (!pageInputDirty.current) setPageInput(String(page)); }, [page]);
  // Reaching the remembered page again, by any means, retires «Volver a p. N».
  useEffect(() => { setReturnLocation(current => current?.page === page ? null : current); }, [page]);
  useEffect(() => {
    const selected = document.querySelector<HTMLElement>('.document-tab.selected'), strip = selected?.parentElement;
    if (!selected || !strip) return;
    const start = (tab: Element) => (tab as HTMLElement).offsetLeft - strip.offsetLeft, left = start(selected);
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    // Revealing to the right stops at a tab's start, so no half-hidden tab shows only its close button.
    else if (left + selected.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.min(left, [...strip.children].map(start).find(value => value >= left + selected.offsetWidth - strip.clientWidth) ?? left);
  }, [activeTabKey]);
  useEffect(() => {
    if (!doc || forgottenIds.current.has(doc.id) || unreadSessions.current.has(doc.id)) return;
    // While scrolling only the page changes: wait for reading to settle before
    // rewriting the session. Closing and backgrounding persist it immediately.
    const saved = sessionSaved.current, pageOnly = saved?.doc === doc && saved.annotations === annotations && saved.bookmarks === bookmarks;
    const timeout = setTimeout(() => {
      if (forgottenIds.current.has(doc.id) || unreadSessions.current.has(doc.id)) return;
      sessionSaved.current = { doc, annotations, bookmarks };
      void saveSession(doc.id, { annotations, bookmarks, lastPage: page, documentRevision: doc.revision, nativeKnownPages: doc.nativeKnownPages, nativeOriginalRefs: doc.nativeOriginalRefs, nativeSavedAnnotations: doc.savedAnnotations, nativeLegacySession: doc.nativeLegacySession }).then(success => { if (docRef.current?.id === doc.id && docRef.current?.revision === doc.revision) setSessionFailed(!success); });
    }, pageOnly ? 1500 : 200);
    return () => clearTimeout(timeout);
  }, [doc, annotations, bookmarks, page]);
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
      if (nothingOpened && isMobile) await libraryOpener.restoreOpenTabs(alive);
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
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    readOutline(doc.pdf).then(data => { if (alive) setOutline(data); }).catch(() => { if (alive) setOutline([]); });
    return () => { alive = false; };
  }, [doc]);
  useEffect(() => {
    if (!doc || !isNativePdfDocument(doc.pdf)) return;
    return subscribeNativePdfAnnotations(doc.pdf, (number, originals) => {
      if (docRef.current?.pdf !== doc.pdf) return;
      const baseline = JSON.parse(doc.savedAnnotations) as unknown[][];
      const additions = JSON.parse(annotationFingerprint(originals)) as unknown[][];
      doc.savedAnnotations = JSON.stringify([...baseline, ...additions.filter(item => !baseline.some(current => current[0] === item[0]))]);
      if (doc.nativeKnownPages?.includes(number)) return;
      let nextAnnotations: Annotation[];
      try { nextAnnotations = doc.nativeLegacySession ? migrateLegacyNativePage(annotationRef.current, number, originals) : [...annotationRef.current, ...originals.filter(item => !annotationRef.current.some(current => current.id === item.id))]; }
      catch (error) { notify(errorMessage(error, 'No se pudieron recuperar las anotaciones anteriores.'), 'error'); return; }
      doc.nativeKnownPages = [...doc.nativeKnownPages || [], number];
      doc.nativeOriginalRefs = [...new Set([...doc.nativeOriginalRefs || [], ...originals.flatMap(item => item.nativeSourceRef ? [item.nativeSourceRef] : [])])];
      annotationRef.current = nextAnnotations;
      if (doc.nativeKnownPages.length === doc.pdf.numPages) doc.nativeLegacySession = false;
      setAnnotations([...annotationRef.current]);
    });
  }, [doc]);
  useEffect(() => {
    let alive = true;
    if (library || mobileTabs) { setLibraryLoading(true); Promise.allSettled([librarySave.current, persistence.draftsWritten]).then(() => listLibrary()).then(items => { if (alive) setRecents(items); }).catch(() => { if (alive) { setRecents([]); notify('No se pudo abrir la biblioteca local.', 'error'); } }).finally(() => { if (alive) setLibraryLoading(false); }); }
    return () => { alive = false; };
  }, [library, mobileTabs, notify]);
  useEffect(() => {
    let alive = true; setPageLabels(null); setReturnLocation(null);
    if (doc) void readPageLabels(doc.pdf).then(labels => { if (alive) setPageLabels(labels); }).catch(() => {});
    return () => { alive = false; };
  }, [doc?.pdf]);
  useEffect(() => {
    let alive = true; setCurrentPageLabel(pageLabels?.[page - 1] || String(page));
    if (doc && !pageLabels) void readPageLabel(doc.pdf, page).then(label => { if (alive) setCurrentPageLabel(label); }).catch(() => {});
    return () => { alive = false; };
  }, [doc?.pdf, page, pageLabels]);
  useEffect(() => {
    if (searchOpen) { setSidebar(true); setTimeout(() => searchInput.current?.focus(), 50); }
  }, [searchOpen]);
  useEffect(() => {
    const root = viewer.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      // The reader remains mounted while editing; hiding it must not change its fit zoom.
      // Neither does hiding the reader chrome or Android's system bars with a tap.
      if (root.clientWidth > 0 && root.clientHeight > 0) setViewportSize(previous => chromeHiddenRef.current && previous.width === root.clientWidth ? previous : { width: root.clientWidth, height: root.clientHeight });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [doc]);
  const chromeUpdate = useRef(Promise.resolve());
  // The selection previewing a highlight takes the chosen colour.
  useEffect(() => { document.documentElement.style.setProperty('--highlight-preview', color); }, [color]);
  // The screen stays on while a document is being read, never in the library.
  const reading = !!doc && !library && readingPreferences.keepAwake;
  useEffect(() => { void setKeepAwake(reading); }, [reading]);
  useEffect(() => () => { void setKeepAwake(false); }, []);
  // The palette's commands, built when it opens.
  const commands = () => paletteCommands({ doc, idle: !busy && !loading, pageName, saveLabel, bookmarked: hasBookmarkPage(bookmarks, page),
    canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0, returnPage: returnLocation?.key === activeTabKey && returnLocation.page !== page ? returnLocation.page : null,
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
  const outlineSection = useCallback((target: number) => {
    let best: { title: string; page: number } | undefined;
    for (const entry of outline || []) if (entry.page !== null && entry.page <= target && (!best || entry.page >= best.page)) best = { title: entry.title, page: entry.page };
    return best?.title;
  }, [outline]);
  // The library shows page one as each document's cover; it is rendered once, when idle.
  useEffect(() => {
    if (!doc || doc.sample) return;
    if (doc.drive) markDrive(doc.id);
    let alive = true;
    const pdf = doc.pdf, id = doc.id, idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 600));
    void readCover(id).then(cover => { if (!cover && alive) idle(() => { if (alive) void renderCover(pdf).then(image => { if (image) void saveCover(id, image); }); }); });
    return () => { alive = false; };
  }, [doc?.id]);
  useEffect(() => {
    if (!isNative || !isMobile) return;
    chromeUpdate.current = chromeUpdate.current.catch(() => {}).then(() => setReaderChrome(systemChromeVisible)).then(() => { window.dispatchEvent(new Event('folio:system-bars-changed')); }).catch(() => {});
  }, [systemChromeVisible]);
  useReaderTaps(viewer, touchLayout && !!doc, tool === 'select' && !busy && !loading && !mobileAnnotating && !searchOpen && !library && !sidebar && !notesOpen && !mobileTabs,
    { doubleTap: toggleTapZoom, toggleChrome: () => setReaderChromeHidden(value => !value), showChrome: () => setReaderChromeHidden(false) });
  const scrollReaderBy = usePageTracking({ viewer, doc, readingMode, page, enabled: phone || workbench !== 'edit-pdf', paused: () => editorRestorePending.current, onPage: setPage,
    onCenter: (number, x, y, width) => {
      // A resize not yet applied to the zoom would anchor the wrong point.
      if (docRef.current && width === fittedWidth.current) readingAnchor.current = { id: docRef.current.id, page: number, x, y, rotation: activeView.current.rotation };
    } });


  useEffect(() => {
    if (!touchLayout || !(sidebar || notesOpen)) return;
    const drawer = document.querySelector<HTMLElement>('.mobile-drawer'); if (!drawer) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!bookmarkEditingId) drawer.querySelector<HTMLButtonElement>('button:not([tabindex="-1"])')?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open], .bookmark-menu')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSidebar(false); setSearchOpen(false); setNotesOpen(false); }
      if (event.key !== 'Tab') return;
      const focusable = [...drawer.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('keydown', keyboard, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [touchLayout, sidebar, notesOpen, bookmarkEditingId]);
  useEffect(() => { if (submitPending.current) { submitPending.current = false; goToResult(0); } }, [results]);
  const pages = useMemo(() => Array.from({ length: doc?.pdf.numPages || 0 }, (_, i) => i + 1), [doc]);
  const annotationPages = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    annotations.forEach(a => { const list = map.get(a.page) || []; list.push(a); map.set(a.page, list); });
    return map;
  }, [annotations]);

  // The phone header overlays the reader and the notch; pages are placed below it.
  function readingInset() {
    const header = phoneRef.current ? document.querySelector('.app-header') : null;
    return header && viewer.current ? header.getBoundingClientRect().bottom - viewer.current.getBoundingClientRect().top + 12 : 16;
  }
  const goToPage = useCallback((number: number, smooth = true, preserveScrollRestore = false) => {
    const pdf = docRef.current?.pdf;
    if (!pdf || !viewer.current) return;
    if (!preserveScrollRestore && scrollRestoreFrame.current !== null) { cancelAnimationFrame(scrollRestoreFrame.current); scrollRestoreFrame.current = null; }
    pageInputDirty.current = false;
    const next = Math.max(1, Math.min(pdf.numPages, number));
    setPage(next); setPageInput(String(next));
    const root = viewer.current, node = root.querySelector<HTMLElement>(`[data-page-number="${next}"]`);
    const distance = node ? node.getBoundingClientRect().top - root.getBoundingClientRect().top - readingInset() : null;
    // While a smooth jump passes other pages, the counter keeps the target and «Volver a p. N» stays.
    scrollReaderBy(root, distance, smooth && distance !== null && readingPreferencesRef.current.smoothScroll && Math.abs(distance) < root.clientHeight * 4 && !matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, [scrollReaderBy]);

  function commitPageInput() {
    pageInputDirty.current = false;
    const next = Number(pageInput);
    if (Number.isInteger(next) && next > 0) goToPage(next);
    else setPageInput(String(page));
  }

  useLayoutEffect(() => {
    if (readingMode === 'single' && viewer.current) viewer.current.scrollTop = 0;
  }, [page, readingMode]);
  useEffect(() => {
    if (docRef.current) goToPage(readingState.current.page, false, true);
  }, [readingMode, goToPage]);

  useSwipePages(viewer, touchLayout && !!doc && readingMode === 'single' && tool === 'select' && !mobileAnnotating && !library && !sidebar && !notesOpen && !busy && !loading,
    step => goToPage(readingState.current.page + step, false));

  // A document the reader opens is shown where it was left; new bytes for the same
  // reader copy (Editar writing its changes) leave the view where it is.
  const scrolledPdf = useRef<PDFDocumentProxy | null>(null);
  useEffect(() => {
    if (!doc || scrolledPdf.current === doc.pdf) return;
    scrolledPdf.current = doc.pdf;
    const restored = restoreScroll.current;
    restoreScroll.current = null;
    const frame = requestAnimationFrame(() => {
      scrollRestoreFrame.current = null;
      if (restored?.key === tabStore.activeKey && viewer.current) viewer.current.scrollTo({ top: restored.top, left: restored.left, behavior: 'instant' });
      else goToPage(doc.initialPage, false);
    });
    scrollRestoreFrame.current = frame;
    return () => { cancelAnimationFrame(frame); if (scrollRestoreFrame.current === frame) scrollRestoreFrame.current = null; };
  }, [doc, goToPage]);

  // Undo keeps less on a phone (see trimHistory).
  const historyBudget = () => (phoneRef.current ? 40 : 200) * 1024 * 1024;
  const trimHistory = (stack: History[]) => trimSteps(stack, historyBudget());
  const annotationGesture = useRef<string | undefined>(undefined);
  /** Records an undo step (one per gesture: a drag records once) and forgets what was undone.
   * False when the step is too large to keep. */
  function recordStep(step: History, gesture?: string) {
    if (!gesture || annotationGesture.current !== gesture) undoStack.current.push(step);
    annotationGesture.current = gesture;
    trimHistory(undoStack.current); redoStack.current = []; setHistoryTick(v => v + 1);
    return !!gesture || undoStack.current.at(-1) === step;
  }
  const commitAnnotations = useCallback((next: Annotation[], gesture?: string) => {
    recordStep({ annotations: annotationRef.current }, gesture);
    if (docRef.current) unreadSessions.current.delete(docRef.current.id);
    annotationRef.current = next; setAnnotations(next);
  }, []);
  const commitBookmarks = useCallback((next: BookmarkNode[], gesture?: string) => {
    if (JSON.stringify(next) === JSON.stringify(readingState.current.bookmarks)) return;
    recordStep({ annotations: annotationRef.current, bookmarks: readingState.current.bookmarks }, gesture);
    if (docRef.current) unreadSessions.current.delete(docRef.current.id);
    readingState.current.bookmarks = next; setBookmarks(next);
  }, []);
  /** Undoes or redoes one step: of Editar's live document, a change of the PDF (reopened from its
   * snapshot), or of annotations and bookmarks. The step it replaces goes to the other stack. */
  function stepHistory(direction: 'undo' | 'redo') {
    if (editorDraftRef.current || busyRef.current || loadingRef.current || editStore.state.committing || liveEdit.settling) return;
    const [from, to] = direction === 'undo' ? [undoStack.current, redoStack.current] : [redoStack.current, undoStack.current];
    const step = from.pop();
    if (!step) return;
    annotationGesture.current = undefined;
    if (step.session) { to.push(step); liveEdit.step(direction); return; }
    // The PDF before Editar replaces the live document's: what it holds now is written first, to redo.
    if (direction === 'undo' && step.bytes && editStore.session) { void liveEdit.write().catch(() => {}).then(() => { to.push(snapshot()); trimHistory(to); return restoreHistory(step, from, to); }); return; }
    to.push(step.bytes ? snapshot() : { annotations: annotationRef.current, bookmarks: readingState.current.bookmarks });
    trimHistory(to);
    if (step.bytes) { void restoreHistory(step, from, to); return; }
    annotationRef.current = step.annotations;
    if (step.bookmarks) { readingState.current.bookmarks = step.bookmarks; setBookmarks(step.bookmarks); }
    setAnnotations(step.annotations); setHistoryTick(v => v + 1);
  }
  const undo = useCallback(() => stepHistory('undo'), [openDocument]);
  const redo = useCallback(() => stepHistory('redo'), [openDocument]);
  const toggleBookmark = useCallback(() => {
    if (!docRef.current || busyRef.current || loadingRef.current) return;
    haptic('light');
    const current = readingState.current.bookmarks;
    // On touch the filled bookmark toggles; Deshacer restores a removed one.
    if (touchRef.current && hasBookmarkPage(current, page)) { commitBookmarks(current.filter(node => node.page === page).reduce((nodes, node) => deleteBookmark(nodes, node.id), current)); notify('Marcador eliminado.', 'success'); return; }
    const next = addPageBookmark(current, page);
    commitBookmarks(next.bookmarks);
    if (touchRef.current) notify('Marcador guardado.', 'success');
    else { setSidebar(true); setSearchOpen(false); setSideTab('bookmarks'); setBookmarkEditingId(next.id); }
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
      case 'search-step': goToResult(visitedSearch.current === `${tabStore.activeKey}\0${searchQuery}` ? resultIndex + shortcut.step : resultIndex); break;
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
  const reopenRecent = (recent: RecentDocument) => libraryOpener.reopen(recent);
  function onAnnotate(annotation: AnnotationDraft | AnnotationDraft[]) {
    if (!doc?.canAnnotate || busyRef.current || loadingRef.current) return;
    if (Array.isArray(annotation)) {
      // A selection spanning several pages is one action in the document history.
      // Highlights over a highlight of the same color join it.
      commitAnnotations(addHighlights(annotationRef.current, annotation.map(item => ({ ...item, id: uid(), created: Date.now() }))));
      if (annotation.some(item => item.kind === 'highlight')) haptic('light');
      return;
    }
    if (annotation.kind === 'note') { noteOrigin.current = 'document'; setNoteDraft(annotation); setNoteText(''); return; }
    commitAnnotations(addHighlights(annotationRef.current, [{ ...annotation, id: uid(), created: Date.now() }]));
    if (annotation.kind === 'highlight') haptic('light');
  }
  const removeAnnotation = useCallback((id: string, gesture?: string) => {
    if (!docRef.current?.canAnnotate || busyRef.current || loadingRef.current || !annotationRef.current.some(annotation => annotation.id === id)) return;
    commitAnnotations(annotationRef.current.filter(annotation => annotation.id !== id), gesture);
    setActiveNote(current => current === id ? null : current);
  }, [commitAnnotations]);
  function snapshot(): History {
    const current = docRef.current!;
    return { bytes: current.bytes, password: current.password, annotations: annotationRef.current,
      page: readingState.current.page, bookmarks: readingState.current.bookmarks };
  }
  async function restoreHistory(value: History, from: History[], to: History[]) {
    const current = docRef.current; if (!current || !value.bytes) return;
    const keepEditing = workbenchRef.current === 'edit-pdf', quiet = editingRef.current;
    setBusy('edit');
    try {
      if (!await openDocument(value.bytes, current.name, current.sample, current.nativeSource, { id: current.id, draftSource: current.draftSource, password: value.password,
        modified: true, useSession: false, preserveHistory: true, page: quiet ? readingState.current.page : value.page, bookmarks: value.bookmarks, quiet })) {
        // The current revision stays open, so the step remains available.
        to.pop(); from.push(value); notify(from === redoStack.current ? 'No se pudo rehacer el cambio.' : 'No se pudo deshacer el cambio.', 'error'); return;
      }
      annotationRef.current = value.annotations; setAnnotations(value.annotations);
      if (keepEditing) setWorkbench('edit-pdf');
    } finally { setBusy(null); setHistoryTick(v => v + 1); }
  }
  /** The reader opens the PDF Editar wrote, keeping the annotations and the view. */
  async function reopenWritten(current: LoadedDocument) {
    const annotations = annotationRef.current; setBusy('edit');
    try {
      if (await openDocument(current.bytes, current.name, current.sample, current.nativeSource, { id: current.id, draftSource: current.draftSource, password: current.password, modified: true,
        useSession: false, preserveHistory: true, page: readingState.current.page, bookmarks: readingState.current.bookmarks, quiet: true })) { annotationRef.current = annotations; setAnnotations(annotations); }
    } finally { setBusy(null); }
  }
  async function applyOperation(operation: Operation, signal?: AbortSignal, context?: { keepEditing?: boolean; page?: number; quiet?: boolean }) {
    const current = docRef.current; if (!current) return;
    if (isNativePdfDocument(current.pdf)) throw new Error('Esta herramienta no está disponible para PDF tan grandes.');
    const before = snapshot(); setBusy('edit');
    try {
      // The bytes already hold the annotations they were opened with; only changes need writing.
      const unchanged = annotationFingerprint(annotationRef.current) === current.bytesAnnotations;
      const source = unchanged ? current.bytes : await annotatedBytes(current);
      signal?.throwIfAborted();
      const output = await processPdf(source, operation, current.password, signal);
      signal?.throwIfAborted();
      // An optimized PDF is left as it is: no reload, no undo step.
      if (operation.operation === 'compress' && output.length >= source.length) { notify('El PDF ya está optimizado; no se redujo su tamaño.'); setWorkbench(null); return; }
      const bookmarkPages = operation.operation === 'pages' ? remapBookmarks(before.bookmarks || [], operation.plan) : before.bookmarks;
      const password = operation.operation === 'protect' ? operation.ownerPassword : operation.operation === 'unprotect' ? '' : current.password;
      const opened = await openDocument(output, current.name, current.sample, current.nativeSource, { id: current.id, draftSource: current.draftSource, password, modified: true,
        useSession: false, preserveHistory: true, page: context?.quiet ? readingState.current.page : context?.keepEditing ? context.page : before.page, bookmarks: bookmarkPages, quiet: context?.quiet });
      if (!opened) throw new Error('No se pudo cargar el resultado de la operación.');
      if (!recordStep(before)) notify('Este cambio no se podrá deshacer porque el documento es demasiado grande.');
      if (!context?.quiet) { setWorkbench(context?.keepEditing ? 'edit-pdf' : null); setTool('select'); }
      if (operation.operation === 'compress') notify(`PDF reducido de ${formatSize(source.length)} a ${formatSize(output.length)}.`, 'success');
    } finally { setBusy(null); }
  }
  const annotatedBytes = (current: LoadedDocument, items?: Annotation[], incremental?: boolean) => output.annotated(current, items, incremental);
  const download = (options?: { keepEditing?: boolean; copy?: boolean }) => output.save(options);
  const printDocument = (anchor?: Anchor) => output.print(anchor);
  const shareDocument = (anchor?: Anchor) => output.share(anchor);
  async function replaceDocument(bytes: Uint8Array, context?: { extraction?: { name: string; plan: PageEntry[] } }) {
    const current = docRef.current; if (!current) return;
    setBusy('edit');
    try {
      const before = snapshot();
      if (context?.extraction) {
        const { name, plan } = context.extraction;
        // A derived PDF owns its session and draft. Loading it retains the source
        // tab, including its annotation history, bookmarks and reading view.
        const opened = await openDocument(bytes, name, false, undefined, { id: uid(), modified: true, draftSource: true,
          useSession: false, page: 1, bookmarks: remapBookmarks(before.bookmarks || [], plan) });
        if (!opened) throw new Error('No se pudo abrir el PDF con las páginas extraídas.');
        setWorkbench(null); notify('Páginas extraídas en una pestaña nueva.', 'success');
        return;
      }
      const opened = await openDocument(bytes, current.name, current.sample, current.nativeSource, { id: current.id, draftSource: current.draftSource, modified: true,
        useSession: false, preserveHistory: true, page: readingState.current.page, bookmarks: readingState.current.bookmarks });
      if (!opened) throw new Error('No se pudo abrir el resultado.');
      setWorkbench(null);
      if (!recordStep(before)) notify('Este cambio no se podrá deshacer porque el documento es demasiado grande.');
    } finally { setBusy(null); }
  }
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
    const next = { ...noteDraft, id: noteDraft.id || uid(), text: noteText.trim(), created: Date.now() } as Annotation;
    commitAnnotations(noteDraft.id ? annotationRef.current.map(a => a.id === next.id ? next : a) : [...annotationRef.current, next]);
    setNoteDraft(null); setActiveNote(next.id);
    if (noteOrigin.current === 'list') setNotesOpen(true);
    if (!mobileAnnotating) setTool('select');
  }
  // Mobile keeps private copies of opened PDFs; those of forgotten entries are deleted.
  const pruneCopies = () => { void prunePrivateCopies(tabStore.list.flatMap(tab => tab.doc.nativeSource ? [tab.doc.nativeSource] : [])).catch(() => {}); };
  // A leftover entry is harmless, so a failure here never reports the save as failed.
  async function retireLibraryEntry(id: string) {
    forgottenIds.current.add(id);
    await librarySave.current.catch(() => {}); await forgetDocument(id).catch(() => {}); pruneCopies();
  }
  function goToResult(index: number) {
    if (!results.length) return;
    const next = (index + results.length) % results.length;
    const searchKey = `${tabStore.activeKey}\0${searchQuery}`;
    if (!returnLocation) rememberLocation(); visitedSearch.current = searchKey;
    setSearchHistory(current => rememberSearch(searchQuery, current));
    setResultIndex(next); goToPage(results[next].page, false);
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('folio:reveal-search-result', { detail: { page: results[next].page, offset: results[next].offset } })));
    if (touchRef.current) { searchInput.current?.blur(); setSidebar(false); setNotesOpen(false); setReaderChromeHidden(false); }
  }
  function submitSearch(step: number) {
    // Enter before the typing pause searches at once and then shows the first result.
    const term = searchTerm(query);
    if (term !== searchQuery) { if (term) { submitPending.current = true; searchNow(term); } return; }
    goToResult(visitedSearch.current === `${tabStore.activeKey}\0${searchQuery}` ? resultIndex + step : resultIndex);
  }
  // A desktop panel closed from inside returns keyboard focus to its rail button.
  function focusRail(label: string) { requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.tool-rail [aria-label="${label}"]`)?.focus({ preventScroll: true })); }
  function closeSearch() {
    // Restore the panel that was open before searching; keyboard focus returns to Buscar.
    const returnFocus = !touchRef.current && !!document.activeElement?.closest('.sidebar');
    visitedSearch.current = null; setSearchOpen(false); setQuery(''); setSidebar(!touchRef.current && sidebarBeforeSearch.current);
    if (returnFocus) focusRail('Buscar en el PDF');
  }
  // iPad anchors Share and Print to the control that opened them.
  const anchorOf = (element: Element | null): Anchor | undefined => { const box = element?.getBoundingClientRect(); return box && { left: box.left, top: box.top, width: box.width, height: box.height }; };
  function showDrive() { setDriveLibrary(true); setLibrary(true); }
  function closeActiveTab() { if (tabStore.activeKey) void closeTab(tabStore.activeKey); }
  function closeMobilePanel() { setSidebar(false); setSearchOpen(false); setQuery(''); setNotesOpen(false); if (phoneRef.current) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="Páginas"]')?.focus({ preventScroll: true })); }
  function rememberLocation() {
    if (tabStore.activeKey && viewer.current) setReturnLocation({ key: tabStore.activeKey, page: readingState.current.page, top: viewer.current.scrollTop, left: viewer.current.scrollLeft });
  }
  function returnToLocation() {
    if (!returnLocation || returnLocation.key !== tabStore.activeKey) return;
    if (searchOpen) closeSearch();
    goToPage(returnLocation.page, false); const location = returnLocation; setReturnLocation(null);
    requestAnimationFrame(() => viewer.current?.scrollTo({ top: location.top, left: location.left, behavior: 'instant' }));
  }
  function mobilePage(number: number) { rememberLocation(); goToPage(number); if (touchRef.current) closeMobilePanel(); }
  function navigatePDF(destination: PDFNavigationTarget) {
    if ('url' in destination) { void openExternalUrl(destination.url).catch(() => notify('No se pudo abrir el enlace.', 'error')); return; }
    rememberLocation(); goToPage(destination.page, false);
    if (destination.top !== undefined && doc) void doc.pdf.getPage(destination.page).then(pdfPage => {
      requestAnimationFrame(() => {
        const node = viewer.current?.querySelector<HTMLElement>(`[data-page-number="${destination.page}"] .page-content`);
        if (!node || !viewer.current) return;
        const point = pdfPage.getViewport({ scale: currentScale.current, rotation: (pdfPage.rotate + rotation) % 360 }).convertToViewportPoint(destination.left || 0, destination.top!);
        const box = node.getBoundingClientRect(), bounds = viewer.current.getBoundingClientRect();
        viewer.current.scrollTo({ top: viewer.current.scrollTop + box.top - bounds.top + point[1] - readingInset() - 8, behavior: 'instant' });
      });
    }).catch(() => {});
  }
  function openExplorer(tab: SideTab = 'pages') { setReaderChromeHidden(false); setSearchOpen(false); setQuery(''); setNotesOpen(false); setSideTab(tab); setSidebar(true); }
  function openSearch() {
    const view = activeView.current;
    if (!view.searchOpen) { visitedSearch.current = null; sidebarBeforeSearch.current = view.sidebar; }
    setReaderChromeHidden(false); setMobileAnnotating(false); setTool('select'); setNotesOpen(false); setSearchOpen(true); setSidebar(true);
    if (view.searchOpen) { searchInput.current?.focus(); searchInput.current?.select(); }
  }
  function startAnnotating() {
    if (!doc?.canAnnotate) { setCapabilityNotice(true); return; }
    setEditing(false);
    if (touchRef.current) closeMobilePanel(); setReaderChromeHidden(false); setMobileAnnotating(true); setTool('select');
  }
  function editNote(annotation: Annotation, origin: 'document' | 'list') { noteOrigin.current = origin; setNoteDraft(annotation); setNoteText(annotation.text); }
  const updateAnnotation = useCallback((id: string, patch: Partial<Pick<Annotation, 'color' | 'text' | 'rect'>>) => {
    if (!docRef.current?.canAnnotate || busyRef.current || loadingRef.current) return;
    commitAnnotations(annotationRef.current.map(item => item.id === id ? { ...item, ...patch } : item));
  }, [commitAnnotations]);
  // The comment's marker sits in the right margin, level with the top of the
  // highlight, so it does not cover the highlighted words; its 20 pt PDF icon stays on the page.
  async function commentHighlight(annotation: Annotation) {
    const view = (await docRef.current?.pdf.getPage(annotation.page).catch(() => null))?.view, x = view ? view[2] - 24 : annotation.rect[2], y = Math.max(annotation.rect[1], annotation.rect[3]);
    noteOrigin.current = 'document'; setNoteDraft({ page: annotation.page, kind: 'note', rect: [x, y, x, y], text: '', color: annotation.color }); setNoteText('');
  }
  function openTools() { if (!doc || isNativePdfDocument(doc.pdf)) { setCapabilityNotice(true); return; } setMobileAnnotating(false); setTool('select'); setWorkbench('home'); }
  function openEditor() {
    if (!doc || isNativePdfDocument(doc.pdf) || busyRef.current) return;
    if (!touchLayout) { setMobileAnnotating(false); setTool('select'); setWorkbench(null); setReaderChromeHidden(false); setEditing(true); return; }
    editorReadingLocation.current = { revision: String(doc.revision), page, top: viewer.current?.scrollTop || 0, left: viewer.current?.scrollLeft || 0 };
    setSidebar(false); setSearchOpen(false); setNotesOpen(false); setMobileAnnotating(false); setReaderChromeHidden(false); setTool('select'); setWorkbench('edit-pdf');
  }
  async function closeWorkbench() {
    const wasEditing = workbenchRef.current === 'edit-pdf' && !phoneRef.current, location = editorReadingLocation.current;
    const desiredPage = readingState.current.page, revision = docRef.current?.revision, key = tabStore.activeKey;
    const request = ++editorRestoreRequest.current;
    if (wasEditing) editorRestorePending.current = true;
    setWorkbench(null); setEditArea(null); if (tool !== 'redact') setTool('select');
    if (!wasEditing) return;
    if (scrollRestoreFrame.current !== null) { cancelAnimationFrame(scrollRestoreFrame.current); scrollRestoreFrame.current = null; }
    // Let the reader and its fit zoom recover before positioning the selected page.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (request === editorRestoreRequest.current && key === tabStore.activeKey && revision === docRef.current?.revision) {
      if (location && String(revision) === location.revision && desiredPage === location.page) {
        setPage(desiredPage); setPageInput(String(desiredPage)); viewer.current?.scrollTo({ top: location.top, left: location.left, behavior: 'instant' });
      } else goToPage(desiredPage, false);
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (request === editorRestoreRequest.current) editorRestorePending.current = false;
  }
  async function selectWorkbenchTool(next: Tool) {
    if (editorDraftRef.current) return;
    if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) await closeWorkbench();
    else setWorkbench(null);
    setTool(next);
  }
  async function openWorkbenchSection(next: string) {
    if (editorDraftRef.current) return;
    if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) await closeWorkbench();
    setWorkbench(next);
  }
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
  function toggleSidePanel(tab: SideTab) {
    if (phoneRef.current || window.innerWidth < 1000) setNotesOpen(false);
    setSidebar(!(sidebar && !searchOpen && sideTab === tab));
    setSearchOpen(false); setSideTab(tab);
  }
  async function clearLibrary() {
    if (!confirmClear) { setConfirmClear(true); return; }
    const pendingIds = tabStore.list.map(tab => tab.doc.id).filter(id => !forgottenIds.current.has(id));
    for (const id of pendingIds) forgottenIds.current.add(id);
    try {
      await Promise.allSettled([persistence.draftsWritten, librarySave.current]);
      await clearSavedState();
      discardOpenTabs(new Set(tabStore.list.map(tab => tab.doc.id))); pruneCopies();
      setRecents([]); setConfirmClear(false);
      notify('Biblioteca y anotaciones locales eliminadas.', 'success');
    } catch { for (const id of pendingIds) forgottenIds.current.delete(id); notify('No se pudo eliminar la biblioteca local.', 'error'); }
  }
  async function forgetRecent(recent: RecentDocument) {
    forgottenIds.current.add(recent.id);
    try {
      await Promise.allSettled([persistence.draftsWritten, librarySave.current]); await forgetDocument(recent.id);
      discardOpenTabs(new Set([recent.id])); pruneCopies();
      tabStore.publish(); setRecents(await listLibrary()); setDeleteTarget(null); notify(isDesktop ? 'Documento quitado de la biblioteca. El archivo original no se modificó.' : 'Copia y cambios eliminados. El archivo original no se modificó.', 'success');
    } catch { forgottenIds.current.delete(recent.id); notify(isDesktop ? 'No se pudo quitar el documento de la biblioteca.' : 'No se pudo eliminar el documento de la biblioteca.', 'error'); }
  }
  // The phone shows the library when the document in front was removed from it.
  function discardOpenTabs(ids: Set<string>) { if (tabStore.discard(ids) && tabStore.list.length && phoneRef.current) setLibrary(true); }
  const explorerIds = ['pages', 'outline', 'bookmarks', 'annotations'] as const;
  function showExplorerTab(id: typeof explorerIds[number], focus = false) {
    // Annotations and the other tabs are separate drawers in the same place:
    // switching between them swaps the content instead of closing and reopening.
    if (id === 'annotations' ? sidebar : notesOpen) setDrawerSwap(true);
    setSearchOpen(false); setQuery(''); setNotesOpen(id === 'annotations'); setSidebar(id !== 'annotations'); if (id !== 'annotations') setSideTab(id);
    // Annotations live in their own drawer, so the tab is focused once it renders.
    if (focus) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.mobile-panel-tabs [data-explorer-tab="${id}"]`)?.focus({ preventScroll: true }));
  }
  const explorerTabs = <div className="mobile-panel-tabs" role="tablist" aria-label="Explorar PDF">{explorerIds.map((id, index) => {
    const Symbol = id === 'pages' ? Layers : id === 'outline' ? ListTree : id === 'bookmarks' ? Bookmark : MessageSquare;
    const label = id === 'pages' ? 'Páginas' : id === 'outline' ? 'Índice' : id === 'bookmarks' ? 'Marcadores' : 'Anotaciones';
    // A drawer sliding away keeps showing the tab it was on.
    const selected = id === 'annotations' ? notesShown : sidebarShown && !searchOpen && sideTab === id;
    return <button key={id} role="tab" data-explorer-tab={id} aria-selected={selected} aria-controls={selected ? 'explorer-panel' : undefined} tabIndex={selected ? 0 : -1} onClick={() => showExplorerTab(id)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); showExplorerTab(explorerIds[event.key === 'Home' ? 0 : event.key === 'End' ? explorerIds.length - 1 : (index + (event.key === 'ArrowLeft' ? explorerIds.length - 1 : 1)) % explorerIds.length], true);
    }}><Symbol size={19} /><span>{label}</span></button>;
  })}</div>;
  const libraryContent = <DocumentLibrary onDrive={driveAvailable ? () => setDriveLibrary(true) : undefined} documents={recents} loading={libraryLoading} activeDocument={doc && !doc.sample ? { id: doc.id, name: doc.name, page, pages: doc.pdf.numPages } : undefined} busy={!!busy || loading} onContinue={doc ? () => setLibrary(false) : undefined} onOpen={recent => void reopenRecent(recent)} onImport={() => requestAnimationFrame(() => void chooseFile())} onCreate={() => setCreating(true)} onDelete={setDeleteTarget} onSettings={() => { setConfirmClear(false); setSettings(true); }} onHelp={() => setHelp(true)} onDemo={() => void openDocument('sample')} />;

  const inlineEditing = !phone && workbench === 'edit-pdf';
  const workbenchPanel = workbench && doc && !isNativePdfDocument(doc.pdf) ? <Workbench key={`${doc.revision}-${workbench}`} doc={doc} page={page} section={workbench} inline={inlineEditing} documentBusy={!!busy} area={editArea} onAreaChange={setEditArea} redactions={redactions} onClose={closeWorkbench} onSelectTool={next => { void selectWorkbenchTool(next); }} onOpenEditor={openEditor} onOpenSection={next => { void openWorkbenchSection(next); }} onDraftChange={setEditorDraft} onEditPageChange={next => { readingState.current.page = next; setPage(next); setPageInput(String(next)); }} onApply={applyOperation} getBytes={() => output.currentBytes()} onNotify={message => notify(message, 'success')} onSave={() => { void download({ keepEditing: true }); }} canSave={!busy && !loading && !editorDraft} onHistory={direction => { if (!busy) { if (direction === 'undo') undo(); else redo(); } }} canUndo={!!undoStack.current.length} canRedo={!!redoStack.current.length} onReplace={replaceDocument} /> : null;

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
  opener.host = { tabs: tabStore, persistence, draft: () => editorDraftRef.current, notify, askPassword: setPassword, current: () => docRef.current,
    leaveEditor: async () => { if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) await closeWorkbench(); },
    setLoading: (loading, cover) => { loadingRef.current = loading; if (cover || !loading) setLoading(loading); },
    view: () => activeView.current, history: () => ({ undo: undoStack.current, redo: redoStack.current }), capture: captureTab, show: activateTab, present: presentTab,
    preferences: () => ({ restorePage: readingPreferencesRef.current.restorePage, mode: readingPreferencesRef.current.mode, defaultZoom: preferencesRef.current.defaultZoom,
      panel: readingPreferencesRef.current.initialPanel, rememberRecent: preferencesRef.current.rememberRecent }),
    forgotten: forgottenIds.current, unread: unreadSessions.current,
    remember: store => { librarySave.current = librarySave.current.catch(() => {}).then(store).catch(() => notify('No se pudo guardar este PDF en la biblioteca.', 'error')); } };
  tabStore.host = { capture: captureTab, show: activateTab, empty: showNoDocument, publish: setTabs, persistence, notify,
    draft: () => editorDraftRef.current, occupied: () => !!busyRef.current || loadingRef.current || !!document.querySelector('dialog[open]'),
    leaveEditor: async live => {
      if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) await closeWorkbench();
      if (live && editStore.session) { setEditing(false); editingRef.current = false; await liveEdit.close(); }
    },
    setClosing: closing => { busyRef.current = closing ? 'close' : null; setBusy(closing ? 'close' : null); }, closeBlocked: setCloseBlocked, storeFailed: () => setSessionFailed(true),
    // The library lists documents by last use. Drafts and pending native edits keep their own entries.
    used: used => {
      if (preferencesRef.current.rememberRecent && !used.sample && !used.draftSource && !(used.modified && used.nativeSource) && !forgottenIds.current.has(used.id))
        librarySave.current = librarySave.current.catch(() => {}).then(() => touchDocument({ id: used.id, pages: used.pdf.numPages, nativeSource: used.nativeSource })).catch(() => {});
    } };
  libraryOpener.host = { tabs: () => tabStore.list, activeKey: () => tabStore.activeKey, retain: () => tabStore.retain(), switchTab, closeTab: key => closeTab(key),
    open: (source, name, token, context) => openDocument(source, name, false, token, context), showLibrary: setLibrary, showDrive: setDriveLibrary,
    driveAvailable: () => driveAvailable, setTransfer: setDriveRefresh, forgotten: id => setRecents(items => items.filter(item => item.id !== id)), notify };
  output.host = { current: () => docRef.current, annotations: () => annotationRef.current, reading: () => readingState.current, draft: () => editorDraftRef.current,
    busy: () => !!busyRef.current, loading: () => loadingRef.current, setBusy, setDriveMessage, writeLive: () => editStore.session ? liveEdit.write() : Promise.resolve(),
    editing: () => workbenchRef.current === 'edit-pdf' && !phoneRef.current, reopen: (source, name, token, context) => openDocument(source, name, false, token, context),
    draftsWritten: () => persistence.draftsWritten, retire: retireLibraryEntry, downloaded: current => { downloadedDrafts.current.add(current); tabStore.publish(); },
    driveConflict: id => { setDriveConflicts(ids => [...new Set([...ids, id])]); setDriveLibrary(true); setLibrary(true); }, notify, dismissNotice: dismissToast };
  persistence.host = { forgotten: id => forgottenIds.current.has(id), unread: id => unreadSessions.current.has(id),
    held: document => docRef.current === document || tabStore.list.some(tab => tab.doc === document), annotated: (document, items) => annotatedBytes(document, items, true) };
  liveEdit.host = { store: editStore, current: () => docRef.current, editing: () => editingRef.current, touch: () => touchRef.current, notify,
    snapshot, historyBudget, trim: trimHistory, historyChanged: () => setHistoryTick(v => v + 1), reopen: reopenWritten,
    stacks: current => { const owner = tabStore.list.find(tab => tab.doc === current); return !owner || owner.key === tabStore.activeKey ? [undoStack.current, redoStack.current] : [owner.undo, owner.redo]; },
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
      {tablet ? <TabletReaderHeader nameAdornment={driveIndicator} documentsOpen={mobileTabs} name={doc?.name || 'Folio'} count={tabs.length} page={pageCounter} pageStep={readingMode === 'single' && doc ? { previous: page > 1 ? () => goToPage(page - 1, false) : undefined, next: page < doc.pdf.numPages ? () => goToPage(page + 1, false) : undefined } : undefined} annotating={mobileAnnotating} disabled={!!busy || loading} draft={editorDraft || inlineEditing} canUndo={!!undoStack.current.length} canRedo={!!redoStack.current.length} bookmarked={!!doc && hasBookmarkPage(bookmarks, page)} onBookmark={toggleBookmark} onLibrary={() => void returnToLibrary()} onDocuments={() => setMobileTabs(value => !value)} onPage={() => { setPageInput(String(page)); setPageJump(true); }} onPages={() => openExplorer()} onSearch={openSearch} onAnnotate={startAnnotating} onDone={() => { setMobileAnnotating(false); setTool('select'); }} onUndo={undo} onRedo={redo} onMore={() => setMobileActions(true)} /> : phone ? <>
        <IconButton label="Volver a la biblioteca" disabled={!!busy || loading} onClick={() => void returnToLibrary()}><ChevronLeft size={24} /></IconButton>
        <button id="document-switcher-trigger" className="mobile-document-selector" aria-label="Documentos abiertos y recientes" aria-haspopup="dialog" aria-expanded={mobileTabs} aria-controls="document-switcher" disabled={!!busy || loading || !tabs.length} onClick={() => setMobileTabs(value => !value)}><span>{doc?.name || 'Folio'}</span>{driveIndicator}{tabs.length > 1 && <span className="mobile-tab-count">{tabs.length}</span>}<ChevronDown size={16} /></button>
        {mobileAnnotating ? <><IconButton label="Deshacer" disabled={!!busy || !undoStack.current.length} onClick={undo}><Undo2 size={21} /></IconButton><IconButton label="Rehacer" disabled={!!busy || !redoStack.current.length} onClick={redo}><Redo2 size={21} /></IconButton><button className="mobile-done" onClick={() => { setMobileAnnotating(false); setTool('select'); }}>Listo</button></> : <IconButton label="Más acciones" onClick={() => setMobileActions(true)}><MoreHorizontal size={23} /></IconButton>}
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
          onQuery={value => { visitedSearch.current = null; setQuery(value); setResultIndex(0); }} onClear={() => setQuery('')}
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
            {sideTab === 'bookmarks' && <BookmarkTree key={activeTabKey} bookmarks={bookmarks} onChange={commitBookmarks} onFold={next => { readingState.current.bookmarks = next; setBookmarks(next); }} page={page} onGoToPage={mobilePage} disabled={!!busy || loading} startEditingId={bookmarkEditingId} onEditingComplete={() => setBookmarkEditingId(null)} />}
          </div>
        </>}
      </aside>}

      <main className={`reader${phone && mobileAnnotating ? ' mobile-annotating' : ''}`} id="document-reader" inert={library || touchLayout && (sidebar || notesOpen)}>
        {!touchLayout && !inlineEditing && <ReaderToolbar doc={doc} busy={!!busy} loading={loading} mode={editing ? 'edit' : mobileAnnotating ? 'annotate' : 'read'}
          onRead={() => { setEditing(false); setMobileAnnotating(false); setTool('select'); }} onAnnotate={startAnnotating} onEdit={openEditor} onTools={openTools}
          canUndo={!!undoStack.current.length} canRedo={!!redoStack.current.length} onUndo={undo} onRedo={redo}
          page={page} pageInput={pageInput} onPageInput={value => { pageInputDirty.current = true; setPageInput(value); }} onPageCommit={commitPageInput} onPageBlur={() => { if (pageInputDirty.current) commitPageInput(); }} onPage={goToPage}
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
        {touchLayout && doc && returnLocation?.key === activeTabKey && returnLocation.page !== page && <button className="touch-return-location" onClick={returnToLocation}><ChevronLeft size={18} /><span>Volver a p. {pageName(returnLocation.page)}</span></button>}

        {phone && doc && <PhoneReadingBar doc={doc} disabled={!!busy || loading} page={page} counter={pageCounter ?? ''} singlePage={readingMode === 'single'} onPage={next => goToPage(next, false)}
          onJump={() => { setPageInput(String(page)); setPageJump(true); }} bookmarked={hasBookmarkPage(bookmarks, page)} onBookmark={toggleBookmark} annotating={mobileAnnotating}
          searching={searchOpen && !sidebar} results={results.length} result={resultIndex} onResult={goToResult} onResults={() => setSidebar(true)} onCloseSearch={closeSearch}
          onPages={() => openExplorer()} onSearch={openSearch} onAnnotate={startAnnotating} onShare={button => void shareDocument(anchorOf(button))} />}
        {!touchLayout && doc && returnLocation?.key === activeTabKey && returnLocation.page !== page && <button className="desktop-return-location" onClick={returnToLocation}><ChevronLeft size={16} /><span>Volver a p. {returnLocation.page}</span></button>}
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
      tablet={tablet} saveLabel={saveLabel} savesOriginal={savesOriginal} capabilitySummary={capabilitySummary} canUndo={undoStack.current.length > 0} canRedo={redoStack.current.length > 0}
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
    <PencilPalette enabled={!!doc?.canAnnotate && !library && !busy && !loading && !workbench} inkColor={inkStyle.color} canUndo={undoStack.current.length > 0}
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

    {library && <div className={`library-screen${phone ? '' : ' desktop-library-screen'}`}>{driveLibrary ? <DriveBrowser onClose={() => setDriveLibrary(false)} onOpen={(file, pending) => libraryOpener.openDrive(file, pending)} onSynced={file => { libraryOpener.synced(file); tabStore.publish(); }} conflicts={driveConflicts} onConflicts={setDriveConflicts} /> : libraryContent}</div>}
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
