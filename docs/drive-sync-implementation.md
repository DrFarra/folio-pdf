# Drive en Folio — implementación y validación

5 de octubre de 2026. Android 0.8.9 incorpora la integración de Drive y conserva
la ruta de guardado en el archivo original de Android de la otra tarea.

## Uso

Documentos → Google Drive → Iniciar sesión con Google. Se muestran las carpetas
de Mi unidad y Compartidos conmigo; la búsqueda se limita a la carpeta actual.
Hay paginación y una sección Sin conexión con los PDF descargados previamente.
Los archivos de Google Docs/Sheets no se convierten ni editan como PDF.

Guardar en Drive actualiza el `fileId` abierto, conservando su carpeta y los
cambios de nombre/movimientos remotos. Guardar una copia sigue siendo una acción
local separada. El guardado del proveedor de archivos de Android y el de Drive
usan rutas distintas; nunca se considera que sobrescribir la caché sea guardar
en la nube.

La sincronización se confirma al pulsar Guardar. Los cambios se conservan como
ediciones pendientes antes de subir y al cerrar/cambiar una pestaña modificada.
Sin conexión, el usuario puede reintentar desde Ediciones pendientes. No hay
subidas de fondo periódicas ni se reemplaza una pestaña modificada automáticamente.
Al abrir un archivo desde Drive se consultan sus metadatos actuales. Las versiones
remotas diferentes pueden abrirse en pestañas distintas para comparar.

## Concurrencia y recuperación

- Drive API v2 conserva el ETag de metadatos. La subida multipart envía If-Match.
  Se probó contra Google, incluyendo dos escrituras distintas lanzadas juntas
  con una barrera: una fue aceptada y la otra recibió HTTP 412.
- Un hash distinto al de la base impide sobrescribir. Cambios de metadatos sin
  cambio de contenido se conservan mediante una nueva precondición del ETag actual.
- La cola local se escribe atómicamente antes de la red, conserva el PDF completo
  y se elimina solo después de verificar el hash y tamaño confirmados por Drive.
- Una respuesta perdida se reconcilia por hash/tamaño. Las copias de conflicto
  reservan y persisten un ID de Drive antes de crearse, evitando duplicados al
  reintentar tras una respuesta incierta.
- Ante conflicto se conserva la edición local y el original remoto. El usuario
  puede guardar una copia de conflicto; no hay fusión automática de PDF binarios
  ni una opción de reemplazo forzado que omita la precondición.
- Cuenta, `fileId` y contenido de la base separan sesiones y borradores. Los
  documentos con bytes idénticos en carpetas/cuentas distintas no comparten edición.
- Las copias locales son inmutables mientras un lector las utiliza. Desconectar
  elimina la sesión del dispositivo y conserva las copias y la cola local.

## PDFs grandes

Las anotaciones compatibles se guardan incrementalmente con MuPDF. Un máximo de
16 bases verificadas se describe en propiedades del archivo. Si una copia local
coincide con una de ellas, se solicitan únicamente los bytes posteriores mediante
Range. El tamaño y MD5 del resultado completo deben coincidir con los metadatos
de Drive antes de utilizarlo. El ETag de metadatos **no** se usa para descargas:
Google usa una representación distinta para el contenido.

La primera apertura requiere descargar el PDF. Una reescritura completa, cambios
externos o una base demasiado antigua necesitan otra descarga completa. Editar
texto, reorganizar, comprimir o censurar puede reescribir el PDF; la eliminación
segura mediante censura conserva su ruta de reescritura completa. La subida actual
envía el PDF entero, en streaming nativo. No se confunde carga reanudable con delta.

El lector Android existente aún procesa el PDF con PDF.js/MuPDF en memoria: estas
mejoras reducen tráfico, pero no garantizan que cualquier PDF de 500 MB entre en la
memoria de cualquier tablet. El lector nativo de iOS dispone de exportación
incremental por archivo para documentos grandes; falta comprobar este flujo con
Drive en un iPhone/iPad físico.

## Autenticación

- Escritorio: navegador del sistema, loopback aleatorio, state y PKCE S256.
  Refresh token en el almacén seguro de Windows/macOS. Las credenciales instaladas
  se leen al compilar desde FOLIO_GOOGLE_DESKTOP_CREDENTIALS o, en esta estación,
  `%LOCALAPPDATA%/Folio/developer-credentials/folio-desktop-oauth.json`. No están en Git.
- Android: Google Identity Services AuthorizationClient; requiere Google Play
  Services y certificado de firma que coincida con el cliente OAuth configurado.
- iOS: ASWebAuthenticationSession, PKCE, esquema inverso registrado y llavero.
- Los tokens permanecen en nativo; ningún comando de la interfaz devuelve tokens.
  No se desactiva la validación TLS ni se amplía el CSP para exponer credenciales.
- Google sigue en Testing. Otras cuentas requieren acceso de prueba y la salida
  pública sigue pendiente de la verificación de Google correspondiente al alcance.

## Pruebas

- `npm run build`: TypeScript y compilación del frontend.
- `node scripts/tests/drive.mjs`: anotación/eliminación incremental e inspección
  real de PDF; carpetas, búsqueda, fallo de red, conflictos y separación del guardado
  Android en interfaces de teléfono, tablet y escritorio mediante un contrato IPC.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib drive::tests`: pruebas
  locales de prefijos verificados e identificadores de almacenamiento.
- Prueba nativa real, ignorada por defecto:
  `cargo test --manifest-path src-tauri/Cargo.toml --lib drive::tests::live_roundtrip_and_conflict -- --ignored`.
  Requiere FOLIO_DRIVE_TEST_TOKEN (ruta privada a un token temporal),
  FOLIO_DRIVE_TEST_PDF (PDF incremental sobre public/sample.pdf) y concurrent.pdf
  junto al anterior. Solo crea PDF de prueba y los envía a la papelera al terminar.
  Verifica descarga completa, caché sin red de contenido, Range, actualización
  del mismo ID, rechazo de ETag antiguo, reescritura externa, carrera simultánea,
  copia de conflicto en la misma carpeta y conservación del original.

No se ha probado el consentimiento OAuth en una tablet Android física: no hay
un dispositivo conectado a esta estación. Tampoco se ha compilado ni probado el
cambio iOS desde Windows. Las pruebas con mocks no sustituyen esas verificaciones.
