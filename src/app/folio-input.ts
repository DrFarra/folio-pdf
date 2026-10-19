import { paletteCommands } from './palette-commands';
import { menuShortcut, readShortcut, useKeyboard, type Shortcut } from './shortcuts';
import { useAndroidBack, useMacMenu } from './native-events';
import { hasBookmarkPage } from '../bookmarks';
import { editKey } from '../edit/keys';
import { turnedPage } from './document-status';
import type { useFolioState } from './folio-state';
import type { useFolioReader } from './folio-reader';
import type { useFolioDocuments } from './folio-documents';
import type { useFolioCommands } from './folio-commands';

type Layer4 = ReturnType<typeof useFolioState> & ReturnType<typeof useFolioReader> & ReturnType<typeof useFolioDocuments> & ReturnType<typeof useFolioCommands>;

/** The user's input: the keyboard's shortcuts and the macOS menu (through one executor), the command palette, and Android's Back button. */
export function useFolioInput(f: Layer4) {
  const { activateHighlight, activeTabKey, bookmarks, busy, busyRef, changeZoom, chooseFile, chooseTheme, closeActiveTab, closeMobilePanel, closeSearch, closeTab, closeWorkbench,
    doc, docRef, download, driveAvailable, driveLibrary, editStore, editingRef, editorDraftRef, goToPage, history, library, loading, loadingRef, mobileAnnotating,
    mobileTabs, notesOpen, notify, openEditor, openExplorer, openSearch, openTools, outline, page, pageName, phoneRef, printDocument, readerChromeHidden,
    readingPreferences, recents, redo, rememberLocation, reopenRecent, results, returnLocation, returnPage, returnToLibrary, returnToLocation, saveLabel, searchInput,
    searchOpen, setConfirmClear, setCreating, setCustomScale, setDriveLibrary, setEditing, setHelp, setInfo, setLibrary, setMobileAnnotating, setMobileTabs, setNotesOpen,
    setPageInput, setPageJump, setPalette, setReaderChromeHidden, setReadingPreferences, setRedactions, setSettings, setShortcutsOpen, setTool, setViewSettings,
    setWorkbench, setZoomMode, shareDocument, showExplorerTab, sidebar, spread, stepResult, switchTab, tabStore, tabs, toggleBookmark, tool, touchLayout, undo, viewer,
    workbench, workbenchRef } = f;
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
  useMacMenu(id => {
    const modal = [...document.querySelectorAll('dialog[open]')].at(-1);
    const shortcut = menuShortcut(id, { modal: !!modal, editor: workbenchRef.current === 'edit-pdf', document: !!docRef.current });
    if (shortcut) runShortcut(shortcut, modal);
  });
  return { commands, find, runShortcut };
}
