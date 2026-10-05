import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';
import { writeAnnotations, inspectDocument } from '../../src/engine/mupdf-engine.mjs';
const out='test-results/drive';fs.mkdirSync(out,{recursive:true});
const original=fs.readFileSync('public/sample.pdf');
const annotation={id:'drive-incremental',page:1,kind:'note',rect:[10,10,30,30],text:'Edición desde otro dispositivo',color:'#ffdd00',created:1};
const changed=writeAnnotations(original,[annotation],'',true);
assert(Buffer.from(changed.subarray(0,original.length)).equals(original),'Incremental annotations preserve the complete source prefix');
assert(inspectDocument(changed).annotations.some(a=>a.id===annotation.id));
const removed=writeAnnotations(changed,[],'',true);
assert(Buffer.from(removed.subarray(0,changed.length)).equals(Buffer.from(changed)));
assert.equal(inspectDocument(removed).annotations.length,0,'Incremental removal must be visible to an independent PDF inspection');
fs.writeFileSync(`${out}/incremental.pdf`,changed);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4291','--strictPort'],{stdio:'ignore',windowsHide:true});
let browser;const results=[];
try {
  for(let n=0;n<80;n++){try{if((await fetch('http://127.0.0.1:4291')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const engine=process.env.FOLIO_TEST_BROWSER==='webkit'?'webkit':'chromium';
  browser=engine==='webkit'?await webkit.launch({headless:true}):await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const layouts=[
    ['android-phone',390,844,'Linux; Android 15; Pixel Mobile',true],
    ['android-tablet',800,1280,'Linux; Android 15; Tablet',true],
    ['windows',1360,900,'Windows NT 10.0; Win64; x64',false],
    ['macos',1360,900,'Macintosh; Intel Mac OS X 14_0',false],
    ['iphone',390,844,'iPhone; CPU iPhone OS 17_0 like Mac OS X',true],
    ['ipad',820,1180,'iPad; CPU OS 17_0 like Mac OS X',true],
  ];
  for(const [name,width,height,agent,mobile] of layouts) {
    const context=await browser.newContext({viewport:{width,height},isMobile:mobile,hasTouch:mobile,userAgent:`Mozilla/5.0 (${agent}) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15`});
    await context.addInitScript(({bytes})=>{
      window.isTauri=true;let counter=0;
      const account={id:'account-one',email:'prueba@example.com',name:'Prueba'};
      const file={id:'drive-file',title:'Documento remoto.pdf',mimeType:'application/pdf',fileSize:String(bytes.length),editable:true};
      const document={token:'drive-source',name:file.title,size:bytes.length};
      const opened={document,binding:'binding-one',account:account.id,fileId:file.id,editable:true,offline:false,transferred:bytes.length};
      const state=window.__driveQA={calls:[],pending:[],outcome:'offline',savedBytes:bytes,account:null};
      window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
      window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>++counter,unregisterCallback:()=>{},invoke:async(command,args,options)=>{
        state.calls.push({command,args:args instanceof Uint8Array?{length:args.length}:args});
        if(command==='plugin:event|listen')return ++counter;
        if(['startup_documents','list_library','recent_documents','pick_documents'].includes(command))return [];
        if(command==='load_draft')return new ArrayBuffer(0);
        if(command==='read_document')return new Uint8Array(state.savedBytes).buffer;
        if(command==='drive_status')return {account:state.account,pending:state.pending};
        if(command==='drive_connect'){state.account=account;return account;}
        if(command==='drive_disconnect'){state.account=null;return;}
        if(command==='drive_list')return args.folder==='root'?{items:[{id:'folder-a',title:'Estudios',mimeType:'application/vnd.google-apps.folder'}]}:{items:args.search&&!file.title.includes(args.search)?[]:[file]};
        if(command==='drive_cached')return {items:[file]};
        if(command==='drive_open'||command==='drive_pending_open')return {...opened,offline:args.offline||false};
        if(command==='drive_lookup')return null;
        if(command==='drive_stage'){
          if(!(args instanceof Uint8Array)||options.headers['x-folio-drive-binding']!=='binding-one')throw Error('Drive must receive binary PDF and original binding');
          state.savedBytes=[...args];const p={id:'pending-one',binding:'binding-one',account:account.id,fileId:file.id,name:file.title,created:Date.now(),size:args.length};state.pending=[p];return p;
        }
        if(command==='drive_sync'){
          if(state.outcome==='offline')throw 'Sin conexión. Edición conservada.';
          if(!args.conflictCopy)return {status:'conflict',opened:null,message:'Otro dispositivo modificó el PDF. Tu edición está conservada.'};
          state.pending=[];return {status:'saved',opened:{...opened,fileId:'conflict-copy'},message:'Copia de conflicto guardada. El original sigue intacto.'};
        }
        return null;
      }};
    },{bytes:[...original]});
    const page=await context.newPage();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:4291');await page.getByRole('button',{name:'Google Drive',exact:true}).click();
    await page.getByRole('button',{name:'Iniciar sesión con Google'}).click();
    await page.getByRole('button',{name:'Estudios Carpeta'}).click();
    await page.getByRole('navigation',{name:'Carpeta actual'}).getByRole('button',{name:'Estudios'}).waitFor();
    await page.getByRole('textbox',{name:'Buscar en esta carpeta'}).fill('inexistente');await page.getByRole('button',{name:'Buscar',exact:true}).click();
    await page.getByText('No hay carpetas ni PDF que coincidan con esta búsqueda.').waitFor();
    await page.getByRole('textbox',{name:'Buscar en esta carpeta'}).fill('');await page.getByRole('button',{name:'Buscar',exact:true}).click();
    await page.getByRole('button',{name:/Documento remoto.pdf/}).waitFor();await page.screenshot({path:`${out}/${name}-folders.png`});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
    await page.getByRole('button',{name:/Documento remoto.pdf/}).click();await page.locator('.loading-overlay').waitFor({state:'detached'});
    await page.getByRole('button',{name:'Guardar en Drive',exact:true}).click();
    await page.getByText(/Puedes reintentarlo en Documentos/).waitFor();
    const native=await page.evaluate(()=>window.__driveQA.calls.filter(c=>['write_pdf_original','write_pdf_copy'].includes(c.command)));
    assert.equal(native.length,0,'Drive must never save into the Android cache or use Android SAF overwrite');
    await page.getByRole('button',{name:'Ver Drive',exact:true}).click();
    await page.getByRole('heading',{name:'Ediciones pendientes (1)'}).waitFor();
    await page.evaluate(()=>window.__driveQA.outcome='conflict');await page.getByRole('button',{name:'Reintentar',exact:true}).click();
    await page.getByText('Otro dispositivo modificó el PDF. Tu edición está conservada.').waitFor();
    await page.screenshot({path:`${out}/${name}-conflict.png`});
    await page.getByRole('button',{name:'Guardar como copia de conflicto',exact:true}).click();
    await page.getByText('Copia de conflicto guardada. El original sigue intacto.').waitFor();
    assert.equal(await page.getByRole('heading',{name:'Ediciones pendientes (1)'}).count(),0);
    assert.deepEqual(errors,[]);results.push({name,passed:true});await context.close();
  }
  console.log(JSON.stringify({passed:true,incrementalBytes:changed.length-original.length,results}));
  fs.writeFileSync(`${out}/report.json`,JSON.stringify({passed:true,engine,version:JSON.parse(fs.readFileSync('package.json','utf8')).version,results,coverage:['incremental PDF annotations and deletion','Drive folders and scoped search','native save routing','offline journal UI','conflict copy without original overwrite'],limitations:['OAuth on physical Android/iOS hardware is not exercised by these browser contract tests.']},null,2));
}finally{await browser?.close();server.kill();}
