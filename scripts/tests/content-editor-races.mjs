import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { operateDocument } from '../../src/engine/operations.mjs';

// The harness supplies delayed public props to the actual component. Only the
// page-image worker's dispatch is gated; extraction and preview use the real
// engines. No test controls or interception are added to production sources.
const root = process.cwd(), output = path.join(root, 'test-results');
const temporary = path.join(root, '.tools', 'content-editor-races-harness');
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(temporary, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function picture(colors) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false);
  try {
    const pixels = pixmap.getPixels();
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) pixels.set(colors[x < 20 ? 0 : 1], y * pixmap.getStride() + x * 3);
    return new Uint8Array(pixmap.asPNG());
  } finally { pixmap.destroy(); }
}
const originalPng = picture([[255, 128, 0], [0, 180, 50]]);
const manualPng = picture([[255, 0, 255], [0, 100, 255]]);
const fixture = await PDFDocument.create(); fixture.addPage([400, 500]);
const source = operateDocument(await fixture.save(), { operation: 'add-image', page: 1, rect: [50, 80, 230, 160], image: originalPng, fit: 'stretch', rotation: 90, opacity: .4 });
const item = operateDocument(source, { operation: 'page-content', page: 1 }).items.find(value => value.kind === 'image' && value.editable);
assert(item, 'The fixture must contain a safely editable image.');
const extracted = operateDocument(source, { operation: 'page-image', page: 1, id: item.id });
assert.equal(extracted.rotation, 90); assert(Math.abs(extracted.opacity - .4) < .001);
const manualFile = path.join(temporary, 'manual-selection.png'); fs.writeFileSync(manualFile, manualPng);
fs.writeFileSync(path.join(temporary, 'source.pdf'), source);
fs.writeFileSync(path.join(temporary, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>:root{--canvas:#eee;--line:#bbb;--surface:#fff;--text:#202020;--muted:#555}body{font:14px Arial;margin:18px}#root{display:flex;height:680px;width:1100px}button,input,select{font:inherit}button{cursor:pointer}</style></head><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>`);
fs.writeFileSync(path.join(temporary, 'harness.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ContentEditor from '/src/components/ContentEditor.tsx';
import { getDocument } from '/src/pdf.ts';
import { pdfAssetSettings } from '/src/assets.ts';
const bytes = new Uint8Array(await (await fetch('./source.pdf')).arrayBuffer());
const loading = getDocument({ ...pdfAssetSettings(), data: new Uint8Array(bytes) });
const pdf = await loading.promise;
const item = ${JSON.stringify(item)};
const scenario = new URLSearchParams(location.search).get('scenario');
let releaseSnapshot;
const snapshotGate = scenario === 'manual-before-snapshot' ? new Promise(resolve => { releaseSnapshot = resolve; }) : Promise.resolve();
window.__race = { snapshotRequested: false, snapshotReleased: scenario !== 'manual-before-snapshot', applied: null, source: Array.from(bytes) };
window.__releaseSnapshot = () => { window.__race.snapshotReleased = true; releaseSnapshot?.(); };
const doc = { pdf, bytes, id: 'race-source', revision: 'race-revision', name: 'source.pdf', size: bytes.length, password: '', canEdit: true, canCopy: true, canAnnotate: true, canAssemble: true };
createRoot(document.getElementById('root')).render(<ContentEditor doc={doc} area={{page:1,rect:item.rect}} initialItem={item} kind="replace-image" active busy={false}
 getBytes={async () => { window.__race.snapshotRequested = true; await snapshotGate; return new Uint8Array(bytes); }}
 onApply={async operation => { window.__race.applied = { ...operation, image: Array.from(operation.image) }; }} onCancel={() => {}} />);
`);

const chrome = findChrome();
assert(chrome, 'A Chromium executable is required.');
const port = process.env.FOLIO_EDITOR_RACES_PORT || '4259', origin = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', port, '--strictPort'], { windowsHide: true, stdio: 'pipe' });
let browser, log = ''; const results = [], errors = [];
server.stdout.on('data', value => { log += value; }); server.stderr.on('data', value => { log += value; });
async function check(id, run) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 760 } }), page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push({ id, message: error.message }));
  // Vite dev prebundles worker imports separately; supply the installed engine's
  // unchanged WASM binary at its resolved request URL, as other dev harnesses do.
  await page.route('**/*mupdf-wasm.wasm*', route => route.fulfill({ path: path.join(root, 'node_modules/mupdf/dist/mupdf-wasm.wasm'), contentType: 'application/wasm' }));
  await page.addInitScript(() => {
    const RealWorker = window.Worker, pending = [];
    window.__imageReads = { requested: 0, posted: 0, completed: 0, terminated: 0 };
    window.__releaseImageReads = () => { for (const dispatch of pending.splice(0)) dispatch(); };
    window.Worker = class extends RealWorker {
      imageRead = false;
      stopped = false;
      constructor(...args) {
        super(...args);
        // Engine workers are reused, so count the response to the image request only.
        this.addEventListener('message', () => { if (this.imageRead) { this.imageRead = false; window.__imageReads.completed++; } });
      }
      postMessage(message, transfer) {
        if (message?.operation === 'operate' && message.options?.operation === 'page-image') {
          this.imageRead = true; window.__imageReads.requested++;
          pending.push(() => { if (!this.stopped) { window.__imageReads.posted++; super.postMessage(message, transfer); } });
        } else super.postMessage(message, transfer);
      }
      terminate() { this.stopped = true; if (this.imageRead) window.__imageReads.terminated++; super.terminate(); }
    };
  });
  try {
    await page.goto(origin + '/.tools/content-editor-races-harness/index.html?scenario=' + id);
    await page.locator('.content-editor').waitFor();
    await page.waitForFunction(() => window.__race?.snapshotRequested);
    results.push({ id, status: 'passed', ...await run(page) });
  } catch (error) {
    results.push({ id, status: 'failed', error: error.stack }); process.exitCode = 1;
    await page.screenshot({ path: path.join(output, 'failure-editor-race-' + id + '.png') });
  } finally { console.log(JSON.stringify(results.at(-1))); await context.close(); }
}
async function ready(page) {
  await page.locator('.content-editor[data-preview-state="ready"]').waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).click({ trial: true, timeout: 60000 });
}
async function captureApply(page) {
  await ready(page); await page.getByRole('button', { name: 'Aplicar cambios', exact: true }).click();
  const operation = await page.evaluate(() => window.__race.applied);
  assert(operation, 'The actual Apply button must emit an operation.');
  assert.equal(operation.operation, 'replace-image'); assert.deepEqual(operation.sourceRect, item.rect);
  assert.equal(digest(new Uint8Array(await page.evaluate(() => window.__race.source))), digest(source), 'Editing controls and preview must not mutate the source.');
  return { ...operation, image: new Uint8Array(operation.image) };
}
try {
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(origin + '/.tools/content-editor-races-harness/index.html')).ok) { started = true; break; } } catch {}
    if (server.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(started, log || 'The component harness did not start.');
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  await check('manual-before-snapshot', async page => {
    assert.equal(await page.evaluate(() => window.__race.snapshotReleased), false);
    await page.getByLabel('Imagen PNG o JPEG', { exact: true }).setInputFiles(manualFile);
    await page.locator('.content-image-info figcaption').filter({ hasText: 'manual-selection.png' }).waitFor();
    await page.evaluate(() => window.__releaseSnapshot());
    await ready(page);
    assert.equal(await page.evaluate(() => window.__imageReads.requested), 0, 'Snapshot completion must not launch an original-image read after a manual choice.');
    assert((await page.locator('.content-image-info figcaption').innerText()).includes('manual-selection.png'));
    const operation = await captureApply(page);
    assert.equal(digest(operation.image), digest(manualPng), 'Apply must retain the exact manually selected image.');
    assert.equal(operation.fit, 'contain');
    await page.screenshot({ path: path.join(output, 'editor-race-manual-before-snapshot.png') });
    return { snapshotReleasedAfterManualChoice: true, automaticImageReads: 0, selectedImageHash: digest(operation.image), realPreviewReady: true, sourceUnchanged: true };
  });
  await check('opacity-before-original-image', async page => {
    await page.waitForFunction(() => window.__imageReads.requested === 1);
    assert.equal(await page.evaluate(() => window.__imageReads.posted), 0, 'Original-image extraction must still be pending when the control changes.');
    await page.getByRole('spinbutton', { name: 'Opacidad', exact: true }).fill('37');
    assert.equal(await page.getByRole('combobox', { name: 'Rotación', exact: true }).inputValue(), '0');
    await page.evaluate(() => window.__releaseImageReads());
    await ready(page);
    assert.equal(await page.getByRole('combobox', { name: 'Ajuste de imagen', exact: true }).inputValue(), 'stretch', 'Untouched fit must recover the original frame mapping.');
    assert.equal(await page.getByRole('combobox', { name: 'Rotación', exact: true }).inputValue(), '90', 'Untouched rotation must recover the original orientation.');
    assert.equal(await page.getByRole('spinbutton', { name: 'Opacidad', exact: true }).inputValue(), '37', 'The explicitly changed opacity must survive extraction.');
    assert.equal(await page.evaluate(() => window.__imageReads.completed), 1, 'The real MuPDF worker must have completed extraction.');
    const operation = await captureApply(page);
    assert.equal(operation.opacity, .37); assert.equal(operation.rotation, 90); assert.equal(operation.fit, 'stretch');
    assert.equal(digest(operation.image), digest(extracted.bytes), 'Apply must reuse the actual original image pixels.');
    const edited = operateDocument(source, operation), imageInfo = operateDocument(edited, { operation: 'page-content', page: 1 }).items.find(value => value.kind === 'image' && value.editable);
    const image = operateDocument(edited, { operation: 'page-image', page: 1, id: imageInfo.id });
    assert.equal(image.rotation, 90); assert(Math.abs(image.opacity - .37) < .001);
    await page.screenshot({ path: path.join(output, 'editor-race-opacity-before-original-image.png') });
    return { pendingReadBeforeInteraction: true, originalFit: operation.fit, originalRotation: operation.rotation, chosenOpacity: operation.opacity, realMuPdfReadAndPreview: true, sourceUnchanged: true };
  });
} finally {
  await browser?.close(); server.kill();
  fs.writeFileSync(path.join(output, 'content-editor-races-results.json'), JSON.stringify({ date: new Date().toISOString(), sourceHash: digest(source), componentHash: digest(fs.readFileSync(path.join(root, 'src/components/ContentEditor.tsx'))), mode: 'real-component-vite-dev', port, results, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}
