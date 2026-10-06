# Folio para Android

Android 8 o posterior, en teléfono y tablet. Usa el motor PDF local y no requiere
una cuenta. `npm run android:build` genera por defecto un APK de prueba arm64
firmado con la clave de desarrollo; con un almacén de claves de publicación genera
el AAB para Google Play y un APK firmado (ver «Compilación»).

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
  En Android también oculta/restaura las barras de estado y navegación. Las barras
  ocultas conservan su espacio, así que el WebView no cambia de tamaño ni la
  página de escala. Desplazar, seleccionar texto y dibujar no activan ese gesto.
  No hay aviso flotante para volver a una página en teléfono o tablet.
- La tablet adopta el diseño compacto cuando la ventana baja de 600 píxeles CSS.
  Girar un teléfono conserva su diseño compacto. Cambiar el tamaño de letra o de
  pantalla, o pasar a otra pantalla, no recrea la actividad ni cierra pestañas.
- La franja bajo la barra de estado toma el color de la pantalla que hay debajo
  (biblioteca o cabecera del lector). Al arrancar, la ventana usa el último tema
  elegido, o el del sistema mientras no haya uno, sin destello blanco.
- Al seleccionar texto del PDF solo aparece el menú de Folio (Copiar, Resaltar,
  Comentar); los campos de texto conservan el menú del sistema para pegar.
- Atrás cierra un nivel cada vez; en la biblioteca deja la app en segundo plano.

## Guardado en Android

«Guardar» actualiza el PDF original. «Guardar una copia» sigue disponible como
acción independiente. El selector pide lectura y escritura y conserva los permisos
que la app de origen permite persistir. Tanto los archivos importados como los
recibidos mediante «Abrir con Folio» guardan su URI de origen junto a la copia de
trabajo. Al guardar una copia o un documento nuevo, el destino elegido se convierte
en su origen para los siguientes guardados.

Si el envío concede solo lectura o el archivo se importó con una versión anterior,
Guardar pide elegir otra vez el PDF original («Permitir guardar en el original»).
Se comprueba su contenido antes de modificarlo; elegir un PDF distinto o con cambios
externos se rechaza. Si el original se movió o se eliminó, Folio lo indica sin abrir
el selector. Las apps que no permiten escritura conservan la opción de copia.

La escritura mantiene un respaldo privado, verifica los bytes resultantes y restaura
el original ante un fallo. Si tampoco se puede restaurar, la versión anterior se abre
como documento nuevo, «<nombre> (versión anterior).pdf», y los cambios siguen en la
sesión. Android no ofrece una sustitución atómica para todos los proveedores.

Las copias que Folio guarda para compartir, imprimir o exportar viven en el
directorio de datos de la app. Los errores del sistema se muestran con un texto en
español; el detalle técnico queda en Logcat.

Pruebas: `node scripts/tests/android-save.mjs` cubre tablet y teléfono con el motor
PDF real y un puente nativo simulado (dibujos, cancelación, errores, reapertura tras
un reinicio, guardados repetidos y copia independiente). `OriginalDocumentTest`
comprueba la escritura real mediante ContentResolver, conflictos, permisos,
restauración, original no encontrado y recuperación de la versión anterior.

## Dibujo con lápiz

Anotar → Lápiz. Color y grosor de 1, 2, 3 o 5 puntos. Mientras no se detecta un
lápiz, se dibuja con el dedo. Al usar por primera vez un lápiz que Android reconozca
como stylus, el lápiz dibuja y el dedo desplaza; «Usar el dedo» cambia esa elección
y Folio la recuerda. El mouse también funciona.
El borrador elimina un trazo; Deshacer y Rehacer actúan por trazo.
La punta borradora de un lápiz compatible se reconoce mediante Pointer Events.
No se simulan presión ni inclinación. La detección de palma depende además del
hardware; se ignoran contactos grandes y contactos durante un trazo de lápiz.
Los dibujos usan anotaciones PDF Ink estándar y permanecen al guardar una copia.

## Archivos

Importar usa el selector de documentos de Android y conserva una copia privada.
«Abrir con Folio» y «Compartir con Folio» reciben los PDF de otras aplicaciones,
tanto al arrancar como con la app abierta. Solo se aceptan URI `content://`, leídas
con el permiso concedido por Android y copiadas antes de incorporarlas a la
biblioteca. Una cola nativa conserva las aperturas hasta que el lector está
preparado. Volver desde Recientes después de que Android cerrara la app no vuelve a
importar el PDF con el que se abrió.

Las copias privadas (`files/FolioImports` y `exports`) que ya no usan la biblioteca
ni una pestaña abierta se borran al arrancar y después de eliminar un documento,
borrar los datos locales o sustituir un documento guardado (comando
`prune_private_copies`). También se liberan los permisos persistentes de sus
originales. Una copia escrita en el último minuto se conserva hasta la siguiente
limpieza.

Al actualizar, la caché de recursos de la interfaz se renueva una sola vez y el
WebView lee la interfaz del APK. No se eliminan documentos, anotaciones, bases de
datos ni preferencias. La versión instalada aparece al pie de Ajustes.
Guardar una copia usa Crear documento; si la escritura falla, se borra el archivo
vacío que se creó. Compartir concede acceso temporal a una copia mediante el
FileProvider de Folio, limitado a la caché de copias compartidas. No se pide acceso
general al almacenamiento. Se mantiene el límite de 100 MiB por PDF. El lector y OCR
usan recursos incluidos.

## Google Drive

La autorización usa Google Play services, sin actividad intermedia. Conectar muestra
siempre el selector de cuenta, así que después de desconectar se puede elegir otra.
Desconectar es local: no revoca el acceso en los demás dispositivos. Al renovar el
token en segundo plano se descarta el que Google guardaba en caché para recibir uno
de una hora.

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

Sin más variables se obtiene el APK de prueba, depurable y firmado con
`~/.android/debug.keystore`. Para publicar, define el almacén de claves de subida:

| Variable | Uso |
| --- | --- |
| `FOLIO_ANDROID_KEYSTORE` | Ruta del almacén de claves. Activa la compilación de publicación. |
| `FOLIO_ANDROID_KEYSTORE_PASSWORD` | Contraseña del almacén. |
| `FOLIO_ANDROID_KEY_ALIAS` | Alias de la clave. |
| `FOLIO_ANDROID_KEY_PASSWORD` | Contraseña de la clave, si difiere de la del almacén. |
| `FOLIO_ANDROID_TARGETS` | Arquitecturas, por defecto `aarch64`; por ejemplo `aarch64 armv7 x86_64`. |
| `FOLIO_ANDROID_VERSION_CODE` | Sustituye el `versionCode` que Tauri deriva de la versión (0.8.11 → 8011). |

Con el almacén se compila en modo release (no depurable, sin tráfico HTTP sin
cifrar, Rust optimizado y R8) y se generan `Folio-Android-<versión>.aab` y
`Folio-Android-<versión>.apk`. Gradle también lee las mismas claves (`storeFile`,
`storePassword`, `keyAlias`, `keyPassword`) de `src-tauri/gen/android/keystore.properties`,
que no se versiona. La firma de Google Play (Play App Signing), el SHA-1 de la clave
de firma en el cliente OAuth de Android y la publicación se hacen fuera del
repositorio. Quien tenga el APK de prueba debe desinstalarlo antes de instalar una
versión firmada con otra clave, y pierde su biblioteca local: conviene guardar o
sincronizar antes los PDF.

```sh
npm run build
npm run test:android
npm run test:file-picker
```

Las pruebas de interfaz usan el Chrome de `CHROME_PATH` (por defecto, la ruta de
Chrome en Windows). Comprueban tablet vertical/horizontal, teléfono
vertical/horizontal, ventana dividida, escritorio, lápiz emulado y deshacer/rehacer.
La prueba de motor verifica Ink, apariencia, coordenadas al girar, borrado y datos
inválidos. La compilación Kotlin/Rust y la firma APK se comprueban por separado.
Los casos nativos se prueban con Robolectric en el módulo Android:
`:tauri-plugin-folio-android:testDebugUnitTest`. Comprueban inicio en frío, apertura
posterior, compartir uno o varios PDF, URI duplicadas o `file://`, reaperturas desde
Recientes, archivos inválidos, errores de acceso, rutas privadas y limpieza de copias.
No sustituyen una prueba en un dispositivo real.
Los iconos incluyen variantes adaptativa, redonda y monocroma para los temas de
Android. La instalación, el selector, compartir, impresión, Drive y lápiz físico
requieren aceptación en un dispositivo.
