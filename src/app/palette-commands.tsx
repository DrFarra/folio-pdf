import type { ReactNode } from 'react';
import {
  ArrowDownToLine,
  BookOpen,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Cloud,
  Eraser,
  FilePlus2,
  FileText,
  FolderOpen,
  Hash,
  Highlighter,
  Info,
  Keyboard,
  Layers,
  ListTree,
  Maximize,
  MessageSquare,
  Minimize,
  Moon,
  MousePointer2,
  PenLine,
  Pencil,
  Printer,
  Redo2,
  Scissors,
  Search,
  Settings,
  Settings2,
  Share2,
  StickyNote,
  Sun,
  Undo2,
  Upload,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { Command } from '../components/CommandPalette';
import { isNativePdfDocument } from '../nativePdf';
import { isMobile, shortcutLabel } from '../platform';
import type { ReadingPreferences } from '../reading-preferences';
import type { LoadedDocument, OutlineEntry, RecentDocument } from '../types';

type Explorer = 'pages' | 'outline' | 'bookmarks';
type PageTone = ReadingPreferences['pageTone'];

/** What the palette offers right now, and how each command runs. */
export type PaletteContext = {
  doc: LoadedDocument | null;
  /** No task or open is running: the document's commands are offered. */
  idle: boolean;
  pageName: (page: number) => string;
  saveLabel: string;
  bookmarked: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** The page «Volver a» returns to, when it differs from this one. */
  returnPage: number | null;
  pageTone: PageTone;
  outline: OutlineEntry[] | null;
  /** The other open tabs, and library documents not open. */
  tabs: { key: string; name: string }[];
  recents: RecentDocument[];
  driveAvailable: boolean;
  run: {
    save: () => void;
    print: () => void;
    share: () => void;
    edit: () => void;
    tools: () => void;
    split: () => void;
    info: () => void;
    close: () => void;
    jump: () => void;
    goTo: (page: number) => void;
    back: () => void;
    bookmark: () => void;
    chapter: (page: number) => void;
    search: () => void;
    explorer: (tab: Explorer) => void;
    annotations: () => void;
    highlight: () => void;
    tool: (tool: 'note' | 'draw' | 'eraser' | 'select') => void;
    undo: () => void;
    redo: () => void;
    zoom: (delta: number) => void;
    fit: (mode: 'page' | 'width') => void;
    actualSize: () => void;
    tone: (tone: PageTone) => void;
    view: () => void;
    switchTab: (key: string) => void;
    reopen: (recent: RecentDocument) => void;
    open: () => void;
    create: () => void;
    drive: () => void;
    library: () => void;
    theme: (theme: 'dark' | 'light') => void;
    settings: () => void;
    shortcuts: () => void;
    help: () => void;
  };
};

/** Everything the palette can do, built when it opens; unavailable actions are left out. */
export function paletteCommands({
  doc,
  idle,
  pageName,
  saveLabel,
  bookmarked,
  canUndo,
  canRedo,
  returnPage,
  pageTone,
  outline,
  tabs,
  recents,
  driveAvailable,
  run,
}: PaletteContext): Command[] {
  const list: Command[] = [],
    add = (
      group: string,
      id: string,
      title: string,
      action: () => void,
      icon?: ReactNode,
      hint?: string,
      keywords?: string,
    ) => {
      list.push({ group, id, title, run: action, icon, hint, keywords });
    };
  if (doc && idle) {
    add(
      'Documento',
      'save',
      saveLabel,
      run.save,
      <ArrowDownToLine size={16} />,
      shortcutLabel('S'),
      'guardar descargar exportar',
    );
    add('Documento', 'print', 'Imprimir', run.print, <Printer size={16} />, shortcutLabel('P'));
    if (isMobile) add('Documento', 'share', 'Compartir PDF', run.share, <Share2 size={16} />);
    if (!isNativePdfDocument(doc.pdf)) {
      add('Documento', 'edit', 'Editar PDF', run.edit, <Pencil size={16} />, undefined, 'texto modificar');
      add(
        'Documento',
        'tools',
        'Herramientas',
        run.tools,
        <Wrench size={16} />,
        undefined,
        'organizar recortar formulario firmar convertir ocr comparar',
      );
      if (doc.canAssemble)
        add(
          'Documento',
          'split',
          'Dividir PDF',
          run.split,
          <Scissors size={16} />,
          undefined,
          'separar partes capitulos extraer',
        );
    }
    add(
      'Documento',
      'info',
      'Información del documento',
      run.info,
      <Info size={16} />,
      undefined,
      'propiedades metadatos',
    );
    add('Documento', 'close', 'Cerrar documento', run.close, <X size={16} />, shortcutLabel('W'));
    add('Navegación', 'jump', 'Ir a página…', run.jump, <Hash size={16} />, undefined, 'saltar numero');
    add(
      'Navegación',
      'first',
      'Primera página',
      () => run.goTo(1),
      <ChevronLeft size={16} />,
      undefined,
      'inicio principio',
    );
    add(
      'Navegación',
      'last',
      'Última página',
      () => run.goTo(doc.pdf.numPages),
      <ChevronRight size={16} />,
      undefined,
      'final fin',
    );
    if (returnPage !== null)
      add(
        'Navegación',
        'back',
        `Volver a p. ${pageName(returnPage)}`,
        run.back,
        <ChevronLeft size={16} />,
        undefined,
        'regresar atras',
      );
    add(
      'Navegación',
      'bookmark',
      bookmarked ? 'Quitar marcador de esta página' : 'Guardar marcador de esta página',
      run.bookmark,
      <Bookmark size={16} />,
      undefined,
      'marcar',
    );
    add(
      'Paneles',
      'search',
      'Buscar en el PDF',
      run.search,
      <Search size={16} />,
      shortcutLabel('F'),
      'encontrar texto',
    );
    add('Paneles', 'pages', 'Páginas', () => run.explorer('pages'), <Layers size={16} />, undefined, 'miniaturas');
    add(
      'Paneles',
      'outline',
      'Índice',
      () => run.explorer('outline'),
      <ListTree size={16} />,
      undefined,
      'capitulos contenido tabla',
    );
    add('Paneles', 'bookmarks', 'Marcadores', () => run.explorer('bookmarks'), <Bookmark size={16} />);
    add(
      'Paneles',
      'annotations',
      'Anotaciones',
      run.annotations,
      <MessageSquare size={16} />,
      undefined,
      'resaltados notas resumen exportar',
    );
    if (doc.canAnnotate) {
      add('Anotar', 'highlight', 'Resaltador', run.highlight, <Highlighter size={16} />, 'H', 'subrayar');
      add('Anotar', 'note', 'Nota', () => run.tool('note'), <StickyNote size={16} />, 'N', 'comentario');
      add('Anotar', 'draw', 'Lápiz', () => run.tool('draw'), <PenLine size={16} />, 'D', 'dibujar rotulador');
      add('Anotar', 'eraser', 'Goma', () => run.tool('eraser'), <Eraser size={16} />, undefined, 'borrar');
      add('Anotar', 'select', 'Seleccionar texto', () => run.tool('select'), <MousePointer2 size={16} />, 'V');
    }
    if (canUndo) add('Anotar', 'undo', 'Deshacer', run.undo, <Undo2 size={16} />, shortcutLabel('Z'));
    if (canRedo) add('Anotar', 'redo', 'Rehacer', run.redo, <Redo2 size={16} />, shortcutLabel('Z', true));
    add('Ver', 'zoom-in', 'Acercar', () => run.zoom(0.1), <ZoomIn size={16} />, shortcutLabel('+'), 'zoom ampliar');
    add('Ver', 'zoom-out', 'Alejar', () => run.zoom(-0.1), <ZoomOut size={16} />, shortcutLabel('-'), 'zoom reducir');
    add('Ver', 'fit-page', 'Ajustar página', () => run.fit('page'), <Minimize size={16} />, undefined, 'zoom');
    add('Ver', 'fit-width', 'Ajustar ancho', () => run.fit('width'), <Maximize size={16} />, undefined, 'zoom');
    add('Ver', 'actual', 'Tamaño real', run.actualSize, <Search size={16} />, shortcutLabel('0'), 'zoom 100');
    for (const [tone, label] of [
      ['normal', 'Páginas normales'],
      ['sepia', 'Páginas en sepia'],
      ['dark', 'Páginas oscuras'],
    ] as const)
      if (pageTone !== tone)
        add(
          'Ver',
          `tone-${tone}`,
          label,
          () => run.tone(tone),
          tone === 'dark' ? <Moon size={16} /> : <Sun size={16} />,
          undefined,
          'color pagina noche lectura invertir',
        );
    add(
      'Ver',
      'view',
      'Vista del documento',
      run.view,
      <Settings2 size={16} />,
      undefined,
      'lectura continua pagina separacion',
    );
    for (const entry of (outline || []).filter(item => item.page !== null).slice(0, 400))
      add(
        'Capítulos',
        `outline-${entry.page}-${entry.title}`,
        entry.title,
        () => run.chapter(entry.page!),
        <BookOpen size={16} />,
        `p. ${pageName(entry.page!)}`,
        'indice seccion',
      );
  }
  for (const tab of tabs)
    add(
      'Documentos abiertos',
      `tab-${tab.key}`,
      tab.name,
      () => run.switchTab(tab.key),
      <FileText size={16} />,
      undefined,
      'pestaña cambiar',
    );
  for (const recent of recents.slice(0, 50))
    add(
      'Biblioteca',
      `recent-${recent.id}`,
      recent.name,
      () => run.reopen(recent),
      <BookOpen size={16} />,
      undefined,
      'abrir reciente documento',
    );
  add('General', 'open', 'Abrir PDF…', run.open, <Upload size={16} />, shortcutLabel('O'), 'importar archivo');
  add('General', 'create', 'Crear PDF', run.create, <FilePlus2 size={16} />, undefined, 'nuevo combinar imagenes');
  if (driveAvailable) add('General', 'drive', 'Google Drive', run.drive, <Cloud size={16} />, undefined, 'nube');
  if (doc)
    add('General', 'library', 'Biblioteca', run.library, <FolderOpen size={16} />, undefined, 'inicio documentos');
  add(
    'General',
    'theme-dark',
    'Tema oscuro',
    () => run.theme('dark'),
    <Moon size={16} />,
    undefined,
    'noche apariencia',
  );
  add('General', 'theme-light', 'Tema claro', () => run.theme('light'), <Sun size={16} />, undefined, 'dia apariencia');
  add('General', 'settings', 'Ajustes', run.settings, <Settings size={16} />, undefined, 'preferencias');
  add('General', 'shortcuts', 'Atajos de teclado', run.shortcuts, <Keyboard size={16} />, '?');
  add('General', 'help', 'Ayuda', run.help, <CircleHelp size={16} />);
  return list;
}
