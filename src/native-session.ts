import type { Annotation } from './types';

const tolerance = .5;
const near = (left: number, right: number) => Math.abs(left - right) <= tolerance;

function samePosition(legacy: Annotation, original: Annotation): boolean {
  if (legacy.rect.every((value, index) => near(value, original.rect[index]))) return true;
  // MuPDF stores a note's display top-left as a raw PDF point. On rotated
  // pages that point may be any corner of PDFKit's full annotation bounds.
  // Accepting that corner also handles the older native full-bounds DTO.
  if (legacy.kind !== 'note' || !near(legacy.rect[0], legacy.rect[2]) || !near(legacy.rect[1], legacy.rect[3])) return false;
  return [original.rect[0], original.rect[2]].some(x => near(legacy.rect[0], x)) &&
    [original.rect[1], original.rect[3]].some(y => near(legacy.rect[1], y));
}

/** Migrates one lazily loaded page of an authoritative MuPDF session. Missing
 * originals were deleted by the user and are deliberately never appended.
 * Their native refs must still be recorded by the caller for native export.
 */
export function migrateLegacyNativePage(annotations: Annotation[], page: number, originals: Annotation[]): Annotation[] {
  const candidates = originals.filter(annotation => annotation.page === page && !!annotation.nativeSourceRef);
  const used = new Set<string>();
  for (const annotation of annotations) if (annotation.page === page && annotation.nativeSourceRef) used.add(annotation.nativeSourceRef);
  return annotations.map(annotation => {
    if (annotation.page !== page || annotation.nativeSourceRef) return annotation;
    const sameKind = candidates.filter(original => original.kind === annotation.kind);
    let matches = annotation.originalName ? sameKind.filter(original => original.originalName === annotation.originalName) : [];
    if (!matches.length && Number.isInteger(annotation.sourceRef) && Number(annotation.sourceRef) > 0) matches = sameKind.filter(original => samePosition(annotation, original));
    if (!matches.length) return annotation; // Preserve an unrecognized/moved user annotation.
    if (matches.length !== 1 || used.has(matches[0].nativeSourceRef!)) {
      throw new Error(`No se pudo recuperar una anotación de la página ${page}: varias anotaciones originales tienen la misma identidad o posición.`);
    }
    const original = matches[0]; used.add(original.nativeSourceRef!);
    return { ...annotation, id: original.id, nativeSourceRef: original.nativeSourceRef, originalName: annotation.originalName || original.originalName };
  });
}
