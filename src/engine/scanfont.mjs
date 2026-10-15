// A typeface made from a scan's own letters, for when no font at hand looks like the page's.
// Every copy of a letter on the page is cut out at the scan's resolution, set on a common grid
// (baseline and size from its line, centred on its ink to a fraction of a pixel) and averaged:
// many soft, noisy copies make one clean, sharper shape. Its outline at half ink is traced and
// written into a real TrueType font, so the rebuilt text stays text, editable and searchable.
// Plain code with no imports: the tests run it in Node.

/** Grid cells per em the letters are averaged on. */
const GRID = 64;
const TOP = 1.05, BELOW = .35, SIDE = .7;

/**
 * The averaged shape of each letter. `samples`: one per letter found on the page, with its
 * character, the columns of the scan it may take (px), its line's baseline and em (px) and rows
 * (px), and the line's ink and background greys. Returns, per character, the average ink field
 * (GRID per em, TOP em above the baseline to BELOW below, SIDE em either side of its centre),
 * how many copies made it, and the page's typical space between letters (em).
 */
export function averageLetters(scan, samples) {
  const W = Math.round(SIDE * 2 * GRID), H = Math.round((TOP + BELOW) * GRID), sums = new Map(), gaps = [];
  const ink = (x, y, sample) => {
    if (x < sample.x0 || x >= sample.x1 || y < sample.top || y >= sample.bottom) return 0;
    const v = (scan.gray[y * scan.w + x] - sample.ground) / ((sample.text - sample.ground) || 1);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
  const bilinear = (x, y, sample) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    return (ink(x0, y0, sample) * (1 - fx) + ink(x0 + 1, y0, sample) * fx) * (1 - fy) + (ink(x0, y0 + 1, sample) * (1 - fx) + ink(x0 + 1, y0 + 1, sample) * fx) * fy;
  };
  // Each copy on the grid, centred on its ink.
  const copies = new Map();
  for (const sample of samples) {
    // Its ink's centre, across and down to the baseline, to a fraction of a pixel.
    let mass = 0, cx = 0, left = Infinity, right = -Infinity;
    for (let y = sample.top; y < sample.bottom; y++) for (let x = sample.x0; x < sample.x1; x++) { const v = ink(x, y, sample); if (v > .05) { mass += v; cx += v * x; } if (v > .5) { left = Math.min(left, x); right = Math.max(right, x); } }
    if (mass < 2 || right < left) continue;
    cx /= mass;
    sample.left = left; sample.right = right + 1;
    let list = copies.get(sample.char);
    if (!list) copies.set(sample.char, list = []);
    // Enough copies to average out the scan's grain; more only cost time.
    if (list.length >= 48) continue;
    const grid = new Float32Array(W * H), em = sample.em;
    for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) {
      const x = cx + ((gx + .5) / GRID - SIDE) * em, y = sample.baseline + ((gy + .5) / GRID - TOP) * em;
      grid[gy * W + gx] = bilinear(x - .5, y - .5, sample);
    }
    list.push({ grid, width: (right + 1 - left) / em });
  }
  for (const [char, list] of copies) sums.set(char, register(list, W, H));
  // The space between letters, from neighbours within a word.
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.word === b.word && a.right !== undefined && b.left !== undefined && b.left > a.right) gaps.push((b.left - a.right) / a.em);
  }
  gaps.sort((p, q) => p - q);
  const letters = new Map();
  for (const [char, entry] of sums) if (entry) letters.set(char, entry);
  const ems = samples.map(sample => sample.em).sort((p, q) => p - q);
  return { letters, width: W, height: H, gap: gaps.length ? gaps[gaps.length >> 1] : .08, em: ems[ems.length >> 1] || GRID };
}

/**
 * Copies of one letter made one: averaged, each copy then moved (a fraction of a pixel, in whole
 * grid cells) to where it matches the average best, the copies that match it worst (a letter cut
 * badly, or misread) dropped, and averaged again. The average's field, how many copies made it,
 * and their typical ink width (em).
 */
function register(list, W, H) {
  if (!list.length) return null;
  const mean = copies => { const field = new Float32Array(W * H); for (const { grid, dx = 0, dy = 0 } of copies) for (let y = 0; y < H; y++) { const sy = y - dy; if (sy < 0 || sy >= H) continue; for (let x = 0; x < W; x++) { const sx = x - dx; if (sx >= 0 && sx < W) field[y * W + x] += grid[sy * W + sx]; } } for (let i = 0; i < field.length; i++) field[i] /= copies.length; return field; };
  const match = (field, grid, dx, dy) => { let sum = 0; for (let y = Math.max(0, dy); y < Math.min(H, H + dy); y += 2) for (let x = Math.max(0, dx); x < Math.min(W, W + dx); x += 2) sum += field[y * W + x] * grid[(y - dy) * W + x - dx]; return sum; };
  let kept = list, field = mean(kept);
  for (let round = 0; round < 2 && kept.length >= 3; round++) {
    for (const copy of kept) {
      let best = -Infinity;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const v = match(field, copy.grid, dx, dy); if (v > best) { best = v; copy.dx = dx; copy.dy = dy; } }
      // How alike, against the copy's own ink and the average's (a heavier copy is not a better one).
      let own = 0; for (let i = 0; i < copy.grid.length; i += 2) own += copy.grid[i] * copy.grid[i];
      copy.fit = best / Math.sqrt(Math.max(1e-9, own));
    }
    const fits = kept.map(copy => copy.fit).sort((p, q) => p - q), floor = fits[Math.floor(fits.length * .25)];
    if (kept.length >= 6) kept = kept.filter(copy => copy.fit >= floor);
    field = mean(kept);
  }
  const widths = kept.map(copy => copy.width).sort((p, q) => p - q);
  return { field, count: kept.length, width: widths[widths.length >> 1] };
}

/**
 * A field sharpened back toward the shapes before the scan softened them: Richardson-Lucy
 * deconvolution with a Gaussian of `sigma` grid cells (the scan's blur, in the grid). Many
 * copies averaged hold detail enough for it; one alone would give noise.
 */
export function sharpen(field, w, h, sigma, rounds = 12) {
  if (!(sigma > .3)) return field;
  const radius = Math.ceil(sigma * 2.5), kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma))), total = kernel.reduce((t, v) => t + v, 0);
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  const blur = values => {
    const across = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let k = -radius; k <= radius; k++) { const xx = x + k; if (xx >= 0 && xx < w) s += values[y * w + xx] * kernel[k + radius]; } across[y * w + x] = s; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let k = -radius; k <= radius; k++) { const yy = y + k; if (yy >= 0 && yy < h) s += across[yy * w + x] * kernel[k + radius]; } out[y * w + x] = s; }
    return out;
  };
  const observed = Float32Array.from(field, v => Math.max(1e-3, v));
  let estimate = Float32Array.from(observed);
  for (let round = 0; round < rounds; round++) {
    const blurred = blur(estimate), ratio = new Float32Array(w * h);
    for (let i = 0; i < ratio.length; i++) ratio[i] = observed[i] / Math.max(1e-4, blurred[i]);
    const correction = blur(ratio);
    for (let i = 0; i < estimate.length; i++) estimate[i] = Math.min(1.5, estimate[i] * correction[i]);
  }
  return estimate;
}

/**
 * A field set against its own strongest ink around each cell (within `radius` cells, never less
 * than `floor`): a hairline thinner than a scan pixel never reaches half ink, yet it is a stroke,
 * and its outline at half is then drawn where it is (as wide as the scan shows it); a full stroke
 * keeps its half-ink outline.
 */
export function relative(field, w, h, radius, floor = .3) {
  const across = new Float32Array(w * h), peak = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = Math.max(0, x - radius); k <= Math.min(w - 1, x + radius); k++) m = Math.max(m, field[y * w + k]); across[y * w + x] = m; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = Math.max(0, y - radius); k <= Math.min(h - 1, y + radius); k++) m = Math.max(m, across[k * w + x]); peak[y * w + x] = m; }
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, field[i] / Math.max(floor, Math.min(1, peak[i])));
  return out;
}

/**
 * The level that keeps a field's ink: as many cells above it as the field holds ink in all. A soft
 * average spreads each stroke, half-ink cuts its thin parts (serifs, hairlines) away; this keeps
 * the stroke's weight where the scan had it.
 */
export function inkLevel(field) {
  // The paper's grain is faint ink everywhere: what is barely off the paper does not count.
  let mass = 0; for (const v of field) if (v > .1) mass += (v - .1) / .9;
  const sorted = Float32Array.from(field).sort().reverse(), level = sorted[Math.min(sorted.length - 1, Math.round(mass))];
  return Math.min(.6, Math.max(.3, level));
}

/**
 * The outline of a field at `level`: closed loops of points in grid units (x right, y down),
 * found by marching squares with each crossing placed along its edge by the values either side.
 */
export function traceOutline(field, w, h, level = .5) {
  const at = (x, y) => x < 0 || y < 0 || x >= w || y >= h ? 0 : field[y * w + x];
  // Each cell edge crossed gets a point; segments join points of one cell.
  const point = new Map(), next = new Map();
  const cross = (ax, ay, bx, by) => {
    const key = ax < bx || (ax === bx && ay < by) ? `${ax},${ay},${bx},${by}` : `${bx},${by},${ax},${ay}`;
    if (!point.has(key)) { const va = at(ax, ay), vb = at(bx, by), t = (level - va) / ((vb - va) || 1e-9); point.set(key, [ax + (bx - ax) * t + .5, ay + (by - ay) * t + .5]); }
    return key;
  };
  for (let y = -1; y < h; y++) for (let x = -1; x < w; x++) {
    // Corners: a top-left, b top-right, c bottom-right, d bottom-left; inside when above level.
    const a = at(x, y) > level, b = at(x + 1, y) > level, c = at(x + 1, y + 1) > level, d = at(x, y + 1) > level;
    const top = () => cross(x, y, x + 1, y), rightE = () => cross(x + 1, y, x + 1, y + 1), bottom = () => cross(x, y + 1, x + 1, y + 1), leftE = () => cross(x, y, x, y + 1);
    // Segments run with ink on their right (y down): outer loops come out one way, holes the other.
    const add = (from, to) => next.set(from(), to());
    switch ((a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0)) {
      case 1: add(bottom, leftE); break;
      case 2: add(rightE, bottom); break;
      case 3: add(rightE, leftE); break;
      case 4: add(top, rightE); break;
      case 5: { const centre = (at(x, y) + at(x + 1, y) + at(x + 1, y + 1) + at(x, y + 1)) / 4 > level; if (centre) { add(top, leftE); add(bottom, rightE); } else { add(top, rightE); add(bottom, leftE); } break; }
      case 6: add(top, bottom); break;
      case 7: add(top, leftE); break;
      case 8: add(leftE, top); break;
      case 9: add(bottom, top); break;
      case 10: { const centre = (at(x, y) + at(x + 1, y) + at(x + 1, y + 1) + at(x, y + 1)) / 4 > level; if (centre) { add(leftE, bottom); add(rightE, top); } else { add(leftE, top); add(rightE, bottom); } break; }
      case 11: add(rightE, top); break;
      case 12: add(leftE, rightE); break;
      case 13: add(bottom, rightE); break;
      case 14: add(leftE, bottom); break;
    }
  }
  const loops = [], seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = []; let key = start;
    while (key !== undefined && !seen.has(key)) { seen.add(key); loop.push(point.get(key)); key = next.get(key); }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** A closed loop with points closer than `tolerance` to the line between their neighbours dropped. */
export function simplify(loop, tolerance) {
  const reduce = (points) => {
    if (points.length < 3) return points;
    const [ax, ay] = points[0], [bx, by] = points[points.length - 1], length = Math.hypot(bx - ax, by - ay) || 1e-9;
    let far = 0, index = 0;
    for (let i = 1; i < points.length - 1; i++) { const [px, py] = points[i], d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length; if (d > far) { far = d; index = i; } }
    return far > tolerance ? [...reduce(points.slice(0, index + 1)).slice(0, -1), ...reduce(points.slice(index))] : [points[0], points[points.length - 1]];
  };
  // Split at the point farthest from the first, so both halves are open runs.
  let split = 0, far = 0;
  for (let i = 1; i < loop.length; i++) { const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]); if (d > far) { far = d; split = i; } }
  const first = reduce(loop.slice(0, split + 1)), second = reduce([...loop.slice(split), loop[0]]);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/**
 * A TrueType font (glyf outlines, straight segments) from glyphs given in font units (y up,
 * 1000 per em): each `{ char, contours: [[x, y], ...][], advance }`; outer contours clockwise,
 * holes counter-clockwise. A space and an empty .notdef come first.
 */
export function trueType({ name, ascent, descent, xHeight, capHeight, space, glyphs }) {
  const all = [{ char: null, contours: [], advance: 500 }, { char: ' ', contours: [], advance: Math.round(space) }, ...glyphs].map(glyph => ({ ...glyph, contours: glyph.contours.map(contour => contour.map(([x, y]) => [Math.round(x), Math.round(y)])) }));
  const u16 = v => [(v >> 8) & 255, v & 255], i16 = v => u16(v < 0 ? v + 65536 : v), u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  // glyf and loca.
  const glyf = [], loca = [], bounds = [];
  for (const glyph of all) {
    loca.push(glyf.length);
    const points = glyph.contours.flat();
    if (!points.length) { bounds.push([0, 0, 0, 0]); continue; }
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]), box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    bounds.push(box);
    const out = [...i16(glyph.contours.length), ...box.flatMap(i16)];
    let end = -1; for (const contour of glyph.contours) { end += contour.length; out.push(...u16(end)); }
    out.push(...u16(0));
    for (let i = 0; i < points.length; i++) out.push(1);
    let px = 0, py = 0;
    for (const [x] of points) { out.push(...i16(x - px)); px = x; }
    for (const [, y] of points) { out.push(...i16(y - py)); py = y; }
    while (out.length % 4) out.push(0);
    glyf.push(...out);
  }
  loca.push(glyf.length);
  const numGlyphs = all.length, xMin = Math.min(0, ...bounds.map(b => b[0])), yMin = Math.min(descent, ...bounds.map(b => b[1])), xMax = Math.max(...bounds.map(b => b[2])), yMax = Math.max(ascent, ...bounds.map(b => b[3]));
  const head = [...u32(0x00010000), ...u32(0x00010000), ...u32(0), ...u32(0x5F0F3CF5), ...u16(0x000B), ...u16(1000), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...i16(xMin), ...i16(yMin), ...i16(xMax), ...i16(yMax), ...u16(0), ...u16(8), ...i16(2), ...i16(1), ...i16(0)];
  const advances = all.map(g => g.advance);
  const hhea = [...u32(0x00010000), ...i16(ascent), ...i16(descent), ...i16(0), ...u16(Math.max(...advances)), ...i16(Math.min(0, ...bounds.map(b => b[0]))), ...i16(0), ...i16(xMax), ...i16(1), ...i16(0), ...i16(0), 0, 0, 0, 0, 0, 0, 0, 0, ...i16(0), ...u16(numGlyphs)];
  const hmtx = all.flatMap((g, i) => [...u16(g.advance), ...i16(bounds[i][0])]);
  const maxPoints = Math.max(0, ...all.map(g => g.contours.flat().length)), maxContours = Math.max(0, ...all.map(g => g.contours.length));
  const maxp = [...u32(0x00010000), ...u16(numGlyphs), ...u16(maxPoints), ...u16(maxContours), ...u16(0), ...u16(0), ...u16(2), ...Array(18).fill(0)];
  const post = [...u32(0x00030000), ...u32(0), ...i16(-100), ...i16(50), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0)];
  // cmap: one segment per character, format 4.
  const mapped = all.map((g, id) => [g.char?.codePointAt(0), id]).filter(([code]) => code !== undefined && code < 0xFFFF).sort((a, b) => a[0] - b[0]);
  const segments = [...mapped, [0xFFFF, 0]], segX2 = segments.length * 2, power = 2 ** Math.floor(Math.log2(segments.length));
  const sub = [...u16(4), ...u16(0), ...u16(0), ...u16(segX2), ...u16(power * 2), ...u16(Math.log2(power)), ...u16(segX2 - power * 2),
    ...segments.flatMap(([code]) => u16(code)), ...u16(0), ...segments.flatMap(([code]) => u16(code)), ...segments.flatMap(([code, id]) => code === 0xFFFF ? u16(1) : u16((id - code + 65536) % 65536)), ...segments.flatMap(() => u16(0))];
  sub.splice(2, 2, ...u16(sub.length));
  const cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...sub];
  // name: family, style, full name, PostScript name (Windows, UTF-16BE).
  const strings = [[1, name], [2, 'Regular'], [4, name], [6, name.replace(/[^A-Za-z0-9-]/g, '')]], utf16 = text => [...text].flatMap(c => u16(c.charCodeAt(0)));
  const storage = [], records = [];
  for (const [id, text] of strings) { const bytes = utf16(text); records.push(...u16(3), ...u16(1), ...u16(0x409), ...u16(id), ...u16(bytes.length), ...u16(storage.length)); storage.push(...bytes); }
  const nameTable = [...u16(0), ...u16(strings.length), ...u16(6 + records.length), ...records, ...storage];
  const codes = mapped.map(m => m[0]), average = Math.round(advances.reduce((t, a) => t + a, 0) / advances.length);
  const os2 = [...u16(4), ...i16(average), ...u16(400), ...u16(5), ...u16(0), ...Array(20).fill(0), ...i16(0), ...Array(10).fill(0), ...u32(1), ...u32(0), ...u32(0), ...u32(0), 70, 76, 73, 79, ...u16(0x40),
    ...u16(Math.min(...codes, 0xFFFF)), ...u16(Math.max(...codes, 0)), ...i16(ascent), ...i16(descent), ...i16(0), ...u16(ascent), ...u16(-descent), ...u32(1), ...u32(0), ...i16(xHeight), ...i16(capHeight), ...u16(0), ...u16(32), ...u16(1)];
  const tables = { 'OS/2': os2, cmap, glyf, head, hhea, hmtx, loca: loca.flatMap(u32), maxp, name: nameTable, post };
  const tags = Object.keys(tables).sort(), count = tags.length, power2 = 2 ** Math.floor(Math.log2(count));
  const sum = bytes => { let total = 0; for (let i = 0; i < bytes.length; i += 4) total = (total + ((bytes[i] << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))) >>> 0; return total; };
  const header = [...u32(0x00010000), ...u16(count), ...u16(power2 * 16), ...u16(Math.log2(power2)), ...u16(count * 16 - power2 * 16)];
  let offset = 12 + count * 16; const directory = [], body = [];
  for (const tag of tags) {
    const bytes = tables[tag];
    directory.push(...[...tag].map(c => c.charCodeAt(0)), ...u32(sum(bytes)), ...u32(offset), ...u32(bytes.length));
    body.push(...bytes); while (body.length % 4) body.push(0);
    offset = 12 + count * 16 + body.length;
  }
  const file = new Uint8Array([...header, ...directory, ...body]);
  // head's checkSumAdjustment, over the whole file.
  const at = 12 + count * 16 + (() => { let o = 0; for (const tag of tags) { if (tag === 'head') return o; o += tables[tag].length + ((4 - tables[tag].length % 4) % 4); } return 0; })();
  const adjust = (0xB1B0AFBA - sum(file)) >>> 0;
  file.set(u32(adjust), at + 8);
  return file;
}

/**
 * A font from averaged letters: each letter's outline at half ink, placed with the page's own
 * spacing (half the usual gap between letters on either side). `letters` from averageLetters.
 * Only letters seen often enough (`least` copies) are made; `blur`, how soft the scan is (the
 * Gaussian's sigma, in scan pixels), is undone first; with `lift`, strokes too thin to reach half
 * ink are kept (see relative), at no less than that ink. `level`: the ink every outline is drawn
 * at, one for the whole face so its letters share one weight (0: each letter's own, keeping its ink).
 */
export function fontFromLetters({ letters, width, height, gap, em }, name, least = 5, level = .5, blur = .55, lift = .5) {
  const unit = 1000 / GRID, side = Math.max(20, Math.round(gap / 2 * 1000)), glyphs = [];
  for (const [char, { field, count }] of letters) {
    // Capitals are few and often kerned under their neighbour (an L's foot), so cut short: they need more copies.
    if (count < (/\p{Lu}/u.test(char) ? least + 3 : least) || /\s/.test(char)) continue;
    // The scan's blur (`blur` scan pixels) in grid cells, undone before the outline is traced.
    const soft = sharpen(field, width, height, blur * GRID / em), sharp = lift ? relative(soft, width, height, Math.round(GRID * .06), lift) : soft;
    const loops = traceOutline(sharp, width, height, level || inkLevel(sharp)).map(loop => simplify(loop, .35)).filter(loop => loop.length >= 3);
    if (!loops.length) continue;
    // In font units, y up from the baseline.
    let contours = loops.map(loop => loop.map(([x, y]) => [x * unit, (TOP * GRID - y) * unit]));
    const area = contour => contour.reduce((t, [x, y], i) => { const [nx, ny] = contour[(i + 1) % contour.length]; return t + (x * ny - nx * y); }, 0) / 2;
    // Specks (a neighbour's edge, the paper's grain) are no part of a letter; a hole may be small.
    contours = contours.filter(contour => Math.abs(area(contour)) > (area(contour) < 0 ? 1500 : 40));
    if (!contours.length) continue;
    // Outer loops clockwise (negative area, y up), holes the other way: TrueType's non-zero rule.
    const inside = ([px, py], contour) => { let hit = false; for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) { const [xi, yi] = contour[i], [xj, yj] = contour[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) hit = !hit; } return hit; };
    contours = contours.map(contour => { const depth = contours.filter(other => other !== contour && inside(contour[0], other)).length, outer = depth % 2 === 0; return (area(contour) < 0) === outer ? contour : [...contour].reverse(); });
    const xs = contours.flat().map(p => p[0]), left = Math.min(...xs), right = Math.max(...xs);
    glyphs.push({ char, contours: contours.map(contour => contour.map(([x, y]) => [x - left + side, y])), advance: Math.round(right - left + side * 2) });
  }
  if (!glyphs.length) return null;
  const tall = c => { const g = glyphs.find(g => g.char === c); return g ? Math.max(...g.contours.flat().map(p => p[1])) : 0; };
  const space = Math.max(180, Math.round(gap * 3.5 * 1000));
  return trueType({ name, ascent: Math.round(TOP * 1000), descent: -Math.round(BELOW * 1000), xHeight: tall('x') || 480, capHeight: tall('H') || 700, space, glyphs });
}
