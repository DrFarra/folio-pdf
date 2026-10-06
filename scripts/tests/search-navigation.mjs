import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { build } from 'vite';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { chromium } from 'playwright-core';
import { findChrome } from './browser.mjs';

// Real PDF.js extraction/DOM and reader interactions; PDFKit IPC is mocked
// explicitly to check only the adapter contract, not native device behavior.
const output = 'test-results/iphone'; fs.mkdirSync(output, { recursive: true });
const harnessPath = `${output}/search-navigation-harness.tsx`;
const htmlPath = `${output}/search-navigation.html`;
const previewDirectory = path.resolve('.tools', `search-navigation-preview-${process.pid}`);
fs.writeFileSync(harnessPath, `import React from 'react';
import { createRoot } from 'react-dom/client';
import PDFPage, { Thumbnail } from '../../src/components/PDFPage';
import * as pdf from '../../src/pdf';
import * as pdfPage from '../../src/components/PDFPage';
import * as nativePdf from '../../src/nativePdf';
import '../../src/styles.css';
import '../../src/components/PDFPage.css';
export function mount(node, props) { const root = createRoot(node); const update = props => root.render(<PDFPage {...props}/>); update(props); return { update, unmount: () => root.unmount() }; }
export function mountThumbnails(node, pdf, selected) { const root = createRoot(node); const update = selected => root.render(<div style={{overflowY:'auto',height:180}} data-thumbnail-grid>{Array.from({length:30},(_,i)=><Thumbnail key={i} pdf={pdf} number={i+1} selected={selected===i+1} onClick={()=>{}}/>)}</div>); update(selected); return { update, unmount: () => root.unmount() }; }
globalThis.__searchFixtureModules = { pdf, pdfPage, nativePdf, mount, mountThumbnails };
`);
fs.writeFileSync(htmlPath, '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="./search-navigation-harness.tsx"></script></body></html>');
await build({ logLevel:'error', publicDir:false, build:{outDir:previewDirectory,emptyOutDir:true,rollupOptions:{input:path.resolve(htmlPath)}} });
const fixture = await PDFDocument.create(), regular = await fixture.embedFont(StandardFonts.Helvetica), bold = await fixture.embedFont(StandardFonts.HelveticaBold);
const pages = Array.from({ length: 30 }, () => fixture.addPage([420, 760])), first = pages[0];
first.drawText('café', { x: 45, y: 700, size: 18, font: regular });
first.drawText('inter', { x: 45, y: 650, size: 18, font: regular });
first.drawText('faz', { x: 45 + regular.widthOfTextAtSize('inter', 18), y: 650, size: 18, font: bold });
first.drawText('parte', { x: 45, y: 600, size: 18, font: regular });
first.drawText('segunda', { x: 45, y: 575, size: 18, font: regular });
first.drawText('interfaz', { x: 45, y: 500, size: 18, font: regular });
first.drawText('interfaz', { x: 45, y: 150, size: 18, font: regular });
pages[1].drawText('Segunda página', { x: 45, y: 650, size: 18, font: regular });
pages[2].drawText('Destino interno', { x: 45, y: 400, size: 18, font: regular });
const link = (rect, action) => fixture.context.register(fixture.context.obj({ Type: PDFName.of('Annot'), Subtype: PDFName.of('Link'), Rect: rect, Border: [0, 0, 0], A: action }));
first.node.set(PDFName.of('Annots'), fixture.context.obj([
  link([44, 645, 125, 670], { S: PDFName.of('GoTo'), D: [pages[2].ref, PDFName.of('XYZ'), 20, 400, null] }),
  link([44, 495, 125, 520], { S: PDFName.of('URI'), URI: PDFString.of('https://example.com/reference') }),
  link([44, 145, 125, 170], { S: PDFName.of('URI'), URI: PDFString.of('javascript:alert(1)') }),
]));
fixture.catalog.set(PDFName.of('PageLabels'), fixture.context.obj({ Nums: [0, { S: PDFName.of('r') }, 2, { S: PDFName.of('D'), St: 1 }] }));
fixture.catalog.set(PDFName.of('Dests'), fixture.context.obj({ Chapter: [pages[2].ref, PDFName.of('XYZ'), 10, 300, null] }));
const outlineRoot = fixture.context.register(fixture.context.obj({ Type: PDFName.of('Outlines'), Count: 2 }));
const outlineParent = fixture.context.register(fixture.context.obj({ Title: PDFString.of('Parte sin destino'), Parent: outlineRoot, Count: 1 }));
const outlineChild = fixture.context.register(fixture.context.obj({ Title: PDFString.of('Capítulo'), Parent: outlineParent, Dest: [pages[2].ref, PDFName.of('Fit')] }));
for (const ref of [outlineRoot, outlineParent]) { fixture.context.lookup(ref).set(PDFName.of('First'), ref === outlineRoot ? outlineParent : outlineChild); fixture.context.lookup(ref).set(PDFName.of('Last'), ref === outlineRoot ? outlineParent : outlineChild); }
fixture.catalog.set(PDFName.of('Outlines'), outlineRoot);
const bytes = [...await fixture.save()];
const chrome = findChrome();
assert(chrome, 'CHROME_PATH must identify installed Chrome or Edge.');
const port = process.env.FOLIO_SEARCH_TEST_PORT || '4205', origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', previewDirectory, '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: 'pipe', windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
let log = '', browser;
server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(log || 'Fixture server exited.');
    try { if (stripVTControlCharacters(log).includes(origin) && (await fetch(`${origin}/${htmlPath}`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, log || 'Fixture server did not start.');
  browser = await chromium.launch({ executablePath: chrome });
  const page = await browser.newPage({ viewport: { width: 550, height: 700 } });
  await page.goto(`${origin}/${htmlPath}`);
  await page.waitForFunction(() => !!window.__searchFixtureModules);
  const report = await page.evaluate(async fixtureBytes => {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const { pdf:pdfModule, pdfPage, nativePdf, mount, mountThumbnails } = window.__searchFixtureModules;
    const { getDocument, pageText, pageTextModel, searchText, findTextMatches, readPageLabels, readPageLabel, readOutline, resolvePDFDestination, safePDFLink } = pdfModule;
    const { markSearch } = pdfPage;
    const { openNativePdf, nativePdfPageAnnotations, subscribeNativePdfAnnotations } = nativePdf;
    const pdf = await getDocument({ data: new Uint8Array(fixtureBytes) }).promise;
    const source = await (await pdf.getPage(1)).getTextContent(), model = pageTextModel(source);
    const occurrences = searchText([model.text], 'interfaz').results;
    check(occurrences.length === 3 && occurrences.every((result, index) => result.count === 1 && result.index === index && model.text.slice(result.offset, result.offset + 8) === 'interfaz'), 'each occurrence needs a distinct original offset');
    check(searchText(['😀 cafe\u0301 interfaz interfaz'], 'interfaz').results[0].offset === '😀 cafe\u0301 interfaz interfaz'.indexOf('interfaz'), 'UTF-16 offsets after combining accents/emoji');
    check(findTextMatches('cafe\u0301 café CAFÉ', 'cafe').map(match => 'cafe\u0301 café CAFÉ'.slice(match.start, match.end)).join('|') === 'cafe\u0301|café|CAFÉ', 'accent-insensitive matches include original combining marks');
    check(findTextMatches('parte\t\n segunda', 'parte segunda').length === 1 && searchText([model.text], 'parte segunda').results.length === 1, 'multi-line/whitespace phrase matching');
    check(searchText([model.text], '   ').total === 0, 'empty query');
    check(findTextMatches('INTERFAZ Interfaz interfaz', 'interfaz').length === 3, 'ASCII case folding');
    const capped = searchText([model.text, model.text], 'interfaz', 4);
    check(capped.total === 6 && capped.results.map(result => `${result.page}:${result.index}`).join() === '1:0,1:1,1:2,2:3', 'every occurrence is counted but only the first results are built');
    check(JSON.stringify((await readPageLabels(pdf)).slice(0,3)) === JSON.stringify(['i', 'ii', '1']), 'actual PDF page labels');
    check(JSON.stringify(await readOutline(pdf)) === JSON.stringify([{title:'Parte sin destino',page:null,depth:0},{title:'Capítulo',page:3,depth:1}]), 'PDF.js preserves outline container headings');
    check(await readOutline(pdf) === await readOutline(pdf), 'the outline is read once per document');
    check(await readPageLabel(pdf, 3) === '1', 'page labels differ from physical positions');
    const internal = await resolvePDFDestination(pdf, [await pdf.getPage(3).then(page => page.ref), { name: 'XYZ' }, 20, 400, null]);
    check(internal?.page === 3 && internal.left === 20 && internal.top === 400, 'indirect internal destination with position');
    check(await resolvePDFDestination(pdf, [50, { name: 'Fit' }]) === null, 'out-of-range destination');
    const named = await resolvePDFDestination(pdf, 'Chapter');
    check(named?.page === 3 && named.left === 10 && named.top === 300, 'named destination');
    check(safePDFLink('javascript:alert(1)') === null && safePDFLink('file:///private/document.pdf') === null && safePDFLink('mailto:reader@example.com') !== null, 'only supported external URL schemes');
    const container = document.createElement('div'); container.dataset.searchText = model.text;
    for (const segment of model.segments) { const span = document.createElement('span'); span.dataset.original = segment.text; span.dataset.searchStart = String(segment.start); span.textContent = segment.text; container.append(span); }
    document.body.replaceChildren(container);
    markSearch(container, 'interfaz', occurrences[0].offset);
    check(container.querySelectorAll(`mark[data-search-offset="${occurrences[0].offset}"]`).length >= 2, 'a word split across font spans gets one shared occurrence');
    check(container.querySelectorAll('mark[data-search-active=true]').length >= 2, 'all fragments of active occurrence');
    const text = container.querySelector('mark').firstChild, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.length);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); const selected = selection.toString();
    markSearch(container, 'interfaz', occurrences[1].offset);
    check(selection.toString() === selected && container.querySelectorAll('mark[data-search-active=true]').length === 1, 'active navigation preserves an existing Selection');
    selection.removeAllRanges(); markSearch(container, '', undefined);
    check(!container.querySelector('mark') && [...container.children].map(span => span.textContent).join('') === model.segments.map(segment => segment.text).join(''), 'clearing search restores all original text');
    const info = { view: [0,0,420,760], rotation: 0, label: 'iv', annotations: [{ id:'source', page:1, kind:'note', rect:[10,10,10,10], color:'#f5d164', text:'source', created:0 }], links:[{rect:[44,645,125,670],page:3,left:20,top:400},{rect:[44,495,125,520],url:'https://example.com/reference'},{rect:[44,145,125,170],page:99}] };
    const calls = [], listeners = [];
    const { pdf: native } = await openNativePdf({token:'mock',name:'native.pdf',size:100},undefined,undefined,{bridge:async(command,args)=>{calls.push({command,args}); if(command==='native_pdf_open') return {id:'mock',revision:'1',size:100,numPages:3,locked:false,signed:false,permissions:{canCopy:true,canPrint:true,canAnnotate:true,canEdit:true,canAssemble:true,canFill:true},firstPage:{page:1,...info}}; if(command==='native_pdf_page_info')return info;if(command==='native_pdf_outline')return [{title:'Parte',page:null,depth:0},{title:'Capítulo',page:3,depth:1}];if(command==='native_pdf_close')return null;throw new Error(command);}});
    const unsub = subscribeNativePdfAnnotations(native, (_page, annotations) => listeners.push(annotations));
    const nativePage = await native.getPage(1), nativeAnnotations = await nativePage.getAnnotations();
    check(nativePage.label === 'iv' && await readPageLabel(native,1) === 'iv' && await readPageLabels(native) === null, 'native label stays lazy per page');
    check(nativeAnnotations.filter(annotation=>annotation.subtype==='Link').length === 2 && listeners.every(annotations=>annotations.length===1) && (await nativePdfPageAnnotations(native,1)).length===1, 'links never contaminate migration/annotation subscribers');
    check(calls.filter(call=>call.command==='native_pdf_page_info').length===1, 'labels never eagerly inspect the entire document');
    check(JSON.stringify(await readOutline(native))===JSON.stringify([{title:'Parte',page:null,depth:0},{title:'Capítulo',page:3,depth:1}]),'native outline preserves container headings');
    unsub(); await native.destroy();
    document.body.innerHTML = '<div id="viewer" style="height:230px;width:480px;overflow:auto;position:relative"><div id="mount"></div></div>';
    const viewer = document.getElementById('viewer'), props={pdf,number:1,scale:1,rotation:0,dimensions:{width:420,height:760,rotation:0},annotations:[],tool:'select',color:'#f5d164',query:'interfaz',activeSearch:occurrences[2],canCopy:true,canAnnotate:true,onAnnotate:()=>{},onNoteClick:()=>{},onRemoveAnnotation:()=>{},onArea:()=>{},redactions:[],onNavigate:destination=>window.__destinations.push(destination)};
    window.__destinations=[]; window.__readerInteractions=0; window.addEventListener('folio:reader-interaction',()=>window.__readerInteractions++); window.__searchHarness=mount(document.getElementById('mount'),props); window.__searchProps=props;
    window.__thumbnailMount=mountThumbnails;
    window.__searchPdf=pdf;
    return { occurrences, sourceText:model.text, labels:await readPageLabels(pdf), nativeContract:true };
  }, bytes);
  await page.locator('canvas[data-rendering=false]').waitFor();
  await page.waitForFunction(() => document.querySelector('#viewer').scrollTop > 300);
  assert.equal(await page.locator('.textLayer mark[data-search-active=true]').count(), 1);
  assert.equal(await page.locator('.pdf-document-link').count(), 2, 'unsafe URI never becomes a clickable link');
  await page.evaluate(()=>{document.getElementById('viewer').scrollTop=0;window.dispatchEvent(new CustomEvent('folio:reveal-search-result',{detail:window.__searchProps.activeSearch}));});
  await page.waitForFunction(()=>document.querySelector('#viewer').scrollTop>300);
  await page.evaluate(() => window.__searchHarness.update({...window.__searchProps,query:'',activeSearch:null}));
  await page.evaluate(() => document.getElementById('viewer').scrollTop=0);
  const firstText = page.locator('.textLayer span').filter({hasText:/^inter$/});
  const linkBox = await firstText.boundingBox(); assert(linkBox, 'fragmented link text');
  await page.mouse.click(linkBox.x+linkBox.width/2,linkBox.y+linkBox.height/2);
  assert.deepEqual(await page.evaluate(()=>window.__destinations[0]), {page:3,left:20,top:400});
  assert.equal(await page.evaluate(()=>window.__readerInteractions),1,'tapping an internal link cancels the pending reader gesture');
  const secondText = page.locator('.textLayer span').filter({hasText:/^faz$/}), endBox=await secondText.boundingBox();
  await page.mouse.move(linkBox.x+2,linkBox.y+linkBox.height/2); await page.mouse.down(); await page.mouse.move(endBox.x+endBox.width-2,endBox.y+endBox.height/2,{steps:15}); await page.mouse.up();
  const selectedLink = await page.evaluate(()=>window.getSelection().toString());
  assert(selectedLink.length >= 5 && 'interfaz'.includes(selectedLink), `link text can be dragged and selected: ${JSON.stringify(selectedLink)}`);
  assert.equal(await page.evaluate(()=>window.__destinations.length), 1, 'selecting link text does not navigate');
  await page.evaluate(()=>window.getSelection().removeAllRanges());
  await page.locator('.pdf-document-link').nth(1).focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.__destinations.at(-1).url), 'https://example.com/reference', 'keyboard link access');
  assert.equal(await page.evaluate(()=>window.__readerInteractions),2,'keyboard external links notify the reader as well');
  await page.evaluate(()=>{window.__searchHarness.unmount();document.body.innerHTML='<div id="thumbnails"></div>';window.__thumb=window.__thumbnailMount(document.getElementById('thumbnails'),window.__searchPdf,25);});
  await page.waitForFunction(()=>document.querySelector('[data-thumbnail-grid]')?.scrollTop>100);
  const thumbScroll=await page.locator('[data-thumbnail-grid]').evaluate(grid=>grid.scrollTop);
  await page.evaluate(()=>window.__thumb.update(25));
  assert.equal(await page.locator('[data-thumbnail-grid]').evaluate(grid=>grid.scrollTop),thumbScroll,'same selected thumbnail does not continually force scrolling');
  await page.evaluate(async()=>{window.__thumb.unmount();await window.__searchPdf.loadingTask.destroy();});
  fs.writeFileSync(`${output}/search-navigation-report.json`, JSON.stringify({...report,actualReaderLinks:true,linkTextSelection:true,activeOccurrenceScroll:true,thumbnailScroll:true},null,2));
  console.log('Search/navigation passed: individual UTF-16 occurrences, accents, cross-span and multi-line matches, labels, native adapter, active reveal, keyboard/tap links, selection, thumbnail grid.');
} finally {
  await browser?.close(); server.kill(); fs.rmSync(harnessPath,{force:true}); fs.rmSync(htmlPath,{force:true});
  const toolsDirectory = path.resolve('.tools');
  assert(path.dirname(previewDirectory) === toolsDirectory && path.basename(previewDirectory).startsWith('search-navigation-preview-'));
  fs.rmSync(previewDirectory,{recursive:true,force:true});
}
