"""Valid file-backed PDF fixtures, including a sparse file above 2 GiB.

The large gap is PDF whitespace and its xref contains the actual 64-bit offsets.
No full-document Python buffer is allocated. This is a synthetic size/memory
fixture; it does not represent a complex 2 GiB scanned document.
"""
from pathlib import Path
import argparse, os

def write_fixture(path, large=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = b'BT /F1 22 Tf 60 650 Td (Folio native PDFKit selection search) Tj 0 -40 Td (Words keep their original bounds.) Tj ET'
    objects = {
        1: b'<< /Type /Catalog /Pages 2 0 R /Outlines 11 0 R >>',
        2: b'<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>',
        3: b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [20 30 592 762] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R 7 0 R] >>',
        4: b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        5: b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream',
        6: b'<< /Type /Annot /Subtype /Highlight /Rect [60 645 330 674] /QuadPoints [60 674 330 674 60 645 330 645] /C [1 1 0] /CA .35 /F 4 /NM (source-highlight) /Contents (Original Folio highlight) >>',
        7: b'<< /Type /Annot /Subtype /Text /Rect [380 620 400 640] /C [1 0 0] /CA .35 /F 4 /NM (source-note) /Contents (Original Folio note) >>',
        8: b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [9 0 R 10 0 R] >>',
        9: b'<< /Type /Annot /Subtype /Highlight /Rect [60 645 330 674] /QuadPoints [60 674 330 674 60 645 330 645] /C [0 1 1] /F 4 /NM (unseen-highlight) /Contents (Preserve unseen page) >>',
        10: b'<< /Type /Annot /Subtype /Square /Rect [450 500 500 550] /C [0 0 1] /F 4 /NM (unseen-square) >>',
        11: b'<< /Type /Outlines /First 12 0 R /Last 12 0 R /Count 1 >>',
        12: b'<< /Title (Folio native second page) /Parent 11 0 R /Dest [8 0 R /Fit] >>',
    }
    with path.open('wb') as file:
        file.write(b'%PDF-1.7\n%Folio file-backed fixture\n')
        offsets = [0] * (len(objects) + 1)
        for index, body in objects.items():
            offsets[index] = file.tell()
            file.write(str(index).encode() + b' 0 obj\n' + body + b'\nendobj\n')
        if large:
            # NTFS requires explicitly marking sparse before seeking. macOS APFS
            # and Unix filesystems create sparse extents without this ioctl.
            if os.name == 'nt':
                import ctypes, msvcrt
                returned = ctypes.c_ulong()
                handle = msvcrt.get_osfhandle(file.fileno())
                ok = ctypes.windll.kernel32.DeviceIoControl(ctypes.c_void_p(handle), 0x000900c4, None, 0, None, 0, ctypes.byref(returned), None)
                if not ok: raise OSError(ctypes.get_last_error(), 'Could not mark the fixture sparse')
            file.seek(2 * 1024**3 + 4096)
            file.write(b'\n')
        xref = file.tell()
        file.write(b'xref\n0 ' + str(len(offsets)).encode() + b'\n0000000000 65535 f \n')
        for offset in offsets[1:]: file.write(f'{offset:010d} 00000 n \n'.encode())
        file.write(b'trailer\n<< /Size ' + str(len(offsets)).encode() + b' /Root 1 0 R >>\nstartxref\n' + str(xref).encode() + b'\n%%EOF\n')
    return path

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('path', type=Path); parser.add_argument('--large', action='store_true')
    args = parser.parse_args(); print(write_fixture(args.path, args.large))
