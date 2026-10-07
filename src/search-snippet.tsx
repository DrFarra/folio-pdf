import { normalize } from './pdf';

/** A result snippet with the searched words marked. Matching ignores case and
 * accents like the search itself, mapping back to the original characters. */
export function MarkedSnippet({ text, query }: { text: string; query: string }) {
  const words = [...new Set(normalize(query).split(/\s+/).filter(word => word.length > 1))];
  if (!words.length) return <>{text}</>;
  let folded = ''; const origin: number[] = [];
  for (let i = 0; i < text.length; i++) { const part = normalize(text[i]); for (const char of part) { folded += char; origin.push(i); } }
  const marks: [number, number][] = [];
  for (const word of words) for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + word.length)) marks.push([origin[at], origin[at + word.length - 1] + 1]);
  if (!marks.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const mark of marks) { const last = merged.at(-1); if (last && mark[0] <= last[1]) last[1] = Math.max(last[1], mark[1]); else merged.push([...mark]); }
  const parts: React.ReactNode[] = []; let cursor = 0;
  merged.forEach(([start, end], index) => { if (start > cursor) parts.push(text.slice(cursor, start)); parts.push(<mark key={index}>{text.slice(start, end)}</mark>); cursor = end; });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

const KEY = 'folio.search.recent';
export function recentSearches(): string[] { try { const value = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 8) : []; } catch { return []; } }
export function rememberSearch(term: string, current: string[]) {
  const value = term.trim(); if (value.length < 2) return current;
  const next = [value, ...current.filter(item => normalize(item) !== normalize(value))].slice(0, 8);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* A convenience. */ }
  return next;
}
export function clearRecentSearches() { try { localStorage.removeItem(KEY); } catch { /* Nothing stored. */ } }
