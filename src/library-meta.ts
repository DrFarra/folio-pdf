import type { PDFDocumentProxy } from 'pdfjs-dist';

/** Library presentation data that is not part of a document's session:
 * page-one covers (IndexedDB, regenerated if lost) and small per-viewer
 * preferences (localStorage). Losing any of it never loses a document. */
const DB = 'folio-library-meta', STORE = 'covers';
let database: Promise<IDBDatabase> | null = null;
function open() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(request.error); };
  });
  return database;
}
async function covers<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode), request = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export const readCover = (id: string) => covers<string>('readonly', store => store.get(id)).then(value => typeof value === 'string' ? value : null).catch(() => null);
export const saveCover = (id: string, image: string) => covers('readwrite', store => { store.put(image, id); }).catch(() => {});
export const forgetCover = (id: string) => covers('readwrite', store => { store.delete(id); }).catch(() => {});
export const clearCovers = () => covers('readwrite', store => { store.clear(); }).catch(() => {});

/** Page one as a small JPEG for the library card. */
export async function renderCover(pdf: PDFDocumentProxy, width = 280): Promise<string | null> {
  try {
    const page = await pdf.getPage(1), unscaled = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: width / unscaled.width });
    const canvas = document.createElement('canvas'); canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d'); if (!context) return null;
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    page.cleanup();
    const image = canvas.toDataURL('image/jpeg', .72); canvas.width = canvas.height = 0;
    return image.startsWith('data:image/jpeg') ? image : null;
  } catch { return null; }
}

function readSet(key: string) { try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return new Set<string>(Array.isArray(value) ? value.filter(item => typeof item === 'string') : []); } catch { return new Set<string>(); } }
function writeSet(key: string, value: Set<string>) { try { localStorage.setItem(key, JSON.stringify([...value])); } catch { /* A preference; the library still works. */ } }
export const favoriteIds = () => readSet('folio.library.favorites');
export function setFavorite(id: string, on: boolean) { const ids = favoriteIds(); if (on) ids.add(id); else ids.delete(id); writeSet('folio.library.favorites', ids); return ids; }
export const driveIds = () => readSet('folio.library.drive');
export function markDrive(id: string) { const ids = driveIds(); if (!ids.has(id)) { ids.add(id); writeSet('folio.library.drive', ids); } }
export function forgetLibraryMeta(id: string) {
  for (const key of ['folio.library.favorites', 'folio.library.drive']) { const ids = readSet(key); if (ids.delete(id)) writeSet(key, ids); }
  void forgetCover(id);
}
export function clearLibraryMeta() {
  try { localStorage.removeItem('folio.library.favorites'); localStorage.removeItem('folio.library.drive'); } catch { /* Nothing stored. */ }
  void clearCovers();
}
export type LibraryView = 'grid' | 'list';
export type LibrarySort = 'recent' | 'name' | 'progress';
export const libraryPreference = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => { try { const value = localStorage.getItem(key) as T | null; return value && allowed.includes(value) ? value : fallback; } catch { return fallback; } };
export const saveLibraryPreference = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* A preference. */ } };
