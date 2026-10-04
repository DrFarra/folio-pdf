import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright-core';
import { build, preview } from 'vite';

// Exercise real IndexedDB and localStorage with the application storage module.
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
  const executablePath = process.env.CHROME_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(fs.existsSync);
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
    const storage = window.__storageQA;
    const legacy = (await storage.listRecent())[0];
    check(legacy?.id === id(1) && !legacy.hidden && await legacy.data.text() === 'original', 'Schema upgrade must preserve legacy bytes and visible recency.');
    for (let number = 2; number <= 25; number++) await storage.rememberDocument({ id: id(number), name: `Document ${number}.pdf`, pages: 2, size: 8, openedAt: number, data: new Blob([`bytes-${number}`]) });
    const all = await storage.listLibrary(), recent = await storage.listRecent();
    check(all.length === 25 && all.some(document => document.id === id(1)), 'Opening more than five PDFs must not evict older library entries.');
    check(recent.length === 20 && recent[0].id === id(25) && recent[19].id === id(6), 'Only the history response is capped; newest entries come first.');

    const session = { annotations: [{ id: 'note', page: 2, kind: 'note', rect: [10, 20, 40, 50], text: 'Retained note', color: '#4579ba', created: 1 }], bookmarks: [{ id: 'mark', title: 'Chapter', page: 2, parentId: null, order: 0, color: '#4579ba' }], lastPage: 2 };
    check(await storage.saveSession(id(25), session), 'Session must persist.');
    await storage.storeDraft(id(25), new TextEncoder().encode('modified25'));
    await storage.hideRecent(id(25));
    check((await storage.listLibrary()).length === 25, 'Hiding history must leave the full catalog intact.');
    check(!(await storage.listRecent()).some(document => document.id === id(25)), 'Hidden documents must leave Recent.');
    const retained = await storage.readSession(id(25));
    check(retained.lastPage === 2 && retained.annotations[0]?.text === 'Retained note' && retained.bookmarks[0]?.title === 'Chapter', 'Hiding history must preserve reading position, notes and bookmarks.');
    check(new TextDecoder().decode(await storage.readDraft(id(25))) === 'modified25', 'Hiding history must preserve the modified PDF.');
    check(await (await storage.listLibrary()).find(document => document.id === id(25)).data.text() === 'bytes-25', 'Hiding history must preserve original PDF bytes.');
    await storage.rememberDocument({ id: id(25), name: 'Renamed.pdf', pages: 2, size: 8, openedAt: 26 });
    const renamed = (await storage.listLibrary()).find(document => document.id === id(25));
    check(!renamed.hidden && await renamed.data.text() === 'bytes-25', 'Metadata-only updates must preserve PDF bytes and restore recency.');
    await storage.hideRecent(id(25));
    return [
      { id: 'legacy-v1-migration', status: 'passed', retainedOriginalBytes: true, storedFormat: legacyBlob ? 'Blob' : 'ArrayBuffer', historicalBlobFormatVerified: legacyBlob },
      { id: 'complete-catalog-and-bounded-history', status: 'passed', catalog: 25, recents: 20 },
      { id: 'hide-preserves-original-session-and-draft', status: 'passed' },
      { id: 'metadata-update-preserves-bytes-and-restores-recency', status: 'passed' },
    ];
  }, engine === 'chromium'));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__storageQA);
  results.push(...await page.evaluate(async () => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const id = number => number.toString(16).padStart(64, '0');
    const storage = window.__storageQA;
    const reloaded = await storage.listLibrary();
    check(reloaded.length === 25 && reloaded.find(document => document.id === id(25)).hidden, 'The catalog and hidden state must survive reload.');
    check(new TextDecoder().decode(await storage.readDraft(id(25))) === 'modified25', 'The modified PDF must survive reload.');
    await storage.forgetDocument(id(25));
    check((await storage.listLibrary()).length === 24 && !(await storage.listLibrary()).some(document => document.id === id(25)), 'Explicit deletion must remove only its target.');
    check(await storage.readDraft(id(25)) === null && (await storage.readSession(id(25))).annotations.length === 0, 'Explicit deletion must clear its draft and session.');
    check(await (await storage.listLibrary()).find(document => document.id === id(1)).data.text() === 'original', 'Deleting one copy must preserve other documents.');
    await storage.saveSession(id(24), { annotations: [], bookmarks: [], lastPage: 2 });
    await storage.storeDraft(id(24), new TextEncoder().encode('modified24'));
    await storage.hideRecent(id(24));
    await storage.clearSavedState();
    check((await storage.listLibrary()).length === 0 && (await storage.listRecent()).length === 0, 'Clear must include hidden catalog entries.');
    check(await storage.readDraft(id(24)) === null && (await storage.readSession(id(24))).lastPage === 1, 'Clear must include hidden drafts and sessions.');
    return [
      { id: 'catalog-hidden-state-and-draft-survive-reload', status: 'passed' },
      { id: 'explicit-delete-clears-only-target-copy-and-changes', status: 'passed' },
      { id: 'clear-includes-hidden-documents', status: 'passed' },
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
