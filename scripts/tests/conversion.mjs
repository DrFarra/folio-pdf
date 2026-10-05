import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { writeAnnotations } from '../../src/engine/mupdf-engine.mjs';

const root = process.cwd(), output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const fixture = await PDFDocument.create(), font = await fixture.embedFont(StandardFonts.Helvetica);
for (let index = 0; index < 3; index++) {
  const page = fixture.addPage(index === 2 ? [100, 200] : [200, 100]);
  if (index === 2) page.setRotation(degrees(90));
  page.drawRectangle({ x: 10, y: 10, width: 20, height: 20, color: rgb(1, 0, 0) });
  page.drawText(`PUBLIC PAGE ${index + 1}`, { x: 40, y: 55, size: 10, font });
}
const source = new Uint8Array(await fixture.save());
const annotated = writeAnnotations(source, [{ id: 'conversion-highlight', kind: 'highlight', page: 1,
  rect: [100, 20, 150, 40], quads: [[100, 40, 150, 40, 100, 20, 150, 20]],
  color: '#f5d164', opacity: .5, text: 'PUBLIC COMMENT', created: 1 }]);
const oversized = await PDFDocument.create(); oversized.addPage([2000, 2000]);
const oversizedBytes = new Uint8Array(await oversized.save());
const digest = bytes => createHash('sha256').update(bytes).digest('hex'), originalHash = digest(source);
const executablePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(fs.existsSync);
assert(executablePath, 'A Chromium executable is required.');
const origin = 'http://127.0.0.1:4248';
// Test the source module through Vite without modifying or rebuilding shared dist.
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '4248', '--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
let browser, serverLog = '';
const results = [], errors = [];
server.stdout.on('data', chunk => { serverLog += chunk; }); server.stderr.on('data', chunk => { serverLog += chunk; });
function pngMetadata(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), density = [];
  let width, height;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = data.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    assert(offset + length + 12 <= bytes.length);
    if (type === 'IHDR') { width = data.getUint32(offset + 8); height = data.getUint32(offset + 12); }
    if (type === 'pHYs') density.push({ x: data.getUint32(offset + 8), y: data.getUint32(offset + 12), unit: bytes[offset + 16] });
    offset += length + 12;
  }
  return { width, height, density };
}
async function check(id, action) {
  try { results.push({ id, status: 'passed', ...await action() }); }
  catch (error) { results.push({ id, status: 'failed', error: error.stack }); process.exitCode = 1; }
  console.log(JSON.stringify(results.at(-1)));
}
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    if (server.exitCode !== null) throw new Error(serverLog);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext(), page = await context.newPage();
  // Vite dev does not bundle the dependency's dynamic WASM URL as production
  // builds do. Serve its real local binary; the actual engine worker still runs.
  await page.route('**/*mupdf-wasm.wasm*', route => route.fulfill({ path: path.join(root, 'node_modules/mupdf/dist/mupdf-wasm.wasm'), contentType: 'application/wasm' }));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); page.setDefaultTimeout(30000);
  await page.evaluate(async ({ source, annotated, oversized }) => {
    const conversion = await import('/src/conversion.ts'), pdf = await import('/src/pdf.ts'), assets = await import('/src/assets.ts');
    const document = await pdf.getDocument({ data: new Uint8Array(source), ...assets.pdfAssetSettings() }).promise;
    window.conversionTest = { conversion, document, source, annotated, oversized };
    window.convertPublic = async (format, pages, options, cancel = '') => {
      const controller = new AbortController(), progress = [];
      if (cancel === 'before') controller.abort();
      const originalToBlob = HTMLCanvasElement.prototype.toBlob;
      if (cancel === 'encoding') HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
        return originalToBlob.call(this, blob => { controller.abort(); callback(blob); }, ...args);
      };
      try {
        const output = await conversion.convertPdf(new Uint8Array(annotated), document, undefined, format, pages, message => {
          progress.push(message);
          if (cancel === 'preflight' && message.startsWith('Comprobando')) controller.abort();
          if (cancel === 'packing' && message.startsWith('Preparando ZIP')) controller.abort();
        }, controller.signal, options);
        return { bytes: [...output], progress };
      } catch (error) { return { error: error.message, name: error.name, progress }; }
      finally { HTMLCanvasElement.prototype.toBlob = originalToBlob; }
    };
  }, { source: [...source], annotated: [...annotated], oversized: [...oversizedBytes] });
  await check('shared-page-selection-validation-preserves-order-for-all-formats', async () => {
    const result = await page.evaluate(async () => {
      const { conversion: c } = window.conversionTest;
      const invalidRanges = ['', '0', '4', '2-1', '1.5', '1,', '1-999999999999999999999'], invalid = [];
      for (const input of invalidRanges) { try { c.parsePageRange(input, 3); invalid.push(input); } catch {} }
      const invalidPages = [[], [0], [4], [1.5], [NaN]], rejected = [];
      for (const format of ['txt', 'docx', 'png']) for (const pages of invalidPages) {
        const value = await window.convertPublic(format, pages);
        if (value.error && value.progress.length === 0) rejected.push(format);
      }
      return { selected: c.parsePageRange('3, 1-2, 2', 3), current: c.conversionPages('current', '', 2, 3), all: c.conversionPages('all', '', 2, 3), invalid, rejected: rejected.length };
    });
    assert.deepEqual(result.selected, [3, 1, 2]); assert.deepEqual(result.current, [2]); assert.deepEqual(result.all, [1, 2, 3]);
    assert.deepEqual(result.invalid, []); assert.equal(result.rejected, 15);
    return { currentAllAndRange: true, duplicatesRemovedInRequestedOrder: true, invalidBeforeProcessing: true };
  });
  await check('png-resolution-dimensions-density-and-rotated-page-selection', async () => {
    for (const dpi of [72, 144, 200, 300]) {
      const result = await page.evaluate(async dpi => await window.convertPublic('png', [3, 1], { dpi, background: 'white' }), dpi);
      assert(!result.error, result.error);
      const archive = unzipSync(new Uint8Array(result.bytes));
      assert.deepEqual(Object.keys(archive), ['pagina-0003.png', 'pagina-0001.png']);
      for (const bytes of Object.values(archive)) {
        const metadata = pngMetadata(bytes);
        assert.equal(metadata.width, Math.ceil(200 * dpi / 72)); assert.equal(metadata.height, Math.ceil(100 * dpi / 72));
        assert.deepEqual(metadata.density, [{ x: Math.round(dpi / .0254), y: Math.round(dpi / .0254), unit: 1 }]);
      }
      if (dpi === 300) fs.writeFileSync(path.join(output, 'conversion-300ppi.zip'), Buffer.from(result.bytes));
    }
    return { testedDpi: [72, 144, 200, 300], exactPixels: true, correctPhysicalDensity: true, selectedOrderAndRotation: true };
  });
  await check('png-background-alpha-and-current-annotations-use-export-bytes', async () => {
    const pixels = await page.evaluate(async () => {
      const { unzipSync } = await import('/node_modules/.vite/deps/fflate.js');
      const values = [];
      for (const background of ['white', 'transparent']) {
        const result = await window.convertPublic('png', [1], { dpi: 144, background });
        if (result.error) throw new Error(result.error);
        const bytes = unzipSync(new Uint8Array(result.bytes))['pagina-0001.png'];
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
        const blank = [...context.getImageData(5, 5, 1, 1).data], annotation = [...context.getImageData(260, 140, 1, 1).data];
        values.push({ background, blank, annotation }); canvas.width = 0; canvas.height = 0;
      }
      return values;
    });
    assert.deepEqual(pixels[0].blank, [255, 255, 255, 255]); assert.equal(pixels[1].blank[3], 0);
    assert(pixels[0].annotation[0] > 220 && pixels[0].annotation[2] < 220, JSON.stringify(pixels[0].annotation));
    assert(pixels[1].annotation[3] > 0, 'Current highlight must be present even with a transparent background.');
    return { whiteOpaque: true, transparentAlpha: true, exportedHighlightPresent: true };
  });
  await check('png-oversized-page-is-rejected-in-preflight-without-silent-downscale', async () => {
    const result = await page.evaluate(async () => {
      const { conversion, oversized } = window.conversionTest, progress = [];
      try {
        await conversion.convertPdf(new Uint8Array(oversized), { numPages: 1 }, undefined, 'png', [1], message => progress.push(message), new AbortController().signal, { dpi: 300, background: 'white' });
        return { success: true, progress };
      } catch (error) { return { error: error.message, progress }; }
    });
    assert(result.error?.includes('300 ppp') && result.error.includes('16 millones'));
    assert(!result.progress.some(message => message.startsWith('Convirtiendo')));
    return { rejectedBeforeCanvas: true, resolutionNeverReduced: true };
  });
  await check('txt-and-docx-use-validated-selected-pages-in-requested-order', async () => {
    const txt = await page.evaluate(async () => await window.convertPublic('txt', [2, 1]));
    assert(!txt.error, txt.error); const content = new TextDecoder().decode(new Uint8Array(txt.bytes));
    assert(content.indexOf('PUBLIC PAGE 2') < content.indexOf('PUBLIC PAGE 1')); assert(!content.includes('PUBLIC PAGE 3'));
    const docx = await page.evaluate(async () => await window.convertPublic('docx', [2]));
    assert(!docx.error, docx.error); const archive = unzipSync(new Uint8Array(docx.bytes)), xml = new TextDecoder().decode(archive['word/document.xml']);
    assert(xml.includes('PUBLIC PAGE 2')); assert(!xml.includes('PUBLIC PAGE 1') && !xml.includes('PUBLIC PAGE 3'));
    return { selectedTextOnly: true, requestedOrder: true, selectedDocxOnly: true };
  });
  await check('png-cancel-before-preflight-encoding-and-packing-keeps-source-usable', async () => {
    for (const cancel of ['before', 'preflight', 'encoding', 'packing']) {
      const result = await page.evaluate(async cancel => await window.convertPublic('png', [1, 2], { dpi: 144, background: 'white' }, cancel), cancel);
      assert.equal(result.name, 'AbortError', `${cancel}: ${JSON.stringify(result)}`); assert(!result.bytes);
    }
    const recovered = await page.evaluate(async () => await window.convertPublic('png', [1], { dpi: 72, background: 'white' }));
    assert(!recovered.error, recovered.error); assert(unzipSync(new Uint8Array(recovered.bytes))['pagina-0001.png']);
    assert.equal(digest(source), originalHash);
    return { canceledStages: ['before', 'preflight', 'encoding', 'packing'], noPartialExport: true, originalAndReaderRemainUsable: true };
  });
  await page.evaluate(async () => { await window.conversionTest.document.loadingTask.destroy(); });
  await context.close();
} finally {
  await browser?.close(); server.kill();
  fs.writeFileSync(path.join(output, 'conversion-results.json'), JSON.stringify({ results, errors }, null, 2) + '\n');
  if (errors.length) { console.log(JSON.stringify({ errors })); process.exitCode = 1; }
}
