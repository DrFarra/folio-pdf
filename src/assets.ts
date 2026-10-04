/** Resolve bundled files using the active WebView origin, including tauri://. */
export function assetUrl(path: string): string {
  return new URL(path, document.baseURI || location.href).href;
}

export function pdfAssetSettings() {
  return {
    cMapUrl: assetUrl('/pdfjs/cmaps/'), cMapPacked: true,
    standardFontDataUrl: assetUrl('/pdfjs/standard_fonts/'),
    wasmUrl: assetUrl('/pdfjs/wasm/'),
  };
}
