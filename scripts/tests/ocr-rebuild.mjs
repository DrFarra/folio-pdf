// Rebuilding a scan as digital text: OCR lines keep their colour and weight, their
// letters leave the image without taking a coloured box with them, and the page comes
// back as real text that Editar can change line by line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web';
import { PaddleOcr } from '../../src/ppocr.ts';
import { rebuildLines } from '../../src/rebuild.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const mupdf = await import(pathToFileURL(require.resolve('mupdf')).href);
const { operateDocument } = await import(pathToFileURL(path.join(root, 'src/engine/operations.mjs')).href);
ort.env.wasm.numThreads = 1;
const results = [];
const check = async (id, run) => { results.push({ id, ...(await run()) }); };

// The "paper": sans and serif text, a bold heading, red text on a light blue box.
const LINES = [
  ['Los antimicrobianos inhiben la pared celular', 'Helvetica', [0, 0, 0], 120],
  ['Reacciones adversas frecuentes', 'Helvetica-Bold', [0, 0, 0], 170],
  ['Dosis ajustada en el anciano', 'Helvetica', [.75, .1, .1], 250],
  ['La farmacocinética describe la absorción del fármaco', 'Times-Roman', [0, 0, 0], 310],
  ['y su eliminación por el riñón en los ancianos', 'Times-Roman', [0, 0, 0], 335],
];
const BOX = [50, 222, 545, 262], FILL = [.82, .9, .98];
function paper() {
  const buffer = new mupdf.Buffer(), writer = new mupdf.DocumentWriter(buffer, 'pdf', ''), device = writer.beginPage([0, 0, 595, 400]);
  const path2 = new mupdf.Path(); path2.rect(BOX[0], BOX[1], BOX[2], BOX[3]);
  device.fillPath(path2, false, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, FILL, 1);
  for (const [line, font, color, y] of LINES) {
    const text = new mupdf.Text(); text.showString(new mupdf.Font(font), [16, 0, 0, -16, 60, y], line);
    device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, color, 1);
  }
  writer.endPage(); writer.close();
  return new Uint8Array(buffer.asUint8Array());
}
const scale = 150 / 72;
const doc = mupdf.Document.openDocument(paper(), 'application/pdf'), pix = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
const image = { data: new Uint8ClampedArray(pix.getPixels()), width: pix.getWidth(), height: pix.getHeight(), channels: 3 };
const model = name => new Uint8Array(fs.readFileSync(path.join(root, 'public/ocr/ppocr', name)));
const engine = await PaddleOcr.create(ort, { det: model('det.onnx'), rec: model('rec-latin.onnx'), cls: model('cls.onnx'), dict: fs.readFileSync(path.join(root, 'public/ocr/ppocr/dict-latin.txt'), 'utf8') });
const lines = await engine.recognize({ ...image, data: new Uint8ClampedArray(image.data) });
const pick = words => lines.find(line => line.text.includes(words));
// The scan as it was, for the engine to match each line's face against.
const scanned = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, image.width, image.height], false); scanned.getPixels().set(image.data);
const original = scanned.asPNG(); scanned.destroy();
const styles = rebuildLines(image, lines.map(line => ({ text: line.text, box: line.box, score: line.score })));
const styleOf = words => styles[lines.findIndex(line => line.text.includes(words))];
const at = (x, y) => { const i = (Math.round(y * scale) * image.width + Math.round(x * scale)) * 3; return [image.data[i], image.data[i + 1], image.data[i + 2]]; };

await check('each-line-keeps-its-colour', () => {
  for (const [line] of LINES) assert(pick(line.split(' ')[0]), `read: ${lines.map(l => l.text).join(' | ')}`);
  const regular = styleOf('antimicrobianos'), red = styleOf('Dosis');
  assert(red.color[0] > .5 && red.color[1] < .35 && red.color[2] < .35, `red read as ${red.color}`);
  assert(Math.max(...regular.color) < .3, `black read as ${regular.color}`);
  assert(red.background[2] > .9 && red.background[0] < .9, `the red line's background read as ${red.background}`);
  return { red: red.color.map(v => +v.toFixed(2)), onBlue: red.background.map(v => +v.toFixed(2)) };
});

await check('letters-leave-the-image-and-the-box-stays', () => {
  for (const line of lines) {
    const [x0, y0, x1, y1] = line.box.map(Math.round); let darkest = 255;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * image.width + x) * 3; darkest = Math.min(darkest, (image.data[i] * 299 + image.data[i + 1] * 587 + image.data[i + 2] * 114) / 1000); }
    assert(darkest > 170, `ink left in "${line.text}": ${darkest}`);
  }
  // Inside the box where the red letters were, its blue fill.
  const [r, g, b] = at(200, 245);
  assert(Math.abs(r - FILL[0] * 255) < 18 && Math.abs(g - FILL[1] * 255) < 18 && Math.abs(b - FILL[2] * 255) < 18, `box fill is now ${[r, g, b]}`);
  return { erased: true, boxKept: [r, g, b] };
});

await check('the-page-comes-back-as-editable-text', () => {
  const pngPix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, image.width, image.height], false); pngPix.getPixels().set(image.data);
  const png = pngPix.asPNG(); pngPix.destroy();
  const scan = new mupdf.PDFDocument(); scan.insertPage(-1, scan.addPage([0, 0, 595, 400], 0, scan.newDictionary(), '')); const bytes = new Uint8Array(scan.saveToBuffer('').asUint8Array());
  const rebuilt = lines.map((line, i) => { const { box, kept, colors, ...colours } = styles[i]; return { text: line.text, box: box.map(v => v / scale), ...colours, words: line.words.map(word => ({ text: word.text, box: word.box.map(v => v / scale) })) }; });
  const out = operateDocument(bytes, { operation: 'ocr', pages: [{ page: 1, words: [], image: png, size: [595, 400], lines: rebuilt, original }] });
  const text = operateDocument(out, { operation: 'text' })[0];
  for (const [line] of LINES) assert(text.includes(line), `text: ${text}`);
  const items = operateDocument(out, { operation: 'page-content', page: 1 }).items.filter(item => item.kind === 'text' && item.editable);
  assert(items.some(item => item.text?.includes('Reacciones adversas')), JSON.stringify(items.map(i => i.text)));
  const layers = operateDocument(out, { operation: 'text-layers', pages: [1] })[0];
  assert(layers.visible >= LINES.length && layers.hidden === 0, JSON.stringify(layers));
  // Each line in the face it was printed in: sans, bold sans, serif.
  const faces = {}; const reader = mupdf.Document.openDocument(out, 'application/pdf'), device = new mupdf.Device({ fillText: text => { let face = '', letters = ''; text.walk({ beginSpan: font => { face = font.getName().split('+').pop(); }, showGlyph: (font, trm, gid, ucs) => { letters += String.fromCodePoint(ucs); } }); faces[letters.trim().slice(0, 12)] = face; } });
  reader.loadPage(0).run(device, mupdf.Matrix.identity); device.close();
  const faceOf = start => Object.entries(faces).find(([letters]) => start.startsWith(letters.slice(0, 8)) || letters.startsWith(start.slice(0, 8)))?.[1];
  assert.equal(faceOf('Los antimicrobianos'), 'Helvetica', JSON.stringify(faces));
  assert.equal(faceOf('Reacciones adversas'), 'Helvetica-Bold', JSON.stringify(faces));
  assert.equal(faceOf('La farmacocinética'), 'Times-Roman', JSON.stringify(faces));
  // Where the bold line is, its text sits within a point of the scan's letters.
  const placed = items.find(item => item.text?.includes('Reacciones')), source = pick('Reacciones').box.map(v => v / scale);
  assert(Math.abs(placed.rect[0] - source[0]) < 3, `placed at ${placed.rect} for ${source}`);
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true }); fs.writeFileSync(path.join(root, 'test-results/ocr-rebuilt.pdf'), out);
  return { realText: true, editableLines: items.length, visible: layers.visible, faces };
});

await check('an-ocr-layer-is-told-apart-from-printed-text', () => {
  const scan = new mupdf.PDFDocument(); scan.insertPage(-1, scan.addPage([0, 0, 595, 400], 0, scan.newDictionary(), '')); const bytes = new Uint8Array(scan.saveToBuffer('').asUint8Array());
  const ocred = operateDocument(bytes, { operation: 'ocr', pages: [{ page: 1, words: [{ text: 'Oculto', rect: [60, 300, 120, 316] }] }] });
  const [layers] = operateDocument(ocred, { operation: 'text-layers', pages: [1] }), [printed] = operateDocument(paper(), { operation: 'text-layers', pages: [1] });
  assert(layers.visible === 0 && layers.hidden > 0, JSON.stringify(layers));
  assert(printed.visible > 0 && printed.hidden === 0, JSON.stringify(printed));
  return { ocrLayerHidden: true, printedVisible: true };
});

for (const result of results) console.log(JSON.stringify({ ...result, status: 'passed' }));
