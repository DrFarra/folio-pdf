import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = process.cwd(), output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const fixture = path.join(output, 'responsive-workbench-check.pdf');
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), form = pdf.getForm();
for (let number = 1; number <= 12; number++) {
  const page = pdf.addPage([500, 400]);
  page.drawText('RESPONSIVE CHECK ' + number, { x: 30, y: 360, size: 18, font });
  if (number <= 3) for (let index = 0; index < 6; index++) {
    const field = form.createTextField('Campo de formulario ' + ((number - 1) * 6 + index + 1) + ' con etiqueta extensa');
    field.setText('Valor de ejemplo'); field.addToPage(page, { x: 30, y: 285 - index * 35, width: 350, height: 25 });
  }
}
form.updateFieldAppearances(font); fs.writeFileSync(fixture, await pdf.save());
const chrome = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
assert(chrome, 'A Chromium executable is required.');
const mode = process.env.FOLIO_RESPONSIVE_MODE || 'preview', port = process.env.FOLIO_RESPONSIVE_PORT || '4257';
assert(['dev', 'preview'].includes(mode), 'FOLIO_RESPONSIVE_MODE must be dev or preview.');
const origin = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), ...(mode === 'preview' ? ['preview'] : []), '--host', '127.0.0.1', '--port', port, '--strictPort'], { windowsHide: true, stdio: 'pipe' });
let log = '', browser, frontendEntry = ''; const results = [], errors = [];
server.stdout.on('data', data => log += data); server.stderr.on('data', data => log += data);
const frame = page => page.evaluate(() => {
  const rect = selector => {
    const element = document.querySelector(selector); if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom,
      scrollTop: element.scrollTop, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight, clientWidth: element.clientWidth, clientHeight: element.clientHeight };
  };
  return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
    dialog: rect('dialog[open]'), heading: rect('dialog[open]>.modal-heading'), navigation: rect('dialog[open]>.workbench-navigation'),
    conversionBody: rect('.conversion-fields'), conversionFooter: rect('.conversion-actions'), fields: rect('.form-fields'), formFooter: rect('.forms-workbench-footer'),
    grid: rect('.page-plan'), pageFooter: rect('.page-plan-footer'), firstCard: rect('.page-plan>article'), firstMove: rect('.page-plan>article .plan-move') };
});
function bounded(value) {
  assert.equal(value.documentWidth, value.width); assert.equal(value.documentHeight, value.height);
  assert.equal(value.dialog.scrollTop, 0, 'The dialog must remain stationary.');
  assert(value.dialog.scrollHeight <= value.dialog.clientHeight + 1, 'Only the body may scroll.');
  for (const key of ['dialog', 'heading', 'navigation']) {
    const box = value[key]; assert(box && box.width > 0 && box.height > 0);
    assert(box.x >= -.5 && box.y >= -.5 && box.right <= value.width + .5 && box.bottom <= value.height + .5, key + ' is outside the window.');
  }
}
function completeCard(value) {
  assert(value.firstCard.y >= value.grid.y && value.firstCard.bottom <= value.grid.bottom, 'At least the complete first row must fit.');
  assert(value.firstMove.bottom <= value.grid.bottom, 'The card move buttons must be visible.');
}
async function reachable(locator) {
  const box = await locator.boundingBox(); assert(box && box.height > 0 && box.width > 0);
  assert(await locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button,input,select,textarea') === element;
  }), 'A visible control must receive pointer input.');
  return box;
}
async function tools(page, title) { await page.getByRole('button', { name: 'Herramientas', exact: true }).click(); await page.getByRole('button', { name: title, exact: true }).click(); }
async function check(page, id, action) {
  try { results.push({ id, status: 'passed', ...await action() }); }
  catch (error) { results.push({ id, status: 'failed', error: error.stack }); process.exitCode = 1; await page.screenshot({ path: path.join(output, 'failure-' + id + '.png') }).catch(() => {}); }
  console.log(JSON.stringify(results.at(-1)));
}
async function drag(page, source, target, release = true) {
  const a = await source.locator('.thumbnail-item').boundingBox(), b = await target.boundingBox(); assert(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2, { steps: 3 }); await page.locator('.page-plan-drag-preview').waitFor();
  await page.mouse.move(b.x + b.width * .8, b.y + b.height / 2, { steps: 10 }); await target.locator('xpath=self::*[contains(@class,"plan-drop-after")]').waitFor();
  if (release) { await page.mouse.up(); await page.locator('.page-plan-drag-preview').waitFor({ state: 'detached' }); }
}
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    if (server.exitCode !== null) throw Error(log); await new Promise(resolve => setTimeout(resolve, 100));
  }
  const html = await (await fetch(origin)).text();
  frontendEntry = html.match(/src="([^"]+\.js)"/)?.[1] || '/src/main.tsx';
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  for (const width of [800, 900, 1024]) {
    const context = await browser.newContext({ viewport: { width, height: 600 } }), page = await context.newPage(); page.setDefaultTimeout(20000);
    // Vite DEV resolves MuPDF's nested WASM URL differently from a production build.
    // Serve the actual bundled binary for this development-only route.
    if (mode === 'dev') await page.route('**/*mupdf-wasm.wasm*', route => route.fulfill({ path: path.join(root, 'node_modules/mupdf/dist/mupdf-wasm.wasm'), contentType: 'application/wasm' }));
    page.on('pageerror', error => errors.push({ width, error: error.message }));
    await page.goto(origin); await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(fixture);
    await page.locator('.reading-area .textLayer span').first().waitFor(); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await check(page, `conversion-${width}x600`, async () => {
      await tools(page, 'Convertir PDF'); await page.getByLabel('Formato de exportación').selectOption('png'); await page.getByLabel('Páginas a exportar').selectOption('range');
      await page.getByLabel('Intervalo de páginas').fill('1-3, 6'); await page.getByLabel('Resolución PNG').selectOption('300'); await page.getByLabel('Fondo PNG').selectOption('transparent');
      const button = page.getByRole('button', { name: 'Exportar PNG', exact: true }); await button.waitFor(); const before = await frame(page); bounded(before); const buttonBefore = await reachable(button);
      const format = await page.getByLabel('Formato de exportación').boundingBox(), scope = await page.getByLabel('Páginas a exportar').boundingBox();
      assert(Math.abs(format.y - scope.y) < 1 && scope.x > format.x, 'Format and scope should share one desktop row.');
      for (const label of ['Formato de exportación', 'Páginas a exportar', 'Intervalo de páginas', 'Resolución PNG', 'Fondo PNG']) { const input = page.getByLabel(label); await input.scrollIntoViewIfNeeded(); await reachable(input); }
      await page.locator('.conversion-fields').evaluate(element => element.scrollTop = element.scrollHeight); const after = await frame(page); bounded(after);
      assert.deepEqual(after.conversionFooter, before.conversionFooter); assert.deepEqual(await reachable(button), buttonBefore); await reachable(page.getByRole('button', { name: 'Cerrar diálogo', exact: true }));
      await page.screenshot({ path: path.join(output, `responsive-fixed-convert-${width}x600.png`) });
      if (width === 800) { const downloading = page.waitForEvent('download'); await button.click(); const download = await downloading; await download.saveAs(path.join(output, 'responsive-conversion-click.zip')); assert.equal(await download.failure(), null); await page.locator('.workbench').waitFor({ state: 'detached' }); }
      else await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
      return { fixedFooter: true, controlsReachable: true, formatScopeInOneRow: true, actualExportClick: width === 800, geometry: after };
    });
    await check(page, `forms-${width}x600`, async () => {
      await tools(page, 'Rellenar formulario'); await page.waitForFunction(() => document.querySelectorAll('.form-fields input').length === 18);
      const before = await frame(page); bounded(before); const button = page.getByRole('button', { name: 'Aplicar valores', exact: true }), buttonBefore = await reachable(button);
      const last = page.locator('.form-fields input').last(); await last.scrollIntoViewIfNeeded(); await reachable(last); const after = await frame(page); bounded(after);
      assert(after.fields.scrollTop > 0); assert.deepEqual(after.formFooter, before.formFooter); assert.deepEqual(await reachable(button), buttonBefore);
      await reachable(page.getByRole('button', { name: 'Cerrar diálogo', exact: true })); await reachable(page.getByRole('button', { name: 'Volver a Herramientas', exact: true }));
      await page.screenshot({ path: path.join(output, `responsive-fixed-forms-${width}x600.png`) });
      if (width === 800) { await last.fill('Responsive footer verified'); await button.click(); await page.locator('.workbench').waitFor({ state: 'detached' }); await tools(page, 'Rellenar formulario'); await page.waitForFunction(() => document.querySelectorAll('.form-fields input').length === 18); assert.equal(await page.locator('.form-fields input').last().inputValue(), 'Responsive footer verified'); }
      await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
      return { singleScrollOwner: true, fixedFooter: true, lastFieldReachable: true, actualApplyClick: width === 800, valuePreserved: width === 800 ? true : null, geometry: after };
    });
    await check(page, `pages-${width}x600`, async () => {
      await tools(page, 'Organizar páginas'); const before = await frame(page); bounded(before); completeCard(before);
      await reachable(page.getByRole('button', { name: 'Mover posición 1 después', exact: true })); await reachable(page.getByRole('button', { name: 'Mover posición 2 antes', exact: true }));
      await page.getByLabel('Seleccionar posición 1', { exact: true }).check(); await page.getByLabel('Seleccionar posición 2', { exact: true }).check();
      const cards = page.locator('.page-plan>article'), order = () => page.locator('.page-plan .plan-label').allTextContents();
      await drag(page, cards.nth(0), cards.nth(2)); assert.deepEqual((await order()).slice(0, 4), ['Página 3', 'Página 1', 'Página 2', 'Página 4']); assert.equal(await page.locator('.page-plan input:checked').count(), 2);
      const prior = await order(); await drag(page, cards.nth(1), cards.nth(3), false); await page.keyboard.press('Escape'); await page.mouse.up(); assert.deepEqual(await order(), prior);
      await page.getByRole('button', { name: 'Mover posición 1 después', exact: true }).click(); assert.deepEqual((await order()).slice(0, 3), ['Página 1', 'Página 3', 'Página 2']);
      const after = await frame(page); bounded(after); completeCard(after); await reachable(page.getByRole('button', { name: 'Extraer selección', exact: true })); await reachable(page.getByRole('button', { name: 'Aplicar cambios', exact: true }));
      await page.screenshot({ path: path.join(output, `responsive-fixed-pages-${width}x600.png`) }); await page.getByLabel('Seleccionar posición 12', { exact: true }).scrollIntoViewIfNeeded();
      assert.deepEqual((await frame(page)).pageFooter, after.pageFooter); await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
      return { completeFirstRow: true, moveButtonsReachable: true, actualMoveClick: true, selectedGroupDrag: true, escapeCancel: true, fixedFooter: true, geometry: after };
    });
    if (width === 1024) await check(page, 'resize-conversion-forms-pages', async () => {
      const sequence = [{ width: 1360, height: 720 }, { width: 800, height: 600 }, { width: 900, height: 600 }, { width: 1024, height: 600 }, { width: 1360, height: 720 }], frames = [];
      for (const section of ['Convertir PDF', 'Rellenar formulario', 'Organizar páginas']) {
        await tools(page, section); if (section === 'Rellenar formulario') await page.waitForFunction(() => document.querySelectorAll('.form-fields input').length === 18);
        if (section === 'Convertir PDF') { await page.getByLabel('Formato de exportación').selectOption('png'); await page.getByLabel('Páginas a exportar').selectOption('range'); await page.getByLabel('Intervalo de páginas').fill('1-3, 6'); }
        for (const size of sequence) {
          await page.setViewportSize(size); await page.evaluate(() => { const grid = document.querySelector('.page-plan'); if (grid) grid.scrollTop = 0; });
          const value = await frame(page); bounded(value); if (section === 'Organizar páginas') { completeCard(value); await reachable(page.getByRole('button', { name: 'Mover posición 1 después', exact: true })); }
          await reachable(page.getByRole('button', { name: section === 'Convertir PDF' ? 'Exportar PNG' : section === 'Rellenar formulario' ? 'Aplicar valores' : 'Extraer selección', exact: true }));
          frames.push({ section, ...size, firstCardHeight: value.firstCard?.height, bodyHeight: value.conversionBody?.height || value.fields?.height || value.grid?.height });
        }
        await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
      }
      return { mediumAndLargeResizing: true, frames };
    });
    await context.close();
  }
} finally {
  try { await browser?.close(); } finally {
    if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
  }
  fs.writeFileSync(path.join(output, 'responsive-workbench-results.json'), JSON.stringify({ date: new Date().toISOString(), source: mode === 'preview' ? 'Vite production preview' : 'Vite DEV', port, frontendEntry, native: false, results, errors }, null, 2) + '\n');
  if (errors.length) { console.log(JSON.stringify(errors)); process.exitCode = 1; }
}
