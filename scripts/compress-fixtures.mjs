// Builds heavy PDFs for scripts/compress-bench.mjs from the test corpus:
//  scanned-book.pdf  pages of the Emacs manual drawn at 300 ppi, as a scanner writes them (JPEG q92);
//  photo-slides.pdf  the photos of a real slide deck enlarged 3× and stored losslessly.
// node scripts/compress-fixtures.mjs [pages]
import fs from 'node:fs';
import * as mupdf from 'mupdf';

const pages = Number(process.argv[2] || 40);
const out = '.fixtures/compress';
fs.mkdirSync(out, { recursive: true });

{
  const source = new mupdf.PDFDocument(fs.readFileSync('.fixtures/emacs-manual.pdf'));
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < pages; i++) {
    const page = source.loadPage(10 + (i % (source.countPages() - 10)));
    const [x0, y0, x1, y1] = page.getBounds();
    const pixmap = page.toPixmap(mupdf.Matrix.scale(300 / 72, 300 / 72), mupdf.ColorSpace.DeviceRGB, false);
    const image = doc.addImage(new mupdf.Image(pixmap.asJPEG(92, false)));
    const resources = doc.newDictionary(),
      xobjects = doc.newDictionary();
    xobjects.put('Scan', image);
    resources.put('XObject', xobjects);
    doc.insertPage(
      -1,
      doc.addPage([0, 0, x1 - x0, y1 - y0], 0, resources, `q ${x1 - x0} 0 0 ${y1 - y0} 0 0 cm /Scan Do Q`),
    );
    pixmap.destroy();
    page.destroy();
  }
  fs.writeFileSync(`${out}/scanned-book.pdf`, doc.saveToBuffer('compress=yes').asUint8Array());
}
{
  const source = new mupdf.PDFDocument(fs.readFileSync('.fixtures/drive/10._Desgarros_-_Distocia_de_Hombros_2024.pdf'));
  const doc = new mupdf.PDFDocument();
  let count = 0;
  for (let num = 1; num < source.countObjects() && count < pages; num++) {
    const ref = source.newIndirect(num);
    if (!ref.isStream() || ref.resolve().get('Subtype').toString() !== '/Image') continue;
    if (ref.resolve().get('Filter').toString() !== '/DCTDecode' || !ref.resolve().get('SMask').isNull()) continue;
    const small = source.loadImage(ref).toPixmap();
    if (small.getWidth() < 300) continue;
    const scale = 3,
      w = small.getWidth() * scale,
      h = small.getHeight() * scale;
    const big = new mupdf.Pixmap(small.getColorSpace(), [0, 0, w, h], false);
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, big);
    device.fillImage(new mupdf.Image(small), [w, 0, 0, h, 0, 0], 1);
    device.close();
    const image = doc.addImage(new mupdf.Image(big));
    const resources = doc.newDictionary(),
      xobjects = doc.newDictionary();
    xobjects.put('Photo', image);
    resources.put('XObject', xobjects);
    // A 10-inch-wide slide: the enlarged photo holds ~3× the detail it shows.
    const pw = 720,
      ph = Math.round((720 * h) / w);
    doc.insertPage(-1, doc.addPage([0, 0, pw, ph], 0, resources, `q ${pw} 0 0 ${ph} 0 0 cm /Photo Do Q`));
    big.destroy();
    count++;
  }
  fs.writeFileSync(`${out}/photo-slides.pdf`, doc.saveToBuffer('compress=yes').asUint8Array());
}
for (const name of fs.readdirSync(out)) console.log(name, (fs.statSync(`${out}/${name}`).size / 1e6).toFixed(1), 'MB');
