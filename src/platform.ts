import { invokeBinary } from './binary';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { downloadBytes } from './pdf';
import type { Annotation } from './types';

// Android and iOS hide their system bars while the reader's controls are hidden.
export async function setReaderChrome(visible: boolean): Promise<void> {
  await invoke('set_mobile_chrome', { visible });
}

export const isNative = isTauri();
/** A short haptic on phones and tablets; elsewhere it does nothing. Fire and forget. */
export function haptic(kind: 'selection' | 'light' | 'medium' | 'success'): void {
  if (!isTauri() || !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return;
  void invoke('haptic', { kind }).catch(() => {});
}
/** iOS: while PDF text is selected Folio's toolbar replaces the system edit menu, which would cover it. */
export function setCustomTextMenu(on: boolean): void {
  (window as Window & { webkit?: { messageHandlers?: { folioTextMenu?: { postMessage(value: boolean): void } } } }).webkit?.messageHandlers?.folioTextMenu?.postMessage(on);
}
/** Keeps the screen on while reading on a phone or tablet; elsewhere it does nothing. */
export async function setKeepAwake(on: boolean): Promise<void> {
  if (!isTauri() || !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return;
  await invoke('set_keep_awake', { on }).catch(() => {});
}
export const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/i.test(navigator.userAgent);
export const isMobile = isIOS || isAndroid;
export const isDesktop = isNative && !isMobile;
export const isMac = !isIOS && /mac/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform);
// Apple writes ⇧⌘S; Windows and Linux write Ctrl+Mayús+S.
export const shortcutLabel = (key: string, shift = false) => isMac || isIOS ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Mayús+' : ''}${key}`;
export type NativeDocument = { token: string; name: string; size: number; id?: string; revision?: string };
// The control that opened Share or Print, in CSS pixels: iPad shows its popover there.
export type Anchor = { left: number; top: number; width: number; height: number };

export async function openExternalUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) throw new Error('Enlace no compatible.');
  if (isNative) await invoke('open_external_url', { url: url.href });
  else window.open(url.href, '_blank', 'noopener,noreferrer');
}

export async function presentNativePdf(token: string, name: string, action: 'save' | 'share' | 'print', annotations: Annotation[], removedSourceRefs: string[], anchor?: Anchor): Promise<NativeDocument | boolean | null> {
  return invoke('native_pdf_present', { token, name, action, annotations, removedSourceRefs, anchor: anchor ? [anchor.left, anchor.top, anchor.width, anchor.height] : null });
}
export async function nativeDraftDocument(id: string, name: string): Promise<NativeDocument | null> {
  return invoke('native_draft_document', { id, name });
}

export async function pickNativeDocuments(): Promise<NativeDocument[]> {
  return invoke<NativeDocument[]>('pick_documents');
}
export async function readNativeDocument(document: NativeDocument): Promise<Uint8Array> {
  if (isAndroid) {
    // Android's JSON response bridge must never materialize the entire PDF as
    // millions of numbers at once. Yield between bounded reads on that bridge.
    const bytes = new Uint8Array(document.size);
    for (let offset = 0; offset < bytes.length;) {
      const length = Math.min(256 * 1024, bytes.length - offset);
      const chunk = new Uint8Array(await invoke<ArrayBuffer>('read_document_range', { token: document.token, offset, length }));
      if (chunk.length !== length) throw new Error('El PDF cambió durante la lectura. Vuelve a abrirlo.');
      bytes.set(chunk, offset); offset += length;
    }
    return bytes;
  }
  return new Uint8Array(await invoke<ArrayBuffer>('read_document', { token: document.token }));
}
export async function startupDocuments(): Promise<NativeDocument[]> {
  return isNative ? invoke<NativeDocument[]>('startup_documents') : [];
}
export async function savePdf(bytes: Uint8Array, name: string, source?: string): Promise<NativeDocument | boolean> {
  if (!isNative) { downloadBytes(bytes, name); return true; }
  const token = await invoke<string | null>('choose_output', { source: source || null, name });
  if (!token) return false;
  return await invokeBinary<NativeDocument | null>('write_pdf_copy', bytes, { headers: { 'x-folio-output-token': token } }) || false;
}

// Windows and macOS replace the opened file without a dialog and throw if it
// changed on disk since it was opened; Android writes through its document provider.
export async function saveOriginalPdf(bytes: Uint8Array, name: string, source: string): Promise<NativeDocument | false> {
  const headers: Record<string, string> = { 'x-folio-source-token': source };
  if (isAndroid) {
    const token = await invoke<string | null>('choose_output', { source, name });
    if (!token) return false;
    headers['x-folio-output-token'] = token;
  }
  return await invokeBinary<NativeDocument | null>('write_pdf_original', bytes, { headers }) || false;
}
// Android and iOS: deletes the private PDF copies that neither the library nor these open documents use.
export async function prunePrivateCopies(keep: string[]): Promise<void> {
  if (isNative && isMobile) await invoke('prune_private_copies', { keep });
}

async function presentMobilePdf(command: 'share_pdf_copy' | 'print_pdf_copy', bytes: Uint8Array, name: string, source?: string, anchor?: Anchor): Promise<boolean> {
  const token = await invoke<string | null>('choose_output', { source: source || null, name });
  if (!token) return false;
  const headers: Record<string, string> = { 'x-folio-output-token': token };
  if (anchor) headers['x-folio-anchor'] = [anchor.left, anchor.top, anchor.width, anchor.height].join(',');
  return invokeBinary<boolean>(command, bytes, { headers });
}
export async function sharePdf(bytes: Uint8Array, name: string, source?: string, anchor?: Anchor): Promise<boolean> {
  if (isNative && isMobile) return presentMobilePdf('share_pdf_copy', bytes, name, source, anchor);
  const file = new File([new Uint8Array(bytes).buffer], name, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return false; throw error; }
  }
  return !!await savePdf(bytes, name, source);
}
export async function printPdf(bytes: Uint8Array, name: string, source?: string, anchor?: Anchor): Promise<boolean> {
  return presentMobilePdf('print_pdf_copy', bytes, name, source, anchor);
}
export async function copyNativeText(text: string): Promise<void> {
  return invoke<void>('copy_text', { text });
}
export async function saveExport(bytes: Uint8Array, name: string, format: 'txt' | 'zip' | 'docx', source?: string): Promise<boolean> {
  if (!isNative) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer]));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000); return true;
  }
  const token = await invoke<string | null>('choose_export', { source: source || null, name, format });
  if (!token) return false;
  const saved = await invokeBinary<boolean | null>('write_export', bytes, { headers: { 'x-folio-output-token': token } });
  return saved !== false;
}
