import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { getDocument, hideAnnotations } from '../pdf';
import { openNativePdf, isNativePdfPasswordError, nativePdfPageAnnotations } from '../nativePdf';
import type { Inspection } from '../engine/mupdf-engine.mjs';
import { inspectOwnedPdf, inspectPdf } from '../engine/client';
import type { DriveBinding } from '../drive';
import { assetUrl, pdfAssetSettings } from '../assets';
import { isNative, isIOS, readNativeDocument, nativeDraftDocument, type NativeDocument } from '../platform';
import { readDraft } from '../storage';

/** What Folio opens: a file the user chose, bytes it made, its sample, or a native file by token. */
export type OpenSource = Blob | Uint8Array | 'sample' | NativeDocument;
/** A password the PDF needs; `submit` retries with the one typed. */
export type PasswordRequest = { retry: boolean; submit: (value: string) => void };

/** iOS keeps PDFs over this size in PDFKit, read from the file, instead of in memory. */
const nativeReadingThreshold = 32 * 1024 * 1024;

export type ReadRequest = {
  source: OpenSource;
  name: string;
  nativeSource?: string;
  drive?: DriveBinding;
  /** Present when Folio reopens a document it already has (an edit, a save, a Drive copy). */
  context?: { id?: string; modified?: boolean; password?: string; revision?: string };
  signal: AbortSignal;
  /** False once a newer open has started: this one stops and releases what it holds. */
  current: () => boolean;
  /** Whether a tab already holds this document. */
  isOpen: (id: string) => boolean;
  onTask: (task: PDFDocumentLoadingTask) => void;
  askPassword: (request: PasswordRequest) => void;
  /** Called when unsaved changes were found and opened instead of the file. */
  onRecovered: () => void;
};
export type ReadDocument = {
  pdf: PDFDocumentProxy;
  bytes: Uint8Array;
  originalBytes: Uint8Array;
  id: string;
  revision: string;
  size: number;
  modified: boolean;
  password: string;
  inspection: Inspection;
  nativeSource?: string;
  /** iOS: the PDF stays in its file, read by PDFKit; `bytes` is empty. */
  fileBacked: boolean;
};

const digest = async (data: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))]
    .map(n => n.toString(16).padStart(2, '0'))
    .join('');

/** Reads and parses a document: its bytes (or its unsaved draft), PDF.js's copy and the engine's inspection.
 * Null when a newer open replaced this one; `{ open }` when, by its content, it is already in a tab. */
export async function readDocument(request: ReadRequest): Promise<ReadDocument | { open: string } | null> {
  const { source, name, drive, context, signal, current } = request;
  const nativeInput = typeof source === 'object' && 'token' in source ? source : null;
  let nativeFile = nativeInput,
    nativeSource = nativeInput?.token || request.nativeSource;
  const fileBacked = isNative && isIOS && !!nativeFile && nativeFile.size > nativeReadingThreshold;
  // Identical PDFs in different Drive files/accounts must never share drafts
  // or annotations. Distinct remote bases also retain separate recovery data.
  const driveId = drive
    ? await digest(new TextEncoder().encode(`${drive.account}:${drive.fileId}:${drive.baseChecksum}`))
    : undefined;
  let bytes = new Uint8Array(0) as Uint8Array;
  let originalBytes = bytes;
  let id: string, revision: string, pdf: PDFDocumentProxy, inspection: Inspection;
  let modified = context?.modified || false;
  let password = context?.password || '';
  let size = 0;
  if (fileBacked) {
    if (!context && nativeInput?.id) {
      const draft = await nativeDraftDocument(driveId || nativeInput.id, name);
      if (draft) {
        nativeFile = draft;
        nativeSource = draft.token;
        modified = true;
        request.onRecovered();
      }
    }
    let opened;
    while (!opened) {
      try {
        opened = await openNativePdf(nativeFile!, password, signal);
      } catch (error) {
        if (!isNativePdfPasswordError(error)) throw error;
        password = await new Promise<string>((resolve, reject) => {
          const cancel = () => reject(new DOMException('Operación cancelada', 'AbortError'));
          signal.addEventListener('abort', cancel, { once: true });
          request.askPassword({
            retry: error.retry,
            submit: value => {
              signal.removeEventListener('abort', cancel);
              resolve(value);
            },
          });
        });
      }
    }
    pdf = opened.pdf;
    request.onTask(pdf.loadingTask);
    id = context?.id || driveId || nativeInput?.id || opened.metadata.id;
    revision = opened.metadata.revision;
    size = opened.metadata.size;
    inspection = {
      ...opened.metadata.permissions,
      canEdit: false,
      canAssemble: false,
      canFill: false,
      signed: opened.metadata.signed,
      pages: opened.metadata.numPages,
      annotations: await nativePdfPageAnnotations(pdf, 1),
    };
  } else {
    // A native file's id is already the SHA-256 of its bytes.
    const knownId = context?.id || driveId || nativeInput?.id;
    // Its draft replaces it, so the draft is looked for first: reading a book's
    // original over IPC only to discard it doubled the time to open it.
    const nativeDraft = !context && isNative && knownId ? await nativeDraftDocument(knownId, name) : null;
    let draftId: string | undefined;
    if (source === 'sample') {
      const response = await fetch(assetUrl('/sample.pdf'));
      if (!response.ok) throw new Error('No se pudo abrir el documento de ejemplo.');
      bytes = new Uint8Array(await response.arrayBuffer());
    } else if (nativeDraft) {
      bytes = await readNativeDocument(nativeDraft);
      modified = true;
      draftId = nativeDraft.id;
      request.onRecovered();
    } else if (nativeFile) bytes = await readNativeDocument(nativeFile);
    else bytes = source instanceof Uint8Array ? source : new Uint8Array(await (source as Blob).arrayBuffer());
    if (!current()) return null;
    if (!nativeDraft) originalBytes = bytes;
    const contentId = knownId ? undefined : await digest(bytes);
    id = knownId || contentId!;
    if (!context && request.isOpen(id)) return { open: id };
    if (!context && !(isNative && knownId)) {
      // A native draft is read in slices, as an opened PDF (one response of hundreds of MB stops
      // the page on Windows), and its id is already the SHA-256 of its bytes.
      const native = isNative ? await nativeDraftDocument(id, name) : null;
      const draft = native ? await readNativeDocument(native) : isNative ? null : await readDraft(id);
      if (draft) {
        bytes = draft;
        modified = true;
        draftId = native?.id;
        request.onRecovered();
      }
    }
    revision =
      (bytes === originalBytes && (context?.revision || nativeInput?.id || contentId)) ||
      draftId ||
      (await digest(bytes));
    size = bytes.length;
    const task = getDocument({ data: new Uint8Array(bytes), password, ...pdfAssetSettings() });
    request.onTask(task);
    task.onPassword = (submit: (value: string) => void, reason: number) => {
      if (current())
        request.askPassword({
          retry: reason === 2,
          submit: value => {
            password = value;
            submit(value);
          },
        });
    };
    pdf = await task.promise;
    try {
      // Bytes read here belong to this load and are lent to the engine; a caller's array is copied.
      if (bytes === source) inspection = await inspectPdf(bytes, password, signal);
      else {
        const { bytes: returned, ...inspected } = await inspectOwnedPdf(bytes, password, signal);
        if (originalBytes === bytes) originalBytes = returned;
        bytes = returned;
        inspection = inspected;
      }
    } catch (error) {
      await pdf.loadingTask.destroy();
      throw error;
    }
    if (inspection.previewBytes) {
      await pdf.loadingTask.destroy();
      const preview = getDocument({ data: inspection.previewBytes, password, ...pdfAssetSettings() });
      request.onTask(preview);
      pdf = await preview.promise;
    }
    hideAnnotations(pdf, inspection.hidden || []);
  }
  if (!current()) {
    await pdf.loadingTask.destroy();
    return null;
  }
  return { pdf, bytes, originalBytes, id, revision, size, modified, password, inspection, nativeSource, fileBacked };
}
