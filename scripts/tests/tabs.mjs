import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';
import { enterAnnotationMode, desktopDocumentAction } from './ui-helpers.mjs';

const root = process.cwd(), output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const sources = [];
for (const letter of ['A', 'B']) {
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = document.addPage([600, 760]);
    page.drawText(`TAB ${letter} PAGE ${i}`, { x: 60, y: 670, size: 20, font });
    page.drawText(`${letter} CONTENT ONLY`, { x: 60, y: 620, size: 16, font });
  }
  const file = path.join(output, `tabs-${letter}.pdf`), bytes = await document.save();
  fs.writeFileSync(file, bytes);
  sources.push({ letter, file, name: path.basename(file), hash: createHash('sha256').update(bytes).digest('hex') });
}
const [a, b] = sources;
const chrome = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(fs.existsSync);
assert(chrome, 'An installed Chrome or Edge is required.');
const origin = 'http://127.0.0.1:4178';
const preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '4178', '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let browser, log = ''; preview.stdout.on('data', data => { log += data; }); preview.stderr.on('data', data => { log += data; });
const results = [], errors = [];
const input = page => page.getByRole('textbox', { name: 'Número de página', exact: true });
const zoom = page => page.getByRole('combobox', { name: 'Nivel de zoom', exact: true });
const tab = (page, source) => page.getByRole('tab', { name: source.name, exact: true });

async function active(page, source) {
  await page.waitForFunction(name => Array.from(document.querySelectorAll('[role=tab]')).some(node => node.getAttribute('aria-label') === name && node.getAttribute('aria-selected') === 'true'), source.name);
  await page.getByRole('heading', { name: source.name, exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
}
async function open(page, source) { await page.locator('.app-header input[type=file]').setInputFiles(source.file); await active(page, source); }
async function switchTo(page, source) { await tab(page, source).click(); await active(page, source); }
async function check(id, action) {
  if (process.env.FOLIO_TABS_TEST && !new RegExp(process.env.FOLIO_TABS_TEST).test(id)) return;
  const context = await browser.newContext({ viewport: { width: 1360, height: 1050 }, acceptDownloads: true }), page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push({ id, error: error.message }));
  try { await page.goto(origin); await open(page, a); const evidence = await action(page); results.push({ id, status: 'passed', ...evidence }); }
  catch (error) { process.exitCode = 1; results.push({ id, status: 'failed', error: error.stack }); await page.screenshot({ path: path.join(output, `failure-${id}.png`), animations: 'disabled' }); }
  finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
}
async function go(page, number) {
  await input(page).fill(String(number)); await input(page).press('Enter');
  await page.waitForFunction(number => {
    const reader = document.querySelector('.reading-area'), sheet = document.querySelector(`.pdf-page-wrap[data-page-number="${number}"]`);
    if (!reader || !sheet) return false;
    const absoluteTop = sheet.getBoundingClientRect().top - reader.getBoundingClientRect().top + reader.scrollTop;
    const target = Math.max(0, Math.min(reader.scrollHeight - reader.clientHeight, absoluteTop - 16));
    return Math.abs(reader.scrollTop - target) < 3;
  }, number);
  await page.locator(`.pdf-page-wrap[data-page-number="${number}"] .page-loading`).waitFor({ state: 'detached' });
}
async function annotate(page, source) {
  await zoom(page).selectOption('100'); await go(page, 1);
  await enterAnnotationMode(page);
  await page.getByRole('button', { name: 'Resaltado automático (H)', exact: true }).click();
  const span = page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: `TAB ${source.letter} PAGE 1` }).first(); await span.waitFor();
  const rect = await span.boundingBox();
  await page.mouse.move(rect.x + 1, rect.y + rect.height / 2); await page.mouse.down(); await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 10 }); await page.mouse.up();
  await page.locator('.highlight-annotation').first().waitFor();
}
async function download(page, name) {
  const promise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar', exact: true }).click();
  const download = await promise, target = path.join(output, name); await download.saveAs(target);
  await page.waitForFunction(() => document.querySelector('.download-button:not([disabled])') && !document.querySelector('.loading-overlay') && !document.querySelector('.pdf-page-wrap[data-page-number="1"] .page-loading'));
  return fs.readFileSync(target);
}
const row = (page, title) => page.locator('.bookmark-entry').filter({ has: page.locator('.bookmark-label', { hasText: new RegExp(`^${title}$`) }) }).first();
async function options(page, title, action) { await page.getByRole('button', { name: `Opciones de ${title}`, exact: true }).click(); await page.getByRole('menuitem', { name: action, exact: true }).click(); }
async function rename(page, title) { const editor = page.getByRole('textbox', { name: 'Nombre del marcador', exact: true }); await editor.fill(title); await editor.press('Enter'); await row(page, title).waitFor(); }
async function session(page, source = a) { return page.evaluate(hash => JSON.parse(localStorage.getItem(`folio.session.${hash}`) || 'null'), source.hash); }
async function waitSession(page, source, title) { await page.waitForFunction(({ hash, title }) => (localStorage.getItem(`folio.session.${hash}`) || '').includes(title), { hash: source.hash, title }); }
const children = (nodes, parentId) => nodes.filter(node => node.parentId === parentId).sort((left, right) => left.order - right.order);

try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {} if (preview.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert(ready, log || 'Preview did not start.'); browser = await chromium.launch({ executablePath: chrome, headless: true });

  await check('open-multiple-files-and-deduplicate-tabs', async page => {
    await page.locator('.app-header input[type=file]').setInputFiles([a.file, b.file]); await active(page, b);
    assert.equal(await page.getByRole('tab').count(), 2);
    await open(page, a); assert.equal(await page.getByRole('tab').count(), 2);
    assert.equal(await page.getByRole('button', { name: 'Abrir PDF', exact: true }).count(), 1);
    await page.screenshot({ path: path.join(output, 'tabs-open-documents.png'), animations: 'disabled' });
    return { simultaneousDocuments: 2, duplicateFileFocusesExistingTab: true, openControls: 1 };
  });

  await check('annotations-history-and-export-stay-with-their-document', async page => {
    await annotate(page, a); await open(page, b); await annotate(page, b); await switchTo(page, a);
    await page.getByRole('button', { name: 'Deshacer (Ctrl+Z)', exact: true }).click(); assert.equal(await page.locator('.highlight-annotation').count(), 0);
    await switchTo(page, b); assert(await page.locator('.highlight-annotation').count() > 0);
    await switchTo(page, a); await page.getByRole('button', { name: 'Rehacer (Ctrl+Y)', exact: true }).click();
    const bytesA = await download(page, 'tabs-export-A.pdf'), notesA = inspectDocument(bytesA).annotations;
    assert.equal(notesA.length, 1); assert(notesA[0].text.includes('TAB A PAGE 1')); assert(!notesA[0].text.includes('TAB B'));
    await switchTo(page, b); const bytesB = await download(page, 'tabs-export-B.pdf'), notesB = inspectDocument(bytesB).annotations;
    assert.equal(notesB.length, 1); assert(notesB[0].text.includes('TAB B PAGE 1')); assert(!notesB[0].text.includes('TAB A'));
    assert(operateDocument(bytesA, { operation: 'text' })[0].includes('A CONTENT ONLY'));
    assert(operateDocument(bytesB, { operation: 'text' })[0].includes('B CONTENT ONLY'));
    assert.equal(await page.getByRole('tab').count(), 2);
    return { annotationIsolation: true, undoRedoIsolation: true, exportedMatchingDocuments: true };
  });

  await check('each-tab-restores-page-zoom-and-scroll', async page => {
    await page.setViewportSize({ width: 1360, height: 690 });
    await zoom(page).selectOption('125'); await go(page, 2);
    const scrollA = await page.locator('.reading-area').evaluate(node => node.scrollTop);
    await open(page, b); await zoom(page).selectOption('75'); await go(page, 3);
    const scrollB = await page.locator('.reading-area').evaluate(node => node.scrollTop);
    await switchTo(page, a);
    await page.waitForFunction(() => document.querySelector('[aria-label="Número de página"]').value === '2'); assert.equal(await zoom(page).inputValue(), '125');
    await page.waitForFunction(expected => Math.abs(document.querySelector('.reading-area').scrollTop - expected) < 3, scrollA);
    await switchTo(page, b);
    await page.waitForFunction(() => document.querySelector('[aria-label="Número de página"]').value === '3'); assert.equal(await zoom(page).inputValue(), '75');
    await page.waitForFunction(expected => Math.abs(document.querySelector('.reading-area').scrollTop - expected) < 3, scrollB);
    return { firstDocumentPage: 2, secondDocumentPage: 3, zoomPercents: [125, 75], preservedScroll: true };
  });

  await check('close-inactive-tab-reopen-session-and-keyboard-switch', async page => {
    await annotate(page, a); await open(page, b);
    await page.getByRole('button', { name: `Cerrar ${a.name}`, exact: true }).click(); await tab(page, a).waitFor({ state: 'detached' }); await active(page, b);
    await open(page, a); await page.locator('.highlight-annotation').first().waitFor();
    await enterAnnotationMode(page); await page.getByRole('button', { name: 'Seleccionar texto (V)', exact: true }).click();
    await page.keyboard.press('Control+Tab'); await active(page, b);
    await page.keyboard.press('Control+Shift+Tab'); await active(page, a);
    await page.keyboard.press('Control+w'); await tab(page, a).waitFor({ state: 'detached' }); await active(page, b);
    await page.getByRole('button', { name: `Cerrar ${b.name}`, exact: true }).click(); await tab(page, b).waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: 'Documentos', exact: true }).waitFor();
    return { inactiveCloseKeepsCurrentDocument: true, reopenRestoresAnnotation: true, keyboardSwitchAndClose: true, lastCloseReturnsToWelcome: true };
  });

  await check('bookmark-groups-page-children-color-folding-and-persistence', async page => {
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click();
    await page.getByRole('button', { name: 'Crear grupo de marcadores', exact: true }).click(); await rename(page, 'Medicine');
    await options(page, 'Medicine', 'Añadir página actual dentro'); await rename(page, 'First page');
    await options(page, 'Medicine', 'Añadir grupo dentro'); await rename(page, 'Kidney');
    await go(page, 2); await options(page, 'Kidney', 'Añadir página actual dentro'); await rename(page, 'Second page');
    await options(page, 'Kidney', 'Color Azul');
    await page.getByRole('button', { name: 'Contraer Kidney', exact: true }).click(); assert.equal(await row(page, 'Second page').count(), 0);
    await page.getByRole('button', { name: 'Expandir Kidney', exact: true }).click(); await row(page, 'Second page').waitFor();
    await page.waitForFunction(hash => JSON.parse(localStorage.getItem(`folio.session.${hash}`) || 'null')?.bookmarks.some(node => node.title === 'Kidney' && node.color === '#4579ba' && !node.collapsed), a.hash);
    await waitSession(page, a, 'Second page'); const saved = await session(page);
    const medicine = saved.bookmarks.find(node => node.title === 'Medicine'); assert(medicine && children(saved.bookmarks, medicine.id).length === 2);
    const kidney = children(saved.bookmarks, medicine.id).find(node => node.title === 'Kidney');
    const child = kidney && children(saved.bookmarks, kidney.id)[0]; assert(child && child.title === 'Second page' && child.page === 2); assert.equal(kidney.color, '#4579ba');
    await open(page, b); await page.getByRole('button', { name: 'Marcadores', exact: true }).click(); assert.equal(await page.locator('.bookmark-entry').count(), 0);
    await switchTo(page, a); await row(page, 'Second page').waitFor();
    await page.reload(); await open(page, a); await page.getByRole('button', { name: 'Marcadores', exact: true }).click(); await row(page, 'Second page').waitFor();
    const reloaded = await session(page); assert.deepEqual(reloaded.bookmarks, saved.bookmarks);
    await page.screenshot({ path: path.join(output, 'bookmarks-tree.png'), animations: 'disabled' });
    return { nestedGroups: true, pageDestinations: [1, 2], groupColor: kidney.color, foldUnfold: true, isolatedPerDocument: true, sessionReloadRestoresTree: true };
  });

  await check('bookmark-reorder-move-and-delete-preserve-children', async page => {
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click();
    await page.getByRole('button', { name: 'Crear grupo de marcadores', exact: true }).click(); await rename(page, 'First group');
    await options(page, 'First group', 'Añadir página actual dentro'); await rename(page, 'Keep this page');
    await page.getByRole('button', { name: 'Crear grupo de marcadores', exact: true }).click(); await rename(page, 'Second group');
    await options(page, 'Second group', 'Subir');
    await page.waitForFunction(hash => {
      const nodes = JSON.parse(localStorage.getItem(`folio.session.${hash}`) || 'null')?.bookmarks || [];
      return nodes.filter(node => node.parentId === null).sort((left, right) => left.order - right.order)[0]?.title === 'Second group';
    }, a.hash);
    assert.equal(children((await session(page)).bookmarks, null)[0].title, 'Second group');
    await options(page, 'Keep this page', 'Mover…');
    const destination = page.getByRole('combobox', { name: 'Dentro de', exact: true });
    const value = await destination.locator('option').filter({ hasText: 'Second group' }).first().getAttribute('value'); assert(value);
    await destination.selectOption(value); await page.getByRole('button', { name: 'Mover', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mover marcador', exact: true }).waitFor({ state: 'detached' });
    await waitSession(page, a, 'Keep this page');
    await page.waitForFunction(hash => {
      const nodes = JSON.parse(localStorage.getItem(`folio.session.${hash}`)).bookmarks;
      const group = nodes.find(node => node.title === 'Second group'); return group && nodes.some(node => node.title === 'Keep this page' && node.parentId === group.id);
    }, a.hash);
    await options(page, 'Second group', 'Eliminar y conservar hijos'); await row(page, 'Second group').waitFor({ state: 'detached' }); await row(page, 'Keep this page').waitFor();
    await page.waitForFunction(hash => JSON.parse(localStorage.getItem(`folio.session.${hash}`)).bookmarks.some(node => node.title === 'Keep this page' && node.parentId === null), a.hash);
    const final = await session(page), nodes = final.bookmarks, retained = nodes.find(node => node.title === 'Keep this page');
    assert(retained && retained.page === 1 && retained.parentId === null); assert(!nodes.some(node => node.title === 'Second group'));
    return { rootOrderChanged: true, movedIntoOtherGroup: true, deletedFolderRetainsPageChild: true, targetPagePreserved: 1 };
  });

  await check('legacy-page-bookmarks-survive-tree-migration', async page => {
    await page.addInitScript(hash => localStorage.setItem(`folio.session.${hash}`, JSON.stringify({ version: 2, annotations: [], bookmarks: [2, 3], lastPage: 2, documentRevision: hash })), a.hash);
    await page.reload(); await open(page, a);
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click();
    await row(page, 'Página 2').waitFor(); await row(page, 'Página 3').waitFor();
    await page.waitForFunction(hash => {
      const saved = JSON.parse(localStorage.getItem(`folio.session.${hash}`) || 'null');
      return saved?.version === 3 && saved.bookmarks.length === 2 && saved.bookmarks.every(node => typeof node === 'object');
    }, a.hash);
    const saved = await session(page); assert.deepEqual(saved.bookmarks.map(node => node.page).sort(), [2, 3]);
    assert(saved.bookmarks.every(node => node.parentId === null && node.title === `Página ${node.page}`));
    return { legacyVersion: 2, migratedVersion: 3, preservedDestinationPages: [2, 3] };
  });

  await check('switching-tabs-commits-bookmark-name-without-enter', async page => {
    await open(page, b); await switchTo(page, a);
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click();
    await page.getByRole('button', { name: 'Crear grupo de marcadores', exact: true }).click(); await rename(page, 'Original name');
    await options(page, 'Original name', 'Renombrar');
    await page.getByRole('textbox', { name: 'Nombre del marcador', exact: true }).fill('Edited before tab switch');
    await page.keyboard.press('Control+Tab'); await active(page, b);
    await page.keyboard.press('Control+Shift+Tab'); await active(page, a);
    await row(page, 'Edited before tab switch').waitFor(); assert.equal(await row(page, 'Original name').count(), 0);
    await waitSession(page, a, 'Edited before tab switch');
    assert.equal((await session(page)).bookmarks.find(node => node.page === null)?.title, 'Edited before tab switch');
    return { unfinishedInlineRenameCommitted: true, switchedWithoutEnter: true, namePersistedInCorrectDocument: true };
  });

  await check('tab-strip-arrow-keys-follow-active-tab-focus', async page => {
    await open(page, b); await tab(page, b).focus();
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('ArrowLeft'); await active(page, a);
      await page.waitForFunction(name => document.activeElement?.getAttribute('role') === 'tab' && document.activeElement.getAttribute('aria-label') === name, a.name);
      assert.equal(await tab(page, a).evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('ArrowRight'); await active(page, b);
      await page.waitForFunction(name => document.activeElement?.getAttribute('role') === 'tab' && document.activeElement.getAttribute('aria-label') === name, b.name);
      assert.equal(await tab(page, b).evaluate(node => node === document.activeElement), true);
    }
    return { repeatedArrowNavigation: true, activeTabReceivesFocus: true };
  });

  await check('repeated-save-keeps-current-pdf-proxy-renderable', async page => {
    for (let i = 1; i <= 3; i++) {
      const bytes = await download(page, `tabs-repeated-save-${i}.pdf`);
      const text = operateDocument(bytes, { operation: 'text' }); assert.equal(text.length, 3); assert(text[0].includes('TAB A PAGE 1'));
      assert.equal(await page.getByRole('tab').count(), 1, 'Saving a copy must keep one tab for this open document.');
    }
    await zoom(page).selectOption('150');
    await desktopDocumentAction(page, 'Rotar vista 90 grados');
    await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
    await page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: 'TAB A PAGE 1' }).first().waitFor();
    assert.equal(await page.getByText('No se pudo renderizar la página.', { exact: true }).count(), 0);
    assert(await page.locator('.pdf-page-wrap[data-page-number="1"] canvas').first().evaluate(canvas => canvas.width > 0 && canvas.height > 0));
    const bytes = await download(page, 'tabs-repeated-save-after-view-change.pdf');
    assert(operateDocument(bytes, { operation: 'text' })[0].includes('TAB A PAGE 1'));
    return { successiveSaves: 3, renderingAfterFourthSave: true, zoomPercent: 150, viewRotation: 90, currentProxyRemainsUsable: true };
  });
} finally { await browser?.close(); preview.kill(); fs.writeFileSync(path.join(output, 'tabs-results.json'), JSON.stringify({ results, errors }, null, 2)); }
if (errors.length) { console.log(JSON.stringify({ uncaughtErrors: errors })); process.exitCode = 1; }
