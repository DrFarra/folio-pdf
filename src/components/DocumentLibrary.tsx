import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, ChevronRight, Clock, FilePlus2, FileText, HelpCircle, MoreHorizontal, Search, Settings, Sparkles, Trash2, Upload, X } from 'lucide-react';
import type { RecentDocument } from '../types';
import './DocumentLibrary.css';

export type DocumentLibraryProps = {
  documents: RecentDocument[];
  activeDocument?: { name: string; page: number };
  busy: boolean;
  loading?: boolean;
  onOpen: (document: RecentDocument) => void;
  onImport: () => void;
  onCreate: () => void;
  onContinue?: () => void;
  onHideRecent: (document: RecentDocument) => void;
  onDelete: (document: RecentDocument) => void;
  onSettings: () => void;
  onHelp: () => void;
  onDemo: () => void;
  onClose?: () => void;
};

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('es', { maximumFractionDigits: 1 })} MB`;
}

export function DocumentLibrary(props: DocumentLibraryProps) {
  const [view, setView] = useState<'all' | 'recent'>('all');
  const [query, setQuery] = useState('');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const sorted = useMemo(() => [...props.documents].sort((a, b) => b.openedAt - a.openedAt), [props.documents]);
  const recents = useMemo(() => sorted.filter(document => !(document as RecentDocument & { hidden?: boolean }).hidden).slice(0, 20), [sorted]);
  const needle = query.trim().toLocaleLowerCase('es');
  const visible = (view === 'all' ? sorted : recents).filter(document => document.name.toLocaleLowerCase('es').includes(needle));

  useEffect(() => {
    if (!openMenu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpenMenu(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [openMenu]);
  useEffect(() => { setOpenMenu(null); }, [view, query, props.documents]);

  const selectView = (next: 'all' | 'recent') => { setView(next); setOpenMenu(null); };
  return <section className="document-library" aria-label="Biblioteca de documentos" aria-busy={props.busy}>
    <header className="document-library-header">
      <div><span className="document-library-brand">Folio</span><h1>Documentos</h1></div>
      <div className="document-library-header-actions">
        <button type="button" aria-label="Preferencias de lectura" onClick={props.onSettings}><Settings size={21} aria-hidden="true" /></button>
        <button type="button" aria-label="Ayuda" onClick={props.onHelp}><HelpCircle size={21} aria-hidden="true" /></button>
        {props.onClose && <button type="button" aria-label="Cerrar biblioteca" onClick={props.onClose}><X size={22} aria-hidden="true" /></button>}
      </div>
    </header>
    <div className="document-library-content">
      {props.activeDocument && props.onContinue && <button type="button" className="document-library-continue" disabled={props.busy} onClick={props.onContinue}>
        <BookOpen size={24} aria-hidden="true" /><span><span className="document-library-eyebrow">Continuar leyendo</span><strong>{props.activeDocument.name}</strong><span className="document-library-secondary">Página {props.activeDocument.page}</span></span><ChevronRight size={22} aria-hidden="true" />
      </button>}
      <div className="document-library-create-actions">
        <button type="button" className="document-library-import" disabled={props.busy} onClick={props.onImport}><Upload size={20} aria-hidden="true" />Importar PDF</button>
        <button type="button" className="document-library-create" disabled={props.busy} onClick={props.onCreate}><FilePlus2 size={20} aria-hidden="true" />Crear PDF</button>
      </div>
      <div className="document-library-search">
        <Search size={20} aria-hidden="true" />
        <input type="search" aria-label="Buscar documentos por nombre" placeholder="Buscar por nombre" value={query} onChange={event => setQuery(event.target.value)} />
        {query && <button type="button" aria-label="Borrar búsqueda de documentos" onClick={() => setQuery('')}><X size={18} aria-hidden="true" /></button>}
      </div>
      <div className="document-library-tabs" role="tablist" aria-label="Vista de documentos">
        {(['all', 'recent'] as const).map((tab, index) => <button type="button" key={tab} role="tab" id={`${id}-${tab}`} aria-controls={`${id}-documents`} aria-selected={view === tab} tabIndex={view === tab ? 0 : -1} ref={element => { tabRefs.current[index] = element; }} onClick={() => selectView(tab)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
          selectView(next === 0 ? 'all' : 'recent'); tabRefs.current[next]?.focus();
        }}>{tab === 'all' ? 'Todas' : 'Recientes'}<span>{tab === 'all' ? sorted.length : recents.length}</span></button>)}
      </div>
      <div className="document-library-results" role="tabpanel" id={`${id}-documents`} aria-labelledby={`${id}-${view}`}>
        {props.loading && !visible.length ? <div className="document-library-empty" role="status"><p>Cargando documentos…</p></div> : visible.length > 0 ? <ul className="document-library-list">{visible.map(document => {
          const hidden = (document as RecentDocument & { hidden?: boolean }).hidden;
          const menuId = `${id}-menu-${document.id}`;
          return <li className="document-library-row" key={document.id}>
            <button type="button" className="document-library-open" disabled={props.busy} aria-label={`Abrir ${document.name}`} onClick={() => props.onOpen(document)}>
              <span className="document-library-file-icon"><FileText size={23} aria-hidden="true" /></span>
              <span className="document-library-file-text"><strong>{document.name}</strong><span>{document.pages} {document.pages === 1 ? 'página' : 'páginas'} · {sizeLabel(document.size)}</span><span className="document-library-date">{new Date(document.openedAt).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })}</span></span>
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
                {!hidden && <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); props.onHideRecent(document); }}><Clock size={18} aria-hidden="true" /><span>Quitar de recientes</span></button>}
                <button type="button" role="menuitem" className="document-library-delete" onClick={() => { setOpenMenu(null); props.onDelete(document); }}><Trash2 size={18} aria-hidden="true" /><span>Eliminar copia local…</span></button>
              </div>}
            </div>
          </li>;
        })}</ul> : <div className="document-library-empty"><BookOpen size={30} aria-hidden="true" /><h2>{needle ? 'Sin resultados' : view === 'recent' ? 'Sin documentos recientes' : 'Tu biblioteca está lista'}</h2><p>{needle ? 'Probá con otro nombre de archivo.' : view === 'recent' ? 'Los documentos que abras aparecerán aquí. Los ocultos siguen en Todas.' : 'Importá un PDF para empezar a leerlo.'}</p></div>}
      </div>
      <button type="button" className="document-library-demo" disabled={props.busy} onClick={props.onDemo}><Sparkles size={21} aria-hidden="true" /><span>Explorar PDF de ejemplo</span><ArrowRight size={20} aria-hidden="true" /></button>
    </div>
  </section>;
}

export default DocumentLibrary;
