# Folio 0.5.0

Aplicación PDF para Windows 10/11 x64, macOS 14 o posterior e iPhone/iPad con iOS 17 o posterior, con React, PDF.js, MuPDF y Tauri.
Cada instalador se compila en su plataforma. Las pruebas de Windows y sus límites
constan en docs/acceptance-windows.md. La entrega original 0.2.0 se conserva aparte.

## Interfaz

En iPhone, los documentos abiertos se eligen desde la cabecera y las herramientas
secundarias se abren en un panel. Los controles táctiles tienen al menos 44 px;
los paneles y diálogos respetan las zonas de la cámara, el indicador de inicio y
el teclado. El zoom con dos dedos conserva el PDF visible durante el gesto.
La selección usa las herramientas y los tiradores de selección de iOS. Archivos
importa los PDF al almacenamiento de la aplicación; guardar y compartir incluyen
las anotaciones y cambios actuales.

Cabecera de 44 px y herramientas de 40 px. La ventana permanece fija;
PDF, miniaturas y anotaciones se desplazan por separado. Las miniaturas solo
se desplazan verticalmente. En Windows, los diálogos se ajustan al área útil
del monitor para mantener las herramientas accesibles sobre la barra de tareas.
Sin barra inferior,
eslóganes ni entradas repetidas: abrir con el botón + de las pestañas, búsqueda y paneles en la
barra lateral, guardar en lectura y operaciones en Herramientas. Ctrl+S guarda
directamente. Ctrl+P prepara la impresión. Ctrl+rueda cambia el zoom conservando el punto bajo el cursor y la página visible durante el nuevo renderizado.

## Funciones implementadas

| Función | Comportamiento |
| --- | --- |
| Lectura | Miniaturas, índice, búsqueda, marcadores, zoom, giro de vista y pantalla completa. Renderiza las páginas próximas a la vista. |
| Pestañas | Varios PDF abiertos en la misma ventana. Cada pestaña conserva cambios, anotaciones, historial, página, zoom y búsqueda. Abrir varios archivos a la vez; cambiar con Ctrl+Tab y cerrar con Ctrl+W. |
| Marcadores | Árbol de páginas y grupos, con nombres, colores, orden y ramas plegables. Arrastrar ramas para cambiar el orden o el padre; deshacer y rehacer conserva sus hijos. Renombrar, crear hijos y eliminar desde el menú. Guardar marcador abre el panel y permite escribir su nombre. Se conservan en la sesión local y al guardar una copia desde Folio. |
| Anotaciones | Notas Text y resaltados Highlight estándar, Unicode y apariencias PDF. El modo automático (H) resalta cada selección y se puede apagar. Doce colores y color personalizado; la elección se recuerda. Al seleccionar texto aparece un menú para copiar, resaltar o comentar. Clic o clic derecho sobre un resaltado permite eliminarlo, incluidos los importados; deshacer lo restaura. Resaltado continuo entre palabras de una línea, sin unir columnas ni saltos de línea; composición Multiply que conserva el negro del texto, con la misma opacidad en vista y exportación. Conserva la opacidad de los resaltados importados y las coordenadas al girar la vista. Los escaneos necesitan OCR para seleccionar palabras. Importar, editar notas y eliminar comentarios. |
| Ajustes de lectura | Zoom inicial, desplazamiento continuo o página individual, separación entre páginas, velocidad de rueda y desplazamiento suave. Tema claro, oscuro o del sistema; panel inicial y su ancho. Opción de recordar la última página. Las preferencias se conservan al reiniciar. |
| Edición | Añadir texto o reemplazar texto dentro de un área conservando el contenido vecino. Añadir PNG/JPEG y eliminar píxeles de imágenes de un área. |
| Páginas | Reordenar, duplicar, extraer, eliminar, girar permanentemente, insertar PDF o páginas en blanco y recortar. En PC, arrastrar miniaturas con el mouse para elegir su posición; las páginas seleccionadas se mueven juntas. El organizador indica el destino, se desplaza al llegar a un borde y permite cancelar con Esc antes de aplicar el orden. Conserva campos, comentarios y enlaces entre páginas importadas. |
| OCR | Español, inglés o ambos, local con Tesseract. Añade texto invisible seleccionable conservando el escaneo. Modelos incluidos para trabajar sin conexión. |
| Formularios | Completar AcroForm: texto, casillas, radios y listas; generar apariencias y aplanar. Crear campos de texto, casillas y listas. |
| Firmas | CMS/PDF RSA/SHA-256 con certificado P12/PFX. Verifica integridad, cobertura ByteRange, vigencia y cadena contra una raíz elegida. Distingue integridad y confianza; bloquea editar archivos firmados. |
| Conversión | PDF a texto, DOCX con texto editable o PNG por página dentro de ZIP. Crear PDF vacío o desde imágenes. |
| Compresión | Optimiza objetos y streams sin reducir la calidad de imágenes. Conserva el archivo si la optimización no disminuye el tamaño. |
| Comparación | Texto por líneas y vistas de ambas páginas con mapa de diferencias visuales. |
| Protección | AES-256, contraseñas de apertura/propietario, permisos de copia e impresión. Quitar cifrado requiere contraseña de propietario. |
| Censura | Elimina texto, píxeles y gráficos del área; aplana formularios y quita comentarios intersectados, metadatos, adjuntos, acciones e índice. Elimina objetos sin referencias al guardar. |
| Guardado | Copia con cambios y comentarios; rechaza original y alias, comprueba destino y escribe atómicamente. Borrador binario y sesión recuperables; nuevos documentos en recientes. Deshacer/rehacer incluye contenido. |

## Límites

- Edición por áreas, sin recomponer párrafos o reproducir la fuente original.
  Usa DM Sans; si el texto no cabe, se informa y no se aplica. La imagen se
  ajusta al rectángulo elegido. Recortar conserva contenido exterior: no censura.
- OCR requiere páginas sin texto; no incluye corrector o reconstrucción de
  tablas. DOCX conserva texto y separación de páginas, sin imágenes ni diseño.
- XFA dinámico y JavaScript no se ejecutan. No se crean grupos de radio nuevos.
- Se firma una vez un archivo sin firmas y sin cifrado. No hay firmas
  incrementales, tarjetas/tokens ni almacén Windows. No se comprueba revocación,
  TSA ni raíces del sistema. Una comprobación criptográfica no acredita por sí
  sola validez jurídica.
- Los permisos dependen del lector; la contraseña de apertura sí cifra. Los
  borradores conservan el cifrado existente; sesiones y notas locales se guardan
  en el perfil del usuario.
- Entrada de hasta 100 MiB, sin lectura por bloques. Hay límites para canvas,
  exportaciones e historial. El manual de 804 páginas pesa unos 3 MB y no acredita
  una prueba de estrés con imágenes de 100 MiB.
- Impresión prepara las páginas con comentarios y usa WebView2; impresora física
  pendiente. Instalación/desinstalación y asociación predeterminada en distintas
  máquinas requieren aceptación manual. El instalador no está firmado.

## Compilar

Node.js 22+, Rust MSVC, Visual Studio C++ Build Tools/Windows SDK y WebView2:
https://v2.tauri.app/start/prerequisites/.

```powershell
npm ci
npm run desktop:dev
npm run desktop:build
```

Salida: src-tauri/target/release/bundle/nsis/Folio_0.5.0_x64-setup.exe.
Instala por usuario y registra Folio.PDF sin escribir UserChoice. Necesita
Internet para obtener WebView2 solo cuando falta. scripts/windows-env.ps1 usa
las herramientas portátiles de esta estación; .tools no se distribuye.
El entorno exacto consta en docs/build-environment.txt.

En macOS: Node 22+, Rust y Xcode Command Line Tools. La fuente incluye la
configuración Mac; conserva las carpetas src-tauri, crates y public.

```sh
npm ci
npm run desktop:macos
```

Genera Folio.app y un DMG universal para Intel y Apple Silicon en
src-tauri/target/universal-apple-darwin/release/bundle. Arrastra Folio a
Aplicaciones. La firma es ad hoc; no tiene notarización Apple. Si macOS bloquea
la primera apertura, usa Privacidad y seguridad > Abrir igualmente para esta
aplicación, sin desactivar Gatekeeper. Actualiza Safari/WebKit junto con macOS.
En Mac los atajos usan ⌘ y los controles de ventana son nativos.

### iPhone y iPad

La compilación iOS requiere un Mac con Xcode y los SDK de Apple. El workflow
`.github/workflows/ios.yml` permite compilar en GitHub Actions desde la rama elegida.

```sh
npm ci
npm run iphone:build
```

La entrega para Feather contiene un IPA de dispositivo arm64. Feather debe
firmarlo con el certificado y perfil válidos configurados por el usuario antes
de instalarlo. Una aplicación de simulador se entrega por separado y no puede
instalarse en un iPhone. Las instrucciones y los resultados de aceptación de
iOS constan en `docs/ios.md` y en los informes de la entrega.

## Verificar

```powershell
npm test
npm run test:native
```

Interfaz: Chrome/Edge o CHROME_PATH. Lectores independientes: Python con
pymupdf/pypdf/cryptography y OpenSSL (OPENSSL_PATH). npm test obtiene el corpus
público con hashes y prueba motores, firmas, interfaz y exportaciones. Los
modelos incluidos se verifican por SHA-256. Informes en test-results.
test:ui:legacy y test:interop:legacy conservan harness de 0.2.0; no certifican
la interfaz actual. La compilación QA tiene identificador y perfil separados;
su puerto de depuración no forma parte del ejecutable distribuido. Los
certificados sintéticos de pruebas se excluyen de la entrega.

## Fuente y licencias

AGPL-3.0-or-later. Fuente, lockfiles, instrucciones y avisos acompañan la entrega.
MuPDF.js 1.28.1 usa el paquete npm sin modificar y se entrega su fuente oficial
completa. tessdata_fast está fijado a un commit con licencia Apache-2.0 y hashes
en public/ocr/models.json. Consulta LICENSE, THIRD-PARTY-NOTICES.txt y
SOURCE-BUILD.txt. El uso acotado de node-forge y la auditoría están en
docs/security.md. No se configura actualización automática.
