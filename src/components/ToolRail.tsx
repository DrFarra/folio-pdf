import { Bookmark, CircleHelp, FolderOpen, Layers, ListTree, MessageSquare, Search, Settings } from 'lucide-react';
import IconButton from './IconButton';
import { shortcutLabel } from '../platform';
import type { SideTab } from '../types';

type Props = {
  library: boolean; hasDocument: boolean;
  /** The side panel's tab when it is open and not searching. */
  panel: SideTab | null; searching: boolean; notesOpen: boolean; annotations: number;
  /** Editar PDF covers the reader: the rail waits. */
  inert: boolean;
  onLibrary: () => void; onPanel: (tab: SideTab) => void; onNotes: () => void; onSearch: () => void;
  onSettings: () => void; onHelp: () => void;
};

/** The desktop's left rail: the library, the document's panels, settings and help. */
export default function ToolRail({ library, hasDocument, panel, searching, notesOpen, annotations, inert, ...on }: Props) {
  const panelButton = (tab: SideTab, label: string, icon: React.ReactNode) =>
    <button className={`rail-button ${panel === tab ? 'active' : ''}`} aria-label={label} aria-expanded={panel === tab} disabled={!hasDocument} onClick={() => on.onPanel(tab)}>{icon}<span>{label}</span></button>;
  return <nav className="tool-rail" aria-label="Herramientas del documento" inert={inert}>
    <div className="rail-primary">
      <button className={library ? 'rail-button active' : 'rail-button'} aria-label="Biblioteca" onClick={on.onLibrary}><FolderOpen size={21} /><span>Biblioteca</span></button>
      {panelButton('pages', 'Páginas', <Layers size={21} />)}
      <button className={`rail-button annotations-toggle ${notesOpen ? 'active' : ''}`} aria-label="Anotaciones" aria-expanded={notesOpen} disabled={!hasDocument} onClick={on.onNotes}><MessageSquare size={21} /><span>Anotaciones</span>{annotations > 0 && <span className="rail-count">{annotations}</span>}</button>
      <button className={`rail-button ${searching ? 'active' : ''}`} aria-label="Buscar en el PDF" title={`Buscar en el PDF (${shortcutLabel('F')})`} aria-expanded={searching} disabled={!hasDocument} onClick={on.onSearch}><Search size={21} /><span>Buscar</span></button>
      {panelButton('bookmarks', 'Marcadores', <Bookmark size={21} />)}
      {panelButton('outline', 'Índice', <ListTree size={21} />)}
    </div>
    <div className="rail-bottom">
      <IconButton label="Ajustes" onClick={on.onSettings}><Settings size={19} /></IconButton>
      <IconButton label="Ayuda y atajos" onClick={on.onHelp}><CircleHelp size={19} /></IconButton>
    </div>
  </nav>;
}
