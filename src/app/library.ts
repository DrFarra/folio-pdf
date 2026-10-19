import { advance, type Transfer } from '../components/DriveBrowser';
import { driveLookup, driveOpen, driveStatus, type DriveBinding, type DriveOpened } from '../drive';
import { isNative, nativeDraftDocument, type NativeDocument } from '../platform';
import { preference } from '../preferences';
import { forgetDocument, listLibrary, readDraft, readLibraryData, readLibrarySource, readSession } from '../storage';
import type { RecentDocument } from '../types';
import { annotationFingerprint, type DocumentTab, type OpenContext } from './model';
import type { Notify } from './notices';
import type { OpenSource } from './document-reader';

/** What opening from the library needs from the app around it. */
export type LibraryHost = {
  /** The open tabs, with the active one's latest state kept in its entry (`retain`). */
  tabs: () => DocumentTab[]; activeKey: () => string | null; retain: () => void;
  switchTab: (key: string) => Promise<void>; closeTab: (key: string) => Promise<void>;
  open: (source: OpenSource, name: string, token?: string, context?: OpenContext) => Promise<boolean | undefined>;
  showLibrary: (shown: boolean) => void; showDrive: (shown: boolean) => void;
  driveAvailable: () => boolean;
  /** The Drive download in progress, shown as a card. */
  setTransfer: (update: Transfer | null | ((current: Transfer | null) => Transfer | null)) => void;
  /** A library entry replaced by a newer Drive revision. */
  forgotten: (id: string) => void;
  notify: Notify;
};

type Latest = { file: DriveOpened; replaced: boolean };

/** Opening documents from the library and Google Drive. A Drive PDF may have been saved
 * from another device since this copy was downloaded: without local work pending, Drive
 * is asked for its current revision first, and a newer one opens in place of the old. */
export class Library {
  /** Set on each render, as EditStore's actions are. */
  host!: LibraryHost;

  /** Opens a library entry: its tab if open, its file, or its unsaved changes. */
  async reopen(recent: RecentDocument) {
    const { host } = this;
    try {
      const existing = host.tabs().find(tab => tab.doc.id === recent.id);
      if (existing) {
        // An open tab of a Drive PDF may also be behind another device's save.
        host.retain();
        const tab = host.tabs().find(item => item.key === existing.key) || existing;
        const dirty = tab.doc.modified || annotationFingerprint(tab.annotations) !== tab.doc.savedAnnotations;
        const latest = await this.latestDriveRevision(recent, tab.doc.drive, dirty);
        if (latest?.replaced) { await this.openLatest(latest, recent.id, existing.key); return; }
        host.setTransfer(null);
        host.showLibrary(false); if (existing.key !== host.activeKey()) requestAnimationFrame(() => void host.switchTab(existing.key)); return;
      }
      if (isNative) {
        let source: NativeDocument, recoveredDraft = false;
        try { source = recent.nativeSource ? { token: recent.nativeSource, name: recent.name, size: recent.size } : await readLibrarySource(recent.id); }
        catch (error) { const draft = await nativeDraftDocument(recent.id, recent.name); if (!draft) throw error; source = draft; recoveredDraft = true; }
        // The native catalog has no source tokens: the opened copy tells whether it came from Drive.
        if (!recent.draft && !recoveredDraft) {
          const latest = await this.latestDriveRevision(recent, await driveLookup(source.token).catch(() => null), await sessionUnsaved(recent.id));
          if (latest) { await this.openLatest(latest, recent.id); return; }
        }
        await host.open(source, recent.name, source.token, recent.draft || recoveredDraft ? { id: recent.id, modified: true, draftSource: true } : undefined);
      }
      else if (recent.draft) {
        const draft = await readDraft(recent.id) || await readLibraryData(recent.id);
        if (!draft) throw new Error('No se pudieron recuperar los cambios sin guardar.');
        await host.open(draft, recent.name, undefined, { id: recent.id, modified: true, draftSource: true });
      }
      else {
        const data = await readLibraryData(recent.id);
        if (data) await host.open(data, recent.name);
        else host.notify('Este PDF ya no está en la biblioteca. Vuelve a abrirlo; tus cambios se conservan.', 'error');
      }
    } catch { host.notify('No se pudo reabrir el archivo. Ábrelo de nuevo con Abrir PDF.', 'error'); }
  }

  /** Opens a Drive file (`pending`: an edit waiting to be uploaded, opened as changes). */
  async openDrive(file: DriveOpened, pending = false) {
    const { host } = this;
    const existing = !pending && host.tabs().find(tab => tab.doc.drive?.account === file.account && tab.doc.drive.fileId === file.fileId && tab.doc.drive.baseChecksum === file.baseChecksum);
    if (existing) {
      await host.switchTab(existing.key); host.showLibrary(false); host.showDrive(false);
      host.notify('Este PDF ya está abierto. Ciérralo si quieres cargar otra versión.'); return;
    }
    if (await host.open(file.document, file.document.name, file.document.token, { drive: file, modified: pending, useSession: !pending })) host.showDrive(false);
  }

  /** A pending edit saved from Drive moves the open tabs of that file to the new
   * revision, so their next save does not report a conflict with it. */
  synced(file: DriveOpened) {
    const binding: DriveBinding = { binding: file.binding, account: file.account, fileId: file.fileId, baseChecksum: file.baseChecksum, editable: file.editable };
    for (const tab of this.host.tabs()) if (tab.doc.drive?.account === file.account && tab.doc.drive.fileId === file.fileId) tab.doc.drive = binding;
  }

  /** Reopens the documents that were open when the system ended the app in the background. */
  async restoreOpenTabs(alive: () => boolean) {
    const { host } = this;
    let saved: { ids?: string[]; active?: string; library?: boolean } | null;
    try { saved = JSON.parse(preference('folio.openTabs', 'null')); } catch { return; }
    const { ids = [], active, library: showLibrary } = saved || {};
    if (!ids.length) return;
    const items = await listLibrary().catch(() => [] as RecentDocument[]);
    for (const id of ids) { const recent = items.find(item => item.id === id); if (recent && alive()) await this.reopen(recent); }
    if (!alive() || !host.tabs().length) return;
    const tab = host.tabs().find(item => item.doc.id === active);
    if (tab && tab.key !== host.activeKey()) await host.switchTab(tab.key);
    if (showLibrary) host.showLibrary(true);
  }

  /** Drive's current revision of a file, unless local work is pending or Drive cannot be asked. */
  private async latestDriveRevision(item: { name: string; size: number }, binding: DriveBinding | null | undefined, unsaved: boolean): Promise<Latest | null> {
    const { host } = this;
    if (!isNative || !host.driveAvailable() || !binding || unsaved) return null;
    const status = await driveStatus().catch(() => null);
    if (!status?.account || status.account.id !== binding.account || status.pending.some(pending => pending.binding === binding.binding)) return null;
    host.setTransfer({ name: item.name, phase: 'connect', done: 0, total: item.size, rate: 0, at: performance.now() });
    try {
      const file = await driveOpen(binding.fileId, false, progress => host.setTransfer(current => current && advance(current, progress)));
      host.setTransfer(current => current && { ...current, phase: 'open' });
      return { file, replaced: file.baseChecksum !== binding.baseChecksum };
    } catch {
      host.setTransfer(null);
      host.notify('No se pudo comprobar Google Drive. Se abrió la copia de este dispositivo, que puede no tener los últimos cambios.');
      return null;
    }
  }

  /** Opens Drive's newer revision in place of the older one, which had no local work. */
  private async openLatest(latest: Latest, previousId: string, previousTab?: string) {
    const { host } = this;
    try { await this.openDrive(latest.file); } finally { host.setTransfer(null); }
    const opened = host.tabs().some(tab => tab.doc.drive?.fileId === latest.file.fileId && tab.doc.drive.baseChecksum === latest.file.baseChecksum);
    if (!opened || !latest.replaced) return;
    if (previousTab && host.tabs().some(tab => tab.key === previousTab)) await host.closeTab(previousTab);
    await forgetDocument(previousId).catch(() => {}); host.forgotten(previousId);
    host.notify('Se abrió la versión más reciente guardada en Google Drive.');
  }
}

/** A stored session holds annotations not yet written into the PDF. */
async function sessionUnsaved(id: string) {
  const session = await readSession(id).catch(() => null);
  return !!session?.annotations.length && (session.nativeSavedAnnotations === undefined || annotationFingerprint(session.annotations) !== session.nativeSavedAnnotations);
}
