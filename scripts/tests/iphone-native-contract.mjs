import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { webkit } from 'playwright-core';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';

// Explicit IPC contract test, deliberately separate from native simulator smoke
// and the browser UI suite. UIKit dialogs are NOT exercised by this mock bridge.
const root = process.cwd(), output = path.join(root, 'test-results', 'iphone'); fs.mkdirSync(output, { recursive: true });
const fixture = await PDFDocument.create(); fixture.addPage([420, 560]).drawText('Native iPhone export retains these words.', { x: 32, y: 455, size: 16 });
const bytes = new Uint8Array(await fixture.save()), name = 'iphone-native-source.pdf';
const originalText = operateDocument(bytes, { operation: 'text' });
const port = process.env.FOLIO_IPHONE_CONTRACT_PORT || '4198', origin = `http://127.0.0.1:${port}`;
const snapshotRoot = path.resolve(root, '.tools'), snapshot = process.env.FOLIO_IPHONE_DEV ? null : path.join(snapshotRoot, `iphone-contract-preview-${process.pid}`);
if (snapshot) { fs.mkdirSync(snapshot, { recursive: true }); fs.cpSync(path.join(root, 'dist'), snapshot, { recursive: true }); }
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...(snapshot ? ['preview', '--outDir', snapshot] : []), '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
let log = '', browser, page; server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
const results = [], errors = [];
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(log);
    if (stripVTControlCharacters(log).includes(origin)) try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, log || 'Vite did not start.');
  browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
  await context.addInitScript(({ bytes, name }) => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' }); Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: undefined });
    globalThis.isTauri = true;
    const source = { token: 'imported-source', name, size: bytes.length }, sessions = new Map(), writes = [], calls = [];
    let callback = 0, nextOutput = 0, cancelSave = true;
    globalThis.__iphoneNativeContract = { writes, calls, sessions, source };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command, args, options) => {
        calls.push({ command, args: args instanceof Uint8Array ? { binaryLength: args.byteLength } : args, options });
        if (command === 'plugin:event|listen') return ++callback;
        if (command === 'startup_documents') return [source];
        if (command === 'recent_documents' || command === 'list_library' || command === 'pick_documents') return [];
        if (command === 'read_document') return new Uint8Array(args.token === source.token ? bytes : writes.at(-1).bytes).buffer;
        if (command === 'load_draft') return new ArrayBuffer(0);
        if (command === 'load_session') return sessions.get(args.id) || null;
        if (command === 'store_session') { sessions.set(args.id, args.session); return null; }
        if (command === 'choose_output') return `reserved-${++nextOutput}`;
        if (['write_pdf_copy', 'share_pdf_copy', 'print_pdf_copy'].includes(command)) {
          if (!(args instanceof Uint8Array)) throw new Error('A PDF command must receive raw bytes, not JSON.');
          if (!options?.headers?.['x-folio-output-token']) throw new Error('A PDF command must bind its reserved output token.');
          writes.push({ command, bytes: [...args], outputToken: options.headers['x-folio-output-token'] });
          if (command !== 'write_pdf_copy') return true;
          if (cancelSave) { cancelSave = false; return null; }
          return { token: 'saved-source', name: 'iphone-native-saved.pdf', size: args.length };
        }
        return null;
      },
    };
  }, { bytes: [...bytes], name });
  page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.getByRole('heading', { name, includeHidden: true, exact: true }).waitFor({ state: 'attached' });
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.locator('.textLayer span').filter({ hasText: 'Native iPhone export' }).first().waitFor();
  const calls = await page.evaluate(() => window.__iphoneNativeContract.calls);
  const startup = calls.findIndex(call => call.command === 'startup_documents');
  assert(startup > calls.findIndex(call => call.args?.event === 'folio-open-documents'));
  assert(startup > calls.findIndex(call => call.args?.event === 'folio-open-error'));
  assert.equal(await page.locator('.window-actions').count(), 0);
  results.push({ id: 'native-mobile-startup-listeners-before-documents', passed: true, bridgeMocked: true, realPdfTextLayer: true });

  const span = page.locator('.textLayer span').filter({ hasText: 'Native iPhone export' }).first();
  await span.evaluate(span => { const range = document.createRange(); range.selectNodeContents(span); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.getByRole('toolbar', { name: 'Herramientas del texto seleccionado', exact: true }).getByRole('button', { name: 'Resaltar', exact: true }).tap();
  await page.locator('.highlight-annotation').waitFor();
  const action = async name => { await page.getByRole('button', { name: 'Más acciones', exact: true }).tap(); await page.getByRole('button', { name, exact: true }).tap(); };
  const idle = async () => { await page.locator('.loading-overlay').waitFor({ state: 'detached' }); await page.getByRole('button', { name: 'Volver a biblioteca', exact: true }).waitFor(); await page.waitForFunction(() => !document.querySelector('button[aria-label="Volver a biblioteca"]')?.disabled); };
  await action('Guardar una copia del PDF');
  await page.waitForFunction(() => window.__iphoneNativeContract.writes.filter(write => write.command === 'write_pdf_copy').length === 1);
  await idle();
  assert.equal(await page.locator('.highlight-annotation').count(), 1);
  assert.match(await page.getByRole('button', { name: 'Documentos abiertos', exact: true }).textContent(), /iphone-native-source/);
  assert.equal(await page.getByRole('status').filter({ hasText: 'PDF guardado.' }).count(), 0, 'A canceled native export must not claim it was saved.');
  results.push({ id: 'native-files-cancel-keeps-current-document-and-unsaved-highlight', passed: true, bridgeMocked: true, uiKitPickerExercised: false });

  await action('Guardar una copia del PDF'); await page.getByRole('heading', { name: 'iphone-native-saved.pdf', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await idle();
  await page.getByRole('button', { name: 'Compartir', exact: true }).tap(); await page.waitForFunction(() => window.__iphoneNativeContract.writes.some(write => write.command === 'share_pdf_copy'));
  await idle();
  await action('Imprimir PDF'); await page.waitForFunction(() => window.__iphoneNativeContract.writes.some(write => write.command === 'print_pdf_copy'));
  await idle();
  const captured = await page.evaluate(() => ({ writes: window.__iphoneNativeContract.writes, calls: window.__iphoneNativeContract.calls,
    sessions: [...window.__iphoneNativeContract.sessions.values()], browserSessions: Object.keys(localStorage).filter(key => key.startsWith('folio.session.')) }));
  const reserved = captured.calls.filter(call => call.command === 'choose_output'); assert.equal(reserved.length, 4);
  assert.equal(new Set(captured.writes.map(write => write.outputToken)).size, 4, 'Each output operation must use a fresh reserved token.');
  for (const [index, write] of captured.writes.entries()) {
    const result = new Uint8Array(write.bytes), inspection = inspectDocument(result); fs.writeFileSync(path.join(output, `iphone-native-contract-${index}-${write.command}.pdf`), result);
    assert.equal(inspection.annotations.length, 1); assert.equal(inspection.annotations[0].kind, 'highlight'); assert(inspection.annotations[0].quads?.length);
    assert.deepEqual(operateDocument(result, { operation: 'text' }), originalText);
  }
  assert(captured.sessions.some(session => session.annotations?.length === 1)); assert.deepEqual(captured.browserSessions, []);
  assert.equal(captured.calls.filter(call => call.command.startsWith('plugin:window|')).length, 0, 'Mobile must not invoke desktop window management.');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'iphone-native-contract.png'), animations: 'disabled' });
  results.push({ id: 'native-save-share-print-raw-standard-pdf-and-private-session-contracts', passed: true, bridgeMocked: true, standardPdfOutputs: 4,
    freshReservedTokens: true, nativeSessionUsed: true, browserSessionUnused: true, uiKitSaveSharePrintSheetsExercised: false });
} catch (error) {
  process.exitCode = 1; results.push({ id: 'native-ios-bridge-contract', passed: false, error: error.stack, serverLog: log });
  await page?.screenshot({ path: path.join(output, 'failure-iphone-native-contract.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await browser?.close(); server.kill();
  if (snapshot) { assert(snapshot.startsWith(snapshotRoot + path.sep)); fs.rmSync(snapshot, { recursive: true, force: true }); }
  const report = { capturedAt: new Date().toISOString(), passed: results.length === 3 && results.every(result => result.passed) && errors.length === 0,
    scope: 'Browser UI with explicitly mocked Tauri IPC; actual exported PDF bytes inspected by MuPDF.', results, errors,
    limitations: ['These are IPC contract tests. No actual UIKit Files, sharing or printing dialog was exercised.', 'Real iOS native app compilation and simulator smoke are separate gates.'] };
  fs.writeFileSync(path.join(output, 'iphone-native-contract-results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
}
