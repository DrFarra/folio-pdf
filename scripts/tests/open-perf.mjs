// Opening a large PDF in the desktop app, from the open request until its first
// page is drawn, and for 20 s after (Folio still writes and indexes then); with
// FOLIO_OPEN_PERF_EDIT=1, then one change in Editar and the 20 s after it:
//   longestFrameMs  the longest gap between the page's frames;
//   ipcLateMs       the longest a trivial command takes (the window's own thread answers every
//                   command, so this is how long the window stops responding);
//   debuggerLateMs  the longest the WebView's main process takes to answer the debugger.
// A frame drawn by the page does not mean the window answers: on Windows the
// WebView hands each command's request body to Folio 1 KB at a time, on the window's thread.
// Run with a QA build (identifier org.folio.pdf.qa or org.folio.pdf.<name>qa, its own data; FOLIO_OPEN_PERF_PORT
// if another uses 9367):
//   FOLIO_OPEN_PERF_EXE=src-tauri/target/debug/folio-pdf.exe node scripts/tests/open-perf.mjs [file.pdf]
// The default file is the ~250 MB book that edit-perf.mjs writes. The app starts
// empty; a second launch with the file hands it over, as opening it from Explorer.
// FOLIO_OPEN_PERF_TRACE=1 also prints every command over 1 MB or 200 ms.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const exe = process.env.FOLIO_OPEN_PERF_EXE;
if (!exe) throw new Error('Set FOLIO_OPEN_PERF_EXE to a QA build of folio-pdf.exe.');
const book = path.resolve(process.argv[2] || 'test-results/edit-perf/book-600-v2.pdf');
if (!fs.existsSync(book))
  throw new Error(`Run FOLIO_EDIT_PERF_PAGES=600 node scripts/tests/edit-perf.mjs first: it writes ${book}.`);
const port = process.env.FOLIO_OPEN_PERF_PORT || '9367';
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
const app = spawn(path.resolve(exe), [], { stdio: 'ignore', env });
const debug = `http://127.0.0.1:${port}`;
for (let i = 0; i < 300; i++) {
  try {
    if ((await fetch(`${debug}/json/version`)).ok) break;
  } catch {}
  await new Promise(r => setTimeout(r, 100));
}
const browser = await chromium.connectOverCDP(debug);
try {
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(120000);
  await page.waitForURL(url => url.hostname === 'tauri.localhost');
  await page.waitForFunction(() => window.__TAURI_INTERNALS__);
  assert.match(
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')),
    /^org\.folio\.pdf\..*qa/,
    'Only a QA build, with data of its own, is driven.',
  );
  await page.waitForTimeout(1500);
  const trace = !!process.env.FOLIO_OPEN_PERF_TRACE;
  if (trace) {
    page.on('console', message => message.text().startsWith('ipc ') && console.log(message.text()));
    app.on('exit', code => console.log('app exit', code));
    page.on('crash', () => console.log('page crash'));
  }
  // Measures from `action` until 20 s after it ends.
  const measure = async (name, action) => {
    await page.evaluate(trace => {
      const probe = (window.folioOpenProbe = { start: performance.now(), frame: 0, ipc: 0, last: performance.now() });
      const frame = now => {
        probe.frame = Math.max(probe.frame, now - probe.last);
        probe.last = now;
        if (!probe.done) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      (async () => {
        while (!probe.done) {
          const t = performance.now();
          await window.__TAURI_INTERNALS__.invoke('plugin:app|version');
          probe.ipc = Math.max(probe.ipc, performance.now() - t);
          await new Promise(r => setTimeout(r, 50));
        }
      })();
      if (!trace || window.folioFetch) return;
      const fetch = (window.folioFetch = window.fetch.bind(window));
      window.fetch = async (url, init) => {
        const t = performance.now(),
          size = init?.body?.byteLength ?? 0,
          response = await fetch(url, init);
        if (String(url).includes('ipc.localhost') && (size > 1e6 || performance.now() - t > 200))
          console.log(
            'ipc',
            Math.round(t - window.folioOpenProbe.start),
            String(url).split('/').pop(),
            size,
            Math.round(performance.now() - t),
          );
        return response;
      };
    }, trace);
    let debuggerLate = 0,
      stop = false;
    const heartbeat = (async () => {
      while (!stop) {
        const t = Date.now();
        await page.evaluate(() => 0);
        debuggerLate = Math.max(debuggerLate, Date.now() - t);
        await new Promise(r => setTimeout(r, 50));
      }
    })();
    const started = Date.now();
    await action();
    const actionMs = Date.now() - started;
    await page.waitForTimeout(20000);
    const result = await page.evaluate(() => {
      const probe = window.folioOpenProbe;
      probe.done = true;
      return { longestFrameMs: Math.round(probe.frame), ipcLateMs: Math.round(probe.ipc) };
    });
    stop = true;
    await heartbeat;
    console.log(
      JSON.stringify({
        step: name,
        sizeMB: Math.round(fs.statSync(book).size / 1048576),
        actionMs,
        ...result,
        debuggerLateMs: debuggerLate,
      }),
    );
  };
  await measure('open', async () => {
    spawn(path.resolve(exe), [book], { stdio: 'ignore', env });
    await page.locator('.pdf-page-wrap[data-page-number="1"] canvas[data-rendering="false"]').waitFor();
  });
  // FOLIO_OPEN_PERF_EDIT=1: then one change in Editar, which Folio writes as a draft after a pause.
  if (process.env.FOLIO_OPEN_PERF_EDIT)
    await measure('edit', async () => {
      await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();
      await page.locator('.edit-toolbar').waitFor();
      await page.locator('.edit-toolbar input[type=file]').setInputFiles({
        name: 'dot.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
      await page.getByText(/colocar «dot.png»/).waitFor();
      const box = await page.locator('.pdf-page-wrap[data-page-number="1"] .page-content').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.locator('.edit-selection.kind-image').waitFor();
    });
} finally {
  await browser.close().catch(() => {});
  app.kill();
}
