import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

// Real Tauri process + Rust file writes. This exercises Android's compact
// JSON payload through Tauri's actual fallback bridge, not a mocked invoke.
const executable = process.env.FOLIO_QA_EXE || 'test-results/unified/folio-qa.exe';
const out = 'test-results/native-binary-ipc'; fs.mkdirSync(out, { recursive: true });
const bytes = Buffer.alloc(14 * 1024 * 1024, 32);
Buffer.from('%PDF-1.7\n').copy(bytes); Buffer.from('\n%%EOF\n').copy(bytes, bytes.length - 7);
const id = createHash('sha256').update(bytes).digest('hex');
const child = spawn(path.resolve(executable), [], { windowsHide: true, stdio: 'ignore' }); let browser;
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch('http://127.0.0.1:9367/json/version')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.connectOverCDP('http://127.0.0.1:9367');
  const page = browser.contexts()[0].pages()[0]; await page.waitForURL(url => url.hostname === 'tauri.localhost');
  const result = await page.evaluate(async ({ id, encoded }) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    if (await invoke('plugin:app|identifier') !== 'org.folio.pdf.qa') throw Error('Must use isolated QA app data');
    // Force the real postMessage path used by Android.
    const originalFetch = window.fetch; let fallbacks = 0;
    window.fetch = (...args) => {
      const url = String(args[0]);
      if (url.startsWith('http://ipc.localhost') || url.startsWith('https://ipc.localhost') || url.startsWith('ipc:')) { fallbacks++; return Promise.reject(Error('QA: exercise postMessage transport')); }
      return originalFetch(...args);
    };
    try {
      const started = performance.now();
      await invoke('store_draft', { base64: encoded }, { headers: { 'x-folio-draft-id': id } });
      const elapsedMs = performance.now() - started;
      window.fetch = originalFetch;
      const saved = new Uint8Array(await invoke('load_draft', { id }));
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', saved))].map(x => x.toString(16).padStart(2, '0')).join('');
      if (hash !== id) throw Error('Native save changed PDF bytes');
      let rejected = false;
      try { await invoke('store_draft', { base64: 'bad!' }, { headers: { 'x-folio-draft-id': id } }); } catch { rejected = true; }
      if (!rejected) throw Error('Invalid data was not rejected');
      const afterError = new Uint8Array(await invoke('load_draft', { id }));
      const afterHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', afterError))].map(x => x.toString(16).padStart(2, '0')).join('');
      if (afterHash !== id) throw Error('A failed write damaged the previous draft');
      await invoke('discard_draft', { id });
      return { bytes: saved.length, elapsedMs, fallbacks, hash, rejected, version: await invoke('plugin:app|version') };
    } finally { window.fetch = originalFetch; }
  }, { id, encoded: bytes.toString('base64') });
  assert.equal(result.version, JSON.parse(fs.readFileSync('package.json')).version);
  assert(result.fallbacks > 0, 'Must exercise the actual postMessage fallback');
  fs.writeFileSync(`${out}/report.json`, JSON.stringify({ passed: true, ...result, realTauriBridge: true, realRustDiskWrite: true, physicalAndroid: false }, null, 2));
  console.log('PASS real Tauri postMessage / Rust: 14 MB binary save, byte-for-byte reload, invalid payload rejection and previous draft preservation.', result);
} finally { await browser?.close().catch(() => {}); if (child.exitCode === null) child.kill(); }
