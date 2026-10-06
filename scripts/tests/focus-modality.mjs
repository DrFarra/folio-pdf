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
const port = process.env.FOLIO_FOCUS_PORT || '4199', origin = `http://127.0.0.1:${port}`;
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'),
  'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let log = '', browser;
preview.stdout.on('data', chunk => { log += chunk; });
preview.stderr.on('data', chunk => { log += chunk; });
const results = [], errors = [];
async function appearance(locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    return { focused: element === document.activeElement, nativeVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
  });
}
const ring = state => state.outlineStyle !== 'none' && state.outlineWidth > 0;
// Pointer focus draws the ring only when the browser itself reports keyboard focus.
async function pointerFocus(locator) {
  const state = await appearance(locator);
  assert.equal(state.focused, true, 'Quitar el anillo no debe quitar el foco del control.');
  assert.equal(ring(state), state.nativeVisible, 'El anillo de foco sigue a :focus-visible: el clic no lo dibuja.');
  return state;
}
async function keyboardFocus(locator) {
  const state = await appearance(locator);
  assert.equal(state.focused, true);
  assert(state.nativeVisible && ring(state), 'La navegación con teclado muestra el anillo de foco.');
  return state;
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
  const page = await browser.newPage({ viewport: { width: 1366, height: 720 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('.app-header input[type=file]').setInputFiles(path.join(root, 'public/sample.pdf'));
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Herramientas', exact: true }).click({ modifiers: ['Control'] });
  const close = page.getByRole('button', { name: 'Cerrar diálogo', exact: true });
  await close.waitFor();
  await pointerFocus(close);
  // Modifier clicks keep focus without a ring; Tab and Shift+Tab draw it.
  await page.keyboard.down('Control');
  await pointerFocus(close);
  await page.keyboard.up('Control');
  await page.keyboard.press('Tab');
  await keyboardFocus(page.locator('.workbench :focus'));
  await page.keyboard.press('Shift+Tab');
  await keyboardFocus(close);
  await page.keyboard.press('Enter');
  await page.locator('.workbench').waitFor({ state: 'detached' });
  await keyboardFocus(page.getByRole('button', { name: 'Herramientas', exact: true }));
  results.push({ id: 'modifier-click-dialog-and-keyboard-return', passed: true });

  const tools = page.getByRole('button', { name: 'Herramientas', exact: true });
  await tools.click();
  await page.getByRole('button', { name: 'Organizar páginas', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator('.workbench').waitFor({ state: 'detached' });
  await pointerFocus(tools);
  results.push({ id: 'mouse-open-organizer-escape-return-without-outline', passed: true });

  await tools.click();
  await page.getByRole('button', { name: 'Organizar páginas', exact: true }).click();
  await page.keyboard.press('Tab');
  await keyboardFocus(page.locator('.workbench :focus'));
  await page.keyboard.press('Escape');
  await page.locator('.workbench').waitFor({ state: 'detached' });
  await keyboardFocus(tools);
  results.push({ id: 'keyboard-tab-organizer-escape-return-with-ring', passed: true });

  await page.getByRole('button', { name: 'Herramientas', exact: true }).click();
  await page.getByRole('button', { name: 'Organizar páginas', exact: true }).click();
  for (const [index, modifier] of [[0, 'Control'], [1, 'Meta']]) {
    const card = page.locator('.page-plan>article').nth(index), thumbnail = card.locator('.thumbnail-item');
    const unselectedBorder = await card.evaluate(element => getComputedStyle(element).borderColor);
    // A modifier-click on an already keyboard-focused control is the mixed
    // interaction that can retain the browser's :focus-visible heuristic.
    await page.keyboard.press('Tab');
    await thumbnail.focus();
    await keyboardFocus(thumbnail);
    await thumbnail.click({ modifiers: [modifier] });
    const state = await pointerFocus(thumbnail);
    assert.equal(await card.locator('input[type=checkbox]').isChecked(), true, 'La multiselección debe seguir funcionando.');
    assert.equal(await card.evaluate(element => element.classList.contains('selected')), true);
    const selectedBorder = await card.evaluate(element => getComputedStyle(element).borderColor);
    assert.notEqual(selectedBorder, unselectedBorder, 'La selección conserva su borde de tarjeta.');
    results.push({ id: `${modifier.toLowerCase()}-click-thumbnail`, passed: true, browserFocusVisible: state.nativeVisible });
  }
  const checkbox = page.getByRole('checkbox', { name: 'Seleccionar posición 3', exact: true });
  await checkbox.click({ modifiers: ['Control'] });
  await pointerFocus(checkbox);
  assert.equal(await checkbox.isChecked(), true);
  await page.keyboard.press('Tab');
  await keyboardFocus(page.locator('.workbench :focus'));
  await page.keyboard.press('Shift+Tab');
  await keyboardFocus(checkbox);
  await page.keyboard.press('Space');
  assert.equal(await checkbox.isChecked(), false, 'El teclado debe poder alternar la misma selección.');
  await keyboardFocus(checkbox);
  results.push({ id: 'checkbox-pointer-and-tab-space-selection', passed: true });
  await page.screenshot({ path: path.join(output, 'focus-modality-organizer.png'), animations: 'disabled' });
  await close.click();

  const pageNumber = page.getByRole('textbox', { name: 'Número de página', exact: true });
  await pageNumber.click({ modifiers: ['Control'] });
  await pointerFocus(pageNumber);
  await page.keyboard.press('ArrowRight');
  await keyboardFocus(pageNumber);
  results.push({ id: 'text-input-pointer-then-keyboard-editing', passed: true });

  // Abrir PDF opens the hidden file input; the input itself never takes a Tab stop.
  assert.equal(await page.locator('.app-header input[type=file]').getAttribute('tabindex'), '-1');
  const pagesRail = page.getByRole('button', { name: 'Páginas', exact: true });
  await pagesRail.click();
  assert.equal((await pointerFocus(pagesRail)).nativeVisible, false, 'Un clic con el ratón no dibuja el anillo de foco.');
  await page.getByRole('button', { name: 'Cerrar panel', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Páginas' && !document.querySelector('.sidebar'));
  results.push({ id: 'closing-panel-returns-focus-to-rail', passed: true });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'focus-modality-results.json'), JSON.stringify({ results, uncaughtErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results, errors }));
} finally {
  await browser?.close();
  preview.kill();
}
