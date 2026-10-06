import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { waitForSession } from './session-helpers.mjs';

const root = process.cwd(), output = path.join(root, 'test-results'); fs.mkdirSync(output, { recursive: true });
const fixture = path.join(output, 'reading-settings.pdf');
const pdf = await PDFDocument.create();
for (let number = 1; number <= 3; number++) pdf.addPage([400, 500]).drawText(`Reading preferences page ${number}`, { x: 30, y: 400 });
fs.writeFileSync(fixture, await pdf.save());
const origin = 'http://127.0.0.1:4189';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4189', '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
const results = [], errors = []; let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const chrome = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  browser = process.env.FOLIO_TEST_BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch({ executablePath: chrome });
  const context = await browser.newContext({ viewport: { width: 1360, height: 850 } }), page = await context.newPage();
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  const open = async () => { await page.waitForFunction(() => !document.querySelector('.new-document-tab')?.disabled); await page.locator('.app-header input[type=file]').setInputFiles({ name: 'reading-settings.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(fixture) }); await page.getByRole('heading', { name: 'reading-settings.pdf', exact: true }).waitFor(); await page.locator('.loading-overlay').waitFor({ state: 'detached' }); };
  const settings = async () => { await page.getByRole('button', { name: 'Ajustes', exact: true }).click(); await page.getByRole('dialog').waitFor(); };
  await page.goto(origin); await open(); await settings();
  assert.equal(await page.getByRole('button', { name: 'Sistema', exact: true }).getAttribute('aria-pressed'), 'true', 'The theme follows the system until chosen.');
  await page.getByLabel('Zoom inicial', { exact: true }).selectOption('125');
  await page.getByLabel('Modo de desplazamiento', { exact: true }).selectOption('single');
  await page.getByLabel('Al abrir un documento', { exact: true }).selectOption('bookmarks');
  await page.getByLabel('Ancho del panel', { exact: true }).fill('300');
  await page.getByLabel('Velocidad de zoom con rueda', { exact: true }).selectOption('50');
  await page.getByLabel('Reabrir en la última página', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Sistema', exact: true }).click();
  await page.getByRole('button', { name: 'Listo', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content === getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()), true, 'The browser bar follows the theme.');
  await page.emulateMedia({ colorScheme: 'light' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  results.push({ id: 'system-theme-follows-os', status: 'passed' });
  // Preferences set how PDFs open; the open document keeps its current view.
  assert.equal(await page.locator('.pdf-page-wrap').count(), 3);
  await page.getByRole('button', { name: 'Página siguiente', exact: true }).click();
  await waitForSession(page, session => session.lastPage === 2);
  results.push({ id: 'preferences-keep-open-view', status: 'passed' });
  await page.waitForFunction(() => localStorage.getItem('folio.defaultZoom') === '125');
  await page.reload(); await open();
  assert.equal(await page.getByLabel('Número de página', { exact: true }).inputValue(), '1');
  assert.equal(await page.getByLabel('Nivel de zoom', { exact: true }).inputValue(), '125');
  assert.equal(await page.locator('.sidebar').evaluate(element => element.clientWidth), 299);
  await page.locator('.bookmark-tree').waitFor({ state: 'attached' });
  assert.match(await page.locator('.sidebar-title').textContent(), /Marcadores/);
  assert.equal(await page.locator('.pdf-page-wrap').count(), 1);
  await page.getByRole('button', { name: 'Página siguiente', exact: true }).click(); await page.locator('.pdf-page-wrap[data-page-number="2"]').waitFor();
  assert.equal(await page.locator('.pdf-page-wrap').count(), 1);
  assert.equal(await page.getByLabel('Número de página', { exact: true }).inputValue(), '2');
  results.push({ id: 'single-page-navigation', status: 'passed' });
  await settings();
  assert.equal(await page.getByLabel('Modo de desplazamiento', { exact: true }).inputValue(), 'single');
  assert.equal(await page.getByLabel('Velocidad de zoom con rueda', { exact: true }).inputValue(), '50');
  await page.getByLabel('Modo de desplazamiento', { exact: true }).selectOption('continuous');
  await page.getByRole('button', { name: 'Listo', exact: true }).click();
  assert.equal(await page.locator('.pdf-page-wrap').count(), 1);
  // On desktop the open document's scroll mode is a direct action in Más acciones.
  await page.getByRole('button', { name: 'Más acciones del documento', exact: true }).click();
  await page.getByRole('button', { name: 'Ver páginas en continuo', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.pdf-page-wrap').length === 3);
  results.push({ id: 'preferences-survive-reload-and-apply-to-new-files', status: 'passed' });
  await settings();
  await page.screenshot({ path: path.join(output, 'reading-settings.png') });
  assert.deepEqual(errors, []); await context.close();
} catch (error) { process.exitCode = 1; results.push({ id: 'reading-settings', status: 'failed', error: error.stack }); }
finally { await browser?.close(); server.kill(); fs.writeFileSync(path.join(output, 'reading-settings-results.json'), JSON.stringify({ hostPlatform: process.platform, results, errors }, null, 2)); console.log(JSON.stringify({ results, errors })); }
