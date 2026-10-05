# Descargas de Folio

Los instaladores y sus fuentes se publican en [GitHub Releases](https://github.com/FarraPY/folio-pdf/releases).
Las versiones indicadas aquí son las de los paquetes verificados, no solamente la versión del código fuente.

| Plataforma | Último paquete | Estado |
| --- | --- | --- |
| Android, tablet y teléfono (arm64) | [0.8.11](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.11) | APK firmado con la misma clave de desarrollo; instalar encima de la versión anterior. |
| Windows x64 | [0.8.11](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.11) | Instalador NSIS de producción. |
| macOS, Apple Silicon e Intel | [0.8.11](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.11) | DMG universal; compilación y pruebas nativas verificadas en el job 37354452186. Firma ad hoc, sin notarización. |
| iPhone e iPad | [0.8.3](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.3) | IPA sin certificado ni perfil de Apple, y paquete separado de simulador. Compilación 0.8.11 pendiente. |

## Cambios en 0.8.11

- Corrige el rechazo de bytes al guardar PDF locales, copias, borradores y ediciones de Drive en Android.
- Android envía archivos en formato compacto y lee los PDF por bloques para evitar grandes arrays JSON.
- Volver a la biblioteca no espera la exportación de Drive; los cambios permanecen en el documento abierto si falla la escritura.
- Agrupa guardados repetidos de una misma edición y permite reintentar una escritura fallida. Al salir al fondo conserva la sesión sin volver a exportar el PDF completo.
- Atrás de Android vuelve a la biblioteca; desde allí deja la actividad en segundo plano sin navegar en el historial del WebView.
- El zoom de Android queda dentro del lector y los gestos pendientes se cancelan al salir al fondo.
- Conserva la interfaz compacta de Drive y los controles separados de lápiz, resaltador y goma. En PC, «Usar el dedo» solo aparece después de detectar un lápiz.
- El código de iOS incorpora lectura, escritura y borrado de dibujos en el lector nativo de PDF grandes. Su validación nativa y su paquete actualizado están en curso.

## Verificación y límites

Se verificaron el recorrido de un PDF de Drive de 14 MB, seis ciclos de fondo/regreso, el tamaño de controles, fallos y reintentos de persistencia y las escrituras duplicadas. El ensayo usa el frontend real con un contrato Android de IPC; no sustituye una prueba física en la Tab S8+.

Un proceso Tauri real verificó por `postMessage` la escritura de 14 MB, su lectura idéntica byte por byte y que rechazar un contenido inválido conserva el borrador anterior. Las pruebas de proveedores Android cubren guardar en el original, permisos y protección frente a modificaciones externas.

El repositorio es público. La compilación Mac [37354452186](https://github.com/FarraPY/folio-pdf/actions/runs/37354452186) completó sus verificaciones nativas. La entrega iOS sigue pendiente de completar las pruebas en el simulador; su última IPA publicada conserva la versión 0.8.3.

Cada publicación incluye el código fuente correspondiente y sumas SHA-256. Los binarios se adjuntan a Releases para que el historial Git conserve el código, sin incorporar APK, DMG ni instaladores al árbol de fuentes.
