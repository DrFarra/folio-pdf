export type Change = { kind: 'added' | 'removed' | 'same'; text: string };
export function compareText(before: string, after: string): Change[] {
  const a = before.split('\n').map(s => s.trim()).filter(Boolean), b = after.split('\n').map(s => s.trim()).filter(Boolean);
  let prefix = 0; while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0; while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const left = a.slice(prefix, a.length - suffix), right = b.slice(prefix, b.length - suffix);
  if (left.length * right.length > 2_000_000) return [...left.map(text => ({ kind: 'removed' as const, text })), ...right.map(text => ({ kind: 'added' as const, text }))];
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const changes: Change[] = []; let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { changes.push({ kind: 'same', text: left[i] }); i++; j++; }
    else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) changes.push({ kind: 'added', text: right[j++] });
    else changes.push({ kind: 'removed', text: left[i++] });
  }
  return changes;
}

export function visualDifference(before: ImageData, after: ImageData): { image: ImageData; changedPixels: number } {
  if (before.width !== after.width || before.height !== after.height) throw new Error('Las imágenes deben tener el mismo tamaño.');
  const result = new ImageData(before.width, before.height); let changedPixels = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const changed = Math.max(...[0, 1, 2].map(n => Math.abs(before.data[i + n] - after.data[i + n]))) > 24;
    if (changed) { changedPixels++; result.data[i] = 220; result.data[i + 1] = 50; result.data[i + 2] = 60; }
    else { const gray = Math.round((after.data[i] + after.data[i + 1] + after.data[i + 2]) / 3 * .35 + 255 * .65); result.data[i] = result.data[i + 1] = result.data[i + 2] = gray; }
    result.data[i + 3] = 255;
  }
  return { image: result, changedPixels };
}
