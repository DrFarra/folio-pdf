import { straightenPage } from './straighten';

/** A scanned page made straight (straightenPage); only a changed page comes back as new pixels. */
function straighten(bitmap: ImageBitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(bitmap, 0, 0);
  const { page, changed, angle, flattened } = straightenPage(
    canvas,
    (width, height) => new OffscreenCanvas(width, height),
  );
  return { bitmap: changed ? page.transferToImageBitmap() : undefined, angle, flattened };
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
