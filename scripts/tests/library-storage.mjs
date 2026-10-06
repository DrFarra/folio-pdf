import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { build, preview } from 'vite';

// Exercise real IndexedDB with the application storage module, including the
// migration of sessions that earlier versions kept in localStorage.
// The blank same-origin page isolates persistence from the reader and workers.
const root = process.cwd();
const output = path.join(root, 'test-results', 'library-storage');
fs.mkdirSync(output, { recursive: true });
const entry = path.join(output, 'storage-qa.ts'), html = path.join(output, 'storage-qa.html');
const previewDirectory = path.resolve(root, '.tools', `library-storage-preview-${process.pid}`);
fs.writeFileSync(entry, "import * as storage from '../../src/storage'; globalThis.__storageQA = storage;");
fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><title>Library storage QA</title></head><body>Storage QA<script type="module" src="./storage-qa.ts"></script></body></html>');
let browser, server;
const results = [];
const engine = process.env.FOLIO_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const report = { passed: false, engine, results, limitations: ['Browser storage checks do not exercise the native filesystem catalog. Its migration and safe hiding are covered by src-tauri Rust unit tests.'] };
if (engine === 'webkit') report.limitations.push('This WebKit runtime cannot persist the old Blob fixture in IndexedDB. Its v1 migration fixture uses ArrayBuffer bytes; Chromium separately verifies the historical Blob format. The production writer also uses ArrayBuffer bytes.');
try {
  await build({logLevel:'error',publicDir:false,build:{outDir:previewDirectory,emptyOutDir:true,rollupOptions:{input:html}}});
  server = await preview({logLevel:'error',build:{outDir:previewDirectory},preview:{host:'127.0.0.1',port:0}});
  const address = server.httpServer.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const executablePath = findChrome();
  browser = process.env.FOLIO_TEST_BROWSER === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  await page.goto(`${origin}/test-results/library-storage/storage-qa.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__storageQA);

  results.push(...await page.evaluate(async legacyBlob => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const id = number => number.toString(16).padStart(64, '0');
    // Seed the previous schema without hidden. Chromium covers historical
    // Blobs; WebKit uses the binary format accepted by its IndexedDB runtime.
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('folio-library', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('documents', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('documents', 'readwrite');
      tx.objectStore('documents').put({ id: id(1), name: 'Legacy.pdf', pages: 2, size: 8, openedAt: 1, data: legacyBlob ? new Blob(['original']) : new TextEncoder().encode('original').buffer });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    const legacySession = { version: 2, annotations: [{ id: 'old', page: 1, kind: 'note', rect: [1, 2, 3, 4], text: 'Legacy note', color: '#4579ba', created: 1 }], bookmarks: [], lastPage: 2 };
    localStorage.setItem(`folio.session.${id(1)}`, JSON.stringify(legacySession));
    localStorage.setItem(`folio.session.${id(2)}`, '{damaged');
    localStorage.setItem('folio.theme', 'dark');
    const storage = window.__storageQA;
    const legacy = (await storage.listLibrary())[0];
    check(legacy?.id === id(1) && legacy.data === undefined && await (await storage.readLibraryData(id(1))).text() === 'original', 'Schema upgrade must move legacy bytes out of the catalog without losing them.');
    check((await storage.readSession(id(1))).annotations[0]?.text === 'Legacy note', 'Schema upgrade must move localStorage sessions into IndexedDB.');
    check(!Object.keys(localStorage).some(key => key.startsWith('folio.session.')) && localStorage.getItem('folio.theme') === 'dark', 'Migrated and damaged sessions must leave localStorage; other preferences stay.');
    for (let number = 2; number <= 25; number++) await storage.rememberDocument({ id: id(number), name: `Document ${number}.pdf`, pages: 2, size: 8, openedAt: number, data: new Blob([`bytes-${number}`]) });
    const all = await storage.listLibrary();
    check(all.length === 25 && all[0].id === id(25) && all.every(document => document.data === undefined), 'The catalog keeps every entry, newest first, without reading PDF bytes.');

    const session = { annotations: [{ id: 'note', page: 2, kind: 'note', rect: [10, 20, 40, 50], text: 'Retained note', color: '#4579ba', created: 1 }], bookmarks: [{ id: 'mark', title: 'Chapter', page: 2, parentId: null, order: 0, color: '#4579ba' }], lastPage: 2 };
    check(await storage.saveSession(id(25), session), 'Session must persist.');
    check(!Object.keys(localStorage).some(key => key.startsWith('folio.session.')), 'Sessions must not use the localStorage quota.');
    const ink = { id: 'ink', page: 1, kind: 'ink', rect: [0, 0, 10, 10], text: '', color: '#2455b5', created: 1, strokeWidth: 2, inkPaths: [Array.from({ length: 20000 }, (_, index) => index / 3)] };
    check(await storage.saveSession(id(24), { annotations: Array.from({ length: 40 }, (_, index) => ({ ...ink, id: `ink-${index}` })), bookmarks: [], lastPage: 1 }), 'A session larger than the localStorage quota must persist.');
    check((await storage.readSession(id(24))).annotations.length === 40, 'A large handwritten session must read back intact.');
    check(await storage.saveSession(id(23), { annotations: [null, session.annotations[0]], bookmarks: [null], lastPage: 1 }), 'A damaged session can be written.');
    check((await storage.readSession(id(23))).annotations.map(item => item.id).join() === 'note', 'Damaged elements are dropped instead of failing the whole session.');
    await storage.storeDraft(id(25), new TextEncoder().encode('modified25'));
    await storage.rememberDocument({ id: id(25), name: 'Renamed.pdf', pages: 2, size: 8, openedAt: 26 });
    const renamed = (await storage.listLibrary()).find(document => document.id === id(25));
    check(renamed.name === 'Renamed.pdf' && await (await storage.readLibraryData(id(25))).text() === 'bytes-25', 'Metadata-only updates must preserve PDF bytes.');
    await storage.touchDocument({ id: id(3), pages: 2 }, 30);
    await storage.touchDocument({ id: id(99), pages: 2 }, 31);
    const touched = await storage.listLibrary();
    check(touched[0].id === id(3) && touched.length === 25, 'Using a document moves it first; touching an unknown id adds nothing.');
    const retained = await storage.readSession(id(25));
    check(retained.lastPage === 2 && retained.annotations[0]?.text === 'Retained note' && retained.bookmarks[0]?.title === 'Chapter', 'Library updates must preserve reading position, notes and bookmarks.');
    check(new TextDecoder().decode(await storage.readDraft(id(25))) === 'modified25', 'Library updates must preserve the modified PDF.');
    return [
      { id: 'legacy-v1-migration', status: 'passed', retainedOriginalBytes: true, storedFormat: legacyBlob ? 'Blob' : 'ArrayBuffer', historicalBlobFormatVerified: legacyBlob },
      { id: 'legacy-local-storage-sessions-migrate', status: 'passed' },
      { id: 'complete-catalog-reads-metadata-only', status: 'passed', catalog: 25 },
      { id: 'sessions-beyond-local-storage-quota', status: 'passed' },
      { id: 'damaged-session-elements-are-dropped', status: 'passed' },
      { id: 'metadata-update-and-last-use-preserve-bytes-session-and-draft', status: 'passed' },
    ];
  }, engine === 'chromium'));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__storageQA);
  results.push(...await page.evaluate(async () => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const id = number => number.toString(16).padStart(64, '0');
    const storage = window.__storageQA;
    const reloaded = await storage.listLibrary();
    check(reloaded.length === 25 && reloaded[0].id === id(3), 'The catalog and its order must survive reload.');
    check(new TextDecoder().decode(await storage.readDraft(id(25))) === 'modified25' && (await storage.readSession(id(25))).lastPage === 2, 'The modified PDF and session must survive reload.');
    await storage.forgetDocument(id(25));
    check((await storage.listLibrary()).length === 24 && !(await storage.listLibrary()).some(document => document.id === id(25)), 'Explicit deletion must remove only its target.');
    check(await storage.readDraft(id(25)) === null && await storage.readLibraryData(id(25)) === null && (await storage.readSession(id(25))).annotations.length === 0, 'Explicit deletion must clear its bytes, draft and session.');
    check(await (await storage.readLibraryData(id(1))).text() === 'original', 'Deleting one copy must preserve other documents.');
    await storage.storeDraft(id(24), new TextEncoder().encode('modified24'));
    await storage.clearSavedState();
    check((await storage.listLibrary()).length === 0 && await storage.readLibraryData(id(1)) === null, 'Clear must remove every catalog entry and its bytes.');
    check(await storage.readDraft(id(24)) === null && (await storage.readSession(id(24))).annotations.length === 0, 'Clear must remove drafts and sessions.');
    return [
      { id: 'catalog-session-and-draft-survive-reload', status: 'passed' },
      { id: 'explicit-delete-clears-only-target-copy-and-changes', status: 'passed' },
      { id: 'clear-removes-every-document', status: 'passed' },
    ];
  }));
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  fs.rmSync(entry,{force:true}); fs.rmSync(html,{force:true});
  assert(path.dirname(previewDirectory) === path.resolve(root,'.tools') && path.basename(previewDirectory).startsWith('library-storage-preview-'));
  fs.rmSync(previewDirectory,{recursive:true,force:true});
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(output, `${engine}-results.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
