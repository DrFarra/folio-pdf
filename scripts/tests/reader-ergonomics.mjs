import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';
import { findChrome } from './browser.mjs';

const root = process.cwd(), output = path.join(root, 'test-results', 'reader-ergonomics');
fs.mkdirSync(output, { recursive: true });
const port = process.env.FOLIO_ERGONOMICS_PORT || '4214', origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...(process.env.FOLIO_ERGONOMICS_DEV ? [] : ['preview']), '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
const results = [], errors = []; let browser;
const agent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
try {
  for (let attempt = 0; attempt < 120; attempt++) { try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const executablePath = findChrome();
  browser = process.env.FOLIO_TEST_BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch({ executablePath, headless: true });
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
    const context = await browser.newContext({ viewport, screen: viewport, isMobile: true, hasTouch: true, userAgent: agent });
    await context.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' }));
    const page = await context.newPage(); await page.emulateMedia({ reducedMotion: 'reduce' }); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(origin);
      await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor();
      if (viewport.width === 390) await page.screenshot({ path: path.join(output, 'library.png') });
      await page.locator('input[type=file][accept="application/pdf,.pdf"]').setInputFiles(path.join(root, 'public', 'sample.pdf'));
      await page.locator('.reading-area .textLayer span').first().waitFor();
      await page.locator('.loading-overlay').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Páginas', exact: true }).waitFor();
      const controls = await page.locator('.app-header button,.mobile-reading-toolbar button,.mobile-reading-status button').evaluateAll(buttons => buttons.map(button => { const box = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label'), width: box.width, height: box.height, left: box.left, right: box.right, top: box.top, bottom: box.bottom }; }));
      for (const control of controls) { assert(control.width >= 44 && control.height >= 44, `44pt control: ${control.label}`); assert(control.left >= -.5 && control.right <= viewport.width + .5, `Within horizontal viewport: ${control.label}`); }
      const frame = () => page.locator('.reading-area').evaluate(element => { const paper = element.querySelector('.pdf-page').getBoundingClientRect(), box = element.getBoundingClientRect(); return { height: element.clientHeight, width: element.clientWidth, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, x: paper.x, y: paper.y, paperWidth: paper.width, paperHeight: paper.height, viewerY: box.y }; });
      const before = await frame();
      if (viewport.width > viewport.height) assert(before.paperWidth >= before.width * .9, `A sideways phone fits the page width: ${before.paperWidth}px of ${before.width}px.`);
      const paper = await page.locator('.pdf-page').first().boundingBox();
      await page.touchscreen.tap(paper.x + Math.min(15, paper.width / 4), Math.min(viewport.height - 140, paper.y + paper.height / 2));
      await page.waitForFunction(() => document.querySelector('.app-shell').classList.contains('reader-chrome-hidden'));
      const after = await frame(); assert.deepEqual(after, before, 'Immersive reading must preserve viewport, paper scale and position.');
      await page.touchscreen.tap(paper.x + Math.min(15, paper.width / 4), Math.min(viewport.height - 140, paper.y + paper.height / 2));
      await page.waitForFunction(() => !document.querySelector('.app-shell').classList.contains('reader-chrome-hidden'));
      if (viewport.width === 390) await page.screenshot({ path: path.join(output, 'reader.png') });
      await page.getByRole('button', { name: 'Páginas', exact: true }).tap();
      const drawer = await page.getByRole('dialog', { name: 'Explorar documento', exact: true }).boundingBox();
      assert(drawer.x >= -.5 && drawer.y >= -.5 && drawer.x + drawer.width <= viewport.width + .5 && drawer.y + drawer.height <= viewport.height + .5, 'Explorer fits visible viewport.');
      if (viewport.width === 390) await page.screenshot({ path: path.join(output, 'explorer.png') });
      await page.getByRole('button', { name: 'Cerrar panel', exact: true }).tap();
      await page.getByRole('button', { name: 'Anotar', exact: true }).tap();
      await page.getByRole('button', { name: 'Nota', exact: true }).tap();
      if (viewport.width === 390) await page.screenshot({ path: path.join(output, 'annotate.png') });
      await page.getByRole('button', { name: 'Listo', exact: true }).tap();
      await page.getByRole('button', { name: 'Más acciones', exact: true }).tap();
      await page.getByRole('button', { name: 'Vista del documento', exact: true }).tap();
      const dialog = await page.getByRole('dialog', { name: 'Vista del documento' }).boundingBox();
      assert(dialog.y >= -.5 && dialog.y + dialog.height <= viewport.height + .5, 'View settings fits viewport.');
      await page.getByRole('button', { name: 'Listo', exact: true }).tap();
      if (viewport.width === 390) {
        // Turning the phone, and turning it back, keeps the page being read.
        const reading = () => page.locator('.mobile-page-jump').getAttribute('title');
        await page.getByRole('button', { name: 'Ir a página', exact: true }).tap();
        const jump = page.getByRole('dialog', { name: 'Ir a página' });
        await jump.getByLabel(/^Página \(1–/).fill('4');
        await jump.getByRole('button', { name: 'Ir a página', exact: true }).tap();
        await page.waitForFunction(() => document.querySelector('.mobile-page-jump')?.title.startsWith('Página 4 de')); await page.waitForTimeout(300);
        for (const size of [{ width: 844, height: 390 }, viewport]) { await page.setViewportSize(size); await page.waitForTimeout(500); assert.match(await reading(), /^Página 4 de/, `Rotation to ${size.width}x${size.height} keeps the reading page.`); }
        // With Lápiz a finger draws, so two fingers scroll: their drift must not zoom; a clear pinch still does.
        await page.getByRole('button', { name: 'Anotar', exact: true }).tap(); await page.getByRole('button', { name: 'Lápiz', exact: true }).tap();
        const cdp = await context.newCDPSession(page), touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
        const twoFingers = async (spread, dy) => { await touch('touchStart', [[145, 420], [245, 420]]); for (let i = 1; i <= 10; i++) await touch('touchMove', [[145 - spread * i / 20, 420 + dy * i / 10 + (i % 2 ? 2 : -2)], [245 + spread * i / 20, 420 + dy * i / 10]]); await touch('touchEnd', []); };
        const paper = () => page.locator('.reading-area').evaluate(element => ({ width: element.querySelector('.pdf-page').getBoundingClientRect().width, top: element.scrollTop, overflow: element.scrollWidth - element.clientWidth }));
        const start = await paper();
        for (const spread of [-3, 3, -3]) await twoFingers(spread, -100);
        await page.waitForTimeout(300); const panned = await paper();
        assert(Math.abs(panned.width - start.width) < .5 && panned.overflow <= 0, `Two-finger scrolling must keep Ajustar página: ${start.width} → ${panned.width}px.`);
        assert(panned.top > start.top + 150, 'Two-finger scrolling pans the pages.');
        assert.equal(await page.locator('[data-ink-id]').count(), 0, 'The first finger of a two-finger gesture leaves no stroke.');
        await twoFingers(120, 0); await page.waitForTimeout(500);
        assert((await paper()).width > start.width * 1.3, 'A clear pinch still zooms.');
      }
      results.push({ viewport, status: 'passed', stableImmersiveViewport: true, controls44pt: true, visibleSheets: true, ...viewport.width === 390 ? { rotationKeepsPage: true, twoFingerPanKeepsZoom: true } : {} });
    } catch (error) { results.push({ viewport, status: 'failed', error: error.stack }); process.exitCode = 1; await page.screenshot({ path: path.join(output, `failure-${viewport.width}.png`) }).catch(() => {}); }
    finally { console.log(JSON.stringify(results.at(-1))); await context.close(); }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); server.kill();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, errors, limitations: ['Browser touch and viewport checks; actual iPhone safe areas, UIKit and physical gestures require device verification.'] }, null, 2));
}
