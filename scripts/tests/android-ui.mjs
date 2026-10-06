import fs from 'node:fs';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {chromium} from 'playwright-core';import { findChrome } from './browser.mjs';
const out='test-results/android';fs.mkdirSync(out,{recursive:true});
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4277'],{stdio:'ignore',windowsHide:true});
let browser;const results=[];
try{
for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:4277')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
browser=await chromium.launch({executablePath:findChrome(),headless:true});
for(const [name,width,height,sw,sh]of [['tablet-portrait',800,1280,800,1280],['tablet-landscape',1280,800,800,1280],['tablet-small',600,960,600,960],['phone',390,844,390,844],['phone-landscape',844,390,390,844],['tablet-split',480,800,800,1280],['desktop',1360,900,1360,900]]){
if(process.env.FOLIO_UI_CASE&&process.env.FOLIO_UI_CASE!==name)continue;
const mobile=name!=='desktop',phone=width<600||Math.min(sw,sh)<600;
const ctx=await browser.newContext({viewport:{width,height},screen:{width:sw,height:sh},isMobile:mobile,hasTouch:mobile,userAgent:mobile?'Mozilla/5.0 (Linux; Android 15; '+(phone?'Pixel 9':'Tablet')+') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 '+(phone?'Mobile ':'')+'Safari/537.36':undefined});
const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
try{
await page.goto('http://127.0.0.1:4277',{waitUntil:'domcontentloaded',timeout:60000});await page.getByRole('heading',{name:'Biblioteca',exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('data-layout'),!mobile?'desktop':phone?'phone':'tablet');
await page.locator('input[type=file][accept="application/pdf,.pdf"]').setInputFiles('public/sample.pdf');await page.locator('.reading-area .textLayer span').first().waitFor();await page.locator('.loading-overlay').waitFor({state:'detached'});
if(!phone&&mobile){
  const reading=await page.locator('.reading-area').boundingBox();
  assert.ok(reading.y<=56.5&&reading.width>=width-1&&reading.height>=height-57,`Reading area must use the tablet: ${JSON.stringify(reading)}`);
  assert.equal(await page.locator('.tool-rail').count(),0);
  await page.screenshot({path:`${out}/${name}-reading.png`});
  const before=await page.locator('.pdf-page').first().boundingBox();
  await page.getByRole('button',{name:'Páginas',exact:true}).click();
  await page.getByRole('dialog',{name:'Explorar documento'}).waitFor();
  assert.deepEqual(await page.locator('.pdf-page').first().boundingBox(),before,'Drawer must preserve PDF layout');
  await page.screenshot({path:`${out}/${name}-panel.png`});
  await page.getByRole('button',{name:'Cerrar panel',exact:true}).click();
}
if(mobile){
  await page.evaluate(()=>document.documentElement.style.setProperty('--native-safe-bottom','24px'));
  assert.equal(await page.locator('.app-shell').evaluate(el=>getComputedStyle(el).paddingBottom),'0px');
  const trigger=page.getByRole('button',{name:'Documentos abiertos y recientes',exact:true});
  await trigger.click();
  const menu=page.getByRole('dialog',{name:'Documentos abiertos y recientes'});
  await menu.waitFor();
  await page.waitForFunction(()=>document.querySelector('.document-switcher')?.getAnimations().every(a=>a.playState==='finished'));
  const tb=await trigger.boundingBox(),mb=await menu.boundingBox();
  assert.ok(Math.abs(mb.y-(tb.y+tb.height+6))<1,'Document picker must open under the title');
  assert.ok(mb.x>=0&&mb.x+mb.width<=width&&mb.y+mb.height<=height-24);
  assert.notEqual(await menu.getAttribute('aria-modal'),'true');
  await page.screenshot({path:`${out}/${name}-documents.png`});
  await page.keyboard.press('ArrowDown');assert.ok(await menu.evaluate(el=>el.contains(document.activeElement)));
  await page.keyboard.press('Escape');await menu.waitFor({state:'detached'});
  assert.equal(await trigger.getAttribute('aria-expanded'),'false');
  // The left margin of the page: the page indicator floats at the right.
  const tapPaper=async()=>{const paper=await page.locator('.page-content').first().boundingBox();await page.touchscreen.tap(paper.x+paper.width*.06,Math.min(paper.y+paper.height*.3,height-120));};
  await tapPaper();await page.waitForFunction(()=>document.querySelector('.app-shell')?.classList.contains('reader-chrome-hidden'));
  await page.locator('.app-header').waitFor({state:'hidden'});
  if(!phone){const area=await page.locator('.reading-area').boundingBox();assert.equal(area.y,0);assert.equal(area.height,height);}
  await page.screenshot({path:`${out}/${name}-immersive.png`});
  await tapPaper();await page.waitForFunction(()=>!document.querySelector('.app-shell')?.classList.contains('reader-chrome-hidden'));
  await trigger.waitFor({state:'visible'});
}
await page.getByRole('button',{name:phone?'Anotar':'Anotar documento',exact:true}).click();await page.getByRole('button',{name:name==='desktop'?'Lápiz (D)':'Lápiz',exact:true}).click();
if(!phone&&mobile){
  const dock=await page.locator('.tablet-annotation-dock').boundingBox();assert.ok(dock.height<=60&&dock.x>=0&&dock.x+dock.width<=width);
  await page.getByRole('button',{name:'Opciones del lápiz',exact:true}).click();
  await page.getByRole('dialog',{name:'Lápiz',exact:true}).getByRole('button',{name:'3 puntos',exact:true}).click();
  await page.keyboard.press('Escape');
}
const layer=page.locator('.ink-interactive').first();const b=await layer.boundingBox();const x=b.x+b.width*.2,y=Math.max(b.y+30,Math.min(b.y+b.height*.35,height-150));
const cdp=await ctx.newCDPSession(page);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1,pointerType:'pen',force:.5});for(let i=1;i<=16;i++)await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+i*5,y:y+Math.sin(i/3)*20,button:'left',buttons:1,pointerType:'pen',force:.7});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+80,y:y+Math.sin(16/3)*20,button:'left',buttons:0,clickCount:1,pointerType:'pen'});
await page.waitForFunction(()=>document.querySelectorAll('[data-ink-id]').length===1);await page.screenshot({path:`${out}/${name}.png`});
// Undo one gesture, then redo it; one draw must be one history step.
await page.keyboard.press('Control+z');await page.waitForFunction(()=>document.querySelectorAll('[data-ink-id]').length===0);await page.keyboard.press('Control+y');await page.waitForFunction(()=>document.querySelectorAll('[data-ink-id]').length===1);
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
if(name==='tablet-landscape'){
  await page.getByRole('button',{name:'Listo',exact:true}).click();
  await page.getByRole('button',{name:'Ir a página',exact:true}).click();
  await page.getByRole('textbox',{name:/^Página \(1–/}).fill('2');
  await page.getByRole('dialog',{name:'Ir a página'}).getByRole('button',{name:'Ir a página',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.tablet-page-jump')?.textContent?.includes('2 /'));
  await page.getByRole('button',{name:'Más acciones del documento',exact:true}).click();
  await page.getByRole('button',{name:'Guardar marcador',exact:true}).click();
  await page.getByRole('button',{name:'Páginas',exact:true}).click();
  await page.getByRole('tab',{name:'Marcadores',exact:true}).click();
  await page.locator('.bookmark-entry').first().waitFor();
  await page.getByRole('tab',{name:'Anotaciones',exact:true}).click();
  await page.getByRole('dialog',{name:'Anotaciones',exact:true}).getByText('Dibujo a mano').waitFor();
  await page.getByRole('button',{name:'Cerrar panel',exact:true}).click();
  await page.getByRole('button',{name:'Buscar en el PDF',exact:true}).click();
  await page.getByRole('textbox',{name:'Buscar texto en el PDF'}).fill('marcador');
  await page.locator('.search-result').first().click();
  await page.getByRole('toolbar',{name:'Resultados de búsqueda'}).waitFor();
  await page.getByRole('button',{name:'Resultado siguiente',exact:true}).click();
  await page.getByRole('button',{name:'Cerrar búsqueda',exact:true}).click();
  await page.getByRole('button',{name:'Documentos abiertos y recientes',exact:true}).click();
  await page.getByRole('dialog',{name:'Documentos abiertos y recientes'}).getByRole('button',{name:'Cambiar a sample.pdf'}).click();
  // The results are on page 6; the ink is on page 1, which is only rendered near the reading position.
  await page.getByRole('button',{name:'Ir a página',exact:true}).click();
  await page.getByRole('textbox',{name:/^Página \(1–/}).fill('1');
  await page.getByRole('dialog',{name:'Ir a página'}).getByRole('button',{name:'Ir a página',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.tablet-page-jump')?.textContent?.trim().startsWith('1 /'));
  await page.locator('[data-ink-id]').first().waitFor();
  assert.equal(await page.locator('[data-ink-id]').count(),1);
  await page.getByRole('button',{name:'Más acciones del documento',exact:true}).click();
  await page.getByRole('button',{name:'Vista del documento',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Cerrar diálogo'}).click();
  assert.equal(await page.locator('.mobile-return-location,.desktop-return-location').count(),0);
  await page.setViewportSize({width:480,height:800});
  await page.waitForFunction(()=>document.documentElement.dataset.layout==='phone');
  assert.equal(await page.locator('[data-ink-id]').count(),1);
  await page.setViewportSize({width:1280,height:800});
  await page.waitForFunction(()=>document.documentElement.dataset.layout==='tablet');
  assert.equal(await page.locator('[data-ink-id]').count(),1);
  const {PDFDocument}=await import('pdf-lib');const second=await PDFDocument.create();second.addPage([600,800]).drawText('Documento reciente de prueba');
  await page.locator('input[type=file][accept="application/pdf,.pdf"]').setInputFiles({name:'Segundo.pdf',mimeType:'application/pdf',buffer:Buffer.from(await second.save())});
  await page.waitForFunction(()=>document.querySelector('#document-switcher-trigger')?.textContent?.includes('Segundo.pdf'));
  await page.locator('.loading-overlay').waitFor({state:'detached'});
  await page.getByRole('button',{name:'Documentos abiertos y recientes',exact:true}).click();
  await page.getByRole('button',{name:'Cerrar Segundo.pdf',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#document-switcher-trigger')?.textContent?.includes('sample.pdf'));
  await page.getByRole('button',{name:'Documentos abiertos y recientes',exact:true}).click();
  await page.getByRole('button',{name:'Abrir reciente Segundo.pdf',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.document-switcher')?.getAnimations().every(a=>a.playState==='finished'));
  await page.screenshot({path:`${out}/tablet-recents.png`});
  await page.getByRole('button',{name:'Abrir reciente Segundo.pdf',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#document-switcher-trigger')?.textContent?.includes('Segundo.pdf'));
}
results.push({name,passed:true});
}catch(e){results.push({name,passed:false,error:e.stack});await page.screenshot({path:`${out}/${name}-failure.png`}).catch(()=>{});process.exitCode=1;}finally{await ctx.close();}console.log(JSON.stringify(results.at(-1)));
}
}finally{await browser?.close();server.kill();fs.writeFileSync(`${out}/ui-results.json`,JSON.stringify(results,null,2));}
