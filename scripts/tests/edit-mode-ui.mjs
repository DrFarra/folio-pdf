// Editar inside the reader on desktop: the pages stay (with their zoom), content
// is selected, moved, typed over, deleted and added on the page itself, each
// change made in Editar's live document without a loading screen or a jump, and
// the reader opening the written PDF once Editar closes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { findChrome } from './browser.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';

const output = path.join(process.cwd(), 'test-results'); fs.mkdirSync(output, { recursive: true });
const port = process.env.FOLIO_EDIT_PORT || '4251', origin = `http://127.0.0.1:${port}`;

// A page with two paragraphs and a picture, and a second page.
const swatch = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 30], false);
swatch.getPixels().fill(0); for (let i = 0; i < 40 * 30; i++) swatch.getPixels().set([30, 120, 200], i * 3);
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
const first = pdf.addPage([595, 842]);
first.drawText('Informe trimestral', { x: 60, y: 760, size: 22, font, color: rgb(.1, .1, .1) });
['Las ventas crecieron un doce por ciento respecto', 'al trimestre anterior gracias a la nueva tienda.'].forEach((line, i) => first.drawText(line, { x: 60, y: 700 - i * 16, size: 12, font }));
first.drawImage(await pdf.embedPng(swatch.asPNG()), { x: 360, y: 420, width: 160, height: 120 });
const second = pdf.addPage([595, 842]); second.drawText('Segunda página', { x: 60, y: 760, size: 16, font });
// A box the PDF draws itself, to recolour.
second.drawRectangle({ x: 300, y: 600, width: 120, height: 40, color: rgb(.48, .18, .36) });
// Pages far enough to leave the reader's view.
for (let i = 3; i <= 14; i++) pdf.addPage([595, 842]).drawText(`Página ${i}`, { x: 60, y: 760, size: 16, font });
const fixture = path.join(output, 'edit-mode.pdf'); fs.writeFileSync(fixture, await pdf.save());

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: 'pipe' });
for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
// FOLIO_TEST_BROWSER=webkit runs it in the engine of the macOS app.
const useWebKit = process.env.FOLIO_TEST_BROWSER === 'webkit';
const browser = useWebKit ? await webkit.launch({ headless: true }) : await chromium.launch({ executablePath: findChrome(), headless: true });
const results = [];
const toasts = [];
async function check(id, run) {
  try { results.push({ id, status: 'passed', ...await run() }); }
  catch (error) { await page.screenshot({ path: path.join(output, `edit-mode-${id}.png`) }).catch(() => {}); results.push({ id, status: 'failed', error: error.stack || String(error), toasts: toasts.splice(0) }); }
}
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(20000);
page.on('pageerror', error => console.log('pageerror', error.message));
// Editar's live documents: each opens a worker of its own.
let liveWorkers = 0; page.on('worker', worker => { if (worker.url().includes('session.worker')) liveWorkers++; });
await page.exposeFunction('folioToast', text => toasts.push(text));
await page.addInitScript(() => new MutationObserver(() => { const toast = document.querySelector('.toast'); if (toast && toast.dataset.seen !== toast.textContent) { toast.dataset.seen = toast.textContent; window.folioToast(toast.textContent); } }).observe(document, { subtree: true, childList: true, characterData: true }));

const pageBox = number => page.locator(`.pdf-page-wrap[data-page-number="${number}"] .page-content`).boundingBox();
const toScreen = async (number, x, y) => { const box = await pageBox(number), scale = box.width / 595; return { x: box.x + x * scale, y: box.y + (842 - y) * scale }; };
const settle = async () => {
  await page.waitForFunction(() => !document.querySelector('.edit-toolbar[data-committing=true]') && !document.querySelector('.edit-snapshot') && !document.querySelector('.edit-ghost'));
  await page.waitForFunction(() => [...document.querySelectorAll('.pdf-page-wrap canvas:not(.page-detail)')].every(canvas => canvas.dataset.rendering !== 'true'));
};
// Each change is kept as a draft in the browser; read it rather than downloading
// (headless Chrome blocks repeated downloads from one page).
const readStore = (store, pick) => page.evaluate(([store, pick]) => new Promise((resolve, reject) => {
  const request = indexedDB.open('folio-library');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const all = request.result.transaction(store, 'readonly').objectStore(store).getAll();
    all.onsuccess = () => { const value = all.result.at(-1); resolve(!value ? null : pick === 'bytes' ? btoa(Array.from(new Uint8Array(value), c => String.fromCharCode(c)).join('')) : JSON.stringify(value)); };
    all.onerror = () => reject(all.error);
  };
}), [store, pick]);
let lastDraft = '';
const exported = async name => {
  let value = '';
  for (let i = 0; i < 100 && (!value || value === lastDraft); i++) { value = await readStore('drafts', 'bytes') || ''; if (!value || value === lastDraft) await page.waitForTimeout(100); }
  assert(value && value !== lastDraft, 'The change was saved as a draft');
  lastDraft = value; const bytes = new Uint8Array(Buffer.from(value, 'base64')); fs.writeFileSync(path.join(output, name), bytes);
  return bytes;
};
const sessionShapes = async () => { for (let i = 0; i < 50; i++) { const session = JSON.parse(await readStore('sessions', 'json') || 'null'); const shapes = session?.annotations?.filter(a => a.kind === 'shape') || []; if (shapes.length) return shapes; await page.waitForTimeout(100); } return []; };
const items = (bytes, number = 1) => operateDocument(bytes, { operation: 'page-content', page: number }).items;
const textAt = (bytes, words) => items(bytes).find(item => item.kind === 'text' && item.level === 'paragraph' && item.text.includes(words));

try {
  await page.goto(origin);
  await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(fixture);
  await page.locator('.loading-overlay').waitFor({ state: 'detached' }); await page.locator('.pdf-page-wrap canvas').first().waitFor();
  await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();

  await check('reader-stays-with-edit-toolbar-and-zoom', async () => {
    await page.locator('.edit-toolbar').waitFor();
    assert(await page.locator('.reading-area').isVisible(), 'The reader stays visible');
    assert.equal(await page.locator('.pdf-content-picker, .workspace-editor').count(), 0);
    const before = await page.getByLabel('Nivel de zoom').inputValue(), point = await toScreen(1, 200, 600);
    await page.mouse.move(point.x, point.y); await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control');
    await page.waitForFunction(value => document.querySelector('[aria-label="Nivel de zoom"]').value !== value, before);
    await page.getByLabel('Nivel de zoom').selectOption('page'); await settle();
    return { readerVisible: true, ctrlWheelZooms: true };
  });

  await check('hover-select-and-move-a-paragraph-in-place', async () => {
    const start = await toScreen(1, 120, 704), scroll = await page.locator('.reading-area').evaluate(node => node.scrollTop);
    let overlay = false; await page.exposeFunction('sawOverlay', () => { overlay = true; });
    await page.evaluate(() => new MutationObserver(() => { if (document.querySelector('.loading-overlay')) window.sawOverlay(); }).observe(document.body, { subtree: true, childList: true }));
    await page.mouse.move(start.x, start.y); await page.locator('.edit-hover').waitFor();
    await page.mouse.down(); await page.mouse.move(start.x + 20, start.y + 40, { steps: 4 }); await page.mouse.move(start.x + 40, start.y + 120, { steps: 6 });
    // The paragraph alone (a sprite drawn by the live document) follows the pointer; WebKit may paint it a frame after the last move.
    await page.locator('.edit-sprite').first().waitFor({ timeout: 2000 });
    await page.mouse.up(); await settle();
    await page.locator('.edit-selection.kind-text').waitFor();
    assert.equal(await page.locator('.reading-area').evaluate(node => node.scrollTop), scroll);
    assert(!overlay, 'No loading screen');
    assert.equal(await page.locator('.pdf-page-wrap[data-page-number="1"] canvas[data-live]').count(), 1, 'The page is drawn from the live document, not reopened');
    const bytes = await exported('edit-moved.pdf'), moved = textAt(bytes, 'Las ventas');
    assert(moved.rect[0] > 70 && moved.rect[1] < 700, `Moved: ${moved.rect}`);
    return { moved: moved.rect.map(Math.round), scrollKept: true, reselected: true };
  });

  await check('type-over-a-paragraph-and-escape-cancels', async () => {
    const title = await toScreen(1, 100, 765);
    await page.mouse.dblclick(title.x, title.y);
    const box = page.getByRole('textbox', { name: 'Texto del párrafo' }); await box.waitFor();
    assert.equal(await box.inputValue(), 'Informe trimestral');
    await page.keyboard.press('End'); await page.keyboard.type(' 2026'); await page.keyboard.press('Escape');
    await box.waitFor({ state: 'detached' });
    await page.mouse.dblclick(title.x, title.y); await box.waitFor();
    await page.keyboard.press('End'); await page.keyboard.type(' de 2026');
    const outside = await toScreen(1, 300, 300); await page.mouse.click(outside.x, outside.y); await settle();
    const bytes = await exported('edit-typed.pdf');
    assert(textAt(bytes, 'Informe trimestral de 2026'), 'Typed text written');
    return { escapeCancels: true, typedText: true };
  });

  await check('delete-and-undo-an-image', async () => {
    const picture = await toScreen(1, 440, 480);
    await page.mouse.click(picture.x, picture.y); await page.locator('.edit-selection.kind-image').waitFor();
    assert.equal(await page.locator('.edit-selection.kind-image .edit-handle').count(), 8);
    await page.keyboard.press('Delete'); await settle();
    assert.equal(items(await exported('edit-deleted.pdf')).filter(item => item.kind === 'image').length, 0);
    await page.keyboard.press('Control+z'); await settle();
    assert.equal(items(await exported('edit-undone.pdf')).filter(item => item.kind === 'image').length, 1);
    await page.keyboard.press('Control+y'); await settle();
    assert.equal(items(await exported('edit-redone.pdf')).filter(item => item.kind === 'image').length, 0);
    await page.keyboard.press('Control+z'); await settle();
    assert.equal(items(await exported('edit-undone-again.pdf')).filter(item => item.kind === 'image').length, 1);
    return { deleted: true, undone: true, redone: true };
  });

  await check('add-an-image-and-a-shape', async () => {
    await page.locator('.edit-toolbar input[type=file]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(swatch.asPNG()) });
    await page.getByText(/colocar «logo.png»/).waitFor();
    const spot = await toScreen(1, 150, 300); await page.mouse.click(spot.x, spot.y); await settle();
    assert.equal(items(await exported('edit-image.pdf')).filter(item => item.kind === 'image').length, 2);
    await page.keyboard.press('r');
    const a = await toScreen(1, 80, 200), b = await toScreen(1, 260, 120);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
    await page.locator('.shape-layer rect').first().waitFor();
    const shapes = await sessionShapes();
    assert.equal(shapes.length, 1); assert.equal(shapes[0].shape, 'rect');
    return { imageAdded: true, shapeAdded: true };
  });
  await check('new-text-and-keyboard-moves', async () => {
    await page.keyboard.press('Escape'); await page.keyboard.press('t');
    const spot = await toScreen(1, 70, 380); await page.mouse.click(spot.x, spot.y);
    const box = page.getByRole('textbox', { name: 'Texto nuevo' }); await box.waitFor();
    await page.keyboard.type('Nota añadida en Folio'); await page.keyboard.press('Control+Enter'); await settle();
    let bytes = await exported('edit-new-text.pdf'); const added = textAt(bytes, 'Nota añadida en Folio');
    assert(added, 'New text written');
    // The new text is selected; arrows move it by a point, Shift by ten.
    await page.locator('.edit-selection.kind-text').waitFor();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(600); await settle();
    bytes = await exported('edit-nudged.pdf'); const nudged = textAt(bytes, 'Nota añadida en Folio');
    assert(Math.abs(nudged.rect[0] - added.rect[0] - 30) < 1.5, `Moved 30 pt: ${added.rect[0]} → ${nudged.rect[0]}`);
    await page.keyboard.press('Control+d'); await settle();
    bytes = await exported('edit-duplicated.pdf');
    assert.equal(items(bytes).filter(item => item.kind === 'text' && item.level === 'line' && item.text.includes('Nota añadida')).length, 2);
    return { newText: true, nudgedOnce: true, duplicated: true };
  });

  await check('resize-turn-and-paste-images', async () => {
    await page.keyboard.press('Escape');
    const picture = await toScreen(1, 440, 480); await page.mouse.click(picture.x, picture.y); await page.locator('.edit-selection.kind-image').waitFor();
    const handle = await page.locator('.edit-selection.kind-image .handle-se').boundingBox();
    await page.mouse.move(handle.x + 4, handle.y + 4); await page.mouse.down(); await page.mouse.move(handle.x + 60, handle.y + 20, { steps: 5 }); await page.mouse.up(); await settle();
    let bytes = await exported('edit-resized.pdf'); const grown = items(bytes).filter(item => item.kind === 'image').sort((a, b) => (b.rect[2] - b.rect[0]) - (a.rect[2] - a.rect[0]))[0];
    const ratio = (grown.rect[2] - grown.rect[0]) / (grown.rect[3] - grown.rect[1]);
    assert(grown.rect[2] - grown.rect[0] > 165 && Math.abs(ratio - 160 / 120) < .02, `Grown with its proportions: ${grown.rect}`);
    await page.getByRole('button', { name: 'Girar 90°' }).click(); await settle();
    bytes = await exported('edit-turned.pdf');
    assert(items(bytes).some(item => item.kind === 'image' && item.rotation === 90), 'Turned a quarter');
    // A pasted image lands at once in the middle of the view, selected, even with a toolbar field focused.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Texto/ }).focus();
    await page.evaluate(async png => {
      const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'captura.png', { type: 'image/png' }));
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    }, Buffer.from(swatch.asPNG()).toString('base64'));
    await settle(); await page.locator('.edit-selection.kind-image').waitFor();
    bytes = await exported('edit-pasted.pdf');
    assert(items(bytes).filter(item => item.kind === 'image').length >= 3, 'Pasted image placed');
    return { resizedKeepingRatio: true, turned: true, pasted: true };
  });

  await check('arrows-and-shape-styles', async () => {
    // A tool key works whatever is selected (Esc would leave Editar with nothing selected).
    await page.keyboard.press('a');
    const a = await toScreen(1, 300, 300), b = await toScreen(1, 450, 220);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
    await page.locator('.shape-layer polyline').first().waitFor();
    await page.getByRole('combobox', { name: 'Grosor del borde' }).selectOption('5');
    let shapes = []; for (let i = 0; i < 50 && !shapes.some(shape => shape.shape === 'arrow' && shape.strokeWidth === 5); i++) { shapes = await sessionShapes(); await page.waitForTimeout(100); }
    assert(shapes.some(shape => shape.shape === 'arrow' && shape.strokeWidth === 5 && shape.line?.length === 4), JSON.stringify(shapes));
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => document.querySelectorAll('.shape-layer polyline').length === 0);
    return { arrowDrawn: true, restyled: true, deleted: true };
  });

  await check('recolouring-a-drawing-shows-at-once-and-is-written-after', async () => {
    const box = page.locator('.pdf-page-wrap[data-page-number="2"]'); await box.scrollIntoViewIfNeeded();
    const spot = await toScreen(2, 360, 620); await page.mouse.move(spot.x, spot.y); await page.locator('.edit-layer[data-edit-page="2"][data-edit-state=ready]').waitFor();
    await page.mouse.click(spot.x, spot.y); await page.locator('.edit-selection.kind-graphic').waitFor();
    await page.getByLabel('Color de relleno').fill('#00aa00');
    // Shown in its new colour before anything is written.
    await page.locator('.edit-layer[data-edit-page="2"] .edit-sprite').waitFor({ timeout: 2000 });
    await settle();
    const drawings = operateDocument(await exported('edit-recoloured.pdf'), { operation: 'page-content', page: 2, graphics: true }).items.filter(item => item.kind === 'graphic');
    assert(drawings.some(item => item.fill === '#00aa00'), JSON.stringify(drawings));
    await page.keyboard.press('Escape');
    await page.locator('.pdf-page-wrap[data-page-number="1"]').scrollIntoViewIfNeeded();
    return { previewed: true, written: true };
  });

  await check('a-page-of-an-older-revision-is-not-reused', async () => {
    // A page shown before an edit and out of view since comes back with the new revision's page.
    const far = page.locator('.pdf-page-wrap[data-page-number="14"]');
    await far.scrollIntoViewIfNeeded(); await far.locator('.page-content canvas').first().waitFor();
    await page.locator('.pdf-page-wrap[data-page-number="1"]').scrollIntoViewIfNeeded();
    const title = await toScreen(1, 100, 765); await page.mouse.move(title.x, title.y); await page.locator('.edit-layer[data-edit-page="1"][data-edit-state=ready]').waitFor();
    await page.mouse.click(title.x, title.y); await page.locator('.edit-selection.kind-text').waitFor();
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(600); await settle(); await page.waitForTimeout(500);
    await far.scrollIntoViewIfNeeded(); await far.locator('.page-content canvas').first().waitFor(); await settle();
    assert.equal(await page.getByText('Folio encontró un error').count(), 0, 'No error screen');
    return { farPageShown: true };
  });

  await check('leaving-opens-the-written-pdf-and-one-undo-returns-to-before', async () => {
    const reopened = () => page.waitForFunction(() => !document.querySelector('.edit-toolbar') && !document.querySelector('canvas[data-live]') && !document.querySelector('[aria-label="Modo lectura"]:disabled'));
    await page.locator('.pdf-page-wrap[data-page-number="1"]').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Listo' }).click(); await reopened(); await settle();
    // The draft once the last change and the reader's reopening have written it.
    for (let value = ''; value !== lastDraft; await page.waitForTimeout(300)) { value = lastDraft; lastDraft = await readStore('drafts', 'bytes'); }
    const before = textAt(new Uint8Array(Buffer.from(lastDraft, 'base64')), 'Informe trimestral');
    // Another visit to Editar: one change, then back to reading.
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click(); await page.locator('.edit-toolbar').waitFor();
    const title = await toScreen(1, 100, 765); await page.mouse.move(title.x, title.y); await page.locator('.edit-layer[data-edit-page="1"][data-edit-state=ready]').waitFor();
    await page.mouse.click(title.x, title.y); await page.locator('.edit-selection.kind-text').waitFor();
    await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(600); await settle();
    const moved = textAt(await exported('edit-second-visit.pdf'), 'Informe trimestral');
    assert(Math.abs(moved.rect[0] - before.rect[0] - 20) < 1.5, `Moved 20 pt: ${before.rect[0]} → ${moved.rect[0]}`);
    await page.getByRole('button', { name: 'Listo' }).click(); await reopened(); await settle();
    // The visit's change undoes back to the PDF as it was before it.
    await page.keyboard.press('Control+z'); await settle();
    const restored = textAt(await exported('edit-visit-undone.pdf'), 'Informe trimestral');
    assert(Math.abs(restored.rect[0] - before.rect[0]) < .5, `Back: ${restored.rect[0]}`);
    assert.equal(await page.getByText('Folio encontró un error').count(), 0, 'No error screen');
    return { reopenedOnce: true, visitUndoneAtOnce: true };
  });
  await check('after-leaving-changes-undo-one-by-one-and-editar-reopens-at-once', async () => {
    const reopened = () => page.waitForFunction(() => !document.querySelector('.edit-toolbar') && !document.querySelector('canvas[data-live]') && !document.querySelector('[aria-label="Modo lectura"]:disabled'));
    const x = bytes => textAt(bytes, 'Informe trimestral').rect[0], workers = liveWorkers;
    // The document stayed live after the last visit: Editar opens it again without another copy.
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click(); await page.locator('.edit-toolbar').waitFor();
    const title = await toScreen(1, 100, 765); await page.mouse.move(title.x, title.y); await page.locator('.edit-layer[data-edit-page="1"][data-edit-state=ready]').waitFor();
    await page.mouse.click(title.x, title.y); await page.locator('.edit-selection.kind-text').waitFor();
    const start = x(new Uint8Array(Buffer.from(lastDraft, 'base64')));
    await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(600); await settle();
    assert(Math.abs(x(await exported('edit-step-1.pdf')) - start - 10) < 1.5, 'First step');
    await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(600); await settle();
    assert(Math.abs(x(await exported('edit-step-2.pdf')) - start - 20) < 1.5, 'Second step');
    await page.getByRole('button', { name: 'Listo' }).click(); await reopened(); await settle();
    // Outside Editar each change still undoes on its own.
    await page.keyboard.press('Control+z');
    assert(Math.abs(x(await exported('edit-step-undone.pdf')) - start - 10) < 1.5, 'One step back');
    await reopened(); await settle();
    await page.keyboard.press('Control+z');
    assert(Math.abs(x(await exported('edit-steps-undone.pdf')) - start) < 1.5, 'Two steps back');
    await reopened(); await settle();
    assert.equal(liveWorkers, workers, 'The same live document throughout');
    assert.equal(await page.getByText('Folio encontró un error').count(), 0, 'No error screen');
    return { reenteredWithoutCopy: true, undoneOneByOne: true };
  });

  await check('a-change-not-yet-written-survives-opening-another-document', async () => {
    // The draft of this document, by its id (the SHA-256 of the file).
    const id = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
    const draft = () => page.evaluate(id => new Promise((resolve, reject) => {
      const request = indexedDB.open('folio-library');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const get = request.result.transaction('drafts', 'readonly').objectStore('drafts').get(id); get.onsuccess = () => resolve(btoa(Array.from(new Uint8Array(get.result), c => String.fromCharCode(c)).join(''))); get.onerror = () => reject(get.error); };
    }), id);
    const before = await draft(), x = bytes => textAt(new Uint8Array(Buffer.from(bytes, 'base64')), 'Informe trimestral').rect[0];
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click(); await page.locator('.edit-toolbar').waitFor();
    const title = await toScreen(1, 100, 765); await page.mouse.move(title.x, title.y); await page.locator('.edit-layer[data-edit-page="1"][data-edit-state=ready]').waitFor();
    await page.mouse.click(title.x, title.y); await page.locator('.edit-selection.kind-text').waitFor();
    await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(450); await settle();
    // Another document opens before the change is written (800 ms after it).
    const other = await PDFDocument.create(); other.addPage([595, 842]).drawText('Otro documento', { x: 60, y: 760, size: 16, font: await other.embedFont(StandardFonts.Helvetica) });
    await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles({ name: 'otro.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await other.save()) });
    await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'otro.pdf');
    // Back to the first document: it shows the change, and its draft holds it.
    await page.locator('.document-tab [role=tab][aria-label="edit-mode.pdf"]').click();
    await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'edit-mode.pdf' && !document.querySelector('canvas[data-live]') && !document.querySelector('[aria-label="Modo lectura"]:disabled'));
    await settle();
    let written = before; for (let i = 0; i < 50 && written === before; i++) { await page.waitForTimeout(100); written = await draft(); }
    assert(Math.abs(x(written) - x(before) - 10) < 1.5, `Moved 10 pt: ${x(before)} → ${x(written)}`);
    const shown = await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span', { hasText: 'Informe' }).first().boundingBox(), box = await pageBox(1);
    assert(Math.abs((shown.x - box.x) / (box.width / 595) - x(written)) < 3, 'The reader shows the moved title');
    // Closing the live document folded its changes into one step back to the PDF it was opened from (the original).
    const original = textAt(new Uint8Array(fs.readFileSync(fixture)), 'Informe trimestral').rect[0];
    let restored = written;
    for (let i = 0; i < 12 && Math.abs(x(restored) - original) > .5; i++) {
      await page.keyboard.press('Control+z'); await page.waitForFunction(() => !document.querySelector('[aria-label="Modo lectura"]:disabled')); await page.waitForTimeout(300); restored = await draft();
    }
    assert(Math.abs(x(restored) - original) < .5, `Back to the original: ${x(restored)}`);
    assert.equal(await page.getByText('Folio encontró un error').count(), 0, 'No error screen');
    return { writtenBeforeSwitching: true, readerReloaded: true, foldedToOriginal: true };
  });
} finally {
  for (const result of results) console.log(JSON.stringify(result));
  fs.writeFileSync(path.join(output, 'edit-mode-ui-results.json'), JSON.stringify({ browser: useWebKit ? 'WebKit' : 'Chromium', results }, null, 2));
  await browser.close(); server.kill();
}
process.exitCode = results.length === 13 && results.every(result => result.status === 'passed') ? 0 : 1;
