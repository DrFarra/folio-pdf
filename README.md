# Folio

Lee, anota, edita y firma PDF en Windows, macOS, Android, iPhone, iPad y el
navegador. Los documentos se procesan en el dispositivo; Folio no los envía a
ningún servidor.

**Descargas:** [publicaciones de cada plataforma](docs/releases.md).

## Plataformas

| Plataforma | Requisitos | Paquete |
| --- | --- | --- |
| Windows | Windows 10 u 11 x64 | Instalador por usuario. Descarga WebView2 si falta. |
| macOS | macOS 14 o posterior, Intel o Apple Silicon | DMG universal |
| Android | Android 8 o posterior, teléfono o tablet arm64 | APK; AAB para Google Play |
| iPhone e iPad | iOS 17 o posterior | IPA |
| Web | Navegador actual | Se puede instalar como aplicación y abre sin conexión. |

## Funciones

| Función | Qué hace |
| --- | --- |
| Lectura | Pestañas, miniaturas, índice, marcadores, búsqueda, zoom y giro. Desplazamiento continuo o por página. Tema claro u oscuro; por defecto sigue al sistema. |
| Anotaciones | Resaltados, notas y dibujo con lápiz o con el dedo, guardados como anotaciones PDF estándar. |
| Edición | Añade o reemplaza texto e imágenes en una zona de la página, con vista previa. Deshacer y rehacer. |
| Páginas | Reordena, duplica, extrae, elimina, gira, inserta y recorta páginas. |
| Formularios | Rellena formularios AcroForm, crea campos y los aplana. |
| OCR | Reconoce texto en español e inglés sin conexión (Tesseract) y lo añade como capa seleccionable. |
| Firmas | Firma con un certificado P12/PFX y comprueba la integridad y la cadena de las firmas. |
| Conversión | Exporta a texto, DOCX o PNG. Crea PDF vacíos o a partir de imágenes. |
| Otras herramientas | Comprime, compara, protege con contraseña (AES-256) y censura contenido. |
| Google Drive | En las apps de escritorio y móviles, abre PDF de Drive, permite editarlos sin conexión y los guarda en el mismo archivo. |

## Guardar

Las anotaciones y los cambios se conservan en el dispositivo mientras trabajas.
Para escribirlos en un PDF:

- **Windows y macOS:** **Guardar** (Ctrl+S, ⌘S) actualiza el PDF abierto. Si es de
  solo lectura o otro programa lo modificó después de abrirlo, Folio no lo
  sobrescribe y te lo indica. **Guardar una copia…** (Ctrl+Mayús+S, ⇧⌘S) crea otro archivo.
- **Android:** **Guardar** actualiza el PDF original y **Guardar una copia** crea otro.
- **iPhone y iPad:** Folio trabaja con una copia importada. **Guardar una copia**
  exporta el PDF a Archivos y **Compartir** abre la hoja de iOS.
- **Web:** **Descargar** baja el PDF con los cambios.

## Límites

- La edición actúa sobre zonas: no recompone párrafos entre bloques ni reutiliza
  cualquier fuente incrustada. Usa Helvetica, Times, Courier o DM Sans y avisa
  cuando sustituye una fuente.
- El OCR trabaja con páginas sin texto. DOCX conserva el texto y los saltos de
  página, sin imágenes ni maquetación.
- No se ejecutan formularios XFA dinámicos ni JavaScript del PDF.
- Solo se firma un PDF sin firmas ni cifrado. No hay firmas incrementales,
  tarjetas o tokens, almacenes de certificados del sistema, revocación ni sellos
  de tiempo.
- Folio carga el PDF entero en memoria, salvo en iPhone e iPad: allí los de más
  de 32 MiB se abren en un lector que permite leer, buscar, resaltar, dibujar y
  añadir notas, pero no editar el contenido, las páginas ni los formularios.
  Android importa PDF de hasta 100 MiB.
- En escritorio y en la web, imprimir envía imágenes de las páginas a 200 ppp.
- No hay actualización automática: las versiones nuevas se publican en
  [GitHub Releases](https://github.com/FarraPY/folio-pdf/releases).

## Compilar

Necesitas Node.js 22 o posterior y, para las apps nativas, Rust estable y los
[requisitos de Tauri](https://v2.tauri.app/start/prerequisites/) de cada sistema.

```sh
npm ci
npm run dev              # interfaz web en http://localhost:5173
npm run build            # comprueba versiones, prepara recursos, tsc y vite build → dist/
npm run desktop:dev      # app de escritorio en modo desarrollo
npm run desktop:windows  # instalador NSIS (en Windows)
npm run desktop:macos    # Folio.app y DMG universal (en macOS)
npm run android:build    # APK y, con clave de publicación, AAB (docs/android.md)
npm run iphone:build     # IPA (en macOS con Xcode; docs/ios.md)
```

El instalador de Windows no está firmado. En macOS, la compilación predeterminada
tiene firma ad hoc: la primera vez que se abre Folio descargado, macOS puede pedir
**Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente**. Si se compila
con `APPLE_SIGNING_IDENTITY` y las credenciales `APPLE_API_*`, la aplicación se
firma con Developer ID y se notariza; entonces no hace falta ese paso.
Para conectar Google Drive en una compilación propia, consulta
[docs/google-drive-oauth.md](docs/google-drive-oauth.md).

## Probar

```sh
npm run test:engine   # motor PDF, sin navegador
npm test              # compila y ejecuta las suites de motor e interfaz
npm run test:native   # pruebas Rust del núcleo de archivos
```

Las pruebas de interfaz usan Chrome o Chromium: indica su ruta con `CHROME_PATH`
(si no, se busca Chrome, Edge o Chromium en las rutas habituales de Windows, macOS
y Linux). `test:interop` necesita Python 3 con pymupdf, pypdf y cryptography, y
OpenSSL (`OPENSSL_PATH` o el `openssl` del PATH). Los resultados quedan
en `test-results/`. Hay suites por plataforma: `test:android`, `test:drive`,
`test:iphone`, `test:macos` y `test:windows-native`. `test:iphone` y `test:macos`
usan además WebKit de Playwright, que otras suites usan con
`FOLIO_TEST_BROWSER=webkit`. `test:windows-native` necesita la compilación QA de
Windows (`FOLIO_NATIVE_EXE`, `FOLIO_LAYOUT_PDF` y `FOLIO_QA_EXE`).

## Documentación

- [docs/releases.md](docs/releases.md): descargas, cambios y cómo publicar.
- [docs/android.md](docs/android.md) y [docs/ios.md](docs/ios.md): detalles y compilación móvil.
- [docs/google-drive-oauth.md](docs/google-drive-oauth.md) y
  [docs/drive-sync-implementation.md](docs/drive-sync-implementation.md): Google Drive.
- [docs/security.md](docs/security.md): dependencias, certificados y privacidad.

## Licencia

Folio es software libre bajo la licencia AGPL-3.0 o posterior ([LICENSE](LICENSE)).
Incluye MuPDF (AGPL), PDF.js, Tesseract y otras dependencias cuyos avisos están en
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt). [SOURCE-BUILD.txt](SOURCE-BUILD.txt)
explica cómo reconstruir los binarios publicados; cada publicación incluye su
código fuente.
