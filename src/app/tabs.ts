import { errorMessage } from '../errors';
import type { LoadedDocument } from '../types';
import { saveAdvice, type DocumentTab } from './model';
import type { Notify } from './notices';
import type { Persistence } from './persistence';

/** What the open tabs need from the app around them. */
export type TabsHost = {
  /** The active tab as it is now on screen (its entry holds it as it was when last left). */
  capture: () => DocumentTab | null;
  /** Shows a tab (`focus`: its tab button takes keyboard focus), or, with none left, the library. */
  show: (tab: DocumentTab, focus?: boolean) => void;
  empty: () => void;
  publish: (tabs: DocumentTab[]) => void;
  /** An edit waits to be applied or discarded. */
  draft: () => boolean;
  /** An operation, an open or a dialog is in the way. */
  occupied: () => boolean;
  /** Leaves Editar PDF, and closes Editar's live document when `live`, before the tab changes. */
  leaveEditor: (live: boolean) => Promise<void>;
  /** Closing waits while the tab's changes are stored. */
  setClosing: (closing: boolean) => void;
  /** The tab, or 'window', could not store its changes: the user decides whether to close anyway. */
  closeBlocked: (key: string) => void;
  /** The active tab's changes could not be stored. */
  storeFailed: () => void;
  /** A document was brought to the front: the library lists it as used now. */
  used: (doc: LoadedDocument) => void;
  persistence: Persistence;
  notify: Notify;
};

/** The open documents, one tab each: switching, closing and reordering them, and storing
 * each one's changes on the way. The active tab's entry is brought up to date (`retain`)
 * before anything reads the list. */
export class Tabs {
  /** Set on each render, as EditStore's actions are. */
  host!: TabsHost;
  list: DocumentTab[] = [];
  activeKey: string | null = null;
  /** Drive edits of closed tabs still being prepared; quitting waits for them. */
  closing = new Set<Promise<boolean>>();

  find(key: string) {
    return this.list.find(tab => tab.key === key);
  }
  /** The open tab holding a document, by its id. */
  holding(id: string) {
    return this.list.find(tab => tab.doc.id === id);
  }

  /** Brings the active tab's entry up to date with the screen. */
  retain() {
    const current = this.host.capture();
    if (current) this.list = this.list.map(tab => (tab.key === current.key ? current : tab));
  }
  publish() {
    this.host.publish([...this.list]);
  }

  /** Stores a tab without making anyone wait: an open document stays in memory, so a failure
   * only marks the tab (and is reported once) until the next successful write. */
  storeInBackground(tab: DocumentTab) {
    const { host } = this;
    void host.persistence.tab(tab, false).catch(error => {
      this.list = this.list.map(item => (item.key === tab.key ? { ...item, sessionFailed: true } : item));
      if (this.activeKey === tab.key) host.storeFailed();
      if (!tab.sessionFailed) host.notify(`${errorMessage(error)} ${saveAdvice}`, 'error');
    });
  }

  async switchTo(key: string) {
    const { host } = this;
    if (host.draft()) {
      host.notify('Aplica o descarta la edición antes de cambiar de documento.');
      return;
    }
    if (key === this.activeKey || host.occupied()) return;
    const next = this.find(key);
    if (!next) return;
    await host.leaveEditor(true);
    const focus = document.activeElement?.getAttribute('role') === 'tab';
    const current = host.capture();
    this.retain();
    host.show(next, focus);
    this.publish();
    if (current) this.storeInBackground(current);
    host.used(next.doc);
  }

  /** The tab after (`step` 1) or before (-1) the active one, wrapping around. */
  neighbour(step: 1 | -1) {
    const index = this.list.findIndex(tab => tab.key === this.activeKey);
    return this.list[(index + this.list.length + step) % this.list.length];
  }

  /** Closes a tab once its changes are stored (`discard`: without storing them). */
  async close(key: string, discard = false) {
    const { host } = this;
    if (host.draft()) {
      host.notify('Aplica o descarta la edición antes de cerrar el documento.');
      return;
    }
    if (host.occupied()) return;
    const index = this.list.findIndex(tab => tab.key === key);
    if (index < 0) return;
    await host.leaveEditor(key === this.activeKey);
    this.retain();
    const closed = this.list[index];
    if (!discard) {
      // Closing releases the document, so its session and draft must be stored
      // first. Actions wait meanwhile, without the reader's «Abriendo PDF…».
      try {
        host.setClosing(true);
        await host.persistence.tab(closed, false);
      } catch (error) {
        if (this.activeKey !== key) {
          host.show(closed);
          this.publish();
        }
        host.notify(errorMessage(error), 'error');
        host.closeBlocked(key);
        return;
      } finally {
        host.setClosing(false);
      }
    }
    this.list = this.list.filter(tab => tab.key !== key);
    if (this.activeKey === key) {
      const next = this.list[Math.min(index, this.list.length - 1)];
      if (next) host.show(next);
      else host.empty();
    }
    this.publish();
    // A closed Drive document becomes a pending edit in the background; its PDF
    // stays loaded until that export finishes, and quitting waits for it.
    const staged =
      !discard && closed.doc.drive?.editable
        ? host.persistence.tab(closed).then(
            () => true,
            () => {
              host.notify(
                `No se pudo preparar la edición de «${closed.doc.name}» para Drive. Tus anotaciones se conservan: ábrelo de nuevo para guardarlo en Drive.`,
                'error',
              );
              return false;
            },
          )
        : Promise.resolve(true);
    this.closing.add(staged);
    void staged.then(() => {
      this.closing.delete(staged);
      setTimeout(() => {
        void closed.doc.pdf.loadingTask.destroy();
      }, 200);
    });
  }

  /** Drops the tabs of documents removed from the library, without storing them. True when the active one went. */
  discard(ids: Set<string>) {
    const removed = this.list.filter(tab => ids.has(tab.doc.id));
    const activeRemoved = removed.some(tab => tab.key === this.activeKey);
    this.list = this.list.filter(tab => !ids.has(tab.doc.id));
    if (activeRemoved && this.list.length) this.host.show(this.list[0]);
    else if (activeRemoved) this.host.empty();
    this.publish();
    for (const tab of removed) setTimeout(() => void tab.doc.pdf.loadingTask.destroy(), 200);
    return activeRemoved;
  }

  /** Puts the tabs in the order of `keys`, which must name each open tab once. */
  reorder(keys: string[], retain: boolean) {
    if (keys.length !== this.list.length || new Set(keys).size !== keys.length || keys.some(key => !this.find(key)))
      return;
    if (retain) this.retain();
    const current = new Map(this.list.map(tab => [tab.key, tab]));
    this.list = keys.map(key => current.get(key)!);
    this.publish();
  }

  /** Stores every tab, Drive edits included; the first that fails is returned, with why. */
  async storeAll() {
    this.retain();
    let failed: DocumentTab | undefined, cause: unknown;
    for (const tab of this.list) {
      try {
        await this.host.persistence.tab(tab);
      } catch (error) {
        if (!failed) {
          failed = tab;
          cause = error;
        }
      }
    }
    return failed && { tab: failed, cause };
  }
}
