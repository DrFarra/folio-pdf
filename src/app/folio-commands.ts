import { useCallback } from 'react';
import { errorMessage } from '../errors';
import { isNativePdfDocument } from '../nativePdf';
import { type History } from './model';
import type { Area, Operation, PageEntry } from '../engine/operations.ts';
import { commentFor, patched, toggledBookmark, withAdded, withNote, without } from './marks';
import { highlightSelection } from '../text-selection';
import type { AnnotationDraft } from '../text-selection';
import { isDesktop, isNative, pickNativeDocuments, haptic, renameNativeDocument, type Anchor } from '../platform';
import type { Annotation, LoadedDocument, RecentDocument, Tool } from '../types';
import { documentStatus, isUnsaved, pageCounter as pageCounterOf, pageName as pageNameOf } from './document-status';
import { centeredArea } from './tool-sections';
import type { useFolioState } from './folio-state';
import type { useFolioReader } from './folio-reader';
import type { useFolioDocuments } from './folio-documents';

type Layer3 = ReturnType<typeof useFolioState> &
  ReturnType<typeof useFolioReader> &
  ReturnType<typeof useFolioDocuments>;

/** What the user can do: the actions on annotations and bookmarks, files and tools, the library
 * and the document's output, and what the interface says about the document. */
export function useFolioCommands(f: Layer3) {
  const {
    readingPreferencesRef,
    setDoc,
    annotationRef,
    annotations,
    bookmarkRef,
    bookmarks,
    busy,
    busyRef,
    captureTab,
    changes,
    closeMobilePanel,
    closeSearch,
    closeTab,
    commitAnnotations,
    commitBookmarks,
    confirmClear,
    currentPageLabel,
    doc,
    docRef,
    downloadedDrafts,
    driveMessage,
    editorDraftRef,
    fileInput,
    history,
    libraryStore,
    loadingRef,
    mobileAnnotating,
    navigate,
    noteDraft,
    noteOrigin,
    noteText,
    notify,
    openDocument,
    openNote,
    output,
    page,
    pageLabels,
    phone,
    phoneRef,
    picking,
    resultIndex,
    resultLimit,
    returnToPlace,
    searchOpen,
    setActiveNote,
    setBookmarkEditingId,
    setCapabilityNotice,
    setConfirmClear,
    setDeleteTarget,
    setDriveLibrary,
    setEditArea,
    setEditing,
    setLibrary,
    setMobileAnnotating,
    setNoteDraft,
    setNotesOpen,
    setReaderChromeHidden,
    setRedactions,
    setSearchOpen,
    setSideTab,
    setSidebar,
    setTool,
    setWorkbench,
    showPage,
    sideTab,
    storageFailed,
    tabStore,
    tool,
    toolSections,
    touchLayout,
    touchRef,
    viewer,
    workbench,
  } = f;
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
    else {
      setSidebar(true);
      setSearchOpen(false);
      setSideTab('bookmarks');
      setBookmarkEditingId(next.added);
    }
  }, [page, commitBookmarks, notify]);
  function activateHighlight() {
    if (!docRef.current?.canAnnotate || !docRef.current.canCopy || busyRef.current || loadingRef.current) return;
    if (highlightSelection()) setTool('select');
    else setTool(previous => (previous === 'highlight' ? 'select' : 'highlight'));
  }
  async function openFiles(files: File[]) {
    if (editorDraftRef.current) {
      notify('Aplica o descarta la edición antes de abrir otro documento.');
      return;
    }
    if (busyRef.current) return;
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        notify('Solo se pueden abrir archivos PDF.', 'error');
        continue;
      }
      await openDocument(file, file.name);
    }
  }
  async function chooseFile() {
    if (editorDraftRef.current) {
      notify('Aplica o descarta la edición antes de abrir otro documento.');
      return;
    }
    if (busyRef.current || loadingRef.current || picking.current) return;
    if (!isNative) {
      fileInput.current?.click();
      return;
    }
    // The system picker is modal; «Abriendo PDF…» waits until a file loads.
    picking.current = true;
    try {
      const files = await pickNativeDocuments();
      for (const file of files) await openDocument(file, file.name, false, file.token);
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      picking.current = false;
    }
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
    if (annotation.kind === 'note') {
      openNote(annotation, 'document', '');
      return;
    }
    commitAnnotations(withAdded(annotationRef.current, [annotation]));
    if (annotation.kind === 'highlight') haptic('light');
  }
  const removeAnnotation = useCallback(
    (id: string, gesture?: string) => {
      if (
        !docRef.current?.canAnnotate ||
        busyRef.current ||
        loadingRef.current ||
        !annotationRef.current.some(annotation => annotation.id === id)
      )
        return;
      commitAnnotations(without(annotationRef.current, id), gesture);
      setActiveNote(current => (current === id ? null : current));
    },
    [commitAnnotations],
  );
  const snapshot = () => changes.snapshot();
  const applyOperation = (
    operation: Operation,
    signal?: AbortSignal,
    context?: { keepEditing?: boolean; page?: number; quiet?: boolean },
  ) => changes.apply(operation, signal, context);
  const annotatedBytes = (current: LoadedDocument, items?: Annotation[], incremental?: boolean) =>
    output.annotated(current, items, incremental);
  const download = (options?: { keepEditing?: boolean; copy?: boolean }) => output.save(options);
  const printDocument = (anchor?: Anchor) => output.print(anchor);
  const shareDocument = (anchor?: Anchor) => output.share(anchor);
  const replaceDocument = (bytes: Uint8Array, context?: { extraction?: { name: string; plan: PageEntry[] } }) =>
    changes.replace(bytes, context);
  function onArea(area: Area) {
    if (!doc?.canEdit || busy) return;
    if (tool === 'redact') {
      setRedactions(previous => [...previous, area]);
      return;
    }
    setEditArea(area);
    setWorkbench(tool);
  }
  // Usar un área centrada; Cambiar área draws another.
  async function centerArea() {
    const current = docRef.current;
    if (!current) return;
    onArea(centeredArea((await current.pdf.getPage(page)).getViewport({ scale: 1 }), tool, page));
  }
  function saveNote() {
    if (!doc?.canAnnotate || !noteDraft || !noteText.trim()) return;
    const { list, note } = withNote(annotationRef.current, noteDraft, noteText);
    commitAnnotations(list);
    setNoteDraft(null);
    setActiveNote(note.id);
    if (noteOrigin.current === 'list') setNotesOpen(true);
    if (!mobileAnnotating) setTool('select');
  }
  // Mobile keeps private copies of opened PDFs; those of forgotten entries are deleted.
  const retireLibraryEntry = (id: string) => libraryStore.retire(id);
  /** Renames a tab's PDF: on desktop its file too, in the same folder. Rejects with the reason it could not. */
  async function renameDocument(key: string, name: string) {
    const tab = tabStore.list.find(item => item.key === key);
    if (!tab) return;
    const doc = tab.doc,
      typed = name.trim().replace(/\.pdf$/i, '');
    if (!typed) throw new Error('Escribe un nombre.');
    const next =
      isDesktop && isNative && doc.nativeSource ? await renameNativeDocument(doc.nativeSource, typed) : `${typed}.pdf`;
    if (next === doc.name) return;
    const renamed = { ...doc, name: next };
    tabStore.list = tabStore.list.map(item => (item.key === key ? { ...item, doc: renamed } : item));
    if (docRef.current === doc) {
      docRef.current = renamed;
      setDoc(renamed);
    }
    tabStore.publish();
    void libraryStore.list();
  }
  /** Closes the given tabs one after another, stopping at one that stays open (a draft being applied). */
  async function closeTabs(keys: string[]) {
    for (const key of keys) {
      await closeTab(key);
      if (tabStore.list.some(item => item.key === key)) return;
    }
  }
  // iPad anchors Share and Print to the control that opened them.
  const anchorOf = (element: Element | null): Anchor | undefined => {
    const box = element?.getBoundingClientRect();
    return box && { left: box.left, top: box.top, width: box.width, height: box.height };
  };
  function showDrive() {
    setDriveLibrary(true);
    setLibrary(true);
  }
  function closeActiveTab() {
    if (tabStore.activeKey) void closeTab(tabStore.activeKey);
  }
  function returnToLocation() {
    returnToPlace(() => {
      if (searchOpen) closeSearch();
    });
  }
  const mobilePage = showPage;
  const navigatePDF = navigate;
  function startAnnotating() {
    if (!doc?.canAnnotate) {
      setCapabilityNotice(true);
      return;
    }
    setEditing(false);
    if (touchRef.current) closeMobilePanel();
    // Unless chosen in Ajustes, Anotar leaves the annotations panel as it was.
    else if (readingPreferencesRef.current.openNotesOnAnnotate && window.innerWidth >= 1000) setNotesOpen(true);
    setReaderChromeHidden(false);
    setMobileAnnotating(true);
    setTool('select');
  }
  const editNote = (annotation: Annotation, origin: 'document' | 'list') =>
    openNote(annotation, origin, annotation.text);
  const updateAnnotation = useCallback(
    (id: string, patch: Partial<Pick<Annotation, 'color' | 'text' | 'rect'>>) => {
      if (!docRef.current?.canAnnotate || busyRef.current || loadingRef.current) return;
      commitAnnotations(patched(annotationRef.current, id, patch));
    },
    [commitAnnotations],
  );
  // The comment's 20 pt PDF icon stays on the page.
  async function commentHighlight(annotation: Annotation) {
    openNote(
      commentFor(annotation, (await docRef.current?.pdf.getPage(annotation.page).catch(() => null))?.view),
      'document',
      '',
    );
  }
  function openTools() {
    if (!doc || isNativePdfDocument(doc.pdf)) {
      setCapabilityNotice(true);
      return;
    }
    setMobileAnnotating(false);
    setTool('select');
    setWorkbench('home');
  }
  function openEditor() {
    if (!doc || isNativePdfDocument(doc.pdf) || busyRef.current) return;
    if (!touchLayout) {
      setMobileAnnotating(false);
      setTool('select');
      setWorkbench(null);
      // Editar's inspector takes the right side.
      setNotesOpen(false);
      setReaderChromeHidden(false);
      setEditing(true);
      return;
    }
    toolSections.remember({
      revision: String(doc.revision),
      page,
      top: viewer.current?.scrollTop || 0,
      left: viewer.current?.scrollLeft || 0,
    });
    setSidebar(false);
    setSearchOpen(false);
    setNotesOpen(false);
    setMobileAnnotating(false);
    setReaderChromeHidden(false);
    setTool('select');
    setWorkbench('edit-pdf');
  }
  const closeWorkbench = () => toolSections.close();
  const selectWorkbenchTool = (next: Tool) => toolSections.selectTool(next);
  const openWorkbenchSection = (next: string) => toolSections.openSection(next);
  async function returnToLibrary() {
    if (editorDraftRef.current) {
      notify('Aplica o descarta la edición antes de salir del editor.');
      return;
    }
    if (busyRef.current || loadingRef.current) return;
    const current = captureTab();
    tabStore.retain();
    tabStore.publish();
    closeMobilePanel();
    setReaderChromeHidden(false);
    setMobileAnnotating(false);
    setTool('select');
    setLibrary(true);
    if (current) tabStore.storeInBackground(current);
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      notify('No se pudo activar la pantalla completa.', 'error');
    }
  }
  async function clearLibrary() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    if (await libraryStore.clear()) setConfirmClear(false);
  }
  async function forgetRecent(recent: RecentDocument) {
    if (await libraryStore.forget(recent)) setDeleteTarget(null);
  }
  // The phone shows the library when the document in front was removed from it.
  function discardOpenTabs(ids: Set<string>) {
    if (tabStore.discard(ids) && tabStore.list.length && phoneRef.current) setLibrary(true);
  }
  const inlineEditing = !phone && workbench === 'edit-pdf';
  const { saveLabel, savesOriginal, sessionStatus, docDirty, driveDirty, driveStatus, capabilitySummary } =
    documentStatus({
      doc,
      annotations,
      storageFailed,
      driveMessage,
      downloaded: !!doc && downloadedDrafts.current.has(doc),
      saving: busy === 'download',
    });
  const unsaved = (document: LoadedDocument, items: Annotation[]) =>
    isUnsaved(document, items, downloadedDrafts.current.has(document));
  const pageName = (number: number) => pageNameOf(pageLabels, number);
  const pageCounter = doc ? pageCounterOf(page, doc.pdf.numPages, currentPageLabel) : undefined;
  const listedResults = Math.max(resultLimit, resultIndex + 1);
  const sideCount =
    sideTab === 'pages'
      ? doc?.pdf.numPages
      : sideTab === 'bookmarks'
        ? bookmarks.filter(node => node.page !== null).length
        : 0;
  return {
    activateHighlight,
    anchorOf,
    annotatedBytes,
    applyOperation,
    capabilitySummary,
    centerArea,
    chooseFile,
    clearLibrary,
    closeActiveTab,
    closeWorkbench,
    commentHighlight,
    discardOpenTabs,
    docDirty,
    download,
    driveDirty,
    driveStatus,
    editNote,
    forgetRecent,
    fullscreen,
    inlineEditing,
    listedResults,
    mobilePage,
    navigatePDF,
    onAnnotate,
    onArea,
    openEditor,
    openFiles,
    openTools,
    openWorkbenchSection,
    pageCounter,
    pageName,
    printDocument,
    recordStep,
    redo,
    removeAnnotation,
    reopenRecent,
    replaceDocument,
    renameDocument,
    closeTabs,
    retireLibraryEntry,
    returnToLibrary,
    returnToLocation,
    saveLabel,
    saveNote,
    savesOriginal,
    selectWorkbenchTool,
    sessionStatus,
    shareDocument,
    showDrive,
    sideCount,
    snapshot,
    startAnnotating,
    toggleBookmark,
    trimHistory,
    undo,
    unsaved,
    updateAnnotation,
  };
}
