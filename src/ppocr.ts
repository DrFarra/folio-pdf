// Folio's OCR engine: PaddleOCR's PP-OCRv5 models (text detection, line orientation,
// Latin recognition for Spanish and English) run with ONNX Runtime. The pre- and
// post-processing is written here, in plain code with no imports, so the browser
// worker and the Node tests run exactly the same steps.
import type * as Ort from 'onnxruntime-web';

export type Pixels = { data: ArrayLike<number>; width: number; height: number; channels: number };
export type Box = [number, number, number, number];
/** A recognised word: its text, its box in image pixels, and each letter's left and right edge. */
export type OcrWord = { text: string; box: Box; score: number; letters: [number, number][] };
export type OcrLine = { text: string; box: Box; score: number; words: OcrWord[] };
export type Models = { det?: Uint8Array; rec?: Uint8Array; cls?: Uint8Array; dict: string };
/**
 * A text line's rectangle, turned with the line: its top-left corner, the unit vector
 * along the text (down the rectangle is that vector turned a right angle clockwise),
 * and its length and height, in image pixels.
 */
export type Frame = { x: number; y: number; ux: number; uy: number; length: number; height: number };
/** A detected line: its frame, the upright box around it, whether it reads upside down, and its ink's top and bottom. */
export type Found = { frame: Frame; box: Box; flipped: boolean; ink: [number, number] };
/** A line ready for the recogniser: 3 × 48 × width floats, its text `resized` wide and padded after. */
export type Prepared = Omit<Found, 'ink'> & { input: Float32Array; width: number; resized: number };
export type Read = Omit<OcrLine, 'box'>;
/** providers: ONNX Runtime execution providers, in order; batch: lines read together (worth it on a GPU). */
export type Options = { detSide?: number; boxThreshold?: number; textThreshold?: number; providers?: string[]; batch?: number };

const IMAGENET_MEAN = [0.485, 0.456, 0.406], IMAGENET_STD = [0.229, 0.224, 0.225];
const level = (frame: Frame) => frame.uy === 0;
const upright = (box: Box): Frame => ({ x: box[0], y: box[1], ux: 1, uy: 0, length: box[2] - box[0], height: box[3] - box[1] });
const corners = ({ x, y, ux, uy, length, height }: Frame) => [[x, y], [x + length * ux, y + length * uy], [x + length * ux - height * uy, y + length * uy + height * ux], [x - height * uy, y + height * ux]];
const bounds = (points: number[][]): Box => [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];

/** Lines and what was read in them, without the empty or doubtful ones. */
export function assemble(found: Found[], read: Read[]): OcrLine[] {
  // Pieces of one row (a line split at a wide gap) share their ink height, so the
  // written text stays one line: same top, same bottom, same baseline.
  const rows = found.map(line => [...line.ink] as [number, number]);
  for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) {
    const a = rows[i], b = rows[j], overlap = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
    if (level(found[i].frame) && level(found[j].frame) && overlap > .6 * Math.min(a[1] - a[0], b[1] - b[0])) rows[i] = rows[j] = [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
  }
  // Level words take the row's ink height, the same for every word, as typeset text has.
  return found.map(({ box, frame }, i, all) => ({ box, frame, ink: rows[i] ?? all[i].ink })).map(({ box, frame, ink }, i) => level(frame)
    ? { ...read[i], words: read[i].words.map(word => ({ ...word, box: [word.box[0], ink[0], word.box[2], ink[1]] as Box })), box: [box[0], ink[0], box[2], ink[1]] as Box }
    : { ...read[i], box })
    .filter(line => line.text.trim() && line.score >= .5);
}

/**
 * Words snapped to their ink. The recogniser places a letter where it is surest of it,
 * inside the letter, so its word boxes fall short of the ink and leave wide gaps; each
 * word grows to the first and last inked column between the middles of the gaps
 * around it. Letters move with their word.
 */
export function fitWords(image: Pixels, found: Found[], read: Read[]): Read[] {
  const { data, width: w, channels: n } = image;
  const light = (x: number, y: number) => { const i = (y * w + x) * n; return n >= 3 ? (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 : data[i]; };
  return read.map((line, i) => {
    const { frame, box, ink } = found[i];
    if (!level(frame) || !line.words.length) return line;
    const y0 = Math.max(0, Math.floor(ink[0])), y1 = Math.min(image.height, Math.ceil(ink[1])), x0 = Math.max(0, Math.floor(box[0])), x1 = Math.min(w, Math.ceil(box[2]));
    let low = 255, high = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const v = light(x, y); if (v < low) low = v; if (v > high) high = v; }
    if (high - low < 40) return line;
    const threshold = (low + high) / 2, inked = (x: number) => { for (let y = y0; y < y1; y++) if (light(x, y) < threshold) return true; return false; };
    const words = [...line.words].sort((a, b) => a.box[0] - b.box[0]);
    // Each boundary between two words is the widest blank gap near where the recogniser put
    // it (it places letters inside them, so a midpoint can fall inside the next word's first letter).
    const blanks: [number, number][] = [];
    for (let x = x0, start = -1; x <= x1; x++) { const empty = x < x1 && !inked(x); if (empty && start < 0) start = x; if (!empty && start >= 0) { blanks.push([start, x]); start = -1; } }
    const reach = (y1 - y0) * .8;
    const boundaries = words.slice(1).map((word, k) => {
      const target = (words[k].box[2] + word.box[0]) / 2;
      let best: [number, number] | null = null, value = -Infinity;
      for (const [a, b] of blanks) { const centre = (a + b) / 2; if (Math.abs(centre - target) > reach) continue; const v = (b - a) - Math.abs(centre - target) * .3; if (v > value) { value = v; best = [a, b]; } }
      return best ?? [Math.round(target), Math.round(target)] as [number, number];
    });
    return { ...line, words: words.map((word, k) => {
      let left = -1, right = -1;
      const from = Math.max(x0, k ? boundaries[k - 1][1] : Math.floor(box[0])), to = Math.min(x1, k < words.length - 1 ? boundaries[k][0] : Math.ceil(box[2]));
      for (let x = from; x < to; x++) if (inked(x)) { if (left < 0) left = x; right = x + 1; }
      if (left < 0) return word;
      const scale = (right - left) / Math.max(1, word.box[2] - word.box[0]), move = (x: number) => left + (x - word.box[0]) * scale;
      return { ...word, box: [left, word.box[1], right, word.box[3]] as Box, letters: word.letters.map(([a, b]) => [move(a), move(b)] as [number, number]) };
    }) };
  });
}

/** CHW float input in BGR order (as PaddleOCR reads images), sampled bilinearly along a frame of the image. */
function tensorFrom(image: Pixels, frame: Frame, width: number, height: number, normalize: (value: number, channel: number) => number, out = new Float32Array(3 * width * height), stride = width, flip = false) {
  const { data, width: w, height: h, channels: n } = image, { x: x0, y: y0, ux, uy } = frame;
  const sx = frame.length / width, sy = frame.height / height, plane = stride * height;
  for (let y = 0; y < height; y++) {
    const t = (y + .5) * sy;
    for (let x = 0; x < width; x++) {
      const s = (x + .5) * sx;
      const fx = Math.min(w - 1, Math.max(0, x0 + s * ux - t * uy - .5)), fy = Math.min(h - 1, Math.max(0, y0 + s * uy + t * ux - .5));
      const xa = Math.floor(fx), xb = Math.min(w - 1, xa + 1), ax = fx - xa, ya = Math.floor(fy), yb = Math.min(h - 1, ya + 1), ay = fy - ya;
      const o = flip ? (height - 1 - y) * stride + (width - 1 - x) : y * stride + x;
      for (let c = 0; c < 3; c++) {
        const k = n >= 3 ? 2 - c : 0; // BGR
        const v = (data[(ya * w + xa) * n + k] * (1 - ax) + data[(ya * w + xb) * n + k] * ax) * (1 - ay) + (data[(yb * w + xa) * n + k] * (1 - ax) + data[(yb * w + xb) * n + k] * ax) * ay;
        out[c * plane + o] = normalize(v / 255, c);
      }
    }
  }
  return out;
}

/**
 * Text lines from DB's probability map: connected pixels above the threshold, each
 * fitted with a rectangle turned to its own slope (so a tilted scan's lines do not
 * overlap), scored, and grown back from DB's shrunk kernel to the text's size.
 */
function regions(prob: Float32Array, w: number, h: number, threshold: number, boxThreshold: number): Frame[] {
  const seen = new Uint8Array(w * h), queue = new Int32Array(w * h), frames: Frame[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= threshold) continue;
    let head = 0, tail = 0, sx = 0, sy = 0;
    seen[start] = 1; queue[tail++] = start;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = (p - x) / w;
      sx += x; sy += y;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && !seen[q] && prob[q] > threshold) { seen[q] = 1; queue[tail++] = q; }
      }
    }
    if (tail < 9) continue;
    // The line's slope from the spread of its pixels; a nearly level line stays exactly level.
    const mx = sx / tail, my = sy / tail; let xx = 0, yy = 0, xy = 0;
    for (let i = 0; i < tail; i++) { const p = queue[i], x = p % w - mx, y = (p - p % w) / w - my; xx += x * x; yy += y * y; xy += x * y; }
    let angle = .5 * Math.atan2(2 * xy, xx - yy);
    if (Math.abs(angle) < .01 || Math.abs(angle) > Math.PI / 4) angle = 0;
    const ux = Math.cos(angle), uy = angle ? Math.sin(angle) : 0;
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity, sum = 0;
    for (let i = 0; i < tail; i++) {
      const p = queue[i], x = p % w - mx, y = (p - p % w) / w - my, s = x * ux + y * uy, t = -x * uy + y * ux;
      if (s < s0) s0 = s; if (s > s1) s1 = s; if (t < t0) t0 = t; if (t > t1) t1 = t; sum += prob[p];
    }
    const length = s1 - s0 + 1, height = t1 - t0 + 1;
    if (Math.min(length, height) < 3 || sum / (length * height) < boxThreshold) continue;
    // DB predicts a shrunk text kernel: grow it back by area × 1.5 / perimeter.
    const grow = length * height * 1.5 / (2 * (length + height)), s = s0 - .5 - grow, t = t0 - .5 - grow;
    frames.push({ x: mx + .5 + s * ux - t * uy, y: my + .5 + s * uy + t * ux, ux, uy, length: length + 2 * grow, height: height + 2 * grow });
  }
  return frames;
}

/** Reading order within a row: top to bottom, and left to right. */
function rowOrder<T extends { box: Box }>(items: T[]) {
  items.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  for (let i = 1; i < items.length; i++) for (let j = i; j > 0; j--) {
    const a = items[j - 1].box, b = items[j].box, tolerance = Math.min(a[3] - a[1], b[3] - b[1]) * .5;
    if (Math.abs(b[1] - a[1]) < tolerance && b[0] < a[0]) [items[j - 1], items[j]] = [items[j], items[j - 1]]; else break;
  }
  return items;
}
/**
 * Reading order by recursive XY-cut: the page splits at the widest blank band across it,
 * into rows read top to bottom, and each row at blank gaps down it, into columns read
 * left to right; so the two columns of an article are each read through.
 */
function readingOrder<T extends { box: Box }>(items: T[]): T[] {
  if (items.length < 3) return rowOrder(items);
  const heights = items.map(({ box }) => box[3] - box[1]).sort((a, b) => a - b), line = heights[heights.length >> 1];
  const cut = (axis: 0 | 1, least: number) => {
    // Blank gaps along an axis: intervals no box covers.
    const spans = items.map(({ box }) => [box[axis], box[axis + 2]]).sort((a, b) => a[0] - b[0]);
    let end = spans[0][1], best = -1, at = 0;
    for (const [from, to] of spans.slice(1)) { if (from - end > best && from - end >= least) { best = from - end; at = (from + end) / 2; } end = Math.max(end, to); }
    return best >= 0 ? at : null;
  };
  const middle = (box: Box, axis: 0 | 1) => (box[axis] + box[axis + 2]) / 2;
  const across = cut(1, line * .6);
  if (across != null) return [...readingOrder(items.filter(({ box }) => middle(box, 1) < across)), ...readingOrder(items.filter(({ box }) => middle(box, 1) >= across))];
  const down = cut(0, line * 1.2);
  if (down != null) return [...readingOrder(items.filter(({ box }) => middle(box, 0) < down)), ...readingOrder(items.filter(({ box }) => middle(box, 0) >= down))];
  return rowOrder(items);
}

/**
 * The ink's rows in a box, as one band or, when blank rows split it into lines of
 * text, one band each: [top, bottom] of the ink, then the box's own rows for that band.
 */
function inkBands(image: Pixels, box: Box): number[][] {
  const whole = inkRows(image, box), { data, width: w, channels: n } = image;
  const x0 = Math.max(0, Math.floor(box[0])), x1 = Math.min(w, Math.ceil(box[2])), y0 = Math.max(0, Math.floor(whole[0])), y1 = Math.min(image.height, Math.ceil(whole[1]));
  if (y1 - y0 < 8) return [whole];
  const light = (x: number, y: number) => { const i = (y * w + x) * n; return n >= 3 ? (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 : data[i]; };
  let low = 255, high = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const v = light(x, y); if (v < low) low = v; if (v > high) high = v; }
  const threshold = (low + high) / 2, least = Math.max(1, (x1 - x0) * .004), rows: boolean[] = [];
  for (let y = y0; y < y1; y++) { let ink = 0; for (let x = x0; x < x1; x++) if (light(x, y) < threshold) ink++; rows.push(ink >= least); }
  const bands: [number, number][] = []; let start = -1;
  rows.forEach((inked, k) => { if (inked && start < 0) start = k; if (!inked && start >= 0) { bands.push([y0 + start, y0 + k]); start = -1; } });
  if (start >= 0) bands.push([y0 + start, y1]);
  // Bands too thin to be a line (an accent, a dot, a rule) join the band next to them.
  const tall = Math.max(...bands.map(([a, b]) => b - a)), lines = bands.filter(([a, b]) => b - a >= tall * .45);
  if (lines.length < 2) return [whole];
  return lines.map(([a, b], k) => {
    const top = k ? (lines[k - 1][1] + a) / 2 : box[1], bottom = k < lines.length - 1 ? (b + lines[k + 1][0]) / 2 : box[3];
    const own = bands.filter(([c, d]) => c >= top && d <= bottom);
    return [Math.min(...own.map(o => o[0])), Math.max(...own.map(o => o[1])), top, bottom];
  });
}

/** Top and bottom of the ink in a box: where its darker pixels begin and end. */
function inkRows(image: Pixels, box: Box): [number, number] {
  const { data, width: w, channels: n } = image, x0 = Math.max(0, Math.floor(box[0])), x1 = Math.min(w, Math.ceil(box[2])), y0 = Math.max(0, Math.floor(box[1])), y1 = Math.min(image.height, Math.ceil(box[3]));
  const light = (x: number, y: number) => { const i = (y * w + x) * n; return n >= 3 ? (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 : data[i]; };
  let low = 255, high = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const v = light(x, y); if (v < low) low = v; if (v > high) high = v; }
  if (high - low < 40) return [box[1], box[3]];
  const threshold = (low + high) / 2, least = Math.max(1, (x1 - x0) * .01);
  let top = -1, bottom = -1;
  for (let y = y0; y < y1; y++) { let ink = 0; for (let x = x0; x < x1; x++) if (light(x, y) < threshold) ink++; if (ink >= least) { if (top < 0) top = y; bottom = y + 1; } }
  return top < 0 ? [box[1], box[3]] : [top, bottom];
}

export class PaddleOcr {
  private ort: typeof Ort; private det: Ort.InferenceSession | null; private rec: Ort.InferenceSession | null; private cls: Ort.InferenceSession | null;
  private alphabet: string[]; private options: Required<Options>;
  private constructor(ort: typeof Ort, det: Ort.InferenceSession | null, rec: Ort.InferenceSession | null, cls: Ort.InferenceSession | null, alphabet: string[], options: Required<Options>) {
    this.ort = ort; this.det = det; this.rec = rec; this.cls = cls; this.alphabet = alphabet; this.options = options;
  }

  static async create(ort: typeof Ort, models: Models, options: Options = {}) {
    const settings: Ort.InferenceSession.SessionOptions = { executionProviders: options.providers ?? ['wasm'], graphOptimizationLevel: 'all' };
    // One after another: the WebGPU provider creates a single session at a time.
    const load = (model?: Uint8Array) => model ? ort.InferenceSession.create(model, settings) : null;
    const det = await load(models.det), rec = await load(models.rec), cls = await load(models.cls);
    // CTC classes: blank, the dictionary, then the space.
    const alphabet = ['', ...models.dict.split(/\r?\n/).filter((line, i, all) => line !== '' || i < all.length - 1), ' '];
    return new PaddleOcr(ort, det, rec, cls, alphabet, { detSide: 1600, boxThreshold: .5, textThreshold: .3, providers: ['wasm'], batch: 1, ...options });
  }

  /** The text lines of a page image, in reading order, with word and letter positions in its pixels. */
  async recognize(image: Pixels, signal?: AbortSignal): Promise<OcrLine[]> {
    const found = await this.lines(image, signal);
    const read = await this.read(found.map(line => PaddleOcr.cut(image, line)), signal);
    return assemble(found, fitWords(image, found, read));
  }

  /** Where the text lines are, in reading order, and which are upside down. Needs det (and cls). */
  async lines(image: Pixels, signal?: AbortSignal): Promise<Found[]> {
    const found = await this.detect(image);
    signal?.throwIfAborted();
    const flipped = await this.orientations(image, found.map(line => line.frame));
    const lines = found.flatMap(({ frame, box }, i): Found[] => {
      if (!level(frame)) return [{ frame, box, flipped: flipped[i], ink: [box[1], box[3]] }];
      // Two close lines the detector took as one are told apart by the blank rows between them.
      return inkBands(image, box).map(ink => {
        const band: Box = ink.length > 2 ? [box[0], ink[2], box[2], ink[3]] : box;
        return { frame: upright(band), box: band, flipped: flipped[i], ink: [ink[0], ink[1]] as [number, number] };
      });
    });
    return lines.length > found.length ? readingOrder(lines) : lines;
  }

  /** One line cut out along its frame and scaled to the recogniser's 48 pixels of height. */
  static cut(image: Pixels, { frame, box, flipped }: Found): Prepared {
    const resized = Math.max(8, Math.min(3200, Math.ceil(48 * frame.length / Math.max(1, frame.height))));
    const width = Math.ceil(Math.max(resized, 96) / 8) * 8;
    return { input: tensorFrom(image, frame, resized, 48, v => (v - .5) / .5, new Float32Array(3 * 48 * width), width, flipped), width, resized, frame, box, flipped };
  }

  /** The text of prepared lines. Needs rec only, so several engines can share a page's lines. */
  async read(lines: Prepared[], signal?: AbortSignal): Promise<Read[]> {
    const { ort } = this, results: Read[] = new Array(lines.length);
    // Lines of about the same width share a batch, padded to the widest of them.
    const order = lines.map((_, i) => i).sort((a, b) => lines[a].width - lines[b].width);
    for (let start = 0; start < order.length; start += this.options.batch) {
      signal?.throwIfAborted();
      const group = order.slice(start, start + this.options.batch), width = Math.max(...group.map(i => lines[i].width));
      let input = lines[group[0]].input;
      if (group.length > 1 || width !== lines[group[0]].width) {
        input = new Float32Array(group.length * 3 * 48 * width);
        group.forEach((i, k) => { const line = lines[i]; for (let row = 0; row < 3 * 48; row++) input.set(line.input.subarray(row * line.width, (row + 1) * line.width), (k * 3 * 48 + row) * width); });
      }
      const result = await this.rec!.run({ [this.rec!.inputNames[0]]: new ort.Tensor('float32', input, [group.length, 3, 48, width]) });
      const output = result[this.rec!.outputNames[0]], [, steps, classes] = output.dims as number[], probs = await output.getData() as Float32Array;
      group.forEach((i, k) => { const line = lines[i]; results[i] = this.decode(probs.subarray(k * steps * classes, (k + 1) * steps * classes), steps, classes, width / steps, line.frame, line.resized, line.flipped); });
      output.dispose();
    }
    return results;
  }

  private async detect(image: Pixels): Promise<{ frame: Frame; box: Box }[]> {
    const { ort } = this, scale = Math.min(1, this.options.detSide / Math.max(image.width, image.height));
    const w = Math.max(32, Math.round(image.width * scale / 32) * 32), h = Math.max(32, Math.round(image.height * scale / 32) * 32);
    const input = tensorFrom(image, upright([0, 0, image.width, image.height]), w, h, (v, c) => (v - IMAGENET_MEAN[c]) / IMAGENET_STD[c]);
    const result = await this.det!.run({ [this.det!.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) });
    const output = result[this.det!.outputNames[0]], [, , mh, mw] = output.dims as number[];
    const frames = regions(await output.getData() as Float32Array, mw, mh, this.options.textThreshold, this.options.boxThreshold);
    output.dispose();
    // From the map's pixels to the image's (the two axes can scale a little differently).
    const kx = image.width / mw, ky = image.height / mh;
    const lines = frames.map(frame => {
      const [a, b, , d] = corners(frame).map(([x, y]) => [x * kx, y * ky]), length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const scaled: Frame = level(frame)
        ? { x: a[0], y: a[1], ux: 1, uy: 0, length, height: d[1] - a[1] }
        : { x: a[0], y: a[1], ux: (b[0] - a[0]) / length, uy: (b[1] - a[1]) / length, length, height: Math.hypot(d[0] - a[0], d[1] - a[1]) };
      const box = bounds(corners(scaled));
      return { frame: scaled, box: [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(image.width, box[2]), Math.min(image.height, box[3])] as Box };
    });
    // Columns and rows are found on the page turned level: by the lines' median slope.
    const slopes = lines.map(({ frame }) => Math.atan2(frame.uy, frame.ux)).sort((a, b) => a - b), slope = slopes[slopes.length >> 1] || 0;
    const cos = Math.cos(-slope), sin = Math.sin(-slope);
    const leveled = lines.map(line => ({ line, box: slope ? bounds(corners(line.frame).map(([x, y]) => [x * cos - y * sin, x * sin + y * cos])) : line.box }));
    return readingOrder(leveled).map(({ line }) => line);
  }

  /** Which lines are upside down (a page scanned the wrong way up). */
  private async orientations(image: Pixels, frames: Frame[]) {
    const flipped = frames.map(() => false);
    if (!this.cls || !frames.length) return flipped;
    const { ort } = this, batch = 16;
    for (let start = 0; start < frames.length; start += batch) {
      const group = frames.slice(start, start + batch), size = 3 * 80 * 160, input = new Float32Array(group.length * size);
      group.forEach((frame, i) => tensorFrom(image, frame, 160, 80, (v, c) => (v - IMAGENET_MEAN[c]) / IMAGENET_STD[c], input.subarray(i * size, (i + 1) * size)));
      const result = await this.cls.run({ [this.cls.inputNames[0]]: new ort.Tensor('float32', input, [group.length, 3, 80, 160]) });
      const scores = await result[this.cls.outputNames[0]].getData() as Float32Array;
      group.forEach((_, i) => { if (scores[i * 2 + 1] > .9) flipped[start + i] = true; });
    }
    return flipped;
  }

  /** CTC: the best class per step, repeats merged, blanks dropped; each letter keeps the steps it spans. */
  private decode(probs: Float32Array, steps: number, classes: number, stride: number, frame: Frame, resized: number, flipped: boolean): Read {
    const letters: { char: string; from: number; to: number; p: number }[] = [];
    let previous = 0;
    for (let t = 0; t < steps; t++) {
      let best = 0, p = probs[t * classes];
      for (let c = 1; c < classes; c++) if (probs[t * classes + c] > p) { p = probs[t * classes + c]; best = c; }
      if (best !== 0 && best === previous) { const last = letters[letters.length - 1]; last.to = t; last.p = Math.max(last.p, p); }
      else if (best !== 0) letters.push({ char: this.alphabet[best] ?? '', from: t, to: t, p });
      previous = best;
    }
    // Steps to distances along the line: a step is `stride` input pixels of the line resized to `resized` wide.
    const along = (step: number) => { const u = Math.min(1, step * stride / resized) * frame.length; return flipped ? frame.length - u : u; };
    const part = (from: number, to: number): Box => bounds(corners({ ...frame, x: frame.x + from * frame.ux, y: frame.y + from * frame.uy, length: to - from }));
    const words: OcrWord[] = [];
    let current: typeof letters = [];
    const close = () => {
      if (!current.length) return;
      const spans = current.map(({ from, to }) => { const a = along(from), b = along(to + 1); return [Math.min(a, b), Math.max(a, b)]; });
      const box = part(Math.min(...spans.map(e => e[0])), Math.max(...spans.map(e => e[1])));
      const edges = spans.map(([a, b]) => { const edge = part(a, b); return [edge[0], edge[2]] as [number, number]; });
      words.push({ text: current.map(l => l.char).join(''), box, score: current.reduce((t, l) => t + l.p, 0) / current.length, letters: edges });
      current = [];
    };
    for (const letter of letters) { if (letter.char === ' ') close(); else current.push(letter); }
    close();
    if (flipped) words.reverse();
    const text = words.map(w => w.text).join(' '), score = letters.length ? letters.reduce((t, l) => t + l.p, 0) / letters.length : 0;
    return { text, score, words };
  }
}
