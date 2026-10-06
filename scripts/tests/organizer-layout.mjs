import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'test-results');
await mkdir(output, { recursive: true });
const chrome = findChrome();
assert(chrome, 'CHROME_PATH debe apuntar a Chrome, Edge o Chromium.');
const port = process.env.FOLIO_ORGANIZER_LAYOUT_PORT || '4198', origin = `http://127.0.0.1:${port}`;
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'),
  'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let log = '', browser;
preview.stdout.on('data', chunk => { log += chunk; });
preview.stderr.on('data', chunk => { log += chunk; });
const results = [], errors = [];
const snapshot = page => page.evaluate(() => {
  const bounds = selector => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
  };
  const dialog = document.querySelector('.pages-workbench'), grid = document.querySelector('.page-plan');
  return { dialog: bounds('.pages-workbench'), header: bounds('.pages-workbench>.modal-heading'),
    back: bounds('.workbench-navigation'), controls: bounds('.page-plan-actions'), grid: bounds('.page-plan'),
    footer: bounds('.page-plan-footer'), apply: bounds('.page-plan-footer>.primary-button'),
    extract: bounds('.page-plan-footer>.secondary-button'),
    dialogScrollTop: dialog.scrollTop, dialogClientHeight: dialog.clientHeight, dialogScrollHeight: dialog.scrollHeight,
    gridScrollTop: grid.scrollTop, gridClientHeight: grid.clientHeight, gridScrollHeight: grid.scrollHeight,
    outerScrollX: scrollX, outerScrollY: scrollY };
});
function assertLayout(value, { width, height }) {
  assert(value.dialog.y >= 0 && value.dialog.x >= 0);
  assert(value.dialog.right <= width && value.dialog.bottom <= height, 'El organizador debe caber en el área visible.');
  assert(value.grid.height > 0, 'Las miniaturas deben conservar espacio visible.');
  assert(value.grid.bottom <= value.footer.y, 'Las miniaturas no deben cubrir los botones inferiores.');
  for (const part of ['header', 'back', 'controls', 'footer', 'apply', 'extract']) {
    assert(value[part].y >= value.dialog.y && value[part].bottom <= value.dialog.bottom, `${part} quedó fuera del diálogo.`);
    assert(value[part].x >= value.dialog.x && value[part].right <= value.dialog.right, `${part} desbordó el ancho del diálogo.`);
  }
  assert.equal(value.dialogScrollTop, 0, 'El diálogo no debe desplazar sus controles.');
  assert.equal(value.dialogScrollHeight, value.dialogClientHeight, 'Solo la cuadrícula debe tener desbordamiento vertical.');
  assert.equal(value.outerScrollX, 0); assert.equal(value.outerScrollY, 0);
}
async function mockWindows(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: 'Windows' } });
    globalThis.isTauri = true;
    let id = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++id, unregisterCallback: () => {},
      invoke: async command => {
        if (command === 'plugin:event|listen') return ++id;
        if (command === 'plugin:window|current_monitor') return { name: '150% DPI test monitor',
          position: { x: 0, y: 0 }, size: { width: 2049, height: 1080 }, scaleFactor: 1.5,
          workArea: { position: { x: 0, y: 0 }, size: { width: 2049, height: 960 } } };
        if (command === 'plugin:window|inner_position') return { x: 0, y: 0 };
        if (command === 'plugin:window|inner_size') return { width: 2049, height: 1080 };
        if (command === 'plugin:window|is_fullscreen') return false;
        if (['startup_documents', 'recent_documents', 'list_library', 'pick_documents'].includes(command)) return [];
        if (command === 'load_session' || command === 'load_draft') return null;
        return undefined;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
}
async function check(id, { viewport, mobile = false, native = false }) {
  const context = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' } : {}) });
  if (native) await mockWindows(context);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push({ id, error: error.message }));
  try {
    await page.goto(origin);
    await page.locator('.app-header input[type=file]').setInputFiles(path.join(root, 'public/sample.pdf'));
    await page.getByRole('heading', { name: 'sample.pdf', exact: true }).waitFor();
    await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    if (mobile) await page.getByRole('button', { name: 'Más acciones', exact: true }).click();
    await page.getByRole('button', { name: 'Herramientas', exact: true }).click();
    await page.getByRole('button', { name: 'Organizar páginas', exact: true }).click();
    if (native) await page.waitForFunction(() => document.querySelector('.pages-workbench').style.getPropertyValue('--modal-visible-height') === '640px');
    await page.getByRole('checkbox', { name: 'Seleccionar posición 1', exact: true }).check();
    const moveTo = page.getByLabel('Mover páginas seleccionadas a la posición', { exact: true });
    // Touch layouts cannot drag pages; the selection moves to a chosen position instead.
    if (mobile) {
      await moveTo.selectOption('2');
      assert.deepEqual((await page.locator('.page-plan .plan-label').allTextContents()).slice(0, 3), ['Página 2', 'Página 3', 'Página 1']);
      assert.equal(await page.getByRole('checkbox', { name: 'Seleccionar posición 3', exact: true }).isChecked(), true, 'The moved page stays selected.');
    } else assert.equal(await moveTo.count(), 0);
    await page.getByRole('button', { name: 'Girar páginas seleccionadas', exact: true }).click();
    const before = await snapshot(page), visible = { ...viewport, height: native ? 640 : viewport.height };
    assertLayout(before, visible);
    const firstCard = await page.locator('.page-plan>article').first().boundingBox();
    for (const selector of ['.plan-label', '.plan-move']) {
      const bounds = await page.locator('.page-plan>article').first().locator(selector).boundingBox();
      assert(bounds.y + bounds.height <= firstCard.y + firstCard.height, 'Las tarjetas no deben comprimirse ni recortar sus etiquetas y botones.');
    }
    assert(before.gridScrollHeight > before.gridClientHeight, 'El documento de prueba debe requerir desplazamiento de miniaturas.');
    await page.mouse.move(before.grid.x + before.grid.width / 2, before.grid.y + before.grid.height / 2);
    await page.mouse.wheel(0, 1200);
    await page.waitForFunction(() => document.querySelector('.page-plan').scrollTop > 0);
    const after = await snapshot(page);
    assertLayout(after, visible);
    for (const part of ['header', 'back', 'controls', 'footer', 'apply', 'extract']) assert.deepEqual(after[part], before[part], `${part} se movió al desplazar las miniaturas.`);
    // Wheel input on the footer must never move the enclosing modal or hide it.
    await page.mouse.move(after.footer.x + after.footer.width / 2, after.footer.y + after.footer.height / 2);
    await page.mouse.wheel(0, 1000);
    assertLayout(await snapshot(page), visible);
    await page.screenshot({ path: path.join(output, `${id}.png`), animations: 'disabled' });
    const apply = page.getByRole('button', { name: 'Aplicar cambios', exact: true });
    assert.equal(await apply.isEnabled(), true);
    await apply.click();
    await page.locator('.pages-workbench').waitFor({ state: 'detached' });
    results.push({ id, passed: true, viewport, visibleHeight: visible.height, mobile, windowsBridgeMocked: native,
      footerAlwaysVisible: true, onlyThumbnailsScroll: true, applyClickable: true });
  } catch (error) {
    await page.screenshot({ path: path.join(output, `failure-${id}.png`), animations: 'disabled' });
    throw error;
  } finally { await context.close(); }
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
  await check('organizer-1366x720', { viewport: { width: 1366, height: 720 } });
  await check('organizer-1360x600', { viewport: { width: 1360, height: 600 } });
  await check('organizer-work-area-150dpi', { viewport: { width: 1366, height: 720 }, native: true });
  await check('organizer-phone-portrait', { viewport: { width: 390, height: 844 }, mobile: true });
  await check('organizer-phone-landscape', { viewport: { width: 844, height: 390 }, mobile: true });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'organizer-layout-results.json'), JSON.stringify({ results, uncaughtErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results, errors }));
} finally {
  await browser?.close();
  preview.kill();
}
