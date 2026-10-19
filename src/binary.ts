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
// Windows' WebView hands Folio a request's body slowly, on the window's thread (a
// 238 MB PDF in 4 MiB requests held the window until the WebView closed), so a large
// PDF is written into memory Folio shares with the page, in slices the page runs between.
const PART = 4 * 1024 * 1024;
type SharedBufferEvent = Event & {
  additionalData: { folioUpload?: string; folioDownload?: string };
  getBuffer(): ArrayBuffer;
};
type WebView2 = {
  addEventListener(type: 'sharedbufferreceived', listener: (event: SharedBufferEvent) => void): void;
  removeEventListener(type: 'sharedbufferreceived', listener: (event: SharedBufferEvent) => void): void;
  releaseBuffer(buffer: ArrayBuffer): void;
};
async function sendShared(webview: WebView2, bytes: Uint8Array): Promise<string> {
  const id = crypto.randomUUID();
  let listener!: (event: SharedBufferEvent) => void;
  const received = new Promise<ArrayBuffer>(resolve => {
    listener = event => {
      if (event.additionalData?.folioUpload === id) resolve(event.getBuffer());
    };
  });
  webview.addEventListener('sharedbufferreceived', listener);
  try {
    await invoke('upload_shared', { id, size: bytes.length });
    const buffer = await received,
      target = new Uint8Array(buffer);
    for (let offset = 0; offset < bytes.length; offset += PART) {
      target.set(bytes.subarray(offset, offset + PART), offset);
      await new Promise(resolve => setTimeout(resolve));
    }
    webview.releaseBuffer(buffer);
    await invoke('upload_shared_end', { id });
    return id;
  } finally {
    webview.removeEventListener('sharedbufferreceived', listener);
  }
}
/** Windows: a large PDF read the other way, Folio filling shared memory from disk (`read_document_shared`).
 * It is copied out in slices the page runs between; null where memory cannot be shared. */
export async function readShared(token: string, size: number): Promise<Uint8Array | null> {
  const webview = (window as { chrome?: { webview?: WebView2 } }).chrome?.webview;
  if (!webview) return null;
  const id = crypto.randomUUID();
  let listener!: (event: SharedBufferEvent) => void;
  const received = new Promise<ArrayBuffer>(resolve => {
    listener = event => {
      if (event.additionalData?.folioDownload === id) resolve(event.getBuffer());
    };
  });
  webview.addEventListener('sharedbufferreceived', listener);
  try {
    // An older WebView2 cannot share memory: the caller reads in slices instead.
    try {
      await invoke('read_document_shared', { token, id });
    } catch {
      return null;
    }
    const buffer = await received;
    try {
      const source = new Uint8Array(buffer),
        bytes = new Uint8Array(size);
      if (source.length !== size) throw new Error('El PDF cambió durante la lectura. Vuelve a abrirlo.');
      for (let offset = 0; offset < size; offset += 8 * PART) {
        bytes.set(source.subarray(offset, offset + 8 * PART), offset);
        await new Promise(resolve => setTimeout(resolve));
      }
      return bytes;
    } finally {
      webview.releaseBuffer(buffer);
      void invoke('release_shared', { id });
    }
  } finally {
    webview.removeEventListener('sharedbufferreceived', listener);
  }
}
export async function invokeBinary<T>(command: string, bytes: Uint8Array, options: InvokeOptions): Promise<T> {
  const webview = (window as { chrome?: { webview?: WebView2 } }).chrome?.webview;
  if (webview && bytes.length > PART) return invoke<T>(command, { upload: await sendShared(webview, bytes) }, options);
  if (!/Android/i.test(navigator.userAgent)) return invoke<T>(command, bytes, options);
  if (bytes.length <= SLICE) return invoke<T>(command, { base64: await toBase64(bytes) }, options);
  const upload = await invoke<string>('upload_begin');
  for (let offset = 0; offset < bytes.length; offset += SLICE)
    await invoke('upload_chunk', { id: upload, base64: await toBase64(bytes.subarray(offset, offset + SLICE)) });
  return invoke<T>(command, { upload }, options);
}
