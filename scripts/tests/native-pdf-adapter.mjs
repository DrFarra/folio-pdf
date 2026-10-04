import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { PDFDocument, degrees } from 'pdf-lib';
import { webkit } from 'playwright-core';
import assert from 'node:assert/strict';

// This is an adapter contract test, not a native PDFKit or 2 GiB device-memory
// test. The bridge is explicitly mocked; rendering, DOM selection and the
// reference PDF.js viewport execute in real WebKit. No App component is loaded.
const output = 'test-results/iphone'; fs.mkdirSync(output, { recursive: true });
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

const fixture = await PDFDocument.create(), fixturePage = fixture.addPage([470, 640]);
fixturePage.setMediaBox(-25, -40, 470, 640); fixturePage.setCropBox(25, 40, 420, 560); fixturePage.setRotation(degrees(90));
fixturePage.drawText('Native selected words', { x: 30, y: 455, size: 18 });
const bytes = [...await fixture.save()];
const port = process.env.FOLIO_NATIVE_PDF_TEST_PORT || '4201', origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: 'pipe', windowsHide: true });
let serverLog = '', browser, page, report;
server.stdout.on('data', data => { serverLog += data; }); server.stderr.on('data', data => { serverLog += data; });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(serverLog || 'The isolated fixture server exited.');
    try { if (serverLog.includes(origin) && (await fetch(origin + '/package.json')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, serverLog || 'The isolated fixture server did not start.');
  browser = await webkit.launch(); const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await context.newPage(); await page.goto(origin + '/package.json', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.body.innerHTML = ''; });
  await page.addStyleTag({ path: 'src/styles.css' }); await page.addStyleTag({ path: 'src/components/PDFPage.css' });
  const result = await page.evaluate(async fixtureBytes => {
    const { openNativePdf, nativePdfMetadata, isNativePdfDocument, subscribeNativePdfAnnotations, nativePdfPageAnnotations, isNativePdfPasswordError } = await import('/src/nativePdf.ts');
    const { getDocument, TextLayer, readOutline } = await import('/src/pdf.ts');
    const actual = await getDocument({ data: new Uint8Array(fixtureBytes) }).promise, originalPage = await actual.getPage(1);
    const info = { view: originalPage.view, rotation: originalPage.rotate, annotations: [{ id: 'original-one', page: 1, kind: 'note', rect: [40, 40, 40, 40], color: '#f5d164', text: 'Original', created: 0, nativeSourceRef: '1:0' }] };
    const metadata = { id: 'a'.repeat(64), revision: 'b'.repeat(64), size: 2 * 1024 ** 3, numPages: 50000, locked: false, signed: false, firstPage: { page: 1, ...info }, permissions: { canCopy: true, canPrint: true, canAnnotate: true, canEdit: true, canAssemble: true, canFill: true } };
    const calls = [], annotated = [];
    let delayRender = false;
    const bridge = async (command, args) => {
      calls.push({ command, args });
      if (command === 'native_pdf_open') return metadata;
      if (command === 'native_pdf_page_info') return { ...info, annotations: args.page === 1 ? info.annotations : [] };
      if (command === 'native_pdf_text') return { lines: [{ text: 'Native selected words', bounds: [30, 455, 280, 473], direction: 'ltr' }] };
      if (command === 'native_pdf_outline') return [{ title: 'Parent', page: 1, depth: 0 }, { title: 'Child', page: 50000, depth: 1 }];
      if (command === 'native_pdf_close') return null;
      if (command === 'native_pdf_render') {
        if (delayRender) await new Promise(resolve => setTimeout(resolve, 120));
        const canvas = document.createElement('canvas'); canvas.width = args.width; canvas.height = args.height;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#18ab42'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        const encoded = atob(canvas.toDataURL('image/png').split(',')[1]); return new Uint8Array([...encoded].map(character => character.charCodeAt(0))).buffer;
      }
      throw new Error('Unexpected command ' + command);
    };
    const { pdf } = await openNativePdf({ token: 'large-file', name: '2GiB.pdf', size: metadata.size }, undefined, undefined, { bridge });
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    check(isNativePdfDocument(pdf) && nativePdfMetadata(pdf).size === metadata.size, 'native metadata');
    const unsubscribe = subscribeNativePdfAnnotations(pdf, (page, annotations) => annotated.push({ page, annotations }));
    const nativePage = await pdf.getPage(1), geometry = [];
    for (const rotation of [0, 90, 180, 270, -90]) for (const dontFlip of [false, true]) {
      const options = { scale: 1.25, rotation, offsetX: 6, offsetY: 9, dontFlip };
      const native = nativePage.getViewport(options), reference = originalPage.getViewport(options);
      check(JSON.stringify(native.transform) === JSON.stringify(reference.transform), 'viewport transform mismatch: ' + rotation + '/' + dontFlip);
      check(native.width === reference.width && native.height === reference.height, 'viewport dimensions');
      const point = native.convertToPdfPoint(...native.convertToViewportPoint(81, 402));
      check(Math.abs(point[0] - 81) < .00001 && Math.abs(point[1] - 402) < .00001, 'coordinate roundtrip');
      geometry.push({ rotation, dontFlip, matchesPDFjs: true });
    }
    const viewport = nativePage.getViewport({ scale: 1, rotation: 0 });
    const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
    await nativePage.render({ canvas, viewport }).promise;
    const pixel = [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data]; check(pixel.join(',') === '24,171,66,255', 'PNG did not draw into canvas');
    const layer = document.createElement('div'); layer.className = 'textLayer'; layer.style.setProperty('--total-scale-factor', '1'); layer.style.setProperty('--scale-factor', '1');
    const frame = document.createElement('div'); frame.style.cssText = `position:fixed;left:0;top:0;width:${viewport.width}px;height:${viewport.height}px;`; frame.append(layer); document.body.append(frame);
    await new TextLayer({ textContentSource: await nativePage.getTextContent(), container: layer, viewport }).render();
    const span = layer.querySelector('span'), rect = span.getBoundingClientRect();
    check(span.textContent === 'Native selected words', 'native text is missing');
    check(rect.width > 200 && rect.height > 10 && rect.left >= 0 && rect.top >= 0, 'native text layer geometry');
    const range = document.createRange(); range.setStart(span.firstChild, 7); range.setEnd(span.firstChild, 15);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); check(selection.toString() === 'selected', 'selection must contain real DOM text');
    check((await nativePdfPageAnnotations(pdf, 1))[0].nativeSourceRef === '1:0' && annotated[0].annotations.length === 1, 'annotations source identity');
    check(JSON.stringify(await readOutline(pdf)) === JSON.stringify([{ title: 'Parent', page: 1, depth: 0 }, { title: 'Child', page: 50000, depth: 1 }]), 'native outline hierarchy');
    const before = canvas.getContext('2d').getImageData(0, 0, 1, 1).data.join(',');
    delayRender = true; const canceled = nativePage.render({ canvas, viewport });
    const cancellation = canceled.promise.then(() => false, error => error.name === 'RenderingCancelledException');
    await new Promise(resolve => setTimeout(resolve, 20)); canceled.cancel(); check(await cancellation, 'render cancellation');
    await new Promise(resolve => setTimeout(resolve, 150)); check(canvas.getContext('2d').getImageData(0, 0, 1, 1).data.join(',') === before, 'canceled render painted');
    for (let number = 2; number <= 24; number++) await (await pdf.getPage(number)).getTextContent();
    await (await pdf.getPage(1)).getTextContent(); check(calls.filter(call => call.command === 'native_pdf_page_info' && call.args.page === 1).length === 2, 'metadata cache must evict');
    check(calls.filter(call => call.command === 'native_pdf_text' && call.args.page === 1).length === 2, 'text cache must evict');
    await pdf.getPage(50000); check(calls.at(-1).args.page === 50000, 'lazy last page');
    await pdf.getData().then(() => { throw new Error('native original bytes unexpectedly available'); }, () => {});
    unsubscribe(); await Promise.all([pdf.destroy(), pdf.loadingTask.destroy()]);
    check(calls.filter(call => call.command === 'native_pdf_close').length === 1, 'close must be idempotent');
    let lockedClosed = false;
    try { await openNativePdf({ token: 'locked', name: 'locked.pdf', size: 1 }, undefined, undefined, { bridge: async command => command === 'native_pdf_open' ? { ...metadata, locked: true } : (lockedClosed = true) }); throw new Error('locked PDF opened'); }
    catch (error) { check(isNativePdfPasswordError(error) && !error.retry && lockedClosed, 'password contract/cache cleanup'); }
    await actual.loadingTask.destroy();
    return { passed: true, bridgeMocked: true, PDFKitExecuted: false, geometry, pixel, selectableText: selection.toString(), originalPdfBytesFetched: false, simulatedDocumentBytes: metadata.size, commands: [...new Set(calls.map(call => call.command))], lazyPages: [...new Set(calls.filter(call => call.command === 'native_pdf_page_info').map(call => call.args.page))], closeCount: 1 };
  }, bytes);
  assert(result.passed);
  report = { version, capturedAt: new Date().toISOString(), ...result, scope: 'Native PDF adapter with explicitly mocked IPC; real WebKit text layer, image decoding and PDF.js viewport reference.', limitations: ['PDFKit was not executed by this test.', 'The 2 GiB value is metadata; real large-file opening and native memory use require the iOS simulator/device tests.'] };
} catch (error) {
  process.exitCode = 1;
  report = { version, capturedAt: new Date().toISOString(), passed: false, bridgeMocked: true, PDFKitExecuted: false, error: error.stack, serverLog };
  await page?.screenshot({ path: `${output}/failure-native-pdf-adapter.png` }).catch(() => {});
} finally {
  await browser?.close(); server.kill();
  fs.writeFileSync(`${output}/native-pdf-adapter-results.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
