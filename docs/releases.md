# Descargas de Folio

Los instaladores y su código fuente se publican en [GitHub Releases](https://github.com/DrFarra/folio-pdf/releases).
Cada fila indica el último paquete publicado de esa plataforma, que puede ser anterior a la versión del código.

| Plataforma | Último paquete | Estado |
| --- | --- | --- |
| Android, tablet y teléfono (arm64) | [0.9.28](https://github.com/DrFarra/folio-pdf/releases/tag/v0.9.28) | APK firmado con la misma clave de desarrollo; instalar encima de la versión anterior. |
| Windows x64 | [0.9.27](https://github.com/DrFarra/folio-pdf/releases/tag/v0.9.27) | Instalador NSIS sin firma Authenticode. |
| macOS, Apple Silicon e Intel | [0.9.27](https://github.com/DrFarra/folio-pdf/releases/tag/v0.9.27) | DMG universal con firma ad hoc, sin notarización. |
| iPhone e iPad | [0.9.28](https://github.com/DrFarra/folio-pdf/releases/tag/v0.9.28) | IPA sin certificado ni perfil de Apple, para firmar con Feather. |

## Cambios en 0.9.28

Solo Android, iPhone e iPad.

- Al volver a abrir Folio después de que el sistema lo cerrara, se reabre solo el documento que tenías delante, en vez de abrir todos uno tras otro. Los demás siguen en la biblioteca.
- Con el teléfono en horizontal, la columna de acciones (Páginas, Buscar, Anotar, Herramientas) ya no tapa el borde derecho de la página, y la página usa todo el ancho, también los márgenes de los lados. Al ocultar las barras, la página ocupa la pantalla entera.
- Al girar el teléfono, una página alejada con los dedos más allá de Ajustar página vuelve a ajustarse. Un doble toque sobre un zoom menor que el ajuste también la ajusta.
- En el teléfono, las herramientas tienen la flecha «Volver a Herramientas» en el título. En horizontal se abren como una ventana centrada, y Herramientas muestra dos por fila.
- Una herramienta se abre desde arriba: Firmas digitales y Proteger PDF ya no aparecen a media altura.

## Cambios en 0.9.27

Solo Windows y macOS.

- En Anotar y Editar, las herramientas flotan sobre la página, centradas, en lugar de ocupar una franja propia. La página empieza a la misma altura que en Leer y ya no se corta la parte de arriba.
- El inspector de Editar sigue arriba a la derecha, alineado con la página.

## Cambios en 0.9.26

- Botones, pestañas, menús y tarjetas responden con animaciones suaves. El color y la sombra cambian al pasar el puntero, y se hunden levemente al presionarlos. Las tarjetas de Herramientas y de la biblioteca se elevan un poco al pasar el puntero, y los colores del lápiz crecen.
- Los menús, el inspector de Editar y las herramientas de Anotar y Editar aparecen con un zoom breve, como los diálogos. En los controles segmentados (Leer, Anotar y Editar, las ubicaciones de Drive, el tema, las secciones de Ajustes), la opción elegida aparece suavemente.
- Las páginas del PDF y lo que se arrastra no se animan. Con «reducir movimiento» activado en el sistema, solo cambian los colores.
- Ajustes tiene más opciones para adaptar Folio: color de acento (coral, azul, verde, violeta, ámbar o grafito), Reducir animaciones, Mostrar el número bajo cada página, Abrir el panel de anotaciones al entrar en Anotar y Mantener siempre visible la barra de página.
- En el escritorio, la barra de página de abajo se esconde poco después de alejar el mouse y vuelve a aparecer al acercarlo. En Ajustes se puede dejar fija.
- Al entrar en Anotar ya no se abre solo el panel de anotaciones (se puede activar en Ajustes).
- Clic derecho sobre una pestaña: Renombrar (en el escritorio también renombra el archivo en su carpeta), Cerrar pestaña, Cerrar las demás pestañas y Cerrar las pestañas a la derecha. Las pestañas se reordenan arrastrándolas.
- En el iPhone en horizontal, al ocultar las barras la página ocupa todo el ancho, sin la franja vacía de la derecha.
- La barra de desplazamiento de Ajustes queda separada de los controles y solo aparece al pasar el puntero.

## Cambios en 0.9.25

- Dividir PDF y Extraer selección ya no se cancelan por tiempo con libros grandes que tienen anotaciones. Antes de dividir, Folio reescribía el libro entero para incluir las anotaciones, y con miles de páginas eso superaba el tiempo máximo. Ahora las agrega al final del archivo sin reescribirlo: en un libro de prueba de 3000 páginas, ese paso bajó de 7,3 s a 0,2 s. Las partes siguen llevando las anotaciones.

## Cambios en 0.9.24

- Ajustes en el teléfono tiene un diseño nuevo, como los ajustes del sistema. Cada sección es una tarjeta con su nombre arriba y cada ajuste es una fila con su valor a la derecha. El tema se elige en un control segmentado.
- Mantener pulsado un documento de «En curso» en la biblioteca permite quitarlo de esa fila; en el escritorio, con clic derecho. Vuelve a aparecer si lo abres otra vez.
- En el iPhone, tocar fuera del texto seleccionado quita la selección.
- En Android, el botón del S Pen abre la paleta rápida del lápiz donde apunta el lápiz. Con el botón presionado sobre la pantalla no se dibuja.
- Google Drive tiene la sección Computadoras, con las carpetas que Google Drive para escritorio copia desde cada computadora.
- En Google Drive, las ubicaciones (Mi unidad, Compartidos conmigo, Computadoras, Sin conexión) forman un solo control. La carpeta en la que estás se muestra como una ruta de texto, con la carpeta actual en negrita, para no confundirla con esas ubicaciones.

## Cambios en 0.9.23

Primera versión con el nuevo diseño, en Windows, macOS, Android, iPhone e iPad.

- Nuevo diseño en escritorio. Una sola barra arriba tiene las pestañas, el cambio entre Leer, Anotar y Editar en el centro, la búsqueda y Guardar. A la izquierda queda una columna de iconos, y la página y el zoom van en una barra flotante sobre el documento.
- Leer, Anotar y Editar son vistas del mismo documento. Ya no hay que salir de Editar con «Listo»: lo que editaste aparece al cambiar de modo, sin pantalla de carga. Un cambio hecho con las flechas justo antes de cambiar de modo ya no se pierde.
- Anotar muestra las herramientas sobre la página y abre el panel de anotaciones al entrar. Las opciones de dibujo tienen deslizadores nuevos de grosor, opacidad y tamaño de la goma.
- Editar muestra las propiedades de lo seleccionado en una tarjeta a la derecha, con su posición y tamaño en puntos para escribirlos a mano.
- Herramientas muestra cada herramienta con un dibujo de lo que hace. Al abrir una, las demás quedan en una lista al lado.
- Ajustes se divide en secciones: Apariencia, Lectura, Archivos locales y Acerca de Folio.
- Con muchas pestañas abiertas, las que no caben se listan en un menú «+N» y ya no tapan el cambio de modo.
- En el teléfono, Herramientas está en la barra de abajo, junto a Páginas, Buscar y Anotar; Compartir PDF pasa a Más acciones. Bajo el nombre del documento se ve la página. Las herramientas de Anotar llevan su nombre bajo el icono, y Herramientas se muestra como una lista. En horizontal, las acciones de lectura pasan a una columna a la derecha y la página conserva su altura.
- En el teléfono y la tablet, las opciones del lápiz usan los deslizadores nuevos. La tablet muestra Herramientas con los dibujos de cada una y Ajustes en dos paneles.
- Al reescribir un texto con tildes en Editar, buscar o copiar ese texto ya da las letras correctas («Página» en vez de «PÈgina»).
- El OCR con enderezado de páginas vuelve a funcionar en Safari anterior a la versión 16.4, en iPhone, iPad y Mac.

## Cambios en 0.9.21

- En Editar, una página que cambiaste se ve nítida con mucho zoom, como el resto del documento. Antes quedaba algo borrosa hasta salir de Editar.
- Enderezar páginas escaneadas para el OCR ya no deja la ventana trabada: se hace aparte, y cancelar lo detiene al momento.

## Cambios en 0.9.20

- Guardar en Windows tarda bastante menos con PDF grandes: un libro de 396 MB editado se guarda en unos 4,5 s en vez de 7,6 s. Folio ya no vuelve a leer el archivo original entero para comprobar que no cambió (le basta su tamaño y fecha, y solo si difieren compara el contenido), calcula la identidad del archivo nuevo mientras lo escribe y no guarda un borrador del PDF que está guardando.

## Cambios en 0.9.19

- Guardar en Windows es mucho más rápido después de editar: Folio ya no vuelve a leer el PDF entero ni reescribe las anotaciones si no cambiaron.
- Si deshaces todos los cambios, el documento vuelve a ser el archivo original: Guardar se apaga y salir de Editar ya no guarda ni vuelve a abrir el documento.
- En Editar, al mover un elemento aparecen guías y se alinea con los bordes y centros de los demás y con el centro de la página; mantén Alt mientras arrastras para moverlo libremente.
- En Editar, si hay varios elementos uno encima de otro, cada clic sobre el seleccionado elige el de debajo.
- El deslizador de opacidad de una imagen la muestra con esa opacidad mientras lo mueves.
- El botón «Volver a p. N» desaparece solo a los 15 segundos.

## Cambios en 0.9.18

- En Windows, los PDF muy grandes (libros de cientos de MB) se abren mucho más rápido.
- Al abrir Folio ya no aparecen franjas negras mientras carga la ventana.
- En el teléfono, los menús de los marcadores, de los resaltados y de la selección de texto ya no se salen de la pantalla.

## Cambios en 0.9.17

- En Editar, mover una imagen en un PDF muy grande ya no deja una copia en su sitio anterior ni se traba con «Guardando el cambio…» en equipos más lentos: el PDF se reescribe cuando dejas de editar un momento, no después de cada movimiento.

## Cambios en 0.9.16

- En Editar, una imagen que mueves desaparece al instante de su sitio anterior, y mover imágenes ya no deja la ventana trabada, tampoco en PDF muy grandes ni en equipos más lentos (Windows).
- Abrir un PDF muy grande con cambios sin guardar ya no cuelga ni cierra la ventana en Windows (necesita WebView2 de 2023 o posterior, el que trae Windows actualizado).
- «Texto buscable» puede rehacer el OCR que otro programa dejó mal leído: quita su capa invisible y escribe la nueva, sin tocar la imagen ni las marcas de agua.
- «Texto editable» mejora en libros escaneados a baja resolución: conserva la letra con serifa en todo el texto, las etiquetas de los dibujos ya no salen en negrita, los títulos en cursiva como «Vía endógena:» salen en cursiva y no se borran palabras de los dibujos que el OCR no leyó.
- El enderezado ya no curva páginas con fotos, dibujos o tablas.
- Las palabras técnicas (lisosomales, lipoproteína, citosol…), los títulos en mayúsculas sin tilde y las palabras partidas a final de línea se reescriben como texto en vez de quedarse como imagen.

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
