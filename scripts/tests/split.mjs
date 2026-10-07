// Dividir PDF: planning of parts and names, the engine's split operation (one part per
// plan, outline kept, progress per part) and the tool end to end in the browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { unzipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { findChrome } from './browser.mjs';
import { chapterParts, defaultNames, equalParts, everyParts, fileNames, rangeParts } from '../../src/split.ts';
import { operateDocument } from '../../src/engine/operations.mjs';

const pages = parts => parts.map(part => [part.first, part.last]);

// Planning.
assert.deepEqual(pages(rangeParts('1-3, 5 ; 8-', 10).parts), [[1, 3], [5, 5], [8, 10]]);
assert.equal(rangeParts('1-3, 5, 8-', 10).skipped, '4, 6–7');
assert.equal(rangeParts('1-10, 2-4', 10).skipped, '');
assert.throws(() => rangeParts('3-1', 10), /inicio/);
assert.throws(() => rangeParts('1-11', 10), /no existen/);
assert.throws(() => rangeParts('a', 10), /no es un intervalo/);
assert.throws(() => rangeParts(' , ', 10), /al menos un intervalo/);
assert.deepEqual(pages(everyParts(4, 10)), [[1, 4], [5, 8], [9, 10]]);
assert.deepEqual(pages(equalParts(3, 10)), [[1, 4], [5, 7], [8, 10]]);
assert.throws(() => everyParts(0, 10), /mayor que cero/);
assert.throws(() => equalParts(11, 10), /solo tiene/);
assert.throws(() => everyParts(1, 6000), /máximo/);
const outline = [{ title: 'Libro', page: 3, depth: 0 }, { title: 'Uno', page: 3, depth: 1 }, { title: 'Dos', page: 6, depth: 1 }, { title: 'Sin página', page: null, depth: 1 }, { title: 'Dos bis', page: 6, depth: 2 }];
assert.deepEqual(chapterParts(outline, 1, 10), [{ first: 1, last: 2, title: 'Preliminares' }, { first: 3, last: 5, title: 'Libro' }, { first: 6, last: 10, title: 'Dos' }]);
assert.deepEqual(chapterParts([], 0, 10), []);
assert.deepEqual(fileNames(['a/b:c', 'A B C.pdf', '  ', 'x'.repeat(200) + '.']), ['a b c.pdf', 'A B C (2).pdf', 'Parte 3.pdf', 'x'.repeat(120) + '.pdf']);
assert.deepEqual(defaultNames('Libro', [{ first: 1, last: 1 }, { first: 2, last: 5 }], false), ['Libro — pág. 1.pdf', 'Libro — págs. 2-5.pdf']);
assert.deepEqual(defaultNames('Libro', [{ first: 1, last: 2, title: 'Intro' }, { first: 3, last: 5, title: 'Fin?' }], true), ['01 — Intro.pdf', '02 — Fin.pdf']);

// Engine: a 10-page PDF with a three-chapter outline, split by chapter.
const fixture = await PDFDocument.create(), font = await fixture.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 10; n++) fixture.addPage([200, 200]).drawText(`PAGE ${n}`, { x: 20, y: 100, size: 20, font });
const withOutline = new mupdf.PDFDocument(await fixture.save());
const iterator = withOutline.outlineIterator();
for (const [title, page] of [['Tres', 7], ['Dos', 4], ['Uno', 1]]) iterator.insert({ title, uri: `#page=${page}`, open: true });
const source = withOutline.saveToBuffer('').asUint8Array().slice(); withOutline.destroy();
const order = [], outputs = [], plan = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => ({ page: first + i }));
assert.equal(operateDocument(source, { operation: 'split', parts: [plan(1, 3), plan(4, 6), plan(7, 10)] }, '', (index, part) => { order.push(index); outputs.push(part); }), 3);
assert.deepEqual(order, [0, 1, 2]);
assert.deepEqual(outputs.map(bytes => { const doc = mupdf.Document.openDocument(bytes, 'application/pdf'); try { return [doc.countPages(), doc.loadPage(0).toStructuredText().asText().trim(), (doc.loadOutline() || []).map(item => item.title).join()]; } finally { doc.destroy(); } }),
  [[3, 'PAGE 1', 'Uno'], [3, 'PAGE 4', 'Dos'], [4, 'PAGE 7', 'Tres']]);
assert.throws(() => operateDocument(source, { operation: 'split', parts: [] }, '', () => {}), /no tiene partes/);
assert.throws(() => operateDocument(source, { operation: 'split', parts: [plan(1, 2)] }), /destino/);
const outputDir = path.join(process.cwd(), 'test-results'); fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'split-chapters.pdf'), source);

// UI: tracemonkey (14 pages) into blocks of 5 pages, then chapters of the fixture.
const port = process.env.FOLIO_SPLIT_PORT || '4247';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: 'pipe' });
for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
try {
  for (const [layout, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, ...layout === 'phone' ? { hasTouch: true, isMobile: true } : {} });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const open = async file => {
      await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(file);
      await page.locator('.loading-overlay').waitFor({ state: 'detached' }); await page.locator('.pdf-page-wrap').first().waitFor();
    };
    const tool = async () => {
      if (layout === 'phone') { await page.getByRole('button', { name: 'Más acciones', exact: true }).click(); await page.locator('.mobile-actions-modal').getByRole('button', { name: 'Herramientas' }).click(); }
      else await page.getByRole('button', { name: 'Herramientas', exact: true }).click();
      await page.getByRole('button', { name: 'Dividir PDF', exact: true }).click(); await page.locator('.split-pdf').waitFor();
    };
    const zipOf = async () => {
      const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Dividir y descargar ZIP' }).click();
      const file = await download, target = path.join(outputDir, `split-${layout}.zip`); await file.saveAs(target);
      await page.locator('.workbench').waitFor({ state: 'detached' });
      return Object.entries(unzipSync(fs.readFileSync(target))).map(([name, bytes]) => { const doc = mupdf.Document.openDocument(bytes, 'application/pdf'); try { return [name, doc.countPages()]; } finally { doc.destroy(); } });
    };
    await page.goto('http://127.0.0.1:' + port); await open('.fixtures/tracemonkey.pdf'); await tool();
    assert(await page.locator('.split-mode', { hasText: 'Capítulos' }).isDisabled());
    await page.getByRole('textbox', { name: 'Intervalos de páginas' }).fill('1-3, 20');
    await page.getByRole('alert').filter({ hasText: 'no existen' }).waitFor();
    assert(await page.getByRole('button', { name: 'Dividir y descargar ZIP' }).isDisabled());
    await page.locator('.split-mode', { hasText: 'Cada N páginas' }).click();
    await page.getByRole('spinbutton', { name: 'Páginas por archivo' }).fill('5');
    await page.waitForFunction(() => document.querySelectorAll('.split-part').length === 3);
    await page.getByRole('textbox', { name: 'Nombre del archivo 2' }).fill('Mitad: centro');
    assert.deepEqual(await zipOf(), [['tracemonkey — págs. 1-5.pdf', 5], ['Mitad centro.pdf', 5], ['tracemonkey — págs. 11-14.pdf', 4]]);
    await open(path.join(outputDir, 'split-chapters.pdf')); await tool();
    await page.locator('.split-mode', { hasText: 'Capítulos' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.split-part').length === 3);
    assert.deepEqual(await zipOf(), [['01 — Uno.pdf', 3], ['02 — Dos.pdf', 3], ['03 — Tres.pdf', 4]]);
    console.log(layout, 'ok');
    await context.close();
  }
} finally { await browser.close(); server.kill(); }
console.log('split ok');
