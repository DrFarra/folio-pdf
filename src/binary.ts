import { invoke, type InvokeOptions } from '@tauri-apps/api/core';

// Tauri on Android sends typed arrays as JSON number arrays. A 14 MB PDF
// then creates millions of JS/Java/Rust values. Base64 uses one compact
// string instead, and FileReader encodes it without a large JS byte loop.
export async function invokeBinary<T>(command: string, bytes: Uint8Array, options: InvokeOptions): Promise<T> {
  if (!/Android/i.test(navigator.userAgent)) return invoke<T>(command, bytes, options);
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.onerror = () => reject(reader.error || new Error('No se pudo preparar el archivo.'));
    reader.readAsDataURL(new Blob([new Uint8Array(bytes).buffer]));
  });
  return invoke<T>(command, { base64 }, options);
}
