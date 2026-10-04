import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { writeAnnotations } from '../../src/engine/mupdf-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'test-results');
await mkdir(output, { recursive: true });
const chrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(existsSync);
assert(chrome, 'CHROME_PATH debe apuntar a Chrome, Edge o Chromium.');

const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'),
  'preview', '--host', '127.0.0.1', '--port', '4175', '--strictPort'], { cwd: root, stdio: 'pipe' });
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
  assert(value.reader.y <= 96, 'Las barras superiores deben dejar espacio para el documento.');
  assert(value.reader.bottom <= value.height, 'El PDF debe permanecer dentro de la ventana.');
}
function assertStationary(before, after) {
  assertFrame(after);
  for (const part of ['header', 'toolbar', 'reader']) assert.deepEqual(after[part], before[part], `${part} se movió al usar la rueda.`);
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
  await page.getByRole('heading', { name: 'Abrir PDF', exact: true }).waitFor();
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
  await page.getByRole('button', { name: 'Preferencias de lectura', exact: true }).click();
  await page.getByRole('button', { name: 'Oscuro', exact: true }).click();
  await page.getByRole('button', { name: 'Listo', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'interfaz-compacta-oscura.png'), animations: 'disabled' });
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(path.join(output, 'layout-results.json'), JSON.stringify({ platform: process.platform, results,
    sidebarScrollIndependent: true, notesScrollIndependent: true, ctrlWheelZoom: true, cursorAnchorPreserved: true, uncaughtErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: results.length, independentPanes: ['PDF', 'miniaturas', 'comentarios'], errors }));
} finally {
  await browser?.close();
  preview.kill();
}
