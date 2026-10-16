// Moving an image Folio placed, in Editar: from releasing the mouse until the
// moved image is selected again; the frames that still show it at its old place
// (a ghost: the images lie over a scan, where no plain colour can hide them);
// and the longest the interface stops (the longest gap between frames) in the
// 3 s after the drop, which covers writing the PDF.
// Run after a build:  node scripts/tests/edit-image-perf.mjs
//   FOLIO_EDIT_PERF_PAGES=600 (the heavy PDF, ~250 MB, written by edit-perf.mjs; 0 for a light one)
//   FOLIO_EDIT_PERF_CPU=4 (slows the CPU four times, as a slower laptop)
//   FOLIO_EDIT_PERF_DPR=2 and FOLIO_EDIT_PERF_ZOOM=width: a sharp screen, the page at full width (bigger pages to draw)
//   FOLIO_EDIT_PERF_EXE=path/to/folio-pdf.exe: in a QA build of the desktop app (identifier org.folio.pdf.qa,
//     its own data), which opens the PDF; the page is reached through WebView2's debugging port.
//   FOLIO_EDIT_PERF_LABEL=before|after names the report.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as mupdf from 'mupdf';
import { PDFDocument, rgb } from 'pdf-lib';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';

const root = process.cwd(), output = path.join(root, 'test-results', 'edit-perf');
fs.mkdirSync(output, { recursive: true });
const pages = Number(process.env.FOLIO_EDIT_PERF_PAGES ?? 600), cpu = Number(process.env.FOLIO_EDIT_PERF_CPU || 1), dpr = Number(process.env.FOLIO_EDIT_PERF_DPR || 1), zoom = process.env.FOLIO_EDIT_PERF_ZOOM || 'page';
let book = path.join(output, `book-${pages}-v2.pdf`);
// The light PDF has a grey chequer where the images go: no plain colour, as over a photo.
if (!pages) {
  const light = await PDFDocument.create(), sheet = light.addPage([612, 792]);
  for (let y = 300; y < 560; y += 3) for (let x = 40; x < 570; x += 3) sheet.drawRectangle({ x, y, width: 3, height: 3, color: rgb(.4 + (x * 7 + y * 13) % 41 / 100, .45, .45) });
  book = path.join(output, 'light.pdf'); fs.writeFileSync(book, await light.save());
} else if (!fs.existsSync(book)) throw new Error(`Run FOLIO_EDIT_PERF_PAGES=${pages} node scripts/tests/edit-perf.mjs first: it writes ${book}.`);

// A red picture: small and plain, or large and noisy (a photo's weight).
const picture = (width, height, noisy) => {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false), data = pixmap.getPixels();
  for (let i = 0; i < width * height; i++) data.set(noisy ? [200 + (i * 7919 % 56), (i * 104729) % 40, (i * 1299709) % 40] : [220, 30, 30], i * 3);
  return Buffer.from(pixmap.asPNG());
};
const images = [{ name: 'small', png: picture(60, 45, false) }, { name: 'large', png: picture(3000, 2250, true) }];

const port = process.env.FOLIO_EDIT_PERF_PORT || '4262', origin = `http://127.0.0.1:${port}`;
const exe = process.env.FOLIO_EDIT_PERF_EXE;
const server = exe ? spawn(path.resolve(exe), [book], { stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9367' } })
  : spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
const debug = 'http://127.0.0.1:9367';
if (exe) for (let i = 0; i < 300; i++) { try { if ((await fetch(`${debug}/json/version`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
const browser = exe ? await chromium.connectOverCDP(debug) : await chromium.launch({ executablePath: findChrome(), headless: true });
const report = { desktop: !!exe, pages, cpu, dpr, zoom, sizeMB: Math.round(fs.statSync(book).size / 1048576), moves: [] };
try {
  if (!exe) for (let i = 0; i < 120; i++) { try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const context = exe ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: dpr });
  const page = exe ? context.pages()[0] : await context.newPage(); page.setDefaultTimeout(300000);
  if (exe) await page.waitForURL(url => url.hostname === 'tauri.localhost'), await page.waitForFunction(() => window.__TAURI_INTERNALS__);
  if (exe) assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')), 'org.folio.pdf.qa', 'Only the QA build, with data of its own, is driven.');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  if (!exe) { await page.goto(origin); await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(book); }
  await page.locator('.pdf-page-wrap[data-page-number="1"] canvas[data-rendering="false"]').waitFor();
  await page.getByRole('button', { name: 'Editar contenido del PDF' }).click(); await page.locator('.edit-toolbar').waitFor();
  await page.getByLabel('Nivel de zoom').selectOption(zoom); await page.waitForTimeout(500);
  const pageBox = () => page.locator('.pdf-page-wrap[data-page-number="1"] .page-content').boundingBox();
  const toScreen = async (x, y) => { const box = await pageBox(), k = box.width / 612; return { x: box.x + x * k, y: box.y + (792 - y) * k }; };
  const settle = () => page.waitForFunction(() => !document.querySelector('.edit-toolbar[data-committing=true]') && !document.querySelector('.edit-snapshot') && !document.querySelector('.edit-ghost')
    && [...document.querySelectorAll('.pdf-page-wrap canvas:not(.page-detail)')].every(canvas => canvas.dataset.rendering !== 'true'));
  for (const image of images) {
    // Placed by dragging a box over the scan (or the light PDF's rules).
    await page.locator('.edit-toolbar input[type=file]').setInputFiles({ name: `${image.name}.png`, mimeType: 'image/png', buffer: image.png });
    await page.getByText(new RegExp(`colocar «${image.name}.png»`)).waitFor();
    const a = await toScreen(80, 500), b = await toScreen(160, 440);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
    await settle(); await page.locator('.edit-selection.kind-image').waitFor(); await page.waitForTimeout(1500);
    for (let move = 0; move < 3; move++) {
      const box = await page.locator('.edit-selection.kind-image').boundingBox(), old = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(old.x, old.y); await page.waitForTimeout(400);
      // On each frame from the drop on: the gap since the last one, and whether the
      // image is still seen at its old place (the page's pixels there are its red,
      // with nothing drawn over them).
      await page.evaluate(old => {
        const probe = window.folioProbe = { gaps: [], ghost: [], last: performance.now(), start: 0, red: false };
        const canvas = document.querySelector('.pdf-page-wrap[data-page-number="1"] canvas:not(.page-detail)'), context = canvas.getContext('2d');
        const covered = () => [...document.querySelectorAll('.edit-layer[data-edit-page="1"] :is(.edit-mask, .edit-sprite, .edit-snapshot)')].some(node => {
          const box = node.getBoundingClientRect();
          return old.x >= box.left && old.x <= box.right && old.y >= box.top && old.y <= box.bottom && (node.tagName !== 'IMG' || node.complete && node.naturalWidth > 0);
        });
        const redHere = () => { const box = canvas.getBoundingClientRect(), k = canvas.width / box.width, [r, g, b] = context.getImageData(Math.round((old.x - box.left) * k), Math.round((old.y - box.top) * k), 1, 1).data; return r > 150 && g < 90 && b < 90; };
        probe.red = redHere();
        const tick = now => {
          probe.gaps.push(now - probe.last); probe.last = now;
          if (probe.start && !covered() && redHere()) probe.ghost.push(Math.round(now - probe.start));
          if (!probe.stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, old);
      assert(await page.evaluate(() => window.folioProbe.red), `The ${image.name} image is on the page before moving`);
      if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      const dx = move % 2 ? -1 : 1;
      await page.mouse.down(); await page.mouse.move(old.x + dx * 60, old.y, { steps: 4 }); await page.mouse.move(old.x + dx * (box.width + 120), old.y, { steps: 4 });
      await page.evaluate(() => { window.folioProbe.start = performance.now(); }); const dropped = Date.now(); await page.mouse.up();
      // Done once the moved image is selected again.
      let done = 0;
      while (!done && Date.now() - dropped < 20000) {
        if (await page.evaluate(() => !document.querySelector('.edit-ghost') && !!document.querySelector('.edit-selection.kind-image') && !document.querySelector('.edit-toolbar[data-committing=true]'))) done = Date.now() - dropped;
      }
      await page.waitForTimeout(Math.max(0, 3000 - (Date.now() - dropped)));
      const { gaps, ghost } = await page.evaluate(() => { window.folioProbe.stop = true; return window.folioProbe; });
      if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await settle();
      report.moves.push({ image: image.name, moveMs: done, ghostMs: ghost, longestFrameMs: Math.round(Math.max(...gaps)), framesOver100: gaps.filter(gap => gap > 100).length });
      console.log(JSON.stringify(report.moves.at(-1)));
      await page.waitForTimeout(1200);
    }
    // Out of the way of the next one.
    await page.keyboard.press('Delete'); await settle(); await page.locator('.edit-selection.kind-image').waitFor({ state: 'detached' });
  }
  report.errors = errors;
  fs.writeFileSync(path.join(output, `image-${process.env.FOLIO_EDIT_PERF_LABEL || 'run'}-${pages}-cpu${cpu}-dpr${dpr}-${zoom}${exe ? '-desktop' : ''}.json`), JSON.stringify(report, null, 2));
  for (const move of report.moves) assert.equal(move.ghostMs.length, 0, `The ${move.image} image is not seen at its old place after the drop (seen at ${move.ghostMs} ms)`);
  assert.deepEqual(errors, []);
} catch (error) { await browser.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(output, 'image-failure.png') }).catch(() => {}); throw error; } finally { await browser.close(); server.kill(); }
if (exe) process.exit(process.exitCode ?? 0);
