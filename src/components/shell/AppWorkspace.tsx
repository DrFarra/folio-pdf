import { BookOpen, ChevronLeft, LoaderCircle, MessageSquare, X } from 'lucide-react';
import { Thumbnail } from '../PDFPage';
import { SheetHandle } from '../Modal';
import IconButton from '../IconButton';
import DocumentOutline from '../DocumentOutline';
import { plural } from '../../pdf';
import { isNativePdfDocument } from '../../nativePdf';
import SearchPanel from '../SearchPanel';
import ToolRail from '../ToolRail';
import { AnnotationToolbar, ReaderToolbar } from '../ReaderToolbar';
import { PhoneAnnotationToolbar, PhoneReadingBar } from '../PhoneReaderControls';
import BookmarkTree from '../BookmarkTree';
import { hasBookmarkPage } from '../../bookmarks';
import EditToolbar from '../../edit/EditToolbar';
import { PageScrubber } from '../PageScrubber';
import { AnnotationsPanel } from '../AnnotationsPanel';
import { clearRecentSearches } from '../../search-snippet';
import { TabletAnnotationDock, TabletSearchBar } from '../TabletReaderControls';
import { isNative, isIOS, copyNativeText, saveExport } from '../../platform';
import { useFolioContext } from '../../app/folio-context';
import { AnnotationSettings, AnnotationSlot, ExplorerTabsBar, PageStack, ToolSectionPanel } from './parts';

/** The workspace: the tool rail, the side panel, the reader with its toolbars, and the annotations panel. */
export default function AppWorkspace() {
  const {
    activateHighlight,
    activeNote,
    activeTabKey,
    anchorOf,
    annotations,
    bookmarkEditingId,
    bookmarks,
    busy,
    centerArea,
    changeZoom,
    closeMobilePanel,
    closeSearch,
    commitBookmarks,
    commitPageInput,
    doc,
    docDirty,
    download,
    drawerSwap,
    editNote,
    editPageInput,
    editStore,
    editing,
    focusRail,
    goToPage,
    goToResult,
    history,
    indexing,
    inlineEditing,
    library,
    listedResults,
    loading,
    mobileAnnotating,
    mobilePage,
    notesLeaving,
    notesOpen,
    notesShown,
    notify,
    occurrences,
    openEditor,
    openExplorer,
    openSearch,
    openTools,
    openWorkbenchSection,
    outline,
    outlineSection,
    page,
    pageCounter,
    pageInput,
    pageInputDirty,
    pageName,
    pages,
    phone,
    query,
    readingMode,
    readingPreferences,
    redactions,
    redo,
    rememberLocation,
    removeAnnotation,
    resultIndex,
    results,
    returnLocation,
    returnPage,
    returnToLocation,
    rotation,
    saveLabel,
    scale,
    searchHistory,
    searchInput,
    searchOpen,
    searchQuery,
    setActiveNote,
    setAnnotationOptions,
    setBookmarkEditingId,
    setConfirmClear,
    setCustomScale,
    setEditing,
    setHelp,
    setLibrary,
    setMobileActions,
    setMobileAnnotating,
    setNotesOpen,
    setPageInput,
    setPageJump,
    setQuery,
    setRedactions,
    setResultLimit,
    setSearchHistory,
    setSearchOpen,
    setSettings,
    setSidebar,
    setTool,
    setWorkbench,
    setZoomMode,
    shareDocument,
    showBookmarks,
    sideCount,
    sideTab,
    sidebar,
    sidebarLeaving,
    sidebarShown,
    startAnnotating,
    submitSearch,
    tablet,
    textIndex,
    thumbnailClicks,
    toggleBookmark,
    toggleSidePanel,
    tool,
    touchLayout,
    typeQuery,
    undo,
    viewer,
    zoomMode,
  } = useFolioContext();
  return (
    <>
      <div className="workspace" inert={library}>
        {!touchLayout && (
          <ToolRail
            library={library}
            hasDocument={!!doc}
            panel={sidebar && !searchOpen ? sideTab : null}
            searching={searchOpen && sidebar}
            notesOpen={notesOpen}
            annotations={annotations.length}
            inert={inlineEditing}
            onLibrary={() => setLibrary(true)}
            onPanel={toggleSidePanel}
            onSearch={() => {
              if (searchOpen && sidebar) closeSearch();
              else openSearch();
            }}
            onNotes={() => {
              if (window.innerWidth < 1000) {
                setSidebar(false);
                setSearchOpen(false);
              }
              setNotesOpen(v => !v);
            }}
            onSettings={() => {
              setSettings(true);
              setConfirmClear(false);
            }}
            onHelp={() => setHelp(true)}
          />
        )}
        {touchLayout && (sidebar || notesOpen || sidebarLeaving || notesLeaving) && (
          <button
            className={`mobile-panel-backdrop${sidebar || notesOpen ? '' : ' closing'}`}
            aria-label="Cerrar panel lateral"
            tabIndex={-1}
            onClick={closeMobilePanel}
          />
        )}
        {sidebarShown && (
          <aside
            className={`sidebar${touchLayout ? ' mobile-drawer' : ''}${sidebarLeaving ? ' closing' : ''}${drawerSwap ? ' drawer-swap' : ''}`}
            role={touchLayout ? 'dialog' : undefined}
            aria-modal={touchLayout ? true : undefined}
            aria-label={touchLayout ? (searchOpen ? 'Buscar en el PDF' : 'Explorar documento') : undefined}
            style={
              touchLayout
                ? undefined
                : { width: readingPreferences.panelWidth, minWidth: readingPreferences.panelWidth }
            }
          >
            {touchLayout && (
              <>
                <SheetHandle onClose={closeMobilePanel} label="Cerrar explorador" />
                <div className="mobile-drawer-heading">
                  <h2>{searchOpen ? 'Buscar' : 'Explorar'}</h2>
                  <IconButton label={searchOpen ? 'Cerrar búsqueda' : 'Cerrar panel'} onClick={closeMobilePanel}>
                    <X size={20} />
                  </IconButton>
                </div>
                {!searchOpen && <ExplorerTabsBar />}
              </>
            )}
            {searchOpen ? (
              <SearchPanel
                touch={touchLayout}
                input={searchInput}
                query={query}
                searchQuery={searchQuery}
                onClose={closeSearch}
                onQuery={typeQuery}
                onClear={() => setQuery('')}
                onSubmit={backwards => submitSearch(backwards ? -1 : phone ? 0 : 1)}
                history={searchHistory}
                onClearHistory={() => {
                  clearRecentSearches();
                  setSearchHistory([]);
                }}
                indexing={indexing}
                indexed={textIndex}
                pages={doc?.pdf.numPages || 0}
                results={results}
                occurrences={occurrences}
                selected={resultIndex}
                listed={listedResults}
                onShowMore={() => setResultLimit(listedResults + 200)}
                onResult={goToResult}
                pageName={pageName}
                section={outlineSection}
                onRecognize={
                  doc?.canEdit && !isNativePdfDocument(doc.pdf)
                    ? () => {
                        closeSearch();
                        void openWorkbenchSection('ocr');
                      }
                    : undefined
                }
              />
            ) : (
              <>
                {!touchLayout && (
                  <div className="sidebar-title">
                    <span>{sideTab === 'pages' ? 'Páginas' : sideTab === 'outline' ? 'Índice' : 'Marcadores'}</span>
                    {!!sideCount && <span className="page-total">{sideCount}</span>}
                    <IconButton
                      label="Cerrar panel"
                      onClick={() => {
                        setSidebar(false);
                        focusRail(sideTab === 'pages' ? 'Páginas' : sideTab === 'outline' ? 'Índice' : 'Marcadores');
                      }}
                    >
                      <X size={16} />
                    </IconButton>
                  </div>
                )}

                <div
                  className={`sidebar-scroll ${sideTab === 'pages' ? 'thumbnails' : 'outline-list'}`}
                  id={touchLayout ? 'explorer-panel' : undefined}
                  role={touchLayout ? 'tabpanel' : undefined}
                >
                  {sideTab === 'pages' &&
                    doc &&
                    pages.map(number => (
                      <Thumbnail
                        key={`${doc.pdf.loadingTask.docId}-${number}`}
                        pdf={doc.pdf}
                        number={number}
                        rotation={rotation}
                        pageLabel={pageName(number)}
                        selected={page === number}
                        onClick={thumbnailClicks[number - 1]}
                      />
                    ))}
                  {sideTab === 'outline' &&
                    (outline ? (
                      <DocumentOutline outline={outline} page={page} onNavigate={mobilePage} />
                    ) : (
                      <div className="empty-panel">
                        <LoaderCircle size={26} className="spin" />
                        <p>Cargando índice…</p>
                      </div>
                    ))}
                  {sideTab === 'bookmarks' && (
                    <BookmarkTree
                      key={activeTabKey}
                      bookmarks={bookmarks}
                      onChange={commitBookmarks}
                      onFold={showBookmarks}
                      page={page}
                      onGoToPage={mobilePage}
                      disabled={!!busy || loading}
                      startEditingId={bookmarkEditingId}
                      onEditingComplete={() => setBookmarkEditingId(null)}
                    />
                  )}
                </div>
              </>
            )}
          </aside>
        )}

        <main
          className={`reader${phone && mobileAnnotating ? ' mobile-annotating' : ''}`}
          id="document-reader"
          inert={library || (touchLayout && (sidebar || notesOpen))}
        >
          {!touchLayout && !inlineEditing && (
            <ReaderToolbar
              doc={doc}
              busy={!!busy}
              loading={loading}
              mode={editing ? 'edit' : mobileAnnotating ? 'annotate' : 'read'}
              onRead={() => {
                setEditing(false);
                setMobileAnnotating(false);
                setTool('select');
              }}
              onAnnotate={startAnnotating}
              onEdit={openEditor}
              onTools={openTools}
              canUndo={!!history.undo.length}
              canRedo={!!history.redo.length}
              onUndo={undo}
              onRedo={redo}
              page={page}
              pageInput={pageInput}
              onPageInput={editPageInput}
              onPageCommit={commitPageInput}
              onPageBlur={() => {
                if (pageInputDirty.current) commitPageInput();
              }}
              onPage={goToPage}
              zoomMode={zoomMode}
              scale={scale}
              onZoom={changeZoom}
              onZoomChoice={value => {
                if (['page', 'width'].includes(value)) setZoomMode(value);
                else {
                  setCustomScale(Number(value) / 100);
                  setZoomMode('custom');
                }
              }}
              bookmarked={hasBookmarkPage(bookmarks, page)}
              onBookmark={toggleBookmark}
              saveLabel={saveLabel}
              unsaved={docDirty}
              onSave={() => void download()}
              onMore={() => setMobileActions(true)}
            />
          )}
          {!touchLayout && !inlineEditing && doc && editing && (
            <EditToolbar store={editStore} doc={doc} onDone={() => setEditing(false)} />
          )}
          {!touchLayout && !inlineEditing && doc && mobileAnnotating && !editing && (
            <AnnotationToolbar
              doc={doc}
              disabled={!!busy || loading}
              tool={tool}
              onTool={setTool}
              onHighlight={activateHighlight}
              settings={<AnnotationSettings />}
              onDone={() => {
                setMobileAnnotating(false);
                setTool('select');
              }}
            />
          )}

          {tablet && doc && mobileAnnotating && !inlineEditing && (
            <TabletAnnotationDock
              tool={tool}
              setTool={setTool}
              disabled={!doc.canAnnotate || !!busy || loading}
              canCopy={doc.canCopy}
              settings={<AnnotationSlot />}
              hasSettings={tool === 'highlight' || tool === 'draw' || tool === 'eraser'}
              onHighlight={activateHighlight}
            />
          )}
          {tablet && doc && searchOpen && !sidebar && !inlineEditing && (
            <TabletSearchBar
              results={results.length}
              result={resultIndex}
              onResult={goToResult}
              onResults={() => setSidebar(true)}
              onClose={closeSearch}
            />
          )}
          {inlineEditing && <ToolSectionPanel />}
          <div
            className="reading-area"
            hidden={inlineEditing}
            style={inlineEditing ? { display: 'none' } : undefined}
            ref={viewer}
            aria-label="Área de lectura del PDF"
            tabIndex={-1}
          >
            {doc ? (
              <PageStack />
            ) : (
              !loading && (
                <div className="welcome">
                  <div className="welcome-icon">
                    <BookOpen size={38} />
                  </div>
                  <h2>Abrir PDF</h2>
                  <p>
                    {!touchLayout
                      ? 'Selecciona un archivo o arrástralo a esta ventana.'
                      : isIOS
                        ? 'Selecciona un PDF desde Archivos.'
                        : 'Selecciona un PDF para abrirlo.'}
                  </p>
                </div>
              )
            )}
            {loading && (
              <div className="loading-overlay" role="status">
                <svg className="activity-ring large" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="activity-ring-track" cx="12" cy="12" r="9" />
                  <circle className="activity-ring-arc" cx="12" cy="12" r="9" />
                </svg>
                <span>Abriendo PDF…</span>
              </div>
            )}
          </div>
          {touchLayout &&
            doc &&
            !inlineEditing &&
            !loading &&
            !(mobileAnnotating && (tool === 'draw' || tool === 'eraser')) && (
              <PageScrubber
                pdf={doc.pdf}
                page={page}
                pages={doc.pdf.numPages}
                viewer={viewer.current}
                continuous={readingMode !== 'single'}
                label={pageName}
                section={outlineSection}
                onJump={target => {
                  if (!returnLocation) rememberLocation();
                  goToPage(target, false);
                }}
              />
            )}
          {touchLayout && doc && returnPage !== null && (
            <button className="touch-return-location" onClick={returnToLocation}>
              <ChevronLeft size={18} />
              <span>Volver a p. {pageName(returnPage)}</span>
            </button>
          )}

          {phone && doc && (
            <PhoneReadingBar
              doc={doc}
              disabled={!!busy || loading}
              page={page}
              counter={pageCounter ?? ''}
              singlePage={readingMode === 'single'}
              onPage={next => goToPage(next, false)}
              onJump={() => {
                setPageInput(String(page));
                setPageJump(true);
              }}
              bookmarked={hasBookmarkPage(bookmarks, page)}
              onBookmark={toggleBookmark}
              annotating={mobileAnnotating}
              searching={searchOpen && !sidebar}
              results={results.length}
              result={resultIndex}
              onResult={goToResult}
              onResults={() => setSidebar(true)}
              onCloseSearch={closeSearch}
              onPages={() => openExplorer()}
              onSearch={openSearch}
              onAnnotate={startAnnotating}
              onShare={button => void shareDocument(anchorOf(button))}
            />
          )}
          {!touchLayout && doc && returnPage !== null && (
            <button className="desktop-return-location" onClick={returnToLocation}>
              <ChevronLeft size={16} />
              <span>Volver a p. {returnPage}</span>
            </button>
          )}
          {phone && doc && mobileAnnotating && (
            <PhoneAnnotationToolbar
              doc={doc}
              disabled={!!busy || loading}
              tool={tool}
              onTool={setTool}
              onHighlight={activateHighlight}
              settings=<AnnotationSlot />
              onMore={() => setAnnotationOptions(true)}
            />
          )}

          {tool !== 'select' &&
            tool !== 'highlight' &&
            tool !== 'draw' &&
            tool !== 'eraser' &&
            doc &&
            (touchLayout || !mobileAnnotating) && (
              <div className="annotation-tool-hint">
                <span>
                  {tool === 'note'
                    ? touchLayout
                      ? 'Toca la página para añadir una nota'
                      : 'Haz clic en la página para añadir una nota'
                    : tool === 'redact'
                      ? 'Marca las áreas que quieres censurar'
                      : tool === 'crop'
                        ? 'Arrastra sobre la página para elegir el área visible'
                        : 'Arrastra para seleccionar el área'}
                </span>
                {!phone && tool !== 'note' && (tool !== 'redact' || !redactions.length) && (
                  <button
                    className="secondary-button"
                    disabled={!doc.canEdit || !!busy}
                    onClick={() => void centerArea()}
                  >
                    Usar un área centrada
                  </button>
                )}
                {tool === 'redact' && redactions.length > 0 && (
                  <>
                    <button
                      className="secondary-button"
                      onClick={() => setRedactions(previous => previous.slice(0, -1))}
                    >
                      Quitar última área
                    </button>
                    <button className="primary-button" onClick={() => setWorkbench('redact')}>
                      Revisar {plural(redactions.length, 'área', 'áreas')}
                    </button>
                  </>
                )}
                {!(touchLayout && mobileAnnotating && tool === 'note') && (
                  <IconButton
                    label="Terminar herramienta"
                    onClick={() => {
                      setTool('select');
                      setRedactions([]);
                    }}
                  >
                    <X size={15} />
                  </IconButton>
                )}
              </div>
            )}
        </main>

        {notesShown && (
          <aside
            className={`notes-panel${touchLayout ? ' mobile-drawer' : ''}${notesLeaving ? ' closing' : ''}${drawerSwap ? ' drawer-swap' : ''}`}
            role={touchLayout ? 'dialog' : undefined}
            aria-modal={touchLayout ? true : undefined}
            aria-label={touchLayout ? 'Anotaciones' : undefined}
          >
            {touchLayout && (
              <>
                <SheetHandle onClose={closeMobilePanel} label="Cerrar explorador" />
                <div className="mobile-drawer-heading">
                  <h2>Explorar</h2>
                  <IconButton label="Cerrar panel" onClick={closeMobilePanel}>
                    <X size={20} />
                  </IconButton>
                </div>
                <ExplorerTabsBar />
              </>
            )}
            {!touchLayout && (
              <div className="notes-heading">
                <div>
                  <MessageSquare size={17} />
                  <h2>Anotaciones</h2>
                  <span>{annotations.length}</span>
                </div>
                <IconButton
                  label="Cerrar anotaciones"
                  onClick={() => {
                    setNotesOpen(false);
                    focusRail('Anotaciones');
                  }}
                >
                  <X size={16} />
                </IconButton>
              </div>
            )}
            <div
              className="notes-scroll"
              id={touchLayout ? 'explorer-panel' : undefined}
              role={touchLayout ? 'tabpanel' : undefined}
            >
              {doc && (
                <AnnotationsPanel
                  annotations={annotations}
                  documentName={doc.name}
                  activeId={activeNote}
                  editable={!!doc.canAnnotate && !busy && !loading}
                  pageName={pageName}
                  onSelect={item => {
                    mobilePage(item.page);
                    setActiveNote(item.id);
                  }}
                  onDelete={item => {
                    removeAnnotation(item.id);
                    notify(
                      item.kind === 'note'
                        ? 'Nota eliminada.'
                        : item.kind === 'ink'
                          ? 'Dibujo eliminado.'
                          : 'Resaltado eliminado.',
                      'info',
                      { label: 'Deshacer', run: undo },
                    );
                  }}
                  onEditNote={item => editNote(item, 'list')}
                  onCopy={async text => {
                    if (isNative && isIOS) await copyNativeText(text);
                    else await navigator.clipboard.writeText(text);
                  }}
                  onSave={(text, name) => saveExport(new TextEncoder().encode(text), name, 'txt', doc.nativeSource)}
                />
              )}
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
