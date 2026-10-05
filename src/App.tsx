import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, BookOpen, Bookmark, Check,
  ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Cloud, FileText, FolderOpen,
  PenLine, Eraser, Highlighter, Info, Keyboard, Layers, ListTree, LoaderCircle, LockKeyhole,
  Maximize, MessageSquare, Minus, MoreHorizontal, MousePointer2,
  Plus, Printer, Redo2, RotateCw, Search, ShieldCheck,
  Settings2, Sparkles, StickyNote, Trash2, Undo2, Upload, X, Wrench, FilePlus2,
} from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import PDFPage, { Thumbnail } from './components/PDFPage';
import Modal, { SheetHandle } from './components/Modal';
import DocumentLibrary from './components/DocumentLibrary';
import { DriveBrowser } from './components/DriveBrowser';
import { driveLookup, driveStage, driveStageNative, driveSync, type DriveBinding, type DriveOpened } from './drive';
import DocumentSwitcher from './components/DocumentSwitcher';
import DocumentOutline from './components/DocumentOutline';
import ViewSettings from './components/ViewSettings';
import { buildTextIndex, exportAnnotated, formatSize, getDocument, readOutline, searchText, pageText, readPageLabels, readPageLabel } from './pdf';
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
import ReadingSettings from './components/ReadingSettings';
import { readReadingPreferences } from './reading-preferences';
import { addPageBookmark, hasBookmarkPage, normalizeBookmarks, remapBookmarks } from './bookmarks';
import { commentSelection, highlightSelection } from './text-selection';
import type { AnnotationDraft } from './text-selection';
import './tabs.css';
import './mac-platform.css';
import './mobile.css';
import './desktop.css';
import './tablet.css';
import { TabletReaderHeader, TabletAnnotationDock } from './components/TabletReaderControls';
import { useDeviceLayout } from './mobile';
import { useDocumentTabDrag } from './useDocumentTabDrag';
import { assetUrl, pdfAssetSettings } from './assets';
import { isDesktop, isNative, isIOS, isAndroid, isMobile, isMac, setAndroidReaderChrome, shortcutLabel, pickNativeDocuments, readNativeDocument, savePdf, saveOriginalPdf, sharePdf, printPdf, presentNativePdf, nativeDraftDocument, startupDocuments, openExternalUrl } from './platform';
import { clearSavedState, forgetDocument, listLibrary, readLibrarySource, hideRecent, readSession, rememberDocument, saveSession, readDraft, storeDraft, discardDraft } from './storage';
import type { Annotation, BookmarkNode, LoadedDocument, OutlineEntry, RecentDocument, Session, SideTab, Tool } from './types';

const DEFAULT_HIGHLIGHT_COLOR = '#f5d164';
const SAMPLE_NAME = 'El arte de observar.pdf';
const annotationFingerprint = (items: Annotation[]) => JSON.stringify(items.map(a => [a.id, a.page, a.kind, a.rect, a.text, a.color, a.quads, a.inkPaths, a.strokeWidth]));
const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const preference = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? String(error.message) : 'No se pudo completar la operación.';
type OpenSource = Blob | Uint8Array | 'sample' | NativeDocument;
const nativeReadingThreshold = 32 * 1024 * 1024;
type NoteDraft = Omit<Annotation, 'id' | 'created'> & { id?: string };
type OpenContext = { drive?: DriveBinding; savedCopy?: boolean; keepEditing?: boolean; draftSource?: boolean; id?: string; password?: string; modified?: boolean; useSession?: boolean; preserveHistory?: boolean; page?: number; bookmarks?: BookmarkNode[] };
type History = { annotations: Annotation[]; bytes?: Uint8Array; password?: string; page?: number; bookmarks?: BookmarkNode[] };
type TabView = { page: number; dimensions: { width: number; height: number; rotation: number }; zoomMode: string; customScale: number; rotation: number; readingMode: 'continuous' | 'single'; annotating: boolean; tool: Tool; color: string; sidebar: boolean; sideTab: SideTab; notesOpen: boolean; outline: OutlineEntry[]; textIndex: string[]; indexing: boolean; searchOpen: boolean; query: string; resultIndex: number; activeNote: string | null; redactions: Area[]; editArea: Area | null; sessionFailed: boolean; draftFailed: boolean };
type DocumentTab = TabView & { key: string; doc: LoadedDocument; annotations: Annotation[]; bookmarks: BookmarkNode[]; undo: History[]; redo: History[]; scrollTop: number; scrollLeft: number };

function IconButton({ children, label, onClick, onMouseDown, disabled = false, active = false, toggle = false, className = '' }: { children: React.ReactNode; label: string; onClick: () => void; onMouseDown?: React.MouseEventHandler<HTMLButtonElement>; disabled?: boolean; active?: boolean; toggle?: boolean; className?: string }) {
  return <button className={`icon-button ${active ? 'active' : ''} ${className}`} aria-label={label} aria-pressed={toggle ? active : undefined} title={label} onClick={onClick} onMouseDown={onMouseDown} disabled={disabled}>{children}</button>;
}

export default function App() {
  const layout = useDeviceLayout(), phone = layout === 'phone', tablet = layout === 'tablet', touchLayout = phone || tablet;
  const [tabletInkOptions, setTabletInkOptions] = useState(false);
  const [mobileActions, setMobileActions] = useState(false);
  const [mobileTabs, setMobileTabs] = useState(false);
  const [mobileAnnotating, setMobileAnnotating] = useState(false);
  const [readerChromeHidden, setReaderChromeHidden] = useState(false);
  const [doc, setDoc] = useState<LoadedDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'download' | 'print' | 'edit' | null>(null);
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
  const [inkColor, setInkColor] = useState(() => preference('folio.ink.color', '#2455b5'));
  const [inkWidth, setInkWidth] = useState(() => Number(preference('folio.ink.width', '2')) || 2);
  const [penOnly, setPenOnly] = useState(() => preference('folio.ink.penOnly', 'true') === 'true');
  useEffect(() => { try { localStorage.setItem('folio.ink.color', inkColor); localStorage.setItem('folio.ink.width', String(inkWidth)); localStorage.setItem('folio.ink.penOnly', String(penOnly)); } catch {} }, [inkColor, inkWidth, penOnly]);
  const [color, setColor] = useState(() => { const saved = preference('folio.highlightColor', DEFAULT_HIGHLIGHT_COLOR); return /^#[0-9a-f]{6}$/i.test(saved) ? saved : DEFAULT_HIGHLIGHT_COLOR; });
  const [sidebar, setSidebar] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>('pages');
  const [notesOpen, setNotesOpen] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkNode[]>([]);
  const [bookmarkEditingId, setBookmarkEditingId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [textIndex, setTextIndex] = useState<string[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const nativeSearchRequested = searchOpen && query.trim().length > 0;
  const [resultIndex, setResultIndex] = useState(0);
  const visitedSearch = useRef<string | null>(null);
  const [library, setLibrary] = useState(true);
  const [driveLibrary, setDriveLibrary] = useState(false);
  const [driveMessage, setDriveMessage] = useState('');
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
  const [password, setPassword] = useState<{ retry: boolean; submit: (value: string) => void } | null>(null);
  const [passwordText, setPasswordText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [sessionFailed, setSessionFailed] = useState(false);
  const [draftFailed, setDraftFailed] = useState(false);
  const storageFailed = sessionFailed || draftFailed;
  useEffect(() => { if (tool === 'highlight' || tool === 'note') setMobileAnnotating(true); }, [tool]);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('folio.theme') || 'light'; } catch { return 'light'; } });
  const [, setHistoryTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
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
  const librarySave = useRef<Promise<void>>(Promise.resolve());
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const saving = useRef(false);
  const dragCounter = useRef(0);
  const passwordCancelled = useRef(false);
  const forgottenIds = useRef(new Set<string>());
  const preferencesRef = useRef({ rememberRecent, defaultZoom });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentScale = useRef(1);
  const phoneRef = useRef(phone); phoneRef.current = phone;
  const touchRef = useRef(touchLayout); touchRef.current = touchLayout;
  const wheelAnchor = useRef<{ id: string; page: number; x: number; y: number; pointerX: number; pointerY: number } | null>(null);
  const activeView = useRef<TabView>(null!);
  activeView.current = { page, dimensions, zoomMode, customScale, rotation, readingMode, annotating: mobileAnnotating, tool, color, sidebar, sideTab, notesOpen, outline, textIndex, indexing, searchOpen, query, resultIndex, activeNote, redactions, editArea, sessionFailed, draftFailed };
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
    setSearchOpen(tab.searchOpen); setQuery(tab.query); setResultIndex(tab.resultIndex); setActiveNote(tab.activeNote);
    setRedactions(tab.redactions); setEditArea(tab.editArea); setSessionFailed(tab.sessionFailed); setDraftFailed(tab.draftFailed); setBookmarkEditingId(null);
    setWorkBenchClosed(); setHistoryTick(v => v + 1); window.getSelection()?.removeAllRanges();
    if (focusSelectedTab) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.document-tab[data-tab-key="${CSS.escape(tab.key)}"] [role=tab]`)?.focus({ preventScroll: true }));
  }
  function setWorkBenchClosed() { setWorkbench(null); setInfo(false); setLibrary(false); setNoteDraft(null); setPageJump(false); setViewSettings(false); setAnnotationOptions(false); setCapabilityNotice(false); }
  async function persistTab(tab: DocumentTab) {
    await draftSave.current;
    if (forgottenIds.current.has(tab.doc.id)) return;
    if (tab.doc.modified && !isNativePdfDocument(tab.doc.pdf)) await storeDraft(tab.doc.id, tab.doc.bytes);
    const saved = await saveSession(tab.doc.id, { annotations: tab.annotations, lastPage: tab.page, bookmarks: tab.bookmarks, documentRevision: tab.doc.revision, nativeKnownPages: tab.doc.nativeKnownPages, nativeOriginalRefs: tab.doc.nativeOriginalRefs, nativeSavedAnnotations: tab.doc.savedAnnotations, nativeLegacySession: tab.doc.nativeLegacySession });
    if (!saved) throw new Error('No se pudo conservar la sesión. Guarda el PDF antes de cerrar la pestaña.');
    if (tab.doc.drive?.editable && (tab.doc.modified || annotationFingerprint(tab.annotations) !== tab.doc.savedAnnotations)) {
      if (isNativePdfDocument(tab.doc.pdf)) {
        if (tab.doc.nativeLegacySession) throw new Error('Guarda el PDF de Drive antes de cerrar para recuperar todas las anotaciones anteriores.');
        const removed = (tab.doc.nativeOriginalRefs || []).filter(ref => !tab.annotations.some(a => a.nativeSourceRef === ref));
        await driveStageNative(tab.doc.drive.binding, tab.doc.nativeSource!, tab.annotations, removed);
      } else await driveStage(tab.doc.drive.binding, tab.doc.canAnnotate ? await exportAnnotated(tab.doc.bytes, tab.annotations, tab.doc.password, undefined, true) : tab.doc.bytes);
    }
  }
  async function switchTab(key: string) {
    if (editorDraftRef.current) { notify('Aplica o descarta el borrador antes de cambiar de documento.'); return; }
    if (key === activeTabRef.current || busyRef.current || loadingRef.current || document.querySelector('dialog[open]')) return;
    const next = tabsRef.current.find(tab => tab.key === key); if (!next) return;
    if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) await closeWorkbench();
    const focusSelectedTab = document.activeElement?.getAttribute('role') === 'tab';
    try {
      loadingRef.current = true; setLoading(true);
      const current = captureTab(); if (current) await persistTab(current);
      retainCurrentTab(); activateTab(next, focusSelectedTab); publishTabs();
    } catch (error) { notify(error instanceof Error ? error.message : 'No se pudo cambiar de pestaña.', true); }
    finally { loadingRef.current = false; setLoading(false); }
  }
  async function closeTab(key: string) {
    if (editorDraftRef.current) { notify('Aplica o descarta el borrador antes de cerrar el documento.'); return; }
    if (busyRef.current || loadingRef.current || document.querySelector('dialog[open]')) return;
    const index = tabsRef.current.findIndex(tab => tab.key === key); if (index < 0) return;
    if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) await closeWorkbench();
    try {
      loadingRef.current = true; setLoading(true); retainCurrentTab();
      const closed = tabsRef.current[index]; await persistTab(closed);
      tabsRef.current = tabsRef.current.filter(tab => tab.key !== key);
      if (activeTabRef.current === key) {
        const next = tabsRef.current[Math.min(index, tabsRef.current.length - 1)];
        if (next) activateTab(next);
        else {
          pageInputDirty.current = false; setPageInput('1'); setPage(1);
          activeTabRef.current = null; setActiveTabKey(null); docRef.current = null; annotationRef.current = []; undoStack.current = []; redoStack.current = [];
          setReaderChromeHidden(false); setDoc(null); setAnnotations([]); setBookmarks([]); setOutline([]); setTextIndex([]); setQuery(''); setSearchOpen(false); setNotesOpen(false); setSidebar(false); setTool('select'); setRedactions([]); setEditArea(null); setWorkBenchClosed(); setMobileAnnotating(false); setLibrary(true);
        }
      }
      publishTabs(); setTimeout(() => { void closed.doc.pdf.loadingTask.destroy(); }, 200);
    } catch (error) { notify(error instanceof Error ? error.message : 'No se pudo cerrar la pestaña.', true); }
    finally { loadingRef.current = false; setLoading(false); }
  }

  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), error ? 7000 : 3500);
  }, []);

  const loadDocument = useCallback(async (source: OpenSource, name = SAMPLE_NAME, sample = false, nativeSource?: string, context?: OpenContext) => {
    if (editorDraftRef.current && !context?.preserveHistory) { notify('Aplica o descarta el borrador antes de abrir otro documento.'); return false; }
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
        const priorTab = captureTab(); if (priorTab) await persistTab(priorTab);
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
          if (draft) { nativeFile = draft; nativeSource = draft.token; modified = true; notify('Borrador recuperado. Usa Guardar para crear el PDF.'); }
        }
        let opened;
        while (!opened) {
          try { opened = await openNativePdf(nativeFile!, documentPassword, controller.signal); }
          catch (error) {
            if (!isNativePdfPasswordError(error)) throw error;
            documentPassword = await new Promise<string>((resolve, reject) => {
              const cancel = () => reject(new DOMException('Operación cancelada', 'AbortError'));
              controller.signal.addEventListener('abort', cancel, { once: true });
              setPassword({ retry: error.retry, submit: value => { controller.signal.removeEventListener('abort', cancel); resolve(value); } });
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
        originalBytes = bytes; id = context?.id || driveId || await digest(bytes);
        if (!context) {
          const existing = tabsRef.current.find(tab => tab.doc.id === id);
          if (existing) { retainCurrentTab(); activateTab(tabsRef.current.find(tab => tab.key === existing.key)!); publishTabs(); setLoading(false); loadingRef.current = false; return true; }
        }
        if (!context) {
          const draft = await readDraft(id);
          if (draft) { bytes = draft; modified = true; notify('Borrador recuperado. Usa Guardar para crear el PDF.'); }
        }
        revision = await digest(bytes); size = bytes.length;
        const task = getDocument({ data: new Uint8Array(bytes), password: documentPassword, ...pdfAssetSettings() });
        taskRef.current = task;
        task.onPassword = (submit: (value: string) => void, reason: number) => { if (request === loadRequest.current) { setPassword({ retry: reason === 2, submit: value => { documentPassword = value; submit(value); } }); setPasswordText(''); } };
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
      if (!context) forgottenIds.current.delete(id);
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
      const session: Session = context?.useSession === false ? { annotations: inspection.annotations, bookmarks: context.bookmarks || [], lastPage: context.page || 1, version: 2 } : await readSession(id);
      if (!context && !readingPreferencesRef.current.restorePage) session.lastPage = 1;
      if (request !== loadRequest.current) { await pdf.loadingTask.destroy(); return; }
      const loaded: LoadedDocument = { pdf, bytes, id, revision, modified, savedAnnotations: annotationFingerprint(inspection.annotations), draftSource: context?.draftSource || (!nativeSource && modified && isNative), name, size, sample: sample || source === 'sample', password: documentPassword, nativeSource, canAnnotate: inspection.canAnnotate, canEdit: inspection.canEdit, canAssemble: inspection.canAssemble, canFill: inspection.canFill, canCopy: inspection.canCopy, canPrint: inspection.canPrint, signed: inspection.signed, initialPage: session.lastPage, hadAnnotations: inspection.annotations.length > 0 };
      const replacing = !!context?.preserveHistory || !!context?.savedCopy;
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
      setOutline([]); setTextIndex([]); setSessionFailed(false); setDraftFailed(false); setPassword(null); setInfo(false);
      setLoading(false); loadingRef.current = false; taskRef.current = null;
      const tab: DocumentTab = { ...activeView.current, tool: restoredTool, key, doc: loaded, annotations: annotationRef.current, bookmarks: restoredBookmarks, page: readingState.current.page,
        dimensions: { width: view.width, height: view.height, rotation: first.rotate }, undo: undoStack.current, redo: redoStack.current,
        scrollTop: replacing ? previousTab?.scrollTop || 0 : 0, scrollLeft: replacing ? previousTab?.scrollLeft || 0 : 0,
        outline: [], textIndex: [], indexing: true, redactions: [], editArea: null, sessionFailed: false, draftFailed: false,
        ...(replacing ? {} : { annotating: false, readingMode: readingPreferencesRef.current.mode, rotation: 0, zoomMode: initialZoomMode, customScale: initialScale, sidebar: initialPanel !== 'closed', sideTab: initialPanel === 'closed' ? 'pages' as SideTab : initialPanel, tool: 'select' as Tool, searchOpen: false, query: '', resultIndex: 0, notesOpen: false, activeNote: null }) };
      tabsRef.current = replacing ? tabsRef.current.map(existing => existing.key === key ? tab : existing) : [...tabsRef.current, tab];
      publishTabs();
      if (previous) setTimeout(() => { void previous.pdf.loadingTask.destroy(); }, 200);
      if (!loaded.sample) {
        if (!context?.preserveHistory && !(context?.modified && nativeSource)) librarySave.current = librarySave.current.catch(() => {}).then(async () => {
          if (forgottenIds.current.has(id)) return;
          await rememberDocument({ id, name, size, pages: pdf.numPages, openedAt: Date.now(), nativeSource: nativeInput?.token || nativeSource, data: nativeSource ? undefined : new Blob([new Uint8Array(originalBytes).buffer], { type: 'application/pdf' }) });
          if (!preferencesRef.current.rememberRecent) await hideRecent(id);
        }).catch(() => notify('No se pudo recordar este PDF en la biblioteca.', true));
        if (inspection.signed) notify('PDF firmado: modo lectura.');
        else if (!inspection.canAnnotate) notify('PDF abierto en modo lectura según sus permisos.');
      }
      return true;
    } catch (error) {
      if (request !== loadRequest.current) return;
      if (!passwordCancelled.current) {
        const detail = errorMessage(error);
        const err = error instanceof Error ? error : new Error(detail);
        console.error('Folio: no se pudo abrir el PDF.', error);
        notify(err.name === 'InvalidPDFException' ? 'Este archivo no es un PDF válido o está dañado.' : err.name === 'PasswordException' ? 'No se pudo desbloquear este PDF.' : `No se pudo abrir ${name}. ${detail}`, true);
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
    draftSave.current = draftSave.current.catch(() => {}).then(async () => {
      if (forgottenIds.current.has(doc.id)) return;
      await storeDraft(doc.id, doc.bytes);
      if (doc.draftSource && !forgottenIds.current.has(doc.id)) { await rememberDocument({ id: doc.id, name: doc.name, size: doc.size, pages: doc.pdf.numPages, openedAt: Date.now(), draft: true }); if (!preferencesRef.current.rememberRecent) await hideRecent(doc.id); }
    });
    void draftSave.current.then(() => { if (docRef.current?.id === doc.id && docRef.current?.revision === doc.revision) setDraftFailed(false); })
      .catch(() => { if (docRef.current?.id === doc.id && docRef.current?.revision === doc.revision) { setDraftFailed(true); notify('No se pudo conservar el borrador. Guarda el PDF antes de cerrar.', true); } });
  }, [doc, notify]);

  useEffect(() => {
    preferencesRef.current = { rememberRecent, defaultZoom };
    try { localStorage.setItem('folio.remember', String(rememberRecent)); localStorage.setItem('folio.defaultZoom', defaultZoom); } catch { /* Settings are still usable for this session. */ }
  }, [rememberRecent, defaultZoom]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? media.matches ? 'dark' : 'light' : theme;
      document.documentElement.dataset.theme = resolved;
      if (isNative && isMobile) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_mobile_theme', { theme: resolved })).catch(() => {});
    };
    apply();
    media.addEventListener('change', apply);
    try { localStorage.setItem('folio.theme', theme); } catch { /* Reading stays available without storage. */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    try { localStorage.setItem('folio.readingPreferences', JSON.stringify(readingPreferences)); } catch { /* Preferences remain active for this session. */ }
  }, [readingPreferences]);
  useEffect(() => { try { localStorage.setItem('folio.highlightColor', color); } catch { /* The selected color still works for this session. */ } }, [color]);
  useEffect(() => { if (!pageInputDirty.current) setPageInput(String(page)); }, [page]);
  useEffect(() => {
    const selected = document.querySelector<HTMLElement>('.document-tab.selected'), strip = selected?.parentElement;
    if (!selected || !strip) return;
    const left = selected.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (left + selected.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + selected.offsetWidth - strip.clientWidth;
  }, [activeTabKey]);
  useEffect(() => {
    if (!doc || forgottenIds.current.has(doc.id)) return;
    const timeout = setTimeout(() => {
      if (forgottenIds.current.has(doc.id)) return;
      void saveSession(doc.id, { annotations, bookmarks, lastPage: page, documentRevision: doc.revision, nativeKnownPages: doc.nativeKnownPages, nativeOriginalRefs: doc.nativeOriginalRefs, nativeSavedAnnotations: doc.savedAnnotations, nativeLegacySession: doc.nativeLegacySession }).then(success => { if (docRef.current?.id === doc.id && docRef.current?.revision === doc.revision) setSessionFailed(!success); });
    }, 200);
    return () => clearTimeout(timeout);
  }, [doc, annotations, bookmarks, page]);
  useEffect(() => {
    if (isDesktop) return;
    const preserve = () => {
      retainCurrentTab();
      for (const tab of tabsRef.current) void persistTab(tab).catch(() => { setSessionFailed(true); });
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
      } catch (error) { if (alive) notify(errorMessage(error), true); }
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
      import('@tauri-apps/api/event').then(({ listen }) => listen<string>('folio-open-error', event => { if (alive) notify(event.payload, true); })),
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
      if (alive && loadRequest.current === 0) setLoading(false);
    }).catch(() => {
      release();
      if (alive) { if (loadRequest.current === 0) setLoading(false); notify('No se pudo preparar la apertura de documentos.', true); }
    });
    return () => { alive = false; if (retry) clearTimeout(retry); release(); };
  }, [openDocument, notify]);
  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    const listener = import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const window = getCurrentWindow();
      return window.onCloseRequested(async event => {
        if (!alive || !tabsRef.current.length) return;
        event.preventDefault();
        if (editorDraftRef.current) { notify('Aplica o descarta el borrador antes de cerrar Folio.'); return; }
        if (busyRef.current || loadingRef.current || document.querySelector('.workbench .operation-loading')) { notify('Espera a que termine la operación antes de cerrar.'); return; }
        try { retainCurrentTab(); for (const tab of tabsRef.current) await persistTab(tab); await window.destroy(); }
        catch { setCloseBlocked(true); notify('No se pudo guardar la sesión. Puedes guardar una copia del PDF.', true); }
      });
    });
    return () => { alive = false; void listener.then(unlisten => unlisten()); };
  }, [notify]);
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    readOutline(doc.pdf).then(data => { if (alive) setOutline(data); }).catch(() => {});
    if (isNativePdfDocument(doc.pdf)) { setIndexing(false); return () => { alive = false; }; }
    setIndexing(true);
    buildTextIndex(doc.pdf, () => alive).then(data => { if (alive) { setTextIndex(data); setIndexing(false); } }).catch(error => { if (alive) { console.error('Folio: no se pudo indexar el PDF.', error); setIndexing(false); notify('Algunas páginas no se pudieron indexar para la búsqueda.', true); } });
    return () => { alive = false; };
  }, [doc, notify]);
  useEffect(() => {
    if (!doc || !isNativePdfDocument(doc.pdf)) return;
    if (!nativeSearchRequested) { setIndexing(false); return; }
    let alive = true;
    setIndexing(true);
    void (async () => {
      const text: string[] = [];
      for (let number = 1; alive && number <= doc.pdf.numPages; number++) {
        const content = await (await doc.pdf.getPage(number)).getTextContent();
        text.push(pageText(content));
        if (alive && (number % 10 === 0 || number === doc.pdf.numPages)) setTextIndex([...text]);
      }
      if (alive) setIndexing(false);
    })().catch(error => { if (alive) { setIndexing(false); notify(errorMessage(error), true); } });
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
      catch (error) { notify(error instanceof Error ? error.message : 'No se pudieron recuperar las anotaciones de la sesión anterior.', true); return; }
      doc.nativeKnownPages = [...doc.nativeKnownPages || [], number];
      doc.nativeOriginalRefs = [...new Set([...doc.nativeOriginalRefs || [], ...originals.flatMap(item => item.nativeSourceRef ? [item.nativeSourceRef] : [])])];
      annotationRef.current = nextAnnotations;
      if (doc.nativeKnownPages.length === doc.pdf.numPages) doc.nativeLegacySession = false;
      setAnnotations([...annotationRef.current]);
    });
  }, [doc]);
  useEffect(() => {
    let alive = true;
    if (library || mobileTabs) { setLibraryLoading(true); Promise.allSettled([librarySave.current, draftSave.current]).then(() => listLibrary()).then(items => { if (alive) setRecents(items); }).catch(() => { if (alive) { setRecents([]); notify('No se pudo abrir la biblioteca local.', true); } }).finally(() => { if (alive) setLibraryLoading(false); }); }
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
      if (root.clientWidth > 0 && root.clientHeight > 0) setViewportSize({ width: root.clientWidth, height: root.clientHeight });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [doc]);
  const chromeUpdate = useRef(Promise.resolve());
  const systemChromeVisible = !readerChromeHidden || !doc || library || !!workbench || !!noteDraft || mobileActions || mobileTabs || pageJump || settings || help || info;
  useEffect(() => {
    if (!isNative || !isAndroid) return;
    chromeUpdate.current = chromeUpdate.current.catch(() => {}).then(() => setAndroidReaderChrome(systemChromeVisible)).then(() => { window.dispatchEvent(new Event('folio:system-bars-changed')); }).catch(() => {});
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
      if (editorRestorePending.current) return;
      const bounds = root.getBoundingClientRect();
      const candidates = [...visible].map(node => {
        const box = node.getBoundingClientRect();
        return { node, height: Math.max(0, Math.min(bounds.bottom, box.bottom) - Math.max(bounds.top, box.top)), distance: Math.abs(box.top - bounds.top) };
      }).filter(item => item.height > 0).sort((a, b) => b.height - a.height || a.distance - b.distance);
      if (candidates[0]) setPage(Number((candidates[0].node as HTMLElement).dataset.pageNumber));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) { if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target); }
      schedule();
    }, { root, threshold: [0, .25, .5, .75, 1] });
    root.querySelectorAll('.pdf-page-wrap').forEach(node => observer.observe(node));
    root.addEventListener('scroll', schedule, { passive: true });
    return () => { observer.disconnect(); root.removeEventListener('scroll', schedule); if (frame) cancelAnimationFrame(frame); };
  }, [doc, readingMode, readingMode === 'single' ? page : null, workbench, phone]);

  const scale = useMemo(() => {
    const rotated = rotation % 180 !== 0;
    const w = rotated ? dimensions.height : dimensions.width;
    const h = rotated ? dimensions.width : dimensions.height;
    if (zoomMode === 'width') return Math.max(.25, Math.min(3, (viewportSize.width - (phone ? 16 : viewportSize.width < 600 ? 30 : 100)) / w));
    if (zoomMode === 'page') return Math.max(.25, Math.min(2, (viewportSize.width - (phone ? 16 : 54)) / w, (viewportSize.height - (phone ? 160 : 76)) / h));
    return customScale;
  }, [zoomMode, customScale, viewportSize, dimensions, rotation, phone]);
  currentScale.current = scale;

  useLayoutEffect(() => {
    const anchor = wheelAnchor.current;
    wheelAnchor.current = null;
    const root = viewer.current;
    if (!anchor || !root || anchor.id !== doc?.id) return;
    const node = root.querySelector<HTMLElement>(`[data-page-number="${anchor.page}"] .pdf-page`);
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    const frame = root.getBoundingClientRect();
    root.scrollLeft += bounds.left + bounds.width * anchor.x - frame.left - anchor.pointerX;
    root.scrollTop += bounds.top + bounds.height * anchor.y - frame.top - anchor.pointerY;
  }, [scale, doc?.id]);

  useEffect(() => {
    const root = viewer.current;
    const shell = document;
    if (!root) return;
    const onWheel = (event: Event) => {
      const wheel = event as WheelEvent;
      if (!wheel.ctrlKey && !(isMac && wheel.metaKey)) return;
      wheel.preventDefault();
      const loaded = docRef.current;
      if (!loaded || !wheel.deltaY) return;
      const delta = wheel.deltaY * (wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? root.clientHeight : 1);
      const next = Math.max(.25, Math.min(3, Math.round(currentScale.current * Math.exp(-Math.max(-200, Math.min(200, delta)) * .001 * readingPreferencesRef.current.wheelSpeed / 100) * 100) / 100));
      if (next === currentScale.current) return;
      const node = (wheel.target as HTMLElement).closest<HTMLElement>('.pdf-page');
      if (node) {
        const bounds = node.getBoundingClientRect();
        const frame = root.getBoundingClientRect();
        wheelAnchor.current = { id: loaded.id, page: Number(node.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber),
          x: (wheel.clientX - bounds.left) / bounds.width, y: (wheel.clientY - bounds.top) / bounds.height,
          pointerX: wheel.clientX - frame.left, pointerY: wheel.clientY - frame.top };
      }
      currentScale.current = next;
      setCustomScale(next); setZoomMode('custom');
    };
    shell.addEventListener('wheel', onWheel, { passive: false });
    return () => shell.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const root = viewer.current;
    if (!touchLayout || !root) return;
    type Pinch = { stack: HTMLElement; distance: number; scale: number; next: number; originX: number; originY: number; centerX: number; centerY: number; pointerX: number; pointerY: number; page: number; x: number; y: number; id: string; frame: number };
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
      gesture = { stack, distance: center.distance, scale: currentScale.current, next: currentScale.current, originX: center.x - stackBounds.left, originY: center.y - stackBounds.top,
        centerX: center.x, centerY: center.y, pointerX: center.x, pointerY: center.y, page: Number(node.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber),
        x: (center.x - bounds.left) / bounds.width, y: (center.y - bounds.top) / bounds.height, id: docRef.current.id, frame: 0 };
      stack.style.transformOrigin = `${gesture.originX}px ${gesture.originY}px`; root.classList.add('pinching');
    };
    const move = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 2) return;
      event.preventDefault(); const center = geometry(event), active = gesture;
      active.next = Math.max(.25, Math.min(3, active.scale * center.distance / active.distance)); active.pointerX = center.x; active.pointerY = center.y;
      if (active.frame) cancelAnimationFrame(active.frame);
      active.frame = requestAnimationFrame(() => { active.stack.style.transform = `translate(${active.pointerX - active.centerX}px, ${active.pointerY - active.centerY}px) scale(${active.next / active.scale})`; });
    };
    const finish = (event: TouchEvent) => {
      if (!gesture || event.touches.length >= 2) return;
      event.preventDefault(); const active = gesture; gesture = null; clearPreview(active);
      if (docRef.current?.id !== active.id) return;
      const frame = root.getBoundingClientRect(), next = Math.round(active.next * 1000) / 1000;
      if (Math.abs(next - currentScale.current) < .0005 && activeView.current.zoomMode === 'custom') {
        const node = root.querySelector<HTMLElement>(`[data-page-number="${active.page}"] .pdf-page`), bounds = node?.getBoundingClientRect();
        if (bounds) { root.scrollLeft += bounds.left + bounds.width * active.x - active.pointerX; root.scrollTop += bounds.top + bounds.height * active.y - active.pointerY; }
        return;
      }
      wheelAnchor.current = { id: active.id, page: active.page, x: active.x, y: active.y, pointerX: active.pointerX - frame.left, pointerY: active.pointerY - frame.top };
      currentScale.current = next; setCustomScale(next); setZoomMode('custom');
    };
    const cancel = () => { if (gesture) { clearPreview(gesture); gesture = null; } };
    root.addEventListener('touchstart', start, { passive: false }); root.addEventListener('touchmove', move, { passive: false }); root.addEventListener('touchend', finish, { passive: false }); root.addEventListener('touchcancel', cancel);
    return () => { cancel(); root.removeEventListener('touchstart', start); root.removeEventListener('touchmove', move); root.removeEventListener('touchend', finish); root.removeEventListener('touchcancel', cancel); };
  }, [touchLayout]);

  useEffect(() => {
    if (!touchLayout || !(sidebar || notesOpen)) return;
    const drawer = document.querySelector<HTMLElement>('.mobile-drawer'); if (!drawer) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!bookmarkEditingId) drawer.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open], .bookmark-menu')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSidebar(false); setSearchOpen(false); setNotesOpen(false); }
      if (event.key !== 'Tab') return;
      const focusable = [...drawer.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('keydown', keyboard, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [touchLayout, sidebar, notesOpen, bookmarkEditingId]);
  const results = useMemo(() => searchText(textIndex, query), [textIndex, query]);
  const occurrences = results.reduce((sum, r) => sum + r.count, 0);
  const pages = useMemo(() => Array.from({ length: doc?.pdf.numPages || 0 }, (_, i) => i + 1), [doc]);
  const annotationPages = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    annotations.forEach(a => { const list = map.get(a.page) || []; list.push(a); map.set(a.page, list); });
    return map;
  }, [annotations]);

  const goToPage = useCallback((number: number, smooth = true, preserveScrollRestore = false) => {
    const pdf = docRef.current?.pdf;
    if (!pdf || !viewer.current) return;
    if (!preserveScrollRestore && scrollRestoreFrame.current !== null) { cancelAnimationFrame(scrollRestoreFrame.current); scrollRestoreFrame.current = null; }
    pageInputDirty.current = false;
    const next = Math.max(1, Math.min(pdf.numPages, number));
    setPage(next); setPageInput(String(next));
    const node = viewer.current.querySelector<HTMLElement>(`[data-page-number="${next}"]`);
    if (node) {
      const distance = node.getBoundingClientRect().top - viewer.current.getBoundingClientRect().top - (phoneRef.current ? 64 : 16);
      viewer.current.scrollTo({ top: viewer.current.scrollTop + distance, behavior: smooth && readingPreferencesRef.current.smoothScroll && Math.abs(distance) < viewer.current.clientHeight * 4 && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
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
    if (!phone || !doc || readingMode !== 'single' || tool !== 'select' || mobileAnnotating || library || sidebar || notesOpen || busy || loading) return;
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
  }, [phone, doc, readingMode, tool, mobileAnnotating, library, sidebar, notesOpen, busy, loading, goToPage]);

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

  function trimHistory(stack: History[], maxEntries = 50) {
    const budget = (phoneRef.current ? 40 : 200) * 1024 * 1024;
    while (stack.length > maxEntries || stack.reduce((total, item) => total + (item.bytes?.length || 0), 0) > budget) stack.shift();
  }
  const commitAnnotations = useCallback((next: Annotation[]) => {
    undoStack.current.push({ annotations: annotationRef.current });
    trimHistory(undoStack.current);
    redoStack.current = [];
    annotationRef.current = next; setAnnotations(next); setHistoryTick(v => v + 1);
  }, []);
  const undo = useCallback(() => {
    if (editorDraftRef.current || busyRef.current || loadingRef.current) return;
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(previous.bytes ? snapshot() : { annotations: annotationRef.current, bookmarks: readingState.current.bookmarks });
    trimHistory(redoStack.current);
    if (previous.bytes) { void restoreHistory(previous); return; }
    annotationRef.current = previous.annotations;
    if (previous.bookmarks) { readingState.current.bookmarks = previous.bookmarks; setBookmarks(previous.bookmarks); }
    setAnnotations(previous.annotations); setHistoryTick(v => v + 1);
  }, [openDocument]);
  const redo = useCallback(() => {
    if (editorDraftRef.current || busyRef.current || loadingRef.current) return;
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(next.bytes ? snapshot() : { annotations: annotationRef.current, bookmarks: readingState.current.bookmarks });
    trimHistory(undoStack.current);
    if (next.bytes) { void restoreHistory(next); return; }
    annotationRef.current = next.annotations;
    if (next.bookmarks) { readingState.current.bookmarks = next.bookmarks; setBookmarks(next.bookmarks); }
    setAnnotations(next.annotations); setHistoryTick(v => v + 1);
  }, [openDocument]);
  const commitBookmarks = useCallback((next: BookmarkNode[]) => {
    if (JSON.stringify(next) === JSON.stringify(readingState.current.bookmarks)) return;
    undoStack.current.push({ annotations: annotationRef.current, bookmarks: readingState.current.bookmarks });
    trimHistory(undoStack.current);
    redoStack.current = [];
    readingState.current.bookmarks = next; setBookmarks(next); setHistoryTick(value => value + 1);
  }, []);
  const changeZoom = useCallback((delta: number) => { setCustomScale(Math.max(.25, Math.min(3, Math.round((scale + delta) * 100) / 100))); setZoomMode('custom'); }, [scale]);
  const toggleBookmark = useCallback(() => {
    if (!docRef.current || busyRef.current || loadingRef.current) return;
    const alreadyMarked = hasBookmarkPage(readingState.current.bookmarks, page);
    const next = addPageBookmark(readingState.current.bookmarks, page);
    commitBookmarks(next.bookmarks);
    if (touchRef.current) notify(alreadyMarked ? 'Página marcada. Puedes organizarla en Marcadores.' : 'Marcador guardado.');
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
      const editing = (e.target as HTMLElement).closest('input,textarea,select,[contenteditable]');
      const modal = document.querySelector('dialog[open]');
      if (modal) { if ((e.ctrlKey || e.metaKey) && ['s', 'p'].includes(e.key.toLowerCase())) e.preventDefault(); return; }
      if (workbenchRef.current === 'edit-pdf' && !phoneRef.current) {
        const command = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
        if (command && !editing && ['z', 'y'].includes(key)) {
          e.preventDefault(); if (!editorDraftRef.current && !busyRef.current && !loadingRef.current) { if (key === 'y' || e.shiftKey) redo(); else undo(); }
        } else if (command && e.key === 'Tab') {
          e.preventDefault(); const all = tabsRef.current, index = all.findIndex(tab => tab.key === activeTabRef.current);
          if (!editorDraftRef.current && all.length > 1) void switchTab(all[(index + (e.shiftKey ? all.length - 1 : 1)) % all.length].key);
        } else if (command && key === 'w') { e.preventDefault(); if (!editorDraftRef.current && activeTabRef.current) void closeTab(activeTabRef.current); }
        else if (command && key === 's') { e.preventDefault(); void download({ keepEditing: true }); }
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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') { e.preventDefault(); if (activeTabRef.current) void closeTab(activeTabRef.current); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); if (!busyRef.current) void chooseFile(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); if (library) document.querySelector<HTMLInputElement>('.document-library-search input')?.focus(); else if (docRef.current) openSearch(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); void printDocument(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void download(); return; }
      if (e.key === 'F3' && (!editing || e.target === searchInput.current) && !busyRef.current && !loadingRef.current && !library && searchOpen && results.length) { e.preventDefault(); const visited = visitedSearch.current === `${activeTabRef.current}\0${query}`; goToResult(visited ? resultIndex + (e.shiftKey ? -1 : 1) : resultIndex); return; }
      if (editing) return;
      if (busyRef.current || loadingRef.current) return;
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if ((e.ctrlKey || e.metaKey) && ['+', '=', '-'].includes(e.key)) { e.preventDefault(); changeZoom(e.key === '-' ? -.1 : .1); }
      else if (e.ctrlKey || e.metaKey || e.altKey) return;
      else if (library) return;
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goToPage(page + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goToPage(page - 1); }
      else if (e.key.toLowerCase() === 'h') activateHighlight();
      else if (e.key.toLowerCase() === 'n' && docRef.current?.canAnnotate) setTool('note');
      else if (e.key.toLowerCase() === 'd' && docRef.current?.canAnnotate) { setMobileAnnotating(true); setTool('draw'); }
      else if (e.key.toLowerCase() === 'v') setTool('select');
      else if (e.key === 'Escape') { setReaderChromeHidden(false); setMobileAnnotating(false); setTool('select'); setSearchOpen(false); setQuery(''); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [page, library, goToPage, undo, redo, changeZoom, searchOpen, query, results, resultIndex]);

  async function openFiles(files: File[]) {
    if (editorDraftRef.current) { notify('Aplica o descarta el borrador antes de abrir otro documento.'); return; }
    if (busyRef.current) return;
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') { notify('Elige un archivo PDF para abrirlo.', true); continue; }
      await openDocument(file, file.name);
    }
  }
  async function chooseFile() {
    if (editorDraftRef.current) { notify('Aplica o descarta el borrador antes de abrir otro documento.'); return; }
    if (busyRef.current || loadingRef.current) return;
    if (!isNative) { fileInput.current?.click(); return; }
    loadingRef.current = true; setLoading(true);
    try {
      const files = await pickNativeDocuments();
      for (const file of files) await openDocument(file, file.name, false, file.token);
    } catch (error) { notify(errorMessage(error), true); }
    finally { loadingRef.current = false; setLoading(false); }
  }
  async function reopenRecent(recent: RecentDocument) {
    try {
      const existing = tabsRef.current.find(tab => tab.doc.id === recent.id);
      if (existing) { setLibrary(false); if (existing.key !== activeTabRef.current) requestAnimationFrame(() => void switchTab(existing.key)); return; }
      if (isNative) {
        let source: NativeDocument, recoveredDraft = false;
        try { source = recent.nativeSource ? { token: recent.nativeSource, name: recent.name, size: recent.size } : await readLibrarySource(recent.id); }
        catch (error) { const draft = await nativeDraftDocument(recent.id, recent.name); if (!draft) throw error; source = draft; recoveredDraft = true; }
        await openDocument(source, recent.name, false, source.token, recent.draft || recoveredDraft ? { id: recent.id, modified: true, draftSource: true } : undefined);
      }
      else if (recent.draft) {
        const draft = await readDraft(recent.id);
        if (!draft && !recent.data) throw new Error('No se pudo recuperar el borrador.');
        await openDocument(draft || recent.data!, recent.name, false, undefined, { id: recent.id, modified: true, draftSource: true });
      }
      else if (recent.data) await openDocument(recent.data, recent.name);
      else notify('El archivo no está disponible. Vuelve a importarlo desde Archivos; sus cambios locales siguen conservados.', true);
    } catch { notify('No se pudo reabrir el archivo. Vuelve a elegirlo desde Abrir PDF.', true); }
  }
  function onAnnotate(annotation: AnnotationDraft | AnnotationDraft[]) {
    if (!doc?.canAnnotate || busyRef.current || loadingRef.current) return;
    if (Array.isArray(annotation)) {
      // A selection spanning several pages is one action in the document history.
      commitAnnotations([...annotationRef.current, ...annotation.map(item => ({ ...item, id: uid(), created: Date.now() }))]);
      return;
    }
    if (annotation.kind === 'note') { noteOrigin.current = 'document'; setNoteDraft(annotation); setNoteText(''); return; }
    commitAnnotations([...annotationRef.current, { ...annotation, id: uid(), created: Date.now() }]);
  }
  const removeAnnotation = useCallback((id: string) => {
    if (!docRef.current?.canAnnotate || busyRef.current || loadingRef.current || !annotationRef.current.some(annotation => annotation.id === id)) return;
    commitAnnotations(annotationRef.current.filter(annotation => annotation.id !== id));
    setActiveNote(current => current === id ? null : current);
  }, [commitAnnotations]);
  function snapshot(): History {
    const current = docRef.current!;
    return { bytes: current.bytes, password: current.password, annotations: annotationRef.current,
      page: readingState.current.page, bookmarks: readingState.current.bookmarks };
  }
  async function restoreHistory(value: History) {
    const current = docRef.current; if (!current || !value.bytes) return;
    const keepEditing = workbenchRef.current === 'edit-pdf';
    setBusy('edit');
    await openDocument(value.bytes, current.name, current.sample, current.nativeSource, { id: current.id, draftSource: current.draftSource, password: value.password,
      modified: true, useSession: false, preserveHistory: true, page: value.page, bookmarks: value.bookmarks });
    annotationRef.current = value.annotations; setAnnotations(value.annotations); setBusy(null); setHistoryTick(v => v + 1);
    if (keepEditing) setWorkbench('edit-pdf');
  }
  async function applyOperation(operation: Operation, signal?: AbortSignal, context?: { keepEditing: boolean; page: number }) {
    const current = docRef.current; if (!current) return;
    if (isNativePdfDocument(current.pdf)) throw new Error('Esta herramienta de edición no está disponible en el lector nativo.');
    const before = snapshot(); setBusy('edit');
    try {
      const source = current.canAnnotate ? await exportAnnotated(current.bytes, annotationRef.current, current.password) : current.bytes;
      signal?.throwIfAborted();
      const output = await processPdf(source, operation, current.password, signal);
      signal?.throwIfAborted();
      const bookmarkPages = operation.operation === 'pages' ? remapBookmarks(before.bookmarks || [], operation.plan) : before.bookmarks;
      const password = operation.operation === 'protect' ? operation.ownerPassword : operation.operation === 'unprotect' ? '' : current.password;
      const opened = await openDocument(output, current.name, current.sample, current.nativeSource, { id: current.id, draftSource: current.draftSource, password, modified: true,
        useSession: false, preserveHistory: true, page: context?.keepEditing ? context.page : before.page, bookmarks: bookmarkPages });
      if (!opened) throw new Error('No se pudo cargar el resultado de la operación.');
      undoStack.current.push(before);
      // Bound the total retained PDF history as well as the number of operations.
      trimHistory(undoStack.current, 20);
      redoStack.current = []; setHistoryTick(v => v + 1); setWorkbench(context?.keepEditing ? 'edit-pdf' : null); setTool('select');
      if (operation.operation === 'compress') notify(output.length < source.length ? `PDF reducido de ${formatSize(source.length)} a ${formatSize(output.length)}.` : 'El PDF ya está optimizado; no se redujo su tamaño.');
    } finally { setBusy(null); }
  }
  async function currentBytes() {
    const current = docRef.current; if (!current) throw new Error('No hay documento abierto.');
    if (isNativePdfDocument(current.pdf)) throw new Error('Este PDF se guarda directamente desde el lector nativo.');
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
        setWorkbench(null); notify('Páginas extraídas en una pestaña nueva.');
        return;
      }
      const opened = await openDocument(bytes, current.name, current.sample, current.nativeSource, { id: current.id, draftSource: current.draftSource, modified: true,
        useSession: false, preserveHistory: true, page: readingState.current.page, bookmarks: readingState.current.bookmarks });
      if (!opened) throw new Error('No se pudo abrir el documento firmado.');
      undoStack.current.push(before); trimHistory(undoStack.current, 20); redoStack.current = []; setHistoryTick(v => v + 1); setWorkbench(null);
    } finally { setBusy(null); }
  }
  function onArea(area: Area) {
    if (!doc?.canEdit || busy) return;
    if (tool === 'redact') { setRedactions(previous => [...previous, area]); return; }
    setEditArea(area); setWorkbench(tool);
  }
  function saveNote() {
    if (!doc?.canAnnotate || !noteDraft || !noteText.trim()) return;
    const next = { ...noteDraft, id: noteDraft.id || uid(), text: noteText.trim(), created: Date.now() } as Annotation;
    commitAnnotations(noteDraft.id ? annotationRef.current.map(a => a.id === next.id ? next : a) : [...annotationRef.current, next]);
    setNoteDraft(null); setActiveNote(next.id);
    setNotesOpen(noteOrigin.current === 'list');
    if (!mobileAnnotating) setTool('select');
  }
  async function presentFileBacked(current: LoadedDocument, action: 'save' | 'share' | 'print') {
    if (current.nativeLegacySession) for (let number = 1; number <= current.pdf.numPages; number++) await nativePdfPageAnnotations(current.pdf, number);
    if (current.nativeLegacySession) throw new Error('No se pudieron recuperar todas las anotaciones de la sesión anterior. La copia no se ha guardado.');
    const removed = (current.nativeOriginalRefs || []).filter(ref => !annotationRef.current.some(annotation => annotation.nativeSourceRef === ref));
    return presentNativePdf(current.nativeSource!, action === 'save' ? current.name.replace(/\.pdf$/i, '') + ' — copia.pdf' : current.name, action, annotationRef.current, removed);
  }
  async function openDriveDocument(file: DriveOpened, pending = false) {
    const existing = !pending && tabsRef.current.find(tab => tab.doc.drive?.account === file.account && tab.doc.drive.fileId === file.fileId && tab.doc.drive.baseChecksum === file.baseChecksum);
    if (existing) {
      await switchTab(existing.key); setLibrary(false); setDriveLibrary(false);
      notify('Este PDF ya está abierto. Conservamos esa pestaña y sus cambios; ciérrala antes de cargar otra versión.'); return;
    }
    const success = await openDocument(file.document, file.document.name, false, file.document.token, { drive: file, modified: pending, useSession: !pending });
    if (success) { setDriveLibrary(false); setDriveMessage(pending ? 'Edición pendiente de guardar en Drive' : file.offline ? 'Copia local · Guarda para sincronizar cuando tengas conexión' : 'Google Drive · Guarda para sincronizar los cambios'); }
  }
  async function saveDriveDocument(current: LoadedDocument, keepEditing: boolean) {
    const binding = current.drive!;
    if (!binding.editable) throw new Error('Este archivo tiene permiso de solo lectura en Google Drive.');
    setDriveMessage('Preparando edición…');
    let pending;
    if (isNativePdfDocument(current.pdf)) {
      if (current.nativeLegacySession) for (let number = 1; number <= current.pdf.numPages; number++) await nativePdfPageAnnotations(current.pdf, number);
      if (current.nativeLegacySession) throw new Error('No se recuperaron todas las anotaciones. La edición no se subió.');
      const removed = (current.nativeOriginalRefs || []).filter(ref => !annotationRef.current.some(a => a.nativeSourceRef === ref));
      pending = await driveStageNative(binding.binding, current.nativeSource!, annotationRef.current, removed);
    } else pending = await driveStage(binding.binding, await currentBytes());
    setDriveMessage('Edición conservada · Subiendo a Drive…');
    try {
      const result = await driveSync(pending.id);
      if (result.status === 'conflict') { setDriveMessage('Conflicto: ambas ediciones están conservadas'); notify(result.message, true); setDriveLibrary(true); setLibrary(true); return; }
      if (!result.opened) throw new Error('No se pudo confirmar el archivo guardado.');
      const saved = result.opened;
      await draftSave.current.catch(() => {});
      const success = await openDocument(saved.document, saved.document.name, false, saved.document.token, { drive: saved, savedCopy: true, keepEditing, password: current.password, useSession: false, page: readingState.current.page, bookmarks: readingState.current.bookmarks });
      if (success) await discardDraft(current.id);
      setDriveMessage('Guardado en Google Drive'); notify(result.message);
    } catch (error) {
      setDriveMessage('Guardado en este dispositivo · Pendiente de sincronizar');
      throw new Error(`${errorMessage(error)} Puedes reintentarlo en Documentos → Google Drive → Ediciones pendientes.`);
    }
  }
  async function download(options?: { keepEditing?: boolean; copy?: boolean }) {
    if (editorDraftRef.current) { notify('Aplica o descarta el borrador antes de guardar el PDF.'); return; }
    const current = docRef.current;
    if (!current || busyRef.current || loadingRef.current || saving.current) return;
    const keepEditing = !!options?.keepEditing && workbenchRef.current === 'edit-pdf' && !phoneRef.current;
    saving.current = true;
    setBusy('download');
    try {
      if (current.drive && !options?.copy) { await saveDriveDocument(current, keepEditing); return; }
      if (isNativePdfDocument(current.pdf)) {
        const saved = await presentFileBacked(current, 'save');
        if (saved && typeof saved === 'object') {
          const opened = await openDocument(saved, saved.name, false, saved.token, { savedCopy: true, keepEditing, password: current.password, useSession: false, page: readingState.current.page, bookmarks: readingState.current.bookmarks });
          if (opened) await discardDraft(current.id);
          notify('PDF guardado.');
        }
        return;
      }
      const bytes = await currentBytes();
      const saveInPlace = isNative && isAndroid && !options?.copy;
      const overwrite = saveInPlace && !!current.nativeSource && !current.draftSource && !current.sample;
      const saved = overwrite
        ? await saveOriginalPdf(bytes, current.name, current.nativeSource!)
        : await savePdf(bytes, saveInPlace ? current.name : current.name.replace(/\.pdf$/i, '') + ' — copia.pdf', current.nativeSource);
      if (saved) {
        await draftSave.current.catch(() => {});
        const opened = await openDocument(bytes, typeof saved === 'object' ? saved.name : current.name, false, typeof saved === 'object' ? saved.token : undefined,
          { savedCopy: true, keepEditing, password: current.password, useSession: false, page: readingState.current.page, bookmarks: readingState.current.bookmarks });
        if (opened) {
          await discardDraft(current.id);
          // Replace the old library entry only after the saved PDF is remembered.
          if (saveInPlace && typeof saved === 'object' && saved.id && saved.id !== current.id) {
            await librarySave.current;
            await rememberDocument({ id: saved.id, name: saved.name, size: saved.size, pages: docRef.current!.pdf.numPages, openedAt: Date.now(), nativeSource: saved.token });
            if (!preferencesRef.current.rememberRecent) await hideRecent(saved.id);
            await forgetDocument(current.id);
          }
        }
        notify(overwrite ? 'Cambios guardados en el PDF original.' : 'PDF guardado.');
      }
    } catch (error) { notify(errorMessage(error) || 'No se pudo guardar el PDF. Tus cambios siguen en Folio.', true); }
    finally { saving.current = false; setBusy(null); }
  }
  async function printDocument() {
    if (editorDraftRef.current) { notify('Aplica o descarta el borrador antes de imprimir el PDF.'); return; }
    const current = docRef.current;
    if (!current?.canPrint || busyRef.current) return;
    if (isNative && isMobile) {
      setBusy('print');
      try { if (isNativePdfDocument(current.pdf)) await presentFileBacked(current, 'print'); else await printPdf(current.canAnnotate ? await exportAnnotated(current.bytes, annotationRef.current, current.password) : current.bytes, current.name, current.nativeSource); }
      catch (error) { notify(error instanceof Error ? error.message : 'No se pudo preparar la impresión.', true); }
      finally { setBusy(null); }
      return;
    }
    setBusy('print'); document.querySelector('.print-document')?.remove();
    const container = document.createElement('div'); container.className = 'print-document'; document.body.append(container);
    let printable = current.pdf;
    let temporary = false;
    try {
      if (current.canAnnotate) { printable = await getDocument({ data: await exportAnnotated(current.bytes, annotationRef.current, current.password), password: current.password, ...pdfAssetSettings() }).promise; temporary = true; }
      let total = 0;
      for (let p = 1; p <= printable.numPages; p++) {
        const pdfPage = await printable.getPage(p), viewport = pdfPage.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        try {
          await pdfPage.render({ canvas, viewport, intent: 'print' }).promise;
          const image = document.createElement('img'); image.src = canvas.toDataURL('image/jpeg', .94); image.alt = `Página ${p}`;
          total += image.src.length; if (total > 200 * 1024 * 1024) throw new Error('El trabajo de impresión es demasiado grande. Extrae un intervalo de páginas para imprimirlo.');
          const sheet = document.createElement('div'); sheet.className = 'print-sheet'; sheet.append(image); container.append(sheet); await image.decode();
        } finally { canvas.width = 0; canvas.height = 0; }
      }
      window.addEventListener('afterprint', () => container.remove(), { once: true });
      if (isDesktop) { const { invoke } = await import('@tauri-apps/api/core'); await invoke('print_document'); }
      else window.print();
    } catch (error) { container.remove(); notify(error instanceof Error ? error.message : 'No se pudo preparar la impresión.', true); }
    finally { if (temporary) await printable.loadingTask.destroy(); setBusy(null); }
  }
  function goToResult(index: number) {
    if (!results.length) return;
    const next = (index + results.length) % results.length;
    const searchKey = `${activeTabRef.current}\0${query}`;
    if (!returnLocation) rememberLocation(); visitedSearch.current = searchKey;
    setResultIndex(next); goToPage(results[next].page, false);
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('folio:reveal-search-result', { detail: { page: results[next].page, offset: results[next].offset } })));
    if (touchRef.current) { searchInput.current?.blur(); setSidebar(false); setNotesOpen(false); setReaderChromeHidden(false); }
  }
  function closeSearch() { visitedSearch.current = null; setSearchOpen(false); setQuery(''); if (touchRef.current) setSidebar(false); }
  async function shareDocument() {
    const current = docRef.current; if (!current || busyRef.current || saving.current) return;
    setBusy('download');
    try { if (isNativePdfDocument(current.pdf)) await presentFileBacked(current, 'share'); else await sharePdf(current.canAnnotate ? await exportAnnotated(current.bytes, annotationRef.current, current.password) : current.bytes, current.name, current.nativeSource); }
    catch (error) { notify(error instanceof Error ? error.message : 'No se pudo compartir el PDF.', true); }
    finally { setBusy(null); }
  }
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
  function navigatePDF(destination: { page: number; left?: number; top?: number } | { url: string }) {
    if ('url' in destination) { void openExternalUrl(destination.url).catch(() => notify('No se pudo abrir el enlace.', true)); return; }
    rememberLocation(); goToPage(destination.page, false);
    if (destination.top !== undefined && doc) void doc.pdf.getPage(destination.page).then(pdfPage => {
      requestAnimationFrame(() => {
        const node = viewer.current?.querySelector<HTMLElement>(`[data-page-number="${destination.page}"] .page-content`);
        if (!node || !viewer.current) return;
        const point = pdfPage.getViewport({ scale: currentScale.current, rotation: (pdfPage.rotate + rotation) % 360 }).convertToViewportPoint(destination.left || 0, destination.top!);
        const box = node.getBoundingClientRect(), bounds = viewer.current.getBoundingClientRect();
        viewer.current.scrollTo({ top: viewer.current.scrollTop + box.top - bounds.top + point[1] - 24, behavior: 'instant' });
      });
    }).catch(() => {});
  }
  function openExplorer(tab: SideTab = 'pages') { setReaderChromeHidden(false); setSearchOpen(false); setQuery(''); setNotesOpen(false); setSideTab(tab); setSidebar(true); }
  function openSearch() { if (!searchOpen) { rememberLocation(); visitedSearch.current = null; } setReaderChromeHidden(false); setMobileAnnotating(false); setTool('select'); setNotesOpen(false); setSearchOpen(true); setSidebar(true); }
  function startAnnotating() {
    if (!doc?.canAnnotate) { setCapabilityNotice(true); return; }
    if (touchRef.current) closeMobilePanel(); setReaderChromeHidden(false); setMobileAnnotating(true); setTool('select');
  }
  function editNote(annotation: Annotation, origin: 'document' | 'list') { noteOrigin.current = origin; setNoteDraft(annotation); setNoteText(annotation.text); }
  const updateAnnotation = useCallback((id: string, patch: Partial<Pick<Annotation, 'color' | 'text'>>) => {
    if (!docRef.current?.canAnnotate || busyRef.current || loadingRef.current) return;
    commitAnnotations(annotationRef.current.map(item => item.id === id ? { ...item, ...patch } : item));
  }, [commitAnnotations]);
  function commentHighlight(annotation: Annotation) {
    const [x, y] = annotation.rect;
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
    if (editorDraftRef.current) { notify('Aplica o descarta el borrador antes de salir del editor.'); return; }
    if (busyRef.current || loadingRef.current) return;
    try { const current = captureTab(); if (current) await persistTab(current); retainCurrentTab(); publishTabs(); closeMobilePanel(); setReaderChromeHidden(false); setMobileAnnotating(false); setTool('select'); setLibrary(true); }
    catch (error) { notify(errorMessage(error), true); }
  }
  async function removeFromRecents(recent: RecentDocument) {
    try { await librarySave.current; await hideRecent(recent.id); setRecents(await listLibrary()); notify('Quitado de recientes. El documento y sus cambios siguen en la biblioteca.'); }
    catch (error) { notify(errorMessage(error), true); }
  }
  function cancelPassword() {
    passwordCancelled.current = true;
    engineRef.current?.abort();
    void taskRef.current?.destroy();
    setPassword(null); setLoading(false); loadingRef.current = false;
  }
  async function fullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { notify('Tu navegador no permite activar la pantalla completa.', true); }
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
    } catch { notify('No se pudo cambiar el estado de la ventana.', true); }
  }
  async function clearLibrary() {
    if (!confirmClear) { setConfirmClear(true); return; }
    const pendingIds = tabsRef.current.map(tab => tab.doc.id).filter(id => !forgottenIds.current.has(id));
    for (const id of pendingIds) forgottenIds.current.add(id);
    try {
      await Promise.allSettled([draftSave.current, librarySave.current]);
      await clearSavedState();
      discardOpenTabs(new Set(tabsRef.current.map(tab => tab.doc.id)));
      setRecents([]); setConfirmClear(false);
      notify('Biblioteca y anotaciones locales eliminadas.');
    } catch { for (const id of pendingIds) forgottenIds.current.delete(id); notify('No se pudo eliminar la biblioteca local.', true); }
  }
  async function forgetRecent(recent: RecentDocument) {
    forgottenIds.current.add(recent.id);
    try {
      await Promise.allSettled([draftSave.current, librarySave.current]); await forgetDocument(recent.id);
      discardOpenTabs(new Set([recent.id]));
      publishTabs(); setRecents(await listLibrary()); setDeleteTarget(null); notify('Copia y cambios locales eliminados. El archivo original no se modificó.');
    } catch { forgottenIds.current.delete(recent.id); notify('No se pudo eliminar el archivo de la biblioteca.', true); }
  }
  function discardOpenTabs(ids: Set<string>) {
    const removed = tabsRef.current.filter(tab => ids.has(tab.doc.id));
    const activeRemoved = removed.some(tab => tab.key === activeTabRef.current);
    tabsRef.current = tabsRef.current.filter(tab => !ids.has(tab.doc.id));
    if (activeRemoved && tabsRef.current.length) { activateTab(tabsRef.current[0]); if (phoneRef.current) setLibrary(true); }
    else if (activeRemoved) {
      activeTabRef.current = null; setActiveTabKey(null); docRef.current = null; annotationRef.current = []; undoStack.current = []; redoStack.current = [];
      setDoc(null); setAnnotations([]); setBookmarks([]); setOutline([]); setTextIndex([]); setPage(1); setPageInput('1'); setQuery(''); setSearchOpen(false); setNotesOpen(false); setSidebar(false); setTool('select'); setMobileAnnotating(false); setReaderChromeHidden(false); setReturnLocation(null); setWorkbench(null); setNoteDraft(null); setLibrary(true);
    }
    publishTabs(); for (const tab of removed) setTimeout(() => void tab.doc.pdf.loadingTask.destroy(), 200);
  }
  const explorerTabs = <div className="mobile-panel-tabs" role="tablist" aria-label="Explorar PDF">{(['pages', 'outline', 'bookmarks', 'annotations'] as const).map(id => {
    const Symbol = id === 'pages' ? Layers : id === 'outline' ? ListTree : id === 'bookmarks' ? Bookmark : MessageSquare;
    const label = id === 'pages' ? 'Páginas' : id === 'outline' ? 'Índice' : id === 'bookmarks' ? 'Marcadores' : 'Anotaciones';
    const selected = id === 'annotations' ? notesOpen : sidebar && !searchOpen && sideTab === id;
    return <button key={id} role="tab" aria-selected={selected} onClick={() => { setSearchOpen(false); setQuery(''); setNotesOpen(id === 'annotations'); setSidebar(id !== 'annotations'); if (id !== 'annotations') setSideTab(id); }}><Symbol size={19} /><span>{label}</span></button>;
  })}</div>;
  const libraryContent = <DocumentLibrary onDrive={() => setDriveLibrary(true)} documents={recents} loading={libraryLoading} activeDocument={doc ? { name: doc.name, page } : undefined} busy={!!busy || loading} onContinue={doc ? () => setLibrary(false) : undefined} onOpen={recent => void reopenRecent(recent)} onImport={() => requestAnimationFrame(() => void chooseFile())} onCreate={() => setCreating(true)} onHideRecent={recent => void removeFromRecents(recent)} onDelete={setDeleteTarget} onSettings={() => { setConfirmClear(false); setSettings(true); }} onHelp={() => setHelp(true)} onDemo={() => void openDocument('sample')} />;

  const inlineEditing = !phone && workbench === 'edit-pdf';
  const workbenchPanel = workbench && doc && !isNativePdfDocument(doc.pdf) ? <Workbench key={`${doc.revision}-${workbench}`} doc={doc} page={page} section={workbench} inline={inlineEditing} documentBusy={!!busy} area={editArea} redactions={redactions} onClose={closeWorkbench} onSelectTool={next => { void selectWorkbenchTool(next); }} onOpenEditor={openEditor} onOpenSection={next => { void openWorkbenchSection(next); }} onDraftChange={setEditorDraft} onEditPageChange={next => { readingState.current.page = next; setPage(next); setPageInput(String(next)); }} onApply={applyOperation} getBytes={currentBytes} onSave={() => { void download({ keepEditing: true }); }} canSave={!busy && !loading && !editorDraft} onHistory={direction => { if (!busy) { if (direction === 'undo') undo(); else redo(); } }} canUndo={!!undoStack.current.length} canRedo={!!redoStack.current.length} onReplace={replaceDocument} /> : null;

  const driveDirty = !!doc?.drive && (doc.modified || annotationFingerprint(annotations) !== doc.savedAnnotations);
  const driveStatus = busy === 'download' ? driveMessage : driveDirty ? 'Google Drive: cambios pendientes de guardar' : 'Documento de Google Drive';
  const driveIndicator = doc?.drive && <span className={`drive-document-indicator${driveDirty ? ' pending' : ''}`} role="status" aria-label={driveStatus} title={driveStatus}>{busy === 'download' ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Cloud size={15} aria-hidden="true" />}</span>;

  return <div className={`app-shell${isDesktop && isMac ? ' native-mac' : ''}${phone ? ' phone-layout' : tablet ? ' tablet-layout' : ''}${readerChromeHidden ? ' reader-chrome-hidden' : ''}${library ? ' library-visible' : ''}`} onDragEnter={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragCounter.current++; setDragOver(true); } }} onDragLeave={e => { e.preventDefault(); if (--dragCounter.current <= 0) { dragCounter.current = 0; setDragOver(false); } }} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { e.preventDefault(); dragCounter.current = 0; setDragOver(false); if (!isNative) void openFiles(Array.from(e.dataTransfer.files)); }}>
    {closeBlocked && <Modal title="No se pudo guardar la sesión" onClose={() => setCloseBlocked(false)}><p className="modal-description">Puedes guardar una copia del PDF antes de salir. Si cierras ahora, los cambios de esta sesión podrían perderse.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setCloseBlocked(false)}>Volver</button><button className="secondary-button" onClick={() => { setCloseBlocked(false); void download({ copy: true }); }}>Guardar una copia</button><button className="primary-button" onClick={() => { void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().destroy()); }}>Cerrar sin guardar sesión</button></div></Modal>}
    <header className="app-header" data-tauri-drag-region inert={touchLayout && (library || sidebar || notesOpen)}>
      {!touchLayout && <div className="brand"><img src="/folio.svg" alt="Folio" /></div>}
      <h1 className="sr-only">{doc?.name || 'Folio'}</h1>
      {tablet ? <TabletReaderHeader nameAdornment={driveIndicator} documentsOpen={mobileTabs} name={doc?.name || 'Folio'} count={tabs.length} page={doc ? `${currentPageLabel} / ${doc.pdf.numPages}` : undefined} annotating={mobileAnnotating} disabled={!!busy || loading} draft={editorDraft || inlineEditing} canUndo={!!undoStack.current.length} canRedo={!!redoStack.current.length} onLibrary={() => void returnToLibrary()} onDocuments={() => setMobileTabs(value => !value)} onPage={() => { setPageInput(String(page)); setPageJump(true); }} onPages={() => openExplorer()} onSearch={openSearch} onAnnotate={startAnnotating} onDone={() => { setMobileAnnotating(false); setTool('select'); }} onUndo={undo} onRedo={redo} onMore={() => setMobileActions(true)} /> : phone ? <>
        <IconButton label="Volver a biblioteca" disabled={!!busy || loading} onClick={() => void returnToLibrary()}><ChevronLeft size={24} /></IconButton>
        <button id="document-switcher-trigger" className="mobile-document-selector" aria-label="Documentos abiertos y recientes" aria-haspopup="dialog" aria-expanded={mobileTabs} aria-controls="document-switcher" disabled={!!busy || loading || !tabs.length} onClick={() => setMobileTabs(value => !value)}><span>{doc?.name || 'Folio'}</span>{driveIndicator}{tabs.length > 1 && <span className="mobile-tab-count">{tabs.length}</span>}<ChevronDown size={16} /></button>
        {mobileAnnotating ? <><IconButton label="Deshacer" disabled={!!busy || !undoStack.current.length} onClick={undo}><Undo2 size={21} /></IconButton><button className="mobile-done" aria-label="Terminar anotación" onClick={() => { setMobileAnnotating(false); setTool('select'); }}>Listo</button></> : <IconButton label="Más acciones" onClick={() => setMobileActions(true)}><MoreHorizontal size={23} /></IconButton>}
      </> : <>
      <div className={`document-tab-strip${tabDrag.enabled ? ' drag-enabled' : ''}${tabDrag.draggingKey ? ' is-dragging' : ''}`} ref={tabDrag.strip} onClickCapture={tabDrag.clickCapture} onDragStart={event => { if (tabDrag.enabled) event.preventDefault(); }} role="tablist" aria-label="Documentos abiertos">
        {tabs.map(tab => <div className={`document-tab ${tab.key === activeTabKey ? 'selected' : ''}${tabDrag.draggingKey === tab.key ? ' plan-tab-dragging' : ''}${tabDrag.drop?.key === tab.key ? ` tab-drop-${tabDrag.drop.side}` : ''}`} key={tab.key} data-tab-key={tab.key} onPointerDown={event => tabDrag.begin(event, tab.key)}>
          <button role="tab" aria-selected={tab.key === activeTabKey} aria-controls="document-reader" aria-label={tab.doc.name} title={tab.doc.name} tabIndex={tab.key === activeTabKey ? 0 : -1} disabled={!!busy || loading || editorDraft} onClick={() => { if (tab.key === activeTabKey) setLibrary(false); else void switchTab(tab.key); }} onKeyDown={event => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const i = tabs.findIndex(item => item.key === tab.key); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length; void switchTab(tabs[next].key); }
          }}>{tab.doc.drive ? tab.key === activeTabKey ? driveIndicator : <Cloud size={14} aria-label="Documento de Google Drive" /> : <FileText size={14} />}<span>{tab.doc.name}</span>{(tab.doc.modified || annotationFingerprint(tab.key === activeTabKey ? annotations : tab.annotations) !== tab.doc.savedAnnotations) && <span className="modified-dot" title="Cambios sin guardar en un PDF" aria-label="Documento modificado" />}</button>
          <button className="document-tab-close" aria-label={`Cerrar ${tab.doc.name}`} title={`Cerrar pestaña (${shortcutLabel('W')})`} disabled={!!busy || loading || editorDraft} onClick={() => void closeTab(tab.key)}><X size={13} /></button>
        </div>)}
      </div>
      {draggedTab && <div className="document-tab-drag-preview" aria-hidden="true" style={{ left: Math.max(8, Math.min(tabDrag.location.x + 16, window.innerWidth - 270)), top: Math.max(8, Math.min(tabDrag.location.y + 16, window.innerHeight - 48)) }}><FileText size={16} /><span>{draggedTab.doc.name}</span></div>}
      <IconButton label="Abrir PDF" disabled={!!busy || loading || editorDraft} onClick={() => void chooseFile()} className="new-document-tab"><Plus size={19} /></IconButton>
      <div className="header-drag-space" data-tauri-drag-region />
      <div className="header-actions">
        <IconButton label="Información del documento" disabled={!doc || loading} onClick={() => setInfo(true)}><Info size={16} /></IconButton>
        <IconButton label="Crear PDF" disabled={!!busy || loading || editorDraft} onClick={() => setCreating(true)}><FilePlus2 size={18} /></IconButton>
        {storageFailed && <button className="session-warning" title="No se pudo guardar la sesión" onClick={() => void download()}><Info size={15} />Sesión sin guardar</button>}
      </div>
      {isDesktop && !isMac && <div className="window-actions">
        <IconButton label="Minimizar ventana" onClick={() => void windowAction('minimize')}><Minus size={16} /></IconButton>
        <IconButton label="Maximizar o restaurar ventana" onClick={() => void windowAction('toggleMaximize')}><Maximize size={14} /></IconButton>
        <IconButton label="Cerrar ventana" onClick={() => void windowAction('close')} className="window-close"><X size={17} /></IconButton>
      </div>}
      </>}
      <input ref={fileInput} type="file" multiple accept="application/pdf,.pdf" className="sr-only" aria-label="Elegir archivo PDF" onChange={e => { const input = e.currentTarget; void openFiles(Array.from(input.files || [])).finally(() => { input.value = ''; }); }} />
    </header>

    <div className="workspace" inert={library}>
      {!touchLayout && <nav className="tool-rail" aria-label="Herramientas del documento" inert={inlineEditing}>
        <div className="rail-primary">
          <button className={library ? 'rail-button active' : 'rail-button'} aria-label="Mis documentos" title="Mis documentos" onClick={() => setLibrary(true)}><FolderOpen size={21} /><span>Documentos</span></button>
          <button className={`rail-button ${sidebar && !searchOpen && sideTab === 'pages' ? 'active' : ''}`} aria-label="Páginas" title="Páginas" aria-expanded={sidebar && !searchOpen && sideTab === 'pages'} disabled={!doc} onClick={() => toggleSidePanel('pages')}><Layers size={21} /><span>Páginas</span></button>
          <button className={`rail-button annotations-toggle ${notesOpen ? 'active' : ''}`} aria-label="Anotaciones" title="Anotaciones" aria-expanded={notesOpen} disabled={!doc} onClick={() => { if (window.innerWidth < 1000) { setSidebar(false); setSearchOpen(false); } setNotesOpen(v => !v); }}><MessageSquare size={21} /><span>Anotaciones</span>{annotations.length > 0 && <span className="rail-count">{annotations.length}</span>}</button>
          <button className={`rail-button ${searchOpen && sidebar ? 'active' : ''}`} aria-label="Buscar en el PDF" title={`Buscar en el PDF (${shortcutLabel('F')})`} aria-expanded={searchOpen && sidebar} disabled={!doc} onClick={() => { if (searchOpen && sidebar) closeSearch(); else openSearch(); }}><Search size={21} /><span>Buscar</span></button>
          <button className={`rail-button ${sidebar && !searchOpen && sideTab === 'bookmarks' ? 'active' : ''}`} aria-label="Marcadores" title="Marcadores" aria-expanded={sidebar && !searchOpen && sideTab === 'bookmarks'} disabled={!doc} onClick={() => toggleSidePanel('bookmarks')}><Bookmark size={21} /><span>Marcadores</span></button>
          <button className={`rail-button ${sidebar && !searchOpen && sideTab === 'outline' ? 'active' : ''}`} aria-label="Índice" title="Índice" aria-expanded={sidebar && !searchOpen && sideTab === 'outline'} disabled={!doc} onClick={() => toggleSidePanel('outline')}><ListTree size={21} /><span>Índice</span></button>
        </div>
        <div className="rail-bottom">
          <IconButton label="Preferencias de lectura" onClick={() => { setSettings(true); setConfirmClear(false); }}><Settings2 size={19} /></IconButton>
          <IconButton label="Ayuda y atajos" onClick={() => setHelp(true)}><CircleHelp size={19} /></IconButton>
        </div>
      </nav>}
      {touchLayout && (sidebar || notesOpen) && <button className="mobile-panel-backdrop" aria-label="Cerrar panel lateral" tabIndex={-1} onClick={closeMobilePanel} />}
      {sidebar && <aside className={`sidebar${touchLayout ? ' mobile-drawer' : ''}`} role={touchLayout ? 'dialog' : undefined} aria-modal={touchLayout ? true : undefined} aria-label={touchLayout ? searchOpen ? 'Buscar en el PDF' : 'Explorar documento' : undefined} style={touchLayout ? undefined : { width: readingPreferences.panelWidth, minWidth: readingPreferences.panelWidth }}>
        {touchLayout && <><SheetHandle onClose={closeMobilePanel} label="Cerrar explorador" /><div className="mobile-drawer-heading"><h2>{searchOpen ? 'Buscar' : 'Explorar'}</h2><IconButton label={searchOpen ? 'Cerrar búsqueda' : 'Cerrar panel'} onClick={closeMobilePanel}><X size={20} /></IconButton></div>{!searchOpen && explorerTabs}</>}
        {searchOpen ? <>
          <div className="sidebar-title"><span>Buscar en el documento</span>{!touchLayout && <IconButton label="Cerrar búsqueda" onClick={closeSearch}><X size={16} /></IconButton>}</div>
          <form className="search-field" onSubmit={e => { e.preventDefault(); const visited = visitedSearch.current === `${activeTabRef.current}\0${query}`; goToResult(!phone && visited ? resultIndex + 1 : resultIndex); }}><Search size={16} /><input ref={searchInput} placeholder="Palabra o frase…" value={query} onChange={e => { visitedSearch.current = null; setQuery(e.target.value); setResultIndex(0); }} aria-label="Buscar texto en el PDF" />{query && <button type="button" onClick={() => setQuery('')} aria-label="Borrar búsqueda"><X size={14} /></button>}</form>
          <div className="search-summary"><span>{indexing ? 'Preparando búsqueda…' : query ? `${occurrences} coincidencia${occurrences === 1 ? '' : 's'}` : 'Buscar texto'}</span>{results.length > 0 && <div><IconButton label="Resultado anterior" onClick={() => goToResult(resultIndex - 1)}><ChevronLeft size={15} /></IconButton><IconButton label="Siguiente resultado" onClick={() => goToResult(resultIndex + 1)}><ChevronRight size={15} /></IconButton></div>}</div>
          <div className="sidebar-scroll search-results">{results.map((result, i) => <button key={`${result.page}-${result.offset}`} className={`search-result ${i === resultIndex ? 'selected' : ''}`} onClick={() => goToResult(i)}><span className="result-heading">Página {pageLabels?.[result.page - 1] || result.page}<span>{i + 1} / {results.length}</span></span><span>{result.text}</span></button>)}{query && !indexing && !results.length && <div className="empty-panel"><Search size={26} /><p>No encontramos «{query}».</p><span>{textIndex.every(t => !t.trim()) ? 'Este PDF no contiene texto seleccionable. La búsqueda necesita texto; no incluye OCR.' : 'Prueba con otra palabra o una frase más corta.'}</span></div>}{!query && <div className="search-hint"><Keyboard size={24} /><p>Introduce un texto para buscar.</p><span>Busca sin distinguir mayúsculas ni acentos.</span></div>}</div>
        </> : <>
          <div className="sidebar-title"><span>{sideTab === 'pages' ? 'Páginas' : sideTab === 'outline' ? 'Índice' : 'Marcadores'}</span><span className="page-total">{doc?.pdf.numPages || 0}</span>{!touchLayout && <IconButton label="Cerrar panel" onClick={() => setSidebar(false)}><X size={16} /></IconButton>}</div>

          <div className={`sidebar-scroll ${sideTab === 'pages' ? 'thumbnails' : 'outline-list'}`} role="tabpanel">
            {sideTab === 'pages' && doc && pages.map(number => <Thumbnail key={`${doc.pdf.loadingTask.docId}-${number}`} pdf={doc.pdf} number={number} pageLabel={pageLabels?.[number - 1]} selected={page === number} onClick={() => mobilePage(number)} />)}
            {sideTab === 'outline' && (outline.length ? <DocumentOutline outline={outline} page={page} onNavigate={mobilePage} /> : <div className="empty-panel"><ListTree size={26} /><p>Sin índice en este PDF.</p><span>Explora sus páginas desde las miniaturas.</span></div>)}
            {sideTab === 'bookmarks' && <BookmarkTree key={activeTabKey} bookmarks={bookmarks} onChange={commitBookmarks} page={page} onGoToPage={mobilePage} disabled={!!busy || loading} startEditingId={bookmarkEditingId} onEditingComplete={() => setBookmarkEditingId(null)} />}
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
            <button className="tools-button" disabled={!doc || !!busy || loading} onClick={openTools} title="Herramientas"><Wrench size={17} /><span>Herramientas</span></button>
            <div className="undo-group"><span className="toolbar-divider" /><IconButton label={`Deshacer (${shortcutLabel('Z')})`} onClick={undo} disabled={!!busy || !undoStack.current.length}><Undo2 size={17} /></IconButton><IconButton label={`Rehacer (${shortcutLabel(isMac ? '⇧+Z' : 'Y')})`} onClick={redo} disabled={!!busy || !redoStack.current.length}><Redo2 size={17} /></IconButton></div>
          </div>
          <div className="page-controls"><IconButton label="Página anterior" onClick={() => goToPage(page - 1)} disabled={!doc || page <= 1}><ChevronLeft size={17} /></IconButton><form onSubmit={e => { e.preventDefault(); commitPageInput(); }}><input aria-label="Número de página" type="text" inputMode="numeric" value={pageInput} onChange={e => { pageInputDirty.current = true; setPageInput(e.target.value.replace(/\D/g, '')); }} onBlur={() => { if (pageInputDirty.current) commitPageInput(); }} /><span>/ {doc?.pdf.numPages || '—'}</span></form><IconButton label="Página siguiente" onClick={() => goToPage(page + 1)} disabled={!doc || page >= doc.pdf.numPages}><ChevronRight size={17} /></IconButton></div>
          <div className="toolbar-right">
            <div className="zoom-controls"><IconButton label="Reducir zoom" onClick={() => changeZoom(-.1)} disabled={!doc || scale <= .25}><Minus size={16} /></IconButton><div className="zoom-select"><select aria-label="Nivel de zoom" value={zoomMode === 'custom' ? String(Math.round(scale * 100)) : zoomMode} onChange={e => { if (['page', 'width'].includes(e.target.value)) setZoomMode(e.target.value); else { setCustomScale(Number(e.target.value) / 100); setZoomMode('custom'); } }} disabled={!doc}><option value="page">Ajustar página</option><option value="width">Ajustar ancho</option>{![50, 75, 100, 125, 150, 200, 300].includes(Math.round(scale * 100)) && zoomMode === 'custom' && <option value={String(Math.round(scale * 100))}>{Math.round(scale * 100)} %</option>}{[50, 75, 100, 125, 150, 200, 300].map(n => <option key={n} value={n}>{n} %</option>)}</select><ChevronDown size={12} /></div><IconButton label="Ampliar zoom" onClick={() => changeZoom(.1)} disabled={!doc || scale >= 3}><Plus size={16} /></IconButton></div>
            <span className="toolbar-divider" /><IconButton label={hasBookmarkPage(bookmarks, page) ? 'Editar marcador de esta página' : 'Guardar marcador de esta página'} disabled={!doc || !!busy || loading} onClick={toggleBookmark} active={hasBookmarkPage(bookmarks, page)}><Bookmark size={17} fill={hasBookmarkPage(bookmarks, page) ? 'currentColor' : 'none'} /></IconButton>
            <button className="download-button" aria-label={doc?.drive ? 'Guardar en Drive' : isNative ? 'Guardar' : 'Descargar'} onClick={() => void download()} disabled={!doc || !!busy || loading}><ArrowDownToLine size={16} /><span>{isNative ? 'Guardar' : 'Descargar'}</span></button>
            {tablet && <IconButton label="Compartir PDF" onClick={() => void shareDocument()} disabled={!doc || !!busy || loading}><Upload size={21} /></IconButton>}<IconButton label="Más acciones del documento" disabled={!doc || !!busy || loading} onClick={() => setMobileActions(true)}><MoreHorizontal size={20} /></IconButton>
          </div>
        </div>}
        {!touchLayout && !inlineEditing && doc && mobileAnnotating && <div className="desktop-annotation-toolbar" role="toolbar" aria-label="Herramientas de anotación">
          <div className="tool-group"><IconButton label="Dibujar" toggle active={tool === 'draw'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool('draw')}><PenLine size={21} /></IconButton><IconButton label="Borrar dibujo" toggle active={tool === 'eraser'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool('eraser')}><Eraser size={21} /></IconButton><IconButton label="Seleccionar texto (V)" active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={18} /></IconButton><IconButton label="Resaltado automático (H)" toggle active={tool === 'highlight'} disabled={!doc.canAnnotate || !doc.canCopy || !!busy || loading} onMouseDown={e => e.preventDefault()} onClick={activateHighlight}><Highlighter size={19} /></IconButton>{tool === 'highlight' && <HighlightColorPicker color={color} onChange={setColor} disabled={!doc.canAnnotate || !doc.canCopy || !!busy || loading} />}<IconButton label="Añadir nota (N)" active={tool === 'note'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool(tool === 'note' ? 'select' : 'note')}><StickyNote size={18} /></IconButton></div>
          <span className="desktop-tool-description">{tool === 'draw' ? 'Dibuja sobre la página' : tool === 'eraser' ? 'Toca el trazo que quieres borrar' : tool === 'highlight' ? 'Selecciona el texto para resaltarlo' : tool === 'note' ? 'Haz clic en la página para añadir una nota' : 'Selecciona texto para copiar, resaltar o comentar'}</span>
          <button className="text-button" onClick={() => { setMobileAnnotating(false); setTool('select'); }}><Check size={16} />Listo</button>
        </div>}

        {!touchLayout && (tool === 'draw' || tool === 'eraser') && doc && !inlineEditing && <div className="ink-settings" role="group" aria-label="Opciones de dibujo">
          <label>Color<input type="color" aria-label="Color del lápiz" value={inkColor} onChange={event => setInkColor(event.target.value)} /></label>
          <label>Trazo<select aria-label="Grosor del lápiz" value={inkWidth} onChange={event => setInkWidth(Number(event.target.value))}>{[1, 2, 3, 5, 8].map(value => <option key={value} value={value}>{value} pt</option>)}</select></label>
          <label><input type="checkbox" checked={penOnly} onChange={event => setPenOnly(event.target.checked)} />Solo lápiz</label>
          <small>{tool === 'eraser' ? 'Toca un trazo para borrarlo' : penOnly ? 'Lápiz para dibujar · dedo para desplazar' : 'Dibuja con lápiz, dedo o mouse'}</small>
        </div>}
        {tablet && doc && mobileAnnotating && !inlineEditing && <TabletAnnotationDock tool={tool} setTool={setTool} disabled={!doc.canAnnotate || !!busy || loading} canCopy={doc.canCopy} color={tool === 'highlight' ? color : inkColor} onSettings={() => setTabletInkOptions(true)} onHighlight={activateHighlight} />}
        {tablet && doc && searchOpen && !sidebar && !inlineEditing && <div className="tablet-search-controls" role="toolbar" aria-label="Resultados de búsqueda"><IconButton label="Ver resultados" onClick={() => setSidebar(true)}><Search size={20} /></IconButton><span>{results.length ? `${resultIndex + 1} / ${results.length}` : 'Sin resultados'}</span><IconButton label="Resultado anterior" disabled={!results.length} onClick={() => goToResult(resultIndex - 1)}><ChevronLeft size={21} /></IconButton><IconButton label="Resultado siguiente" disabled={!results.length} onClick={() => goToResult(resultIndex + 1)}><ChevronRight size={21} /></IconButton><IconButton label="Cerrar búsqueda" onClick={closeSearch}><X size={21} /></IconButton></div>}
        {inlineEditing && workbenchPanel}
        <div className="reading-area" hidden={inlineEditing} style={inlineEditing ? { display: 'none' } : undefined} ref={viewer} aria-label="Área de lectura del PDF" tabIndex={-1}>
          {doc ? <div className="pdf-stack" key={doc.pdf.loadingTask.docId} style={{ gap: readingPreferences.pageGap }}>{doc.sample && <div className="sample-hint"><Sparkles size={13} /><span>PDF de ejemplo</span></div>}{(readingMode === 'single' ? [page] : pages).map(number => <PDFPage key={`${doc.revision}-${number}`} pdf={doc.pdf} number={number} pageLabel={pageLabels?.[number - 1]} scale={scale} rotation={rotation} dimensions={dimensions} annotations={annotationPages.get(number) || []} tool={tool} color={color} inkColor={inkColor} inkWidth={inkWidth} penOnly={penOnly} query={query} activeSearch={searchOpen && (!touchLayout || !sidebar) ? results[resultIndex] : null} onNavigate={navigatePDF} canCopy={doc.canCopy} canAnnotate={doc.canAnnotate && !busy && !loading} onRemoveAnnotation={removeAnnotation} onUpdateAnnotation={updateAnnotation} onCommentHighlight={commentHighlight} onAnnotate={onAnnotate} onArea={onArea} redactions={redactions} onNoteClick={id => { const annotation = annotationRef.current.find(item => item.id === id); if (annotation && doc.canAnnotate) editNote(annotation, 'document'); else { setNotesOpen(true); setActiveNote(id); } }} />)}</div> : !loading && <div className="welcome"><div className="welcome-icon"><BookOpen size={38} /></div><h2>Abrir PDF</h2><p>{phone ? 'Selecciona un PDF desde Archivos.' : 'Selecciona un archivo o arrástralo a esta ventana.'}</p></div>}
          {loading && <div className="loading-overlay"><LoaderCircle size={28} className="spin" /><span>Abriendo PDF…</span></div>}
        </div>

        {phone && doc && <>
          <div className="mobile-reading-status">
            {readingMode === 'single' && <IconButton label="Página anterior" disabled={!!busy || loading || page <= 1} onClick={() => goToPage(page - 1, false)}><ChevronLeft size={20} /></IconButton>}
            <button className="mobile-page-jump" aria-label="Ir a página" title={`Página ${page} de ${doc.pdf.numPages}`} disabled={!!busy || loading} onClick={() => { setPageInput(String(page)); setPageJump(true); }}><span>{currentPageLabel} / {doc.pdf.numPages}</span><ChevronDown size={13} /></button>
            {readingMode === 'single' && <IconButton label="Página siguiente" disabled={!!busy || loading || page >= doc.pdf.numPages} onClick={() => goToPage(page + 1, false)}><ChevronRight size={20} /></IconButton>}
            <IconButton label={hasBookmarkPage(bookmarks, page) ? 'Página marcada' : 'Guardar marcador de esta página'} disabled={!!busy || loading} onClick={toggleBookmark} active={hasBookmarkPage(bookmarks, page)}><Bookmark size={20} fill={hasBookmarkPage(bookmarks, page) ? 'currentColor' : 'none'} /></IconButton>
          </div>
          {!mobileAnnotating && (searchOpen && !sidebar ? <div className="mobile-search-toolbar" role="toolbar" aria-label="Resultados de búsqueda"><button className="mobile-search-list" aria-label="Ver resultados" onClick={() => setSidebar(true)}><Search size={20} /><span>{results.length ? `${resultIndex + 1} / ${results.length}` : 'Sin resultados'}</span></button><IconButton label="Resultado anterior" disabled={!results.length} onClick={() => goToResult(resultIndex - 1)}><ChevronLeft size={22} /></IconButton><IconButton label="Resultado siguiente" disabled={!results.length} onClick={() => goToResult(resultIndex + 1)}><ChevronRight size={22} /></IconButton><IconButton label="Cerrar búsqueda" onClick={closeSearch}><X size={22} /></IconButton></div> : <nav className="mobile-reading-toolbar" aria-label="Acciones de lectura"><button aria-label="Páginas" disabled={!!busy || loading} onClick={() => openExplorer()}><Layers size={22} /><span>Páginas</span></button><button aria-label="Buscar" disabled={!!busy || loading} onClick={openSearch}><Search size={22} /><span>Buscar</span></button><button aria-label="Anotar" disabled={!!busy || loading} onClick={startAnnotating}><Highlighter size={22} /><span>Anotar</span></button><button aria-label="Compartir" disabled={!!busy || loading} onClick={() => void shareDocument()}><Upload size={22} /><span>Compartir</span></button></nav>)}
        </>}
        {!touchLayout && doc && returnLocation?.key === activeTabKey && <button className="desktop-return-location" onClick={returnToLocation}><ChevronLeft size={16} /><span>Volver a p. {returnLocation.page}</span></button>}
        {phone && doc && mobileAnnotating && <div className="mobile-annotation-toolbar" role="toolbar" aria-label="Herramientas de anotación">
          <IconButton label="Resaltado automático" toggle active={tool === 'highlight'} disabled={!doc.canAnnotate || !doc.canCopy || !!busy || loading} onMouseDown={event => event.preventDefault()} onClick={activateHighlight}><Highlighter size={21} /></IconButton>
          {tool === 'highlight' && <HighlightColorPicker color={color} onChange={setColor} disabled={!doc.canAnnotate || !doc.canCopy || !!busy || loading} />}
          <IconButton label="Añadir nota" toggle active={tool === 'note'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool(tool === 'note' ? 'select' : 'note')}><StickyNote size={21} /></IconButton>
          <IconButton label="Seleccionar texto" toggle active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={21} /></IconButton>
          <IconButton label="Dibujar" toggle active={tool === 'draw'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool('draw')}><PenLine size={21} /></IconButton><IconButton label="Borrar dibujo" toggle active={tool === 'eraser'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool('eraser')}><Eraser size={21} /></IconButton><IconButton label="Más herramientas de anotación" onClick={() => setAnnotationOptions(true)}><MoreHorizontal size={22} /></IconButton>
        </div>}

        {tool !== 'select' && tool !== 'highlight' && tool !== 'draw' && tool !== 'eraser' && doc && (phone || !mobileAnnotating) && <div className="annotation-tool-hint">
          <span>{tool === 'note' ? phone ? 'Toca la página para añadir una nota' : 'Haz clic para añadir una nota' : tool === 'redact' ? 'Marca las áreas que quieres eliminar' : 'Arrastra para seleccionar el área'}</span>

          {tool === 'redact' && redactions.length > 0 && <><button className="secondary-button" onClick={() => setRedactions(previous => previous.slice(0, -1))}>Quitar última área</button><button className="primary-button" onClick={() => setWorkbench('redact')}>Revisar {redactions.length} áreas</button></>}
          {!(phone && mobileAnnotating && tool === 'note') && <IconButton label="Terminar herramienta" onClick={() => { setTool('select'); setRedactions([]); }}><X size={15} /></IconButton>}
        </div>}


      </main>

      {notesOpen && <aside className={`notes-panel${touchLayout ? ' mobile-drawer' : ''}`} role={touchLayout ? 'dialog' : undefined} aria-modal={touchLayout ? true : undefined} aria-label={touchLayout ? 'Anotaciones' : undefined}>{touchLayout && <><SheetHandle onClose={closeMobilePanel} label="Cerrar explorador" /><div className="mobile-drawer-heading"><h2>Explorar</h2><IconButton label="Cerrar panel" onClick={closeMobilePanel}><X size={20} /></IconButton></div>{explorerTabs}</>}<div className="notes-heading"><div><MessageSquare size={17} /><h2>Anotaciones</h2><span>{annotations.length}</span></div>{!touchLayout && <IconButton label="Cerrar anotaciones" onClick={() => setNotesOpen(false)}><X size={16} /></IconButton>}</div><div className="notes-scroll" role="tabpanel">{annotations.length ? [...annotations].sort((a, b) => a.page - b.page || a.created - b.created).map(a => <article key={a.id} className={`annotation-card ${activeNote === a.id ? 'selected' : ''}`}><div className="annotation-card-heading"><button onClick={() => { mobilePage(a.page); setActiveNote(a.id); }}>{a.kind === 'note' ? <StickyNote size={14} /> : a.kind === 'ink' ? <PenLine size={14} /> : <Highlighter size={14} />}<span>Página {pageLabels?.[a.page - 1] || a.page}</span></button><IconButton label="Eliminar anotación" disabled={!doc?.canAnnotate || !!busy || loading} onClick={() => removeAnnotation(a.id)}><Trash2 size={14} /></IconButton></div>{a.kind === 'note' ? <><p>{a.text}</p><button className="note-edit" disabled={!doc?.canAnnotate || !!busy || loading} onClick={() => editNote(a, 'list')}>Editar nota</button></> : <span className="highlight-description"><span style={{ backgroundColor: a.color }} />{a.text || (a.kind === 'ink' ? 'Dibujo a mano' : 'Texto resaltado')}</span>}</article>) : <div className="empty-panel annotations-empty"><div className="note-illustration"><StickyNote size={32} /></div><h3>Sin anotaciones</h3></div>}</div></aside>}
    </div>

    {touchLayout && <DocumentSwitcher open={mobileTabs && !library} documents={tabs.map(tab => ({ key: tab.key, id: tab.doc.id, name: tab.doc.name, page: tab.key === activeTabKey ? page : tab.page, pages: tab.doc.pdf.numPages }))} recents={recents} activeKey={activeTabKey} disabled={!!busy || loading || editorDraft} onDismiss={() => setMobileTabs(false)} onSelect={key => { setMobileTabs(false); requestAnimationFrame(() => { closeMobilePanel(); if (key === activeTabKey) setLibrary(false); else void switchTab(key); }); }} onRecent={recent => { setMobileTabs(false); requestAnimationFrame(() => { closeMobilePanel(); void reopenRecent(recent); }); }} onCloseDocument={key => { setMobileTabs(false); requestAnimationFrame(() => void closeTab(key)); }} onImport={() => { setMobileTabs(false); requestAnimationFrame(() => void chooseFile()); }} onLibrary={() => { setMobileTabs(false); void returnToLibrary(); }} />}
    {touchLayout && mobileActions && <Modal title="Acciones del documento" onClose={() => setMobileActions(false)} className="mobile-actions-modal">
      {storageFailed && <p className="mobile-storage-error" role="alert">No se pudo guardar la sesión. Guarda una copia del PDF.</p>}
      <p className="mobile-save-status"><Check size={17} />{storageFailed ? 'La sesión necesita una copia de respaldo.' : 'Tus cambios se conservan automáticamente en este dispositivo.'}</p>
      <div className="mobile-file-actions"><button className="primary-button" aria-label={doc?.drive ? 'Guardar en Drive' : isNative && isAndroid ? 'Guardar PDF' : 'Guardar una copia del PDF'} onClick={() => mobileAction(() => void download())} disabled={!doc || !!busy || loading}><ArrowDownToLine size={20} /><span>{doc?.drive ? 'Guardar en Drive' : isNative && isAndroid ? 'Guardar' : 'Guardar una copia'}</span></button></div>
      <p className="modal-description">{doc?.drive ? 'Guarda los cambios en el mismo archivo de Google Drive.' : isNative && isAndroid ? 'Guardar actualiza el PDF original. Si es un documento nuevo, podrás elegir dónde guardarlo.' : 'Guarda o comparte una copia para incluir los cambios en un archivo PDF.'}</p>
      {doc && (!doc.canAnnotate || isNativePdfDocument(doc.pdf)) && <p className="mobile-capability-summary">{doc.signed ? 'Este PDF está firmado. La edición está desactivada para conservar su firma.' : !doc.canAnnotate ? 'Los permisos del PDF no permiten anotaciones.' : 'Este documento grande usa el lector del sistema: lectura, búsqueda, resaltados y notas disponibles. Las herramientas de edición de páginas no están disponibles.'}</p>}
      <div className="mobile-action-grid">
        {doc?.drive && <button onClick={() => mobileAction(() => { setDriveLibrary(true); setLibrary(true); })}><Cloud size={20} /><span>Ver Drive</span></button>}
        {(doc?.drive || isNative && isAndroid) && <button onClick={() => mobileAction(() => void download({ copy: true }))} disabled={!doc || !!busy || loading}><FilePlus2 size={21} /><span>Guardar una copia</span></button>}
        {tablet && <><button onClick={() => mobileAction(() => void shareDocument())} disabled={!doc || !!busy}><Upload size={21} /><span>Compartir PDF</span></button><button onClick={() => mobileAction(() => openExplorer())}><Layers size={21} /><span>Explorar documento</span></button><button onClick={() => mobileAction(toggleBookmark)}><Bookmark size={21} /><span>{hasBookmarkPage(bookmarks, page) ? 'Página marcada' : 'Guardar marcador'}</span></button><button onClick={() => mobileAction(openEditor)} disabled={!doc?.canEdit || !!busy}><FileText size={21} /><span>Editar PDF</span></button></>}
        <button onClick={() => mobileAction(() => setViewSettings(true))} disabled={!doc}><Settings2 size={21} /><span>Vista del documento</span></button>
        <button onClick={() => mobileAction(openTools)} disabled={!doc || !!busy}><Wrench size={21} /><span>Herramientas</span></button>
        <button onClick={() => mobileAction(() => void printDocument())} disabled={!doc?.canPrint || !!busy}><Printer size={21} /><span>Imprimir PDF</span></button>
        <button onClick={() => mobileAction(() => setInfo(true))} disabled={!doc}><Info size={21} /><span>Información del documento</span></button>
        <button onClick={() => mobileAction(undo)} disabled={!!busy || !undoStack.current.length}><Undo2 size={21} /><span>Deshacer</span></button><button onClick={() => mobileAction(redo)} disabled={!!busy || !redoStack.current.length}><Redo2 size={21} /><span>Rehacer</span></button>
        <button className="mobile-close-document" onClick={() => mobileAction(() => { if (activeTabKey) void closeTab(activeTabKey); })} disabled={!!busy || loading}><X size={21} /><span>Cerrar documento</span></button>
      </div>
    </Modal>}
    {!touchLayout && mobileActions && <Modal title="Acciones del documento" onClose={() => setMobileActions(false)} className="desktop-actions-menu">
      {doc?.drive && <button className="text-button" onClick={() => mobileAction(() => { setDriveLibrary(true); setLibrary(true); })}><Cloud size={16} />Ver Drive</button>}
      <p className="desktop-save-status">{storageFailed ? 'Guarda una copia: no se pudo conservar la sesión.' : 'Tus cambios se conservan en este dispositivo.'}</p>
      <div className="desktop-document-actions">
        <button onClick={() => mobileAction(() => setViewSettings(true))}><Settings2 size={19} /><span>Vista del documento</span><span>Zoom y desplazamiento</span></button>
        <button aria-label="Rotar vista 90 grados" onClick={() => mobileAction(() => setRotation(value => (value + 90) % 360))}><RotateCw size={19} /><span>Rotar vista 90 grados</span></button>
        <button aria-label="Imprimir PDF" disabled={!doc?.canPrint || !!busy} onClick={() => mobileAction(() => void printDocument())}><Printer size={19} /><span>Imprimir PDF</span></button>
        <button aria-label="Pantalla completa" onClick={() => mobileAction(() => void fullscreen())}><Maximize size={19} /><span>Pantalla completa</span></button>
        <button onClick={() => mobileAction(() => setInfo(true))}><Info size={19} /><span>Información del documento</span></button>
        <button onClick={() => mobileAction(() => void returnToLibrary())}><FolderOpen size={19} /><span>Volver a biblioteca</span></button>
        <button onClick={() => mobileAction(() => { if (activeTabKey) void closeTab(activeTabKey); })}><X size={19} /><span>Cerrar documento</span></button>
      </div>
    </Modal>}
    {phone && annotationOptions && <Modal title="Opciones de anotación" onClose={() => setAnnotationOptions(false)}><div className="ink-settings mobile-ink-settings"><label>Color del lápiz<input type="color" aria-label="Color del lápiz" value={inkColor} onChange={event => setInkColor(event.target.value)} /></label><label>Grosor<select aria-label="Grosor del lápiz" value={inkWidth} onChange={event => setInkWidth(Number(event.target.value))}>{[1, 2, 3, 5, 8].map(value => <option key={value} value={value}>{value} pt</option>)}</select></label><label><input type="checkbox" checked={penOnly} onChange={event => setPenOnly(event.target.checked)} />Solo lápiz</label></div><div className="mobile-action-grid"><button onClick={() => { setAnnotationOptions(false); redo(); }} disabled={!!busy || !redoStack.current.length}><Redo2 size={21} />Rehacer</button><button onClick={() => { setAnnotationOptions(false); setSidebar(false); setNotesOpen(true); }}><MessageSquare size={21} />Ver anotaciones ({annotations.length})</button><button onClick={() => { setAnnotationOptions(false); openTools(); }}><Wrench size={21} />Más herramientas</button></div></Modal>}
    {touchLayout && pageJump && doc && <Modal title="Ir a página" onClose={() => setPageJump(false)} className="page-jump-modal"><form onSubmit={event => { event.preventDefault(); const next = Number(pageInput); if (Number.isInteger(next) && next >= 1 && next <= doc.pdf.numPages) { rememberLocation(); setPageJump(false); requestAnimationFrame(() => goToPage(next, false)); } }}><label htmlFor="jump-page-number">Página física (1–{doc.pdf.numPages})</label><input id="jump-page-number" autoFocus data-autofocus aria-label="Número de página" type="text" inputMode="numeric" pattern="[0-9]+" value={pageInput} onChange={event => setPageInput(event.target.value.replace(/\D/g, ''))} /><label className="reading-setting"><span>Recorrer páginas</span><input aria-label="Recorrer páginas" type="range" min="1" max={doc.pdf.numPages} value={Math.max(1, Math.min(doc.pdf.numPages, Number(pageInput) || page))} onChange={event => setPageInput(event.target.value)} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setPageJump(false)}>Cancelar</button><button className="primary-button" disabled={!Number.isInteger(Number(pageInput)) || Number(pageInput) < 1 || Number(pageInput) > doc.pdf.numPages}>Ir a página</button></div></form></Modal>}
    {tablet && tabletInkOptions && <Modal title="Opciones de lápiz y resaltador" className="tablet-ink-modal" onClose={() => setTabletInkOptions(false)}><div className="ink-settings"><label>Color del lápiz<input type="color" aria-label="Color del lápiz" value={inkColor} onChange={event => setInkColor(event.target.value)} /></label><label>Grosor<select aria-label="Grosor del lápiz" value={inkWidth} onChange={event => setInkWidth(Number(event.target.value))}>{[1, 2, 3, 5, 8].map(value => <option key={value} value={value}>{value} pt</option>)}</select></label><label><input type="checkbox" checked={penOnly} onChange={event => setPenOnly(event.target.checked)} />Solo lápiz</label><p>Con Solo lápiz, dibuja con el lápiz y desplaza la página con el dedo.</p><label>Color del resaltador<input type="color" aria-label="Color del resaltador" value={color} onChange={event => setColor(event.target.value)} /></label></div><div className="modal-actions"><button className="primary-button" onClick={() => setTabletInkOptions(false)}>Listo</button></div></Modal>}
    {viewSettings && <ViewSettings phone={phone} mode={readingMode} onMode={setReadingMode} zoom={zoomMode} scale={scale} onZoom={value => { if (['width', 'page'].includes(value)) setZoomMode(value); else { setCustomScale(Number(value) / 100); setZoomMode('custom'); } }} rotation={rotation} onRotate={() => setRotation(value => (value + 90) % 360)} onClose={() => setViewSettings(false)} />}
    {capabilityNotice && <Modal title="Herramientas disponibles" onClose={() => setCapabilityNotice(false)}><p className="modal-description">{doc?.signed ? 'Este PDF está firmado. Puedes leer, buscar, copiar el texto permitido y guardar marcadores. La edición está desactivada para conservar su firma.' : !doc?.canAnnotate ? 'Los permisos del documento no permiten anotaciones. Puedes leerlo, buscar y guardar marcadores. La copia de texto y la impresión dependen de los permisos del PDF.' : 'Este documento grande usa el lector del sistema para conservar memoria. Puedes leer, buscar, resaltar, añadir notas y compartir una copia. Las herramientas avanzadas de edición no están disponibles para este documento.'}</p><div className="modal-actions"><button className="primary-button" onClick={() => setCapabilityNotice(false)}>Entendido</button></div></Modal>}
    <TextSelectionMenu key={doc?.pdf.loadingTask.docId} enabled={!!doc?.canCopy && !mobileActions && tool === 'select' && !loading && !busy && !noteDraft && !workbench && !creating && !library && !settings && !help && !info && !password && !closeBlocked && !pageJump && !viewSettings && !annotationOptions && !capabilityNotice && !deleteTarget && !tabletInkOptions && !(touchLayout && (sidebar || notesOpen || mobileActions || mobileTabs))} canAnnotate={!!doc?.canAnnotate} color={color} onHighlight={() => { highlightSelection(); }} onComment={() => { commentSelection(); }} onNotify={notify} />
    {dragOver && <div className="drop-overlay"><div><Upload size={38} /><h2>Soltar para abrir</h2><p>Archivo PDF</p></div></div>}
    {creating && <CreatePDF onClose={() => setCreating(false)} onCreate={async (bytes, name) => { await openDocument(bytes, name, false, undefined, { modified: true, useSession: false }); setCreating(false); }} />}
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <Info size={18} /> : <Check size={18} />}<span>{toast.message}</span><button aria-label="Cerrar aviso" onClick={() => setToast(null)}><X size={15} /></button></div>}

    {library && <div className={`library-screen${phone ? '' : ' desktop-library-screen'}`}>{driveLibrary ? <DriveBrowser onClose={() => setDriveLibrary(false)} onOpen={openDriveDocument} /> : libraryContent}</div>}
    {deleteTarget && <Modal title="Eliminar copia local" onClose={() => setDeleteTarget(null)}><p className="modal-description">Se eliminarán la copia de «{deleteTarget.name}» de la biblioteca, sus anotaciones, marcadores y cambios guardados en este dispositivo. El archivo original de Archivos no se modifica.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setDeleteTarget(null)}>Cancelar</button><button className="primary-button destructive-button" disabled={!!busy || loading} onClick={() => void forgetRecent(deleteTarget)}>Eliminar copia local y cambios</button></div></Modal>}
    {!inlineEditing && workbenchPanel}
    {noteDraft && <Modal title={noteDraft.id ? 'Editar nota' : 'Añadir nota'} onClose={() => setNoteDraft(null)} className="note-modal"><div className="note-page-label"><StickyNote size={16} />Página {noteDraft.page}</div><textarea autoFocus data-autofocus aria-label="Texto de la nota" placeholder="Escribe un comentario" value={noteText} maxLength={5000} onChange={e => setNoteText(e.target.value)} /><div className="note-modal-footer"><span>{noteText.length} / 5000</span><button className="secondary-button" onClick={() => setNoteDraft(null)}>Cancelar</button><button className="primary-button" disabled={!noteText.trim()} onClick={saveNote}><Check size={16} />Guardar nota</button></div></Modal>}
    {password && <Modal title="Este PDF tiene contraseña" onClose={cancelPassword} className="password-modal"><p className="modal-description">Introduce la contraseña para abrirlo.</p><form onSubmit={e => { e.preventDefault(); if (passwordText) { password.submit(passwordText); setPassword(null); } }}><label htmlFor="pdf-password">Contraseña del documento</label><input autoFocus data-autofocus id="pdf-password" type="password" value={passwordText} onChange={e => setPasswordText(e.target.value)} autoComplete="off" />{password.retry && <p className="password-error">La contraseña anterior no es correcta. Inténtalo de nuevo.</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={cancelPassword}>Cancelar</button><button className="primary-button" disabled={!passwordText}><LockKeyhole size={15} />Abrir PDF</button></div></form></Modal>}
    {info && doc && <Modal title="Sobre este documento" onClose={() => setInfo(false)} className="info-modal"><div className="info-file"><FileText size={30} /><strong>{doc.name}</strong></div><dl className="document-details"><div><dt>Páginas</dt><dd>{doc.pdf.numPages}</dd></div><div><dt>Tamaño</dt><dd>{formatSize(doc.size)}</dd></div><div><dt>Anotaciones de Folio</dt><dd>{annotations.length}</dd></div><div><dt>Marcadores</dt><dd>{bookmarks.length}</dd></div><div><dt>Procesamiento</dt><dd>Local, en tu dispositivo</dd></div></dl></Modal>}
    {settings && <ReadingSettings phone={phone} theme={theme} onTheme={setTheme} zoom={defaultZoom} onZoom={setDefaultZoom} preferences={readingPreferences} onPreferences={value => { setReadingPreferences(value); if (!phone) setReadingMode(value.mode); }} rememberRecent={rememberRecent} onRemember={setRememberRecent} confirmClear={confirmClear} onClear={() => void clearLibrary()} onCancelClear={() => setConfirmClear(false)} onClose={() => setSettings(false)} />}
    {help && <Modal title={phone ? "Ayuda" : "Ayuda y atajos"} onClose={() => setHelp(false)} className="help-modal"><div className="help-feature"><Highlighter size={21} /><div><strong>Anotaciones</strong><p>{phone ? "Mantén pulsada una palabra y mueve los controles de selección. Aparece un menú para copiar, resaltar o comentar. Anotar abre las herramientas inferiores; Listo vuelve a lectura. El resaltador activa el modo automático y muestra su selector de color. Toca un resaltado para cambiar el color, comentar o eliminarlo. Amplía o reduce el documento con dos dedos." : "Activa el resaltado automático y selecciona palabras o líneas; pulsa H otra vez para desactivarlo. Elige el color junto al resaltador. Al seleccionar texto con V, aparece el menú para copiar, resaltar o comentar. Para añadir una nota, activa la herramienta de notas y haz clic en la página."}</p></div></div><div className="help-feature"><ShieldCheck size={21} /><div><strong>Guardar comentarios</strong><p>Los cambios se conservan en este dispositivo. {isNative && isAndroid ? 'Guardar actualiza el PDF original; Guardar una copia crea un archivo aparte.' : <>Usa {isNative || phone ? 'Guardar una copia' : 'Descargar'} o Compartir para incluirlos en un archivo PDF.</>}</p></div></div>{!phone && <><h3 className="shortcuts-heading">Atajos de teclado</h3><div className="shortcut-grid">{[['Abrir PDF', shortcutLabel('O')], ['Cambiar de pestaña', 'Ctrl+Tab'], ['Cerrar pestaña', shortcutLabel('W')], ['Buscar', shortcutLabel('F')], [isDesktop ? 'Guardar' : 'Descargar', shortcutLabel('S')], ['Deshacer', shortcutLabel('Z')], ['Rehacer', shortcutLabel('⇧+Z')], ['Cambiar de página', '← / →'], ['Seleccionar texto', 'V'], ['Resaltado automático', 'H'], ['Añadir nota', 'N'], ['Zoom', isMac ? '⌘ / Ctrl + rueda' : 'Ctrl + rueda'], ['Salir de una herramienta', 'Esc']].map(([label, keys]) => <div key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}</div></>}<p className="help-limit">{phone ? "Toca el nombre para cambiar de PDF o importar otro. Páginas reúne miniaturas, índice, marcadores y anotaciones. Toca el contador para saltar a una página; el marcador guarda la página sin abrir el teclado. Más acciones ofrece Vista del documento, Guardar una copia y herramientas. La flecha superior vuelve a la biblioteca y conserva los documentos abiertos. Un toque breve sobre el PDF oculta o muestra los controles; no cambia su tamaño." : <>Usa Herramientas para editar, organizar páginas, rellenar formularios, reconocer texto, comparar documentos o trabajar con firmas. Guarda una copia con {shortcutLabel('S')}.</>}</p></Modal>}
  </div>;
}
