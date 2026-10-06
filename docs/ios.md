# Folio para iPhone e iPad

Folio requiere iOS 17 o posterior. La interfaz permite usar el lector con
toques, seleccionar texto, resaltar, dibujar, organizar marcadores, cambiar
entre PDFs y guardar copias. El motor PDF, sus recursos y el OCR se incluyen en
la aplicación; los documentos se procesan en el dispositivo.

La entrega incluye `README_iPhone.md`, que `scripts/package-ios.py` genera con
la versión y el nombre de la IPA de esa entrega.

## Instalar con Feather

La IPA `Folio_<versión>_iphone_arm64_unsigned.ipa` es para un iPhone o iPad
físico con procesador arm64. No tiene un certificado ni perfil de Apple
incorporado. En Feather, importa el archivo IPA, selecciona tu certificado y
perfil de aprovisionamiento válidos, firma la aplicación e instálala. Feather
requiere ese certificado y perfil: tener Feather instalado no reemplaza esos
requisitos. No compartas la clave privada, el certificado ni sus contraseñas.

Si Feather modifica el identificador de la aplicación al firmarla, usa el mismo
identificador en posteriores actualizaciones para conservar sus datos. Si tu
certificado vence o se revoca, será necesario volver a firmar con uno válido.

La carpeta `.app` de simulador se distribuye por separado para desarrollo. No
sirve para instalar en un iPhone ni se debe comprimir y renombrar como IPA.

## Archivos y privacidad

Al abrir PDFs, Folio presenta el selector de Archivos de iOS. Puede importar
varios documentos. iOS entrega una copia autorizada y Folio la conserva en
`Documents/Imports/<uuid>`; las pestañas y la biblioteca apuntan a esa copia
durable. No depende de que un proveedor de iCloud o de terceros mantenga una
URL temporal. Al eliminar un documento de la biblioteca, o todos los datos
locales, Folio borra también su copia; al iniciarse borra las que ya no están
en la biblioteca.

Guardar crea una nueva copia con las anotaciones y presenta el selector de
exportación de Archivos. Compartir usa la hoja nativa de iOS. Imprimir usa
AirPrint con el PDF exportado, incluidas sus anotaciones. Cancelar cualquiera
de estos diálogos no se presenta como guardado o impresión completados. Nunca
se sobrescribe el PDF original al exportar una copia.

Los PDFs de más de 32 MiB usan PDFKit y permanecen en disco. El lector solicita
solo el texto y la imagen de las páginas visibles, con imágenes de hasta cuatro
megapíxeles. No hay un límite de 100 MB para importar; la disponibilidad de
espacio en el dispositivo y el contenido de cada página condicionan la apertura.
Ese modo permite leer, buscar, copiar, usar marcadores, dibujar y añadir o
eliminar resaltados y notas. Al guardar, MuPDF nativo añade los cambios a una
copia del original para conservar las propiedades y apariencias de sus
anotaciones, formularios y páginas no modificadas. La edición estructural, los
formularios y el OCR completo siguen disponibles en el motor de documentos
pequeños; el lector de archivos grandes no expone esas operaciones.

Folio solo pide acceso a la cámara si eliges «Hacer foto» al añadir una imagen.
No usa fotos, micrófono, ubicación, contactos ni seguimiento. Los accesos a
Archivos se conceden por documento mediante iOS. El manifiesto de privacidad
`src-tauri/plugins/folio-ios/ios/PrivacyInfo.xcprivacy` declara que no recopila
datos y el único uso de API con motivo obligatorio: la fecha de modificación de
los PDFs dentro del contenedor de la aplicación.

## Compilar

Necesitas un Mac con Xcode completo, su SDK de iOS y al menos un runtime de
iPhone Simulator instalado, Node.js 22 o posterior, Python 3.12 o posterior,
make y Rust estable. Usa una copia limpia de la fuente y ejecuta:

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

La CLI Tauri bloqueada por `package-lock.json` crea el scaffold Xcode, añade el
manifiesto de privacidad a la raíz del bundle y compila dos targets distintos:
`aarch64-apple-ios-sim` y `aarch64-apple-ios`. Por omisión usa
`tauri ios build --no-sign --ci` con `Cargo.lock`, sin cuenta de Apple. El
simulador puede firmarse localmente ad hoc para su ejecución; esa firma no se
coloca en la IPA de dispositivo.

Para firmar la IPA de dispositivo, define `APPLE_DEVELOPMENT_TEAM` y las
credenciales que lee Tauri: `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD` e
`IOS_MOBILE_PROVISION`, o `APPLE_API_KEY`, `APPLE_API_ISSUER` y
`APPLE_API_KEY_PATH`. `FOLIO_IOS_EXPORT_METHOD` elige `app-store-connect` (por
omisión), `release-testing` o `debugging`. El resultado es
`Folio_<versión>_iphone_arm64.ipa`, que se sube a App Store Connect con
Transporter o `xcrun altool`; `scripts/package-ios.py` empaqueta solo la IPA sin
firmar para Feather.

Para probar el puente nativo sin producir una entrega:

```sh
node scripts/build-ios.mjs --simulator --qa
python3 scripts/tests/native-smoke-ios.py --qa --app test-results/ios-build/qa/Folio.app
```

La variante `native-qa` se compila aparte, nunca se firma y se excluye de la
IPA final. El workflow `.github/workflows/ios.yml` se ejecuta únicamente a
petición; el modo `full` exige pruebas móviles y nativas antes de
empaquetar.

## Pruebas

`npm run test:iphone` comprueba en WebKit el diseño y las operaciones de lectura y
edición con tamaños de iPhone e iPad. `scripts/tests/native-smoke-ios.py` instala la
app en el simulador y comprueba la apertura, la capa de texto, la búsqueda, el puente
Swift/UIKit y la persistencia en Rust. Ninguna de las dos sustituye una instalación
en un dispositivo real con tu certificado.

Referencias: [Tauri iOS](https://v2.tauri.app/distribute/sign/ios/),
[plugins nativos](https://v2.tauri.app/develop/plugins/develop-mobile/),
[Feather](https://github.com/khcrysalis/Feather).
