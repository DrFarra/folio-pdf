import type { RecentDocument, Session } from './types';
import { invoke } from '@tauri-apps/api/core';
import { isNative } from './platform';
import { normalizeBookmarks } from './bookmarks';

const PREFIX = 'folio.session.';
const EMPTY: Session = { annotations: [], bookmarks: [], lastPage: 1 };

const revisions = new Map<string, number>();
type StoredRecent = Omit<RecentDocument, 'data'> & { data?: Blob | ArrayBuffer };
function recentDocument(value: StoredRecent): RecentDocument {
  return { ...value, data: value.data instanceof ArrayBuffer ? new Blob([value.data], { type: 'application/pdf' }) : value.data };
}
function nativeBaseline(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const rows = JSON.parse(value);
    if (Array.isArray(rows) && rows.every(row => Array.isArray(row) && row.length >= 6 && typeof row[0] === 'string' && Number.isInteger(row[1]) && ['highlight', 'note'].includes(row[2]) && Array.isArray(row[3]) && row[3].length === 4 && row[3].every(Number.isFinite))) return value;
  } catch { /* A damaged baseline does not prevent opening the PDF. */ }
}
function parseSession(raw: Partial<Session> | null): Session {
    if (!raw || !Array.isArray(raw.annotations) || !Array.isArray(raw.bookmarks)) return { ...EMPTY };
    return {
      version: raw.version,
      documentRevision: typeof raw.documentRevision === 'string' ? raw.documentRevision : undefined,
      annotations: raw.annotations.filter(a =>
        typeof a.id === 'string' && Number.isInteger(a.page) && Number(a.page) > 0 &&
        (a.kind === 'note' || a.kind === 'highlight') && typeof a.text === 'string' &&
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
export async function readSession(id: string): Promise<Session> {
  if (isNative) {
    const raw = await invoke<(Session & { revision?: number }) | null>('load_session', { id });
    revisions.set(id, raw?.revision || 0);
    return parseSession(raw);
  }
  try { return parseSession(JSON.parse(localStorage.getItem(PREFIX + id) || 'null')); }
  catch { return { ...EMPTY }; }
}
export async function saveSession(id: string, session: Session): Promise<boolean> {
  const revision = Math.max((revisions.get(id) || 0) + 1, Date.now() * 1000);
  revisions.set(id, revision);
  const data = { ...session, bookmarks: normalizeBookmarks(session.bookmarks), version: 3, revision };
  try {
    if (isNative) await invoke('store_session', { id, session: data });
    else localStorage.setItem(PREFIX + id, JSON.stringify(data));
    return true;
  } catch { return false; }
}

// Drafts hold real modified PDF bytes, separately from the original on disk.
export async function readDraft(id: string): Promise<Uint8Array | null> {
  if (isNative) {
    const bytes = new Uint8Array(await invoke<ArrayBuffer>('load_draft', { id }));
    return bytes.length ? bytes : null;
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readonly'), request = tx.objectStore('drafts').get(id);
    request.onsuccess = async () => {
      try { resolve(request.result ? new Uint8Array(request.result instanceof Blob ? await request.result.arrayBuffer() : request.result) : null); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(request.error); tx.oncomplete = () => db.close();
  });
}
export async function storeDraft(id: string, bytes: Uint8Array): Promise<void> {
  if (isNative) { await invoke('store_draft', new Uint8Array(bytes), { headers: { 'x-folio-draft-id': id } }); return; }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(new Uint8Array(bytes).buffer, id);
    tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
export async function discardDraft(id: string): Promise<void> {
  if (isNative) { await invoke('discard_draft', { id }); return; }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').delete(id);
    tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('folio-library', 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('documents')) request.result.createObjectStore('documents', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Almacenamiento bloqueado'));
  });
}

export async function listRecent(): Promise<RecentDocument[]> {
  if (isNative) return invoke<RecentDocument[]>('recent_documents');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('documents', 'readonly');
    const request = tx.objectStore('documents').getAll();
    request.onsuccess = () => resolve((request.result as StoredRecent[]).map(recentDocument).sort((a, b) => b.openedAt - a.openedAt));
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function rememberDocument(doc: RecentDocument): Promise<void> {
  if (isNative) {
    if (doc.nativeSource) await invoke('remember_document', { id: doc.id, token: doc.nativeSource, pages: doc.pages, openedAt: doc.openedAt });
    else if (doc.draft) await invoke('remember_draft', { id: doc.id, name: doc.name, pages: doc.pages, openedAt: doc.openedAt });
    return;
  }
  const recents = await listRecent();
  // WebKit can fail when cloning file-backed Blobs to IndexedDB. Keep the
  // original PDF as binary bytes, then expose a Blob when the library reads it.
  const stored: StoredRecent = { ...doc, data: doc.data ? await doc.data.arrayBuffer() : undefined };
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite');
    const store = tx.objectStore('documents');
    store.put(stored);
    recents.filter(d => d.id !== doc.id).slice(4).forEach(d => store.delete(d.id));
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export async function forgetDocument(id: string): Promise<void> {
  if (isNative) { await invoke('forget_document', { id }); return; }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite');
    tx.objectStore('documents').delete(id);
    tx.oncomplete = () => { db.close(); localStorage.removeItem(PREFIX + id); void discardDraft(id).then(resolve, reject); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
export async function clearSavedState(): Promise<void> {
  if (isNative) { await invoke('clear_saved_state'); return; }
  for (const recent of await listRecent()) await forgetDocument(recent.id);
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').clear();
    tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
  });
  Object.keys(localStorage).filter(key => key.startsWith(PREFIX)).forEach(key => localStorage.removeItem(key));
}
