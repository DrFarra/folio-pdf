import { ChevronDown, ChevronLeft, ChevronRight, Layers, Search, Highlighter, MoreHorizontal, Undo2, Redo2, PenLine, Eraser, StickyNote, MousePointer2 } from 'lucide-react';
import type { MouseEventHandler, ReactNode } from 'react';
import type { Tool } from '../types';

function Button({ label, children, onClick, onMouseDown, disabled, active }: { label: string; children: ReactNode; onClick: () => void; onMouseDown?: MouseEventHandler<HTMLButtonElement>; disabled?: boolean; active?: boolean }) {
  return <button type="button" className={`tablet-icon-button${active ? ' active' : ''}`} aria-label={label} title={label} disabled={disabled} aria-pressed={active} onClick={onClick} onMouseDown={onMouseDown}>{children}</button>;
}

export function TabletReaderHeader({ name, nameAdornment, count, page, pageStep, documentsOpen, annotating, disabled, draft, canUndo, canRedo, onLibrary, onDocuments, onPage, onPages, onSearch, onAnnotate, onDone, onUndo, onRedo, onMore }: {
  name: string; nameAdornment?: ReactNode; count: number; page?: string; pageStep?: { previous?: () => void; next?: () => void }; documentsOpen: boolean; annotating: boolean; disabled: boolean; draft: boolean; canUndo: boolean; canRedo: boolean;
  onLibrary: () => void; onDocuments: () => void; onPage: () => void; onPages: () => void; onSearch: () => void; onAnnotate: () => void; onDone: () => void; onUndo: () => void; onRedo: () => void; onMore: () => void;
}) {
  return <>
    <Button label="Volver a la biblioteca" disabled={disabled || draft} onClick={onLibrary}><ChevronLeft size={23} /></Button>
    <button id="document-switcher-trigger" className="tablet-document-selector" aria-label="Documentos abiertos y recientes" aria-haspopup="dialog" aria-expanded={documentsOpen} aria-controls="document-switcher" disabled={disabled || draft || count === 0} onClick={onDocuments}><span>{name}</span>{nameAdornment}{count > 1 && <small>{count}</small>}<ChevronDown size={16} /></button>
    {page && pageStep && <Button label="Página anterior" disabled={disabled || draft || !pageStep.previous} onClick={() => pageStep.previous?.()}><ChevronLeft size={21} /></Button>}
    {page && <button className="tablet-page-jump" aria-label="Ir a página" title={`Página ${page}`} disabled={disabled || draft} onClick={onPage}>{page}</button>}
    {page && pageStep && <Button label="Página siguiente" disabled={disabled || draft || !pageStep.next} onClick={() => pageStep.next?.()}><ChevronRight size={21} /></Button>}
    {annotating ? <>
      <Button label="Deshacer" disabled={disabled || !canUndo} onClick={onUndo}><Undo2 size={21} /></Button>
      <Button label="Rehacer" disabled={disabled || !canRedo} onClick={onRedo}><Redo2 size={21} /></Button>
      <button className="tablet-done" onClick={onDone}>Listo</button>
    </> : <>
      <Button label="Páginas" disabled={disabled || draft || !page} onClick={onPages}><Layers size={21} /></Button>
      <Button label="Buscar en el PDF" disabled={disabled || draft || !page} onClick={onSearch}><Search size={21} /></Button>
      <Button label="Anotar documento" disabled={disabled || draft || !page} onClick={onAnnotate}><Highlighter size={21} /></Button>
    </>}
    <Button label="Más acciones del documento" disabled={disabled || draft || !page} onClick={onMore}><MoreHorizontal size={23} /></Button>
  </>;
}

// Same order and behaviour as the phone and desktop toolbars; the settings slot
// at the end is always reserved so no tool moves under the finger, and its
// divider shows only when the tool has options.
export function TabletAnnotationDock({ tool, setTool, disabled, canCopy, settings, hasSettings, onHighlight }: { tool: Tool; setTool: (tool: Tool) => void; disabled: boolean; canCopy: boolean; settings: ReactNode; hasSettings: boolean; onHighlight: () => void }) {
  return <div className="tablet-annotation-dock" role="toolbar" aria-label="Herramientas de anotación">
    <Button label="Seleccionar texto" active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={21} /></Button>
    <Button label="Resaltador" active={tool === 'highlight'} disabled={disabled || !canCopy} onMouseDown={event => event.preventDefault()} onClick={onHighlight}><Highlighter size={22} /></Button>
    <Button label="Nota" active={tool === 'note'} disabled={disabled} onClick={() => setTool(tool === 'note' ? 'select' : 'note')}><StickyNote size={21} /></Button>
    <Button label="Lápiz" active={tool === 'draw'} disabled={disabled} onClick={() => setTool('draw')}><PenLine size={22} /></Button>
    <Button label="Goma" active={tool === 'eraser'} disabled={disabled} onClick={() => setTool('eraser')}><Eraser size={22} /></Button>
    <span className="tablet-dock-divider" style={hasSettings ? undefined : { visibility: 'hidden' }} />{settings}
  </div>;
}
