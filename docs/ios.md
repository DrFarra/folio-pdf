# Folio para iPhone e iPad

Folio 0.8.3 requiere iOS 17 o posterior. La interfaz permite usar el lector con
toques, seleccionar texto, resaltar, organizar marcadores, cambiar entre PDFs y
guardar copias. El motor PDF, sus recursos y el OCR se incluyen en la aplicación;
los documentos se procesan en el dispositivo.

La versión 0.8.3 incorpora la eliminación de los contornos de foco también en
la entrega de iPhone. El tirador de las hojas mantiene sus acciones de cierre
por toque y arrastre. Los campos de página, notas y contraseña reciben el foco
al abrir su diálogo, y los controles de zoom y acciones del editor se adaptan
al toque tanto en vertical como en horizontal.

## Instalar con Feather

La entrega `Folio_0.8.3_iphone_arm64_unsigned.ipa` es para un iPhone o iPad físico
con procesador arm64. No tiene un certificado ni perfil de Apple incorporado.
En Feather, importa el archivo IPA, selecciona tu certificado y perfil de
aprovisionamiento válidos, firma la aplicación e instálala. Feather requiere
ese certificado y perfil: tener Feather instalado no reemplaza esos requisitos.
No compartas la clave privada, el certificado ni sus contraseñas con Folio.

Si Feather modifica el identificador de la aplicación al firmarla, usa el mismo
identificador en posteriores actualizaciones para conservar sus datos. Si tu
certificado vence o se revoca, será necesario volver a firmar con uno válido.

La carpeta `.app` de simulador se distribuye por separado para desarrollo. No
sirve para instalar en un iPhone ni se debe comprimir y renombrar como IPA.

## Archivos y privacidad

Al abrir PDFs, Folio presenta el selector de Archivos de iOS. Puede importar
varios documentos. iOS entrega una copia autorizada y Folio la conserva en
`Documents/Imports`; las pestañas y los
recientes apuntan a esa copia durable. No depende de que un proveedor de iCloud
o de terceros mantenga una URL temporal.

Guardar crea una nueva copia con las anotaciones y presenta el selector de
exportación de Archivos. Compartir usa la hoja nativa de iOS. Imprimir usa
AirPrint con el PDF exportado, incluidas sus anotaciones. Cancelar cualquiera
de estos diálogos no se presenta como guardado o impresión completados. Nunca
se sobrescribe el PDF original al exportar una copia.

Los PDFs de más de 32 MiB usan PDFKit y permanecen en disco. El lector solicita
solo el texto y la imagen de las páginas visibles, con imágenes de hasta cuatro
megapíxeles. No hay un límite de 100 MB para importar; la disponibilidad de
espacio en el dispositivo y el contenido de cada página condicionan la apertura.
Ese modo permite leer, buscar, copiar, usar marcadores y añadir o eliminar
resaltados y notas. Al guardar, MuPDF nativo añade los cambios a una copia del
original para conservar las propiedades y apariencias de sus anotaciones,
formularios y páginas no modificadas. La edición estructural, los formularios y el OCR completo
siguen disponibles en el motor de documentos pequeños; el lector de archivos
grandes no expone esas operaciones.

No se solicitan permisos de fotos, cámara, micrófono, ubicación, contactos ni
tracking. Los accesos a Archivos se conceden por documento mediante iOS.

## Compilar

Necesitas un Mac con Xcode completo, su SDK de iOS y al menos un runtime de
iPhone Simulator instalado, Node.js 22 o posterior, Python 3.12 o posterior,
make y Rust estable. Usa una
copia limpia de la fuente y ejecuta:

```sh
npm ci
node scripts/build-ios.mjs
```

El script verifica y compila el código correspondiente MuPDF 1.28.1 para
dispositivo y simulador antes de resolver el paquete Swift local. Para usar
el archivo fuente incluido en la entrega sin descargarlo:

```sh
node scripts/build-mupdf-ios.mjs --source /ruta/mupdf-1.28.1-source.tar.gz
node scripts/build-ios.mjs
```

La CLI Tauri bloqueada por `package-lock.json` crea el scaffold Xcode y compila
dos targets distintos: `aarch64-apple-ios-sim` y `aarch64-apple-ios`. El flujo usa
`tauri ios build --no-sign --ci` con `Cargo.lock`. No requiere cuenta de Apple
ni envía software a App Store Connect. El simulador puede firmarse localmente
ad hoc para su ejecución; esa firma no se coloca en la IPA de dispositivo.

Para probar el puente nativo sin producir una entrega:

```sh
node scripts/build-ios.mjs --simulator --qa
python3 scripts/tests/native-smoke-ios.py --qa --app test-results/ios-build/qa/Folio.app
```

La variante `native-qa` se compila aparte y se excluye de la IPA final. El
workflow privado `.github/workflows/ios.yml` se ejecuta únicamente a petición;
el modo `full` exige pruebas móviles y nativas antes de empaquetar.

## Alcance de la verificación

Las pruebas WebKit móviles cubren el diseño y las operaciones de lectura y
edición, incluidos los paneles con ambos temas, la edición de texto e imágenes,
el contenido y los píxeles del PDF exportado y su reapertura. El empaquetado exige
los informes completos de estas pruebas, los 48 casos del motor y los contratos
del puente simulado, ligados a la fuente y a la interfaz compilada de la entrega.
Las comprobaciones UIKit de producción cierran la hoja de documentos con toques
y arrastre y cambian entre los PDFs importados, conservando capturas.
El smoke nativo instala y abre el bundle arm64 de simulador, verifica
el PDF real y su capa de texto, búsqueda, el puente Swift/UIKit y la persistencia
Rust, y toma una captura. La prueba PDFKit ejecuta la importación Swift, abre
un PDF sintético válido de más de 2 GiB, extrae palabras y dibuja páginas con
cuatro rotaciones. Comprueba las posiciones del texto, la eliminación y creación
de anotaciones, la conservación de páginas no visitadas y la memoria residente
del proceso de simulador. El tamaño del archivo de prueba proviene de una zona
dispersa de espacio PDF; no simula la complejidad de un escaneo de 2 GiB.
El empaquetador inspecciona el Mach-O de la IPA de
dispositivo para comprobar que es arm64 con plataforma iOS y no iOS Simulator.

Una prueba en simulador no verifica la firma del certificado particular del
usuario, la instalación física con Feather, todos los proveedores de Archivos
ni una impresión real en una impresora. El manifiesto de cada entrega declara
explícitamente cuáles de esas operaciones se comprobaron.

La base iOS 17 acota la plataforma WKWebView y las API web modernas que usa
PDF.js 6. Se incluye la compatibilidad de ReadableStream para WebKit que ya usa
la versión Mac. La fuente, las licencias y el código correspondiente de MuPDF
se entregan junto con la IPA.

Referencias: [Tauri iOS](https://v2.tauri.app/distribute/sign/ios/),
[plugins nativos](https://v2.tauri.app/develop/plugins/develop-mobile/),
[Feather](https://github.com/khcrysalis/Feather).
