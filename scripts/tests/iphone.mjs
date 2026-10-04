import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';

// WebKit's mobile browser context provides genuine DOM text selection, PDF.js
// rendering and browser downloads. It does not automate UIKit selection handles,
// Files/Share sheets, a device notch or a physical two-finger gesture. Those
// limitations are retained in the machine-readable report, including on CI.
const root = process.cwd(), output = path.join(root, 'test-results', 'iphone');
fs.mkdirSync(output, { recursive: true });
const phrase = 'Select these words on iPhone.';
const automaticPhrase = 'Automatically highlight this text.';
const copiedPhrase = 'these words';
const source = path.join(output, 'iphone-reading.pdf'), another = path.join(output, 'iphone-second.pdf');
async function createPdf(name) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = pdf.addPage([420, 560]);
    page.drawText(`${name} PAGE ${i}`, { x: 32, y: 510, size: 20, font });
    page.drawText(phrase, { x: 32, y: 455, size: 14, font });
    page.drawText(automaticPhrase, { x: 32, y: 410, size: 14, font });
    page.drawText(`ORIGINAL ${name} CONTENT ${i}`, { x: 32, y: 365, size: 14, font });
  }
  return new Uint8Array(await pdf.save());
}
fs.writeFileSync(source, await createPdf('FIRST'));
fs.writeFileSync(another, await createPdf('SECOND'));
const imageSource = path.join(output, 'iphone-page-image.png');
const rasterDocument = new mupdf.PDFDocument(new Uint8Array(fs.readFileSync(source))), rasterPage = rasterDocument.loadPage(0), raster = rasterPage.toPixmap([.75, 0, 0, .75, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
fs.writeFileSync(imageSource, new Uint8Array(raster.asPNG())); raster.destroy(); rasterPage.destroy(); rasterDocument.destroy();
const external = path.join(output, 'iphone-external.pdf');
const externalDoc = new mupdf.PDFDocument(new Uint8Array(fs.readFileSync(source))), externalPage = externalDoc.loadPage(0);
const imported = externalPage.createAnnotation('Highlight');
imported.setName('External:iPhone-highlight'); imported.setContents(phrase); imported.setAuthor('Independent editor');
imported.setQuadPoints([[32, 91, 270, 91, 32, 110, 270, 110]]); imported.setColor([1, .85, .1]); imported.setOpacity(.35); imported.update(); imported.destroy();
const note = externalPage.createAnnotation('Text'); note.setName('External:iPhone-note'); note.setContents('Keep this independent note.'); note.setRect([310, 132, 330, 152]); note.update(); note.destroy();
const externalBuffer = externalDoc.saveToBuffer('garbage=4,compress=yes');
fs.writeFileSync(external, new Uint8Array(externalBuffer.asUint8Array())); externalBuffer.destroy(); externalPage.destroy(); externalDoc.destroy();
const readOnly = path.join(output, 'iphone-readonly.pdf');
fs.writeFileSync(readOnly, operateDocument(new Uint8Array(fs.readFileSync(external)), { operation: 'protect', userPassword: '', ownerPassword: 'test-owner', permissions: 16 }));
const noCopy = path.join(output, 'iphone-no-copy.pdf');
fs.writeFileSync(noCopy, operateDocument(new Uint8Array(fs.readFileSync(source)), { operation: 'protect', userPassword: '', ownerPassword: 'test-owner', permissions: 32 }));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originals = new Map([source, another, external, readOnly, noCopy].map(file => [file, hash(file)]));
const sourceText = operateDocument(new Uint8Array(fs.readFileSync(source)), { operation: 'text' });
function nativePdfAnnotations(bytes) {
  const doc = new mupdf.PDFDocument(bytes), results = [];
  try {
    if (doc.needsPassword()) assert(doc.authenticatePassword(''));
    for (let index = 0; index < doc.countPages(); index++) {
      const page = doc.loadPage(index), items = page.getAnnotations();
      try { for (const annotation of items) results.push({ page: index + 1, type: annotation.getType(), text: annotation.getContents(), name: annotation.getObject().get('NM').asString() }); }
      finally { for (const annotation of items) annotation.destroy(); page.destroy(); }
    }
    return results;
  } finally { doc.destroy(); }
}
const testFilter = process.env.FOLIO_IPHONE_TEST ? new RegExp(process.env.FOLIO_IPHONE_TEST) : null;
const selected = id => !testFilter || testFilter.test(id);
const port = process.env.FOLIO_IPHONE_PORT || '4195', origin = `http://127.0.0.1:${port}`;
const snapshotRoot = path.resolve(root, '.tools'), snapshot = process.env.FOLIO_IPHONE_DEV ? null : path.join(snapshotRoot, `iphone-preview-${process.pid}`);
if (snapshot) { fs.mkdirSync(snapshot, { recursive: true }); fs.cpSync(path.join(root, 'dist'), snapshot, { recursive: true }); }
const builtIndexHash = snapshot ? createHash('sha256').update(fs.readFileSync(path.join(snapshot, 'index.html'))).digest('hex') : null;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), ...(snapshot ? ['preview', '--outDir', snapshot] : []), '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let log = '', browser; server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
const results = [], errors = [];
const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const selectionMenu = page => page.getByRole('toolbar', { name: 'Herramientas del texto seleccionado', exact: true });
const highlights = page => page.locator('.highlight-annotation:not(.preview)');
const reader = page => page.locator('.reading-area');
const heading = (page, file) => page.getByRole('heading', { name: path.basename(file), exact: true, includeHidden: true });

async function open(page, files = source) {
  await page.waitForFunction(() => !document.querySelector('.app-header button[aria-label="Abrir PDF"]')?.disabled);
  await page.locator('.app-header input[type=file]').setInputFiles(files);
  await heading(page, Array.isArray(files) ? files.at(-1) : files).waitFor({ state: 'attached' });
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
  await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').first().waitFor();
}
async function goToPage(page, number) {
  const input = page.getByLabel('Número de página', { exact: true }); await input.fill(String(number)); await input.press('Enter');
  await page.waitForFunction(number => document.querySelector('[aria-label="Número de página"]')?.value === String(number), number);
}
async function actions(page) {
  await page.getByRole('button', { name: 'Más acciones', exact: true }).tap();
  return page.getByRole('dialog', { name: 'Acciones del documento', exact: true });
}
async function settings(page) {
  await actions(page); await page.getByRole('button', { name: 'Preferencias de lectura', exact: true }).tap();
  await page.getByRole('dialog', { name: 'Preferencias de lectura', exact: true }).waitFor();
}
async function annotateMode(page) {
  await actions(page); await page.getByRole('button', { name: 'Anotar documento', exact: true }).tap();
  await page.getByRole('button', { name: 'Resaltado automático', exact: true }).waitFor();
}
async function noteMode(page) {
  await annotateMode(page); await page.getByRole('button', { name: 'Añadir nota', exact: true }).tap();
}
async function closeDialog(page) {
  await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).tap();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
}
async function save(page, name) {
  await actions(page); const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Guardar PDF', exact: true }).tap();
  const downloaded = await pending, file = path.join(output, name); await downloaded.saveAs(file);
  await page.waitForFunction(() => !document.querySelector('.loading-overlay') && !document.querySelector('.app-header button[aria-label="Abrir PDF"]')?.disabled);
  await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
  await page.locator('.pdf-page-wrap[data-page-number="1"] canvas[data-render-scale]').waitFor();
  const bytes = new Uint8Array(fs.readFileSync(file));
  return { file, bytes, inspection: inspectDocument(bytes) };
}
async function tabs(page) {
  await page.getByRole('button', { name: 'Documentos abiertos', exact: true }).tap();
  await page.getByRole('dialog', { name: 'Documentos abiertos', exact: true }).waitFor();
}
async function switchTo(page, file) {
  await tabs(page); await page.getByRole('button', { name: `Abrir pestaña ${path.basename(file)}`, exact: true }).tap();
  await heading(page, file).waitFor({ state: 'attached' }); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
}
async function panel(page, tab = 'Marcadores') {
  if (!await page.getByRole('dialog', { name: 'Explorar documento', exact: true }).isVisible()) await page.getByRole('button', { name: 'Explorar documento', exact: true }).tap();
  await page.getByRole('tab', { name: tab, exact: true }).tap();
}
async function closePanel(page) {
  await page.getByRole('button', { name: 'Cerrar panel', exact: true }).tap();
  await page.getByRole('dialog', { name: 'Explorar documento', exact: true }).waitFor({ state: 'detached' });
}
async function selection(page, text = phrase, target = copiedPhrase) {
  const span = page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: text }).first();
  await span.scrollIntoViewIfNeeded();
  // A real browser Range over PDF.js's measured text, never a rectangle or an
  // injected annotation. Physical long-press handles are outside Playwright.
  return span.evaluate((span, target) => {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT), parts = [];
    let all = ''; while (walker.nextNode()) { parts.push({ node: walker.currentNode, start: all.length }); all += walker.currentNode.textContent; }
    const index = all.indexOf(target); if (index < 0) throw new Error('The PDF text item did not contain the expected words.');
    const endpoint = offset => { const part = parts.findLast(part => part.start <= offset); return { node: part.node, offset: offset - part.start }; };
    const start = endpoint(index), end = endpoint(index + target.length);
    const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);
    const rect = range.getBoundingClientRect();
    return { text: selected.toString(), width: rect.width, height: rect.height };
  }, target);
}
async function removeHighlight(page, index = 0) {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const box = await highlights(page).nth(index).boundingBox(); assert(box, 'A visible highlight is required.');
  await page.evaluate(() => {
    window.__iphoneHighlightTapEvents = [];
    const record = event => window.__iphoneHighlightTapEvents.push({ type: event.type, pointerType: event.pointerType, button: event.button,
      x: event.clientX, y: event.clientY, selection: window.getSelection()?.toString(), collapsed: window.getSelection()?.isCollapsed,
      rendering: document.querySelector('.pdf-page-wrap[data-page-number="1"] canvas')?.dataset.rendering,
      target: event.target?.className });
    for (const name of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click']) document.addEventListener(name, record, { once: true, capture: true });
  });
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole('menu', { name: 'Resaltado', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: 'Eliminar resaltado', exact: true }).tap();
}
async function geometry(page) {
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight, windowScroll: [scrollX, scrollY],
    reader: (() => { const element = document.querySelector('.reading-area'), box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; })(),
    inputs: [...document.querySelectorAll('input:not([type=file]):not([type=range]):not([type=color]):not([type=checkbox]),select,textarea')].filter(element => element.getClientRects().length).map(element => ({ label: element.getAttribute('aria-label') || element.name, fontSize: parseFloat(getComputedStyle(element).fontSize) })),
    buttons: [...document.querySelectorAll('button')].filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden').map(element => {
      const box = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label') || element.textContent.trim(), width: box.width, height: box.height, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  }));
}
function assertScreen(geometry, { touchTargets = true, inputFonts = true } = {}) {
  assert(geometry.documentWidth <= geometry.width + 1, `Screen scrolls horizontally: ${JSON.stringify(geometry)}`);
  assert(geometry.documentHeight <= geometry.height + 1, `Outer document scrolls vertically: ${JSON.stringify(geometry)}`);
  assert.deepEqual(geometry.windowScroll, [0, 0], 'The app shell must remain fixed while the document scrolls.');
  if (touchTargets) for (const button of geometry.buttons) assert(button.width >= 43.5 && button.height >= 43.5, `Small touch target: ${JSON.stringify(button)}`);
  if (inputFonts) for (const input of geometry.inputs) assert(input.fontSize >= 16, `An input could trigger iOS focus zoom: ${JSON.stringify(input)}`);
}
async function check(id, action, options = {}) {
  if (!selected(id)) return;
  const viewport = options.viewport || { width: 390, height: 844 };
  const context = await browser.newContext({ viewport, screen: viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent, acceptDownloads: true });
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  await context.addInitScript(() => { Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' }); Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: undefined }); });
  const diagnostics = [], outside = [], caseErrors = [];
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) diagnostics.push({ type: message.type(), text: message.text() }); });
  page.on('pageerror', error => { const issue = { id, error: error.message }; caseErrors.push(issue); errors.push(issue); });
  page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) outside.push(request.url()); });
  try {
    await page.goto(origin); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await open(page, options.file || source);
    const evidence = await action(page, context); assert.deepEqual(caseErrors, []); assert.deepEqual(outside, [], 'No document processing may call an outside service.');
    for (const [file, initialHash] of originals) assert.equal(hash(file), initialHash, 'The original file must remain unchanged.');
    results.push({ id, status: 'passed', viewport, engine: process.env.FOLIO_TEST_BROWSER === 'chromium' ? 'chromium' : 'webkit', ...evidence, originalFilesUnchanged: true, outsideRequests: [] });
  } catch (error) {
    process.exitCode = 1; results.push({ id, status: 'failed', error: error.stack, diagnostics, uiState: await page.evaluate(() => ({
      selection: window.getSelection()?.toString(), collapsed: window.getSelection()?.isCollapsed, highlightTapEvents: window.__iphoneHighlightTapEvents,
      draftSummaries: window.__iphoneDraftSummaries,
      activeElement: document.activeElement?.outerHTML?.slice(0, 500), alerts: [...document.querySelectorAll('[role=alert], .toast')].map(node => node.textContent),
    })).catch(() => null) });
    await page.screenshot({ path: path.join(output, `failure-${id}.png`), animations: 'disabled' }).catch(() => {});
  } finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
}

try {
  let ready = false; for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(log);
    // Do not accidentally run against somebody else's preview process when
    // this server failed to acquire its strict port.
    if (log.includes(origin)) try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, log || 'Vite did not start.');
  if (process.env.FOLIO_TEST_BROWSER === 'chromium') {
    const executablePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(fs.existsSync);
    assert(executablePath, 'Set CHROME_PATH to the installed Chromium executable.'); browser = await chromium.launch({ executablePath, headless: true });
  } else browser = await webkit.launch({ headless: true });

  for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }, { width: 768, height: 1024 }]) {
    await check(`reading-layout-${viewport.width}x${viewport.height}`, async page => {
      assert.equal(await page.locator('.app-shell.phone-layout').count(), 1);
      assert.equal(await page.locator('.window-actions').count(), 0);
      assert.equal(await page.locator('.document-tab-strip').isVisible(), false);
      assert.equal(await page.getByRole('button', { name: 'Abrir PDF', exact: true }).count(), 1);
      const before = await geometry(page); assertScreen(before);
      assert(before.reader.height >= viewport.height * .62, `Reader wastes space: ${JSON.stringify(before.reader)}`);
      await page.screenshot({ path: path.join(output, `iphone-reading-${viewport.width}x${viewport.height}.png`), animations: 'disabled' });
      await reader(page).evaluate(element => { element.scrollTop = 180; });
      await page.waitForFunction(() => document.querySelector('.reading-area').scrollTop > 0);
      assertScreen(await geometry(page));
      await page.screenshot({ path: path.join(output, `iphone-reading-scrolled-${viewport.width}x${viewport.height}.png`), animations: 'disabled' });
      await actions(page); assertScreen(await geometry(page)); await closeDialog(page);
      await panel(page, 'Páginas'); const drawer = await page.getByRole('dialog', { name: 'Explorar documento', exact: true }).boundingBox();
      assert(drawer && drawer.width <= viewport.width && drawer.height <= viewport.height, 'The drawer must fit the screen.');
      assertScreen(await geometry(page)); await closePanel(page);
      return { shellFixed: true, primaryControlsTouchSized: true, inputFontAtLeast16: true, readerHeight: before.reader.height, horizontalOverflow: 0, documentScrollContained: true, drawerFits: true };
    }, { viewport });
  }

  await check('multiple-documents-selector-isolated-annotations-and-page-state', async page => {
    const range = await selection(page); assert.equal(range.text, copiedPhrase); await selectionMenu(page).waitFor();
    await selectionMenu(page).getByRole('button', { name: 'Resaltar', exact: true }).tap(); await highlights(page).waitFor();
    await goToPage(page, 2);
    await page.waitForFunction(() => document.querySelector('[aria-label="Número de página"]').value === '2');
    await open(page, another); assert.equal(await highlights(page).count(), 0);
    await tabs(page); assert.equal(await page.getByRole('button', { name: /^Abrir pestaña / }).count(), 2);
    assertScreen(await geometry(page)); await page.screenshot({ path: path.join(output, 'iphone-documents.png'), animations: 'disabled' }); await closeDialog(page);
    await open(page, another); await tabs(page); assert.equal(await page.getByRole('button', { name: /^Abrir pestaña / }).count(), 2); await closeDialog(page);
    await switchTo(page, source); assert.equal(await page.getByLabel('Número de página', { exact: true }).inputValue(), '2');
    await goToPage(page, 1); await highlights(page).waitFor();
    const first = await save(page, 'iphone-first-export.pdf'); assert.equal(first.inspection.annotations.length, 1); assert.equal(first.inspection.annotations[0].text, copiedPhrase);
    await switchTo(page, another); const second = await save(page, 'iphone-second-export.pdf'); assert.equal(second.inspection.annotations.length, 0);
    assert(operateDocument(second.bytes, { operation: 'text' })[0].includes('ORIGINAL SECOND'));
    await tabs(page); assert.equal(await page.getByRole('button', { name: /^Abrir pestaña / }).count(), 2);
    await page.getByRole('button', { name: `Cerrar ${path.basename(source)}`, exact: true }).tap();
    await page.locator('dialog[open]').waitFor({ state: 'detached' }); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await tabs(page); assert.equal(await page.getByRole('button', { name: /^Abrir pestaña / }).count(), 1); await closeDialog(page); await heading(page, another).waitFor({ state: 'attached' });
    return { openedDocuments: 2, duplicateFocusesExistingDocument: true, pageRestored: 2, exportedAnnotationIsolation: true, inactiveCloseKeepsCurrentDocument: true };
  });

  await check('native-text-range-copy-highlight-and-comment-standard-pdf', async page => {
    const range = await selection(page); assert.equal(range.text, copiedPhrase); assert(range.width > 10 && range.height > 2); await selectionMenu(page).waitFor();
    assertScreen(await geometry(page));
    await page.screenshot({ path: path.join(output, 'iphone-selection.png'), animations: 'disabled' });
    await selectionMenu(page).getByRole('button', { name: 'Copiar', exact: true }).tap();
    await page.getByRole('status').filter({ hasText: 'Texto copiado.' }).waitFor();
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), copiedPhrase, 'Copy must preserve the selected range.');
    // Read the actual system clipboard if the browser exposes its read API.
    // No clipboard mock is installed. Write success + range preservation remain
    // separately reported if WebKit does not permit automated clipboard reads.
    const clipboard = await page.evaluate(async () => { try { return { readable: true, value: await navigator.clipboard.readText() }; } catch (error) { return { readable: false, reason: error.name }; } });
    if (clipboard.readable) assert.equal(clipboard.value, copiedPhrase);
    await selectionMenu(page).getByRole('button', { name: 'Resaltar', exact: true }).tap(); await highlights(page).waitFor();
    await selection(page, automaticPhrase, 'highlight this text'); await selectionMenu(page).waitFor();
    await selectionMenu(page).getByRole('button', { name: 'Comentar', exact: true }).tap();
    await page.getByLabel('Texto de la nota', { exact: true }).fill('An iPhone text comment.'); assertScreen(await geometry(page));
    await page.getByRole('button', { name: 'Guardar nota', exact: true }).tap(); await page.locator('.note-marker').waitFor();
    await page.getByRole('button', { name: 'Cerrar anotaciones', exact: true }).tap();
    const saved = await save(page, 'iphone-selection-export.pdf'); assert.deepEqual(operateDocument(saved.bytes, { operation: 'text' }), sourceText);
    const highlight = saved.inspection.annotations.find(item => item.kind === 'highlight'), comment = saved.inspection.annotations.find(item => item.kind === 'note');
    assert.equal(highlight.text, copiedPhrase); assert(highlight.quads?.length); assert.equal(comment.text, 'An iPhone text comment.');
    await removeHighlight(page); await highlights(page).waitFor({ state: 'detached' });
    const removed = await save(page, 'iphone-selection-removed.pdf'); assert.equal(removed.inspection.annotations.length, 1); assert.equal(removed.inspection.annotations[0].kind, 'note');
    return { genuineBrowserTextRange: true, selectionRange: range, contextualCopySucceeded: true, systemClipboard: clipboard, standardPdfHighlightQuads: highlight.quads.length, standardCommentSaved: true, directTapRemovalPreservesNote: true, exportOriginalTextPreserved: true };
  });

  await check('automatic-highlight-custom-color-and-reopen-persistence', async page => {
    await annotateMode(page);
    assertScreen(await geometry(page));
    await page.screenshot({ path: path.join(output, 'iphone-annotation-tools.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Color del resaltador', exact: true }).tap();
    const palette = page.getByRole('dialog', { name: 'Colores del resaltador', exact: true }); await palette.waitFor();
    assert.equal(await palette.locator('.highlight-color-presets button').count(), 12); assertScreen(await geometry(page));
    await page.getByLabel('Color personalizado del resaltador', { exact: true }).fill('#1177dd');
    await page.getByRole('button', { name: 'Color del resaltador', exact: true }).tap();
    await page.getByRole('button', { name: 'Resaltado automático', exact: true }).tap();
    assert.equal(await page.getByRole('button', { name: 'Resaltado automático', exact: true }).getAttribute('aria-pressed'), 'true');
    await selection(page, automaticPhrase, automaticPhrase); await highlights(page).waitFor();
    assert.equal(await selectionMenu(page).count(), 0);
    const saved = await save(page, 'iphone-automatic-export.pdf'); const highlight = saved.inspection.annotations.find(item => item.kind === 'highlight');
    assert.equal(highlight.text, automaticPhrase); assert.equal(highlight.color.toLowerCase(), '#1177dd');
    await removeHighlight(page); await highlights(page).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'Resaltado automático', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.reload(); await open(page, saved.file); assert.equal(await highlights(page).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('folio.highlightColor')), '#1177dd');
    const final = await save(page, 'iphone-automatic-deleted.pdf'); assert.equal(final.inspection.annotations.length, 0);
    return { twelvePresetColors: true, customColor: '#1177dd', stableTextSelectionAutomaticallyHighlights: true, modeSurvivesRemoval: true, deletionSurvivesReload: true, nativeSelectionHandlesNotAutomated: true };
  });

  await check('external-highlight-removal-retains-standard-note', async page => {
    assert.equal(await highlights(page).count(), 1); await removeHighlight(page); await highlights(page).waitFor({ state: 'detached' });
    await page.reload(); await open(page, external); assert.equal(await highlights(page).count(), 0);
    const saved = await save(page, 'iphone-external-removed.pdf');
    assert.equal(saved.inspection.annotations.length, 1); assert.equal(saved.inspection.annotations[0].kind, 'note');
    assert.equal(saved.inspection.annotations[0].text, 'Keep this independent note.');
    assert.deepEqual(operateDocument(saved.bytes, { operation: 'text' }), sourceText);
    return { importedPdfAnnotationRemovedFromFile: true, independentStandardNotePreserved: true, sessionDeletionSurvivesReload: true };
  }, { file: external });

  await check('readonly-copy-and-highlight-permission-enforced', async page => {
    await actions(page);
    assert(await page.getByRole('button', { name: 'Anotar documento', exact: true }).isDisabled());
    await closeDialog(page);
    await selection(page); await selectionMenu(page).waitFor(); assert.equal(await selectionMenu(page).getByRole('button').count(), 1);
    const saved = await save(page, 'iphone-readonly-export.pdf'), originalBytes = new Uint8Array(fs.readFileSync(readOnly));
    // Folio's editable-annotation inspection intentionally excludes a PDF whose
    // permissions forbid editing. Inspect its actual PDF Annots independently.
    assert.deepEqual(saved.bytes, originalBytes, 'Read-only export must preserve every original byte.');
    const native = nativePdfAnnotations(saved.bytes); assert.equal(native.length, 2);
    assert(native.some(item => item.type === 'Highlight')); assert(native.some(item => item.type === 'Text'));
    assert.deepEqual(native, nativePdfAnnotations(originalBytes));
    return { annotationPermissionEnforced: true, copyAllowed: true, externalAnnotationsPreserved: true };
  }, { file: readOnly });

  await check('copy-protection-does-not-expose-text-actions', async page => {
    await annotateMode(page);
    await selection(page); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await selectionMenu(page).count(), 0); assert(await page.getByRole('button', { name: 'Resaltado automático', exact: true }).isDisabled());
    return { copyPermissionEnforced: true, forbiddenTextActionsAbsent: true };
  }, { file: noCopy });

  await check('reading-settings-persist-follow-system-and-single-page', async page => {
    await settings(page); assertScreen(await geometry(page)); await page.screenshot({ path: path.join(output, 'iphone-settings.png'), animations: 'disabled' });
    await page.getByLabel('Zoom inicial', { exact: true }).selectOption('width');
    await page.getByLabel('Modo de desplazamiento', { exact: true }).selectOption('single');
    await page.getByLabel('Panel inicial', { exact: true }).selectOption('bookmarks');
    await page.getByLabel('Reabrir en la última página', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Sistema', exact: true }).tap(); await page.getByRole('button', { name: 'Listo', exact: true }).tap();
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(await page.locator('.pdf-page-wrap').count(), 1); await goToPage(page, 2);
    await page.locator('.pdf-page-wrap[data-page-number="2"]').waitFor(); assert.equal(await page.locator('.pdf-page-wrap').count(), 1);
    await page.reload(); await open(page); assert.equal(await page.getByLabel('Número de página', { exact: true }).inputValue(), '1');
    await page.getByRole('dialog', { name: 'Explorar documento', exact: true }).waitFor(); await page.locator('.bookmark-tree').waitFor({ state: 'attached' });
    assertScreen(await geometry(page)); await closePanel(page); await settings(page);
    assert.equal(await page.getByLabel('Zoom inicial', { exact: true }).inputValue(), 'width'); assert.equal(await page.getByLabel('Modo de desplazamiento', { exact: true }).inputValue(), 'single');
    assert.equal(await page.getByLabel('Panel inicial', { exact: true }).inputValue(), 'bookmarks'); assert.equal(await page.getByLabel('Reabrir en la última página', { exact: true }).isChecked(), false);
    await page.getByLabel('Modo de desplazamiento', { exact: true }).selectOption('continuous'); await page.getByRole('button', { name: 'Listo', exact: true }).tap();
    assert.equal(await page.locator('.pdf-page-wrap').count(), 3);
    return { persistentPreferences: true, responsiveSystemTheme: true, singlePageNavigation: true, defaultPanelOpens: true, restorePageCanBeDisabled: true };
  });

  await check('bookmark-name-tree-pointer-handle-move-and-persistence', async page => {
    const row = title => page.locator('.bookmark-entry').filter({ has: page.locator('.bookmark-label', { hasText: new RegExp(`^${title}$`) }) }).first();
    const rename = async title => { const input = page.getByLabel('Nombre del marcador', { exact: true }); await input.fill(title); await input.press('Enter'); await row(title).waitFor(); };
    const option = async (title, action) => { await page.getByRole('button', { name: `Opciones de ${title}`, exact: true }).tap(); await page.getByRole('menuitem', { name: action, exact: true }).tap(); };
    const stored = async () => page.evaluate(identity => JSON.parse(localStorage.getItem(`folio.session.${identity}`) || 'null'), originals.get(source));
    const waitTree = async predicate => {
      for (let i = 0; i < 80; i++) { const state = await stored(); if (state && predicate(state.bookmarks)) return state.bookmarks; await page.waitForTimeout(50); }
      throw new Error('The bookmark tree was not persisted in the expected state.');
    };
    await page.getByRole('button', { name: 'Guardar marcador de esta página', exact: true }).tap();
    await page.getByRole('dialog', { name: 'Explorar documento', exact: true }).waitFor();
    const name = page.getByLabel('Nombre del marcador', { exact: true }); await name.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Nombre del marcador');
    assert.equal(await name.evaluate(input => input === document.activeElement), true, 'The new bookmark must immediately offer naming.');
    assertScreen(await geometry(page)); await rename('Cover I chose');
    await page.getByRole('button', { name: 'Crear grupo de marcadores', exact: true }).tap(); await rename('Medicine');
    await option('Medicine', 'Añadir grupo dentro'); await rename('Kidney');
    await option('Kidney', 'Añadir página actual dentro'); await rename('Clinical page');
    await option('Kidney', 'Color Azul'); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Crear grupo de marcadores', exact: true }).tap(); await rename('Destination');
    const original = await waitTree(nodes => nodes.length === 5 && nodes.find(node => node.title === 'Kidney')?.color === '#4579ba');
    const medicine = original.find(node => node.title === 'Medicine'), kidney = original.find(node => node.title === 'Kidney'), child = original.find(node => node.title === 'Clinical page'), destination = original.find(node => node.title === 'Destination');
    assert.equal(kidney.parentId, medicine.id); assert.equal(child.parentId, kidney.id);
    const handle = page.getByRole('button', { name: 'Arrastrar Medicine', exact: true }); assert.equal(await handle.count(), 1);
    assert.equal(await handle.evaluate(button => getComputedStyle(button).touchAction), 'none', 'The dedicated handle must opt out of page scrolling.');
    const originBox = await handle.boundingBox(), target = await row('Destination').boundingBox(); assert(originBox && target);
    // Playwright WebKit has tap but no continuous touch-drag API. A real mouse
    // pointer exercises the same handle, hit-testing and capture path. The
    // alternative Mover dialog is also completed entirely with touch taps.
    await page.mouse.move(originBox.x + originBox.width / 2, originBox.y + originBox.height / 2); await page.mouse.down();
    await page.mouse.move(originBox.x + originBox.width / 2 + 10, originBox.y + originBox.height / 2, { steps: 3 });
    await page.locator('.bookmark-drag-preview').waitFor();
    await page.mouse.move(target.x + Math.min(target.width / 2, 130), target.y + target.height / 2, { steps: 12 });
    await row('Destination').locator('xpath=self::*[contains(@class,"drop-inside")]').waitFor();
    await page.screenshot({ path: path.join(output, 'iphone-bookmark-drag.png'), animations: 'disabled' }); await page.mouse.up();
    const moved = await waitTree(nodes => nodes.find(node => node.id === medicine.id)?.parentId === destination.id);
    assert.equal(moved.find(node => node.id === kidney.id).parentId, medicine.id); assert.equal(moved.find(node => node.id === child.id).parentId, kidney.id);
    await option('Medicine', 'Mover…'); await page.getByLabel('Dentro de', { exact: true }).selectOption('');
    assertScreen(await geometry(page)); await page.getByRole('button', { name: 'Mover', exact: true }).tap();
    const final = await waitTree(nodes => nodes.find(node => node.id === medicine.id)?.parentId === null);
    assert.equal(final.find(node => node.id === kidney.id).color, '#4579ba'); assert.equal(final.find(node => node.id === child.id).page, 1);
    await page.setViewportSize({ width: 320, height: 568 });
    assertScreen(await geometry(page));
    const branchLabels = await Promise.all(['Medicine', 'Kidney', 'Clinical page'].map(title => row(title).locator('.bookmark-label').boundingBox()));
    assert(branchLabels.every(Boolean));
    assert(branchLabels[1].x > branchLabels[0].x && branchLabels[2].x > branchLabels[1].x, 'Each child must visibly indent beyond its parent.');
    await page.screenshot({ path: path.join(output, 'iphone-bookmarks.png'), animations: 'disabled' }); await closePanel(page);
    await page.reload(); await open(page); await panel(page, 'Marcadores'); await row('Clinical page').waitFor();
    assert.deepEqual((await stored()).bookmarks, final);
    return { pageBookmarkImmediatelyNames: true, nestedGroupsCreatedThroughUi: true, pointerDragDedicatedHandle: true, touchMoveDialogCompleted: true, branchChildrenAndColorPreserved: true, compactTreeFits320: true, childLabelsVisiblyIndented: true, entireTreePersistsAfterReload: true, physicalTouchDragNotAutomated: true };
  });

  await check('pinch-compositor-bitmap-retention-and-cancel', async page => {
    await page.evaluate(() => {
      const wrap = document.querySelector('.pdf-page-wrap[data-page-number="1"]');
      const trace = { frames: 0, blankFrames: [], zeroDimensions: [], loaders: [], previewTransforms: [], renderScales: [] };
      let frame;
      const sample = () => {
        trace.frames++;
        const canvas = wrap.querySelector('.page-content > canvas');
        if (!canvas || canvas.width === 0 || canvas.height === 0) trace.zeroDimensions.push(trace.frames);
        else {
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let dark = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && pixels[i] < 210 && pixels[i + 1] < 210 && pixels[i + 2] < 210) dark++;
          if (dark < 100) trace.blankFrames.push({ frame: trace.frames, dark });
          const scale = canvas.dataset.renderScale; if (trace.renderScales.at(-1) !== scale) trace.renderScales.push(scale);
        }
        if (wrap.querySelector('.page-loading')) trace.loaders.push(trace.frames);
        const transform = document.querySelector('.pdf-stack').style.transform;
        if (transform && trace.previewTransforms.at(-1) !== transform) trace.previewTransforms.push(transform);
        frame = requestAnimationFrame(sample);
      };
      sample(); window.__iphonePinchTrace = { trace, stop: () => { cancelAnimationFrame(frame); return trace; } };
    });
    async function pinch(ratio, cancel = false) {
      return page.evaluate(async ({ ratio, cancel }) => {
        const root = document.querySelector('.reading-area'), canvas = document.querySelector('.pdf-page-wrap[data-page-number="1"] canvas');
        const initial = Number(canvas.dataset.renderScale), bounds = root.getBoundingClientRect(), x = (bounds.left + bounds.right) / 2, y = Math.min(bounds.top + 170, bounds.bottom - 70);
        // Send standard DOM TouchEvents through the production pinch listeners.
        // This tests the compositor/commit contract, not an OS gesture recognizer.
        let eventConstruction = 'TouchEvent';
        const touches = distance => [{ identifier: 1, target: root, clientX: x - distance / 2, clientY: y }, { identifier: 2, target: root, clientX: x + distance / 2, clientY: y }];
        const dispatch = (type, fingers) => {
          let event;
          try { const native = fingers.map(touch => new Touch(touch)); event = new TouchEvent(type, { bubbles: true, cancelable: true, touches: native, targetTouches: native, changedTouches: native }); }
          catch {
            // The Windows WebKit port exposes Touch but forbids its constructor.
            // Retain the genuine production listener/render test while stating
            // clearly that its touch lists were supplied by the harness.
            eventConstruction = 'Event with synthetic read-only touch lists';
            event = new Event(type, { bubbles: true, cancelable: true });
            for (const name of ['touches', 'targetTouches', 'changedTouches']) Object.defineProperty(event, name, { value: fingers });
          }
          return root.dispatchEvent(event);
        };
        dispatch('touchstart', touches(100)); dispatch('touchmove', touches(100 * ratio));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const preview = { scale: Number(canvas.dataset.renderScale), transform: document.querySelector('.pdf-stack').style.transform, width: canvas.width, height: canvas.height };
        dispatch(cancel ? 'touchcancel' : 'touchend', []);
        return { initial, preview, eventConstruction, expected: cancel ? initial : Math.round(Math.max(.25, Math.min(3, initial * ratio)) * 1000) / 1000 };
      }, { ratio, cancel });
    }
    const scales = [];
    for (const ratio of [1.3, .85, 1.2]) {
      const requested = await pinch(ratio); assert.equal(requested.preview.scale, requested.initial, 'A pinch preview must retain the existing raster.');
      assert(requested.preview.transform.includes('scale('), 'The preview must use the compositor before its final render.');
      await page.waitForFunction(expected => Number(document.querySelector('.pdf-page-wrap[data-page-number="1"] canvas')?.dataset.renderScale) === expected, requested.expected);
      scales.push(requested);
    }
    const canceled = await pinch(1.5, true); assert.equal(canceled.preview.scale, canceled.initial);
    assert.equal(await page.locator('.pdf-stack').evaluate(element => element.style.transform), '');
    assert.equal(await page.locator('.pdf-page-wrap[data-page-number="1"] canvas').evaluate(canvas => Number(canvas.dataset.renderScale)), canceled.initial);
    const trace = await page.evaluate(() => window.__iphonePinchTrace.stop());
    assert(trace.frames >= 5); assert.deepEqual(trace.blankFrames, []); assert.deepEqual(trace.zeroDimensions, []); assert.deepEqual(trace.loaders, []); assert(trace.previewTransforms.length >= 3);
    assertScreen(await geometry(page)); await page.screenshot({ path: path.join(output, 'iphone-after-pinch.png'), animations: 'disabled' });
    return { productionTouchEventPinchHandler: true, physicalGestureNotAutomated: true, compositorPreviewRetainsRaster: true, completedScaleChanges: scales, canceledGestureKeepsScale: true, sampledFrames: trace.frames, blankFrames: 0, loaderFrames: 0 };
  });

  await check('mobile-workbench-page-order-and-image-pdf-creation', async page => {
    await actions(page); await page.getByRole('button', { name: 'Herramientas', exact: true }).tap();
    await page.getByRole('dialog', { name: 'Herramientas', exact: true }).waitFor(); assertScreen(await geometry(page));
    await page.getByRole('button', { name: 'Organizar páginas', exact: true }).tap();
    await page.getByRole('dialog', { name: 'Organizar páginas', exact: true }).waitFor(); assertScreen(await geometry(page));
    await page.getByLabel('Orden o intervalo de páginas', { exact: true }).fill('3,1');
    await page.getByRole('button', { name: 'Usar orden', exact: true }).tap();
    await page.screenshot({ path: path.join(output, 'iphone-organize-pages.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Aplicar orden', exact: true }).tap(); await page.locator('.workbench').waitFor({ state: 'detached' });
    const organized = await save(page, 'iphone-organized-export.pdf'), text = operateDocument(organized.bytes, { operation: 'text' });
    assert.equal(text.length, 2); assert(text[0].includes('FIRST PAGE 3')); assert(text[1].includes('FIRST PAGE 1'));
    await actions(page); await page.getByRole('button', { name: 'Crear PDF', exact: true }).tap();
    await page.getByRole('dialog', { name: 'Crear PDF', exact: true }).waitFor(); await page.getByLabel('Nombre', { exact: true }).fill('iPhone created.pdf');
    await page.locator('.workbench input[type=file]').setInputFiles(imageSource); assertScreen(await geometry(page));
    await page.getByRole('button', { name: 'Crear documento', exact: true }).tap(); await page.locator('.workbench').waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: 'iPhone created.pdf', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
    const created = await save(page, 'iphone-created-image-export.pdf'), document = new mupdf.PDFDocument(created.bytes);
    let images = 0;
    try { assert.equal(document.countPages(), 1); document.findPage(0).get('Resources', 'XObject').forEach(value => { if (value.get('Subtype').asName() === 'Image') images++; }); }
    finally { document.destroy(); }
    assert.equal(images, 1);
    return { pageOrderSavedThroughMobileUi: [3, 1], toolSheetTouchTargetsSized: true, imagePdfCreatedThroughMobileUi: true, actualEmbeddedImages: images };
  }, { viewport: { width: 320, height: 568 } });

  await check('note-tool-pinch-does-not-create-notes-and-short-touch-tap-does', async page => {
    await noteMode(page);
    await page.locator('.page-content.tool-note').first().waitFor();
    const expected = await page.evaluate(async () => {
      const root = document.querySelector('.reading-area'), target = document.querySelector('.page-content.tool-note'), canvas = target.querySelector('canvas');
      const box = root.getBoundingClientRect(), x = (box.left + box.right) / 2, y = Math.min(box.top + 180, box.bottom - 100), initial = Number(canvas.dataset.renderScale);
      const fingers = distance => [{ identifier: 1, target, clientX: x - distance / 2, clientY: y }, { identifier: 2, target, clientX: x + distance / 2, clientY: y }];
      const touch = (type, touches) => { const event = new Event(type, { bubbles: true, cancelable: true }); for (const name of ['touches', 'targetTouches', 'changedTouches']) Object.defineProperty(event, name, { value: touches }); target.dispatchEvent(event); };
      const pointer = (type, finger) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: finger.identifier, button: 0, buttons: type === 'pointerdown' ? 1 : 0, clientX: finger.clientX, clientY: finger.clientY }));
      const initialFingers = fingers(100); pointer('pointerdown', initialFingers[0]); touch('touchstart', [initialFingers[0]]);
      pointer('pointerdown', initialFingers[1]); touch('touchstart', initialFingers); touch('touchmove', fingers(125));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      touch('touchend', []); pointer('pointerup', initialFingers[0]); pointer('pointerup', initialFingers[1]);
      return Math.round(initial * 1.25 * 1000) / 1000;
    });
    await page.waitForFunction(expected => Number(document.querySelector('.pdf-page-wrap[data-page-number="1"] canvas')?.dataset.renderScale) === expected, expected);
    assert.equal(await page.getByRole('dialog', { name: 'Añadir nota', exact: true }).count(), 0, 'A second finger converting the touch into a pinch must not add a note.');
    assert.equal(await page.locator('.note-marker').count(), 0);
    const bounds = await reader(page).boundingBox();
    await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + Math.min(180, bounds.height / 2));
    await page.getByRole('dialog', { name: 'Añadir nota', exact: true }).waitFor();
    await page.getByLabel('Texto de la nota', { exact: true }).fill('Created by one short touch tap.');
    await page.getByRole('button', { name: 'Guardar nota', exact: true }).tap(); await page.getByRole('button', { name: 'Cerrar anotaciones', exact: true }).tap();
    assert.equal(await page.locator('.note-marker').count(), 1); assertScreen(await geometry(page));
    const saved = await save(page, 'iphone-short-touch-note.pdf'); assert.equal(saved.inspection.annotations.length, 1);
    assert.equal(saved.inspection.annotations[0].kind, 'note'); assert.equal(saved.inspection.annotations[0].text, 'Created by one short touch tap.');
    return { pendingNoteCanceledByTwoFingerPinchContract: true, twoFingerEventsSynthetic: true, actualTouchscreenShortTapCreatesOneNote: true, standardPdfNoteSaved: true };
  });

  await check('webkit-recent-file-and-real-pdf-draft-survive-reload', async page => {
    const identity = originals.get(source);
    const storageSnapshot = () => page.evaluate(async identity => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('folio-library', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const get = store => new Promise((resolve, reject) => { const request = db.transaction(store, 'readonly').objectStore(store).get(identity); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        const [draft, recent] = await Promise.all([get('drafts'), get('documents')]);
        const asBytes = async value => value ? [...new Uint8Array(value instanceof Blob ? await value.arrayBuffer() : value)] : [];
        return { draft: await asBytes(draft), recent: await asBytes(recent?.data), recentName: recent?.name, recentId: recent?.id, session: JSON.parse(localStorage.getItem(`folio.session.${identity}`) || 'null') };
      } finally { db.close(); }
    }, identity);
    await page.waitForFunction(async identity => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('folio-library', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise(resolve => { const request = db.transaction('documents', 'readonly').objectStore('documents').get(identity); request.onsuccess = () => resolve(!!request.result?.data); }); }
      finally { db.close(); }
    }, identity);
    await actions(page); await page.getByRole('button', { name: 'Herramientas', exact: true }).tap(); await page.getByRole('button', { name: 'Organizar páginas', exact: true }).tap();
    await page.getByLabel('Orden o intervalo de páginas', { exact: true }).fill('2,1'); await page.getByRole('button', { name: 'Usar orden', exact: true }).tap();
    await page.getByRole('button', { name: 'Aplicar orden', exact: true }).tap(); await page.locator('.workbench').waitFor({ state: 'detached' });
    await page.waitForFunction(async identity => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('folio-library', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise(resolve => { const request = db.transaction('drafts', 'readonly').objectStore('drafts').get(identity); request.onsuccess = () => resolve(!!request.result?.byteLength); }); }
      finally { db.close(); }
    }, identity);
    const before = await storageSnapshot(), beforeDraft = new Uint8Array(before.draft);
    assert.equal(operateDocument(beforeDraft, { operation: 'text' }).length, 2, 'The stored draft must contain the two edited pages before reload.');
    const snapshotSummary = (value, stage) => ({ stage, draftPages: value.draft.length ? operateDocument(new Uint8Array(value.draft), { operation: 'text' }).length : 0,
      draftHash: createHash('sha256').update(new Uint8Array(value.draft)).digest('hex'), recentHash: createHash('sha256').update(new Uint8Array(value.recent)).digest('hex'),
      recentId: value.recentId, recentName: value.recentName, sessionRevision: value.session?.documentRevision });
    const beforeSummary = snapshotSummary(before, 'before-reload');
    await page.reload(); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    const afterSummary = snapshotSummary(await storageSnapshot(), 'after-reload-before-open');
    await page.evaluate(summaries => { window.__iphoneDraftSummaries = summaries; }, [beforeSummary, afterSummary]);
    assert.equal(afterSummary.draftPages, 2, 'The stored draft must remain two pages after reload.');
    assert.equal(afterSummary.recentHash, identity, 'The recent document must remain the original PDF bytes.');
    await actions(page); await page.getByRole('button', { name: 'Mis documentos', exact: true }).tap();
    const row = page.locator('.recent-row').filter({ has: page.locator('strong', { hasText: /^iphone-reading\.pdf$/ }) }); await row.waitFor();
    assertScreen(await geometry(page)); await row.locator('button').first().tap();
    await heading(page, source).waitFor({ state: 'attached' }); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    const reopenedSummary = snapshotSummary(await storageSnapshot(), 'after-open');
    await page.evaluate(summary => window.__iphoneDraftSummaries.push(summary), reopenedSummary);
    assert.equal(await page.locator('.pdf-page-wrap').count(), 2);
    await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: 'FIRST PAGE 2' }).waitFor();
    const saved = await save(page, 'iphone-recovered-draft.pdf'), text = operateDocument(saved.bytes, { operation: 'text' });
    assert.equal(text.length, 2); assert(text[0].includes('FIRST PAGE 2')); assert(text[1].includes('FIRST PAGE 1'));
    assert.equal(await page.locator('.toast.error').count(), 0, 'A restored document must not report a library or draft failure.');
    return { originalFileRememberedInWebKit: true, reopenFromRecentUi: true, modifiedPdfBytesRecoveredAfterReload: true, recoveredPageOrder: [2, 1], storageSnapshots: [beforeSummary, afterSummary, reopenedSummary], storageErrorToast: false };
  });
} finally {
  await browser?.close(); server.kill();
  if (snapshot) { assert(snapshot.startsWith(snapshotRoot + path.sep)); fs.rmSync(snapshot, { recursive: true, force: true }); }
  const report = { capturedAt: new Date().toISOString(), passed: results.length > 0 && results.every(result => result.status === 'passed') && errors.length === 0, results, errors,
    builtIndexSha256: builtIndexHash,
    scope: 'Real browser PDF rendering, text Range, UI touch taps, standard PDF export and persistence.',
    limitations: ['The WebKit browser harness does not automate UIKit Files or Share sheets.', 'Native iOS text-selection handles and physical pinch gestures need separate simulator/device validation.', 'Viewport sizes do not emulate actual notch safe-area insets.'],
    ...(results.some(result => result.status === 'failed') ? { serverLog: log } : {}) };
  fs.writeFileSync(path.join(output, 'iphone-results.json'), JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
