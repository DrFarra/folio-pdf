// The app's pure decisions, tested without a browser: which shortcut a key press means (and
// a macOS menu command), the page ← and → turn to, the bookmark button, the centred area of
// the area tools, and what the interface says about a document.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
// Inside the project, so the bundle finds its packages in node_modules.
await mkdir(path.join(root, 'test-results'), { recursive: true });
const out = await mkdtemp(path.join(root, 'test-results', 'app-logic-'));
const entry = path.join(out, 'logic.mjs');
await build({
  stdin: {
    contents: `export * from './src/app/shortcuts.ts'; export * from './src/app/document-status.ts'; export { toggledBookmark, withNote, commentFor } from './src/app/marks.ts'; export { centeredArea } from './src/app/tool-sections.ts';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: entry,
  logLevel: 'silent',
  // React, Tauri and the rest of the interface are not part of these decisions.
  external: ['react', '@tauri-apps/*', 'lucide-react', 'pdfjs-dist', 'mupdf'],
  // Vite's asset URLs (workers, wasm) are not part of these decisions either.
  plugins: [
    {
      name: 'vite-assets',
      setup(bundle) {
        bundle.onResolve({ filter: /\?(url|worker)$/ }, args => ({ path: args.path, namespace: 'vite-asset' }));
        bundle.onLoad({ filter: /.*/, namespace: 'vite-asset' }, () => ({
          contents: 'export default "";',
          loader: 'js',
        }));
      },
    },
  ],
});
const logic = await import(pathToFileURL(entry).href);
await rm(out, { recursive: true, force: true });

const key = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
const context = {
  field: false,
  searchField: false,
  modal: false,
  editor: false,
  draft: false,
  busy: false,
  loading: false,
  library: false,
  tabs: 2,
  tab: true,
  searchResults: false,
  canAnnotate: true,
  overflows: () => false,
  editKeys: () => false,
};

// Shortcuts.
assert.deepEqual(logic.readShortcut(key('ArrowRight'), context), {
  prevent: true,
  shortcut: { run: 'turn', forward: true },
});
assert.deepEqual(logic.readShortcut(key('ArrowRight'), { ...context, overflows: () => true }).shortcut, {
  run: 'scroll',
  left: 40,
});
assert.deepEqual(logic.readShortcut(key('s', { ctrlKey: true }), context).shortcut, { run: 'save', copy: false });
assert.deepEqual(logic.readShortcut(key('Tab', { ctrlKey: true, shiftKey: true }), context).shortcut, {
  run: 'switch-tab',
  step: -1,
});
assert.equal(
  logic.readShortcut(key('Tab', { ctrlKey: true }), { ...context, tabs: 1 }).shortcut,
  undefined,
  'One tab: Ctrl+Tab does nothing.',
);
assert.deepEqual(logic.readShortcut(key('w', { ctrlKey: true }), { ...context, modal: true }), {
  prevent: true,
  shortcut: { run: 'close-dialog' },
});
assert.deepEqual(
  logic.readShortcut(key('x'), { ...context, modal: true }),
  { prevent: false, shortcut: undefined },
  'A dialog keeps ordinary keys.',
);
assert.deepEqual(
  logic.readShortcut(key('z', { ctrlKey: true }), { ...context, editor: true, draft: true }),
  { prevent: true, shortcut: undefined },
  'An unapplied edit holds undo.',
);
assert.equal(
  logic.readShortcut(key('h'), { ...context, field: true }).shortcut,
  undefined,
  'Typing in a field is not a shortcut.',
);
assert.deepEqual(logic.readShortcut(key('n'), context).shortcut, { run: 'tool', tool: 'note' });
assert.equal(logic.readShortcut(key('n'), { ...context, canAnnotate: false }).shortcut, undefined);
assert.equal(
  logic.readShortcut(key('+', { ctrlKey: true }), { ...context, busy: true }).prevent,
  true,
  'Browser zoom stays off even while busy.',
);
assert.equal(
  logic.readShortcut(key('ArrowRight'), { ...context, editKeys: () => true }).shortcut,
  undefined,
  "Editar's own keys win.",
);

// The macOS menu.
const menu = { modal: false, editor: false, document: true };
assert.deepEqual(logic.menuShortcut('close-tab', { ...menu, modal: true }), { run: 'close-dialog' });
assert.deepEqual(logic.menuShortcut('save-copy', { ...menu, editor: true }), {
  run: 'save',
  keepEditing: true,
  copy: true,
});
assert.equal(logic.menuShortcut('print', { ...menu, editor: true }), undefined);
assert.equal(logic.menuShortcut('zoom-in', { ...menu, document: false }), undefined);
assert.deepEqual(logic.menuShortcut('zoom-reset', menu), { run: 'actual-size' });

// Turning pages; side by side, pages turn as pairs: 1–2, 3–4…
assert.equal(logic.turnedPage(5, true, false), 6);
assert.equal(logic.turnedPage(1, false, false), 1);
assert.equal(logic.turnedPage(1, true, true), 3);
assert.equal(logic.turnedPage(2, true, true), 3);
assert.equal(logic.turnedPage(4, false, true), 1);
assert.equal(logic.turnedPage(3, false, true), 1);

// Page names and the bookmark button.
assert.equal(logic.pageName(['i', 'ii', '1'], 3), '3 (1)');
assert.equal(logic.pageName(['1', '2'], 2), '2');
assert.equal(logic.pageCounter(3, 10, 'iii'), '3 / 10 · iii');
const added = logic.toggledBookmark([], 4, true);
assert.equal(added.bookmarks.length, 1);
assert.ok(added.added);
assert.deepEqual(
  logic.toggledBookmark(added.bookmarks, 4, true),
  { bookmarks: [] },
  'On touch the filled bookmark toggles off.',
);
assert.equal(
  logic.toggledBookmark(added.bookmarks, 4, false).added,
  added.added,
  'On desktop it edits the existing one.',
);

// A note and a highlight's comment.
const note = logic.withNote([], { page: 1, kind: 'note', rect: [0, 0, 0, 0], text: '', color: '#ff0000' }, '  hola ');
assert.equal(note.list.length, 1);
assert.equal(note.note.text, 'hola');
assert.deepEqual(
  logic.commentFor({ page: 2, rect: [10, 20, 30, 40], color: '#00ff00' }, [0, 0, 600, 800]).rect,
  [576, 40, 576, 40],
);

// The centred area, on an upright page (PDF y grows upwards).
const view = { width: 100, height: 200, convertToPdfPoint: (x, y) => [x, 200 - y] };
assert.deepEqual(logic.centeredArea(view, 'crop', 3), { page: 3, rect: [10, 20, 90, 180] });
assert.deepEqual(logic.centeredArea(view, 'redact', 3).rect.map(Math.round), [25, 85, 75, 115]);

// What the interface says about a document.
const doc = { modified: false, savedAnnotations: '[]', drive: { editable: true }, canAnnotate: true };
const status = logic.documentStatus({
  doc,
  annotations: [],
  downloaded: false,
  saving: true,
  driveMessage: 'Subiendo a Drive…',
  storageFailed: false,
});
assert.equal(status.saveLabel, 'Guardar en Drive');
assert.equal(status.driveStatus, 'Subiendo a Drive…');
assert.equal(status.docDirty, false);
assert.equal(
  logic.isUnsaved({ ...doc, modified: true }, [], true),
  false,
  'A downloaded web PDF no longer reads as unsaved.',
);

console.log(JSON.stringify({ id: 'app-logic', status: 'passed' }));
