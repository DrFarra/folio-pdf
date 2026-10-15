# Editar en memoria

Objetivo: que Editar (escritorio) se sienta como Acrobat: mover, redimensionar,
recolorear y borrar sin reabrir el PDF en cada cambio. Se hace en tres etapas;
las tres están hechas (de la 3, lo que compensa; ver abajo).

## Etapa 1 (hecha): documento vivo

Antes, cada cambio copiaba el PDF entero al motor, lo abría, lo editaba, lo
guardaba entero, lo verificaba reabriéndolo, lo devolvía, PDF.js lo reabría
(`openDocument`) y se escribía el borrador; además, leer los elementos de la
página y pedir la «placa» copiaban otra vez el PDF a un worker.

Ahora:

- Al entrar en Editar, `EditStore.open` abre el documento una vez en un worker
  propio (`src/engine/session.ts` + `session.worker.ts`) con el *journal* de
  MuPDF activo. Cada cambio es un paso del journal (`beginOperation` /
  `endOperation`); si sus comprobaciones fallan, `abandonOperation` lo deshace y
  el documento queda como estaba.
- Las operaciones son las de siempre, pero en el sitio: `editDocument(doc, op)`
  en `operations.mjs` edita y verifica sobre el documento abierto (sin guardar ni
  reabrir). `operateDocument` usa la misma función y luego guarda, así que hay una
  sola implementación y todas las pruebas de motor la cubren.
- La respuesta de un cambio es solo el número de página. La página cambiada sube
  de versión (`state.live.versions`) y `PDFPage` la dibuja desde el documento vivo
  (`render`, píxeles RGBA a la escala de la página), sin reabrir PDF.js. Los
  elementos (`content`) y la placa (`plate`) también se leen del documento vivo.
- Deshacer/rehacer en Editar usan el journal (`undo`/`redo`); en la pila de Folio
  son entradas `session`.
- El PDF se escribe (`save`, `garbage=1`) 800 ms después del último cambio, antes
  de guardar, de cambiar o cerrar pestaña, al cerrar Folio y al salir de Editar.
  El SHA-256 (la revisión) se calcula en el worker. Lo escrito pasa a ser
  `doc.bytes` y el borrador, sin reabrir el lector.
- Al salir de Editar, el lector abre una sola vez el PDF escrito. Desde la etapa 3
  el documento vivo sigue abierto (ver «Etapa 3»); al cerrarlo, sus pasos se
  convierten en uno: «volver al PDF de antes de Editar».

### Medición (antes → después)

`node scripts/tests/edit-perf.mjs` (Chromium, PDF con un escaneo distinto por
página y dos líneas de texto encima; mover un párrafo, desde soltar el ratón hasta
que la página muestra el resultado y vuelve a estar seleccionado). Antes = 0.9.10
(e874790) con el mismo guion y el mismo PDF:

| | 238 MB / 600 págs., antes | después | 475 MB / 1200 págs., antes | después |
|---|---|---|---|---|
| Por cambio (mediana de 4) | 865 ms | 35 ms | 1,49 s | 35 ms |
| Salir de Editar | 0 (nada pendiente) | 616 ms, una vez | 0 | 1,6 s, una vez |

El coste por cambio ya no depende del tamaño del PDF. (Una primera medición dio
896 → 35 ms con un PDF de prueba cuyos escaneos declaraban un tamaño distinto del
real; MuPDF los pintaba negros. El guion se corrigió y se midió otra vez.)

En Node, sobre el mismo PDF: editar en el sitio 10 ms frente a 177 ms del camino
abrir→editar→guardar; escribir el PDF entero ~50 ms (incremental ~26 ms).

### Límites conocidos de la etapa 1

- Las páginas cambiadas las dibuja MuPDF hasta salir de Editar: el suavizado de
  letras puede diferir un poco de PDF.js; la capa de texto, la búsqueda y las
  miniaturas de esas páginas muestran el estado anterior hasta salir; con mucho
  zoom no se pinta el detalle de alta densidad de esas páginas.
- Mientras hay pasos por rehacer no se dibuja la placa (dibujarla abandona una
  operación, y eso borraría lo que se puede rehacer): se usa el color de fondo.
- Cerrado el documento vivo (al cambiar de documento), sus cambios se deshacen de
  una vez; si el PDF supera el presupuesto del historial (200 MB), como hasta
  ahora, ya no se pueden deshacer.
- Si el worker se cae, se pierden los cambios no escritos (como mucho los de los
  últimos ~800 ms); Folio avisa. En la web, cerrar la pestaña del navegador en
  ese intervalo también los pierde (`beforeunload` no puede esperar).
- Tableta y teléfono usan su propio editor (`PdfContentPicker`, `ContentEditor`)
  con el camino anterior (`applyOperation`); no cambian.

## Riesgos

- **Memoria en PDFs grandes.** El documento vivo es otra copia de los bytes en
  su worker, más la caché de MuPDF. Para un libro de 1 GB en un Mac de 8 GB eso es
  demasiado, y MuPDF tampoco puede guardar modificado un PDF de más de ~0.75 GB.
  Propuesta: por encima de ~0.5 GB, prestar los bytes al worker en vez de copiarlos
  mientras Editar está abierto, o rechazar Editar con un mensaje claro hasta que
  exista la escritura incremental nativa (etapa 3).
- **Coherencia PDF.js / MuPDF.** Dos motores dibujan la misma página. La etapa 2
  debe dibujar desde MuPDF todo lo de una página en edición (fondo y elementos) y
  dejar PDF.js para el resto, para no mezclar en una misma página.
- **Ids posicionales** (`text-paragraph-b3`, `image-2`, `graphic-5`). Siguen siendo
  válidos solo para un estado de la página: cada cambio sube la versión y se leen
  otra vez (milisegundos). Las capas de la etapa 2 necesitan ids estables entre
  cambios (ver abajo).
- **Journal de MuPDF.** Guardar con `garbage>=2` lo rompe en silencio (deshacer
  deja de funcionar; comprobado): la sesión escribe con `garbage=1`, que sí quita
  los objetos sin usar (el texto borrado no queda en el archivo). Comenzar una
  operación borra los pasos por rehacer, también si falla.
- **Móviles/táctil.** Quedan con el editor y el camino anteriores; llevarles el
  documento vivo es posible (mismo `EditSession`) pero no está hecho.

## Etapa 2 (hecha): sprites por objeto

Al arrastrar, redimensionar, girar o recolorear, lo que se mueve en pantalla es
el elemento solo (su *sprite*: sus píxeles con transparencia, dibujados por el
documento vivo a la escala actual), y donde estaba se ve la «placa» (la página
sin él). Antes se movía una copia de los píxeles de la página en su rectángulo,
con lo que hubiera detrás (un texto sobre un recuadro de color arrastraba un
trozo del recuadro).

- `itemSprite` (`operations.mjs`) no cambia el documento. Texto e imagen se
  dibujan con lo mismo que escribe «mover» (`movedDrawing`: las mismas glifos con
  sus fuentes y colores, o la imagen con su máscara), así que el sprite es lo que
  quedará en el PDF. Un dibujo se aísla quitando de los flujos de la página todo
  lo demás que pinta (y texto, imágenes y sombreados), en una página de un
  documento auxiliar con la misma geometría y recursos gráficos; conserva así el
  estado gráfico que lo rodea. Con `fill`/`stroke` se dibuja ya recoloreado.
- `EditStore.sprite` los pide a la sesión y los guarda junto a las placas (los 40
  últimos de un estado de la página). `EditLayer` lo precarga al pasar el ratón por
  un elemento y lo usa (`Sprite`) al arrastrar y en el «fantasma» que queda hasta
  que la página muestra el cambio; mientras no llega, la copia de píxeles de antes.
- Recolorear un dibujo se ve al instante, sin cambiar el PDF; el color se escribe
  300 ms después de la última elección, como antes.
- Como los sprites solo leen, se dibujan también con pasos por rehacer (la placa
  no: sigue usando el color de fondo en ese caso).

Medido (`edit-perf.mjs`, mismo PDF de 238 MB): el sprite sigue al puntero ~64 ms
después de pulsar (incluye los cuatro pasos de movimiento simulados); el coste por
cambio sigue en 35 ms.

### Cambio respecto a la propuesta, y por qué

La propuesta era dibujar al entrar en Editar cada página como un fondo (sin los
elementos editables) más un sprite por elemento, todo en una pasada, con ids
estables. Se hizo por elemento y a demanda, porque:

- **Orden de apilado.** Con un único fondo, lo no editable que el PDF pinta *encima*
  de un elemento editable (una etiqueta girada sobre un recuadro) quedaría debajo
  de su sprite. Hacerlo bien exige partir el fondo en capas intercaladas, y repartir
  el texto glifo a glifo entre elementos que comparten una orden de dibujo.
- **Coste.** Una página puede tener cientos de dibujos; pintarlos todos al entrar
  cuesta memoria y trabajo para elementos que no se van a tocar. Con el documento
  vivo, un sprite cuesta milisegundos y está listo antes de empezar a arrastrar.
- **Ids estables innecesarios.** El sprite y la placa se piden por estado de la
  página; tras un cambio se vuelven a pedir y la reselección por posición sigue
  funcionando.

### Límites de la etapa 2

- El primer fotograma de un arrastre puede mostrar aún la copia de píxeles si el
  sprite no estaba precargado (p. ej. con el teclado, sin pasar el ratón).
- La vista previa del color reemplaza el dibujo entero; si el dibujo tiene partes
  con colores distintos, todas toman el nuevo, igual que al escribirlo.
- Los textos se mueven, no se escalan (como antes): el sprite de un texto no se
  redimensiona.

## Etapa 3 (hecha): escritura diferida

La escritura ya era diferida desde la etapa 1 (tras 800 ms de pausa, antes de
guardar, de cambiar de documento o de cerrar, y al salir de Editar). La etapa 3
añade:

- **El documento vivo sigue abierto al salir de Editar** («aparcado», hasta 512 MB,
  `PARK_LIMIT` en `App.tsx`): sus cambios se deshacen y rehacen uno a uno también
  fuera de Editar (el journal deshace, la página se ve al instante desde el
  documento vivo y el lector abre el resultado), y volver a Editar no copia otra
  vez el PDF. Cambiar o cerrar de documento, u otra operación que lo reescriba
  (Herramientas, guardar en el sitio, deshacer más atrás de Editar), lo cierra y
  sus pasos se repliegan en uno como antes. Solo hay uno, el del documento activo.
- **Borradores sin cola de revisiones viejas**: una revisión ya sustituida por otra
  (Editar escribe una por pausa) no se escribe; se escribe la nueva, que va detrás.
  Así no se acumulan escrituras de un PDF entero ni sus copias en memoria. En la
  web, `storeDraft` evita además una copia completa del PDF.

Medido (`edit-perf.mjs`, Chromium):

| | 238 MB / 600 págs. | 475 MB / 1200 págs. |
|---|---|---|
| Entrar en Editar, primera vez | 122 ms | 170 ms |
| Volver a entrar (documento vivo abierto) | 104 ms | 101 ms |
| Deshacer el último cambio fuera de Editar | 624 ms | 1,37 s |
| Por cambio, en Editar | 35 ms | 35 ms |

Antes de la etapa 3, en estos PDFs (más de 200 MB) los cambios de Editar no se
podían deshacer tras salir; en PDFs menores se deshacían todos de una vez.

### Lo que no se hizo, y por qué

- **Escritura incremental.** Medido en Node con el PDF de 238 MB: escribir con
  `incremental` tarda ~26 ms frente a ~55 ms con `garbage=1`, en un worker y fuera
  del camino de cada cambio. A cambio, el archivo conservaría las versiones
  anteriores: un texto borrado seguiría dentro del borrador, y de cualquier copia
  que no se reescriba entera (la de Drive se exporta incremental). No compensa.
- **Borrador fuera del hilo principal.** En la app de escritorio el borrador va por
  el puente nativo (`store_draft`), que no es accesible desde un worker; en la web
  el coste es la copia que hace IndexedDB, de la que ya se quitó una.
- **PDFs de más de ~0.75 GB.** Anexar una actualización incremental escrita a mano
  exige saber qué objetos cambiaron; mupdf.js no lo expone (el journal solo da los
  nombres de los pasos). Sigue pendiente: o soporte de MuPDF para escribir a un
  flujo de salida en vez de a un búfer en su heap, o llevar la escritura a Rust.

### Límites de la etapa 3

- El documento aparcado ocupa otra copia del PDF en memoria mientras el documento
  está abierto y activo.
- Deshacer fuera de Editar reabre el lector en cada paso (624 ms con 238 MB).

## Después de las etapas: selección múltiple

Primer paso hacia «a la altura de los visores profesionales»: en Editar se pueden
seleccionar varios elementos de una página y cambiarlos juntos, como un solo paso.

- Seleccionar: Mayús (o Ctrl/⌘) + clic añade o quita; arrastrar en un espacio
  libre dibuja un recuadro que selecciona lo que queda dentro entero (con Mayús, lo
  añade); Ctrl/⌘+A selecciona todo lo editable de la página.
- Con varios: arrastrar cualquiera mueve todos (el grupo no sale de la página);
  flechas, duplicar (Ctrl/⌘+D), eliminar (Supr) y seis alineaciones en la barra
  (izquierda, centro, derecha, arriba, medio, abajo, respecto a la caja de todos).
  Cada uno se ve como su sprite y donde estaba, su placa. Un clic sin arrastrar en
  uno del grupo lo deja solo seleccionado.
- Motor: `editDocumentAll` aplica la lista como un paso del journal; como un cambio
  puede renumerar los elementos de la página, cada siguiente se vuelve a buscar por
  tipo y lugar, y los movimientos van primero los que van delante en su dirección.
  Si uno falla, no se aplica ninguno.
- Las formas de Folio (anotaciones) no entran en un grupo.

Medido (`edit-perf.mjs`, 238 MB): mover juntos el párrafo y el escaneo, 71 ms.

Al hacerlo apareció un fallo de la etapa 1, corregido: cada escritura del PDF tras
una pausa movía la vista a la página con la que se abrió el documento (el efecto
que restaura el scroll se disparaba con cada nueva copia de los bytes). Ahora solo
actúa cuando el lector abre otro documento.

## Pruebas

- `npm run test:edit-engine`: incluye `a-live-document-takes-changes-in-place-and-undoes-them`
  (mismo resultado que el camino de una vez, cambio fallido o abandonado sin efecto,
  deshacer/rehacer del journal tras escribir) y
  `sprites-draw-one-item-alone-without-changing-the-document` (texto, imagen con
  transparencia, dibujo aislado y recoloreado; el documento no cambia) y
  `several-items-change-as-one-step` (dos párrafos movidos juntos, un deshacer, y
  un lote con un elemento ya inexistente que no deja nada a medias).
- `npm run test:edit-mode:ui` (Chromium; `FOLIO_TEST_BROWSER=webkit` para WebKit):
  `several-items-move-align-delete-and-undo-together` (Mayús+clic, arrastrar el
  grupo, deshacer de una vez sin que la vista salte, recuadro, alinear, borrar y
  restaurar),
  la página se dibuja desde el documento vivo, el arrastre muestra el sprite,
  rehacer, `recolouring-a-drawing-shows-at-once-and-is-written-after`,
  `leaving-opens-the-written-pdf-and-one-undo-returns-to-before`,
  `after-leaving-changes-undo-one-by-one-and-editar-reopens-at-once` y
  `a-change-not-yet-written-survives-opening-another-document` (que también
  comprueba el repliegue de los pasos al cerrar el documento vivo).
- `node scripts/tests/edit-perf.mjs` tras compilar: tiempos por cambio, hasta el
  sprite, mover dos a la vez, al salir, al entrar (primera vez y de nuevo) y al
  deshacer fuera de Editar.
