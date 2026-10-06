import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';

// The installed web app opens offline, keeps one cache per version and never
// answers unhashed files from the cache while the network works.
const root = process.cwd(), output = path.join(root, 'test-results'); fs.mkdirSync(output, { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const origin = 'http://127.0.0.1:4236';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4236', '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
const results = []; let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const chrome = findChrome();
  browser = await chromium.launch({ executablePath: chrome });
  const context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(20000);
  // A cache left by an earlier version of the worker.
  await page.goto(origin + '/folio.svg'); await page.evaluate(() => caches.open('folio-0.5.0').then(cache => cache.put('/stale', new Response('old'))));
  await page.goto(origin);
  // Activation deletes the older caches before the worker reports 'activated'.
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const stored = await page.evaluate(async () => ({ keys: await caches.keys(), urls: (await (await caches.open((await caches.keys())[0])).keys()).map(request => new URL(request.url).pathname) }));
  assert.deepEqual(stored.keys, [`folio-${version}`], 'The cache is named after the version and older caches are deleted.');
  const entry = (await (await fetch(origin)).text()).match(/src="(\/assets\/[^"]+\.js)"/)[1];
  for (const file of ['/', '/theme.js', entry]) assert.ok(stored.urls.includes(file), `${file} is cached when the worker installs.`);
  results.push({ id: 'versioned-cache-with-shell', status: 'passed' });

  // Online, unhashed files come from the network even when a cached copy exists.
  await page.evaluate(async version => (await caches.open(`folio-${version}`)).put('/theme.js', new Response('window.folioStaleTheme = true;', { headers: { 'Content-Type': 'text/javascript' } })), version);
  await page.reload(); await page.locator('#root > *').first().waitFor();
  assert.equal(await page.evaluate(() => window.folioStaleTheme), undefined, 'An unhashed file is not served from the cache while online.');
  results.push({ id: 'network-first-unhashed', status: 'passed' });

  await context.setOffline(true);
  await page.reload(); await page.locator('#root > *').first().waitFor();
  assert.equal(await page.title(), 'Folio', 'The installed app opens without a connection.');
  await context.setOffline(false);
  results.push({ id: 'offline-start', status: 'passed' });
  fs.writeFileSync(path.join(output, 'service-worker-results.json'), JSON.stringify({ version, results }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close(); server.kill();
}
