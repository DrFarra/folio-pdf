# Google Drive en Folio: comportamiento acordado

Requisitos del usuario, 5 de octubre de 2026. La implementación y las pruebas
realizadas se describen en [drive-sync-implementation.md](drive-sync-implementation.md).
Esta lista conserva los requisitos; no implica que todo el conjunto esté probado
en dispositivos físicos.

## Acceso y organización

1. Incluir una sección Google Drive con Conectar con Google Drive, cuenta
   conectada y Desconectar. Autorizar cada cuenta desde la plataforma nativa.
2. Mostrar el árbol de carpetas existente, su ruta y los PDF dentro de cada
   carpeta, con carpetas primero, paginación y búsqueda. Evitar una lista plana.
3. Abrir el PDF elegido bajo demanda, manteniendo su `fileId` y carpeta original.
4. Guardar ediciones y anotaciones en ese mismo archivo. Al entrar desde otro
   dispositivo, refrescar los cambios remotos y abrir la revisión actualizada.
5. Mostrar estados claros: Guardado en Drive, Cambios pendientes, Sin conexión,
   Sincronizando, Conflicto y Error. Guardado local no equivale a guardado remoto.

## Integridad al guardar

- Mantener por cuenta y archivo una base común: revisión remota observada, hash
  del contenido, bytes/base local y cambios pendientes. La hora del dispositivo
  no decide qué versión gana.
- Persistir primero un borrador recuperable y una operación con identificador
  estable. Un cierre, corte de red o reinicio no debe perder cambios ni duplicar
  guardados al reintentar. Aislar y serializar las operaciones locales por archivo.
- Refrescar el estado remoto antes de abrir y antes de guardar, así como al
  recuperar conexión o volver a primer plano. No reemplazar un borrador sucio
  con contenido remoto de forma silenciosa.
- La actualización del original requiere control de concurrencia **atómico**
  aplicado por el servidor. Evaluar y comprobar la precondición de revisión/ETag
  admitida por la subida real. Dos escrituras sobre la misma base no deben ambas
  reemplazar el archivo. Una comprobación GET seguida por PATCH sin precondición
  deja una carrera y no cumple el requisito.
- Si Drive no permite hacer cumplir la condición necesaria en el flujo de subida
  elegido, resolver esa limitación con un mecanismo verificable de coordinación
  antes de habilitar el sobrescrito automático. No anunciar el problema resuelto
  ni usar un archivo de bloqueo no atómico como garantía.
- Confirmar el resultado remoto y su revisión/hash antes de marcar Guardado en
  Drive. Si se pierde la respuesta de una subida, reconciliar el resultado con
  el identificador de operación y el contenido antes de repetirla.

## Cuando los dos dispositivos editaron

Conservar el original remoto más reciente y el borrador local íntegro. Mostrar
que el documento cambió en otro dispositivo y ofrecer abrir ambas versiones,
conservar la de Drive o conservar la local como una copia de conflicto claramente
identificada. Antes de reemplazar el original por una versión elegida, conservar
una recuperación y volver a exigir la precondición sobre la revisión que el
usuario acaba de revisar.

Los conflictos se resuelven de forma explícita. Un guardado normal no duplica
documentos; una copia se crea únicamente como recuperación/conflicto o por una
acción Guardar copia. No mezclar automáticamente dos PDF binarios ni descartar
anotaciones. Sin conexión, conservar cambios como pendientes y aplicar la misma
política al reconectar.

## Pruebas de aceptación obligatorias

| Caso | Resultado requerido |
| --- | --- |
| A guarda y B abre después | B recibe el PDF actualizado con el mismo ID y carpeta. |
| A y B editan la misma base, A guarda primero | B detecta conflicto y ambos contenidos siguen recuperables. |
| A y B guardan exactamente a la vez | La protección atómica evita pérdida silenciosa; comprobarlo con una barrera de concurrencia en la prueba. |
| B edita sin conexión y A guarda en línea | B conserva su borrador; al volver se detecta el conflicto. |
| Se corta la red después de que Google aceptó la subida | La reconciliación evita duplicados y no informa falsamente una pérdida. |
| El archivo se renombra o mueve en otro dispositivo | Folio conserva la identidad y actualiza ruta/nombre. |
| El original fue eliminado o perdió permiso de edición | No recrearlo ni sobrescribirlo automáticamente; conservar borrador y ofrecer recuperación. |
| Dos archivos tienen igual nombre en carpetas distintas | Se editan por `fileId`, sin cruzar contenido. |
| Cambia la cuenta conectada | No subir borradores de una cuenta al Drive de otra. |
| Cierre durante el guardado | Recuperar borrador y operación pendiente al reiniciar. |

Ver [google-drive-oauth.md](google-drive-oauth.md) para los clientes de plataforma,
el alcance configurado y los requisitos previos a la publicación.
