import { useCallback, useEffect, useState } from 'react';
import type { Area } from '../engine/operations.ts';
import { preference } from '../preferences';
import { readReadingPreferences } from '../reading-preferences';
import type { OutlineEntry, SideTab, Tool } from '../types';
import { DEFAULT_HIGHLIGHT_COLOR, type TabView } from './model';

/** The reader's view of the document in front, which each tab keeps as its own (`TabView`):
 * page, first page's size, rotation and reading mode; Anotar and its tool and colour; the
 * side panels and outline; the active note; the area tools' areas; and whether its changes
 * could be stored. Zoom and search, also kept per tab, live in their own hooks. */
export function useTabView() {
  const [page, setPage] = useState(1);
  const [dimensions, setDimensions] = useState({ width: 595, height: 842, rotation: 0 });
  const [rotation, setRotation] = useState(0);
  const [readingMode, setReadingMode] = useState<TabView['readingMode']>(() => readReadingPreferences().mode);
  const [annotating, setAnnotating] = useState(false);
  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState(() => {
    const saved = preference('folio.highlightColor', DEFAULT_HIGHLIGHT_COLOR);
    return /^#[0-9a-f]{6}$/i.test(saved) ? saved : DEFAULT_HIGHLIGHT_COLOR;
  });
  const [sidebar, setSidebar] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>('pages');
  const [notesOpen, setNotesOpen] = useState(false);
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const [redactions, setRedactions] = useState<Area[]>([]);
  const [editArea, setEditArea] = useState<Area | null>(null);
  const [sessionFailed, setSessionFailed] = useState(false);
  const [draftFailed, setDraftFailed] = useState(false);
  // The highlighter and notes are Anotar's tools: choosing one enters it.
  useEffect(() => {
    if (tool === 'highlight' || tool === 'note') setAnnotating(true);
  }, [tool]);
  useEffect(() => {
    try {
      localStorage.setItem('folio.highlightColor', color);
    } catch {
      /* The selected color still works for this session. */
    }
  }, [color]);
  // The selection previewing a highlight takes the chosen colour.
  useEffect(() => {
    document.documentElement.style.setProperty('--highlight-preview', color);
  }, [color]);
  /** Shows a tab's view. On touch layouts (`closeDrawers`) the drawers start closed, whatever the tab had open. */
  const apply = useCallback((view: TabView, closeDrawers: boolean) => {
    setPage(view.page);
    setDimensions(view.dimensions);
    setRotation(view.rotation);
    setReadingMode(view.readingMode);
    setTool(view.tool);
    setColor(view.color);
    setAnnotating(view.annotating || view.tool === 'highlight' || view.tool === 'note');
    setSidebar(closeDrawers ? false : view.sidebar);
    setSideTab(view.sideTab);
    setNotesOpen(closeDrawers ? false : view.notesOpen);
    setOutline(view.outline);
    setActiveNote(view.activeNote);
    setRedactions(view.redactions);
    setEditArea(view.editArea);
    setSessionFailed(view.sessionFailed);
    setDraftFailed(view.draftFailed);
  }, []);
  return {
    page,
    setPage,
    dimensions,
    setDimensions,
    rotation,
    setRotation,
    readingMode,
    setReadingMode,
    annotating,
    setAnnotating,
    tool,
    setTool,
    color,
    setColor,
    sidebar,
    setSidebar,
    sideTab,
    setSideTab,
    notesOpen,
    setNotesOpen,
    outline,
    setOutline,
    activeNote,
    setActiveNote,
    redactions,
    setRedactions,
    editArea,
    setEditArea,
    sessionFailed,
    setSessionFailed,
    draftFailed,
    setDraftFailed,
    apply,
  };
}
