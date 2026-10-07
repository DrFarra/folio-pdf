import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Bookmark, Check, ChevronDown, ChevronRight, Folder, FolderPlus, GripVertical, MoreHorizontal, Move, Pencil, Plus, Trash2 } from 'lucide-react';
import type { BookmarkNode } from '../types';
import { bookmarkChildren, bookmarkDescendants, bookmarkDropDestination, createBookmark, deleteBookmark, dropBookmark, moveBookmark, reorderBookmark } from '../bookmarks';
import type { BookmarkDropTarget } from '../bookmarks';
import Modal from './Modal';
import { visibleBounds } from '../mobile';
import { haptic } from '../platform';
import './BookmarkTree.css';

type Props = {
  bookmarks: BookmarkNode[];
  /** Changes sharing a gesture form a single undo step. */
  onChange: (bookmarks: BookmarkNode[], gesture?: string) => void;
  /** Folding is view state and stays out of the undo history. */
  onFold: (bookmarks: BookmarkNode[]) => void;
  page: number;
  onGoToPage: (page: number) => void;
  disabled?: boolean;
  startEditingId?: string | null;
  onEditingComplete?: () => void;
};
type Row = { node: BookmarkNode; depth: number };
type DragGesture = { id: string; pointerId: number; startX: number; startY: number; x: number; y: number; active: boolean; source: HTMLDivElement; scroller: HTMLElement | null; scrollStart: number; cleanup: () => void };
const COLORS = [['Rojo', '#bd4b38'], ['Amarillo', '#c89728'], ['Verde', '#448764'], ['Azul', '#4579ba'], ['Violeta', '#8a64b4']] as const;

function flatten(nodes: BookmarkNode[], includeCollapsed = false, expanded = new Set<string>()): Row[] {
  const children = new Map<string | null, BookmarkNode[]>();
  for (const node of nodes) { const siblings = children.get(node.parentId) || []; siblings.push(node); children.set(node.parentId, siblings); }
  for (const siblings of children.values()) siblings.sort((a, b) => a.order - b.order);
  const rows: Row[] = [], stack: Row[] = [...(children.get(null) || [])].reverse().map(node => ({ node, depth: 0 }));
  while (stack.length) {
    const row = stack.pop()!; rows.push(row);
    if (includeCollapsed || !row.node.collapsed || expanded.has(row.node.id)) stack.push(...[...(children.get(row.node.id) || [])].reverse().map(node => ({ node, depth: row.depth + 1 })));
  }
  return rows;
}

export default function BookmarkTree({ bookmarks, onChange, onFold, page, onGoToPage, disabled = false, startEditingId, onEditingComplete }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; left: number; top: number; bottom: number; opened: number } | null>(null);
  const [menuPlace, setMenuPlace] = useState<{ menu: typeof menu; left: number; top: number } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [destination, setDestination] = useState('');
  const [beforeId, setBeforeId] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [drop, setDrop] = useState<BookmarkDropTarget | null>(null);
  const [blockedId, setBlockedId] = useState<string | null>(null);
  // Re-renders the lifted row as the finger moves; the gesture ref holds the position.
  const [, setDragLocation] = useState({ x: 0, y: 0 });
  const [expandedWhileDragging, setExpandedWhileDragging] = useState(new Set<string>());
  const tree = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), menuElement = useRef<HTMLDivElement>(null);
  const gesture = useRef<DragGesture | null>(null), dropRef = useRef<BookmarkDropTarget | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null), hoverId = useRef<string | null>(null);
  const expandedRef = useRef(new Set<string>()), suppressClick = useRef(false), rowHeights = useRef(new Map<string, number>());
  const bookmarksRef = useRef(bookmarks), changeRef = useRef(onChange), disabledRef = useRef(disabled);
  bookmarksRef.current = bookmarks; changeRef.current = onChange; disabledRef.current = disabled;
  const editing = useRef<string | null>(null);
  const editValue = useRef('');
  editing.current = editingId; editValue.current = name;
  const rows = useMemo(() => flatten(bookmarks, false, expandedWhileDragging), [bookmarks, expandedWhileDragging]);
  const allRows = useMemo(() => flatten(bookmarks, true), [bookmarks]);
  const menuNode = bookmarks.find(node => node.id === menu?.id);
  const movingNode = bookmarks.find(node => node.id === movingId);
  const excluded = useMemo(() => movingId ? new Set([movingId, ...bookmarkDescendants(bookmarks, movingId)]) : new Set<string>(), [bookmarks, movingId]);
  const tabId = rows.some(row => row.node.id === focusedId) ? focusedId : rows[0]?.node.id;

  const focusRow = (id: string) => {
    setFocusedId(id);
    requestAnimationFrame(() => tree.current?.querySelector<HTMLElement>(`[data-bookmark-id="${CSS.escape(id)}"]`)?.focus());
  };
  const beginEdit = (id: string) => {
    const node = bookmarks.find(item => item.id === id); if (!node || disabled) return;
    setMenu(null); setName(node.title); setEditingId(id); setFocusedId(id);
  };
  useEffect(() => {
    if (startEditingId && bookmarks.some(node => node.id === startEditingId) && !disabled) {
      setEditingId(startEditingId); setName(bookmarks.find(node => node.id === startEditingId)!.title); setFocusedId(startEditingId);
    }
  }, [startEditingId, disabled]);
  useEffect(() => {
    if (editingId) { input.current?.focus(); input.current?.select(); input.current?.scrollIntoView({ block: 'nearest' }); }
  }, [editingId]);
  const finishEdit = (save: boolean, restoreFocus = true) => {
    const id = editing.current; if (!id) return;
    editing.current = null;
    const title = editValue.current.trim().slice(0, 200);
    if (save && title) onChange(bookmarks.map(node => node.id === id ? { ...node, title } : node));
    setEditingId(null); onEditingComplete?.(); if (restoreFocus) focusRow(id);
  };
  // Place the menu once its real size is known: below the anchor, above it when
  // there is no room, and always inside the visible viewport.
  useLayoutEffect(() => {
    const element = menuElement.current; if (!menu || !element) return;
    const box = element.getBoundingClientRect(), bounds = visibleBounds(), below = menu.bottom + 4, above = menu.top - 4 - box.height;
    const top = below + box.height <= bounds.bottom - 8 || above < bounds.top + 8 ? below : above;
    setMenuPlace({ menu, left: Math.max(bounds.left + 8, Math.min(menu.left, bounds.right - box.width - 8)), top: Math.max(bounds.top + 8, Math.min(top, bounds.bottom - box.height - 8)) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    menuElement.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => { if (!menuElement.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenu(null); focusRow(menu.id); } };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [menu]);
  useEffect(() => { if (disabled) { setMenu(null); setMovingId(null); cancelDrag(); } }, [disabled]);
  useEffect(() => () => { gesture.current?.cleanup(); if (hoverTimer.current) clearTimeout(hoverTimer.current); document.body.classList.remove('bookmark-drag-active'); }, []);

  const toggle = (node: BookmarkNode) => onFold(bookmarks.map(item => item.id === node.id ? { ...item, collapsed: !item.collapsed } : item));
  const add = (parentId: string | null, asGroup: boolean) => {
    const next = createBookmark(bookmarks, asGroup ? null : page, parentId);
    onChange(next.bookmarks); setMenu(null); setName(next.bookmarks.find(node => node.id === next.id)!.title); setEditingId(next.id); setFocusedId(next.id);
  };
  const showMenu = (id: string, anchor: { left: number; top: number; bottom: number }) => {
    if (!disabled) setMenu({ id, opened: Date.now(), left: anchor.left, top: anchor.top, bottom: anchor.bottom });
  };
  const remove = (node: BookmarkNode) => {
    const next = deleteBookmark(bookmarks, node.id); onChange(next); setMenu(null);
    const sibling = bookmarkChildren(next, node.parentId)[0] || next.find(item => item.id === node.parentId) || next[0];
    if (sibling) focusRow(sibling.id);
  };
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>, row: Row, index: number) => {
    if (event.target instanceof HTMLInputElement || disabled) return;
    const children = bookmarkChildren(bookmarks, row.node.id);
    if (event.key === 'ArrowDown') { event.preventDefault(); if (rows[index + 1]) focusRow(rows[index + 1].node.id); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (rows[index - 1]) focusRow(rows[index - 1].node.id); }
    else if (event.key === 'Home') { event.preventDefault(); if (rows[0]) focusRow(rows[0].node.id); }
    else if (event.key === 'End') { event.preventDefault(); if (rows.at(-1)) focusRow(rows.at(-1)!.node.id); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); if (children.length) { if (row.node.collapsed) toggle(row.node); else focusRow(children[0].id); } }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); if (children.length && !row.node.collapsed) toggle(row.node); else if (row.node.parentId) focusRow(row.node.parentId); }
    else if (event.key === 'Enter') { event.preventDefault(); if (row.node.page !== null) onGoToPage(row.node.page); else if (children.length) toggle(row.node); }
    else if (event.key === 'F2') { event.preventDefault(); beginEdit(row.node.id); }
    else if (event.key === 'Delete') { event.preventDefault(); remove(row.node); }
    else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); showMenu(row.node.id, event.currentTarget.getBoundingClientRect()); }
  };
  const clearHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null; hoverId.current = null;
  };
  const updateDrop = (x: number, y: number) => {
    const active = gesture.current;
    if (!active?.active || !tree.current) return;
    const hit = document.elementFromPoint(x, y);
    const element = hit?.closest<HTMLElement>('[data-bookmark-id]');
    let target: BookmarkDropTarget | null = null;
    if (element && tree.current.contains(element)) {
      const box = element.getBoundingClientRect(), fraction = (y - box.top) / box.height;
      target = { id: element.dataset.bookmarkId!, position: fraction < .23 ? 'before' : fraction > .77 ? 'after' : 'inside' };
    } else if (hit?.closest('.bookmark-root-drop')) target = { id: null, position: 'inside' };
    // Between rows sliding aside: keep the current slot instead of flickering.
    else if (hit && tree.current.contains(hit)) return;
    const valid = target && bookmarkDropDestination(bookmarksRef.current, active.id, target);
    setBlockedId(target && !valid && target.id !== active.id ? target.id : null);
    if (!valid) target = null;
    if (dropRef.current?.id !== target?.id || dropRef.current?.position !== target?.position) {
      dropRef.current = target; setDrop(target);
    }
    const parent = target?.position === 'inside' && target.id ? bookmarksRef.current.find(node => node.id === target!.id) : undefined;
    if (parent?.collapsed && !expandedRef.current.has(parent.id) && parent.id !== hoverId.current) {
      clearHover(); hoverId.current = parent.id;
      hoverTimer.current = setTimeout(() => {
        expandedRef.current = new Set([...expandedRef.current, parent.id]); setExpandedWhileDragging(expandedRef.current);
        hoverTimer.current = null;
      }, 600);
    } else if (!parent || !parent.collapsed) clearHover();
  };
  const cancelDrag = (keepClickSuppressed = false) => {
    const active = gesture.current;
    gesture.current = null; active?.cleanup(); clearHover();
    document.body.classList.remove('bookmark-drag-active');
    setDraggingId(null); setDrop(null); dropRef.current = null; setBlockedId(null);
    expandedRef.current = new Set(); setExpandedWhileDragging(expandedRef.current);
    if (!keepClickSuppressed) suppressClick.current = false;
  };
  const beginDrag = (event: React.PointerEvent<HTMLDivElement>, node: BookmarkNode) => {
    if (disabled || event.button !== 0 || event.pointerType === 'touch' && !(event.target as Element).closest('.bookmark-drag-handle') || editingId === node.id ||
        (event.target as Element).closest('input, .bookmark-options')) return;
    if (gesture.current) cancelDrag();
    let scrollFrame = 0;
    const source = event.currentTarget;
    const active: DragGesture = { id: node.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, active: false, source, scroller: null, scrollStart: 0, cleanup: () => {} };
    gesture.current = active;
    const autoScroll = () => {
      if (gesture.current !== active || !active.active) return;
      const container = active.scroller;
      if (container) {
        const box = container.getBoundingClientRect();
        if (active.x >= box.left && active.x <= box.right && active.y >= box.top && active.y <= box.bottom) {
          const speed = active.y < box.top + 32 ? -10 : active.y > box.bottom - 32 ? 10 : 0;
          if (speed) { container.scrollTop += speed; updateDrop(active.x, active.y); setDragLocation({ x: active.x, y: active.y }); }
        }
      }
      scrollFrame = requestAnimationFrame(autoScroll);
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== active.pointerId || disabledRef.current) return;
      active.x = pointer.clientX; active.y = pointer.clientY;
      if (!active.active) {
        if (Math.hypot(pointer.clientX - active.startX, pointer.clientY - active.startY) < 5) return;
        active.active = true; suppressClick.current = true;
        let container: HTMLElement | null = tree.current?.parentElement || null;
        while (container && !(container.scrollHeight > container.clientHeight && /auto|scroll/.test(getComputedStyle(container).overflowY))) container = container.parentElement;
        active.scroller = container; active.scrollStart = container?.scrollTop || 0;
        measureRows();
        source.setPointerCapture?.(active.pointerId); document.getSelection()?.removeAllRanges();
        document.body.classList.add('bookmark-drag-active'); setDraggingId(node.id); setMenu(null); haptic('medium');
        scrollFrame = requestAnimationFrame(autoScroll);
      }
      pointer.preventDefault(); setDragLocation({ x: pointer.clientX, y: pointer.clientY }); updateDrop(pointer.clientX, pointer.clientY);
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== active.pointerId) return;
      if (active.active) {
        pointer.preventDefault(); updateDrop(pointer.clientX, pointer.clientY);
        const current = bookmarksRef.current;
        const next = !disabledRef.current && dropRef.current ? dropBookmark(current, active.id, dropRef.current) : current;
        if (next !== current) { changeRef.current(next); haptic('light'); }
        setTimeout(() => { suppressClick.current = false; }, 0);
      }
      cancelDrag(active.active);
      if (active.active) focusRow(active.id);
    };
    const cancel = (pointer: PointerEvent) => { if (pointer.pointerId === active.pointerId) { cancelDrag(); suppressClick.current = false; } };
    const escape = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      // The release that follows a cancelled drag is not a click on the row under it.
      const dragged = active.active; cancelDrag(dragged); focusRow(active.id);
      if (dragged) window.addEventListener('pointerup', () => setTimeout(() => { suppressClick.current = false; }, 0), { once: true });
    };
    active.cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', escape);
      cancelAnimationFrame(scrollFrame); if (source.hasPointerCapture?.(active.pointerId)) source.releasePointerCapture(active.pointerId);
    };
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', escape);
  };
  // Row slots are measured untransformed so the rows sliding aside never feed back into their size.
  function measureRows() {
    tree.current?.querySelectorAll<HTMLElement>('[data-bookmark-id]').forEach(row => rowHeights.current.set(row.dataset.bookmarkId!, row.offsetHeight + 2));
  }
  useLayoutEffect(() => { if (draggingId) measureRows(); }, [draggingId, rows]);
  // While dragging, the row (with its open children) follows the finger and the
  // rows between its old and new slot slide aside to open the gap where it lands.
  const lifted = new Set<string>(), shifted = new Map<string, number>();
  let liftedOffset = 0;
  const dragged = draggingId && gesture.current?.active ? rows.findIndex(row => row.node.id === draggingId) : -1;
  if (dragged >= 0) {
    let last = dragged;
    while (last + 1 < rows.length && rows[last + 1].depth > rows[dragged].depth) last++;
    let block = 0;
    for (let i = dragged; i <= last; i++) { lifted.add(rows[i].node.id); block += rowHeights.current.get(rows[i].node.id) ?? 37; }
    let slot = -1;
    if (drop?.id === null) slot = rows.length;
    else if (drop && drop.position !== 'inside') {
      const target = rows.findIndex(row => row.node.id === drop.id);
      if (target >= 0) {
        slot = target;
        if (drop.position === 'after') { slot = target + 1; while (slot < rows.length && rows[slot].depth > rows[target].depth) slot++; }
      }
    }
    if (slot > last + 1) for (let i = last + 1; i < slot; i++) shifted.set(rows[i].node.id, -block);
    else if (slot >= 0 && slot < dragged) for (let i = slot; i < dragged; i++) shifted.set(rows[i].node.id, block);
    const active = gesture.current!;
    liftedOffset = active.y - active.startY + ((active.scroller?.scrollTop || 0) - active.scrollStart);
  }
  const targetNode = bookmarks.find(node => node.id === drop?.id);
  const dropHint = blockedId ? 'No se puede mover un grupo dentro de sí mismo.' : drop?.id === null ? 'Al final del nivel principal' : targetNode ? `${drop?.position === 'inside' ? 'Dentro de' : drop?.position === 'before' ? 'Antes de' : 'Después de'} ${targetNode.title}` : 'Arrastra a un grupo o entre marcadores';

  return <div className={`bookmark-panel${draggingId ? ' is-dragging' : ''}`} onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }} onDragStart={event => event.preventDefault()} onDragEnter={event => { if (!event.dataTransfer.types.includes('Files')) event.stopPropagation(); }} onDragLeave={event => { if (!event.dataTransfer.types.includes('Files')) event.stopPropagation(); }}>
    <div className="bookmark-panel-actions"><button className="bookmark-new-group" aria-label="Crear grupo de marcadores" onClick={() => add(null, true)} disabled={disabled}><FolderPlus size={15} /><span>Nuevo grupo</span></button></div>
    {!bookmarks.length && <div className="empty-panel"><Bookmark size={26} /><p>Sin marcadores.</p><span>{document.documentElement.dataset.layout === 'phone' ? 'Toca el marcador junto al número de página para guardar esta página.' : document.documentElement.dataset.layout === 'tablet' ? 'Usa Guardar marcador en Más acciones para guardar esta página.' : 'Guarda la página actual con el marcador de la barra de herramientas.'}</span></div>}
    <div className={`bookmark-tree${dragged >= 0 ? ' is-sorting' : ''}`} role="tree" aria-label="Árbol de marcadores" ref={tree}>
      {rows.map((row, index) => {
        const { node, depth } = row, hasChildren = bookmarks.some(item => item.parentId === node.id);
        return <div key={node.id} className={`bookmark-entry ${node.page === page ? 'selected' : ''} ${drop?.id === node.id ? `drop-${drop.position}` : ''} ${blockedId === node.id ? 'drop-blocked' : ''} ${draggingId === node.id ? 'dragging' : ''} ${lifted.has(node.id) ? 'lifted' : ''}`} data-bookmark-id={node.id} role="treeitem" aria-label={node.page === null ? node.title : `${node.title}, página ${node.page}`} aria-level={depth + 1} aria-expanded={hasChildren ? !node.collapsed || expandedWhileDragging.has(node.id) : undefined} aria-selected={node.page === page} tabIndex={disabled ? -1 : node.id === tabId ? 0 : -1} style={{ '--bookmark-depth': Math.min(depth, 10), '--bookmark-color': node.color, transform: lifted.has(node.id) ? `translate3d(0, ${liftedOffset}px, 0)${node.id === draggingId ? ' scale(1.02)' : ''}` : shifted.has(node.id) ? `translate3d(0, ${shifted.get(node.id)}px, 0)` : undefined } as React.CSSProperties} onFocus={() => setFocusedId(node.id)} onKeyDown={event => keyDown(event, row, index)} onContextMenu={event => { event.preventDefault(); showMenu(node.id, { left: event.clientX, top: event.clientY, bottom: event.clientY }); }} draggable={false} onPointerDown={event => beginDrag(event, node)}>
          {hasChildren ? <button className="bookmark-fold" tabIndex={-1} aria-label={`${node.collapsed && !expandedWhileDragging.has(node.id) ? 'Expandir' : 'Contraer'} ${node.title}`} onClick={() => toggle(node)} disabled={disabled}>{node.collapsed && !expandedWhileDragging.has(node.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button> : <span className="bookmark-fold-space" />}
          {node.page === null ? <Folder size={14} className="bookmark-symbol" /> : <Bookmark size={13} className="bookmark-symbol" fill="currentColor" />}
          {editingId === node.id ? <input ref={input} className="bookmark-name-input" aria-label="Nombre del marcador" value={name} maxLength={200} onChange={event => setName(event.target.value)} onBlur={() => finishEdit(true, false)} onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishEdit(event.key === 'Enter'); } }} disabled={disabled} /> : <button className="bookmark-label" tabIndex={-1} title={node.page === null ? node.title : `${node.title} · Página ${node.page}`} onDoubleClick={() => beginEdit(node.id)} onClick={() => { setFocusedId(node.id); if (node.page !== null) onGoToPage(node.page); else if (hasChildren) toggle(node); }} disabled={disabled}>{node.title}</button>}
          {node.page !== null && <span className="bookmark-page">{node.page}</span>}
          <button className="bookmark-drag-handle" tabIndex={-1} aria-label={`Arrastrar ${node.title}`} disabled={disabled || editingId === node.id} onClick={event => { event.preventDefault(); event.stopPropagation(); }}><GripVertical size={18} /></button>
          <button className="bookmark-options" tabIndex={-1} aria-label={`Opciones de ${node.title}`} aria-haspopup="menu" aria-expanded={menu?.id === node.id} onClick={event => showMenu(node.id, event.currentTarget.getBoundingClientRect())} disabled={disabled}><MoreHorizontal size={16} /></button>
        </div>;
      })}
      {draggingId && <div className={`bookmark-root-drop${drop?.id === null ? ' active' : ''}`} aria-label="Soltar en nivel principal">Nivel principal</div>}
    </div>
    {draggingId && <div className="bookmark-drop-hint" role="status" aria-live="polite">{dropHint}</div>}
    {menu && menuNode && createPortal(<div className="bookmark-menu" ref={menuElement} role="menu" aria-label={`Opciones de ${menuNode.title}`} style={menuPlace?.menu === menu ? { left: menuPlace.left, top: menuPlace.top } : { left: menu.left, top: menu.bottom + 4 }} onKeyDown={event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[target]?.focus();
    }}>
      <button role="menuitem" onClick={() => beginEdit(menuNode.id)}><Pencil size={14} />Renombrar</button>
      <button role="menuitem" onClick={() => add(menuNode.id, false)}><Plus size={14} />Añadir página actual dentro</button>
      <button role="menuitem" onClick={() => add(menuNode.id, true)}><FolderPlus size={14} />Añadir grupo dentro</button>
      <div className="bookmark-menu-divider" />
      <button role="menuitem" onClick={() => { setMovingId(menuNode.id); setDestination(menuNode.parentId || ''); setBeforeId(''); setMenu(null); }}><Move size={14} />Mover…</button>
      <button role="menuitem" disabled={bookmarkChildren(bookmarks, menuNode.parentId)[0]?.id === menuNode.id} onClick={() => { onChange(reorderBookmark(bookmarks, menuNode.id, -1)); setMenu(null); focusRow(menuNode.id); }}><ArrowUp size={14} />Subir</button>
      <button role="menuitem" disabled={bookmarkChildren(bookmarks, menuNode.parentId).at(-1)?.id === menuNode.id} onClick={() => { onChange(reorderBookmark(bookmarks, menuNode.id, 1)); setMenu(null); focusRow(menuNode.id); }}><ArrowDown size={14} />Bajar</button>
      <div className="bookmark-menu-divider" />
      <div className="bookmark-color-options" role="group" aria-label="Color del marcador">{COLORS.map(([label, color]) => <button key={label} role="menuitem" aria-label={`Color ${label}`} title={label} style={{ background: color }} onClick={() => onChange(bookmarks.map(node => node.id === menuNode.id ? { ...node, color } : node))}>{menuNode.color.toLowerCase() === color && <Check size={13} />}</button>)}<input type="color" aria-label="Color personalizado del marcador" title="Color personalizado" value={menuNode.color} onChange={event => onChange(bookmarks.map(node => node.id === menuNode.id ? { ...node, color: event.target.value } : node), `color:${menu.id}:${menu.opened}`)} /></div>
      <div className="bookmark-menu-divider" />
      <button role="menuitem" className="bookmark-delete" onClick={() => remove(menuNode)}><Trash2 size={14} />{bookmarks.some(node => node.parentId === menuNode.id) ? 'Eliminar y conservar hijos' : 'Eliminar'}</button>
    </div>, document.body)}
    {movingNode && <Modal title="Mover marcador" onClose={() => setMovingId(null)} className="bookmark-move-modal"><p className="bookmark-moving-title">{movingNode.title}</p><label>Dentro de<select aria-label="Dentro de" value={destination} onChange={event => { setDestination(event.target.value); setBeforeId(''); }}><option value="">Nivel principal</option>{allRows.filter(row => !excluded.has(row.node.id)).map(row => <option key={row.node.id} value={row.node.id}>{`${'— '.repeat(Math.min(row.depth, 10))}${row.node.title}`}</option>)}</select></label><label>Posición<select aria-label="Posición del marcador" value={beforeId} onChange={event => setBeforeId(event.target.value)}><option value="">Al final</option>{bookmarkChildren(bookmarks, destination || null).filter(node => node.id !== movingId).map(node => <option key={node.id} value={node.id}>Antes de {node.title}</option>)}</select></label><div className="modal-actions"><button className="secondary-button" onClick={() => setMovingId(null)}>Cancelar</button><button className="primary-button" onClick={() => { onChange(moveBookmark(bookmarks, movingNode.id, destination || null, beforeId || undefined)); setMovingId(null); focusRow(movingNode.id); }}>Mover</button></div></Modal>}
  </div>;
}
