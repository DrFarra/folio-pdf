import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../errors';
import { isNativePdfDocument } from '../nativePdf';
import { pageText, searchText } from '../pdf';
import { recentSearches } from '../search-snippet';
import type { LoadedDocument } from '../types';
import { searchTerm } from './model';
import type { Notify } from './notices';
import { useLatest } from './latest';

/** Searching the open document: the typed `query`, the term searched (`searchQuery`,
 * which follows typing after a pause and needs two characters), its results over the
 * document's text index, and the searches made before. The index is built while search
 * is open; the tab switcher saves and restores all of it with each tab. */
export function useDocumentSearch(doc: LoadedDocument | null, open: boolean, notify: Notify) {
  const [textIndex, setTextIndex] = useState<string[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [query, setQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [resultIndex, setResultIndex] = useState(0);
  // Results are listed 200 at a time.
  const [resultLimit, setResultLimit] = useState(200);
  const [history, setHistory] = useState(recentSearches);
  const indexed = useLatest(textIndex);
  // PDFKit text crosses IPC, so a native document waits for a query.
  const requested = open && (!!searchQuery || !(doc && isNativePdfDocument(doc.pdf)));
  useEffect(() => {
    // The text index is built when search is opened, not on every open: a
    // 4000-page book would otherwise keep the PDF worker busy for minutes
    // while the reader waits for the pages on screen. Results appear as it runs.
    if (!doc) return;
    if (!requested || indexed.current.length === doc.pdf.numPages) {
      setIndexing(false);
      return;
    }
    let alive = true;
    setIndexing(true);
    void (async () => {
      const text = [...indexed.current]; // Resume an interrupted index.
      for (let number = text.length + 1; alive && number <= doc.pdf.numPages; number++) {
        const content = await (await doc.pdf.getPage(number)).getTextContent();
        text.push(pageText(content));
        if (alive && (number % 25 === 0 || number === doc.pdf.numPages)) setTextIndex([...text]);
      }
      if (alive) setIndexing(false);
    })().catch(error => {
      if (alive) {
        console.error('Folio: no se pudo indexar el PDF.', error);
        setIndexing(false);
        notify(errorMessage(error, 'Algunas páginas no se pudieron indexar para la búsqueda.'), 'error');
      }
    });
    return () => {
      alive = false;
    };
  }, [doc, requested, notify]);
  useEffect(() => {
    const term = searchTerm(query),
      apply = () => {
        setSearchQuery(term);
        setResultLimit(200);
      };
    if (!term) {
      apply();
      return;
    }
    const timer = setTimeout(apply, 250);
    return () => clearTimeout(timer);
  }, [query]);
  // Every occurrence is counted; the first 1000 are navigable and listed in steps.
  const { results, total: occurrences } = useMemo(
    () => searchText(textIndex, searchQuery, 1000),
    [textIndex, searchQuery],
  );
  /** Searches `term` now, without waiting for the typing pause. */
  const searchNow = (term: string) => {
    setSearchQuery(term);
    setResultLimit(200);
  };
  return {
    textIndex,
    setTextIndex,
    indexing,
    setIndexing,
    query,
    setQuery,
    searchQuery,
    setSearchQuery,
    searchNow,
    resultIndex,
    setResultIndex,
    resultLimit,
    setResultLimit,
    results,
    occurrences,
    history,
    setHistory,
  };
}
