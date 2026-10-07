import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { findChrome } from './browser.mjs';
import { enterAnnotationMode } from './ui-helpers.mjs';
import { storedSession, waitForSession } from './session-helpers.mjs';

// A two-column table drawn row by row, as PDFs usually store tables: the text
// order alternates left, right, left, right. Dragging down the left column must
// highlight only that column; a plain paragraph must still highlight every line.
const root = process.cwd(), output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const source = path.join(output, 'column-selection-source.pdf');
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page1 = pdf.addPage([600, 780]);
const left = ['Izquierda uno: insuficiencia', 'Izquierda dos: disnea', 'Izquierda tres: edemas', 'Izquierda cuatro: fatiga'];
const right = ['Derecha uno: furosemida', 'Derecha dos: enalapril', 'Derecha tres: carvedilol', 'Derecha cuatro: espironolactona'];
left.forEach((text, row) => { page1.drawText(text, { x: 50, y: 700 - row * 26, size: 13, font }); page1.drawText(right[row], { x: 330, y: 700 - row * 26, size: 13, font }); });
const paragraph = ['Primera linea del parrafo que ocupa el ancho de la pagina entera sin columnas.', 'Segunda linea del parrafo que tambien ocupa todo el ancho de la pagina.', 'Tercera linea del parrafo para comprobar el resaltado normal.'];
paragraph.forEach((text, row) => page1.drawText(text, { x: 50, y: 520 - row * 22, size: 12, font }));
const bytes = await pdf.save(), hash = createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(source, bytes);
const chrome = findChrome(); assert(chrome, 'An installed Chrome or Edge is required.');
const port = process.env.FOLIO_COLUMN_PORT || '4191', origin = `http://127.0.0.1:${port}`;
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let browser; const results = [], errors = [];
const span = (page, text) => page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: text }).first();
async function drag(page, from, to) {
  const a = await span(page, from).boundingBox(), b = await span(page, to).boundingBox(); assert(a && b);
  await page.mouse.move(a.x + 1, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 16 });
  return async () => { await page.mouse.up(); };
}
const highlights = async page => ((await storedSession(page, hash))?.annotations || []).filter(item => item.kind === 'highlight');
try {
  for (let i = 0; i < 40; i++) { try { await fetch(origin); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
  browser = await chromium.launch({ executablePath: chrome });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1050 } }), page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('.app-header input[type=file]').setInputFiles(source);
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.getByRole('combobox', { name: 'Nivel de zoom', exact: true }).selectOption('100');
  await span(page, left[0]).waitFor();
  await enterAnnotationMode(page);
  await page.getByRole('button', { name: 'Resaltador (H)', exact: true }).click();

  // Left column, rows two to four.
  let release = await drag(page, left[1], left[3]);
  await page.locator('.column-selection-preview > span').first().waitFor();
  const previewCount = await page.locator('.column-selection-preview > span').count();
  await page.screenshot({ path: path.join(output, 'column-selection-preview.png') });
  await release();
  await waitForSession(page, (session, id) => id === hash && session.annotations?.filter(item => item.kind === 'highlight').length === 1);
  let [column] = await highlights(page);
  assert.equal(column.quads.length, 3, `Three left-column lines: ${JSON.stringify(column.quads)}`);
  for (const text of right) assert(!column.text.includes(text.split(':')[0]), `Right column leaked into the highlight: ${column.text}`);
  for (const text of left.slice(1)) assert(column.text.includes(text), `Missing left-column line: ${column.text}`);
  const columnRight = Math.max(...column.quads.flatMap(quad => quad.filter((_, index) => index % 2 === 0)));
  assert(columnRight < 330, `Highlight reaches the right column (x=${columnRight}).`);
  results.push({ id: 'left-column-only', passed: true, previewCount, text: column.text });

  // A paragraph across the page width keeps every line and its whole width.
  release = await drag(page, paragraph[0].slice(0, 20), paragraph[2].slice(-20));
  await release();
  await waitForSession(page, (session, id) => id === hash && session.annotations?.filter(item => item.kind === 'highlight').length === 2);
  const free = (await highlights(page)).find(item => item.id !== column.id);
  assert.equal(free.quads.length, 3, 'A free paragraph keeps its three lines.');
  assert(free.text.includes('Segunda linea'), free.text);
  results.push({ id: 'paragraph-unchanged', passed: true });

  // Crossing from the left column into the right one is a deliberate choice and is kept.
  release = await drag(page, left[0], right[1]);
  await release();
  await waitForSession(page, (session, id) => id === hash && session.annotations?.filter(item => item.kind === 'highlight').length === 3);
  const crossing = (await highlights(page)).at(-1);
  assert(crossing.text.includes('Derecha uno'), `A selection ending in the other column keeps it: ${crossing.text}`);
  results.push({ id: 'cross-column-kept', passed: true });
  assert.deepEqual(errors, []);
} catch (error) { process.exitCode = 1; results.push({ passed: false, error: String(error?.stack || error).slice(0, 1200) }); }
finally { await browser?.close(); preview.kill(); console.log(JSON.stringify({ passed: process.exitCode !== 1, results })); }
