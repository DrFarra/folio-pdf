import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, Search } from 'lucide-react';
import { normalize } from '../pdf';
import './CommandPalette.css';

export type Command = { id: string; title: string; group: string; hint?: string; keywords?: string; icon?: React.ReactNode; run: () => void };

/** Rank: every query word must appear; titles that start with it come first. */
function score(command: Command, words: string[]) {
  const title = normalize(command.title), haystack = `${title} ${normalize(command.keywords || '')} ${normalize(command.group)}`;
  let total = 0;
  for (const word of words) {
    const at = haystack.indexOf(word); if (at < 0) return -1;
    total += title.startsWith(word) ? 0 : title.includes(` ${word}`) ? 1 : at < title.length ? 2 : 4;
  }
  return total;
}

/** ⌘K / Ctrl+K: one search box for every action, page, outline section and
 * recent document. Typing a number offers that page. */
export function CommandPalette({ commands, onClose, pageCommand }: { commands: Command[]; onClose: () => void; pageCommand?: (page: number) => Command | null }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const results = useMemo(() => {
    const words = normalize(query.trim()).split(/\s+/).filter(Boolean);
    const page = /^\d+$/.test(query.trim()) ? pageCommand?.(Number(query.trim())) : null;
    const ranked = words.length ? commands.map(command => ({ command, rank: score(command, words) })).filter(item => item.rank >= 0).sort((a, b) => a.rank - b.rank).map(item => item.command) : commands;
    return [...(page ? [page] : []), ...ranked].slice(0, 60);
  }, [query, commands]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    const node = dialog.current; node?.showModal(); input.current?.focus();
    return () => node?.close();
  }, []);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const run = (command: Command | undefined) => { if (!command) return; onClose(); requestAnimationFrame(() => command.run()); };
  // Results show under their group heading in the order ranked.
  let lastGroup = '';
  return createPortal(<dialog ref={dialog} className="command-palette" aria-label="Paleta de comandos" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="command-search">
      <Search size={18} aria-hidden="true" />
      <input ref={input} role="combobox" aria-expanded="true" aria-controls={id} aria-activedescendant={results[active] ? `${id}-${active}` : undefined} aria-label="Buscar comandos, páginas y documentos" placeholder="Buscar acciones, páginas, capítulos o documentos…" value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(results.length - 1, index + 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
          else if (event.key === 'Enter') { event.preventDefault(); run(results[active]); }
        }} />
      <kbd>Esc</kbd>
    </div>
    <div ref={list} className="command-results" role="listbox" id={id} aria-label="Resultados">
      {results.length ? results.map((command, index) => {
        const heading = command.group !== lastGroup ? command.group : null; lastGroup = command.group;
        return <div key={`${command.group}-${command.id}`} role="presentation">
          {heading && <div className="command-group" role="presentation">{heading}</div>}
          <div id={`${id}-${index}`} data-index={index} role="option" aria-selected={index === active} className="command-item" onPointerMove={() => setActive(index)} onClick={() => run(command)}>
            <span className="command-icon" aria-hidden="true">{command.icon}</span>
            <span className="command-title">{command.title}</span>
            {command.hint && <kbd>{command.hint}</kbd>}
            {index === active && <CornerDownLeft className="command-enter" size={15} aria-hidden="true" />}
          </div>
        </div>;
      }) : <p className="command-empty">Nada coincide con «{query}».</p>}
    </div>
    <footer className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> elegir</span><span><kbd>↵</kbd> abrir</span><span>Escribe un número para ir a esa página</span></footer>
  </dialog>, document.body);
}
