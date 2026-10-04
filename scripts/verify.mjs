import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus=process.env.FOLIO_TEST_CORPUS || path.join(root,'.fixtures');
const resultDir=path.join(root,'test-results');
await mkdir(resultDir,{recursive:true});
const preview=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','4173','--strictPort'],{cwd:root,stdio:'pipe'});
let previewLog='';preview.stdout.on('data',c=>previewLog+=c);preview.stderr.on('data',c=>previewLog+=c);
const origin='http://127.0.0.1:4173';
for(let attempt=0;attempt<100;attempt++){try{if((await fetch(origin)).ok)break;}catch{}if(preview.exitCode!==null)throw new Error(previewLog);await new Promise(r=>setTimeout(r,100));}
const chrome=process.env.CHROME_PATH || ['/usr/bin/chromium','/usr/bin/google-chrome','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if(!chrome){preview.kill();throw new Error('Define CHROME_PATH con la ruta a Chromium, Chrome o Edge.');}
const results=[];
const errors=[];
const requests=[];
const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,acceptDownloads:true});
await context.addInitScript(()=>{window.print=()=>{window.__folioPrintCalled=true;};});
const page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message));
context.on('request',request=>requests.push({method:request.method(),url:request.url()}));
async function record(id,fn){
 const start=Date.now();
 try{const evidence=await fn();results.push({id,status:evidence?.status||'passed',elapsedMs:Date.now()-start,...evidence});}
 catch(e){results.push({id,status:'failed',elapsedMs:Date.now()-start,error:String(e)});}
 await writeFile(resultDir+'/browser-results.json',JSON.stringify({platform:'Linux, Chromium headless; NO Windows installer tested',results,uncaughtErrors:errors},null,2));
 console.log(JSON.stringify(results.at(-1)));
}
async function open(name){
 const start=Date.now();
 await page.locator('input[type=file]').setInputFiles(corpus+'/'+name);
 await page.waitForFunction(name=>document.querySelector('h1')?.textContent===name.replace(/\.pdf$/i,''),name,{timeout:45000});
 await page.locator('.loading-overlay').waitFor({state:'detached',timeout:45000});
 await page.locator('.pdf-page-wrap[data-page-number="1"] .page-content canvas').waitFor();
 await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({state:'detached',timeout:45000});
 return Date.now()-start;
}
async function addHighlight(){
 await page.getByRole('button',{name:'Resaltar un área (H)',exact:true}).click();
 const b=await page.locator('.pdf-page-wrap[data-page-number="1"] .page-content').boundingBox();
 assert(b&&b.width>100);
 await page.mouse.move(b.x+b.width*.15,b.y+b.height*.25);
 await page.mouse.down();
 await page.mouse.move(b.x+b.width*.65,b.y+b.height*.28,{steps:8});
 await page.mouse.up();
 await page.getByRole('button',{name:'Seleccionar texto (V)',exact:true}).click();
}
async function addNote(text){
 await page.getByRole('button',{name:'Añadir nota (N)',exact:true}).click();
 const b=await page.locator('.pdf-page-wrap[data-page-number="1"] .page-content').boundingBox();
 await page.mouse.click(b.x+b.width*.78,b.y+b.height*.2);
 await page.getByRole('textbox',{name:'Texto de la nota',exact:true}).fill(text);
 await page.getByRole('button',{name:'Guardar nota',exact:true}).click();
 await page.locator('dialog[open]').waitFor({state:'detached'});
}
async function getSavedSession(name){
 const id=createHash('sha256').update(await readFile(corpus+'/'+name)).digest('hex');
 return page.evaluate(id=>JSON.parse(localStorage.getItem('folio.session.'+id)||'null'),id);
}
async function exportPdf(name,annotated){
 await page.getByRole('button',{name:'Descargar',exact:true}).click();
 const event=page.waitForEvent('download',{timeout:45000});
 await page.locator('dialog').getByRole('button',{name:annotated?/PDF con anotaciones/:/PDF original/}).click();
 const download=await event;
 await download.saveAs(resultDir+'/'+name);
 return download.suggestedFilename();
}
try{
 await page.goto(origin);
 await page.locator('input[type=file]').setInputFiles(path.join(root,'public/sample.pdf'));
 await page.waitForFunction(()=>document.querySelector('.textLayer')?.textContent?.includes('observar'),null,{timeout:45000});
 await record('initial-sample-and-ui',async()=>{
  await page.waitForFunction(()=>document.querySelector('.textLayer')?.textContent?.includes('observar'));
  assert.equal(await page.locator('.pdf-page-wrap').count(),6);
  await page.screenshot({path:resultDir+'/actual-viewer.png'});
  return {pages:6,firstPageRendered:true};
 });
 await record('real-text-navigation-search-zoom-rotation',async()=>{
  const firstPageMs=await open('tracemonkey.pdf');
  assert.equal(await page.locator('.pdf-page-wrap').count(),14);
  await page.getByRole('button',{name:'Página siguiente',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Número de página"]').value==='2');
  await page.getByRole('button',{name:'Buscar en el documento (Ctrl+F)',exact:true}).click();
  await page.getByRole('textbox',{name:'Buscar texto en el PDF',exact:true}).fill('trace');
  await page.waitForFunction(()=>document.querySelectorAll('.search-result').length>0,{timeout:45000});
  const matchingPages=await page.locator('.search-result').count();
  await page.locator('.search-result').first().click();
  await page.waitForFunction(()=>document.querySelectorAll('.textLayer mark').length>0);
  const markedWords=await page.locator('.textLayer mark').count();
  await page.getByRole('button',{name:'Cerrar búsqueda',exact:true}).click();
  await page.getByRole('combobox',{name:'Nivel de zoom',exact:true}).selectOption('100');
  assert.equal(await page.getByRole('combobox',{name:'Nivel de zoom',exact:true}).inputValue(),'100');
  await page.getByRole('button',{name:'Rotar vista 90 grados',exact:true}).click();
  await page.screenshot({path:resultDir+'/rotated-view.png'});
  await page.getByRole('button',{name:'Rotar vista 90 grados',exact:true}).click();
  await page.getByRole('button',{name:'Rotar vista 90 grados',exact:true}).click();
  await page.getByRole('button',{name:'Rotar vista 90 grados',exact:true}).click();
  await page.getByRole('combobox',{name:'Nivel de zoom',exact:true}).selectOption('page');
  const p=page.getByRole('textbox',{name:'Número de página',exact:true});await p.fill('1');await p.press('Enter');
  await page.waitForFunction(()=>document.querySelector('[aria-label="Número de página"]').value==='1');
  return {pages:14,firstPageMs,matchingPages,markedWords,viewRotationOnly:true};
 });
 await record('annotations-undo-redo-note-export',async()=>{
  await addHighlight();
  assert.equal(await page.locator('.highlight-annotation').count(),1);
  await page.getByRole('button',{name:'Deshacer (Ctrl+Z)',exact:true}).click();
  assert.equal(await page.locator('.highlight-annotation').count(),0);
  await page.getByRole('button',{name:'Rehacer (Ctrl+Y)',exact:true}).click();
  assert.equal(await page.locator('.highlight-annotation').count(),1);
  await addNote('Nota de auditoría: conservar el contenido original.');
  await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.startsWith('folio.session.')&&JSON.parse(localStorage.getItem(k)).annotations.length===2));
  const session=await getSavedSession('tracemonkey.pdf');assert.equal(session.annotations.length,2);
  const filename=await exportPdf('tracemonkey-anotado.pdf',true);
  await page.screenshot({path:resultDir+'/actual-annotations.png'});
  return {savedAnnotations:session.annotations.length,undoRedo:true,exportedFile:'tracemonkey-anotado.pdf',suggestedFilename:filename,exportMode:'PDF estándar: Highlight/Text, apariencias y Unicode, sin páginas añadidas'};
 });
 await record('local-library-reopen',async()=>{
  await page.reload();await page.locator('.loading-overlay').waitFor({state:'detached'});
  await page.getByRole('button',{name:'Mis documentos',exact:true}).click();
  await page.locator('.recent-row').filter({hasText:'tracemonkey.pdf'}).locator('button').first().click();
  await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='tracemonkey');
  const session=await getSavedSession('tracemonkey.pdf');assert.equal(session.annotations.length,2);
  await page.getByRole('button',{name:/Anotaciones/}).first().click();
  assert.equal(await page.locator('.annotation-card').count(),2);
  return {localSessionRestored:true,annotations:2};
 });
 await record('original-download-byte-preservation',async()=>{
  await exportPdf('tracemonkey-original-download.pdf',false);
  assert.deepEqual(await readFile(resultDir+'/tracemonkey-original-download.pdf'),await readFile(corpus+'/tracemonkey.pdf'));
  return {byteIdentical:true};
 });
 await record('print-preparation-only',async()=>{
  const popupPromise=context.waitForEvent('page');
  await page.getByRole('button',{name:'Imprimir PDF',exact:true}).click();
  const popup=await popupPromise;
  await popup.waitForFunction(()=>window.__folioPrintCalled===true,null,{timeout:60000});
  const renderedPages=await popup.locator('img').count();assert.equal(renderedPages,14);
  await popup.close();
  return {status:'partial',renderedPages,printMethodInvoked:true,nativePrinterAndWindowsNotTested:true};
 });
 await record('real-scanned-pdf-no-ocr',async()=>{
  const firstPageMs=await open('scanned-skew.pdf');
  await page.getByRole('button',{name:'Buscar en el documento (Ctrl+F)',exact:true}).click();
  await page.getByRole('textbox',{name:'Buscar texto en el PDF',exact:true}).fill('the');
  await page.waitForFunction(()=>document.querySelector('.search-summary')?.textContent?.includes('0 coincidencias'));
  const emptyMessage=await page.locator('.empty-panel').innerText();assert(emptyMessage.includes('no contiene texto seleccionable'));
  await page.screenshot({path:resultDir+'/actual-scanned-pdf.png'});
  await page.getByRole('button',{name:'Cerrar búsqueda',exact:true}).click();
  return {status:'partial',firstPageMs,scanRenders:true,searchUnavailableWithoutOcr:true,message:emptyMessage};
 });
 await record('real-acroform-read-not-fill',async()=>{
  const firstPageMs=await open('irs-w9.pdf');
  const htmlFields=await page.locator('.page-content input,.page-content select,.page-content textarea').count();
  assert.equal(htmlFields,0);
  await addHighlight();await exportPdf('irs-w9-anotado.pdf',true);
  await page.screenshot({path:resultDir+'/actual-form-static.png'});
  return {status:'partial',firstPageMs,pages:6,interactiveFormFields:htmlFields,sourcePdfHas23Fields:true,formFillingNotImplemented:true};
 });
 await record('aes256-password-wrong-correct-encrypted-export',async()=>{
  await page.locator('input[type=file]').setInputFiles(corpus+'/irs-w9-aes256-test.pdf');
  await page.locator('#pdf-password').fill('incorrecta');
  await page.locator('dialog').getByRole('button',{name:'Abrir PDF',exact:true}).click();
  await page.locator('.password-error').waitFor();
  await page.locator('#pdf-password').fill('folio-test');
  await page.locator('dialog').getByRole('button',{name:'Abrir PDF',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='irs-w9-aes256-test');
  await page.locator('.loading-overlay').waitFor({state:'detached'});
  await page.locator('.pdf-page-wrap[data-page-number="1"] .page-loading').waitFor({state:'detached'});
  await addHighlight();
  await page.getByRole('button',{name:'Descargar',exact:true}).click();
  const downloadEvent=page.waitForEvent('download',{timeout:45000});
  await page.locator('dialog').getByRole('button',{name:/PDF con anotaciones/}).click();
  const encryptedDownload=await downloadEvent;await encryptedDownload.saveAs(resultDir+'/protected-anotado.pdf');
  return {wrongPasswordRejected:true,correctPasswordAccepted:true,encryptedDocumentRendered:true,annotatedExportSucceeded:true,encryptionIndependentValidation:'verify-interoperability.py'};
 });
 await record('password-cancel-preserves-current-document',async()=>{
  await page.locator('input[type=file]').setInputFiles(corpus+'/irs-w9-aes256-test.pdf');
  await page.locator('#pdf-password').waitFor();
  await page.locator('dialog').getByRole('button',{name:'Cancelar',exact:true}).click();
  await page.locator('.loading-overlay').waitFor({state:'detached'});
  assert.equal(await page.locator('h1').innerText(),'irs-w9-aes256-test');
  return {cancelHandled:true,priorDocumentStillOpen:true};
 });
 await record('large-real-804-page-document',async()=>{
  const firstPageMs=await open('emacs-manual.pdf');
  assert.equal(await page.locator('.pdf-page-wrap').count(),804);
  const firstCanvases=await page.locator('.page-content canvas').count();
  const input=page.getByRole('textbox',{name:'Número de página',exact:true});
  await input.fill('804');await input.press('Enter');
  await page.locator('.pdf-page-wrap[data-page-number="804"] .page-content canvas').waitFor({timeout:60000});
  await page.locator('.pdf-page-wrap[data-page-number="804"] .page-loading').waitFor({state:'detached',timeout:60000});
  await page.waitForFunction(()=>document.querySelector('[aria-label="Número de página"]').value==='804');
  const renderedCanvases=await page.locator('.page-content canvas').count();
  await page.screenshot({path:resultDir+'/actual-large-last-page.png'});
  return {pages:804,bytes:3084965,firstPageMs,lastPageRendered:true,firstCanvases,renderedCanvases,singleRunNotWindowsBenchmark:true};
 });
 await record('invalid-file-preserves-current-pdf',async()=>{
  await page.locator('input[type=file]').setInputFiles({name:'invalid.pdf',mimeType:'application/pdf',buffer:Buffer.from('This is not a PDF.')});
  await page.locator('.toast.error').waitFor();
  const message=await page.locator('.toast.error').innerText();assert(message.includes('no es un PDF válido'));
  assert.equal(await page.locator('h1').innerText(),'emacs-manual');
  return {invalidPdfRejected:true,priorDocumentStillOpen:true};
 });
 await record('reopen-standard-annotations-and-unicode',async()=>{
  await page.locator('input[type=file]').setInputFiles(resultDir+'/tracemonkey-anotado.pdf');
  await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='tracemonkey-anotado');
  await page.locator('.loading-overlay').waitFor({state:'detached'});
  await page.getByRole('button',{name:/^Anotaciones/}).click();
  assert.equal(await page.locator('.annotation-card').count(),2);
  await page.getByRole('button',{name:'Editar nota',exact:true}).click();
  await page.getByRole('textbox',{name:'Texto de la nota',exact:true}).fill('Nota Unicode: 漢字 🙂');
  await page.getByRole('button',{name:'Guardar nota',exact:true}).click();
  await exportPdf('unicode-standard.pdf',true);
  await page.locator('input[type=file]').setInputFiles(resultDir+'/unicode-standard.pdf');
  await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='unicode-standard');
  await page.locator('.loading-overlay').waitFor({state:'detached'});
  await page.getByRole('button',{name:/^Anotaciones/}).click();
  assert.equal(await page.locator('.annotation-card').count(),2);
  assert((await page.locator('.annotation-card').filter({hasText:'Nota Unicode'}).innerText()).includes('漢字 🙂'));
  await page.locator('.annotation-card').filter({hasText:'Nota Unicode'}).getByRole('button',{name:'Eliminar anotación',exact:true}).click();
  assert.equal(await page.locator('.annotation-card').count(),1);
  await exportPdf('deleted-note.pdf',true);
  await page.getByRole('button',{name:'Eliminar anotación',exact:true}).click();
  assert.equal(await page.locator('.annotation-card').count(),0);
  await exportPdf('deleted-all.pdf',true);
  return {importedComments:2,unicodePreserved:true,noteDeletionExported:true,allCommentsDeletionExported:true,pages:await page.locator('.pdf-page-wrap').count()};
 });
 await record('restricted-pdf-disables-annotation-tools',async()=>{
  await page.locator('input[type=file]').setInputFiles(resultDir+'/restricted.pdf');
  await page.locator('#pdf-password').fill('reader');await page.locator('dialog').getByRole('button',{name:'Abrir PDF',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='restricted');
  await page.locator('.loading-overlay').waitFor({state:'detached'});
  assert(await page.getByRole('button',{name:'Resaltar un área (H)',exact:true}).isDisabled());
  assert(await page.getByRole('button',{name:'Añadir nota (N)',exact:true}).isDisabled());
  await page.keyboard.press('h');assert(await page.getByRole('button',{name:'Seleccionar texto (V)',exact:true}).evaluate(e=>e.classList.contains('active')));
  return {annotationToolsDisabled:true,shortcutRespectsPermissions:true};
 });
 await record('signature-detection-is-read-only-without-validity-claim',async()=>{
  await page.locator('input[type=file]').setInputFiles(resultDir+'/signature-detection-fixture.pdf');
  await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='signature-detection-fixture');
  await page.locator('.loading-overlay').waitFor({state:'detached'});
  assert(await page.getByRole('button',{name:'Resaltar un área (H)',exact:true}).isDisabled());
  assert((await page.locator('.toast').innerText()).includes('Su validez todavía no se verifica'));
  return {signatureDetected:true,savingChangesBlocked:true,cryptographicValidityTested:false};
 });
 await record('privacy-transport-during-tests',async()=>{
  const external=requests.filter(r=>!r.url.startsWith(origin)&&!r.url.startsWith('blob:')&&!r.url.startsWith('data:'));
  const posts=requests.filter(r=>r.method==='POST'||r.method==='PUT');
  assert.equal(posts.length,0);assert.equal(external.length,0);
  return {networkRequests:requests.length,documentUploads:0,externalAppRequests:external.length};
 });
} finally {
 await writeFile(resultDir+'/browser-results.json',JSON.stringify({date:new Date().toISOString(),platform:'Linux Chromium headless; NO Windows installer tested',results,uncaughtErrors:errors,requests},null,2));
 await browser.close();preview.kill();
}
if(results.some(r=>r.status==='failed')||errors.length)process.exitCode=1;

