import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as mupdf from 'mupdf';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder=path.join(root,'.fixtures');await mkdir(folder,{recursive:true});
const imported=process.env.FOLIO_TEST_CORPUS?path.resolve(process.env.FOLIO_TEST_CORPUS):null;
const documents=[
 ['tracemonkey.pdf','https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf','3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113'],
 ['irs-w9.pdf','https://www.irs.gov/pub/irs-pdf/fw9.pdf','2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53'],
 ['scanned-skew.pdf','https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/skew.pdf','6be6b54d49df71351974774404e299b756d8d3cbeb2c4a31f15fae8dd983d72f'],
 ['emacs-manual.pdf','https://www.gnu.org/software/emacs/manual/pdf/emacs.pdf','c9ca029caf39189d596f4a4d262eec93fd2cee05e5742476caa17a8eda0e48b5'],
];
// FOLIO_TEST_CORPUS_ONLY limits a run to the files its suites read (comma-separated names).
const only=process.env.FOLIO_TEST_CORPUS_ONLY?.split(',').map(name=>name.trim()).filter(Boolean);
async function download(url){
 for(let attempt=1;;attempt++){
  try{return await fetch(url,{signal:AbortSignal.timeout(60000),headers:{'User-Agent':'Folio-PDF-test-fixtures/0.2.0','Accept':'application/pdf,*/*'}});}
  catch(error){if(attempt>=3)throw error;await new Promise(resolve=>setTimeout(resolve,attempt*2000));}
 }
}
for(const [name,url,expected] of documents.filter(([name])=>!only||only.includes(name))){
 let data;try{data=await readFile(path.join(folder,name));}catch{}
 if((!data||createHash('sha256').update(data).digest('hex')!==expected)&&imported){
  try{data=await readFile(path.join(imported,name));}catch{}
 }
 if(!data||createHash('sha256').update(data).digest('hex')!==expected){
  const response=await download(url);if(!response.ok)throw new Error(`${name}: HTTP ${response.status}. Puedes importar una copia de la misma edición con FOLIO_TEST_CORPUS. No se acepta otro archivo sin revisar su SHA-256.`);
  data=new Uint8Array(await response.arrayBuffer());
  if(createHash('sha256').update(data).digest('hex')!==expected)throw new Error(`${name} cambió en origen. Revisa el corpus antes de actualizar su hash.`);
 }
 await writeFile(path.join(folder,name),data);
 console.log(name+' verificado');
}
const original=new mupdf.PDFDocument(await readFile(path.join(folder,'irs-w9.pdf')));
const encrypted=original.saveToBuffer('encrypt=aes-256,user-password=folio-test,owner-password=folio-owner-test');
await writeFile(path.join(folder,'irs-w9-aes256-test.pdf'),encrypted.asUint8Array());encrypted.destroy();original.destroy();
await writeFile(path.join(folder,'manifest.json'),JSON.stringify({publicDocuments:documents,protectedFixture:'Derivación controlada del W9; contraseña de pruebas folio-test'},null,2));
