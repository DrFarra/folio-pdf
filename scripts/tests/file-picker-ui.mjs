import assert from 'node:assert/strict';
import fs from 'node:fs';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { settled } from './ui-helpers.mjs';
import { PDFDocument } from 'pdf-lib';

const output = 'test-results/file-picker';
fs.mkdirSync(output, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
const image = name => ({ name, mimeType: 'image/png', buffer: png });
const longName = 'Apuntes_de_neumología_con_un_nombre_muy_largo_'.repeat(4) + '.png';
const reports = [];
let server, browser;

async function fits(page, id) {
  await settled(page);
  const dimensions = await page.locator('dialog[open]').evaluate(dialog => {
    const box = dialog.getBoundingClientRect();
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width,
      viewport: [innerWidth, innerHeight], overflow: dialog.scrollWidth > dialog.clientWidth + 1,
      nativeFileControls: [...dialog.querySelectorAll('input[type=file]')].filter(input => input.getBoundingClientRect().width > 2).length };
  });
  assert(dimensions.x >= 0 && dimensions.y >= 0 && dimensions.right <= dimensions.viewport[0] + 1 && dimensions.bottom <= dimensions.viewport[1] + 1, id + ' must fit the viewport');
  assert.equal(dimensions.overflow, false, id + ' must not overflow horizontally');
  assert.equal(dimensions.nativeFileControls, 0, id + ' must use the shared file control');
  if (await page.locator('.create-pdf-actions').count()) {
    assert(await page.getByRole('dialog', { name: 'Crear PDF', exact: true }).getByRole('button', { name: 'Crear PDF', exact: true }).evaluate(button => {
      const box = button.getBoundingClientRect();
      return box.y >= 0 && box.bottom <= innerHeight && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === button;
    }), 'The creation action must stay visible without scrolling');
  }
  await page.screenshot({ path: `${output}/${id}.png` });
  return dimensions;
}
async function openTools(page, mobile, phone) {
  if (mobile) await page.getByRole('button', { name: phone ? 'Más acciones' : 'Más acciones del documento', exact: true }).click();
  await page.getByRole('button', { name: 'Herramientas', exact: true }).click();
}
async function storedPdf(page, name) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await page.evaluate(async name => {
    const request = indexedDB.open('folio-library');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    // The catalog keeps metadata; the PDF bytes live in the 'files' store under the same id.
    const read = (store, query) => new Promise(resolve => { const req = db.transaction(store).objectStore(store)[query === undefined ? 'getAll' : 'get'](query); req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(undefined); });
    const record = (await read('documents')).find(record => record.name === name), data = record && await read('files', record.id);
    db.close();
    return data ? [...new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data)] : null;
    }, name);
    if (result?.length) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Created PDF was not saved: ' + name);
}

try {
  server = await preview({ logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  for (const [id, width, height, sw, sh] of [
    ['tablet-landscape', 1280, 800, 800, 1280], ['tablet-portrait', 800, 1280, 800, 1280],
    ['tablet-small', 600, 960, 600, 960], ['phone', 390, 844, 390, 844],
    ['phone-landscape', 844, 390, 390, 844], ['desktop', 1360, 900, 1360, 900],
  ]) {
    if (process.env.FOLIO_UI_CASE && process.env.FOLIO_UI_CASE !== id) continue;
    const mobile = id !== 'desktop', phone = sw < 600;
    const context = await browser.newContext({ viewport: { width, height }, screen: { width: sw, height: sh }, isMobile: mobile, hasTouch: mobile,
      userAgent: mobile ? `Mozilla/5.0 (Linux; Android 15; ${phone ? 'Mobile' : 'Tablet'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36` : undefined });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(origin);
      await page.getByRole('button', { name: 'Crear PDF', exact: true }).first().click();
      const empty = await fits(page, `${id}-empty`);
      if (!phone) assert(empty.width <= 541, 'Creation should use a compact dialog');
      if (id === 'tablet-landscape') {
        await page.evaluate(() => document.documentElement.style.setProperty('--visible-height', '360px'));
        await fits(page, `${id}-keyboard`);
        assert((await page.locator('dialog[open]').boundingBox()).y + (await page.locator('dialog[open]').boundingBox()).height <= 360);
        await page.evaluate(() => document.documentElement.style.removeProperty('--visible-height'));
      }
      await page.getByLabel('Nombre', { exact: true }).fill('  ');
      assert(await page.getByRole('dialog', { name: 'Crear PDF', exact: true }).getByRole('button', { name: 'Crear PDF', exact: true }).isDisabled());
      await page.getByLabel('Nombre', { exact: true }).fill('Imágenes.pdf');
      const choose = page.getByRole('button', { name: 'Añadir imágenes', exact: true });
      // Real button activation must still open the native file chooser.
      const chooserPromise = page.waitForEvent('filechooser');
      await choose.click();
      await (await chooserPromise).setFiles([image(longName), image('Segunda.png')]);
      assert.equal(await page.locator('.create-pdf-files>li').count(), 2);
      // Appending the same file must fire change again, and removing only one
      // entry must preserve the remaining page order.
      await page.getByLabel('Imágenes (opcional)', { exact: true }).setInputFiles(image('Segunda.png'));
      assert.equal(await page.locator('.create-pdf-files>li').count(), 3);
      await page.getByRole('button', { name: 'Quitar imagen 2', exact: true }).click();
      assert.equal(await page.locator('.create-pdf-files>li').count(), 2);
      assert.equal(await page.locator('.create-pdf-filename').last().textContent(), 'Segunda.png');
      await fits(page, `${id}-images`);
      await page.getByRole('dialog', { name: 'Crear PDF', exact: true }).getByRole('button', { name: 'Crear PDF', exact: true }).click();
      await page.getByRole('dialog', { name: 'Crear PDF', exact: true }).waitFor({ state: 'detached' });
      const created = await PDFDocument.load(new Uint8Array(await storedPdf(page, 'Imágenes.pdf')));
      assert.equal(created.getPageCount(), 2);
      await page.locator('.loading-overlay').waitFor({ state: 'detached' });
      await openTools(page, mobile, phone);
      await page.getByRole('button', { name: 'Comparar documentos', exact: true }).click();
      await page.getByLabel('Segundo PDF', { exact: true }).setInputFiles('public/sample.pdf');
      assert.equal(await page.locator('.file-picker-status.has-file').textContent(), 'sample.pdf');
      await fits(page, `${id}-compare`);
      await page.getByRole('button', { name: 'Volver a Herramientas', exact: true }).click();
      await page.getByRole('button', { name: 'Firmas digitales', exact: true }).click();
      await fits(page, `${id}-signatures`);
      const rootInput = page.getByLabel('Raíz de confianza (.cer o .pem, opcional)', { exact: true });
      await rootInput.setInputFiles({ name: 'Confianza.cer', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3]) });
      await page.getByText('Confianza.cer', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Volver a Herramientas', exact: true }).click();
      await page.getByRole('button', { name: 'Comparar documentos', exact: true }).click();
      assert.equal(await page.locator('.file-picker-status.has-file').textContent(), 'sample.pdf', 'Selection must survive navigation between tools');
      if (id === 'tablet-landscape') {
        await page.getByRole('button', { name: 'Comparar', exact: true }).click();
        await page.locator('.visual-comparison img').first().waitFor();
        await fits(page, `${id}-compared`);
      }
      await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
      // Blank creation remains available from the library without opening a file chooser.
      await page.getByRole('button', { name: mobile ? 'Volver a la biblioteca' : 'Biblioteca', exact: true }).click();
      await page.getByRole('button', { name: 'Crear PDF', exact: true }).first().click();
      await page.getByLabel('Nombre', { exact: true }).fill('En blanco.pdf');
      await page.getByRole('dialog', { name: 'Crear PDF', exact: true }).getByRole('button', { name: 'Crear PDF', exact: true }).click();
      const blank = await PDFDocument.load(new Uint8Array(await storedPdf(page, 'En blanco.pdf')));
      assert.equal(blank.getPageCount(), 1);
      assert.deepEqual(errors, []);
      reports.push({ id, passed: true, generatedPages: created.getPageCount() });
    } catch (error) {
      reports.push({ id, passed: false, error: error.stack }); process.exitCode = 1;
      await page.screenshot({ path: `${output}/${id}-failure.png` });
    } finally { await context.close(); }
    console.log(JSON.stringify(reports.at(-1)));
  }
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.httpServer.close(resolve));
  fs.writeFileSync(`${output}/results.json`, JSON.stringify(reports, null, 2));
}
