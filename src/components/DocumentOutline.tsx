import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ListTree } from 'lucide-react';
import type { OutlineEntry } from '../types';
import './DocumentOutline.css';

type Props = { outline: OutlineEntry[]; page: number; onNavigate: (page: number) => void };
type Node = { entry: OutlineEntry; id: string; children: Node[] };
// The tab retains its outline array, so a temporarily closed explorer does not
// reset the reader's collapsed chapters. Weak keys release closed documents.
const savedFolds = new WeakMap<OutlineEntry[], Set<string>>();

function buildTree(outline: OutlineEntry[]) {
  const roots: Node[] = [], stack: { node: Node; depth: number }[] = [];
  for (const [index, entry] of outline.entries()) {
    const depth = Math.max(0, Number.isFinite(entry.depth) ? Math.floor(entry.depth) : 0);
    const node: Node = { entry, id: `outline-${index}`, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ node, depth });
  }
  return roots;
}

export default function DocumentOutline({ outline, page, onNavigate }: Props) {
  const domId = useId();
  const tree = useMemo(() => buildTree(outline), [outline]);
  const activeIndex = useMemo(() => {
    let active = -1;
    for (let index = 0; index < outline.length; index++) {
      const destination = outline[index].page;
      if (destination != null && destination <= page && (active < 0 || destination >= (outline[active].page ?? -Infinity))) active = index;
    }
    return active;
  }, [outline, page]);
  const activeId = activeIndex < 0 ? null : `outline-${activeIndex}`;
  const activePath = useMemo(() => {
    const path = new Set<string>();
    const visit = (nodes: Node[]): boolean => nodes.some(node => {
      if (node.id === activeId || visit(node.children)) { path.add(node.id); return true; }
      return false;
    });
    visit(tree);
    return path;
  }, [tree, activeId]);
  const initialFolds = () => {
    const cached = savedFolds.get(outline);
    if (cached) return new Set(cached);
    const result = new Set<string>();
    const visit = (nodes: Node[]) => nodes.forEach(node => {
      if (node.children.length && !activePath.has(node.id)) result.add(node.id);
      visit(node.children);
    });
    visit(tree);
    return result;
  };
  const [folds, setFolds] = useState(initialFolds);
  const source = useRef(outline);
  useEffect(() => {
    if (source.current === outline) return;
    source.current = outline;
    setFolds(initialFolds());
  }, [outline]);
  const toggle = (id: string) => setFolds(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    savedFolds.set(outline, next);
    return next;
  });
  if (!outline.length) return <div className="empty-panel"><ListTree size={26} /><p>Sin índice en este PDF.</p><span>Explora sus páginas desde las miniaturas.</span></div>;
  const rows = (nodes: Node[], depth = 0) => <ul className="document-outline-list">{nodes.map(node => {
    const collapsed = folds.has(node.id), branch = node.children.length > 0;
    return <li key={node.id} className={activePath.has(node.id) ? 'outline-current-chapter' : undefined}>
      <div className={`document-outline-row${node.id === activeId ? ' selected' : ''}`} style={{ '--outline-depth': depth } as React.CSSProperties}>
        {branch ? <button className="document-outline-fold" aria-label={`${collapsed ? 'Expandir' : 'Contraer'} ${node.entry.title}`} aria-expanded={!collapsed} aria-controls={`${domId}-${node.id}-children`} onClick={() => toggle(node.id)}>{collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}</button> : <span className="document-outline-fold-space" aria-hidden="true" />}
        {node.entry.page != null || branch ? <button className="document-outline-destination" aria-current={node.id === activeId ? 'location' : undefined} aria-expanded={node.entry.page == null ? !collapsed : undefined} onClick={() => node.entry.page == null ? toggle(node.id) : onNavigate(node.entry.page)}><span>{node.entry.title}</span>{node.entry.page != null && <span className="document-outline-page">{node.entry.page}</span>}</button> : <span className="document-outline-destination"><span>{node.entry.title}</span></span>}
      </div>
      {branch && <div id={`${domId}-${node.id}-children`} hidden={collapsed}>{rows(node.children, depth + 1)}</div>}
    </li>;
  })}</ul>;
  return <nav className="document-outline" aria-label="Índice del documento">{rows(tree)}</nav>;
}
