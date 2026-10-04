"""Compare compiled iOS PNG pixels with Folio's original opaque icon assets.

Only inspection copies are written. Source/catalog/compiled assets are never
modified. Apple's CgBI scanlines use raw deflate, BGRA and premultiplied alpha.
"""
from pathlib import Path
import argparse, hashlib, json, struct, zlib

SIGNATURE = b'\x89PNG\r\n\x1a\n'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def decode_png(data):
    if not data.startswith(SIGNATURE):
        raise ValueError('The icon is not a PNG.')
    offset, header, payload, cgbi, ended = 8, None, [], False, False
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError('Truncated PNG chunk.')
        size = struct.unpack_from('>I', data, offset)[0]
        tag = data[offset + 4:offset + 8]
        end = offset + size + 12
        if end > len(data):
            raise ValueError('Truncated PNG payload.')
        content = data[offset + 8:offset + 8 + size]
        checksum = struct.unpack_from('>I', data, offset + 8 + size)[0]
        if zlib.crc32(tag + content) & 0xffffffff != checksum:
            raise ValueError('The icon contains a PNG chunk with an invalid CRC.')
        if tag == b'CgBI':
            cgbi = True
        elif tag == b'IHDR':
            if header is not None or size != 13:
                raise ValueError('Invalid PNG header.')
            header = struct.unpack('>IIBBBBB', content)
        elif tag == b'IDAT':
            payload.append(content)
        elif tag == b'IEND':
            ended = True
            break
        offset = end
    if not ended or header is None:
        raise ValueError('The PNG has no complete header/end.')
    width, height, bits, color, compression, filtering, interlace = header
    if not (0 < width <= 2048 and 0 < height <= 2048 and bits == 8 and color in (2, 6)
            and compression == filtering == interlace == 0):
        raise ValueError(f'Unsupported icon PNG format: {header}')
    channels = 4 if color == 6 else 3
    stride = width * channels
    stream = zlib.decompressobj(-15 if cgbi else 15)
    raw = stream.decompress(b''.join(payload), height * (stride + 1) + 1) + stream.flush()
    if not stream.eof or stream.unused_data or len(raw) != height * (stride + 1):
        raise ValueError('Invalid PNG scanline size or compressed stream.')
    previous, decoded = bytearray(stride), bytearray()
    for y in range(height):
        start = y * (stride + 1)
        kind, row = raw[start], bytearray(raw[start + 1:start + stride + 1])
        if kind > 4:
            raise ValueError('Unsupported PNG row filter.')
        for x in range(stride):
            left = row[x - channels] if x >= channels else 0
            up = previous[x]
            upper_left = previous[x - channels] if x >= channels else 0
            if kind == 1:
                predictor = left
            elif kind == 2:
                predictor = up
            elif kind == 3:
                predictor = (left + up) // 2
            elif kind == 4:
                value = left + up - upper_left
                distances = abs(value - left), abs(value - up), abs(value - upper_left)
                predictor = left if distances[0] <= distances[1] and distances[0] <= distances[2] else up if distances[1] <= distances[2] else upper_left
            else:
                predictor = 0
            row[x] = (row[x] + predictor) & 255
        previous = row
        for x in range(0, stride, channels):
            red, green, blue = row[x:x + 3]
            alpha = row[x + 3] if channels == 4 else 255
            if cgbi:
                red, blue = blue, red
                if 0 < alpha < 255:
                    red, green, blue = (min(255, (component * 255 + alpha // 2) // alpha) for component in (red, green, blue))
            decoded.extend((red, green, blue, alpha))
    return width, height, bytes(decoded), cgbi


def inspection_png(width, height, rgba):
    def chunk(tag, content):
        return struct.pack('>I', len(content)) + tag + content + struct.pack('>I', zlib.crc32(tag + content) & 0xffffffff)
    stride = width * 4
    raw = b''.join(b'\0' + rgba[y * stride:(y + 1) * stride] for y in range(height))
    return SIGNATURE + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def compare_icon(compiled, reference, output):
    compiled, reference, output = Path(compiled), Path(reference), Path(output)
    actual_data, expected_data = compiled.read_bytes(), reference.read_bytes()
    width, height, actual, cgbi = decode_png(actual_data)
    expected_width, expected_height, expected, _ = decode_png(expected_data)
    if (width, height) != (expected_width, expected_height):
        raise ValueError(f'Wrong icon size: {compiled.name} is {width}x{height}, expected {expected_width}x{expected_height}.')
    if any(alpha != 255 for alpha in expected[3::4]):
        raise ValueError('The iOS reference icon must be opaque.')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(inspection_png(width, height, actual))
    differences = [abs(a - b) for a, b in zip(actual, expected)]
    return {'compiledName': compiled.name, 'sourceName': reference.name, 'width': width, 'height': height,
            'compiledPngSha256': digest(actual_data), 'sourcePngSha256': digest(expected_data),
            'compiledPixelSha256': digest(actual), 'sourcePixelSha256': digest(expected),
            'compiledFormat': 'CgBI' if cgbi else 'PNG', 'identicalPixels': actual == expected,
            'maximumChannelDifference': max(differences), 'meanChannelDifference': sum(differences) / len(differences),
            'inspectionFile': output.name}


def verify_compiled_icons(app, references, output):
    app, references, output = Path(app), Path(references), Path(output)
    icons = [compare_icon(app / compiled, references / source, output / ('icon-decoded-' + compiled))
             for compiled, source in [('AppIcon60x60@2x.png', 'AppIcon-60x60@2x.png'),
                                      ('AppIcon76x76@2x~ipad.png', 'AppIcon-76x76@2x.png')]]
    report = {'passed': all(icon['identicalPixels'] for icon in icons), 'kind': 'Folio compiled iOS icon pixels', 'icons': icons}
    (output / 'compiled-icons-ios.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    if not report['passed']:
        raise ValueError('The compiled iPhone/iPad icon differs from the original Folio icon; see compiled-icons-ios.json.')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--compiled', required=True, type=Path)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(compare_icon(args.compiled, args.reference, args.out), indent=2))
