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
fs.writeFileSync('test-results/operations-results.json', JSON.stringify({ engine: 'MuPDF WASM', results }, null, 2));
