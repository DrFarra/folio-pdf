import { mkdir, readFile, writeFile, copyFile, readdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../public/ocr/', import.meta.url);
await mkdir(root, { recursive: true });
await copyFile(new URL('../node_modules/tesseract.js/dist/worker.min.js', import.meta.url), new URL('worker.min.js', root));
await mkdir(new URL('core/', root), { recursive: true });
for (const name of await readdir(new URL('../node_modules/tesseract.js-core/', import.meta.url))) if (/lstm\.wasm(?:\.js)?$/.test(name)) {
  await copyFile(new URL(`../node_modules/tesseract.js-core/${name}`, import.meta.url), new URL(`core/${name}`, root));
  await chmod(new URL(`core/${name}`, root), 0o644); // The package ships some as executable.
}
await copyFile(new URL('../node_modules/tesseract.js-core/LICENSE', import.meta.url), new URL('core/LICENSE', root));
const revision = '87416418657359cb625c412a48b6e1d6d41c29bd';
const expectedHashes = { eng: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2', spa: '6f2e04d02774a18f01bed44b1111f2cd7f3ba7ac9dc4373cd3f898a40ea6b464' };
const existing = await readFile(new URL('models.json', root), 'utf8').then(JSON.parse).catch(() => null);
const models = [];
for (const code of ['eng', 'spa']) {
  const name = `${code}.traineddata`, path = new URL(name, root);
  let bytes = await readFile(path).catch(() => null);
  const recorded = existing?.models.find(model => model.code === code);
  if (!bytes) {
    const url = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${revision}/${name}`;
    const response = await fetch(url); if (!response.ok) throw new Error(`Modelo ${code}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer()); await writeFile(path, bytes);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedHashes[code]) throw new Error(`El modelo ${code} no coincide con el archivo publicado de esta versión.`);
  if (recorded && sha256 !== recorded.sha256) throw new Error(`El modelo ${code} no coincide con el hash registrado.`);
  models.push({ code, bytes: bytes.length, sha256, url: `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${revision}/${name}` });
}
await writeFile(new URL('models.json', root), JSON.stringify({ source: 'tesseract-ocr/tessdata_fast', revision, license: 'Apache-2.0', models }, null, 2));
console.log(JSON.stringify({ localOCR: true, models: models.map(({ code, bytes }) => ({ code, bytes })) }));
