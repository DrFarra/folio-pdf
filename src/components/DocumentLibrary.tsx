import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, ArrowRight, BookOpen, Check, ChevronRight, Cloud, FilePlus2, HelpCircle, LayoutGrid, List, MessageSquare, MoreHorizontal, Search, Settings, Star, Trash2, Upload, X } from 'lucide-react';
import type { RecentDocument } from '../types';
import { isDesktop } from '../platform';
import { formatSize, plural } from '../pdf';
import { readSession } from '../storage';
import { driveIds, favoriteIds, libraryPreference, readCover, saveLibraryPreference, setFavorite, type LibrarySort, type LibraryView } from '../library-meta';
import './DocumentLibrary.css';

export type DocumentLibraryProps = {
  documents: RecentDocument[];
  activeDocument?: { id: string; name: string; page: number; pages: number };
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
type Details = { cover?: string | null; lastPage?: number; annotations?: number };
type Filter = 'all' | 'favorites' | 'drive';
const SORTS: { id: LibrarySort; label: string }[] = [{ id: 'recent', label: 'Recientes' }, { id: 'name', label: 'Nombre' }, { id: 'progress', label: 'Progreso' }];

const relative = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
function when(time: number) {
  const seconds = (time - Date.now()) / 1000, abs = Math.abs(seconds);
  if (abs < 60) return 'ahora';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 7) return relative.format(Math.round(seconds / 86400), 'day');
  return new Date(time).toLocaleDateString('es', { day: 'numeric', month: 'short', year: new Date(time).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
const title = (name: string) => name.replace(/\.pdf$/i, '');
// Page one is where every document opens: progress starts after it.
const progress = (page: number | undefined, pages: number) => pages > 1 && page && page > 1 ? Math.min(1, Math.max(0, page / pages)) : 0;
// Covers that are not rendered yet get a tinted tile with the title, never a blank box.
function hue(text: string) { let h = 0; for (const char of text) h = (h * 31 + char.charCodeAt(0)) % 360; return h; }

function Cover({ name, image, size }: { name: string; image?: string | null; size: 'hero' | 'card' | 'row' }) {
  return <span className={`library-cover ${size}${image ? '' : ' placeholder'}`} style={image ? undefined : { '--cover-hue': hue(name) } as React.CSSProperties} aria-hidden="true">
    {image ? <img src={image} alt="" draggable={false} /> : <span>{title(name)}</span>}
  </span>;
}
function Progress({ value }: { value: number }) {
  return <span className="library-progress" aria-hidden="true"><span style={{ transform: `scaleX(${value})` }} /></span>;
}

export function DocumentLibrary(props: DocumentLibraryProps) {
  const [query, setQuery] = useState('');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [view, setView] = useState<LibraryView>(() => libraryPreference('folio.library.view', ['grid', 'list'] as const, document.documentElement.hasAttribute('data-phone') ? 'list' : 'grid'));
  const [sort, setSort] = useState<LibrarySort>(() => libraryPreference('folio.library.sort', ['recent', 'name', 'progress'] as const, 'recent'));
  const [filter, setFilter] = useState<Filter>('all');
  const [favorites, setFavorites] = useState(favoriteIds);
  const [drive] = useState(driveIds);
  const [details, setDetails] = useState<Record<string, Details>>({});
  const menuRef = useRef<HTMLDivElement>(null), sortRef = useRef<HTMLDivElement>(null);
  const id = useId();

  // Covers and reading positions load after the list, without delaying it.
  const ids = props.documents.map(document => document.id).join('|');
  useEffect(() => {
    let alive = true;
    for (const document of props.documents) {
      if (details[document.id]?.cover !== undefined) continue;
      void Promise.all([readCover(document.id), readSession(document.id).catch(() => null)]).then(([cover, session]) => {
        if (!alive) return;
        setDetails(current => ({ ...current, [document.id]: { cover, lastPage: session?.lastPage, annotations: session?.annotations?.length } }));
      });
    }
    return () => { alive = false; };
  }, [ids]);

  const active = props.activeDocument;
  const pageOf = (document: RecentDocument) => active?.id === document.id ? active.page : details[document.id]?.lastPage;
  const needle = query.trim().toLocaleLowerCase('es');
  const visible = useMemo(() => {
    const list = props.documents.filter(document => document.name.toLocaleLowerCase('es').includes(needle)
      && (filter === 'all' || filter === 'favorites' && favorites.has(document.id) || filter === 'drive' && drive.has(document.id)));
    const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
    return list.sort(sort === 'name' ? (a, b) => collator.compare(a.name, b.name)
      : sort === 'progress' ? (a, b) => progress(pageOf(b), b.pages) - progress(pageOf(a), a.pages) || b.openedAt - a.openedAt
      : (a, b) => b.openedAt - a.openedAt);
  }, [props.documents, needle, filter, favorites, drive, sort, details, active?.page]);
  // The document being read, or else the one read most recently.
  const resume = active ? props.documents.find(document => document.id === active.id) : [...props.documents].sort((a, b) => b.openedAt - a.openedAt)[0];
  const resumePage = resume ? pageOf(resume) : active?.page, resumePages = resume?.pages || active?.pages || 0;

  useEffect(() => {
    if (!openMenu && !sortOpen) return;
    if (openMenu) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !sortRef.current?.contains(event.target)) { setOpenMenu(null); setSortOpen(false); }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [openMenu, sortOpen]);
  useEffect(() => { setOpenMenu(null); }, [query, props.documents]);
  const chooseView = (next: LibraryView) => { setView(next); saveLibraryPreference('folio.library.view', next); };
  const chooseSort = (next: LibrarySort) => { setSort(next); setSortOpen(false); saveLibraryPreference('folio.library.sort', next); };
  const toggleFavorite = (documentId: string) => { setFavorites(new Set(setFavorite(documentId, !favorites.has(documentId)))); setOpenMenu(null); };
  const menuKeys = (event: React.KeyboardEvent<HTMLDivElement>, close: () => void) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"],[role="menuitemradio"]'));
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const current = items.indexOf(event.target as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  };

  const meta = (document: RecentDocument) => {
    const page = pageOf(document), notes = details[document.id]?.annotations;
    return <>
      <span className="library-meta-line">{page && page > 1 ? `Pág. ${page} de ${document.pages}` : plural(document.pages, 'página', 'páginas')}{view === 'list' && <> · {formatSize(document.size)}</>}</span>
      <span className="library-meta-line document-library-date">{when(document.openedAt)}{notes ? <><span aria-hidden="true"> · </span><MessageSquare size={12} aria-hidden="true" /><span className="sr-only">,</span> {plural(notes, 'anotación', 'anotaciones')}</> : null}</span>
    </>;
  };

  return <section className={`document-library library-${view}`} aria-label="Biblioteca" aria-busy={props.busy}>
    <header className="document-library-header">
      <div><span className="document-library-brand">Folio</span><h1>Biblioteca</h1></div>
      <div className="document-library-header-actions">
        <button type="button" aria-label="Ajustes" title="Ajustes" onClick={props.onSettings}><Settings size={21} aria-hidden="true" /></button>
        <button type="button" aria-label="Ayuda" title="Ayuda" onClick={props.onHelp}><HelpCircle size={21} aria-hidden="true" /></button>
        {props.onClose && <button type="button" aria-label="Cerrar biblioteca" onClick={props.onClose}><X size={22} aria-hidden="true" /></button>}
      </div>
    </header>
    <div className="document-library-content">
      {resume && (active ? props.onContinue : true) && <button type="button" className="document-library-continue" disabled={props.busy} onClick={() => active && props.onContinue ? props.onContinue() : props.onOpen(resume)} aria-label={`Continuar leyendo ${resume.name}${resumePage ? `, página ${resumePage}` : ''}`}>
        <Cover name={resume.name} image={details[resume.id]?.cover} size="hero" />
        <span className="library-resume-text">
          <span className="document-library-eyebrow">{active ? 'Continuar leyendo' : 'Retomar lectura'}</span>
          <strong>{title(resume.name)}</strong>
          <span className="document-library-secondary">{resumePage && resumePage > 1 ? `Página ${resumePage} de ${resumePages}` : `${plural(resumePages, 'página', 'páginas')} · Sin empezar`}</span>
          {progress(resumePage, resumePages) > 0 && <span className="library-resume-progress"><Progress value={progress(resumePage, resumePages)} /><span>{Math.round(progress(resumePage, resumePages) * 100)} %</span></span>}
        </span>
        <ChevronRight size={22} aria-hidden="true" />
      </button>}
      <div className="document-library-create-actions">
        <button type="button" className="document-library-import" disabled={props.busy} onClick={props.onImport}><Upload size={20} aria-hidden="true" /><span>Abrir PDF</span></button>
        {props.onDrive && <button type="button" className="document-library-create" disabled={props.busy} onClick={props.onDrive}><Cloud size={20} aria-hidden="true" /><span>Google Drive</span></button>}
        <button type="button" className="document-library-create" disabled={props.busy} onClick={props.onCreate}><FilePlus2 size={20} aria-hidden="true" /><span>Crear PDF</span></button>
      </div>
      {props.documents.length > 0 && <>
        <div className="library-toolbar">
          <div className="document-library-search">
            <Search size={19} aria-hidden="true" />
            <input type="search" aria-label="Buscar documentos por nombre" placeholder="Buscar" value={query} onChange={event => setQuery(event.target.value)} />
            {query && <button type="button" aria-label="Borrar búsqueda de documentos" onClick={() => setQuery('')}><X size={18} aria-hidden="true" /></button>}
          </div>
          <div className="library-sort" ref={sortRef}>
            <button type="button" className="library-tool" aria-label={`Ordenar: ${SORTS.find(item => item.id === sort)!.label}`} title="Ordenar" aria-haspopup="menu" aria-expanded={sortOpen} onClick={() => setSortOpen(value => !value)}><ArrowDownUp size={19} aria-hidden="true" /></button>
            {sortOpen && <div className="document-library-menu library-sort-menu" role="menu" aria-label="Ordenar documentos" onKeyDown={event => menuKeys(event, () => setSortOpen(false))}>
              {SORTS.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={sort === item.id} onClick={() => chooseSort(item.id)}><span>{item.label}</span>{sort === item.id && <Check size={17} aria-hidden="true" />}</button>)}
            </div>}
          </div>
          <div className="library-view-toggle" role="group" aria-label="Vista de la biblioteca">
            <button type="button" className="library-tool" aria-label="Cuadrícula" title="Cuadrícula" aria-pressed={view === 'grid'} onClick={() => chooseView('grid')}><LayoutGrid size={18} aria-hidden="true" /></button>
            <button type="button" className="library-tool" aria-label="Lista" title="Lista" aria-pressed={view === 'list'} onClick={() => chooseView('list')}><List size={19} aria-hidden="true" /></button>
          </div>
        </div>
        {(favorites.size > 0 || drive.size > 0 || filter !== 'all') && props.documents.some(document => favorites.has(document.id) || drive.has(document.id)) && <div className="library-filters" role="group" aria-label="Filtrar documentos">
          {([['all', 'Todos', props.documents.length], ['favorites', 'Favoritos', props.documents.filter(document => favorites.has(document.id)).length], ['drive', 'Google Drive', props.documents.filter(document => drive.has(document.id)).length]] as const)
            .filter(([value, , count]) => value === 'all' || count > 0 || filter === value)
            .map(([value, label, count]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'favorites' && <Star size={14} aria-hidden="true" />}{value === 'drive' && <Cloud size={14} aria-hidden="true" />}<span>{label}</span><small>{count}</small></button>)}
        </div>}
      </>}
      <div className="document-library-results">
        {props.loading && !visible.length ? <div className="document-library-empty" role="status"><p>Cargando documentos…</p></div> : visible.length > 0 ? <ul className="document-library-list" aria-label="Documentos de la biblioteca">{visible.map(document => {
          const menuId = `${id}-menu-${document.id}`, favorite = favorites.has(document.id), value = progress(pageOf(document), document.pages);
          return <li className={`document-library-row${active?.id === document.id ? ' reading' : ''}${openMenu === document.id ? ' menu-open' : ''}`} key={document.id}>
            <button type="button" className="document-library-open" disabled={props.busy} aria-label={`Abrir ${document.name}`} onClick={() => props.onOpen(document)}>
              <span className="library-cover-frame">
                <Cover name={document.name} image={details[document.id]?.cover} size={view === 'grid' ? 'card' : 'row'} />
                {(favorite || drive.has(document.id) || document.draft) && <span className="library-badges">{document.draft && <span className="library-badge draft">Sin guardar</span>}{drive.has(document.id) && <span className="library-badge icon" title="Google Drive"><Cloud size={13} aria-hidden="true" /></span>}{favorite && <span className="library-badge icon favorite" title="Favorito"><Star size={13} aria-hidden="true" /></span>}</span>}
              </span>
              <span className="document-library-file-text"><strong>{document.name}</strong>{meta(document)}{value > 0 && <span className="library-row-progress"><Progress value={value} /><span>{Math.round(value * 100)} %</span></span>}</span>
            </button>
            <div className="document-library-menu-container" ref={openMenu === document.id ? menuRef : undefined}>
              <button type="button" className="document-library-more" disabled={props.busy} aria-label={`Opciones de ${document.name}`} aria-haspopup="menu" aria-expanded={openMenu === document.id} aria-controls={openMenu === document.id ? menuId : undefined} onClick={() => setOpenMenu(current => current === document.id ? null : document.id)}><MoreHorizontal size={20} aria-hidden="true" /></button>
              {openMenu === document.id && <div className="document-library-menu" id={menuId} role="menu" aria-label={`Opciones de ${document.name}`} onKeyDown={event => menuKeys(event, () => { menuRef.current?.querySelector<HTMLButtonElement>('.document-library-more')?.focus(); setOpenMenu(null); })}>
                <button type="button" role="menuitem" onClick={() => toggleFavorite(document.id)}><Star size={18} aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} /><span>{favorite ? 'Quitar de favoritos' : 'Añadir a favoritos'}</span></button>
                <button type="button" role="menuitem" className="document-library-delete" onClick={() => { setOpenMenu(null); props.onDelete(document); }}><Trash2 size={18} aria-hidden="true" /><span>{isDesktop ? 'Quitar de la biblioteca…' : 'Eliminar de la biblioteca…'}</span></button>
              </div>}
            </div>
          </li>;
        })}</ul> : <div className="document-library-empty">
          <span className="library-empty-art" aria-hidden="true"><BookOpen size={30} /></span>
          <h2>{needle ? 'Sin resultados' : filter !== 'all' ? 'Nada por aquí' : 'Tu biblioteca está vacía'}</h2>
          <p>{needle ? 'Prueba con otro nombre.' : filter === 'favorites' ? 'Marca un documento como favorito desde sus opciones.' : filter === 'drive' ? 'Los PDF que abras desde Google Drive aparecerán aquí.' : 'Los PDF que abras aparecerán aquí, con su portada y tu progreso.'}</p>
          {(needle || filter !== 'all') && <button type="button" className="library-reset" onClick={() => { setQuery(''); setFilter('all'); }}>Ver todos los documentos</button>}
        </div>}
      </div>
      <button type="button" className="document-library-demo" disabled={props.busy} onClick={props.onDemo}><BookOpen size={21} aria-hidden="true" /><span>Abrir PDF de ejemplo</span><ArrowRight size={20} aria-hidden="true" /></button>
    </div>
  </section>;
}

export default DocumentLibrary;
