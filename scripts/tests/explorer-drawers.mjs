// Switching the explorer between Anotaciones and Páginas/Índice/Marcadores on touch
// layouts swaps one drawer for the other in place; opening and closing still slide.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { findChrome } from './browser.mjs';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', process.env.FOLIO_DRAWERS_PORT || '4243', '--strictPort'], { stdio: 'pipe' });
for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + (process.env.FOLIO_DRAWERS_PORT || '4243'))).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
const browser = await chromium.launch({ executablePath: findChrome(), headless: true }); let failed = false;
for (const [layout, width, height] of [['tablet', 800, 1000], ['phone', 390, 844]]) {
  const context = await browser.newContext({ viewport: { width, height }, screen: { width, height }, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; device) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36' });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto('http://127.0.0.1:' + (process.env.FOLIO_DRAWERS_PORT || '4243')); await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles('.fixtures/tracemonkey.pdf');
  await page.locator('.textLayer span').first().waitFor(); await page.locator('.loading-overlay').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Páginas', exact: true }).first().click(); await page.waitForTimeout(600);
  const state = () => page.evaluate(() => ({ drawers: [...document.querySelectorAll('.mobile-drawer')].map(d => d.className.replace('mobile-drawer', '').trim()),
    animating: [...document.querySelectorAll('.mobile-drawer')].flatMap(d => d.getAnimations().map(a => a.animationName)),
    selected: [...document.querySelectorAll('[data-explorer-tab][aria-selected="true"]')].map(t => t.dataset.explorerTab) }));
  const steps = [];
  for (const tab of ['annotations', 'outline', 'annotations', 'pages']) { await page.locator(`.mobile-drawer:not(.closing) [data-explorer-tab="${tab}"]`).click(); steps.push({ tab, ...await state() }); }
  await page.keyboard.press('Escape'); await page.waitForTimeout(30); const closing = await state(); await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Páginas', exact: true }).first().click(); await page.waitForTimeout(30); const reopened = await state();
  failed ||= !closing.animating.length || !reopened.animating.length || reopened.drawers.some(d => d.includes('drawer-swap'));
  console.log(layout, JSON.stringify(steps), 'close:', JSON.stringify(closing), 'reopen:', JSON.stringify(reopened));
  failed ||= steps.some(s => s.drawers.length !== 1 || s.animating.length || s.selected.length !== 1 || s.selected[0] !== s.tab);
  await context.close();
}
await browser.close(); server.kill(); process.exitCode = failed ? 1 : 0;
