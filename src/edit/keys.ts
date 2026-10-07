import type { EditStore, EditTool } from './store';
import { deleteSelection, duplicateSelection, editText, nudgeSelection } from './actions';

// Keys while editing, outside a text field: Supr deletes, Ctrl/⌘+D duplicates,
// arrows move by a point (Shift, ten), letters pick tools, Intro types in the
// selected text and Esc deselects, then leaves Editar.

const TOOL_KEYS: Record<string, EditTool> = { v: 'select', t: 'text', i: 'image', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow' };

export function editKey(store: EditStore, event: KeyboardEvent, leave: () => void): boolean {
  const state = store.state, command = event.ctrlKey || event.metaKey, key = event.key;
  if (state.draft) return false;
  const selection = state.selection;
  if ((key === 'Delete' || key === 'Backspace') && selection) { event.preventDefault(); void deleteSelection(store); return true; }
  if (command && !event.shiftKey && key.toLowerCase() === 'd' && selection) { event.preventDefault(); duplicateSelection(store); return true; }
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  if (arrows[key] && selection && !command) {
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    nudgeSelection(store, arrows[key][0] * step, arrows[key][1] * step);
    return true;
  }
  if (key === 'Enter' && selection?.kind === 'text') {
    event.preventDefault();
    void store.items(store.doc!, selection.page).then(info => editText(store, selection.page, selection.item, info.items)).catch(() => {});
    return true;
  }
  if (key === 'Escape') {
    event.preventDefault();
    if (selection || state.tool !== 'select' || state.image) store.set({ selection: null, tool: 'select', image: null, notice: '' });
    else leave();
    return true;
  }
  const tool = !command && !event.altKey ? TOOL_KEYS[key.toLowerCase()] : undefined;
  if (tool && !state.committing) {
    event.preventDefault();
    if (tool === 'image') document.querySelector<HTMLInputElement>('.edit-toolbar input[type=file]')?.click();
    else store.set({ tool, image: null, notice: '', ...(tool !== 'select' ? { selection: null } : {}) });
    return true;
  }
  return false;
}
