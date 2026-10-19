import { createContext, useContext } from 'react';
import type { useFolio } from './use-folio';

/** Everything the app's view draws from (see useFolio). */
export type Folio = ReturnType<typeof useFolio>;
export const FolioContext = createContext<Folio | null>(null);
/** Folio's state, for the parts of its view (inside App). */
export function useFolioContext() {
  const folio = useContext(FolioContext);
  if (!folio) throw new Error('useFolioContext needs FolioContext.Provider (App).');
  return folio;
}
