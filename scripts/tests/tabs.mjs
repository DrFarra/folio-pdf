import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';
import { enterAnnotationMode, desktopDocumentAction } from './ui-helpers.mjs';
import { storedSession, waitForSession } from './session-helpers.mjs';

const root = process.cwd(), output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const sources = [];
for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = document.addPage([600, 760]);
    page.drawText(`TAB ${letter} PAGE ${i}`, { x: 60, y: 670, size: 20, font });
    page.drawText(`${letter} CONTENT ONLY`, { x: 60, y: 620, size: 16, font });
  }
  const file = path.join(output, `tabs-${letter}.pdf`), bytes = await document.save();
  fs.writeFileSync(file, bytes);
  sources.push({ letter, file, name: path.basename(file), hash: createHash('sha256').update(bytes).digest('hex') });
}
const [a, b, c] = sources;
const chrome = findChrome();
assert(chrome, 'An installed Chrome or Edge is required.');
const origin = 'http://127.0.0.1:4178';
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '4178', '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let browser, log = ''; preview.stdout.on('data', data => { log += data; }); preview.stderr.on('data', data => { log += data; });
const results = [], errors = [];
const input = page => page.getByRole('textbox', { name: 'Número de página', exact: true });
const zoom = page => page.getByRole('combobox', { name: 'Nivel de zoom', exact: true });
const tab = (page, source) => page.getByRole('tab', { name: source.name, exact: true });

async function active(page, source) {
  await page.waitForFunction(name => Array.from(document.querySelectorAll('[role=tab]')).some(node => node.getAttribute('aria-label') === name && node.getAttribute('aria-selected') === 'true'), source.name);
  await page.getByRole('heading', { name: source.name, exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
}
async function open(page, source) { await page.locator('.app-header input[type=file]').setInputFiles(source.file); await active(page, source); }
async function switchTo(page, source) { await tab(page, source).click(); await active(page, source); }
async function check(id, action) {
  if (process.env.FOLIO_TABS_TEST && !new RegExp(process.env.FOLIO_TABS_TEST).test(id)) return;
  const context = await browser.newContext({ viewport: { width: 1360, height: 1050 }, acceptDownloads: true }), page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push({ id, error: error.message }));
  try { await page.goto(origin); await open(page, a); const evidence = await action(page); results.push({ id, status: 'passed', ...evidence }); }
  catch (error) { process.exitCode = 1; results.push({ id, status: 'failed', error: error.stack }); await page.screenshot({ path: path.join(output, `failure-${id}.png`), animations: 'disabled' }); }
  finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
}
async function go(page, number) {
  await input(page).fill(String(number)); await input(page).press('Enter');
  await page.waitForFunction(number => {
    const reader = document.querySelector('.reading-area'), sheet = document.querySelector(`.pdf-page-wrap[data-page-number="${number}"]`);
    if (!reader || !sheet) return false;
    const absoluteTop = sheet.getBoundingClientRect().top - reader.getBoundingClientRect().top + reader.scrollTop;
    const target = Math.max(0, Math.min(reader.scrollHeight - reader.clientHeight, absoluteTop - 16));
    return Math.abs(reader.scrollTop - target) < 3;
  }, number);
  await page.locator(`.pdf-page-wrap[data-page-number="${number}"] .page-loading`).waitFor({ state: 'detached' });
}
async function annotate(page, source) {
  await zoom(page).selectOption('100'); await go(page, 1);
  await enterAnnotationMode(page);
  await page.getByRole('button', { name: 'Resaltador (H)', exact: true }).click();
  const span = page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: `TAB ${source.letter} PAGE 1` }).first(); await span.waitFor();
  const rect = await span.boundingBox();
  await page.mouse.move(rect.x + 1, rect.y + rect.height / 2); await page.mouse.down(); await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 10 }); await page.mouse.up();
  await page.locator('.highlight-annotation').first().waitFor();
}
async function download(page, name) {
  const promise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar', exact: true }).click();
  const download = await promise, target = path.join(output, name); await download.saveAs(target);
  await page.waitForFunction(() => document.querySelector('.download-button:not([disabled])') && !document.querySelector('.loading-overlay') && !document.querySelector('.pdf-page-wrap[data-page-number="1"] .page-loading'));
  return fs.readFileSync(target);
}
const row = (page, title) => page.locator('.bookmark-entry').filter({ has: page.locator('.bookmark-label', { hasText: new RegExp(`^${title}$`) }) }).first();
async function options(page, title, action) { await page.getByRole('button', { name: `Opciones de ${title}`, exact: true }).click(); await page.getByRole('menuitem', { name: action, exact: true }).click(); }
async function rename(page, title) { const editor = page.getByRole('textbox', { name: 'Nombre del marcador', exact: true }); await editor.fill(title); await editor.press('Enter'); await row(page, title).waitFor(); }
async function session(page, source = a) { return storedSession(page, source.hash); }
async function waitSession(page, source, title) { await waitForSession(page, (value, id) => id === source.hash && JSON.stringify(value).includes(title)); }
const children = (nodes, parentId) => nodes.filter(node => node.parentId === parentId).sort((left, right) => left.order - right.order);
const tabOrder = page => page.locator('.document-tab [role=tab]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
async function beginTabDrag(page, source) {
  const bounds = await tab(page, source).boundingBox(); assert(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 12, bounds.y + bounds.height / 2, { steps: 3 });
  await page.locator('.document-tab-drag-preview').waitFor();
}
async function moveTabDrag(page, target, side = 'before') {
  const bounds = await tab(page, target).locator('..').boundingBox(); assert(bounds);
  await page.mouse.move(bounds.x + bounds.width * (side === 'before' ? .2 : .8), bounds.y + bounds.height / 2, { steps: 12 });
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {} if (preview.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert(ready, log || 'Preview did not start.'); browser = await chromium.launch({ executablePath: chrome, headless: true });

  await check('open-multiple-files-and-deduplicate-tabs', async page => {
    await page.locator('.app-header input[type=file]').setInputFiles([a.file, b.file]); await active(page, b);
    assert.equal(await page.getByRole('tab').count(), 2);
    await open(page, a); assert.equal(await page.getByRole('tab').count(), 2);
    assert.equal(await page.getByRole('button', { name: 'Abrir PDF', exact: true }).count(), 1);
    await page.screenshot({ path: path.join(output, 'tabs-open-documents.png'), animations: 'disabled' });
    return { simultaneousDocuments: 2, duplicateFileFocusesExistingTab: true, openControls: 1 };
  });

  await check('annotations-history-and-export-stay-with-their-document', async page => {
    await annotate(page, a); await open(page, b); await annotate(page, b); await switchTo(page, a);
    await page.getByRole('button', { name: 'Deshacer (Ctrl+Z)', exact: true }).click(); assert.equal(await page.locator('.highlight-annotation').count(), 0);
    await switchTo(page, b); assert(await page.locator('.highlight-annotation').count() > 0);
    await switchTo(page, a); await page.getByRole('button', { name: 'Rehacer (Ctrl+Y)', exact: true }).click();
    const bytesA = await download(page, 'tabs-export-A.pdf'), notesA = inspectDocument(bytesA).annotations;
    assert.equal(notesA.length, 1); assert(notesA[0].text.includes('TAB A PAGE 1')); assert(!notesA[0].text.includes('TAB B'));
    await switchTo(page, b); const bytesB = await download(page, 'tabs-export-B.pdf'), notesB = inspectDocument(bytesB).annotations;
    assert.equal(notesB.length, 1); assert(notesB[0].text.includes('TAB B PAGE 1')); assert(!notesB[0].text.includes('TAB A'));
    assert(operateDocument(bytesA, { operation: 'text' })[0].includes('A CONTENT ONLY'));
    assert(operateDocument(bytesB, { operation: 'text' })[0].includes('B CONTENT ONLY'));
    assert.equal(await page.getByRole('tab').count(), 2);
    return { annotationIsolation: true, undoRedoIsolation: true, exportedMatchingDocuments: true };
  });

  await check('extract-selection-opens-new-tab-and-retains-source-state', async page => {
    await page.setViewportSize({ width: 1360, height: 690 });
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click();
    await page.getByRole('button', { name: 'Guardar marcador de esta página', exact: true }).click(); await rename(page, 'First source page');
    await go(page, 3); await page.getByRole('button', { name: 'Guardar marcador de esta página', exact: true }).click(); await rename(page, 'Third source page');
    await annotate(page, a); await zoom(page).selectOption('125'); await go(page, 2);
    await waitForSession(page, (value, id) => id === a.hash && value.lastPage === 2);
    const before = await session(page), scrollTop = await page.locator('.reading-area').evaluate(node => node.scrollTop);
    const sourceKey = await tab(page, a).locator('..').getAttribute('data-tab-key');
    await page.getByRole('button', { name: 'Herramientas', exact: true }).click();
    await page.getByRole('button', { name: 'Organizar páginas', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Seleccionar posición 1', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Seleccionar posición 3', exact: true }).check();
    await page.getByRole('button', { name: 'Extraer selección', exact: true }).click();
    const extracted = { name: 'tabs-A — páginas extraídas.pdf' }; await active(page, extracted);
    assert.equal(await page.getByRole('tab').count(), 2); assert.equal(await tab(page, a).locator('..').getAttribute('data-tab-key'), sourceKey);
    assert.notEqual(await tab(page, extracted).locator('..').getAttribute('data-tab-key'), sourceKey);
    assert.equal(await input(page).inputValue(), '1'); assert.equal(await page.locator('.pdf-page-wrap').count(), 2);
    await page.locator('.highlight-annotation').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Deshacer (Ctrl+Z)', exact: true }).isDisabled(), true, 'The extracted PDF starts with its own history.');
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click(); await row(page, 'Third source page').waitFor();
    const [, extractedSession] = await waitForSession(page, (value, id) => id !== a.hash && value.bookmarks.some(node => node.title === 'Third source page' && node.page === 2));
    assert.deepEqual(extractedSession.bookmarks.map(node => [node.title, node.page]), [['First source page', 1], ['Third source page', 2]]);
    await switchTo(page, a); assert.equal(await zoom(page).inputValue(), '125'); assert.equal(await input(page).inputValue(), '2');
    await page.waitForFunction(expected => Math.abs(document.querySelector('.reading-area').scrollTop - expected) < 3, scrollTop);
    const after = await session(page); assert.deepEqual(after.annotations, before.annotations); assert.deepEqual(after.bookmarks, before.bookmarks);
    assert.equal(after.documentRevision, before.documentRevision); assert.equal(after.lastPage, 2);
    await page.getByRole('button', { name: 'Deshacer (Ctrl+Z)', exact: true }).click(); assert.equal(await page.locator('.highlight-annotation').count(), 0);
    await page.getByRole('button', { name: 'Rehacer (Ctrl+Y)', exact: true }).click(); await go(page, 1); await page.locator('.highlight-annotation').first().waitFor();
    await page.getByRole('button', { name: `Cerrar ${extracted.name}`, exact: true }).click(); await tab(page, extracted).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    await page.getByRole('button', { name: `Abrir ${extracted.name}`, exact: true }).click(); await active(page, extracted);
    await page.locator('.highlight-annotation').first().waitFor(); assert.equal(await page.locator('.pdf-page-wrap').count(), 2);
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click(); await row(page, 'Third source page').waitFor();
    const extractedBytes = await download(page, 'tabs-extracted-selection.pdf'), extractedText = operateDocument(extractedBytes, { operation: 'text' });
    assert.equal(extractedText.length, 2); assert(extractedText[0].includes('TAB A PAGE 1')); assert(extractedText[1].includes('TAB A PAGE 3'));
    assert.equal(inspectDocument(extractedBytes).annotations.length, 1);
    await switchTo(page, a); const sourceBytes = await download(page, 'tabs-extraction-source.pdf');
    assert.equal(operateDocument(sourceBytes, { operation: 'text' }).length, 3); assert.equal(inspectDocument(sourceBytes).annotations.length, 1);
    assert.equal(createHash('sha256').update(fs.readFileSync(a.file)).digest('hex'), a.hash, 'Extraction must leave the original file untouched.');
    return { extractedName: extracted.name, opensSeparateTab: true, retainedSourcePages: 3, extractedPages: [1, 3], annotationCopied: true, bookmarksRemapped: true, sourceSessionAndHistoryPreserved: true, sourceViewRestored: true, derivedDraftReopened: true, originalFileUnchanged: true };
  });

  await check('mouse-tab-drag-retains-active-document-history-and-view', async page => {
    await page.setViewportSize({ width: 1360, height: 690 }); await annotate(page, a); await zoom(page).selectOption('125'); await go(page, 2);
    const scrollTop = await page.locator('.reading-area').evaluate(node => node.scrollTop);
    await open(page, b); await open(page, c); await switchTo(page, a);
    const activeKey = await tab(page, a).locator('..').getAttribute('data-tab-key');
    await beginTabDrag(page, c); await moveTabDrag(page, a); await page.mouse.up();
    await page.locator('.document-tab-drag-preview').waitFor({ state: 'detached' });
    assert.deepEqual(await tabOrder(page), [c.name, a.name, b.name]); await active(page, a);
    assert.equal(await tab(page, a).locator('..').getAttribute('data-tab-key'), activeKey);
    assert.equal(await zoom(page).inputValue(), '125'); assert.equal(await input(page).inputValue(), '2');
    await page.waitForFunction(expected => Math.abs(document.querySelector('.reading-area').scrollTop - expected) < 3, scrollTop);
    await page.keyboard.press('Control+Tab'); await active(page, b); await page.keyboard.press('Control+Tab'); await active(page, c);
    await page.keyboard.press('Control+Tab'); await active(page, a);
    await beginTabDrag(page, a); await moveTabDrag(page, b, 'after'); await page.mouse.up();
    await page.locator('.document-tab-drag-preview').waitFor({ state: 'detached' });
    assert.deepEqual(await tabOrder(page), [c.name, b.name, a.name]); await active(page, a);
    await page.getByRole('button', { name: 'Deshacer (Ctrl+Z)', exact: true }).click(); assert.equal(await page.locator('.highlight-annotation').count(), 0);
    await page.getByRole('button', { name: 'Rehacer (Ctrl+Y)', exact: true }).click(); await go(page, 1); await page.locator('.highlight-annotation').first().waitFor();
    await beginTabDrag(page, c); await moveTabDrag(page, b, 'after'); await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await tabOrder(page), [c.name, b.name, a.name]); await active(page, a);
    await beginTabDrag(page, c); await page.mouse.move(500, 400, { steps: 10 }); await page.mouse.up();
    assert.deepEqual(await tabOrder(page), [c.name, b.name, a.name]); await active(page, a);
    await tab(page, b).click(); await active(page, b); await tab(page, a).dblclick(); await active(page, a);
    await page.getByRole('button', { name: `Cerrar ${c.name}`, exact: true }).click(); await tab(page, c).waitFor({ state: 'detached' }); await active(page, a);
    assert.deepEqual(await tabOrder(page), [b.name, a.name]); assert.equal(await page.locator('.document-tab-drag-preview').count(), 0);
    return { realMouseReorder: true, activeAndInactiveTabsDraggable: true, activeTabUnchanged: true, historyAndViewPreserved: true, ctrlTabFollowsNewOrder: true, escapeAndOutsideCancel: true, normalClickDoubleClickAndClose: true };
  });

  await check('mouse-tab-drag-autoscrolls-overflowing-strip', async page => {
    await page.setViewportSize({ width: 1000, height: 690 });
    await page.locator('.app-header input[type=file]').setInputFiles(sources.slice(1).map(source => source.file)); await active(page, sources.at(-1));
    const strip = page.locator('.document-tab-strip'); assert(await strip.evaluate(node => node.scrollWidth > node.clientWidth));
    await strip.evaluate(node => { node.scrollLeft = 0; }); await beginTabDrag(page, a);
    const bounds = await strip.boundingBox(); assert(bounds);
    await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2, { steps: 12 });
    await page.waitForFunction(() => { const strip = document.querySelector('.document-tab-strip'); return strip.scrollLeft > 40; });
    await page.waitForFunction(() => { const strip = document.querySelector('.document-tab-strip'); return strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 3; });
    await page.mouse.up(); await page.locator('.document-tab-drag-preview').waitFor({ state: 'detached' });
    assert.deepEqual(await tabOrder(page), [...sources.slice(1).map(source => source.name), a.name]); await active(page, sources.at(-1));
    await page.keyboard.press('Control+Tab'); await active(page, a);
    return { edgeAutoScroll: true, movedFirstTabToLastPosition: true, activeDocumentPreserved: true, keyboardOrderAfterScroll: true };
  });

  await check('wheel-scrolls-overflowing-strip-by-whole-tabs', async page => {
    await page.setViewportSize({ width: 1000, height: 690 });
    await page.locator('.app-header input[type=file]').setInputFiles(sources.slice(1).map(source => source.file)); await active(page, sources.at(-1));
    const strip = page.locator('.document-tab-strip'); await strip.evaluate(node => { node.scrollLeft = 0; });
    const stops = await strip.evaluate(node => [...node.children].map(tab => Math.min(tab.offsetLeft - node.offsetLeft, node.scrollWidth - node.clientWidth)));
    const reaches = stop => page.waitForFunction(stop => Math.abs(document.querySelector('.document-tab-strip').scrollLeft - stop) < 2, stop);
    const bounds = await strip.boundingBox(); assert(bounds); await page.mouse.move(bounds.x + 40, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 100); await reaches(stops[1]);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 10);
    await page.waitForTimeout(200); assert(Math.abs(await strip.evaluate(node => node.scrollLeft) - stops[1]) < 2, 'Small trackpad steps must add up before the strip moves a whole tab.');
    await page.mouse.wheel(0, 10); await reaches(stops[2]);
    await page.mouse.wheel(0, -100); await reaches(stops[1]);
    return { verticalWheelScrollsStrip: true, stopsAtTabStarts: true, smallStepsAccumulate: true };
  });

  await check('each-tab-restores-page-zoom-and-scroll', async page => {
    await page.setViewportSize({ width: 1360, height: 690 });
    await zoom(page).selectOption('125'); await go(page, 2);
    const scrollA = await page.locator('.reading-area').evaluate(node => node.scrollTop);
    await open(page, b); await zoom(page).selectOption('75'); await go(page, 3);
    const scrollB = await page.locator('.reading-area').evaluate(node => node.scrollTop);
    await switchTo(page, a);
    await page.waitForFunction(() => document.querySelector('[aria-label="Número de página"]').value === '2'); assert.equal(await zoom(page).inputValue(), '125');
    await page.waitForFunction(expected => Math.abs(document.querySelector('.reading-area').scrollTop - expected) < 3, scrollA);
    await switchTo(page, b);
    await page.waitForFunction(() => document.querySelector('[aria-label="Número de página"]').value === '3'); assert.equal(await zoom(page).inputValue(), '75');
    await page.waitForFunction(expected => Math.abs(document.querySelector('.reading-area').scrollTop - expected) < 3, scrollB);
    return { firstDocumentPage: 2, secondDocumentPage: 3, zoomPercents: [125, 75], preservedScroll: true };
  });

  await check('close-inactive-tab-reopen-session-and-keyboard-switch', async page => {
    await annotate(page, a); await open(page, b);
    await page.getByRole('button', { name: `Cerrar ${a.name}`, exact: true }).click(); await tab(page, a).waitFor({ state: 'detached' }); await active(page, b);
    await open(page, a); await page.locator('.highlight-annotation').first().waitFor();
    await enterAnnotationMode(page); await page.getByRole('button', { name: 'Seleccionar texto (V)', exact: true }).click();
    await page.keyboard.press('Control+Tab'); await active(page, b);
    await page.keyboard.press('Control+Shift+Tab'); await active(page, a);
    await page.keyboard.press('Control+w'); await tab(page, a).waitFor({ state: 'detached' }); await active(page, b);
    await page.getByRole('button', { name: `Cerrar ${b.name}`, exact: true }).click(); await tab(page, b).waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor();
    return { inactiveCloseKeepsCurrentDocument: true, reopenRestoresAnnotation: true, keyboardSwitchAndClose: true, lastCloseReturnsToWelcome: true };
  });

  await check('bookmark-groups-page-children-color-folding-and-persistence', async page => {
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click();
    await page.getByRole('button', { name: 'Crear grupo de marcadores', exact: true }).click(); await rename(page, 'Medicine');
    await options(page, 'Medicine', 'Añadir página actual dentro'); await rename(page, 'First page');
    await options(page, 'Medicine', 'Añadir grupo dentro'); await rename(page, 'Kidney');
    await go(page, 2); await options(page, 'Kidney', 'Añadir página actual dentro'); await rename(page, 'Second page');
    await options(page, 'Kidney', 'Color Azul');
    await page.getByRole('button', { name: 'Contraer Kidney', exact: true }).click(); assert.equal(await row(page, 'Second page').count(), 0);
    await page.getByRole('button', { name: 'Expandir Kidney', exact: true }).click(); await row(page, 'Second page').waitFor();
    // Folding is view state: Deshacer reverts the color, not the folding.
    await page.getByRole('button', { name: 'Deshacer (Ctrl+Z)', exact: true }).click();
    await waitForSession(page, (value, id) => id === a.hash && value.bookmarks.some(node => node.title === 'Kidney' && node.color !== '#4579ba' && !node.collapsed));
    assert.equal(await row(page, 'Second page').isVisible(), true);
    await page.getByRole('button', { name: 'Rehacer (Ctrl+Y)', exact: true }).click();
    // Dragging through the custom color picker is a single undo step.
    await page.getByRole('button', { name: 'Opciones de Kidney', exact: true }).click();
    const custom = page.getByLabel('Color personalizado del marcador', { exact: true }); await custom.fill('#112233'); await custom.fill('#445566');
    await page.keyboard.press('Escape'); await page.locator('.bookmark-menu').waitFor({ state: 'detached' });
    await waitForSession(page, (value, id) => id === a.hash && value.bookmarks.some(node => node.title === 'Kidney' && node.color === '#445566'));
    await page.getByRole('button', { name: 'Deshacer (Ctrl+Z)', exact: true }).click();
    await waitForSession(page, (value, id) => id === a.hash && value.bookmarks.some(node => node.title === 'Kidney' && node.color === '#4579ba' && !node.collapsed));
    await row(page, 'Second page').waitFor();
    await waitSession(page, a, 'Second page'); const saved = await session(page);
    const medicine = saved.bookmarks.find(node => node.title === 'Medicine'); assert(medicine && children(saved.bookmarks, medicine.id).length === 2);
    const kidney = children(saved.bookmarks, medicine.id).find(node => node.title === 'Kidney');
    const child = kidney && children(saved.bookmarks, kidney.id)[0]; assert(child && child.title === 'Second page' && child.page === 2); assert.equal(kidney.color, '#4579ba');
    await open(page, b); await page.getByRole('button', { name: 'Marcadores', exact: true }).click(); assert.equal(await page.locator('.bookmark-entry').count(), 0);
    await switchTo(page, a); await row(page, 'Second page').waitFor();
    await page.reload(); await open(page, a); await page.getByRole('button', { name: 'Marcadores', exact: true }).click(); await row(page, 'Second page').waitFor();
    const reloaded = await session(page); assert.deepEqual(reloaded.bookmarks, saved.bookmarks);
    await page.screenshot({ path: path.join(output, 'bookmarks-tree.png'), animations: 'disabled' });
    return { nestedGroups: true, pageDestinations: [1, 2], groupColor: kidney.color, foldUnfold: true, isolatedPerDocument: true, sessionReloadRestoresTree: true };
  });

  await check('bookmark-reorder-move-and-delete-preserve-children', async page => {
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click();
    await page.getByRole('button', { name: 'Crear grupo de marcadores', exact: true }).click(); await rename(page, 'First group');
    await options(page, 'First group', 'Añadir página actual dentro'); await rename(page, 'Keep this page');
    await page.getByRole('button', { name: 'Crear grupo de marcadores', exact: true }).click(); await rename(page, 'Second group');
    await options(page, 'Second group', 'Subir');
    await waitForSession(page, (value, id) => id === a.hash && children(value.bookmarks, null)[0]?.title === 'Second group');
    assert.equal(children((await session(page)).bookmarks, null)[0].title, 'Second group');
    await options(page, 'Keep this page', 'Mover…');
    const destination = page.getByRole('combobox', { name: 'Dentro de', exact: true });
    const value = await destination.locator('option').filter({ hasText: 'Second group' }).first().getAttribute('value'); assert(value);
    await destination.selectOption(value); await page.getByRole('button', { name: 'Mover', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mover marcador', exact: true }).waitFor({ state: 'detached' });
    await waitSession(page, a, 'Keep this page');
    await waitForSession(page, (value, id) => {
      const group = id === a.hash && value.bookmarks.find(node => node.title === 'Second group'); return group && value.bookmarks.some(node => node.title === 'Keep this page' && node.parentId === group.id);
    });
    await options(page, 'Second group', 'Eliminar y conservar hijos'); await row(page, 'Second group').waitFor({ state: 'detached' }); await row(page, 'Keep this page').waitFor();
    await waitForSession(page, (value, id) => id === a.hash && value.bookmarks.some(node => node.title === 'Keep this page' && node.parentId === null));
    const final = await session(page), nodes = final.bookmarks, retained = nodes.find(node => node.title === 'Keep this page');
    assert(retained && retained.page === 1 && retained.parentId === null); assert(!nodes.some(node => node.title === 'Second group'));
    return { rootOrderChanged: true, movedIntoOtherGroup: true, deletedFolderRetainsPageChild: true, targetPagePreserved: 1 };
  });

  await check('legacy-page-bookmarks-survive-tree-migration', async page => {
    // Earlier versions kept web sessions in localStorage; the database upgrade moves them.
    // Leave the app first so that it writes nothing after the reset.
    await page.goto(`${origin}/folio.svg`);
    await page.evaluate(hash => new Promise(resolve => {
      localStorage.setItem(`folio.session.${hash}`, JSON.stringify({ version: 2, annotations: [], bookmarks: [2, 3], lastPage: 2, documentRevision: hash }));
      const request = indexedDB.deleteDatabase('folio-library'); request.onsuccess = request.onerror = request.onblocked = resolve;
    }), a.hash);
    await page.goto(origin); await open(page, a);
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click();
    await row(page, 'Página 2').waitFor(); await row(page, 'Página 3').waitFor();
    await waitForSession(page, (value, id) => id === a.hash && value.version === 3 && value.bookmarks.length === 2 && value.bookmarks.every(node => typeof node === 'object'));
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('folio.session.'))), false);
    const saved = await session(page); assert.deepEqual(saved.bookmarks.map(node => node.page).sort(), [2, 3]);
    assert(saved.bookmarks.every(node => node.parentId === null && node.title === `Página ${node.page}`));
    return { legacyVersion: 2, migratedVersion: 3, preservedDestinationPages: [2, 3] };
  });

  await check('switching-tabs-commits-bookmark-name-without-enter', async page => {
    await open(page, b); await switchTo(page, a);
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click();
    await page.getByRole('button', { name: 'Crear grupo de marcadores', exact: true }).click(); await rename(page, 'Original name');
    await options(page, 'Original name', 'Renombrar');
    await page.getByRole('textbox', { name: 'Nombre del marcador', exact: true }).fill('Edited before tab switch');
    await page.keyboard.press('Control+Tab'); await active(page, b);
    await page.keyboard.press('Control+Shift+Tab'); await active(page, a);
    await row(page, 'Edited before tab switch').waitFor(); assert.equal(await row(page, 'Original name').count(), 0);
    await waitSession(page, a, 'Edited before tab switch');
    assert.equal((await session(page)).bookmarks.find(node => node.page === null)?.title, 'Edited before tab switch');
    return { unfinishedInlineRenameCommitted: true, switchedWithoutEnter: true, namePersistedInCorrectDocument: true };
  });

  await check('tab-strip-arrow-keys-follow-active-tab-focus', async page => {
    await open(page, b); await tab(page, b).focus();
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('ArrowLeft'); await active(page, a);
      await page.waitForFunction(name => document.activeElement?.getAttribute('role') === 'tab' && document.activeElement.getAttribute('aria-label') === name, a.name);
      assert.equal(await tab(page, a).evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('ArrowRight'); await active(page, b);
      await page.waitForFunction(name => document.activeElement?.getAttribute('role') === 'tab' && document.activeElement.getAttribute('aria-label') === name, b.name);
      assert.equal(await tab(page, b).evaluate(node => node === document.activeElement), true);
    }
    return { repeatedArrowNavigation: true, activeTabReceivesFocus: true };
  });

  await check('repeated-save-keeps-current-pdf-proxy-renderable', async page => {
    for (let i = 1; i <= 3; i++) {
      const bytes = await download(page, `tabs-repeated-save-${i}.pdf`);
      const text = operateDocument(bytes, { operation: 'text' }); assert.equal(text.length, 3); assert(text[0].includes('TAB A PAGE 1'));
      assert.equal(await page.getByRole('tab').count(), 1, 'Saving a copy must keep one tab for this open document.');
    }
    await zoom(page).selectOption('150');
    await desktopDocumentAction(page, 'Girar vista 90°');
    await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
    await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: 'TAB A PAGE 1' }).first().waitFor();
    assert.equal(await page.getByText('No se pudo mostrar la página.', { exact: true }).count(), 0);
    assert(await page.locator('.pdf-page-wrap[data-page-number="1"] canvas').first().evaluate(canvas => canvas.width > 0 && canvas.height > 0));
    const bytes = await download(page, 'tabs-repeated-save-after-view-change.pdf');
    assert(operateDocument(bytes, { operation: 'text' })[0].includes('TAB A PAGE 1'));
    await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    const entry = page.getByRole('button', { name: `Abrir ${a.name}`, exact: true }); await entry.waitFor();
    assert.equal(await entry.count(), 1, 'Downloading keeps the single library entry of the document.');
    return { successiveSaves: 3, renderingAfterFourthSave: true, zoomPercent: 150, viewRotation: 90, currentProxyRemainsUsable: true };
  });
  await check('web-download-keeps-original-session-and-library-entry', async page => {
    await annotate(page, a); await waitForSession(page, (value, id) => id === a.hash && value.annotations.length === 1);
    assert.equal(await tab(page, a).locator('.modified-dot').count(), 1);
    assert.equal(inspectDocument(await download(page, 'tabs-download-keeps-original.pdf')).annotations.length, 1);
    assert.equal(await tab(page, a).locator('.modified-dot').count(), 0, 'The downloaded changes no longer read as unsaved.');
    await page.waitForTimeout(500);
    assert.equal((await session(page, a))?.annotations.length, 1, 'Downloading must keep the session of the original PDF.');
    await page.getByRole('button', { name: `Cerrar ${a.name}`, exact: true }).click(); await tab(page, a).waitFor({ state: 'detached' });
    await open(page, a); await page.locator('.highlight-annotation').first().waitFor();
    await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    const entry = page.getByRole('button', { name: `Abrir ${a.name}`, exact: true }); await entry.waitFor();
    assert.equal(await entry.count(), 1, 'Downloading must neither duplicate nor delete the library entry.');
    return { sessionKept: true, reopenedOriginalShowsAnnotations: true, libraryEntries: 1 };
  });

  await check('unreadable-session-is-not-overwritten', async page => {
    await annotate(page, a); await waitForSession(page, (value, id) => id === a.hash && value.annotations.length === 1);
    await open(page, b); await page.getByRole('button', { name: `Cerrar ${a.name}`, exact: true }).click(); await tab(page, a).waitFor({ state: 'detached' });
    // The next read of the 'sessions' store fails once, as a locked or lost database would.
    await page.evaluate(() => { const get = IDBObjectStore.prototype.get; let fail = true; IDBObjectStore.prototype.get = function (...args) { if (fail && this.name === 'sessions') { fail = false; throw new DOMException('Simulated read failure', 'UnknownError'); } return get.apply(this, args); }; });
    await open(page, a); await page.locator('.toast, .activity-pill').getByText(/No se pudieron cargar las anotaciones guardadas/).waitFor();
    await switchTo(page, b); await switchTo(page, a); await page.waitForTimeout(1800);
    assert.equal((await session(page, a))?.annotations.length, 1, 'A session that could not be read must not be rewritten automatically.');
    await page.getByRole('button', { name: 'Guardar marcador de esta página', exact: true }).click();
    await waitForSession(page, (value, id) => id === a.hash && value.bookmarks.length === 1 && value.annotations.length === 0);
    return { storedAnnotationsKept: true, firstChangeWritesSession: true };
  });

  await check('return-location-survives-smooth-thumbnail-jump', async page => {
    await page.getByRole('button', { name: 'Páginas', exact: true }).click();
    await page.getByRole('button', { name: 'Ir a página 3', exact: true }).click();
    const back = page.getByRole('button', { name: 'Volver a p. 1', exact: true }); await back.waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Número de página"]')?.value === '3'); await page.waitForTimeout(800);
    assert.equal(await back.count(), 1, 'A smooth jump keeps «Volver a p. N» after the animation.');
    await back.click(); await back.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('[aria-label="Número de página"]')?.value === '1');
    return { returnShownAfterSmoothJump: true, returnRestoresPage: true };
  });
} finally { await browser?.close(); preview.kill(); fs.writeFileSync(path.join(output, 'tabs-results.json'), JSON.stringify({ results, errors }, null, 2)); }
if (errors.length) { console.log(JSON.stringify({ uncaughtErrors: errors })); process.exitCode = 1; }
