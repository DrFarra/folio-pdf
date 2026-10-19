export type Box = { x: number; y: number; w: number; h: number };

/** Where a moved box lines up: its new place, and the guide lines it lines up on (page pixels). */
export type Snapped = { box: Box; x?: number; y?: number };

/** Moves `box` by at most `reach` on each axis so that one of its edges or its centre lines up
 * with an edge or the centre of one of `others`, or with the page's centre. Each axis snaps on its
 * own, to the nearest line. */
export function snapBox(box: Box, others: Box[], page: { width: number; height: number }, reach: number): Snapped {
  const nearest = (start: number, size: number, lines: number[]) => {
    let best: { shift: number; at: number } | null = null;
    for (const own of [start, start + size / 2, start + size])
      for (const at of lines) {
        const shift = at - own;
        if (Math.abs(shift) <= reach && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, at };
      }
    return best;
  };
  const x = nearest(box.x, box.w, [
      page.width / 2,
      ...others.flatMap(other => [other.x, other.x + other.w / 2, other.x + other.w]),
    ]),
    y = nearest(box.y, box.h, [
      page.height / 2,
      ...others.flatMap(other => [other.y, other.y + other.h / 2, other.y + other.h]),
    ]);
  return { box: { ...box, x: box.x + (x?.shift ?? 0), y: box.y + (y?.shift ?? 0) }, x: x?.at, y: y?.at };
}
