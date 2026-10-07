import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';
import { settled } from './ui-helpers.mjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// The stylus barrel button (S Pen, Wacom, Surface) and the Apple Pencil double
// tap or squeeze relayed by the iOS plugin open the pen tools at the pen tip.
const out = 'test-results/pencil-palette'; fs.mkdirSync(out, { recursive: true });
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
pdf.addPage([420, 600]).drawText('PENCIL PALETTE', { x: 32, y: 510, size: 16, font });
const source = Buffer.from(await pdf.save());
const origin = 'http://127.0.0.1:4287';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4287', '--strictPort'], { stdio: 'ignore', windowsHide: true });
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  for (const [layout, width, height] of [['desktop', 1360, 980], ['tablet', 800, 1000]]) {
    const mobile = layout !== 'desktop';
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: mobile,
      userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 15; tablet) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36' : undefined });
    const page = await context.newPage(), errors = []; page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.locator('.app-header input[type=file]').setInputFiles({ name: 'Lapiz.pdf', mimeType: 'application/pdf', buffer: source });
    await page.locator('.textLayer span').first().waitFor(); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
    const cdp = await context.newCDPSession(page);
    const pen = (type, x, y, button, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, pointerType: 'pen', button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
    const palette = page.getByRole('toolbar', { name: 'Herramientas del lápiz', exact: true });
    const centre = async () => palette.evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.top }; });

    // Barrel button pressed while hovering: the ring opens at the tip, nothing is drawn.
    const box = await page.locator('.page-content').first().boundingBox(); assert(box);
    const x = Math.round(box.x + box.width * .5), y = Math.round(box.y + box.height * .5);
    await pen('mouseMoved', x, y, 'none', 0);
    await pen('mouseMoved', x, y, 'none', 2);
    await palette.waitFor({ state: 'attached' }); await settled(page);
    assert.deepEqual(await centre(), { x, y }, `${layout}: the palette must open where the pen points`);
    assert.equal(await palette.getByRole('button').count(), 5, 'Undo only appears once there is something to undo');
    await page.screenshot({ path: `${out}/${layout}-open.png` });
    await pen('mouseMoved', x, y, 'none', 0);
    await palette.getByRole('button', { name: 'Rotulador', exact: true }).click();
    await palette.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.page-content.tool-draw').count() > 0, true, `${layout}: choosing a pen tool must activate drawing`);

    // Reopen through the native relay (Apple Pencil) and check the active tool and Escape.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('folio:pencil-palette', { detail: { x: 200, y: 300 } })));
    await palette.waitFor({ state: 'attached' }); await settled(page);
    assert.deepEqual(await centre(), { x: 200, y: 300 });
    assert.equal(await palette.getByRole('button', { name: 'Rotulador', exact: true }).getAttribute('class').then(c => c.includes('active')), true);
    await page.keyboard.press('Escape');
    await palette.waitFor({ state: 'detached' });

    // Near an edge the ring stays fully on screen.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('folio:pencil-palette', { detail: { x: 4, y: 4 } })));
    await palette.waitFor({ state: 'attached' }); await settled(page);
    const inside = await palette.locator('button').evaluateAll(buttons => buttons.every(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
    assert.equal(inside, true, `${layout}: palette buttons must stay inside the viewport`);
    await page.mouse.click(width - 40, height - 40);
    await palette.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${layout}: ok`);
  }
} finally { await browser?.close(); server.kill(); }
