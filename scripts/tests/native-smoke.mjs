import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { operateDocument } from '../../src/engine/operations.mjs';
import { verifySignatures } from '../../src/engine/signatures.mjs';

// Use a separate QA identifier/data directory, never the user's live Folio session.
const executable = process.env.FOLIO_NATIVE_EXE;
const pdf = process.env.FOLIO_LAYOUT_PDF;
assert(executable && pdf, 'FOLIO_NATIVE_EXE y FOLIO_LAYOUT_PDF son necesarios.');
const endpoint = process.env.FOLIO_NATIVE_CDP || 'http://127.0.0.1:9367';
const output = path.resolve('test-results');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const original = hash(await readFile(pdf));
const child = spawn(executable, [pdf, path.resolve('public/sample.pdf')], { windowsHide: true, stdio: 'ignore' });
let browser;
const errors = [];
try {
  let ready = false;
  for (let n = 0; n < 200; n++) {
    try { if ((await fetch(endpoint + '/json/version')).ok) { ready = true; break; } } catch {}
    assert(child.exitCode === null, 'El contenedor nativo cerró antes de arrancar.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'WebView2 no expuso el puerto de la compilación QA.');
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().startsWith('http://tauri.localhost')) || context.pages()[0] || await context.waitForEvent('page');
  await page.waitForURL(url => url.hostname === 'tauri.localhost');
  page.on('pageerror', error => errors.push(error.message));
  const invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), {command, args});
  assert.equal(await invoke('plugin:app|identifier'), 'org.folio.pdf.qa', 'Solo se permite automatizar la instancia QA.');
  assert.equal(await invoke('plugin:app|version'), version);
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  // Each run starts from clean QA sessions. Existing sticky-note icons from a
  // previous run may occupy the exact character where the mouse drag starts.
  await invoke('forget_document', { id: original });
  await invoke('forget_document', { id: hash(await readFile('public/sample.pdf')) });
  await page.reload();
  await page.getByRole('tab', { name: 'sample.pdf', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 2, 'Los archivos iniciales deben abrirse en pestañas independientes.');
  await page.getByRole('tab', { name: path.basename(pdf), exact: true }).click();
  await page.getByRole('heading', { name: path.basename(pdf), exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.locator('.textLayer').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Guardar', exact: true }).count(), 1);
  const geometry = () => page.evaluate(() => ({
    height: innerHeight, width: innerWidth, scrollY, scrollX,
    documentHeight: document.documentElement.scrollHeight,
    documentWidth: document.documentElement.scrollWidth,
    headerY: document.querySelector('.app-header').getBoundingClientRect().top,
    toolbarY: document.querySelector('.reader-toolbar').getBoundingClientRect().top,
  }));
  const frame = await geometry();
  assert.equal(frame.height, frame.documentHeight); assert.equal(frame.width, frame.documentWidth);
  await page.getByRole('combobox', { name: 'Nivel de zoom' }).selectOption('100');
  const area = await page.locator('.reading-area').boundingBox();
  await page.mouse.move(area.x + area.width * .6, area.y + 150);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('select[aria-label="Nivel de zoom"]').value === '111');
  assert.deepEqual(await geometry(), frame, 'Ctrl + rueda alteró la interfaz nativa.');
  await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => document.querySelector('.reading-area').scrollTop > 0);
  assert.deepEqual(await geometry(), frame);
  await page.getByRole('button', { name: 'Páginas', exact: true }).click();
  await page.locator('.sidebar').waitFor();
  await page.getByRole('button', { name: 'Páginas', exact: true }).click();
  await page.locator('.sidebar').waitFor({state:'detached'});
  await page.getByRole('button', { name: 'Anotaciones', exact: true }).click();
  await page.locator('.notes-panel').waitFor();
  await page.getByRole('button', { name: 'Anotaciones', exact: true }).click();
  await page.locator('.notes-panel').waitFor({state:'detached'});
  const initialMaximized = await invoke('plugin:window|is_maximized', {label:'main'});
  await page.getByRole('button', { name: 'Maximizar o restaurar ventana', exact: true }).click();
  await page.waitForFunction(async previous => (await window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized', {label:'main'})) !== previous, initialMaximized);
  await page.getByRole('button', { name: 'Maximizar o restaurar ventana', exact: true }).click();
  await page.waitForFunction(async previous => (await window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized', {label:'main'})) === previous, initialMaximized);
  await page.getByRole('combobox', { name: 'Nivel de zoom' }).selectOption('125');
  await page.locator('.reading-area').evaluate(element => {element.scrollTop = 0});
  await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({state:'detached'});
  await page.getByRole('button', { name: 'Preferencias de lectura', exact: true }).click();
  await page.getByRole('button', { name: 'Oscuro', exact: true }).click();
  await page.getByRole('button', { name: 'Listo', exact: true }).click();
  await page.screenshot({path:path.join(output, 'folio-windows.png'), animations:'disabled'});
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(hash(await readFile(pdf)), original, 'El archivo original cambió.');
  const nativeModules = {};
  nativeModules.multipleStartupTabs = true;
  await page.getByRole('textbox', { name: 'Número de página', exact: true }).fill('1');
  await page.getByRole('textbox', { name: 'Número de página', exact: true }).press('Enter');
  await page.getByRole('combobox', { name: 'Nivel de zoom', exact: true }).selectOption('100');
  await page.getByRole('button', { name: /^(Guardar|Editar) marcador de esta página$/ }).click();
  const bookmarkName = page.getByRole('textbox', { name: 'Nombre del marcador', exact: true });
  await bookmarkName.waitFor(); assert(await bookmarkName.evaluate(node => node === document.activeElement));
  await bookmarkName.fill('QA nombre de página'); await bookmarkName.press('Enter');
  await page.waitForFunction(async id => (await window.__TAURI_INTERNALS__.invoke('load_session', { id }))?.bookmarks.some(node => node.title === 'QA nombre de página' && node.page === 1), original);
  nativeModules.bookmarkNameFocusedAndStored = true;
  await page.getByRole('button', { name: 'Marcadores', exact: true }).click();
  await page.locator('.sidebar').waitFor({ state: 'detached' });
  const selectedSpan = page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: 'Dos guías' }).first();
  await selectedSpan.waitFor(); await selectedSpan.scrollIntoViewIfNeeded();
  const annotationsBeforeSelection = (await invoke('load_session', { id: original }))?.annotations?.length || 0;
  await page.getByRole('button', { name: 'Color del resaltador', exact: true }).click();
  assert.equal(await page.locator('.highlight-color-presets button').count(), 12);
  await page.getByRole('button', { name: 'Color Azul', exact: true }).click();
  await page.getByRole('button', { name: 'Resaltado automático (H)', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Resaltado automático (H)', exact: true }).getAttribute('aria-pressed'), 'true');
  const spanBounds = await selectedSpan.boundingBox();
  await page.mouse.move(spanBounds.x + 1, spanBounds.y + spanBounds.height / 2); await page.mouse.down();
  await page.mouse.move(spanBounds.x + spanBounds.width - 1, spanBounds.y + spanBounds.height / 2, { steps: 8 });
  assert.equal(await page.locator('.tool-highlight .highlight-annotation.preview').count(), 0);
  await page.mouse.up();
  await page.waitForFunction(async ({ id, count }) => {
    const session = await window.__TAURI_INTERNALS__.invoke('load_session', { id });
    return session?.annotations.length > count && session.annotations.some(node => node.text.startsWith('Dos guías') && node.quads?.length && node.color === '#8bbaf0');
  }, { id: original, count: annotationsBeforeSelection });
  await page.mouse.move(spanBounds.x + 1, spanBounds.y + spanBounds.height / 2); await page.mouse.down();
  await page.mouse.move(spanBounds.x + spanBounds.width - 1, spanBounds.y + spanBounds.height / 2, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(async ({ id, count }) => (await window.__TAURI_INTERNALS__.invoke('load_session', { id }))?.annotations.length === count + 2, { id: original, count: annotationsBeforeSelection });
  await page.getByRole('button', { name: 'Resaltado automático (H)', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Resaltado automático (H)', exact: true }).getAttribute('aria-pressed'), 'false');
  nativeModules.automaticHighlightToggleAndTwelveColors = true;
  nativeModules.textSelectionHighlightAndRustSession = true;
  await page.getByRole('tab', { name: 'sample.pdf', exact: true }).click();
  await page.getByRole('heading', { name: 'sample.pdf', exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('combobox', { name: 'Nivel de zoom', exact: true }).inputValue(), 'page');
  await page.getByRole('tab', { name: path.basename(pdf), exact: true }).click();
  await page.getByRole('heading', { name: path.basename(pdf), exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('combobox', { name: 'Nivel de zoom', exact: true }).inputValue(), '100');
  assert((await invoke('load_session', { id: original })).bookmarks.some(node => node.title === 'QA nombre de página'));
  nativeModules.tabSwitchPreservesViewAndBookmarks = true;
  await page.getByRole('button', { name: 'Seleccionar texto (V)', exact: true }).click();
  async function selectForMenu() {
    await selectedSpan.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const sheet = await page.locator('.pdf-page-wrap[data-page-number="1"] .page-content').boundingBox();
    await page.mouse.click(sheet.x + 12, Math.max(96, sheet.y + 12));
    const rect = await selectedSpan.boundingBox();
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await page.mouse.up();
    try { await page.getByRole('toolbar', { name: 'Herramientas del texto seleccionado', exact: true }).waitFor(); }
    catch (error) {
      await page.screenshot({ path: path.join(output, 'native-selection-menu-failure.png') });
      const state = await page.evaluate(({ x, y }) => ({
        selection: window.getSelection()?.toString(), tools: [...document.querySelectorAll('.page-content')].map(node => node.className),
        hit: document.elementsFromPoint(x, y).slice(0, 5).map(node => ({ tag: node.tagName, class: node.className })),
        dialogs: [...document.querySelectorAll('[role=dialog]')].map(node => node.getAttribute('aria-label')),
        scroll: document.querySelector('.reading-area').scrollTop,
      }), { x: rect.x + 1, y: rect.y + rect.height / 2 });
      await writeFile(path.join(output, 'native-selection-menu-failure.json'), JSON.stringify(state, null, 2));
      throw error;
    }
  }
  const beforePopupHighlight = (await invoke('load_session', { id: original })).annotations.length;
  await selectForMenu();
  await page.getByRole('toolbar', { name: 'Herramientas del texto seleccionado', exact: true }).getByRole('button', { name: 'Resaltar', exact: true }).click();
  await page.waitForFunction(async ({ id, count }) => (await window.__TAURI_INTERNALS__.invoke('load_session', { id }))?.annotations.length > count, { id: original, count: beforePopupHighlight });
  await selectForMenu();
  await page.getByRole('toolbar', { name: 'Herramientas del texto seleccionado', exact: true }).getByRole('button', { name: 'Comentar', exact: true }).click();
  await page.getByRole('textbox', { name: 'Texto de la nota', exact: true }).fill('QA comentario del texto seleccionado');
  await page.getByRole('button', { name: 'Guardar nota', exact: true }).click();
  await page.waitForFunction(async id => (await window.__TAURI_INTERNALS__.invoke('load_session', { id }))?.annotations.some(note => note.kind === 'note' && note.page === 1 && note.text === 'QA comentario del texto seleccionado'), original);
  nativeModules.floatingSelectionHighlightsAndComments = true;
  await page.getByRole('button', { name: 'Cerrar anotaciones', exact: true }).click();
  async function openFixture(filename) {
    const file = path.join(output, filename), id = hash(await readFile(file));
    await invoke('forget_document', { id });
    await page.locator('.app-header input[type=file]').setInputFiles(file);
    await page.getByRole('heading', { name: filename, exact: true }).waitFor();
    await page.locator('.loading-overlay').waitFor({state:'detached'});
    await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({state:'detached'});
    return id;
  }
  async function tool(name) { await page.getByRole('button',{name:'Herramientas',exact:true}).click(); await page.getByRole('button',{name,exact:true}).click(); }
  async function draft(id, predicate) {
    let bytes;
    for (let n=0;n<100;n++) {
      bytes = new Uint8Array(await page.evaluate(async id => Array.from(new Uint8Array(await window.__TAURI_INTERNALS__.invoke('load_draft',{id}))), id));
      if (bytes.length && await predicate(bytes)) return bytes;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error('El borrador nativo no contiene el resultado esperado.');
  }
  const editId = await openFixture('workbench-source.pdf');
  await tool('Reemplazar texto'); await page.getByRole('combobox',{name:'Nivel de zoom'}).selectOption('100');
  const bounds=await page.locator('.pdf-page').first().boundingBox();
  await page.mouse.move(bounds.x+35,bounds.y+128); await page.mouse.down(); await page.mouse.move(bounds.x+210,bounds.y+156,{steps:8}); await page.mouse.up();
  await page.getByRole('textbox',{name:'Texto del PDF'}).fill('NATIVE EDIT'); await page.getByRole('button',{name:'Aplicar texto',exact:true}).click();
  await page.locator('.workbench').waitFor({state:'detached'});
  await draft(editId, bytes=>operateDocument(bytes,{operation:'text'})[0].includes('NATIVE EDIT'));
  nativeModules.realEditingAndBinaryDraft = true;
  await tool('Firmas digitales'); await page.locator('.signing-form input[type=file]').setInputFiles(path.join(output,'qa-identity.p12'));
  await page.getByLabel('Contraseña del certificado',{exact:true}).fill('qa-only'); await page.getByRole('button',{name:'Firmar documento',exact:true}).click();
  await page.locator('.workbench').waitFor({state:'detached',timeout:60000});
  const signed=await draft(editId, async bytes => (await verifySignatures(bytes))[0]?.integrity);
  await writeFile(path.join(output,'native-signed.pdf'),signed); nativeModules.realCmsSigning = true;
  await tool('Firmas digitales'); await page.getByRole('button',{name:'Verificar firmas',exact:true}).click();
  await page.locator('.signature-results article').waitFor(); assert((await page.locator('.signature-results article').innerText()).includes('Válida'));
  await page.getByRole('button',{name:'Cerrar diálogo',exact:true}).click(); nativeModules.signatureVerification = true;
  const scanId=await openFixture('scan.pdf'); await tool('Reconocer texto (OCR)'); await page.getByLabel('Idioma',{exact:true}).selectOption('eng');
  await page.getByRole('button',{name:'Reconocer texto',exact:true}).click(); await page.locator('.workbench').waitFor({state:'detached',timeout:90000});
  const recognized=await draft(scanId,bytes=>operateDocument(bytes,{operation:'text'})[0].includes('FOLIO OCR TEST'));
  await writeFile(path.join(output,'native-ocr.pdf'),recognized); nativeModules.localOCR = true;
  const recent=await invoke('recent_documents'); assert(recent.some(r=>r.id===scanId && r.draft)); nativeModules.unsavedDraftInLibrary = true;
  await page.reload(); await page.locator('.loading-overlay').waitFor({state:'detached'});
  await page.getByRole('button',{name:'Mis documentos',exact:true}).click(); await page.locator('.recent-row').filter({hasText:'scan.pdf'}).locator('button').first().click();
  await page.getByRole('heading',{name:'scan.pdf',exact:true}).waitFor(); await page.locator('.loading-overlay').waitFor({state:'detached'});
  await page.waitForFunction(() => document.querySelector('.textLayer')?.textContent?.includes('FOLIO OCR TEST'));
  nativeModules.draftReopenedAfterReload = true;
  assert.equal(errors.length,0,errors.join('\n'));
  await page.getByRole('button', { name: 'Minimizar ventana', exact: true }).click();
  await page.waitForFunction(async () => window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized', {label:'main'}));
  await page.getByRole('button', { name: 'Cerrar ventana', exact: true }).click();
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error('La instancia QA no cerró.')), 10000);
    child.once('exit', () => {clearTimeout(timer); resolve()});
  });
  const result = {platform:process.platform, identifier:'org.folio.pdf.qa', version,
    nativePdfOpen:true, ctrlWheelZoom:true, wheelScrollOnlyContent:true, foldingPanels:true,
    maximizeRestore:true, minimize:true, gracefulClose:true, originalUnchanged:true,
    nativeModules, uncaughtErrors:errors, pdfSha256:original};
  await writeFile(path.join(output, 'native-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
}
