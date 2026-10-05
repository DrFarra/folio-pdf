import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = process.cwd(), output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const fixture = path.join(output, 'content-editor-layout.pdf');
const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
const sheet = document.addPage([500, 400]);
sheet.drawText('CONTENT EDITOR LAYOUT', { x: 32, y: 350, size: 18, font });
sheet.drawText('An original PDF page stays visible while adjusting the draft.', { x: 32, y: 315, size: 12, font });
fs.writeFileSync(fixture, await document.save());
const useWebKit = process.env.FOLIO_TEST_BROWSER === 'webkit', browserName = useWebKit ? 'WebKit' : 'Chromium';
const chrome = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(fs.existsSync);
if (!useWebKit) assert(chrome, 'A Chromium executable is required.');
const port = process.env.FOLIO_EDITOR_LAYOUT_PORT || '4202', origin = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { windowsHide: true, stdio: 'pipe' });
let log = '', browser, frontendEntry; const results = [], errors = [];
server.stdout.on('data', bytes => { log += bytes; }); server.stderr.on('data', bytes => { log += bytes; });
const iphoneAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const cases = [
  { width: 1360, height: 720 }, { width: 1360, height: 600 }, { width: 1024, height: 600 }, { width: 760, height: 600 },
  { width: 390, height: 844, phone: true }, { width: 844, height: 390, phone: true },
];
const geometry = page => page.evaluate(() => {
  const measure = selector => {
    const element = document.querySelector(selector), bounds = element?.getBoundingClientRect();
    return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom,
      scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth, clientHeight: element.clientHeight } : null;
  };
  return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
    scrollX, scrollY, phone: document.documentElement.hasAttribute('data-phone'), dialog: measure('.content-workbench'),
    editor: measure('.content-editor'), body: measure('.content-editor-body'), preview: measure('.content-preview'),
    canvas: measure('.content-preview canvas'), inspector: measure('.content-inspector'),
    inspectorTop: measure('.content-inspector-top'), inspectorScroll: measure('.content-inspector-scroll'), footer: measure('.content-editor-footer') };
});
function assertBounds(value, phone) {
  assert.equal(value.scrollX, 0); assert.equal(value.scrollY, 0);
  assert.equal(value.documentWidth, value.width, 'The app must not overflow horizontally.');
  assert.equal(value.documentHeight, value.height, 'The page itself must not scroll.');
  for (const key of ['dialog', 'editor', 'body', 'preview', 'canvas', 'inspector', 'inspectorTop', 'inspectorScroll', 'footer']) {
    const bounds = value[key]; assert(bounds && bounds.width > 0 && bounds.height > 0, key + ' must have usable space.');
    assert(bounds.x >= -.5 && bounds.y >= -.5 && bounds.right <= value.width + .5 && bounds.bottom <= value.height + .5, key + ' must stay inside the viewport: ' + JSON.stringify(bounds));
    if (key !== 'canvas') assert(bounds.scrollWidth <= bounds.clientWidth + 1, key + ' must not scroll horizontally.');
  }
  assert.equal(value.dialog.scrollTop, 0, 'Only the inspector should scroll to expose its controls.');
  assert.equal(value.body.scrollTop, 0); assert.equal(value.editor.scrollTop, 0);
  assert.equal(value.inspector.scrollTop, 0, 'The selection heading must stay fixed while properties scroll.');
  assert(value.inspectorScroll.y >= value.inspectorTop.bottom - 1, 'Properties must stay below the fixed selection heading.');
  assert(value.inspectorScroll.bottom <= value.inspector.bottom + 1);
  assert(value.canvas.height >= (phone && value.height < 500 ? 80 : 150), 'The PDF preview is too small.');
  assert.equal(value.phone, phone);
}
async function ensureButton(page, name) {
  const button = page.getByRole('button', { name, exact: true });
  assert(await button.isEnabled());
  const box = await button.boundingBox(); assert(box);
  const reachable = await button.evaluate(element => {
    const box = element.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === element;
  });
  assert(reachable, name + ' must be reachable without scrolling the dialog.');
  return box;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, log || 'The preview server did not start.');
  const html = await (await fetch(origin)).text();
  frontendEntry = html.match(/src="([^"]+\.js)"/)?.[1]; assert(frontendEntry, 'The report must identify the tested frontend build.');
  browser = useWebKit ? await webkit.launch({ headless: true }) : await chromium.launch({ executablePath: chrome, headless: true });
  for (const specification of cases) {
    const { phone = false, width, height } = specification, id = (phone ? 'phone-' : 'desktop-') + width + 'x' + height;
    if (process.env.FOLIO_EDITOR_LAYOUT_TEST && !new RegExp(process.env.FOLIO_EDITOR_LAYOUT_TEST).test(id)) continue;
    const context = await browser.newContext({ viewport: { width, height }, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: iphoneAgent } : {}) });
    if (phone) await context.addInitScript(() => { Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' }); Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: undefined }); });
    else if (useWebKit) await context.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
      Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: 'macOS' } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push({ id, error: error.message }));
    try {
      await page.goto(origin);
      await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(fixture);
      await page.locator('.reading-area .textLayer span').first().waitFor();
      await page.locator('.loading-overlay').waitFor({ state: 'detached' });
      if (phone) await page.getByRole('button', { name: 'Más acciones', exact: true }).tap();
      else await page.getByRole('combobox', { name: 'Nivel de zoom' }).selectOption('100');
      await page.getByRole('button', { name: 'Herramientas', exact: true }).click();
      await page.getByRole('button', { name: 'Añadir texto', exact: true }).click();
      const bounds = await page.locator('.pdf-page').first().boundingBox(); assert(bounds);
      await page.mouse.move(bounds.x + bounds.width * .1, bounds.y + bounds.height * .3); await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * .75, bounds.y + bounds.height * .75, { steps: 8 }); await page.mouse.up();
      await page.locator('.content-editor').waitFor();
      await page.getByLabel('Texto', { exact: true }).fill('Vista previa real del editor.');
      await page.locator('.content-editor[data-preview-state=ready]').waitFor({ timeout: 60000 });
      const before = await geometry(page); assertBounds(before, phone);
      const applyBefore = await ensureButton(page, 'Aplicar cambios'), cancelBefore = await ensureButton(page, 'Cancelar');
      const visited = [], controlBounds = [];
      for (const label of ['Texto', 'Fuente', 'Tamaño', 'Color', 'Alineación', 'Interlineado', 'Ajustar líneas', 'Posición X', 'Posición Y', 'Ancho', 'Alto']) {
        const input = page.getByLabel(label, { exact: true }); await input.scrollIntoViewIfNeeded();
        const inputBox = await input.boundingBox(), inspector = await page.locator('.content-inspector-scroll').boundingBox(); assert(inputBox && inspector);
        assert(inputBox.y >= inspector.y - 1 && inputBox.y + inputBox.height <= inspector.y + inspector.height + 1, label + ' must be reachable below the fixed heading by scrolling properties.');
        const reachable = await input.evaluate(element => {
          const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return hit === element || element.contains(hit);
        });
        assert(reachable, label + ' must not be covered by the fixed heading or footer.');
        controlBounds.push({ label, input: inputBox, properties: inspector, reachable });
        visited.push(label);
      }
      const after = await geometry(page); assertBounds(after, phone);
      assert.deepEqual(await ensureButton(page, 'Aplicar cambios'), applyBefore, 'Apply must remain stationary while scrolling controls.');
      assert.deepEqual(await ensureButton(page, 'Cancelar'), cancelBefore, 'Cancel must remain stationary while scrolling controls.');
      assert(after.inspectorScroll.scrollTop > 0, 'The properties body should expose its last controls by vertical scrolling.');
      assert.deepEqual(after.inspectorTop, before.inspectorTop, 'The selection heading must remain stationary while scrolling properties.');
      assert.equal(after.preview.scrollTop, before.preview.scrollTop);
      assert.equal(await page.locator('.modified-dot').count(), 0, 'Preview must not modify the source document.');
      await page.screenshot({ path: path.join(output, 'content-editor-layout-' + id + '.png'), animations: 'disabled' });
      await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await page.locator('.workbench').waitFor({ state: 'detached' });
      results.push({ id, status: 'passed', simulatedPhone: phone, frontendEntry, previewHeight: before.canvas.height, inspectorScroll: after.inspectorScroll.scrollTop,
        fixedFooter: true, fixedSelectionHeading: true, allControlsReachable: visited, controlBounds, noHorizontalOverflow: true, originalUnchanged: true, geometry: after });
    } catch (error) {
      results.push({ id, status: 'failed', frontendEntry, error: error.stack }); process.exitCode = 1;
      await page.screenshot({ path: path.join(output, 'failure-editor-layout-' + id + '.png'), animations: 'disabled' }).catch(() => {});
    } finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
  }
} finally {
  await browser?.close();
  if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
  fs.writeFileSync(path.join(output, 'content-editor-layout-results.json'), JSON.stringify({ platform: process.platform, browser: browserName, frontendEntry, nativeAppleDeviceTested: false, results, errors }, null, 2) + '\n');
  if (errors.length) { console.log(JSON.stringify({ errors })); process.exitCode = 1; }
}
