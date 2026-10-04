from pathlib import Path
import os,json,hashlib,subprocess,shutil
import fitz
from pypdf import PdfReader

root=Path(__file__).resolve().parent.parent
corpus=Path(os.environ.get('FOLIO_TEST_CORPUS',root/'.fixtures'))
output=root/'test-results'
results=[]
def text(reader):return [p.get_text() for p in reader]
def fields(reader):
    return {k:str(v.get('/V')) for k,v in (reader.get_fields() or {}).items()}
def image_hashes(doc,page):
    return sorted(hashlib.sha256(doc.extract_image(x[0])['image']).hexdigest() for x in doc[page].get_images())
for source,target,pw in [('tracemonkey.pdf','engine-standard.pdf',''),('irs-w9-aes256-test.pdf','engine-protected.pdf','folio-test'),('tracemonkey.pdf','tracemonkey-anotado.pdf',''),('irs-w9.pdf','irs-w9-anotado.pdf',''),('irs-w9-aes256-test.pdf','protected-anotado.pdf','folio-test')]:
    path=output/target
    if not path.exists():raise RuntimeError('Falta la salida requerida: '+target)
    original=fitz.open(corpus/source);exported=fitz.open(path);protected=bool(exported.needs_pass)
    if original.needs_pass:original.authenticate(pw)
    if exported.needs_pass:exported.authenticate(pw)
    assert len(exported)==len(original),(target,'cambió la cantidad de páginas')
    assert text(original)==text(exported),(target,'cambió el contenido textual')
    assert all(image_hashes(original,i)==image_hashes(exported,i) for i in range(len(original))),(target,'cambió una imagen original')
    before=PdfReader(corpus/source);after=PdfReader(path)
    if before.is_encrypted:before.decrypt(pw)
    if after.is_encrypted:after.decrypt(pw)
    assert fields(before)==fields(after),(target,'cambió un campo del formulario')
    assert all((a.get_contents().get_data() if a.get_contents() else b'')==(b.get_contents().get_data() if b.get_contents() else b'') for a,b in zip(before.pages,after.pages)),(target,'cambió un operador del contenido original')
    annotations=[a for p in exported for a in (p.annots() or [])]
    assert annotations,(target,'no hay comentarios estándar')
    if pw:assert protected,(target,'se perdió el cifrado')
    if target.startswith('engine-'):assert any(a.info['content']=='Nota Unicode: 漢字 🙂' for a in annotations)
    results.append({'file':target,'pagesPreserved':len(exported),'originalTextPreserved':True,'embeddedImagesPreserved':True,'formValuesPreserved':True,'standardAnnotations':len(annotations),'passwordProtected':protected,'mupdfReadable':True,'pypdfReadable':True})
unicode_reader=PdfReader(output/'unicode-standard.pdf')
contents=[str(a.get_object().get('/Contents','')) for p in unicode_reader.pages for a in p.get('/Annots',[])]
assert 'Nota Unicode: 漢字 🙂' in contents,'Pérdida Unicode en salida del visor'
deleted=fitz.open(output/'deleted-note.pdf')
assert sum(len(list(p.annots() or [])) for p in deleted)==1
empty=fitz.open(output/'deleted-all.pdf')
assert sum(len(list(p.annots() or [])) for p in empty)==0
geometry_before=fitz.open(output/'geometry-original.pdf');geometry_after=fitz.open(output/'geometry-standard.pdf')
for a,b in zip(geometry_before,geometry_after):assert a.rotation==b.rotation and a.cropbox==b.cropbox
poppler=shutil.which('pdftoppm')
if poppler:
    subprocess.run([poppler,'-f','1','-singlefile','-scale-to','1200','-png',str(output/'unicode-standard.pdf'),str(output/'standard-poppler')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    subprocess.run(['pdftotext',str(output/'tracemonkey-anotado.pdf'),str(output/'tracemonkey-poppler.txt')],check=True)
    assert 'Trace' in (output/'tracemonkey-poppler.txt').read_text(errors='replace')
else:raise RuntimeError('Instala Poppler para validar con un segundo motor de render.')
(output/'interoperability-results.json').write_text(json.dumps({'results':results,'unicodePreservedByIndependentParser':True,'deletionPreserved':True,'cropAndRotationPreserved':True,'popplerRenderPassed':True,'windowsReadersTested':False},ensure_ascii=False,indent=2))
print(json.dumps({'standardAnnotations':True,'Unicode':True,'originalContentPreserved':True,'encryptionPreserved':True,'renderers':['MuPDF','Poppler'],'parsers':['pypdf'],'WindowsReaders':'pendiente'},ensure_ascii=False))
