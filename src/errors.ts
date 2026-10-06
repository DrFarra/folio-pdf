// Folio's own errors are already in Spanish. Known errors from PDF.js, MuPDF,
// the browser, Tauri and the operating system get an actionable equivalent, and
// any other English or internal text gets the caller's fallback.
const known: [RegExp, string][] = [
  [/AbortError|\baborted\b/i, 'La operación se canceló.'],
  [/Incorrect Password/i, 'La contraseña no es correcta.'],
  [/PasswordException|No password given/i, 'Este PDF está protegido. Escribe su contraseña.'],
  [/InvalidPDFException|Invalid PDF|startxref|\bxref\b|no objects found|object out of range|syntax error|zlib|cannot (open|load|recognize) document/i, 'El archivo no es un PDF válido o está dañado.'],
  [/out of memory|cannot allocate|allocation failed|Invalid array length/i, 'No hay memoria suficiente para este PDF. Cierra otros documentos y vuelve a intentarlo.'],
  [/memory access out of bounds|\bunreachable\b|RuntimeError/i, 'No se pudo procesar el PDF. El documento no cambió; vuelve a intentarlo.'],
  [/cannot be decoded|EncodingError/i, 'No se pudo leer la imagen. Elige otro archivo PNG o JPEG.'],
  [/QuotaExceeded|\bquota\b|os error (28|39|112)\b|No space left|not enough space|ENOSPC/i, 'No queda espacio de almacenamiento en este dispositivo.'],
  [/not allowed\. Permissions|Command \S+ not found|plugin \S+ not found/i, 'Esta función no está disponible en esta versión de Folio.'],
  [/os error (5|13)\b|permission denied|access is denied|EACCES|EPERM|NotAllowedError/i, 'Folio no tiene permiso para usar este archivo o esta carpeta.'],
  [/os error (2|3)\b|No such file|cannot find the (file|path)|ENOENT|NotFoundError/i, 'No se encontró el archivo. Puede que se haya movido o eliminado.'],
  [/os error (32|33)\b|used by another process|sharing violation|EBUSY/i, 'Otra aplicación está usando el archivo. Ciérrala y vuelve a intentarlo.'],
  [/os error 30\b|read-only file system|EROFS/i, 'Esta ubicación es de solo lectura. Elige otra.'],
  [/Failed to fetch|NetworkError|Load failed|timed out|ECONNREFUSED|ECONNRESET/i, 'No hay conexión. Comprueba la red y vuelve a intentarlo.'],
];
const english = /\b(the|cannot|can't|could not|failed|unable|invalid|denied|undefined|null|not|is|of|to|unexpected)\b/i;
const spanish = /[áéíóúñ¿¡«»]|\b(el|la|los|las|del|de|que|para|una?|se)\b/i;

export function errorMessage(error: unknown, fallback = 'No se pudo completar la operación.'): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const translated = known.find(([pattern]) => pattern.test(`${error instanceof Error ? error.name : ''} ${message}`));
  if (translated) return translated[1];
  return !message.trim() || english.test(message) && !spanish.test(message) ? fallback : message;
}
