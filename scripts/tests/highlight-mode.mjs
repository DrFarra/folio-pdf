import assert from 'node:assert/strict';
import { enterAnnotationMode } from './ui-helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';

const root = process.cwd(), output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const source = path.join(output, 'highlight-mode-source.pdf');
const lines = ['FIRST: Automatic highlighting stays enabled.', 'SECOND: A separate selection uses the same color.', 'THIRD: Manual selection only opens the action menu.', 'FOURTH: A custom color is stored in the PDF.'];
const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica), sheet = document.addPage([600, 760]);
lines.forEach((text, index) => sheet.drawText(text, { x: 60, y: 670 - 42 * index, size: 14, font }));
const originalBytes = await document.save(), sourceHash = createHash('sha256').update(originalBytes).digest('hex');
fs.writeFileSync(source, originalBytes);
const originalText = operateDocument(originalBytes, { operation: 'text' });
const chrome = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(fs.existsSync);
assert(chrome, 'An installed Chrome or Edge is required.');
const port = process.env.FOLIO_HIGHLIGHT_MODE_PORT || '4180', origin = `http://127.0.0.1:${port}`;
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let browser, log = ''; preview.stdout.on('data', data => { log += data; }); preview.stderr.on('data', data => { log += data; });
const results = [], errors = [];
const picker = page => page.getByRole('button', { name: 'Color del resaltador', exact: true });
const mode = page => page.getByRole('button', { name: 'Resaltado automático (H)', exact: true });
const palette = page => page.getByRole('dialog', { name: 'Colores del resaltador', exact: true });

async function open(page, file = source) {
  await page.locator('.app-header input[type=file]').setInputFiles(file);
  await page.getByRole('heading', { name: path.basename(file), exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.getByRole('combobox', { name: 'Nivel de zoom', exact: true }).selectOption('100');
  await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').first().waitFor();
  await enterAnnotationMode(page);
}
async function check(id, action) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 1050 }, acceptDownloads: true }), page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push({ id, error: error.message }));
  try { await page.goto(origin); await open(page); const evidence = await action(page); results.push({ id, status: 'passed', ...evidence }); }
  catch (error) { process.exitCode = 1; results.push({ id, status: 'failed', error: error.stack }); await page.screenshot({ path: path.join(output, `failure-${id}.png`), animations: 'disabled' }); }
  finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
}
async function selectLine(page, number) {
  const item = page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: lines[number] }).first();
  const box = await item.boundingBox(); assert(box);
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 14 }); await page.mouse.up();
}
async function selectPreset(page, name) { await picker(page).click(); await palette(page).waitFor(); await page.getByRole('button', { name: `Color ${name}`, exact: true }).click(); await palette(page).waitFor({ state: 'detached' }); }
async function waitCount(page, hash, count) { await page.waitForFunction(({ hash, count }) => JSON.parse(localStorage.getItem(`folio.session.${hash}`) || 'null')?.annotations?.filter(item => item.kind === 'highlight').length === count, { hash, count }); }
async function annotations(page, hash = sourceHash) { return page.evaluate(hash => JSON.parse(localStorage.getItem(`folio.session.${hash}`) || 'null')?.annotations?.filter(item => item.kind === 'highlight') || [], hash); }
async function save(page, name) {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar', exact: true }).click();
  const target = path.join(output, name); await (await pending).saveAs(target);
  await page.waitForFunction(() => document.querySelector('.download-button:not([disabled])') && !document.querySelector('.loading-overlay'));
  return { target, bytes: fs.readFileSync(target) };
}
function standardAnnotations(bytes, expectedColors) {
  assert.deepEqual(operateDocument(bytes, { operation: 'text' }), originalText, 'Highlighting must retain every original line.');
  const highlights = inspectDocument(bytes).annotations.filter(item => item.kind === 'highlight');
  assert.equal(highlights.length, expectedColors.length);
  assert.deepEqual(highlights.map(item => item.color.toLowerCase()).sort(), [...expectedColors].sort());
  const pdf = new mupdf.PDFDocument(bytes), page = pdf.loadPage(0), native = page.getAnnotations();
  for (const annotation of native) {
    if (annotation.getType() === 'Highlight') assert(annotation.getObject().get('QuadPoints').length >= 8 && annotation.getObject().get('QuadPoints').length % 8 === 0);
    annotation.destroy();
  }
  assert(highlights.every(item => item.quads?.length && item.text.trim())); page.destroy(); pdf.destroy();
  return highlights;
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {} if (preview.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert(ready, log || 'Preview did not start.'); browser = await chromium.launch({ executablePath: chrome, headless: true });

  await check('continuous-highlight-toggle-colors-standard-export-and-reopen', async page => {
    assert.equal(await picker(page).count(), 0, 'The highlight palette appears when the highlighter is selected.'); assert.equal(await mode(page).count(), 1);
    await mode(page).click();
    assert.equal(await picker(page).count(), 1);
    await selectPreset(page, 'Azul');
    assert((await mode(page).getAttribute('class')).includes('active'));
    await selectLine(page, 0); await waitCount(page, sourceHash, 1);
    await selectLine(page, 1); await waitCount(page, sourceHash, 2);
    assert((await mode(page).getAttribute('class')).includes('active'), 'Automatic highlighting remains enabled across separate selections.');
    assert((await annotations(page)).every(item => item.color === '#8bbaf0'));
    await mode(page).click(); assert(!(await mode(page).getAttribute('class')).includes('active'));
    await selectLine(page, 2); await page.getByRole('toolbar', { name: 'Herramientas del texto seleccionado', exact: true }).waitFor();
    assert.equal((await annotations(page)).length, 2, 'Selection with automatic mode disabled only offers the manual actions.');
    const selected = await page.evaluate(() => window.getSelection()?.toString()); assert(selected?.includes('THIRD:'));
    const box = await page.locator('.pdf-page-wrap[data-page-number="1"] .page-content').boundingBox(); await page.mouse.click(box.x + 12, box.y + 12);
    await mode(page).click();
    await picker(page).click(); await page.getByLabel('Color personalizado del resaltador', { exact: true }).fill('#123abc');
    await page.waitForFunction(() => localStorage.getItem('folio.highlightColor') === '#123abc');
    assert.equal((await annotations(page)).length, 2, 'Choosing a highlighter color does not change existing annotations.');
    await page.screenshot({ path: path.join(output, 'highlight-color-palette.png'), animations: 'disabled' });
    await page.keyboard.press('Escape'); await palette(page).waitFor({ state: 'detached' });
    await selectLine(page, 3); await waitCount(page, sourceHash, 3);
    await page.screenshot({ path: path.join(output, 'highlight-automatic-colors.png'), animations: 'disabled' });
    const { target, bytes } = await save(page, 'highlight-mode-colors.pdf');
    const highlights = standardAnnotations(bytes, ['#8bbaf0', '#8bbaf0', '#123abc']);
    assert(highlights.some(item => item.color === '#123abc' && item.text.includes('FOURTH:')));
    const savedHash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(await mode(page).getAttribute('aria-pressed'), 'true', 'Saving must keep automatic highlighting enabled.');
    await selectLine(page, 0); await waitCount(page, savedHash, 4);
    await page.keyboard.press('Control+z'); await waitCount(page, savedHash, 3);
    assert.equal(await mode(page).getAttribute('aria-pressed'), 'true');
    await page.reload(); await open(page, target);
    await mode(page).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('folio.highlightColor')), '#123abc');
    assert.equal(await picker(page).locator('.highlight-color-current').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(18, 58, 188)');
    await waitCount(page, savedHash, 3);
    assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'), sourceHash);
    return { automaticSelections: 2, toggleOffAddsNoAnnotation: true, customColor: '#123abc', standardQuads: true, originalUnchanged: true, colorAndAnnotationsPersist: true, automaticModeSurvivesSave: true };
  });

  await check('palette-presets-keyboard-outside-and-contextual-visibility', async page => {
    assert.equal(await picker(page).count(), 0);
    await mode(page).click();
    await picker(page).click(); assert.equal(await page.locator('.highlight-color-presets button').count(), 12);
    for (const name of ['Amarillo', 'Verde', 'Rosa', 'Violeta', 'Azul', 'Naranja', 'Rojo', 'Menta', 'Cian', 'Índigo', 'Lima', 'Gris']) assert.equal(await page.getByRole('button', { name: `Color ${name}`, exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Color Naranja', exact: true }).click();
    assert.equal((await annotations(page)).length, 0);
    await picker(page).focus(); await picker(page).press('ArrowDown'); await palette(page).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Color Naranja');
    await page.keyboard.press('ArrowRight'); assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Color Rojo');
    await page.keyboard.press('Enter'); await palette(page).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Color del resaltador');
    await picker(page).press('ArrowDown'); await palette(page).waitFor(); await page.keyboard.press('Escape'); await palette(page).waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 800, height: 600 }); await picker(page).click();
    const box = await palette(page).boundingBox(); assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= 800 && box.y + box.height <= 600);
    await page.getByRole('textbox', { name: 'Número de página', exact: true }).click(); await palette(page).waitFor({ state: 'detached' });
    return { namedPresets: 12, contextualVisibility: true, choosingColorAddsNoAnnotation: true, keyboardNavigation: true, escapeAndOutsideDismiss: true, compactViewportClamped: true };
  });
  assert.equal(errors.length, 0, JSON.stringify(errors));
} finally {
  await browser?.close(); preview.kill();
  fs.writeFileSync(path.join(output, 'highlight-mode-results.json'), JSON.stringify({ passed: !process.exitCode, results, errors }, null, 2));
}
