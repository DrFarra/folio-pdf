import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PDFDocument, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { inspectDocument, writeAnnotations } from '../../src/engine/mupdf-engine.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const corpus=process.env.FOLIO_TEST_CORPUS || path.join(root,'.fixtures');
const output=path.join(root,'test-results');fs.mkdirSync(output,{recursive:true});
const results=[];
const bytes=name=>new Uint8Array(fs.readFileSync(path.join(corpus,name)));
const hash=data=>createHash('sha256').update(data).digest('hex');
const annotations=[
  {id:'highlight-test',page:1,kind:'highlight',rect:[90,565,450,550],color:'#f5d164',text:'',created:Date.now()},
  {id:'unicode-test',page:1,kind:'note',rect:[100,650,100,650],color:'#f5d164',text:'Nota Unicode: 漢字 🙂',created:Date.now()},
];
function check(id,run){try{const evidence=run();results.push({id,status:'passed',...evidence});}catch(e){results.push({id,status:'failed',error:e.message});process.exitCode=1;}console.log(JSON.stringify(results.at(-1)));}

check('standard-annotations-unicode-and-original-immutable',()=>{
  const source=bytes('tracemonkey.pdf'),before=hash(source),result=writeAnnotations(source,annotations);
  fs.writeFileSync(path.join(output,'engine-standard.pdf'),result);
  const inspected=inspectDocument(result);
  assert.equal(inspected.pages,14);assert.equal(inspected.annotations.length,2);
  assert.equal(inspected.annotations.find(a=>a.kind==='note').text,annotations[1].text);
  assert.deepEqual(inspected.annotations.find(a=>a.kind==='highlight').rect,[90,550,450,565]);
  assert.equal(hash(source),before);
  return {pages:14,standardComments:2,unicodePreserved:true,originalUnchanged:true};
});
check('repeated-save-does-not-duplicate-and-deletion-survives',()=>{
  const first=new Uint8Array(fs.readFileSync(path.join(output,'engine-standard.pdf'))),inspected=inspectDocument(first);
  const second=writeAnnotations(first,inspected.annotations);assert.equal(inspectDocument(second).annotations.length,2);
  const remaining=inspected.annotations.filter(a=>a.kind==='highlight');
  const deleted=writeAnnotations(second,remaining);assert.equal(inspectDocument(deleted).annotations.length,1);
  fs.writeFileSync(path.join(output,'engine-deleted-note.pdf'),deleted);
  const none=writeAnnotations(deleted,[]);assert.equal(inspectDocument(none).annotations.length,0);
  return {afterRepeatedSave:2,afterDeletion:1,afterDeleteAll:0};
});
check('encrypted-save-retains-password-and-standard-comment',()=>{
  const source=bytes('irs-w9-aes256-test.pdf');
  assert.throws(()=>inspectDocument(source,'wrong'));
  const result=writeAnnotations(source,[annotations[1]],'folio-test');
  fs.writeFileSync(path.join(output,'engine-protected.pdf'),result);
  const locked=new mupdf.PDFDocument(result);assert(locked.needsPassword());locked.destroy();
  assert.throws(()=>inspectDocument(result,'wrong'));
  assert.equal(inspectDocument(result,'folio-test').annotations[0].text,annotations[1].text);
  return {passwordRetained:true,unicodePreserved:true};
});
check('document-permissions-are-enforced',()=>{
  const doc=new mupdf.PDFDocument(bytes('irs-w9.pdf'));
  const b=doc.saveToBuffer('encrypt=aes-256,user-password=reader,owner-password=owner,permissions=4');
  const restricted=new Uint8Array(b.asUint8Array());b.destroy();doc.destroy();
  assert.equal(inspectDocument(restricted,'reader').canAnnotate,false);
  assert.throws(()=>writeAnnotations(restricted,annotations,'reader'),/permisos/);
  fs.writeFileSync(path.join(output,'restricted.pdf'),restricted);
  return {restrictedAnnotationsBlocked:true};
});
check('signed-document-is-detected-and-save-blocked-without-claiming-validity',()=>{
  const doc=new mupdf.PDFDocument(bytes('irs-w9.pdf'));
  const signature=doc.addObject({Type:'Sig',ByteRange:[0,100,200,10],Contents:doc.newByteString([0,1,2])});
  const field=doc.addObject({FT:'Sig',T:doc.newString('Fake signature for detection test'),V:signature});
  doc.getTrailer().get('Root','AcroForm','Fields').push(field);
  const b=doc.saveToBuffer('garbage=3');const data=new Uint8Array(b.asUint8Array());b.destroy();doc.destroy();
  assert.equal(inspectDocument(data).signed,true);assert.equal(inspectDocument(data).canAnnotate,false);
  assert.throws(()=>writeAnnotations(data,annotations),/firma/);
  fs.writeFileSync(path.join(output,'signature-detection-fixture.pdf'),data);
  return {signatureDetected:true,savingBlocked:true,cryptographicValidityTested:false};
});
check('inherited-signature-field-also-blocks-changes',()=>{
  const doc=new mupdf.PDFDocument(bytes('irs-w9.pdf'));
  const signature=doc.addObject({Type:'Sig',Contents:doc.newByteString([0,1]),ByteRange:[0,10,30,10]});
  const child=doc.addObject({V:signature});
  const parent=doc.addObject({FT:'Sig',T:doc.newString('Inherited signature'),Kids:[child]});
  child.put('Parent',parent);doc.getTrailer().get('Root','AcroForm','Fields').push(parent);
  const b=doc.saveToBuffer('garbage=3');const data=new Uint8Array(b.asUint8Array());b.destroy();doc.destroy();
  assert.equal(inspectDocument(data).signed,true);assert.throws(()=>writeAnnotations(data,annotations),/firma/);
  return {inheritedFieldTypeDetected:true,cryptographicValidityTested:false};
});
check('invalid-annotations-fail-before-producing-output',()=>{
  assert.throws(()=>writeAnnotations(bytes('tracemonkey.pdf'),[{...annotations[0],rect:[NaN,1,2,3]}]));
  assert.throws(()=>writeAnnotations(bytes('tracemonkey.pdf'),[{...annotations[0],page:9999}]));
  assert.throws(()=>writeAnnotations(bytes('tracemonkey.pdf'),[annotations[0],annotations[0]]));
  return {invalidCoordinatesBlocked:true,invalidPagesBlocked:true,duplicateIdsBlocked:true};
});

const geometry=await PDFDocument.create();
for(const angle of [0,90,180,270]){const p=geometry.addPage([600,800]);p.setCropBox(50,40,480,680);p.setRotation(degrees(angle));p.drawText('CROP AND ROTATION '+angle,{x:80,y:650,size:20});}
const geometryBytes=await geometry.save();fs.writeFileSync(path.join(output,'geometry-original.pdf'),geometryBytes);
check('notes-and-highlights-roundtrip-across-crop-and-four-rotations',()=>{
  const values=[0,90,180,270].flatMap((angle,i)=>annotations.map(a=>({...a,id:a.id+'-'+angle,page:i+1,rect:a.kind==='note'?[100,600,100,600]:[90,620,320,600]})));
  const result=writeAnnotations(geometryBytes,values),read=inspectDocument(result).annotations;
  assert.equal(read.length,8);
  for(const value of values){const match=read.find(a=>a.id===value.id);assert(match);const expected=value.kind==='note'?value.rect:[90,600,320,620];match.rect.forEach((n,i)=>assert(Math.abs(n-expected[i])<.001));}
  fs.writeFileSync(path.join(output,'geometry-standard.pdf'),result);
  return {rotations:[0,90,180,270],cropPreserved:true,comments:8};
});
check('recolored-existing-highlight-and-note-persist-after-reopen',()=>{
  const saved=writeAnnotations(bytes('tracemonkey.pdf'),annotations),reopened=inspectDocument(saved).annotations;
  const changed=reopened.map(a=>({...a,color:a.kind==='highlight'?'#4caf50':'#e53935',opacity:a.kind==='highlight'?.6:a.opacity}));
  const result=inspectDocument(writeAnnotations(saved,changed)).annotations;
  assert.equal(result.find(a=>a.kind==='highlight').color,'#4caf50');assert(Math.abs(result.find(a=>a.kind==='highlight').opacity-.6)<.01);
  assert.equal(result.find(a=>a.kind==='note').color,'#e53935');assert.equal(result.find(a=>a.kind==='note').text,annotations[1].text);
  return {highlightColorAndOpacityPersisted:true,noteColorPersisted:true};
});
check('large-pdf-is-read-on-demand-and-keeps-annotations',()=>{
  // Above 32 MB MuPDF reads the bytes through a stream instead of copying them.
  const padded=new mupdf.PDFDocument(writeAnnotations(bytes('tracemonkey.pdf'),annotations));
  padded.getTrailer().get('Root').put('FolioPadding',padded.addStream(new Uint8Array(33*1024*1024).fill(7),{}));
  const large=padded.saveToBuffer('').asUint8Array().slice();padded.destroy();
  assert(large.length>32*1024*1024);
  const inspected=inspectDocument(large);
  assert.equal(inspected.pages,14);assert.equal(inspected.annotations.length,2);
  // A large PDF is not rewritten to remove them: the reader hides them by PDF.js id.
  assert.equal(inspected.previewBytes,undefined);assert.deepEqual(inspected.hidden,inspected.annotations.map(a=>`${a.sourceRef}R`));
  const recolored=inspected.annotations.map(a=>({...a,color:'#4caf50'}));
  const incremental=writeAnnotations(large,recolored,'',true);
  assert(incremental.length>=large.length);assert(inspectDocument(incremental).annotations.every(a=>a.color==='#4caf50'));
  assert.equal(inspectDocument(writeAnnotations(large,[recolored[0]])).annotations.length,1);
  return {bytes:large.length,annotationsRead:2,hiddenByReference:true,incrementalSave:true,fullSave:true};
});
fs.writeFileSync(path.join(output,'engine-results.json'),JSON.stringify({platform:'Node + actual MuPDF WASM engine',results},null,2));
