import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';

const root = process.cwd(), output = path.join(root, 'test-results'); fs.mkdirSync(output, { recursive: true });
const source = path.join(output, 'selection-menu-source.pdf');
const first = 'MENU: Copy these selected words.', target = 'Copy these selected words';
const second = 'COMMENT: Attach a note to this text.';
const edge = 'EDGE: Select these words.';
const fixture = await PDFDocument.create(), font = await fixture.embedFont(StandardFonts.Helvetica);
const sheet = fixture.addPage([600, 760]);
sheet.drawText(first, { x: 60, y: 665, size: 14, font });
sheet.drawText(second, { x: 60, y: 620, size: 14, font });
sheet.drawText(edge, { x: 60, y: 24, size: 14, font });
fixture.addPage([600, 760]).drawText('SECOND PAGE: Keep the toolbar keys here.', { x: 60, y: 665, size: 14, font });
const bytes = new Uint8Array(await fixture.save()); fs.writeFileSync(source, bytes);
const longSource = path.join(output, 'selection-menu-long-copy.pdf'), longFixture = await PDFDocument.create(), longFont = await longFixture.embedFont(StandardFonts.Helvetica), longPage = longFixture.addPage([600, 760]);
const longLines = Array.from({ length: 90 }, (_, i) => `LONG_${String(i).padStart(3, '0')}: ${'abcdefghij'.repeat(7)}`);
for (let i = 0; i < longLines.length; i++) longPage.drawText(longLines[i], { x: 60, y: 735 - i * 7.7, size: 7, font: longFont });
fs.writeFileSync(longSource, await longFixture.save());
const readOnly = path.join(output, 'selection-menu-readonly.pdf'), noCopy = path.join(output, 'selection-menu-no-copy.pdf');
fs.writeFileSync(readOnly, operateDocument(bytes, { operation: 'protect', userPassword: '', ownerPassword: 'qa-owner', permissions: 16 }));
fs.writeFileSync(noCopy, operateDocument(bytes, { operation: 'protect', userPassword: '', ownerPassword: 'qa-owner', permissions: 32 }));
const chrome = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
assert(chrome, 'Chrome or Edge must be installed.');
const port = process.env.FOLIO_SELECTION_MENU_PORT || '4180', origin = `http://127.0.0.1:${port}`;
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let browser, log = ''; preview.stdout.on('data', data => { log += data; }); preview.stderr.on('data', data => { log += data; });
const results = [], errors = [];
const toolbar = page => page.getByRole('toolbar', { name: 'Herramientas del texto seleccionado', exact: true });

async function open(page, file) {
  await page.locator('.app-header input[type=file]').setInputFiles(file);
  await page.getByRole('heading', { name: path.basename(file), exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.getByRole('combobox', { name: 'Nivel de zoom' }).selectOption('100');
  await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
  // Zoom intentionally keeps the previous bitmap and text visible. A detached
  // first-paint loader alone does not mean the new selection layer is ready.
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.pdf-page-wrap[data-page-number="1"] .page-content>canvas');
    return canvas?.dataset.rendering === 'false' && Number(canvas.dataset.renderScale) === 1;
  });
  await page.locator('.textLayer span').first().waitFor();
}
async function point(page, text, index, end = false) {
  const span = page.locator('.textLayer span').filter({ hasText: text }).first();
  return span.evaluate((element, { index, end }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node, offset = end ? index - 1 : index;
    while ((node = walker.nextNode())) {
      if (offset < node.textContent.length) { const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1); const box = range.getBoundingClientRect(); return { x: end ? box.right - box.width * .03 : box.left + box.width * .03, y: (box.top + box.bottom) / 2 }; }
      offset -= node.textContent.length;
    }
    throw new Error('No measurable character at the requested offset.');
  }, { index, end });
}
async function select(page, text = first, from = first.indexOf(target), to = first.indexOf(target) + target.length) {
  const a = await point(page, text, from), b = await point(page, text, to, true);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 });
  assert.equal(await toolbar(page).count(), 0, 'The popup must stay hidden while selection is being dragged.');
  await page.mouse.up(); await toolbar(page).waitFor();
}
async function save(page, name) {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar', exact: true }).click();
  const file = await pending, target = path.join(output, name); await file.saveAs(target);
  await page.locator('.loading-overlay').waitFor({ state: 'detached' }); return inspectDocument(new Uint8Array(fs.readFileSync(target)));
}
async function check(id, action, file = source, viewport = { width: 1360, height: 900 }) {
  if (process.env.FOLIO_SELECTION_MENU_TEST && !new RegExp(process.env.FOLIO_SELECTION_MENU_TEST).test(id)) return;
  const context = await browser.newContext({ viewport, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] }), page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push({ id, error: error.message }));
  if (process.env.FOLIO_SELECTION_MENU_DEBUG) {
    page.on('console', message => { if (message.text().startsWith('MENU_DEBUG ')) console.log(message.text()); });
    await page.addInitScript(() => {
      const report = type => console.log('MENU_DEBUG ' + JSON.stringify({ type, time: Math.round(performance.now()), text: window.getSelection()?.toString(), scroll: document.querySelector('.reading-area')?.scrollTop, menu: !!document.querySelector('.text-selection-menu') }));
      for (const name of ['selectionchange', 'pointerdown', 'pointerup', 'mouseup', 'scroll']) document.addEventListener(name, () => report(name), true);
      window.addEventListener('folio:text-selection-finished', () => report('finished'));
      new MutationObserver(() => report('mutation')).observe(document, { subtree: true, childList: true });
    });
  }
  try { await page.goto(origin); await open(page, file); const evidence = await action(page); results.push({ id, status: 'passed', ...evidence }); }
  catch (error) { process.exitCode = 1; results.push({ id, status: 'failed', error: error.stack }); await page.screenshot({ path: path.join(output, `failure-${id}.png`), animations: 'disabled' }); }
  finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
}
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} if (preview.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  await check('contextual-copy-preserves-selection-and-highlight', async page => {
    await select(page); await toolbar(page).getByRole('button', { name: 'Copiar', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Texto copiado.' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), target);
    assert.equal(await page.evaluate(() => window.getSelection().toString()), target);
    await toolbar(page).getByRole('button', { name: 'Resaltar', exact: true }).click();
    await page.locator('.highlight-annotation').first().waitFor(); await toolbar(page).waitFor({ state: 'detached' });
    const document = await save(page, 'ui-selection-menu-highlight.pdf');
    assert.equal(document.annotations.length, 1); assert.equal(document.annotations[0].text, target); assert(document.annotations[0].quads?.length);
    return { clipboardActualText: true, selectionPreservedAfterCopy: true, standardPdfHighlight: true };
  });
  await check('contextual-comment-creates-standard-note', async page => {
    await select(page, second, 9, second.length - 1); await toolbar(page).getByRole('button', { name: 'Comentar', exact: true }).click();
    await page.getByRole('textbox', { name: 'Texto de la nota', exact: true }).fill('Comentario desde el texto seleccionado.');
    await page.getByRole('button', { name: 'Guardar nota', exact: true }).click();
    await page.locator('.note-marker').waitFor(); await toolbar(page).waitFor({ state: 'detached' });
    const document = await save(page, 'ui-selection-menu-comment.pdf');
    assert.equal(document.annotations.length, 1); assert.equal(document.annotations[0].kind, 'note'); assert.equal(document.annotations[0].text, 'Comentario desde el texto seleccionado.');
    assert.equal(document.annotations[0].page, 1); assert(document.annotations[0].rect[0] > 60 && document.annotations[0].rect[0] < 145);
    return { contextualCommentSaved: true, originalTextPreserved: true };
  });
  await check('contextual-copy-falls-back-when-clipboard-api-rejects', async page => {
    await select(page);
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new DOMException('Clipboard API unavailable for this test', 'NotAllowedError')) }); });
    await toolbar(page).getByRole('button', { name: 'Copiar', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Texto copiado.' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), target);
    assert.equal(await page.evaluate(() => window.getSelection().toString()), target);
    return { nativeCopyFallback: true, selectionRestoredAfterFallback: true };
  });
  await check('contextual-copy-keeps-more-than-5000-selected-characters', async page => {
    const a = await point(page, longLines[0], 0), b = await point(page, longLines.at(-1), longLines.at(-1).length, true);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 18 }); await page.mouse.up(); await toolbar(page).waitFor();
    await toolbar(page).getByRole('button', { name: 'Copiar', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Texto copiado.' }).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert(copied.length > 5000); assert.equal(copied.replace(/\r?\n/g, ''), longLines.join(''));
    return { fullCharactersCopied: copied.length, annotationTextLimitDoesNotTruncateClipboard: true };
  }, longSource);
  await check('contextual-menu-dismisses-on-scroll-escape-and-tab-change', async page => {
    await select(page); await page.mouse.move(1200, 400); await page.mouse.wheel(0, 70); await toolbar(page).waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.reading-area').scrollTop > 0);
    await page.locator('.reading-area').evaluate(el => { el.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('.reading-area').scrollTop === 0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Clear the previous selection before selecting again. Dragging its selected
    // characters would start Chromium's native text drag rather than a new range.
    await page.mouse.click(900, 300);
    await select(page);
    await page.keyboard.press('Escape'); await toolbar(page).waitFor({ state: 'detached' });
    await page.mouse.click(900, 300);
    await select(page); await open(page, readOnly); await toolbar(page).waitFor({ state: 'detached' });
    return { scrollingDismisses: true, escapeDismisses: true, documentSwitchDismisses: true };
  });
  await check('contextual-menu-keyboard-arrows-stay-in-toolbar', async page => {
    await select(page); await toolbar(page).getByRole('button', { name: 'Copiar', exact: true }).focus();
    await page.keyboard.press('ArrowRight'); assert.equal(await toolbar(page).getByRole('button', { name: 'Resaltar', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('End'); assert.equal(await toolbar(page).getByRole('button', { name: 'Comentar', exact: true }).evaluate(el => el === document.activeElement), true);
    assert.equal(await page.getByRole('textbox', { name: 'Número de página', exact: true }).inputValue(), '1');
    return { keyboardNavigation: true, pdfPageUnchanged: true };
  });
  await check('readonly-selection-menu-only-copies', async page => {
    await select(page); assert.equal(await toolbar(page).getByRole('button').count(), 1);
    await toolbar(page).getByRole('button', { name: 'Copiar', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Texto copiado.' }).waitFor(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), target);
    return { copyPermissionRespected: true, annotationActionsAbsent: true };
  }, readOnly);
  await check('copy-protected-document-has-no-selection-menu', async page => {
    const a = await point(page, first, 6), b = await point(page, first, first.length - 1, true);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up();
    assert.equal(await toolbar(page).count(), 0); assert(await page.getByRole('button', { name: 'Resaltado automático (H)', exact: true }).isDisabled());
    return { forbiddenCopyActionAbsent: true };
  }, noCopy);
  await check('contextual-menu-fits-narrow-viewport-near-page-bottom', async page => {
    await page.locator('.textLayer span').filter({ hasText: edge }).first().scrollIntoViewIfNeeded();
    await select(page, edge, 6, edge.length - 1);
    const geometry = await toolbar(page).evaluate(el => { const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, bodyWidth: document.documentElement.scrollWidth }; });
    assert(geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height, JSON.stringify(geometry));
    assert.equal(geometry.bodyWidth, geometry.width); await page.screenshot({ path: path.join(output, 'selection-menu-narrow.png'), animations: 'disabled' });
    return { noViewportOverflow: true, viewport: [geometry.width, geometry.height] };
  }, source, { width: 360, height: 500 });
  assert.equal(errors.length, 0, JSON.stringify(errors));
} finally {
  if (browser) await browser.close(); preview.kill();
  fs.writeFileSync(path.join(output, 'selection-menu-results.json'), JSON.stringify({ capturedAt: new Date().toISOString(), results, errors }, null, 2));
}
