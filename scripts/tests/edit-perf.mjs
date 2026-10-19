// Time per change in Editar on a large PDF: from releasing the mouse after
// moving a paragraph until the page shows the result, with nothing pending; and
// from the start of the drag until the paragraph's sprite follows the pointer.
// Run after a build:  node scripts/tests/edit-perf.mjs
//   FOLIO_EDIT_PERF_PAGES=600 (default, ~250 MB)  FOLIO_EDIT_PERF_MOVES=4
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as mupdf from 'mupdf';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';

const root = process.cwd(),
  output = path.join(root, 'test-results', 'edit-perf');
fs.mkdirSync(output, { recursive: true });
const textPdf = path.join(root, '.fixtures', 'emacs-manual.pdf');
if (!fs.existsSync(textPdf)) throw new Error('Run npm run test:fixtures first (emacs-manual.pdf).');

// A textbook-like file: a distinct scan per page and two lines of text over it,
// written directly (no library holds it in memory).
const pages = Number(process.env.FOLIO_EDIT_PERF_PAGES || 600),
  book = path.join(output, `book-${pages}-v2.pdf`);
if (!fs.existsSync(book)) {
  const source = mupdf.Document.openDocument(fs.readFileSync(textPdf), 'application/pdf');
  const scans = Array.from({ length: 8 }, (_, i) =>
    source.loadPage(30 + i * 40).toPixmap(mupdf.Matrix.scale(2.8, 2.8), mupdf.ColorSpace.DeviceRGB, false),
  );
  // The size the PDF declares must be the JPEG's own: MuPDF draws a mismatch black.
  const jpegs = scans.map(scan => Buffer.from(scan.asJPEG(75))),
    size = scans.map(scan => [scan.getWidth(), scan.getHeight()]);
  const fd = fs.openSync(book, 'w'),
    offsets = [];
  let at = 0;
  const put = data => {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    fs.writeSync(fd, b);
    at += b.length;
  };
  const obj = (n, body, stream) => {
    offsets[n] = at;
    put(`${n} 0 obj\n${body}\n`);
    if (stream) {
      put('stream\n');
      put(stream);
      put('\nendstream');
    }
    put('\nendobj\n');
  };
  put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(
    2,
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 3} 0 R`).join(' ')}] >>`,
  );
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages; i++) {
    const comment = Buffer.from(`page ${i + 1}`),
      unique = Buffer.concat([
        jpegs[i % jpegs.length].subarray(0, 2),
        Buffer.from([0xff, 0xfe, 0, comment.length + 2]),
        comment,
        jpegs[i % jpegs.length].subarray(2),
      ]);
    const n = 4 + i * 3,
      j = i % jpegs.length;
    // The scan sits in the lower part; the paragraph above it on white.
    const text = `q 512 0 0 560 50 40 cm /Im Do Q BT /F 14 Tf 60 720 Td 18 TL (Insuficiencia cardiaca: capitulo ${Math.floor(i / 40) + 1}, pagina ${i + 1}.) Tj T* (El tratamiento combina diureticos y vasodilatadores.) Tj ET`;
    obj(
      n,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F 3 0 R >> /XObject << /Im ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`,
    );
    obj(n + 1, `<< /Length ${text.length} >>`, text);
    obj(
      n + 2,
      `<< /Type /XObject /Subtype /Image /Width ${size[j][0]} /Height ${size[j][1]} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${unique.length} >>`,
      unique,
    );
  }
  const xref = at,
    count = 4 + pages * 3;
  put(
    `xref\n0 ${count}\n0000000000 65535 f \n${Array.from({ length: count - 1 }, (_, i) => `${String(offsets[i + 1]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
  fs.closeSync(fd);
}

const moves = Number(process.env.FOLIO_EDIT_PERF_MOVES || 4),
  port = process.env.FOLIO_EDIT_PERF_PORT || '4261',
  origin = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'],
  { cwd: root, stdio: 'pipe', windowsHide: true },
);
const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  // No library copy, like the desktop app reopening the file itself.
  await context.addInitScript(() => localStorage.setItem('folio.remember', 'false'));
  const page = await context.newPage();
  page.setDefaultTimeout(300000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  let started = Date.now();
  await page.locator('input[type=file][accept="application/pdf,.pdf"]').first().setInputFiles(book);
  await page.locator('.pdf-page-wrap[data-page-number="1"] canvas[data-rendering="false"]').waitFor();
  const openMs = Date.now() - started;
  // Entering Editar: from the click until the paragraph under the pointer can be picked.
  const pageBox = () => page.locator('.pdf-page-wrap[data-page-number="1"] .page-content').boundingBox();
  const enter = async () => {
    const begun = Date.now();
    await page.getByRole('button', { name: 'Editar contenido del PDF' }).click();
    await page.locator('.edit-toolbar').waitFor();
    const shown = await pageBox(),
      scale = shown.width / 612;
    await page.mouse.move(shown.x + 150 * scale, shown.y + 72 * scale);
    await page.locator('.edit-layer[data-edit-page="1"][data-edit-state=ready]').waitFor();
    return Date.now() - begun;
  };
  const enterMs = [await enter()],
    box = await pageBox(),
    k = box.width / 612;
  const settle = () =>
    page.waitForFunction(
      () =>
        !document.querySelector('.edit-toolbar[data-committing=true]') &&
        !document.querySelector('.edit-snapshot') &&
        !document.querySelector('.edit-ghost') &&
        [...document.querySelectorAll('.pdf-page-wrap canvas:not(.page-detail)')].every(
          canvas => canvas.dataset.rendering !== 'true',
        ),
    );
  const times = [],
    sprites = [];
  let x = 150,
    y = 72;
  for (let i = 0; i < moves; i++) {
    const at = { x: box.x + x * k, y: box.y + y * k };
    await page.mouse.move(at.x, at.y);
    await page.locator('.edit-layer[data-edit-page="1"][data-edit-state=ready]').waitFor();
    await page.mouse.move(at.x + 1, at.y);
    await page.locator('.edit-hover').waitFor();
    // The paragraph alone (its sprite) follows the pointer from the start of the drag
    // (null in a build without sprites). Moves go right, clear of the scan below.
    await page.mouse.down();
    let drag = Date.now();
    await page.mouse.move(at.x + 10 * k, at.y, { steps: 4 });
    sprites.push(
      await page
        .locator('.edit-sprite')
        .waitFor({ timeout: 2000 })
        .then(
          () => Date.now() - drag,
          () => null,
        ),
    );
    await page.mouse.move(at.x + 20 * k, at.y, { steps: 4 });
    started = Date.now();
    await page.mouse.up();
    await settle();
    // The moved paragraph is selected again: the change is done.
    await page.locator('.edit-selection.kind-text').waitFor();
    times.push(Date.now() - started);
    x += 20;
    await page.mouse.click(box.x + 20, box.y + 20);
    await page.locator('.edit-selection').waitFor({ state: 'detached' });
  }
  // Two items at once (the paragraph and the scan below it), dragged together as one change.
  const words = { x: box.x + (x + 10) * k, y: box.y + y * k },
    scan = { x: box.x + 300 * k, y: box.y + 500 * k };
  await page.mouse.move(words.x, words.y);
  await page.locator('.edit-hover').waitFor();
  await page.mouse.click(words.x, words.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(scan.x, scan.y);
  await page.keyboard.up('Shift');
  // null in a build without selecting several.
  let groupMs = null;
  if (
    await page
      .getByText('2 elementos')
      .waitFor({ timeout: 3000 })
      .then(
        () => true,
        () => false,
      )
  ) {
    await page.mouse.move(scan.x, scan.y);
    await page.mouse.down();
    await page.mouse.move(scan.x + 10 * k, scan.y + 10 * k, { steps: 4 });
    started = Date.now();
    await page.mouse.up();
    await settle();
    await page.getByText('2 elementos').waitFor();
    groupMs = Date.now() - started;
  }
  await page.mouse.click(box.x + 20, box.y + 20);
  // Leaving Editar writes the PDF once and the reader opens it: from Listo (or an
  // undo outside Editar) until the header works again. 0 when nothing was pending.
  const busy = () =>
    page.evaluate(
      () =>
        new Promise(resolve => {
          const started = performance.now();
          let seen = false;
          const check = () => {
            const disabled = document.querySelector('[aria-label="Modo lectura"]')?.disabled;
            seen ||= disabled;
            if ((seen && !disabled) || (!seen && performance.now() - started > 5000))
              resolve(seen ? Math.round(performance.now() - started) : 0);
            else requestAnimationFrame(check);
          };
          check();
        }),
    );
  let leaving = busy();
  await page.getByRole('button', { name: 'Listo' }).click();
  const leaveMs = await leaving;
  await settle();
  // Again into Editar (the live document stayed open) and out, then the last move undone outside Editar.
  enterMs.push(await enter());
  leaving = busy();
  await page.getByRole('button', { name: 'Listo' }).click();
  await leaving;
  await settle();
  leaving = busy();
  await page.keyboard.press('Control+z');
  const undoMs = await leaving;
  await settle();
  const sorted = [...times].sort((a, b) => a - b);
  const report = {
    pages,
    sizeMB: Math.round(fs.statSync(book).size / 1048576),
    openMs,
    moveMs: times,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    spriteMs: sprites,
    groupMs,
    leaveMs,
    enterMs,
    undoMs,
    errors,
  };
  console.log(JSON.stringify(report));
  fs.writeFileSync(
    path.join(output, `report-${process.env.FOLIO_EDIT_PERF_LABEL || 'run'}.json`),
    JSON.stringify(report, null, 2),
  );
} catch (error) {
  await browser
    .contexts()[0]
    ?.pages()[0]
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
  server.kill();
}
