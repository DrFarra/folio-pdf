// Runs the scripts the native shells inject into the page against a real DOM:
// Android's selection gate (plugins/folio-android/src/lib.rs) and the macOS
// Deshacer/Rehacer menu items (src-tauri/src/lib.rs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';

const read = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const gate = JSON.parse(read('src-tauri/plugins/folio-android/src/lib.rs').match(/const SELECTION_GATE: &str = ("(?:[^"\\]|\\.)*");/)[1]);
const menu = read('src-tauri/src/lib.rs').match(/window\.eval\(format!\("((?:[^"\\]|\\.)*)", id == "redo"\)\)/)[1];
const undoScript = (id, redo) => menu.replaceAll('{{', '{').replaceAll('}}', '}').replace('{id}', id).replace('{}', String(redo));

const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
try {
  const page = await browser.newPage({ hasTouch: true });
  await page.setContent(`<p id="help">Ayuda seleccionable</p><div class="textLayer" data-copy-allowed="false"><span id="pdf">Texto del PDF</span></div>
    <dialog id="dialog"><p id="licence">Licencia</p></dialog><input id="field" value="nota">`);
  await page.evaluate(() => { window.touches = []; window.FolioSelection = { touched: pdf => window.touches.push(pdf) }; });
  await page.evaluate(gate);
  for (const id of ['pdf', 'help']) await page.dispatchEvent(`#${id}`, 'pointerdown');
  await page.evaluate(() => document.getElementById('dialog').show());
  await page.dispatchEvent('#licence', 'pointerdown');
  await page.dispatchEvent('#pdf', 'pointerdown');
  assert.deepEqual(await page.evaluate(() => window.touches), [true, false, false, false], 'Only PDF text without an open dialog silences Android’s toolbar');

  await page.evaluate(() => {
    document.getElementById('dialog').close(); document.activeElement?.blur();
    window.keys = []; window.commands = [];
    window.addEventListener('keydown', event => window.keys.push([event.key, event.metaKey, event.shiftKey, event.target.id || event.target.tagName]));
    document.execCommand = command => { window.commands.push(command); return true; };
  });
  await page.evaluate(undoScript('undo', false));
  await page.evaluate(undoScript('redo', true));
  assert.deepEqual(await page.evaluate(() => window.keys), [['z', true, false, 'BODY'], ['z', true, true, 'BODY']], 'The menu items act like ⌘Z and ⇧⌘Z for the reader');
  await page.focus('#field');
  await page.evaluate(undoScript('undo', false));
  assert.deepEqual(await page.evaluate(() => [window.commands, window.keys.length]), [['undo'], 2], 'A text field keeps WebKit’s own undo');
  console.log('Native injected scripts: Android selection gate and macOS undo menu behave as expected.');
} finally { await browser.close(); }
