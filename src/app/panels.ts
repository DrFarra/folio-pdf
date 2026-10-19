import { useEffect, useRef, useState } from 'react';
import { useExit } from '../motion';
import { rememberSearch } from '../search-snippet';
import type { SideTab, Tool } from '../types';
import { searchTerm } from './model';
import type { useDocumentSearch } from './search';
import { useLatest } from './latest';

/** The explorer's tabs on touch layouts: three in the side drawer, annotations in their own. */
export const explorerIds = ['pages', 'outline', 'bookmarks', 'annotations'] as const;
export type ExplorerId = (typeof explorerIds)[number];

type Panels = {
  touch: boolean;
  phone: boolean;
  sidebar: boolean;
  setSidebar: (open: boolean) => void;
  sideTab: SideTab;
  setSideTab: (tab: SideTab) => void;
  notesOpen: boolean;
  setNotesOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  search: ReturnType<typeof useDocumentSearch>;
  input: React.RefObject<HTMLInputElement | null>;
  /** A bookmark's name is being edited: the drawer leaves its focus alone. */
  bookmarkEditing: boolean;
  setTool: (tool: Tool) => void;
  setAnnotating: (annotating: boolean) => void;
  showChrome: () => void;
  /** Switching between the explorer and annotation drawers swaps their content. */
  setDrawerSwap: (swap: boolean) => void;
  activeKey: () => string | null;
  goToPage: (page: number, smooth?: boolean) => void;
  /** «Volver a p. N»: whether a place is remembered, and remembering this one. */
  hasReturn: () => boolean;
  rememberLocation: () => void;
};

/** The side panels and search: opening and closing them, stepping through results, and on
 * touch layouts the drawers' keyboard focus. */
export function usePanels(options: Panels) {
  const {
    touch,
    phone,
    sidebar,
    setSidebar,
    sideTab,
    setSideTab,
    notesOpen,
    setNotesOpen,
    searchOpen,
    setSearchOpen,
    search,
    input,
    setTool,
    setAnnotating,
    showChrome,
  } = options;
  const live = useLatest(options);
  // The search a result was last visited for (Enter goes to the next one only then), and Enter
  // pressed before the typing pause; the panel open before searching, to restore.
  const visited = useRef<string | null>(null),
    submitPending = useRef(false),
    panelBeforeSearch = useRef(false);

  useEffect(() => {
    if (searchOpen) {
      live.current.setSidebar(true);
      setTimeout(() => live.current.input.current?.focus(), 50);
    }
  }, [searchOpen]);
  // A touch drawer keeps keyboard focus inside it; Escape closes it.
  const { bookmarkEditing } = options;
  useEffect(() => {
    if (!touch || !(sidebar || notesOpen)) return;
    const drawer = document.querySelector<HTMLElement>('.mobile-drawer');
    if (!drawer) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!bookmarkEditing)
      drawer.querySelector<HTMLButtonElement>('button:not([tabindex="-1"])')?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open], .bookmark-menu')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        live.current.setSidebar(false);
        live.current.setSearchOpen(false);
        live.current.setNotesOpen(false);
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...drawer.querySelectorAll<HTMLElement>(
          'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ),
      ].filter(element => element.getClientRects().length);
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('keydown', keyboard, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [touch, sidebar, notesOpen, bookmarkEditing]);

  const searchKey = () => `${live.current.activeKey()}\0${search.searchQuery}`;
  /** Shows a result (wrapping around), remembering where the reader was. */
  const goToResult = (index: number) => {
    const { results, searchQuery } = search;
    if (!results.length) return;
    const next = (index + results.length) % results.length;
    if (!live.current.hasReturn()) live.current.rememberLocation();
    visited.current = searchKey();
    search.setHistory(current => rememberSearch(searchQuery, current));
    search.setResultIndex(next);
    live.current.goToPage(results[next].page, false);
    requestAnimationFrame(() =>
      window.dispatchEvent(
        new CustomEvent('folio:reveal-search-result', {
          detail: { page: results[next].page, offset: results[next].offset },
        }),
      ),
    );
    if (touch) {
      input.current?.blur();
      setSidebar(false);
      setNotesOpen(false);
      showChrome();
    }
  };
  const goToResultRef = useLatest(goToResult);
  useEffect(() => {
    if (submitPending.current) {
      submitPending.current = false;
      goToResultRef.current(0);
    }
  }, [search.results]);
  /** Enter (`step` 1, or 0 to show the current result) and Shift+Enter (-1). */
  const submitSearch = (step: number) => {
    // Enter before the typing pause searches at once and then shows the first result.
    const term = searchTerm(search.query);
    if (term !== search.searchQuery) {
      if (term) {
        submitPending.current = true;
        search.searchNow(term);
      }
      return;
    }
    goToResult(visited.current === searchKey() ? search.resultIndex + step : search.resultIndex);
  };
  /** F3: the next result, or the current one when it has not been visited yet. */
  const stepResult = (step: 1 | -1) =>
    goToResult(visited.current === searchKey() ? search.resultIndex + step : search.resultIndex);
  /** Typing a search starts its results afresh. */
  const typeQuery = (value: string) => {
    visited.current = null;
    search.setQuery(value);
    search.setResultIndex(0);
  };

  // A desktop panel closed from inside returns keyboard focus to its rail button.
  const focusRail = (label: string) =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(`.tool-rail [aria-label="${label}"]`)?.focus({ preventScroll: true }),
    );
  const openSearch = () => {
    if (!searchOpen) {
      visited.current = null;
      panelBeforeSearch.current = sidebar;
    }
    showChrome();
    setAnnotating(false);
    setTool('select');
    setNotesOpen(false);
    setSearchOpen(true);
    setSidebar(true);
    if (searchOpen) {
      input.current?.focus();
      input.current?.select();
    }
  };
  const closeSearch = () => {
    // Restore the panel that was open before searching; keyboard focus returns to Buscar.
    const returnFocus = !touch && !!document.activeElement?.closest('.sidebar');
    visited.current = null;
    setSearchOpen(false);
    search.setQuery('');
    setSidebar(!touch && panelBeforeSearch.current);
    if (returnFocus) focusRail('Buscar en el PDF');
  };
  const closeMobilePanel = () => {
    setSidebar(false);
    setSearchOpen(false);
    search.setQuery('');
    setNotesOpen(false);
    if (phone)
      requestAnimationFrame(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="Páginas"]')?.focus({ preventScroll: true }),
      );
  };
  const openExplorer = (tab: SideTab = 'pages') => {
    showChrome();
    setSearchOpen(false);
    search.setQuery('');
    setNotesOpen(false);
    setSideTab(tab);
    setSidebar(true);
  };
  /** The desktop rail's panel buttons open their panel, or close it when it is the one shown. */
  const toggleSidePanel = (tab: SideTab) => {
    if (phone || window.innerWidth < 1000) setNotesOpen(false);
    setSidebar(!(sidebar && !searchOpen && sideTab === tab));
    setSearchOpen(false);
    setSideTab(tab);
  };
  const showExplorerTab = (id: ExplorerId, focus = false) => {
    // Annotations and the other tabs are separate drawers in the same place:
    // switching between them swaps the content instead of closing and reopening.
    if (id === 'annotations' ? sidebar : notesOpen) live.current.setDrawerSwap(true);
    setSearchOpen(false);
    search.setQuery('');
    setNotesOpen(id === 'annotations');
    setSidebar(id !== 'annotations');
    if (id !== 'annotations') setSideTab(id);
    // Annotations live in their own drawer, so the tab is focused once it renders.
    if (focus)
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLButtonElement>(`.mobile-panel-tabs [data-explorer-tab="${id}"]`)
          ?.focus({ preventScroll: true }),
      );
  };
  /** A page chosen in a panel: remembered for «Volver», and on touch the drawer closes. */
  const showPage = (number: number) => {
    live.current.rememberLocation();
    live.current.goToPage(number);
    if (touch) closeMobilePanel();
  };
  return {
    goToResult,
    submitSearch,
    stepResult,
    typeQuery,
    openSearch,
    closeSearch,
    closeMobilePanel,
    openExplorer,
    toggleSidePanel,
    showExplorerTab,
    showPage,
    focusRail,
  };
}

/** The touch drawers (explorer, annotations) stay mounted while they slide away. Only the one
 * open last slides away; one replaced by a tab switch is already gone. `drawerSwap` marks a
 * switch between them, which swaps their content instead of closing and reopening. */
export function useDrawerExit(touch: boolean, sidebar: boolean, notesOpen: boolean) {
  const sidebarLeaving = useExit(touch && sidebar),
    notesLeaving = useExit(touch && notesOpen);
  const [drawerSwap, setDrawerSwap] = useState(false);
  const last = useRef<'sidebar' | 'notes'>('sidebar');
  if (sidebar) last.current = 'sidebar';
  else if (notesOpen) last.current = 'notes';
  useEffect(() => {
    if (!sidebar && !notesOpen) setDrawerSwap(false);
  }, [sidebar, notesOpen]);
  return {
    sidebarLeaving,
    notesLeaving,
    drawerSwap,
    setDrawerSwap,
    sidebarShown: sidebar || (sidebarLeaving && last.current === 'sidebar'),
    notesShown: notesOpen || (notesLeaving && last.current === 'notes'),
  };
}
