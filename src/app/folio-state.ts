import { useRef, useState } from 'react';
import type { DocumentTab, TabView } from './model';
import type { PasswordRequest } from '../components/DocumentDialogs';
import { useInkPreferences } from './ink-preferences';
import { useNotices } from './notices';
import { useReaderZoom, useViewportSize } from './reader-zoom';
import { useTabView } from './tab-view';
import { useMarks } from './marks';
import { useDialogs, useDriveState, useNoteEditor } from './dialogs';
import { useAppPreferences } from './app-preferences';
import { useDocumentSearch } from './search';
import { useDeviceLayout } from '../mobile';
import type { LoadedDocument } from '../types';
import { useControllers } from './controllers';
import { useLatest } from './latest';
import { useDrawerExit } from './panels';
import { activityLabel } from './document-status';

/** Folio's state: the document in front and its view, the open dialogs, the preferences, and the controllers that act on documents. */
export function useFolioState() {
  const layout = useDeviceLayout(),
    phone = layout === 'phone',
    tablet = layout === 'tablet',
    touchLayout = phone || tablet;
  const {
    mobileActions,
    setMobileActions,
    mobileTabs,
    setMobileTabs,
    creating,
    setCreating,
    pageJump,
    setPageJump,
    viewSettings,
    setViewSettings,
    annotationOptions,
    setAnnotationOptions,
    capabilityNotice,
    setCapabilityNotice,
    deleteTarget,
    setDeleteTarget,
    help,
    setHelp,
    settings,
    setSettings,
    confirmClear,
    setConfirmClear,
    info,
    setInfo,
    palette,
    setPalette,
    whatsNew,
    setWhatsNew,
    shortcutsOpen,
    setShortcutsOpen,
    closeBlocked,
    setCloseBlocked,
  } = useDialogs();
  const {
    driveAvailable,
    driveLibrary,
    setDriveLibrary,
    driveMessage,
    setDriveMessage,
    driveConflicts,
    setDriveConflicts,
    driveRefresh,
    setDriveRefresh,
  } = useDriveState();
  // Editar inside the reader (desktop): the pages stay, with an edit layer and toolbar.
  const [editing, setEditing] = useState(false);
  const editingRef = useLatest(editing);
  const { editStore, tabStore, opener, history, changes, toolSections, liveEdit, persistence, output, libraryStore } =
    useControllers();
  const [readerChromeHidden, setReaderChromeHidden] = useState(false);
  const [doc, setDoc] = useState<LoadedDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'download' | 'print' | 'edit' | 'close' | null>(null);
  const [workbench, setWorkbench] = useState<string | null>(null);
  const workbenchRef = useLatest(workbench);
  const [editorDraft, setEditorDraft] = useState(false);
  const editorDraftRef = useLatest(editorDraft);
  const {
    page,
    setPage,
    dimensions,
    rotation,
    setRotation,
    readingMode,
    setReadingMode,
    annotating: mobileAnnotating,
    setAnnotating: setMobileAnnotating,
    tool,
    setTool,
    color,
    setColor,
    sidebar,
    setSidebar,
    sideTab,
    setSideTab,
    notesOpen,
    setNotesOpen,
    outline,
    setOutline,
    activeNote,
    setActiveNote,
    redactions,
    setRedactions,
    editArea,
    setEditArea,
    sessionFailed,
    setSessionFailed,
    draftFailed,
    setDraftFailed,
    apply: applyTabView,
  } = useTabView();
  const {
    inkKind,
    setInkKind,
    setInkStyles,
    inkStyle,
    inkRecentColors,
    setInkRecentColors,
    eraserSize,
    setEraserSize,
    penOnly,
    choosePenOnly,
    penDetected,
  } = useInkPreferences();
  const {
    annotations,
    annotationRef,
    showAnnotations,
    commitAnnotations,
    bookmarks,
    bookmarkRef,
    showBookmarks,
    commitBookmarks,
  } = useMarks(
    (step, gesture) => history.record(step, gesture),
    () => {
      if (docRef.current) unreadSessions.current.delete(docRef.current.id);
    },
  );
  const [bookmarkEditingId, setBookmarkEditingId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [library, setLibrary] = useState(true);
  const libraryRef = useLatest(library);
  const {
    rememberRecent,
    setRememberRecent,
    defaultZoom,
    setDefaultZoom,
    readingPreferences,
    setReadingPreferences,
    readingPreferencesRef,
    preferencesRef,
  } = useAppPreferences();
  const {
    noteDraft,
    setNoteDraft,
    noteText,
    setNoteText,
    noteOrigin,
    noteAnchor,
    editNote: openNote,
  } = useNoteEditor();
  const [password, setPassword] = useState<PasswordRequest | null>(null);
  const passwordRef = useLatest(password);
  const [dragOver, setDragOver] = useState(false);
  const { sidebarLeaving, notesLeaving, drawerSwap, setDrawerSwap, sidebarShown, notesShown } = useDrawerExit(
    touchLayout,
    sidebar,
    notesOpen,
  );
  const storageFailed = sessionFailed || draftFailed;
  const [, setHistoryTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const picking = useRef(false);
  const viewer = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const loadingRef = useLatest(loading);
  const docRef = useRef<LoadedDocument | null>(null);
  const readingState = useRef({ page });
  readingState.current = { page };
  const busyRef = useLatest(busy);
  const dragCounter = useRef(0);
  // Web documents whose edited PDF was downloaded as it is now: their tab no longer reads as unsaved.
  const downloadedDrafts = useRef(new WeakSet<LoadedDocument>());
  // Documents whose stored session could not be read: nothing rewrites it until the user changes something.
  const unreadSessions = useRef(new Set<string>());
  const phoneRef = useLatest(phone);
  const touchRef = useLatest(touchLayout);
  const chromeHiddenRef = useLatest(readerChromeHidden);
  const viewportSize = useViewportSize(viewer, doc, () => chromeHiddenRef.current);
  const fittedWidth = useLatest(viewportSize.width);
  const activityText = activityLabel(busy, !!doc?.drive, driveMessage);
  const { toast, notify, dismiss: dismissToast, activity, activityDone } = useNotices(activityText);
  const search = useDocumentSearch(doc, searchOpen, notify);
  const {
    textIndex,
    setTextIndex,
    indexing,
    setIndexing,
    query,
    setQuery,
    searchQuery,
    setSearchQuery,
    resultIndex,
    setResultIndex,
    resultLimit,
    setResultLimit,
    results,
    occurrences,
    history: searchHistory,
    setHistory: setSearchHistory,
  } = search;
  // Two pages side by side share the width.
  const spread = readingMode === 'spread' && !phone;
  const {
    zoomMode,
    setZoomMode,
    customScale,
    setCustomScale,
    scale,
    currentScale,
    readingAnchor,
    changeZoom,
    toggleTapZoom,
  } = useReaderZoom({
    viewer,
    documentId: doc?.id,
    currentId: () => docRef.current?.id,
    dimensions,
    rotation,
    viewportSize,
    phone,
    touchLayout,
    spread,
    pageGap: readingPreferences.pageGap,
    wheelSpeed: () => readingPreferencesRef.current.wheelSpeed,
    pinchable: !library,
    canPinch: () => !busyRef.current && !loadingRef.current,
    currentPage: () => readingState.current.page,
  });
  const activeView = useRef<TabView>(null!);
  activeView.current = {
    page,
    dimensions,
    zoomMode,
    customScale,
    rotation,
    readingMode,
    annotating: mobileAnnotating,
    tool,
    color,
    sidebar,
    sideTab,
    notesOpen,
    outline,
    textIndex,
    indexing,
    searchOpen,
    query,
    resultIndex,
    activeNote,
    redactions,
    editArea,
    sessionFailed,
    draftFailed,
  };
  return {
    activeNote,
    activeTabKey,
    activeView,
    activity,
    activityDone,
    annotationOptions,
    annotationRef,
    annotations,
    applyTabView,
    bookmarkEditingId,
    bookmarkRef,
    bookmarks,
    busy,
    busyRef,
    capabilityNotice,
    changeZoom,
    changes,
    choosePenOnly,
    chromeHiddenRef,
    closeBlocked,
    color,
    commitAnnotations,
    commitBookmarks,
    confirmClear,
    creating,
    currentScale,
    customScale,
    defaultZoom,
    deleteTarget,
    dimensions,
    dismissToast,
    doc,
    docRef,
    downloadedDrafts,
    draftFailed,
    dragCounter,
    dragOver,
    drawerSwap,
    driveAvailable,
    driveConflicts,
    driveLibrary,
    driveMessage,
    driveRefresh,
    editArea,
    editStore,
    editing,
    editingRef,
    editorDraft,
    editorDraftRef,
    eraserSize,
    fileInput,
    fittedWidth,
    help,
    history,
    indexing,
    info,
    inkKind,
    inkRecentColors,
    inkStyle,
    layout,
    library,
    libraryRef,
    libraryStore,
    liveEdit,
    loading,
    loadingRef,
    mobileActions,
    mobileAnnotating,
    mobileTabs,
    noteAnchor,
    noteDraft,
    noteOrigin,
    noteText,
    notesLeaving,
    notesOpen,
    notesShown,
    notify,
    occurrences,
    openNote,
    opener,
    outline,
    output,
    page,
    pageJump,
    palette,
    password,
    passwordRef,
    penDetected,
    penOnly,
    persistence,
    phone,
    phoneRef,
    picking,
    preferencesRef,
    query,
    readerChromeHidden,
    readingAnchor,
    readingMode,
    readingPreferences,
    readingPreferencesRef,
    readingState,
    redactions,
    rememberRecent,
    resultIndex,
    resultLimit,
    results,
    rotation,
    scale,
    search,
    searchHistory,
    searchInput,
    searchOpen,
    searchQuery,
    sessionFailed,
    setActiveNote,
    setActiveTabKey,
    setAnnotationOptions,
    setBookmarkEditingId,
    setBusy,
    setCapabilityNotice,
    setCloseBlocked,
    setColor,
    setConfirmClear,
    setCreating,
    setCustomScale,
    setDefaultZoom,
    setDeleteTarget,
    setDoc,
    setDraftFailed,
    setDragOver,
    setDrawerSwap,
    setDriveConflicts,
    setDriveLibrary,
    setDriveMessage,
    setDriveRefresh,
    setEditArea,
    setEditing,
    setEditorDraft,
    setEraserSize,
    setHelp,
    setHistoryTick,
    setIndexing,
    setInfo,
    setInkKind,
    setInkRecentColors,
    setInkStyles,
    setLibrary,
    setLoading,
    setMobileActions,
    setMobileAnnotating,
    setMobileTabs,
    setNoteDraft,
    setNoteText,
    setNotesOpen,
    setOutline,
    setPage,
    setPageJump,
    setPalette,
    setPassword,
    setQuery,
    setReaderChromeHidden,
    setReadingMode,
    setReadingPreferences,
    setRedactions,
    setRememberRecent,
    setResultIndex,
    setResultLimit,
    setRotation,
    setSearchHistory,
    setSearchOpen,
    setSearchQuery,
    setSessionFailed,
    setSettings,
    setShortcutsOpen,
    setSideTab,
    setSidebar,
    setTabs,
    setTextIndex,
    setTool,
    setViewSettings,
    setWhatsNew,
    setWorkbench,
    setZoomMode,
    settings,
    shortcutsOpen,
    showAnnotations,
    showBookmarks,
    sideTab,
    sidebar,
    sidebarLeaving,
    sidebarShown,
    spread,
    storageFailed,
    tabStore,
    tablet,
    tabs,
    textIndex,
    toast,
    toggleTapZoom,
    tool,
    toolSections,
    touchLayout,
    touchRef,
    unreadSessions,
    viewSettings,
    viewer,
    viewportSize,
    whatsNew,
    workbench,
    workbenchRef,
    zoomMode,
  };
}
