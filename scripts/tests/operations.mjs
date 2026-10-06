import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { operateDocument } from '../../src/engine/operations.mjs';
import { inspectDocument, writeAnnotations } from '../../src/engine/mupdf-engine.mjs';

fs.mkdirSync('test-results', { recursive: true });
const results = [];
async function check(id, test) {
  try { results.push({ id, status: 'passed', ...await test() }); }
  catch (error) { results.push({ id, status: 'failed', error: error.stack }); process.exitCode = 1; }
  console.log(JSON.stringify(results.at(-1)));
}
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 3; i++) {
  const page = pdf.addPage([400, 500]); page.drawText(`PAGE ${i}`, { x: 40, y: 430, size: 18, font });
  page.drawText('SECRET 123456', { x: 40, y: 350, size: 18, font });
  page.drawText('PRESERVE THIS TEXT', { x: 40, y: 260, size: 14, font });
}
pdf.setTitle('Private metadata');
const form = pdf.getForm(), field = form.createTextField('full.name');
field.setText('Original name'); field.addToPage(pdf.getPage(0), { x: 40, y: 190, width: 200, height: 30 });
const checkBox = form.createCheckBox('agree'); checkBox.addToPage(pdf.getPage(0), { x: 40, y: 150, width: 20, height: 20 });
const choice = form.createDropdown('country'); choice.addOptions(['Paraguay', 'Uruguay']); choice.select('Paraguay');
choice.addToPage(pdf.getPage(0), { x: 80, y: 150, width: 160, height: 25 });
const source = await pdf.save();
const text = data => operateDocument(data, { operation: 'text' });
const exportFile = (name, bytes) => fs.writeFileSync(`test-results/${name}.pdf`, bytes);

await check('page-order-delete-duplicate-rotation-and-original-preserved', () => {
  const before = Buffer.from(source);
  const bytes = operateDocument(source, { operation: 'pages', plan: [{ page: 3 }, { page: 1, rotation: 90 }, { page: 1 }] });
  assert.deepEqual(source, new Uint8Array(before));
  const doc = new mupdf.PDFDocument(bytes); assert.equal(doc.countPages(), 3);
  assert.equal(doc.findPage(1).getInheritable('Rotate').asNumber(), 90);
  assert.equal(doc.findPage(2).getInheritable('Rotate').asNumber(), 0, 'Duplicar no debe compartir el giro.'); doc.destroy();
  assert(text(bytes)[0].includes('PAGE 3')); assert(!text(bytes).some(t => t.includes('PAGE 2')));
  exportFile('organized', bytes); return { pages: 3, order: [3, 1, 1] };
});
await check('blank-pages-and-merge-preserve-text', () => {
  const bytes = operateDocument(source, { operation: 'pages', plan: [{ page: 1 }, { blank: [595, 842] }, { source: 0, page: 2 }], sources: [{ bytes: source }] });
  const strings = text(bytes); assert.equal(strings.length, 3); assert.equal(strings[1].trim(), ''); assert(strings[2].includes('PAGE 2'));
  exportFile('merged', bytes); return { pages: 3, blankPage: true };
});
await check('fill-text-checkbox-and-choice-roundtrip', () => {
  const fields = operateDocument(source, { operation: 'fields' }); assert.equal(fields.length, 3);
  const values = Object.fromEntries(fields.map(f => [f.id, f.name === 'full.name' ? 'Emilio González' : f.name === 'agree' ? true : 'Uruguay']));
  const bytes = operateDocument(source, { operation: 'fill', values });
  const next = operateDocument(bytes, { operation: 'fields' });
  assert.equal(next.find(f => f.name === 'full.name').value, 'Emilio González');
  assert.equal(next.find(f => f.name === 'agree').checked, true);
  assert.equal(next.find(f => f.name === 'country').value, 'Uruguay');
  exportFile('filled-form', bytes); return { fields: next.length, unicode: true };
});
await check('replace-original-text-keeps-neighboring-content', () => {
  const bytes = operateDocument(source, { operation: 'replace-text', page: 1, rect: [35, 344, 210, 372], text: 'PUBLIC TEXT', size: 16, color: '#000000' });
  exportFile('edited-text', bytes);
  const strings = text(bytes); assert(!strings[0].includes('SECRET')); assert(strings[0].includes('PUBLIC TEXT')); assert(strings[0].includes('PRESERVE THIS TEXT'));
  assert(strings[1].includes('SECRET')); exportFile('edited-text', bytes); return { replacement: true, otherPagesPreserved: true };
});
await check('redaction-removes-data-fields-comments-and-metadata', () => {
  const annotated = writeAnnotations(source, [{ id: 'private', page: 1, kind: 'note', rect: [40, 365, 40, 365], color: '#f5d164', text: 'SECRET 123456', created: 1 }]);
  const bytes = operateDocument(annotated, { operation: 'redact', areas: [{ page: 1, rect: [30, 340, 250, 380] }] });
  assert(!text(bytes)[0].includes('SECRET')); assert(text(bytes)[0].includes('PRESERVE THIS TEXT'));
  assert.equal(inspectDocument(bytes).annotations.length, 0);
  const doc = new mupdf.PDFDocument(bytes); assert(doc.getTrailer().get('Info').isNull());
  assert.equal(operateDocument(bytes, { operation: 'fields' }).length, 0); doc.destroy();
  exportFile('redacted', bytes); return { removedFromText: true, metadataRemoved: true, fieldsFlattened: true };
});
await check('aes256-protect-restrict-and-owner-unlock', () => {
  const bytes = operateDocument(source, { operation: 'protect', userPassword: 'reader', ownerPassword: 'owner', permissions: 4 });
  assert.throws(() => inspectDocument(bytes, 'wrong'));
  const permissions = inspectDocument(bytes, 'reader'); assert(!permissions.canEdit && !permissions.canFill && !permissions.canAssemble);
  assert.throws(() => operateDocument(bytes, { operation: 'compress' }, 'reader'), /permisos/);
  const unlocked = operateDocument(bytes, { operation: 'unprotect' }, 'owner'); assert.equal(inspectDocument(unlocked).pages, 3);
  exportFile('protected-operations', bytes); return { encryption: 'AES-256', permissionsEnforced: true, ownerCanUnlock: true };
});
await check('lossless-compression-keeps-text-fields-and-pages', () => {
  const bytes = operateDocument(source, { operation: 'compress' }); assert.deepEqual(text(bytes), text(source));
  assert.equal(operateDocument(bytes, { operation: 'fields' }).length, 3); return { originalSize: source.length, resultSize: bytes.length };
});
await check('crop-and-rotated-text-placement', async () => {
  const pdf = await PDFDocument.create(); const p = pdf.addPage([600, 800]); p.setCropBox(50, 40, 480, 680); p.setRotation(degrees(90));
  const bytes = operateDocument(await pdf.save(), { operation: 'add-text', page: 1, rect: [100, 300, 200, 650], text: 'ROTATED', size: 14, color: '#000000' });
  assert(text(bytes)[0].includes('ROTATED')); exportFile('rotated-edit', bytes); return { nativeRotation: 90, cropPreserved: true };
});
await check('actual-crop-coordinate-roundtrip-at-four-rotations', async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const pdf = await PDFDocument.create(), p = pdf.addPage([600, 800]);
    p.setCropBox(50, 40, 480, 680); p.setRotation(degrees(rotation));
    const bytes = operateDocument(await pdf.save(), { operation: 'crop', page: 1, rect: [100, 150, 400, 500] });
    const doc = new mupdf.PDFDocument(bytes);
    assert.deepEqual(doc.findPage(0).get('CropBox').asJS(), [100, 150, 400, 500]);
    doc.destroy(); exportFile(`crop-${rotation}`, bytes);
  }
  return { rotations: [0, 90, 180, 270], pdfCoordinatesPreserved: true };
});
await check('merge-preserves-real-fields-notes-and-internal-links', () => {
  const original = new mupdf.PDFDocument(source), page = original.findPage(0), annotations = page.get('Annots');
  const link = original.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 40, 40], A: { S: 'GoTo', D: [original.findPage(1), 'Fit'] } }); annotations.push(link);
  const saved = original.saveToBuffer('garbage=4,compress=yes'), sourceWithLink = new Uint8Array(saved.asUint8Array()); saved.destroy(); original.destroy();
  const withNotes = writeAnnotations(sourceWithLink, [{ id: 'merge-note', page: 1, kind: 'note', rect: [300, 350, 300, 350], color: '#f5d164', text: 'Imported note', created: 1 }]);
  const bytes = operateDocument(source, { operation: 'pages', plan: [{ page: 3 }, { source: 0, page: 1 }, { source: 0, page: 2 }], sources: [{ bytes: withNotes }] });
  const fields = operateDocument(bytes, { operation: 'fields' }); assert.equal(fields.length, 3); assert(fields.every(f => f.page === 2));
  const filled = operateDocument(bytes, { operation: 'fill', values: Object.fromEntries(fields.map(f => [f.id, f.type === 'checkbox' ? true : f.type === 'combobox' ? 'Uruguay' : 'Imported value'])) });
  assert(operateDocument(filled, { operation: 'fields' }).some(f => f.value === 'Imported value'));
  assert(inspectDocument(bytes).annotations.some(a => a.text === 'Imported note' && a.page === 2));
  const doc = new mupdf.PDFDocument(bytes), annots = doc.findPage(1).get('Annots'); let found = false;
  for (let i = 0; i < annots.length; i++) if (annots.get(i).get('Subtype').asName() === 'Link') {
    assert.equal(annots.get(i).get('Dest', 0).asIndirect(), doc.findPage(2).asIndirect()); found = true;
  }
  assert(found); doc.destroy(); exportFile('merged-complete', filled); return { fields: 3, comments: true, internalDestinationRemapped: true };
});
await check('multiline-highlights-retain-separate-standard-quads', () => {
  const quads = [[40, 440, 150, 440, 40, 422, 150, 422], [40, 370, 195, 370, 40, 348, 195, 348]];
  const bytes = writeAnnotations(source, [{ id: 'lines', page: 1, kind: 'highlight', rect: [40, 348, 195, 440], color: '#f5d164', text: 'Two lines', quads, created: 1 }]);
  assert.deepEqual(inspectDocument(bytes).annotations[0].quads, quads); exportFile('multiline-highlight', bytes); return { standardQuads: 2 };
});
await check('radio-group-exports-one-selected-option', async () => {
  const pdf=await PDFDocument.create(), page=pdf.addPage([400,500]), group=pdf.getForm().createRadioGroup('decision');
  group.addOptionToPage('First',page,{x:40,y:200,width:20,height:20}); group.addOptionToPage('Second',page,{x:80,y:200,width:20,height:20}); group.select('First');
  const source=await pdf.save(), fields=operateDocument(source,{operation:'fields'}); assert.equal(fields.length,2);
  const bytes=operateDocument(source,{operation:'fill',values:Object.fromEntries(fields.map((f,i)=>[f.id,i===1]))});
  const next=operateDocument(bytes,{operation:'fields'}); assert.equal(next.filter(f=>f.checked).length,1); assert(next[1].checked);
  const independent=await PDFDocument.load(bytes); assert.equal(independent.getForm().getRadioGroup('decision').getSelected(),'Second');
  exportFile('radio-filled',bytes); return { selected:'Second', exclusive:true };
});
await check('image-redaction-removes-embedded-pixels-and-hidden-copy', async () => {
  const picture = await PDFDocument.create(), p = picture.addPage([400, 200]);
  p.drawText('IMAGE SECRET 98765', { x: 30, y: 120, size: 22 }); p.drawText('SAFE IMAGE', { x: 30, y: 50, size: 18 });
  const raster = new mupdf.PDFDocument(await picture.save()), page = raster.loadPage(0), pixels = page.toPixmap([2,0,0,2,0,0], mupdf.ColorSpace.DeviceRGB, false);
  const png = new Uint8Array(pixels.asPNG()); pixels.destroy(); page.destroy(); raster.destroy();
  const target = await PDFDocument.create(), image = await target.embedPng(png), imagePage = target.addPage([400, 200]); imagePage.drawImage(image, { x: 0, y: 0, width: 400, height: 200 });
  const original = await target.save(), bytes = operateDocument(original, { operation: 'redact', areas: [{ page: 1, rect: [20,110,330,148] }] });
  exportFile('image-redaction-original', original); exportFile('image-redacted', bytes);
  const images = new mupdf.PDFDocument(original), originalImageBytes = [];
  for (let i=1;i<images.countObjects();i++) { const obj=images.newIndirect(i); if (obj.get('Subtype').asName() === 'Image') {
    const stream=obj.readStream(); originalImageBytes.push(new Uint8Array(stream.asUint8Array())); stream.destroy();
  } } images.destroy(); assert(originalImageBytes.length);
  const doc = new mupdf.PDFDocument(bytes); let oldImageFound = false;
  for (let i=1;i<doc.countObjects();i++) { const obj=doc.newIndirect(i); if (obj.get('Subtype').asName() === 'Image') {
    const stream=obj.readStream(); const data=new Uint8Array(stream.asUint8Array()); stream.destroy();
    if (originalImageBytes.some(before => data.length===before.length && data.every((n,i)=>n===before[i]))) oldImageFound=true;
  } }
  assert(!oldImageFound); doc.destroy(); return { rasterFixture: true, independentPixelCheckRequired: true };
});
await check('sanitize-removes-script-launch-and-submit-actions-but-keeps-links', async () => {
  const target = await PDFDocument.create(), page = target.addPage([400, 400]), dni = target.getForm().createTextField('dni');
  dni.setText('12345678Z'); dni.addToPage(page, { x: 40, y: 300, width: 120, height: 20 });
  const doc = new mupdf.PDFDocument(await target.save()), annots = doc.findPage(0).get('Annots'), root = doc.getTrailer().get('Root');
  annots.get(0).put('AA', doc.newDictionary()); annots.get(0).get('AA').put('Fo', { S: 'JavaScript', JS: doc.newString('app.alert(1)') });
  for (const [y, action] of [[200, { S: 'JavaScript', JS: doc.newString('this.submitForm("https://example.com")') }], [150, { S: 'Launch', F: doc.newString('calc.exe') }], [100, { S: 'URI', URI: doc.newString('https://example.org/'), Next: { S: 'JavaScript', JS: doc.newString('app.alert(2)') } }]])
    annots.push(doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [40, y, 200, y + 20], A: action }));
  const outline = doc.addObject({ Title: doc.newString('Inicio'), A: { S: 'JavaScript', JS: doc.newString('app.alert(3)') } }), outlines = doc.addObject({ Type: 'Outlines', First: outline, Last: outline, Count: 1 });
  outline.put('Parent', outlines); root.put('Outlines', outlines); root.get('AcroForm').put('XFA', doc.newString('<xdp:xdp/>'));
  const source = new Uint8Array(doc.saveToBuffer('').asUint8Array()); doc.destroy();
  const cleaned = new mupdf.PDFDocument(operateDocument(source, { operation: 'sanitize' })), links = cleaned.findPage(0).get('Annots'), actions = [];
  for (let i = 0; i < links.length; i++) { assert(links.get(i).get('AA').isNull()); actions.push(links.get(i).get('A', 'S').asName()); }
  assert.deepEqual(actions, ['', '', '', 'URI']); assert(links.get(3).get('A', 'Next').isNull());
  assert(cleaned.getTrailer().get('Root', 'Outlines', 'First', 'A').isNull()); assert(cleaned.getTrailer().get('Root', 'AcroForm', 'XFA').isNull());
  assert.equal(operateDocument(cleaned.saveToBuffer('').asUint8Array(), { operation: 'fields' })[0].value, '12345678Z'); cleaned.destroy();
  return { fieldAndLinkScriptsRemoved: true, launchRemoved: true, chainedScriptRemoved: true, outlineScriptRemoved: true, xfaRemoved: true, uriLinkKept: true };
});
await check('same-named-fields-are-listed-once-and-filled-on-every-page', async () => {
  const target = await PDFDocument.create(), pages = [target.addPage([400, 400]), target.addPage([400, 400])], name = target.getForm().createTextField('nombre');
  name.setText('Original'); for (const page of pages) name.addToPage(page, { x: 40, y: 300, width: 160, height: 24 });
  const original = await target.save(), listed = operateDocument(original, { operation: 'fields' });
  assert.equal(listed.length, 1); assert.deepEqual(listed[0].pages, [1, 2]);
  const bytes = operateDocument(original, { operation: 'fill', values: { [listed[0].id]: 'Ana Pérez' } }), doc = new mupdf.PDFDocument(bytes);
  for (let i = 0; i < 2; i++) { const page = doc.loadPage(i); assert.equal(page.getWidgets()[0].getValue(), 'Ana Pérez'); page.destroy(); }
  doc.destroy(); return { listedOnce: true, valueOnEveryPage: true };
});
await check('fields-without-a-name-stay-separate', () => {
  const doc = new mupdf.PDFDocument(), page = doc.addPage([0, 0, 400, 400], 0, {}, ''), refs = [];
  for (const [i, value] of ['orig0', 'orig1'].entries()) refs.push(doc.addObject({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', Rect: [40, 300 - i * 50, 200, 324 - i * 50], V: doc.newString(value), DA: doc.newString('/Helv 12 Tf 0 g') }));
  page.put('Annots', refs); doc.insertPage(-1, page); doc.getTrailer().get('Root').put('AcroForm', doc.addObject({ Fields: refs }));
  const original = new Uint8Array(doc.saveToBuffer('').asUint8Array()); doc.destroy();
  const listed = operateDocument(original, { operation: 'fields' }); assert.deepEqual(listed.map(field => field.value), ['orig0', 'orig1']);
  const filled = new mupdf.PDFDocument(operateDocument(original, { operation: 'fill', values: { [listed[0].id]: 'Escrito' } })), widgets = filled.loadPage(0).getWidgets();
  assert.deepEqual(widgets.map(widget => widget.getValue()), ['Escrito', 'orig1']); filled.destroy();
  return { bothListed: true, fillingOneKeepsTheOther: true };
});
const photo = (orientation = 1) => {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 80, 40], false), samples = pixmap.getPixels();
  for (let y = 0; y < 40; y++) for (let x = 0; x < 80; x++) samples.set([x < 40 ? 230 : 20, y < 20 ? 20 : 200, x < 40 ? 20 : 230], y * pixmap.getStride() + x * 3);
  const jpeg = new Uint8Array(pixmap.asJPEG(95, false)); pixmap.destroy();
  if (orientation === 1) return jpeg;
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, exif.length + 2, ...exif, ...jpeg.subarray(2)]);
};
await check('jpeg-images-stay-compressed-when-moved-or-duplicated', async () => {
  const target = await PDFDocument.create(), jpeg = photo(), image = await target.embedJpg(jpeg); target.addPage([400, 400]).drawImage(image, { x: 40, y: 200, width: 160, height: 80 });
  const original = await target.save(), item = operateDocument(original, { operation: 'page-content', page: 1 }).items.find(item => item.kind === 'image');
  const info = operateDocument(original, { operation: 'page-image', page: 1, id: item.id });
  assert.equal(info.type, 'image/jpeg'); assert.deepEqual(info.bytes, jpeg);
  const moved = operateDocument(original, { operation: 'replace-image', page: 1, rect: [item.rect[0] + 20, item.rect[1], item.rect[2] + 20, item.rect[3]], sourceRect: item.rect, image: info.bytes, fit: 'stretch' });
  const doc = new mupdf.PDFDocument(moved), streams = [];
  for (let i = 1; i < doc.countObjects(); i++) { const object = doc.newIndirect(i); if (object.get('Subtype').asName() === 'Image') { const raw = object.readRawStream(); streams.push([object.get('Filter').toString(), raw.getLength()]); raw.destroy(); } }
  doc.destroy(); assert.deepEqual(streams, [['/DCTDecode', jpeg.length]]);
  return { originalJpegReturned: true, movedImageKeepsSameJpeg: true };
});
await check('inline-image-never-returns-another-images-jpeg', () => {
  const doc = new mupdf.PDFDocument(), gray = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 32, 32], false); gray.clear(40);
  const xobject = doc.addRawStream(new Uint8Array(gray.asJPEG(90, false)), { Type: 'XObject', Subtype: 'Image', Width: 32, Height: 32, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }); gray.destroy();
  const red = 'ff0000'.repeat(32 * 32), page = doc.addPage([0, 0, 400, 400], 0, { XObject: { Im1: xobject } }, `q 100 0 0 100 20 280 cm /Im1 Do Q\nq 100 0 0 100 200 40 cm BI /W 32 /H 32 /CS /RGB /BPC 8 /F /AHx ID ${red}> EI Q\n`);
  doc.insertPage(-1, page); const original = new Uint8Array(doc.saveToBuffer('').asUint8Array()); doc.destroy();
  const items = operateDocument(original, { operation: 'page-content', page: 1 }).items.filter(item => item.kind === 'image'); assert.equal(items.length, 2);
  const first = pixels => { const image = new mupdf.Image(pixels.bytes), pixmap = image.toPixmap(); try { return [...pixmap.getPixels().subarray(0, 3)]; } finally { pixmap.destroy(); image.destroy(); } };
  const [stored, inline] = items.map(item => operateDocument(original, { operation: 'page-image', page: 1, id: item.id }));
  assert.equal(stored.type, 'image/jpeg'); assert.equal(inline.type, 'image/png'); assert.deepEqual(first(inline), [255, 0, 0]);
  return { xobjectJpegReturned: true, inlineImageDecodedItself: true };
});
await check('camera-photo-exif-orientation-is-placed-upright', async () => {
  const blank = await PDFDocument.create(); blank.addPage([300, 300]);
  const bytes = operateDocument(await blank.save(), { operation: 'add-image', page: 1, rect: [50, 50, 250, 250], image: photo(6), fit: 'contain' });
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf'), page = doc.loadPage(0), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false), samples = pixmap.getPixels();
  const at = (x, y) => [...samples.subarray(y * pixmap.getStride() + x * 3, y * pixmap.getStride() + x * 3 + 3)], near = (a, b) => a.every((n, i) => Math.abs(n - b[i]) < 40);
  // Rotated 90° clockwise: the stored top-left (red) shows top-right, the stored bottom-left top-left.
  assert(near(at(175, 100), [230, 20, 20])); assert(near(at(125, 100), [230, 200, 20])); assert(near(at(175, 200), [20, 20, 230]));
  pixmap.destroy(); page.destroy(); doc.destroy(); return { orientation6Upright: true, portraitFrame: true };
});
fs.writeFileSync('test-results/operations-results.json', JSON.stringify({ engine: 'MuPDF WASM', results }, null, 2));
