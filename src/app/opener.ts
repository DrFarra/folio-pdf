import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import { driveLookup } from '../drive';
import { errorMessage } from '../errors';
import { isNative } from '../platform';
import { rememberDocument } from '../storage';
import type { LoadedDocument } from '../types';
import type { PasswordRequest } from '../components/DocumentDialogs';
import { readDocument, type OpenSource } from './document-reader';
import { SAMPLE_NAME, uid, type DocumentTab, type History, type OpenContext, type TabView } from './model';
import type { Notify } from './notices';
import { openedDocument, openedTab, openingSession } from './opened-document';
import type { Persistence } from './persistence';
import type { Tabs } from './tabs';

/** What opening a document needs from the app around it. */
export type OpenerHost = {
  tabs: Tabs;
  persistence: Persistence;
  /** An edit waits to be applied or discarded. */
  draft: () => boolean;
  /** Leaves Editar PDF before another document opens in its place. */
  leaveEditor: () => Promise<void>;
  /** «Abriendo PDF…» (`cover`: over the reader; an edit reopening its document does not cover it). */
  setLoading: (loading: boolean, cover: boolean) => void;
  askPassword: (request: PasswordRequest | null) => void;
  /** The document in front, its view, and its undo history. */
  current: () => LoadedDocument | null;
  view: () => TabView;
  history: () => { undo: History[]; redo: History[] };
  /** The active tab as it is now on screen. */
  capture: () => DocumentTab | null;
  /** Brings an open tab to the front. */
  show: (tab: DocumentTab) => void;
  /** Shows a newly opened tab; `previous` is the tab in front before it. */
  present: (
    tab: DocumentTab,
    how: { replacing: boolean; quiet: boolean; resumeEditing: boolean; previous: DocumentTab | null },
  ) => void;
  preferences: () => {
    restorePage: boolean;
    mode: TabView['readingMode'];
    defaultZoom: string;
    panel: DocumentTab['sideTab'] | 'closed';
    rememberRecent: boolean;
  };
  /** Documents removed from the library, and those whose stored session could not be read. */
  forgotten: Set<string>;
  unread: Set<string>;
  /** Adds a library entry, after the entries already queued. */
  remember: (store: () => Promise<void>) => void;
  notify: Notify;
};

/** Opening documents, one at a time and in the order asked: a newer open replaces one still
 * running. A document already in a tab is shown there instead; an edit, an undo or a save
 * reopens the document in its own tab (`context.preserveHistory`, `savedCopy`). */
export class DocumentOpener {
  /** Set on each render, as EditStore's actions are. */
  host!: OpenerHost;
  /** How many opens were asked for: a running one is current while it is the last. */
  requests = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private engine: AbortController | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private cancelled = false;

  open(source: OpenSource, name = SAMPLE_NAME, sample = false, nativeSource?: string, context?: OpenContext) {
    const operation = this.queue.catch(() => {}).then(() => this.load(source, name, sample, nativeSource, context));
    this.queue = operation;
    return operation;
  }

  /** The password was not given: the open stops, quietly. */
  cancel() {
    this.cancelled = true;
    this.engine?.abort();
    void this.task?.destroy();
    this.host.askPassword(null);
    this.host.setLoading(false, true);
  }

  // The PDF.js load in progress, given up when another starts or it fails.
  private dropTask() {
    void this.task?.destroy();
    this.task = null;
  }

  /** Opens a document. True when it is shown (opened, or found in a tab), false when it
   * failed, undefined when a newer open replaced it. */
  private async load(
    source: OpenSource,
    name: string,
    sample: boolean,
    nativeSource?: string,
    context?: OpenContext,
  ): Promise<boolean | undefined> {
    const { host } = this,
      { tabs } = host;
    if (host.draft() && !context?.preserveHistory) {
      host.notify('Aplica o descarta la edición antes de abrir otro documento.');
      return false;
    }
    if (!context?.preserveHistory) await host.leaveEditor();
    const request = ++this.requests,
      current = () => request === this.requests;
    this.engine?.abort();
    const controller = new AbortController();
    this.engine = controller;
    this.dropTask();
    this.cancelled = false;
    host.askPassword(null);
    // An edit reopens the document in place, without covering the reader.
    host.setLoading(true, !context?.quiet);
    const done = () => {
      host.setLoading(false, true);
      this.task = null;
    };
    try {
      const prior = host.current();
      if (prior && !context?.preserveHistory && !context?.savedCopy) {
        const priorTab = host.capture();
        if (priorTab) tabs.storeInBackground(priorTab);
      }
      const nativeInput = typeof source === 'object' && 'token' in source ? source : null;
      nativeSource = nativeInput?.token || nativeSource;
      const drive =
        context?.drive ||
        (context?.preserveHistory ? prior?.drive : undefined) ||
        (nativeSource && isNative ? await driveLookup(nativeSource) : undefined) ||
        undefined;
      // A document already in a tab is shown there instead of opened twice.
      const showTab = (id: string) => {
        const existing = tabs.holding(id);
        if (!existing) return false;
        // Keeping the current tab replaces its entry: the one to show is found again.
        tabs.retain();
        host.show(tabs.find(existing.key)!);
        tabs.publish();
        done();
        return true;
      };
      if (!context && nativeInput?.id && !drive && showTab(nativeInput.id)) return true;
      const read = await readDocument({
        source,
        name,
        nativeSource,
        drive,
        context,
        signal: controller.signal,
        current,
        isOpen: id => !!tabs.holding(id),
        onTask: task => {
          this.task = task;
        },
        askPassword: ask => host.askPassword({ name, ...ask }),
        onRecovered: () => host.notify('Se recuperaron tus cambios sin guardar.'),
      });
      if (!read) return;
      if ('open' in read) {
        showTab(read.open);
        return true;
      }
      const { pdf, originalBytes, id, size, modified, inspection, fileBacked } = read;
      nativeSource = read.nativeSource;
      const existing = context ? undefined : tabs.holding(id);
      if (existing) {
        // Avoid closing the native token shared by the existing adapter.
        if (!fileBacked || existing.doc.nativeSource !== nativeSource) await pdf.loadingTask.destroy();
        showTab(id);
        return true;
      }
      const first = await pdf.getPage(1),
        page = first.getViewport({ scale: 1 });
      if (!current()) {
        await pdf.loadingTask.destroy();
        return;
      }
      const preferences = host.preferences();
      const { session, unread } = await openingSession(
        id,
        inspection.annotations,
        context?.useSession === false ? context : null,
        !!context || preferences.restorePage,
      );
      if (unread)
        host.notify(
          'No se pudieron cargar las anotaciones guardadas de este PDF. Ciérralo y vuelve a abrirlo antes de hacer cambios, o se reemplazarán.',
          'error',
        );
      if (!current()) {
        await pdf.loadingTask.destroy();
        return;
      }
      const opened = openedDocument(read, session, {
        name,
        sample: sample || source === 'sample',
        drive,
        draftSource: context?.draftSource,
        fresh: context?.useSession === false,
      });
      const doc = opened.doc;
      // A recovered draft is already on disk: writing it back sends the whole PDF to Folio again,
      // which on Windows holds the window for seconds (238 MB: it stopped answering and closed).
      if (!context && modified) host.persistence.stored(doc);
      const replacing = !!context?.preserveHistory || !!context?.savedCopy;
      // Opening a document again after deleting its local copy starts a new record.
      if (!replacing) host.forgotten.delete(id);
      if (unread) host.unread.add(id);
      else host.unread.delete(id);
      const previousTab = host.capture();
      tabs.retain();
      const previous = replacing ? host.current() : null;
      const key = replacing && tabs.activeKey ? tabs.activeKey : uid();
      const { undo, redo } = host.history();
      const tab = openedTab({
        key,
        doc,
        opened,
        dimensions: { width: page.width, height: page.height, rotation: first.rotate },
        current: host.view(),
        previous: previousTab,
        replacing,
        undo,
        redo,
        preferences,
      });
      host.present(tab, {
        replacing,
        quiet: !!context?.quiet,
        resumeEditing: !!context?.keepEditing && !fileBacked,
        previous: previousTab,
      });
      done();
      tabs.list = replacing ? tabs.list.map(item => (item.key === key ? tab : item)) : [...tabs.list, tab];
      tabs.publish();
      if (previous)
        setTimeout(() => {
          void previous.pdf.loadingTask.destroy();
        }, 200);
      if (!doc.sample) {
        // With the library preference off, opened PDFs leave no copy behind; PDFs created in Folio are still kept.
        if (
          (preferences.rememberRecent || context?.modified) &&
          !context?.preserveHistory &&
          !(context?.modified && nativeSource)
        )
          host.remember(async () => {
            if (host.forgotten.has(id)) return;
            await rememberDocument({
              id,
              name,
              size,
              pages: pdf.numPages,
              openedAt: Date.now(),
              nativeSource: nativeInput?.token || nativeSource,
              data: nativeSource
                ? undefined
                : new Blob([originalBytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
            });
          });
        if (inspection.signed) host.notify('PDF firmado: modo lectura.');
        else if (!inspection.canAnnotate) host.notify('PDF abierto en modo lectura según sus permisos.');
      }
      return true;
    } catch (error) {
      if (!current()) return;
      if (!this.cancelled) {
        console.error('Folio: no se pudo abrir el PDF.', error);
        host.notify(`No se pudo abrir «${name}». ${errorMessage(error, 'El archivo puede estar dañado.')}`, 'error');
      }
      this.dropTask();
      host.setLoading(false, true);
      host.askPassword(null);
      return false;
    }
  }
}
