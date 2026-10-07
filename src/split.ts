// How "Dividir PDF" turns each mode's options into parts and file names.
// No imports, so the Node tests load this file directly.

export type Part = { first: number; last: number; title?: string };
export type OutlineItem = { title: string; page: number | null; depth: number };
export const MAX_PARTS = 5000;

const limit = (parts: Part[]) => {
  if (parts.length > MAX_PARTS) throw new Error(`Se crearían ${parts.length.toLocaleString('es')} archivos; el máximo es ${MAX_PARTS.toLocaleString('es')}.`);
  return parts;
};
const count = (value: number, total: number, what: string) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Escribe un número de ${what} mayor que cero.`);
  if (value > total) throw new Error(`El documento solo tiene ${total.toLocaleString('es')} páginas.`);
  return value;
};

/** "1-5, 8, 10-": one part per interval; "10-" runs to the last page. Also returns the pages left out. */
export function rangeParts(text: string, total: number): { parts: Part[]; skipped: string } {
  const parts: Part[] = [];
  for (const token of text.split(/[,;]/).map(token => token.trim()).filter(Boolean)) {
    const match = token.match(/^(\d+)\s*(?:([-–])\s*(\d*))?$/);
    if (!match) throw new Error(`«${token}» no es un intervalo válido. Usa por ejemplo 1-5, 6-12, 13-.`);
    const first = Number(match[1]), last = match[2] ? match[3] ? Number(match[3]) : total : first;
    if (first < 1 || last > total) throw new Error(`«${token}» contiene páginas que no existen; el documento tiene ${total.toLocaleString('es')}.`);
    if (last < first) throw new Error(`En «${token}» el inicio debe ser menor o igual que el final.`);
    parts.push({ first, last });
  }
  if (!parts.length) throw new Error('Escribe al menos un intervalo, por ejemplo 1-5, 6-12.');
  const covered = new Uint8Array(total + 1);
  for (const part of parts) covered.fill(1, part.first, part.last + 1);
  const gaps: string[] = [];
  for (let page = 1; page <= total; page++) if (!covered[page]) {
    let end = page; while (end < total && !covered[end + 1]) end++;
    gaps.push(end > page ? `${page}–${end}` : String(page)); page = end;
  }
  return { parts: limit(parts), skipped: gaps.join(', ') };
}

export function everyParts(size: number, total: number): Part[] {
  count(size, total, 'páginas');
  return limit(Array.from({ length: Math.ceil(total / size) }, (_, i) => ({ first: i * size + 1, last: Math.min(total, (i + 1) * size) })));
}

/** `pieces` parts whose sizes differ by at most one page; the first ones take the remainder. */
export function equalParts(pieces: number, total: number): Part[] {
  count(pieces, total, 'partes');
  const size = Math.floor(total / pieces), extra = total % pieces, parts: Part[] = [];
  for (let i = 0, first = 1; i < pieces; i++) { const last = first + size + (i < extra ? 1 : 0) - 1; parts.push({ first, last }); first = last + 1; }
  return limit(parts);
}

/** One part per outline entry up to `depth` (0 = chapters). Entries that start on the
 * same page merge into the first; pages before the first entry become "Preliminares". */
export function chapterParts(outline: OutlineItem[], depth: number, total: number): Part[] {
  const starts: { page: number; title: string }[] = [];
  for (const item of outline.filter(item => item.depth <= depth && item.page && item.page >= 1 && item.page <= total).sort((a, b) => a.page! - b.page!))
    if (starts.at(-1)?.page !== item.page) starts.push({ page: item.page!, title: item.title.trim() || `Página ${item.page}` });
  if (!starts.length) return [];
  const parts: Part[] = starts[0].page > 1 ? [{ first: 1, last: starts[0].page - 1, title: 'Preliminares' }] : [];
  starts.forEach((start, i) => parts.push({ first: start.page, last: (starts[i + 1]?.page ?? total + 1) - 1, title: start.title }));
  return limit(parts);
}

export const pagesLabel = (part: Part) => part.first === part.last ? `Pág. ${part.first}` : `Págs. ${part.first}–${part.last}`;

/** Names that are valid on Windows, macOS, Android and in a ZIP: no reserved characters,
 * at most 120 characters, ending in .pdf and unique regardless of case. */
export function fileNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name, i) => {
    let stem = name.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/[. ]+$/, '') || `Parte ${i + 1}`;
    for (let n = 2, base = stem; used.has(stem.toLocaleLowerCase('es')); n++) stem = `${base} (${n})`;
    used.add(stem.toLocaleLowerCase('es'));
    return stem + '.pdf';
  });
}

/** Chapters are numbered so they sort in reading order; other parts name their pages. */
export function defaultNames(base: string, parts: Part[], chapters: boolean): string[] {
  const width = Math.max(2, String(parts.length).length);
  return fileNames(parts.map((part, i) => chapters
    ? `${String(i + 1).padStart(width, '0')} — ${part.title}`
    : `${base} — ${part.first === part.last ? `pág. ${part.first}` : `págs. ${part.first}-${part.last}`}`));
}
