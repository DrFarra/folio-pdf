import { invoke, type InvokeOptions } from '@tauri-apps/api/core';

// Tauri on Android sends typed arrays as JSON number arrays. A 14 MB PDF
// then creates millions of JS/Java/Rust values. Base64, which FileReader
// encodes without a large JS byte loop, goes in one message up to 2 MiB;
// Rust stages larger files slice by slice and the command takes the result.
const SLICE = 2 * 1024 * 1024;
function toBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.onerror = () => reject(reader.error || new Error('No se pudo preparar el archivo.'));
    reader.readAsDataURL(new Blob([bytes.slice()]));
  });
}
export async function invokeBinary<T>(command: string, bytes: Uint8Array, options: InvokeOptions): Promise<T> {
  if (!/Android/i.test(navigator.userAgent)) return invoke<T>(command, bytes, options);
  if (bytes.length <= SLICE) return invoke<T>(command, { base64: await toBase64(bytes) }, options);
  const upload = await invoke<string>('upload_begin');
  for (let offset = 0; offset < bytes.length; offset += SLICE) await invoke('upload_chunk', { id: upload, base64: await toBase64(bytes.subarray(offset, offset + SLICE)) });
  return invoke<T>(command, { upload }, options);
}
