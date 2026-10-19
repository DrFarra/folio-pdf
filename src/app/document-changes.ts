import { remapBookmarks } from '../bookmarks';
import { processPdf } from '../engine/client';
import type { Operation, PageEntry } from '../engine/operations.ts';
import { isNativePdfDocument } from '../nativePdf';
import { formatSize } from '../pdf';
import type { Annotation, BookmarkNode, LoadedDocument } from '../types';
import { annotationFingerprint, uid, type History, type OpenContext } from './model';
import type { Notify } from './notices';

/** What changing the PDF needs from the app around it. */
export type ChangesHost = {
  current: () => LoadedDocument | null;
  annotations: () => Annotation[];
  setAnnotations: (annotations: Annotation[]) => void;
  reading: () => { page: number; bookmarks: BookmarkNode[] };
  /** The PDF with Folio's annotations written into it. */
  annotated: (doc: LoadedDocument) => Promise<Uint8Array>;
  open: (
    bytes: Uint8Array,
    name: string,
    sample: boolean,
    token: string | undefined,
    context: OpenContext,
  ) => Promise<boolean | undefined>;
  setBusy: (busy: boolean) => void;
  /** Editar PDF is open (`workbench`), and Editar on the reader (`editing`). */
  workbench: () => boolean;
  editing: () => boolean;
  /** Shows a tool section, Editar PDF ('edit-pdf') or none. */
  setWorkbench: (section: string | null) => void;
  resetTool: () => void;
  /** Records an undo step; false when it is too large to keep. */
  record: (step: History) => boolean;
  /** Which stack an undo step came from, for its failure message. */
  isRedo: (stack: History[]) => boolean;
  changed: () => void;
  notify: Notify;
};

/** Changes to the PDF itself: a tool's operation, a result to put in its place, an undo
 * step's snapshot, and Editar's written copy. Each reopens the document in its own tab,
 * keeping the reader where it was and the annotations Folio keeps beside the PDF. */
export class DocumentChanges {
  /** Set on each render, as EditStore's actions are. */
  host!: ChangesHost;

  /** The document as an undo step that holds its PDF. */
  snapshot(): History {
    const { host } = this,
      doc = host.current()!,
      { page, bookmarks } = host.reading();
    return { bytes: doc.bytes, password: doc.password, annotations: host.annotations(), page, bookmarks };
  }

  /** Reopens `doc` with new bytes in place of its copy. */
  private reopen(doc: LoadedDocument, bytes: Uint8Array, context: OpenContext) {
    return this.host.open(bytes, doc.name, doc.sample, doc.nativeSource, {
      id: doc.id,
      draftSource: doc.draftSource,
      modified: true,
      useSession: false,
      preserveHistory: true,
      ...context,
    });
  }

  /** Reopens an undo step's PDF; on failure the current revision stays open and the step stays available. */
  async restore(step: History, from: History[], to: History[]) {
    const { host } = this,
      doc = host.current();
    if (!doc || !step.bytes) return;
    const keepEditing = host.workbench(),
      quiet = host.editing();
    host.setBusy(true);
    try {
      if (
        !(await this.reopen(doc, step.bytes, {
          password: step.password,
          page: quiet ? host.reading().page : step.page,
          bookmarks: step.bookmarks,
          quiet,
        }))
      ) {
        to.pop();
        from.push(step);
        host.notify(host.isRedo(from) ? 'No se pudo rehacer el cambio.' : 'No se pudo deshacer el cambio.', 'error');
        return;
      }
      host.setAnnotations(step.annotations);
      if (keepEditing) host.setWorkbench('edit-pdf');
    } finally {
      host.setBusy(false);
      host.changed();
    }
  }

  /** The reader opens the PDF Editar wrote, keeping the annotations and the view. */
  async reopenWritten(doc: LoadedDocument) {
    const { host } = this,
      annotations = host.annotations(),
      { page, bookmarks } = host.reading();
    host.setBusy(true);
    try {
      if (await this.reopen(doc, doc.bytes, { password: doc.password, page, bookmarks, quiet: true }))
        host.setAnnotations(annotations);
    } finally {
      host.setBusy(false);
    }
  }

  /** Runs a tool's operation on the PDF (its annotations written in first) and opens the result.
   * `keepEditing` returns to Editar PDF at `page`; `quiet` keeps the reader as it is. */
  async apply(
    operation: Operation,
    signal?: AbortSignal,
    context?: { keepEditing?: boolean; page?: number; quiet?: boolean },
  ) {
    const { host } = this,
      doc = host.current();
    if (!doc) return;
    if (isNativePdfDocument(doc.pdf)) throw new Error('Esta herramienta no está disponible para PDF tan grandes.');
    const before = this.snapshot();
    host.setBusy(true);
    try {
      // The bytes already hold the annotations they were opened with; only changes need writing.
      const unchanged = annotationFingerprint(host.annotations()) === doc.bytesAnnotations;
      const source = unchanged ? doc.bytes : await host.annotated(doc);
      signal?.throwIfAborted();
      const output = await processPdf(source, operation, doc.password, signal);
      signal?.throwIfAborted();
      // An optimized PDF is left as it is: no reload, no undo step.
      if (operation.operation === 'compress' && output.length >= source.length) {
        host.notify('El PDF ya está optimizado; no se redujo su tamaño.');
        host.setWorkbench(null);
        return;
      }
      const bookmarks =
        operation.operation === 'pages' ? remapBookmarks(before.bookmarks || [], operation.plan) : before.bookmarks;
      const password =
        operation.operation === 'protect'
          ? operation.ownerPassword
          : operation.operation === 'unprotect'
            ? ''
            : doc.password;
      const opened = await this.reopen(doc, output, {
        password,
        page: context?.quiet ? host.reading().page : context?.keepEditing ? context.page : before.page,
        bookmarks,
        quiet: context?.quiet,
      });
      if (!opened) throw new Error('No se pudo cargar el resultado de la operación.');
      if (!host.record(before))
        host.notify('Este cambio no se podrá deshacer porque el documento es demasiado grande.');
      if (!context?.quiet) {
        host.setWorkbench(context?.keepEditing ? 'edit-pdf' : null);
        host.resetTool();
      }
      if (operation.operation === 'compress')
        host.notify(`PDF reducido de ${formatSize(source.length)} a ${formatSize(output.length)}.`, 'success');
    } finally {
      host.setBusy(false);
    }
  }

  /** Puts a tool's finished PDF in place of the document, or (`extraction`) opens the extracted pages in a new tab. */
  async replace(bytes: Uint8Array, context?: { extraction?: { name: string; plan: PageEntry[] } }) {
    const { host } = this,
      doc = host.current();
    if (!doc) return;
    host.setBusy(true);
    try {
      const before = this.snapshot();
      if (context?.extraction) {
        const { name, plan } = context.extraction;
        // A derived PDF owns its session and draft. Loading it retains the source
        // tab, including its annotation history, bookmarks and reading view.
        const opened = await host.open(bytes, name, false, undefined, {
          id: uid(),
          modified: true,
          draftSource: true,
          useSession: false,
          page: 1,
          bookmarks: remapBookmarks(before.bookmarks || [], plan),
        });
        if (!opened) throw new Error('No se pudo abrir el PDF con las páginas extraídas.');
        host.setWorkbench(null);
        host.notify('Páginas extraídas en una pestaña nueva.', 'success');
        return;
      }
      const { page, bookmarks } = host.reading();
      if (!(await this.reopen(doc, bytes, { page, bookmarks }))) throw new Error('No se pudo abrir el resultado.');
      host.setWorkbench(null);
      if (!host.record(before))
        host.notify('Este cambio no se podrá deshacer porque el documento es demasiado grande.');
    } finally {
      host.setBusy(false);
    }
  }
}
