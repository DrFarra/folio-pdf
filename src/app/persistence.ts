import { driveStage, driveStageNative } from '../drive';
import { isNativePdfDocument } from '../nativePdf';
import { discardDraft, rememberDocument, saveSession, storeDraft } from '../storage';
import type { Annotation, LoadedDocument } from '../types';
import { annotationFingerprint, here, type DocumentTab } from './model';

/** What storing a tab needs from the app around it. */
export type PersistenceHost = {
  /** Removed from the library: nothing of it is stored again. */
  forgotten: (id: string) => boolean;
  /** Its stored session could not be read: it is kept until the user changes something. */
  unread: (id: string) => boolean;
  /** Shown or held by a tab: a revision replaced since is not worth writing. */
  held: (doc: LoadedDocument) => boolean;
  /** The PDF with `annotations` appended to it, as Drive receives it. */
  annotated: (doc: LoadedDocument, annotations: Annotation[]) => Promise<Uint8Array>;
};

type Write = { signature: string; promise: Promise<void> };

/** Stores what an open document needs to survive Folio closing: its session (annotations,
 * bookmarks, page), its modified PDF as a draft, and for an editable Drive file the edit
 * waiting to be uploaded. Writes of the same state are shared, and each kind is queued so
 * an older one never lands after a newer one. */
export class Persistence {
  /** Set on each render, as EditStore's actions are. */
  host!: PersistenceHost;
  private drafts: Promise<void> = Promise.resolve();
  /** A save is running: the PDF it writes is not stored as a draft as well. */
  holding = false;
  private draftWrites = new WeakMap<LoadedDocument, Promise<void>>();
  private tabWrites = new Map<string, Write>();
  private driveWrites = new Map<string, Write>();

  /** Settles once the drafts queued so far are written or have failed. */
  get draftsWritten() {
    return this.drafts;
  }

  /** `doc`'s bytes already are its stored draft (one recovered on opening): writing them back is skipped. */
  stored(doc: LoadedDocument) {
    this.draftWrites.set(doc, Promise.resolve());
  }

  /** Discards `id`'s draft once the drafts queued before it are written: the document is its file again. */
  discard(id: string): Promise<void> {
    const operation = this.drafts.catch(() => {}).then(() => discardDraft(id));
    this.drafts = operation;
    return operation;
  }

  /** Stores a modified document's PDF as its draft, once per revision. */
  draft(document: LoadedDocument): Promise<void> {
    const { host } = this;
    if (this.holding || !document.modified || isNativePdfDocument(document.pdf) || host.forgotten(document.id))
      return Promise.resolve();
    const existing = this.draftWrites.get(document);
    if (existing) return existing;
    const operation = this.drafts
      .catch(() => {})
      .then(async () => {
        if (host.forgotten(document.id)) return;
        // A revision already replaced (Editar writes one per pause) is not written: the newer one, queued after it, is.
        if (!host.held(document)) return;
        await storeDraft(document.id, document.bytes);
        if (document.draftSource && !host.forgotten(document.id)) {
          await rememberDocument({
            id: document.id,
            name: document.name,
            size: document.size,
            pages: document.pdf.numPages,
            openedAt: Date.now(),
            draft: true,
          });
        }
      });
    this.drafts = operation;
    this.draftWrites.set(document, operation);
    void operation.catch(() => {
      this.draftWrites.delete(document);
    });
    return operation;
  }

  /** Stores a tab's session and draft and, unless `stageDrive` is false, its pending Drive edit. */
  tab(tab: DocumentTab, stageDrive = true): Promise<void> {
    const { host } = this;
    if (host.forgotten(tab.doc.id)) return Promise.resolve();
    const fingerprint = annotationFingerprint(tab.annotations);
    const signature = JSON.stringify([
      tab.doc.revision,
      fingerprint,
      tab.page,
      tab.bookmarks,
      tab.doc.nativeKnownPages,
      tab.doc.nativeOriginalRefs,
      tab.doc.nativeLegacySession,
    ]);
    const key = `${tab.key}:${stageDrive}`;
    const previous = this.tabWrites.get(key);
    if (previous?.signature === signature) return previous.promise;
    const operation = (previous?.promise || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        // Session metadata is small. Persist it before any PDF export, including
        // on Android background events; an earlier failed draft is retryable.
        // A session that could not be read is kept until the user changes something.
        if (!host.unread(tab.doc.id)) {
          const saved = await saveSession(tab.doc.id, {
            annotations: tab.annotations,
            lastPage: tab.page,
            bookmarks: tab.bookmarks,
            documentRevision: tab.doc.revision,
            nativeKnownPages: tab.doc.nativeKnownPages,
            nativeOriginalRefs: tab.doc.nativeOriginalRefs,
            nativeSavedAnnotations: tab.doc.savedAnnotations,
            nativeLegacySession: tab.doc.nativeLegacySession,
          });
          if (!saved) throw new Error(`No se pudieron guardar tus cambios en ${here}.`);
        }
        await this.draft(tab.doc);
        if (!stageDrive || !tab.doc.drive?.editable || (!tab.doc.modified && fingerprint === tab.doc.savedAnnotations))
          return;
        const binding = tab.doc.drive.binding,
          edit = `${tab.doc.revision}:${fingerprint}`;
        const staged = this.driveWrites.get(binding);
        if (staged?.signature === edit) {
          await staged.promise;
          return;
        }
        const stage = (staged?.promise || Promise.resolve())
          .catch(() => {})
          .then(async () => {
            if (isNativePdfDocument(tab.doc.pdf)) {
              if (tab.doc.nativeLegacySession)
                throw new Error(
                  'Guarda el PDF de Drive antes de cerrar para recuperar todas las anotaciones anteriores.',
                );
              const removed = (tab.doc.nativeOriginalRefs || []).filter(
                ref => !tab.annotations.some(a => a.nativeSourceRef === ref),
              );
              await driveStageNative(binding, tab.doc.nativeSource!, tab.annotations, removed);
            } else await driveStage(binding, await host.annotated(tab.doc, tab.annotations));
          });
        this.driveWrites.set(binding, { signature: edit, promise: stage });
        void stage.catch(() => {
          if (this.driveWrites.get(binding)?.promise === stage) this.driveWrites.delete(binding);
        });
        await stage;
      });
    this.tabWrites.set(key, { signature, promise: operation });
    void operation.catch(() => {
      if (this.tabWrites.get(key)?.promise === operation) this.tabWrites.delete(key);
    });
    return operation;
  }
}
