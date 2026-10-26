// Comprimir PDF: what each level changes, what it must never change, and the documents
// it must survive (encrypted, forms, shared and masked images, CMYK, 16-bit, indexed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as mupdf from 'mupdf';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { operateDocument } from '../../src/engine/operations.ts';
import { COMPRESSION_PRESETS } from '../../src/engine/compression-settings.ts';
import {
  jpegQuality,
  resample,
  sampleScale,
  fewColours,
  loadImage,
  loadKeepsTwice,
} from '../../src/engine/compress.ts';

fs.mkdirSync('test-results', { recursive: true });
const results = [];
async function check(id, test) {
  try {
    results.push({ id, status: 'passed', ...(await test()) });
  } catch (error) {
    results.push({ id, status: 'failed', error: error.stack });
    process.exitCode = 1;
  }
  console.log(JSON.stringify(results.at(-1)));
}

// A photograph-like image: smooth light, edges and grain, from a fixed seed.
let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
function photo(width, height, n) {
  const samples = new Uint8Array(width * height * n);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < n; c++)
        samples[(y * width + x) * n + c] = Math.max(
          0,
          Math.min(
            255,
            128 + 90 * Math.sin(x / (37 + 9 * c) + c) * Math.cos(y / 53) + (x > width / 2 ? 30 : -20) + random() * 24,
          ),
        );
  return samples;
}
const spaces = { 1: mupdf.ColorSpace.DeviceGray, 3: mupdf.ColorSpace.DeviceRGB, 4: mupdf.ColorSpace.DeviceCMYK };
const names = { 1: 'DeviceGray', 3: 'DeviceRGB', 4: 'DeviceCMYK' };
/** An image object written as the producer chose: raw samples (Flate) or a JPEG. */
function addImage(doc, { width, height, n = 3, samples = photo(width, height, n), jpeg, bpc = 8, extra = {} }) {
  const dict = doc.newDictionary();
  dict.put('Type', doc.newName('XObject'));
  dict.put('Subtype', doc.newName('Image'));
  dict.put('Width', width);
  dict.put('Height', height);
  dict.put('BitsPerComponent', bpc);
  dict.put('ColorSpace', doc.newName(names[n]));
  for (const [key, value] of Object.entries(extra)) dict.put(key, value);
  if (jpeg) {
    const pixmap = new mupdf.Pixmap(spaces[n], [0, 0, width, height], false);
    pixmap.getPixels().set(samples);
    dict.put('Filter', doc.newName('DCTDecode'));
    return doc.addRawStream(pixmap.asJPEG(jpeg, false), dict);
  }
  return doc.addStream(samples, dict);
}
function page(doc, size, images, content) {
  const resources = doc.newDictionary(),
    xobjects = doc.newDictionary();
  for (const [name, ref] of Object.entries(images)) xobjects.put(name, ref);
  resources.put('XObject', xobjects);
  doc.insertPage(-1, doc.addPage([0, 0, ...size], 0, resources, content));
}
const save = doc => new Uint8Array(doc.saveToBuffer('compress=yes').asUint8Array());
const compress = (bytes, level, password) =>
  operateDocument(bytes, { operation: 'compress', settings: COMPRESSION_PRESETS[level] }, password);
const images = bytes => {
  const doc = new mupdf.PDFDocument(bytes),
    found = {};
  for (let num = 1; num < doc.countObjects(); num++) {
    const ref = doc.newIndirect(num);
    if (!ref.isStream()) continue;
    const dict = ref.resolve();
    if (dict.get('Subtype').toString() !== '/Image') continue;
    const name = dict.get('Name').isNull() ? String(num) : dict.get('Name').asName();
    found[name] = {
      width: dict.get('Width').asNumber(),
      height: dict.get('Height').asNumber(),
      filter: dict.get('Filter').toString(),
      space: dict.get('ColorSpace').toString(),
      bpc: dict.get('BitsPerComponent').asNumber(),
      mask: dict.get('SMask').isNull()
        ? null
        : { width: dict.get('SMask').get('Width').asNumber(), height: dict.get('SMask').get('Height').asNumber() },
    };
  }
  return found;
};
const render = (bytes, index, dpi = 72, password = '') => {
  const doc = new mupdf.PDFDocument(bytes);
  if (password) doc.authenticatePassword(password);
  const pixmap = doc
    .loadPage(index)
    .toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false);
  return new Uint8Array(pixmap.getPixels());
};
const psnr = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return sum ? 10 * Math.log10((255 * 255 * a.length) / sum) : Infinity;
};
const pages = bytes => new mupdf.PDFDocument(bytes).countPages();

// Page 1: one photo shown 6 in wide and the same object again 1 in wide; a masked photo; a flat chart.
// Page 2: CMYK, 16-bit and gray JPEG photos. Page 3: what must stay untouched (indexed, 1-bit, a small icon).
const doc = new mupdf.PDFDocument();
const named = (name, options) => addImage(doc, { ...options, extra: { ...options.extra, Name: doc.newName(name) } });
const shared = named('shared', { width: 2400, height: 1600 });
const mask = addImage(doc, { width: 1200, height: 1200, n: 1, samples: photo(1200, 1200, 1) });
const masked = named('masked', { width: 1200, height: 1200, extra: { SMask: mask } });
const chart = new Uint8Array(1800 * 1200 * 3);
for (let i = 0; i < chart.length / 3; i++) chart.set((i % 1800) % 300 < 150 ? [30, 90, 200] : [250, 250, 250], i * 3);
const flat = named('chart', { width: 1800, height: 1200, samples: chart });
page(
  doc,
  [612, 792],
  { A: shared, B: masked, C: flat },
  'q 432 0 0 288 90 480 cm /A Do Q q 72 0 0 48 20 20 cm /A Do Q q 144 0 0 144 400 300 cm /B Do Q q 216 0 0 144 90 300 cm /C Do Q',
);
const cmyk = named('cmyk', { width: 1600, height: 1200, n: 4 });
const deep = named('deep', {
  width: 900,
  height: 600,
  bpc: 16,
  samples: (() => {
    const eight = photo(900, 600, 3),
      sixteen = new Uint8Array(eight.length * 2);
    for (let i = 0; i < eight.length; i++) sixteen[i * 2] = eight[i];
    return sixteen;
  })(),
});
const grayJpeg = named('gray-jpeg', { width: 2000, height: 1500, n: 1, jpeg: 95 });
page(
  doc,
  [612, 792],
  { A: cmyk, B: deep, C: grayJpeg },
  'q 216 0 0 162 40 560 cm /A Do Q q 180 0 0 120 300 560 cm /B Do Q q 288 0 0 216 40 200 cm /C Do Q',
);
const palette = doc.newByteString(Array.from({ length: 256 * 3 }, (_, i) => (i * 37) & 255));
const indexed = named('indexed', {
  width: 1600,
  height: 1600,
  n: 1,
  samples: photo(1600, 1600, 1),
  extra: {
    ColorSpace: (() => {
      const space = doc.newArray();
      space.push(doc.newName('Indexed'));
      space.push(doc.newName('DeviceRGB'));
      space.push(255);
      space.push(palette);
      return space;
    })(),
  },
});
const bits = named('bilevel', { width: 2400, height: 2400, n: 1, bpc: 1, samples: photo(300, 2400, 1) });
const icon = named('icon', { width: 64, height: 64 });
page(
  doc,
  [612, 792],
  { A: indexed, B: bits, C: icon },
  'q 72 0 0 72 40 600 cm /A Do Q q 72 0 0 72 200 600 cm /B Do Q q 72 0 0 72 400 600 cm /C Do Q',
);
const source = save(doc);
fs.writeFileSync('test-results/compress-source.pdf', source);

await check('lossless-keeps-every-page-and-image-identical', () => {
  const output = compress(source, 'lossless');
  for (let index = 0; index < 3; index++) assert.deepEqual(render(output, index), render(source, index));
  assert.deepEqual(images(output), images(source));
  // The previous call shape (no settings) still means lossless.
  assert.deepEqual(render(operateDocument(source, { operation: 'compress' }), 0), render(source, 0));
  return { from: source.length, to: output.length };
});

await check('balanced-resamples-to-the-largest-use-and-keeps-what-must-stay', () => {
  const output = compress(source, 'balanced'),
    before = images(source),
    after = images(output);
  fs.writeFileSync('test-results/compress-balanced.pdf', output);
  assert(output.length < source.length / 4, `${output.length} of ${source.length}`);
  assert.equal(pages(output), 3);
  // Shown 6 in wide at most: 1200 px at 200 ppp, not the 200 px its small copy needs.
  assert.deepEqual([after.shared.width, after.shared.height], [1200, 800]);
  assert.equal(after.shared.filter, '/DCTDecode');
  // The mask follows its image, losslessly.
  assert.deepEqual(after.masked.mask, { width: after.masked.width, height: after.masked.height });
  assert.equal(after.masked.width, 400);
  // Flat artwork keeps sharp edges: fewer pixels, never JPEG.
  assert.notEqual(after.chart.filter, '/DCTDecode');
  assert.equal(after.chart.width, 600);
  // CMYK stays CMYK (print colours); 16-bit becomes 8-bit.
  assert.equal(after.cmyk.space, '/DeviceCMYK');
  assert.equal(after.deep.bpc, 8);
  // Left exactly as they were.
  for (const name of ['indexed', 'bilevel', 'icon']) assert.deepEqual(after[name], before[name], name);
  for (let index = 0; index < 3; index++) {
    const value = psnr(render(source, index, 100), render(output, index, 100));
    assert(value > 30, `page ${index + 1}: ${value.toFixed(1)} dB`);
  }
  return { from: source.length, to: output.length };
});

await check('cmyk-and-gray-jpegs-read-the-same-in-pdfjs-and-mupdf', async () => {
  const output = compress(source, 'strong');
  const pdf = await pdfjs.getDocument({ data: output.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const pdfPage = await pdf.getPage(2);
  const list = await pdfPage.getOperatorList();
  let drawn = 0;
  for (let i = 0; i < list.fnArray.length; i++) {
    if (list.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
    const image = await new Promise(resolve => pdfPage.objs.get(list.argsArray[i][0], resolve));
    assert(image.width > 0 && image.data.length > 0);
    drawn++;
  }
  assert.equal(drawn, 3);
  // MuPDF draws the CMYK photo as before: no inverted colours.
  const value = psnr(render(source, 1, 50), render(output, 1, 50));
  assert(value > 28, `${value.toFixed(1)} dB`);
  return { drawn, psnr: Number(value.toFixed(1)) };
});

await check('levels-shrink-in-order', () => {
  const sizes = ['high', 'balanced', 'strong', 'maximum'].map(level => compress(source, level).length);
  for (let i = 1; i < sizes.length; i++) assert(sizes[i] <= sizes[i - 1], sizes.join(' > '));
  return { sizes };
});

await check('custom-settings-are-validated', () => {
  for (const settings of [
    { resolution: 10, quality: 80 },
    { resolution: 200, quality: 120 },
    { resolution: NaN, quality: 50 },
    'max',
  ])
    assert.throws(() => operateDocument(source, { operation: 'compress', settings }), /inválidos/);
  const output = operateDocument(source, { operation: 'compress', settings: { resolution: 96, quality: 40 } });
  assert(output.length < compress(source, 'maximum').length * 1.5);
  return {};
});

await check('progress-reaches-the-end-and-counts-pages-and-images', () => {
  const steps = [];
  operateDocument(
    source,
    { operation: 'compress', settings: COMPRESSION_PRESETS.balanced },
    '',
    undefined,
    (done, total) => steps.push([done, total]),
  );
  assert(steps.length >= 3);
  const total = steps[0][1];
  assert(steps.every(([done, all], i) => all === total && (i === 0 || done >= steps[i - 1][0])));
  assert.equal(steps.at(-1)[0], total - 1);
  return { steps: steps.length };
});

await check('duplicated-images-are-stored-once', () => {
  const copy = new mupdf.PDFDocument();
  const samples = photo(800, 600, 3);
  const first = addImage(copy, { width: 800, height: 600, samples }),
    second = addImage(copy, { width: 800, height: 600, samples });
  page(copy, [612, 792], { A: first }, 'q 400 0 0 300 50 400 cm /A Do Q');
  page(copy, [612, 792], { A: second }, 'q 400 0 0 300 50 400 cm /A Do Q');
  const bytes = save(copy);
  const output = compress(bytes, 'lossless');
  assert.equal(Object.keys(images(output)).length, 1);
  assert.deepEqual(render(output, 1), render(bytes, 1));
  return { from: bytes.length, to: output.length };
});

const corpus = name =>
  fs.existsSync(`.fixtures/${name}`) ? new Uint8Array(fs.readFileSync(`.fixtures/${name}`)) : null;

await check('encrypted-pdf-stays-encrypted-with-its-password', () => {
  const bytes = corpus('irs-w9-aes256-test.pdf');
  if (!bytes) return { skipped: 'run npm run test:fixtures' };
  const output = compress(bytes, 'balanced', 'folio-test');
  const doc = new mupdf.PDFDocument(output);
  assert(doc.needsPassword());
  assert(doc.authenticatePassword('folio-test'));
  assert.equal(doc.countPages(), 6);
  assert.deepEqual(render(output, 0, 72, 'folio-test'), render(bytes, 0, 72, 'folio-test'));
  return { from: bytes.length, to: output.length };
});

await check('form-fields-and-their-fonts-survive', () => {
  const bytes = corpus('irs-w9.pdf');
  if (!bytes) return { skipped: 'run npm run test:fixtures' };
  const fields = data => operateDocument(data, { operation: 'fields' });
  const output = compress(bytes, 'maximum');
  assert.deepEqual(
    fields(output).map(field => field.name),
    fields(bytes).map(field => field.name),
  );
  for (let index = 0; index < pages(bytes); index++) assert.deepEqual(render(output, index), render(bytes, index));
  return { from: bytes.length, to: output.length };
});

await check('text-and-pages-unchanged-in-a-long-manual', () => {
  const bytes = corpus('tracemonkey.pdf');
  if (!bytes) return { skipped: 'run npm run test:fixtures' };
  const output = compress(bytes, 'balanced');
  assert.deepEqual(operateDocument(output, { operation: 'text' }), operateDocument(bytes, { operation: 'text' }));
  for (const index of [0, 5, 13]) assert(psnr(render(bytes, index), render(output, index)) > 40);
  return { from: bytes.length, to: output.length };
});

await check('the-loadImage-leak-workaround-matches-this-mupdf', () => {
  // MuPDF.js 1.28.1 keeps the image loadImage returns twice; compress.ts releases the extra
  // reference (a 187 MB document ran out of memory without it). After upgrading MuPDF.js,
  // a failure here means loadImage changed: check it before changing this test.
  assert.equal(loadKeepsTwice, true);
  const leaky = new mupdf.PDFDocument();
  const ref = addImage(leaky, { width: 300, height: 200 });
  for (let i = 0; i < 50; i++) {
    const image = loadImage(leaky, ref);
    assert.equal(image.getWidth(), 300);
    image.toPixmap().destroy();
    image.destroy();
    mupdf.emptyStore();
  }
  return {};
});

await check('helpers', () => {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 32, 32], false);
  pixmap.getPixels().fill(90);
  for (const quality of [40, 75, 92]) assert.equal(jpegQuality(pixmap.asJPEG(quality, false)), quality);
  assert.equal(jpegQuality(new Uint8Array([0xff, 0xd8, 0x00])), null);
  // Exact area averages: a 4×2 gray image to 2×1.
  assert.deepEqual([...resample(new Uint8Array([0, 100, 200, 40, 20, 60, 0, 0]), 4, 2, 1, 2, 1)], [45, 60]);
  // 6 in at 200 ppp is 1200 px; an image at most 25 % too detailed is left alone.
  assert.equal(sampleScale(2400, 1600, { width: 432, height: 288 }, 200), 0.5);
  assert.equal(sampleScale(1400, 900, { width: 432, height: 288 }, 200), 1);
  assert(fewColours(new Uint8Array(3000).fill(7), 3));
  assert(!fewColours(photo(200, 200, 3), 3));
  return {};
});

fs.writeFileSync('test-results/compress.json', JSON.stringify(results, null, 2));
