import { discardDraft } from '../storage';
import { driveStage, driveStageNative, driveSync, type DriveOpened } from '../drive';
import { errorMessage } from '../errors';
import { isNativePdfDocument, nativePdfPageAnnotations } from '../nativePdf';
import { exportAnnotated } from '../pdf';
import {
  isMobile,
  isNative,
  presentNativePdf,
  printPdf,
  saveOriginalPdf,
  savePdf,
  sharePdf,
  type Anchor,
  type NativeDocument,
} from '../platform';
import type { Annotation, BookmarkNode, LoadedDocument } from '../types';
import { annotationFingerprint, copyName, savesInPlace, type OpenContext } from './model';
import type { Notify } from './notices';
import { printRendered } from './print';

/** What saving, sharing and printing need from the app around them. */
export type OutputHost = {
  /** The document in front and its annotations. */
  current: () => LoadedDocument | null;
  annotations: () => Annotation[];
  reading: () => { page: number; bookmarks: BookmarkNode[] };
  /** An edit waits to be applied or discarded: nothing leaves Folio meanwhile. */
  draft: () => boolean;
  busy: () => boolean;
  loading: () => boolean;
  setBusy: (task: 'download' | 'print' | null) => void;
  /** The Drive step shown while saving there. */
  setDriveMessage: (message: string) => void;
  /** Writes Editar's live document, when there is one, so the save holds its changes. */
  writeLive: () => Promise<void>;
  /** Editar PDF is open and stays open on the saved document. */
  editing: () => boolean;
  /** Opens the saved file in place of the document. */
  reopen: (
    source: Uint8Array | NativeDocument,
    name: string,
    token: string | undefined,
    context: OpenContext,
  ) => Promise<boolean | undefined>;
  /** The saved file holds `next`'s bytes, already open: it replaces `previous` wherever it is held, without reopening it. */
  adopt: (previous: LoadedDocument, next: LoadedDocument) => void;
  /** The document's file now has `revision`: undo steps holding other bytes read as unsaved. */
  savedAs: (revision: string) => void;
  /** While a save runs, the PDF it writes is not also stored as a draft; afterwards an unsaved one is. */
  holdDrafts: (hold: boolean) => void;
  /** Drafts queued so far are written: a saved document's draft can be discarded. */
  draftsWritten: () => Promise<void>;
  /** Removes a library entry the saved document replaces. */
  retire: (id: string) => Promise<void>;
  /** Drive holds a newer revision: the pending edit waits in the Drive browser. */
  driveConflict: (pendingId: string) => void;
  /** The web download holds the current changes: the document no longer reads as unsaved. */
  downloaded: (doc: LoadedDocument) => void;
  notify: Notify;
  dismissNotice: () => void;
};

/** Getting a document out of Folio: saving it (over its file, as a copy, to Drive, or as a
 * download), sharing it and printing it, always with Folio's annotations written in. */
export class DocumentOutput {
  /** Set on each render, as EditStore's actions are. */
  host!: OutputHost;
  /** A save is running: another waits, and sharing waits for it. */
  saving = false;

  /** The PDF with Folio's annotations written into it (`incremental`: appended, keeping the original bytes). */
  async annotated(doc: LoadedDocument, items = this.host.annotations(), incremental = false) {
    return doc.canAnnotate ? exportAnnotated(doc.bytes, items, doc.password, undefined, incremental) : doc.bytes;
  }

  /** The document in front as a file. Drive keeps the original bytes and appends the changes. */
  async currentBytes() {
    const doc = this.host.current();
    if (!doc) throw new Error('No hay documento abierto.');
    if (isNativePdfDocument(doc.pdf)) throw new Error('Usa Guardar una copia para guardar este PDF.');
    const annotations = this.host.annotations();
    // The bytes already hold these annotations: writing them again would rewrite the whole PDF for nothing.
    if (annotationFingerprint(annotations) === doc.bytesAnnotations) return doc.bytes;
    return this.annotated(doc, annotations, !!doc.drive);
  }

  /** The annotations PDFKit's file-backed document had removed, all its pages read first when an older session left them unknown. */
  private async removedOriginals(doc: LoadedDocument, failure: string) {
    if (doc.nativeLegacySession)
      for (let number = 1; number <= doc.pdf.numPages; number++) await nativePdfPageAnnotations(doc.pdf, number);
    if (doc.nativeLegacySession) throw new Error(failure);
    const annotations = this.host.annotations();
    return (doc.nativeOriginalRefs || []).filter(
      ref => !annotations.some(annotation => annotation.nativeSourceRef === ref),
    );
  }

  /** iOS writes a file-backed PDF with its annotations itself, and presents it to save, share or print. */
  private async presentFileBacked(doc: LoadedDocument, action: 'save' | 'share' | 'print', anchor?: Anchor) {
    const removed = await this.removedOriginals(
      doc,
      'No se pudieron recuperar todas las anotaciones anteriores. La copia no se guardó.',
    );
    return presentNativePdf(
      doc.nativeSource!,
      action === 'save' ? copyName(doc.name) : doc.name,
      action,
      this.host.annotations(),
      removed,
      anchor,
    );
  }

  /** The saved file replaces the document, keeping the reader where it was. */
  private reopenSaved(
    source: Uint8Array | NativeDocument,
    name: string,
    token: string | undefined,
    doc: LoadedDocument,
    keepEditing: boolean,
    drive?: DriveOpened,
  ) {
    const { page, bookmarks } = this.host.reading();
    return this.host.reopen(source, name, token, {
      drive,
      savedCopy: true,
      keepEditing,
      password: doc.password,
      useSession: false,
      page,
      bookmarks,
    });
  }

  private async saveToDrive(doc: LoadedDocument, keepEditing: boolean) {
    const { host } = this,
      binding = doc.drive!;
    if (!binding.editable) throw new Error('Este archivo tiene permiso de solo lectura en Google Drive.');
    host.setDriveMessage('Preparando…');
    const pending = isNativePdfDocument(doc.pdf)
      ? await driveStageNative(
          binding.binding,
          doc.nativeSource!,
          host.annotations(),
          await this.removedOriginals(doc, 'No se recuperaron todas las anotaciones. La edición no se subió.'),
        )
      : await driveStage(binding.binding, await this.currentBytes());
    host.setDriveMessage('Subiendo a Drive…');
    try {
      const result = await driveSync(pending.id);
      if (result.status === 'conflict') {
        host.driveConflict(pending.id);
        host.notify(result.message, 'error');
        return;
      }
      if (!result.opened) throw new Error('No se pudo confirmar el archivo guardado.');
      const saved = result.opened;
      await host.draftsWritten().catch(() => {});
      if (await this.reopenSaved(saved.document, saved.document.name, saved.document.token, doc, keepEditing, saved)) {
        await discardDraft(doc.id);
        // Each Drive revision has its own id: the saved one replaces the previous library entry.
        if (host.current()?.id !== doc.id) await host.retire(doc.id);
      }
      host.notify(result.message, 'success');
    } catch (error) {
      throw new Error(
        `${errorMessage(error)} Puedes reintentarlo en Biblioteca → Google Drive → Ediciones pendientes.`,
      );
    }
  }

  /** Guardar: over the opened file where the platform allows it (or to Drive), otherwise as a
   * copy or a download; `copy` always asks for a new file. `keepEditing` keeps Editar PDF open. */
  async save(options?: { keepEditing?: boolean; copy?: boolean }) {
    // Storing the PDF about to be saved as a draft too wrote a book twice, the draft only to be discarded.
    const hold = !this.saving;
    if (hold) this.host.holdDrafts(true);
    try {
      await this.saveNow(options);
    } finally {
      if (hold) this.host.holdDrafts(false);
    }
  }

  private async saveNow(options?: { keepEditing?: boolean; copy?: boolean }) {
    const { host } = this;
    if (host.draft()) {
      host.notify('Aplica o descarta la edición antes de guardar el PDF.');
      return;
    }
    if (!this.saving) await host.writeLive().catch(() => {});
    const doc = host.current();
    if (!doc || host.busy() || host.loading() || this.saving) return;
    const keepEditing = !!options?.keepEditing && host.editing();
    this.saving = true;
    host.setBusy('download');
    try {
      if (doc.drive && !options?.copy) {
        await this.saveToDrive(doc, keepEditing);
        return;
      }
      if (doc.drive) host.setDriveMessage('Guardando una copia…');
      if (isNativePdfDocument(doc.pdf)) {
        const saved = await this.presentFileBacked(doc, 'save');
        if (saved && typeof saved === 'object') {
          if (await this.reopenSaved(saved, saved.name, saved.token, doc, keepEditing)) await discardDraft(doc.id);
          host.notify(`Copia guardada. Ahora editas «${saved.name}».`, 'success');
        }
        return;
      }
      const saveInPlace = savesInPlace && !options?.copy,
        copy = isNative && !saveInPlace;
      const overwrite = saveInPlace && !!doc.nativeSource && !doc.draftSource && !doc.sample;
      if (overwrite && !doc.modified && annotationFingerprint(host.annotations()) === doc.savedAnnotations) {
        host.notify('No hay cambios que guardar.');
        return;
      }
      const bytes = await this.currentBytes();
      const saved = overwrite
        ? await saveOriginalPdf(bytes, doc.name, doc.nativeSource!)
        : await savePdf(bytes, saveInPlace ? doc.name : copyName(doc.name), doc.nativeSource);
      // The web download is an independent copy that may never reach the disk: the
      // tab keeps its id, session, draft and library entry, so reopening the
      // original still shows the changes. Only the unsaved marks are cleared.
      if (saved && !isNative) {
        doc.savedAnnotations = annotationFingerprint(host.annotations());
        host.downloaded(doc);
        host.notify('Descarga iniciada.', 'success');
        return;
      }
      if (saved) {
        await host.draftsWritten().catch(() => {});
        const name = typeof saved === 'object' ? saved.name : doc.name;
        // The file holds the very bytes open here (no annotations had to be written in): it becomes the
        // document's file as it is. Reading a book back (PDF.js, the engine) took most of saving it.
        const file = typeof saved === 'object' && saved.id && bytes === doc.bytes ? saved : null;
        if (file)
          host.adopt(doc, {
            ...doc,
            id: file.id!,
            revision: file.revision || file.id!,
            name,
            nativeSource: file.token,
            size: bytes.length,
            modified: false,
            draftSource: false,
            sample: false,
            outdated: undefined,
            savedAnnotations: annotationFingerprint(host.annotations()),
          });
        if (
          file ||
          (await this.reopenSaved(bytes, name, typeof saved === 'object' ? saved.token : undefined, doc, keepEditing))
        ) {
          const current = host.current();
          if (current) host.savedAs(current.revision);
          await discardDraft(doc.id);
          // The saved PDF replaces the previous library entry; after a copy the original stays listed.
          if (!copy && host.current()?.id !== doc.id) await host.retire(doc.id);
        }
        host.notify(
          overwrite
            ? 'Cambios guardados en el PDF original.'
            : copy
              ? `Copia guardada. Ahora editas «${name}».`
              : 'PDF guardado.',
          'success',
        );
      }
    } catch (error) {
      host.notify(errorMessage(error, 'No se pudo guardar el PDF. Tus cambios siguen en Folio.'), 'error');
    } finally {
      this.saving = false;
      host.setBusy(null);
      host.setDriveMessage('');
    }
  }

  /** Prints through the system: phones and tablets hand the PDF to their print sheet (anchored on iPad). */
  async print(anchor?: Anchor) {
    const { host } = this;
    if (host.draft()) {
      host.notify('Aplica o descarta la edición antes de imprimir el PDF.');
      return;
    }
    const doc = host.current();
    if (!doc || host.busy()) return;
    if (!doc.canPrint) {
      host.notify('Este PDF no permite imprimir.', 'error');
      return;
    }
    host.setBusy('print');
    try {
      if (isNative && isMobile) {
        if (isNativePdfDocument(doc.pdf)) await this.presentFileBacked(doc, 'print', anchor);
        else await printPdf(await this.annotated(doc), doc.name, doc.nativeSource, anchor);
      }
      // Print the PDF's own bytes: the reader's preview leaves out its original annotations.
      else
        await printRendered(
          doc.canAnnotate ? await this.annotated(doc) : new Uint8Array(doc.bytes),
          doc.password,
          (page, total) => host.notify(`Preparando impresión… página ${page} de ${total}`),
          host.dismissNotice,
        );
    } catch (error) {
      host.notify(errorMessage(error, 'No se pudo preparar la impresión.'), 'error');
    } finally {
      host.setBusy(null);
    }
  }

  /** The system's share sheet (anchored on iPad). */
  async share(anchor?: Anchor) {
    const { host } = this,
      doc = host.current();
    if (!doc || host.busy() || this.saving) return;
    host.setBusy('download');
    try {
      if (isNativePdfDocument(doc.pdf)) await this.presentFileBacked(doc, 'share', anchor);
      else await sharePdf(await this.annotated(doc), doc.name, doc.nativeSource, anchor);
    } catch (error) {
      host.notify(errorMessage(error, 'No se pudo compartir el PDF.'), 'error');
    } finally {
      host.setBusy(null);
    }
  }
}
