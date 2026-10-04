import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';

// These tests use actual mouse drags through the PDF.js text layer. They do not
// construct a Selection programmatically or call the annotation implementation.
const root = process.cwd();
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const source = path.join(output, 'highlighting-source.pdf');
const lines = [
  'FIRST LINE: Select only these words.',
  'SECOND LINE: Highlight follows the text.',
  'THIRD LINE: The spaces between lines stay clear.',
  'LAST LINE: Remaining content is preserved.',
];
const fixture = await PDFDocument.create();
const font = await fixture.embedFont(StandardFonts.Helvetica);
const fixturePage = fixture.addPage([600, 760]);
for (let i = 0; i < lines.length; i++) fixturePage.drawText(lines[i], { x: 60, y: 665 - i * 35, size: 14, font });

const raster = await PDFDocument.create();
const rasterPage = raster.addPage([250, 120]);
rasterPage.drawText('IMAGE WITHOUT A TEXT LAYER', { x: 10, y: 65, size: 12 });
const rasterDocument = new mupdf.PDFDocument(await raster.save());
const rasterNativePage = rasterDocument.loadPage(0);
const pixmap = rasterNativePage.toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
const image = await fixture.embedPng(new Uint8Array(pixmap.asPNG()));
fixturePage.drawImage(image, { x: 60, y: 260, width: 250, height: 120 });
const nextLine = 'NEXT PAGE: Continue selecting words.';
fixture.addPage([600, 760]).drawText(nextLine, { x: 60, y: 665, size: 14, font });
pixmap.destroy(); rasterNativePage.destroy(); rasterDocument.destroy();
fs.writeFileSync(source, await fixture.save());
const originalText = operateDocument(fs.readFileSync(source), { operation: 'text' });

const chrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(fs.existsSync);
assert(chrome, 'CHROME_PATH must identify an installed Chrome or Edge.');
const port = process.env.FOLIO_HIGHLIGHT_PORT || '4177';
const origin = `http://127.0.0.1:${port}`;
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'),
  'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let browser, log = '';
preview.stdout.on('data', data => { log += data; });
preview.stderr.on('data', data => { log += data; });
const results = [], errors = [];

async function open(page, file) {
  await page.locator('.app-header input[type=file]').setInputFiles(file);
  await page.getByRole('heading', { name: path.basename(file), exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.getByRole('combobox', { name: 'Nivel de zoom', exact: true }).selectOption('100');
  await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
  await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').first().waitFor();
}

async function check(id, action, file = source) {
  if (process.env.FOLIO_HIGHLIGHT_TEST && !new RegExp(process.env.FOLIO_HIGHLIGHT_TEST).test(id)) return;
  const context = await browser.newContext({ viewport: { width: 1360, height: 1050 }, acceptDownloads: true });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push({ id, error: error.message }));
  try {
    await page.goto(origin); await open(page, file);
    const evidence = await action(page);
    results.push({ id, status: 'passed', ...evidence });
  } catch (error) {
    process.exitCode = 1;
    results.push({ id, status: 'failed', error: error.stack });
    await page.screenshot({ path: path.join(output, `failure-${id}.png`), animations: 'disabled' });
  } finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
}

async function spanPoint(page, text, offset, edge, number = 1) {
  const locator = page.locator(`.pdf-page-wrap[data-page-number="${number}"] .textLayer span`).filter({ hasText: text }).first();
  await locator.waitFor();
  return locator.evaluate((span, { offset, edge }) => {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    const length = nodes.reduce((sum, node) => sum + node.textContent.length, 0);
    const character = Math.max(0, Math.min(length - 1, edge === 'end' ? offset - 1 : offset));
    const charRect = index => {
      let remaining = index;
      for (const node of nodes) {
        if (remaining < node.textContent.length) {
          const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, remaining + 1);
          const rect = range.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        }
        remaining -= node.textContent.length;
      }
      throw new Error('The text has no measurable character.');
    };
    const rect = charRect(character), first = charRect(0), next = charRect(Math.min(1, length - 1));
    const dx = (next.left + next.right - first.left - first.right) / 2;
    const dy = (next.top + next.bottom - first.top - first.bottom) / 2;
    const trailing = edge === 'end';
    if (Math.abs(dx) >= Math.abs(dy)) return { x: ((dx >= 0) === trailing) ? rect.right - rect.width * .03 : rect.left + rect.width * .03, y: (rect.top + rect.bottom) / 2 };
    return { x: (rect.left + rect.right) / 2, y: ((dy >= 0) === trailing) ? rect.bottom - rect.height * .03 : rect.top + rect.height * .03 };
  }, { offset, edge });
}

async function drag(page, from, to, { checkPreview = true } = {}) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  if (checkPreview) assert.equal(await page.locator('.tool-highlight .highlight-annotation.preview').count(), 0, 'Text highlighting must not show an area rectangle while dragging.');
  await page.mouse.move(to.x, to.y, { steps: 8 });
  if (process.env.FOLIO_HIGHLIGHT_DEBUG) console.log(JSON.stringify({ gesture: { from, to }, nativeSelection: await page.evaluate(() => {
    const selection = window.getSelection();
    const describe = node => ({ text: node?.textContent, parentText: node?.parentElement?.textContent, parentTag: node?.parentElement?.tagName });
    return { text: selection?.toString(), anchorOffset: selection?.anchorOffset, focusOffset: selection?.focusOffset, anchor: describe(selection?.anchorNode), focus: describe(selection?.focusNode), spans: [...document.querySelectorAll('.pdf-page-wrap[data-page-number="1"] .textLayer span')].map(span => ({ text: span.textContent, bounds: span.getBoundingClientRect().toJSON(), transform: getComputedStyle(span).transform })) };
  }) }));
  await page.mouse.up();
}

async function dragText(page, first, from, last, to, reverse = false, options) {
  const a = await spanPoint(page, first, from, 'start');
  const b = await spanPoint(page, last, to, 'end');
  await drag(page, reverse ? b : a, reverse ? a : b, options);
}

async function highlight(page) { await page.getByRole('button', { name: 'Resaltado automático (H)', exact: true }).click(); }

async function save(page, id, { original = originalText } = {}) {
  await page.locator('.highlight-annotation').first().waitFor();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar', exact: true }).click();
  const file = await download, target = path.join(output, `highlighting-${id}.pdf`); await file.saveAs(target);
  await page.waitForFunction(() => document.querySelector('.download-button:not([disabled])') && !document.querySelector('.loading-overlay') && !document.querySelector('.pdf-page-wrap[data-page-number="1"] .page-loading'));
  const bytes = fs.readFileSync(target);
  if (original) assert.deepEqual(operateDocument(bytes, { operation: 'text' }), original, 'Highlighting must preserve all original text.');
  const annotations = inspectDocument(bytes).annotations.filter(annotation => annotation.kind === 'highlight');
  const document = new mupdf.PDFDocument(bytes); let standardHighlights = 0;
  for (const number of new Set(annotations.map(annotation => annotation.page))) {
    const pageNative = document.loadPage(number - 1), native = pageNative.getAnnotations();
    for (const annotation of native) if (annotation.getType() === 'Highlight') {
      standardHighlights++;
      assert(annotation.getObject().get('QuadPoints').length > 0 && annotation.getObject().get('QuadPoints').length % 8 === 0, 'The exported file must contain standard PDF QuadPoints.');
    }
    for (const annotation of native) annotation.destroy(); pageNative.destroy();
  }
  assert(standardHighlights > 0); document.destroy();
  return annotations;
}

function textOnly(annotation, { maxHeight = 24, minimumLines = 1 } = {}) {
  assert(annotation.quads?.length, 'A text highlight needs quads rather than a rectangle fallback.');
  for (const quad of annotation.quads) {
    assert(quad.length === 8 && quad.every(Number.isFinite));
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    assert(Math.max(...ys) - Math.min(...ys) <= maxHeight, `A single quad bridges the line spacing: ${JSON.stringify(quad)}`);
  }
  const centers = annotation.quads.map(quad => (quad[1] + quad[3] + quad[5] + quad[7]) / 4);
  const bands = centers.reduce((list, y) => { if (!list.some(existing => Math.abs(existing - y) < 2)) list.push(y); return list; }, []);
  assert(bands.length >= minimumLines, `Expected ${minimumLines} independently highlighted lines; found ${bands.length}.`);
  return { quads: annotation.quads.length, lineBands: bands.length, selectedText: annotation.text };
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    if (preview.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, log || 'Preview did not start.');
  browser = await chromium.launch({ executablePath: chrome, headless: true });

  await check('single-line-partial-word-selection', async page => {
    await highlight(page);
    const phrase = 'Select only these words';
    await dragText(page, lines[0], lines[0].indexOf(phrase), lines[0], lines[0].indexOf(phrase) + phrase.length);
    const annotations = await save(page, 'single-line'); assert.equal(annotations.length, 1);
    assert.equal(annotations[0].text.trim(), phrase);
    return { ...textOnly(annotations[0]), contentPreserved: true };
  });

  for (const reverse of [false, true]) await check(`multi-line-${reverse ? 'reverse' : 'forward'}-selection`, async page => {
    await highlight(page);
    await dragText(page, lines[0], lines[0].indexOf('Select'), lines[1], lines[1].length - 1, reverse);
    const annotations = await save(page, `multi-${reverse ? 'reverse' : 'forward'}`); assert.equal(annotations.length, 1);
    assert(annotations[0].text.includes('Select only these words'));
    assert(annotations[0].text.includes('Highlight follows the text'));
    assert(!annotations[0].text.includes('THIRD LINE'));
    await page.screenshot({ path: path.join(output, `highlighting-multi-${reverse ? 'reverse' : 'forward'}.png`), animations: 'disabled' });
    return { ...textOnly(annotations[0], { minimumLines: 2 }), reverse, noRectanglePreview: true };
  });

  await check('blank-and-image-drag-create-no-highlight', async page => {
    await highlight(page);
    const frame = await page.locator('.pdf-page').first().boundingBox();
    await drag(page, { x: frame.x + 350, y: frame.y + 300 }, { x: frame.x + 510, y: frame.y + 400 });
    assert.equal(await page.locator('.highlight-annotation').count(), 0, 'An empty area must not become a rectangle annotation.');
    await drag(page, { x: frame.x + 65, y: frame.y + 395 }, { x: frame.x + 290, y: frame.y + 455 });
    assert.equal(await page.locator('.highlight-annotation').count(), 0, 'An image without recognized text must not become a rectangle annotation.');
    return { blankAreaAnnotations: 0, imageAreaAnnotations: 0, rectanglePreviews: 0 };
  });

  await check('select-text-then-apply-existing-highlight-button', async page => {
    await dragText(page, lines[0], 0, lines[1], lines[1].length, false, { checkPreview: false });
    assert((await page.evaluate(() => window.getSelection()?.toString() || '')).includes('Highlight follows the text'));
    await highlight(page);
    const annotations = await save(page, 'preselected'); assert.equal(annotations.length, 1);
    assert.equal(annotations[0].text.replace(/\s+/g, ' ').trim(), `${lines[0]}${lines[1]}`, 'The selected range must contain exactly the requested first two lines.');
    return { ...textOnly(annotations[0], { minimumLines: 2 }), existingToolbarControlAppliesSelection: true };
  });

  for (const angle of [90, 180, 270]) await check(`rotated-${angle}-view-and-zoom-keep-text-quad-coordinates`, async page => {
    for (let i = 0; i < angle / 90; i++) await page.getByRole('button', { name: 'Rotar vista 90 grados', exact: true }).click();
    await page.getByRole('combobox', { name: 'Nivel de zoom', exact: true }).selectOption('150');
    await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
    await page.waitForFunction(angle => {
      const canvas = document.querySelector('.pdf-page-wrap[data-page-number="1"] canvas');
      return canvas?.dataset.rendering === 'false' && canvas.dataset.renderScale === '1.5' && canvas.dataset.renderRotation === String(angle);
    }, angle);
    await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: lines[0] }).first().scrollIntoViewIfNeeded();
    await highlight(page);
    await dragText(page, lines[0], 0, lines[0], lines[0].length);
    const annotations = await save(page, `rotated-${angle}`); assert.equal(annotations.length, 1);
    assert.equal(annotations[0].text.trim(), lines[0]);
    return { ...textOnly(annotations[0]), viewRotation: angle, zoomPercent: 150 };
  });

  await check('search-mark-wrappers-do-not-expand-text-selection', async page => {
    await page.getByRole('button', { name: 'Buscar en el PDF', exact: true }).click();
    await page.getByRole('textbox', { name: 'Buscar texto en el PDF', exact: true }).fill('only');
    await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer mark').first().waitFor();
    await highlight(page); const phrase = 'Select only these words';
    await dragText(page, lines[0], lines[0].indexOf(phrase), lines[0], lines[0].indexOf(phrase) + phrase.length);
    const annotations = await save(page, 'search-mark'); assert.equal(annotations.length, 1);
    assert.equal(annotations[0].text.trim(), phrase);
    const evidence = textOnly(annotations[0]); assert.equal(evidence.lineBands, 1);
    const rectangles = annotations[0].quads.map(quad => ({ left: Math.min(quad[0], quad[2], quad[4], quad[6]), right: Math.max(quad[0], quad[2], quad[4], quad[6]) })).sort((a, b) => a.left - b.left);
    for (let i = 1; i < rectangles.length; i++) assert(rectangles[i].left >= rectangles[i - 1].right - 1, 'Search mark wrappers must not create overlapping duplicate highlight geometry.');
    return { ...evidence, markWrapperNotDuplicated: true };
  });

  await check('selection-across-pages-creates-text-quads-on-each-page', async page => {
    await page.getByRole('combobox', { name: 'Nivel de zoom', exact: true }).selectOption('75');
    await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
    await page.locator('.pdf-page-wrap[data-page-number="2"] .textLayer span').first().waitFor();
    await highlight(page);
    const start = await spanPoint(page, lines[3], 0, 'start');
    const end = await spanPoint(page, nextLine, nextLine.length, 'end', 2);
    const hint = await page.locator('.annotation-tool-hint').count() ? await page.locator('.annotation-tool-hint').boundingBox() : null;
    assert(!hint || end.x < hint.x || end.x > hint.x + hint.width || end.y < hint.y || end.y > hint.y + hint.height, 'The selection endpoint must be on the PDF rather than under the tool hint.');
    await drag(page, start, end);
    await page.waitForFunction(() => document.querySelectorAll('.highlight-annotation').length === 2);
    await page.getByRole('button', { name: 'Deshacer (Ctrl+Z)', exact: true }).click();
    assert.equal(await page.locator('.highlight-annotation').count(), 0, 'One cross-page selection must undo as one action.');
    await page.getByRole('button', { name: 'Rehacer (Ctrl+Y)', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.highlight-annotation').length === 2);
    const annotations = await save(page, 'cross-pages'); assert.equal(annotations.length, 2);
    const first = annotations.find(annotation => annotation.page === 1), second = annotations.find(annotation => annotation.page === 2);
    assert(first?.text.includes(lines[3])); assert(second?.text.includes(nextLine));
    assert(!first.text.includes('NEXT PAGE') && !second.text.includes('LAST LINE'));
    textOnly(first); textOnly(second);
    return { highlightedPages: [1, 2], separatePageAnnotations: 2, pageCaptionExcluded: true, standardTextQuads: true, selectionUndoRedoAsOneAction: true };
  });

  const realPdf = process.env.FOLIO_HIGHLIGHT_REAL_PDF || 'C:/Users/Emilio/Downloads/Reumatologia_Nefrologia_Guia_Clinica.pdf';
  if (fs.existsSync(realPdf)) await check('real-user-pdf-paragraph-selection', async page => {
    const sourceHash = createHash('sha256').update(fs.readFileSync(realPdf)).digest('hex');
    const first = page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: 'Dos guías' }).first();
    const last = page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: 'renales.' }).first();
    const firstText = await first.textContent(), lastText = await last.textContent();
    await highlight(page);
    await dragText(page, 'Dos guías', firstText.indexOf('Dos guías'), 'renales.', lastText.indexOf('renales.') + 'renales.'.length);
    const annotations = await save(page, 'real-paragraph', { original: operateDocument(fs.readFileSync(realPdf), { operation: 'text' }) });
    const selected = annotations.find(annotation => annotation.text.startsWith('Dos guías') && annotation.text.endsWith('renales.'));
    assert(selected, JSON.stringify(annotations));
    await page.screenshot({ path: path.join(output, 'highlighting-real-paragraph.png'), animations: 'disabled' });
    const evidence = textOnly(selected, { maxHeight: 25, minimumLines: 3 }); assert.equal(evidence.lineBands, 3, 'Only the three paragraph lines should be highlighted.');
    assert.equal(createHash('sha256').update(fs.readFileSync(realPdf)).digest('hex'), sourceHash);
    return { ...evidence, userPdfPages: 56, originalFileUnchanged: true, sourceSha256: sourceHash };
  }, realPdf);
} finally {
  await browser?.close(); preview.kill();
  fs.writeFileSync(path.join(output, 'highlighting-results.json'), JSON.stringify({ results, errors }, null, 2));
}
if (errors.length) { console.log(JSON.stringify({ uncaughtErrors: errors })); process.exitCode = 1; }
