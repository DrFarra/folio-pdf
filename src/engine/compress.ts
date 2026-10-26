import * as mupdf from 'mupdf';
import type { CompressionSettings } from './compression-settings.ts';

// garbage=3 and 4 compare every object with every other (a minute for a 3 MB manual, hours
// for a 200 MB book), and in MuPDF 1.28.1 garbage=2 and above renumber objects this module
// has read and lose their streams. Duplicates that weigh are merged below by hash instead;
// garbage=1 drops what nothing uses and objstms packs the small objects together.
export const COMPRESSED_SAVE = 'garbage=1,compress=yes,objstms=yes,encrypt=keep';

// An image is resampled only when it holds this much more detail than the page shows.
const RESAMPLE_ABOVE = 1.25;
// Below this many pixels an image costs too little to be worth touching.
const SMALL_IMAGE = 96 * 96;
// A recompressed image replaces the original only if it saves at least this share.
const WORTH_SAVING = 0.9;

// MuPDF.js 1.28.1's loadImage wraps the reference pdf_load_image returns in an Image whose
// constructor keeps it again, so destroy() leaves the whole image behind: a 200 MB book ran
// out of memory. The extra reference is released only while the binding's own code (read
// back, minified or not) still does both; a fixed MuPDF.js simply skips this.
export const loadKeepsTwice =
  /new [\w$]+\([\w$]+\._wasm_pdf_load_image\(/.test(mupdf.PDFDocument.prototype.loadImage.toString()) &&
  /typeof [\w$]+\s*===?\s*"number"\)\s*\{?\s*[\w$]+\s*=\s*[\w$]+\._wasm_keep_image\(/.test(mupdf.Image.toString());

export function loadImage(doc: mupdf.PDFDocument, ref: mupdf.PDFObject) {
  const image = doc.loadImage(ref);
  if (loadKeepsTwice) (mupdf.Image as unknown as { _drop: (pointer: number) => void })._drop(image.pointer);
  return image;
}

/** Reports work done out of the total (pages measured plus images considered). */
export type Progress = (done: number, total: number) => void;

/** Shrinks `doc` in place; save it with COMPRESSED_SAVE. Every image that cannot be
 * recompressed safely (or would not get smaller) is left exactly as it was. */
export function compressDocument(doc: mupdf.PDFDocument, settings: CompressionSettings, progress?: Progress) {
  removeUnusedData(doc);
  if (settings.quality > 0) {
    recompressImages(doc, settings, progress);
    subsetFonts(doc);
  }
  mergeDuplicateStreams(doc);
}

/** Keeps only the glyphs the pages use. Not in forms, whose fields may later be typed in
 * with any character; a failure part-way is rolled back. */
function subsetFonts(doc: mupdf.PDFDocument) {
  const fields = doc.getTrailer().get('Root', 'AcroForm', 'Fields');
  if (fields.isArray() && fields.length) return;
  doc.enableJournal();
  doc.beginOperation('Subset fonts');
  try {
    doc.subsetFonts();
    doc.endOperation();
  } catch {
    doc.abandonOperation();
  }
}

/** Page thumbnails and application-private data (Illustrator keeps a second copy of the
 * artwork there): no viewer draws them. */
export function removeUnusedData(doc: mupdf.PDFDocument) {
  for (let index = 0, count = doc.countPages(); index < count; index++) {
    const page = doc.findPage(index);
    page.delete('Thumb');
    page.delete('PieceInfo');
  }
  doc.getTrailer().get('Root').delete('PieceInfo');
}

type Need = { width: number; height: number };

function recompressImages(doc: mupdf.PDFDocument, settings: CompressionSettings, progress?: Progress) {
  const masks = new Set<number>();
  const images: number[] = [];
  for (let num = 1, count = doc.countObjects(); num < count; num++) {
    const dict = resolved(doc, num);
    if (!dict || dict.get('Subtype').asName?.() !== 'Image') continue;
    const mask = dict.get('SMask');
    if (mask.isIndirect()) masks.add(mask.asIndirect());
    images.push(num);
  }
  const pages = settings.resolution ? doc.countPages() : 0,
    total = pages + images.length;
  const needs = pages ? displayedSizes(doc, done => progress?.(done, total)) : new Map<number, Need>();
  images.forEach((num, index) => {
    progress?.(pages + index, total);
    if (masks.has(num)) return;
    try {
      recompressImage(doc, num, settings, needs.get(num));
    } catch {
      // A damaged or unusual image stays as it was.
    } finally {
      mupdf.emptyStore();
    }
  });
}

function resolved(doc: mupdf.PDFDocument, num: number) {
  try {
    const object = doc.newIndirect(num);
    return object.isStream() ? object.resolve() : null;
  } catch {
    return null;
  }
}

/** The largest size, in points, each image object is drawn at on any page. An image the
 * pages do not draw (or that cannot be traced to its object) gets no entry and keeps its pixels. */
function displayedSizes(doc: mupdf.PDFDocument, measured: (pages: number) => void) {
  const needs = new Map<number, Need>(),
    unknown = new Set<number>();
  for (let index = 0, count = doc.countPages(); index < count; index++) {
    measured(index);
    const drawn = new Map<number, { image: mupdf.Image; need: Need }>();
    const record = (image: mupdf.Image, ctm: mupdf.Matrix) => {
      const width = Math.hypot(ctm[0], ctm[1]),
        height = Math.hypot(ctm[2], ctm[3]);
      const seen = drawn.get(image.pointer);
      if (!seen) drawn.set(image.pointer, { image, need: { width, height } });
      else {
        seen.need.width = Math.max(seen.need.width, width);
        seen.need.height = Math.max(seen.need.height, height);
        image.destroy();
      }
    };
    const device = new mupdf.Device({
      fillImage: (image: mupdf.Image, ctm: mupdf.Matrix) => record(image, ctm),
      fillImageMask: (image: mupdf.Image, ctm: mupdf.Matrix) => record(image, ctm),
      clipImageMask: (image: mupdf.Image, ctm: mupdf.Matrix) => record(image, ctm),
    });
    let page: mupdf.PDFPage | undefined;
    try {
      page = doc.loadPage(index);
      page.run(device, mupdf.Matrix.identity);
      // MuPDF keeps one Image per image object while anything holds it (the store never
      // evicts a held item), so the page's resources lead from what was drawn back to the objects.
      // Pages often share one resource dictionary listing every image: only an object the
      // size of something drawn here is loaded, so each page does not read every image.
      const sizes = new Set([...drawn.values()].map(({ image }) => `${image.getWidth()}x${image.getHeight()}`));
      for (const num of imageObjects(page.getObject().getInheritable('Resources'))) {
        const ref = doc.newIndirect(num);
        if (!sizes.has(`${ref.get('Width').asNumber()}x${ref.get('Height').asNumber()}`)) continue;
        const image = loadImage(doc, ref);
        const seen = drawn.get(image.pointer);
        image.destroy();
        if (!seen) continue;
        const need = needs.get(num);
        needs.set(num, {
          width: Math.max(need?.width ?? 0, seen.need.width),
          height: Math.max(need?.height ?? 0, seen.need.height),
        });
      }
    } catch {
      // A page that cannot be read leaves its images at full resolution.
      for (const num of safeImageObjects(page)) unknown.add(num);
    } finally {
      device.destroy();
      page?.destroy();
      for (const { image } of drawn.values()) image.destroy();
      mupdf.emptyStore();
    }
  }
  for (const num of unknown) needs.delete(num);
  return needs;
}

function safeImageObjects(page?: mupdf.PDFPage) {
  try {
    return page ? imageObjects(page.getObject().getInheritable('Resources')) : [];
  } catch {
    return [];
  }
}

/** Image objects a resource dictionary reaches, through forms and patterns. */
function imageObjects(resources: mupdf.PDFObject, found = new Set<number>(), visited = new Set<number>()) {
  if (!resources.isDictionary()) return found;
  for (const kind of ['XObject', 'Pattern']) {
    resources.get(kind).forEach(entry => {
      if (!entry.isIndirect()) return;
      const num = entry.asIndirect();
      if (visited.has(num)) return;
      visited.add(num);
      const value = entry.resolve();
      if (value.get('Subtype').asName?.() === 'Image') found.add(num);
      else imageObjects(value.get('Resources'), found, visited);
    });
  }
  return found;
}

const plainSpaces = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK']);
const encodedAs = new Set(['DCTDecode', 'FlateDecode', 'LZWDecode', 'RunLengthDecode', 'JPXDecode']);

/** Components of a colour space whose samples can be resampled and written back as they are. */
function components(space: mupdf.PDFObject) {
  if (space.isName())
    return plainSpaces.has(space.asName()) ? ({ DeviceGray: 1, DeviceRGB: 3 }[space.asName()] ?? 4) : 0;
  if (!space.isArray()) return 0;
  const family = space.get(0).asName?.();
  if (family === 'ICCBased') {
    const n = space.get(1, 'N').asNumber();
    return [1, 3, 4].includes(n) ? n : 0;
  }
  if (family === 'CalRGB') return 3;
  if (family === 'CalGray') return 1;
  return 0;
}

function filters(dict: mupdf.PDFObject) {
  const filter = dict.get('Filter');
  if (filter.isNull()) return [];
  if (filter.isName()) return [filter.asName()];
  const names: string[] = [];
  filter.forEach(name => names.push(name.isName() ? name.asName() : ''));
  return names;
}

function recompressImage(doc: mupdf.PDFDocument, num: number, settings: CompressionSettings, need?: Need) {
  const ref = doc.newIndirect(num),
    dict = ref.resolve();
  const width = dict.get('Width').asNumber(),
    height = dict.get('Height').asNumber();
  const encoding = filters(dict);
  const jpx = encoding.includes('JPXDecode');
  const n = components(dict.get('ColorSpace'));
  if (
    !n ||
    width * height < SMALL_IMAGE ||
    dict.get('ImageMask').asBoolean?.() ||
    !dict.get('Mask').isNull() ||
    !dict.get('Decode').isNull() ||
    !dict.get('SMaskInData').isNull() ||
    (!jpx && dict.get('BitsPerComponent').asNumber() < 8) ||
    !encoding.every(name => encodedAs.has(name))
  )
    return;
  const mask = dict.get('SMask');
  if (mask.isIndirect() && (!mask.get('Matte').isNull() || !mask.get('Decode').isNull())) return;
  const encoded = ref.readRawStream();
  const original = encoded.getLength(),
    jpeg = encoding.length === 1 && encoding[0] === 'DCTDecode';
  // A JPEG already at or below the asked quality only loses detail when encoded again.
  const sourceQuality = jpeg ? jpegQuality(encoded.asUint8Array()) : null;
  encoded.destroy();
  const scale = need ? sampleScale(width, height, need, settings.resolution) : 1;
  if (scale === 1 && sourceQuality !== null && sourceQuality <= settings.quality + 7) return;

  const target = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  const pixels = decoded(doc, ref, n);
  if (!pixels) return;
  const samples = scale < 1 ? resample(pixels, width, height, n, target.width, target.height) : pixels;
  const photo = jpeg || jpx || encoding.includes('DCTDecode') || !fewColours(samples, n);

  if (photo) {
    const jpeg = encodeJpeg(samples, target.width, target.height, n, settings.quality, original * WORTH_SAVING);
    if (!jpeg) return;
    if (scale < 1 && !scaleMask(doc, mask, width, height, target)) return;
    ref.writeRawStream(jpeg);
    dict.put('Filter', doc.newName('DCTDecode'));
  } else {
    // Drawings, charts and screenshots keep sharp edges: only fewer pixels, losslessly.
    if (scale === 1) return;
    if (!scaleMask(doc, mask, width, height, target)) return;
    ref.writeStream(samples);
    dict.delete('Filter');
  }
  dict.delete('DecodeParms');
  dict.put('Width', target.width);
  dict.put('Height', target.height);
  dict.put('BitsPerComponent', 8);
}

/** The share of pixels to keep so the image still has `resolution` pixels per inch where it is largest. */
export function sampleScale(width: number, height: number, need: Need, resolution: number) {
  if (!need.width || !need.height) return 1;
  const scale = Math.max(((need.width / 72) * resolution) / width, ((need.height / 72) * resolution) / height);
  return scale * RESAMPLE_ABOVE < 1 ? scale : 1;
}

/** The image's 8-bit samples in its own colour space, or null when MuPDF would change them. */
function decoded(doc: mupdf.PDFDocument, ref: mupdf.PDFObject, n: number) {
  const image = loadImage(doc, ref);
  const pixmap = image.toPixmap();
  try {
    if (pixmap.getNumberOfComponents() !== n || pixmap.getAlpha()) return null;
    const width = pixmap.getWidth(),
      height = pixmap.getHeight(),
      stride = pixmap.getStride(),
      source = pixmap.getPixels();
    if (stride === width * n) return new Uint8Array(source);
    const samples = new Uint8Array(width * height * n);
    for (let y = 0; y < height; y++) samples.set(source.subarray(y * stride, y * stride + width * n), y * width * n);
    return samples;
  } finally {
    pixmap.destroy();
    image.destroy();
  }
}

/** Area-average resampling: each new pixel is the exact mean of the source area it covers. */
export function resample(
  source: Uint8Array,
  width: number,
  height: number,
  n: number,
  toWidth: number,
  toHeight: number,
) {
  const columns = weights(width, toWidth),
    rows = weights(height, toHeight);
  // Each source row is shrunk horizontally once, then added to the target rows it covers.
  const line = new Float32Array(toWidth * n),
    sums = new Float32Array(toWidth * n);
  const out = new Uint8Array(toWidth * toHeight * n);
  let shrunk = -1;
  for (let to = 0; to < toHeight; to++) {
    sums.fill(0);
    for (let k = rows.offset[to]; k < rows.offset[to + 1]; k++) {
      // Neighbouring target rows share the source row on their border.
      if (rows.index[k] !== shrunk) shrinkRow(source, (shrunk = rows.index[k]) * width * n, n, columns, line);
      const weight = rows.share[k];
      for (let i = 0; i < line.length; i++) sums[i] += line[i] * weight;
    }
    const base = to * toWidth * n;
    for (let i = 0; i < sums.length; i++) out[base + i] = sums[i] + 0.5;
  }
  return out;
}

function shrinkRow(source: Uint8Array, start: number, n: number, columns: Weights, line: Float32Array) {
  const { offset, index, share } = columns;
  line.fill(0);
  for (let x = 0, to = 0; x < offset.length - 1; x++, to += n)
    for (let k = offset[x]; k < offset[x + 1]; k++) {
      const at = start + index[k] * n,
        weight = share[k];
      for (let c = 0; c < n; c++) line[to + c] += source[at + c] * weight;
    }
}

type Weights = { offset: Int32Array; index: Int32Array; share: Float32Array };

/** For each target cell, the source cells it covers (index[offset[i]…offset[i+1]]) and the
 * share of each, summing to 1. */
function weights(size: number, toSize: number): Weights {
  const ratio = size / toSize,
    offset = new Int32Array(toSize + 1),
    index: number[] = [],
    share: number[] = [];
  for (let to = 0; to < toSize; to++) {
    const start = to * ratio,
      end = start + ratio;
    for (let from = Math.floor(start); from < Math.min(size, Math.ceil(end)); from++) {
      const covered = Math.min(end, from + 1) - Math.max(start, from);
      if (covered > 1e-9) {
        index.push(from);
        share.push(covered / ratio);
      }
    }
    offset[to + 1] = index.length;
  }
  return { offset, index: Int32Array.from(index), share: Float32Array.from(share) };
}

/** True for flat artwork (a logo, a chart, a screenshot of text): few distinct colours. */
export function fewColours(samples: Uint8Array, n: number) {
  const colours = new Set<number>(),
    pixels = samples.length / n,
    step = Math.max(1, Math.floor(pixels / 200000));
  for (let p = 0; p < pixels; p += step) {
    let colour = 0;
    for (let c = 0; c < n; c++) colour = colour * 256 + samples[p * n + c];
    colours.add(colour);
    if (colours.size > 4096) return false;
  }
  return true;
}

/** The smallest JPEG at `quality` or above that stays faithful to `samples` (if the
 * difference shows in the whole image or in any patch of it, quality goes up), or null
 * when none is smaller than `limit` bytes. */
function encodeJpeg(samples: Uint8Array, width: number, height: number, n: number, quality: number, limit: number) {
  const space =
    n === 1 ? mupdf.ColorSpace.DeviceGray : n === 3 ? mupdf.ColorSpace.DeviceRGB : mupdf.ColorSpace.DeviceCMYK;
  const pixmap = new mupdf.Pixmap(space, [0, 0, width, height], false);
  try {
    pixmap.getPixels().set(samples);
    const floor = fidelityFloor(quality);
    for (let q = quality; q <= 95; q += 6) {
      const jpeg = pixmap.asJPEG(q, false);
      // A higher quality only makes it larger.
      if (jpeg.length >= limit) return null;
      const back = decodeJpeg(jpeg, n);
      if (back && back.length === samples.length && faithful(samples, back, width, height, n, floor)) return jpeg;
    }
    return null;
  } finally {
    pixmap.destroy();
  }
}

// The IJG luminance table at quality 50, which encoders scale for every other quality.
const BASE_LUMINANCE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
  87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
].reduce((sum, value) => sum + value, 0);

/** The IJG quality (1–100) a JPEG was saved at, from its first quantization table; null if unreadable. */
export function jpegQuality(jpeg: Uint8Array) {
  for (let i = 2; i + 4 < jpeg.length;) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1],
      length = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (marker === 0xdb) {
      const precision = jpeg[i + 4] >> 4;
      let sum = 0;
      for (let k = 0; k < 64; k++)
        sum += precision ? (jpeg[i + 5 + 2 * k] << 8) | jpeg[i + 6 + 2 * k] : jpeg[i + 5 + k];
      const scale = (sum * 100) / BASE_LUMINANCE;
      return Math.max(1, Math.min(100, Math.round(scale <= 100 ? (200 - scale) / 2 : 5000 / scale)));
    }
    if (marker === 0xda || length < 2) return null;
    i += 2 + length;
  }
  return null;
}

/** The PSNR, in dB, an image must keep at `quality`: 37.6 dB at 88, 31 dB at 55. */
export const fidelityFloor = (quality: number) => 20 + quality * 0.2;

function decodeJpeg(jpeg: Uint8Array, n: number) {
  const image = new mupdf.Image(jpeg);
  const pixmap = image.toPixmap();
  try {
    if (pixmap.getNumberOfComponents() !== n || pixmap.getStride() !== pixmap.getWidth() * n) return null;
    const samples = new Uint8Array(pixmap.getPixels());
    // On its own, MuPDF reads a CMYK JPEG's Adobe marker as inverted; inside a PDF it is not.
    if (n === 4) for (let i = 0; i < samples.length; i++) samples[i] = 255 - samples[i];
    return samples;
  } finally {
    pixmap.destroy();
    image.destroy();
  }
}

/** PSNR of the whole image above `floor`, and of every 32×32 patch above `floor - 6`,
 * so text or a face in one corner is not traded for a smooth sky elsewhere. */
export function faithful(a: Uint8Array, b: Uint8Array, width: number, height: number, n: number, floor: number) {
  const block = 32,
    psnr = (sum: number, count: number) => (sum ? 10 * Math.log10((255 * 255 * count) / sum) : Infinity);
  let total = 0;
  for (let by = 0; by < height; by += block)
    for (let bx = 0; bx < width; bx += block) {
      let sum = 0,
        count = 0;
      for (let y = by; y < Math.min(height, by + block); y++)
        for (let i = (y * width + bx) * n, end = (y * width + Math.min(width, bx + block)) * n; i < end; i++) {
          const d = a[i] - b[i];
          sum += d * d;
          count++;
        }
      if (psnr(sum, count) < floor - 6) return false;
      total += sum;
    }
  return psnr(total, a.length) >= floor;
}

/** Resamples an image's soft mask to its new size; false when that is not possible, so the image stays. */
function scaleMask(
  doc: mupdf.PDFDocument,
  mask: mupdf.PDFObject,
  width: number,
  height: number,
  target: { width: number; height: number },
) {
  if (mask.isNull()) return true;
  if (!mask.isIndirect()) return false;
  const dict = mask.resolve();
  if (dict.get('Width').asNumber() !== width || dict.get('Height').asNumber() !== height) return true;
  const samples = decoded(doc, mask, 1);
  if (!samples) return false;
  mask.writeStream(resample(samples, width, height, 1, target.width, target.height));
  dict.delete('Filter');
  dict.delete('DecodeParms');
  dict.put('Width', target.width);
  dict.put('Height', target.height);
  dict.put('BitsPerComponent', 8);
  dict.put('ColorSpace', doc.newName('DeviceGray'));
  return true;
}

/** Points every reference to a heavy stream (an image, a font, a form) at the first
 * identical copy. Merged documents often carry the same logo or font once per page. */
export function mergeDuplicateStreams(doc: mupdf.PDFDocument) {
  const first = new Map<string, number>(),
    duplicate = new Map<number, number>();
  for (let num = 1, count = doc.countObjects(); num < count; num++) {
    try {
      const ref = doc.newIndirect(num);
      if (!ref.isStream()) continue;
      const raw = rawBytes(ref);
      if (raw.length < 2048) continue;
      const dict = ref.resolve();
      const key = `${digest(raw)}:${raw.length}:${dictionaryKey(dict)}`;
      const original = first.get(key);
      if (original === undefined) first.set(key, num);
      else if (sameBytes(rawBytes(doc.newIndirect(original)), raw)) duplicate.set(num, original);
    } catch {
      // Unreadable streams are left alone.
    }
  }
  if (!duplicate.size) return;
  const visited = new Set<number>();
  const relink = (object: mupdf.PDFObject) => {
    if (object.isIndirect()) {
      const num = object.asIndirect();
      if (visited.has(num)) return;
      visited.add(num);
      object = object.resolve();
    }
    if (object.isArray()) {
      for (let i = 0; i < object.length; i++) {
        const item = object.get(i);
        const target = item.isIndirect() ? duplicate.get(item.asIndirect()) : undefined;
        if (target !== undefined) object.put(i, doc.newIndirect(target));
        else relink(item);
      }
    } else if (object.isDictionary()) {
      const keys: string[] = [];
      object.forEach((_value, key) => keys.push(String(key)));
      for (const key of keys) {
        const item = object.get(key);
        const target = item.isIndirect() ? duplicate.get(item.asIndirect()) : undefined;
        if (target !== undefined) object.put(key, doc.newIndirect(target));
        else relink(item);
      }
    }
  };
  for (let num = 1, count = doc.countObjects(); num < count; num++)
    if (!duplicate.has(num))
      try {
        relink(doc.newIndirect(num));
      } catch {
        // An object that cannot be read keeps its references.
      }
  relink(doc.getTrailer());
}

/** A copy of the stream's encoded bytes (MuPDF's own buffer is not indexable, and its
 * memory may move when the engine grows). */
function rawBytes(ref: mupdf.PDFObject) {
  const buffer = ref.readRawStream();
  try {
    return buffer.asUint8Array().slice();
  } finally {
    buffer.destroy();
  }
}

/** The dictionary without its length, which identical streams may still write differently. */
function dictionaryKey(dict: mupdf.PDFObject) {
  const keys: string[] = [];
  dict.forEach((value, key) => {
    if (key !== 'Length') keys.push(`${key}=${value.toString(true)}`);
  });
  return keys.sort().join(';');
}

function digest(bytes: Uint8Array) {
  let a = 0x811c9dc5,
    b = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b + bytes[i], 0x85ebca6b) ^ (b >>> 13);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
