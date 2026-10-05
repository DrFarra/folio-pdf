# Folio para Android

APK de prueba arm64 para Android 8 o posterior. Usa el motor PDF local y no
requiere una cuenta. El APK está firmado con una clave de desarrollo; no es una
publicación de Google Play. Mantener esa clave permite actualizar instalaciones.

## Pantallas

- Teléfono: acciones inferiores y explorador superpuesto.
- Tablet: una cabecera de 56 px, documentos en un selector y explorador
  superpuesto. El PDF no cambia de tamaño al abrir el panel. Las herramientas
  aparecen en una paleta flotante solo al anotar; color y grosor van en opciones.
  Los controles táctiles conservan objetivos de 48 px.
- El título abre un desplegable animado con documentos abiertos y recientes,
  sin oscurecer el PDF. Se cierra al tocar fuera o pulsar Escape; respeta la
  preferencia de reducir movimiento.
- Un toque corto sobre la página en modo lectura alterna pantalla completa.
  En Android también oculta/restaura las barras de estado y navegación. Desplazar,
  seleccionar texto y dibujar no activan ese gesto. No hay aviso flotante para
  volver a una página en teléfono o tablet.
- La tablet adopta el diseño compacto cuando la ventana baja de 600 píxeles CSS.
  Girar un teléfono conserva su diseño compacto.

## Guardado en Android (0.8.8)

«Guardar» actualiza el PDF original. «Guardar una copia» sigue disponible como
acción independiente. El selector pide lectura y escritura y conserva los permisos
que el proveedor permite persistir. Tanto los archivos importados como los recibidos
mediante «Abrir con Folio» guardan su URI de origen junto a la copia de trabajo.
Al guardar una copia o un documento nuevo, el destino elegido se convierte en su
origen para los siguientes guardados.

Si el envío concede solo lectura o el archivo se importó con una versión anterior,
Guardar permite seleccionar el original y autorizar su escritura. Se comprueba su
contenido antes de modificarlo; elegir un PDF distinto o con cambios externos se
rechaza. Los proveedores que no permiten escritura conservan la opción de copia.

La escritura mantiene un respaldo privado, verifica los bytes resultantes y restaura
el original ante un fallo. Los respaldos cuya restauración falla se conservan en
`FolioRecovery`; los cambios continúan disponibles en la sesión. Android no ofrece
una sustitución atómica para todos los proveedores de documentos.

Pruebas: `node scripts/tests/android-save.mjs` cubre tablet y teléfono con el motor
PDF real y un puente nativo simulado (dibujos, cancelación, errores, reapertura,
guardados repetidos y copia independiente). `OriginalDocumentTest` comprueba la
escritura real mediante ContentResolver, conflictos, permisos y restauración.

## Dibujo con lápiz

Anotar → Dibujar. Color y grosor de 1, 2, 3, 5 u 8 puntos. «Solo lápiz» permite
dibujar con un lápiz que Android reconozca como stylus y desplazar con un dedo.
Desactivarlo permite dibujar con el dedo. El mouse también funciona.
El borrador elimina un trazo; Deshacer y Rehacer actúan por trazo.
La punta borradora de un lápiz compatible se reconoce mediante Pointer Events.
No se simulan presión ni inclinación. La detección de palma depende además del
hardware; se ignoran contactos grandes y contactos durante un trazo de lápiz.
Los dibujos usan anotaciones PDF Ink estándar y permanecen al guardar una copia.

## Archivos

Importar usa el selector de documentos de Android y conserva una copia privada.
«Abrir con Folio» y «Compartir con Folio» reciben los PDF de otras aplicaciones,
tanto al arrancar como con la app abierta. Las URI de contenido se leen con el
permiso concedido por Android y se copian antes de incorporarlas a la biblioteca.
Una cola nativa conserva las aperturas hasta que el lector está preparado.
Al actualizar, la caché de recursos de la interfaz se renueva una sola vez y el
WebView lee la interfaz del APK. No se eliminan documentos, anotaciones, bases de
datos ni preferencias. La versión instalada aparece al pie de Ajustes.
Guardar una copia usa Crear documento; compartir concede acceso temporal a una
copia mediante FileProvider. No se pide acceso general al almacenamiento.
Se mantiene el límite de 100 MiB por PDF. El lector y OCR usan recursos incluidos.

## Compilación

JDK 17, SDK 36, Build Tools 36, NDK 29.0.14206865, Rust y Node 22 o posterior.
En Windows, cargar primero el entorno C++/Rust y luego Android:

```powershell
. ./scripts/windows-env.ps1
. ./scripts/android-env.ps1
npm run android:build
```

El proyecto Gradle está en `src-tauri/gen/android`. El script usa una copia de la
biblioteca nativa cuando Windows no permite enlaces simbólicos. No cambia la
configuración de seguridad del equipo. Salida en `release/android`.

```sh
npm run build
npm run test:android
npm run test:file-picker
```

Las pruebas comprueban tablet vertical/horizontal, teléfono vertical/horizontal,
ventana dividida, escritorio, lápiz emulado y deshacer/rehacer. La prueba de motor
verifica Ink, apariencia, coordenadas al girar, borrado y datos inválidos.
La compilación Kotlin/Rust y la firma APK se comprueban por separado.
Los casos de recepción de archivos se prueban con Robolectric en el módulo
Android: `:tauri-plugin-folio-android:testDebugUnitTest`. Comprueban inicio en frío,
apertura posterior, compartir uno o varios PDF, URI duplicadas, archivos inválidos
y errores de acceso. No sustituyen una prueba en un dispositivo real.
Los iconos incluyen variantes adaptativa, redonda y monocroma para los temas de
Android, además de PNG por densidad. El APK 0.8.3 actualiza la versión 0.8.2 con
la misma identidad y clave de desarrollo. La versión 0.8.4 corrige los márgenes
duplicados de Android/WebView: el contenedor nativo aplica arriba y laterales
una sola vez y remite esos insets a cero. El PDF continúa detrás de la navegación
transparente; solo los controles respetan el margen inferior. Las actualizaciones
del teclado siguen llegando al WebView. La barra de estado toma el fondo del tema
para que la hora y los indicadores sean legibles.
La instalación, el selector, compartir, impresión y lápiz físico requieren
aceptación en un dispositivo: esta estación no tiene Android conectado.
