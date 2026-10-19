import { useMemo } from 'react';
import { BookOpen, Cloud, LoaderCircle } from 'lucide-react';
import { useFolioContext } from '../../app/folio-context';
import PDFPage from '../PDFPage';
import DocumentLibrary from '../DocumentLibrary';
import Workbench from '../Workbench';
import ExplorerTabs from '../ExplorerTabs';
import HighlightColorPicker from '../HighlightColorPicker';
import DrawingSettings from '../DrawingSettings';
import { isNativePdfDocument } from '../../nativePdf';
import { isMobile } from '../../platform';
import type { Annotation } from '../../types';

const NO_ANNOTATIONS: Annotation[] = [];

/** The touch explorer's tabs; a drawer sliding away keeps showing the tab it was on. */
export function ExplorerTabsBar() {
  const { notesShown, searchOpen, showExplorerTab, sideTab, sidebarShown } = useFolioContext();
  return (
    <ExplorerTabs
      onSelect={showExplorerTab}
      selected={id => (id === 'annotations' ? notesShown : sidebarShown && !searchOpen && sideTab === id)}
    />
  );
}

/** The library, with its documents and actions. */
export function LibraryContent() {
  const {
    page,
    busy,
    chooseFile,
    doc,
    driveAvailable,
    libraryLoading,
    loading,
    openDocument,
    recents,
    reopenRecent,
    setConfirmClear,
    setCreating,
    setDeleteTarget,
    setDriveLibrary,
    setHelp,
    setLibrary,
    setSettings,
  } = useFolioContext();
  return (
    <DocumentLibrary
      onDrive={driveAvailable ? () => setDriveLibrary(true) : undefined}
      documents={recents}
      loading={libraryLoading}
      activeDocument={doc && !doc.sample ? { id: doc.id, name: doc.name, page, pages: doc.pdf.numPages } : undefined}
      busy={!!busy || loading}
      onContinue={doc ? () => setLibrary(false) : undefined}
      onOpen={recent => void reopenRecent(recent)}
      onImport={() => requestAnimationFrame(() => void chooseFile())}
      onCreate={() => setCreating(true)}
      onDelete={setDeleteTarget}
      onSettings={() => {
        setConfirmClear(false);
        setSettings(true);
      }}
      onHelp={() => setHelp(true)}
      onDemo={() => void openDocument('sample')}
    />
  );
}

/** The open tool section, or Editar PDF in place of the reader. */
export function ToolSectionPanel() {
  const {
    applyOperation,
    busy,
    closeWorkbench,
    doc,
    download,
    editArea,
    editorDraft,
    history,
    inlineEditing,
    loading,
    notify,
    openEditor,
    openWorkbenchSection,
    output,
    page,
    readingState,
    redactions,
    redo,
    replaceDocument,
    selectWorkbenchTool,
    setEditArea,
    setEditorDraft,
    setPage,
    setPageInput,
    undo,
    workbench,
  } = useFolioContext();
  return workbench && doc && !isNativePdfDocument(doc.pdf) ? (
    <Workbench
      key={`${doc.revision}-${workbench}`}
      doc={doc}
      page={page}
      section={workbench}
      inline={inlineEditing}
      documentBusy={!!busy}
      area={editArea}
      onAreaChange={setEditArea}
      redactions={redactions}
      onClose={closeWorkbench}
      onSelectTool={next => {
        void selectWorkbenchTool(next);
      }}
      onOpenEditor={openEditor}
      onOpenSection={next => {
        void openWorkbenchSection(next);
      }}
      onDraftChange={setEditorDraft}
      onEditPageChange={next => {
        readingState.current.page = next;
        setPage(next);
        setPageInput(String(next));
      }}
      onApply={applyOperation}
      getBytes={() => output.currentBytes()}
      onNotify={message => notify(message, 'success')}
      onSave={() => {
        void download({ keepEditing: true });
      }}
      canSave={!busy && !loading && !editorDraft}
      onHistory={direction => {
        if (!busy) {
          if (direction === 'undo') undo();
          else redo();
        }
      }}
      canUndo={!!history.undo.length}
      canRedo={!!history.redo.length}
      onReplace={replaceDocument}
    />
  ) : null;
}

/** The active Drive document's state: synced, pending, or saving. */
export function DriveIndicator() {
  const { busy, doc, driveDirty, driveStatus } = useFolioContext();
  return (
    (doc?.drive && (
      <span
        className={`drive-document-indicator${driveDirty ? ' pending' : ''}`}
        role="status"
        aria-label={driveStatus}
        title={driveStatus}
      >
        {busy === 'download' ? (
          <LoaderCircle size={15} className="spin" aria-hidden="true" />
        ) : (
          <Cloud size={15} aria-hidden="true" />
        )}
      </span>
    )) ||
    null
  );
}

/** The document's pages. Scrolling changes the current page many times a second; the stack
 * does not depend on it (except in single-page mode), so a long book's thousands of pages are
 * not re-rendered on every page change. */
export function PageStack() {
  const {
    annotationPages,
    busy,
    color,
    dimensions,
    doc,
    editStore,
    editing,
    eraserSize,
    inkStyle,
    loading,
    page,
    pageHandlers,
    pageLabels,
    pageName,
    pages,
    penOnly,
    readingMode,
    readingPreferences,
    redactions,
    removeAnnotation,
    resultIndex,
    results,
    rotation,
    scale,
    searchOpen,
    searchQuery,
    sidebar,
    spread,
    tool,
    touchLayout,
    updateAnnotation,
  } = useFolioContext();
  const stackPage = readingMode === 'single' ? page : 0;
  const editEnvironment = useMemo(
    () => (editing && doc && !touchLayout ? { store: editStore, doc } : undefined),
    [editing, doc, touchLayout, editStore],
  );
  return useMemo(
    () =>
      doc && (
        <div className={`pdf-stack${spread ? ' spread' : ''}`} key={doc.id} style={{ gap: readingPreferences.pageGap }}>
          {doc.sample && (
            <div className="sample-hint">
              <BookOpen size={13} />
              <span>PDF de ejemplo</span>
            </div>
          )}
          {(readingMode === 'single' ? [page] : pages).map(number => (
            <PDFPage
              key={number}
              pdf={doc.pdf}
              edit={editEnvironment}
              live={editStore}
              number={number}
              pageLabel={pageName(number)}
              scale={scale}
              rotation={rotation}
              dimensions={dimensions}
              annotations={annotationPages.get(number) || NO_ANNOTATIONS}
              tool={tool}
              color={color}
              inkColor={inkStyle.color}
              inkWidth={inkStyle.width}
              inkOpacity={inkStyle.opacity}
              eraserSize={eraserSize}
              penOnly={penOnly}
              query={searchOpen ? searchQuery : ''}
              activeSearch={searchOpen && (!touchLayout || !sidebar) ? results[resultIndex] : null}
              canCopy={doc.canCopy}
              canAnnotate={doc.canAnnotate && !busy && !loading}
              onRemoveAnnotation={removeAnnotation}
              onUpdateAnnotation={updateAnnotation}
              redactions={redactions}
              {...pageHandlers}
            />
          ))}
        </div>
      ),
    [
      doc,
      spread,
      readingPreferences.pageGap,
      readingMode,
      stackPage,
      pages,
      pageLabels,
      scale,
      rotation,
      dimensions,
      annotationPages,
      tool,
      color,
      inkStyle,
      eraserSize,
      penOnly,
      searchOpen,
      searchQuery,
      touchLayout,
      sidebar,
      results,
      resultIndex,
      busy,
      loading,
      removeAnnotation,
      updateAnnotation,
      redactions,
      pageHandlers,
      editEnvironment,
      editStore,
    ],
  );
}

/** The active annotation tool's options (colour, width), when it has some. */
export function AnnotationSettings() {
  const {
    busy,
    choosePenOnly,
    color,
    doc,
    eraserSize,
    inkKind,
    inkRecentColors,
    inkStyle,
    loading,
    penDetected,
    penOnly,
    setColor,
    setEraserSize,
    setInkKind,
    setInkRecentColors,
    setInkStyles,
    tool,
  } = useFolioContext();
  return tool === 'highlight' ? (
    <HighlightColorPicker
      color={color}
      onChange={setColor}
      disabled={!doc?.canAnnotate || !doc?.canCopy || !!busy || loading}
    />
  ) : tool === 'draw' || tool === 'eraser' ? (
    <DrawingSettings
      mode={tool}
      kind={inkKind}
      style={inkStyle}
      recentColors={inkRecentColors}
      eraserSize={eraserSize}
      penOnly={penOnly}
      showFingerOption={isMobile || penDetected}
      onKind={setInkKind}
      onStyle={change => setInkStyles(styles => ({ ...styles, [inkKind]: { ...styles[inkKind], ...change } }))}
      onCustomColor={value =>
        setInkRecentColors(colors => [value, ...colors.filter(item => item !== value)].slice(0, 5))
      }
      onEraserSize={setEraserSize}
      onPenOnly={choosePenOnly}
      disabled={!doc?.canAnnotate || !!busy || loading}
    />
  ) : null;
}

/** On touch, tools without options keep their slot so no button moves under the finger. */
export function AnnotationSlot() {
  const { tool } = useFolioContext();
  return tool === 'highlight' || tool === 'draw' || tool === 'eraser' ? (
    <AnnotationSettings />
  ) : (
    <span className="drawing-settings-trigger" aria-hidden="true" style={{ visibility: 'hidden' }} />
  );
}
