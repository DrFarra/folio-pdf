import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import ts from 'typescript';
import { operateDocument } from '../../src/engine/operations.mjs';
import { inspectDocument, writeAnnotations } from '../../src/engine/mupdf-engine.mjs';

const output = path.resolve('test-results'); fs.mkdirSync(output, { recursive: true });
const results = [], hash = value => createHash('sha256').update(value).digest('hex');
async function check(id, run) {
  try { results.push({ id, status: 'passed', ...await run() }); }
  catch (error) { results.push({ id, status: 'failed', error: error.stack }); process.exitCode = 1; }
  console.log(JSON.stringify(results.at(-1)));
}
const createBlank = async () => { const doc = await PDFDocument.create(); doc.addPage([320, 320]); return doc.save(); };
const blank = await createBlank();
const text = bytes => operateDocument(bytes, { operation: 'text' })[0];
const save = (name, bytes) => fs.writeFileSync(path.join(output, `content-editor-${name}.pdf`), bytes);
function lines(bytes) {
  const doc = new mupdf.PDFDocument(bytes), page = doc.loadPage(0), rows = []; let structured;
  try {
    structured = page.toStructuredText();
    structured.walk({ beginLine: bounds => rows.push({ bounds, text: '' }), onChar: (character, _origin, font) => { try { rows.at(-1).text += character; } finally { font.destroy(); } } });
    return rows;
  } finally { structured?.destroy(); page.destroy(); doc.destroy(); }
}
function imageBytes(solid) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 120, 60], false);
  try {
    const pixels = pixmap.getPixels();
    for (let y = 0; y < 60; y++) for (let x = 0; x < 120; x++) {
      const color = solid || (x < 60 ? [255, 0, 0] : [0, 0, 255]);
      pixels.set(color, y * pixmap.getStride() + x * 3);
    }
    return new Uint8Array(pixmap.asPNG());
  } finally { pixmap.destroy(); }
}
const picture = imageBytes(), green = imageBytes([0, 255, 0]);
function raster(bytes) {
  const doc = new mupdf.PDFDocument(bytes), page = doc.loadPage(0), scale = 2;
  let pixmap;
  try {
    pixmap = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
    const data = new Uint8Array(pixmap.getPixels()), stride = pixmap.getStride(), components = pixmap.getNumberOfComponents();
    const ox = pixmap.getX(), oy = pixmap.getY(), transform = page.getTransform();
    return (x, y) => {
      const px = Math.floor((x * transform[0] + y * transform[2] + transform[4]) * scale - ox);
      const py = Math.floor((x * transform[1] + y * transform[3] + transform[5]) * scale - oy);
      return Array.from(data.slice(py * stride + px * components, py * stride + px * components + 3));
    };
  } finally { pixmap?.destroy(); page.destroy(); doc.destroy(); }
}
const near = (actual, expected, tolerance = 3) => actual.forEach((number, index) => assert(Math.abs(number - expected[index]) <= tolerance, `${actual} != ${expected}`));

await check('text-wrap-alignment-line-spacing-and-font-are-real-pdf-content', () => {
  const before = hash(blank), base = { operation: 'add-text', page: 1, rect: [50, 90, 220, 260], text: 'Alpha beta gamma delta epsilon zeta eta theta', size: 18, color: '#204060', fontName: 'Helvetica-Bold', wrap: true };
  const left = lines(operateDocument(blank, { ...base, align: 'left', lineHeight: 1 }));
  const centeredBytes = operateDocument(blank, { ...base, align: 'center', lineHeight: 2 }), centered = lines(centeredBytes);
  const right = lines(operateDocument(blank, { ...base, align: 'right', lineHeight: 1 }));
  assert(left.length >= 3); assert.equal(centered.length, left.length); assert.equal(right.length, left.length);
  left.forEach((line, index) => {
    assert(Math.abs(line.bounds[0] - 50) < 1);
    assert(Math.abs((centered[index].bounds[0] + centered[index].bounds[2]) / 2 - 135) < 1);
    assert(Math.abs(right[index].bounds[2] - 220) < 1);
    assert.equal(line.text, centered[index].text); assert.equal(line.text, right[index].text);
  });
  near([left[1].bounds[1] - left[0].bounds[1]], [18], .05);
  near([centered[1].bounds[1] - centered[0].bounds[1]], [36], .05);
  const info = operateDocument(centeredBytes, { operation: 'area-info', page: 1, rect: base.rect });
  assert(/Bold$/.test(info.fontName)); assert.equal(info.color, '#204060'); assert.equal(info.size, 18);
  assert.equal(hash(blank), before); save('wrapped-center', centeredBytes);
  return { lines: left.length, actualAlignment: true, actualLineSpacing: [18, 36], font: info.fontName, sourceUnchanged: true };
});

await check('long-word-wrap-explicit-newlines-and-legacy-defaults', () => {
  const options = { operation: 'add-text', page: 1, rect: [40, 60, 280, 280], text: 'Legacy line\nSecond line', size: 16, color: '#000000' };
  const old = operateDocument(blank, options), explicit = operateDocument(blank, { ...options, align: 'left', lineHeight: 1.25, wrap: false, fontName: 'Helvetica' });
  assert.deepEqual(lines(old), lines(explicit));
  const word = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', narrow = operateDocument(blank, { ...options, rect: [40, 40, 85, 290], text: word + '\n\nTail', wrap: true, size: 12 });
  const rows = lines(narrow); assert(rows.length >= 5); assert.equal(rows.map(row => row.text).join('').replaceAll(' ', ''), word + 'Tail');
  assert(rows.every(row => row.bounds[0] >= 39.5 && row.bounds[2] <= 85.6));
  assert.throws(() => operateDocument(blank, { ...options, rect: [40, 60, 80, 90], text: word }), /no cabe/);
  const shortBox = { ...options, rect: [40, 60, 100, 72], text: 'gyp', size: 12 };
  assert.throws(() => operateDocument(blank, { ...shortBox, wrap: true }), /no cabe/);
  assert(text(operateDocument(blank, shortBox)).includes('gyp'), 'Legacy baseline fitting remains available.');
  return { legacyGeometryIdentical: true, longWordWrapped: true, explicitNewlinesSupported: true };
});

await check('bundled-font-bytes-are-used-with-real-font-metadata', () => {
  const names = [];
  for (const style of ['regular', 'semibold']) {
    const font = new Uint8Array(fs.readFileSync(path.resolve(`public/fonts/dm-sans-${style}.ttf`)));
    const bytes = operateDocument(blank, { operation: 'add-text', page: 1, rect: [40, 100, 280, 250], text: 'Texto Español: mañana', size: 18, color: '#111111', font, wrap: true });
    const info = operateDocument(bytes, { operation: 'area-info', page: 1, rect: [40, 100, 280, 250] });
    assert(info.text.includes('Español')); assert(info.text.includes('mañana')); assert(/DMSans/i.test(info.fontName)); names.push(info.fontName);
  }
  assert.notEqual(names[0], names[1]); return { actualFontNames: names, unicode: true };
});

await check('image-fit-opacity-and-quarter-rotation-preserve-pixel-geometry', () => {
  const options = { operation: 'add-image', page: 1, rect: [100, 100, 220, 220], image: picture };
  const contain = raster(operateDocument(blank, { ...options, fit: 'contain' }));
  near(contain(110, 150), [255, 0, 0]); near(contain(210, 150), [0, 0, 255]); near(contain(110, 210), [255, 255, 255]);
  const coverBytes = operateDocument(blank, { ...options, fit: 'cover' }), cover = raster(coverBytes);
  near(cover(110, 210), [255, 0, 0]); near(cover(210, 110), [0, 0, 255]); near(cover(90, 150), [255, 255, 255]); near(cover(230, 150), [255, 255, 255]);
  const alpha = raster(operateDocument(blank, { ...options, fit: 'contain', opacity: .5 })); near(alpha(110, 150), [255, 128, 128]);
  for (const rotation of [90, 270]) {
    const rotated = raster(operateDocument(blank, { ...options, fit: 'contain', rotation }));
    near(rotated(110, 150), [255, 255, 255]);
    near(rotated(160, 210), rotation === 90 ? [255, 0, 0] : [0, 0, 255]);
    near(rotated(160, 110), rotation === 90 ? [0, 0, 255] : [255, 0, 0]);
  }
  const backwards = operateDocument(blank, options), stretch = operateDocument(blank, { ...options, fit: 'stretch', opacity: 1, rotation: 0 });
  near(raster(backwards)(110, 210), raster(stretch)(110, 210));
  const halfTurn = raster(operateDocument(blank, { ...options, fit: 'contain', rotation: 180 })); near(halfTurn(110, 150), [0, 0, 255]);
  save('image-cover', coverBytes);
  return { contain: true, coverClipped: true, alpha: .5, rotations: [0, 90, 180, 270], oldStretchPreserved: true };
});

const fixture = await PDFDocument.create(), regular = await fixture.embedFont(StandardFonts.Helvetica), bold = await fixture.embedFont(StandardFonts.HelveticaBold);
const fixturePage = fixture.addPage([320, 320]);
fixturePage.drawText('ORIGINAL SECRET', { x: 20, y: 240, size: 12, font: regular, color: rgb(0, 0, 0) });
fixturePage.drawText('KEEP NEIGHBOR', { x: 20, y: 190, size: 12, font: regular });
fixturePage.drawText('DESTINATION SAFE', { x: 180, y: 150, size: 10, font: regular });
fixturePage.drawText('Large', { x: 20, y: 280, size: 18, font: bold, color: rgb(1, 0, 0) });
fixturePage.drawText('small', { x: 90, y: 280, size: 10, font: regular });
const field = fixture.getForm().createTextField('editor-preserved-field'); field.setText('FIELD VALUE'); field.addToPage(fixturePage, { x: 80, y: 226, width: 75, height: 12 });
fixture.setTitle('Metadata remains during editing');
let original = writeAnnotations(await fixture.save(), [
  { id: 'editor-note', kind: 'note', page: 1, rect: [35, 244, 35, 244], color: '#f5d164', text: 'Keep comment', created: 1 },
  { id: 'editor-highlight', kind: 'highlight', page: 1, rect: [20, 238, 130, 253], color: '#f5d164', text: 'Keep highlight', created: 1 },
]);
{
  const doc = new mupdf.PDFDocument(original), page = doc.loadPage(0);
  const mark = page.createAnnotation('Redact'); mark.setRect([20, 115, 145, 135]); mark.setName('PendingRedaction'); mark.update();
  doc.findPage(0).get('Annots').push(doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [20, 238, 130, 253], A: { S: 'URI', URI: doc.newString('https://example.org/keep') } }));
  const buffer = doc.saveToBuffer('garbage=4,compress=yes'); original = new Uint8Array(buffer.asUint8Array()); buffer.destroy(); page.destroy(); doc.destroy();
}
function annotationTypes(bytes) {
  const doc = new mupdf.PDFDocument(bytes);
  try { const annots = doc.findPage(0).get('Annots'); return Array.from({ length: annots.length }, (_, index) => annots.get(index).get('Subtype').asName()).sort(); }
  finally { doc.destroy(); }
}

await check('text-replacement-source-and-destination-are-independent-and-annotations-survive', () => {
  const before = hash(original), sourceRect = [15, 224, 158, 258];
  const bytes = operateDocument(original, { operation: 'replace-text', page: 1, sourceRect, rect: [175, 30, 305, 105], text: 'NEW TEXT', size: 16, color: '#000000', align: 'center', wrap: true });
  assert(!text(bytes).includes('ORIGINAL SECRET')); assert(text(bytes).includes('NEW TEXT')); assert(text(bytes).includes('KEEP NEIGHBOR')); assert(text(bytes).includes('DESTINATION SAFE'));
  assert.deepEqual(annotationTypes(bytes), annotationTypes(original));
  const notes = inspectDocument(bytes).annotations; assert.equal(notes.length, 2); assert(notes.some(note => note.id === 'editor-note' && note.text === 'Keep comment'));
  assert.deepEqual(notes.find(note => note.id === 'editor-highlight').quads, inspectDocument(original).annotations.find(note => note.id === 'editor-highlight').quads);
  assert.equal(operateDocument(bytes, { operation: 'fields' })[0].value, 'FIELD VALUE');
  const doc = new mupdf.PDFDocument(bytes); assert.equal(doc.getTrailer().get('Info', 'Title').asString(), 'Metadata remains during editing'); doc.destroy();
  assert.equal(hash(original), before); save('replace-independent', bytes);
  return { sourceRemoved: true, destinationTextPreserved: true, widgetsLinksCommentsAndPendingRedactionsPreserved: true, sourceUnchanged: true };
});

await check('image-replacement-keeps-text-comments-and-neighboring-image', async () => {
  const doc = await PDFDocument.load(original), image = await doc.embedPng(picture), other = await doc.embedPng(green), page = doc.getPage(0);
  page.drawImage(image, { x: 20, y: 225, width: 140, height: 40 }); page.drawImage(other, { x: 20, y: 30, width: 60, height: 30 });
  const source = await doc.save(), before = hash(source), bytes = operateDocument(source, { operation: 'replace-image', page: 1, sourceRect: [15, 224, 165, 268], rect: [180, 30, 300, 110], image: green, fit: 'contain', opacity: .5 });
  assert(text(bytes).includes('ORIGINAL SECRET')); assert.deepEqual(annotationTypes(bytes), annotationTypes(source)); assert.equal(operateDocument(bytes, { operation: 'fields' })[0].value, 'FIELD VALUE');
  const pixels = raster(bytes); near(pixels(25, 263), [255, 255, 255]); near(pixels(40, 40), [0, 255, 0]); near(pixels(200, 70), [128, 255, 128]);
  assert.equal(hash(source), before); save('replace-image', bytes);
  return { originalImageRegionCleared: true, originalTextAndAnnotationsPreserved: true, neighborImagePreserved: true, actualReplacementAlpha: true };
});

await check('area-info-selects-characters-style-and-rotated-cropped-coordinates', async () => {
  const info = operateDocument(original, { operation: 'area-info', page: 1, rect: [17, 275, 130, 301] });
  assert(info.text.includes('Large')); assert(info.text.includes('small')); assert(info.mixedStyle); assert.equal(info.color, '#ff0000'); assert(info.fontName.includes('Helvetica-Bold')); assert.equal(info.rotated, false);
  for (const rotation of [0, 90, 180, 270]) {
    const doc = await PDFDocument.create(), page = doc.addPage([400, 500]); page.setCropBox(50, 40, 280, 400); page.setRotation(degrees(rotation));
    page.drawText('ROTATED AREA', { x: 80, y: 350, size: 16 }); page.drawText('OUTSIDE', { x: 80, y: 250, size: 16 });
    const source = await doc.save(), before = hash(source), selected = operateDocument(source, { operation: 'area-info', page: 1, rect: [75, 345, 220, 370] });
    assert.equal(selected.text, 'ROTATED AREA'); assert.equal(selected.size, 16); assert.equal(selected.rotated, rotation !== 0); assert.equal(hash(source), before);
  }
  return { partialSelection: true, mixedStylesReported: true, rotations: [0, 90, 180, 270], cropAndOriginalPreserved: true };
});

await check('invalid-options-overflow-and-copy-permissions-fail-with-source-intact', () => {
  const before = hash(original), base = { operation: 'replace-text', page: 1, rect: [20, 200, 200, 260], text: 'Valid', size: 16, color: '#000000' };
  for (const patch of [{ size: 0 }, { align: 'justify' }, { lineHeight: .5 }, { lineHeight: NaN }, { lineHeight: 4 }, { wrap: 'yes' }, { fontName: 'Missing font' }, { sourceRect: [NaN, 0, 10, 10] }, { rect: [20, 200, 40, 220], text: 'Will overflow', wrap: true }]) assert.throws(() => operateDocument(original, { ...base, ...patch }));
  for (const patch of [{ fit: 'bad' }, { opacity: -.1 }, { opacity: 2 }, { opacity: NaN }, { rotation: 45 }, { sourceRect: [0, 0, 0, 0] }]) assert.throws(() => operateDocument(original, { operation: 'replace-image', page: 1, rect: [20, 30, 100, 100], image: picture, ...patch }));
  const doc = new mupdf.PDFDocument(original), buffer = doc.saveToBuffer('encrypt=aes-256,user-password=reader,owner-password=owner,permissions=4');
  const restricted = new Uint8Array(buffer.asUint8Array()); buffer.destroy(); doc.destroy();
  assert.throws(() => operateDocument(restricted, { operation: 'area-info', page: 1, rect: [0, 0, 300, 300] }, 'reader'), /no permite extraer/);
  assert.throws(() => operateDocument(restricted, base, 'reader'), /permisos/); assert.equal(hash(original), before);
  return { invalidControlsBlocked: true, noPartialMutationOnFailure: true, copyAndEditPermissionsEnforced: true };
});

await check('client-area-inspection-and-preview-cancel-before-or-during-work', async () => {
  const clientPath = path.resolve('src/engine/client.ts'), source = fs.readFileSync(clientPath, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(clientPath).href));
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const priorWorker = globalThis.Worker, workers = [];
  class ControlledWorker {
    constructor() { workers.push(this); }
    postMessage(message) { this.message = message; assert.notEqual(message.bytes.buffer, original.buffer); }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = ControlledWorker;
  try {
    const client = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    const before = hash(original), pre = new AbortController(); pre.abort();
    await assert.rejects(client.readAreaContent(original, { page: 1, rect: [0, 0, 100, 100] }, undefined, pre.signal), error => error.name === 'AbortError'); assert.equal(workers.length, 0);
    const info = client.readAreaContent(original, { page: 1, rect: [15, 238, 135, 258] });
    const worker = workers.at(-1); worker.onmessage({ data: { result: operateDocument(worker.message.bytes, worker.message.options) } }); assert((await info).text.includes('ORIGINAL SECRET')); assert(worker.terminated);
    const abort = new AbortController(), promise = client.processPdf(original, { operation: 'add-text', page: 1, rect: [20, 40, 300, 140], text: 'Preview', size: 18, color: '#000000' }, undefined, abort.signal);
    abort.abort(); await assert.rejects(promise, error => error.name === 'AbortError'); assert(workers.at(-1).terminated); assert.equal(hash(original), before);
    return { alreadyAbortedStartsNoWorker: true, typedAreaResult: true, activePreviewWorkerTerminated: true, sourceUnchanged: true };
  } finally { globalThis.Worker = priorWorker; }
});

fs.writeFileSync(path.join(output, 'content-editor-engine-results.json'), JSON.stringify({ engine: 'MuPDF.js 1.28.1 actual PDF bytes and pixels', results }, null, 2));
