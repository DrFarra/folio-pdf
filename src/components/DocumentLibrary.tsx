import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, ChevronRight, FilePlus2, FileText, FolderOpen, HelpCircle, MoreHorizontal, Search, Settings, Trash2, Upload, X } from 'lucide-react';
import type { RecentDocument } from '../types';
import { isDesktop } from '../platform';
import { formatSize, plural } from '../pdf';
import './DocumentLibrary.css';

export type DocumentLibraryProps = {
  documents: RecentDocument[];
  activeDocument?: { name: string; page: number };
  busy: boolean;
  loading?: boolean;
  onOpen: (document: RecentDocument) => void;
  onImport: () => void;
  onCreate: () => void;
  onDrive?: () => void;
  onContinue?: () => void;
  onDelete: (document: RecentDocument) => void;
  onSettings: () => void;
  onHelp: () => void;
  onDemo: () => void;
  onClose?: () => void;
};

// A single list, most recently used first, filtered by name.
export function DocumentLibrary(props: DocumentLibraryProps) {
  const [query, setQuery] = useState('');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const sorted = useMemo(() => [...props.documents].sort((a, b) => b.openedAt - a.openedAt), [props.documents]);
  const needle = query.trim().toLocaleLowerCase('es');
  const visible = sorted.filter(document => document.name.toLocaleLowerCase('es').includes(needle));

  useEffect(() => {
    if (!openMenu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpenMenu(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [openMenu]);
  useEffect(() => { setOpenMenu(null); }, [query, props.documents]);

  return <section className="document-library" aria-label="Biblioteca" aria-busy={props.busy}>
    <header className="document-library-header">
      <div><span className="document-library-brand">Folio</span><h1>Biblioteca</h1></div>
      <div className="document-library-header-actions">
        <button type="button" aria-label="Ajustes" onClick={props.onSettings}><Settings size={21} aria-hidden="true" /></button>
        <button type="button" aria-label="Ayuda" onClick={props.onHelp}><HelpCircle size={21} aria-hidden="true" /></button>
        {props.onClose && <button type="button" aria-label="Cerrar biblioteca" onClick={props.onClose}><X size={22} aria-hidden="true" /></button>}
      </div>
    </header>
    <div className="document-library-content">
      {props.activeDocument && props.onContinue && <button type="button" className="document-library-continue" disabled={props.busy} onClick={props.onContinue}>
        <BookOpen size={24} aria-hidden="true" /><span><span className="document-library-eyebrow">Continuar leyendo</span><strong>{props.activeDocument.name}</strong><span className="document-library-secondary">Página {props.activeDocument.page}</span></span><ChevronRight size={22} aria-hidden="true" />
      </button>}
      <div className="document-library-create-actions">
        <button type="button" className="document-library-import" disabled={props.busy} onClick={props.onImport}><Upload size={20} aria-hidden="true" />Abrir PDF</button>
        <button type="button" className="document-library-create" disabled={props.busy} onClick={props.onCreate}><FilePlus2 size={20} aria-hidden="true" />Crear PDF</button>
        {props.onDrive && <button type="button" className="document-library-create" disabled={props.busy} onClick={props.onDrive}><FolderOpen size={20} aria-hidden="true" />Google Drive</button>}
      </div>
      <div className="document-library-search">
        <Search size={20} aria-hidden="true" />
        <input type="search" aria-label="Buscar documentos por nombre" placeholder="Buscar por nombre" value={query} onChange={event => setQuery(event.target.value)} />
        {query && <button type="button" aria-label="Borrar búsqueda de documentos" onClick={() => setQuery('')}><X size={18} aria-hidden="true" /></button>}
      </div>
      <div className="document-library-results">
        {props.loading && !visible.length ? <div className="document-library-empty" role="status"><p>Cargando documentos…</p></div> : visible.length > 0 ? <ul className="document-library-list" aria-label="Documentos de la biblioteca">{visible.map(document => {
          const menuId = `${id}-menu-${document.id}`;
          return <li className="document-library-row" key={document.id}>
            <button type="button" className="document-library-open" disabled={props.busy} aria-label={`Abrir ${document.name}`} onClick={() => props.onOpen(document)}>
              <span className="document-library-file-icon"><FileText size={23} aria-hidden="true" /></span>
              <span className="document-library-file-text"><strong>{document.name}</strong><span>{plural(document.pages, 'página', 'páginas')} · {formatSize(document.size)}</span><span className="document-library-date">{new Date(document.openedAt).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })}</span></span>
            </button>
            <div className="document-library-menu-container" ref={openMenu === document.id ? menuRef : undefined}>
              <button type="button" className="document-library-more" disabled={props.busy} aria-label={`Opciones de ${document.name}`} aria-haspopup="menu" aria-expanded={openMenu === document.id} aria-controls={openMenu === document.id ? menuId : undefined} onClick={() => setOpenMenu(current => current === document.id ? null : document.id)}><MoreHorizontal size={22} aria-hidden="true" /></button>
              {openMenu === document.id && <div className="document-library-menu" id={menuId} role="menu" aria-label={`Opciones de ${document.name}`} onKeyDown={event => {
                const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menuRef.current?.querySelector<HTMLButtonElement>('.document-library-more')?.focus(); setOpenMenu(null); }
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault(); const current = items.indexOf(event.target as HTMLButtonElement);
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                  items[next]?.focus();
                }
              }}>
                <button type="button" role="menuitem" className="document-library-delete" onClick={() => { setOpenMenu(null); props.onDelete(document); }}><Trash2 size={18} aria-hidden="true" /><span>{isDesktop ? 'Quitar de la biblioteca…' : 'Eliminar de la biblioteca…'}</span></button>
              </div>}
            </div>
          </li>;
        })}</ul> : <div className="document-library-empty"><BookOpen size={30} aria-hidden="true" /><h2>{needle ? 'Sin resultados' : 'Aún no hay documentos'}</h2><p>{needle ? 'Prueba con otro nombre.' : 'Abre un PDF o crea uno nuevo.'}</p></div>}
      </div>
      <button type="button" className="document-library-demo" disabled={props.busy} onClick={props.onDemo}><BookOpen size={21} aria-hidden="true" /><span>Abrir PDF de ejemplo</span><ArrowRight size={20} aria-hidden="true" /></button>
    </div>
  </section>;
}

export default DocumentLibrary;
