import type { RefObject } from 'react';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import IconButton from './IconButton';
import { plural } from '../pdf';
import { MarkedSnippet } from '../search-snippet';

type Result = { page: number; offset: number; text: string };

type Props = {
  /** Touch layouts title the panel themselves. */
  touch: boolean;
  input: RefObject<HTMLInputElement | null>;
  query: string; searchQuery: string;
  onQuery: (value: string) => void; onClear: () => void;
  /** Enter, or Shift+Enter (`backwards`). */
  onSubmit: (backwards: boolean) => void;
  onClose: () => void;
  history: string[]; onClearHistory: () => void;
  /** The text index, built page by page while `indexing`. */
  indexing: boolean; indexed: string[]; pages: number;
  results: Result[]; occurrences: number; selected: number;
  /** How many results are listed; more are listed on request. */
  listed: number; onShowMore: () => void;
  onResult: (index: number) => void;
  pageName: (page: number) => string;
  /** The outline section a page belongs to. */
  section: (page: number) => string | undefined;
  /** Offered when the document has no text to search. */
  onRecognize?: () => void;
};

/** Search in the side panel: the field, recent searches, the result count and the results. */
export default function SearchPanel(props: Props) {
  const { touch, input, query, searchQuery, history, indexing, indexed, results, occurrences, selected, listed } = props;
  return <>
    {!touch && <div className="sidebar-title"><span>Buscar</span><IconButton label="Cerrar búsqueda" onClick={props.onClose}><X size={16} /></IconButton></div>}
    <form className="search-field" onSubmit={e => { e.preventDefault(); props.onSubmit(false); }}><Search size={16} /><input ref={input} placeholder="Palabra o frase…" value={query} onChange={e => props.onQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); props.onClose(); } else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); props.onSubmit(true); } }} aria-label="Buscar texto en el PDF" />{query && <button type="button" onClick={props.onClear} aria-label="Borrar búsqueda"><X size={14} /></button>}</form>
    {!query.trim() && history.length > 0 && <div className="search-recent"><div><span>Búsquedas recientes</span><button type="button" className="text-button" onClick={props.onClearHistory}>Borrar</button></div><div role="list">{history.map(term => <button key={term} type="button" role="listitem" onClick={() => { props.onQuery(term); input.current?.focus({ preventScroll: true }); }}><Search size={13} aria-hidden="true" />{term}</button>)}</div></div>}
    <div className="search-summary"><span aria-live="polite">{indexing ? (searchQuery && indexed.length ? `${plural(occurrences, 'coincidencia', 'coincidencias')} · buscando (${indexed.length} de ${props.pages} págs.)…` : 'Preparando búsqueda…') : query.trim().length === 1 ? 'Escribe al menos dos caracteres' : searchQuery ? plural(occurrences, 'coincidencia', 'coincidencias') : ''}</span>{results.length > 0 && <div><IconButton label="Resultado anterior" onClick={() => props.onResult(selected - 1)}><ChevronLeft size={15} /></IconButton><IconButton label="Siguiente resultado" onClick={() => props.onResult(selected + 1)}><ChevronRight size={15} /></IconButton></div>}</div>
    <div className="sidebar-scroll search-results">{results.slice(0, listed).map((result, i) => <button key={`${result.page}-${result.offset}`} className={`search-result ${i === selected ? 'selected' : ''}`} onClick={() => props.onResult(i)}><span className="result-heading"><span className="result-page">Página {props.pageName(result.page)}{props.section(result.page) && <em>{props.section(result.page)}</em>}</span><span>{i + 1} / {results.length}</span></span><span className="result-snippet"><MarkedSnippet text={result.text} query={searchQuery} /></span></button>)}{results.length > listed ? <button className="text-button" onClick={props.onShowMore}>Mostrar más resultados</button> : occurrences > results.length && <div className="search-hint"><span>Se muestran las primeras {results.length} coincidencias. Escribe una frase más concreta para afinar.</span></div>}{searchQuery && !indexing && !results.length && (indexed.every(t => !t.trim()) ? <div className="empty-panel"><Search size={26} /><p>Este PDF no tiene texto que se pueda buscar.</p>{props.onRecognize && <button className="text-button" onClick={props.onRecognize}>Reconocer texto (OCR)</button>}</div> : <div className="empty-panel"><Search size={26} /><p>Sin resultados para «{searchQuery.trim()}».</p><span>Prueba con otra palabra o una frase más corta.</span></div>)}{!searchQuery && <div className="search-hint"><span>No distingue mayúsculas ni acentos.</span></div>}</div>
  </>;
}
