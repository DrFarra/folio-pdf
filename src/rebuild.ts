// A scanned page rebuilt as digital text: each recognised line's colours are read from
// its pixels, then its letters are erased from the image, each column of the letters
// filled from the background just above and below them (so a coloured box or a shaded
// band stays, without the text). The text is then written again as real text.
// Plain code with no imports, so the tests run it in Node too.

export type Pixels = { data: Uint8ClampedArray; width: number; height: number; channels: number };
export type Box = [number, number, number, number];
/** A line to rebuild: its text, its ink box in image pixels and how sure the recogniser was of it (0–1). */
export type LineArea = { text: string; box: Box; score: number };
/** A line's ink colour and its background's, 0–1. */
export type Style = { color: [number, number, number]; background: [number, number, number] };

/**
 * Styles of the lines (null for a line left in the image), with the others' letters
 * erased from `image` in place. A line stays in the image when it was read with doubt,
 * when its background is not plain (a figure's labels, text over a photo), or when its
 * ink does not stand out.
 */
export function rebuildLines(image: Pixels, lines: LineArea[]): (Style | null)[] {
  const { data, width: w, height: h, channels: n } = image;
  const rgb = (i: number) => n >= 3 ? [data[i * n], data[i * n + 1], data[i * n + 2]] : [data[i * n], data[i * n], data[i * n]];
  // Read every line before erasing any: lines close together share a margin.
  const looks = lines.map(({ text, box, score }) => {
    const x0 = Math.max(0, Math.floor(box[0])), x1 = Math.min(w, Math.ceil(box[2])), y0 = Math.max(0, Math.floor(box[1])), y1 = Math.min(h, Math.ceil(box[3]));
    // A few letters alone are a figure's label more often than text (and an α read as a): they need more certainty.
    const letters = text.replace(/\s/g, '').length;
    // Wrong text on the page is worse than the scan's own letters: only what was read with confidence is rewritten.
    if (letters <= 3 || score < (letters < 6 ? .96 : .92) || x1 - x0 < 2 || y1 - y0 < 2) return null;
    // Text about as wide as its letters make it at this height: a box holding several close
    // lines (too narrow for its height), or text read only in part (too wide), stays as it is.
    const em = (x1 - x0) / (text.length * .5);
    if (em < (y1 - y0) * .55 || em > (y1 - y0) * 2.2) return null;
    // The background: the ring of pixels just around the line, which must be nearly one colour.
    const ring = Math.max(2, Math.round((y1 - y0) * .3)), around: number[][] = [];
    for (let y = Math.max(0, y0 - ring); y < Math.min(h, y1 + ring); y++) for (let x = Math.max(0, x0 - ring); x < Math.min(w, x1 + ring); x += (y < y0 || y >= y1) ? 1 : x1 - x0 + ring) {
      if (y >= y0 && y < y1 && x >= x0 && x < x1) continue;
      around.push(rgb(y * w + x));
    }
    if (around.length < 8) return null;
    const background = [0, 1, 2].map(c => { const values = around.map(p => p[c]).sort((a, b) => a - b); return values[values.length >> 1]; });
    const far = (p: number[]) => Math.hypot(p[0] - background[0], p[1] - background[1], p[2] - background[2]);
    if (around.filter(p => far(p) > 40).length > around.length * .2) return null;
    // Ink: what stands apart from the background, darker or lighter.
    const distances: number[] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) distances.push(far(rgb(y * w + x)));
    const sorted = [...distances].sort((a, b) => a - b), strongest = sorted[Math.floor(sorted.length * .98)];
    if (strongest < 50) return null;
    // The colour of the strokes' cores, away from their soft edges.
    const sum = [0, 0, 0]; let count = 0;
    for (let y = y0, k = 0; y < y1; y++) for (let x = x0; x < x1; x++, k++) if (distances[k] > strongest * .7) { const p = rgb(y * w + x); sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; count++; }
    const color = sum.map(v => Math.round(v / Math.max(1, count)) / 255) as [number, number, number];
    // The faint edge of a blurred scan's letters is erased too: anything clearly off the plain background.
    return { x0, x1, y0, y1, far, edge: Math.max(14, strongest * .1), grow: Math.max(2, Math.round((y1 - y0) * .06)), style: { color, background: background.map(v => v / 255) as [number, number, number] } };
  });
  // Lines left in the image keep every pixel: erasing a neighbour must not reach into them.
  const kept = looks.flatMap((look, i) => look ? [] : [lines[i].box]);
  for (const look of looks) if (look) erase(image, look, kept);
  return looks.map(look => look?.style ?? null);
}

/**
 * The page cleaned of its scan: the paper's own tint (yellowed, grey) set to white, its
 * faint noise and show-through gone, and dark ink set back to black, each channel
 * stretched from the ink's black to the paper's colour (which also undoes a colour cast).
 * Pages that are not light paper (a dark slide, a photo) are left as they are.
 */
export function cleanPaper(image: Pixels) {
  const { data, width: w, height: h, channels: n } = image, count = w * h;
  const light = (i: number) => n >= 3 ? (data[i * n] * 299 + data[i * n + 1] * 587 + data[i * n + 2] * 114) / 1000 : data[i * n];
  const histogram = new Uint32Array(256), step = Math.max(1, Math.floor(count / 200_000));
  for (let i = 0; i < count; i += step) histogram[Math.round(light(i))]++;
  // The paper: the most common light tone.
  let paper = 128; for (let v = 128; v < 256; v++) if (histogram[v] > histogram[paper]) paper = v;
  let total = 0; for (let v = 0; v < 256; v++) total += histogram[v];
  if (paper < 150 || histogram.slice(paper - 12, paper + 13).reduce((a, b) => a + b, 0) < total * .3) return;
  // Its colour, and the ink's black, per channel.
  const white = [0, 0, 0], black = [255, 255, 255]; let samples = 0;
  for (let i = 0; i < count; i += step) {
    const v = light(i);
    if (Math.abs(v - paper) <= 8) { for (let c = 0; c < 3; c++) white[c] += data[i * n + (n >= 3 ? c : 0)]; samples++; }
  }
  for (let c = 0; c < 3; c++) white[c] /= samples;
  const darkest: number[][] = [[], [], []];
  for (let i = 0; i < count; i += step) if (light(i) < paper * .5) for (let c = 0; c < 3; c++) darkest[c].push(data[i * n + (n >= 3 ? c : 0)]);
  for (let c = 0; c < 3; c++) { const values = darkest[c].sort((a, b) => a - b); black[c] = values.length ? Math.min(70, values[Math.floor(values.length * .05)]) : 0; }
  const map = [0, 1, 2].map(c => Uint8ClampedArray.from({ length: 256 }, (_, v) => (v - black[c]) / Math.max(1, white[c] - black[c]) * 255));
  for (let i = 0; i < count; i++) {
    const o = i * n, mapped = [0, 1, 2].map(c => map[c][data[o + (n >= 3 ? c : 0)]]);
    // Near-white becomes white: paper grain and show-through from the other side.
    const lum = (mapped[0] * 299 + mapped[1] * 587 + mapped[2] * 114) / 1000, lift = lum > 235 ? 1 : lum > 215 ? (lum - 215) / 20 : 0;
    for (let c = 0; c < Math.min(n, 3); c++) data[o + c] = mapped[n >= 3 ? c : 0] + (255 - mapped[n >= 3 ? c : 0]) * lift;
  }
}

/** The letters of one line erased: ink and its soft edge, each column filled from above to below. */
function erase(image: Pixels, { x0, x1, y0, y1, far, edge, grow }: { x0: number; x1: number; y0: number; y1: number; far: (p: number[]) => number; edge: number; grow: number }, kept: Box[]) {
  // Outside its own box only: inside it, the line's letters always go, even where a neighbour's box overlaps.
  const protectedAt = (x: number, y: number) => (y < y0 || y >= y1 || x < x0 || x >= x1) && kept.some(b => x >= b[0] && x < b[2] && y >= b[1] && y < b[3]);
  const { data, width: w, height: h, channels: n } = image, pad = grow + 1;
  const inked = (x: number, y: number) => { const i = (y * w + x) * n; return far(n >= 3 ? [data[i], data[i + 1], data[i + 2]] : [data[i], data[i], data[i]]) > edge; };
  const left = Math.max(0, x0 - pad), right = Math.min(w, x1 + pad), top = Math.max(0, y0 - pad), bottom = Math.min(h, y1 + pad);
  const cw = right - left, ch = bottom - top, mask = new Uint8Array(cw * ch);
  // Ink, including the faint edge of each stroke a scan leaves, grown by a few pixels.
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (inked(left + x, top + y)) {
    for (let dy = -grow; dy <= grow; dy++) for (let dx = -grow; dx <= grow; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < ch && xx >= 0 && xx < cw) mask[yy * cw + xx] = 1; }
  }
  // A stroke can run past the box (a descender, an accent): follow it until background, a little way.
  const reach = Math.ceil((y1 - y0) * .5);
  for (let x = 0; x < cw; x++) {
    for (let y = 0; y < ch; y++) {
      if (!mask[y * cw + x]) continue;
      let end = y; while (end < ch && mask[end * cw + x]) end++;
      const px = left + x;
      let above = top + y - 1, below = top + end;
      if (y === 0) while (above >= 0 && top - above < reach && inked(px, above)) above--;
      if (end === ch) while (below < h && below - bottom < reach && inked(px, below)) below++;
      for (let k = above + 1 - top; k < below - top; k++) {
        if (protectedAt(px, top + k)) continue;
        const f = (k - (above - top)) / (below - above), o = ((top + k) * w + px) * n;
        for (let c = 0; c < n; c++) {
          const a = above >= 0 ? data[(above * w + px) * n + c] : below < h ? data[(below * w + px) * n + c] : 255;
          const b = below < h ? data[(below * w + px) * n + c] : a;
          data[o + c] = c === 3 ? 255 : a + (b - a) * f;
        }
      }
      y = end;
    }
  }
}
