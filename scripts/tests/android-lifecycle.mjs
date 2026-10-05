import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
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
const calls = [], sessions = new Map(); let stageFail = true, staged = 0, sessionFail = false;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:4295')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
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
    if (command === 'read_document_range') { assert(args.length <= 256 * 1024); return [...bytes.subarray(args.offset, args.offset + args.length)]; }
    if (command === 'load_draft') return [];
    if (command === 'load_session') return sessions.get(args.id) || null;
    if (command === 'store_session') { if (sessionFail) throw Error('Storage unavailable'); sessions.set(args.id, args.session); return; }
    if (command === 'list_library' || command === 'recent_documents') return [{ ...file, nativeSource: file.token, pages: 24, openedAt: 1 }];
    if (command === 'android_safe_area') return { bottom: 0 };
    if (command === 'drive_stage') {
      staged++;
      assert.equal(typeof args.base64, 'string');
      assert.equal(inspectDocument(Buffer.from(args.base64, 'base64')).annotations.filter(a => a.kind === 'ink').length, 1);
      if (stageFail) { await new Promise(resolve => { releaseStage = resolve; }); throw Error('No se pudo preparar la edición'); }
      return { id: 'pending', binding: 'qa-binding' };
    }
    return null;
  });
  await page.addInitScript(() => {
    window.isTauri = true; let callback = 0;
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => ++callback, unregisterCallback() {}, invoke: (command, args, options) => window.folioInvoke(command, args, options) };
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
    await page.getByRole('heading', { name: 'Documentos', exact: true }).waitFor();
    assert.equal(await back(), true, 'At home Android can background without destroying the activity');
    await background();
    await page.getByRole('button', { name: /Continuar leyendo/ }).click();
    await button.waitFor();
    assert.equal(reads(), readCount, 'Returning and resuming must reuse the open PDF');
    assert.equal(staged, 0, 'An unedited PDF never gets exported on background or home');
    const box = await button.boundingBox(); assert.equal(box.width, originalBox.width); assert.equal(box.height, originalBox.height);
  }
  await page.getByRole('button', { name: 'Anotar documento', exact: true }).click();
  await page.getByRole('button', { name: 'Dibujar', exact: true }).click();
  const ink = await page.locator('.ink-interactive').first().boundingBox(), x = ink.x + ink.width * .3, y = ink.y + ink.height * .4;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, pointerType: 'pen', clickCount: 1, force: .5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 40, y: y + 20, button: 'left', buttons: 1, pointerType: 'pen', force: .5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 40, y: y + 20, button: 'left', buttons: 0, pointerType: 'pen', clickCount: 1 });
  await page.locator('[data-ink-id]').waitFor();
  await background(); await background();
  await page.waitForTimeout(300); assert.equal(staged, 0, 'Background persists annotations without rendering a full PDF');
  assert.equal([...sessions.values()].at(-1).annotations.filter(a => a.kind === 'ink').length, 1);
  await back();
  await page.getByRole('heading', { name: 'Documentos', exact: true }).waitFor();
  for (let i = 0; i < 300 && !releaseStage; i++) await page.waitForTimeout(30);
  assert(releaseStage, 'Drive staging reached the deliberately delayed native write');
  await page.getByRole('button', { name: /Continuar leyendo/ }).click(); await page.locator('[data-ink-id]').waitFor();
  await back(); assert.equal(staged, 1, 'Repeated home navigation coalesces the same in-flight write');
  releaseStage(); await page.getByText(/El documento sigue abierto/).waitFor();
  stageFail = false;
  await page.getByRole('button', { name: /Continuar leyendo/ }).click(); await back();
  for (let i = 0; i < 300 && staged < 2; i++) await page.waitForTimeout(30);
  assert.equal(staged, 2, 'A failed write can be retried');
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: /Continuar leyendo/ }).click(); await back();
  await page.waitForTimeout(250); assert.equal(staged, 2, 'The same successful PDF edit is not encoded again');
  assert.equal(reads(), readCount); assert.deepEqual(errors, []);
  await page.screenshot({ path: `${out}/home-after-retry.png` });
  fs.writeFileSync(`${out}/report.json`, JSON.stringify({ version: JSON.parse(fs.readFileSync('package.json')).version, passed: true, bytes: bytes.length, readChunks: readCount, backgroundCycles: 6, nativeWrites: staged, bridge: 'contract, Android byte format', physicalTablet: false }, null, 2));
  console.log('PASS: 14 MB Drive PDF, repeated native Back and foreground, stable controls, bounded reads, non-blocking home, deduplicated writes and retry with ink preserved.');
} finally { releaseStage?.(); await browser?.close(); server.kill(); }
