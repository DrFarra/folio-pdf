import type { BookmarkNode } from './types';

export const DEFAULT_BOOKMARK_COLOR = '#bd4b38';
const uid = () => globalThis.crypto?.randomUUID?.() ?? `bookmark-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ordered = (nodes: BookmarkNode[]) => [...nodes].sort((a, b) => a.order - b.order);
export const bookmarkChildren = (nodes: BookmarkNode[], parentId: string | null) => ordered(nodes.filter(node => node.parentId === parentId));

function reindex(nodes: BookmarkNode[]): BookmarkNode[] {
  const groups = new Map<string | null, BookmarkNode[]>();
  for (const node of nodes) { const group = groups.get(node.parentId) || []; group.push(node); groups.set(node.parentId, group); }
  const orders = new Map<string, number>();
  for (const group of groups.values()) ordered(group).forEach((node, index) => orders.set(node.id, index));
  return nodes.map(node => ({ ...node, order: orders.get(node.id)! }));
}

function retainNodes(nodes: BookmarkNode[], retained: Set<string>): BookmarkNode[] {
  const groups = new Map<string | null, BookmarkNode[]>();
  for (const node of nodes) { const group = groups.get(node.parentId) || []; group.push(node); groups.set(node.parentId, group); }
  for (const group of groups.values()) group.sort((a, b) => a.order - b.order);
  const stack = [...(groups.get(null) || [])].reverse().map(node => ({ node, parentId: null as string | null }));
  const result: BookmarkNode[] = [], positions = new Map<string | null, number>();
  while (stack.length) {
    const { node, parentId } = stack.pop()!;
    const keep = retained.has(node.id);
    if (keep) {
      const order = positions.get(parentId) || 0; positions.set(parentId, order + 1);
      result.push({ ...node, parentId, order });
    }
    stack.push(...[...(groups.get(node.id) || [])].reverse().map(child => ({ node: child, parentId: keep ? node.id : parentId })));
  }
  return result;
}

/** Accept old page-number lists and repair malformed trees without losing valid bookmarks. */
export function normalizeBookmarks(value: unknown, maxPage = Infinity): BookmarkNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: BookmarkNode[] = [], ids = new Set<string>();
  for (const [index, entry] of value.slice(0, 10000).entries()) {
    const numeric = Number.isInteger(entry) && entry > 0;
    if (!numeric && (!entry || typeof entry !== 'object')) continue;
    const page = numeric ? entry as number : entry.page === null ? null : Number.isInteger(entry.page) && entry.page > 0 ? entry.page as number : undefined;
    if (page === undefined) continue;
    const baseId = !numeric && typeof entry.id === 'string' && entry.id.trim() ? entry.id.slice(0, 128) : `legacy-page-${page ?? 'group'}-${index}`;
    let id = baseId;
    for (let duplicate = 1; ids.has(id); duplicate++) id = `${baseId.slice(0, 110)}-${duplicate}`;
    ids.add(id);
    nodes.push({ id, page,
      title: !numeric && typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim().slice(0, 200) : page === null ? 'Grupo' : `Página ${page}`,
      parentId: !numeric && typeof entry.parentId === 'string' ? entry.parentId : null,
      color: !numeric && typeof entry.color === 'string' && /^#[0-9a-f]{6}$/i.test(entry.color) ? entry.color : DEFAULT_BOOKMARK_COLOR,
      order: !numeric && Number.isFinite(entry.order) && entry.order >= 0 ? entry.order : index,
      ...(!numeric && entry.collapsed === true ? { collapsed: true } : {}),
    });
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) if (node.parentId === node.id || node.parentId && !byId.has(node.parentId)) node.parentId = null;
  // Each node has a single parent. Mark ancestry once to break cycles in linear time.
  const complete = new Set<string>();
  for (const node of nodes) {
    const path = new Set<string>(); let current: BookmarkNode | undefined = node;
    while (current && !complete.has(current.id)) {
      path.add(current.id);
      if (current.parentId && path.has(current.parentId)) { current.parentId = null; break; }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    for (const id of path) complete.add(id);
  }
  return retainNodes(nodes, new Set(nodes.filter(node => node.page === null || node.page <= maxPage).map(node => node.id)));
}

export function hasBookmarkPage(nodes: BookmarkNode[], page: number): boolean { return nodes.some(node => node.page === page); }

export function createBookmark(nodes: BookmarkNode[], page: number | null, parentId: string | null = null): { bookmarks: BookmarkNode[]; id: string } {
  const id = uid();
  const parent = nodes.find(node => node.id === parentId);
  const parentKey = parent?.id || null;
  const node: BookmarkNode = { id, title: page === null ? 'Grupo' : `Página ${page}`, page, parentId: parentKey, color: parent?.color || DEFAULT_BOOKMARK_COLOR, order: bookmarkChildren(nodes, parentKey).length };
  return { id, bookmarks: [...nodes.map(item => item.id === parentKey ? { ...item, collapsed: false } : item), node] };
}

export function addPageBookmark(nodes: BookmarkNode[], page: number): { bookmarks: BookmarkNode[]; id: string } {
  const existing = nodes.find(node => node.page === page);
  if (!existing) return createBookmark(nodes, page);
  const ancestors = new Set<string>(); let parentId = existing.parentId;
  while (parentId) { ancestors.add(parentId); parentId = nodes.find(node => node.id === parentId)?.parentId || null; }
  return { bookmarks: nodes.map(node => ancestors.has(node.id) ? { ...node, collapsed: false } : node), id: existing.id };
}

export function bookmarkDescendants(nodes: BookmarkNode[], id: string): Set<string> {
  const groups = new Map<string | null, BookmarkNode[]>();
  for (const node of nodes) { const group = groups.get(node.parentId) || []; group.push(node); groups.set(node.parentId, group); }
  const descendants = new Set<string>(), queue = [...(groups.get(id) || [])];
  while (queue.length) { const node = queue.pop()!; if (descendants.has(node.id)) continue; descendants.add(node.id); queue.push(...(groups.get(node.id) || [])); }
  return descendants;
}

/** Move into a parent or before a sibling. Invalid moves return the original tree. */
export function moveBookmark(nodes: BookmarkNode[], id: string, parentId: string | null, beforeId?: string): BookmarkNode[] {
  const moving = nodes.find(node => node.id === id);
  if (!moving || parentId === id || parentId && (!nodes.some(node => node.id === parentId) || bookmarkDescendants(nodes, id).has(parentId))) return nodes;
  if (beforeId === id) return nodes;
  const siblings = bookmarkChildren(nodes, parentId).filter(node => node.id !== id);
  const before = beforeId ? siblings.findIndex(node => node.id === beforeId) : -1;
  if (beforeId && before < 0) return nodes;
  siblings.splice(before < 0 ? siblings.length : before, 0, { ...moving, parentId });
  const positions = new Map(siblings.map((node, index) => [node.id, index]));
  const next = reindex(nodes.map(node => node.id === id ? { ...node, parentId, order: positions.get(id)! } : positions.has(node.id) ? { ...node, order: positions.get(node.id)! } : node.id === parentId ? { ...node, collapsed: false } : node));
  return next.every((node, index) => node.parentId === nodes[index].parentId && node.order === nodes[index].order && !!node.collapsed === !!nodes[index].collapsed) ? nodes : next;
}

export type BookmarkDropPosition = 'before' | 'inside' | 'after';
export type BookmarkDropTarget = { id: string | null; position: BookmarkDropPosition };

/** Resolve one mouse drop consistently for the indicator and the actual move. A null target means root end. */
export function bookmarkDropDestination(nodes: BookmarkNode[], movingId: string, target: BookmarkDropTarget): { parentId: string | null; beforeId?: string } | null {
  if (!nodes.some(node => node.id === movingId)) return null;
  if (target.id === null) return { parentId: null };
  const row = nodes.find(node => node.id === target.id);
  if (!row || row.id === movingId) return null;
  const parentId = target.position === 'inside' ? row.id : row.parentId;
  if (parentId === movingId || parentId && bookmarkDescendants(nodes, movingId).has(parentId)) return null;
  if (target.position === 'inside') return { parentId };
  if (target.position === 'before') return { parentId, beforeId: row.id };
  const siblings = bookmarkChildren(nodes, parentId).filter(node => node.id !== movingId);
  return { parentId, beforeId: siblings[siblings.findIndex(node => node.id === row.id) + 1]?.id };
}

/** Move a whole branch while preserving every descendant, title, page and color. */
export function dropBookmark(nodes: BookmarkNode[], movingId: string, target: BookmarkDropTarget): BookmarkNode[] {
  const destination = bookmarkDropDestination(nodes, movingId, target);
  return destination ? moveBookmark(nodes, movingId, destination.parentId, destination.beforeId) : nodes;
}

export function reorderBookmark(nodes: BookmarkNode[], id: string, direction: -1 | 1): BookmarkNode[] {
  const node = nodes.find(item => item.id === id); if (!node) return nodes;
  const siblings = bookmarkChildren(nodes, node.parentId), index = siblings.findIndex(item => item.id === id), target = index + direction;
  if (target < 0 || target >= siblings.length) return nodes;
  [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
  const positions = new Map(siblings.map((item, position) => [item.id, position]));
  return nodes.map(item => positions.has(item.id) ? { ...item, order: positions.get(item.id)! } : item);
}

/** Deleting a parent promotes its children at the same position; no subtree is discarded. */
export function deleteBookmark(nodes: BookmarkNode[], id: string): BookmarkNode[] {
  const deleted = nodes.find(node => node.id === id); if (!deleted) return nodes;
  const siblings = bookmarkChildren(nodes, deleted.parentId).flatMap(node => node.id === id ? bookmarkChildren(nodes, id) : [node]);
  const positions = new Map(siblings.map((node, index) => [node.id, index]));
  return reindex(nodes.filter(node => node.id !== id).map(node => positions.has(node.id) ? { ...node, parentId: deleted.parentId, order: positions.get(node.id)! } : node));
}

/** Follow page assembly; imported/blank pages do not inherit this document's bookmarks. */
export function remapBookmarks(nodes: BookmarkNode[], plan: { page?: number; source?: number | null }[]): BookmarkNode[] {
  const pages = new Map<number, number[]>();
  plan.forEach((entry, index) => { if (entry.source == null && entry.page != null) { const matches = pages.get(entry.page) || []; matches.push(index + 1); pages.set(entry.page, matches); } });
  const retained = retainNodes(nodes, new Set(nodes.filter(node => node.page === null || pages.has(node.page)).map(node => node.id)));
  const ids = new Set(nodes.map(node => node.id));
  const mapped = retained.flatMap(node => node.page === null ? [node] : pages.get(node.page)!.map((page, index) => {
    let id = node.id;
    if (index) { const base = `${node.id}-copy-${index}`; id = base; for (let suffix = 1; ids.has(id); suffix++) id = `${base}-${suffix}`; ids.add(id); }
    return { ...node, id, page, order: node.order + index / (pages.get(node.page!)!.length + 1) };
  }));
  return reindex(mapped);
}
