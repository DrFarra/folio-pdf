import { useFolioState } from './folio-state';
import { useFolioReader } from './folio-reader';
import { useFolioDocuments } from './folio-documents';
import { useFolioCommands } from './folio-commands';
import { useFolioInput } from './folio-input';
import { useFolioWiring } from './folio-wiring';

/** Folio's state and the coordination between its parts, in layers that each build on the
 * ones before: the state, the reader, the open documents, the user's actions, their input
 * (keyboard, menu, palette, Back), and the wiring that connects the controllers. Returns
 * state and actions only; `App` draws them. */
export function useFolio() {
  const state = useFolioState();
  const reader = useFolioReader({ ...state });
  const documents = useFolioDocuments({ ...state, ...reader });
  const commands = useFolioCommands({ ...state, ...reader, ...documents });
  const input = useFolioInput({ ...state, ...reader, ...documents, ...commands });
  const wiring = useFolioWiring({ ...state, ...reader, ...documents, ...commands, ...input });
  return { ...state, ...reader, ...documents, ...commands, ...input, ...wiring };
}
