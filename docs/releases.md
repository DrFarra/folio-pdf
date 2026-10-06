# Descargas de Folio

Los instaladores y su código fuente se publican en [GitHub Releases](https://github.com/FarraPY/folio-pdf/releases).
Cada fila indica el último paquete publicado de esa plataforma, que puede ser anterior a la versión del código.

| Plataforma | Último paquete | Estado |
| --- | --- | --- |
| Android, tablet y teléfono (arm64) | [0.8.11](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.11) | APK firmado con la misma clave de desarrollo; instalar encima de la versión anterior. |
| Windows x64 | [0.8.11](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.11) | Instalador NSIS sin firma Authenticode. |
| macOS, Apple Silicon e Intel | [0.8.11](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.11) | DMG universal con firma ad hoc, sin notarización. |
| iPhone e iPad | [0.8.3](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.3) | IPA sin certificado ni perfil de Apple, para firmar con Feather. Compilación 0.8.11 pendiente. |

## Cambios en 0.8.11

- Corrige el rechazo de bytes al guardar PDF locales, copias, borradores y ediciones de Drive en Android.
- Android envía archivos en formato compacto y lee los PDF por bloques para evitar grandes arrays JSON.
- Volver a la biblioteca no espera la exportación de Drive; los cambios permanecen en el documento abierto si falla la escritura.
- Agrupa guardados repetidos de una misma edición y permite reintentar una escritura fallida. Al salir al fondo conserva la sesión sin volver a exportar el PDF completo.
- Atrás de Android vuelve a la biblioteca; desde allí deja la actividad en segundo plano sin navegar en el historial del WebView.
- El zoom de Android queda dentro del lector y los gestos pendientes se cancelan al salir al fondo.
- Conserva la interfaz compacta de Drive y los controles separados de lápiz, resaltador y goma.
- El lector de PDF grandes de iOS permite dibujar y borrar dibujos.

Las notas de versiones anteriores están en cada publicación de GitHub Releases y en el historial de Git.

## Publicar

Cada plataforma se compila en su propio sistema, con la misma versión en `package.json`,
`Cargo.toml` y la configuración Tauri (`npm run build` lo comprueba).

| Plataforma | Compilar | Empaquetar |
| --- | --- | --- |
| Windows | `npm run desktop:windows -- --ci -- --locked` | Instalador en `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/` |
| macOS | Workflow `macos.yml` o `npm run desktop:macos` | `python3 scripts/package-macos.py` (lo ejecuta el workflow) |
| iPhone e iPad | Workflow `ios.yml` o `npm run iphone:build` | `python3 scripts/package-ios.py` (lo ejecuta el workflow) |
| Android | `npm run android:build` con `FOLIO_ANDROID_KEYSTORE` ([docs/android.md](android.md)) | APK y AAB en `release/android/` |

`python3 scripts/package-delivery.py --out release/<carpeta> --mupdf-source mupdf-1.28.1-source.tar.gz --windows … --macos … --ios …`
reúne los paquetes verificados de Windows, macOS e iPhone con el código fuente
correspondiente, la fuente de MuPDF y las sumas SHA-256. Los binarios se adjuntan
a GitHub Releases; no se incorporan al repositorio.

Firmar con certificados de Apple o Windows, notarizar y publicar en App Store o
Google Play requiere credenciales que no están en el repositorio: los scripts las
leen de variables de entorno ([README](../README.md#compilar), [docs/android.md](android.md),
[docs/ios.md](ios.md)).
