// OCR benchmark: Folio's engine (PP-OCRv5 via ONNX Runtime) against tesseract.js on
// pages whose true text is known. Born-digital pages are rendered like scans, then
// degraded (blur + noise + strong JPEG, low resolution, a 2° tilt). Prints a table
// and writes test-results/ocr-bench.json.
//   node scripts/tests/ocr-bench.mjs [--quick]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web';
import { PaddleOcr } from '../../src/ppocr.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const mupdf = await import(pathToFileURL(require.resolve('mupdf')).href);
const quick = process.argv.includes('--quick');
ort.env.wasm.numThreads = 1;

// A Spanish page of running text, so the benchmark covers accents and ñ.
function spanishPage() {
  const words =
    'Los antimicrobianos betalactámicos inhiben la síntesis de la pared celular bacteriana al unirse a las proteínas fijadoras de penicilina. Su eficacia depende del tiempo en que la concentración supera la concentración inhibitoria mínima. Las reacciones adversas más frecuentes son la hipersensibilidad, las alteraciones gastrointestinales y la nefrotoxicidad en dosis altas; el niño y el anciano requieren ajuste.'.split(
      ' ',
    );
  const lines = [];
  let line = '';
  for (let i = 0; lines.length < 40; i++) {
    const w = words[i % words.length];
    if ((line + ' ' + w).length > 84) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  const buffer = new mupdf.Buffer(),
    out = new mupdf.DocumentWriter(buffer, 'pdf', '');
  const device = out.beginPage([0, 0, 595, 842]),
    text = new mupdf.Text(),
    times = new mupdf.Font('Times-Roman');
  lines.forEach((t, i) => text.showString(times, [11, 0, 0, -11, 60, 70 + i * 17], t));
  device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1);
  out.endPage();
  out.close();
  return new Uint8Array(buffer.asUint8Array());
}

const sources = [
  ['tracemonkey (EN, 2 columnas)', fs.readFileSync(path.join(root, '.fixtures/tracemonkey.pdf')), 1],
  ['manual de Emacs (EN)', fs.readFileSync(path.join(root, '.fixtures/emacs-manual.pdf')), 40],
  ['formulario W-9 (EN)', fs.readFileSync(path.join(root, '.fixtures/irs-w9.pdf')), 1],
  ['guía de Folio (ES)', fs.readFileSync(path.join(root, 'public/sample.pdf')), 2],
  ['texto médico (ES)', spanishPage(), 1],
].slice(0, quick ? 2 : undefined);

// Ground truth: the PDF's own lines and words, with boxes in page points.
function truth(bytes, number) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf'),
    page = doc.loadPage(number - 1),
    stext = page.toStructuredText();
  const lines = [],
    words = [];
  let line = '',
    word = '',
    box = null;
  const flushWord = () => {
    if (word.trim()) words.push({ text: word, box });
    word = '';
    box = null;
  };
  stext.walk({
    beginLine: () => {
      line = '';
    },
    onChar: (c, origin, font, size, quad) => {
      line += c;
      if (/\s/.test(c)) {
        flushWord();
        return;
      }
      word += c;
      const xs = [quad[0], quad[2], quad[4], quad[6]],
        ys = [quad[1], quad[3], quad[5], quad[7]];
      const q = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      box = box ? [Math.min(box[0], q[0]), Math.min(box[1], q[1]), Math.max(box[2], q[2]), Math.max(box[3], q[3])] : q;
    },
    endLine: () => {
      flushWord();
      if (line.trim()) lines.push(line);
    },
  });
  stext.destroy();
  page.destroy();
  doc.destroy();
  return {
    lines: lines.map(norm).filter(Boolean),
    words: words.map(w => ({ ...w, text: norm(w.text) })).filter(w => w.text),
  };
}
const norm = s =>
  s
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

// Scanner-like renderings of a page.
function render(bytes, number, dpi) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf'),
    page = doc.loadPage(number - 1);
  const pix = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false);
  const image = {
    data: new Uint8ClampedArray(pix.getPixels()),
    width: pix.getWidth(),
    height: pix.getHeight(),
    channels: 3,
  };
  pix.destroy();
  page.destroy();
  doc.destroy();
  return image;
}
function degrade(image) {
  const { data, width: w, height: h } = image,
    out = new Uint8ClampedArray(data.length);
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let sum = 0,
          n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy,
              xx = x + dx;
            if (yy >= 0 && yy < h && xx >= 0 && xx < w) {
              sum += data[(yy * w + xx) * 3 + c];
              n++;
            }
          }
        out[(y * w + x) * 3 + c] = sum / n + (random() + random() + random() - 1.5) * 28;
      }
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.getPixels().set(out);
  const jpeg = pix.asJPEG(35);
  pix.destroy();
  const back = new mupdf.Image(jpeg).toPixmap(),
    result = {
      data: new Uint8ClampedArray(back.getPixels()),
      width: w,
      height: h,
      channels: back.getNumberOfComponents(),
    };
  back.destroy();
  return result;
}
function tilt(image, degrees) {
  const { data, width: w, height: h, channels: n } = image,
    out = new Uint8ClampedArray(data.length).fill(255);
  const t = (-degrees * Math.PI) / 180,
    c = Math.cos(t),
    s = Math.sin(t);
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
  return { ...image, data: out };
}
const png = image => {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, image.width, image.height], false),
    p = pix.getPixels();
  for (let i = 0, j = 0; i < image.width * image.height; i++, j += image.channels) {
    p[i * 3] = image.data[j];
    p[i * 3 + 1] = image.data[j + (image.channels > 1 ? 1 : 0)];
    p[i * 3 + 2] = image.data[j + (image.channels > 2 ? 2 : 0)];
  }
  const bytes = pix.asPNG();
  pix.destroy();
  return Buffer.from(bytes);
};

// Metrics that do not depend on reading order (columns are read differently by each engine).
function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i),
    current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}
function wordCer(truthWords, foundWords) {
  // Each true word against its closest recognised word: line breaks and order do not count.
  const byLength = new Map();
  for (const w of foundWords) {
    const list = byLength.get(w.length) || [];
    list.push(w);
    byLength.set(w.length, list);
  }
  let errors = 0,
    total = 0;
  for (const { text } of truthWords) {
    let best = text.length;
    for (let d = 0; d < best; d++)
      for (const length of new Set([text.length - d, text.length + d]))
        for (const other of byLength.get(length) || []) {
          best = Math.min(best, distance(text, other));
          if (!best) break;
        }
    errors += best;
    total += text.length;
  }
  return errors / total;
}
// The whole text in reading order: also counts columns read across.
const orderCer = (truthLines, foundLines) => {
  const a = truthLines.join(' '),
    b = foundLines.join(' ');
  return distance(a, b) / a.length;
};
function wordScores(truthWords, foundWords) {
  const pool = new Map();
  for (const w of foundWords) pool.set(w, (pool.get(w) || 0) + 1);
  let hits = 0;
  for (const { text } of truthWords) {
    const n = pool.get(text) || 0;
    if (n) {
      hits++;
      pool.set(text, n - 1);
    }
  }
  const recall = hits / truthWords.length,
    precision = hits / Math.max(1, foundWords.length);
  return { recall, precision, f1: recall + precision ? (2 * recall * precision) / (recall + precision) : 0 };
}
function boxIou(truthWords, found, scale) {
  const iou = (a, b) => {
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]),
      h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (w <= 0 || h <= 0) return 0;
    const i = w * h;
    return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i);
  };
  const scores = [];
  for (const word of truthWords) {
    const box = word.box.map(v => v * scale);
    let best = 0;
    for (const other of found) if (other.text === word.text) best = Math.max(best, iou(box, other.box));
    if (best) scores.push(best);
  }
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

// The engines.
const model = name => new Uint8Array(fs.readFileSync(path.join(root, 'public/ocr/ppocr', name)));
const paddle = await PaddleOcr.create(ort, {
  det: model('det.onnx'),
  rec: model('rec-latin.onnx'),
  cls: model('cls.onnx'),
  dict: fs.readFileSync(path.join(root, 'public/ocr/ppocr/dict-latin.txt'), 'utf8'),
});
const { createWorker } = await import('tesseract.js');
const tesseract = await createWorker('spa+eng', 1, {
  langPath: path.join(root, 'public/ocr'),
  gzip: false,
  cacheMethod: 'none',
});
const engines = {
  'Folio (PP-OCRv5)': async image => {
    const lines = await paddle.recognize(image);
    return {
      lines: lines.map(l => norm(l.text)),
      words: lines.flatMap(l => l.words.map(w => ({ text: norm(w.text), box: w.box }))),
    };
  },
  'Tesseract 5 (actual)': async image => {
    const { data } = await tesseract.recognize(png(image), {}, { blocks: true, text: true });
    const lines = (data.blocks || []).flatMap(b => b.paragraphs.flatMap(p => p.lines));
    return {
      lines: lines.map(l => norm(l.text)),
      words: lines
        .flatMap(l => l.words)
        .map(w => ({ text: norm(w.text), box: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1] })),
    };
  },
};

const variants = [
  ['limpia 150 ppp', (b, n) => ({ image: render(b, n, 150), scale: 150 / 72, boxes: true })],
  ['degradada', (b, n) => ({ image: degrade(render(b, n, 150)), scale: 150 / 72, boxes: true })],
  ['baja resolución 100 ppp', (b, n) => ({ image: render(b, n, 100), scale: 100 / 72, boxes: true })],
  ['torcida 2°', (b, n) => ({ image: tilt(render(b, n, 150), 2), scale: 150 / 72, boxes: false })],
].slice(0, quick ? 2 : undefined);

const rows = [];
try {
  for (const [name, bytes, number] of sources) {
    const real = truth(bytes, number);
    for (const [variant, make] of variants) {
      const { image, scale, boxes } = make(bytes, number);
      for (const [engine, run] of Object.entries(engines)) {
        const started = performance.now(),
          found = await run(image),
          ms = performance.now() - started;
        const words = found.words.filter(w => w.text);
        const row = {
          page: name,
          variant,
          engine,
          cer: wordCer(
            real.words,
            words.map(w => w.text),
          ),
          order: orderCer(real.lines, found.lines),
          ...wordScores(
            real.words,
            words.map(w => w.text),
          ),
          iou: boxes ? boxIou(real.words, words, scale) : null,
          ms,
        };
        rows.push(row);
        console.log(
          JSON.stringify({
            ...row,
            cer: +row.cer.toFixed(4),
            order: +row.order.toFixed(4),
            f1: +row.f1.toFixed(4),
            iou: row.iou == null ? null : +row.iou.toFixed(3),
            ms: Math.round(ms),
          }),
        );
      }
    }
  }
} finally {
  await tesseract.terminate();
}

const summary = Object.keys(engines).map(engine => {
  const mine = rows.filter(r => r.engine === engine),
    mean = key =>
      mine.filter(r => r[key] != null).reduce((t, r) => t + r[key], 0) / mine.filter(r => r[key] != null).length;
  return { engine, cer: mean('cer'), order: mean('order'), f1: mean('f1'), iou: mean('iou'), ms: mean('ms') };
});
console.log(
  '\n| Motor | Error por carácter | Error en orden de lectura | Palabras (F1) | Cajas (IoU) | Tiempo por página (CPU, 1 hilo) |\n| --- | --- | --- | --- | --- | --- |',
);
for (const s of summary)
  console.log(
    `| ${s.engine} | ${(s.cer * 100).toFixed(2)} % | ${(s.order * 100).toFixed(1)} % | ${(s.f1 * 100).toFixed(1)} % | ${s.iou.toFixed(2)} | ${(s.ms / 1000).toFixed(1)} s |`,
  );
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test-results/ocr-bench.json'), JSON.stringify({ rows, summary }, null, 2));
// The quick run is a test: Folio's engine reads every page well, and better than Tesseract on average.
if (quick) {
  for (const row of rows.filter(r => r.engine.startsWith('Folio')))
    assert(row.f1 >= 0.94, `${row.page}, ${row.variant}: ${(row.f1 * 100).toFixed(1)} % of words`);
  assert(summary[0].f1 > summary[1].f1, 'Folio reads more words right than Tesseract');
}
