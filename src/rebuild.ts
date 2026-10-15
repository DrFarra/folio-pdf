// A scanned page rebuilt as digital text: each recognised line's colours are read from
// its pixels, then its letters are erased from the image, each column of the letters
// filled from the background just above and below them (so a coloured box or a shaded
// band stays, without the text). The text is then written again as real text.
// Plain code with no imports, so the tests run it in Node too.

export type Pixels = { data: Uint8ClampedArray; width: number; height: number; channels: number };
export type Box = [number, number, number, number];
/** A line to rebuild: its text, its ink box in image pixels and how sure the recogniser was of it (0–1). */
export type LineArea = { text: string; box: Box; score: number; words?: { text?: string; box: Box; score: number }[] };
/**
 * A line's box (its band's rows when `band`: it sits on a band of its own colour, a table's dark
 * row), its ink colour as the scan shows it and as printed (`ink`), its background's, 0–1, and the
 * colour of each word printed in another
 * (a link in blue, a term in red), null for the rest.
 */
export type Style = { box: Box; color: [number, number, number]; ink: [number, number, number]; background: [number, number, number]; band: boolean; kept: number[]; colors: ([number, number, number] | null)[] };

/**
 * Whether a word is in a word list: the list's words, sorted (by code unit) and one per line, as
 * public/ocr/words.bin holds them, searched by halves. A word is looked up in lower case,
 * without the punctuation around it; a hyphenated one by its parts.
 */
export function wordChecker(list: string): (word: string) => boolean {
  const starts: number[] = [0];
  for (let i = list.indexOf('\n'); i >= 0; i = list.indexOf('\n', i + 1)) starts.push(i + 1);
  const at = (k: number) => list.slice(starts[k], k + 1 < starts.length ? starts[k + 1] - 1 : list.length);
  const has = (word: string) => {
    let low = 0, high = starts.length - 1;
    while (low <= high) { const mid = (low + high) >> 1, here = at(mid); if (here === word) return true; if (here < word) low = mid + 1; else high = mid - 1; }
    return false;
  };
  return word => {
    const core = word.normalize('NFC').toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    return !core || core.split('-').every(part => !part || has(part));
  };
}

/**
 * Styles of the lines (null for a line left in the image), with the others' letters
 * erased from `image` in place. A line stays in the image when it was read with doubt,
 * when its background is not plain (a figure's labels, text over a photo), or when its
 * ink does not stand out.
 */
export function rebuildLines(image: Pixels, lines: LineArea[], known?: (word: string) => boolean): (Style | null)[] {
  const { data, width: w, height: h, channels: n } = image;
  const rgb = (i: number) => n >= 3 ? [data[i * n], data[i * n + 1], data[i * n + 2]] : [data[i * n], data[i * n], data[i * n]];
  // Read every line before erasing any: lines close together share a margin.
  const looks = lines.map(({ text, box, score, words = [] }, index) => {
    const x0 = Math.max(0, Math.floor(box[0])), x1 = Math.min(w, Math.ceil(box[2]));
    let y0 = Math.max(0, Math.floor(box[1])), y1 = Math.min(h, Math.ceil(box[3]));
    // A few letters alone are a figure's label more often than text (and an α read as a): they need more certainty.
    const letters = text.replace(/\s/g, '').length;
    // Wrong text on the page is worse than the scan's own letters: only what was read with confidence is rewritten.
    if (letters <= 3 || score < (letters < 6 ? .96 : .85) || x1 - x0 < 2 || y1 - y0 < 2) return null;
    // A line on its own, with no line of its paragraph just above or below (a figure's label, a
    // running head), is read without the help of its neighbours' context: it needs more certainty.
    const alone = !lines.some((other, k) => k !== index && Math.abs(other.box[3] - other.box[1] - (y1 - y0)) < (y1 - y0) * .4 && Math.abs(other.box[1] + other.box[3] - y0 - y1) / 2 < (y1 - y0) * 2.5 && Math.min(other.box[2], x1) > Math.max(other.box[0], x0));
    if (alone && score < .97) return null;
    // A doubtful word stays as the scan shows it, the rest of its line is rewritten; a line
    // mostly of doubtful words stays whole.
    // A bullet's mark (▪, •, a dash) is read as whatever symbol is nearest: it stays as the scan shows it.
    // A word with the marks of a misreading (a punctuation mark doubled «pro--», «O..», not an
    // ellipsis; a figure among letters «l0s», «5o%»; a capital inside a small-letter word
    // «aumEnto») stays as scanned too. Ordinals («3er», «2a») and units are fine.
    const misread = (word: string) => /(?<![-.,;:])([-.,;:])\1(?![-.,;:])/u.test(word) || /\p{Ll}\d+\p{Ll}|^\d+\p{Ll}%$/u.test(word) || /\p{Ll}{2}\p{Lu}\p{Ll}/u.test(word);
    // A word of letters not in the word list, read with any doubt, is a misreading more often than
    // a term the list lacks (a term the recogniser is sure of is rewritten).
    const unknown = (word: { text?: string; score: number }) => !!known && !!word.text && /^\P{N}*$/u.test(word.text) && /\p{L}{3}/u.test(word.text) && word.score < .995 && !known(word.text);
    const kept = words.flatMap((word, n) => word.score < .8 || misread(word.text ?? '') || unknown(word) || (n === 0 && words.length > 1 && /^[-–—•·▪■◆►▸○●*]$/u.test(text.split(/\s+/)[0] ?? '')) ? [n] : []);
    if (kept.length * 2 > words.length) return null;
    // A box taller than its text reaches into the next line: drawn in to its own letters, the
    // band of rows with most ink and as far above and below as letters reach (ascenders, descenders).
    if ((x1 - x0) / (text.length * .5) < (y1 - y0) * .45) {
      const tone = (i: number) => { const p = rgb(i); return (p[0] * 299 + p[1] * 587 + p[2] * 114) / 1000; };
      const values: number[] = []; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 4) values.push(tone(y * w + x));
      values.sort((p, q) => p - q);
      const paper = values[values.length >> 1], dark = (y: number) => { let n = 0; for (let x = x0; x < x1; x += 2) if (Math.abs(tone(y * w + x) - paper) > 60) n++; return n; };
      const rows = Array.from({ length: y1 - y0 }, (_, k) => dark(y0 + k)), peak = Math.max(...rows), at = rows.indexOf(peak);
      let a = at, b = at; while (a > 0 && rows[a - 1] >= peak * .3) a--; while (b < rows.length - 1 && rows[b + 1] >= peak * .3) b++;
      const band = b - a + 1, top = Math.max(y0, y0 + a - Math.round(band * .45)), bottom = Math.min(y1, y0 + b + 1 + Math.round(band * .4));
      // Only a box with one line in it: another band about as full is a second line, read into this one.
      const other = Math.max(0, ...rows.filter((_, k) => k < a - band * .6 || k > b + band * .6));
      if (other < peak * .7 && bottom - top >= 4 && bottom - top < y1 - y0) [y0, y1] = [top, bottom];
    }
    // Text about as wide as its letters make it at this height: a box holding several close
    // lines (too narrow for its height), or text read only in part (too wide), stays as it is.
    const em = (x1 - x0) / (text.length * .5);
    if (em < (y1 - y0) * .45 || em > (y1 - y0) * 2.2) return null;
    // The background: the ring of pixels just around the line, which must be nearly one colour.
    const ring = Math.max(2, Math.round((y1 - y0) * .3)), around: number[][] = [];
    const neighbours = lines.filter((other, k) => k !== index && other.box[2] > x0 - ring && other.box[0] < x1 + ring && other.box[3] > y0 - ring && other.box[1] < y1 + ring).map(other => other.box);
    for (let y = Math.max(0, y0 - ring); y < Math.min(h, y1 + ring); y++) for (let x = Math.max(0, x0 - ring); x < Math.min(w, x1 + ring); x += (y < y0 || y >= y1) ? 1 : x1 - x0 + ring) {
      if (y >= y0 && y < y1 && x >= x0 && x < x1) continue;
      // Not the letters of the lines just above or below (close leading reaches into the ring).
      if (neighbours.some(b => x >= b[0] && x < b[2] && y >= b[1] && y < b[3])) continue;
      around.push(rgb(y * w + x));
    }
    if (around.length < 8) return null;
    // Each channel's median, counted (the box holds thousands of pixels).
    const median = (pixels: number[][]) => [0, 1, 2].map(c => {
      const counts = new Uint32Array(256); for (const p of pixels) counts[p[c]]++;
      let v = 0; for (let seen = counts[0]; seen <= pixels.length >> 1; ) seen += counts[++v];
      return v;
    });
    let inside: number[][] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) inside.push(rgb(y * w + x));
    let background = median(around);
    const far = (p: number[]) => Math.hypot(p[0] - background[0], p[1] - background[1], p[2] - background[2]);
    // Letters fill a fraction of their box: when most of it is another colour than around it, the
    // line sits on a band of its own (a table's dark heading row) and that band is its background.
    // Its letters are erased within the band only: around it is another colour, not more ink.
    // Unless much of it is the colour around: text on paper has paper between and inside its
    // letters (dense small text, softened, can still have a grey middle).
    // and a band is one flat colour, most of it close to its middle (blurred text's tones spread out).
    const middle = median(inside), flat = inside.filter(p => Math.hypot(p[0] - middle[0], p[1] - middle[1], p[2] - middle[2]) < 25).length;
    const band = far(middle) > 60 && inside.filter(p => far(p) < 40).length < inside.length * .4 && flat > inside.length * .45;
    if (band) {
      // The band's colour without its letters' pixels.
      const rough = median(inside);
      background = median(inside.filter(p => Math.hypot(p[0] - rough[0], p[1] - rough[1], p[2] - rough[2]) < 40));
      // The box reaches past the band's edges (into a light cell, as light as the letters): the
      // line is the band's own rows, those with its colour across a good part of their width
      // (the letters cover the rest).
      const banded = (y: number) => { let on = 0, all = 0; for (let x = x0; x < x1; x += 2, all++) if (far(rgb(y * w + x)) < 40) on++; return on > all * .3; };
      const rows = Array.from({ length: y1 - y0 }, (_, k) => banded(y0 + k)), first = rows.indexOf(true), last = rows.lastIndexOf(true);
      if (first < 0 || last - first < 3) return null;
      const [top, bottom] = [y0 + first, y0 + last + 1];
      [y0, y1] = [top, bottom];
      inside = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) inside.push(rgb(y * w + x));
    } else if (around.filter(p => far(p) > 40).length > around.length * .2) return null;
    // Most of the box one flat colour other than the ring: the line's own paper (the first line of
    // a tinted box, its ring half the white beyond it). Its letters stand on that.
    else if (flat > inside.length * .7 && far(middle) > 20) background = middle;
    // Ink: what stands apart from the background, darker or lighter.
    const distances = inside.map(far);
    const sorted = [...distances].sort((a, b) => a - b), strongest = sorted[Math.floor(sorted.length * .98)];
    if (strongest < 50) return null;
    // The colour of the strokes' cores, away from their soft edges (what the scan shows, which the
    // letters are matched against), and of their darkest tenth (the ink printed: a scan's blur never
    // lets a thin stroke reach its full colour), which the text is written in.
    const coreColour = (floor: number, like?: number[]) => {
      const sum = [0, 0, 0]; let count = 0;
      for (let y = y0, k = 0; y < y1; y++) for (let x = x0; x < x1; x++, k++) if (distances[k] > strongest * floor) {
        const p = rgb(y * w + x);
        // Of the line's own colour only (a black label beside teal words is not the teal's ink).
        if (like && Math.hypot(p[0] - like[0], p[1] - like[1], p[2] - like[2]) > 70) continue;
        sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; count++;
      }
      return count ? sum.map(v => Math.round(v / count) / 255) as [number, number, number] : null;
    };
    const color = coreColour(.7) ?? [0, 0, 0], printed = coreColour(.9, color.map(v => v * 255)) ?? color;
    // A word with a sub- or superscript (O₂, β₁, Ca²⁺) is misread (the small figure as a comma or a
    // dot, or lost): it stays as the scan shows it. Such a figure is a piece of ink about half the
    // small letters' height, starting above the baseline and reaching below it (often to the box's
    // foot), or above the letters; a piece reaching the box's top is the line above's, one wholly
    // below the baseline the next line's.
    {
      const isInk = (x: number, y: number) => far(rgb(y * w + x)) > strongest * .5, rows = Array.from({ length: y1 - y0 }, (_, r) => { let c = 0; for (let x = x0; x < x1; x++) if (isInk(x, y0 + r)) c++; return c; });
      const peak = Math.max(...rows), at = rows.indexOf(peak);
      let xTop = at, base = at; while (xTop > 0 && rows[xTop - 1] >= peak * .45) xTop--; while (base < rows.length && rows[base] >= peak * .45) base++;
      const xh = base - xTop;
      // The OCR's trace of a script it misread: a comma or point between a letter and more of the
      // word («β,-», «O.,», «DA,/»), or figures against letters («Ca2+», «β2»); a comma at a word's
      // end is only a comma.
      const scripted = (word: string) => /\p{L}[,.][-–/,.)\p{L}]/u.test(word) || /\p{L}\d|\d\p{L}/u.test(word);
      if (xh >= 4) words.forEach(({ box: [a, , b], text: said }, n) => {
        if (kept.includes(n) || !scripted(said ?? '')) return;
        // Not the word's own final comma or point.
        const wa = Math.max(x0, Math.floor(a)), wb = Math.min(x1, Math.ceil(b - (/[,;.]$/u.test(said ?? '') ? xh * .45 : 0))), cw = wb - wa, ch = y1 - y0;
        if (cw < 2) return;
        const seen = new Uint8Array(cw * ch);
        for (let start = 0; start < seen.length; start++) {
          if (seen[start] || !isInk(wa + start % cw, y0 + Math.floor(start / cw))) continue;
          let top = ch, bottom = 0, edge = false; const stack = [start]; seen[start] = 1;
          while (stack.length) {
            const i = stack.pop()!, x = i % cw, y = (i - x) / cw;
            top = Math.min(top, y); bottom = Math.max(bottom, y + 1); if (y === 0) edge = true;
            for (const j of [x > 0 ? i - 1 : -1, x < cw - 1 ? i + 1 : -1, y > 0 ? i - cw : -1, y < ch - 1 ? i + cw : -1]) if (j >= 0 && !seen[j] && isInk(wa + j % cw, y0 + Math.floor(j / cw))) { seen[j] = 1; stack.push(j); }
          }
          const height = bottom - top;
          if (edge || height < xh * .45 || height > xh * 1.05) continue;
          const below = bottom > base + xh * .2 && top > xTop + xh * .3 && top < base, above = bottom < base - xh * .45 && top < xTop - xh * .1;
          if (below || above) { kept.push(n); return; }
        }
      });
    }
    if (kept.length * 2 > words.length) return null;
    // Too few letters left to rewrite (a table cell's «+ α» once its «β₁» stays): the line stays whole.
    if (words.length && words.reduce((t, word, n) => t + (kept.includes(n) ? 0 : word.text?.replace(/[^\p{L}\p{N}]/gu, '').length ?? 4), 0) <= 3) return null;
    // Each word's own colour, from its strokes' cores the same way: kept only when clearly another.
    const colors = words.map(({ box: [a, , b] }) => {
      const tally = [0, 0, 0]; let seen = 0;
      for (let y = y0, k = 0; y < y1; y++) for (let x = x0; x < x1; x++, k++) if (x >= a && x < b && distances[k] > strongest * .85) { const p = inside[k]; tally[0] += p[0]; tally[1] += p[1]; tally[2] += p[2]; seen++; }
      if (seen < 6) return null;
      const own = tally.map(v => Math.round(v / seen) / 255) as [number, number, number];
      return Math.hypot(own[0] - color[0], own[1] - color[1], own[2] - color[2]) > .2 ? own : null;
    });
    // The faint edge of a blurred scan's letters is erased too: anything clearly off the plain background.
    const ink = color.map(v => v * 255), axis = Math.max(1, Math.hypot(ink[0] - background[0], ink[1] - background[1], ink[2] - background[2]));
    // How far a pixel lies from the background toward the ink's colour: a letter's soft edge does,
    // another colour beside the line (a table cell's edge, the white around a coloured box) does not.
    const toward = (r: number, g: number, b: number) => ((r - background[0]) * (ink[0] - background[0]) + (g - background[1]) * (ink[1] - background[1]) + (b - background[2]) * (ink[2] - background[2])) / axis;
    return { x0, x1, y0, y1, toward, band, ground: background, edge: Math.max(14, strongest * .1), grow: Math.max(3, Math.round((y1 - y0) * .09)), keep: kept.map(n => [words[n].box[0] - 1, y0, words[n].box[2] + 1, y1] as Box), style: { box: [x0, y0, x1, y1] as Box, color, background: background.map(v => v / 255) as [number, number, number], ink: printed, band, kept, colors } };
  });
  // Lines left in the image keep every pixel: erasing a neighbour must not reach into them.
  // A kept word is safe up to halfway into a neighbour's box that overlaps its own: the rest of
  // that overlap holds the neighbour's descenders (or accents), which go with it.
  const halfway = ([x0, y0, x1, y1]: Box, line: number): Box => {
    for (const [k, { box }] of lines.entries()) {
      if (k === line || box[2] <= x0 || box[0] >= x1) continue;
      if (box[1] < y0 && box[3] > y0 && box[3] < y1) y0 = (y0 + box[3]) / 2;
      if (box[3] > y1 && box[1] < y1 && box[1] > y0) y1 = (y1 + box[1]) / 2;
    }
    return [x0, y0, x1, y1];
  };
  const kept = looks.flatMap((look, i) => look ? [] : [lines[i].box]), words = looks.flatMap((look, i) => (look?.keep ?? []).map(box => halfway(box, i)));
  for (const look of looks) if (look) erase(image, look, kept, words);
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
  for (let c = 0; c < 3; c++) { const values = darkest[c].sort((a, b) => a - b); black[c] = values.length ? Math.min(35, values[Math.floor(values.length * .05)]) : 0; }
  const map = [0, 1, 2].map(c => Uint8ClampedArray.from({ length: 256 }, (_, v) => (v - black[c]) / Math.max(1, white[c] - black[c]) * 255));
  for (let i = 0; i < count; i++) {
    const o = i * n, mapped = [0, 1, 2].map(c => map[c][data[o + (n >= 3 ? c : 0)]]);
    // Near-white becomes white: paper grain and show-through from the other side.
    // Only greys and the paper's own faint tint: a pale coloured cell or box keeps its colour.
    const lum = (mapped[0] * 299 + mapped[1] * 587 + mapped[2] * 114) / 1000, chroma = Math.max(...mapped) - Math.min(...mapped);
    const lift = (lum > 235 ? 1 : lum > 215 ? (lum - 215) / 20 : 0) * (chroma <= 6 ? 1 : chroma >= 18 ? 0 : (18 - chroma) / 12);
    for (let c = 0; c < Math.min(n, 3); c++) data[o + c] = mapped[n >= 3 ? c : 0] + (255 - mapped[n >= 3 ? c : 0]) * lift;
  }
  flatAreas(image);
}

/**
 * Areas printed in one flat colour (a table's cells, a dark band, a tinted box) set to that
 * colour again: the scan's grain gone, and with it the faint trace erased letters leave. The
 * page's flat colours are those covering a good part of it; a pixel takes one only where all
 * of its neighbours are close to it too, so photos, gradients and letters' edges stay as they are.
 */
function flatAreas(image: Pixels) {
  const { data, width: w, height: h, channels: n } = image, count = w * h;
  if (n < 3) return;
  const step = Math.max(1, Math.floor(count / 200_000)), bins = new Map<number, number[]>();
  for (let i = 0; i < count; i += step) {
    const o = i * n, key = (data[o] >> 4) << 8 | (data[o + 1] >> 4) << 4 | data[o + 2] >> 4, bin = bins.get(key) ?? [0, 0, 0, 0];
    bin[0]++; bin[1] += data[o]; bin[2] += data[o + 1]; bin[3] += data[o + 2]; bins.set(key, bin);
  }
  const distance = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), palette: number[][] = [];
  for (const [seen, r, g, b] of [...bins.values()].sort((p, q) => q[0] - p[0])) {
    if (seen < count / step * .01 || palette.length >= 12) break;
    const colour = [r / seen, g / seen, b / seen];
    if (!palette.some(other => distance(other, colour) < 16)) palette.push(colour);
  }
  // Which flat colour each colour is near, looked up at 6 bits a channel.
  const near = new Int8Array(1 << 18).fill(-1);
  for (let key = 0; key < near.length; key++) {
    const p = [(key >> 12) * 4 + 2, (key >> 6 & 63) * 4 + 2, (key & 63) * 4 + 2];
    let best = -1, closest = 14; palette.forEach((colour, k) => { const d = distance(colour, p); if (d < closest) { closest = d; best = k; } });
    near[key] = best;
  }
  const label = new Int8Array(count);
  for (let i = 0; i < count; i++) { const o = i * n; label[i] = near[(data[o] >> 2) << 12 | (data[o + 1] >> 2) << 6 | data[o + 2] >> 2]; }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, k = label[i];
    if (k < 0) continue;
    let flat = true;
    for (let dy = -1; dy <= 1 && flat; dy++) for (let dx = -1; dx <= 1; dx++) if (label[i + dy * w + dx] !== k) { flat = false; break; }
    if (flat) for (let c = 0; c < 3; c++) data[i * n + c] = palette[k][c];
  }
}

/**
 * The letters of one line erased: their ink, the faint halo and the paler ringing a scan leaves
 * around it, and strokes running past the box (descenders, accents). Each erased pixel is filled
 * from the nearest clear background in its column and its row, weighed by nearness, so a cell's
 * edge, a band above or the next line never bleed in.
 */
function erase(image: Pixels, { x0, x1, y0, y1, toward, band, ground, edge, grow }: { x0: number; x1: number; y0: number; y1: number; toward: (r: number, g: number, b: number) => number; band: boolean; ground: number[]; edge: number; grow: number }, kept: Box[], words: Box[]) {
  // A kept word is safe everywhere; a kept line outside this line's box, and inside it (where
  // the boxes of close lines overlap) for the strokes that belong to it (see below).
  const inside = (x: number, y: number, b: Box) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3];
  const protectedAt = (x: number, y: number) => words.some(b => inside(x, y, b)) || ((y < y0 || y >= y1 || x < x0 || x >= x1) && kept.some(b => inside(x, y, b)));
  const { data, width: w, height: h, channels: n } = image, spread = 3, reach = band ? 0 : Math.ceil((y1 - y0) * .5), pad = band ? 0 : grow + 1 + spread;
  // The window: the line, its halo, and as far as its strokes may run past it.
  const left = Math.max(0, x0 - pad), right = Math.min(w, x1 + pad), top = Math.max(0, y0 - pad - reach), bottom = Math.min(h, y1 + pad + reach);
  const coreTop = Math.max(0, y0 - pad) - top, coreBottom = Math.min(h, y1 + pad) - top, cw = right - left, ch = bottom - top;
  const pixel = (x: number, y: number) => { const i = ((top + y) * w + left + x) * n; return n >= 3 ? [data[i], data[i + 1], data[i + 2]] : [data[i], data[i], data[i]]; };
  const off = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const halo = Math.max(8, edge * .55);
  // The background column by column, just above and just below the line:
  // a line can cross two colours, side by side (a heading over a green and a pink band) or one
  // above the other (a band's edge across its box), and a pixel is background near either.
  const rows = Math.max(2, Math.round((y1 - y0) * .3));
  // In each column the pixels furthest from the letters' colour (the lines just above and below
  // reach in with their own letters): the middle of the farther half, not the very farthest (a
  // grainy tint's lightest grain is near white). Then the middle of those across the columns around.
  const sampled = (above: boolean) => {
    const columns = Array.from({ length: cw }, (_, x) => {
      if (band) return ground;
      const samples: [number, number[]][] = [];
      for (let k = 1; k <= rows; k++) { const y = above ? coreTop - k : coreBottom - 1 + k; if (y < 0 || y >= ch) continue; const p = pixel(x, y); samples.push([toward(p[0], p[1], p[2]), p]); }
      if (!samples.length) return null;
      // The lighter quarter (the next lines' letters reach in), of what is not far lighter than the
      // line's own background (a thin white rule, the white beyond a coloured box are not it).
      // (On paper, grey or not, lighter is only cleaner paper: all count.)
      const tinted = Math.max(...ground) - Math.min(...ground) > 25, groundTone = toward(ground[0], ground[1], ground[2]);
      // Nor another colour altogether (a dark band just above a table row; on a tint, the white
      // beyond its box).
      const usable = samples.filter(([t, p]) => (!tinted || t > groundTone - halo) && off(p, ground) < (tinted ? 30 : 70)).sort((p, q) => p[0] - q[0]);
      return usable.length ? usable[usable.length >> 2][1] : null;
    });
    return columns.map((_, x) => { const near = columns.slice(Math.max(0, x - rows), x + rows + 1).filter(Boolean) as number[][]; return near.length ? [0, 1, 2].map(c => near.map(p => p[c]).sort((a, b) => a - b)[near.length >> 1]) : null; });
  };
  const aboveLocal = sampled(true), belowLocal = sampled(false);
  const local = aboveLocal.map((p, x) => p ?? belowLocal[x] ?? ground), under = belowLocal.map((p, x) => p ?? local[x]);
  const fromGround = (p: number[], x: number) => Math.min(off(p, local[x]), off(p, under[x]));
  // Ink: how far a pixel lies toward the letters' colour from its own column's background (the
  // line's one background colour would take a tinted band for ink).
  const base = local.map((p, x) => Math.max(toward(p[0], p[1], p[2]), toward(under[x][0], under[x][1], under[x][2])));
  const tone = (x: number, y: number) => { const p = pixel(x, y); return toward(p[0], p[1], p[2]) - base[x]; };
  // A rule (a table's line, an underline) is a thin run of solid ink far longer than any letter:
  // it stays. Solid: at full ink all along (letters' halos and serifs touch, their ink does not);
  // thin: clear a few pixels above and below (more on a finer scan, where a rule is thicker) along nearly all of it, or on one side when it runs on
  // past the text (a rule just over a title's capitals); a row through letters is a long run too.
  const rule = new Uint8Array(cw * ch), long = Math.max(40, (y1 - y0) * 4), gap = Math.max(3, Math.round((y1 - y0) * .15));
  for (let y = 0; y < ch; y++) for (let x = 0, run = 0; x <= cw; x++) {
    // At the halo's ink: a thin grey rule never reaches the letters' full ink.
    if (x < cw && tone(x, y) > halo) { run++; continue; }
    // A run reaching the window's side goes on beyond it (a table's rule under a short word).
    // (Followed far enough to tell whether it runs past the line's text.)
    let before = 0, after = 0;
    const far = long * 1.5 + (y1 - y0) * 2;
    if (run && x - run === 0) for (let k = -1; left + k >= 0 && before < far && tone(k, y) > halo; k--) before++;
    if (run && x === cw) for (let k = cw; left + k < w && after < far && tone(k, y) > halo; k++) after++;
    const length = run + before + after;
    if (length > long) {
      let both = 0, either = 0;
      for (let k = x - run; k < x; k++) { const up = y - gap < 0 || tone(k, y - gap) <= halo, down = y + gap >= ch || tone(k, y + gap) <= halo; if (up && down) both++; if (up || down) either++; }
      // A rule runs past the line's own text (a row along soft letters' feet or tops never does).
      const start = left + x - run - before, end = left + x + after;
      const beyond = start < x0 - (y1 - y0) || end > x1 + (y1 - y0);
      // Clear on both sides it is thin wherever it lies; clear on one side only (just over a title's
      // capitals) it must run past the line's text.
      if (both > run * .9 || (beyond && either > run * .9)) for (let yy = Math.max(0, y - 1); yy <= Math.min(ch - 1, y + 1); yy++) rule.fill(1, yy * cw + x - run, yy * cw + x);
      // Thick and longer still, it is a band or a filled box beside the line: it stays too.
      else if (beyond && length > long * 1.5) { let solid = 0; for (let k = x - run; k < x; k++) if (tone(k, y) > edge) solid++; if (solid > run * .95) rule.fill(1, y * cw + x - run, y * cw + x); }
    }
    run = 0;
  }
  // The ink, its faint halo included, grown by a few pixels.
  const mask = new Uint8Array(cw * ch);
  for (let y = coreTop; y < coreBottom; y++) for (let x = 0; x < cw; x++) if (!rule[y * cw + x] && tone(x, y) > halo) {
    for (let yy = Math.max(coreTop, y - grow); yy <= Math.min(coreBottom - 1, y + grow); yy++) mask.fill(1, yy * cw + Math.max(0, x - grow), yy * cw + Math.min(cw, x + grow + 1));
  }
  // A stroke can run past the box (a descender, an accent): followed until background, a little way.
  for (let x = 0; x < cw; x++) {
    // (Not into another colour beyond the line, a band above or below it: there no stroke runs on.)
    if (mask[coreTop * cw + x] && aboveLocal[x]) for (let y = coreTop - 1; y >= 0 && tone(x, y) > edge && !rule[y * cw + x]; y--) mask[y * cw + x] = 1;
    if (mask[(coreBottom - 1) * cw + x] && belowLocal[x]) for (let y = coreBottom; y < ch && tone(x, y) > edge && !rule[y * cw + x]; y++) mask[y * cw + x] = 1;
  }
  // Next to the letters, any pixel off the background either way goes too: a compressed scan
  // rings around dark strokes with paler, greyer pixels, which turn white once the paper is cleaned.
  const across = new Uint8Array(cw * ch), near = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (mask[y * cw + x]) across.fill(1, y * cw + Math.max(0, x - spread), y * cw + Math.min(cw, x + spread + 1));
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (across[y * cw + x]) for (let yy = Math.max(0, y - spread); yy <= Math.min(ch - 1, y + spread); yy++) near[yy * cw + x] = 1;
  // (Within the line's rows only: past them lies the next colour, not its ringing.)
  for (let i = 0; i < mask.length; i++) { const y = Math.floor(i / cw); if (!mask[i] && near[i] && !rule[i] && y >= coreTop && y < coreBottom && fromGround(pixel(i % cw, y), i % cw) > 12) mask[i] = 1; }
  // Where a kept line's box overlaps this one, each stroke goes with the line it belongs to: a
  // connected piece of ink stays when its middle is nearer the kept line's middle than this one's
  // (a descender of the line above, an accent of the line below), with its halo.
  const keep = new Uint8Array(cw * ch), overlapping = kept.filter(b => b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0);
  if (overlapping.length) {
    const label = new Int32Array(cw * ch).fill(-1), stack: number[] = [];
    for (let start = 0; start < label.length; start++) {
      if (label[start] >= 0 || tone(start % cw, Math.floor(start / cw)) <= halo) continue;
      const piece: number[] = []; label[start] = start; stack.push(start);
      while (stack.length) {
        const i = stack.pop()!, x = i % cw, y = (i - x) / cw; piece.push(i);
        for (const j of [x > 0 ? i - 1 : -1, x < cw - 1 ? i + 1 : -1, y > 0 ? i - cw : -1, y < ch - 1 ? i + cw : -1]) if (j >= 0 && label[j] < 0 && tone(j % cw, Math.floor(j / cw)) > halo) { label[j] = start; stack.push(j); }
      }
      const cy = top + piece.reduce((t, i) => t + Math.floor(i / cw), 0) / piece.length, cx = left + piece.reduce((t, i) => t + i % cw, 0) / piece.length;
      const owner = overlapping.find(b => cx >= b[0] && cx < b[2] && Math.abs(cy - (b[1] + b[3]) / 2) < Math.abs(cy - (y0 + y1) / 2));
      if (owner) for (const i of piece) { const x = i % cw, y = (i - x) / cw; for (let yy = Math.max(0, y - grow); yy <= Math.min(ch - 1, y + grow); yy++) keep.fill(1, yy * cw + Math.max(0, x - grow), yy * cw + Math.min(cw, x + grow + 1)); }
    }
  }
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (rule[y * cw + x] || keep[y * cw + x] || protectedAt(left + x, top + y)) mask[y * cw + x] = 0;
  const write = (x: number, y: number, value: number[]) => { const o = ((top + y) * w + left + x) * n; for (let c = 0; c < n; c++) data[o + c] = c === 3 ? 255 : value[n >= 3 ? c : 0]; };
  // On a band, its one colour.
  if (band) { for (let i = 0; i < mask.length; i++) if (mask[i]) write(i % cw, Math.floor(i / cw), ground); return; }
  // Clear background: what is left unerased and close to the background (not another line's letters).
  const clear = new Uint8Array(cw * ch);
  for (let i = 0; i < mask.length; i++) clear[i] = !mask[i] && !keep[i] && fromGround(pixel(i % cw, Math.floor(i / cw)), i % cw) < 30 ? 1 : 0;
  // The nearest clear pixel up, down, left and right of each erased one.
  const up = new Int32Array(cw * ch).fill(-1), down = new Int32Array(cw * ch).fill(-1), before = new Int32Array(cw * ch).fill(-1), after = new Int32Array(cw * ch).fill(-1);
  for (let x = 0; x < cw; x++) {
    for (let y = 0, last = -1; y < ch; y++) { const i = y * cw + x; if (clear[i]) last = y; else up[i] = last; }
    for (let y = ch - 1, last = -1; y >= 0; y--) { const i = y * cw + x; if (clear[i]) last = y; else down[i] = last; }
  }
  for (let y = 0; y < ch; y++) {
    for (let x = 0, last = -1; x < cw; x++) { const i = y * cw + x; if (clear[i]) last = x; else before[i] = last; }
    for (let x = cw - 1, last = -1; x >= 0; x--) { const i = y * cw + x; if (clear[i]) last = x; else after[i] = last; }
  }
  const fills: [number, number, number[]][] = [];
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = y * cw + x;
    if (!mask[i]) continue;
    const sum = [0, 0, 0]; let weight = 0;
    // The nearest weigh far more (a row between letters holds its own band's colour, sharp at its edge).
    const add = (px: number, py: number, d: number) => { const p = pixel(px, py), k = 1 / (d * d); for (let c = 0; c < 3; c++) sum[c] += p[c] * k; weight += k; };
    if (up[i] >= 0) add(x, up[i], y - up[i]);
    if (down[i] >= 0) add(x, down[i], down[i] - y);
    if (before[i] >= 0) add(before[i], y, x - before[i]);
    if (after[i] >= 0) add(after[i], y, after[i] - x);
    fills.push([x, y, weight ? sum.map(v => v / weight) : local[x]]);
  }
  for (const [x, y, value] of fills) write(x, y, value);
}
