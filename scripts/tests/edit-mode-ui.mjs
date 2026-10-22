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
import { operateDocument } from '../../src/engine/operations.ts';

const output = path.join(process.cwd(), 'test-results');
fs.mkdirSync(output, { recursive: true });
const port = process.env.FOLIO_EDIT_PORT || '4251',
  origin = `http://127.0.0.1:${port}`;

// A page with two paragraphs and a picture, and a second page.
const swatch = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 30], false);
swatch.getPixels().fill(0);
for (let i = 0; i < 40 * 30; i++) swatch.getPixels().set([30, 120, 200], i * 3);
const pdf = await PDFDocument.create(),
  font = await pdf.embedFont(StandardFonts.Helvetica);
const first = pdf.addPage([595, 842]);
first.drawText('Informe trimestral', { x: 60, y: 760, size: 22, font, color: rgb(0.1, 0.1, 0.1) });
['Las ventas crecieron un doce por ciento respecto', 'al trimestre anterior gracias a la nueva tienda.'].forEach(
  (line, i) => first.drawText(line, { x: 60, y: 700 - i * 16, size: 12, font }),
);
first.drawImage(await pdf.embedPng(swatch.asPNG()), { x: 360, y: 420, width: 160, height: 120 });
const second = pdf.addPage([595, 842]);
second.drawText('Segunda página', { x: 60, y: 760, size: 16, font });
// A box the PDF draws itself, to recolour.
second.drawRectangle({ x: 300, y: 600, width: 120, height: 40, color: rgb(0.48, 0.18, 0.36) });
// Pages far enough to leave the reader's view.
for (let i = 3; i <= 14; i++) pdf.addPage([595, 842]).drawText(`Página ${i}`, { x: 60, y: 760, size: 16, font });
// On page 3, a paragraph and another cell's text below it, as in a table.
const third = pdf.getPage(2);
['Interpreta sus efectos', 'farmacológicos'].forEach((line, i) =>
  third.drawText(line, { x: 60, y: 700 - i * 16, size: 12, font }),
);
third.drawText('Discusión de casos', { x: 150, y: 660, size: 12, font });
const fixture = path.join(output, 'edit-mode.pdf');
fs.writeFileSync(fixture, await pdf.save());

const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'],
  { stdio: 'pipe' },
);
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(origin)).ok) break;
  } catch {}
  await new Promise(r => setTimeout(r, 100));
}
// FOLIO_TEST_BROWSER=webkit runs it in the engine of the macOS app.
const useWebKit = process.env.FOLIO_TEST_BROWSER === 'webkit';
const browser = useWebKit
  ? await webkit.launch({ headless: true })
  : await chromium.launch({ executablePath: findChrome(), headless: true });
const results = [];
const toasts = [];
async function check(id, run) {
  try {
    results.push({ id, status: 'passed', ...(await run()) });
  } catch (error) {
    await page.screenshot({ path: path.join(output, `edit-mode-${id}.png`) }).catch(() => {});
    results.push({ id, status: 'failed', error: error.stack || String(error), toasts: toasts.splice(0) });
  }
}
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on('pageerror', error => console.log('pageerror', error.message));
// Editar's live documents: each opens a worker of its own.
let liveWorkers = 0;
page.on('worker', worker => {
  if (worker.url().includes('session.worker')) liveWorkers++;
});
await page.exposeFunction('folioToast', text => toasts.push(text));
await page.addInitScript(() =>
  new MutationObserver(() => {
    const toast = document.querySelector('.toast');
    if (toast && toast.dataset.seen !== toast.textContent) {
      toast.dataset.seen = toast.textContent;
      window.folioToast(toast.textContent);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true }),
);

const pageBox = number => page.locator(`.pdf-page-wrap[data-page-number="${number}"] .page-content`).boundingBox();
const toScreen = async (number, x, y) => {
  const box = await pageBox(number),
    scale = box.width / 595;
  return { x: box.x + x * scale, y: box.y + (842 - y) * scale };
};
// Clicks a page point once its Editar layer is ready and the layout has settled (entering Editar shifts the page).
const pick = async (number, x, y) => {
  let at = await toScreen(number, x, y);
  await page.mouse.move(at.x, at.y);
  await page.locator(`.edit-layer[data-edit-page="${number}"][data-edit-state=ready]`).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  at = await toScreen(number, x, y);
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
};
const settle = async () => {
  await page.waitForFunction(
    () =>
      !document.querySelector('.edit-toolbar[data-committing=true]') &&
      !document.querySelector('.edit-snapshot') &&
      !document.querySelector('.edit-ghost'),
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.pdf-page-wrap canvas:not(.page-detail)')].every(
      canvas => canvas.dataset.rendering !== 'true',
    ),
  );
};
// Each change is kept as a draft in the browser; read it rather than downloading
// (headless Chrome blocks repeated downloads from one page).
const readStore = (store, pick) =>
  page.evaluate(
    ([store, pick]) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('folio-library');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const all = request.result.transaction(store, 'readonly').objectStore(store).getAll();
          all.onsuccess = () => {
            const value = all.result.at(-1);
            resolve(
              !value
                ? null
                : pick === 'bytes'
                  ? btoa(Array.from(new Uint8Array(value), c => String.fromCharCode(c)).join(''))
                  : JSON.stringify(value),
            );
          };
          all.onerror = () => reject(all.error);
        };
      }),
    [store, pick],
  );
let lastDraft = '';
const exported = async name => {
  let value = '';
  for (let i = 0; i < 100 && (!value || value === lastDraft); i++) {
    value = (await readStore('drafts', 'bytes')) || '';
    if (!value || value === lastDraft) await page.waitForTimeout(100);
  }
  assert(value && value !== lastDraft, 'The change was saved as a draft');
  lastDraft = value;
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  fs.writeFileSync(path.join(output, name), bytes);
  return bytes;
};
const sessionShapes = async () => {
  for (let i = 0; i < 50; i++) {
    const session = JSON.parse((await readStore('sessions', 'json')) || 'null');
    const shapes = session?.annotations?.filter(a => a.kind === 'shape') || [];
    if (shapes.length) return shapes;
    await page.waitForTimeout(100);
  }
  return [];
};
const items = (bytes, number = 1) => operateDocument(bytes, { operation: 'page-content', page: number }).items;
const textAt = (bytes, words) =>
  items(bytes).find(item => item.kind === 'text' && item.level === 'paragraph' && item.text.includes(words));

try {
  await page.goto(origin);
  await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(fixture);
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.locator('.pdf-page-wrap canvas').first().waitFor();
  await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();

  await check('reader-stays-with-edit-toolbar-and-zoom', async () => {
    await page.locator('.edit-toolbar').waitFor();
    assert(await page.locator('.reading-area').isVisible(), 'The reader stays visible');
    assert.equal(await page.locator('.pdf-content-picker, .workspace-editor').count(), 0);
    const before = await page.getByLabel('Nivel de zoom').inputValue(),
      point = await toScreen(1, 200, 600);
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -200);
    await page.keyboard.up('Control');
    await page.waitForFunction(value => document.querySelector('[aria-label="Nivel de zoom"]').value !== value, before);
    await page.getByLabel('Nivel de zoom').selectOption('page');
    await settle();
    return { readerVisible: true, ctrlWheelZooms: true };
  });

  await check('hover-select-and-move-a-paragraph-in-place', async () => {
    const start = await toScreen(1, 120, 704),
      scroll = await page.locator('.reading-area').evaluate(node => node.scrollTop);
    let overlay = false;
    await page.exposeFunction('sawOverlay', () => {
      overlay = true;
    });
    await page.evaluate(() =>
      new MutationObserver(() => {
        if (document.querySelector('.loading-overlay')) window.sawOverlay();
      }).observe(document.body, { subtree: true, childList: true }),
    );
    await page.mouse.move(start.x, start.y);
    await page.locator('.edit-hover').waitFor();
    await page.mouse.down();
    await page.mouse.move(start.x + 20, start.y + 40, { steps: 4 });
    await page.mouse.move(start.x + 40, start.y + 120, { steps: 6 });
    // The paragraph alone (a sprite drawn by the live document) follows the pointer; WebKit may paint it a frame after the last move.
    await page.locator('.edit-sprite').first().waitFor({ timeout: 2000 });
    await page.mouse.up();
    await settle();
    await page.locator('.edit-selection.kind-text').waitFor();
    assert.equal(await page.locator('.reading-area').evaluate(node => node.scrollTop), scroll);
    assert(!overlay, 'No loading screen');
    assert.equal(
      await page.locator('.pdf-page-wrap[data-page-number="1"] canvas[data-live]').count(),
      1,
      'The page is drawn from the live document, not reopened',
    );
    const bytes = await exported('edit-moved.pdf'),
      moved = textAt(bytes, 'Las ventas');
    assert(moved.rect[0] > 70 && moved.rect[1] < 700, `Moved: ${moved.rect}`);
    return { moved: moved.rect.map(Math.round), scrollKept: true, reselected: true };
  });

  await check('a-changed-page-is-sharp-when-zoomed-in', async () => {
    // At 600 % the full page is drawn below screen density: its visible part is
    // drawn again sharply, from the live document (the paragraph has moved away).
    await page.getByLabel('Nivel de zoom').selectOption('600');
    await settle();
    const spot = async () => [await toScreen(1, 62, 712), await toScreen(1, 95, 698)];
    const [a] = await spot();
    await page.locator('.reading-area').evaluate((node, a) => {
      const box = node.getBoundingClientRect();
      node.scrollBy(a.x - box.left - box.width / 2, a.y - box.top - box.height / 2);
    }, a);
    const [from, to] = await spot();
    const detail = page.locator('.pdf-page-wrap[data-page-number="1"] canvas.page-detail');
    await page.waitForFunction(
      ([node, from, to]) => {
        const box = node.width && node.getBoundingClientRect();
        return box && box.left <= from.x && box.top <= from.y && box.right >= to.x && box.bottom >= to.y;
      },
      [await detail.elementHandle(), from, to],
    );
    const { ink, oldSpot } = await detail.evaluate(
      (node, [from, to]) => {
        const box = node.getBoundingClientRect(),
          k = node.width / box.width,
          dark = (x, y, w, h) => {
            const data = node.getContext('2d').getImageData(x, y, Math.max(1, w), Math.max(1, h)).data;
            let n = 0;
            for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 300) n++;
            return n;
          };
        return {
          ink: dark(0, 0, node.width, node.height),
          oldSpot: dark(
            Math.round((from.x - box.left) * k),
            Math.round((from.y - box.top) * k),
            Math.round((to.x - from.x) * k),
            Math.round((to.y - from.y) * k),
          ),
        };
      },
      [from, to],
    );
    assert(ink > 0, 'The sharp copy shows the page');
    assert.equal(oldSpot, 0, 'The sharp copy shows the paragraph moved, not where it was');
    await page.getByLabel('Nivel de zoom').selectOption('page');
    await settle();
    return { ink, oldSpot };
  });

  await check('type-over-a-paragraph-and-escape-cancels', async () => {
    const title = await toScreen(1, 100, 765);
    const box = page.getByRole('textbox', { name: 'Texto del párrafo' });
    // A slow runner can space the two clicks too far apart to be one double click: try once more.
    const typeOver = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.mouse.dblclick(title.x, title.y);
        if (
          await box.waitFor({ timeout: 8000 }).then(
            () => true,
            () => false,
          )
        )
          return;
        // Escape only clears what the stray single click selected: with nothing selected it would leave Editar.
        if (await page.locator('.edit-selection').count()) await page.keyboard.press('Escape');
        await settle();
      }
      await box.waitFor();
    };
    await typeOver();
    assert.equal(await box.inputValue(), 'Informe trimestral');
    await page.keyboard.press('End');
    await page.keyboard.type(' 2026');
    await page.keyboard.press('Escape');
    await box.waitFor({ state: 'detached' });
    // The page settles back after the cancelled draft before it takes the next double click.
    await settle();
    await page.mouse.move(title.x, title.y);
    await page.locator('.edit-layer[data-edit-page="1"][data-edit-state=ready]').waitFor();
    await typeOver();
    await page.keyboard.press('End');
    await page.keyboard.type(' de 2026');
    const outside = await toScreen(1, 300, 300);
    await page.mouse.click(outside.x, outside.y);
    await settle();
    const bytes = await exported('edit-typed.pdf');
    assert(textAt(bytes, 'Informe trimestral de 2026'), 'Typed text written');
    return { escapeCancels: true, typedText: true };
  });

  await check('delete-and-undo-an-image', async () => {
    const picture = await toScreen(1, 440, 480);
    await page.mouse.click(picture.x, picture.y);
    await page.locator('.edit-selection.kind-image').waitFor();
    assert.equal(await page.locator('.edit-selection.kind-image .edit-handle').count(), 8);
    await page.keyboard.press('Delete');
    await settle();
    assert.equal(items(await exported('edit-deleted.pdf')).filter(item => item.kind === 'image').length, 0);
    await page.keyboard.press('Control+z');
    await settle();
    assert.equal(items(await exported('edit-undone.pdf')).filter(item => item.kind === 'image').length, 1);
    await page.keyboard.press('Control+y');
    await settle();
    assert.equal(items(await exported('edit-redone.pdf')).filter(item => item.kind === 'image').length, 0);
    await page.keyboard.press('Control+z');
    await settle();
    assert.equal(items(await exported('edit-undone-again.pdf')).filter(item => item.kind === 'image').length, 1);
    return { deleted: true, undone: true, redone: true };
  });

  await check('add-an-image-and-a-shape', async () => {
    await page
      .locator('.edit-toolbar input[type=file]')
      .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(swatch.asPNG()) });
    await page.getByText(/colocar «logo.png»/).waitFor();
    const spot = await toScreen(1, 150, 300);
    await page.mouse.click(spot.x, spot.y);
    await settle();
    assert.equal(items(await exported('edit-image.pdf')).filter(item => item.kind === 'image').length, 2);
    await page.keyboard.press('r');
    const a = await toScreen(1, 80, 200),
      b = await toScreen(1, 260, 120);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    await page.locator('.shape-layer rect').first().waitFor();
    const shapes = await sessionShapes();
    assert.equal(shapes.length, 1);
    assert.equal(shapes[0].shape, 'rect');
    return { imageAdded: true, shapeAdded: true };
  });
  await check('new-text-and-keyboard-moves', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('t');
    const spot = await toScreen(1, 70, 380);
    await page.mouse.click(spot.x, spot.y);
    const box = page.getByRole('textbox', { name: 'Texto nuevo' });
    await box.waitFor();
    await page.keyboard.type('Nota añadida en Folio');
    await page.keyboard.press('Control+Enter');
    await settle();
    let bytes = await exported('edit-new-text.pdf');
    const added = textAt(bytes, 'Nota añadida en Folio');
    assert(added, 'New text written');
    // The new text is selected; arrows move it by a point, Shift by ten.
    await page.locator('.edit-selection.kind-text').waitFor();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(600);
    await settle();
    bytes = await exported('edit-nudged.pdf');
    const nudged = textAt(bytes, 'Nota añadida en Folio');
    assert(Math.abs(nudged.rect[0] - added.rect[0] - 30) < 1.5, `Moved 30 pt: ${added.rect[0]} → ${nudged.rect[0]}`);
    await page.keyboard.press('Control+d');
    await settle();
    bytes = await exported('edit-duplicated.pdf');
    assert.equal(
      items(bytes).filter(item => item.kind === 'text' && item.level === 'line' && item.text.includes('Nota añadida'))
        .length,
      2,
    );
    return { newText: true, nudgedOnce: true, duplicated: true };
  });

  await check('resize-turn-and-paste-images', async () => {
    await page.keyboard.press('Escape');
    const picture = await toScreen(1, 440, 480);
    await page.mouse.click(picture.x, picture.y);
    await page.locator('.edit-selection.kind-image').waitFor();
    const handle = await page.locator('.edit-selection.kind-image .handle-se').boundingBox();
    await page.mouse.move(handle.x + 4, handle.y + 4);
    await page.mouse.down();
    await page.mouse.move(handle.x + 60, handle.y + 20, { steps: 5 });
    await page.mouse.up();
    await settle();
    let bytes = await exported('edit-resized.pdf');
    const grown = items(bytes)
      .filter(item => item.kind === 'image')
      .sort((a, b) => b.rect[2] - b.rect[0] - (a.rect[2] - a.rect[0]))[0];
    const ratio = (grown.rect[2] - grown.rect[0]) / (grown.rect[3] - grown.rect[1]);
    assert(
      grown.rect[2] - grown.rect[0] > 165 && Math.abs(ratio - 160 / 120) < 0.02,
      `Grown with its proportions: ${grown.rect}`,
    );
    await page.getByRole('button', { name: 'Girar 90°' }).click();
    await settle();
    bytes = await exported('edit-turned.pdf');
    assert(
      items(bytes).some(item => item.kind === 'image' && item.rotation === 90),
      'Turned a quarter',
    );
    // A pasted image lands at once in the middle of the view, selected, even with a toolbar field focused.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Texto/ }).focus();
    await page.evaluate(async png => {
      const data = new DataTransfer();
      data.items.add(
        new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'captura.png', { type: 'image/png' }),
      );
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    }, Buffer.from(swatch.asPNG()).toString('base64'));
    await settle();
    await page.locator('.edit-selection.kind-image').waitFor();
    bytes = await exported('edit-pasted.pdf');
    assert(items(bytes).filter(item => item.kind === 'image').length >= 3, 'Pasted image placed');
    return { resizedKeepingRatio: true, turned: true, pasted: true };
  });

  await check('arrows-and-shape-styles', async () => {
    // A tool key works whatever is selected (Esc would leave Editar with nothing selected).
    await page.keyboard.press('a');
    const a = await toScreen(1, 300, 300),
      b = await toScreen(1, 450, 220);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    await page.locator('.shape-layer polyline').first().waitFor();
    await page.getByRole('combobox', { name: 'Grosor del borde' }).selectOption('5');
    let shapes = [];
    for (let i = 0; i < 50 && !shapes.some(shape => shape.shape === 'arrow' && shape.strokeWidth === 5); i++) {
      shapes = await sessionShapes();
      await page.waitForTimeout(100);
    }
    assert(
      shapes.some(shape => shape.shape === 'arrow' && shape.strokeWidth === 5 && shape.line?.length === 4),
      JSON.stringify(shapes),
    );
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => document.querySelectorAll('.shape-layer polyline').length === 0);
    return { arrowDrawn: true, restyled: true, deleted: true };
  });

  await check('recolouring-a-drawing-shows-at-once-and-is-written-after', async () => {
    const box = page.locator('.pdf-page-wrap[data-page-number="2"]');
    await box.scrollIntoViewIfNeeded();
    const spot = await toScreen(2, 360, 620);
    await page.mouse.move(spot.x, spot.y);
    await page.locator('.edit-layer[data-edit-page="2"][data-edit-state=ready]').waitFor();
    await page.mouse.click(spot.x, spot.y);
    await page.locator('.edit-selection.kind-graphic').waitFor();
    await page.getByRole('button', { name: 'Color de relleno' }).click();
    // The panel offers document colours; a code picks any other.
    await page.getByRole('dialog', { name: 'Color de relleno' }).getByRole('button', { name: 'Verde' }).waitFor();
    await page.getByLabel('Código hexadecimal').fill('00aa00');
    await page.keyboard.press('Enter');
    assert(
      (await page.getByRole('dialog', { name: 'Color de relleno' }).count()) === 0,
      'the colours stay open after Enter',
    );
    // Shown in its new colour before anything is written.
    await page.locator('.edit-layer[data-edit-page="2"] .edit-sprite').waitFor({ timeout: 2000 });
    await settle();
    const drawings = operateDocument(await exported('edit-recoloured.pdf'), {
      operation: 'page-content',
      page: 2,
      graphics: true,
    }).items.filter(item => item.kind === 'graphic');
    assert(
      drawings.some(item => item.fill === '#00aa00'),
      JSON.stringify(drawings),
    );
    await page.keyboard.press('Escape');
    await page.locator('.pdf-page-wrap[data-page-number="1"]').scrollIntoViewIfNeeded();
    return { previewed: true, written: true };
  });

  await check('several-items-move-align-delete-and-undo-together', async () => {
    const box = page.locator('.pdf-page-wrap[data-page-number="2"]');
    await box.scrollIntoViewIfNeeded();
    const page2 = bytes => operateDocument(bytes, { operation: 'page-content', page: 2, graphics: true }).items,
      label = bytes => page2(bytes).find(item => item.level === 'paragraph' && item.text.includes('Segunda')),
      badge = bytes => page2(bytes).find(item => item.kind === 'graphic');
    const words = await toScreen(2, 100, 765),
      shape = await toScreen(2, 360, 620);
    await page.mouse.move(words.x, words.y);
    await page.locator('.edit-layer[data-edit-page="2"][data-edit-state=ready]').waitFor();
    // Click, then Shift+click: two items, with what applies to both.
    await page.mouse.click(words.x, words.y);
    await page.keyboard.down('Shift');
    await page.mouse.click(shape.x, shape.y);
    await page.keyboard.up('Shift');
    await page.getByText('2 elementos').waitFor();
    assert.equal(await page.locator('.edit-layer[data-edit-page="2"] .edit-selection').count(), 2);
    const before = new Uint8Array(Buffer.from(lastDraft, 'base64')),
      k = (await pageBox(2)).width / 595;
    // Dragging one moves both, as one change.
    await page.mouse.move(shape.x, shape.y);
    await page.mouse.down();
    await page.mouse.move(shape.x + 20, shape.y + 15, { steps: 4 });
    await page.mouse.move(shape.x + 40, shape.y + 30, { steps: 4 });
    await page.locator('.edit-layer[data-edit-page="2"] .edit-sprite').nth(1).waitFor({ timeout: 2000 });
    await page.mouse.up();
    await settle();
    await page.getByText('2 elementos').waitFor();
    let bytes = await exported('edit-group-moved.pdf');
    for (const pick of [label, badge])
      assert(
        Math.abs(pick(bytes).rect[0] - pick(before).rect[0] - 40 / k) < 2 &&
          Math.abs(pick(bytes).rect[1] - pick(before).rect[1] + 30 / k) < 2,
        `Moved together: ${pick(before).rect} → ${pick(bytes).rect}`,
      );
    await page.keyboard.press('Control+z');
    await settle();
    bytes = await exported('edit-group-undone.pdf');
    for (const pick of [label, badge])
      assert(Math.abs(pick(bytes).rect[0] - pick(before).rect[0]) < 0.5, 'One undo puts both back');
    // Writing the change and undoing it leave the view on this page.
    const shown = await pageBox(2);
    assert(shown.y > -shown.height / 2 && shown.y < 900, `Page 2 still in view: ${shown.y}`);
    // A box drawn on empty space selects what it holds; aligning lines them up.
    const from = await toScreen(2, 40, 790),
      to = await toScreen(2, 450, 580);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.locator('.edit-marquee').waitFor();
    await page.mouse.up();
    await page.getByText('2 elementos').waitFor();
    await page.getByRole('button', { name: 'Alinear a la izquierda' }).click();
    await settle();
    bytes = await exported('edit-group-aligned.pdf');
    assert(
      Math.abs(label(bytes).rect[0] - badge(bytes).rect[0]) < 1.5,
      `Aligned left: ${label(bytes).rect[0]} / ${badge(bytes).rect[0]}`,
    );
    await page.getByText('2 elementos').waitFor();
    await page.keyboard.press('Delete');
    await settle();
    bytes = await exported('edit-group-deleted.pdf');
    assert(!label(bytes) && !badge(bytes), 'Both removed');
    await page.keyboard.press('Control+z');
    await settle();
    bytes = await exported('edit-group-restored.pdf');
    assert(label(bytes) && badge(bytes), 'Both back');
    await page.locator('.pdf-page-wrap[data-page-number="1"]').scrollIntoViewIfNeeded();
    return { shiftClick: true, movedAsOne: true, marquee: true, aligned: true, deletedAndRestored: true };
  });

  await check('text-moved-over-other-text-moves-again-and-boxes-select-it', async () => {
    // A paragraph dropped across another cell's text, as in a table, stays Folio's own block.
    await page.locator('.pdf-page-wrap[data-page-number="3"]').scrollIntoViewIfNeeded();
    const paragraph = bytes =>
      items(bytes, 3).find(item => item.level === 'paragraph' && item.text.startsWith('Interpreta'));
    const before =
      paragraph(new Uint8Array(Buffer.from(lastDraft, 'base64'))) ??
      paragraph(new Uint8Array(fs.readFileSync(fixture)));
    // Pressing on the text and dragging (a click first on selected text would start typing in it).
    const drag = async (from, to) => {
      let a = await toScreen(3, ...from);
      await page.mouse.move(a.x, a.y);
      await page.locator('.edit-layer[data-edit-page="3"][data-edit-state=ready]').waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      a = await toScreen(3, ...from);
      const b = await toScreen(3, ...to);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
      await page.mouse.move(b.x, b.y, { steps: 4 });
      await page.mouse.up();
      await settle();
    };
    await drag([80, 702], [170, 672]);
    let bytes = await exported('edit-over-cell.pdf'),
      moved = paragraph(bytes);
    assert(
      moved.editable && Math.abs(moved.rect[0] - before.rect[0] - 90) < 2,
      `Moved over the cell, still editable: ${moved.rect} ${moved.reason ?? ''}`,
    );
    await drag([170, 672], [170, 572]);
    bytes = await exported('edit-over-cell-again.pdf');
    const again = paragraph(bytes);
    assert(Math.abs(again.rect[1] - moved.rect[1] + 100) < 2, `Moved a second time: ${moved.rect} → ${again.rect}`);
    const cell = items(bytes, 3).find(item => item.level === 'paragraph' && item.text === 'Discusión de casos');
    assert(cell && Math.abs(cell.rect[0] - 150) < 1, "The other cell's text stays where it was");
    // A box loosely around it selects it (its box is larger than its letters).
    await page.mouse.click((await toScreen(3, 500, 800)).x, (await toScreen(3, 500, 800)).y);
    const from = await toScreen(3, 150, 600),
      to = await toScreen(3, 260, 560);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await page.locator('.edit-layer[data-edit-page="3"] .edit-selection.kind-text').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.pdf-page-wrap[data-page-number="1"]').scrollIntoViewIfNeeded();
    return { editableOverOtherText: true, movedAgain: true, boxSelects: true };
  });

  await check('a-page-of-an-older-revision-is-not-reused', async () => {
    // A page shown before an edit and out of view since comes back with the new revision's page.
    const far = page.locator('.pdf-page-wrap[data-page-number="14"]');
    await far.scrollIntoViewIfNeeded();
    await far.locator('.page-content canvas').first().waitFor();
    await page.locator('.pdf-page-wrap[data-page-number="1"]').scrollIntoViewIfNeeded();
    await pick(1, 100, 765);
    await page.locator('.edit-selection.kind-text').waitFor();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(600);
    await settle();
    await page.waitForTimeout(500);
    await far.scrollIntoViewIfNeeded();
    await far.locator('.page-content canvas').first().waitFor();
    await settle();
    assert.equal(await page.getByText('Folio encontró un error').count(), 0, 'No error screen');
    return { farPageShown: true };
  });

  await check('leaving-opens-the-written-pdf-and-one-undo-returns-to-before', async () => {
    const reopened = () =>
      page.waitForFunction(
        () =>
          !document.querySelector('.edit-toolbar') &&
          !document.querySelector('canvas[data-live]') &&
          !document.querySelector('[aria-label="Modo lectura"]:disabled'),
      );
    await page.locator('.pdf-page-wrap[data-page-number="1"]').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Modo lectura' }).click();
    await reopened();
    await settle();
    // The draft once the last change and the reader's reopening have written it.
    for (let value = ''; value !== lastDraft; await page.waitForTimeout(300)) {
      value = lastDraft;
      lastDraft = await readStore('drafts', 'bytes');
    }
    const before = textAt(new Uint8Array(Buffer.from(lastDraft, 'base64')), 'Informe trimestral');
    // Another visit to Editar: one change, then back to reading.
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();
    await page.locator('.edit-toolbar').waitFor();
    await pick(1, 100, 765);
    await page.locator('.edit-selection.kind-text').waitFor();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(600);
    await settle();
    const moved = textAt(await exported('edit-second-visit.pdf'), 'Informe trimestral');
    assert(Math.abs(moved.rect[0] - before.rect[0] - 20) < 1.5, `Moved 20 pt: ${before.rect[0]} → ${moved.rect[0]}`);
    await page.getByRole('button', { name: 'Modo lectura' }).click();
    await reopened();
    await settle();
    // The visit's change undoes back to the PDF as it was before it.
    await page.keyboard.press('Control+z');
    await settle();
    const restored = textAt(await exported('edit-visit-undone.pdf'), 'Informe trimestral');
    assert(Math.abs(restored.rect[0] - before.rect[0]) < 0.5, `Back: ${restored.rect[0]}`);
    assert.equal(await page.getByText('Folio encontró un error').count(), 0, 'No error screen');
    return { reopenedOnce: true, visitUndoneAtOnce: true };
  });
  await check('after-leaving-changes-undo-one-by-one-and-editar-reopens-at-once', async () => {
    const reopened = () =>
      page.waitForFunction(
        () =>
          !document.querySelector('.edit-toolbar') &&
          !document.querySelector('canvas[data-live]') &&
          !document.querySelector('[aria-label="Modo lectura"]:disabled'),
      );
    const x = bytes => textAt(bytes, 'Informe trimestral').rect[0],
      workers = liveWorkers;
    // The document stayed live after the last visit: Editar opens it again without another copy.
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();
    await page.locator('.edit-toolbar').waitFor();
    await pick(1, 100, 765);
    await page.locator('.edit-selection.kind-text').waitFor();
    const start = x(new Uint8Array(Buffer.from(lastDraft, 'base64')));
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(600);
    await settle();
    assert(Math.abs(x(await exported('edit-step-1.pdf')) - start - 10) < 1.5, 'First step');
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(600);
    await settle();
    assert(Math.abs(x(await exported('edit-step-2.pdf')) - start - 20) < 1.5, 'Second step');
    await page.getByRole('button', { name: 'Modo lectura' }).click();
    await reopened();
    await settle();
    // Outside Editar each change still undoes on its own.
    await page.keyboard.press('Control+z');
    assert(Math.abs(x(await exported('edit-step-undone.pdf')) - start - 10) < 1.5, 'One step back');
    await reopened();
    await settle();
    await page.keyboard.press('Control+z');
    assert(Math.abs(x(await exported('edit-steps-undone.pdf')) - start) < 1.5, 'Two steps back');
    await reopened();
    await settle();
    assert.equal(liveWorkers, workers, 'The same live document throughout');
    assert.equal(await page.getByText('Folio encontró un error').count(), 0, 'No error screen');
    return { reenteredWithoutCopy: true, undoneOneByOne: true };
  });

  await check('a-nudge-right-before-leaving-is-kept', async () => {
    const x = bytes => textAt(bytes, 'Informe trimestral').rect[0],
      start = x(new Uint8Array(Buffer.from(lastDraft, 'base64')));
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();
    await page.locator('.edit-toolbar').waitFor();
    await pick(1, 100, 765);
    await page.locator('.edit-selection.kind-text').waitFor();
    // Leaving before the keys' pause writes the nudge.
    await page.keyboard.press('Shift+ArrowRight');
    await page.getByRole('button', { name: 'Modo lectura' }).click();
    assert(Math.abs(x(await exported('edit-nudge-on-leave.pdf')) - start - 10) < 1.5, 'The nudge is written');
    // The reader reopens the written PDF right after: the next check starts once it has.
    await page.waitForTimeout(1200);
    await page.waitForFunction(
      () =>
        !document.querySelector('canvas[data-live]') && !document.querySelector('[aria-label="Modo lectura"]:disabled'),
    );
    await settle();
    return { kept: true };
  });

  await check('a-change-not-yet-written-survives-opening-another-document', async () => {
    // The draft of this document, by its id (the SHA-256 of the file).
    const id = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
    const draft = () =>
      page.evaluate(
        id =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open('folio-library');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const get = request.result.transaction('drafts', 'readonly').objectStore('drafts').get(id);
              get.onsuccess = () =>
                resolve(btoa(Array.from(new Uint8Array(get.result), c => String.fromCharCode(c)).join('')));
              get.onerror = () => reject(get.error);
            };
          }),
        id,
      );
    const before = await draft(),
      x = bytes => textAt(new Uint8Array(Buffer.from(bytes, 'base64')), 'Informe trimestral').rect[0];
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();
    await page.locator('.edit-toolbar').waitFor();
    await pick(1, 100, 765);
    await page.locator('.edit-selection.kind-text').waitFor();
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(450);
    await settle();
    // Another document opens before the change is written (800 ms after it).
    const other = await PDFDocument.create();
    other
      .addPage([595, 842])
      .drawText('Otro documento', { x: 60, y: 760, size: 16, font: await other.embedFont(StandardFonts.Helvetica) });
    await page
      .locator('input[type=file][accept="application/pdf,.pdf"]')
      .first()
      .setInputFiles({ name: 'otro.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await other.save()) });
    await page.waitForFunction(
      () => document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'otro.pdf',
    );
    // Back to the first document: it shows the change, and its draft holds it.
    await page.locator('.document-tab [role=tab][aria-label="edit-mode.pdf"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'edit-mode.pdf' &&
        !document.querySelector('canvas[data-live]') &&
        !document.querySelector('[aria-label="Modo lectura"]:disabled'),
    );
    await settle();
    let written = before;
    for (let i = 0; i < 50 && written === before; i++) {
      await page.waitForTimeout(100);
      written = await draft();
    }
    assert(Math.abs(x(written) - x(before) - 10) < 1.5, `Moved 10 pt: ${x(before)} → ${x(written)}`);
    // The text layer follows the pixels once scrolling settles.
    const span = page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span', { hasText: 'Informe' }).first();
    await span.waitFor();
    const shown = await span.boundingBox(),
      box = await pageBox(1);
    assert(Math.abs((shown.x - box.x) / (box.width / 595) - x(written)) < 3, 'The reader shows the moved title');
    // Closing the live document folded its changes into one step back to the PDF it was opened from (the original):
    // undoing them all returns to the file itself, so its draft is discarded and nothing is left to save.
    const original = textAt(new Uint8Array(fs.readFileSync(fixture)), 'Informe trimestral').rect[0];
    let restored = written;
    for (let i = 0; i < 12 && restored; i++) {
      await page.keyboard.press('Control+z');
      await page.waitForFunction(() => !document.querySelector('[aria-label="Modo lectura"]:disabled'));
      await page.waitForTimeout(300);
      restored = await draft();
    }
    assert.equal(restored, '', 'The draft is discarded once every change is undone');
    await settle();
    const back = await span.boundingBox(),
      page1 = await pageBox(1);
    assert(Math.abs((back.x - page1.x) / (page1.width / 595) - original) < 3, 'The reader shows the original title');
    assert.equal(await page.locator('.download-button.pending').count(), 0, 'Nothing left to save');
    assert.equal(await page.getByText('Folio encontró un error').count(), 0, 'No error screen');
    return { writtenBeforeSwitching: true, readerReloaded: true, foldedToOriginal: true, cleanAgain: true };
  });

  await check('undoing-every-change-in-editar-leaves-nothing-to-save', async () => {
    const fresh = await PDFDocument.create();
    fresh
      .addPage([595, 842])
      .drawText('Documento limpio', { x: 60, y: 760, size: 16, font: await fresh.embedFont(StandardFonts.Helvetica) });
    const bytes = Buffer.from(await fresh.save()),
      id = crypto.createHash('sha256').update(bytes).digest('hex');
    const stored = () =>
      page.evaluate(
        id =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open('folio-library');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const get = request.result.transaction('drafts', 'readonly').objectStore('drafts').get(id);
              get.onsuccess = () => resolve(!!get.result);
              get.onerror = () => reject(get.error);
            };
          }),
        id,
      );
    await page
      .locator('input[type=file][accept="application/pdf,.pdf"]')
      .first()
      .setInputFiles({ name: 'limpio.pdf', mimeType: 'application/pdf', buffer: bytes });
    await page.waitForFunction(
      () => document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'limpio.pdf',
    );
    await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();
    await page.locator('.edit-toolbar').waitFor();
    await pick(1, 100, 765);
    await page.locator('.edit-selection.kind-text').waitFor();
    await page.keyboard.press('Shift+ArrowRight');
    await settle();
    // Written after a pause: a draft and the unsaved mark.
    for (let i = 0; i < 50 && !(await stored()); i++) await page.waitForTimeout(100);
    assert(await stored(), 'The change was written as a draft');
    await page.locator('.download-button.pending').waitFor();
    // One undo returns to the file: no draft, nothing to save, and leaving Editar has nothing to reopen.
    await page.keyboard.press('Control+z');
    await settle();
    await page.waitForFunction(() => !document.querySelector('.download-button.pending'));
    for (let i = 0; i < 50 && (await stored()); i++) await page.waitForTimeout(100);
    assert(!(await stored()), 'The draft is discarded');
    let busy = false;
    await page.exposeFunction('sawBusy', () => {
      busy = true;
    });
    await page.evaluate(() =>
      new MutationObserver(() => {
        if (document.querySelector('[aria-label="Modo lectura"]:disabled, .loading-overlay')) window.sawBusy();
      }).observe(document.body, { subtree: true, childList: true, attributes: true }),
    );
    await page.getByRole('button', { name: 'Modo lectura' }).click();
    await page.locator('.edit-toolbar').waitFor({ state: 'detached' });
    await page.waitForTimeout(1500);
    assert(!busy, 'Leaving Editar reopens nothing');
    assert.equal(await page.locator('.download-button.pending').count(), 0, 'Still nothing to save');
    return { draftDiscarded: true, nothingToSave: true, noReopen: true };
  });

  await check('clicking-again-picks-what-lies-beneath-in-turn', async () => {
    // Text over a small box over a large box the PDF draws: three items under one point.
    const stacked = await PDFDocument.create(),
      sheet = stacked.addPage([595, 842]);
    sheet.drawRectangle({ x: 100, y: 500, width: 300, height: 200, color: rgb(0.85, 0.9, 0.95) });
    sheet.drawRectangle({ x: 150, y: 560, width: 200, height: 80, color: rgb(0.7, 0.8, 0.9) });
    sheet.drawText('Encima de todo', {
      x: 180,
      y: 596,
      size: 14,
      font: await stacked.embedFont(StandardFonts.Helvetica),
    });
    await page
      .locator('input[type=file][accept="application/pdf,.pdf"]')
      .first()
      .setInputFiles({ name: 'apilados.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await stacked.save()) });
    await page.waitForFunction(
      () => document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'apilados.pdf',
    );
    await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();
    await page.locator('.edit-toolbar').waitFor();
    const kinds = [],
      rects = [];
    await pick(1, 200, 600);
    for (let i = 0; i < 4; i++) {
      if (i) {
        // Apart enough not to be a double click, which starts typing.
        await page.waitForTimeout(700);
        const at = await toScreen(1, 200, 600);
        await page.mouse.click(at.x, at.y);
      }
      await page.waitForFunction(() => document.querySelector('.edit-selection'));
      kinds.push(await page.locator('.edit-selection').evaluate(node => /kind-(\w+)/.exec(node.className)?.[1]));
      rects.push(JSON.stringify(await page.locator('.edit-selection').boundingBox()));
    }
    assert.deepEqual(kinds, ['text', 'graphic', 'graphic', 'text'], `Each click one deeper: ${kinds}`);
    assert.notEqual(rects[1], rects[2], 'The small box, then the large one');
    assert.equal(await page.getByRole('textbox', { name: 'Texto del párrafo' }).count(), 0, 'No typing started');
    await page.getByRole('button', { name: 'Modo lectura' }).click();
    await page.locator('.edit-toolbar').waitFor({ state: 'detached' });
    return { order: kinds };
  });

  await check('moving-lines-up-with-other-items-and-alt-moves-freely', async () => {
    const aligned = await PDFDocument.create(),
      font = await aligned.embedFont(StandardFonts.Helvetica),
      sheet = aligned.addPage([595, 842]);
    sheet.drawText('Alfa', { x: 60, y: 700, size: 14, font });
    sheet.drawText('Beta', { x: 200, y: 600, size: 14, font });
    const bytes = Buffer.from(await aligned.save()),
      id = crypto.createHash('sha256').update(bytes).digest('hex');
    const draftX = async previous => {
      for (let i = 0; i < 60; i++) {
        const value = await page.evaluate(
          id =>
            new Promise((resolve, reject) => {
              const request = indexedDB.open('folio-library');
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const get = request.result.transaction('drafts', 'readonly').objectStore('drafts').get(id);
                get.onsuccess = () =>
                  resolve(
                    get.result
                      ? btoa(Array.from(new Uint8Array(get.result), c => String.fromCharCode(c)).join(''))
                      : '',
                  );
                get.onerror = () => reject(get.error);
              };
            }),
          id,
        );
        if (value && value !== previous)
          return { value, x: textAt(new Uint8Array(Buffer.from(value, 'base64')), 'Beta').rect[0] };
        await page.waitForTimeout(100);
      }
      throw new Error('The move was not written');
    };
    await page
      .locator('input[type=file][accept="application/pdf,.pdf"]')
      .first()
      .setInputFiles({ name: 'guias.pdf', mimeType: 'application/pdf', buffer: bytes });
    await page.waitForFunction(
      () => document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'guias.pdf',
    );
    await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();
    await page.locator('.edit-toolbar').waitFor();
    // Beta's left edge dragged 3 pt short of Alfa's: it lines up, and a guide shows where.
    const drag = async (from, to, alt) => {
      // The layer reads the page once the pointer is over it; the hover follows the next move.
      let start = await toScreen(1, from, 604);
      await page.mouse.move(start.x - 2, start.y);
      await page.locator('.edit-layer[data-edit-page="1"][data-edit-state=ready]').waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      start = await toScreen(1, from, 604);
      await page.mouse.move(start.x, start.y);
      // A selected item shows its selection instead of the hover.
      await page.locator('.edit-hover, .edit-selection.kind-text').first().waitFor();
      await page.mouse.down();
      if (alt) await page.keyboard.down('Alt');
      const end = await toScreen(1, to, 604);
      await page.mouse.move((start.x + end.x) / 2, end.y, { steps: 4 });
      await page.mouse.move(end.x, end.y, { steps: 4 });
      const guide = await page.locator('.edit-guide.vertical').count();
      await page.mouse.up();
      if (alt) await page.keyboard.up('Alt');
      await settle();
      return guide;
    };
    const guided = await drag(205, 205 - 137, false),
      snapped = await draftX('');
    assert.equal(guided, 1, 'A guide shows while it lines up');
    assert(Math.abs(snapped.x - 60) < 0.5, `Lined up with Alfa: ${snapped.x}`);
    // Held Alt: the same kind of drag lands where it is dropped.
    const free = await drag(snapped.x + 5, snapped.x + 5 + 140, true),
      dropped = await draftX(snapped.value);
    const back = await drag(dropped.x + 5, dropped.x + 5 - 137, true),
      loose = await draftX(dropped.value);
    assert.equal(free + back, 0, 'No guides with Alt held');
    assert(Math.abs(loose.x - 63) < 1, `Not lined up: ${loose.x}`);
    await page.getByRole('button', { name: 'Modo lectura' }).click();
    // The reader opens the written PDF before anything else opens.
    await page.waitForFunction(
      () =>
        !document.querySelector('.edit-toolbar') &&
        !document.querySelector('canvas[data-live]') &&
        !document.querySelector('[aria-label="Modo lectura"]:disabled'),
    );
    await settle();
    return { snappedTo: Math.round(snapped.x), freeTo: Math.round(loose.x) };
  });

  await check('the-opacity-slider-shows-the-image-faded-while-sliding', async () => {
    const faded = await PDFDocument.create(),
      sheet = faded.addPage([595, 842]);
    sheet.drawImage(await faded.embedPng(swatch.asPNG()), { x: 100, y: 500, width: 200, height: 150 });
    const bytes = Buffer.from(await faded.save()),
      id = crypto.createHash('sha256').update(bytes).digest('hex');
    await page
      .locator('input[type=file][accept="application/pdf,.pdf"]')
      .first()
      .setInputFiles({ name: 'opacidad.pdf', mimeType: 'application/pdf', buffer: bytes });
    await page.waitForFunction(
      () => document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'opacidad.pdf',
    );
    await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();
    await page.locator('.edit-toolbar').waitFor();
    await pick(1, 200, 575);
    await page.locator('.edit-selection.kind-image').waitFor();
    // Held on the slider at about 40 %: the image shows faded before anything is written.
    const slider = page.getByRole('slider', { name: 'Opacidad de la imagen' }),
      track = await slider.boundingBox();
    await page.mouse.move(track.x + track.width - 2, track.y + track.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * 0.4, track.y + track.height / 2, { steps: 6 });
    const value = Number(await slider.inputValue()) / 100;
    await page.waitForFunction(
      value => {
        const sprite = document.querySelector('.edit-sprite');
        return sprite && Math.abs(Number(sprite.style.opacity) - value) < 0.01;
      },
      value,
      { timeout: 10000 },
    );
    const live = await page.locator('.edit-sprite').evaluate(node => Number(node.style.opacity));
    await page.mouse.up();
    await settle();
    // Letting go writes it into the PDF.
    let opacity;
    for (let i = 0; i < 60 && opacity === undefined; i++) {
      const stored = await page.evaluate(
        id =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open('folio-library');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const get = request.result.transaction('drafts', 'readonly').objectStore('drafts').get(id);
              get.onsuccess = () =>
                resolve(
                  get.result ? btoa(Array.from(new Uint8Array(get.result), c => String.fromCharCode(c)).join('')) : '',
                );
              get.onerror = () => reject(get.error);
            };
          }),
        id,
      );
      if (stored)
        opacity = items(new Uint8Array(Buffer.from(stored, 'base64'))).find(item => item.kind === 'image')?.opacity;
      else await page.waitForTimeout(100);
    }
    assert(value > 0.3 && value < 0.5, `Slid to about 40 %: ${value}`);
    assert(Math.abs(opacity - value) < 0.02, `Written: ${opacity}`);
    await page.getByRole('button', { name: 'Modo lectura' }).click();
    await page.locator('.edit-toolbar').waitFor({ state: 'detached' });
    return { shownWhileSliding: live, written: opacity };
  });

  await check('position-and-size-typed-in-the-inspector', async () => {
    const placed = await PDFDocument.create(),
      sheet = placed.addPage([595, 842]);
    sheet.drawImage(await placed.embedPng(swatch.asPNG()), { x: 120, y: 480, width: 200, height: 150 });
    const bytes = Buffer.from(await placed.save()),
      id = crypto.createHash('sha256').update(bytes).digest('hex');
    const written = async previous => {
      for (let i = 0; i < 80; i++) {
        const stored = await page.evaluate(
          id =>
            new Promise((resolve, reject) => {
              const request = indexedDB.open('folio-library');
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const get = request.result.transaction('drafts', 'readonly').objectStore('drafts').get(id);
                get.onsuccess = () =>
                  resolve(
                    get.result
                      ? btoa(Array.from(new Uint8Array(get.result), c => String.fromCharCode(c)).join(''))
                      : '',
                  );
                get.onerror = () => reject(get.error);
              };
            }),
          id,
        );
        const rect = stored
          ? items(new Uint8Array(Buffer.from(stored, 'base64'))).find(item => item.kind === 'image')?.rect
          : null;
        if (rect && JSON.stringify(rect) !== JSON.stringify(previous)) return rect;
        await page.waitForTimeout(100);
      }
      throw new Error('Nothing written');
    };
    // The last check left Editar: a file chosen while the reader reopens its PDF is not opened.
    await page.waitForFunction(() => !document.querySelector('[aria-label="Modo lectura"]:disabled'));
    await page
      .locator('input[type=file][accept="application/pdf,.pdf"]')
      .first()
      .setInputFiles({ name: 'posicion.pdf', mimeType: 'application/pdf', buffer: bytes });
    await page.waitForFunction(
      () => document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'posicion.pdf',
    );
    await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();
    await page.locator('.edit-toolbar').waitFor();
    await pick(1, 220, 555);
    await page.locator('.edit-selection.kind-image').waitFor();
    // Counted from the page's top left corner, in points.
    const x = page.getByLabel('Posición X', { exact: true }),
      y = page.getByLabel('Posición Y', { exact: true });
    assert.equal(await x.inputValue(), '120');
    assert.equal(await y.inputValue(), String(842 - 630));
    await x.fill('60');
    await x.press('Enter');
    let rect = await written(null);
    assert(Math.abs(rect[0] - 60) < 0.5 && Math.abs(rect[2] - 260) < 0.5, `Moved to x 60: ${rect}`);
    await settle();
    await page.locator('.edit-selection.kind-image').waitFor();
    const width = page.getByLabel('Ancho del elemento', { exact: true });
    await page.waitForFunction(() => document.querySelector('[aria-label="Posición X"]')?.value === '60');
    await width.fill('100');
    await width.press('Enter');
    rect = await written(rect);
    assert(Math.abs(rect[2] - rect[0] - 100) < 0.5 && Math.abs(rect[3] - 630) < 0.5, `100 pt wide, same top: ${rect}`);
    await settle();
    await page.getByRole('button', { name: 'Modo lectura' }).click();
    await page.locator('.edit-toolbar').waitFor({ state: 'detached' });
    return { moved: true, resized: true };
  });
} finally {
  for (const result of results) console.log(JSON.stringify(result));
  fs.writeFileSync(
    path.join(output, 'edit-mode-ui-results.json'),
    JSON.stringify({ browser: useWebKit ? 'WebKit' : 'Chromium', results }, null, 2),
  );
  await browser.close();
  server.kill();
}
process.exitCode = results.length === 22 && results.every(result => result.status === 'passed') ? 0 : 1;
