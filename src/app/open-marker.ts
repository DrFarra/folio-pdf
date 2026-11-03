import { formatSize } from '../pdf';
import { interruptedOpenMarker, isAndroid, isIOS, openMarker } from '../platform';
import type { OpenSource } from './document-reader';

type Marker = { name: string; size?: number; step: string; reloaded?: boolean };
const mark = (marker: Marker | null) => openMarker(marker && JSON.stringify(marker));
let latest = 0;
// Rust read the last run's marker at launch, before anything new opened; after iOS reloads a
// WebView whose process died, it gives this run's own marker instead.
const previous = isIOS || isAndroid ? interruptedOpenMarker() : Promise.resolve(null);

/** While a native PDF opens on a phone or tablet, and for 15 s after it is shown, Folio keeps on
 * disk which file and step it is at. If the system ends Folio meanwhile (memory, a crash), the
 * next launch knows. Desktop does not need it: quitting there right after opening is common. */
export async function watchOpen<T>(source: OpenSource, name: string, open: () => Promise<T>): Promise<T> {
  if (!(isIOS || isAndroid) || typeof source !== 'object' || !('token' in source)) return open();
  const id = ++latest;
  await mark({ name, size: source.size, step: 'abría' });
  try {
    const result = await open();
    if (id === latest) await mark({ name, size: source.size, step: 'mostraba' });
    return result;
  } finally {
    setTimeout(() => {
      if (id === latest) void mark(null);
    }, 15_000);
  }
}

/** The system file picker copies the chosen PDF before Folio sees it. */
export const watchImport = (picking: boolean) =>
  isIOS || isAndroid ? mark(picking ? { name: '', step: 'importaba' } : null) : Promise.resolve();

/** True when this page is a reload after its WebView process died: the documents Folio
 * started with are not opened again, since one of them may have ended that process. */
export const reloadedAfterInterruption = () =>
  previous.then(value => {
    try {
      return !!value && !!(JSON.parse(value) as Marker).reloaded;
    } catch {
      return false;
    }
  });

/** What was being opened when the last run ended without finishing, as a message. */
export async function interruptedOpen(): Promise<string | null> {
  try {
    const value = await previous;
    if (!value) return null;
    const { name, size, step } = JSON.parse(value) as Marker;
    const file = name ? `«${name}»${size ? ` (${formatSize(size)})` : ''}` : 'un PDF';
    return `Folio se interrumpió mientras ${step} ${file}, así que no lo ha vuelto a abrir. Puedes abrirlo desde la biblioteca.`;
  } catch {
    return null;
  }
}
