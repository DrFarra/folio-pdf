import { useEffect, useRef } from 'react';
import { isMac, isNative } from '../platform';

/** What a key press asks for. `undefined` leaves it to the page. */
export type Shortcut =
  | { run: 'close-dialog' | 'undo' | 'redo' | 'close-tab' | 'palette' | 'open' | 'find' | 'print' | 'shortcuts' | 'actual-size' | 'escape' }
  | { run: 'switch-tab' | 'search-step'; step: 1 | -1 }
  | { run: 'save'; copy: boolean; keepEditing?: boolean }
  | { run: 'zoom'; delta: number }
  | { run: 'scroll'; left: number }
  | { run: 'turn'; forward: boolean }
  | { run: 'tool'; tool: 'highlight' | 'note' | 'draw' | 'select' };

/** Where the key was pressed. */
export type KeyContext = {
  /** The key went to a text field, select or editable element. */
  field: boolean;
  /** …which is the search field. */
  searchField: boolean;
  /** A dialog is open. */
  modal: boolean;
  /** Editar PDF is open in the reader's place (desktop), and holds an unapplied edit. */
  editor: boolean; draft: boolean;
  busy: boolean; loading: boolean;
  library: boolean;
  /** Open tabs, and whether one is shown. */
  tabs: number; tab: boolean;
  /** Search is open with results. */
  searchResults: boolean;
  canAnnotate: boolean;
  /** The zoomed page overflows the reader sideways. */
  overflows: () => boolean;
  /** Editar's own keys (moving, deleting, nudging content) took the press. */
  editKeys: () => boolean;
};

/** The shortcut a key press means in `context`, and whether the browser's default
 * action is stopped (it is for every shortcut Folio takes, even one that waits). */
export function readShortcut(e: KeyboardEvent, context: KeyContext): { prevent: boolean; shortcut?: Shortcut } {
  const command = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  // On Windows, WebView2's zoom stays on so that touchpad pinches reach the page as
  // Ctrl+wheel (Tauri ties both together); its key zoom would scale the whole interface.
  const prevent = command && ['+', '=', '-', '0'].includes(e.key);
  const take = (shortcut?: Shortcut) => ({ prevent: true, shortcut });
  const pass = (shortcut?: Shortcut) => ({ prevent, shortcut });
  const { field, modal, editor, draft, busy, loading, library, tabs, tab } = context;
  const nextTab = (previous: boolean) => take(tabs > 1 ? { run: 'switch-tab', step: previous ? -1 : 1 } : undefined);
  // ⌃⌘F is the menu's Pantalla completa on macOS; leave it to toggleFullScreen:.
  if (isMac && e.metaKey && e.ctrlKey && key === 'f') return pass();
  if (context.editKeys()) return pass();
  if (modal) {
    if (!command || !['s', 'p', 'w', 'o', 'f'].includes(key)) return pass();
    // Unhandled, ⌘W would reach the window menu and close Folio: it closes the dialog in front.
    return take(key === 'w' ? { run: 'close-dialog' } : undefined);
  }
  // Editar PDF keeps the reader's history, tab and save shortcuts, and none of its others.
  if (editor) {
    if (command && !field && ['z', 'y'].includes(key)) return take(draft || busy || loading ? undefined : { run: key === 'y' || e.shiftKey ? 'redo' : 'undo' });
    if (command && e.key === 'Tab') return draft ? take() : nextTab(e.shiftKey);
    if (command && key === 'w') return take(!draft && tab ? { run: 'close-tab' } : undefined);
    if (command && key === 's') return take({ run: 'save', keepEditing: true, copy: isNative && e.shiftKey });
    if (command && ['p', 'o', 'f'].includes(key)) return take();
    return pass();
  }
  if (command && e.key === 'Tab') return nextTab(e.shiftKey);
  if (isMac && e.metaKey && ((e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) || (e.shiftKey && ['[', ']', '{', '}'].includes(e.key)))) return nextTab(['ArrowLeft', '[', '{'].includes(e.key));
  // Without a document, ⌘W is left to the window menu.
  if (command && key === 'w' && tab) return take({ run: 'close-tab' });
  if (command && !e.shiftKey && !e.altKey && key === 'k') return take({ run: 'palette' });
  if (command && key === 'o') return take(busy ? undefined : { run: 'open' });
  if (command && key === 'f') return take({ run: 'find' });
  if (command && key === 'p') return take({ run: 'print' });
  if (command && key === 's') return take({ run: 'save', copy: isNative && e.shiftKey });
  if (e.key === 'F3' && (!field || context.searchField) && !busy && !loading && !library && context.searchResults) return take({ run: 'search-step', step: e.shiftKey ? -1 : 1 });
  if (field) return pass();
  if (e.key === '?' && !e.ctrlKey && !e.metaKey) return take({ run: 'shortcuts' });
  if (busy || loading) return pass();
  if (command && key === 'z') return take({ run: e.shiftKey ? 'redo' : 'undo' });
  if (command && key === 'y') return take({ run: 'redo' });
  if (command && ['+', '=', '-'].includes(e.key)) return take({ run: 'zoom', delta: e.key === '-' ? -.1 : .1 });
  if (command && e.key === '0') return take({ run: 'actual-size' });
  if (command || e.altKey || library) return pass();
  // A zoomed page that overflows sideways scrolls with ← and →; PageUp/PageDown still turn pages.
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && context.overflows()) return take({ run: 'scroll', left: e.key === 'ArrowRight' ? 40 : -40 });
  if (e.key === 'ArrowRight' || e.key === 'PageDown') return take({ run: 'turn', forward: true });
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') return take({ run: 'turn', forward: false });
  if (key === 'h') return pass({ run: 'tool', tool: 'highlight' });
  if (key === 'n' && context.canAnnotate) return pass({ run: 'tool', tool: 'note' });
  if (key === 'd' && context.canAnnotate) return pass({ run: 'tool', tool: 'draw' });
  if (key === 'v') return pass({ run: 'tool', tool: 'select' });
  if (e.key === 'Escape') return pass({ run: 'escape' });
  return pass();
}

/** Calls `handle` for each key press the page has not handled yet. */
export function useKeyboard(handle: (event: KeyboardEvent) => void) {
  const live = useRef(handle); live.current = handle;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (!event.defaultPrevented) live.current(event); };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}
