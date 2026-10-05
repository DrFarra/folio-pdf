import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const root = process.cwd(), output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const sources = [];
for (const letter of ['A', 'B']) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let number = 1; number <= 2; number++) {
    const page = pdf.addPage([600, 900]);
    page.drawText(`INLINE ${letter} PAGE ${number}`, { x: 50, y: 800, font, size: 18, color: rgb(0, .2, .4) });
    page.drawText(`NEIGHBOR ${letter} ${number}`, { x: 50, y: 650, font, size: 14 });
  }
  const file = path.join(output, `inline-editor-${letter}.pdf`);
  fs.writeFileSync(file, await pdf.save()); sources.push({ file, name: path.basename(file), letter });
}
const [a, b] = sources;
const executablePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(fs.existsSync);
assert(executablePath, 'An installed Chrome or Edge is required.');
const port = process.env.FOLIO_INLINE_EDITOR_PORT || '4260', origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
let browser, log = '', frontendEntry;
const results = [], errors = [];
server.stdout.on('data', value => { log += value; }); server.stderr.on('data', value => { log += value; });
const tab = (page, source) => page.getByRole('tab', { name: source.name, exact: true });
const pageNumber = page => page.getByRole('textbox', { name: 'Número de página', exact: true });
const zoom = page => page.getByRole('combobox', { name: 'Nivel de zoom', exact: true });
const picker = (page, number = 1) => page.locator(`.pdf-content-picker[data-page="${number}"][data-picker-state="ready"]`).waitFor({ timeout: 60000 });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function active(page, source) {
  await page.waitForFunction(name => [...document.querySelectorAll('[role="tab"]')].some(node => node.getAttribute('aria-label') === name && node.getAttribute('aria-selected') === 'true'), source.name);
  await page.getByRole('heading', { name: source.name, exact: true }).waitFor();
  await page.locator('.loading-overlay').waitFor({ state: 'detached' });
}
async function open(page, source) {
  await page.locator('.app-header input[type="file"]').setInputFiles(source.file); await active(page, source);
}
async function edit(page, number = 1) {
  await page.getByRole('button', { name: 'Herramientas', exact: true }).click();
  await page.getByRole('button', { name: 'Editar PDF', exact: true }).click(); await picker(page, number);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.locator('main.reader>.workspace-editor').count(), 1);
  assert.equal(await page.locator('.app-header .document-tab-strip').isVisible(), true);
}
async function closeEditor(page) {
  await page.getByRole('button', { name: 'Listo', exact: true }).click();
  await page.locator('.workspace-editor').waitFor({ state: 'detached' });
  await page.locator('.reading-area').waitFor({ state: 'visible' }); await settle(page);
}
async function disabledPointerClick(page, control) {
  assert.equal(await control.isDisabled(), true);
  const bounds = await control.boundingBox(); assert(bounds);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}
async function assertDraft(page, value) {
  await active(page, a);
  assert.equal(await page.locator('.document-tab [role="tab"]').count(), 2);
  assert.equal(await page.getByRole('textbox', { name: 'Texto', exact: true }).inputValue(), value);
  assert.equal(await page.locator('dialog[open]').count(), 0);
}
async function check(id, run) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 720 }, acceptDownloads: true });
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push({ id, message: error.message }));
  try {
    await page.goto(origin); await open(page, a);
    results.push({ id, status: 'passed', frontendEntry, ...await run(page) });
  } catch (error) {
    process.exitCode = 1; results.push({ id, status: 'failed', frontendEntry, error: error.stack });
    if (!page.isClosed()) await page.screenshot({ path: path.join(output, `failure-${id}.png`), animations: 'disabled' });
  } finally { console.log(JSON.stringify(results.at(-1))); await context.close(); }
}
try {
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await fetch(origin); if (response.ok) { frontendEntry = (await response.text()).match(/src="([^"]+\.js)"/)?.[1]; started = true; break; } } catch {}
    if (server.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(started, `Preview did not start: ${log}`); assert(frontendEntry?.startsWith('/assets/'), 'The integration suite must exercise the built frontend.');
  browser = await chromium.launch({ executablePath, headless: true });
  await check('inline-draft-guards-tabs-shortcuts-and-document-actions', async page => {
    await open(page, b); await tab(page, a).click(); await active(page, a);
    // A real history entry makes Ctrl+Z meaningful: an unguarded reader undo
    // would remove this bookmark while the selected text draft remains visible.
    await page.getByRole('button', { name: 'Guardar marcador de esta página', exact: true }).click();
    await page.getByRole('button', { name: 'Editar marcador de esta página', exact: true }).waitFor();
    await edit(page);
    await page.getByRole('button', { name: 'Párrafo: INLINE A PAGE 1', exact: true }).click();
    await page.locator('.content-editor').waitFor();
    const draft = 'DRAFT A 1';
    await page.getByRole('textbox', { name: 'Texto', exact: true }).fill(draft);
    await page.locator('.content-editor[data-preview-state="ready"]').waitFor({ timeout: 60000 });
    await page.locator('.content-box').focus();
    for (const key of ['Control+Tab', 'Control+w', 'Control+z', 'Control+Shift+z', 'Control+y', 'Control+s', 'Control+p', 'Control+o']) {
      await page.keyboard.press(key); await settle(page); await assertDraft(page, draft);
    }
    await disabledPointerClick(page, tab(page, b)); await assertDraft(page, draft);
    await disabledPointerClick(page, page.getByRole('button', { name: `Cerrar ${a.name}`, exact: true })); await assertDraft(page, draft);
    for (const name of ['Abrir PDF', 'Crear PDF', 'Listo']) {
      await disabledPointerClick(page, page.getByRole('button', { name, exact: true })); await assertDraft(page, draft);
    }
    // A supplied file reaches openFiles directly, bypassing the disabled +
    // button; the callback guard must still keep the active source and draft.
    await page.locator('.app-header input[type="file"]').setInputFiles(b.file); await settle(page); await assertDraft(page, draft);
    await page.screenshot({ path: path.join(output, 'inline-editor-draft-guards.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Descartar borrador', exact: true }).click(); await picker(page);
    assert.equal(await tab(page, b).isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: 'Listo', exact: true }).isDisabled(), false);
    await closeEditor(page);
    assert.equal(await page.getByRole('button', { name: 'Editar marcador de esta página', exact: true }).isVisible(), true, 'Global undo must not remove the reader history entry behind a draft.');
    await edit(page); await tab(page, b).click(); await active(page, b);
    assert.equal(await page.locator('.workspace-editor').count(), 0);
    await tab(page, a).click(); await active(page, a);
    assert.equal(await page.getByRole('button', { name: 'Editar marcador de esta página', exact: true }).isVisible(), true);
    return { tabsVisible: true, draftPreserved: true, guardedShortcuts: 8, guardedPointerActions: 5, guardedFileCallback: true, undoHistoryUnchanged: true, discardEnablesTabSwitch: true };
  });
  await check('inline-page-navigation-and-reader-zoom-scroll-restoration', async page => {
    await open(page, b); await tab(page, a).click(); await active(page, a);
    await edit(page);
    await page.getByRole('button', { name: 'Página siguiente del editor', exact: true }).click(); await picker(page, 2);
    await closeEditor(page);
    await page.waitForFunction(() => document.querySelector('input[aria-label="Número de página"]')?.value === '2');
    await page.locator('.pdf-page-wrap[data-page-number="2"] .page-loading').waitFor({ state: 'detached' });
    await page.waitForTimeout(200);
    assert.equal(await pageNumber(page).inputValue(), '2', 'Leaving the editor without applying must keep the intentionally selected page.');
    const page2 = await page.locator('.reading-area').evaluate(reader => {
      const sheet = reader.querySelector('.pdf-page-wrap[data-page-number="2"]'), bounds = reader.getBoundingClientRect(), box = sheet.getBoundingClientRect();
      return { readerTop: bounds.top, pageTop: box.top, readerBottom: bounds.bottom, pageBottom: box.bottom, scrollTop: reader.scrollTop };
    });
    assert(page2.pageTop < page2.readerBottom && page2.pageBottom > page2.readerTop); assert(page2.scrollTop > 0);
    await page.screenshot({ path: path.join(output, 'inline-editor-page-return.png'), animations: 'disabled' });
    await edit(page, 2);
    await page.getByRole('button', { name: 'Volver a Herramientas', exact: true }).click();
    await page.getByRole('button', { name: 'Organizar páginas', exact: true }).click();
    const organizer = page.getByRole('dialog', { name: 'Organizar páginas', exact: true }); await organizer.waitFor();
    await organizer.getByRole('button', { name: 'Cerrar diálogo', exact: true }).click();
    await organizer.waitFor({ state: 'detached' }); await settle(page); await page.waitForTimeout(200);
    assert.equal(await pageNumber(page).inputValue(), '2', 'Opening another tool from the inline editor must restore the selected reading page.');
    await edit(page, 2);
    await page.getByRole('button', { name: 'Volver a Herramientas', exact: true }).click();
    await page.getByRole('button', { name: 'Añadir texto', exact: true }).click();
    await page.locator('.workspace-editor').waitFor({ state: 'detached' }); await settle(page); await page.waitForTimeout(200);
    assert.equal(await pageNumber(page).inputValue(), '2');
    const area = await page.locator('.pdf-page-wrap[data-page-number="2"] .page-content').boundingBox(); assert(area);
    await page.mouse.move(area.x + area.width * .3, area.y + area.height * .4); await page.mouse.down();
    await page.mouse.move(area.x + area.width * .65, area.y + area.height * .6, { steps: 8 }); await page.mouse.up();
    await page.locator('.content-editor[data-kind="add-text"]').waitFor();
    assert.equal(await page.locator('.content-editor canvas[aria-label="Vista previa de la página 2"]').count(), 1, 'Area selection must operate on the restored visible page.');
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await page.locator('.workbench').waitFor({ state: 'detached' }); await page.keyboard.press('Escape'); await settle(page);
    assert.equal(await pageNumber(page).inputValue(), '2');
    await pageNumber(page).fill('1'); await pageNumber(page).press('Enter');
    await page.waitForFunction(() => document.querySelector('input[aria-label="Número de página"]')?.value === '1');
    const positions = [];
    for (const setting of ['150', 'width']) {
      await zoom(page).selectOption(setting); await settle(page);
      await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({ state: 'detached' });
      await page.locator('.reading-area').evaluate(reader => { reader.scrollTop = 143; reader.scrollLeft = 0; });
      await page.waitForTimeout(200);
      assert.equal(await pageNumber(page).inputValue(), '1');
      const before = await page.locator('.reading-area').evaluate(reader => ({ top: reader.scrollTop, left: reader.scrollLeft }));
      assert(before.top > 100);
      await edit(page); await closeEditor(page);
      await page.waitForTimeout(250);
      const after = await page.locator('.reading-area').evaluate(reader => ({ top: reader.scrollTop, left: reader.scrollLeft }));
      assert.equal(await zoom(page).inputValue(), setting); assert.equal(await pageNumber(page).inputValue(), '1');
      assert(Math.abs(after.top - before.top) <= 2, `${setting}: opening and leaving editing changed vertical position ${before.top} → ${after.top}.`);
      assert(Math.abs(after.left - before.left) <= 2);
      await edit(page); await tab(page, b).click(); await active(page, b);
      await tab(page, a).click(); await active(page, a); await page.waitForTimeout(250);
      const afterTabs = await page.locator('.reading-area').evaluate(reader => ({ top: reader.scrollTop, left: reader.scrollLeft }));
      assert.equal(await zoom(page).inputValue(), setting); assert.equal(await pageNumber(page).inputValue(), '1');
      assert(Math.abs(afterTabs.top - before.top) <= 2, `${setting}: switching tabs from the selector changed vertical position ${before.top} → ${afterTabs.top}.`);
      assert(Math.abs(afterTabs.left - before.left) <= 2);
      positions.push({ zoom: setting, before, after, afterTabs });
    }
    return { selectedPageKeptWithoutApply: true, page2, otherToolKeepsPage: true, areaToolUsesVisiblePage: true, readerZoomAndScrollRestored: true, positions };
  });
} finally {
  await browser?.close();
  if (server.exitCode === null) { server.kill(); await new Promise(resolve => { server.once('exit', resolve); if (server.exitCode !== null) resolve(); }); }
  fs.writeFileSync(path.join(output, 'inline-editor-integration-results.json'), JSON.stringify({ date: new Date().toISOString(), frontendEntry, results, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}
