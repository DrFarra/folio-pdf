import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  BookOpen,
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eraser,
  FileText,
  Highlighter,
  Minus,
  MoreHorizontal,
  MousePointer2,
  PenLine,
  Plus,
  Redo2,
  Search,
  StickyNote,
  Undo2,
} from 'lucide-react';
import IconButton from './IconButton';
import { MAX_ZOOM, redoShortcut } from '../app/model';
import { isNativePdfDocument } from '../nativePdf';
import { shortcutLabel } from '../platform';
import type { LoadedDocument, Tool } from '../types';

const zoomSteps = [50, 75, 100, 125, 150, 200, 300, 400, 600, 800];

export type ReaderMode = 'read' | 'annotate' | 'edit';

type ModeProps = {
  doc: LoadedDocument | null;
  idle: boolean;
  mode: ReaderMode;
  onRead: () => void;
  onAnnotate: () => void;
  onEdit: () => void;
};

/** Leer, Anotar and Editar: three views of the same document, centred in the desktop header. */
export function ModeSwitch({ doc, idle, mode, ...on }: ModeProps) {
  return (
    <div className="desktop-mode-switch" role="group" aria-label="Modo del documento">
      <button aria-label="Modo lectura" aria-pressed={mode === 'read'} disabled={!idle} onClick={on.onRead}>
        <BookOpen size={16} />
        <span>Leer</span>
      </button>
      <button aria-label="Anotar documento" aria-pressed={mode === 'annotate'} disabled={!idle} onClick={on.onAnnotate}>
        <Highlighter size={16} />
        <span>Anotar</span>
      </button>
      <button
        aria-label="Editar contenido del PDF"
        aria-pressed={mode === 'edit'}
        disabled={!idle || !doc?.canEdit || !doc.canCopy || isNativePdfDocument(doc.pdf)}
        onClick={on.onEdit}
      >
        <FileText size={16} />
        <span>Editar</span>
      </button>
    </div>
  );
}

type ActionProps = {
  doc: LoadedDocument | null;
  idle: boolean;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onPalette: () => void;
  saveLabel: string;
  unsaved: boolean;
  onSave: () => void;
  onMore: () => void;
};

/** The desktop header's right side: the command palette, history, save and more. */
export function HeaderActions({ doc, idle, busy, saveLabel, ...on }: ActionProps) {
  return (
    <div className="header-document-actions">
      <button className="palette-button" aria-label="Buscar o hacer algo" onClick={on.onPalette}>
        <Search size={15} />
        <span>Buscar o hacer algo…</span>
        <kbd>{shortcutLabel('K')}</kbd>
      </button>
      <div className="undo-group">
        <IconButton label={`Deshacer (${shortcutLabel('Z')})`} onClick={on.onUndo} disabled={busy || !on.canUndo}>
          <Undo2 size={17} />
        </IconButton>
        <IconButton label={`Rehacer (${redoShortcut})`} onClick={on.onRedo} disabled={busy || !on.canRedo}>
          <Redo2 size={17} />
        </IconButton>
      </div>
      <button
        className={`download-button${on.unsaved ? ' pending' : ''}`}
        aria-label={saveLabel}
        title={`${saveLabel} (${shortcutLabel('S')})`}
        onClick={on.onSave}
        disabled={!idle}
      >
        <ArrowDownToLine size={16} />
        <span>{doc?.drive ? 'Guardar' : saveLabel}</span>
      </button>
      <IconButton label="Más acciones del documento" disabled={!idle} onClick={on.onMore}>
        <MoreHorizontal size={20} />
      </IconButton>
    </div>
  );
}

type Props = {
  doc: LoadedDocument | null;
  idle: boolean;
  /** The page number field holds what is typed until it is committed (Enter or leaving it). */
  page: number;
  pageInput: string;
  onPageInput: (value: string) => void;
  onPageCommit: () => void;
  onPageBlur: () => void;
  onPage: (page: number) => void;
  zoomMode: string;
  scale: number;
  onZoom: (delta: number) => void;
  /** 'page', 'width' or a percentage. */
  onZoomChoice: (value: string) => void;
  bookmarked: boolean;
  onBookmark: () => void;
  /** Stays on screen; otherwise it hides while reading until the pointer nears it. */
  pinned: boolean;
};

/** The desktop reader's floating bar over the pages: page, zoom and this page's bookmark. */
export function ReaderToolbar({ doc, idle, page, scale, zoomMode, bookmarked, pinned, ...on }: Props) {
  const percent = Math.round(scale * 100);
  const bar = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  // Out of the way while reading: it hides soon after the pointer leaves its area, and comes
  // back as the pointer nears it or the keyboard reaches it.
  useEffect(() => {
    if (pinned) {
      setHidden(false);
      return;
    }
    let timer = 0;
    const hideSoon = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setHidden(true), 1500);
    };
    const near = (event: PointerEvent) => {
      const box = bar.current?.getBoundingClientRect();
      if (!box || event.pointerType === 'touch') return;
      const close =
        event.clientX > box.left - 80 &&
        event.clientX < box.right + 80 &&
        event.clientY > box.top - 90 &&
        event.clientY < box.bottom + 40;
      if (close || bar.current?.contains(document.activeElement)) {
        clearTimeout(timer);
        setHidden(false);
      } else hideSoon();
    };
    hideSoon();
    window.addEventListener('pointermove', near);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', near);
    };
  }, [pinned]);
  return (
    <div
      ref={bar}
      className="reader-toolbar"
      role="toolbar"
      aria-label="Página y zoom"
      data-hidden={hidden || undefined}
      onFocus={() => setHidden(false)}
    >
      <div className="page-controls">
        <IconButton label="Página anterior" onClick={() => on.onPage(page - 1)} disabled={!doc || page <= 1}>
          <ChevronLeft size={17} />
        </IconButton>
        <form
          onSubmit={e => {
            e.preventDefault();
            on.onPageCommit();
          }}
        >
          <input
            aria-label="Número de página"
            type="text"
            inputMode="numeric"
            value={on.pageInput}
            onChange={e => on.onPageInput(e.target.value.replace(/\D/g, ''))}
            onBlur={on.onPageBlur}
          />
          <span>/ {doc?.pdf.numPages || '—'}</span>
        </form>
        <IconButton
          label="Página siguiente"
          onClick={() => on.onPage(page + 1)}
          disabled={!doc || page >= doc.pdf.numPages}
        >
          <ChevronRight size={17} />
        </IconButton>
      </div>
      <span className="toolbar-divider" />
      <div className="zoom-controls">
        <IconButton label="Reducir zoom" onClick={() => on.onZoom(-0.1)} disabled={!doc || scale <= 0.25}>
          <Minus size={16} />
        </IconButton>
        <div className="zoom-select">
          <select
            aria-label="Nivel de zoom"
            value={zoomMode === 'custom' ? String(percent) : zoomMode}
            onChange={e => on.onZoomChoice(e.target.value)}
            disabled={!doc}
          >
            <option value="page">Ajustar página</option>
            <option value="width">Ajustar ancho</option>
            {!zoomSteps.includes(percent) && zoomMode === 'custom' && (
              <option value={String(percent)}>{percent} %</option>
            )}
            {zoomSteps.map(n => (
              <option key={n} value={n}>
                {n} %
              </option>
            ))}
          </select>
          <ChevronDown size={12} />
        </div>
        <IconButton label="Ampliar zoom" onClick={() => on.onZoom(0.1)} disabled={!doc || scale >= MAX_ZOOM}>
          <Plus size={16} />
        </IconButton>
      </div>
      <span className="toolbar-divider" />
      <IconButton
        label={bookmarked ? 'Editar marcador de esta página' : 'Guardar marcador de esta página'}
        disabled={!idle}
        onClick={on.onBookmark}
        active={bookmarked}
      >
        <Bookmark size={17} fill={bookmarked ? 'currentColor' : 'none'} />
      </IconButton>
    </div>
  );
}

type AnnotationProps = {
  doc: LoadedDocument;
  disabled: boolean;
  tool: Tool;
  onTool: (tool: Tool) => void;
  onHighlight: () => void;
  /** The active tool's options (colour, width). */
  settings: ReactNode;
};

/** Anotar's toolbar on desktop: its tools, the active one's options and what it does. Leer and Editar leave it. */
export function AnnotationToolbar({ doc, disabled, tool, onTool, onHighlight, settings }: AnnotationProps) {
  const locked = !doc.canAnnotate || disabled;
  return (
    <div className="desktop-annotation-toolbar" role="toolbar" aria-label="Herramientas de anotación">
      <div className="tool-group">
        <IconButton label="Seleccionar texto (V)" toggle active={tool === 'select'} onClick={() => onTool('select')}>
          <MousePointer2 size={18} />
        </IconButton>
        <IconButton
          label="Resaltador (H)"
          toggle
          active={tool === 'highlight'}
          disabled={locked || !doc.canCopy}
          onMouseDown={e => e.preventDefault()}
          onClick={onHighlight}
        >
          <Highlighter size={19} />
        </IconButton>
        <IconButton
          label="Nota (N)"
          toggle
          active={tool === 'note'}
          disabled={locked}
          onClick={() => onTool(tool === 'note' ? 'select' : 'note')}
        >
          <StickyNote size={18} />
        </IconButton>
        <IconButton label="Lápiz (D)" toggle active={tool === 'draw'} disabled={locked} onClick={() => onTool('draw')}>
          <PenLine size={21} />
        </IconButton>
        <IconButton label="Goma" toggle active={tool === 'eraser'} disabled={locked} onClick={() => onTool('eraser')}>
          <Eraser size={21} />
        </IconButton>
      </div>
      {(tool === 'highlight' || tool === 'draw' || tool === 'eraser') && <span className="toolbar-divider" />}
      {settings}
    </div>
  );
}
