import { flatTilt, flatten, flattenField, inkMask, marginTilt, shrink, skewAngle } from './straighten';

/**
 * A scanned page made straight for reading: turned by its tilt, then flattened when
 * its lines curve. Only a turned or flattened page comes back as new pixels; a turn
 * is redone on the PDF's own content, without recompressing the scan.
 */
function straighten(bitmap: ImageBitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(bitmap, 0, 0);
  const read = (source: OffscreenCanvas) => {
    const image = source
      .getContext('2d', { willReadFrequently: true })!
      .getImageData(0, 0, source.width, source.height);
    const sample = shrink({ data: image.data, width: image.width, height: image.height, channels: 4 });
    return { image, sample, mask: inkMask(sample) };
  };
  let page = canvas,
    { image, sample, mask } = read(canvas);
  const turn = (degrees: number) => {
    if (page !== canvas) {
      page.width = 0;
      page.height = 0;
    }
    page = canvas;
    if (Math.abs(degrees) >= 0.1) {
      page = new OffscreenCanvas(canvas.width, canvas.height);
      const context = page.getContext('2d', { willReadFrequently: true })!;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, page.width, page.height);
      context.translate(page.width / 2, page.height / 2);
      context.rotate((degrees * Math.PI) / 180);
      context.translate(-page.width / 2, -page.height / 2);
      context.drawImage(canvas, 0, 0);
    }
    ({ image, sample, mask } = read(page));
  };
  let angle = skewAngle(mask, sample.width, sample.height);
  if (angle) turn(angle);
  let field = flattenField(mask, sample.width, sample.height);
  if (field) {
    // A curve pulls the page's angle: the margin, which stays straight, says the true turn.
    const extra = marginTilt(mask, sample.width, sample.height) ?? flatTilt(mask, sample.width, sample.height);
    if (extra) {
      angle = Math.round((angle + extra) * 100) / 100;
      turn(angle);
      field = flattenField(mask, sample.width, sample.height);
    }
  }
  if (field) {
    image.data.set(
      flatten({ data: image.data, width: image.width, height: image.height, channels: 4 }, field, 1 / sample.scale),
    );
    page.getContext('2d')!.putImageData(image, 0, 0);
  }
  return { bitmap: page !== canvas || field ? page.transferToImageBitmap() : undefined, angle, flattened: !!field };
}

self.onmessage = (event: MessageEvent<ImageBitmap>) => {
  try {
    const result = straighten(event.data);
    self.postMessage(result, { transfer: result.bitmap ? [result.bitmap] : [] });
  } catch (error) {
    self.postMessage({ error: (error instanceof Error && error.message) || 'No se pudo enderezar la página.' });
  } finally {
    event.data.close();
  }
};
