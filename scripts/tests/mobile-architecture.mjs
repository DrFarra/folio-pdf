import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

// Real PDF and DOM acceptance checks for the library/reader transitions. Native
// large-file IPC is explicitly mocked only in the capability-explanation case.
const root = process.cwd(), output = path.join(root, 'test-results', 'mobile-architecture');
fs.mkdirSync(output, { recursive: true });
const fixture = path.join(output, 'Architecture.pdf');
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
for (let index = 1; index <= 5; index++) {
  const page = pdf.addPage([420, 560]);
  page.drawText(`CHAPTER PAGE ${index}`, { x: 32, y: 510, size: 20, font });
  page.drawText(`Needle first on page ${index}. Needle second here.`, { x: 32, y: 450, size: 12, font });
  page.drawText('Select these words to comment.', { x: 32, y: 390, size: 14, font });
}
const reviewField = pdf.getForm().createTextField('Review');
reviewField.addToPage(pdf.getPage(0), { x: 32, y: 300, width: 260, height: 24 });
reviewField.setText('Original'); pdf.getForm().updateFieldAppearances(font);
const context = pdf.context, outline = context.obj({ Type: 'Outlines' }), outlineRef = context.register(outline);
const specs = [
  ['Chapter A', null, null], ['A introduction', 1, 0], ['A details', 2, 0],
  ['Chapter B', 3, null], ['B introduction', 3, 3], ['B deeper', 4, 4], ['B summary', 5, 3],
];
const items = specs.map(([title, number]) => context.obj({ Title: PDFString.of(title), ...(number == null ? {} : { Dest: [pdf.getPage(number - 1).ref, PDFName.of('Fit')] }) }));
const references = items.map(item => context.register(item));
for (const [index, [, , parent]] of specs.entries()) {
  const siblings = specs.map((spec, sibling) => spec[2] === parent ? sibling : -1).filter(sibling => sibling >= 0);
  const position = siblings.indexOf(index), children = specs.map((spec, child) => spec[2] === index ? child : -1).filter(child => child >= 0);
  items[index].set(PDFName.of('Parent'), parent === null ? outlineRef : references[parent]);
  if (position > 0) items[index].set(PDFName.of('Prev'), references[siblings[position - 1]]);
  if (position < siblings.length - 1) items[index].set(PDFName.of('Next'), references[siblings[position + 1]]);
  if (children.length) {
    items[index].set(PDFName.of('First'), references[children[0]]);
    items[index].set(PDFName.of('Last'), references[children.at(-1)]);
    items[index].set(PDFName.of('Count'), context.obj(children.length));
  }
}
outline.set(PDFName.of('First'), references[0]); outline.set(PDFName.of('Last'), references[3]); outline.set(PDFName.of('Count'), context.obj(specs.length));
pdf.catalog.set(PDFName.of('Outlines'), outlineRef);
fs.writeFileSync(fixture, await pdf.save());

const port = process.env.FOLIO_MOBILE_ARCHITECTURE_PORT || '4211', origin = `http://127.0.0.1:${port}`;
const snapshotRoot = path.resolve(root, '.tools'), snapshot = process.env.FOLIO_MOBILE_ARCHITECTURE_DEV ? null : path.join(snapshotRoot, `mobile-architecture-preview-${process.pid}`);
if (snapshot) { fs.mkdirSync(snapshot, { recursive: true }); fs.cpSync(path.join(root, 'dist'), snapshot, { recursive: true }); }
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...(snapshot ? ['preview', '--outDir', snapshot] : []), '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let log = '', browser;
server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
const results = [], errors = [];
const iphoneAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const visibleButton = (page, name) => page.getByRole('button', { name, exact: true }).filter({ visible: true });
async function open(page) {
  await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(fixture);
  await page.locator('.reading-area .textLayer span').first().waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
}
async function closeSheet(page) { await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).tap(); }
async function check(id, action, { native = false, desktop = false, viewport = { width: 1360, height: 950 } } = {}) {
  if (process.env.FOLIO_MOBILE_ARCHITECTURE_TEST && !new RegExp(process.env.FOLIO_MOBILE_ARCHITECTURE_TEST).test(id)) return;
  const session = await browser.newContext(desktop ? { viewport } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: iphoneAgent, deviceScaleFactor: 2 });
  if (!desktop) await session.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' }));
  if (native) await session.addInitScript(nativeBridge);
  const page = await session.newPage(); page.setDefaultTimeout(20000);
  const caseErrors = []; page.on('pageerror', error => { caseErrors.push(error.message); errors.push({ id, error: error.message }); });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 45000 }); const evidence = await action(page);
    assert.deepEqual(caseErrors, [], 'The flow must not generate browser errors.');
    results.push({ id, status: 'passed', ...evidence });
  } catch (error) {
    results.push({ id, status: 'failed', error: error.stack }); process.exitCode = 1;
    await page.screenshot({ path: path.join(output, `${id}-failure.png`), animations: 'disabled' }).catch(() => {});
  } finally { console.log(JSON.stringify(results.at(-1))); await session.close(); }
}
function nativeBridge() {
  globalThis.isTauri = true;
  const source = { token: 'architecture-native', name: 'Large native.pdf', size: 64 * 1024 ** 2, id: 'n'.repeat(64), revision: 'n'.repeat(64) };
  const callbacks = new Map(), listeners = new Map(); let callbackId = 0;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_, id) => listeners.delete(id) };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: callback => { const id = ++callbackId; callbacks.set(id, callback); return id; },
    unregisterCallback: id => callbacks.delete(id),
    invoke: async (command, args = {}) => {
      if (command === 'plugin:event|listen') { const id = ++callbackId; listeners.set(id, args); return id; }
      if (command === 'plugin:event|unlisten') return null;
      if (command === 'startup_documents') return [source];
      if (['recent_documents', 'list_library'].includes(command)) return [];
      if (['load_session', 'native_draft_document'].includes(command)) return null;
      if (command === 'native_pdf_open') return { id: source.id, revision: source.revision, size: source.size, numPages: 3, locked: false, signed: false, permissions: { canCopy: true, canPrint: true, canAnnotate: true, canEdit: false, canAssemble: false, canFill: false }, firstPage: { page: 1, view: [0, 0, 420, 560], rotation: 0 } };
      if (command === 'native_pdf_page_info') return { view: [0, 0, 420, 560], rotation: 0, annotations: [] };
      if (command === 'native_pdf_text') return { lines: [{ text: `Large native page ${args.page}`, bounds: [30, 480, 350, 500], direction: 'ltr', hasEOL: true }] };
      if (command === 'native_pdf_outline') return [];
      if (command === 'native_pdf_render') {
        const canvas = document.createElement('canvas'); canvas.width = args.width; canvas.height = args.height;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        const raw = atob(canvas.toDataURL('image/png').split(',')[1]); return new Uint8Array([...raw].map(character => character.charCodeAt(0))).buffer;
      }
      if (command === 'read_document') throw new Error('Large files must stay file-backed.');
      return null;
    },
  };
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(log || 'The app server exited.');
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, log || 'The app server did not become ready.');
  const executablePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(fs.existsSync);
  browser = process.env.FOLIO_TEST_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ executablePath, headless: true });

  await check('library-is-root-and-back-preserves-document', async page => {
    await page.getByRole('heading', { name: 'Documentos', exact: true }).waitFor();
    await visibleButton(page, 'Importar PDF').waitFor(); await open(page);
    const position = await page.locator('.reading-area').evaluate(async reader => {
      const chapter = reader.querySelector('[data-page-number="3"]');
      reader.scrollTop += chapter.getBoundingClientRect().top - reader.getBoundingClientRect().top + 90;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return reader.scrollTop;
    });
    await visibleButton(page, 'Volver a biblioteca').tap();
    await page.getByRole('heading', { name: 'Documentos', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Abrir Architecture.pdf', exact: true }).tap();
    await page.locator('.reading-area .textLayer span').first().waitFor();
    await page.waitForFunction(position => Math.abs(document.querySelector('.reading-area').scrollTop - position) < 3, position);
    for (const name of ['Páginas', 'Buscar', 'Anotar', 'Compartir']) await visibleButton(page, name).waitFor();
    await visibleButton(page, 'Documentos abiertos').tap();
    assert.equal(await page.locator('.mobile-document-list>div').count(), 1, 'Reopening from the library must reuse the open document.');
    await page.getByRole('button', { name: 'Cerrar Architecture.pdf', exact: true }).tap();
    await page.getByRole('heading', { name: 'Documentos', exact: true }).waitFor();
    return { rootLibrary: true, directReadingActions: true, documentResumed: true, resumedScrollWithinPixels: 3, duplicateTabs: false, closingLastDocumentReturnsToLibrary: true };
  });
  await check('search-reveals-hit-and-keeps-navigation', async page => {
    await open(page); await visibleButton(page, 'Buscar').tap();
    await page.getByLabel('Buscar texto en el PDF', { exact: true }).fill('Needle');
    await page.locator('.search-result').first().waitFor();
    assert.equal(await page.locator('.search-result').count(), 10, 'Repeated words on one page must be separately navigable occurrences.');
    await page.locator('.search-result').nth(1).tap();
    await page.locator('.sidebar.mobile-drawer').waitFor({ state: 'detached' });
    assert.equal(await page.locator('main.reader').getAttribute('inert'), null);
    const activeHit = page.locator('.reading-area mark[data-search-active="true"]').first();
    await activeHit.waitFor();
    assert.equal(await activeHit.evaluate(mark => mark.closest('[data-page-number]').dataset.pageNumber), '1', 'The second occurrence remains on page one.');
    await visibleButton(page, 'Resultado siguiente').tap();
    await page.waitForFunction(() => document.querySelector('mark[data-search-active="true"]')?.closest('[data-page-number]')?.dataset.pageNumber === '2');
    assert.equal(await page.locator('.sidebar.mobile-drawer').count(), 0, 'Next hit must not reopen the results sheet.');
    return { hitRevealed: true, readerInteractive: true, nextHitWithoutSheet: true };
  });
  await check('quick-bookmark-does-not-open-keyboard-or-panel', async page => {
    await open(page); await visibleButton(page, 'Guardar marcador de esta página').tap();
    assert.equal(await page.locator('.mobile-drawer').count(), 0);
    assert.equal(await page.locator('.bookmark-name-input').count(), 0);
    await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('folio.session.') && JSON.parse(localStorage.getItem(key)).bookmarks.length === 1));
    return { bookmarkPersisted: true, readingUninterrupted: true };
  });
  await check('saving-note-returns-to-document', async page => {
    await open(page); await visibleButton(page, 'Anotar').tap(); await visibleButton(page, 'Añadir nota').tap();
    const bounds = await page.locator('.page-content').first().boundingBox(); assert(bounds);
    await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + 150);
    await page.getByRole('dialog', { name: 'Añadir nota', exact: true }).waitFor();
    await page.getByLabel('Texto de la nota', { exact: true }).fill('Architecture acceptance note');
    await visibleButton(page, 'Guardar nota').tap();
    await page.locator('.note-marker').waitFor(); assert.equal(await page.locator('.notes-panel.mobile-drawer').count(), 0);
    assert.equal(await page.locator('main.reader').getAttribute('inert'), null);
    return { standardNoteCreated: true, returnedToReading: true };
  });
  await check('single-page-controls-work-without-more-menu', async page => {
    await page.evaluate(() => localStorage.setItem('folio.readingPreferences', JSON.stringify({ mode: 'single' }))); await page.reload();
    await open(page); await visibleButton(page, 'Página siguiente').tap();
    await page.locator('.pdf-page-wrap[data-page-number="2"]').waitFor();
    assert.equal(await page.locator('.pdf-page-wrap').count(), 1); assert.equal(await page.locator('dialog[open]').count(), 0);
    await visibleButton(page, 'Página anterior').tap(); await page.locator('.pdf-page-wrap[data-page-number="1"]').waitFor();
    return { singlePageDirectNextAndPrevious: true };
  });
  await check('outline-folds-preserve-context-and-titles-navigate', async page => {
    await open(page); await visibleButton(page, 'Páginas').tap(); await page.getByRole('tab', { name: 'Índice', exact: true }).tap();
    await page.getByRole('navigation', { name: 'Índice del documento', exact: true }).waitFor();
    await visibleButton(page, 'Plegar Chapter A').tap(); await visibleButton(page, 'Desplegar Chapter B').tap();
    await page.getByRole('button', { name: 'Cerrar panel', exact: true }).tap();
    await visibleButton(page, 'Páginas').tap(); await page.getByRole('tab', { name: 'Índice', exact: true }).tap();
    assert.equal(await visibleButton(page, 'Desplegar Chapter A').getAttribute('aria-expanded'), 'false');
    assert.equal(await visibleButton(page, 'Plegar Chapter B').getAttribute('aria-expanded'), 'true');
    await page.locator('.document-outline-destination').filter({ hasText: 'Chapter B' }).tap();
    await page.locator('.mobile-drawer').waitFor({ state: 'detached' });
    await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('folio.session.') && JSON.parse(localStorage.getItem(key)).lastPage === 3));
    return { independentTitleNavigation: true, collapsedChaptersRemembered: true };
  });
  await check('mobile-sheet-can-dismiss-and-restores-focus', async page => {
    await open(page); const trigger = visibleButton(page, 'Más acciones'); await trigger.tap();
    const dialog = page.getByRole('dialog', { name: 'Acciones del documento', exact: true }); await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Cerrar hoja', exact: true }).waitFor();
    const box = await dialog.boundingBox(); assert(box && box.y + box.height <= 845, 'The sheet must fit the visible viewport.');
    await dialog.locator('.sheet-handle').evaluate(handle => {
      const rect = handle.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      // Pointer capture requires hardware pointers. This contract drives the
      // real drag handlers while physical UIKit gestures remain device QA.
      handle.setPointerCapture = () => {};
      for (const [type, dy] of [['pointerdown', 0], ['pointermove', 100], ['pointerup', 100]]) handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y + dy }));
    });
    await dialog.waitFor({ state: 'detached' }); assert.equal(await trigger.evaluate(button => document.activeElement === button), true);
    return { bottomSheetWithinViewport: true, dragDismissContract: true, focusRestored: true };
  });
  await check('library-removal-preserves-active-annotations', async page => {
    await open(page); await visibleButton(page, 'Guardar marcador de esta página').tap();
    await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('folio.session.') && JSON.parse(localStorage.getItem(key)).bookmarks.length === 1));
    await visibleButton(page, 'Volver a biblioteca').tap();
    await page.getByRole('button', { name: /Opciones.*Architecture\.pdf/ }).tap();
    await page.getByRole('menuitem', { name: 'Quitar de recientes', exact: true }).tap();
    assert.equal(await page.getByRole('dialog').count(), 0);
    const retained = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('folio.session.')).some(key => JSON.parse(localStorage.getItem(key)).bookmarks.length === 1));
    assert.equal(retained, true, 'Removing recency must preserve the document session.');
    return { removeRecentKeepsSession: true };
  });
  await check('library-delete-confirms-and-does-not-resurrect', async page => {
    await open(page); await visibleButton(page, 'Guardar marcador de esta página').tap();
    await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('folio.session.') && JSON.parse(localStorage.getItem(key)).bookmarks.length === 1));
    const sessionKey = await page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('folio.session.')));
    assert(sessionKey); const documentId = sessionKey.slice('folio.session.'.length);
    const storedCopy = () => page.evaluate(async id => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('folio-library'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction(['documents', 'drafts'], 'readonly');
      const read = store => new Promise((resolve, reject) => { const request = tx.objectStore(store).get(id); request.onsuccess = () => resolve(request.result !== undefined); request.onerror = () => reject(request.error); });
      const [document, draft] = await Promise.all([read('documents'), read('drafts')]); db.close(); return { document, draft };
    }, documentId);
    await visibleButton(page, 'Volver a biblioteca').tap();
    const requestDeletion = async () => {
      await page.getByRole('button', { name: /Opciones.*Architecture\.pdf/ }).tap();
      await page.getByRole('menuitem', { name: 'Eliminar copia local…', exact: true }).tap();
      await page.getByRole('dialog', { name: 'Eliminar copia local', exact: true }).waitFor();
    };
    await requestDeletion();
    await visibleButton(page, 'Cancelar').tap(); await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key))?.bookmarks.length, sessionKey), 1, 'Cancel must preserve annotations and bookmarks.');
    assert.equal((await storedCopy()).document, true, 'Cancel must preserve the stored PDF.');
    await requestDeletion(); await visibleButton(page, 'Eliminar copia local y cambios').tap();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Abrir Architecture.pdf', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.pdf-page-wrap').count(), 0, 'The deleted document must close its reader tab.');
    assert.equal(await page.getByRole('button', { name: 'Documentos abiertos', exact: true }).count(), 0);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), sessionKey), null);
    assert.deepEqual(await storedCopy(), { document: false, draft: false });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    // Let the reader's delayed persistence callbacks settle before reloading.
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), sessionKey), null, 'pagehide must not recreate a deleted session.');
    assert.deepEqual(await storedCopy(), { document: false, draft: false });
    await page.reload(); await page.getByRole('heading', { name: 'Documentos', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Abrir Architecture.pdf', exact: true }).count(), 0);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), sessionKey), null);
    assert.deepEqual(await storedCopy(), { document: false, draft: false });
    return { cancelPreservesCopyAndSession: true, confirmedDeletionRemovesCopyDraftSessionAndTab: true, noResurrectionOnPagehideOrReload: true };
  });
  await check('large-file-tools-explain-unavailable-capabilities', async page => {
    await page.locator('.reading-area .textLayer span').first().waitFor();
    await visibleButton(page, 'Más acciones').tap();
    await visibleButton(page, 'Herramientas').tap();
    await page.getByText(/(archivo|documento).*(grande|32|PDFKit)|PDFKit.*(archivo|documento)/i).first().waitFor();
    return { nativeFileBackedAdapter: true, capabilityReasonVisible: true, nativeIPCMocked: true };
  }, { native: true });
  await check('desktop-dialog-keeps-native-modal-behavior', async page => {
    await open(page); await page.getByRole('button', { name: 'Preferencias de lectura', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Preferencias de lectura', exact: true }); await dialog.waitFor();
    assert.equal(await dialog.locator('.sheet-handle').isVisible(), false);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    return { mobileHandleHiddenOnDesktop: true, escapeDismisses: true };
  }, { desktop: true });
  await check('desktop-library-is-root-and-resumes-position', async page => {
    await page.getByRole('heading', { name: 'Documentos', exact: true }).waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 0, 'The desktop library is a workspace, not a blocking startup dialog.');
    await page.keyboard.press('Control+f');
    assert.equal(await page.getByRole('searchbox', { name: 'Buscar documentos por nombre', exact: true }).evaluate(input => document.activeElement === input), true, 'Ctrl+F in the library searches documents.');
    await open(page);
    const position = await page.locator('.reading-area').evaluate(async reader => {
      const chapter = reader.querySelector('[data-page-number="3"]');
      reader.scrollTop += chapter.getBoundingClientRect().top - reader.getBoundingClientRect().top + 90;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return reader.scrollTop;
    });
    await visibleButton(page, 'Mis documentos').click();
    await page.getByRole('heading', { name: 'Documentos', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Abrir Architecture.pdf', exact: true }).click();
    await page.waitForFunction(top => Math.abs(document.querySelector('.reading-area').scrollTop - top) <= 3, position);
    assert.equal(await page.locator('.document-tab').count(), 1, 'Reopening the library row should resume its existing tab.');
    return { desktopLibraryRoot: true, savedScrollWithinPixels: 3, noDuplicateTab: true };
  }, { desktop: true });
  await check('desktop-import-immediately-returns-to-library', async page => {
    await page.addInitScript(() => {
      const original = Blob.prototype.arrayBuffer;
      globalThis.__folioDelayedLibraryReads = 0;
      Blob.prototype.arrayBuffer = async function () {
        if (!(this instanceof File)) {
          globalThis.__folioDelayedLibraryReads++;
          await new Promise(resolve => setTimeout(resolve, 600));
        }
        return original.call(this);
      };
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(fixture);
    await page.locator('.reading-area canvas').first().waitFor();
    await visibleButton(page, 'Mis documentos').click();
    await page.getByRole('heading', { name: 'Documentos', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Abrir Architecture.pdf', exact: true }).waitFor();
    assert(await page.evaluate(() => globalThis.__folioDelayedLibraryReads > 0), 'The delayed Blob persistence path must be exercised.');
    assert.equal(await page.getByRole('button', { name: 'Abrir Architecture.pdf', exact: true }).count(), 1);
    return { slowPersistenceExercised: true, immediateReturnEventuallyShowsImportedDocument: true };
  }, { desktop: true });
  await check('desktop-search-keyboard-and-return-to-reading-position', async page => {
    await open(page);
    const position = await page.locator('.reading-area').evaluate(async reader => {
      const chapter = reader.querySelector('[data-page-number="4"]');
      reader.scrollTop += chapter.getBoundingClientRect().top - reader.getBoundingClientRect().top + 90;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return reader.scrollTop;
    });
    await page.keyboard.press('Control+f');
    const input = page.getByLabel('Buscar texto en el PDF', { exact: true }); await input.fill('Needle');
    await page.waitForFunction(() => document.querySelectorAll('.search-result').length === 10);
    const selected = index => page.waitForFunction(index => [...document.querySelectorAll('.search-result')].findIndex(result => result.classList.contains('selected')) === index, index);
    await input.press('Enter'); await selected(0);
    await input.press('Enter'); await selected(1);
    assert.equal(await input.evaluate(input => document.activeElement === input), true, 'Search keyboard navigation must work without leaving the search input.');
    await input.press('F3'); await selected(2);
    await input.press('Shift+F3'); await selected(1);
    await page.locator('.desktop-return-location').click();
    await page.waitForFunction(position => Math.abs(document.querySelector('.reading-area').scrollTop - position) < 3, position);
    assert.equal(await page.getByLabel('Buscar texto en el PDF', { exact: true }).count(), 0);
    return { enterVisitsThenAdvancesOccurrence: true, f3AndShiftF3WithinSearchInput: true, originalReadingPositionRestoredWithinPixels: 3 };
  }, { desktop: true });
  await check('desktop-annotation-mode-and-more-print', async page => {
    await open(page);
    assert.equal(await page.getByRole('button', { name: 'Color del resaltador', exact: true }).isVisible(), false, 'Color belongs to annotation mode.');
    await page.locator('.reading-area').focus(); await page.keyboard.press('h');
    await visibleButton(page, 'Color del resaltador').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.desktop-annotation-toolbar').waitFor({ state: 'detached' });
    await visibleButton(page, 'Anotar documento').click();
    await visibleButton(page, 'Resaltado automático (H)').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Color del resaltador', exact: true }).isVisible(), false, 'Tool properties appear for the active tool.');
    await visibleButton(page, 'Resaltado automático (H)').click();
    await visibleButton(page, 'Color del resaltador').waitFor();
    await visibleButton(page, 'Modo lectura').click();
    assert.equal(await page.getByRole('button', { name: 'Color del resaltador', exact: true }).isVisible(), false);
    await visibleButton(page, 'Más acciones del documento').click();
    await page.getByRole('button', { name: /^Imprimir/ }).filter({ visible: true }).waitFor();
    return { cleanReadingMode: true, keyboardModeAndEscape: true, explicitAnnotationTools: true, printDiscoverableInMore: true };
  }, { desktop: true });
  await check('desktop-tools-categories-and-back-preserve-unapplied-drafts', async page => {
    await open(page); await visibleButton(page, 'Herramientas').click();
    const catalog = page.getByRole('dialog', { name: 'Herramientas', exact: true }); await catalog.waitFor();
    assert.equal(await catalog.locator('.tool-category').count(), 6);
    assert.equal(await catalog.locator('.operation-grid > button').count(), 16, 'The catalog must retain every existing operation.');
    for (const name of ['Páginas', 'Contenido', 'Formularios', 'Revisión y firmas', 'Exportación y OCR', 'Protección']) assert.equal(await catalog.getByRole('heading', { name, exact: true }).count(), 1);
    await visibleButton(page, 'Organizar páginas').click(); await visibleButton(page, 'Página en blanco').click();
    assert.equal(await page.locator('.page-plan > article').count(), 6);
    await visibleButton(page, 'Volver a Herramientas').click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-tool-key') === 'pages');
    assert.equal(await visibleButton(page, 'Organizar páginas').evaluate(button => document.activeElement === button), true, 'Back should restore keyboard focus to the operation.');
    await visibleButton(page, 'Organizar páginas').click(); assert.equal(await page.locator('.page-plan > article').count(), 6);
    await visibleButton(page, 'Volver a Herramientas').click(); await visibleButton(page, 'Rellenar formulario').click();
    const review = page.getByRole('textbox', { name: /Review/ }); await review.fill('Unapplied review draft');
    await visibleButton(page, 'Volver a Herramientas').click(); await visibleButton(page, 'Rellenar formulario').click();
    assert.equal(await review.inputValue(), 'Unapplied review draft', 'Returning to forms must not re-read over a pending value.');
    await visibleButton(page, 'Volver a Herramientas').click(); await visibleButton(page, 'Proteger PDF').click();
    const owner = page.getByLabel('Contraseña de propietario', { exact: true }); await owner.fill('draft-only-owner');
    await visibleButton(page, 'Volver a Herramientas').click(); await visibleButton(page, 'Proteger PDF').click(); assert.equal(await owner.inputValue(), 'draft-only-owner');
    await visibleButton(page, 'Volver a Herramientas').click(); await visibleButton(page, 'Comparar documentos').click();
    await page.getByLabel('Segundo PDF', { exact: true }).setInputFiles(fixture);
    await page.getByLabel('Contraseña del segundo PDF, si tiene', { exact: true }).fill('comparison-draft');
    await visibleButton(page, 'Volver a Herramientas').click(); await visibleButton(page, 'Comparar documentos').click();
    assert.equal(await page.getByLabel('Segundo PDF', { exact: true }).evaluate(input => input.files[0]?.name), 'Architecture.pdf');
    assert.equal(await page.getByLabel('Contraseña del segundo PDF, si tiene', { exact: true }).inputValue(), 'comparison-draft');
    if (!process.env.FOLIO_TEST_SKIP_COMPARE_BUSY) {
      await page.evaluate(() => {
        const original = File.prototype.arrayBuffer;
        globalThis.__folioCompareReadStarted = false;
        File.prototype.arrayBuffer = async function () {
          globalThis.__folioCompareReadStarted = true;
          await new Promise(resolve => { globalThis.__folioResumeCompareRead = resolve; });
          return original.call(this);
        };
      });
      await visibleButton(page, 'Comparar').click();
      await page.waitForFunction(() => globalThis.__folioCompareReadStarted);
      await page.waitForFunction(() => document.querySelector('.workbench-back').disabled);
      assert.equal(await visibleButton(page, 'Volver a Herramientas').isDisabled(), true, 'Back must wait while comparison reads and processes the second PDF.');
      await page.evaluate(() => globalThis.__folioResumeCompareRead());
      await page.waitForFunction(() => !document.querySelector('.workbench-back').disabled);
      await page.locator('.compare-controls').waitFor();
    }
    await page.getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
    assert.equal(await page.locator('.pdf-page-wrap').count(), 5, 'Leaving tools must not apply the six-page plan.');
    return { sixPurposeGroups: true, allSixteenOperations: true, unappliedPlanFormSecurityAndComparisonPreserved: true, keyboardFocusRestored: true, documentUnchanged: true, comparisonBackWaitsForActiveTask: !process.env.FOLIO_TEST_SKIP_COMPARE_BUSY };
  }, { desktop: true });
  await check('desktop-narrow-window-keeps-actions-and-legible-labels', async page => {
    await open(page);
    for (const width of [1360, 1100, 900, 760]) {
      await page.setViewportSize({ width, height: 820 });
      await visibleButton(page, 'Anotar documento').waitFor(); await visibleButton(page, 'Más acciones del documento').waitFor();
      const measurements = await page.locator('.reader-toolbar').evaluate(toolbar => {
        const bounds = toolbar.getBoundingClientRect();
        const visible = [...toolbar.querySelectorAll('button,input,select')].filter(element => { const box = element.getBoundingClientRect(), css = getComputedStyle(element); return box.width > 0 && box.height > 0 && css.visibility !== 'hidden' && css.display !== 'none'; });
        return { width: window.innerWidth, toolbarRight: bounds.right, toolbarBottom: bounds.bottom, overflow: toolbar.scrollWidth - toolbar.clientWidth, controls: visible.map(element => { const box = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label') || element.textContent.trim(), left: box.left, right: box.right, top: box.top, bottom: box.bottom, font: Number.parseFloat(getComputedStyle(element).fontSize) }; }) };
      });
      assert(measurements.toolbarRight <= width + 1 && measurements.overflow <= 1, `${width}px reader toolbar must fit without horizontal clipping.`);
      for (const control of measurements.controls) assert(control.left >= -1 && control.right <= width + 1 && control.bottom <= measurements.toolbarBottom + 1, `${control.label} must fit the toolbar at ${width}px.`);
      for (let index = 0; index < measurements.controls.length; index++) for (const other of measurements.controls.slice(index + 1)) {
        const control = measurements.controls[index], overlapWidth = Math.min(control.right, other.right) - Math.max(control.left, other.left), overlapHeight = Math.min(control.bottom, other.bottom) - Math.max(control.top, other.top);
        assert(overlapWidth <= 2 || overlapHeight <= 2, `${control.label} overlaps ${other.label} at ${width}px.`);
      }
      const annotateFont = await visibleButton(page, 'Anotar documento').evaluate(button => Number.parseFloat(getComputedStyle(button).fontSize));
      assert(annotateFont >= 12, 'Main desktop action labels should remain legible at a narrow width.');
      await visibleButton(page, 'Más acciones del documento').click(); await page.getByRole('button', { name: /^Imprimir/ }).filter({ visible: true }).waitFor();
      await page.keyboard.press('Escape');
    }
    await page.screenshot({ path: path.join(output, 'desktop-narrow-760.png'), animations: 'disabled' });
    return { testedWidths: [1360, 1100, 900, 760], noToolbarClipping: true, actionFontAtLeastPixels: 12, printAvailableAtAllWidths: true };
  }, { desktop: true });
} finally {
  await browser?.close(); server.kill();
  if (snapshot) { assert(path.resolve(snapshot).startsWith(snapshotRoot + path.sep)); fs.rmSync(snapshot, { recursive: true, force: true }); }
  const report = { passed: results.length > 0 && results.every(result => result.status === 'passed') && errors.length === 0, results, errors,
    limitations: ['Browser mobile emulation does not validate physical iOS selection handles or system Files/Share sheets.', 'Drag dismissal is a pointer-event contract; verify the gesture on a device.', 'The native capability case uses explicit mocked IPC, not a real PDFKit parser.', 'Desktop browser checks validate the interface; native Windows printing and Tauri window behavior need a packaged-app check.'],
    ...(results.some(result => result.status === 'failed') ? { serverLog: log } : {}) };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
