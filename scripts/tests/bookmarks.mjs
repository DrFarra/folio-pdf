import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { addPageBookmark, bookmarkChildren, bookmarkDescendants, bookmarkDropDestination, createBookmark, deleteBookmark, dropBookmark, hasBookmarkPage, moveBookmark, normalizeBookmarks, remapBookmarks, reorderBookmark } from '../../src/bookmarks.ts';

const results = [];
function check(name, action) { action(); results.push({ name, passed: true }); }
const node = (id, page, parentId = null, order = 0) => ({ id, title: id, page, parentId, order, color: '#4579ba' });

check('legacy numeric sessions keep every valid bookmark with deterministic IDs', () => {
  const raw = [1, 8, -2, 0, null, '2', 8, 3.5];
  const migrated = normalizeBookmarks(raw);
  assert.deepEqual(migrated.map(item => item.page), [1, 8, 8]);
  assert.equal(new Set(migrated.map(item => item.id)).size, 3);
  assert.deepEqual(migrated, normalizeBookmarks(raw));
  assert.deepEqual(migrated, normalizeBookmarks(migrated));
  assert.equal(migrated[1].title, 'Página 8');
});

check('malformed IDs, missing parents, names, colors and cycles are repaired', () => {
  const normalized = normalizeBookmarks([
    { ...node('a', 1, 'b'), title: '  Inicio  ', color: 'red', collapsed: true },
    node('b', null, 'a'), node('b', 2), node('self', 3, 'self'), node('orphan', 4, 'missing'),
    { ...node('bad', -4), page: '4' }, null,
  ]);
  assert.equal(normalized.length, 5);
  assert.equal(new Set(normalized.map(item => item.id)).size, 5);
  assert.equal(normalized.find(item => item.id === 'a').title, 'Inicio');
  assert.equal(normalized.find(item => item.id === 'a').color, '#bd4b38');
  assert.equal(normalized.find(item => item.id === 'a').collapsed, true);
  assert.equal(normalized.find(item => item.id === 'self').parentId, null);
  assert.equal(normalized.find(item => item.id === 'orphan').parentId, null);
  for (const item of normalized) assert.ok(!bookmarkDescendants(normalized, item.id).has(item.id));
});

check('page validation keeps folders and promotes valid descendants of removed pages', () => {
  const value = normalizeBookmarks([node('folder', null), node('gone', 8, 'folder'), node('child', 2, 'gone'), node('empty', null, 'gone')], 3);
  assert.deepEqual(value.map(item => item.id), ['folder', 'child', 'empty']);
  assert.equal(value.find(item => item.id === 'child').parentId, 'folder');
  assert.equal(value.find(item => item.id === 'empty').parentId, 'folder');
  const ordered = normalizeBookmarks([node('before', 1), node('removed', 8, null, 1), node('after', 3, null, 2), node('one', 2, 'removed', 5), node('two', null, 'removed', 7)], 3);
  assert.deepEqual(bookmarkChildren(ordered, null).map(item => item.id), ['before', 'one', 'two', 'after']);
});

check('adding an existing page returns its node and unfolds its complete ancestry', () => {
  const original = [ { ...node('top', null), collapsed: true }, { ...node('group', null, 'top'), collapsed: true }, node('page', 2, 'group') ];
  const opened = addPageBookmark(original, 2);
  assert.equal(opened.id, 'page'); assert.equal(opened.bookmarks.length, 3);
  assert.ok(opened.bookmarks.filter(item => item.page === null).every(item => !item.collapsed));
  assert.ok(original[0].collapsed); assert.ok(original[1].collapsed);
  const added = addPageBookmark(opened.bookmarks, 4);
  assert.equal(added.bookmarks.find(item => item.id === added.id).page, 4);
  assert.equal(added.bookmarks.find(item => item.id === added.id).parentId, null);
  assert.ok(hasBookmarkPage(added.bookmarks, 4));
});

check('child groups and page bookmarks inherit color and unfold their parent', () => {
  const original = [ { ...node('top', null), collapsed: true } ];
  const added = createBookmark(original, 3, 'top');
  const child = added.bookmarks.find(item => item.id === added.id);
  assert.equal(child.parentId, 'top'); assert.equal(child.color, '#4579ba');
  assert.equal(added.bookmarks[0].collapsed, false);
  const group = createBookmark(added.bookmarks, null, 'top');
  assert.equal(group.bookmarks.find(item => item.id === group.id).order, 1);
});

check('reparenting and before/after ordering reject moves into descendants', () => {
  const original = [node('a', null), node('b', 1, null, 1), node('child', 2, 'a'), node('grandchild', 3, 'child')];
  assert.equal(moveBookmark(original, 'a', 'grandchild'), original);
  assert.equal(moveBookmark(original, 'a', 'a'), original);
  assert.equal(moveBookmark(original, 'a', 'missing'), original);
  assert.equal(moveBookmark(original, 'b', null, 'missing'), original);
  const into = moveBookmark(original, 'b', 'a', 'child');
  assert.deepEqual(bookmarkChildren(into, 'a').map(item => item.id), ['b', 'child']);
  const out = moveBookmark(into, 'child', null, 'a');
  assert.deepEqual(bookmarkChildren(out, null).map(item => item.id), ['child', 'a']);
  assert.equal(out.find(item => item.id === 'grandchild').parentId, 'child');
  assert.deepEqual(bookmarkChildren(reorderBookmark(out, 'a', -1), null).map(item => item.id), ['a', 'child']);
  assert.equal(reorderBookmark(out, 'a', 1), out);
});

check('mouse destinations move complete branches into groups or page parents without losing attributes', () => {
  const original = [node('mother', null), { ...node('child', 2, 'mother'), title: 'Kidney', color: '#123abc' },
    node('grandchild', 3, 'child'), { ...node('target', null, null, 1), collapsed: true }, node('page-parent', 1, null, 2)];
  const nested = dropBookmark(original, 'mother', { id: 'target', position: 'inside' });
  assert.equal(nested.find(item => item.id === 'mother').parentId, 'target');
  assert.equal(nested.find(item => item.id === 'target').collapsed, false);
  assert.deepEqual(nested.find(item => item.id === 'child'), original.find(item => item.id === 'child'));
  assert.deepEqual(nested.find(item => item.id === 'grandchild'), original.find(item => item.id === 'grandchild'));
  const pageNested = dropBookmark(nested, 'mother', { id: 'page-parent', position: 'inside' });
  assert.equal(pageNested.find(item => item.id === 'mother').parentId, 'page-parent');
  for (const position of ['before', 'inside', 'after']) {
    assert.equal(bookmarkDropDestination(pageNested, 'mother', { id: 'grandchild', position }), null);
    assert.equal(dropBookmark(pageNested, 'mother', { id: 'grandchild', position }), pageNested);
  }
  assert.equal(dropBookmark(pageNested, 'mother', { id: 'mother', position: 'inside' }), pageNested);
  assert.equal(dropBookmark(pageNested, 'missing', { id: null, position: 'inside' }), pageNested);
  assert.equal(original.find(item => item.id === 'mother').parentId, null);
});

check('mouse before/after and root-container drops retain branch children and normalize sibling order', () => {
  const original = [node('a', null), node('b', null, null, 1), node('c', null, null, 2), node('child', 2, 'a')];
  const after = dropBookmark(original, 'a', { id: 'b', position: 'after' });
  assert.deepEqual(bookmarkChildren(after, null).map(item => item.id), ['b', 'a', 'c']);
  const before = dropBookmark(after, 'c', { id: 'b', position: 'before' });
  assert.deepEqual(bookmarkChildren(before, null).map(item => item.id), ['c', 'b', 'a']);
  const nested = dropBookmark(before, 'a', { id: 'b', position: 'inside' });
  const root = dropBookmark(nested, 'a', { id: null, position: 'inside' });
  assert.deepEqual(bookmarkChildren(root, null).map(item => item.id), ['c', 'b', 'a']);
  assert.equal(root.find(item => item.id === 'child').parentId, 'a');
  assert.deepEqual(bookmarkChildren(root, null).map(item => item.order), [0, 1, 2]);
  assert.equal(dropBookmark(root, 'a', { id: null, position: 'inside' }), root, 'Identical drop must not create a second undo step');
});

check('deleting a parent promotes immediate children at its former position', () => {
  const original = [node('before', 1), node('parent', null, null, 1), node('after', 5, null, 2), node('one', 2, 'parent'), node('two', 3, 'parent', 1), node('nested', 4, 'one')];
  const deleted = deleteBookmark(original, 'parent');
  assert.equal(deleted.length, 5);
  assert.deepEqual(bookmarkChildren(deleted, null).map(item => item.id), ['before', 'one', 'two', 'after']);
  assert.equal(deleted.find(item => item.id === 'nested').parentId, 'one');
  assert.equal(deleteBookmark(original, 'missing'), original);
  assert.equal(original.find(item => item.id === 'one').parentId, 'parent');
});

check('page assembly follows reorder, deletion and duplicate pages while retaining folders', () => {
  const original = [node('folder', null), node('removed', 1, 'folder'), node('surviving-child', 3, 'removed'), node('second', 2), node('third', 3, null, 1)];
  const mapped = remapBookmarks(original, [{ page: 3 }, { page: 2 }, { source: 0, page: 3 }, { blank: [595, 842] }, { page: 3 }]);
  assert.equal(mapped.some(item => item.id === 'removed'), false);
  assert.equal(mapped.find(item => item.id === 'folder').page, null);
  assert.equal(mapped.find(item => item.id === 'second').page, 2);
  assert.equal(mapped.find(item => item.id === 'surviving-child').parentId, 'folder');
  assert.deepEqual(mapped.filter(item => item.title === 'surviving-child').map(item => item.page), [1, 5]);
  assert.deepEqual(mapped.filter(item => item.title === 'third').map(item => item.page), [1, 5]);
  assert.equal(new Set(mapped.map(item => item.id)).size, mapped.length);
  assert.ok(!mapped.some(item => item.page === 3 || item.page === 4));
  assert.deepEqual(mapped, normalizeBookmarks(JSON.parse(JSON.stringify(mapped))));
});

await fs.mkdir('test-results', { recursive: true });
await fs.writeFile('test-results/bookmarks-results.json', JSON.stringify({ passed: true, cases: results }, null, 2));
console.log(`${results.length} bookmark model checks passed.`);
