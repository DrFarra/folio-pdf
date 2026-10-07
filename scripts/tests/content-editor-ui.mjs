import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { androidTablet, desktopDocumentAction, openTabletEditor, tabletDownload } from './ui-helpers.mjs';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { operateDocument } from '../../src/engine/operations.mjs';
import { inspectDocument, writeAnnotations } from '../../src/engine/mupdf-engine.mjs';

const root = process.cwd(), output = path.join(root, 'test-results');
const frontendEntry = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8').match(/<script[^>]+src="([^"]+)"/)?.[1];
assert(frontendEntry, 'A built frontend is required.');
fs.mkdirSync(output, { recursive: true });
const source = path.join(output, 'content-editor-source.pdf');
const fixture = await PDFDocument.create(), font = await fixture.embedFont(StandardFonts.Helvetica);
for (let number = 1; number <= 2; number++) {
  const page = fixture.addPage([400, 500]);
  page.drawText(`PAGE ${number}`, { x: 40, y: 430, size: 18, font });
  page.drawText('ORIGINAL TEXT', { x: 40, y: 350, size: 16, font });
  page.drawText('NEIGHBOR TEXT', { x: 40, y: 260, size: 14, font });
}
let original = writeAnnotations(await fixture.save(), [{ id: 'editor-note', page: 1, kind: 'note', rect: [45, 347, 62, 364], color: '#f4cc59', text: 'Keep this note', created: 1 }]);
fs.writeFileSync(source, original);
const rotated = await PDFDocument.create();
const rotations = [90, 180, 270, 0], crop = [2.83466, 65.1969, 482.685, 575.325];
for (const angle of rotations) {
  const page = rotated.addPage([485.52, 578.16]); page.setCropBox(crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1]); page.setRotation(degrees(angle));
  // Light gray source glyphs cannot contaminate the magenta ink predicate with
  // LCD/subpixel color fringes around dark original text on Windows.
  page.drawText(`ROTATED ${angle}`, { x: 60, y: 470, size: 16, font: await rotated.embedFont(StandardFonts.Helvetica), color: rgb(.75, .75, .75) });
}
const rotatedSource = path.join(output, 'content-editor-rotated.pdf');
// Scanned PDFs commonly finish with invisible OCR text. Its rendering mode is
// inherited by later streams unless the original content is properly isolated.
const inheritedTextMode = new mupdf.PDFDocument(await rotated.save());
for (let index = 0; index < rotations.length; index++) {
  const target = inheritedTextMode.findPage(index), previous = target.get('Contents'), contents = inheritedTextMode.newArray();
  if (previous.isArray()) for (let stream = 0; stream < previous.length; stream++) contents.push(previous.get(stream));
  else if (!previous.isNull()) contents.push(previous);
  contents.push(inheritedTextMode.addStream('BT 3 Tr ET\n', {})); target.put('Contents', contents);
}
const inheritedBuffer = inheritedTextMode.saveToBuffer('garbage=4,compress=yes');
fs.writeFileSync(rotatedSource, new Uint8Array(inheritedBuffer.asUint8Array())); inheritedBuffer.destroy(); inheritedTextMode.destroy();
const imageFixture = await PDFDocument.create(), imagePage = imageFixture.addPage([100, 50]);
imagePage.drawRectangle({ x: 0, y: 0, width: 50, height: 50, color: rgb(1, 0, 0) });
imagePage.drawRectangle({ x: 50, y: 0, width: 50, height: 50, color: rgb(0, .7, 0) });
const imageDoc = new mupdf.PDFDocument(await imageFixture.save()), imageMuPage = imageDoc.loadPage(0);
const imagePixmap = imageMuPage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
const imageBytes = new Uint8Array(imagePixmap.asPNG());
const imageFile = path.join(output, 'content-editor-image.png'); fs.writeFileSync(imageFile, imageBytes);
imagePixmap.destroy(); imageMuPage.destroy(); imageDoc.destroy();
const withImage = operateDocument(original, { operation: 'add-image', page: 1, rect: [40, 60, 240, 160], image: imageBytes });
const imageSource = path.join(output, 'content-editor-image-source.pdf'); fs.writeFileSync(imageSource, withImage);

const chrome = findChrome();
assert(chrome, 'A Chromium executable is required.');
const port = process.env.FOLIO_EDITOR_UI_PORT || '4201', origin = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { windowsHide: true, stdio: 'pipe' });
let log = '', browser; const results = [], errors = [];
server.stdout.on('data', chunk => { log += chunk; }); server.stderr.on('data', chunk => { log += chunk; });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const text = bytes => operateDocument(bytes, { operation: 'text' });
async function open(page, file = source) {
  await page.locator('.app-header input[type=file]').setInputFiles(file);
  await page.getByRole('heading', { name: path.basename(file), exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.locator('.pdf-page-wrap').first().waitFor();
  await page.locator('.reading-area').evaluate(node => { node.scrollTop = 0; });
  await page.locator('.pdf-page-wrap').first().locator('.page-loading').waitFor({ state: 'detached' });
}
const picker = (page, number) => page.locator(`.pdf-content-picker${number ? `[data-page="${number}"]` : ''}[data-picker-state="ready"]`).waitFor({ timeout: 60000 });
// Touch layouts keep this editor (the desktop edits inside the reader, see
// edit-mode-ui.mjs); a tablet opens it from the document action sheet. Add tools
// draw on the selector page at 100 % (1 pt = 1 px); replace tools select a detected item.
async function editor(page, action, box = null, number = 1) {
  if (!await page.locator('.pdf-content-picker').count()) await openTabletEditor(page);
  const selector = page.locator('.pdf-content-picker'); await picker(page);
  if (await selector.getAttribute('data-page') !== String(number)) { await selector.getByLabel('Página del editor', { exact: true }).fill(String(number)); await selector.getByLabel('Página del editor', { exact: true }).press('Enter'); }
  await picker(page, number);
  if (await selector.getByRole('button', { name: '100 %', exact: true }).getAttribute('aria-pressed') !== 'true') { await selector.getByRole('button', { name: '100 %', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.pdf-content-picker [aria-label="Zoom actual"]')?.textContent === '100 %'); }
  await picker(page, number);
  if (action === 'Reemplazar texto') await selector.getByRole('button', { name: /^(Párrafo|Texto): ORIGINAL TEXT$/ }).first().click();
  else if (action === 'Reemplazar imagen') await selector.locator('.pdf-content-item[data-kind="image"][data-editable="true"]').first().click();
  else {
    await selector.getByRole('button', { name: action, exact: true }).click(); await stageSettled(page);
    const bounds = await selector.locator('.pdf-picker-stage').boundingBox(); assert(bounds);
    await page.mouse.move(bounds.x + box[0], bounds.y + box[1]); await page.mouse.down();
    await page.mouse.move(bounds.x + box[2], bounds.y + box[3], { steps: 8 }); await page.mouse.up();
  }
  await page.locator('.content-editor').waitFor(); await page.locator('.content-preview canvas').waitFor();
}
// Choosing a tool changes the hint below the page, which can resize and re-render the page: draw once it is stable.
const stageSettled = page => page.waitForFunction(() => new Promise(resolve => {
  const stage = document.querySelector('.pdf-content-picker[data-picker-state="ready"] .pdf-picker-stage'); if (!stage) { resolve(false); return; }
  const before = JSON.stringify(stage.getBoundingClientRect());
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(stage.isConnected && stage.closest('.pdf-content-picker').dataset.pickerState === 'ready' && JSON.stringify(stage.getBoundingClientRect()) === before)));
}));
async function ready(page) {
  await page.locator('.content-editor[data-preview-state=ready]').waitFor({ timeout: 60000 });
  // ResizeObserver may schedule one more render after the viewport changes.
  // Trial action waits for an enabled, stable button without committing edits.
  await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).click({ trial: true, timeout: 60000 });
}
// The inline editor stays open on the selector after applying or discarding; Listo returns to the reader.
async function closeEditor(page) {
  await picker(page); await page.getByRole('button', { name: 'Listo', exact: true }).click();
  await page.locator('.workspace-editor').waitFor({ state: 'detached', timeout: 60000 });
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
}
async function apply(page) {
  await ready(page); await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).click();
  await page.locator('.content-editor').waitFor({ state: 'detached', timeout: 60000 }); await closeEditor(page);
}
async function discard(page) {
  await page.getByRole('button', { name: 'Descartar edición', exact: true }).click();
  await page.locator('.content-editor').waitFor({ state: 'detached' }); await closeEditor(page);
}
// The reader's history and download live in the tablet action sheet.
const history = (page, name) => desktopDocumentAction(page, name);
async function canUndo(page, name = 'Deshacer') {
  await page.getByRole('button', { name: 'Más acciones del documento', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Acciones del documento', exact: true }); await dialog.waitFor();
  // The sheet lists the history pair only when there is something to revert.
  const button = dialog.getByRole('button', { name, exact: true }), enabled = await button.count() ? await button.isEnabled() : false;
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  return enabled;
}
async function save(page, name) {
  const download = await tabletDownload(page);
  const target = path.join(output, name); await (await download).saveAs(target);
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  return new Uint8Array(fs.readFileSync(target));
}
async function check(id, action, viewport = { width: 1280, height: 800 }) {
  if (process.env.FOLIO_EDITOR_TEST && !new RegExp(process.env.FOLIO_EDITOR_TEST).test(id)) return;
  const context = await browser.newContext({ ...androidTablet(viewport), acceptDownloads: true }); const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push({ id, message: error.message }));
  try {
    await page.goto(origin);
    assert.equal(await page.locator('script[type="module"][src]').getAttribute('src'), frontendEntry, 'Tested frontend must match the recorded build.');
    await open(page); results.push({ id, status: 'passed', ...await action(page) });
  }
  catch (error) { results.push({ id, status: 'failed', error: error.stack }); process.exitCode = 1; await page.screenshot({ path: path.join(output, `failure-editor-${id}.png`) }); }
  finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
}
try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(origin)).ok) break; } catch {} if (server.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  await check('replacement-preview-move-export-and-one-history-step', async page => {
    await editor(page, 'Reemplazar texto');
    // The selected text starts as the editable value.
    await page.waitForFunction(() => document.querySelector('.content-editor textarea')?.value.includes('ORIGINAL TEXT'));
    await page.getByLabel('Texto', { exact: true }).fill('REPLACED CONTENT');
    await page.getByLabel('Tamaño', { exact: true }).fill('14');
    await page.getByLabel('Color', { exact: true }).fill('#d02020');
    await page.getByLabel('Posición X', { exact: true }).fill('80');
    await page.getByLabel('Posición Y', { exact: true }).fill('200');
    await page.getByLabel('Ancho', { exact: true }).fill('240');
    await page.getByLabel('Alto', { exact: true }).fill('50');
    await ready(page); await page.screenshot({ path: path.join(output, 'content-editor-text-preview.png') });
    await apply(page);
    await history(page, 'Deshacer');
    await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await page.locator('.textLayer span').filter({ hasText: 'ORIGINAL TEXT' }).first().waitFor();
    assert(!await canUndo(page), 'One content commit must have one undo step.');
    await history(page, 'Rehacer'); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await page.locator('.textLayer span').filter({ hasText: 'REPLACED CONTENT' }).first().waitFor();
    const bytes = await save(page, 'editor-replaced.pdf'), strings = text(bytes);
    assert(!strings[0].includes('ORIGINAL TEXT')); assert(strings[0].includes('REPLACED CONTENT')); assert(strings[0].includes('NEIGHBOR TEXT'));
    assert(strings[1].includes('ORIGINAL TEXT')); assert(inspectDocument(bytes).annotations.some(annotation => annotation.text === 'Keep this note'));
    assert(await canUndo(page), 'Saving a copy must preserve editing history.');
    await history(page, 'Deshacer'); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await page.locator('.textLayer span').filter({ hasText: 'ORIGINAL TEXT' }).first().waitFor();
    const restored = await save(page, 'editor-undo-after-save.pdf'); assert.deepEqual(text(restored), text(original));
    assert(await canUndo(page, 'Rehacer'), 'Saving after undo must also preserve redo.');
    assert.equal(digest(fs.readFileSync(source)), digest(original));
    return { realPdfPreview: true, sourceAndDestinationIndependent: true, notePreserved: true, oneUndoStep: true, historySurvivesSave: true, unchangedOriginalFile: true };
  });
  await check('cancel-stale-preview-invalid-draft-and-return-to-tools', async page => {
    await editor(page, 'Añadir texto', [40, 300, 220, 390]);
    await page.getByLabel('Texto', { exact: true }).fill('FIRST DRAFT');
    await page.getByLabel('Texto', { exact: true }).fill('LATEST DRAFT'); await ready(page);
    const latest = await page.locator('.content-preview canvas').evaluate(canvas => canvas.toDataURL());
    await page.getByRole('button', { name: 'Volver a Herramientas', exact: true }).click();
    await page.getByText('Tienes una edición sin aplicar.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Editar PDF', exact: true }).click();
    assert.equal(await page.getByLabel('Texto', { exact: true }).inputValue(), 'LATEST DRAFT'); await ready(page);
    assert.equal(await page.locator('.content-preview canvas').evaluate(canvas => canvas.toDataURL()), latest);
    await page.getByLabel('Tamaño', { exact: true }).fill('200');
    await page.getByLabel('Texto', { exact: true }).fill('TEXT THAT CANNOT FIT INTO THIS BOX');
    await page.locator('.content-editor[data-preview-state=error]').waitFor();
    assert(await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).isDisabled());
    const visibleFailure = page.locator('.content-editor-footer .content-footer-error');
    await visibleFailure.waitFor();
    assert((await visibleFailure.textContent()).includes('El texto no cabe'), 'The actual fit error must be visible in the fixed footer.');
    const failureBounds = await visibleFailure.boundingBox(), screen = page.viewportSize();
    assert(failureBounds && failureBounds.y >= 0 && failureBounds.y + failureBounds.height <= screen.height, 'The footer error must stay inside the viewport.');
    await discard(page);
    assert(!await canUndo(page), 'A discarded draft adds no history step.');
    const bytes = await save(page, 'editor-canceled.pdf'); assert.deepEqual(text(bytes), text(original));
    return { staleResultsDiscarded: true, draftSurvivesTools: true, invalidApplyBlocked: true, canceledDocumentUnchanged: true };
  });
  await check('wrapped-formatted-text-and-latest-draft-export', async page => {
    await editor(page, 'Añadir texto', [40, 300, 220, 435]);
    await page.getByLabel('Texto', { exact: true }).fill('OBSOLETE DRAFT');
    await page.getByLabel('Texto', { exact: true }).fill('Texto final con varias palabras que deben ajustarse dentro de la caja.');
    const semibold = await page.getByLabel('Fuente', { exact: true }).locator('option').filter({ hasText: /Semibold|Seminegrita|Negrita/i }).first().getAttribute('value');
    assert(semibold); await page.getByLabel('Fuente', { exact: true }).selectOption(semibold);
    await page.getByLabel('Tamaño', { exact: true }).fill('16');
    await page.getByLabel('Alineación', { exact: true }).selectOption('center');
    await page.getByLabel('Interlineado', { exact: true }).fill('1.5');
    await page.getByLabel('Ajustar líneas', { exact: true }).check();
    await apply(page); const bytes = await save(page, 'editor-wrapped.pdf'), strings = text(bytes);
    assert(strings[0].replace(/\s+/g, ' ').includes('Texto final con varias palabras')); assert(!strings[0].includes('OBSOLETE'));
    assert.equal(strings[1], text(original)[1]);
    const doc = new mupdf.PDFDocument(bytes), mp = doc.loadPage(0), structured = mp.toStructuredText(); let lineCount = 0, nonDefaultFont = false;
    structured.walk({ beginLine() { lineCount++; }, onChar(char, origin, font) { try { if (/Folio\s*Sans|DMSans|DM\s*Sans/i.test(font.getName())) nonDefaultFont = true; } finally { font.destroy(); } } });
    structured.destroy(); mp.destroy(); doc.destroy(); assert(lineCount > 3); assert(nonDefaultFont);
    return { wrappedExport: true, selectedFontExported: true, latestDraftOnly: true, otherPageUnchanged: true };
  });
  await check('image-preview-proportions-drag-resize-and-export', async page => {
    await editor(page, 'Añadir imagen', [40, 300, 240, 455]);
    await page.locator('.content-editor input[type=file]').setInputFiles(imageFile);
    assert.equal(await page.getByLabel('Ajuste de imagen', { exact: true }).inputValue(), 'contain');
    await ready(page); const box = await page.locator('.content-box[data-role=destination]').boundingBox(); assert(box);
    const xBefore = Number(await page.getByLabel('Posición X', { exact: true }).inputValue());
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 - 15, { steps: 8 }); await page.mouse.up();
    assert(Number(await page.getByLabel('Posición X', { exact: true }).inputValue()) > xBefore + 5);
    const handle = await page.locator('.content-box-handle[data-handle=se]').boundingBox(); assert(handle);
    const widthBefore = Number(await page.getByLabel('Ancho', { exact: true }).inputValue());
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 20, handle.y + handle.height / 2 + 20, { steps: 6 }); await page.mouse.up();
    assert(Number(await page.getByLabel('Ancho', { exact: true }).inputValue()) > widthBefore + 5);
    await page.getByLabel('Opacidad', { exact: true }).fill('60');
    await page.getByLabel('Rotación', { exact: true }).selectOption('90'); await ready(page);
    await page.screenshot({ path: path.join(output, 'content-editor-image-preview.png') });
    await apply(page); const bytes = await save(page, 'editor-image.pdf');
    assert.deepEqual(text(bytes), text(original)); const doc = new mupdf.PDFDocument(bytes), mp = doc.loadPage(0), pixmap = mp.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const pixels = pixmap.getPixels(); let colored = 0;
    for (let index = 0; index < pixels.length; index += 3) if (pixels[index] > 200 && pixels[index + 1] > 50 && pixels[index + 1] < 180 && pixels[index + 2] > 50 && pixels[index + 2] < 180) colored++;
    pixmap.destroy(); mp.destroy(); doc.destroy(); assert(colored > 100);
    return { defaultPreservesAspect: true, dragAndResize: true, actualOpacityAndRotation: true, originalTextPreserved: true };
  });
  await check('replace-image-clears-original-region-and-keeps-neighbors', async page => {
    await open(page, imageSource); await editor(page, 'Reemplazar imagen');
    await page.locator('.content-editor input[type=file]').setInputFiles(imageFile);
    await page.getByLabel('Bloquear proporción', { exact: true }).uncheck();
    await page.getByLabel('Ancho', { exact: true }).fill('100');
    await page.getByLabel('Alto', { exact: true }).fill('80');
    await page.getByLabel('Posición X', { exact: true }).fill('260');
    await page.getByLabel('Posición Y', { exact: true }).fill('300');
    await page.getByLabel('Ajuste de imagen', { exact: true }).selectOption('cover'); await apply(page);
    const bytes = await save(page, 'editor-replaced-image.pdf'); assert.deepEqual(text(bytes), text(original));
    const doc = new mupdf.PDFDocument(bytes), mp = doc.loadPage(0), pixmap = mp.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false), pixels = pixmap.getPixels(), width = pixmap.getWidth();
    const pixel = (x, y) => Array.from(pixels.slice((y * width + x) * 3, (y * width + x) * 3 + 3));
    assert(pixel(70, 380).every(value => value > 245), 'The image at the source must disappear.');
    assert(pixel(270, 330)[0] > 230 && pixel(270, 330)[1] < 30, 'The replacement must appear at the moved destination.');
    pixmap.destroy(); mp.destroy(); doc.destroy();
    return { sourceRemoved: true, destinationMoved: true, neighboringTextPreserved: true };
  });
  await check('corrupt-image-cannot-apply-previous-image', async page => {
    await editor(page, 'Añadir imagen', [40, 300, 240, 450]);
    await page.locator('.content-editor input[type=file]').setInputFiles(imageFile); await ready(page);
    await page.locator('.content-editor input[type=file]').setInputFiles({ name: 'corrupt.png', mimeType: 'image/png', buffer: Buffer.from('invalid image bytes') });
    await page.locator('.content-editor[data-preview-state=error]').waitFor();
    assert(await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).isDisabled());
    await page.locator('.content-editor input[type=file]').setInputFiles(imageFile); await ready(page);
    await discard(page);
    assert(!await canUndo(page), 'A discarded draft adds no history step.');
    return { corruptImageBlocked: true, validImageRecovery: true, canceledWithoutMutation: true };
  });
  await check('delayed-image-loading-does-not-restore-stale-position', async page => {
    await editor(page, 'Añadir imagen', [40, 300, 240, 450]);
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () {
        if (this.name === 'content-editor-image.png') {
          globalThis.__editorImageReading = true;
          await new Promise(resolve => { globalThis.__resumeEditorImage = resolve; });
        }
        return original.call(this);
      };
    });
    await page.locator('.content-editor input[type=file]').setInputFiles(imageFile);
    await page.waitForFunction(() => globalThis.__editorImageReading);
    const xInput = page.getByLabel('Posición X', { exact: true }), blocked = await xInput.isDisabled();
    const before = Number(await xInput.inputValue());
    if (blocked) {
      const box = await page.locator('.content-box[data-role=destination]').boundingBox(); assert(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
      assert.equal(Number(await xInput.inputValue()), before, 'A loading lock must also block pointer movement.');
    } else {
      await xInput.fill('160'); await page.getByLabel('Rotación', { exact: true }).selectOption('90');
    }
    assert(await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).isDisabled());
    await page.evaluate(() => globalThis.__resumeEditorImage()); await ready(page);
    if (blocked) assert.equal(Number(await xInput.inputValue()), before);
    else { assert(Number(await xInput.inputValue()) >= 159); assert.equal(await page.getByLabel('Rotación', { exact: true }).inputValue(), '90'); }
    await discard(page);
    return { uploadRaceGuarded: true, pointerOrLatestPositionPreserved: true, configurationLockedDuringUpload: blocked };
  });
  await check('rotated-cropped-page-box-mapping-and-short-window-footer', async page => {
    await open(page, rotatedSource); const painted = [];
    for (const [index, angle] of rotations.entries()) {
      await page.setViewportSize({ width: 1280, height: 800 });
      const number = index + 1, width = angle % 180 ? crop[3] - crop[1] : crop[2] - crop[0], height = angle % 180 ? crop[2] - crop[0] : crop[3] - crop[1];
      await editor(page, 'Añadir texto', [90, 80, 310, 170], number);
      await page.getByLabel('Texto', { exact: true }).fill('ROTATED NEW TEXT ' + angle);
      await page.getByLabel('Color', { exact: true }).fill('#ff00ff');
      await page.getByLabel('Posición X', { exact: true }).fill('120');
      await page.getByLabel('Posición Y', { exact: true }).fill('100');
      await page.getByLabel('Ancho', { exact: true }).fill('240');
      await page.getByLabel('Alto', { exact: true }).fill('80'); await ready(page);
      const canvas = await page.locator('.content-preview canvas').boundingBox(), box = await page.locator('.content-box[data-role=destination]').boundingBox(); assert(canvas && box);
      assert(Math.abs((box.x - canvas.x) / canvas.width * width - 120) < 2);
      assert(Math.abs((box.y - canvas.y) / canvas.height * height - 100) < 2);
      const previewInk = await page.locator('.content-preview canvas').evaluate((canvas, dimensions) => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0, left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const offset = (y * canvas.width + x) * 4;
          if (pixels[offset] > 200 && pixels[offset + 1] < 150 && pixels[offset + 2] > 200 && pixels[offset] - pixels[offset + 1] > 80 && pixels[offset + 2] - pixels[offset + 1] > 80) { count++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1); }
        }
        return { count, left: left / canvas.width * dimensions.width, top: top / canvas.height * dimensions.height, right: right / canvas.width * dimensions.width, bottom: bottom / canvas.height * dimensions.height };
      }, { width, height });
      await page.screenshot({ path: path.join(output, 'content-editor-rotated-preview-' + angle + '.png') });
      assert(previewInk.count > 10 && previewInk.right - previewInk.left > 50 && previewInk.bottom - previewInk.top > 3, 'Preview must paint actual text ink across a meaningful glyph span, not merely retain extractable text: ' + JSON.stringify({ angle, previewInk }));
      assert(previewInk.left >= 118 && previewInk.top >= 98 && previewInk.right <= 362 && previewInk.bottom <= 182, 'Preview text ink must be inside the destination box: ' + JSON.stringify({ angle, previewInk }));
      // A tablet window shortened by the keyboard or split screen.
      await page.setViewportSize({ width: 1280, height: 600 }); await ready(page);
      const applyBounds = await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).boundingBox(), cancelBounds = await page.getByRole('button', { name: 'Descartar edición', exact: true }).boundingBox();
      assert(applyBounds && cancelBounds && applyBounds.y + applyBounds.height <= 600 && cancelBounds.y + cancelBounds.height <= 600);
      await apply(page); const bytes = await save(page, 'editor-rotated-' + angle + '.pdf'); assert(text(bytes)[index].includes('ROTATED NEW TEXT ' + angle));
      const doc = new mupdf.PDFDocument(bytes), pdfPage = doc.loadPage(index), pixmap = pdfPage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
      try {
        assert.equal(doc.findPage(index).getInheritable('Rotate').asNumber(), angle);
        const pixels = pixmap.getPixels(), rasterWidth = pixmap.getWidth();
        let count = 0, left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (let y = 0; y < pixmap.getHeight(); y++) for (let x = 0; x < rasterWidth; x++) {
          const offset = (y * rasterWidth + x) * 3;
          if (pixels[offset] > 200 && pixels[offset + 1] < 150 && pixels[offset + 2] > 200 && pixels[offset] - pixels[offset + 1] > 80 && pixels[offset + 2] - pixels[offset + 1] > 80) { count++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1); }
        }
        const exportInk = { count, left, top, right, bottom };
        assert(count > 10 && right - left > 50 && bottom - top > 3, 'The saved PDF must also paint the inserted text across a meaningful glyph span: ' + JSON.stringify({ angle, exportInk }));
        assert(left >= 118 && top >= 98 && right <= 362 && bottom <= 182, 'Export text must be inside the destination box: ' + JSON.stringify({ angle, exportInk }));
        for (const edge of ['left', 'top', 'right', 'bottom']) assert(Math.abs(previewInk[edge] - exportInk[edge]) < 3, 'Preview and saved glyph bounds must agree: ' + JSON.stringify({ angle, previewInk, exportInk }));
        painted.push({ angle, previewInk, exportInk });
      } finally { pixmap.destroy(); pdfPage.destroy(); doc.destroy(); }
    }
    return { cropAndRotationMapped: true, shortWindowButtonsVisible: true, actualRotatedPdfExport: true, paintedTextInsideDestination: true, previewAndExportAgree: true, painted };
  });
} finally {
  await browser?.close(); server.kill();
  fs.writeFileSync(path.join(output, 'content-editor-ui-results.json'), JSON.stringify({ frontendEntry, results, errors }, null, 2) + '\n');
  if (errors.length) { console.log(JSON.stringify({ errors })); process.exitCode = 1; }
}
