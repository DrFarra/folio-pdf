import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { writeAnnotations } from '../../src/engine/mupdf-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'test-results');
await mkdir(output, { recursive: true });
const chrome = findChrome();
assert(chrome, 'CHROME_PATH debe apuntar a Chrome, Edge o Chromium.');

const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'),
  'preview', '--host', '127.0.0.1', '--port', '4175', '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let log = '';
preview.stdout.on('data', chunk => { log += chunk; });
preview.stderr.on('data', chunk => { log += chunk; });
const origin = 'http://127.0.0.1:4175';
let browser;
const results = [];
const errors = [];
const frame = page => page.evaluate(() => {
  const bounds = selector => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom } : null;
  };
  return { width: innerWidth, height: innerHeight, scrollX, scrollY,
    documentHeight: document.documentElement.scrollHeight,
    documentWidth: document.documentElement.scrollWidth,
    header: bounds('.app-header'), toolbar: bounds('.reader-toolbar'),
    reader: bounds('.reading-area'),
    viewerScroll: document.querySelector('.reading-area').scrollTop };
});
function assertFrame(value) {
  assert.equal(value.scrollX, 0);
  assert.equal(value.scrollY, 0);
  assert.equal(value.documentHeight, value.height, 'La ventana completa no debe desplazarse.');
  assert.equal(value.documentWidth, value.width, 'La ventana completa no debe desbordarse horizontalmente.');
  assert(value.reader.height > 0, 'El PDF debe conservar espacio visible.');
  assert(value.toolbar && Math.abs(value.reader.y - value.toolbar.bottom) <= 1, `El PDF debe comenzar inmediatamente debajo de la barra: ${JSON.stringify(value)}`);
  assert(value.reader.height >= value.height * .5, `La lectura debe conservar al menos la mitad de la ventana: ${JSON.stringify(value)}`);
  assert(value.reader.bottom <= value.height, 'El PDF debe permanecer dentro de la ventana.');
}
function assertStationary(before, after) {
  assertFrame(after);
  for (const part of ['header', 'toolbar', 'reader']) assert.deepEqual(after[part], before[part], `${part} se movió al usar la rueda.`);
}
async function assertDialogVisible(page, bounds = { top: 0, left: 0, width: 1360, height: 690 }) {
  const dialog = await page.locator('.workbench').boundingBox();
  assert(dialog.y >= bounds.top && dialog.x >= bounds.left, 'Herramientas debe comenzar en el área visible.');
  assert(dialog.y + dialog.height <= bounds.top + bounds.height, 'Herramientas quedó debajo del área visible.');
  assert(dialog.x + dialog.width <= bounds.left + bounds.width, 'Herramientas desbordó el área visible.');
  const close = await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).boundingBox();
  assert(close.y >= dialog.y && close.y + close.height <= dialog.y + dialog.height, 'Cerrar diálogo debe seguir visible al desplazar las herramientas.');
  return dialog;
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    if (preview.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, log || 'El servidor no arrancó.');
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 690 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor();
  await page.locator('input[type=file]').setInputFiles(path.join(root, 'public/sample.pdf'));
  await page.locator('.textLayer').first().waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });

  for (const viewport of [{ width: 1360, height: 690 }, { width: 800, height: 600 },
    { width: 390, height: 740 }, { width: 1360, height: 320 }, { width: 1800, height: 1000 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('combobox', { name: 'Nivel de zoom' }).selectOption('150');
    await page.locator('.reading-area').evaluate(element => { element.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('.reading-area').scrollTop === 0);
    const before = await frame(page);
    assertFrame(before);
    const reader = before.reader;
    await page.mouse.move(reader.x + reader.width * .7, reader.y + reader.height * .5);
    await page.mouse.wheel(0, 550);
    await page.waitForFunction(() => document.querySelector('.reading-area').scrollTop > 0);
    const after = await frame(page);
    assertStationary(before, after);
    await page.locator('.reading-area').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.mouse.wheel(0, 800);
    assertStationary(before, await frame(page));
    await page.mouse.move(40, 24);
    await page.mouse.wheel(0, 800);
    assertStationary(before, await frame(page));
    const openBounds = await page.getByRole('button', { name: 'Abrir PDF', exact: true }).boundingBox();
    assert(openBounds.x >= 0 && openBounds.x + openBounds.width <= viewport.width, 'Abrir PDF quedó fuera de la ventana.');
    results.push({ viewport, toolbarBottom: after.toolbar.bottom, readerHeight: after.reader.height, wheelScrollsOnlyContent: true });
  }

  await page.setViewportSize({ width: 1360, height: 690 });
  await page.locator('.reading-area').evaluate(element => { element.scrollTop = 0; });
  await page.getByRole('button', { name: 'Páginas', exact: true }).click();
  const beforeSidebar = await frame(page);
  const sidebar = await page.locator('.sidebar-scroll').boundingBox();
  await page.mouse.move(sidebar.x + sidebar.width * .5, sidebar.y + sidebar.height * .5);
  await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => document.querySelector('.sidebar-scroll').scrollTop > 0);
  assertStationary(beforeSidebar, await frame(page));
  assert.equal((await frame(page)).viewerScroll, beforeSidebar.viewerScroll, 'Las miniaturas desplazaron el documento.');

  const sidebarResults = [];
  for (const width of [180, 220, 360]) {
    await page.locator('.sidebar').evaluate((element, width) => { element.style.width = `${width}px`; element.style.minWidth = `${width}px`; }, width);
    const dimensions = await page.locator('.sidebar-scroll').evaluate(element => ({ width: element.clientWidth, contentWidth: element.scrollWidth, overflowX: getComputedStyle(element).overflowX }));
    assert.equal(dimensions.contentWidth, dimensions.width, `Las miniaturas desbordaron el panel de ${width}px.`);
    const bounds = await page.locator('.sidebar-scroll').boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(500, 0);
    assert.equal(await page.locator('.sidebar-scroll').evaluate(element => element.scrollLeft), 0, 'Páginas solo debe desplazarse verticalmente.');
    sidebarResults.push({ panelWidth: width, noHorizontalOverflow: true });
  }
  await page.locator('.sidebar').evaluate(element => { element.style.width = '220px'; element.style.minWidth = '220px'; });

  const toolResults = [];
  for (const viewport of [{ width: 1360, height: 690 }, { width: 800, height: 600 }, { width: 1360, height: 320 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Herramientas', exact: true }).click();
    const bounds = await assertDialogVisible(page, { top: 0, left: 0, ...viewport });
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 32);
    await page.mouse.wheel(0, 1200);
    await page.waitForFunction(() => { const dialog = document.querySelector('.workbench'); return dialog.scrollTop >= dialog.scrollHeight - dialog.clientHeight - 1; });
    await assertDialogVisible(page, { top: 0, left: 0, ...viewport });
    const lastTool = page.getByRole('button', { name: 'Eliminar datos ocultos', exact: true });
    const lastBounds = await lastTool.boundingBox();
    assert(lastBounds.y + lastBounds.height < viewport.height, 'La última herramienta debe quedar por encima del límite de la ventana.');
    await lastTool.click();
    await page.getByRole('heading', { name: 'Eliminar datos ocultos', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
    await page.getByRole('button', { name: 'Herramientas', exact: true }).click();
    await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).focus();
    for (let index = 0; index < await page.locator('.operation-grid>button').count(); index++) await page.keyboard.press('Tab');
    assert.equal(await lastTool.evaluate(element => element === document.activeElement), true, 'El teclado debe acceder a la última herramienta.');
    await assertDialogVisible(page, { top: 0, left: 0, ...viewport });
    await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
    toolResults.push({ viewport, mouseAndKeyboardReachEveryTool: true });
  }
  await page.setViewportSize({ width: 1360, height: 690 });

  // Exercise the Windows geometry contract with a window whose WebView extends
  // behind a bottom/top taskbar and moves to a monitor with negative coordinates.
  // The bridge is mocked; these checks do not claim native Windows acceptance.
  const nativeContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await nativeContext.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: 'Windows' } });
    globalThis.isTauri = true;
    const callbacks = new Map(), listeners = new Map(); let id = 0;
    const state = globalThis.__layoutNative = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 },
      workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 960 } }, fullscreen: false, denied: false,
      emit: event => { for (const [eventId, item] of listeners) if (item.event === event) callbacks.get(item.handler)?.({ event, id: eventId, payload: {} }); },
      listenerCount: () => listeners.size };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: callback => { callbacks.set(++id, callback); return id; }, unregisterCallback: callback => callbacks.delete(callback),
      invoke: async (command, args) => {
        if (command === 'plugin:event|listen') { listeners.set(++id, args); return id; }
        if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
        if (command === 'plugin:window|current_monitor') { if (state.denied) throw new Error('Geometry unavailable'); return { name: 'Test monitor', size: { width: 1920, height: 1080 }, position: state.workArea.position, workArea: state.workArea, scaleFactor: 1.5 }; }
        if (command === 'plugin:window|inner_position') return state.position;
        if (command === 'plugin:window|inner_size') return state.size;
        if (command === 'plugin:window|is_fullscreen') return state.fullscreen;
        if (command === 'startup_documents' || command === 'recent_documents' || command === 'list_library' || command === 'pick_documents') return [];
        if (command === 'load_session' || command === 'load_draft') return null;
        return undefined;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, eventId) => { const item = listeners.get(eventId); if (item) callbacks.delete(item.handler); } };
  });
  const nativePage = await nativeContext.newPage();
  nativePage.on('pageerror', error => errors.push(error.message));
  await nativePage.goto(origin);
  await nativePage.locator('.app-header input[type=file]').setInputFiles(path.join(root, 'public/sample.pdf'));
  await nativePage.locator('.loading-overlay').waitFor({ state: 'detached' });
  const baselineListeners = await nativePage.evaluate(() => globalThis.__layoutNative.listenerCount());
  await nativePage.getByRole('button', { name: 'Herramientas', exact: true }).click();
  await nativePage.waitForFunction(() => document.querySelector('.workbench').style.getPropertyValue('--modal-visible-height') === '640px');
  await assertDialogVisible(nativePage, { top: 0, left: 0, width: 1280, height: 640 });
  await nativePage.evaluate(() => { const state = globalThis.__layoutNative; state.position = { x: -1920, y: 0 }; state.workArea = { position: { x: -1920, y: 48 }, size: { width: 1920, height: 1032 } }; state.emit('tauri://move'); });
  await nativePage.waitForFunction(() => document.querySelector('.workbench').style.getPropertyValue('--modal-visible-top') === '32px');
  await assertDialogVisible(nativePage, { top: 32, left: 0, width: 1280, height: 688 });
  await nativePage.evaluate(() => { globalThis.__layoutNative.fullscreen = true; globalThis.__layoutNative.emit('tauri://resize'); });
  await nativePage.waitForFunction(() => !document.querySelector('.workbench').style.getPropertyValue('--modal-visible-height'));
  await assertDialogVisible(nativePage, { top: 0, left: 0, width: 1280, height: 720 });
  await nativePage.evaluate(() => { globalThis.__layoutNative.fullscreen = false; globalThis.__layoutNative.emit('tauri://scale-change'); });
  await nativePage.waitForFunction(() => document.querySelector('.workbench').style.getPropertyValue('--modal-visible-top') === '32px');
  await nativePage.evaluate(() => { globalThis.__layoutNative.denied = true; globalThis.__layoutNative.emit('tauri://focus'); });
  await nativePage.waitForFunction(() => !document.querySelector('.workbench').style.getPropertyValue('--modal-visible-height'));
  await assertDialogVisible(nativePage, { top: 0, left: 0, width: 1280, height: 720 });
  await nativePage.getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
  await nativePage.waitForFunction(baseline => globalThis.__layoutNative.listenerCount() === baseline, baselineListeners);
  await nativeContext.close();

  const annotatedFile = path.join(output, 'layout-anotaciones.pdf');
  const annotations = Array.from({ length: 30 }, (_, i) => ({ id: `layout-${i}`, page: i % 6 + 1,
    kind: 'note', rect: [100, 650, 100, 650], color: '#f5d164', text: `Comentario ${i + 1}: 漢字 🙂`, created: Date.now() }));
  await writeFile(annotatedFile, writeAnnotations(new Uint8Array(await readFile(path.join(root, 'public/sample.pdf'))), annotations));
  await page.locator('input[type=file]').setInputFiles(annotatedFile);
  await page.getByRole('heading', { name: 'layout-anotaciones.pdf', exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Anotaciones', exact: true }).click();
  const notes = await page.locator('.notes-scroll').boundingBox();
  const beforeNotes = await frame(page);
  await page.mouse.move(notes.x + notes.width * .5, notes.y + notes.height * .5);
  await page.mouse.wheel(0, 600);
  await page.waitForFunction(() => document.querySelector('.notes-scroll').scrollTop > 0);
  assertStationary(beforeNotes, await frame(page));
  assert.equal((await frame(page)).viewerScroll, beforeNotes.viewerScroll, 'Los comentarios desplazaron el documento.');
  await page.getByRole('button', { name: 'Anotaciones', exact: true }).click();

  // Ctrl + rueda cambia el PDF y mantiene el punto situado bajo el cursor.
  await page.getByRole('combobox', { name: 'Nivel de zoom' }).selectOption('100');
  await page.locator('.reading-area').evaluate(element => { element.scrollTop = 0; });
  const canvasBounds = await page.locator('.pdf-page').first().boundingBox();
  const cursor = { x: canvasBounds.x + canvasBounds.width * .5, y: canvasBounds.y + 120 };
  const pdfPoint = () => page.locator('.pdf-page').first().evaluate((element, cursor) => {
    const r = element.getBoundingClientRect();
    return { x: (cursor.x - r.x) / r.width, y: (cursor.y - r.y) / r.height };
  }, cursor);
  const pointBefore = await pdfPoint();
  const beforeCtrl = await frame(page);
  await page.mouse.move(cursor.x, cursor.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('select[aria-label="Nivel de zoom"]').value === '111');
  const pointAfter = await pdfPoint();
  assertStationary(beforeCtrl, await frame(page));
  assert(Math.abs(pointAfter.x - pointBefore.x) < .005 && Math.abs(pointAfter.y - pointBefore.y) < .005, 'El zoom perdió el punto bajo el cursor.');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('select[aria-label="Nivel de zoom"]').value === '100');

  const userPdf = process.env.FOLIO_LAYOUT_PDF;
  if (userPdf) {
    await page.locator('input[type=file]').setInputFiles(userPdf);
    await page.getByRole('heading', { name: path.basename(userPdf), exact: true }).waitFor();
    await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  } else {
    await page.locator('input[type=file]').setInputFiles(path.join(root, 'public/sample.pdf'));
    await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  }
  await page.getByRole('combobox', { name: 'Nivel de zoom' }).selectOption('125');
  await page.locator('.reading-area').evaluate(element => { element.scrollTop = 0; });
  await page.locator('.sidebar-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
  // Esperar también a que las miniaturas visibles terminen de pintar.
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.thumbnail-item canvas');
    if (!canvas || canvas.width < 2) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  });
  await page.getByRole('button', { name: 'Páginas', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'interfaz-compacta.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('button', { name: 'Oscuro', exact: true }).click();
  await page.getByRole('button', { name: 'Listo', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'interfaz-compacta-oscura.png'), animations: 'disabled' });
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(path.join(output, 'layout-results.json'), JSON.stringify({ platform: process.platform, results,
    sidebarResults, toolResults, windowsWorkAreaBridgeMocked: true, nativeDialogListenerCleanup: true,
    sidebarScrollIndependent: true, notesScrollIndependent: true, ctrlWheelZoom: true, cursorAnchorPreserved: true, uncaughtErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: results.length, independentPanes: ['PDF', 'miniaturas', 'comentarios'], sidebarResults, toolResults, windowsWorkAreaBridgeMocked: true, errors }));
} finally {
  await browser?.close();
  preview.kill();
}
