import { useMemo, useRef } from 'react';
import { errorMessage } from '../errors';
import { uid } from './model';
import type { Area } from '../engine/operations.ts';
import type { AnnotationDraft } from '../text-selection';
import { useEdgeSwipeBack } from '../edge-swipe';
import { touchDocument } from '../storage';
import type { Annotation, PDFNavigationTarget } from '../types';
import type { useFolioState } from './folio-state';
import type { useFolioReader } from './folio-reader';
import type { useFolioDocuments } from './folio-documents';
import type { useFolioCommands } from './folio-commands';
import type { useFolioInput } from './folio-input';

type Layer5 = ReturnType<typeof useFolioState> & ReturnType<typeof useFolioReader> & ReturnType<typeof useFolioDocuments> & ReturnType<typeof useFolioCommands> & ReturnType<typeof useFolioInput>;

/** Connects the controllers to the app (their hosts), Editar's actions and the pages' event handlers. */
export function useFolioWiring(f: Layer5) {
  const { activateTab, activeView, annotatedBytes, annotationRef, applyOperation, bookmarkRef, busyRef, cancelScrollRestore, captureTab, changes, closeTab, closeWorkbench,
    commentHighlight, commitAnnotations, discardOpenTabs, dismissToast, doc, docRef, downloadedDrafts, driveAvailable, driveLibrary, editNote, editStore, editingRef,
    editorDraftRef, goToPage, history, inlineEditing, library, libraryStore, liveEdit, loadingRef, mobileAnnotating, mobilePage, navigatePDF, notify, onAnnotate, onArea,
    openDocument, opener, output, pages, persistence, phoneRef, preferencesRef, presentTab, readingPreferencesRef, readingState, recordStep, removeAnnotation,
    reopenWritten, retireLibraryEntry, returnToLibrary, setActiveNote, setBusy, setCloseBlocked, setDoc, setDriveConflicts, setDriveLibrary, setDriveMessage,
    setDriveRefresh, setEditArea, setEditing, setHistoryTick, setLibrary, setLoading, setNotesOpen, setPage, setPageInput, setPassword, setRecents, setSessionFailed,
    setTabs, setTool, setWorkbench, showAnnotations, showBookmarks, showNoDocument, snapshot, switchTab, tabStore, tool, toolSections, touchLayout, touchRef, trimHistory,
    unreadSessions, viewer, workbench, workbenchRef } = f;
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
  return { pageEvents, pageHandlers, thumbnailClicks };
}
