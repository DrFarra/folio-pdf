import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, BookOpen, Bookmark, Check,
  ChevronDown, ChevronLeft, ChevronRight, CircleHelp, FileText, FolderOpen,
  Highlighter, Info, Keyboard, Layers, ListTree, LoaderCircle, LockKeyhole,
  Maximize, MessageSquare, Minus, MoreHorizontal, MousePointer2, PanelLeft,
  Plus, Printer, Redo2, RotateCw, Search, ShieldCheck,
  Settings2, Sparkles, StickyNote, Trash2, Undo2, Upload, X, Wrench, FilePlus2,
} from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import PDFPage, { Thumbnail } from './components/PDFPage';
import Modal from './components/Modal';
import { buildTextIndex, exportAnnotated, formatSize, getDocument, readOutline, searchText } from './pdf';
import { openNativePdf, isNativePdfDocument, isNativePdfPasswordError, nativePdfPageAnnotations, subscribeNativePdfAnnotations } from './nativePdf';
import { migrateLegacyNativePage } from './native-session';
import type { Inspection } from './engine/mupdf-engine.mjs';
import type { NativeDocument } from './platform';
import { inspectPdf, processPdf } from './engine/client';
import type { Area, Operation } from './engine/operations.mjs';
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
import { usePhoneLayout } from './mobile';
import { assetUrl, pdfAssetSettings } from './assets';
import { isDesktop, isNative, isIOS, isMac, shortcutLabel, pickNativeDocuments, readNativeDocument, savePdf, sharePdf, printPdf, presentNativePdf, nativeDraftDocument, startupDocuments } from './platform';
import { clearSavedState, forgetDocument, listRecent, readSession, rememberDocument, saveSession, readDraft, storeDraft, discardDraft } from './storage';
import type { Annotation, BookmarkNode, LoadedDocument, OutlineEntry, RecentDocument, Session, SideTab, Tool } from './types';

const DEFAULT_HIGHLIGHT_COLOR = '#f5d164';
const SAMPLE_NAME = 'El arte de observar.pdf';
const annotationFingerprint = (items: Annotation[]) => JSON.stringify(items.map(a => [a.id, a.page, a.kind, a.rect, a.text, a.color, a.quads]));
const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const preference = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? String(error.message) : 'No se pudo completar la operación.';
type OpenSource = Blob | Uint8Array | 'sample' | NativeDocument;
const nativeReadingThreshold = 32 * 1024 * 1024;
type NoteDraft = Omit<Annotation, 'id' | 'created'> & { id?: string };
type OpenContext = { savedCopy?: boolean; draftSource?: boolean; id?: string; password?: string; modified?: boolean; useSession?: boolean; preserveHistory?: boolean; page?: number; bookmarks?: BookmarkNode[] };
type History = { annotations: Annotation[]; bytes?: Uint8Array; password?: string; page?: number; bookmarks?: BookmarkNode[] };
type TabView = { page: number; dimensions: { width: number; height: number; rotation: number }; zoomMode: string; customScale: number; rotation: number; tool: Tool; color: string; sidebar: boolean; sideTab: SideTab; notesOpen: boolean; outline: OutlineEntry[]; textIndex: string[]; indexing: boolean; searchOpen: boolean; query: string; resultIndex: number; activeNote: string | null; redactions: Area[]; editArea: Area | null; sessionFailed: boolean; draftFailed: boolean };
type DocumentTab = TabView & { key: string; doc: LoadedDocument; annotations: Annotation[]; bookmarks: BookmarkNode[]; undo: History[]; redo: History[]; scrollTop: number; scrollLeft: number };

function IconButton({ children, label, onClick, onMouseDown, disabled = false, active = false, toggle = false, className = '' }: { children: React.ReactNode; label: string; onClick: () => void; onMouseDown?: React.MouseEventHandler<HTMLButtonElement>; disabled?: boolean; active?: boolean; toggle?: boolean; className?: string }) {
  return <button className={`icon-button ${active ? 'active' : ''} ${className}`} aria-label={label} aria-pressed={toggle ? active : undefined} title={label} onClick={onClick} onMouseDown={onMouseDown} disabled={disabled}>{children}</button>;
}

export default function App() {
  const phone = usePhoneLayout();
  const [mobileActions, setMobileActions] = useState(false);
  const [mobileTabs, setMobileTabs] = useState(false);
  const [mobileAnnotating, setMobileAnnotating] = useState(false);
  const [readerChromeHidden, setReaderChromeHidden] = useState(false);
  const [doc, setDoc] = useState<LoadedDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'download' | 'print' | 'edit' | null>(null);
  const [workbench, setWorkbench] = useState<string | null>(null);
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
  const [tool, setTool] = useState<Tool>('select');
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
  const [library, setLibrary] = useState(false);
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
  const [noteText, setNoteText] = useState('');
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const [password, setPassword] = useState<{ retry: boolean; submit: (value: string) => void } | null>(null);
  const [passwordText, setPasswordText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [sessionFailed, setSessionFailed] = useState(false);
  const [draftFailed, setDraftFailed] = useState(false);
  const storageFailed = sessionFailed || draftFailed;
  useEffect(() => { if (phone && (tool === 'highlight' || tool === 'note')) setMobileAnnotating(true); }, [phone, tool]);
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
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const engineRef = useRef<AbortController | null>(null);
  const docRef = useRef<LoadedDocument | null>(null);
  const annotationRef = useRef<Annotation[]>([]);
  const readingState = useRef({ page, bookmarks });
  readingState.current = { page, bookmarks };
  const undoStack = useRef<History[]>([]);
  const redoStack = useRef<History[]>([]);
  const draftSave = useRef<Promise<void>>(Promise.resolve());
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
  const wheelAnchor = useRef<{ id: string; page: number; x: number; y: number; pointerX: number; pointerY: number } | null>(null);
  const activeView = useRef<TabView>(null!);
  activeView.current = { page, dimensions, zoomMode, customScale, rotation, tool, color, sidebar, sideTab, notesOpen, outline, textIndex, indexing, searchOpen, query, resultIndex, activeNote, redactions, editArea, sessionFailed, draftFailed };

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
    if (phoneRef.current) setMobileAnnotating(tab.tool === 'highlight' || tab.tool === 'note');
    setSidebar(phoneRef.current ? false : tab.sidebar); setSideTab(tab.sideTab); setNotesOpen(phoneRef.current ? false : tab.notesOpen); setOutline(tab.outline); setTextIndex(tab.textIndex); setIndexing(tab.indexing);
    setSearchOpen(tab.searchOpen); setQuery(tab.query); setResultIndex(tab.resultIndex); setActiveNote(tab.activeNote);
    setRedactions(tab.redactions); setEditArea(tab.editArea); setSessionFailed(tab.sessionFailed); setDraftFailed(tab.draftFailed); setBookmarkEditingId(null);
    setWorkBenchClosed(); setHistoryTick(v => v + 1); window.getSelection()?.removeAllRanges();
    if (focusSelectedTab) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.document-tab[data-tab-key="${CSS.escape(tab.key)}"] [role=tab]`)?.focus({ preventScroll: true }));
  }
  function setWorkBenchClosed() { setWorkbench(null); setInfo(false); setLibrary(false); setNoteDraft(null); }
  async function persistTab(tab: DocumentTab) {
    await draftSave.current;
    if (tab.doc.modified && !isNativePdfDocument(tab.doc.pdf)) await storeDraft(tab.doc.id, tab.doc.bytes);
    const saved = await saveSession(tab.doc.id, { annotations: tab.annotations, lastPage: tab.page, bookmarks: tab.bookmarks, documentRevision: tab.doc.revision, nativeKnownPages: tab.doc.nativeKnownPages, nativeOriginalRefs: tab.doc.nativeOriginalRefs, nativeSavedAnnotations: tab.doc.savedAnnotations, nativeLegacySession: tab.doc.nativeLegacySession });
    if (!saved) throw new Error('No se pudo conservar la sesión. Guarda el PDF antes de cerrar la pestaña.');
  }
  async function switchTab(key: string) {
    if (key === activeTabRef.current || busyRef.current || loadingRef.current || document.querySelector('dialog[open]')) return;
    const next = tabsRef.current.find(tab => tab.key === key); if (!next) return;
    const focusSelectedTab = document.activeElement?.getAttribute('role') === 'tab';
    try {
      loadingRef.current = true; setLoading(true);
      const current = captureTab(); if (current) await persistTab(current);
      retainCurrentTab(); activateTab(next, focusSelectedTab); publishTabs();
    } catch (error) { notify(error instanceof Error ? error.message : 'No se pudo cambiar de pestaña.', true); }
    finally { loadingRef.current = false; setLoading(false); }
  }
  async function closeTab(key: string) {
    if (busyRef.current || loadingRef.current || document.querySelector('dialog[open]')) return;
    const index = tabsRef.current.findIndex(tab => tab.key === key); if (index < 0) return;
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
          setReaderChromeHidden(false); setDoc(null); setAnnotations([]); setBookmarks([]); setOutline([]); setTextIndex([]); setQuery(''); setSearchOpen(false); setNotesOpen(false); setSidebar(false); setTool('select'); setRedactions([]); setEditArea(null); setWorkBenchClosed();
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
      if (!context && nativeInput?.id) {
        const existing = tabsRef.current.find(tab => tab.doc.id === nativeInput.id);
        if (existing) { retainCurrentTab(); activateTab(tabsRef.current.find(tab => tab.key === existing.key)!); publishTabs(); setLoading(false); loadingRef.current = false; return true; }
      }
      const fileBacked = isNative && isIOS && !!nativeFile && nativeFile.size > nativeReadingThreshold;
      const digest = async (data: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer))].map(n => n.toString(16).padStart(2, '0')).join('');
      let bytes = new Uint8Array(0) as Uint8Array;
      let id: string, revision: string, pdf: PDFDocumentProxy, inspection: Inspection;
      let originalBytes = bytes;
      let modified = context?.modified || false;
      let documentPassword = context?.password || '';
      let size = 0;
      if (fileBacked) {
        if (!context && nativeInput?.id) {
          const draft = await nativeDraftDocument(nativeInput.id, name);
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
        id = context?.id || nativeInput?.id || opened.metadata.id; revision = opened.metadata.revision; size = opened.metadata.size;
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
        originalBytes = bytes; id = context?.id || await digest(bytes);
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
      if (!context?.preserveHistory) { undoStack.current = []; redoStack.current = []; }
      setHistoryTick(v => v + 1); setRedactions([]); setEditArea(null);
      const initialZoom = preferencesRef.current.defaultZoom;
      const initialScale = Number(initialZoom) ? Math.max(.25, Math.min(3, Number(initialZoom) / 100)) : 1;
      const initialZoomMode = Number(initialZoom) ? 'custom' : initialZoom;
      const initialPanel = readingPreferencesRef.current.initialPanel;
      if (!replacing) { setRotation(0); setZoomMode(initialZoomMode); setCustomScale(initialScale); setSidebar(initialPanel !== 'closed'); if (initialPanel !== 'closed') setSideTab(initialPanel); setSearchOpen(false); setQuery(''); setResultIndex(0); setNotesOpen(false); setActiveNote(null); }
      setTool(restoredTool); setLibrary(false); setWorkbench(null); setNoteDraft(null); setBookmarkEditingId(null);
      setOutline([]); setTextIndex([]); setSessionFailed(false); setDraftFailed(false); setPassword(null); setInfo(false);
      setLoading(false); loadingRef.current = false; taskRef.current = null;
      const tab: DocumentTab = { ...activeView.current, tool: restoredTool, key, doc: loaded, annotations: annotationRef.current, bookmarks: restoredBookmarks, page: readingState.current.page,
        dimensions: { width: view.width, height: view.height, rotation: first.rotate }, undo: undoStack.current, redo: redoStack.current,
        scrollTop: replacing ? previousTab?.scrollTop || 0 : 0, scrollLeft: replacing ? previousTab?.scrollLeft || 0 : 0,
        outline: [], textIndex: [], indexing: true, redactions: [], editArea: null, sessionFailed: false, draftFailed: false,
        ...(replacing ? {} : { rotation: 0, zoomMode: initialZoomMode, customScale: initialScale, sidebar: initialPanel !== 'closed', sideTab: initialPanel === 'closed' ? 'pages' as SideTab : initialPanel, tool: 'select' as Tool, searchOpen: false, query: '', resultIndex: 0, notesOpen: false, activeNote: null }) };
      tabsRef.current = replacing ? tabsRef.current.map(existing => existing.key === key ? tab : existing) : [...tabsRef.current, tab];
      publishTabs();
      if (previous) setTimeout(() => { void previous.pdf.loadingTask.destroy(); }, 200);
      if (!loaded.sample) {
        if (preferencesRef.current.rememberRecent && !context?.preserveHistory && !(context?.modified && nativeSource)) rememberDocument({ id, name, size, pages: pdf.numPages, openedAt: Date.now(), nativeSource: nativeInput?.token || nativeSource, data: nativeSource ? undefined : new Blob([new Uint8Array(originalBytes).buffer], { type: 'application/pdf' }) })
          .catch(() => notify('No se pudo recordar este PDF en la biblioteca.', true));
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
    if (!doc?.modified || isNativePdfDocument(doc.pdf)) return;
    draftSave.current = draftSave.current.catch(() => {}).then(async () => {
      await storeDraft(doc.id, doc.bytes);
      if (doc.draftSource && preferencesRef.current.rememberRecent && !forgottenIds.current.has(doc.id)) await rememberDocument({ id: doc.id, name: doc.name, size: doc.size, pages: doc.pdf.numPages, openedAt: Date.now(), draft: true });
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
      if (isNative && isIOS) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_mobile_theme', { theme: resolved })).catch(() => {});
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
    if (!doc) return;
    const timeout = setTimeout(() => {
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
        text.push(content.items.map(item => 'str' in item ? item.str : '').join(' '));
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
    if (library) listRecent().then(setRecents).catch(() => { setRecents([]); notify('La biblioteca local no está disponible en este navegador.', true); });
  }, [library, notify]);
  useEffect(() => {
    if (searchOpen) { setSidebar(true); setTimeout(() => searchInput.current?.focus(), 50); }
  }, [searchOpen]);
  useEffect(() => {
    const root = viewer.current;
    if (!root) return;
    const observer = new ResizeObserver(() => setViewportSize({ width: root.clientWidth, height: root.clientHeight }));
    observer.observe(root);
    return () => observer.disconnect();
  }, [doc]);
  useEffect(() => {
    const root = viewer.current;
    if (!phone || !doc || !root) return;
    let origin: { id: number; x: number; y: number; top: number; left: number; at: number } | null = null;
    const doubleTapWindow = 350;
    let timer = 0, lastTap = 0;
    const cancel = () => { origin = null; if (timer) clearTimeout(timer); timer = 0; };
    const down = (event: PointerEvent) => {
      if (timer) clearTimeout(timer);
      timer = 0;
      if (event.pointerType !== 'touch' || !event.isPrimary || tool !== 'select' || busy || loading) { origin = null; return; }
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
          !window.getSelection()?.isCollapsed || document.querySelector('dialog[open]')) return;
      lastTap = Date.now();
      timer = window.setTimeout(() => { timer = 0; if (window.getSelection()?.isCollapsed && !document.querySelector('dialog[open]')) setReaderChromeHidden(value => !value); }, doubleTapWindow);
    };
    const selection = () => { if (!window.getSelection()?.isCollapsed) cancel(); };
    root.addEventListener('pointerdown', down, true); root.addEventListener('pointerup', up, true);
    root.addEventListener('pointercancel', cancel, true); window.addEventListener('folio:pinch-start', cancel);
    document.addEventListener('selectionchange', selection);
    return () => { cancel(); root.removeEventListener('pointerdown', down, true); root.removeEventListener('pointerup', up, true); root.removeEventListener('pointercancel', cancel, true); window.removeEventListener('folio:pinch-start', cancel); document.removeEventListener('selectionchange', selection); };
  }, [phone, doc, tool, busy, loading]);
  useEffect(() => {
    if (!doc || !viewer.current) return;
    const root = viewer.current;
    const visible = new Set<Element>();
    let frame = 0;
    const update = () => {
      frame = 0;
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
  }, [doc, readingPreferences.mode, readingPreferences.mode === 'single' ? page : null]);

  const scale = useMemo(() => {
    const rotated = rotation % 180 !== 0;
    const w = rotated ? dimensions.height : dimensions.width;
    const h = rotated ? dimensions.width : dimensions.height;
    if (zoomMode === 'width') return Math.max(.25, Math.min(3, (viewportSize.width - (phone ? 16 : viewportSize.width < 600 ? 30 : 100)) / w));
    if (zoomMode === 'page') return Math.max(.25, Math.min(2, (viewportSize.width - (phone ? 16 : 54)) / w, (viewportSize.height - (phone ? 40 : 76)) / h));
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
    if (!phone || !root) return;
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
  }, [phone]);

  useEffect(() => {
    if (!phone || !(sidebar || notesOpen)) return;
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
  }, [phone, sidebar, notesOpen, bookmarkEditingId]);
  const results = useMemo(() => searchText(textIndex, query), [textIndex, query]);
  const occurrences = results.reduce((sum, r) => sum + r.count, 0);
  const pages = useMemo(() => Array.from({ length: doc?.pdf.numPages || 0 }, (_, i) => i + 1), [doc]);
  const annotationPages = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    annotations.forEach(a => { const list = map.get(a.page) || []; list.push(a); map.set(a.page, list); });
    return map;
  }, [annotations]);

  const goToPage = useCallback((number: number, smooth = true) => {
    const pdf = docRef.current?.pdf;
    if (!pdf || !viewer.current) return;
    pageInputDirty.current = false;
    const next = Math.max(1, Math.min(pdf.numPages, number));
    setPage(next); setPageInput(String(next));
    const node = viewer.current.querySelector<HTMLElement>(`[data-page-number="${next}"]`);
    if (node) {
      const distance = node.getBoundingClientRect().top - viewer.current.getBoundingClientRect().top - 16;
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
    if (readingPreferences.mode === 'single' && viewer.current) viewer.current.scrollTop = 0;
  }, [page, readingPreferences.mode]);
  useEffect(() => {
    if (docRef.current) goToPage(readingState.current.page, false);
  }, [readingPreferences.mode, goToPage]);

  useEffect(() => {
    if (!doc) return;
    const restored = restoreScroll.current;
    restoreScroll.current = null;
    const frame = requestAnimationFrame(() => {
      if (restored?.key === activeTabRef.current && viewer.current) viewer.current.scrollTo({ top: restored.top, left: restored.left, behavior: 'instant' });
      else goToPage(doc.initialPage, false);
    });
    return () => cancelAnimationFrame(frame);
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
    const next = addPageBookmark(readingState.current.bookmarks, page);
    commitBookmarks(next.bookmarks);
    setSidebar(true); setSearchOpen(false); setSideTab('bookmarks'); setBookmarkEditingId(next.id);
  }, [page, commitBookmarks]);
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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearchOpen(true); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); void printDocument(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void download(); return; }
      if (editing) return;
      if (busyRef.current || loadingRef.current) return;
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if ((e.ctrlKey || e.metaKey) && ['+', '=', '-'].includes(e.key)) { e.preventDefault(); changeZoom(e.key === '-' ? -.1 : .1); }
      else if (e.ctrlKey || e.metaKey || e.altKey) return;
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goToPage(page + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goToPage(page - 1); }
      else if (e.key.toLowerCase() === 'h') activateHighlight();
      else if (e.key.toLowerCase() === 'n' && docRef.current?.canAnnotate) setTool('note');
      else if (e.key.toLowerCase() === 'v') setTool('select');
      else if (e.key === 'Escape') { setReaderChromeHidden(false); setTool('select'); setSearchOpen(false); setQuery(''); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [page, goToPage, undo, redo, changeZoom]);

  async function openFiles(files: File[]) {
    if (busyRef.current) return;
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') { notify('Elige un archivo PDF para abrirlo.', true); continue; }
      await openDocument(file, file.name);
    }
  }
  async function chooseFile() {
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
      if (recent.nativeSource) await openDocument({ token: recent.nativeSource, name: recent.name, size: recent.size }, recent.name, false, recent.nativeSource, recent.draft ? { id: recent.id, modified: true, draftSource: true } : undefined);
      else if (recent.data) await openDocument(recent.data, recent.name);
    } catch { notify('No se pudo reabrir el archivo. Vuelve a elegirlo desde Abrir PDF.', true); }
  }
  function onAnnotate(annotation: AnnotationDraft | AnnotationDraft[]) {
    if (!doc?.canAnnotate || busyRef.current || loadingRef.current) return;
    if (Array.isArray(annotation)) {
      // A selection spanning several pages is one action in the document history.
      commitAnnotations([...annotationRef.current, ...annotation.map(item => ({ ...item, id: uid(), created: Date.now() }))]);
      return;
    }
    if (annotation.kind === 'note') { setNoteDraft(annotation); setNoteText(''); return; }
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
    setBusy('edit');
    await openDocument(value.bytes, current.name, current.sample, current.nativeSource, { id: current.id, draftSource: current.draftSource, password: value.password,
      modified: true, useSession: false, preserveHistory: true, page: value.page, bookmarks: value.bookmarks });
    annotationRef.current = value.annotations; setAnnotations(value.annotations); setBusy(null); setHistoryTick(v => v + 1);
  }
  async function applyOperation(operation: Operation, signal?: AbortSignal) {
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
        useSession: false, preserveHistory: true, page: before.page, bookmarks: bookmarkPages });
      if (!opened) throw new Error('No se pudo cargar el resultado de la operación.');
      undoStack.current.push(before);
      // Bound the total retained PDF history as well as the number of operations.
      trimHistory(undoStack.current, 20);
      redoStack.current = []; setHistoryTick(v => v + 1); setWorkbench(null); setTool('select');
      if (operation.operation === 'compress') notify(output.length < source.length ? `PDF reducido de ${formatSize(source.length)} a ${formatSize(output.length)}.` : 'El PDF ya está optimizado; no se redujo su tamaño.');
    } finally { setBusy(null); }
  }
  async function currentBytes() {
    const current = docRef.current; if (!current) throw new Error('No hay documento abierto.');
    if (isNativePdfDocument(current.pdf)) throw new Error('Este PDF se guarda directamente desde el lector nativo.');
    return current.canAnnotate ? exportAnnotated(current.bytes, annotationRef.current, current.password) : current.bytes;
  }
  async function replaceDocument(bytes: Uint8Array) {
    const current = docRef.current; if (!current) return;
    setBusy('edit');
    try {
      const before = snapshot();
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
    setNoteDraft(null); setNotesOpen(true); setActiveNote(next.id); setTool('select');
  }
  async function presentFileBacked(current: LoadedDocument, action: 'save' | 'share' | 'print') {
    if (current.nativeLegacySession) for (let number = 1; number <= current.pdf.numPages; number++) await nativePdfPageAnnotations(current.pdf, number);
    if (current.nativeLegacySession) throw new Error('No se pudieron recuperar todas las anotaciones de la sesión anterior. La copia no se ha guardado.');
    const removed = (current.nativeOriginalRefs || []).filter(ref => !annotationRef.current.some(annotation => annotation.nativeSourceRef === ref));
    return presentNativePdf(current.nativeSource!, action === 'save' ? current.name.replace(/\.pdf$/i, '') + ' — copia.pdf' : current.name, action, annotationRef.current, removed);
  }
  async function download() {
    const current = docRef.current;
    if (!current || busyRef.current || loadingRef.current || saving.current) return;
    saving.current = true;
    setBusy('download');
    try {
      if (isNativePdfDocument(current.pdf)) {
        const saved = await presentFileBacked(current, 'save');
        if (saved && typeof saved === 'object') {
          const opened = await openDocument(saved, saved.name, false, saved.token, { savedCopy: true, password: current.password, useSession: false, page: readingState.current.page, bookmarks: readingState.current.bookmarks });
          if (opened) await discardDraft(current.id);
          notify('PDF guardado.');
        }
        return;
      }
      const bytes = await currentBytes();
      const saved = await savePdf(bytes, current.name.replace(/\.pdf$/i, '') + ' — copia.pdf', current.nativeSource);
      if (saved) {
        await draftSave.current.catch(() => {});
        const opened = await openDocument(bytes, typeof saved === 'object' ? saved.name : current.name, false, typeof saved === 'object' ? saved.token : undefined,
          { savedCopy: true, password: current.password, useSession: false, page: readingState.current.page, bookmarks: readingState.current.bookmarks });
        if (opened) await discardDraft(current.id);
        notify('PDF guardado.');
      }
    } catch (error) { notify(error instanceof Error ? error.message : 'No se pudo guardar el PDF. El original está intacto.', true); }
    finally { saving.current = false; setBusy(null); }
  }
  async function printDocument() {
    const current = docRef.current;
    if (!current?.canPrint || busyRef.current) return;
    if (isIOS) {
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
    setResultIndex(next); goToPage(results[next].page);
  }
  function closeSearch() { setSearchOpen(false); setQuery(''); }
  async function shareDocument() {
    const current = docRef.current; if (!current || busyRef.current || saving.current) return;
    setBusy('download');
    try { if (isNativePdfDocument(current.pdf)) await presentFileBacked(current, 'share'); else await sharePdf(current.canAnnotate ? await exportAnnotated(current.bytes, annotationRef.current, current.password) : current.bytes, current.name, current.nativeSource); }
    catch (error) { notify(error instanceof Error ? error.message : 'No se pudo compartir el PDF.', true); }
    finally { setBusy(null); }
  }
  function mobileAction(action: () => void) { setMobileActions(false); requestAnimationFrame(action); }
  function closeMobilePanel() { setSidebar(false); setSearchOpen(false); setNotesOpen(false); if (phoneRef.current) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="Explorar documento"]')?.focus({ preventScroll: true })); }
  function mobilePage(number: number) { goToPage(number); if (phoneRef.current) closeMobilePanel(); }
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
    try {
      await draftSave.current.catch(() => {});
      for (const tab of tabsRef.current) forgottenIds.current.add(tab.doc.id);
      await clearSavedState();
      annotationRef.current = []; setAnnotations([]); setBookmarks([]);
      undoStack.current = []; redoStack.current = []; setHistoryTick(v => v + 1);
      tabsRef.current = tabsRef.current.map(tab => ({ ...tab, annotations: [], bookmarks: [], undo: [], redo: [] })); publishTabs();
      setRecents([]); setConfirmClear(false);
      notify('Biblioteca y anotaciones locales eliminadas.');
    } catch { notify('No se pudo eliminar la biblioteca local.', true); }
  }
  async function forgetRecent(recent: RecentDocument) {
    try {
      await draftSave.current.catch(() => {}); await forgetDocument(recent.id); forgottenIds.current.add(recent.id);
      tabsRef.current = tabsRef.current.map(tab => tab.doc.id === recent.id ? { ...tab, annotations: [], bookmarks: [], undo: [], redo: [] } : tab);
      if (docRef.current?.id === recent.id) { annotationRef.current = []; setAnnotations([]); setBookmarks([]); undoStack.current = []; redoStack.current = []; setHistoryTick(v => v + 1); }
      publishTabs(); setRecents(await listRecent()); notify('Archivo y anotaciones eliminados de la biblioteca local.');
    } catch { notify('No se pudo eliminar el archivo de la biblioteca.', true); }
  }

  return <div className={`app-shell${isDesktop && isMac ? ' native-mac' : ''}${phone ? ' phone-layout' : ''}${readerChromeHidden ? ' reader-chrome-hidden' : ''}`} onDragEnter={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragCounter.current++; setDragOver(true); } }} onDragLeave={e => { e.preventDefault(); if (--dragCounter.current <= 0) { dragCounter.current = 0; setDragOver(false); } }} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { e.preventDefault(); dragCounter.current = 0; setDragOver(false); if (!isNative) void openFiles(Array.from(e.dataTransfer.files)); }}>
    {closeBlocked && <Modal title="No se pudo guardar la sesión" onClose={() => setCloseBlocked(false)}><p className="modal-description">Puedes guardar una copia del PDF antes de salir. Si cierras ahora, los cambios de esta sesión podrían perderse.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setCloseBlocked(false)}>Volver</button><button className="secondary-button" onClick={() => { setCloseBlocked(false); void download(); }}>Guardar una copia</button><button className="primary-button" onClick={() => { void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().destroy()); }}>Cerrar sin guardar sesión</button></div></Modal>}
    <header className="app-header" data-tauri-drag-region inert={phone && (sidebar || notesOpen)}>
      {!phone && <div className="brand"><img src="/folio.svg" alt="Folio" /></div>}
      <h1 className="sr-only">{doc?.name || 'Folio'}</h1>
      {phone ? <>
        <IconButton label="Explorar documento" disabled={!doc} onClick={() => { setNotesOpen(false); setSidebar(v => !v); }}><PanelLeft size={21} /></IconButton>
        <button className="mobile-document-selector" aria-label="Documentos abiertos" aria-haspopup="dialog" disabled={!!busy || loading || !tabs.length} onClick={() => setMobileTabs(true)}><span>{doc?.name || 'Folio'}</span>{tabs.length > 0 && <span className="mobile-tab-count">{tabs.length}</span>}<ChevronDown size={16} /></button>
        <IconButton label="Abrir PDF" disabled={!!busy || loading} onClick={() => void chooseFile()}><Plus size={21} /></IconButton>
        <IconButton label="Más acciones" onClick={() => setMobileActions(true)}><MoreHorizontal size={23} /></IconButton>
      </> : <>
      <div className="document-tab-strip" role="tablist" aria-label="Documentos abiertos">
        {tabs.map(tab => <div className={`document-tab ${tab.key === activeTabKey ? 'selected' : ''}`} key={tab.key} data-tab-key={tab.key}>
          <button role="tab" aria-selected={tab.key === activeTabKey} aria-controls="document-reader" aria-label={tab.doc.name} title={tab.doc.name} tabIndex={tab.key === activeTabKey ? 0 : -1} disabled={!!busy || loading} onClick={() => void switchTab(tab.key)} onKeyDown={event => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const i = tabs.findIndex(item => item.key === tab.key); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length; void switchTab(tabs[next].key); }
          }}><FileText size={14} /><span>{tab.doc.name}</span>{(tab.doc.modified || annotationFingerprint(tab.key === activeTabKey ? annotations : tab.annotations) !== tab.doc.savedAnnotations) && <span className="modified-dot" title="Cambios sin guardar en un PDF" aria-label="Documento modificado" />}</button>
          <button className="document-tab-close" aria-label={`Cerrar ${tab.doc.name}`} title={`Cerrar pestaña (${shortcutLabel('W')})`} disabled={!!busy || loading} onClick={() => void closeTab(tab.key)}><X size={13} /></button>
        </div>)}
      </div>
      <IconButton label="Abrir PDF" disabled={!!busy || loading} onClick={() => void chooseFile()} className="new-document-tab"><Plus size={19} /></IconButton>
      <div className="header-drag-space" data-tauri-drag-region />
      <div className="header-actions">
        <IconButton label="Información del documento" disabled={!doc || loading} onClick={() => setInfo(true)}><Info size={16} /></IconButton>
        <IconButton label="Crear PDF" disabled={!!busy || loading} onClick={() => setCreating(true)}><FilePlus2 size={18} /></IconButton>
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

    <div className="workspace">
      {!phone && <nav className="tool-rail" aria-label="Herramientas del documento">
        <div className="rail-primary">
          <button className={library ? 'rail-button active' : 'rail-button'} aria-label="Mis documentos" title="Mis documentos" onClick={() => setLibrary(true)}><FolderOpen size={21} /><span>Documentos</span></button>
          <button className={`rail-button ${sidebar && !searchOpen && sideTab === 'pages' ? 'active' : ''}`} aria-label="Páginas" title="Páginas" aria-expanded={sidebar && !searchOpen && sideTab === 'pages'} disabled={!doc} onClick={() => toggleSidePanel('pages')}><Layers size={21} /><span>Páginas</span></button>
          <button className={`rail-button annotations-toggle ${notesOpen ? 'active' : ''}`} aria-label="Anotaciones" title="Anotaciones" aria-expanded={notesOpen} disabled={!doc} onClick={() => setNotesOpen(v => !v)}><MessageSquare size={21} /><span>Anotaciones</span>{annotations.length > 0 && <span className="rail-count">{annotations.length}</span>}</button>
          <button className={`rail-button ${searchOpen && sidebar ? 'active' : ''}`} aria-label="Buscar en el PDF" title={`Buscar en el PDF (${shortcutLabel('F')})`} aria-expanded={searchOpen && sidebar} disabled={!doc} onClick={() => setSearchOpen(v => !v)}><Search size={21} /><span>Buscar</span></button>
          <button className={`rail-button ${sidebar && !searchOpen && sideTab === 'bookmarks' ? 'active' : ''}`} aria-label="Marcadores" title="Marcadores" aria-expanded={sidebar && !searchOpen && sideTab === 'bookmarks'} disabled={!doc} onClick={() => toggleSidePanel('bookmarks')}><Bookmark size={21} /><span>Marcadores</span></button>
          <button className={`rail-button ${sidebar && !searchOpen && sideTab === 'outline' ? 'active' : ''}`} aria-label="Índice" title="Índice" aria-expanded={sidebar && !searchOpen && sideTab === 'outline'} disabled={!doc} onClick={() => toggleSidePanel('outline')}><ListTree size={21} /><span>Índice</span></button>
        </div>
        <div className="rail-bottom">
          <IconButton label="Preferencias de lectura" onClick={() => { setSettings(true); setConfirmClear(false); }}><Settings2 size={19} /></IconButton>
          <IconButton label="Ayuda y atajos" onClick={() => setHelp(true)}><CircleHelp size={19} /></IconButton>
        </div>
      </nav>}
      {phone && (sidebar || notesOpen) && <button className="mobile-panel-backdrop" aria-label="Cerrar panel lateral" tabIndex={-1} onClick={closeMobilePanel} />}
      {sidebar && <aside className={`sidebar${phone ? ' mobile-drawer' : ''}`} role={phone ? 'dialog' : undefined} aria-modal={phone ? true : undefined} aria-label={phone ? 'Explorar documento' : undefined} style={phone ? undefined : { width: readingPreferences.panelWidth, minWidth: readingPreferences.panelWidth }}>
        {phone && <><div className="mobile-drawer-heading"><h2>Explorar</h2><IconButton label="Cerrar panel" onClick={closeMobilePanel}><X size={20} /></IconButton></div><div className="mobile-panel-tabs" role="tablist" aria-label="Explorar PDF">{[['pages', 'Páginas', Layers], ['bookmarks', 'Marcadores', Bookmark], ['outline', 'Índice', ListTree], ['search', 'Buscar', Search]].map(([id, label, Icon]) => { const Symbol = Icon as typeof Layers; return <button key={id as string} role="tab" aria-selected={id === 'search' ? searchOpen : !searchOpen && sideTab === id} onClick={() => { if (id === 'search') setSearchOpen(true); else { setSearchOpen(false); setSideTab(id as SideTab); } }}><Symbol size={19} /><span>{label as string}</span></button>; })}</div></>}
        {searchOpen ? <>
          <div className="sidebar-title"><span>Buscar en el documento</span>{!phone && <IconButton label="Cerrar búsqueda" onClick={closeSearch}><X size={16} /></IconButton>}</div>
          <form className="search-field" onSubmit={e => { e.preventDefault(); goToResult(resultIndex + 1); }}><Search size={16} /><input ref={searchInput} placeholder="Palabra o frase…" value={query} onChange={e => { setQuery(e.target.value); setResultIndex(0); }} aria-label="Buscar texto en el PDF" />{query && <button type="button" onClick={() => setQuery('')} aria-label="Borrar búsqueda"><X size={14} /></button>}</form>
          <div className="search-summary"><span>{indexing ? 'Preparando búsqueda…' : query ? `${occurrences} coincidencia${occurrences === 1 ? '' : 's'}` : 'Buscar texto'}</span>{results.length > 0 && <div><IconButton label="Resultado anterior" onClick={() => goToResult(resultIndex - 1)}><ChevronLeft size={15} /></IconButton><IconButton label="Siguiente resultado" onClick={() => goToResult(resultIndex + 1)}><ChevronRight size={15} /></IconButton></div>}</div>
          <div className="sidebar-scroll search-results">{results.map((result, i) => <button key={result.page} className={`search-result ${i === resultIndex ? 'selected' : ''}`} onClick={() => goToResult(i)}><span className="result-heading">Página {result.page}<span>{result.count}</span></span><span>{result.text}</span></button>)}{query && !indexing && !results.length && <div className="empty-panel"><Search size={26} /><p>No encontramos «{query}».</p><span>{textIndex.every(t => !t.trim()) ? 'Este PDF no contiene texto seleccionable. La búsqueda necesita texto; no incluye OCR.' : 'Prueba con otra palabra o una frase más corta.'}</span></div>}{!query && <div className="search-hint"><Keyboard size={24} /><p>Introduce un texto para buscar.</p><span>Busca sin distinguir mayúsculas ni acentos.</span></div>}</div>
        </> : <>
          <div className="sidebar-title"><span>{sideTab === 'pages' ? 'Páginas' : sideTab === 'outline' ? 'Índice' : 'Marcadores'}</span><span className="page-total">{doc?.pdf.numPages || 0}</span></div>

          <div className={`sidebar-scroll ${sideTab === 'pages' ? 'thumbnails' : 'outline-list'}`} role="tabpanel">
            {sideTab === 'pages' && doc && pages.map(number => <Thumbnail key={`${doc.pdf.loadingTask.docId}-${number}`} pdf={doc.pdf} number={number} selected={page === number} onClick={() => mobilePage(number)} />)}
            {sideTab === 'outline' && (outline.length ? outline.map((entry, i) => <button key={i} className={`outline-entry ${page === entry.page ? 'selected' : ''}`} style={{ paddingLeft: 14 + Math.min(entry.depth, 4) * 12 }} onClick={() => mobilePage(entry.page)}><span>{entry.title}</span><span>{entry.page}</span></button>) : <div className="empty-panel"><ListTree size={26} /><p>Sin índice en este PDF.</p><span>Explora sus páginas desde las miniaturas.</span></div>)}
            {sideTab === 'bookmarks' && <BookmarkTree key={activeTabKey} bookmarks={bookmarks} onChange={commitBookmarks} page={page} onGoToPage={mobilePage} disabled={!!busy || loading} startEditingId={bookmarkEditingId} onEditingComplete={() => setBookmarkEditingId(null)} />}
          </div>
        </>}
      </aside>}

      <main className={`reader${phone && mobileAnnotating ? ' mobile-annotating' : ''}`} id="document-reader" inert={phone && (sidebar || notesOpen)}>
        {!phone && <div className="reader-toolbar">
          <div className="toolbar-left"><button className="tools-button" disabled={!doc || !!busy || isNativePdfDocument(doc.pdf)} onClick={() => { setWorkbench('home'); setTool('select'); }} title="Herramientas"><Wrench size={17} /><span>Herramientas</span></button><span className="toolbar-divider" /><div className="tool-group"><IconButton label="Seleccionar texto (V)" active={tool === 'select'} disabled={!doc} onClick={() => setTool('select')}><MousePointer2 size={17} /></IconButton><IconButton label="Resaltado automático (H)" toggle active={tool === 'highlight'} disabled={!doc?.canAnnotate || !doc.canCopy || !!busy || loading} onMouseDown={e => e.preventDefault()} onClick={activateHighlight}><Highlighter size={18} /></IconButton><HighlightColorPicker color={color} onChange={setColor} disabled={!doc?.canAnnotate || !doc?.canCopy || !!busy || loading} /><IconButton label="Añadir nota (N)" active={tool === 'note'} disabled={!doc?.canAnnotate} onClick={() => setTool('note')}><StickyNote size={17} /></IconButton></div><div className="undo-group"><span className="toolbar-divider" /><IconButton label={`Deshacer (${shortcutLabel('Z')})`} onClick={undo} disabled={!!busy || !undoStack.current.length}><Undo2 size={17} /></IconButton><IconButton label={`Rehacer (${shortcutLabel(isMac ? '⇧+Z' : 'Y')})`} onClick={redo} disabled={!!busy || !redoStack.current.length}><Redo2 size={17} /></IconButton></div></div>
          <div className="page-controls"><IconButton label="Página anterior" onClick={() => goToPage(page - 1)} disabled={!doc || page <= 1}><ChevronLeft size={17} /></IconButton><form onSubmit={e => { e.preventDefault(); commitPageInput(); }}><input aria-label="Número de página" type="text" inputMode="numeric" value={pageInput} onChange={e => { pageInputDirty.current = true; setPageInput(e.target.value.replace(/\D/g, '')); }} onBlur={() => { if (pageInputDirty.current) commitPageInput(); }} /><span>/ {doc?.pdf.numPages || '—'}</span></form><IconButton label="Página siguiente" onClick={() => goToPage(page + 1)} disabled={!doc || page >= doc.pdf.numPages}><ChevronRight size={17} /></IconButton></div>
          <div className="toolbar-right"><div className="zoom-controls"><IconButton label="Reducir zoom" onClick={() => changeZoom(-.1)} disabled={!doc || scale <= .25}><Minus size={16} /></IconButton><div className="zoom-select"><select aria-label="Nivel de zoom" value={zoomMode === 'custom' ? String(Math.round(scale * 100)) : zoomMode} onChange={e => { if (['page', 'width'].includes(e.target.value)) setZoomMode(e.target.value); else { setCustomScale(Number(e.target.value) / 100); setZoomMode('custom'); } }} disabled={!doc}><option value="page">Ajustar página</option><option value="width">Ajustar ancho</option>{![50, 75, 100, 125, 150, 200, 300].includes(Math.round(scale * 100)) && zoomMode === 'custom' && <option value={String(Math.round(scale * 100))}>{Math.round(scale * 100)} %</option>}{[50, 75, 100, 125, 150, 200, 300].map(n => <option key={n} value={n}>{n} %</option>)}</select><ChevronDown size={12} /></div><IconButton label="Ampliar zoom" onClick={() => changeZoom(.1)} disabled={!doc || scale >= 3}><Plus size={16} /></IconButton></div><span className="toolbar-divider" /><IconButton label="Rotar vista 90 grados" disabled={!doc} onClick={() => setRotation(v => (v + 90) % 360)}><RotateCw size={17} /></IconButton><IconButton label={hasBookmarkPage(bookmarks, page) ? 'Editar marcador de esta página' : 'Guardar marcador de esta página'} disabled={!doc} onClick={toggleBookmark} active={hasBookmarkPage(bookmarks, page)}><Bookmark size={17} fill={hasBookmarkPage(bookmarks, page) ? 'currentColor' : 'none'} /></IconButton><IconButton label="Pantalla completa" onClick={() => void fullscreen()} className="fullscreen-button"><Maximize size={17} /></IconButton><span className="toolbar-divider" /><IconButton label="Imprimir PDF" disabled={!doc?.canPrint || !!busy} onClick={() => void printDocument()} className="print-button">{busy === 'print' ? <LoaderCircle size={17} className="spin" /> : <Printer size={17} />}</IconButton><button className="download-button" onClick={() => void download()} disabled={!doc || !!busy}><ArrowDownToLine size={16} /><span>{isDesktop ? 'Guardar' : 'Descargar'}</span></button></div>
        </div>}

        <div className="reading-area" ref={viewer} aria-label="Área de lectura del PDF" tabIndex={-1}>
          {doc ? <div className="pdf-stack" key={doc.pdf.loadingTask.docId} style={{ gap: readingPreferences.pageGap }}>{doc.sample && <div className="sample-hint"><Sparkles size={13} /><span>PDF de ejemplo</span></div>}{(readingPreferences.mode === 'single' ? [page] : pages).map(number => <PDFPage key={`${doc.revision}-${number}`} pdf={doc.pdf} number={number} scale={scale} rotation={rotation} dimensions={dimensions} annotations={annotationPages.get(number) || []} tool={tool} color={color} query={query} canCopy={doc.canCopy} canAnnotate={doc.canAnnotate && !busy && !loading} onRemoveAnnotation={removeAnnotation} onAnnotate={onAnnotate} onArea={onArea} redactions={redactions} onNoteClick={id => { setNotesOpen(true); setActiveNote(id); }} />)}</div> : !loading && <div className="welcome"><div className="welcome-icon"><BookOpen size={38} /></div><h2>Abrir PDF</h2><p>{phone ? 'Selecciona un PDF desde Archivos.' : 'Selecciona un archivo o arrástralo a esta ventana.'}</p></div>}
          {loading && <div className="loading-overlay"><LoaderCircle size={28} className="spin" /><span>Abriendo PDF…</span></div>}
        </div>

        {phone && doc && <div className="mobile-reading-status"><div className="page-controls"><form onSubmit={event => { event.preventDefault(); commitPageInput(); }}><input aria-label="Número de página" type="text" inputMode="numeric" disabled={!!busy || loading} value={pageInput} onChange={event => { pageInputDirty.current = true; setPageInput(event.target.value.replace(/\D/g, '')); }} onBlur={() => { if (pageInputDirty.current) commitPageInput(); }} /><span>/ {doc.pdf.numPages}</span></form></div><IconButton label={hasBookmarkPage(bookmarks, page) ? 'Editar marcador de esta página' : 'Guardar marcador de esta página'} disabled={!!busy || loading} onClick={() => { setNotesOpen(false); toggleBookmark(); }} active={hasBookmarkPage(bookmarks, page)}><Bookmark size={21} fill={hasBookmarkPage(bookmarks, page) ? 'currentColor' : 'none'} /></IconButton></div>}
        {phone && doc && mobileAnnotating && <div className="mobile-annotation-toolbar" role="toolbar" aria-label="Herramientas de anotación">
          <IconButton label="Resaltado automático" toggle active={tool === 'highlight'} disabled={!doc.canAnnotate || !doc.canCopy || !!busy || loading} onMouseDown={event => event.preventDefault()} onClick={activateHighlight}><Highlighter size={21} /></IconButton>
          <HighlightColorPicker color={color} onChange={setColor} disabled={!doc.canAnnotate || !doc.canCopy || !!busy || loading} />
          <IconButton label="Añadir nota" toggle active={tool === 'note'} disabled={!doc.canAnnotate || !!busy || loading} onClick={() => setTool(tool === 'note' ? 'select' : 'note')}><StickyNote size={21} /></IconButton>
          <IconButton label="Deshacer" disabled={!!busy || !undoStack.current.length} onClick={undo}><Undo2 size={21} /></IconButton>
          <IconButton label="Rehacer" disabled={!!busy || !redoStack.current.length} onClick={redo}><Redo2 size={21} /></IconButton>
          <IconButton label="Terminar anotación" onClick={() => { setMobileAnnotating(false); setTool('select'); }}><X size={21} /></IconButton>
        </div>}

        {tool !== 'select' && tool !== 'highlight' && doc && <div className="annotation-tool-hint">
          <span>{tool === 'note' ? phone ? 'Toca la página para añadir una nota' : 'Haz clic para añadir una nota' : tool === 'redact' ? 'Marca las áreas que quieres eliminar' : 'Arrastra para seleccionar el área'}</span>

          {tool === 'redact' && redactions.length > 0 && <><button className="secondary-button" onClick={() => setRedactions(previous => previous.slice(0, -1))}>Quitar última área</button><button className="primary-button" onClick={() => setWorkbench('redact')}>Revisar {redactions.length} áreas</button></>}
          {!(phone && mobileAnnotating && tool === 'note') && <IconButton label="Terminar herramienta" onClick={() => { setTool('select'); setRedactions([]); }}><X size={15} /></IconButton>}
        </div>}


      </main>

      {notesOpen && <aside className={`notes-panel${phone ? ' mobile-drawer' : ''}`} role={phone ? 'dialog' : undefined} aria-modal={phone ? true : undefined} aria-label={phone ? 'Anotaciones' : undefined}><div className="notes-heading"><div><MessageSquare size={17} /><h2>Anotaciones</h2><span>{annotations.length}</span></div><IconButton label="Cerrar anotaciones" onClick={() => setNotesOpen(false)}><X size={16} /></IconButton></div><div className="notes-scroll">{annotations.length ? annotations.map(a => <article key={a.id} className={`annotation-card ${activeNote === a.id ? 'selected' : ''}`}><div className="annotation-card-heading"><button onClick={() => { mobilePage(a.page); setActiveNote(a.id); }}>{a.kind === 'note' ? <StickyNote size={14} /> : <Highlighter size={14} />}<span>Página {a.page}</span></button><IconButton label="Eliminar anotación" disabled={!doc?.canAnnotate || !!busy || loading} onClick={() => removeAnnotation(a.id)}><Trash2 size={14} /></IconButton></div>{a.kind === 'note' ? <><p>{a.text}</p><button className="note-edit" disabled={!doc?.canAnnotate || !!busy || loading} onClick={() => { setNoteDraft(a); setNoteText(a.text); }}>Editar nota</button></> : <span className="highlight-description"><span style={{ backgroundColor: a.color }} />{a.text || 'Texto resaltado'}</span>}</article>) : <div className="empty-panel annotations-empty"><div className="note-illustration"><StickyNote size={32} /></div><h3>Sin anotaciones</h3></div>}</div></aside>}
    </div>

    {phone && mobileTabs && <Modal title="Documentos abiertos" onClose={() => setMobileTabs(false)} className="mobile-tabs-modal"><div className="mobile-document-list">{tabs.map(tab => <div key={tab.key} className={tab.key === activeTabKey ? 'selected' : ''}><button aria-label={`Abrir pestaña ${tab.doc.name}`} aria-current={tab.key === activeTabKey ? 'page' : undefined} onClick={() => { setMobileTabs(false); requestAnimationFrame(() => { closeMobilePanel(); void switchTab(tab.key); }); }} disabled={!!busy || loading}><FileText size={20} /><span>{tab.doc.name}</span>{tab.key === activeTabKey && <Check size={18} />}</button><IconButton label={`Cerrar ${tab.doc.name}`} onClick={() => { setMobileTabs(false); requestAnimationFrame(() => void closeTab(tab.key)); }} disabled={!!busy || loading}><X size={19} /></IconButton></div>)}</div></Modal>}
    {phone && mobileActions && <Modal title="Acciones del documento" onClose={() => setMobileActions(false)} className="mobile-actions-modal">
      {storageFailed && <p className="mobile-storage-error" role="alert">No se pudo guardar la sesión. Guarda una copia del PDF.</p>}
      <div className="mobile-file-actions"><button className="primary-button" aria-label="Guardar PDF" onClick={() => mobileAction(() => void download())} disabled={!doc || !!busy || loading}><ArrowDownToLine size={20} /><span>Guardar PDF</span></button>{isIOS && <button className="secondary-button" aria-label="Compartir PDF" onClick={() => mobileAction(() => void shareDocument())} disabled={!doc || !!busy || loading}><Upload size={20} /><span>Compartir</span></button>}</div>
      <div className="mobile-reading-controls"><div><IconButton label="Página anterior" onClick={() => mobileAction(() => goToPage(page - 1))} disabled={!doc || page <= 1}><ChevronLeft size={20} /></IconButton><span>Página {page} de {doc?.pdf.numPages || '—'}</span><IconButton label="Página siguiente" onClick={() => mobileAction(() => goToPage(page + 1))} disabled={!doc || page >= doc.pdf.numPages}><ChevronRight size={20} /></IconButton></div><div><IconButton label="Reducir zoom" onClick={() => changeZoom(-.1)} disabled={!doc || scale <= .25}><Minus size={20} /></IconButton><select aria-label="Nivel de zoom" value={zoomMode === 'custom' ? String(Math.round(scale * 100)) : zoomMode} disabled={!doc} onChange={event => { if (['page', 'width'].includes(event.target.value)) setZoomMode(event.target.value); else { setCustomScale(Number(event.target.value) / 100); setZoomMode('custom'); } }}><option value="page">Ajustar página</option><option value="width">Ajustar ancho</option>{![50, 75, 100, 125, 150, 200, 300].includes(Math.round(scale * 100)) && zoomMode === 'custom' && <option value={String(Math.round(scale * 100))}>{Math.round(scale * 100)} %</option>}{[50, 75, 100, 125, 150, 200, 300].map(number => <option key={number} value={number}>{number} %</option>)}</select><IconButton label="Ampliar zoom" onClick={() => changeZoom(.1)} disabled={!doc || scale >= 3}><Plus size={20} /></IconButton></div></div>
      <div className="mobile-action-grid">
        <button onClick={() => mobileAction(() => { closeMobilePanel(); setNotesOpen(true); })} disabled={!doc}><MessageSquare size={21} /><span>Anotaciones{annotations.length ? ` (${annotations.length})` : ''}</span></button>
        {!mobileAnnotating && <button onClick={() => mobileAction(() => { setMobileAnnotating(true); setTool('select'); })} disabled={!doc?.canAnnotate || !!busy || loading}><Highlighter size={21} /><span>Anotar documento</span></button>}
        <button onClick={() => mobileAction(() => { setMobileAnnotating(false); setWorkbench('home'); setTool('select'); })} disabled={!doc || !!busy || isNativePdfDocument(doc.pdf)}><Wrench size={21} /><span>Herramientas</span></button>
        <button onClick={() => mobileAction(() => { setSettings(true); setConfirmClear(false); })}><Settings2 size={21} /><span>Preferencias de lectura</span></button>
        {!mobileAnnotating && <><button onClick={() => mobileAction(undo)} disabled={!!busy || !undoStack.current.length}><Undo2 size={21} /><span>Deshacer</span></button><button onClick={() => mobileAction(redo)} disabled={!!busy || !redoStack.current.length}><Redo2 size={21} /><span>Rehacer</span></button></>}
        <button onClick={() => mobileAction(() => setRotation(value => (value + 90) % 360))} disabled={!doc}><RotateCw size={21} /><span>Rotar vista</span></button>
        <button onClick={() => mobileAction(() => void printDocument())} disabled={!doc?.canPrint || !!busy}><Printer size={21} /><span>Imprimir PDF</span></button>
        <button onClick={() => mobileAction(() => setLibrary(true))}><FolderOpen size={21} /><span>Mis documentos</span></button>
        <button onClick={() => mobileAction(() => setInfo(true))} disabled={!doc}><Info size={21} /><span>Información del documento</span></button>
        <button onClick={() => mobileAction(() => setCreating(true))} disabled={!!busy || loading}><FilePlus2 size={21} /><span>Crear PDF</span></button>
        <button onClick={() => mobileAction(() => setHelp(true))}><CircleHelp size={21} /><span>Ayuda</span></button>
      </div>
    </Modal>}
    <TextSelectionMenu key={doc?.pdf.loadingTask.docId} enabled={!!doc?.canCopy && tool === 'select' && !loading && !busy && !noteDraft && !workbench && !creating && !library && !settings && !help && !info && !password && !closeBlocked && !(phone && (sidebar || notesOpen || mobileActions || mobileTabs))} canAnnotate={!!doc?.canAnnotate} color={color} onHighlight={() => { highlightSelection(); }} onComment={() => { commentSelection(); }} onNotify={notify} />
    {dragOver && <div className="drop-overlay"><div><Upload size={38} /><h2>Soltar para abrir</h2><p>Archivo PDF</p></div></div>}
    {creating && <CreatePDF onClose={() => setCreating(false)} onCreate={async (bytes, name) => { await openDocument(bytes, name, false, undefined, { modified: true, useSession: false }); setCreating(false); }} />}
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <Info size={18} /> : <Check size={18} />}<span>{toast.message}</span><button aria-label="Cerrar aviso" onClick={() => setToast(null)}><X size={15} /></button></div>}

    {library && <Modal title="Mis documentos" onClose={() => setLibrary(false)} className="library-modal"><div className="library-section-title">RECIENTES <span>{recents.length}</span></div>{recents.length ? <div className="recent-list">{recents.map(recent => <div className="recent-row" key={recent.id}><button onClick={() => void reopenRecent(recent)}><div className="recent-icon"><FileText size={22} /></div><div><strong>{recent.name}</strong><span>{recent.pages} páginas · {formatSize(recent.size)} · {new Date(recent.openedAt).toLocaleDateString('es', { day: 'numeric', month: 'short' })}</span></div><ChevronRight size={16} /></button><IconButton label={`Olvidar ${recent.name} y sus anotaciones guardadas`} onClick={() => void forgetRecent(recent)}><Trash2 size={15} /></IconButton></div>)}</div> : <div className="library-empty"><BookOpen size={25} /><p>Sin documentos recientes.</p></div>}<button className="demo-document" onClick={() => void openDocument('sample')}><div><Sparkles size={19} /><div><strong>PDF de ejemplo</strong><span>6 páginas</span></div></div><ArrowRight size={17} /></button></Modal>}
    {workbench && doc && !isNativePdfDocument(doc.pdf) && <Workbench key={`${doc.revision}-${workbench}`} doc={doc} page={page} section={workbench} area={editArea} redactions={redactions} onClose={() => { setWorkbench(null); setEditArea(null); if (tool !== 'redact') setTool('select'); }} onSelectTool={next => { setWorkbench(null); setTool(next); }} onApply={applyOperation} getBytes={currentBytes} onReplace={replaceDocument} />}
    {noteDraft && <Modal title={noteDraft.id ? 'Editar nota' : 'Añadir nota'} onClose={() => setNoteDraft(null)} className="note-modal"><div className="note-page-label"><StickyNote size={16} />Página {noteDraft.page}</div><textarea autoFocus aria-label="Texto de la nota" placeholder="Escribe un comentario" value={noteText} maxLength={5000} onChange={e => setNoteText(e.target.value)} /><div className="note-modal-footer"><span>{noteText.length} / 5000</span><button className="secondary-button" onClick={() => setNoteDraft(null)}>Cancelar</button><button className="primary-button" disabled={!noteText.trim()} onClick={saveNote}><Check size={16} />Guardar nota</button></div></Modal>}
    {password && <Modal title="Este PDF tiene contraseña" onClose={cancelPassword} className="password-modal"><p className="modal-description">Introduce la contraseña para abrirlo.</p><form onSubmit={e => { e.preventDefault(); if (passwordText) { password.submit(passwordText); setPassword(null); } }}><label htmlFor="pdf-password">Contraseña del documento</label><input autoFocus id="pdf-password" type="password" value={passwordText} onChange={e => setPasswordText(e.target.value)} autoComplete="off" />{password.retry && <p className="password-error">La contraseña anterior no es correcta. Inténtalo de nuevo.</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={cancelPassword}>Cancelar</button><button className="primary-button" disabled={!passwordText}><LockKeyhole size={15} />Abrir PDF</button></div></form></Modal>}
    {info && doc && <Modal title="Sobre este documento" onClose={() => setInfo(false)} className="info-modal"><div className="info-file"><FileText size={30} /><strong>{doc.name}</strong></div><dl className="document-details"><div><dt>Páginas</dt><dd>{doc.pdf.numPages}</dd></div><div><dt>Tamaño</dt><dd>{formatSize(doc.size)}</dd></div><div><dt>Anotaciones de Folio</dt><dd>{annotations.length}</dd></div><div><dt>Marcadores</dt><dd>{bookmarks.length}</dd></div><div><dt>Procesamiento</dt><dd>Local, en tu dispositivo</dd></div></dl></Modal>}
    {settings && <ReadingSettings phone={phone} theme={theme} onTheme={setTheme} zoom={defaultZoom} onZoom={setDefaultZoom} preferences={readingPreferences} onPreferences={setReadingPreferences} rememberRecent={rememberRecent} onRemember={setRememberRecent} confirmClear={confirmClear} onClear={() => void clearLibrary()} onCancelClear={() => setConfirmClear(false)} onClose={() => setSettings(false)} />}
    {help && <Modal title={phone ? "Ayuda" : "Ayuda y atajos"} onClose={() => setHelp(false)} className="help-modal"><div className="help-feature"><Highlighter size={21} /><div><strong>Anotaciones</strong><p>{phone ? "Mantén pulsada una palabra y mueve los controles de selección. Aparece un menú para copiar, resaltar o comentar. En Más acciones, Anotar documento abre las herramientas inferiores. El resaltador activa el modo automático; el botón de color elige su color. Toca un resaltado para eliminarlo. Amplía o reduce el documento con dos dedos." : "Activa el resaltado automático y selecciona palabras o líneas; pulsa H otra vez para desactivarlo. Elige el color junto al resaltador. Al seleccionar texto con V, aparece el menú para copiar, resaltar o comentar. Para añadir una nota, activa la herramienta de notas y haz clic en la página."}</p></div></div><div className="help-feature"><ShieldCheck size={21} /><div><strong>Guardar comentarios</strong><p>Usa {isNative || phone ? 'Guardar PDF' : 'Descargar'} para incluir los comentarios y cambios en el archivo.</p></div></div>{!phone && <><h3 className="shortcuts-heading">Atajos de teclado</h3><div className="shortcut-grid">{[['Abrir PDF', shortcutLabel('O')], ['Cambiar de pestaña', 'Ctrl+Tab'], ['Cerrar pestaña', shortcutLabel('W')], ['Buscar', shortcutLabel('F')], [isDesktop ? 'Guardar' : 'Descargar', shortcutLabel('S')], ['Deshacer', shortcutLabel('Z')], ['Rehacer', shortcutLabel('⇧+Z')], ['Cambiar de página', '← / →'], ['Seleccionar texto', 'V'], ['Resaltado automático', 'H'], ['Añadir nota', 'N'], ['Zoom', isMac ? '⌘ / Ctrl + rueda' : 'Ctrl + rueda'], ['Salir de una herramienta', 'Esc']].map(([label, keys]) => <div key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}</div></>}<p className="help-limit">{phone ? "Toca el nombre del documento para cambiar de PDF. En Explorar, organiza los marcadores desde su menú o arrastra su asa. En Más acciones encontrarás Guardar PDF, anotaciones, herramientas y preferencias de lectura." : <>Usa Herramientas para editar, organizar páginas, rellenar formularios, reconocer texto, comparar documentos o trabajar con firmas. Guarda una copia con {shortcutLabel('S')}.</>}</p></Modal>}
  </div>;
}
