import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { shouldShowWhatsNew } from '../components/WhatsNew';
import type { Transfer } from '../components/DriveBrowser';
import { driveStatus } from '../drive';
import { isNative } from '../platform';
import type { Annotation, RecentDocument } from '../types';
import type { NoteDraft } from './model';

/** Which dialogs, sheets and menus are open. */
export function useDialogs() {
  const [mobileActions, setMobileActions] = useState(false);
  const [mobileTabs, setMobileTabs] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pageJump, setPageJump] = useState(false);
  const [viewSettings, setViewSettings] = useState(false);
  const [annotationOptions, setAnnotationOptions] = useState(false);
  const [capabilityNotice, setCapabilityNotice] = useState(false);
  // The library entry waiting for its removal to be confirmed.
  const [deleteTarget, setDeleteTarget] = useState<RecentDocument | null>(null);
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState(false);
  // Ajustes asks once more before clearing the library.
  const [confirmClear, setConfirmClear] = useState(false);
  const [info, setInfo] = useState(false);
  const [palette, setPalette] = useState(false);
  const [whatsNew, setWhatsNew] = useState(shouldShowWhatsNew);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // The tab key, or 'window', whose closing waits because its session could not be saved.
  const [closeBlocked, setCloseBlocked] = useState<string | null>(null);
  return {
    mobileActions,
    setMobileActions,
    mobileTabs,
    setMobileTabs,
    creating,
    setCreating,
    pageJump,
    setPageJump,
    viewSettings,
    setViewSettings,
    annotationOptions,
    setAnnotationOptions,
    capabilityNotice,
    setCapabilityNotice,
    deleteTarget,
    setDeleteTarget,
    help,
    setHelp,
    settings,
    setSettings,
    confirmClear,
    setConfirmClear,
    info,
    setInfo,
    palette,
    setPalette,
    whatsNew,
    setWhatsNew,
    shortcutsOpen,
    setShortcutsOpen,
    closeBlocked,
    setCloseBlocked,
  };
}

/** The note being written or edited, its text, where it was opened from (the page or the
 * annotations list, which reopens after saving), and where its card shows: beside the
 * note's marker, or where a new note was clicked. */
export function useNoteEditor() {
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const [noteText, setNoteText] = useState('');
  const noteOrigin = useRef<'document' | 'list'>('document');
  const [noteAnchor, setNoteAnchor] = useState<{ left: number; top: number; right: number; bottom: number } | null>(
    null,
  );
  const lastPointer = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const remember = (event: PointerEvent) => {
      lastPointer.current = { x: event.clientX, y: event.clientY };
    };
    document.addEventListener('pointerdown', remember, true);
    return () => document.removeEventListener('pointerdown', remember, true);
  }, []);
  const noteKey = noteDraft ? (noteDraft.id ?? 'new') : null;
  useLayoutEffect(() => {
    if (!noteKey) return;
    const marker =
      noteKey !== 'new'
        ? document.querySelector(`.note-marker[data-note-id="${CSS.escape(noteKey)}"]`)?.getBoundingClientRect()
        : null;
    const { x, y } = lastPointer.current;
    setNoteAnchor(
      marker
        ? marker.bottom > 0 && marker.top < innerHeight
          ? marker
          : null
        : x || y
          ? { left: x, top: y, right: x + 26, bottom: y + 27 }
          : null,
    );
  }, [noteKey]);
  /** Opens the note card on a note (`origin`: where it was chosen) or a new one, with its text. */
  const editNote = (draft: NoteDraft | Annotation, origin: 'document' | 'list', text: string) => {
    noteOrigin.current = origin;
    setNoteDraft(draft);
    setNoteText(text);
  };
  return { noteDraft, setNoteDraft, noteText, setNoteText, noteOrigin, noteAnchor, editNote };
}

/** Google Drive in the app: whether this build can reach it, its browser in the library, the
 * step shown while saving there, edits that met a newer revision, and a download in progress. */
export function useDriveState() {
  const [driveAvailable, setDriveAvailable] = useState(isNative);
  const [driveLibrary, setDriveLibrary] = useState(false);
  const [driveMessage, setDriveMessage] = useState('');
  const [driveConflicts, setDriveConflicts] = useState<string[]>([]);
  const [driveRefresh, setDriveRefresh] = useState<Transfer | null>(null);
  // Builds without Google's OAuth client cannot connect to Drive.
  useEffect(() => {
    if (isNative)
      void driveStatus()
        .then(status => setDriveAvailable(status.available !== false))
        .catch(() => {});
  }, []);
  return {
    driveAvailable,
    driveLibrary,
    setDriveLibrary,
    driveMessage,
    setDriveMessage,
    driveConflicts,
    setDriveConflicts,
    driveRefresh,
    setDriveRefresh,
  };
}
