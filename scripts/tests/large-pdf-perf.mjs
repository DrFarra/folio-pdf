// Measures how the reader feels with large PDFs: time to the first page, blank
// pages and long frames while scrolling, and a far jump. Run after a build:
//   node scripts/tests/large-pdf-perf.mjs   (FOLIO_PERF_CPU=4 throttles like a phone)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import * as mupdf from 'mupdf';
import { PDFDocument } from 'pdf-lib';
import { chromium, webkit } from 'playwright-core';
import { findChrome } from './browser.mjs';

const root = process.cwd(), output = path.join(root, 'test-results', 'large-pdf-perf');
fs.mkdirSync(output, { recursive: true });
const textPdf = path.join(root, '.fixtures', 'emacs-manual.pdf');
if (!fs.existsSync(textPdf)) throw new Error('Run npm run test:fixtures first (emacs-manual.pdf).');

// 120 scanned-like pages, each with its own ~2500 px JPEG.
const scanPdf = path.join(output, 'scans.pdf');
if (!fs.existsSync(scanPdf)) {
  const source = mupdf.Document.openDocument(fs.readFileSync(textPdf), 'application/pdf'), out = await PDFDocument.create();
  const jpegs = Array.from({ length: 6 }, (_, i) => source.loadPage(40 + i * 30).toPixmap(mupdf.Matrix.scale(4, 4), mupdf.ColorSpace.DeviceRGB, false).asJPEG(80));
  for (let i = 0; i < 120; i++) { const image = await out.embedJpg(jpegs[i % jpegs.length]), page = out.addPage([612, 792]); page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 }); }
  fs.writeFileSync(scanPdf, await out.save());
}

// FOLIO_PERF_HUGE=1 adds a ~1 GB, 3000-page textbook-like file (a scan and a
// line of text per page), written directly so no library holds it in memory.
const hugePdf = path.join(output, 'huge.pdf');
if (process.env.FOLIO_PERF_HUGE && !fs.existsSync(hugePdf)) {
  const source = mupdf.Document.openDocument(fs.readFileSync(textPdf), 'application/pdf');
  const jpegs = Array.from({ length: 8 }, (_, i) => Buffer.from(source.loadPage(30 + i * 40).toPixmap(mupdf.Matrix.scale(2.8, 2.8), mupdf.ColorSpace.DeviceRGB, false).asJPEG(75)));
  const size = jpegs.map(j => [j.readUInt16BE(j.indexOf(Buffer.from([0xff, 0xc0])) + 7), j.readUInt16BE(j.indexOf(Buffer.from([0xff, 0xc0])) + 5)]);
  const pages = 3000, fd = fs.openSync(hugePdf, 'w'), offsets = [];
  let at = 0; const put = data => { const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1'); fs.writeSync(fd, b); at += b.length; };
  const obj = (n, body, stream) => { offsets[n] = at; put(`${n} 0 obj\n${body}\n`); if (stream) { put('stream\n'); put(stream); put('\nendstream'); } put('\nendobj\n'); };
  put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 3} 0 R`).join(' ')}] >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages; i++) {
    // A JPEG comment makes every page's image distinct, as in a real book, so
    // MuPDF cannot merge them when it rewrites the file.
    const comment = Buffer.from(`page ${i + 1}`), unique = Buffer.concat([jpegs[i % jpegs.length].subarray(0, 2), Buffer.from([0xff, 0xfe, 0, comment.length + 2]), comment, jpegs[i % jpegs.length].subarray(2)]);
    const n = 4 + i * 3, j = i % jpegs.length, text = `q 612 0 0 792 0 0 cm /Im Do Q BT /F 9 Tf 40 20 Td (Capitulo ${Math.floor(i / 40) + 1} pagina ${i + 1} insuficiencia cardiaca) Tj ET`;
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F 3 0 R >> /XObject << /Im ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${text.length} >>`, text);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${size[j][0]} /Height ${size[j][1]} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${unique.length} >>`, unique);
  }
  const xref = at, count = 4 + pages * 3;
  put(`xref\n0 ${count}\n0000000000 65535 f \n${Array.from({ length: count - 1 }, (_, i) => `${String(offsets[i + 1]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  fs.closeSync(fd);
}

const cpu = Number(process.env.FOLIO_PERF_CPU || 1), port = process.env.FOLIO_PERF_PORT || '4231', origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', ...(process.env.FOLIO_PERF_DIST ? ['--outDir', process.env.FOLIO_PERF_DIST] : []), '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let browser;
const report = {};
try {
  for (let attempt = 0; attempt < 120; attempt++) { try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const engine = process.env.FOLIO_PERF_BROWSER === 'webkit' ? 'webkit' : 'chromium';
  browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch({ executablePath: findChrome(), headless: true });
  const documents = [['text-804p', textPdf, 600], ['scans-120p', scanPdf, 90], ...(process.env.FOLIO_PERF_HUGE ? [['huge-3000p', hugePdf, 2500]] : [])];
  for (const [name, file, jump] of documents.filter(([name]) => !process.env.FOLIO_PERF_ONLY || process.env.FOLIO_PERF_ONLY.split(',').includes(name))) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // FOLIO_PERF_NOLIB=1 keeps no library copy, like the desktop apps that reopen the file itself.
    if (process.env.FOLIO_PERF_NOLIB) await context.addInitScript(() => localStorage.setItem('folio.remember', 'false'));
    // FOLIO_PERF_THUMBS=1 opens the page thumbnails panel next to the reader.
    if (process.env.FOLIO_PERF_THUMBS) await context.addInitScript(() => localStorage.setItem('folio.readingPreferences', JSON.stringify({ initialPanel: 'pages' })));
    const page = await context.newPage(); page.setDefaultTimeout(120000);
    const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null;
    if (cdp && cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Biblioteca', exact: true }).waitFor();
    // Peak memory of every browser process (renderer, GPU, workers), sampled each second.
    let peak = 0, sampling = true; const browserCdp = engine === 'chromium' ? await browser.newBrowserCDPSession() : null;
    const sample = async () => { while (sampling) {
      const { processInfo } = browserCdp ? await browserCdp.send('SystemInfo.getProcessInfo').catch(() => ({ processInfo: [] })) : { processInfo: [] };
      const ids = processInfo.map(p => p.id).join(','), query = browserCdp ? `-Id ${ids}` : '-Name WebKitWebProcess,WebKitNetworkProcess,Playwright';
      if (process.platform === 'win32' && (ids || !browserCdp)) await new Promise(resolve => execFile('powershell', ['-NoProfile', '-Command', `(Get-Process ${query} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum`], (_, out) => { peak = Math.max(peak, Number(out) || 0); if (process.env.FOLIO_PERF_TRACE) console.log(`  ${Date.now() - started}ms ${Math.round((Number(out) || 0) / 1048576)}MB`); resolve(); }));
      await new Promise(resolve => setTimeout(resolve, 250));
    } }; let started = Date.now(); const sampler = sample();
    await page.locator('input[type=file][accept="application/pdf,.pdf"]').setInputFiles(file);
    const opened = await page.waitForFunction(() => document.querySelector('.pdf-page-wrap[data-page-number="1"] canvas[data-rendering="false"]') ? 'ok' : document.querySelector('[role=alert]')?.textContent, null, { timeout: 600000 });
    const open = Date.now() - started; if (process.env.FOLIO_PERF_TRACE) console.log(`  opened at ${open}ms`); const outcome = await opened.jsonValue();
    if (outcome !== 'ok') { sampling = false; await sampler; report[name] = { cpu, peakMB: Math.round(peak / 1048576), openMs: open, failed: outcome }; console.log(name, JSON.stringify(report[name])); await context.close(); continue; }
    // Scroll at a steady reading-fling speed right away, while the app is still
    // indexing: count frames whose centre page has no pixels yet and long frames.
    // FOLIO_PERF_TIMELINE=1 sums the browser's own work (style, layout, paint) while scrolling.
    const timeline = [];
    if (cdp && process.env.FOLIO_PERF_TIMELINE) { cdp.on('Tracing.dataCollected', ({ value }) => timeline.push(...value)); await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' }); }
    if (cdp && process.env.FOLIO_PERF_PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
    const scroll = await page.evaluate(async () => {
      const reader = document.querySelector('.reading-area'), frames = [], blanks = [];
      const wraps = [...reader.querySelectorAll('.pdf-page-wrap')], origin = reader.getBoundingClientRect().top - reader.scrollTop, tops = wraps.map(wrap => wrap.getBoundingClientRect().top - origin);
      let longTasks = 0; const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks += entry.duration; });
      observer.observe({ type: 'longtask', buffered: false });
      const speed = 2.5; // px per ms, about three pages per second
      let last = performance.now(); const end = last + 6000;
      await new Promise(resolve => { const step = now => {
        frames.push(now - last); reader.scrollTop += speed * (now - last); last = now;
        // Every 4th frame, find the centre page by binary search over the cached
        // page offsets (a hit test over thousands of nodes would distort the result).
        if (frames.length % 4 === 0) {
          const centre = reader.scrollTop + reader.clientHeight / 2; let low = 0, high = tops.length - 1;
          while (low < high) { const mid = (low + high + 1) >> 1; if (tops[mid] <= centre) low = mid; else high = mid - 1; }
          blanks.push(!(wraps[low]?.querySelector('canvas')?.width > 0));
        }
        if (now < end) requestAnimationFrame(step); else resolve();
      }; requestAnimationFrame(step); });
      observer.disconnect();
      const sorted = [...frames].sort((a, b) => a - b);
      return { frames: frames.length, p95: Math.round(sorted[Math.floor(sorted.length * .95)]), max: Math.round(sorted.at(-1)), over50: frames.filter(f => f > 50).length, blankPct: Math.round(blanks.filter(Boolean).length / blanks.length * 100), longTaskMs: Math.round(longTasks) };
    });
    if (cdp && process.env.FOLIO_PERF_TIMELINE) {
      await new Promise(resolve => { cdp.once('Tracing.tracingComplete', resolve); void cdp.send('Tracing.end'); });
      const totals = {}; for (const event of timeline) if (event.ph === 'X' && event.dur) totals[event.name] = (totals[event.name] || 0) + event.dur / 1000;
      console.log(Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([name, ms]) => `${Math.round(ms)}ms ${name}`).join(String.fromCharCode(10)));
    }
    if (cdp && process.env.FOLIO_PERF_PROFILE) fs.writeFileSync(path.join(output, `${name}-cpu${cpu}.cpuprofile`), JSON.stringify((await cdp.send('Profiler.stop')).profile));
    // Jump far through the page field, then wait for that page's pixels.
    const jumpStart = Date.now();
    await page.getByLabel('Número de página').fill(String(jump)); await page.getByLabel('Número de página').press('Enter');
    await page.waitForFunction(number => document.querySelector(`.pdf-page-wrap[data-page-number="${number}"] canvas[data-rendering="false"]`), jump);
    const jumped = Date.now() - jumpStart;
    const memory = await cdp?.send('Runtime.getHeapUsage').catch(() => null);
    sampling = false; await sampler;
    report[name] = { cpu, peakMB: Math.round(peak / 1048576), openMs: open, jumpMs: jumped, ...scroll, heapMB: memory ? Math.round(memory.usedSize / 1048576) : null, domNodes: await page.evaluate(() => document.getElementsByTagName('*').length) };
    console.log(name, JSON.stringify(report[name]));
    await context.close();
  }
  fs.writeFileSync(path.join(output, `report-cpu${cpu}.json`), JSON.stringify(report, null, 2));
} finally { await browser?.close(); server.kill(); }
