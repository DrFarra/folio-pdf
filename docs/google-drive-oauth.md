# Google Drive OAuth para Folio

Configuración creada y verificada en Google Cloud el 5 de octubre de 2026.
**Integración implementada en código; Google OAuth continúa en modo de prueba.**
La biblioteca de Drive, guardado condicional, caché y recuperación de conflictos
están integrados en Android y escritorio. El código de iOS está añadido, pero
requiere compilación y prueba en un dispositivo Apple. El JSON adjunto registra
los clientes; cada autenticador nativo utiliza el cliente de su plataforma.

Consulta [drive-sync-implementation.md](drive-sync-implementation.md) para las
pruebas realizadas, el comportamiento del guardado y sus límites actuales.

## Configuración creada

- Proyecto: `folio-510714` (número `743680809956`).
- API habilitada: `drive.googleapis.com`.
- Marca de consentimiento: Folio; público externo; estado Prueba.
- La cuenta propietaria indicada por el usuario se agregó a la lista de prueba.
- Tres clientes: Folio Desktop, Folio Android - pruebas APK y Folio iOS - org.folio.pdf.
- IDs públicos y datos de plataforma: [google-drive-oauth.config.json](google-drive-oauth.config.json).
- [Consola de clientes](https://console.cloud.google.com/auth/clients?project=folio-510714).
- [Permisos configurados](https://console.cloud.google.com/auth/scopes?project=folio-510714).

Los archivos descargados de Google están fuera del repositorio, bajo
`%LOCALAPPDATA%/Folio/developer-credentials/`, con acceso de archivos limitado al
usuario de Windows: `folio-desktop-oauth.json`, `folio-android-oauth.json` y
`folio-ios-oauth.plist`. No copiar secretos ni tokens a este documento, al JSON
público, a logs o al historial Git.

## Biblioteca existente y sincronización

El alcance configurado es `https://www.googleapis.com/auth/drive`. Permite leer
y actualizar archivos existentes directamente desde el explorador propio de
Folio, conservando el mismo `fileId`. Google lo clasifica como restringido y lo
presenta como permiso para ver, editar y borrar todos los archivos de Drive.
El producto solicitado solo necesita navegar carpetas y abrir/editar PDF; no
implementar borrado masivo ni modificaciones ajenas a los documentos elegidos.

El flujo pedido es: sección **Google Drive** → **Conectar con Google Drive** →
navegar las carpetas existentes → abrir un PDF → editar → guardar en el mismo
archivo y carpeta → abrir ese mismo documento actualizado desde otro dispositivo.
No sustituir el guardado normal por copias nuevas. El usuario pidió mantener su
organización de carpetas, no una lista plana de cientos de documentos.

El explorador debe mostrar carpetas primero, ruta navegable, volver a la carpeta
anterior y búsqueda con alcance visible (carpeta actual o todo Drive). Paginar
resultados y excluir la papelera. Al listar hijos, usar el identificador de la
carpeta; admitir carpetas vacías y nombres repetidos, sin identificar documentos
por su nombre. Mostrar PDF (`application/pdf`) y carpetas
(`application/vnd.google-apps.folder`), con tratamiento explícito de accesos
directos y de archivos compartidos. No descargar todos los documentos al conectar.

Guardar con el mismo `fileId`, conservando carpeta, nombre y permisos salvo una
acción explícita del usuario. Comprobar las capacidades del archivo: un usuario
sin permiso de edición puede leer y, cuando esté permitido, guardar una copia,
pero no actualizar el original. Cada usuario autoriza su propio Drive; no usar
la cuenta del desarrollador ni una cuenta de servicio como almacén común.

Sincronizar los bytes del PDF guardado, incluidas sus anotaciones, junto con los
metadatos de lectura que Folio guarda por separado. Mantener los datos y colas
aislados por cuenta y `fileId`. No borrar archivos al desconectar una cuenta.

## Conflictos: condición obligatoria para entregar la función

Esta protección **todavía no está implementada**. El contrato de comportamiento
se detalla en [drive-sync-requirements.md](drive-sync-requirements.md).
No basta con consultar la fecha antes de subir: dos dispositivos pueden leer
la misma revisión y guardar a la vez. La escritura del original debe estar
protegida por una condición de versión que el servidor haga cumplir y cuya
eficacia se haya comprobado con subidas reales. No asumir que un parámetro
`version` o un encabezado HTTP es suficiente sin esa prueba.

En caso de divergencia, conservar las dos versiones y mostrar una resolución
explícita. No aplicar "gana el último guardado", ni intentar mezclar binarios PDF.

## Integración por plataforma

- Escritorio: navegador del sistema, código de autorización, PKCE S256 y `state`;
  callback loopback en un puerto local disponible. Almacenar tokens mediante las
  funciones seguras del sistema operativo. El cliente instalado es público:
  no confiar en su secreto embebido como protección de la app.
- Android: Google Identity Services `AuthorizationClient` en el plugin nativo.
  El cliente actual corresponde al paquete `org.folio.pdf` y al certificado
  **Android Debug** comprobado de nuevo en el APK 0.8.9 con `apksigner`. Para una distribución
  con firma de producción o Google Play, registrar su SHA-1 real en otro cliente
  Android del mismo proyecto. No usar el flujo loopback de escritorio en Android.
- iOS: sesión nativa `ASWebAuthenticationSession`, PKCE y el esquema URL inverso del JSON.
  El ID `org.folio.pdf` se comprobó en `Info.plist` de la IPA 0.8.3 sin firma.
  Si Feather cambia el identificador al firmar, esa instalación necesita un
  cliente que coincida; no se ha comprobado el ID instalado en el teléfono.
  El esquema URL está añadido a `Info.ios.plist`; falta generar y probar la nueva IPA.

## Pruebas y publicación pendientes

La creación de clientes y permisos se comprobó en la consola. Pasaron las pruebas
reales de tokens, listado, descarga, guardado y concurrencia descritas en
[drive-sync-implementation.md](drive-sync-implementation.md). Falta validar el
consentimiento de Google en una tablet Android física y compilar/probar iOS;
los contratos de interfaz no sustituyen esos ensayos en dispositivos.

Solo las cuentas agregadas como usuarios de prueba pueden autorizar la app en
este estado. Antes de distribuirla públicamente, completar marca y política de
privacidad y cumplir la verificación que Google exige para `drive`, un
alcance restringido. Si se almacenan o transmiten datos de alcances restringidos
por servidores, revisar también el requisito de evaluación de seguridad. No se
publicó la app ni se presentó una solicitud de verificación.

Referencias oficiales:

- [Alcances de Google Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Consentimiento OAuth](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [OAuth para aplicaciones nativas](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Autorización Android](https://developer.android.com/identity/authorization)
- [Certificado del cliente Android](https://developers.google.com/android/guides/client-auth)
