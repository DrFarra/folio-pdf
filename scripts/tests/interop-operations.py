"""Independent checks of actual operation/UI exports using pypdf and PyMuPDF."""
from pathlib import Path
import json, traceback, subprocess, os, shutil
import pymupdf as fitz
from pypdf import PdfReader

root=Path(__file__).resolve().parents[2]
output=root/'test-results'
results=[]
def check(name, action):
    try:
        detail=action() or {}
        results.append(dict(id=name,status='passed',**detail))
    except Exception as error:
        results.append(dict(id=name,status='failed',error=traceback.format_exc()))
    print(json.dumps(results[-1]))
def readable(name):
    a=PdfReader(output/name)
    b=fitz.open(output/name)
    assert len(a.pages)==len(b)
    for p in b:
        pix=p.get_pixmap(matrix=fitz.Matrix(.4,.4))
        assert pix.width and pix.height
    return a,b
def editable():
    for filename, marker in [('edited-text.pdf','PUBLIC TEXT'),('ui-edited.pdf','UI REPLACED')]:
        a,b=readable(filename)
        assert marker in a.pages[0].extract_text() and marker in b[0].get_text()
        assert 'SECRET' not in a.pages[0].extract_text() and 'SECRET' not in b[0].get_text()
        assert 'PRESERVE THIS TEXT' in b[0].get_text()
    return {'parsers':['pypdf','PyMuPDF'],'originalTextRemoved':True,'otherTextPreserved':True}
def fields():
    a,b=readable('filled-form.pdf')
    f=a.get_fields()
    assert f['full.name']['/V']=='Emilio González'
    assert f['agree']['/V']=='/Yes' and f['country']['/V']=='Uruguay'
    a,b=readable('merged-complete.pdf')
    assert len(a.get_fields())==3
    assert any(v.get('/V')=='Imported value' for v in a.get_fields().values())
    assert any(x.info['content']=='Imported note' for x in (b[1].annots() or []))
    assert any(x.get('page')==2 for x in b[1].get_links())
    return {'unicode':True,'mergedFieldsCommentsAndLinks':True}
def crops():
    for rotation in [0,90,180,270]:
        a,b=readable(f'crop-{rotation}.pdf')
        assert list(a.pages[0].cropbox)==[100,150,400,500]
        assert b[0].rotation==rotation
    a,b=readable('multiline-highlight.pdf')
    annots=a.pages[0]['/Annots']
    assert any(len(x.get_object().get('/QuadPoints',[]))==16 for x in annots)
    return {'cropAtFourRotations':True,'multilineHighlightQuads':True}
def redaction():
    for filename in ['redacted.pdf','ui-redacted.pdf']:
        a,b=readable(filename)
        assert 'SECRET' not in a.pages[0].extract_text() and 'SECRET' not in b[0].get_text()
        assert not a.get_fields() and not a.metadata
    a,b=readable('image-redacted.pdf')
    before=fitz.open(output/'image-redaction-original.pdf')
    old=before.extract_image(before[0].get_images()[0][0])['image']
    old_samples=fitz.Pixmap(old).samples
    for xref in range(1,b.xref_length()):
        if b.xref_get_key(xref,'Subtype')[1]=='/Image':
            samples=fitz.Pixmap(b,xref).samples
            assert samples!=old_samples,'La imagen original sin censura sigue en el PDF.'
    p=b[0].get_pixmap(matrix=fitz.Matrix(2,2))
    q=before[0].get_pixmap(matrix=fitz.Matrix(2,2))
    for y in range(112,146):
        for x in range(24,326):
            assert p.pixel(x*2,(200-y)*2)==(0,0,0)
    # The lower, unselected line of the same embedded image remains exactly intact.
    for y in range(25,80):
        for x in range(15,350):
            assert p.pixel(x*2,(200-y)*2)==q.pixel(x*2,(200-y)*2)
    return {'selectedTextRemoved':True,'originalEmbeddedImageAbsent':True,'unselectedPixelsPreserved':True}
def ocr():
    a,b=readable('ui-ocr.pdf')
    assert 'FOLIO OCR TEST' in a.pages[0].extract_text()
    assert 'FOLIO OCR TEST' in b[0].get_text()
    source=fitz.open(output/'scan.pdf')
    assert b[0].get_pixmap().samples==source[0].get_pixmap().samples
    return {'searchableInIndependentParsers':True,'scanPixelsUnchanged':True}
def signatures():
    a,b=readable('ui-signed.pdf')
    sig=next(f for f in a.get_fields().values() if f.get('/FT')=='/Sig')['/V']
    ranges=list(sig['/ByteRange'])
    assert ranges[0]==0 and ranges[2]+ranges[3]==(output/'ui-signed.pdf').stat().st_size
    openssl=Path(os.environ.get('OPENSSL_PATH') or shutil.which('openssl') or r'C:\Program Files\Git\usr\bin\openssl.exe')
    assert openssl.exists(),'Define OPENSSL_PATH para la verificación CMS independiente.'
    file=(output/'ui-signed.pdf').read_bytes()
    content=file[ranges[0]:ranges[0]+ranges[1]]+file[ranges[2]:ranges[2]+ranges[3]]
    (output/'cms-content.bin').write_bytes(content)
    (output/'cms-signature.der').write_bytes(bytes(sig['/Contents']))
    command=[str(openssl),'cms','-verify','-binary','-inform','DER','-in',str(output/'cms-signature.der'),'-content',str(output/'cms-content.bin'),'-noverify','-out',str(output/'cms-verified.bin')]
    result=subprocess.run(command,capture_output=True)
    assert result.returncode==0,result.stderr.decode(errors='replace')
    assert (output/'cms-verified.bin').read_bytes()==content
    changed=bytearray(content);changed[len(changed)//2]^=1;(output/'cms-content.bin').write_bytes(changed)
    invalid=subprocess.run(command,capture_output=True)
    assert invalid.returncode!=0,'OpenSSL aceptó contenido modificado.'
    return {'standardSignatureDictionary':True,'entireFileByteRange':True,'opensslCmsVerified':True,'tamperedContentRejected':True}
check('original-content-editing',editable)
check('standard-forms-and-merged-links',fields)
check('crop-and-standard-highlight',crops)
check('permanent-text-and-image-redaction',redaction)
check('ocr-preserves-image-and-adds-searchable-text',ocr)
check('digital-signature-format',signatures)
(output/'interop-operations.json').write_text(json.dumps({'platform':'Windows','parsers':['pypdf','PyMuPDF'],'results':results},indent=2),encoding='utf-8')
assert all(r['status']=='passed' for r in results),'Falló la verificación independiente.'
