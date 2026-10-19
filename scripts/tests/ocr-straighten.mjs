// Straightening before OCR: tilted and curved pages come out straight, a straight
// page is left alone, and the engine writes the turned or flattened page.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shrink, inkMask, skewAngle, marginTilt, traceLines, flattenField, flatten } from '../../src/straighten.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const mupdf = await import(pathToFileURL(require.resolve('mupdf')).href);
const { operateDocument } = await import(pathToFileURL(path.join(root, 'src/engine/operations.ts')).href);
const results = [];
const check = async (id, run) => {
  results.push({ id, ...(await run()) });
};

// A page of "words": dark dashes along lines y(x), as a scanner sees them.
function page(width, height, lineY) {
  const data = new Uint8ClampedArray(width * height * 3).fill(255);
  for (let k = 0; k * 34 + 120 < height - 120; k++)
    for (let x = 90; x < width - 90; x++) {
      if (Math.floor(x / 23) % 6 === 5) continue; // gaps between words
      const y = Math.round(lineY(k, x));
      for (let dy = -5; dy <= 5; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < height) data.fill(30, (yy * width + x) * 3, (yy * width + x) * 3 + 3);
      }
    }
  return { data, width, height, channels: 3 };
}
const analyse = pixels => {
  const sample = shrink(pixels);
  return { sample, mask: inkMask(sample) };
};
// How far the traced lines stray from straight and level, in sample pixels.
function crookedness(pixels) {
  const { sample, mask } = analyse(pixels),
    { lines } = traceLines(mask, sample.width, sample.height);
  assert(lines.length >= 4, `lines traced: ${lines.length}`);
  return Math.max(
    ...lines.map(({ fit }) => {
      const u = [-0.4, -0.2, 0, 0.2, 0.4].map(t => fit[0] + t * (fit[1] + t * (fit[2] + t * fit[3])));
      return Math.max(...u) - Math.min(...u);
    }),
  );
}

await check('a-straight-page-is-left-alone', () => {
  const straight = page(1200, 1600, k => 120 + k * 34),
    { sample, mask } = analyse(straight);
  assert.equal(skewAngle(mask, sample.width, sample.height), 0);
  assert.equal(flattenField(mask, sample.width, sample.height), null);
  return { angle: 0, flattened: false };
});

await check('a-tilted-page-reads-its-angle-and-sign', () => {
  const found = [];
  for (const degrees of [3, -2.4, 7]) {
    const t = Math.tan((degrees * Math.PI) / 180);
    // Rising to the right in an image means y shrinks as x grows.
    const { sample, mask } = analyse(page(1200, 1600, (k, x) => 300 + k * 34 - (x - 600) * t));
    const angle = skewAngle(mask, sample.width, sample.height);
    assert(Math.abs(angle - degrees) <= 0.15, `${degrees}° read as ${angle}°`);
    found.push(angle);
  }
  return { found };
});

await check('curved-lines-come-out-straight', () => {
  // Like a book near its spine: lines bow more towards the right edge.
  const curved = page(1500, 2000, (k, x) => 140 + k * 34 + 46 * ((x - 90) / 1320) ** 3 - 10 * Math.sin(x / 400));
  const before = crookedness(curved);
  const { sample, mask } = analyse(curved),
    field = flattenField(mask, sample.width, sample.height);
  assert(field, 'a curved page needs flattening');
  const flat = { ...curved, data: flatten(curved, field, 1 / sample.scale) };
  const after = crookedness(flat);
  assert(after < 2.5 && after < before / 4, `crookedness ${before.toFixed(1)} → ${after.toFixed(1)}`);
  return { before: +before.toFixed(1), after: +after.toFixed(1) };
});

await check('a-photo-is-not-taken-for-lines-of-text', () => {
  // A micrograph above a short caption: its blobs line up across strips by chance,
  // which once turned and warped the page. Nothing in it may count as a line.
  const sheet = page(1500, 2000, k => (k < 48 ? -100 : 1700 + (k - 48) * 34)),
    { data, width } = sheet;
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 150; y < 1550; y++)
    for (let x = 90; x < 1410; x++) data.fill(150, (y * width + x) * 3, (y * width + x) * 3 + 3);
  for (let n = 0; n < 4000; n++) {
    const cx = 100 + random() * 1300,
      cy = 160 + random() * 1380,
      r = 4 + random() * 14;
    for (let y = Math.round(cy - r); y <= cy + r; y++)
      for (let x = Math.round(cx - r); x <= cx + r; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) data.fill(40, (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  const { sample, mask } = analyse(sheet),
    { lines } = traceLines(mask, sample.width, sample.height);
  const inPhoto = lines.filter(({ fit }) => fit[0] < 1560 * sample.scale).length;
  assert.equal(inPhoto, 0, `lines traced in the photo: ${inPhoto}`);
  assert.equal(flattenField(mask, sample.width, sample.height), null);
  assert.equal(marginTilt(mask, sample.width, sample.height), null);
  return { lines: lines.length, inPhoto };
});

await check('two-columns-out-of-step-are-not-a-curve', () => {
  // A flat table or two-column page whose right column's rows sit up or down from the
  // left's, by a different amount on each row (headings, paragraphs, subscripts): a
  // trace that slides from one column's row to the other's is no curve of the page.
  const sheet = page(1500, 2000, (k, x) => 140 + k * 34 + (x > 760 ? (((k * 7) % 5) - 2) * 5 : 0)),
    { sample, mask } = analyse(sheet);
  assert.equal(flattenField(mask, sample.width, sample.height), null);
  return { flattened: false };
});

// Turned clockwise by `degrees` about the centre, smoothly, as the canvas does it.
function turned({ data, width: w, height: h, channels: n }, degrees) {
  const t = (degrees * Math.PI) / 180,
    c = Math.cos(t),
    s = Math.sin(t),
    out = new Uint8ClampedArray(data.length).fill(255);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2,
        dy = y - h / 2,
        fx = c * dx + s * dy + w / 2,
        fy = -s * dx + c * dy + h / 2,
        x0 = Math.floor(fx),
        y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const ax = fx - x0,
        ay = fy - y0;
      for (let k = 0; k < n; k++) {
        const at = (xx, yy) => data[(yy * w + xx) * n + k];
        out[(y * w + x) * n + k] =
          (at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax) * (1 - ay) +
          (at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax) * ay;
      }
    }
  return { data: out, width: w, height: h, channels: n };
}

await check('a-curved-and-turned-page-takes-its-turn-from-the-margin', () => {
  // Bowed lines on a sheet lying 2° anticlockwise: the curve pulls the projection
  // angle, the left margin gives the true turn back (clockwise 2°).
  const sheet = turned(
    page(
      1500,
      2000,
      (k, x) => 140 + k * 34 + 120 * ((x - 90) / 1320) ** 4 + 25 * Math.sin((Math.PI * (x - 90)) / 1320),
    ),
    -2,
  );
  let { sample, mask } = analyse(sheet);
  const pulled = skewAngle(mask, sample.width, sample.height);
  ({ sample, mask } = analyse(turned(sheet, pulled)));
  assert(flattenField(mask, sample.width, sample.height), 'still curved after the first turn');
  const total = pulled + marginTilt(mask, sample.width, sample.height);
  assert(Math.abs(total - 2) <= 0.3, `turned ${total}° instead of 2°`);
  const upright = turned(sheet, total),
    fixed = analyse(upright),
    field = flattenField(fixed.mask, fixed.sample.width, fixed.sample.height);
  const after = crookedness({ ...upright, data: flatten(upright, field, 1 / fixed.sample.scale) });
  assert(after < 3, `crookedness after ${after.toFixed(1)}`);
  return { pulled, total: +total.toFixed(2), after: +after.toFixed(1) };
});

// The engine side: a PDF page whose text rises 4° is turned straight in place,
// and a flattened image replaces a page with the OCR words where it put them.
const tiltedPdf = () => {
  const doc = new mupdf.PDFDocument(),
    font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const t = (4 * Math.PI) / 180,
    lines = [];
  for (let k = 0; k < 28; k++)
    lines.push(
      `BT /F1 11 Tf 70 ${720 - k * 22} Td (${'Farmacologia clinica de los antimicrobianos y sus efectos '.repeat(1)}) Tj ET`,
    );
  const content = `q ${Math.cos(t)} ${Math.sin(t)} ${-Math.sin(t)} ${Math.cos(t)} ${306 - 306 * Math.cos(t) + 396 * Math.sin(t)} ${396 - 306 * Math.sin(t) - 396 * Math.cos(t)} cm ${lines.join('\n')} Q`;
  const resources = doc.newDictionary(),
    fonts = doc.newDictionary();
  fonts.put('F1', font);
  resources.put('Font', fonts);
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, content));
  return new Uint8Array(doc.saveToBuffer('compress=yes').asUint8Array());
};
const angleOf = bytes => {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf'),
    page = doc.loadPage(0),
    pixmap = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false);
  try {
    const { sample, mask } = analyse({
      data: pixmap.getPixels(),
      width: pixmap.getWidth(),
      height: pixmap.getHeight(),
      channels: 3,
    });
    return skewAngle(mask, sample.width, sample.height);
  } finally {
    pixmap.destroy();
    page.destroy();
    doc.destroy();
  }
};

await check('the-engine-turns-a-tilted-page-straight', () => {
  const original = tiltedPdf(),
    before = angleOf(original);
  assert(Math.abs(before - 4) <= 0.2, `read ${before}°`);
  const turned = operateDocument(original, {
    operation: 'ocr',
    pages: [{ page: 1, angle: before, words: [{ text: 'Farmacologia', rect: [70, 712, 140, 724] }] }],
  });
  const after = angleOf(turned);
  assert.equal(after, 0, `still ${after}° after turning`);
  return { before, after };
});

await check('the-engine-puts-a-flattened-image-in-place-of-the-page', () => {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 850, 1100], false);
  pixmap.clear(255);
  const png = pixmap.asPNG();
  pixmap.destroy();
  // A rotated page: the image shows it as seen, so it becomes an upright page of that size.
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 792, 612], 90, doc.newDictionary(), 'BT ET'));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  const out = operateDocument(bytes, {
    operation: 'ocr',
    pages: [{ page: 1, image: png, size: [612, 792], words: [{ text: 'Recto', rect: [100, 700, 160, 715] }] }],
  });
  const read = mupdf.Document.openDocument(out, 'application/pdf'),
    result = read.loadPage(0);
  try {
    assert.deepEqual(result.getBounds().map(Math.round), [0, 0, 612, 792]);
    let box = null;
    const text = result.toStructuredText();
    text.walk({
      onChar: (c, origin, font, size, quad) => {
        if (!box) box = quad;
      },
    });
    text.destroy();
    assert(box && Math.abs(box[0] - 100) < 2 && Math.abs(box[1] - (792 - 715)) < 4, `word at ${box}`);
    const images = [];
    result.toStructuredText('preserve-images').walk({ onImageBlock: bbox => images.push(bbox.map(Math.round)) });
    assert.deepEqual(images[0], [0, 0, 612, 792]);
  } finally {
    result.destroy();
    read.destroy();
  }
  return { upright: true, wordInPlace: true };
});

for (const result of results) console.log(JSON.stringify({ ...result, status: 'passed' }));
