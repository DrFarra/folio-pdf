# Aceptación de Folio 0.4.1 — 04/10/2026

Windows 11 Pro x64, build 26200; compilación MSVC de producción sin la función
native-qa, identificador QA ni puerto de depuración. El ejecutable portátil
procede del instalador NSIS de esta versión; native-build-windows.json acredita
los hashes de la compilación y el instalador.

## Comprobaciones nuevas de 0.4.1

| Grupo | Evidencia | Alcance |
| --- | --- | --- |
| Preferencias de lectura | reading-settings-results.json | Tres casos: tema del sistema, navegación por página y preferencias conservadas al recargar y abrir otros archivos. |
| Eliminar resaltados y zoom | remove-highlights-results.json | Seis casos: borrado contextual de resaltados nuevos e importados, deshacer/rehacer, eliminación del objeto real al guardar, permisos y aislamiento entre pestañas. Zoom repetido e interrumpido conserva el canvas visible, sin ningún fotograma en blanco en el muestreo; texto y resaltado permanecen alineados. |
| Arrastre de marcadores | bookmark-drag-results.json | Cinco casos: mover una rama a un grupo plegado, conservar sus atributos, deshacer/rehacer, impedir ciclos, cancelar, reordenar y recuperar toda la rama al guardar y reabrir. |
| Aplicación nativa actual | native-smoke.json | Flujos de apertura, pestañas, selección, guardado, recuperación, edición, OCR y firma ejecutados con WebView2 y Rust de 0.4.1 en un perfil QA separado. |
| Actualización instalada | installed-smoke.json, production-state.json | Actualización de 0.4.0 a 0.4.1 en la ruta existente por usuario. Registro y ejecutable acreditan 0.4.1; los cinco archivos instalados coinciden con la entrega. El PDF volvió a abrirse con sus once anotaciones y dos marcadores intactos; también se conservaron su hash y UserChoice. No se capturó el código de salida del instalador: la verificación se basa en registro, archivos y perfil. |

Los informes nativos y de instalación distribuidos corresponden a 0.4.1.
Las capturas nuevas muestran las preferencias, el menú de borrado de resaltados,
el resultado del zoom y el traslado y recuperación de marcadores. Las regresiones
de la revisión anterior se conservan a continuación; los límites de aceptación
manual siguen abiertos.

## Regresiones anteriores de Folio 0.4.0

Windows 11 Pro x64, build 26200; Tauri/WebView2 y Chrome. Build nativo MSVC.
El corpus público incluye TraceMonkey, W9 del IRS, escaneo de OCRmyPDF y manual
de GNU Emacs de 804 páginas, con hashes verificados. Los PDF sintéticos se usan
para casos controlados, edición, censura y certificados. Ninguna identidad de
prueba forma parte de la entrega ni constituye una firma Authenticode.

### Comprobaciones ejecutadas

| Grupo | Evidencia | Alcance |
| --- | --- | --- |
| Núcleo de archivos | native-tests.json | Cuatro regresiones: original/alias protegido, destino modificado por otro escritor, sustitución solo del snapshot confirmado y entrada inválida/incompleta. |
| Comentarios | engine-results.json | Ocho casos: Unicode, importación, borrado, guardado repetido, AES-256, permisos, firma detectada, recorte y cuatro rotaciones. |
| Operaciones | operations-results.json | Trece casos: orden/giro/duplicación, combinación con campos/comentarios/enlaces, edición real, formularios, radio exclusivo, censura textual e imágenes, recorte correcto, compresión y cifrado. |
| Firmas | signatures-results.json | RSA-2048/SHA-256 real, ByteRange completo, contraseña incorrecta rechazada, contenido modificado rechazado, raíz elegida, confianza diferenciada y datos posteriores detectados. |
| Interfaz | workbench-results.json | Flujos completos de edición, formulario/creación de campo, OCR local/cancelación, DOCX/PNG, comparación, firma, recuperación, resaltado textual, Ctrl+S directo, permisos, W9, PDF inválido y primera/última página del manual de 804 páginas. |
| Resaltado por texto | highlighting-results.json | Gestos reales del ratón: fragmento exacto, varias líneas, arrastre inverso, selección previa, blanco/imagen sin comentarios, selección entre páginas y deshacer en una sola acción. Vista girada 90/180/270 a 150%, marcas de búsqueda y párrafo del PDF del usuario limitado a tres líneas; QuadPoints estándar y original intacto. |
| Pestañas y árbol | tabs-results.json | Apertura múltiple sin duplicar documentos, anotaciones/historial/guardado/vista aislados, cerrar/reabrir, Ctrl+Tab/Ctrl+W, edición de nombres sin Enter, foco del teclado, guardado repetido y recursos del visor. Grupos, hijos, nombres, colores, orden, traslado, plegado y eliminación conservando hijos; migración de marcadores anteriores. |
| Modelo de marcadores | bookmarks-results.json | Ocho regresiones de migración, reparación de árboles/ciclos, límites de páginas, ascendencia, colores, traslado/orden, eliminación y cambios de páginas con duplicación. |
| Menú de selección | selection-menu-results.json | Nueve casos: copiar, resaltar con QuadPoints y comentar con nota estándar; copia completa de 7378 caracteres y alternativa al portapapeles; cierre al desplazar, pulsar Escape o cambiar de documento; teclado, permisos de copiar/anotar y ventana estrecha. |
| Resaltado automático y colores | highlight-mode-results.json | Dos flujos: selecciones consecutivas con el color elegido, apagar el modo y seleccionar sin resaltar, color personalizado conservando la selección, exportación de QuadPoints con colores exactos y recuperación del color al recargar. Guardar conserva el modo automático y permite seguir resaltando. Doce colores, teclado, Escape y panel dentro de la ventana. |
| Disposición | layout-results.json | Cinco tamaños; sin scroll global, paneles independientes, Ctrl+rueda conserva el punto bajo cursor, temas claro/oscuro. |
| Lectores independientes | interop-operations.json | pypdf, PyMuPDF y OpenSSL: texto original reemplazado, campos Unicode, comentarios/enlaces importados, QuadPoints, recortes girados, píxeles censurados y original de imagen eliminado, OCR sin alterar el escaneo, CMS válido y manipulación rechazada. |
| Aplicación nativa | native-smoke.json | Apertura de dos archivos iniciales en pestañas, vista y marcadores conservados al cambiar de documento; nombre de marcador enfocado y persistido; resaltado textual automático con doce colores y menú para resaltar/comentar, guardados en Rust. Rueda/zoom/paneles/controles de ventana; edición, OCR, firma y verificación bajo la CSP de WebView2; borrador binario, biblioteca, recuperación tras recarga y cierre normal. |
| Actualización anterior | Registro histórico de 0.4.0 | Se verificó la actualización de 0.3.0 a 0.4.0 por usuario en este Windows 11, conservando PDF, anotaciones, marcador y UserChoice. El marcador numérico migró a la sesión v3. El informe installed-smoke.json distribuido se ha actualizado a la comprobación de 0.4.1 descrita arriba. |

El contenedor QA tiene identificador org.folio.pdf.qa y perfil separado. Su
puerto CDP no se distribuye. El PDF de 56 páginas del usuario conserva SHA-256
d4a45e05c01a42af5c41702da3ef10484fdb9f22b0ae72221abd5c33266b64aa.
La sesión anterior con sus anotaciones se mantiene en el perfil de producción.
Se distribuyen los informes de esta revisión y las capturas correspondientes.

## Aceptación manual que queda abierta

- Instalación nueva y desinstalación en Windows 10 y 11; actualizaciones en
  otros equipos; WebView2 presente/ausente y descarga fallida. La actualización
  por usuario en este Windows 11 ya se verificó con el runtime presente.
- Diálogos de archivo, rutas Unicode, arrastrar y abrir desde Explorer, iconos,
  asociaciones y aplicación predeterminada respetando otra elección del usuario.
- Guardar mediante selector nativo en Acrobat Reader y PDF-XChange/Foxit,
  comprobar comentarios, campos, firmas y sus apariencias de forma manual.
- Fallos de disco real, carpeta sin permiso, corte durante escritura y cambio
  externo de destino durante un diálogo; el núcleo tiene regresiones pero estas
  condiciones del sistema no están acreditadas por la prueba de WebView2.
- Impresora física, diálogo y cancelación de impresión nativa.
- Memoria/latencia con un archivo de imágenes cercano a 100 MiB; el manual de
  804 páginas pesa unos 3 MB. Entrada/salida por bloques no está implementada.
- Corpus amplio de PDFs dañados, XFA, fuentes poco comunes, grupos de radio al
  importar, certificados de distintos emisores y firmas múltiples/incrementales.

## Alcance funcional

Las herramientas de 0.4.0 realizan operaciones sobre el PDF y tienen pruebas
de su resultado. No se declara equivalencia con una suite comercial completa.
La edición es por áreas, DOCX es solo texto y OCR carece de corrección manual.
La firma admite RSA/PFX y una firma nueva; no hay TSA/revocación/almacén Windows.
Las limitaciones se explican en la herramienta donde afectan la decisión y en
README.md. docs/security.md registra la auditoría y el uso de node-forge.
