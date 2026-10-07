import { invokeBinary } from './binary';
import { clearLibraryMeta, forgetLibraryMeta } from './library-meta';
import type { RecentDocument, Session } from './types';
import { invoke } from '@tauri-apps/api/core';
import { isNative } from './platform';
import type { NativeDocument } from './platform';
import { normalizeBookmarks } from './bookmarks';

// Sessions written by earlier web versions; the database upgrade moves them and
// readSession picks up any that a tab of an earlier version writes afterwards.
const LEGACY_SESSION_PREFIX = 'folio.session.';
const EMPTY: Session = { annotations: [], bookmarks: [], lastPage: 1 };
const STORES = ['documents', 'files', 'drafts', 'sessions'];

const revisions = new Map<string, number>();
function nativeBaseline(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const rows = JSON.parse(value);
    if (Array.isArray(rows) && rows.every(row => Array.isArray(row) && row.length >= 6 && typeof row[0] === 'string' && Number.isInteger(row[1]) && ['highlight', 'note', 'ink'].includes(row[2]) && Array.isArray(row[3]) && row[3].length === 4 && row[3].every(Number.isFinite))) return value;
  } catch { /* A damaged baseline does not prevent opening the PDF. */ }
}
function parseSession(raw: Partial<Session> | null): Session {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.annotations) || !Array.isArray(raw.bookmarks)) return { ...EMPTY };
    return {
      version: raw.version,
      documentRevision: typeof raw.documentRevision === 'string' ? raw.documentRevision : undefined,
      annotations: raw.annotations.filter(a => !!a && typeof a === 'object' &&
        typeof a.id === 'string' && Number.isInteger(a.page) && Number(a.page) > 0 &&
        (a.kind === 'note' || a.kind === 'highlight' || a.kind === 'ink' && Array.isArray(a.inkPaths) && a.inkPaths.length > 0 && a.inkPaths.every(path => Array.isArray(path) && path.length >= 4 && path.length <= 20000 && path.length % 2 === 0 && path.every(Number.isFinite)) && Number.isFinite(a.strokeWidth) && a.strokeWidth! > 0 && a.strokeWidth! <= 50 ||
          a.kind === 'shape' && ['rect', 'ellipse', 'line', 'arrow'].includes(a.shape!) && Number.isFinite(a.strokeWidth) && a.strokeWidth! >= 0 && a.strokeWidth! <= 50 &&
          (a.fill == null || /^#[0-9a-f]{6}$/i.test(a.fill)) && (a.line === undefined || Array.isArray(a.line) && a.line.length === 4 && a.line.every(Number.isFinite))) && typeof a.text === 'string' &&
        Array.isArray(a.rect) && a.rect.length === 4 && a.rect.every(Number.isFinite) &&
        typeof a.color === 'string' && /^#[0-9a-f]{6}$/i.test(a.color)),
      bookmarks: normalizeBookmarks(raw.bookmarks),
      lastPage: Number.isInteger(raw.lastPage) && Number(raw.lastPage) > 0 ? Number(raw.lastPage) : 1,
      nativeKnownPages: Array.isArray(raw.nativeKnownPages) ? raw.nativeKnownPages.filter(page => Number.isInteger(page) && page > 0) : undefined,
      nativeOriginalRefs: Array.isArray(raw.nativeOriginalRefs) ? raw.nativeOriginalRefs.filter(ref => typeof ref === 'string') : undefined,
      nativeSavedAnnotations: nativeBaseline(raw.nativeSavedAnnotations),
      nativeLegacySession: raw.nativeLegacySession === true,
    };
}
// Rejects when the stored session cannot be read; the caller opens the PDF without it.
export async function readSession(id: string): Promise<Session> {
  if (isNative) {
    const raw = await invoke<(Session & { revision?: number }) | null>('load_session', { id });
    revisions.set(id, raw?.revision || 0);
    return parseSession(raw);
  }
  type Stored = Partial<Session> & { revision?: number };
  const stored = await transact<Stored | undefined>('sessions', 'readonly', tx => tx.objectStore('sessions').get(id));
  // A tab still running an earlier version keeps writing sessions to localStorage
  // after the upgrade moved them: the newer copy wins, then the key goes.
  let legacy: Stored | null = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_SESSION_PREFIX + id) || 'null'); } catch { /* A damaged legacy copy is ignored. */ }
  if (!legacy || typeof legacy !== 'object') return parseSession(stored ?? null);
  const newer = !stored || (Number(legacy.revision) || 0) > (Number(stored.revision) || 0);
  if (newer) await transact('sessions', 'readwrite', tx => { tx.objectStore('sessions').put(legacy, id); });
  try { localStorage.removeItem(LEGACY_SESSION_PREFIX + id); } catch { /* It is read again next time. */ }
  return parseSession(newer ? legacy : stored ?? null);
}
export async function saveSession(id: string, session: Session): Promise<boolean> {
  const revision = Math.max((revisions.get(id) || 0) + 1, Date.now() * 1000);
  revisions.set(id, revision);
  const data = { ...session, bookmarks: normalizeBookmarks(session.bookmarks), version: 3, revision };
  try {
    if (isNative) await invoke('store_session', { id, session: data });
    else await transact('sessions', 'readwrite', tx => { tx.objectStore('sessions').put(data, id); });
    return true;
  } catch { return false; }
}

// Drafts hold real modified PDF bytes, separately from the original on disk.
export async function readDraft(id: string): Promise<Uint8Array | null> {
  if (isNative) {
    const bytes = new Uint8Array(await invoke<ArrayBuffer>('load_draft', { id }));
    return bytes.length ? bytes : null;
  }
  const value = await transact<Blob | ArrayBuffer | undefined>('drafts', 'readonly', tx => tx.objectStore('drafts').get(id));
  return value ? new Uint8Array(value instanceof Blob ? await value.arrayBuffer() : value) : null;
}
export async function storeDraft(id: string, bytes: Uint8Array): Promise<void> {
  if (isNative) { await invokeBinary('store_draft', bytes, { headers: { 'x-folio-draft-id': id } }); return; }
  await transact('drafts', 'readwrite', tx => { tx.objectStore('drafts').put(new Uint8Array(bytes).buffer, id); });
}
export async function discardDraft(id: string): Promise<void> {
  if (isNative) { await invoke('discard_draft', { id }); return; }
  await transact('drafts', 'readwrite', tx => { tx.objectStore('drafts').delete(id); });
}

// Version 3 keeps the catalog metadata apart from the PDF bytes, so listing the
// library never reads every PDF, and moves sessions out of localStorage's quota.
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('folio-library', 3);
    let legacyKeys: string[] = [];
    request.onupgradeneeded = event => {
      const db = request.result, tx = request.transaction!;
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions');
      if (event.oldVersion >= 3) return;
      const files = tx.objectStore('files'), sessions = tx.objectStore('sessions');
      tx.objectStore('documents').openCursor().onsuccess = ({ target }) => {
        const cursor = (target as IDBRequest<IDBCursorWithValue | null>).result; if (!cursor) return;
        const { data, ...entry } = cursor.value;
        if (data !== undefined) { files.put(data, entry.id); cursor.update(entry); }
        cursor.continue();
      };
      try {
        legacyKeys = Object.keys(localStorage).filter(key => key.startsWith(LEGACY_SESSION_PREFIX));
        for (const key of legacyKeys) {
          try { const session = JSON.parse(localStorage.getItem(key) || 'null'); if (session) sessions.put(session, key.slice(LEGACY_SESSION_PREFIX.length)); }
          catch { /* A damaged legacy session is dropped. */ }
        }
      } catch { legacyKeys = []; }
    };
    request.onsuccess = () => {
      try { for (const key of legacyKeys) localStorage.removeItem(key); } catch { /* The copies are already in the database. */ }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Cierra las otras pestañas de Folio y vuelve a intentarlo.'));
  });
}
// Runs one transaction and resolves with the request returned by run, once committed.
async function transact<T = void>(stores: string | string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => IDBRequest | void): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode), request = run(tx);
    tx.oncomplete = () => { db.close(); resolve(request?.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

// The catalog lists metadata only. A web entry's PDF is read when it is opened.
export async function listLibrary(): Promise<RecentDocument[]> {
  if (isNative) return invoke<RecentDocument[]>('list_library');
  return (await transact<RecentDocument[]>('documents', 'readonly', tx => tx.objectStore('documents').getAll())).sort((a, b) => b.openedAt - a.openedAt);
}
export async function readLibraryData(id: string): Promise<Blob | null> {
  const data = await transact<Blob | ArrayBuffer | undefined>('files', 'readonly', tx => tx.objectStore('files').get(id));
  return data === undefined ? null : data instanceof Blob ? data : new Blob([data], { type: 'application/pdf' });
}

// Native catalog listing reads metadata only. Validate and register the PDF
// selected by the user when it is opened, rather than hashing the whole library.
export async function readLibrarySource(id: string): Promise<NativeDocument> {
  return invoke<NativeDocument>('open_library_document', { id });
}

let persistenceRequested = false;
export async function rememberDocument(doc: RecentDocument): Promise<void> {
  if (isNative) {
    if (doc.nativeSource) await invoke('remember_document', { id: doc.id, token: doc.nativeSource, pages: doc.pages, openedAt: doc.openedAt });
    else if (doc.draft) await invoke('remember_draft', { id: doc.id, name: doc.name, pages: doc.pages, openedAt: doc.openedAt });
    return;
  }
  // WebKit can fail when cloning file-backed Blobs to IndexedDB. Keep the
  // original PDF as binary bytes, then expose a Blob when the library reads it.
  const { data: blob, ...entry } = doc;
  const data = blob ? await blob.arrayBuffer() : undefined;
  await transact(['documents', 'files'], 'readwrite', tx => {
    const store = tx.objectStore('documents'), request = store.get(doc.id);
    request.onsuccess = () => { store.put({ ...request.result, ...entry }); };
    if (data) tx.objectStore('files').put(data, doc.id);
  });
  // Without persistent storage, browsers may evict the library after a period without use.
  if (!persistenceRequested) { persistenceRequested = true; void navigator.storage?.persist?.().catch(() => {}); }
}
// Records the last use of a document that is already in the library.
export async function touchDocument(doc: Pick<RecentDocument, 'id' | 'pages' | 'nativeSource'>, openedAt = Date.now()): Promise<void> {
  if (isNative) { if (doc.nativeSource) await invoke('remember_document', { id: doc.id, token: doc.nativeSource, pages: doc.pages, openedAt }); return; }
  await transact('documents', 'readwrite', tx => {
    const store = tx.objectStore('documents'), request = store.get(doc.id);
    request.onsuccess = () => { if (request.result) store.put({ ...request.result, openedAt }); };
  });
}

export async function forgetDocument(id: string): Promise<void> {
  forgetLibraryMeta(id);
  if (isNative) { await invoke('forget_document', { id }); return; }
  await transact(STORES, 'readwrite', tx => { for (const name of STORES) tx.objectStore(name).delete(id); });
  try { localStorage.removeItem(LEGACY_SESSION_PREFIX + id); } catch { /* Without storage access there is no legacy copy. */ }
  revisions.delete(id);
}
export async function clearSavedState(): Promise<void> {
  clearLibraryMeta();
  if (isNative) { await invoke('clear_saved_state'); return; }
  await transact(STORES, 'readwrite', tx => { for (const name of STORES) tx.objectStore(name).clear(); });
  try { for (const key of Object.keys(localStorage)) if (key.startsWith(LEGACY_SESSION_PREFIX)) localStorage.removeItem(key); } catch { /* Without storage access there is no legacy copy. */ }
  revisions.clear();
}
