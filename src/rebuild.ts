// A scanned page rebuilt as digital text: each recognised line's colour and weight are
// read from its ink, then its letters are erased from the image, each column of the
// letters filled from the background just above and below them (so a coloured box or a
// shaded band stays, without the text). The text is then written again as real text.
// Plain code with no imports, so the tests run it in Node too.

export type Pixels = { data: Uint8ClampedArray; width: number; height: number; channels: number };
export type Box = [number, number, number, number];
/** A line's ink colour (0–1) and whether its strokes are bold. */
export type Style = { color: [number, number, number]; bold: boolean };

const STROKE_BOLD = .145;

/**
 * Styles of the lines in `boxes` (ink boxes in image pixels), with their letters erased
 * from `image` in place. A line without clear ink (too little contrast) is left as is: null.
 */
export function rebuildLines(image: Pixels, boxes: Box[]): (Style | null)[] {
  const { data, width: w, height: h, channels: n } = image;
  const light = (i: number) => n >= 3 ? (data[i * n] * 299 + data[i * n + 1] * 587 + data[i * n + 2] * 114) / 1000 : data[i * n];
  // Read every line before erasing any: lines close together share a margin.
  const looks = boxes.map(box => {
    const x0 = Math.max(0, Math.floor(box[0])), x1 = Math.min(w, Math.ceil(box[2])), y0 = Math.max(0, Math.floor(box[1])), y1 = Math.min(h, Math.ceil(box[3]));
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;
    let low = 255, high = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = light(y * w + x); if (v < low) low = v; if (v > high) high = v; }
    if (high - low < 40) return null;
    const threshold = (low + high) / 2, core = (low + threshold) / 2;
    // The colour of the strokes' cores, away from their antialiased edges.
    const sum = [0, 0, 0]; let count = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * w + x; if (light(i) >= core) continue;
      for (let c = 0; c < 3; c++) sum[c] += data[i * n + (n >= 3 ? c : 0)]; count++;
    }
    if (!count) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * w + x; if (light(i) < threshold) { for (let c = 0; c < 3; c++) sum[c] += data[i * n + (n >= 3 ? c : 0)]; count++; } }
    // Weight: the typical width of a stroke crossed horizontally, against the line's height.
    const runs: number[] = [];
    for (let y = y0; y < y1; y++) { let run = 0; for (let x = x0; x <= x1; x++) { if (x < x1 && light(y * w + x) < threshold) run++; else if (run) { runs.push(run); run = 0; } } }
    runs.sort((a, b) => a - b);
    const stroke = runs.length ? runs[runs.length >> 1] / (y1 - y0) : 0;
    return { x0, x1, y0, y1, low, high, style: { color: sum.map(v => Math.round(v / Math.max(1, count)) / 255) as [number, number, number], bold: stroke > STROKE_BOLD } };
  });
  for (const look of looks) if (look) erase(image, look, light);
  return looks.map(look => look?.style ?? null);
}

/** The letters of one line erased: ink and its soft edge, each column filled from above to below. */
function erase(image: Pixels, { x0, x1, y0, y1, low, high }: { x0: number; x1: number; y0: number; y1: number; low: number; high: number }, light: (i: number) => number) {
  const { data, width: w, height: h, channels: n } = image, pad = 2;
  const left = Math.max(0, x0 - pad), right = Math.min(w, x1 + pad), top = Math.max(0, y0 - pad), bottom = Math.min(h, y1 + pad);
  const cw = right - left, ch = bottom - top, edge = high - (high - low) * .2, mask = new Uint8Array(cw * ch);
  // Ink, including the light edge of each stroke, grown by a pixel.
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (light((top + y) * w + left + x) < edge) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < ch && xx >= 0 && xx < cw) mask[yy * cw + xx] = 1; }
  }
  // A stroke can run past the box (a descender, an accent): follow it until paper, a little way.
  const reach = Math.ceil((y1 - y0) * .5);
  for (let x = 0; x < cw; x++) {
    for (let y = 0; y < ch; y++) {
      if (!mask[y * cw + x]) continue;
      let end = y; while (end < ch && mask[end * cw + x]) end++;
      const px = left + x;
      let above = top + y - 1, below = top + end;
      if (y === 0) while (above >= 0 && top - above < reach && light(above * w + px) < edge) above--;
      if (end === ch) while (below < h && below - bottom < reach && light(below * w + px) < edge) below++;
      for (let k = above + 1 - top; k < below - top; k++) {
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
