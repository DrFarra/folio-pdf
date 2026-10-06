import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import ts from 'typescript';
import { operateDocument } from '../../src/engine/operations.mjs';
import { inspectDocument, open, save, writeAnnotations } from '../../src/engine/mupdf-engine.mjs';

const results = [], hash = bytes => createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync('test-results', { recursive: true });
async function check(id, test) {
  try { results.push({ id, status: 'passed', ...await test() }); }
  catch (error) { results.push({ id, status: 'failed', error: error.stack }); process.exitCode = 1; }
  console.log(JSON.stringify(results.at(-1)));
}
const content = (bytes, page = 1, password) => operateDocument(bytes, { operation: 'page-content', page }, password);
const text = (bytes, password) => operateDocument(bytes, { operation: 'text' }, password);
const remove = (bytes, item, page = 1, password) => operateDocument(bytes, { operation: 'remove-content', page, id: item.id, kind: item.kind, rect: item.rect }, password);
function raster(bytes, index = 0, password) {
  const doc = open(bytes, password), page = doc.loadPage(index), pix = page.toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false, false);
  try { return { width: pix.getWidth(), height: pix.getHeight(), stride: pix.getStride(), components: pix.getNumberOfComponents(), x: pix.getX(), y: pix.getY(), data: new Uint8Array(pix.getPixels()) }; }
  finally { pix.destroy(); page.destroy(); doc.destroy(); }
}
function visibleRect(bytes, rect, index = 0) {
  const doc = open(bytes), page = doc.loadPage(index);
  try { return mupdf.Rect.transform(rect, page.getTransform()); } finally { page.destroy(); doc.destroy(); }
}
function pdfRect(bytes, rect, index = 0) {
  const doc = open(bytes), page = doc.loadPage(index);
  try { return mupdf.Rect.transform(rect, mupdf.Matrix.invert(page.getTransform())); } finally { page.destroy(); doc.destroy(); }
}
function outsideUnchanged(before, after, box) {
  assert.equal(before.width, after.width); assert.equal(before.height, after.height);
  for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) {
    const vx = (x + before.x) / 2, vy = (y + before.y) / 2;
    if (vx >= box[0] - 1 && vx <= box[2] + 1 && vy >= box[1] - 1 && vy <= box[3] + 1) continue;
    const at = y * before.stride + x * before.components;
    for (let c = 0; c < before.components; c++) assert.equal(after.data[at + c], before.data[at + c], `Neighbour pixel changed at ${vx},${vy}.`);
  }
}
function colorAt(image, x, y) {
  const at = (Math.floor(y * 2) - image.y) * image.stride + (Math.floor(x * 2) - image.x) * image.components;
  return Array.from(image.data.slice(at, at + 3));
}
function annotationState(bytes) {
  const doc = open(bytes);
  try {
    const array = doc.findPage(0).get('Annots');
    return Array.from({ length: array.length }, (_, i) => {
      const a = array.get(i);
      return { type: a.get('Subtype').asName(), name: a.get('NM').asString(), rect: a.get('Rect').toString(), contents: a.get('Contents').asString(), uri: a.get('A', 'URI').asString(), quads: a.get('QuadPoints').toString() };
    });
  } finally { doc.destroy(); }
}
function picture(alpha = false) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 10], alpha);
  try { const data = pix.getPixels(); for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) { const color = x < 10 ? [255, 0, 0] : [0, 0, 255]; if (alpha) color.push(x < 10 ? 255 : 0); data.set(color, y * pix.getStride() + x * pix.getNumberOfComponents()); } return new Uint8Array(pix.asPNG()); }
  finally { pix.destroy(); }
}
const png = picture();
async function wordsFixture(lineHeight = 18) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([400, 400]);
  page.drawText('FIRST LINE\nSECOND LINE', { x: 30, y: 300, size: 12, lineHeight, font });
  page.drawText('RIGHT COLUMN', { x: 240, y: 300, size: 12, font });
  page.drawText('KEEP THIRD', { x: 30, y: 230, size: 12, font });
  pdf.setTitle('Ordinary edit keeps metadata'); return pdf.save();
}

await check('delete-one-line-preserves-next-line-and-neighbour-pixels', async () => {
  const source = await wordsFixture(), before = hash(source), item = content(source).items.find(item => item.level === 'line' && item.text === 'FIRST LINE');
  assert(item?.editable); const result = remove(source, item), output = text(result)[0];
  assert(!output.includes('FIRST LINE')); assert(output.includes('SECOND LINE')); assert(output.includes('RIGHT COLUMN')); assert(output.includes('KEEP THIRD'));
  outsideUnchanged(raster(source), raster(result), visibleRect(source, item.rect)); assert.equal(hash(source), before);
  return { selectedTextRemoved: true, sameBlockNextLineRetained: true, neighbourPixelsExact: true, originalUnchanged: true };
});

await check('delete-paragraph-uses-lines-and-retains-background-and-another-column', async () => {
  const pdf = await PDFDocument.load(await wordsFixture()); pdf.getPage(0).drawRectangle({ x: 30, y: 289, width: 120, height: 1, color: rgb(0, 0, 1) });
  const source = await pdf.save(), item = content(source).items.find(item => item.level === 'paragraph' && item.text === 'FIRST LINE\nSECOND LINE'); assert(item?.editable);
  const result = remove(source, item), output = text(result)[0]; assert(!output.includes('FIRST LINE')); assert(!output.includes('SECOND LINE')); assert(output.includes('RIGHT COLUMN')); assert(output.includes('KEEP THIRD'));
  assert.deepEqual(colorAt(raster(result), 50, 110.5), [0, 0, 255]); outsideUnchanged(raster(source), raster(result), visibleRect(source, item.rect));
  return { bothSelectedLinesRemoved: true, interlineGraphicsPreserved: true, adjacentColumnPreserved: true };
});

await check('unsafe-tight-lines-and-foreign-glyphs-are-rejected-with-source-intact', async () => {
  const source = await wordsFixture(8), before = hash(source), line = content(source).items.find(item => item.level === 'line' && item.text === 'FIRST LINE'); assert(line?.editable);
  assert.throws(() => remove(source, line), /demasiado cerca|otros caracteres/); assert.equal(hash(source), before);
  const pdf = await PDFDocument.load(await wordsFixture()); pdf.getPage(0).drawText('OVERLAP', { x: 50, y: 302, size: 12 });
  const overlap = await pdf.save(), candidate = content(overlap).items.find(item => item.level === 'line' && item.text.includes('FIRST'));
  assert(candidate); assert.throws(() => remove(overlap, candidate), /superpuesto|demasiado cerca|otros caracteres/);
  return { tightlySpacedUnselectedLineProtected: true, foreignOverlappingGlyphsProtected: true, failuresDoNotMutateSource: true };
});

await check('ordinary-leading-line-delete-and-replace-keep-adjacent-lines', async () => {
  for (const name of [StandardFonts.Helvetica, StandardFonts.TimesRoman]) for (const lineHeight of [12, 14.4]) {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(name); pdf.addPage([400, 400]).drawText('Linea uno gjpqy\nLinea DOS Áé\nLinea tres gjpqy', { x: 30, y: 300, size: 12, lineHeight, font });
    const source = await pdf.save(), line = content(source).items.find(item => item.level === 'line' && item.text.includes('DOS')); assert(line?.editable, `${name} ${lineHeight}`);
    const removed = text(remove(source, line))[0]; assert(!removed.includes('DOS')); assert(removed.includes('Linea uno gjpqy') && removed.includes('Linea tres gjpqy'), `${name} ${lineHeight}: ${removed}`);
    const replaced = text(operateDocument(source, { operation: 'replace-text', page: 1, rect: line.rect, sourceRect: line.rect, sourceId: line.id, text: 'Nueva', size: 12, color: '#000000', fontName: 'Helvetica', wrap: true, baselineOffset: line.baselineOffset }))[0];
    assert(!replaced.includes('DOS')); assert(replaced.includes('Nueva')); assert(replaced.includes('Linea uno gjpqy') && replaced.includes('Linea tres gjpqy'), `${name} ${lineHeight}: ${replaced}`);
  }
  return { solidAndNormalLeading: true, neighbourLinesRetainedOnDelete: true, neighbourLinesRetainedOnReplace: true };
});

await check('area-replacement-removes-only-glyphs-centred-in-the-area', async () => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([400, 400]);
  page.drawText('Precio total: 1.250 euros', { x: 30, y: 300, size: 14, font }); page.drawText('Linea siguiente cercana', { x: 30, y: 284, size: 14, font });
  const source = await pdf.save(), area = [107, 296, 147, 314];
  assert.equal(operateDocument(source, { operation: 'area-info', page: 1, rect: area }).text.trim(), '1.250');
  const output = text(operateDocument(source, { operation: 'replace-text', page: 1, rect: area, text: '990', size: 14, color: '#000000', fontName: 'Helvetica', wrap: true }))[0];
  assert(!output.includes('1.250')); assert(output.includes('990')); assert(output.includes('Precio total:')); assert(output.includes('euros')); assert(output.includes('Linea siguiente cercana'));
  return { suggestionMatchesRemoval: true, touchedNeighbourLettersKept: true };
});

await check('ordinary-deletion-keeps-notes-highlights-links-widgets-pending-redactions-and-metadata', async () => {
  const pdf = await PDFDocument.load(await wordsFixture()), field = pdf.getForm().createTextField('action-field'); field.setText('KEEP FIELD'); field.addToPage(pdf.getPage(0), { x: 28, y: 287, width: 110, height: 10 });
  let source = writeAnnotations(await pdf.save(), [
    { id: 'action-note', kind: 'note', page: 1, rect: [40, 304, 40, 304], color: '#f5d164', text: 'Keep note', created: 1 },
    { id: 'action-highlight', kind: 'highlight', page: 1, rect: [30, 298, 105, 314], color: '#f5d164', text: 'Keep mark', created: 1 },
  ]);
  const doc = open(source), page = doc.loadPage(0), pending = page.createAnnotation('Redact'); pending.setRect([27, 150, 150, 181]); pending.setName('pending-ordinary-edit'); pending.update();
  doc.findPage(0).get('Annots').push(doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [30, 298, 120, 314], A: { S: 'URI', URI: doc.newString('https://example.org/preserve') } }));
  const free = page.createAnnotation('FreeText'); free.setRect([25, 80, 180, 110]); free.setContents('Keep free annotation'); free.update(); source = save(doc); page.destroy(); doc.destroy();
  const before = hash(source), annotations = annotationState(source), selected = content(source).items.find(item => item.level === 'line' && item.text === 'FIRST LINE'); assert(selected?.editable);
  const result = remove(source, selected); assert.deepEqual(annotationState(result), annotations); assert.equal(operateDocument(result, { operation: 'fields' })[0].value, 'KEEP FIELD');
  assert.equal(inspectDocument(result).annotations.find(note => note.id === 'action-note').text, 'Keep note'); assert(text(result)[0].includes('KEEP THIRD'));
  const saved = open(result); assert.equal(saved.getTrailer().get('Info', 'Title').asString(), 'Ordinary edit keeps metadata'); saved.destroy(); assert.equal(hash(source), before);
  return { notesHighlightsLinksFreeTextWidgetsAndPendingMarksPreserved: true, metadataPreserved: true, fieldValuePreserved: true };
});

await check('shared-image-removal-affects-only-one-instance-and-reveals-original-background', async () => {
  const pdf = await PDFDocument.create(), image = await pdf.embedPng(png), page = pdf.addPage([400, 400]);
  page.drawRectangle({ x: 20, y: 20, width: 110, height: 60, color: rgb(0, 1, 0) }); page.drawImage(image, { x: 25, y: 25, width: 100, height: 50 }); page.drawImage(image, { x: 25, y: 170, width: 100, height: 50 });
  pdf.addPage([400, 400]).drawImage(image, { x: 220, y: 40, width: 100, height: 50 }); const source = await pdf.save(), before = hash(source), images = content(source).items.filter(item => item.kind === 'image'); assert.equal(images.length, 2); assert(images.every(item => item.editable));
  const result = remove(source, images[0]); assert.equal(content(result).items.filter(item => item.kind === 'image').length, 1); assert.deepEqual(raster(result, 1), raster(source, 1));
  const box = visibleRect(source, images[0].rect); assert.deepEqual(colorAt(raster(result), (box[0] + box[2]) / 2, (box[1] + box[3]) / 2), [0, 255, 0]); outsideUnchanged(raster(source), raster(result), box); assert.equal(hash(source), before);
  assert.throws(() => remove(result, images[0]), /selección cambió|ya no existe/); assert.throws(() => remove(result, images[1]), /selección cambió|ya no existe/);
  return { selectedInstanceRemoved: true, sharedResourceOtherInstanceAndPageIntact: true, greenBackgroundRevealed: true, staleIdsRejected: true };
});

await check('tiny-image-overlaps-and-invisible-overlapping-instances-block-deletion', async () => {
  for (const opacity of [0, 1]) {
    const pdf = await PDFDocument.create(), image = await pdf.embedPng(png), page = pdf.addPage([320, 320]); page.drawImage(image, { x: 20, y: 20, width: 100, height: 50 }); page.drawImage(image, { x: opacity ? 119.8 : 40, y: 20, width: 100, height: 50, opacity });
    const source = await pdf.save(), before = hash(source), first = content(source).items.find(item => item.kind === 'image'); assert(first.editable);
    assert.throws(() => remove(source, first), /Otra imagen toca/); assert.equal(hash(source), before);
  }
  return { subHalfPointOverlapRejected: true, invisibleInstanceNotAccidentallyRemoved: true };
});

await check('masked-or-cropped-images-cannot-bypass-the-safe-selection-gate', async () => {
  for (const scenario of ['mask', 'crop']) {
    const pdf = await PDFDocument.create(), page = pdf.addPage([320, 320]), image = await pdf.embedPng(picture(scenario === 'mask')); page.drawImage(image, { x: 20, y: 20, width: 100, height: 50 });
    if (scenario === 'crop') page.setCropBox(50, 0, 250, 320);
    const source = await pdf.save(), before = hash(source), item = content(source).items.find(item => item.kind === 'image'); assert(item && !item.editable); assert.throws(() => remove(source, item), /recortada|máscara/); assert.equal(hash(source), before);
  }
  return { softMasksRejected: true, partialCropRejected: true, originalUnchanged: true };
});

await check('native-crop-and-all-quarter-turns-remove-or-duplicate-the-intended-image', async () => {
  const cases = [];
  for (const rotation of [0, 90, 180, 270]) {
    const pdf = await PDFDocument.create(), image = await pdf.embedPng(png), page = pdf.addPage([485.52, 578.16]); page.setCropBox(2.83466, 65.1969, 479.85034, 510.1281); page.setRotation(degrees(rotation));
    page.drawImage(image, { x: 140, y: 200, width: 100, height: 50, opacity: .4 }); page.drawText('KEEP ROTATED TEXT', { x: 50, y: 470, size: 12 });
    const source = await pdf.save(), before = hash(source), original = content(source).items.find(item => item.kind === 'image'); assert(original?.editable);
    const removed = remove(source, original); assert.equal(content(removed).items.filter(item => item.kind === 'image').length, 0); assert(text(removed)[0].includes('KEEP ROTATED TEXT')); outsideUnchanged(raster(source), raster(removed), visibleRect(source, original.rect));
    const pixels = operateDocument(source, { operation: 'page-image', page: 1, id: original.id }), visible = visibleRect(source, original.rect), destination = pdfRect(source, [visible[0] + 130, visible[1], visible[2] + 130, visible[3]]);
    const copied = operateDocument(source, { operation: 'add-image', page: 1, rect: destination, image: pixels.bytes, opacity: pixels.opacity, rotation: pixels.rotation, fit: 'stretch' });
    assert.equal(content(copied).items.filter(item => item.kind === 'image').length, 2); outsideUnchanged(raster(source), raster(copied), visibleRect(source, destination)); assert.equal(hash(source), before);
    const box = visibleRect(source, destination), sourceBox = visibleRect(source, original.rect); assert.deepEqual(colorAt(raster(copied), box[0] + (box[2] - box[0]) * .25, box[1] + (box[3] - box[1]) * .5), colorAt(raster(source), sourceBox[0] + (sourceBox[2] - sourceBox[0]) * .25, sourceBox[1] + (sourceBox[3] - sourceBox[1]) * .5));
    const line = content(source).items.find(item => item.level === 'line' && item.text === 'KEEP ROTATED TEXT'); if (rotation) assert.throws(() => remove(source, line), /girado|vertical/);
    cases.push({ rotation, copiedRotation: pixels.rotation, originalPixelsPreserved: true });
  }
  return { nonzeroCropBox: true, cases, rotatedTextStillBlocked: true };
});

await check('second-page-extraction-preview-retains-selection-ids-and-geometries', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([300, 300]); const page = pdf.addPage([400, 400]), image = await pdf.embedPng(png); page.drawText('PAGE TWO TEXT', { x: 30, y: 300, size: 12 }); page.drawImage(image, { x: 30, y: 80, width: 100, height: 50 });
  const source = await pdf.save(), extracted = operateDocument(source, { operation: 'pages', plan: [{ page: 2 }] });
  for (const original of content(source, 2).items.filter(item => item.level === 'paragraph' || item.kind === 'image')) {
    const previewItem = content(extracted).items.find(item => item.id === original.id); assert.deepEqual(previewItem, original);
    const preview = remove(extracted, original), full = remove(source, original, 2); assert.deepEqual(raster(preview), raster(full, 1)); assert.deepEqual(text(preview)[0], text(full)[1]); assert.deepEqual(raster(full, 0), raster(source, 0));
  }
  return { extractedPageUsesIdenticalIdsAndPdfCoordinates: true, previewMatchesFullCommitPixels: true, originalFirstPagePreserved: true };
});

await check('text-duplication-adds-an-independent-copy-and-leaves-original-content', async () => {
  const source = await wordsFixture(), before = hash(source), item = content(source).items.find(item => item.level === 'line' && item.text === 'FIRST LINE'), destination = [item.rect[0] + 12, item.rect[1] - 110, item.rect[2] + 22, item.rect[3] - 85];
  const result = operateDocument(source, { operation: 'add-text', page: 1, rect: destination, text: item.text, size: item.size, color: item.color, fontName: item.fontName, wrap: true, baselineOffset: item.baselineOffset });
  assert.equal(text(result)[0].match(/FIRST LINE/g).length, 2); assert(text(result)[0].includes('SECOND LINE')); outsideUnchanged(raster(source), raster(result), visibleRect(source, destination)); assert.equal(hash(source), before);
  return { originalAndCopyBothSearchable: true, originalPixelsExact: true, addHasNoSourceRect: true };
});

await check('bad-selection-copy-edit-signature-and-encryption-guards-do-not-change-source', async () => {
  const source = await wordsFixture(), before = hash(source), item = content(source).items.find(item => item.level === 'line' && item.text === 'FIRST LINE'), operation = { operation: 'remove-content', page: 1, id: item.id, kind: item.kind, rect: item.rect };
  for (const patch of [{ id: 'image-999' }, { id: 'bad-id' }, { id: item.id, kind: 'image' }, { kind: 'unknown' }, { page: 0 }, { page: 2 }, { rect: item.rect.map(n => n + 1) }, { rect: [NaN, 0, 20, 30] }]) assert.throws(() => operateDocument(source, { ...operation, ...patch }));
  for (const permissions of [8, 16]) {
    const secured = operateDocument(source, { operation: 'protect', userPassword: 'reader', ownerPassword: 'owner', permissions }); assert.throws(() => operateDocument(secured, operation, 'reader'), /permisos|extraer/);
  }
  const secured = operateDocument(source, { operation: 'protect', userPassword: 'reader', ownerPassword: 'owner', permissions: 4095 }), securedHash = hash(secured), edited = operateDocument(secured, operation, 'reader');
  const encrypted = new mupdf.PDFDocument(edited); assert(encrypted.needsPassword()); assert.equal(encrypted.authenticatePassword('wrong'), 0); assert(encrypted.authenticatePassword('reader')); encrypted.destroy(); assert(!text(edited, 'reader')[0].includes('FIRST LINE')); assert.equal(hash(secured), securedHash);
  const doc = open(source); doc.getTrailer().get('Root').put('Perms', { DocMDP: doc.addObject({ Type: 'Sig' }) }); const signed = save(doc); doc.destroy(); assert.throws(() => operateDocument(signed, operation), /firmado/); assert.equal(hash(source), before);
  return { idKindAreaAndPageValidated: true, separateCopyAndEditPermissionsEnforced: true, signedPdfReadonly: true, encryptionPreserved: true };
});

await check('legacy-image-removal-preserves-pending-marks-notes-and-unrelated-text', async () => {
  const pdf = await PDFDocument.load(await wordsFixture()), image = await pdf.embedPng(png); pdf.getPage(0).drawImage(image, { x: 30, y: 60, width: 100, height: 50 });
  let source = writeAnnotations(await pdf.save(), [{ id: 'legacy-image-note', kind: 'note', page: 1, rect: [35, 100, 35, 100], color: '#f5d164', text: 'Keep legacy note', created: 1 }]);
  const doc = open(source), page = doc.loadPage(0), pending = page.createAnnotation('Redact'); pending.setRect([25, 90, 155, 110]); pending.setName('pending-first-line'); pending.update(); source = save(doc); page.destroy(); doc.destroy();
  const before = annotationState(source), originalText = text(source), result = operateDocument(source, { operation: 'remove-image', page: 1, rect: [30, 60, 130, 110] });
  assert.equal(content(result).items.filter(item => item.kind === 'image').length, 0); assert.deepEqual(annotationState(result), before); assert.deepEqual(text(result), originalText);
  return { pendingRedactionNotExecuted: true, commentsPreserved: true, legacyPixelRemovalStillWorks: true };
});

await check('client-remove-preview-cancels-with-source-owned-by-caller', async () => {
  const bytes = await wordsFixture(), before = hash(bytes), item = content(bytes).items.find(item => item.level === 'line' && item.text === 'FIRST LINE'), operation = { operation: 'remove-content', page: 1, id: item.id, kind: item.kind, rect: item.rect };
  const file = path.resolve('src/engine/client.ts'), code = ts.transpileModule(fs.readFileSync(file, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href)), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const previousWorker = globalThis.Worker, workers = []; class ControlledWorker { constructor() { workers.push(this); } postMessage(message) { this.message = message; assert.notEqual(message.bytes.buffer, bytes.buffer); } terminate() { this.terminated = true; } }
  globalThis.Worker = ControlledWorker;
  try {
    const client = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')), prior = new AbortController(); prior.abort(); await assert.rejects(client.processPdf(bytes, operation, undefined, prior.signal), error => error.name === 'AbortError'); assert.equal(workers.length, 0);
    const controller = new AbortController(), pending = client.processPdf(bytes, operation, undefined, controller.signal), active = workers.at(-1); controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
    assert(active.terminated); assert.equal(workers.length, 2); assert(!workers[1].terminated, 'A warm replacement waits for the next preview.');
    const ready = client.processPdf(bytes, operation), worker = workers.at(-1); assert.equal(workers.length, 2); worker.onmessage({ data: { result: operateDocument(worker.message.bytes, worker.message.options) } }); assert(!text(await ready)[0].includes('FIRST LINE')); assert(!worker.terminated); assert.equal(hash(bytes), before);
    const failed = client.processPdf(bytes, operation); assert.equal(workers.length, 2, 'A finished worker is reused.'); worker.onmessage({ data: { error: 'Error del motor.' } }); await assert.rejects(failed, /Error del motor/); assert(!worker.terminated);
    const trapped = client.processPdf(bytes, operation); worker.onmessage({ data: { error: 'Aborted()', fatal: true } }); await assert.rejects(trapped, /Aborted/); assert(worker.terminated, 'A worker whose engine trapped is discarded.');
    return { preAbortNoWorker: true, activePreviewTerminated: true, warmWorkerReused: true, trappedWorkerDiscarded: true, originalBufferNotTransferred: true, realBackendResultReturned: true };
  } finally { globalThis.Worker = previousWorker; }
});

fs.writeFileSync('test-results/content-actions-engine-results.json', JSON.stringify({ engine: 'MuPDF.js 1.28.1 selected regions, real PDF text and rendered pixels', results }, null, 2));
