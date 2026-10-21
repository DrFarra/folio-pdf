// Editing inside the reader: moving text keeps its own glyphs, fonts and styles;
// images move, turn, fade and duplicate without being re-encoded; replaced text
// can keep the PDF's original font; added drawings do not nest q/Q per edit;
// shapes are Folio annotations that move and change style. Editar's live
// document takes those changes in place, each one a step it can undo, and
// draws any item alone (a sprite) to move it on screen before it is written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  operateDocument,
  editDocument,
  editDocumentAll,
  pagePlate,
  itemSprite,
  readPage,
} from '../../src/engine/operations.ts';
import { writeAnnotations, inspectDocument, open } from '../../src/engine/mupdf-engine.mjs';

const results = [];
async function check(id, run) {
  try {
    results.push({ id, status: 'passed', ...(await run()) });
  } catch (error) {
    results.push({ id, status: 'failed', error: error.stack || String(error) });
  }
}
const items = (bytes, page) => operateDocument(bytes, { operation: 'page-content', page }).items;
const paragraphs = (bytes, page) =>
  items(bytes, page).filter(
    item => item.kind === 'text' && item.level === 'paragraph' && item.editable && item.text.length > 40,
  );
const glyphs = (bytes, index) => {
  const doc = new mupdf.PDFDocument(bytes),
    page = doc.loadPage(index),
    found = [];
  page.toStructuredText('preserve-whitespace').walk({
    onChar: (c, origin, font, size) => {
      if (c.trim()) found.push({ c, x: origin[0], y: origin[1], font: font.getName(), size });
    },
  });
  return found;
};
const tracemonkey = new Uint8Array(fs.readFileSync('.fixtures/tracemonkey.pdf'));

await check('moved-text-keeps-glyphs-fonts-and-styles', () => {
  const [title] = paragraphs(tracemonkey, 1),
    r = title.rect;
  const before = glyphs(tracemonkey, 0).filter(
    g => g.x >= r[0] - 1 && g.x <= r[2] + 1 && g.y >= 792 - r[3] - 1 && g.y <= 792 - r[1] + 1,
  );
  const moved = operateDocument(tracemonkey, {
    operation: 'move-text',
    page: 1,
    sourceId: title.id,
    sourceRect: r,
    rect: [r[0] + 40, r[1] - 10, r[2] + 40, r[3] - 10],
  });
  const after = glyphs(moved, 0);
  for (const glyph of before)
    assert(
      after.some(
        g =>
          g.font === glyph.font &&
          Math.abs(g.size - glyph.size) < 0.01 &&
          Math.abs(g.x - glyph.x - 40) < 0.05 &&
          Math.abs(g.y - glyph.y - 10) < 0.05,
      ),
      `${glyph.c} moved with its font`,
    );
  // A second and third move on the same page still work.
  let bytes = moved;
  for (const i of [1, 2]) {
    const p = paragraphs(bytes, 1)[i],
      q = p.rect;
    bytes = operateDocument(bytes, {
      operation: 'move-text',
      page: 1,
      sourceId: p.id,
      sourceRect: q,
      rect: [q[0] + 5, q[1], q[2] + 5, q[3]],
    });
  }
  return { glyphsMoved: before.length, repeatedMoves: true };
});

await check('copy-keeps-the-original-and-resize-is-refused', () => {
  const [title] = paragraphs(tracemonkey, 1),
    r = title.rect;
  const copy = operateDocument(tracemonkey, {
    operation: 'move-text',
    page: 1,
    sourceId: title.id,
    sourceRect: r,
    rect: [r[0], r[1] - 300, r[2], r[3] - 300],
    copy: true,
  });
  const count = bytes => glyphs(bytes, 0).filter(g => g.c === 'T' && g.size > 15).length;
  assert.equal(count(copy), count(tracemonkey) * 2);
  assert.throws(
    () =>
      operateDocument(tracemonkey, {
        operation: 'move-text',
        page: 1,
        sourceId: title.id,
        sourceRect: r,
        rect: [r[0], r[1], r[2] + 50, r[3]],
      }),
    /tamaño/,
  );
  return { duplicated: true, resizeRefused: true };
});

await check('replaced-text-uses-the-original-font', () => {
  const [p] = paragraphs(tracemonkey, 2);
  const bytes = operateDocument(tracemonkey, {
    operation: 'replace-text',
    page: 2,
    sourceId: p.id,
    sourceRect: p.rect,
    rect: p.rect,
    text: 'Hence recording',
    size: p.size,
    color: p.color,
    originalFont: true,
    wrap: true,
    baselineOffset: p.baselineOffset,
    lineHeight: p.lineHeight,
  });
  const written = glyphs(bytes, 1).filter(g => g.y < 800 - p.rect[1] && g.y > 792 - p.rect[3] - 2);
  assert(
    written.some(g => g.c === 'H' && g.font.replace(/^[A-Z]{6}\+/, '') === p.fontName.replace(/^[A-Z]{6}\+/, '')),
    'Same font family as the source',
  );
  assert.throws(
    () =>
      operateDocument(tracemonkey, {
        operation: 'replace-text',
        page: 2,
        sourceId: p.id,
        sourceRect: p.rect,
        rect: p.rect,
        text: 'Ωmega',
        size: p.size,
        color: p.color,
        originalFont: true,
        wrap: true,
      }),
    /fuente original no incluye/,
  );
  return { originalFontReused: true, missingGlyphReported: true };
});

await check('rewritten-accented-text-reads-as-drawn', async () => {
  const pdf = await PDFDocument.create(),
    helvetica = await pdf.embedFont(StandardFonts.Helvetica);
  // The original font has painted every letter, so Editar can reuse it.
  const original = 'Página ¿Qué? ¡Sí! árbol, él, mí, sólo, menú, niño, pingüino';
  pdf.addPage([500, 300]).drawText(original, { x: 30, y: 220, size: 12, font: helvetica });
  const source = await pdf.save();
  const p = items(source, 1).find(item => item.kind === 'text' && item.level === 'paragraph');
  const text = `${original} NUEVO`;
  // pdf.js is what the reader's text layer, search and copy use.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const extracted = async bytes => {
    const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
    try {
      const content = await (await (await task.promise).getPage(1)).getTextContent();
      return content.items.map(item => item.str).join('');
    } finally {
      await task.destroy();
    }
  };
  for (const fields of [{ originalFont: true }, { fontName: 'Helvetica' }, { fontName: 'Times-Roman' }]) {
    const bytes = operateDocument(source, {
      operation: 'replace-text',
      page: 1,
      sourceId: p.id,
      sourceRect: p.rect,
      rect: [p.rect[0], p.rect[1], 480, p.rect[3] + 40],
      text,
      size: p.size,
      color: p.color,
      wrap: true,
      ...fields,
    });
    const read = items(bytes, 1).find(item => item.kind === 'text' && item.level === 'paragraph');
    assert.equal(read.text, text, `page-content with ${JSON.stringify(fields)}`);
    assert.equal((await extracted(bytes)).replace(/\s+/g, ' ').trim(), text, `pdf.js with ${JSON.stringify(fields)}`);
  }
  return { originalFont: true, standardFonts: true };
});

await check('images-move-turn-fade-and-copy-without-re-encoding', async () => {
  const source = new mupdf.PDFDocument(tracemonkey);
  const jpeg = source.loadPage(0).toPixmap(mupdf.Matrix.scale(0.4, 0.4), mupdf.ColorSpace.DeviceRGB, false).asJPEG(80);
  const alpha = source.loadPage(1).toPixmap(mupdf.Matrix.scale(0.3, 0.3), mupdf.ColorSpace.DeviceRGB, true).asPNG();
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([600, 800]);
  page.drawImage(await pdf.embedJpg(jpeg), { x: 40, y: 450, width: 245, height: 317 });
  page.drawImage(await pdf.embedPng(alpha), { x: 320, y: 450, width: 184, height: 238 });
  let bytes = new Uint8Array(await pdf.save());
  const streams = b => {
    const d = new mupdf.PDFDocument(b),
      r = [];
    for (let n = 1; n < d.countObjects(); n++) {
      const o = d.newIndirect(n, 0);
      if (o.isDictionary() && o.get('Subtype').asName() === 'Image') r.push(o.get('Length').asNumber());
    }
    return r.sort((x, y) => x - y);
  };
  const before = streams(bytes),
    [photo, png] = items(bytes, 1).filter(item => item.kind === 'image');
  assert(photo.editable && png.editable && png.transparent, 'A PNG with alpha is editable');
  bytes = operateDocument(bytes, {
    operation: 'move-image',
    page: 1,
    sourceId: photo.id,
    sourceRect: photo.rect,
    rect: [50, 50, 367, 295],
    rotation: 90,
  });
  const transparent = items(bytes, 1).find(item => item.transparent);
  bytes = operateDocument(bytes, {
    operation: 'move-image',
    page: 1,
    sourceId: transparent.id,
    sourceRect: transparent.rect,
    rect: [transparent.rect[0], 60, transparent.rect[2], 60 + transparent.rect[3] - transparent.rect[1]],
    opacity: 0.5,
    copy: true,
  });
  const after = items(bytes, 1).filter(item => item.kind === 'image');
  assert.equal(after.length, 3);
  assert(after.some(item => item.rotation === 90) && after.some(item => Math.abs(item.opacity - 0.5) < 0.01));
  assert.deepEqual([...new Set(streams(bytes))], [...new Set(before)], 'Image streams are reused byte for byte');
  return { rotated: true, faded: true, copied: true, reEncoded: false };
});

await check('turn-is-clockwise', async () => {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2, 1], false);
  pix.getPixels().set([255, 0, 0, 0, 0, 255]);
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 400]).drawImage(await pdf.embedPng(pix.asPNG()), { x: 100, y: 150, width: 200, height: 100 });
  let bytes = new Uint8Array(await pdf.save());
  const image = items(bytes, 1).find(item => item.kind === 'image');
  bytes = operateDocument(bytes, {
    operation: 'move-image',
    page: 1,
    sourceId: image.id,
    sourceRect: image.rect,
    rect: [150, 100, 250, 300],
    rotation: 90,
  });
  const render = new mupdf.PDFDocument(bytes)
      .loadPage(0)
      .toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false),
    at = (x, y) => [...render.getPixels().slice((y * render.getWidth() + x) * 3, (y * render.getWidth() + x) * 3 + 3)];
  assert.deepEqual(at(200, 120), [255, 0, 0], 'The left edge turns to the top');
  return { clockwise: true };
});

await check('added-drawings-do-not-nest-q-per-edit', async () => {
  const pdf = await PDFDocument.create();
  pdf
    .addPage([400, 400])
    .drawText('Base', { x: 20, y: 380, size: 10, font: await pdf.embedFont(StandardFonts.Helvetica) });
  let bytes = new Uint8Array(await pdf.save());
  for (let i = 0; i < 40; i++)
    bytes = operateDocument(bytes, {
      operation: 'add-text',
      page: 1,
      rect: [20, 20 + i * 8, 200, 28 + i * 8],
      text: `Línea ${i}`,
      size: 6,
      color: '#000000',
    });
  const doc = new mupdf.PDFDocument(bytes),
    contents = doc.findPage(0).get('Contents');
  let depth = 0,
    deepest = 0;
  for (let i = 0; i < contents.length; i++)
    for (const token of contents.get(i).readStream().asString().split(/\s+/)) {
      if (token === 'q') deepest = Math.max(deepest, ++depth);
      if (token === 'Q') depth--;
    }
  assert(deepest <= 2, `q depth ${deepest}`);
  return { additions: 40, deepest };
});

await check('shape-annotations-round-trip-move-and-restyle', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 400]);
  const blank = new Uint8Array(await pdf.save());
  const shapes = [
    {
      id: 'r1',
      page: 1,
      kind: 'shape',
      shape: 'rect',
      rect: [50, 50, 150, 120],
      color: '#d03030',
      fill: '#ffe0a0',
      strokeWidth: 2,
      opacity: 0.8,
      text: '',
      created: 1,
    },
    {
      id: 'e1',
      page: 1,
      kind: 'shape',
      shape: 'ellipse',
      rect: [200, 50, 300, 150],
      color: '#2050c0',
      fill: null,
      strokeWidth: 3,
      text: '',
      created: 1,
    },
    {
      id: 'a1',
      page: 1,
      kind: 'shape',
      shape: 'arrow',
      rect: [50, 200, 300, 300],
      line: [50, 200, 300, 300],
      color: '#000000',
      strokeWidth: 1.5,
      text: '',
      created: 1,
    },
  ];
  let read = inspectDocument(writeAnnotations(blank, shapes)).annotations;
  assert.deepEqual(
    read.map(a => [a.id, a.shape, a.fill]),
    [
      ['r1', 'rect', '#ffe0a0'],
      ['e1', 'ellipse', null],
      ['a1', 'arrow', null],
    ],
  );
  assert.deepEqual(read.find(a => a.id === 'a1').line.map(Math.round), [50, 200, 300, 300]);
  const moved = read.map(a => (a.id === 'r1' ? { ...a, rect: [100, 100, 200, 170], fill: null, strokeWidth: 4 } : a));
  read = inspectDocument(writeAnnotations(writeAnnotations(blank, shapes), moved)).annotations;
  const rect = read.find(a => a.id === 'r1');
  assert.deepEqual([rect.rect.map(Math.round), rect.fill, rect.strokeWidth], [[100, 100, 200, 170], null, 4]);
  assert.throws(() => writeAnnotations(blank, [{ ...shapes[0], shape: 'star' }]), /forma/);
  return { created: 3, movedAndRestyled: true };
});

await check('a-moved-note-keeps-its-new-place-in-the-pdf', () => {
  const blank = new mupdf.PDFDocument();
  blank.insertPage(-1, blank.addPage([0, 0, 595, 842], 0, {}, ''));
  const note = {
    id: 'n1',
    page: 1,
    kind: 'note',
    rect: [100, 700, 100, 700],
    color: '#8bbaf0',
    text: 'Mover',
    created: 1,
  };
  const written = writeAnnotations(blank.saveToBuffer('').asUint8Array(), [note]);
  const moved = inspectDocument(writeAnnotations(written, [{ ...note, rect: [300, 400, 300, 400] }])).annotations.find(
    a => a.id === 'n1',
  );
  assert.deepEqual(moved.rect.map(Math.round), [300, 400, 300, 400]);
  return { moved: true };
});

await check('pdf-drawings-move-recolour-copy-and-remove-in-place', () => {
  const doc = new mupdf.PDFDocument(),
    font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  doc.insertPage(
    -1,
    doc.addPage(
      [0, 0, 595, 842],
      0,
      { Font: { F1: font } },
      [
        '1 1 1 rg 0 0 595 842 re f', // the page's background is not listed
        'q .48 .18 .36 rg 100 600 120 30 re f Q', // a badge's fill…
        '.3 .1 .2 RG',
        'q 2 w 100 600 120 30 re S Q', // …and its border: one drawing
        'BT /F1 12 Tf 1 1 1 rg 110 610 Td (Dolor) Tj ET', // its label, above it
        '0 0 0 RG 1 w 50 500 m 300 500 l S', // a lone rule
      ].join('\n'),
    ),
  );
  const bytes = doc.saveToBuffer('').asUint8Array();
  const drawings = value =>
    operateDocument(value, { operation: 'page-content', page: 1, graphics: true }).items.filter(
      item => item.kind === 'graphic',
    );
  const label = value =>
    glyphs(value, 0)
      .map(g => [g.c, Math.round(g.x), Math.round(g.y)])
      .join();
  const found = drawings(bytes),
    badge = found.find(item => item.fill);
  assert.equal(found.length, 2, JSON.stringify(found));
  assert.deepEqual([badge.rect.map(Math.round), badge.fill, badge.stroke], [[99, 599, 221, 631], '#7a2e5c', '#4d1a33']);
  assert.equal(
    operateDocument(bytes, { operation: 'page-content', page: 1 }).items.filter(item => item.kind === 'graphic').length,
    0,
    'Listed only when asked',
  );
  const edit = (operation, extra = {}) =>
    operateDocument(bytes, {
      operation,
      page: 1,
      sourceId: badge.id,
      sourceRect: badge.rect,
      rect: badge.rect,
      ...extra,
    });
  const moved = drawings(
    edit('move-graphic', { rect: [badge.rect[0] + 100, badge.rect[1] - 50, badge.rect[2] + 100, badge.rect[3] - 50] }),
  );
  assert(
    moved.some(
      item =>
        item.fill &&
        Math.abs(item.rect[0] - badge.rect[0] - 100) < 0.1 &&
        Math.abs(item.rect[1] - badge.rect[1] + 50) < 0.1,
    ),
    'Fill and border moved together',
  );
  assert.equal(
    label(edit('move-graphic', { rect: [badge.rect[0] + 100, badge.rect[1], badge.rect[2] + 100, badge.rect[3]] })),
    label(bytes),
    'Text stays',
  );
  const recoloured = edit('recolor-graphic', { fill: '#00ff00' });
  assert.deepEqual(
    drawings(recoloured)
      .map(item => [item.fill, item.stroke])
      .find(([fill]) => fill),
    ['#00ff00', '#4d1a33'],
  );
  assert.equal(
    drawings(
      edit('move-graphic', {
        rect: [badge.rect[0], badge.rect[1] - 100, badge.rect[2], badge.rect[3] - 100],
        copy: true,
      }),
    ).length,
    3,
  );
  const removed = edit('remove-graphic');
  assert.deepEqual([drawings(removed).length, label(removed)], [1, label(bytes)]);
  assert.throws(
    () =>
      operateDocument(bytes, {
        operation: 'remove-graphic',
        page: 1,
        sourceId: badge.id,
        sourceRect: [0, 0, 10, 10],
        rect: [0, 0, 10, 10],
      }),
    /selección cambió/,
  );
  return { listed: 2, movedTogether: true, recoloured: true, copied: true, removed: true, textKept: true };
});

await check('a-live-document-takes-changes-in-place-and-undoes-them', () => {
  // As session.worker.ts does: one open document, each change a journal step,
  // written with garbage=1 (deeper collection renumbers objects and breaks the journal).
  const doc = open(tracemonkey);
  doc.enableJournal();
  const write = () => {
    const buffer = doc.saveToBuffer('garbage=1,compress=yes,encrypt=keep');
    try {
      return new Uint8Array(buffer.asUint8Array());
    } finally {
      buffer.destroy();
    }
  };
  const step = options => {
    doc.beginOperation(`${options.operation}:${options.page}`);
    try {
      editDocument(doc, options);
      doc.endOperation();
    } catch (error) {
      doc.abandonOperation();
      throw error;
    }
  };
  const layout = bytes =>
    [1, 2]
      .map(page =>
        paragraphs(bytes, page)
          .map(p => `${p.text.slice(0, 12)}@${p.rect.map(Math.round)}`)
          .join('|'),
      )
      .join('\n');
  const [title] = paragraphs(tracemonkey, 1),
    r = title.rect;
  const move = {
    operation: 'move-text',
    page: 1,
    sourceId: title.id,
    sourceRect: r,
    rect: [r[0] + 40, r[1] - 10, r[2] + 40, r[3] - 10],
  };
  step(move);
  const moved = write();
  assert.equal(layout(moved), layout(operateDocument(tracemonkey, move)), 'Same result as writing the change at once');
  // The next change reads the page as it is now.
  const [second] = paragraphs(moved, 2);
  step({ operation: 'remove-content', page: 2, id: second.id, kind: 'text', rect: second.rect });
  const removed = write();
  assert(!paragraphs(removed, 2).some(p => p.text === second.text), 'Removed from the live page');
  // A change refused by its checks, or abandoned halfway, leaves the document as it was.
  assert.throws(() => step(move), /selección cambió/);
  doc.beginOperation('plate');
  const plate = pagePlate(doc, {
    operation: 'page-plate',
    page: 1,
    id: paragraphs(removed, 1)[1].id,
    kind: 'text',
    rect: paragraphs(removed, 1)[1].rect,
    scale: 1,
  });
  doc.abandonOperation();
  assert(plate.png.length > 100, 'A plate is drawn');
  assert.deepEqual([layout(write()), doc.getJournal().position], [layout(removed), 2]);
  doc.undo();
  doc.undo();
  assert.equal(layout(write()), layout(tracemonkey), 'Undone in the journal');
  doc.redo();
  assert.equal(layout(write()), layout(moved), 'Redone');
  doc.destroy();
  return { inPlace: true, sameAsOneShot: true, failedChangeKept: false, undoRedo: true };
});

await check('sprites-draw-one-item-alone-without-changing-the-document', () => {
  // A badge (fill and border) with a white label above it, a rule, and a paragraph.
  const doc = new mupdf.PDFDocument(),
    font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  doc.insertPage(
    -1,
    doc.addPage(
      [0, 0, 595, 842],
      0,
      { Font: { F1: font } },
      [
        'q .48 .18 .36 rg 100 600 120 30 re f Q',
        '.3 .1 .2 RG',
        'q 2 w 100 600 120 30 re S Q',
        'BT /F1 12 Tf 1 1 1 rg 110 610 Td (Dolor) Tj ET',
        '0 0 0 RG 1 w 50 500 m 300 500 l S',
        'BT /F1 14 Tf 0 0 0 rg 60 760 Td (Informe trimestral) Tj ET',
      ].join('\n'),
    ),
  );
  const bytes = doc.saveToBuffer('').asUint8Array(),
    live = open(bytes);
  const found = operateDocument(bytes, { operation: 'page-content', page: 1, graphics: true }).items;
  const badge = found.find(item => item.kind === 'graphic' && item.fill),
    title = found.find(item => item.level === 'paragraph' && item.text.startsWith('Informe'));
  // The pixel at a PDF point of a sprite drawn at scale 2: [r, g, b, alpha].
  const pixels = sprite => {
    const pixmap = new mupdf.Image(sprite.png).toPixmap(),
      n = pixmap.getStride() / pixmap.getWidth();
    return {
      pixmap,
      at: (x, y) => {
        const px = Math.round((x - sprite.rect[0]) * 2),
          py = Math.round((sprite.rect[3] - y) * 2);
        return [...pixmap.getPixels().slice(py * pixmap.getStride() + px * n, py * pixmap.getStride() + px * n + n)];
      },
    };
  };

  const text = pixels(itemSprite(live, { page: 1, id: title.id, kind: 'text', rect: title.rect, scale: 2 }));
  assert.equal(text.at(title.rect[0] - 2, title.rect[1] - 2).at(-1), 0, 'Transparent around the text');
  assert(
    text.pixmap.getPixels().some((value, i) => i % 4 === 3 && value === 255),
    'Opaque on its glyphs',
  );
  const shape = pixels(itemSprite(live, { page: 1, id: badge.id, kind: 'graphic', rect: badge.rect, scale: 2 }));
  const close = (actual, expected) =>
    actual.length === expected.length && actual.every((value, i) => Math.abs(value - expected[i]) <= 1);
  assert(close(shape.at(115, 615), [122, 46, 92, 255]), 'The badge alone: its fill where the label was');
  assert.equal(shape.at(96.5, 596.5).at(-1), 0, 'Transparent around it');
  const recoloured = pixels(
    itemSprite(live, { page: 1, id: badge.id, kind: 'graphic', rect: badge.rect, scale: 2, fill: '#00ff00' }),
  );
  assert.deepEqual(recoloured.at(160, 615), [0, 255, 0, 255], 'Shown in its new colour');
  const after = readPage(live, { operation: 'page-content', page: 1, graphics: true }).items;
  assert.deepEqual(
    after.map(item => [item.id, item.fill]),
    found.map(item => [item.id, item.fill]),
    'The document is unchanged',
  );
  // An image keeps its pixels and its transparency.
  const swatch = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 4], true);
  swatch.clear();
  for (let i = 0; i < 8; i++) swatch.getPixels().set([200, 30, 30, 255], i * 4);
  const pictured = new mupdf.PDFDocument(),
    image = pictured.addImage(new mupdf.Image(swatch));
  pictured.insertPage(
    -1,
    pictured.addPage([0, 0, 300, 300], 0, { XObject: { Im: image } }, 'q 100 0 0 100 50 50 cm /Im Do Q'),
  );
  const picture = open(pictured.saveToBuffer('').asUint8Array()),
    item = readPage(picture, { operation: 'page-content', page: 1 }).items.find(entry => entry.kind === 'image');
  const drawn = pixels(itemSprite(picture, { page: 1, id: item.id, kind: 'image', rect: item.rect, scale: 2 }));
  assert.deepEqual(
    [drawn.at(100, 140), drawn.at(100, 60).at(-1)],
    [[200, 30, 30, 255], 0],
    'Its colour, and transparent where it is',
  );
  return { text: true, drawingAlone: true, recolouredPreview: true, image: true, documentUnchanged: true };
});

await check('several-items-change-as-one-step', () => {
  const doc = open(tracemonkey);
  doc.enableJournal();
  const write = () => {
    const buffer = doc.saveToBuffer('garbage=1,compress=yes,encrypt=keep');
    try {
      return new Uint8Array(buffer.asUint8Array());
    } finally {
      buffer.destroy();
    }
  };
  // Two paragraphs of the left column, one above the other, moved right together.
  const [a, b] = ['Abstract', 'Dynamic languag'].map(start =>
    readPage(doc, { operation: 'page-content', page: 1 }).items.find(
      item => item.level === 'paragraph' && item.text.startsWith(start),
    ),
  );
  const moves = [a, b].map(p => ({
    operation: 'move-text',
    page: 1,
    sourceId: p.id,
    sourceRect: p.rect,
    rect: [p.rect[0] + 10, p.rect[1], p.rect[2] + 10, p.rect[3]],
  }));
  doc.beginOperation('batch:1');
  editDocumentAll(doc, moves);
  doc.endOperation();
  let bytes = write();
  for (const [p, start] of [
    [a, 'Abstract'],
    [b, 'Dynamic languag'],
  ]) {
    // At the same height (re-emitted glyphs give a slightly different line box).
    const moved = items(bytes, 1).find(
      item =>
        item.level === 'paragraph' &&
        item.text.startsWith(start) &&
        Math.abs(item.rect[1] + item.rect[3] - p.rect[1] - p.rect[3]) < 6,
    );
    assert(moved && Math.abs(moved.rect[0] - p.rect[0] - 10) < 0.5, `${start} moved: ${moved?.rect}`);
  }
  // One step undoes both; a batch with one item that is gone changes nothing.
  doc.undo();
  bytes = write();
  assert.equal(items(bytes, 1).find(item => item.text?.startsWith('Abstract')).rect[0], a.rect[0]);
  const gone = { ...moves[1], sourceRect: [1, 1, 20, 20] };
  doc.beginOperation('batch:1');
  assert.throws(() => editDocumentAll(doc, [moves[0], gone]), /selección cambió/);
  doc.abandonOperation();
  assert.equal(
    items(write(), 1).find(item => item.text?.startsWith('Abstract')).rect[0],
    a.rect[0],
    'Nothing half done',
  );
  doc.destroy();
  return { movedTogether: 2, oneUndo: true, atomic: true };
});

await check('moved-text-lands-exactly-and-reads-the-same', () => {
  // A long line in an embedded font with a little extra space between letters,
  // as browsers print. Written back as one run, its glyphs drifted along the line.
  const face = new mupdf.Font('DM Sans', fs.readFileSync('public/fonts/dm-sans-regular.ttf')),
    doc = new mupdf.PDFDocument();
  const line = 'Armado a partir de las notas (guía de alumnos, Farreras y cuadros resumen), con dudas del banco.';
  const codes = [...line].map(c => face.encodeCharacter(c.codePointAt(0)).toString(16).padStart(4, '0')).join('');
  doc.insertPage(
    -1,
    doc.addPage(
      [0, 0, 595, 842],
      0,
      { Font: { F1: doc.addFont(face) } },
      `BT /F1 7 Tf 0.0137 Tc 30 742 Td <${codes}> Tj ET`,
    ),
  );
  const bytes = doc.saveToBuffer('').asUint8Array(),
    [item] = items(bytes, 1).filter(entry => entry.level === 'paragraph');
  assert.equal(item.text, line);
  const r = item.rect,
    moved = operateDocument(bytes, {
      operation: 'move-text',
      page: 1,
      sourceId: item.id,
      sourceRect: r,
      rect: [r[0] + 10, r[1] - 40, r[2] + 10, r[3] - 40],
    });
  const before = glyphs(bytes, 0),
    after = glyphs(moved, 0);
  for (const glyph of before)
    assert(
      after.some(g => g.c === glyph.c && Math.abs(g.x - glyph.x - 10) < 0.02 && Math.abs(g.y - glyph.y - 40) < 0.02),
      `${glyph.c} at its place`,
    );
  assert(
    items(moved, 1).some(entry => entry.level === 'paragraph' && entry.text === line),
    'Reads the same, parentheses included',
  );
  return { glyphs: before.length, exact: true };
});

await check('text-folio-wrote-moves-again-over-other-text', async () => {
  // A paragraph moved onto another cell's text, as in a table, is still Folio's own block.
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([595, 842]);
  ['Interpreta sus efectos', 'farmacológicos'].forEach((line, i) =>
    page.drawText(line, { x: 60, y: 700 - i * 16, size: 12, font }),
  );
  page.drawText('Discusión de casos', { x: 150, y: 660, size: 12, font });
  let bytes = new Uint8Array(await pdf.save());
  const block = items(bytes, 1).find(item => item.level === 'paragraph' && item.text.startsWith('Interpreta')),
    r = block.rect;
  bytes = operateDocument(bytes, {
    operation: 'move-text',
    page: 1,
    sourceId: block.id,
    sourceRect: r,
    rect: [r[0] + 90, r[1] - 30, r[2] + 90, r[3] - 30],
  });
  const own = items(bytes, 1).find(
    item => item.level === 'paragraph' && item.text === 'Interpreta sus efectos\nfarmacológicos',
  );
  assert(
    own?.editable,
    `Offered alone and editable: ${JSON.stringify(
      items(bytes, 1)
        .filter(item => item.level === 'paragraph')
        .map(item => [item.id, item.text, item.editable]),
    )}`,
  );
  const copied = operateDocument(bytes, {
    operation: 'move-text',
    page: 1,
    sourceId: own.id,
    sourceRect: own.rect,
    rect: [own.rect[0], own.rect[1] - 200, own.rect[2], own.rect[3] - 200],
    copy: true,
  });
  assert.equal(
    items(copied, 1).filter(item => item.level === 'paragraph' && item.text.endsWith('farmacológicos')).length >= 2,
    true,
    'Copied',
  );
  bytes = operateDocument(bytes, {
    operation: 'move-text',
    page: 1,
    sourceId: own.id,
    sourceRect: own.rect,
    rect: [own.rect[0] - 90, own.rect[1] + 30, own.rect[2] - 90, own.rect[3] + 30],
  });
  const back = items(bytes, 1).find(item => item.level === 'paragraph' && item.text.startsWith('Interpreta')),
    cell = items(bytes, 1).find(item => item.level === 'paragraph' && item.text === 'Discusión de casos');
  assert(Math.abs(back.rect[0] - r[0]) < 0.5 && Math.abs(back.rect[1] - r[1]) < 0.5, `Back in place: ${back.rect}`);
  assert(cell?.editable && Math.abs(cell.rect[0] - 150) < 1, 'The other text untouched and editable again');
  const removed = operateDocument(bytes, {
    operation: 'remove-content',
    page: 1,
    id: back.id,
    kind: 'text',
    rect: back.rect,
  });
  assert(
    !items(removed, 1).some(item => item.text?.startsWith('Interpreta')) &&
      items(removed, 1).some(item => item.text === 'Discusión de casos'),
    'Removed alone',
  );
  return { overOtherText: true, movedBack: true, copied: true, removed: true };
});

for (const result of results) console.log(JSON.stringify(result));
process.exitCode = results.some(result => result.status !== 'passed') ? 1 : 0;
