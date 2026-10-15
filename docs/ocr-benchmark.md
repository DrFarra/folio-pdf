# OCR de Folio: banco de pruebas

El motor de OCR de Folio usa los modelos PP-OCRv5 de PaddleOCR (detección de líneas, orientación de línea y reconocimiento latino para español, inglés y otros 30 idiomas) con ONNX Runtime Web. Este documento lo compara con el motor anterior, tesseract.js (Tesseract 5, modelos `tessdata_fast` español + inglés).

Para repetirlo: `node scripts/tests/ocr-bench.mjs`. La versión corta (`--quick`, `npm run test:ocr-engine`) forma parte de las pruebas.

## Método

- **Páginas**:
  - de documentos nacidos digitales, así que el texto verdadero es el del propio PDF:
    - el artículo *tracemonkey* (inglés, dos columnas);
    - una página del manual de Emacs;
    - el formulario W-9 del IRS;
    - la guía de Folio (español);
  - una página de texto médico en español con tildes y eñes.
- **Variantes de cada página**:
  - **limpia 150 ppp**: como un escaneo;
  - **degradada**: desenfoque, ruido y JPEG de calidad 35;
  - **baja resolución 100 ppp**;
  - **torcida 2°**: sin enderezar antes, para medir a cada motor solo.
- **Medidas**, que no dependen de cómo cada motor corta las líneas:
  - **Palabras (F1)**: palabras reconocidas exactas, frente a las verdaderas.
  - **Error por carácter**: cada palabra verdadera contra la reconocida más parecida.
  - **Error de orden de lectura**: el texto completo en el orden en que lo entrega cada motor. Mide si se leen bien las columnas.
  - **Cajas (IoU)**: cuánto coincide la caja de cada palabra con la del PDF.

## Resultados (15 de octubre de 2026)

| Motor | Error por carácter | Error de orden de lectura | Palabras (F1) | Cajas (IoU) |
| --- | --- | --- | --- | --- |
| **Folio (PP-OCRv5)** | **0,65 %** | **5,1 %** | **98,2 %** | **0,63** |
| Tesseract 5 (anterior) | 1,95 % | 20,2 % | 92,6 % | 0,61 |

Por variante:

| Variante | Folio: palabras | Tesseract: palabras | Folio: error por carácter | Tesseract: error por carácter |
| --- | --- | --- | --- | --- |
| limpia 150 ppp | 98,5 % | 96,3 % | 0,66 % | 1,19 % |
| degradada | 97,5 % | 93,6 % | 0,57 % | 1,83 % |
| baja resolución 100 ppp | 98,3 % | 87,9 % | 0,71 % | 2,99 % |
| torcida 2° | 98,5 % | 92,7 % | 0,68 % | 1,77 % |

Por página:

| Página | Folio: palabras | Tesseract: palabras | Folio: orden | Tesseract: orden |
| --- | --- | --- | --- | --- |
| tracemonkey (EN, 2 columnas) | 96,2 % | 84,7 % | 0,6 % | 60,9 % |
| manual de Emacs (EN) | 100,0 % | 99,2 % | 0,0 % | 0,1 % |
| formulario W-9 (EN) | 97,5 % | 83,7 % | 24,3 % | 36,8 % |
| guía de Folio (ES) | 97,3 % | 95,6 % | 0,5 % | 3,3 % |
| texto médico (ES) | 99,9 % | 99,9 % | 0,0 % | 0,0 % |

## Velocidad

| Dónde | Folio | Tesseract |
| --- | --- | --- |
| Procesador, un hilo (Node, este banco) | 5,8 s por página | 1,4 s por página |
| Tarjeta gráfica con WebGPU (WebView2, NVIDIA) | **0,5 s por página** (0,95 s la primera) | no la usa |

En la app, el motor usa la tarjeta gráfica con WebGPU cuando la hay. Sin ella reparte las líneas de cada página entre hasta 4 workers, cada uno con un hilo. El texto que sale de la tarjeta gráfica es idéntico al del procesador.

## Límites conocidos

- Las degradaciones son simuladas: faltan fotos reales de teléfono y escaneos de libros. Hay que repetir el banco con PDF reales de los usuarios.
- No lee texto vertical (lomos, tablas giradas 90°).
- En formularios el orden de lectura sigue siendo difícil: en el W-9 erra un 24 %, frente a un 37 % de Tesseract.
- Las cifras de PaddleOCR publicadas por Baidu se midieron con sus propios datos. Este banco es independiente, pero pequeño.
