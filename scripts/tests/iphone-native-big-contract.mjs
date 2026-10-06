import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { webkit } from 'playwright-core';

// Exercises the actual App and its native-PDF adapter with explicit mocked IPC.
// No original 2 GiB byte buffer exists in this harness. Real Files interaction,
// PDFKit reading/export and device memory are verified by native tests separately.
const root = process.cwd(), output = path.join(root, 'test-results', 'iphone'); fs.mkdirSync(output, { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
assert(!/\.getData\s*\(/.test(fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')), 'The App must not materialize the original PDF through getData().');
const port = process.env.FOLIO_IPHONE_BIG_CONTRACT_PORT || '4202', origin = `http://127.0.0.1:${port}`;
const snapshotRoot = path.join(root, '.tools'), snapshot = process.env.FOLIO_IPHONE_BIG_DEV ? null : path.join(snapshotRoot, `iphone-big-preview-${process.pid}`);
if (snapshot) { fs.mkdirSync(snapshot, { recursive: true }); fs.cpSync(path.join(root, 'dist'), snapshot, { recursive: true }); }
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...(snapshot ? ['preview', '--outDir', snapshot] : []), '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
let log = '', browser, page; server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
const results = [], errors = [];
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(log || 'The isolated contract server exited.');
    try { if (stripVTControlCharacters(log).includes(origin) && (await fetch(origin)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, log || 'The contract server did not start.');
  browser = await webkit.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
  await context.addInitScript(() => {
    globalThis.isTauri = true;
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' });
    const storage = key => JSON.parse(localStorage.getItem(key) || 'null');
    const sessions = storage('__bigSessions') || {}, recents = storage('__bigRecents') || {}, calls = storage('__bigCalls') || [];
    const imported = { id: 'imported-a-page1', page: 1, kind: 'highlight', rect: [30, 450, 280, 470], quads: [[30, 470, 280, 470, 30, 450, 280, 450]], color: '#f5d164', text: 'Imported highlight A', created: 0, opacity: .25, nativeSourceRef: 'pdfkit:1:0' };
    const unseen = { id: 'imported-a-page20', page: 20, kind: 'note', rect: [30, 400, 30, 400], color: '#f5d164', text: 'Keep unseen original page 20', created: 0, nativeSourceRef: 'pdfkit:20:0' };
    const sources = {
      first: { token: 'first', name: 'Large first.pdf', size: 2 * 1024 ** 3, id: 'a'.repeat(64), revision: 'a'.repeat(64), annotations: [imported, unseen] },
      second: { token: 'second', name: 'Large second.pdf', size: 2 * 1024 ** 3, id: 'b'.repeat(64), revision: 'b'.repeat(64), annotations: [] },
      locked: { token: 'locked', name: 'Large locked.pdf', size: 2 * 1024 ** 3, id: 'c'.repeat(64), revision: 'c'.repeat(64), annotations: [] },
      migration: { token: 'migration', name: 'Large first.pdf', size: 2 * 1024 ** 3, id: 'e'.repeat(64), revision: 'e'.repeat(64), annotations: [{ id: 'migrated-native-note', page: 1, kind: 'note', rect: [45, 390, 45, 390], color: '#f5d164', text: 'Recovered native draft note', created: 0, nativeSourceRef: 'pdfkit:1:0' }] },
      legacy: { token: 'legacy', name: 'Legacy.pdf', size: 2 * 1024 ** 3, id: 'f'.repeat(64), revision: 'f'.repeat(64), annotations: [
        { ...imported, id: 'native-legacy-highlight', nativeSourceRef: 'pdfkit:1:0' },
        { ...unseen, id: 'native-legacy-deleted', nativeSourceRef: 'pdfkit:20:0' },
        { id: 'native-legacy-named-note', page: 5, kind: 'note', rect: [90, 300, 90, 300], color: '#f5d164', text: 'Original named note', created: 0, originalName: 'name-kept', nativeSourceRef: 'pdfkit:5:0' },
      ] },
      ambiguous: { token: 'ambiguous', name: 'Ambiguous.pdf', size: 2 * 1024 ** 3, id: '0'.repeat(64), revision: '0'.repeat(64), annotations: [
        { ...imported, id: 'ambiguous-original-one', nativeSourceRef: 'pdfkit:1:0' },
        { ...imported, id: 'ambiguous-original-two', nativeSourceRef: 'pdfkit:1:1' },
      ] },
    };
    const callbacks = new Map(), listeners = new Map(), opened = new Set();
    let id = 0;
    const api = { calls, sessions, sources, opened, pickNext: [], cancelNextSave: true, outputs: [], workers: [],
      emit: token => { for (const [listener, record] of listeners) if (record.event === 'folio-open-documents') callbacks.get(record.handler)?.({ event: record.event, id: listener, payload: [sources[token]] }); },
    };
    globalThis.__nativeBigContract = api;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker { constructor(url, options) { api.workers.push(String(url)); super(url, options); } };
    const permissions = { canCopy: true, canPrint: true, canAnnotate: true, canEdit: true, canAssemble: true, canFill: true };
    const sourceInfo = source => ({ token: source.token, name: source.name, size: source.size, id: source.id, revision: source.revision });
    const persist = () => { localStorage.setItem('__bigCalls', JSON.stringify(calls)); localStorage.setItem('__bigSessions', JSON.stringify(sessions)); localStorage.setItem('__bigRecents', JSON.stringify(recents)); };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_, listener) => listeners.delete(listener) };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: callback => { const key = ++id; callbacks.set(key, callback); return key; },
      unregisterCallback: callback => callbacks.delete(callback),
      invoke: async (command, args = {}) => {
        calls.push({ command, args: structuredClone(args), at: Date.now() }); persist();
        if (['read_document', 'load_draft', 'store_draft', 'write_pdf_copy', 'share_pdf_copy', 'print_pdf_copy'].includes(command)) throw new Error('Forbidden whole-file command: ' + command);
        if (command === 'plugin:event|listen') { const listener = ++id; listeners.set(listener, args); return listener; }
        if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return null; }
        if (command === 'drive_lookup') return null;
        if (command === 'startup_documents') return [sourceInfo(storage('__ambiguousSessionFixture') ? sources.ambiguous : storage('__legacySessionFixture') ? sources.legacy : sources.first)];
        if (command === 'native_draft_document') return storage('__recoverNativeDraft') && args.id === sources.first.id ? sourceInfo(sources.migration) : null;
        if (command === 'pick_documents') { const chosen = api.pickNext.splice(0); return chosen.map(token => sourceInfo(sources[token])); }
        if (command === 'load_session') return structuredClone(sessions[args.id] || null);
        if (command === 'store_session') { sessions[args.id] = structuredClone(args.session); persist(); return null; }
        if (command === 'remember_document') { recents[args.id] = { id: args.id, name: sources[args.token].name, size: sources[args.token].size, nativeSource: args.token, pages: args.pages, openedAt: args.openedAt }; persist(); return null; }
        if (command === 'recent_documents') return Object.values(recents);
        if (command === 'list_library') return Object.values(recents).map(({ nativeSource, ...metadata }) => metadata);
        if (command === 'open_library_document') {
          const source = sources[recents[args.id]?.nativeSource];
          if (!source) throw new Error('The selected library source is unavailable.');
          return sourceInfo(source);
        }
        if (command === 'native_pdf_open') {
          const source = sources[args.token]; if (!source) throw new Error('Unknown source token.');
          const locked = args.token === 'locked' && args.password !== 'correct-pass';
          if (!locked) opened.add(args.token);
          return { id: source.id, revision: source.revision, size: source.size, numPages: locked ? 0 : 40, locked, signed: false, permissions,
            firstPage: locked ? undefined : { page: 1, view: [0, 0, 420, 560], rotation: 0 } };
        }
        if (command === 'native_pdf_close') { opened.delete(args.token); return null; }
        if (command.startsWith('native_pdf_') && !opened.has(args.token)) throw new Error('The native source was closed: ' + args.token);
        if (command === 'native_pdf_page_info') return { view: [0, 0, 420, 560], rotation: 0, annotations: structuredClone(sources[args.token].annotations.filter(annotation => annotation.page === args.page)) };
        if (command === 'native_pdf_text') {
          await new Promise(resolve => setTimeout(resolve, 3));
          return { lines: [{ text: args.page === 20 ? 'Needle only on page 20.' : `Original native text page ${args.page}.`, bounds: [30, 480, 350, 500], direction: 'ltr', hasEOL: true }] };
        }
        if (command === 'native_pdf_outline') return [{ title: 'Start', page: 1, depth: 0 }, { title: 'Page 20', page: 20, depth: 1 }];
        if (command === 'native_pdf_render') {
          if (args.width > 4096 || args.height > 4096 || args.width * args.height > 4_000_000) throw new Error('A native raster exceeded its pixel bounds.');
          const canvas = document.createElement('canvas'); canvas.width = args.width; canvas.height = args.height;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.scale(canvas.width / 420, canvas.height / 560);
          ctx.fillStyle = '#24303a'; ctx.font = '20px sans-serif'; ctx.fillText(`Native PDF page ${args.page}`, 30, 40); ctx.font = '20px sans-serif';
          ctx.fillText(args.page === 20 ? 'Needle only on page 20.' : `Original native text page ${args.page}.`, 30, 76);
          const raw = atob(canvas.toDataURL('image/png').split(',')[1]); return new Uint8Array([...raw].map(character => character.charCodeAt(0))).buffer;
        }
        if (command === 'native_pdf_present') {
          api.outputs.push(structuredClone(args));
          if (args.action !== 'save') return true;
          if (api.cancelNextSave) { api.cancelNextSave = false; return null; }
          const original = sources[args.token];
          const kept = original.annotations.filter(annotation => !args.removedSourceRefs.includes(annotation.nativeSourceRef));
          for (const annotation of args.annotations) {
            const match = annotation.nativeSourceRef ? kept.findIndex(item => item.nativeSourceRef === annotation.nativeSourceRef) : -1;
            if (match >= 0) kept[match] = annotation;
            else kept.push({ ...annotation, nativeSourceRef: annotation.nativeSourceRef || `pdfkit:${annotation.page}:new` });
          }
          sources.saved = { ...original, token: 'saved', name: args.name, id: 'd'.repeat(64), revision: 'd'.repeat(64), annotations: structuredClone(kept) };
          return sourceInfo(sources.saved);
        }
        if (command === 'set_mobile_theme' || command === 'copy_text' || command === 'discard_draft') return null;
        throw new Error('Unexpected native command: ' + command);
      },
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
  const current = name => page.getByRole('heading', { name, exact: true, includeHidden: true });
  const readyDocument = async name => { await current(name).waitFor({ state: 'attached' }); await page.locator('.loading-overlay').waitFor({ state: 'detached' }); await page.locator('.pdf-page-wrap[data-page-number="1"] canvas[data-rendering=false]').waitFor(); };
  const action = async name => { await page.getByRole('button', { name: 'Más acciones', exact: true }).tap(); await page.getByRole('dialog', { name: 'Acciones del documento', exact: true }).getByRole('button', { name, exact: true }).tap(); };
  const annotations = async () => { await page.getByRole('button', { name: 'Páginas', exact: true }).tap(); await page.getByRole('tab', { name: 'Anotaciones', exact: true }).tap(); };
  const capture = () => page.evaluate(() => ({ calls: window.__nativeBigContract.calls, outputs: window.__nativeBigContract.outputs, workers: window.__nativeBigContract.workers, sessions: window.__nativeBigContract.sessions }));
  const mark = id => results.push({ id, passed: true, bridgeMocked: true });
  await page.goto(origin); await readyDocument('Large first.pdf');
  await page.locator('.highlight-annotation[data-annotation-id="imported-a-page1"]').waitFor();
  assert.equal(await page.locator('.highlight-annotation[data-annotation-id="imported-a-page1"]').evaluate(element => getComputedStyle(element).opacity), '0.25', 'Imported PDF highlight opacity must be preserved by the visible overlay.');
  let state = await capture(); assert(!state.calls.some(call => call.command === 'native_pdf_page_info' && call.args.page >= 10)); assert.deepEqual(state.workers, []);
  mark('native-2gib-metadata-opens-with-page-pixels-and-no-whole-file-read-or-js-worker');

  await annotations();
  const importedCard = page.locator('.annotation-card').filter({ hasText: 'Imported highlight A' }); await importedCard.getByRole('button', { name: 'Eliminar anotación', exact: true }).tap();
  await page.locator('.highlight-annotation[data-annotation-id="imported-a-page1"]').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Cerrar panel', exact: true }).tap();
  const span = page.locator('.pdf-page-wrap[data-page-number="1"] .textLayer span').filter({ hasText: 'Original native text page 1.' }).first();
  await span.evaluate(span => { const range = document.createRange(); range.selectNodeContents(span); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.getByRole('toolbar', { name: 'Herramientas del texto seleccionado', exact: true }).getByRole('button', { name: 'Resaltar', exact: true }).tap();
  await page.locator('.pdf-page-wrap[data-page-number="1"] .highlight-annotation').waitFor();
  await page.waitForFunction(() => window.__nativeBigContract.sessions['a'.repeat(64)]?.annotations.some(annotation => annotation.kind === 'highlight' && !annotation.nativeSourceRef));
  await action('Guardar una copia del PDF'); await page.waitForFunction(() => window.__nativeBigContract.outputs.length === 1);
  state = await capture(); assert.deepEqual(state.outputs[0].removedSourceRefs, ['pdfkit:1:0']); assert(state.outputs[0].annotations.some(annotation => annotation.quads?.length && !annotation.nativeSourceRef));
  assert(!state.outputs[0].removedSourceRefs.includes('pdfkit:20:0')); assert.equal(await page.getByRole('status').filter({ hasText: 'Copia guardada.' }).count(), 0);
  await readyDocument('Large first.pdf');
  mark('imported-delete-and-real-text-highlight-reach-native-export-cancel-preserves-session-and-unseen-original');

  await page.getByRole('button', { name: 'Más acciones', exact: true }).tap();
  await page.evaluate(() => window.__nativeBigContract.emit('second')); await page.waitForTimeout(350);
  state = await capture(); assert(!state.calls.some(call => call.command === 'native_pdf_open' && call.args.token === 'second'));
  await page.getByRole('dialog', { name: 'Acciones del documento', exact: true }).getByRole('button', { name: 'Cerrar diálogo', exact: true }).tap();
  await readyDocument('Large second.pdf');
  await page.getByRole('button', { name: 'Documentos abiertos y recientes', exact: true }).tap();
  await page.getByRole('dialog', { name: 'Documentos abiertos y recientes', exact: true }).getByRole('button', { name: 'Cambiar a Large first.pdf', exact: true }).tap();
  await readyDocument('Large first.pdf'); assert.equal(await page.locator('.highlight-annotation[data-annotation-id="imported-a-page1"]').count(), 0);
  await page.waitForFunction(() => { const session = window.__nativeBigContract.sessions['a'.repeat(64)]; return session?.nativeKnownPages?.includes(1) && session?.nativeOriginalRefs?.includes('pdfkit:1:0') && !session.annotations.some(annotation => annotation.id === 'imported-a-page1'); });
  mark('system-open-event-waits-for-modal-and-deleted-original-does-not-return-on-tab-switch');

  await page.reload(); await readyDocument('Large first.pdf'); assert.equal(await page.locator('.highlight-annotation[data-annotation-id="imported-a-page1"]').count(), 0);
  assert.equal(await page.locator('.pdf-page-wrap[data-page-number="1"] .highlight-annotation').count(), 1);
  mark('native-session-reload-restores-added-highlight-and-keeps-imported-original-deleted');

  await page.getByRole('button', { name: 'Buscar', exact: true }).tap();
  await page.getByRole('textbox', { name: 'Buscar texto en el PDF', exact: true }).waitFor(); await page.waitForTimeout(300);
  state = await capture(); assert(!state.calls.some(call => call.command === 'native_pdf_text' && call.args.page >= 10), 'Opening the empty search panel must not index distant pages.');
  await page.getByRole('textbox', { name: 'Buscar texto en el PDF', exact: true }).fill('Needle');
  await page.locator('.search-result').filter({ hasText: 'Página 20' }).waitFor();
  await page.waitForFunction(() => window.__nativeBigContract.calls.some(call => call.command === 'native_pdf_text' && call.args.page === 40));
  await page.getByRole('button', { name: 'Borrar búsqueda', exact: true }).tap(); await page.getByRole('button', { name: 'Cerrar búsqueda', exact: true }).tap();
  mark('native-text-search-starts-only-after-a-query-and-finds-lazy-page20');

  await page.evaluate(() => { window.__nativeBigContract.cancelNextSave = false; });
  await action('Guardar una copia del PDF'); await readyDocument('Large first — copia.pdf');
  state = await capture(); const exported = state.outputs.at(-1); assert.equal(exported.action, 'save'); assert.deepEqual(exported.removedSourceRefs, ['pdfkit:1:0']);
  assert(exported.annotations.some(annotation => annotation.nativeSourceRef === 'pdfkit:20:0'));
  assert.equal(await page.locator('.highlight-annotation[data-annotation-id="imported-a-page1"]').count(), 0);
  assert.equal(await page.locator('.pdf-page-wrap[data-page-number="1"] .highlight-annotation').count(), 1);
  // iOS always saves a copy and then edits it.
  await page.getByRole('status').filter({ hasText: 'Copia guardada. Ahora editas «Large first — copia.pdf».' }).first().waitFor();
  mark('native-save-uses-removal-refs-preserves-other-originals-and-reopens-file-backed-copy');

  const chooseLocked = async () => { await page.evaluate(() => { window.__nativeBigContract.pickNext.push('locked'); }); await page.getByRole('button', { name: 'Documentos abiertos y recientes', exact: true }).tap(); await page.getByRole('dialog', { name: 'Documentos abiertos y recientes', exact: true }).getByRole('button', { name: 'Abrir PDF', exact: true }).tap(); await page.getByRole('dialog', { name: 'Este PDF tiene contraseña', exact: true }).waitFor(); };
  await chooseLocked(); await page.getByRole('dialog', { name: 'Este PDF tiene contraseña', exact: true }).getByRole('button', { name: 'Cancelar', exact: true }).tap();
  await readyDocument('Large first — copia.pdf'); assert.equal(await page.getByRole('dialog', { name: 'Este PDF tiene contraseña', exact: true }).count(), 0);
  await chooseLocked(); let password = page.getByRole('dialog', { name: 'Este PDF tiene contraseña', exact: true });
  await password.getByLabel('Contraseña').fill('wrong'); await password.getByRole('button', { name: 'Abrir PDF', exact: true }).tap();
  await page.locator('.password-error').waitFor(); password = page.getByRole('dialog', { name: 'Este PDF tiene contraseña', exact: true });
  await password.getByLabel('Contraseña').fill('correct-pass'); await password.getByRole('button', { name: 'Abrir PDF', exact: true }).tap(); await readyDocument('Large locked.pdf');
  state = await capture(); assert(state.calls.filter(call => call.command === 'native_pdf_close' && call.args.token === 'locked').length >= 3);
  mark('native-locked-pdf-cancel-keeps-document-and-wrong-password-retry-unlocks');

  await page.evaluate(() => localStorage.setItem('__recoverNativeDraft', 'true'));
  await page.reload(); await readyDocument('Large first.pdf');
  await page.waitForFunction(() => { const session = window.__nativeBigContract.sessions['a'.repeat(64)]; return session?.documentRevision === 'e'.repeat(64) && session.annotations.some(annotation => annotation.id === 'migrated-native-note'); });
  state = await capture();
  assert(state.calls.some(call => call.command === 'native_pdf_open' && call.args.token === 'migration'));
  const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('__bigRecents'))['a'.repeat(64)]);
  assert.equal(recent.nativeSource, 'first', 'Recovering a native draft must keep the original source in recents.');
  await annotations(); await page.locator('.annotation-card').filter({ hasText: 'Recovered native draft note' }).waitFor();
  await page.getByRole('button', { name: 'Cerrar panel', exact: true }).tap();
  mark('legacy-large-draft-recovers-as-native-file-and-keeps-original-recent-without-reading-or-storing-full-bytes');

  await page.evaluate(() => {
    localStorage.setItem('__legacySessionFixture', 'true');
    const sessions = window.__nativeBigContract.sessions;
    sessions['f'.repeat(64)] = { version: 3, documentRevision: 'f'.repeat(64), lastPage: 1, bookmarks: [], annotations: [
      { id: 'pdf-1-18', sourceRef: 18, page: 1, kind: 'highlight', rect: [30.25, 450.25, 280.25, 470.25], quads: [[30, 470, 280, 470, 30, 450, 280, 450]], color: '#3d9dea', text: 'Edited legacy highlight', created: 100 },
      { id: 'pdf-5-80', sourceRef: 80, originalName: 'name-kept', page: 5, kind: 'note', rect: [95, 305, 95, 305], color: '#9277db', text: 'Edited legacy note', created: 200 },
      { id: 'legacy-user-note', page: 1, kind: 'note', rect: [10, 100, 10, 100], color: '#f5d164', text: 'Own legacy note', created: 300 },
    ] };
    localStorage.setItem('__bigSessions', JSON.stringify(sessions));
  });
  await page.reload(); await readyDocument('Legacy.pdf');
  await page.waitForFunction(() => { const session = window.__nativeBigContract.sessions['f'.repeat(64)]; return session?.nativeLegacySession && session.annotations.some(annotation => annotation.id === 'native-legacy-highlight' && annotation.nativeSourceRef === 'pdfkit:1:0'); });
  let legacySession = (await capture()).sessions['f'.repeat(64)];
  assert.equal(legacySession.annotations.length, 3); assert(!legacySession.annotations.some(annotation => annotation.id === 'native-legacy-deleted'));
  const keptLegacy = legacySession.annotations.find(annotation => annotation.id === 'native-legacy-highlight');
  assert.equal(keptLegacy.color, '#3d9dea'); assert.equal(keptLegacy.text, 'Edited legacy highlight');
  const legacyHighlight = page.locator('.highlight-annotation[data-annotation-id="native-legacy-highlight"]').first();
  await legacyHighlight.waitFor();
  assert.equal(Number(await legacyHighlight.evaluate(element => getComputedStyle(element).opacity)), .35,
    'A legacy native highlight without explicit opacity must retain the opacity used by native export.');
  await page.reload(); await readyDocument('Legacy.pdf');
  await page.waitForFunction(() => window.__nativeBigContract.sessions['f'.repeat(64)]?.nativeLegacySession === true);
  await page.evaluate(() => { window.__nativeBigContract.cancelNextSave = false; });
  await action('Guardar una copia del PDF'); await readyDocument('Legacy — copia.pdf');
  state = await capture(); const legacyExport = state.outputs.at(-1);
  assert.deepEqual(legacyExport.removedSourceRefs, ['pdfkit:20:0']);
  assert.equal(legacyExport.annotations.length, 3, 'Migrating a legacy session must not append deleted or duplicate originals.');
  assert(legacyExport.annotations.some(annotation => annotation.id === 'native-legacy-named-note' && annotation.nativeSourceRef === 'pdfkit:5:0' && annotation.text === 'Edited legacy note' && annotation.color === '#9277db'));
  assert(legacyExport.annotations.some(annotation => annotation.id === 'legacy-user-note' && !annotation.nativeSourceRef));
  assert(state.calls.some(call => call.command === 'native_pdf_page_info' && call.args.token === 'legacy' && call.args.page === 20), 'Legacy save must resolve unseen original references before export.');
  assert.equal(await page.locator('.highlight-annotation[data-annotation-id="native-legacy-highlight"]').count(), 1);
  mark('v3-mupdf-session-migrates-numeric-and-named-refs-preserves-edits-and-keeps-unseen-deleted-original-out-of-export');

  await page.evaluate(() => {
    localStorage.setItem('__ambiguousSessionFixture', 'true');
    const sessions = window.__nativeBigContract.sessions;
    sessions['0'.repeat(64)] = { version: 3, documentRevision: '0'.repeat(64), lastPage: 1, bookmarks: [], annotations: [
      { id: 'pdf-1-99', sourceRef: 99, page: 1, kind: 'highlight', rect: [30, 450, 280, 470], quads: [[30, 470, 280, 470, 30, 450, 280, 450]], color: '#3d9dea', text: 'Preserve ambiguous legacy edit', created: 100 },
    ] };
    localStorage.setItem('__bigSessions', JSON.stringify(sessions));
  });
  await page.reload(); await readyDocument('Ambiguous.pdf');
  await page.getByRole('alert').filter({ hasText: 'varias anotaciones originales' }).waitFor();
  await page.waitForFunction(() => window.__nativeBigContract.sessions['0'.repeat(64)]?.nativeLegacySession === true);
  await action('Guardar una copia del PDF');
  await page.getByRole('alert').filter({ hasText: 'La copia no se ha guardado.' }).waitFor();
  await readyDocument('Ambiguous.pdf');
  state = await capture(); assert.equal(state.outputs.length, 0, 'Ambiguous migration must be rejected before native export.');
  const unresolved = state.sessions['0'.repeat(64)];
  assert(unresolved.nativeLegacySession && !unresolved.nativeKnownPages.includes(1));
  assert.equal(unresolved.annotations.length, 1); assert.equal(unresolved.annotations[0].text, 'Preserve ambiguous legacy edit');
  assert.equal(unresolved.annotations[0].color, '#3d9dea'); assert.equal(unresolved.annotations[0].id, 'pdf-1-99');
  mark('ambiguous-legacy-overlaps-notify-without-crashing-or-losing-edits-and-block-native-export');

  assert(!state.calls.some(call => ['read_document', 'load_draft', 'store_draft', 'write_pdf_copy', 'share_pdf_copy', 'print_pdf_copy'].includes(call.command)));
  assert.deepEqual(state.workers, []); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'iphone-native-big-contract.png'), animations: 'disabled' });
  mark('all-integrated-flows-avoid-full-buffer-commands-worker-editing-and-getData-call-sites');
} catch (error) {
  process.exitCode = 1; results.push({ id: 'native-big-integration', passed: false, bridgeMocked: true, error: error.stack, serverLog: log });
  await page?.screenshot({ path: path.join(output, 'failure-iphone-native-big-contract.png'), animations: 'disabled' }).catch(() => {});
} finally {
  const evidence = await page?.evaluate(() => ({ calls: window.__nativeBigContract?.calls, sessions: window.__nativeBigContract?.sessions, outputs: window.__nativeBigContract?.outputs, workers: window.__nativeBigContract?.workers })).catch(() => undefined);
  await browser?.close(); server.kill();
  if (snapshot) { assert(path.resolve(snapshot).startsWith(path.resolve(snapshotRoot) + path.sep)); fs.rmSync(snapshot, { recursive: true, force: true }); }
  const report = { version, capturedAt: new Date().toISOString(), buildMode: snapshot ? 'immutable-dist' : 'live-source', passed: results.length === 11 && results.every(result => result.passed) && errors.length === 0, results, errors, evidence,
    scope: 'Actual Folio App and native-PDF adapter in mobile WebKit with explicitly mocked file-backed IPC and persisted mock sessions.',
    limitations: ['The 2 GiB input is source metadata, not a real native file.', 'Mock export verifies command arguments and UI outcomes; actual PDFKit output bytes are tested by the native simulator suite.', 'UIKit picker, Files app Open In and physical memory were not exercised.'] };
  fs.writeFileSync(path.join(output, 'iphone-native-big-contract-results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, evidence: undefined }));
  if (!report.passed) process.exitCode = 1;
}
