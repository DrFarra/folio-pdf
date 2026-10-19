import { useMemo } from 'react';
import { EditStore } from '../edit/store';
import { DocumentChanges } from './document-changes';
import { DocumentOutput } from './document-output';
import { UndoHistory } from './history';
import { Library } from './library';
import { LiveEdit } from './live-edit';
import { DocumentOpener } from './opener';
import { Persistence } from './persistence';
import { Tabs } from './tabs';
import { ToolSections } from './tool-sections';

/** The controllers that act on documents, one each for the app's life. Their hosts (what
 * they need from the app) are set on each render by useFolioWiring. */
export function useControllers() {
  return useMemo(() => ({
    editStore: new EditStore(), tabStore: new Tabs(), opener: new DocumentOpener(), history: new UndoHistory(), changes: new DocumentChanges(),
    toolSections: new ToolSections(), liveEdit: new LiveEdit(), persistence: new Persistence(), output: new DocumentOutput(), libraryStore: new Library(),
  }), []);
}
