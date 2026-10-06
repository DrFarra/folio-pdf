import { copyFile, cp, mkdir } from 'node:fs/promises';
for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
  const target = new URL(`../public/pdfjs/${name}/`, import.meta.url); await mkdir(target, { recursive: true });
  // quickjs-eval runs PDF JavaScript in pdf.js's sandbox, which Folio never enables.
  await cp(new URL(`../node_modules/pdfjs-dist/${name}/`, import.meta.url), target, { recursive: true, force: true, filter: source => !/quickjs-eval\./.test(source) });
}
// Ajustes → Ver licencia shows this copy offline; keep it identical to LICENSE.
await mkdir(new URL('../public/licenses/', import.meta.url), { recursive: true });
await copyFile(new URL('../LICENSE', import.meta.url), new URL('../public/licenses/LICENSE.txt', import.meta.url));
await import('./prepare-ocr.mjs');
