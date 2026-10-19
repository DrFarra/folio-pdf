import type { ReactNode } from 'react';
import {
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Highlighter,
  Layers,
  MoreHorizontal,
  MousePointer2,
  PenLine,
  Search,
  StickyNote,
  Upload,
  X,
} from 'lucide-react';
import IconButton from './IconButton';
import type { LoadedDocument, Tool } from '../types';

type ReadingBarProps = {
  doc: LoadedDocument;
  disabled: boolean;
  page: number;
  /** «page / pages», with the printed page label when it differs. */
  counter: string;
  /** Single-page reading shows its own page buttons. */
  singlePage: boolean;
  onPage: (page: number) => void;
  onJump: () => void;
  bookmarked: boolean;
  onBookmark: () => void;
  /** While annotating, the annotation toolbar takes the bottom of the screen. */
  annotating: boolean;
  /** Search is open with its sheet closed: the bar steps through the results instead. */
  searching: boolean;
  results: number;
  result: number;
  onResult: (index: number) => void;
  onResults: () => void;
  onCloseSearch: () => void;
  onPages: () => void;
  onSearch: () => void;
  onAnnotate: () => void;
  onShare: (button: HTMLElement) => void;
};

/** The phone reader's bottom: the page and its bookmark, then reading actions or search results. */
export function PhoneReadingBar({
  doc,
  disabled,
  page,
  counter,
  singlePage,
  onPage,
  onJump,
  bookmarked,
  onBookmark,
  annotating,
  searching,
  results,
  result,
  onResult,
  ...on
}: ReadingBarProps) {
  return (
    <>
      <div className="mobile-reading-status">
        {singlePage && (
          <IconButton label="Página anterior" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>
            <ChevronLeft size={20} />
          </IconButton>
        )}
        <button
          className="mobile-page-jump"
          aria-label="Ir a página"
          title={`Página ${page} de ${doc.pdf.numPages}`}
          disabled={disabled}
          onClick={onJump}
        >
          <span>{counter}</span>
          <ChevronDown size={13} />
        </button>
        {singlePage && (
          <IconButton
            label="Página siguiente"
            disabled={disabled || page >= doc.pdf.numPages}
            onClick={() => onPage(page + 1)}
          >
            <ChevronRight size={20} />
          </IconButton>
        )}
        <IconButton
          label={bookmarked ? 'Quitar marcador de esta página' : 'Guardar marcador de esta página'}
          disabled={disabled}
          onClick={onBookmark}
          active={bookmarked}
        >
          <Bookmark size={20} fill={bookmarked ? 'currentColor' : 'none'} />
        </IconButton>
      </div>
      {!annotating &&
        (searching ? (
          <div className="mobile-search-toolbar" role="toolbar" aria-label="Resultados de búsqueda">
            <button className="mobile-search-list" aria-label="Ver resultados" onClick={on.onResults}>
              <Search size={20} />
              <span>{results ? `${result + 1} / ${results}` : 'Sin resultados'}</span>
            </button>
            <IconButton label="Resultado anterior" disabled={!results} onClick={() => onResult(result - 1)}>
              <ChevronLeft size={22} />
            </IconButton>
            <IconButton label="Resultado siguiente" disabled={!results} onClick={() => onResult(result + 1)}>
              <ChevronRight size={22} />
            </IconButton>
            <IconButton label="Cerrar búsqueda" onClick={on.onCloseSearch}>
              <X size={22} />
            </IconButton>
          </div>
        ) : (
          <nav className="mobile-reading-toolbar" aria-label="Acciones de lectura">
            <button aria-label="Páginas" disabled={disabled} onClick={on.onPages}>
              <Layers size={22} />
              <span>Páginas</span>
            </button>
            <button aria-label="Buscar" disabled={disabled} onClick={on.onSearch}>
              <Search size={22} />
              <span>Buscar</span>
            </button>
            <button aria-label="Anotar" disabled={disabled} onClick={on.onAnnotate}>
              <Highlighter size={22} />
              <span>Anotar</span>
            </button>
            <button aria-label="Compartir" disabled={disabled} onClick={event => on.onShare(event.currentTarget)}>
              <Upload size={22} />
              <span>Compartir</span>
            </button>
          </nav>
        ))}
    </>
  );
}

/** Anotar's toolbar on phones; the active tool's options keep their slot. */
export function PhoneAnnotationToolbar({
  doc,
  disabled,
  tool,
  onTool,
  onHighlight,
  settings,
  onMore,
}: {
  doc: LoadedDocument;
  disabled: boolean;
  tool: Tool;
  onTool: (tool: Tool) => void;
  onHighlight: () => void;
  settings: ReactNode;
  onMore: () => void;
}) {
  const locked = !doc.canAnnotate || disabled;
  return (
    <div className="mobile-annotation-toolbar" role="toolbar" aria-label="Herramientas de anotación">
      <IconButton label="Seleccionar texto" toggle active={tool === 'select'} onClick={() => onTool('select')}>
        <MousePointer2 size={21} />
      </IconButton>
      <IconButton
        label="Resaltador"
        toggle
        active={tool === 'highlight'}
        disabled={locked || !doc.canCopy}
        onMouseDown={event => event.preventDefault()}
        onClick={onHighlight}
      >
        <Highlighter size={21} />
      </IconButton>
      <IconButton
        label="Nota"
        toggle
        active={tool === 'note'}
        disabled={locked}
        onClick={() => onTool(tool === 'note' ? 'select' : 'note')}
      >
        <StickyNote size={21} />
      </IconButton>
      <IconButton label="Lápiz" toggle active={tool === 'draw'} disabled={locked} onClick={() => onTool('draw')}>
        <PenLine size={21} />
      </IconButton>
      <IconButton label="Goma" toggle active={tool === 'eraser'} disabled={locked} onClick={() => onTool('eraser')}>
        <Eraser size={21} />
      </IconButton>
      {settings}
      <IconButton label="Más opciones" onClick={onMore}>
        <MoreHorizontal size={22} />
      </IconButton>
    </div>
  );
}
