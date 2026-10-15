// Straightening a scanned page before OCR, from its pixels alone: the tilt of the
// whole page (projection profile), then the curve of each text line, as near the
// spine of a book or in a phone photo, flattened by moving each column of pixels
// up or down. Plain code with no imports, so the tests run it in Node too.

export type Pixels = { data: ArrayLike<number>; width: number; height: number; channels: number };
/** A grey copy of the page, small enough to analyse quickly. */
export type Sample = { gray: Uint8Array; width: number; height: number; scale: number };
/**
 * How far up or down each point of the flat page comes from, on a grid over the
 * sample. Vertical only: a page curving towards the spine is seen with each column
 * of it raised or lowered, its letters are not turned.
 */
export type Field = { cols: number; rows: number; step: number; dy: Float32Array };
type Line = { fit: number[]; lo: number; hi: number; count: number };

/** A grey copy at most `size` pixels on its long side; each pixel averages the block it covers. */
export function shrink(page: Pixels, size = 1200): Sample {
  const { data, width: w, height: h, channels: n } = page;
  const scale = Math.min(1, size / Math.max(w, h)), sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));
  const sums = new Float64Array(sw * sh), counts = new Uint32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(sh - 1, Math.floor(y * sh / h)) * sw;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * n, t = ty + Math.min(sw - 1, Math.floor(x * sw / w));
      sums[t] += n >= 3 ? (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 : data[i]; counts[t]++;
    }
  }
  const gray = new Uint8Array(sw * sh);
  for (let i = 0; i < gray.length; i++) gray[i] = counts[i] ? sums[i] / counts[i] : 255;
  return { gray, width: sw, height: sh, scale: sw / w };
}

/** Ink: pixels clearly darker than their surroundings, so the shading of a photo does not count. */
export function inkMask({ gray, width: w, height: h }: Sample): Uint8Array {
  const stride = w + 1, sum = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += gray[y * w + x]; sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1] + row; } }
  const r = Math.max(8, Math.round(Math.min(w, h) / 40)), mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const mean = (sum[y1 * stride + x1] - sum[y0 * stride + x1] - sum[y1 * stride + x0] + sum[y0 * stride + x0]) / ((y1 - y0) * (x1 - x0));
      const v = gray[y * w + x]; mask[y * w + x] = v < mean * .85 && v < 200 ? 1 : 0;
    }
  }
  return mask;
}

/**
 * Tilt of the text lines in degrees, positive when they rise to the right: the angle
 * at which the rows of ink line up best. 0 when straight or without clear lines.
 */
export function skewAngle(mask: Uint8Array, w: number, h: number, limit = 15): number {
  const xs: number[] = [], ys: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { xs.push(x); ys.push(y); }
  if (xs.length < 300) return 0;
  const reach = w * Math.sin(limit * Math.PI / 180), bins = new Float64Array(Math.ceil(h + 2 * reach) + 2);
  const score = (degrees: number) => {
    const t = degrees * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) bins[Math.round(ys[i] * cos + xs[i] * sin + reach)]++;
    // Sharp edges between the rows of text and the gaps between them.
    let sum = 0; for (let i = 1; i < bins.length; i++) { const d = bins[i] - bins[i - 1]; sum += d * d; }
    return sum;
  };
  const level = score(0); let best = 0, top = level;
  const search = (from: number, to: number, by: number) => { for (let a = from; a <= to + 1e-9; a += by) { const s = score(a); if (s > top) { top = s; best = a; } } };
  search(-limit, limit, .5); search(best - .5, best + .5, .05);
  // At the edge of the search, or barely better than straight: not a tilt worth turning.
  if (Math.abs(best) > limit - .5 || top < level * 1.02 || Math.abs(best) < .1) return 0;
  return Math.round(best * 100) / 100;
}

const evaluate = (fit: number[], x: number, w: number) => { const u = x / w - .5; return fit[0] + u * (fit[1] + u * (fit[2] + u * fit[3])); };
function cubic(points: number[][], w: number): number[] | null {
  // Least squares for y = a + b·u + c·u² + d·u³, u = x/w − ½.
  const m = Array.from({ length: 4 }, () => new Array(5).fill(0));
  for (const [x, y] of points) {
    const u = x / w - .5, p = [1, u, u * u, u * u * u];
    for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) m[i][j] += p[i] * p[j]; m[i][4] += p[i] * y; }
  }
  for (let i = 0; i < 4; i++) {
    let pivot = i; for (let k = i + 1; k < 4; k++) if (Math.abs(m[k][i]) > Math.abs(m[pivot][i])) pivot = k;
    [m[i], m[pivot]] = [m[pivot], m[i]];
    if (Math.abs(m[i][i]) < 1e-12) return null;
    for (let k = 0; k < 4; k++) if (k !== i) { const f = m[k][i] / m[i][i]; for (let j = i; j < 5; j++) m[k][j] -= f * m[i][j]; }
  }
  return m.map((row, i) => row[4] / m[i][i]);
}

/** The text lines of a straight-ish page, traced across vertical strips and fitted with cubics. */
export function traceLines(mask: Uint8Array, w: number, h: number): { lines: Line[]; spacing: number } {
  const strips = 24, sw = w / strips, peaks: number[][] = [], strengths: number[][] = [];
  const profile = new Float32Array(h), smooth = new Float32Array(h);
  for (let s = 0; s < strips; s++) {
    const x0 = Math.floor(s * sw), x1 = Math.floor((s + 1) * sw);
    profile.fill(0);
    for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) profile[y] += mask[y * w + x];
    for (let y = 0; y < h; y++) { let t = 0, c = 0; for (let k = Math.max(0, y - 2); k <= Math.min(h - 1, y + 2); k++) { t += profile[k]; c++; } smooth[y] = t / c; }
    const list: number[] = [], strength: number[] = [], least = (x1 - x0) * .06;
    for (let y = 2; y < h - 2; y++) {
      const v = smooth[y];
      if (v > least && v >= smooth[y - 1] && v > smooth[y + 1] && v >= smooth[y - 2] && v > smooth[y + 2]) { list.push(y); strength.push(v); }
    }
    peaks.push(list); strengths.push(strength);
  }
  const gaps = peaks.flatMap(list => list.slice(1).map((y, i) => y - list[i])).sort((a, b) => a - b);
  const spacing = gaps[Math.floor(gaps.length * .6)] || 0;
  if (spacing < 4) return { lines: [], spacing };
  // One peak per line: a weaker one closer than half a line (an ascender row, a dot) goes.
  peaks.forEach((list, s) => {
    const keep = list.map(() => true);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length && list[j] - list[i] < spacing * .5; j++) {
      if (strengths[s][i] >= strengths[s][j]) keep[j] = false; else keep[i] = false;
    }
    peaks[s] = list.filter((_, i) => keep[i]);
  });
  const tolerance = spacing * .35, middle = strips >> 1, used = peaks.map(list => new Uint8Array(list.length)), lines: Line[] = [];
  peaks[middle].forEach((seed, index) => {
    if (used[middle][index]) return;
    used[middle][index] = 1;
    const points = [[(middle + .5) * sw, seed]];
    for (const direction of [1, -1]) {
      let y = seed, lastX = (middle + .5) * sw, slope = 0, misses = 0;
      for (let s = middle + direction; s >= 0 && s < strips && misses <= 2; s += direction) {
        const x = (s + .5) * sw, want = y + slope * (x - lastX);
        let found = -1;
        peaks[s].forEach((p, j) => { if (!used[s][j] && Math.abs(p - want) <= tolerance && (found < 0 || Math.abs(p - want) < Math.abs(peaks[s][found] - want))) found = j; });
        if (found < 0) { misses++; continue; }
        const p = peaks[s][found]; used[s][found] = 1;
        slope = slope * .5 + (p - y) / (x - lastX) * .5; y = p; lastX = x; misses = 0; points.push([x, p]);
      }
    }
    if (points.length < strips * .5) return;
    const fit = cubic(points, w); if (!fit) return;
    const rms = Math.sqrt(points.reduce((t, [x, y]) => t + (evaluate(fit, x, w) - y) ** 2, 0) / points.length);
    if (rms > spacing * .2) return;
    const xs = points.map(([x]) => x);
    lines.push({ fit, lo: Math.min(...xs), hi: Math.max(...xs), count: points.length });
  });
  // The same line traced twice keeps its longer trace.
  const kept = lines.filter(line => !lines.some(other => other !== line && Math.abs(evaluate(other.fit, w / 2, w) - evaluate(line.fit, w / 2, w)) < spacing * .5 && (other.count > line.count || other.count === line.count && lines.indexOf(other) < lines.indexOf(line))));
  return { lines: kept, spacing };
}

// A line's height at x; past its traced ends it goes on along its slope for about
// a strip (the last letters), then stays level.
function clampAt(line: Line, x: number, w: number) {
  const end = x < line.lo ? line.lo : x > line.hi ? line.hi : x, y = evaluate(line.fit, end, w);
  if (end === x) return y;
  const u = end / w - .5, [, b, c, d] = line.fit, slope = (b + 2 * c * u + 3 * d * u * u) / w;
  return y + slope * Math.max(-w / 16, Math.min(w / 16, x - end));
}
// Where the lines bend least: away from a book's spine, where the page lies flat.
function flattest(lines: Line[], w: number) {
  let best = w / 2, least = Infinity;
  for (let x = w * .1; x <= w * .9; x += w / 32) {
    const bends = lines.filter(line => x >= line.lo && x <= line.hi).map(({ fit }) => Math.abs(2 * fit[2] + 6 * fit[3] * (x / w - .5))).sort((a, b) => a - b);
    if (bends.length < lines.length / 2) continue;
    const bend = bends[bends.length >> 1]; if (bend < least) { least = bend; best = x; }
  }
  return best;
}

/**
 * The tilt left on a page whose lines curve, read where it lies flat: the projection
 * angle of a curved page is pulled by its curve, which would lean the margins.
 * Degrees, positive when the lines there rise to the right.
 */
export function flatTilt(mask: Uint8Array, w: number, h: number): number {
  const { lines } = traceLines(mask, w, h);
  if (lines.length < 4) return 0;
  const x = flattest(lines, w), u = x / w - .5;
  const slopes = lines.filter(line => x >= line.lo && x <= line.hi).map(({ fit }) => (fit[1] + 2 * fit[2] * u + 3 * fit[3] * u * u) / w).sort((a, b) => a - b);
  if (!slopes.length) return 0;
  const degrees = -Math.atan(slopes[slopes.length >> 1]) * 180 / Math.PI;
  return Math.abs(degrees) < .1 || Math.abs(degrees) > 15 ? 0 : Math.round(degrees * 100) / 100;
}

/**
 * The turn that makes the left margin vertical, in degrees clockwise (the sign of
 * skewAngle), or null when the text has no clear margin. The margin is the page's
 * own straight edge: the lines can curve, it does not.
 */
export function marginTilt(mask: Uint8Array, w: number, h: number): number | null {
  const { lines, spacing } = traceLines(mask, w, h);
  if (lines.length < 6) return null;
  const band = Math.max(1, Math.round(spacing * .25)), starts: number[][] = [];
  for (const line of lines) {
    // Where the ink of this line begins: the first column with ink in its band.
    for (let x = 0; x < line.hi; x++) {
      const y = Math.round(clampAt(line, x, w)); let ink = 0;
      for (let dy = -band; dy <= band; dy++) { const yy = y + dy; if (yy >= 0 && yy < h) ink += mask[yy * w + x]; }
      if (ink >= 2) { starts.push([x, y]); break; }
    }
  }
  // Theil–Sen: indented first lines of paragraphs do not move the median.
  const slopes: number[] = [];
  for (let i = 0; i < starts.length; i++) for (let j = i + 1; j < starts.length; j++) {
    const dy = starts[j][1] - starts[i][1]; if (Math.abs(dy) > spacing * 3) slopes.push((starts[j][0] - starts[i][0]) / dy);
  }
  if (slopes.length < 10) return null;
  slopes.sort((a, b) => a - b);
  const slope = slopes[slopes.length >> 1], offsets = starts.map(([x, y]) => x - slope * y).sort((a, b) => a - b), middle = offsets[offsets.length >> 1];
  if (starts.filter(([x, y]) => Math.abs(x - slope * y - middle) < spacing * .5).length < starts.length * .5) return null;
  const degrees = Math.atan(slope) * 180 / Math.PI;
  return Math.abs(degrees) > 15 ? null : Math.round(degrees * 100) / 100;
}

/**
 * The shifts that make the traced lines straight and level, or null when they
 * already are (a page that only needs turning keeps its original image). The flat
 * part of the page stays where it is; the curved part is brought to it.
 */
export function flattenField(mask: Uint8Array, w: number, h: number): Field | null {
  const traced = traceLines(mask, w, h), spacing = traced.spacing;
  // Only running text shows a page's curve: a few short lines (captions beside drawings,
  // whose strokes can pass for lines) are no evidence of it.
  const lines = traced.lines.filter(line => line.hi - line.lo >= w * .35);
  if (lines.length < 6) return null;
  const at = (line: Line, x: number) => clampAt(line, x, w);
  // Curved: the middle of the line strays from the straight chord between its ends.
  const bent = lines.filter(line => {
    let most = 0; const a = at(line, line.lo), b = at(line, line.hi);
    for (let x = line.lo; x <= line.hi; x += w / 48) most = Math.max(most, Math.abs(at(line, x) - (a + (b - a) * (x - line.lo) / (line.hi - line.lo))));
    return most > Math.max(2, spacing * .1);
  });
  if (bent.length < lines.length / 3) return null;
  const flat = flattest(lines, w), target = (line: Line) => at(line, flat);
  lines.sort((a, b) => target(a) - target(b));
  const step = 8, cols = Math.ceil(w / step) + 1, rows = Math.ceil(h / step) + 1, dy = new Float32Array(cols * rows);
  const offsets = new Float64Array(lines.length), targets = lines.map(target);
  for (let gx = 0; gx < cols; gx++) {
    const x = gx * step;
    let previous = -Infinity;
    lines.forEach((line, k) => {
      const y = at(line, x);
      // Lines must not cross: one that would keeps its neighbour's shift here.
      offsets[k] = y > previous + 1 || k === 0 ? y - targets[k] : offsets[k - 1];
      previous = Math.max(previous, y);
    });
    let k = 0;
    for (let gy = 0; gy < rows; gy++) {
      const y = gy * step, i = gy * cols + gx;
      while (k < lines.length - 1 && targets[k + 1] <= y) k++;
      if (y <= targets[0]) dy[i] = offsets[0];
      else if (k >= lines.length - 1) dy[i] = offsets[lines.length - 1];
      else { const f = (y - targets[k]) / (targets[k + 1] - targets[k] || 1); dy[i] = offsets[k] + f * (offsets[k + 1] - offsets[k]); }
    }
  }
  return { cols, rows, step, dy };
}

/** The flat page, each pixel read from above or below as the field says; `scale` is page pixels per sample pixel. */
export function flatten(page: Pixels, field: Field, scale: number): Uint8ClampedArray {
  const { data, width: w, height: h, channels: n } = page, { cols, rows, step, dy } = field;
  const out = new Uint8ClampedArray(w * h * n).fill(255);
  const grid = (values: Float32Array, i: number, fx: number, fy: number) => (values[i] * (1 - fx) + values[i + 1] * fx) * (1 - fy) + (values[i + cols] * (1 - fx) + values[i + cols + 1] * fx) * fy;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(rows - 1.001, y / scale / step), r = Math.floor(gy), fy = gy - r;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(cols - 1.001, x / scale / step), c = Math.floor(gx), fx = gx - c, i = r * cols + c;
      const sy = y + grid(dy, i, fx, fy) * scale, y0 = Math.floor(sy);
      if (y0 < 0 || y0 >= h - 1) continue;
      const ay = sy - y0, a = (y0 * w + x) * n, b = a + w * n, o = (y * w + x) * n;
      for (let k = 0; k < n; k++) out[o + k] = data[a + k] * (1 - ay) + data[b + k] * ay;
    }
  }
  return out;
}
