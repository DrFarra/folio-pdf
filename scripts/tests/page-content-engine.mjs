import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import ts from 'typescript';
import { operateDocument } from '../../src/engine/operations.mjs';
import { inspectDocument, writeAnnotations } from '../../src/engine/mupdf-engine.mjs';

const results = [], output = path.resolve('test-results'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(output, { recursive: true });
async function check(id, run) {
  try { results.push({ id, status: 'passed', ...await run() }); }
  catch (error) { results.push({ id, status: 'failed', error: error.stack }); process.exitCode = 1; }
  console.log(JSON.stringify(results.at(-1)));
}
const content = (bytes, page = 1, password) => operateDocument(bytes, { operation: 'page-content', page }, password);
const pageImage = (bytes, page, id, password) => operateDocument(bytes, { operation: 'page-image', page, id }, password);
function saveDoc(doc) { const buffer = doc.saveToBuffer('garbage=4,compress=yes'); try { return new Uint8Array(buffer.asUint8Array()); } finally { buffer.destroy(); } }
function append(doc, index, drawing) {
  const object = doc.findPage(index), before = object.get('Contents'), contents = doc.newArray();
  if (before.isArray()) for (let i = 0; i < before.length; i++) contents.push(before.get(i)); else if (!before.isNull()) contents.push(before);
  contents.push(doc.addStream(drawing, {})); object.put('Contents', contents);
}
function picture(alpha = false) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 10], alpha), data = pix.getPixels(), components = pix.getNumberOfComponents();
  try {
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) {
      const color = x < 10 ? [255, 0, 0] : [0, 0, 255];
      if (alpha) color.push(x < 10 ? 255 : 0);
      data.set(color, y * pix.getStride() + x * components);
    }
    return new Uint8Array(pix.asPNG());
  } finally { pix.destroy(); }
}
const png = picture();
function pixels(bytes, index = 0) {
  const doc = new mupdf.PDFDocument(bytes), page = doc.loadPage(index), pix = page.toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
  try { return new Uint8Array(pix.getPixels()); } finally { pix.destroy(); page.destroy(); doc.destroy(); }
}
function origins(bytes) {
  const doc = new mupdf.PDFDocument(bytes), page = doc.loadPage(0), structured = page.toStructuredText(), rows = []; let row;
  try {
    structured.walk({ beginLine: () => { row = { text: '' }; rows.push(row); }, onChar: (c, origin, font) => { try { row.text += c; row.origin ??= origin; } finally { font.destroy(); } } }); return rows;
  } finally { structured.destroy(); page.destroy(); doc.destroy(); }
}
async function textFixture(rotation = 0) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([485.52, 578.16]); page.setCropBox(2.83466, 65.1969, 479.85034, 510.1281); page.setRotation(degrees(rotation));
  page.drawText('FIRST line\nSECOND line', { x: 60, y: 470, size: 12, font, lineHeight: 18, color: rgb(.2, .3, .4) });
  page.drawText('RIGHT column', { x: 250, y: 470, size: 12, font });
  page.drawText('Regular ', { x: 60, y: 340, size: 12, font }); page.drawText('BOLD', { x: 106, y: 340, size: 12, font: bold, color: rgb(1, 0, 0) });
  return doc.save();
}

await check('lines-paragraphs-styles-and-baselines-are-real-regions', async () => {
  const source = await textFixture(), before = hash(source), info = content(source), again = content(source);
  assert.deepEqual(info, again);
  const paragraph = info.items.find(item => item.level === 'paragraph' && item.text === 'FIRST line\nSECOND line');
  assert(paragraph?.editable); assert.equal(paragraph.size, 12); assert.equal(paragraph.color, '#334d66'); assert.equal(paragraph.fontName, 'Helvetica');
  assert(Math.abs(paragraph.lineHeight - 1.5) < .001); assert(paragraph.baselineOffset > 12 && paragraph.baselineOffset < 14);
  assert(info.items.some(item => item.level === 'line' && item.text === 'FIRST line'));
  assert(info.items.some(item => item.level === 'paragraph' && item.text === 'RIGHT column'));
  assert(info.items.some(item => item.text.includes('BOLD') && item.mixedStyle));
  assert(info.items.every(item => !('bytes' in item)));
  const edited = operateDocument(source, { operation: 'replace-text', page: 1, rect: paragraph.rect, sourceRect: paragraph.rect, text: paragraph.text, size: 12, color: paragraph.color, fontName: 'Helvetica', wrap: true, baselineOffset: paragraph.baselineOffset, lineHeight: paragraph.lineHeight });
  const oldRows = origins(source), newRows = origins(edited);
  for (const label of ['FIRST line', 'SECOND line']) {
    const old = oldRows.find(row => row.text === label), next = newRows.find(row => row.text === label);
    assert(next); assert(Math.abs(old.origin[0] - next.origin[0]) < .01); assert(Math.abs(old.origin[1] - next.origin[1]) < .01);
  }
  assert.equal(hash(source), before);
  for (const baselineOffset of [-1, NaN, 3000]) assert.throws(() => operateDocument(source, { operation: 'add-text', page: 1, rect: [40, 100, 300, 200], text: 'Valid', size: 12, color: '#000000', baselineOffset }), /línea de base/);
  return { levels: ['line', 'paragraph'], columnsSeparate: true, mixedStylesDetected: true, lineHeight: paragraph.lineHeight, replacementBaselinesPreserved: true, sourceUnchanged: true };
});

await check('native-quarter-rotations-and-crop-box-return-original-pdf-coordinates', async () => {
  const boxes = [];
  for (const rotation of [0, 90, 180, 270]) {
    const source = await textFixture(rotation), before = hash(source), line = content(source).items.find(item => item.level === 'line' && item.text === 'FIRST line');
    assert(line); assert.equal(line.rotated, rotation !== 0); assert.equal(line.editable, rotation === 0); assert.equal(!!line.areaReplaceable, rotation !== 0, 'Rotated text offers area replacement.');
    assert(Math.abs(line.rect[0] - 60) < .01); boxes.push(line.rect);
    line.rect.forEach((value, i) => assert(Math.abs(value - boxes[0][i]) < .01)); assert.equal(hash(source), before);
  }
  return { rotations: [0, 90, 180, 270], nonzeroCropBox: true, sourceRectInvariant: true, unsupportedTextRotationExplained: true };
});

await check('non-bmp-to-unicode-text-is-not-truncated-by-the-installed-walker', () => {
  const doc = new mupdf.PDFDocument();
  const cmap = doc.addStream('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Unicode def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n1 beginbfchar\n<41> <D83DDE00>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend end\n', {});
  const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding', ToUnicode: cmap });
  doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, { Font: { F0: font } }, 'BT /F0 16 Tf 1 0 0 1 20 60 Tm (A) Tj ET\n'));
  const bytes = saveDoc(doc); doc.destroy(); const info = content(bytes);
  assert.equal(info.items.find(item => item.level === 'line').text, '😀'); assert.equal(info.items.find(item => item.level === 'paragraph').text, '😀');
  assert(operateDocument(bytes, { operation: 'text' })[0].includes('😀'));
  return { nonBmpCodepointPreserved: true, fullPrecisionWalkerGeometry: true };
});

await check('ocr-is-readonly-and-widget-comment-text-is-not-content', async () => {
  const source = await textFixture(), pdf = await PDFDocument.load(source), font = await pdf.embedFont(StandardFonts.Helvetica), field = pdf.getForm().createTextField('content-widget');
  field.setText('WIDGET SHOULD NOT EDIT'); field.addToPage(pdf.getPage(0), { x: 60, y: 200, width: 260, height: 20 }); pdf.getForm().updateFieldAppearances(font);
  const annotated = writeAnnotations(await pdf.save(), [{ id: 'content-note', page: 1, kind: 'note', rect: [440, 440, 440, 440], color: '#f5d164', text: 'COMMENT SHOULD NOT EDIT', created: 1 }]);
  const doc = new mupdf.PDFDocument(annotated), fonts = doc.findPage(0).get('Resources', 'Font'); let name;
  fonts.forEach((_value, key) => { name ??= key; });
  append(doc, 0, `BT /${name} 12 Tf 3 Tr 1 0 0 1 60 130 Tm (HIDDEN OCR) Tj ET\n`);
  const bytes = saveDoc(doc); doc.destroy(); const before = hash(bytes), info = content(bytes);
  const hidden = info.items.filter(item => item.text === 'HIDDEN OCR'); assert.equal(hidden.length, 2); assert(hidden.every(item => !item.editable && /OCR invisible/.test(item.reason) && !item.areaReplaceable));
  assert(!info.items.some(item => /SHOULD NOT EDIT/.test(item.text || '')));
  assert(content(bytes).items.some(item => item.text === 'FIRST line' && item.editable));
  assert.equal(operateDocument(bytes, { operation: 'fields' })[0].value, 'WIDGET SHOULD NOT EDIT'); assert.equal(inspectDocument(bytes).annotations.length, 1); assert.equal(hash(bytes), before);
  return { invisibleOcrExplained: true, visibleTextStillEditable: true, fieldsAndCommentsExcluded: true, originalIntact: true };
});

await check('reuse-original-image-keeps-quarter-turn-opacity-frame-and-annotations', async () => {
  const cases = [];
  for (const pageRotation of [0, 90, 180, 270]) for (const imageRotation of [0, 90, 180, 270]) {
    const pdf = await PDFDocument.create(), embedded = await pdf.embedPng(png), page = pdf.addPage([485.52, 578.16]);
    page.setCropBox(2.83466, 65.1969, 479.85034, 510.1281); page.setRotation(degrees(pageRotation));
    page.drawImage(embedded, { x: 160, y: 200, width: 120, height: 60, rotate: degrees(imageRotation), opacity: .4 });
    const source = writeAnnotations(await pdf.save(), [{ id: 'image-note', page: 1, kind: 'note', rect: [440, 500, 440, 500], color: '#f5d164', text: 'Keep image comment', created: 1 }]), before = hash(source);
    const info = content(source), image = info.items.find(item => item.kind === 'image'); assert(image?.editable, JSON.stringify(info));
    const original = pageImage(source, 1, image.id); assert(original.bytes instanceof Uint8Array); assert.equal(original.width, 20); assert.equal(original.height, 10); assert(Math.abs(original.opacity - .4) < .000001); assert([0, 90, 180, 270].includes(original.rotation));
    const edited = operateDocument(source, { operation: 'replace-image', page: 1, rect: image.rect, sourceRect: image.rect, image: original.bytes, fit: 'stretch', opacity: original.opacity, rotation: original.rotation });
    const oldPixels = pixels(source), newPixels = pixels(edited); assert.equal(oldPixels.length, newPixels.length);
    let maxDifference = 0; oldPixels.forEach((value, i) => { maxDifference = Math.max(maxDifference, Math.abs(value - newPixels[i])); });
    assert(maxDifference <= 1, `${pageRotation}/${imageRotation}: preview changed original image pixels by ${maxDifference}.`);
    assert.deepEqual(inspectDocument(edited).annotations.map(note => [note.id, note.text, note.rect]), inspectDocument(source).annotations.map(note => [note.id, note.text, note.rect])); assert.equal(hash(source), before);
    cases.push({ pageRotation, imageRotation, detectedRotation: original.rotation, maxPixelDifference: maxDifference });
  }
  return { cases, faintImageDetected: true, pngIntrinsicPixels: true, originalOpacityPreserved: true, annotationsAndSourcePreserved: true };
});

await check('repeated-image-instances-ids-are-page-scoped-and-neighbor-is-preserved', async () => {
  const pdf = await PDFDocument.create(), embedded = await pdf.embedPng(png), page = pdf.addPage([320, 320]);
  page.drawImage(embedded, { x: 20, y: 20, width: 100, height: 50 }); page.drawImage(embedded, { x: 20, y: 170, width: 100, height: 50 });
  const second = pdf.addPage([320, 320]); second.drawImage(embedded, { x: 200, y: 50, width: 60, height: 100 }); const source = await pdf.save(), before = hash(source);
  const images = content(source).items.filter(item => item.kind === 'image'); assert.equal(images.length, 2); assert(images.every(item => item.editable)); assert.notEqual(images[0].id, images[1].id);
  assert.deepEqual(images, content(source).items.filter(item => item.kind === 'image'));
  const original = pageImage(source, 1, images[0].id), destination = [170, 20, 270, 70];
  const moved = operateDocument(source, { operation: 'replace-image', page: 1, rect: destination, sourceRect: images[0].rect, image: original.bytes, fit: 'stretch', opacity: original.opacity, rotation: original.rotation });
  assert.deepEqual(pixels(moved, 1), pixels(source, 1));
  const doc = new mupdf.PDFDocument(moved), p = doc.loadPage(0), pix = p.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  try { const data = pix.getPixels(), at = (320 - 195) * pix.getStride() + 40 * pix.getNumberOfComponents(); assert.deepEqual(Array.from(data.slice(at, at + 3)), [255, 0, 0]); }
  finally { pix.destroy(); p.destroy(); doc.destroy(); }
  assert.throws(() => pageImage(source, 2, images[1].id), /no existe/); assert.throws(() => pageImage(source, 3, images[0].id), /página inválido/); assert.throws(() => pageImage(source, 1, 'text-line-b0-l0'), /no es válida/); assert.throws(() => operateDocument(source, { operation: 'page-image', page: 1 }), /no es válida/); assert.equal(hash(source), before);
  return { repeatedXObjectSeparateInstances: true, stableIds: true, pageScopeAndInvalidIdsChecked: true, neighborInstanceAndOtherPagePreserved: true };
});

await check('ambiguous-images-clipping-masks-skew-and-reflection-are-explained-and-blocked', async () => {
  const cases = [];
  for (const scenario of ['overlap', 'clip', 'mask', 'skew', 'reflection']) {
    const pdf = await PDFDocument.create(), image = await pdf.embedPng(scenario === 'mask' ? picture(true) : png), page = pdf.addPage([320, 320]);
    page.drawImage(image, { x: scenario === 'reflection' ? 200 : 80, y: 150, width: scenario === 'reflection' ? -120 : 120, height: 60, ...(scenario === 'skew' ? { rotate: degrees(30) } : {}) });
    if (scenario === 'overlap') page.drawImage(image, { x: 100, y: 170, width: 120, height: 60 });
    let source = await pdf.save();
    if (scenario === 'clip') {
      const doc = new mupdf.PDFDocument(source), object = doc.findPage(0), contents = object.get('Contents'), list = doc.newArray();
      list.push(doc.addStream('q 80 150 60 60 re W n\n', {})); for (let i = 0; i < contents.length; i++) list.push(contents.get(i)); list.push(doc.addStream('Q\n', {})); object.put('Contents', list); source = saveDoc(doc); doc.destroy();
    }
    const info = content(source), found = info.items.filter(item => item.kind === 'image'); assert(found.length);
    // A PNG's own alpha is transparency: editable in place, but not exported for the touch editor.
    if (scenario === 'mask') { assert(found.every(item => item.editable && item.transparent)); found.forEach(item => assert.throws(() => pageImage(source, 1, item.id), /transparencia/)); cases.push(scenario); continue; }
    assert(found.every(item => !item.editable && item.reason));
    found.forEach(item => assert.throws(() => pageImage(source, 1, item.id), new RegExp(item.reason.split(':')[0]))); assert(info.warnings.length); cases.push(scenario);
  }
  return { cases, originalImageExtractionCannotBypassReadOnlyState: true };
});

await check('copy-edit-signature-permissions-and-original-bytes-remain-enforced', async () => {
  const source = await textFixture(), before = hash(source);
  const noCopy = operateDocument(source, { operation: 'protect', userPassword: 'reader', ownerPassword: 'owner', permissions: 4 });
  assert.throws(() => content(noCopy, 1, 'reader'), /no permite extraer/); assert.throws(() => pageImage(noCopy, 1, 'image-0', 'reader'), /no permite extraer/);
  const noEdit = operateDocument(source, { operation: 'protect', userPassword: 'reader', ownerPassword: 'owner', permissions: 16 }), restricted = content(noEdit, 1, 'reader'); assert(restricted.items.length); assert(restricted.items.every(item => !item.editable));
  const doc = new mupdf.PDFDocument(source); doc.getTrailer().get('Root').put('AcroForm', doc.addObject({ Fields: [doc.addObject({ FT: 'Sig', T: doc.newString('Signature guard fixture'), V: {} })] }));
  const signed = saveDoc(doc); doc.destroy(); const signedInfo = content(signed); assert(signedInfo.items.every(item => !item.editable && /firmado/.test(item.reason) && !item.areaReplaceable));
  for (const page of [0, NaN, 3, 1.5]) assert.throws(() => content(source, page), /página inválido/); assert.equal(hash(source), before);
  return { copyPermission: true, editPermission: true, existingSignatureGuard: true, sourceUnchanged: true };
});

await check('image-raster-limit-is-checked-before-decoding', () => {
  const doc = new mupdf.PDFDocument(), w = 4001, h = 4000, compressed = new Uint8Array(deflateSync(Buffer.alloc(w * h * 3, 120)));
  const image = doc.addRawStream(compressed, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' });
  doc.insertPage(-1, doc.addPage([0, 0, 320, 320], 0, { XObject: { Huge: image } }, 'q 100 0 0 100 20 20 cm /Huge Do Q\n'));
  const source = saveDoc(doc); doc.destroy(); const item = content(source).items.find(item => item.kind === 'image'); assert(item && !item.editable && /16 megapíxeles/.test(item.reason)); assert.throws(() => pageImage(source, 1, item.id), /16 megapíxeles/);
  return { declaredPixels: w * h, limit: 16000000, imageRejectedBeforeRasterization: true };
});

await check('too-many-elements-fails-cleanly-and-later-saves-still-work', async () => {
  // Heavy vector art inside nested transparency groups, as in layered CAD and map exports.
  const doc = new mupdf.PDFDocument(); let rects = '';
  for (let i = 0; i < 20500; i++) rects += `${(i % 200) * 2} ${Math.floor(i / 200) * 2} 1 1 re f\n`;
  let form = doc.addStream(rects, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792] });
  for (let depth = 0; depth < 6; depth++) form = doc.addStream('q 0 0 612 792 re W n /X Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Resources: { XObject: { X: form } }, Group: { S: 'Transparency' } });
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { X: form } }, 'q /X Do Q')); const heavy = saveDoc(doc); doc.destroy();
  const light = await textFixture(), note = [{ id: 'after-heavy', page: 1, kind: 'note', rect: [100, 100, 100, 100], color: '#ffcc00', text: 'Nota', created: 1 }];
  const saved = writeAnnotations(heavy, note).length, edited = operateDocument(light, { operation: 'add-text', page: 1, rect: [60, 60, 300, 120], text: 'Añadido', size: 12 }).length;
  // The device callbacks run inside MuPDF; an exception thrown through them used to corrupt its heap.
  for (let i = 0; i < 10; i++) assert.throws(() => content(heavy), /demasiados elementos/);
  assert.equal(writeAnnotations(heavy, note).length, saved); assert.equal(operateDocument(light, { operation: 'add-text', page: 1, rect: [60, 60, 300, 120], text: 'Añadido', size: 12 }).length, edited);
  assert(content(light).items.some(item => item.text === 'FIRST line'));
  return { failures: 10, saveAfterFailures: true, editAfterFailures: true };
});

await check('page-content-and-image-client-copy-and-cancellation', async () => {
  const pdf = await PDFDocument.create(), image = await pdf.embedPng(png); pdf.addPage([320, 320]).drawImage(image, { x: 20, y: 20, width: 100, height: 50 }); const bytes = await pdf.save(), before = hash(bytes);
  const file = path.resolve('src/engine/client.ts'), source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href)), code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const priorWorker = globalThis.Worker, workers = [];
  class FakeWorker { constructor() { workers.push(this); } postMessage(message) { this.message = message; assert.notEqual(message.bytes.buffer, bytes.buffer); } terminate() { this.terminated = true; } }
  globalThis.Worker = FakeWorker;
  try {
    const client = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')), aborted = new AbortController(); aborted.abort();
    await assert.rejects(client.getPageContent(bytes, 1, '', aborted.signal), error => error.name === 'AbortError'); await assert.rejects(client.readPageImage(bytes, 1, 'image-0', '', aborted.signal), error => error.name === 'AbortError'); assert.equal(workers.length, 0);
    const pending = client.getPageContent(bytes, 1), worker = workers.at(-1); worker.onmessage({ data: { result: operateDocument(worker.message.bytes, worker.message.options) } }); const result = await pending; assert(result.items[0].editable); assert(!worker.terminated);
    const extracting = client.readPageImage(bytes, 1, result.items[0].id), imageWorker = workers.at(-1); assert.equal(imageWorker, worker, 'The idle engine worker is reused.'); imageWorker.onmessage({ data: { result: operateDocument(imageWorker.message.bytes, imageWorker.message.options) } }); assert((await extracting).bytes instanceof Uint8Array); assert(!imageWorker.terminated);
    const cancel = new AbortController(), cancelled = client.readPageImage(bytes, 1, 'image-0', undefined, cancel.signal); cancel.abort(); await assert.rejects(cancelled, error => error.name === 'AbortError'); assert(worker.terminated); assert.equal(hash(bytes), before);
    return { typedContentAndSinglePng: true, sourceCopy: true, preAbortNoWorkers: true, idleWorkerReused: true, activeImageReadCancelled: true };
  } finally { globalThis.Worker = priorWorker; }
});

fs.writeFileSync(path.join(output, 'page-content-engine-results.json'), JSON.stringify({ engine: 'MuPDF.js 1.28.1 real PDF regions, image bytes and rendered pixels', results }, null, 2));
