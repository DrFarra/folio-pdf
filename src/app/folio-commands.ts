import { useCallback } from 'react';
import { errorMessage } from '../errors';
import { isNativePdfDocument } from '../nativePdf';
import { type History } from './model';
import type { Area, Operation, PageEntry } from '../engine/operations.ts';
import { paletteCommands } from './palette-commands';
import { commentFor, patched, toggledBookmark, withAdded, withNote, without } from './marks';
import { menuShortcut, readShortcut, useKeyboard, type Shortcut } from './shortcuts';
import { useAndroidBack, useMacMenu } from './native-events';
import { hasBookmarkPage } from '../bookmarks';
import { highlightSelection } from '../text-selection';
import type { AnnotationDraft } from '../text-selection';
import { editKey } from '../edit/keys';
import { isNative, pickNativeDocuments, haptic, type Anchor } from '../platform';
import type { Annotation, LoadedDocument, RecentDocument, Tool } from '../types';
import { documentStatus, isUnsaved, pageCounter as pageCounterOf, pageName as pageNameOf, turnedPage } from './document-status';
import { centeredArea } from './tool-sections';
import type { useFolioState } from './folio-state';
import type { useFolioReader } from './folio-reader';
import type { useFolioDocuments } from './folio-documents';

type Layer3 = ReturnType<typeof useFolioState> & ReturnType<typeof useFolioReader> & ReturnType<typeof useFolioDocuments>;

/** What the user does: the commands of the keyboard, the palette and the menus, and the actions on annotations, tools, files and the library. */
export function useFolioCommands(f: Layer3) {
  const { activeTabKey, annotationRef, annotations, bookmarkRef, bookmarks, busy, busyRef, captureTab, changeZoom, changes, chooseTheme, closeMobilePanel, closeSearch, closeTab,
    commitAnnotations, commitBookmarks, confirmClear, currentPageLabel, doc, docRef, downloadedDrafts, driveAvailable, driveLibrary, driveMessage, editStore, editingRef,
    editorDraftRef, fileInput, goToPage, history, library, libraryStore, loading, loadingRef, mobileAnnotating, mobileTabs, navigate, noteDraft, noteOrigin, noteText,
    notesOpen, notify, openDocument, openExplorer, openNote, openSearch, outline, output, page, pageLabels, phone, phoneRef, picking, readerChromeHidden,
    readingPreferences, recents, rememberLocation, resultIndex, resultLimit, results, returnLocation, returnPage, returnToPlace, searchInput, searchOpen, setActiveNote,
    setBookmarkEditingId, setCapabilityNotice, setConfirmClear, setCreating, setCustomScale, setDeleteTarget, setDriveLibrary, setEditArea, setEditing, setHelp, setInfo,
    setLibrary, setMobileAnnotating, setMobileTabs, setNoteDraft, setNotesOpen, setPageInput, setPageJump, setPalette, setReaderChromeHidden, setReadingPreferences,
    setRedactions, setSearchOpen, setSettings, setShortcutsOpen, setSideTab, setSidebar, setTool, setViewSettings, setWorkbench, setZoomMode, showExplorerTab, showPage,
    sideTab, sidebar, spread, stepResult, storageFailed, switchTab, tabStore, tabs, tool, toolSections, touchLayout, touchRef, viewer, workbench, workbenchRef } = f;
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
      case 'settings': setConfirmClear(false); setSettings(true); break;
      case 'help': setHelp(true); break;
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
      case 'turn': goToPage(turnedPage(page, shortcut.forward, spread)); break;
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
  // Usar un área centrada; Cambiar área draws another.
  async function centerArea() {
    const current = docRef.current; if (!current) return;
    onArea(centeredArea((await current.pdf.getPage(page)).getViewport({ scale: 1 }), tool, page));
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
  const { saveLabel, savesOriginal, sessionStatus, docDirty, driveDirty, driveStatus, capabilitySummary } = documentStatus({ doc, annotations, storageFailed, driveMessage,
    downloaded: !!doc && downloadedDrafts.current.has(doc), saving: busy === 'download' });
  const unsaved = (document: LoadedDocument, items: Annotation[]) => isUnsaved(document, items, downloadedDrafts.current.has(document));
  const pageName = (number: number) => pageNameOf(pageLabels, number);
  const pageCounter = doc ? pageCounterOf(page, doc.pdf.numPages, currentPageLabel) : undefined;
  const listedResults = Math.max(resultLimit, resultIndex + 1);
  const sideCount = sideTab === 'pages' ? doc?.pdf.numPages : sideTab === 'bookmarks' ? bookmarks.filter(node => node.page !== null).length : 0;
  useMacMenu(id => {
    const modal = [...document.querySelectorAll('dialog[open]')].at(-1);
    const shortcut = menuShortcut(id, { modal: !!modal, editor: workbenchRef.current === 'edit-pdf', document: !!docRef.current });
    if (shortcut) runShortcut(shortcut, modal);
  });
  return { activateHighlight, anchorOf, annotatedBytes, applyOperation, capabilitySummary, centerArea, chooseFile, clearLibrary, closeActiveTab, closeWorkbench, commands,
    commentHighlight, discardOpenTabs, docDirty, download, driveDirty, driveStatus, editNote, find, forgetRecent, fullscreen, inlineEditing, listedResults, mobilePage,
    navigatePDF, onAnnotate, onArea, openEditor, openFiles, openTools, openWorkbenchSection, pageCounter, pageName, printDocument, recordStep, redo, removeAnnotation,
    reopenRecent, replaceDocument, retireLibraryEntry, returnToLibrary, returnToLocation, runShortcut, saveLabel, saveNote, savesOriginal, selectWorkbenchTool,
    sessionStatus, shareDocument, showDrive, sideCount, snapshot, startAnnotating, toggleBookmark, trimHistory, undo, unsaved, updateAnnotation };
}
