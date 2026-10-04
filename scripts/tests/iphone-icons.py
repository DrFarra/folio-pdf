"""Validate the icon delivery gate against real PNG and Apple's CgBI layout."""
from pathlib import Path
import json, struct, sys, tempfile, unittest, zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ios_icon_audit import decode_png, inspection_png, verify_compiled_icons

RGBA = bytes([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])

def cgbi_png(rows):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    compressor = zlib.compressobj(wbits=-15)
    compressed = compressor.compress(bytes(rows)) + compressor.flush()
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'CgBI', bytes([64, 160, 96, 130])) +
            chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', compressed[:len(compressed)//2]) +
            chunk(b'IDAT', compressed[len(compressed)//2:]) + chunk(b'IEND', b''))

class Icons(unittest.TestCase):
    def test_standard_png(self):
        self.assertEqual(decode_png(inspection_png(2, 2, RGBA)), (2, 2, RGBA, False))

    def test_cgbi_raw_deflate_bgra_and_filters(self):
        # Fixed scanlines encode the four opaque red/green/blue/white pixels.
        # Sub/Up/Average/Paeth bytes exercise restoration BEFORE BGRA conversion.
        rows = [
            [0, 0, 0, 255, 255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255],
            [1, 0, 0, 255, 255, 0, 255, 1, 0, 2, 255, 0, 1, 0, 255, 0, 255, 0],
            [1, 0, 0, 255, 255, 0, 255, 1, 0, 3, 255, 0, 129, 128, 128, 128, 255, 0],
            [1, 0, 0, 255, 255, 0, 255, 1, 0, 4, 255, 0, 1, 0, 0, 0, 255, 0],
        ]
        for scanlines in rows:
            with self.subTest(filter=scanlines[9]):
                self.assertEqual(decode_png(cgbi_png(scanlines)), (2, 2, RGBA, True))

    def test_corrupt_compiled_png_rejected(self):
        icon = bytearray(cgbi_png([0, 0, 0, 255, 255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255]))
        icon[20] ^= 1
        with self.assertRaisesRegex(ValueError, 'CRC'):
            decode_png(bytes(icon))

    def test_package_rejects_wrong_artwork_and_accepts_identical_pixels(self):
        with tempfile.TemporaryDirectory(prefix='folio-icon-gate-') as directory:
            directory = Path(directory)
            app, source, evidence = [directory / name for name in ['app', 'source', 'evidence']]
            app.mkdir(); source.mkdir()
            mapping = [('AppIcon60x60@2x.png', 'AppIcon-60x60@2x.png'),
                       ('AppIcon76x76@2x~ipad.png', 'AppIcon-76x76@2x.png')]
            for compiled, reference in mapping:
                (app / compiled).write_bytes(cgbi_png([0, 0, 0, 255, 255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255]))
                (source / reference).write_bytes(inspection_png(2, 2, RGBA))
            self.assertTrue(verify_compiled_icons(app, source, evidence)['passed'])
            (app / mapping[0][0]).write_bytes(inspection_png(2, 2, bytes([0, 0, 0, 255]) * 4))
            with self.assertRaisesRegex(ValueError, 'differs from the original Folio'):
                verify_compiled_icons(app, source, evidence)
            report = json.loads((evidence / 'compiled-icons-ios.json').read_text())
            self.assertFalse(report['passed'])
            self.assertFalse(report['icons'][0]['identicalPixels'])

if __name__ == '__main__':
    unittest.main()
