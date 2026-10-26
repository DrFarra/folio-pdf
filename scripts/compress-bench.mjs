// Comprimir PDF on real documents: size, time and how much each page changes when drawn.
// node scripts/compress-bench.mjs file.pdf… [--levels=high,balanced]
import fs from 'node:fs';
import * as mupdf from 'mupdf';
import { compressDocument, COMPRESSED_SAVE } from '../src/engine/compress.ts';
import { COMPRESSION_PRESETS } from '../src/engine/compression-settings.ts';

const args = process.argv.slice(2);
const levels = (
  args.find(a => a.startsWith('--levels='))?.slice(9) ?? Object.keys(COMPRESSION_PRESETS).join(',')
).split(',');
const files = args.filter(a => !a.startsWith('--'));
const render = (doc, index, dpi = 100) => {
  const page = doc.loadPage(index);
  try {
    const pixmap = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false);
    const pixels = new Uint8Array(pixmap.getPixels());
    pixmap.destroy();
    return pixels;
  } finally {
    page.destroy();
  }
};
const psnr = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return sum ? 10 * Math.log10((255 * 255 * a.length) / sum) : Infinity;
};
const text = (doc, index) => {
  const page = doc.loadPage(index);
  try {
    return page.toStructuredText().asText();
  } finally {
    page.destroy();
  }
};
for (const file of files) {
  const bytes = fs.readFileSync(file);
  const original = new mupdf.PDFDocument(bytes);
  const pages = original.countPages();
  const sample = [...new Set([0, 1, Math.floor(pages / 2), pages - 1].filter(i => i >= 0 && i < pages))];
  console.log(`${file.split('/').pop()}  ${(bytes.length / 1e6).toFixed(2)} MB, ${pages} p.`);
  for (const level of levels) {
    const doc = new mupdf.PDFDocument(bytes);
    const start = performance.now();
    compressDocument(doc, COMPRESSION_PRESETS[level]);
    const out = doc.saveToBuffer(COMPRESSED_SAVE).asUint8Array().slice();
    const seconds = (performance.now() - start) / 1000;
    doc.destroy();
    const result = new mupdf.PDFDocument(out);
    if (result.countPages() !== pages) throw new Error('page count changed');
    let worst = Infinity;
    for (const index of sample) {
      worst = Math.min(worst, psnr(render(original, index), render(result, index)));
      if (text(original, index) !== text(result, index)) throw new Error(`text changed on page ${index + 1}`);
    }
    result.destroy();
    console.log(
      `  ${level.padEnd(9)} ${(out.length / 1e6).toFixed(2)} MB  ${String(Math.round((1 - out.length / bytes.length) * 100)).padStart(3)} %  ${seconds.toFixed(1)} s  worst page ${worst === Infinity ? 'identical' : worst.toFixed(1) + ' dB'}`,
    );
    if (process.env.OUT) fs.writeFileSync(`${process.env.OUT}/${level}-${file.split('/').pop()}`, out);
  }
  original.destroy();
}
