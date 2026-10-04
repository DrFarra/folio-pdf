import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = process.cwd(), output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 3; i++) pdf.addPage([480, 620]).drawText(`Bookmark drag page ${i}`, { x: 45, y: 530, size: 20, font });
const source = path.join(output, 'bookmark-drag-source.pdf'), bytes = await pdf.save(); fs.writeFileSync(source, bytes);
const hash = createHash('sha256').update(bytes).digest('hex');
const node = (id, title, page, parentId, order, color = '#4579ba') => ({ id, title, page, parentId, order, color });
const original = [node('mother', 'Mother branch', null, null, 0, '#123abc'), node('page', 'Child page', 2, 'mother', 0),
  node('subgroup', 'Nested group', null, 'mother', 1, '#8a64b4'), node('grandchild', 'Grandchild page', 3, 'subgroup', 0, '#c89728'),
  { ...node('target', 'Destination group', null, null, 1), collapsed: true }, node('target-child', 'Existing child', 1, 'target', 0),
  node('page-parent', 'Page parent', 1, null, 2, '#448764')];
const chrome = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(fs.existsSync);
assert(process.env.FOLIO_TEST_BROWSER === 'webkit' || chrome, 'An installed Chrome or Edge is required.');
const port = process.env.FOLIO_BOOKMARK_DRAG_PORT || '4187', origin = `http://127.0.0.1:${port}`;
const viteArgs = process.env.FOLIO_BOOKMARK_DRAG_DEV ? [] : ['preview'];
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), ...viteArgs, '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let log = '', browser, page; server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
const errors = [], results = [];
const row = id => page.locator(`.bookmark-entry[data-bookmark-id="${id}"]`);
const stored = async (identity = hash) => page.evaluate(hash => JSON.parse(localStorage.getItem(`folio.session.${hash}`) || 'null'), identity);
const children = (nodes, parentId) => nodes.filter(node => node.parentId === parentId).sort((a, b) => a.order - b.order);
const branchAttributes = nodes => nodes.filter(node => ['mother', 'page', 'subgroup', 'grandchild'].includes(node.id)).map(({ parentId, order, collapsed, ...node }) => node);
async function waitParent(id, parentId, identity = hash) {
  await page.waitForFunction(({ hash, id, parentId }) => JSON.parse(localStorage.getItem(`folio.session.${hash}`) || 'null')?.bookmarks.some(node => node.id === id && node.parentId === parentId), { hash: identity, id, parentId });
}
async function open(file) {
  await page.locator('.app-header input[type=file]').setInputFiles(file);
  await page.getByRole('heading', { name: path.basename(file), exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  const sidebar = page.getByRole('button', { name: 'Marcadores', exact: true });
  if (await sidebar.getAttribute('aria-expanded') !== 'true') await sidebar.click();
  await row('mother').waitFor();
}
async function startDrag(id) {
  const box = await row(id).locator('.bookmark-label').boundingBox(); assert(box);
  const x = box.x + Math.min(24, box.width / 2), y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 8, y, { steps: 3 });
  await page.locator('.bookmark-drag-preview').waitFor();
}
async function over(id, position = 'inside') {
  const box = await row(id).boundingBox(); assert(box);
  await page.mouse.move(box.x + Math.min(85, box.width / 2), box.y + box.height * (position === 'before' ? .1 : position === 'after' ? .9 : .5), { steps: 12 });
}
async function drag(id, target, position = 'inside') {
  await startDrag(id); await over(target, position); await row(target).locator(`xpath=self::*[contains(@class,"drop-${position}")]`).waitFor(); await page.mouse.up();
  await page.locator('.bookmark-drag-preview').waitFor({ state: 'detached' });
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {} if (server.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert(ready, log || 'Vite did not start.'); browser = process.env.FOLIO_TEST_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true }); page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ hash, bookmarks }) => {
    const key = `folio.session.${hash}`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 3, annotations: [], bookmarks, lastPage: 1, documentRevision: hash }));
  }, { hash, bookmarks: original });
  await page.goto(origin); await open(source);
  await startDrag('mother'); await over('target');
  await row('target').locator('xpath=self::*[contains(@class,"drop-inside")]').waitFor();
  await row('target-child').waitFor(); // 600ms hover must expand the collapsed destination.
  await page.screenshot({ path: path.join(output, 'bookmark-drag-destination.png'), animations: 'disabled' });
  await page.mouse.up(); await waitParent('mother', 'target');
  let nodes = (await stored()).bookmarks;
  assert.deepEqual(branchAttributes(nodes), branchAttributes(original));
  assert.equal(nodes.find(node => node.id === 'page').parentId, 'mother');
  assert.equal(nodes.find(node => node.id === 'grandchild').parentId, 'subgroup');
  assert.equal(!!nodes.find(node => node.id === 'target').collapsed, false);
  assert.equal(await row('mother').getAttribute('aria-level'), '2');
  results.push({ id: 'root-branch-into-collapsed-parent-real-mouse', passed: true, hoverExpands: true, branchAttributesPreserved: true });

  await page.getByRole('button', { name: /^Deshacer \(/ }).click(); await waitParent('mother', null);
  assert.deepEqual((await stored()).bookmarks, original);
  await page.getByRole('button', { name: /^Rehacer \(/ }).click(); await waitParent('mother', 'target');
  results.push({ id: 'branch-move-undo-and-redo', passed: true });

  const beforeCycle = (await stored()).bookmarks;
  await startDrag('target'); await over('grandchild'); await row('grandchild').locator('xpath=self::*[contains(@class,"drop-blocked")]').waitFor();
  await page.mouse.up(); assert.deepEqual((await stored()).bookmarks, beforeCycle);
  await startDrag('mother'); await over('page-parent'); await page.keyboard.press('Escape'); await page.mouse.up();
  assert.deepEqual((await stored()).bookmarks, beforeCycle);
  results.push({ id: 'descendant-cycle-and-escape-cancel', passed: true });

  await drag('mother', 'page-parent', 'before'); await waitParent('mother', null);
  assert.deepEqual(children((await stored()).bookmarks, null).map(node => node.id), ['target', 'mother', 'page-parent']);
  await drag('mother', 'page-parent'); await waitParent('mother', 'page-parent');
  await startDrag('mother'); const rootDrop = page.getByLabel('Soltar en nivel principal', { exact: true });
  const bounds = await rootDrop.boundingBox(); assert(bounds); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 12 });
  await rootDrop.locator('xpath=self::*[contains(@class,"active")]').waitFor(); await page.mouse.up(); await waitParent('mother', null);
  assert.deepEqual(children((await stored()).bookmarks, null).map(node => node.id), ['target', 'page-parent', 'mother']);
  await drag('mother', 'target', 'before'); await waitParent('mother', null);
  await page.waitForFunction(hash => JSON.parse(localStorage.getItem(`folio.session.${hash}`)).bookmarks.find(node => node.id === 'mother').order === 0, hash);
  const final = (await stored()).bookmarks;
  assert.deepEqual(children(final, null).map(node => node.id), ['mother', 'target', 'page-parent']);
  assert.deepEqual(branchAttributes(final), branchAttributes(original));
  results.push({ id: 'reorder-page-parent-and-root-container', passed: true });

  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar', exact: true }).click();
  const downloaded = await pending, saved = path.join(output, 'bookmark-drag-saved.pdf'); await downloaded.saveAs(saved);
  await page.waitForFunction(() => !document.querySelector('.loading-overlay') && !document.querySelector('.download-button')?.disabled);
  const savedHash = createHash('sha256').update(fs.readFileSync(saved)).digest('hex');
  await waitParent('mother', null, savedHash); assert.deepEqual((await stored(savedHash)).bookmarks, final);
  await page.reload(); await open(saved); assert.deepEqual((await stored(savedHash)).bookmarks, final);
  assert.equal(await row('mother').getAttribute('aria-level'), '1'); assert.equal(await row('grandchild').getAttribute('aria-level'), '3');
  assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'), hash);
  await page.screenshot({ path: path.join(output, 'bookmark-drag-restored.png'), animations: 'disabled' });
  results.push({ id: 'save-and-reopen-restores-entire-branch', passed: true, sessionVersion: (await stored(savedHash)).version, originalPdfUnchanged: true });
  assert.deepEqual(errors, []);
} catch (error) {
  process.exitCode = 1; results.push({ id: 'bookmark-drag', passed: false, error: error.stack });
  if (page) await page.screenshot({ path: path.join(output, 'bookmark-drag-failure.png'), animations: 'disabled' });
} finally {
  await browser?.close(); server.kill();
  const report = { passed: results.length === 5 && results.every(result => result.passed) && !errors.length, results, errors };
  fs.writeFileSync(path.join(output, 'bookmark-drag-results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
