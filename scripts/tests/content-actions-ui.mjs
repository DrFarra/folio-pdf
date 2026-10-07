import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { androidTablet, openTabletEditor } from './ui-helpers.mjs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { operateDocument } from '../../src/engine/operations.mjs';
import { inspectDocument, writeAnnotations } from '../../src/engine/mupdf-engine.mjs';

// Synthetic content only. Exercise the actual editor, PDF engine, download and
// native bridge contract; the bridge case does not claim native OS acceptance.
const root = process.cwd(), output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const fixture = await PDFDocument.create(), font = await fixture.embedFont(StandardFonts.HelveticaBold);
for (let n = 1; n <= 2; n++) {
  const page = fixture.addPage([600, 800]);
  page.drawText('ORIGINAL ' + n, { x: 40, y: 700, size: 16, font, color: rgb(0, .2, .4) });
  page.drawText('KEEP NEIGHBOR ' + n, { x: 40, y: 600, size: 14, font });
}
const picture = await PDFDocument.create();
picture.addPage([100, 50]).drawRectangle({ x: 0, y: 0, width: 100, height: 50, color: rgb(0, .7, .2) });
const pictureDoc = new mupdf.PDFDocument(await picture.save()), picturePage = pictureDoc.loadPage(0);
const picturePixels = picturePage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
const imageBytes = new Uint8Array(picturePixels.asPNG());
picturePixels.destroy(); picturePage.destroy(); pictureDoc.destroy();
let original = operateDocument(await fixture.save(), { operation: 'add-image', page: 1, rect: [40, 380, 140, 430], image: imageBytes, fit: 'stretch' });
original = writeAnnotations(original, [{ id: 'actions-note', kind: 'note', page: 1, rect: [500, 600, 520, 620], text: 'KEEP NOTE', color: '#ffcc00', created: 1 }]);
const source = path.join(output, 'content-actions-source.pdf'); fs.writeFileSync(source, original);
const sourceHash = createHash('sha256').update(original).digest('hex');
const useWebKit = process.env.FOLIO_TEST_BROWSER === 'webkit', browserName = useWebKit ? 'WebKit' : 'Chromium';
const saveShortcut = (useWebKit ? 'Meta' : 'Control') + '+s', saveCopyShortcut = (useWebKit ? 'Meta' : 'Control') + '+Shift+s';
// The editor's save button: Descargar on the web, Guardar in the desktop app.
const saveButton = page => page.locator('.edit-pdf-save');
const chrome = findChrome();
if (!useWebKit) assert(chrome, 'Chrome or Edge is required, or set CHROME_PATH.');
const port = process.env.FOLIO_CONTENT_ACTIONS_PORT || '4261', origin = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { windowsHide: true, stdio: 'pipe' });
let browser, log = '', frontendEntry; const results = [], errors = [];
server.stdout.on('data', chunk => { log += chunk; }); server.stderr.on('data', chunk => { log += chunk; });
const textCount = (bytes, text, page = 1) => operateDocument(bytes, { operation: 'text' })[page - 1].split(text).length - 1;
const images = bytes => operateDocument(bytes, { operation: 'page-content', page: 1 }).items.filter(item => item.kind === 'image');
function preserved(bytes) {
  const texts = operateDocument(bytes, { operation: 'text' });
  assert(texts[0].includes('KEEP NEIGHBOR 1') && texts[1].includes('KEEP NEIGHBOR 2'));
  assert(inspectDocument(bytes).annotations.some(note => note.text === 'KEEP NOTE'));
  assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'), sourceHash, 'The original source is immutable.');
}
function pixel(bytes, x, y) {
  const doc = new mupdf.PDFDocument(bytes), page = doc.loadPage(0), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  try { const at = (y * pixmap.getWidth() + x) * 3; return [...pixmap.getPixels().subarray(at, at + 3)]; }
  finally { pixmap.destroy(); page.destroy(); doc.destroy(); }
}
const green = value => value[1] > value[0] + 100 && value[1] > value[2] + 80;
async function picker(page, number = 1) { await page.locator(`.pdf-content-picker[data-page="${number}"][data-picker-state="ready"]`).waitFor({ timeout: 60000 }); }
async function ready(page, intent = 'edit') { await page.locator(`.content-editor[data-intent="${intent}"][data-preview-state="ready"]`).waitFor({ timeout: 60000 }); }
// Touch layouts keep this editor; the desktop edits inside the reader (edit-mode-ui.mjs).
const documentHeader = page => page.locator('.app-header .tablet-document-selector');
async function workspace(page) {
  await page.locator('main.reader .workspace-editor').waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.layout), 'tablet');
  assert.equal(await documentHeader(page).isVisible(), true);
}
async function enter(page) { await openTabletEditor(page); await picker(page); await workspace(page); }
async function selectText(page, number = 1, last = false) {
  const matches = page.getByRole('button', { name: 'Párrafo: ORIGINAL ' + number, exact: true });
  if (last) {
    const tops = await matches.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
    await matches.nth(tops.indexOf(Math.max(...tops))).click();
  } else await matches.first().click();
  await ready(page);
}
async function selectImage(page, copy = false) {
  const matches = page.locator('.pdf-content-item[data-kind="image"][data-editable="true"]');
  const lefts = await matches.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
  await matches.nth(lefts.indexOf(copy ? Math.max(...lefts) : Math.min(...lefts))).click(); await ready(page);
}
async function intent(page, kind) { await page.getByRole('button', { name: kind === 'duplicate' ? 'Duplicar' : kind === 'delete' ? 'Eliminar' : 'Editar', exact: true }).click(); await ready(page, kind); }
async function commit(page, kind = 'edit', number = 1) {
  await ready(page, kind);
  const label = kind === 'duplicate' ? 'Aplicar duplicación' : kind === 'delete' ? 'Aplicar eliminación' : 'Aplicar cambios';
  await page.getByRole('button', { name: label, exact: true }).click(); await picker(page, number);
}
async function savedIdle(page, number = 1) {
  await saveButton(page).click({ trial: true, timeout: 60000 });
  await picker(page, number); await workspace(page);
}
async function save(page, name, keyboard = false, number = 1) {
  const event = page.waitForEvent('download'); void event.catch(() => {});
  if (keyboard) await page.keyboard.press(saveShortcut); else await page.getByRole('button', { name: 'Descargar', exact: true }).click();
  const target = path.join(output, name); await (await event).saveAs(target); await savedIdle(page, number);
  return new Uint8Array(fs.readFileSync(target));
}
async function history(page, direction, number = 1) {
  const previous = await page.locator('.pdf-content-picker').elementHandle();
  await page.getByRole('button', { name: direction, exact: true }).click();
  // The old selector stays mounted while App opens the history snapshot.
  await page.waitForFunction(element => !element.isConnected, previous, { timeout: 60000 });
  await picker(page, number);
}
async function nativeBridge(context) {
  // The Android app: the tablet keeps this editor, and Android reserves every output, the original included.
  await context.addInitScript(({ bytes, name }) => {
    globalThis.isTauri = true;
    const callbacks = new Map(), listeners = new Map(); let id = 0;
    const state = globalThis.__contentActionsNative = { source: bytes, outputs: ['output-original-token', null, 'output-copy-token'], chosen: [], writes: [], originals: [], remembered: [], sessions: [], drafts: [] };
    // Android sends PDFs as base64 (src/binary.ts).
    const payload = args => args?.base64 ? [...atob(args.base64)].map(char => char.charCodeAt(0)) : [...new Uint8Array(args)];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: callback => { callbacks.set(++id, callback); return id; }, unregisterCallback: callback => callbacks.delete(callback),
      invoke: async (command, args, options) => {
        if (command === 'plugin:event|listen') { listeners.set(++id, args); return id; }
        if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
        if (command === 'plugin:window|current_monitor') return { name: 'Test monitor', size: { width: 1360, height: 720 }, position: { x: 0, y: 0 }, workArea: { position: { x: 0, y: 0 }, size: { width: 1360, height: 720 } }, scaleFactor: 1 };
        if (command === 'plugin:window|inner_position') return { x: 0, y: 0 };
        if (command === 'plugin:window|inner_size') return { width: 1360, height: 720 };
        if (command === 'plugin:window|is_fullscreen') return false;
        if (command === 'startup_documents') return [{ token: 'source-token', name, size: bytes.length }];
        if (command === 'read_document') return new Uint8Array(state.source).buffer;
        if (command === 'read_document_range') return new Uint8Array(state.source.slice(args.offset, args.offset + args.length)).buffer;
        if (command === 'android_safe_area') return { bottom: 0 };
        if (['recent_documents', 'list_library', 'pick_documents'].includes(command)) return [];
        if (command === 'load_session') return null;
        if (command === 'load_draft') return new ArrayBuffer(0);
        if (command === 'choose_output') { state.chosen.push(args); return state.outputs.shift() ?? null; }
        if (command === 'write_pdf_copy') { const data = payload(args); state.writes.push({ bytes: data, headers: options?.headers }); return { token: 'output-copy-token', name: 'content-actions-source — copia.pdf', size: data.length }; }
        if (command === 'write_pdf_original') { const data = payload(args); state.originals.push({ bytes: data, headers: options?.headers }); return { token: 'saved-token', name, size: data.length }; }
        if (command === 'remember_document') state.remembered.push(args);
        if (command === 'store_session') state.sessions.push(args);
        if (command === 'store_draft') state.drafts.push({ size: args.length, headers: options?.headers });
        return undefined;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, eventId) => { const item = listeners.get(eventId); if (item) callbacks.delete(item.handler); } };
  }, { bytes: [...original], name: path.basename(source) });
}
async function check(id, run, native = false) {
  if (process.env.FOLIO_CONTENT_ACTIONS_TEST && !new RegExp(process.env.FOLIO_CONTENT_ACTIONS_TEST).test(id)) return;
  const context = await browser.newContext({ ...androidTablet(), acceptDownloads: true });
  if (native) await nativeBridge(context);
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push({ id, message: error.message }));
  try {
    await page.goto(origin);
    if (!native) await page.locator('.app-header input[type=file]').setInputFiles(source);
    await page.getByRole('heading', { name: path.basename(source), exact: true }).waitFor({ timeout: 60000 });
    await page.locator('.loading-overlay').waitFor({ state: 'detached' }); await enter(page);
    results.push({ id, status: 'passed', frontendEntry, ...await run(page) });
  } catch (error) { results.push({ id, status: 'failed', frontendEntry, error: error.stack }); process.exitCode = 1; await page.screenshot({ path: path.join(output, 'failure-content-actions-' + id + '.png') }).catch(() => {}); }
  finally { console.log(JSON.stringify(results.at(-1))); await context.close(); }
}
try {
  let listening = false;
  for (let n = 0; n < 100; n++) { try { if ((await fetch(origin)).ok) { listening = true; break; } } catch {} if (server.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert(listening, 'Vite preview did not start: ' + log);
  frontendEntry = (await (await fetch(origin)).text()).match(/src="([^"]+\.js)"/)?.[1]; assert(frontendEntry);
  browser = useWebKit ? await webkit.launch({ headless: true }) : await chromium.launch({ executablePath: chrome, headless: true });
  await check('duplicate-delete-text-history', async page => {
    await selectText(page); await intent(page, 'duplicate');
    await page.getByLabel('Posición Y', { exact: true }).fill('280'); await commit(page, 'duplicate');
    const duplicated = await save(page, 'content-actions-text-duplicate.pdf');
    assert.equal(textCount(duplicated, 'ORIGINAL 1'), 2); preserved(duplicated);
    await selectText(page, 1, true); await intent(page, 'delete'); await commit(page, 'delete');
    assert.equal(await page.getByRole('button', { name: 'Párrafo: ORIGINAL 1', exact: true }).count(), 1);
    await history(page, 'Deshacer'); assert.equal(await page.getByRole('button', { name: 'Párrafo: ORIGINAL 1', exact: true }).count(), 2);
    await history(page, 'Rehacer'); const deleted = await save(page, 'content-actions-text-delete.pdf');
    assert.equal(textCount(deleted, 'ORIGINAL 1'), 1); preserved(deleted);
    return { duplicateRetainsOriginal: true, selectedCopyDeleted: true, oneStepUndoRedo: true, originalNeighborsAndNotePreserved: true };
  });
  await check('duplicate-delete-image-pixels', async page => {
    await selectImage(page); await intent(page, 'duplicate');
    await page.getByLabel('Posición X', { exact: true }).fill('300'); await page.getByLabel('Posición Y', { exact: true }).fill('370'); await commit(page, 'duplicate');
    const duplicated = await save(page, 'content-actions-image-duplicate.pdf');
    assert.equal(images(duplicated).length, 2); assert(green(pixel(duplicated, 90, 395)) && green(pixel(duplicated, 350, 395))); preserved(duplicated);
    await selectImage(page, true); await intent(page, 'delete'); await commit(page, 'delete');
    await history(page, 'Deshacer'); assert.equal(await page.locator('.pdf-content-item[data-kind="image"]').count(), 2);
    await history(page, 'Rehacer'); const deleted = await save(page, 'content-actions-image-delete.pdf');
    assert.equal(images(deleted).length, 1); assert(green(pixel(deleted, 90, 395))); assert.deepEqual(pixel(deleted, 350, 395), [255, 255, 255]); preserved(deleted);
    return { intrinsicImageDuplicated: true, copyPixelsRemoved: true, originalPixelsPreserved: true, undoRedo: true };
  });
  await check('reset-cancel-do-not-commit', async page => {
    let downloads = 0; page.on('download', () => downloads++);
    await selectText(page); const frame = await page.locator('.content-editor').getAttribute('data-destination-rect');
    await page.getByRole('textbox', { name: 'Texto', exact: true }).fill('DRAFT 1');
    // Only a changed element is a draft; saving waits until the editor reports it.
    await page.locator('.edit-pdf-save:disabled').waitFor();
    await page.keyboard.press(saveShortcut);
    await page.locator('.toast, .activity-pill').getByText('Aplica o descarta la edición antes de guardar el PDF.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Descargar', exact: true }).isDisabled(), true); assert.equal(downloads, 0);
    await intent(page, 'duplicate'); await page.getByLabel('Posición X', { exact: true }).fill('220');
    await page.getByRole('button', { name: 'Restablecer', exact: true }).click(); await ready(page);
    assert.equal(await page.getByRole('textbox', { name: 'Texto', exact: true }).inputValue(), 'ORIGINAL 1');
    assert.equal(await page.locator('.content-editor').getAttribute('data-destination-rect'), frame);
    await intent(page, 'delete'); await page.getByRole('button', { name: 'Descartar edición', exact: true }).click(); await picker(page);
    await selectImage(page); await intent(page, 'duplicate'); await page.getByLabel('Opacidad', { exact: true }).fill('50');
    await page.getByRole('button', { name: 'Restablecer', exact: true }).click(); await ready(page);
    assert.equal(await page.getByLabel('Opacidad', { exact: true }).inputValue(), '100');
    await intent(page, 'delete'); await page.getByRole('button', { name: 'Descartar edición', exact: true }).click(); await picker(page);
    assert.equal(await page.getByRole('button', { name: 'Deshacer', exact: true }).isDisabled(), true);
    const bytes = await save(page, 'content-actions-cancel.pdf');
    assert.deepEqual(operateDocument(bytes, { operation: 'text' }), operateDocument(original, { operation: 'text' }));
    assert.equal(images(bytes).length, 1); assert(green(pixel(bytes, 90, 395))); preserved(bytes);
    return { shortcutBlocksUnappliedDraft: true, resetReturnsToOriginalEdit: true, cancelledDeletionChangesNothing: true, noHistoryStep: true };
  });
  await check('inline-save-shortcut-page-history-library', async page => {
    await page.getByRole('button', { name: 'Página siguiente del editor', exact: true }).click(); await picker(page, 2);
    await selectText(page, 2); await page.getByRole('textbox', { name: 'Texto', exact: true }).fill('SAVED 2'); await commit(page, 'edit', 2);
    const saved = await save(page, 'content-actions-inline-save.pdf', false, 2); assert.equal(textCount(saved, 'SAVED 2', 2), 1); preserved(saved);
    // The same single document stays open: the header names it without an open-documents count.
    assert((await documentHeader(page).innerText()).includes(path.basename(source))); assert.equal(await documentHeader(page).locator('small').count(), 0);
    // The download replaces the library entry instead of adding a second one.
    const savedId = createHash('sha256').update(saved).digest('hex');
    await page.waitForFunction(id => new Promise(resolve => { const request = indexedDB.open('folio-library'); request.onsuccess = () => { const db = request.result, tx = db.transaction('documents', 'readonly'), rows = tx.objectStore('documents').getAll(); rows.onsuccess = () => resolve(rows.result.length === 1 && rows.result[0].id === id); tx.oncomplete = () => db.close(); }; request.onerror = () => resolve(false); }), savedId);
    await history(page, 'Deshacer', 2); assert.equal(await page.getByRole('button', { name: 'Párrafo: ORIGINAL 2', exact: true }).count(), 1);
    const undone = await save(page, 'content-actions-inline-undo.pdf', true, 2); assert.equal(textCount(undone, 'SAVED 2', 2), 0); preserved(undone);
    await history(page, 'Rehacer', 2); assert.equal(await page.getByRole('button', { name: 'Párrafo: SAVED 2', exact: true }).count(), 1);
    const redone = await save(page, 'content-actions-inline-redo.pdf', true, 2); assert.equal(textCount(redone, 'SAVED 2', 2), 1); preserved(redone);
    await page.screenshot({ path: path.join(output, 'content-actions-inline-save.png') });
    return { [useWebKit ? 'buttonAndCmdSDownloadRealPdf' : 'buttonAndCtrlSDownloadRealPdf']: true, remainsInlineOnPage2: true, documentIdentityPreserved: true, downloadReplacesLibraryEntry: true, historySurvivesEverySave: true, annotationsExported: true };
  });
  await check('native-save-cancel-and-success-contract', async page => {
    await page.getByRole('button', { name: 'Página siguiente del editor', exact: true }).click(); await picker(page, 2);
    await selectText(page, 2); await page.getByRole('textbox', { name: 'Texto', exact: true }).fill('NATIVE 2'); await commit(page, 'edit', 2);
    // Guardar replaces the opened file through the provider; Guardar una copia asks where to write.
    await page.keyboard.press(saveShortcut);
    await page.waitForFunction(() => globalThis.__contentActionsNative.originals.length === 1); await savedIdle(page, 2);
    await page.locator('.toast, .activity-pill').getByText('Cambios guardados en el PDF original.', { exact: true }).waitFor();
    let state = await page.evaluate(() => globalThis.__contentActionsNative);
    assert.equal(state.originals[0].headers['x-folio-source-token'], 'source-token'); assert.equal(state.originals[0].headers['x-folio-output-token'], 'output-original-token');
    assert.equal(state.chosen.length, 1); assert.equal(state.chosen[0].source, 'source-token'); assert.equal(state.writes.length, 0);
    const replaced = new Uint8Array(state.originals[0].bytes); assert.equal(textCount(replaced, 'NATIVE 2', 2), 1); preserved(replaced);
    assert((await documentHeader(page).innerText()).includes('content-actions-source.pdf')); assert.equal(await documentHeader(page).locator('small').count(), 0);
    await page.keyboard.press(saveCopyShortcut); await savedIdle(page, 2);
    assert.equal(await page.evaluate(() => globalThis.__contentActionsNative.writes.length), 0, 'Cancelling output selection writes no PDF.');
    await page.keyboard.press(saveCopyShortcut);
    await page.waitForFunction(() => globalThis.__contentActionsNative.writes.length === 1); await savedIdle(page, 2);
    state = await page.evaluate(() => globalThis.__contentActionsNative);
    assert.equal(state.chosen.length, 3); assert.equal(state.chosen[1].source, 'saved-token'); assert.equal(state.chosen[2].source, 'saved-token'); assert.equal(state.originals.length, 1);
    assert.equal(state.writes[0].headers['x-folio-output-token'], 'output-copy-token');
    const bytes = new Uint8Array(state.writes[0].bytes); assert.equal(textCount(bytes, 'NATIVE 2', 2), 1); preserved(bytes);
    assert.equal(createHash('sha256').update(new Uint8Array(state.source)).digest('hex'), sourceHash);
    assert(state.remembered.some(row => row.token === 'output-copy-token'), 'The saved copy is registered in the native library.');
    // The copy replaces the open document in place: one document, now named as the copy.
    assert((await documentHeader(page).innerText()).includes('content-actions-source — copia.pdf')); assert.equal(await documentHeader(page).locator('small').count(), 0);
    await history(page, 'Deshacer', 2); assert.equal(await page.getByRole('button', { name: 'Párrafo: ORIGINAL 2', exact: true }).count(), 1);
    await history(page, 'Rehacer', 2); assert.equal(await page.getByRole('button', { name: 'Párrafo: NATIVE 2', exact: true }).count(), 1);
    return { bridgeMockOnly: true, saveReplacesOriginalThroughProvider: true, cancelledOutputWritesNothing: true, realAnnotatedPdfPayload: true, outputTokenAndSourcePreserved: true, copiedNameAndLibraryEntry: true, inlinePageAndHistoryPreserved: true };
  }, true);
} finally {
  await browser?.close();
  if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
  fs.writeFileSync(path.join(output, 'content-actions-ui-results.json'), JSON.stringify({ date: new Date().toISOString(), platform: process.platform, browser: browserName, saveShortcut, frontendEntry, syntheticFixturesOnly: true, results, errors }, null, 2));
  if (errors.length || !results.length) process.exitCode = 1;
}
