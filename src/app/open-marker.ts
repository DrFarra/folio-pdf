import { formatSize } from '../pdf';
import { isAndroid, isIOS, openMarker } from '../platform';
import type { OpenSource } from './document-reader';

type Marker = { name: string; size?: number; step: string };
const mark = (marker: Marker | null) => openMarker(marker && JSON.stringify(marker));
let latest = 0;
// Read before anything opens: the marker left by the last run, if it ended mid-open.
const previous = isIOS || isAndroid ? openMarker(null) : Promise.resolve(null);

/** While a native PDF opens on a phone or tablet, and for 15 s after it is shown, Folio keeps on
 * disk which file and step it is at. If the system ends Folio meanwhile (memory, a crash), the
 * next launch knows. Desktop does not need it: quitting there right after opening is common. */
export async function watchOpen<T>(source: OpenSource, name: string, open: () => Promise<T>): Promise<T> {
  if (!(isIOS || isAndroid) || typeof source !== 'object' || !('token' in source)) return open();
  const id = ++latest;
  await previous;
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
  isIOS || isAndroid ? previous.then(() => mark(picking ? { name: '', step: 'importaba' } : null)) : previous;

/** What was being opened when the last run ended without finishing, as a message. */
export async function interruptedOpen(): Promise<string | null> {
  try {
    const value = await previous;
    if (!value) return null;
    const { name, size, step } = JSON.parse(value) as Marker;
    const file = name ? `«${name}»${size ? ` (${formatSize(size)})` : ''}` : 'un PDF';
    return `Folio se cerró la última vez mientras ${step} ${file}, así que no lo ha vuelto a abrir. Puedes abrirlo desde la biblioteca.`;
  } catch {
    return null;
  }
}
