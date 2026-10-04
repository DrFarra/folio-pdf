import { invoke, isTauri } from '@tauri-apps/api/core';
import { downloadBytes } from './pdf';

export const isDesktop = isTauri();
export const isMac = /mac/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform);
export const shortcutLabel = (key: string) => `${isMac ? '⌘' : 'Ctrl'}+${key}`;
export type NativeDocument = { token: string; name: string; size: number };

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
  return isDesktop ? invoke<NativeDocument | null>('startup_document') : null;
}
export async function startupDocuments(): Promise<NativeDocument[]> {
  return isDesktop ? invoke<NativeDocument[]>('startup_documents') : [];
}
export async function savePdf(bytes: Uint8Array, name: string, source?: string): Promise<NativeDocument | boolean> {
  if (!isDesktop) { downloadBytes(bytes, name); return true; }
  const token = await invoke<string | null>('choose_output', { source: source || null, name });
  if (!token) return false;
  return invoke<NativeDocument>('write_pdf_copy', new Uint8Array(bytes), { headers: { 'x-folio-output-token': token } });
}
export async function saveExport(bytes: Uint8Array, name: string, format: 'txt' | 'html' | 'png' | 'jpg' | 'zip' | 'docx' | 'json', source?: string): Promise<boolean> {
  if (!isDesktop) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer]));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000); return true;
  }
  const token = await invoke<string | null>('choose_export', { source: source || null, name, format });
  if (!token) return false;
  await invoke('write_export', new Uint8Array(bytes), { headers: { 'x-folio-output-token': token } }); return true;
}
