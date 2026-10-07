import { useEffect, useState } from 'react';

/** What each highlight color means to the reader, e.g. yellow = Importante.
 * Defaults suit study notes; any color can be renamed or cleared. Stored per
 * viewer; the PDF keeps only the color. */
const DEFAULTS: Record<string, string> = {
  '#f5d164': 'Importante', '#91c6a5': 'Definición', '#eea1b7': 'Clínica', '#bea9e4': 'Mecanismo',
  '#8bbaf0': 'Dato clave', '#f2af74': 'Repasar', '#eba08e': 'Alto rendimiento',
};
const KEY = 'folio.highlight.labels', EVENT = 'folio:highlight-labels';
function stored(): Record<string, string> { try { const value = JSON.parse(localStorage.getItem(KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
export function highlightLabels(): Record<string, string> {
  const labels = { ...DEFAULTS };
  for (const [hex, label] of Object.entries(stored())) if (typeof label === 'string') labels[hex.toLowerCase()] = label;
  return labels;
}
export const highlightLabel = (hex: string) => highlightLabels()[hex.toLowerCase()]?.trim() || '';
export function setHighlightLabel(hex: string, label: string) {
  const labels = stored(); labels[hex.toLowerCase()] = label.slice(0, 40);
  try { localStorage.setItem(KEY, JSON.stringify(labels)); } catch { /* A preference. */ }
  window.dispatchEvent(new Event(EVENT));
}
/** Re-renders when any meaning changes. */
export function useHighlightLabels() {
  const [labels, setLabels] = useState(highlightLabels);
  useEffect(() => { const update = () => setLabels(highlightLabels()); window.addEventListener(EVENT, update); return () => window.removeEventListener(EVENT, update); }, []);
  return labels;
}
