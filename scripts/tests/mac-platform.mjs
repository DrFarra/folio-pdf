import assert from 'node:assert/strict';
import { enterAnnotationMode } from './ui-helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';

const root = process.cwd(), output = path.join(root, 'test-results'); fs.mkdirSync(output, { recursive: true });
const source = path.join(output, 'mac-platform-source.pdf'), another = path.join(output, 'mac-platform-another.pdf');
const selectedText = 'Folio for Mac works';
async function fixture(name) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) { const page = pdf.addPage([420, 560]); page.drawText(`${name} PAGE ${i}`, { x: 42, y: 490, size: 18, font }); page.drawText(selectedText, { x: 42, y: 420, size: 16, font }); }
  return pdf.save();
}
fs.writeFileSync(source, await fixture('MAC')); fs.writeFileSync(another, await fixture('OTHER'));
const scanSource = path.join(output, 'mac-platform-scan.pdf');
const raster = await PDFDocument.create(); raster.addPage([550, 280]).drawText('FOLIO MAC OCR', { x: 50, y: 180, size: 32 });
const imageDocument = new mupdf.PDFDocument(await raster.save()), imagePage = imageDocument.loadPage(0), pixmap = imagePage.toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
const scan = await PDFDocument.create(), image = await scan.embedPng(new Uint8Array(pixmap.asPNG())); scan.addPage([550, 280]).drawImage(image, { x: 0, y: 0, width: 550, height: 280 });
fs.writeFileSync(scanSource, await scan.save()); pixmap.destroy(); imagePage.destroy(); imageDocument.destroy();
const testFilter = process.env.FOLIO_MAC_PLATFORM_TEST ? new RegExp(process.env.FOLIO_MAC_PLATFORM_TEST) : null;
const selected = id => !testFilter || testFilter.test(id);
const chromeTests = ['chrome-mac-native-titlebar-and-startup-handshake', 'chrome-windows-controls-remain-unchanged', 'chrome-mac-command-and-legacy-api-fallback', 'chrome-mac-native-tab-layout', 'chrome-windows-native-tab-layout'];
const webkitTests = ['webkit-mac-command-and-legacy-api-fallback', 'webkit-local-ocr-and-font-assets', 'webkit-rapid-three-documents-search'];
const runChrome = chromeTests.some(selected), runWebKit = webkitTests.some(selected);
const chrome = findChrome();
if (runChrome) assert(chrome, 'Chrome or Edge must be installed, or set CHROME_PATH.');
assert(runChrome || runWebKit, 'FOLIO_MAC_PLATFORM_TEST did not match any test.');
const port = process.env.FOLIO_MAC_PLATFORM_PORT || '4183', origin = `http://127.0.0.1:${port}`;
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let log = ''; preview.stdout.on('data', data => { log += data; }); preview.stderr.on('data', data => { log += data; });
const browsers = [], results = [], errors = [];

async function prepare(context, { mac = true, native = false, missingModernApis = false } = {}) {
  await context.addInitScript(({ mac, native, missingModernApis }) => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: mac ? 'MacIntel' : 'Win32' });
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: mac ? 'macOS' : 'Windows' } });
    if (missingModernApis) {
      Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, { configurable: true, writable: true, value: undefined });
      for (const [object, key] of [[Map.prototype, 'getOrInsertComputed'], [Map.prototype, 'getOrInsert'], [WeakMap.prototype, 'getOrInsertComputed'], [WeakMap.prototype, 'getOrInsert'], [Math, 'sumPrecise'], [Promise, 'withResolvers'], [Promise, 'try'], [URL, 'parse'], [Response.prototype, 'bytes'], [Uint8Array, 'fromBase64'], [Uint8Array.prototype, 'toBase64']]) {
        Object.defineProperty(object, key, { configurable: true, writable: true, value: undefined });
      }
    }
    if (!native) return;
    globalThis.isTauri = true;
    globalThis.__folioNativeCalls = [];
    let id = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++id, unregisterCallback: () => {},
      invoke: async (command, arguments_) => {
        globalThis.__folioNativeCalls.push({ command, arguments: arguments_ });
        if (command === 'plugin:event|listen') return ++id;
        if (command === 'startup_documents' || command === 'recent_documents' || command === 'list_library' || command === 'pick_documents') return [];
        if (command === 'load_session' || command === 'choose_output') return null;
        return undefined;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { mac, native, missingModernApis });
}
async function open(page, file = source, hasText = true) {
  // Setting a hidden file input bypasses the visible button's disabled state.
  // Wait for the previous save/load to finish before simulating a file choice.
  await page.waitForFunction(() => !document.querySelector('button.new-document-tab')?.disabled);
  if (process.env.FOLIO_MAC_PLATFORM_DEBUG) console.log('opening', path.basename(file), await page.evaluate(() => ({ openDisabled: document.querySelector('button.new-document-tab')?.disabled, downloadDisabled: document.querySelector('.download-button')?.disabled, loading: !!document.querySelector('.loading-overlay'), title: document.querySelector('h1')?.textContent })));
  await page.locator('.app-header input[type=file]').setInputFiles(file);
  await page.getByRole('heading', { name: path.basename(file), exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.getByRole('combobox', { name: 'Nivel de zoom' }).selectOption('100');
  await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
  if (hasText) await page.locator('.textLayer span').filter({ hasText: selectedText }).first().waitFor();
}
async function check(browser, id, action, options = {}) {
  if (!selected(id)) return;
  const context = await browser.newContext({ viewport: { width: 1360, height: 760 }, acceptDownloads: true }), page = await context.newPage(); page.setDefaultTimeout(20000);
  const diagnostics = [];
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) { diagnostics.push({ type: message.type(), text: message.text(), location: message.location() }); if (process.env.FOLIO_MAC_PLATFORM_DEBUG) console.log('browser', id, message.type(), message.text()); } });
  page.on('pageerror', error => errors.push({ id, error: error.message }));
  const outside = []; page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) outside.push(request.url()); });
  try { await prepare(context, options); await page.goto(origin); await page.locator('.loading-overlay').waitFor({ state: 'detached' }); const evidence = await action(page); assert.deepEqual(outside, []); results.push({ id, status: 'passed', ...evidence, networkOutsideApp: 0 }); }
  catch (error) { process.exitCode = 1; results.push({ id, status: 'failed', error: error.stack, diagnostics, uiState: await page.evaluate(() => ({ openDisabled: document.querySelector('button.new-document-tab')?.disabled, downloadDisabled: document.querySelector('.download-button')?.disabled, loading: !!document.querySelector('.loading-overlay'), title: document.querySelector('h1')?.textContent, tabs: [...document.querySelectorAll('[role=tab]')].map(el => ({ name: el.getAttribute('aria-label'), selected: el.getAttribute('aria-selected') })), indexFailures: window.__folioIndexFailures, rapidToasts: window.__folioRapidToasts, blobReads: window.__folioBlobReads, searchQuery: document.querySelector('input[aria-label="Buscar texto en el PDF"]')?.value, searchSummary: document.querySelector('.search-summary')?.textContent, alerts: [...document.querySelectorAll('[role=alert]')].map(el => el.textContent) })) }); await page.screenshot({ path: path.join(output, `failure-${id}.png`), animations: 'disabled' }); }
  finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
}
async function nativeTitlebar(page, mac) {
  assert.equal(await page.locator('.window-actions').count(), mac ? 0 : 1);
  assert.equal(await page.locator('.app-header').evaluate(el => parseInt(getComputedStyle(el).paddingLeft)), mac ? 78 : 10);
  const calls = await page.evaluate(() => globalThis.__folioNativeCalls);
  const startup = calls.findIndex(call => call.command === 'startup_documents');
  assert(startup > calls.findIndex(call => call.arguments?.event === 'folio-open-documents'));
  assert(startup > calls.findIndex(call => call.arguments?.event === 'folio-open-error'));
  return { nativeTrafficLightsSpace: mac, customWindowsControls: !mac, listenersReadyBeforeStartup: true };
}
async function desktopActions(page, label) {
  await open(page); await enterAnnotationMode(page); assert.equal(await page.getByRole('button', { name: 'Deshacer (⌘Z)', exact: true }).count(), 1);
  await page.keyboard.press('Meta+f'); await page.getByRole('textbox', { name: 'Buscar texto en el PDF', exact: true }).fill('Mac'); await page.locator('.search-result').first().waitFor();
  await page.getByRole('button', { name: 'Cerrar búsqueda', exact: true }).click();
  await page.locator('.pdf-page').first().hover(); await page.keyboard.down('Meta'); await page.mouse.wheel(0, -180); await page.keyboard.up('Meta');
  await page.waitForFunction(() => Number(document.querySelector('select[aria-label="Nivel de zoom"]').value) > 100);
  await page.getByRole('combobox', { name: 'Nivel de zoom' }).selectOption('100'); await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
  await enterAnnotationMode(page);
  await page.getByRole('button', { name: 'Nota (N)', exact: true }).click();
  const bounds = await page.locator('.pdf-page').first().boundingBox(); await page.mouse.click(bounds.x + 250, bounds.y + 190);
  await page.getByRole('textbox', { name: 'Texto de la nota', exact: true }).fill('Mac note'); await page.getByRole('button', { name: 'Guardar nota', exact: true }).click();
  await page.locator('.reading-area').focus(); await page.keyboard.press('Meta+z'); await page.locator('.note-marker').waitFor({ state: 'detached' });
  await page.keyboard.press('Meta+Shift+z'); await page.locator('.note-marker').waitFor();
  await page.getByRole('button', { name: 'Resaltador (H)', exact: true }).click();
  const span = page.locator('.textLayer span').filter({ hasText: selectedText }).first(); const box = await span.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
  await page.locator('.highlight-annotation').first().waitFor();
  const pending = page.waitForEvent('download'); await page.locator('.reading-area').focus(); await page.keyboard.press('Meta+s');
  const downloaded = await pending, saved = path.join(output, `ui-${label}.pdf`); await downloaded.saveAs(saved); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  const annotationList = inspectDocument(new Uint8Array(fs.readFileSync(saved))).annotations;
  assert(annotationList.some(item => item.kind === 'note' && item.text === 'Mac note')); assert(annotationList.some(item => item.kind === 'highlight' && item.text.includes(selectedText)));
  await open(page, another); await page.locator('.reading-area').focus(); await page.keyboard.press('Meta+Alt+ArrowLeft');
  await page.locator('[role=tab][aria-selected=true]').filter({ hasText: 'mac-platform-source' }).waitFor();
  await page.keyboard.press('Meta+w'); await page.getByRole('tab', { name: path.basename(another), exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `${label}.png`), animations: 'disabled' });
  return { commandFind: true, commandWheelZoom: true, commandUndoRedo: true, commandSaveStandardPdf: true, commandTabsAndClose: true, legacyPdfRuntime: true };
}
async function tabLayout(page, mac) {
  await page.setViewportSize({ width: mac ? 1024 : 1360, height: 760 });
  assert.equal(await page.locator('.app-header').evaluate(el => parseInt(getComputedStyle(el).paddingLeft)), mac ? 78 : 10);
  assert.equal(await page.locator('.window-actions').count(), mac ? 0 : 1);
  await page.locator('.app-header input[type=file]').setInputFiles([path.join(root, 'public/sample.pdf'), source, another]);
  await page.getByRole('heading', { name: path.basename(another), exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('button.new-document-tab')?.disabled);
  assert.equal(await page.getByRole('tab').count(), 3);
  const geometry = () => page.evaluate(() => {
    const header = document.querySelector('.app-header'), strip = document.querySelector('.document-tab-strip'), selected = document.querySelector('.document-tab.selected');
    const brand = document.querySelector('.brand').getBoundingClientRect(), bounds = strip.getBoundingClientRect(), current = selected.getBoundingClientRect();
    return { clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth, scrollLeft: strip.scrollLeft, headerClientWidth: header.clientWidth, headerScrollWidth: header.scrollWidth, documentWidth: document.documentElement.scrollWidth, windowWidth: innerWidth, brandRight: brand.right, stripLeft: bounds.left, selectedLeft: current.left, selectedRight: current.right, stripRight: bounds.right, tabWidth: selected.getBoundingClientRect().width };
  });
  const three = await geometry();
  assert(three.clientWidth >= three.scrollWidth - 1, JSON.stringify(three));
  assert(three.scrollLeft <= 1, JSON.stringify(three));
  assert(three.stripLeft >= three.brandRight, JSON.stringify(three));
  const extras = [];
  for (let i = 0; i < 8; i++) { const file = path.join(output, `mac-layout-extra-${i}.pdf`); fs.writeFileSync(file, await fixture(`EXTRA ${i}`)); extras.push(file); }
  await page.locator('.app-header input[type=file]').setInputFiles(extras);
  await page.getByRole('heading', { name: path.basename(extras.at(-1)), exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('button.new-document-tab')?.disabled);
  assert.equal(await page.getByRole('tab').count(), 11);
  await page.waitForFunction(() => document.querySelector('.document-tab-strip').scrollLeft > 0);
  const many = await geometry();
  assert(many.scrollWidth > many.clientWidth && many.scrollLeft > 0, JSON.stringify(many));
  assert(many.selectedLeft >= many.stripLeft - 1 && many.selectedRight <= many.stripRight + 1, JSON.stringify(many));
  assert(many.headerScrollWidth <= many.headerClientWidth + 1 && many.documentWidth <= many.windowWidth + 1, JSON.stringify(many));
  await page.screenshot({ path: path.join(output, `mac-layout-${mac ? 'mac1024' : 'windows1360'}.png`), animations: 'disabled' });
  // Tabs size to their name within these limits; the '+' button stays right after the strip.
  for (const [width, least, most] of [[800, 120, 228], [600, 100, 140]]) {
    await page.setViewportSize({ width, height: 760 }); const small = await geometry();
    assert(small.tabWidth >= least - .5 && small.tabWidth <= most + .5, JSON.stringify(small));
    const plus = await page.locator('.app-header .new-document-tab').boundingBox(); assert(plus && plus.x >= small.stripRight - 1 && plus.x <= small.stripRight + 12, JSON.stringify({ plus, small }));
    assert(small.headerScrollWidth <= small.headerClientWidth + 1 && small.documentWidth <= small.windowWidth + 1, JSON.stringify(small));
  }
  return { threeTabsFitWithoutScroll: true, elevenTabsScrollWithinHeader: true, responsiveWidths: [[120, 228], [100, 140]], newTabNextToStrip: true, three, many };
}
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} if (preview.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 100)); }
  if (runChrome) {
    const chromeBrowser = await chromium.launch({ executablePath: chrome, headless: true }); browsers.push(chromeBrowser);
    await check(chromeBrowser, chromeTests[0], page => nativeTitlebar(page, true), { native: true });
    await check(chromeBrowser, chromeTests[1], page => nativeTitlebar(page, false), { mac: false, native: true });
    await check(chromeBrowser, chromeTests[2], page => desktopActions(page, 'mac-chrome'), { missingModernApis: true });
    await check(chromeBrowser, chromeTests[3], page => tabLayout(page, true), { native: true });
    await check(chromeBrowser, chromeTests[4], page => tabLayout(page, false), { mac: false, native: true });
  }
  if (runWebKit) {
    const webkitBrowser = await webkit.launch({ headless: true }); browsers.push(webkitBrowser);
    await check(webkitBrowser, webkitTests[0], page => desktopActions(page, 'mac-webkit'), { missingModernApis: true });
    await check(webkitBrowser, webkitTests[1], async page => {
    await open(page, scanSource, false); await page.getByRole('button', { name: 'Herramientas', exact: true }).click(); await page.getByRole('button', { name: 'Reconocer texto (OCR)', exact: true }).click();
    await page.getByLabel('Idioma', { exact: true }).selectOption('eng'); await page.getByRole('button', { name: 'Reconocer texto', exact: true }).click(); await page.locator('.workbench').waitFor({ state: 'detached', timeout: 120000 });
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar', exact: true }).click(); const downloaded = await pending, saved = path.join(output, 'ui-mac-webkit-ocr.pdf'); await downloaded.saveAs(saved);
    assert(operateDocument(new Uint8Array(fs.readFileSync(saved)), { operation: 'text' })[0].includes('FOLIO MAC OCR'));
    return { realWebKitOcr: true, localLanguageAndFontAssets: true };
    });
    await check(webkitBrowser, webkitTests[2], async page => {
      await page.evaluate(() => {
        window.__folioIndexFailures = [];
        window.__folioRapidToasts = [];
        window.__folioBlobReads = [];
        const original = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = function(...args) {
          const name = this.name || `blob-${this.size}`;
          return original.apply(this, args).then(value => { window.__folioBlobReads.push({ name, size: this.size, read: true }); return value; }, error => { window.__folioBlobReads.push({ name, size: this.size, read: false, error: `${error.name}: ${error.message}` }); throw error; });
        };
        const capture = () => {
          for (const toast of document.querySelectorAll('.toast')) {
            if (toast.textContent.includes('indexar')) window.__folioIndexFailures.push(toast.textContent);
            if (window.__folioRapidToasts.at(-1) !== toast.textContent) window.__folioRapidToasts.push(toast.textContent);
          }
        };
        new MutationObserver(capture).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      const sample = path.join(root, 'public/sample.pdf');
      const sampleOccurrenceCount = operateDocument(new Uint8Array(fs.readFileSync(sample)), { operation: 'text' }).reduce((count, text) => count + (text.match(/folio/gi)?.length || 0), 0);
      // One file-choice event queues three opens without waiting for any index.
      await page.locator('.app-header input[type=file]').setInputFiles([sample, source, another].map(file => ({ name: path.basename(file), mimeType: 'application/pdf', buffer: fs.readFileSync(file) })));
      await page.getByRole('heading', { name: path.basename(another), exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('button.new-document-tab')?.disabled);
      assert.equal(await page.getByRole('tab').count(), 3);
      for (let cycle = 0; cycle < 3; cycle++) for (const [file, query, count] of [[sample, 'FOLIO', sampleOccurrenceCount], [source, 'MAC PAGE', 3], [another, 'OTHER PAGE', 3]]) {
        await page.getByRole('tab', { name: path.basename(file), exact: true }).click();
        await page.getByRole('tab', { name: path.basename(file), exact: true, selected: true }).waitFor();
        await page.getByRole('heading', { name: path.basename(file), exact: true }).waitFor();
        await page.waitForFunction(() => !document.querySelector('button.new-document-tab')?.disabled);
        await page.keyboard.press('Meta+f');
        await page.getByRole('textbox', { name: 'Buscar texto en el PDF', exact: true }).fill(query);
        await page.waitForFunction(() => !document.querySelector('.search-summary')?.textContent.includes('Preparando'));
        await page.waitForFunction(expected => document.querySelectorAll('.search-result').length === expected, count);
        await page.getByRole('button', { name: 'Cerrar búsqueda', exact: true }).click();
      }
      assert.deepEqual(await page.evaluate(() => window.__folioIndexFailures), []);
      const layout = await page.evaluate(() => {
        const brand = document.querySelector('.brand').getBoundingClientRect(), element = document.querySelector('.document-tab-strip'), strip = element.getBoundingClientRect();
        return { brandRight: brand.right, tabStripLeft: strip.left, scrollLeft: element.scrollLeft, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
      });
      assert(layout.tabStripLeft >= layout.brandRight, 'Tab strip overlaps the logo.');
      return { threeOpensBeforeIndex: true, allTabsSearchComplete: true, repeatedSwitchCycles: 3, blobReads: await page.evaluate(() => window.__folioBlobReads), layout };
    });
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
} finally {
  await Promise.allSettled(browsers.map(browser => browser.close())); preview.kill();
  fs.writeFileSync(path.join(output, 'mac-platform-results.json'), JSON.stringify({ capturedAt: new Date().toISOString(), hostPlatform: process.platform, hostArchitecture: process.arch, testedViaHttpPreview: true, nativeWkWebViewCustomProtocolVerified: false, results, errors }, null, 2));
}
