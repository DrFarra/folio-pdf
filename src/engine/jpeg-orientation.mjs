// PDF viewers ignore the EXIF orientation of JPEG data, while galleries and
// browsers apply it. Callers rotate camera photos explicitly when placing them.

/** EXIF orientation (1-8) of JPEG bytes; 1 when absent or unreadable. */
export function jpegOrientation(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 2; offset + 4 <= bytes.length;) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0xda || marker === 0xd9) return 1;
    const end = offset + 2 + data.getUint16(offset + 2);
    if (end > bytes.length) return 1;
    if (marker === 0xe1 && end - offset >= 18 && data.getUint32(offset + 4) === 0x45786966 && data.getUint16(offset + 8) === 0) {
      const tiff = offset + 10, little = data.getUint16(tiff) === 0x4949;
      const ifd = tiff + data.getUint32(tiff + 4, little);
      if (ifd + 2 > end) return 1;
      for (let entry = ifd + 2, count = data.getUint16(ifd, little); count-- > 0 && entry + 12 <= end; entry += 12) {
        if (data.getUint16(entry, little) !== 0x0112) continue;
        const value = data.getUint16(entry + 8, little);
        return value >= 1 && value <= 8 ? value : 1;
      }
      return 1;
    }
    offset = end;
  }
  return 1;
}

/** Maps an image's unit square to its upright view, with y pointing down as in
 * MuPDF device space. Orientations 5-8 swap the displayed width and height. */
export function orientationMatrix(orientation) {
  return [[1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, 1, 0], [-1, 0, 0, -1, 1, 1], [1, 0, 0, -1, 0, 1],
    [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, 1, 0], [0, -1, -1, 0, 1, 1], [0, -1, 1, 0, 0, 1]][orientation - 1] ?? [1, 0, 0, 1, 0, 0];
}
