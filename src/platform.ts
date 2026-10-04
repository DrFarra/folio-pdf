import { invoke, isTauri } from '@tauri-apps/api/core';
import { downloadBytes } from './pdf';
import type { Annotation } from './types';

export const isNative = isTauri();
export const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isMobile = isIOS || /Android/i.test(navigator.userAgent);
export const isDesktop = isNative && !isMobile;
export const isMac = !isIOS && /mac/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform);
export const shortcutLabel = (key: string) => `${isMac || isIOS ? '⌘' : 'Ctrl'}+${key}`;
export type NativeDocument = { token: string; name: string; size: number; id?: string; revision?: string };

export async function openExternalUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) throw new Error('Enlace no compatible.');
  if (isNative) await invoke('open_external_url', { url: url.href });
  else window.open(url.href, '_blank', 'noopener,noreferrer');
}

export async function presentNativePdf(token: string, name: string, action: 'save' | 'share' | 'print', annotations: Annotation[], removedSourceRefs: string[]): Promise<NativeDocument | boolean | null> {
  return invoke('native_pdf_present', { token, name, action, annotations, removedSourceRefs });
}
export async function nativeDraftDocument(id: string, name: string): Promise<NativeDocument | null> {
  return invoke('native_draft_document', { id, name });
}

export async function pickNativeDocument(): Promise<NativeDocument | null> {
  return invoke<NativeDocument | null>('pick_document');
}
export async function pickNativeDocuments(): Promise<NativeDocument[]> {
  return invoke<NativeDocument[]>('pick_documents');
}
export async function readNativeDocument(document: NativeDocument): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('read_document', { token: document.token }));
}
export async function startupDocument(): Promise<NativeDocument | null> {
  return isNative ? invoke<NativeDocument | null>('startup_document') : null;
}
export async function startupDocuments(): Promise<NativeDocument[]> {
  return isNative ? invoke<NativeDocument[]>('startup_documents') : [];
}
export async function savePdf(bytes: Uint8Array, name: string, source?: string): Promise<NativeDocument | boolean> {
  if (!isNative) { downloadBytes(bytes, name); return true; }
  const token = await invoke<string | null>('choose_output', { source: source || null, name });
  if (!token) return false;
  return await invoke<NativeDocument | null>('write_pdf_copy', new Uint8Array(bytes), { headers: { 'x-folio-output-token': token } }) || false;
}

async function presentMobilePdf(command: 'share_pdf_copy' | 'print_pdf_copy', bytes: Uint8Array, name: string, source?: string): Promise<boolean> {
  const token = await invoke<string | null>('choose_output', { source: source || null, name });
  if (!token) return false;
  return invoke<boolean>(command, new Uint8Array(bytes), { headers: { 'x-folio-output-token': token } });
}
export async function sharePdf(bytes: Uint8Array, name: string, source?: string): Promise<boolean> {
  if (isNative && isIOS) return presentMobilePdf('share_pdf_copy', bytes, name, source);
  const file = new File([new Uint8Array(bytes).buffer], name, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return false; throw error; }
  }
  return !!await savePdf(bytes, name, source);
}
export async function printPdf(bytes: Uint8Array, name: string, source?: string): Promise<boolean> {
  return presentMobilePdf('print_pdf_copy', bytes, name, source);
}
export async function copyNativeText(text: string): Promise<void> {
  return invoke<void>('copy_text', { text });
}
export async function saveExport(bytes: Uint8Array, name: string, format: 'txt' | 'html' | 'png' | 'jpg' | 'zip' | 'docx' | 'json', source?: string): Promise<boolean> {
  if (!isNative) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer]));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000); return true;
  }
  const token = await invoke<string | null>('choose_export', { source: source || null, name, format });
  if (!token) return false;
  const saved = await invoke<boolean | null>('write_export', new Uint8Array(bytes), { headers: { 'x-folio-output-token': token } });
  return saved !== false;
}
