// Editing inside the reader: moving text keeps its own glyphs, fonts and styles;
// images move, turn, fade and duplicate without being re-encoded; replaced text
// can keep the PDF's original font; added drawings do not nest q/Q per edit;
// shapes are Folio annotations that move and change style.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { operateDocument } from '../../src/engine/operations.mjs';
import { writeAnnotations, inspectDocument } from '../../src/engine/mupdf-engine.mjs';

const results = [];
async function check(id, run) {
  try { results.push({ id, status: 'passed', ...await run() }); }
  catch (error) { results.push({ id, status: 'failed', error: error.stack || String(error) }); }
}
const items = (bytes, page) => operateDocument(bytes, { operation: 'page-content', page }).items;
const paragraphs = (bytes, page) => items(bytes, page).filter(item => item.kind === 'text' && item.level === 'paragraph' && item.editable && item.text.length > 40);
const glyphs = (bytes, index) => {
  const doc = new mupdf.PDFDocument(bytes), page = doc.loadPage(index), found = [];
  page.toStructuredText('preserve-whitespace').walk({ onChar: (c, origin, font, size) => { if (c.trim()) found.push({ c, x: origin[0], y: origin[1], font: font.getName(), size }); } });
  return found;
};
const tracemonkey = new Uint8Array(fs.readFileSync('.fixtures/tracemonkey.pdf'));

await check('moved-text-keeps-glyphs-fonts-and-styles', () => {
  const [title] = paragraphs(tracemonkey, 1), r = title.rect;
  const before = glyphs(tracemonkey, 0).filter(g => g.x >= r[0] - 1 && g.x <= r[2] + 1 && g.y >= 792 - r[3] - 1 && g.y <= 792 - r[1] + 1);
  const moved = operateDocument(tracemonkey, { operation: 'move-text', page: 1, sourceId: title.id, sourceRect: r, rect: [r[0] + 40, r[1] - 10, r[2] + 40, r[3] - 10] });
  const after = glyphs(moved, 0);
  for (const glyph of before) assert(after.some(g => g.font === glyph.font && Math.abs(g.size - glyph.size) < .01 && Math.abs(g.x - glyph.x - 40) < .05 && Math.abs(g.y - glyph.y - 10) < .05), `${glyph.c} moved with its font`);
  // A second and third move on the same page still work.
  let bytes = moved;
  for (const i of [1, 2]) { const p = paragraphs(bytes, 1)[i], q = p.rect; bytes = operateDocument(bytes, { operation: 'move-text', page: 1, sourceId: p.id, sourceRect: q, rect: [q[0] + 5, q[1], q[2] + 5, q[3]] }); }
  return { glyphsMoved: before.length, repeatedMoves: true };
});

await check('copy-keeps-the-original-and-resize-is-refused', () => {
  const [title] = paragraphs(tracemonkey, 1), r = title.rect;
  const copy = operateDocument(tracemonkey, { operation: 'move-text', page: 1, sourceId: title.id, sourceRect: r, rect: [r[0], r[1] - 300, r[2], r[3] - 300], copy: true });
  const count = bytes => glyphs(bytes, 0).filter(g => g.c === 'T' && g.size > 15).length;
  assert.equal(count(copy), count(tracemonkey) * 2);
  assert.throws(() => operateDocument(tracemonkey, { operation: 'move-text', page: 1, sourceId: title.id, sourceRect: r, rect: [r[0], r[1], r[2] + 50, r[3]] }), /tamaño/);
  return { duplicated: true, resizeRefused: true };
});

await check('replaced-text-uses-the-original-font', () => {
  const [p] = paragraphs(tracemonkey, 2);
  const bytes = operateDocument(tracemonkey, { operation: 'replace-text', page: 2, sourceId: p.id, sourceRect: p.rect, rect: p.rect, text: 'Hence recording', size: p.size, color: p.color, originalFont: true, wrap: true, baselineOffset: p.baselineOffset, lineHeight: p.lineHeight });
  const written = glyphs(bytes, 1).filter(g => g.y < 800 - p.rect[1] && g.y > 792 - p.rect[3] - 2);
  assert(written.some(g => g.c === 'H' && g.font.replace(/^[A-Z]{6}\+/, '') === p.fontName.replace(/^[A-Z]{6}\+/, '')), 'Same font family as the source');
  assert.throws(() => operateDocument(tracemonkey, { operation: 'replace-text', page: 2, sourceId: p.id, sourceRect: p.rect, rect: p.rect, text: 'Ωmega', size: p.size, color: p.color, originalFont: true, wrap: true }), /fuente original no incluye/);
  return { originalFontReused: true, missingGlyphReported: true };
});

await check('images-move-turn-fade-and-copy-without-re-encoding', async () => {
  const source = new mupdf.PDFDocument(tracemonkey);
  const jpeg = source.loadPage(0).toPixmap(mupdf.Matrix.scale(.4, .4), mupdf.ColorSpace.DeviceRGB, false).asJPEG(80);
  const alpha = source.loadPage(1).toPixmap(mupdf.Matrix.scale(.3, .3), mupdf.ColorSpace.DeviceRGB, true).asPNG();
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]);
  page.drawImage(await pdf.embedJpg(jpeg), { x: 40, y: 450, width: 245, height: 317 });
  page.drawImage(await pdf.embedPng(alpha), { x: 320, y: 450, width: 184, height: 238 });
  let bytes = new Uint8Array(await pdf.save());
  const streams = b => { const d = new mupdf.PDFDocument(b), r = []; for (let n = 1; n < d.countObjects(); n++) { const o = d.newIndirect(n, 0); if (o.isDictionary() && o.get('Subtype').asName() === 'Image') r.push(o.get('Length').asNumber()); } return r.sort((x, y) => x - y); };
  const before = streams(bytes), [photo, png] = items(bytes, 1).filter(item => item.kind === 'image');
  assert(photo.editable && png.editable && png.transparent, 'A PNG with alpha is editable');
  bytes = operateDocument(bytes, { operation: 'move-image', page: 1, sourceId: photo.id, sourceRect: photo.rect, rect: [50, 50, 367, 295], rotation: 90 });
  const transparent = items(bytes, 1).find(item => item.transparent);
  bytes = operateDocument(bytes, { operation: 'move-image', page: 1, sourceId: transparent.id, sourceRect: transparent.rect, rect: [transparent.rect[0], 60, transparent.rect[2], 60 + transparent.rect[3] - transparent.rect[1]], opacity: .5, copy: true });
  const after = items(bytes, 1).filter(item => item.kind === 'image');
  assert.equal(after.length, 3);
  assert(after.some(item => item.rotation === 90) && after.some(item => Math.abs(item.opacity - .5) < .01));
  assert.deepEqual([...new Set(streams(bytes))], [...new Set(before)], 'Image streams are reused byte for byte');
  return { rotated: true, faded: true, copied: true, reEncoded: false };
});

await check('turn-is-clockwise', async () => {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2, 1], false); pix.getPixels().set([255, 0, 0, 0, 0, 255]);
  const pdf = await PDFDocument.create(); pdf.addPage([400, 400]).drawImage(await pdf.embedPng(pix.asPNG()), { x: 100, y: 150, width: 200, height: 100 });
  let bytes = new Uint8Array(await pdf.save()); const image = items(bytes, 1).find(item => item.kind === 'image');
  bytes = operateDocument(bytes, { operation: 'move-image', page: 1, sourceId: image.id, sourceRect: image.rect, rect: [150, 100, 250, 300], rotation: 90 });
  const render = new mupdf.PDFDocument(bytes).loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false), at = (x, y) => [...render.getPixels().slice((y * render.getWidth() + x) * 3, (y * render.getWidth() + x) * 3 + 3)];
  assert.deepEqual(at(200, 120), [255, 0, 0], 'The left edge turns to the top');
  return { clockwise: true };
});

await check('added-drawings-do-not-nest-q-per-edit', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([400, 400]).drawText('Base', { x: 20, y: 380, size: 10, font: await pdf.embedFont(StandardFonts.Helvetica) });
  let bytes = new Uint8Array(await pdf.save());
  for (let i = 0; i < 40; i++) bytes = operateDocument(bytes, { operation: 'add-text', page: 1, rect: [20, 20 + i * 8, 200, 28 + i * 8], text: `Línea ${i}`, size: 6, color: '#000000' });
  const doc = new mupdf.PDFDocument(bytes), contents = doc.findPage(0).get('Contents');
  let depth = 0, deepest = 0;
  for (let i = 0; i < contents.length; i++) for (const token of contents.get(i).readStream().asString().split(/\s+/)) { if (token === 'q') deepest = Math.max(deepest, ++depth); if (token === 'Q') depth--; }
  assert(deepest <= 2, `q depth ${deepest}`);
  return { additions: 40, deepest };
});

await check('shape-annotations-round-trip-move-and-restyle', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([400, 400]); const blank = new Uint8Array(await pdf.save());
  const shapes = [
    { id: 'r1', page: 1, kind: 'shape', shape: 'rect', rect: [50, 50, 150, 120], color: '#d03030', fill: '#ffe0a0', strokeWidth: 2, opacity: .8, text: '', created: 1 },
    { id: 'e1', page: 1, kind: 'shape', shape: 'ellipse', rect: [200, 50, 300, 150], color: '#2050c0', fill: null, strokeWidth: 3, text: '', created: 1 },
    { id: 'a1', page: 1, kind: 'shape', shape: 'arrow', rect: [50, 200, 300, 300], line: [50, 200, 300, 300], color: '#000000', strokeWidth: 1.5, text: '', created: 1 },
  ];
  let read = inspectDocument(writeAnnotations(blank, shapes)).annotations;
  assert.deepEqual(read.map(a => [a.id, a.shape, a.fill]), [['r1', 'rect', '#ffe0a0'], ['e1', 'ellipse', null], ['a1', 'arrow', null]]);
  assert.deepEqual(read.find(a => a.id === 'a1').line.map(Math.round), [50, 200, 300, 300]);
  const moved = read.map(a => a.id === 'r1' ? { ...a, rect: [100, 100, 200, 170], fill: null, strokeWidth: 4 } : a);
  read = inspectDocument(writeAnnotations(writeAnnotations(blank, shapes), moved)).annotations;
  const rect = read.find(a => a.id === 'r1');
  assert.deepEqual([rect.rect.map(Math.round), rect.fill, rect.strokeWidth], [[100, 100, 200, 170], null, 4]);
  assert.throws(() => writeAnnotations(blank, [{ ...shapes[0], shape: 'star' }]), /forma/);
  return { created: 3, movedAndRestyled: true };
});

for (const result of results) console.log(JSON.stringify(result));
process.exitCode = results.some(result => result.status !== 'passed') ? 1 : 0;
