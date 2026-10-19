import { MessageSquare, Upload, Wrench, Hash } from 'lucide-react';
import Modal from '../Modal';
import NotePopover from '../NotePopover';
import { DriveBrowser, TransferCard } from '../DriveBrowser';
import DocumentSwitcher from '../DocumentSwitcher';
import ViewSettings from '../ViewSettings';
import CreatePDF from '../CreatePDF';
import { HelpDialog, ShortcutsDialog } from '../HelpDialogs';
import { DesktopDocumentActions, TouchDocumentActions } from '../DocumentActions';
import { CapabilityNotice, DocumentInfoDialog, ForgetDocumentDialog, NoteDialog, PageJumpDialog, PasswordDialog } from '../DocumentDialogs';
import TextSelectionMenu from '../TextSelectionMenu';
import ReadingSettings from '../ReadingSettings';
import { Notices } from '../../app/notices';
import { commentSelection, highlightSelection } from '../../text-selection';
import { ActivityPill } from '../ActivityPill';
import { ColumnSelectionPreview } from '../ColumnSelectionPreview';
import { CommandPalette } from '../CommandPalette';
import { WhatsNew } from '../WhatsNew';
import { PencilPalette, type PencilAction } from '../PencilPalette';
import { isNative, isMobile, shortcutLabel } from '../../platform';
import { useFolioContext } from '../../app/folio-context';
import { LibraryContent, ToolSectionPanel } from './parts';

/** What shows over the workspace: sheets, dialogs, menus, notices, the library and the tool sections. */
export default function AppOverlays() {
  const { redo, activateHighlight, activeTabKey, activity, activityDone, annotationOptions, annotations, bookmarks, busy, cancelPassword, capabilityNotice, capabilitySummary, chooseFile,
    chooseTheme, clearLibrary, closeActiveTab, closeBlocked, closeMobilePanel, closeTab, color, commands, confirmClear, creating, defaultZoom, deleteTarget, dismissToast, doc,
    download, dragOver, driveConflicts, driveLibrary, driveRefresh, editing, editorDraft, forgetRecent, fullscreen, goToPage, help, history, info, inkKind, inkStyle, inlineEditing,
    layout, library, libraryStore, loading, mobileActions, mobileTabs, noteAnchor, noteDraft, noteText, notesOpen, notify, openDocument, openEditor, openTools,
    page, pageInput, pageJump, pageName, palette, password, phone, printDocument, readingMode, readingPreferences, recents, rememberLocation, rememberRecent, removeAnnotation,
    reopenRecent, returnLocation, returnToLibrary, rotation, saveLabel, saveNote, savesOriginal, scale, sessionStatus, setAnnotationOptions, setCapabilityNotice, setConfirmClear,
    setCreating, setCustomScale, setDefaultZoom, setDeleteTarget, setDriveConflicts, setDriveLibrary, setHelp, setInfo, setInkKind, setLibrary, setMobileActions,
    setMobileAnnotating, setMobileTabs, setNoteDraft, setNoteText, setNotesOpen, setPageInput, setPageJump, setPalette, setPassword, setReadingMode, setReadingPreferences,
    setRememberRecent, setRotation, setSettings, setShortcutsOpen, setSidebar, setTool, setViewSettings, setWhatsNew, setZoomMode, settings, shareDocument, shortcutsOpen,
    showDrive, sidebar, storageFailed, switchTab, tabStore, tablet, tabs, theme, toast, tool, touchLayout, undo, viewSettings, whatsNew, workbench, zoomMode } = useFolioContext();
  return <>
  {touchLayout && <DocumentSwitcher open={mobileTabs && !library} documents={tabs.map(tab => ({ key: tab.key, id: tab.doc.id, name: tab.doc.name, page: tab.key === activeTabKey ? page : tab.page, pages: tab.doc.pdf.numPages }))} recents={recents} activeKey={activeTabKey} disabled={!!busy || loading || editorDraft} onDismiss={() => setMobileTabs(false)} onSelect={key => { setMobileTabs(false); requestAnimationFrame(() => { closeMobilePanel(); if (key === activeTabKey) setLibrary(false); else void switchTab(key); }); }} onRecent={recent => { setMobileTabs(false); requestAnimationFrame(() => { closeMobilePanel(); void reopenRecent(recent); }); }} onCloseDocument={key => { setMobileTabs(false); requestAnimationFrame(() => void closeTab(key)); }} onImport={() => { setMobileTabs(false); requestAnimationFrame(() => void chooseFile()); }} onLibrary={() => { setMobileTabs(false); void returnToLibrary(); }} />}
  {touchLayout && mobileActions && <TouchDocumentActions doc={doc} busy={!!busy} loading={loading} status={sessionStatus} storageFailed={storageFailed} onClose={() => setMobileActions(false)}
    tablet={tablet} saveLabel={saveLabel} savesOriginal={savesOriginal} capabilitySummary={capabilitySummary} canUndo={history.undo.length > 0} canRedo={history.redo.length > 0}
    on={{ save: () => void download(), saveCopy: () => void download({ copy: true }), undo, redo, drive: showDrive, share: anchor => void shareDocument(anchor), edit: openEditor,
      view: () => setViewSettings(true), tools: openTools, print: anchor => void printDocument(anchor), info: () => setInfo(true), close: closeActiveTab }} />}
  {!touchLayout && mobileActions && <DesktopDocumentActions doc={doc} busy={!!busy} loading={loading} status={sessionStatus} storageFailed={storageFailed} onClose={() => setMobileActions(false)}
    singlePage={readingMode === 'single'} on={{ drive: showDrive, saveCopy: () => void download({ copy: true }), toggleSinglePage: () => setReadingMode(readingMode === 'single' ? 'continuous' : 'single'),
      rotate: () => setRotation(value => (value + 90) % 360), print: () => void printDocument(), fullscreen: () => void fullscreen(), info: () => setInfo(true), close: closeActiveTab }} />}
  {phone && annotationOptions && <Modal title="Opciones de anotación" onClose={() => setAnnotationOptions(false)}><div className="mobile-action-grid"><button onClick={() => { setAnnotationOptions(false); setSidebar(false); setNotesOpen(true); }}><MessageSquare size={21} />Ver anotaciones ({annotations.length})</button><button onClick={() => { setAnnotationOptions(false); openTools(); }}><Wrench size={21} />Herramientas</button></div></Modal>}
  {touchLayout && pageJump && doc && <PageJumpDialog pages={doc.pdf.numPages} page={page} value={pageInput} onValue={setPageInput} onCancel={() => setPageJump(false)}
    onGo={next => { rememberLocation(); setPageJump(false); requestAnimationFrame(() => goToPage(next, false)); }} />}

  {viewSettings && <ViewSettings touch={touchLayout} phone={phone} mode={readingMode} onMode={setReadingMode} zoom={zoomMode} scale={scale} onZoom={value => { if (['width', 'page'].includes(value)) setZoomMode(value); else { setCustomScale(Number(value) / 100); setZoomMode('custom'); } }} rotation={rotation} onRotate={() => setRotation(value => (value + 90) % 360)} pageTone={readingPreferences.pageTone} onPageTone={pageTone => setReadingPreferences(current => ({ ...current, pageTone }))} keepAwake={readingPreferences.keepAwake} onKeepAwake={isNative && isMobile ? keepAwake => setReadingPreferences(current => ({ ...current, keepAwake })) : undefined} onClose={() => setViewSettings(false)} />}
  {capabilityNotice && <CapabilityNotice summary={capabilitySummary} onClose={() => setCapabilityNotice(false)} />}
  <TextSelectionMenu key={doc?.pdf.loadingTask.docId} enabled={!!doc?.canCopy && !editing && !mobileActions && tool === 'select' && !loading && !busy && !noteDraft && !workbench && !creating && !library && !settings && !help && !info && !password && !closeBlocked && !pageJump && !viewSettings && !annotationOptions && !capabilityNotice && !deleteTarget && !(touchLayout && (sidebar || notesOpen || mobileActions || mobileTabs))} canAnnotate={!!doc?.canAnnotate} color={color} onHighlight={() => { highlightSelection(); }} onComment={() => { commentSelection(); }} onNotify={(message, error) => notify(message, error ? 'error' : 'success')} />
  {dragOver && <div className="drop-overlay"><div><Upload size={38} /><h2>Suelta para abrir</h2><p>Archivos PDF</p></div></div>}
  {creating && <CreatePDF onClose={() => setCreating(false)} onCreate={async (bytes, name) => { await openDocument(bytes, name, false, undefined, { modified: true, useSession: false }); setCreating(false); }} />}
  <ActivityPill working={activity} done={activityDone} />
  <PencilPalette enabled={!!doc?.canAnnotate && !library && !busy && !loading && !workbench} inkColor={inkStyle.color} canUndo={history.undo.length > 0}
    active={tool === 'draw' ? inkKind : tool === 'eraser' || tool === 'highlight' || tool === 'note' ? tool as PencilAction : undefined}
    onAction={action => {
      if (action === 'undo') { undo(); return; }
      setMobileAnnotating(true);
      if (action === 'pen' || action === 'marker') { setInkKind(action); setTool('draw'); }
      else if (action === 'highlight') activateHighlight();
      else setTool(action);
    }} />
  {whatsNew && <WhatsNew touch={touchLayout} onClose={() => setWhatsNew(false)} />}
  {palette && <CommandPalette commands={commands()} onClose={() => setPalette(false)} pageCommand={number => doc && number >= 1 && number <= doc.pdf.numPages ? { id: 'page-number', group: 'Navegación', title: `Ir a la página ${number}`, icon: <Hash size={16} />, run: () => { if (!returnLocation) rememberLocation(); goToPage(number, false); } } : null} />}
  {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
  {doc && <ColumnSelectionPreview />}
  <Notices toast={toast} onDismiss={dismissToast} />

  {library && <div className={`library-screen${phone ? '' : ' desktop-library-screen'}`}>{driveLibrary ? <DriveBrowser onClose={() => setDriveLibrary(false)} onOpen={(file, pending) => libraryStore.openDrive(file, pending)} onSynced={file => { libraryStore.synced(file); tabStore.publish(); }} conflicts={driveConflicts} onConflicts={setDriveConflicts} /> : <LibraryContent />}</div>}
  {driveRefresh && <TransferCard transfer={driveRefresh} />}
  {deleteTarget && <ForgetDocumentDialog target={deleteTarget} open={tabs.some(tab => tab.doc.id === deleteTarget.id)} disabled={!!busy || loading} onCancel={() => setDeleteTarget(null)} onConfirm={() => void forgetRecent(deleteTarget)} />}
  {!inlineEditing && <ToolSectionPanel />}
  {noteDraft && touchLayout && <NoteDialog isNew={!noteDraft.id} page={pageName(noteDraft.page)} text={noteText} onText={setNoteText} onSave={saveNote} onCancel={() => setNoteDraft(null)} />}
  {noteDraft && !touchLayout && <NotePopover anchor={noteAnchor} page={pageName(noteDraft.page)} text={noteText} color={noteDraft.color} isNew={!noteDraft.id} shortcut={shortcutLabel('↵')} onText={setNoteText}
    onColor={color => setNoteDraft(draft => draft && { ...draft, color })} onSave={saveNote} onCancel={() => setNoteDraft(null)} onRemove={noteDraft.id ? () => { removeAnnotation(noteDraft.id!); setNoteDraft(null); } : undefined} />}
  {password && <PasswordDialog request={password} onSubmitted={() => setPassword(null)} onCancel={cancelPassword} />}
  {info && doc && <DocumentInfoDialog doc={doc} annotations={annotations.length} bookmarks={bookmarks.length} onClose={() => setInfo(false)} />}
  {settings && <ReadingSettings layout={layout} theme={theme} onTheme={chooseTheme} zoom={defaultZoom} onZoom={setDefaultZoom} preferences={readingPreferences} onPreferences={setReadingPreferences} rememberRecent={rememberRecent} onRemember={setRememberRecent} openDocuments={tabs.length} confirmClear={confirmClear} onClear={() => void clearLibrary()} onCancelClear={() => setConfirmClear(false)} onClose={() => setSettings(false)} />}
  {help && <HelpDialog touch={touchLayout} onClose={() => setHelp(false)} />}
  </>;
}
