import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { operateDocument } from '../../src/engine/operations.mjs';
import { writeAnnotations, inspectDocument } from '../../src/engine/mupdf-engine.mjs';

const root = process.cwd(), output = path.join(root, 'test-results'); fs.mkdirSync(output, { recursive: true });
const fixture = await PDFDocument.create(), font = await fixture.embedFont(StandardFonts.HelveticaBold);
for (let n = 1; n <= 2; n++) {
  const page = fixture.addPage([400, 500]);
  page.drawText('ORIGINAL ' + n, { x: 40, y: 400, size: 16, color: rgb(0, .2, .4), font });
  page.drawText('KEEP NEIGHBOR ' + n, { x: 40, y: 300, size: 14, font });
}
const picture = await PDFDocument.create(), picturePage = picture.addPage([100, 50]);
picturePage.drawRectangle({ x: 0, y: 0, width: 100, height: 50, color: rgb(0, .7, .2) });
const pictureDoc = new mupdf.PDFDocument(await picture.save()), pictureMuPage = pictureDoc.loadPage(0), pixmap = pictureMuPage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
const imageBytes = new Uint8Array(pixmap.asPNG()); pixmap.destroy(); pictureMuPage.destroy(); pictureDoc.destroy();
const imageFile = path.join(output, 'pdf-editing-picture.png'); fs.writeFileSync(imageFile, imageBytes);
let original = operateDocument(await fixture.save(), { operation: 'add-image', page: 1, rect: [40, 150, 140, 250], image: imageBytes, fit: 'stretch' });
original = writeAnnotations(original, [{ id: 'editing-note', page: 1, kind: 'note', rect: [340, 420, 360, 440], color: '#ffcc00', text: 'KEEP NOTE', created: 1 }]);
const source = path.join(output, 'pdf-editing-source.pdf'); fs.writeFileSync(source, original);
const useWebKit = process.env.FOLIO_TEST_BROWSER === 'webkit', browserName = useWebKit ? 'WebKit' : 'Chromium';
const chrome = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
if (!useWebKit) assert(chrome, 'Chrome or Edge is required, or set CHROME_PATH.');
const port = process.env.FOLIO_EDITING_UI_PORT || '4251', origin = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { windowsHide: true, stdio: 'pipe' });
let browser, log = '', frontendEntry; const results = [], errors = [];
server.stdout.on('data', value => { log += value; }); server.stderr.on('data', value => { log += value; });
async function open(page) {
  await page.goto(origin); await page.locator('.app-header input[type=file]').setInputFiles(source);
  await page.getByRole('heading', { name: path.basename(source), exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Herramientas', exact: true }).click();
  await page.getByRole('button', { name: 'Editar PDF', exact: true }).click(); await picker(page);
  await inlineWorkspace(page);
}
async function inlineWorkspace(page) {
  const workspace = page.locator('main.reader .workspace-editor'); await workspace.waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Editing must be integrated in the reader, without an open dialog.');
  assert.equal(await workspace.evaluate(element => element.tagName), 'SECTION');
  assert.equal(await workspace.getAttribute('aria-label'), 'Editar PDF');
  assert.equal(await page.locator('.app-header .document-tab-strip').isVisible(), true, 'Document tabs must remain visible while editing.');
  assert.equal(await page.getByRole('tab', { name: path.basename(source), exact: true }).getAttribute('aria-selected'), 'true');
  const geometry = await workspace.evaluate(element => {
    const bounds = element.getBoundingClientRect(), header = document.querySelector('.app-header').getBoundingClientRect(), main = element.closest('main').getBoundingClientRect();
    const visible = selector => [...document.querySelectorAll(selector)].some(node => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden'; });
    const navigation = element.querySelector('.workbench-navigation').getBoundingClientRect(), controls = [...element.querySelectorAll('.workbench-navigation button')].map(button => button.getBoundingClientRect()), centers = controls.map(box => (box.top + box.bottom) / 2);
    return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, headerBottom: header.bottom, mainTop: main.top, position: getComputedStyle(element).position, width: innerWidth, height: innerHeight, horizontalOverflow: document.documentElement.scrollWidth - innerWidth, readerToolbarVisible: visible('main.reader>.reader-toolbar'), readerVisible: visible('main.reader>.reading-area'), navigationHeight: navigation.height, navigationControlHeight: Math.max(...controls.map(box => box.height)), navigationCenterSpread: Math.max(...centers) - Math.min(...centers) };
  });
  assert.notEqual(geometry.position, 'fixed');
  assert(geometry.top >= geometry.headerBottom - 1 && geometry.top >= geometry.mainTop - 1);
  assert(geometry.bottom <= geometry.height + 1 && geometry.left >= -1 && geometry.right <= geometry.width + 1);
  assert(geometry.horizontalOverflow <= 1);
  assert.equal(geometry.readerToolbarVisible, false, 'Reader and editor toolbars must not compete for the same space.');
  assert.equal(geometry.readerVisible, false, 'The editing surface replaces the reader canvas in the same main pane.');
  assert(geometry.navigationCenterSpread <= 1 && geometry.navigationHeight <= geometry.navigationControlHeight + 1, 'Editor navigation must remain in one row, preserving page height.');
  return geometry;
}
async function picker(page, number = 1) { await page.locator(`.pdf-content-picker[data-page="${number}"][data-picker-state="ready"]`).waitFor({ timeout: 60000 }); }
async function selectText(page, number = 1) { await page.getByRole('button', { name: 'Párrafo: ORIGINAL ' + number, exact: true }).click(); await page.locator('.content-editor').waitFor(); }
async function ready(page) { await page.locator('.content-editor[data-preview-state="ready"]').waitFor({ timeout: 60000 }); }
async function commit(page, number = 1) { await ready(page); await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).click({ trial: true, timeout: 60000 }); await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).click(); await picker(page, number); }
async function save(page, name) { await page.getByRole('button', { name: 'Listo', exact: true }).click(); await page.locator('.workbench').waitFor({ state: 'detached' }); await page.getByRole('button', { name: 'Descargar', exact: true }).click({ trial: true }); const download = page.waitForEvent('download'); void download.catch(() => {}); await page.getByRole('button', { name: 'Descargar', exact: true }).click(); const target = path.join(output, name); await (await download).saveAs(target); await page.locator('.loading-overlay').waitFor({ state: 'detached' }); return new Uint8Array(fs.readFileSync(target)); }
async function check(id, run, viewport = { width: 1360, height: 720 }) {
  if (process.env.FOLIO_EDITING_TEST && !new RegExp(process.env.FOLIO_EDITING_TEST).test(id)) return;
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  if (useWebKit) await context.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: 'macOS' } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push({ id, message: error.message }));
  try { await open(page); results.push({ id, status: 'passed', frontendEntry, inlineWorkspace: true, ...await run(page) }); }
  catch (error) { results.push({ id, status: 'failed', frontendEntry, error: error.stack }); process.exitCode = 1; await page.screenshot({ path: path.join(output, 'failure-editing-' + id + '.png') }); }
  finally { console.log(JSON.stringify(results.at(-1))); await context.close(); }
}
try {
  for (let n = 0; n < 100; n++) { try { if ((await fetch(origin)).ok) break; } catch {} if (server.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 100)); }
  frontendEntry = (await (await fetch(origin)).text()).match(/src="([^"]+\.js)"/)?.[1];
  assert(frontendEntry, 'The report must identify the tested frontend build.');
  browser = useWebKit ? await webkit.launch({ headless: true }) : await chromium.launch({ executablePath: chrome, headless: true });
  await check('direct-selection-continuous-history', async page => {
    await selectText(page);
    assert.equal(await page.getByRole('textbox', { name: 'Texto', exact: true }).inputValue(), 'ORIGINAL 1');
    assert.equal(await page.getByRole('combobox', { name: 'Fuente', exact: true }).inputValue(), 'Helvetica-Bold');
    assert.equal(Number(await page.getByRole('spinbutton', { name: 'Tamaño', exact: true }).inputValue()), 16);
    assert.equal(await page.getByLabel('Color', { exact: true }).inputValue(), '#003366');
    await ready(page); assert.equal(await page.locator('.content-footer-status').innerText(), 'Sin cambios.');
    assert(await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).isDisabled(), 'Selecting text alone must not offer to rewrite it.');
    await page.getByRole('textbox', { name: 'Texto', exact: true }).fill('EDITED 1'); await commit(page);
    await page.getByRole('button', { name: 'Página siguiente del editor', exact: true }).click(); await picker(page, 2);
    await selectText(page, 2); await page.getByRole('textbox', { name: 'Texto', exact: true }).fill('EDITED 2'); await commit(page, 2);
    await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
    // History restores the recorded reading page; the first edit remains.
    await page.locator('.pdf-content-picker[data-picker-state="ready"]').waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: 'Rehacer', exact: true }).click(); await picker(page, 2);
    const bytes = await save(page, 'pdf-editing-continuous.pdf'), texts = operateDocument(bytes, { operation: 'text' });
    assert(texts[0].includes('EDITED 1') && texts[1].includes('EDITED 2')); assert(!texts.join('').includes('ORIGINAL'));
    assert(texts[0].includes('KEEP NEIGHBOR 1') && texts[1].includes('KEEP NEIGHBOR 2'));
    assert(inspectDocument(bytes).annotations.some(note => note.text === 'KEEP NOTE'));
    return { autoStyle: true, twoPageEdits: true, keptEditing: true, undoRedo: true, neighborsAndNote: true };
  });
  await check('cancel-zoom-and-frame', async page => {
    await selectText(page); await page.getByRole('button', { name: 'Al área', exact: true }).click(); await ready(page);
    assert(Number(await page.locator('.content-zoom-controls>span').innerText().then(value => value.replace('%', ''))) > 100);
    await page.getByRole('textbox', { name: 'Texto', exact: true }).fill('DISCARD THIS');
    await page.getByRole('button', { name: 'Restablecer', exact: true }).click(); await ready(page);
    assert.equal(await page.getByRole('textbox', { name: 'Texto', exact: true }).inputValue(), 'ORIGINAL 1', 'Reset restores the selected source draft without modifying the document.');
    await page.getByRole('textbox', { name: 'Texto', exact: true }).fill('DISCARD THIS');
    await page.getByRole('button', { name: 'Descartar edición', exact: true }).click(); await picker(page);
    await page.locator('.pdf-content-item[data-kind="image"][data-editable="true"]').first().click();
    const before = await page.locator('.content-editor').getAttribute('data-destination-rect');
    await page.getByLabel('Imagen PNG o JPEG', {exact:true}).setInputFiles(imageFile); await ready(page);
    assert.equal(await page.locator('.content-editor').getAttribute('data-destination-rect'), before, 'Uploading a different aspect ratio preserves the chosen frame');
    await page.getByRole('button', { name: 'Descartar edición', exact: true }).click(); await picker(page);
    const bytes = await save(page, 'pdf-editing-cancel.pdf'); assert.deepEqual(operateDocument(bytes, { operation: 'text' }), operateDocument(original, { operation: 'text' }));
    return { zoomAtArea: true, resetRestoresSourceDraft: true, cancelledDraftUnchanged: true, imageFramePreserved: true };
  });
  await check('return-from-tools-keeps-draft', async page => {
    await selectText(page); await ready(page);
    await page.getByRole('textbox', { name: 'Texto', exact: true }).fill('DRAFT 1');
    const frame = await page.locator('.content-editor').getAttribute('data-destination-rect');
    await page.getByRole('button', { name: 'Volver a Herramientas', exact: true }).click();
    await page.getByRole('button', { name: 'Editar PDF', exact: true }).click(); await ready(page);
    assert.equal(await page.getByRole('textbox', { name: 'Texto', exact: true }).inputValue(), 'DRAFT 1');
    assert.equal(await page.locator('.content-editor').getAttribute('data-destination-rect'), frame);
    await commit(page);
    const bytes = await save(page, 'pdf-editing-return-from-tools.pdf');
    assert(operateDocument(bytes, { operation: 'text' })[0].includes('DRAFT 1'));
    return { editorReopens: true, draftAndFramePreserved: true, committedDraft: true };
  });
  await check('low-height-editor-actions', async page => {
    await selectText(page); await ready(page);
    const metrics = await page.locator('.workspace-editor').evaluate(workspace => {
      const apply = workspace.querySelector('.content-editor-footer .primary-button').getBoundingClientRect(), preview = workspace.querySelector('.content-preview').getBoundingClientRect();
      return { applyBottom: apply.bottom, visibleHeight: innerHeight, previewHeight: preview.height, horizontalOverflow: workspace.scrollWidth - workspace.clientWidth };
    });
    assert(metrics.applyBottom <= metrics.visibleHeight - 8); assert(metrics.horizontalOverflow <= 1); assert(metrics.previewHeight >= 200);
    await inlineWorkspace(page);
    await page.screenshot({ path: path.join(output, 'pdf-editing-low-height.png') }); return metrics;
  }, { width: 1024, height: 600 });
  await check('move-original-image-without-upload', async page => {
    await page.locator('.pdf-content-item[data-kind="image"][data-editable="true"]').first().click(); await ready(page);
    assert.equal(await page.locator('.content-image-info figcaption').innerText().then(value => value.split('\n')[0]), 'Imagen original');
    assert.equal(await page.getByLabel('Ajuste de imagen', { exact: true }).inputValue(), 'stretch');
    await page.getByLabel('Posición X', { exact: true }).fill('220');
    const frame = await page.locator('.content-editor').getAttribute('data-destination-rect');
    await page.getByLabel('Rotación', { exact: true }).selectOption('90');
    assert.equal(await page.locator('.content-editor').getAttribute('data-destination-rect'), frame);
    await page.getByLabel('Opacidad', { exact: true }).fill('60'); await commit(page);
    const bytes = await save(page, 'pdf-editing-moved-image.pdf');
    assert.deepEqual(operateDocument(bytes, { operation: 'text' }), operateDocument(original, { operation: 'text' }));
    const doc = new mupdf.PDFDocument(bytes), target = doc.loadPage(0), pixmap = target.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    try {
      const pixels = pixmap.getPixels(), at = (x, y) => [...pixels.subarray((y * pixmap.getWidth() + x) * 3, (y * pixmap.getWidth() + x) * 3 + 3)];
      assert.deepEqual(at(90, 300), [255, 255, 255]); const moved = at(270, 300); assert(moved[1] > moved[0] + 70 && moved[0] > 70 && moved[0] < 140);
    } finally { pixmap.destroy(); target.destroy(); doc.destroy(); }
    return { noExternalFileRequired: true, originalRegionRemoved: true, movedPixels: true, framePreservedOnRotation: true, opacityExported: true };
  });
  await check('medium-window-editor-resize', async page => {
    await selectText(page); await ready(page);
    const originalArea = await page.locator('.content-editor').getAttribute('data-destination-rect'), metrics = [];
    for (const width of [1024, 900, 800, 1360]) {
      await page.setViewportSize({ width, height: 600 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await ready(page);
      const workspace = await inlineWorkspace(page);
      const value = await page.locator('.content-editor').evaluate(editor => {
        const footer = editor.querySelector('.content-editor-footer .primary-button').getBoundingClientRect(), inspector = editor.querySelector('.content-inspector').getBoundingClientRect();
        const box = editor.querySelector('.content-box').getBoundingClientRect(), preview = editor.querySelector('.content-preview').getBoundingClientRect();
        const actions = [...editor.querySelectorAll('.content-editor-actions button')].map(button => { const bounds = button.getBoundingClientRect(); return { label: button.textContent.trim(), left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, visible: bounds.top >= inspector.top && bounds.bottom <= inspector.bottom && bounds.left >= inspector.left && bounds.right <= inspector.right }; });
        const heading = editor.querySelector('.content-inspector-heading'), reset = editor.querySelector('.content-reset').getBoundingClientRect(), top = editor.querySelector('.content-inspector-top').getBoundingClientRect();
        const scrollBounds = editor.querySelector('.content-inspector-scroll').getBoundingClientRect(), initialControls = ['Texto', 'Fuente', 'Tamaño', 'Color'].map(label => { const bounds = editor.querySelector(`[aria-label="${label}"]`).getBoundingClientRect(); return { label, top: bounds.top, bottom: bounds.bottom, visible: bounds.top >= scrollBounds.top && bounds.bottom <= scrollBounds.bottom }; });
        return { width: innerWidth, applyBottom: footer.bottom, inspectorWidth: inspector.width, previewHeight: preview.height, horizontalOverflow: document.documentElement.scrollWidth - innerWidth, areaVisible: box.left >= preview.left && box.right <= preview.right && box.top >= preview.top && box.bottom <= preview.bottom, actionButtons: actions, objectHeading: heading.querySelector('h3').textContent, propertySections: [...editor.querySelectorAll('.content-property-section>h4')].map(title => title.textContent), compactTextRows: editor.querySelector('textarea[aria-label="Texto"]').rows, originalDetailsClosed: !editor.querySelector('.content-editor-source-info')?.open, inspectorTop: { top: top.top, bottom: top.bottom }, resetVisible: reset.top >= top.top && reset.bottom <= top.bottom && reset.left >= top.left && reset.right <= top.right, initialControls };
      });
      assert(value.applyBottom <= 592); assert(value.inspectorWidth >= 240); assert(value.horizontalOverflow <= 1); assert(value.areaVisible); assert(value.previewHeight >= 200);
      assert.deepEqual(value.actionButtons.map(action => action.label), ['Editar', 'Duplicar', 'Eliminar']);
      assert(value.actionButtons.every(action => action.visible), 'Object actions must be visible without scrolling the inspector.');
      assert.equal(value.objectHeading, 'Texto'); assert(value.resetVisible);
      assert(value.initialControls.every(control => control.visible), 'Text, font, size and color should remain fully visible when a block opens.');
      assert.deepEqual(value.propertySections, ['Formato', 'Distribución', 'Posición y tamaño']);
      assert(value.compactTextRows <= 3); assert(value.originalDetailsClosed);
      await page.getByLabel('Posición X', { exact: true }).scrollIntoViewIfNeeded();
      const scrolled = await page.locator('.content-editor').evaluate(editor => {
        const top = editor.querySelector('.content-inspector-top').getBoundingClientRect(), footer = editor.querySelector('.content-editor-footer .primary-button').getBoundingClientRect();
        return { scrollTop: editor.querySelector('.content-inspector-scroll').scrollTop, top: top.top, bottom: top.bottom, applyBottom: footer.bottom };
      });
      assert(scrolled.scrollTop > 0, 'Position fields must remain reachable by scrolling properties.');
      assert.equal(scrolled.top, value.inspectorTop.top); assert.equal(scrolled.bottom, value.inspectorTop.bottom); assert.equal(scrolled.applyBottom, value.applyBottom);
      await page.locator('.content-inspector-scroll').evaluate(element => { element.scrollTop = 0; });
      value.propertiesScrollable = true; value.inspectorHeadingAndFooterFixed = true;
      assert.equal(await page.locator('.content-editor').getAttribute('data-destination-rect'), originalArea); metrics.push({ ...value, workspace });
      if ([800, 900, 1024].includes(width)) await page.screenshot({ path: path.join(output, `pdf-editing-medium-${width}x600.png`) });
      if (width === 1360) await page.screenshot({ path: path.join(output, 'pdf-editing-wide-low-1360x600.png') });
    }
    return { resizingKeepsDraft: true, selectedAreaReadableAndVisible: true, sameReaderView: true, appHeaderAndTabsVisible: true, noDialog: true, metrics };
  });
} finally {
  await browser?.close();
  if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
  fs.writeFileSync(path.join(output, 'pdf-editing-ui-results.json'), JSON.stringify({ date: new Date().toISOString(), platform: process.platform, browser: browserName, frontendEntry, results, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}
