import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const out = 'test-results/drawing'; fs.mkdirSync(out, { recursive: true });
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
const sheet = pdf.addPage([420, 600]);
sheet.drawText('FIRST LINE TO HIGHLIGHT', { x: 32, y: 510, size: 16, font });
sheet.drawText('SECOND INDEPENDENT LINE', { x: 32, y: 460, size: 16, font });
const source = Buffer.from(await pdf.save());
const origin = 'http://127.0.0.1:4284';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4284', '--strictPort'], { stdio: 'ignore', windowsHide: true });
const results = []; let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const chrome = findChrome();
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  for (const [layout, width, height] of [['desktop', 1360, 980], ['tablet', 800, 1000], ['phone', 390, 844]]) {
    const mobile = layout !== 'desktop';
    const context = await browser.newContext({ viewport: { width, height }, screen: { width, height }, hasTouch: true, isMobile: mobile,
      userAgent: mobile ? `Mozilla/5.0 (Linux; Android 15; ${layout}) AppleWebKit/537.36 Chrome/140.0.0.0 ${layout === 'phone' ? 'Mobile ' : ''}Safari/537.36` : undefined });
    const page = await context.newPage(), errors = []; page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(origin); await page.locator('.app-header input[type=file]').setInputFiles({ name: 'Gestos.pdf', mimeType: 'application/pdf', buffer: source });
      await page.locator('.textLayer span').first().waitFor(); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
      // Area tools own a one-finger drag; the note tool and the reader keep scrolling.
      // Desktop layouts never pinch-zoom the interface (WebView2's pinch is on for touchpads).
      const touchActions = await page.locator('.page-content').first().evaluate(content => {
        const original = content.className, actions = {};
        for (const tool of ['select', 'note', 'highlight', 'redact', 'crop', 'add-text', 'replace-image', 'create-field']) { content.className = `page-content tool-${tool}`; actions[tool] = getComputedStyle(content).touchAction; }
        content.className = original; return actions;
      });
      assert.deepEqual(touchActions, { select: layout === 'desktop' ? 'pan-x pan-y' : 'auto', note: 'pan-x pan-y', highlight: 'pan-y', redact: 'none', crop: 'none', 'add-text': 'none', 'replace-image': 'none', 'create-field': 'none' });
      await page.getByRole('button', { name: layout === 'phone' ? 'Anotar' : 'Anotar documento', exact: true }).click();
      await page.getByRole('button', { name: mobile ? 'Lápiz' : 'Lápiz (D)', exact: true }).click();
      await page.getByRole('button', { name: 'Opciones del lápiz', exact: true }).click();
      let popup = page.getByRole('dialog', { name: 'Lápiz', exact: true });
      await popup.waitFor();
      assert.equal(await popup.getByLabel('Usar el dedo').count(), mobile ? 1 : 0, 'PC must hide finger settings until a pen is detected, even on a touch capable browser.');
      await popup.getByRole('button', { name: '4 pt', exact: true }).click();
      await page.screenshot({ path: `${out}/${layout}-pencil.png` });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.ink-settings').count(), 0);
      const cdp = await context.newCDPSession(page);
      const pen = (type, x, y, buttons = type === 'mouseReleased' ? 0 : 1) => cdp.send('Input.dispatchMouseEvent', { type, x, y, pointerType: 'pen', button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, force: buttons ? .65 : 0 });
      const inkCount = count => page.waitForFunction(count => document.querySelectorAll('[data-ink-id]').length === count, count);
      const box = await page.locator('.ink-layer').first().boundingBox(); assert(box);
      const y = box.y + box.height * .62, xs = [.3, .5, .7].map(f => box.x + box.width * f), dy = box.height * .09;
      for (const x of xs) { await pen('mousePressed', x, y); await pen('mouseMoved', x, y + dy); await pen('mouseReleased', x, y + dy); }
      await inkCount(3);
      await page.getByRole('button', { name: 'Opciones del lápiz', exact: true }).click();
      popup = page.getByRole('dialog', { name: 'Lápiz', exact: true }); await popup.getByLabel('Usar el dedo').waitFor();
      assert.equal(await popup.getByRole('button', { name: '4 pt', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Goma', exact: true }).click();
      await page.getByRole('button', { name: 'Opciones de la goma', exact: true }).click();
      popup = page.getByRole('dialog', { name: 'Goma', exact: true });
      await popup.getByRole('button', { name: 'Media', exact: true }).click();
      assert.equal(await popup.getByRole('group', { name: 'Color del lápiz' }).count(), 0);
      await page.screenshot({ path: `${out}/${layout}-eraser.png` }); await page.keyboard.press('Escape');
      // One press and two fast moves cross all three strokes. Check BEFORE release.
      await pen('mousePressed', xs[0] - 20, y + dy / 2);
      await pen('mouseMoved', xs[0] + 2, y + dy / 2); await inkCount(2);
      await pen('mouseMoved', xs[2] + 20, y + dy / 2); await inkCount(0);
      await pen('mouseReleased', xs[2] + 20, y + dy / 2);
      await page.keyboard.press('Control+z'); await inkCount(3);
      await pen('mouseMoved', xs[0], y, 0); await page.waitForTimeout(80); await inkCount(3);
      await page.keyboard.press('Control+y'); await inkCount(0);
      await page.getByRole('button', { name: mobile ? 'Lápiz' : 'Lápiz (D)', exact: true }).click();
      await page.getByRole('button', { name: 'Opciones del lápiz', exact: true }).click();
      await page.getByLabel('Usar el dedo', { exact: true }).check();
      await page.waitForTimeout(450); // Palm rejection expires after the pen leaves.
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 3, radiusY: 3, force: .7, id: 1 }] });
      // A tap on the page closes the pen options without leaving a dot of ink.
      const options = await page.getByRole('dialog', { name: 'Lápiz', exact: true }).boundingBox();
      const tapY = [box.y + 24, box.y + box.height - 24].find(value => value < options.y - 8 || value > options.y + options.height + 8);
      await touch('touchStart', box.x + box.width / 2, tapY); await touch('touchEnd');
      await page.getByRole('dialog', { name: 'Lápiz', exact: true }).waitFor({ state: 'detached' }); await page.waitForTimeout(100); await inkCount(0);
      await touch('touchStart', xs[0], y); await touch('touchMove', xs[0] + 35, y + 15); await touch('touchEnd'); await inkCount(1);
      await page.getByRole('button', { name: mobile ? 'Resaltador' : 'Resaltador (H)', exact: true }).click();
      await page.getByRole('button', { name: 'Color del resaltador', exact: true }).click();
      popup = page.getByRole('dialog', { name: 'Colores del resaltador', exact: true });
      const paletteBox = await popup.boundingBox(); assert(paletteBox.x >= 0 && paletteBox.x + paletteBox.width <= width);
      await page.screenshot({ path: `${out}/${layout}-highlighter.png` });
      await popup.getByRole('button', { name: 'Color Verde', exact: true }).click();
      const lines = await page.locator('.textLayer span').all();
      const first = await lines[0].boundingBox(), second = await lines[1].boundingBox();
      const highlights = count => page.waitForFunction(count => document.querySelectorAll('.highlight-annotation:not(.preview)').length === count, count);
      await pen('mousePressed', first.x + 1, first.y + first.height / 2);
      await pen('mouseMoved', first.x + first.width - 1, first.y + first.height / 2);
      await page.waitForTimeout(650); await highlights(0); // Never commit while pen is held.
      await pen('mouseReleased', first.x + first.width - 1, first.y + first.height / 2); await highlights(1);
      await pen('mouseMoved', second.x + second.width - 1, second.y + second.height / 2, 0);
      await page.waitForTimeout(650); await highlights(1);
      assert.equal(await page.evaluate(() => getSelection()?.toString()), '', 'Hover after lifting the pen must not extend selection.');
      await pen('mousePressed', second.x + 1, second.y + second.height / 2);
      await pen('mouseMoved', second.x + second.width - 1, second.y + second.height / 2);
      await pen('mouseReleased', second.x + second.width - 1, second.y + second.height / 2); await highlights(2);
      assert.deepEqual(errors, []);
      results.push({ layout, passed: true, input: 'Chromium CDP pen and touch input', individualPopovers: true, closingPopoverDoesNotDraw: true, areaToolsOwnTouchDrag: true, desktopFingerOptionRequiresDetectedPen: true, fingerDrawing: true, continuousEraserBeforeLift: true, fastSweepCrossesAllStrokes: true, oneUndoRestoresSweep: true, highlighterWaitsForLift: true, penHoverDoesNotRepeatHighlight: true, physicalPenTested: false });
    } catch (error) { process.exitCode = 1; results.push({ layout, passed: false, error: error.stack }); await page.screenshot({ path: `${out}/${layout}-failure.png` }).catch(() => {}); }
    finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
  }
  // Pen-only finger momentum is one glide for the whole reader: a finger held on
  // another page stops it, so a pencil put down there never draws on a sliding page.
  const long = await PDFDocument.create(), longFont = await long.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 6; i++) long.addPage([420, 600]).drawText(`PAGE ${i}`, { x: 32, y: 510, size: 16, font: longFont });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; phone) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36' });
  await context.addInitScript(() => localStorage.setItem('folio.ink.penMode', 'pen'));
  const page = await context.newPage(), errors = []; page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin); await page.locator('.app-header input[type=file]').setInputFiles({ name: 'Largo.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await long.save()) });
    await page.locator('.textLayer span').first().waitFor(); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Anotar', exact: true }).click(); await page.getByRole('button', { name: 'Lápiz', exact: true }).click();
    assert.equal(await page.locator('.ink-layer.ink-interactive').first().getAttribute('data-pen-only'), 'true');
    const cdp = await context.newCDPSession(page), top = () => page.locator('.reading-area').evaluate(reader => reader.scrollTop);
    const touch = (type, x, y, id = 1) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 3, radiusY: 3, force: .7, id }] });
    const first = await page.locator('.pdf-page-wrap[data-page-number="1"] .ink-layer').boundingBox(); assert(first);
    const startY = first.y + first.height * .8; await touch('touchStart', 200, startY);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', 200, startY - i * 50); await page.waitForTimeout(8); }
    await touch('touchEnd'); const lifted = await top(); await page.waitForTimeout(80);
    const flung = await top(), hold = await page.evaluate(() => {
      const reader = document.querySelector('.reading-area').getBoundingClientRect();
      for (const layer of document.querySelectorAll('.pdf-page-wrap:not([data-page-number="1"]) .ink-layer')) {
        const box = layer.getBoundingClientRect(), y = Math.max(box.top, reader.top) + 30;
        if (y < Math.min(box.bottom, reader.bottom) - 120) return { y, page: layer.closest('.pdf-page-wrap').dataset.pageNumber };
      }
    });
    assert(hold, 'Another page must be under the finger after the fling.');
    await touch('touchStart', 200, hold.y, 2); const held = await top(); await page.waitForTimeout(300); const after = await top(); await touch('touchEnd');
    assert(flung > lifted + 5, `The fling must keep gliding after the finger lifts (scrollTop ${lifted} -> ${flung}).`);
    assert(Math.abs(after - held) <= 2, `A finger held on page ${hold.page} must stop the glide started on page 1 (scrollTop ${held} -> ${after}).`);
    assert.deepEqual(errors, []);
    results.push({ layout: 'phone-pen-only', passed: true, glideContinuesAfterFling: true, pressOnAnotherPageStopsGlide: true, heldOnPage: hold.page });
  } catch (error) { process.exitCode = 1; results.push({ layout: 'phone-pen-only', passed: false, error: error.stack }); await page.screenshot({ path: `${out}/phone-pen-only-failure.png` }).catch(() => {}); }
  finally { await context.close(); console.log(JSON.stringify(results.at(-1))); }
} finally { await browser?.close(); server.kill(); fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2)); }
