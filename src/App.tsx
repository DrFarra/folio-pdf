import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, BookOpen, Bookmark, Check, CircleAlert,
  ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Cloud, FileText, FolderOpen,
  PenLine, Eraser, Highlighter, Info, Layers, ListTree, LoaderCircle, LockKeyhole,
  Maximize, Minimize, MessageSquare, Minus, MoreHorizontal, MousePointer2,
  Plus, Printer, Redo2, RotateCw, Search, ShieldCheck,
  Settings, Settings2, StickyNote, Undo2, Upload, X, Wrench, FilePlus2,
} from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import PDFPage, { Thumbnail } from './components/PDFPage';
import Modal, { SheetHandle } from './components/Modal';
import DocumentLibrary from './components/DocumentLibrary';
import { DriveBrowser, TransferCard, advance, type Transfer } from './components/DriveBrowser';
import { driveLookup, driveOpen, driveStage, driveStageNative, driveStatus as readDriveStatus, driveSync, type DriveBinding, type DriveOpened } from './drive';
import DocumentSwitcher from './components/DocumentSwitcher';
import DocumentOutline from './components/DocumentOutline';
import ViewSettings from './components/ViewSettings';
import { buildTextIndex, exportAnnotated, formatSize, getDocument, plural, readOutline, searchText, pageText, readPageLabels, readPageLabel } from './pdf';
import { errorMessage } from './errors';
import { openNativePdf, isNativePdfDocument, isNativePdfPasswordError, nativePdfPageAnnotations, subscribeNativePdfAnnotations } from './nativePdf';
import { migrateLegacyNativePage } from './native-session';
import type { Inspection } from './engine/mupdf-engine.mjs';
import type { NativeDocument } from './platform';
import { inspectPdf, processPdf } from './engine/client';
import type { Area, Operation, PageEntry } from './engine/operations.mjs';
import Workbench from './components/Workbench';
import CreatePDF from './components/CreatePDF';
import BookmarkTree from './components/BookmarkTree';
import TextSelectionMenu from './components/TextSelectionMenu';
import HighlightColorPicker from './components/HighlightColorPicker';
import DrawingSettings, { INK_DEFAULTS, inkRange, type InkKind, type InkStyle } from './components/DrawingSettings';
import ReadingSettings from './components/ReadingSettings';
import { readReadingPreferences } from './reading-preferences';
import { addPageBookmark, deleteBookmark, hasBookmarkPage, normalizeBookmarks, remapBookmarks } from './bookmarks';
import { commentSelection, highlightSelection } from './text-selection';
import type { AnnotationDraft } from './text-selection';
import './tabs.css';
import './mac-platform.css';
import './mobile.css';
import './desktop.css';
import './tablet.css';
import './motion.css';
import { useExit } from './motion';
import { markDrive, readCover, renderCover, saveCover } from './library-meta';
import { PageScrubber } from './components/PageScrubber';
import { ActivityPill, type ActivityStep } from './components/ActivityPill';
import { ColumnSelectionPreview } from './components/ColumnSelectionPreview';
import { addHighlights } from './highlight-merge';
import { AnnotationsPanel } from './components/AnnotationsPanel';
import { TabletReaderHeader, TabletAnnotationDock } from './components/TabletReaderControls';
import { useDeviceLayout } from './mobile';
import { useDocumentTabDrag } from './useDocumentTabDrag';
import { assetUrl, pdfAssetSettings } from './assets';
import { isDesktop, isNative, isIOS, isAndroid, isMobile, isMac, setReaderChrome, shortcutLabel, pickNativeDocuments, readNativeDocument, savePdf, saveOriginalPdf, sharePdf, printPdf, presentNativePdf, nativeDraftDocument, startupDocuments, openExternalUrl, prunePrivateCopies, copyNativeText, saveExport, type Anchor } from './platform';
import { clearSavedState, forgetDocument, listLibrary, readLibraryData, readLibrarySource, readSession, rememberDocument, touchDocument, saveSession, readDraft, storeDraft, discardDraft } from './storage';
import type { Annotation, BookmarkNode, LoadedDocument, OutlineEntry, PDFNavigationTarget, RecentDocument, Session, SideTab, Tool } from './types';

const DEFAULT_HIGHLIGHT_COLOR = '#f5d164';
const NO_ANNOTATIONS: Annotation[] = [];
const SAMPLE_NAME = 'Guía de Folio.pdf';
// Annotation arrays are replaced, never mutated, so one serialization per array
// serves every render, tab badge and save check.
const fingerprints = new WeakMap<Annotation[], string>();
const annotationFingerprint = (items: Annotation[]) => {
  let fingerprint = fingerprints.get(items);
  if (fingerprint === undefined) fingerprints.set(items, fingerprint = JSON.stringify(items.map(a => [a.id, a.page, a.kind, a.rect, a.text, a.color, a.quads, a.inkPaths, a.strokeWidth])));
  return fingerprint;
};
const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const preference = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const searchTerm = (value: string) => value.trim().length >= 2 ? value : '';
// Saving a copy of a copy keeps a single suffix.
const copyName = (name: string) => `${name.replace(/\.pdf$/i, '').replace(/( — copia)+$/, '')} — copia.pdf`;
// Windows, macOS and Android save over the opened file; iOS saves copies through its sheets and the web downloads.
const savesInPlace = isNative && (isAndroid || isDesktop);
const fileSaveLabel = savesInPlace ? 'Guardar' : isNative ? 'Guardar una copia' : 'Descargar';
// Where unsaved changes are kept, and how to keep them in a PDF when that fails.
const here = isDesktop ? 'este equipo' : isNative ? 'este dispositivo' : 'este navegador';
const saveAdvice = savesInPlace ? 'Guarda el PDF para no perderlos.' : isNative ? 'Guarda una copia del PDF para no perderlos.' : 'Descarga el PDF para no perderlos.';
const redoShortcut = isMac || isIOS ? shortcutLabel('Z', true) : shortcutLabel('Y');
// Fingers draw until a pen appears; an explicit choice always wins. The old
// folio.ink.penOnly default was stored unasked, so only its 'false' is a choice.
const penMode = () => preference('folio.ink.penMode', preference('folio.ink.penOnly', '') === 'false' ? 'finger' : '');
// The theme follows the system until chosen. The old folio.theme was stored
// unasked as 'light', so only its 'dark' is a choice.
const themeChoice = () => preference('folio.themeChoice', preference('folio.theme', '') === 'dark' ? 'dark' : 'system');
type OpenSource = Blob | Uint8Array | 'sample' | NativeDocument;
type ToastKind = 'success' | 'info' | 'error';
const nativeReadingThreshold = 32 * 1024 * 1024;
type NoteDraft = Omit<Annotation, 'id' | 'created'> & { id?: string };
type OpenContext = { drive?: DriveBinding; savedCopy?: boolean; keepEditing?: boolean; draftSource?: boolean; id?: string; password?: string; modified?: boolean; useSession?: boolean; preserveHistory?: boolean; page?: number; bookmarks?: BookmarkNode[] };
type History = { annotations: Annotation[]; bytes?: Uint8Array; password?: string; page?: number; bookmarks?: BookmarkNode[] };
type TabView = { page: number; dimensions: { width: number; height: number; rotation: number }; zoomMode: string; customScale: number; rotation: number; readingMode: 'continuous' | 'single'; annotating: boolean; tool: Tool; color: string; sidebar: boolean; sideTab: SideTab; notesOpen: boolean; outline: OutlineEntry[] | null; textIndex: string[]; indexing: boolean; searchOpen: boolean; query: string; resultIndex: number; activeNote: string | null; redactions: Area[]; editArea: Area | null; sessionFailed: boolean; draftFailed: boolean };
type DocumentTab = TabView & { key: string; doc: LoadedDocument; annotations: Annotation[]; bookmarks: BookmarkNode[]; undo: History[]; redo: History[]; scrollTop: number; scrollLeft: number };

function IconButton({ children, label, onClick, onMouseDown, disabled = false, active = false, toggle = false, className = '' }: { children: React.ReactNode; label: string; onClick: () => void; onMouseDown?: React.MouseEventHandler<HTMLButtonElement>; disabled?: boolean; active?: boolean; toggle?: boolean; className?: string }) {
  return <button className={`icon-button ${active ? 'active' : ''} ${className}`} aria-label={label} aria-pressed={toggle ? active : undefined} title={label} onClick={onClick} onMouseDown={onMouseDown} disabled={disabled}>{children}</button>;
}

export default function App() {
  const layout = useDeviceLayout(), phone = layout === 'phone', tablet = layout === 'tablet', touchLayout = phone || tablet;
  const [mobileActions, setMobileActions] = useState(false);
  const [mobileTabs, setMobileTabs] = useState(false);
  const [mobileAnnotating, setMobileAnnotating] = useState(false);
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
  const [zoomMode, setZoomMode] = useState('page');
  const [customScale, setCustomScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [readingMode, setReadingMode] = useState<'continuous' | 'single'>(() => readReadingPreferences().mode);
  const [tool, setTool] = useState<Tool>('select');
  const [inkKind, setInkKind] = useState<InkKind>(() => preference('folio.ink.kind', 'pen') === 'marker' ? 'marker' : 'pen');
  const [inkStyles, setInkStyles] = useState<Record<InkKind, InkStyle>>(() => {
    // Older versions kept one pen color and width; they become the pen's style.
    const legacy = { ...INK_DEFAULTS.pen, color: preference('folio.ink.color', INK_DEFAULTS.pen.color), width: Number(preference('folio.ink.width', '2')) || 2 };
    let saved: Partial<Record<InkKind, Partial<InkStyle>>> = {};
    try { saved = JSON.parse(preference('folio.ink.styles', '{}')) || {}; } catch {}
    const valid = (kind: InkKind, style: Partial<InkStyle> | undefined, fallback: InkStyle): InkStyle => {
      const range = inkRange(kind), width = Number(style?.width), opacity = Number(style?.opacity);
      return { color: typeof style?.color === 'string' && /^#[0-9a-f]{6}$/i.test(style.color) ? style.color.toLowerCase() : fallback.color,
        width: Number.isFinite(width) ? Math.min(range.max, Math.max(range.min, width)) : fallback.width, opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(.1, opacity)) : fallback.opacity };
    };
    return { pen: valid('pen', saved.pen, legacy), marker: valid('marker', saved.marker, INK_DEFAULTS.marker) };
  });
  const [inkRecentColors, setInkRecentColors] = useState<string[]>(() => { try { const value = JSON.parse(preference('folio.ink.recentColors', '[]')); return Array.isArray(value) ? value.filter(item => typeof item === 'string' && /^#[0-9a-f]{6}$/.test(item)).slice(0, 5) : []; } catch { return []; } });
  const inkStyle = inkStyles[inkKind];
  const [eraserSize, setEraserSize] = useState(() => Number(preference('folio.ink.eraserSize', '16')) || 16);
  const [penOnly, setPenOnly] = useState(() => penMode() === 'pen');
  const choosePenOnly = useCallback((value: boolean) => { setPenOnly(value); try { localStorage.setItem('folio.ink.penMode', value ? 'pen' : 'finger'); } catch {} }, []);
  const [penDetected, setPenDetected] = useState(false);
  useEffect(() => {
    const detect = (event: PointerEvent) => { if (event.pointerType !== 'pen') return; setPenDetected(true); if (!penMode()) choosePenOnly(true); };
    window.addEventListener('pointerover', detect, { passive: true, capture: true });
    window.addEventListener('pointerdown', detect, { passive: true, capture: true });
    return () => { window.removeEventListener('pointerover', detect, true); window.removeEventListener('pointerdown', detect, true); };
  }, [choosePenOnly]);
  useEffect(() => { try { localStorage.setItem('folio.ink.kind', inkKind); localStorage.setItem('folio.ink.styles', JSON.stringify(inkStyles)); localStorage.setItem('folio.ink.recentColors', JSON.stringify(inkRecentColors)); localStorage.setItem('folio.ink.eraserSize', String(eraserSize)); } catch {} }, [inkKind, inkStyles, inkRecentColors, eraserSize]);
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
  const [textIndex, setTextIndex] = useState<string[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The searched text follows typing after a pause and needs two characters.
  const [searchQuery, setSearchQuery] = useState('');
  const nativeSearchRequested = searchOpen && !!searchQuery;
  const [resultIndex, setResultIndex] = useState(0);
  const [resultLimit, setResultLimit] = useState(200);
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
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const noteOrigin = useRef<'document' | 'list'>('document');
  const [noteText, setNoteText] = useState('');
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const [password, setPassword] = useState<{ name: string; retry: boolean; submit: (value: string) => void } | null>(null);
  const passwordRef = useRef(password); passwordRef.current = password;
  const [passwordText, setPasswordText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: ToastKind; id: number; action?: { label: string; run: () => void } } | null>(null);
  // Drawers and notices stay mounted while they animate out.
  const sidebarLeaving = useExit(touchLayout && sidebar), notesLeaving = useExit(touchLayout && notesOpen), toastLeaving = useExit(!!toast, 150);
  const lastToast = useRef(toast); if (toast) lastToast.current = toast;
  const shownToast = toast || (toastLeaving ? lastToast.current : null);
  const toastRef = useRef<HTMLDivElement>(null);
  const [windowState, setWindowState] = useState({ maximized: false, fullscreen: false });
  const [driveAvailable, setDriveAvailable] = useState(isNative);
  const [driveRefresh, setDriveRefresh] = useState<Transfer | null>(null);
  const menuAction = useRef((_id: string) => {});
  const [sessionFailed, setSessionFailed] = useState(false);
  const [draftFailed, setDraftFailed] = useState(false);
  const storageFailed = sessionFailed || draftFailed;
  useEffect(() => { if (tool === 'highlight' || tool === 'note') setMobileAnnotating(true); }, [tool]);
  // The tab key, or 'window', whose closing waits because its session could not be saved.
  const [closeBlocked, setCloseBlocked] = useState<string | null>(null);
  const [theme, setTheme] = useState(themeChoice);
  const chooseTheme = (value: string) => { setTheme(value); try { localStorage.setItem('folio.themeChoice', value); } catch { /* The theme still applies to this session. */ } };
  const [, setHistoryTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const picking = useRef(false);
  const viewer = useRef<HTMLDivElement>(null);
  const pageInputDirty = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const loadRequest = useRef(0);
  const tabsRef = useRef<DocumentTab[]>([]);
  const activeTabRef = useRef<string | null>(null);
  const openQueue = useRef<Promise<unknown>>(Promise.resolve());
  const loadingRef = useRef(loading); loadingRef.current = loading;
  const restoreScroll = useRef<{ key: string; top: number; left: number } | null>(null);
  const scrollRestoreFrame = useRef<number | null>(null);
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const engineRef = useRef<AbortController | null>(null);
  const docRef = useRef<LoadedDocument | null>(null);
  const annotationRef = useRef<Annotation[]>([]);
  const readingState = useRef({ page, bookmarks });
  readingState.current = { page, bookmarks };
  const undoStack = useRef<History[]>([]);
  const redoStack = useRef<History[]>([]);
  const draftSave = useRef<Promise<void>>(Promise.resolve());
  const sessionSaved = useRef<{ doc: LoadedDocument; annotations: Annotation[]; bookmarks: BookmarkNode[] } | null>(null);
  const draftWrites = useRef(new WeakMap<LoadedDocument, Promise<void>>());
  const tabWrites = useRef(new Map<string, { signature: string; promise: Promise<void> }>());
  const driveWrites = useRef(new Map<string, { signature: string; promise: Promise<void> }>());
  const librarySave = useRef<Promise<void>>(Promise.resolve());
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const saving = useRef(false);
  const printCleanup = useRef<(() => void) | null>(null);
  const dragCounter = useRef(0);
  const passwordCancelled = useRef(false);
  const forgottenIds = useRef(new Set<string>());
  // Web documents whose edited PDF was downloaded as it is now: their tab no longer reads as unsaved.
  const downloadedDrafts = useRef(new WeakSet<LoadedDocument>());
  // Documents whose stored session could not be read: nothing rewrites it until the user changes something.
  const unreadSessions = useRef(new Set<string>());
  // Drive edits of closed tabs still being prepared; quitting waits for them.
  const closingStages = useRef(new Set<Promise<boolean>>());
  const preferencesRef = useRef({ rememberRecent, defaultZoom });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentScale = useRef(1);
  // The smooth page jump in progress, if any, and the reader's page tracking.
  const smoothJump = useRef(0), smoothJumps = useRef(0), trackPage = useRef(() => {});
  const phoneRef = useRef(phone); phoneRef.current = phone;
  const touchRef = useRef(touchLayout); touchRef.current = touchLayout;
  const wheelAnchor = useRef<{ id: string; page: number; x: number; y: number; pointerX: number; pointerY: number } | null>(null);
  // The page point at the centre of the reader, updated while reading, so zoom,
  // rotation and size changes keep the same place in view.
  const readingAnchor = useRef<{ id: string; page: number; x: number; y: number; rotation: number } | null>(null);
  const chromeHiddenRef = useRef(readerChromeHidden); chromeHiddenRef.current = readerChromeHidden;
  const fittedWidth = useRef(viewportSize.width); fittedWidth.current = viewportSize.width;
  const activeView = useRef<TabView>(null!);
  activeView.current = { page, dimensions, zoomMode, customScale, rotation, readingMode, annotating: mobileAnnotating, tool, color, sidebar, sideTab, notesOpen, outline, textIndex, indexing, searchOpen, query, resultIndex, activeNote, redactions, editArea, sessionFailed, draftFailed };
  const tabWheel = useRef(0);
  const tabDrag = useDocumentTabDrag({ keys: tabs.map(tab => tab.key), activeKey: activeTabKey, disabled: phone || !!busy || loading,
    onReorder: keys => {
      if (busyRef.current || loadingRef.current || keys.length !== tabsRef.current.length || new Set(keys).size !== keys.length ||
          keys.some(key => !tabsRef.current.some(tab => tab.key === key))) return;
      if (workbenchRef.current !== 'edit-pdf' || phoneRef.current) retainCurrentTab();
      const current = new Map(tabsRef.current.map(tab => [tab.key, tab]));
      tabsRef.current = keys.map(key => current.get(key)!); publishTabs();
    } });
  const draggedTab = tabs.find(tab => tab.key === tabDrag.draggingKey);

  function captureTab(): DocumentTab | null {
    // Commit an inline bookmark name before a keyboard switch, close or open.
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('bookmark-name-input')) document.activeElement.blur();
    const current = docRef.current, key = activeTabRef.current;
    if (!current || !key) return null;
    return { ...activeView.current, key, doc: current, annotations: annotationRef.current, bookmarks: readingState.current.bookmarks,
      undo: undoStack.current, redo: redoStack.current, scrollTop: viewer.current?.scrollTop || 0, scrollLeft: viewer.current?.scrollLeft || 0 };
  }
  function retainCurrentTab() {
    const current = captureTab();
    if (current) tabsRef.current = tabsRef.current.map(tab => tab.key === current.key ? current : tab);
  }
  function publishTabs() { setTabs([...tabsRef.current]); }
  function activateTab(tab: DocumentTab, focusSelectedTab = document.activeElement?.getAttribute('role') === 'tab') {
    pageInputDirty.current = false;
    activeTabRef.current = tab.key; setActiveTabKey(tab.key);
    docRef.current = tab.doc; annotationRef.current = tab.annotations; readingState.current = { page: tab.page, bookmarks: tab.bookmarks };
    undoStack.current = tab.undo; redoStack.current = tab.redo;
    restoreScroll.current = { key: tab.key, top: tab.scrollTop, left: tab.scrollLeft };
    setReaderChromeHidden(false); setDoc(tab.doc); setAnnotations(tab.annotations); setBookmarks(tab.bookmarks); setPage(tab.page); setPageInput(String(tab.page)); setDimensions(tab.dimensions);
    setZoomMode(tab.zoomMode); setCustomScale(tab.customScale); setRotation(tab.rotation); setTool(tab.tool); setColor(tab.color);
    setReadingMode(tab.readingMode); setReturnLocation(null);
    setMobileAnnotating(tab.annotating || tab.tool === 'highlight' || tab.tool === 'note');
    setSidebar(touchRef.current ? false : tab.sidebar); setSideTab(tab.sideTab); setNotesOpen(touchRef.current ? false : tab.notesOpen); setOutline(tab.outline); setTextIndex(tab.textIndex); setIndexing(tab.indexing);
    setSearchOpen(tab.searchOpen); setQuery(tab.query); setSearchQuery(searchTerm(tab.query)); setResultIndex(tab.resultIndex); setActiveNote(tab.activeNote);
    setRedactions(tab.redactions); setEditArea(tab.editArea); setSessionFailed(tab.sessionFailed); setDraftFailed(tab.draftFailed); setBookmarkEditingId(null);
    setWorkBenchClosed(); setHistoryTick(v => v + 1); window.getSelection()?.removeAllRanges();
    if (focusSelectedTab) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.document-tab[data-tab-key="${CSS.escape(tab.key)}"] [role=tab]`)?.focus({ preventScroll: true }));
  }
  function setWorkBenchClosed() { setWorkbench(null); setInfo(false); setLibrary(false); setNoteDraft(null); setPageJump(false); setViewSettings(false); setAnnotationOptions(false); setCapabilityNotice(false); }
  function ensureDraft(document: LoadedDocument): Promise<void> {
    if (!document.modified || isNativePdfDocument(document.pdf) || forgottenIds.current.has(document.id)) return Promise.resolve();
    const existing = draftWrites.current.get(document); if (existing) return existing;
    const operation = draftSave.current.catch(() => {}).then(async () => {
      if (forgottenIds.current.has(document.id)) return;
      await storeDraft(document.id, document.bytes);
      if (document.draftSource && !forgottenIds.current.has(document.id)) {
        await rememberDocument({ id: document.id, name: document.name, size: document.size, pages: document.pdf.numPages, openedAt: Date.now(), draft: true });
      }
    });
    draftSave.current = operation; draftWrites.current.set(document, operation);
    void operation.catch(() => { draftWrites.current.delete(document); });
    return operation;
  }
  function persistTab(tab: DocumentTab, stageDrive = true): Promise<void> {
    if (forgottenIds.current.has(tab.doc.id)) return Promise.resolve();
    const fingerprint = annotationFingerprint(tab.annotations);
    const signature = JSON.stringify([tab.doc.revision, fingerprint, tab.page, tab.bookmarks, tab.doc.nativeKnownPages, tab.doc.nativeOriginalRefs, tab.doc.nativeLegacySession]);
    const key = `${tab.key}:${stageDrive}`;
    const previous = tabWrites.current.get(key);
    if (previous?.signature === signature) return previous.promise;
    const operation = (previous?.promise || Promise.resolve()).catch(() => {}).then(async () => {
      // Session metadata is small. Persist it before any PDF export, including
      // on Android background events; an earlier failed draft is retryable.
      // A session that could not be read is kept until the user changes something.
      if (!unreadSessions.current.has(tab.doc.id)) {
        const saved = await saveSession(tab.doc.id, { annotations: tab.annotations, lastPage: tab.page, bookmarks: tab.bookmarks, documentRevision: tab.doc.revision, nativeKnownPages: tab.doc.nativeKnownPages, nativeOriginalRefs: tab.doc.nativeOriginalRefs, nativeSavedAnnotations: tab.doc.savedAnnotations, nativeLegacySession: tab.doc.nativeLegacySession });
        if (!saved) throw new Error(`No se pudieron guardar tus cambios en ${here}.`);
      }
      await ensureDraft(tab.doc);
      if (!stageDrive || !tab.doc.drive?.editable || !tab.doc.modified && fingerprint === tab.doc.savedAnnotations) return;
      const binding = tab.doc.drive.binding, edit = `${tab.doc.revision}:${fingerprint}`;
      const staged = driveWrites.current.get(binding);
      if (staged?.signature === edit) { await staged.promise; return; }
      const stage = (staged?.promise || Promise.resolve()).catch(() => {}).then(async () => {
        if (isNativePdfDocument(tab.doc.pdf)) {
          if (tab.doc.nativeLegacySession) throw new Error('Guarda el PDF de Drive antes de cerrar para recuperar todas las anotaciones anteriores.');
          const removed = (tab.doc.nativeOriginalRefs || []).filter(ref => !tab.annotations.some(a => a.nativeSourceRef === ref));
          await driveStageNative(binding, tab.doc.nativeSource!, tab.annotations, removed);
        } else await driveStage(binding, tab.doc.canAnnotate ? await exportAnnotated(tab.doc.bytes, tab.annotations, tab.doc.password, undefined, true) : tab.doc.bytes);
      });
      driveWrites.current.set(binding, { signature: edit, promise: stage });
      void stage.catch(() => { if (driveWrites.current.get(binding)?.promise === stage) driveWrites.current.delete(binding); });
      await stage;
    });
    tabWrites.current.set(key, { signature, promise: operation });
    void operation.catch(() => { if (tabWrites.current.get(key)?.promise === operation) tabWrites.current.delete(key); });
    return operation;
  }
  // An open document stays in memory, so navigation never waits for its session
  // and a failure only marks the tab until the next successful write.
  function persistInBackground(tab: DocumentTab) {
    void persistTab(tab, false).catch(error => {
      tabsRef.current = tabsRef.current.map(item => item.key === tab.key ? { ...item, sessionFailed: true } : item);
      if (activeTabRef.current === tab.key) setSessionFailed(true);
      if (!tab.sessionFailed) notify(`${errorMessage(error)} ${saveAdvice}`, 'error');
    });
  }
  async function switchTab(key: string) {
    if (editorDraftRef.current) { notify('Aplica o descarta la edición antes de cambiar de documento.'); return; }
    if (key === activeTabRef.current || busyRef.current || loadingRef.current || document.querySelector('dialog[open]')) return;
    const next = tabsRef.current.find(tab => tab.key === key); if (!next) return;
    if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) await closeWorkbench();
    const focusSelectedTab = document.activeElement?.getAttribute('role') === 'tab';
    const current = captureTab();
    retainCurrentTab(); activateTab(next, focusSelectedTab); publishTabs();
    if (current) persistInBackground(current);
    // The library lists documents by last use. Drafts and pending native edits keep their own entries.
    const used = next.doc;
    if (preferencesRef.current.rememberRecent && !used.sample && !used.draftSource && !(used.modified && used.nativeSource) && !forgottenIds.current.has(used.id))
      librarySave.current = librarySave.current.catch(() => {}).then(() => touchDocument({ id: used.id, pages: used.pdf.numPages, nativeSource: used.nativeSource })).catch(() => {});
  }
  async function closeTab(key: string, discardSession = false) {
    if (editorDraftRef.current) { notify('Aplica o descarta la edición antes de cerrar el documento.'); return; }
    if (busyRef.current || loadingRef.current || document.querySelector('dialog[open]')) return;
    const index = tabsRef.current.findIndex(tab => tab.key === key); if (index < 0) return;
    if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) await closeWorkbench();
    retainCurrentTab();
    const closed = tabsRef.current[index];
    if (!discardSession) {
      // Closing releases the document, so its session and draft must be stored
      // first. Actions wait meanwhile, without the reader's «Abriendo PDF…».
      try { busyRef.current = 'close'; setBusy('close'); await persistTab(closed, false); }
      catch (error) {
        if (activeTabRef.current !== key) { activateTab(closed); publishTabs(); }
        notify(errorMessage(error), 'error'); setCloseBlocked(key); return;
      } finally { busyRef.current = null; setBusy(null); }
    }
    tabsRef.current = tabsRef.current.filter(tab => tab.key !== key);
    if (activeTabRef.current === key) {
      const next = tabsRef.current[Math.min(index, tabsRef.current.length - 1)];
      if (next) activateTab(next);
      else {
        pageInputDirty.current = false; setPageInput('1'); setPage(1);
        activeTabRef.current = null; setActiveTabKey(null); docRef.current = null; annotationRef.current = []; undoStack.current = []; redoStack.current = [];
        setReaderChromeHidden(false); setDoc(null); setAnnotations([]); setBookmarks([]); setOutline(null); setTextIndex([]); setQuery(''); setSearchOpen(false); setNotesOpen(false); setSidebar(false); setTool('select'); setRedactions([]); setEditArea(null); setWorkBenchClosed(); setMobileAnnotating(false); setLibrary(true);
      }
    }
    publishTabs();
    // A closed Drive document becomes a pending edit in the background; its PDF
    // stays loaded until that export finishes, and quitting waits for it.
    const staged = !discardSession && closed.doc.drive?.editable ? persistTab(closed).then(() => true, () => {
      notify(`No se pudo preparar la edición de «${closed.doc.name}» para Drive. Tus anotaciones se conservan: ábrelo de nuevo para guardarlo en Drive.`, 'error'); return false;
    }) : Promise.resolve(true);
    closingStages.current.add(staged);
    void staged.then(() => { closingStages.current.delete(staged); setTimeout(() => { void closed.doc.pdf.loadingTask.destroy(); }, 200); });
  }

  // ✓ confirms a completed action and «i» explains a blocked one. Errors stay
  // until closed; screen readers hear every notice through the live regions.
  // While a task runs its outcome waits for the activity capsule, which shows it in place.
  const activityRun = useRef<{ started: number; result?: { message: string; kind: ToastKind } } | null>(null);
  const notify = useCallback((message: string, kind: ToastKind = 'info', action?: { label: string; run: () => void }) => {
    if (activityRun.current && kind !== 'error' && !action) { activityRun.current.result = { message, kind }; return; }
    setToast(previous => ({ message, kind, id: (previous?.id || 0) + 1, action }));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    // A notice with an action stays longer, so there is time to use it.
    toastTimer.current = kind === 'error' ? null : setTimeout(() => setToast(null), action ? 6000 : 3500);
  }, []);

  const loadDocument = useCallback(async (source: OpenSource, name = SAMPLE_NAME, sample = false, nativeSource?: string, context?: OpenContext) => {
    if (editorDraftRef.current && !context?.preserveHistory) { notify('Aplica o descarta la edición antes de abrir otro documento.'); return false; }
    if (workbenchRef.current === 'edit-pdf' && !phoneRef.current && !context?.preserveHistory) await closeWorkbench();
    const request = ++loadRequest.current;
    engineRef.current?.abort();
    const controller = new AbortController(); engineRef.current = controller;
    if (taskRef.current) { void taskRef.current.destroy(); taskRef.current = null; }
    passwordCancelled.current = false;
    setPassword(null);
    loadingRef.current = true;
    setLoading(true);
    try {
      const priorDocument = docRef.current;
      if (priorDocument && !context?.preserveHistory && !context?.savedCopy) {
        const priorTab = captureTab(); if (priorTab) persistInBackground(priorTab);
      }
      const nativeInput = typeof source === 'object' && 'token' in source ? source : null;
      let nativeFile = nativeInput;
      nativeSource = nativeFile?.token || nativeSource;
      const drive = context?.drive || (context?.preserveHistory ? priorDocument?.drive : undefined) || (nativeSource && isNative ? await driveLookup(nativeSource) : undefined) || undefined;
      if (!context && nativeInput?.id && !drive) {
        const existing = tabsRef.current.find(tab => tab.doc.id === nativeInput.id);
        if (existing) { retainCurrentTab(); activateTab(tabsRef.current.find(tab => tab.key === existing.key)!); publishTabs(); setLoading(false); loadingRef.current = false; return true; }
      }
      const fileBacked = isNative && isIOS && !!nativeFile && nativeFile.size > nativeReadingThreshold;
      const digest = async (data: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer))].map(n => n.toString(16).padStart(2, '0')).join('');
      // Identical PDFs in different Drive files/accounts must never share drafts
      // or annotations. Distinct remote bases also retain separate recovery data.
      const driveId = drive ? await digest(new TextEncoder().encode(`${drive.account}:${drive.fileId}:${drive.baseChecksum}`)) : undefined;
      let bytes = new Uint8Array(0) as Uint8Array;
      let id: string, revision: string, pdf: PDFDocumentProxy, inspection: Inspection;
      let originalBytes = bytes;
      let modified = context?.modified || false;
      let documentPassword = context?.password || '';
      let size = 0;
      if (fileBacked) {
        if (!context && nativeInput?.id) {
          const draft = await nativeDraftDocument(driveId || nativeInput.id, name);
          if (draft) { nativeFile = draft; nativeSource = draft.token; modified = true; notify('Se recuperaron tus cambios sin guardar.'); }
        }
        let opened;
        while (!opened) {
          try { opened = await openNativePdf(nativeFile!, documentPassword, controller.signal); }
          catch (error) {
            if (!isNativePdfPasswordError(error)) throw error;
            documentPassword = await new Promise<string>((resolve, reject) => {
              const cancel = () => reject(new DOMException('Operación cancelada', 'AbortError'));
              controller.signal.addEventListener('abort', cancel, { once: true });
              setPassword({ name, retry: error.retry, submit: value => { controller.signal.removeEventListener('abort', cancel); resolve(value); } });
              setPasswordText('');
            });
          }
        }
        pdf = opened.pdf;
        taskRef.current = pdf.loadingTask;
        id = context?.id || driveId || nativeInput?.id || opened.metadata.id; revision = opened.metadata.revision; size = opened.metadata.size;
        inspection = { ...opened.metadata.permissions, canEdit: false, canAssemble: false, canFill: false,
          signed: opened.metadata.signed, pages: opened.metadata.numPages, annotations: await nativePdfPageAnnotations(pdf, 1) };
      } else {
        if (source === 'sample') {
          const response = await fetch(assetUrl('/sample.pdf'));
          if (!response.ok) throw new Error('No se pudo abrir el documento de ejemplo.');
          bytes = new Uint8Array(await response.arrayBuffer());
        } else if (nativeFile) bytes = await readNativeDocument(nativeFile);
        else bytes = source instanceof Uint8Array ? source : new Uint8Array(await (source as Blob).arrayBuffer());
        if (request !== loadRequest.current) return;
        // A native file's id is already the SHA-256 of its bytes.
        originalBytes = bytes; id = context?.id || driveId || nativeInput?.id || await digest(bytes);
        if (!context) {
          const existing = tabsRef.current.find(tab => tab.doc.id === id);
          if (existing) { retainCurrentTab(); activateTab(tabsRef.current.find(tab => tab.key === existing.key)!); publishTabs(); setLoading(false); loadingRef.current = false; return true; }
        }
        if (!context) {
          const draft = await readDraft(id);
          if (draft) { bytes = draft; modified = true; notify('Se recuperaron tus cambios sin guardar.'); }
        }
        revision = bytes === originalBytes && nativeInput?.id ? nativeInput.id : await digest(bytes); size = bytes.length;
        const task = getDocument({ data: new Uint8Array(bytes), password: documentPassword, ...pdfAssetSettings() });
        taskRef.current = task;
        task.onPassword = (submit: (value: string) => void, reason: number) => { if (request === loadRequest.current) { setPassword({ name, retry: reason === 2, submit: value => { documentPassword = value; submit(value); } }); setPasswordText(''); } };
        pdf = await task.promise;
        try { inspection = await inspectPdf(bytes, documentPassword, controller.signal); }
        catch (error) { await pdf.loadingTask.destroy(); throw error; }
        if (inspection.previewBytes) {
          await pdf.loadingTask.destroy();
          const preview = getDocument({ data: inspection.previewBytes, password: documentPassword, ...pdfAssetSettings() });
          taskRef.current = preview; pdf = await preview.promise;
        }
      }
      if (request !== loadRequest.current) { await pdf.loadingTask.destroy(); return; }
      if (!context) {
        const existing = tabsRef.current.find(tab => tab.doc.id === id);
        if (existing) {
          // Avoid closing the native token shared by the existing adapter.
          if (!fileBacked || existing.doc.nativeSource !== nativeSource) await pdf.loadingTask.destroy();
          retainCurrentTab(); activateTab(tabsRef.current.find(tab => tab.key === existing.key)!); publishTabs();
          setLoading(false); loadingRef.current = false; taskRef.current = null; return true;
        }
      }
      const first = await pdf.getPage(1);
      const view = first.getViewport({ scale: 1 });
      if (request !== loadRequest.current) { await pdf.loadingTask.destroy(); return; }
      let sessionUnread = false;
      const session: Session = context?.useSession === false ? { annotations: inspection.annotations, bookmarks: context.bookmarks || [], lastPage: context.page || 1, version: 2 }
        : await readSession(id).catch(() => { sessionUnread = true; notify('No se pudieron cargar las anotaciones guardadas de este PDF. Ciérralo y vuelve a abrirlo antes de hacer cambios, o se reemplazarán.', 'error'); return { annotations: [], bookmarks: [], lastPage: 1 }; });
      if (!context && !readingPreferencesRef.current.restorePage) session.lastPage = 1;
      if (request !== loadRequest.current) { await pdf.loadingTask.destroy(); return; }
      const loaded: LoadedDocument = { pdf, bytes, id, revision, modified, savedAnnotations: annotationFingerprint(inspection.annotations), draftSource: context?.draftSource || (!nativeSource && modified && isNative), name, size, sample: sample || source === 'sample', password: documentPassword, nativeSource, canAnnotate: inspection.canAnnotate, canEdit: inspection.canEdit, canAssemble: inspection.canAssemble, canFill: inspection.canFill, canCopy: inspection.canCopy, canPrint: inspection.canPrint, signed: inspection.signed, initialPage: session.lastPage, hadAnnotations: inspection.annotations.length > 0 };
      const replacing = !!context?.preserveHistory || !!context?.savedCopy;
      // Opening a document again after deleting its local copy starts a new record.
      if (!replacing) forgottenIds.current.delete(id);
      if (sessionUnread) unreadSessions.current.add(id); else unreadSessions.current.delete(id);
      loaded.drive = drive;
      if (drive && !drive.editable) { loaded.canAnnotate = false; loaded.canEdit = false; loaded.canAssemble = false; loaded.canFill = false; }
      const previousTab = captureTab(); retainCurrentTab();
      const restoredTool: Tool = replacing && previousTab?.tool === 'highlight' && loaded.canAnnotate && loaded.canCopy ? 'highlight' : 'select';
      const previous = replacing ? docRef.current : null;
      const key = replacing && activeTabRef.current ? activeTabRef.current : uid();
      activeTabRef.current = key; setActiveTabKey(key);
      pageInputDirty.current = false;
      docRef.current = loaded;
      setDoc(loaded);
      setReaderChromeHidden(false);
      setDimensions({ width: view.width, height: view.height, rotation: first.rotate });
      const initialPage = Math.max(1, Math.min(pdf.numPages, session.lastPage));
      setPage(initialPage); setPageInput(String(initialPage));
      const sessionMatches = session.documentRevision === revision || (!session.documentRevision && !modified) || context?.useSession === false;
      loaded.nativeKnownPages = fileBacked && sessionMatches ? session.nativeKnownPages || [] : [];
      loaded.nativeLegacySession = fileBacked && sessionMatches && (session.nativeLegacySession || (session.version || 0) >= 2 && !session.nativeKnownPages && !session.nativeOriginalRefs);
      loaded.nativeOriginalRefs = fileBacked && sessionMatches ? session.nativeOriginalRefs || [] : [];
      if (fileBacked && sessionMatches && session.nativeSavedAnnotations) loaded.savedAnnotations = session.nativeSavedAnnotations;
      const restored = !sessionMatches ? inspection.annotations : (session.version || 0) >= 2 ? session.annotations : [...inspection.annotations, ...session.annotations.filter(a => !inspection.annotations.some(b => b.id === a.id))];
      annotationRef.current = restored.filter(a => a.page <= pdf.numPages);
      setAnnotations(annotationRef.current);
      const restoredBookmarks = normalizeBookmarks(session.bookmarks, pdf.numPages);
      setBookmarks(restoredBookmarks);
      readingState.current = { page: Math.max(1, Math.min(pdf.numPages, session.lastPage)), bookmarks: restoredBookmarks };
      if (!context?.preserveHistory && !context?.savedCopy) { undoStack.current = []; redoStack.current = []; }
      setHistoryTick(v => v + 1); setRedactions([]); setEditArea(null);
      const initialZoom = preferencesRef.current.defaultZoom;
      const initialScale = Number(initialZoom) ? Math.max(.25, Math.min(3, Number(initialZoom) / 100)) : 1;
      const initialZoomMode = Number(initialZoom) ? 'custom' : initialZoom;
      const initialPanel = readingPreferencesRef.current.initialPanel;
      if (!replacing) setReadingMode(readingPreferencesRef.current.mode);
      if (!replacing) { setRotation(0); setZoomMode(initialZoomMode); setCustomScale(initialScale); setSidebar(!touchRef.current && initialPanel !== 'closed'); if (initialPanel !== 'closed') setSideTab(initialPanel); setSearchOpen(false); setQuery(''); setResultIndex(0); setNotesOpen(false); setActiveNote(null); }
      const resumeEditing = !!context?.keepEditing && !phoneRef.current && !fileBacked;
      if (resumeEditing) editorReadingLocation.current = { revision: String(loaded.revision), page: initialPage, top: previousTab?.scrollTop || 0, left: previousTab?.scrollLeft || 0 };
      setTool(restoredTool); setLibrary(false); setWorkbench(resumeEditing ? 'edit-pdf' : null); setNoteDraft(null); setBookmarkEditingId(null);
      setOutline(null); setTextIndex([]); setSessionFailed(false); setDraftFailed(false); setPassword(null); setInfo(false);
      setLoading(false); loadingRef.current = false; taskRef.current = null;
      const tab: DocumentTab = { ...activeView.current, tool: restoredTool, key, doc: loaded, annotations: annotationRef.current, bookmarks: restoredBookmarks, page: readingState.current.page,
        dimensions: { width: view.width, height: view.height, rotation: first.rotate }, undo: undoStack.current, redo: redoStack.current,
        scrollTop: replacing ? previousTab?.scrollTop || 0 : 0, scrollLeft: replacing ? previousTab?.scrollLeft || 0 : 0,
        outline: null, textIndex: [], indexing: true, redactions: [], editArea: null, sessionFailed: false, draftFailed: false,
        ...(replacing ? {} : { annotating: false, readingMode: readingPreferencesRef.current.mode, rotation: 0, zoomMode: initialZoomMode, customScale: initialScale, sidebar: initialPanel !== 'closed', sideTab: initialPanel === 'closed' ? 'pages' as SideTab : initialPanel, tool: 'select' as Tool, searchOpen: false, query: '', resultIndex: 0, notesOpen: false, activeNote: null }) };
      tabsRef.current = replacing ? tabsRef.current.map(existing => existing.key === key ? tab : existing) : [...tabsRef.current, tab];
      publishTabs();
      if (previous) setTimeout(() => { void previous.pdf.loadingTask.destroy(); }, 200);
      if (!loaded.sample) {
        // With the library preference off, opened PDFs leave no copy behind; PDFs created in Folio are still kept.
        if ((preferencesRef.current.rememberRecent || context?.modified) && !context?.preserveHistory && !(context?.modified && nativeSource)) librarySave.current = librarySave.current.catch(() => {}).then(async () => {
          if (forgottenIds.current.has(id)) return;
          await rememberDocument({ id, name, size, pages: pdf.numPages, openedAt: Date.now(), nativeSource: nativeInput?.token || nativeSource, data: nativeSource ? undefined : new Blob([new Uint8Array(originalBytes).buffer], { type: 'application/pdf' }) });
        }).catch(() => notify('No se pudo guardar este PDF en la biblioteca.', 'error'));
        if (inspection.signed) notify('PDF firmado: modo lectura.');
        else if (!inspection.canAnnotate) notify('PDF abierto en modo lectura según sus permisos.');
      }
      return true;
    } catch (error) {
      if (request !== loadRequest.current) return;
      if (!passwordCancelled.current) {
        console.error('Folio: no se pudo abrir el PDF.', error);
        notify(`No se pudo abrir «${name}». ${errorMessage(error, 'El archivo puede estar dañado.')}`, 'error');
      }
      void taskRef.current?.destroy();
      setLoading(false); loadingRef.current = false; setPassword(null); taskRef.current = null;
      return false;
    }
  }, [notify]);
  const openDocument = useCallback((source: OpenSource, name = SAMPLE_NAME, sample = false, nativeSource?: string, context?: OpenContext) => {
    const operation = openQueue.current.catch(() => {}).then(() => loadDocument(source, name, sample, nativeSource, context));
    openQueue.current = operation;
    return operation;
  }, [loadDocument]);

  useEffect(() => {
    if (!doc?.modified || isNativePdfDocument(doc.pdf) || forgottenIds.current.has(doc.id)) return;
    void ensureDraft(doc).then(() => { if (docRef.current?.id === doc.id && docRef.current?.revision === doc.revision) setDraftFailed(false); })
      .catch(error => {
        if (docRef.current?.id !== doc.id || docRef.current?.revision !== doc.revision) return;
        // Saving a PDF over the size limit would fail too, so its message replaces the advice.
        const message = errorMessage(error, '');
        setDraftFailed(true); notify(/supera 1 GB/.test(message) ? message : `No se pudieron guardar tus cambios en ${here}. ${saveAdvice}`, 'error');
      });
  }, [doc, notify]);

  // Builds without Google's OAuth client cannot connect to Drive.
  useEffect(() => { if (isNative) void readDriveStatus().then(status => setDriveAvailable(status.available !== false)).catch(() => {}); }, []);
  // The toast joins the top layer again on each notice, above any dialog opened since.
  useLayoutEffect(() => {
    const node = toastRef.current; if (!node?.showPopover) return;
    if (node.matches(':popover-open')) node.hidePopover();
    node.showPopover();
  }, [toast]);
  useEffect(() => {
    preferencesRef.current = { rememberRecent, defaultZoom };
    try { localStorage.setItem('folio.remember', String(rememberRecent)); localStorage.setItem('folio.defaultZoom', defaultZoom); } catch { /* Settings are still usable for this session. */ }
  }, [rememberRecent, defaultZoom]);
  const systemChromeVisible = !readerChromeHidden || !doc || library || !!workbench || !!noteDraft || mobileActions || mobileTabs || pageJump || settings || help || info;
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const root = document.documentElement, resolved = theme === 'system' ? media.matches ? 'dark' : 'light' : theme;
      root.dataset.theme = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
      // 'system' keeps the next cold start following the system. Android paints the
      // status bar with the colour at the top of the current screen; iOS ignores it.
      // With the reader chrome hidden that is the reading area, so the kept strip blends in.
      if (isNative && isMobile) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_mobile_theme', { theme: theme === 'system' ? 'system' : resolved, background: getComputedStyle(root).getPropertyValue(library ? '--bg' : systemChromeVisible ? '--surface' : '--canvas').trim() })).catch(() => {});
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme, library, systemChromeVisible]);
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
  useEffect(() => {
    if (isDesktop) return;
    const preserve = () => {
      retainCurrentTab();
      for (const tab of tabsRef.current) void persistTab(tab, false).catch(() => { setSessionFailed(true); });
      // The system may end a backgrounded app; startup reopens these from the library.
      if (isNative && isMobile) try { localStorage.setItem('folio.openTabs', JSON.stringify({ ids: tabsRef.current.map(tab => tab.doc.id), active: docRef.current?.id, library: libraryRef.current })); } catch { /* Only the reopening is lost. */ }
    };
    const background = () => { if (document.visibilityState === 'hidden') preserve(); };
    window.addEventListener('beforeunload', preserve);
    window.addEventListener('pagehide', preserve);
    document.addEventListener('visibilitychange', background);
    return () => { window.removeEventListener('beforeunload', preserve); window.removeEventListener('pagehide', preserve); document.removeEventListener('visibilitychange', background); };
  }, []);
  useEffect(() => {
    if (!isNative) { setLoading(false); return; }
    let alive = true;
    const pending: NativeDocument[] = [];
    let draining = false, retry = 0;
    const drain = async () => {
      if (!alive || draining || !pending.length) return;
      if (busyRef.current || loadingRef.current && loadRequest.current > 0 || document.querySelector('dialog[open]')) {
        retry = window.setTimeout(() => { retry = 0; void drain(); }, 200); return;
      }
      draining = true;
      try {
        while (alive && pending.length) {
          if (busyRef.current || document.querySelector('dialog[open]')) break;
          const file = pending.shift()!;
          await openDocument(file, file.name, false, file.token);
        }
      } catch (error) { if (alive) notify(errorMessage(error), 'error'); }
      finally { draining = false; if (alive && pending.length) retry = window.setTimeout(() => { retry = 0; void drain(); }, 200); }
    };
    const openNativeFiles = async (files: NativeDocument[]) => {
      pending.push(...files.filter(file => !pending.some(queued => queued.token === file.token)));
      await drain();
    };
    const listenerPromises = [
      import('@tauri-apps/api/event').then(({ listen }) => listen<NativeDocument[]>('folio-open-documents', event => {
        if (!alive) return;
        setDragOver(false); dragCounter.current = 0;
        void openNativeFiles(event.payload);
      })),
      import('@tauri-apps/api/event').then(({ listen }) => listen<string>('folio-open-error', event => { if (alive) notify(event.payload, 'error'); })),
    ];
    let released = false;
    const release = () => {
      if (released) return; released = true;
      void Promise.allSettled(listenerPromises).then(results => { for (const result of results) if (result.status === 'fulfilled') { try { result.value(); } catch { /* A closing WebView can already have removed its listeners. */ } } });
    };
    void Promise.all(listenerPromises).then(async () => {
      if (!alive) return;
      // Rust can now drain queued Finder/argv opens without losing an event.
      const files = await startupDocuments();
      if (!alive) return;
      await openNativeFiles(files);
      if (alive && !files.length && isMobile) await restoreOpenTabs(() => alive);
      if (alive && loadRequest.current === 0) setLoading(false);
    }).catch(() => {
      release();
      if (alive) { if (loadRequest.current === 0) setLoading(false); notify('No se pudo preparar la apertura de documentos.', 'error'); }
    });
    return () => { alive = false; if (retry) clearTimeout(retry); release(); };
  }, [openDocument, notify]);
  useEffect(() => {
    if (!isDesktop) return;
    // The desktop app takes file drops natively (Rust opens them), so the web
    // drag events never fire: its webview events drive the same overlay.
    let alive = true;
    const isPdf = (path: string) => /\.pdf$/i.test(path);
    const listener = import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (!alive) return;
      if (payload.type === 'enter') setDragOver(payload.paths.some(isPdf));
      else if (payload.type !== 'over') setDragOver(false);
      if (payload.type !== 'drop') return;
      const rejected = payload.paths.filter(path => !isPdf(path)).length;
      if (rejected) notify('Solo se pueden abrir archivos PDF.', rejected === payload.paths.length ? 'error' : 'info');
    })).catch(() => null);
    return () => { alive = false; void listener.then(unlisten => unlisten?.()); };
  }, [notify]);
  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    const listener = import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const window = getCurrentWindow();
      return window.onCloseRequested(async event => {
        if (!alive || !tabsRef.current.length && !closingStages.current.size) return;
        event.preventDefault();
        if (editorDraftRef.current) { notify('Aplica o descarta la edición antes de cerrar Folio.'); return; }
        // A pending password request is not an operation: closing cancels it.
        if (passwordRef.current) cancelPassword();
        if (busyRef.current || loadingRef.current || document.querySelector('.workbench .operation-loading')) { notify('Espera a que termine la operación antes de cerrar.'); return; }
        // A closed Drive tab whose edit could not be prepared keeps Folio open, with its notice.
        if (closingStages.current.size) { notify('Guardando en Drive…'); if ((await Promise.all(closingStages.current)).includes(false)) return; }
        // Every tab is stored; the first one that fails is shown, so the dialog saves that document.
        retainCurrentTab();
        let failed: DocumentTab | undefined, cause: unknown;
        for (const tab of tabsRef.current) { try { await persistTab(tab); } catch (error) { if (!failed) { failed = tab; cause = error; } } }
        if (!failed) { await window.destroy().catch(() => notify('No se pudo cerrar Folio.', 'error')); return; }
        if (activeTabRef.current !== failed.key) { activateTab(failed); publishTabs(); }
        notify(errorMessage(cause), 'error'); setCloseBlocked('window');
      });
    });
    return () => { alive = false; void listener.then(unlisten => unlisten()); };
  }, [notify]);
  useEffect(() => {
    if (isDesktop) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(doc ? `${doc.name} — Folio` : 'Folio')).catch(() => {});
  }, [doc?.name]);
  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    const listener = import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const window = getCurrentWindow();
      const sync = () => void Promise.all([window.isMaximized(), window.isFullscreen()]).then(([maximized, fullscreen]) => { if (alive) setWindowState({ maximized, fullscreen }); }).catch(() => {});
      sync(); return window.onResized(sync);
    });
    return () => { alive = false; void listener.then(unlisten => unlisten()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!isDesktop || !isMac) return;
    // The macOS menu bar; its shortcuts reach it only when the page leaves them unhandled.
    let alive = true;
    const listener = import('@tauri-apps/api/event').then(({ listen }) => listen<string>('folio-menu', ({ payload }) => { if (alive) menuAction.current(payload); }));
    return () => { alive = false; void listener.then(unlisten => unlisten()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    readOutline(doc.pdf).then(data => { if (alive) setOutline(data); }).catch(() => { if (alive) setOutline([]); });
    // A restored tab keeps its complete index; only a new or interrupted one is built.
    if (isNativePdfDocument(doc.pdf) || activeView.current.textIndex.length === doc.pdf.numPages) { setIndexing(false); return () => { alive = false; }; }
    setIndexing(true);
    buildTextIndex(doc.pdf, () => alive).then(data => { if (alive) { setTextIndex(data); setIndexing(false); } }).catch(error => { if (alive) { console.error('Folio: no se pudo indexar el PDF.', error); setIndexing(false); notify('Algunas páginas no se pudieron indexar para la búsqueda.', 'error'); } });
    return () => { alive = false; };
  }, [doc, notify]);
  useEffect(() => {
    if (!doc || !isNativePdfDocument(doc.pdf)) return;
    if (!nativeSearchRequested || activeView.current.textIndex.length === doc.pdf.numPages) { setIndexing(false); return; }
    let alive = true;
    setIndexing(true);
    void (async () => {
      const text = [...activeView.current.textIndex]; // Resume an interrupted index.
      for (let number = text.length + 1; alive && number <= doc.pdf.numPages; number++) {
        const content = await (await doc.pdf.getPage(number)).getTextContent();
        text.push(pageText(content));
        if (alive && (number % 10 === 0 || number === doc.pdf.numPages)) setTextIndex([...text]);
      }
      if (alive) setIndexing(false);
    })().catch(error => { if (alive) { setIndexing(false); notify(errorMessage(error), 'error'); } });
    return () => { alive = false; };
  }, [doc, nativeSearchRequested, notify]);
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
    if (library || mobileTabs) { setLibraryLoading(true); Promise.allSettled([librarySave.current, draftSave.current]).then(() => listLibrary()).then(items => { if (alive) setRecents(items); }).catch(() => { if (alive) { setRecents([]); notify('No se pudo abrir la biblioteca local.', 'error'); } }).finally(() => { if (alive) setLibraryLoading(false); }); }
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
    const term = searchTerm(query), apply = () => { setSearchQuery(term); setResultLimit(200); };
    if (!term) { apply(); return; }
    const timer = setTimeout(apply, 250);
    return () => clearTimeout(timer);
  }, [query]);
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
  // Saving, syncing, printing and applying edits show a capsule while they run.
  const [activity, setActivity] = useState<ActivityStep | null>(null);
  const [activityDone, setActivityDone] = useState<ActivityStep | null>(null);
  const activityLabel = busy === 'download' ? doc?.drive ? driveMessage || 'Guardando en Google Drive…' : savesInPlace ? 'Guardando el PDF…' : isNative ? 'Guardando una copia…' : 'Preparando el PDF…'
    : busy === 'print' ? 'Preparando la impresión…' : busy === 'edit' ? 'Aplicando los cambios…' : '';
  useEffect(() => {
    if (activityLabel) {
      if (!activityRun.current) { activityRun.current = { started: performance.now() }; setActivityDone(null); setActivity({ id: Date.now(), label: activityLabel }); }
      else setActivity(current => current && { ...current, label: activityLabel });
      return;
    }
    const run = activityRun.current; if (!run) return;
    activityRun.current = null; setActivity(null);
    // Quick work keeps its usual notice; longer work shows its outcome in the capsule.
    if (run.result && performance.now() - run.started >= 260) setActivityDone({ id: Date.now(), label: run.result.message });
    else if (run.result) notify(run.result.message, run.result.kind);
  }, [activityLabel]);
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
  useEffect(() => {
    const root = viewer.current;
    if (!touchLayout || !doc || !root) return;
    let origin: { id: number; x: number; y: number; top: number; left: number; at: number } | null = null;
    const doubleTapWindow = 350;
    let timer = 0, lastTap = 0;
    const cancel = () => { origin = null; if (timer) clearTimeout(timer); timer = 0; };
    const down = (event: PointerEvent) => {
      if (timer) clearTimeout(timer);
      timer = 0;
      if (event.pointerType !== 'touch' || !event.isPrimary || tool !== 'select' || busy || loading || mobileAnnotating || searchOpen || library || sidebar || notesOpen || mobileTabs) { origin = null; return; }
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('.page-content') || target.closest('button,a,input,textarea,[role="button"],.highlight-annotation') || !window.getSelection()?.isCollapsed) { origin = null; return; }
      if (Date.now() - lastTap < doubleTapWindow) { origin = null; lastTap = 0; return; }
      origin = { id: event.pointerId, x: event.clientX, y: event.clientY, top: root.scrollTop, left: root.scrollLeft, at: Date.now() };
    };
    const up = (event: PointerEvent) => {
      const start = origin; origin = null;
      if (!start || event.pointerId !== start.id || Date.now() - start.at > 250 ||
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6 ||
          Math.abs(root.scrollTop - start.top) > 3 || Math.abs(root.scrollLeft - start.left) > 3 ||
          !window.getSelection()?.isCollapsed || document.querySelector('dialog[open],.document-switcher,.highlight-annotation-menu,.highlight-color-palette,.text-selection-menu')) return;
      lastTap = Date.now();
      timer = window.setTimeout(() => { timer = 0; if (window.getSelection()?.isCollapsed && !document.querySelector('dialog[open],.document-switcher,.highlight-annotation-menu,.highlight-color-palette,.text-selection-menu')) setReaderChromeHidden(value => !value); }, doubleTapWindow);
    };
    const selection = () => { if (!window.getSelection()?.isCollapsed) cancel(); };
    const action = () => { cancel(); setReaderChromeHidden(false); };
    root.addEventListener('pointerdown', down, true); root.addEventListener('pointerup', up, true);
    root.addEventListener('pointercancel', cancel, true); window.addEventListener('folio:pinch-start', cancel);
    document.addEventListener('selectionchange', selection);
    window.addEventListener('folio:reader-interaction', action);
    return () => { cancel(); root.removeEventListener('pointerdown', down, true); root.removeEventListener('pointerup', up, true); root.removeEventListener('pointercancel', cancel, true); window.removeEventListener('folio:pinch-start', cancel); window.removeEventListener('folio:reader-interaction', action); document.removeEventListener('selectionchange', selection); };
  }, [touchLayout, doc, tool, busy, loading, mobileAnnotating, searchOpen, library, sidebar, notesOpen, mobileTabs]);
  useEffect(() => {
    if (!doc || !viewer.current || !phone && workbench === 'edit-pdf') return;
    const root = viewer.current;
    const visible = new Set<Element>();
    let frame = 0;
    const update = () => {
      frame = 0;
      if (editorRestorePending.current || smoothJump.current) return;
      const bounds = root.getBoundingClientRect();
      const candidates = [...visible].map(node => {
        const box = node.getBoundingClientRect();
        return { node, height: Math.max(0, Math.min(bounds.bottom, box.bottom) - Math.max(bounds.top, box.top)), distance: Math.abs(box.top - bounds.top) };
      }).filter(item => item.height > 0).sort((a, b) => b.height - a.height || a.distance - b.distance);
      if (candidates[0]) setPage(Number((candidates[0].node as HTMLElement).dataset.pageNumber));
      const centerX = bounds.left + root.clientWidth / 2, centerY = bounds.top + root.clientHeight / 2;
      let anchor: { node: HTMLElement; box: DOMRect; gap: number } | null = null;
      for (const node of visible) {
        const box = node.querySelector('.pdf-page')?.getBoundingClientRect(), gap = box ? Math.max(box.top - centerY, centerY - box.bottom, 0) : Infinity;
        if (box?.height && (!anchor || gap < anchor.gap)) anchor = { node: node as HTMLElement, box, gap };
      }
      // A resize not yet applied to the zoom would anchor the wrong point.
      if (anchor && docRef.current && root.clientWidth === fittedWidth.current) readingAnchor.current = { id: docRef.current.id, page: Number(anchor.node.dataset.pageNumber), x: (centerX - anchor.box.left) / anchor.box.width, y: (centerY - anchor.box.top) / anchor.box.height, rotation: activeView.current.rotation };
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    trackPage.current = schedule;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) { if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target); }
      schedule();
    }, { root, threshold: [0, .25, .5, .75, 1] });
    root.querySelectorAll('.pdf-page-wrap').forEach(node => observer.observe(node));
    root.addEventListener('scroll', schedule, { passive: true });
    return () => { observer.disconnect(); root.removeEventListener('scroll', schedule); if (frame) cancelAnimationFrame(frame); if (trackPage.current === schedule) trackPage.current = () => {}; };
  }, [doc, readingMode, readingMode === 'single' ? page : null, workbench, phone]);

  const scale = useMemo(() => {
    const rotated = rotation % 180 !== 0;
    const w = rotated ? dimensions.height : dimensions.width;
    const h = rotated ? dimensions.width : dimensions.height;
    // A phone held sideways fits the width: fitting the page height leaves it unreadable.
    if (zoomMode === 'width' || zoomMode === 'page' && phone && viewportSize.width > viewportSize.height) return Math.max(.25, Math.min(3, (viewportSize.width - (phone ? 16 : viewportSize.width < 600 ? 30 : 100)) / w));
    if (zoomMode === 'page') return Math.max(.25, Math.min(2, (viewportSize.width - (phone ? 16 : 54)) / w, (viewportSize.height - (phone ? 160 : 76)) / h));
    return customScale;
  }, [zoomMode, customScale, viewportSize, dimensions, rotation, phone]);
  currentScale.current = scale;

  useLayoutEffect(() => {
    const pointer = wheelAnchor.current, reading = readingAnchor.current, root = viewer.current;
    wheelAnchor.current = null;
    if (!root) return;
    // Wheel and pinch keep the point under the fingers; buttons, keys, rotation and
    // size changes keep the page point that was at the centre of the reader.
    const anchor = pointer || reading && { ...reading, pointerX: root.clientWidth / 2, pointerY: root.clientHeight / 2 };
    if (!anchor || anchor.id !== doc?.id) return;
    let { x, y } = anchor;
    if (!pointer && reading) for (let turn = (rotation - reading.rotation + 360) % 360; turn > 0; turn -= 90) [x, y] = [1 - y, x];
    const node = root.querySelector<HTMLElement>(`[data-page-number="${anchor.page}"] .pdf-page`);
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    const frame = root.getBoundingClientRect();
    root.scrollLeft += bounds.left + bounds.width * x - frame.left - anchor.pointerX;
    root.scrollTop += bounds.top + bounds.height * y - frame.top - anchor.pointerY;
  }, [scale, rotation, doc?.id]);

  useEffect(() => {
    const root = viewer.current;
    const shell = document;
    if (!root) return;
    // The scale is kept unrounded so many small trackpad steps add up.
    const zoomAt = (value: number, point: { clientX: number; clientY: number; target: EventTarget | null }) => {
      const loaded = docRef.current, next = Math.max(.25, Math.min(3, value));
      if (!loaded || next === currentScale.current) return;
      const node = point.target instanceof Element ? point.target.closest<HTMLElement>('.pdf-page') : null;
      if (node) {
        const bounds = node.getBoundingClientRect();
        const frame = root.getBoundingClientRect();
        wheelAnchor.current = { id: loaded.id, page: Number(node.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber),
          x: (point.clientX - bounds.left) / bounds.width, y: (point.clientY - bounds.top) / bounds.height,
          pointerX: point.clientX - frame.left, pointerY: point.clientY - frame.top };
      }
      currentScale.current = next;
      setCustomScale(next); setZoomMode('custom');
    };
    let gestureScale = 0;
    const onWheel = (event: Event) => {
      const wheel = event as WheelEvent;
      if (!wheel.ctrlKey && !(isMac && wheel.metaKey)) return;
      wheel.preventDefault();
      if (gestureScale || !wheel.deltaY) return;
      // A trackpad pinch arrives as small pixel deltas and follows the fingers
      // (Chromium's convention); wheel notches use the configured speed.
      const pinch = wheel.deltaMode === 0 && Math.abs(wheel.deltaY) < 50;
      const delta = wheel.deltaY * (wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? root.clientHeight : 1);
      zoomAt(currentScale.current * Math.exp(pinch ? -delta / 100 : -Math.max(-200, Math.min(200, delta)) * .001 * readingPreferencesRef.current.wheelSpeed / 100), wheel);
    };
    // WebKit on macOS reports trackpad pinches as gesture events, not ctrl+wheel.
    // Touch layouts handle two-finger pinches with touch events instead.
    const onGesture = (event: Event) => {
      const gesture = event as Event & { scale: number; clientX: number; clientY: number };
      event.preventDefault();
      if (event.type === 'gesturestart') gestureScale = currentScale.current;
      else if (event.type === 'gestureend') gestureScale = 0;
      else if (gestureScale && docRef.current) zoomAt(gestureScale * gesture.scale, gesture);
    };
    const gestures = touchLayout ? [] : ['gesturestart', 'gesturechange', 'gestureend'];
    shell.addEventListener('wheel', onWheel, { passive: false });
    for (const type of gestures) shell.addEventListener(type, onGesture, { passive: false });
    return () => { shell.removeEventListener('wheel', onWheel); for (const type of gestures) shell.removeEventListener(type, onGesture); };
  }, [touchLayout]);

  // Two fingers pan, or zoom once their spacing clearly changes, on any touch
  // screen: with Lápiz or Goma a single finger draws.
  useEffect(() => {
    const root = viewer.current;
    if (!root || library) return;
    type Pinch = { stack: HTMLElement; distance: number; scale: number; next: number; pinched: boolean; originX: number; originY: number; centerX: number; centerY: number; pointerX: number; pointerY: number; page: number; x: number; y: number; id: string; frame: number };
    let gesture: Pinch | null = null;
    const geometry = (event: TouchEvent) => {
      const a = event.touches[0], b = event.touches[1];
      return { distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    };
    const clearPreview = (active: Pinch) => {
      cancelAnimationFrame(active.frame); active.stack.style.removeProperty('transform'); active.stack.style.removeProperty('transform-origin');
      root.classList.remove('pinching');
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2 || gesture || !docRef.current || busyRef.current || loadingRef.current || document.querySelector('dialog[open], .mobile-drawer')) return;
      const center = geometry(event), stack = root.querySelector<HTMLElement>('.pdf-stack');
      const node = document.elementFromPoint(center.x, center.y)?.closest<HTMLElement>('.pdf-page') || root.querySelector<HTMLElement>(`[data-page-number="${readingState.current.page}"] .pdf-page`);
      if (!stack || !node) return;
      event.preventDefault(); document.getSelection()?.removeAllRanges(); window.dispatchEvent(new Event('folio:pinch-start'));
      const bounds = node.getBoundingClientRect(), stackBounds = stack.getBoundingClientRect();
      gesture = { stack, distance: center.distance, scale: currentScale.current, next: currentScale.current, pinched: false, originX: center.x - stackBounds.left, originY: center.y - stackBounds.top,
        centerX: center.x, centerY: center.y, pointerX: center.x, pointerY: center.y, page: Number(node.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber),
        x: (center.x - bounds.left) / bounds.width, y: (center.y - bounds.top) / bounds.height, id: docRef.current.id, frame: 0 };
      stack.style.transformOrigin = `${gesture.originX}px ${gesture.originY}px`; root.classList.add('pinching');
    };
    const move = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 2) return;
      event.preventDefault(); const center = geometry(event), active = gesture;
      // Fingers drift while scrolling: only a clear change of spacing starts the zoom, which then follows the whole gesture.
      if (!active.pinched && Math.abs(center.distance - active.distance) > Math.max(6, active.distance * .08)) active.pinched = true;
      if (active.pinched) active.next = Math.max(.25, Math.min(3, active.scale * center.distance / active.distance));
      active.pointerX = center.x; active.pointerY = center.y;
      if (active.frame) cancelAnimationFrame(active.frame);
      active.frame = requestAnimationFrame(() => { active.stack.style.transform = `translate(${active.pointerX - active.centerX}px, ${active.pointerY - active.centerY}px) scale(${active.next / active.scale})`; });
    };
    const finish = (event: TouchEvent) => {
      if (!gesture || event.touches.length >= 2) return;
      event.preventDefault(); const active = gesture; gesture = null; clearPreview(active);
      if (docRef.current?.id !== active.id) return;
      const frame = root.getBoundingClientRect(), next = Math.round(active.next * 1000) / 1000;
      // A pan keeps the zoom mode, so Ajustar página still refits.
      if (!active.pinched || Math.abs(next - currentScale.current) < .0005 && activeView.current.zoomMode === 'custom') {
        const node = root.querySelector<HTMLElement>(`[data-page-number="${active.page}"] .pdf-page`), bounds = node?.getBoundingClientRect();
        if (bounds) { root.scrollLeft += bounds.left + bounds.width * active.x - active.pointerX; root.scrollTop += bounds.top + bounds.height * active.y - active.pointerY; }
        return;
      }
      wheelAnchor.current = { id: active.id, page: active.page, x: active.x, y: active.y, pointerX: active.pointerX - frame.left, pointerY: active.pointerY - frame.top };
      currentScale.current = next; setCustomScale(next); setZoomMode('custom');
    };
    const cancel = () => { if (gesture) { clearPreview(gesture); gesture = null; } };
    const background = () => { if (document.visibilityState === 'hidden') cancel(); };
    root.addEventListener('touchstart', start, { passive: false }); root.addEventListener('touchmove', move, { passive: false }); root.addEventListener('touchend', finish, { passive: false }); root.addEventListener('touchcancel', cancel);
    window.addEventListener('blur', cancel); window.addEventListener('pagehide', cancel); document.addEventListener('visibilitychange', background);
    return () => { cancel(); root.removeEventListener('touchstart', start); root.removeEventListener('touchmove', move); root.removeEventListener('touchend', finish); root.removeEventListener('touchcancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('pagehide', cancel); document.removeEventListener('visibilitychange', background); };
  }, [library]);

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
  // Every occurrence is counted; the first 1000 are navigable and listed in steps.
  const { results, total: occurrences } = useMemo(() => searchText(textIndex, searchQuery, 1000), [textIndex, searchQuery]);
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
    smoothJump.current = 0;
    if (node) {
      const distance = node.getBoundingClientRect().top - root.getBoundingClientRect().top - readingInset();
      const behavior = smooth && readingPreferencesRef.current.smoothScroll && Math.abs(distance) < root.clientHeight * 4 && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant';
      // While the animation passes other pages, the counter keeps the target and
      // «Volver a p. N» stays; tracking resumes when it ends or the user scrolls.
      if (behavior === 'smooth') {
        const jump = smoothJump.current = ++smoothJumps.current, events = ['scrollend', 'wheel', 'touchstart', 'pointerdown', 'keydown'];
        const end = () => {
          clearTimeout(timer); for (const type of events) root.removeEventListener(type, end);
          if (smoothJump.current === jump) { smoothJump.current = 0; trackPage.current(); }
        };
        for (const type of events) root.addEventListener(type, end, { passive: true });
        const timer = window.setTimeout(end, 1000);
      }
      root.scrollTo({ top: root.scrollTop + distance, behavior });
    }
  }, []);

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

  useEffect(() => {
    const root = viewer.current;
    if (!touchLayout || !doc || readingMode !== 'single' || tool !== 'select' || mobileAnnotating || library || sidebar || notesOpen || busy || loading) return;
    let start: { x: number; y: number; at: number } | null = null;
    const down = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.touches.length !== 1 || root!.scrollWidth > root!.clientWidth + 4 || target?.closest('button,a,input,.highlight-annotation') || !window.getSelection()?.isCollapsed) { start = null; return; }
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY, at: Date.now() };
    };
    const end = (event: TouchEvent) => {
      const origin = start; start = null;
      if (!origin || !event.changedTouches[0] || !window.getSelection()?.isCollapsed) return;
      const dx = event.changedTouches[0].clientX - origin.x, dy = event.changedTouches[0].clientY - origin.y;
      if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.7 && Date.now() - origin.at < 600) goToPage(readingState.current.page + (dx < 0 ? 1 : -1), false);
    };
    const cancel = () => { start = null; };
    root?.addEventListener('touchstart', down, { passive: true }); root?.addEventListener('touchend', end, { passive: true }); root?.addEventListener('touchcancel', cancel);
    return () => { root?.removeEventListener('touchstart', down); root?.removeEventListener('touchend', end); root?.removeEventListener('touchcancel', cancel); };
  }, [touchLayout, doc, readingMode, tool, mobileAnnotating, library, sidebar, notesOpen, busy, loading, goToPage]);

  useEffect(() => {
    if (!doc) return;
    const restored = restoreScroll.current;
    restoreScroll.current = null;
    const frame = requestAnimationFrame(() => {
      scrollRestoreFrame.current = null;
      if (restored?.key === activeTabRef.current && viewer.current) viewer.current.scrollTo({ top: restored.top, left: restored.left, behavior: 'instant' });
      else goToPage(doc.initialPage, false);
    });
    scrollRestoreFrame.current = frame;
    return () => { cancelAnimationFrame(frame); if (scrollRestoreFrame.current === frame) scrollRestoreFrame.current = null; };
  }, [doc, goToPage]);

  // At most 50 steps, 20 of them PDF snapshots, within a memory budget. Trimming
  // starts at the oldest step: earlier steps never outlive a later snapshot.
  function trimHistory(stack: History[]) {
    const budget = (phoneRef.current ? 40 : 200) * 1024 * 1024, snapshots = () => stack.filter(item => item.bytes);
    while (stack.length > 50 || snapshots().length > 20 || snapshots().reduce((total, item) => total + item.bytes!.length, 0) > budget) stack.shift();
  }
  const annotationGesture = useRef<string | undefined>(undefined);
  const commitAnnotations = useCallback((next: Annotation[], gesture?: string) => {
    if (!gesture || annotationGesture.current !== gesture) undoStack.current.push({ annotations: annotationRef.current });
    annotationGesture.current = gesture;
    trimHistory(undoStack.current);
    redoStack.current = [];
    if (docRef.current) unreadSessions.current.delete(docRef.current.id);
    annotationRef.current = next; setAnnotations(next); setHistoryTick(v => v + 1);
  }, []);
  const undo = useCallback(() => {
    if (editorDraftRef.current || busyRef.current || loadingRef.current) return;
    const previous = undoStack.current.pop();
    if (!previous) return;
    annotationGesture.current = undefined;
    redoStack.current.push(previous.bytes ? snapshot() : { annotations: annotationRef.current, bookmarks: readingState.current.bookmarks });
    trimHistory(redoStack.current);
    if (previous.bytes) { void restoreHistory(previous, undoStack.current, redoStack.current); return; }
    annotationRef.current = previous.annotations;
    if (previous.bookmarks) { readingState.current.bookmarks = previous.bookmarks; setBookmarks(previous.bookmarks); }
    setAnnotations(previous.annotations); setHistoryTick(v => v + 1);
  }, [openDocument]);
  const redo = useCallback(() => {
    if (editorDraftRef.current || busyRef.current || loadingRef.current) return;
    const next = redoStack.current.pop();
    if (!next) return;
    annotationGesture.current = undefined;
    undoStack.current.push(next.bytes ? snapshot() : { annotations: annotationRef.current, bookmarks: readingState.current.bookmarks });
    trimHistory(undoStack.current);
    if (next.bytes) { void restoreHistory(next, redoStack.current, undoStack.current); return; }
    annotationRef.current = next.annotations;
    if (next.bookmarks) { readingState.current.bookmarks = next.bookmarks; setBookmarks(next.bookmarks); }
    setAnnotations(next.annotations); setHistoryTick(v => v + 1);
  }, [openDocument]);
  const commitBookmarks = useCallback((next: BookmarkNode[], gesture?: string) => {
    if (JSON.stringify(next) === JSON.stringify(readingState.current.bookmarks)) return;
    if (!gesture || annotationGesture.current !== gesture) undoStack.current.push({ annotations: annotationRef.current, bookmarks: readingState.current.bookmarks });
    annotationGesture.current = gesture;
    trimHistory(undoStack.current);
    redoStack.current = [];
    if (docRef.current) unreadSessions.current.delete(docRef.current.id);
    readingState.current.bookmarks = next; setBookmarks(next); setHistoryTick(value => value + 1);
  }, []);
  const changeZoom = useCallback((delta: number) => { setCustomScale(Math.max(.25, Math.min(3, Math.round((scale + delta) * 100) / 100))); setZoomMode('custom'); }, [scale]);
  const toggleBookmark = useCallback(() => {
    if (!docRef.current || busyRef.current || loadingRef.current) return;
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

  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // ⌃⌘F is the menu's Pantalla completa on macOS; leave it to toggleFullScreen:.
      if (isMac && e.metaKey && e.ctrlKey && e.key.toLowerCase() === 'f') return;
      const editing = (e.target as HTMLElement).closest('input,textarea,select,[contenteditable]');
      const modal = [...document.querySelectorAll('dialog[open]')].at(-1);
      if (modal) {
        const key = (e.ctrlKey || e.metaKey) && e.key.toLowerCase();
        if (!key || !['s', 'p', 'w', 'o', 'f'].includes(key)) return;
        // Unhandled, ⌘W would reach the window menu and close Folio: it closes the dialog in front.
        e.preventDefault(); if (key === 'w') modal.dispatchEvent(new Event('cancel', { cancelable: true }));
        return;
      }
      if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) {
        const command = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
        if (command && !editing && ['z', 'y'].includes(key)) {
          e.preventDefault(); if (!editorDraftRef.current && !busyRef.current && !loadingRef.current) { if (key === 'y' || e.shiftKey) redo(); else undo(); }
        } else if (command && e.key === 'Tab') {
          e.preventDefault(); const all = tabsRef.current, index = all.findIndex(tab => tab.key === activeTabRef.current);
          if (!editorDraftRef.current && all.length > 1) void switchTab(all[(index + (e.shiftKey ? all.length - 1 : 1)) % all.length].key);
        } else if (command && key === 'w') { e.preventDefault(); if (!editorDraftRef.current && activeTabRef.current) void closeTab(activeTabRef.current); }
        else if (command && key === 's') { e.preventDefault(); void download({ keepEditing: true, copy: isNative && e.shiftKey }); }
        else if (command && ['p', 'o', 'f'].includes(key)) e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        e.preventDefault(); const all = tabsRef.current, index = all.findIndex(tab => tab.key === activeTabRef.current);
        if (all.length > 1) void switchTab(all[(index + (e.shiftKey ? all.length - 1 : 1)) % all.length].key);
        return;
      }
      if (isMac && e.metaKey && ((e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) || (e.shiftKey && ['[', ']', '{', '}'].includes(e.key)))) {
        e.preventDefault(); const all = tabsRef.current, index = all.findIndex(tab => tab.key === activeTabRef.current);
        const previous = ['ArrowLeft', '[', '{'].includes(e.key);
        if (all.length > 1) void switchTab(all[(index + (previous ? all.length - 1 : 1)) % all.length].key);
        return;
      }
      // Without a document, ⌘W is left to the window menu.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && activeTabRef.current) { e.preventDefault(); void closeTab(activeTabRef.current); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); if (!busyRef.current) void chooseFile(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); if (library) document.querySelector<HTMLInputElement>('.document-library-search input')?.focus(); else if (docRef.current) openSearch(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); void printDocument(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void download({ copy: isNative && e.shiftKey }); return; }
      if (e.key === 'F3' && (!editing || e.target === searchInput.current) && !busyRef.current && !loadingRef.current && !library && searchOpen && results.length) { e.preventDefault(); const visited = visitedSearch.current === `${activeTabRef.current}\0${searchQuery}`; goToResult(visited ? resultIndex + (e.shiftKey ? -1 : 1) : resultIndex); return; }
      if (editing) return;
      if (busyRef.current || loadingRef.current) return;
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if ((e.ctrlKey || e.metaKey) && ['+', '=', '-'].includes(e.key)) { e.preventDefault(); changeZoom(e.key === '-' ? -.1 : .1); }
      else if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setCustomScale(1); setZoomMode('custom'); }
      else if (e.ctrlKey || e.metaKey || e.altKey) return;
      else if (library) return;
      // A zoomed page that overflows sideways scrolls with ← and →; PageUp/PageDown still turn pages.
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && viewer.current && viewer.current.scrollWidth > viewer.current.clientWidth + 4) { e.preventDefault(); viewer.current.scrollBy({ left: e.key === 'ArrowRight' ? 40 : -40 }); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goToPage(page + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goToPage(page - 1); }
      else if (e.key.toLowerCase() === 'h') activateHighlight();
      else if (e.key.toLowerCase() === 'n' && docRef.current?.canAnnotate) setTool('note');
      else if (e.key.toLowerCase() === 'd' && docRef.current?.canAnnotate) { setMobileAnnotating(true); setTool('draw'); }
      else if (e.key.toLowerCase() === 'v') setTool('select');
      else if (e.key === 'Escape') { setReaderChromeHidden(false); setMobileAnnotating(false); setTool('select'); if (searchOpen) closeSearch(); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [page, library, goToPage, undo, redo, changeZoom, searchOpen, searchQuery, results, resultIndex]);

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
  // Reopens the documents that were open when the system ended the app in the background.
  async function restoreOpenTabs(alive: () => boolean) {
    let saved: { ids?: string[]; active?: string; library?: boolean } | null;
    try { saved = JSON.parse(preference('folio.openTabs', 'null')); } catch { return; }
    const { ids = [], active, library: showLibrary } = saved || {};
    if (!ids.length) return;
    const items = await listLibrary().catch(() => [] as RecentDocument[]);
    for (const id of ids) { const recent = items.find(item => item.id === id); if (recent && alive()) await reopenRecent(recent); }
    if (!alive() || !tabsRef.current.length) return;
    const tab = tabsRef.current.find(item => item.doc.id === active);
    if (tab && tab.key !== activeTabRef.current) await switchTab(tab.key);
    if (showLibrary) setLibrary(true);
  }
  // A Drive PDF in Recientes may have been saved from another device since this
  // copy was downloaded. Without local work pending, ask Drive for its current
  // revision; the download is skipped when this copy is still the latest.
  async function latestDriveRevision(item: { name: string; size: number }, binding: DriveBinding | null | undefined, unsaved: boolean) {
    if (!isNative || !driveAvailable || !binding || unsaved) return null;
    const status = await readDriveStatus().catch(() => null);
    if (!status?.account || status.account.id !== binding.account || status.pending.some(pending => pending.binding === binding.binding)) return null;
    setDriveRefresh({ name: item.name, phase: 'connect', done: 0, total: item.size, rate: 0, at: performance.now() });
    try {
      const file = await driveOpen(binding.fileId, false, progress => setDriveRefresh(current => current && advance(current, progress)));
      setDriveRefresh(current => current && { ...current, phase: 'open' });
      return { file, replaced: file.baseChecksum !== binding.baseChecksum };
    } catch {
      setDriveRefresh(null);
      notify('No se pudo comprobar Google Drive. Se abrió la copia de este dispositivo, que puede no tener los últimos cambios.');
      return null;
    }
  }
  const sessionUnsaved = async (id: string) => {
    const session = await readSession(id).catch(() => null);
    return !!session?.annotations.length && (session.nativeSavedAnnotations === undefined || annotationFingerprint(session.annotations) !== session.nativeSavedAnnotations);
  };
  // Opens Drive's newer revision in place of the older one, which had no local work.
  async function openLatestRevision(latest: { file: DriveOpened; replaced: boolean }, previousId: string, previousTab?: string) {
    try { await openDriveDocument(latest.file); } finally { setDriveRefresh(null); }
    const opened = tabsRef.current.some(tab => tab.doc.drive?.fileId === latest.file.fileId && tab.doc.drive.baseChecksum === latest.file.baseChecksum);
    if (!opened || !latest.replaced) return;
    if (previousTab && tabsRef.current.some(tab => tab.key === previousTab)) await closeTab(previousTab);
    await forgetDocument(previousId).catch(() => {}); setRecents(items => items.filter(item => item.id !== previousId));
    notify('Se abrió la versión más reciente guardada en Google Drive.');
  }
  async function reopenRecent(recent: RecentDocument) {
    try {
      const existing = tabsRef.current.find(tab => tab.doc.id === recent.id);
      if (existing) {
        // An open tab of a Drive PDF may also be behind another device's save.
        retainCurrentTab();
        const tab = tabsRef.current.find(item => item.key === existing.key) || existing;
        const dirty = tab.doc.modified || annotationFingerprint(tab.annotations) !== tab.doc.savedAnnotations;
        const latest = await latestDriveRevision(recent, tab.doc.drive, dirty);
        if (latest?.replaced) { await openLatestRevision(latest, recent.id, existing.key); return; }
        setDriveRefresh(null);
        setLibrary(false); if (existing.key !== activeTabRef.current) requestAnimationFrame(() => void switchTab(existing.key)); return;
      }
      if (isNative) {
        let source: NativeDocument, recoveredDraft = false;
        try { source = recent.nativeSource ? { token: recent.nativeSource, name: recent.name, size: recent.size } : await readLibrarySource(recent.id); }
        catch (error) { const draft = await nativeDraftDocument(recent.id, recent.name); if (!draft) throw error; source = draft; recoveredDraft = true; }
        // The native catalog has no source tokens: the opened copy tells whether it came from Drive.
        if (!recent.draft && !recoveredDraft) {
          const latest = await latestDriveRevision(recent, await driveLookup(source.token).catch(() => null), await sessionUnsaved(recent.id));
          if (latest) { await openLatestRevision(latest, recent.id); return; }
        }
        await openDocument(source, recent.name, false, source.token, recent.draft || recoveredDraft ? { id: recent.id, modified: true, draftSource: true } : undefined);
      }
      else if (recent.draft) {
        const draft = await readDraft(recent.id) || await readLibraryData(recent.id);
        if (!draft) throw new Error('No se pudieron recuperar los cambios sin guardar.');
        await openDocument(draft, recent.name, false, undefined, { id: recent.id, modified: true, draftSource: true });
      }
      else {
        const data = await readLibraryData(recent.id);
        if (data) await openDocument(data, recent.name);
        else notify('Este PDF ya no está en la biblioteca. Vuelve a abrirlo; tus cambios se conservan.', 'error');
      }
    } catch { notify('No se pudo reabrir el archivo. Ábrelo de nuevo con Abrir PDF.', 'error'); }
  }
  function onAnnotate(annotation: AnnotationDraft | AnnotationDraft[]) {
    if (!doc?.canAnnotate || busyRef.current || loadingRef.current) return;
    if (Array.isArray(annotation)) {
      // A selection spanning several pages is one action in the document history.
      // Highlights over a highlight of the same color join it.
      commitAnnotations(addHighlights(annotationRef.current, annotation.map(item => ({ ...item, id: uid(), created: Date.now() }))));
      return;
    }
    if (annotation.kind === 'note') { noteOrigin.current = 'document'; setNoteDraft(annotation); setNoteText(''); return; }
    commitAnnotations(addHighlights(annotationRef.current, [{ ...annotation, id: uid(), created: Date.now() }]));
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
    const keepEditing = workbenchRef.current === 'edit-pdf';
    setBusy('edit');
    try {
      if (!await openDocument(value.bytes, current.name, current.sample, current.nativeSource, { id: current.id, draftSource: current.draftSource, password: value.password,
        modified: true, useSession: false, preserveHistory: true, page: value.page, bookmarks: value.bookmarks })) {
        // The current revision stays open, so the step remains available.
        to.pop(); from.push(value); notify(from === redoStack.current ? 'No se pudo rehacer el cambio.' : 'No se pudo deshacer el cambio.', 'error'); return;
      }
      annotationRef.current = value.annotations; setAnnotations(value.annotations);
      if (keepEditing) setWorkbench('edit-pdf');
    } finally { setBusy(null); setHistoryTick(v => v + 1); }
  }
  async function applyOperation(operation: Operation, signal?: AbortSignal, context?: { keepEditing: boolean; page: number }) {
    const current = docRef.current; if (!current) return;
    if (isNativePdfDocument(current.pdf)) throw new Error('Esta herramienta no está disponible para PDF tan grandes.');
    const before = snapshot(); setBusy('edit');
    try {
      const source = current.canAnnotate ? await exportAnnotated(current.bytes, annotationRef.current, current.password) : current.bytes;
      signal?.throwIfAborted();
      const output = await processPdf(source, operation, current.password, signal);
      signal?.throwIfAborted();
      // An optimized PDF is left as it is: no reload, no undo step.
      if (operation.operation === 'compress' && output.length >= source.length) { notify('El PDF ya está optimizado; no se redujo su tamaño.'); setWorkbench(null); return; }
      const bookmarkPages = operation.operation === 'pages' ? remapBookmarks(before.bookmarks || [], operation.plan) : before.bookmarks;
      const password = operation.operation === 'protect' ? operation.ownerPassword : operation.operation === 'unprotect' ? '' : current.password;
      const opened = await openDocument(output, current.name, current.sample, current.nativeSource, { id: current.id, draftSource: current.draftSource, password, modified: true,
        useSession: false, preserveHistory: true, page: context?.keepEditing ? context.page : before.page, bookmarks: bookmarkPages });
      if (!opened) throw new Error('No se pudo cargar el resultado de la operación.');
      undoStack.current.push(before); trimHistory(undoStack.current);
      if (undoStack.current.at(-1) !== before) notify('Este cambio no se podrá deshacer porque el documento es demasiado grande.');
      redoStack.current = []; setHistoryTick(v => v + 1); setWorkbench(context?.keepEditing ? 'edit-pdf' : null); setTool('select');
      if (operation.operation === 'compress') notify(`PDF reducido de ${formatSize(source.length)} a ${formatSize(output.length)}.`, 'success');
    } finally { setBusy(null); }
  }
  async function currentBytes() {
    const current = docRef.current; if (!current) throw new Error('No hay documento abierto.');
    if (isNativePdfDocument(current.pdf)) throw new Error('Usa Guardar una copia para guardar este PDF.');
    return current.canAnnotate ? exportAnnotated(current.bytes, annotationRef.current, current.password, undefined, !!current.drive) : current.bytes;
  }
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
      undoStack.current.push(before); trimHistory(undoStack.current); redoStack.current = []; setHistoryTick(v => v + 1); setWorkbench(null);
      if (undoStack.current.at(-1) !== before) notify('Este cambio no se podrá deshacer porque el documento es demasiado grande.');
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
  async function presentFileBacked(current: LoadedDocument, action: 'save' | 'share' | 'print', anchor?: Anchor) {
    if (current.nativeLegacySession) for (let number = 1; number <= current.pdf.numPages; number++) await nativePdfPageAnnotations(current.pdf, number);
    if (current.nativeLegacySession) throw new Error('No se pudieron recuperar todas las anotaciones anteriores. La copia no se guardó.');
    const removed = (current.nativeOriginalRefs || []).filter(ref => !annotationRef.current.some(annotation => annotation.nativeSourceRef === ref));
    return presentNativePdf(current.nativeSource!, action === 'save' ? copyName(current.name) : current.name, action, annotationRef.current, removed, anchor);
  }
  // Mobile keeps private copies of opened PDFs; those of forgotten entries are deleted.
  const pruneCopies = () => { void prunePrivateCopies(tabsRef.current.flatMap(tab => tab.doc.nativeSource ? [tab.doc.nativeSource] : [])).catch(() => {}); };
  // A leftover entry is harmless, so a failure here never reports the save as failed.
  async function retireLibraryEntry(id: string) {
    forgottenIds.current.add(id);
    await librarySave.current.catch(() => {}); await forgetDocument(id).catch(() => {}); pruneCopies();
  }
  async function openDriveDocument(file: DriveOpened, pending = false) {
    const existing = !pending && tabsRef.current.find(tab => tab.doc.drive?.account === file.account && tab.doc.drive.fileId === file.fileId && tab.doc.drive.baseChecksum === file.baseChecksum);
    if (existing) {
      await switchTab(existing.key); setLibrary(false); setDriveLibrary(false);
      notify('Este PDF ya está abierto. Ciérralo si quieres cargar otra versión.'); return;
    }
    if (await openDocument(file.document, file.document.name, false, file.document.token, { drive: file, modified: pending, useSession: !pending })) setDriveLibrary(false);
  }
  // A pending edit saved from Drive moves the open tabs of that file to the new
  // revision, so their next save does not report a conflict with it.
  function driveSynced(file: DriveOpened) {
    const binding: DriveBinding = { binding: file.binding, account: file.account, fileId: file.fileId, baseChecksum: file.baseChecksum, editable: file.editable };
    for (const tab of tabsRef.current) if (tab.doc.drive?.account === file.account && tab.doc.drive.fileId === file.fileId) tab.doc.drive = binding;
    publishTabs();
  }
  async function saveDriveDocument(current: LoadedDocument, keepEditing: boolean) {
    const binding = current.drive!;
    if (!binding.editable) throw new Error('Este archivo tiene permiso de solo lectura en Google Drive.');
    setDriveMessage('Preparando…');
    let pending;
    if (isNativePdfDocument(current.pdf)) {
      if (current.nativeLegacySession) for (let number = 1; number <= current.pdf.numPages; number++) await nativePdfPageAnnotations(current.pdf, number);
      if (current.nativeLegacySession) throw new Error('No se recuperaron todas las anotaciones. La edición no se subió.');
      const removed = (current.nativeOriginalRefs || []).filter(ref => !annotationRef.current.some(a => a.nativeSourceRef === ref));
      pending = await driveStageNative(binding.binding, current.nativeSource!, annotationRef.current, removed);
    } else pending = await driveStage(binding.binding, await currentBytes());
    setDriveMessage('Subiendo a Drive…');
    try {
      const result = await driveSync(pending.id);
      if (result.status === 'conflict') { setDriveConflicts(ids => [...new Set([...ids, pending.id])]); notify(result.message, 'error'); setDriveLibrary(true); setLibrary(true); return; }
      if (!result.opened) throw new Error('No se pudo confirmar el archivo guardado.');
      const saved = result.opened;
      await draftSave.current.catch(() => {});
      const success = await openDocument(saved.document, saved.document.name, false, saved.document.token, { drive: saved, savedCopy: true, keepEditing, password: current.password, useSession: false, page: readingState.current.page, bookmarks: readingState.current.bookmarks });
      if (success) {
        await discardDraft(current.id);
        // Each Drive revision has its own id: the saved one replaces the previous library entry.
        if (docRef.current?.id !== current.id) await retireLibraryEntry(current.id);
      }
      notify(result.message, 'success');
    } catch (error) {
      throw new Error(`${errorMessage(error)} Puedes reintentarlo en Biblioteca → Google Drive → Ediciones pendientes.`);
    }
  }
  async function download(options?: { keepEditing?: boolean; copy?: boolean }) {
    if (editorDraftRef.current) { notify('Aplica o descarta la edición antes de guardar el PDF.'); return; }
    const current = docRef.current;
    if (!current || busyRef.current || loadingRef.current || saving.current) return;
    const keepEditing = !!options?.keepEditing && workbenchRef.current === 'edit-pdf' && !phoneRef.current;
    saving.current = true;
    setBusy('download');
    try {
      if (current.drive && !options?.copy) { await saveDriveDocument(current, keepEditing); return; }
      if (current.drive) setDriveMessage('Guardando una copia…');
      if (isNativePdfDocument(current.pdf)) {
        const saved = await presentFileBacked(current, 'save');
        if (saved && typeof saved === 'object') {
          const opened = await openDocument(saved, saved.name, false, saved.token, { savedCopy: true, keepEditing, password: current.password, useSession: false, page: readingState.current.page, bookmarks: readingState.current.bookmarks });
          if (opened) await discardDraft(current.id);
          notify(`Copia guardada. Ahora editas «${saved.name}».`, 'success');
        }
        return;
      }
      const saveInPlace = savesInPlace && !options?.copy, copy = isNative && !saveInPlace;
      const overwrite = saveInPlace && !!current.nativeSource && !current.draftSource && !current.sample;
      if (overwrite && !current.modified && annotationFingerprint(annotationRef.current) === current.savedAnnotations) { notify('No hay cambios que guardar.'); return; }
      const bytes = await currentBytes();
      const saved = overwrite
        ? await saveOriginalPdf(bytes, current.name, current.nativeSource!)
        : await savePdf(bytes, saveInPlace ? current.name : copyName(current.name), current.nativeSource);
      // The web download is an independent copy that may never reach the disk: the
      // tab keeps its id, session, draft and library entry, so reopening the
      // original still shows the changes. Only the unsaved marks are cleared.
      if (saved && !isNative) {
        current.savedAnnotations = annotationFingerprint(annotationRef.current); downloadedDrafts.current.add(current);
        publishTabs(); notify('Descarga iniciada.', 'success'); return;
      }
      if (saved) {
        await draftSave.current.catch(() => {});
        const name = typeof saved === 'object' ? saved.name : current.name;
        const opened = await openDocument(bytes, name, false, typeof saved === 'object' ? saved.token : undefined,
          { savedCopy: true, keepEditing, password: current.password, useSession: false, page: readingState.current.page, bookmarks: readingState.current.bookmarks });
        if (opened) {
          await discardDraft(current.id);
          // The saved PDF replaces the previous library entry; after a copy the original stays listed.
          if (!copy && docRef.current?.id !== current.id) await retireLibraryEntry(current.id);
        }
        notify(overwrite ? 'Cambios guardados en el PDF original.' : copy ? `Copia guardada. Ahora editas «${name}».` : 'PDF guardado.', 'success');
      }
    } catch (error) { notify(errorMessage(error, 'No se pudo guardar el PDF. Tus cambios siguen en Folio.'), 'error'); }
    finally { saving.current = false; setBusy(null); setDriveMessage(''); }
  }
  async function printDocument(anchor?: Anchor) {
    if (editorDraftRef.current) { notify('Aplica o descarta la edición antes de imprimir el PDF.'); return; }
    const current = docRef.current;
    if (!current || busyRef.current) return;
    if (!current.canPrint) { notify('Este PDF no permite imprimir.', 'error'); return; }
    if (isNative && isMobile) {
      setBusy('print');
      try { if (isNativePdfDocument(current.pdf)) await presentFileBacked(current, 'print', anchor); else await printPdf(current.canAnnotate ? await exportAnnotated(current.bytes, annotationRef.current, current.password) : current.bytes, current.name, current.nativeSource, anchor); }
      catch (error) { notify(errorMessage(error, 'No se pudo preparar la impresión.'), 'error'); }
      finally { setBusy(null); }
      return;
    }
    setBusy('print'); printCleanup.current?.();
    const container = document.createElement('div'); container.className = 'print-document'; document.body.append(container);
    const images: string[] = [];
    const release = printCleanup.current = () => { container.remove(); images.forEach(url => URL.revokeObjectURL(url)); if (printCleanup.current === release) printCleanup.current = null; };
    let printable: PDFDocumentProxy | null = null;
    try {
      // Print the PDF's own bytes: the reader's preview leaves out its original annotations.
      printable = await getDocument({ data: current.canAnnotate ? await exportAnnotated(current.bytes, annotationRef.current, current.password) : new Uint8Array(current.bytes), password: current.password, ...pdfAssetSettings() }).promise;
      let total = 0;
      for (let p = 1; p <= printable.numPages; p++) {
        notify(`Preparando impresión… página ${p} de ${printable.numPages}`);
        // 200 ppp keeps text sharp on paper while each canvas stays within mobile limits.
        const pdfPage = await printable.getPage(p), size = pdfPage.getViewport({ scale: 1 }), viewport = pdfPage.getViewport({ scale: Math.min(200 / 72, 4096 / Math.max(size.width, size.height)) });
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        try {
          await pdfPage.render({ canvas, viewport, intent: 'print' }).promise;
          const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
          if (!blob) throw new Error('No se pudo preparar la impresión.');
          total += blob.size; if (total > 300 * 1024 * 1024) throw new Error('El trabajo de impresión es demasiado grande. Extrae un intervalo de páginas para imprimirlo.');
          const image = document.createElement('img'); image.src = URL.createObjectURL(blob); images.push(image.src); image.alt = `Página ${p}`;
          const sheet = document.createElement('div'); sheet.className = 'print-sheet'; sheet.append(image); container.append(sheet); await image.decode();
        } finally { canvas.width = 0; canvas.height = 0; pdfPage.cleanup(); }
      }
      setToast(null);
      window.addEventListener('afterprint', release, { once: true });
      if (isDesktop) { const { invoke } = await import('@tauri-apps/api/core'); await invoke('print_document'); }
      else window.print();
    } catch (error) { release(); notify(errorMessage(error, 'No se pudo preparar la impresión.'), 'error'); }
    finally { await printable?.loadingTask.destroy(); setBusy(null); }
  }
  function goToResult(index: number) {
    if (!results.length) return;
    const next = (index + results.length) % results.length;
    const searchKey = `${activeTabRef.current}\0${searchQuery}`;
    if (!returnLocation) rememberLocation(); visitedSearch.current = searchKey;
    setResultIndex(next); goToPage(results[next].page, false);
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('folio:reveal-search-result', { detail: { page: results[next].page, offset: results[next].offset } })));
    if (touchRef.current) { searchInput.current?.blur(); setSidebar(false); setNotesOpen(false); setReaderChromeHidden(false); }
  }
  function submitSearch(step: number) {
    // Enter before the typing pause searches at once and then shows the first result.
    const term = searchTerm(query);
    if (term !== searchQuery) { if (term) { submitPending.current = true; setSearchQuery(term); setResultLimit(200); } return; }
    goToResult(visitedSearch.current === `${activeTabRef.current}\0${searchQuery}` ? resultIndex + step : resultIndex);
  }
  // A desktop panel closed from inside returns keyboard focus to its rail button.
  function focusRail(label: string) { requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.tool-rail [aria-label="${label}"]`)?.focus({ preventScroll: true })); }
  function closeSearch() {
    // Restore the panel that was open before searching; keyboard focus returns to Buscar.
    const returnFocus = !touchRef.current && !!document.activeElement?.closest('.sidebar');
    visitedSearch.current = null; setSearchOpen(false); setQuery(''); setSidebar(!touchRef.current && sidebarBeforeSearch.current);
    if (returnFocus) focusRail('Buscar en el PDF');
  }
  async function shareDocument(anchor?: Anchor) {
    const current = docRef.current; if (!current || busyRef.current || saving.current) return;
    setBusy('download');
    try { if (isNativePdfDocument(current.pdf)) await presentFileBacked(current, 'share', anchor); else await sharePdf(current.canAnnotate ? await exportAnnotated(current.bytes, annotationRef.current, current.password) : current.bytes, current.name, current.nativeSource, anchor); }
    catch (error) { notify(errorMessage(error, 'No se pudo compartir el PDF.'), 'error'); }
    finally { setBusy(null); }
  }
  // iPad anchors Share and Print to the control that opened them.
  const anchorOf = (element: Element | null): Anchor | undefined => { const box = element?.getBoundingClientRect(); return box && { left: box.left, top: box.top, width: box.width, height: box.height }; };
  // Actions chosen from Más acciones anchor to the button that opened the sheet.
  const actionsAnchor = () => anchorOf(document.querySelector('[aria-label="Más acciones"], [aria-label="Más acciones del documento"]'));
  function mobileAction(action: () => void) { setMobileActions(false); requestAnimationFrame(action); }
  function closeMobilePanel() { setSidebar(false); setSearchOpen(false); setQuery(''); setNotesOpen(false); if (phoneRef.current) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="Páginas"]')?.focus({ preventScroll: true })); }
  function rememberLocation() {
    if (activeTabRef.current && viewer.current) setReturnLocation({ key: activeTabRef.current, page: readingState.current.page, top: viewer.current.scrollTop, left: viewer.current.scrollLeft });
  }
  function returnToLocation() {
    if (!returnLocation || returnLocation.key !== activeTabRef.current) return;
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
    if (touchRef.current) closeMobilePanel(); setReaderChromeHidden(false); setMobileAnnotating(true); setTool('select');
  }
  function editNote(annotation: Annotation, origin: 'document' | 'list') { noteOrigin.current = origin; setNoteDraft(annotation); setNoteText(annotation.text); }
  const updateAnnotation = useCallback((id: string, patch: Partial<Pick<Annotation, 'color' | 'text'>>) => {
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
    editorReadingLocation.current = { revision: String(doc.revision), page, top: viewer.current?.scrollTop || 0, left: viewer.current?.scrollLeft || 0 };
    setSidebar(false); setSearchOpen(false); setNotesOpen(false); setMobileAnnotating(false); setReaderChromeHidden(false); setTool('select'); setWorkbench('edit-pdf');
  }
  async function closeWorkbench() {
    const wasEditing = workbenchRef.current === 'edit-pdf' && !phoneRef.current, location = editorReadingLocation.current;
    const desiredPage = readingState.current.page, revision = docRef.current?.revision, key = activeTabRef.current;
    const request = ++editorRestoreRequest.current;
    if (wasEditing) editorRestorePending.current = true;
    setWorkbench(null); setEditArea(null); if (tool !== 'redact') setTool('select');
    if (!wasEditing) return;
    if (scrollRestoreFrame.current !== null) { cancelAnimationFrame(scrollRestoreFrame.current); scrollRestoreFrame.current = null; }
    // Let the reader and its fit zoom recover before positioning the selected page.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (request === editorRestoreRequest.current && key === activeTabRef.current && revision === docRef.current?.revision) {
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
    retainCurrentTab(); publishTabs(); closeMobilePanel(); setReaderChromeHidden(false); setMobileAnnotating(false); setTool('select'); setLibrary(true);
    if (current) persistInBackground(current);
  }
  useEffect(() => {
    if (!isNative || !isAndroid) return;
    // Each Back undoes one level: dialog or menu, panel, tool section, annotation
    // mode or hidden controls, and only then the document.
    const back = (event: Event) => {
      const modal = [...document.querySelectorAll('dialog[open]')].at(-1), popover = document.querySelector('.drawing-settings-popup,.highlight-color-palette,.highlight-annotation-menu,.bookmark-menu,.document-library-menu');
      const selection = !!document.querySelector('.text-selection-menu');
      if (!modal && !popover && !selection && library && !driveLibrary) return; // Android backgrounds the existing activity.
      event.preventDefault();
      const toolsBack = (modal || document).querySelector<HTMLButtonElement>('.workbench .workbench-back:not(:disabled)');
      if (modal) { if (toolsBack) toolsBack.click(); else modal.dispatchEvent(new Event('cancel', { cancelable: true })); return; }
      if (popover) { (document.activeElement || document).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return; }
      if (selection) { window.getSelection()?.removeAllRanges(); return; }
      if (mobileTabs) { setMobileTabs(false); return; }
      if (sidebar || notesOpen || searchOpen) { closeMobilePanel(); return; }
      if (library) { setDriveLibrary(false); return; }
      if (workbench) { if (toolsBack) toolsBack.click(); else if (editorDraftRef.current) notify('Aplica o descarta la edición antes de salir del editor.'); else void closeWorkbench(); return; }
      if (mobileAnnotating || tool !== 'select') { setMobileAnnotating(false); setTool('select'); setRedactions([]); return; }
      if (readerChromeHidden) { setReaderChromeHidden(false); return; }
      void returnToLibrary();
    };
    window.addEventListener('folio:android-back', back);
    return () => window.removeEventListener('folio:android-back', back);
  });
  function cancelPassword() {
    passwordCancelled.current = true;
    engineRef.current?.abort();
    void taskRef.current?.destroy();
    setPassword(null); setLoading(false); loadingRef.current = false;
  }
  async function fullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { notify('No se pudo activar la pantalla completa.', 'error'); }
  }
  function toggleSidePanel(tab: SideTab) {
    if (phoneRef.current || window.innerWidth < 1000) setNotesOpen(false);
    setSidebar(!(sidebar && !searchOpen && sideTab === tab));
    setSearchOpen(false); setSideTab(tab);
  }
  async function windowAction(action: 'minimize' | 'toggleMaximize' | 'close') {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow()[action]();
    } catch { notify('No se pudo cambiar el estado de la ventana.', 'error'); }
  }
  async function clearLibrary() {
    if (!confirmClear) { setConfirmClear(true); return; }
    const pendingIds = tabsRef.current.map(tab => tab.doc.id).filter(id => !forgottenIds.current.has(id));
    for (const id of pendingIds) forgottenIds.current.add(id);
    try {
      await Promise.allSettled([draftSave.current, librarySave.current]);
      await clearSavedState();
      discardOpenTabs(new Set(tabsRef.current.map(tab => tab.doc.id))); pruneCopies();
      setRecents([]); setConfirmClear(false);
      notify('Biblioteca y anotaciones locales eliminadas.', 'success');
    } catch { for (const id of pendingIds) forgottenIds.current.delete(id); notify('No se pudo eliminar la biblioteca local.', 'error'); }
  }
  async function forgetRecent(recent: RecentDocument) {
    forgottenIds.current.add(recent.id);
    try {
      await Promise.allSettled([draftSave.current, librarySave.current]); await forgetDocument(recent.id);
      discardOpenTabs(new Set([recent.id])); pruneCopies();
      publishTabs(); setRecents(await listLibrary()); setDeleteTarget(null); notify(isDesktop ? 'Documento quitado de la biblioteca. El archivo original no se modificó.' : 'Copia y cambios eliminados. El archivo original no se modificó.', 'success');
    } catch { forgottenIds.current.delete(recent.id); notify(isDesktop ? 'No se pudo quitar el documento de la biblioteca.' : 'No se pudo eliminar el documento de la biblioteca.', 'error'); }
  }
  function discardOpenTabs(ids: Set<string>) {
    const removed = tabsRef.current.filter(tab => ids.has(tab.doc.id));
    const activeRemoved = removed.some(tab => tab.key === activeTabRef.current);
    tabsRef.current = tabsRef.current.filter(tab => !ids.has(tab.doc.id));
    if (activeRemoved && tabsRef.current.length) { activateTab(tabsRef.current[0]); if (phoneRef.current) setLibrary(true); }
    else if (activeRemoved) {
      activeTabRef.current = null; setActiveTabKey(null); docRef.current = null; annotationRef.current = []; undoStack.current = []; redoStack.current = [];
      setDoc(null); setAnnotations([]); setBookmarks([]); setOutline(null); setTextIndex([]); setPage(1); setPageInput('1'); setQuery(''); setSearchOpen(false); setNotesOpen(false); setSidebar(false); setTool('select'); setMobileAnnotating(false); setReaderChromeHidden(false); setReturnLocation(null); setWorkbench(null); setNoteDraft(null); setLibrary(true);
    }
    publishTabs(); for (const tab of removed) setTimeout(() => void tab.doc.pdf.loadingTask.destroy(), 200);
  }
  const explorerIds = ['pages', 'outline', 'bookmarks', 'annotations'] as const;
  function showExplorerTab(id: typeof explorerIds[number], focus = false) {
    setSearchOpen(false); setQuery(''); setNotesOpen(id === 'annotations'); setSidebar(id !== 'annotations'); if (id !== 'annotations') setSideTab(id);
    // Annotations live in their own drawer, so the tab is focused once it renders.
    if (focus) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.mobile-panel-tabs [data-explorer-tab="${id}"]`)?.focus({ preventScroll: true }));
  }
  const explorerTabs = <div className="mobile-panel-tabs" role="tablist" aria-label="Explorar PDF">{explorerIds.map((id, index) => {
    const Symbol = id === 'pages' ? Layers : id === 'outline' ? ListTree : id === 'bookmarks' ? Bookmark : MessageSquare;
    const label = id === 'pages' ? 'Páginas' : id === 'outline' ? 'Índice' : id === 'bookmarks' ? 'Marcadores' : 'Anotaciones';
    // A drawer sliding away keeps showing the tab it was on.
    const selected = id === 'annotations' ? notesOpen || notesLeaving : (sidebar || sidebarLeaving) && !searchOpen && sideTab === id;
    return <button key={id} role="tab" data-explorer-tab={id} aria-selected={selected} aria-controls={selected ? 'explorer-panel' : undefined} tabIndex={selected ? 0 : -1} onClick={() => showExplorerTab(id)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); showExplorerTab(explorerIds[event.key === 'Home' ? 0 : event.key === 'End' ? explorerIds.length - 1 : (index + (event.key === 'ArrowLeft' ? explorerIds.length - 1 : 1)) % explorerIds.length], true);
    }}><Symbol size={19} /><span>{label}</span></button>;
  })}</div>;
  const libraryContent = <DocumentLibrary onDrive={driveAvailable ? () => setDriveLibrary(true) : undefined} documents={recents} loading={libraryLoading} activeDocument={doc && !doc.sample ? { id: doc.id, name: doc.name, page, pages: doc.pdf.numPages } : undefined} busy={!!busy || loading} onContinue={doc ? () => setLibrary(false) : undefined} onOpen={recent => void reopenRecent(recent)} onImport={() => requestAnimationFrame(() => void chooseFile())} onCreate={() => setCreating(true)} onDelete={setDeleteTarget} onSettings={() => { setConfirmClear(false); setSettings(true); }} onHelp={() => setHelp(true)} onDemo={() => void openDocument('sample')} />;

  const inlineEditing = !phone && workbench === 'edit-pdf';
  const workbenchPanel = workbench && doc && !isNativePdfDocument(doc.pdf) ? <Workbench key={`${doc.revision}-${workbench}`} doc={doc} page={page} section={workbench} inline={inlineEditing} documentBusy={!!busy} area={editArea} onAreaChange={setEditArea} redactions={redactions} onClose={closeWorkbench} onSelectTool={next => { void selectWorkbenchTool(next); }} onOpenEditor={openEditor} onOpenSection={next => { void openWorkbenchSection(next); }} onDraftChange={setEditorDraft} onEditPageChange={next => { readingState.current.page = next; setPage(next); setPageInput(String(next)); }} onApply={applyOperation} getBytes={currentBytes} onSave={() => { void download({ keepEditing: true }); }} canSave={!busy && !loading && !editorDraft} onHistory={direction => { if (!busy) { if (direction === 'undo') undo(); else redo(); } }} canUndo={!!undoStack.current.length} canRedo={!!redoStack.current.length} onReplace={replaceDocument} /> : null;

  const saveLabel = doc?.drive ? 'Guardar en Drive' : fileSaveLabel;
  // Only an opened file can be updated; otherwise Guardar already asks where to save.
  const savesOriginal = savesInPlace && !!doc?.nativeSource && !doc.drive && !doc.draftSource && !doc.sample;
  const sessionStatus = storageFailed ? `No se pudieron guardar tus cambios en ${here}. ${saveAdvice}` : `Los cambios se conservan en ${here}.`;
  const driveDirty = !!doc?.drive && (doc.modified || annotationFingerprint(annotations) !== doc.savedAnnotations);
  const driveStatus = busy === 'download' && driveMessage ? driveMessage : driveDirty ? 'Google Drive: cambios pendientes de guardar' : 'Documento de Google Drive';
  const driveIndicator = doc?.drive && <span className={`drive-document-indicator${driveDirty ? ' pending' : ''}`} role="status" aria-label={driveStatus} title={driveStatus}>{busy === 'download' ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Cloud size={15} aria-hidden="true" />}</span>;

  // Positions are physical page numbers; a printed label that differs follows them.
  const pageName = (number: number) => { const label = pageLabels?.[number - 1]; return label && label !== String(number) ? `${number} (${label})` : String(number); };
  const pageCounter = doc ? `${page} / ${doc.pdf.numPages}${currentPageLabel !== String(page) ? ` · ${currentPageLabel}` : ''}` : undefined;
  const listedResults = Math.max(resultLimit, resultIndex + 1);
  const sideCount = sideTab === 'pages' ? doc?.pdf.numPages : sideTab === 'bookmarks' ? bookmarks.filter(node => node.page !== null).length : 0;
  // The macOS menu bar's commands behave as their keyboard shortcuts.
  menuAction.current = id => {
    const modal = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (id === 'close-tab') { if (modal) modal.dispatchEvent(new Event('cancel', { cancelable: true })); else if (activeTabRef.current) void closeTab(activeTabRef.current); return; }
    // As with the keyboard, a dialog in front or the inline editor keeps the reader's commands.
    if (modal || workbenchRef.current === 'edit-pdf' && !['settings', 'help', 'save', 'save-copy'].includes(id)) return;
    if (id === 'settings') { setConfirmClear(false); setSettings(true); }
    else if (id === 'help') setHelp(true);
    else if (id === 'save' || id === 'save-copy') void download({ keepEditing: true, copy: id === 'save-copy' });
    else if (id === 'print') void printDocument();
    else if (id === 'find') { if (library) document.querySelector<HTMLInputElement>('.document-library-search input')?.focus(); else if (docRef.current) openSearch(); }
    else if (id === 'zoom-in' || id === 'zoom-out') { if (docRef.current) changeZoom(id === 'zoom-in' ? .1 : -.1); }
    else if (id === 'zoom-reset' && docRef.current) { setCustomScale(1); setZoomMode('custom'); }
  };
  const capabilitySummary = doc?.signed ? 'Este PDF está firmado. Puedes leerlo, buscar y añadir marcadores; editarlo invalidaría la firma.'
    : doc?.drive && !doc.drive.editable ? 'Este archivo de Google Drive es de solo lectura. Puedes leerlo, buscar y añadir marcadores.'
    : !doc?.canAnnotate ? 'El autor de este PDF no permite anotarlo. Puedes leerlo, buscar y añadir marcadores.'
    : 'PDF grande: puedes leer, buscar, resaltar, dibujar y añadir notas. No se pueden editar páginas ni formularios.';
  const shortcuts = [
    ['Abrir PDF', shortcutLabel('O')], ['Buscar', shortcutLabel('F')], [fileSaveLabel, shortcutLabel('S')], ...isNative ? [['Guardar una copia…', shortcutLabel('S', true)]] : [], ['Imprimir', shortcutLabel('P')],
    ['Deshacer', shortcutLabel('Z')], ['Rehacer', redoShortcut],
    // Browsers keep Ctrl+W and Ctrl+Tab for their own tabs.
    ...isDesktop ? [['Cambiar de pestaña', isMac ? '⌃Tab' : 'Ctrl+Tab'], ['Cerrar pestaña', shortcutLabel('W')]] : [],
    ['Cambiar de página', '← / →'], ['Zoom', isMac || isIOS ? '⌘+ / ⌘−' : 'Ctrl + / Ctrl −'], ['Tamaño real', shortcutLabel('0')],
    ['Seleccionar texto', 'V'], ['Resaltador', 'H'], ['Nota', 'N'], ['Lápiz', 'D'], ['Salir de una herramienta', 'Esc'],
  ];
  // Stable handlers let memoized pages skip renders that change nothing on them.
  const pageEvents = useRef({ onAnnotate, onArea, navigatePDF, commentHighlight, mobilePage, openNote: (_id: string) => {} });
  pageEvents.current = { onAnnotate, onArea, navigatePDF, commentHighlight, mobilePage, openNote: id => {
    const annotation = annotationRef.current.find(item => item.id === id);
    if (annotation && docRef.current?.canAnnotate) editNote(annotation, 'document'); else { setNotesOpen(true); setActiveNote(id); }
  } };
  const pageHandlers = useMemo(() => ({ onAnnotate: (annotation: AnnotationDraft | AnnotationDraft[]) => pageEvents.current.onAnnotate(annotation), onArea: (area: Area) => pageEvents.current.onArea(area),
    onNavigate: (destination: PDFNavigationTarget) => pageEvents.current.navigatePDF(destination), onCommentHighlight: (annotation: Annotation) => void pageEvents.current.commentHighlight(annotation), onNoteClick: (id: string) => pageEvents.current.openNote(id) }), []);
  const thumbnailClicks = useMemo(() => pages.map(number => () => pageEvents.current.mobilePage(number)), [pages]);
  const annotationSettings = tool === 'highlight' ? <HighlightColorPicker color={color} onChange={setColor} disabled={!doc?.canAnnotate || !doc?.canCopy || !!busy || loading} /> : (tool === 'draw' || tool === 'eraser') ? <DrawingSettings mode={tool} kind={inkKind} style={inkStyle} recentColors={inkRecentColors} eraserSize={eraserSize} penOnly={penOnly} showFingerOption={isMobile || penDetected} onKind={setInkKind} onStyle={change => setInkStyles(styles => ({ ...styles, [inkKind]: { ...styles[inkKind], ...change } }))} onCustomColor={value => setInkRecentColors(colors => [value, ...colors.filter(item => item !== value)].slice(0, 5))} onEraserSize={setEraserSize} onPenOnly={choosePenOnly} disabled={!doc?.canAnnotate || !!busy || loading} /> : null;
  // On touch, tools without options keep their slot so no button moves under the finger.
  const annotationSlot = annotationSettings || <span className="drawing-settings-trigger" aria-hidden="true" style={{ visibility: 'hidden' }} />;

  return <div className={`app-shell${isDesktop && isMac ? ' native-mac' : ''}${isDesktop && isMac && windowState.fullscreen ? ' mac-fullscreen' : ''}${phone ? ' phone-layout' : tablet ? ' tablet-layout' : ''}${readerChromeHidden ? ' reader-chrome-hidden' : ''}${library ? ' library-visible' : ''}`} onDragEnter={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragCounter.current++; setDragOver(true); } }} onDragLeave={e => { e.preventDefault(); if (--dragCounter.current <= 0) { dragCounter.current = 0; setDragOver(false); } }} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { e.preventDefault(); dragCounter.current = 0; setDragOver(false); if (!isDesktop) void openFiles(Array.from(e.dataTransfer.files)); }}>
    {closeBlocked && <Modal title="No se pudieron guardar tus cambios" onClose={() => setCloseBlocked(null)}><p className="modal-description">{savesInPlace ? 'Guarda' : isNative ? 'Guarda una copia de' : 'Descarga'} «{doc?.name}» antes de {closeBlocked === 'window' ? 'salir' : 'cerrarlo'} o perderás los cambios.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setCloseBlocked(null)}>Volver</button><button className="secondary-button" onClick={() => { setCloseBlocked(null); void download({ copy: !savesInPlace }); }}>{savesInPlace ? saveLabel : fileSaveLabel}</button><button className="primary-button" onClick={() => {
      const key = closeBlocked; setCloseBlocked(null);
      if (key === 'window') void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().destroy());
      else requestAnimationFrame(() => void closeTab(key, true));
    }}>{closeBlocked === 'window' ? 'Salir sin guardar' : 'Cerrar sin guardar'}</button></div></Modal>}
    <header className="app-header" data-tauri-drag-region inert={touchLayout && (library || sidebar || notesOpen)}>
      {!touchLayout && <div className="brand"><img src="/folio.svg" alt="Folio" /></div>}
      <h1 className="sr-only">{doc?.name || 'Folio'}</h1>
      {tablet ? <TabletReaderHeader nameAdornment={driveIndicator} documentsOpen={mobileTabs} name={doc?.name || 'Folio'} count={tabs.length} page={pageCounter} pageStep={readingMode === 'single' && doc ? { previous: page > 1 ? () => goToPage(page - 1, false) : undefined, next: page < doc.pdf.numPages ? () => goToPage(page + 1, false) : undefined } : undefined} annotating={mobileAnnotating} disabled={!!busy || loading} draft={editorDraft || inlineEditing} canUndo={!!undoStack.current.length} canRedo={!!redoStack.current.length} bookmarked={!!doc && hasBookmarkPage(bookmarks, page)} onBookmark={toggleBookmark} onLibrary={() => void returnToLibrary()} onDocuments={() => setMobileTabs(value => !value)} onPage={() => { setPageInput(String(page)); setPageJump(true); }} onPages={() => openExplorer()} onSearch={openSearch} onAnnotate={startAnnotating} onDone={() => { setMobileAnnotating(false); setTool('select'); }} onUndo={undo} onRedo={redo} onMore={() => setMobileActions(true)} /> : phone ? <>
        <IconButton label="Volver a la biblioteca" disabled={!!busy || loading} onClick={() => void returnToLibrary()}><ChevronLeft size={24} /></IconButton>
        <button id="document-switcher-trigger" className="mobile-document-selector" aria-label="Documentos abiertos y recientes" aria-haspopup="dialog" aria-expanded={mobileTabs} aria-controls="document-switcher" disabled={!!busy || loading || !tabs.length} onClick={() => setMobileTabs(value => !value)}><span>{doc?.name || 'Folio'}</span>{driveIndicator}{tabs.length > 1 && <span className="mobile-tab-count">{tabs.length}</span>}<ChevronDown size={16} /></button>
        {mobileAnnotating ? <><IconButton label="Deshacer" disabled={!!busy || !undoStack.current.length} onClick={undo}><Undo2 size={21} /></IconButton><IconButton label="Rehacer" disabled={!!busy || !redoStack.current.length} onClick={redo}><Redo2 size={21} /></IconButton><button className="mobile-done" onClick={() => { setMobileAnnotating(false); setTool('select'); }}>Listo</button></> : <IconButton label="Más acciones" onClick={() => setMobileActions(true)}><MoreHorizontal size={23} /></IconButton>}
      </> : <>
      <div className={`document-tab-strip${tabDrag.enabled ? ' drag-enabled' : ''}${tabDrag.draggingKey ? ' is-dragging' : ''}`} ref={tabDrag.strip} onClickCapture={tabDrag.clickCapture} onDragStart={event => { if (tabDrag.enabled) event.preventDefault(); }} onWheel={event => {
        if (event.deltaX || event.ctrlKey || event.metaKey) return;
        // The strip snaps to whole tabs, so a scrollBy moves at least one tab: gather small trackpad steps first.
        tabWheel.current += event.deltaY * (event.deltaMode ? 40 : 1);
        if (Math.abs(tabWheel.current) >= 50) { event.currentTarget.scrollBy({ left: tabWheel.current }); tabWheel.current = 0; }
      }} role="tablist" aria-label="Documentos abiertos">
        {tabs.map(tab => { const modified = tab.doc.modified && !downloadedDrafts.current.has(tab.doc) || annotationFingerprint(tab.key === activeTabKey ? annotations : tab.annotations) !== tab.doc.savedAnnotations; return <div className={`document-tab ${tab.key === activeTabKey ? 'selected' : ''}${tabDrag.draggingKey === tab.key ? ' plan-tab-dragging' : ''}${tabDrag.drop?.key === tab.key ? ` tab-drop-${tabDrag.drop.side}` : ''}`} key={tab.key} data-tab-key={tab.key} onPointerDown={event => tabDrag.begin(event, tab.key)}>
          <button role="tab" aria-selected={tab.key === activeTabKey} aria-controls="document-reader" aria-label={tab.doc.name} aria-describedby={modified ? `modified-${tab.key}` : undefined} title={tab.doc.name} tabIndex={tab.key === activeTabKey ? 0 : -1} disabled={!!busy || loading || editorDraft} onClick={() => { if (tab.key === activeTabKey) setLibrary(false); else void switchTab(tab.key); }} onKeyDown={event => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const i = tabs.findIndex(item => item.key === tab.key); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length; void switchTab(tabs[next].key); }
            else if (event.key === 'Delete') { event.preventDefault(); void closeTab(tab.key); }
          }}>{tab.doc.drive ? tab.key === activeTabKey ? driveIndicator : <Cloud size={14} aria-label="Documento de Google Drive" /> : <FileText size={14} />}<span>{tab.doc.name}</span>{modified && <span className="modified-dot" id={`modified-${tab.key}`} title="Cambios sin guardar"><span className="sr-only">Cambios sin guardar</span></span>}</button>
          {/* Outside the Tab order: the focused tab closes with Delete or the shortcut. */}
          <button className="document-tab-close" aria-label={`Cerrar ${tab.doc.name}`} title={isDesktop ? `Cerrar pestaña (${shortcutLabel('W')})` : 'Cerrar pestaña'} tabIndex={-1} disabled={!!busy || loading || editorDraft} onClick={() => void closeTab(tab.key)}><X size={13} /></button>
        </div>; })}
      </div>
      {draggedTab && <div className="document-tab-drag-preview" aria-hidden="true" style={{ left: Math.max(8, Math.min(tabDrag.location.x + 16, window.innerWidth - 270)), top: Math.max(8, Math.min(tabDrag.location.y + 16, window.innerHeight - 48)) }}><FileText size={16} /><span>{draggedTab.doc.name}</span></div>}
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
      {!touchLayout && <nav className="tool-rail" aria-label="Herramientas del documento" inert={inlineEditing}>
        <div className="rail-primary">
          <button className={library ? 'rail-button active' : 'rail-button'} aria-label="Biblioteca" onClick={() => setLibrary(true)}><FolderOpen size={21} /><span>Biblioteca</span></button>
          <button className={`rail-button ${sidebar && !searchOpen && sideTab === 'pages' ? 'active' : ''}`} aria-label="Páginas" aria-expanded={sidebar && !searchOpen && sideTab === 'pages'} disabled={!doc} onClick={() => toggleSidePanel('pages')}><Layers size={21} /><span>Páginas</span></button>
          <button className={`rail-button annotations-toggle ${notesOpen ? 'active' : ''}`} aria-label="Anotaciones" aria-expanded={notesOpen} disabled={!doc} onClick={() => { if (window.innerWidth < 1000) { setSidebar(false); setSearchOpen(false); } setNotesOpen(v => !v); }}><MessageSquare size={21} /><span>Anotaciones</span>{annotations.length > 0 && <span className="rail-count">{annotations.length}</span>}</button>
          <button className={`rail-button ${searchOpen && sidebar ? 'active' : ''}`} aria-label="Buscar en el PDF" title={`Buscar en el PDF (${shortcutLabel('F')})`} aria-expanded={searchOpen && sidebar} disabled={!doc} onClick={() => { if (searchOpen && sidebar) closeSearch(); else openSearch(); }}><Search size={21} /><span>Buscar</span></button>
          <button className={`rail-button ${sidebar && !searchOpen && sideTab === 'bookmarks' ? 'active' : ''}`} aria-label="Marcadores" aria-expanded={sidebar && !searchOpen && sideTab === 'bookmarks'} disabled={!doc} onClick={() => toggleSidePanel('bookmarks')}><Bookmark size={21} /><span>Marcadores</span></button>
          <button className={`rail-button ${sidebar && !searchOpen && sideTab === 'outline' ? 'active' : ''}`} aria-label="Índice" aria-expanded={sidebar && !searchOpen && sideTab === 'outline'} disabled={!doc} onClick={() => toggleSidePanel('outline')}><ListTree size={21} /><span>Índice</span></button>
        </div>
        <div className="rail-bottom">
          <IconButton label="Ajustes" onClick={() => { setSettings(true); setConfirmClear(false); }}><Settings size={19} /></IconButton>
          <IconButton label="Ayuda y atajos" onClick={() => setHelp(true)}><CircleHelp size={19} /></IconButton>
        </div>
      </nav>}
      {touchLayout && (sidebar || notesOpen || sidebarLeaving || notesLeaving) && <button className={`mobile-panel-backdrop${sidebar || notesOpen ? '' : ' closing'}`} aria-label="Cerrar panel lateral" tabIndex={-1} onClick={closeMobilePanel} />}
      {(sidebar || sidebarLeaving) && <aside className={`sidebar${touchLayout ? ' mobile-drawer' : ''}${sidebarLeaving ? ' closing' : ''}`} role={touchLayout ? 'dialog' : undefined} aria-modal={touchLayout ? true : undefined} aria-label={touchLayout ? searchOpen ? 'Buscar en el PDF' : 'Explorar documento' : undefined} style={touchLayout ? undefined : { width: readingPreferences.panelWidth, minWidth: readingPreferences.panelWidth }}>
        {touchLayout && <><SheetHandle onClose={closeMobilePanel} label="Cerrar explorador" /><div className="mobile-drawer-heading"><h2>{searchOpen ? 'Buscar' : 'Explorar'}</h2><IconButton label={searchOpen ? 'Cerrar búsqueda' : 'Cerrar panel'} onClick={closeMobilePanel}><X size={20} /></IconButton></div>{!searchOpen && explorerTabs}</>}
        {searchOpen ? <>
          {!touchLayout && <div className="sidebar-title"><span>Buscar</span><IconButton label="Cerrar búsqueda" onClick={closeSearch}><X size={16} /></IconButton></div>}
          <form className="search-field" onSubmit={e => { e.preventDefault(); submitSearch(phone ? 0 : 1); }}><Search size={16} /><input ref={searchInput} placeholder="Palabra o frase…" value={query} onChange={e => { visitedSearch.current = null; setQuery(e.target.value); setResultIndex(0); }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); submitSearch(-1); } }} aria-label="Buscar texto en el PDF" />{query && <button type="button" onClick={() => setQuery('')} aria-label="Borrar búsqueda"><X size={14} /></button>}</form>
          <div className="search-summary"><span aria-live="polite">{indexing ? 'Preparando búsqueda…' : query.trim().length === 1 ? 'Escribe al menos dos caracteres' : searchQuery ? plural(occurrences, 'coincidencia', 'coincidencias') : ''}</span>{results.length > 0 && <div><IconButton label="Resultado anterior" onClick={() => goToResult(resultIndex - 1)}><ChevronLeft size={15} /></IconButton><IconButton label="Siguiente resultado" onClick={() => goToResult(resultIndex + 1)}><ChevronRight size={15} /></IconButton></div>}</div>
          <div className="sidebar-scroll search-results">{results.slice(0, listedResults).map((result, i) => <button key={`${result.page}-${result.offset}`} className={`search-result ${i === resultIndex ? 'selected' : ''}`} onClick={() => goToResult(i)}><span className="result-heading">Página {pageName(result.page)}<span>{i + 1} / {results.length}</span></span><span>{result.text}</span></button>)}{results.length > listedResults ? <button className="text-button" onClick={() => setResultLimit(listedResults + 200)}>Mostrar más resultados</button> : occurrences > results.length && <div className="search-hint"><span>Se muestran las primeras {results.length} coincidencias. Escribe una frase más concreta para afinar.</span></div>}{searchQuery && !indexing && !results.length && (textIndex.every(t => !t.trim()) ? <div className="empty-panel"><Search size={26} /><p>Este PDF no tiene texto que se pueda buscar.</p>{doc?.canEdit && !isNativePdfDocument(doc.pdf) && <button className="text-button" onClick={() => { closeSearch(); void openWorkbenchSection('ocr'); }}>Reconocer texto (OCR)</button>}</div> : <div className="empty-panel"><Search size={26} /><p>Sin resultados para «{searchQuery.trim()}».</p><span>Prueba con otra palabra o una frase más corta.</span></div>)}{!searchQuery && <div className="search-hint"><span>No distingue mayúsculas ni acentos.</span></div>}</div>
        </> : <>
          {!touchLayout && <div className="sidebar-title"><span>{sideTab === 'pages' ? 'Páginas' : sideTab === 'outline' ? 'Índice' : 'Marcadores'}</span>{!!sideCount && <span className="page-total">{sideCount}</span>}<IconButton label="Cerrar panel" onClick={() => { setSidebar(false); focusRail(sideTab === 'pages' ? 'Páginas' : sideTab === 'outline' ? 'Índice' : 'Marcadores'); }}><X size={16} /></IconButton></div>}

          <div className={`sidebar-scroll ${sideTab === 'pages' ? 'thumbnails' : 'outline-list'}`} id={touchLayout ? 'explorer-panel' : undefined} role={touchLayout ? 'tabpanel' : undefined}>
            {sideTab === 'pages' && doc && pages.map(number => <Thumbnail key={`${doc.pdf.loadingTask.docId}-${number}`} pdf={doc.pdf} number={number} rotation={rotation} pageLabel={pageName(number)} selected={page === number} onClick={thumbnailClicks[number - 1]} />)}
            {sideTab === 'outline' && (outline ? <DocumentOutline outline={outline} page={page} onNavigate={mobilePage} /> : <div className="empty-panel"><LoaderCircle size={26} className="spin" /><p>Cargando índice…</p></div>)}
            {sideTab === 'bookmarks' && <BookmarkTree key={activeTabKey} bookmarks={bookmarks} onChange={commitBookmarks} onFold={next => { readingState.current.bookmarks = next; setBookmarks(next); }} page={page} onGoToPage={mobilePage} disabled={!!busy || loading} startEditingId={bookmarkEditingId} onEditingComplete={() => setBookmarkEditingId(null)} />}
          </div>
        </>}
      </aside>}

      <main className={`reader${phone && mobileAnnotating ? ' mobile-annotating' : ''}`} id="document-reader" inert={library || touchLayout && (sidebar || notesOpen)}>
        {!touchLayout && !inlineEditing && <div className="reader-toolbar">
          <div className="toolbar-left">
            <div className="desktop-mode-switch" role="group" aria-label="Modo del documento">
              <button aria-label="Modo lectura" aria-pressed={!mobileAnnotating} disabled={!doc || !!busy || loading} onClick={() => { setMobileAnnotating(false); setTool('select'); }}><BookOpen size={17} /><span>Lectura</span></button>
              <button aria-label="Anotar documento" aria-pressed={mobileAnnotating} disabled={!doc || !!busy || loading} onClick={startAnnotating}><Highlighter size={17} /><span>Anotar</span></button>
              <button aria-label="Editar contenido del PDF" aria-pressed={false} disabled={!doc?.canEdit || !doc?.canCopy || !!busy || loading || !!doc && isNativePdfDocument(doc.pdf)} onClick={openEditor}><FileText size={17} /><span>Editar</span></button>
            </div>
            <button className="tools-button" aria-label="Herramientas" disabled={!doc || !!busy || loading} onClick={openTools}><Wrench size={17} /><span>Herramientas</span></button>
            <div className="undo-group"><span className="toolbar-divider" /><IconButton label={`Deshacer (${shortcutLabel('Z')})`} onClick={undo} disabled={!!busy || !undoStack.current.length}><Undo2 size={17} /></IconButton><IconButton label={`Rehacer (${redoShortcut})`} onClick={redo} disabled={!!busy || !redoStack.current.length}><Redo2 size={17} /></IconButton></div>
          </div>
          <div className="page-controls"><IconButton label="Página anterior" onClick={() => goToPage(page - 1)} disabled={!doc || page <= 1}><ChevronLeft size={17} /></IconButton><form onSubmit={e => { e.preventDefault(); commitPageInput(); }}><input aria-label="Número de página" type="text" inputMode="numeric" value={pageInput} onChange={e => { pageInputDirty.current = true; setPageInput(e.target.value.replace(/\D/g, '')); }} onBlur={() => { if (pageInputDirty.current) commitPageInput(); }} /><span>/ {doc?.pdf.numPages || '—'}</span></form><IconButton label="Página siguiente" onClick={() => goToPage(page + 1)} disabled={!doc || page >= doc.pdf.numPages}><ChevronRight size={17} /></IconButton></div>
          <div className="toolbar-right">
            <div className="zoom-controls"><IconButton label="Reducir zoom" onClick={() => changeZoom(-.1)} disabled={!doc || scale <= .25}><Minus size={16} /></IconButton><div className="zoom-select"><select aria-label="Nivel de zoom" value={zoomMode === 'custom' ? String(Math.round(scale * 100)) : zoomMode} onChange={e => { if (['page', 'width'].includes(e.target.value)) setZoomMode(e.target.value); else { setCustomScale(Number(e.target.value) / 100); setZoomMode('custom'); } }} disabled={!doc}><option value="page">Ajustar página</option><option value="width">Ajustar ancho</option>{![50, 75, 100, 125, 150, 200, 300].includes(Math.round(scale * 100)) && zoomMode === 'custom' && <option value={String(Math.round(scale * 100))}>{Math.round(scale * 100)} %</option>}{[50, 75, 100, 125, 150, 200, 300].map(n => <option key={n} value={n}>{n} %</option>)}</select><ChevronDown size={12} /></div><IconButton label="Ampliar zoom" onClick={() => changeZoom(.1)} disabled={!doc || scale >= 3}><Plus size={16} /></IconButton></div>
            <span className="toolbar-divider" /><IconButton label={hasBookmarkPage(bookmarks, page) ? 'Editar marcador de esta página' : 'Guardar marcador de esta página'} disabled={!doc || !!busy || loading} onClick={toggleBookmark} active={hasBookmarkPage(bookmarks, page)}><Bookmark size={17} fill={hasBookmarkPage(bookmarks, page) ? 'currentColor' : 'none'} /></IconButton>
            <button className="download-button" aria-label={saveLabel} title={`${saveLabel} (${shortcutLabel('S')})`} onClick={() => void download()} disabled={!doc || !!busy || loading}><ArrowDownToLine size={16} /><span>{doc?.drive ? 'Guardar' : saveLabel}</span></button>
            <IconButton label="Más acciones del documento" disabled={!doc || !!busy || loading} onClick={() => setMobileActions(true)}><MoreHorizontal size={20} /></IconButton>
          </div>
        </div>}
        {!touchLayout && !inlineEditing && doc && mobileAnnotating && <div className="desktop-annotation-toolbar" role="toolbar" aria-label="Herramientas de anotación">
          <div className="tool-group"><IconButton label="Seleccionar texto (V)" toggle active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={18} /></IconButton><IconButton label="Resaltador (H)" toggle active={tool === 'highlight'} disabled={!doc.canAnnotate || !doc.canCopy || !!busy || loading} onMouseDown={e => e.preventDefault()} onClick={activateHighlight}><Highlighter size={19} /></IconButton><IconButton label="Nota (N)" toggle active={tool === 'note'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool(tool === 'note' ? 'select' : 'note')}><StickyNote size={18} /></IconButton><IconButton label="Lápiz (D)" toggle active={tool === 'draw'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool('draw')}><PenLine size={21} /></IconButton><IconButton label="Goma" toggle active={tool === 'eraser'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool('eraser')}><Eraser size={21} /></IconButton>{annotationSettings}</div>
          <span className="desktop-tool-description">{tool === 'draw' ? 'Dibuja sobre la página' : tool === 'eraser' ? 'Pasa la goma sobre un trazo para borrarlo' : tool === 'highlight' ? 'Selecciona el texto para resaltarlo' : tool === 'note' ? 'Haz clic en la página para añadir una nota' : 'Selecciona texto para copiar, resaltar o comentar'}</span>
          <button className="text-button" onClick={() => { setMobileAnnotating(false); setTool('select'); }}><Check size={16} />Listo</button>
        </div>}

        {tablet && doc && mobileAnnotating && !inlineEditing && <TabletAnnotationDock tool={tool} setTool={setTool} disabled={!doc.canAnnotate || !!busy || loading} canCopy={doc.canCopy} settings={annotationSlot} hasSettings={!!annotationSettings} onHighlight={activateHighlight} />}
        {tablet && doc && searchOpen && !sidebar && !inlineEditing && <div className="tablet-search-controls" role="toolbar" aria-label="Resultados de búsqueda"><IconButton label="Ver resultados" onClick={() => setSidebar(true)}><Search size={20} /></IconButton><span>{results.length ? `${resultIndex + 1} / ${results.length}` : 'Sin resultados'}</span><IconButton label="Resultado anterior" disabled={!results.length} onClick={() => goToResult(resultIndex - 1)}><ChevronLeft size={21} /></IconButton><IconButton label="Resultado siguiente" disabled={!results.length} onClick={() => goToResult(resultIndex + 1)}><ChevronRight size={21} /></IconButton><IconButton label="Cerrar búsqueda" onClick={closeSearch}><X size={21} /></IconButton></div>}
        {inlineEditing && workbenchPanel}
        <div className="reading-area" hidden={inlineEditing} style={inlineEditing ? { display: 'none' } : undefined} ref={viewer} aria-label="Área de lectura del PDF" tabIndex={-1}>
          {doc ? <div className="pdf-stack" key={doc.pdf.loadingTask.docId} style={{ gap: readingPreferences.pageGap }}>{doc.sample && <div className="sample-hint"><BookOpen size={13} /><span>PDF de ejemplo</span></div>}{(readingMode === 'single' ? [page] : pages).map(number => <PDFPage key={`${doc.revision}-${number}`} pdf={doc.pdf} number={number} pageLabel={pageName(number)} scale={scale} rotation={rotation} dimensions={dimensions} annotations={annotationPages.get(number) || NO_ANNOTATIONS} tool={tool} color={color} inkColor={inkStyle.color} inkWidth={inkStyle.width} inkOpacity={inkStyle.opacity} eraserSize={eraserSize} penOnly={penOnly} query={searchOpen ? searchQuery : ''} activeSearch={searchOpen && (!touchLayout || !sidebar) ? results[resultIndex] : null} canCopy={doc.canCopy} canAnnotate={doc.canAnnotate && !busy && !loading} onRemoveAnnotation={removeAnnotation} onUpdateAnnotation={updateAnnotation} redactions={redactions} {...pageHandlers} />)}</div> : !loading && <div className="welcome"><div className="welcome-icon"><BookOpen size={38} /></div><h2>Abrir PDF</h2><p>{!touchLayout ? 'Selecciona un archivo o arrástralo a esta ventana.' : isIOS ? 'Selecciona un PDF desde Archivos.' : 'Selecciona un PDF para abrirlo.'}</p></div>}
          {loading && <div className="loading-overlay" role="status"><svg className="activity-ring large" viewBox="0 0 24 24" aria-hidden="true"><circle className="activity-ring-track" cx="12" cy="12" r="9" /><circle className="activity-ring-arc" cx="12" cy="12" r="9" /></svg><span>Abriendo PDF…</span></div>}
        </div>
        {touchLayout && doc && !inlineEditing && !loading && !(mobileAnnotating && (tool === 'draw' || tool === 'eraser')) && <PageScrubber pdf={doc.pdf} page={page} pages={doc.pdf.numPages} viewer={viewer.current} continuous={readingMode !== 'single'} label={pageName} section={outlineSection} onJump={target => { if (!returnLocation) rememberLocation(); goToPage(target, false); }} />}
        {touchLayout && doc && returnLocation?.key === activeTabKey && returnLocation.page !== page && <button className="touch-return-location" onClick={returnToLocation}><ChevronLeft size={18} /><span>Volver a p. {pageName(returnLocation.page)}</span></button>}

        {phone && doc && <>
          <div className="mobile-reading-status">
            {readingMode === 'single' && <IconButton label="Página anterior" disabled={!!busy || loading || page <= 1} onClick={() => goToPage(page - 1, false)}><ChevronLeft size={20} /></IconButton>}
            <button className="mobile-page-jump" aria-label="Ir a página" title={`Página ${page} de ${doc.pdf.numPages}`} disabled={!!busy || loading} onClick={() => { setPageInput(String(page)); setPageJump(true); }}><span>{pageCounter}</span><ChevronDown size={13} /></button>
            {readingMode === 'single' && <IconButton label="Página siguiente" disabled={!!busy || loading || page >= doc.pdf.numPages} onClick={() => goToPage(page + 1, false)}><ChevronRight size={20} /></IconButton>}
            <IconButton label={hasBookmarkPage(bookmarks, page) ? 'Quitar marcador de esta página' : 'Guardar marcador de esta página'} disabled={!!busy || loading} onClick={toggleBookmark} active={hasBookmarkPage(bookmarks, page)}><Bookmark size={20} fill={hasBookmarkPage(bookmarks, page) ? 'currentColor' : 'none'} /></IconButton>
          </div>
          {!mobileAnnotating && (searchOpen && !sidebar ? <div className="mobile-search-toolbar" role="toolbar" aria-label="Resultados de búsqueda"><button className="mobile-search-list" aria-label="Ver resultados" onClick={() => setSidebar(true)}><Search size={20} /><span>{results.length ? `${resultIndex + 1} / ${results.length}` : 'Sin resultados'}</span></button><IconButton label="Resultado anterior" disabled={!results.length} onClick={() => goToResult(resultIndex - 1)}><ChevronLeft size={22} /></IconButton><IconButton label="Resultado siguiente" disabled={!results.length} onClick={() => goToResult(resultIndex + 1)}><ChevronRight size={22} /></IconButton><IconButton label="Cerrar búsqueda" onClick={closeSearch}><X size={22} /></IconButton></div> : <nav className="mobile-reading-toolbar" aria-label="Acciones de lectura"><button aria-label="Páginas" disabled={!!busy || loading} onClick={() => openExplorer()}><Layers size={22} /><span>Páginas</span></button><button aria-label="Buscar" disabled={!!busy || loading} onClick={openSearch}><Search size={22} /><span>Buscar</span></button><button aria-label="Anotar" disabled={!!busy || loading} onClick={startAnnotating}><Highlighter size={22} /><span>Anotar</span></button><button aria-label="Compartir" disabled={!!busy || loading} onClick={event => void shareDocument(anchorOf(event.currentTarget))}><Upload size={22} /><span>Compartir</span></button></nav>)}
        </>}
        {!touchLayout && doc && returnLocation?.key === activeTabKey && returnLocation.page !== page && <button className="desktop-return-location" onClick={returnToLocation}><ChevronLeft size={16} /><span>Volver a p. {returnLocation.page}</span></button>}
        {phone && doc && mobileAnnotating && <div className="mobile-annotation-toolbar" role="toolbar" aria-label="Herramientas de anotación">
          <IconButton label="Seleccionar texto" toggle active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={21} /></IconButton>
          <IconButton label="Resaltador" toggle active={tool === 'highlight'} disabled={!doc.canAnnotate || !doc.canCopy || !!busy || loading} onMouseDown={event => event.preventDefault()} onClick={activateHighlight}><Highlighter size={21} /></IconButton>
          <IconButton label="Nota" toggle active={tool === 'note'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool(tool === 'note' ? 'select' : 'note')}><StickyNote size={21} /></IconButton>
          <IconButton label="Lápiz" toggle active={tool === 'draw'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool('draw')}><PenLine size={21} /></IconButton><IconButton label="Goma" toggle active={tool === 'eraser'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool('eraser')}><Eraser size={21} /></IconButton>
          {annotationSlot}<IconButton label="Más opciones" onClick={() => setAnnotationOptions(true)}><MoreHorizontal size={22} /></IconButton>
        </div>}

        {tool !== 'select' && tool !== 'highlight' && tool !== 'draw' && tool !== 'eraser' && doc && (touchLayout || !mobileAnnotating) && <div className="annotation-tool-hint">
          <span>{tool === 'note' ? touchLayout ? 'Toca la página para añadir una nota' : 'Haz clic en la página para añadir una nota' : tool === 'redact' ? 'Marca las áreas que quieres censurar' : tool === 'crop' ? 'Arrastra sobre la página para elegir el área visible' : 'Arrastra para seleccionar el área'}</span>
          {!phone && tool !== 'note' && (tool !== 'redact' || !redactions.length) && <button className="secondary-button" disabled={!doc.canEdit || !!busy} onClick={() => void centerArea()}>Usar un área centrada</button>}
          {tool === 'redact' && redactions.length > 0 && <><button className="secondary-button" onClick={() => setRedactions(previous => previous.slice(0, -1))}>Quitar última área</button><button className="primary-button" onClick={() => setWorkbench('redact')}>Revisar {plural(redactions.length, 'área', 'áreas')}</button></>}
          {!(touchLayout && mobileAnnotating && tool === 'note') && <IconButton label="Terminar herramienta" onClick={() => { setTool('select'); setRedactions([]); }}><X size={15} /></IconButton>}
        </div>}


      </main>

      {(notesOpen || notesLeaving) && <aside className={`notes-panel${touchLayout ? ' mobile-drawer' : ''}${notesLeaving ? ' closing' : ''}`} role={touchLayout ? 'dialog' : undefined} aria-modal={touchLayout ? true : undefined} aria-label={touchLayout ? 'Anotaciones' : undefined}>{touchLayout && <><SheetHandle onClose={closeMobilePanel} label="Cerrar explorador" /><div className="mobile-drawer-heading"><h2>Explorar</h2><IconButton label="Cerrar panel" onClick={closeMobilePanel}><X size={20} /></IconButton></div>{explorerTabs}</>}{!touchLayout && <div className="notes-heading"><div><MessageSquare size={17} /><h2>Anotaciones</h2><span>{annotations.length}</span></div><IconButton label="Cerrar anotaciones" onClick={() => { setNotesOpen(false); focusRail('Anotaciones'); }}><X size={16} /></IconButton></div>}<div className="notes-scroll" id={touchLayout ? 'explorer-panel' : undefined} role={touchLayout ? 'tabpanel' : undefined}>{doc && <AnnotationsPanel annotations={annotations} documentName={doc.name} activeId={activeNote} editable={!!doc.canAnnotate && !busy && !loading} pageName={pageName}
          onSelect={item => { mobilePage(item.page); setActiveNote(item.id); }} onDelete={item => { removeAnnotation(item.id); notify(item.kind === 'note' ? 'Nota eliminada.' : item.kind === 'ink' ? 'Dibujo eliminado.' : 'Resaltado eliminado.', 'info', { label: 'Deshacer', run: undo }); }} onEditNote={item => editNote(item, 'list')}
          onCopy={async text => { if (isNative && isIOS) await copyNativeText(text); else await navigator.clipboard.writeText(text); }}
          onSave={(text, name) => saveExport(new TextEncoder().encode(text), name, 'txt', doc.nativeSource)} />}</div></aside>}
    </div>

    {touchLayout && <DocumentSwitcher open={mobileTabs && !library} documents={tabs.map(tab => ({ key: tab.key, id: tab.doc.id, name: tab.doc.name, page: tab.key === activeTabKey ? page : tab.page, pages: tab.doc.pdf.numPages }))} recents={recents} activeKey={activeTabKey} disabled={!!busy || loading || editorDraft} onDismiss={() => setMobileTabs(false)} onSelect={key => { setMobileTabs(false); requestAnimationFrame(() => { closeMobilePanel(); if (key === activeTabKey) setLibrary(false); else void switchTab(key); }); }} onRecent={recent => { setMobileTabs(false); requestAnimationFrame(() => { closeMobilePanel(); void reopenRecent(recent); }); }} onCloseDocument={key => { setMobileTabs(false); requestAnimationFrame(() => void closeTab(key)); }} onImport={() => { setMobileTabs(false); requestAnimationFrame(() => void chooseFile()); }} onLibrary={() => { setMobileTabs(false); void returnToLibrary(); }} />}
    {touchLayout && mobileActions && <Modal title="Acciones del documento" onClose={() => setMobileActions(false)} className="mobile-actions-modal">
      {storageFailed ? <p className="mobile-storage-error" role="alert">{sessionStatus}</p> : <p className="mobile-save-status"><Check size={17} />{sessionStatus}</p>}
      <div className="mobile-file-actions"><button className="primary-button" aria-label={doc?.drive ? saveLabel : savesInPlace ? 'Guardar PDF' : isNative ? 'Guardar una copia del PDF' : 'Descargar PDF'} onClick={() => mobileAction(() => void download())} disabled={!doc || !!busy || loading}><ArrowDownToLine size={20} /><span>{saveLabel}</span></button></div>
      {/* PDFs created in Folio, recovered changes and the sample are saved as new files, so Guardar is the only save. */}
      {savesOriginal ? <p className="modal-description">Guardar actualiza el PDF original.</p> : savesInPlace && doc && !doc.drive && <p className="modal-description">Podrás elegir dónde guardar este PDF.</p>}
      {doc && (!doc.canAnnotate || isNativePdfDocument(doc.pdf)) && <p className="mobile-capability-summary">{capabilitySummary}</p>}
      <div className="mobile-action-grid">
        {/* Annotation mode has its own history buttons; here they appear, as a pair, only with something to revert. */}
        {(undoStack.current.length > 0 || redoStack.current.length > 0) && <><button onClick={() => mobileAction(undo)} disabled={!!busy || !undoStack.current.length}><Undo2 size={21} /><span>Deshacer</span></button><button onClick={() => mobileAction(redo)} disabled={!!busy || !redoStack.current.length}><Redo2 size={21} /><span>Rehacer</span></button></>}
        {doc?.drive && <button onClick={() => mobileAction(() => { setDriveLibrary(true); setLibrary(true); })}><Cloud size={20} /><span>Ver Drive</span></button>}
        {(doc?.drive || savesOriginal) && <button onClick={() => mobileAction(() => void download({ copy: true }))} disabled={!doc || !!busy || loading}><FilePlus2 size={21} /><span>Guardar una copia</span></button>}
        {tablet && <><button onClick={() => { const anchor = actionsAnchor(); mobileAction(() => void shareDocument(anchor)); }} disabled={!doc || !!busy}><Upload size={21} /><span>Compartir PDF</span></button><button onClick={() => mobileAction(openEditor)} disabled={!doc?.canEdit || !!busy}><FileText size={21} /><span>Editar PDF</span></button></>}
        <button onClick={() => mobileAction(() => setViewSettings(true))} disabled={!doc}><Settings2 size={21} /><span>Vista del documento</span></button>
        <button onClick={() => mobileAction(openTools)} disabled={!doc || !!busy}><Wrench size={21} /><span>Herramientas</span></button>
        <button onClick={() => { const anchor = actionsAnchor(); mobileAction(() => void printDocument(anchor)); }} disabled={!doc?.canPrint || !!busy}><Printer size={21} /><span>Imprimir PDF</span></button>
        <button onClick={() => mobileAction(() => setInfo(true))} disabled={!doc}><Info size={21} /><span>Información del documento</span></button>
        <button className="mobile-close-document" onClick={() => mobileAction(() => { if (activeTabKey) void closeTab(activeTabKey); })} disabled={!!busy || loading}><X size={21} /><span>Cerrar documento</span></button>
      </div>
    </Modal>}
    {!touchLayout && mobileActions && <Modal title="Acciones del documento" onClose={() => setMobileActions(false)} className="desktop-actions-menu">
      {doc?.drive && <button className="text-button" onClick={() => mobileAction(() => { setDriveLibrary(true); setLibrary(true); })}><Cloud size={16} />Ver Drive</button>}
      {storageFailed && <p className="desktop-save-status" role="alert">{sessionStatus}</p>}
      <div className="desktop-document-actions">
        {isNative && <button aria-label="Guardar una copia" disabled={!doc || !!busy || loading} onClick={() => mobileAction(() => void download({ copy: true }))}><FilePlus2 size={19} /><span>Guardar una copia…</span><span>{shortcutLabel('S', true)}</span></button>}
        {/* The toolbar holds zoom and the rail returns to the library, so neither repeats here. */}
        <button onClick={() => mobileAction(() => setReadingMode(readingMode === 'single' ? 'continuous' : 'single'))}><Layers size={19} /><span>{readingMode === 'single' ? 'Ver páginas en continuo' : 'Ver una página a la vez'}</span></button>
        <button onClick={() => mobileAction(() => setRotation(value => (value + 90) % 360))}><RotateCw size={19} /><span>Girar vista 90°</span></button>
        <button aria-label="Imprimir PDF" disabled={!doc?.canPrint || !!busy} onClick={() => mobileAction(() => void printDocument())}><Printer size={19} /><span>Imprimir PDF</span></button>
        {!isNative && document.fullscreenEnabled && <button aria-label="Pantalla completa" onClick={() => mobileAction(() => void fullscreen())}><Maximize size={19} /><span>Pantalla completa</span></button>}
        <button onClick={() => mobileAction(() => setInfo(true))}><Info size={19} /><span>Información del documento</span></button>
        <button onClick={() => mobileAction(() => { if (activeTabKey) void closeTab(activeTabKey); })}><X size={19} /><span>Cerrar documento</span></button>
      </div>
    </Modal>}
    {phone && annotationOptions && <Modal title="Opciones de anotación" onClose={() => setAnnotationOptions(false)}><div className="mobile-action-grid"><button onClick={() => { setAnnotationOptions(false); setSidebar(false); setNotesOpen(true); }}><MessageSquare size={21} />Ver anotaciones ({annotations.length})</button><button onClick={() => { setAnnotationOptions(false); openTools(); }}><Wrench size={21} />Herramientas</button></div></Modal>}
    {touchLayout && pageJump && doc && <Modal title="Ir a página" onClose={() => setPageJump(false)} className="page-jump-modal"><form onSubmit={event => { event.preventDefault(); const next = Number(pageInput); if (Number.isInteger(next) && next >= 1 && next <= doc.pdf.numPages) { rememberLocation(); setPageJump(false); requestAnimationFrame(() => goToPage(next, false)); } }}><label htmlFor="jump-page-number">Página (1–{doc.pdf.numPages})</label><input id="jump-page-number" autoFocus data-autofocus type="text" inputMode="numeric" pattern="[0-9]+" value={pageInput} onChange={event => setPageInput(event.target.value.replace(/\D/g, ''))} /><label className="reading-setting"><span>Recorrer páginas</span><input aria-label="Recorrer páginas" type="range" min="1" max={doc.pdf.numPages} value={Math.max(1, Math.min(doc.pdf.numPages, Number(pageInput) || page))} onChange={event => setPageInput(event.target.value)} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setPageJump(false)}>Cancelar</button><button className="primary-button" disabled={!Number.isInteger(Number(pageInput)) || Number(pageInput) < 1 || Number(pageInput) > doc.pdf.numPages}>Ir a página</button></div></form></Modal>}

    {viewSettings && <ViewSettings touch={touchLayout} mode={readingMode} onMode={setReadingMode} zoom={zoomMode} scale={scale} onZoom={value => { if (['width', 'page'].includes(value)) setZoomMode(value); else { setCustomScale(Number(value) / 100); setZoomMode('custom'); } }} rotation={rotation} onRotate={() => setRotation(value => (value + 90) % 360)} onClose={() => setViewSettings(false)} />}
    {capabilityNotice && <Modal title="Herramientas disponibles" onClose={() => setCapabilityNotice(false)}><p className="modal-description">{capabilitySummary}</p><div className="modal-actions"><button className="primary-button" onClick={() => setCapabilityNotice(false)}>Entendido</button></div></Modal>}
    <TextSelectionMenu key={doc?.pdf.loadingTask.docId} enabled={!!doc?.canCopy && !mobileActions && tool === 'select' && !loading && !busy && !noteDraft && !workbench && !creating && !library && !settings && !help && !info && !password && !closeBlocked && !pageJump && !viewSettings && !annotationOptions && !capabilityNotice && !deleteTarget && !(touchLayout && (sidebar || notesOpen || mobileActions || mobileTabs))} canAnnotate={!!doc?.canAnnotate} color={color} onHighlight={() => { highlightSelection(); }} onComment={() => { commentSelection(); }} onNotify={(message, error) => notify(message, error ? 'error' : 'success')} />
    {dragOver && <div className="drop-overlay"><div><Upload size={38} /><h2>Suelta para abrir</h2><p>Archivos PDF</p></div></div>}
    {creating && <CreatePDF onClose={() => setCreating(false)} onCreate={async (bytes, name) => { await openDocument(bytes, name, false, undefined, { modified: true, useSession: false }); setCreating(false); }} />}
    <ActivityPill working={activity} done={activityDone} />
    {doc && <ColumnSelectionPreview />}
    {shownToast && <div key={shownToast.id} ref={toastRef} popover="manual" className={`toast ${shownToast.kind === 'error' ? 'error' : ''}${toast ? '' : ' closing'}`}>{shownToast.kind === 'error' ? <CircleAlert size={18} /> : shownToast.kind === 'info' ? <Info size={18} /> : <Check size={18} />}<span>{shownToast.message}</span>{shownToast.action && <button type="button" className="toast-action" onClick={() => { const action = shownToast.action!; setToast(null); action.run(); }}>{shownToast.action.label}</button>}<button aria-label="Cerrar aviso" onClick={() => setToast(null)}><X size={15} /></button></div>}
    <div className="sr-only" role="status">{toast && toast.kind !== 'error' && <span key={toast.id}>{toast.message}</span>}</div>
    <div className="sr-only" role="alert">{toast?.kind === 'error' && <span key={toast.id}>{toast.message}</span>}</div>

    {library && <div className={`library-screen${phone ? '' : ' desktop-library-screen'}`}>{driveLibrary ? <DriveBrowser onClose={() => setDriveLibrary(false)} onOpen={openDriveDocument} onSynced={driveSynced} conflicts={driveConflicts} onConflicts={setDriveConflicts} /> : libraryContent}</div>}
    {driveRefresh && <TransferCard transfer={driveRefresh} />}
    {deleteTarget && <Modal title={isDesktop ? 'Quitar de la biblioteca' : 'Eliminar de la biblioteca'} onClose={() => setDeleteTarget(null)}><p className="modal-description">{isDesktop ? `Se quitará «${deleteTarget.name}» de la biblioteca junto con sus anotaciones, marcadores y cambios guardados en este equipo.` : `Se eliminarán de ${here} la copia de «${deleteTarget.name}», sus anotaciones, marcadores y cambios guardados.`} El archivo original no se modifica.{tabs.some(tab => tab.doc.id === deleteTarget.id) && ' El documento abierto se cerrará y perderás los cambios que no hayas guardado en un PDF.'}</p><div className="modal-actions"><button className="secondary-button" onClick={() => setDeleteTarget(null)}>Cancelar</button><button className="primary-button destructive-button" disabled={!!busy || loading} onClick={() => void forgetRecent(deleteTarget)}>{isDesktop ? 'Quitar de la biblioteca' : 'Eliminar copia y cambios'}</button></div></Modal>}
    {!inlineEditing && workbenchPanel}
    {noteDraft && <Modal title={noteDraft.id ? 'Editar nota' : 'Añadir nota'} onClose={() => setNoteDraft(null)} className="note-modal"><div className="note-page-label"><StickyNote size={16} />Página {pageName(noteDraft.page)}</div><textarea autoFocus data-autofocus aria-label="Texto de la nota" placeholder="Escribe una nota…" value={noteText} maxLength={5000} onChange={e => setNoteText(e.target.value)} /><div className="note-modal-footer"><span>{noteText.length} / 5000</span><button className="secondary-button" onClick={() => setNoteDraft(null)}>Cancelar</button><button className="primary-button" disabled={!noteText.trim()} onClick={saveNote}><Check size={16} />Guardar nota</button></div></Modal>}
    {password && <Modal title="Este PDF tiene contraseña" onClose={cancelPassword} className="password-modal"><p className="modal-description">Introduce la contraseña para abrir «{password.name}».</p><form onSubmit={e => { e.preventDefault(); if (passwordText) { password.submit(passwordText); setPassword(null); } }}><label htmlFor="pdf-password">Contraseña</label><input autoFocus data-autofocus id="pdf-password" type="password" value={passwordText} onChange={e => setPasswordText(e.target.value)} autoComplete="off" />{password.retry && <p className="password-error">La contraseña anterior no es correcta. Inténtalo de nuevo.</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={cancelPassword}>Cancelar</button><button className="primary-button" disabled={!passwordText}><LockKeyhole size={15} />Abrir PDF</button></div></form></Modal>}
    {info && doc && <Modal title="Información del documento" onClose={() => setInfo(false)} className="info-modal"><div className="info-file"><FileText size={30} /><strong>{doc.name}</strong></div><dl className="document-details"><div><dt>Páginas</dt><dd>{doc.pdf.numPages}</dd></div><div><dt>Tamaño</dt><dd>{formatSize(doc.size)}</dd></div><div><dt>Anotaciones de Folio</dt><dd>{annotations.length}</dd></div><div><dt>Marcadores</dt><dd>{bookmarks.length}</dd></div></dl></Modal>}
    {settings && <ReadingSettings layout={layout} theme={theme} onTheme={chooseTheme} zoom={defaultZoom} onZoom={setDefaultZoom} preferences={readingPreferences} onPreferences={setReadingPreferences} rememberRecent={rememberRecent} onRemember={setRememberRecent} openDocuments={tabs.length} confirmClear={confirmClear} onClear={() => void clearLibrary()} onCancelClear={() => setConfirmClear(false)} onClose={() => setSettings(false)} />}
    {help && <Modal title={touchLayout ? 'Ayuda' : 'Ayuda y atajos'} onClose={() => setHelp(false)} className="help-modal">
      <div className="help-feature"><Highlighter size={21} /><div><strong>Anotar</strong><p>{touchLayout ? 'Mantén pulsado el texto para copiarlo, resaltarlo o comentarlo. Anotar muestra el resaltador, las notas, el lápiz y la goma; Listo vuelve a la lectura. Toca un resaltado para cambiar su color, comentarlo o borrarlo.' : 'Selecciona texto para copiarlo, resaltarlo o comentarlo. Anotar muestra el resaltador, las notas, el lápiz y la goma. Con el resaltador activo, cada selección queda resaltada; haz clic en un resaltado para cambiarlo o borrarlo.'}</p></div></div>
      <div className="help-feature"><ShieldCheck size={21} /><div><strong>Guardar cambios</strong><p>Los cambios se conservan en {here}. {savesInPlace ? `Guardar${touchLayout ? '' : ` (${shortcutLabel('S')})`} actualiza el PDF original; Guardar una copia crea otro archivo.` : `Para tenerlos en un PDF, usa ${fileSaveLabel}${touchLayout ? ' o Compartir' : ` (${shortcutLabel('S')})`}.`}</p></div></div>
      {touchLayout ? <div className="help-feature"><Layers size={21} /><div><strong>Navegar</strong><p>Toca el nombre del documento para cambiar de PDF. Páginas reúne miniaturas, índice, marcadores y anotaciones. Toca el número de página para ir a otra. Pellizca para ampliar y toca el PDF para ocultar o mostrar los controles.</p></div></div> : <>
        <h3 className="shortcuts-heading">Atajos de teclado</h3><div className="shortcut-grid">{shortcuts.map(([label, keys]) => <div key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}</div>
        <p className="help-limit">Usa Herramientas para editar, organizar páginas, rellenar formularios, reconocer texto, comparar documentos o trabajar con firmas.</p>
      </>}
    </Modal>}
  </div>;
}
