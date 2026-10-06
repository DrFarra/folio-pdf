import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';

// Real frontend, PDF serialization and library lifecycle, with a native IPC
// harness. Provider writes and rollback are tested separately in Robolectric.
const out = 'test-results/android-save'; fs.mkdirSync(out, { recursive: true });
const pdf = await PDFDocument.create(); pdf.addPage([420, 600]).drawText('Guardar en el original', { x: 35, y: 540 });
const fixture = Buffer.from(await pdf.save());
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4281', '--strictPort'], { stdio: 'ignore', windowsHide: true });
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:4281')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  for (const [layout, width, height] of [['tablet', 1280, 800], ['phone', 390, 844]]) {
    if (process.env.FOLIO_SAVE_LAYOUT && process.env.FOLIO_SAVE_LAYOUT !== layout) continue;
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: `Mozilla/5.0 (Linux; Android 15; ${layout}) AppleWebKit/537.36 Chrome/140.0.0.0 ${layout === 'phone' ? 'Mobile ' : ''}Safari/537.36` });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const original = `${out}/${layout}-original.pdf`; fs.writeFileSync(original, fixture);
    const sources = new Map(), outputs = new Map(), catalog = new Map(), sessions = new Map();
    let sequence = 0, mode = 'save'; const calls = [], errors = [];
    const register = (bytes, name = 'Apuntes.pdf', path = original) => {
      const doc = { token: `source-${++sequence}`, name, size: bytes.length, id: hash(bytes), revision: hash(bytes) };
      sources.set(doc.token, { doc, bytes: Buffer.from(bytes), path }); return doc;
    };
    let latest = register(fixture);
    await page.exposeFunction('folioInvoke', async (command, args, options) => {
      calls.push(command);
      if (command === 'plugin:event|listen') return ++sequence;
      if (command === 'plugin:app|version') return '0.8.8';
      if (command === 'android_safe_area') return { bottom: 0 };
      if (command === 'drive_lookup') return null;
      if (command === 'startup_documents') return [];
      if (command === 'list_library' || command === 'recent_documents') return [...catalog.values()];
      if (command === 'pick_documents') return [latest];
      if (command === 'open_library_document') return sources.get(catalog.get(args.id).nativeSource).doc;
      if (command === 'read_document') return [...sources.get(args.token).bytes];
      if (command === 'read_document_range') return [...sources.get(args.token).bytes.subarray(args.offset, args.offset + args.length)];
      if (command === 'load_draft') return [];
      if (command === 'load_session') return sessions.get(args.id) || null;
      if (command === 'store_session') { sessions.set(args.id, args.session); return; }
      if (command === 'remember_document') { const source = sources.get(args.token); catalog.set(args.id, { ...source.doc, id: args.id, nativeSource: args.token, pages: args.pages, openedAt: args.openedAt }); return; }
      if (command === 'forget_document') { catalog.delete(args.id); sessions.delete(args.id); return; }
      if (command === 'choose_output') { const token = `output-${++sequence}`; outputs.set(token, args); return token; }
      if (command === 'write_pdf_original' || command === 'write_pdf_copy') {
        const reservation = outputs.get(options.headers['x-folio-output-token']); assert(reservation);
        if (mode === 'cancel') return null;
        if (mode === 'error') throw new Error('El PDF cambió fuera de Folio. Usa Guardar una copia.');
        assert.equal(typeof args.base64, 'string', 'Android uses compact binary transport');
        const bytes = Buffer.from(args.base64, 'base64'); assert(inspectDocument(bytes).pages === 1);
        let path;
        if (command === 'write_pdf_original') {
          assert.equal(options.headers['x-folio-source-token'], reservation.source);
          path = sources.get(reservation.source).path;
          assert.equal(reservation.name, sources.get(reservation.source).doc.name);
        } else path = `${out}/${layout}-copy.pdf`;
        fs.writeFileSync(path, bytes); latest = register(bytes, reservation.name, path); return latest;
      }
      return null;
    });
    await page.addInitScript(() => {
      window.isTauri = true;
      let callback = 0;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => ++callback, unregisterCallback: () => {},
        invoke: (command, args, options) => window.folioInvoke(command, args instanceof Uint8Array ? [...args] : args, options),
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4281');
    await page.getByRole('button', { name: 'Abrir PDF', exact: true }).click();
    await page.locator('.reading-area .textLayer span').first().waitFor();
    const draw = async count => {
      await page.getByRole('button', { name: layout === 'phone' ? 'Anotar' : 'Anotar documento', exact: true }).click();
      await page.getByRole('button', { name: 'Lápiz', exact: true }).click();
      const b = await page.locator('.ink-interactive').first().boundingBox(); const x = b.x + b.width * .2, y = Math.max(120, b.y + b.height * (.3 + count * .04));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: .5 });
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + i * 5, y: y + i, button: 'left', buttons: 1, pointerType: 'pen', force: .6 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 40, y: y + 8, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
      await page.waitForFunction(n => document.querySelectorAll('[data-ink-id]').length === n, count);
      await page.getByRole('button', { name: 'Listo', exact: true }).click();
    };
    const save = async (copy = false) => {
      const previousWrites = calls.filter(c => c === 'write_pdf_original' || c === 'write_pdf_copy').length;
      await page.getByRole('button', { name: layout === 'phone' ? 'Más acciones' : 'Más acciones del documento', exact: true }).click();
      await page.getByRole('button', { name: copy ? 'Guardar una copia' : 'Guardar PDF', exact: true }).click();
      for (let i = 0; i < 200 && calls.filter(c => c === 'write_pdf_original' || c === 'write_pdf_copy').length === previousWrites; i++) await page.waitForTimeout(50);
      assert.equal(calls.filter(c => c === 'write_pdf_original' || c === 'write_pdf_copy').length, previousWrites + 1);
      await page.waitForFunction(() => !document.querySelector('.loading-overlay') && !document.querySelector('[aria-label="Documentos abiertos y recientes"]')?.disabled);
    };
    await draw(1);
    mode = 'cancel'; await save(); assert.deepEqual(fs.readFileSync(original), fixture);
    assert.equal(await page.locator('[data-ink-id]').count(), 1);
    mode = 'error'; await save(); await page.locator('.toast').getByText(/El PDF cambió fuera de Folio/).waitFor(); assert.deepEqual(fs.readFileSync(original), fixture);
    mode = 'save'; await save(); await page.locator('.toast').getByText('Cambios guardados en el PDF original.', { exact: true }).waitFor();
    assert.equal(inspectDocument(fs.readFileSync(original)).annotations.filter(a => a.kind === 'ink').length, 1);
    assert.equal(catalog.size, 1); assert.equal(calls.filter(c => c === 'write_pdf_copy').length, 0);
    // A restart (Android ending the app in the background) reopens the saved document by itself.
    await page.reload(); await page.locator('[data-ink-id]').waitFor();
    await draw(2); await save(); await page.locator('.toast').getByText('Cambios guardados en el PDF original.', { exact: true }).waitFor();
    assert.equal(inspectDocument(fs.readFileSync(original)).annotations.filter(a => a.kind === 'ink').length, 2);
    assert.equal(catalog.size, 1);
    const savedOriginal = fs.readFileSync(original);
    await draw(3); await save(true); await page.locator('.toast').getByText(/^Copia guardada\. Ahora editas «.+»\.$/).waitFor();
    assert.deepEqual(fs.readFileSync(original), savedOriginal);
    assert.equal(inspectDocument(fs.readFileSync(`${out}/${layout}-copy.pdf`)).annotations.filter(a => a.kind === 'ink').length, 3);
    assert.equal(catalog.size, 2); assert.deepEqual(errors, []);
    await draw(4); await save(); await page.locator('.toast').getByText('Cambios guardados en el PDF original.', { exact: true }).waitFor();
    assert.deepEqual(fs.readFileSync(original), savedOriginal);
    assert.equal(inspectDocument(fs.readFileSync(`${out}/${layout}-copy.pdf`)).annotations.filter(a => a.kind === 'ink').length, 4);
    assert.equal(catalog.size, 2); assert.deepEqual(errors, []);
    await page.screenshot({ path: `${out}/${layout}-saved.png` });
    await context.close();
    console.log(`PASS ${layout}: cancel, errors, original saved with ink, reopen, repeat without duplicate annotations/library rows, explicit copy and subsequent overwrite of that copy`);
  }
} finally { await browser?.close(); server.kill(); }
