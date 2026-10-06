import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { chromium, webkit } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { inspectDocument, writeAnnotations } from '../../src/engine/mupdf-engine.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';
import { storedSession } from './session-helpers.mjs';

// WebKit's mobile browser context provides genuine DOM text selection, PDF.js
// rendering and browser downloads. It does not automate UIKit selection handles,
// Files/Share sheets, a device notch or a physical two-finger gesture. Those
// limitations are retained in the machine-readable report, including on CI.
const root = process.cwd(), output = path.join(root, 'test-results', 'iphone', process.env.FOLIO_IPHONE_OUTPUT || '');
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
const editorSource = path.join(output, 'iphone-editor.pdf');
const pictureFixture = await PDFDocument.create();
pictureFixture.addPage([80, 40]).drawRectangle({ x: 0, y: 0, width: 80, height: 40, color: rgb(0, .7, .2) });
const pictureDocument = new mupdf.PDFDocument(await pictureFixture.save()), picturePage = pictureDocument.loadPage(0);
const picturePixmap = picturePage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
const editorImage = new Uint8Array(picturePixmap.asPNG()); picturePixmap.destroy(); picturePage.destroy(); pictureDocument.destroy();
const editorFixture = await PDFDocument.create(), editorFont = await editorFixture.embedFont(StandardFonts.Helvetica);
const editorPage = editorFixture.addPage([420, 560]), embeddedImage = await editorFixture.embedPng(editorImage);
editorPage.drawText('MOBILE ORIGINAL', { x: 32, y: 460, size: 16, font: editorFont });
editorPage.drawText('KEEP NEIGHBOR', { x: 32, y: 400, size: 14, font: editorFont });
editorPage.drawImage(embeddedImage, { x: 32, y: 230, width: 80, height: 40 });
fs.writeFileSync(editorSource, writeAnnotations(await editorFixture.save(), [{ id: 'mobile-editor-note', kind: 'note', page: 1,
  rect: [320, 400, 340, 420], text: 'KEEP MOBILE NOTE', color: '#ffcc00', created: 1 }]));
const originals = new Map([source, another, external, readOnly, noCopy, editorSource].map(file => [file, hash(file)]));
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
const frontendEntry = snapshot ? fs.readFileSync(path.join(snapshot, 'index.html'), 'utf8').match(/<script[^>]+src="([^"]+)"/)?.[1] : '/src/main.tsx';
assert(frontendEntry, 'The tested frontend entry must be identifiable.');
const browserName = process.env.FOLIO_TEST_BROWSER === 'chromium' ? 'Chromium' : 'WebKit';
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), ...(snapshot ? ['preview', '--outDir', snapshot] : []), '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
let log = '', browser; server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
const results = [], errors = [];
const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const selectionMenu = page => page.getByRole('toolbar', { name: 'Herramientas del texto seleccionado', exact: true });
const highlights = page => page.locator('.highlight-annotation:not(.preview)');
const reader = page => page.locator('.reading-area');
const heading = (page, file) => page.getByRole('heading', { name: path.basename(file), exact: true, includeHidden: true });

async function open(page, files = source) {
  await page.waitForFunction(() => !document.querySelector('.loading-overlay') && !document.querySelector('.app-header button[aria-label="Volver a la biblioteca"]')?.disabled);
  await page.locator('.app-header input[type=file]').setInputFiles(files);
  await heading(page, Array.isArray(files) ? files.at(-1) : files).waitFor({ state: 'attached' });
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
  await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').first().waitFor();
}
async function goToPage(page, number) {
  await page.getByRole('button', { name: 'Ir a página', exact: true }).tap();
  const input = page.getByLabel(/^Página \(1–/); await input.fill(String(number)); await input.press('Enter');
  await waitForReadingPage(page, number);
  assert.equal(await readingPage(page), number);
}
async function readingPage(page) { return page.locator('.mobile-page-jump').evaluate(button => Number(button.title.match(/^Página (\d+) de /)?.[1] || button.textContent.trim().split('/')[0])); }
async function waitForReadingPage(page, requested = null) {
  await page.evaluate(() => { window.__iphoneNavigation = { number: null, scrollTop: null, stableFrames: 0 }; });
  await page.waitForFunction(requested => {
    const sample = window.__iphoneNavigation, viewer = document.querySelector('.reading-area');
    const counter = document.querySelector('.mobile-page-jump');
    const number = Number(counter?.title.match(/^Página (\d+) de /)?.[1] || counter?.textContent.trim().split('/')[0]);
    const wrap = viewer?.querySelector(`.pdf-page-wrap[data-page-number="${number}"]`);
    const canvas = wrap?.querySelector('.page-content > canvas');
    const bounds = wrap?.getBoundingClientRect(), visible = viewer?.getBoundingClientRect();
    const inView = bounds && visible && bounds.bottom > visible.top && bounds.top < visible.bottom;
    const atBottom = viewer && viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 1;
    const atReadingStart = inView && bounds.top >= visible.top - 1 && (bounds.top <= visible.top + 72 || atBottom);
    const published = canvas && canvas.width > 0 && canvas.height > 0 && !!canvas.dataset.renderScale
      && canvas.dataset.rendering === 'false' && !wrap.querySelector('.page-loading');
    const ready = inView && published && (requested === null || (number === requested && atReadingStart));
    const stationary = viewer && sample.number === number && Math.abs(viewer.scrollTop - sample.scrollTop) < .2;
    sample.stableFrames = ready && stationary ? sample.stableFrames + 1 : 0;
    sample.number = number; sample.scrollTop = viewer?.scrollTop;
    sample.pageTop = bounds?.top; sample.viewerTop = visible?.top; sample.published = !!published;
    return sample.stableFrames >= 3;
  }, requested, { polling: 'raf' });
}
async function actions(page) {
  if (await page.getByRole('button', { name: 'Listo', exact: true }).isVisible()) await page.getByRole('button', { name: 'Listo', exact: true }).tap();
  await page.getByRole('button', { name: /^Más acciones(?: del documento)?$/ }).tap();
  return page.getByRole('dialog', { name: 'Acciones del documento', exact: true });
}
async function settings(page) {
  await library(page); await page.getByRole('button', { name: 'Ajustes', exact: true }).tap();
  await page.getByRole('dialog', { name: 'Ajustes', exact: true }).waitFor();
}
async function library(page) {
  if (!await page.locator('.library-screen').isVisible()) await page.getByRole('button', { name: 'Volver a la biblioteca', exact: true }).tap();
  await page.locator('.library-screen').waitFor();
}
async function continueReading(page) { await page.locator('.document-library-continue').tap(); await page.locator('.library-screen').waitFor({state:'detached'}); }
async function viewSettings(page) {
  await actions(page); await page.getByRole('button', {name:'Vista del documento',exact:true}).tap();
  await page.getByRole('dialog', {name:'Vista del documento',exact:true}).waitFor();
}
async function annotateMode(page) {
  await page.getByRole('button', { name: 'Anotar', exact: true }).tap();
  await page.getByRole('button', { name: 'Resaltador', exact: true }).waitFor();
}
async function noteMode(page) {
  await annotateMode(page); await page.getByRole('button', { name: 'Nota', exact: true }).tap();
}
async function closeDialog(page) {
  if (await page.locator('.document-switcher').isVisible()) { await page.keyboard.press('Escape'); await page.locator('.document-switcher').waitFor({state:'detached'}); return; }
  await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).tap();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
}
async function save(page, name) {
  await actions(page); const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar PDF', exact: true }).tap();
  const downloaded = await pending, file = path.join(output, name); await downloaded.saveAs(file);
  await page.waitForFunction(() => !document.querySelector('.loading-overlay') && !document.querySelector('.app-header button[aria-label="Volver a la biblioteca"]')?.disabled);
  // Offscreen pages deliberately release their rendered content on iOS. Wait
  // for the current reading page to publish its bitmap instead of loading an
  // unrelated first page that may be outside the lazy-rendering margin.
  await waitForReadingPage(page);
  const bytes = new Uint8Array(fs.readFileSync(file));
  return { file, bytes, inspection: inspectDocument(bytes) };
}
async function tabs(page) {
  await page.getByRole('button', { name: 'Documentos abiertos y recientes', exact: true }).tap();
  await page.getByRole('dialog', { name: 'Documentos abiertos y recientes', exact: true }).waitFor();
  await page.locator('.document-switcher').evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
}
async function switchTo(page, file) {
  await tabs(page); await page.getByRole('button', { name: `Cambiar a ${path.basename(file)}`, exact: true }).tap();
  await heading(page, file).waitFor({ state: 'attached' }); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
}
async function panel(page, tab = 'Marcadores') {
  if (!await page.getByRole('dialog', { name: 'Explorar documento', exact: true }).isVisible()) await page.getByRole('button', { name: 'Páginas', exact: true }).tap();
  await page.getByRole('tab', { name: tab, exact: true }).tap();
}
async function closePanel(page) {
  await page.getByRole('button', { name: 'Cerrar panel', exact: true }).tap();
  await page.getByRole('dialog', { name: 'Explorar documento', exact: true }).waitFor({ state: 'detached' });
}
async function focusAppearance(page, expected = null) {
  const samples = await page.evaluate(() => [...new Set([
    document.activeElement, ...document.querySelectorAll(':focus, :focus-visible, .sheet-handle'),
  ])].filter(element => element instanceof HTMLElement).map(element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    const outline = pseudo => {
      const value = getComputedStyle(element, pseudo);
      return { style: value.outlineStyle, width: parseFloat(value.outlineWidth), color: value.outlineColor };
    };
    return { label: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 80), tag: element.tagName, type: element.getAttribute('type'),
      className: element.className, focused: element === document.activeElement, focusVisible: element.matches(':focus-visible'),
      visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden', outline: outline(null),
      before: outline('::before'), after: outline('::after'), boxShadow: style.boxShadow,
      selectedAnnotation: element.matches('.highlight-annotation[data-selected=true]') };
  }));
  for (const sample of samples) {
    if (sample.selectedAnnotation) continue;
    const parts = [['element', sample.outline], ['before', sample.before], ['after', sample.after]], painted = ([, outline]) => outline.style !== 'none' && outline.width > 0;
    // A tap never draws a focus ring and touch text fields rely on the caret; keyboard focus (:focus-visible) must stay visible.
    const textField = sample.tag === 'TEXTAREA' || sample.tag === 'INPUT' && !['checkbox', 'radio', 'range', 'color', 'file'].includes(sample.type);
    if (sample.focusVisible && sample.focused && !textField) assert(parts.some(painted) || sample.boxShadow !== 'none', `Keyboard focus must show an indicator: ${JSON.stringify(sample)}`);
    else for (const [part, outline] of parts) {
      assert(!painted([part, outline]), `Touch focus must not paint an outline (${part}): ${JSON.stringify(sample)}`);
    }
    if (String(sample.className).split(' ').includes('sheet-handle')) assert.equal(sample.boxShadow, 'none', 'The sheet handle must not paint a focus shadow.');
  }
  if (expected) assert.equal(await expected.evaluate(element => element === document.activeElement), true, 'Focus must remain on the functional control instead of being blurred to hide its outline.');
  return samples;
}

async function touchFocusControl(page, control) {
  await control.tap();
  return focusAppearance(page);
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
  // Opening/removing an annotation must cancel the PDF's pending short tap,
  // even when its menu closes before the double-tap recognition timer expires.
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.app-shell').evaluate(shell=>shell.classList.contains('reader-chrome-hidden')),false,'Annotation interactions cancel the deferred reader chrome toggle.');
}
async function geometry(page) {
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight, windowScroll: [scrollX, scrollY],
    reader: (() => { const element = document.querySelector('.reading-area'), box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; })(),
    inputs: [...document.querySelectorAll('input:not([type=file]):not([type=range]):not([type=color]):not([type=checkbox]),select,textarea')].filter(element => element.getClientRects().length).map(element => ({ label: element.getAttribute('aria-label') || element.name, fontSize: parseFloat(getComputedStyle(element).fontSize) })),
    buttons: [...document.querySelectorAll('button')].filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden').map(element => {
      const box = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label') || element.textContent.trim(), width: box.width, height: box.height, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        pdfPrecisionTarget: element.matches('.content-box-handle, .pdf-content-item') };
    }),
  }));
}
function assertScreen(geometry, { touchTargets = true, inputFonts = true } = {}) {
  assert(geometry.documentWidth <= geometry.width + 1, `Screen scrolls horizontally: ${JSON.stringify(geometry)}`);
  assert(geometry.documentHeight <= geometry.height + 1, `Outer document scrolls vertically: ${JSON.stringify(geometry)}`);
  assert.deepEqual(geometry.windowScroll, [0, 0], 'The app shell must remain fixed while the document scrolls.');
  // PDF objects and their precision handles retain the PDF's own geometry;
  // enlarging them would overlap neighboring content. Ordinary UI actions,
  // including zoom, editor tabs, reset and commit, still require 44px targets.
  if (touchTargets) for (const button of geometry.buttons) if (!button.pdfPrecisionTarget) assert(button.width >= 43.5 && button.height >= 43.5, `Small touch target: ${JSON.stringify(button)}`);
  if (inputFonts) for (const input of geometry.inputs) assert(input.fontSize >= 16, `An input could trigger iOS focus zoom: ${JSON.stringify(input)}`);
}
async function check(id, action, options = {}) {
  if (!selected(id)) return;
  const viewport = options.viewport || { width: 390, height: 844 };
  const context = await browser.newContext({ viewport, screen: viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent, acceptDownloads: true, colorScheme: options.theme || 'light' });
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  await context.addInitScript(() => { Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' }); Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: undefined }); });
  if (options.theme) await context.addInitScript(theme => localStorage.setItem('folio.theme', theme), options.theme);
  const diagnostics = [], outside = [], caseErrors = [];
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) diagnostics.push({ type: message.type(), text: message.text() }); });
  page.on('pageerror', error => { const issue = { id, error: error.message }; caseErrors.push(issue); errors.push(issue); });
  page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) outside.push(request.url()); });
  try {
    await page.goto(origin); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await open(page, options.file || source);
    const evidence = await action(page, context); assert.deepEqual(caseErrors, []); assert.deepEqual(outside, [], 'No document processing may call an outside service.');
    for (const [file, initialHash] of originals) assert.equal(hash(file), initialHash, 'The original file must remain unchanged.');
    results.push({ id, status: 'passed', viewport, engine: process.env.FOLIO_TEST_BROWSER === 'chromium' ? 'chromium' : 'webkit', browser: browserName, frontendEntry, ...evidence, originalFilesUnchanged: true, outsideRequests: [] });
  } catch (error) {
    process.exitCode = 1; results.push({ id, status: 'failed', browser: browserName, frontendEntry, viewport, error: error.stack, diagnostics, uiState: await page.evaluate(() => ({
      selection: window.getSelection()?.toString(), collapsed: window.getSelection()?.isCollapsed, highlightTapEvents: window.__iphoneHighlightTapEvents,
      draftSummaries: window.__iphoneDraftSummaries,
      navigation: window.__iphoneNavigation,
      chromeNoteEvents: window.__iphoneChromeNoteEvents,
      editorPreview: window.__iphoneEditorPreview,
      touchTargetViolations: [...document.querySelectorAll('button')].filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden').map(element => {
        const box = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label') || element.textContent.trim(), width: box.width, height: box.height };
      }).filter(box => box.width < 43.5 || box.height < 43.5),
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
    if (stripVTControlCharacters(log).includes(origin)) try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, log || 'Vite did not start.');
  if (process.env.FOLIO_TEST_BROWSER === 'chromium') {
    const executablePath = findChrome();
    assert(executablePath, 'Set CHROME_PATH to the installed Chromium executable.'); browser = await chromium.launch({ executablePath, headless: true });
  } else browser = await webkit.launch({ headless: true });

  for (const theme of ['light', 'dark']) {
    await check(`touch-focus-document-sheet-${theme}`, async page => {
      await open(page, another);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      const opener = page.getByRole('button', { name: 'Documentos abiertos y recientes', exact: true });
      await opener.focus(); const before = await focusAppearance(page, opener);
      await opener.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Documentos abiertos y recientes', exact: true }); await dialog.waitFor();
      await dialog.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
      assert.equal(await dialog.getByRole('button', { name: /^Cambiar a / }).count(), 2);
      assert.equal(await dialog.locator('.document-switcher-row.selected').count(), 1);
      // Opened from the keyboard, focus starts on the current document; the arrows move through the list.
      const current = dialog.locator('.document-switcher-row.selected').getByRole('button', { name: /^Cambiar a / });
      await focusAppearance(page, current);
      await page.keyboard.press('ArrowDown');
      assert.equal(await current.evaluate(element => element !== document.activeElement && !!document.activeElement?.closest('.document-switcher')), true, 'Arrow keys move focus within the document list.');
      await focusAppearance(page);
      assertScreen(await geometry(page));
      await page.screenshot({ path: path.join(output, `iphone-focus-documents-${theme}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
      const restored = await focusAppearance(page, opener);
      await opener.tap(); await dialog.waitFor(); await opener.tap(); await dialog.waitFor({state:'detached'});
      await opener.tap(); await dialog.waitFor();
      await dialog.getByRole('button', { name: `Cambiar a ${path.basename(source)}`, exact: true }).tap();
      await heading(page, source).waitFor({ state: 'attached' }); await waitForReadingPage(page, 1);
      await focusAppearance(page);
      return { theme, realTouchTaps: true, anchoredDocumentPicker: true, keyboardNavigation: true,
        escapeRestoresFocus: true, triggerTogglesPicker: true, touchDocumentSwitchWorks: true,
        originalDocumentSelectionStillVisible: true, focusSamples: { before, restored } };
    }, { theme });

    await check(`touch-focus-explorer-panels-${theme}`, async page => {
      const opener = page.getByRole('button', { name: 'Páginas', exact: true });
      await opener.focus(); await opener.tap();
      const explorer = page.getByRole('dialog', { name: 'Explorar documento', exact: true }); await explorer.waitFor();
      // The sheet handle is a gesture aid hidden from assistive technology; the close button takes focus.
      const handle = explorer.getByRole('button', { name: 'Cerrar panel', exact: true });
      await focusAppearance(page, handle);
      const snapshots = [];
      for (const tab of ['Páginas', 'Índice', 'Marcadores']) {
        const control = explorer.getByRole('tab', { name: tab, exact: true });
        await control.tap(); assert.equal(await control.getAttribute('aria-selected'), 'true');
        snapshots.push({ tab, appearance: await focusAppearance(page) });
      }
      await explorer.getByRole('tab', { name: 'Anotaciones', exact: true }).tap();
      const annotations = page.getByRole('dialog', { name: 'Anotaciones', exact: true }); await annotations.waitFor();
      await focusAppearance(page, annotations.getByRole('button', { name: 'Cerrar panel', exact: true }));
      assertScreen(await geometry(page));
      await page.screenshot({ path: path.join(output, `iphone-focus-explorer-${theme}.png`), animations: 'disabled' });
      await annotations.getByRole('button', { name: 'Cerrar panel', exact: true }).tap(); await annotations.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Páginas');
      await focusAppearance(page, opener);
      await panel(page, 'Páginas');
      await page.getByRole('dialog', { name: 'Explorar documento', exact: true }).getByRole('button', { name: 'Ir a página 2', exact: true }).tap();
      await waitForReadingPage(page, 2);
      assert.equal(await page.getByRole('dialog', { name: 'Explorar documento', exact: true }).count(), 0);
      await focusAppearance(page);
      return { theme, explorerHandleAutoFocusRetained: true, tabSelectionPreserved: snapshots,
        annotationsPanelTouchDismiss: true, restoredPagesFocus: true, touchThumbnailNavigatesPage: 2 };
    }, { theme });

    await check(`touch-focus-page-search-and-settings-${theme}`, async page => {
      const jumpOpener = page.getByRole('button', { name: 'Ir a página', exact: true });
      await jumpOpener.focus(); await jumpOpener.press('Enter');
      const jump = page.getByRole('dialog', { name: 'Ir a página', exact: true }); await jump.waitFor();
      const number = jump.getByLabel(/^Página \(1–/);
      const initialNumberFocus = await number.evaluate(element => element === document.activeElement);
      assert.equal(initialNumberFocus, true, 'Opening the page form must honor its explicitly requested autofocus input.');
      await focusAppearance(page); await number.tap(); await number.fill('2');
      await focusAppearance(page, number); assert.equal(await number.inputValue(), '2');
      await jump.getByRole('button', { name: 'Ir a página', exact: true }).tap(); await jump.waitFor({ state: 'detached' });
      await waitForReadingPage(page, 2); await focusAppearance(page, jumpOpener);
      await page.getByRole('button', { name: 'Buscar', exact: true }).tap();
      const search = page.getByRole('dialog', { name: 'Buscar en el PDF', exact: true }); await search.waitFor();
      const query = search.getByLabel('Buscar texto en el PDF', { exact: true });
      await query.tap(); await query.fill('CONTENT 3'); await focusAppearance(page, query);
      await search.locator('.search-result').waitFor();
      assert.equal(await search.locator('.search-result').count(), 1);
      await page.screenshot({ path: path.join(output, `iphone-focus-search-${theme}.png`), animations: 'disabled' });
      await search.locator('.search-result').tap(); await search.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('.mobile-page-jump')?.title.startsWith('Página 3 de '));
      await focusAppearance(page);
      await page.getByRole('button', { name: 'Cerrar búsqueda', exact: true }).tap();
      await settings(page);
      const settingsDialog = page.getByRole('dialog', { name: 'Ajustes', exact: true });
      // The sheet handle is only a gesture aid; focus starts on the close button.
      await focusAppearance(page, settingsDialog.getByRole('button', { name: 'Cerrar diálogo', exact: true }));
      const themeButton = settingsDialog.getByRole('button', { name: theme === 'light' ? 'Claro' : 'Oscuro', exact: true });
      await touchFocusControl(page, themeButton); assert.equal(await themeButton.getAttribute('aria-pressed'), 'true');
      const zoom = settingsDialog.getByLabel('Zoom inicial', { exact: true });
      await zoom.tap(); await zoom.selectOption('width'); await focusAppearance(page);
      assert.equal(await zoom.inputValue(), 'width');
      await page.screenshot({ path: path.join(output, `iphone-focus-settings-${theme}.png`), animations: 'disabled' });
      await settingsDialog.getByRole('button', { name: 'Listo', exact: true }).tap(); await settingsDialog.waitFor({ state: 'detached' });
      await focusAppearance(page); await continueReading(page); await focusAppearance(page);
      return { theme, pageJumpInputInitiallyFocused: initialNumberFocus, inputKeepsEditableFocusAfterTouch: true, pageJumpByTouch: 2, searchInputEditable: true,
        searchResultNavigationByTouch: 3, settingsThemeSelectionPreserved: true, nativeSelectValueUpdated: true,
        focusRestoredAfterPageForm: true, noTouchOutlineAndVisibleKeyboardFocus: true };
    }, { theme });
  }

  await check('mobile-content-editor-text-image-export-reopen', async page => {
    const picker = () => page.locator('.pdf-content-picker[data-page="1"][data-picker-state="ready"]').waitFor({ timeout: 60000 });
    const ready = (intent = 'edit') => page.locator(`.content-editor[data-intent="${intent}"][data-preview-state="ready"]`).waitFor({ timeout: 60000 });
    const centeredPreview = async () => {
      await page.evaluate(() => { window.__iphoneEditorPreview = { stableFrames: 0 }; });
      await page.waitForFunction(() => {
        const editor = document.querySelector('.content-editor'), host = editor?.querySelector('.content-preview'), destination = editor?.querySelector('.content-box[data-role=destination]');
        if (!host || !destination) return false;
        const frame = destination.getBoundingClientRect(), visible = host.getBoundingClientRect(), sample = window.__iphoneEditorPreview;
        const fullyVisible = frame.width > 0 && frame.height > 0 && frame.left >= visible.left - 1 && frame.right <= visible.right + 1
          && frame.top >= visible.top - 1 && frame.bottom <= visible.bottom + 1 && visible.top >= 0 && visible.bottom <= innerHeight;
        const stationary = sample.scrollTop === host.scrollTop && sample.scrollLeft === host.scrollLeft
          && sample.left === frame.left && sample.top === frame.top && sample.width === frame.width && sample.height === frame.height;
        sample.stableFrames = editor.dataset.previewState === 'ready' && fullyVisible && stationary ? sample.stableFrames + 1 : 0;
        Object.assign(sample, { fullyVisible, previewState: editor.dataset.previewState, scrollTop: host.scrollTop, scrollLeft: host.scrollLeft,
          left: frame.left, top: frame.top, width: frame.width, height: frame.height,
          viewport: { left: visible.left, top: visible.top, right: visible.right, bottom: visible.bottom } });
        return sample.stableFrames >= 3;
      }, undefined, { polling: 'raf' });
      return page.evaluate(() => window.__iphoneEditorPreview);
    };
    const intent = async value => {
      await page.getByRole('button', { name: value === 'duplicate' ? 'Duplicar' : 'Eliminar', exact: true }).tap(); await ready(value);
    };
    const commit = async (value = 'edit') => {
      await ready(value);
      await reachableTap(page.getByRole('button', { name: value === 'duplicate' ? 'Aplicar duplicación' : value === 'delete' ? 'Aplicar eliminación' : 'Aplicar cambios', exact: true }));
      await picker();
    };
    const reachableTap = async button => {
      await button.scrollIntoViewIfNeeded();
      const bounds = await button.boundingBox(); assert(bounds && bounds.width >= 43.5 && bounds.height >= 43.5, 'Editor action must retain a touch-sized target.');
      const viewport = page.viewportSize(); assert(bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1,
        `Editor action must be fully reachable within the mobile viewport: ${JSON.stringify(bounds)}`);
      assert(await button.evaluate(element => {
        const box = element.getBoundingClientRect(), target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return !!target && (element === target || element.contains(target));
      }), 'Editor action must not be obscured by another panel.');
      await button.tap(); await focusAppearance(page);
    };
    const history = async direction => {
      const previous = await page.locator('.pdf-content-picker').elementHandle();
      await reachableTap(page.getByRole('button', { name: direction, exact: true }));
      await page.waitForFunction(element => !element.isConnected, previous, { timeout: 60000 }); await picker();
    };
    await actions(page); await page.getByRole('button', { name: 'Herramientas', exact: true }).tap();
    await page.getByRole('dialog', { name: 'Herramientas', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Editar PDF', exact: true }).tap();
    const editor = page.getByRole('dialog', { name: 'Editar PDF', exact: true }); await editor.waitFor(); await picker();
    assert.equal(await page.locator('.workspace-editor').count(), 0, 'Mobile editing uses its bounded sheet, separately from desktop inline editing.');
    await page.getByRole('button', { name: 'Párrafo: MOBILE ORIGINAL', exact: true }).tap(); await ready();
    const text = page.getByRole('textbox', { name: 'Texto', exact: true }); await text.tap(); await text.fill('MOBILE EDITED');
    await focusAppearance(page, text); await ready(); assertScreen(await geometry(page));
    const portraitPreview = await centeredPreview();
    await page.screenshot({ path: path.join(output, 'iphone-editor-portrait.png'), animations: 'disabled' });
    await commit();
    await page.locator('.pdf-content-item[data-kind="image"][data-editable="true"]').tap(); await ready();
    await intent('duplicate'); await page.getByLabel('Posición X', { exact: true }).fill('200'); await ready('duplicate');
    await page.setViewportSize({ width: 844, height: 390 }); await ready('duplicate');
    assertScreen(await geometry(page));
    const landscapePreview = await centeredPreview();
    await page.screenshot({ path: path.join(output, 'iphone-editor-landscape.png'), animations: 'disabled' });
    await commit('duplicate');
    assert.equal(await page.locator('.pdf-content-item[data-kind="image"]').count(), 2);
    const selectCopy = async () => {
      const items = page.locator('.pdf-content-item[data-kind="image"][data-editable="true"]');
      const lefts = await items.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
      await items.nth(lefts.indexOf(Math.max(...lefts))).tap(); await ready();
    };
    await selectCopy(); await intent('delete'); await reachableTap(page.getByRole('button', { name: 'Descartar edición', exact: true })); await picker();
    assert.equal(await page.locator('.pdf-content-item[data-kind="image"]').count(), 2, 'Cancelling deletion must retain both images.');
    await selectCopy(); await intent('delete'); await commit('delete');
    assert.equal(await page.locator('.pdf-content-item[data-kind="image"]').count(), 1);
    await history('Deshacer'); assert.equal(await page.locator('.pdf-content-item[data-kind="image"]').count(), 2);
    await history('Rehacer'); assert.equal(await page.locator('.pdf-content-item[data-kind="image"]').count(), 1);
    await history('Deshacer'); assert.equal(await page.locator('.pdf-content-item[data-kind="image"]').count(), 2);
    await reachableTap(page.getByRole('button', { name: 'Listo', exact: true })); await editor.waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 390, height: 844 }); await waitForReadingPage(page, 1);
    const saved = await save(page, 'iphone-editor-export.pdf'), texts = operateDocument(saved.bytes, { operation: 'text' });
    assert(texts[0].includes('MOBILE EDITED') && !texts[0].includes('MOBILE ORIGINAL') && texts[0].includes('KEEP NEIGHBOR'));
    assert(saved.inspection.annotations.some(item => item.text === 'KEEP MOBILE NOTE'));
    assert.equal(operateDocument(saved.bytes, { operation: 'page-content', page: 1 }).items.filter(item => item.kind === 'image').length, 2);
    const rendered = new mupdf.PDFDocument(saved.bytes), renderedPage = rendered.loadPage(0), pixmap = renderedPage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    try {
      const pixels = pixmap.getPixels(), pixel = (x, y) => [...pixels.subarray((y * pixmap.getWidth() + x) * 3, (y * pixmap.getWidth() + x) * 3 + 3)];
      for (const point of [[60, 310], [230, 310]]) { const value = pixel(...point); assert(value[1] > value[0] + 100 && value[1] > value[2] + 80, 'The original image and its copy must exist as rendered PDF pixels.'); }
    } finally { pixmap.destroy(); renderedPage.destroy(); rendered.destroy(); }
    await page.reload(); await open(page, saved.file);
    await page.locator('.textLayer span').filter({ hasText: 'MOBILE EDITED' }).waitFor();
    return { mobileModalEditor: true, touchTextReplacement: true, touchImageDuplication: true, cancelledImageDeletionRetainsCopies: true,
      touchDeleteUndoRedo: true, portraitAndLandscapeActionsReachable: true, selectedFrameVisibleAfterRotation: { portrait: portraitPreview, landscape: landscapePreview }, exportedTextNeighborsAndNotePreserved: true,
      exportedOriginalAndCopyImagePixels: true, exportedImages: 2, exportedPdfReopened: true, originalSourceSha256: originals.get(editorSource),
      physicalKeyboardAndUIKitNotAutomated: true };
  }, { file: editorSource });

  for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }, { width: 768, height: 1024 }]) {
    await check(`reading-layout-${viewport.width}x${viewport.height}`, async page => {
      assert.equal(await page.locator(viewport.width >= 700 && viewport.height >= 600 ? '.app-shell.tablet-layout' : '.app-shell.phone-layout').count(), 1);
      assert.equal(await page.locator('.window-actions').count(), 0);
      assert.equal(await page.locator('.document-tab-strip').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Documentos abiertos y recientes', exact: true }).count(), 1);
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
    assert.equal(await readingPage(page),2);
    await open(page, another); assert.equal(await highlights(page).count(), 0);
    await tabs(page); assert.equal(await page.getByRole('button', { name: /^Cambiar a / }).count(), 2);
    assertScreen(await geometry(page)); await page.screenshot({ path: path.join(output, 'iphone-documents.png'), animations: 'disabled' }); await closeDialog(page);
    await open(page, another); await tabs(page); assert.equal(await page.getByRole('button', { name: /^Cambiar a / }).count(), 2); await closeDialog(page);
    await switchTo(page, source); assert.equal(await readingPage(page),2);
    await waitForReadingPage(page, 2);
    await page.getByRole('button', {name:'Ir a página',exact:true}).tap();
    const pageInput = page.getByLabel(/^Página \(1–/);
    await pageInput.fill('1'); await pageInput.press('Enter');
    // A user can open actions while the smooth scroll is still running. Do
    // not wait between Enter and this tap: leaving the field must not submit
    // the observer's intermediate page number and cancel the requested jump.
    await actions(page);
    await waitForReadingPage(page, 1); assert.equal(await readingPage(page),1);
    await closeDialog(page); await highlights(page).waitFor();
    const firstPageNavigation = await page.evaluate(() => window.__iphoneNavigation);
    await page.screenshot({ path: path.join(output, 'iphone-restored-page-one.png'), animations: 'disabled' });
    const first = await save(page, 'iphone-first-export.pdf'); assert.equal(first.inspection.annotations.length, 1); assert.equal(first.inspection.annotations[0].text, copiedPhrase);
    await switchTo(page, another); await goToPage(page, 2);
    const second = await save(page, 'iphone-second-export.pdf'); assert.equal(second.inspection.annotations.length, 0);
    assert.equal(await readingPage(page),2);
    assert(operateDocument(second.bytes, { operation: 'text' })[0].includes('ORIGINAL SECOND'));
    await tabs(page); assert.equal(await page.getByRole('button', { name: /^Cambiar a / }).count(), 2);
    await page.getByRole('button', { name: `Cerrar ${path.basename(source)}`, exact: true }).tap();
    await page.locator('dialog[open]').waitFor({ state: 'detached' }); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await tabs(page); assert.equal(await page.getByRole('button', { name: /^Cambiar a / }).count(), 1); await closeDialog(page); await heading(page, another).waitFor({ state: 'attached' });
    return { openedDocuments: 2, duplicateFocusesExistingDocument: true, pageRestored: 2, rapidActionTapPreservesRequestedPage: true, firstPageNavigation, secondExportFromPage: 2, exportedAnnotationIsolation: true, inactiveCloseKeepsCurrentDocument: true };
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
    assert.equal(await page.getByRole('dialog', {name:'Anotaciones',exact:true}).count(),0,'Saving a note returns to reading without forcing the annotations panel.');
    const saved = await save(page, 'iphone-selection-export.pdf'); assert.deepEqual(operateDocument(saved.bytes, { operation: 'text' }), sourceText);
    const highlight = saved.inspection.annotations.find(item => item.kind === 'highlight'), comment = saved.inspection.annotations.find(item => item.kind === 'note');
    assert.equal(highlight.text, copiedPhrase); assert(highlight.quads?.length); assert.equal(comment.text, 'An iPhone text comment.');
    await removeHighlight(page); await highlights(page).waitFor({ state: 'detached' });
    const removed = await save(page, 'iphone-selection-removed.pdf'); assert.equal(removed.inspection.annotations.length, 1); assert.equal(removed.inspection.annotations[0].kind, 'note');
    return { genuineBrowserTextRange: true, selectionRange: range, contextualCopySucceeded: true, systemClipboard: clipboard, standardPdfHighlightQuads: highlight.quads.length, standardCommentSaved: true, directTapRemovalPreservesNote: true, exportOriginalTextPreserved: true };
  });

  await check('automatic-highlight-custom-color-and-reopen-persistence', async page => {
    await annotateMode(page);
    await page.getByRole('button', { name: 'Resaltador', exact: true }).tap();
    assertScreen(await geometry(page));
    await page.screenshot({ path: path.join(output, 'iphone-annotation-tools.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Color del resaltador', exact: true }).tap();
    const palette = page.getByRole('dialog', { name: 'Colores del resaltador', exact: true }); await palette.waitFor();
    assert.equal(await palette.locator('.highlight-color-presets button').count(), 12); assertScreen(await geometry(page));
    await page.getByLabel('Color personalizado del resaltador', { exact: true }).fill('#1177dd');
    await page.getByRole('button', { name: 'Color del resaltador', exact: true }).tap();
    assert.equal(await page.getByRole('button', { name: 'Resaltador', exact: true }).getAttribute('aria-pressed'), 'true');
    await selection(page, automaticPhrase, automaticPhrase); await highlights(page).waitFor();
    assert.equal(await selectionMenu(page).count(), 0);
    await page.getByRole('button',{name:'Deshacer',exact:true}).tap(); await highlights(page).waitFor({state:'detached'});
    await page.getByRole('button',{name:'Rehacer',exact:true}).tap(); await highlights(page).waitFor();
    const saved = await save(page, 'iphone-automatic-export.pdf'); const highlight = saved.inspection.annotations.find(item => item.kind === 'highlight');
    assert.equal(highlight.text, automaticPhrase); assert.equal(highlight.color.toLowerCase(), '#1177dd');
    await annotateMode(page); await page.getByRole('button', {name:'Resaltador',exact:true}).tap();
    await removeHighlight(page); await highlights(page).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'Resaltador', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.reload(); await open(page, saved.file); assert.equal(await highlights(page).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('folio.highlightColor')), '#1177dd');
    const final = await save(page, 'iphone-automatic-deleted.pdf'); assert.equal(final.inspection.annotations.length, 0);
    return { twelvePresetColors: true, customColor: '#1177dd', stableTextSelectionAutomaticallyHighlights: true, annotationToolbarUndoAndMenuRedo:true,modeSurvivesRemoval: true, deletionSurvivesReload: true, nativeSelectionHandlesNotAutomated: true };
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
    assert.equal(await page.getByRole('button', {name:'Anotar',exact:true}).isDisabled(),false);
    await page.getByRole('button', {name:'Anotar',exact:true}).tap();
    await page.getByRole('dialog', {name:'Herramientas disponibles',exact:true}).waitFor();
    assert(await page.getByRole('dialog', {name:'Herramientas disponibles',exact:true}).textContent().then(text=>text.includes('permisos')));
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
    assert.equal(await selectionMenu(page).count(), 0); assert(await page.getByRole('button', { name: 'Resaltador', exact: true }).isDisabled());
    return { copyPermissionEnforced: true, forbiddenTextActionsAbsent: true };
  }, { file: noCopy });

  await check('reading-settings-persist-follow-system-and-single-page', async page => {
    await settings(page); assertScreen(await geometry(page)); await page.screenshot({ path: path.join(output, 'iphone-settings.png'), animations: 'disabled' });
    await page.getByLabel('Zoom inicial', { exact: true }).selectOption('width');
    await page.getByLabel('Modo de desplazamiento', { exact: true }).selectOption('single');
    // Phones always open with the panel closed, so they offer no panel options.
    assert.equal(await page.getByLabel('Al abrir un documento', { exact: true }).count(), 0);
    await page.getByLabel('Reabrir en la última página', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Sistema', exact: true }).tap(); await page.getByRole('button', { name: 'Listo', exact: true }).tap();
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await continueReading(page);
    assert.equal(await page.locator('.pdf-page-wrap').count(),3,'Global defaults do not change the current iPhone document view.');
    await viewSettings(page); await page.getByLabel('Modo de desplazamiento',{exact:true}).selectOption('single');
    await page.getByRole('button',{name:'Listo',exact:true}).tap();
    assert.equal(await page.locator('.pdf-page-wrap').count(), 1); await goToPage(page, 2);
    await page.locator('.pdf-page-wrap[data-page-number="2"]').waitFor(); assert.equal(await page.locator('.pdf-page-wrap').count(), 1);
    await page.reload(); await open(page); assert.equal(await readingPage(page),1);
    assert.equal(await page.locator('.pdf-page-wrap').count(),1,'Reopening uses the single-page default.');
    await panel(page,'Marcadores'); await page.locator('.bookmark-tree').waitFor({ state: 'attached' });
    assertScreen(await geometry(page)); await closePanel(page); await settings(page);
    assert.equal(await page.getByLabel('Zoom inicial', { exact: true }).inputValue(), 'width'); assert.equal(await page.getByLabel('Modo de desplazamiento', { exact: true }).inputValue(), 'single');
    assert.equal(await page.getByLabel('Reabrir en la última página', { exact: true }).isChecked(), false);
    await page.getByLabel('Modo de desplazamiento', { exact: true }).selectOption('continuous'); await page.getByRole('button', { name: 'Listo', exact: true }).tap();
    await continueReading(page); assert.equal(await page.locator('.pdf-page-wrap').count(),1,'Updating the next-document default preserves the current single-page view.');
    await viewSettings(page); await page.getByLabel('Modo de desplazamiento',{exact:true}).selectOption('continuous'); await page.getByRole('button',{name:'Listo',exact:true}).tap();
    assert.equal(await page.locator('.pdf-page-wrap').count(), 3);
    return { persistentPreferences: true, responsiveSystemTheme: true, singlePageNavigation: true, explorerAccessible: true, globalDefaultsSeparateFromCurrentView:true,restorePageCanBeDisabled: true };
  });

  await check('bookmark-name-tree-pointer-handle-move-and-persistence', async page => {
    const row = title => page.locator('.bookmark-entry').filter({ has: page.locator('.bookmark-label', { hasText: new RegExp(`^${title}$`) }) }).first();
    const rename = async title => { const input = page.getByLabel('Nombre del marcador', { exact: true }); await input.fill(title); await input.press('Enter'); await row(title).waitFor(); };
    const option = async (title, action) => { await page.getByRole('button', { name: `Opciones de ${title}`, exact: true }).tap(); await page.getByRole('menuitem', { name: action, exact: true }).tap(); };
    const stored = async () => storedSession(page, originals.get(source));
    const waitTree = async predicate => {
      for (let i = 0; i < 80; i++) { const state = await stored(); if (state && predicate(state.bookmarks)) return state.bookmarks; await page.waitForTimeout(50); }
      throw new Error('The bookmark tree was not persisted in the expected state.');
    };
    await page.getByRole('button', { name: 'Guardar marcador de esta página', exact: true }).tap();
    assert.equal(await page.getByRole('dialog',{name:'Explorar documento',exact:true}).count(),0,'Quick bookmark keeps reading visible.');
    assert.equal(await page.getByLabel('Nombre del marcador',{exact:true}).count(),0,'Quick bookmark does not open the keyboard.');
    await panel(page,'Marcadores'); await option('Página 1','Renombrar');
    const name = page.getByLabel('Nombre del marcador', { exact: true }); await name.waitFor();
    assert.equal(await name.evaluate(input => input === document.activeElement), true, 'Explicit rename focuses the bookmark input.');
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
    return { quickBookmarkPreservesReading:true, explicitBookmarkRename:true, nestedGroupsCreatedThroughUi: true, pointerDragDedicatedHandle: true, touchMoveDialogCompleted: true, branchChildrenAndColorPreserved: true, compactTreeFits320: true, childLabelsVisiblyIndented: true, entireTreePersistsAfterReload: true, physicalTouchDragNotAutomated: true };
  });

  await check('reader-short-touch-chrome-and-gesture-exclusions', async page => {
    const shell = page.locator('.app-shell'), header = page.locator('.app-header');
    const visibleChrome = async message => {
      // The toggle is intentionally delayed to distinguish a double tap. Wait
      // past that threshold before accepting any exclusion as a success.
      await page.waitForTimeout(500);
      assert.equal(await shell.evaluate(element => element.classList.contains('reader-chrome-hidden')), false, message);
      assert(await header.isVisible(), message);
      assert(await page.locator('.mobile-reading-status').isVisible(), message);
    };
    const blankPoint = async () => {
      const canvas = await page.locator('.pdf-page-wrap[data-page-number="1"] .page-content > canvas').boundingBox();
      const view = await reader(page).boundingBox(); assert(canvas && view);
      const point = { x: Math.min(canvas.x + canvas.width * .9, view.x + view.width - 30), y: Math.min(canvas.y + canvas.height * .8, view.y + view.height - 100) };
      assert(point.x > Math.max(view.x, canvas.x) && point.x < Math.min(view.x + view.width, canvas.x + canvas.width));
      assert(point.y > Math.max(view.y, canvas.y) && point.y < Math.min(view.y + view.height, canvas.y + canvas.height));
      return point;
    };
    const dispatchPointer = async (type, point, extra = {}) => page.evaluate(({ type, point, extra }) => {
      const target = document.elementFromPoint(point.x, point.y);
      if (!target?.closest('.page-content')) throw new Error('Touch target must be the rendered PDF, not its controls.');
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch',
        pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: point.x, clientY: point.y, ...extra }));
    }, { type, point, extra });
    await page.evaluate(() => {
      window.getSelection()?.removeAllRanges();
      window.__iphoneChromeTouchUps = [];
      document.addEventListener('pointerup', event => {
        if (event.pointerType === 'touch' && event.target?.closest?.('.page-content')) {
          window.__iphoneChromeTouchUps.push({ at: performance.now(), x: event.clientX, y: event.clientY });
        }
      }, { capture: true });
    });
    const initial = await reader(page).boundingBox(), initialScale=await page.locator('.pdf-page-wrap[data-page-number="1"] canvas').getAttribute('data-render-scale'), blank = await blankPoint();
    await page.touchscreen.tap(blank.x, blank.y);
    await page.waitForFunction(() => document.querySelector('.app-shell')?.classList.contains('reader-chrome-hidden'));
    await header.waitFor({state:'hidden'}); await page.locator('.mobile-reading-status').waitFor({state:'hidden'});
    assert.equal(await header.isVisible(), false); assert.equal(await page.locator('.mobile-reading-status').isVisible(), false);
    const expanded = await reader(page).boundingBox(); assert.equal(expanded.height,initial.height,'Hiding overlay controls keeps the PDF viewport stable.');
    assert.equal(await page.locator('.pdf-page-wrap[data-page-number="1"] canvas').getAttribute('data-render-scale'),initialScale,'Hiding controls must not rescale the PDF.');
    await page.screenshot({ path: path.join(output, 'iphone-reader-chrome-hidden.png'), animations: 'disabled' });
    const restore = await blankPoint(); await page.touchscreen.tap(restore.x, restore.y);
    await visibleChrome('A second short touch must restore the complete reader controls.');
    const independentTouchGapMs = await page.evaluate(() => {
      const [first, second] = window.__iphoneChromeTouchUps;
      return first && second ? second.at - first.at : null;
    });
    assert(Number.isFinite(independentTouchGapMs) && independentTouchGapMs > 0, 'The report must record both real hide and restore touches.');

    // Exercise the end of a double tap's recognition interval inside WebKit,
    // without transport/screenshot latency determining when its second touch
    // arrives. These PointerEvents are explicitly synthetic in the report; the
    // consecutive real touchscreen double tap is tested separately below.
    const boundaryPoint = await blankPoint();
    const boundaryDoubleTap = await page.evaluate(async point => {
      const target = document.elementFromPoint(point.x, point.y);
      if (!target?.closest('.page-content')) throw new Error('Boundary taps must hit the PDF.');
      const shell = document.querySelector('.app-shell');
      let observing = true;
      const frames = [];
      const observe = () => {
        frames.push({ at: performance.now(), hidden: shell.classList.contains('reader-chrome-hidden') });
        if (observing) requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
      const tap = () => {
        for (const type of ['pointerdown', 'pointerup']) {
          target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
            pointerType: 'touch', pointerId: 91, isPrimary: true, button: 0,
            buttons: type === 'pointerdown' ? 1 : 0, clientX: point.x, clientY: point.y }));
        }
      };
      tap(); const firstUp = performance.now();
      await new Promise(resolve => setTimeout(resolve, 320));
      const gapMs = performance.now() - firstUp;
      const hiddenBeforeSecond = shell.classList.contains('reader-chrome-hidden');
      tap();
      await new Promise(resolve => setTimeout(resolve, 500)); observing = false;
      return { gapMs, hiddenBeforeSecond, frames: frames.length, hiddenFrames: frames.filter(frame => frame.hidden).length };
    }, boundaryPoint);
    assert(boundaryDoubleTap.gapMs >= 300 && boundaryDoubleTap.gapMs < 350, 'The boundary regression must actually dispatch its second touch between 300 and 350 ms.');
    assert.equal(boundaryDoubleTap.hiddenBeforeSecond, false, 'Controls must not hide before a double tap has been ruled out.');
    assert.equal(boundaryDoubleTap.hiddenFrames, 0, 'A late double tap must not briefly hide controls.');
    await visibleChrome('A second tap near the double tap boundary must preserve reader chrome.');

    const double = await blankPoint(); await page.touchscreen.tap(double.x, double.y); await page.touchscreen.tap(double.x, double.y);
    await visibleChrome('A double tap must not toggle reader chrome.');

    const scrolling = await blankPoint(); await dispatchPointer('pointerdown', scrolling);
    await reader(page).evaluate(element => { element.scrollTop += 60; });
    await dispatchPointer('pointermove', { x: scrolling.x, y: scrolling.y - 30 });
    await dispatchPointer('pointerup', { x: scrolling.x, y: scrolling.y - 30 });
    assert(await reader(page).evaluate(element => element.scrollTop) >= 50, 'The scrolling exclusion must actually move the PDF.');
    await visibleChrome('A scrolling touch must not hide controls.'); await goToPage(page, 1);

    const holding = await blankPoint(); await dispatchPointer('pointerdown', holding);
    const range = await selection(page); assert.equal(range.text, copiedPhrase);
    await page.waitForTimeout(550); await dispatchPointer('pointerup', holding);
    await selectionMenu(page).waitFor();
    await visibleChrome('Long press and a real browser text selection must preserve controls.');
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), copiedPhrase);
    await page.evaluate(() => window.getSelection()?.removeAllRanges()); await selectionMenu(page).waitFor({ state: 'detached' });

    const pinch = await blankPoint(); await dispatchPointer('pointerdown', pinch);
    const expected = await page.evaluate(async point => {
      const target = document.elementFromPoint(point.x, point.y), canvas = target.closest('.page-content').querySelector('canvas');
      const initial = Number(canvas.dataset.renderScale);
      const fingers = distance => [{ identifier: 1, target, clientX: point.x - distance / 2, clientY: point.y }, { identifier: 2, target, clientX: point.x + distance / 2, clientY: point.y }];
      const touch = (type, touches) => { const event = new Event(type, { bubbles: true, cancelable: true }); for (const key of ['touches', 'targetTouches', 'changedTouches']) Object.defineProperty(event, key, { value: touches }); target.dispatchEvent(event); };
      touch('touchstart', fingers(80)); touch('touchmove', fingers(88));
      await new Promise(resolve => requestAnimationFrame(resolve)); touch('touchend', []);
      return Math.round(initial * 1.1 * 1000) / 1000;
    }, pinch);
    await dispatchPointer('pointerup', pinch);
    await page.waitForFunction(expected => Number(document.querySelector('.pdf-page-wrap[data-page-number="1"] canvas')?.dataset.renderScale) === expected, expected);
    await visibleChrome('A two finger zoom must cancel the pending reader tap.');

    await annotateMode(page); await page.getByRole('button', { name: 'Resaltador', exact: true }).tap();
    await page.locator('.page-content.tool-highlight').first().waitFor();
    const highlighting = await blankPoint(); await page.touchscreen.tap(highlighting.x, highlighting.y);
    await visibleChrome('The active highlight tool must preserve its visible controls.');
    await page.getByRole('button', { name: 'Nota', exact: true }).tap();
    await page.locator('.page-content.tool-note').first().waitFor();
    await page.evaluate(() => {
      window.__iphoneChromeNoteEvents = [];
      const capture = event => window.__iphoneChromeNoteEvents.push({ type: event.type, pointerType: event.pointerType,
        button: event.button, pointerId: event.pointerId, at: Date.now(), x: event.clientX, y: event.clientY, target: event.target?.className,
        text: event.target?.textContent?.slice(0, 80), note: event.target?.closest?.('.page-content')?.className });
      for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click']) document.addEventListener(name, capture, { capture: true });
      let hasModal = false;
      const observer = new MutationObserver(() => {
        const current = !!document.querySelector('.note-modal');
        if (current !== hasModal) window.__iphoneChromeNoteEvents.push({ type: current ? 'note-modal-added' : 'note-modal-removed', at: Date.now() });
        hasModal = current;
      });
      observer.observe(document.body, { subtree: true, childList: true });
    });
    const note = await blankPoint(); await page.touchscreen.tap(note.x, note.y);
    await page.getByRole('dialog', { name: 'Añadir nota', exact: true }).waitFor();
    assert.equal(await shell.evaluate(element => element.classList.contains('reader-chrome-hidden')), false, 'Note creation must keep reader chrome visible.');
    const dialog = page.getByRole('dialog', { name: 'Añadir nota', exact: true }), dialogBox = await dialog.boundingBox(); assert(dialogBox);
    const padding = { x: dialogBox.x + 3, y: dialogBox.y + dialogBox.height / 2 };
    assert(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.matches('.note-modal'), padding), 'The padding regression must tap the dialog itself.');
    await page.touchscreen.tap(padding.x, padding.y); await page.waitForTimeout(350);
    assert(await dialog.isVisible(), 'Tapping inside dialog padding must not be mistaken for backdrop dismissal.');
    const outside = { x: Math.max(2, dialogBox.x - 8), y: dialogBox.y + dialogBox.height / 2 };
    assert(outside.x < dialogBox.x, 'The backdrop regression must actually tap outside the dialog.');
    await page.touchscreen.tap(outside.x, outside.y); await dialog.waitFor({ state: 'detached' });
    await visibleChrome('Closing an unsaved note must preserve reader chrome.');
    await page.screenshot({ path: path.join(output, 'iphone-reader-chrome-restored.png'), animations: 'disabled' });
    return { actualTouchscreenTapHidesAndRestores: true, independentTouchGapMs, boundaryDoubleTap,
      doubleTapBoundaryPointerEventsSynthetic: true, reclaimedReaderHeight: expanded.height - initial.height,
      doubleTapDoesNotHide: true, scrollingDoesNotHide: true, browserTextSelectionDoesNotHide: true,
      twoFingerZoomDoesNotHide: true, activeHighlightAndNoteToolsDoNotHide: true,
      modalPaddingTapDoesNotClose: true, actualBackdropTapCloses: true,
      gestureContractEventsSynthetic: true, physicalLongPressAndPinchNotAutomated: true };
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
    await page.getByRole('button', { name: 'Mover posición 3 antes', exact: true }).tap();
    await page.getByRole('button', { name: 'Mover posición 2 antes', exact: true }).tap();
    await page.getByRole('checkbox', { name: 'Seleccionar posición 3', exact: true }).check();
    await page.getByRole('button', { name: 'Eliminar páginas seleccionadas', exact: true }).tap();
    await page.screenshot({ path: path.join(output, 'iphone-organize-pages.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).tap(); await page.locator('.workbench').waitFor({ state: 'detached' });
    const organized = await save(page, 'iphone-organized-export.pdf'), text = operateDocument(organized.bytes, { operation: 'text' });
    assert.equal(text.length, 2); assert(text[0].includes('FIRST PAGE 3')); assert(text[1].includes('FIRST PAGE 1'));
    await library(page); await page.getByRole('button', { name: 'Crear PDF', exact: true }).tap();
    await page.getByRole('dialog', { name: 'Crear PDF', exact: true }).waitFor(); await page.getByLabel('Nombre', { exact: true }).fill('iPhone created.pdf');
    await page.getByLabel('Imágenes (opcional)', { exact: true }).setInputFiles(imageSource); assertScreen(await geometry(page));
    await page.getByRole('dialog', { name: 'Crear PDF', exact: true }).getByRole('button', { name: 'Crear PDF', exact: true }).tap(); await page.getByRole('dialog', { name: 'Crear PDF', exact: true }).waitFor({ state: 'detached' });
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
    await page.getByRole('button', { name: 'Guardar nota', exact: true }).tap();
    assert.equal(await page.getByRole('dialog',{name:'Anotaciones',exact:true}).count(),0); await page.getByRole('button',{name:'Listo',exact:true}).tap();
    assert.equal(await page.locator('.note-marker').count(), 1); assertScreen(await geometry(page));
    const saved = await save(page, 'iphone-short-touch-note.pdf'); assert.equal(saved.inspection.annotations.length, 1);
    assert.equal(saved.inspection.annotations[0].kind, 'note'); assert.equal(saved.inspection.annotations[0].text, 'Created by one short touch tap.');
    return { pendingNoteCanceledByTwoFingerPinchContract: true, twoFingerEventsSynthetic: true, actualTouchscreenShortTapCreatesOneNote: true, standardPdfNoteSaved: true };
  });

  await check('webkit-recent-file-and-real-pdf-draft-survive-reload', async page => {
    const identity = originals.get(source);
    const storageSnapshot = () => page.evaluate(async identity => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('folio-library'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const get = store => new Promise((resolve, reject) => { const request = db.transaction(store, 'readonly').objectStore(store).get(identity); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        // Library rows hold metadata; their PDF bytes live in 'files' and sessions in 'sessions'.
        const [draft, recent, file, session] = await Promise.all([get('drafts'), get('documents'), get('files'), get('sessions')]);
        const asBytes = async value => value ? [...new Uint8Array(value instanceof Blob ? await value.arrayBuffer() : value)] : [];
        return { draft: await asBytes(draft), recent: await asBytes(file), recentName: recent?.name, recentId: recent?.id, session: session || null };
      } finally { db.close(); }
    }, identity);
    await page.waitForFunction(async identity => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('folio-library'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise(resolve => { const request = db.transaction('files', 'readonly').objectStore('files').get(identity); request.onsuccess = () => resolve(!!request.result); }); }
      finally { db.close(); }
    }, identity);
    await actions(page); await page.getByRole('button', { name: 'Herramientas', exact: true }).tap(); await page.getByRole('button', { name: 'Organizar páginas', exact: true }).tap();
    await page.getByRole('button', { name: 'Mover posición 2 antes', exact: true }).tap();
    await page.getByRole('checkbox', { name: 'Seleccionar posición 3', exact: true }).check();
    await page.getByRole('button', { name: 'Eliminar páginas seleccionadas', exact: true }).tap();
    await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).tap(); await page.locator('.workbench').waitFor({ state: 'detached' });
    await page.waitForFunction(async identity => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('folio-library'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
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
    await library(page);
    const row = page.locator('.document-library-row').filter({ has: page.locator('strong', { hasText: /^iphone-reading\.pdf$/ }) }); await row.waitFor();
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
  await browser?.close();
  if (server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; }
  if (snapshot) { assert(snapshot.startsWith(snapshotRoot + path.sep)); fs.rmSync(snapshot, { recursive: true, force: true }); }
  const report = { capturedAt: new Date().toISOString(), passed: results.length > 0 && results.every(result => result.status === 'passed') && errors.length === 0, results, errors,
    builtIndexSha256: builtIndexHash, frontendEntry, browser: browserName, hostPlatform: process.platform,
    scope: 'Real browser PDF rendering, text Range, UI touch taps, standard PDF export and persistence.',
    limitations: ['The WebKit browser harness does not automate UIKit Files or Share sheets.', 'Native iOS text-selection handles and physical pinch gestures need separate simulator/device validation.', 'Continuous sheet touch drags are not driven by the WebKit tap API.', 'DOM autofocus and viewport resizing do not automate the iOS keyboard or keyboard safe-area changes.', 'Viewport sizes do not emulate actual notch safe-area insets.'],
    ...(results.some(result => result.status === 'failed') ? { serverLog: log } : {}) };
  fs.writeFileSync(path.join(output, 'iphone-results.json'), JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
