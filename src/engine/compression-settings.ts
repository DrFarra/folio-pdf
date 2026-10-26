// Comprimir PDF's levels, apart from the engine so the interface does not load MuPDF.

/** How hard Comprimir PDF works on images. `quality` 0 keeps every image as it is (lossless). */
export type CompressionSettings = {
  /** Highest resolution kept for an image at the size it is shown on the page, in pixels per inch. */
  resolution: number;
  /** JPEG quality for photographs, 30–95. */
  quality: number;
};

export const COMPRESSION_PRESETS = {
  lossless: { resolution: 0, quality: 0 },
  high: { resolution: 300, quality: 88 },
  balanced: { resolution: 200, quality: 80 },
  strong: { resolution: 150, quality: 70 },
  maximum: { resolution: 100, quality: 55 },
} satisfies Record<string, CompressionSettings>;

export function validCompression(settings: unknown): settings is CompressionSettings {
  if (!settings || typeof settings !== 'object') return false;
  const { resolution, quality } = settings as CompressionSettings;
  return (
    Number.isFinite(resolution) &&
    Number.isFinite(quality) &&
    (quality === 0 || (quality >= 30 && quality <= 95)) &&
    (resolution === 0 || (resolution >= 50 && resolution <= 1200))
  );
}
