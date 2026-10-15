// Real pages through Folio's whole OCR path, as the app runs it: classify the page,
// render it, straighten it, read it, and rebuild it as editable text. Writes, for each
// page, the original and the rebuilt page side by side and the text read, to
// test-results/real/, for a person to look at. The PDFs are the user's own and stay
// on this computer; nothing here is committed.
//   node scripts/tests/ocr-real.mjs "file.pdf#12" "other.pdf#3" ...
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web';
import { PaddleOcr } from '../../src/ppocr.ts';
import { cleanPaper, rebuildLines } from '../../src/rebuild.ts';
import { shrink, inkMask, skewAngle, flattenField, marginTilt, flatTilt, flatten } from '../../src/straighten.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const mupdf = await import(pathToFileURL(require.resolve('mupdf')).href);
const { operateDocument } = await import(pathToFileURL(path.join(root, 'src/engine/operations.mjs')).href);
const out = path.join(root, 'test-results/real'); fs.mkdirSync(out, { recursive: true });
const faces = JSON.parse(fs.readFileSync(path.join(root, 'public/fonts/ocr/faces.json'), 'utf8')).faces.map(({ file, ...face }) => ({ ...face, file: new Uint8Array(fs.readFileSync(path.join(root, 'public/fonts/ocr', file))) }));
ort.env.wasm.numThreads = 4;
const model = name => new Uint8Array(fs.readFileSync(path.join(root, 'public/ocr/ppocr', name)));
const engine = await PaddleOcr.create(ort, { det: model('det.onnx'), rec: model('rec-latin.onnx'), cls: model('cls.onnx'), dict: fs.readFileSync(path.join(root, 'public/ocr/ppocr/dict-latin.txt'), 'utf8') });

// The canvas's turn, done by hand: clockwise by `degrees` about the centre, white outside.
function turned({ data, width: w, height: h, channels: n }, degrees) {
  const t = degrees * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), result = new Uint8ClampedArray(data.length).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - w / 2, dy = y - h / 2, fx = c * dx + s * dy + w / 2, fy = -s * dx + c * dy + h / 2, x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
    const ax = fx - x0, ay = fy - y0;
    for (let k = 0; k < n; k++) { const at = (xx, yy) => data[(yy * w + xx) * n + k]; result[(y * w + x) * n + k] = (at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax) * (1 - ay) + (at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax) * ay; }
  }
  return { data: result, width: w, height: h, channels: n };
}
// src/ocr.ts's straighten(), on plain pixels.
function straighten(image) {
  const analyse = pixels => { const sample = shrink(pixels); return { sample, mask: inkMask(sample) }; };
  let page = image, { sample, mask } = analyse(page), angle = skewAngle(mask, sample.width, sample.height);
  if (angle) { page = turned(image, angle); ({ sample, mask } = analyse(page)); }
  let field = flattenField(mask, sample.width, sample.height);
  if (field) {
    const extra = marginTilt(mask, sample.width, sample.height) ?? flatTilt(mask, sample.width, sample.height);
    if (extra) { angle = Math.round((angle + extra) * 100) / 100; page = Math.abs(angle) >= .1 ? turned(image, angle) : image; ({ sample, mask } = analyse(page)); field = flattenField(mask, sample.width, sample.height); }
  }
  if (field) page = { ...page, data: flatten(page, field, 1 / sample.scale) };
  return { page, angle, flattened: !!field };
}
const pixmapOf = image => { const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, image.width, image.height], false); pix.getPixels().set(image.data); return pix; };

for (const spec of process.argv.slice(2)) {
  const [file, number = '1'] = spec.split('#'), name = `${path.basename(file, '.pdf').replace(/[^\w-]+/g, '_').slice(0, 40)}-p${number}`;
  const bytes = fs.readFileSync(file), doc = mupdf.Document.openDocument(bytes, 'application/pdf'), page = doc.loadPage(Number(number) - 1);
  const [layers] = operateDocument(bytes, { operation: 'text-layers', pages: [Number(number)] });
  const bounds = page.getBounds(), width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
  const scale = Math.min(3, Math.sqrt(12_000_000 / (width * height))), times = {};
  let started = performance.now();
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
  const image = { data: new Uint8ClampedArray(pix.getPixels()), width: pix.getWidth(), height: pix.getHeight(), channels: 3 };
  times.render = performance.now() - started; started = performance.now();
  const { page: straight, angle, flattened } = straighten(image);
  times.straighten = performance.now() - started; started = performance.now();
  const lines = await engine.recognize({ ...straight, data: new Uint8ClampedArray(straight.data) });
  times.ocr = performance.now() - started; started = performance.now();
  if (process.env.FOLIO_LINES) for (const line of lines) if (line.text.match(new RegExp(process.env.FOLIO_LINES))) console.log('OCRLINE', line.score.toFixed(3), line.box.map(Math.round).join(','), JSON.stringify(line.text), line.words.map(w => w.text + '@' + w.box.map(Math.round).join(',')).join(' '));
  const heights = lines.map(line => line.box[3] - line.box[1]).sort((a, b) => a - b), usual = heights[heights.length >> 1] || 0;
  const level = lines.filter(line => line.box[3] - line.box[1] <= usual * 2.5), scanned = pixmapOf(straight), original = scanned.asJPEG(90); if (process.env.FOLIO_STRAIGHT) fs.writeFileSync(path.join(out, `${name}-straight.png`), scanned.asPNG()); scanned.destroy();
  let t0 = performance.now();
  const styles = rebuildLines(straight, level.map(line => ({ text: line.text, box: line.box, score: line.score, words: line.words })));
  times.lines = performance.now() - t0; t0 = performance.now();
  if (process.env.FOLIO_BACKDROP) { const raw = pixmapOf(straight); fs.writeFileSync(path.join(out, `${name}-erased.png`), raw.asPNG()); raw.destroy(); }
  cleanPaper(straight);
  times.paper = performance.now() - t0; t0 = performance.now();
  const rebuilt = level.flatMap((line, i) => { const style = styles[i]; if (!style) return []; const { kept, box: lineBox, colors, ...colours } = style, words = line.words.flatMap((word, n) => kept.includes(n) ? [] : [{ ...word, color: colors[n] ?? undefined }]); return [{ text: words.map(word => word.text).join(' '), box: lineBox.map(v => v / scale), ...colours, words: words.map(word => ({ text: word.text, box: word.box.map(v => v / scale), color: word.color })) }]; });
  // FOLIO_BACKDROP=1 also writes the cleaned image the text is laid over.
  const backdrop = pixmapOf(straight), jpeg = backdrop.asJPEG(90); if (process.env.FOLIO_BACKDROP) fs.writeFileSync(path.join(out, `${name}-backdrop.png`), backdrop.asPNG()); backdrop.destroy();
  const blank = new mupdf.PDFDocument(); blank.insertPage(-1, blank.addPage([0, 0, width, height], 0, blank.newDictionary(), ''));
  const result = operateDocument(new Uint8Array(blank.saveToBuffer('').asUint8Array()), { operation: 'ocr', pages: [{ page: 1, words: [], image: jpeg, size: [width, height], lines: rebuilt, original }], faces });
  times.engine = performance.now() - t0;
  times.rebuild = performance.now() - started;
  // Side by side, at 1.2 px per point: the page as it was, the page rebuilt.
  const view = 1.2, left = page.toPixmap(mupdf.Matrix.scale(view, view), mupdf.ColorSpace.DeviceRGB, false), right = mupdf.Document.openDocument(result, 'application/pdf').loadPage(0).toPixmap(mupdf.Matrix.scale(view, view), mupdf.ColorSpace.DeviceRGB, false);
  const W = left.getWidth(), H = Math.max(left.getHeight(), right.getHeight()), both = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W * 2 + 20, H], false); both.clear(150);
  const target = both.getPixels(), stride = (W * 2 + 20) * 3;
  for (const [k, p] of [[0, left], [1, right]]) { const source = p.getPixels(), w = p.getWidth(); for (let y = 0; y < p.getHeight(); y++) target.set(source.subarray(y * w * 3, (y + 1) * w * 3), y * stride + k * (W + 20) * 3); }
  fs.writeFileSync(path.join(out, `${name}.png`), both.asPNG()); fs.writeFileSync(path.join(out, `${name}.pdf`), result);
  fs.writeFileSync(path.join(out, `${name}.txt`), lines.map(line => line.text).join('\n'));
  console.log(JSON.stringify({ page: name, scan: layers.scan, visible: layers.visible, hidden: layers.hidden, size: [image.width, image.height], angle, flattened, lines: lines.length, rebuilt: rebuilt.length, ms: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)])) }));
  pix.destroy(); page.destroy(); doc.destroy();
}
