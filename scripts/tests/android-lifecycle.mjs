import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { PDFDocument } from 'pdf-lib';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';

const out = 'test-results/android-lifecycle'; fs.mkdirSync(out, { recursive: true });
const pdf = await PDFDocument.create();
for (let p = 0; p < 24; p++) pdf.addPage([420, 600]).drawText(`Drive y Android: pagina ${p + 1}`, { x: 35, y: 540 });
await pdf.attach(randomBytes(14 * 1024 * 1024), 'datos.bin');
const bytes = Buffer.from(await pdf.save()), id = createHash('sha256').update(bytes).digest('hex');
const file = { token: 'drive-source', name: 'Drive 14 MB.pdf', size: bytes.length, id, revision: id };
const account = { id: 'qa-account', email: 'test@example.com', name: 'QA' };
const opened = { document: file, binding: 'qa-binding', account: account.id, fileId: 'qa-file', baseChecksum: id, editable: true, offline: false, transferred: bytes.length };
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4295', '--strictPort'], { stdio: 'ignore', windowsHide: true });
let browser, releaseStage;
const calls = [], sessions = new Map(), uploads = new Map(); let stageFail = true, staged = 0, sessionFail = false;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:4295')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, screen: { width: 1280, height: 800 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-X800) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36' });
  const page = await context.newPage(); page.setDefaultTimeout(30000); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('folioInvoke', async (command, args) => {
    calls.push({ command, length: args?.length });
    if (command === 'plugin:event|listen') return calls.length;
    if (command === 'startup_documents') return [];
    if (command === 'drive_status') return { account, pending: [] };
    if (command === 'drive_list') return { items: [{ id: 'qa-file', title: file.name, mimeType: 'application/pdf', fileSize: String(bytes.length), editable: true }] };
    if (command === 'drive_open') return opened;
    if (command === 'drive_lookup') return opened;
    if (command === 'read_document') throw Error('Android must not serialize the complete PDF as a number array');
    // The page turns this back into the JSON number array Android delivers; base64 keeps the mocked bridge fast.
    if (command === 'read_document_range') { assert(args.length <= 256 * 1024); return bytes.subarray(args.offset, args.offset + args.length).toString('base64'); }
    if (command === 'load_draft') return [];
    if (command === 'load_session') return sessions.get(args.id) || null;
    if (command === 'store_session') { if (sessionFail) throw Error('Storage unavailable'); sessions.set(args.id, args.session); return; }
    if (command === 'list_library' || command === 'recent_documents') return [{ ...file, nativeSource: file.token, pages: 24, openedAt: 1 }];
    if (command === 'android_safe_area') return { bottom: 0 };
    // Android sends payloads over 2 MiB as base64 slices, then names the upload.
    if (command === 'upload_begin') { const upload = 'u' + uploads.size; uploads.set(upload, []); return upload; }
    if (command === 'upload_chunk') { assert(Buffer.from(args.base64, 'base64').length <= 2 * 1024 * 1024); uploads.get(args.id).push(Buffer.from(args.base64, 'base64')); return null; }
    if (command === 'drive_stage') {
      staged++;
      assert.equal(args.base64, undefined, 'A 14 MB PDF must not cross the bridge in one message');
      const payload = Buffer.concat(uploads.get(args.upload)); uploads.delete(args.upload);
      assert.equal(inspectDocument(payload).annotations.filter(a => a.kind === 'ink').length, 1);
      if (stageFail) { await new Promise(resolve => { releaseStage = resolve; }); throw Error('No se pudo preparar la edición'); }
      return { id: 'pending', binding: 'qa-binding' };
    }
    return null;
  });
  await page.addInitScript(() => {
    window.isTauri = true; let callback = 0;
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => ++callback, unregisterCallback() {}, invoke: async (command, args, options) => { const value = await window.folioInvoke(command, args, options); return command === 'read_document_range' ? Array.from(Uint8Array.from(atob(value), c => c.charCodeAt(0))) : value; } };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  await page.goto('http://127.0.0.1:4295');
  await page.getByRole('button', { name: 'Google Drive', exact: true }).click();
  await page.getByRole('button', { name: /Drive 14 MB.pdf/ }).click();
  await page.locator('.reading-area .textLayer span').first().waitFor();
  const reads = () => calls.filter(c => c.command === 'read_document_range').length;
  const readCount = reads(); assert(readCount > 50);
  const back = () => page.evaluate(() => window.dispatchEvent(new Event('folio:android-back', { cancelable: true })));
  const background = () => page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('blur')); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('focus')); });
  const button = page.getByRole('button', { name: 'Más acciones del documento', exact: true });
  const originalBox = await button.boundingBox();
  for (let i = 0; i < 4; i++) {
    assert.equal(await back(), false, 'Native Back is handled inside the reader');
    await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor();
    assert.equal(await back(), true, 'At home Android can background without destroying the activity');
    await background();
    await page.getByRole('button', { name: /Continuar leyendo/ }).click();
    await button.waitFor();
    assert.equal(reads(), readCount, 'Returning and resuming must reuse the open PDF');
    assert.equal(staged, 0, 'An unedited PDF never gets exported on background or home');
    const box = await button.boundingBox(); assert.equal(box.width, originalBox.width); assert.equal(box.height, originalBox.height);
  }
  await page.getByRole('button', { name: 'Anotar documento', exact: true }).click();
  await page.getByRole('button', { name: 'Lápiz', exact: true }).click();
  const ink = await page.locator('.ink-interactive').first().boundingBox(), x = ink.x + ink.width * .3, y = ink.y + ink.height * .4;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, pointerType: 'pen', clickCount: 1, force: .5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 40, y: y + 20, button: 'left', buttons: 1, pointerType: 'pen', force: .5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 40, y: y + 20, button: 'left', buttons: 0, pointerType: 'pen', clickCount: 1 });
  await page.locator('[data-ink-id]').waitFor();
  await background(); await background();
  await page.waitForTimeout(300); assert.equal(staged, 0, 'Background persists annotations without rendering a full PDF');
  assert.equal([...sessions.values()].at(-1).annotations.filter(a => a.kind === 'ink').length, 1);
  // Back leaves annotation mode first. Going home keeps the edit in the session; Drive gets it when the document closes.
  assert.equal(await back(), false); await page.getByRole('button', { name: 'Lápiz', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('heading', { name: 'Biblioteca', exact: true }).isVisible(), false, 'Back closes annotation mode before the document');
  await back();
  await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor();
  await page.waitForTimeout(300); assert.equal(staged, 0, 'Home never renders the full PDF for Drive');
  await page.getByRole('button', { name: /Continuar leyendo/ }).click(); await page.locator('[data-ink-id]').waitFor();
  const close = async () => {
    await page.getByRole('button', { name: 'Más acciones del documento', exact: true }).click();
    await page.getByRole('button', { name: 'Cerrar documento', exact: true }).click();
    await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor();
  };
  const reopen = async () => { await page.getByRole('button', { name: `Abrir ${file.name}`, exact: true }).click(); await page.locator('[data-ink-id]').waitFor(); };
  await close();
  for (let i = 0; i < 300 && !releaseStage; i++) await page.waitForTimeout(30);
  assert(releaseStage, 'Closing stages the Drive edit, reaching the deliberately delayed native write');
  await reopen(); await close(); await page.waitForTimeout(300); assert.equal(staged, 1, 'Closing again while the same edit is in flight reuses that write');
  releaseStage(); await page.locator('.toast, .activity-pill').getByText(/No se pudo preparar la edición/).first().waitFor();
  stageFail = false;
  await reopen(); await close();
  for (let i = 0; i < 300 && staged < 2; i++) await page.waitForTimeout(30);
  assert.equal(staged, 2, 'A failed write can be retried');
  await page.waitForTimeout(200);
  await reopen(); await close();
  await page.waitForTimeout(250); assert.equal(staged, 2, 'The same successful PDF edit is not encoded again');
  assert.equal(reads(), readCount * 4, 'Each opening reads the PDF once, in bounded chunks'); assert.deepEqual(errors, []);
  await page.screenshot({ path: `${out}/home-after-retry.png` });
  fs.writeFileSync(`${out}/report.json`, JSON.stringify({ version: JSON.parse(fs.readFileSync('package.json')).version, passed: true, bytes: bytes.length, readChunks: readCount, backgroundCycles: 6, openings: 4, nativeWrites: staged, bridge: 'contract, Android byte format', physicalTablet: false }, null, 2));
  console.log('PASS: 14 MB Drive PDF, repeated native Back and foreground, stable controls, bounded reads, chunked uploads, Drive staging on close, deduplicated writes and retry with ink preserved.');
} finally { releaseStage?.(); await browser?.close(); server.kill(); }
