import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { operateDocument } from '../../src/engine/operations.mjs';

const root = process.cwd(), output = path.join(root, 'test-results'); fs.mkdirSync(output, { recursive: true });
const fixture = await PDFDocument.create(), font = await fixture.embedFont(StandardFonts.Helvetica);
const first = fixture.addPage([500, 400]);
first.drawText('FIRST LINE\nSECOND LINE', { x: 40, y: 300, size: 16, lineHeight: 20, font });
const crop = [2.83466, 65.1969, 482.685, 575.325], rotated = fixture.addPage([485.52, 578.16]);
rotated.setCropBox(crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1]); rotated.setRotation(degrees(90));
rotated.drawText('CROPPED LABEL', { x: 90, y: 420, size: 18, font, color: rgb(1, 0, 1) });
const third = fixture.addPage([500, 400]), picture = await PDFDocument.create(), tile = picture.addPage([100, 50]);
tile.drawRectangle({ x: 0, y: 0, width: 100, height: 50, color: rgb(.1, .65, .2) });
const pictureDoc = new mupdf.PDFDocument(await picture.save()), picturePage = pictureDoc.loadPage(0), pixmap = picturePage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
const image = await fixture.embedPng(new Uint8Array(pixmap.asPNG())); pixmap.destroy(); picturePage.destroy(); pictureDoc.destroy();
third.drawImage(image, { x: 70, y: 130, width: 210, height: 105 });
const fourth = fixture.addPage([500, 400]); fourth.drawRectangle({ x: 40, y: 240, width: 225, height: 20, color: rgb(.8, .8, .8) });
const bytes = operateDocument(await fixture.save(), { operation: 'ocr', pages: [{ page: 4, words: [{ text: 'INVISIBLE OCR SAMPLE', rect: [40, 240, 265, 260] }] }] });
const source = path.join(output, 'pdf-content-picker-source.pdf'); fs.writeFileSync(source, bytes);
const oracle = [1, 2, 3, 4].map(page => operateDocument(bytes, { operation: 'page-content', page }));
const nativeGeometry = new mupdf.PDFDocument(bytes), rotatedPage = nativeGeometry.loadPage(1);
const transform = rotatedPage.getTransform(), rotatedBounds = rotatedPage.getBounds(); rotatedPage.destroy(); nativeGeometry.destroy();
const chrome = findChrome(); assert(chrome);
const port = process.env.FOLIO_PICKER_UI_PORT || '4253', origin = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { windowsHide: true, stdio: 'pipe' });
let browser, log = '', frontendEntry; const results = [], errors = [];
server.stdout.on('data', value => { log += value; }); server.stderr.on('data', value => { log += value; });
const iphoneAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
async function picker(page, number = 1) {
  await page.locator(`.pdf-content-picker[data-page="${number}"][data-picker-state="ready"]`).waitFor({ timeout: 60000 });
  const width = number === 2 ? rotatedBounds[2] - rotatedBounds[0] : 500, height = number === 2 ? rotatedBounds[3] - rotatedBounds[1] : 400;
  await page.waitForFunction(({ number, width, height }) => {
    const picker = document.querySelector('.pdf-content-picker'); if (picker?.dataset.page !== String(number) || picker.dataset.pickerState !== 'ready') return false;
    if (picker.querySelector('[aria-label="Ajustar página"]').getAttribute('aria-pressed') !== 'true') return true;
    const host = picker.querySelector('.pdf-picker-viewport'), style = getComputedStyle(host), canvas = picker.querySelector('canvas').getBoundingClientRect();
    const scale = Math.max(.05, Math.min((host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / width, (host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / height, 3));
    return Math.abs(canvas.width - width * scale) < 1 && Math.abs(canvas.height - height * scale) < 1;
  }, { number, width, height }, { timeout: 60000 });
}
async function open(page, phone) {
  await page.goto(origin); await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(source);
  await page.locator('.loading-overlay').waitFor({ state: 'detached' }); await page.locator('.reading-area .textLayer span').first().waitFor();
  if (phone) await page.getByRole('button', { name: 'Más acciones', exact: true }).tap();
  await page.getByRole('button', { name: 'Herramientas', exact: true }).click(); await page.getByRole('button', { name: 'Editar PDF', exact: true }).click();
  await page.locator('.pdf-content-picker[data-picker-state="ready"]').waitFor({ timeout: 60000 });
  // On a phone the reader may legitimately identify the second visible page.
  // Navigate explicitly so each fixture assertion starts at a known page.
  if (await page.locator('.pdf-content-picker').getAttribute('data-page') !== '1') await navigate(page, 1);
  await picker(page);
}
async function navigate(page, number) { await page.getByRole('spinbutton', { name: 'Página del editor', exact: true }).fill(String(number)); await page.getByRole('spinbutton', { name: 'Página del editor', exact: true }).press('Enter'); await picker(page, number); }
async function check(id, run, specification = { width: 1360, height: 720 }) {
  if (process.env.FOLIO_PICKER_TEST && !new RegExp(process.env.FOLIO_PICKER_TEST).test(id)) return;
  const { phone = false, width, height } = specification;
  const context = await browser.newContext({ viewport: { width, height }, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: iphoneAgent } : {}) });
  if (phone) await context.addInitScript(() => { Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' }); Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: undefined }); });
  const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push({ id, message: error.message }));
  try { await open(page, phone); results.push({ id, status: 'passed', frontendEntry, ...await run(page) }); }
  catch (error) { results.push({ id, status: 'failed', frontendEntry, error: error.stack }); process.exitCode = 1; await page.screenshot({ path: path.join(output, 'failure-picker-' + id + '.png') }); }
  finally { console.log(JSON.stringify(results.at(-1))); await context.close(); }
}
async function layout(page, specification) {
  await picker(page);
  // Read the ready state and geometry in one frame: a resize observer may start
  // another render between a separate readiness wait and an evaluate call.
  const geometryHandle = await page.waitForFunction(({ baseWidth, baseHeight }) => {
    const element = document.querySelector('.pdf-content-picker');
    if (element?.dataset.pickerState !== 'ready') return false;
    const rect = node => { const bounds = node.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom, overflowX: node.scrollWidth - node.clientWidth }; };
    const container = element.closest('.workspace-editor,dialog'), phone = document.documentElement.hasAttribute('data-phone');
    // Measure the settled layout: a sheet still sliding in is offset by its animation.
    if (container?.getAnimations().some(animation => animation.playState === 'running')) return false;
    const canvas = rect(element.querySelector('canvas'));
    if (!canvas.width || !canvas.height || getComputedStyle(element.querySelector('.pdf-picker-stage')).visibility === 'hidden') return false;
    if (element.querySelector('[aria-label="Ajustar página"]').getAttribute('aria-pressed') === 'true') {
      const host = element.querySelector('.pdf-picker-viewport'), style = getComputedStyle(host);
      const scale = Math.max(.05, Math.min((host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / baseWidth, (host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / baseHeight, 3));
      if (Math.abs(canvas.width - baseWidth * scale) >= 1 || Math.abs(canvas.height - baseHeight * scale) >= 1) return false;
    }
    const navigation = container.querySelector('.workbench-navigation'), controls = [...navigation.querySelectorAll('button')].map(button => button.getBoundingClientRect()), centers = controls.map(box => (box.top + box.bottom) / 2);
    return { width: innerWidth, height: innerHeight, phone, inlineWorkspace: container.classList.contains('workspace-editor'), header: rect(document.querySelector('.app-header')), openDialogs: document.querySelectorAll('dialog[open]').length, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, container: rect(container), picker: rect(element), toolbar: rect(element.querySelector('.pdf-picker-toolbar')), viewport: rect(element.querySelector('.pdf-picker-viewport')), canvas: rect(element.querySelector('canvas')), footer: rect(element.querySelector('.pdf-picker-footer')), navigationHeight: navigation.getBoundingClientRect().height, navigationControlHeight: Math.max(...controls.map(box => box.height)), navigationCenterSpread: Math.max(...centers) - Math.min(...centers) };
  }, { baseWidth: 500, baseHeight: 400 }, { timeout: 60000 });
  const geometry = await geometryHandle.jsonValue(); await geometryHandle.dispose();
  assert.equal(geometry.phone, !!specification.phone); assert.equal(geometry.documentWidth, geometry.width); assert.equal(geometry.documentHeight, geometry.height);
  if (!specification.phone) {
    assert.equal(geometry.inlineWorkspace, true, 'Desktop editing must stay in the main reader.');
    assert.equal(geometry.openDialogs, 0);
    assert(geometry.header.height >= 40 && geometry.container.y >= geometry.header.bottom - 1, 'The app header must remain visible above the integrated editor.');
    assert.equal(await page.locator('.app-header .document-tab-strip').isVisible(), true);
    assert(geometry.navigationCenterSpread <= 1 && geometry.navigationHeight <= geometry.navigationControlHeight + 1, 'Desktop navigation must stay in one row without taking height from the page.');
  }
  for (const [name, bounds] of Object.entries(geometry).filter(([name]) => ['container', 'picker', 'toolbar', 'viewport', 'canvas', 'footer'].includes(name))) {
    assert(bounds.width > 0 && bounds.height > 0, name + ' needs usable space.');
    assert(bounds.x >= -.5 && bounds.y >= -.5 && bounds.right <= geometry.width + .5 && bounds.bottom <= geometry.height + .5, name + ' must remain in the window: ' + JSON.stringify(bounds));
    assert(bounds.overflowX <= 1, name + ' must not overflow horizontally at Fit.');
  }
  assert(geometry.viewport.bottom <= geometry.footer.y + 1, 'Footer must follow the canvas without clipping.');
  assert(geometry.canvas.height >= (specification.height < 500 ? 120 : 200), 'The page must have practical viewing space, not merely fit in the dialog: ' + geometry.canvas.height);
  const fields = await page.locator('.pdf-picker-pagination>input,.pdf-picker-level>select').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element), number = property => parseFloat(style[property]) || 0;
    return { label: element.getAttribute('aria-label'), height: element.getBoundingClientRect().height, fontSize: number('fontSize'), contentHeight: element.getBoundingClientRect().height - number('paddingTop') - number('paddingBottom') - number('borderTopWidth') - number('borderBottomWidth') };
  }));
  for (const field of fields) assert(field.contentHeight >= field.fontSize * 1.2, 'Toolbar field must have enough inner height to display its text: ' + JSON.stringify(field));
  for (const name of ['Seleccionar', 'Añadir texto', 'Añadir imagen', '100 %', 'Página siguiente del editor', 'Listo']) {
    const button = page.getByRole('button', { name, exact: true });
    assert(await button.evaluate(element => { const bounds = element.getBoundingClientRect(); return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === element; }), name + ' must be reachable.');
  }
  assert.equal(await page.locator('.modified-dot').count(), 0, 'Selecting and rendering must not modify the document.');
  return { ...geometry, fields };
}
try {
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(origin)).ok) { started = true; break; } } catch {} if (server.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert(started, log || 'Preview did not start.'); frontendEntry = (await (await fetch(origin)).text()).match(/src="([^"]+\.js)"/)?.[1];
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  await check('levels-zoom-pagination-and-contained-pan', async page => {
    const paragraphs = oracle[0].items.filter(item => item.kind === 'text' && item.level === 'paragraph'), lines = oracle[0].items.filter(item => item.kind === 'text' && item.level === 'line');
    assert(paragraphs.length && lines.length > paragraphs.length, 'Fixture needs a multi-line paragraph.');
    assert.equal(await page.locator('.pdf-content-item[data-kind="text"]').count(), paragraphs.length);
    await page.getByRole('combobox', { name: 'Seleccionar texto por', exact: true }).selectOption('line');
    assert.equal(await page.locator('.pdf-content-item[data-kind="text"]').count(), lines.length);
    assert.equal(await page.locator('.pdf-content-item[data-level="paragraph"]').count(), 0);
    await page.getByRole('button', { name: '100 %', exact: true }).click(); await picker(page);
    const nativeWidth = (await page.locator('.pdf-content-picker canvas').boundingBox()).width; assert(Math.abs(nativeWidth - 500) < 1);
    await page.getByRole('button', { name: 'Acercar página del editor', exact: true }).click(); await picker(page);
    assert(Math.abs((await page.locator('.pdf-content-picker canvas').boundingBox()).width - 625) < 1);
    for (let index = 0; index < 5; index++) { await page.getByRole('button', { name: 'Acercar página del editor', exact: true }).click(); await picker(page); }
    const pan = await page.locator('.pdf-picker-viewport').evaluate(element => { const container = element.closest('.workspace-editor,dialog'); return { scrollWidth: element.scrollWidth, width: element.clientWidth, containerOverflow: container.scrollWidth - container.clientWidth, bodyOverflow: document.documentElement.scrollWidth - innerWidth }; });
    assert(pan.scrollWidth > pan.width + 100); assert(pan.containerOverflow <= 1 && pan.bodyOverflow <= 1);
    await page.getByRole('button', { name: 'Ajustar página', exact: true }).click(); await picker(page);
    await page.getByRole('button', { name: 'Página siguiente del editor', exact: true }).click(); await picker(page, 2);
    await page.getByRole('button', { name: 'Página anterior del editor', exact: true }).click(); await picker(page, 1);
    return { paragraphs: paragraphs.length, lines: lines.length, scale100Width: nativeWidth, intentionalPanContained: true, pagination: true };
  });
  await check('crop-rotate90-overlay-contains-painted-glyph', async page => {
    await navigate(page, 2);
    const item = oracle[1].items.find(item => item.level === 'paragraph' && item.text?.includes('CROPPED LABEL')); assert(item);
    const marker = page.locator(`[data-content-id="${item.id}"]`), stage = await page.locator('.pdf-picker-stage').boundingBox(), actual = await marker.boundingBox(); assert(stage && actual);
    const expected = mupdf.Rect.transform(item.rect, transform), width = rotatedBounds[2] - rotatedBounds[0], height = rotatedBounds[3] - rotatedBounds[1];
    const edges = [actual.x - stage.x, actual.y - stage.y, actual.x + actual.width - stage.x, actual.y + actual.height - stage.y];
    const scale = stage.width / width;
    for (let index = 0; index < 4; index++) assert(Math.abs(edges[index] - expected[index] * scale) < 1, 'Overlay must match the PDF transform: ' + JSON.stringify({ edges, expected, scale }));
    assert(Math.abs(stage.height / height - scale) < .005);
    const ink = await page.locator('.pdf-content-picker canvas').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let count = 0, left = Infinity, top = Infinity, right = 0, bottom = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) { const index = (y * canvas.width + x) * 4;
        if (data[index] > 200 && data[index + 1] < 150 && data[index + 2] > 200 && data[index] - data[index + 1] > 80 && data[index + 2] - data[index + 1] > 80) { count++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
      }
      const bounds = canvas.getBoundingClientRect(); return { count, edges: [left / canvas.width * bounds.width, top / canvas.height * bounds.height, right / canvas.width * bounds.width, bottom / canvas.height * bounds.height] };
    });
    assert(ink.count > 20); assert(ink.edges[0] >= edges[0] - 3 && ink.edges[1] >= edges[1] - 3 && ink.edges[2] <= edges[2] + 3 && ink.edges[3] <= edges[3] + 3, 'Painted glyphs must lie inside the clickable overlay.');
    await page.screenshot({ path: path.join(output, 'pdf-content-picker-crop-90.png') });
    // Rotated text cannot be edited as text; its region can still be replaced.
    assert(!item.editable && item.areaReplaceable); await page.mouse.click(actual.x + actual.width / 2, actual.y + actual.height / 2);
    await page.getByRole('button', { name: 'Reemplazar esta zona', exact: true }).click(); const editor = page.locator('.content-editor'); await editor.waitFor();
    assert.equal(await editor.getAttribute('data-kind'), 'replace-text'); assert.equal(await editor.getAttribute('data-selected'), 'false');
    (await editor.getAttribute('data-source-rect')).split(',').map(Number).forEach((value, index) => assert(Math.abs(value - item.rect[index]) < .01));
    // The area's own text can start the replacement.
    await page.getByRole('button', { name: 'Usar texto del área', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.content-editor textarea')?.value.includes('CROPPED LABEL'));
    return { crop, rotation: 90, paintedGlyphPixels: ink.count, transformAligned: true, editable: item.editable, areaReplacementOpened: true, areaTextSuggested: true };
  });
  await check('drawing-text-and-image-uses-crop-pdf-coordinates', async page => {
    await navigate(page, 2);
    const width = rotatedBounds[2] - rotatedBounds[0], height = rotatedBounds[3] - rotatedBounds[1];
    const expected = mupdf.Rect.transform([width * .2, height * .25, width * .6, height * .45], mupdf.Matrix.invert(transform));
    for (const [label, kind] of [['Añadir texto', 'add-text'], ['Añadir imagen', 'add-image']]) {
      await page.getByRole('button', { name: label, exact: true }).click(); const stage = await page.locator('.pdf-picker-stage').boundingBox(); assert(stage);
      await page.mouse.move(stage.x + stage.width * .2, stage.y + stage.height * .25); await page.mouse.down(); await page.mouse.move(stage.x + stage.width * .6, stage.y + stage.height * .45, { steps: 8 }); await page.mouse.up();
      await page.locator(`.content-editor[data-kind="${kind}"]`).waitFor();
      const rect = (await page.locator('.content-editor').getAttribute('data-source-rect')).split(',').map(Number);
      for (let index = 0; index < 4; index++) assert(Math.abs(rect[index] - expected[index]) < 2, 'Drawn area must use original rotated/cropped PDF coordinates.');
      assert.equal(await page.locator('.content-preview canvas').getAttribute('aria-label'), 'Vista previa de la página 2');
      await page.getByRole('button', { name: 'Descartar edición', exact: true }).click(); await picker(page, 2);
    }
    // From the keyboard, adding opens the editor on a centred area instead of waiting for a drag.
    await page.getByRole('button', { name: 'Añadir texto', exact: true }).press('Enter'); await page.locator('.content-editor[data-kind="add-text"]').waitFor();
    // The band is centred as the page is shown, so it stays wide on this /Rotate 90 page.
    const centred = mupdf.Rect.transform([width * .25, height * .425, width * .75, height * .575], mupdf.Matrix.invert(transform));
    const keyboardRect = (await page.locator('.content-editor').getAttribute('data-source-rect')).split(',').map(Number);
    for (let index = 0; index < 4; index++) assert(Math.abs(keyboardRect[index] - centred[index]) < 2, `Keyboard area must be a horizontal band on the shown page: ${keyboardRect} vs ${centred}.`);
    await page.getByRole('button', { name: 'Descartar edición', exact: true }).click(); await picker(page, 2);
    return { addText: true, addImage: true, originalPdfCoordinates: true, keyboardAddsCentredArea: true, page: 2 };
  });
  await check('image-selection-keeps-original-source-region', async page => {
    await navigate(page, 3); const item = oracle[2].items.find(item => item.kind === 'image' && item.editable); assert(item);
    await page.locator(`[data-content-id="${item.id}"]`).click(); await page.locator('.content-editor[data-kind="replace-image"]').waitFor();
    const rect = (await page.locator('.content-editor').getAttribute('data-source-rect')).split(',').map(Number);
    for (let index = 0; index < 4; index++) assert(Math.abs(rect[index] - item.rect[index]) < .01);
    assert.equal(await page.locator('.content-preview canvas').getAttribute('aria-label'), 'Vista previa de la página 3');
    await page.getByRole('button', { name: 'Descartar edición', exact: true }).click(); await picker(page, 3); return { imageSelected: true, sourceRegionExact: true, page: 3 };
  });
  await check('invisible-ocr-explains-unavailability-without-opening-editor', async page => {
    await navigate(page, 4); const item = oracle[3].items.find(item => item.level === 'paragraph' && item.text?.includes('INVISIBLE OCR SAMPLE')); assert(item && !item.editable && item.reason);
    const button = page.locator(`[data-content-id="${item.id}"]`), bounds = await button.boundingBox(); assert(bounds);
    // aria-disabled correctly describes an unavailable edit action; clicking its
    // region is still allowed to inspect the reason, including with a keyboard.
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    assert.equal(await page.locator('.content-editor').count(), 0); assert((await page.locator('.pdf-picker-footer').innerText()).includes(item.reason));
    assert.equal(await page.locator('.pdf-picker-unavailable[role="alert"]').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Reemplazar esta zona', exact: true }).count(), 0, 'Invisible OCR text offers no area replacement.');
    if (oracle[3].warnings.length) { await page.locator('.pdf-picker-warnings>summary').click(); for (const warning of oracle[3].warnings) assert((await page.locator('.pdf-picker-warnings').innerText()).includes(warning)); }
    await page.screenshot({ path: path.join(output, 'pdf-content-picker-invisible-ocr.png') }); return { unavailableReason: item.reason, noEditAction: true, warningCount: oracle[3].warnings.length };
  });
  for (const specification of [{ width: 800, height: 600 }, { width: 900, height: 600 }, { width: 1024, height: 600 }, { width: 390, height: 844, phone: true }, { width: 430, height: 932, phone: true }, { width: 844, height: 390, phone: true }]) {
    const id = (specification.phone ? 'phone-' : 'desktop-') + specification.width + 'x' + specification.height;
    await check(id, async page => {
      const geometry = await layout(page, specification);
      await page.screenshot({ path: path.join(output, 'pdf-content-picker-' + id + '.png') }); return { geometry, controlsReachable: true, noHorizontalOverflow: true, simulatedPhone: !!specification.phone };
    }, specification);
  }
  await check('resize-medium-keeps-selection-zoom-and-usable-layout', async page => {
    const samples = [];
    for (const width of [900, 800, 1024]) {
      const specification = { width, height: 600 }; await page.setViewportSize(specification); const geometry = await layout(page, specification);
      await page.getByRole('combobox', { name: 'Seleccionar texto por', exact: true }).selectOption('line');
      // A resize can still be publishing its render when the level changes.
      // Wait for the real line targets, rather than count an updating surface.
      const expectedLines = oracle[0].items.filter(item => item.kind === 'text' && item.level === 'line').length;
      await page.waitForFunction(expected => {
        const picker = document.querySelector('.pdf-content-picker');
        return picker?.dataset.pickerState === 'ready' && picker.querySelectorAll('.pdf-content-item[data-kind="text"][data-level="line"]').length === expected;
      }, expectedLines, { timeout: 60000 });
      await picker(page);
      assert.equal(await page.locator('.pdf-content-item[data-kind="text"]').count(), expectedLines);
      samples.push({ width, canvasHeight: geometry.canvas.height });
      await page.screenshot({ path: path.join(output, `pdf-content-picker-resize-${width}x600.png`) });
    }
    return { samples, resizePreservesPage: true, noHorizontalOverflow: true };
  });
} finally {
  await browser?.close(); server.kill();
  fs.writeFileSync(path.join(output, 'pdf-content-picker-ui-results.json'), JSON.stringify({ date: new Date().toISOString(), frontendEntry, results, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}
