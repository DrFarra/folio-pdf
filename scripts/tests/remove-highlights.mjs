import assert from 'node:assert/strict';
import { enterAnnotationMode } from './ui-helpers.mjs';
import { waitForSession } from './session-helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';

// Exercise the public UI with real pointer gestures. Imported highlights are
// authored directly as PDF annotations by MuPDF, without Folio's annotation writer.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const lines = [
  'REMOVE FIRST: Delete only this highlighted text.',
  'REMOVE SECOND: A multiline highlight is one annotation.',
  'KEEP THIRD: This independent highlight must remain.',
];
const fixture = await PDFDocument.create(), font = await fixture.embedFont(StandardFonts.Helvetica);
const sheet = fixture.addPage([600, 760]);
for (let i = 0; i < lines.length; i++) sheet.drawText(lines[i], { x: 60, y: 665 - i * 40, size: 14, font });
fixture.addPage([600, 760]).drawText('SECOND PAGE: Original content stays intact.', { x: 60, y: 665, size: 14, font });
const plainBytes = new Uint8Array(await fixture.save());
const source = path.join(output, 'remove-highlights-source.pdf');
fs.writeFileSync(source, plainBytes);

const imported = path.join(output, 'remove-highlights-external.pdf');
const targetName = 'External:qa-remove-multiline', retainedName = 'External:qa-keep-highlight';
const noteName = 'External:qa-keep-note', noteText = 'Comentario externo: conservar esta nota.';
const external = new mupdf.PDFDocument(plainBytes), nativePage = external.loadPage(0);
const quad = i => {
  const top = 760 - (665 - i * 40) - 13, bottom = top + 17;
  const right = 60 + font.widthOfTextAtSize(lines[i], 14);
  return [60, top, right, top, 60, bottom, right, bottom];
};
for (const [name, quads, text, color] of [
  [targetName, [quad(0), quad(1)], `${lines[0]}\n${lines[1]}`, [1, .85, .1]],
  [retainedName, [quad(2)], lines[2], [.45, .75, .95]],
]) {
  const annotation = nativePage.createAnnotation('Highlight');
  annotation.setName(name); annotation.setContents(text); annotation.setAuthor('External PDF editor');
  annotation.setQuadPoints(quads); annotation.setColor(color); annotation.setOpacity(.35);
  annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT); annotation.update(); annotation.destroy();
}
const note = nativePage.createAnnotation('Text');
note.setName(noteName); note.setContents(noteText); note.setAuthor('External PDF editor');
note.setRect([470, 180, 490, 200]); note.setIcon('Note');
note.setFlags(mupdf.PDFAnnotation.IS_PRINT); note.update(); note.destroy();
const buffer = external.saveToBuffer('garbage=4,compress=yes');
fs.writeFileSync(imported, new Uint8Array(buffer.asUint8Array()));
buffer.destroy(); nativePage.destroy(); external.destroy();
const importedBytes = new Uint8Array(fs.readFileSync(imported));
const importedAnnotations = inspectDocument(importedBytes).annotations;
const targetId = importedAnnotations.find(annotation => annotation.originalName === targetName)?.id;
assert(targetId && !targetId.startsWith('Folio:'), 'The fixture must contain a third-party PDF highlight.');
assert.equal(importedAnnotations.length, 3);
const readOnly = path.join(output, 'remove-highlights-readonly.pdf');
fs.writeFileSync(readOnly, operateDocument(importedBytes, { operation: 'protect', userPassword: '', ownerPassword: 'qa-owner', permissions: 16 }));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originals = new Map([source, imported, readOnly].map(file => [file, hash(file)]));
const originalText = operateDocument(plainBytes, { operation: 'text' });

function pdfAnnotations(bytes) {
  const document = new mupdf.PDFDocument(bytes), annotations = [];
  try {
    if (document.needsPassword()) assert(document.authenticatePassword(''), 'The QA fixture must open without a password prompt.');
    for (let index = 0; index < document.countPages(); index++) {
      const page = document.loadPage(index), native = page.getAnnotations();
      try {
        for (const annotation of native) {
          const object = annotation.getObject(), type = annotation.getType();
          annotations.push({ page: index + 1, type, name: object.get('NM').asString(),
            text: annotation.getContents(), author: annotation.getAuthor(), flags: annotation.getFlags(),
            color: annotation.getColor().map(value => +value.toFixed(5)),
            ...(annotation.hasRect() ? { rect: annotation.getRect().map(value => +value.toFixed(5)) } : {}),
            ...(type === 'Highlight' ? { quads: annotation.getQuadPoints().map(points => points.map(value => +value.toFixed(5))), appearance: !object.get('AP', 'N').isNull() } : {}),
          });
        }
      } finally { for (const annotation of native) annotation.destroy(); page.destroy(); }
    }
    return annotations;
  } finally { document.destroy(); }
}
const retainedOriginal = pdfAnnotations(importedBytes).filter(annotation => annotation.name !== targetName);
assert(retainedOriginal.find(annotation => annotation.name === retainedName)?.appearance);

const chrome = findChrome();
assert(process.env.FOLIO_TEST_BROWSER === 'webkit' || chrome, 'CHROME_PATH must identify an installed Chrome or Edge.');
const port = process.env.FOLIO_REMOVE_HIGHLIGHT_PORT || '4183', origin = `http://127.0.0.1:${port}`;
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'),
  'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let browser, log = '';
preview.stdout.on('data', data => { log += data; }); preview.stderr.on('data', data => { log += data; });
const results = [], errors = [];
const overlays = page => page.locator('.highlight-annotation:not(.preview)');
const menu = page => page.getByRole('menu', { name: 'Resaltado', exact: true });
const removeAction = page => menu(page).getByRole('menuitem', { name: 'Eliminar resaltado', exact: true });
const automatic = page => page.getByRole('button', { name: 'Resaltador (H)', exact: true });

async function open(page, file) {
  await page.locator('.app-header input[type=file]').setInputFiles(file);
  await page.getByRole('heading', { name: path.basename(file), exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.getByRole('combobox', { name: 'Nivel de zoom', exact: true }).selectOption('100');
  await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
  await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').first().waitFor();
}
async function expectOverlays(page, count) {
  await page.waitForFunction(count => document.querySelectorAll('.highlight-annotation:not(.preview)').length === count, count);
}
async function point(page, text, offset, end = false) {
  return page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: text }).first().evaluate((span, { offset, end }) => {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let remaining = end ? offset - 1 : offset;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (remaining < node.textContent.length) {
        const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, remaining + 1);
        const box = range.getBoundingClientRect();
        return { x: end ? box.right - box.width * .03 : box.left + box.width * .03, y: (box.top + box.bottom) / 2 };
      }
      remaining -= node.textContent.length;
    }
    throw new Error('No measurable text at the requested offset.');
  }, { offset, end });
}
async function highlight(page, first = 0, last = first) {
  await enterAnnotationMode(page);
  if (await automatic(page).getAttribute('aria-pressed') !== 'true') await automatic(page).click();
  const from = await point(page, lines[first], 0), to = await point(page, lines[last], lines[last].length, true);
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 14 }); await page.mouse.up();
  await overlays(page).first().waitFor();
}
async function showMenu(page, locator = overlays(page).first(), button = 'left') {
  // Pointer coordinates permit hit testing through the text layer rather than
  // bypassing it with force clicks or dispatchEvent.
  const box = await locator.boundingBox(); assert(box, 'The highlight must be visible.');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button });
  await menu(page).waitFor();
  assert.equal(await page.locator('.notes-panel').count(), 0, 'Direct deletion must not require opening the annotations panel.');
}
async function remove(page, locator, button) {
  await showMenu(page, locator, button);
  await removeAction(page).click();
  await menu(page).waitFor({ state: 'detached' });
}
async function download(page, suffix) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar', exact: true }).click();
  const file = await pending, target = path.join(output, `remove-highlights-${suffix}.pdf`); await file.saveAs(target);
  await page.waitForFunction(() => document.querySelector('.download-button:not([disabled])') && !document.querySelector('.loading-overlay') && !document.querySelector('.pdf-page-wrap[data-page-number="1"] .page-loading'));
  const bytes = new Uint8Array(fs.readFileSync(target));
  assert.deepEqual(operateDocument(bytes, { operation: 'text' }), originalText, 'Deleting a highlight must preserve the document text.');
  return { file: target, bytes, annotations: pdfAnnotations(bytes) };
}
async function reopened(file, expectedOverlays) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 1050 } }), page = await context.newPage();
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push({ id: 'reopened-export', error: error.message }));
  try { await page.goto(origin); await open(page, file); await expectOverlays(page, expectedOverlays); }
  finally { await context.close(); }
}
async function check(id, action, file = source, viewport = { width: 1360, height: 1050 }) {
  if (process.env.FOLIO_REMOVE_HIGHLIGHT_TEST && !new RegExp(process.env.FOLIO_REMOVE_HIGHLIGHT_TEST).test(id)) return;
  const context = await browser.newContext({ viewport, acceptDownloads: true }), page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push({ id, error: error.message }));
  try {
    await page.goto(origin); await open(page, file);
    const evidence = await action(page);
    for (const [original, before] of originals) assert.equal(hash(original), before, `The original PDF was modified: ${original}`);
    results.push({ id, status: 'passed', ...evidence, originalPdfImmutable: true });
  } catch (error) {
    process.exitCode = 1; results.push({ id, status: 'failed', error: error.stack });
    await page.screenshot({ path: path.join(output, `failure-${id}.png`), animations: 'disabled' }).catch(() => {});
  } finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    if (preview.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, log || 'Preview did not start.');
  browser = process.env.FOLIO_TEST_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ executablePath: chrome, headless: true });

  await check('new-multiline-highlight-direct-delete-undo-redo-and-export', async page => {
    await highlight(page, 0, 1); await expectOverlays(page, 2);
    await page.getByRole('button', { name: 'Seleccionar texto (V)', exact: true }).click();
    await showMenu(page, overlays(page).last());
    await page.screenshot({ path: path.join(output, 'remove-highlights-contextual-menu.png'), animations: 'disabled' });
    await removeAction(page).click();
    await expectOverlays(page, 0);
    await page.getByRole('button', { name: /^Deshacer \(/ }).click(); await expectOverlays(page, 2);
    await page.getByRole('button', { name: /^Rehacer \(/ }).click(); await expectOverlays(page, 0);
    const saved = await download(page, 'new-deleted'); assert.equal(saved.annotations.length, 0);
    await reopened(saved.file, 0);
    return { directContextualRemoval: true, multilineQuadsRemovedTogether: 2, undoRedoRestoresWholeAnnotation: true, exportedHighlightObjects: 0, reopenedHighlightObjects: 0 };
  });

  await check('external-pdf-highlight-delete-is-persistent-and-removes-real-pdf-object', async page => {
    await expectOverlays(page, 3);
    const target = page.locator(`.highlight-annotation[data-annotation-id="${targetId}"]`).last();
    await remove(page, await target.count() ? target : overlays(page).nth(1)); await expectOverlays(page, 1);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); await expectOverlays(page, 3);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y'); await expectOverlays(page, 1);
    await waitForSession(page, (session, id) => id === originals.get(imported) && session.annotations?.length === 2);
    await page.reload(); await open(page, imported); await expectOverlays(page, 1);
    const saved = await download(page, 'external-deleted');
    assert.equal(saved.annotations.length, 2);
    assert.equal(saved.annotations.filter(annotation => annotation.type === 'Highlight').length, 1);
    assert(!saved.annotations.some(annotation => annotation.name === targetName), 'The removed external annotation must be absent from PDF Annots.');
    assert.deepEqual(saved.annotations, retainedOriginal, 'Independent highlight and note dictionaries must stay intact.');
    assert.equal(inspectDocument(saved.bytes).annotations.filter(annotation => annotation.kind === 'highlight').length, 1);
    await reopened(saved.file, 1);
    return { thirdPartyStandardPdfHighlight: true, sourceReferenceHandled: targetId, nativePdfObjectRemoved: true, remainingStandardHighlights: 1, externalNotePreserved: true, undoRedoWorks: true, sessionReloadDoesNotRestoreDeletedHighlight: true, reopenedExportHasOnlyRetainedHighlight: true };
  }, imported);

  await check('highlight-tool-remains-active-after-direct-removal', async page => {
    await highlight(page); await expectOverlays(page, 1);
    assert.equal(await automatic(page).getAttribute('aria-pressed'), 'true');
    await remove(page); await expectOverlays(page, 0);
    assert.equal(await automatic(page).getAttribute('aria-pressed'), 'true', 'Deleting a highlight must preserve automatic highlight mode.');
    await highlight(page, 2); await expectOverlays(page, 1);
    const saved = await download(page, 'continued-highlighting');
    assert.equal(saved.annotations.length, 1); assert.equal(saved.annotations[0].type, 'Highlight');
    assert.equal(saved.annotations[0].text.trim(), lines[2]);
    return { removalWorksInHighlightMode: true, automaticModePreserved: true, nextTextSelectionHighlightsNormally: true };
  });

  await check('contextual-removal-dismisses-and-never-targets-another-tab', async page => {
    await highlight(page); await expectOverlays(page, 1);
    await page.getByRole('button', { name: 'Seleccionar texto (V)', exact: true }).click();
    await showMenu(page); await page.keyboard.press('Escape'); await menu(page).waitFor({ state: 'detached' }); await expectOverlays(page, 1);
    await showMenu(page); await page.mouse.click(1100, 400); await menu(page).waitFor({ state: 'detached' }); await expectOverlays(page, 1);
    await showMenu(page); await open(page, imported); await menu(page).waitFor({ state: 'detached' }); await expectOverlays(page, 3);
    await page.getByRole('tab', { name: path.basename(source), exact: true }).click();
    await page.getByRole('heading', { name: path.basename(source), exact: true }).waitFor(); await expectOverlays(page, 1);
    await remove(page); await expectOverlays(page, 0);
    await page.getByRole('tab', { name: path.basename(imported), exact: true }).click();
    await page.getByRole('heading', { name: path.basename(imported), exact: true }).waitFor(); await expectOverlays(page, 3);
    const saved = await download(page, 'other-tab-unchanged');
    assert.deepEqual(saved.annotations, pdfAnnotations(importedBytes));
    return { escapeDismisses: true, outsideClickDismisses: true, tabSwitchDismisses: true, removalStaysWithOriginalTab: true, otherPdfAnnotationsUnchanged: true };
  });

  await check('readonly-external-highlights-cannot-be-deleted', async page => {
    const first = await point(page, lines[0], Math.floor(lines[0].length / 2));
    await page.mouse.click(first.x, first.y);
    assert.equal(await page.getByRole('menuitem', { name: 'Eliminar resaltado', exact: true }).count(), 0, 'A PDF without annotation permission must not expose removal.');
    assert.equal(await automatic(page).count(), 0, 'Read-only documents keep annotation tools out of reading mode.');
    await page.getByRole('button', { name: 'Anotar documento', exact: true }).click();
    const explanation = page.getByRole('dialog', { name: 'Herramientas disponibles', exact: true });
    await explanation.waitFor();
    assert.match(await explanation.innerText(), /no permite anotarlo/i);
    await explanation.getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
    const saved = await download(page, 'readonly-preserved');
    assert.deepEqual(saved.annotations, pdfAnnotations(new Uint8Array(fs.readFileSync(readOnly))));
    return { annotationPermissionRespected: true, removalActionAbsent: true, standardHighlightsAndNotePreserved: true };
  }, readOnly);

  await check('repeated-and-interrupted-zoom-retains-bitmap-and-highlight-alignment', async page => {
    await highlight(page); await expectOverlays(page, 1);
    await page.getByRole('button', { name: 'Seleccionar texto (V)', exact: true }).click();
    await page.mouse.click(1100, 400);
    await page.evaluate(() => {
      const wrap = document.querySelector('.pdf-page-wrap[data-page-number="1"]');
      const trace = { frames: 0, minimumDarkPixels: Infinity, blankFrames: [], loaders: [], zeroDimensions: [], canvasRemovals: 0 };
      const inspect = (reason, pixels = false) => {
        const canvas = wrap.querySelector('.page-content > canvas');
        if (!canvas || canvas.width === 0 || canvas.height === 0) { trace.zeroDimensions.push(reason); return; }
        if (wrap.querySelector('.page-loading')) trace.loaders.push(reason);
        if (!pixels) return;
        const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let dark = 0;
        for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] > 0 && rgba[i] < 220 && rgba[i + 1] < 220 && rgba[i + 2] < 220) dark++;
        trace.minimumDarkPixels = Math.min(trace.minimumDarkPixels, dark);
        if (dark < 100) trace.blankFrames.push({ reason, dark, width: canvas.width, height: canvas.height });
      };
      const observer = new MutationObserver(records => {
        for (const record of records) if (record.type === 'childList') for (const node of record.removedNodes) {
          if (node instanceof Element && (node.matches('canvas[aria-label]') || node.querySelector('canvas[aria-label]'))) trace.canvasRemovals++;
        }
        inspect('mutation');
      });
      observer.observe(wrap, { subtree: true, attributes: true, attributeFilter: ['width', 'height'], childList: true });
      let frame;
      const sample = () => { trace.frames++; inspect('animation-frame', true); frame = requestAnimationFrame(sample); };
      sample();
      window.__folioZoomTrace = { trace, stop: () => { cancelAnimationFrame(frame); observer.disconnect(); return trace; } };
    });
    const sequence = [150, 90, 125, 100], zoom = page.getByRole('combobox', { name: 'Nivel de zoom', exact: true });
    const geometry = [];
    async function requestZoom(percent) {
      if (await zoom.locator(`option[value="${percent}"]`).count()) await zoom.selectOption(String(percent));
      else {
        // 90% is reached with the ordinary zoom controls; it is a dynamic
        // select option, so the test must not inject an option into the UI.
        let current = Number(await zoom.inputValue());
        while (current !== percent) {
          await page.getByRole('button', { name: current > percent ? 'Reducir zoom' : 'Ampliar zoom', exact: true }).click();
          const next = Number(await zoom.inputValue()); assert.notEqual(next, current); current = next;
        }
      }
    }
    async function settled(percent) {
      await page.waitForFunction(({ percent, text }) => {
        const wrap = document.querySelector('.pdf-page-wrap[data-page-number="1"]');
        const canvas = wrap?.querySelector('.page-content > canvas');
        const span = [...(wrap?.querySelectorAll('.textLayer span') || [])].find(node => node.textContent === text);
        if (!canvas || !span || wrap.querySelector('.page-loading')) return false;
        return canvas.width === Math.ceil(600 * percent / 100) && canvas.height === Math.ceil(760 * percent / 100)
          && Math.abs(parseFloat(getComputedStyle(span).fontSize) - 14 * percent / 100) < .1;
      }, { percent, text: lines[0] });
      const highlight = await overlays(page).first().boundingBox();
      const text = await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: lines[0] }).first().boundingBox();
      assert(highlight && text);
      assert(Math.abs(highlight.x - text.x) < 2 && Math.abs(highlight.width - text.width) < 3,
        `The highlight and text diverged at ${percent}%: ${JSON.stringify({ highlight, text })}`);
      geometry.push({ percent, highlightWidth: +highlight.width.toFixed(2), textWidth: +text.width.toFixed(2) });
    }
    for (const percent of sequence) { await requestZoom(percent); await settled(percent); }
    // Interrupt renders with another requested scale to exercise cancellation,
    // while the same previously painted page remains visible.
    for (const percent of [150, 90, 125, 100]) await requestZoom(percent);
    await settled(100);
    const trace = await page.evaluate(() => window.__folioZoomTrace.stop());
    assert(trace.frames >= 3, JSON.stringify(trace));
    assert.equal(trace.blankFrames.length, 0, `A zoom frame lost the page bitmap: ${JSON.stringify(trace)}`);
    assert.equal(trace.zeroDimensions.length, 0, `The page canvas disappeared or was reset to zero: ${JSON.stringify(trace)}`);
    assert.equal(trace.loaders.length, 0, `Zoom obscured an existing bitmap with a loading indicator: ${JSON.stringify(trace)}`);
    await page.screenshot({ path: path.join(output, 'remove-highlights-after-zoom.png'), animations: 'disabled' });
    await showMenu(page); await removeAction(page).click(); await expectOverlays(page, 0);
    return { requestedZoomPercents: [100, ...sequence], interruptedZoom: true, sampledFrames: trace.frames,
      minimumDarkPixels: trace.minimumDarkPixels, canvasRemovals: trace.canvasRemovals, blankFrames: 0,
      loadersDuringZoom: 0, textAndHighlightGeometry: geometry, contextualRemovalWorksAfterZoom: true };
  });

  assert.equal(errors.length, 0, JSON.stringify(errors));
} finally {
  if (browser) await browser.close(); preview.kill();
  fs.writeFileSync(path.join(output, 'remove-highlights-results.json'), JSON.stringify({ capturedAt: new Date().toISOString(), results, errors }, null, 2));
}
