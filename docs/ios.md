# Folio para iPhone e iPad

Folio 0.5.0 requiere iOS 17 o posterior. La interfaz permite usar el lector con
toques, seleccionar texto, resaltar, organizar marcadores, cambiar entre PDFs y
guardar copias. El motor PDF, sus recursos y el OCR se incluyen en la aplicación;
los documentos se procesan en el dispositivo.

## Instalar con Feather

La entrega `Folio_0.5.0_iphone_arm64_unsigned.ipa` es para un iPhone o iPad físico
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
varios documentos. Copia cada archivo seleccionado a su carpeta `Documents/Imports`
mientras conserva la autorización de acceso del proveedor; las pestañas y los
recientes apuntan a esa copia durable. No depende de que un proveedor de iCloud
o de terceros mantenga una URL temporal.

Guardar crea una nueva copia con las anotaciones y presenta el selector de
exportación de Archivos. Compartir usa la hoja nativa de iOS. Imprimir usa
AirPrint con el PDF exportado, incluidas sus anotaciones. Cancelar cualquiera
de estos diálogos no se presenta como guardado o impresión completados. Nunca
se sobrescribe el PDF original al exportar una copia.

No se solicitan permisos de fotos, cámara, micrófono, ubicación, contactos ni
tracking. Los accesos a Archivos se conceden por documento mediante iOS.

## Compilar

Necesitas un Mac con Xcode completo, su SDK de iOS y al menos un runtime de
iPhone Simulator instalado, Node.js 22 o posterior y Rust estable. Usa una
copia limpia de la fuente y ejecuta:

```sh
npm ci
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
edición. El smoke nativo instala y abre el bundle arm64 de simulador, verifica
el PDF real y su capa de texto, búsqueda, el puente Swift/UIKit y la persistencia
Rust, y toma una captura. El empaquetador inspecciona el Mach-O de la IPA de
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
