import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root=path.resolve(process.argv[2] || 'artifacts/release');
const chrome=process.env.CHROME_PATH || ['/usr/bin/chromium','/usr/bin/google-chrome','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if(!chrome)throw new Error('Define CHROME_PATH.');
const server=createServer(async(req,res)=>{
 const route=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 const file=path.resolve(root,'.'+route);
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 try{const data=await fs.readFile(file);const mime={'.html':'text/html; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.pdf':'application/pdf'};res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(data);}catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
 const page=await browser.newPage();
 await page.goto('http://127.0.0.1:'+server.address().port+'/avance-folio-0.2.html');
 await page.evaluate(async()=>Promise.all([...document.images].map(img=>img.decode())));
 // Local HTML links work in the complete release folder. Do not bake temporary
 // localhost URLs into the standalone PDF that users may download separately.
 await page.evaluate(()=>{
  for(const link of document.querySelectorAll('a[href]')){
   const href=link.getAttribute('href');
   if(href&&!href.startsWith('http')&&!href.startsWith('#'))link.removeAttribute('href');
  }
 });
 await page.pdf({path:path.join(root,'avance-folio-0.2.pdf'),format:'A4',printBackground:true,preferCSSPageSize:true});
 console.log('Informe PDF generado.');
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
