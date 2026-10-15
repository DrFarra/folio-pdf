# Descargas de Folio

Los instaladores y su código fuente se publican en [GitHub Releases](https://github.com/FarraPY/folio-pdf/releases).
Cada fila indica el último paquete publicado de esa plataforma, que puede ser anterior a la versión del código.

| Plataforma | Último paquete | Estado |
| --- | --- | --- |
| Android, tablet y teléfono (arm64) | [0.8.11](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.11) | APK firmado con la misma clave de desarrollo; instalar encima de la versión anterior. |
| Windows x64 | [0.8.11](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.11) | Instalador NSIS sin firma Authenticode. |
| macOS, Apple Silicon e Intel | [0.8.11](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.11) | DMG universal con firma ad hoc, sin notarización. |
| iPhone e iPad | [0.8.3](https://github.com/FarraPY/folio-pdf/releases/tag/v0.8.3) | IPA sin certificado ni perfil de Apple, para firmar con Feather. Compilación 0.9.0 pendiente. |

## Cambios en 0.9.15

- «Reconocer texto (OCR)» con «Texto editable» reconstruye la página escaneada mucho más parecida al original: la misma familia de letra en toda la página y en todo el libro (Palatino, Gill Sans…), el grosor de la tinta del libro, y las negritas y cursivas donde las tiene el original (títulos de tabla, «Fig. 4-9.», términos en cursiva, cabeceras).
- Los fondos de color se respetan al borrar las letras escaneadas: sin franjas blancas en los recuadros de color, y las rayas gruesas y las viñetas se conservan enteras.
- Una palabra que el OCR leyó con dudas y que no está en el diccionario español o inglés se deja tal como se escaneó en lugar de reescribirse mal.

## Cambios en 0.9.14

- Nuevo motor de OCR propio de Folio (modelos PP-OCRv5 de PaddleOCR): lee bien el 98 % de las palabras frente al 93 % del anterior, comete un tercio de los errores por letra y lee las columnas de los artículos en su orden. Con tarjeta gráfica (WebGPU) tarda alrededor de medio segundo por página; sin ella reparte el trabajo entre varios núcleos. Funciona sin conexión.
- «Reconocer texto (OCR)» puede enderezar las páginas: una página torcida se gira sin perder calidad, y si sus líneas se curvan (cerca del lomo de un libro o en una foto) se aplana para que quede recta como un PDF digital.
- Las palabras reconocidas se ajustan a su tinta, así que resaltar y seleccionar texto escaneado encaja mejor.

## Cambios en 0.9.13

- En Editar, el texto que ya moviste se puede volver a mover aunque quede encima de otro texto, y el recuadro de selección toma todo lo que queda al menos a medias dentro.
- El color en Editar se elige en un panel con colores para documentos, un selector personalizado, el código hexadecimal y un cuentagotas (Windows).
- El selector de zoom ocupa solo lo que mide su texto.
- Los botones ya no quedan con un marco naranja después de un clic, un atajo o al cerrar un diálogo; el marco aparece solo al moverse con Tab o las flechas.

## Cambios en 0.9.12

- En Editar ya se puede mover el texto de los PDF impresos desde el navegador (por ejemplo, resúmenes en Segoe UI): antes muchos párrafos se negaban con «no se puede mover sin cambiar su aspecto». Las letras quedan en su sitio exacto.
- Al mover texto, los paréntesis y demás signos se siguen copiando y buscando bien.
- Un texto con una fuente dibujada (Type 3, como algunas estrellas ★) explica que hay que editarlo para reescribirlo.

## Cambios en 0.9.11

- Editar va mucho más rápido: cada cambio tarda unos 35 ms aunque el PDF tenga cientos de MB (antes, cerca de 1 s en un PDF de 238 MB y 1,5 s en uno de 475 MB). El PDF ya no se reabre en cada cambio, solo una vez al salir de Editar.
- Al arrastrar, girar o recolorear, se mueve solo el elemento, con su transparencia, y el nuevo color se ve al instante.
- Se pueden seleccionar varios elementos (Mayús+clic, un recuadro o Ctrl+A) y moverlos, duplicarlos, borrarlos o alinearlos juntos, en un solo paso de deshacer.
- Los cambios hechos en Editar se deshacen uno a uno también después de salir, y volver a Editar es inmediato.
- Corregido: la vista ya no salta a otra página un momento después de cada cambio.

## Cambios en 0.9.10

- Editar se siente sólido: al soltar un elemento queda en su sitio, seleccionado, y donde estaba se ve al instante lo que hay debajo; ya no aparecen cuadros vacíos, copias duplicadas ni saltos, y la barra no se atenúa en cada cambio.
- Las imágenes colocadas se mueven, cambian de tamaño, giran y se borran al instante, aunque se toquen con otras imágenes.
- Un clic sobre una imagen que tapa un texto selecciona la imagen.
- Las notas se escriben en una tarjeta junto a la propia nota, con su color, sin oscurecer la página, y se pueden arrastrar para moverlas.
- Cada herramienta tiene su propio cursor: nota, resaltador, lápiz, goma, formas, imagen y áreas.

## Cambios en 0.9.9

- Corregido el cierre «Folio encontró un error» al volver a una página ya vista después de editar el PDF.
- Los cambios en Editar se aplican al instante (unos 0,15 s en vez de 3-4 s en PDF grandes) y el texto editado no parpadea.
- En Editar se pueden seleccionar, mover, duplicar, recolorear y borrar las cajas, bandas y líneas del PDF; Alt+clic elige lo que está debajo.
- Las imágenes colocadas siguen siendo editables (mover, cambiar tamaño, girar) aunque haya texto o dibujos debajo; Ctrl+V pega una imagen al instante.
- Las notas muestran su texto al pasar el ratón; con clic derecho se cambia su color, se editan o se eliminan.
- Los selectores de color ocupan todo su botón y el texto de la interfaz ya no se puede seleccionar.

## Cambios en 0.9.8

- En Windows y macOS, el menú «⋯» de cada documento de la biblioteca está en la esquina de su portada: el texto de la tarjeta ya no queda cortado ni tapado.
- Ese menú ya no se sale de la ventana: se desplaza hacia dentro junto a los bordes y se abre hacia arriba cerca del borde inferior.

## Cambios en 0.9.7

- En el teléfono, los botones Cuadrícula y Lista de la biblioteca y el menú de cada documento tienen el tamaño táctil completo (44 px).
- Primera versión publicada en GitHub desde la que Windows puede actualizarse con «Buscar actualizaciones».

## Cambios en 0.9.6

- En Windows, «Buscar actualizaciones» (Ajustes) busca la última versión publicada en GitHub y la instala desde ahí: Folio se cierra, se actualiza y vuelve a abrirse. En macOS abre la página de versiones.
- En Windows y macOS, la biblioteca ocupa todo el ancho de la ventana.
- Los enlaces «Avisos de terceros» y «Código fuente» apuntan al repositorio actual.

## Cambios en 0.9.5

- En Windows y macOS, el botón Guardar se ilumina cuando el documento tiene cambios sin guardar, tanto en archivos locales como de Google Drive.

## Cambios en 0.9.4

- En Windows y macOS, «Editar» ya no abre otra pantalla: se edita sobre las propias páginas, con el mismo zoom (también con el touchpad) y una barra de herramientas debajo de la principal.
- Pasar el ratón resalta un texto, una imagen o una forma; un clic la selecciona con sus tiradores. Se mueve arrastrando y el cambio se guarda al soltar, con su paso de deshacer.
- Mover un texto conserva exactamente su fuente, sus negritas y cursivas. Doble clic en un párrafo para escribir directamente en la página, con fuente, tamaño, negrita, cursiva, color, alineación e interlineado.
- El texto reescrito usa la fuente original del PDF cuando tiene todas las letras; si no, la misma familia instalada en el equipo o la más parecida.
- Las imágenes se mueven, se amplían conservando su proporción, giran, cambian de opacidad, se duplican o se reemplazan sin perder calidad. Para añadir una: el botón Imagen, arrastrar un archivo a la página o pegar con Ctrl+V.
- Nuevas formas: rectángulo, elipse, línea y flecha, con color de borde, relleno, grosor y opacidad. Se pueden seguir editando después.
- Atajos: Supr elimina, Ctrl+D duplica, las flechas desplazan (Mayús: 10 puntos), V T I R O L A eligen herramienta y Esc deselecciona.
- En tablet y teléfono, «Editar PDF» sigue como hasta ahora.

## Cambios en 0.9.3

- En Windows, pellizcar con el touchpad vuelve a ampliar el PDF.
- Ctrl + / Ctrl − / Ctrl 0 nunca amplían la interfaz, tampoco con un diálogo abierto, y un pellizco en una pantalla táctil de escritorio tampoco.

## Cambios en 0.9.2

- Nueva herramienta «Dividir PDF» (Herramientas → Páginas): separa un documento en varios archivos por intervalos, cada N páginas, en partes iguales o por capítulos del índice, con vista previa y nombres editables.
- En Windows y macOS los archivos se guardan en la carpeta que elijas, sin reemplazar ninguno; en iPhone, Android y la web se guardan en un ZIP.
- Dividir un libro de 1 GB por capítulos tarda unos segundos y no duplica su memoria.

## Cambios en 0.9.1

- Los PDF muy grandes (libros de 1 GB) se abren con un tercio de la memoria y ya no se cancelan por tiempo en equipos de 8 GB.
- Un PDF grande que ya trae resaltados de otra app se abre sin rehacer el archivo; sus resaltados aparecen una sola vez.
- El desplazamiento es fluido en documentos de miles de páginas, también con el panel de miniaturas abierto.
- La búsqueda prepara el texto al abrirla y muestra resultados mientras avanza.
- En tablet y teléfono, pasar entre Anotaciones y Páginas, Índice o Marcadores ya no cierra y vuelve a abrir el panel.
- Si un PDF es demasiado grande para guardarlo modificado, Folio lo explica y conserva tus anotaciones.

## Cambios en 0.9.0

- En Windows y macOS, Guardar (Ctrl+S / ⌘S) actualiza el PDF abierto y «Guardar una copia…» (Ctrl+Mayús+S / ⇧⌘S) crea otro archivo. Un PDF de solo lectura, o que otro programa cambió, no se reemplaza.
- En Android, Guardar escribe en el PDF original. Si falla y no se puede restaurar, la versión anterior queda en la biblioteca.
- El tema sigue al del sistema hasta que elijas uno.
- La biblioteca es una sola lista, ordenada por uso y con búsqueda. Si desactivas «Añadir a la biblioteca los PDF que abras», no se guardan.
- El zoom, la rotación y el cambio de tamaño de la ventana mantienen la posición de lectura. El pellizco del trackpad amplía.
- Puedes dibujar con el dedo hasta que Folio detecta un lápiz.
- Las herramientas de contenido por áreas están en «Editar PDF».
- Google Drive solo aparece en la app instalada.
- macOS tiene barra de menús en español, con Deshacer y Rehacer del documento.
- Ayuda para cada plataforma, «Acerca de Folio» con el código fuente y las licencias, y la «Guía de Folio» como PDF de ejemplo.
- En iPhone e iPad, la biblioteca conserva y abre sus PDF después de restaurar una copia de seguridad o cambiar de dispositivo.
- En Windows, los enlaces de los PDF se abren completos aunque lleven comas o parámetros.

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
Una versión nueva empieza subiendo ese número y escribiendo aquí sus cambios. Etiqueta
como `v<versión>` el commit compilado: «Código fuente» en Ajustes abre esa etiqueta.

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
