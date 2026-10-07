import { invokeBinary } from './binary';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { NativeDocument } from './platform';
import type { Annotation } from './types';
export type DriveAccount = { id: string; email: string; name: string };
export type DriveBinding = { binding: string; account: string; fileId: string; baseChecksum: string; editable: boolean };
export type DriveOpened = DriveBinding & { document: NativeDocument; offline: boolean; transferred: number };
export type DriveItem = { id: string; title: string; mimeType: string; fileSize?: string; modifiedDate?: string; editable?: boolean };
export type DrivePending = { id: string; binding: string; account: string; fileId: string; name: string; created: number; size: number; conflict?: boolean };
// `available` is false in desktop builds without Google's OAuth client.
export type DriveStatus = { available?: boolean; account: DriveAccount | null; pending: DrivePending[] };
export type DriveSync = { status: 'saved' | 'conflict'; opened: DriveOpened | null; message: string };
export const driveStatus = () => invoke<DriveStatus>('drive_status');
export const driveConnect = () => invoke<DriveAccount>('drive_connect');
export const driveCancelConnect = () => invoke<void>('drive_cancel_connect');
export const driveDisconnect = () => invoke<void>('drive_disconnect');
export const driveList = (folder: string, search = '', pageToken?: string) => invoke<{ items?: DriveItem[]; nextPageToken?: string }>('drive_list', { folder, search, pageToken });
export const driveCached = () => invoke<{ items: DriveItem[] }>('drive_cached');
/** Reported while opening: bytes of the file downloaded so far, then its verification. */
export type DriveProgress = { phase: 'connect' | 'download' | 'verify'; done: number; total: number };
export const driveOpen = (fileId: string, offline = false, onProgress?: (progress: DriveProgress) => void) => {
  const channel = new Channel<DriveProgress>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke<DriveOpened>('drive_open', { fileId, offline, onProgress: channel });
};
export const driveLookup = (token: string) => invoke<DriveBinding | null>('drive_lookup', { token });
export const driveStage = (binding: string, bytes: Uint8Array) => invokeBinary<DrivePending>('drive_stage', bytes, { headers: { 'x-folio-drive-binding': binding } });
export const driveStageNative = (binding: string, token: string, annotations: Annotation[], removedSourceRefs: string[]) => invoke<DrivePending>('drive_stage_native', { binding, token, annotations, removedSourceRefs });
export const driveSync = (id: string, conflictCopy = false) => invoke<DriveSync>('drive_sync', { id, conflictCopy });
export const drivePendingOpen = (id: string) => invoke<DriveOpened>('drive_pending_open', { id });
export const driveDiscard = (id: string) => invoke<void>('drive_discard', { id });
