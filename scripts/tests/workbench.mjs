import assert from 'node:assert/strict';
import { enterAnnotationMode } from './ui-helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { operateDocument } from '../../src/engine/operations.mjs';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';
import { verifySignatures } from '../../src/engine/signatures.mjs';
import { unzipSync, strFromU8 } from 'fflate';

const root = process.cwd(), output = path.join(root, 'test-results'); fs.mkdirSync(output, { recursive: true });
const source = path.join(output, 'workbench-source.pdf');
const fixture = await PDFDocument.create(), font = await fixture.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 3; i++) { const page = fixture.addPage([400, 500]); page.drawText(`PAGE ${i}`, { x: 40, y: 430, size: 18, font }); page.drawText('SECRET 123456', { x: 40, y: 350, size: 18, font }); page.drawText('PRESERVE THIS TEXT', { x: 40, y: 260, size: 14, font }); }
const form = fixture.getForm(), textField = form.createTextField('name'); textField.addToPage(fixture.getPage(0), { x: 40, y: 190, width: 200, height: 30 }); textField.setText('Original');
const box = form.createCheckBox('agree'); box.addToPage(fixture.getPage(0), { x: 40, y: 150, width: 20, height: 20 });
fs.writeFileSync(source, await fixture.save());
const rasterSource = await PDFDocument.create(), rasterPage = rasterSource.addPage([600, 300]);
rasterPage.drawText('FOLIO OCR TEST', { x: 50, y: 210, size: 32 }); rasterPage.drawText('Hola Paraguay 2026', { x: 50, y: 135, size: 27 });
const rasterDocument = new mupdf.PDFDocument(await rasterSource.save()), scanPage = rasterDocument.loadPage(0), pixmap = scanPage.toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
const png = new Uint8Array(pixmap.asPNG()); fs.writeFileSync(path.join(output, 'scan.png'), png); pixmap.destroy(); scanPage.destroy(); rasterDocument.destroy();
const scanned = await PDFDocument.create(), scanImage = await scanned.embedPng(png), scan = scanned.addPage([600, 300]); scan.drawImage(scanImage, { x: 0, y: 0, width: 600, height: 300 });
fs.writeFileSync(path.join(output, 'scan.pdf'), await scanned.save());
const edited = operateDocument(fs.readFileSync(source), { operation: 'replace-text', page: 1, rect: [35, 344, 210, 372], text: 'PUBLIC TEXT', size: 16, color: '#000000' }); fs.writeFileSync(path.join(output, 'comparison-after.pdf'), edited);
const chrome = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '4176', '--strictPort'], { stdio: 'pipe', windowsHide: true });
const origin = 'http://127.0.0.1:4176'; let browser, log = ''; preview.stdout.on('data', data => { log += data; }); preview.stderr.on('data', data => { log += data; });
const results = [], errors = [];
async function check(id, action) {
  if (process.env.FOLIO_UI_TEST && !new RegExp(process.env.FOLIO_UI_TEST).test(id)) return;
  const context = await browser.newContext({ viewport: { width: 1360, height: 760 }, acceptDownloads: true }), page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push({ id, error: error.message }));
  page.on('console', message => { if (message.type() === 'error') console.log(JSON.stringify({ id, browserConsole: message.text() })); });
  page.on('requestfailed', request => console.log(JSON.stringify({ id, failedRequest: request.url(), error: request.failure()?.errorText })));
  try { await page.goto(origin); await open(page, source); const evidence = await action(page); results.push({ id, status: 'passed', ...evidence }); }
  catch (error) { results.push({ id, status: 'failed', error: error.stack }); process.exitCode = 1; await page.screenshot({ path: path.join(output, `failure-${id}.png`), animations: 'disabled' }); }
  finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
}
async function open(page, file) { await page.locator('.app-header input[type=file]').setInputFiles(file); await page.getByRole('heading', { name: path.basename(file), exact: true }).waitFor(); await page.locator('.loading-overlay').waitFor({ state: 'detached' }); await page.locator('.pdf-page-wrap').first().waitFor(); }
async function tools(page, name) { await page.getByRole('button', { name: 'Herramientas', exact: true }).click(); await page.getByRole('button', { name, exact: true }).click(); }
async function save(page, name) { const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar', exact: true }).click(); const file = await download; const target = path.join(output, name); await file.saveAs(target); await page.locator('.loading-overlay').waitFor({ state: 'detached' }); return new Uint8Array(fs.readFileSync(target)); }
async function drawArea(page, box) { await page.getByRole('combobox', { name: 'Nivel de zoom' }).selectOption('100'); await page.locator('.reading-area').evaluate(el => { el.scrollTop = 0; }); await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' }); const bounds = await page.locator('.pdf-page').first().boundingBox(); const a = { x: bounds.x + box[0], y: bounds.y + 500 - box[3] }, b = { x: bounds.x + box[2], y: bounds.y + 500 - box[1] }; await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up(); }
const plannedOrder = page => page.locator('.page-plan .plan-label').allTextContents();
const selectedPositions = page => page.locator('.page-plan>article').evaluateAll(cards => cards.flatMap((card, index) => card.querySelector('input').checked ? [index + 1] : []));
async function dragPlannedPage(page, sourceLabel, targetLabel, side, release = true) {
  const cards = page.locator('.page-plan>article');
  const source = cards.filter({ has: page.locator('.plan-label').filter({ hasText: sourceLabel }) });
  const target = cards.filter({ has: page.locator('.plan-label').filter({ hasText: targetLabel }) });
  await dragPlannedCards(page, source, target, side, release);
}
async function dragPlannedCards(page, source, target, side, release = true) {
  const a = await source.locator('.thumbnail-item, .plan-placeholder').boundingBox(), b = await target.boundingBox(); assert(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2, { steps: 3 });
  await page.locator('.page-plan-drag-preview').waitFor();
  await page.mouse.move(b.x + b.width * (side === 'before' ? .2 : .8), b.y + b.height / 2, { steps: 12 });
  await target.locator(`xpath=self::*[contains(@class,"plan-drop-${side}")]`).waitFor();
  if (release) { await page.mouse.up(); await page.locator('.page-plan-drag-preview').waitFor({ state: 'detached' }); }
}
try {
  for (let n = 0; n < 100; n++) { try { if ((await fetch(origin)).ok) break; } catch {} if (preview.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  await check('single-controls-and-page-order', async page => {
    assert.equal(await page.getByRole('button', { name: 'Abrir PDF', exact: true }).count(), 1); assert.equal(await page.getByRole('button', { name: /Buscar en/ }).count(), 1);
    await page.getByRole('button', { name: 'Páginas', exact: true }).click(); assert.equal(await page.locator('.sidebar-tabs').count(), 0); await page.getByRole('button', { name: 'Páginas', exact: true }).click();
    await tools(page, 'Organizar páginas');
    assert.equal(await page.getByRole('textbox', { name: 'Orden o intervalo de páginas' }).count(), 0);
    await dragPlannedPage(page, 'Página 3', 'Página 1', 'before');
    await page.getByLabel('Seleccionar posición 3', { exact: true }).check(); await page.getByRole('button', { name: 'Eliminar páginas seleccionadas', exact: true }).click();
    await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).click(); await page.locator('.workbench').waitFor({ state: 'detached' }); assert.equal(await page.locator('.pdf-page-wrap').count(), 2);
    const bytes = await save(page, 'ui-organized.pdf'), text = operateDocument(bytes, { operation: 'text' }); assert(text[0].includes('PAGE 3') && text[1].includes('PAGE 1')); return { duplicateControlsRemoved: true, savedOrder: [3, 1] };
  });
  await check('mouse-page-drag-group-cancel-and-content-history', async page => {
    await tools(page, 'Organizar páginas');
    await dragPlannedPage(page, 'Página 3', 'Página 1', 'before');
    assert.deepEqual(await plannedOrder(page), ['Página 3', 'Página 1', 'Página 2']);
    assert.equal(await page.locator('.page-plan input:checked').count(), 0, 'Dropping a thumbnail must not toggle its selection.');
    await dragPlannedPage(page, 'Página 3', 'Página 2', 'after');
    assert.deepEqual(await plannedOrder(page), ['Página 1', 'Página 2', 'Página 3']);
    await dragPlannedPage(page, 'Página 3', 'Página 1', 'before', false);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await page.locator('dialog.workbench[open]').count(), 1, 'Escape cancels the drag while keeping the organizer open.');
    assert.deepEqual(await plannedOrder(page), ['Página 1', 'Página 2', 'Página 3']);
    await dragPlannedPage(page, 'Página 3', 'Página 1', 'before', false);
    await page.mouse.move(3, 3, { steps: 8 }); await page.mouse.up();
    assert.deepEqual(await plannedOrder(page), ['Página 1', 'Página 2', 'Página 3']);
    await page.getByLabel('Seleccionar posición 1', { exact: true }).check();
    await page.getByLabel('Seleccionar posición 3', { exact: true }).click({ modifiers: ['Shift'] });
    for (let i = 0; i < 9; i++) await page.getByRole('button', { name: 'Duplicar páginas seleccionadas', exact: true }).click();
    const longOrder = await plannedOrder(page); assert.equal(longOrder.length, 30);
    const grid = page.locator('.page-plan'), first = await grid.locator('.thumbnail-item').first().boundingBox(), bounds = await grid.boundingBox(); assert(first && bounds);
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2); await page.mouse.down();
    await page.mouse.move(first.x + first.width / 2 + 8, first.y + first.height / 2, { steps: 3 });
    await page.locator('.page-plan-drag-preview').waitFor();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 5, { steps: 12 });
    await page.waitForFunction(() => document.querySelector('.page-plan').scrollTop > 100);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await plannedOrder(page), longOrder, 'Auto-scrolling followed by cancellation keeps the order.');
    await page.locator('.workbench').getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
    await tools(page, 'Organizar páginas');
    await page.getByLabel('Seleccionar posición 1', { exact: true }).check(); await page.getByLabel('Seleccionar posición 3', { exact: true }).check();
    await dragPlannedPage(page, 'Página 3', 'Página 2', 'after');
    assert.deepEqual(await plannedOrder(page), ['Página 2', 'Página 1', 'Página 3'], 'Selected pages retain their relative order.');
    assert.equal(await page.locator('.page-plan input:checked').count(), 2);
    await page.screenshot({ path: path.join(output, 'page-plan-mouse-reordered.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).click(); await page.locator('.workbench').waitFor({ state: 'detached' });
    await page.locator('.pdf-page-wrap').first().locator('.textLayer span').filter({ hasText: 'PAGE 2' }).waitFor();
    await page.getByRole('button', { name: 'Deshacer (Ctrl+Z)', exact: true }).click(); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await page.locator('.pdf-page-wrap').first().locator('.textLayer span').filter({ hasText: 'PAGE 1' }).waitFor();
    await page.getByRole('button', { name: 'Rehacer (Ctrl+Y)', exact: true }).click(); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await page.locator('.pdf-page-wrap').first().locator('.textLayer span').filter({ hasText: 'PAGE 2' }).waitFor();
    const bytes = await save(page, 'ui-mouse-organized.pdf');
    assert.deepEqual(operateDocument(bytes, { operation: 'text' }).map(text => text.match(/PAGE (\d)/)[1]), ['2', '1', '3']);
    return { realMouseReorder: true, selectedGroupOrderPreserved: true, escapeAndOutsideCancel: true, edgeAutoScroll: true, exportedOrderAndUndoRedo: true };
  });
  await check('page-selection-shift-anchor-and-pending-changes', async page => {
    await tools(page, 'Organizar páginas');
    const cards = page.locator('.page-plan>article'), thumbnail = position => cards.nth(position - 1).locator('.thumbnail-item');
    const checkbox = position => page.getByLabel(`Seleccionar posición ${position}`, { exact: true });
    const apply = page.getByRole('button', { name: 'Aplicar cambios', exact: true }), extract = page.getByRole('button', { name: 'Extraer selección', exact: true });
    assert(await apply.isDisabled()); assert(await extract.isDisabled());
    await thumbnail(3).click({ modifiers: ['Shift'] }); assert.deepEqual(await selectedPositions(page), [3]);
    assert(await apply.isDisabled(), 'Selecting pages does not change the PDF.'); assert(await extract.isEnabled());
    await thumbnail(3).click(); await checkbox(1).click({ modifiers: ['Shift'] }); assert.deepEqual(await selectedPositions(page), [1, 2, 3]);
    await page.getByRole('button', { name: 'Girar páginas seleccionadas', exact: true }).click(); assert(await apply.isEnabled());
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Girar páginas seleccionadas', exact: true }).click();
    assert(await apply.isDisabled(), 'Four rotations restore the original plan.');
    await page.getByRole('button', { name: 'Página en blanco', exact: true }).click(); assert(await apply.isEnabled());
    for (let i = 1; i <= 3; i++) await checkbox(i).click();
    await checkbox(4).click(); await page.getByRole('button', { name: 'Eliminar páginas seleccionadas', exact: true }).click();
    assert(await apply.isDisabled(), 'Removing the newly inserted blank page restores the original plan.');
    await checkbox(1).click(); await checkbox(3).click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Duplicar páginas seleccionadas', exact: true }).click(); assert.equal(await cards.count(), 6);
    for (const i of [1, 3, 5]) await checkbox(i).click();
    await thumbnail(2).click(); await thumbnail(5).click({ modifiers: ['Shift'] }); assert.deepEqual(await selectedPositions(page), [2, 3, 4, 5]);
    await thumbnail(3).click({ modifiers: ['Shift'] }); assert.deepEqual(await selectedPositions(page), [2, 3], 'Successive Shift clicks preserve the original anchor.');
    await thumbnail(2).click(); await thumbnail(1).click({ modifiers: ['Shift'] }); assert.deepEqual(await selectedPositions(page), [1, 2]);
    await thumbnail(5).click({ modifiers: ['Control'] }); await thumbnail(6).click({ modifiers: ['Control', 'Shift'] }); assert.deepEqual(await selectedPositions(page), [1, 2, 5, 6]);
    await thumbnail(4).click({ modifiers: ['Meta'] }); await thumbnail(3).click({ modifiers: ['Meta', 'Shift'] }); assert.deepEqual(await selectedPositions(page), [1, 2, 3, 4, 5, 6]);
    await checkbox(4).click(); await checkbox(2).click({ modifiers: ['Shift'] }); assert.deepEqual(await selectedPositions(page), [2, 3, 4]);
    const anchor = await cards.nth(3).getAttribute('data-plan-key');
    await page.getByRole('button', { name: 'Mover posición 4 antes', exact: true }).click();
    await thumbnail(5).click({ modifiers: ['Shift'] }); assert.deepEqual(await selectedPositions(page), [3, 4, 5]);
    assert.equal(await cards.nth(2).getAttribute('data-plan-key'), anchor, 'The anchor follows its page after reordering.');
    await page.getByRole('button', { name: 'Duplicar páginas seleccionadas', exact: true }).click();
    await thumbnail(7).click({ modifiers: ['Shift'] }); assert.deepEqual(await selectedPositions(page), [3, 4, 5, 6, 7]);
    assert.equal(await cards.nth(2).getAttribute('data-plan-key'), anchor, 'Duplicates do not replace the anchor.');
    await page.getByRole('button', { name: 'Eliminar páginas seleccionadas', exact: true }).click(); assert.equal(await cards.count(), 4);
    await checkbox(2).click({ modifiers: ['Shift'] }); assert.deepEqual(await selectedPositions(page), [2], 'Deleting the anchor makes the next Shift click start a new range.');
    await dragPlannedCards(page, cards.nth(1), cards.nth(3), 'after', false); await page.keyboard.press('Escape'); await page.mouse.up();
    await thumbnail(4).click({ modifiers: ['Shift'] }); assert.deepEqual(await selectedPositions(page), [2, 3, 4], 'Canceling a drag keeps the selection anchor.');
    await page.screenshot({ path: path.join(output, 'page-selection-shift-range.png'), animations: 'disabled' });
    return { thumbnailAndCheckboxRanges: true, reverseAndRepeatedRanges: true, controlAndMetaAdditive: true, keyedAnchorAfterReorderDuplicateDelete: true, canceledDragPreservesAnchor: true, onlyPdfChangesEnableApply: true };
  });
  await check('extract-selected-rotated-and-inserted-pages-without-changing-source', async page => {
    await tools(page, 'Organizar páginas');
    await page.getByLabel('Seleccionar posición 1', { exact: true }).check(); await page.getByLabel('Seleccionar posición 3', { exact: true }).click({ modifiers: ['Control'] });
    await page.getByRole('button', { name: 'Girar páginas seleccionadas', exact: true }).click();
    await page.getByRole('button', { name: 'Página en blanco', exact: true }).click();
    await page.locator('.page-plan-actions input[type=file]').setInputFiles(source); await page.waitForFunction(() => document.querySelectorAll('.page-plan>article').length === 7);
    await page.getByLabel('Seleccionar posición 7', { exact: true }).click({ modifiers: ['Control'] });
    await page.getByRole('button', { name: 'Extraer selección', exact: true }).click();
    const extractedName = 'workbench-source — páginas extraídas.pdf'; await page.getByRole('heading', { name: extractedName, exact: true }).waitFor(); await page.locator('.workbench').waitFor({ state: 'detached' });
    const bytes = await save(page, 'ui-selected-extracted.pdf'), extracted = await PDFDocument.load(bytes);
    assert.equal(extracted.getPageCount(), 3); assert.deepEqual(extracted.getPages().map(page => page.getRotation().angle), [90, 90, 0]);
    assert.deepEqual(operateDocument(bytes, { operation: 'text' }).map(text => text.match(/PAGE (\d)/)[1]), ['1', '3', '3']);
    await page.getByRole('tab', { name: path.basename(source), exact: true }).click(); await page.getByRole('heading', { name: path.basename(source), exact: true }).waitFor(); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    const originalBytes = await save(page, 'ui-extraction-source-preserved.pdf'), original = await PDFDocument.load(originalBytes);
    assert.equal(original.getPageCount(), 3); assert.deepEqual(original.getPages().map(page => page.getRotation().angle), [0, 0, 0]);
    assert.deepEqual(operateDocument(originalBytes, { operation: 'text' }).map(text => text.match(/PAGE (\d)/)[1]), ['1', '2', '3']);
    return { selectedPagesOnly: true, insertedPdfAndRotationPreserved: true, unselectedBlankExcluded: true, sourcePdfUnchanged: true };
  });
  await check('forms-fill-and-export', async page => {
    await tools(page, 'Rellenar formulario'); await page.locator('.form-fields label').filter({ hasText: 'name' }).locator('input').fill('Emilio González'); await page.locator('.form-fields label').filter({ hasText: 'agree' }).locator('input').check();
    await page.getByRole('button', { name: 'Aplicar valores', exact: true }).click(); await page.locator('.workbench').waitFor({ state: 'detached' });
    const bytes = await save(page, 'ui-filled.pdf'), fields = operateDocument(bytes, { operation: 'fields' }); assert.equal(fields.find(f => f.name === 'name').value, 'Emilio González'); assert(fields.find(f => f.name === 'agree').checked); return { actualFieldsSaved: true };
  });
  await check('text-replacement-and-content-history', async page => {
    await tools(page, 'Reemplazar texto'); await drawArea(page, [35, 344, 210, 372]); await page.getByRole('textbox', { name: 'Texto', exact: true }).fill('UI REPLACED'); await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).click(); await page.locator('.workbench').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Deshacer (Ctrl+Z)', exact: true }).click(); await page.locator('.loading-overlay').waitFor({ state: 'detached' }); await page.getByRole('button', { name: 'Rehacer (Ctrl+Y)', exact: true }).click(); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    const bytes = await save(page, 'ui-edited.pdf'), text = operateDocument(bytes, { operation: 'text' }); assert(text[0].includes('UI REPLACED')); assert(!text[0].includes('SECRET')); assert(text[0].includes('PRESERVE THIS TEXT')); return { originalTextRemoved: true, undoRedoContent: true };
  });
  await check('redaction-removes-content', async page => {
    await tools(page, 'Censurar contenido'); await drawArea(page, [30, 340, 250, 380]); await page.getByRole('button', { name: 'Revisar 1 áreas', exact: true }).click(); await page.getByRole('button', { name: 'Eliminar contenido seleccionado', exact: true }).click(); await page.locator('.workbench').waitFor({ state: 'detached' });
    const bytes = await save(page, 'ui-redacted.pdf'), text = operateDocument(bytes, { operation: 'text' }); assert(!text[0].includes('SECRET')); assert(text[0].includes('PRESERVE')); return { dataRemoved: true };
  });
  await check('ocr-local-searchable-pdf', async page => {
    const externalRequests = []; page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) externalRequests.push(request.url()); });
    await open(page, path.join(output, 'scan.pdf')); await tools(page, 'Reconocer texto (OCR)'); await page.getByLabel('Idioma', { exact: true }).selectOption('eng'); await page.getByRole('button', { name: 'Reconocer texto', exact: true }).click(); await page.locator('.workbench').waitFor({ state: 'detached', timeout: 120000 });
    const bytes = await save(page, 'ui-ocr.pdf'), text = operateDocument(bytes, { operation: 'text' }); assert(text[0].includes('FOLIO OCR TEST'), text[0]); assert.equal(externalRequests.length, 0, externalRequests.join('\n')); return { realOcr: true, networkRequestsOutsideApp: 0 };
  });
  await check('word-and-image-conversion', async page => {
    await tools(page, 'Convertir PDF'); await page.getByLabel('Páginas a exportar', { exact: true }).selectOption('range'); await page.getByRole('textbox', { name: 'Intervalo de páginas' }).fill('0'); assert(await page.getByRole('button', { name: 'Exportar Word', exact: true }).isDisabled()); await page.getByRole('textbox', { name: 'Intervalo de páginas' }).fill('1-2'); const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Exportar Word', exact: true }).click(); const file = await download; await file.saveAs(path.join(output, 'ui-converted.docx')); await page.locator('.workbench').waitFor({ state: 'detached' });
    const files = unzipSync(fs.readFileSync(path.join(output, 'ui-converted.docx'))); assert(strFromU8(files['word/document.xml']).includes('PRESERVE THIS TEXT'));
    await tools(page, 'Convertir PDF'); await page.getByLabel('Formato de exportación', { exact: true }).selectOption('png'); await page.getByLabel('Resolución PNG', { exact: true }).selectOption('300'); await page.getByLabel('Fondo PNG', { exact: true }).selectOption('transparent'); const images = page.waitForEvent('download'); await page.getByRole('button', { name: 'Exportar PNG', exact: true }).click(); const zip = await images; await zip.saveAs(path.join(output, 'ui-pages.zip')); const pngFiles = unzipSync(fs.readFileSync(path.join(output, 'ui-pages.zip'))); assert.equal(Object.keys(pngFiles).length, 1); const image = Object.values(pngFiles)[0], view = new DataView(image.buffer, image.byteOffset, image.byteLength); assert.equal(view.getUint32(16), 1667); assert.equal(view.getUint32(20), 2084); return { editableWordText: true, actualPngExport: true, dpi300: true, invalidRangeBlocked: true };
  });
  await check('visual-and-text-comparison', async page => {
    await tools(page, 'Comparar documentos'); await page.locator('.compare-documents input[type=file]').setInputFiles(path.join(output, 'comparison-after.pdf')); await page.getByRole('button', { name: 'Comparar', exact: true }).click(); await page.locator('.visual-comparison img').first().waitFor(); assert.equal(await page.locator('.visual-comparison img').count(), 3);
    await page.getByLabel('Comparación', { exact: true }).selectOption('text'); await page.locator('.text-differences .added').filter({ hasText: 'PUBLIC TEXT' }).waitFor(); assert(await page.locator('.text-differences .removed').innerText() !== ''); await page.screenshot({ path: path.join(output, 'comparison-ui.png') }); return { actualVisualDiff: true, textualDifference: true };
  });
  await check('real-digital-signing-and-verification', async page => {
    await tools(page, 'Firmas digitales'); await page.locator('.signing-form input[type=file]').setInputFiles(path.join(output, 'qa-identity.p12')); await page.getByLabel('Contraseña del certificado', { exact: true }).fill('qa-only'); await page.getByRole('button', { name: 'Firmar documento', exact: true }).click(); await page.locator('.workbench').waitFor({ state: 'detached', timeout: 60000 });
    const bytes = await save(page, 'ui-signed.pdf'); const signatures = await verifySignatures(bytes); assert(signatures[0].integrity && signatures[0].coversWholeDocument);
    await tools(page, 'Firmas digitales'); await page.getByRole('button', { name: 'Verificar firmas', exact: true }).click(); await page.locator('.signature-results article').waitFor(); assert((await page.locator('.signature-results article').innerText()).includes('Válida')); return { validRsaCms: true, verifiedInBrowserWorker: true };
  });
  await check('draft-survives-reload', async page => {
    await tools(page, 'Organizar páginas'); await dragPlannedPage(page, 'Página 2', 'Página 1', 'before'); await page.getByLabel('Seleccionar posición 3', { exact: true }).check(); await page.getByRole('button', { name: 'Eliminar páginas seleccionadas', exact: true }).click(); await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).click(); await page.locator('.workbench').waitFor({ state: 'detached' });
    await page.waitForFunction(async () => { const db = await new Promise(resolve => { const req = indexedDB.open('folio-library', 2); req.onsuccess = () => resolve(req.result); }); const count = await new Promise(resolve => { const tx = db.transaction('drafts'); const req = tx.objectStore('drafts').count(); req.onsuccess = () => resolve(req.result); tx.oncomplete = () => db.close(); }); return count > 0; });
    await page.reload(); await open(page, source); assert.equal(await page.locator('.pdf-page-wrap').count(), 2); const bytes = await save(page, 'ui-restored-draft.pdf'); assert(operateDocument(bytes, { operation: 'text' })[0].includes('PAGE 2')); return { realBytesRecovered: true };
  });
  await check('horizontal-text-highlight-and-direct-ctrl-save', async page => {
    await enterAnnotationMode(page);
    await page.getByRole('combobox', { name: 'Nivel de zoom' }).selectOption('100');
    await page.locator('.textLayer span').filter({ hasText: 'PRESERVE THIS TEXT' }).first().waitFor();
    await page.getByRole('button', { name: 'Resaltado automático (H)', exact: true }).click();
    const span=await page.locator('.textLayer span').filter({ hasText: 'PRESERVE THIS TEXT' }).first().boundingBox();
    await page.mouse.move(span.x+1,span.y+span.height/2); await page.mouse.down(); await page.mouse.move(span.x+span.width-1,span.y+span.height/2,{steps:8}); await page.mouse.up();
    await page.locator('.highlight-annotation').first().waitFor();
    await page.getByRole('textbox',{name:'Número de página',exact:true}).focus();
    const download=page.waitForEvent('download'); await page.keyboard.press('Control+s'); const file=await download;
    const target=path.join(output,'ui-text-highlight.pdf'); await file.saveAs(target);
    const notes=inspectDocument(fs.readFileSync(target)).annotations;
    assert(notes.some(a=>a.quads?.length && a.text.includes('PRESERVE THIS TEXT')),JSON.stringify(notes));
    assert.equal(await page.locator('dialog[open]').count(),0); return { characterSelection:true, standardQuads:true, ctrlSWithoutExtraDialog:true };
  });
  await check('real-public-form-and-encrypted-permissions', async page => {
    await open(page,path.join(root,'.fixtures','irs-w9.pdf')); await tools(page,'Rellenar formulario');
    await page.locator('.form-fields input').first().waitFor(); assert(await page.locator('.form-fields label').count()>10);
    await page.locator('dialog[open]').getByRole('button',{name:'Cerrar diálogo',exact:true}).click();
    const locked=operateDocument(fs.readFileSync(source),{operation:'protect',userPassword:'reader',ownerPassword:'owner',permissions:4});
    fs.writeFileSync(path.join(output,'ui-restricted-source.pdf'),locked);
    await page.locator('.app-header input[type=file]').setInputFiles(path.join(output,'ui-restricted-source.pdf'));
    await page.getByLabel('Contraseña del documento',{exact:true}).fill('wrong'); await page.locator('.password-modal').getByRole('button',{name:'Abrir PDF',exact:true}).click();
    await page.locator('.password-error').waitFor(); await page.getByLabel('Contraseña del documento',{exact:true}).fill('reader'); await page.locator('.password-modal').getByRole('button',{name:'Abrir PDF',exact:true}).click();
    await page.locator('.loading-overlay').waitFor({state:'detached'}); await page.getByRole('button',{name:'Herramientas',exact:true}).click();
    assert(await page.getByRole('button',{name:'Reemplazar texto',exact:true}).isDisabled()); assert(await page.getByRole('button',{name:'Rellenar formulario',exact:true}).isDisabled());
    assert.equal(await page.locator('.textLayer').first().evaluate(el=>getComputedStyle(el).userSelect),'none');
    return { realW9Fields:true, wrongPasswordRetry:true, editAndFormPermissionsEnforced:true };
  });
  await check('large-public-manual-and-invalid-file-recovery', async page => {
    await open(page,path.join(root,'.fixtures','emacs-manual.pdf')); const doc=new mupdf.PDFDocument(fs.readFileSync(path.join(root,'.fixtures','emacs-manual.pdf'))); const count=doc.countPages(); doc.destroy();
    assert(count>700); const input=page.getByRole('textbox',{name:'Número de página',exact:true}); await input.fill(String(count)); await input.press('Enter');
    await page.locator(`.pdf-page-wrap[data-page-number="${count}"] .page-loading`).waitFor({state:'detached'});
    fs.writeFileSync(path.join(output,'invalid.pdf'),'This is not a PDF'); await page.locator('.app-header input[type=file]').setInputFiles(path.join(output,'invalid.pdf'));
    await page.locator('.toast.error').waitFor(); assert.equal(await page.getByRole('heading',{name:'emacs-manual.pdf',exact:true}).count(),1);
    await open(page,source); assert.equal(await page.locator('.pdf-page-wrap').count(),3); return { publicManualPages:count, lastPageRendered:true, invalidFileKeepsCurrentDocument:true };
  });
  await check('ocr-cancel-keeps-document-usable', async page => {
    await open(page,path.join(output,'scan.pdf')); await tools(page,'Reconocer texto (OCR)');
    await page.getByRole('button',{name:'Reconocer texto',exact:true}).click(); await page.getByRole('button',{name:'Cancelar',exact:true}).click();
    await page.locator('.operation-loading').waitFor({state:'detached'}); await page.locator('dialog[open]').getByRole('button',{name:'Cerrar diálogo',exact:true}).click();
    const bytes=await save(page,'ui-canceled-ocr.pdf'); assert.equal(operateDocument(bytes,{operation:'text'})[0].trim(),''); return { canceledBeforeMutation:true, saveStillWorks:true };
  });
  await check('create-form-field-and-fill-real-value', async page => {
    await tools(page,'Crear campo'); await drawArea(page,[40,30,220,65]);
    await page.getByLabel('Nombre del campo',{exact:true}).fill('created_by_user'); await page.getByRole('button',{name:'Crear campo',exact:true}).click(); await page.locator('.workbench').waitFor({state:'detached'});
    await tools(page,'Rellenar formulario'); await page.locator('.form-fields label').filter({hasText:'created_by_user'}).locator('input').fill('Nuevo valor');
    await page.getByRole('button',{name:'Aplicar valores',exact:true}).click(); await page.locator('.workbench').waitFor({state:'detached'});
    const bytes=await save(page,'ui-created-field.pdf'); assert.equal(operateDocument(bytes,{operation:'fields'}).find(f=>f.name==='created_by_user').value,'Nuevo valor'); return { realWidgetCreated:true, valueAndAppearanceSaved:true };
  });
  await check('image-to-pdf-creation', async page => {
    await page.getByRole('button',{name:'Crear PDF',exact:true}).click(); await page.getByLabel('Nombre',{exact:true}).fill('Desde imagen.pdf');
    await page.locator('.workbench input[type=file]').setInputFiles(path.join(output,'scan.png')); await page.getByRole('button',{name:'Crear documento',exact:true}).click(); await page.locator('.workbench').waitFor({state:'detached'});
    const bytes=await save(page,'ui-created-from-image.pdf'), pdf=await PDFDocument.load(bytes); assert.equal(pdf.getPageCount(),1);
    const doc=new mupdf.PDFDocument(bytes); let images=0;
    doc.findPage(0).get('Resources','XObject').forEach(value=>{if(value.get('Subtype').asName()==='Image')images++;});
    assert.equal(images,1);doc.destroy(); return { createdFromImage:true, realEmbeddedImage:true };
  });
  await check('ctrl-print-prepares-document-pages', async page => {
    await page.evaluate(()=>{window.print=()=>{window.__folioPrintCalled=true;};});
    await page.keyboard.press('Control+p'); await page.waitForFunction(()=>window.__folioPrintCalled===true);
    assert.equal(await page.locator('.print-document .print-sheet img').count(),3);
    assert(await page.locator('.print-document .print-sheet img').first().evaluate(img=>img.complete && img.naturalWidth>0));
    return { shortcutUsesCurrentPdf:true, preparedPages:3, physicalPrinterTested:false };
  });
} finally { await browser?.close(); preview.kill(); fs.writeFileSync(path.join(output, 'workbench-results.json'), JSON.stringify({ results, errors }, null, 2)); }
if (errors.length) { console.log(JSON.stringify({ uncaughtErrors: errors })); process.exitCode = 1; }
