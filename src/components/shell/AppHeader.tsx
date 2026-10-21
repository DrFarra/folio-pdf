import {
  ChevronDown,
  ChevronLeft,
  Info,
  Maximize,
  Minimize,
  Minus,
  MoreHorizontal,
  Plus,
  Redo2,
  Undo2,
  X,
} from 'lucide-react';
import IconButton from '../IconButton';
import DocumentTabStrip from '../DocumentTabStrip';
import { HeaderActions, ModeSwitch } from '../ReaderToolbar';
import { hasBookmarkPage } from '../../bookmarks';
import { TabletReaderHeader } from '../TabletReaderControls';
import { isDesktop, isMac } from '../../platform';
import { useFolioContext } from '../../app/folio-context';
import { DriveIndicator } from './parts';

/** The header: on desktop the document tabs and the window's controls; on phones and tablets the document's name and the reader's actions. */
export default function AppHeader() {
  const {
    activeTabKey,
    annotations,
    bookmarks,
    busy,
    chooseFile,
    closeTab,
    doc,
    download,
    editorDraft,
    fileInput,
    goToPage,
    history,
    inlineEditing,
    library,
    loading,
    mobileAnnotating,
    mobileTabs,
    notesOpen,
    openExplorer,
    openFiles,
    openSearch,
    page,
    pageCounter,
    phone,
    readingMode,
    redo,
    returnToLibrary,
    sessionStatus,
    setLibrary,
    setMobileActions,
    setMobileAnnotating,
    setMobileTabs,
    setPageInput,
    setPageJump,
    setTool,
    sidebar,
    startAnnotating,
    storageFailed,
    switchTab,
    tabDrag,
    tablet,
    tabs,
    toggleBookmark,
    touchLayout,
    undo,
    unsaved,
    windowAction,
    windowState,
    docDirty,
    editing,
    openEditor,
    saveLabel,
    setEditing,
    setPalette,
  } = useFolioContext();
  const idle = !!doc && !busy && !loading;
  return (
    <>
      <header className="app-header" data-tauri-drag-region inert={touchLayout && (library || sidebar || notesOpen)}>
        <h1 className="sr-only">{doc?.name || 'Folio'}</h1>
        {tablet ? (
          <TabletReaderHeader
            nameAdornment={<DriveIndicator />}
            documentsOpen={mobileTabs}
            name={doc?.name || 'Folio'}
            count={tabs.length}
            page={pageCounter}
            pageStep={
              readingMode === 'single' && doc
                ? {
                    previous: page > 1 ? () => goToPage(page - 1, false) : undefined,
                    next: page < doc.pdf.numPages ? () => goToPage(page + 1, false) : undefined,
                  }
                : undefined
            }
            annotating={mobileAnnotating}
            disabled={!!busy || loading}
            draft={editorDraft || inlineEditing}
            canUndo={!!history.undo.length}
            canRedo={!!history.redo.length}
            bookmarked={!!doc && hasBookmarkPage(bookmarks, page)}
            onBookmark={toggleBookmark}
            onLibrary={() => void returnToLibrary()}
            onDocuments={() => setMobileTabs(value => !value)}
            onPage={() => {
              setPageInput(String(page));
              setPageJump(true);
            }}
            onPages={() => openExplorer()}
            onSearch={openSearch}
            onAnnotate={startAnnotating}
            onDone={() => {
              setMobileAnnotating(false);
              setTool('select');
            }}
            onUndo={undo}
            onRedo={redo}
            onMore={() => setMobileActions(true)}
          />
        ) : phone ? (
          <>
            <IconButton
              label="Volver a la biblioteca"
              disabled={!!busy || loading}
              onClick={() => void returnToLibrary()}
            >
              <ChevronLeft size={24} />
            </IconButton>
            <button
              id="document-switcher-trigger"
              className="mobile-document-selector"
              aria-label="Documentos abiertos y recientes"
              aria-haspopup="dialog"
              aria-expanded={mobileTabs}
              aria-controls="document-switcher"
              disabled={!!busy || loading || !tabs.length}
              onClick={() => setMobileTabs(value => !value)}
            >
              <span>{doc?.name || 'Folio'}</span>
              <DriveIndicator />
              {tabs.length > 1 && <span className="mobile-tab-count">{tabs.length}</span>}
              <ChevronDown size={16} />
            </button>
            {mobileAnnotating ? (
              <>
                <IconButton label="Deshacer" disabled={!!busy || !history.undo.length} onClick={undo}>
                  <Undo2 size={21} />
                </IconButton>
                <IconButton label="Rehacer" disabled={!!busy || !history.redo.length} onClick={redo}>
                  <Redo2 size={21} />
                </IconButton>
                <button
                  className="mobile-done"
                  onClick={() => {
                    setMobileAnnotating(false);
                    setTool('select');
                  }}
                >
                  Listo
                </button>
              </>
            ) : (
              <IconButton label="Más acciones" onClick={() => setMobileActions(true)}>
                <MoreHorizontal size={23} />
              </IconButton>
            )}
          </>
        ) : (
          <>
            {/* Three zones: the mode switch stays centred and the tabs never reach it. */}
            <div className="header-start" data-tauri-drag-region>
              <div className="brand">
                <img src="/folio.svg" alt="Folio" />
              </div>
              <DocumentTabStrip
                tabs={tabs}
                activeKey={activeTabKey}
                disabled={!!busy || loading || editorDraft}
                driveIndicator={<DriveIndicator />}
                drag={tabDrag}
                modified={tab => unsaved(tab.doc, tab.key === activeTabKey ? annotations : tab.annotations)}
                onShow={() => setLibrary(false)}
                onSwitch={key => void switchTab(key)}
                onClose={key => void closeTab(key)}
              />
              {tabs.length > 0 && (
                <IconButton
                  label="Abrir PDF"
                  disabled={!!busy || loading || editorDraft}
                  onClick={() => void chooseFile()}
                  className="new-document-tab"
                >
                  <Plus size={19} />
                </IconButton>
              )}
              <div className="header-drag-space" data-tauri-drag-region />
            </div>
            <div className="header-center" data-tauri-drag-region>
              {doc && !library && !inlineEditing && (
                <ModeSwitch
                  doc={doc}
                  idle={idle}
                  mode={editing ? 'edit' : mobileAnnotating ? 'annotate' : 'read'}
                  onRead={() => {
                    setEditing(false);
                    setMobileAnnotating(false);
                    setTool('select');
                  }}
                  onAnnotate={startAnnotating}
                  onEdit={openEditor}
                />
              )}
            </div>
            <div className="header-end" data-tauri-drag-region>
              {/* Document information lives in Más acciones and creation in the library. */}
              <div className="header-actions">
                {storageFailed && (
                  <button className="session-warning" title={sessionStatus} onClick={() => void download()}>
                    <Info size={15} />
                    Cambios sin guardar
                  </button>
                )}
              </div>
              {doc && !library && !inlineEditing && (
                <HeaderActions
                  doc={doc}
                  idle={idle}
                  busy={!!busy}
                  canUndo={!!history.undo.length}
                  canRedo={!!history.redo.length}
                  onUndo={undo}
                  onRedo={redo}
                  onPalette={() => setPalette(true)}
                  saveLabel={saveLabel}
                  unsaved={docDirty}
                  onSave={() => void download()}
                  onMore={() => setMobileActions(true)}
                />
              )}
              {isDesktop && !isMac && (
                <div className="window-actions">
                  <IconButton label="Minimizar ventana" onClick={() => void windowAction('minimize')}>
                    <Minus size={16} />
                  </IconButton>
                  <IconButton
                    label={windowState.maximized ? 'Restaurar ventana' : 'Maximizar ventana'}
                    onClick={() => void windowAction('toggleMaximize')}
                  >
                    {windowState.maximized ? <Minimize size={14} /> : <Maximize size={14} />}
                  </IconButton>
                  <IconButton
                    label="Cerrar ventana"
                    onClick={() => void windowAction('close')}
                    className="window-close"
                  >
                    <X size={17} />
                  </IconButton>
                </div>
              )}
            </div>
          </>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="application/pdf,.pdf"
          className="sr-only"
          aria-label="Elegir archivo PDF"
          tabIndex={-1}
          aria-hidden="true"
          onChange={e => {
            const input = e.currentTarget;
            void openFiles(Array.from(input.files || [])).finally(() => {
              input.value = '';
            });
          }}
        />
      </header>
    </>
  );
}
