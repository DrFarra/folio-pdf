import { isNative } from '../platform';
import type { Annotation, LoadedDocument } from '../types';
import { annotationFingerprint, fileSaveLabel, here, saveAdvice, savesInPlace } from './model';

/** Whether a document has changes not saved in a PDF: a tab shows its unsaved dot, and Guardar
 * lights up, exactly when this holds. A web download of the current PDF counts as saved. */
export const isUnsaved = (doc: LoadedDocument, annotations: Annotation[], downloaded: boolean) => doc.modified && !downloaded || annotationFingerprint(annotations) !== doc.savedAnnotations;

type Inputs = {
  doc: LoadedDocument | null; annotations: Annotation[];
  /** The document's current PDF was downloaded (web). */
  downloaded: boolean;
  /** Saving is running, the Drive step it is at, and whether storing changes here failed. */
  saving: boolean; driveMessage: string; storageFailed: boolean;
};

/** What the interface says about the document in front: its save button and state, its
 * Drive state, and why some tools are unavailable. */
export function documentStatus({ doc, annotations, downloaded, saving, driveMessage, storageFailed }: Inputs) {
  const driveDirty = !!doc?.drive && (doc.modified || annotationFingerprint(annotations) !== doc.savedAnnotations);
  return {
    saveLabel: doc?.drive ? 'Guardar en Drive' : fileSaveLabel,
    // Only an opened file can be updated; otherwise Guardar already asks where to save.
    savesOriginal: savesInPlace && !!doc?.nativeSource && !doc.drive && !doc.draftSource && !doc.sample,
    sessionStatus: storageFailed ? `No se pudieron guardar tus cambios en ${here}. ${saveAdvice}` : `Los cambios se conservan en ${here}.`,
    docDirty: !!doc && isUnsaved(doc, annotations, downloaded),
    driveDirty,
    driveStatus: saving && driveMessage ? driveMessage : driveDirty ? 'Google Drive: cambios pendientes de guardar' : 'Documento de Google Drive',
    capabilitySummary: doc?.signed ? 'Este PDF está firmado. Puedes leerlo, buscar y añadir marcadores; editarlo invalidaría la firma.'
      : doc?.drive && !doc.drive.editable ? 'Este archivo de Google Drive es de solo lectura. Puedes leerlo, buscar y añadir marcadores.'
      : !doc?.canAnnotate ? 'El autor de este PDF no permite anotarlo. Puedes leerlo, buscar y añadir marcadores.'
      : 'PDF grande: puedes leer, buscar, resaltar, dibujar y añadir notas. No se pueden editar páginas ni formularios.',
  };
}

/** A page's name: positions are physical page numbers; a printed label that differs follows them. */
export const pageName = (labels: string[] | null, page: number) => { const label = labels?.[page - 1]; return label && label !== String(page) ? `${page} (${label})` : String(page); };

/** «page / pages», with the current page's printed label when it differs. */
export const pageCounter = (page: number, pages: number, label: string) => `${page} / ${pages}${label !== String(page) ? ` · ${label}` : ''}`;

/** The page ← and → turn to; two pages side by side (`spread`, 1–2, 3–4…) turn as a pair. */
export const turnedPage = (page: number, forward: boolean, spread: boolean) =>
  forward ? page + (spread ? 2 - (page + 1) % 2 : 1) : Math.max(1, page - (spread ? (page % 2 ? 2 : 3) : 1));

/** What the activity capsule says while a task runs: saving (where), printing or applying edits. */
export const activityLabel = (busy: string | null, drive: boolean, driveMessage: string) =>
  busy === 'download' ? drive ? driveMessage || 'Guardando en Google Drive…' : savesInPlace ? 'Guardando el PDF…' : isNative ? 'Guardando una copia…' : 'Preparando el PDF…'
    : busy === 'print' ? 'Preparando la impresión…' : busy === 'edit' ? 'Aplicando los cambios…' : '';
