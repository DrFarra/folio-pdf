// Web sessions live in the 'sessions' store of the folio-library IndexedDB
// database, keyed by document id. These helpers read them from a test page.
export const storedSessions = page => page.evaluate(() => new Promise(resolve => {
  const request = indexedDB.open('folio-library');
  request.onerror = () => resolve({});
  request.onsuccess = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('sessions')) { db.close(); resolve({}); return; }
    const tx = db.transaction('sessions', 'readonly'), store = tx.objectStore('sessions'), keys = store.getAllKeys(), values = store.getAll();
    tx.oncomplete = () => { db.close(); resolve(Object.fromEntries(keys.result.map((key, index) => [key, values.result[index]]))); };
    tx.onerror = () => { db.close(); resolve({}); };
  };
}));
export const storedSession = async (page, id) => (await storedSessions(page))[id] ?? null;
/** Resolves with [id, session] for the first stored session that matches. */
export async function waitForSession(page, predicate, timeout = 20000) {
  for (const end = Date.now() + timeout; ;) {
    const match = Object.entries(await storedSessions(page)).find(([id, session]) => session && predicate(session, id));
    if (match) return match;
    if (Date.now() > end) throw new Error('No stored session matched in time.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
